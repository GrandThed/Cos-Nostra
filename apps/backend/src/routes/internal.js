// Bot -> backend routes, protected by BOT_SHARED_SECRET. The bot records the Discord
// message it posted for a clip and every reaction add/remove; reactions are append-only
// rows closed with removed_at so history survives and rankings only count open rows.
// It also reads and writes guild_settings, the per-guild channel and seed emojis that
// `/clips setup` configures.
//
// Also registers plugins/bot.js so app.notifyBot exists app-wide (app.js only imports
// route files; each route file owns the plugins it needs). Both plugins carry
// skip-override: Fastify encapsulates each registered plugin, so a decorator added two
// levels down would otherwise never reach the root instance the clips routes see.

import { timingSafeEqual } from 'node:crypto';
import { and, asc, count, eq, isNull, ne } from 'drizzle-orm';
import { z } from 'zod';

import botPlugin from '../plugins/bot.js';
import { clips, guildSettings, posts, reactions, users } from '../db/schema.js';
import { purgeClip } from '../lib/clip-purge.js';
import { RESERVED_SLUGS } from './guildSite.js';

const postBody = z.object({
  clipId: z.string().min(1),
  guildId: z.string().min(1),
  channelId: z.string().min(1),
  messageId: z.string().min(1),
});

const reactionBody = z.object({
  messageId: z.string().min(1),
  userDiscordId: z.string().min(1),
  emoji: z.string().min(1),
  action: z.enum(['add', 'remove']),
});

// channelId is a Discord snowflake, so digits only; the emoji list is what the bot seeds on
// every post, capped so a setup command cannot make the bot rate-limit itself. locale is one
// of the bot's supported languages (see apps/bot/src/i18n.js SUPPORTED_LOCALES).
const guildBody = z.object({
  channelId: z.string().regex(/^[0-9]+$/),
  seedEmojis: z.array(z.string().min(1)).min(1).max(5).optional(),
  locale: z.enum(['en', 'es']).optional(),
  // Whether the bot @mentions everyone who was in voice with the clip owner. `/clips config`
  // toggles it; omitted means "leave it alone", like the two fields above.
  tagVoiceMembers: z.boolean().optional(),
  // Back the public clip site (docs/PLAN.md phase 5). `name`/`icon` are pushed by `/clips
  // setup` every time it runs, since a guild can rename or re-icon itself at any point; `icon`
  // is nullable so a removed custom icon can be cleared, not just left stale. `slug` is set
  // once by a human and is the URL segment (e.g. "famafia") - never derived automatically.
  name: z.string().trim().min(1).max(100).optional(),
  icon: z.string().trim().max(64).nullable().optional(),
  slug: z
    .string()
    .trim()
    .toLowerCase()
    .regex(/^[a-z0-9](?:[a-z0-9-]{0,48}[a-z0-9])?$/, 'must be lowercase letters, digits and hyphens')
    .refine((s) => !RESERVED_SLUGS.has(s), 'reserved')
    .optional(),
});

/**
 * A column that holds a JSON array as plain text (clips.participants, guild_settings.
 * seed_emojis). Anything unparsable degrades to an empty array: only these routes write those
 * columns, so bad text means someone edited the row by hand, and that must not 500 the request
 * the bot needs to post at all.
 * @param {string | null | undefined} text
 * @returns {string[]}
 */
