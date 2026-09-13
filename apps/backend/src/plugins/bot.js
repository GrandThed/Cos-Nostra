// Backend -> bot notifications. `app.notifyBot(clipId)` tells the bot's internal HTTP server
// that a clip finished uploading so it can post it to Discord. Delivery is best effort:
// the clip is already stored, so a failed notification must never fail the upload request.
// The bot can re-check through GET /internal/posts/:messageId and the clip listing; the
// retries here only cover a bot restart or a short network blip.
//
// `app.voiceSnapshot(discordId)` asks the same server who is in voice with a user right now,
// for routes/discord.js. That one is a real request/response - the caller needs the answer -
// but it is just as unfailing: see the decorator.

import { setTimeout as sleep } from 'node:timers/promises';

const DEFAULT_DELAYS = [1_000, 3_000, 9_000];
const REQUEST_TIMEOUT_MS = 5_000;
// Shorter than REQUEST_TIMEOUT_MS: the desktop is holding a record hotkey press open on this
// answer, so giving up quickly and tagging nobody beats making the user wait.
const VOICE_SNAPSHOT_TIMEOUT_MS = 4_000;

let retryDelays = DEFAULT_DELAYS;

/**
 * Override the retry schedule. Only used by tests to keep them fast; production always
 * uses 1 s, 3 s, 9 s.
 * @param {number[] | null} delays  null restores the default
 */
export function setRetryDelays(delays) {
  retryDelays = delays ?? DEFAULT_DELAYS;
}

/**
 * @param {import('fastify').FastifyInstance} app
 * @param {string} clipId
 * @param {number} attempt  0-based
 */
async function attempt(app, clipId, attempt) {
  const res = await fetch(`${app.config.BOT_INTERNAL_URL}/post`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${app.config.BOT_SHARED_SECRET}`,
    },
    body: JSON.stringify({ clipId }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!res.ok) {
    throw new Error(`bot answered ${res.status}`);
  }
  app.log.info({ clipId, attempt }, 'bot notified');
}

/**
 * Runs the first attempt and the retry chain. Never rejects.
 * @param {import('fastify').FastifyInstance} app
 * @param {string} clipId
 */
async function deliver(app, clipId) {
  const delays = retryDelays;
  for (let i = 0; i <= delays.length; i++) {
    try {
      await attempt(app, clipId, i);
      return;
    } catch (err) {
      const last = i === delays.length;
      app.log[last ? 'error' : 'warn'](
        { clipId, attempt: i, err: err?.message ?? String(err) },
        last ? 'bot notification failed, giving up' : 'bot notification failed, will retry',
      );
      if (!last) await sleep(delays[i]);
    }
  }
}

/** @type {import('fastify').FastifyPluginAsync} */
async function botPlugin(app) {
  /**
   * Fire-and-forget notification. Resolves as soon as the first attempt has been
   * scheduled; delivery and retries continue in the background and are logged.
   * @param {string} clipId
   * @returns {Promise<void>}
   */
  app.decorate('notifyBot', async (clipId) => {
    if (!app.config.BOT_INTERNAL_URL) {
      app.log.debug({ clipId }, 'BOT_INTERNAL_URL unset, not notifying bot');
      return;
    }
    // deliver() catches everything; the extra .catch guards against a bug in the logger.
    deliver(app, clipId).catch((err) => {
      app.log.error({ clipId, err }, 'notifyBot crashed');
    });
  });

  /**
   * Who is in voice with this user right now. Unlike notifyBot this is a real request/response
   * - the desktop is waiting on the answer to attach to the clip it is about to create - but it
   * still must never reject: every failure resolves to an empty list, because a clip must not
   * fail to save over a Discord lookup. There are no retries for the same reason: the answer is
   * only true for the instant the hotkey was pressed, so a late one is worth less than none.
   * @param {string} discordId  the clip owner's Discord user id
   * @returns {Promise<{ participants: string[] }>}
   */
  app.decorate('voiceSnapshot', async (discordId) => {
    if (!app.config.BOT_INTERNAL_URL) return { participants: [] };
    try {
      const res = await fetch(`${app.config.BOT_INTERNAL_URL}/voice-snapshot`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${app.config.BOT_SHARED_SECRET}`,
        },
        body: JSON.stringify({ discordId }),
        signal: AbortSignal.timeout(VOICE_SNAPSHOT_TIMEOUT_MS),
      });
      if (!res.ok) return { participants: [] };
      const body = await res.json();
      return { participants: Array.isArray(body?.participants) ? body.participants : [] };
    } catch (err) {
      app.log.warn({ err, discordId }, 'voiceSnapshot failed');
      return { participants: [] };
    }
  });
}

// Decorators registered here must be visible to the whole app, not only to the
// encapsulation context of routes/internal.js which registers this plugin.
botPlugin[Symbol.for('skip-override')] = true;

export default botPlugin;
