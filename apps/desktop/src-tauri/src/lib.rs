mod api;
mod capture;
mod settings;
mod storage;
mod ffmpeg;
mod games;
mod queue;
mod win;

use std::panic::AssertUnwindSafe;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use anyhow::Context as _;
use serde::Serialize;
use tauri::menu::{Menu, MenuItem};
use tauri::tray::TrayIconBuilder;
use tauri::{AppHandle, Emitter, Manager, State};
use tauri_plugin_autostart::{MacosLauncher, ManagerExt as _};
use tauri_plugin_dialog::DialogExt as _;
use tauri_plugin_global_shortcut::{Code, GlobalShortcutExt, Shortcut, ShortcutState};
use tauri_plugin_notification::NotificationExt as _;
use tauri_plugin_opener::OpenerExt as _;

use api::{Api, DevicePoll, NewClipUpload};
use capture::{CaptureConflict, HookCallback, HookedGame, Recorder};
use ffmpeg::{Binaries, Encoders, Trim};
use games::DetectedGame;
use queue::{
    ClipRow, ClipStatus, Gate, NewClip, OnChange, Outputs, Processor, Queue, UploadResult,
    Uploader, Worker,
};
use settings::{Account, Settings};

/// How long the device login keeps polling before giving up.
const LOGIN_TIMEOUT: Duration = Duration::from_secs(10 * 60);
const LOGIN_POLL: Duration = Duration::from_secs(2);

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
    /// ffmpeg/ffprobe, once located at startup. `None` means encoding is unavailable.
    ffmpeg: Mutex<Option<Binaries>>,
    /// Why ffmpeg is unavailable, shown in the Status tab.
    ffmpeg_error: Mutex<Option<String>>,
    /// Clip queue; `None` until the database opened (or forever if it could not).
    queue: Mutex<Option<Arc<Queue>>>,
    worker: Mutex<Option<Worker>>,
    /// The device login in progress, if any. Replaced by `start_login`, cleared on finish.
    login: Mutex<Option<LoginSession>>,
}

/// A running device login: the poll thread stops when `cancelled` is set.
struct LoginSession {
    code: String,
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
    auto_upload: bool,
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
        auto_upload: settings.auto_upload,
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
    let api = state.api()?;
    let device_name = std::env::var("COMPUTERNAME").unwrap_or_else(|_| "Windows PC".into());
    let start = api
        .start_device_login(&device_name)
        .context("starting device login")?;
    log::info!("device login {} started, opening {}", start.code, start.verify_url);
    if let Err(e) = app.opener().open_url(&start.verify_url, None::<&str>) {
        log::warn!("opening browser: {e}");
    }

    let cancelled = Arc::new(AtomicBool::new(false));
    *state.login.lock().unwrap() = Some(LoginSession {
        code: start.code.clone(),
        cancelled: Arc::clone(&cancelled),
    });
    let poll_app = app.clone();
    let code = start.code.clone();
    std::thread::spawn(move || poll_login(&poll_app, api, &code, cancelled));
    let _ = app.emit("login-changed", ());
    Ok(LoginStarted {
        code: start.code,
        verify_url: start.verify_url,
    })
}

