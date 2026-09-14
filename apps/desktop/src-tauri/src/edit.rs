//! The editor's model: one range on a match. A clip opens on the match it was taken in when
//! that match is still on this PC, and on its own recording otherwise; either way it is one
//! kept range with a start and an end.
//!
//! Apply has three outcomes. A range inside the footage the clip already has becomes a cut on
//! that file. A range that reaches past it takes a fresh copy of the footage (plus a margin)
//! out of the match, which becomes the clip's recording, so the clip no longer depends on the
//! match surviving the storage limit. A published clip then goes back through the encoder and
//! replaces itself on the site; a local one is not encoded at all.

use std::path::{Path, PathBuf};

use anyhow::{bail, Context, Result};
use chrono::{DateTime, Duration, Local, Utc};
use serde::{Deserialize, Serialize};

use crate::cutter;
use crate::ffmpeg::{self, Binaries, Cut, Segment, MIN_SEGMENT_MS};
use crate::placement::{self, Wall};
use crate::queue::{ClipRow, ClipStatus, Queue, Rebased};
use crate::sessions::{format_time, parse_time, SessionStore};
use crate::storage;

/// Footage kept either side of a range copied into a new recording, so the next edit can still
/// widen it a little without going back to the match.
pub const MARGIN_MS: i64 = 3_000;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SourceKind {
    Match,
    Clip,
}

/// What the editor loads for a clip.
#[derive(Debug, Clone, Serialize)]
pub struct EditSource {
    pub kind: SourceKind,
    /// The file the editor plays: the match file, or the clip's own recording (or its encoded
    /// copy once the recording is gone).
    pub path: String,
    pub match_id: Option<i64>,
    pub duration_ms: i64,
    pub fps: f64,
    pub width: u32,
    pub height: u32,
    pub has_audio: bool,
    /// The clip's current range, in `path` milliseconds.
    pub range: Segment,
    /// Where the footage the clip already has sits in `path`, for the editor to draw. `None`
    /// when the clip has no video on this PC.
    pub clip_span: Option<Segment>,
    /// True when the clip's own file is the untouched recording. False means the encoded copy
    /// is all there is; on its own source that makes Apply permanent.
    pub original: bool,
    /// The stored cut has several kept parts, which Apply will turn into one range.
    pub multi_part: bool,
}

/// What `apply` did, so the caller knows whether to wake the worker.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Applied {
    /// The range is the one the clip already had.
    Unchanged,
    /// A cut on the file the clip already has.
    Cut,
    /// A new recording taken out of the match or the encoded copy.
    Rebased,
}

/// The file an edit applies to: the original recording while it is still here, otherwise the
/// best encoded copy. `None` when the clip has no video on this PC.
pub fn edit_source_path(row: &ClipRow) -> Option<(String, bool)> {
    if Path::new(&row.source_path).is_file() {
        return Some((row.source_path.clone(), true));
    }
    [&row.h264_path, &row.av1_path]
        .into_iter()
        .flatten()
        .find(|p| Path::new(p).is_file())
        .map(|p| (p.clone(), false))
}

/// Wall-clock time of the first frame of the file `edit_source_path` picked. The recording
/// starts at `captured_at`; an encoded copy of it starts where the cut it was made with began.
///
/// That holds for every copy this build makes: an edit never leaves a cut measured against a
/// copy behind, because a copy is never cut in place (see `apply`), and baking a cut moves
/// `captured_at` (`Queue::bake_cut`).
pub fn file_start(row: &ClipRow, original: bool) -> Option<DateTime<Utc>> {
    let at = parse_time(row.captured_at.as_deref()?).ok()?;
    let shift = if original {
        0
    } else {
        row.cut.as_ref().and_then(|c| c.first()).map_or(0, |s| s.start_ms)
    };
    Some(at + Duration::milliseconds(shift))
}

fn wall_of(start: DateTime<Utc>, duration_ms: i64) -> Wall {
    let start = start.timestamp_millis();
    Wall { start, end: start + duration_ms }
}

fn busy(row: &ClipRow) -> bool {
    matches!(row.status, ClipStatus::Encoding | ClipStatus::Uploading)
}

