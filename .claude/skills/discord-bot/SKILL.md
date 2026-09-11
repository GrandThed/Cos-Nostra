---
name: discord-bot
description: How the Cos Nostra Discord bot is built, run locally, tested without a gateway, and how its slash commands are registered; plus the Discord behaviours that shaped it (embed vs link, upload limits, emoji identity, duplicate instances). Use when editing anything under apps/bot, debugging a command that does not answer, or working out why a clip posted the way it did.
---

# Discord bot

`apps/bot` is discord.js 14 plus Node builtins. No framework, no logging library, no zod:
`apps/bot/Dockerfile` installs only the bot workspace (`npm ci --workspace apps/bot
--include-workspace-root=false --omit=dev`), so anything that is not in `apps/bot/package.json`
will exist locally through npm's hoisting and then be **missing in production**. That is how
`@cos-nostra/shared` nearly shipped broken: it is imported by `src/backend.js` and had to be
declared explicitly.

## Shape

`src/index.js` is the only file that knows about all the parts; everything else takes its
collaborators as arguments and is testable with plain fakes.

| Module | Exports | Job |
|---|---|---|
| `config.js` | `loadConfig(env)` | Validates the environment, reporting **every** problem at once like the backend does |
| `backend.js` | `createBackend({baseUrl, botToken, fetch})` | The only door to the API; wraps `@cos-nostra/shared` |
| `server.js` | `createServer({config, poster, log})` | `GET /health`, `POST /post` on `BOT_PORT` |
| `post.js` | `createPoster({client, backend, log, fetch})`, `uploadLimitBytes(tier)` | Posts one clip to every configured guild |
| `reactions.js` | `registerReactions({client, backend, outbox, log})` | Gateway reactions to backend votes |
| `commands.js` | `commands`, `registerCommands({client, backend, log})` | `/clips setup latest top mine link` |
| `outbox.js` | `createOutbox({send, onError, delays, log})` | FIFO retry queue for reaction writes |
| `deploy-commands.js` | script | Registers `commands` with Discord |

`POST /post` answers **202 immediately** and posts in the background: the clip is already
durable in the bucket, so the backend's `notifyBot` must never wait on a Discord round trip.

## Running it

```
npm start -w apps/bot            # loads the repo-root .env
npm test -w apps/bot             # ~98 tests, no network, no gateway
npm run deploy-commands -w apps/bot
```

**Never run a local bot while the Railway service is deployed.** Two processes on one
`DISCORD_TOKEN` both connect to the gateway and both receive every interaction. The symptoms are
confusing because they are split across two machines:

- The instance that loses the race logs `DiscordAPIError[40060]: Interaction has already been
  acknowledged` on its **first** `deferReply`, which looks like a double-acknowledge bug in our
  own handler and is not.
- The user sees whatever the *other* instance replied, which may be an error the local logs never
  mention. That mismatch is the tell: **a reply the running process never logged means another
  instance answered it.**
- Clips get posted twice and every reaction is written twice.

Stop one of them before debugging anything else. To take the Railway one out of the way, pause
the service; to take the local one out, kill the `node` process whose command line contains
`apps/bot` (stopping the `npm` wrapper alone can leave the child alive).

## Registering slash commands

Registration is a **separate step from deploying** and has to be re-run whenever a command's
name, options or description change. Guild-scoped registration (`DISCORD_DEV_GUILD_ID` set) is
instant; global registration takes up to an hour.

- `Missing Access` (code 50001) means the bot **was never invited to that guild**, not that a
  permission is missing. Check with `GET https://discord.com/api/v10/users/@me/guilds` and a
  `Bot <token>` header: an empty array proves it. The install link and its permission integer
  are in the railway-deploy skill.
- Confirm `DISCORD_DEV_GUILD_ID` against that same listing rather than trusting `.env`. A wrong
  id fails with the same `Missing Access`.
- The script sets `process.exitCode` and never calls `process.exit()`. Calling it while
  `@discordjs/rest` is still closing its agent aborts inside libuv on Windows (`Assertion
  failed: !(handle->flags & UV_HANDLE_CLOSING)`, exit 3221226505) and turns a readable REST
  error into a crash. The same rule applies to `index.js` shutdown.

`/clips setup` is gated on Manage Guild **at runtime**, not with
`setDefaultMemberPermissions`: Discord only accepts that on a top-level command, and `/clips`
also carries `latest`, `top`, `mine` and `link`, which every member should see. A server admin
can override default permissions anyway, so the runtime check is the one that holds.

