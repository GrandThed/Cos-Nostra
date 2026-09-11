//! What the clips cost on this PC, and the cleanup actions the Storage tab offers.
//!
//! Nothing here trusts the sizes recorded in the database. A file may have been moved, deleted
//! or re-encoded outside the app since the row was written, and the whole point of the tab is
//! to say what the disk actually holds, so every number comes from a fresh `stat`.
//!
//! Two ideas run through the cleanup actions. Removing the *original recording* of a clip that
//! already encoded is pure profit: the buffer writes ~20 Mbps and the AV1 copy is an order of
//! magnitude smaller. Removing the *local video* of a clip the backend already has keeps the
//! row, the thumbnail and the link, so the clip is still listed and still watchable, just not
//! from this machine. Nothing that exists only on this PC is ever removed without being asked.

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};

use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};

use crate::queue::{ClipRow, ClipStatus, Queue};

/// Outputs live next to the source: `<stem>.av1.mp4`, `<stem>.h264.mp4`, `<stem>.jpg`.
pub fn output_paths(source: &Path) -> (PathBuf, PathBuf, PathBuf) {
    let stem = source
        .file_stem()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_else(|| "clip".to_string());
    let dir = source.parent().map(Path::to_path_buf).unwrap_or_default();
    (
        dir.join(format!("{stem}.av1.mp4")),
        dir.join(format!("{stem}.h264.mp4")),
        dir.join(format!("{stem}.jpg")),
    )
}

/// Every file a clip row may own, for deletion.
pub fn clip_files(row: &ClipRow) -> Vec<String> {
    let mut files = vec![row.source_path.clone()];
    for p in [&row.av1_path, &row.h264_path, &row.thumb_path].into_iter().flatten() {
        files.push(p.clone());
    }
    // Rows that never reached the processor have no output paths recorded; also try the
    // conventional names so a failed clip does not leave partial outputs behind.
    for p in conventional(row) {
        if !files.contains(&p) {
            files.push(p);
        }
    }
    files
}

/// Clips and the bytes they hold on this PC.
#[derive(Debug, Clone, Copy, Default, Serialize)]
pub struct Bucket {
    pub clips: i64,
    pub bytes: i64,
}

impl Bucket {
    fn add(&mut self, bytes: i64) {
        self.clips += 1;
        self.bytes += bytes;
    }
}

/// One slice of the game bar.
#[derive(Debug, Clone, Default, Serialize)]
pub struct GameUsage {
    /// `None` for clips whose game was never detected.
    pub game: Option<String>,
    pub clips: i64,
    pub bytes: i64,
}

/// The same bytes split by what kind of file holds them.
#[derive(Debug, Clone, Copy, Default, Serialize)]
pub struct Kinds {
    /// Original recordings straight from the replay buffer.
    pub sources: i64,
    pub av1: i64,
    pub h264: i64,
    pub thumbs: i64,
    /// Files sitting in the clip folder that no clip row claims. Reported, never deleted.
    pub other: i64,
    pub other_files: i64,
}

#[derive(Debug, Clone, Default, Serialize)]
pub struct StorageStats {
    pub clip_dir: String,
    pub clips: i64,
    pub total: i64,
    pub kinds: Kinds,
    /// Biggest first; every clip lands in exactly one entry.
    pub games: Vec<GameUsage>,
    /// Clips the backend has a copy of.
    pub published: Bucket,
    /// Clips that exist nowhere else.
    pub local_only: Bucket,
    /// What each cleanup action would free right now. The first two overlap on clips that are
    /// both encoded and uploaded, so the numbers are recomputed after every action.
    pub reclaim_sources: Bucket,
    pub reclaim_published: Bucket,
    pub reclaim_failed: Bucket,
    /// Free and total bytes of the volume holding the clip folder, when Windows answers.
    pub free_space: Option<i64>,
    pub disk_size: Option<i64>,
}

