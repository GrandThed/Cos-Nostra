# Continue from here

Written 2026-09-11 at the end of the session that closed phase 3, fixed the AV1 preset and
built and deployed phase 4. Paste the block below as the first message of a new session opened
in the repo root. Delete this file once phase 4 is closed and the prompt is stale.

## Where things stand

- **Phases 1, 2, 3: done and verified.** Backend live at `https://cosnostra.benja.ar` with
  Railway Postgres and a Storage Bucket. One clip is uploaded (`cKKTMjWyCu5D`).
- **AV1 sizing: fixed.** `av1_amf` quantizers are 0-255, not 0-51, so the old `-qp_i 28` asked
  for near-lossless. Now cqp 95: 32 percent smaller than the H.264 fallback at a 0.87 VMAF gap
  on real gameplay. Numbers in the video-encoding skill.
- **Phase 4: built, deployed, acceptance test part-run.** The bot is on Railway, in the dev
  guild FAMAFIA (`438477166573912074`), `/clips` registered, `/clips setup` works, and posting a
  clip works end to end including the seed reactions. What is left is listed in the prompt.
- **Phases 5 and 6: not started.**

## Things that will bite a fresh session

- **Never run a local bot while the Railway service is deployed.** Two gateway connections on
  one token: clips post twice, reactions count twice, and the failure looks like a bug in our
  interaction handler. Pause one before debugging. See the `discord-bot` skill.
- The desktop app defaults to the **production** backend with auto-upload on, so linking
  Discord in `tauri dev` drains the local clip queue into the real bucket.
- Auto-upload is currently **off** in `%APPDATA%\Cos Nostra\settings.json`, switched off during
  phase 3 testing so the queue of test-pattern clips would not flood production.
- The local clip queue holds ~20 clips, most of them ffplay test patterns and a game queue
  screen. Only `2026-09-10 18-34-35.mp4` is real gameplay, and its AV1 was encoded with the old
  broken preset.

## The prompt

```
You are the lead engineer on Cos Nostra. Read CLAUDE.md, docs/PLAN.md and the skills in
.claude/skills (run-desktop, libobs-api, video-encoding, railway-deploy, discord-bot) before
touching anything. Treat "Decisions that are settled" in CLAUDE.md as fixed.

Phases 1 to 3 are done. Phase 4 is built and deployed but its acceptance test is only part-run.
Finish it, then continue.

1. Close phase 4. The acceptance test in docs/PLAN.md is: upload a clip from the desktop app and
   see it in the channel within seconds; react, remove the reaction, react again, and /clips top
   reflects the final count. Specifically still unproven:
   - Reaction tracking against a real Discord post. Nobody has reacted to one yet. I will click
     the reactions; tell me exactly what to do and verify the vote rows through the backend.
   - The automatic path. Every post so far was triggered by hand with POST /post. This needs
     BOT_INTERNAL_URL set on the backend service to the bot's internal hostname and port 3001;
     tell me what to set if it is not set yet, then prove a desktop upload reaches Discord on
     its own.
   - /clips latest, /clips mine and /clips link have never been run in Discord.
   Only one bot may be connected at a time, so do not start a local one without pausing the
   Railway service first. When it passes, mark phase 4 done in docs/PLAN.md with what changed,
   and commit.

2. Then phase 5, the yearly recap, per docs/PLAN.md. The rendering worker must run both on
   Railway and on my PC, so keep it plain Node plus ffmpeg.

3. Then phase 6, editing in the desktop app.

How to work: split each phase into independent packages that do not touch the same files, spawn
one subagent per package with a self-contained brief (goal, files it owns, conventions, the
skill to load, the command that proves it works), review their diffs yourself, run the
acceptance test, and fix integration issues directly. The desktop app must keep working on this
machine at every commit. NVENC and QSV cannot be tested here, so keep them behind the probe and
say so. If you need a credential, a Railway setting or a Discord permission that does not exist,
stop and tell me exactly what to create. Do not invent it.

Commit when an acceptance test passes, one commit per coherent step, message says what works
now. You may commit without asking. Never force push. Keep docs/PLAN.md, CLAUDE.md and the
skills current. New environment variables go into .env.example and the railway-deploy skill,
never into the repo with values.

Report at the end of each phase: what passed, what is deferred and why, what you need from me.
Then continue if nothing is blocking.

Begin with step 1.
```
