//! Replay buffer and session recording on top of embedded libobs.
//!
//! The scene has two layers: a monitor capture of the primary display underneath and a
//! game capture of any fullscreen application on top. When a game is hooked it covers the
//! monitor layer; otherwise the desktop is what gets recorded. Desktop audio is mixed in.
//!
//! A session recording writes the same scene to a file for as long as a supported game runs.
//! It shares the replay buffer's encoders rather than opening its own, so recording a whole
//! session costs disk, not a second hardware encode.

use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use anyhow::{bail, Context, Result};
use libobs_simple::output::replay::ObsContextReplayExt;
use libobs_simple::output::simple::{HardwareCodec, HardwarePreset};
use libobs_simple::sources::windows::{
    GameCaptureSourceBuilder, MonitorCaptureSourceBuilder, ObsDisplayCaptureMethod,
    ObsGameCaptureMode, ObsHookableSourceSignals, ObsHookableSourceTrait,
};
use libobs_wrapper::context::ObsContext;
use libobs_wrapper::data::object::ObsObjectTrait;
use libobs_wrapper::data::output::{ObsOutputRef, ObsOutputTrait, ObsReplayBufferOutputRef};
use libobs_wrapper::data::video::ObsVideoInfoBuilder;
use libobs_wrapper::data::ObsDataSetters;
use libobs_wrapper::encoders::ObsContextEncoders;
use libobs_wrapper::scenes::SceneItemExtSceneTrait;
use libobs_wrapper::sources::ObsSourceBuilder;
use libobs_wrapper::utils::{ObsPath, OutputInfo, SourceInfo, StartupInfo};

/// Output types tried for a session recording, best first. `mp4_output` is OBS's hybrid MP4:
/// an ordinary MP4 to every player, and still readable after a crash because it writes as it
/// goes. `ffmpeg_muxer` is the classic recorder, kept for a runtime without the first, with
/// fragmented MP4 flags for the same crash safety.
const SESSION_OUTPUTS: [&str; 2] = ["mp4_output", "ffmpeg_muxer"];

/// How long a started recording may report itself inactive before it counts as lost. An
/// output that failed after a successful start (a muxer that died, a full disk) stops being
/// active; one that just started may take a moment to say it is.
const START_SETTLE: Duration = Duration::from_secs(5);

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
    let Some(fg) = crate::win::foreground_window() else {
        return Ok(None);
    };
    let in_use = GameCaptureSourceBuilder::is_window_in_use_by_other_instance(fg.pid)
        .with_context(|| format!("checking hook pipe for pid {}", fg.pid))?;
    if !in_use {
        return Ok(None);
    }
    log::debug!(
        "foreground process {} ({}) already hooked by another capture tool",
        fg.pid,
        fg.executable
    );
    Ok(Some(CaptureConflict {
        executable: fg.executable,
        title: fg.title,
    }))
}

/// The session recording that is running right now.
struct SessionRecording {
    output: ObsOutputRef,
    path: PathBuf,
    started: Instant,
}

pub struct Recorder {
    // Declared before `context` so the signal manager disconnects while the OBS runtime is
    // still alive. Dropping it closes the broadcast channels, which ends the hook thread.
    _game_signals: Arc<ObsHookableSourceSignals>,
    hooked: Arc<Mutex<Option<HookedGame>>>,
    session: Option<SessionRecording>,
    /// Session outputs created so far, by output type. Reused with a new path for every
    /// recording, because the context keeps every output it ever created.
    session_outputs: Vec<(&'static str, ObsOutputRef)>,
    context: ObsContext,
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
            session: None,
            session_outputs: Vec::new(),
            context,
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

    /// Starts writing the scene to `path` until `stop_recording`, on the replay buffer's own
    /// encoders. The replay buffer keeps running alongside.
    pub fn start_recording(&mut self, path: &Path) -> Result<()> {
        if self.session.is_some() {
            bail!("a session recording is already running");
        }
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)
                .with_context(|| format!("creating {}", parent.display()))?;
        }
        let path_text = path
            .to_str()
            .context("recording path is not valid UTF-8")?
            .to_string();
        let mut last_error = None;
        for kind in SESSION_OUTPUTS {
            match self.start_session_output(kind, &path_text) {
                Ok(output) => {
                    log::info!("session recording started with {kind}: {}", path.display());
                    self.session = Some(SessionRecording {
                        output,
                        path: path.to_path_buf(),
                        started: Instant::now(),
                    });
                    return Ok(());
                }
                Err(e) => {
                    log::warn!("session recording with {kind} did not start: {e:#}");
                    last_error = Some(e);
                }
            }
        }
        Err(last_error.unwrap_or_else(|| anyhow::anyhow!("no session output type available")))
            .context("starting the session recording")
    }

    fn start_session_output(&mut self, kind: &'static str, path: &str) -> Result<ObsOutputRef> {
        let mut settings = self.context.data()?;
        settings.set_string("path", path)?;
        if kind == "ffmpeg_muxer" {
            settings.set_string("muxer_settings", "movflags=frag_keyframe+empty_moov+default_base_moof")?;
        }
        let output = match self.session_outputs.iter().find(|(k, _)| *k == kind) {
            Some((_, existing)) => {
                existing.update_settings(settings).context("updating the output path")?;
                existing.clone()
            }
            None => {
                let mut output = self
                    .context
                    .output(OutputInfo::new(kind, format!("session_{kind}"), Some(settings), None))
                    .with_context(|| format!("creating {kind} output"))?;
                let video = self
                    .replay
                    .get_current_video_encoder()?
                    .context("the replay buffer has no video encoder to share")?;
                output.set_video_encoder(video).context("sharing the video encoder")?;
                let audio: Vec<_> = self
                    .replay
                    .audio_encoders()
                    .read()
                    .map_err(|e| anyhow::anyhow!("audio encoder lock poisoned: {e}"))?
                    .iter()
                    .map(|(mixer, encoder)| (*mixer, encoder.clone()))
                    .collect();
                for (mixer, encoder) in audio {
                    output
                        .set_audio_encoder(encoder, mixer)
                        .context("sharing the audio encoder")?;
                }
                self.session_outputs.push((kind, output.clone()));
                output
            }
        };
        output.start().with_context(|| format!("starting {kind}"))?;
        Ok(output)
    }

    /// Stops the session recording and waits until the file is closed. `None` when nothing
    /// was recording.
    pub fn stop_recording(&mut self) -> Result<Option<PathBuf>> {
        let Some(mut recording) = self.session.take() else {
            return Ok(None);
        };
        let active = recording.output.is_active().unwrap_or(false);
        if active {
            recording
                .output
                .stop()
                .with_context(|| format!("stopping the recording {}", recording.path.display()))?;
        }
        log::info!("session recording stopped: {}", recording.path.display());
        Ok(Some(recording.path))
    }

    /// The file the session recording is writing, while it is. A recording whose output died
    /// after starting reads as `None`, so the session watch starts a fresh one.
    pub fn recording_path(&self) -> Option<PathBuf> {
        let recording = self.session.as_ref()?;
        let settled = recording.started.elapsed() >= START_SETTLE;
        if settled && !recording.output.is_active().unwrap_or(false) {
            return None;
        }
        Some(recording.path.clone())
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
        // The session recording shares the replay buffer's encoders, so it closes its file
        // first. The session watch notices the recording is gone and starts a new one on the
        // next recorder.
        if let Err(e) = self.stop_recording() {
            log::warn!("stopping session recording: {e:#}");
        }
        if let Err(e) = self.replay.stop() {
            log::warn!("stopping replay buffer: {e}");
        }
    }
}
