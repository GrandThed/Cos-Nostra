//! Replay buffer on top of embedded libobs.
//!
//! The scene has two layers: a monitor capture of the primary display underneath and a
//! game capture of any fullscreen application on top. When a game is hooked it covers the
//! monitor layer; otherwise the desktop is what gets recorded. Desktop audio is mixed in.

use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use anyhow::{Context, Result};
use libobs_simple::output::replay::ObsContextReplayExt;
use libobs_simple::output::simple::{HardwareCodec, HardwarePreset};
use libobs_simple::sources::windows::{
    GameCaptureSourceBuilder, MonitorCaptureSourceBuilder, ObsDisplayCaptureMethod,
    ObsGameCaptureMode, ObsHookableSourceSignals, ObsHookableSourceTrait,
};
use libobs_wrapper::context::ObsContext;
use libobs_wrapper::data::output::{ObsOutputTrait, ObsReplayBufferOutputRef};
use libobs_wrapper::data::video::ObsVideoInfoBuilder;
use libobs_wrapper::data::ObsDataSetters;
use libobs_wrapper::encoders::ObsContextEncoders;
use libobs_wrapper::scenes::SceneItemExtSceneTrait;
use libobs_wrapper::sources::ObsSourceBuilder;
use libobs_wrapper::utils::{ObsPath, SourceInfo, StartupInfo};

use crate::settings::Settings;

/// The game the game-capture source currently has hooked, from libobs's `hooked` signal.
#[derive(Debug, Clone, serde::Serialize)]
pub struct HookedGame {
    pub title: String,
    pub class: String,
    pub executable: String,
}

/// Called on the libobs signal thread whenever the game capture hooks or unhooks.
pub type HookCallback = Box<dyn Fn(Option<HookedGame>) + Send + Sync + 'static>;

/// Another capture tool already holds the game-capture hook in the foreground game.
#[derive(Debug, Clone, serde::Serialize)]
pub struct CaptureConflict {
    pub executable: String,
    pub title: String,
}

/// Looks at the foreground window. If it is a game and another OBS-style hook pipe already
/// exists for its process, returns who is in the way. `None` means we are clear to record.
///
/// Never panics: any Win32 or pipe error is logged at debug level and treated as "no conflict".
pub fn capture_conflict() -> Option<CaptureConflict> {
    match foreground_conflict() {
        Ok(conflict) => conflict,
        Err(e) => {
            log::debug!("capture conflict check skipped: {e:#}");
            None
        }
    }
}

fn foreground_conflict() -> Result<Option<CaptureConflict>> {
    use windows::Win32::UI::WindowsAndMessaging::{GetForegroundWindow, GetWindowThreadProcessId};

    // Safety: plain Win32 queries; the only pointer is the pid out-param below.
    let hwnd = unsafe { GetForegroundWindow() };
    if hwnd.is_invalid() {
        return Ok(None);
    }
    let mut pid = 0u32;
    unsafe { GetWindowThreadProcessId(hwnd, Some(&mut pid)) };
    if pid == 0 || pid == std::process::id() {
        return Ok(None);
    }

    let in_use = GameCaptureSourceBuilder::is_window_in_use_by_other_instance(pid)
        .with_context(|| format!("checking hook pipe for pid {pid}"))?;
    if !in_use {
        return Ok(None);
    }

    let executable = process_executable_name(pid).unwrap_or_else(|e| {
        log::debug!("executable name for pid {pid} unavailable: {e:#}");
        String::new()
    });
    let title = window_title(hwnd);
    log::debug!("foreground process {pid} ({executable}) already hooked by another capture tool");
    Ok(Some(CaptureConflict { executable, title }))
}

