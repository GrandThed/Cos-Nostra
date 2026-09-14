// The bot's internal HTTP server. node:http, no framework. The backend calls four routes:
//
//   - POST /post after an upload completes, or when the owner posts a clip to more servers;
//   - POST /unpost when a clip is unpublished or deleted, to take its messages down;
//   - POST /voice-snapshot while a clip is being made;
//   - POST /member-guilds when the desktop's Publish dialog asks which servers to offer;
//
// and Railway calls GET /health.
//
// POST /post and POST /unpost are fire-and-forget by contract (see
// apps/backend/src/plugins/bot.js): the backend has already written the outcome it wants, so
// we answer 202 before touching Discord and never let a Discord failure turn into a retry
// storm or a crashed process. The backend only looks at the status code.
//
// POST /voice-snapshot and POST /member-guilds are the opposite: the caller wants the answer,
// so it is served inline. They exist because only the bot can ask - the backend has no gateway
// connection of its own, and the voice state cache and guild membership both live behind one.

import http from 'node:http';
import { timingSafeEqual } from 'node:crypto';

import { deleteMessage } from './manage.js';
import { memberGuilds } from './members.js';

// Bodies here are a few ids: a clip, a user, a handful of guilds or posts. Anything larger is a
// mistake or an attack.
const MAX_BODY_BYTES = 16 * 1024;
// The backend gives POST /member-guilds 4 s before it answers the desktop with bot_unavailable.
// Answering a little earlier with the guilds confirmed so far is better than being cut off.
const MEMBER_GUILDS_TIMEOUT_MS = 3_500;
// Railway private networking resolves to IPv6, so a dual-stack bind is required for the
// backend to reach us at bot.railway.internal. Node leaves ipv6Only off, so IPv4 works too.
const HOST = '::';

const NOOP_LOG = { info() {}, warn() {}, error() {}, debug() {} };

/**
 * @param {http.ServerResponse} res
 * @param {number} status
 * @param {unknown} body
 */
function json(res, status, body) {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(text),
  });
  res.end(text);
}

/**
 * Constant-time bearer comparison, same shape as the backend's bot auth.
 * @param {string | undefined} header
 * @param {Buffer} expected
 */
function authorized(header, expected) {
  const got = Buffer.from(header ?? '');
  return got.length === expected.length && timingSafeEqual(got, expected);
}

/**
 * @param {http.IncomingMessage} req
 * @returns {Promise<string>} rejects when the body is larger than MAX_BODY_BYTES
 */