function safeParseJsonArray(text) {
  try {
    const parsed = JSON.parse(text ?? '[]');
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/**
 * Fallback for when plugins/auth.js has not landed yet: the same check the auth package
 * provides as app.authenticateBot.
 * @param {import('fastify').FastifyInstance} app
 */
function localBotAuth(app) {
  const expected = Buffer.from(`Bearer ${app.config.BOT_SHARED_SECRET}`);
  return async (req, reply) => {
    const got = Buffer.from(req.headers.authorization ?? '');
    if (got.length !== expected.length || !timingSafeEqual(got, expected)) {
      return reply.code(401).send({ error: 'unauthorized' });
    }
  };
}

/**
 * @param {import('fastify').FastifyInstance} app
 * @param {number} postId
 */
async function countOpen(app, postId) {
  const [row] = await app.db
    .select({ n: count() })
    .from(reactions)
    .where(and(eq(reactions.postId, postId), isNull(reactions.removedAt)));
  return Number(row?.n ?? 0);
}

/**
 * Wire shape for a guild_settings row: seed_emojis is stored as a JSON array string and the
 * bot only ever sees the parsed array.
 * @param {typeof guildSettings.$inferSelect} row
 */
function guildToJson(row) {
  return {
    guildId: row.guildId,
    channelId: row.channelId,
    // Unparsable text degrades to no seed reactions rather than 500 the listing the bot
    // needs to post anything at all. See safeParseJsonArray.
    seedEmojis: safeParseJsonArray(row.seedEmojis),
    locale: row.locale,
    tagVoiceMembers: row.tagVoiceMembers,
    name: row.name,
    icon: row.icon,
    slug: row.slug,
  };
}

/** @type {import('fastify').FastifyPluginAsync} */
async function internalRoutes(app) {
  await app.register(botPlugin);

  let preHandler = app.hasDecorator('authenticateBot') ? app.authenticateBot : null;
  if (!preHandler) {
    app.log.warn('app.authenticateBot missing, /internal uses the local shared-secret check');
    preHandler = localBotAuth(app);
  }
  const opts = { preHandler };

  app.post('/internal/posts', opts, async (req, reply) => {
    const parsed = postBody.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'bad_request', issues: parsed.error.issues });
    }
    const { clipId, guildId, channelId, messageId } = parsed.data;
    const [clip] = await app.db.select({ id: clips.id }).from(clips).where(eq(clips.id, clipId));
    if (!clip) return reply.code(404).send({ error: 'unknown_clip' });

    const [row] = await app.db
      .insert(posts)
      .values({ clipId, guildId, channelId, messageId })
      .onConflictDoUpdate({ target: posts.messageId, set: { clipId, guildId, channelId } })
      .returning({ id: posts.id });
    return reply.code(201).send({ id: row.id });
  });

  app.post('/internal/reactions', opts, async (req, reply) => {
    const parsed = reactionBody.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'bad_request', issues: parsed.error.issues });
    }
    const { messageId, userDiscordId, emoji, action } = parsed.data;
    const [post] = await app.db
      .select({ id: posts.id })
      .from(posts)
      .where(eq(posts.messageId, messageId));
    if (!post) return reply.code(404).send({ error: 'unknown_message' });

    const openRow = and(
      eq(reactions.postId, post.id),
      eq(reactions.userDiscordId, userDiscordId),
      eq(reactions.emoji, emoji),
      isNull(reactions.removedAt),
    );
    if (action === 'add') {
      const [existing] = await app.db.select({ id: reactions.id }).from(reactions).where(openRow);
      if (!existing) {
        await app.db.insert(reactions).values({ postId: post.id, userDiscordId, emoji });
      }
    } else {
      await app.db.update(reactions).set({ removedAt: new Date() }).where(openRow);
    }
    return { ok: true, open: await countOpen(app, post.id) };
  });

  app.get('/internal/posts/:messageId', opts, async (req, reply) => {
    const [post] = await app.db
      .select({
        id: posts.id,
        clipId: posts.clipId,
        guildId: posts.guildId,
        channelId: posts.channelId,
        messageId: posts.messageId,
      })
      .from(posts)
      .where(eq(posts.messageId, req.params.messageId));
    if (!post) return reply.code(404).send({ error: 'unknown_message' });
    const { id, ...rest } = post;
    return { ...rest, open: await countOpen(app, id) };
  });

  app.get('/internal/clips/:id', opts, async (req, reply) => {
    const id = req.params.id;
    const [row] = await app.db
      .select({
        id: clips.id,
        game: clips.game,
        title: clips.title,
        durationMs: clips.durationMs,
        sizeH264: clips.sizeH264,
        recordedAt: clips.recordedAt,
        status: clips.status,
        participants: clips.participants,
        discordId: users.discordId,
        username: users.username,
      })
      .from(clips)
      .innerJoin(users, eq(users.id, clips.userId))
      .where(eq(clips.id, id));
    if (!row || row.status !== 'ready') return reply.code(404).send({ error: 'unknown_clip' });

    const base = app.config.PUBLIC_URL;
    return {
      id: row.id,
      game: row.game,
      title: row.title,
      durationMs: row.durationMs,
      sizeH264: row.sizeH264,
      recordedAt: row.recordedAt,
      owner: { discordId: row.discordId, username: row.username },
      // Discord ids of whoever was in voice with the owner at capture time. Only the bot ever
      // sees these; the public clip JSON has no such field.
      participants: safeParseJsonArray(row.participants),
      urls: {
        h264: `${base}/clips/${id}/h264`,
        thumb: `${base}/clips/${id}/thumb`,
        page: `${base}/c/${id}`,
      },
    };
  });

  // The manage menu on a Discord post: the bot deletes a clip on the owner's behalf, so the
  // request carries the shared secret rather than the owner's device token. The bot decides
  // who is allowed to press the button (it knows the post's owner); the backend's job is to
  // take the clip down exactly as DELETE /clips/:id would.
  app.delete('/internal/clips/:id', opts, async (req, reply) => {
    if (!app.storage) return reply.code(503).send({ error: 'storage_unavailable' });
    const [row] = await app.db
      .select({
        id: clips.id,
        keyAv1: clips.keyAv1,
        keyH264: clips.keyH264,
        keyThumb: clips.keyThumb,
        status: clips.status,
      })
      .from(clips)
      .where(eq(clips.id, req.params.id));
    if (!row || row.status === 'deleted') return reply.code(404).send({ error: 'unknown_clip' });
    await purgeClip(app, row);
    return reply.code(204).send();
  });

  // ---- guild settings -----------------------------------------------------------------

  app.get('/internal/guilds', opts, async () => {
    const rows = await app.db.select().from(guildSettings).orderBy(asc(guildSettings.guildId));
    return { items: rows.map(guildToJson) };
  });

  app.get('/internal/guilds/:guildId', opts, async (req, reply) => {
    const [row] = await app.db
      .select()
      .from(guildSettings)
      .where(eq(guildSettings.guildId, req.params.guildId));
    if (!row) return reply.code(404).send({ error: 'unknown_guild' });
    return guildToJson(row);
  });

  app.put('/internal/guilds/:guildId', opts, async (req, reply) => {
    const parsed = guildBody.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'bad_request', issues: parsed.error.issues });
    }
    const { guildId } = req.params;
    // The bot always passes interaction.guildId, so anything else is a bug or a stray
    // call; refuse it rather than writing a row no guild can ever read back.
    if (!/^[0-9]+$/.test(guildId)) {
      return reply.code(400).send({ error: 'bad_request', issues: [{ path: ['guildId'], message: 'must be a snowflake' }] });
    }
    const { channelId, seedEmojis, locale, tagVoiceMembers, name, icon, slug } = parsed.data;
    // Omitting a field means "leave it alone": a new row falls back to the column default, an
    // existing row keeps whatever the guild configured earlier.
    const values = { guildId, channelId, updatedAt: new Date() };
    const set = { channelId, updatedAt: new Date() };
    if (seedEmojis) {
      values.seedEmojis = JSON.stringify(seedEmojis);
      set.seedEmojis = values.seedEmojis;
    }
    if (locale) {
      values.locale = locale;
      set.locale = locale;
    }
    // Tested against undefined, not truthiness: `false` is the whole point of this toggle.
    if (tagVoiceMembers !== undefined) {
      values.tagVoiceMembers = tagVoiceMembers;
      set.tagVoiceMembers = tagVoiceMembers;
    }
    if (name !== undefined) {
      values.name = name;
      set.name = name;
    }
    // 'icon' in req.body, not truthiness: a guild that removed its custom icon sends null to
    // clear the stored hash, which is different from not mentioning icon at all.
    if ('icon' in (req.body ?? {})) {
      values.icon = icon;
      set.icon = icon;
    }
    if (slug !== undefined) {
      // Checked ahead of the write, rather than by catching the unique index's constraint
      // violation, because the two supported drivers (pg, PGlite) do not surface that error
      // the same way and this route cannot tell PGlite's shape from pg's reliably. A guild
      // renaming its own slug back to itself is not a conflict, hence the guildId exclusion.
      const [taken] = await app.db
        .select({ guildId: guildSettings.guildId })
        .from(guildSettings)
        .where(and(eq(guildSettings.slug, slug), ne(guildSettings.guildId, guildId)));
      if (taken) return reply.code(409).send({ error: 'slug_taken', slug });
      values.slug = slug;
      set.slug = slug;
    }

    const [row] = await app.db
      .insert(guildSettings)
      .values(values)
      .onConflictDoUpdate({ target: guildSettings.guildId, set })
      .returning();
    return guildToJson(row);
  });
}

internalRoutes[Symbol.for('skip-override')] = true;

export default internalRoutes;