/// Which cleanup the Storage tab asked for.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CleanTarget {
    /// Original recordings of clips that finished encoding. Keeps the clip.
    Sources,
    /// Source, AV1 and H.264 of clips the backend already has. Keeps the row, the thumbnail
    /// and the link.
    Published,
    /// Rows and files of clips that failed and will not be retried.
    Failed,
}

#[derive(Debug, Clone, Copy, Default, Serialize)]
pub struct CleanResult {
    pub clips: i64,
    pub bytes: i64,
}

/// The bytes each of a clip's four files takes on disk right now. Missing files are zero.
#[derive(Debug, Clone, Copy, Default)]
struct RowSizes {
    source: i64,
    av1: i64,
    h264: i64,
    thumb: i64,
}

impl RowSizes {
    fn total(&self) -> i64 {
        self.source + self.av1 + self.h264 + self.thumb
    }

    /// Everything but the thumbnail, which is kept when a published clip is cleaned.
    fn video(&self) -> i64 {
        self.source + self.av1 + self.h264
    }

    /// True when both encoder outputs are on disk, so the source is no longer needed.
    fn encoded(&self) -> bool {
        self.av1 > 0 && self.h264 > 0
    }
}

/// Walks every clip and the clip folder and adds up what is actually there.
pub fn scan(rows: &[ClipRow], clip_dir: &Path) -> StorageStats {
    let mut stats = StorageStats {
        clip_dir: clip_dir.display().to_string(),
        clips: rows.len() as i64,
        ..Default::default()
    };
    let mut games: HashMap<Option<String>, GameUsage> = HashMap::new();
    let mut claimed: HashSet<String> = HashSet::new();

    for row in rows {
        let sizes = sizes_of(row);
        for p in paths_of(row) {
            claimed.insert(path_key(&p));
        }

        stats.total += sizes.total();
        stats.kinds.sources += sizes.source;
        stats.kinds.av1 += sizes.av1;
        stats.kinds.h264 += sizes.h264;
        stats.kinds.thumbs += sizes.thumb;

        let usage = games.entry(row.game.clone()).or_default();
        usage.game = row.game.clone();
        usage.clips += 1;
        usage.bytes += sizes.total();

        if row.remote_id.is_some() {
            stats.published.add(sizes.total());
            if sizes.video() > 0 {
                stats.reclaim_published.add(sizes.video());
            }
        } else {
            stats.local_only.add(sizes.total());
        }
        if sizes.source > 0 && sizes.encoded() {
            stats.reclaim_sources.add(sizes.source);
        }
        if row.status == ClipStatus::Failed {
            stats.reclaim_failed.add(sizes.total());
        }
    }

    // Anything else in the folder: leftovers from a crashed encode, a row deleted by hand, a
    // video the user dropped in. Counted so the total matches Explorer, never deleted for them.
    if let Ok(entries) = std::fs::read_dir(clip_dir) {
        for entry in entries.flatten() {
            let Ok(meta) = entry.metadata() else { continue };
            if !meta.is_file() {
                continue;
            }
            if claimed.contains(&path_key(&entry.path().display().to_string())) {
                continue;
            }
            stats.kinds.other += meta.len() as i64;
            stats.kinds.other_files += 1;
        }
    }
    stats.total += stats.kinds.other;

    stats.games = games.into_values().collect();
    // Biggest first, with a stable tiebreak so the bar does not reshuffle between refreshes.
    stats.games.sort_by(|a, b| {
        b.bytes
            .cmp(&a.bytes)
            .then(b.clips.cmp(&a.clips))
            .then(a.game.cmp(&b.game))
    });

    if let Some((free, size)) = disk_space(clip_dir) {
        stats.free_space = Some(free);
        stats.disk_size = Some(size);
    }
    stats
}

