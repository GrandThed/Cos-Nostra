//! Clip job queue on SQLite under %APPDATA%\Cos Nostra\clips.db, plus the worker thread that
//! drains it. States: saved -> encoding -> encoded (-> uploading -> done in phase 3), or failed.
//! Failed jobs retry with exponential backoff up to `MAX_ATTEMPTS`, after which they wait for
//! a manual retry. The queue survives restarts: an `encoding` row found at open time is put
//! back to `saved`.

use std::panic::{catch_unwind, AssertUnwindSafe};
use std::path::Path;
use std::sync::{Arc, Condvar, Mutex, MutexGuard};
use std::time::Duration;

use anyhow::{anyhow, Context, Result};
use chrono::{DateTime, SecondsFormat, Utc};
use rusqlite::{params, Connection, OptionalExtension, Row};
use serde::{Deserialize, Serialize};

pub const MAX_ATTEMPTS: i32 = 5;

/// Current schema, stored in `PRAGMA user_version` so later phases can migrate.
const SCHEMA_VERSION: i32 = 1;

/// How often the worker polls when nobody calls `wake`.
#[cfg(not(test))]
const POLL_INTERVAL: Duration = Duration::from_secs(5);
#[cfg(test)]
const POLL_INTERVAL: Duration = Duration::from_millis(50);

/// First retry delay; doubles per attempt up to `BACKOFF_CAP`.
#[cfg(not(test))]
const BACKOFF_BASE: Duration = Duration::from_secs(30);
#[cfg(not(test))]
const BACKOFF_CAP: Duration = Duration::from_secs(30 * 60);
#[cfg(test)]
const BACKOFF_BASE: Duration = Duration::from_millis(40);
#[cfg(test)]
const BACKOFF_CAP: Duration = Duration::from_millis(500);

/// Longest error text stored on a row.
const MAX_ERROR_CHARS: usize = 2000;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ClipStatus {
    Saved,
    Encoding,
    Encoded,
    Uploading,
    Done,
    Failed,
}

impl ClipStatus {
    pub fn as_str(self) -> &'static str {
        match self {
            ClipStatus::Saved => "saved",
            ClipStatus::Encoding => "encoding",
            ClipStatus::Encoded => "encoded",
            ClipStatus::Uploading => "uploading",
            ClipStatus::Done => "done",
            ClipStatus::Failed => "failed",
        }
    }

    pub fn parse(s: &str) -> Option<Self> {
        Some(match s {
            "saved" => ClipStatus::Saved,
            "encoding" => ClipStatus::Encoding,
            "encoded" => ClipStatus::Encoded,
            "uploading" => ClipStatus::Uploading,
            "done" => ClipStatus::Done,
            "failed" => ClipStatus::Failed,
            _ => return None,
        })
    }
}

/// What the app knows about a clip right after the replay buffer wrote it.
#[derive(Debug, Clone)]
pub struct NewClip {
    pub source_path: String,
    pub game: Option<String>,
    pub title: Option<String>,
    /// RFC 3339.
    pub recorded_at: String,
    pub duration_ms: i64,
    pub width: u32,
    pub height: u32,
    pub size_source: i64,
}

/// One row of the clips table, as shown in the UI.
#[derive(Debug, Clone, Serialize)]
pub struct ClipRow {
    pub id: i64,
    pub source_path: String,
    pub game: Option<String>,
    pub title: Option<String>,
    pub recorded_at: String,
    pub duration_ms: i64,
    pub width: u32,
    pub height: u32,
    pub size_source: i64,
    pub size_av1: Option<i64>,
    pub size_h264: Option<i64>,
    pub av1_path: Option<String>,
    pub h264_path: Option<String>,
    pub thumb_path: Option<String>,
    pub status: ClipStatus,
    pub error: Option<String>,
    pub attempts: i32,
}

/// Files the processor produced for a clip.
#[derive(Debug, Clone)]
pub struct Outputs {
    pub av1_path: String,
    pub h264_path: String,
    pub thumb_path: String,
    pub size_av1: i64,
    pub size_h264: i64,
}

/// Does the encoding work for one clip. Runs on the worker thread.
pub type Processor = Arc<dyn Fn(&ClipRow) -> Result<Outputs> + Send + Sync>;
/// Returns true when the worker may encode right now (for example no game in the foreground).
pub type Gate = Arc<dyn Fn() -> bool + Send + Sync>;
/// Called with the clip id after every status change so the UI can refresh.
pub type OnChange = Arc<dyn Fn(i64) + Send + Sync>;

