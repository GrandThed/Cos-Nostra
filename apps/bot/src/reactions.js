// Reaction tracking: turns Discord reaction events into votes on clip posts.
//
// Every accepted reaction becomes a job on the outbox instead of a direct backend call, so a
// backend restart or a Railway deploy delays votes rather than losing them. The backend route
// (POST /internal/reactions) is idempotent and append-only: an 'add' inserts a row only when no
// open one matches, a 'remove' stamps removed_at on the open row it finds. So this module owes
// the backend exactly one faithfully reported event per Discord event, with an emoji key that
// pairs an add with its later remove.
//
// The discord.js event names are string literals on purpose: nothing here needs discord.js at
// runtime, which keeps the unit test free of a gateway client.

/** Message ids to remember. Bounded so a chatty guild cannot grow the map without limit. */
const CACHE_CAP = 500;

/**
 * How long a "the backend does not know this message" answer is trusted. Positive answers never
 * expire (a post row is never deleted under us), but a negative one can be a race: the bot posts
 * a clip and registers the message a round trip later, so a reaction in that window must not be
 * written off for the lifetime of the process.
 */
const UNKNOWN_TTL_MS = 60_000;

const noop = () => {};

/**
 * "The backend has no post row for this message." backend.getPost reports that by throwing the
 * shared client's ApiError with status 404; a null or undefined result is accepted as the same
 * answer so this module does not care which of the two contracts it is handed. Checked by shape
 * rather than `instanceof ApiError` to keep this file free of imports and easy to fake in tests.
 *
 * @param {unknown} err
 */
function isNotFound(err) {
  return Boolean(err) && Number(/** @type {{ status?: unknown }} */ (err).status) === 404;
}

/**
 * @typedef {object} ReactionJob
 * @property {string} messageId
 * @property {string} userDiscordId
 * @property {string} emoji
 * @property {'add' | 'remove'} action
 */

/**
 * Storage key for a reaction emoji, used for both add and remove so the backend can pair them.
 * Unicode emoji are stored as the raw character, custom emoji as `name:id` ("pog:1234"), which
 * stays readable in the database and can never collide with a unicode emoji of the same name.
 *
 * Deliberately not discord.js's `emoji.identifier`: that percent-encodes unicode names and
 * prefixes animated custom emoji with "a:", and the reaction-remove gateway payload does not
 * reliably carry the animated flag, so one emoji could key differently on add and on remove and
 * the remove would never close the row the add opened.
 *
 * @param {{ id?: string | null, name?: string | null } | null | undefined} emoji
 * @returns {string | null} null when Discord sent neither a name nor an id
 */
export function emojiKey(emoji) {
  const id = emoji?.id ?? null;
  const name = emoji?.name ?? null;
  // A deleted custom emoji can arrive with a null name; the id alone still pairs add with remove.
  if (id) return name ? `${name}:${id}` : String(id);
  return name || null;
}

/**
 * Bounded map of message id -> "the backend knows this message". Insertion ordered, so the
 * oldest entry is the first key; negative entries also expire (see UNKNOWN_TTL_MS).
 * @param {{ cap?: number, ttlMs?: number }} [options]
 */
function createMessageCache({ cap = CACHE_CAP, ttlMs = UNKNOWN_TTL_MS } = {}) {
  /** @type {Map<string, { known: boolean, at: number }>} */
  const entries = new Map();
  return {
    /**
     * @param {string} messageId
     * @returns {boolean | undefined} undefined when nothing is cached
     */
    get(messageId) {
      const hit = entries.get(messageId);
      if (!hit) return undefined;
      if (!hit.known && Date.now() - hit.at >= ttlMs) {
        entries.delete(messageId);
        return undefined;
      }
      return hit.known;
    },
    /**
     * @param {string} messageId
     * @param {boolean} known
     */
    set(messageId, known) {
      entries.delete(messageId); // re-insert so the eviction order is insertion order
      entries.set(messageId, { known, at: Date.now() });
      while (entries.size > cap) {
        const oldest = entries.keys().next().value;
        entries.delete(oldest);
      }
    },
  };
}

/** @param {unknown} err */
function errorText(err) {
  return /** @type {Error} */ (err)?.message ?? String(err);
}

/**
 * Accepts the bot's console logger, a partial one, or nothing at all: a missing method must not
 * be able to throw inside an event handler.
 * @param {Partial<Record<'debug' | 'info' | 'warn' | 'error', Function>> | undefined} log
 */
function safeLog(log) {
  /** @param {string} name @param {string} [fallback] */
  const pick = (name, fallback) => {
    if (typeof log?.[name] === 'function') return log[name].bind(log);
    if (fallback && typeof log?.[fallback] === 'function') return log[fallback].bind(log);
    return noop;
  };
  // debug has no fallback on purpose: skipped reactions are the common case and must stay quiet.
  return {
    debug: pick('debug'),
    info: pick('info'),
    warn: pick('warn'),
    error: pick('error', 'warn'),
  };
}

/**
 * Attaches the reaction handlers to a client (logged in or not yet).
 *
 * @param {object} deps
 * @param {import('node:events').EventEmitter & { user?: { id: string } | null }} deps.client
 * @param {{ getPost(messageId: string): Promise<unknown> }} deps.backend  an unknown message is
 *   either a null result or a thrown ApiError with status 404; both mean "not one of our posts"
 * @param {{ enqueue(job: ReactionJob): void }} deps.outbox  fire and forget, retries internally
 * @param {Partial<Record<'debug' | 'info' | 'warn' | 'error', Function>>} [deps.log]
 * @returns {void}
 */
