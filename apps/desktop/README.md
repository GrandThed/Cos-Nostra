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
- Settings live in `%APPDATA%\Cos Nostra\settings.json`, clip metadata in `clips.db` beside it.

## The window

Plain HTML, CSS and TypeScript modules in `src/`, no framework. `main.ts` is the wiring: it
mounts one of four screens, keeps `store.ts` fed from a five second poll and the events Rust
pushes, and nothing renders from an event payload directly.

| | |
|---|---|
| `shell.ts` | title bar, toolbar, alarm banners, the status panel behind the recording pill |
| `library.ts` | game sidebar, filters, the clip grid that becomes rows under 840 px |
| `player.ts` | the clip detail view, which is also the player |
| `editor.ts` | trim & cut: the timeline with handles, split, undo, and Apply, which sends the clip back through the queue |
| `storage.ts`, `settings.ts`, `firstrun.ts` | the other three screens |
| `clips.ts` | what a clip row means: its badge, its meta line, where its video is |
| `styles/tokens.css` | the one token set both themes run on |

The window is undecorated, so `.titlebar` is the title bar and the window buttons call the
Tauri window API; that needs the `core:window:allow-*` permissions in
`capabilities/default.json`. Light and dark follow `prefers-color-scheme`, which WebView2 fixes
when the window is created — changing the system theme only takes effect on the next launch.

Fonts are self-hosted in `src/assets/fonts/` so the app looks the same offline. They are
variable-weight subsets of Bricolage Grotesque, Rubik and JetBrains Mono, all OFL-1.1 (see
`OFL.txt` beside them); `node scripts/fetch-fonts.mjs src/assets/fonts` regenerates them.

The player reads clip files through Tauri's asset protocol. `lib.rs` widens its scope to the
clip folder at startup and whenever the folder setting changes, so a clip outside that folder
will not play.

## Trim & cut

A cut is a list of kept ranges (`ffmpeg::Segment`) stored on the clip row (`cut`, schema v4)
and measured against the original recording. Apply puts the row back to `saved`; the worker
re-encodes both outputs from the recording with the cut applied (one segment is `-ss`/`-to`,
several are a `trim`/`concat` filter graph in one pass), regenerates the thumbnail from inside
the kept footage, records the new length, and re-uploads under the same clip id through
`POST /clips/:id/replace`. While the recording is on disk the cut is non-destructive: the
editor reopens on the whole recording with the cut drawn on it. Once the recording has been
dropped, the encoded H.264 copy is the source, the cut is baked into it and the row's `cut` is
cleared afterwards, and the editor warns and asks for a second click on Apply.

## ffmpeg

`ffmpeg.exe` and `ffprobe.exe` ship as Tauri sidecars (`bundle.externalBin` in `tauri.conf.json`)
and are copied next to the app exe at build time. `src-tauri/src/ffmpeg.rs` looks there first and
falls back to `ffmpeg` on PATH. The sidecar files live in `src-tauri/binaries/` as
`ffmpeg-x86_64-pc-windows-msvc.exe` / `ffprobe-x86_64-pc-windows-msvc.exe`; they are about
220 MB each and are gitignored. `npm run ensure-ffmpeg` (run automatically before `tauri dev` and
`tauri build`) creates them from ffmpeg on PATH, the winget `Gyan.FFmpeg` package directory, or
the pinned BtbN GPL build download, in that order. Delete `src-tauri/binaries/` to refresh them.

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

## First launch

The installed app starts with only the placeholder `obs.dll`. `libobs-bootstrapper` downloads
the signed OBS runtime (about 150 MB) from the `libobs-rs/libobs-builds` GitHub releases,
extracts it into `obs_new\` next to the exe, writes `%TEMP%\libobs_updater.ps1` and exits. That
script waits for the process to end, moves `obs_new\` over the install directory and relaunches
the app with the same arguments. From the second launch on the runtime is found in place and the
replay buffer starts immediately. To force a fresh download delete `obs.dll`, `obs-plugins\` and
`data\` from the install directory.
