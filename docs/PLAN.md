# Cos Nostra implementation plan

Last updated 2026-09-10. Status of milestone 1: done and verified on an AMD RX 9060 XT.

## 1. What we are building

Three parts that share one idea: a clip is a short video with an owner, a game, a timestamp and a set of Discord reactions.

| Part | Runs on | Stack | Job |
|---|---|---|---|
| Desktop | The player's Windows PC | Tauri 2, Rust, embedded libobs, bundled ffmpeg | Keep a replay buffer, save it on a hotkey, trim, encode to AV1, upload |
| Backend | Railway | Node 24, Fastify, Postgres, S3-compatible object storage | Own the clip records, issue upload URLs, serve a player page, compute rankings |
| Bot | Railway | Node 24, discord.js | Post new clips, record reactions, run the yearly event |

Guiding decisions, already made:

- Capture and encoding happen on the player's GPU. Railway never touches video bytes.
- Videos live in object storage with an S3 API. Cloudflare R2 is the default because egress is free. Railway volumes are not used for video.
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

Remaining polish, one to two weeks:

- Settings screen: hotkey rebinding with live capture of the key combo, buffer length, bitrate, folder, start with Windows.
- Show which game is hooked. libobs emits hooked and unhooked signals on the game capture source. Surface them as a status line and a tray tooltip.
- Overlay-free feedback when a clip saves: a Windows toast and a short sound.
- Guard against a second capture tool holding the game. Detect with the window helper and explain it instead of recording black.
- Crash resilience: if libobs fails to start, keep the app alive, show the error and a retry button.
- NSIS installer through `tauri build`, code signing deferred.

Acceptance: a friend installs it from the installer, launches a game, presses the hotkey, finds a correct clip in the folder, and the app survives a reboot.

### Phase 2. Desktop post-processing. Two to three weeks.

Goal: every saved clip becomes a small AV1 file plus an H.264 fallback and a thumbnail, without the user doing anything.

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

### Phase 3. Backend. Three weeks.

Goal: a deployed API with Discord login, presigned uploads, clip records and a player page.

Stack details:

- Fastify with `@fastify/jwt`, `@fastify/cors`, `@fastify/rate-limit`.
- Postgres through `drizzle-orm` with migrations checked in.
- `@aws-sdk/client-s3` and `@aws-sdk/s3-request-presigner` for R2.
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

Storage layout in the bucket: `clips/<user_id>/<clip_id>/av1.mp4`, `h264.mp4`, `thumb.jpg`. Objects are public read behind the R2 custom domain. Deletion removes all three.

Deployment:

- Railway service `backend` with root directory `apps/backend`, Nixpacks or a small Dockerfile, `npm start`.
- Env vars: `DATABASE_URL`, `S3_*`, `DISCORD_CLIENT_ID`, `DISCORD_CLIENT_SECRET`, `JWT_SECRET`, `BOT_SHARED_SECRET`, `PUBLIC_URL`.
- Migrations run on deploy through a release command.

Acceptance: from a clean install, a user logs in through Discord, a clip uploaded from the desktop app opens in the browser at its player URL on desktop and on a phone.

### Phase 4. Discord bot. Two weeks.

Goal: clips show up in Discord and every reaction is counted.

Tasks:

- Gateway intents: Guilds, GuildMessages, GuildMessageReactions. Partials for Message and Reaction so reactions on old messages still arrive.
- Slash commands registered per guild: `/clips setup` to choose the clip channel, `/clips latest`, `/clips top [year] [game]`, `/clips mine`, `/clips link` to get a device login link.
- Posting: an internal HTTP server inside the bot, `POST /post`, called by the backend after upload. Fetch the guild's upload limit from the API. If the H.264 file fits, upload it as an attachment so it plays inline. Otherwise send an embed with the thumbnail, the game, the owner, and a link to the player page.
- Reaction tracking: on add or remove, if the message id belongs to a post, write the vote to the backend. Bot's own reactions are ignored. Count each user once per emoji.
- Seed reactions: after posting, the bot adds two or three configured emojis so people can click instead of searching.
- Resilience: the bot keeps a local queue for backend writes and retries so a backend deploy never loses votes.

Deployment: Railway service `bot`, root directory `apps/bot`, env vars `DISCORD_TOKEN`, `BACKEND_URL`, `BOT_SHARED_SECRET`.

Acceptance: upload a clip from the desktop app and see it in the channel within seconds. React, remove the reaction, react again, and `/clips top` reflects the final count.

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
- Cost: R2 gives 10 GB free and then about 15 dollars per terabyte per month with no egress. A community producing 200 clips a month at 30 MB each is 6 GB a month, so storage cost stays trivial for the first year.

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