const SCHEMA: &str = "
CREATE TABLE IF NOT EXISTS clips (
    id INTEGER PRIMARY KEY,
    source_path TEXT NOT NULL UNIQUE,
    game TEXT,
    title TEXT,
    recorded_at TEXT NOT NULL,
    duration_ms INTEGER NOT NULL,
    width INTEGER,
    height INTEGER,
    size_source INTEGER NOT NULL,
    size_av1 INTEGER,
    size_h264 INTEGER,
    av1_path TEXT,
    h264_path TEXT,
    thumb_path TEXT,
    status TEXT NOT NULL,
    error TEXT,
    attempts INTEGER NOT NULL DEFAULT 0,
    next_attempt_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS clips_status ON clips(status);
";

/// Column list shared by every SELECT so `row_from` stays in sync.
const COLUMNS: &str = "id, source_path, game, title, recorded_at, duration_ms, width, height, \
    size_source, size_av1, size_h264, av1_path, h264_path, thumb_path, status, error, attempts";

pub struct Queue {
    conn: Mutex<Connection>,
}

impl Queue {
    /// Opens or creates the database and applies the schema. Resets stale `encoding` rows.
    pub fn open(path: &Path) -> Result<Queue> {
        if let Some(parent) = path.parent() {
            if !parent.as_os_str().is_empty() {
                std::fs::create_dir_all(parent)
                    .with_context(|| format!("creating {}", parent.display()))?;
            }
        }
        let conn = Connection::open(path)
            .with_context(|| format!("opening clip database {}", path.display()))?;
        conn.busy_timeout(Duration::from_secs(5))
            .context("setting busy timeout")?;
        conn.pragma_update(None, "journal_mode", "WAL")
            .context("enabling WAL")?;
        conn.pragma_update(None, "synchronous", "NORMAL")
            .context("setting synchronous")?;
        conn.execute_batch(SCHEMA).context("creating clips schema")?;

        let version: i32 = conn
            .pragma_query_value(None, "user_version", |r| r.get(0))
            .context("reading schema version")?;
        if version < SCHEMA_VERSION {
            // Nothing to migrate yet; future versions add ALTERs here keyed on `version`.
            conn.pragma_update(None, "user_version", SCHEMA_VERSION)
                .context("writing schema version")?;
        }

        let reset = conn
            .execute(
                "UPDATE clips SET status = 'saved', updated_at = ?1 WHERE status = 'encoding'",
                params![now_rfc3339()],
            )
            .context("resetting interrupted encodes")?;
        if reset > 0 {
            log::warn!("reset {reset} interrupted encoding job(s) to saved");
        }

        Ok(Queue {
            conn: Mutex::new(conn),
        })
    }

    fn lock(&self) -> MutexGuard<'_, Connection> {
        self.conn.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// Inserts a `saved` row and returns its id.
    pub fn enqueue(&self, clip: NewClip) -> Result<i64> {
        let now = now_rfc3339();
        let conn = self.lock();
        conn.execute(
            "INSERT INTO clips (source_path, game, title, recorded_at, duration_ms, width, height, \
             size_source, status, attempts, created_at, updated_at) \
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, 'saved', 0, ?9, ?9)",
            params![
                clip.source_path,
                clip.game,
                clip.title,
                clip.recorded_at,
                clip.duration_ms,
                clip.width,
                clip.height,
                clip.size_source,
                now,
            ],
        )
        .with_context(|| format!("enqueueing {}", clip.source_path))?;
        Ok(conn.last_insert_rowid())
    }

    /// All clips, newest first.
    pub fn list(&self) -> Result<Vec<ClipRow>> {
        let conn = self.lock();
        let mut stmt = conn
            .prepare(&format!(
                "SELECT {COLUMNS} FROM clips ORDER BY recorded_at DESC, id DESC"
            ))
            .context("preparing list")?;
        let rows = stmt
            .query_map([], row_from)
            .context("listing clips")?
            .collect::<rusqlite::Result<Vec<_>>>()
            .context("reading clip rows")?;
        Ok(rows)
    }

    pub fn get(&self, id: i64) -> Result<Option<ClipRow>> {
        let conn = self.lock();
        get_in(&conn, id)
    }

    /// Removes the row and returns it so the caller can delete the files.
    pub fn delete(&self, id: i64) -> Result<Option<ClipRow>> {
        let conn = self.lock();
        let row = get_in(&conn, id)?;
        if row.is_some() {
            conn.execute("DELETE FROM clips WHERE id = ?1", params![id])
                .with_context(|| format!("deleting clip {id}"))?;
        }
        Ok(row)
    }

    pub fn set_game(&self, id: i64, game: Option<&str>) -> Result<()> {
        let conn = self.lock();
        conn.execute(
            "UPDATE clips SET game = ?2, updated_at = ?3 WHERE id = ?1",
            params![id, game, now_rfc3339()],
        )
        .with_context(|| format!("setting game on clip {id}"))?;
        Ok(())
    }

    /// Puts a `failed` clip back to `saved` with attempts reset.
    pub fn retry(&self, id: i64) -> Result<()> {
        let conn = self.lock();
        conn.execute(
            "UPDATE clips SET status = 'saved', attempts = 0, error = NULL, \
             next_attempt_at = NULL, updated_at = ?2 WHERE id = ?1 AND status = 'failed'",
            params![id, now_rfc3339()],
        )
        .with_context(|| format!("retrying clip {id}"))?;
        Ok(())
    }

    /// Atomically picks the oldest runnable job and marks it `encoding`.
    fn claim_next(&self) -> Result<Option<ClipRow>> {
        let now = now_rfc3339();
        let mut conn = self.lock();
        let tx = conn.transaction().context("starting claim transaction")?;
        let row = tx
            .query_row(
                &format!(
                    "SELECT {COLUMNS} FROM clips WHERE \
                     (status = 'saved' AND (next_attempt_at IS NULL OR next_attempt_at <= ?1)) \
                     OR (status = 'failed' AND attempts < ?2 \
                         AND next_attempt_at IS NOT NULL AND next_attempt_at <= ?1) \
                     ORDER BY id ASC LIMIT 1"
                ),
                params![now, MAX_ATTEMPTS],
                row_from,
            )
            .optional()
            .context("selecting next job")?;
        let Some(mut row) = row else {
            return Ok(None);
        };
        tx.execute(
            "UPDATE clips SET status = 'encoding', next_attempt_at = NULL, updated_at = ?2 \
             WHERE id = ?1",
            params![row.id, now],
        )
        .with_context(|| format!("marking clip {} encoding", row.id))?;
        tx.commit().context("committing claim")?;
        row.status = ClipStatus::Encoding;
        Ok(Some(row))
    }

    fn mark_encoded(&self, id: i64, out: &Outputs) -> Result<()> {
        let conn = self.lock();
        conn.execute(
            "UPDATE clips SET status = 'encoded', error = NULL, next_attempt_at = NULL, \
             av1_path = ?2, h264_path = ?3, thumb_path = ?4, size_av1 = ?5, size_h264 = ?6, \
             updated_at = ?7 WHERE id = ?1",
            params![
                id,
                out.av1_path,
                out.h264_path,
                out.thumb_path,
                out.size_av1,
                out.size_h264,
                now_rfc3339(),
            ],
        )
        .with_context(|| format!("marking clip {id} encoded"))?;
        Ok(())
    }

    /// Records a failure, bumps attempts and schedules the next try (or none at the cap).
    fn mark_failed(&self, id: i64, error: &str) -> Result<()> {
        let error: String = error.chars().take(MAX_ERROR_CHARS).collect();
        let now = Utc::now();
        let mut conn = self.lock();
        let tx = conn.transaction().context("starting failure transaction")?;
        let attempts: i32 = tx
            .query_row(
                "SELECT attempts FROM clips WHERE id = ?1",
                params![id],
                |r| r.get::<_, i32>(0),
            )
            .with_context(|| format!("reading attempts of clip {id}"))?
            + 1;
        let next_attempt_at = if attempts < MAX_ATTEMPTS {
            Some(format_rfc3339(now + backoff_for(attempts)))
        } else {
            None
        };
        tx.execute(
            "UPDATE clips SET status = 'failed', error = ?2, attempts = ?3, \
             next_attempt_at = ?4, updated_at = ?5 WHERE id = ?1",
            params![id, error, attempts, next_attempt_at, format_rfc3339(now)],
        )
        .with_context(|| format!("marking clip {id} failed"))?;
        tx.commit().context("committing failure")?;
        Ok(())
    }

    #[cfg(test)]
    fn next_attempt_at(&self, id: i64) -> Result<Option<String>> {
        let conn = self.lock();
        Ok(conn.query_row(
            "SELECT next_attempt_at FROM clips WHERE id = ?1",
            params![id],
            |r| r.get(0),
        )?)
    }
}

fn get_in(conn: &Connection, id: i64) -> Result<Option<ClipRow>> {
    conn.query_row(
        &format!("SELECT {COLUMNS} FROM clips WHERE id = ?1"),
        params![id],
        row_from,
    )
    .optional()
    .with_context(|| format!("reading clip {id}"))
}

fn row_from(r: &Row<'_>) -> rusqlite::Result<ClipRow> {
    let status_text: String = r.get(14)?;
    let status = ClipStatus::parse(&status_text).ok_or_else(|| {
        rusqlite::Error::FromSqlConversionFailure(
            14,
            rusqlite::types::Type::Text,
            format!("unknown clip status {status_text:?}").into(),
        )
    })?;
    Ok(ClipRow {
        id: r.get(0)?,
        source_path: r.get(1)?,
        game: r.get(2)?,
        title: r.get(3)?,
        recorded_at: r.get(4)?,
        duration_ms: r.get(5)?,
        width: r.get::<_, Option<u32>>(6)?.unwrap_or(0),
        height: r.get::<_, Option<u32>>(7)?.unwrap_or(0),
        size_source: r.get(8)?,
        size_av1: r.get(9)?,
        size_h264: r.get(10)?,
        av1_path: r.get(11)?,
        h264_path: r.get(12)?,
        thumb_path: r.get(13)?,
        status,
        error: r.get(15)?,
        attempts: r.get(16)?,
    })
}

/// Fixed-width RFC 3339 UTC so string comparison in SQL orders by time.
fn format_rfc3339(t: DateTime<Utc>) -> String {
    t.to_rfc3339_opts(SecondsFormat::Millis, true)
}

fn now_rfc3339() -> String {
    format_rfc3339(Utc::now())
}

/// Delay before the next try after `attempts` failures: base * 2^(attempts-1), capped.
fn backoff_for(attempts: i32) -> Duration {
    backoff_with(BACKOFF_BASE, BACKOFF_CAP, attempts)
}

fn backoff_with(base: Duration, cap: Duration, attempts: i32) -> Duration {
    let exp = attempts.saturating_sub(1).clamp(0, 30) as u32;
    base.checked_mul(1u32 << exp).unwrap_or(cap).min(cap)
}

struct WorkerInner {
    woken: Mutex<bool>,
    cv: Condvar,
}

impl WorkerInner {
    /// Blocks until `wake` is called or `timeout` passes, consuming the wake flag.
    fn wait(&self, timeout: Duration) {
        let mut woken = self.woken.lock().unwrap_or_else(|e| e.into_inner());
        if !*woken {
            let (guard, _) = self
                .cv
                .wait_timeout(woken, timeout)
                .unwrap_or_else(|e| e.into_inner());
            woken = guard;
        }
        *woken = false;
    }
}

/// Handle to the worker thread. Dropping it does not stop the thread; call `wake` after
/// enqueueing so the worker does not wait for its next poll.
pub struct Worker {
    inner: Arc<WorkerInner>,
}

impl Worker {
    pub fn wake(&self) {
        *self.inner.woken.lock().unwrap_or_else(|e| e.into_inner()) = true;
        self.inner.cv.notify_one();
    }
}

/// Starts the worker thread. It polls every few seconds and whenever woken, picks the oldest
/// `saved` row whose retry time has passed, marks it `encoding`, runs `processor`, then marks
/// `encoded` or `failed` (with backoff). `gate` is checked before each job and the job is
/// skipped while it returns false.
pub fn start_worker(
    queue: Arc<Queue>,
    processor: Processor,
    gate: Gate,
    on_change: OnChange,
) -> Worker {
    let inner = Arc::new(WorkerInner {
        woken: Mutex::new(false),
        cv: Condvar::new(),
    });
    let thread_inner = Arc::clone(&inner);
    let spawned = std::thread::Builder::new()
        .name("clip-worker".into())
        .spawn(move || worker_loop(thread_inner, queue, processor, gate, on_change));
    if let Err(e) = spawned {
        log::error!("failed to start clip worker thread: {e}");
    }
    Worker { inner }
}

fn worker_loop(
    inner: Arc<WorkerInner>,
    queue: Arc<Queue>,
    processor: Processor,
    gate: Gate,
    on_change: OnChange,
) {
    log::info!("clip worker started");
    loop {
        inner.wait(POLL_INTERVAL);
        // Drain everything runnable, re-checking the gate between jobs.
        while gate() {
            match queue.claim_next() {
                Ok(Some(row)) => run_job(&queue, &row, &processor, &on_change),
                Ok(None) => break,
                Err(e) => {
                    log::error!("clip worker could not select a job: {e:#}");
                    break;
                }
            }
        }
    }
}

fn run_job(queue: &Queue, row: &ClipRow, processor: &Processor, on_change: &OnChange) {
    let id = row.id;
    on_change(id);
    log::info!("encoding clip {id} ({})", row.source_path);

    let outcome = match catch_unwind(AssertUnwindSafe(|| processor(row))) {
        Ok(result) => result,
        Err(payload) => Err(anyhow!("processor panicked: {}", panic_message(&payload))),
    };

    let written = match outcome {
        Ok(out) => queue.mark_encoded(id, &out),
        Err(e) => {
            let text = format!("{e:#}");
            log::error!("clip {id} failed: {text}");
            queue.mark_failed(id, &text)
        }
    };
    if let Err(e) = written {
        log::error!("clip worker could not update clip {id}: {e:#}");
    }
    on_change(id);
}

fn panic_message(payload: &Box<dyn std::any::Any + Send>) -> String {
    if let Some(s) = payload.downcast_ref::<&str>() {
        (*s).to_string()
    } else if let Some(s) = payload.downcast_ref::<String>() {
        s.clone()
    } else {
        "unknown panic".to_string()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::time::Instant;

    fn temp_db() -> PathBuf {
        static COUNTER: AtomicUsize = AtomicUsize::new(0);
        let n = COUNTER.fetch_add(1, Ordering::Relaxed);
        std::env::temp_dir().join(format!(
            "cos-nostra-queue-test-{}-{}-{}.db",
            std::process::id(),
            n,
            Utc::now().timestamp_nanos_opt().unwrap_or(0)
        ))
    }

    fn clip(name: &str, recorded_at: &str) -> NewClip {
        NewClip {
            source_path: format!("C:\\clips\\{name}.mkv"),
            game: Some("Game".into()),
            title: None,
            recorded_at: recorded_at.into(),
            duration_ms: 30_000,
            width: 1920,
            height: 1080,
            size_source: 12_345,
        }
    }

    fn wait_until(queue: &Queue, id: i64, pred: impl Fn(&ClipRow) -> bool) -> ClipRow {
        let deadline = Instant::now() + Duration::from_secs(10);
        loop {
            let row = queue.get(id).unwrap().expect("row exists");
            if pred(&row) {
                return row;
            }
            assert!(Instant::now() < deadline, "timed out waiting; last row {row:?}");
            std::thread::sleep(Duration::from_millis(10));
        }
    }

    fn noop_change() -> OnChange {
        Arc::new(|_| {})
    }

    fn outputs() -> Outputs {
        Outputs {
            av1_path: "a.mp4".into(),
            h264_path: "h.mp4".into(),
            thumb_path: "t.jpg".into(),
            size_av1: 1,
            size_h264: 2,
        }
    }

    #[test]
    fn round_trip() {
        let q = Queue::open(&temp_db()).unwrap();
        let a = q.enqueue(clip("a", "2026-09-10T10:00:00.000Z")).unwrap();
        let b = q.enqueue(clip("b", "2026-09-10T11:00:00.000Z")).unwrap();
        let c = q.enqueue(clip("c", "2026-09-10T11:00:00.000Z")).unwrap();

        let ids: Vec<i64> = q.list().unwrap().iter().map(|r| r.id).collect();
        assert_eq!(ids, vec![c, b, a], "newest first by recorded_at then id");

        let row = q.get(a).unwrap().unwrap();
        assert_eq!(row.status, ClipStatus::Saved);
        assert_eq!(row.width, 1920);
        assert_eq!(row.attempts, 0);
        assert_eq!(row.game.as_deref(), Some("Game"));

        q.set_game(a, Some("Other")).unwrap();
        assert_eq!(q.get(a).unwrap().unwrap().game.as_deref(), Some("Other"));
        q.set_game(a, None).unwrap();
        assert_eq!(q.get(a).unwrap().unwrap().game, None);

        let deleted = q.delete(b).unwrap().unwrap();
        assert_eq!(deleted.id, b);
        assert!(q.get(b).unwrap().is_none());
        assert!(q.delete(b).unwrap().is_none());
        assert_eq!(q.list().unwrap().len(), 2);

        // Duplicate source paths are rejected.
        assert!(q.enqueue(clip("a", "2026-09-10T12:00:00.000Z")).is_err());
    }

    #[test]
    fn open_resets_encoding_rows() {
        let path = temp_db();
        let id = {
            let q = Queue::open(&path).unwrap();
            let id = q.enqueue(clip("x", "2026-09-10T10:00:00.000Z")).unwrap();
            q.lock()
                .execute(
                    "UPDATE clips SET status = 'encoding', attempts = 2 WHERE id = ?1",
                    params![id],
                )
                .unwrap();
            id
        };
        let q = Queue::open(&path).unwrap();
        let row = q.get(id).unwrap().unwrap();
        assert_eq!(row.status, ClipStatus::Saved);
        assert_eq!(row.attempts, 2, "attempts survive the reset");
    }

    #[test]
    fn backoff_doubles_and_caps() {
        let base = Duration::from_secs(30);
        let cap = Duration::from_secs(30 * 60);
        assert_eq!(backoff_with(base, cap, 1), Duration::from_secs(30));
        assert_eq!(backoff_with(base, cap, 2), Duration::from_secs(60));
        assert_eq!(backoff_with(base, cap, 3), Duration::from_secs(120));
        assert_eq!(backoff_with(base, cap, 4), Duration::from_secs(240));
        assert_eq!(backoff_with(base, cap, 7), Duration::from_secs(1800));
        assert_eq!(backoff_with(base, cap, 40), cap);
        assert_eq!(backoff_with(base, cap, 0), Duration::from_secs(30));
    }

    #[test]
    fn worker_retries_then_succeeds() {
        let q = Arc::new(Queue::open(&temp_db()).unwrap());
        let calls = Arc::new(AtomicUsize::new(0));
        let changes = Arc::new(AtomicUsize::new(0));
        let processor: Processor = {
            let calls = Arc::clone(&calls);
            Arc::new(move |_row| {
                let n = calls.fetch_add(1, Ordering::SeqCst);
                if n < 2 {
                    anyhow::bail!("boom {n}")
                }
                Ok(outputs())
            })
        };
        let on_change: OnChange = {
            let changes = Arc::clone(&changes);
            Arc::new(move |_| {
                changes.fetch_add(1, Ordering::SeqCst);
            })
        };
        let worker = start_worker(Arc::clone(&q), processor, Arc::new(|| true), on_change);

        let id = q.enqueue(clip("w", "2026-09-10T10:00:00.000Z")).unwrap();
        worker.wake();

        let failed = wait_until(&q, id, |r| r.status == ClipStatus::Failed);
        assert_eq!(failed.attempts, 1);
        assert_eq!(failed.error.as_deref(), Some("boom 0"));
        assert!(q.next_attempt_at(id).unwrap().is_some());

        let done = wait_until(&q, id, |r| r.status == ClipStatus::Encoded);
        assert_eq!(done.attempts, 2, "two failures before success");
        assert_eq!(done.error, None);
        assert_eq!(done.av1_path.as_deref(), Some("a.mp4"));
        assert_eq!(done.size_h264, Some(2));
        assert_eq!(q.next_attempt_at(id).unwrap(), None);
        assert_eq!(calls.load(Ordering::SeqCst), 3);
        assert_eq!(changes.load(Ordering::SeqCst), 6, "two on_change per run");
    }

    #[test]
    fn worker_survives_panic() {
        let q = Arc::new(Queue::open(&temp_db()).unwrap());
        let calls = Arc::new(AtomicUsize::new(0));
        let processor: Processor = {
            let calls = Arc::clone(&calls);
            Arc::new(move |_row| {
                if calls.fetch_add(1, Ordering::SeqCst) == 0 {
                    panic!("kaboom");
                }
                Ok(outputs())
            })
        };
        let worker = start_worker(Arc::clone(&q), processor, Arc::new(|| true), noop_change());
        let id = q.enqueue(clip("p", "2026-09-10T10:00:00.000Z")).unwrap();
        worker.wake();
        let failed = wait_until(&q, id, |r| r.status == ClipStatus::Failed);
        assert_eq!(failed.error.as_deref(), Some("processor panicked: kaboom"));
        wait_until(&q, id, |r| r.status == ClipStatus::Encoded);
    }

    #[test]
    fn closed_gate_keeps_row_saved() {
        let q = Arc::new(Queue::open(&temp_db()).unwrap());
        let calls = Arc::new(AtomicUsize::new(0));
        let processor: Processor = {
            let calls = Arc::clone(&calls);
            Arc::new(move |_row| {
                calls.fetch_add(1, Ordering::SeqCst);
                Ok(outputs())
            })
        };
        let worker = start_worker(Arc::clone(&q), processor, Arc::new(|| false), noop_change());
        let id = q.enqueue(clip("g", "2026-09-10T10:00:00.000Z")).unwrap();
        worker.wake();
        std::thread::sleep(POLL_INTERVAL * 6);
        assert_eq!(q.get(id).unwrap().unwrap().status, ClipStatus::Saved);
        assert_eq!(calls.load(Ordering::SeqCst), 0);
    }

    #[test]
    fn max_attempts_then_manual_retry() {
        let q = Arc::new(Queue::open(&temp_db()).unwrap());
        let calls = Arc::new(AtomicUsize::new(0));
        let processor: Processor = {
            let calls = Arc::clone(&calls);
            Arc::new(move |_row| {
                calls.fetch_add(1, Ordering::SeqCst);
                anyhow::bail!("always")
            })
        };
        let worker = start_worker(Arc::clone(&q), processor, Arc::new(|| true), noop_change());
        let id = q.enqueue(clip("m", "2026-09-10T10:00:00.000Z")).unwrap();
        worker.wake();

        let exhausted = wait_until(&q, id, |r| r.attempts >= MAX_ATTEMPTS);
        assert_eq!(exhausted.status, ClipStatus::Failed);
        assert_eq!(exhausted.attempts, MAX_ATTEMPTS);
        assert_eq!(q.next_attempt_at(id).unwrap(), None);

        // Nothing more happens without a manual retry.
        std::thread::sleep(POLL_INTERVAL * 6);
        assert_eq!(calls.load(Ordering::SeqCst), MAX_ATTEMPTS as usize);
        assert_eq!(q.get(id).unwrap().unwrap().attempts, MAX_ATTEMPTS);

        q.retry(id).unwrap();
        // retry may have already been picked up; either saved/encoding or failed with 1 attempt.
        let after = wait_until(&q, id, |r| r.attempts < MAX_ATTEMPTS);
        assert!(after.attempts <= 1, "attempts reset by retry, got {after:?}");
        worker.wake();
        let again = wait_until(&q, id, |r| r.status == ClipStatus::Failed && r.attempts == 1);
        assert_eq!(again.error.as_deref(), Some("always"));
        assert!(q.next_attempt_at(id).unwrap().is_some());
    }

    #[test]
    fn retry_ignores_non_failed_rows() {
        let q = Queue::open(&temp_db()).unwrap();
        let id = q.enqueue(clip("r", "2026-09-10T10:00:00.000Z")).unwrap();
        q.lock()
            .execute(
                "UPDATE clips SET status = 'encoded', attempts = 3 WHERE id = ?1",
                params![id],
            )
            .unwrap();
        q.retry(id).unwrap();
        let row = q.get(id).unwrap().unwrap();
        assert_eq!(row.status, ClipStatus::Encoded);
        assert_eq!(row.attempts, 3);
    }

    #[test]
    fn error_text_is_truncated() {
        let q = Queue::open(&temp_db()).unwrap();
        let id = q.enqueue(clip("t", "2026-09-10T10:00:00.000Z")).unwrap();
        q.mark_failed(id, &"x".repeat(5000)).unwrap();
        let row = q.get(id).unwrap().unwrap();
        assert_eq!(row.error.map(|e| e.chars().count()), Some(MAX_ERROR_CHARS));
        assert_eq!(row.status, ClipStatus::Failed);
        assert_eq!(row.attempts, 1);
    }
}