## How a clip gets posted

Per guild, not per clip — the upload limit is a property of the guild's boost tier, so one clip
can attach in a boosted guild and go as a link everywhere else.

| Boost tier | Limit |
|---|---|
| 0 and 1 | 10 MB |
| 2 | 50 MB |
| 3 | 100 MB |

These are Discord *policy* numbers that have changed before (8 → 25 → 10 MB), so they live only
in `uploadLimitBytes()`. Attach only below ~95% of the limit: the multipart envelope counts too.

**A message that carries its own embed gets no link preview.** Measured against the real API on
2026-09-11 with three shapes in a real channel:

| message | result |
|---|---|
| rich embed + bare URL | one `type=rich` embed, **no player** |
| bare URL alone | `type=video`, 1920x1080, thumbnail, title and description from our og: tags |
| rich embed + `<URL>` | one `type=rich` embed |

So the link path sends **content only, no `embeds[]`**, and Discord renders the player page's
`og:video` into a native inline player at full quality with no size limit. That is why there is
no `buildEmbed` in `post.js`. The attachment path wraps its URL in `<>` to suppress the preview,
because the file already plays inline and a second player would be noise.

Two consequences worth remembering:

- The embed's title, description and thumbnail come from `apps/backend/src/routes/player.js`,
  not from the bot. Changing how a post looks usually means editing the og: tags there.
- Discord caches an embed when it first crawls a URL and does not re-crawl it. Anything that
  changes over time (a reaction count) must stay out of `og:description` or it freezes at its
  first value forever.

To see what Discord actually made of a message, read it back rather than guessing:

```
GET https://discord.com/api/v10/channels/<channel>/messages/<id>
```

and look at `embeds[].type`, `embeds[].video` and `attachments`. Discord unfurls asynchronously,
so wait several seconds before reading.

## Reactions

Seed reactions are the bot's own and must never count as votes; the tracker ignores
`client.user.id` and any `user.bot`.

**Do not use `reaction.emoji.identifier` as the vote key.** discord.js builds an animated
emoji's identifier as `a:name:id` on add but the remove payload is a partial emoji without
`animated`, yielding `name:id` — so a remove would never close the row its add opened. Build the
key by hand: `emoji.id ? \`${emoji.name}:${emoji.id}\` : emoji.name`.

Partials are enabled (`Partials.Message`, `Partials.Reaction`) so reactions on messages sent
before the bot started still arrive; anything partial must be `fetch()`ed inside a try/catch,
because an unhandled rejection in an event handler kills the process.

`backend.getPost(messageId)` is how the bot tells its own posts from every other message in a
busy channel. Unknown messages are cached negatively (bounded, and expiring after 60 s so a
reaction that beats `POST /internal/posts` is not written off permanently). Writes go through
the **outbox**, never straight to the backend, so a backend deploy cannot lose a vote. The
outbox is in-memory and FIFO: a crash loses the backlog, and the ordering guarantee is what
stops an add/remove pair from being reordered.

A `getPost` failure that is *not* a 404 (a 502 mid-deploy) skips the reaction rather than
enqueuing it — the outbox protects the write path, not the lookup path. That gap is deliberate
and still open.

## Testing without Discord

Every module takes its collaborators as arguments, so the suite never opens a socket. A
discord.js `Client` is an `EventEmitter`, so a fake client is `new EventEmitter()` with a
`user = { id: 'bot-1' }` and `emit('messageReactionAdd', reaction, user)` exercises the real
handler. Interactions are plain objects recording `deferReply`/`editReply` calls. Build embeds
and attachments with the real `EmbedBuilder`/`AttachmentBuilder` and assert on `toJSON()` so the
payload passes discord.js's own validation.

`node --test apps/bot/test/` with a directory argument fails on this machine with
`MODULE_NOT_FOUND`; use `npm test -w apps/bot` or `node --test "apps/bot/test/*.test.js"`.

## Driving it by hand

The backend's `notifyBot` sends exactly this, so it is also how to test a post without an
upload:

```
curl -X POST http://127.0.0.1:3001/post \
  -H "authorization: Bearer $BOT_SHARED_SECRET" \
  -H 'content-type: application/json' \
  -d '{"clipId":"<id>"}'
```

202 with `{"ok":true,...}` means accepted, not posted — read the log or the channel for the
outcome. A wrong secret is 401, and the comparison is constant time.
