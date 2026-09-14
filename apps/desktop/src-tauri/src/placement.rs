//! Where a clip sits on a match. `clips.db` and `sessions.db` stay separate files, so the join
//! happens here, in wall-clock time: a clip knows when its recording started (`captured_at`),
//! a match file knows when its first frame was (`file_start_at`), and both are UTC.
//!
//! A clip's range is `captured_at` plus its cut span, or plus the whole recording when it has
//! no cut. A clip with several kept parts counts as its outer span, which is also what the
//! editor opens it as.

use std::path::Path;

use anyhow::Result;
use serde::Serialize;

use crate::ffmpeg::Segment;
use crate::queue::{ClipRow, ClipStatus};
use crate::sessions::{parse_time, MatchRow, MatchStatus, SessionStore};

/// A span of wall-clock time in milliseconds since the Unix epoch.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Wall {
    pub start: i64,
    pub end: i64,
}

/// The wall-clock span of a clip's current range. `None` for a clip with no known capture time,
/// which then appears on no match.
pub fn clip_wall(row: &ClipRow) -> Option<Wall> {
    let at = parse_time(row.captured_at.as_deref()?).ok()?.timestamp_millis();
    let (from, to) = match row.cut.as_deref().filter(|c| !c.is_empty()) {
        Some(cut) => (cut[0].start_ms, cut[cut.len() - 1].end_ms),
        None => (0, row.duration_ms),
    };
    (to > from).then_some(Wall { start: at + from, end: at + to })
}

/// The wall-clock span of a match file, for a match that has one.
pub fn match_wall(m: &MatchRow) -> Option<Wall> {
    if m.status != MatchStatus::Ready {
        return None;
    }
    let start = parse_time(m.file_start_at.as_deref()?).ok()?.timestamp_millis();
    let duration = m.duration_ms.filter(|d| *d > 0)?;
    Some(Wall { start, end: start + duration })
}

/// `span` measured in the match file's own milliseconds and clamped to it. `None` when the two
/// do not overlap at all; touching ends are not an overlap.
pub fn in_match(span: Wall, file: Wall) -> Option<Segment> {
    let start = span.start.max(file.start);
    let end = span.end.min(file.end);
    (end > start).then_some(Segment { start_ms: start - file.start, end_ms: end - file.start })
}

/// A clip and a session are from different games only when both say which game and the names
/// differ. The session's name comes from the same `games::name_for` the clip's does, so case
/// and stray spaces are the only differences worth forgiving. An unknown game proves nothing,
/// and the overlap in time is evidence enough.
pub fn same_game(clip: Option<&str>, session: &str) -> bool {
    match clip {
        Some(game) => game.trim().eq_ignore_ascii_case(session.trim()),
        None => true,
    }
}

/// One clip drawn on a match timeline, in match-file milliseconds.
#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct MatchClip {
    pub clip_id: i64,
    pub start_ms: i64,
    pub end_ms: i64,
    pub status: ClipStatus,
    /// The site has it.
    pub published: bool,
}

/// The match a clip was taken in, with the clip's range measured in the match file.
#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct ClipMatch {
    pub match_id: i64,
    pub session_id: i64,
    pub start_ms: i64,
    pub end_ms: i64,
    pub duration_ms: i64,
    pub path: String,
}

/// A match that can be clipped from right now: ready, placed in time, with its file on disk.
#[derive(Debug, Clone)]
pub struct Candidate {
    pub row: MatchRow,
    pub game: String,
    pub wall: Wall,
    pub path: String,
}

/// Every match a clip could be found on. Reads the whole session list, so callers placing
/// many clips build this once.
pub fn candidates(store: &SessionStore) -> Result<Vec<Candidate>> {
    let mut out = Vec::new();
    for session in store.list()? {
        for m in session.matches {
            let Some(wall) = match_wall(&m) else { continue };
            let Some(path) = m.path.clone().filter(|p| Path::new(p).is_file()) else { continue };
            out.push(Candidate { row: m, game: session.game_name.clone(), wall, path });
        }
    }
    Ok(out)
}