/// Probes what the editor should load for a clip.
pub fn open(bins: &Binaries, queue: &Queue, store: Option<&SessionStore>, id: i64) -> Result<EditSource> {
    let row = queue.get(id)?.with_context(|| format!("clip {id} not found"))?;
    let own = edit_source_path(&row);
    let multi_part = row.cut.as_ref().is_some_and(|c| c.len() > 1);

    let found = match store {
        Some(store) => placement::best_match(&placement::candidates(store)?, &row),
        None => None,
    };
    if let Some(m) = found {
        let info = ffmpeg::probe(bins, Path::new(&m.path)).context("probing the match")?;
        let match_start = m_start(store.expect("a match came from the store"), m.match_id)?;
        let clip_span = match &own {
            Some((path, original)) => {
                let own_info = ffmpeg::probe(bins, Path::new(path)).context("probing the clip")?;
                file_start(&row, *original)
                    .and_then(|s| placement::in_match(wall_of(s, own_info.duration_ms), wall_of(match_start, info.duration_ms)))
            }
            None => None,
        };
        return Ok(EditSource {
            kind: SourceKind::Match,
            path: m.path,
            match_id: Some(m.match_id),
            duration_ms: info.duration_ms,
            fps: info.fps,
            width: info.width,
            height: info.height,
            has_audio: info.has_audio,
            range: Segment { start_ms: m.start_ms, end_ms: m.end_ms.min(info.duration_ms) },
            clip_span,
            original: own.as_ref().is_some_and(|(_, o)| *o),
            multi_part,
        });
    }

    let (path, original) = own.context("this clip has no video on this PC to edit")?;
    let info = ffmpeg::probe(bins, Path::new(&path)).context("probing the clip")?;
    // A cut only means something against the recording it was made on.
    let range = match row.cut.as_deref().filter(|c| original && !c.is_empty()) {
        Some(cut) => Segment {
            start_ms: cut[0].start_ms.clamp(0, info.duration_ms),
            end_ms: cut[cut.len() - 1].end_ms.clamp(0, info.duration_ms),
        },
        None => Segment { start_ms: 0, end_ms: info.duration_ms },
    };
    Ok(EditSource {
        kind: SourceKind::Clip,
        path,
        match_id: None,
        duration_ms: info.duration_ms,
        fps: info.fps,
        width: info.width,
        height: info.height,
        has_audio: info.has_audio,
        range,
        clip_span: Some(Segment { start_ms: 0, end_ms: info.duration_ms }),
        original,
        multi_part: original && multi_part,
    })
}

fn m_start(store: &SessionStore, match_id: i64) -> Result<DateTime<Utc>> {
    let m = store.get_match(match_id)?.with_context(|| format!("match {match_id} not found"))?;
    parse_time(m.file_start_at.as_deref().context("this match has no start time")?)
}

/// Applies the editor's range to a clip. `start_ms..end_ms` is measured in the file of `kind`.
pub fn apply(
    bins: &Binaries,
    queue: &Queue,
    store: Option<&SessionStore>,
    clip_dir: &Path,
    id: i64,
    kind: SourceKind,
    start_ms: i64,
    end_ms: i64,
) -> Result<Applied> {
    let row = queue.get(id)?.with_context(|| format!("clip {id} not found"))?;
    if busy(&row) {
        bail!("this clip is busy right now; wait for the current job to finish");
    }
    let own = edit_source_path(&row);

    match kind {
        SourceKind::Match => {
            let store = store.context("the session database is not available")?;
            let m = placement::best_match(&placement::candidates(store)?, &row)
                .context("the match this clip was taken in is no longer on this PC")?;
            let match_path = PathBuf::from(&m.path);
            let match_info = ffmpeg::probe(bins, &match_path).context("probing the match")?;
            let match_start = m_start(store, m.match_id)?;
            let (start, end) = checked_range(start_ms, end_ms, match_info.duration_ms)?;

            // Inside the recording the clip already has: a cut on it. An encoded copy is never
            // cut in place when the match is here to copy from instead, which keeps the
            // original quality and never makes a cut permanent.
            if let Some((path, true)) = &own {
                let info = ffmpeg::probe(bins, Path::new(path)).context("probing the clip")?;
                if let Some(fs) = file_start(&row, true) {
                    let span = placement::in_match(wall_of(fs, info.duration_ms), wall_of(match_start, match_info.duration_ms));
                    if span.is_some_and(|s| start >= s.start_ms && end <= s.end_ms) {
                        let offset = match_start.timestamp_millis() - fs.timestamp_millis();
                        return cut_in_place(bins, queue, &row, info.duration_ms, start + offset, end + offset);
                    }
                }
            }
            rebuild(bins, queue, &row, clip_dir, &match_path, match_start, match_info.duration_ms, start, end)
        }
        SourceKind::Clip => {
            let (path, original) = own.context("this clip has no video on this PC to edit")?;
            let info = ffmpeg::probe(bins, Path::new(&path)).context("probing the clip")?;
            let (start, end) = checked_range(start_ms, end_ms, info.duration_ms)?;
            if original {
                return cut_in_place(bins, queue, &row, info.duration_ms, start, end);
            }
            // Only the encoded copy is left. Stream-copying the range out of it gives the clip a
            // recording again, so the cut is an ordinary one rather than a range measured
            // against a file the next encode overwrites.
            let copy_start = file_start(&row, false).unwrap_or_else(Utc::now);
            rebuild(bins, queue, &row, clip_dir, Path::new(&path), copy_start, info.duration_ms, start, end)
        }
    }
}

