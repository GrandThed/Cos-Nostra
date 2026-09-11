// Posts one clip to every configured guild channel and records the resulting message ids
// with the backend.
//
// The attachment-vs-link decision is made per guild, not per clip: the upload limit is a
// property of the guild's boost tier, so the same clip can go up as a playable attachment
// in a boosted guild and as a link everywhere else. Both paths play inline — the link path
// relies on Discord unfurling the player page into a native video embed, which is why this
// module never sends an embed of its own. See messageContent().
//
// Failure policy: a single guild never takes the whole post down. A channel that cannot be
// fetched, a download that fails, a backend write that errors, an emoji the bot may not
// use - all are logged and the loop moves on. Only data the whole post depends on (the clip
// itself, the guild list) rejects, so the caller's retry queue can replay the entire post.

import { AttachmentBuilder } from 'discord.js';

const MB = 1024 * 1024;

/**
 * Discord's per-message upload limit for a guild, by boost tier.
 *
 * These are Discord *policy* numbers, not protocol constants, and they have changed before:
 * the unboosted limit was 8 MB, then 25 MB, and is 10 MB today. Every limit lives in this
 * one helper so the next change is a one-line edit instead of a hunt.
 *
 * @param {number} premiumTier `guild.premiumTier` (discord.js `GuildPremiumTier`, 0-3)
 * @returns {number} limit in bytes
 */
export function uploadLimitBytes(premiumTier) {
  switch (Number(premiumTier)) {
    case 3:
      return 100 * MB;
    case 2:
      return 50 * MB;
    default:
      // Tier 0 and tier 1 share the default limit; anything unknown gets the safe floor.
      return 10 * MB;
  }
}

// The multipart envelope (boundaries, headers, the JSON payload) counts against the limit
// too, so only attach a file that is comfortably under it.
const SIZE_MARGIN = 0.95;

const MAX_CONTENT = 2000;
const MAX_TITLE = 256;

/**
 * @param {string} value
 * @param {number} max
 */
function truncate(value, max) {
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
}

