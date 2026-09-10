// The bot's only door to the backend. Wraps the shared API client so the rest of the bot
// speaks in domain verbs (recordPost, recordReaction) and never builds a URL or a header.
//
// Missing rows are normal here: a clip can be deleted between the notification and the post,
// and a guild has no config until someone runs /clips setup. Those two read as null. Every
// other failure keeps its ApiError so callers can look at .status and the outbox can retry.

import { createClient, ApiError } from '@cos-nostra/shared';

/**
 * @param {unknown} err
 * @returns {boolean}
 */
function isNotFound(err) {
  if (err instanceof ApiError) return err.status === 404;
  // Defensive: a client built against a different copy of the package still reports itself.
  return Boolean(err) && err.name === 'ApiError' && err.status === 404;
}

/**
 * @template T
 * @param {() => Promise<T>} call
 * @returns {Promise<T | null>}
 */
async function orNull(call) {
  try {
    return await call();
  } catch (err) {
    if (isNotFound(err)) return null;
    throw err;
  }
}

/**
 * @param {{ baseUrl: string, botToken: string, fetch?: typeof globalThis.fetch }} options
 */
export function createBackend({ baseUrl, botToken, fetch }) {
  const api = createClient({ baseUrl, botToken, fetch });

  return {
    /**
     * Clip with owner and URLs, or null when it is unknown or not ready yet.
     * @param {string} clipId
     */
    getClip: (clipId) => orNull(() => api.internalClip(clipId)),

    /**
     * Remember the Discord message a clip was posted as. Idempotent on messageId.
     * @param {{ clipId: string, guildId: string, channelId: string, messageId: string }} body
     */
    recordPost: ({ clipId, guildId, channelId, messageId }) =>
      api.internalPost({ clipId, guildId, channelId, messageId }),

    /**
     * One vote. Retried by the outbox, so it must stay safe to send twice: the backend
     * ignores a duplicate add and closing an already closed row is a no-op.
     * @param {{ messageId: string, userDiscordId: string, emoji: string, action: 'add' | 'remove' }} body
     */
    recordReaction: ({ messageId, userDiscordId, emoji, action }) =>
      api.recordReaction({ messageId, userDiscordId, emoji, action }),

    /**
     * Throws ApiError 404 when the message is not one of ours, which is how the reaction
     * listener tells our posts from every other message in the channel.
     * @param {string} messageId
     */
    getPost: (messageId) => api.getPost(messageId),

    /**
     * Guild configuration, or null when the guild has not been set up.
     * @param {string} guildId
     */
    getGuild: (guildId) => orNull(() => api.getGuild(guildId)),

    /**
     * @param {string} guildId
     * @param {{ channelId?: string | null, seedEmojis?: string[] }} body
     */
    putGuild: (guildId, { channelId, seedEmojis }) => api.putGuild(guildId, { channelId, seedEmojis }),

    /**
     * Every guild that has been set up. Wrapped in { items } by the backend, like the
     * other listings.
     * @returns {Promise<{ items: { guildId: string, channelId: string, seedEmojis: string[] }[] }>}
     */
    listGuilds: () => api.listGuilds(),

    /**
     * Starts a device login for /clips link. A public route, so it carries no auth; it is
     * here so the command uses the validated BACKEND_URL rather than reading the env again.
     * @param {string} deviceName
     * @returns {Promise<{ code: string, verifyUrl: string, expiresIn: number }>}
     */
    startDeviceLogin: (deviceName) => api.startDeviceLogin(deviceName),

    /** @param {import('@cos-nostra/shared').ClipListQuery} [query] */
    listClips: (query) => api.listClips(query),

    /** @param {{ guild?: string, year?: number, limit?: number }} query */
    getRankings: ({ guild, year, limit } = {}) => api.rankings({ guild, year, limit }),
  };
}
