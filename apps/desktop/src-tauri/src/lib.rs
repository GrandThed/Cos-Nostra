mod capture;
mod settings;

use std::sync::Mutex;

use serde::Serialize;
use tauri::menu::{Menu, MenuItem};
use tauri::tray::TrayIconBuilder;
use tauri::{AppHandle, Emitter, Manager, State};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut, ShortcutState};

use capture::Recorder;
use settings::Settings;

struct AppState {
    settings: Mutex<Settings>,
    recorder: Mutex<Option<Recorder>>,
    last_error: Mutex<Option<String>>,
}

#[derive(Serialize, Clone)]
struct Status {
    recording: bool,
    encoder: Option<String>,
    hotkey: String,
    clip_dir: String,
    buffer_seconds: i64,
    error: Option<String>,
}

#[derive(Serialize, Clone)]
struct ClipSaved {
    path: String,
}

#[tauri::command]
fn get_status(state: State<AppState>) -> Status {
    let settings = state.settings.lock().unwrap();
    let recorder = state.recorder.lock().unwrap();
    Status {
        recording: recorder.as_ref().map(|r| r.is_active()).unwrap_or(false),
        encoder: recorder.as_ref().map(|r| r.encoder_id().to_string()),
        hotkey: settings.hotkey.clone(),
        clip_dir: settings.clip_dir.display().to_string(),
        buffer_seconds: settings.buffer_seconds,
        error: state.last_error.lock().unwrap().clone(),
    }
}

#[tauri::command]
fn save_clip(app: AppHandle) -> Result<String, String> {
    save_clip_inner(&app).map(|p| p.display().to_string())
}

fn save_clip_inner(app: &AppHandle) -> Result<std::path::PathBuf, String> {
    let state = app.state::<AppState>();
    let recorder = state.recorder.lock().unwrap();
    let recorder = recorder.as_ref().ok_or("recorder is not running")?;
    let path = recorder.save().map_err(|e| format!("{e:#}"))?;
    log::info!("clip saved: {}", path.display());
    let _ = app.emit(
        "clip-saved",
        ClipSaved {
            path: path.display().to_string(),
        },
    );
    Ok(path)
}

fn start_recorder(app: &AppHandle) {
    let state = app.state::<AppState>();
    let settings = state.settings.lock().unwrap().clone();
    match Recorder::start(&settings) {
        Ok(rec) => {
            *state.recorder.lock().unwrap() = Some(rec);
            *state.last_error.lock().unwrap() = None;
        }
        Err(e) => {
            let msg = format!("{e:#}");
            log::error!("recorder failed to start: {msg}");
            *state.last_error.lock().unwrap() = Some(msg);
        }
    }
    let _ = app.emit("status-changed", ());
}

fn register_hotkey(app: &AppHandle, hotkey: &str) -> anyhow::Result<()> {
    let shortcut: Shortcut = hotkey
        .parse()
        .map_err(|e| anyhow::anyhow!("bad hotkey {hotkey:?}: {e}"))?;
    app.global_shortcut()
        .on_shortcut(shortcut, |app, _shortcut, event| {
            if event.state == ShortcutState::Pressed {
                if let Err(e) = save_clip_inner(app) {
                    log::error!("hotkey save failed: {e}");
                }
            }
        })?;
    Ok(())
}

fn build_tray(app: &AppHandle) -> tauri::Result<()> {
    let clip = MenuItem::with_id(app, "clip", "Save clip", true, None::<&str>)?;
    let show = MenuItem::with_id(app, "show", "Open", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&clip, &show, &quit])?;

    let mut tray = TrayIconBuilder::with_id("main")
        .menu(&menu)
        .tooltip("Cos Nostra")
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id.as_ref() {
            "clip" => {
                if let Err(e) = save_clip_inner(app) {
                    log::error!("tray save failed: {e}");
                }
            }
            "show" => {
                if let Some(w) = app.get_webview_window("main") {
                    let _ = w.show();
                    let _ = w.set_focus();
                }
            }
            "quit" => app.exit(0),
            _ => {}
        });
    if let Some(icon) = app.default_window_icon() {
        tray = tray.icon(icon.clone());
    }
    tray.build(app)?;
    Ok(())
}

pub fn run() {
    env_logger::Builder::from_env(env_logger::Env::default().default_filter_or("info")).init();

    // OBS binaries are downloaded on first launch. If the bootstrapper had to install them
    // it relaunches the process itself, so we simply exit here.
    let runtime = tokio::runtime::Runtime::new().expect("tokio runtime");
    let bootstrap = runtime.block_on(libobs_bootstrapper::ObsBootstrapper::bootstrap(
        &libobs_bootstrapper::ObsBootstrapperOptions::default(),
    ));
    match bootstrap {
        Ok(libobs_bootstrapper::ObsBootstrapperResult::Restart) => {
            log::info!("OBS runtime installed, restarting");
            return;
        }
        Ok(libobs_bootstrapper::ObsBootstrapperResult::None) => {}
        Err(e) => {
            log::error!("OBS bootstrap failed: {e}");
            return;
        }
    }

    let settings = Settings::load();
    let _ = settings.save();

    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            if let Some(w) = app.get_webview_window("main") {
                let _ = w.show();
                let _ = w.set_focus();
            }
        }))
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .manage(AppState {
            settings: Mutex::new(settings),
            recorder: Mutex::new(None),
            last_error: Mutex::new(None),
        })
        .invoke_handler(tauri::generate_handler![get_status, save_clip])
        .setup(|app| {
            let handle = app.handle().clone();
            build_tray(&handle)?;
            let hotkey = handle
                .state::<AppState>()
                .settings
                .lock()
                .unwrap()
                .hotkey
                .clone();
            register_hotkey(&handle, &hotkey)?;
            // libobs startup takes a moment; keep the window responsive.
            std::thread::spawn(move || start_recorder(&handle));
            Ok(())
        })
        .on_window_event(|window, event| {
            // Closing the window hides it; the app lives in the tray.
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                let _ = window.hide();
                api.prevent_close();
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
