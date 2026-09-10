// Bot -> backend routes, protected by BOT_SHARED_SECRET. The bot records the Discord
// message it posted for a clip and every reaction add/remove; reactions are append-only
// rows closed with removed_at so history survives and rankings only count open rows.
//
// Also registers plugins/bot.js so app.notifyBot exists app-wide (app.js only imports
// route files; each route file owns the plugins it needs). Both plugins carry
// skip-override: Fastify encapsulates each registered plugin, so a decorator added two
// levels down would otherwise never reach the root instance the clips routes see.

import { timingSafeEqual } from 'node:crypto';
import { and, count, eq, isNull } from 'drizzle-orm';
import { z } from 'zod';

import botPlugin from '../plugins/bot.js';
import { clips, posts, reactions, users } from '../db/schema.js';

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
}

internalRoutes[Symbol.for('skip-override')] = true;

export default internalRoutes;
