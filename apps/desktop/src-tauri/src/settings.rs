//! User settings for the clipper. Persisted as JSON under %APPDATA%\Cos Nostra.

use serde::{Deserialize, Serialize};
use std::path::PathBuf;

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
        }
    }
}

impl Settings {
    fn path() -> Option<PathBuf> {
        std::env::var_os("APPDATA")
            .map(|p| PathBuf::from(p).join("Cos Nostra").join("settings.json"))
    }

    pub fn load() -> Self {
        Self::path()
            .and_then(|p| std::fs::read_to_string(p).ok())
            .and_then(|s| serde_json::from_str(&s).ok())
            .unwrap_or_default()
    }

    pub fn save(&self) -> anyhow::Result<()> {
        let path = Self::path().ok_or_else(|| anyhow::anyhow!("APPDATA is not set"))?;
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        std::fs::write(path, serde_json::to_string_pretty(self)?)?;
        Ok(())
    }
}
