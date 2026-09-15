//! Turns a finished session into match files.
//!
//! Each recording is measured first: its end is when the recorder was told to stop, its start
//! is that minus the probed duration. Each match then gets the footage its span (plus the
//! rolls) covers, stream-copied from the nearest keyframe so nothing is re-encoded, and a
//! thumbnail. Once every match has its file, the raw recordings go: the menus, the queues and
//! the agent selects in between were never going to be watched.
//!
//! Two cases keep footage no match claimed. A game with no provider, or a provider that never
//! reached the game, marks nothing, so each recording becomes one undetected "match" (renamed,
//! not copied). A provider that worked and saw no match at all means the session was menus and
//! the range, and it is discarded whole.
//!
//! Idempotent: a match that already has its file is skipped, and recordings are only deleted
//! after every match is settled, so a crash mid-way just runs again at the next start.

use std::path::{Path, PathBuf};

use anyhow::{Context, Result};
use chrono::{DateTime, Duration, Local, Utc};

use crate::ffmpeg::{self, Binaries};
use crate::sessions::{parse_time, MatchRow, MatchStatus, RecordingRow, SessionRow, SessionStatus, SessionStore};
use crate::timeline::{self, Covered, Piece, Span};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Processed {
    /// The session had nothing worth keeping and is gone.
    Discarded,
    /// Every match has its file.
    Ready { matches: usize },
    /// Some match could not be cut; the recordings are still on disk for another try.
    Failed,
}

/// A recording that could be measured.
struct Measured {
    row: RecordingRow,
    span: Span,
    duration_ms: i64,
}

pub fn process(store: &SessionStore, bins: &Binaries, session_id: i64) -> Result<Processed> {
    let Some(session) = store.session(session_id)? else {
        return Ok(Processed::Discarded);
    };
    log::info!("processing session {session_id} ({}, {} matches)", session.game_name, session.matches.len());

    let mut problems: Vec<String> = Vec::new();
    let measured = measure(store, bins, &session, &mut problems)?;

    let mut matches = session.matches.clone();
    if matches.is_empty() {
        if session.provider_reached && problems.is_empty() {
            log::info!("session {session_id}: the game was reachable and no match was played; discarding");
            remove_files(measured.iter().map(|m| m.row.path.as_str()));
            store.delete_session(session_id)?;
            return Ok(Processed::Discarded);
        }
        for m in &measured {
            store.add_undetected_match(session_id, m.span.start, m.span.end)?;
        }
        matches = store.session(session_id)?.map(|s| s.matches).unwrap_or_default();
    }

    let covered: Vec<Covered> = measured
        .iter()
        .map(|m| Covered { recording: m.row.id, span: m.span })
        .collect();
    let session_end = session
        .ended_at
        .as_deref()
        .map(parse_time)
        .transpose()?
        .or_else(|| covered.iter().map(|c| c.span.end).max());

    // Recordings renamed into a match file are no longer ours to delete.
    let mut consumed: Vec<i64> = Vec::new();
    let mut failed = false;
    for m in &matches {
        if m.status == MatchStatus::Ready && m.path.as_deref().is_some_and(|p| Path::new(p).is_file()) {
            continue;
        }
        match cut_match(store, bins, &session, m, &measured, &covered, session_end, &mut consumed) {
            Ok(true) => {}
            Ok(false) => {
                store.set_match_status(m.id, MatchStatus::Missing, Some("no recording covers this match"))?;
            }
            Err(e) => {
                let text = format!("{e:#}");
                log::error!("session {session_id}: match {} could not be cut: {text}", m.id);
                store.set_match_status(m.id, MatchStatus::Failed, Some(&text))?;
                problems.push(text);
                failed = true;
            }
        }
    }

    if failed {
        store.set_session_status(session_id, SessionStatus::Failed, Some(&problems.join("\n")))?;
        return Ok(Processed::Failed);
    }

    for m in &measured {
        if !consumed.contains(&m.row.id) {
            remove_files([m.row.path.as_str()]);
        }
        store.delete_recording(m.row.id)?;
    }
    let error = (!problems.is_empty()).then(|| problems.join("\n"));
    store.set_session_status(session_id, SessionStatus::Ready, error.as_deref())?;
    let ready = store
        .session(session_id)?
        .map(|s| s.matches.iter().filter(|m| m.status == MatchStatus::Ready).count())
        .unwrap_or(0);
    log::info!("session {session_id}: {ready} match file(s) ready");
    Ok(Processed::Ready { matches: ready })
}

