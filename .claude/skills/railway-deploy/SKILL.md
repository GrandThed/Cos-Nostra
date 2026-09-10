---
name: railway-deploy
description: How the Cos Nostra backend and Discord bot are deployed to Railway from the GitHub monorepo (Dockerfile per service via RAILWAY_DOCKERFILE_PATH, all other settings in the dashboard), which environment variables each service and the Discord application need, how migrations run, and how to read a failed deploy. Use when adding a service, changing env vars, debugging a failed deploy, or setting up Railway for the first time.
---

# Railway deployment

One Railway project, deployed from the GitHub repo `GrandThed/Cos-Nostra` (branch `main`), holding:

| Service | Kind | Purpose |
|---|---|---|
| backend | Docker, from `apps/backend/Dockerfile` | Fastify API and player page, public at `https://cosnostra.benja.ar` |
| bot | Docker, from `apps/bot/Dockerfile` | discord.js bot, private network only |
| Postgres | Railway database | attached to the backend through `DATABASE_URL` |
| Bucket | Railway Storage Bucket (S3 API, no public read) | clip objects, reached only through presigned URLs |

Video never goes through Railway compute: the desktop app uploads to the bucket through presigned URLs and the backend redirects players to presigned GETs.

**Service names are not guaranteed.** Railway generates names like `adventurous-fascination` and renaming is not always available in the UI. Never assume a service is called `backend`, `Postgres` or `Bucket` — read the real name off the service's Variables or Networking panel before writing a `${{...}}` reference. This matters more than it looks; see "The empty-string trap" below.

There is no Railway CLI on the dev machine. Everything below happens in the dashboard or through `git push`.

## Config as Code is dead — use RAILWAY_DOCKERFILE_PATH

`apps/backend/railway.json` and `apps/bot/railway.json` are still in the repo but **Railway no longer reads them**. Config as Code was deprecated: existing files keep working until 2026-12-01, and since 2026-08-28 a service that has never used it cannot opt in. Any service created after that date shows a dead "Add File Path" button that will not save. The files are kept only because `railway config migrate` can convert them if the project ever moves to Infrastructure as Code (`.railway/railway.ts`, applied with the Railway CLI or the `railwayapp/config` GitHub Action — not on git push).

So each service is configured two ways:

**1. The builder, through a service variable.** Railway auto-detects with Railpack, which cannot handle a workspace root (it finds no `start` script in the root `package.json` and fails with "No start command detected"). Point it at the Dockerfile instead:

```
RAILWAY_DOCKERFILE_PATH = apps/backend/Dockerfile     # backend service
RAILWAY_DOCKERFILE_PATH = apps/bot/Dockerfile         # bot service
```

Root directory stays `/` on both. The Dockerfiles need the repo root as build context because the npm lockfile lives there.

**2. Everything else, by hand in Settings → Deploy.**

| Setting | backend | bot |
|---|---|---|
| Custom Start Command | `npm start -w apps/backend` | `npm start -w apps/bot` |
| Pre-deploy step | `npm run migrate -w apps/backend` | none, never run migrations from the bot |
| Healthcheck Path | `/health` | `/health` (phase 4; empty before that) |
| Restart Policy | On Failure, max 5 | On Failure, max 5 |

The start command duplicates the Dockerfile `CMD` and can be left blank. The pre-deploy step is the collapsed `+ Add pre-deploy step` link directly under Custom Start Command, easy to miss.

This changed in phase 4: the bot now serves `GET /health` and `POST /post` on `BOT_PORT`, so it takes a healthcheck like the backend. Set the bot's Healthcheck Path to `/health` **and give it a target port of `BOT_PORT`**, because the bot does not read Railway's injected `PORT`. Before phase 4 a healthcheck failed every bot deploy, since nothing answered.

## Why Dockerfiles with the repo root as context

The npm lockfile lives at the repo root (npm workspaces). A service whose root directory is `apps/backend` cannot see it, so no auto-detected builder can do a reproducible install. Each Dockerfile copies the root manifests, runs `npm ci --workspace apps/<name> --include-workspace-root=false --omit=dev`, then copies `packages/shared` and the app. `.dockerignore` at the root keeps `apps/desktop`, `target/`, `node_modules/` and `.env` out of the context.

## Discord application

One application at discord.com/developers/applications provides both the OAuth client and the bot.

