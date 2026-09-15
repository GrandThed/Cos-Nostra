//! Replay buffer and session recording on top of embedded libobs.
//!
//! The scene has two layers: a monitor capture of the primary display underneath and a
//! game capture of any fullscreen application on top. When a game is hooked it covers the
//! monitor layer; otherwise the desktop is what gets recorded. Sound comes from the desktop,
//! from the hooked game alone, or from the game plus chosen apps (`AudioSource`), and the
//! microphone can be added on a track of its own (see `TRACK_MIX`).
//!
//! A session recording writes the same scene to a file for as long as a supported game runs.
//! It shares the replay buffer's encoders rather than opening its own, so recording a whole
//! session costs disk, not a second hardware encode.

use std::ffi::CStr;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use anyhow::{anyhow, bail, Context, Result};
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
use libobs_wrapper::encoders::{ObsAudioEncoderType, ObsContextEncoders};
use libobs_wrapper::scenes::SceneItemExtSceneTrait;
use libobs_wrapper::sources::{ObsFilterRef, ObsSourceBuilder, ObsSourceTrait};
use libobs_wrapper::utils::{AudioEncoderInfo, ObsPath, OutputInfo, SourceInfo, StartupInfo};

/// Output types tried for a session recording, best first. `mp4_output` is OBS's hybrid MP4:
/// an ordinary MP4 to every player, and still readable after a crash because it writes as it
/// goes. `ffmpeg_muxer` is the classic recorder, kept for a runtime without the first, with
/// fragmented MP4 flags for the same crash safety.
const SESSION_OUTPUTS: [&str; 2] = ["mp4_output", "ffmpeg_muxer"];

/// How long a started recording may report itself inactive before it counts as lost. An
/// output that failed after a successful start (a muxer that died, a full disk) stops being
/// active; one that just started may take a moment to say it is.
const START_SETTLE: Duration = Duration::from_secs(5);

/// Audio tracks of every recording, as libobs mixer and output track indexes alike. Track 1 is
/// the mix of everything recorded, which is what a player plays. With the microphone on, track
/// 2 is that mix without the microphone and track 3 the microphone alone, so a clip can leave
/// the voice out when it is published or exported. With it off track 1 is the only one, exactly
/// as recordings were before the microphone existed.
pub const TRACK_MIX: usize = 0;
pub const TRACK_NO_MIC: usize = 1;
pub const TRACK_MIC: usize = 2;

/// Which mixers a source feeds: everything but the microphone goes to the mix and to the
/// voiceless track, the microphone to the mix and to its own.
const MIXERS_SOUND: u32 = (1 << TRACK_MIX) | (1 << TRACK_NO_MIC);
const MIXERS_MIC: u32 = (1 << TRACK_MIX) | (1 << TRACK_MIC);

/// AAC bitrate of every audio track.
const AUDIO_BITRATE_KBPS: i64 = 192;

/// OBS's per-application audio source (Windows 10 2004 and newer).
const APP_AUDIO_SOURCE: &CStr = c"wasapi_process_output_capture";
/// `WINDOW_PRIORITY_EXE` in OBS's window helpers: pick the window whose process has this name.
const WINDOW_PRIORITY_EXE: i64 = 2;
/// RNNoise, OBS's own noise suppression. The filter and the method name are both in the
/// `obs-filters` plugin the runtime ships.
const NOISE_FILTER: &str = "noise_suppress_filter_v2";

use crate::settings::{AudioSource, Settings};

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
    /// The file it started with.
    path: PathBuf,
    /// The file it moved on to at its last split, if it split.
    current: &'static FileSlot,
    started: Instant,
}

/// Where a session output writes after a split. OBS names those files itself and says so with
/// its `file_changed` signal, whose handler keeps the name here. One per output, leaked on
/// purpose: the signal is connected for the life of the output, which the context owns.
type FileSlot = Mutex<Option<PathBuf>>;

