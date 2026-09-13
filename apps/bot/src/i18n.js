// Translation for everything the bot says out loud.
//
// The language is a property of the guild, not of the process: the community this runs for is
// Spanish-speaking, so DEFAULT_LOCALE is 'es', but a server admin can switch a guild to
// English with /clips setup and the backend stores it in guild_settings.locale.
//
// t() never throws. A key missing from the requested locale falls back to Spanish (the
// complete dictionary) and then to the key itself, because a reply reading `top.title` is a
// bug report a user can forward, while a crashed handler leaves a deferred interaction
// hanging until Discord times it out.
//
// Nothing here is about Discord's own command localization: the descriptions in the slash
// command picker follow the *user's* client language and are registered separately, as
// name/description localizations in commands.js.

import { SUPPORTED_LOCALES, DEFAULT_LOCALE } from '@cos-nostra/shared';

import { es } from './locales/es.js';
import { en } from './locales/en.js';

/** @typedef {import('@cos-nostra/shared').Locale} Locale */

/** @type {Record<Locale, Record<string, unknown>>} */
const DICTIONARIES = { es, en };

export { DEFAULT_LOCALE, SUPPORTED_LOCALES };

/**
 * A supported locale, or the default. Anything the backend or an option could hand over -
 * null, 'fr', an object - resolves to DEFAULT_LOCALE rather than to a missing dictionary.
 * @param {unknown} value
 * @returns {Locale}
 */
export function resolveLocale(value) {
  return SUPPORTED_LOCALES.includes(/** @type {Locale} */ (value))
    ? /** @type {Locale} */ (value)
    : DEFAULT_LOCALE;
}

/**
 * Walks a dot path into a dictionary. Only a string is a translation: a path that stops on a
 * nested object (`setup.languages`) is as missing as one that stops on nothing.
 * @param {unknown} dict
 * @param {string} key
 * @returns {string | undefined}
 */
function lookup(dict, key) {
  let node = dict;
  for (const part of String(key).split('.')) {
    if (node === null || typeof node !== 'object') return undefined;
    node = /** @type {Record<string, unknown>} */ (node)[part];
  }
  return typeof node === 'string' ? node : undefined;
}

/**
 * Replaces `{name}` with params.name. An unknown placeholder is left alone so a template that
 * outgrew its call site is visible instead of silently blank.
 * @param {string} template
 * @param {Record<string, unknown> | undefined} params
 */
function fill(template, params) {
  if (!params) return template;
  return template.replace(/\{(\w+)\}/g, (match, name) =>
    params[name] === undefined || params[name] === null ? match : String(params[name]),
  );
}

/**
 * @param {unknown} locale
 * @param {string} key  dot path, e.g. 'setup.needsPermission'
 * @param {Record<string, unknown>} [params]
 * @returns {string}
 */
export function t(locale, key, params) {
  const template =
    lookup(DICTIONARIES[resolveLocale(locale)], key) ??
    lookup(DICTIONARIES[DEFAULT_LOCALE], key) ??
    String(key);
  return fill(template, params);
}

/**
 * The language a guild has asked for.
 *
 * DMs (no guildId) and a backend that cannot answer both get the default rather than an
 * error: failing to look up a language must never be the reason a command has no reply. The
 * command handler's own backend call is the one allowed to fail loudly.
 *
 * @param {{ getGuild?: (guildId: string) => Promise<{ locale?: unknown } | null> }} backend
 * @param {string | null | undefined} guildId
 * @returns {Promise<Locale>}
 */
export async function localeForGuild(backend, guildId) {
  if (!guildId || typeof backend?.getGuild !== 'function') return DEFAULT_LOCALE;
  try {
    const guild = await backend.getGuild(guildId);
    return resolveLocale(guild?.locale);
  } catch {
    return DEFAULT_LOCALE;
  }
}
