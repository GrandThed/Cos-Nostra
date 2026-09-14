//! Cover art and icons for the games in the library.
//!
//! Pictures live in `%APPDATA%\Cos Nostra\game-art`, described by `index.json` there (game name
//! to [`Entry`]). A single long-lived worker thread looks them up, so nothing here blocks the
//! caller and the blocking HTTP client never lives in an async context.
//!
//! Resolution, all best effort:
//! 1. Steam app id from the exe path (the Steam library it sits in and that library's
//!    `appmanifest_*.acf`), else from Discord's entry for the game.
//! 2. Discord's public list of detectable games (`detectable.json`, a slim copy refreshed weekly)
//!    matched by exe file name and/or game name.
//! 3. Cover: Steam's local library cache, the Steam CDN, the Steam store assets API, Discord's
//!    cover image, then Steam header images.
//! 4. Icon: Discord's app icon, else the icon inside the exe.
//!
//! A picture the user chose is marked custom and is never replaced automatically.

use std::collections::{BTreeMap, HashMap};
use std::io::Read;
use std::panic::AssertUnwindSafe;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc::{self, Receiver, RecvTimeoutError, Sender};
use std::sync::{Mutex, MutexGuard};
use std::time::{Duration, Instant};

use anyhow::{bail, Context, Result};
use chrono::{DateTime, Utc};
use serde::de::DeserializeOwned;
use serde::{Deserialize, Deserializer, Serialize};
use tauri::{AppHandle, Emitter, Manager};

/// What is known about a game when a clip is saved from it.
#[derive(Debug, Clone, Default)]
pub struct GameHint {
    /// The library's name for the game, exactly as stored on the clip row.
    pub name: String,
    /// Process image file name, e.g. `cs2.exe`.
    pub executable: Option<String>,
    /// Full path of the process image, when it could be read.
    pub executable_path: Option<String>,
}

/// Which picture the UI wants. Each falls back to the other when only one exists.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ArtKind {
    /// Square, for the sidebar.
    Icon,
    /// Box art or banner, for the game header.
    Cover,
}

#[derive(Debug, Clone, Serialize)]
pub struct GameArtImage {
    /// `data:` URL.
    pub url: String,
    /// True when the user chose this picture, so it is never replaced automatically.
    pub custom: bool,
}

const CHANGED_EVENT: &str = "game-art-changed";
const INDEX_FILE: &str = "index.json";
const DETECTABLE_FILE: &str = "detectable.json";
const DETECTABLE_URL: &str = "https://discord.com/api/v9/applications/detectable";
const STEAM_CDN: &str = "https://cdn.cloudflare.steamstatic.com/steam/apps";
const STEAM_STORE_ASSETS: &str = "https://shared.akamai.steamstatic.com/store_item_assets/";
const MAX_IMAGE_BYTES: u64 = 10 * 1024 * 1024;
const MAX_DETECTABLE_BYTES: u64 = 64 * 1024 * 1024;
const MAX_JSON_BYTES: u64 = 4 * 1024 * 1024;
const ICON_SIZE: u32 = 256;
/// A lookup that found nothing is tried again after this long.
const RETRY_EMPTY_HOURS: i64 = 24;
const DETECTABLE_MAX_AGE_DAYS: i64 = 7;
/// After a failed refresh of the Discord list, the stale copy is used for this long.
const DETECTABLE_RETRY: Duration = Duration::from_secs(60 * 60);
/// The worker drops the Discord list and HTTP client after this long without work.
const WORKER_IDLE: Duration = Duration::from_secs(5 * 60);

const SOURCE_STEAM: &str = "steam";
const SOURCE_DISCORD: &str = "discord";
const SOURCE_EXE: &str = "exe";
const SOURCE_CUSTOM: &str = "custom";

// ---------------------------------------------------------------------------
// Index

/// What is cached for one game. Unknown or missing fields read as their defaults so the file
/// survives builds adding fields.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
struct Entry {
    executable: Option<String>,
    executable_path: Option<String>,
    steam_app_id: Option<u32>,
    discord_app_id: Option<String>,
    /// File name inside the cache directory.
    icon: Option<String>,
    /// File name inside the cache directory.
    cover: Option<String>,
    /// Where the cover (or, without one, the icon) came from: steam, discord, exe or custom.
    source: Option<String>,
    custom: bool,
    /// RFC 3339 time of the last lookup.
    checked_at: Option<String>,
}

impl Entry {
    fn files(&self) -> impl Iterator<Item = &str> {
        self.icon.iter().chain(self.cover.iter()).map(String::as_str)
    }

    fn has_pictures(&self) -> bool {
        self.icon.is_some() || self.cover.is_some()
    }
}

type Index = BTreeMap<String, Entry>;

/// Whether a lookup should run for `hint`, given what is cached for it.
fn needs_resolve(entry: Option<&Entry>, hint: &GameHint, now: DateTime<Utc>) -> bool {
    let Some(entry) = entry else { return true };
    if entry.custom {
        return false;
    }
    if !entry.has_pictures() {
        let stale = entry
            .checked_at
            .as_deref()
            .and_then(|t| DateTime::parse_from_rfc3339(t).ok())
            .is_none_or(|t| {
                now.signed_duration_since(t) >= chrono::Duration::hours(RETRY_EMPTY_HOURS)
            });
        if stale {
            return true;
        }
    }
    hint.executable_path.is_some() && entry.executable_path.is_none() && entry.cover.is_none()
}

fn referenced(index: &Index, file: &str) -> bool {
    index.values().any(|e| e.files().any(|f| f == file))
}

/// Of `files`, the ones no entry in `index` uses any more.
fn orphans(index: &Index, files: impl IntoIterator<Item = String>) -> Vec<String> {
    let mut out: Vec<String> = files.into_iter().filter(|f| !referenced(index, f)).collect();
    out.dedup();
    out
}

/// Applies "every clip of `from` is now `to`" to the index. Returns the files that became
/// unused and whether the index changed.
fn rename_in_index(index: &mut Index, from: &str, to: &str) -> (Vec<String>, bool) {
    if from == to {
        return (Vec::new(), false);
    }
    let Some(moved) = index.remove(from) else {
        return (Vec::new(), false);
    };
    match index.get_mut(to) {
        None => {
            index.insert(to.to_string(), moved);
            (Vec::new(), true)
        }
        Some(kept) => {
            if kept.executable.is_none() {
                kept.executable = moved.executable.clone();
            }
            if kept.executable_path.is_none() {
                kept.executable_path = moved.executable_path.clone();
            }
            let files: Vec<String> = moved.files().map(str::to_string).collect();
            (orphans(index, files), true)
        }
    }
}

/// 32-bit FNV-1a. Stable across builds and platforms, unlike `DefaultHasher`.
fn fnv1a32(bytes: &[u8]) -> u32 {
    let mut hash = 0x811c_9dc5u32;
    for &b in bytes {
        hash ^= u32::from(b);
        hash = hash.wrapping_mul(0x0100_0193);
    }
    hash
}

/// `counter-strike-2-1a2b3c4d`: readable slug plus a hash so names that slug alike stay apart.
fn file_base(game: &str) -> String {
    let mut slug = String::new();
    for c in game.chars() {
        if slug.len() >= 40 {
            break;
        }
        if c.is_ascii_alphanumeric() {
            slug.push(c.to_ascii_lowercase());
        } else if !slug.is_empty() && !slug.ends_with('-') {
            slug.push('-');
        }
    }
    let slug = slug.trim_end_matches('-');
    let slug = if slug.is_empty() { "game" } else { slug };
    format!("{slug}-{:08x}", fnv1a32(game.as_bytes()))
}

/// The cache file name for `game`'s `kind` picture, skipping names another game's entry still
/// uses (an entry carried over by a rename keeps its old file names).
fn free_file_name(index: &Index, game: &str, kind: &str, ext: &str) -> String {
    let base = file_base(game);
    let mut n = 1;
    loop {
        let candidate = if n == 1 {
            format!("{base}-{kind}.{ext}")
        } else {
            format!("{base}-{kind}-{n}.{ext}")
        };
        let taken = index
            .iter()
            .any(|(g, e)| g != game && e.files().any(|f| f == candidate));
        if !taken {
            return candidate;
        }
        n += 1;
    }
}

fn load_index(dir: &Path) -> Index {
    let path = dir.join(INDEX_FILE);
    let bytes = match std::fs::read(&path) {
        Ok(b) => b,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Index::new(),
        Err(e) => {
            log::warn!("reading {}: {e}", path.display());
            return Index::new();
        }
    };
    let bytes = bytes.strip_prefix(b"\xEF\xBB\xBF").unwrap_or(&bytes);
    serde_json::from_slice(bytes).unwrap_or_else(|e| {
        log::warn!("{} is unreadable, starting over: {e}", path.display());
        Index::new()
    })
}

fn write_atomic(path: &Path, bytes: &[u8]) -> Result<()> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).with_context(|| format!("creating {}", parent.display()))?;
    }
    let mut part = path.as_os_str().to_owned();
    part.push(".part");
    let part = PathBuf::from(part);
    std::fs::write(&part, bytes).with_context(|| format!("writing {}", part.display()))?;
    std::fs::rename(&part, path).with_context(|| format!("replacing {}", path.display()))
}

