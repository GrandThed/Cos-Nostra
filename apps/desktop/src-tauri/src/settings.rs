//! User settings for the clipper. Persisted as JSON under %APPDATA%\Cos Nostra.

use anyhow::Context as _;
use serde::{Deserialize, Serialize};
use std::path::PathBuf;

pub const MIN_BUFFER_SECONDS: i64 = 5;
pub const MAX_BUFFER_SECONDS: i64 = 300;
pub const MIN_BITRATE_KBPS: u32 = 2_000;
pub const MAX_BITRATE_KBPS: u32 = 60_000;
pub const DEFAULT_BACKEND_URL: &str = "https://cosnostra.benja.ar";
/// Upper bound for the clip folder budget. Well past any plausible disk, and only here so a
/// typo cannot ask for a limit that overflows the byte arithmetic.
pub const MAX_STORAGE_LIMIT_GB: u32 = 100_000;

/// How much the encoder is allowed to spend on a clip.
///
/// Every level is constant quality with a ceiling ("capped CRF"), not a bitrate target. That
/// distinction is the whole point: an ordinary clip never reaches its ceiling and comes out as
/// small as its content allows, while a high-motion one is trimmed instead of ballooning. The
/// per-encoder numbers live in `ffmpeg::av1_args` and `ffmpeg::h264_args`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Quality {
    /// Tighter ceiling. Noticeably softer on high motion, much smaller everywhere.
    Small,
    /// The default.
    #[default]
    Balanced,
    /// Loose ceiling. Big files on hard footage, near-transparent on everything else.
    High,
}

/// Which engine encodes finished clips.
///
/// This is not the same choice as the replay buffer's encoder, which is always hardware: the
/// buffer has to keep up with a game in real time, while clip encoding happens afterwards and
/// can take as long as it likes.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum EncodeEngine {
    /// The probed hardware encoder. Fast, and worse per byte.
    Gpu,
    /// libsvtav1 and libx264 on the CPU. Slower, and measurably better per byte.
    #[default]
    Cpu,
}

/// Language of everything the user reads: the web UI, the tray menu and the toasts.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Language {
    /// The default. The community this app is built for is Spanish-speaking.
    #[default]
    Es,
    En,
}

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
    /// How much the encoder may spend per clip.
    pub quality: Quality,
    /// Hardware or software encoding for finished clips. Not the replay buffer, which is
    /// always hardware.
    pub encode_engine: EncodeEngine,
    /// Language of the interface, the tray menu and the toasts.
    pub language: Language,
    /// Base URL of the Cos Nostra backend, no trailing slash.
    pub backend_url: String,
    /// Long-lived device token from the Discord device login. `None` when logged out.
    pub device_token: Option<String>,
    /// Who the token belongs to; shown in the UI.
    pub account: Option<Account>,
    /// Upload every encoded clip without asking.
    pub auto_upload: bool,
    /// Delete the original replay-buffer recording once both encoder outputs exist. The buffer
    /// writes about ten times what the AV1 copy costs, so this is where the disk goes. Off by
    /// default because the original is the best source for a future re-encode or trim.
    pub delete_source_after_encode: bool,
    /// Keep the clip folder under this many gigabytes, 0 for no limit. Enforced by dropping the
    /// local video of the oldest clips the backend already has, never anything only stored here.
    pub storage_limit_gb: u32,
    /// Record every session of a supported game (Valorant, League of Legends, Counter-Strike)
    /// from start to finish and cut it into matches afterwards. The recording shares the
    /// replay buffer's encoder, so it costs disk (about 9 GB an hour at the default bitrate
    /// until the session is cut), not frames.
    pub record_sessions: bool,
    /// Bring the window up on the finished session when the player leaves the game.
    pub open_after_session: bool,
    /// Set once the first-run flow (runtime download, encoder probe, Discord link) has been
    /// seen through or skipped. Until then the window shows that flow instead of the library.
    ///
    /// Defaults to `true` so that upgrading an install whose `settings.json` predates the flow
    /// does not replay it; `load` clears it only when there is no settings file at all.
    pub first_run_done: bool,
    /// Set after the one-time "still recording in the tray" toast on the first window close.
    pub tray_hint_shown: bool,
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
            quality: Quality::default(),
            encode_engine: EncodeEngine::default(),
            language: Language::default(),
            backend_url: DEFAULT_BACKEND_URL.into(),
            device_token: None,
            account: None,
            auto_upload: true,
            delete_source_after_encode: false,
            storage_limit_gb: 0,
            record_sessions: true,
            open_after_session: true,
            first_run_done: true,
            tray_hint_shown: false,
        }
    }
}

