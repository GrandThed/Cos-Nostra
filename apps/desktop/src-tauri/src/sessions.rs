//! Game sessions, the recordings behind them, the matches cut out of them and the events on
//! their timelines, in SQLite under `%APPDATA%\Cos Nostra\sessions.db`.
//!
//! A separate file from `clips.db` on purpose: the clip queue versions its schema through
//! `PRAGMA user_version`, and two stores sharing one file would share that number too.
//!
//! Lifecycle of a session: `recording` while the game runs, `processing` once it ended and the
//! matches are being cut, then `ready` (or `failed`, with the recordings left on disk so a later
//! start can try again). Lifecycle of a match: `live` while it is being played, `pending` once
//! it ended and waits to be cut, `ready` with its own file, or `missing` when no recording
//! covers it.
//!
//! All times are RFC 3339 UTC with milliseconds, so string order is time order.

use std::path::Path;
use std::sync::{Mutex, MutexGuard};
use std::time::Duration;

use anyhow::{bail, Context, Result};
use chrono::{DateTime, SecondsFormat, Utc};
use rusqlite::{params, Connection, OptionalExtension, Row};
use serde::Serialize;

use crate::timeline::{Event, GameEvent, Outcome, SessionGame};

/// Stored in `PRAGMA user_version`. 2 added `matches.event_offset_ms`. 3 added
/// `recordings.follows`, which chains the parts of a recording split without a gap.
const SCHEMA_VERSION: i32 = 3;

/// The furthest a match's events can be moved either way by hand.
pub const MAX_EVENT_OFFSET_MS: i64 = 10 * 60 * 1000;

