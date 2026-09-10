mod capture;
mod settings;

use std::panic::AssertUnwindSafe;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;

use anyhow::Context as _;
use serde::Serialize;
use tauri::menu::{Menu, MenuItem};
use tauri::tray::TrayIconBuilder;
use tauri::{AppHandle, Emitter, Manager, State};
use tauri_plugin_autostart::{MacosLauncher, ManagerExt as _};
use tauri_plugin_dialog::DialogExt as _;
use tauri_plugin_global_shortcut::{Code, GlobalShortcutExt, Shortcut, ShortcutState};
use tauri_plugin_notification::NotificationExt as _;

use capture::{CaptureConflict, HookCallback, HookedGame, Recorder};
use settings::Settings;

struct AppState {
    settings: Mutex<Settings>,
    recorder: Mutex<Option<Recorder>>,
    last_error: Mutex<Option<String>>,
    /// Set when the saved hotkey could not be registered at startup; cleared by save_settings.
    hotkey_error: Mutex<Option<String>>,
    /// Set from the libobs hook callback; read by get_status. Never held across anything slow.
    hooked_game: Mutex<Option<HookedGame>>,
    /// Bumped on every (re)start so a slow start that got superseded discards its result.
    generation: AtomicU64,
}

#[derive(Serialize, Clone)]
struct Status {
    recording: bool,
    encoder: Option<String>,
    hotkey: String,
    clip_dir: String,
    buffer_seconds: i64,
    error: Option<String>,
    hotkey_error: Option<String>,
    hooked_game: Option<HookedGame>,
    conflict: Option<CaptureConflict>,
}

#[derive(Serialize, Clone)]
struct ClipSaved {
    path: String,
}

// ---------------------------------------------------------------------------
// Commands

#[tauri::command]
fn get_status(state: State<AppState>) -> Status {
    let settings = state.settings.lock().unwrap();
    let recorder = state.recorder.lock().unwrap();
    // The callback is the primary source; the recorder's own view covers a hook that fired
    // before the callback was wired up.
    let hooked_game = state
        .hooked_game
        .lock()
        .unwrap()
        .clone()
        .or_else(|| recorder.as_ref().and_then(|r| r.hooked_game()));
    // Our own hook creates the same pipe the conflict check looks for, so only ask while we
    // have nothing hooked ourselves.
    let conflict = if hooked_game.is_some() {
        None
    } else {
        capture::capture_conflict()
    };
    Status {
        recording: recorder.as_ref().map(|r| r.is_active()).unwrap_or(false),
        encoder: recorder.as_ref().map(|r| r.encoder_id().to_string()),
        hotkey: settings.hotkey.clone(),
        clip_dir: settings.clip_dir.display().to_string(),
        buffer_seconds: settings.buffer_seconds,
        error: state.last_error.lock().unwrap().clone(),
        hotkey_error: state.hotkey_error.lock().unwrap().clone(),
        hooked_game,
        conflict,
    }
}

#[tauri::command]
fn save_clip(app: AppHandle) -> Result<String, String> {
    save_clip_inner(&app).map(|p| p.display().to_string())
}

#[tauri::command]
fn get_settings(state: State<AppState>) -> Settings {
    state.settings.lock().unwrap().clone()
}

/// Validates, persists and applies new settings. Async so the hotkey swap and the file write
/// happen off the main thread.
#[tauri::command]
async fn save_settings(app: AppHandle, settings: Settings) -> Result<(), String> {
    save_settings_inner(&app, settings).map_err(|e| format!("{e:#}"))
}

/// Opens a folder picker. Must be async: the blocking dialog cannot run on the main thread.
#[tauri::command]
async fn pick_clip_dir(app: AppHandle) -> Result<Option<String>, String> {
    let picked = app.dialog().file().blocking_pick_folder();
    match picked {
        None => Ok(None),
        Some(p) => p
            .into_path()
            .map(|p| Some(p.display().to_string()))
            .map_err(|e| format!("{e:#}")),
    }
}

#[tauri::command]
fn retry_recorder(app: AppHandle) {
    restart_recorder(&app);
}