fn remove_files(dir: &Path, names: &[String]) {
    for name in names {
        match std::fs::remove_file(dir.join(name)) {
            Ok(()) => {}
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(e) => log::debug!("removing game art {name}: {e}"),
        }
    }
}

// ---------------------------------------------------------------------------
// State

pub struct GameArt {
    /// `None` when there is no data directory; everything is then a no-op.
    dir: Option<PathBuf>,
    inner: Mutex<Inner>,
    /// Generation of the index last written, so an older snapshot never overwrites a newer one.
    saved: Mutex<u64>,
    jobs: Sender<Job>,
}

#[derive(Default)]
struct Inner {
    index: Index,
    /// Lookups queued or running, by game name.
    in_flight: HashMap<String, InFlight>,
    next_token: u64,
    generation: u64,
}

struct InFlight {
    hint: GameHint,
    /// Identifies this lookup; a reset or rename removes it, which makes the running lookup's
    /// result be thrown away.
    token: u64,
}

struct Job {
    name: String,
    token: u64,
}

#[derive(Clone, Serialize)]
struct GameArtChanged {
    game: String,
}

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(|e| e.into_inner())
}

fn emit_changed(app: &AppHandle, game: &str) {
    let _ = app.emit(CHANGED_EVENT, GameArtChanged { game: game.to_string() });
}

fn clean_hint(hint: GameHint) -> GameHint {
    let clean = |s: Option<String>| s.map(|s| s.trim().to_string()).filter(|s| !s.is_empty());
    GameHint {
        name: hint.name,
        executable: clean(hint.executable),
        executable_path: clean(hint.executable_path),
    }
}

impl Inner {
    fn snapshot(&mut self) -> (u64, Vec<u8>) {
        self.generation += 1;
        let bytes = serde_json::to_vec_pretty(&self.index).unwrap_or_else(|e| {
            log::warn!("serializing the game art index: {e}");
            Vec::new()
        });
        (self.generation, bytes)
    }
}

impl GameArt {
    fn persist(&self, (generation, bytes): (u64, Vec<u8>)) {
        let Some(dir) = &self.dir else { return };
        if bytes.is_empty() {
            return;
        }
        let mut saved = lock(&self.saved);
        if generation <= *saved {
            return;
        }
        match write_atomic(&dir.join(INDEX_FILE), &bytes) {
            Ok(()) => *saved = generation,
            Err(e) => log::warn!("saving the game art index: {e:#}"),
        }
    }

    /// Queues a lookup when the retry policy wants one; otherwise just remembers any executable
    /// details the entry lacked.
    fn enqueue(&self, hint: GameHint) {
        let hint = clean_hint(hint);
        if self.dir.is_none() || hint.name.trim().is_empty() {
            return;
        }
        let mut inner = lock(&self.inner);
        let wanted = needs_resolve(inner.index.get(&hint.name), &hint, Utc::now());
        let mut job = None;
        let mut snapshot = None;
        if wanted {
            let token = inner.next_token + 1;
            match inner.in_flight.get_mut(&hint.name) {
                Some(running) => {
                    if running.hint.executable.is_none() {
                        running.hint.executable = hint.executable.clone();
                    }
                    if running.hint.executable_path.is_none() {
                        running.hint.executable_path = hint.executable_path.clone();
                    }
                }
                None => {
                    inner.next_token = token;
                    job = Some(Job { name: hint.name.clone(), token });
                    inner.in_flight.insert(hint.name.clone(), InFlight { hint, token });
                }
            }
        } else if let Some(entry) = inner.index.get_mut(&hint.name) {
            let mut changed = false;
            if entry.executable.is_none() && hint.executable.is_some() {
                entry.executable = hint.executable;
                changed = true;
            }
            if entry.executable_path.is_none() && hint.executable_path.is_some() {
                entry.executable_path = hint.executable_path;
                changed = true;
            }
            if changed {
                snapshot = Some(inner.snapshot());
            }
        }
        drop(inner);
        if let Some(snapshot) = snapshot {
            self.persist(snapshot);
        }
        if let Some(job) = job {
            let name = job.name.clone();
            if self.jobs.send(job).is_err() {
                log::debug!("game art worker is gone; not looking up {name}");
                lock(&self.inner).in_flight.remove(&name);
            }
        }
    }

    /// Files an entry names that are no longer on disk are dropped from it, so the retry
    /// policy looks the game up again.
    fn forget_missing(&self, game: &str, dir: &Path) {
        let mut inner = lock(&self.inner);
        let Some(entry) = inner.index.get_mut(game) else { return };
        let mut changed = false;
        for slot in [&mut entry.icon, &mut entry.cover] {
            if slot.as_ref().is_some_and(|f| !dir.join(f).is_file()) {
                *slot = None;
                changed = true;
            }
        }
        if !changed {
            return;
        }
        if entry.custom && entry.cover.is_none() {
            entry.custom = false;
            entry.source = None;
        }
        entry.checked_at = None;
        let snapshot = inner.snapshot();
        drop(inner);
        self.persist(snapshot);
    }

    /// Stores what a lookup found, unless the lookup was superseded (reset or rename) or the
    /// user has since chosen a picture. Looks the game up again when an exe path arrived while
    /// it ran.
    fn commit(&self, app: &AppHandle, dir: &Path, job: &Job, started: &GameHint, found: Resolved) {
        let mut inner = lock(&self.inner);
        let current = match inner.in_flight.get(&job.name) {
            Some(f) if f.token == job.token => f.hint.clone(),
            _ => {
                drop(inner);
                log::debug!("game art lookup for {} was superseded", job.name);
                found.discard();
                return;
            }
        };
        inner.in_flight.remove(&job.name);

        let custom = inner.index.get(&job.name).is_some_and(|e| e.custom);
        let mut discard = Vec::new();
        let mut placed = |staged: Option<Staged>, kind: &str, inner: &Inner| -> Option<(String, &'static str)> {
            let staged = staged?;
            if custom {
                discard.push(staged.part);
                return None;
            }
            let name = free_file_name(&inner.index, &job.name, kind, staged.ext);
            // A rename is a single metadata operation, cheap enough under the lock, and doing
            // it here means the index never names a file that is not in place yet.
            match std::fs::rename(&staged.part, dir.join(&name)) {
                Ok(()) => Some((name, staged.source)),
                Err(e) => {
                    log::info!("placing game art {name}: {e}");
                    discard.push(staged.part);
                    None
                }
            }
        };
        let icon = placed(found.icon, "icon", &inner);
        let cover = placed(found.cover, "cover", &inner);

        let entry = inner.index.entry(job.name.clone()).or_default();
        if found.executable.is_some() {
            entry.executable = found.executable;
        }
        if found.executable_path.is_some() {
            entry.executable_path = found.executable_path;
        }
        if found.steam_app_id.is_some() {
            entry.steam_app_id = found.steam_app_id;
        }
        if found.discord_app_id.is_some() {
            entry.discord_app_id = found.discord_app_id;
        }
        entry.checked_at = Some(Utc::now().to_rfc3339());
        let mut replaced = Vec::new();
        let changed = icon.is_some() || cover.is_some();
        if let Some((name, source)) = &icon {
            replaced.extend(entry.icon.replace(name.clone()).filter(|old| old != name));
            if cover.is_none() && entry.cover.is_none() {
                entry.source = Some(source.to_string());
            }
        }
        if let Some((name, source)) = &cover {
            replaced.extend(entry.cover.replace(name.clone()).filter(|old| old != name));
            entry.source = Some(source.to_string());
        }
        let unused = orphans(&inner.index, replaced);
        let snapshot = inner.snapshot();
        drop(inner);

        self.persist(snapshot);
        remove_files(dir, &unused);
        for part in discard {
            let _ = std::fs::remove_file(part);
        }
        if changed {
            emit_changed(app, &job.name);
        }
        if current.executable_path.is_some() && started.executable_path.is_none() {
            self.enqueue(current);
        }
    }
}

/// Registers the managed state. Called once from `setup`, before any command can run.
pub fn init(app: &AppHandle) {
    let dir = crate::settings::data_dir().map(|d| d.join("game-art"));
    let index = dir.as_deref().map(load_index).unwrap_or_default();
    let (jobs, rx) = mpsc::channel();
    app.manage(GameArt {
        dir: dir.clone(),
        inner: Mutex::new(Inner { index, ..Default::default() }),
        saved: Mutex::new(0),
        jobs,
    });
    let Some(dir) = dir else {
        log::warn!("no data directory; game art is off");
        return;
    };
    let handle = app.clone();
    if let Err(e) = std::thread::Builder::new()
        .name("game-art".into())
        .spawn(move || worker(handle, dir, rx))
    {
        log::warn!("starting the game art worker: {e}");
    }
}

/// Looks up art for a game in the background if it has none yet. Never blocks.
pub fn request(app: &AppHandle, hint: GameHint) {
    if let Some(state) = app.try_state::<GameArt>() {
        state.enqueue(hint);
    }
}