/// File name of the process image, e.g. `game.exe`.
fn process_executable_name(pid: u32) -> Result<String> {
    use windows::Win32::Foundation::CloseHandle;
    use windows::Win32::System::Threading::{
        OpenProcess, QueryFullProcessImageNameW, PROCESS_NAME_WIN32,
        PROCESS_QUERY_LIMITED_INFORMATION,
    };

    // Safety: the handle is closed on every path; the buffer outlives the call.
    let handle = unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid) }
        .context("opening process")?;
    let mut buf = vec![0u16; 1024];
    let mut len = buf.len() as u32;
    let queried = unsafe {
        QueryFullProcessImageNameW(
            handle,
            PROCESS_NAME_WIN32,
            windows::core::PWSTR(buf.as_mut_ptr()),
            &mut len,
        )
    };
    unsafe {
        let _ = CloseHandle(handle);
    }
    queried.context("querying process image name")?;
    let full = String::from_utf16_lossy(&buf[..len as usize]);
    Ok(full.rsplit(['\\', '/']).next().unwrap_or(&full).to_string())
}

fn window_title(hwnd: windows::Win32::Foundation::HWND) -> String {
    use windows::Win32::UI::WindowsAndMessaging::GetWindowTextW;
    let mut buf = [0u16; 512];
    // Safety: the buffer is valid for the call and Win32 bounds the copy by its length.
    let len = unsafe { GetWindowTextW(hwnd, &mut buf) };
    String::from_utf16_lossy(&buf[..len.max(0) as usize])
}

pub struct Recorder {
    // Declared before `_context` so the signal manager disconnects while the OBS runtime is
    // still alive. Dropping it closes the broadcast channels, which ends the hook thread.
    _game_signals: Arc<ObsHookableSourceSignals>,
    hooked: Arc<Mutex<Option<HookedGame>>>,
    _context: ObsContext,
    replay: ObsReplayBufferOutputRef,
    encoder_id: String,
}

impl Recorder {
    /// Reports the game currently hooked by the game capture source, if any.
    pub fn hooked_game(&self) -> Option<HookedGame> {
        self.hooked
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .clone()
    }

    /// Boots libobs, builds the scene and starts the replay buffer.
    /// `on_hook` fires with `Some` when a game gets hooked and `None` when it unhooks.
    pub fn start(settings: &Settings, on_hook: HookCallback) -> Result<Self> {
        std::fs::create_dir_all(&settings.clip_dir)
            .with_context(|| format!("creating {}", settings.clip_dir.display()))?;

        let video = ObsVideoInfoBuilder::new()
            .fps_num(settings.fps)
            .fps_den(1)
            .build();

        let mut context = StartupInfo::new()
            .set_video_info(video)
            .start()
            .context("starting libobs")?;

        let mut scene = context.scene("main", None).context("creating scene")?;

        // Layer 1: primary monitor.
        let monitors =
            MonitorCaptureSourceBuilder::get_monitors().context("enumerating monitors")?;
        let primary = monitors
            .iter()
            .find(|m| m.0.is_primary)
            .or_else(|| monitors.first())
            .context("no monitor found")?;
        context
            .source_builder::<MonitorCaptureSourceBuilder, _>("Monitor")?
            .set_monitor(primary)
            .set_capture_cursor(true)
            .set_capture_method(ObsDisplayCaptureMethod::MethodAuto)
            .add_to_scene(&mut scene)
            .context("adding monitor capture")?;

        // Layer 2: any fullscreen game, drawn on top when hooked.
        let game = context
            .source_builder::<GameCaptureSourceBuilder, _>("Game")?
            .set_capture_mode(ObsGameCaptureMode::Any)
            .set_capture_cursor(true)
            .set_capture_overlays(true)
            .set_anti_cheat_hook(true)
            .add_to_scene(&mut scene)
            .context("adding game capture")?;
        let game_signals = game.inner_source().source_specific_signals();
        let hooked = Arc::new(Mutex::new(None));
        spawn_hook_listener(&game_signals, hooked.clone(), on_hook)
            .context("subscribing to game capture hook signals")?;

        // Desktop audio from the default output device.
        let mut audio_settings = context.data()?;
        audio_settings.set_string("device_id", "default")?;
        scene
            .add_and_create_source(SourceInfo::new(
                "wasapi_output_capture",
                "Desktop Audio",
                Some(audio_settings),
                None,
            ))
            .context("adding desktop audio")?;

        scene.set_to_channel(0).context("activating scene")?;

        let clip_dir = settings
            .clip_dir
            .to_str()
            .context("clip directory path is not valid UTF-8")?;

        let replay = context
            .replay_buffer_builder("replay", ObsPath::new(clip_dir))
            .max_time_sec(settings.buffer_seconds)
            .max_size_mb(settings.buffer_max_mb)
            .format("%CCYY-%MM-%DD %hh-%mm-%ss")
            .extension("mp4")
            .video_bitrate(settings.video_bitrate_kbps)
            .audio_bitrate(192)
            .hardware_encoder(HardwareCodec::H264, HardwarePreset::Quality)
            .build()
            .context("building replay buffer")?;

        let encoder_id = pick_h264_encoder(&context)?;

        replay.start().context("starting replay buffer")?;
        log::info!("replay buffer running with encoder {encoder_id}");

        Ok(Self {
            _game_signals: game_signals,
            hooked,
            _context: context,
            replay,
            encoder_id,
        })
    }