export function registerReactions({ client, backend, outbox, log }) {
  if (typeof client?.on !== 'function') {
    throw new TypeError('registerReactions: client is required');
  }
  if (typeof backend?.getPost !== 'function') {
    throw new TypeError('registerReactions: backend.getPost is required');
  }
  if (typeof outbox?.enqueue !== 'function') {
    throw new TypeError('registerReactions: outbox.enqueue is required');
  }

  const logger = safeLog(log);
  const cache = createMessageCache();
  /**
   * Lookups that have not answered yet, so a burst shares one request.
   * @type {Map<string, Promise<boolean>>}
   */
  const inFlight = new Map();

  /**
   * Is this message one of our clip posts? Cached both ways, and reactions that arrive in the
   * same burst (a fresh clip post, or a busy channel) share the one request rather than each
   * asking. Rejects only on a failure that is worth retrying; an unknown message is `false`.
   *
   * @param {string} messageId
   * @returns {Promise<boolean>}
   */
  function isClipPost(messageId) {
    const cached = cache.get(messageId);
    if (cached !== undefined) return Promise.resolve(cached);

    let pending = inFlight.get(messageId);
    if (!pending) {
      pending = (async () => {
        let known;
        try {
          const post = await backend.getPost(messageId);
          known = post !== null && post !== undefined;
        } catch (err) {
          // The real backend.getPost throws ApiError 404 for a message it has no post row for.
          if (!isNotFound(err)) throw err;
          known = false;
        }
        cache.set(messageId, known);
        return known;
      })();
      inFlight.set(messageId, pending);
      // Free the slot whichever way it settles. The catch is what keeps a rejection that every
      // awaiter handles anyway from being reported as unhandled, and it must not be attached to
      // `pending` itself or awaiters would see a resolved promise.
      pending.catch(noop).finally(() => inFlight.delete(messageId));
    }
    return pending;
  }

  /**
   * @param {'add' | 'remove'} action
   * @param {import('discord.js').MessageReaction} reaction
   * @param {import('discord.js').User} user
   */
  async function handle(action, reaction, user) {
    // 1. Resolve partials. With Partials.Message and Partials.Reaction the gateway delivers
    //    reactions on messages the bot never saw, and nothing but the ids is readable until the
    //    structures are fetched. A deleted message or a lost channel makes the fetch fail; that
    //    is a warning and a skip, never a throw.
    if (reaction?.partial) {
      try {
        // MessageReaction#fetch fetches the message too, so this usually covers both partials.
        await reaction.fetch();
      } catch (err) {
        const id = reaction?.message?.id ?? 'unknown';
        logger.warn(`reaction ${action} on ${id}: fetch failed, skipped: ${errorText(err)}`);
        return;
      }
    }
    if (reaction?.message?.partial) {
      try {
        await reaction.message.fetch();
      } catch (err) {
        const id = reaction?.message?.id ?? 'unknown';
        logger.warn(`reaction ${action} on ${id}: message fetch failed, skipped: ${errorText(err)}`);
        return;
      }
    }

    const messageId = reaction?.message?.id;
    if (!messageId) {
      logger.warn(`reaction ${action} without a message id, skipped`);
      return;
    }

    const userDiscordId = user?.id;
    if (!userDiscordId) {
      logger.warn(`reaction ${action} on message ${messageId} without a user id, skipped`);
      return;
    }

    // 2. Never count a bot. The poster seeds two or three emojis on every clip so people have
    //    something to click; those are ours and are not votes. Other bots are ignored too.
    if (client.user?.id && userDiscordId === client.user.id) {
      logger.debug(`reaction ${action} on message ${messageId} is our own seed, ignored`);
      return;
    }
    if (user?.bot) {
      logger.debug(`reaction ${action} on message ${messageId} by bot ${userDiscordId}, ignored`);
      return;
    }

    // 3. Only messages the backend knows are clip posts, and in a busy guild almost none are.
    //    Cache both answers so the same unrelated message is not looked up over and over.
    let known;
    try {
      known = await isClipPost(messageId);
    } catch (err) {
      // Nothing is cached on a real failure, so the next reaction asks again instead of
      // inheriting a guess. Losing this one vote is the cost of not writing a wrong one.
      logger.warn(
        `reaction ${action} on ${messageId}: post lookup failed, skipped: ${errorText(err)}`,
      );
      return;
    }
    if (!known) {
      logger.debug(`reaction ${action} on message ${messageId} is not one of our posts, ignored`);
      return;
    }

    // 4. One emoji representation for add and remove; see emojiKey.
    const emoji = emojiKey(reaction?.emoji);
    if (!emoji) {
      logger.warn(`reaction ${action} on message ${messageId} has no emoji name or id, skipped`);
      return;
    }

    // 5. Hand it to the outbox, which retries, so a backend deploy cannot lose the vote.
    /** @type {ReactionJob} */
    const job = { messageId, userDiscordId, emoji, action };
    try {
      outbox.enqueue(job);
    } catch (err) {
      logger.warn(
        `reaction ${action} ${emoji} on message ${messageId}: could not enqueue: ${errorText(err)}`,
      );
      return;
    }
    logger.info(`reaction ${action} ${emoji} on message ${messageId} by ${userDiscordId}, queued`);
  }

  /**
   * discord.js emits synchronously and ignores the returned promise, so an unhandled rejection
   * here would take the process down. handle() contains its own failures; this is the last
   * resort for anything unforeseen.
   * @param {'add' | 'remove'} action
   */
  const listener = (action) => (reaction, user) => {
    handle(action, reaction, user).catch((err) => {
      logger.error(`reaction ${action} handler failed: ${err?.stack ?? errorText(err)}`);
    });
  };

  client.on('messageReactionAdd', listener('add'));
  client.on('messageReactionRemove', listener('remove'));
}
