//! Clip job queue on SQLite under %APPDATA%\Cos Nostra\clips.db, plus the worker thread that
//! drains it. States: saved -> encoding -> encoded -> uploading -> done, or failed. The `stage`
//! column says which step failed so a retry resumes at encode or upload. Failed jobs retry with
//! exponential backoff up to `MAX_ATTEMPTS`, after which they wait for a manual retry. The queue
//! survives restarts: an `encoding` row found at open time is put back to `saved`, an
//! `uploading` one back to `encoded`.
//!
//! Only rows with `publish = 1` move at all. Everything the hotkey or a match saves starts as a
//! local clip (`saved`, `publish = 0`) and stays exactly there, unencoded, until the user
//! presses Publish; the worker never so much as looks at it.

use std::collections::HashMap;
use std::panic::{catch_unwind, AssertUnwindSafe};
use std::path::Path;
use std::sync::{Arc, Condvar, Mutex, MutexGuard};
use std::time::Duration;

use anyhow::{anyhow, bail, Context, Result};
use chrono::{DateTime, SecondsFormat, Utc};
use rusqlite::{params, Connection, OptionalExtension, Row};
use serde::{Deserialize, Serialize};

use crate::ffmpeg::Segment;

pub const MAX_ATTEMPTS: i32 = 5;

/// Current schema, stored in `PRAGMA user_version` so later phases can migrate.
/// 1: initial. 2: `stage`, `remote_id`, `page_url` for uploads. 3: `fps`, which the player
/// needs to step a frame at a time. 4: `cut`, the kept parts the editor chose.
/// 5: `participants`, JSON array of Discord user ids seen in the owner's voice channel at
/// capture time. 6: publish on demand: `publish`, `publish_guilds`, `publish_title`, the
/// `posts` cache, and `captured_at`, which places a clip on the match it was taken in.
const SCHEMA_VERSION: i32 = 6;

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

/// Which step a row is in (or failed at).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Stage {
    Encode,
    Upload,
}

impl Stage {
    pub fn as_str(self) -> &'static str {
        match self {
            Stage::Encode => "encode",
            Stage::Upload => "upload",
        }
    }

    fn parse(s: &str) -> Option<Self> {
        Some(match s {
            "encode" => Stage::Encode,
            "upload" => Stage::Upload,
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
    /// Frames per second the source was captured at, as `ffmpeg::probe` read it.
    pub fps: f64,
    pub size_source: i64,
    /// Discord ids who were in the owner's voice channel when the clip was taken. Always
    /// `None` at insert time: the snapshot is fetched from the backend on its own thread and
    /// written later with `set_participants`, so a slow or missing backend never delays the
    /// row appearing in the UI.
    pub participants: Option<Vec<String>>,
    /// RFC 3339 UTC wall-clock time of the first frame of `source_path`. `None` only when the
    /// caller has no idea, which keeps the clip off every match timeline.
    pub captured_at: Option<String>,
}

/// One live Discord post of a clip, as `GET /me/posts` last reported it. Cached on the row so
/// the library can draw server icons without asking the backend for every card.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ClipPost {
    pub guild_id: String,
    pub name: Option<String>,
    pub icon_url: Option<String>,
    pub message_url: String,
    pub posted_at: String,
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
    pub stage: Stage,
    /// Backend clip id once uploaded.
    pub remote_id: Option<String>,
    /// Public player page once uploaded.
    pub page_url: Option<String>,
    /// Capture frame rate. `None` on clips saved before the column existed, which is why the
    /// player falls back to a sensible step when it frame-steps.
    pub fps: Option<f64>,
    /// The parts of the original recording the editor chose to keep, in order. `None` is the
    /// whole recording. Measured against `source_path`; once that file is gone and a cut has
    /// been baked into the outputs, the processor clears this so the next edit starts fresh.
    pub cut: Option<Vec<Segment>>,
    /// Discord ids of everyone in the owner's voice channel at the moment the clip was taken,
    /// so the bot can mention them when it posts. `None` on a clip saved before the column
    /// existed, on one whose snapshot has not landed yet, and on one whose lookup failed —
    /// all of which read the same as "nobody to mention" by the time the clip uploads.
    pub participants: Option<Vec<String>>,
    /// When the row last changed. The UI keys its thumbnail cache on it, since a re-encode
    /// rewrites the thumbnail in place under the same path.
    pub updated_at: String,
    /// The user asked for this clip to be published. The worker encodes and uploads only
    /// these; a row without it is a local clip, whatever its status says.
    pub publish: bool,
    /// Discord guild ids chosen in the publish dialog (and any added later). `None` on a clip
    /// published before the dialog existed.
    pub publish_guilds: Option<Vec<String>>,
    /// The title typed in the publish dialog.
    pub publish_title: Option<String>,
    /// RFC 3339 UTC time of the first frame of `source_path`. Together with `cut` (or the whole
    /// `duration_ms` when there is none) it is where the clip sits in wall-clock time, which
    /// is how it is found on a match. When the recording is gone and an encoded copy is what is
    /// left, that copy starts `cut[0].start_ms` later; see `edit::file_start`.
    pub captured_at: Option<String>,
    /// Live Discord posts, from the last `GET /me/posts`. Empty for a clip nobody posted.
    pub posts: Vec<ClipPost>,
}

/// Files the processor produced for a clip.
#[derive(Debug, Clone)]
pub struct Outputs {
    pub av1_path: String,
    pub h264_path: String,
    pub thumb_path: String,
    pub size_av1: i64,
    pub size_h264: i64,
    /// Length of what was written, when a cut made it differ from the recording. `None`
    /// leaves the row's duration alone.
    pub duration_ms: Option<i64>,
}

/// What the uploader hands back for a finished upload.
#[derive(Debug, Clone)]
pub struct UploadResult {
    pub remote_id: String,
    pub page_url: String,
}

/// Attached by the uploader (with `.context(Refused(..))`) to a failure that retrying cannot
/// fix: the backend turned the clip down on its merits rather than failing to hear it. The
/// same three files will be refused again in thirty seconds and in thirty minutes, so the row
/// parks as `failed` with no next attempt instead of grinding through all `MAX_ATTEMPTS`. The
/// Retry button still works, which is the point — the user fixes the cause (frees quota) and
/// asks again. The inner string is the whole of what the user is told, so write it for them.
#[derive(Debug, Clone, Copy)]
pub struct Refused(pub &'static str);

impl std::fmt::Display for Refused {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.0)
    }
}

/// True when a `Refused` sits anywhere in the chain. `anyhow`'s downcast searches through
/// every `.context()` layer, so the marker survives the contexts added above it.
pub fn is_refused(e: &anyhow::Error) -> bool {
    e.downcast_ref::<Refused>().is_some()
}

/// Does the encoding work for one clip. Runs on the worker thread.
pub type Processor = Arc<dyn Fn(&ClipRow) -> Result<Outputs> + Send + Sync>;
/// Uploads one encoded clip. Runs on the worker thread.
pub type Uploader = Arc<dyn Fn(&ClipRow) -> Result<UploadResult> + Send + Sync>;
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
    fps REAL,
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
    updated_at TEXT NOT NULL,
    stage TEXT NOT NULL DEFAULT 'encode',
    remote_id TEXT,
    page_url TEXT,
    cut TEXT,
    participants TEXT,
    publish INTEGER NOT NULL DEFAULT 0,
    publish_guilds TEXT,
    publish_title TEXT,
    captured_at TEXT,
    posts TEXT
);
CREATE INDEX IF NOT EXISTS clips_status ON clips(status);
";

/// Columns added after version 1, applied with ALTER TABLE to databases that predate them.
/// Every one is nullable or has a default; `migrate_to_publish_on_demand` backfills the two
/// whose default would be wrong for an existing row.
const ADDED_COLUMNS: [(&str, &str); 11] = [
    ("stage", "TEXT NOT NULL DEFAULT 'encode'"),
    ("remote_id", "TEXT"),
    ("page_url", "TEXT"),
    ("fps", "REAL"),
    ("cut", "TEXT"),
    ("participants", "TEXT"),
    ("publish", "INTEGER NOT NULL DEFAULT 0"),
    ("publish_guilds", "TEXT"),
    ("publish_title", "TEXT"),
    ("captured_at", "TEXT"),
    ("posts", "TEXT"),
];

/// Column list shared by every SELECT so `row_from` stays in sync.
const COLUMNS: &str = "id, source_path, game, title, recorded_at, duration_ms, width, height, \
    size_source, size_av1, size_h264, av1_path, h264_path, thumb_path, status, error, attempts, \
    stage, remote_id, page_url, fps, cut, updated_at, participants, publish, publish_guilds, \
    publish_title, captured_at, posts";