function readBody(req) {
  return new Promise((resolve, reject) => {
    /** @type {Buffer[]} */
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error('body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

/**
 * Reads and JSON-parses a request body, answering the request itself when it cannot. Both
 * POST routes take a small JSON object, so both get the same 413 and the same 400.
 * @param {http.IncomingMessage} req
 * @param {http.ServerResponse} res
 * @returns {Promise<{ ok: true, body: any } | { ok: false }>}
 */
async function jsonBody(req, res) {
  let raw;
  try {
    raw = await readBody(req);
  } catch {
    json(res, 413, { error: 'payload_too_large' });
    return { ok: false };
  }
  try {
    return { ok: true, body: JSON.parse(raw) };
  } catch {
    json(res, 400, { error: 'bad_json' });
    return { ok: false };
  }
}

/**
 * Everyone in `discordId`'s voice channel except `discordId`, in the first guild that has
 * them in one.
 *
 * A person is realistically in one guild's voice at a time, so the first hit wins rather than
 * merging channels from several servers into one participant list. Everything is read from
 * the gateway cache the GuildVoiceStates intent keeps current - no REST call, nothing to
 * await - which is why the route can answer inline.
 *
 * Only ids are collected: a VoiceState always carries one, with no GuildMembers intent and no
 * cached member needed (see client.js), and `<@id>` renders the name on the reader's side.
 *
 * @param {any} client discord.js Client
 * @param {string} discordId
 * @returns {string[]}
 */
function voiceSnapshot(client, discordId) {
  const guilds = client?.guilds?.cache;
  if (!guilds || typeof guilds.values !== 'function') return [];
  for (const guild of guilds.values()) {
    const states = guild?.voiceStates?.cache;
    if (!states || typeof states.get !== 'function') continue;
    const own = states.get(discordId);
    if (!own?.channelId) continue;
    return [...states.values()]
      .filter((state) => state?.channelId === own.channelId && state.id !== discordId)
      .map((state) => String(state.id));
  }
  return [];
}

/** @param {unknown} value */
function isNonEmptyString(value) {
  return typeof value === 'string' && value.length > 0;
}

/** @param {unknown} value @returns {value is string[]} */
function isIdList(value) {
  return Array.isArray(value) && value.every(isNonEmptyString);
}

/**
 * One entry of POST /unpost. Only the channel and message ids are needed to delete it; the
 * guild id is carried for the log and checked only for its type.
 * @param {any} post
 */
function isPostRef(post) {
  return (
    Boolean(post) &&
    typeof post === 'object' &&
    isNonEmptyString(post.channelId) &&
    isNonEmptyString(post.messageId) &&
    (post.guildId === undefined || typeof post.guildId === 'string')
  );
}

/**
 * @param {object} options
 * @param {import('./config.js').Config} options.config
 * @param {{ postClip: (clipId: string, guildIds?: string[]) => Promise<unknown> }} options.poster
 * @param {{ info: Function, warn: Function, error: Function, debug: Function }} [options.log]
 * @param {any} [options.client] discord.js Client, read by POST /voice-snapshot and
 *   POST /member-guilds and used to delete messages for POST /unpost
 * @param {number} [options.memberGuildsTimeoutMs] overridable so a test need not wait 3.5 s
 */
export function createServer({
  config,
  poster,
  log = NOOP_LOG,
  client,
  memberGuildsTimeoutMs = MEMBER_GUILDS_TIMEOUT_MS,
}) {
  const expected = Buffer.from(`Bearer ${config.BOT_SHARED_SECRET}`);

  /**
   * Posting runs after the response, detached from the request. Everything it can throw,
   * including a synchronous throw from a bad poster, is logged and swallowed here.
   * @param {string} clipId
   * @param {string[] | undefined} guildIds
   */
  function postInBackground(clipId, guildIds) {
    void (async () => {
      try {
        await poster.postClip(clipId, guildIds);
      } catch (err) {
        log.error(`post failed for clip ${clipId}: ${err?.stack ?? err?.message ?? String(err)}`);
      }
    })();
  }

  /**
   * Takes a clip's messages down after the response, one at a time: there are rarely more than
   * a few, and discord.js queues deletes in one channel behind the same rate limit anyway.
   * deleteMessage already tolerates a message or channel that is gone.
   * @param {string} clipId
   * @param {{ guildId?: string, channelId: string, messageId: string }[]} posts
   */
  function unpostInBackground(clipId, posts) {
    void (async () => {
      for (const post of posts) {
        try {
          await deleteMessage(client, post.channelId, post.messageId, log);
        } catch (err) {
          // deleteMessage never rejects today; this keeps a future change from crashing us.
          log.error(`unpost of message ${post.messageId} failed: ${err?.message ?? String(err)}`);
        }
      }
      log.info(`clip ${clipId}: took down ${posts.length} post(s)`);
    })();
  }

  const server = http.createServer(async (req, res) => {
    let path = '/';
    try {
      path = new URL(req.url ?? '/', 'http://bot.internal').pathname;
    } catch {
      path = req.url ?? '/';
    }

    if (req.method === 'GET' && path === '/health') {
      return json(res, 200, { ok: true });
    }

    if (req.method === 'POST' && path === '/voice-snapshot') {
      if (!authorized(req.headers.authorization, expected)) {
        log.warn('POST /voice-snapshot rejected: bad shared secret');
        return json(res, 401, { error: 'unauthorized' });
      }
      const parsed = await jsonBody(req, res);
      if (!parsed.ok) return;
      const discordId = parsed.body?.discordId;
      if (typeof discordId !== 'string' || discordId.length === 0) {
        return json(res, 400, { error: 'bad_request', message: 'discordId is required' });
      }
      // A cache lookup, so there is nothing to defer: answer with the participants, or with
      // an empty list when the user is not in voice anywhere the bot can see.
      const participants = voiceSnapshot(client, discordId);
      log.debug(`voice snapshot for ${discordId}: ${participants.length} other(s) in the channel`);
      return json(res, 200, { participants });
    }

    if (req.method === 'POST' && path === '/post') {
      if (!authorized(req.headers.authorization, expected)) {
        log.warn('POST /post rejected: bad shared secret');
        return json(res, 401, { error: 'unauthorized' });
      }
      const parsed = await jsonBody(req, res);
      if (!parsed.ok) return;
      const clipId = parsed.body?.clipId;
      if (typeof clipId !== 'string' || clipId.length === 0) {
        return json(res, 400, { error: 'bad_request', message: 'clipId is required' });
      }
      // Absent and null are the same thing - "use the clip's own targets" - because the poster
      // resolves them with `??`. Anything else must be a list of ids: a malformed list that
      // quietly fell back to the clip's targets could post somewhere nobody asked for.
      const guildIds = parsed.body.guildIds ?? undefined;
      if (guildIds !== undefined && !isIdList(guildIds)) {
        return json(res, 400, {
          error: 'bad_request',
          message: 'guildIds must be an array of guild ids',
        });
      }
      // Accept first, work later. The backend must not wait for Discord.
      json(res, 202, { ok: true, clipId });
      log.info(
        `queued clip ${clipId} for posting${guildIds ? ` to guild(s) ${guildIds.join(', ') || '(none)'}` : ''}`,
      );
      postInBackground(clipId, guildIds);
      return;
    }

    if (req.method === 'POST' && path === '/member-guilds') {
      if (!authorized(req.headers.authorization, expected)) {
        log.warn('POST /member-guilds rejected: bad shared secret');
        return json(res, 401, { error: 'unauthorized' });
      }
      const parsed = await jsonBody(req, res);
      if (!parsed.ok) return;
      const discordId = parsed.body?.discordId;
      const guildIds = parsed.body?.guildIds;
      if (!isNonEmptyString(discordId) || !isIdList(guildIds)) {
        return json(res, 400, {
          error: 'bad_request',
          message: 'discordId and guildIds are required',
        });
      }
      // memberGuilds never rejects and is bounded by the timeout, so the response always goes
      // out in time for the backend's own deadline.
      const confirmed = await memberGuilds({
        client,
        discordId,
        guildIds,
        timeoutMs: memberGuildsTimeoutMs,
        log,
      });
      log.debug(`member guilds for ${discordId}: ${confirmed.length} of ${guildIds.length}`);
      return json(res, 200, { guildIds: confirmed });
    }

    if (req.method === 'POST' && path === '/unpost') {
      if (!authorized(req.headers.authorization, expected)) {
        log.warn('POST /unpost rejected: bad shared secret');
        return json(res, 401, { error: 'unauthorized' });
      }
      const parsed = await jsonBody(req, res);
      if (!parsed.ok) return;
      const clipId = parsed.body?.clipId;
      const posts = parsed.body?.posts;
      if (!isNonEmptyString(clipId) || !Array.isArray(posts) || !posts.every(isPostRef)) {
        return json(res, 400, {
          error: 'bad_request',
          message: 'clipId and posts [{ guildId, channelId, messageId }] are required',
        });
      }
      // The backend has already marked these posts removed; the messages are ours to clean up.
      json(res, 202, { ok: true, clipId });
      log.info(`queued ${posts.length} post(s) of clip ${clipId} for removal`);
      unpostInBackground(clipId, posts);
      return;
    }

    json(res, 404, { error: 'not_found' });
  });

  return {
    /** @returns {Promise<void>} resolves once the port is bound */
    listen() {
      return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(config.BOT_PORT, HOST, () => {
          server.removeListener('error', reject);
          log.info(`internal HTTP server listening on [${HOST}]:${server.address()?.port}`);
          resolve();
        });
      });
    },
    /** @returns {Promise<void>} */
    close() {
      return new Promise((resolve) => {
        if (!server.listening) return resolve();
        server.close(() => resolve());
        // Idle keep-alive sockets would hold the close open past a Railway SIGTERM.
        server.closeIdleConnections?.();
      });
    },
    // The bound port, which is not config.BOT_PORT when that is 0 (tests).
    get port() {
      const address = server.address();
      return typeof address === 'object' && address ? address.port : config.BOT_PORT;
    },
  };
}
