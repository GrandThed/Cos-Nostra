# Cos Nostra implementation plan

Last updated 2026-09-11. Phases 1 to 4 are done and verified on an AMD RX 9060 XT: the whole loop runs, from the hotkey to a clip in Discord to a counted reaction. The backend and the bot are both live on Railway. Phases 5 and 6 have not started.

## 1. What we are building

Three parts that share one idea: a clip is a short video with an owner, a game, a timestamp and a set of Discord reactions.

| Part | Runs on | Stack | Job |
|---|---|---|---|
| Desktop | The player's Windows PC | Tauri 2, Rust, embedded libobs, bundled ffmpeg | Keep a replay buffer, save it on a hotkey, trim, encode to AV1, upload |
| Backend | Railway | Node 24, Fastify, Postgres, S3-compatible object storage | Own the clip records, issue upload URLs, serve a player page, compute rankings |
| Bot | Railway | Node 24, discord.js | Post new clips, record reactions, run the yearly event |

Guiding decisions, already made:

- Capture and encoding happen on the player's GPU. Railway never touches video bytes.
- Videos live in object storage with an S3 API. A Railway Storage Bucket is the default; nothing outside `plugins/storage.js` knows which provider it is. Railway volumes are not used for video.
- Final format is AV1 in MP4 with Opus audio, hardware encoded when the card supports it, SVT-AV1 otherwise. Every clip also keeps an H.264 copy for Discord embeds and old phones until we measure that nobody needs it.
- Identity is Discord. Every user of the desktop app logs in with Discord OAuth, which is what lets the bot tie reactions to clip owners.
- The desktop app is GPL-3.0. Backend and bot live in the same public monorepo.

## 2. Data flow

1. Player presses the hotkey. Desktop flushes the libobs replay buffer to a local H.264 file in about one second.
2. Desktop reads the foreground process to guess the game, generates a thumbnail, and queues the file.
3. The queue worker trims to the chosen length, encodes to AV1 and to an H.264 fallback, then asks the backend for presigned upload URLs.
4. Desktop uploads both files and the thumbnail straight to object storage, then tells the backend the upload is complete.
5. Backend writes the clip record and calls the bot over an internal HTTP endpoint.
6. Bot posts the clip to the configured channel, as an attachment when it fits the server's upload limit, otherwise as an embed linking to the player page. It stores the message id on the clip.
7. Every reaction add or remove on that message is written to the backend as a vote.
8. Once a year the bot runs the recap: rank clips by reactions, render a compilation, post it.

## 3. Repository layout

```
cos-nostra/
  apps/desktop/          Tauri app (src = web UI, src-tauri = Rust)
  apps/backend/          Fastify API and player page
  apps/bot/              discord.js bot
  packages/shared/       TypeScript types and the API client, used by backend, bot and desktop UI
  docs/                  This plan, architecture notes, runbooks
  .github/workflows/     CI: cargo check, npm test, desktop release builds
```

Railway deploys the backend and the bot as two services from the same repo, each with its own root directory. Postgres is a Railway plugin attached to the backend.

## 4. Phases

Each phase ends with something a real user can try. Durations assume one developer working part time.

### Phase 1. Desktop capture. Done.

What exists:

- Tauri app with tray icon, single instance, close to tray.
- libobs bootstrapped at first launch from the signed OBS builds, restart handled.
- Scene with monitor capture under a game capture, desktop audio mixed in.
- Replay buffer with hardware H.264 (NVENC, AMF, QSV in that order, x264 fallback).
- Global hotkey Alt+F10 and a tray menu entry save the buffer.
- Settings file in `%APPDATA%\Cos Nostra\settings.json`.

Polish, done 2026-09-10:

- Settings tab: hotkey rebinding with live key capture, buffer length, bitrate, folder picker, start with Windows, toast and sound toggles. Saving re-registers the hotkey with rollback and restarts the recorder only when a capture setting changed.
- Hooked game shown on the Status tab and in the tray tooltip, from the libobs `hooked` and `unhooked` signals.
- Toast and system sound on save, toast with the error on a failed save.
- Conflict banner when the foreground game already has another tool's capture hook pipe.
- libobs failure or panic keeps the app alive with the error and a Retry button. The release profile now unwinds instead of aborting so the retry path works there too.
- NSIS installer, per user, with the placeholder `obs.dll` shipped as a resource and an uninstall hook that removes the downloaded runtime. Code signing deferred. A tag-triggered GitHub workflow builds the installer but has not run yet.

What changed from the plan and why:

- The installer lands in `%LOCALAPPDATA%\Cos Nostra`, not Program Files, because the OBS bootstrapper extracts the runtime next to the exe and needs a writable directory without elevation.
- The dummy `obs.dll` is committed under `src-tauri/resources/` rather than pulled from `target/`, because tauri-build fails when a listed resource does not exist yet on a clean clone.
- "Survives a reboot" was checked through the Run registry entry that the autostart plugin writes, not an actual reboot of the dev machine. The plugin writes the path unquoted, so the app rewrites the entry quoted right after enabling it.
- Conflict detection looks for the `CaptureHook_Pipe<pid>` that any OBS-style hook creates, including our own, so the check is skipped while we have a game hooked. The positive path was exercised through that false positive; there was no second capture tool to test against.

Acceptance (a friend installs it from the installer, launches a game, presses the hotkey, finds a correct clip in the folder, and the app survives a reboot) was run on the dev machine with ffplay fullscreen standing in for the game.

### Phase 2. Desktop post-processing. Done 2026-09-10.

Goal: every saved clip becomes a small AV1 file plus an H.264 fallback and a thumbnail, without the user doing anything.

What exists:

- ffmpeg and ffprobe as Tauri sidecars. `scripts/ensure-ffmpeg.ps1` copies them from PATH or downloads the BtbN GPL build into the gitignored `src-tauri/binaries/`; it runs before every `tauri dev` and `tauri build` because tauri-build refuses to build without them.
- Encoder probe at startup, cached in settings, re-probe from the UI. AMF was chosen for AV1 and H.264 on the dev GPU.
- Clip queue in SQLite (`%APPDATA%\Cos Nostra\clips.db`), worker thread, backoff retries up to five attempts, stale `encoding` rows reset at startup.
- Game detection from the foreground window at hotkey time: a table of about 240 executables, window title cleanup as fallback, a list of programs that are never games.
- Thumbnail, AV1 and H.264 written next to the source as `<stem>.jpg`, `<stem>.av1.mp4`, `<stem>.h264.mp4`.
- Clips tab: thumbnail, editable game, date, duration, sizes, status, open folder, retry, delete.

What changed from the plan and why:

- Encoding waits while a game is hooked or the foreground window looks like a game, rather than watching process priority alone. ffmpeg still runs at below-normal priority with half the cores.
- Trim is plumbed through (`ffmpeg::Trim`) but not exposed in the UI until phase 6.
- The AV1 preset was wrong until 2026-09-10 and is now fixed: AMF quantizers run 0-255, not 0-51, so `-qp_i 28` asked for near-lossless AV1 and produced files about twice the size of the H.264 fallback on real gameplay (53 MB against 27 MB for one 27 s clip). `av1_amf` now uses cqp 95, measured at 32 percent smaller than the H.264 fallback with a 0.87 VMAF gap, and 65 percent smaller than the old output. The measurements, the rejected knobs and the method are in the video-encoding skill. `av1_nvenc` and `av1_qsv` keep 28, which is correct on their native 0-51 scales but is still unmeasured because this is an AMD machine.
- The installer grows by two 220 MB static ffmpeg binaries (compressed by NSIS). If that hurts, switch to a download at first launch like the OBS runtime.

Acceptance (ten clips saved during gameplay all encoded within a few minutes of leaving the game, at low priority) was run with ffplay fullscreen as the game: eleven clips queued, none encoded while it was focused, all done 143 seconds after closing it, ffmpeg observed at BelowNormal priority.

Tasks:

- Bundle ffmpeg as a Tauri sidecar binary. Use the same build that is on this machine, which has `av1_amf`, `av1_nvenc`, `av1_qsv` and `libsvtav1`.
- Encoder probe at startup: run ffmpeg once with each hardware AV1 encoder on a two second sample and keep the first that succeeds. Cache the result in settings.
- Encoding presets:
  - AV1 hardware: constant quality around QP 28 for AMF and NVENC, `-quality quality`, keyframe every two seconds.
  - AV1 software: `libsvtav1 -preset 8 -crf 34`, which ran at roughly two times realtime on this Ryzen 5 5500.
  - H.264 fallback: hardware H.264 at 8 Mbps, CRF style where the encoder allows it.
  - Audio: Opus 128 kbps in the AV1 file, AAC 160 kbps in the H.264 file.
- Trim step: keep the whole buffer by default, optional trim from the UI later. Cutting is done with `-ss` and `-to` before the encoder so no re-encode of unused footage happens.
- Thumbnail: single frame at 25 percent of the clip, JPEG, 640 wide.
- Game detection: at save time read the foreground window's process name and title. Map known executables to game names in a small table, fall back to the window title. The user can correct it in the UI.
- Job queue: SQLite file under app data, one row per clip with states `saved`, `encoding`, `encoded`, `uploading`, `done`, `failed`. A worker thread drains it. Retries with backoff. Survives restarts.
- Clip list in the UI: thumbnail, game, date, size, status, open folder, delete.

