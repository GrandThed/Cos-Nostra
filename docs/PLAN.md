# Cos Nostra implementation plan

Last updated 2026-09-15. Phases 1 to 4 are done and verified on an AMD RX 9060 XT: the whole loop runs, from the hotkey to a clip in Discord to a counted reaction. The backend and the bot are both live on Railway. Phase 6 (cutting) is done on the desktop and needs the backend's replace route deployed. Phase 5 (a public per-guild clip site, redefined from the original yearly-recap plan) is built and tested locally; it deploys alongside phase 6's replace route, since both need the same backend push.

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

- ffmpeg as a Tauri sidecar. `scripts/ensure-ffmpeg.ps1` copies it from PATH or downloads the BtbN GPL build into the gitignored `src-tauri/binaries/`; it runs before every `tauri dev` and `tauri build` because tauri-build refuses to build without it.
- *Later:* releases ship a minimal static ffmpeg from `scripts/build-ffmpeg.sh` (pinned sources, only the components `ffmpeg.rs` uses) and no ffprobe, whose two uses now read ffmpeg's own input description and `framecrc` output. Two full builds were 313 MB of the 452 MB install.
- Encoder probe at startup, cached in settings, re-probe from the UI. AMF was chosen for AV1 and H.264 on the dev GPU.
- Clip queue in SQLite (`%APPDATA%\Cos Nostra\clips.db`), worker thread, backoff retries up to five attempts, stale `encoding` rows reset at startup.
- Game detection from the foreground window at hotkey time: a table of about 240 executables, window title cleanup as fallback, a list of programs that are never games.
- Thumbnail, AV1 and H.264 written next to the source as `<stem>.jpg`, `<stem>.av1.mp4`, `<stem>.h264.mp4`.
- Clips tab: thumbnail, editable game, date, duration, sizes, status, open folder, retry, delete.

What changed from the plan and why:

- Encoding waits while a game is hooked or the foreground window looks like a game, rather than watching process priority alone. ffmpeg still runs at below-normal priority with half the cores.
- Trim is plumbed through (`ffmpeg::Trim`) but not exposed in the UI until phase 6.
- The AV1 preset was wrong until 2026-09-10 and is now fixed: AMF quantizers run 0-255, not 0-51, so `-qp_i 28` asked for near-lossless AV1 and produced files about twice the size of the H.264 fallback on real gameplay (53 MB against 27 MB for one 27 s clip). `av1_amf` now uses cqp 95, measured at 32 percent smaller than the H.264 fallback with a 0.87 VMAF gap, and 65 percent smaller than the old output. The measurements, the rejected knobs and the method are in the video-encoding skill. `av1_nvenc` and `av1_qsv` keep 28, which is correct on their native 0-51 scales but is still unmeasured because this is an AMD machine.
- The installer grows by two 220 MB static ffmpeg binaries (compressed by NSIS). *Resolved later* by the minimal ffmpeg build and dropping ffprobe (see the sidecar note above), not by a download at first launch, which would have saved installer size but no disk.

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

- Desktop login: the app opens the browser to `/auth/discord/start?device=<code>`. That page shows the device name and the code and asks the user to confirm before a same-origin form POST sends them to Discord; a link alone never reaches Discord, so a phished verify URL cannot link a stranger's device. After the OAuth callback the backend shows a page naming the linked device and stores a long-lived device token. The desktop polls `/auth/device/<code>` with the `pollSecret` it got when it started the login (a bearer header; without it the poll is a 401), until it receives the token. This is the standard device flow and avoids a local HTTP listener in the app.
- Bot to backend: a shared secret in an `Authorization` header over Railway's private network.

Endpoints:

| Method and path | Purpose |
|---|---|
| POST /auth/device | Start a device login, returns a code and a poll secret |
| GET+POST /auth/discord/start, GET /auth/discord/callback | Confirmation page, then the OAuth dance |
| GET /auth/device/:code | Poll for the device token (bearer: the poll secret) |
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


### Storage tab. Done 2026-09-11.

Not in the original plan. It exists because the clipper never deleted anything: the replay
buffer writes about 20 Mbps and every original recording stayed on disk next to its own AV1
copy, which is roughly a tenth of the size. A month of use is tens of gigabytes, most of it
footage that has already been encoded and uploaded.

- `storage.rs` owns the file layout (`output_paths`, `clip_files`, moved out of `lib.rs`) and
  answers `storage_stats`: total bytes, a split by kind, a per-game breakdown for the bar, a
  published-versus-local split, what each cleanup would free, and free space on the volume.
  Every number is a fresh `stat`, never the sizes recorded at encode time, because files move
  and get deleted outside the app.
- Three cleanups, each behind a confirming second click: drop the original recordings of clips
  that already encoded; release the local video of clips the backend already has; delete failed
  clips outright. Leftover files in the folder that no row claims are counted and named but
  never deleted, since they are not ours.
- Two settings, both off by default so nothing changes for an existing install:
  `delete_source_after_encode` and `storage_limit_gb`. The limit is enforced from the queue's
  status-change callback, and only ever gives up clips the backend has, so it can leave the
  folder over the limit rather than deleting the only copy of something. The tab says so when
  that happens.

What changed from what one might expect:

