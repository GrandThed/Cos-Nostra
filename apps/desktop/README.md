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
- Settings live in `%APPDATA%\Cos Nostra\settings.json`.

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