/// Probes every recording of the session and settles when it started. Recordings whose file
/// is gone or unreadable are reported and left out.
fn measure(
    store: &SessionStore,
    bins: &Binaries,
    session: &SessionRow,
    problems: &mut Vec<String>,
) -> Result<Vec<Measured>> {
    let mut probed: Vec<(RecordingRow, i64)> = Vec::new();
    for row in store.recordings(session.id)? {
        let path = Path::new(&row.path);
        if !path.is_file() {
            log::warn!("session {}: recording {} is missing", session.id, row.path);
            store.delete_recording(row.id)?;
            continue;
        }
        match ffmpeg::probe(bins, path) {
            Ok(info) if info.duration_ms > 0 => probed.push((row, info.duration_ms)),
            Ok(_) => problems.push(format!("{} has no footage", row.path)),
            Err(e) => problems.push(format!("{} could not be read: {e:#}", row.path)),
        }
    }

    // Latest first, so a part split off without a gap finds when the part after it started:
    // that is exactly where it ends. Only the last part of a chain needs its stop time.
    let mut starts: std::collections::HashMap<i64, DateTime<Utc>> = std::collections::HashMap::new();
    let mut out = Vec::new();
    for (row, duration_ms) in probed.iter().rev() {
        let duration = Duration::milliseconds(*duration_ms);
        let next_start = probed
            .iter()
            .find(|(later, _)| later.follows == Some(row.id))
            .and_then(|(later, _)| starts.get(&later.id))
            .copied();
        let start = match next_start {
            Some(end) => end - duration,
            None => {
                let requested = parse_time(&row.requested_at)?;
                // The file ends where the stop was asked for. Without a stop (a crash) or with a
                // stop that cannot hold that much footage, count from the start request instead.
                match row.stopped_at.as_deref().map(parse_time).transpose()? {
                    Some(stopped) if stopped - duration >= requested - Duration::seconds(5) => stopped - duration,
                    _ => requested,
                }
            }
        };
        starts.insert(row.id, start);
        store.set_recording_timing(row.id, start, *duration_ms)?;
        out.push(Measured {
            span: Span { start, end: start + duration },
            duration_ms: *duration_ms,
            row: row.clone(),
        });
    }
    out.reverse();
    Ok(out)
}

/// Cuts one match. `Ok(false)` when no footage covers it.
#[allow(clippy::too_many_arguments)]
fn cut_match(
    store: &SessionStore,
    bins: &Binaries,
    session: &SessionRow,
    m: &MatchRow,
    measured: &[Measured],
    covered: &[Covered],
    session_end: Option<DateTime<Utc>>,
    consumed: &mut Vec<i64>,
) -> Result<bool> {
    let start = parse_time(&m.started_at)?;
    let end = match m.ended_at.as_deref() {
        Some(e) => parse_time(e)?,
        None => session_end.unwrap_or(start),
    };
    let want = if m.detected { timeline::wanted(start, end) } else { Span { start, end } };
    let pieces = timeline::pieces(want, covered);
    let Some(first) = pieces.first() else {
        return Ok(false);
    };
    let recording = |p: &Piece| measured.iter().find(|r| r.row.id == p.recording).expect("pieces come from these recordings");

    let dir = Path::new(&recording(first).row.path)
        .parent()
        .map(Path::to_path_buf)
        .unwrap_or_default();
    let dst = unique(&dir, &file_stem(session, m, start));

    let file_start;
    if let [only] = pieces.as_slice() {
        let rec = recording(only);
        let whole = only.from_ms <= 0 && only.to_ms >= rec.duration_ms - 500;
        if whole && !m.detected {
            std::fs::rename(&rec.row.path, &dst)
                .with_context(|| format!("renaming {} to {}", rec.row.path, dst.display()))?;
            consumed.push(rec.row.id);
            file_start = rec.span.start;
        } else {
            let from = ffmpeg::keyframe_at_or_before(bins, Path::new(&rec.row.path), only.from_ms)?;
            ffmpeg::copy_range(bins, Path::new(&rec.row.path), from, only.to_ms, &dst)?;
            file_start = rec.span.start + Duration::milliseconds(from);
        }
    } else {
        // A recorder restart mid-match: copy each side and join them. Events after the gap
        // land early by the length of the gap; that is the price of one file per match.
        let mut parts: Vec<PathBuf> = Vec::new();
        let mut first_start = None;
        for (i, p) in pieces.iter().enumerate() {
            let rec = recording(p);
            let from = ffmpeg::keyframe_at_or_before(bins, Path::new(&rec.row.path), p.from_ms)?;
            let part = dst.with_extension(format!("piece{i}.mp4"));
            ffmpeg::copy_range(bins, Path::new(&rec.row.path), from, p.to_ms, &part)?;
            first_start.get_or_insert(rec.span.start + Duration::milliseconds(from));
            parts.push(part);
        }
        let joined = ffmpeg::concat_copy(bins, &parts, &dst);
        remove_files(parts.iter().filter_map(|p| p.to_str()));
        joined?;
        file_start = first_start.expect("at least one piece");
    }

    let info = ffmpeg::probe(bins, &dst).with_context(|| format!("probing {}", dst.display()))?;
    let thumb = dst.with_extension("jpg");
    // A third of the way in is past the load screen and usually mid-round.
    let thumb = match ffmpeg::thumbnail(bins, &dst, &thumb, info.duration_ms / 3) {
        Ok(()) => Some(thumb),
        Err(e) => {
            log::warn!("thumbnail for match {} failed: {e:#}", m.id);
            None
        }
    };
    store.set_match_file(m.id, &dst, thumb.as_deref(), file_start, info.duration_ms, info.size as i64)?;
    log::info!("match {} -> {} ({} ms)", m.id, dst.display(), info.duration_ms);
    Ok(true)
}