- Releasing a published clip keeps the row, the thumbnail and the page URL, and only nulls
  `av1_path` and `h264_path`. The clip stays in the Clips tab reading "on the site only" with
  its Copy link button; no schema change was needed, since a null output path already meant
  "no local file". Deleting the row instead would have thrown away the link.
- The database lives in `%APPDATA%` and the clips in Videos, which the first version of the
  tests did not reproduce: the SQLite WAL files landed in the clip folder and were counted as
  leftovers. The fixture now keeps them apart the way the app does.

### Desktop UI redesign. Done 2026-09-11.

The four-tab 480x360 window was scaffolding: it showed the pipeline, not the clips. The
redesign in `design_handoff_cos_nostra_ui/` replaces it with a resizable 1120x720 app whose
subject is the library, and it is implemented as plain HTML/CSS/TypeScript modules under
`apps/desktop/src/` with no framework, because every component in the handoff is one element
and one class.

- Navigation: three tabs (Library, Storage, Settings) in a segmented pill. Capture status is
  not a tab but a live pill in the toolbar that opens a status panel, and the three alarms
  (recorder failed, hotkey taken, ffmpeg missing) plus the capture conflict stack as banners
  under the toolbar on every tab. The player is a detail view inside the library, not a
  destination, and its Prev/Next walk whatever the library is currently showing.
- The window is undecorated (`decorations: false`) so the title bar is ours, at the design's
  38 px. That needs `core:window:allow-*` permissions in `capabilities/default.json`.
- Theme: one token set in `src/styles/tokens.css`, switched by `prefers-color-scheme`. WebView2
  fixes the scheme when the window is created, so a system theme change only shows after a
  restart.
- The three design fonts are self-hosted in `src/assets/fonts/` (about 160 KB of variable
  woff2, OFL-1.1) rather than pulled from Google, because the app has to look the same with no
  network. `scripts/fetch-fonts.mjs` regenerates them.
- The player plays the local H.264 through the asset protocol, whose scope is widened to the
  clip folder at startup and whenever the folder setting changes. A clip that has not finished
  encoding plays its original recording; one whose local video was released streams from
  `/clips/:id/h264`.

What this needed from the Rust side, all of it small:

- Encode and upload percentages, because the design's badges show them. `ffmpeg -progress` is
  parsed from a spawned child (stderr drained on its own thread so neither pipe can fill), and
  the upload body is a counting reader with an explicit length, since a chunked presigned PUT
  is rejected. Both surface as a `clip-progress` event plus a `clip_progress` command for a UI
  that opened mid-job.
- `rename_game`, which renames every clip of one game and so also merges two.
- An `fps` column (schema v3) so the rail can say "1920x1080 - 60 fps" and the player can step
  one frame. Rows written before it read `None` and fall back to 60.
- `delete_clip` now deletes the copy on the site first and stops if that fails, because the
  rail calls the button "Delete everywhere". The backend keeps the row, so the Discord post
  survives with a dead video; the rail says exactly that rather than claiming otherwise.
- The OBS bootstrap moved inside the Tauri app so the first-run screen can show the download.
  The window is up and reporting progress while it runs, and on `Restart` the app says so and
  exits for the updater.

### Match recording and the game timeline. Base and Valorant phase 1 done 2026-09-13; Teamfight Tactics, Counter-Strike GSI, Valorant phase 2 and match storage added the same day.

Not in the original plan. The hotkey only catches what the player remembers to save; this
records every match of Valorant, League of Legends and Counter-Strike so clips can be made
afterwards, from a list of matches with a timeline of what happened in each.

The shape, and why:

- **The whole session is recorded, then cut.** A session opens when the game's process
  appears (`timeline::sight`, a Toolhelp snapshot every second, no handle to the game) and
  closes ten seconds after it is gone, or six minutes for League while its client is still
  open between games. Detection only *labels* footage, it never decides what gets recorded,
  so a missed or late match start costs a marker, not the match.
- **Same encoder, second output.** `capture::Recorder::start_recording` adds OBS's
  `mp4_output` (hybrid MP4, readable after a crash) on the replay buffer's own video and audio
  encoders, so a session costs disk (about 9 GB an hour at 20 Mbps until it is cut), not a
  second hardware encode. `ffmpeg_muxer` with fragmented flags is the fallback.
- **Everything is wall-clock time.** Providers emit `timeline::Event`s (`match_start`,
  `round_end`, `match_end`, and `kill`/`death`/`assist` for games that can see them) stamped
  with when they happened. A recording's start is measured afterwards as its stop time minus
  its probed duration; a match file stores its first frame's time. Events land in any file by
  subtraction, and a recorder restart mid-match just leaves two recordings side by side.
- **Cutting is a stream copy.** `cutter.rs` gives each match its span plus 10 s before and
  8 s after, copied from the keyframe at or before the start (found from packet headers around
  the point, so it costs the same on a three hour file), joined with the concat demuxer when a
  restart split it, plus a thumbnail. Then the raw recordings are deleted. A provider that
  worked and saw no match means the session was menus and it is discarded; a game with no
  provider, or a provider that never reached the game, keeps each recording whole, renamed.
- **A clip from a match is an ordinary clip.** `clip_from_match` copies the range with three
  seconds either side into the clip folder and enqueues it with the exact range as its `cut`
  (`Queue::enqueue_with_cut`), so encoding, the editor and uploading are the paths that exist.
  Since publish on demand (below) it stays local like a hotkey clip until published.