/// Every clip of `from` is now called `to`; carries the art along.
pub fn renamed(app: &AppHandle, from: Option<&str>, to: Option<&str>) {
    let Some(to) = to.filter(|t| !t.trim().is_empty()) else { return };
    let Some(state) = app.try_state::<GameArt>() else { return };
    let from = from.filter(|f| *f != to);
    let mut inner = lock(&state.inner);
    let (unused, changed) = match from {
        Some(from) => rename_in_index(&mut inner.index, from, to),
        None => (Vec::new(), false),
    };
    // A lookup still running for the old name would land on a name no clip uses.
    let carried = from.and_then(|f| inner.in_flight.remove(f)).map(|f| f.hint);
    let snapshot = changed.then(|| inner.snapshot());
    drop(inner);
    if let Some(snapshot) = snapshot {
        state.persist(snapshot);
    }
    if let Some(dir) = &state.dir {
        remove_files(dir, &unused);
    }
    if let Some(hint) = carried {
        state.enqueue(GameHint { name: to.to_string(), ..hint });
    }
    emit_changed(app, to);
}

#[tauri::command]
pub fn get_game_art(app: AppHandle, game: String, kind: ArtKind) -> Result<Option<GameArtImage>, String> {
    let Some(state) = app.try_state::<GameArt>() else { return Ok(None) };
    let Some(dir) = state.dir.clone() else { return Ok(None) };
    let entry = lock(&state.inner).index.get(&game).cloned();
    let Some(entry) = entry else {
        state.enqueue(GameHint { name: game, ..Default::default() });
        return Ok(None);
    };
    let order = match kind {
        ArtKind::Icon => [&entry.icon, &entry.cover],
        ArtKind::Cover => [&entry.cover, &entry.icon],
    };
    let mut missing = false;
    for file in order.into_iter().flatten() {
        match std::fs::read(dir.join(file)) {
            Ok(bytes) => {
                return Ok(Some(GameArtImage {
                    url: format!("data:{};base64,{}", mime_for(file), crate::base64_encode(&bytes)),
                    custom: entry.custom,
                }))
            }
            Err(e) => {
                log::debug!("reading game art {file}: {e}");
                missing = true;
            }
        }
    }
    if missing {
        state.forget_missing(&game, &dir);
    }
    state.enqueue(GameHint {
        name: game,
        executable: entry.executable,
        executable_path: entry.executable_path,
    });
    Ok(None)
}

#[tauri::command]
pub async fn choose_game_art(app: AppHandle, game: String) -> Result<bool, String> {
    tauri::async_runtime::spawn_blocking(move || choose_blocking(&app, &game).map_err(|e| format!("{e:#}")))
        .await
        .map_err(|e| format!("task failed: {e}"))?
}

fn choose_blocking(app: &AppHandle, game: &str) -> Result<bool> {
    use tauri_plugin_dialog::DialogExt;

    if game.trim().is_empty() {
        bail!("no game given");
    }
    let state = app.try_state::<GameArt>().context("game art is not ready")?;
    let dir = state.dir.clone().context("there is no data folder to keep pictures in")?;
    let Some(picked) = app
        .dialog()
        .file()
        .set_title(format!("Picture for {game}"))
        .add_filter("Images", &["png", "jpg", "jpeg", "webp"])
        .blocking_pick_file()
    else {
        return Ok(false);
    };
    let path = picked.into_path().context("reading the chosen path")?;
    let size = std::fs::metadata(&path)
        .with_context(|| format!("reading {}", path.display()))?
        .len();
    if size > MAX_IMAGE_BYTES {
        bail!("that picture is larger than 10 MB");
    }
    let bytes = std::fs::read(&path).with_context(|| format!("reading {}", path.display()))?;
    let ext = image_format(&bytes).context("that file is not a PNG, JPEG or WebP picture")?;
    let staged = stage(&dir, &bytes, ext, SOURCE_CUSTOM)?;

    let mut inner = lock(&state.inner);
    let name = free_file_name(&inner.index, game, "custom", ext);
    if let Err(e) = std::fs::rename(&staged.part, dir.join(&name)) {
        drop(inner);
        let _ = std::fs::remove_file(&staged.part);
        return Err(e).context("saving the picture");
    }
    let entry = inner.index.entry(game.to_string()).or_default();
    let replaced: Vec<String> = entry.files().filter(|f| *f != name).map(str::to_string).collect();
    entry.icon = None;
    entry.cover = Some(name);
    entry.custom = true;
    entry.source = Some(SOURCE_CUSTOM.to_string());
    entry.checked_at = Some(Utc::now().to_rfc3339());
    let unused = orphans(&inner.index, replaced);
    let snapshot = inner.snapshot();
    drop(inner);

    state.persist(snapshot);
    remove_files(&dir, &unused);
    emit_changed(app, game);
    Ok(true)
}

#[tauri::command]
pub fn reset_game_art(app: AppHandle, game: String) -> Result<(), String> {
    let Some(state) = app.try_state::<GameArt>() else { return Ok(()) };
    let mut inner = lock(&state.inner);
    let removed = inner.index.remove(&game);
    // Whatever is running for it was started before the reset; its result is thrown away.
    inner.in_flight.remove(&game);
    let unused = removed
        .as_ref()
        .map(|e| orphans(&inner.index, e.files().map(str::to_string)))
        .unwrap_or_default();
    let snapshot = removed.is_some().then(|| inner.snapshot());
    drop(inner);
    if let Some(snapshot) = snapshot {
        state.persist(snapshot);
    }
    if let Some(dir) = &state.dir {
        remove_files(dir, &unused);
    }
    let removed = removed.unwrap_or_default();
    state.enqueue(GameHint {
        name: game.clone(),
        executable: removed.executable,
        executable_path: removed.executable_path,
    });
    emit_changed(&app, &game);
    Ok(())
}

// ---------------------------------------------------------------------------
// Images

fn image_format(bytes: &[u8]) -> Option<&'static str> {
    if bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
        Some("png")
    } else if bytes.starts_with(&[0xFF, 0xD8, 0xFF]) {
        Some("jpg")
    } else if bytes.len() >= 12 && &bytes[..4] == b"RIFF" && &bytes[8..12] == b"WEBP" {
        Some("webp")
    } else {
        None
    }
}

fn mime_for(file: &str) -> &'static str {
    match file.rsplit('.').next().map(str::to_ascii_lowercase).as_deref() {
        Some("jpg" | "jpeg") => "image/jpeg",
        Some("webp") => "image/webp",
        _ => "image/png",
    }
}

/// A picture written next to the cache under a temporary name, not yet in the index.
#[derive(Debug)]
struct Staged {
    part: PathBuf,
    ext: &'static str,
    source: &'static str,
}

fn stage(dir: &Path, bytes: &[u8], ext: &'static str, source: &'static str) -> Result<Staged> {
    static COUNTER: AtomicU64 = AtomicU64::new(0);
    std::fs::create_dir_all(dir).with_context(|| format!("creating {}", dir.display()))?;
    let n = COUNTER.fetch_add(1, Ordering::Relaxed);
    let part = dir.join(format!(".stage-{}-{n}.part", std::process::id()));
    std::fs::write(&part, bytes).with_context(|| format!("writing {}", part.display()))?;
    Ok(Staged { part, ext, source })
}

fn encode_png(icon: &crate::win::IconImage) -> Result<Vec<u8>> {
    let mut out = Vec::new();
    let mut encoder = png::Encoder::new(&mut out, icon.width, icon.height);
    encoder.set_color(png::ColorType::Rgba);
    encoder.set_depth(png::BitDepth::Eight);
    let mut writer = encoder.write_header().context("writing PNG header")?;
    writer.write_image_data(&icon.rgba).context("writing PNG data")?;
    writer.finish().context("finishing PNG")?;
    Ok(out)
}

/// Reads at most `max` bytes, failing when there is more.
fn read_capped(reader: impl Read, max: u64) -> Result<Vec<u8>> {
    let mut bytes = Vec::new();
    reader.take(max + 1).read_to_end(&mut bytes).context("reading body")?;
    if bytes.len() as u64 > max {
        bail!("body is larger than {max} bytes");
    }
    Ok(bytes)
}

fn percent_encode(s: &str) -> String {
    let mut out = String::with_capacity(s.len() * 3);
    for b in s.bytes() {
        if b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_' | b'.' | b'~') {
            out.push(b as char);
        } else {
            out.push_str(&format!("%{b:02X}"));
        }
    }
    out
}

// ---------------------------------------------------------------------------
// Steam

/// Tokens of Valve's KeyValues text format.
#[derive(Debug, PartialEq)]
enum VdfToken {
    Str(String),
    Open,
    Close,
}