// ---------------------------------------------------------------------------
// Saving

fn save_clip_inner(app: &AppHandle) -> Result<PathBuf, String> {
    let state = app.state::<AppState>();
    let (notify, sound) = {
        let s = state.settings.lock().unwrap();
        (s.notify_on_save, s.sound_on_save)
    };
    let result = {
        let recorder = state.recorder.lock().unwrap();
        match recorder.as_ref() {
            Some(r) => r.save().map_err(|e| format!("{e:#}")),
            None => Err("recorder is not running".to_string()),
        }
    };
    match &result {
        Ok(path) => {
            log::info!("clip saved: {}", path.display());
            let _ = app.emit(
                "clip-saved",
                ClipSaved {
                    path: path.display().to_string(),
                },
            );
            if notify {
                let name = path
                    .file_name()
                    .map(|n| n.to_string_lossy().into_owned())
                    .unwrap_or_else(|| path.display().to_string());
                show_toast(app, "Clip saved", &name);
            }
            if sound {
                play_save_sound();
            }
        }
        Err(e) => {
            log::error!("clip save failed: {e}");
            if notify {
                show_toast(app, "Clip not saved", e);
            }
        }
    }
    result
}

fn show_toast(app: &AppHandle, title: &str, body: &str) {
    if let Err(e) = app.notification().builder().title(title).body(body).show() {
        log::warn!("toast failed: {e}");
    }
}

/// Plays the system "Asterisk" event sound without blocking. No asset needed.
fn play_save_sound() {
    use windows::core::w;
    use windows::Win32::Media::Audio::{PlaySoundW, SND_ALIAS, SND_ASYNC};
    // SAFETY: the alias is a static wide string and SND_ASYNC returns immediately.
    let ok = unsafe { PlaySoundW(w!("SystemAsterisk"), None, SND_ALIAS | SND_ASYNC) };
    if !ok.as_bool() {
        log::debug!("PlaySoundW returned false");
    }
}

// ---------------------------------------------------------------------------
// Recorder lifecycle

/// Runs on the libobs signal thread. Only touches the small hooked_game lock, then hands off.
fn on_hook_changed(app: &AppHandle, game: Option<HookedGame>) {
    let state = app.state::<AppState>();
    match &game {
        Some(g) => log::info!("game hooked: {} ({})", g.title, g.executable),
        None => log::info!("game unhooked"),
    }
    *state.hooked_game.lock().unwrap() = game.clone();
    update_tray_tooltip(app, game.as_ref());
    let _ = app.emit("status-changed", ());
}

fn update_tray_tooltip(app: &AppHandle, game: Option<&HookedGame>) {
    let text = match game {
        Some(g) => format!("Cos Nostra – recording {}", g.title),
        None => "Cos Nostra – idle".to_string(),
    };
    if let Some(tray) = app.tray_by_id("main") {
        if let Err(e) = tray.set_tooltip(Some(text)) {
            log::warn!("tray tooltip failed: {e}");
        }
    }
}

fn panic_message(payload: &(dyn std::any::Any + Send)) -> String {
    if let Some(s) = payload.downcast_ref::<&str>() {
        (*s).to_string()
    } else if let Some(s) = payload.downcast_ref::<String>() {
        s.clone()
    } else {
        "unknown panic".to_string()
    }
}

/// Boots libobs with the current settings. Blocking; call from a background thread.
fn start_recorder(app: &AppHandle) {
    let state = app.state::<AppState>();
    let generation = state.generation.fetch_add(1, Ordering::SeqCst) + 1;
    let settings = state.settings.lock().unwrap().clone();

    let hook_app = app.clone();
    let on_hook: HookCallback = Box::new(move |game| on_hook_changed(&hook_app, game));

    // A panic inside libobs setup must not take the whole app down (both profiles unwind).
    let outcome = std::panic::catch_unwind(AssertUnwindSafe(|| Recorder::start(&settings, on_hook)));
    let result = match outcome {
        Ok(Ok(rec)) => Ok(rec),
        Ok(Err(e)) => Err(format!("{e:#}")),
        Err(payload) => Err(format!("recorder panicked: {}", panic_message(&*payload))),
    };

    if state.generation.load(Ordering::SeqCst) != generation {
        // A newer restart superseded this one; throw away whatever we got.
        log::info!("discarding superseded recorder start");
        drop(result);
        return;
    }

    match result {
        Ok(rec) => {
            *state.recorder.lock().unwrap() = Some(rec);
            *state.last_error.lock().unwrap() = None;
        }
        Err(msg) => {
            log::error!("recorder failed to start: {msg}");
            *state.recorder.lock().unwrap() = None;
            *state.last_error.lock().unwrap() = Some(msg);
        }
    }
    let _ = app.emit("status-changed", ());
}