- **OAuth2 → Redirects**: add `https://cosnostra.benja.ar/auth/discord/callback` exactly, no trailing slash. Add `http://localhost:3000/auth/discord/callback` as well to complete login against a local backend. `config.PUBLIC_URL` strips trailing slashes, so the value registered here must match `PUBLIC_URL + /auth/discord/callback`.
- **OAuth2 → General**: client id → `DISCORD_CLIENT_ID` (both services), client secret → `DISCORD_CLIENT_SECRET` (backend only).
- **Bot → Token**: Reset Token, shown once → `DISCORD_TOKEN` (bot service only).
- **Bot → Privileged Gateway Intents**: leave all off. The bot requests `Guilds`, `GuildMessages`, `GuildMessageReactions`, none of which are privileged. Message Content is only needed if a later phase reads message text.
- **Install link**: scopes `bot` + `applications.commands`; permissions View Channels, Send Messages, Embed Links, Attach Files, Add Reactions, Read Message History. Those six add up to **117824**, so the link is:

  ```
  https://discord.com/oauth2/authorize?client_id=<DISCORD_CLIENT_ID>&scope=bot%20applications.commands&permissions=117824
  ```

  **A bot that was never invited anywhere fails command registration with `Missing Access` (code 50001)**, which reads like a permissions bug but is not one. Check with `GET https://discord.com/api/v10/users/@me/guilds` and a `Bot <token>` header: an empty array means it is in no guild, and no amount of permission fiddling will help until someone opens the install link. Guild-scoped registration also needs the guild id to be one the bot is actually in, so confirm it against that listing rather than trusting `DISCORD_DEV_GUILD_ID`.

## Environment variables

Set these in each service's Variables tab. `${{Service.VAR}}` is Railway's reference syntax — **use the `${{` autocomplete rather than typing service names**, because a name that does not match resolves to an empty string.

Backend (`apps/backend/src/config.js` validates all of these at startup):

```
RAILWAY_DOCKERFILE_PATH  apps/backend/Dockerfile
PUBLIC_URL               https://cosnostra.benja.ar
DATABASE_URL             ${{<postgres service>.DATABASE_URL}}   private URL, not DATABASE_PUBLIC_URL
JWT_SECRET               random, at least 16 chars (use 32 bytes hex)
BOT_SHARED_SECRET        random, at least 16 chars; identical on the bot
DISCORD_CLIENT_ID        from the Discord application
DISCORD_CLIENT_SECRET    from the Discord application
S3_ENDPOINT              ${{<bucket service>.ENDPOINT}}
S3_REGION                ${{<bucket service>.REGION}}
S3_BUCKET                ${{<bucket service>.BUCKET}}
S3_ACCESS_KEY_ID         ${{<bucket service>.ACCESS_KEY_ID}}
S3_SECRET_ACCESS_KEY     ${{<bucket service>.SECRET_ACCESS_KEY}}
S3_URL_STYLE             virtual   (path only for older buckets that reject virtual-host URLs)
LOG_LEVEL                info
BOT_INTERNAL_URL         http://<bot internal hostname>:3001   (leave unset until phase 4)
DISCORD_API_BASE         optional, defaults to https://discord.com/api
```

`PORT` is injected by Railway (8080 in practice) and the app binds `0.0.0.0:$PORT`. **Do not set `PORT` on the backend** — a hardcoded value breaks the healthcheck. `NODE_ENV` comes from the Dockerfile.

Generate the two secrets with:

```
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

Bot:

```
RAILWAY_DOCKERFILE_PATH  apps/bot/Dockerfile
DISCORD_TOKEN            bot token from the Discord application
DISCORD_CLIENT_ID        same application
BOT_SHARED_SECRET        identical string to the backend's, byte for byte
BACKEND_URL              http://<backend internal hostname>:<backend $PORT>
BOT_PORT                 3001   (phase 4, internal HTTP server for /post and /health)
```

Only `DISCORD_TOKEN` is read today; the rest are staged for phase 4. The bot validates nothing, so a missing token surfaces as a discord.js `TokenInvalid` rather than a named error.

Note `BOT_PORT`, not `PORT`: the repo-root `.env` is shared by both apps and `PORT=3000` is already the backend's.

**The port in `BACKEND_URL` is not 3000 in production.** `apps/backend/src/index.js` binds `config.PORT`, and on Railway that is the injected `PORT` (8080 in practice), not the 3000 from `.env.example` or the Dockerfile `EXPOSE`. Private networking does no port mapping, so the bot must dial the port the backend actually listened on. Read it off the backend deploy log line `Server listening at http://0.0.0.0:<port>` and use that number. Locally it really is 3000.

## The empty-string trap

A `${{...}}` reference whose service name does not exist resolves to an **empty string**, not an error. Two different failures follow:

- `DATABASE_URL` empty → the pre-deploy step dies with `invalid environment: DATABASE_URL: Too small: expected string to have >=1 characters`. Loud, and the deploy is aborted. Note the wording: `Too small` means the variable exists and is empty (a broken reference); `expected string, received undefined` would mean it is not set at all.
- Any `S3_*` empty → `loadConfig` sets `storage = null` and the app **boots normally**. Clip uploads answer 503 forever, with nothing in the logs beyond one warning at startup.