/// A new recording for a clip, after the editor widened it past the file it had: the copy
/// taken out of the match (or out of the encoded copy) that replaces `source_path`.
#[derive(Debug, Clone)]
pub struct Rebased {
    pub source_path: String,
    /// RFC 3339 UTC time of the new file's first frame.
    pub captured_at: String,
    /// The range inside the new file. `None` when it is the whole file.
    pub cut: Option<Vec<Segment>>,
    pub duration_ms: i64,
    pub size_source: i64,
    pub width: u32,
    pub height: u32,
    pub fps: f64,
    /// A thumbnail already written for the new file, if one could be.
    pub thumb_path: Option<String>,
}

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
            if version >= 1 {
                // An older table already exists; the CREATE above did not add the new columns.
                add_missing_columns(&conn)?;
                if version < 6 {
                    migrate_to_publish_on_demand(&conn)?;
                }
            }
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
        let reset = conn
            .execute(
                "UPDATE clips SET status = 'encoded', updated_at = ?1 WHERE status = 'uploading'",
                params![now_rfc3339()],
            )
            .context("resetting interrupted uploads")?;
        if reset > 0 {
            log::warn!("reset {reset} interrupted upload job(s) to encoded");
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
        self.insert(clip, None)
    }

    /// Inserts a `saved` row that already carries a cut, for a clip taken out of a longer
    /// recording. One statement, so the worker never sees the row without its cut.
    pub fn enqueue_with_cut(&self, clip: NewClip, cut: &[Segment]) -> Result<i64> {
        self.insert(clip, Some(cut))
    }

    fn insert(&self, clip: NewClip, cut: Option<&[Segment]>) -> Result<i64> {
        let cut = cut
            .filter(|c| !c.is_empty())
            .map(serde_json::to_string)
            .transpose()
            .context("encoding cut")?;
        // Normally absent: the voice snapshot arrives after the row does. Honoured anyway so a
        // caller that already has one does not silently lose it.
        let participants = clip
            .participants
            .as_deref()
            .filter(|p| !p.is_empty())
            .map(serde_json::to_string)
            .transpose()
            .context("encoding participants")?;
        let now = now_rfc3339();
        let conn = self.lock();
        // `publish` is left at its default: every new clip is a local one.
        conn.execute(
            "INSERT INTO clips (source_path, game, title, recorded_at, duration_ms, width, height, \
             fps, size_source, status, attempts, created_at, updated_at, cut, participants, \
             captured_at) \
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, 'saved', 0, ?10, ?10, ?11, ?12, ?13)",
            params![
                clip.source_path,
                clip.game,
                clip.title,
                clip.recorded_at,
                clip.duration_ms,
                clip.width,
                clip.height,
                clip.fps,
                clip.size_source,
                now,
                cut,
                participants,
                clip.captured_at,
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

    /// Forgets the local AV1 and H.264 outputs of a clip whose files the caller removed. The
    /// row, its thumbnail, its recorded sizes and its upload link stay, so the clip is still
    /// listed and still watchable through the site; `av1_path` being null is how the UI knows
    /// there is nothing left here to open. Only ever called for clips the backend has.
    pub fn clear_local_video(&self, id: i64) -> Result<()> {
        let conn = self.lock();
        conn.execute(
            "UPDATE clips SET av1_path = NULL, h264_path = NULL, updated_at = ?2 WHERE id = ?1",
            params![id, now_rfc3339()],
        )
        .with_context(|| format!("clearing local video of clip {id}"))?;
        Ok(())
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

    /// Moves every clip of one game to another name, and returns how many moved. `None` on
    /// either side is the "no game detected" pile, which is why the match cannot just be
    /// `game = ?1`. Renaming onto a name that already exists merges the two.
    pub fn rename_game(&self, from: Option<&str>, to: Option<&str>) -> Result<usize> {
        let conn = self.lock();
        let changed = conn
            .execute(
                "UPDATE clips SET game = ?2, updated_at = ?3 WHERE game IS ?1",
                params![from, to, now_rfc3339()],
            )
            .with_context(|| format!("renaming game {from:?} to {to:?}"))?;
        Ok(changed)
    }

    /// Sends a clip back through the encoder with a new cut (`None` for the whole recording),
    /// from wherever it was: an encoded or uploaded clip is re-encoded and, when the site
    /// already has it, re-uploaded in place. Refused while a job is running on the clip, since
    /// the worker would be writing the outputs this one is about to replace.
    pub fn request_reencode(&self, id: i64, cut: Option<&[Segment]>) -> Result<()> {
        let json = cut
            .map(serde_json::to_string)
            .transpose()
            .context("encoding cut")?;
        let mut conn = self.lock();
        let tx = conn.transaction().context("starting re-encode transaction")?;
        let status: Option<String> = tx
            .query_row("SELECT status FROM clips WHERE id = ?1", params![id], |r| r.get(0))
            .optional()
            .with_context(|| format!("reading clip {id}"))?;
        match status.as_deref() {
            None => bail!("clip {id} not found"),
            Some("encoding") | Some("uploading") => {
                bail!("this clip is busy right now; wait for the current job to finish")
            }
            Some(_) => {}
        }
        tx.execute(
            "UPDATE clips SET cut = ?2, status = 'saved', stage = 'encode', attempts = 0, \
             error = NULL, next_attempt_at = NULL, updated_at = ?3 WHERE id = ?1",
            params![id, json, now_rfc3339()],
        )
        .with_context(|| format!("requesting re-encode of clip {id}"))?;
        tx.commit().context("committing re-encode request")?;
        Ok(())
    }

    /// Forgets a clip's cut after it was baked into the outputs from a file that no longer
    /// exists as the original, so the segments are not applied twice. The new copy starts
    /// where the cut did, so `captured_at` moves forward by `shift_ms` to keep placing the
    /// clip where it really is.
    pub fn bake_cut(&self, id: i64, shift_ms: i64) -> Result<()> {
        let conn = self.lock();
        let captured: Option<String> = conn
            .query_row("SELECT captured_at FROM clips WHERE id = ?1", params![id], |r| r.get(0))
            .optional()
            .with_context(|| format!("reading clip {id}"))?
            .flatten();
        let moved = captured
            .as_deref()
            .and_then(|c| DateTime::parse_from_rfc3339(c).ok())
            .map(|c| format_rfc3339(c.with_timezone(&Utc) + chrono::Duration::milliseconds(shift_ms)));
        conn.execute(
            "UPDATE clips SET cut = NULL, captured_at = COALESCE(?3, captured_at), updated_at = ?2 \
             WHERE id = ?1",
            params![id, now_rfc3339(), moved],
        )
        .with_context(|| format!("clearing cut of clip {id}"))?;
        Ok(())
    }

    /// Records the thumbnail written for a clip that has not been encoded. Bumps `updated_at`
    /// on purpose: the UI caches thumbnails by path and `updated_at`, and a range change
    /// rewrites the file under the same path.
    pub fn set_thumb(&self, id: i64, path: &str) -> Result<()> {
        let conn = self.lock();
        conn.execute(
            "UPDATE clips SET thumb_path = ?2, updated_at = ?3 WHERE id = ?1",
            params![id, path, now_rfc3339()],
        )
        .with_context(|| format!("setting thumbnail of clip {id}"))?;
        Ok(())
    }

    /// Marks a clip for publishing with what the dialog chose, and lets the worker at it.
    ///
    /// A `saved` row gets encoded then uploaded. An `encoded` one (a clip from before publish
    /// on demand, which encoded but never went up) goes straight to upload, since an edit of a
    /// local clip always throws stale outputs away; unless its outputs have gone missing, in
    /// which case it encodes again. A failed row starts over at the stage it failed in.
    pub fn publish(
        &self,
        id: i64,
        title: Option<&str>,
        game: Option<&str>,
        guild_ids: &[String],
    ) -> Result<()> {
        let guilds = serde_json::to_string(guild_ids).context("encoding guild ids")?;
        let mut conn = self.lock();
        let tx = conn.transaction().context("starting publish transaction")?;
        let row = get_in(&tx, id)?.with_context(|| format!("clip {id} not found"))?;
        if row.remote_id.is_some() {
            bail!("this clip is already published");
        }
        if row.publish && matches!(row.status, ClipStatus::Encoding | ClipStatus::Uploading) {
            bail!("this clip is already being published");
        }
        let outputs_here = [&row.av1_path, &row.h264_path, &row.thumb_path]
            .into_iter()
            .all(|p| p.as_deref().is_some_and(|p| Path::new(p).is_file()));
        let status = match row.status {
            ClipStatus::Failed if row.stage == Stage::Upload && outputs_here => "encoded",
            ClipStatus::Failed => "saved",
            ClipStatus::Encoded if !outputs_here => "saved",
            other => other.as_str(),
        };
        let restart = status != row.status.as_str() || row.status == ClipStatus::Failed;
        tx.execute(
            "UPDATE clips SET publish = 1, publish_title = ?2, game = ?3, publish_guilds = ?4, \
             status = ?5, \
             stage = CASE WHEN ?5 = 'saved' THEN 'encode' ELSE stage END, \
             attempts = CASE WHEN ?6 THEN 0 ELSE attempts END, \
             error = CASE WHEN ?6 THEN NULL ELSE error END, \
             next_attempt_at = NULL, updated_at = ?7 WHERE id = ?1",
            params![id, title, game, guilds, status, restart, now_rfc3339()],
        )
        .with_context(|| format!("publishing clip {id}"))?;
        tx.commit().context("committing publish")?;
        Ok(())
    }

    /// First half of unpublishing: stops the worker from touching the clip (by clearing
    /// `publish`) before the backend is asked to delete it, so an encode cannot start between
    /// the check and the request. Refused while a job is already running. Returns the row as
    /// it was, for its `remote_id`.
    pub fn begin_unpublish(&self, id: i64) -> Result<ClipRow> {
        let mut conn = self.lock();
        let tx = conn.transaction().context("starting unpublish transaction")?;
        let row = get_in(&tx, id)?.with_context(|| format!("clip {id} not found"))?;
        if matches!(row.status, ClipStatus::Encoding | ClipStatus::Uploading) {
            bail!("this clip is busy right now; wait for the current job to finish");
        }
        // The Storage tab releases a published clip's local video, leaving the site as the only
        // copy. Deleting that copy is what "delete everywhere" is for, not unpublish.
        let video_here = [Some(&row.source_path), row.av1_path.as_ref(), row.h264_path.as_ref()]
            .into_iter()
            .flatten()
            .any(|p| Path::new(p).is_file());
        if row.remote_id.is_some() && !video_here {
            bail!("this clip's video is only on the site now, so unpublishing would lose it; delete it everywhere instead");
        }
        tx.execute("UPDATE clips SET publish = 0 WHERE id = ?1", params![id])
            .with_context(|| format!("holding clip {id}"))?;
        tx.commit().context("committing unpublish hold")?;
        Ok(row)
    }

    /// Puts `publish` back after the backend refused an unpublish, so the clip is exactly as
    /// published as it was.
    pub fn restore_publish(&self, id: i64, publish: bool) -> Result<()> {
        let conn = self.lock();
        conn.execute("UPDATE clips SET publish = ?2 WHERE id = ?1", params![id, publish])
            .with_context(|| format!("restoring clip {id}"))?;
        Ok(())
    }

    /// Second half: the site has let go, so the clip becomes local again. Its files all stay.
    /// It rests as `encoded` while both encoded copies are still here (a later Publish uploads
    /// them without encoding again) and as `saved` otherwise.
    pub fn finish_unpublish(&self, id: i64) -> Result<()> {
        let mut conn = self.lock();
        let tx = conn.transaction().context("starting unpublish transaction")?;
        let row = get_in(&tx, id)?.with_context(|| format!("clip {id} not found"))?;
        let outputs_here = [&row.av1_path, &row.h264_path]
            .into_iter()
            .all(|p| p.as_deref().is_some_and(|p| Path::new(p).is_file()));
        tx.execute(
            "UPDATE clips SET publish = 0, remote_id = NULL, page_url = NULL, posts = NULL, \
             status = ?2, stage = 'encode', attempts = 0, error = NULL, next_attempt_at = NULL, \
             updated_at = ?3 WHERE id = ?1",
            params![id, if outputs_here { "encoded" } else { "saved" }, now_rfc3339()],
        )
        .with_context(|| format!("unpublishing clip {id}"))?;
        tx.commit().context("committing unpublish")?;
        Ok(())
    }

    /// Adds guild ids to the ones the clip was published to, for the "post to more" action.
    pub fn add_publish_guilds(&self, id: i64, guild_ids: &[String]) -> Result<()> {
        let mut conn = self.lock();
        let tx = conn.transaction().context("starting guilds transaction")?;
        let row = get_in(&tx, id)?.with_context(|| format!("clip {id} not found"))?;
        let mut all = row.publish_guilds.unwrap_or_default();
        for g in guild_ids {
            if !all.contains(g) {
                all.push(g.clone());
            }
        }
        tx.execute(
            "UPDATE clips SET publish_guilds = ?2 WHERE id = ?1",
            params![id, serde_json::to_string(&all).context("encoding guild ids")?],
        )
        .with_context(|| format!("adding guilds to clip {id}"))?;
        tx.commit().context("committing guilds")?;
        Ok(())
    }

    /// Replaces every published clip's posts cache with what the backend reported, keyed by
    /// `remote_id`; a clip missing from the map has no live posts. Returns the ids whose cache
    /// actually changed. `updated_at` is left alone: it keys the thumbnail cache, and a
    /// refresh every five minutes would otherwise reload every published thumbnail.
    pub fn replace_posts(&self, by_remote: &HashMap<String, Vec<ClipPost>>) -> Result<Vec<i64>> {
        let mut conn = self.lock();
        let tx = conn.transaction().context("starting posts transaction")?;
        let current: Vec<(i64, Option<String>, Option<String>)> = {
            let mut stmt = tx
                .prepare("SELECT id, remote_id, posts FROM clips WHERE remote_id IS NOT NULL OR posts IS NOT NULL")
                .context("preparing posts read")?;
            let rows = stmt
                .query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))
                .context("reading posts")?
                .collect::<rusqlite::Result<_>>()
                .context("reading posts")?;
            rows
        };
        let mut changed = Vec::new();
        for (id, remote_id, posts) in current {
            let wanted = remote_id
                .as_ref()
                .and_then(|r| by_remote.get(r))
                .filter(|p| !p.is_empty())
                .map(serde_json::to_string)
                .transpose()
                .context("encoding posts")?;
            let have = posts
                .as_deref()
                .and_then(|json| serde_json::from_str::<Vec<ClipPost>>(json).ok())
                .filter(|p| !p.is_empty())
                .map(|p| serde_json::to_string(&p))
                .transpose()
                .context("encoding posts")?;
            if wanted != have {
                tx.execute("UPDATE clips SET posts = ?2 WHERE id = ?1", params![id, wanted])
                    .with_context(|| format!("caching posts of clip {id}"))?;
                changed.push(id);
            }
        }
        tx.commit().context("committing posts")?;
        Ok(changed)
    }

    /// A new range on the recording a local clip already has. The encoded copies (a clip from
    /// before publish on demand may have some) no longer match it, so their paths are
    /// forgotten and the row goes back to `saved`; the caller deletes the files. The length
    /// becomes the range's, since nothing will encode it and report one.
    pub fn set_local_cut(&self, id: i64, cut: Option<&[Segment]>, duration_ms: i64) -> Result<()> {
        let json = cut.map(serde_json::to_string).transpose().context("encoding cut")?;
        let mut conn = self.lock();
        let tx = conn.transaction().context("starting cut transaction")?;
        let row = get_in(&tx, id)?.with_context(|| format!("clip {id} not found"))?;
        if matches!(row.status, ClipStatus::Encoding | ClipStatus::Uploading) {
            bail!("this clip is busy right now; wait for the current job to finish");
        }
        if row.publish || row.remote_id.is_some() {
            bail!("a published clip is re-encoded, not cut in place");
        }
        tx.execute(
            "UPDATE clips SET cut = ?2, duration_ms = ?3, av1_path = NULL, h264_path = NULL, \
             size_av1 = NULL, size_h264 = NULL, status = 'saved', stage = 'encode', attempts = 0, \
             error = NULL, next_attempt_at = NULL, updated_at = ?4 WHERE id = ?1",
            params![id, json, duration_ms, now_rfc3339()],
        )
        .with_context(|| format!("cutting clip {id}"))?;
        tx.commit().context("committing cut")?;
        Ok(())
    }

    /// Points a clip at a new recording (see `Rebased`) and sends it back to `saved`. The old
    /// outputs belong to the old file's name, so their paths are forgotten; the caller deletes
    /// the files. A published clip is then encoded and replaced on the site by
    /// the worker; a local one just rests with its new range.
    pub fn rebase(&self, id: i64, new: &Rebased) -> Result<()> {
        let json = new
            .cut
            .as_deref()
            .filter(|c| !c.is_empty())
            .map(serde_json::to_string)
            .transpose()
            .context("encoding cut")?;
        let mut conn = self.lock();
        let tx = conn.transaction().context("starting rebase transaction")?;
        let status: Option<String> = tx
            .query_row("SELECT status FROM clips WHERE id = ?1", params![id], |r| r.get(0))
            .optional()
            .with_context(|| format!("reading clip {id}"))?;
        match status.as_deref() {
            None => bail!("clip {id} not found"),
            Some("encoding") | Some("uploading") => {
                bail!("this clip is busy right now; wait for the current job to finish")
            }
            Some(_) => {}
        }
        tx.execute(
            "UPDATE clips SET source_path = ?2, captured_at = ?3, cut = ?4, duration_ms = ?5, \
             size_source = ?6, width = ?7, height = ?8, fps = ?9, av1_path = NULL, h264_path = NULL, \
             size_av1 = NULL, size_h264 = NULL, thumb_path = ?11, status = 'saved', stage = 'encode', \
             attempts = 0, error = NULL, next_attempt_at = NULL, updated_at = ?10 WHERE id = ?1",
            params![
                id,
                new.source_path,
                new.captured_at,
                json,
                new.duration_ms,
                new.size_source,
                new.width,
                new.height,
                new.fps,
                now_rfc3339(),
                new.thumb_path,
            ],
        )
        .with_context(|| format!("pointing clip {id} at {}", new.source_path))?;
        tx.commit().context("committing rebase")?;
        Ok(())
    }

    /// Records who was in voice with the owner when the clip was taken. Written after the row
    /// exists, because the answer comes from the backend and the clip must not wait on it.
    /// An empty list is stored as such: "the lookup ran and found nobody".
    pub fn set_participants(&self, id: i64, participants: &[String]) -> Result<()> {
        let json = serde_json::to_string(participants).context("serializing participants")?;
        let conn = self.lock();
        conn.execute(
            "UPDATE clips SET participants = ?2, updated_at = ?3 WHERE id = ?1",
            params![id, json, now_rfc3339()],
        )
        .with_context(|| format!("setting participants on clip {id}"))?;
        Ok(())
    }

    /// Puts a `failed` clip back to the start of the stage it failed in (`saved` for encode,
    /// `encoded` for upload) with attempts reset.
    pub fn retry(&self, id: i64) -> Result<()> {
        let conn = self.lock();
        conn.execute(
            "UPDATE clips SET \
             status = CASE WHEN stage = 'upload' THEN 'encoded' ELSE 'saved' END, \
             attempts = 0, error = NULL, next_attempt_at = NULL, updated_at = ?2 \
             WHERE id = ?1 AND status = 'failed'",
            params![id, now_rfc3339()],
        )
        .with_context(|| format!("retrying clip {id}"))?;
        Ok(())
    }

    /// Atomically picks the oldest runnable encode job and marks it `encoding`. Only clips the
    /// user published: a local clip is never encoded.
    fn claim_next(&self) -> Result<Option<ClipRow>> {
        let now = now_rfc3339();
        let mut conn = self.lock();
        let tx = conn.transaction().context("starting claim transaction")?;
        let row = tx
            .query_row(
                &format!(
                    "SELECT {COLUMNS} FROM clips WHERE publish = 1 AND ( \
                     (status = 'saved' AND (next_attempt_at IS NULL OR next_attempt_at <= ?1)) \
                     OR (status = 'failed' AND stage = 'encode' AND attempts < ?2 \
                         AND next_attempt_at IS NOT NULL AND next_attempt_at <= ?1)) \
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
            "UPDATE clips SET status = 'encoding', stage = 'encode', next_attempt_at = NULL, \
             updated_at = ?2 WHERE id = ?1",
            params![row.id, now],
        )
        .with_context(|| format!("marking clip {} encoding", row.id))?;
        tx.commit().context("committing claim")?;
        row.status = ClipStatus::Encoding;
        row.stage = Stage::Encode;
        Ok(Some(row))
    }

    /// The oldest published `encoded` row, or an upload failure whose retry time has passed.
    /// Does not claim it; call `mark_uploading` next. An `encoded` local clip stays put.
    pub fn next_uploadable(&self) -> Result<Option<ClipRow>> {
        let conn = self.lock();
        conn.query_row(
            &format!(
                "SELECT {COLUMNS} FROM clips WHERE publish = 1 AND (status = 'encoded' \
                 OR (status = 'failed' AND stage = 'upload' AND attempts < ?2 \
                     AND next_attempt_at IS NOT NULL AND next_attempt_at <= ?1)) \
                 ORDER BY id ASC LIMIT 1"
            ),
            params![now_rfc3339(), MAX_ATTEMPTS],
            row_from,
        )
        .optional()
        .context("selecting next upload")
    }

    /// Marks a row `uploading`. Attempts restart at zero when the row comes fresh from encode.
    pub fn mark_uploading(&self, id: i64) -> Result<()> {
        let conn = self.lock();
        conn.execute(
            "UPDATE clips SET status = 'uploading', \
             attempts = CASE WHEN stage = 'encode' THEN 0 ELSE attempts END, \
             stage = 'upload', next_attempt_at = NULL, updated_at = ?2 WHERE id = ?1",
            params![id, now_rfc3339()],
        )
        .with_context(|| format!("marking clip {id} uploading"))?;
        Ok(())
    }

    pub fn mark_done(&self, id: i64, remote_id: &str, page_url: &str) -> Result<()> {
        let conn = self.lock();
        conn.execute(
            "UPDATE clips SET status = 'done', stage = 'upload', error = NULL, \
             next_attempt_at = NULL, remote_id = ?2, page_url = ?3, updated_at = ?4 WHERE id = ?1",
            params![id, remote_id, page_url, now_rfc3339()],
        )
        .with_context(|| format!("marking clip {id} done"))?;
        Ok(())
    }

    pub fn mark_upload_failed(&self, id: i64, error: &str) -> Result<()> {
        self.mark_failed_in(id, Stage::Upload, error, true)
    }

    /// Records an upload the backend refused outright (see `Refused`). Identical to
    /// `mark_upload_failed` except that no next attempt is scheduled, so the worker leaves
    /// the row alone until somebody presses Retry.
    pub fn mark_upload_refused(&self, id: i64, error: &str) -> Result<()> {
        self.mark_failed_in(id, Stage::Upload, error, false)
    }

    pub(crate) fn mark_encoded(&self, id: i64, out: &Outputs) -> Result<()> {
        let conn = self.lock();
        conn.execute(
            "UPDATE clips SET status = 'encoded', error = NULL, next_attempt_at = NULL, \
             av1_path = ?2, h264_path = ?3, thumb_path = ?4, size_av1 = ?5, size_h264 = ?6, \
             duration_ms = COALESCE(?8, duration_ms), updated_at = ?7 WHERE id = ?1",
            params![
                id,
                out.av1_path,
                out.h264_path,
                out.thumb_path,
                out.size_av1,
                out.size_h264,
                now_rfc3339(),
                out.duration_ms,
            ],
        )
        .with_context(|| format!("marking clip {id} encoded"))?;
        Ok(())
    }

    /// Records an encode failure, bumps attempts and schedules the next try (or none at the cap).
    pub(crate) fn mark_failed(&self, id: i64, error: &str) -> Result<()> {
        self.mark_failed_in(id, Stage::Encode, error, true)
    }

    /// `schedule_retry` false parks the row with no `next_attempt_at` however many attempts it
    /// has left, which is how a refused upload stops without pretending it ran out of tries.
    fn mark_failed_in(&self, id: i64, stage: Stage, error: &str, schedule_retry: bool) -> Result<()> {
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
        let next_attempt_at = if schedule_retry && attempts < MAX_ATTEMPTS {
            Some(format_rfc3339(now + backoff_for(attempts)))
        } else {
            None
        };
        tx.execute(
            "UPDATE clips SET status = 'failed', error = ?2, attempts = ?3, \
             next_attempt_at = ?4, updated_at = ?5, stage = ?6 WHERE id = ?1",
            params![id, error, attempts, next_attempt_at, format_rfc3339(now), stage.as_str()],
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

/// Adds whichever of the later columns this database does not have yet. Idempotent, so a
/// half-applied migration (crash between ALTERs) finishes on the next open.
fn add_missing_columns(conn: &Connection) -> Result<()> {
    let mut stmt = conn
        .prepare("PRAGMA table_info(clips)")
        .context("reading clips columns")?;
    let existing: Vec<String> = stmt
        .query_map([], |r| r.get::<_, String>(1))
        .context("listing clips columns")?
        .collect::<rusqlite::Result<_>>()
        .context("reading clips columns")?;
    for (name, decl) in ADDED_COLUMNS {
        if !existing.iter().any(|c| c == name) {
            conn.execute(&format!("ALTER TABLE clips ADD COLUMN {name} {decl}"), [])
                .with_context(|| format!("adding column {name}"))?;
            log::info!("clip queue: added column {name}");
        }
    }
    Ok(())
}

/// Version 6: clips publish on demand. Runs once, on the open that brings a database up to 6,
/// and is idempotent should it run twice. Nothing is deleted and nothing is re-encoded.
///
/// - A clip the site already has was, in effect, published: `publish = 1`, so a re-edit still
///   replaces it and a queued replace still runs. Every other clip becomes local, including
///   ones that were waiting to encode or had encoded but not uploaded; they stay that way
///   until someone presses Publish.
/// - `captured_at` is a best guess, since nothing recorded it: the replay buffer saved the
///   clip a moment before `recorded_at` was taken, so the recording started about its own
///   length earlier. The length of the recording is the row's duration, or the end of its cut
///   when the duration is already the cut length. Clips taken from a match before this build
///   stamped `recorded_at` at the clip's start rather than the file's end, so they land up to
///   a recording's length early; that is the "best effort".
fn migrate_to_publish_on_demand(conn: &Connection) -> Result<()> {
    let published = conn
        .execute("UPDATE clips SET publish = 1 WHERE remote_id IS NOT NULL", [])
        .context("marking uploaded clips published")?;
    let rows: Vec<(i64, String, i64, Option<String>)> = {
        let mut stmt = conn
            .prepare("SELECT id, recorded_at, duration_ms, cut FROM clips WHERE captured_at IS NULL")
            .context("reading clips to place")?;
        let rows = stmt
            .query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)))
            .context("reading clips to place")?
            .collect::<rusqlite::Result<_>>()
            .context("reading clips to place")?;
        rows
    };
    let mut placed = 0;
    for (id, recorded_at, duration_ms, cut) in rows {
        let Ok(recorded) = DateTime::parse_from_rfc3339(&recorded_at) else {
            continue;
        };
        let cut_end = cut
            .as_deref()
            .and_then(|json| serde_json::from_str::<Vec<Segment>>(json).ok())
            .and_then(|segments| segments.last().map(|s| s.end_ms))
            .unwrap_or(0);
        let length = duration_ms.max(cut_end).max(0);
        let captured = recorded.with_timezone(&Utc) - chrono::Duration::milliseconds(length);
        conn.execute(
            "UPDATE clips SET captured_at = ?2 WHERE id = ?1",
            params![id, format_rfc3339(captured)],
        )
        .with_context(|| format!("placing clip {id}"))?;
        placed += 1;
    }
    log::info!("clip queue: publish on demand; {published} uploaded clip(s) kept published, {placed} placed in time");
    Ok(())
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
    let stage_text: String = r.get(17)?;
    let cut = r
        .get::<_, Option<String>>(21)?
        .map(|json| serde_json::from_str::<Vec<Segment>>(&json))
        .transpose()
        .map_err(|e| {
            rusqlite::Error::FromSqlConversionFailure(21, rusqlite::types::Type::Text, Box::new(e))
        })?
        // An empty list would mean the same as no cut; keep one spelling.
        .filter(|segments| !segments.is_empty());
    // Unlike the cut, a broken participants list is not worth failing a row over: the clip is
    // still perfectly encodable and uploadable, only the mentions are lost, so junk reads as
    // no snapshot. An empty list is stored as no snapshot too, since both mention nobody.
    let participants = r
        .get::<_, Option<String>>(23)?
        .and_then(|json| serde_json::from_str::<Vec<String>>(&json).ok())
        .filter(|ids| !ids.is_empty());
    // Both are caches of choices made elsewhere, so junk reads as nothing rather than failing.
    let publish_guilds = r
        .get::<_, Option<String>>(25)?
        .and_then(|json| serde_json::from_str::<Vec<String>>(&json).ok());
    let posts = r
        .get::<_, Option<String>>(28)?
        .and_then(|json| serde_json::from_str::<Vec<ClipPost>>(&json).ok())
        .unwrap_or_default();
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
        stage: Stage::parse(&stage_text).ok_or_else(|| {
            rusqlite::Error::FromSqlConversionFailure(
                17,
                rusqlite::types::Type::Text,
                format!("unknown clip stage {stage_text:?}").into(),
            )
        })?,
        remote_id: r.get(18)?,
        page_url: r.get(19)?,
        fps: r.get(20)?,
        cut,
        participants,
        updated_at: r.get(22)?,
        publish: r.get::<_, i64>(24)? != 0,
        publish_guilds,
        publish_title: r.get(26)?,
        captured_at: r.get(27)?,
        posts,
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

/// Starts the worker thread. It polls every few seconds and whenever woken. Encode jobs first:
/// the oldest `saved` row whose retry time has passed is marked `encoding`, run through
/// `processor`, then marked `encoded` or `failed` (with backoff). Then upload jobs, when an
/// `uploader` is given and `upload_gate` is open (logged in): `encoded` rows go
/// `uploading` -> `done` or `failed`. Each gate is checked before every job.
pub fn start_worker(
    queue: Arc<Queue>,
    processor: Processor,
    gate: Gate,
    on_change: OnChange,
    uploader: Option<Uploader>,
    upload_gate: Gate,
) -> Worker {
    let inner = Arc::new(WorkerInner {
        woken: Mutex::new(false),
        cv: Condvar::new(),
    });
    let thread_inner = Arc::clone(&inner);
    let spawned = std::thread::Builder::new()
        .name("clip-worker".into())
        .spawn(move || {
            worker_loop(thread_inner, queue, processor, gate, on_change, uploader, upload_gate)
        });
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
    uploader: Option<Uploader>,
    upload_gate: Gate,
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
        let Some(uploader) = uploader.as_ref() else {
            continue;
        };
        while upload_gate() {
            match queue.next_uploadable() {
                Ok(Some(row)) => run_upload(&queue, &row, uploader, &on_change),
                Ok(None) => break,
                Err(e) => {
                    log::error!("clip worker could not select an upload: {e:#}");
                    break;
                }
            }
        }
    }
}

fn run_upload(queue: &Queue, row: &ClipRow, uploader: &Uploader, on_change: &OnChange) {
    let id = row.id;
    if let Err(e) = queue.mark_uploading(id) {
        log::error!("clip worker could not mark clip {id} uploading: {e:#}");
        return;
    }
    on_change(id);
    log::info!("uploading clip {id} ({})", row.source_path);
    let mut row = row.clone();
    row.status = ClipStatus::Uploading;
    row.stage = Stage::Upload;

    let outcome = match catch_unwind(AssertUnwindSafe(|| uploader(&row))) {
        Ok(result) => result,
        Err(payload) => Err(anyhow!("uploader panicked: {}", panic_message(&payload))),
    };

    let written = match outcome {
        Ok(done) => {
            log::info!("clip {id} uploaded: {}", done.page_url);
            queue.mark_done(id, &done.remote_id, &done.page_url)
        }
        Err(e) if is_refused(&e) => {
            let text = format!("{e:#}");
            log::error!("clip {id} refused by the backend, not retrying: {text}");
            queue.mark_upload_refused(id, &text)
        }
        Err(e) => {
            let text = format!("{e:#}");
            log::error!("clip {id} upload failed: {text}");
            queue.mark_upload_failed(id, &text)
        }
    };
    if let Err(e) = written {
        log::error!("clip worker could not update clip {id}: {e:#}");
    }
    on_change(id);
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
            fps: 60.0,
            size_source: 12_345,
            participants: None,
            captured_at: None,
        }
    }

    /// A clip the user pressed Publish on, which is the only kind the worker touches.
    fn published(q: &Queue, name: &str) -> i64 {
        let id = q.enqueue(clip(name, "2026-09-10T10:00:00.000Z")).unwrap();
        q.publish(id, None, None, &[]).unwrap();
        id
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
            duration_ms: None,
        }
    }

    fn seg(start_ms: i64, end_ms: i64) -> Segment {
        Segment { start_ms, end_ms }
    }

    /// The editor's path: a finished clip goes back to `saved` carrying its cut, the encode
    /// records the shorter length, and a clip mid-job is refused.
    #[test]
    fn reencode_request_carries_the_cut_and_is_refused_mid_job() {
        let q = Queue::open(&temp_db()).unwrap();
        let id = q.enqueue(clip("c", "2026-09-10T10:00:00.000Z")).unwrap();
        q.mark_encoded(id, &outputs()).unwrap();
        q.mark_uploading(id).unwrap();
        q.mark_done(id, "r1", "https://x/c/r1").unwrap();
        let before = q.get(id).unwrap().unwrap();
        assert_eq!(before.cut, None);

        let cut = vec![seg(1_000, 5_000), seg(9_000, 12_000)];
        q.request_reencode(id, Some(&cut)).unwrap();
        let row = q.get(id).unwrap().unwrap();
        assert_eq!(row.status, ClipStatus::Saved);
        assert_eq!(row.stage, Stage::Encode);
        assert_eq!(row.attempts, 0);
        assert_eq!(row.cut, Some(cut.clone()));
        assert_eq!(row.remote_id.as_deref(), Some("r1"), "the site's copy is still known");
        assert_eq!(row.av1_path.as_deref(), Some("a.mp4"), "old outputs stay until replaced");
        assert!(row.updated_at >= before.updated_at);

        // The encode that applies it records the new length; a plain encode leaves it alone.
        q.mark_encoded(id, &Outputs { duration_ms: Some(7_000), ..outputs() }).unwrap();
        let row = q.get(id).unwrap().unwrap();
        assert_eq!(row.duration_ms, 7_000);
        assert_eq!(row.cut, Some(cut), "the cut stays for the next edit of the original");
        q.mark_encoded(id, &outputs()).unwrap();
        assert_eq!(q.get(id).unwrap().unwrap().duration_ms, 7_000);

        // Baked from a copy: the cut is consumed.
        q.bake_cut(id, 0).unwrap();
        assert_eq!(q.get(id).unwrap().unwrap().cut, None);

        // Back to the whole recording is a re-encode too.
        q.request_reencode(id, None).unwrap();
        let row = q.get(id).unwrap().unwrap();
        assert_eq!(row.status, ClipStatus::Saved);
        assert_eq!(row.cut, None);

        for busy in ["encoding", "uploading"] {
            q.lock()
                .execute("UPDATE clips SET status = ?2 WHERE id = ?1", params![id, busy])
                .unwrap();
            let err = q.request_reencode(id, None).unwrap_err();
            assert!(format!("{err:#}").contains("busy"), "{busy}: {err:#}");
        }
        assert!(q.request_reencode(9999, None).is_err());
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
        let worker = start_worker(Arc::clone(&q), processor, Arc::new(|| true), on_change, None, Arc::new(|| false));

        let id = published(&q, "w");
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
        let worker = start_worker(Arc::clone(&q), processor, Arc::new(|| true), noop_change(), None, Arc::new(|| false));
        let id = published(&q, "p");
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
        let worker = start_worker(Arc::clone(&q), processor, Arc::new(|| false), noop_change(), None, Arc::new(|| false));
        let id = published(&q, "g");
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
        let worker = start_worker(Arc::clone(&q), processor, Arc::new(|| true), noop_change(), None, Arc::new(|| false));
        let id = published(&q, "m");
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

    fn ok_processor() -> Processor {
        Arc::new(|_row| Ok(outputs()))
    }

    fn upload_result() -> UploadResult {
        UploadResult {
            remote_id: "abc123".into(),
            page_url: "https://x/c/abc123".into(),
        }
    }

    #[test]
    fn upload_succeeds_after_encode() {
        let q = Arc::new(Queue::open(&temp_db()).unwrap());
        let uploads = Arc::new(AtomicUsize::new(0));
        let uploader: Uploader = {
            let uploads = Arc::clone(&uploads);
            Arc::new(move |row| {
                assert_eq!(row.status, ClipStatus::Uploading);
                assert_eq!(row.av1_path.as_deref(), Some("a.mp4"));
                uploads.fetch_add(1, Ordering::SeqCst);
                Ok(upload_result())
            })
        };
        let worker = start_worker(
            Arc::clone(&q),
            ok_processor(),
            Arc::new(|| true),
            noop_change(),
            Some(uploader),
            Arc::new(|| true),
        );
        let id = published(&q, "u");
        worker.wake();
        let done = wait_until(&q, id, |r| r.status == ClipStatus::Done);
        assert_eq!(done.remote_id.as_deref(), Some("abc123"));
        assert_eq!(done.page_url.as_deref(), Some("https://x/c/abc123"));
        assert_eq!(done.stage, Stage::Upload);
        assert_eq!(done.attempts, 0);
        assert_eq!(uploads.load(Ordering::SeqCst), 1);
        // Done rows are never picked up again.
        assert!(q.next_uploadable().unwrap().is_none());
    }

    #[test]
    fn upload_fails_then_retries_with_backoff() {
        let q = Arc::new(Queue::open(&temp_db()).unwrap());
        let calls = Arc::new(AtomicUsize::new(0));
        let uploader: Uploader = {
            let calls = Arc::clone(&calls);
            Arc::new(move |_row| {
                let n = calls.fetch_add(1, Ordering::SeqCst);
                if n < 2 {
                    anyhow::bail!("network {n}")
                }
                Ok(upload_result())
            })
        };
        let worker = start_worker(
            Arc::clone(&q),
            ok_processor(),
            Arc::new(|| true),
            noop_change(),
            Some(uploader),
            Arc::new(|| true),
        );
        let id = published(&q, "f");
        worker.wake();

        let failed = wait_until(&q, id, |r| r.status == ClipStatus::Failed);
        assert_eq!(failed.stage, Stage::Upload);
        assert_eq!(failed.attempts, 1);
        assert_eq!(failed.error.as_deref(), Some("network 0"));
        assert!(q.next_attempt_at(id).unwrap().is_some());
        // The encode outputs survive an upload failure.
        assert_eq!(failed.av1_path.as_deref(), Some("a.mp4"));

        let done = wait_until(&q, id, |r| r.status == ClipStatus::Done);
        assert_eq!(done.attempts, 2);
        assert_eq!(done.error, None);
        assert_eq!(calls.load(Ordering::SeqCst), 3);
    }

    /// A refused upload (413: too large, or the account is out of quota) must stop on the
    /// first try. Retrying cannot change the answer, so the five backoffs an ordinary failure
    /// spends would only delay telling the user, and `Retry` has to keep working for after
    /// they have freed some space.
    #[test]
    fn a_refused_upload_parks_without_retrying() {
        let q = Arc::new(Queue::open(&temp_db()).unwrap());
        let calls = Arc::new(AtomicUsize::new(0));
        let uploader: Uploader = {
            let calls = Arc::clone(&calls);
            Arc::new(move |_row| {
                calls.fetch_add(1, Ordering::SeqCst);
                Err(anyhow!("HTTP 413: quota_exceeded"))
                    .context(Refused("your storage quota is full"))
                    .context("creating clip record")
            })
        };
        let worker = start_worker(
            Arc::clone(&q),
            Arc::new(|_row| Ok(outputs())),
            Arc::new(|| true),
            noop_change(),
            Some(uploader),
            Arc::new(|| true),
        );
        let id = published(&q, "r");
        worker.wake();

        let parked = wait_until(&q, id, |r| r.status == ClipStatus::Failed && r.attempts > 0);
        assert_eq!(parked.stage, Stage::Upload);
        assert_eq!(parked.attempts, 1, "stopped on the first answer, not at the cap");
        assert!(
            q.next_attempt_at(id).unwrap().is_none(),
            "a refused clip schedules no next attempt",
        );
        // The message the card's tooltip shows has to name the cause, not just the status.
        let error = parked.error.unwrap_or_default();
        assert!(error.contains("your storage quota is full"), "unhelpful error: {error}");

        // Long enough that any scheduled backoff would have fired.
        std::thread::sleep(POLL_INTERVAL * 4);
        assert_eq!(calls.load(Ordering::SeqCst), 1, "never retried on its own");

        // The user frees space and presses Retry: the queue picks it straight back up.
        q.retry(id).unwrap();
        worker.wake();
        wait_until(&q, id, |_| calls.load(Ordering::SeqCst) > 1);
    }

    #[test]
    fn upload_failure_is_not_re_encoded_and_retry_resumes_at_upload() {
        let q = Arc::new(Queue::open(&temp_db()).unwrap());
        let encodes = Arc::new(AtomicUsize::new(0));
        let processor: Processor = {
            let encodes = Arc::clone(&encodes);
            Arc::new(move |_row| {
                encodes.fetch_add(1, Ordering::SeqCst);
                Ok(outputs())
            })
        };
        let uploader: Uploader = Arc::new(|_row| anyhow::bail!("always"));
        let worker = start_worker(
            Arc::clone(&q),
            processor,
            Arc::new(|| true),
            noop_change(),
            Some(uploader),
            Arc::new(|| true),
        );
        let id = published(&q, "e");
        worker.wake();
        let exhausted = wait_until(&q, id, |r| r.attempts >= MAX_ATTEMPTS);
        assert_eq!(exhausted.status, ClipStatus::Failed);
        assert_eq!(exhausted.stage, Stage::Upload);
        assert_eq!(encodes.load(Ordering::SeqCst), 1, "never re-encoded");
        std::thread::sleep(POLL_INTERVAL * 4);
        assert_eq!(encodes.load(Ordering::SeqCst), 1);

        q.retry(id).unwrap();
        let after = wait_until(&q, id, |r| r.attempts < MAX_ATTEMPTS);
        assert!(
            matches!(after.status, ClipStatus::Encoded | ClipStatus::Uploading | ClipStatus::Failed),
            "retry resumes at upload, got {after:?}"
        );
        assert_eq!(after.stage, Stage::Upload);
        wait_until(&q, id, |r| r.status == ClipStatus::Failed && r.attempts == 1);
        assert_eq!(encodes.load(Ordering::SeqCst), 1, "retry did not re-encode");
    }

    #[test]
    fn closed_upload_gate_keeps_row_encoded() {
        let q = Arc::new(Queue::open(&temp_db()).unwrap());
        let uploads = Arc::new(AtomicUsize::new(0));
        let gate_open = Arc::new(std::sync::atomic::AtomicBool::new(false));
        let uploader: Uploader = {
            let uploads = Arc::clone(&uploads);
            Arc::new(move |_row| {
                uploads.fetch_add(1, Ordering::SeqCst);
                Ok(upload_result())
            })
        };
        let upload_gate: Gate = {
            let gate_open = Arc::clone(&gate_open);
            Arc::new(move || gate_open.load(Ordering::SeqCst))
        };
        let worker = start_worker(
            Arc::clone(&q),
            ok_processor(),
            Arc::new(|| true),
            noop_change(),
            Some(uploader),
            upload_gate,
        );
        let id = published(&q, "g");
        worker.wake();
        wait_until(&q, id, |r| r.status == ClipStatus::Encoded);
        std::thread::sleep(POLL_INTERVAL * 6);
        assert_eq!(q.get(id).unwrap().unwrap().status, ClipStatus::Encoded);
        assert_eq!(uploads.load(Ordering::SeqCst), 0);

        // Opening the gate (login) and waking drains the backlog.
        gate_open.store(true, Ordering::SeqCst);
        worker.wake();
        wait_until(&q, id, |r| r.status == ClipStatus::Done);
        assert_eq!(uploads.load(Ordering::SeqCst), 1);
    }

    #[test]
    fn no_uploader_leaves_rows_encoded() {
        let q = Arc::new(Queue::open(&temp_db()).unwrap());
        let worker = start_worker(
            Arc::clone(&q),
            ok_processor(),
            Arc::new(|| true),
            noop_change(),
            None,
            Arc::new(|| true),
        );
        let id = published(&q, "n");
        worker.wake();
        wait_until(&q, id, |r| r.status == ClipStatus::Encoded);
        std::thread::sleep(POLL_INTERVAL * 4);
        assert_eq!(q.get(id).unwrap().unwrap().status, ClipStatus::Encoded);
    }

    #[test]
    fn open_resets_uploading_rows_and_migrates_v1() {
        let path = temp_db();
        // Build a version-1 database by hand, as the phase-2 app would have left it.
        {
            let conn = Connection::open(&path).unwrap();
            conn.execute_batch(
                "CREATE TABLE clips (id INTEGER PRIMARY KEY, source_path TEXT NOT NULL UNIQUE, \
                 game TEXT, title TEXT, recorded_at TEXT NOT NULL, duration_ms INTEGER NOT NULL, \
                 width INTEGER, height INTEGER, size_source INTEGER NOT NULL, size_av1 INTEGER, \
                 size_h264 INTEGER, av1_path TEXT, h264_path TEXT, thumb_path TEXT, \
                 status TEXT NOT NULL, error TEXT, attempts INTEGER NOT NULL DEFAULT 0, \
                 next_attempt_at TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL); \
                 PRAGMA user_version = 1; \
                 INSERT INTO clips (source_path, recorded_at, duration_ms, size_source, status, \
                 created_at, updated_at) VALUES ('C:\\old.mkv', '2026-01-01T00:00:00.000Z', 1000, \
                 5, 'uploading', 'x', 'x');",
            )
            .unwrap();
        }
        let q = Queue::open(&path).unwrap();
        let row = &q.list().unwrap()[0];
        assert_eq!(row.status, ClipStatus::Encoded, "interrupted upload goes back to encoded");
        assert_eq!(row.stage, Stage::Encode);
        assert_eq!(row.remote_id, None);
        assert_eq!(row.fps, None, "a row that predates the column has no frame rate");
        assert_eq!(row.cut, None, "and no cut");
        assert_eq!(row.participants, None, "and nobody in voice");
        assert!(!row.publish, "never uploaded, so it is a local clip now");
        assert_eq!(
            row.captured_at.as_deref(),
            Some("2025-12-31T23:59:59.000Z"),
            "placed its own length before it was recorded"
        );
        let version: i32 = q
            .lock()
            .pragma_query_value(None, "user_version", |r| r.get(0))
            .unwrap();
        assert_eq!(version, SCHEMA_VERSION);
        // Reopening a migrated database is a no-op.
        drop(q);
        Queue::open(&path).unwrap();
    }

    /// Renaming a whole game is also how the library merges two, and how the "Unknown game"
    /// pile is emptied, so all three directions get a clip each.
    #[test]
    fn renaming_a_game_moves_every_clip_of_it() {
        let q = Queue::open(&temp_db()).unwrap();
        let named = |name: &str, file: &str| NewClip {
            game: Some(name.into()),
            ..clip(file, "2026-09-10T10:00:00.000Z")
        };
        let a = q.enqueue(named("HELLDIVERS2", "a")).unwrap();
        let b = q.enqueue(named("HELLDIVERS2", "b")).unwrap();
        let c = q.enqueue(named("Rocket League", "c")).unwrap();
        let unknown = q
            .enqueue(NewClip {
                game: None,
                ..clip("d", "2026-09-10T10:00:00.000Z")
            })
            .unwrap();

        let game_of = |id| q.get(id).unwrap().unwrap().game;

        // Merge: the odd spelling joins a name that already has clips.
        assert_eq!(q.rename_game(Some("HELLDIVERS2"), Some("Helldivers 2")).unwrap(), 2);
        assert_eq!(game_of(a).as_deref(), Some("Helldivers 2"));
        assert_eq!(game_of(b).as_deref(), Some("Helldivers 2"));
        assert_eq!(game_of(c).as_deref(), Some("Rocket League"), "other games are untouched");

        // The unknown pile is addressed by NULL, not by a name.
        assert_eq!(q.rename_game(None, Some("Lethal Company")).unwrap(), 1);
        assert_eq!(game_of(unknown).as_deref(), Some("Lethal Company"));

        // And back again.
        assert_eq!(q.rename_game(Some("Lethal Company"), None).unwrap(), 1);
        assert_eq!(game_of(unknown), None);
        assert_eq!(q.rename_game(Some("Nothing Here"), Some("x")).unwrap(), 0);
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

    /// The voice snapshot lands after the row does, so it has to survive a round trip through
    /// the column and mean the same thing whether it never ran, found nobody, or found four.
    #[test]
    fn participants_are_written_after_the_clip_and_round_trip() {
        let q = Queue::open(&temp_db()).unwrap();
        let id = q.enqueue(clip("v", "2026-09-13T22:00:00.000Z")).unwrap();
        let before = q.get(id).unwrap().unwrap();
        assert_eq!(before.participants, None, "no snapshot yet");

        let ids = vec!["123".to_string(), "456".to_string(), "789".to_string()];
        q.set_participants(id, &ids).unwrap();
        let row = q.get(id).unwrap().unwrap();
        assert_eq!(row.participants, Some(ids));
        assert!(row.updated_at >= before.updated_at);
        // Nothing else about the row moved.
        assert_eq!(row.status, ClipStatus::Saved);
        assert_eq!(row.source_path, before.source_path);
        // The list also comes back through `list`, which is what the UI reads.
        assert_eq!(q.list().unwrap()[0].participants.as_ref().unwrap().len(), 3);

        // A lookup that found nobody reads the same as no lookup at all.
        q.set_participants(id, &[]).unwrap();
        assert_eq!(q.get(id).unwrap().unwrap().participants, None);

        // Junk in the column is not worth failing the row over.
        q.lock()
            .execute(
                "UPDATE clips SET participants = 'not json' WHERE id = ?1",
                params![id],
            )
            .unwrap();
        assert_eq!(q.get(id).unwrap().unwrap().participants, None);
    }

    /// A database written by the build before this feature gains the column on open, and its
    /// existing rows read as "no snapshot" rather than erroring.
    #[test]
    fn v4_database_gains_participants() {
        let path = temp_db();
        let id = {
            let q = Queue::open(&path).unwrap();
            let id = q.enqueue(clip("old", "2026-09-12T10:00:00.000Z")).unwrap();
            // Rewind to a v4 file: drop the column and the version with it.
            let conn = q.lock();
            conn.execute("ALTER TABLE clips DROP COLUMN participants", []).unwrap();
            conn.pragma_update(None, "user_version", 4).unwrap();
            id
        };
        let q = Queue::open(&path).unwrap();
        let row = q.get(id).unwrap().unwrap();
        assert_eq!(row.participants, None, "a row that predates the column has no snapshot");
        assert_eq!(row.status, ClipStatus::Saved);
        let version: i32 = q
            .lock()
            .pragma_query_value(None, "user_version", |r| r.get(0))
            .unwrap();
        assert_eq!(version, SCHEMA_VERSION);
        // And the migrated column is writable straight away.
        q.set_participants(id, &["42".to_string()]).unwrap();
        assert_eq!(q.get(id).unwrap().unwrap().participants, Some(vec!["42".to_string()]));
    }

    #[test]
    fn a_clip_can_arrive_with_its_cut() {
        let q = Queue::open(&temp_db()).unwrap();
        let cut = [Segment { start_ms: 2_000, end_ms: 9_500 }];
        let id = q.enqueue_with_cut(clip("from-match", "2026-09-13T21:00:00.000Z"), &cut).unwrap();
        let row = q.get(id).unwrap().unwrap();
        assert_eq!(row.status, ClipStatus::Saved);
        assert_eq!(row.cut.as_deref(), Some(&cut[..]));
        // An empty cut is the whole recording, stored as no cut.
        let whole = q.enqueue_with_cut(clip("whole", "2026-09-13T21:00:01.000Z"), &[]).unwrap();
        assert_eq!(q.get(whole).unwrap().unwrap().cut, None);
    }

    // -----------------------------------------------------------------------
    // Publish on demand

    fn scratch_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "cos-nostra-queue-{name}-{}-{}",
            std::process::id(),
            Utc::now().timestamp_nanos_opt().unwrap_or(0)
        ));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    /// Outputs that really exist, for the paths that check.
    fn real_outputs(dir: &Path, stem: &str) -> Outputs {
        let file = |ext: &str| {
            let p = dir.join(format!("{stem}.{ext}"));
            std::fs::write(&p, b"x").unwrap();
            p.display().to_string()
        };
        Outputs {
            av1_path: file("av1.mp4"),
            h264_path: file("h264.mp4"),
            thumb_path: file("jpg"),
            size_av1: 1,
            size_h264: 1,
            duration_ms: None,
        }
    }

    /// A database from the build before publish on demand: an uploaded clip stays published
    /// (so a re-edit still replaces it), everything else becomes local, and every clip gets a
    /// best-guess place in time. Nothing else about any row moves.
    #[test]
    fn a_v5_database_migrates_to_publish_on_demand() {
        let path = temp_db();
        let (uploaded, trimmed, encoded, replacing, offset) = {
            let q = Queue::open(&path).unwrap();
            let uploaded = q.enqueue(clip("uploaded", "2026-09-10T10:00:30.000Z")).unwrap();
            q.mark_encoded(uploaded, &outputs()).unwrap();
            q.mark_uploading(uploaded).unwrap();
            q.mark_done(uploaded, "r1", "https://x/c/r1").unwrap();
            let cut = [seg(2_000, 9_500)];
            let trimmed = q
                .enqueue_with_cut(NewClip { duration_ms: 7_500, ..clip("trimmed", "2026-09-10T10:05:00.000Z") }, &cut)
                .unwrap();
            let encoded = q.enqueue(clip("encoded", "2026-09-10T10:10:00.000Z")).unwrap();
            q.mark_encoded(encoded, &outputs()).unwrap();
            // A re-edit of an uploaded clip, queued when the old app closed.
            let replacing = q.enqueue(clip("replacing", "2026-09-10T10:20:00.000Z")).unwrap();
            q.mark_done(replacing, "r2", "https://x/c/r2").unwrap();
            q.request_reencode(replacing, Some(&cut)).unwrap();
            // Written by an app that stamped local time with an offset.
            let offset = q.enqueue(clip("offset", "2026-09-10T12:00:30+02:00")).unwrap();

            let conn = q.lock();
            for column in ["publish", "publish_guilds", "publish_title", "captured_at", "posts"] {
                conn.execute(&format!("ALTER TABLE clips DROP COLUMN {column}"), []).unwrap();
            }
            conn.pragma_update(None, "user_version", 5).unwrap();
            (uploaded, trimmed, encoded, replacing, offset)
        };

        let q = Queue::open(&path).unwrap();
        let row = |id| q.get(id).unwrap().unwrap();
        let version: i32 = q.lock().pragma_query_value(None, "user_version", |r| r.get(0)).unwrap();
        assert_eq!(version, SCHEMA_VERSION);

        let up = row(uploaded);
        assert!(up.publish, "the site has it, so it counts as published");
        assert_eq!(up.status, ClipStatus::Done);
        assert_eq!(up.captured_at.as_deref(), Some("2026-09-10T10:00:00.000Z"));
        assert!(up.posts.is_empty() && up.publish_guilds.is_none() && up.publish_title.is_none());

        let tr = row(trimmed);
        assert!(!tr.publish, "waiting to encode is now a local clip");
        assert_eq!(tr.status, ClipStatus::Saved);
        assert_eq!(tr.cut.as_deref(), Some(&[seg(2_000, 9_500)][..]), "the cut is untouched");
        assert_eq!(
            tr.captured_at.as_deref(),
            Some("2026-09-10T10:04:50.500Z"),
            "the recording is as long as the cut's end, not the kept length"
        );

        let en = row(encoded);
        assert!(!en.publish);
        assert_eq!(en.status, ClipStatus::Encoded, "encoded but never uploaded stays encoded");
        assert_eq!(en.av1_path.as_deref(), Some("a.mp4"), "its outputs are kept");

        let re = row(replacing);
        assert!(re.publish, "a queued replace still runs");
        assert_eq!(re.status, ClipStatus::Saved);

        assert_eq!(row(offset).captured_at.as_deref(), Some("2026-09-10T10:00:00.000Z"));

        // The worker agrees: the only runnable job is the replace.
        assert_eq!(q.claim_next().unwrap().map(|r| r.id), Some(replacing));
        assert!(q.next_uploadable().unwrap().is_none(), "the encoded local clip is not uploaded");

        // Opening again is a no-op.
        drop(q);
        let q = Queue::open(&path).unwrap();
        assert_eq!(q.get(trimmed).unwrap().unwrap().captured_at.as_deref(), Some("2026-09-10T10:04:50.500Z"));
    }

    /// The whole point of the change: with both gates open and a worker running, a clip nobody
    /// published is neither encoded nor uploaded, however long it waits. Publishing an old
    /// encoded clip uploads it without encoding it again.
    #[test]
    fn local_clips_are_never_encoded_or_uploaded() {
        let dir = scratch_dir("gating");
        let q = Arc::new(Queue::open(&temp_db()).unwrap());
        let encodes = Arc::new(AtomicUsize::new(0));
        let uploads = Arc::new(AtomicUsize::new(0));
        let processor: Processor = {
            let encodes = Arc::clone(&encodes);
            Arc::new(move |_row| {
                encodes.fetch_add(1, Ordering::SeqCst);
                Ok(outputs())
            })
        };
        let uploader: Uploader = {
            let uploads = Arc::clone(&uploads);
            Arc::new(move |_row| {
                uploads.fetch_add(1, Ordering::SeqCst);
                Ok(upload_result())
            })
        };
        let worker = start_worker(
            Arc::clone(&q),
            processor,
            Arc::new(|| true),
            noop_change(),
            Some(uploader),
            Arc::new(|| true),
        );

        let local = q.enqueue(clip("local", "2026-09-10T10:00:00.000Z")).unwrap();
        let old = q.enqueue(clip("old", "2026-09-10T10:00:01.000Z")).unwrap();
        q.mark_encoded(old, &real_outputs(&dir, "old")).unwrap();
        worker.wake();
        std::thread::sleep(POLL_INTERVAL * 6);
        assert_eq!(q.get(local).unwrap().unwrap().status, ClipStatus::Saved);
        assert_eq!(q.get(old).unwrap().unwrap().status, ClipStatus::Encoded);
        assert_eq!(encodes.load(Ordering::SeqCst), 0, "nothing local was encoded");
        assert_eq!(uploads.load(Ordering::SeqCst), 0, "nothing local was uploaded");

        // Publishing the old encoded clip goes straight to the upload.
        q.publish(old, Some("ace"), Some("Valorant"), &["123".to_string()]).unwrap();
        worker.wake();
        let done = wait_until(&q, old, |r| r.status == ClipStatus::Done);
        assert_eq!(encodes.load(Ordering::SeqCst), 0, "its outputs were still good");
        assert_eq!(uploads.load(Ordering::SeqCst), 1);
        assert_eq!(done.publish_title.as_deref(), Some("ace"));
        assert_eq!(done.game.as_deref(), Some("Valorant"));
        assert_eq!(done.publish_guilds, Some(vec!["123".to_string()]));

        // And a fresh one runs the whole way.
        q.publish(local, None, None, &[]).unwrap();
        worker.wake();
        wait_until(&q, local, |r| r.status == ClipStatus::Done);
        assert_eq!(encodes.load(Ordering::SeqCst), 1);
        assert_eq!(uploads.load(Ordering::SeqCst), 2);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn publishing_restarts_a_failed_clip_and_refuses_a_published_one() {
        let q = Queue::open(&temp_db()).unwrap();
        let id = q.enqueue(clip("f", "2026-09-10T10:00:00.000Z")).unwrap();
        q.mark_failed(id, "ffmpeg exploded").unwrap();
        // Outputs that are not on disk: an upload failure with nothing to upload encodes again.
        let up = q.enqueue(clip("u", "2026-09-10T10:00:01.000Z")).unwrap();
        q.mark_encoded(up, &outputs()).unwrap();
        q.mark_upload_failed(up, "offline").unwrap();

        q.publish(id, None, None, &[]).unwrap();
        let row = q.get(id).unwrap().unwrap();
        assert!(row.publish);
        assert_eq!(row.status, ClipStatus::Saved);
        assert_eq!((row.attempts, row.error.as_deref()), (0, None));
        assert_eq!(row.publish_guilds, Some(vec![]), "no server is a choice too: web page only");

        q.publish(up, None, None, &[]).unwrap();
        let row = q.get(up).unwrap().unwrap();
        assert_eq!((row.status, row.stage), (ClipStatus::Saved, Stage::Encode));

        q.mark_done(id, "r1", "https://x/c/r1").unwrap();
        assert!(q.publish(id, None, None, &[]).is_err(), "published once is published");
        assert!(q.publish(9999, None, None, &[]).is_err());
    }

    /// Unpublish keeps every file and turns the clip back into a local one, resting as
    /// `encoded` when both copies are still here (so publishing again skips the encode) and as
    /// `saved` when they are not. The two halves let a failed backend call put things back.
    #[test]
    fn unpublishing_makes_a_clip_local_again() {
        let dir = scratch_dir("unpublish");
        let q = Queue::open(&temp_db()).unwrap();
        let post = ClipPost {
            guild_id: "1".into(),
            name: Some("Cos Nostra".into()),
            icon_url: None,
            message_url: "https://discord.com/channels/1/2/3".into(),
            posted_at: "2026-09-13T20:00:00.000Z".into(),
        };

        let kept = published(&q, "kept");
        q.mark_encoded(kept, &real_outputs(&dir, "kept")).unwrap();
        q.mark_uploading(kept).unwrap();
        q.mark_done(kept, "r1", "https://x/c/r1").unwrap();
        q.replace_posts(&HashMap::from([("r1".to_string(), vec![post.clone()])])).unwrap();
        assert_eq!(q.get(kept).unwrap().unwrap().posts, vec![post]);

        let held = q.begin_unpublish(kept).unwrap();
        assert_eq!(held.remote_id.as_deref(), Some("r1"), "the caller gets the id to delete");
        assert!(!q.get(kept).unwrap().unwrap().publish, "the worker lets go first");
        // The backend said no: everything is as it was.
        q.restore_publish(kept, held.publish).unwrap();
        assert!(q.get(kept).unwrap().unwrap().publish);

        q.begin_unpublish(kept).unwrap();
        q.finish_unpublish(kept).unwrap();
        let row = q.get(kept).unwrap().unwrap();
        assert!(!row.publish);
        assert_eq!((row.remote_id, row.page_url), (None, None));
        assert!(row.posts.is_empty());
        assert_eq!(row.status, ClipStatus::Encoded);
        assert!(Path::new(row.av1_path.as_deref().unwrap()).is_file(), "files stay");
        assert!(q.next_uploadable().unwrap().is_none(), "and nothing uploads it again");

        // A clip whose local video was released is only on the site: unpublishing would lose it.
        let released = published(&q, "released");
        q.mark_encoded(released, &outputs()).unwrap();
        q.mark_done(released, "r2", "https://x/c/r2").unwrap();
        q.clear_local_video(released).unwrap();
        assert!(q.begin_unpublish(released).is_err(), "the last copy is not unpublished away");
        let row = q.get(released).unwrap().unwrap();
        assert!(row.publish && row.remote_id.as_deref() == Some("r2"), "nothing changed");

        // With its recording still here it rests on that, as `saved`.
        let recorded = published(&q, "recorded");
        let recording = dir.join("recorded.mp4");
        std::fs::write(&recording, b"video").unwrap();
        q.lock()
            .execute("UPDATE clips SET source_path = ?2 WHERE id = ?1", params![recorded, recording.display().to_string()])
            .unwrap();
        q.mark_encoded(recorded, &outputs()).unwrap();
        q.mark_done(recorded, "r3", "https://x/c/r3").unwrap();
        q.clear_local_video(recorded).unwrap();
        q.begin_unpublish(recorded).unwrap();
        q.finish_unpublish(recorded).unwrap();
        assert_eq!(q.get(recorded).unwrap().unwrap().status, ClipStatus::Saved);

        for busy in ["encoding", "uploading"] {
            q.lock()
                .execute("UPDATE clips SET status = ?2, publish = 1 WHERE id = ?1", params![kept, busy])
                .unwrap();
            assert!(q.begin_unpublish(kept).is_err(), "{busy} is refused");
            assert!(q.get(kept).unwrap().unwrap().publish, "{busy}: nothing changed");
        }
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn the_posts_cache_follows_the_backend_without_touching_thumbnails() {
        let q = Queue::open(&temp_db()).unwrap();
        let a = published(&q, "a");
        let b = published(&q, "b");
        let local = q.enqueue(clip("l", "2026-09-10T10:00:00.000Z")).unwrap();
        q.mark_done(a, "ra", "https://x/c/ra").unwrap();
        q.mark_done(b, "rb", "https://x/c/rb").unwrap();
        let post = |guild: &str| ClipPost {
            guild_id: guild.into(),
            name: None,
            icon_url: Some(format!("https://cdn.discordapp.com/icons/{guild}/x.png?size=96")),
            message_url: format!("https://discord.com/channels/{guild}/2/3"),
            posted_at: "2026-09-13T20:00:00.000Z".into(),
        };
        let before = q.get(a).unwrap().unwrap().updated_at;

        let report = HashMap::from([("ra".to_string(), vec![post("1"), post("2")])]);
        assert_eq!(q.replace_posts(&report).unwrap(), vec![a]);
        assert_eq!(q.get(a).unwrap().unwrap().posts.len(), 2);
        assert!(q.get(b).unwrap().unwrap().posts.is_empty());
        assert!(q.get(local).unwrap().unwrap().posts.is_empty());
        assert_eq!(q.get(a).unwrap().unwrap().updated_at, before, "the thumbnail cache key is left alone");

        assert!(q.replace_posts(&report).unwrap().is_empty(), "the same report changes nothing");
        // Hidden from Discord everywhere: the clip has no live posts left.
        assert_eq!(q.replace_posts(&HashMap::new()).unwrap(), vec![a]);
        assert!(q.get(a).unwrap().unwrap().posts.is_empty());
    }

    #[test]
    fn a_local_cut_drops_stale_outputs_and_a_rebase_swaps_the_recording() {
        let q = Queue::open(&temp_db()).unwrap();
        let id = q.enqueue(clip("c", "2026-09-10T10:00:00.000Z")).unwrap();
        q.mark_encoded(id, &outputs()).unwrap();

        q.set_local_cut(id, Some(&[seg(1_000, 4_000)]), 3_000).unwrap();
        let row = q.get(id).unwrap().unwrap();
        assert_eq!(row.status, ClipStatus::Saved);
        assert_eq!(row.cut, Some(vec![seg(1_000, 4_000)]));
        assert_eq!(row.duration_ms, 3_000);
        assert_eq!((row.av1_path, row.h264_path), (None, None), "stale outputs are forgotten");

        let rebased = Rebased {
            source_path: "C:\\clips\\new.mp4".into(),
            captured_at: "2026-09-10T09:59:50.000Z".into(),
            cut: Some(vec![seg(3_000, 20_000)]),
            duration_ms: 17_000,
            size_source: 99,
            width: 1280,
            height: 720,
            fps: 30.0,
            thumb_path: Some("C:\\clips\\new.jpg".into()),
        };
        q.rebase(id, &rebased).unwrap();
        let row = q.get(id).unwrap().unwrap();
        assert_eq!(row.source_path, "C:\\clips\\new.mp4");
        assert_eq!(row.captured_at.as_deref(), Some("2026-09-10T09:59:50.000Z"));
        assert_eq!((row.duration_ms, row.size_source, row.width), (17_000, 99, 1280));
        assert_eq!(row.thumb_path.as_deref(), Some("C:\\clips\\new.jpg"));
        assert!(!row.publish, "a rebase does not publish anything");

        // A published clip is re-encoded instead, and nothing is cut while a job runs.
        q.publish(id, None, None, &[]).unwrap();
        assert!(q.set_local_cut(id, None, 17_000).is_err());
        q.lock().execute("UPDATE clips SET status = 'encoding' WHERE id = ?1", params![id]).unwrap();
        assert!(q.rebase(id, &rebased).is_err());

        // Baking a cut into a copy moves the clip's start to where that cut began.
        q.lock().execute("UPDATE clips SET status = 'encoded' WHERE id = ?1", params![id]).unwrap();
        q.bake_cut(id, 3_000).unwrap();
        let row = q.get(id).unwrap().unwrap();
        assert_eq!(row.cut, None);
        assert_eq!(row.captured_at.as_deref(), Some("2026-09-10T09:59:53.000Z"));
    }
}
