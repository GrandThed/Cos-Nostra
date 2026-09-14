mod api;
mod cutter;
mod capture;
mod edit;
mod settings;
mod storage;
mod ffmpeg;
mod games;
mod i18n;
mod placement;
mod providers;
mod queue;
mod session_app;
mod session_watch;
mod sessions;
mod timeline;
mod win;

use std::collections::HashMap;
use std::panic::AssertUnwindSafe;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use anyhow::Context as _;
use libobs_bootstrapper::status_handler::ObsBootstrapStatusHandler;
use serde::Serialize;
use tauri::menu::{Menu, MenuItem};
use tauri::tray::TrayIconBuilder;
use tauri::{AppHandle, Emitter, Manager, State};
use tauri_plugin_autostart::{MacosLauncher, ManagerExt as _};
use tauri_plugin_dialog::DialogExt as _;
use tauri_plugin_global_shortcut::{Code, GlobalShortcutExt, Shortcut, ShortcutState};
use tauri_plugin_notification::NotificationExt as _;
use tauri_plugin_opener::OpenerExt as _;

use api::{Api, DevicePoll, NewClipUpload, ReplaceClipUpload};
use capture::{CaptureConflict, HookCallback, HookedGame, Recorder};
use edit::{EditSource, SourceKind};
use ffmpeg::{Binaries, Cut, Encoders};
use games::DetectedGame;
use queue::{
    ClipPost, ClipRow, ClipStatus, Gate, NewClip, OnChange, Outputs, Processor, Queue, Refused,
    UploadResult, Uploader, Worker,
};
use settings::{Account, Language, Settings};

/// How long the device login keeps polling before giving up.
const LOGIN_TIMEOUT: Duration = Duration::from_secs(10 * 60);
const LOGIN_POLL: Duration = Duration::from_secs(2);

/// How often the posts cache is refreshed while logged in. Posts also change from Discord
/// itself (Hide in the manage menu, a bot that could not post), which nothing tells us about.
const POSTS_EVERY: Duration = Duration::from_secs(5 * 60);
/// After an upload completes the bot posts on its own time, so the cache is refreshed twice:
/// once when the post has usually landed, and once more for a slow bot or a rate limit.
const POSTS_AFTER_UPLOAD: [Duration; 2] = [Duration::from_secs(5), Duration::from_secs(30)];

/// Error texts the publish dialog recognises and puts in its own words. Anything else it shows
/// as it came.
const NOT_LOGGED_IN: &str = "not_logged_in";
const BOT_UNAVAILABLE: &str = "bot_unavailable";

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
    /// ffmpeg, once located at startup. `None` means encoding is unavailable.
    ffmpeg: Mutex<Option<Binaries>>,
    /// Why ffmpeg is unavailable, shown in the Status tab.
    ffmpeg_error: Mutex<Option<String>>,
    /// Clip queue; `None` until the database opened (or forever if it could not).
    queue: Mutex<Option<Arc<Queue>>>,
    worker: Mutex<Option<Worker>>,
    /// The device login in progress, if any. Replaced by `start_login`, cleared on finish.
    login: Mutex<Option<LoginSession>>,
    /// Where the OBS runtime download has got to. The first-run screen reads it, and polls it
    /// once at startup because the webview may finish loading after the download does.
    bootstrap: Mutex<Bootstrap>,
    /// Per-clip encode and upload percentages, keyed by clip id. Live only: the queue owns the
    /// statuses, this is just how far the job that is running right now has got.
    progress: Mutex<std::collections::HashMap<i64, ClipProgress>>,
    /// Game sessions and their matches; `None` until the database opened.
    sessions: Mutex<Option<Arc<sessions::SessionStore>>>,
    /// The session being played right now, as of the session watch's last look.
    live_session: Mutex<Option<session_watch::LiveSession>>,
    /// Sessions being cut into matches right now.
    processing: Mutex<session_app::Processing>,
    /// Held while the posts cache is refreshed, so the timers after an upload and the periodic
    /// refresh never write over each other with answers of different ages.
    posts_refresh: Mutex<()>,
}

/// A running device login: the poll thread stops when `cancelled` is set.
///
/// `poll_secret` lives here and nowhere else. It is not persisted (a login that outlives the
/// process is not a login) and it is never sent to the webview, which has no use for it.
struct LoginSession {
    code: String,
    /// Held so the secret's lifetime is the login's: replacing or cancelling a login drops it.
    /// The poll thread got its own copy, which is why nothing reads this one.
    #[allow(dead_code)]
    poll_secret: String,
    cancelled: Arc<AtomicBool>,
}

impl AppState {
    fn queue(&self) -> Option<Arc<Queue>> {
        self.queue.lock().unwrap().clone()
    }

    fn wake_worker(&self) {
        if let Some(w) = self.worker.lock().unwrap().as_ref() {
            w.wake();
        }
    }

    /// A client for the current backend URL and token. Built per call since both can change.
    fn api(&self) -> anyhow::Result<Api> {
        let s = self.settings.lock().unwrap();
        Api::new(&s.backend_url, s.device_token.clone())
    }

    fn account(&self) -> Option<Account> {
        self.settings.lock().unwrap().account.clone()
    }
}

#[derive(Serialize, Clone)]
struct LoginStarted {
    code: String,
    verify_url: String,
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
    encoders: Option<Encoders>,
    ffmpeg_error: Option<String>,
    account: Option<Account>,
    /// The game session being recorded, if one is.
    session: Option<session_watch::LiveSession>,
}

/// How far the OBS runtime bootstrap has got. `Ready` on every launch after the first.
#[derive(Serialize, Clone, Debug, Default)]
#[serde(tag = "phase", rename_all = "snake_case")]
enum Bootstrap {
    Downloading { progress: f32, message: String },
    Extracting { progress: f32, message: String },
    /// The runtime landed; the app has to restart before it can load the real `obs.dll`.
    Restarting,
    /// The default: the common launch has the runtime already, and the first-run screen only
    /// appears once the bootstrapper says it has work to do.
    #[default]
    Ready,
    Failed { message: String },
}

/// The percentage the running encode or upload of one clip has reached.
#[derive(Serialize, Clone, Copy, Debug)]
struct ClipProgress {
    id: i64,
    stage: &'static str,
    percent: u8,
}

#[derive(Serialize, Clone)]
struct ClipSaved {
    path: String,
}

#[derive(Serialize, Clone)]
struct ClipsChanged {
    id: Option<i64>,
}

fn emit_clips_changed(app: &AppHandle, id: Option<i64>) {
    let _ = app.emit("clips-changed", ClipsChanged { id });
}

/// Records how far a clip's encode or upload has got and tells the UI. Called from the worker
/// thread several times a second, so it does nothing when the whole percent has not moved.
fn set_progress(app: &AppHandle, id: i64, stage: &'static str, percent: u8) {
    let percent = percent.min(100);
    let state = app.state::<AppState>();
    {
        let mut live = state.progress.lock().unwrap();
        match live.get(&id) {
            Some(p) if p.stage == stage && p.percent == percent => return,
            _ => live.insert(id, ClipProgress { id, stage, percent }),
        };
    }
    let _ = app.emit("clip-progress", ClipProgress { id, stage, percent });
}

/// Forgets a clip's percentage once its job is over, so a finished badge never shows a stale
/// number if the clip is retried later.
fn clear_progress(app: &AppHandle, id: i64) {
    app.state::<AppState>().progress.lock().unwrap().remove(&id);
    let _ = app.emit("clip-progress", ClipProgress { id, stage: "idle", percent: 0 });
}

/// Lets the asset protocol read the clip folder, so the player can play the local H.264 file,
/// and its `Matches` folder, where the match files are. Re-run whenever the folder changes;
/// scopes only ever widen, which is fine for a folder the user chose themselves.
fn allow_clip_dir(app: &AppHandle, dir: &Path) {
    for dir in [dir.to_path_buf(), session_app::matches_dir(dir)] {
        if let Err(e) = app.asset_protocol_scope().allow_directory(&dir, false) {
            log::warn!("{} is not readable by the player: {e}", dir.display());
        }
    }
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
        encoders: settings.encoders.clone(),
        ffmpeg_error: state.ffmpeg_error.lock().unwrap().clone(),
        account: settings.account.clone(),
        session: state.live_session.lock().unwrap().clone(),
    }
}

#[tauri::command]
fn save_clip(app: AppHandle) -> Result<String, String> {
    save_clip_inner(&app).map(|p| p.display().to_string())
}

#[tauri::command]
fn get_settings(state: State<AppState>) -> Settings {
    // The device token never crosses into the webview. It is a long-lived bearer for the
    // backend, and the webview is the one part of this app that runs code the backend (or a
    // page it serves) can influence; the UI shows the login through `account` instead.
    // `save_settings_inner` puts the live token back on the way in, so a round trip through
    // the UI does not log the device out.
    Settings {
        device_token: None,
        ..state.settings.lock().unwrap().clone()
    }
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
// Account commands

/// Starts a Discord device login: asks the backend for a code, opens the browser and polls on
/// a background thread until the token arrives, the user cancels, or ten minutes pass.
#[tauri::command]
async fn start_login(app: AppHandle) -> Result<LoginStarted, String> {
    // The blocking HTTP client must not be created or dropped on a tokio worker thread.
    tauri::async_runtime::spawn_blocking(move || start_login_inner(&app))
        .await
        .map_err(|e| format!("login task failed: {e}"))?
        .map_err(|e| format!("{e:#}"))
}

#[tauri::command]
fn cancel_login(app: AppHandle) {
    let state = app.state::<AppState>();
    if let Some(session) = state.login.lock().unwrap().take() {
        session.cancelled.store(true, Ordering::SeqCst);
        log::info!("device login {} cancelled", session.code);
    }
    let _ = app.emit("login-changed", ());
}

/// Forgets the token and account. The backend is told on a best-effort basis.
#[tauri::command]
async fn logout(app: AppHandle) -> Result<(), String> {
    // Same rule as start_login: blocking reqwest only on a plain thread.
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<AppState>();
        match state.api() {
            Ok(api) => {
                if let Err(e) = api.delete_device() {
                    log::warn!("revoking device token: {e:#}");
                }
            }
            Err(e) => log::warn!("{e:#}"),
        }
        store_account(&app, None, None)
    })
    .await
    .map_err(|e| format!("logout task failed: {e}"))?
    .map_err(|e| format!("{e:#}"))
}