Acceptance: ten clips saved in a row during gameplay all end up encoded within a few minutes of leaving the game, with no dropped frames in the game while encoding runs at low process priority.

### Phase 3. Backend. Done 2026-09-10, deployed and verified against production.

Goal: a deployed API with Discord login, presigned uploads, clip records and a player page.

Live at `https://cosnostra.benja.ar`, with Railway Postgres and a Railway Storage Bucket attached.

What changed from the plan and why:

- Object storage is a Railway Storage Bucket instead of R2, still only through the S3 API. Railway buckets have no public read, so objects are never public: `GET /clips/:id/{av1,h264,thumb}` are the stable URLs and redirect to one-hour presigned GETs. The player page, Discord embeds and the bot use those.
- Local development and tests run on PGlite (Postgres in WASM) through the same Drizzle schema and migrations; `DATABASE_URL=pglite://memory` or `pglite://./data/dev`. Production uses `pg`.
- Railway services build from Dockerfiles with the repo root as context, because the npm lockfile lives at the root. The `railway.json` files are dead weight: Railway deprecated Config as Code, so the builder is selected with a `RAILWAY_DOCKERFILE_PATH` service variable and every other setting is set by hand in the dashboard. Details in the railway-deploy skill.
- Device tokens are opaque random strings stored hashed; the JWT only signs the OAuth `state`.
- Backend and bot load the repo-root `.env` locally (`node --env-file-if-exists`), and the root `.env.example` is the single local reference.
- `device_logins` rows are deleted when the desktop collects the token, which is how "consumed" is represented.
- `@aws-sdk/client-s3` signs `x-amz-checksum-crc32` for an *empty* body into every presigned PUT URL. Railway's bucket ignores it and real uploads succeed (verified at 50 KB, 20 MB and 38 MB). A provider that enforced it would reject every upload, so this is a portability landmine worth remembering rather than a bug to fix now.
- The desktop app's default `backend_url` is production, so a fresh install talks to Railway with no configuration.

Acceptance, run end to end against production on 2026-09-10: the desktop app's own "Link Discord"
button started a device login, the browser completed the Discord OAuth round trip with no clicks
(the account had already authorized the application) and the app logged in as `granthed`. Five
clips uploaded straight to the bucket through presigned PUTs at roughly 4 MB/s, each in 13-18 s,
and `POST /clips/:id/complete` verified all three objects with HEADs. The player page at
`/c/cKKTMjWyCu5D` was checked in headless Edge over the DevTools protocol at 390x844 mobile and
1280x900: no horizontal overflow at either size, and the AV1 source actually decoded and played
(`readyState` 4, 77 frames in 1.5 s). `DELETE /clips/:id` removed objects and rows for the test
clips, and `DELETE /auth/device` revoked the probe token, which then answered 401.

Deferred: a real iOS Safari check, because there is no Apple device here. The page keeps the
H.264 `<source>` for exactly that case and Edge reports `probably` for both codecs, but "works on
a phone" has only been proven with a phone-sized Chromium viewport.

Stack details:

- Fastify with `@fastify/jwt`, `@fastify/cors`, `@fastify/rate-limit`.
- Postgres through `drizzle-orm` with migrations checked in.
- `@aws-sdk/client-s3` and `@aws-sdk/s3-request-presigner` for the bucket.
- `pino` logging, `/health` for Railway.

Data model:

| Table | Columns |
|---|---|
| users | id, discord_id, username, avatar, created_at |
| devices | id, user_id, name, token_hash, last_seen |
| clips | id, user_id, game, title, duration_ms, width, height, size_av1, size_h264, key_av1, key_h264, key_thumb, recorded_at, uploaded_at, status |
| posts | id, clip_id, guild_id, channel_id, message_id, posted_at |
| reactions | id, post_id, user_discord_id, emoji, created_at, removed_at |
| events | id, guild_id, year, status, compilation_key, created_at |

Reactions are append-only with a removed_at timestamp. Rankings count rows where removed_at is null. This keeps the history and lets the yearly job replay it.

Auth:

- Desktop login: the app opens the browser to `/auth/discord/start?device=<code>`. After the OAuth callback the backend shows a page that says the device is linked and stores a long-lived device token. The desktop polls `/auth/device/<code>` until it receives the token. This is the standard device flow and avoids a local HTTP listener in the app.
- Bot to backend: a shared secret in an `Authorization` header over Railway's private network.