fn checked_range(start_ms: i64, end_ms: i64, duration_ms: i64) -> Result<(i64, i64)> {
    let start = start_ms.clamp(0, duration_ms);
    let end = end_ms.clamp(0, duration_ms);
    if end - start < MIN_SEGMENT_MS {
        bail!("a clip needs at least {MIN_SEGMENT_MS} ms");
    }
    Ok((start, end))
}

/// A range on the recording the clip already has.
fn cut_in_place(
    bins: &Binaries,
    queue: &Queue,
    row: &ClipRow,
    file_ms: i64,
    start: i64,
    end: i64,
) -> Result<Applied> {
    let cut = Cut::normalize(&[Segment { start_ms: start, end_ms: end }], file_ms)?;
    let stored = if cut.is_whole() { None } else { Some(cut.segments.as_slice()) };
    let current = row.cut.clone().unwrap_or_default();
    let published = row.publish || row.remote_id.is_some();

    if published {
        let settled = matches!(row.status, ClipStatus::Encoded | ClipStatus::Done);
        if settled && cut.segments == current {
            log::info!("clip {}: range unchanged, nothing to re-encode", row.id);
            return Ok(Applied::Unchanged);
        }
        queue.request_reencode(row.id, stored)?;
        log::info!("clip {}: re-encode requested for {start}..{end} ms", row.id);
        return Ok(Applied::Cut);
    }

    let stale = [&row.av1_path, &row.h264_path].into_iter().flatten().cloned().collect::<Vec<_>>();
    if cut.segments == current && row.status == ClipStatus::Saved && stale.is_empty() {
        return Ok(Applied::Unchanged);
    }
    queue.set_local_cut(row.id, stored, cut.kept_ms(file_ms))?;
    // Encoded copies of the old range would only ever mislead: a later Publish must encode the
    // new one. The recording itself is the source, so nothing is lost.
    remove_files(stale.iter().map(String::as_str));
    if let Err(e) = refresh_thumbnail(bins, queue, row.id) {
        log::warn!("clip {}: thumbnail after the edit failed: {e:#}", row.id);
    }
    log::info!("clip {}: kept {start}..{end} ms, still local", row.id);
    Ok(Applied::Cut)
}