/// `2026-09-13 21-04 Valorant - Ascent (Competitive)`, or `... Valorant session` when nothing
/// was detected.
fn file_stem(session: &SessionRow, m: &MatchRow, start: DateTime<Utc>) -> String {
    let when = start.with_timezone(&Local).format("%Y-%m-%d %H-%M");
    let what = if m.detected {
        match (m.map.as_deref(), m.mode.as_deref()) {
            (Some(map), Some(mode)) => format!("{} - {map} ({mode})", session.game_name),
            (Some(map), None) => format!("{} - {map}", session.game_name),
            (None, Some(mode)) => format!("{} - {mode}", session.game_name),
            (None, None) => format!("{} match", session.game_name),
        }
    } else {
        format!("{} session", session.game_name)
    };
    sanitize(&format!("{when} {what}"))
}

fn sanitize(name: &str) -> String {
    name.chars()
        .map(|c| if matches!(c, '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*') || c.is_control() { '_' } else { c })
        .collect::<String>()
        .trim_end_matches(['.', ' '])
        .to_string()
}

/// `<dir>/<stem>.mp4`, or `<stem> 2.mp4` and up when that exists.
pub fn unique(dir: &Path, stem: &str) -> PathBuf {
    let first = dir.join(format!("{stem}.mp4"));
    if !first.exists() {
        return first;
    }
    (2..)
        .map(|n| dir.join(format!("{stem} {n}.mp4")))
        .find(|p| !p.exists())
        .expect("some suffix is free")
}