/// Runs one cleanup over every clip. Files already gone are not an error.
pub fn clean(queue: &Queue, target: CleanTarget) -> Result<CleanResult> {
    let rows = queue.list().context("listing clips")?;
    let mut result = CleanResult::default();
    for row in &rows {
        let sizes = sizes_of(row);
        // `None` when this clip is not what the action is about, so a clip whose files were
        // already gone still counts as cleaned when its row went with them.
        let freed = match target {
            CleanTarget::Sources => {
                (sizes.source > 0 && sizes.encoded()).then(|| drop_source(row))
            }
            CleanTarget::Published => match row.remote_id.is_some() && sizes.video() > 0 {
                true => Some(drop_local_video(queue, row)?),
                false => None,
            },
            CleanTarget::Failed => match row.status == ClipStatus::Failed {
                true => {
                    queue
                        .delete(row.id)
                        .with_context(|| format!("deleting clip {}", row.id))?;
                    Some(clip_files(row).iter().map(|p| remove(p)).sum())
                }
                false => None,
            },
        };
        if let Some(freed) = freed {
            result.clips += 1;
            result.bytes += freed;
        }
    }
    if result.clips > 0 {
        log::info!(
            "storage: {target:?} cleanup freed {} bytes across {} clips",
            result.bytes,
            result.clips
        );
    }
    Ok(result)
}

/// Deletes the original recording of a clip that has both encoder outputs. Returns bytes freed.
pub fn drop_source(row: &ClipRow) -> i64 {
    remove(&row.source_path)
}

/// Removes the local video of a clip the backend already has and forgets the output paths, so
/// the Clips tab still lists it with its thumbnail and its link.
fn drop_local_video(queue: &Queue, row: &ClipRow) -> Result<i64> {
    let (av1, h264, _) = conventional_paths(row);
    let mut freed = remove(&row.source_path);
    for p in [row.av1_path.as_deref(), row.h264_path.as_deref()].into_iter().flatten() {
        freed += remove(p);
    }
    freed += remove(&av1);
    freed += remove(&h264);
    queue
        .clear_local_video(row.id)
        .with_context(|| format!("clearing local outputs of clip {}", row.id))?;
    Ok(freed)
}

/// Keeps the clip folder under `limit_bytes` by giving up the local video of the oldest clips
/// the backend already has. A limit of zero means no limit. Clips that exist only here are
/// never touched, so this can leave the folder over the limit; the Storage tab says so when it
/// does rather than deleting the only copy of something.
pub fn enforce_limit(queue: &Queue, clip_dir: &Path, limit: i64) -> Result<CleanResult> {
    let mut result = CleanResult::default();
    if limit <= 0 {
        return Ok(result);
    }
    let rows = queue.list().context("listing clips")?;
    let mut total = scan(&rows, clip_dir).total;
    if total <= limit {
        return Ok(result);
    }
    // `list` is newest first, so walking it backwards gives up the oldest copies first.
    for row in rows.iter().rev() {
        if total <= limit {
            break;
        }
        if row.remote_id.is_none() {
            continue;
        }
        let freed = drop_local_video(queue, row)?;
        if freed > 0 {
            total -= freed;
            result.clips += 1;
            result.bytes += freed;
        }
    }
    if result.clips > 0 {
        log::info!(
            "storage: limit of {limit} bytes freed {} bytes across {} uploaded clips",
            result.bytes,
            result.clips
        );
    }
    Ok(result)
}

/// Bytes in a gigabyte, for turning the setting into a limit.
pub const GB: i64 = 1024 * 1024 * 1024;

/// Free and total bytes of the volume holding `dir`. Walks up to the first existing ancestor,
/// because the clip folder may not have been created yet.
fn disk_space(dir: &Path) -> Option<(i64, i64)> {
    use windows::core::HSTRING;
    use windows::Win32::Storage::FileSystem::GetDiskFreeSpaceExW;

    let mut probe = dir;
    while !probe.exists() {
        probe = probe.parent()?;
    }
    let wide = HSTRING::from(probe.as_os_str());
    let mut free = 0u64;
    let mut size = 0u64;
    // Safety: both out-params are plain stack u64s that outlive the call.
    let ok = unsafe { GetDiskFreeSpaceExW(&wide, Some(&mut free), Some(&mut size), None) };
    match ok {
        Ok(()) => Some((free as i64, size as i64)),
        Err(e) => {
            log::debug!("free space for {} unavailable: {e}", probe.display());
            None
        }
    }
}