- **Separate database.** `sessions.db` beside `clips.db`, because the queue versions its schema
  through `user_version` and two stores in one file would share the number.
- Files go to `<clip folder>\Matches`, which the Storage tab's top-level scan does not see and
  the asset protocol scope now also allows. Since 2026-09-14 new sessions go to
  `<clip folder>\<Game>\Matches` instead (see "Game folders and game art" below).
- When the session ends the window comes forward on the Matches tab (`open_after_session`),
  and both new settings default on.

Valorant phase 1 (`providers/valorant.rs`): the Riot Client's lockfile gives a port and password
for its loopback API; `/chat/v1/session` gives the player's puuid and `/chat/v4/presences`,
polled every second, the base64 presence blob. `INGAME` opens a match (not in the range),
every rise of the score is a `round_end` with who won it, leaving `INGAME` ends it with the
result, and ninety seconds without presence mid-match writes it off at the moment it went
quiet. Riot moved the loop state into `matchPresenceData` in 2024, so fields are looked up by
name at any depth, nested groups first; both layouts are tested.

Verified 2026-09-13 in `tauri dev` with uploads off, against a real Riot Client (League's
client was open): ffplay renamed to `VALORANT-Win64-Shipping.exe` opened session 1, the hybrid
MP4 started on the shared AMF encoder, the provider connected to the local API, closing the
fake game stopped the recording (2052 frames, 2 lagged), the session ended after the grace,
was kept whole because no Valorant presence existed, renamed to a 34.2 s 1080p60 H.264/AAC
match file with a thumbnail, and the window came up on it. `cargo test`: 80 pass, including
real ffmpeg cuts across a recorder restart and the watch state machine on a fake host.

Not verified, and what would:

- A real Valorant match. Round ends from the score, the result, and the 2024 presence layout
  are tested against hand-written blobs only; the log line `valorant: INGAME (queue ..., map
  ...)` on a real match is what confirms the fields. If the score never moves, the score
  fields have moved too.
- `clip_from_match` end to end from the UI; its keyframe search, copy and queue insert are each
  tested.
- Marker precision on real footage. The file's start comes from the stop time, which libobs
  honours to within a frame or two; presence polls are one second apart.

Also verified 2026-09-13: a real League match (ARAM) was recorded, ended and kept whole, before
League had a provider. An app restart mid-game ended that session at its start in the list,
because recovery only knew the recording's start request; recovery now takes the recording
file's last write as its stop.

