---
name: run-desktop
description: Build, launch, test and stop the Cos Nostra Tauri desktop clipper in dev mode, including the OBS bootstrap restart, hotkey testing and clip verification. Use when asked to run the desktop app, check that capture works, or debug a startup failure.
---

# Run the desktop app

## Launch

From `apps/desktop`, with `RUST_LOG=info` so the capture layer logs:

```powershell
$env:RUST_LOG="info"; npm run tauri dev
```

Run it in the background and watch its output file. The lines that matter:

- `available video encoders: [...]` then `replay buffer running with encoder X`: success.
- `recorder failed to start: ...`: libobs came up but the scene or output failed. The message carries the `.context()` chain.
- `OBS bootstrap failed: ...`: download or extraction problem, usually network.
- `OBS runtime installed, restarting`: first launch only. The app relaunches itself and the `npm run tauri dev` process exits with `npm error code 4294967295`. That is expected. Kill the relaunched exe (it has no Vite server) and run `npm run tauri dev` again.

The OBS runtime lands in `apps/desktop/src-tauri/target/debug/` (`obs.dll`, `obs-plugins/64bit/`, `data/`). It is gitignored through `target/`. Delete that directory to force a re-download.

## Test a save

Send the hotkey from PowerShell while the app runs:

```powershell
(New-Object -ComObject WScript.Shell).SendKeys("%{F10}")
```

Then look for `clip saved: <path>` in the log and verify the file:

```
ffprobe -v error -show_entries format=duration,size:stream=codec_name,width,height,r_frame_rate -of default=nw=1 "<path>"
```

Expect h264 video at the monitor's resolution, 60 fps, aac audio, duration close to the buffer length. Clips go to `%USERPROFILE%\Videos\Cos Nostra` unless settings say otherwise.

## Test the game hook without a game

Any fullscreen Direct3D window gets hooked. ffplay from the ffmpeg install works:

```powershell
ffplay -fs -autoexit -loglevel quiet "<any video file>"
```

Expect `game capture hooked ffplay.exe (...)` in the log, the Status tab switching to
"Recording: ...", and `game capture unhooked` when ffplay closes.

## Test the encoding pipeline

Startup lines to expect after `replay buffer running`: `using sidecar ffmpeg in ...`, `encoders probed in ...: av1=av1_amf h264=h264_amf` (first run only; cached in settings afterwards), `clip queue ready at ...\clips.db`. After a hotkey save: `queued clip N: <path> (<ms>, WxH)`. Encoding waits while a game is hooked or the foreground window looks like a game, then logs `encoding clip N`, `clip N: thumbnail in`, `clip N: AV1 (...) in`, `clip N: H.264 (...) in`. Outputs sit next to the source as `<stem>.jpg`, `<stem>.av1.mp4`, `<stem>.h264.mp4`. `Get-Process ffmpeg | select PriorityClass` should say `BelowNormal` while it runs.

For the ten-clip acceptance run, send the hotkey every three seconds while ffplay is fullscreen, close ffplay, and count `clip N: H.264` lines.

## Look at the UI and drive it

The window cannot be brought to the front while VS Code has focus (Windows blocks focus stealing),
so capture it with `PrintWindow` instead of a screen grab:

```powershell
$sig = '[DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr h, IntPtr dc, uint f);
[DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
public struct RECT { public int Left, Top, Right, Bottom; }'
Add-Type -MemberDefinition $sig -Name W -Namespace N; Add-Type -AssemblyName System.Drawing
$p = Get-Process cos-nostra-desktop | ? { $_.MainWindowHandle -ne 0 } | select -First 1
$r = New-Object N.W+RECT; [N.W]::GetWindowRect($p.MainWindowHandle, [ref]$r) | Out-Null
$bmp = New-Object System.Drawing.Bitmap ($r.Right-$r.Left), ($r.Bottom-$r.Top)
$g = [System.Drawing.Graphics]::FromImage($bmp); $dc = $g.GetHdc()
[N.W]::PrintWindow($p.MainWindowHandle, $dc, 2) | Out-Null; $g.ReleaseHdc($dc); $bmp.Save("shot.png")
```

Clicks: `SetCursorPos` to window-relative coordinates from the screenshot, then `mouse_event(2)` and
`mouse_event(4)`. Keyboard: `WScript.Shell.SendKeys`. Injected keys arrive in the webview with an
empty `KeyboardEvent.code`; the hotkey capture falls back to `key`, so `SendKeys("%{F9}")` binds
Alt+F9 correctly.

## Test the installer

Stop the dev app first (same single-instance id). Then:

```powershell
& "src-tauri\target\release\bundle\nsis\Cos Nostra_0.1.0_x64-setup.exe" /S
$env:RUST_LOG="info"; & "$env:LOCALAPPDATA\Cos Nostra\cos-nostra-desktop.exe"
```

The release exe has no console, so its log is not visible; check behaviour through the UI and
`%USERPROFILE%\Videos\Cos Nostra`. First launch downloads the runtime into `obs_new\`, exits, and
`%TEMP%\libobs_updater.ps1` swaps the files and relaunches. `Get-Process cos-nostra-desktop`
disappears for a few seconds during the swap; wait for it to come back.

## Stop

```
taskkill /IM cos-nostra-desktop.exe /F
```

Then stop the background tauri dev task. Avoid `taskkill /IM node.exe` unless nothing else Node is running.

## Where things are

- Settings: `%APPDATA%\Cos Nostra\settings.json`. Delete it to reset to defaults.
- Rust sources: `apps/desktop/src-tauri/src/` (`lib.rs` app shell, `capture.rs` libobs, `settings.rs`).
- Fast iteration on Rust only: `cargo check` in `apps/desktop/src-tauri`, about two seconds warm.

## Common failures

- Black clip: another app holds the game capture hook, or the game runs with an anti-cheat that blocks it. The monitor layer should still show the desktop; if the clip is fully black the graphics adapter index may be wrong on a multi-GPU machine.
- Hotkey does nothing: another program registered Alt+F10 first. Change `hotkey` in settings.
- `recorder is not running` from the UI: the recorder thread has not finished starting, or it failed; check the log.
- `LNK1123` at the end of the build: stale `resource.lib` from a concurrent build. Delete `src-tauri/target/debug/build/cos-nostra-desktop-*/` and run again.
- Vite exits with `npm error code 4294967295` and the app shows a blank window: port 1420 was still held by a previous Vite. `Get-NetTCPConnection -LocalPort 1420` finds the owner.
- Buffer shows `failed` with a red banner and a Retry button: libobs or the clip folder failed. Fix the cause (usually the folder in Settings) and press Retry; the app stays alive.