unsafe extern "C" fn on_file_changed(data: *mut std::ffi::c_void, calldata: *mut libobs_wrapper::sys::calldata_t) {
    if data.is_null() || calldata.is_null() {
        return;
    }
    // Safety: `data` is the leaked `FileSlot` this handler was connected with, which is never
    // freed; `calldata` is OBS's for the duration of the call.
    let slot = unsafe { &*(data as *const FileSlot) };
    let mut next: *const std::os::raw::c_char = std::ptr::null();
    let found = unsafe { libobs_wrapper::sys::calldata_get_string(calldata, c"next_file".as_ptr(), &mut next) };
    if !found || next.is_null() {
        return;
    }
    // OBS builds the name with forward slashes; rows store Windows paths.
    let name = unsafe { CStr::from_ptr(next) }.to_string_lossy().replace('/', "\\");
    log::info!("session recording split, now writing {name}");
    *slot.lock().unwrap_or_else(|p| p.into_inner()) = Some(PathBuf::from(name));
}

pub struct Recorder {
    // Declared before `context` so the signal manager disconnects while the OBS runtime is
    // still alive. Dropping it closes the broadcast channels, which ends the hook thread.
    _game_signals: Arc<ObsHookableSourceSignals>,
    hooked: Arc<Mutex<Option<HookedGame>>>,
    session: Option<SessionRecording>,
    /// Session outputs created so far, by output type, with the slot their split signal fills.
    /// Reused with a new path for every recording, because the context keeps every output it
    /// ever created.
    session_outputs: Vec<(&'static str, ObsOutputRef, &'static FileSlot)>,
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

        // The canvas is the primary screen; the picture encoded is that, or smaller.
        let screen = ObsVideoInfoBuilder::new().build();
        let (width, height) = output_size(screen.get_base_width(), screen.get_base_height(), settings.record_height);
        let video = ObsVideoInfoBuilder::new()
            .fps_num(settings.fps)
            .fps_den(1)
            .output_width(width)
            .output_height(height)
            .build();
        log::info!(
            "recording {width}x{height} at {} fps from a {}x{} screen",
            settings.fps,
            screen.get_base_width(),
            screen.get_base_height()
        );

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

        // Sound from the game alone needs application audio capture, which older Windows lacks;
        // those systems keep recording the desktop rather than recording nothing.
        let mut sound = settings.audio_source;
        if sound != AudioSource::System && !app_audio_available(&context) {
            log::warn!("application audio capture is not available here; recording all desktop audio instead");
            sound = AudioSource::System;
        }

        // Layer 2: any fullscreen game, drawn on top when hooked. Its own audio follows the
        // hooked window, which is how "only the game" is recorded.
        let mut game_builder = context
            .source_builder::<GameCaptureSourceBuilder, _>("Game")?
            .set_capture_mode(ObsGameCaptureMode::Any)
            .set_capture_cursor(true)
            .set_capture_overlays(true)
            .set_anti_cheat_hook(true);
        if sound != AudioSource::System {
            game_builder = game_builder
                .set_capture_audio(true)
                .map_err(|e| anyhow!("{e:?}"))
                .context("capturing the game's audio")?;
        }
        let game = game_builder.add_to_scene(&mut scene).context("adding game capture")?;
        let game_signals = game.inner_source().source_specific_signals();
        let hooked = Arc::new(Mutex::new(None));
        spawn_hook_listener(&game_signals, hooked.clone(), on_hook)
            .context("subscribing to game capture hook signals")?;

        match sound {
            AudioSource::System => {
                // Everything the default output device plays.
                let mut audio_settings = context.data()?;
                audio_settings.set_string("device_id", crate::settings::DEFAULT_DEVICE)?;
                let desktop = scene
                    .add_and_create_source(SourceInfo::new(
                        "wasapi_output_capture",
                        "Desktop Audio",
                        Some(audio_settings),
                        None,
                    ))
                    .context("adding desktop audio")?;
                tune_audio(desktop.inner_source(), MIXERS_SOUND, 1.0, false)?;
            }
            AudioSource::Game | AudioSource::GameAndApps => {
                tune_audio(game.inner_source(), MIXERS_SOUND, 1.0, false)?;
            }
        }
        if sound == AudioSource::GameAndApps {
            for (i, app) in settings.audio_apps.iter().enumerate() {
                if let Err(e) = add_app_audio(&context, &mut scene, i, app) {
                    // One app that cannot be captured must not cost the recording.
                    log::warn!("not recording {app}: {e:#}");
                }
            }
        }
        if settings.mic_enabled {
            add_microphone(&context, &mut scene, settings).context("adding the microphone")?;
        }

