//! The session feature's side of the app: the host the session watch runs against, processing
//! finished sessions into match files, and the commands the Matches tab calls.
//!
//! Recordings and match files live in `<clip folder>\Matches`. The Storage tab only reads the
//! top of the clip folder, so none of them are mistaken for leftovers there.

use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use anyhow::{bail, Context as _};
use chrono::{DateTime, Duration, Local, Utc};
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, State};
use tauri_plugin_opener::OpenerExt as _;

use crate::cutter::{self, Processed};
use crate::ffmpeg::{self, Segment};
use crate::placement::{self, ClipMatch, MatchClip};
use crate::queue::NewClip;
use crate::session_watch::{self, Host, LiveSession};
use crate::sessions::{format_time, parse_time, EventRow, SessionRow, SessionStatus, SessionStore};
use crate::timeline::{Provider, SessionGame, Sighting};
use crate::{emit_clips_changed, on_blocking_thread, queue_or_err, AppState};

/// Shortest clip that can be taken out of a match.
const MIN_CLIP_MS: i64 = 1_000;
/// Footage kept either side of a clip taken from a match, so the editor can still widen it.
const CLIP_MARGIN_MS: i64 = 3_000;

pub fn matches_dir(clip_dir: &Path) -> PathBuf {
    clip_dir.join("Matches")
}

#[derive(Serialize, Clone)]
struct SessionChanged {
    id: i64,
}

fn emit_sessions_changed(app: &AppHandle, id: i64) {
    let _ = app.emit("sessions-changed", SessionChanged { id });
}

struct AppHost {
    app: AppHandle,
}

impl Host for AppHost {
    fn running_executables(&self) -> Vec<String> {
        crate::win::running_executables().unwrap_or_else(|e| {
            log::debug!("process list unavailable: {e:#}");
            Vec::new()
        })
    }

    fn enabled(&self) -> bool {
        self.app.state::<AppState>().settings.lock().unwrap().record_sessions
    }

    fn recording_path(&self, session_id: i64, n: usize) -> PathBuf {
        let clip_dir = self.app.state::<AppState>().settings.lock().unwrap().clip_dir.clone();
        matches_dir(&clip_dir).join(format!("session-{session_id}-{n}.mp4"))
    }

    fn start_recording(&self, path: &Path) -> anyhow::Result<()> {
        let state = self.app.state::<AppState>();
        let mut recorder = state.recorder.lock().unwrap();
        match recorder.as_mut() {
            Some(r) => r.start_recording(path),
            None => bail!("the recorder is not running"),
        }
    }

    fn stop_recording(&self) -> anyhow::Result<DateTime<Utc>> {
        let state = self.app.state::<AppState>();
        let mut recorder = state.recorder.lock().unwrap();
        // Taken before the stop: the file ends where the stop was asked for.
        let at = Utc::now();
        if let Some(r) = recorder.as_mut() {
            r.stop_recording()?;
        }
        Ok(at)
    }

    fn current_recording(&self) -> Option<PathBuf> {
        let state = self.app.state::<AppState>();
        let recorder = state.recorder.lock().unwrap();
        recorder.as_ref()?.recording_path()
    }

    fn provider(&self, game: SessionGame) -> Option<Box<dyn Provider>> {
        crate::providers::for_game(game)
    }

    fn game_name(&self, s: &Sighting) -> String {
        crate::games::name_for(&s.executable, "").unwrap_or_else(|| s.game.id().to_string())
    }

    fn session_changed(&self, session_id: i64) {
        emit_sessions_changed(&self.app, session_id);
    }

    fn session_ended(&self, session_id: i64) {
        on_session_ended(&self.app, session_id);
    }
}

