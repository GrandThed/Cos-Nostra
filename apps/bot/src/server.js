// The bot's internal HTTP server. Two routes, node:http, no framework: the backend calls
// POST /post after an upload completes and Railway calls GET /health.
//
// POST /post is fire-and-forget by contract (see apps/backend/src/plugins/bot.js): the clip
// is already stored, so we answer 202 before touching Discord and never let a posting failure
// turn into a retry storm or a crashed process. The backend only looks at the status code.

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
 * @param {object} options
 * @param {import('./config.js').Config} options.config
 * @param {{ postClip: (clipId: string) => Promise<unknown> }} options.poster
 * @param {{ info: Function, warn: Function, error: Function, debug: Function }} [options.log]
 */
export function createServer({ config, poster, log = NOOP_LOG }) {
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

    if (req.method === 'POST' && path === '/post') {
      if (!authorized(req.headers.authorization, expected)) {
        log.warn('POST /post rejected: bad shared secret');
        return json(res, 401, { error: 'unauthorized' });
      }
      let raw;
      try {
        raw = await readBody(req);
      } catch {
        return json(res, 413, { error: 'payload_too_large' });
      }
      let body;
      try {
        body = JSON.parse(raw);
      } catch {
        return json(res, 400, { error: 'bad_json' });
      }
      const clipId = body?.clipId;
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