/// Tears down the current recorder (if any) and starts a fresh one on a background thread.
fn restart_recorder(app: &AppHandle) {
    let state = app.state::<AppState>();
    let old = state.recorder.lock().unwrap().take();
    *state.hooked_game.lock().unwrap() = None;
    *state.last_error.lock().unwrap() = None;
    update_tray_tooltip(app, None);
    let _ = app.emit("status-changed", ());

    let handle = app.clone();
    std::thread::spawn(move || {
        // Shutting libobs down can take a moment too; keep it off the UI thread.
        drop(old);
        start_recorder(&handle);
    });
}

// ---------------------------------------------------------------------------
// Settings

/// Parses a shortcut and insists on a modifier or an F-key so a bare letter cannot hijack typing.
fn parse_hotkey(hotkey: &str) -> anyhow::Result<Shortcut> {
    let shortcut: Shortcut = hotkey
        .parse()
        .map_err(|e| anyhow::anyhow!("bad hotkey {hotkey:?}: {e}"))?;
    let is_fkey = matches!(
        shortcut.key,
        Code::F1
            | Code::F2
            | Code::F3
            | Code::F4
            | Code::F5
            | Code::F6
            | Code::F7
            | Code::F8
            | Code::F9
            | Code::F10
            | Code::F11
            | Code::F12
            | Code::F13
            | Code::F14
            | Code::F15
            | Code::F16
            | Code::F17
            | Code::F18
            | Code::F19
            | Code::F20
            | Code::F21
            | Code::F22
            | Code::F23
            | Code::F24
    );
    if shortcut.mods.is_empty() && !is_fkey {
        anyhow::bail!("hotkey {hotkey:?} needs a modifier (Ctrl, Alt, Shift) or an F-key");
    }
    Ok(shortcut)
}

fn register_hotkey(app: &AppHandle, hotkey: &str) -> anyhow::Result<()> {
    let shortcut = parse_hotkey(hotkey)?;
    app.global_shortcut()
        .on_shortcut(shortcut, |app, _shortcut, event| {
            if event.state == ShortcutState::Pressed {
                // Feedback (toast, sound, log) is handled inside.
                let _ = save_clip_inner(app);
            }
        })?;
    Ok(())
}

fn unregister_hotkey(app: &AppHandle, hotkey: &str) {
    if let Ok(shortcut) = hotkey.parse::<Shortcut>() {
        if let Err(e) = app.global_shortcut().unregister(shortcut) {
            log::warn!("unregister {hotkey:?} failed: {e}");
        }
    }
}

fn save_settings_inner(app: &AppHandle, mut new: Settings) -> anyhow::Result<()> {
    new.hotkey = new.hotkey.trim().to_string();
    new.validate()?;
    parse_hotkey(&new.hotkey)?;

    let state = app.state::<AppState>();
    let old = state.settings.lock().unwrap().clone();

    // Hotkey: swap, and roll back to the old binding if the new one cannot be registered.
    // If the saved one never registered (startup failure) we always try again.
    let hotkey_broken = state.hotkey_error.lock().unwrap().is_some();
    if new.hotkey != old.hotkey || hotkey_broken {
        unregister_hotkey(app, &old.hotkey);
        if let Err(e) = register_hotkey(app, &new.hotkey) {
            if let Err(re) = register_hotkey(app, &old.hotkey) {
                log::error!("could not restore hotkey {:?}: {re:#}", old.hotkey);
            }
            return Err(e).with_context(|| format!("registering hotkey {:?}", new.hotkey));
        }
        *state.hotkey_error.lock().unwrap() = None;
    }

    // Persist before touching the recorder so a libobs failure does not lose the change.
    new.save().context("saving settings")?;
    *state.settings.lock().unwrap() = new.clone();

    let mut deferred_error: Option<anyhow::Error> = None;
    if new.start_with_windows != old.start_with_windows {
        if let Err(e) = apply_autostart(app, new.start_with_windows) {
            log::error!("autostart change failed: {e:#}");
            deferred_error = Some(e);
        }
    }

    if new.needs_recorder_restart(&old) {
        restart_recorder(app);
    } else {
        let _ = app.emit("status-changed", ());
    }

    match deferred_error {
        Some(e) => Err(e),
        None => Ok(()),
    }
}

