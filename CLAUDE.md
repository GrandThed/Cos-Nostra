# Cos Nostra

Game clipping for a Discord community. Three apps in one npm workspace. Read `docs/PLAN.md` for the roadmap and the decisions behind it before proposing architecture changes.

## Layout

- `apps/desktop` Windows clipper. Tauri 2. Web UI in `src/` (vanilla TypeScript, Vite), Rust in `src-tauri/`. Capture lives in `src-tauri/src/capture.rs` on embedded libobs through the `libobs-wrapper`, `libobs-simple` and `libobs-bootstrapper` crates. The UI is one module per screen plus `store.ts`, `clips.ts` and `styles/tokens.css`; `apps/desktop/README.md` has the map, and `design_handoff_cos_nostra_ui/` is the design it implements.
- `apps/backend` Fastify API and player page. Postgres on Railway, video in S3-compatible object storage.
- `apps/bot` discord.js bot that posts clips and records reactions.
- `packages/shared` shared TypeScript types and API client (to be created in phase 3).
- `docs/PLAN.md` implementation plan. Keep it current when scope changes.

## Commands

Run from the repo root unless noted.

```
npm install                      # all workspaces
npm run desktop                  # tauri dev (builds Rust, starts Vite, launches app)
npm run backend                  # node --watch apps/backend
npm run bot                      # node --watch apps/bot
cd apps/desktop/src-tauri && cargo check    # fast Rust type check
cd apps/desktop && npm run tauri build      # NSIS installer
```

Toolchain on the dev machine: Rust stable MSVC, Node 24, ffmpeg 9 (`ffmpeg`/`ffprobe` on PATH after a fresh shell), VS 2022 Build Tools. GPU is an AMD RX 9060 XT, so AMF encoders are what get exercised locally; NVENC and QSV paths are untested here.

## Decisions that are settled

- Capture and encoding happen on the player's machine. The backend never processes video.
- Embedded libobs, not obs-websocket. Do not suggest requiring OBS Studio.
- Final format is AV1 (hardware when available, SVT-AV1 fallback) plus an H.264 copy for Discord attachments and old devices.
- Discord OAuth is the only identity. Desktop links a device through a device-code flow, no local HTTP listener.
- Object storage is a Railway Storage Bucket, addressed only through the S3 API so it stays swappable. Railway buckets have no public read, so nothing is ever a public object URL: the backend redirects `GET /clips/:id/{av1,h264,thumb}` to one-hour presigned GETs.
- License is GPL-3.0 for the whole repo because the desktop app links libobs through GPL-3.0 crates. Do not add dependencies with GPL-incompatible licenses.
- OBS runtime binaries are downloaded at first launch from the signed `libobs-rs/libobs-builds` releases and are never rebuilt or patched, so anti-cheat allowlisting of the game hook keeps working.

## Conventions

- JavaScript packages are ESM (`"type": "module"`), Node 24, no TypeScript build step in backend and bot; plain JS with JSDoc types where useful. The desktop UI is TypeScript through Vite.
- Rust: `anyhow` for errors with `.context()`, `log` macros, `env_logger` initialized in `run()`. Keep the libobs surface behind `capture::Recorder` so the rest of the app never imports `libobs_*`.
- Secrets only in `.env` files (gitignored) locally and Railway variables in production. `.env.example` lists every variable a package needs.
- Prefer small, plain modules over frameworks. Fastify plugins for cross-cutting concerns, one route file per resource.
- Commit messages: imperative subject, body explains why. No commits without being asked.

## Gotchas