fn vdf_tokens(text: &str) -> Vec<VdfToken> {
    let mut tokens = Vec::new();
    let mut chars = text.chars().peekable();
    while let Some(c) = chars.next() {
        match c {
            '"' => {
                let mut s = String::new();
                while let Some(c) = chars.next() {
                    match c {
                        '"' => break,
                        '\\' => match chars.next() {
                            Some('n') => s.push('\n'),
                            Some('t') => s.push('\t'),
                            Some(other) => s.push(other),
                            None => break,
                        },
                        _ => s.push(c),
                    }
                }
                tokens.push(VdfToken::Str(s));
            }
            '{' => tokens.push(VdfToken::Open),
            '}' => tokens.push(VdfToken::Close),
            '/' if chars.peek() == Some(&'/') => {
                for c in chars.by_ref() {
                    if c == '\n' {
                        break;
                    }
                }
            }
            c if c.is_whitespace() => {}
            c => {
                let mut s = String::from(c);
                while let Some(&next) = chars.peek() {
                    if next.is_whitespace() || matches!(next, '"' | '{' | '}') {
                        break;
                    }
                    s.push(next);
                    chars.next();
                }
                tokens.push(VdfToken::Str(s));
            }
        }
    }
    tokens
}

/// Every `"key" "value"` pair in the file, at any depth, in order. Section names are skipped.
fn vdf_pairs(text: &str) -> Vec<(String, String)> {
    let tokens = vdf_tokens(text);
    let mut pairs = Vec::new();
    let mut i = 0;
    while i < tokens.len() {
        match (&tokens[i], tokens.get(i + 1)) {
            (VdfToken::Str(key), Some(VdfToken::Str(value))) => {
                pairs.push((key.clone(), value.clone()));
                i += 2;
            }
            _ => i += 1,
        }
    }
    pairs
}

/// Library folders listed in `libraryfolders.vdf`: `"path"` keys, or the numbered values of the
/// pre-2021 format.
fn library_paths_from_vdf(text: &str) -> Vec<PathBuf> {
    vdf_pairs(text)
        .into_iter()
        .filter(|(k, v)| {
            k.eq_ignore_ascii_case("path")
                || (!k.is_empty()
                    && k.chars().all(|c| c.is_ascii_digit())
                    && v.contains(':')
                    && v.contains(['\\', '/']))
        })
        .map(|(_, v)| PathBuf::from(v))
        .collect()
}

/// Lowercase, backslashes, no `\\?\` prefix, no trailing separator.
fn normalize_path(path: &str) -> String {
    let path = path.strip_prefix(r"\\?\").unwrap_or(path);
    path.replace('/', "\\").to_lowercase().trim_end_matches('\\').to_string()
}

struct SteamInstall {
    root: PathBuf,
    libraries: Vec<PathBuf>,
}

impl SteamInstall {
    fn locate() -> Option<Self> {
        let key = winreg::RegKey::predef(winreg::enums::HKEY_CURRENT_USER)
            .open_subkey(r"Software\Valve\Steam")
            .ok()?;
        let path: String = key.get_value("SteamPath").ok()?;
        let root = PathBuf::from(path.replace('/', "\\"));
        if !root.is_dir() {
            return None;
        }
        let libraries = steam_libraries(&root);
        Some(Self { root, libraries })
    }
}

fn steam_libraries(root: &Path) -> Vec<PathBuf> {
    let mut libraries = vec![root.to_path_buf()];
    if let Ok(text) = std::fs::read_to_string(root.join("steamapps").join("libraryfolders.vdf")) {
        for path in library_paths_from_vdf(&text) {
            let norm = normalize_path(&path.to_string_lossy());
            if !libraries.iter().any(|l| normalize_path(&l.to_string_lossy()) == norm) {
                libraries.push(path);
            }
        }
    }
    libraries
}

/// The app id of the Steam game whose install folder holds `exe_path`.
fn steam_app_id_for_exe(exe_path: &str, libraries: &[PathBuf]) -> Option<u32> {
    let exe = normalize_path(exe_path);
    libraries.iter().find_map(|library| {
        let prefix = format!("{}\\steamapps\\common\\", normalize_path(&library.to_string_lossy()));
        let installdir = exe.strip_prefix(&prefix)?.split('\\').next().filter(|d| !d.is_empty())?;
        app_id_for_installdir(library, installdir)
    })
}

fn app_id_for_installdir(library: &Path, installdir: &str) -> Option<u32> {
    let steamapps = library.join("steamapps");
    let entries = std::fs::read_dir(&steamapps).ok()?;
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().to_lowercase();
        if !name.starts_with("appmanifest_") || !name.ends_with(".acf") {
            continue;
        }
        let Ok(text) = std::fs::read_to_string(entry.path()) else { continue };
        let pairs = vdf_pairs(&text);
        let dir_matches = pairs
            .iter()
            .any(|(k, v)| k.eq_ignore_ascii_case("installdir") && v.to_lowercase() == installdir);
        if dir_matches {
            let id = pairs
                .iter()
                .find(|(k, _)| k.eq_ignore_ascii_case("appid"))
                .and_then(|(_, v)| v.trim().parse().ok());
            if id.is_some() {
                return id;
            }
        }
    }
    None
}

/// Candidate files in Steam's local library cache, best first, among `names`. Newer clients
/// keep each image in a hashed subfolder of the app's folder, older ones flat.
fn steam_cache_files(root: &Path, app_id: u32, names: &[&str]) -> Vec<PathBuf> {
    let cache = root.join("appcache").join("librarycache");
    let app_dir = cache.join(app_id.to_string());
    let subdirs: Vec<PathBuf> = std::fs::read_dir(&app_dir)
        .map(|entries| {
            entries
                .flatten()
                .filter(|e| e.file_type().is_ok_and(|t| t.is_dir()))
                .map(|e| e.path())
                .collect()
        })
        .unwrap_or_default();
    let mut out = Vec::new();
    for name in names {
        out.push(app_dir.join(name));
        let mut nested: Vec<(std::time::SystemTime, PathBuf)> = subdirs
            .iter()
            .map(|d| d.join(name))
            .filter_map(|p| Some((p.metadata().ok()?.modified().ok()?, p)))
            .collect();
        nested.sort_by_key(|(modified, _)| std::cmp::Reverse(*modified));
        out.extend(nested.into_iter().map(|(_, p)| p));
        out.push(cache.join(format!("{app_id}_{name}")));
    }
    out
}

/// Full URLs of the named assets from an `IStoreBrowseService/GetItems` response.
fn store_asset_url(response: &serde_json::Value, key: &str) -> Option<String> {
    let assets = response.pointer("/response/store_items/0/assets")?;
    let format = assets.get("asset_url_format")?.as_str()?;
    let file = assets.get(key)?.as_str().filter(|f| !f.is_empty())?;
    Some(format!("{STEAM_STORE_ASSETS}{}", format.replace("${FILENAME}", file)))
}

// ---------------------------------------------------------------------------
// Discord

/// The parts of a Discord detectable application this module uses.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
struct Detectable {
    id: String,
    name: String,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    aliases: Vec<String>,
    /// Windows executable file names, lowercase, without folders or the `>` marker.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    exes: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    icon_hash: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    cover_image_hash: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    steam_app_id: Option<u32>,
}

#[derive(Serialize, Deserialize)]
struct DetectableCache {
    fetched_at: String,
    apps: Vec<Detectable>,
}

/// Deserializes a field, turning a value of an unexpected shape into `None` instead of failing
/// the whole 24,000-entry list.
fn lenient<'de, D, T>(deserializer: D) -> std::result::Result<Option<T>, D::Error>
where
    D: Deserializer<'de>,
    T: DeserializeOwned,
{
    let value = serde_json::Value::deserialize(deserializer)?;
    Ok(serde_json::from_value(value).ok())
}

#[derive(Deserialize)]
struct RawApp {
    #[serde(default, deserialize_with = "lenient")]
    id: Option<String>,
    #[serde(default, deserialize_with = "lenient")]
    name: Option<String>,
    #[serde(default, deserialize_with = "lenient")]
    aliases: Option<Vec<String>>,
    #[serde(default, deserialize_with = "lenient")]
    executables: Option<Vec<RawExecutable>>,
    #[serde(default, deserialize_with = "lenient")]
    icon_hash: Option<String>,
    #[serde(default, deserialize_with = "lenient")]
    cover_image_hash: Option<String>,
    #[serde(default, deserialize_with = "lenient")]
    third_party_skus: Option<Vec<RawSku>>,
}

#[derive(Deserialize)]
struct RawExecutable {
    #[serde(default, deserialize_with = "lenient")]
    os: Option<String>,
    #[serde(default, deserialize_with = "lenient")]
    name: Option<String>,
}

#[derive(Deserialize)]
struct RawSku {
    #[serde(default, deserialize_with = "lenient")]
    distributor: Option<String>,
    #[serde(default, deserialize_with = "lenient")]
    id: Option<String>,
}

/// `win64/cs2.exe` and `>javaw.exe` both become the bare lowercase file name.
fn exe_basename(name: &str) -> Option<String> {
    let last = name.rsplit(['/', '\\']).next()?.trim().trim_start_matches('>').trim();
    (!last.is_empty()).then(|| last.to_lowercase())
}

/// Lowercase ASCII letters and digits only, so "VALORANT" and "Valorant" agree.
fn normalize_name(name: &str) -> String {
    name.chars().filter(char::is_ascii_alphanumeric).map(|c| c.to_ascii_lowercase()).collect()
}