    /// Flushes the buffer to disk and returns the saved file.
    pub fn save(&self) -> Result<PathBuf> {
        let path = self.replay.save_buffer().context("saving replay buffer")?;
        Ok(path.into_path_buf())
    }

    pub fn encoder_id(&self) -> &str {
        &self.encoder_id
    }

    pub fn is_active(&self) -> bool {
        self.replay.is_active().unwrap_or(false)
    }
}

/// Drains the `hooked`/`unhooked` broadcast receivers on a dedicated thread with a
/// current-thread tokio runtime. The thread exits on its own once the signal manager is
/// dropped and the channels close, so a Recorder restart never leaks a runtime.
fn spawn_hook_listener(
    signals: &ObsHookableSourceSignals,
    hooked: Arc<Mutex<Option<HookedGame>>>,
    on_hook: HookCallback,
) -> Result<()> {
    use tokio::sync::broadcast::error::RecvError;

    let mut hooked_rx = signals.on_hooked().context("subscribing to hooked")?;
    let mut unhooked_rx = signals.on_unhooked().context("subscribing to unhooked")?;

    let runtime = tokio::runtime::Builder::new_current_thread()
        .build()
        .context("building hook listener runtime")?;

    std::thread::Builder::new()
        .name("game-hook-signals".into())
        .spawn(move || {
            runtime.block_on(async move {
                loop {
                    let next = tokio::select! {
                        r = hooked_rx.recv() => r.map(|sig| Some(HookedGame {
                            title: sig.title,
                            class: sig.class,
                            executable: sig.executable,
                        })),
                        r = unhooked_rx.recv() => r.map(|_| None),
                    };
                    match next {
                        Ok(game) => {
                            match &game {
                                Some(g) => log::info!(
                                    "game capture hooked {} ({}, class {})",
                                    g.executable,
                                    g.title,
                                    g.class
                                ),
                                None => log::info!("game capture unhooked"),
                            }
                            *hooked.lock().unwrap_or_else(|p| p.into_inner()) = game.clone();
                            on_hook(game);
                        }
                        Err(RecvError::Lagged(n)) => {
                            log::debug!("hook signal listener lagged by {n} events");
                        }
                        Err(RecvError::Closed) => break,
                    }
                }
                log::debug!("hook signal listener stopped");
            });
        })
        .context("spawning hook listener thread")?;
    Ok(())
}

/// Mirrors the hardware selection order of the replay buffer builder, for status display.
fn pick_h264_encoder(context: &ObsContext) -> Result<String> {
    use libobs_wrapper::encoders::ObsVideoEncoderType as T;
    let available: Vec<T> = context
        .available_video_encoders()
        .context("listing encoders")?
        .into_iter()
        .map(|b| b.get_encoder_id().clone())
        .collect();
    log::info!("available video encoders: {available:?}");
    let preferred = [
        T::OBS_NVENC_H264_TEX,
        T::H264_TEXTURE_AMF,
        T::OBS_QSV11_V2,
        T::OBS_NVENC_H264_SOFT,
        T::OBS_QSV11_SOFT_V2,
    ];
    let chosen = preferred
        .into_iter()
        .find(|c| available.contains(c))
        .unwrap_or(T::OBS_X264);
    Ok(format!("{chosen:?}"))
}

impl Drop for Recorder {
    fn drop(&mut self) {
        if let Err(e) = self.replay.stop() {
            log::warn!("stopping replay buffer: {e}");
        }
    }
}