- `tauri dev` on first launch: the bootstrapper downloads OBS and the app restarts itself, so the original `npm run tauri dev` exits with an error. Just run it again. The bootstrap now runs inside the app (so the first-run screen can show the download), which means the window opens first and the recorder only starts after it finishes. See the `run-desktop` skill.
- The window is undecorated: the title bar is HTML, and its buttons need the `core:window:allow-*` permissions in `capabilities/default.json`. Anything not a button in it carries `data-tauri-drag-region`.
- WebView2 decides `prefers-color-scheme` when the window is created, so flipping the Windows app theme does nothing to a running app, with or without a page reload. Restart it to see the other theme.
- The player reads clip files through the asset protocol, whose scope `lib.rs` widens to the clip folder at startup and on every folder change. A video outside that folder will not play, silently.
- The published libobs-rs crates are ahead of the GitHub main branch. Read the API from `~/.cargo/registry/src/*/libobs-wrapper-*` not from the repo. See the `libobs-api` skill.
- `ObsContext::scene(name, channel)` takes an `Option<u32>`. `ObsVideoEncoder` does not expose its id; encoder selection order is mirrored in `capture::pick_h264_encoder`.
- Killing `node.exe` to stop Vite also kills anything else Node on the machine. Prefer stopping the tauri dev task.
- ffmpeg from winget is at `%LOCALAPPDATA%\Microsoft\WinGet\Packages\Gyan.FFmpeg*\ffmpeg-*\bin\` if PATH has not refreshed.
- `LNK1123: error during conversion to COFF` on the final link means the `resource.lib` written by tauri-build got corrupted, usually by two builds running at once. Delete `src-tauri/target/debug/build/cos-nostra-desktop-*/` and rebuild.
- OBS plugins write `rtmp-services/` and `win-capture/` next to the exe at runtime (in `src-tauri/` during dev). Both are gitignored; never commit them.
- `settings.json` must be UTF-8 without BOM. PowerShell's `Set-Content -Encoding utf8` writes a BOM; the loader strips it, but other tools reading the file may not.
- The dev build and the installed build share the single-instance id, so launching one while the other runs only focuses the running one. Stop the dev app before testing an installer. **Check which one is actually running before believing anything about behaviour**: `Get-Process cos-nostra-desktop | Select-Object Path, StartTime`. A stale build in `%LOCALAPPDATA%\Cos Nostra` looks identical and silently uses the presets it was built with. The encoder that wrote a clip is recorded in the file, so that is the fastest way to tell which code produced it: `ffprobe -v error -show_entries stream_tags=encoder -of default=nw=1 clip.av1.mp4` prints `libsvtav1` or `av1_amf`.
- **An older build silently strips settings it does not know about.** `Settings` is `#[serde(default)]`, so a new field is *read* as its default by any build, but an old build then writes the file back **without** that field. Running yesterday's installer after adding `quality` and `encode_engine` blanked both keys in `settings.json`. Nothing is lost permanently (the new build fills them from `Default` again), but a setting that appears to reset itself means an old build touched the file.
- ffmpeg is the only Tauri sidecar, in the gitignored `apps/desktop/src-tauri/binaries/`; there is no ffprobe, and the app must not start needing one (`ffmpeg::probe` parses ffmpeg's input description instead). `npm run ensure-ffmpeg` (run automatically before `tauri dev` and `tauri build`) fills it from PATH or a download, which is a full ~200 MB build. Releases ship the minimal one from `npm run build-ffmpeg -w apps/desktop` (`scripts/build-ffmpeg.sh` in MSYS2, 15-30 minutes cold), which enables **only** what `ffmpeg.rs` uses: a new encoder, filter or format that works in `tauri dev` against the full build fails in the installer with "Unknown encoder" / "No such filter" until it is added to that script's `configure` line. `ffmpeg -version` on the sidecar shows `--disable-everything` when it is the minimal one. A build that fails with a missing `ffmpeg-x86_64-pc-windows-msvc.exe` means ensure-ffmpeg did not run.
- Clip metadata lives in `%APPDATA%\Cos Nostra\clips.db` (SQLite, WAL). Delete it together with the `*.av1.mp4`, `*.h264.mp4` and `*.jpg` files next to the clips to start over.
- Game sessions and matches live in `sessions.db` beside it, their files in `<clip folder>\Matches`. Delete both to start over; a session still marked `recording` at startup is ended and cut, so a killed app does not lose one.
- **A dev build records your real games.** With `record_sessions` on (the default), launching Valorant, League or CS while `tauri dev` runs records the whole session to disk and pops the window when you close the game. To test without a game, run ffplay renamed to one of the executables in `timeline::SessionGame::game_exes` (`ffplay -fs -f lavfi -i testsrc2=size=1920x1080:rate=60`); the recording shows whatever fullscreen game is hooked, not necessarily that window. The Valorant provider reads the Riot Client's lockfile, so it connects whenever any Riot client is open, League included, but only a running Valorant has the presence it needs.
- Never create or drop a `reqwest::blocking` client inside an `async` Tauri command: tokio panics ("Cannot drop a runtime in a context where blocking is not allowed") and the poisoned mutexes take the app down. Wrap the body in `tauri::async_runtime::spawn_blocking` or use a plain thread, as `start_login` and `logout` do.
- The backend runs locally without Postgres: `DATABASE_URL=pglite://./data/dev`. Point the desktop at it through the Backend URL field in Settings (`http://localhost:3000`), and register `http://localhost:3000/auth/discord/callback` as a redirect in the Discord app if you want the login to complete locally.
- Never run `npm start -w apps/bot` while the Railway bot service is deployed: two gateway connections on one `DISCORD_TOKEN` both receive every interaction, so clips post twice, reactions are written twice, and the loser logs `Interaction has already been acknowledged` while the user sees a reply that appears in no log you are reading. See the `discord-bot` skill.
- A dev build publishes to **production**: `settings.rs` defaults `backend_url` to `https://cosnostra.benja.ar`. Nothing uploads by itself any more (only rows with `publish = 1`, set by the Publish dialog, are encoded or uploaded), but pressing Publish in `tauri dev` posts to the real Discord servers. Point Backend URL at `http://localhost:3000` to test publishing. Clips that got up by accident come down with `DELETE /clips/:id` using the device token, which now also deletes their Discord messages.
- **Never run a desktop build from before publish-on-demand against a `clips.db` a newer build migrated.** It ignores `publish`, brings back `auto_upload` defaulting on, and encodes and uploads every local clip, posting each to every server. It also strips `last_publish_guilds` from `settings.json`. The auto-updater makes this rare; a stale installed build in `%LOCALAPPDATA%\Cos Nostra` is how it happens.
- Unpublish is `DELETE /clips/:id` plus keeping the local files, so it is refused for a clip whose local video the Storage tab released: the site copy would be the last one. Republishing always makes a new clip id and link.
- The editor is one range on the match (`edit.rs`). A range that reaches past the clip's own recording copies that span (plus 3 s) out of the match into a **new** recording named after its start, points the row at it and deletes the old recording, its encoded copies and thumbnail. Anything holding a clip's path across an Apply can be left pointing at a deleted file.
- Re-encoding a published clip writes over the existing `<stem>.av1.mp4` / `<stem>.h264.mp4` / `<stem>.jpg` by renaming a `.part` file into place. The thumbnail path does not change, so the UI keys its thumbnail cache on the row's `updated_at`; anything else that caches by path will show the old frame. A player holding the H.264 file open while the rename lands is tolerated on NTFS (Rust opens files with `FILE_SHARE_DELETE`), but if an encode ever fails with a sharing violation, that is where to look.
- Deploying the poll-secret change breaks **linking** on every desktop build from before it, though not existing logins: a stored `device_token` keeps working, but `GET /auth/device/:code` now requires the `pollSecret` as a bearer, and an older build polls without one, gets a 401, treats it as transient and finishes with **"login timed out; try again"**. That reads like a network fault and is not one. The fix is to install a build from after the change and link again; there is no server-side workaround, by design.
- Smart App Control (Windows 11) blocks freshly linked unsigned binaries with `os error 4551`, "Una directiva de Control de aplicaciones bloqueó este archivo", plus a Windows Security toast naming the exe. It stops `cargo test` from running its test binaries and stops a dev build from launching, while `cargo check --tests` still works because it never executes anything. **Turned off on this dev machine on 2026-09-13**, so it should not reappear here; the symptom is written down because it cost a session before that, and because it is what a second machine would hit. Check with `Get-MpComputerStatus | Select SmartAppControlState`. There is no per-app exclusion, and turning it off is one-way — Windows will not re-enable it without a reset or clean install — so it is the user's call, never something to switch off on their behalf.
- `POST /clips/:id/replace` only exists on a backend deployed after the editor. Against an older backend the desktop's upload of an edited clip fails with a route 404 and retries with backoff; it deliberately does **not** fall back to creating a new clip (that would post it to Discord again). Deploy the backend before shipping a desktop build with the editor.
- The exe links `obs.dll` at load time. The installer ships the bootstrapper's dummy from `src-tauri/resources/obs-dummy.dll` and installs per user into `%LOCALAPPDATA%\Cos Nostra` because the real runtime is extracted next to the exe on first launch.

## Skills

Project skills live in `.claude/skills/`: `run-desktop`, `libobs-api`, `video-encoding`, `railway-deploy`, `discord-bot`. Use them instead of rediscovering the workflow.