/// Opens the session database, finishes whatever a previous run left behind, and starts the
/// session watch. Runs once at startup on its own thread.
pub fn start(app: &AppHandle) {
    let state = app.state::<AppState>();
    let Some(db) = crate::settings::data_dir().map(|d| d.join("sessions.db")) else {
        log::error!("APPDATA is not set; session recording disabled");
        return;
    };
    let store = match SessionStore::open(&db) {
        Ok(s) => Arc::new(s),
        Err(e) => {
            log::error!("opening session database {}: {e:#}", db.display());
            return;
        }
    };
    match store.recover() {
        Ok(pending) if !pending.is_empty() => log::info!("{} session(s) wait to be processed", pending.len()),
        Ok(_) => {}
        Err(e) => log::error!("recovering sessions: {e:#}"),
    }
    *state.sessions.lock().unwrap() = Some(store.clone());

    let host: Arc<dyn Host> = Arc::new(AppHost { app: app.clone() });
    let tick_app = app.clone();
    let spawned = session_watch::spawn(store, host, move |live| {
        let state = tick_app.state::<AppState>();
        let mut current = state.live_session.lock().unwrap();
        if *current != live {
            *current = live;
            drop(current);
            let _ = tick_app.emit("status-changed", ());
        }
    });
    if let Err(e) = spawned {
        log::error!("session watch could not start: {e}");
    }
    log::info!("session watch running, database at {}", db.display());
    process_pending(app);
    let _ = app.emit("sessions-changed", SessionChanged { id: 0 });
}

fn on_session_ended(app: &AppHandle, id: i64) {
    emit_sessions_changed(app, id);
    let open = app.state::<AppState>().settings.lock().unwrap().open_after_session;
    if open {
        if let Some(w) = app.get_webview_window("main") {
            let _ = w.unminimize();
            let _ = w.show();
            let _ = w.set_focus();
        }
        let _ = app.emit("session-ended", SessionChanged { id });
    }
    process(app, vec![id]);
}

/// Processes every session waiting for it. Needs both the database and ffmpeg, which open on
/// different threads at startup, so each of them calls this once it is ready.
pub fn process_pending(app: &AppHandle) {
    let Some(store) = app.state::<AppState>().sessions.lock().unwrap().clone() else {
        return;
    };
    match store.pending() {
        Ok(ids) if !ids.is_empty() => process(app, ids),
        Ok(_) => {}
        Err(e) => log::error!("listing sessions to process: {e:#}"),
    }
}

/// Cuts the given sessions into matches, one after another, on a background thread.
fn process(app: &AppHandle, ids: Vec<i64>) {
    let state = app.state::<AppState>();
    let Some(store) = state.sessions.lock().unwrap().clone() else {
        return;
    };
    let Some(bins) = state.ffmpeg.lock().unwrap().clone() else {
        log::info!("sessions {ids:?} will be cut once ffmpeg is available");
        return;
    };
    let ids: Vec<i64> = {
        let mut busy = state.processing.lock().unwrap();
        ids.into_iter().filter(|id| busy.insert(*id)).collect()
    };
    if ids.is_empty() {
        return;
    }
    let app = app.clone();
    std::thread::spawn(move || {
        for id in ids {
            emit_sessions_changed(&app, id);
            let outcome = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                cutter::process(&store, &bins, id)
            }));
            let failure = match outcome {
                Ok(Ok(Processed::Ready { matches })) => {
                    log::info!("session {id} ready with {matches} match(es)");
                    None
                }
                Ok(Ok(Processed::Discarded)) => None,
                Ok(Ok(Processed::Failed)) => None,
                Ok(Err(e)) => Some(format!("{e:#}")),
                Err(_) => Some("cutting the session panicked".to_string()),
            };
            if let Some(text) = failure {
                log::error!("session {id} could not be processed: {text}");
                if let Err(e) = store.set_session_status(id, SessionStatus::Failed, Some(&text)) {
                    log::error!("{e:#}");
                }
            }
            app.state::<AppState>().processing.lock().unwrap().remove(&id);
            emit_sessions_changed(&app, id);
        }
        enforce_session_storage(&app, &store);
    });
}

