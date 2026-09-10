---
name: railway-deploy
description: How the Cos Nostra backend and Discord bot are deployed to Railway from the GitHub monorepo (Dockerfile + config-as-code per service), which environment variables each service needs including the Storage Bucket references, how migrations run, and how to check logs. Use when adding a service, changing env vars, debugging a failed deploy, or setting up Railway for the first time.
---

# Railway deployment

One Railway project, deployed from the GitHub repo `GrandThed/Cos-Nostra` (branch `main`), holding:

| Service | Kind | Purpose |
|---|---|---|
| `backend` | Docker, from `apps/backend/Dockerfile` | Fastify API and player page, public at `https://cosnostra.benja.ar` |
| `bot` | Docker, from `apps/bot/Dockerfile` | discord.js bot, private network only |
| `Postgres` | Railway database | attached to the backend through `DATABASE_URL` |
| `Bucket` | Railway Storage Bucket (S3 API, no public read) | clip objects; credentials exposed as reference variables |

Video never goes through Railway compute: the desktop app uploads to the bucket through presigned URLs and the backend redirects players to presigned GETs.

There is no Railway CLI on the dev machine. Everything below happens in the dashboard or through git push.

## Why Dockerfiles with the repo root as context

The npm lockfile lives at the repo root (npm workspaces). A service whose root directory is `apps/backend` cannot see it, so Nixpacks/Railpack cannot do a reproducible install. Instead every service keeps **root directory `/`** and builds with its own Dockerfile, which copies the root manifests, runs `npm ci --workspace apps/<name> --include-workspace-root=false --omit=dev`, then copies `packages/shared` and the app. `.dockerignore` at the root keeps `apps/desktop`, `target/`, `node_modules/` and `.env` out of the context.

Per-service settings are config-as-code (`$schema: https://railway.com/railway.schema.json`):

| File | builder | dockerfilePath | preDeployCommand | healthcheckPath | watchPatterns |
|---|---|---|---|---|---|
| `apps/backend/railway.json` | DOCKERFILE | `apps/backend/Dockerfile` | `npm run migrate -w apps/backend` | `/health` | `apps/backend/**`, `packages/shared/**`, root `package.json`, `package-lock.json` |
| `apps/bot/railway.json` | DOCKERFILE | `apps/bot/Dockerfile` | none | none until phase 4 | `apps/bot/**`, `packages/shared/**`, root manifests |

Both set `restartPolicyType: ON_FAILURE` and `startCommand: npm start -w apps/<name>` (same as the Dockerfile CMD). Railway only auto-detects `railway.json` at the root directory, so each service must be pointed at its file (Settings -> Config-as-code -> file path). Values in the config file override the dashboard for the same field.

The bot config has no healthcheck yet. Add `"healthcheckPath": "/health"` to `apps/bot/railway.json` in phase 4, once the bot serves its internal HTTP server on `PORT`.

## Environment variables

Set these in each service's Variables tab. `${{Service.VAR}}` is Railway's reference syntax; replace `Bucket` and `Postgres` with the exact names of those services in the project.

Backend (`apps/backend/src/config.js` validates all of these at startup):

```
PUBLIC_URL              https://cosnostra.benja.ar
DATABASE_URL            ${{Postgres.DATABASE_URL}}   (private network, no TLS needed)
JWT_SECRET              random, at least 16 chars (use 32+)
BOT_SHARED_SECRET       random, at least 16 chars; identical on the bot
DISCORD_CLIENT_ID       from the Discord application
DISCORD_CLIENT_SECRET   from the Discord application
BOT_INTERNAL_URL        http://bot.railway.internal:3001   (leave unset until phase 4)
S3_ENDPOINT             ${{Bucket.ENDPOINT}}
S3_REGION               ${{Bucket.REGION}}
S3_BUCKET               ${{Bucket.BUCKET}}
S3_ACCESS_KEY_ID        ${{Bucket.ACCESS_KEY_ID}}
S3_SECRET_ACCESS_KEY    ${{Bucket.SECRET_ACCESS_KEY}}
S3_URL_STYLE            virtual   (path only for older buckets that reject virtual-host URLs)
LOG_LEVEL               info
DISCORD_API_BASE        optional, default https://discord.com/api
```

`PORT` is injected by Railway; do not set it. The backend listens on `0.0.0.0:$PORT`.

Bot:

```
DISCORD_TOKEN           bot token from the Discord application
DISCORD_CLIENT_ID       same application
BACKEND_URL             http://backend.railway.internal:${{backend.PORT}}
BOT_SHARED_SECRET       ${{backend.BOT_SHARED_SECRET}}
PORT                    3001   (internal HTTP server for /post and /health, phase 4)
```