/** @param {unknown} value */
function slug(value) {
  return String(value ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
}

/**
 * `<game>-<clipId>.mp4`, or just `<clipId>.mp4` when there is no game to name it after.
 * @param {Clip} clip
 */
function attachmentName(clip) {
  const id = slug(clip.id) || 'clip';
  const base = slug(clip.game) || id;
  return base === id ? `${id}.mp4` : `${base}-${id}.mp4`;
}

/** @param {Clip} clip */
function clipTitle(clip) {
  return truncate(clip.title || clip.game || 'Clip', MAX_TITLE);
}

/**
 * Message text, used on both paths.
 *
 * On the link path the URL is left bare on purpose: Discord turns the player page into a
 * native `type=video` embed from its og:video tags, and that preview is the only way to get
 * an inline player for a clip too big to attach. Wrapping the URL in angle brackets
 * suppresses the preview, so it is only wrapped when a real attachment is already playing
 * inline and a second player would be noise.
 * @param {Clip} clip
 * @param {{ unfurl: boolean }} opts  unfurl: let Discord build its video preview
 */
function messageContent(clip, { unfurl }) {
  const who = clip.owner?.username;
  const head = who ? `${clipTitle(clip)} - ${who}` : clipTitle(clip);
  const link = unfurl ? clip.urls.page : `<${clip.urls.page}>`;
  return truncate(`${head}\n${link}`, MAX_CONTENT);
}

/**
 * @param {any} channel
 * @returns {boolean} true when the channel can take a `send()`
 */
function isSendableText(channel) {
  if (!channel || typeof channel.send !== 'function') return false;
  if (typeof channel.isTextBased !== 'function') return false;
  return channel.isTextBased();
}

/**
 * @typedef {object} Clip
 * @property {string} id
 * @property {string | null} game
 * @property {string | null} title
 * @property {number | null} durationMs
 * @property {number | null} sizeH264
 * @property {string | null} recordedAt
 * @property {{ discordId: string, username: string }} owner
 * @property {{ h264: string, thumb: string, page: string }} urls
 */

/**
 * @typedef {object} GuildConfig
 * @property {string} guildId
 * @property {string} channelId
 * @property {string[]} seedEmojis
 */

/** @typedef {{ guildId: string, channelId: string, messageId: string }} PostedMessage */

/**
 * @param {object} options
 * @param {import('discord.js').Client} options.client
 * @param {{
 *   getClip: (clipId: string) => Promise<Clip | null>,
 *   listGuilds: () => Promise<{ items: GuildConfig[] }>,
 *   recordPost: (post: { clipId: string } & PostedMessage) => Promise<unknown>,
 * }} options.backend
 * @param {{ info?: Function, warn?: Function, error?: Function }} [options.log]
 * @param {typeof globalThis.fetch} [options.fetch] injected in tests
 * @returns {{ postClip: (clipId: string) => Promise<PostedMessage[]> }}
 */
export function createPoster({
  client,
  backend,
  log = console,
  fetch: fetchImpl = globalThis.fetch,
}) {
  /**
   * Downloads the H.264 copy at most once per post, however many guilds attach it.
   * `urls.h264` is a backend redirect to a presigned GET, which fetch follows by default.
   * @param {Clip} clip
   * @param {{ promise?: Promise<Buffer> }} cache
   * @returns {Promise<Buffer>}
   */
  function h264Bytes(clip, cache) {
    if (!cache.promise) {
      cache.promise = (async () => {
        const res = await fetchImpl(clip.urls.h264);
        if (!res.ok) throw new Error(`GET ${clip.urls.h264} failed with ${res.status}`);
        return Buffer.from(await res.arrayBuffer());
      })();
    }
    return cache.promise;
  }

  /**
   * @param {Clip} clip
   * @param {GuildConfig} config
   * @param {any} channel
   * @param {{ promise?: Promise<Buffer> }} cache
   * @returns {Promise<import('discord.js').MessageCreateOptions>}
   */
  async function buildPayload(clip, config, channel, cache) {
    const tier = channel.guild?.premiumTier ?? 0;
    const limit = uploadLimitBytes(tier);
    const size = Number(clip.sizeH264);
    const fits = Number.isFinite(size) && size > 0 && size < limit * SIZE_MARGIN;

    if (fits) {
      try {
        const bytes = await h264Bytes(clip, cache);
        log.info?.(
          `clip ${clip.id}: attaching ${size} B in guild ${config.guildId} (tier ${tier}, limit ${limit} B)`,
        );
        return {
          content: messageContent(clip, { unfurl: false }),
          files: [new AttachmentBuilder(bytes, { name: attachmentName(clip) })],
        };
      } catch (err) {
        // Small enough to attach, but we could not get the bytes. The link still works.
        log.warn?.(
          `clip ${clip.id}: H.264 download failed, posting an embed instead: ${err?.message ?? err}`,
        );
      }
    } else {
      log.info?.(
        `clip ${clip.id}: ${size} B over the ${limit} B limit of guild ${config.guildId} (tier ${tier}), posting an embed`,
      );
    }
    // Deliberately no embeds[]: Discord drops the link preview on any message that carries
    // an embed of its own, and that preview is what holds the video player. Measured on
    // 2026-09-11 — a rich embed plus a bare URL produced one `type=rich` embed and no
    // player, while the URL alone produced `type=video` at 1920x1080. The page's og: tags
    // already supply the title, owner, game, duration and thumbnail, so nothing is lost.
    return { content: messageContent(clip, { unfurl: true }) };
  }

  /**
   * Seed reactions are the bot's own, so the reaction tracker (which ignores the bot user)
   * never counts them as votes. Added one at a time: a custom emoji the bot may not use
   * throws, and that must not cost the guild the rest of its seeds.
   * @param {any} message
   * @param {GuildConfig} config
   */
  async function addSeedReactions(message, config) {
    for (const emoji of config.seedEmojis ?? []) {
      try {
        await message.react(emoji);
      } catch (err) {
        log.warn?.(
          `post ${message.id}: seed reaction ${emoji} failed in guild ${config.guildId}: ${err?.message ?? err}`,
        );
      }
    }
  }

  /**
   * @param {Clip} clip
   * @param {GuildConfig} config
   * @param {{ promise?: Promise<Buffer> }} cache
   * @returns {Promise<PostedMessage | null>}
   */
  async function postToGuild(clip, config, cache) {
    if (!config?.channelId) {
      // A guild row exists but /clips setup has not picked a channel yet.
      log.warn?.(`clip ${clip.id}: guild ${config?.guildId} has no clip channel, skipping`);
      return null;
    }

    let channel;
    try {
      channel = await client.channels.fetch(config.channelId);
    } catch (err) {
      log.warn?.(
        `clip ${clip.id}: channel ${config.channelId} of guild ${config.guildId} could not be fetched: ${err?.message ?? err}`,
      );
      return null;
    }
    if (!isSendableText(channel)) {
      log.warn?.(
        `clip ${clip.id}: channel ${config.channelId} of guild ${config.guildId} is missing or not a text channel`,
      );
      return null;
    }

    const payload = await buildPayload(clip, config, channel, cache);
    const message = await channel.send(payload);
    /** @type {PostedMessage} */
    const posted = {
      guildId: config.guildId,
      channelId: config.channelId,
      messageId: message.id,
    };

    try {
      await backend.recordPost({ clipId: clip.id, ...posted });
    } catch (err) {
      // The message is live whether or not the row landed, and the backend can reconcile it
      // through GET /internal/posts/:messageId. Reporting it as posted is what keeps a retry
      // from double-posting the clip.
      log.error?.(
        `clip ${clip.id}: message ${message.id} posted but recordPost failed: ${err?.message ?? err}`,
      );
    }

    await addSeedReactions(message, config);
    return posted;
  }

  return {
    /**
     * @param {string} clipId
     * @returns {Promise<PostedMessage[]>}
     */
    async postClip(clipId) {
      const clip = await backend.getClip(clipId);
      if (!clip) {
        // Deleted, or not finished uploading. Neither is worth a retry.
        log.warn?.(`clip ${clipId}: unknown to the backend, nothing posted`);
        return [];
      }

      // A guild list we cannot read is not a per-guild failure: returning [] here would
      // tell the caller the clip had been posted when it had not, so let it reject.
      // GET /internal/guilds answers `{ items }`; a bare array is accepted too so that a
      // change on the client side cannot turn posting into a silent no-op.
      const listed = await backend.listGuilds();
      const guilds = Array.isArray(listed) ? listed : (listed?.items ?? []);
      if (guilds.length === 0) {
        log.warn?.(`clip ${clipId}: no guild has a clip channel configured`);
      }

      /** @type {{ promise?: Promise<Buffer> }} */
      const cache = {};
      /** @type {PostedMessage[]} */
      const posted = [];
      for (const config of guilds) {
        try {
          const result = await postToGuild(clip, config, cache);
          if (result) posted.push(result);
        } catch (err) {
          log.error?.(
            `clip ${clipId}: posting to guild ${config?.guildId} failed: ${err?.message ?? err}`,
          );
        }
      }
      return posted;
    },
  };
}
