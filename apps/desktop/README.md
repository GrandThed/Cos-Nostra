# Cos Nostra desktop

Windows clipper built with Tauri. Capture and encoding run on embedded libobs.

## How it works

- On first launch `libobs-bootstrapper` downloads the OBS runtime next to the executable and
  restarts the app.
- `src-tauri/src/capture.rs` boots libobs with a scene of two layers: a monitor capture of the
  primary display and a game capture of any fullscreen application on top. Desktop audio is
  mixed in. A replay buffer output keeps the last N seconds encoded in memory with the first
  available hardware H.264 encoder (NVENC, AMF, QSV) or x264 as fallback.
- A global hotkey (default `Alt+F10`), the tray menu, or the window button flush the buffer to
  `%USERPROFILE%\Videos\Cos Nostra`.
- Settings live in `%APPDATA%\Cos Nostra\settings.json`, clip metadata in `clips.db` beside it,
  game sessions and matches in `sessions.db`.

## Match recording

Valorant, League of Legends and Counter-Strike are recorded whole and cut into matches when the
player leaves the game. The reasoning and what has been verified are in `docs/PLAN.md`; the map:

| | |
|---|---|
| `timeline.rs` | the game-agnostic vocabulary: which games, events, the `Provider` trait, which footage a match wants |
| `session_watch.rs` | the thread that sees a game start and stop, keeps a recording running, feeds provider events in; runs against a `Host` trait so tests use a fake |
| `providers/valorant.rs` | Riot Client lockfile and local API, presence decoding, the presence-to-events state machine |
| `providers/league.rs` | the game's Live Client Data API on port 2999: game clock to wall clock, the player's kills, objectives, the result |
| `sessions.rs` | `sessions.db`: sessions, recordings, matches, events |
| `cutter.rs` | a finished session into match files, by stream copy from the nearest keyframe |
| `session_app.rs` | the app side: the real `Host`, processing, the Matches tab's commands |
| `placement.rs` | where a clip sits on a match, from the clip's `captured_at` and the match file's `file_start_at` |
| `edit.rs` | what the editor opens for a clip (its match, or its own recording) and what Apply does |

Recordings (`session-<id>-<n>.mp4`) and match files live in `<clip folder>\<Game>\Matches`;
sessions recorded before per-game folders stay in `<clip folder>\Matches`.

## The clip folder

`folders.rs` decides where files go. A hotkey clip is written by the replay buffer to the top of
the clip folder and, once the probe says libobs finished writing it, moved into
`<clip folder>\<Game>\Clips` (`Unknown game\Clips` when no game was detected); its encoded
copies and thumbnail are written next to it. Clips taken from a match go to the same folder, and
a recording the editor rebuilds stays in the folder its clip is already in. Game names become
folder names with the characters Windows refuses removed and reserved names suffixed.

Rows store absolute paths, so clips saved before the layout existed stay loose at the top of the
folder and keep working; nothing migrates them. Renaming or merging a game (and changing a clip's
game, including from the Publish dialog) moves the clips that live in the old name's folder
into the new one's through `storage::relocate`, which moves every file of a clip or none and
then prunes the empty folder. A clip whose file is held open by a player or ffmpeg keeps its
folder.

## Game pictures