        scene.set_to_channel(0).context("activating scene")?;

        let clip_dir = settings
            .clip_dir
            .to_str()
            .context("clip directory path is not valid UTF-8")?;

        // The memory cap has to hold the whole buffer at the chosen bitrate, or a high quality
        // preset quietly shortens it. A quarter over what the bitrates add up to.
        let tracks = if settings.mic_enabled { 3 } else { 1 };
        let kbps = i64::from(settings.video_bitrate_kbps) + AUDIO_BITRATE_KBPS * tracks;
        let needed_mb = kbps * settings.buffer_seconds / 8 / 1000 * 5 / 4;
        let mut replay = context
            .replay_buffer_builder("replay", ObsPath::new(clip_dir))
            .max_time_sec(settings.buffer_seconds)
            .max_size_mb(settings.buffer_max_mb.max(needed_mb))
            .format("%CCYY-%MM-%DD %hh-%mm-%ss")
            .extension("mp4")
            .video_bitrate(settings.video_bitrate_kbps)
            .audio_bitrate(AUDIO_BITRATE_KBPS as u32)
            .hardware_encoder(HardwareCodec::H264, HardwarePreset::Quality)
            .build()
            .context("building replay buffer")?;
        // The builder encodes the mix on track 1. The two microphone tracks get encoders of
        // their own, which the session recording shares like the rest.
        if settings.mic_enabled {
            for track in [TRACK_NO_MIC, TRACK_MIC] {
                let mut audio = context.data()?;
                audio.set_string("rate_control", "CBR")?;
                audio.set_int("bitrate", AUDIO_BITRATE_KBPS)?;
                let name = format!("replay_audio_track{}", track + 1);
                replay
                    .create_and_set_audio_encoder(
                        AudioEncoderInfo::new(ObsAudioEncoderType::FFMPEG_AAC, name.as_str(), Some(audio), None),
                        track,
                    )
                    .with_context(|| format!("adding audio track {}", track + 1))?;
            }
        }

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
    ///
    /// With `split`, the output closes the file on the first keyframe after that long and
    /// carries on in a new one next to it, named `<stem>-<date>-<time>.mp4`, without losing a
    /// frame; `recording_path` follows it.
    pub fn start_recording(&mut self, path: &Path, split: Option<Duration>) -> Result<()> {
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
            match self.start_session_output(kind, path, &path_text, split) {
                Ok((output, current)) => {
                    log::info!("session recording started with {kind}: {}", path.display());
                    self.session = Some(SessionRecording {
                        output,
                        path: path.to_path_buf(),
                        current,
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

    fn start_session_output(
        &mut self,
        kind: &'static str,
        path: &Path,
        path_text: &str,
        split: Option<Duration>,
    ) -> Result<(ObsOutputRef, &'static FileSlot)> {
        let mut settings = self.context.data()?;
        settings.set_string("path", path_text)?;
        if kind == "ffmpeg_muxer" {
            settings.set_string("muxer_settings", "movflags=frag_keyframe+empty_moov+default_base_moof")?;
        }
        // An output is reused, and its settings merge, so the split keys are always written.
        settings.set_bool("split_file", split.is_some())?;
        settings.set_int("max_time_sec", split.map_or(0, |d| d.as_secs() as i64))?;
        if split.is_some() {
            let dir = path
                .parent()
                .and_then(Path::to_str)
                .context("recording folder is not valid UTF-8")?;
            let stem = path
                .file_stem()
                .and_then(|s| s.to_str())
                .context("recording name is not valid UTF-8")?;
            settings.set_string("directory", dir)?;
            // OBS's own date codes; `%` is the only character they claim.
            settings.set_string("format", format!("{}-%CCYY%MM%DD-%hh%mm%ss", stem.replace('%', "")).as_str())?;
            settings.set_string("extension", "mp4")?;
            settings.set_bool("allow_spaces", false)?;
            settings.set_bool("allow_overwrite", false)?;
        }
        let existing = self
            .session_outputs
            .iter()
            .find(|(k, _, _)| *k == kind)
            .map(|(_, output, slot)| (output.clone(), *slot));
        let (output, slot) = match existing {
            Some((existing, slot)) => {
                existing.update_settings(settings).context("updating the output path")?;
                (existing, slot)
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
                let slot: &'static FileSlot = Box::leak(Box::new(Mutex::new(None)));
                connect_file_changed(&output, slot).context("listening for file splits")?;
                self.session_outputs.push((kind, output.clone(), slot));
                (output, slot)
            }
        };
        *slot.lock().unwrap_or_else(|p| p.into_inner()) = None;
        output.start().with_context(|| format!("starting {kind}"))?;
        Ok((output, slot))
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
        let path = recording.current_file();
        log::info!("session recording stopped: {}", path.display());
        Ok(Some(path))
    }

    /// The file the session recording is writing, while it is: the one it started with, or the
    /// one it split off last. A recording whose output died after starting reads as `None`, so
    /// the session watch starts a fresh one.
    pub fn recording_path(&self) -> Option<PathBuf> {
        let recording = self.session.as_ref()?;
        let settled = recording.started.elapsed() >= START_SETTLE;
        if settled && !recording.output.is_active().unwrap_or(false) {
            return None;
        }
        Some(recording.current_file())
    }
}

impl SessionRecording {
    fn current_file(&self) -> PathBuf {
        self.current
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .clone()
            .unwrap_or_else(|| self.path.clone())
    }
}

/// Connects `on_file_changed` to an output, filling `slot`.
fn connect_file_changed(output: &ObsOutputRef, slot: &'static FileSlot) -> Result<()> {
    let ptr = output.as_ptr();
    let data = libobs_wrapper::unsafe_send::Sendable(slot as *const FileSlot as *mut std::ffi::c_void);
    libobs_wrapper::run_with_obs!(output.runtime(), (ptr, data), move || unsafe {
        // Safety: the output is alive for the call; the handler and the leaked slot outlive it.
        let handler = libobs_wrapper::sys::obs_output_get_signal_handler(ptr.get_ptr());
        libobs_wrapper::sys::signal_handler_connect(handler, c"file_changed".as_ptr(), Some(on_file_changed), data.0);
    })
    .context("connecting file_changed")
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

/// The size a `base_width`x`base_height` screen is recorded at with a height cap of `cap` (0 for
/// none): the same shape, never larger, both sides even as 4:2:0 encoders need.
fn output_size(base_width: u32, base_height: u32, cap: u32) -> (u32, u32) {
    let even = |n: u32| (n / 2 * 2).max(2);
    if cap == 0 || base_height <= cap || base_height == 0 {
        return (even(base_width), even(base_height));
    }
    let width = (u64::from(base_width) * u64::from(cap) + u64::from(base_height) / 2) / u64::from(base_height);
    (even(width as u32), even(cap))
}

/// Routes a source's sound to `mixers` at `volume` (1.0 is unchanged), downmixed to mono when
/// asked. None of this has a wrapper in libobs-rs, so it is the raw calls on the OBS thread.
fn tune_audio<S>(source: &S, mixers: u32, volume: f32, mono: bool) -> Result<()>
where
    S: ObsObjectTrait<*mut libobs_wrapper::sys::obs_source_t>,
{
    let ptr = source.as_ptr();
    libobs_wrapper::run_with_obs!(source.runtime(), (ptr), move || unsafe {
        // Safety: the smart pointer keeps the source alive for the call, which runs on the
        // OBS thread like every other libobs call.
        let raw = ptr.get_ptr();
        libobs_wrapper::sys::obs_source_set_audio_mixers(raw, mixers);
        libobs_wrapper::sys::obs_source_set_volume(raw, volume);
        if mono {
            let flags = libobs_wrapper::sys::obs_source_get_flags(raw);
            libobs_wrapper::sys::obs_source_set_flags(raw, flags | libobs_wrapper::sys::OBS_SOURCE_FLAG_FORCE_MONO);
        }
    })
    .context("routing a source's audio")
}

/// True when this runtime can capture one application's audio, which the game-only and
/// game-and-apps sources need.
fn app_audio_available(context: &ObsContext) -> bool {
    libobs_wrapper::run_with_obs!(context.runtime(), move || unsafe {
        // Safety: a static C string, looked up on the OBS thread.
        !libobs_wrapper::sys::obs_get_latest_input_type_id(APP_AUDIO_SOURCE.as_ptr()).is_null()
    })
    .unwrap_or(false)
}

/// Records one app's sound next to the game, found by its executable's window.
fn add_app_audio(context: &ObsContext, scene: &mut libobs_wrapper::scenes::ObsSceneRef, index: usize, exe: &str) -> Result<()> {
    crate::settings::validate_audio_app(exe)?;
    let mut settings = context.data()?;
    // OBS names a window `title:class:exe`; empty title and class with the exe priority match
    // any window of the process.
    settings.set_string("window", format!("::{exe}").as_str())?;
    settings.set_int("priority", WINDOW_PRIORITY_EXE)?;
    let name = format!("App Audio {}", index + 1);
    let source = scene
        .add_and_create_source(SourceInfo::new(
            APP_AUDIO_SOURCE.to_str().expect("ASCII"),
            name.as_str(),
            Some(settings),
            None,
        ))
        .context("adding the app's audio source")?;
    tune_audio(source.inner_source(), MIXERS_SOUND, 1.0, false)?;
    log::info!("recording the audio of {exe} next to the game");
    Ok(())
}

/// The microphone, on the mix and on its own track. Downmixed to mono, since a voice is mono
/// and many USB microphones deliver it on the left channel only.
fn add_microphone(context: &ObsContext, scene: &mut libobs_wrapper::scenes::ObsSceneRef, settings: &Settings) -> Result<()> {
    let mut mic_settings = context.data()?;
    mic_settings.set_string("device_id", settings.mic_device.as_str())?;
    let mic = scene
        .add_and_create_source(SourceInfo::new("wasapi_input_capture", "Microphone", Some(mic_settings), None))
        .context("creating the microphone source")?;
    tune_audio(mic.inner_source(), MIXERS_MIC, settings.mic_volume as f32 / 100.0, true)?;
    if settings.mic_noise_suppression {
        let suppress = (|| -> Result<()> {
            let mut filter_settings = context.data()?;
            filter_settings.set_string("method", "rnnoise")?;
            let filter = ObsFilterRef::new(
                NOISE_FILTER,
                "Noise Suppression",
                Some(filter_settings.into_immutable()),
                None,
                context.runtime().clone(),
            )?;
            mic.inner_source().apply_filter(&filter)?;
            Ok(())
        })();
        // A voice with some background noise beats no voice at all.
        if let Err(e) = suppress {
            log::warn!("microphone noise suppression is off: {e:#}");
        }
    }
    log::info!(
        "recording the microphone {} at {} %",
        settings.mic_device,
        settings.mic_volume
    );
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

#[cfg(test)]
mod tests {
    use super::output_size;

    #[test]
    fn the_recording_is_scaled_down_in_shape() {
        assert_eq!(output_size(2560, 1440, 0), (2560, 1440));
        assert_eq!(output_size(2560, 1440, 1080), (1920, 1080));
        assert_eq!(output_size(3440, 1440, 1080), (2580, 1080), "ultrawide keeps its shape");
        assert_eq!(output_size(1920, 1080, 1440), (1920, 1080), "never up");
        assert_eq!(output_size(1366, 768, 720), (1280, 720));
    }
}