fn remove_files<'a>(paths: impl IntoIterator<Item = &'a str>) {
    for p in paths {
        match std::fs::remove_file(p) {
            Ok(()) => log::info!("deleted {p}"),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(e) => log::warn!("could not delete {p}: {e}"),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::timeline::{Event, GameEvent, Outcome, SessionGame};

    fn bins() -> Binaries {
        ffmpeg::locate().expect("ffmpeg must be reachable for these tests")
    }

    fn dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "cos-nostra-cutter-{name}-{}-{}",
            std::process::id(),
            std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    /// `seconds` of footage with a keyframe every second.
    fn recording(bins: &Binaries, path: &Path, seconds: u32) {
        let mut cmd = std::process::Command::new(&bins.ffmpeg);
        cmd.args(["-hide_banner", "-nostdin", "-y", "-v", "error"])
            .args(["-f", "lavfi", "-i", "testsrc2=size=320x180:rate=30"])
            .args(["-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000"])
            .args(["-t", &seconds.to_string(), "-c:v", "libx264", "-preset", "ultrafast"])
            .args(["-g", "30", "-keyint_min", "30", "-sc_threshold", "0", "-pix_fmt", "yuv420p"])
            .args(["-c:a", "aac", "-b:a", "64k"])
            .arg(path);
        assert!(cmd.status().unwrap().success());
    }

    fn t(s: i64) -> DateTime<Utc> {
        DateTime::from_timestamp(1_800_000_000 + s, 0).unwrap()
    }

    #[test]
    fn cuts_a_detected_match_and_drops_the_rest() {
        let bins = bins();
        let dir = dir("detected");
        let store = SessionStore::open(&dir.join("sessions.db")).unwrap();
        let id = store.create_session(SessionGame::Valorant, "Valorant", t(0)).unwrap();

        // 40 s of session footage, requested at 0 and stopped at 40.
        let raw = dir.join("session-1-1.mp4");
        recording(&bins, &raw, 40);
        let rec = store.add_recording(id, &raw, t(0)).unwrap();
        store.stop_recording(rec, t(40)).unwrap();

        // A match from 15 s to 25 s: with the rolls, 5 s to 33 s of the file.
        let m = store.open_match(id, t(15), Some("Ascent"), Some("Competitive")).unwrap();
        store
            .add_event(id, Some(m), &GameEvent { at: t(20), event: Event::RoundEnd { round: 1, ally: 1, enemy: 0, won: Some(true) } })
            .unwrap();
        store.close_match(m, t(25), Some(13), Some(1), Some(Outcome::Win)).unwrap();
        store.set_provider_reached(id).unwrap();
        store.end_session(id, t(40)).unwrap();

        assert_eq!(process(&store, &bins, id).unwrap(), Processed::Ready { matches: 1 });

        let session = store.session(id).unwrap().unwrap();
        assert_eq!(session.status, SessionStatus::Ready);
        let row = &session.matches[0];
        assert_eq!(row.status, MatchStatus::Ready);
        let path = PathBuf::from(row.path.as_deref().unwrap());
        assert!(path.is_file());
        assert!(path.file_name().unwrap().to_string_lossy().contains("Valorant - Ascent (Competitive)"));
        assert!(Path::new(row.thumb_path.as_deref().unwrap()).is_file());
        let duration = row.duration_ms.unwrap();
        assert!((duration - 28_000).abs() <= 150, "match file is {duration} ms");
        // The file starts on the keyframe at 5 s, so the round end sits 15 s in. The sample's
        // container runs a few ms past 40 s (audio priming), which moves the measured start.
        let start = parse_time(row.file_start_at.as_deref().unwrap()).unwrap();
        assert!((start - t(5)).num_milliseconds().abs() <= 100, "file starts at {start}");

        assert!(!raw.exists(), "the raw recording is gone");
        assert!(store.recordings(id).unwrap().is_empty());
        // Running it again is a no-op.
        assert_eq!(process(&store, &bins, id).unwrap(), Processed::Ready { matches: 1 });
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn keeps_undetected_footage_by_renaming_it() {
        let bins = bins();
        let dir = dir("undetected");
        let store = SessionStore::open(&dir.join("sessions.db")).unwrap();
        let id = store.create_session(SessionGame::CounterStrike, "Counter-Strike 2", t(0)).unwrap();
        let raw = dir.join("session-1-1.mp4");
        recording(&bins, &raw, 4);
        let rec = store.add_recording(id, &raw, t(0)).unwrap();
        store.stop_recording(rec, t(4)).unwrap();
        store.end_session(id, t(4)).unwrap();

        assert_eq!(process(&store, &bins, id).unwrap(), Processed::Ready { matches: 1 });
        let session = store.session(id).unwrap().unwrap();
        let m = &session.matches[0];
        assert!(!m.detected);
        let path = PathBuf::from(m.path.as_deref().unwrap());
        assert!(path.file_name().unwrap().to_string_lossy().ends_with("Counter-Strike 2 session.mp4"));
        assert!(path.is_file());
        assert!(!raw.exists(), "renamed, not copied");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn discards_a_session_of_menus() {
        let bins = bins();
        let dir = dir("menus");
        let store = SessionStore::open(&dir.join("sessions.db")).unwrap();
        let id = store.create_session(SessionGame::Valorant, "Valorant", t(0)).unwrap();
        let raw = dir.join("session-1-1.mp4");
        recording(&bins, &raw, 2);
        store.add_recording(id, &raw, t(0)).unwrap();
        store.set_provider_reached(id).unwrap();
        store.end_session(id, t(2)).unwrap();

        assert_eq!(process(&store, &bins, id).unwrap(), Processed::Discarded);
        assert!(store.session(id).unwrap().is_none());
        assert!(!raw.exists());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_match_split_by_a_recorder_restart_is_joined() {
        let bins = bins();
        let dir = dir("split");
        let store = SessionStore::open(&dir.join("sessions.db")).unwrap();
        let id = store.create_session(SessionGame::Valorant, "Valorant", t(0)).unwrap();
        let a = dir.join("session-1-1.mp4");
        let b = dir.join("session-1-2.mp4");
        recording(&bins, &a, 20);
        recording(&bins, &b, 20);
        let ra = store.add_recording(id, &a, t(0)).unwrap();
        store.stop_recording(ra, t(20)).unwrap();
        let rb = store.add_recording(id, &b, t(22)).unwrap();
        store.stop_recording(rb, t(42)).unwrap();
        let m = store.open_match(id, t(25), None, None).unwrap();
        store.close_match(m, t(30), None, None, None).unwrap();
        // A match entirely inside the gap has no footage.
        let gap = store.open_match(id, t(60), None, None).unwrap();
        store.close_match(gap, t(70), None, None, None).unwrap();
        store.end_session(id, t(80)).unwrap();

        assert_eq!(process(&store, &bins, id).unwrap(), Processed::Ready { matches: 1 });
        let session = store.session(id).unwrap().unwrap();
        let joined = &session.matches[0];
        assert_eq!(joined.status, MatchStatus::Ready);
        // 15..20 of the first file, then 0..16 of the second (the match wants 15..38).
        let duration = joined.duration_ms.unwrap();
        assert!((duration - 21_000).abs() <= 300, "joined match is {duration} ms");
        let start = parse_time(joined.file_start_at.as_deref().unwrap()).unwrap();
        assert!((start - t(15)).num_milliseconds().abs() <= 100, "file starts at {start}");
        assert_eq!(session.matches[1].status, MatchStatus::Missing);
        assert!(std::fs::read_dir(&dir).unwrap().flatten().all(|e| !e.file_name().to_string_lossy().contains(".piece")));
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// Parts split without a gap are timed back from the stop of the last one, whatever the
    /// split was noticed at, and each is kept whole for a game with no provider.
    #[test]
    fn parts_of_a_split_recording_are_timed_from_the_last_stop() {
        let bins = bins();
        let dir = dir("split-parts");
        let store = SessionStore::open(&dir.join("sessions.db")).unwrap();
        let id = store.create_session(SessionGame::Other, "Hades II", t(0)).unwrap();
        let (a, b) = (dir.join("session-1-1.mp4"), dir.join("session-1-1-part.mp4"));
        recording(&bins, &a, 6);
        recording(&bins, &b, 4);
        let ra = store.add_recording(id, &a, t(0)).unwrap();
        // The split was noticed a second and a half late, and so was the stop of the first part.
        store.stop_recording(ra, t(7) + Duration::milliseconds(500)).unwrap();
        let rb = store.add_recording_after(id, &b, t(7) + Duration::milliseconds(500), Some(ra)).unwrap();
        store.stop_recording(rb, t(10)).unwrap();
        store.end_session(id, t(10)).unwrap();

        assert_eq!(process(&store, &bins, id).unwrap(), Processed::Ready { matches: 2 });
        let session = store.session(id).unwrap().unwrap();
        let starts: Vec<DateTime<Utc>> = session
            .matches
            .iter()
            .map(|m| parse_time(m.file_start_at.as_deref().unwrap()).unwrap())
            .collect();
        // The second part ends at the stop; the first ends exactly where the second begins.
        assert!((starts[1] - t(6)).num_milliseconds().abs() <= 100, "second part starts at {}", starts[1]);
        assert!((starts[0] - t(0)).num_milliseconds().abs() <= 150, "first part starts at {}", starts[0]);
        assert!(session.matches.iter().all(|m| !m.detected && m.status == MatchStatus::Ready));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn names_are_filesystem_safe() {
        assert_eq!(sanitize("a:b/c?d. "), "a_b_c_d");
        let d = dir("unique");
        std::fs::write(d.join("x.mp4"), b"").unwrap();
        assert_eq!(unique(&d, "x"), d.join("x 2.mp4"));
        let _ = std::fs::remove_dir_all(&d);
    }
}
