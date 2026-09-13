// Slash commands: one top-level /clips with five subcommands (docs/PLAN.md, phase 4).
//
//   /clips setup channel:<#channel> [language:]  store the clip channel and reply language
//                                                for this guild (Manage Server)
//   /clips config [emojis:] [tag_voice_members:] the rest of the guild settings, and an echo
//                                                of the current ones (Manage Server)
//   /clips latest                     the newest ready clip, as an embed
//   /clips top [year] [game]          the yearly leaderboard for this guild
//   /clips mine                       the caller's own clips, ephemeral
//   /clips link                       how to link the desktop app, ephemeral
//
// Every subcommand defers first: Discord discards an interaction that is not acknowledged in
// three seconds and all five have to cross the network to the backend. Ephemeral-ness is
// fixed at defer time, which is why the defer, not the edit, carries the flag.
//
// Two different languages are in play here, and they are not the same mechanism:
//
//   - The *reply* language is the guild's, stored by the backend in guild_settings.locale and
//     read through localeForGuild() once per interaction. Everything a handler says goes
//     through t(locale, ...) so one server's members all read the same language.
//   - The *picker* language is Discord's own: the name and description localizations below
//     follow the invoking user's client language and are baked into the registered command.
//     They are polish, and they cannot be per guild.
//
// The backend is injected (apps/bot/src/backend.js) so tests never touch HTTP. Errors are
// duck-typed (name 'ApiError' or a numeric status) rather than imported from
// @cos-nostra/shared, so this module keeps discord.js as its only runtime import.

import {
  ChannelType,
  EmbedBuilder,
  MessageFlags,
  PermissionFlagsBits,
  SlashCommandBuilder,
} from 'discord.js';

import { SUPPORTED_LOCALES, localeForGuild, t } from './i18n.js';

/** @typedef {import('@cos-nostra/shared').Locale} Locale */

/** Brand red, shared by every embed the bot posts. */
const COLOR = 0xc4302b;

/** Channel types /clips setup accepts. Both are text channels a bot can post clips into. */
const TEXT_CHANNELS = [ChannelType.GuildText, ChannelType.GuildAnnouncement];

/** Subcommands whose reply only the caller should see. */
const EPHEMERAL = new Set(['setup', 'config', 'mine', 'link']);

/** How many seed reactions a guild may have. Discord allows more; five is plenty to vote on. */
const MAX_SEED_EMOJIS = 5;

// ---- command definition ----------------------------------------------------------------

/**
 * English description plus its localizations, from the same dictionaries the replies use.
 * `es-419` gets the Spanish copy too: the community is Latin American and Discord does not
 * fall back from one Spanish variant to the other.
 * @template {{ setDescription: Function, setDescriptionLocalizations: Function }} T
 * @param {T} builder
 * @param {string} key  a key under commandDescriptions
 * @returns {T}
 */
function described(builder, key) {
  const path = `commandDescriptions.${key}`;
  builder.setDescription(t('en', path));
  builder.setDescriptionLocalizations({
    'en-US': t('en', path),
    'en-GB': t('en', path),
    'es-ES': t('es', path),
    'es-419': t('es', path),
  });
  return builder;
}

