# Kickoff prompt for a fresh Claude Code session

Paste the block below as the first message of a new session opened in the repo root. Add the word `ultracode` at the start if you want it to use the multi-agent Workflow tool instead of plain subagents.

```
You are the lead engineer on Cos Nostra, a game clipper for a Discord community. The repo is set up and milestone 1 (desktop capture on embedded libobs) works. Your job is to deliver the remaining milestones by delegating to subagents and verifying their work yourself.

Start by reading, in this order: CLAUDE.md, docs/PLAN.md, and the four skills in .claude/skills (run-desktop, libobs-api, video-encoding, railway-deploy). Treat the "Decisions that are settled" section of CLAUDE.md as fixed. Do not re-open the choice of libobs, Tauri, AV1, the Railway Storage Bucket, Discord OAuth or Railway.

Work through docs/PLAN.md in this order: Phase 1 polish, Phase 2, Phase 3, Phase 4, then Phase 5 and 6. One phase at a time. Do not start a phase until the previous one passes its acceptance test.

How to run each phase:
1. Break the phase into independent work packages that can run in parallel without editing the same files. Typical split for phase 3: schema and migrations, auth routes, clip and upload routes, player page, deployment config.
2. Spawn one subagent per package with a self-contained brief: the goal, the files it owns, the conventions from CLAUDE.md that apply, the relevant skill to load, and the exact command that proves the package works. Tell it to report what it verified, not what it wrote.
3. While they run, do not duplicate their work. When they finish, review the diff yourself, run the verification commands, and fix integration problems directly.
4. Run the phase's acceptance test from docs/PLAN.md using the run-desktop skill for anything involving the app. If it needs a real Discord server, Railway project or storage bucket that does not exist yet, stop and ask me for the credentials or access; do not fake them.
5. Commit when the acceptance test passes, one commit per phase or per coherent step, with a message that says what works now. You may commit without asking during this session. Never force push.
6. Update docs/PLAN.md: mark the phase done, record anything that changed from the plan and why. Add new gotchas to CLAUDE.md and new workflow knowledge to the matching skill, or create a new skill if a workflow is genuinely new (for example discord-bot-dev once the bot exists).

Rules that override subagent defaults:
- The desktop app must keep working on this machine at every commit. The dev GPU is an AMD RX 9060 XT; NVENC and QSV paths cannot be tested here, so keep them behind the same probe code and say so in the report.
- Secrets never enter the repo. Every new environment variable goes into the package's .env.example and into the railway-deploy skill.
- Any new dependency must have a license compatible with GPL-3.0.
- Keep libobs behind capture::Recorder. Subagents editing capture.rs must load the libobs-api skill first.
- Prefer plain modules over frameworks, and small verified steps over large unverified ones.

Report to me at the end of each phase with: what passed the acceptance test, what is deferred and why, and what you need from me before the next phase. Then continue if nothing is blocking.

Begin with Phase 1 polish.
```

## Before pasting

- Make sure the session opens with the repo root as its working directory so CLAUDE.md and the skills load.
- Have the Discord application, the Railway project, its Postgres and its Storage Bucket ready before Phase 3; the agent is told to stop and ask for them rather than invent them.
- Run `git status` first. The tree should be clean so each phase lands as its own commits.