fn slim_app(raw: RawApp) -> Option<Detectable> {
    let id = raw.id.filter(|s| !s.is_empty())?;
    let name = raw.name.filter(|s| !s.is_empty())?;
    let steam_app_id = raw.third_party_skus.unwrap_or_default().into_iter().find_map(|sku| {
        sku.distributor
            .filter(|d| d.eq_ignore_ascii_case("steam"))
            .and(sku.id)
            .and_then(|id| id.trim().parse().ok())
    });
    let icon_hash = raw.icon_hash.filter(|s| !s.is_empty());
    let cover_image_hash = raw.cover_image_hash.filter(|s| !s.is_empty());
    if icon_hash.is_none() && cover_image_hash.is_none() && steam_app_id.is_none() {
        return None;
    }
    let mut exes: Vec<String> = raw
        .executables
        .unwrap_or_default()
        .into_iter()
        .filter(|e| e.os.as_deref() == Some("win32"))
        .filter_map(|e| exe_basename(e.name.as_deref()?))
        .collect();
    exes.sort();
    exes.dedup();
    Some(Detectable {
        id,
        name,
        aliases: raw.aliases.unwrap_or_default(),
        exes,
        icon_hash,
        cover_image_hash,
        steam_app_id,
    })
}

fn parse_detectable(reader: impl Read) -> Result<Vec<Detectable>> {
    let raw: Vec<RawApp> = serde_json::from_reader(std::io::BufReader::new(reader))
        .context("parsing the detectable applications")?;
    Ok(raw.into_iter().filter_map(slim_app).collect())
}

/// Discord's entry for a game.
///
/// By exe: a file name only one entry lists is accepted; one several entries list (javaw.exe)
/// needs the entry's name or an alias to agree with the game's name. Without an exe match the
/// name alone must agree.
fn match_detectable<'a>(apps: &'a [Detectable], name: &str, exe: Option<&str>) -> Option<&'a Detectable> {
    let wanted = normalize_name(name);
    let agrees = |app: &Detectable| {
        !wanted.is_empty()
            && (normalize_name(&app.name) == wanted
                || app.aliases.iter().any(|a| normalize_name(a) == wanted))
    };
    if let Some(exe) = exe.and_then(exe_basename) {
        let by_exe: Vec<&Detectable> = apps.iter().filter(|a| a.exes.contains(&exe)).collect();
        match by_exe.as_slice() {
            [] => {}
            [only] => return Some(only),
            several => {
                if let Some(app) = several.iter().find(|a| agrees(a)) {
                    return Some(app);
                }
            }
        }
    }
    let mut by_name = apps.iter().filter(|a| agrees(a));
    let first = by_name.next()?;
    if first.icon_hash.is_some() {
        return Some(first);
    }
    Some(by_name.find(|a| a.icon_hash.is_some()).unwrap_or(first))
}

// ---------------------------------------------------------------------------
// Worker

/// What one lookup found. Pictures are staged files the commit moves into place.
#[derive(Debug, Default)]
struct Resolved {
    executable: Option<String>,
    executable_path: Option<String>,
    steam_app_id: Option<u32>,
    discord_app_id: Option<String>,
    icon: Option<Staged>,
    cover: Option<Staged>,
}

impl Resolved {
    fn discard(self) {
        for staged in self.icon.into_iter().chain(self.cover) {
            let _ = std::fs::remove_file(staged.part);
        }
    }
}

fn worker(app: AppHandle, dir: PathBuf, rx: Receiver<Job>) {
    // Leftovers of a lookup the app was closed during.
    if let Ok(entries) = std::fs::read_dir(&dir) {
        for entry in entries.flatten() {
            if entry.file_name().to_string_lossy().ends_with(".part") {
                let _ = std::fs::remove_file(entry.path());
            }
        }
    }
    let mut resolver = Resolver::new(dir.clone());
    loop {
        let job = match rx.recv_timeout(WORKER_IDLE) {
            Ok(job) => job,
            Err(RecvTimeoutError::Timeout) => {
                resolver.release();
                continue;
            }
            Err(RecvTimeoutError::Disconnected) => break,
        };
        let Some(state) = app.try_state::<GameArt>() else { continue };
        let hint = match lock(&state.inner).in_flight.get(&job.name) {
            Some(f) if f.token == job.token => f.hint.clone(),
            _ => continue,
        };
        let started = Instant::now();
        let found = match std::panic::catch_unwind(AssertUnwindSafe(|| resolver.resolve(&hint))) {
            Ok(found) => found,
            Err(_) => {
                log::warn!("game art lookup for {} panicked", hint.name);
                Resolved::default()
            }
        };
        log::debug!("game art lookup for {} took {:?}", hint.name, started.elapsed());
        state.commit(&app, &dir, &job, &hint, found);
    }
}

struct Resolver {
    dir: PathBuf,
    http: Option<reqwest::blocking::Client>,
    apps: Option<Vec<Detectable>>,
    apps_fetched_at: Option<DateTime<Utc>>,
    apps_loaded_from_disk: bool,
    apps_last_attempt: Option<Instant>,
}

impl Resolver {
    fn new(dir: PathBuf) -> Self {
        Self {
            dir,
            http: None,
            apps: None,
            apps_fetched_at: None,
            apps_loaded_from_disk: false,
            apps_last_attempt: None,
        }
    }

    /// Frees the Discord list and the HTTP client while there is nothing to do.
    fn release(&mut self) {
        self.http = None;
        self.apps = None;
        self.apps_loaded_from_disk = false;
    }

    fn client(&mut self) -> Result<reqwest::blocking::Client> {
        if let Some(client) = &self.http {
            return Ok(client.clone());
        }
        let client = reqwest::blocking::Client::builder()
            .timeout(Duration::from_secs(20))
            .user_agent(concat!("CosNostra/", env!("CARGO_PKG_VERSION")))
            .build()
            .context("building the HTTP client")?;
        self.http = Some(client.clone());
        Ok(client)
    }

    fn resolve(&mut self, hint: &GameHint) -> Resolved {
        let mut path = hint.executable_path.clone();
        let exe = hint
            .executable
            .clone()
            .or_else(|| path.as_deref().and_then(|p| p.rsplit(['\\', '/']).next()).map(str::to_string));
        if path.is_none() {
            path = exe.as_deref().and_then(crate::win::find_process_image_path);
        }

        let steam = SteamInstall::locate();
        let mut steam_app_id = match (&steam, &path) {
            (Some(steam), Some(path)) => steam_app_id_for_exe(path, &steam.libraries),
            _ => None,
        };
        let discord = self
            .detectable()
            .and_then(|apps| match_detectable(apps, &hint.name, exe.as_deref()).cloned());
        if steam_app_id.is_none() {
            steam_app_id = discord.as_ref().and_then(|d| d.steam_app_id);
        }

        let cover = self.find_cover(steam.as_ref(), steam_app_id, discord.as_ref());
        let icon = self.find_icon(discord.as_ref(), path.as_deref());
        log::info!(
            "game art for {}: steam app {:?}, discord app {:?}, cover from {}, icon from {}",
            hint.name,
            steam_app_id,
            discord.as_ref().map(|d| d.id.as_str()),
            cover.as_ref().map_or("nowhere", |s| s.source),
            icon.as_ref().map_or("nowhere", |s| s.source),
        );
        Resolved {
            executable: exe,
            executable_path: path,
            steam_app_id,
            discord_app_id: discord.map(|d| d.id),
            icon,
            cover,
        }
    }

    fn find_cover(
        &mut self,
        steam: Option<&SteamInstall>,
        steam_app_id: Option<u32>,
        discord: Option<&Detectable>,
    ) -> Option<Staged> {
        if let Some(id) = steam_app_id {
            if let Some(steam) = steam {
                let local = steam_cache_files(&steam.root, id, &["library_600x900.jpg", "library_capsule.jpg"]);
                if let Some(staged) = local.iter().find_map(|p| self.stage_local(p, SOURCE_STEAM)) {
                    return Some(staged);
                }
            }
            if let Some(staged) = self.stage_url(&format!("{STEAM_CDN}/{id}/library_600x900.jpg"), SOURCE_STEAM) {
                return Some(staged);
            }
            if let Some(assets) = self.store_item(id) {
                for key in ["library_capsule", "header"] {
                    if let Some(url) = store_asset_url(&assets, key) {
                        if let Some(staged) = self.stage_url(&url, SOURCE_STEAM) {
                            return Some(staged);
                        }
                    }
                }
            }
        }
        if let Some(app) = discord {
            if let Some(hash) = &app.cover_image_hash {
                let url = format!("https://cdn.discordapp.com/app-icons/{}/{hash}.png?size=1024", app.id);
                if let Some(staged) = self.stage_url(&url, SOURCE_DISCORD) {
                    return Some(staged);
                }
            }
        }
        let id = steam_app_id?;
        if let Some(steam) = steam {
            let local = steam_cache_files(&steam.root, id, &["header.jpg", "library_header.jpg"]);
            if let Some(staged) = local.iter().find_map(|p| self.stage_local(p, SOURCE_STEAM)) {
                return Some(staged);
            }
        }
        self.stage_url(&format!("{STEAM_CDN}/{id}/header.jpg"), SOURCE_STEAM)
    }

