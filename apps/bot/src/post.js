// Posts one clip to the guild channels it is meant for and records the resulting message ids
// with the backend.
//
// Which guilds those are is resolved here, not by the backend (see resolveTargets()). A clip
// published from a current desktop build carries the servers its owner picked, and each one
// must still have a clip channel and still have the owner as a member when the post happens:
// the backend only knows what was picked, and only the bot can ask Discord who is in a guild.
// A clip from an older build carries no targets and goes to every configured guild, as it
// always did. Guilds that already show a live post of the clip are skipped either way, which
// is what makes a retried notification or a second "post to more servers" safe.
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

import { resolveLocale, t } from './i18n.js';
import { manageRow } from './manage.js';
import { isMember } from './members.js';

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
 * Everyone this post is allowed to ping: the owner, plus whoever was in their voice channel
 * when they pressed the hotkey.
 *
 * `parse: []` stays on every payload, so the only mentions that fire are the ids listed here.
 * That is what keeps the rest of the message inert: the title and the game name come from the
 * desktop app, so a clip titled "@everyone" or "<@&12345>" still renders as text, because
 * `allowedMentions.users` is an allow-list of ids and not a blessing for whatever the content
 * happens to contain.
 *
 * Participants are dropped when the guild has turned voice tagging off. `undefined` counts as
 * on, matching the backend column's default: a guild that has never touched the setting gets
 * the feature.
 *
 * @param {Clip} clip
 * @param {GuildConfig} [config]
 * @returns {string[]} deduped, owner first
 */
export function mentionedIds(clip, config) {
  const others = config?.tagVoiceMembers !== false ? (clip?.participants ?? []) : [];
  return [clip?.owner?.discordId, ...others].filter(
    (id, i, arr) => typeof id === 'string' && id.length > 0 && arr.indexOf(id) === i,
  );
}

/**
 * The mention allow-list for one message. A fresh object and a fresh array per message,
 * because discord.js resolves the payload it is handed in place.
 * @param {Clip} clip
 * @param {GuildConfig} [config]
 * @returns {import('discord.js').MessageMentionOptions}
 */
function mentions(clip, config) {
  return { parse: [], users: mentionedIds(clip, config) };
}

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

/** @param {Clip} clip @param {import('@cos-nostra/shared').Locale} locale */
function clipTitle(clip, locale) {
  return truncate(clip.title || clip.game || t(locale, 'post.defaultTitle'), MAX_TITLE);
}

/**
 * Message text, used on both paths.
 *
 * On the link path the URL is left bare on purpose: Discord turns the player page into a
 * native `type=video` embed from its og:video tags, and that preview is the only way to get
 * an inline player for a clip too big to attach. Wrapping the URL in angle brackets
 * suppresses the preview, so it is only wrapped when a real attachment is already playing
 * inline and a second player would be noise.
 *
 * The language is the destination guild's, not the uploader's: the same clip goes out in
 * Spanish to one server and in English to another in the same postClip() run.
 *
 * The owner is named with `<@id>` rather than with the username the backend stored: it is a
 * real ping, it renders the nickname each reader knows them by, and it survives a rename.
 * Everyone else who was in the voice channel follows in the same form. Only the ids in
 * mentionedIds() actually notify - see mentions().
 *
 * @param {Clip} clip
 * @param {{
 *   unfurl: boolean,
 *   locale: import('@cos-nostra/shared').Locale,
 *   config?: GuildConfig,
 * }} opts
 *   unfurl: let Discord build its video preview
 */
