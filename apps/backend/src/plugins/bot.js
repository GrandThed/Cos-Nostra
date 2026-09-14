// Backend -> bot calls, all against the bot's internal HTTP server with BOT_SHARED_SECRET.
//
// Two of them are notifications, fire-and-forget with the same 1 s / 3 s / 9 s retry chain:
//
//   app.notifyBot(clipId, guildIds?)  POST /post    a clip is ready, or should reach more guilds
//   app.unpostBot(clipId, posts)      POST /unpost  a clip was taken down, delete its messages
//
// Delivery is best effort: whatever prompted the call (an upload, a delete) is already durable,
// so a failed notification must never fail that request. The retries only cover a bot restart
// or a short network blip.
//
// The other two are real request/responses, because the caller needs the answer:
//
//   app.voiceSnapshot(discordId)            who is in voice with a user right now; never fails
//   app.memberGuilds(discordId, guildIds)   which of these guilds the user is in; throws on
//                                           failure so GET /discord/guilds can answer 503

import { setTimeout as sleep } from 'node:timers/promises';

const DEFAULT_DELAYS = [1_000, 3_000, 9_000];
const REQUEST_TIMEOUT_MS = 5_000;
// Shorter than REQUEST_TIMEOUT_MS: the desktop is holding a record hotkey press open on this
// answer, so giving up quickly and tagging nobody beats making the user wait.
const VOICE_SNAPSHOT_TIMEOUT_MS = 4_000;
// The publish dialog is open and waiting on this list; past four seconds a clear "bot
// unavailable" is more useful to the user than a spinner.
const MEMBER_GUILDS_TIMEOUT_MS = 4_000;

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
 * One POST to the bot. Rejects on a network error, a timeout or a non-2xx status.
 * @param {import('fastify').FastifyInstance} app
 * @param {string} path  e.g. '/post'
 * @param {unknown} body
 * @param {number} timeoutMs
 */
async function postToBot(app, path, body, timeoutMs) {
  const res = await fetch(`${app.config.BOT_INTERNAL_URL}${path}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${app.config.BOT_SHARED_SECRET}`,
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) {
    throw new Error(`bot answered ${res.status}`);
  }
  return res;
}

/**
 * Runs the first attempt and the retry chain for a notification. Never rejects.
 * @param {import('fastify').FastifyInstance} app
 * @param {string} path
 * @param {{ clipId: string }} body
 * @param {string} what  for the failure log lines, e.g. 'bot notification'
 * @param {string} delivered  the success log line
 */
async function deliver(app, path, body, what, delivered) {
  const delays = retryDelays;
  const { clipId } = body;
  for (let i = 0; i <= delays.length; i++) {
    try {
      await postToBot(app, path, body, REQUEST_TIMEOUT_MS);
      app.log.info({ clipId, attempt: i }, delivered);
      return;
    } catch (err) {
      const last = i === delays.length;
      app.log[last ? 'error' : 'warn'](
        { clipId, attempt: i, path, err: err?.message ?? String(err) },
        last ? `${what} failed, giving up` : `${what} failed, will retry`,
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
   *
   * Without `guildIds` the bot works out the targets itself from the clip (its stored
   * target_guilds, or every configured guild for a legacy clip); with them, it posts to those
   * guilds only. The field is left out of the body entirely when not given, so a bot from
   * before publish-on-demand sees exactly the request it always did.
   * @param {string} clipId
   * @param {string[]} [guildIds]
   * @returns {Promise<void>}
   */
  app.decorate('notifyBot', async (clipId, guildIds) => {
    if (!app.config.BOT_INTERNAL_URL) {
      app.log.debug({ clipId }, 'BOT_INTERNAL_URL unset, not notifying bot');
      return;
    }
    const body = guildIds ? { clipId, guildIds } : { clipId };
    // deliver() catches everything; the extra .catch guards against a bug in the logger.
    deliver(app, '/post', body, 'bot notification', 'bot notified').catch((err) => {
      app.log.error({ clipId, err }, 'notifyBot crashed');
    });
  });

  /**
   * Tell the bot to delete a clip's Discord messages. Same delivery as notifyBot: the posts
   * are already marked removed by the time this runs, so there is nothing to roll back if it
   * never lands, only messages left behind in a channel.
   * @param {string} clipId
   * @param {Array<{ guildId: string, channelId: string, messageId: string }>} posts
   * @returns {Promise<void>}
   */
  app.decorate('unpostBot', async (clipId, posts) => {
    if (!posts || posts.length === 0) return;
    if (!app.config.BOT_INTERNAL_URL) {
      app.log.debug({ clipId }, 'BOT_INTERNAL_URL unset, not asking the bot to unpost');
      return;
    }
    const body = {
      clipId,
      posts: posts.map(({ guildId, channelId, messageId }) => ({ guildId, channelId, messageId })),
    };
    deliver(app, '/unpost', body, 'bot unpost', 'bot asked to unpost').catch((err) => {
      app.log.error({ clipId, err }, 'unpostBot crashed');
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
      const res = await postToBot(app, '/voice-snapshot', { discordId }, VOICE_SNAPSHOT_TIMEOUT_MS);
      const body = await res.json();
      return { participants: Array.isArray(body?.participants) ? body.participants : [] };
    } catch (err) {
      app.log.warn({ err, discordId }, 'voiceSnapshot failed');
      return { participants: [] };
    }
  });

  /**
   * Which of `guildIds` the bot is in and `discordId` is a member of. Unlike voiceSnapshot this
   * one does fail, on purpose: the answer decides where a clip may be published, and "none of
   * them" would look to the user like they had been removed from every server. So a bot that is
   * down, slow, erroring or answering nonsense rejects, and the route turns that into a 503.
   *
   * With BOT_INTERNAL_URL unset (local dev) there is nobody to ask, and every guild passes, so
   * the publish dialog can still be exercised against a local backend.
   *
   * The answer is intersected with what was asked: the bot can narrow the list, never widen it.
   * @param {string} discordId
   * @param {string[]} guildIds
   * @returns {Promise<string[]>}
   */
  app.decorate('memberGuilds', async (discordId, guildIds) => {
    if (guildIds.length === 0) return [];
    if (!app.config.BOT_INTERNAL_URL) {
      app.log.debug({ discordId }, 'BOT_INTERNAL_URL unset, every configured guild is publishable');
      return [...guildIds];
    }
    const res = await postToBot(app, '/member-guilds', { discordId, guildIds }, MEMBER_GUILDS_TIMEOUT_MS);
    const body = await res.json();
    if (!Array.isArray(body?.guildIds)) {
      throw new Error('bot answered /member-guilds without a guildIds array');
    }
    const confirmed = new Set(body.guildIds);
    return guildIds.filter((id) => confirmed.has(id));
  });
}

// Decorators registered here must be visible to the whole app, not only to the
// encapsulation context of routes/internal.js which registers this plugin.
botPlugin[Symbol.for('skip-override')] = true;

export default botPlugin;