The library sidebar, the game header and the Matches session list show a picture per game.
`src-tauri/src/game_art.rs` finds them on a worker thread and caches them in
`%APPDATA%\Cos Nostra\game-art\`, keyed by the game's name in the library; `src/gameArt.ts`
asks for them as data URLs (`get_game_art`) and repaints tiles in place on `game-art-changed`.

A save hands over the executable and, from the foreground window, its path. The lookup, in order:

1. Steam app id: the exe path under `<library>\steamapps\common\<installdir>` matched to an
   `appmanifest_*.acf`, or the Steam SKU on the game's entry in Discord's detectable-games list
   (`/api/v9/applications/detectable`, matched by exe name, or by name for clips saved before
   pictures existed).
2. Cover: Steam's own `appcache\librarycache\<appid>` (no network), the Steam CDN, the store
   assets API for newer apps with hashed URLs, then Discord's cover image.
3. Icon: Discord's app icon, else the exe's icon (`win::extract_exe_icon`). With no square icon
   the UI crops the cover.

Clicking the header picture replaces it with a chosen file (`custom`, never overwritten); "Reset
image" drops it and looks the game up again. Renaming a game carries its pictures to the new name.

## The window

Plain HTML, CSS and TypeScript modules in `src/`, no framework. `main.ts` is the wiring: it
mounts one of six screens, keeps `store.ts` fed from a five second poll and the events Rust
pushes, and nothing renders from an event payload directly.

| | |
|---|---|
| `shell.ts` | title bar, toolbar, alarm banners, the status panel behind the recording pill |
| `library.ts` | game sidebar, filters, the clip grid that becomes rows under 840 px |
| `matches.ts` | sessions and their matches, the match player with its round timeline and your clips drawn on it, in/out marks that become a clip |
| `player.ts` | the clip detail view, which is also the player, with the Publish button |
| `editor.ts` | one range on the match: start and end handles, undo, and Apply |
| `publish.ts` | the Publish dialog: title, game, servers; for a published clip, more servers, unpublish, delete |
| `circles.ts` | the status circle and the stack of server icons on a clip |
| `storage.ts`, `settings.ts`, `firstrun.ts` | the other three screens |
| `clips.ts` | what a clip row means: its badge, its meta line, where its video is |
| `gameArt.ts` | game pictures: the per-game cache and the tiles that repaint when one lands |
| `styles/tokens.css` | the one token set both themes run on |

The window is undecorated, so `.titlebar` is the title bar and the window buttons call the
Tauri window API; that needs the `core:window:allow-*` permissions in
`capabilities/default.json`. Light and dark follow `prefers-color-scheme`, which WebView2 fixes
when the window is created — changing the system theme only takes effect on the next launch.

Fonts are self-hosted in `src/assets/fonts/` so the app looks the same offline. They are
variable-weight subsets of Bricolage Grotesque, Rubik and JetBrains Mono, all OFL-1.1 (see
`OFL.txt` beside them); `node scripts/fetch-fonts.mjs src/assets/fonts` regenerates them.

The player reads clip files through Tauri's asset protocol. `lib.rs` widens its scope to the
clip folder and everything under it at startup and whenever the folder setting changes, so a
clip outside that folder will not play.

## Local clips and publishing

Every clip starts **local**: saved, thumbnailed, playable, and never encoded or uploaded. The
queue only moves rows with `publish = 1` (`clips.db` schema v6), which the Publish dialog sets
together with the title, the game and the chosen servers (`publish_guilds`). The worker then
encodes and uploads as before, sending `guildIds` with `POST /clips` so the bot posts only where
the owner asked. `GET /me/posts` fills the row's `posts` cache (at startup, after an upload, after
posting to more servers, every five minutes), which is what the server circles draw. Unpublish
deletes the clip on the site and in Discord and puts the row back to local with its files;
publishing again makes a new link.

Each clip stores `captured_at`, the wall-clock time of its recording's first frame, so
`placement.rs` can put it on the match it overlaps. Clips from before schema v6 got it from
`recorded_at` minus their length, and match clips from those builds land early by up to a
recording's length.

## Trim

The editor is one kept range, drawn on the match when the clip's match file is still here and
on the clip's own recording otherwise. A range inside the clip's recording becomes a one-segment
`cut` on it. A range that reaches past it copies that span plus three seconds out of the match
into a new recording, which replaces the old one (and its encoded copies), so the clip no longer
depends on the match surviving the storage limit. A local clip is not encoded by any of this; a
published clip goes back to `saved` and re-uploads under the same clip id through
`POST /clips/:id/replace`. A clip with only its encoded copy left is never cut in place: the
range is stream-copied out of that copy into a recording of its own. The encoder still accepts a
multi-segment `cut` for rows written by older builds; the editor opens those on their outer span.

## ffmpeg

`ffmpeg.exe` ships as a Tauri sidecar (`bundle.externalBin` in `tauri.conf.json`) and is copied
next to the app exe at build time. `src-tauri/src/ffmpeg.rs` looks there first and falls back to
`ffmpeg` on PATH. The sidecar lives, gitignored, in `src-tauri/binaries/` as
`ffmpeg-x86_64-pc-windows-msvc.exe`.

There is no ffprobe. `ffmpeg::probe` reads the `Input #0` description ffmpeg prints about a file,
and `ffmpeg::keyframe_at_or_before` stream-copies the window into the `framecrc` muxer, which lists
each packet with its keyframe flag. A second binary would have been a second full copy of every
codec library.

