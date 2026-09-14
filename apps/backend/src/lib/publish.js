// Shared pieces of publish-on-demand: which Discord guilds a clip is aimed at, which of its
// posts are still up, and the guild shape the desktop's publish dialog and clip cards show.
// Used by routes/clips.js, routes/discord.js, routes/internal.js and lib/clip-purge.js, so the
// JSON-array parsing rule and the icon URL have exactly one definition.

import { and, eq, inArray, isNull } from 'drizzle-orm';

import { guildSettings, posts } from '../db/schema.js';
import { guildIconUrl } from './html.js';

/**
 * A column that holds a JSON array as plain text (clips.participants, clips.target_guilds,
 * guild_settings.seed_emojis). Anything unparsable degrades to an empty array: only the routes
 * write those columns, so bad text means someone edited the row by hand, and that must not 500
 * the request the bot needs to post at all.
 * @param {string | null | undefined} text
 * @returns {string[]}
 */
export function safeParseJsonArray(text) {
  try {
    const parsed = JSON.parse(text ?? '[]');
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/**
 * clips.target_guilds as the wire sees it. Null stays null - it is the legacy "every configured
 * guild" and must not collapse into `[]`, which means "no Discord post at all". Everything else
 * follows safeParseJsonArray, so a hand-mangled value posts nowhere rather than everywhere.
 * @param {string | null | undefined} text
 * @returns {string[] | null}
 */
export function parseTargetGuilds(text) {
  return text == null ? null : safeParseJsonArray(text);
}

/**
 * The `iconUrl` every desktop-facing route hands out: a 96 px PNG from Discord's CDN, or null
 * for a guild with no custom icon. `icon` is stored as a bare hash; the URL is built only here.
 * @param {string} guildId
 * @param {string | null | undefined} icon  guild_settings.icon
 */
export function guildIcon(guildId, icon) {
  return guildIconUrl(guildId, icon, 96);
}

/**
 * A guild as the desktop sees it: enough to draw a checkbox in the publish dialog.
 * @param {{ guildId: string, name: string | null, icon: string | null, slug: string | null }} row
 */
export function guildSummary(row) {
  return {
    guildId: row.guildId,
    name: row.name ?? null,
    iconUrl: guildIcon(row.guildId, row.icon),
    slug: row.slug ?? null,
  };
}

/**
 * The subset of `guildIds` that has a guild_settings row, deduplicated, in the order given.
 * A guild with no row has no channel to post in, so asking for it is dropped silently rather
 * than refused: the desktop's list can be a little stale and that is not the user's fault.
 * @param {import('fastify').FastifyInstance} app
 * @param {string[]} guildIds
 * @returns {Promise<string[]>}
 */
export async function configuredGuildIds(app, guildIds) {
  const unique = [...new Set(guildIds)];
  if (unique.length === 0) return [];
  const rows = await app.db
    .select({ guildId: guildSettings.guildId })
    .from(guildSettings)
    .where(inArray(guildSettings.guildId, unique));
  const known = new Set(rows.map((r) => r.guildId));
  return unique.filter((id) => known.has(id));
}

/**
 * Every post of a clip whose Discord message is still up, oldest first.
 * @param {import('fastify').FastifyInstance} app
 * @param {string} clipId
 * @returns {Promise<Array<{ guildId: string, channelId: string, messageId: string }>>}
 */
export async function livePosts(app, clipId) {
  return app.db
    .select({ guildId: posts.guildId, channelId: posts.channelId, messageId: posts.messageId })
    .from(posts)
    .where(and(eq(posts.clipId, clipId), isNull(posts.removedAt)))
    .orderBy(posts.postedAt, posts.id);
}
