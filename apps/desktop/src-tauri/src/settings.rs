//! User settings for the clipper. Persisted as JSON under %APPDATA%\Cos Nostra.

use serde::{Deserialize, Serialize};
use std::path::PathBuf;

pub const MIN_BUFFER_SECONDS: i64 = 5;
pub const MAX_BUFFER_SECONDS: i64 = 300;
pub const MIN_BITRATE_KBPS: u32 = 2_000;
pub const MAX_BITRATE_KBPS: u32 = 60_000;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct Settings {
    /// Global hotkey that saves the replay buffer, in Tauri shortcut syntax.
    pub hotkey: String,
    /// Seconds of footage kept in memory.
    pub buffer_seconds: i64,
    /// Upper bound for the in-memory buffer.
    pub buffer_max_mb: i64,
    /// Video bitrate of the buffer in kbps. The buffer is re-encoded to AV1 later, so keep this high.
    pub video_bitrate_kbps: u32,
    /// Frames per second captured.
    pub fps: u32,
    /// Where saved clips land.
    pub clip_dir: PathBuf,
    /// Register the app to launch at Windows login.
    pub start_with_windows: bool,
    /// Show a toast after every save (and after a failed one).
    pub notify_on_save: bool,
    /// Play the system asterisk sound after a successful save.
    pub sound_on_save: bool,
}

impl Default for Settings {
    fn default() -> Self {
        let videos = std::env::var_os("USERPROFILE")
            .map(|p| PathBuf::from(p).join("Videos"))
            .unwrap_or_else(|| PathBuf::from("."));
        Self {
            hotkey: "Alt+F10".into(),
            buffer_seconds: 30,
            buffer_max_mb: 1024,
            video_bitrate_kbps: 20_000,
            fps: 60,
            clip_dir: videos.join("Cos Nostra"),
            start_with_windows: false,
            notify_on_save: true,
            sound_on_save: true,
        }
    }
}

impl Settings {
    fn path() -> Option<PathBuf> {
        std::env::var_os("APPDATA")
            .map(|p| PathBuf::from(p).join("Cos Nostra").join("settings.json"))
    }

    /// Loads the saved settings. A missing file is normal; an unreadable one is logged and
    /// replaced with defaults on the next save. A UTF-8 BOM (PowerShell's `-Encoding utf8`
    /// writes one) is stripped so hand edits do not silently reset everything.
    pub fn load() -> Self {
        let Some(path) = Self::path() else {
            return Self::default();
        };
        let Ok(text) = std::fs::read_to_string(&path) else {
            return Self::default();
        };
        match serde_json::from_str(text.trim_start_matches('\u{feff}')) {
            Ok(s) => s,
            Err(e) => {
                log::warn!("{} is not valid, using defaults: {e}", path.display());
                Self::default()
            }
        }
    }

    pub fn save(&self) -> anyhow::Result<()> {
        let path = Self::path().ok_or_else(|| anyhow::anyhow!("APPDATA is not set"))?;
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        std::fs::write(path, serde_json::to_string_pretty(self)?)?;
        Ok(())
    }

    /// Range checks for everything except the hotkey, which needs the shortcut parser in lib.rs.
    pub fn validate(&self) -> anyhow::Result<()> {
        if !(MIN_BUFFER_SECONDS..=MAX_BUFFER_SECONDS).contains(&self.buffer_seconds) {
            anyhow::bail!(
                "buffer length must be between {MIN_BUFFER_SECONDS} and {MAX_BUFFER_SECONDS} seconds"
            );
        }
        if !(MIN_BITRATE_KBPS..=MAX_BITRATE_KBPS).contains(&self.video_bitrate_kbps) {
            anyhow::bail!("video bitrate must be between {MIN_BITRATE_KBPS} and {MAX_BITRATE_KBPS} kbps");
        }
        if self.fps == 0 || self.fps > 240 {
            anyhow::bail!("fps must be between 1 and 240");
        }
        if self.buffer_max_mb <= 0 {
            anyhow::bail!("buffer_max_mb must be positive");
        }
        if self.clip_dir.as_os_str().is_empty() {
            anyhow::bail!("clip folder must not be empty");
        }
        if self.hotkey.trim().is_empty() {
            anyhow::bail!("hotkey must not be empty");
        }
        Ok(())
    }

    /// True when a change between `self` and `other` requires rebuilding the libobs pipeline.
    pub fn needs_recorder_restart(&self, other: &Settings) -> bool {
        self.buffer_seconds != other.buffer_seconds
            || self.buffer_max_mb != other.buffer_max_mb
            || self.video_bitrate_kbps != other.video_bitrate_kbps
            || self.fps != other.fps
            || self.clip_dir != other.clip_dir
    }
}
