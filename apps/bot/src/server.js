// The bot's internal HTTP server. Three routes, node:http, no framework: the backend calls
// POST /post after an upload completes and POST /voice-snapshot while a clip is being made,
// and Railway calls GET /health.
//
// POST /post is fire-and-forget by contract (see apps/backend/src/plugins/bot.js): the clip
// is already stored, so we answer 202 before touching Discord and never let a posting failure
// turn into a retry storm or a crashed process. The backend only looks at the status code.
//
// POST /voice-snapshot is the opposite: the caller wants the answer, and the answer is a
// synchronous read of the gateway's voice state cache, so it is served inline. It exists
// because only the bot holds that state - the desktop app knows who pressed the hotkey and
// nothing else, and the backend has no gateway connection of its own.

import http from 'node:http';
import { timingSafeEqual } from 'node:crypto';

// Bodies here are a single clip id. Anything larger is a mistake or an attack.
const MAX_BODY_BYTES = 16 * 1024;
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

/**
 * @param {object} options
 * @param {import('./config.js').Config} options.config
 * @param {{ postClip: (clipId: string) => Promise<unknown> }} options.poster
 * @param {{ info: Function, warn: Function, error: Function, debug: Function }} [options.log]
 * @param {any} [options.client] discord.js Client, read by POST /voice-snapshot
 */
export function createServer({ config, poster, log = NOOP_LOG, client }) {
  const expected = Buffer.from(`Bearer ${config.BOT_SHARED_SECRET}`);

  /**
   * Posting runs after the response, detached from the request. Everything it can throw,
   * including a synchronous throw from a bad poster, is logged and swallowed here.
   * @param {string} clipId
   */
  function postInBackground(clipId) {
    void (async () => {
      try {
        await poster.postClip(clipId);
      } catch (err) {
        log.error(`post failed for clip ${clipId}: ${err?.stack ?? err?.message ?? String(err)}`);
      }
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
      // Accept first, work later. The backend must not wait for Discord.
      json(res, 202, { ok: true, clipId });
      log.info(`queued clip ${clipId} for posting`);
      postInBackground(clipId);
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