/// Per-user data directory (`%APPDATA%\Cos Nostra`): settings, the clip queue database, the
/// session database.
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
    ///
    /// No file at all is the one case that means "nobody has run this app here yet", so it is
    /// also the only thing that arms the first-run flow. A file that exists but cannot be read
    /// or parsed keeps the flow away: those users have used the app, they just lost a setting.
    pub fn load() -> Self {
        let Some(path) = Self::path() else {
            return Self::default();
        };
        let text = match std::fs::read_to_string(&path) {
            Ok(text) => text,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                return Self {
                    first_run_done: false,
                    ..Self::default()
                }
            }
            Err(e) => {
                log::warn!("{} could not be read, using defaults: {e}", path.display());
                return Self::default();
            }
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
        if self.storage_limit_gb > MAX_STORAGE_LIMIT_GB {
            anyhow::bail!("storage limit must be at most {MAX_STORAGE_LIMIT_GB} GB");
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

/// Accepts `https://host[:port][/path]`; no query, fragment or trailing slash.
///
/// Plain `http://` is allowed only for `localhost` and `127.0.0.1`, which is how the local dev
/// backend is used. Everything else has to be https: the device token, every clip and the
/// verification URL the app opens in a browser all travel over this URL, so a cleartext one
/// hands all three to anyone on the network.
pub fn validate_backend_url(url: &str) -> anyhow::Result<()> {
    let (plain, rest) = match url.strip_prefix("https://") {
        Some(rest) => (false, rest),
        None => match url.strip_prefix("http://") {
            Some(rest) => (true, rest),
            None => anyhow::bail!("backend URL must start with https://"),
        },
    };
    let host = rest.split('/').next().unwrap_or("");
    if host.is_empty() || host.contains(char::is_whitespace) {
        anyhow::bail!("backend URL needs a host");
    }
    if plain && !is_local_host(host) {
        anyhow::bail!("backend URL must be https:// (http:// only for localhost)");
    }
    if url.ends_with('/') || url.contains('?') || url.contains('#') {
        anyhow::bail!("backend URL must not end with / or contain ? or #");
    }
    Ok(())
}

/// True for the host part (port optional) of a backend running on this machine.
fn is_local_host(host: &str) -> bool {
    let name = host.split(':').next().unwrap_or(host);
    name.eq_ignore_ascii_case("localhost") || name == "127.0.0.1"
}

/// The clip folder is more than a preference: `lib.rs` widens the asset protocol scope to it
/// so the player can read videos out of it, and the Storage tab hands it to the shell. Both
/// mean the webview must not be able to name an arbitrary string here, so a folder has to be
/// a full path that already exists rather than anything non-empty.
pub fn validate_clip_dir(dir: &std::path::Path) -> anyhow::Result<()> {
    if dir.as_os_str().is_empty() {
        anyhow::bail!("clip folder must not be empty");
    }
    if !dir.is_absolute() {
        anyhow::bail!(
            "clip folder must be a full path, like C:\\Users\\you\\Videos\\Cos Nostra (got {})",
            dir.display()
        );
    }
    let meta = std::fs::metadata(dir)
        .with_context(|| format!("clip folder {} cannot be read", dir.display()))?;
    if !meta.is_dir() {
        anyhow::bail!("clip folder {} is not a folder", dir.display());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn backend_url_validation() {
        assert!(validate_backend_url(DEFAULT_BACKEND_URL).is_ok());
        assert!(validate_backend_url("https://x.example/api").is_ok());
        assert!(validate_backend_url("cosnostra.benja.ar").is_err());
        assert!(validate_backend_url("https://").is_err());
        assert!(validate_backend_url("https://x.example/").is_err());
        assert!(validate_backend_url("ftp://x.example").is_err());
    }

    #[test]
    fn only_a_local_backend_may_be_plain_http() {
        // How the dev backend is pointed at; see the note in CLAUDE.md.
        assert!(validate_backend_url("http://localhost:3000").is_ok());
        assert!(validate_backend_url("http://127.0.0.1:3000").is_ok());
        assert!(validate_backend_url("http://LOCALHOST:3000").is_ok());
        // Everything else carries the device token and the clips, so it has to be https.
        assert!(validate_backend_url("http://cosnostra.benja.ar").is_err());
        assert!(validate_backend_url("http://192.168.1.5:3000").is_err());
        // Not a loopback host, just one that starts like one.
        assert!(validate_backend_url("http://localhost.evil.example").is_err());
    }

    #[test]
    fn the_clip_folder_must_be_an_existing_absolute_path() {
        let dir = std::env::temp_dir().join(format!("cos-nostra-dir-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        validate_clip_dir(&dir).unwrap();

        assert!(validate_clip_dir(std::path::Path::new("")).is_err());
        assert!(validate_clip_dir(std::path::Path::new("clips")).is_err(), "relative");
        assert!(validate_clip_dir(std::path::Path::new(r"..\clips")).is_err(), "relative");
        assert!(
            validate_clip_dir(&dir.join("does-not-exist")).is_err(),
            "a folder that is not there"
        );

        let file = dir.join("not-a-folder.txt");
        std::fs::write(&file, b"x").unwrap();
        assert!(validate_clip_dir(&file).is_err(), "a file is not a folder");

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn defaults_are_logged_out() {
        let s = Settings::default();
        assert!(!s.logged_in());
        assert!(s.auto_upload);
        assert_eq!(s.backend_url, DEFAULT_BACKEND_URL);
        s.validate().unwrap();
    }

    #[test]
    fn a_settings_file_written_before_the_quality_picker_still_loads() {
        // Every existing install has a settings.json with neither field. serde(default) on
        // the struct is what keeps those from being reset to defaults wholesale, so this
        // asserts the untouched fields survive and the two new ones arrive at their default.
        let old = r#"{
            "hotkey": "Alt+F9",
            "buffer_seconds": 45,
            "clip_dir": "C:\\clips",
            "auto_upload": false
        }"#;
        let s: Settings = serde_json::from_str(old).unwrap();
        assert_eq!(s.hotkey, "Alt+F9");
        assert_eq!(s.buffer_seconds, 45);
        assert!(!s.auto_upload);
        assert_eq!(s.quality, Quality::Balanced);
        assert_eq!(s.encode_engine, EncodeEngine::Cpu);
        // The storage settings arrived later still, and both defaults mean "behave as before".
        assert!(!s.delete_source_after_encode);
        assert_eq!(s.storage_limit_gb, 0);
        // Session recording arrived after that, on by default.
        assert!(s.record_sessions);
        assert!(s.open_after_session);
        // Localization arrived last; an install from before it reads as Spanish, like a new one.
        assert_eq!(s.language, Language::Es);
        // A settings file is proof the app has run here, so the first-run flow stays away
        // even though the key that records it was only added with the new window.
        assert!(s.first_run_done);
    }

    #[test]
    fn the_storage_limit_is_range_checked() {
        let ok = Settings { storage_limit_gb: 500, ..Default::default() };
        ok.validate().unwrap();
        let absurd = Settings {
            storage_limit_gb: MAX_STORAGE_LIMIT_GB + 1,
            ..Default::default()
        };
        assert!(absurd.validate().is_err());
    }

    #[test]
    fn quality_and_engine_round_trip_as_snake_case() {
        // The web UI reads and writes these as the literal strings in its <select> options,
        // so the wire spelling is part of the contract with main.ts.
        let mut s = Settings::default();
        s.quality = Quality::Small;
        s.encode_engine = EncodeEngine::Gpu;
        let json = serde_json::to_string(&s).unwrap();
        assert!(json.contains(r#""quality":"small""#), "{json}");
        assert!(json.contains(r#""encode_engine":"gpu""#), "{json}");

        let back: Settings = serde_json::from_str(&json).unwrap();
        assert_eq!(back.quality, Quality::Small);
        assert_eq!(back.encode_engine, EncodeEngine::Gpu);
    }

    #[test]
    fn the_language_round_trips_as_a_two_letter_code() {
        // Same contract as quality and encode_engine: these are the <select> values in the UI.
        let mut s = Settings::default();
        assert_eq!(s.language, Language::Es);
        let json = serde_json::to_string(&s).unwrap();
        assert!(json.contains(r#""language":"es""#), "{json}");

        s.language = Language::En;
        let json = serde_json::to_string(&s).unwrap();
        assert!(json.contains(r#""language":"en""#), "{json}");

        let back: Settings = serde_json::from_str(&json).unwrap();
        assert_eq!(back.language, Language::En);
        let es: Settings = serde_json::from_str(r#"{"language":"es"}"#).unwrap();
        assert_eq!(es.language, Language::Es);
    }
}