/// The candidate that holds the most of the clip. Ties go to the earlier match, which is the
/// order `candidates` returns them in within a session.
pub fn best_match(candidates: &[Candidate], clip: &ClipRow) -> Option<ClipMatch> {
    let wall = clip_wall(clip)?;
    candidates
        .iter()
        .filter(|c| same_game(clip.game.as_deref(), &c.game))
        .filter_map(|c| in_match(wall, c.wall).map(|range| (c, range)))
        .fold(None::<(&Candidate, Segment)>, |best, (c, range)| match best {
            Some((_, kept)) if kept.end_ms - kept.start_ms >= range.end_ms - range.start_ms => best,
            _ => Some((c, range)),
        })
        .map(|(c, range)| ClipMatch {
            match_id: c.row.id,
            session_id: c.row.session_id,
            start_ms: range.start_ms,
            end_ms: range.end_ms,
            duration_ms: c.wall.end - c.wall.start,
            path: c.path.clone(),
        })
}

/// Every clip whose range overlaps a match, clamped to the match, in list order.
pub fn clips_for_match(store: &SessionStore, clips: &[ClipRow], match_id: i64) -> Result<Vec<MatchClip>> {
    let Some(m) = store.get_match(match_id)? else {
        return Ok(Vec::new());
    };
    let Some(file) = match_wall(&m) else {
        return Ok(Vec::new());
    };
    let Some(session) = store.session(m.session_id)? else {
        return Ok(Vec::new());
    };
    Ok(clips
        .iter()
        .filter(|c| same_game(c.game.as_deref(), &session.game_name))
        .filter_map(|c| {
            let range = in_match(clip_wall(c)?, file)?;
            Some(MatchClip {
                clip_id: c.id,
                start_ms: range.start_ms,
                end_ms: range.end_ms,
                status: c.status,
                published: c.remote_id.is_some(),
            })
        })
        .collect())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::queue::{NewClip, Queue};
    use crate::timeline::SessionGame;
    use chrono::{DateTime, Utc};
    use std::path::PathBuf;

    fn t(s: i64) -> DateTime<Utc> {
        DateTime::from_timestamp(1_800_000_000 + s, 0).unwrap()
    }

    fn at(s: i64) -> String {
        crate::sessions::format_time(t(s))
    }

    fn dir() -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "cos-nostra-placement-{}-{}",
            std::process::id(),
            Utc::now().timestamp_nanos_opt().unwrap_or(0)
        ));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn clip(name: &str, game: Option<&str>, captured: Option<i64>, duration_ms: i64) -> NewClip {
        NewClip {
            source_path: format!("C:\\clips\\{name}.mp4"),
            game: game.map(str::to_string),
            title: None,
            recorded_at: "2026-09-13T21:00:00.000Z".into(),
            duration_ms,
            width: 1920,
            height: 1080,
            fps: 60.0,
            size_source: 1,
            participants: None,
            captured_at: captured.map(at),
        }
    }

    #[test]
    fn overlap_is_clamped_to_the_match_and_touching_is_not_overlap() {
        let file = Wall { start: 100_000, end: 160_000 };
        assert_eq!(
            in_match(Wall { start: 110_000, end: 140_000 }, file),
            Some(Segment { start_ms: 10_000, end_ms: 40_000 })
        );
        assert_eq!(
            in_match(Wall { start: 90_000, end: 120_000 }, file),
            Some(Segment { start_ms: 0, end_ms: 20_000 }),
            "a clip that began before the match file is cut at its start"
        );
        assert_eq!(
            in_match(Wall { start: 150_000, end: 190_000 }, file),
            Some(Segment { start_ms: 50_000, end_ms: 60_000 })
        );
        assert_eq!(in_match(Wall { start: 160_000, end: 170_000 }, file), None);
        assert_eq!(in_match(Wall { start: 10_000, end: 100_000 }, file), None);

        assert!(same_game(Some("Valorant"), "Valorant"));
        assert!(same_game(Some(" valorant "), "VALORANT"));
        assert!(same_game(None, "Valorant"), "an unknown game proves nothing");
        assert!(!same_game(Some("League of Legends"), "Valorant"));
    }

    #[test]
    fn a_clip_is_placed_by_its_cut_or_its_whole_recording() {
        let dir = dir();
        let q = Queue::open(&dir.join("clips.db")).unwrap();
        let whole = q.enqueue(clip("whole", None, Some(10), 30_000)).unwrap();
        let cut = q
            .enqueue_with_cut(clip("cut", None, Some(10), 7_000), &[
                Segment { start_ms: 2_000, end_ms: 4_000 },
                Segment { start_ms: 6_000, end_ms: 11_000 },
            ])
            .unwrap();
        let unplaced = q.enqueue(clip("unplaced", None, None, 30_000)).unwrap();
        let ms = |s: i64| t(s).timestamp_millis();
        assert_eq!(
            clip_wall(&q.get(whole).unwrap().unwrap()),
            Some(Wall { start: ms(10), end: ms(40) })
        );
        assert_eq!(
            clip_wall(&q.get(cut).unwrap().unwrap()),
            Some(Wall { start: ms(12), end: ms(21) }),
            "several kept parts count as their outer span"
        );
        assert_eq!(clip_wall(&q.get(unplaced).unwrap().unwrap()), None);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn clips_are_found_on_their_match_and_matches_for_their_clips() {
        let dir = dir();
        let store = SessionStore::open(&dir.join("sessions.db")).unwrap();
        let q = Queue::open(&dir.join("clips.db")).unwrap();
        let session = store.create_session(SessionGame::Valorant, "Valorant", t(0)).unwrap();
        // Two matches back to back: 100..160 s and 150..210 s of wall-clock time.
        let first = store.add_undetected_match(session, t(100), t(160)).unwrap();
        let first_file = dir.join("first.mp4");
        std::fs::write(&first_file, b"x").unwrap();
        store.set_match_file(first, &first_file, None, t(100), 60_000, 1).unwrap();
        let second = store.add_undetected_match(session, t(150), t(210)).unwrap();
        let second_file = dir.join("second.mp4");
        std::fs::write(&second_file, b"x").unwrap();
        store.set_match_file(second, &second_file, None, t(150), 60_000, 1).unwrap();

        let inside = q.enqueue(clip("inside", Some("Valorant"), Some(110), 30_000)).unwrap();
        let early = q.enqueue(clip("early", None, Some(90), 30_000)).unwrap();
        let other_game = q.enqueue(clip("league", Some("League of Legends"), Some(110), 30_000)).unwrap();
        let later = q.enqueue(clip("later", Some("Valorant"), Some(300), 30_000)).unwrap();
        let unplaced = q.enqueue(clip("unplaced", Some("Valorant"), None, 30_000)).unwrap();
        let straddling = q.enqueue(clip("straddling", Some("valorant"), Some(145), 30_000)).unwrap();
        let clips = q.list().unwrap();

        let on_first = clips_for_match(&store, &clips, first).unwrap();
        let find = |id: i64| on_first.iter().find(|c| c.clip_id == id).map(|c| (c.start_ms, c.end_ms));
        assert_eq!(find(inside), Some((10_000, 40_000)));
        assert_eq!(find(early), Some((0, 20_000)), "clamped to the start of the file");
        assert_eq!(find(straddling), Some((45_000, 60_000)), "clamped to the end of the file");
        assert_eq!(find(other_game), None, "another game at the same time is not this match");
        assert_eq!(find(later), None);
        assert_eq!(find(unplaced), None);
        assert!(on_first.iter().all(|c| c.status == ClipStatus::Saved && !c.published));
        assert!(clips_for_match(&store, &clips, 9_999).unwrap().is_empty());

        let cands = candidates(&store).unwrap();
        let row = |id: i64| q.get(id).unwrap().unwrap();
        let found = best_match(&cands, &row(inside)).unwrap();
        assert_eq!((found.match_id, found.session_id), (first, session));
        assert_eq!((found.start_ms, found.end_ms, found.duration_ms), (10_000, 40_000, 60_000));
        assert_eq!(found.path, first_file.display().to_string());
        // 145..175 s: 15 s of the first match, 25 s of the second. The bigger share wins.
        let found = best_match(&cands, &row(straddling)).unwrap();
        assert_eq!((found.match_id, found.start_ms, found.end_ms), (second, 0, 25_000));
        assert_eq!(best_match(&cands, &row(other_game)), None);
        assert_eq!(best_match(&cands, &row(later)), None);
        assert_eq!(best_match(&cands, &row(unplaced)), None);

        // A match whose file is gone (the storage limit took it) cannot be clipped from.
        std::fs::remove_file(&second_file).unwrap();
        let cands = candidates(&store).unwrap();
        assert_eq!(best_match(&cands, &row(straddling)).map(|m| m.match_id), Some(first));
        let _ = std::fs::remove_dir_all(&dir);
    }
}
