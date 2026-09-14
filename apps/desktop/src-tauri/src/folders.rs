//! Where a game's files go inside the clip folder: `<clip folder>\<Game>\Clips` for clips and
//! `<clip folder>\<Game>\Matches` for session recordings and the matches cut from them.
//!
//! Only files written after this layout existed live in it. Clips saved before it stay loose
//! in the clip folder and match files in `<clip folder>\Matches`; rows carry absolute paths, so
//! both keep working where they are.

use std::path::{Path, PathBuf};

/// Folder for clips whose game was never detected.
pub const UNKNOWN_GAME: &str = "Unknown game";
/// Subfolder of a game's folder holding its clips.
pub const CLIPS: &str = "Clips";
/// Subfolder of a game's folder holding its session recordings and match files. Also the name
/// of the pre-layout folder at the top of the clip folder.
pub const MATCHES: &str = "Matches";

/// `<clip folder>\<Game>`.
pub fn game_dir(clip_dir: &Path, game: Option<&str>) -> PathBuf {
    clip_dir.join(folder_name(game))
}

/// `<clip folder>\<Game>\Clips`.
pub fn clips_dir(clip_dir: &Path, game: Option<&str>) -> PathBuf {
    game_dir(clip_dir, game).join(CLIPS)
}

/// `<clip folder>\<Game>\Matches`.
pub fn matches_dir(clip_dir: &Path, game: &str) -> PathBuf {
    game_dir(clip_dir, Some(game)).join(MATCHES)
}

/// True when `dir` is the clips folder of `game` under `clip_dir`, compared the way Windows
/// compares paths. How a rename tells a clip that lives in the layout from one saved before it.
pub fn is_clips_dir_of(dir: &Path, clip_dir: &Path, game: Option<&str>) -> bool {
    same_path(dir, &clips_dir(clip_dir, game))
}

/// A game name as a Windows folder name: characters Windows refuses become spaces, runs of
/// whitespace collapse, trailing dots and spaces go, and names Windows reserves (or the old
/// top-level `Matches` folder) get a suffix. Never empty.
pub fn folder_name(game: Option<&str>) -> String {
    let Some(game) = game else {
        return UNKNOWN_GAME.to_string();
    };
    let replaced: String = game
        .chars()
        .map(|c| match c {
            '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*' => ' ',
            c if c.is_control() => ' ',
            c => c,
        })
        .collect();
    let mut name = replaced.split_whitespace().collect::<Vec<_>>().join(" ");
    while name.ends_with(['.', ' ']) {
        name.pop();
    }
    if name.is_empty() {
        return UNKNOWN_GAME.to_string();
    }
    // Windows reserves these with or without an extension (`CON.txt` is still CON).
    let base = name.split('.').next().unwrap_or("").trim_end().to_ascii_uppercase();
    let reserved = matches!(base.as_str(), "CON" | "PRN" | "AUX" | "NUL")
        || ((base.starts_with("COM") || base.starts_with("LPT"))
            && base.len() == 4
            && base.as_bytes()[3].is_ascii_digit());
    if reserved || name.eq_ignore_ascii_case(MATCHES) {
        name.push_str(" (game)");
    }
    // Long names are legal but make every clip path long; keep well inside MAX_PATH.
    if name.chars().count() > 80 {
        name = name.chars().take(80).collect::<String>().trim_end_matches(['.', ' ']).to_string();
    }
    name
}

/// A file name stem in `dir` that is free for a recording with extension `ext` *and* for the
/// outputs that sit next to it (`<stem>.av1.mp4`, `<stem>.h264.mp4`, `<stem>.jpg`): `stem`
/// itself, or `stem 2` and up.
pub fn free_stem(dir: &Path, stem: &str, ext: &str) -> String {
    let taken = |s: &str| {
        [format!("{s}.{ext}"), format!("{s}.av1.mp4"), format!("{s}.h264.mp4"), format!("{s}.jpg")]
            .iter()
            .any(|name| dir.join(name).exists())
    };
    if !taken(stem) {
        return stem.to_string();
    }
    (2..)
        .map(|n| format!("{stem} {n}"))
        .find(|s| !taken(s))
        .expect("some suffix is free")
}

/// Moves a finished recording into `dir` under a free name, and returns where it is now. A
/// file still held open (libobs finishing the write, an antivirus scan) is retried for a
/// couple of seconds; after that the error is returned and the file stays where it was.
pub fn move_recording(path: &Path, dir: &Path) -> anyhow::Result<PathBuf> {
    use anyhow::Context as _;
    std::fs::create_dir_all(dir).with_context(|| format!("creating {}", dir.display()))?;
    let stem = path.file_stem().map(|s| s.to_string_lossy().into_owned()).unwrap_or_else(|| "clip".into());
    let ext = path.extension().map(|s| s.to_string_lossy().into_owned()).unwrap_or_else(|| "mp4".into());
    let mut last = None;
    for attempt in 0..8 {
        if attempt > 0 {
            std::thread::sleep(std::time::Duration::from_millis(250));
        }
        let dst = dir.join(format!("{}.{ext}", free_stem(dir, &stem, &ext)));
        match std::fs::rename(path, &dst) {
            Ok(()) => return Ok(dst),
            Err(e) => last = Some(e),
        }
    }
    Err(last.expect("at least one attempt")).with_context(|| format!("moving {} into {}", path.display(), dir.display()))
}

