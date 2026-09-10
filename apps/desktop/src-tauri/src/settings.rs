//! User settings for the clipper. Persisted as JSON under %APPDATA%\Cos Nostra.

use serde::{Deserialize, Serialize};
use std::path::PathBuf;

pub const MIN_BUFFER_SECONDS: i64 = 5;
pub const MAX_BUFFER_SECONDS: i64 = 300;
pub const MIN_BITRATE_KBPS: u32 = 2_000;
pub const MAX_BITRATE_KBPS: u32 = 60_000;
pub const DEFAULT_BACKEND_URL: &str = "https://cosnostra.benja.ar";

/// The Discord user this device is linked to, as reported by the backend.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Account {
    pub discord_id: String,
    pub username: String,
    pub avatar: Option<String>,
}

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
    /// ffmpeg encoders chosen by the startup probe. `None` until the probe has run.
    pub encoders: Option<crate::ffmpeg::Encoders>,
    /// Encode even while a game is in the foreground. Off by default to protect frame rate.
    pub encode_while_gaming: bool,
    /// Base URL of the Cos Nostra backend, no trailing slash.
    pub backend_url: String,
    /// Long-lived device token from the Discord device login. `None` when logged out.
    pub device_token: Option<String>,
    /// Who the token belongs to; shown in the UI.
    pub account: Option<Account>,
    /// Upload every encoded clip without asking.
    pub auto_upload: bool,
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
            encoders: None,
            encode_while_gaming: false,
            backend_url: DEFAULT_BACKEND_URL.into(),
            device_token: None,
            account: None,
            auto_upload: true,
        }
    }
}

/// Per-user data directory (`%APPDATA%\Cos Nostra`): settings, the clip queue database.
/// `None` when APPDATA is not set, which only happens in odd service contexts.
pub fn data_dir() -> Option<PathBuf> {
    std::env::var_os("APPDATA").map(|p| PathBuf::from(p).join("Cos Nostra"))
}

impl Settings {
    fn path() -> Option<PathBuf> {
        data_dir().map(|d| d.join("settings.json"))
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
        validate_backend_url(&self.backend_url)?;
        Ok(())
    }

    /// True when a device token is stored (not necessarily still valid).
    pub fn logged_in(&self) -> bool {
        self.device_token.is_some()
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

/// Accepts `http://host[:port][/path]` or `https://...`; no query, fragment or trailing slash.
pub fn validate_backend_url(url: &str) -> anyhow::Result<()> {
    let rest = url
        .strip_prefix("https://")
        .or_else(|| url.strip_prefix("http://"))
        .ok_or_else(|| anyhow::anyhow!("backend URL must start with http:// or https://"))?;
    let host = rest.split('/').next().unwrap_or("");
    if host.is_empty() || host.contains(char::is_whitespace) {
        anyhow::bail!("backend URL needs a host");
    }
    if url.ends_with('/') || url.contains('?') || url.contains('#') {
        anyhow::bail!("backend URL must not end with / or contain ? or #");
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn backend_url_validation() {
        assert!(validate_backend_url(DEFAULT_BACKEND_URL).is_ok());
        assert!(validate_backend_url("http://localhost:3000").is_ok());
        assert!(validate_backend_url("https://x.example/api").is_ok());
        assert!(validate_backend_url("cosnostra.benja.ar").is_err());
        assert!(validate_backend_url("https://").is_err());
        assert!(validate_backend_url("https://x.example/").is_err());
        assert!(validate_backend_url("ftp://x.example").is_err());
    }

    #[test]
    fn defaults_are_logged_out() {
        let s = Settings::default();
        assert!(!s.logged_in());
        assert!(s.auto_upload);
        assert_eq!(s.backend_url, DEFAULT_BACKEND_URL);
        s.validate().unwrap();
    }
}