    fn find_icon(&mut self, discord: Option<&Detectable>, exe_path: Option<&str>) -> Option<Staged> {
        if let Some(app) = discord {
            if let Some(hash) = &app.icon_hash {
                let url = format!("https://cdn.discordapp.com/app-icons/{}/{hash}.png?size={ICON_SIZE}", app.id);
                if let Some(staged) = self.stage_url(&url, SOURCE_DISCORD) {
                    return Some(staged);
                }
            }
        }
        let path = exe_path?;
        let icon = match crate::win::extract_exe_icon(path, ICON_SIZE) {
            Ok(Some(icon)) => icon,
            Ok(None) => {
                log::debug!("{path} has no icon");
                return None;
            }
            Err(e) => {
                log::debug!("extracting the icon of {path}: {e:#}");
                return None;
            }
        };
        if icon.rgba.chunks_exact(4).all(|px| px[3] == 0) {
            log::debug!("the icon of {path} is fully transparent");
            return None;
        }
        let bytes = encode_png(&icon).map_err(|e| log::debug!("encoding the icon of {path}: {e:#}")).ok()?;
        self.stage_bytes(&bytes, "png", SOURCE_EXE)
    }

    fn stage_bytes(&self, bytes: &[u8], ext: &'static str, source: &'static str) -> Option<Staged> {
        stage(&self.dir, bytes, ext, source)
            .map_err(|e| log::info!("staging game art: {e:#}"))
            .ok()
    }

    fn stage_local(&self, path: &Path, source: &'static str) -> Option<Staged> {
        let meta = path.metadata().ok()?;
        if !meta.is_file() || meta.len() > MAX_IMAGE_BYTES {
            return None;
        }
        let bytes = std::fs::read(path).ok()?;
        let ext = image_format(&bytes)?;
        self.stage_bytes(&bytes, ext, source)
    }

    fn stage_url(&mut self, url: &str, source: &'static str) -> Option<Staged> {
        match self.fetch_image(url) {
            Ok(Some((bytes, ext))) => self.stage_bytes(&bytes, ext, source),
            Ok(None) => None,
            Err(e) => {
                log::info!("fetching {url}: {e:#}");
                None
            }
        }
    }

    /// `Ok(None)` for anything that is not a 200 with an image body of a known format.
    fn fetch_image(&mut self, url: &str) -> Result<Option<(Vec<u8>, &'static str)>> {
        let response = self.client()?.get(url).send().context("sending request")?;
        if response.status() != reqwest::StatusCode::OK {
            log::debug!("{url}: HTTP {}", response.status());
            return Ok(None);
        }
        let content_type = response
            .headers()
            .get(reqwest::header::CONTENT_TYPE)
            .and_then(|v| v.to_str().ok())
            .unwrap_or("");
        if !content_type.starts_with("image/") {
            log::debug!("{url}: not an image ({content_type})");
            return Ok(None);
        }
        if response.content_length().is_some_and(|len| len > MAX_IMAGE_BYTES) {
            log::debug!("{url}: image larger than 10 MB");
            return Ok(None);
        }
        let bytes = read_capped(response, MAX_IMAGE_BYTES)?;
        Ok(image_format(&bytes).map(|ext| (bytes, ext)))
    }

    fn store_item(&mut self, app_id: u32) -> Option<serde_json::Value> {
        let input = format!(
            r#"{{"ids":[{{"appid":{app_id}}}],"context":{{"language":"english","country_code":"US"}},"data_request":{{"include_assets":true}}}}"#
        );
        let url = format!(
            "https://api.steampowered.com/IStoreBrowseService/GetItems/v1?input_json={}",
            percent_encode(&input)
        );
        let mut fetch = || -> Result<Option<serde_json::Value>> {
            let response = self.client()?.get(&url).send().context("sending request")?;
            if response.status() != reqwest::StatusCode::OK {
                log::debug!("Steam store item {app_id}: HTTP {}", response.status());
                return Ok(None);
            }
            let bytes = read_capped(response, MAX_JSON_BYTES)?;
            Ok(Some(serde_json::from_slice(&bytes).context("parsing the store item")?))
        };
        fetch().map_err(|e| log::info!("Steam store item {app_id}: {e:#}")).ok().flatten()
    }

    /// The Discord list, from memory, disk, or the network when the copy is a week old.
    fn detectable(&mut self) -> Option<&[Detectable]> {
        let path = self.dir.join(DETECTABLE_FILE);
        if !self.apps_loaded_from_disk {
            self.apps_loaded_from_disk = true;
            match std::fs::read(&path) {
                Ok(bytes) => match serde_json::from_slice::<DetectableCache>(&bytes) {
                    Ok(cache) => {
                        self.apps_fetched_at = DateTime::parse_from_rfc3339(&cache.fetched_at)
                            .ok()
                            .map(|t| t.with_timezone(&Utc));
                        self.apps = Some(cache.apps);
                    }
                    Err(e) => log::info!("{} is unreadable: {e}", path.display()),
                },
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
                Err(e) => log::info!("reading {}: {e}", path.display()),
            }
        }
        let fresh = self.apps.is_some()
            && self.apps_fetched_at.is_some_and(|t| {
                Utc::now().signed_duration_since(t) < chrono::Duration::days(DETECTABLE_MAX_AGE_DAYS)
            });
        let may_try = self.apps_last_attempt.is_none_or(|t| t.elapsed() >= DETECTABLE_RETRY);
        if !fresh && may_try {
            self.apps_last_attempt = Some(Instant::now());
            match self.fetch_detectable() {
                Ok(apps) => {
                    let now = Utc::now();
                    let cache = DetectableCache { fetched_at: now.to_rfc3339(), apps };
                    match serde_json::to_vec(&cache) {
                        Ok(bytes) => {
                            if let Err(e) = write_atomic(&path, &bytes) {
                                log::info!("saving the Discord game list: {e:#}");
                            }
                        }
                        Err(e) => log::info!("serializing the Discord game list: {e}"),
                    }
                    log::info!("refreshed the Discord game list: {} games", cache.apps.len());
                    self.apps = Some(cache.apps);
                    self.apps_fetched_at = Some(now);
                }
                Err(e) => log::info!(
                    "refreshing the Discord game list failed{}: {e:#}",
                    if self.apps.is_some() { ", using the cached copy" } else { "" }
                ),
            }
        }
        self.apps.as_deref()
    }