#[tauri::command]
fn get_account(state: State<AppState>) -> Option<Account> {
    state.account()
}

fn start_login_inner(app: &AppHandle) -> anyhow::Result<LoginStarted> {
    let state = app.state::<AppState>();
    // Any earlier attempt is superseded.
    if let Some(old) = state.login.lock().unwrap().take() {
        old.cancelled.store(true, Ordering::SeqCst);
    }
    let backend_url = state.settings.lock().unwrap().backend_url.clone();
    let api = state.api()?;
    let device_name = std::env::var("COMPUTERNAME").unwrap_or_else(|_| "Windows PC".into());
    let start = api
        .start_device_login(&device_name)
        .context("starting device login")?;
    // Before this ever reaches the shell. See `check_verify_url`.
    check_verify_url(&backend_url, &start.verify_url)?;
    log::info!("device login {} started, opening {}", start.code, start.verify_url);
    if let Err(e) = app.opener().open_url(&start.verify_url, None::<&str>) {
        log::warn!("opening browser: {e}");
    }

    let cancelled = Arc::new(AtomicBool::new(false));
    *state.login.lock().unwrap() = Some(LoginSession {
        code: start.code.clone(),
        poll_secret: start.poll_secret.clone(),
        cancelled: Arc::clone(&cancelled),
    });
    let poll_app = app.clone();
    let code = start.code.clone();
    let poll_secret = start.poll_secret;
    std::thread::spawn(move || poll_login(&poll_app, api, &code, &poll_secret, cancelled));
    let _ = app.emit("login-changed", ());
    Ok(LoginStarted {
        code: start.code,
        verify_url: start.verify_url,
    })
}

/// Scheme and authority of an absolute http(s) URL, lowercased, port kept. `None` for anything
/// that is not plainly `http://host...` or `https://host...`.
///
/// Deliberately strict rather than lenient: userinfo (`https://good.example@evil.example/`),
/// backslashes (which browsers and shells treat as separators) and whitespace all mean "not a
/// URL I am willing to reason about", because the caller uses the answer to decide whether to
/// hand the string to the Windows shell.
fn origin_of(url: &str) -> Option<(String, String)> {
    // A backslash is a path separator to the shell and a slash to a browser, so a URL
    // containing one means two different things to the two things that will see it.
    if url.chars().any(|c| c.is_whitespace() || c.is_control() || c == '\\') {
        return None;
    }
    let (scheme, rest) = url.split_once("://")?;
    let scheme = scheme.to_ascii_lowercase();
    if scheme != "http" && scheme != "https" {
        return None;
    }
    let authority = rest.split(['/', '?', '#']).next().unwrap_or("").to_ascii_lowercase();
    if authority.is_empty() || authority.contains('@') {
        return None;
    }
    Some((scheme, authority))
}

/// True for the two hosts a backend may legitimately be reached over plain http: a local one.
fn is_loopback_authority(authority: &str) -> bool {
    let host = authority.split(':').next().unwrap_or(authority);
    host == "localhost" || host == "127.0.0.1"
}

/// Refuses to open a browser URL that did not come from the configured backend.
///
/// `verify_url` arrives in the backend's answer to `POST /auth/device`, and `open_url` on
/// Windows ends up in `powershell Start-Process -FilePath <target>`, which happily launches a
/// local or UNC `.bat`, `.exe` or `.hta`. A backend that is compromised, impersonated or
/// simply reached over a hostile network would then get code execution on every client that
/// presses "Link Discord". So the URL has to be https (or http to a local backend, which is
/// how the dev backend is used) and has to point at the same host and port as the backend
/// the user configured.
fn check_verify_url(backend_url: &str, verify_url: &str) -> anyhow::Result<()> {
    let (backend_scheme, backend_host) = origin_of(backend_url)
        .with_context(|| format!("backend URL is not an http(s) URL: {backend_url}"))?;
    let (scheme, host) = origin_of(verify_url).ok_or_else(|| {
        anyhow::anyhow!("the backend answered with a verification URL that is not http(s)")
    })?;
    if host != backend_host {
        anyhow::bail!(
            "the backend answered with a verification URL for {host}, which is not the backend \
             ({backend_host}); refusing to open it"
        );
    }
    if scheme != "https" && !(backend_scheme == "http" && is_loopback_authority(&backend_host)) {
        anyhow::bail!("the verification URL must be https; refusing to open {scheme}://{host}");
    }
    Ok(())
}

/// Polls the device code until it is ready. Runs on its own thread.
fn poll_login(app: &AppHandle, api: Api, code: &str, poll_secret: &str, cancelled: Arc<AtomicBool>) {
    let deadline = Instant::now() + LOGIN_TIMEOUT;
    let outcome: Result<(String, Account), String> = loop {
        std::thread::sleep(LOGIN_POLL);
        if cancelled.load(Ordering::SeqCst) {
            return;
        }
        if Instant::now() > deadline {
            break Err("login timed out; try again".into());
        }
        match api.poll_device_login(code, poll_secret) {
            Ok(Some(DevicePoll::Pending)) => {}
            Ok(Some(DevicePoll::Ready { token, user })) => break Ok((token, user.into())),
            Ok(None) => break Err("login code expired; try again".into()),
            // The poll secret is not accepted. Retrying for ten minutes cannot fix that.
            Err(e) if api::status_of(&e) == Some(401) => {
                log::warn!("device login poll rejected: {e:#}");
                break Err("the backend rejected this login; try again".into());
            }
            Err(e) => {
                // Transient network trouble: keep polling until the deadline.
                log::warn!("polling device login: {e:#}");
            }
        }
    };
    if cancelled.load(Ordering::SeqCst) {
        return;
    }
    let state = app.state::<AppState>();
    {
        let mut login = state.login.lock().unwrap();
        if login.as_ref().is_some_and(|s| s.code == code) {
            *login = None;
        }
    }
    match outcome {
        Ok((token, account)) => {
            log::info!("logged in as {}", account.username);
            if let Err(e) = store_account(app, Some(token), Some(account)) {
                log::error!("saving login: {e:#}");
                let _ = app.emit("login-failed", format!("{e:#}"));
            }
        }
        Err(msg) => {
            log::warn!("device login failed: {msg}");
            let _ = app.emit("login-failed", msg);
        }
    }
    let _ = app.emit("login-changed", ());
}

/// Persists a token and account (or clears both), tells the UI and wakes the worker so
/// published clips that waited for a login get uploaded. A login also fetches the posts, which
/// may already exist from another device.
fn store_account(app: &AppHandle, token: Option<String>, account: Option<Account>) -> anyhow::Result<()> {
    let state = app.state::<AppState>();
    let logged_in = token.is_some();
    {
        let mut s = state.settings.lock().unwrap();
        s.device_token = token;
        s.account = account;
        s.save().context("saving settings")?;
    }
    let _ = app.emit("account-changed", state.account());
    let _ = app.emit("status-changed", ());
    state.wake_worker();
    if logged_in {
        schedule_posts_refresh(app, Duration::ZERO);
    }
    Ok(())
}

/// Checks a stored token against the backend at startup. A 401 clears it; anything else
/// (offline, backend down) keeps it and refreshes the account on success.
fn verify_token(app: &AppHandle) {
    let state = app.state::<AppState>();
    let api = match state.api() {
        Ok(a) => a,
        Err(e) => {
            log::warn!("{e:#}");
            return;
        }
    };
    match api.me() {
        Ok(me) => {
            let account: Account = me.user.into();
            let changed = state.account().as_ref() != Some(&account);
            if changed {
                let token = state.settings.lock().unwrap().device_token.clone();
                if let Err(e) = store_account(app, token, Some(account)) {
                    log::warn!("{e:#}");
                }
            }
            log::info!("device token verified");
        }
        Err(e) if api::status_of(&e) == Some(401) => {
            log::warn!("device token rejected, logging out: {e:#}");
            if let Err(e) = store_account(app, None, None) {
                log::warn!("{e:#}");
            }
        }
        Err(e) => log::warn!("could not verify device token: {e:#}"),
    }
}

// ---------------------------------------------------------------------------
// Clip list commands

fn queue_or_err(state: &AppState) -> Result<Arc<Queue>, String> {
    state
        .queue()
        .ok_or_else(|| "clip queue is not available".to_string())
}

#[tauri::command]
fn list_clips(state: State<AppState>) -> Result<Vec<ClipRow>, String> {
    queue_or_err(&state)?.list().map_err(|e| format!("{e:#}"))
}