/// Copies `start - MARGIN..end + MARGIN` of `src` into a new recording in the clip folder and
/// points the clip at it. The old recording, outputs and thumbnail are deleted only once the
/// row points at the new file.
#[allow(clippy::too_many_arguments)]
fn rebuild(
    bins: &Binaries,
    queue: &Queue,
    row: &ClipRow,
    clip_dir: &Path,
    src: &Path,
    src_start: DateTime<Utc>,
    src_ms: i64,
    start: i64,
    end: i64,
) -> Result<Applied> {
    let from = ffmpeg::keyframe_at_or_before(bins, src, (start - MARGIN_MS).max(0))?;
    let to = (end + MARGIN_MS).min(src_ms);
    // Named like the replay buffer names its clips, after the moment the clip starts.
    let moment = src_start + Duration::milliseconds(start);
    let stem = moment.with_timezone(&Local).format("%Y-%m-%d %H-%M-%S").to_string();
    std::fs::create_dir_all(clip_dir).with_context(|| format!("creating {}", clip_dir.display()))?;
    let dst = cutter::unique(clip_dir, &stem);
    ffmpeg::copy_range(bins, src, from, to, &dst)?;

    let (_, _, new_thumb) = storage::output_paths(&dst);
    let rebased = (|| -> Result<Rebased> {
        let info = ffmpeg::probe(bins, &dst)?;
        let cut = Cut::normalize(
            &[Segment { start_ms: start - from, end_ms: (end - from).min(info.duration_ms) }],
            info.duration_ms,
        )?;
        // Before the row points here: a published clip is the worker's the moment it does, and
        // the encoder writes this same thumbnail, so two ffmpegs must not race for the file.
        let thumb = match ffmpeg::thumbnail(bins, &dst, &new_thumb, cut.source_time_at(0.25, info.duration_ms)) {
            Ok(()) => Some(new_thumb.display().to_string()),
            Err(e) => {
                log::warn!("clip {}: thumbnail for the new recording failed: {e:#}", row.id);
                None
            }
        };
        let rebased = Rebased {
            source_path: dst.display().to_string(),
            captured_at: format_time(src_start + Duration::milliseconds(from)),
            duration_ms: cut.kept_ms(info.duration_ms),
            cut: (!cut.is_whole()).then_some(cut.segments),
            size_source: info.size as i64,
            width: info.width,
            height: info.height,
            fps: info.fps,
            thumb_path: thumb,
        };
        queue.rebase(row.id, &rebased)?;
        Ok(rebased)
    })();
    if let Err(e) = rebased {
        remove_files([dst.display().to_string(), new_thumb.display().to_string()].iter().map(String::as_str));
        return Err(e);
    }

    let (av1, h264, thumb) = storage::output_paths(Path::new(&row.source_path));
    let mut old: Vec<String> = vec![row.source_path.clone()];
    old.extend([&row.av1_path, &row.h264_path, &row.thumb_path].into_iter().flatten().cloned());
    old.extend([av1, h264, thumb].iter().map(|p| p.display().to_string()));
    let keep = [dst.display().to_string(), new_thumb.display().to_string()];
    old.retain(|p| !keep.iter().any(|k| p.eq_ignore_ascii_case(k)));
    remove_files(old.iter().map(String::as_str));

    log::info!(
        "clip {}: new recording {} ({from}..{to} ms of {})",
        row.id,
        dst.display(),
        src.display()
    );
    Ok(Applied::Rebased)
}