/// Keeps `<clip folder>\Matches` under the configured limit, the same way the clip queue's
/// `on_clip_changed` enforces `storage_limit_gb` after every job. Runs once after a batch of
/// sessions finishes cutting rather than after each one, since a whole batch just wrote its
/// match files together.
fn enforce_session_storage(app: &AppHandle, store: &SessionStore) {
    let limit_gb = app.state::<AppState>().settings.lock().unwrap().session_storage_limit_gb;
    if limit_gb == 0 {
        return;
    }
    match crate::storage::enforce_session_limit(store, i64::from(limit_gb) * crate::storage::GB) {
        Ok(freed) if freed.clips > 0 => {
            log::info!("session storage limit freed {} match(es), {} bytes", freed.clips, freed.bytes);
        }
        Ok(_) => {}
        Err(e) => log::warn!("session storage limit could not be applied: {e:#}"),
    }
}

fn store_or_err(state: &AppState) -> Result<Arc<SessionStore>, String> {
    state
        .sessions
        .lock()
        .unwrap()
        .clone()
        .ok_or_else(|| "the session database is not available".to_string())
}

/// Refuses to touch a session that is still being recorded or cut.
fn check_idle(state: &AppState, session_id: i64) -> Result<(), String> {
    if state.live_session.lock().unwrap().as_ref().is_some_and(|l| l.id == session_id) {
        return Err("this session is still being recorded".into());
    }
    if state.processing.lock().unwrap().contains(&session_id) {
        return Err("this session is being cut into matches right now".into());
    }
    Ok(())
}

fn remove_files(files: &[String]) {
    for p in files {
        match std::fs::remove_file(p) {
            Ok(()) => log::info!("deleted {p}"),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(e) => log::warn!("could not delete {p}: {e}"),
        }
    }
}

// ---------------------------------------------------------------------------
// Commands

#[tauri::command]
pub fn list_sessions(state: State<AppState>) -> Result<Vec<SessionRow>, String> {
    store_or_err(&state)?.list().map_err(|e| format!("{e:#}"))
}

#[tauri::command]
pub fn match_events(state: State<AppState>, id: i64) -> Result<Vec<EventRow>, String> {
    store_or_err(&state)?.events(id).map_err(|e| format!("{e:#}"))
}

#[tauri::command]
pub fn live_session(state: State<AppState>) -> Option<LiveSession> {
    state.live_session.lock().unwrap().clone()
}

#[tauri::command]
pub async fn delete_session(app: AppHandle, id: i64) -> Result<(), String> {
    on_blocking_thread(move || {
        let state = app.state::<AppState>();
        check_idle(&state, id)?;
        let files = store_or_err(&state)?.delete_session(id).map_err(|e| format!("{e:#}"))?;
        remove_files(&files);
        emit_sessions_changed(&app, id);
        Ok(())
    })
    .await
}

#[tauri::command]
pub async fn delete_match(app: AppHandle, id: i64) -> Result<(), String> {
    on_blocking_thread(move || {
        let state = app.state::<AppState>();
        let store = store_or_err(&state)?;
        let row = store
            .get_match(id)
            .map_err(|e| format!("{e:#}"))?
            .ok_or_else(|| format!("match {id} not found"))?;
        check_idle(&state, row.session_id)?;
        let files = store.delete_match(id).map_err(|e| format!("{e:#}"))?;
        remove_files(&files);
        emit_sessions_changed(&app, row.session_id);
        Ok(())
    })
    .await
}

/// Tries to cut a session that failed again, from the recordings it kept.
#[tauri::command]
pub fn retry_session(app: AppHandle, id: i64) -> Result<(), String> {
    let state = app.state::<AppState>();
    check_idle(&state, id)?;
    let store = store_or_err(&state)?;
    let session = store
        .session(id)
        .map_err(|e| format!("{e:#}"))?
        .ok_or_else(|| format!("session {id} not found"))?;
    if session.status != SessionStatus::Failed {
        return Err("only a session that failed can be tried again".into());
    }
    store
        .set_session_status(id, SessionStatus::Processing, None)
        .map_err(|e| format!("{e:#}"))?;
    process(&app, vec![id]);
    Ok(())
}