/// Deletes a clip everywhere: the copy on the site first, then the row and every file we know
/// about here. Missing files are fine.
///
/// The site goes first on purpose. If it cannot be reached, nothing local is touched and the
/// error says so, because a clip deleted only here would leave a video on the site that the
/// app can no longer see, let alone remove. A clip the site has already forgotten (404) is not
/// an obstacle.
#[tauri::command]
async fn delete_clip(app: AppHandle, id: i64) -> Result<(), String> {
    on_blocking_thread(move || {
        let state = app.state::<AppState>();
        let queue = queue_or_err(&state)?;
        let row = queue.get(id).map_err(|e| format!("{e:#}"))?;

        if let Some(remote_id) = row.as_ref().and_then(|r| r.remote_id.as_deref()) {
            let api = state.api().map_err(|e| format!("{e:#}"))?;
            match api.delete_clip(remote_id) {
                Ok(()) => log::info!("clip {id}: removed {remote_id} from the site"),
                Err(e) if api::status_of(&e) == Some(404) => {
                    log::info!("clip {id}: the site no longer has {remote_id}");
                }
                Err(e) => {
                    return Err(format!(
                        "the copy on the site could not be deleted, so nothing was removed here: {e:#}"
                    ))
                }
            }
        }

        let row = queue.delete(id).map_err(|e| format!("{e:#}"))?;
        if let Some(row) = row {
            for p in storage::clip_files(&row) {
                match std::fs::remove_file(&p) {
                    Ok(()) => log::info!("deleted {p}"),
                    Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
                    Err(e) => log::warn!("could not delete {p}: {e}"),
                }
            }
        }
        emit_clips_changed(&app, Some(id));
        Ok(())
    })
    .await
}

#[tauri::command]
fn set_clip_game(app: AppHandle, id: i64, game: Option<String>) -> Result<(), String> {
    let state = app.state::<AppState>();
    let game = game.map(|g| g.trim().to_string()).filter(|g| !g.is_empty());
    queue_or_err(&state)?
        .set_game(id, game.as_deref())
        .map_err(|e| format!("{e:#}"))?;
    emit_clips_changed(&app, Some(id));
    Ok(())
}

/// Renames every clip of one game at once, which is also how two games are merged: rename the
/// misdetected one to the name the good one already has and the library folds them together.
/// `from` is `None` for the "Unknown game" pile, `to` is `None` to send clips back to it.
#[tauri::command]
fn rename_game(app: AppHandle, from: Option<String>, to: Option<String>) -> Result<usize, String> {
    let state = app.state::<AppState>();
    let to = to.map(|g| g.trim().to_string()).filter(|g| !g.is_empty());
    let changed = queue_or_err(&state)?
        .rename_game(from.as_deref(), to.as_deref())
        .map_err(|e| format!("{e:#}"))?;
    if changed > 0 {
        emit_clips_changed(&app, None);
    }
    Ok(changed)
}

#[tauri::command]
fn retry_clip(app: AppHandle, id: i64) -> Result<(), String> {
    let state = app.state::<AppState>();
    queue_or_err(&state)?
        .retry(id)
        .map_err(|e| format!("{e:#}"))?;
    clear_progress(&app, id);
    state.wake_worker();
    emit_clips_changed(&app, Some(id));
    Ok(())
}

/// The percentages of whatever the worker is busy with, so a UI that opened mid-job is not
/// left waiting for the next event.
#[tauri::command]
fn clip_progress(state: State<AppState>) -> Vec<ClipProgress> {
    state.progress.lock().unwrap().values().copied().collect()
}

/// How far the OBS runtime download has got. Polled once on load; updates arrive as events.
#[tauri::command]
fn get_bootstrap(state: State<AppState>) -> Bootstrap {
    state.bootstrap.lock().unwrap().clone()
}

/// Closes the first-run flow, whether the user linked Discord or skipped it.
#[tauri::command]
fn finish_first_run(app: AppHandle) -> Result<(), String> {
    let state = app.state::<AppState>();
    let mut settings = state.settings.lock().unwrap();
    if settings.first_run_done {
        return Ok(());
    }
    settings.first_run_done = true;
    settings.save().map_err(|e| format!("{e:#}"))?;
    drop(settings);
    let _ = app.emit("status-changed", ());
    Ok(())
}

/// Reveals the best file we have for the clip in Explorer: the AV1 output when encoded,
/// otherwise the source recording.
#[tauri::command]
fn open_clip_folder(app: AppHandle, id: i64) -> Result<(), String> {
    let state = app.state::<AppState>();
    let row = queue_or_err(&state)?
        .get(id)
        .map_err(|e| format!("{e:#}"))?
        .ok_or_else(|| format!("clip {id} not found"))?;
    let candidates = [
        row.av1_path.as_deref(),
        row.h264_path.as_deref(),
        Some(row.source_path.as_str()),
    ];
    let existing = candidates
        .into_iter()
        .flatten()
        .find(|p| Path::new(p).exists());
    // Fall back to the source path even if it is gone so at least the folder opens.
    let target = existing.unwrap_or(row.source_path.as_str());
    app.opener()
        .reveal_item_in_dir(target)
        .map_err(|e| format!("{e:#}"))
}

/// The thumbnail as a data URL, so the webview needs no asset protocol scope.
#[tauri::command]
fn get_thumbnail(state: State<AppState>, id: i64) -> Result<Option<String>, String> {
    let row = queue_or_err(&state)?
        .get(id)
        .map_err(|e| format!("{e:#}"))?;
    let Some(thumb) = row.and_then(|r| r.thumb_path) else {
        return Ok(None);
    };
    match std::fs::read(&thumb) {
        Ok(bytes) => Ok(Some(format!("data:image/jpeg;base64,{}", base64_encode(&bytes)))),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(format!("reading {thumb}: {e}")),
    }
}

// ---------------------------------------------------------------------------
// Editor commands

fn ffmpeg_or_err(state: &AppState) -> Result<Binaries, String> {
    state
        .ffmpeg
        .lock()
        .unwrap()
        .clone()
        .ok_or_else(|| "ffmpeg is not available".to_string())
}

/// What the editor loads for a clip: the match it was taken in when that is still here, its own
/// recording otherwise. Off the main thread: it runs ffmpeg to probe them.
#[tauri::command]
async fn edit_source(app: AppHandle, id: i64) -> Result<EditSource, String> {
    on_blocking_thread(move || {
        let state = app.state::<AppState>();
        let queue = queue_or_err(&state)?;
        let bins = ffmpeg_or_err(&state)?;
        let store = state.sessions.lock().unwrap().clone();
        edit::open(&bins, &queue, store.as_deref(), id).map_err(|e| format!("{e:#}"))
    })
    .await
}