The Variables tab renders resolved references; anything showing blank is a broken name.

## Networking

- Backend: Generate Domain, then Custom Domain `cosnostra.benja.ar` with the CNAME Railway shows, at the DNS provider for `benja.ar`. Wait for the certificate.
- Bot: no public domain, no TCP proxy, static IPs off, outbound IPv6 off. It only makes an outbound WebSocket to Discord's gateway. Railway may warn that no port was detected; that is expected for a worker and harmless as long as no healthcheck is set.
- Private networking is dual-stack (`IPv4 & IPv6`) and on by default. Binding `::` covers both and is the safer default for the phase 4 bot server, but `0.0.0.0` also works.
- Backend and bot talk over `*.railway.internal`. Only the backend gets a public domain.

## Migrations

Drizzle SQL migrations are committed under `apps/backend/drizzle/` (generate with `npm run generate -w apps/backend`). The backend's pre-deploy step runs `npm run migrate -w apps/backend` in the freshly built image before the new container starts; if it fails the deploy is aborted and the previous version keeps running. `buildApp` also applies migrations at startup (`app.js`, `opts.migrate` defaults true), so the schema is created either way and a manual redeploy is safe — the pre-deploy step only buys a cleaner failure mode. Never run migrations from the bot.

## First-time setup checklist

1. **Discord application**: as above. Note client id, client secret, bot token.
2. **Railway project**: New Project → Deploy from GitHub repo → `GrandThed/Cos-Nostra`. Rename the created service to `backend` if the UI allows it.
3. **backend → Variables**: `RAILWAY_DOCKERFILE_PATH` first, then the full backend list. **Push your commits before deploying** — Railway builds whatever is on `origin/main`, and a build that fails with the Railpack banner on a commit you thought was fixed usually means unpushed work (`git status -sb` shows `ahead N`).
4. **backend → Settings**: root directory `/`, branch `main`, start command, pre-deploy step, healthcheck `/health`.
5. **Postgres**: + New → Database → PostgreSQL. Note the real service name.
6. **Bucket**: + New → Storage Bucket. Note the real service name. Its Variables tab shows `ENDPOINT`, `REGION`, `BUCKET`, `ACCESS_KEY_ID`, `SECRET_ACCESS_KEY`.
7. **Deploy the backend** and read the logs in order: Dockerfile stages → pre-deploy `migrations applied (pg)` → `object storage ready` → `Server listening at http://0.0.0.0:8080`. Then `https://cosnostra.benja.ar/health` answers `{"ok":true,"driver":"pg"}`.
8. **bot service**: + New → GitHub Repo → same repo. Root directory `/`, its own `RAILWAY_DOCKERFILE_PATH`, the bot variables, start command, **no healthcheck**, no domain. Success looks like `Logged in as <name>` in the deploy log.
9. **Phase 4**: add `BOT_PORT=3001` and the bot's `/health` healthcheck, and set `BOT_INTERNAL_URL` on the backend to `http://<bot internal hostname>:3001`. Until that variable is set the backend logs `BOT_INTERNAL_URL unset, not notifying bot` and clips upload without ever reaching Discord; the bot's `POST /post` can still be driven by hand to test the rest.
10. **Register the slash commands**: `npm run deploy-commands -w apps/bot`, which registers to `DISCORD_DEV_GUILD_ID` when set (instant) and globally otherwise (up to an hour). It is a separate step from deploying, and it must be re-run whenever a command's name, options or description change.

Watch paths used to come from `railway.json`; without it every push to `main` redeploys both services, including desktop-only commits. Set Watch Paths by hand in Settings if that becomes annoying: `apps/backend/**`, `packages/shared/**`, `package.json`, `package-lock.json` (and the `apps/bot/**` equivalent).

## Local parity

The repo-root `.env.example` is the single reference for every variable. Copy it to `.env`; both Node apps load it through `node --env-file-if-exists=../../.env`. Locally use `DATABASE_URL=pglite://./data/dev` instead of Postgres and leave the `S3_*` variables empty (upload routes answer 503). `RUST_LOG` and `GITHUB_TOKEN` in `.env.example` are shell-only — nothing loads the root `.env` into the desktop app. Never point a local `.env` at the production database.

## Checking a deploy