Bot to backend traffic stays on the private network (`*.railway.internal`, IPv6). Only the backend gets a public domain.

## Migrations

Drizzle SQL migrations are committed under `apps/backend/drizzle/` (generate with `npm run generate -w apps/backend`). The backend's `preDeployCommand` runs `npm run migrate -w apps/backend` in the freshly built image before the new container is started; if it fails the deploy is aborted and the previous version keeps running. `buildApp` also applies migrations at startup, so a manual redeploy is safe. Never run migrations from the bot.

## First-time setup checklist (dashboard)

1. **Discord application** (discord.com/developers): create one application. Under OAuth2 add the redirect `https://cosnostra.benja.ar/auth/discord/callback` exactly. Note the client id and secret. Under Bot, reset and copy the token, enable the Message Content intent only if a later phase needs it.
2. **Railway project**: New Project -> Deploy from GitHub repo -> `GrandThed/Cos-Nostra`. Railway creates one service; rename it `backend`.
3. **backend service -> Settings**: Source: root directory `/`, branch `main`. Config-as-code file path: `apps/backend/railway.json`. Confirm the builder shows Dockerfile `apps/backend/Dockerfile` after the next deploy trigger. Networking: Generate Domain (temporary), then Custom Domain `cosnostra.benja.ar`; add the CNAME Railway shows at the DNS provider for `benja.ar` and wait for the certificate. Target port: the one the app listens on (`PORT` is injected; the container exposes 3000).
4. **Postgres**: + New -> Database -> PostgreSQL. Note its service name (default `Postgres`).
5. **Bucket**: + New -> Storage Bucket. Note its service name (default `Bucket`). Its Variables tab shows `ENDPOINT`, `REGION`, `BUCKET`, `ACCESS_KEY_ID`, `SECRET_ACCESS_KEY`.
6. **backend service -> Variables**: add every backend variable from the list above, using the `${{Postgres.DATABASE_URL}}` and `${{Bucket.*}}` references. Generate `JWT_SECRET` and `BOT_SHARED_SECRET` (`openssl rand -hex 32`). Leave `BOT_INTERNAL_URL` unset for now.
7. **Deploy the backend**: push to `main` or click Deploy. Watch the build log (Dockerfile stages), then the pre-deploy log (`migrations applied (pg)`), then the deploy log. `https://cosnostra.benja.ar/health` must answer `{"ok":true,"driver":"pg"}`.
8. **bot service**: + New -> GitHub Repo -> same repo. Rename to `bot`. Settings: root directory `/`, config-as-code file path `apps/bot/railway.json`, no public domain. Variables: the bot list above.
9. **Link the two**: on the backend set `BOT_INTERNAL_URL=http://bot.railway.internal:3001` once the bot's internal server exists (phase 4). Private networking must be enabled on the project (default for new projects).
10. **Watch paths**: `watchPatterns` in each `railway.json` already stop desktop-only commits from redeploying the services. Check the Deployments tab after a desktop commit to confirm nothing was triggered.

## Local parity

The repo-root `.env.example` is the single reference for every variable (backend, bot, desktop). Copy it to `.env`; both Node apps load it through `node --env-file-if-exists=../../.env`. `apps/backend/.env.example` mirrors just the backend block. Locally use `DATABASE_URL=pglite://./data/dev` instead of Postgres and leave the `S3_*` variables empty (upload routes answer 503). Never point a local `.env` at the production database.

## Checking a deploy

- Logs: service -> Deployments -> the deployment -> Build / Deploy tabs. Pre-deploy command output has its own section. The backend logs pino JSON; paste through `npx pino-pretty` locally if needed.
- Build fails at `npm ci`: the lockfile is out of sync with a `package.json`. Run `npm install` at the root, commit `package-lock.json`.
- Build fails at `COPY packages/shared/package.json`: the Dockerfile expects the repo root as context; the service root directory drifted from `/`.
- Deploy crashes immediately with `invalid environment:` followed by variable names: add the missing variables. A `${{Bucket.X}}` reference to a wrong service name resolves to an empty string, which makes storage silently disabled (503 on uploads) rather than a crash.
- Pre-deploy fails: usually `DATABASE_URL` pointing at the public proxy without TLS, or a migration conflict. Fix the migration locally against PGlite (`npm test -w apps/backend`) before pushing again.
- Healthcheck never passes: the app must listen on `0.0.0.0:$PORT`; do not hardcode 3000 in the variables.
- Discord login loops or errors: the redirect URI in the Discord portal must be exactly `PUBLIC_URL + /auth/discord/callback`, no trailing slash.
