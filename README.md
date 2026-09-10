# Cos Nostra

Game clipping for a Discord community.

- `apps/desktop` – Windows clipper (Tauri + embedded libobs). Global hotkey saves the replay buffer, trims, compresses to AV1 and uploads.
- `apps/backend` – Clip API and player (Node, Fastify, Postgres). Videos live in S3-compatible object storage.
- `apps/bot` – Discord bot that posts clips, records reactions and builds the yearly compilation.

See `docs/PLAN.md` for the implementation plan and `CLAUDE.md` for conventions.

Backend and bot deploy to Railway from GitHub. Licensed GPL-3.0: the desktop app links libobs (GPL-2.0-or-later) through libobs-rs (GPL-3.0).
