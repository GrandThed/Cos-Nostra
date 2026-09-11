# Cos Nostra

Game clipping for a Discord community. Three apps in one npm workspace. Read `docs/PLAN.md` for the roadmap and the decisions behind it before proposing architecture changes.

## Layout

- `apps/desktop` Windows clipper. Tauri 2. Web UI in `src/` (vanilla TypeScript, Vite), Rust in `src-tauri/`. Capture lives in `src-tauri/src/capture.rs` on embedded libobs through the `libobs-wrapper`, `libobs-simple` and `libobs-bootstrapper` crates.
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

- `tauri dev` on first launch: the bootstrapper downloads OBS, restarts the app itself, and the original `npm run tauri dev` exits with an error. Just run it again. See the `run-desktop` skill.
- The published libobs-rs crates are ahead of the GitHub main branch. Read the API from `~/.cargo/registry/src/*/libobs-wrapper-*` not from the repo. See the `libobs-api` skill.
- `ObsContext::scene(name, channel)` takes an `Option<u32>`. `ObsVideoEncoder` does not expose its id; encoder selection order is mirrored in `capture::pick_h264_encoder`.
- Killing `node.exe` to stop Vite also kills anything else Node on the machine. Prefer stopping the tauri dev task.
- ffmpeg from winget is at `%LOCALAPPDATA%\Microsoft\WinGet\Packages\Gyan.FFmpeg*\ffmpeg-*\bin\` if PATH has not refreshed.
- `LNK1123: error during conversion to COFF` on the final link means the `resource.lib` written by tauri-build got corrupted, usually by two builds running at once. Delete `src-tauri/target/debug/build/cos-nostra-desktop-*/` and rebuild.
- OBS plugins write `rtmp-services/` and `win-capture/` next to the exe at runtime (in `src-tauri/` during dev). Both are gitignored; never commit them.
- `settings.json` must be UTF-8 without BOM. PowerShell's `Set-Content -Encoding utf8` writes a BOM; the loader strips it, but other tools reading the file may not.
- The dev build and the installed build share the single-instance id, so launching one while the other runs only focuses the running one. Stop the dev app before testing an installer.
- ffmpeg and ffprobe are Tauri sidecars in the gitignored `apps/desktop/src-tauri/binaries/`. `npm run ensure-ffmpeg` (run automatically before `tauri dev` and `tauri build`) fills it from PATH or a download. A build that fails with a missing `ffmpeg-x86_64-pc-windows-msvc.exe` means that script did not run.
- Clip metadata lives in `%APPDATA%\Cos Nostra\clips.db` (SQLite, WAL). Delete it together with the `*.av1.mp4`, `*.h264.mp4` and `*.jpg` files next to the clips to start over.
- Never create or drop a `reqwest::blocking` client inside an `async` Tauri command: tokio panics ("Cannot drop a runtime in a context where blocking is not allowed") and the poisoned mutexes take the app down. Wrap the body in `tauri::async_runtime::spawn_blocking` or use a plain thread, as `start_login` and `logout` do.
- The backend runs locally without Postgres: `DATABASE_URL=pglite://./data/dev`. Point the desktop at it through the Backend URL field in Settings (`http://localhost:3000`), and register `http://localhost:3000/auth/discord/callback` as a redirect in the Discord app if you want the login to complete locally.
- Never run `npm start -w apps/bot` while the Railway bot service is deployed: two gateway connections on one `DISCORD_TOKEN` both receive every interaction, so clips post twice, reactions are written twice, and the loser logs `Interaction has already been acknowledged` while the user sees a reply that appears in no log you are reading. See the `discord-bot` skill.
- A dev build uploads to **production**: `settings.rs` defaults `backend_url` to `https://cosnostra.benja.ar`, and `auto_upload` defaults on, so linking Discord in `tauri dev` sends every already-encoded clip in the queue to the real bucket, oldest first. Before testing the queue, either uncheck "Upload clips automatically" in Settings or point Backend URL at `http://localhost:3000`. Clips that got up by accident come down with `DELETE /clips/:id` using the device token.
- The exe links `obs.dll` at load time. The installer ships the bootstrapper's dummy from `src-tauri/resources/obs-dummy.dll` and installs per user into `%LOCALAPPDATA%\Cos Nostra` because the real runtime is extracted next to the exe on first launch.

## Skills

Project skills live in `.claude/skills/`: `run-desktop`, `libobs-api`, `video-encoding`, `railway-deploy`, `discord-bot`. Use them instead of rediscovering the workflow.