What ships is a minimal static build: `npm run build-ffmpeg` runs `scripts/build-ffmpeg.sh` in
MSYS2 (a private copy is unpacked into `%LOCALAPPDATA%\cos-nostra-ffmpeg-build` when none is
installed) and writes the sidecar. FFmpeg and every library in it are pinned by version and
SHA-256, and it enables only the encoders, decoders, formats and filters `ffmpeg.rs` uses. **A new
encoder, filter or format in `ffmpeg.rs` has to be added to the `configure` line there too**, or it
fails at runtime with "Unknown encoder" or "No such filter" even though it works against the full
ffmpeg on PATH. CI builds the same script, caches the exe by the script's hash, and puts it in every
release.

`npm run ensure-ffmpeg` (run automatically before `tauri dev` and `tauri build`) leaves an existing
sidecar alone. When there is none it copies ffmpeg from PATH, the winget `Gyan.FFmpeg` package
directory, or the BtbN GPL build download, in that order. Those are full builds of 150-200 MB:
fine for `tauri dev`, and it warns that an installer built with one ships all of it.

## Develop

```
npm install
npm run tauri dev
```

Requires Rust (MSVC toolchain), Node, and the Visual Studio C++ build tools.

## Build the installer

```
cd apps/desktop
npm run tauri build
```

This runs `tsc && vite build`, a release Cargo build (LTO, several minutes cold) and NSIS.
The result is `src-tauri/target/release/bundle/nsis/Cos Nostra_<version>_x64-setup.exe`.
It is unsigned for now, so SmartScreen will warn on first run. `.github/workflows/desktop-release.yml`
builds the same installer on `windows-latest` for every `v*` tag and attaches it to a draft
GitHub release.

What the installer does (`src-tauri/tauri.conf.json`, `src-tauri/installer-hooks.nsh`):

- Installs per user (`installMode: currentUser`) into `%LOCALAPPDATA%\Cos Nostra\`
  with no elevation. The install directory has to stay writable because the OBS runtime is
  extracted next to the exe at runtime.
- Ships `resources\obs-dummy.dll`, the 60 KB placeholder from the `libobs-bootstrapper`
  crate (same bytes its build script drops into `target/<profile>/obs.dll`), and copies it to
  `obs.dll` next to the exe when no `obs.dll` exists yet. The exe links `obs.dll` at load time
  and will not start without it. An upgrade keeps the real `obs.dll` so nothing is re-downloaded.
- The uninstaller removes everything the runtime wrote next to the exe (`obs-plugins\`, `data\`,
  `obs_new\`, ffmpeg and libobs DLLs, `rtmp-services\`, `win-capture\` and so on) before
  Tauri removes its own files. Settings in `%APPDATA%\Cos Nostra` are left alone.
- WebView2 uses `downloadBootstrapper`: it is already present on Windows 10/11, the installer only
  downloads it if missing.

Silent install and uninstall for testing:

```
& ".\src-tauri\target\release\bundle\nsis\Cos Nostra_0.1.0_x64-setup.exe" /S
& "$env:LOCALAPPDATA\Cos Nostra\uninstall.exe" /S
```

## Updates

`src/updater.ts` checks `https://github.com/GrandThed/Cos-Nostra/releases/latest/download/latest.json`
through `tauri-plugin-updater` at startup and every six hours, and downloads and installs a
newer signed build in the background; `shell.ts` shows "update available" / "restart to finish"
as ordinary alarm banners. Skipped entirely in `tauri dev` (`import.meta.env.DEV`), since there
is no installed build to update into.

The plugin verifies a minisign signature against the public key in `tauri.conf.json`
(`plugins.updater.pubkey`). Only `.github/workflows/desktop-release.yml` can produce a build
that verifies: it signs the installer with the private half via the `TAURI_SIGNING_PRIVATE_KEY`
and `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` repo secrets and uploads the resulting `latest.json` to
the release. Losing that private key means every future release has to ship a build that skips
verification for one version, since nothing already installed would ever trust a new key. This
also means releases can no longer be drafted (`releaseDraft: false`): GitHub's "latest release"
has to already be this one for the endpoint above to find it, so there is no review window
between a tag push and every desktop install offering that build.

## First launch

The installed app starts with only the placeholder `obs.dll`. `libobs-bootstrapper` downloads
the signed OBS runtime (about 150 MB) from the `libobs-rs/libobs-builds` GitHub releases,
extracts it into `obs_new\` next to the exe, writes `%TEMP%\libobs_updater.ps1` and exits. That
script waits for the process to end, moves `obs_new\` over the install directory and relaunches
the app with the same arguments. From the second launch on the runtime is found in place and the
replay buffer starts immediately. To force a fresh download delete `obs.dll`, `obs-plugins\` and
`data\` from the install directory.