// A note on permissions. Discord only accepts default_member_permissions on a top-level
// command, and /clips carries four subcommands every member is meant to use, so putting
// ManageGuild here would hide /clips latest, top, mine and link from everyone without it.
// The gate for /clips setup is therefore the runtime check in handleSetup, which is the one
// that actually holds in any case: a server admin can override default permissions per guild.
const clips = described(new SlashCommandBuilder().setName('clips'), 'clips')
  .addSubcommand((sub) =>
    described(sub.setName('setup'), 'setup')
      .addChannelOption((opt) =>
        described(opt.setName('channel'), 'setupChannel')
          .addChannelTypes(...TEXT_CHANNELS)
          .setRequired(true),
      )
      // Optional on purpose: a guild that never picks one stays on the backend's default,
      // and an admin changing only the channel must not have to restate the language.
      .addStringOption((opt) =>
        described(opt.setName('language'), 'setupLanguage').addChoices(
          { name: 'Español', value: 'es' },
          { name: 'English', value: 'en' },
        ),
      )
      // The public clip site's URL segment (docs/PLAN.md phase 5), e.g. "famafia" for
      // cosnostra.benja.ar/famafia. Optional and sticky like language: most setup runs are
      // just a channel change and should not have to restate it.
      .addStringOption((opt) =>
        described(opt.setName('slug'), 'setupSlug').setMinLength(1).setMaxLength(50),
      ),
  )
  // Everything about a guild that is not the channel. Both options are optional, and running
  // it with neither echoes the current settings back, so it doubles as "what is set here?".
  .addSubcommand((sub) =>
    described(sub.setName('config'), 'config')
      .addStringOption((opt) =>
        described(opt.setName('emojis'), 'configEmojis').setMaxLength(200),
      )
      .addBooleanOption((opt) =>
        described(opt.setName('tag_voice_members'), 'configTagVoiceMembers'),
      ),
  )
  .addSubcommand((sub) => described(sub.setName('latest'), 'latest'))
  .addSubcommand((sub) =>
    described(sub.setName('top'), 'top')
      .addIntegerOption((opt) =>
        described(opt.setName('year'), 'topYear').setMinValue(2000).setMaxValue(2100),
      )
      .addStringOption((opt) => described(opt.setName('game'), 'topGame').setMaxLength(200)),
  )
  .addSubcommand((sub) => described(sub.setName('mine'), 'mine'))
  .addSubcommand((sub) => described(sub.setName('link'), 'link'));

/**
 * Command payloads ready for Discord's REST API. Consumed by src/deploy-commands.js.
 * @type {import('discord.js').RESTPostAPIApplicationCommandsJSONBody[]}
 */
export const commands = [clips.toJSON()];

// ---- replies ---------------------------------------------------------------------------

/**
 * Edits the deferred reply, with mentions disabled.
 *
 * Every reply goes through here because most of them interpolate text the bot does not
 * control: clip titles and owner usernames from the backend, and the free-text `game` option
 * of /clips top, which any member can set to "@everyone" or to a role id. `parse: []` makes
 * Discord render those as plain text instead of pinging. The client in client.js already
 * defaults to this; repeating it per payload means a change to that default cannot quietly
 * turn a leaderboard into a server-wide ping. Channel mentions (`<#id>`) still render, as
 * they never notify anyone.
 *
 * @param {any} interaction
 * @param {import('discord.js').InteractionEditReplyOptions} payload
 */
function respond(interaction, payload) {
  return interaction.editReply({ ...payload, allowedMentions: { parse: [] } });
}

/**
 * Wraps user-supplied text in a code span so it reads as a quoted value rather than as
 * markup. Backticks are stripped first, so the span cannot be closed early and the rest of
 * the sentence cannot be turned into markdown. allowedMentions already stops the pings; this
 * is about the message not being hijacked visually.
 * @param {string} value
 */
function quoted(value) {
  return `\`${String(value).replace(/`/g, '')}\``;
}

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

/** @param {Locale} locale @param {unknown} n */
function reactorCount(locale, n) {
  const count = Number(n ?? 0);
  return t(locale, count === 1 ? 'top.reactorsOne' : 'top.reactorsMany', { count });
}

/** Best available human label for a clip. @param {Locale} locale @param {any} clip */
function clipLabel(locale, clip) {
  return String(clip?.title || clip?.game || t(locale, 'common.untitledClip')).slice(0, 120);
}

/** Markdown link to the player page, or bare text when the clip has no page URL. */
function clipLink(locale, clip) {
  const label = clipLabel(locale, clip).replace(/([[\]])/g, '\\$1');
  return isHttpUrl(clip?.urls?.page) ? `[${label}](${clip.urls.page})` : label;
}

/** @param {Locale} locale @param {any} clip */
function ownerName(locale, clip) {
  return clip?.owner?.username || t(locale, 'common.someone');
}