/// Deletes a file and returns the bytes it freed. Zero when it was already gone.
fn remove(path: &str) -> i64 {
    let size = size_on_disk(path);
    match std::fs::remove_file(path) {
        Ok(()) => {
            log::info!("storage: deleted {path} ({size} bytes)");
            size
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => 0,
        Err(e) => {
            log::warn!("storage: could not delete {path}: {e}");
            0
        }
    }
}

fn size_on_disk(path: &str) -> i64 {
    std::fs::metadata(path).map(|m| m.len() as i64).unwrap_or(0)
}

/// The output paths a clip would have used, whether or not the encode recorded them.
fn conventional_paths(row: &ClipRow) -> (String, String, String) {
    let (av1, h264, thumb) = output_paths(Path::new(&row.source_path));
    (
        av1.display().to_string(),
        h264.display().to_string(),
        thumb.display().to_string(),
    )
}

fn conventional(row: &ClipRow) -> Vec<String> {
    let (av1, h264, thumb) = conventional_paths(row);
    vec![av1, h264, thumb]
}

/// Where a clip's four files are. The recorded path wins; the conventional one stands in when a
/// step never wrote its path, so half-finished encodes still show up in the totals.
fn paths_of(row: &ClipRow) -> [String; 4] {
    let (av1, h264, thumb) = conventional_paths(row);
    [
        row.source_path.clone(),
        row.av1_path.clone().unwrap_or(av1),
        row.h264_path.clone().unwrap_or(h264),
        row.thumb_path.clone().unwrap_or(thumb),
    ]
}

fn sizes_of(row: &ClipRow) -> RowSizes {
    let [source, av1, h264, thumb] = paths_of(row);
    RowSizes {
        source: size_on_disk(&source),
        av1: size_on_disk(&av1),
        h264: size_on_disk(&h264),
        thumb: size_on_disk(&thumb),
    }
}

/// Compares paths the way Windows does, so a row's path and a directory listing agree.
fn path_key(path: &str) -> String {
    path.replace('/', "\\").to_lowercase()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::queue::{NewClip, Outputs};
    use std::sync::atomic::{AtomicUsize, Ordering};

    /// A scratch clip folder and a database path outside it, the way the real app keeps clips
    /// in Videos and `clips.db` in `%APPDATA%`. Keeping them apart matters: the WAL files sit
    /// next to the database, and in the clip folder they would count as leftovers.
    fn temp_dirs() -> (PathBuf, PathBuf) {
        static COUNTER: AtomicUsize = AtomicUsize::new(0);
        let n = COUNTER.fetch_add(1, Ordering::Relaxed);
        let base = std::env::temp_dir().join(format!(
            "cos-nostra-storage-test-{}-{}",
            std::process::id(),
            n
        ));
        let _ = std::fs::remove_dir_all(&base);
        let clips = base.join("clips");
        std::fs::create_dir_all(&clips).unwrap();
        (clips, base.join("clips.db"))
    }

    fn write(path: &Path, bytes: usize) {
        std::fs::write(path, vec![b'x'; bytes]).unwrap();
    }

    /// Enqueues a clip with `bytes` of source next to `dir`, and returns its id.
    fn add(queue: &Queue, dir: &Path, name: &str, game: Option<&str>, bytes: usize) -> i64 {
        let source = dir.join(format!("{name}.mkv"));
        write(&source, bytes);
        queue
            .enqueue(NewClip {
                source_path: source.display().to_string(),
                game: game.map(str::to_string),
                title: None,
                recorded_at: format!("2026-09-1{}T10:00:00.000Z", name.len() % 10),
                duration_ms: 30_000,
                width: 1920,
                height: 1080,
                size_source: bytes as i64,
            })
            .unwrap()
    }

    /// Writes the three outputs a finished encode leaves and records them on the row.
    fn encode(queue: &Queue, id: i64, av1: usize, h264: usize, thumb: usize) {
        let row = queue.get(id).unwrap().unwrap();
        let (av1_path, h264_path, thumb_path) = conventional_paths(&row);
        write(Path::new(&av1_path), av1);
        write(Path::new(&h264_path), h264);
        write(Path::new(&thumb_path), thumb);
        queue
            .mark_encoded(
                id,
                &Outputs {
                    av1_path,
                    h264_path,
                    thumb_path,
                    size_av1: av1 as i64,
                    size_h264: h264 as i64,
                },
            )
            .unwrap();
    }

    /// Marks a clip uploaded the way a finished upload does.
    fn publish(queue: &Queue, id: i64, name: &str) {
        queue.mark_uploading(id).unwrap();
        queue
            .mark_done(id, name, &format!("https://example/c/{name}"))
            .unwrap();
    }

    #[test]
    fn totals_split_by_kind_game_and_destination() {
        let (dir, db) = temp_dirs();
        let q = Queue::open(&db).unwrap();
        let a = add(&q, &dir, "a", Some("Wardogs"), 1000);
        let b = add(&q, &dir, "b", Some("Wardogs"), 2000);
        add(&q, &dir, "c", None, 3000);
        encode(&q, a, 100, 200, 10);
        encode(&q, b, 100, 200, 10);
        publish(&q, b, "remote-b");
        // A file nobody claims.
        write(&dir.join("stray.mp4"), 77);

        let stats = scan(&q.list().unwrap(), &dir);
        assert_eq!(stats.clips, 3);
        assert_eq!(stats.kinds.sources, 6000);
        assert_eq!(stats.kinds.av1, 200);
        assert_eq!(stats.kinds.h264, 400);
        assert_eq!(stats.kinds.thumbs, 20);
        assert_eq!(stats.kinds.other, 77, "the stray file is counted, once");
        assert_eq!(stats.kinds.other_files, 1);
        assert_eq!(stats.total, 6000 + 200 + 400 + 20 + 77);

        assert_eq!(stats.games.len(), 2);
        assert_eq!(stats.games[0].game.as_deref(), Some("Wardogs"));
        assert_eq!(stats.games[0].clips, 2);
        assert_eq!(stats.games[0].bytes, 1000 + 2000 + 200 + 400 + 20);
        assert_eq!(stats.games[1].game, None, "undetected games get their own slice");
        assert_eq!(stats.games[1].clips, 1);

        assert_eq!(stats.published.clips, 1, "only the uploaded clip");
        assert_eq!(stats.local_only.clips, 2);
        assert_eq!(stats.reclaim_sources.clips, 2, "a and b encoded, c did not");
        assert_eq!(stats.reclaim_sources.bytes, 3000);
        assert_eq!(stats.reclaim_published.bytes, 2000 + 100 + 200);
        assert_eq!(stats.reclaim_failed.clips, 0);
        assert!(stats.free_space.unwrap_or(0) > 0, "Windows reports free space");
        assert!(stats.disk_size.unwrap_or(0) >= stats.free_space.unwrap_or(0));
    }

    #[test]
    fn cleaning_sources_keeps_the_encoded_copies() {
        let (dir, db) = temp_dirs();
        let q = Queue::open(&db).unwrap();
        let a = add(&q, &dir, "a", Some("Game"), 1000);
        let b = add(&q, &dir, "b", Some("Game"), 2000);
        encode(&q, a, 100, 200, 10);

        let freed = clean(&q, CleanTarget::Sources).unwrap();
        assert_eq!(freed.clips, 1);
        assert_eq!(freed.bytes, 1000);
        assert!(!dir.join("a.mkv").exists(), "the encoded clip gave up its source");
        assert!(dir.join("a.av1.mp4").exists());
        assert!(dir.join("b.mkv").exists(), "an unencoded clip keeps its only copy");
        assert!(q.get(a).unwrap().is_some(), "the row survives");
        assert_eq!(q.get(b).unwrap().unwrap().size_source, 2000);

        // Running it again finds nothing left to do.
        assert_eq!(clean(&q, CleanTarget::Sources).unwrap().clips, 0);
    }

    #[test]
    fn cleaning_published_clips_keeps_the_row_thumbnail_and_link() {
        let (dir, db) = temp_dirs();
        let q = Queue::open(&db).unwrap();
        let a = add(&q, &dir, "a", Some("Game"), 1000);
        let b = add(&q, &dir, "b", Some("Game"), 2000);
        encode(&q, a, 100, 200, 10);
        encode(&q, b, 100, 200, 10);
        publish(&q, a, "a");

        let freed = clean(&q, CleanTarget::Published).unwrap();
        assert_eq!(freed.clips, 1);
        assert_eq!(freed.bytes, 1000 + 100 + 200);
        assert!(!dir.join("a.mkv").exists());
        assert!(!dir.join("a.av1.mp4").exists());
        assert!(dir.join("a.jpg").exists(), "the thumbnail stays for the Clips tab");

        let row = q.get(a).unwrap().unwrap();
        assert_eq!(row.status, ClipStatus::Done);
        assert_eq!(row.page_url.as_deref(), Some("https://example/c/a"));
        assert_eq!(row.remote_id.as_deref(), Some("a"));
        assert!(row.av1_path.is_none(), "the UI can tell the video is gone");
        assert!(row.h264_path.is_none());

        assert!(dir.join("b.av1.mp4").exists(), "a clip that never uploaded is untouched");
        assert_eq!(clean(&q, CleanTarget::Published).unwrap().clips, 0);
    }

    #[test]
    fn cleaning_failed_clips_removes_rows_and_files() {
        let (dir, db) = temp_dirs();
        let q = Queue::open(&db).unwrap();
        let a = add(&q, &dir, "a", Some("Game"), 1000);
        let b = add(&q, &dir, "b", Some("Game"), 2000);
        q.mark_failed(a, "ffmpeg exploded").unwrap();

        let freed = clean(&q, CleanTarget::Failed).unwrap();
        assert_eq!(freed.clips, 1);
        assert_eq!(freed.bytes, 1000);
        assert!(q.get(a).unwrap().is_none(), "the row goes too");
        assert!(!dir.join("a.mkv").exists());
        assert!(q.get(b).unwrap().is_some());
    }

    #[test]
    fn the_limit_only_gives_up_clips_the_backend_already_has() {
        let (dir, db) = temp_dirs();
        let q = Queue::open(&db).unwrap();
        // `recorded_at` is what orders the list, and `add` derives it from the name length.
        let old = add(&q, &dir, "o", Some("Game"), 1000);
        let mid = add(&q, &dir, "mi", Some("Game"), 1000);
        let local = add(&q, &dir, "loc", Some("Game"), 1000);
        publish(&q, old, "o");
        publish(&q, mid, "mi");

        let freed = enforce_limit(&q, &dir, 2500).unwrap();
        assert_eq!(freed.clips, 1, "one clip was enough to get under the limit");
        assert!(!dir.join("o.mkv").exists(), "the oldest uploaded clip went first");
        assert!(dir.join("mi.mkv").exists());
        assert!(dir.join("loc.mkv").exists(), "never the one that exists only here");

        // A limit that uploaded clips alone cannot meet stops rather than eating the rest.
        let freed = enforce_limit(&q, &dir, 500).unwrap();
        assert_eq!(freed.clips, 1);
        assert!(dir.join("loc.mkv").exists());
        assert!(q.get(local).unwrap().is_some());
        assert!(scan(&q.list().unwrap(), &dir).total > 500, "still over, and honest about it");

        assert_eq!(enforce_limit(&q, &dir, 0).unwrap().clips, 0, "zero means no limit");
    }
}
