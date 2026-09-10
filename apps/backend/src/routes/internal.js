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
import { and, asc, count, eq, isNull } from 'drizzle-orm';
import { z } from 'zod';

import botPlugin from '../plugins/bot.js';
import { clips, guildSettings, posts, reactions, users } from '../db/schema.js';

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
// every post, capped so a setup command cannot make the bot rate-limit itself.
const guildBody = z.object({
  channelId: z.string().regex(/^[0-9]+$/),
  seedEmojis: z.array(z.string().min(1)).min(1).max(5).optional(),
});

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
  let seedEmojis = [];
  try {
    const parsed = JSON.parse(row.seedEmojis);
    if (Array.isArray(parsed)) seedEmojis = parsed;
  } catch {
    // Only this route writes the column, so unparsable text means someone edited the row
    // by hand. Degrade to no seed reactions rather than 500 the listing the bot needs to
    // post anything at all.
  }
  return {
    guildId: row.guildId,
    channelId: row.channelId,
    seedEmojis,
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
      urls: {
        h264: `${base}/clips/${id}/h264`,
        thumb: `${base}/clips/${id}/thumb`,
        page: `${base}/c/${id}`,
      },
    };
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
    const { channelId, seedEmojis } = parsed.data;
    // Omitting seedEmojis means "leave it alone": a new row falls back to the column
    // default, an existing row keeps whatever the guild configured earlier.
    const values = { guildId, channelId, updatedAt: new Date() };
    const set = { channelId, updatedAt: new Date() };
    if (seedEmojis) {
      values.seedEmojis = JSON.stringify(seedEmojis);
      set.seedEmojis = values.seedEmojis;
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