/// Applies the editor's one range, measured in the file of `source` (`"match"` or `"clip"`).
/// See `edit::apply` for what that does to the clip. A published clip is woken up for the
/// worker, which re-encodes it and replaces it on the site under the same link.
#[tauri::command]
async fn apply_range(
    app: AppHandle,
    id: i64,
    source: SourceKind,
    start_ms: i64,
    end_ms: i64,
) -> Result<(), String> {
    let emit_app = app.clone();
    let applied = on_blocking_thread(move || {
        let state = app.state::<AppState>();
        let queue = queue_or_err(&state)?;
        let bins = ffmpeg_or_err(&state)?;
        let store = state.sessions.lock().unwrap().clone();
        let clip_dir = state.settings.lock().unwrap().clip_dir.clone();
        edit::apply(&bins, &queue, store.as_deref(), &clip_dir, id, source, start_ms, end_ms)
            .map_err(|e| format!("{e:#}"))
    })
    .await?;
    if applied != edit::Applied::Unchanged {
        let state = emit_app.state::<AppState>();
        clear_progress(&emit_app, id);
        state.wake_worker();
        emit_clips_changed(&emit_app, Some(id));
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// Publishing

/// A server the publish dialog offers.
#[derive(Serialize, Clone)]
struct PublishGuild {
    guild_id: String,
    name: Option<String>,
    icon_url: Option<String>,
}

/// Only Discord's own CDN reaches the webview as an image URL; the CSP would block anything
/// else anyway, and a URL that is not what it claims is better dropped here.
fn discord_icon(url: Option<String>) -> Option<String> {
    url.filter(|u| {
        u.starts_with("https://cdn.discordapp.com/")
            && !u.chars().any(|c| c.is_whitespace() || c.is_control() || c == '\\' || c == '"')
    })
}

/// True for `https://discord.com/channels/<digits>/<digits>/<digits>` and nothing else: it is
/// handed to the shell, which runs far more than web pages (see `check_verify_url`).
fn is_discord_message_url(url: &str) -> bool {
    let Some(rest) = url.strip_prefix("https://discord.com/channels/") else {
        return false;
    };
    let parts: Vec<&str> = rest.split('/').collect();
    origin_of(url).is_some()
        && parts.len() == 3
        && parts.iter().all(|p| !p.is_empty() && p.chars().all(|c| c.is_ascii_digit()))
}

/// Discord snowflakes, deduplicated, at most 25 of them, as the backend accepts.
fn checked_guild_ids(ids: Vec<String>) -> Result<Vec<String>, String> {
    let mut out: Vec<String> = Vec::new();
    for id in ids {
        let id = id.trim().to_string();
        if id.is_empty() || id.len() > 20 || !id.chars().all(|c| c.is_ascii_digit()) {
            return Err(format!("{id:?} is not a Discord server id"));
        }
        if !out.contains(&id) {
            out.push(id);
        }
    }
    if out.len() > 25 {
        return Err("a clip can be posted to at most 25 servers at once".into());
    }
    Ok(out)
}

fn logged_in_api(state: &AppState) -> Result<Api, String> {
    if !state.settings.lock().unwrap().logged_in() {
        return Err(NOT_LOGGED_IN.into());
    }
    state.api().map_err(|e| format!("{e:#}"))
}

/// The servers this account can publish to. `bot_unavailable` when the backend could not ask
/// the bot, which the dialog explains and offers to retry.
#[tauri::command]
async fn list_publish_guilds(app: AppHandle) -> Result<Vec<PublishGuild>, String> {
    on_blocking_thread(move || {
        let state = app.state::<AppState>();
        let api = logged_in_api(&state)?;
        match api.publish_guilds() {
            Ok(guilds) => Ok(guilds
                .into_iter()
                .map(|g| PublishGuild { guild_id: g.guild_id, name: g.name, icon_url: discord_icon(g.icon_url) })
                .collect()),
            Err(e) if api::status_of(&e) == Some(503) => {
                log::warn!("listing publish guilds: {e:#}");
                Err(BOT_UNAVAILABLE.into())
            }
            Err(e) => Err(format!("{e:#}")),
        }
    })
    .await
}

/// Publishes a local clip: records what the dialog chose and lets the worker encode and upload
/// it. The chosen servers are remembered as next time's default.
#[tauri::command]
async fn publish_clip(
    app: AppHandle,
    id: i64,
    title: Option<String>,
    game: Option<String>,
    guild_ids: Vec<String>,
) -> Result<(), String> {
    on_blocking_thread(move || {
        let state = app.state::<AppState>();
        if !state.settings.lock().unwrap().logged_in() {
            return Err(NOT_LOGGED_IN.into());
        }
        let guilds = checked_guild_ids(guild_ids)?;
        let tidy = |s: Option<String>| s.map(|s| s.trim().to_string()).filter(|s| !s.is_empty());
        let (title, game) = (tidy(title), tidy(game));
        queue_or_err(&state)?
            .publish(id, title.as_deref(), game.as_deref(), &guilds)
            .map_err(|e| format!("{e:#}"))?;
        {
            let mut s = state.settings.lock().unwrap();
            s.last_publish_guilds = guilds.clone();
            if let Err(e) = s.save() {
                log::warn!("remembering the publish servers: {e:#}");
            }
        }
        log::info!("clip {id}: published to {} server(s)", guilds.len());
        clear_progress(&app, id);
        state.wake_worker();
        emit_clips_changed(&app, Some(id));
        let _ = app.emit("status-changed", ());
        Ok(())
    })
    .await
}

/// Posts an already published clip in more servers. Returns the ids the backend queued.
#[tauri::command]
async fn add_clip_posts(app: AppHandle, id: i64, guild_ids: Vec<String>) -> Result<Vec<String>, String> {
    on_blocking_thread(move || {
        let state = app.state::<AppState>();
        let api = logged_in_api(&state)?;
        let guilds = checked_guild_ids(guild_ids)?;
        if guilds.is_empty() {
            return Err("pick at least one server".into());
        }
        let queue = queue_or_err(&state)?;
        let row = queue
            .get(id)
            .map_err(|e| format!("{e:#}"))?
            .ok_or_else(|| format!("clip {id} not found"))?;
        let remote = row.remote_id.ok_or_else(|| "this clip is not published".to_string())?;
        let queued = api.add_clip_posts(&remote, &guilds).map_err(|e| match api::status_of(&e) {
            Some(409) => "the site is still processing this clip; try again in a moment".to_string(),
            _ => format!("{e:#}"),
        })?;
        if let Err(e) = queue.add_publish_guilds(id, &queued.queued) {
            log::warn!("clip {id}: remembering the new servers: {e:#}");
        }
        log::info!("clip {id}: {} more post(s) queued", queued.queued.len());
        for after in POSTS_AFTER_UPLOAD {
            schedule_posts_refresh(&app, after);
        }
        Ok(queued.queued)
    })
    .await
}

/// Takes a clip off the site and out of Discord, and keeps it here as a local clip. Publishing
/// it again later makes a new clip with a new link. The site goes first: if it cannot be
/// reached the clip stays exactly as published as it was.
#[tauri::command]
async fn unpublish_clip(app: AppHandle, id: i64) -> Result<(), String> {
    on_blocking_thread(move || {
        let state = app.state::<AppState>();
        let queue = queue_or_err(&state)?;
        let held = queue.begin_unpublish(id).map_err(|e| format!("{e:#}"))?;
        if let Some(remote) = held.remote_id.as_deref() {
            match state.api().and_then(|api| api.delete_clip(remote)) {
                Ok(()) => log::info!("clip {id}: unpublished {remote}"),
                Err(e) if api::status_of(&e) == Some(404) => {
                    log::info!("clip {id}: the site no longer had {remote}");
                }
                Err(e) => {
                    if let Err(restore) = queue.restore_publish(id, held.publish) {
                        log::error!("clip {id}: could not put the publish flag back: {restore:#}");
                    }
                    return Err(format!("the site could not be reached, so the clip is still published: {e:#}"));
                }
            }
        }
        queue.finish_unpublish(id).map_err(|e| format!("{e:#}"))?;
        clear_progress(&app, id);
        emit_clips_changed(&app, Some(id));
        schedule_posts_refresh(&app, Duration::ZERO);
        Ok(())
    })
    .await
}

#[tauri::command]
async fn refresh_posts(app: AppHandle) -> Result<(), String> {
    on_blocking_thread(move || refresh_posts_now(&app).map_err(|e| format!("{e:#}"))).await
}

/// Opens one of a clip's Discord posts, by guild, from the cached link.
#[tauri::command]
fn open_clip_post(app: AppHandle, id: i64, guild_id: String) -> Result<(), String> {
    let state = app.state::<AppState>();
    let row = queue_or_err(&state)?
        .get(id)
        .map_err(|e| format!("{e:#}"))?
        .ok_or_else(|| format!("clip {id} not found"))?;
    let post = row
        .posts
        .iter()
        .find(|p| p.guild_id == guild_id)
        .ok_or_else(|| "that post is not there any more".to_string())?;
    if !is_discord_message_url(&post.message_url) {
        return Err(format!("{} is not a Discord message link; refusing to open it", post.message_url));
    }
    app.opener()
        .open_url(&post.message_url, None::<&str>)
        .map_err(|e| format!("{e:#}"))
}

/// Replaces the posts cache with `GET /me/posts`. Quietly does nothing while logged out or
/// before the queue opened.
fn refresh_posts_now(app: &AppHandle) -> anyhow::Result<()> {
    let state = app.state::<AppState>();
    let _one_at_a_time = state.posts_refresh.lock().unwrap_or_else(|e| e.into_inner());
    if !state.settings.lock().unwrap().logged_in() {
        return Ok(());
    }
    let Some(queue) = state.queue() else {
        return Ok(());
    };
    let posts = state.api()?.my_posts()?;
    let mut by_remote: HashMap<String, Vec<ClipPost>> = HashMap::new();
    for p in posts {
        by_remote.entry(p.clip_id).or_default().push(ClipPost {
            guild_id: p.guild_id,
            name: p.name,
            icon_url: discord_icon(p.icon_url),
            message_url: p.message_url,
            posted_at: p.posted_at,
        });
    }
    let changed = queue.replace_posts(&by_remote)?;
    if !changed.is_empty() {
        log::info!("posts cache changed for {} clip(s)", changed.len());
        emit_clips_changed(app, None);
    }
    Ok(())
}

/// Refreshes the posts cache after `after`, on a thread of its own: HTTP must stay off the
/// async runtime and the worker thread alike.
fn schedule_posts_refresh(app: &AppHandle, after: Duration) {
    let app = app.clone();
    let spawned = std::thread::Builder::new()
        .name("posts-refresh".into())
        .spawn(move || {
            std::thread::sleep(after);
            if let Err(e) = refresh_posts_now(&app) {
                log::warn!("refreshing Discord posts: {e:#}");
            }
        });
    if let Err(e) = spawned {
        log::warn!("could not start a posts refresh: {e}");
    }
}

#[tauri::command]
fn get_encoders(state: State<AppState>) -> Option<Encoders> {
    state.settings.lock().unwrap().encoders.clone()
}

/// Re-runs the (slow) encoder probe and stores the result in settings.
#[tauri::command]
async fn reprobe_encoders(app: AppHandle) -> Result<Encoders, String> {
    let state = app.state::<AppState>();
    let bins = state
        .ffmpeg
        .lock()
        .unwrap()
        .clone()
        .ok_or_else(|| "ffmpeg is not available".to_string())?;
    let encoders = ffmpeg::probe_encoders(&bins);
    log::info!("encoders probed: av1={} h264={}", encoders.av1, encoders.h264);
    {
        let mut s = state.settings.lock().unwrap();
        s.encoders = Some(encoders.clone());
        if let Err(e) = s.save() {
            log::warn!("saving probed encoders: {e:#}");
        }
    }
    let _ = app.emit("status-changed", ());
    Ok(encoders)
}

// ---------------------------------------------------------------------------
// Storage commands

/// What the clips cost on this PC. Stats every file, so it runs off the main thread.
#[tauri::command]
async fn storage_stats(app: AppHandle) -> Result<storage::StorageStats, String> {
    on_blocking_thread(move || {
        let state = app.state::<AppState>();
        let clip_dir = state.settings.lock().unwrap().clip_dir.clone();
        let rows = queue_or_err(&state)?.list().map_err(|e| format!("{e:#}"))?;
        let mut stats = storage::scan(&rows, &clip_dir);
        // The sessions database may not have opened yet (or ever, if APPDATA is unset); that is
        // not a reason to fail the whole tab, so it is just left at zero.
        if let Some(sessions) = state.sessions.lock().unwrap().clone() {
            stats.matches = storage::scan_matches(&sessions).map_err(|e| format!("{e:#}"))?;
        }
        Ok(stats)
    })
    .await
}

/// Runs one of the cleanups the Storage tab offers. The UI asks for a second click first.
#[tauri::command]
async fn clean_storage(
    app: AppHandle,
    target: storage::CleanTarget,
) -> Result<storage::CleanResult, String> {
    let emit_to = app.clone();
    let result = on_blocking_thread(move || {
        let state = app.state::<AppState>();
        let queue = queue_or_err(&state)?;
        storage::clean(&queue, target).map_err(|e| format!("{e:#}"))
    })
    .await?;
    emit_clips_changed(&emit_to, None);
    Ok(result)
}

/// Reveals the clip folder itself, for the leftover files the app will not delete on its own.
#[tauri::command]
fn open_clip_dir(app: AppHandle) -> Result<(), String> {
    let dir = app.state::<AppState>().settings.lock().unwrap().clip_dir.clone();
    app.opener()
        .open_path(dir.display().to_string(), None::<&str>)
        .map_err(|e| format!("{e:#}"))
}

/// Runs blocking work off the async runtime, flattening the join error into the same `String`
/// every command returns.
async fn on_blocking_thread<T, F>(f: F) -> Result<T, String>
where
    T: Send + 'static,
    F: FnOnce() -> Result<T, String> + Send + 'static,
{
    tauri::async_runtime::spawn_blocking(f)
        .await
        .map_err(|e| format!("task failed: {e}"))?
}

/// Standard base64 with padding. Small enough to not be worth a dependency.
fn base64_encode(bytes: &[u8]) -> String {
    const ALPHABET: &[u8; 64] =
        b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let b = [chunk[0], *chunk.get(1).unwrap_or(&0), *chunk.get(2).unwrap_or(&0)];
        let n = (u32::from(b[0]) << 16) | (u32::from(b[1]) << 8) | u32::from(b[2]);
        out.push(ALPHABET[(n >> 18) as usize & 63] as char);
        out.push(ALPHABET[(n >> 12) as usize & 63] as char);
        out.push(if chunk.len() > 1 { ALPHABET[(n >> 6) as usize & 63] as char } else { '=' });
        out.push(if chunk.len() > 2 { ALPHABET[n as usize & 63] as char } else { '=' });
    }
    out
}

// ---------------------------------------------------------------------------
// Encoding pipeline

fn file_size(path: &Path) -> anyhow::Result<i64> {
    let meta = std::fs::metadata(path).with_context(|| format!("stat {}", path.display()))?;
    Ok(meta.len() as i64)
}

/// The worker's job for one clip: thumbnail, AV1, then H.264. Runs on the worker thread.
fn process_clip(app: &AppHandle, row: &ClipRow) -> anyhow::Result<Outputs> {
    let state = app.state::<AppState>();
    let bins = state
        .ffmpeg
        .lock()
        .unwrap()
        .clone()
        .context("ffmpeg is not available")?;
    let (probed, quality, engine) = {
        let s = state.settings.lock().unwrap();
        (s.encoders.clone(), s.quality, s.encode_engine)
    };
    let probed = probed.context("encoders have not been probed yet")?;
    // The probe records what the graphics card can do; the engine setting decides whether we
    // use it. Software is the default because it is measurably better per megabyte - see
    // ffmpeg::av1_args - and clip encoding runs after the game has exited anyway.
    let encoders = ffmpeg::encoders_for(&probed, engine);

    // The outputs are always named after the recording, but what they are encoded *from* is
    // the recording only while it is still here. After the Storage tab (or the setting) has
    // dropped it, a re-encode - which only the editor asks for - reads the encoded copy
    // instead, and the cut is then baked in rather than kept as an instruction.
    let (source, original) = edit::edit_source_path(row).with_context(|| {
        format!("clip {}: the recording {} is gone and no encoded copy is left", row.id, row.source_path)
    })?;
    let source = Path::new(&source);
    let (av1, h264, thumb) = storage::output_paths(Path::new(&row.source_path));
    let cut = Cut {
        segments: row.cut.clone().unwrap_or_default(),
    };
    if !original && !cut.is_whole() {
        log::warn!(
            "clip {}: cutting the encoded copy {} because the recording is gone; the cut will be permanent",
            row.id,
            source.display()
        );
    }
    log::info!(
        "encoding clip {} ({}){}",
        row.id,
        source.display(),
        if cut.is_whole() { String::new() } else { format!(", {} kept part(s)", cut.segments.len()) }
    );

    // The source is probed rather than trusted from the row: an edited row's duration is the
    // cut length, and a source that is the encoded copy is not the file the row describes.
    let info = ffmpeg::probe(&bins, source).context("probing the source")?;
    let cut = Cut::normalize(&cut.segments, info.duration_ms).context("checking the cut")?;
    let kept_ms = cut.kept_ms(info.duration_ms);

    let t = Instant::now();
    let at_ms = cut.source_time_at(0.25, info.duration_ms);
    ffmpeg::thumbnail(&bins, source, &thumb, at_ms)
        .with_context(|| format!("thumbnail for {}", source.display()))?;
    log::info!("clip {}: thumbnail in {:.1?}", row.id, t.elapsed());

    // Both encodes read the same source, so the badge counts the AV1 pass as the first half of
    // the clip and the H.264 pass as the second.
    let on_av1 = |done: f32| set_progress(app, row.id, "encode", (done * 50.0) as u8);
    let on_h264 = |done: f32| set_progress(app, row.id, "encode", (50.0 + done * 50.0) as u8);

    let t = Instant::now();
    ffmpeg::encode_av1(
        &bins,
        &encoders.av1,
        quality,
        source,
        &av1,
        &cut,
        info.has_audio,
        Some(&ffmpeg::Progress {
            duration_ms: kept_ms,
            on: &on_av1,
        }),
    )
    .with_context(|| format!("AV1 encode with {}", encoders.av1))?;
    let size_av1 = file_size(&av1)?;
    log::info!(
        "clip {}: AV1 ({}) in {:.1?}, {} bytes",
        row.id,
        encoders.av1,
        t.elapsed(),
        size_av1
    );

    let t = Instant::now();
    ffmpeg::encode_h264(
        &bins,
        &encoders.h264,
        quality,
        source,
        &h264,
        &cut,
        info.has_audio,
        Some(&ffmpeg::Progress {
            duration_ms: kept_ms,
            on: &on_h264,
        }),
    )
    .with_context(|| format!("H.264 encode with {}", encoders.h264))?;
    let size_h264 = file_size(&h264)?;
    log::info!(
        "clip {}: H.264 ({}) in {:.1?}, {} bytes",
        row.id,
        encoders.h264,
        t.elapsed(),
        size_h264
    );

    // The length the row will show is what actually got written, not the arithmetic on the
    // cut: keyframe placement can move an edge by a frame.
    let duration_ms = match ffmpeg::probe(&bins, &av1) {
        Ok(out) if out.duration_ms > 0 => Some(out.duration_ms),
        Ok(_) => Some(kept_ms),
        Err(e) => {
            log::warn!("clip {}: could not probe the AV1 output: {e:#}", row.id);
            Some(kept_ms)
        }
    };

    if !original && !cut.is_whole() {
        // Baked into the copy the next edit would read from, so it must not apply again, and
        // that copy now starts where the cut did. Only rows queued by a build from before the
        // range editor get here: an edit now always gives a clip a recording of its own.
        if let Some(queue) = state.queue() {
            if let Err(e) = queue.bake_cut(row.id, cut.segments[0].start_ms) {
                log::warn!("clip {}: could not clear the baked cut: {e:#}", row.id);
            }
        }
    }

    Ok(Outputs {
        av1_path: av1.display().to_string(),
        h264_path: h264.display().to_string(),
        thumb_path: thumb.display().to_string(),
        size_av1,
        size_h264,
        duration_ms,
    })
}

/// The worker's upload job for one encoded clip: create the record, PUT the three files,
/// complete. Any failure is retried by the queue with backoff.
fn upload_clip(app: &AppHandle, row: &ClipRow) -> anyhow::Result<UploadResult> {
    let state = app.state::<AppState>();
    let api = state.api()?;
    let av1 = row.av1_path.as_deref().context("clip has no AV1 output")?;
    let h264 = row.h264_path.as_deref().context("clip has no H.264 output")?;
    let thumb = row.thumb_path.as_deref().context("clip has no thumbnail")?;

    let t = Instant::now();
    // The backend signs each upload URL for the size declared here, so these come from the
    // files themselves. The sizes the encode wrote to the queue are the same numbers in
    // every ordinary case, but a re-encode or a half-written file would make them a lie the
    // bucket rejects, and `stat` costs nothing next to the upload.
    let size_av1 = file_size(Path::new(av1))?;
    let size_h264 = file_size(Path::new(h264))?;
    let size_thumb = file_size(Path::new(thumb))?;

    // 503 is the backend missing its storage config, which someone may well fix while the
    // clip waits, so it retries. 413 is this clip being too big or this account being out of
    // quota: the same bytes will be refused every time, so it is marked `Refused` and the
    // queue parks it for a manual retry rather than spending five backoffs on a certainty.
    let explain = |e: anyhow::Error| match api::status_of(&e) {
        Some(503) => e.context("the backend has no storage configured yet"),
        Some(413) => {
            e.context(Refused("the backend refused this clip: too large, or your storage quota is full"))
        }
        _ => e,
    };
    let create = || {
        api.create_clip(&NewClipUpload {
            game: row.game.clone(),
            // What the publish dialog named it, or the window title a clip from before the
            // dialog carried.
            title: row.publish_title.clone().or_else(|| row.title.clone()),
            duration_ms: row.duration_ms,
            width: row.width,
            height: row.height,
            recorded_at: row.recorded_at.clone(),
            size_av1,
            size_h264,
            size_thumb,
            participant_discord_ids: row.participants.clone(),
            // A clip published before the dialog existed and since forgotten by the site comes
            // back as a web page only, rather than being posted to every server a second time.
            guild_ids: row.publish_guilds.clone().unwrap_or_default(),
        })
        .map_err(explain)
        .context("creating clip record")
    };
    // A clip the site already has is replaced under its own id, so the page URL and the
    // Discord post keep working. If the site has since forgotten it (deleted from another
    // device, say), it becomes a new clip rather than an error the queue retries forever.
    // Only the backend's own `not_found` counts: a backend too old to have the route
    // answers 404 as well, and turning that into a fresh upload would post the clip to
    // Discord a second time.
    let (created, replaced) = match row.remote_id.as_deref() {
        Some(remote) => match api.replace_clip(
            remote,
            &ReplaceClipUpload {
                duration_ms: row.duration_ms,
                size_av1,
                size_h264,
                size_thumb,
            },
        ) {
            Ok(c) => (c, true),
            Err(e) if api::http_error(&e).is_some_and(|h| h.status == 404 && h.error == "not_found") => {
                log::warn!("clip {}: the site no longer has {remote}, uploading as a new clip", row.id);
                (create()?, false)
            }
            Err(e) => return Err(explain(e).context("replacing clip on the site")),
        },
        None => (create()?, false),
    };
    log::info!(
        "clip {}: remote id {}{}",
        row.id,
        created.id,
        if replaced { " (replacing)" } else { "" }
    );

    // The three files go up back to back, so the percentage counts bytes against their sum
    // rather than restarting at zero for each one.
    let total = (size_av1 + size_h264 + size_thumb).max(1) as u64;
    let mut uploaded: u64 = 0;
    for (url, path, content_type, size) in [
        (&created.uploads.av1, av1, "video/mp4", size_av1),
        (&created.uploads.h264, h264, "video/mp4", size_h264),
        (&created.uploads.thumb, thumb, "image/jpeg", size_thumb),
    ] {
        let progress_app = app.clone();
        let id = row.id;
        let before = uploaded;
        let on_bytes: api::OnBytes = Arc::new(move |sent| {
            set_progress(&progress_app, id, "upload", ((before + sent) * 100 / total) as u8);
        });
        api.put_file(url, Path::new(path), content_type, Some(on_bytes))
            .with_context(|| format!("uploading {path}"))?;
        uploaded += size as u64;
    }

    let done = api
        .complete_clip(&created.id)
        .context("completing upload")?;
    log::info!(
        "clip {}: uploaded in {:.1?}, {}",
        row.id,
        t.elapsed(),
        done.urls.page
    );
    let (notify, language) = {
        let s = state.settings.lock().unwrap();
        (s.notify_on_save, s.language)
    };
    if notify {
        let title = if replaced {
            i18n::clip_updated(language)
        } else {
            i18n::clip_uploaded(language)
        };
        show_toast(app, title, &done.urls.page);
    }
    Ok(UploadResult {
        remote_id: done.id,
        page_url: done.urls.page,
    })
}

/// True when the worker may upload: logged in. Which clips go up is the queue's business, and
/// it only ever offers the ones the user published.
fn upload_allowed(app: &AppHandle) -> bool {
    app.state::<AppState>().settings.lock().unwrap().logged_in()
}

/// True when the worker may encode: the user opted in, or nothing game-like is running.
fn encode_allowed(app: &AppHandle) -> bool {
    let state = app.state::<AppState>();
    if state.settings.lock().unwrap().encode_while_gaming {
        return true;
    }
    if state.hooked_game.lock().unwrap().is_some() {
        return false;
    }
    games::detect_foreground().is_none()
}

/// The queue's status-change callback: refresh the UI, then apply the two storage settings to
/// the clip that just moved. Runs on the worker thread, between jobs, so the file deletions
/// never race an encode. Both settings are off by default, and then this is one lock and a
/// return.
fn on_clip_changed(app: &AppHandle, id: i64) {
    let state = app.state::<AppState>();
    let status = state.queue().and_then(|q| q.get(id).ok()).flatten().map(|r| r.status);
    // A status change means the job that owned the percentage is over, one way or another.
    // The next one sets its own before the first event arrives.
    if !matches!(status, Some(ClipStatus::Encoding) | Some(ClipStatus::Uploading)) {
        clear_progress(app, id);
    }
    emit_clips_changed(app, Some(id));
    // The upload is complete, and the bot now posts it on its own time.
    if status == Some(ClipStatus::Done) {
        for after in POSTS_AFTER_UPLOAD {
            schedule_posts_refresh(app, after);
        }
    }
    let (drop_sources, limit_gb, clip_dir) = {
        let s = state.settings.lock().unwrap();
        (
            s.delete_source_after_encode,
            s.storage_limit_gb,
            s.clip_dir.clone(),
        )
    };
    if !drop_sources && limit_gb == 0 {
        return;
    }
    let Some(queue) = state.queue() else { return };
    // Only the two resting states matter. Everything else is a clip mid-flight, whose files
    // are still being written.
    let row = match queue.get(id) {
        Ok(Some(row)) if matches!(row.status, ClipStatus::Encoded | ClipStatus::Done) => row,
        Ok(_) => return,
        Err(e) => {
            log::warn!("storage upkeep could not read clip {id}: {e:#}");
            return;
        }
    };

    let mut changed = false;
    if drop_sources && row.status == ClipStatus::Encoded && storage::drop_source(&row) > 0 {
        changed = true;
    }
    if limit_gb > 0 {
        match storage::enforce_limit(&queue, &clip_dir, i64::from(limit_gb) * storage::GB) {
            Ok(freed) => changed |= freed.clips > 0,
            Err(e) => log::warn!("storage limit could not be applied: {e:#}"),
        }
    }
    if changed {
        emit_clips_changed(app, None);
    }
}

/// Locates ffmpeg, probes encoders if needed, opens the queue and starts the worker.
/// Blocking (the probe takes seconds); runs on a background thread at startup.
fn start_pipeline(app: &AppHandle) {
    let state = app.state::<AppState>();

    let bins = match ffmpeg::locate() {
        Ok(b) => b,
        Err(e) => {
            let msg = format!("{e:#}");
            log::error!("ffmpeg not available: {msg}");
            *state.ffmpeg_error.lock().unwrap() = Some(msg);
            let _ = app.emit("status-changed", ());
            return;
        }
    };
    log::info!("ffmpeg: {}", bins.ffmpeg.display());
    *state.ffmpeg.lock().unwrap() = Some(bins.clone());

    let needs_probe = state.settings.lock().unwrap().encoders.is_none();
    if needs_probe {
        let t = Instant::now();
        let encoders = ffmpeg::probe_encoders(&bins);
        log::info!(
            "encoders probed in {:.1?}: av1={} h264={}",
            t.elapsed(),
            encoders.av1,
            encoders.h264
        );
        let mut s = state.settings.lock().unwrap();
        s.encoders = Some(encoders);
        if let Err(e) = s.save() {
            log::warn!("saving probed encoders: {e:#}");
        }
    }
    let _ = app.emit("status-changed", ());

    let db = match settings::data_dir() {
        Some(d) => d.join("clips.db"),
        None => {
            log::error!("APPDATA is not set; clip queue disabled");
            return;
        }
    };
    if let Some(parent) = db.parent() {
        if let Err(e) = std::fs::create_dir_all(parent) {
            log::error!("creating {}: {e}", parent.display());
        }
    }
    let queue = match Queue::open(&db) {
        Ok(q) => Arc::new(q),
        Err(e) => {
            log::error!("opening clip queue {}: {e:#}", db.display());
            return;
        }
    };

    let proc_app = app.clone();
    let processor: Processor = Arc::new(move |row| process_clip(&proc_app, row));
    let gate_app = app.clone();
    let gate: Gate = Arc::new(move || encode_allowed(&gate_app));
    let change_app = app.clone();
    let on_change: OnChange = Arc::new(move |id| on_clip_changed(&change_app, id));
    let upload_app = app.clone();
    let uploader: Uploader = Arc::new(move |row| upload_clip(&upload_app, row));
    let upload_gate_app = app.clone();
    let upload_gate: Gate = Arc::new(move || upload_allowed(&upload_gate_app));

    let worker = queue::start_worker(
        queue.clone(),
        processor,
        gate,
        on_change,
        Some(uploader),
        upload_gate,
    );
    *state.queue.lock().unwrap() = Some(queue);
    *state.worker.lock().unwrap() = Some(worker);
    log::info!("clip queue ready at {}", db.display());
    emit_clips_changed(app, None);
    // The posts cache: now, then every few minutes for as long as the app runs. Both check the
    // login themselves, so a login later on is picked up by the next round.
    schedule_posts_refresh(app, Duration::ZERO);
    let periodic = app.clone();
    let spawned = std::thread::Builder::new().name("posts-periodic".into()).spawn(move || loop {
        std::thread::sleep(POSTS_EVERY);
        if let Err(e) = refresh_posts_now(&periodic) {
            log::warn!("refreshing Discord posts: {e:#}");
        }
    });
    if let Err(e) = spawned {
        log::warn!("could not start the periodic posts refresh: {e}");
    }
    // Sessions that ended while ffmpeg was not yet located can be cut now.
    session_app::process_pending(app);
}

/// Probes the freshly written file and adds it to the library as a local clip. libobs may
/// still be flushing the MP4 when the replay buffer returns, so the probe is retried for about
/// three seconds. `saved_at` is the moment just before the buffer was flushed: the file ends
/// there, so it starts its own length earlier, and that is what places the clip on a match.
fn enqueue_saved_clip(
    app: &AppHandle,
    path: PathBuf,
    detected: Option<DetectedGame>,
    saved_at: chrono::DateTime<chrono::Utc>,
) {
    let state = app.state::<AppState>();
    let Some(queue) = state.queue() else {
        log::warn!("clip queue unavailable; {} is not in the library", path.display());
        return;
    };
    let bins = state.ffmpeg.lock().unwrap().clone();
    let Some(bins) = bins else {
        log::warn!("ffmpeg unavailable; {} is not in the library", path.display());
        return;
    };

    let mut info = None;
    let mut last_err = None;
    for attempt in 0..6 {
        if attempt > 0 {
            std::thread::sleep(Duration::from_millis(500));
        }
        match ffmpeg::probe(&bins, &path) {
            Ok(i) if i.duration_ms > 0 => {
                info = Some(i);
                break;
            }
            Ok(i) => last_err = Some(format!("probe reported duration {} ms", i.duration_ms)),
            Err(e) => last_err = Some(format!("{e:#}")),
        }
    }
    let Some(info) = info else {
        log::error!(
            "could not probe {}: {}",
            path.display(),
            last_err.unwrap_or_default()
        );
        return;
    };

    let clip = NewClip {
        source_path: path.display().to_string(),
        game: detected.as_ref().map(|d| d.game.clone()),
        title: detected.as_ref().map(|d| d.title.clone()),
        recorded_at: chrono::Local::now().to_rfc3339(),
        duration_ms: info.duration_ms,
        width: info.width,
        height: info.height,
        fps: info.fps,
        size_source: info.size as i64,
        // Filled in by `snapshot_voice_participants` below, once the row has an id.
        participants: None,
        captured_at: Some(sessions::format_time(
            saved_at - chrono::Duration::milliseconds(info.duration_ms),
        )),
    };
    match queue.enqueue(clip) {
        Ok(id) => {
            log::info!(
                "saved clip {id}: {} ({} ms, {}x{})",
                path.display(),
                info.duration_ms,
                info.width,
                info.height
            );
            emit_clips_changed(app, Some(id));
            snapshot_voice_participants(app, &queue, id);
            // A local clip is never encoded until it is published, and the encoder is what
            // used to make the thumbnail, so the card gets one here.
            match edit::refresh_thumbnail(&bins, &queue, id) {
                Ok(()) => emit_clips_changed(app, Some(id)),
                Err(e) => log::warn!("clip {id}: thumbnail failed: {e:#}"),
            }
        }
        Err(e) => log::error!("enqueue {} failed: {e:#}", path.display()),
    }
}

/// Asks the backend who is in the owner's Discord voice channel and records the answer on the
/// clip, so the bot can mention them when the clip is eventually posted.
///
/// It has to be asked *now*, not at upload time: encoding and uploading can take minutes, and
/// by then the channel may have emptied or filled with other people. It runs on its own thread
/// because it is a blocking HTTP call and nothing about the clip depends on the answer — the
/// row is already enqueued and the UI already knows about it, and a backend that is slow, old
/// or unreachable must cost the clip nothing. Best effort throughout: every failure leaves
/// `participants` null, which reads the same as nobody having been in voice.
fn snapshot_voice_participants(app: &AppHandle, queue: &Arc<Queue>, id: i64) {
    let app = app.clone();
    let queue = Arc::clone(queue);
    let spawned = std::thread::Builder::new()
        .name("voice-snapshot".into())
        .spawn(move || {
            let api = match app.state::<AppState>().api() {
                Ok(api) => api,
                Err(e) => {
                    log::warn!("voice snapshot for clip {id} skipped: {e:#}");
                    return;
                }
            };
            match api.voice_snapshot() {
                Ok(snapshot) => {
                    log::info!(
                        "clip {id}: {} in voice at capture time",
                        snapshot.participants.len()
                    );
                    if let Err(e) = queue.set_participants(id, &snapshot.participants) {
                        log::warn!("could not store voice snapshot for clip {id}: {e:#}");
                    }
                }
                Err(e) => log::warn!("voice snapshot for clip {id} failed: {e:#}"),
            }
        });
    if let Err(e) = spawned {
        log::warn!("could not start the voice snapshot thread for clip {id}: {e}");
    }
}

// ---------------------------------------------------------------------------
// Saving

/// The game libobs currently has hooked, shaped like a foreground detection so the two are
/// interchangeable at save time. Used only when the foreground window is not itself a game.
fn hooked_game_as_detected(state: &State<AppState>) -> Option<games::DetectedGame> {
    let hooked = state.hooked_game.lock().unwrap().clone()?;
    let game = games::name_for(&hooked.executable, &hooked.title)?;
    let confident = games::is_known(&hooked.executable);
    Some(games::DetectedGame {
        game,
        executable: hooked.executable,
        title: hooked.title,
        confident,
    })
}

fn save_clip_inner(app: &AppHandle) -> Result<PathBuf, String> {
    let state = app.state::<AppState>();
    let (notify, sound, language) = {
        let s = state.settings.lock().unwrap();
        (s.notify_on_save, s.sound_on_save, s.language)
    };
    let (result, saved_at) = {
        let recorder = state.recorder.lock().unwrap();
        // Taken right before the flush, not after the probe: the file ends here.
        let saved_at = chrono::Utc::now();
        let result = match recorder.as_ref() {
            Some(r) => r.save().map_err(|e| format!("{e:#}")),
            None => Err("recorder is not running".to_string()),
        };
        (result, saved_at)
    };
    match &result {
        Ok(path) => {
            log::info!("clip saved: {}", path.display());
            // The game is still focused right now; look before the toast steals attention.
            // Falling back to the hooked game matters more than it looks: the hotkey is
            // global, so a clip can be saved while the game is running but not focused
            // (alt-tabbed, a second monitor, an overlay), and the foreground window alone
            // would then label real gameplay as nothing at all.
            let detected = games::detect_foreground().or_else(|| hooked_game_as_detected(&state));
            match &detected {
                Some(d) => log::info!("game for this clip: {} ({})", d.game, d.executable),
                None => log::info!("no game detected for this clip"),
            }
            let queue_app = app.clone();
            let queue_path = path.clone();
            std::thread::spawn(move || enqueue_saved_clip(&queue_app, queue_path, detected, saved_at));
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
                show_toast(app, i18n::clip_saved(language), &name);
            }
            if sound {
                play_save_sound();
            }
        }
        Err(e) => {
            log::error!("clip save failed: {e}");
            if notify {
                show_toast(app, i18n::clip_not_saved(language), e);
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
// OBS runtime bootstrap

/// Feeds the bootstrapper's progress to the first-run screen. Throttled to whole percents:
/// the download reports far more often than a progress bar can use.
#[derive(Debug)]
struct BootstrapReporter {
    app: AppHandle,
    last_download: f32,
    last_extract: f32,
}

impl ObsBootstrapStatusHandler for BootstrapReporter {
    type Error = std::convert::Infallible;

    fn handle_downloading(&mut self, progress: f32, message: String) -> Result<(), Self::Error> {
        if progress - self.last_download >= 0.01 || progress >= 1.0 {
            self.last_download = progress;
            set_bootstrap(&self.app, Bootstrap::Downloading { progress, message });
        }
        Ok(())
    }

    fn handle_extraction(&mut self, progress: f32, message: String) -> Result<(), Self::Error> {
        if progress - self.last_extract >= 0.01 || progress >= 1.0 {
            self.last_extract = progress;
            set_bootstrap(&self.app, Bootstrap::Extracting { progress, message });
        }
        Ok(())
    }
}

fn set_bootstrap(app: &AppHandle, next: Bootstrap) {
    *app.state::<AppState>().bootstrap.lock().unwrap() = next.clone();
    let _ = app.emit("obs-bootstrap", next);
}

/// Installs the OBS runtime if this machine does not have it, then starts the recorder.
///
/// This runs inside the app rather than before it so the first-run screen can show the
/// download; on every later launch the bootstrapper finds a valid installation and returns at
/// once. The exe links `obs.dll` at load time and starts against the dummy the installer
/// ships, so a fresh runtime can only take effect after a restart: the bootstrapper leaves an
/// updater behind that waits for this process to exit, swaps the dll and launches us again.
async fn bootstrap_and_start_recorder(app: AppHandle) {
    let options = libobs_bootstrapper::ObsBootstrapperOptions::default();
    let reporter = Box::new(BootstrapReporter {
        app: app.clone(),
        last_download: 0.0,
        last_extract: 0.0,
    });
    match libobs_bootstrapper::ObsBootstrapper::bootstrap_with_handler(&options, reporter).await {
        Ok(libobs_bootstrapper::ObsBootstrapperResult::Restart) => {
            log::info!("OBS runtime installed, restarting");
            set_bootstrap(&app, Bootstrap::Restarting);
            // Give the screen a moment to say so before the process disappears.
            tokio::time::sleep(Duration::from_millis(800)).await;
            app.exit(0);
        }
        Ok(libobs_bootstrapper::ObsBootstrapperResult::None) => {
            set_bootstrap(&app, Bootstrap::Ready);
            // libobs startup is blocking and slow; keep it off the async runtime.
            std::thread::spawn(move || start_recorder(&app));
        }
        Err(e) => {
            let message = format!("{e}");
            log::error!("OBS bootstrap failed: {message}");
            *app.state::<AppState>().last_error.lock().unwrap() =
                Some(format!("the recording engine could not be installed: {message}"));
            set_bootstrap(&app, Bootstrap::Failed { message });
            let _ = app.emit("status-changed", ());
        }
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
    let language = app.state::<AppState>().settings.lock().unwrap().language;
    let text = match game {
        Some(g) => i18n::tray_recording(language, &g.title),
        None => i18n::tray_idle(language),
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
    // Checked here rather than in `validate` because it touches the disk: a settings file
    // whose folder has since been unplugged still has to load at startup, it just cannot be
    // saved again until the folder is back. The folder picker always returns one that exists.
    settings::validate_clip_dir(&new.clip_dir)?;
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

    // The UI never edits the login; keep whatever the account flow stored meanwhile.
    {
        let live = state.settings.lock().unwrap();
        new.device_token = live.device_token.clone();
        new.account = live.account.clone();
    }
    // The UI never edits these either; they belong to the shell and the publish dialog, and a
    // Settings screen opened before the last publish would otherwise put an old choice back.
    new.first_run_done = old.first_run_done;
    new.tray_hint_shown = old.tray_hint_shown;
    new.last_publish_guilds = old.last_publish_guilds.clone();

    // Persist before touching the recorder so a libobs failure does not lose the change.
    new.save().context("saving settings")?;
    *state.settings.lock().unwrap() = new.clone();
    if new.clip_dir != old.clip_dir {
        allow_clip_dir(app, &new.clip_dir);
    }
    if new.language != old.language {
        relabel_tray(app, new.language);
    }

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

/// The first time the window is closed, say where the app went. Closing hides to the tray and
/// keeps recording, which is a surprise exactly once.
fn explain_tray_once(app: &AppHandle) {
    let state = app.state::<AppState>();
    let language = {
        let mut settings = state.settings.lock().unwrap();
        if settings.tray_hint_shown {
            return;
        }
        settings.tray_hint_shown = true;
        if let Err(e) = settings.save() {
            log::warn!("saving the tray hint flag: {e:#}");
        }
        settings.language
    };
    show_toast(
        app,
        i18n::tray_hint_title(language),
        i18n::tray_hint_body(language),
    );
}

fn tray_menu(app: &AppHandle, language: Language) -> tauri::Result<Menu<tauri::Wry>> {
    let clip = MenuItem::with_id(app, "clip", i18n::tray_save_clip(language), true, None::<&str>)?;
    let show = MenuItem::with_id(app, "show", i18n::tray_open(language), true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", i18n::tray_quit(language), true, None::<&str>)?;
    Menu::with_items(app, &[&clip, &show, &quit])
}

/// The tray menu is built once at startup, so a language change has to relabel it or the menu
/// stays in the old language until the app restarts.
fn relabel_tray(app: &AppHandle, language: Language) {
    let Some(tray) = app.tray_by_id("main") else {
        return;
    };
    match tray_menu(app, language) {
        Ok(menu) => {
            if let Err(e) = tray.set_menu(Some(menu)) {
                log::warn!("tray menu relabel failed: {e}");
            }
        }
        Err(e) => log::warn!("rebuilding the tray menu: {e}"),
    }
    let game = app.state::<AppState>().hooked_game.lock().unwrap().clone();
    update_tray_tooltip(app, game.as_ref());
}

fn build_tray(app: &AppHandle) -> tauri::Result<()> {
    let language = app.state::<AppState>().settings.lock().unwrap().language;
    let menu = tray_menu(app, language)?;

    let mut tray = TrayIconBuilder::with_id("main")
        .menu(&menu)
        .tooltip(i18n::tray_idle(language))
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
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .manage(AppState {
            settings: Mutex::new(settings),
            recorder: Mutex::new(None),
            last_error: Mutex::new(None),
            hotkey_error: Mutex::new(None),
            hooked_game: Mutex::new(None),
            generation: AtomicU64::new(0),
            ffmpeg: Mutex::new(None),
            ffmpeg_error: Mutex::new(None),
            queue: Mutex::new(None),
            worker: Mutex::new(None),
            login: Mutex::new(None),
            bootstrap: Mutex::new(Bootstrap::default()),
            progress: Mutex::new(std::collections::HashMap::new()),
            sessions: Mutex::new(None),
            live_session: Mutex::new(None),
            processing: Mutex::new(session_app::Processing::new()),
            posts_refresh: Mutex::new(()),
        })
        .invoke_handler(tauri::generate_handler![
            get_status,
            save_clip,
            get_settings,
            save_settings,
            pick_clip_dir,
            retry_recorder,
            list_clips,
            delete_clip,
            set_clip_game,
            rename_game,
            retry_clip,
            clip_progress,
            open_clip_folder,
            get_thumbnail,
            storage_stats,
            clean_storage,
            open_clip_dir,
            get_encoders,
            reprobe_encoders,
            edit_source,
            apply_range,
            list_publish_guilds,
            publish_clip,
            add_clip_posts,
            unpublish_clip,
            refresh_posts,
            open_clip_post,
            start_login,
            cancel_login,
            logout,
            get_account,
            get_bootstrap,
            finish_first_run,
            session_app::list_sessions,
            session_app::match_events,
            session_app::live_session,
            session_app::delete_session,
            session_app::delete_match,
            session_app::retry_session,
            session_app::clip_from_match,
            session_app::open_match_folder,
            session_app::match_thumbnail,
            session_app::clips_for_match,
            session_app::match_for_clip,
            session_app::clip_match_index
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
            allow_clip_dir(&handle, &settings.clip_dir);
            // Install the OBS runtime if it is missing, then start the recorder. Both take a
            // moment, so the window is already up and showing progress by then.
            let recorder_handle = handle.clone();
            tauri::async_runtime::spawn(bootstrap_and_start_recorder(recorder_handle));
            // A stored device token is checked against the backend off the main thread.
            if settings.logged_in() {
                let verify_handle = handle.clone();
                std::thread::spawn(move || verify_token(&verify_handle));
            }
            // The session database and the watch that records whole game sessions. It asks
            // the recorder for a recording and simply retries until one is running.
            let sessions_handle = handle.clone();
            std::thread::spawn(move || session_app::start(&sessions_handle));
            // ffmpeg lookup, encoder probe and queue open. Independent of libobs, so it
            // runs on its own thread rather than waiting for the recorder.
            std::thread::spawn(move || start_pipeline(&handle));
            Ok(())
        })
        .on_window_event(|window, event| {
            // Closing the window hides it; the app lives in the tray.
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                let _ = window.hide();
                api.prevent_close();
                explain_tray_once(window.app_handle());
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_verification_url_must_belong_to_the_backend() {
        let prod = "https://cosnostra.benja.ar";
        check_verify_url(prod, "https://cosnostra.benja.ar/link?code=ABCD").unwrap();
        // Case and path shape do not matter; host and scheme do.
        check_verify_url(prod, "https://CosNostra.Benja.AR/link").unwrap();
        check_verify_url(prod, "https://cosnostra.benja.ar").unwrap();

        // A different host, however it is dressed up.
        assert!(check_verify_url(prod, "https://evil.example/link").is_err());
        assert!(check_verify_url(prod, "https://cosnostra.benja.ar.evil.example/").is_err());
        assert!(check_verify_url(prod, "https://cosnostra.benja.ar@evil.example/").is_err());
        // Right host, wrong port is still a different origin.
        assert!(check_verify_url(prod, "https://cosnostra.benja.ar:8443/link").is_err());
        // A downgrade to plain http against a public backend.
        assert!(check_verify_url(prod, "http://cosnostra.benja.ar/link").is_err());

        // The shapes that made this check necessary: the Windows opener shells out to
        // `Start-Process -FilePath`, which runs local and UNC paths.
        for bad in [
            r"C:\Windows\System32\calc.exe",
            r"\\evil.example\share\payload.bat",
            "file:///C:/Users/Public/payload.hta",
            "ms-msdt:/id PCWDiagnostic",
            "javascript:alert(1)",
            r"https://cosnostra.benja.ar\@evil.example/",
            " https://cosnostra.benja.ar/link",
            "https://cosnostra.benja.ar/link\r\nX: y",
            "",
        ] {
            assert!(check_verify_url(prod, bad).is_err(), "should be refused: {bad:?}");
        }
    }

    #[test]
    fn a_local_backend_may_answer_over_http() {
        check_verify_url("http://localhost:3000", "http://localhost:3000/link?code=A").unwrap();
        check_verify_url("http://127.0.0.1:3000", "http://127.0.0.1:3000/link").unwrap();
        // Still the same host: a local backend cannot send the browser somewhere else.
        assert!(check_verify_url("http://localhost:3000", "http://localhost:9/x").is_err());
        assert!(check_verify_url("http://localhost:3000", "http://evil.example/x").is_err());
        // And "localhost" in the verification URL does not excuse a remote backend.
        assert!(check_verify_url("https://cosnostra.benja.ar", "http://localhost/x").is_err());
    }

    /// A post link comes from the backend and is handed to the shell, so only the one shape a
    /// Discord message link has gets through.
    #[test]
    fn only_discord_message_links_are_opened() {
        assert!(is_discord_message_url("https://discord.com/channels/111/222/333"));
        for bad in [
            "https://discord.com/channels/111/222",
            "https://discord.com/channels/111/222/333/444",
            "https://discord.com/channels/111/222/abc",
            "https://discord.com/channels/111/222/333?x=1",
            "https://discord.com.evil.example/channels/1/2/3",
            "https://evil.example/https://discord.com/channels/1/2/3",
            "http://discord.com/channels/1/2/3",
            r"https://discord.com/channels/1/2/3\..\..\calc.exe",
            "https://discord.com/channels/1/2/3 ",
            "",
        ] {
            assert!(!is_discord_message_url(bad), "should be refused: {bad:?}");
        }
        assert_eq!(
            discord_icon(Some("https://cdn.discordapp.com/icons/1/a.png?size=96".into())).as_deref(),
            Some("https://cdn.discordapp.com/icons/1/a.png?size=96")
        );
        assert_eq!(discord_icon(Some("https://evil.example/a.png".into())), None);
        assert_eq!(checked_guild_ids(vec![" 12 ".into(), "12".into(), "34".into()]).unwrap(), vec!["12", "34"]);
        assert!(checked_guild_ids(vec!["12; drop".into()]).is_err());
        assert!(checked_guild_ids((0..26).map(|n| n.to_string()).collect()).is_err());
    }

    /// `get_settings` is the only way settings reach the webview, and the device token is the
    /// one field that must not make the trip.
    #[test]
    fn settings_sent_to_the_webview_carry_no_device_token() {
        let stored = Settings {
            device_token: Some("device-token".into()),
            account: Some(Account {
                discord_id: "123".into(),
                username: "benja".into(),
                avatar: None,
            }),
            ..Settings::default()
        };
        // The same shape `get_settings` builds; it needs a running app to call directly.
        let sent = Settings { device_token: None, ..stored.clone() };
        assert!(sent.device_token.is_none());
        assert_eq!(sent.account, stored.account, "the account still identifies the login");
        let json = serde_json::to_string(&sent).unwrap();
        assert!(!json.contains("device-token"), "{json}");
    }
}
