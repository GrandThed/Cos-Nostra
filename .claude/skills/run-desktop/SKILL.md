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
