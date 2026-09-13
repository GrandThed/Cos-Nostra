// Clip records, presigned uploads, media redirects, listing and rankings.
//
// Lifecycle: POST /clips creates a `pending` row and hands the desktop three presigned PUT
// URLs. The desktop uploads straight to the bucket, then calls /complete; the backend
// verifies each object with a HEAD, flips the row to `ready` and pings the bot. Reads never
// expose bucket URLs: /clips/:id/{av1,h264,thumb} are the stable addresses and redirect to
// a short-lived presigned GET.
//
// Those three PUT URLs are the only bucket write anybody but the backend ever holds, so
// create is where every limit is applied: each URL is signed for the exact size the desktop
// declared (config MAX_CLIP_MB caps it), and the user's stored bytes have to stay under
// USER_QUOTA_GB. A device token therefore cannot write more than it asked for, or more in
// total than its owner's quota.
//
// Auth decorators (authenticateDevice) and the bot notifier (notifyBot) come from sibling
// plugins that may register after this file, so they are resolved per request, not at load.

import { and, desc, eq, inArray, lt, sql } from 'drizzle-orm';
import { z } from 'zod';

import { clips, posts, reactions, users } from '../db/schema.js';
import { purgeClip } from '../lib/clip-purge.js';
import { newClipId } from '../lib/ids.js';
import { bearer } from '../plugins/auth.js';
import { clipKeys } from '../plugins/storage.js';

const MEDIA = {
  av1: { column: 'keyAv1', contentType: 'video/mp4' },
  h264: { column: 'keyH264', contentType: 'video/mp4' },
  thumb: { column: 'keyThumb', contentType: 'image/jpeg' },
};
const MEDIA_NAMES = Object.keys(MEDIA);

// Short on purpose. A presigned PUT is the only bucket write anyone outside the backend ever
// gets, so it should not outlive the upload it was minted for: it also bounds the window in
// which an object could be replaced after /complete verified it. The desktop never reuses a
// URL across retries - a failed upload job creates a new clip - so nothing needs the hour.
const UPLOAD_TTL = 15 * 60;
const MEDIA_TTL = 3600;

// Optional metadata is `nullish`, not `optional`: the desktop serialises a Rust
// `Option::None` as JSON null, so a clip saved with no game detected used to fail its whole
// upload with a 400 on `game` and `title`. Absent and null mean the same thing here - the
// columns are nullable either way - and being strict about which one the client sent buys
// nothing. Found closing phase 4; see docs/PLAN.md.
const createSchema = z.object({
  game: z.string().trim().max(200).nullish(),
  title: z.string().trim().max(200).nullish(),
  durationMs: z.number().int().positive(),
  width: z.number().int().positive().nullish(),
  height: z.number().int().positive().nullish(),
  recordedAt: z.iso.datetime({ offset: true }),
  // Sizes are a promise, not a hint: each one is signed into its upload URL, so a clip that
  // declares the wrong number cannot upload at all. Zero is rejected for the same reason -
  // it would sign a URL that can only write an empty object.
  sizeAv1: z.number().int().positive(),
  sizeH264: z.number().int().positive(),
  sizeThumb: z.number().int().positive(),
  // Who was in the owner's voice channel when the hotkey was pressed, as Discord user ids.
  // The desktop asks POST /discord/voice-snapshot for these at capture time and hands them
  // back here; the bot @mentions them on the post. Capped so one clip cannot make the bot
  // write a mention storm, and nullish for the same reason the other optional fields are:
  // the desktop serialises a Rust None as null.
  participantDiscordIds: z.array(z.string().min(1)).max(50).nullish(),
});

// A clip the desktop edited: same record, new files. Only what a cut can change is accepted;
// the game, title, resolution and recording time stay what the first upload said.
const replaceSchema = createSchema.pick({
  durationMs: true,
  sizeAv1: true,
  sizeH264: true,
  sizeThumb: true,
});

// The clip site's rename / change-game form (routes/guildSite.js links here indirectly
// through the player page). At least one field must be present, or there is nothing to do.
const updateSchema = z
  .object({
    title: z.string().trim().max(200).nullable().optional(),
    game: z.string().trim().max(200).nullable().optional(),
  })
  .refine((v) => v.title !== undefined || v.game !== undefined, 'nothing to update');

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

