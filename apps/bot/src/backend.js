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
     * Delete a clip everywhere: files, row, votes and every post of it. Bot-authenticated,
     * because the caller is a Discord button, not a device token.
     *
     * Unlike the reads above this one keeps its ApiError: 404 means the clip was already
     * gone, which every caller should treat as success (two people pressing Confirm, or a
     * double click), while anything else has to be visible. See registerManage in manage.js.
     * @param {string} clipId
     * @returns {Promise<void>}
     */
    deleteClip: (clipId) => api.internalDeleteClip(clipId),

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
     * Guild configuration - clip channel, seed emojis and reply language - or null when the
     * guild has not been set up. A guild that exists but never picked a language comes back
     * with the backend's default, so `locale` is always a supported code.
     * @param {string} guildId
     * @returns {Promise<import('@cos-nostra/shared').GuildSettings | null>}
     */
    getGuild: (guildId) => orNull(() => api.getGuild(guildId)),

    /**
     * The PUT replaces the row, so every field the caller still wants has to be in the body.
     * `locale`, `tagVoiceMembers`, `name` and `slug` are exceptions: leaving any of them out
     * keeps whatever the guild has, which is what /clips setup relies on when the admin only
     * changed the channel and what /clips config relies on when they only changed the emojis.
     * `icon` is different - `null` explicitly clears a removed custom icon - so it is sent
     * whenever given, `null` included.
     * @param {string} guildId
     * @param {{
     *   channelId?: string | null,
     *   seedEmojis?: string[],
     *   locale?: import('@cos-nostra/shared').Locale,
     *   tagVoiceMembers?: boolean,
     *   name?: string,
     *   icon?: string | null,
     *   slug?: string,
     * }} body
     */
    putGuild: (guildId, { channelId, seedEmojis, locale, tagVoiceMembers, name, icon, slug }) =>
      api.putGuild(guildId, {
        channelId,
        seedEmojis,
        ...(locale ? { locale } : {}),
        ...(typeof tagVoiceMembers === 'boolean' ? { tagVoiceMembers } : {}),
        ...(name ? { name } : {}),
        ...(icon !== undefined ? { icon } : {}),
        ...(slug ? { slug } : {}),
      }),

    /**
     * Every guild that has been set up. Wrapped in { items } by the backend, like the
     * other listings.
     * @returns {Promise<{ items: import('@cos-nostra/shared').GuildSettings[] }>}
     */
    listGuilds: () => api.listGuilds(),

    // No startDeviceLogin here on purpose. The response's `pollSecret` is the only thing that
    // can finish a device login and it is shown once, so a login started from the bot could
    // never be collected by the desktop, which starts its own. /clips link explains where the
    // button is instead; see handleLink in commands.js.

    /** @param {import('@cos-nostra/shared').ClipListQuery} [query] */
    listClips: (query) => api.listClips(query),

    /** @param {{ guild?: string, year?: number, limit?: number }} query */
    getRankings: ({ guild, year, limit } = {}) => api.rankings({ guild, year, limit }),
  };
}
