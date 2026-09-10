---
name: libobs-api
description: How to work with the embedded libobs layer in the desktop app through the libobs-wrapper, libobs-simple and libobs-bootstrapper crates, including where to read the real API, the traits you must import, and known pitfalls. Use when editing capture.rs, adding sources, filters, encoders or outputs, or when a libobs call does not compile.
---

# libobs through libobs-rs

## Read the API from the registry, not GitHub

The published crates are newer than the repository's main branch. Pinned versions are in `apps/desktop/src-tauri/Cargo.toml`. Sources are at:

```
~/.cargo/registry/src/*/libobs-wrapper-9.*/src
~/.cargo/registry/src/*/libobs-simple-8.*/src
~/.cargo/registry/src/*/libobs-bootstrapper-0.4.*/src
```

Grep there for `pub fn` before writing a call. Useful entry points:

- `libobs-wrapper/src/context.rs`: `ObsContext` methods (`scene`, `output`, `replay_buffer`, `source_builder`, `data`, `reset_video`).
- `libobs-wrapper/src/data/output/traits.rs`: `ObsOutputTrait` (`start`, `stop`, `is_active`, encoder setters). Import the trait or the methods are not found.
- `libobs-wrapper/src/data/output/replay_buffer.rs`: `ObsReplayBufferOutputRef::save_buffer`, `replay_signals`.
- `libobs-simple/src/output/replay.rs`: `ReplayBufferBuilder` and the hardware encoder candidate order.
- `libobs-simple/src/sources/windows/sources/`: `GameCaptureSourceBuilder`, `MonitorCaptureSourceBuilder`, `WindowCaptureSourceBuilder` with generated `set_*` methods from the `define_object_manager!` fields.
- `libobs-wrapper/src/encoders/mod.rs`: `ObsContextEncoders` (`available_video_encoders`, `best_video_encoder`).

## Traits to import

```rust
use libobs_wrapper::data::output::ObsOutputTrait;      // start/stop/is_active on outputs
use libobs_wrapper::data::ObsDataSetters;              // set_string/set_int/set_bool on ObsData
use libobs_wrapper::scenes::SceneItemExtSceneTrait;    // add_source, add_and_create_source
use libobs_wrapper::sources::ObsSourceBuilder;         // add_to_scene on builders
use libobs_wrapper::encoders::ObsContextEncoders;      // available_video_encoders
use libobs_simple::output::replay::ObsContextReplayExt; // context.replay_buffer_builder
```

## Patterns that work

- Generic source with raw settings, for source types without a builder (desktop audio):
  ```rust
  let mut s = context.data()?;
  s.set_string("device_id", "default")?;
  scene.add_and_create_source(SourceInfo::new("wasapi_output_capture", "Desktop Audio", Some(s), None))?;
  ```
- Scene creation: `context.scene("main", None)` then `scene.set_to_channel(0)` after sources are added. Later sources draw on top of earlier ones.
- `ObsPath::new(&str)` for absolute paths, `ObsPath::from_relative` for paths next to the exe.
- The context uses its own OBS thread; `ObsContext` and output refs are `Clone + Send`, safe to keep in Tauri state behind a `Mutex`.
- Keep everything libobs behind `capture::Recorder`. The rest of the app only sees `start`, `save`, `is_active`, `encoder_id`.

## Pitfalls seen so far

- `ObsVideoEncoder` fields are `pub(crate)`; there is no getter for the encoder id. Mirror the selection order instead (see `pick_h264_encoder`).
- Monitor capture with `MethodDXGI` requires DPI awareness; `MethodAuto` is safe.
- Game capture `set_capture_audio(true)` returns `Result` and fails on systems without application audio capture. We use a desktop audio source instead to avoid doubled audio.
- Do not reset the OBS context repeatedly; the wrapper documents a small leak per reset. Restart the process instead.
- The bootstrapper's `install_dummy_dll` default feature places a placeholder `obs.dll` so the exe links before the real runtime is downloaded. Keep that feature on.

## Signals (hooked / unhooked on game capture)

- `add_to_scene` returns `ObsSceneItemRef<GameCaptureSource>`; `inner_source().source_specific_signals()` (trait `ObsHookableSourceTrait` from `libobs_simple::sources::windows`) gives `Arc<ObsHookableSourceSignals>` with `on_hooked()` / `on_unhooked()`, each a `tokio::sync::broadcast::Receiver` of capacity 16.
- Payload structs are the names from `impl_signal_manager!` in libobs-simple `src/sources/windows/sources/mod.rs`: `HookedSignal { title, class, executable, source }`, `UnhookedSignal`. `title` is the window title, not a product name.
- Drain the receivers on a dedicated thread with a current-thread tokio runtime; `RecvError::Closed` ends the loop when the source drops.
- The signal manager's `Drop` runs `run_with_obs!` and unwraps, so any `Arc<ObsHookableSourceSignals>` you keep must be declared before the `ObsContext` field in your struct so it drops first.
- `libobs_simple::sources::windows` re-exports only `WindowInfo` and `WindowSearchMode` from libobs-window-helper. For the foreground window's exe and title use the `windows` crate (`GetForegroundWindow`, `GetWindowThreadProcessId`, `OpenProcess` + `QueryFullProcessImageNameW`, `GetWindowTextW`). `GameCaptureSourceBuilder::is_window_in_use_by_other_instance(pid)` checks for another tool's `CaptureHook_Pipe<pid>`.

## OBS setting keys worth knowing

- Replay buffer output (`replay_buffer`): `directory`, `format`, `extension`, `max_time_sec`, `max_size_mb`, `allow_spaces`.
- Video encoders: `rate_control` (CBR, CQP, VBR), `bitrate`, `preset`, `cqp`, `keyint_sec`, `profile`.
- Game capture: `capture_mode` (`any_fullscreen`, `window`, `hotkey`), `window`, `anti_cheat_hook`, `capture_overlays`, `capture_cursor`, `hook_rate`.
- Monitor capture: `monitor_id`, `method` (0 auto, 1 DXGI, 2 WGC), `capture_cursor`.
