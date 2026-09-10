// Slash commands: one top-level /clips with five subcommands (docs/PLAN.md, phase 4).
//
//   /clips setup channel:<#channel>   store the clip channel for this guild (Manage Server)
//   /clips latest                     the newest ready clip, as an embed
//   /clips top [year] [game]          the yearly leaderboard for this guild
//   /clips mine                       the caller's own clips, ephemeral
//   /clips link                       start a device login for the desktop app, ephemeral
//
// Every subcommand defers first: Discord discards an interaction that is not acknowledged in
// three seconds and all five have to cross the network to the backend. Ephemeral-ness is
// fixed at defer time, which is why the defer, not the edit, carries the flag.
//
// The backend is injected (apps/bot/src/backend.js) so tests never touch HTTP. Errors are
// duck-typed (name 'ApiError' or a numeric status) rather than imported from
// @cos-nostra/shared, so this module keeps discord.js as its only import.

import {
  ChannelType,
  EmbedBuilder,
  MessageFlags,
  PermissionFlagsBits,
  SlashCommandBuilder,
} from 'discord.js';

/** Brand red, shared by every embed the bot posts. */
const COLOR = 0xc4302b;

/** Channel types /clips setup accepts. Both are text channels a bot can post clips into. */
const TEXT_CHANNELS = [ChannelType.GuildText, ChannelType.GuildAnnouncement];

/** Subcommands whose reply only the caller should see. */
const EPHEMERAL = new Set(['setup', 'mine', 'link']);

/** Device-login method names, most likely first. packages/shared calls it startDeviceLogin. */
const DEVICE_LOGIN_METHODS = ['startDeviceLogin', 'createDeviceLogin', 'deviceLogin', 'startLogin'];

// ---- command definition ----------------------------------------------------------------

// A note on permissions. Discord only accepts default_member_permissions on a top-level
// command, and /clips carries four subcommands every member is meant to use, so putting
// ManageGuild here would hide /clips latest, top, mine and link from everyone without it.
// The gate for /clips setup is therefore the runtime check in handleSetup, which is the one
// that actually holds in any case: a server admin can override default permissions per guild.
const clips = new SlashCommandBuilder()
  .setName('clips')
  .setDescription('Cos Nostra clips')
  .addSubcommand((sub) =>
    sub
      .setName('setup')
      .setDescription('Choose the channel new clips are posted to (needs Manage Server)')
      .addChannelOption((opt) =>
        opt
          .setName('channel')
          .setDescription('Text channel for new clips')
          .addChannelTypes(...TEXT_CHANNELS)
          .setRequired(true),
      ),
  )
  .addSubcommand((sub) => sub.setName('latest').setDescription('Show the most recent clip'))
  .addSubcommand((sub) =>
    sub
      .setName('top')
      .setDescription('Leaderboard of the most reacted clips')
      .addIntegerOption((opt) =>
        opt
          .setName('year')
          .setDescription('Year to rank (defaults to the current year)')
          .setMinValue(2000)
          .setMaxValue(2100),
      )
      .addStringOption((opt) =>
        opt.setName('game').setDescription('Only clips from this game').setMaxLength(200),
      ),
  )
  .addSubcommand((sub) =>
    sub.setName('mine').setDescription('Show your own clips (only you see the reply)'),
  )
  .addSubcommand((sub) =>
    sub.setName('link').setDescription('Link the Cos Nostra desktop app to your Discord account'),
  );

/**
 * Command payloads ready for Discord's REST API. Consumed by src/deploy-commands.js.
 * @type {import('discord.js').RESTPostAPIApplicationCommandsJSONBody[]}
 */
export const commands = [clips.toJSON()];

// ---- formatting ------------------------------------------------------------------------

/** @param {unknown} value */
function isHttpUrl(value) {
  return typeof value === 'string' && /^https?:\/\//i.test(value);
}