League provider (`providers/league.rs`), added the same day. The game client's documented Live
Client Data API (`https://127.0.0.1:2999/liveclientdata/allgamedata`, no login, self-signed
certificate) answers only while a match is loaded. Each poll gives the game clock, the active
player's Riot ID, all players with champion and team, and the event list. The clock's zero in
wall-clock time is the smallest `now - gameTime` seen, and every event lands at zero plus its
`EventTime`, which also places the past events right when the app joins mid-match. The player's
own kills, deaths, assists and multikills go on the timeline (other players' kills do not), plus
dragons, heralds, barons, voidgrubs, towers and inhibitors with whose team got them (towers by
the structure's `T1`/`T2` side, not the last hit), team aces, and `GameEnd` with the result.
`Multikill` and `Objective` were added to `timeline::Event` for it, and every non-round event now
has a Select button in the Matches tab that takes the dozen seconds leading up to it. Tested
against hand-written snapshots, including a match joined midway, a post-game screen that keeps
the API up, and a new game without an end; **not yet run against a real match**, and Riot's
event field names are from its sample events rather than a capture.

Teamfight Tactics, Counter-Strike GSI, Valorant phase 2 and match storage, added 2026-09-13:

- **Teamfight Tactics** (`TFTClient-Win64-Shipping.exe`) is a `SessionGame` now, with no
  provider, so it behaves exactly like Counter-Strike did before its own provider existed:
  the whole session is kept and renamed once, `provider_reached` never true.
- **Counter-Strike: Game State Integration** (`providers/counter_strike.rs`). CS2 POSTs its
  match state to a local HTTP endpoint named by a `.cfg` dropped in the game's `csgo/cfg/`
  folder; `tiny_http` (Apache-2.0/MIT) runs that receiver on its own thread and feeds a channel
  `poll` drains, since this provider is push- rather than poll-based like the other two. A
  `round.phase` of `"over"` is a round end, `map.phase` of `"gameover"` the match's end, scores
  from `map.team_ct`/`map.team_t` oriented by `player.team`. `reached()` only flips once a POST
  has actually produced a timeline event, not on the first POST: CS2's heartbeat (30 s in the
  shipped `.cfg`) would otherwise mark a quiet main-menu session reached with nothing played,
  which `cutter.rs` discards outright. The port is `providers::counter_strike::GSI_PORT`
  (51122); the `.cfg` is `src-tauri/resources/gamestate_integration_cosnostra.cfg` and is
  **not** copied into the game automatically — it has to be placed in
  `<Steam library>\steamapps\common\Counter-Strike Global Offensive\game\csgo\cfg\` by hand.
  Tested only against hand-written GSI POST bodies shaped like Valve's documented examples;
  **no real CS2 install has exercised this.**
- **Valorant phase 2** (`providers/valorant.rs`): once a match ends with a real result, the
  local Riot Client's `/entitlements/v1/token` gives an access token and entitlements JWT, and
  `GET pd.<shard>.a.pvp.net/match-details/v1/matches/<id>` gives the full match, whose
  `kills[]` (`killer`, `victim`, `timeSinceGameStartMillis`) become `Kill`/`Death` events
  anchored on the match's start the same way League's game clock is. The match id itself is
  read from a `matchId` field the presence blob is *hoped* to carry (`Presence::match_id`);
  the shard is a new setting, `Settings::valorant_shard` (default `na`; `eu`, `ap`, `kr` are the
  other values used in the wild), since nothing in the local API names it reliably. Every part
  of this — the `matchId` field's very existence, the match-details shape, all of it — is
  **UNVERIFIED against a real match**; weapon and headshot are left out rather than guessed,
  since the documented shape puts them behind a weapon-asset id this file has no table for.
- **Matches in the Storage tab, and a cap on kept session footage.** `storage::scan_matches`
  sums every session's match files (a fresh `stat`, same rule as the rest of that module) into
  a new `StorageStats::matches` bucket, separate from `published`/`local_only` since matches
  have no AV1/H264 step and are never uploaded. A new setting, `session_storage_limit_gb`
  (default 0, off, mirroring `storage_limit_gb`), is enforced by `storage::enforce_session_limit`
  after every batch of sessions finishes cutting: unlike clips, a match is never backed up
  anywhere, so the oldest ones are deleted outright via `SessionStore::delete_match` rather than
  having a local copy released. A currently-recording session's raw (not yet cut) footage is
  not part of `scan_matches`' total, only match files that have already been cut or renamed —
  the number can lag slightly behind actual disk usage while a session is live.

Next:

- Play a League match with this build and check that kills land where they happened. The log
  line `league: match on (...)` shows the mode, the map and which names count as the player; if
  kills never show up, the names in events differ from the active player's.
- Play a real Counter-Strike match with the `.cfg` installed and check that `counter_strike:
  match on (...)` and round/match events actually appear; the GSI shape and the `reached()`
  eagerness rule are both unverified against the real game.
- Play a real Valorant match through to the end and check the log line naming the shard and
  match id; if `matchId` never appears in the presence blob, kills silently never populate,
  which is the whole reason `Presence::match_id` and everything downstream of it is UNVERIFIED.

### Phase 5. Public per-guild clip site. Built 2026-09-13, not yet deployed.

Redefined from the original plan's once-a-year recap worker (kept below as a later idea) to
something used every day: a "YouTube for the server's clips" at a URL scoped to each Discord
server, open to browse and watch with no login, with Discord login only to manage your own
clips.

What exists:

- **Path-scoped per guild, not hardcoded to one server.** `guild_settings` gained nullable
  `name`, `icon` (a bare Discord CDN hash, same convention as `users.avatar`) and `slug`
  columns, the last with a unique index. `/clips setup` now sends the guild's live `name`/`icon`
  (from `interaction.guild`, no extra Discord call) on every run, plus an optional `slug`
  argument, sticky like `language`. A taken slug is refused with `409 slug_taken`; the bot
  catches that specific status, retries the same `PUT /internal/guilds/:guildId` once without
  the slug, and reports the conflict separately so it never costs the channel or language
  change riding along with it. Setting the slug for an existing guild is a manual, one-time
  `/clips setup` re-run - there is no admin UI or batch script, since every future guild uses
  the exact same path.
- **Viewing needs no login.** `routes/guildSite.js` serves `/:slug` (recent clips), `/:slug/games`
  and `/:slug/g/:game` (browse by game), `/:slug/users` and `/:slug/u/:discordId` (browse by
  user, with avatars), all public, all built on the same `clips` join through `posts.guildId`
  that `GET /rankings` already used. `/:slug/c/:id` never renders a clip itself - it 302s to
  `/c/:id?guild=:slug` so there is exactly one place a clip is ever rendered, keeping the
  Discord-unfurl-critical Open Graph tags in `routes/player.js` from ever diverging.
- **A browser session, separate from the desktop's device tokens.** `GET /login` and
  `GET /login/callback` run the same Discord OAuth dance `lib/discord.js` already had, but end
  in a `browser_sessions` row (a random token, only its hash stored - the same shape as
  `devices`, chosen over a sealed cookie or a bare JWT specifically because it can be revoked
  server-side) carried in a signed, `httpOnly`, `sameSite=lax` cookie. `sameSite=lax` alone is
  the CSRF defense for the mutating routes below; no token was needed. `POST /logout` destroys
  the row and clears the cookie. New required env var `SESSION_COOKIE_SECRET` (>=32 chars);
  the Discord application needs a second OAuth2 redirect, `<PUBLIC_URL>/login/callback`,
  alongside the device flow's.
- **Clip management reuses the desktop's own routes, not a parallel API.** `PATCH /clips/:id`
  (new: rename title, change game) and the existing `DELETE /clips/:id` both now accept either
  a device token or a session cookie through one `deviceOrSessionAuth` preHandler, so the
  website's rename/delete panel on the player page (shown only to the clip's owner, via a
  same-origin `fetch`) calls exactly what the desktop app calls, with exactly the same ownership
  check. Someone not logged in sees a "Log in with Discord" link instead; the panel and the OG
  tags coexist on the one player page.
- **No template engine, no static files.** Every page is still hand-built HTML through
  `lib/html.js`'s shared `layout()`, extended with a dozen more CSS rules (guild header, avatar
  cards, the management panel) rather than adding `@fastify/static` or a build step.

Verified 2026-09-13 against PGlite: 60 backend tests pass (session login and logout, an owner
renaming and a stranger being refused, guild browsing by game and by user, a 404 for an unknown
or reserved slug, a taken slug's 409 and the bot's retry-without-slug), plus 177 bot tests and
19 shared-package tests, none of which touch a network. **Not yet run against production** -
that needs the Discord application's second redirect URI and `SESSION_COOKIE_SECRET` set on
Railway first (see Phase 6, which deploys alongside this), then one `/clips setup` run with a
chosen slug for the existing FAMAFIA guild.

What changed from the plan and why:

- The yearly recap worker (rendering a compilation video, `/clips recap start`) is **not**
  part of this phase any more. It is still a reasonable later feature - the ideas below are
  kept for when it gets picked up - but it stopped being what "phase 5" means for this project.
- `GET /clips` (the JSON API the desktop and `/clips mine`/`top` use) was **not** extended with
  a `?guild=` filter. The site's browse pages need shapes (distinct games, distinct users) that
  do not fit that endpoint's cursor-paginated contract, so they query the database directly in
  `guildSite.js` instead, the same way `player.js` already does.

Later idea, not currently planned: a yearly recap compilation video (`/clips recap start
[year]`, selection rules per guild, an ffmpeg rendering worker, a posted leaderboard embed).
Nothing about the site above blocks building this later; it would sit alongside it as another
page and another bot command.

### Phase 6. Editing in the desktop app. Cutting done 2026-09-11.

The scope was narrowed to cutting, which is what a clipper actually needs: trim the ends,
take out the middle, put it back on the site under the same link.

What exists:

- An editor screen (`editor.ts`, reached from the player's strip, its rail button or `E`)
  with the clip above a timeline: a ruler, a filmstrip drawn from a second decoder, every
  kept part outlined with draggable in and out handles, removed ranges hatched with a "keep"
  button to restore them, and a playhead. Split at the playhead, set in and out, remove a
  part, undo and redo, precise in/out fields, zoom (1 to 12x, Ctrl+wheel), and playback that
  skips the removed ranges so the preview is what the clip will be. Keys are the ones every
  trimmer shares: I, O, S, Delete, [ and ], Ctrl+Z, Ctrl+Enter.
- A cut is a list of kept ranges (`ffmpeg::Segment`) on the clip row (`cut`, schema v4),
  measured against the original recording. Apply puts the row back to `saved`; the worker
  re-encodes both outputs from the recording (one range through `-ss`/`-to`, several through a
  `trim`/`concat` filter graph in the same pass), takes the thumbnail from inside the kept
  footage, records the new length, and re-uploads.
- Non-destructive while the recording is on disk: the editor reopens on the whole recording
  with the cut drawn on it, and Reset undoes it. Once the recording has been dropped by the
  Storage tab, the H.264 copy is the source, the cut is baked in and the editor asks for a
  second click on Apply and says why.
- `POST /clips/:id/replace` on the backend re-signs the three PUT URLs for the same keys, so
  the clip id, the page URL and the Discord post survive. `/complete` no longer pings the bot
  for a replace. The row stays `ready` throughout, since a PUT to an existing key is atomic.

Verified 2026-09-11 in `tauri dev` with uploads off: a 14.65 s desktop recording was split at
5 s and 10 s and the middle removed; the queue re-encoded it with two kept parts and both
outputs probe at 9.63 s (the source keeps its 14.65 s), the card shows 0:10, the editor reopens
with the cut drawn and Apply disabled until something changes. A three-part cut on a generated
sample, with and without an audio stream, is in `cargo test ffmpeg::tests::end_to_end`; the
replace route has a backend test; the re-encode request has a queue test.

What changed from the plan and why:

- The replace path was **not** exercised against production: the backend has to be deployed
  with the new route first, and the desktop deliberately fails (and retries) rather than
  creating a second clip when it meets a backend without it.
- Discord caches an embed on first crawl, so a replaced video shows up in the existing
  post's inline player only when Discord's media proxy refetches it; an attachment post keeps
  the old file. The link is right either way. Re-posting is a bot change for later.
- Not done: "save as a new clip" (two highlights out of one buffer). The source path is unique
  per row, so it needs a copy or a hard link of the recording and a decision about how the
  Storage tab counts it.
- Later ideas, still not planned: overlays, slow motion, audio ducking.

### Desktop auto-update. Done 2026-09-13.

Not in the original plan. Before this, a new build only reached a player if they noticed the
GitHub release and reinstalled by hand; every clipper on an older build would silently miss
whatever the next one fixed.

- `tauri-plugin-updater` polls `https://github.com/GrandThed/Cos-Nostra/releases/latest/download/latest.json`
  (`plugins.updater` in `tauri.conf.json`) and checks the signature against a minisign keypair
  generated for this: the public half lives in `tauri.conf.json`, the private half is the
  `TAURI_SIGNING_PRIVATE_KEY` / `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` GitHub secrets that
  `desktop-release.yml` feeds to `tauri-action`, which is what makes it sign the NSIS installer
  and produce `latest.json` on every tagged build. Nothing but that pipeline can produce an
  update this app will install.
- `src/updater.ts` checks once at startup and every six hours (this is a tray app, often left
  running for days) and drives download/install through the plugin; `shell.ts` reads its state
  the same way it reads `Status` for the existing alarm banners, so "update available" and
  "restart to finish" show up next to the recorder-failed and hotkey-taken banners rather than
  as a separate UI. A restart is a `tauri-plugin-process` `relaunch()`, the same shape the OBS
  bootstrap already uses to restart into a freshly downloaded runtime.
- The release workflow had to stop drafting releases (`releaseDraft: false`): GitHub's
  `/releases/latest` endpoint, which the updater's URL relies on, does not see draft or
  prerelease releases. There is now no manual review step between a tag push and every desktop
  install offering that build.
- The binary itself is still unsigned (SmartScreen still warns on a fresh install); this only
  signs the *update payload* so the app can trust it came from this pipeline, which is a
  separate, cheaper guarantee than an EV code-signing certificate.

### Discord bot: manage menu, mentions and voice auto-tag. Done 2026-09-13.

Not in the original plan. A posted clip named its owner in plain text (no notification) and
could only be deleted or hidden from the desktop app; managing a clip from Discord meant
leaving Discord. Four additions, built together since they all touch `post.js` and
`guild_settings`:

- **Real `@mentions`.** The owner, and everyone who was in the owner's voice channel at the
  moment they pressed the hotkey, are now pinged. `allowedMentions` on every post is an
  explicit id allow-list (`{ parse: [], users: [...] }`) rather than the old blanket
  `parse: []`, so a clip's free-text title or game still cannot ping anyone outside that list
  even if it contains raw `<@id>` syntax - the allow-list is what actually gates a notification,
  not what appears in the message content.
- **Voice auto-tag is a capture-time snapshot, not a post-time lookup.** Encoding and upload
  can take minutes after a game closes, so who is in voice by the time a clip posts is not who
  was there when it was recorded. The desktop asks `POST /discord/voice-snapshot` (device
  token; resolves the caller's own Discord id server-side, so a device cannot ask about anyone
  else) on a background thread immediately after the hotkey saves, before encoding even starts,
  and writes the answer onto the local queue row (`clips.db` schema v5, new nullable
  `participants` column) so it survives however long the clip sits in the queue. The backend
  proxies the question to the bot's own `POST /voice-snapshot`, which reads `channelId` off
  `guild.voiceStates.cache` - deliberately without the `GuildMembers` intent, since a raw
  `<@id>` mention resolves client-side with no cached member needed, so this cost no privileged
  intent. Every failure on this path (bot unreachable, user not in voice, timeout) resolves to
  an empty participant list rather than an error; a clip must never fail to save over a Discord
  lookup. A guild can turn this off (`guild_settings.tag_voice_members`, default on) without
  losing the owner mention.
- **A private manage menu on every post.** A `⚙️ Manage` button sits on every clip message.
  Clicking it is an ephemeral reply visible only to the clicker - Discord's own mechanism, nothing
  custom - so the public post carries no indication of who has access or what they saw. The
  owner or anyone with Manage Server gets a real panel (Hide / Delete, re-checked on every
  click rather than trusted from the opening click); anyone else gets a private "not yours"
  reply. Hide deletes the Discord message only - the clip stays fully live on the player page,
  in rankings and in `/clips top|latest|mine`. Delete is delete-everywhere, the same operation
  the desktop's own "Delete everywhere" performs, reached through a new bot-authenticated
  `DELETE /internal/clips/:id` (the device-authed `DELETE /clips/:id` a user's own token allows
  cannot be used here, since a moderator managing someone else's clip has no token for it); both
  routes now share one `purgeClip()` helper instead of duplicating the storage-then-row-status
  sequence.
- **`/clips config`.** Seed emojis and the voice-tag toggle, gated on Manage Guild at runtime
  like `/clips setup`. Calling it with no options echoes the guild's current settings rather
  than performing a no-op write.

What changed from how this was scoped:

- Considered logging voice-state history so a post-time lookup could reconstruct who was
  present at an arbitrary past instant, rejected for a capture-time snapshot instead: the
  desktop already knows the instant that matters, so asking then and carrying the answer
  through the queue needed no new table, no retention question and no clock-skew reasoning.
- `manageRow()`'s button label is fixed and locale-neutral (Discord does not localize a
  component label per viewer the way an ephemeral reply's text can be); everything the panel
  says after a click goes through the same `t(locale, ...)` / `localeForGuild()` path as every
  other reply.

Verified: 173 bot tests, 60 backend tests, 19 `packages/shared` tests and 107 desktop
`cargo test`s (`cargo check` clean) all green, covering the authorization branches (owner /
Manage Guild / neither), the allow-list mention behavior, `set_participants`'s round trip, the
v4→v5 migration, and every new route's auth and error paths - none of it touching a gateway or
a real Discord API call.

Not verified, and what would:

- Whether a message's `components` (the manage button) suppress Discord's own `type=video`
  link unfurl the way `embeds[]` does - `post.js` was already changed once for exactly that
  reason (see Phase 4 above) and this adds a *different* message field, which should be
  independent of it, but that has not been checked against a real channel. Post one clip and
  read it back with `GET /channels/:id/messages/:id`, same method the discord-bot skill already
  documents, and confirm `embeds[].type` is still `video` with `components[]` also present.
- The whole hotkey-to-mention loop end to end: press the hotkey while actually sitting in a
  real Discord voice channel with a second account, and confirm both accounts are pinged on
  the eventual post.
- `/clips config` is a new subcommand and is not live in any guild until
  `npm run deploy-commands -w apps/bot` is run again - registration is a separate step from
  deploying, same as every other command change.

### Publish on demand. Built 2026-09-13, not yet deployed or run in the app.

Not in the original plan. Every hotkey clip used to encode, upload and post itself to every
configured server. In practice a player wants a piece of what they saved, and a match recording
is mostly used for the moment they forgot to clip, so the product now centers on the act of
publishing one chosen clip rather than on uploading everything.

The shape, and why:

- **Clips are local until published.** The hotkey still saves the replay buffer as its own file
  (it can be watched at once, survives the match being deleted, and works in games that are not
  recorded). `clips.db` schema v6 adds `publish`, and the queue only encodes or uploads rows
  where it is 1. The `auto_upload` setting is gone. Encoding waits for Publish because almost
  every clip is trimmed first, and encoding before the trim was wasted work.
- **A clip knows where it is on its match.** `captured_at` is the wall-clock time of the clip
  recording's first frame (taken just before `Recorder::save()`, minus the probed length), and
  a match file already stores `file_start_at`, so `placement.rs` finds the overlap by
  subtraction, like match events. The Matches timeline draws clips as ranges; the Library has
  "Show in match". `clips.db` and `sessions.db` stay separate; the join is in Rust.
- **The editor is one range on the match.** Split and remove-part are gone. Dragging past the
  saved footage copies that span (plus 3 s) out of the match into a new recording for the clip,
  so a clip is always self-contained. Publishing is once per clip: re-editing a published clip
  replaces it under the same link, as before.
- **Publish is a dialog.** Title, game, and the servers to post in, from `GET /discord/guilds`:
  guilds with a clip channel where the bot confirms the user is a member (`POST
  /member-guilds` on the bot, a REST member fetch, no privileged intent). None ticked means a
  web page only. The choice travels as `guildIds` on `POST /clips` and is stored as
  `clips.target_guilds`; `null` is the legacy "every configured guild" path that keeps desktop
  builds from before this working. The bot re-checks membership at post time and skips any
  guild that already has a live post of the clip, so retries and "post to more servers" (`POST
  /clips/:id/posts`) never double-post.
- **Posts can be taken down, and that is recorded.** `posts.removed_at` marks a post whose
  message is gone: Hide in the Discord manage menu (`DELETE /internal/posts/:messageId`), and
  every purge. `purgeClip` now also tells the bot to delete the clip's live messages (`POST
  /unpost`), so deleting a clip from the desktop, the site or Discord removes all of its posts.
  Rankings and the guild site keep counting hidden posts, as Hide promised.
- **Unpublish** is `DELETE /clips/:id` while keeping the local files; publishing again makes a
  new clip and link, since the old objects are gone. It is refused for a clip whose local video
  the Storage tab released, because the site copy would be the last one.
- **Clip cards** carry a status circle (local, working with a progress ring, published, failed)
  and a stack of server icons from `GET /me/posts`, cached on the row as `posts` and refreshed at
  startup, after uploads, after posting more, and every five minutes.

Rollout: deploy the backend (migration `0005`) and the bot together, then ship the desktop.
Until the new bot is live, `GET /discord/guilds` answers 503, and unpublishing or deleting a clip
leaves its Discord messages up. Never
run an older desktop build against a migrated `clips.db`: it would upload every local clip (see
`CLAUDE.md`).

Verified 2026-09-13 without running the app: 73 backend tests on PGlite (migration 0005 also
applied to a copy of the dev database), 195 bot tests, 26 `packages/shared` tests, 122 desktop
`cargo test`s (1 ignored) including real-ffmpeg Apply cases inside and past the saved footage,
`tsc --noEmit` and `vite build`.

Not verified, and what would:

- The UI itself: the dialog, circles, progress rings and clip ranges in both themes. Run `tauri
  dev` with Backend URL on `http://localhost:3000`.
- `captured_at` against a real replay-buffer save: clip once during a recorded match and check
  that its range on the timeline shows the same moment as the clip.
- Membership filtering against real Discord, and a real publish: the backend and bot have to be
  deployed first.
- The editor's scrolling and filmstrip on a long match file.

### Game folders and game art. Built 2026-09-14, not yet run in the app.

Not in the original plan. Desktop only; no backend, bot or wire change.

- **Per-game folders.** New clips go to `<clip folder>\<Game>\Clips`, undetected ones to
  `Unknown game\Clips`, new session recordings and their match files to `<Game>\Matches`
  (`folders.rs`). Existing files were deliberately not migrated: rows hold absolute paths, so
  nothing breaks, and moving a whole library at startup is risk with no payoff. Renaming a game
  or changing a clip's game moves the clips already inside the old name's folder, all of a
  clip's files or none (`storage::relocate`, `Queue::relocate`).
- **Game pictures.** Resolved on the player's machine and cached under `%APPDATA%`, never
  bundled (publisher art does not belong in a GPL repo) and never sent to the backend. Steam
  games are identified from the exe path and Steam's own manifests, with their art usually
  already on disk in Steam's library cache; everything else (Riot, Epic, Battle.net, Xbox,
  standalone launchers) through Discord's detectable-games list, which is undocumented and so
  cached, refreshed weekly and optional. Last resort is the exe's own icon, then a letter tile.
  SteamGridDB or IGDB would cover more portrait art but need an API key, which would mean a
  backend proxy; not needed yet.
- The user can replace a picture from the game header; that choice is never overwritten.

Verified without running the app: 142 of 143 desktop `cargo test`s (the flaky
`max_attempts_then_manual_retry` timing test fails under load and passes alone), including new
tests for folder naming, moving with rollback when a file is held open, Steam manifest and
Discord matching, and the art index's rename and retry rules; the `#[ignore]`d network tests
against the live Discord and Steam endpoints; `tsc` and `vite build`.

Not verified: the tiles and header in both themes, a real hotkey clip landing in its game
folder (and the move not racing libobs), pictures for Valorant, League and a Steam game in the
running app, rename moving files while the player has the clip open.

### Steam recording parity: audio, markers, background recording, export. Released in desktop 0.3.0 on 2026-09-15.

Not in the original plan. A comparison with Steam Game Recording turned up what it does that
this app did not; these are the ones picked, in the order they were built. Desktop only; no
backend, bot or wire change.

- **Microphone and audio sources.** Settings has an Audio card: record everything the default
  output plays (as before, the default), only the hooked game (the game capture's own
  application audio), or the game plus chosen apps (one `wasapi_process_output_capture` per
  executable, matched by the exe of a window). The microphone is optional, with device,
  volume, mono downmix and RNNoise. With it on every recording carries three AAC tracks: the
  mix, the mix without the mic, the mic alone (`capture::TRACK_*`, each source routed with
  `obs_source_set_audio_mixers`, one audio encoder per track shared by the session output). The
  player plays the mix; publish and export offer to leave the voice out, which encodes the
  second track. `clips.db` v7 adds `include_mic`; a clip already encoded with the other choice
  encodes again when published.
- **Marker hotkey.** `Alt+F11` by default drops `timeline::Event::Marker` on the session being
  recorded, with a sound unlike a save's, or a toast when nothing is recording. A marker shows on
  every match file that holds its moment (`SessionStore::events`), and its row selects the 25 s
  before it.
- **Background recording of any game.** Off by default (`record_other_games`). Whatever the
  capture hooks that the game table does not reject opens a `SessionGame::Other` session, which
  lasts while that process runs. The recording splits every 15 minutes without a gap through
  `mp4_output`'s own file splitting; OBS names the next file and says so with `file_changed`,
  which `capture.rs` catches with a raw signal handler. Parts are chained in `sessions.db` v3
  (`recordings.follows`), so the cutter times each from the stop of the last. With no provider
  every part becomes its own undetected match, renamed rather than copied, titled by its start
  time. `storage::enforce_other_games_footage` keeps the newest `other_games_hours` (default 2)
  of that footage, counted in footage rather than clock time, after every part and every cut.
  A supported game starting ends the background session so it gets its own.
- **Export.** A clip exports to a file chosen in a save dialog: as recorded (stream copy from the
  keyframe before the clip), at most N MB (Discord's 10, 50 and 500 as presets; the bitrate is
  planned from the length, the picture drops to 720p, then 30 fps, then smaller until the bitrate
  can draw it, and a result over the target is encoded once more at a proportionally lower
  bitrate), or custom codec, resolution, frame rate and quality level. H.264 and AV1 follow the
  encode engine setting; H.265 is hardware only and probed on first use. Settings also gained a
  recording resolution cap (the libobs output size), a frame rate picker and recording quality
  presets over the buffer bitrate, and the buffer's memory cap now grows with the bitrate so a
  high preset does not quietly shorten it.

Verified 2026-09-15: 164 desktop `cargo test`s (new ones for track selection and a real
three-track encode, the mic publish choice, marker placement across match files, split parts
timed from the last stop against real ffmpeg, the footage budget, other-game sessions and a
supported game taking over, size planning and every export mode against real ffmpeg), `tsc`,
`vite build`, clippy with no new warnings. In `tauri dev` on the RX 9060 XT with the mic on and
"game and apps" (Discord): the game audio child source, Discord's process capture, the mic with
noise suppression and three AAC encoders all came up; a hotkey clip had three tracks with the
game's tone on tracks 1 and 2 and the room on track 3. A fullscreen ffplay opened an `other`
session whose recording split eleven times (with the part length set to 40 s for the test),
the parts met with 0 ms gaps in `sessions.db`, the marker landed on the right part in the
Matches tab, and a 10 MB export of a 29 s 1080p60 clip came out 720p30, one audio track,
9.2 MB, through the real save dialog.

Not verified, and what would:

- A real game's audio through "only the game", and an anti-cheat game's process capture.
- A full 15-minute part and the footage budget deleting a part during a live session; the unit
  tests cover the rule, the 40 s run covered the splitting.
- H.265 export: the dev sidecar is the minimal build from before `hevc_*` were added. Rebuild it
  (`npm run build-ffmpeg -w apps/desktop`) and export once.
- The publish dialog's microphone box against a real publish.

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