/// Takes `start_ms..end_ms` of a match file and puts it in the clip queue like any saved clip:
/// a short copy of the footage around it becomes the clip's recording, and the exact range
/// becomes its cut, so the editor opens with room to widen it. Returns the new clip's id.
#[tauri::command]
pub async fn clip_from_match(app: AppHandle, id: i64, start_ms: i64, end_ms: i64) -> Result<i64, String> {
    let emit_app = app.clone();
    let clip_id = on_blocking_thread(move || clip_from_match_inner(&app, id, start_ms, end_ms).map_err(|e| format!("{e:#}")))
        .await?;
    emit_clips_changed(&emit_app, Some(clip_id));
    Ok(clip_id)
}

fn clip_from_match_inner(app: &AppHandle, id: i64, start_ms: i64, end_ms: i64) -> anyhow::Result<i64> {
    let state = app.state::<AppState>();
    let store = store_or_err(&state).map_err(anyhow::Error::msg)?;
    let queue = queue_or_err(&state).map_err(anyhow::Error::msg)?;
    let bins = state.ffmpeg.lock().unwrap().clone().context("ffmpeg is not available")?;
    let row = store.get_match(id)?.with_context(|| format!("match {id} not found"))?;
    let session = store
        .session(row.session_id)?
        .with_context(|| format!("session {} not found", row.session_id))?;
    let path = row
        .path
        .as_deref()
        .filter(|p| Path::new(p).is_file())
        .context("this match has no video on this PC")?;
    let duration = row.duration_ms.context("this match has not been measured")?;
    let file_start = parse_time(row.file_start_at.as_deref().context("this match has no start time")?)?;

    let start = start_ms.clamp(0, duration);
    let end = end_ms.clamp(0, duration);
    if end - start < MIN_CLIP_MS {
        bail!("a clip needs at least a second");
    }

    let from = ffmpeg::keyframe_at_or_before(&bins, Path::new(path), (start - CLIP_MARGIN_MS).max(0))?;
    let to = (end + CLIP_MARGIN_MS).min(duration);
    let clip_dir = state.settings.lock().unwrap().clip_dir.clone();
    let moment = file_start + Duration::milliseconds(start);
    // Named like the replay buffer names its clips, after the moment the clip starts.
    let stem = moment.with_timezone(&Local).format("%Y-%m-%d %H-%M-%S").to_string();
    let dst = cutter::unique(&clip_dir, &stem);
    ffmpeg::copy_range(&bins, Path::new(path), from, to, &dst)?;
    let info = ffmpeg::probe(&bins, &dst)?;

    let cut = [Segment {
        start_ms: start - from,
        end_ms: (end - from).min(info.duration_ms),
    }];
    let clip = NewClip {
        source_path: dst.display().to_string(),
        game: Some(session.game_name.clone()),
        title: None,
        recorded_at: moment.with_timezone(&Local).to_rfc3339(),
        duration_ms: cut[0].end_ms - cut[0].start_ms,
        width: info.width,
        height: info.height,
        fps: info.fps,
        size_source: info.size as i64,
        // A match is cut out long after it was played, so there is no moment to snapshot
        // voice membership at. Only the hotkey path carries participants.
        participants: None,
        // The copy starts on the keyframe at `from`, which is what places the clip back on
        // this match's timeline.
        captured_at: Some(format_time(file_start + Duration::milliseconds(from))),
    };
    let clip_id = queue.enqueue_with_cut(clip, &cut)?;
    log::info!(
        "clip {clip_id} taken from match {id}: {start}..{end} ms of {}",
        Path::new(path).display()
    );
    // A local clip: nothing encodes it, so it gets its thumbnail here. The worker is not woken,
    // there is nothing for it to do until the clip is published.
    if let Err(e) = crate::edit::refresh_thumbnail(&bins, &queue, clip_id) {
        log::warn!("clip {clip_id}: thumbnail failed: {e:#}");
    }
    Ok(clip_id)
}

