// Clip records, presigned uploads, media redirects, listing and rankings.
//
// Lifecycle: POST /clips creates a `pending` row and hands the desktop three presigned PUT
// URLs. The desktop uploads straight to the bucket, then calls /complete; the backend
// verifies each object with a HEAD, flips the row to `ready` and pings the bot. Reads never
// expose bucket URLs: /clips/:id/{av1,h264,thumb} are the stable addresses and redirect to
// a short-lived presigned GET.
//
// Auth decorators (authenticateDevice) and the bot notifier (notifyBot) come from sibling
// plugins that may register after this file, so they are resolved per request, not at load.

import { and, desc, eq, sql } from 'drizzle-orm';
import { z } from 'zod';

import { clips, posts, reactions, users } from '../db/schema.js';
import { newClipId } from '../lib/ids.js';
import { clipKeys } from '../plugins/storage.js';

const MEDIA = {
  av1: { column: 'keyAv1', contentType: 'video/mp4' },
  h264: { column: 'keyH264', contentType: 'video/mp4' },
  thumb: { column: 'keyThumb', contentType: 'image/jpeg' },
};
const MEDIA_NAMES = Object.keys(MEDIA);

const UPLOAD_TTL = 3600;
const MEDIA_TTL = 3600;

const createSchema = z.object({
  game: z.string().trim().max(200).optional(),
  title: z.string().trim().max(200).optional(),
  durationMs: z.number().int().positive(),
  width: z.number().int().positive().optional(),
  height: z.number().int().positive().optional(),
  recordedAt: z.iso.datetime({ offset: true }),
  sizeAv1: z.number().int().nonnegative(),
  sizeH264: z.number().int().nonnegative(),
});

const idSchema = z.object({ id: z.string().regex(/^[0-9A-Za-z]{12}$/) });

const listSchema = z.object({
  user: z.string().min(1).optional(),
  game: z.string().min(1).optional(),
  year: z.coerce.number().int().min(2000).max(2100).optional(),
  sort: z.enum(['recent', 'top']).default('recent'),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  cursor: z.coerce.number().int().nonnegative().default(0),
});