fn apply_autostart(app: &AppHandle, enabled: bool) -> anyhow::Result<()> {
    let launcher = app.autolaunch();
    let current = launcher.is_enabled().unwrap_or(false);
    if enabled && !current {
        launcher
            .enable()
            .map_err(|e| anyhow::anyhow!("{e}"))
            .context("enabling start with Windows")?;
        quote_autostart_entry()?;
    } else if !enabled && current {
        launcher
            .disable()
            .map_err(|e| anyhow::anyhow!("{e}"))
            .context("disabling start with Windows")?;
    }
    Ok(())
}

/// The autostart plugin writes the exe path to HKCU\...\Run unquoted, and our install directory
/// contains a space. Rewrite the value quoted so Windows never tries `...\Local\Cos` first.
fn quote_autostart_entry() -> anyhow::Result<()> {
    use winreg::enums::HKEY_CURRENT_USER;
    use winreg::RegKey;
    let exe = std::env::current_exe().context("locating current exe")?;
    let run = RegKey::predef(HKEY_CURRENT_USER)
        .open_subkey_with_flags(
            r"Software\Microsoft\Windows\CurrentVersion\Run",
            winreg::enums::KEY_SET_VALUE,
        )
        .context("opening Run key")?;
    run.set_value("Cos Nostra", &format!("\"{}\"", exe.display()))
        .context("writing quoted Run entry")?;
    Ok(())
}

// ---------------------------------------------------------------------------
// Tray and app shell

fn build_tray(app: &AppHandle) -> tauri::Result<()> {
    let clip = MenuItem::with_id(app, "clip", "Save clip", true, None::<&str>)?;
    let show = MenuItem::with_id(app, "show", "Open", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&clip, &show, &quit])?;

    let mut tray = TrayIconBuilder::with_id("main")
        .menu(&menu)
        .tooltip("Cos Nostra – idle")
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id.as_ref() {
            "clip" => {
                let _ = save_clip_inner(app);
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
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_autostart::init(MacosLauncher::LaunchAgent, None))
        .manage(AppState {
            settings: Mutex::new(settings),
            recorder: Mutex::new(None),
            last_error: Mutex::new(None),
            hotkey_error: Mutex::new(None),
            hooked_game: Mutex::new(None),
            generation: AtomicU64::new(0),
        })
        .invoke_handler(tauri::generate_handler![
            get_status,
            save_clip,
            get_settings,
            save_settings,
            pick_clip_dir,
            retry_recorder
        ])
        .setup(|app| {
            let handle = app.handle().clone();
            build_tray(&handle)?;
            let settings = handle.state::<AppState>().settings.lock().unwrap().clone();
            // A bad or taken hotkey is reported in the UI rather than aborting startup.
            if let Err(e) = register_hotkey(&handle, &settings.hotkey) {
                let msg = format!("hotkey {:?} could not be registered: {e:#}", settings.hotkey);
                log::error!("{msg}");
                *handle.state::<AppState>().hotkey_error.lock().unwrap() = Some(msg);
            }
            // Keep the autostart entry in sync with the saved preference (e.g. after a reinstall).
            if let Err(e) = apply_autostart(&handle, settings.start_with_windows) {
                log::warn!("{e:#}");
            }
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
