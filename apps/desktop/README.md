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

## Develop

```
npm install
npm run tauri dev
```

Requires Rust (MSVC toolchain), Node, and the Visual Studio C++ build tools.