const rankingsSchema = z.object({
  guild: z.string().min(1),
  year: z.coerce.number().int().min(2000).max(2100),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

const toIso = (d) => (d instanceof Date ? d.toISOString() : d ?? null);

/**
 * Public JSON for a clip. Shared with the player page so URLs have one shape.
 * @param {import('fastify').FastifyInstance} app
 * @param {typeof clips.$inferSelect} row
 * @param {{ discordId: string, username: string, avatar: string | null } | null} owner
 * @param {number} [reactions]
 */
export function clipToJson(app, row, owner, reactions = 0) {
  const base = app.config.PUBLIC_URL;
  return {
    id: row.id,
    game: row.game ?? null,
    title: row.title ?? null,
    durationMs: row.durationMs,
    width: row.width ?? null,
    height: row.height ?? null,
    sizeAv1: row.sizeAv1 ?? null,
    sizeH264: row.sizeH264 ?? null,
    recordedAt: toIso(row.recordedAt),
    uploadedAt: toIso(row.uploadedAt),
    owner: owner
      ? { discordId: owner.discordId, username: owner.username, avatar: owner.avatar ?? null }
      : null,
    urls: {
      av1: `${base}/clips/${row.id}/av1`,
      h264: `${base}/clips/${row.id}/h264`,
      thumb: `${base}/clips/${row.id}/thumb`,
      page: `${base}/c/${row.id}`,
    },
    reactions: Number(reactions ?? 0),
  };
}

// Live reaction count for the clip in the outer query: reactions on any of its posts
// whose removed_at is still null.
const liveReactions = sql`(select count(*) from ${reactions}
  inner join ${posts} on ${posts.id} = ${reactions.postId}
  where ${posts.clipId} = ${clips.id} and ${reactions.removedAt} is null)`.mapWith(Number);

const ownerColumns = { discordId: users.discordId, username: users.username, avatar: users.avatar };

// Year filters are evaluated in UTC so results do not depend on the server's time zone.
const recordedInYear = (year) =>
  sql`extract(year from ${clips.recordedAt} at time zone 'UTC') = ${year}`;

const badRequest = (reply, issues) => reply.code(400).send({ error: 'bad_request', issues });
const notFound = (reply) => reply.code(404).send({ error: 'not_found' });

/** @param {import('fastify').FastifyInstance} app */
export default async function clipRoutes(app) {
  // Device auth is provided by plugins/auth.js; resolve it per request so registration
  // order does not matter and tests can substitute their own.
  function deviceAuth(request, reply, done) {
    if (typeof app.authenticateDevice !== 'function') {
      app.log.error('authenticateDevice decorator missing');
      return reply.code(503).send({ error: 'auth_unavailable' });
    }
    return app.authenticateDevice(request, reply, done);
  }

  const requireStorage = (reply) => {
    if (app.storage) return true;
    reply.code(503).send({ error: 'storage_unavailable' });
    return false;
  };

  /** Clip plus owner and live reaction count, or undefined. */
  async function loadClip(id) {
    const rows = await app.db
      .select({ clip: clips, owner: ownerColumns, reactions: liveReactions })
      .from(clips)
      .innerJoin(users, eq(users.id, clips.userId))
      .where(eq(clips.id, id))
      .limit(1);
    return rows[0];
  }

  /** Loads a clip for a mutating route; replies and returns undefined if not allowed. */
  async function loadOwned(request, reply) {
    const params = idSchema.safeParse(request.params);
    if (!params.success) {
      badRequest(reply, params.error.issues);
      return undefined;
    }
    const found = await loadClip(params.data.id);
    if (!found || found.clip.status === 'deleted') {
      notFound(reply);
      return undefined;
    }
    if (found.clip.userId !== request.user.id) {
      reply.code(403).send({ error: 'forbidden' });
      return undefined;
    }
    return found;
  }

  // ---- create -------------------------------------------------------------------------

  app.post('/clips', { preHandler: deviceAuth }, async (request, reply) => {
    if (!requireStorage(reply)) return;
    const parsed = createSchema.safeParse(request.body);
    if (!parsed.success) return badRequest(reply, parsed.error.issues);
    const body = parsed.data;

    const id = newClipId();
    const keys = clipKeys(request.user.id, id);
    await app.db.insert(clips).values({
      id,
      userId: request.user.id,
      game: body.game || null,
      title: body.title || null,
      durationMs: body.durationMs,
      width: body.width ?? null,
      height: body.height ?? null,
      sizeAv1: body.sizeAv1,
      sizeH264: body.sizeH264,
      keyAv1: keys.av1,
      keyH264: keys.h264,
      keyThumb: keys.thumb,
      recordedAt: new Date(body.recordedAt),
      status: 'pending',
    });

    const [av1, h264, thumb] = await Promise.all([
      app.storage.presignPut(keys.av1, MEDIA.av1.contentType, UPLOAD_TTL),
      app.storage.presignPut(keys.h264, MEDIA.h264.contentType, UPLOAD_TTL),
      app.storage.presignPut(keys.thumb, MEDIA.thumb.contentType, UPLOAD_TTL),
    ]);
    request.log.info({ clipId: id, userId: request.user.id }, 'clip created');
    return reply.code(201).send({ id, uploads: { av1, h264, thumb }, expiresIn: UPLOAD_TTL });
  });

  // ---- complete -----------------------------------------------------------------------

  app.post('/clips/:id/complete', { preHandler: deviceAuth }, async (request, reply) => {
    if (!requireStorage(reply)) return;
    const found = await loadOwned(request, reply);
    if (!found) return;
    const { clip } = found;

    const heads = await Promise.all(
      MEDIA_NAMES.map((n) => app.storage.head(clip[MEDIA[n].column])),
    );
    const missing = MEDIA_NAMES.filter((_, i) => heads[i] === null);
    if (missing.length > 0) {
      return reply.code(409).send({ error: 'upload_incomplete', missing });
    }

    const [updated] = await app.db
      .update(clips)
      .set({
        sizeAv1: heads[0].size,
        sizeH264: heads[1].size,
        uploadedAt: new Date(),
        status: 'ready',
      })
      .where(eq(clips.id, clip.id))
      .returning();
    request.log.info({ clipId: clip.id }, 'clip ready');

    if (app.hasDecorator('notifyBot')) {
      // Fire and forget: the bot has its own retry queue and the upload is already durable.
      Promise.resolve()
        .then(() => app.notifyBot(clip.id))
        .catch((err) => request.log.warn({ err, clipId: clip.id }, 'notifyBot failed'));
    }
    return clipToJson(app, updated, found.owner, found.reactions);
  });

  // ---- read ---------------------------------------------------------------------------

  app.get('/clips/:id', async (request, reply) => {
    const params = idSchema.safeParse(request.params);
    if (!params.success) return notFound(reply);
    const found = await loadClip(params.data.id);
    if (!found || found.clip.status !== 'ready') return notFound(reply);
    return clipToJson(app, found.clip, found.owner, found.reactions);
  });

  for (const name of MEDIA_NAMES) {
    const { column, contentType } = MEDIA[name];
    app.get(`/clips/:id/${name}`, async (request, reply) => {
      const params = idSchema.safeParse(request.params);
      if (!params.success) return notFound(reply);
      const found = await loadClip(params.data.id);
      if (!found || found.clip.status !== 'ready') return notFound(reply);
      if (!requireStorage(reply)) return;
      const url = await app.storage.presignGet(found.clip[column], MEDIA_TTL, contentType);
      return reply.header('Cache-Control', 'private, max-age=0').redirect(url, 302);
    });
  }

  // ---- list ---------------------------------------------------------------------------

  app.get('/clips', async (request, reply) => {
    const parsed = listSchema.safeParse(request.query);
    if (!parsed.success) return badRequest(reply, parsed.error.issues);
    const q = parsed.data;

    const where = [eq(clips.status, 'ready')];
    if (q.user) where.push(eq(users.discordId, q.user));
    if (q.game) where.push(eq(clips.game, q.game));
    if (q.year !== undefined) where.push(recordedInYear(q.year));

    const order =
      q.sort === 'top'
        ? [desc(liveReactions), desc(clips.recordedAt), desc(clips.id)]
        : [desc(clips.recordedAt), desc(clips.id)];

    // Offset cursor: one extra row tells us whether there is a next page.
    const rows = await app.db
      .select({ clip: clips, owner: ownerColumns, reactions: liveReactions })
      .from(clips)
      .innerJoin(users, eq(users.id, clips.userId))
      .where(and(...where))
      .orderBy(...order)
      .limit(q.limit + 1)
      .offset(q.cursor);

    const page = rows.slice(0, q.limit);
    return {
      items: page.map((r) => clipToJson(app, r.clip, r.owner, r.reactions)),
      nextCursor: rows.length > q.limit ? String(q.cursor + q.limit) : null,
    };
  });

  // ---- delete -------------------------------------------------------------------------

  app.delete('/clips/:id', { preHandler: deviceAuth }, async (request, reply) => {
    if (!requireStorage(reply)) return;
    const found = await loadOwned(request, reply);
    if (!found) return;
    const { clip } = found;
    await app.storage.deleteMany([clip.keyAv1, clip.keyH264, clip.keyThumb]);
    // Keep the row: posts and reactions reference it and the recap replays history.
    await app.db.update(clips).set({ status: 'deleted' }).where(eq(clips.id, clip.id));
    request.log.info({ clipId: clip.id }, 'clip deleted');
    return reply.code(204).send();
  });

  // ---- rankings -----------------------------------------------------------------------

  app.get('/rankings', async (request, reply) => {
    const parsed = rankingsSchema.safeParse(request.query);
    if (!parsed.success) return badRequest(reply, parsed.error.issues);
    const q = parsed.data;

    // Reactions are joined only while live, so both counts ignore removed rows. A clip
    // with a post in the guild but no reactions still ranks with zeros.
    const reactionCount = sql`count(${reactions.id})`.mapWith(Number);
    const distinctReactors = sql`count(distinct ${reactions.userDiscordId})`.mapWith(Number);

    const rows = await app.db
      .select({ clip: clips, owner: ownerColumns, reactions: reactionCount, distinctReactors })
      .from(clips)
      .innerJoin(users, eq(users.id, clips.userId))
      .innerJoin(posts, and(eq(posts.clipId, clips.id), eq(posts.guildId, q.guild)))
      .leftJoin(reactions, and(eq(reactions.postId, posts.id), sql`${reactions.removedAt} is null`))
      .where(and(eq(clips.status, 'ready'), recordedInYear(q.year)))
      .groupBy(clips.id, users.id)
      .orderBy(desc(distinctReactors), desc(reactionCount), desc(clips.recordedAt), desc(clips.id))
      .limit(q.limit);

    return {
      items: rows.map((r) => ({
        clip: clipToJson(app, r.clip, r.owner, r.reactions),
        reactions: r.reactions,
        distinctReactors: r.distinctReactors,
      })),
    };
  });
}