Endpoints:

| Method and path | Purpose |
|---|---|
| POST /auth/device | Start a device login, returns a code |
| GET /auth/discord/start, /auth/discord/callback | OAuth dance |
| GET /auth/device/:code | Poll for the device token |
| POST /clips | Create a pending clip, returns presigned PUT URLs for av1, h264 and thumb |
| POST /clips/:id/complete | Mark upload done, triggers bot post |
| GET /clips/:id | Clip metadata |
| GET /clips?user=&game=&year=&sort= | Listing with pagination |
| GET /c/:id | Player page, HTML with an AV1 video tag and H.264 fallback source |
| POST /internal/posts | Bot records the Discord message for a clip |
| POST /internal/reactions | Bot records a reaction add or remove |
| GET /rankings?guild=&year= | Top clips by reactions, used by the bot and the recap |

Storage layout in the bucket: `clips/<user_id>/<clip_id>/av1.mp4`, `h264.mp4`, `thumb.jpg`. Objects are never public: every read is a presigned GET the backend redirects to. Deletion removes all three.

Deployment: one Railway service built from `apps/backend/Dockerfile` with the repo root as context, root directory `/`, migrations in a pre-deploy step, healthcheck `/health`, custom domain `cosnostra.benja.ar`. The per-service variable list lives in the railway-deploy skill so there is one copy of it.

Acceptance: from a clean install, a user logs in through Discord, a clip uploaded from the desktop app opens in the browser at its player URL on desktop and on a phone.

### Phase 4. Discord bot. Done 2026-09-11.

Goal: clips show up in Discord and every reaction is counted.

Both services are live on Railway and the bot is in the dev guild (FAMAFIA,
`438477166573912074`) with `/clips` registered guild-scoped.

Acceptance, run end to end against production on 2026-09-11: a clip saved with the hotkey
during a real Wardogs session encoded, uploaded, and the backend's `POST /clips/:id/complete`
at 14:52:25.076 produced Discord message `1547983158601850932` at 14:52:25.147 - **71 ms**,
with nothing triggered by hand. It rendered as a native `type=video` embed at 1920x1080 with
the three seed reactions. A human then reacted with two emojis (`open` 0 -> 2, rankings
`2r/1u`) and removed one (`open` -> 1, `1r/1u`), which is the pairing test that matters: the
remove closed the row its own add had opened. `/clips top` then listed the clip first with
"1 reactor" and `/clips latest` showed `Reactions = 1`. The bot's own seed emojis were never
counted at any point.

What is verified:

- The whole loop, as above: hotkey to Discord to a counted reaction.
- `POST /post` posts a clip and records the message; a wrong shared secret is 401 in
  constant time.
- `/clips setup`, `/clips latest` and `/clips top` driven from Discord.
- 98 bot tests and 29 backend tests, none of which touch a gateway or a network.

Two bugs this test found, both fixed:

- **A clip with no game could never upload.** The desktop serialises a Rust `Option::None` as
  JSON null and zod's `.optional()` rejects null, so `POST /clips` answered 400 and the queue
  retried forever. Every clip uploaded before this happened to have a game, so nothing had
  exercised it. `game`, `title`, `width` and `height` are `nullish` now; a wrong type is
  still a 400, and there is a regression test.
- **Game detection only read the foreground window.** The hotkey is global, so a clip is often
  saved while the game is running but not focused, and those clips arrived with no game at all.
  It now falls back to the game libobs has hooked.

What changed from the plan and why:

- Posting sends **no embed of its own**. Discord suppresses the link preview on any message
  that carries an embed, and that preview is what holds the video player, so a clip too large
  to attach used to appear as a static thumbnail. Posting the bare player URL instead makes
  Discord build a native `type=video` embed at 1920x1080 from the page's og: tags: an inline
  player at full quality with no size limit. The measurements are in the discord-bot skill.
  The attachment path still suppresses the preview, since the file already plays inline.
- Consequently `og:description` in `routes/player.js` carries no reaction count: Discord caches
  an embed on first crawl and never re-crawls, so the count would freeze at zero.
- A clip is posted to **every** configured guild, one `posts` row each, which is what
  `posts.guild_id` always implied. Restricting it to guilds the owner belongs to is future work.
- `guild_settings` (guild id, channel, seed emojis) plus `GET`/`PUT /internal/guilds` were added
  to the backend; the plan never said where `/clips setup` would keep its channel.
- `/clips setup` is gated on Manage Guild at runtime rather than with
  `setDefaultMemberPermissions`, which Discord only accepts on a top-level command and which
  would have hidden `latest`, `top`, `mine` and `link` from ordinary members.