function messageContent(clip, { unfurl, locale, config }) {
  const title = clipTitle(clip, locale);
  const [owner, ...others] = mentionedIds(clip, config);
  // An owner with no Discord id should not happen, but a clip is not worth losing over it.
  const who = owner ? `<@${owner}>` : clip.owner?.username;
  let head = who ? t(locale, 'post.byOwner', { title, user: who }) : title;
  if (others.length > 0) {
    const withThem = t(locale, 'post.withOthers', {
      mentions: others.map((id) => `<@${id}>`).join(' '),
    });
    head = `${head} ${withThem}`;
  }
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
 * @property {string[]} participants  Discord ids of everyone who was in the owner's voice
 *   channel when the hotkey was pressed, recorded by the desktop app at capture time
 * @property {{ h264: string, thumb: string, page: string }} urls
 * @property {string[] | null} [targetGuildIds]  the servers the owner picked when publishing;
 *   null (or absent, from a backend older than publish-on-demand) means every configured guild
 * @property {PostedMessage[]} [posts]  the clip's live Discord posts, one per guild at most
 */

/**
 * @typedef {object} GuildConfig
 * @property {string} guildId
 * @property {string} channelId
 * @property {string[]} seedEmojis
 * @property {import('@cos-nostra/shared').Locale} [locale]
 * @property {boolean} [tagVoiceMembers]  undefined means on, like the backend's default
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
 * @returns {{ postClip: (clipId: string, guildIds?: string[] | null) => Promise<PostedMessage[]> }}
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
    // GET /internal/guilds carries the locale, so posting needs no extra round trip for it.
    const locale = resolveLocale(config.locale);

    if (fits) {
      try {
        const bytes = await h264Bytes(clip, cache);
        log.info?.(
          `clip ${clip.id}: attaching ${size} B in guild ${config.guildId} (tier ${tier}, limit ${limit} B)`,
        );
        return {
          content: messageContent(clip, { unfurl: false, locale, config }),
          files: [new AttachmentBuilder(bytes, { name: attachmentName(clip) })],
          allowedMentions: mentions(clip, config),
          // Components are not embeds: they sit in their own field and leave the link
          // unfurl alone, so the button can ride along on both paths.
          components: [manageRow(clip.id)],
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
    // `components` is a different field and does not suppress the unfurl, which is how the
    // manage button can sit under a post that still plays inline.
    return {
      content: messageContent(clip, { unfurl: true, locale, config }),
      allowedMentions: mentions(clip, config),
      components: [manageRow(clip.id)],
    };
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

  /**
   * Whether the clip's owner is in the guild, answering false - with a warning - whenever
   * Discord cannot say yes. Posting someone's clip into a server they are not in is the one
   * outcome this check exists to prevent, so "could not tell" errs on the side of not posting.
   * @param {Clip} clip
   * @param {string} guildId
   * @returns {Promise<boolean>}
   */
  async function ownerIsMember(clip, guildId) {
    const ownerId = clip.owner?.discordId;
    if (!ownerId) {
      log.warn?.(`clip ${clip.id}: owner has no Discord id, cannot check guild ${guildId}`);
      return false;
    }
    let guild;
    try {
      // The Guilds intent keeps the cache complete; the fetch is for the moments it is not,
      // such as a guild that became available again after an outage.
      guild = client.guilds?.cache?.get(guildId) ?? (await client.guilds.fetch(guildId));
    } catch (err) {
      log.warn?.(`clip ${clip.id}: guild ${guildId} is not reachable by the bot: ${err?.message ?? err}`);
      return false;
    }
    try {
      if (await isMember(guild, ownerId)) return true;
      log.warn?.(`clip ${clip.id}: owner ${ownerId} is not a member of guild ${guildId}, skipping`);
    } catch (err) {
      log.warn?.(
        `clip ${clip.id}: membership of ${ownerId} in guild ${guildId} could not be checked, skipping: ${err?.message ?? err}`,
      );
    }
    return false;
  }

  /**
   * The configured guilds this post goes to, and whether each still needs the owner's
   * membership confirmed before it gets the clip.
   *
   * `wanted = guildIds ?? clip.targetGuildIds`, so an explicit list from POST /post (a "post to
   * more servers" call) wins over what was picked at publish time. Null there is the legacy
   * clip: every configured guild, no membership check, exactly as before targets existed.
   *
   * @param {Clip} clip
   * @param {GuildConfig[]} guilds  every configured guild
   * @param {string[] | null | undefined} guildIds
   * @returns {{ targets: GuildConfig[], checkMembership: boolean }}
   */
  function resolveTargets(clip, guilds, guildIds) {
    const raw = guildIds ?? clip.targetGuildIds ?? null;
    if (raw !== null && !Array.isArray(raw)) {
      // Not "every guild": a malformed target list must never widen into posting everywhere.
      throw new TypeError(`clip ${clip.id}: target guild list is not an array`);
    }
    const wanted = raw === null ? null : new Set(raw.map(String));
    const live = new Set((clip.posts ?? []).map((post) => String(post?.guildId)));

    if (wanted) {
      const configured = new Set(guilds.map((config) => String(config?.guildId)));
      const unknown = [...wanted].filter((guildId) => !configured.has(guildId));
      if (unknown.length > 0) {
        log.info?.(`clip ${clip.id}: guild(s) ${unknown.join(', ')} are not configured, skipping`);
      }
    }

    const targets = guilds.filter((config) => {
      const guildId = String(config?.guildId);
      if (wanted && !wanted.has(guildId)) return false;
      if (live.has(guildId)) {
        log.info?.(`clip ${clip.id}: already posted in guild ${guildId}, skipping`);
        return false;
      }
      return true;
    });
    return { targets, checkMembership: wanted !== null };
  }

  return {
    /**
     * @param {string} clipId
     * @param {string[] | null} [guildIds]  overrides the clip's own targets when given
     * @returns {Promise<PostedMessage[]>}
     */
    async postClip(clipId, guildIds) {
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
      const { targets, checkMembership } = resolveTargets(clip, guilds, guildIds);

      /** @type {{ promise?: Promise<Buffer> }} */
      const cache = {};
      /** @type {PostedMessage[]} */
      const posted = [];
      for (const config of targets) {
        try {
          if (checkMembership && !(await ownerIsMember(clip, config.guildId))) continue;
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
