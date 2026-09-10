//! Replay buffer on top of embedded libobs.
//!
//! The scene has two layers: a monitor capture of the primary display underneath and a
//! game capture of any fullscreen application on top. When a game is hooked it covers the
//! monitor layer; otherwise the desktop is what gets recorded. Desktop audio is mixed in.

use std::path::PathBuf;

use anyhow::{Context, Result};
use libobs_simple::output::replay::ObsContextReplayExt;
use libobs_simple::output::simple::{HardwareCodec, HardwarePreset};
use libobs_simple::sources::windows::{
    GameCaptureSourceBuilder, MonitorCaptureSourceBuilder, ObsDisplayCaptureMethod,
    ObsGameCaptureMode,
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

pub struct Recorder {
    _context: ObsContext,
    replay: ObsReplayBufferOutputRef,
    encoder_id: String,
}

impl Recorder {
    /// Boots libobs, builds the scene and starts the replay buffer.
    pub fn start(settings: &Settings) -> Result<Self> {
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
        context
            .source_builder::<GameCaptureSourceBuilder, _>("Game")?
            .set_capture_mode(ObsGameCaptureMode::Any)
            .set_capture_cursor(true)
            .set_capture_overlays(true)
            .set_anti_cheat_hook(true)
            .add_to_scene(&mut scene)
            .context("adding game capture")?;

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