/// Polls the device code until it is ready. Runs on its own thread.
fn poll_login(app: &AppHandle, api: Api, code: &str, cancelled: Arc<AtomicBool>) {
    let deadline = Instant::now() + LOGIN_TIMEOUT;
    let outcome: Result<(String, Account), String> = loop {
        std::thread::sleep(LOGIN_POLL);
        if cancelled.load(Ordering::SeqCst) {
            return;
        }
        if Instant::now() > deadline {
            break Err("login timed out; try again".into());
        }
        match api.poll_device_login(code) {
            Ok(Some(DevicePoll::Pending)) => {}
            Ok(Some(DevicePoll::Ready { token, user })) => break Ok((token, user.into())),
            Ok(None) => break Err("login code expired; try again".into()),
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
/// pending `encoded` rows get uploaded.
fn store_account(app: &AppHandle, token: Option<String>, account: Option<Account>) -> anyhow::Result<()> {
    let state = app.state::<AppState>();
    {
        let mut s = state.settings.lock().unwrap();
        s.device_token = token;
        s.account = account;
        s.save().context("saving settings")?;
    }
    let _ = app.emit("account-changed", state.account());
    let _ = app.emit("status-changed", ());
    state.wake_worker();
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

/// Removes the row and every file we know about for it. Missing files are fine.
#[tauri::command]
async fn delete_clip(app: AppHandle, id: i64) -> Result<(), String> {
    let state = app.state::<AppState>();
    let row = queue_or_err(&state)?
        .delete(id)
        .map_err(|e| format!("{e:#}"))?;
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

#[tauri::command]
fn retry_clip(app: AppHandle, id: i64) -> Result<(), String> {
    let state = app.state::<AppState>();
    queue_or_err(&state)?
        .retry(id)
        .map_err(|e| format!("{e:#}"))?;
    state.wake_worker();
    emit_clips_changed(&app, Some(id));
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
        Ok(storage::scan(&rows, &clip_dir))
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

    let source = Path::new(&row.source_path);
    let (av1, h264, thumb) = storage::output_paths(source);
    log::info!("encoding clip {} ({})", row.id, source.display());

    let t = Instant::now();
    let at_ms = row.duration_ms / 4;
    ffmpeg::thumbnail(&bins, source, &thumb, at_ms)
        .with_context(|| format!("thumbnail for {}", source.display()))?;
    log::info!("clip {}: thumbnail in {:.1?}", row.id, t.elapsed());

    let t = Instant::now();
    ffmpeg::encode_av1(&bins, &encoders.av1, quality, source, &av1, Trim::default())
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
    ffmpeg::encode_h264(&bins, &encoders.h264, quality, source, &h264, Trim::default())
        .with_context(|| format!("H.264 encode with {}", encoders.h264))?;
    let size_h264 = file_size(&h264)?;
    log::info!(
        "clip {}: H.264 ({}) in {:.1?}, {} bytes",
        row.id,
        encoders.h264,
        t.elapsed(),
        size_h264
    );

    Ok(Outputs {
        av1_path: av1.display().to_string(),
        h264_path: h264.display().to_string(),
        thumb_path: thumb.display().to_string(),
        size_av1,
        size_h264,
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
    let created = api
        .create_clip(&NewClipUpload {
            game: row.game.clone(),
            title: row.title.clone(),
            duration_ms: row.duration_ms,
            width: row.width,
            height: row.height,
            recorded_at: row.recorded_at.clone(),
            size_av1: row.size_av1.unwrap_or(0),
            size_h264: row.size_h264.unwrap_or(0),
        })
        .map_err(|e| match api::status_of(&e) {
            Some(503) => e.context("the backend has no storage configured yet"),
            _ => e,
        })
        .context("creating clip record")?;
    log::info!("clip {}: remote id {}", row.id, created.id);

    for (url, path, content_type) in [
        (&created.uploads.av1, av1, "video/mp4"),
        (&created.uploads.h264, h264, "video/mp4"),
        (&created.uploads.thumb, thumb, "image/jpeg"),
    ] {
        api.put_file(url, Path::new(path), content_type)
            .with_context(|| format!("uploading {path}"))?;
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
    if state.settings.lock().unwrap().notify_on_save {
        show_toast(app, "Clip uploaded", &done.urls.page);
    }
    Ok(UploadResult {
        remote_id: done.id,
        page_url: done.urls.page,
    })
}

/// True when the worker may upload: logged in and auto-upload on.
fn upload_allowed(app: &AppHandle) -> bool {
    let s = app.state::<AppState>().settings.lock().unwrap().clone();
    s.logged_in() && s.auto_upload
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
    emit_clips_changed(app, Some(id));
    let state = app.state::<AppState>();
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
}

/// Probes the freshly written file and enqueues it. libobs may still be flushing the MP4
/// when the replay buffer returns, so the probe is retried for about three seconds.
fn enqueue_saved_clip(app: &AppHandle, path: PathBuf, detected: Option<DetectedGame>) {
    let state = app.state::<AppState>();
    let Some(queue) = state.queue() else {
        log::warn!("clip queue unavailable; {} will not be encoded", path.display());
        return;
    };
    let bins = state.ffmpeg.lock().unwrap().clone();
    let Some(bins) = bins else {
        log::warn!("ffmpeg unavailable; {} will not be encoded", path.display());
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
        size_source: info.size as i64,
    };
    match queue.enqueue(clip) {
        Ok(id) => {
            log::info!(
                "queued clip {id}: {} ({} ms, {}x{})",
                path.display(),
                info.duration_ms,
                info.width,
                info.height
            );
            state.wake_worker();
            emit_clips_changed(app, Some(id));
        }
        Err(e) => log::error!("enqueue {} failed: {e:#}", path.display()),
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
            std::thread::spawn(move || enqueue_saved_clip(&queue_app, queue_path, detected));
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

    // The UI never edits the login; keep whatever the account flow stored meanwhile.
    {
        let live = state.settings.lock().unwrap();
        new.device_token = live.device_token.clone();
        new.account = live.account.clone();
    }
    // Persist before touching the recorder so a libobs failure does not lose the change.
    new.save().context("saving settings")?;
    *state.settings.lock().unwrap() = new.clone();
    if new.auto_upload && !old.auto_upload {
        state.wake_worker();
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
            ffmpeg: Mutex::new(None),
            ffmpeg_error: Mutex::new(None),
            queue: Mutex::new(None),
            worker: Mutex::new(None),
            login: Mutex::new(None),
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
            retry_clip,
            open_clip_folder,
            get_thumbnail,
            storage_stats,
            clean_storage,
            open_clip_dir,
            get_encoders,
            reprobe_encoders,
            start_login,
            cancel_login,
            logout,
            get_account
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
            let recorder_handle = handle.clone();
            std::thread::spawn(move || start_recorder(&recorder_handle));
            // A stored device token is checked against the backend off the main thread.
            if settings.logged_in() {
                let verify_handle = handle.clone();
                std::thread::spawn(move || verify_token(&verify_handle));
            }
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
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