- The reaction outbox is in-memory. A crash loses the backlog; the plan's "local queue" was not
  specified as durable and nothing yet justifies a file or a table.
- `BOT_INTERNAL_URL` on the backend is what makes the path automatic, and it was the last
  thing missing. Until it is set the backend logs `BOT_INTERNAL_URL unset, not notifying bot`
  and clips upload without ever reaching Discord.

Deferred, with reasons:

- `/clips mine` and `/clips link` answer ephemerally, so their replies are not in the channel
  history and cannot be read back through the REST API the way the others were. Their handlers
  are covered by unit tests and share the defer/edit path that `latest` and `top` exercised
  live.
- Re-adding the same emoji after removing it was not observed as a separate step. Add was
  proven twice and remove was proven to close the row its add opened, which is the case the
  emoji-key bug would have broken; a re-add is the same insert path as the first add.
- Animated custom emoji. `emojiKey` exists precisely because discord.js keys them differently
  on add and remove, and the dev guild had no animated emoji to click.


### Phase 5. Yearly recap. Two weeks, mostly a worker.

Goal: once a year the bot posts a compilation of the best clips.

Tasks:

- `/clips recap start [year]` opens an event: the backend freezes the ranking for that year and guild and stores it on the event row.
- Selection rules, configurable per guild: top N clips by distinct reacting users, at most K per owner, minimum one clip per active member if there is room.
- Rendering worker: a Node script in `apps/backend/worker` that downloads the H.264 sources, normalizes each to 1920 by 1080 at 60 fps with loudness normalized audio, adds a title card per clip with owner and game, concatenates with ffmpeg, and encodes to AV1 plus H.264. Uploads to `events/<guild>/<year>/`.
- Where it runs: as a Railway worker service with a larger CPU plan started only for the job, or on the organizer's PC with the same script. The script must work in both places, so it is plain Node plus ffmpeg with no Railway assumptions.
- The bot posts the result with a leaderboard embed and a link to a recap page on the backend that lists every clip in order.

Acceptance: run the recap against last year's test data and get a watchable video with correct ordering and credits.

### Phase 6. Editing in the desktop app. Three weeks, after everything above works.

- Trim: a timeline under a video preview with in and out handles. Preview plays the local H.264 file through the webview.
- Simple cuts: remove a middle section, join the two parts. Still done through ffmpeg, no custom video code.
- Re-upload of an edited clip replaces the object and keeps the same clip id and Discord post.
- Later ideas, not planned: overlays, slow motion, audio ducking.

## 5. Cross-cutting work

- `packages/shared`: TypeScript types for clips, users and events, a typed fetch client, and zod schemas used by the backend for validation and by the desktop UI for forms.
- CI: on every push run `cargo check` and `cargo clippy` for the desktop, `npm test` for the JavaScript packages. On tags, run `tauri build` on a Windows runner and attach the installer to a GitHub release.
- Observability: Railway logs for both services, a `/health` endpoint each, and an alert if the bot disconnects for more than a few minutes.
- Backups: Railway Postgres daily backups. The bucket is the source of truth for video, so versioning is enabled on it.
- Cost: a community producing 200 clips a month at 30 MB each stores 6 GB a month, so stored bytes stay cheap on any provider. Railway bills egress as well, unlike R2, so watch bandwidth once people actually watch clips; the S3-only surface means moving the bucket elsewhere is a variable change.

## 6. Risks and mitigations

| Risk | Mitigation |
|---|---|
| Anti cheat blocks the game capture hook | We ship the signed hook from the official builds and never rebuild it. Fall back to monitor capture automatically. |
| libobs-rs is maintained by one person | Pin versions, vendor the crate sources if the repo goes quiet, keep the libobs surface small and behind our own `Recorder` type. |
| AV1 playback on old phones | Always keep the H.264 copy and let the player page pick. Revisit in a year. |
| Discord upload limit shrinks again | Posting code treats the attachment path as optional and always has the link path. |
| Railway sleeps or restarts the bot | Bot has no state that matters, reconnects on its own, and the backend is the source of truth for votes. |
| Encoding hurts game performance | Encoding runs at below normal priority and only when the game is not the foreground window, or after the game exits. |

## 7. Order of work for the next month

1. Phase 1 polish: settings screen, hooked game indicator, installer.
2. Phase 2: ffmpeg sidecar, encoder probe, queue, thumbnails.
3. Phase 3: backend with device login and uploads, deployed to Railway.
4. Phase 4: bot posting and reaction tracking.

At the end of that month the whole loop works: hotkey to Discord to counted reactions. Recap and editing come after.