    fn fetch_detectable(&mut self) -> Result<Vec<Detectable>> {
        let response = self
            .client()?
            .get(DETECTABLE_URL)
            .timeout(Duration::from_secs(120))
            .send()
            .context("sending request")?;
        if response.status() != reqwest::StatusCode::OK {
            bail!("HTTP {}", response.status());
        }
        if response.content_length().is_some_and(|len| len > MAX_DETECTABLE_BYTES) {
            bail!("the list is larger than 64 MB");
        }
        // Truncating at the cap leaves invalid JSON, so an oversized body fails to parse.
        parse_detectable(response.take(MAX_DETECTABLE_BYTES))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir(tag: &str) -> PathBuf {
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let dir = std::env::temp_dir().join(format!("cosnostra-game-art-{tag}-{}-{nanos}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn app(id: &str, name: &str, exes: &[&str]) -> Detectable {
        Detectable {
            id: id.into(),
            name: name.into(),
            aliases: Vec::new(),
            exes: exes.iter().map(|e| e.to_string()).collect(),
            icon_hash: Some(format!("icon{id}")),
            cover_image_hash: None,
            steam_app_id: None,
        }
    }

    fn entry_with(icon: Option<&str>, cover: Option<&str>) -> Entry {
        Entry {
            icon: icon.map(Into::into),
            cover: cover.map(Into::into),
            checked_at: Some(Utc::now().to_rfc3339()),
            ..Default::default()
        }
    }

    #[test]
    fn vdf_scanner_reads_library_folders_in_both_formats() {
        let current = r#"
"libraryfolders"
{
	"0"
	{
		"path"		"C:\\Program Files (x86)\\Steam"
		"label"		""
		"apps"
		{
			"228980"		"486965132"
		}
	}
	"1"
	{
		"path"		"E:\\SteamLibrary"
		"apps" { "730" "71579838838" }
	}
}"#;
        assert_eq!(
            library_paths_from_vdf(current),
            vec![PathBuf::from(r"C:\Program Files (x86)\Steam"), PathBuf::from(r"E:\SteamLibrary")]
        );
        let legacy = "\"LibraryFolders\"\n{\n\t\"TimeNextStatsReport\"\t\t\"1234567890\"\n\t\"ContentStatsID\"\t\t\"-123\"\n\t\"1\"\t\t\"D:\\\\Games\\\\Steam\"\n}\n// trailing comment";
        assert_eq!(library_paths_from_vdf(legacy), vec![PathBuf::from(r"D:\Games\Steam")]);
        // Unterminated and brace-heavy input does not panic.
        let _ = vdf_pairs("\"a\" { \"b\" \"c");
        let _ = vdf_pairs("}}}{{ unquoted value \\");
    }

    #[test]
    fn appmanifest_installdir_gives_the_app_id() {
        let root = temp_dir("steam");
        let lib_a = root.join("Steam");
        let lib_b = root.join("SteamLibrary");
        for lib in [&lib_a, &lib_b] {
            std::fs::create_dir_all(lib.join("steamapps").join("common")).unwrap();
        }
        std::fs::write(
            lib_b.join("steamapps").join("appmanifest_730.acf"),
            "\"AppState\"\n{\n\t\"appid\"\t\t\"730\"\n\t\"name\"\t\t\"Counter-Strike 2\"\n\t\"installdir\"\t\t\"Counter-Strike Global Offensive\"\n}\n",
        )
        .unwrap();
        std::fs::write(
            lib_b.join("steamapps").join("appmanifest_3527290.acf"),
            "\"AppState\" { \"appid\" \"3527290\" \"installdir\" \"PEAK\" }",
        )
        .unwrap();
        std::fs::write(lib_b.join("steamapps").join("notes.txt"), "\"installdir\" \"PEAK\"").unwrap();
        let libraries = vec![lib_a.clone(), lib_b.clone()];

        let cs2 = format!(
            "{}/steamapps/COMMON/counter-strike global offensive/game/bin/win64/cs2.exe",
            lib_b.to_string_lossy().to_uppercase()
        );
        assert_eq!(steam_app_id_for_exe(&cs2, &libraries), Some(730));
        let peak = lib_b.join(r"steamapps\common\PEAK\PEAK.exe");
        assert_eq!(steam_app_id_for_exe(&format!(r"\\?\{}", peak.display()), &libraries), Some(3527290));
        // Installed folder without a manifest, a file outside any library, and a lookalike.
        let unknown = lib_a.join(r"steamapps\common\Other\other.exe");
        assert_eq!(steam_app_id_for_exe(&unknown.to_string_lossy(), &libraries), None);
        assert_eq!(steam_app_id_for_exe(r"C:\Riot Games\VALORANT\live\VALORANT.exe", &libraries), None);
        let lookalike = format!("{}2\\steamapps\\common\\PEAK\\PEAK.exe", lib_b.display());
        assert_eq!(steam_app_id_for_exe(&lookalike, &libraries), None);

        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn steam_cache_prefers_flat_then_newest_nested_then_legacy() {
        let root = temp_dir("librarycache");
        let files = steam_cache_files(&root, 730, &["library_600x900.jpg"]);
        let cache = root.join("appcache").join("librarycache");
        assert_eq!(files, vec![cache.join("730").join("library_600x900.jpg"), cache.join("730_library_600x900.jpg")]);
        let nested = cache.join("3527290").join("480bd879");
        std::fs::create_dir_all(&nested).unwrap();
        std::fs::write(nested.join("library_600x900.jpg"), [0xFF, 0xD8, 0xFF, 0xE0]).unwrap();
        let files = steam_cache_files(&root, 3527290, &["library_600x900.jpg"]);
        assert_eq!(files[1], nested.join("library_600x900.jpg"));
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn discord_entries_are_slimmed_from_the_raw_list() {
        let json = r#"[
            {"id":"356869127241072640","name":"Counter-Strike 2","aliases":["CS2"],
             "executables":[{"is_launcher":false,"name":"win64/cs2.exe","os":"win32"},
                            {"name":"cs2_osx","os":"darwin"}],
             "icon_hash":"558f","cover_image_hash":"694f",
             "third_party_skus":[{"distributor":"epic","id":null},{"distributor":"steam","id":"730"}],
             "overlay_methods":null},
            {"id":"1","name":"Minecraft","executables":[{"name":">javaw.exe","os":"win32","arguments":"-jar"},
                                                        {"name":"minecraft/runtime/bin/JAVAW.exe","os":"win32"}],
             "icon_hash":"abc","aliases":null},
            {"id":"2","name":"Nothing useful","executables":[{"name":"x.exe","os":"win32"}],"icon_hash":null},
            {"id":"3","name":"Odd shapes","executables":"not a list","icon_hash":42,"cover_image_hash":"c"}
        ]"#;
        let apps = parse_detectable(json.as_bytes()).unwrap();
        assert_eq!(apps.len(), 3);
        assert_eq!(apps[0].exes, vec!["cs2.exe"]);
        assert_eq!(apps[0].steam_app_id, Some(730));
        assert_eq!(apps[0].aliases, vec!["CS2"]);
        assert_eq!(apps[1].exes, vec!["javaw.exe"]);
        assert_eq!(apps[2].name, "Odd shapes");
        assert!(apps[2].exes.is_empty() && apps[2].icon_hash.is_none());
    }

    #[test]
    fn discord_matching_rules() {
        let mut minecraft = app("1", "Minecraft", &["javaw.exe"]);
        minecraft.aliases = vec!["Minecraft Java Edition".into()];
        let apps = vec![
            app("700136079562375258", "VALORANT", &["valorant-win64-shipping.exe"]),
            app("356869127241072640", "Counter-Strike 2", &["cs2.exe"]),
            minecraft,
            app("2", "Spiral Knights", &["javaw.exe"]),
            app("3", "Some Game", &["game.exe"]),
            app("4", "Other Game", &["game.exe"]),
        ];
        let id = |name: &str, exe: Option<&str>| match_detectable(&apps, name, exe).map(|a| a.id.clone());

        // Path segments and case in the hint's exe.
        assert_eq!(id("cs2", Some(r"Win64\CS2.exe")).as_deref(), Some("356869127241072640"));
        // A unique exe wins even when the library calls the game something else.
        assert_eq!(id("My renamed game", Some("cs2.exe")).as_deref(), Some("356869127241072640"));
        // Ambiguous exe needs the name (or an alias) to agree.
        assert_eq!(id("Spiral Knights", Some(">javaw.exe")).as_deref(), Some("2"));
        assert_eq!(id("minecraft: java edition", Some("javaw.exe")).as_deref(), Some("1"));
        assert_eq!(id("Some Other Java Thing", Some("javaw.exe")), None);
        assert_eq!(id("Unrelated", Some("game.exe")), None);
        // Name only: normalized equality, nothing fuzzier.
        assert_eq!(id("Valorant", None).as_deref(), Some("700136079562375258"));
        assert_eq!(id("V A L O R A N T!", None).as_deref(), Some("700136079562375258"));
        assert_eq!(id("Valorant 2", None), None);
        assert_eq!(id("", None), None);
        assert_eq!(id("日本語", None), None);
        // An unknown exe falls back to the name.
        assert_eq!(id("VALORANT", Some("valorant.exe")).as_deref(), Some("700136079562375258"));
    }

    #[test]
    fn renames_move_or_drop_entries() {
        let mut index = Index::new();
        index.insert("Old".into(), Entry { custom: true, ..entry_with(None, Some("old-custom.png")) });
        let (unused, changed) = rename_in_index(&mut index, "Old", "New");
        assert!(changed && unused.is_empty());
        assert!(!index.contains_key("Old"));
        assert_eq!(index["New"].cover.as_deref(), Some("old-custom.png"));
        assert!(index["New"].custom);

        // Both exist: the target keeps its own pictures and the source's files go, except one
        // a third entry still uses.
        index.insert("Dup".into(), Entry {
            executable: Some("dup.exe".into()),
            ..entry_with(Some("dup-icon.png"), Some("shared-cover.jpg"))
        });
        index.insert("Third".into(), entry_with(None, Some("shared-cover.jpg")));
        let (unused, changed) = rename_in_index(&mut index, "Dup", "New");
        assert!(changed);
        assert_eq!(unused, vec!["dup-icon.png".to_string()]);
        assert_eq!(index["New"].cover.as_deref(), Some("old-custom.png"));
        assert_eq!(index["New"].executable.as_deref(), Some("dup.exe"));
        assert!(!index.contains_key("Dup"));

        // Nothing to move, or a rename onto itself.
        assert_eq!(rename_in_index(&mut index, "Missing", "New"), (Vec::new(), false));
        assert_eq!(rename_in_index(&mut index, "New", "New"), (Vec::new(), false));
        assert!(index.contains_key("New"));
    }

    #[test]
    fn retry_policy() {
        let now = Utc::now();
        let name_only = GameHint { name: "Game".into(), ..Default::default() };
        let with_path = GameHint {
            name: "Game".into(),
            executable: Some("game.exe".into()),
            executable_path: Some(r"C:\Games\game.exe".into()),
        };

        assert!(needs_resolve(None, &name_only, now));

        let empty_recent = Entry { checked_at: Some((now - chrono::Duration::hours(2)).to_rfc3339()), ..Default::default() };
        assert!(!needs_resolve(Some(&empty_recent), &name_only, now));
        let empty_old = Entry { checked_at: Some((now - chrono::Duration::hours(25)).to_rfc3339()), ..Default::default() };
        assert!(needs_resolve(Some(&empty_old), &name_only, now));
        let never_checked = Entry { checked_at: Some("garbage".into()), ..Default::default() };
        assert!(needs_resolve(Some(&never_checked), &name_only, now));
        assert!(needs_resolve(Some(&Entry::default()), &name_only, now));

        // A newly known path retries an entry without a cover, even with an icon.
        let icon_only = entry_with(Some("i.png"), None);
        assert!(!needs_resolve(Some(&icon_only), &name_only, now));
        assert!(needs_resolve(Some(&icon_only), &with_path, now));
        let icon_only_known_path = Entry { executable_path: Some("x".into()), ..icon_only };
        assert!(!needs_resolve(Some(&icon_only_known_path), &with_path, now));
        assert!(!needs_resolve(Some(&entry_with(None, Some("c.jpg"))), &with_path, now));

        // Custom art is never replaced automatically.
        let custom = Entry { custom: true, checked_at: None, ..entry_with(None, None) };
        assert!(!needs_resolve(Some(&custom), &with_path, now));
    }

    #[test]
    fn file_names_are_slug_plus_stable_hash() {
        assert_eq!(fnv1a32(b""), 0x811c_9dc5);
        assert_eq!(fnv1a32(b"a"), 0xe40c_292c);
        assert_eq!(fnv1a32(b"foobar"), 0xbf9c_f968);
        assert_eq!(file_base("Counter-Strike 2"), format!("counter-strike-2-{:08x}", fnv1a32(b"Counter-Strike 2")));
        assert_eq!(file_base("  --VALORANT!!  "), format!("valorant-{:08x}", fnv1a32(b"  --VALORANT!!  ")));
        assert!(file_base("日本語").starts_with("game-"));
        assert_ne!(file_base("Valorant"), file_base("VALORANT"));
        assert!(file_base(&"x".repeat(200)).len() <= 40 + 9);

        let mut index = Index::new();
        let base = file_base("New");
        assert_eq!(free_file_name(&index, "New", "cover", "jpg"), format!("{base}-cover.jpg"));
        // Its own file name is reused; one another game carried over by a rename is not.
        index.insert("New".into(), entry_with(None, Some(&format!("{base}-cover.jpg"))));
        assert_eq!(free_file_name(&index, "New", "cover", "jpg"), format!("{base}-cover.jpg"));
        index.insert("Renamed".into(), entry_with(None, Some(&format!("{base}-cover.jpg"))));
        assert_eq!(free_file_name(&index, "New", "cover", "jpg"), format!("{base}-cover-2.jpg"));
    }

    #[test]
    fn image_helpers() {
        assert_eq!(image_format(b"\x89PNG\r\n\x1a\nrest"), Some("png"));
        assert_eq!(image_format(&[0xFF, 0xD8, 0xFF, 0xDB]), Some("jpg"));
        assert_eq!(image_format(b"RIFF\0\0\0\0WEBPVP8 "), Some("webp"));
        assert_eq!(image_format(b"GIF89a"), None);
        assert_eq!(image_format(b"<html>"), None);
        assert_eq!(mime_for("a-cover.JPG"), "image/jpeg");
        assert_eq!(mime_for("a-custom.webp"), "image/webp");
        assert_eq!(mime_for("a-icon.png"), "image/png");
        assert_eq!(percent_encode(r#"{"a":1} ~x"#), "%7B%22a%22%3A1%7D%20~x");
        assert!(read_capped(&[0u8; 10][..], 10).is_ok());
        assert!(read_capped(&[0u8; 11][..], 10).is_err());
    }

    #[test]
    fn store_asset_urls_are_built_from_the_format() {
        let response: serde_json::Value = serde_json::from_str(
            r#"{"response":{"store_items":[{"appid":3527290,"assets":{
                "asset_url_format":"steam/apps/3527290/${FILENAME}?t=1786470571",
                "library_capsule":"480bd879ac737921bfa2529a6fea15961267ad21/library_600x900.jpg",
                "header":"31bac6b2eccf09b368f5e95ce510bae2baf3cfcd/header.jpg"}}]}}"#,
        )
        .unwrap();
        assert_eq!(
            store_asset_url(&response, "library_capsule").as_deref(),
            Some("https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/3527290/480bd879ac737921bfa2529a6fea15961267ad21/library_600x900.jpg?t=1786470571")
        );
        assert!(store_asset_url(&response, "hero_capsule").is_none());
        let missing: serde_json::Value = serde_json::from_str(r#"{"response":{"store_items":[{"success":2}]}}"#).unwrap();
        assert!(store_asset_url(&missing, "header").is_none());
    }

    #[test]
    fn index_round_trips_and_tolerates_unknown_fields() {
        let dir = temp_dir("index");
        let mut index = Index::new();
        index.insert("VALORANT".into(), Entry {
            executable: Some("VALORANT-Win64-Shipping.exe".into()),
            steam_app_id: None,
            discord_app_id: Some("700136079562375258".into()),
            icon: Some("valorant-icon.png".into()),
            source: Some(SOURCE_DISCORD.into()),
            ..entry_with(None, None)
        });
        write_atomic(&dir.join(INDEX_FILE), &serde_json::to_vec_pretty(&index).unwrap()).unwrap();
        assert_eq!(load_index(&dir), index);
        std::fs::write(dir.join(INDEX_FILE), "\u{FEFF}{\"X\":{\"cover\":\"x.jpg\",\"future\":1}}").unwrap();
        assert_eq!(load_index(&dir)["X"].cover.as_deref(), Some("x.jpg"));
        std::fs::write(dir.join(INDEX_FILE), "not json").unwrap();
        assert!(load_index(&dir).is_empty());
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn exe_icon_is_extracted_as_png() {
        let windir = std::env::var("WINDIR").unwrap_or_else(|_| r"C:\Windows".into());
        let explorer = format!(r"{windir}\explorer.exe");
        let icon = crate::win::extract_exe_icon(&explorer, ICON_SIZE).unwrap().expect("explorer has an icon");
        assert_eq!((icon.width, icon.height), (ICON_SIZE, ICON_SIZE));
        assert!(icon.rgba.chunks_exact(4).any(|px| px[3] != 0));
        let png = encode_png(&icon).unwrap();
        assert_eq!(image_format(&png), Some("png"));
        // A file with no icon resource, and one that does not exist.
        let no_icon = format!(r"{windir}\System32\kernel32.dll");
        assert!(crate::win::extract_exe_icon(&no_icon, ICON_SIZE).unwrap().is_none());
        assert!(crate::win::extract_exe_icon(r"C:\does\not\exist.exe", ICON_SIZE).unwrap().is_none());
    }

    #[test]
    #[ignore = "network"]
    fn network_discord_list_matches_known_games() {
        let dir = temp_dir("network-discord");
        let mut resolver = Resolver::new(dir.clone());
        let apps = resolver.detectable().expect("list").to_vec();
        assert!(apps.len() > 10_000);
        let valorant = match_detectable(&apps, "Valorant", Some("VALORANT-Win64-Shipping.exe")).unwrap();
        assert_eq!(valorant.id, "700136079562375258");
        assert!(valorant.icon_hash.is_some() && valorant.cover_image_hash.is_some());
        let cs2 = match_detectable(&apps, "Counter-Strike 2", Some("cs2.exe")).unwrap();
        assert_eq!(cs2.steam_app_id, Some(730));
        assert!(match_detectable(&apps, "League of Legends", Some("League of Legends.exe")).is_some());
        let icon = resolver.find_icon(Some(valorant), None).expect("icon");
        assert_eq!(icon.ext, "png");
        assert!(dir.join(DETECTABLE_FILE).is_file());
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    #[ignore = "network"]
    fn network_full_chain_for_known_games() {
        let dir = temp_dir("network-chain");
        let mut resolver = Resolver::new(dir.clone());
        let hint = |name: &str, exe: Option<&str>, path: Option<&str>| GameHint {
            name: name.into(),
            executable: exe.map(Into::into),
            executable_path: path.map(Into::into),
        };
        let valorant = resolver.resolve(&hint("VALORANT", Some("VALORANT-Win64-Shipping.exe"), None));
        assert_eq!(valorant.discord_app_id.as_deref(), Some("700136079562375258"));
        assert_eq!(valorant.icon.as_ref().map(|s| s.source), Some(SOURCE_DISCORD));
        assert!(valorant.cover.is_some());

        let cs2 = resolver.resolve(&hint("Counter-Strike 2", Some("cs2.exe"), None));
        assert_eq!(cs2.steam_app_id, Some(730));
        assert_eq!(cs2.cover.as_ref().map(|s| s.source), Some(SOURCE_STEAM));

        // Unknown to Discord and Steam: the exe's own icon, no cover.
        let windir = std::env::var("WINDIR").unwrap_or_else(|_| r"C:\Windows".into());
        let explorer = format!(r"{windir}\explorer.exe");
        let local = resolver.resolve(&hint("Not A Real Game 12345", None, Some(&explorer)));
        assert_eq!(local.icon.as_ref().map(|s| s.source), Some(SOURCE_EXE));
        assert!(local.cover.is_none());
        for found in [valorant, cs2, local] {
            found.discard();
        }
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    #[ignore = "network"]
    fn network_steam_store_assets_give_a_cover_for_new_apps() {
        let dir = temp_dir("network-steam");
        let mut resolver = Resolver::new(dir.clone());
        let item = resolver.store_item(3527290).expect("store item");
        let url = store_asset_url(&item, "library_capsule").expect("capsule");
        let staged = resolver.stage_url(&url, SOURCE_STEAM).expect("image");
        assert_eq!(staged.ext, "jpg");
        let cover = resolver.find_cover(None, Some(730), None).expect("cs2 cover");
        assert_eq!(cover.source, SOURCE_STEAM);
        let _ = std::fs::remove_dir_all(dir);
    }
}