/** @param {Locale} locale @param {any} clip */
function gameName(locale, clip) {
  return String(clip?.game || t(locale, 'common.unknownGame'));
}

/** ISO string to a Date the embed builder accepts, or null. @param {unknown} iso */
function parsedDate(iso) {
  if (!iso) return null;
  const date = new Date(/** @type {string} */ (iso));
  return Number.isNaN(date.getTime()) ? null : date;
}

/**
 * Embed for a single clip: the thumbnail plus a link to the player page.
 * @param {Locale} locale
 * @param {any} clip
 */
function clipEmbed(locale, clip) {
  const embed = new EmbedBuilder().setColor(COLOR).setTitle(clipLabel(locale, clip));
  if (isHttpUrl(clip?.urls?.page)) embed.setURL(clip.urls.page);
  if (isHttpUrl(clip?.urls?.thumb)) embed.setImage(clip.urls.thumb);
  embed.addFields(
    { name: t(locale, 'embed.fieldGame'), value: gameName(locale, clip), inline: true },
    { name: t(locale, 'embed.fieldLength'), value: formatDuration(clip?.durationMs), inline: true },
    {
      name: t(locale, 'embed.fieldReactions'),
      value: String(Number(clip?.reactions ?? 0)),
      inline: true,
    },
  );
  embed.setFooter({ text: t(locale, 'embed.footer', { user: ownerName(locale, clip) }) });
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

/** One line a Discord user can act on. @param {Locale} locale @param {any} err */
function humanError(locale, err) {
  const status = isApiError(err) ? Number(err.status) : 0;
  if (status === 401 || status === 403) return t(locale, 'errors.auth');
  if (status === 404) return t(locale, 'errors.notFound');
  if (status === 429) return t(locale, 'errors.rateLimited');
  if (status >= 500) return t(locale, 'errors.server');
  if (status >= 400) return t(locale, 'errors.badRequest');
  return t(locale, 'errors.unreachable');
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

// ---- subcommand handlers ---------------------------------------------------------------

/**
 * @typedef {object} HandlerContext
 * @property {any} backend  apps/bot/src/backend.js
 * @property {{ error: Function, warn: Function, info: Function }} log
 * @property {Locale} locale  the guild's reply language, resolved once per interaction
 */

/**
 * /clips setup - remember the clip channel, and optionally the reply language, for this guild.
 * @param {any} interaction
 * @param {HandlerContext} ctx
 */
async function handleSetup(interaction, { backend, log, locale }) {
  if (!interaction.guildId) {
    return respond(interaction, { content: t(locale, 'setup.guildOnly') });
  }

  // The gate that counts: default_member_permissions cannot be scoped to one subcommand and
  // can be overridden per guild, so the invoking member is checked here.
  const permissions = interaction.memberPermissions;
  if (!permissions || !permissions.has(PermissionFlagsBits.ManageGuild)) {
    log.info(
      `/clips setup refused for ${interaction.user?.id} in ${interaction.guildId}: no Manage Server`,
    );
    return respond(interaction, { content: t(locale, 'setup.needsPermission') });
  }

  const channel = interaction.options.getChannel('channel');
  if (!channel || !TEXT_CHANNELS.includes(channel.type)) {
    return respond(interaction, { content: t(locale, 'setup.badChannel') });
  }

  // Discord constrains `language` to the two choices, but an option is still user input:
  // anything not in SUPPORTED_LOCALES is dropped rather than sent to the backend, which
  // would answer 400 and lose the channel change with it.
  const chosen = interaction.options.getString('language');
  const language = SUPPORTED_LOCALES.includes(chosen) ? chosen : undefined;

  // The public clip site's URL segment (docs/PLAN.md phase 5). Optional and sticky, like
  // language: most setup runs are just a channel change and should not have to restate it.
  const slug = interaction.options.getString('slug')?.trim().toLowerCase() || undefined;

  // PUT replaces the row, so read the current config and hand the seed emojis back rather
  // than dropping them. getGuild returns null for a guild that was never set up. Omitting
  // `locale` leaves the stored one alone, which is why it is only sent when it was picked.
  const existing = await backend.getGuild(interaction.guildId);
  const seedEmojis = existing?.seedEmojis ?? undefined;
  // interaction.guild carries the live Discord object (name, icon hash) with no extra API
  // call, since /clips setup only runs inside a guild. Sent every run, not just when changed,
  // so a renamed or re-iconned server's clip site catches up the next time an admin touches
  // setup for any reason.
  const guildName = interaction.guild?.name;
  const guildIcon = interaction.guild?.icon ?? null;

  let saved;
  let slugTaken = false;
  try {
    saved = await backend.putGuild(interaction.guildId, {
      channelId: channel.id,
      seedEmojis,
      ...(language ? { locale: language } : {}),
      ...(guildName ? { name: guildName } : {}),
      icon: guildIcon,
      ...(slug ? { slug } : {}),
    });
  } catch (err) {
    // A taken slug must not lose the channel/language change riding along with it: retry
    // once without it and tell the admin separately that the URL specifically did not save.
    if (slug && isApiError(err) && Number(err.status) === 409) {
      slugTaken = true;
      saved = await backend.putGuild(interaction.guildId, {
        channelId: channel.id,
        seedEmojis,
        ...(language ? { locale: language } : {}),
        ...(guildName ? { name: guildName } : {}),
        icon: guildIcon,
      });
    } else {
      throw err;
    }
  }

  // The confirmation speaks the language that is in force after the change, not before it.
  const replyLocale = language ?? locale;
  const seeds = saved?.seedEmojis ?? seedEmojis;
  const seedLine =
    Array.isArray(seeds) && seeds.length > 0
      ? t(replyLocale, 'setup.seedLine', { emojis: seeds.join(' ') })
      : '';
  const languageLine = language
    ? t(replyLocale, 'setup.languageLine', {
        language: t(replyLocale, `setup.languages.${language}`),
      })
    : '';
  const slugLine = slugTaken
    ? t(replyLocale, 'setup.slugTaken', { slug })
    : saved?.slug
      ? t(replyLocale, 'setup.slugLine', { slug: saved.slug })
      : '';
  log.info(
    `clip channel for guild ${interaction.guildId} set to ${channel.id}${language ? `, language ${language}` : ''}${slugTaken ? ' (slug taken)' : ''}`,
  );
  return respond(interaction, {
    content: `${t(replyLocale, 'setup.saved', { channel: channel.id })}${seedLine}${languageLine}${slugLine}`,
  });
}

/**
 * Seed emojis as typed, or null when the option was given and is not usable.
 *
 * Whitespace-separated, because that is how someone types three emojis in a row, and because
 * a custom emoji (`<:name:id>`) contains no space of its own. The cap is ours, not Discord's:
 * every seed is a reaction the bot adds one at a time to every post in the guild.
 *
 * @param {string} raw
 * @returns {string[] | null}
 */
function parseSeedEmojis(raw) {
  const tokens = String(raw)
    .split(/\s+/)
    .filter((token) => token.length > 0);
  if (tokens.length === 0 || tokens.length > MAX_SEED_EMOJIS) return null;
  return tokens;
}

/** @param {Locale} locale @param {unknown} on */
function onOff(locale, on) {
  return t(locale, on === false ? 'config.off' : 'config.on');
}

/**
 * The settings line both branches of /clips config end on.
 * @param {Locale} locale
 * @param {{ seedEmojis?: string[], tagVoiceMembers?: boolean }} settings
 */
function configLines(locale, settings) {
  const seeds = Array.isArray(settings?.seedEmojis) ? settings.seedEmojis : [];
  return [
    t(locale, 'config.seedLine', {
      emojis: seeds.length > 0 ? seeds.join(' ') : t(locale, 'config.noEmojis'),
    }),
    t(locale, 'config.tagLine', { state: onOff(locale, settings?.tagVoiceMembers) }),
  ].join('\n');
}

/**
 * /clips config - the guild settings that are not the channel: seed reactions, and whether a
 * post mentions the people who were in voice when the clip was recorded.
 *
 * Given no options at all it changes nothing and reads the settings back instead, which is
 * the only way to see them. Given some, it PUTs the whole row, because the backend's PUT
 * replaces it: whatever was not named has to be handed back or it is dropped, exactly as
 * handleSetup does with the seed emojis.
 *
 * @param {any} interaction
 * @param {HandlerContext} ctx
 */
async function handleConfig(interaction, { backend, log, locale }) {
  if (!interaction.guildId) {
    return respond(interaction, { content: t(locale, 'config.guildOnly') });
  }

  const permissions = interaction.memberPermissions;
  if (!permissions || !permissions.has(PermissionFlagsBits.ManageGuild)) {
    log.info(
      `/clips config refused for ${interaction.user?.id} in ${interaction.guildId}: no Manage Server`,
    );
    return respond(interaction, { content: t(locale, 'config.needsPermission') });
  }

  // Validated before the round trip: a bad emoji list should not cost a read.
  const rawEmojis = interaction.options.getString('emojis');
  const seedEmojis = rawEmojis === null || rawEmojis === undefined ? undefined : parseSeedEmojis(rawEmojis);
  if (seedEmojis === null) {
    return respond(interaction, { content: t(locale, 'config.badEmojis', { max: MAX_SEED_EMOJIS }) });
  }
  // getBoolean answers null when the option was not given, which is what "leave it alone"
  // looks like here - false is a real value and must not be mistaken for it.
  const tagVoiceMembers = interaction.options.getBoolean('tag_voice_members');

  const existing = await backend.getGuild(interaction.guildId);
  if (!existing?.channelId) {
    // channelId is required by the PUT and /clips config has no channel option, so there is
    // nothing this command can do for a guild that never ran /clips setup.
    return respond(interaction, { content: t(locale, 'config.needsSetupFirst') });
  }

  if (seedEmojis === undefined && tagVoiceMembers === null) {
    return respond(interaction, {
      content: `${t(locale, 'config.current')}\n${configLines(locale, existing)}`,
    });
  }

  const saved = await backend.putGuild(interaction.guildId, {
    channelId: existing.channelId,
    seedEmojis: seedEmojis ?? existing.seedEmojis,
    locale: existing.locale,
    tagVoiceMembers: tagVoiceMembers ?? existing.tagVoiceMembers,
  });

  const settings = {
    seedEmojis: saved?.seedEmojis ?? seedEmojis ?? existing.seedEmojis,
    tagVoiceMembers: saved?.tagVoiceMembers ?? tagVoiceMembers ?? existing.tagVoiceMembers,
  };
  log.info(
    `config for guild ${interaction.guildId} updated${seedEmojis ? `, seeds ${seedEmojis.join(' ')}` : ''}${
      tagVoiceMembers === null ? '' : `, voice mentions ${tagVoiceMembers ? 'on' : 'off'}`
    }`,
  );
  return respond(interaction, {
    content: `${t(locale, 'config.saved')}\n${configLines(locale, settings)}`,
  });
}

/**
 * /clips latest - the newest ready clip.
 * @param {any} interaction
 * @param {HandlerContext} ctx
 */
async function handleLatest(interaction, { backend, locale }) {
  const { items = [] } = (await backend.listClips({ sort: 'recent', limit: 1 })) ?? {};
  const clip = items[0];
  if (!clip) {
    return respond(interaction, { content: t(locale, 'latest.empty') });
  }
  return respond(interaction, { embeds: [clipEmbed(locale, clip)] });
}

/**
 * /clips top - the yearly leaderboard for this guild.
 * @param {any} interaction
 * @param {HandlerContext} ctx
 */
async function handleTop(interaction, { backend, locale }) {
  if (!interaction.guildId) {
    return respond(interaction, { content: t(locale, 'top.guildOnly') });
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
    return respond(interaction, {
      // The game name is whatever the caller typed, so it is quoted rather than echoed raw.
      content: game
        ? t(locale, 'top.emptyGame', { game: quoted(game), year })
        : t(locale, 'top.empty', { year }),
    });
  }

  const lines = rows.map((row, i) => {
    const clip = row?.clip ?? {};
    const parts = [
      ownerName(locale, clip),
      gameName(locale, clip),
      reactorCount(locale, row?.distinctReactors),
    ];
    return `**${i + 1}.** ${clipLink(locale, clip)} - ${parts.join(' - ')}`;
  });

  const embed = new EmbedBuilder()
    .setColor(COLOR)
    .setTitle(t(locale, 'top.title', { year }))
    .setDescription(lines.join('\n'));
  if (game) embed.setFooter({ text: t(locale, 'top.footer', { game }) });
  const best = rows[0]?.clip;
  if (isHttpUrl(best?.urls?.thumb)) embed.setThumbnail(best.urls.thumb);
  return respond(interaction, { embeds: [embed] });
}

/**
 * /clips mine - the caller's own clips.
 * @param {any} interaction
 * @param {HandlerContext} ctx
 */
async function handleMine(interaction, { backend, locale }) {
  // The backend's `user` filter matches users.discord_id, which is exactly this id.
  const { items = [] } = (await backend.listClips({ user: interaction.user.id, limit: 5 })) ?? {};
  if (items.length === 0) {
    return respond(interaction, { content: t(locale, 'mine.empty') });
  }
  const lines = items.map((clip, i) => {
    const when = parsedDate(clip?.recordedAt);
    // A Discord timestamp renders in each reader's own language and time zone, so it is
    // left to the client rather than formatted here.
    const stamp = when
      ? `<t:${Math.floor(when.getTime() / 1000)}:R>`
      : t(locale, 'mine.unknownDate');
    const length = formatDuration(clip?.durationMs);
    return `**${i + 1}.** ${clipLink(locale, clip)} - ${gameName(locale, clip)} - ${length} - ${stamp}`;
  });
  const embed = new EmbedBuilder()
    .setColor(COLOR)
    .setTitle(t(locale, 'mine.title'))
    .setDescription(lines.join('\n'))
    .setFooter({ text: t(locale, 'mine.footer', { count: items.length }) });
  return respond(interaction, { embeds: [embed] });
}

/**
 * /clips link - explain how to link the desktop app. Ephemeral, because it is about the
 * caller's own account.
 *
 * This used to start a device login here and hand back the code and the verify URL. That
 * never worked and now cannot: only the process that calls POST /auth/device can finish the
 * login, because the response's `pollSecret` is the bearer for GET /auth/device/:code and it
 * is shown exactly once. A login the bot starts is therefore one the desktop can never
 * collect - it always starts its own - so the old reply sent people through a Discord consent
 * screen that linked a device nobody held, which then expired ten minutes later.
 *
 * Rather than leave that in, the command says where the real button is. Linking from the app
 * is also the flow the confirmation page was designed around: the code on screen in the app
 * is what the user checks the browser against.
 *
 * @param {any} interaction
 * @param {HandlerContext} ctx
 */
async function handleLink(interaction, { locale }) {
  return respond(interaction, {
    content: [t(locale, 'link.open'), t(locale, 'link.verify'), t(locale, 'link.done')].join('\n'),
  });
}

/** @type {Record<string, (interaction: any, ctx: HandlerContext) => Promise<unknown>>} */
const handlers = {
  setup: handleSetup,
  config: handleConfig,
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

  // After the defer, because this crosses the network too and the three-second window is
  // spent on the acknowledgement, not on a language lookup. localeForGuild never throws, so
  // a guild whose config cannot be read still gets an answer, in Spanish.
  const locale = await localeForGuild(backend, interaction.guildId);

  try {
    await handler(interaction, { backend, log, locale });
  } catch (err) {
    const status = isApiError(err) ? ` (status ${err.status})` : '';
    log.error(`/clips ${sub} failed${status}: ${errorText(err)}`);
    if (!deferred) return;
    try {
      await respond(interaction, { content: humanError(locale, err), embeds: [] });
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