/// Writes a clip's thumbnail from inside its current range, for clips that are not going
/// through the encoder (which makes its own). Named like the encoder names it, so a later encode
/// simply overwrites it.
pub fn refresh_thumbnail(bins: &Binaries, queue: &Queue, id: i64) -> Result<()> {
    let row = queue.get(id)?.with_context(|| format!("clip {id} not found"))?;
    let (path, original) = edit_source_path(&row).context("the clip has no video on this PC")?;
    let cut = Cut {
        segments: if original { row.cut.clone().unwrap_or_default() } else { Vec::new() },
    };
    let at = cut.source_time_at(0.25, row.duration_ms);
    let (_, _, thumb) = storage::output_paths(Path::new(&row.source_path));
    ffmpeg::thumbnail(bins, Path::new(&path), &thumb, at)?;
    queue.set_thumb(id, &thumb.display().to_string())
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
    use crate::queue::{NewClip, Outputs};
    use crate::timeline::SessionGame;

    fn t(s: i64) -> DateTime<Utc> {
        DateTime::from_timestamp(1_800_000_000 + s, 0).unwrap()
    }

    fn near(actual: i64, expected: i64, what: &str) {
        assert!((actual - expected).abs() <= 150, "{what}: {actual}, expected about {expected}");
    }

    /// `seconds` of footage with a keyframe every second, like the recorder's short GOP.
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

    /// A 40 s match recorded from t(0), and a local clip the hotkey saved of 10..20 s of it.
    struct Fixture {
        dir: PathBuf,
        clip_dir: PathBuf,
        bins: Binaries,
        store: SessionStore,
        queue: Queue,
        match_path: PathBuf,
        match_id: i64,
        clip_id: i64,
    }

    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.dir);
        }
    }

    fn fixture(name: &str) -> Fixture {
        let bins = ffmpeg::locate().expect("ffmpeg must be reachable for these tests");
        let dir = std::env::temp_dir().join(format!(
            "cos-nostra-edit-{name}-{}-{}",
            std::process::id(),
            Utc::now().timestamp_nanos_opt().unwrap_or(0)
        ));
        let clip_dir = dir.join("clips");
        let matches = clip_dir.join("Matches");
        std::fs::create_dir_all(&matches).unwrap();
        let store = SessionStore::open(&dir.join("sessions.db")).unwrap();
        let queue = Queue::open(&dir.join("clips.db")).unwrap();

        let session = store.create_session(SessionGame::Valorant, "Valorant", t(0)).unwrap();
        let match_path = matches.join("match.mp4");
        recording(&bins, &match_path, 40);
        let info = ffmpeg::probe(&bins, &match_path).unwrap();
        let match_id = store.add_undetected_match(session, t(0), t(40)).unwrap();
        store
            .set_match_file(match_id, &match_path, None, t(0), info.duration_ms, info.size as i64)
            .unwrap();

        let clip_path = clip_dir.join("clip.mp4");
        ffmpeg::copy_range(&bins, &match_path, 10_000, 20_000, &clip_path).unwrap();
        let clip = ffmpeg::probe(&bins, &clip_path).unwrap();
        let clip_id = queue
            .enqueue(NewClip {
                source_path: clip_path.display().to_string(),
                game: Some("Valorant".into()),
                title: None,
                recorded_at: format_time(t(20)),
                duration_ms: clip.duration_ms,
                width: clip.width,
                height: clip.height,
                fps: clip.fps,
                size_source: clip.size as i64,
                participants: None,
                captured_at: Some(format_time(t(10))),
            })
            .unwrap();
        Fixture { dir, clip_dir, bins, store, queue, match_path, match_id, clip_id }
    }

    impl Fixture {
        fn row(&self) -> ClipRow {
            self.queue.get(self.clip_id).unwrap().unwrap()
        }

        fn open(&self) -> EditSource {
            open(&self.bins, &self.queue, Some(&self.store), self.clip_id).unwrap()
        }

        fn apply(&self, kind: SourceKind, start: i64, end: i64) -> Result<Applied> {
            apply(&self.bins, &self.queue, Some(&self.store), &self.clip_dir, self.clip_id, kind, start, end)
        }

        fn outputs(&self, av1: &Path, h264: &Path, thumb: &str) {
            self.queue
                .mark_encoded(
                    self.clip_id,
                    &Outputs {
                        av1_path: av1.display().to_string(),
                        h264_path: h264.display().to_string(),
                        thumb_path: thumb.to_string(),
                        size_av1: 5,
                        size_h264: 5,
                        duration_ms: None,
                    },
                )
                .unwrap();
        }
    }

    #[test]
    fn a_range_inside_the_saved_footage_cuts_the_local_clip_in_place() {
        let f = fixture("inside");
        let source = f.open();
        assert_eq!(source.kind, SourceKind::Match);
        assert_eq!(source.match_id, Some(f.match_id));
        assert_eq!(source.path, f.match_path.display().to_string());
        near(source.range.start_ms, 10_000, "range start");
        near(source.range.end_ms, 20_000, "range end");
        let span = source.clip_span.expect("the clip's own footage is drawn");
        near(span.start_ms, 10_000, "footage start");
        near(span.end_ms, 20_000, "footage end");
        assert!(source.original && !source.multi_part);

        assert_eq!(f.apply(SourceKind::Match, 12_000, 18_000).unwrap(), Applied::Cut);
        let row = f.row();
        assert_eq!(row.source_path, f.clip_dir.join("clip.mp4").display().to_string(), "same recording");
        assert_eq!(row.cut, Some(vec![Segment { start_ms: 2_000, end_ms: 8_000 }]));
        assert_eq!(row.duration_ms, 6_000);
        assert_eq!(row.status, ClipStatus::Saved);
        assert!(!row.publish, "an edit publishes nothing");
        assert!(Path::new(row.thumb_path.as_deref().expect("a thumbnail without encoding")).is_file());

        // It now sits at 12..18 s of the match, and applying that again is nothing to do.
        let source = f.open();
        assert_eq!((source.range.start_ms, source.range.end_ms), (12_000, 18_000));
        assert_eq!(f.apply(SourceKind::Match, 12_000, 18_000).unwrap(), Applied::Unchanged);

        // Mid-job, nothing is touched.
        f.queue.publish(f.clip_id, None, None, &[]).unwrap();
        f.queue.mark_uploading(f.clip_id).unwrap();
        assert!(f.apply(SourceKind::Match, 11_000, 18_000).is_err(), "refused mid-job");
        assert_eq!(f.row().cut, Some(vec![Segment { start_ms: 2_000, end_ms: 8_000 }]));
    }

    #[test]
    fn a_range_past_the_saved_footage_takes_a_new_recording_from_the_match() {
        let f = fixture("past");
        // An encode from before publish on demand, whose copies the new range makes stale.
        let old = f.row();
        let (av1, h264, thumb) = storage::output_paths(Path::new(&old.source_path));
        for p in [&av1, &h264, &thumb] {
            std::fs::write(p, b"stale").unwrap();
        }
        f.outputs(&av1, &h264, &thumb.display().to_string());

        assert_eq!(f.apply(SourceKind::Match, 5_000, 25_000).unwrap(), Applied::Rebased);
        let row = f.row();
        assert_ne!(row.source_path, old.source_path);
        assert!(Path::new(&row.source_path).is_file());
        assert!(!Path::new(&old.source_path).exists(), "the old recording goes once replaced");
        assert!(!av1.exists() && !h264.exists(), "and so do its stale copies");
        // The copy starts on the keyframe at 2 s, three seconds before the range.
        assert_eq!(row.captured_at.as_deref(), Some(format_time(t(2)).as_str()));
        assert_eq!(row.cut, Some(vec![Segment { start_ms: 3_000, end_ms: 23_000 }]));
        assert_eq!(row.duration_ms, 20_000);
        assert_eq!((row.av1_path.as_deref(), row.status), (None, ClipStatus::Saved));
        assert!(!row.publish);
        assert!(Path::new(row.thumb_path.as_deref().unwrap()).is_file());

        let source = f.open();
        assert_eq!((source.range.start_ms, source.range.end_ms), (5_000, 25_000));
        let span = source.clip_span.unwrap();
        near(span.start_ms, 2_000, "new footage start");
        near(span.end_ms, 28_000, "new footage end");

        // The storage limit takes the match: the clip carries its own footage now.
        std::fs::remove_file(&f.match_path).unwrap();
        let source = f.open();
        assert_eq!(source.kind, SourceKind::Clip);
        assert_eq!((source.range.start_ms, source.range.end_ms), (3_000, 23_000));
        assert!(f.apply(SourceKind::Match, 0, 10_000).is_err(), "no match to copy from");
    }

    #[test]
    fn a_published_clip_goes_back_through_the_encoder_under_the_same_id() {
        let f = fixture("published");
        f.queue.publish(f.clip_id, Some("ace"), None, &[]).unwrap();
        f.queue.mark_done(f.clip_id, "r1", "https://x/c/r1").unwrap();

        assert_eq!(f.apply(SourceKind::Match, 11_000, 19_000).unwrap(), Applied::Cut);
        let row = f.row();
        assert_eq!(row.status, ClipStatus::Saved, "queued for the worker");
        assert!(row.publish);
        assert_eq!(row.remote_id.as_deref(), Some("r1"), "replaced, not uploaded anew");
        assert_eq!(row.cut, Some(vec![Segment { start_ms: 1_000, end_ms: 9_000 }]));

        assert_eq!(f.apply(SourceKind::Match, 0, 30_000).unwrap(), Applied::Rebased);
        let row = f.row();
        assert!(row.publish && row.remote_id.as_deref() == Some("r1"));
        assert_eq!(row.status, ClipStatus::Saved);
        assert_eq!(row.captured_at.as_deref(), Some(format_time(t(0)).as_str()));
    }

    /// With the recording gone and no match to fall back on, the encoded copy is all there is.
    /// The range is stream-copied out of it into a recording of its own, rather than cut in
    /// place against a file the next encode overwrites.
    #[test]
    fn an_encoded_copy_is_never_cut_in_place() {
        let f = fixture("copy");
        let old = f.row();
        let (_, h264, _) = storage::output_paths(Path::new(&old.source_path));
        std::fs::rename(&old.source_path, &h264).unwrap();
        f.outputs(&h264, &h264, "");
        std::fs::remove_file(&f.match_path).unwrap();

        let source = f.open();
        assert_eq!(source.kind, SourceKind::Clip);
        assert!(!source.original);
        assert_eq!(source.path, h264.display().to_string());

        assert_eq!(f.apply(SourceKind::Clip, 2_000, 6_000).unwrap(), Applied::Rebased);
        let row = f.row();
        assert!(Path::new(&row.source_path).is_file());
        assert!(!h264.exists(), "the copy it came from is gone");
        assert_eq!(row.captured_at.as_deref(), Some(format_time(t(10)).as_str()));
        assert_eq!(row.cut, Some(vec![Segment { start_ms: 2_000, end_ms: 6_000 }]));
        assert_eq!(edit_source_path(&row).map(|(_, original)| original), Some(true));
    }
}