// How long a pending clip is left alone after its upload URLs expire. S3 checks a presigned
// URL's expiry when a request starts, not when it ends, so a PUT begun just inside the window
// can still be streaming well after it; the desktop gives a single PUT 30 minutes. With an
// hour of slack the reaper never deletes an object out from under an upload still landing.
const PENDING_GRACE_MS = 60 * 60 * 1000;

/**
 * Bytes a user is already holding: both video copies of every clip that is stored (`ready`)
 * or was ever handed upload URLs and not yet reaped (`pending`, at any age).
 *
 * A pending row counts for as long as it exists because its URLs may already have been used:
 * an expired URL cannot write any more, but whatever it wrote before expiring is still in the
 * bucket. Letting old pending rows fall out of the count would let a client PUT, skip
 * /complete, wait out the TTL and upload again, piling up bytes the quota never sees. What
 * stops an abandoned upload from costing quota forever is `reapAbandoned`, which deletes the
 * objects before the row stops counting. Deleted clips are not counted: their objects are
 * gone. Thumbnails are not counted either - they are capped individually and rounding error
 * next to a video.
 *
 * @param {import('fastify').FastifyInstance} app
 * @param {number} userId
 */
async function storedBytes(app, userId) {
  const [row] = await app.db
    .select({
      total:
        sql`coalesce(sum(coalesce(${clips.sizeAv1}, 0) + coalesce(${clips.sizeH264}, 0)), 0)`.mapWith(
          Number,
        ),
    })
    .from(clips)
    .where(and(eq(clips.userId, userId), inArray(clips.status, ['ready', 'pending'])));
  return row?.total ?? 0;
}

/**
 * Deletes a user's uploads that were started and never completed, once no PUT against them
 * can still be running (see PENDING_GRACE_MS). Objects go first and the rows are marked
 * `deleted` after, so a bucket failure leaves the rows pending and still counted: the quota
 * can over-count for a while, never under-count. Runs per user from create, which is the only
 * request that can be used to repeat an abandoned upload, so nobody can outpace it.
 *
 * @param {import('fastify').FastifyInstance} app
 * @param {import('fastify').FastifyRequest & { user: { id: number } }} request
 */
async function reapAbandoned(app, request) {
  const cutoff = new Date(Date.now() - UPLOAD_TTL * 1000 - PENDING_GRACE_MS);
  const stale = await app.db
    .select({ id: clips.id, keyAv1: clips.keyAv1, keyH264: clips.keyH264, keyThumb: clips.keyThumb })
    .from(clips)
    .where(
      and(eq(clips.userId, request.user.id), eq(clips.status, 'pending'), lt(clips.createdAt, cutoff)),
    );
  if (stale.length === 0) return;
  try {
    await app.storage.deleteMany(stale.flatMap((c) => [c.keyAv1, c.keyH264, c.keyThumb]));
  } catch (err) {
    request.log.warn({ err, userId: request.user.id }, 'could not delete abandoned uploads');
    return;
  }
  const ids = stale.map((c) => c.id);
  await app.db.update(clips).set({ status: 'deleted' }).where(inArray(clips.id, ids));
  request.log.info({ userId: request.user.id, clipIds: ids }, 'abandoned uploads deleted');
}

/**
 * The limits create and replace share: every file under its cap, and the user's stored bytes
 * plus the two videos under the quota. `freeing` is what the request gives back when it
 * lands, the current size of the clip a replace overwrites.
 *
 * @param {import('fastify').FastifyInstance} app
 * @param {number} userId
 * @param {{ sizeAv1: number, sizeH264: number, sizeThumb: number }} sizes
 * @param {number} [freeing]
 * @returns {Promise<null | Record<string, string | number>>} null when allowed, else the 413 body
 */