/// Removes `dir` and then its parent when they are empty and strictly inside `clip_dir`, so a
/// game folder whose clips all moved or were deleted does not linger. Anything not empty, or
/// outside the clip folder, is left alone.
pub fn prune_empty(dir: &Path, clip_dir: &Path) {
    let mut current = Some(dir);
    for _ in 0..2 {
        let Some(d) = current else { return };
        let inside = d.starts_with(clip_dir) && !same_path(d, clip_dir);
        if !inside || std::fs::remove_dir(d).is_err() {
            return;
        }
        log::info!("removed empty folder {}", d.display());
        current = d.parent();
    }
}

fn same_path(a: &Path, b: &Path) -> bool {
    let key = |p: &Path| p.display().to_string().replace('/', "\\").trim_end_matches('\\').to_lowercase();
    key(a) == key(b)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn names_become_folder_names() {
        assert_eq!(folder_name(Some("Valorant")), "Valorant");
        assert_eq!(folder_name(Some("Hunt: Showdown 1896")), "Hunt Showdown 1896");
        assert_eq!(folder_name(Some("Counter-Strike: Global Offensive")), "Counter-Strike Global Offensive");
        assert_eq!(folder_name(Some("R.E.P.O.")), "R.E.P.O");
        assert_eq!(folder_name(Some("  What?  ")), "What");
        assert_eq!(folder_name(Some("a\\b/c")), "a b c");
        assert_eq!(folder_name(Some("???")), UNKNOWN_GAME);
        assert_eq!(folder_name(None), UNKNOWN_GAME);
    }

    #[test]
    fn reserved_names_get_a_suffix() {
        assert_eq!(folder_name(Some("CON")), "CON (game)");
        assert_eq!(folder_name(Some("nul")), "nul (game)");
        assert_eq!(folder_name(Some("COM1")), "COM1 (game)");
        assert_eq!(folder_name(Some("Matches")), "Matches (game)");
        assert_eq!(folder_name(Some("Console")), "Console");
        assert_eq!(folder_name(Some("COMA")), "COMA");
    }

    #[test]
    fn layout() {
        let root = Path::new(r"C:\Videos\Cos Nostra");
        assert_eq!(clips_dir(root, Some("Valorant")), Path::new(r"C:\Videos\Cos Nostra\Valorant\Clips"));
        assert_eq!(clips_dir(root, None), Path::new(r"C:\Videos\Cos Nostra\Unknown game\Clips"));
        assert_eq!(matches_dir(root, "League of Legends"), Path::new(r"C:\Videos\Cos Nostra\League of Legends\Matches"));
        assert!(is_clips_dir_of(Path::new(r"c:/videos/cos nostra/valorant/clips/"), root, Some("Valorant")));
        assert!(!is_clips_dir_of(root, root, Some("Valorant")));
    }

    fn temp_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "cos-nostra-folders-{name}-{}-{}",
            std::process::id(),
            std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn a_free_stem_avoids_the_outputs_too() {
        let dir = temp_dir("stem");
        assert_eq!(free_stem(&dir, "clip", "mp4"), "clip");
        std::fs::write(dir.join("clip.jpg"), b"").unwrap();
        assert_eq!(free_stem(&dir, "clip", "mp4"), "clip 2", "a stray thumbnail takes the name");
        std::fs::write(dir.join("clip 2.mp4"), b"").unwrap();
        assert_eq!(free_stem(&dir, "clip", "mp4"), "clip 3");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn recordings_move_under_a_free_name_and_empty_folders_go() {
        let root = temp_dir("move");
        let src = root.join("2026-09-14 10-00-00.mp4");
        std::fs::write(&src, b"x").unwrap();
        let dir = clips_dir(&root, Some("Valorant"));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("2026-09-14 10-00-00.mp4"), b"taken").unwrap();

        let moved = move_recording(&src, &dir).unwrap();
        assert_eq!(moved, dir.join("2026-09-14 10-00-00 2.mp4"));
        assert!(moved.is_file() && !src.exists());

        std::fs::remove_file(&moved).unwrap();
        prune_empty(&dir, &root);
        assert!(dir.exists(), "still holds the other clip");
        std::fs::remove_file(dir.join("2026-09-14 10-00-00.mp4")).unwrap();
        prune_empty(&dir, &root);
        assert!(!dir.exists() && !game_dir(&root, Some("Valorant")).exists(), "Clips and the game folder");
        assert!(root.exists(), "never the clip folder itself");
        let _ = std::fs::remove_dir_all(&root);
    }
}