/** @param {number | null | undefined} ms */
function formatDuration(ms) {
  const seconds = Math.max(0, Math.round(Number(ms ?? 0) / 1000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}

/** @param {unknown} n */
function reactorCount(n) {
  const count = Number(n ?? 0);
  return `${count} reactor${count === 1 ? '' : 's'}`;
}

/** Best available human label for a clip. @param {any} clip */
function clipLabel(clip) {
  return String(clip?.title || clip?.game || 'Untitled clip').slice(0, 120);
}

/** Markdown link to the player page, or bare text when the clip has no page URL. */
function clipLink(clip) {
  const label = clipLabel(clip).replace(/([[\]])/g, '\\$1');
  return isHttpUrl(clip?.urls?.page) ? `[${label}](${clip.urls.page})` : label;
}

/** @param {any} clip */
function ownerName(clip) {
  return clip?.owner?.username || 'someone';
}

/** ISO string to a Date the embed builder accepts, or null. @param {unknown} iso */
function parsedDate(iso) {
  if (!iso) return null;
  const date = new Date(/** @type {string} */ (iso));
  return Number.isNaN(date.getTime()) ? null : date;
}

/**
 * Embed for a single clip: the thumbnail plus a link to the player page.
 * @param {any} clip
 */
function clipEmbed(clip) {
  const embed = new EmbedBuilder().setColor(COLOR).setTitle(clipLabel(clip));
  if (isHttpUrl(clip?.urls?.page)) embed.setURL(clip.urls.page);
  if (isHttpUrl(clip?.urls?.thumb)) embed.setImage(clip.urls.thumb);
  embed.addFields(
    { name: 'Game', value: String(clip?.game || 'Unknown'), inline: true },
    { name: 'Length', value: formatDuration(clip?.durationMs), inline: true },
    { name: 'Reactions', value: String(Number(clip?.reactions ?? 0)), inline: true },
  );
  embed.setFooter({ text: `Clipped by ${ownerName(clip)}` });
  const recorded = parsedDate(clip?.recordedAt);
  if (recorded) embed.setTimestamp(recorded);
  return embed;
}

// ---- errors ----------------------------------------------------------------------------

/**
 * ApiError from packages/shared, recognised without importing it.
 * @param {any} err
 */
function isApiError(err) {
  return Boolean(err) && (err.name === 'ApiError' || typeof err.status === 'number');
}

/** One line a Discord user can act on. @param {any} err */
function humanError(err) {
  const status = isApiError(err) ? Number(err.status) : 0;
  if (status === 401 || status === 403) {
    return 'The bot is not allowed to talk to the Cos Nostra backend. An admin should check BOT_SHARED_SECRET.';
  }
  if (status === 404) return 'The backend has nothing for that yet.';
  if (status === 429) return 'The backend is rate limiting us. Try again in a minute.';
  if (status >= 500) return 'The Cos Nostra backend is having a moment. Try again shortly.';
  if (status >= 400) return 'The backend rejected that request, so nothing changed.';
  return 'Could not reach the Cos Nostra backend. Try again in a moment.';
}

/** @param {any} err */
function errorText(err) {
  return err?.stack ?? err?.message ?? String(err);
}

/**
 * Logger that tolerates a partial `log` object. index.js passes { error, warn, info, debug }
 * whose methods take printf-style arguments, so every message here is a single string.
 * @param {{ error?: Function, warn?: Function, info?: Function } | undefined} log
 */
function normalizeLog(log) {
  const target = log ?? console;
  /** @param {'error' | 'warn' | 'info'} name */
  const pick = (name) =>
    typeof target[name] === 'function' ? target[name].bind(target) : console.error.bind(console);
  return { error: pick('error'), warn: pick('warn'), info: pick('info') };
}

// ---- device login ----------------------------------------------------------------------

/**
 * Starts a device login for /clips link.
 *
 * backend.js does not expose the device-login call today (it is a public route, not an
 * /internal one), so this falls back to POST /auth/device directly. Add startDeviceLogin to
 * backend.js and the first branch takes over with no change here.
 *
 * @param {any} backend
 * @param {string} deviceName
 * @returns {Promise<{ code?: string, verifyUrl?: string, verificationUrl?: string, expiresIn?: number } | null>}
 */
async function startDeviceLogin(backend, deviceName) {
  const method = DEVICE_LOGIN_METHODS.find((name) => typeof backend?.[name] === 'function');
  if (method) return backend[method](deviceName);

  const baseUrl = String(backend?.baseUrl ?? process.env.BACKEND_URL ?? '').replace(/\/+$/, '');
  if (!baseUrl) return null;
  const res = await fetch(`${baseUrl}/auth/device`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({ deviceName }),
  });
  if (!res.ok) {
    // Shaped like the shared ApiError so humanError() treats it the same way.
    const err = new Error(`POST /auth/device failed with status ${res.status}`);
    err.name = 'ApiError';
    err.status = res.status;
    throw err;
  }
  return res.json();
}

// ---- subcommand handlers ---------------------------------------------------------------

/**
 * @typedef {object} HandlerContext
 * @property {any} backend  apps/bot/src/backend.js
 * @property {{ error: Function, warn: Function, info: Function }} log
 */

/**
 * /clips setup - remember the clip channel for this guild.
 * @param {any} interaction
 * @param {HandlerContext} ctx
 */
async function handleSetup(interaction, { backend, log }) {
  if (!interaction.guildId) {
    return interaction.editReply({ content: 'Run this in the server you want clips posted to.' });
  }

  // The gate that counts: default_member_permissions cannot be scoped to one subcommand and
  // can be overridden per guild, so the invoking member is checked here.
  const permissions = interaction.memberPermissions;
  if (!permissions || !permissions.has(PermissionFlagsBits.ManageGuild)) {
    log.info(
      `/clips setup refused for ${interaction.user?.id} in ${interaction.guildId}: no Manage Server`,
    );
    return interaction.editReply({
      content: 'You need the **Manage Server** permission to change the clip channel.',
    });
  }

  const channel = interaction.options.getChannel('channel');
  if (!channel || !TEXT_CHANNELS.includes(channel.type)) {
    return interaction.editReply({
      content: 'Pick a normal text channel. Clips cannot be posted to that one.',
    });
  }

  // PUT replaces the row, so read the current config and hand the seed emojis back rather
  // than dropping them. getGuild returns null for a guild that was never set up.
  const existing = await backend.getGuild(interaction.guildId);
  const seedEmojis = existing?.seedEmojis ?? undefined;
  const saved = await backend.putGuild(interaction.guildId, { channelId: channel.id, seedEmojis });

  const seeds = saved?.seedEmojis ?? seedEmojis;
  const seedLine = Array.isArray(seeds) && seeds.length > 0 ? ` Seed reactions: ${seeds.join(' ')}` : '';
  log.info(`clip channel for guild ${interaction.guildId} set to ${channel.id}`);
  return interaction.editReply({
    content: `New clips will be posted to <#${channel.id}>.${seedLine}`,
  });
}

/**
 * /clips latest - the newest ready clip.
 * @param {any} interaction
 * @param {HandlerContext} ctx
 */
async function handleLatest(interaction, { backend }) {
  const { items = [] } = (await backend.listClips({ sort: 'recent', limit: 1 })) ?? {};
  const clip = items[0];
  if (!clip) {
    return interaction.editReply({
      content: 'No clips yet. Press the hotkey in a game and this will fill up.',
    });
  }
  return interaction.editReply({ embeds: [clipEmbed(clip)] });
}

/**
 * /clips top - the yearly leaderboard for this guild.
 * @param {any} interaction
 * @param {HandlerContext} ctx
 */
async function handleTop(interaction, { backend }) {
  if (!interaction.guildId) {
    return interaction.editReply({ content: 'Rankings are per server, so run this in one.' });
  }
  const year = interaction.options.getInteger('year') ?? new Date().getUTCFullYear();
  const game = interaction.options.getString('game');

  const { items = [] } =
    (await backend.getRankings({ guild: interaction.guildId, year, limit: 10 })) ?? {};

  // GET /rankings has no game filter (apps/backend/src/routes/clips.js), so the filter runs
  // here, over the top ten the backend returned. The footer says so, because "the top three
  // Rocket League clips of the year's top ten" is not "the top three Rocket League clips".
  const wanted = game?.trim().toLowerCase();
  const rows = wanted
    ? items.filter((row) => String(row?.clip?.game ?? '').trim().toLowerCase() === wanted)
    : items;

  if (rows.length === 0) {
    return interaction.editReply({
      content: game
        ? `No ranked ${game} clips in ${year} yet.`
        : `No clips have been reacted to in ${year} yet.`,
    });
  }

  const lines = rows.map((row, i) => {
    const clip = row?.clip ?? {};
    const parts = [ownerName(clip), clip.game || 'Unknown', reactorCount(row?.distinctReactors)];
    return `**${i + 1}.** ${clipLink(clip)} - ${parts.join(' - ')}`;
  });

  const embed = new EmbedBuilder()
    .setColor(COLOR)
    .setTitle(`Top clips of ${year}`)
    .setDescription(lines.join('\n'));
  if (game) embed.setFooter({ text: `Filtered to ${game} within this year's top 10` });
  const best = rows[0]?.clip;
  if (isHttpUrl(best?.urls?.thumb)) embed.setThumbnail(best.urls.thumb);
  return interaction.editReply({ embeds: [embed] });
}

/**
 * /clips mine - the caller's own clips.
 * @param {any} interaction
 * @param {HandlerContext} ctx
 */
async function handleMine(interaction, { backend }) {
  // The backend's `user` filter matches users.discord_id, which is exactly this id.
  const { items = [] } = (await backend.listClips({ user: interaction.user.id, limit: 5 })) ?? {};
  if (items.length === 0) {
    return interaction.editReply({
      content:
        'You have no uploaded clips yet. Link the desktop app with `/clips link` and save one.',
    });
  }
  const lines = items.map((clip, i) => {
    const when = parsedDate(clip?.recordedAt);
    const stamp = when ? `<t:${Math.floor(when.getTime() / 1000)}:R>` : 'unknown date';
    const length = formatDuration(clip?.durationMs);
    return `**${i + 1}.** ${clipLink(clip)} - ${clip?.game || 'Unknown'} - ${length} - ${stamp}`;
  });
  const embed = new EmbedBuilder()
    .setColor(COLOR)
    .setTitle('Your clips')
    .setDescription(lines.join('\n'))
    .setFooter({ text: `Your ${items.length} most recent` });
  return interaction.editReply({ embeds: [embed] });
}

/**
 * /clips link - start a device login. The reply carries a login code, so it stays ephemeral.
 * @param {any} interaction
 * @param {HandlerContext} ctx
 */
async function handleLink(interaction, { backend }) {
  const deviceName = `Discord ${
    interaction.user?.username ?? interaction.user?.id ?? 'user'
  }`.slice(0, 100);
  const login = await startDeviceLogin(backend, deviceName);
  // routes/auth.js answers { code, verifyUrl, expiresIn }; the older shared typedef called it
  // verificationUrl, so accept either.
  const url = login?.verifyUrl ?? login?.verificationUrl;
  if (!login?.code || !url) {
    return interaction.editReply({
      content: 'Device linking is not available right now. Ask an admin to check the bot setup.',
    });
  }
  const expiresIn = Number(login.expiresIn);
  const minutes = Number.isFinite(expiresIn) && expiresIn > 0 ? Math.max(1, Math.round(expiresIn / 60)) : null;
  return interaction.editReply({
    content: [
      'Open this link, approve it with Discord, and the desktop app picks the login up on its own:',
      url,
      `Your code: **${login.code}**${minutes ? ` (expires in about ${minutes} minutes)` : ''}`,
      'Only you can see this message. Do not share the code with anyone.',
    ].join('\n'),
  });
}

/** @type {Record<string, (interaction: any, ctx: HandlerContext) => Promise<unknown>>} */
const handlers = {
  setup: handleSetup,
  latest: handleLatest,
  top: handleTop,
  mine: handleMine,
  link: handleLink,
};

// ---- wiring ----------------------------------------------------------------------------

/** @param {any} interaction */
function isChatInput(interaction) {
  if (!interaction) return false;
  if (typeof interaction.isChatInputCommand === 'function') return interaction.isChatInputCommand();
  return typeof interaction.options?.getSubcommand === 'function';
}

/**
 * @param {any} interaction
 * @param {HandlerContext} ctx
 */
async function handleInteraction(interaction, { backend, log }) {
  if (!isChatInput(interaction) || interaction.commandName !== 'clips') return;

  let sub;
  try {
    sub = interaction.options.getSubcommand();
  } catch {
    sub = undefined;
  }
  const handler = sub ? handlers[sub] : undefined;
  if (!handler) {
    log.warn(`unknown /clips subcommand: ${sub}`);
    return;
  }

  // Defer before anything that can block. Ephemeral-ness is decided here and cannot be
  // changed by the edit that follows.
  let deferred = false;
  try {
    await interaction.deferReply(EPHEMERAL.has(sub) ? { flags: MessageFlags.Ephemeral } : {});
    deferred = true;
  } catch (err) {
    log.error(`could not defer /clips ${sub}: ${errorText(err)}`);
    return;
  }

  try {
    await handler(interaction, { backend, log });
  } catch (err) {
    const status = isApiError(err) ? ` (status ${err.status})` : '';
    log.error(`/clips ${sub} failed${status}: ${errorText(err)}`);
    if (!deferred) return;
    try {
      await interaction.editReply({ content: humanError(err), embeds: [] });
    } catch (editErr) {
      // The interaction token expires after 15 minutes; nothing left to do but log it.
      log.warn(`could not edit the deferred /clips ${sub} reply: ${errorText(editErr)}`);
    }
  }
}

/**
 * Attaches the /clips interaction handler to a discord.js client.
 * @param {{ client: any, backend: any, log?: { error?: Function, warn?: Function, info?: Function } }} deps
 * @returns {void}
 */
export function registerCommands({ client, backend, log }) {
  if (!client) throw new TypeError('registerCommands: client is required');
  if (!backend) throw new TypeError('registerCommands: backend is required');
  const logger = normalizeLog(log);
  client.on('interactionCreate', (interaction) => {
    // discord.js does not await this listener, so nothing may escape as a rejection.
    handleInteraction(interaction, { backend, log: logger }).catch((err) =>
      logger.error(`unhandled /clips error: ${errorText(err)}`),
    );
  });
}
