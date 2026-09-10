---
name: railway-deploy
description: How the Cos Nostra backend and Discord bot are deployed to Railway from the GitHub monorepo, which environment variables each service needs, how migrations run, and how to check logs. Use when adding a service, changing env vars, debugging a failed deploy, or setting up Railway for the first time.
---

# Railway deployment

Two services from one repository plus a Postgres plugin. Video never goes through Railway; it lives in S3-compatible object storage.

## Services

| Service | Root directory | Start command | Health |
|---|---|---|---|
| backend | `apps/backend` | `npm start` | `GET /health` |
| bot | `apps/bot` | `npm start` | `GET /health` on the bot's internal port |

Set each service's root directory in Railway's settings so it builds only its package. Both use Nixpacks with Node 24; add `engines.node` to each `package.json` so the detected version is right. Watch paths: `apps/backend/**` and `packages/shared/**` for the backend, `apps/bot/**` and `packages/shared/**` for the bot, so a desktop-only commit does not redeploy them.

Because the workspace root holds the lockfile, each service's build needs the root `package.json` and `package-lock.json`. If Nixpacks cannot resolve the workspace from a subdirectory, switch that service to a small Dockerfile that copies the root manifests, runs `npm ci --workspace apps/<name>`, and starts the package.

## Environment variables

Backend:

```
DATABASE_URL            from the Postgres plugin reference
PUBLIC_URL              https://<backend domain>
JWT_SECRET
BOT_SHARED_SECRET       same value on the bot
DISCORD_CLIENT_ID
DISCORD_CLIENT_SECRET
S3_ENDPOINT             https://<account>.r2.cloudflarestorage.com
S3_REGION               auto
S3_BUCKET
S3_ACCESS_KEY_ID
S3_SECRET_ACCESS_KEY
S3_PUBLIC_BASE_URL      https://<r2 custom domain>
BOT_INTERNAL_URL        http://bot.railway.internal:<port>
```

Bot:

```
DISCORD_TOKEN
DISCORD_CLIENT_ID
BACKEND_URL             http://backend.railway.internal:<port>   (private network)
BOT_SHARED_SECRET
PORT                    internal HTTP port for /post and /health
```

Use Railway's private networking (`*.railway.internal`) for bot to backend traffic. Only the backend gets a public domain.

## Migrations

Drizzle migrations are committed under `apps/backend/drizzle/`. The backend runs `npm run migrate` as its pre-deploy command in Railway so schema changes apply before the new version starts. Never run migrations from the bot.

## Local parity

`apps/backend/.env.example` and `apps/bot/.env.example` list every variable. For local Postgres use Docker or Railway's `railway run` to borrow the deployed database in a development environment, never the production one.

## Checking a deploy

- `railway logs -s backend` or the dashboard. The backend logs with pino in JSON; pipe through `npx pino-pretty` locally.
- A deploy that builds but crashes usually means a missing variable. The backend validates its environment at startup and prints the missing names.
- The Discord OAuth redirect URI must exactly match `PUBLIC_URL + /auth/discord/callback` in the Discord developer portal.