async function refuseOverLimits(app, userId, sizes, freeing = 0) {
  const { maxClipBytes, maxThumbBytes, userQuotaBytes } = app.config.limits;
  const tooBig = [
    ['av1', sizes.sizeAv1, maxClipBytes],
    ['h264', sizes.sizeH264, maxClipBytes],
    ['thumb', sizes.sizeThumb, maxThumbBytes],
  ].find(([, size, max]) => size > max);
  if (tooBig) {
    const [file, size, max] = tooBig;
    return { error: 'clip_too_large', file, size, max };
  }
  if (userQuotaBytes > 0) {
    const used = (await storedBytes(app, userId)) - freeing;
    const wanted = sizes.sizeAv1 + sizes.sizeH264;
    if (used + wanted > userQuotaBytes) {
      return { error: 'quota_exceeded', used, wanted, quota: userQuotaBytes };
    }
  }
  return null;
}

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

  // The clip site's management panel (routes/guildSite.js / routes/player.js) authenticates
  // with the browser session cookie instead of a device token; both decorators normalize to
  // the same request.user shape (plugins/auth.js, plugins/session.js), so everything below
  // this point - ownership checks included - does not need to know which one was used. A
  // Bearer header, when present, always means the desktop app, so it takes priority.
  async function deviceOrSessionAuth(request, reply) {
    if (bearer(request)) return deviceAuth(request, reply, () => {});
    if (typeof app.authenticateSession !== 'function') {
      app.log.error('authenticateSession decorator missing');
      return reply.code(503).send({ error: 'auth_unavailable' });
    }
    return app.authenticateSession(request, reply);
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

    await reapAbandoned(app, request);
    const refusal = await refuseOverLimits(app, request.user.id, body);
    if (refusal) {
      request.log.info({ userId: request.user.id, ...refusal }, 'clip rejected');
      return reply.code(413).send(refusal);
    }

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
      participants: JSON.stringify(body.participantDiscordIds ?? []),
      recordedAt: new Date(body.recordedAt),
      status: 'pending',
    });

    // Each URL is signed for the exact size declared above, so these three signatures are
    // the whole of what this request can ever write to the bucket.
    const [av1, h264, thumb] = await Promise.all([
      app.storage.presignPut(keys.av1, MEDIA.av1.contentType, UPLOAD_TTL, body.sizeAv1),
      app.storage.presignPut(keys.h264, MEDIA.h264.contentType, UPLOAD_TTL, body.sizeH264),
      app.storage.presignPut(keys.thumb, MEDIA.thumb.contentType, UPLOAD_TTL, body.sizeThumb),
    ]);
    request.log.info({ clipId: id, userId: request.user.id }, 'clip created');
    return reply.code(201).send({ id, uploads: { av1, h264, thumb }, expiresIn: UPLOAD_TTL });
  });

  // ---- replace ------------------------------------------------------------------------
  //
  // An edited clip keeps its id, so the page URL and the Discord post keep working, and the
  // desktop gets the same three PUT URLs a create hands out, signed for the new sizes and
  // pointing at the same keys. The row stays `ready` throughout: a PUT to an existing key is
  // atomic, so viewers see the old video until the new one has fully landed, never a gap.
  // /complete then records the new sizes and length without pinging the bot again.

  app.post('/clips/:id/replace', { preHandler: deviceAuth }, async (request, reply) => {
    if (!requireStorage(reply)) return;
    const found = await loadOwned(request, reply);
    if (!found) return;
    const { clip } = found;
    if (clip.status !== 'ready') {
      return reply.code(409).send({ error: 'not_ready', status: clip.status });
    }
    const parsed = replaceSchema.safeParse(request.body);
    if (!parsed.success) return badRequest(reply, parsed.error.issues);
    const body = parsed.data;

    // The clip's current bytes are overwritten when the replacement lands, so they do not
    // count against it.
    const freeing = (clip.sizeAv1 ?? 0) + (clip.sizeH264 ?? 0);
    const refusal = await refuseOverLimits(app, request.user.id, body, freeing);
    if (refusal) {
      request.log.info({ clipId: clip.id, ...refusal }, 'replace rejected');
      return reply.code(413).send(refusal);
    }

    // Until /complete has looked at the bucket, the row has to cover whichever of the old and
    // new objects is larger, because either may be what is there. Writing the declared sizes
    // outright would let a client declare one byte, never upload and never complete, and so
    // make a clip whose real objects are still in the bucket count as almost nothing. Taking
    // the greater can only over-count, and only until /complete records what landed.
    await app.db
      .update(clips)
      .set({
        durationMs: body.durationMs,
        sizeAv1: sql`greatest(${clips.sizeAv1}, ${body.sizeAv1})`,
        sizeH264: sql`greatest(${clips.sizeH264}, ${body.sizeH264})`,
      })
      .where(eq(clips.id, clip.id));

    const [av1, h264, thumb] = await Promise.all([
      app.storage.presignPut(clip.keyAv1, MEDIA.av1.contentType, UPLOAD_TTL, body.sizeAv1),
      app.storage.presignPut(clip.keyH264, MEDIA.h264.contentType, UPLOAD_TTL, body.sizeH264),
      app.storage.presignPut(clip.keyThumb, MEDIA.thumb.contentType, UPLOAD_TTL, body.sizeThumb),
    ]);
    request.log.info({ clipId: clip.id, userId: request.user.id }, 'clip replace started');
    return { id: clip.id, uploads: { av1, h264, thumb }, expiresIn: UPLOAD_TTL };
  });

  // ---- complete -----------------------------------------------------------------------

  app.post('/clips/:id/complete', { preHandler: deviceAuth }, async (request, reply) => {
    if (!requireStorage(reply)) return;
    const found = await loadOwned(request, reply);
    if (!found) return;
    const { clip } = found;
    // A replace completes through here too; the bot only hears about the first upload,
    // since the Discord post already exists and points at the same URL.
    const firstUpload = clip.status === 'pending';

    const heads = await Promise.all(
      MEDIA_NAMES.map((n) => app.storage.head(clip[MEDIA[n].column])),
    );
    const missing = MEDIA_NAMES.filter((_, i) => heads[i] === null);
    if (missing.length > 0) {
      return reply.code(409).send({ error: 'upload_incomplete', missing });
    }

    // The signed content-length should have made this impossible at the bucket. It is
    // checked again here because that enforcement lives in someone else's S3 implementation,
    // and an object that got past it would otherwise be recorded as a ready clip.
    const { maxClipBytes, maxThumbBytes } = app.config.limits;
    const caps = { av1: maxClipBytes, h264: maxClipBytes, thumb: maxThumbBytes };
    const oversized = MEDIA_NAMES.filter((n, i) => heads[i].size > caps[n]);
    if (oversized.length > 0) {
      request.log.warn(
        { clipId: clip.id, oversized, sizes: heads.map((h) => h.size) },
        'oversized objects in the bucket: the signed content-length was not enforced',
      );
      await app.storage.deleteMany([clip.keyAv1, clip.keyH264, clip.keyThumb]);
      await app.db.update(clips).set({ status: 'deleted' }).where(eq(clips.id, clip.id));
      return reply.code(413).send({ error: 'clip_too_large', files: oversized });
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
    request.log.info({ clipId: clip.id }, firstUpload ? 'clip ready' : 'clip replaced');

    if (firstUpload && app.hasDecorator('notifyBot')) {
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

  // ---- update -------------------------------------------------------------------------
  //
  // Rename or re-tag a clip's game. This is the clip site's management panel (routes/
  // guildSite.js / routes/player.js) as well as anything the desktop might add later; both
  // use the exact same route and ownership check, just with a different credential.

  app.patch('/clips/:id', { preHandler: deviceOrSessionAuth }, async (request, reply) => {
    const found = await loadOwned(request, reply);
    if (!found) return;
    const parsed = updateSchema.safeParse(request.body);
    if (!parsed.success) return badRequest(reply, parsed.error.issues);
    const { clip } = found;
    const set = {};
    if (parsed.data.title !== undefined) set.title = parsed.data.title || null;
    if (parsed.data.game !== undefined) set.game = parsed.data.game || null;

    const [updated] = await app.db.update(clips).set(set).where(eq(clips.id, clip.id)).returning();
    request.log.info({ clipId: clip.id, userId: request.user.id, fields: Object.keys(set) }, 'clip updated');
    return clipToJson(app, updated, found.owner, found.reactions);
  });

  // ---- delete -------------------------------------------------------------------------

  app.delete('/clips/:id', { preHandler: deviceOrSessionAuth }, async (request, reply) => {
    if (!requireStorage(reply)) return;
    const found = await loadOwned(request, reply);
    if (!found) return;
    // Same helper the bot's manage menu calls through DELETE /internal/clips/:id, so a clip
    // deleted from Discord and one deleted from here end up in exactly the same state.
    await purgeClip(app, found.clip);
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