/// The clips taken during a match, as ranges on its timeline.
#[tauri::command]
pub async fn clips_for_match(app: AppHandle, match_id: i64) -> Result<Vec<MatchClip>, String> {
    on_blocking_thread(move || {
        let state = app.state::<AppState>();
        let store = store_or_err(&state)?;
        let clips = queue_or_err(&state)?.list().map_err(|e| format!("{e:#}"))?;
        placement::clips_for_match(&store, &clips, match_id).map_err(|e| format!("{e:#}"))
    })
    .await
}

/// The match a clip was taken in, if it is still on this PC.
#[tauri::command]
pub async fn match_for_clip(app: AppHandle, clip_id: i64) -> Result<Option<ClipMatch>, String> {
    on_blocking_thread(move || {
        let state = app.state::<AppState>();
        let store = store_or_err(&state)?;
        let Some(row) = queue_or_err(&state)?.get(clip_id).map_err(|e| format!("{e:#}"))? else {
            return Ok(None);
        };
        let candidates = placement::candidates(&store).map_err(|e| format!("{e:#}"))?;
        Ok(placement::best_match(&candidates, &row))
    })
    .await
}

/// Which clips have a match to show them in, all at once, so the library can offer "Show in
/// match" without asking once per card.
#[derive(Serialize, Clone)]
pub struct ClipMatchRef {
    clip_id: i64,
    match_id: i64,
    session_id: i64,
}

#[tauri::command]
pub async fn clip_match_index(app: AppHandle) -> Result<Vec<ClipMatchRef>, String> {
    on_blocking_thread(move || {
        let state = app.state::<AppState>();
        // Before the session database opens there is simply nothing to show a clip in.
        let Some(store) = state.sessions.lock().unwrap().clone() else {
            return Ok(Vec::new());
        };
        let clips = queue_or_err(&state)?.list().map_err(|e| format!("{e:#}"))?;
        let candidates = placement::candidates(&store).map_err(|e| format!("{e:#}"))?;
        Ok(clips
            .iter()
            .filter_map(|c| {
                placement::best_match(&candidates, c).map(|m| ClipMatchRef {
                    clip_id: c.id,
                    match_id: m.match_id,
                    session_id: m.session_id,
                })
            })
            .collect())
    })
    .await
}

#[tauri::command]
pub fn open_match_folder(app: AppHandle, id: i64) -> Result<(), String> {
    let state = app.state::<AppState>();
    let row = store_or_err(&state)?
        .get_match(id)
        .map_err(|e| format!("{e:#}"))?
        .ok_or_else(|| format!("match {id} not found"))?;
    match row.path.as_deref().filter(|p| Path::new(p).exists()) {
        Some(p) => app.opener().reveal_item_in_dir(p).map_err(|e| format!("{e:#}")),
        None => {
            let clip_dir = state.settings.lock().unwrap().clip_dir.clone();
            let dir = matches_dir(&clip_dir);
            app.opener()
                .open_path(dir.display().to_string(), None::<&str>)
                .map_err(|e| format!("{e:#}"))
        }
    }
}

/// A match's thumbnail as a data URL.
#[tauri::command]
pub fn match_thumbnail(state: State<AppState>, id: i64) -> Result<Option<String>, String> {
    let row = store_or_err(&state)?.get_match(id).map_err(|e| format!("{e:#}"))?;
    let Some(thumb) = row.and_then(|r| r.thumb_path) else {
        return Ok(None);
    };
    match std::fs::read(&thumb) {
        Ok(bytes) => Ok(Some(format!("data:image/jpeg;base64,{}", crate::base64_encode(&bytes)))),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(format!("reading {thumb}: {e}")),
    }
}

/// Ids being cut right now, so a UI can say so for a session that just ended.
pub type Processing = HashSet<i64>;