- Logs: service → Deployments → the deployment → Build / Deploy tabs. The pre-deploy output appears at the top of the Deploy log, before `Starting Container`. The backend logs pino JSON; paste through `npx pino-pretty` locally if needed.
- Startup lines worth grepping: `migrations applied (pg)`, `object storage ready` (or `S3_* not configured: upload and media routes will answer 503`, from `plugins/storage.js`), `Server listening at`.
- **Build log shows the Railpack banner and "No start command detected"**: the service is not using the Dockerfile. Either `RAILWAY_DOCKERFILE_PATH` is unset, or the deployed commit predates the Dockerfile — check `git status -sb` for unpushed commits.
- Build fails at `npm ci`: the lockfile is out of sync with a `package.json`. Run `npm install` at the root, commit `package-lock.json`.
- Build fails at `COPY packages/shared/package.json`: the service root directory drifted from `/`.
- Deploy crashes with `invalid environment:` and a list of variables: add them, or fix a broken `${{...}}` reference. See "The empty-string trap".
- Pre-deploy fails: usually `DATABASE_URL` empty or pointing at the public proxy without TLS, or a migration conflict. Fix migrations locally against PGlite (`npm test -w apps/backend`) before pushing again.
- Healthcheck never passes: the app must bind `0.0.0.0:$PORT`; never hardcode a port in the variables. On the bot, the cause is a healthcheck path set on a service that serves no HTTP.
- Uploads answer 503 on a healthy backend: a broken `${{<bucket>.*}}` reference. Check the startup log line.
- Discord login loops or errors: the redirect URI in the Discord portal must be exactly `PUBLIC_URL + /auth/discord/callback`, no trailing slash.

## Smoke-testing the deployed API

No Railway CLI here, so the deploy is checked from outside with curl. This sequence is what
closed phase 3 on 2026-09-10; it exercises every moving part in order.

```bash
curl -s https://cosnostra.benja.ar/health                 # {"ok":true,"driver":"pg"}
curl -s https://cosnostra.benja.ar/                       # recent-clips page, 200 text/html
curl -s -X POST https://cosnostra.benja.ar/auth/device \
  -H 'content-type: application/json' -d '{"deviceName":"probe"}'
```

Open the `verifyUrl` it returns in a browser that has a Discord session, then poll
`GET /auth/device/<code>`. It answers `{"status":"pending"}` until the callback lands and then
hands the token out exactly once. **If Discord has already authorized this application for that
account, the whole OAuth leg completes with no clicks** — the browser round trip is invisible,
which makes the flow scriptable.

With the token:

```bash
curl -s -H "Authorization: Bearer $TOKEN" https://cosnostra.benja.ar/auth/me
curl -s -X POST https://cosnostra.benja.ar/clips -H "Authorization: Bearer $TOKEN" \
  -H 'content-type: application/json' \
  -d '{"durationMs":1000,"recordedAt":"2026-09-10T20:00:00Z","sizeAv1":0,"sizeH264":0}'
```

`201` with three presigned URLs means the `S3_*` references resolved. `503 storage_unavailable`
means one of them is empty — see "The empty-string trap". Then PUT a real file to the `thumb`
URL and check the media redirect:

```bash
curl -s -o /dev/null -w '%{http_code} -> %{redirect_url}\n' https://cosnostra.benja.ar/clips/<id>/av1
curl -sL -o /dev/null -w '%{http_code} %{content_type} %{size_download}\n' https://cosnostra.benja.ar/clips/<id>/av1
```

Clean up afterwards: `DELETE /clips/<id>` removes all three objects and flips the row to
`deleted`, and `DELETE /auth/device` revokes the probe token (a revoked token then answers 401).

**The presigned PUT carries a checksum of an empty body.** `@aws-sdk/client-s3` v3 signs
`x-amz-checksum-crc32=AAAAAA==` (CRC32 of zero bytes) into every presigned PutObject URL.
Railway's bucket ignores it, so uploading a real body succeeds — verified with a 50 KB JPEG and
with 38 MB and 20 MB videos. A provider that *enforces* it would reject every upload with a
checksum mismatch; the fix then is to turn the SDK's default checksum off when presigning, not
to change the desktop client.

## Verifying the player page like a phone

Edge is the only Chromium on the dev machine. Headless with the DevTools protocol proves both
layout and playback, which a screenshot alone does not:

```powershell
& "C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe" --headless=new --disable-gpu `
  --autoplay-policy=no-user-gesture-required --remote-debugging-port=9222 `
  --user-data-dir="$env:TEMP\edgecdp" about:blank
```

Then drive it from Node (Node 24 has a global `WebSocket`, so CDP needs no dependency):
`Emulation.setDeviceMetricsOverride` to 390x844 mobile, navigate, and `Runtime.evaluate` to read
`documentElement.scrollWidth` against `clientWidth` for horizontal overflow and to call
`video.play()` and check `currentTime` advanced. On 2026-09-10 the player page reported no
overflow at 390x844 or 1280x900, and the AV1 source played (`readyState` 4, 77 frames decoded in
1.5 s). iOS Safari is still untested — there is no Apple device here.