const SCHEMA: &str = "
CREATE TABLE IF NOT EXISTS sessions (
    id INTEGER PRIMARY KEY,
    game TEXT NOT NULL,
    game_name TEXT NOT NULL,
    started_at TEXT NOT NULL,
    ended_at TEXT,
    status TEXT NOT NULL,
    provider_reached INTEGER NOT NULL DEFAULT 0,
    error TEXT,
    updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS recordings (
    id INTEGER PRIMARY KEY,
    session_id INTEGER NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    path TEXT NOT NULL UNIQUE,
    requested_at TEXT NOT NULL,
    stopped_at TEXT,
    started_at TEXT,
    duration_ms INTEGER,
    follows INTEGER
);
CREATE TABLE IF NOT EXISTS matches (
    id INTEGER PRIMARY KEY,
    session_id INTEGER NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    started_at TEXT NOT NULL,
    ended_at TEXT,
    detected INTEGER NOT NULL,
    map TEXT,
    mode TEXT,
    result TEXT,
    ally_score INTEGER,
    enemy_score INTEGER,
    path TEXT,
    thumb_path TEXT,
    file_start_at TEXT,
    duration_ms INTEGER,
    size INTEGER,
    status TEXT NOT NULL,
    error TEXT,
    updated_at TEXT NOT NULL,
    event_offset_ms INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS events (
    id INTEGER PRIMARY KEY,
    session_id INTEGER NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    match_id INTEGER REFERENCES matches(id) ON DELETE CASCADE,
    at TEXT NOT NULL,
    kind TEXT NOT NULL,
    data TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS recordings_session ON recordings(session_id);
CREATE INDEX IF NOT EXISTS matches_session ON matches(session_id);
CREATE INDEX IF NOT EXISTS events_match ON events(match_id, at);
CREATE INDEX IF NOT EXISTS events_session ON events(session_id, at);
";

/// Match columns added after version 1, applied with ALTER TABLE to databases that predate
/// them. Every one is nullable or has a default.
const ADDED_MATCH_COLUMNS: [(&str, &str); 1] = [("event_offset_ms", "INTEGER NOT NULL DEFAULT 0")];

/// The same for recordings.
const ADDED_RECORDING_COLUMNS: [(&str, &str); 1] = [("follows", "INTEGER")];

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum SessionStatus {
    Recording,
    Processing,
    Ready,
    Failed,
}

impl SessionStatus {
    fn as_str(self) -> &'static str {
        match self {
            Self::Recording => "recording",
            Self::Processing => "processing",
            Self::Ready => "ready",
            Self::Failed => "failed",
        }
    }

    fn parse(s: &str) -> Option<Self> {
        Some(match s {
            "recording" => Self::Recording,
            "processing" => Self::Processing,
            "ready" => Self::Ready,
            "failed" => Self::Failed,
            _ => return None,
        })
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum MatchStatus {
    Live,
    Pending,
    Ready,
    Missing,
    Failed,
}

impl MatchStatus {
    fn as_str(self) -> &'static str {
        match self {
            Self::Live => "live",
            Self::Pending => "pending",
            Self::Ready => "ready",
            Self::Missing => "missing",
            Self::Failed => "failed",
        }
    }

    fn parse(s: &str) -> Option<Self> {
        Some(match s {
            "live" => Self::Live,
            "pending" => Self::Pending,
            "ready" => Self::Ready,
            "missing" => Self::Missing,
            "failed" => Self::Failed,
            _ => return None,
        })
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct SessionRow {
    pub id: i64,
    /// `SessionGame::id`.
    pub game: String,
    /// What the clip library calls the game, so clips made from a match file under it.
    pub game_name: String,
    pub started_at: String,
    pub ended_at: Option<String>,
    pub status: SessionStatus,
    pub provider_reached: bool,
    pub error: Option<String>,
    /// Oldest first.
    pub matches: Vec<MatchRow>,
}

#[derive(Debug, Clone, Serialize)]
pub struct MatchRow {
    pub id: i64,
    pub session_id: i64,
    pub started_at: String,
    pub ended_at: Option<String>,
    /// False for the stand-in that keeps a session's footage when nothing detected a match.
    pub detected: bool,
    pub map: Option<String>,
    pub mode: Option<String>,
    pub result: Option<Outcome>,
    pub ally_score: Option<i64>,
    pub enemy_score: Option<i64>,
    pub path: Option<String>,
    pub thumb_path: Option<String>,
    /// The wall-clock time of the first frame of `path`. An event at `at` is at
    /// `at - file_start_at` in the file.
    pub file_start_at: Option<String>,
    pub duration_ms: Option<i64>,
    pub size: Option<i64>,
    pub status: MatchStatus,
    pub error: Option<String>,
    pub updated_at: String,
    /// Added to every event's time on this match when it is shown, for timelines recorded out
    /// of step with the video. Events keep their stored times.
    pub event_offset_ms: i64,
}

#[derive(Debug, Clone, Serialize)]
pub struct RecordingRow {
    pub id: i64,
    pub session_id: i64,
    pub path: String,
    /// When the app asked libobs to start. The first frame lands a little later.
    pub requested_at: String,
    pub stopped_at: Option<String>,
    /// Measured once the file is closed: `stopped_at` minus the probed duration.
    pub started_at: Option<String>,
    pub duration_ms: Option<i64>,
    /// The recording this one carries on from without a gap: the recorder split the file here
    /// rather than stopping. Its first frame is the frame after that one's last, which times
    /// every part of a chain from the stop of the last one alone.
    pub follows: Option<i64>,
}

/// One file of other games' footage; see `SessionStore::other_games_footage`.
#[derive(Debug, Clone, PartialEq)]
pub struct Footage {
    pub piece: FootagePiece,
    pub session_id: i64,
    /// RFC 3339 UTC, when the footage starts.
    pub start: String,
    pub duration_ms: i64,
    pub path: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FootagePiece {
    Match(i64),
    Recording(i64),
}

#[derive(Debug, Clone, Serialize)]
pub struct EventRow {
    pub id: i64,
    pub match_id: Option<i64>,
    pub at: String,
    #[serde(flatten)]
    pub event: Event,
}

/// Fixed-width RFC 3339 UTC so string comparison in SQL orders by time.
pub fn format_time(t: DateTime<Utc>) -> String {
    t.to_rfc3339_opts(SecondsFormat::Millis, true)
}

pub fn parse_time(s: &str) -> Result<DateTime<Utc>> {
    Ok(DateTime::parse_from_rfc3339(s)
        .with_context(|| format!("bad timestamp {s:?}"))?
        .with_timezone(&Utc))
}

pub struct SessionStore {
    conn: Mutex<Connection>,
}

const MATCH_COLUMNS: &str = "id, session_id, started_at, ended_at, detected, map, mode, result, \
    ally_score, enemy_score, path, thumb_path, file_start_at, duration_ms, size, status, error, \
    updated_at, event_offset_ms";

const SESSION_COLUMNS: &str =
    "id, game, game_name, started_at, ended_at, status, provider_reached, error";

const RECORDING_COLUMNS: &str =
    "id, session_id, path, requested_at, stopped_at, started_at, duration_ms, follows";

impl SessionStore {
    pub fn open(path: &Path) -> Result<SessionStore> {
        if let Some(parent) = path.parent() {
            if !parent.as_os_str().is_empty() {
                std::fs::create_dir_all(parent)
                    .with_context(|| format!("creating {}", parent.display()))?;
            }
        }
        let conn = Connection::open(path)
            .with_context(|| format!("opening session database {}", path.display()))?;
        conn.busy_timeout(Duration::from_secs(5))
            .context("setting busy timeout")?;
        conn.pragma_update(None, "journal_mode", "WAL")
            .context("enabling WAL")?;
        conn.pragma_update(None, "synchronous", "NORMAL")
            .context("setting synchronous")?;
        conn.pragma_update(None, "foreign_keys", "ON")
            .context("enabling foreign keys")?;
        conn.execute_batch(SCHEMA).context("creating sessions schema")?;
        let version: i32 = conn
            .pragma_query_value(None, "user_version", |r| r.get(0))
            .context("reading schema version")?;
        if version < SCHEMA_VERSION {
            // Older tables already exist and the CREATE above did not touch them.
            add_missing_columns(&conn, "matches", &ADDED_MATCH_COLUMNS)?;
            add_missing_columns(&conn, "recordings", &ADDED_RECORDING_COLUMNS)?;
            conn.pragma_update(None, "user_version", SCHEMA_VERSION)
                .context("writing schema version")?;
        }
        Ok(SessionStore { conn: Mutex::new(conn) })
    }

    fn lock(&self) -> MutexGuard<'_, Connection> {
        self.conn.lock().unwrap_or_else(|e| e.into_inner())
    }

    // -----------------------------------------------------------------------
    // Written live, by the session watch

    pub fn create_session(&self, game: SessionGame, game_name: &str, at: DateTime<Utc>) -> Result<i64> {
        let conn = self.lock();
        let now = format_time(Utc::now());
        conn.execute(
            "INSERT INTO sessions (game, game_name, started_at, status, updated_at) \
             VALUES (?1, ?2, ?3, 'recording', ?4)",
            params![game.id(), game_name, format_time(at), now],
        )
        .context("creating session")?;
        Ok(conn.last_insert_rowid())
    }

    pub fn add_recording(&self, session_id: i64, path: &Path, requested_at: DateTime<Utc>) -> Result<i64> {
        self.add_recording_after(session_id, path, requested_at, None)
    }

    /// A recording that carries on from `follows` without a gap, where the recorder split its
    /// file (see `RecordingRow::follows`).
    pub fn add_recording_after(
        &self,
        session_id: i64,
        path: &Path,
        requested_at: DateTime<Utc>,
        follows: Option<i64>,
    ) -> Result<i64> {
        let conn = self.lock();
        conn.execute(
            "INSERT INTO recordings (session_id, path, requested_at, follows) VALUES (?1, ?2, ?3, ?4)",
            params![session_id, path.display().to_string(), format_time(requested_at), follows],
        )
        .with_context(|| format!("adding recording {}", path.display()))?;
        Ok(conn.last_insert_rowid())
    }

    pub fn stop_recording(&self, id: i64, at: DateTime<Utc>) -> Result<()> {
        self.lock()
            .execute(
                "UPDATE recordings SET stopped_at = ?2 WHERE id = ?1 AND stopped_at IS NULL",
                params![id, format_time(at)],
            )
            .with_context(|| format!("stopping recording {id}"))?;
        Ok(())
    }

    pub fn set_provider_reached(&self, session_id: i64) -> Result<()> {
        self.lock()
            .execute(
                "UPDATE sessions SET provider_reached = 1 WHERE id = ?1",
                params![session_id],
            )
            .context("marking provider reached")?;
        Ok(())
    }

    /// Opens a match that is being played right now.
    pub fn open_match(
        &self,
        session_id: i64,
        at: DateTime<Utc>,
        map: Option<&str>,
        mode: Option<&str>,
    ) -> Result<i64> {
        let conn = self.lock();
        let now = format_time(Utc::now());
        conn.execute(
            "INSERT INTO matches (session_id, started_at, detected, map, mode, status, updated_at) \
             VALUES (?1, ?2, 1, ?3, ?4, 'live', ?5)",
            params![session_id, format_time(at), map, mode, now],
        )
        .context("opening match")?;
        Ok(conn.last_insert_rowid())
    }

    pub fn set_match_score(&self, id: i64, ally: u32, enemy: u32) -> Result<()> {
        self.lock()
            .execute(
                "UPDATE matches SET ally_score = ?2, enemy_score = ?3, updated_at = ?4 WHERE id = ?1",
                params![id, ally, enemy, format_time(Utc::now())],
            )
            .with_context(|| format!("scoring match {id}"))?;
        Ok(())
    }

    /// Ends a live match. A score of `None` keeps whatever the rounds already recorded.
    pub fn close_match(
        &self,
        id: i64,
        at: DateTime<Utc>,
        ally: Option<u32>,
        enemy: Option<u32>,
        result: Option<Outcome>,
    ) -> Result<()> {
        self.lock()
            .execute(
                "UPDATE matches SET ended_at = ?2, ally_score = COALESCE(?3, ally_score), \
                 enemy_score = COALESCE(?4, enemy_score), result = COALESCE(?5, result), \
                 status = 'pending', updated_at = ?6 WHERE id = ?1 AND status = 'live'",
                params![id, format_time(at), ally, enemy, result.map(Outcome::as_str), format_time(Utc::now())],
            )
            .with_context(|| format!("closing match {id}"))?;
        Ok(())
    }

    pub fn add_event(&self, session_id: i64, match_id: Option<i64>, event: &GameEvent) -> Result<i64> {
        let conn = self.lock();
        conn.execute(
            "INSERT INTO events (session_id, match_id, at, kind, data) VALUES (?1, ?2, ?3, ?4, ?5)",
            params![
                session_id,
                match_id,
                format_time(event.at),
                event.event.kind(),
                serde_json::to_string(&event.event).context("serialising event")?,
            ],
        )
        .context("adding event")?;
        Ok(conn.last_insert_rowid())
    }

    /// The game was left: close whatever is still open and hand the session to processing.
    pub fn end_session(&self, id: i64, at: DateTime<Utc>) -> Result<()> {
        let mut conn = self.lock();
        let tx = conn.transaction().context("starting transaction")?;
        let at = format_time(at);
        let now = format_time(Utc::now());
        tx.execute(
            "UPDATE recordings SET stopped_at = ?2 WHERE session_id = ?1 AND stopped_at IS NULL",
            params![id, at],
        )?;
        tx.execute(
            "UPDATE matches SET ended_at = ?2, status = 'pending', updated_at = ?3 \
             WHERE session_id = ?1 AND status = 'live'",
            params![id, at, now],
        )?;
        tx.execute(
            "UPDATE sessions SET ended_at = ?2, status = 'processing', updated_at = ?3 \
             WHERE id = ?1 AND status = 'recording'",
            params![id, at, now],
        )?;
        tx.commit().with_context(|| format!("ending session {id}"))?;
        Ok(())
    }

    /// At startup: a session still `recording` belongs to a run of the app that died mid-game.
    /// It ends at the last thing known about it, and joins the queue for processing. Returns
    /// every session waiting to be processed, oldest first.
    ///
    /// A recording that was never stopped gets its file's last write as its stop: the recorder
    /// writes as it goes, so that is within seconds of when the app went away, where the start
    /// request alone would end an hour-long session the moment it began.
    pub fn recover(&self) -> Result<Vec<i64>> {
        let stale: Vec<i64> = {
            let conn = self.lock();
            let mut stmt = conn.prepare("SELECT id FROM sessions WHERE status = 'recording'")?;
            let ids = stmt.query_map([], |r| r.get(0))?.collect::<rusqlite::Result<_>>()?;
            ids
        };
        for id in stale {
            for rec in self.recordings(id)?.into_iter().filter(|r| r.stopped_at.is_none()) {
                match std::fs::metadata(&rec.path).and_then(|m| m.modified()) {
                    Ok(written) => self.stop_recording(rec.id, DateTime::<Utc>::from(written))?,
                    Err(e) => log::warn!("recording {} has no last write time: {e}", rec.path),
                }
            }
            let last: String = self.lock().query_row(
                "SELECT MAX(t) FROM ( \
                   SELECT started_at AS t FROM sessions WHERE id = ?1 \
                   UNION ALL SELECT COALESCE(stopped_at, requested_at) FROM recordings WHERE session_id = ?1 \
                   UNION ALL SELECT at FROM events WHERE session_id = ?1)",
                params![id],
                |r| r.get(0),
            )?;
            log::warn!("session {id} was still recording when the app stopped; ending it at {last}");
            self.end_session(id, parse_time(&last)?)?;
        }
        self.pending()
    }

    /// Sessions that ended and wait for their matches to be cut.
    pub fn pending(&self) -> Result<Vec<i64>> {
        let conn = self.lock();
        let mut stmt =
            conn.prepare("SELECT id FROM sessions WHERE status = 'processing' ORDER BY started_at")?;
        let ids = stmt.query_map([], |r| r.get(0))?.collect::<rusqlite::Result<_>>()?;
        Ok(ids)
    }

    // -----------------------------------------------------------------------
    // Processing

    pub fn recordings(&self, session_id: i64) -> Result<Vec<RecordingRow>> {
        let conn = self.lock();
        let mut stmt = conn.prepare(&format!(
            "SELECT {RECORDING_COLUMNS} FROM recordings WHERE session_id = ?1 ORDER BY requested_at"
        ))?;
        let rows = stmt
            .query_map(params![session_id], recording_from)?
            .collect::<rusqlite::Result<_>>()?;
        Ok(rows)
    }

    pub fn set_recording_timing(&self, id: i64, started_at: DateTime<Utc>, duration_ms: i64) -> Result<()> {
        self.lock()
            .execute(
                "UPDATE recordings SET started_at = ?2, duration_ms = ?3 WHERE id = ?1",
                params![id, format_time(started_at), duration_ms],
            )
            .with_context(|| format!("timing recording {id}"))?;
        Ok(())
    }

    pub fn delete_recording(&self, id: i64) -> Result<()> {
        self.lock()
            .execute("DELETE FROM recordings WHERE id = ?1", params![id])
            .with_context(|| format!("deleting recording {id}"))?;
        Ok(())
    }

    /// A stand-in match covering footage nothing detected a match in, so it is kept.
    pub fn add_undetected_match(&self, session_id: i64, start: DateTime<Utc>, end: DateTime<Utc>) -> Result<i64> {
        let conn = self.lock();
        conn.execute(
            "INSERT INTO matches (session_id, started_at, ended_at, detected, status, updated_at) \
             VALUES (?1, ?2, ?3, 0, 'pending', ?4)",
            params![session_id, format_time(start), format_time(end), format_time(Utc::now())],
        )
        .context("adding undetected match")?;
        Ok(conn.last_insert_rowid())
    }

    pub fn set_match_file(
        &self,
        id: i64,
        path: &Path,
        thumb: Option<&Path>,
        file_start_at: DateTime<Utc>,
        duration_ms: i64,
        size: i64,
    ) -> Result<()> {
        self.lock()
            .execute(
                "UPDATE matches SET path = ?2, thumb_path = ?3, file_start_at = ?4, duration_ms = ?5, \
                 size = ?6, status = 'ready', error = NULL, updated_at = ?7 WHERE id = ?1",
                params![
                    id,
                    path.display().to_string(),
                    thumb.map(|t| t.display().to_string()),
                    format_time(file_start_at),
                    duration_ms,
                    size,
                    format_time(Utc::now()),
                ],
            )
            .with_context(|| format!("recording the file of match {id}"))?;
        Ok(())
    }

    pub fn set_match_status(&self, id: i64, status: MatchStatus, error: Option<&str>) -> Result<()> {
        self.lock()
            .execute(
                "UPDATE matches SET status = ?2, error = ?3, updated_at = ?4 WHERE id = ?1",
                params![id, status.as_str(), error, format_time(Utc::now())],
            )
            .with_context(|| format!("setting match {id} {}", status.as_str()))?;
        Ok(())
    }

    /// Sets how far a match's events are moved when shown, clamped to `MAX_EVENT_OFFSET_MS`
    /// either way. `updated_at` is left alone on purpose: the UI keys its video player and
    /// thumbnail cache on it, and moving the timeline must not reload the video.
    pub fn set_match_event_offset(&self, id: i64, offset_ms: i64) -> Result<()> {
        let offset_ms = offset_ms.clamp(-MAX_EVENT_OFFSET_MS, MAX_EVENT_OFFSET_MS);
        let changed = self
            .lock()
            .execute(
                "UPDATE matches SET event_offset_ms = ?2 WHERE id = ?1",
                params![id, offset_ms],
            )
            .with_context(|| format!("setting the event offset of match {id}"))?;
        if changed == 0 {
            bail!("match {id} not found");
        }
        Ok(())
    }

    pub fn set_session_status(&self, id: i64, status: SessionStatus, error: Option<&str>) -> Result<()> {
        self.lock()
            .execute(
                "UPDATE sessions SET status = ?2, error = ?3, updated_at = ?4 WHERE id = ?1",
                params![id, status.as_str(), error, format_time(Utc::now())],
            )
            .with_context(|| format!("setting session {id} {}", status.as_str()))?;
        Ok(())
    }

    // -----------------------------------------------------------------------
    // Reading

    pub fn session(&self, id: i64) -> Result<Option<SessionRow>> {
        let conn = self.lock();
        let Some(mut row) = conn
            .query_row(
                &format!("SELECT {SESSION_COLUMNS} FROM sessions WHERE id = ?1"),
                params![id],
                session_from,
            )
            .optional()
            .with_context(|| format!("reading session {id}"))?
        else {
            return Ok(None);
        };
        row.matches = matches_in(&conn, id)?;
        Ok(Some(row))
    }

    /// Every session with its matches, newest first.
    pub fn list(&self) -> Result<Vec<SessionRow>> {
        let conn = self.lock();
        let mut stmt = conn.prepare(&format!(
            "SELECT {SESSION_COLUMNS} FROM sessions ORDER BY started_at DESC"
        ))?;
        let mut rows: Vec<SessionRow> = stmt
            .query_map([], session_from)?
            .collect::<rusqlite::Result<_>>()
            .context("listing sessions")?;
        for row in &mut rows {
            row.matches = matches_in(&conn, row.id)?;
        }
        Ok(rows)
    }

    /// Every match with a file on disk, oldest first, across every session — for enforcing
    /// `session_storage_limit_gb`. Unlike `list` (newest session first, for the UI), this reads
    /// straight across sessions and only matches actually `ready`: a `live` or `pending` match
    /// has no file to free yet, and a `missing` or `failed` one never got one.
    pub fn oldest_matches(&self) -> Result<Vec<MatchRow>> {
        let conn = self.lock();
        let mut stmt = conn.prepare(&format!(
            "SELECT {MATCH_COLUMNS} FROM matches WHERE status = 'ready' ORDER BY started_at, id"
        ))?;
        let rows = stmt
            .query_map([], match_from)?
            .collect::<rusqlite::Result<_>>()
            .context("listing oldest matches")?;
        Ok(rows)
    }

    /// Every piece of footage of other games (`SessionGame::Other`) on disk, newest first: match
    /// files, and the finished parts of recordings not cut yet. The part a recording is writing
    /// has no stop and is not here. For the background recording's budget, which counts footage
    /// rather than time, so a game played yesterday is not lost to the clock.
    pub fn other_games_footage(&self) -> Result<Vec<Footage>> {
        let conn = self.lock();
        let mut out: Vec<Footage> = Vec::new();
        let mut stmt = conn.prepare(
            "SELECT m.id, m.session_id, m.file_start_at, m.duration_ms, m.path FROM matches m \
             JOIN sessions s ON s.id = m.session_id \
             WHERE s.game = 'other' AND m.status = 'ready' AND m.path IS NOT NULL \
             AND m.file_start_at IS NOT NULL AND m.duration_ms IS NOT NULL",
        )?;
        for row in stmt.query_map([], |r| {
            Ok(Footage {
                piece: FootagePiece::Match(r.get(0)?),
                session_id: r.get(1)?,
                start: r.get(2)?,
                duration_ms: r.get(3)?,
                path: r.get(4)?,
            })
        })? {
            out.push(row?);
        }
        let mut stmt = conn.prepare(
            "SELECT r.id, r.session_id, r.requested_at, r.stopped_at, r.path FROM recordings r \
             JOIN sessions s ON s.id = r.session_id \
             WHERE s.game = 'other' AND r.stopped_at IS NOT NULL",
        )?;
        let parts: Vec<(i64, i64, String, String, String)> = stmt
            .query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?)))?
            .collect::<rusqlite::Result<_>>()?;
        for (id, session_id, requested, stopped, path) in parts {
            // Not measured until the session is cut; the span it was asked for is near enough.
            let duration_ms = (parse_time(&stopped)? - parse_time(&requested)?).num_milliseconds().max(0);
            out.push(Footage { piece: FootagePiece::Recording(id), session_id, start: requested, duration_ms, path });
        }
        out.sort_by(|a, b| b.start.cmp(&a.start));
        Ok(out)
    }

    pub fn get_match(&self, id: i64) -> Result<Option<MatchRow>> {
        self.lock()
            .query_row(
                &format!("SELECT {MATCH_COLUMNS} FROM matches WHERE id = ?1"),
                params![id],
                match_from,
            )
            .optional()
            .with_context(|| format!("reading match {id}"))
    }

    /// The timeline of one match, oldest first: its own events, plus every marker of its session
    /// that its file shows. A marker belongs to the moment rather than to a match, so one pressed
    /// in the menus lands in the pre-roll of the next match, and one pressed in a game nothing
    /// detects matches in lands on the recording kept whole.
    pub fn events(&self, match_id: i64) -> Result<Vec<EventRow>> {
        let row = self.get_match(match_id)?;
        let window = row.as_ref().and_then(|m| {
            let start = parse_time(m.file_start_at.as_deref()?).ok()?;
            let end = start + chrono::Duration::milliseconds(m.duration_ms?);
            Some((m.session_id, format_time(start), format_time(end)))
        });
        let (session_id, from, to) = window.unwrap_or((-1, String::new(), String::new()));
        let conn = self.lock();
        let mut stmt = conn.prepare(
            "SELECT id, match_id, at, data FROM events WHERE match_id = ?1 \
             OR (session_id = ?2 AND kind = 'marker' AND at >= ?3 AND at <= ?4) ORDER BY at, id",
        )?;
        let rows = stmt
            .query_map(params![match_id, session_id, from, to], event_from)?
            .collect::<rusqlite::Result<_>>()
            .with_context(|| format!("reading events of match {match_id}"))?;
        Ok(rows)
    }

    // -----------------------------------------------------------------------
    // Deleting

    /// Deletes a session and everything under it. Returns the files it owned, for the caller
    /// to remove; the rows are gone either way.
    pub fn delete_session(&self, id: i64) -> Result<Vec<String>> {
        let mut conn = self.lock();
        let tx = conn.transaction()?;
        let mut files: Vec<String> = Vec::new();
        {
            let mut stmt = tx.prepare("SELECT path FROM recordings WHERE session_id = ?1")?;
            for p in stmt.query_map(params![id], |r| r.get::<_, String>(0))? {
                files.push(p?);
            }
            let mut stmt =
                tx.prepare("SELECT path, thumb_path FROM matches WHERE session_id = ?1")?;
            for pair in stmt.query_map(params![id], |r| {
                Ok((r.get::<_, Option<String>>(0)?, r.get::<_, Option<String>>(1)?))
            })? {
                let (path, thumb) = pair?;
                files.extend(path);
                files.extend(thumb);
            }
        }
        tx.execute("DELETE FROM sessions WHERE id = ?1", params![id])?;
        tx.commit().with_context(|| format!("deleting session {id}"))?;
        Ok(files)
    }

    /// Deletes one match and its events. A finished session left with no matches goes too.
    /// Returns the files the match owned.
    pub fn delete_match(&self, id: i64) -> Result<Vec<String>> {
        let Some(row) = self.get_match(id)? else {
            return Ok(Vec::new());
        };
        let mut conn = self.lock();
        let tx = conn.transaction()?;
        tx.execute("DELETE FROM matches WHERE id = ?1", params![id])?;
        let left: i64 = tx.query_row(
            "SELECT COUNT(*) FROM matches WHERE session_id = ?1",
            params![row.session_id],
            |r| r.get(0),
        )?;
        if left == 0 {
            tx.execute(
                "DELETE FROM sessions WHERE id = ?1 AND status IN ('ready', 'failed')",
                params![row.session_id],
            )?;
        }
        tx.commit().with_context(|| format!("deleting match {id}"))?;
        Ok(row.path.into_iter().chain(row.thumb_path).collect())
    }
}

/// Adds whichever of a table's later columns this database does not have yet. Idempotent, so
/// a half-applied migration finishes on the next open.
fn add_missing_columns(conn: &Connection, table: &str, columns: &[(&str, &str)]) -> Result<()> {
    let mut stmt = conn
        .prepare(&format!("PRAGMA table_info({table})"))
        .with_context(|| format!("reading {table} columns"))?;
    let existing: Vec<String> = stmt
        .query_map([], |r| r.get::<_, String>(1))
        .with_context(|| format!("listing {table} columns"))?
        .collect::<rusqlite::Result<_>>()
        .with_context(|| format!("reading {table} columns"))?;
    for (name, decl) in columns {
        if !existing.iter().any(|c| c == name) {
            conn.execute(&format!("ALTER TABLE {table} ADD COLUMN {name} {decl}"), [])
                .with_context(|| format!("adding column {table}.{name}"))?;
            log::info!("sessions: added column {table}.{name}");
        }
    }
    Ok(())
}

fn matches_in(conn: &Connection, session_id: i64) -> Result<Vec<MatchRow>> {
    let mut stmt = conn.prepare(&format!(
        "SELECT {MATCH_COLUMNS} FROM matches WHERE session_id = ?1 ORDER BY started_at, id"
    ))?;
    let rows = stmt
        .query_map(params![session_id], match_from)?
        .collect::<rusqlite::Result<_>>()
        .with_context(|| format!("reading matches of session {session_id}"))?;
    Ok(rows)
}

fn bad(column: usize, what: String) -> rusqlite::Error {
    rusqlite::Error::FromSqlConversionFailure(column, rusqlite::types::Type::Text, what.into())
}

fn session_from(r: &Row<'_>) -> rusqlite::Result<SessionRow> {
    let status: String = r.get(5)?;
    Ok(SessionRow {
        id: r.get(0)?,
        game: r.get(1)?,
        game_name: r.get(2)?,
        started_at: r.get(3)?,
        ended_at: r.get(4)?,
        status: SessionStatus::parse(&status).ok_or_else(|| bad(5, format!("unknown session status {status:?}")))?,
        provider_reached: r.get::<_, i64>(6)? != 0,
        error: r.get(7)?,
        matches: Vec::new(),
    })
}

fn match_from(r: &Row<'_>) -> rusqlite::Result<MatchRow> {
    let status: String = r.get(15)?;
    Ok(MatchRow {
        id: r.get(0)?,
        session_id: r.get(1)?,
        started_at: r.get(2)?,
        ended_at: r.get(3)?,
        detected: r.get::<_, i64>(4)? != 0,
        map: r.get(5)?,
        mode: r.get(6)?,
        result: r.get::<_, Option<String>>(7)?.as_deref().and_then(Outcome::parse),
        ally_score: r.get(8)?,
        enemy_score: r.get(9)?,
        path: r.get(10)?,
        thumb_path: r.get(11)?,
        file_start_at: r.get(12)?,
        duration_ms: r.get(13)?,
        size: r.get(14)?,
        status: MatchStatus::parse(&status).ok_or_else(|| bad(15, format!("unknown match status {status:?}")))?,
        error: r.get(16)?,
        updated_at: r.get(17)?,
        event_offset_ms: r.get(18)?,
    })
}

fn recording_from(r: &Row<'_>) -> rusqlite::Result<RecordingRow> {
    Ok(RecordingRow {
        id: r.get(0)?,
        session_id: r.get(1)?,
        path: r.get(2)?,
        requested_at: r.get(3)?,
        stopped_at: r.get(4)?,
        started_at: r.get(5)?,
        duration_ms: r.get(6)?,
        follows: r.get(7)?,
    })
}

fn event_from(r: &Row<'_>) -> rusqlite::Result<EventRow> {
    let data: String = r.get(3)?;
    Ok(EventRow {
        id: r.get(0)?,
        match_id: r.get(1)?,
        at: r.get(2)?,
        event: serde_json::from_str(&data).map_err(|e| bad(3, format!("unreadable event: {e}")))?,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::timeline::EndReason;
    use chrono::Duration as ChronoDuration;
    use std::path::PathBuf;

    fn t(s: i64) -> DateTime<Utc> {
        DateTime::from_timestamp(1_800_000_000 + s, 0).unwrap()
    }

    fn store() -> (SessionStore, PathBuf) {
        let dir = std::env::temp_dir().join(format!(
            "cos-nostra-sessions-test-{}-{}",
            std::process::id(),
            rand_suffix()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        (SessionStore::open(&dir.join("sessions.db")).unwrap(), dir)
    }

    fn rand_suffix() -> u128 {
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    }

    #[test]
    fn a_session_with_two_matches_round_trips() {
        let (s, dir) = store();
        let id = s.create_session(SessionGame::Valorant, "Valorant", t(0)).unwrap();
        let rec = s.add_recording(id, &dir.join("r1.mp4"), t(1)).unwrap();

        let m1 = s.open_match(id, t(60), Some("Ascent"), Some("Competitive")).unwrap();
        s.add_event(id, Some(m1), &GameEvent {
            at: t(60),
            event: Event::MatchStart { map: Some("Ascent".into()), mode: Some("Competitive".into()) },
        })
        .unwrap();
        s.add_event(id, Some(m1), &GameEvent {
            at: t(150),
            event: Event::RoundEnd { round: 1, ally: 1, enemy: 0, won: Some(true) },
        })
        .unwrap();
        s.set_match_score(m1, 1, 0).unwrap();
        s.close_match(m1, t(1800), Some(13), Some(9), Some(Outcome::Win)).unwrap();

        let m2 = s.open_match(id, t(2000), Some("Bind"), None).unwrap();
        s.stop_recording(rec, t(2500)).unwrap();
        s.end_session(id, t(2600)).unwrap();

        let session = s.session(id).unwrap().unwrap();
        assert_eq!(session.status, SessionStatus::Processing);
        assert_eq!(session.ended_at.as_deref(), Some(format_time(t(2600)).as_str()));
        assert_eq!(session.matches.len(), 2);
        let first = &session.matches[0];
        assert_eq!(first.id, m1);
        assert_eq!(first.result, Some(Outcome::Win));
        assert_eq!((first.ally_score, first.enemy_score), (Some(13), Some(9)));
        assert_eq!(first.status, MatchStatus::Pending);
        // The open match was closed by the end of the session, at the session's end.
        let second = &session.matches[1];
        assert_eq!(second.id, m2);
        assert_eq!(second.ended_at.as_deref(), Some(format_time(t(2600)).as_str()));
        assert_eq!(second.status, MatchStatus::Pending);
        // Stopping twice keeps the first stop.
        let recs = s.recordings(id).unwrap();
        assert_eq!(recs[0].stopped_at.as_deref(), Some(format_time(t(2500)).as_str()));

        let events = s.events(m1).unwrap();
        assert_eq!(events.len(), 2);
        assert!(matches!(events[1].event, Event::RoundEnd { round: 1, .. }));
        let json = serde_json::to_value(&events[1]).unwrap();
        assert_eq!(json["kind"], "round_end", "events reach the UI flattened: {json}");

        assert_eq!(s.pending().unwrap(), vec![id]);
    }

    /// A marker shows on every match file that holds its moment, and on a recording kept whole
    /// for a game nothing detects matches in; not on footage that does not reach it.
    #[test]
    fn markers_show_on_the_files_that_hold_them() {
        let (s, dir) = store();
        let id = s.create_session(SessionGame::Valorant, "Valorant", t(0)).unwrap();
        let first = s.open_match(id, t(100), None, None).unwrap();
        let marker = |at| GameEvent { at, event: Event::Marker };
        // Pressed during the first match, and in the menus just before the second.
        s.add_event(id, Some(first), &marker(t(150))).unwrap();
        s.close_match(first, t(200), None, None, None).unwrap();
        s.add_event(id, None, &marker(t(295))).unwrap();
        let second = s.open_match(id, t(300), None, None).unwrap();
        s.close_match(second, t(400), None, None, None).unwrap();
        // The second file starts 10 s early, so it shows the menus marker; the first ends at 208 s.
        s.set_match_file(first, &dir.join("a.mp4"), None, t(90), 118_000, 1).unwrap();
        s.set_match_file(second, &dir.join("b.mp4"), None, t(290), 118_000, 1).unwrap();

        let at = |m| s.events(m).unwrap().iter().filter(|e| e.event == Event::Marker).map(|e| e.at.clone()).collect::<Vec<_>>();
        assert_eq!(at(first), vec![format_time(t(150))]);
        assert_eq!(at(second), vec![format_time(t(295))]);

        // Another session's marker at the same moment is not this session's.
        let other = s.create_session(SessionGame::League, "League of Legends", t(0)).unwrap();
        s.add_event(other, None, &marker(t(160))).unwrap();
        assert_eq!(at(first).len(), 1);

        // A match with no file yet still has its own events.
        let open = s.open_match(id, t(500), None, None).unwrap();
        s.add_event(id, Some(open), &marker(t(510))).unwrap();
        assert_eq!(at(open), vec![format_time(t(510))]);
    }

    #[test]
    fn closing_a_match_keeps_the_round_score_when_the_end_has_none() {
        let (s, _dir) = store();
        let id = s.create_session(SessionGame::Valorant, "Valorant", t(0)).unwrap();
        let m = s.open_match(id, t(10), None, None).unwrap();
        s.set_match_score(m, 7, 5).unwrap();
        s.close_match(m, t(900), None, None, None).unwrap();
        let row = s.get_match(m).unwrap().unwrap();
        assert_eq!((row.ally_score, row.enemy_score), (Some(7), Some(5)));
        // A second close does not move the end.
        s.close_match(m, t(1000), Some(1), Some(1), Some(Outcome::Draw)).unwrap();
        let row = s.get_match(m).unwrap().unwrap();
        assert_eq!(row.ended_at.as_deref(), Some(format_time(t(900)).as_str()));
        assert_eq!(row.result, None);
    }

    #[test]
    fn recovery_ends_a_session_at_the_last_thing_known() {
        let (s, dir) = store();
        let id = s.create_session(SessionGame::CounterStrike, "Counter-Strike 2", t(0)).unwrap();
        s.add_recording(id, &dir.join("a.mp4"), t(5)).unwrap();
        let m = s.open_match(id, t(100), None, None).unwrap();
        s.add_event(id, Some(m), &GameEvent {
            at: t(700),
            event: Event::MatchEnd { ally: None, enemy: None, result: None, reason: EndReason::Lost },
        })
        .unwrap();
        let ready = s.create_session(SessionGame::League, "League of Legends", t(10_000)).unwrap();
        s.end_session(ready, t(11_000)).unwrap();
        s.set_session_status(ready, SessionStatus::Ready, None).unwrap();

        assert_eq!(s.recover().unwrap(), vec![id]);
        let row = s.session(id).unwrap().unwrap();
        assert_eq!(row.status, SessionStatus::Processing);
        assert_eq!(row.ended_at.as_deref(), Some(format_time(t(700)).as_str()));
        assert_eq!(row.matches[0].status, MatchStatus::Pending);
        let recs = s.recordings(id).unwrap();
        assert_eq!(recs[0].stopped_at.as_deref(), Some(format_time(t(700)).as_str()));
        // Running it again changes nothing.
        assert_eq!(s.recover().unwrap(), vec![id]);
    }

    /// The app restarted mid-game with nothing on the timeline: the recording's last write is
    /// the end, not its start.
    #[test]
    fn recovery_ends_an_eventless_session_at_the_recordings_last_write() {
        let (s, dir) = store();
        // Long enough ago that the file's modified time (now) is clearly later.
        let begun = Utc::now() - ChronoDuration::minutes(12);
        let id = s.create_session(SessionGame::League, "League of Legends", begun).unwrap();
        let file = dir.join("session-1-1.mp4");
        std::fs::write(&file, b"footage").unwrap();
        s.add_recording(id, &file, begun).unwrap();

        assert_eq!(s.recover().unwrap(), vec![id]);
        let row = s.session(id).unwrap().unwrap();
        let ended = parse_time(row.ended_at.as_deref().unwrap()).unwrap();
        assert!(ended - begun >= ChronoDuration::minutes(11), "ended {ended}, begun {begun}");
        let rec = &s.recordings(id).unwrap()[0];
        assert_eq!(rec.stopped_at, row.ended_at);
    }

    #[test]
    fn deleting_cascades_and_reports_files() {
        let (s, dir) = store();
        let id = s.create_session(SessionGame::Valorant, "Valorant", t(0)).unwrap();
        s.add_recording(id, &dir.join("raw.mp4"), t(0)).unwrap();
        let m = s.open_match(id, t(10), None, None).unwrap();
        s.add_event(id, Some(m), &GameEvent {
            at: t(20),
            event: Event::RoundEnd { round: 1, ally: 0, enemy: 1, won: Some(false) },
        })
        .unwrap();
        s.end_session(id, t(100)).unwrap();
        s.set_match_file(m, &dir.join("m.mp4"), Some(&dir.join("m.jpg")), t(0), 100_000, 42).unwrap();
        let other = s.add_undetected_match(id, t(0), t(100)).unwrap();
        s.set_session_status(id, SessionStatus::Ready, None).unwrap();

        let files = s.delete_match(m).unwrap();
        assert_eq!(files.len(), 2);
        assert!(s.events(m).unwrap().is_empty());
        assert!(s.session(id).unwrap().is_some(), "one match is left");

        s.delete_match(other).unwrap();
        assert!(s.session(id).unwrap().is_none(), "an empty finished session goes too");

        let id = s.create_session(SessionGame::Valorant, "Valorant", t(500)).unwrap();
        s.add_recording(id, &dir.join("raw2.mp4"), t(500)).unwrap();
        let files = s.delete_session(id).unwrap();
        assert_eq!(files, vec![dir.join("raw2.mp4").display().to_string()]);
        assert!(s.list().unwrap().is_empty());
    }

    #[test]
    fn oldest_matches_spans_sessions_and_skips_matches_with_no_file() {
        let (s, dir) = store();
        let s1 = s.create_session(SessionGame::Valorant, "Valorant", t(0)).unwrap();
        let s2 = s.create_session(SessionGame::League, "League of Legends", t(1000)).unwrap();
        let ready1 = s.add_undetected_match(s1, t(0), t(10)).unwrap();
        s.set_match_file(ready1, &dir.join("a.mp4"), None, t(0), 10_000, 1).unwrap();
        let ready2 = s.add_undetected_match(s2, t(1000), t(1010)).unwrap();
        s.set_match_file(ready2, &dir.join("b.mp4"), None, t(1000), 10_000, 1).unwrap();
        // Still open: no file yet, so it must not show up.
        s.open_match(s2, t(2000), None, None).unwrap();

        let ids: Vec<i64> = s.oldest_matches().unwrap().iter().map(|m| m.id).collect();
        assert_eq!(ids, vec![ready1, ready2], "oldest first, across both sessions");
    }

    /// Moving a timeline by hand is clamped, and leaves `updated_at` alone so the UI does not
    /// reload the video under the user.
    #[test]
    fn a_match_event_offset_is_clamped_and_keeps_updated_at() {
        let (s, _dir) = store();
        let id = s.create_session(SessionGame::League, "League of Legends", t(0)).unwrap();
        let m = s.add_undetected_match(id, t(0), t(100)).unwrap();
        let before = s.get_match(m).unwrap().unwrap();
        assert_eq!(before.event_offset_ms, 0);

        std::thread::sleep(Duration::from_millis(5));
        s.set_match_event_offset(m, 24_150).unwrap();
        let row = s.get_match(m).unwrap().unwrap();
        assert_eq!(row.event_offset_ms, 24_150);
        assert_eq!(row.updated_at, before.updated_at);
        assert_eq!(s.session(id).unwrap().unwrap().matches[0].event_offset_ms, 24_150);

        s.set_match_event_offset(m, -MAX_EVENT_OFFSET_MS - 1).unwrap();
        assert_eq!(s.get_match(m).unwrap().unwrap().event_offset_ms, -MAX_EVENT_OFFSET_MS);
        s.set_match_event_offset(m, i64::MAX).unwrap();
        assert_eq!(s.get_match(m).unwrap().unwrap().event_offset_ms, MAX_EVENT_OFFSET_MS);
        assert!(s.set_match_event_offset(m + 1, 0).is_err());
    }

    /// A version 1 database gains the offset column on open, with its matches at no offset.
    #[test]
    fn v1_database_gains_the_event_offset() {
        let (s, dir) = store();
        let id = s.create_session(SessionGame::League, "League of Legends", t(0)).unwrap();
        let m = s.add_undetected_match(id, t(0), t(100)).unwrap();
        {
            // Rewind to a v1 file: drop the column and the version with it.
            let conn = s.lock();
            conn.execute("ALTER TABLE matches DROP COLUMN event_offset_ms", []).unwrap();
            conn.pragma_update(None, "user_version", 1).unwrap();
        }
        drop(s);

        let s = SessionStore::open(&dir.join("sessions.db")).unwrap();
        assert_eq!(s.get_match(m).unwrap().unwrap().event_offset_ms, 0);
        let version: i32 = s.lock().pragma_query_value(None, "user_version", |r| r.get(0)).unwrap();
        assert_eq!(version, SCHEMA_VERSION);
        s.set_match_event_offset(m, -1_500).unwrap();
        assert_eq!(s.get_match(m).unwrap().unwrap().event_offset_ms, -1_500);
        // Opening it again changes nothing.
        drop(s);
        let s = SessionStore::open(&dir.join("sessions.db")).unwrap();
        assert_eq!(s.get_match(m).unwrap().unwrap().event_offset_ms, -1_500);
    }

    #[test]
    fn recordings_get_their_measured_timing() {
        let (s, dir) = store();
        let id = s.create_session(SessionGame::Valorant, "Valorant", t(0)).unwrap();
        let rec = s.add_recording(id, &dir.join("r.mp4"), t(0)).unwrap();
        s.set_recording_timing(rec, t(0) + ChronoDuration::milliseconds(1_250), 60_000).unwrap();
        let row = &s.recordings(id).unwrap()[0];
        assert_eq!(row.duration_ms, Some(60_000));
        assert_eq!(parse_time(row.started_at.as_deref().unwrap()).unwrap(), t(1) + ChronoDuration::milliseconds(250));
        s.delete_recording(rec).unwrap();
        assert!(s.recordings(id).unwrap().is_empty());
    }
}
