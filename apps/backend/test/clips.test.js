// Clip routes against PGlite with fake S3 credentials. Presigning is pure computation so no
// bucket is needed; head/deleteMany are stubbed on app.storage. If plugins/auth.js is not
// registered yet, a minimal Bearer-token preHandler stands in for it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import http from 'node:http';
import { setTimeout as sleep } from 'node:timers/promises';

import { eq } from 'drizzle-orm';

import { buildApp } from '../src/app.js';
import { clips, devices, posts, reactions, users } from '../src/db/schema.js';
import { randomId } from '../src/lib/ids.js';
import { testEnv } from './helpers.js';

const s3Env = {
  S3_ENDPOINT: 'http://127.0.0.1:9',
  S3_BUCKET: 'test-bucket',
  S3_ACCESS_KEY_ID: 'AKIATEST',
  S3_SECRET_ACCESS_KEY: 'secret-test',
  S3_URL_STYLE: 'path',
};

const sha256 = (s) => createHash('sha256').update(s).digest('hex');

// Stand-in for the bot's internal server: records every clip id POSTed to /post.
async function fakeBot() {
  const notified = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      if (req.method === 'POST' && req.url === '/post') notified.push(JSON.parse(body).clipId);
      res.writeHead(204).end();
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}`;
  return { notified, url, close: () => new Promise((resolve) => server.close(resolve)) };
}

async function clipApp(extraEnv = {}) {
  const bot = await fakeBot();
  const app = await buildApp({
    env: { ...testEnv, ...s3Env, BOT_INTERNAL_URL: bot.url, ...extraEnv },
    fastify: { logger: false },
  });
  app.addHook('onClose', () => bot.close());

  if (!app.hasDecorator('authenticateDevice')) {
    app.decorate('authenticateDevice', async (request, reply) => {
      const token = (request.headers.authorization ?? '').replace(/^Bearer\s+/i, '');
      const rows = await app.db
        .select({ device: devices, user: users })
        .from(devices)
        .innerJoin(users, eq(users.id, devices.userId))
        .where(eq(devices.tokenHash, sha256(token)))
        .limit(1);
      if (!token || rows.length === 0) return reply.code(401).send({ error: 'unauthorized' });
      request.device = rows[0].device;
      const u = rows[0].user;
      request.user = { id: u.id, discordId: u.discordId, username: u.username, avatar: u.avatar };
    });
  }
  if (!app.hasDecorator('notifyBot')) {
    app.decorate('notifyBot', async (clipId) => {
      bot.notified.push(clipId);
    });
  }
  await app.ready();
  app.notified = bot.notified;
  return app;
}

async function waitForNotification(app, count) {
  for (let i = 0; i < 50 && app.notified.length < count; i++) await sleep(20);
}

async function makeUser(app, discordId, username, token) {
  const [user] = await app.db.insert(users).values({ discordId, username, avatar: null }).returning();
  await app.db.insert(devices).values({ userId: user.id, name: 'pc', tokenHash: sha256(token) });
  return user;
}

async function insertReadyClip(app, user, fields) {
  const id = randomId();
  const [row] = await app.db
    .insert(clips)
    .values({
      id,
      userId: user.id,
      durationMs: 30000,
      keyAv1: `clips/${user.id}/${id}/av1.mp4`,
      keyH264: `clips/${user.id}/${id}/h264.mp4`,
      keyThumb: `clips/${user.id}/${id}/thumb.jpg`,
      status: 'ready',
      uploadedAt: new Date(),
      ...fields,
    })
    .returning();
  return row;
}

async function insertPost(app, clipId, guildId, messageId) {
  const [row] = await app.db
    .insert(posts)
    .values({ clipId, guildId, channelId: 'chan', messageId })
    .returning();
  return row;
}

async function react(app, postId, userDiscordId, emoji, removed = false) {
  await app.db.insert(reactions).values({
    postId,
    userDiscordId,
    emoji,
    removedAt: removed ? new Date() : null,
  });
}

const auth = (token) => ({ authorization: `Bearer ${token}` });

const validBody = {
  game: 'Valorant',
  title: 'ace',
  durationMs: 30000,
  width: 1920,
  height: 1080,
  recordedAt: '2025-06-01T12:00:00.000Z',
  sizeAv1: 1000,
  sizeH264: 2000,
  sizeThumb: 100,
};

test('ids are 12 base62 characters and unique', () => {
  const seen = new Set();
  for (let i = 0; i < 1000; i++) {
    const id = randomId();
    assert.match(id, /^[0-9A-Za-z]{12}$/);
    seen.add(id);
  }
  assert.equal(seen.size, 1000);
});

test('POST /clips answers 503 without storage', async () => {
  const app = await clipApp({ S3_ENDPOINT: '' });
  try {
    assert.equal(app.storage, null);
    await makeUser(app, '100', 'nobucket', 'tok-nobucket');
    const res = await app.inject({
      method: 'POST',
      url: '/clips',
      headers: auth('tok-nobucket'),
      payload: validBody,
    });
    assert.equal(res.statusCode, 503);
    assert.deepEqual(res.json(), { error: 'storage_unavailable' });
  } finally {
    await app.close();
  }
});

test('create, complete and read a clip', async () => {
  const app = await clipApp();
  try {
    const user = await makeUser(app, '111', 'alice', 'tok-alice');

    const unauth = await app.inject({ method: 'POST', url: '/clips', payload: validBody });
    assert.equal(unauth.statusCode, 401);

    const bad = await app.inject({
      method: 'POST',
      url: '/clips',
      headers: auth('tok-alice'),
      payload: { ...validBody, durationMs: -1 },
    });
    assert.equal(bad.statusCode, 400);
    assert.equal(bad.json().error, 'bad_request');
    assert.ok(Array.isArray(bad.json().issues));

    const created = await app.inject({
      method: 'POST',
      url: '/clips',
      headers: auth('tok-alice'),
      payload: validBody,
    });
    assert.equal(created.statusCode, 201, created.body);
    const { id, uploads, expiresIn } = created.json();
    assert.match(id, /^[0-9A-Za-z]{12}$/);
    assert.equal(expiresIn, 900);
    for (const [name, file] of [['av1', 'av1.mp4'], ['h264', 'h264.mp4'], ['thumb', 'thumb.jpg']]) {
      const url = new URL(uploads[name]);
      assert.equal(url.origin, 'http://127.0.0.1:9');
      assert.equal(url.pathname, `/test-bucket/clips/${user.id}/${id}/${file}`);
      assert.equal(url.searchParams.get('X-Amz-Algorithm'), 'AWS4-HMAC-SHA256');
      assert.equal(url.searchParams.get('X-Amz-Expires'), '900');
      assert.ok(url.searchParams.get('X-Amz-Signature'));
      // content-length is signed, so the URL can only write the size that was declared.
      // content-type is not: the SDK drops it, and the uploader sets it on the PUT itself.
      assert.equal(url.searchParams.get('X-Amz-SignedHeaders'), 'content-length;host');
    }

    // Pending clips are invisible.
    assert.equal((await app.inject({ method: 'GET', url: `/clips/${id}` })).statusCode, 404);
    assert.equal((await app.inject({ method: 'GET', url: `/clips/${id}/av1` })).statusCode, 404);

    // Complete with the thumbnail missing.
    const objects = {
      [`clips/${user.id}/${id}/av1.mp4`]: { size: 1234, contentType: 'video/mp4' },
      [`clips/${user.id}/${id}/h264.mp4`]: { size: 5678, contentType: 'video/mp4' },
    };
    app.storage.head = async (key) => objects[key] ?? null;
    let res = await app.inject({
      method: 'POST',
      url: `/clips/${id}/complete`,
      headers: auth('tok-alice'),
    });
    assert.equal(res.statusCode, 409);
    assert.deepEqual(res.json(), { error: 'upload_incomplete', missing: ['thumb'] });
    assert.deepEqual(app.notified, []);

    // Someone else cannot complete it.
    await makeUser(app, '222', 'bob', 'tok-bob');
    res = await app.inject({ method: 'POST', url: `/clips/${id}/complete`, headers: auth('tok-bob') });
    assert.equal(res.statusCode, 403);

    objects[`clips/${user.id}/${id}/thumb.jpg`] = { size: 99, contentType: 'image/jpeg' };
    res = await app.inject({ method: 'POST', url: `/clips/${id}/complete`, headers: auth('tok-alice') });
    assert.equal(res.statusCode, 200, res.body);
    let json = res.json();
    assert.equal(json.sizeAv1, 1234);
    assert.equal(json.sizeH264, 5678);
    assert.ok(json.uploadedAt);
    await waitForNotification(app, 1);
    assert.deepEqual(app.notified, [id]);

    res = await app.inject({ method: 'GET', url: `/clips/${id}` });
    assert.equal(res.statusCode, 200);
    json = res.json();
    assert.deepEqual(json, {
      id,
      game: 'Valorant',
      title: 'ace',
      durationMs: 30000,
      width: 1920,
      height: 1080,
      sizeAv1: 1234,
      sizeH264: 5678,
      recordedAt: '2025-06-01T12:00:00.000Z',
      uploadedAt: json.uploadedAt,
      owner: { discordId: '111', username: 'alice', avatar: null },
      urls: {
        av1: `http://localhost:3000/clips/${id}/av1`,
        h264: `http://localhost:3000/clips/${id}/h264`,
        thumb: `http://localhost:3000/clips/${id}/thumb`,
        page: `http://localhost:3000/c/${id}`,
      },
      reactions: 0,
    });

    // Media redirects to a signed GET.
    for (const [name, file, type] of [
      ['av1', 'av1.mp4', 'video/mp4'],
      ['h264', 'h264.mp4', 'video/mp4'],
      ['thumb', 'thumb.jpg', 'image/jpeg'],
    ]) {
      res = await app.inject({ method: 'GET', url: `/clips/${id}/${name}` });
      assert.equal(res.statusCode, 302);
      assert.equal(res.headers['cache-control'], 'private, max-age=0');
      const url = new URL(res.headers.location);
      assert.equal(url.pathname, `/test-bucket/clips/${user.id}/${id}/${file}`);
      assert.ok(url.searchParams.get('X-Amz-Signature'));
      assert.equal(url.searchParams.get('response-content-type'), type);
    }

    // Delete: objects removed, row kept as deleted, reads 404.
    const deleted = [];
    app.storage.deleteMany = async (keys) => deleted.push(...keys);
    res = await app.inject({ method: 'DELETE', url: `/clips/${id}`, headers: auth('tok-bob') });
    assert.equal(res.statusCode, 403);
    res = await app.inject({ method: 'DELETE', url: `/clips/${id}`, headers: auth('tok-alice') });
    assert.equal(res.statusCode, 204);
    assert.deepEqual(deleted.sort(), Object.keys(objects).sort());
    const [row] = await app.db.select().from(clips).where(eq(clips.id, id));
    assert.equal(row.status, 'deleted');
    assert.equal((await app.inject({ method: 'GET', url: `/clips/${id}` })).statusCode, 404);
    assert.equal((await app.inject({ method: 'GET', url: `/clips/${id}/h264` })).statusCode, 404);
    res = await app.inject({ method: 'DELETE', url: `/clips/${id}`, headers: auth('tok-alice') });
    assert.equal(res.statusCode, 404);
  } finally {
    await app.close();
  }
});

test('replace re-signs the same keys, keeps the id and does not re-post', async () => {
  const app = await clipApp({ MAX_CLIP_MB: '10', USER_QUOTA_GB: '1' });
  try {
    const user = await makeUser(app, '500', 'editor', 'tok-editor');
    await makeUser(app, '501', 'other', 'tok-other');

    const created = await app.inject({
      method: 'POST',
      url: '/clips',
      headers: auth('tok-editor'),
      payload: validBody,
    });
    assert.equal(created.statusCode, 201, created.body);
    const { id } = created.json();
    const keys = {
      av1: `clips/${user.id}/${id}/av1.mp4`,
      h264: `clips/${user.id}/${id}/h264.mp4`,
      thumb: `clips/${user.id}/${id}/thumb.jpg`,
    };

    // A clip that has not finished its first upload cannot be replaced.
    const early = await app.inject({
      method: 'POST',
      url: `/clips/${id}/replace`,
      headers: auth('tok-editor'),
      payload: { durationMs: 12000, sizeAv1: 500, sizeH264: 900, sizeThumb: 80 },
    });
    assert.equal(early.statusCode, 409);
    assert.equal(early.json().error, 'not_ready');

    const objects = {
      [keys.av1]: { size: 1000, contentType: 'video/mp4' },
      [keys.h264]: { size: 2000, contentType: 'video/mp4' },
      [keys.thumb]: { size: 100, contentType: 'image/jpeg' },
    };
    app.storage.head = async (key) => objects[key] ?? null;
    let res = await app.inject({ method: 'POST', url: `/clips/${id}/complete`, headers: auth('tok-editor') });
    assert.equal(res.statusCode, 200, res.body);
    await waitForNotification(app, 1);
    assert.deepEqual(app.notified, [id]);

    // Not the owner, bad body, too large: refused before anything changes.
    res = await app.inject({
      method: 'POST',
      url: `/clips/${id}/replace`,
      headers: auth('tok-other'),
      payload: { durationMs: 12000, sizeAv1: 500, sizeH264: 900, sizeThumb: 80 },
    });
    assert.equal(res.statusCode, 403);
    res = await app.inject({
      method: 'POST',
      url: `/clips/${id}/replace`,
      headers: auth('tok-editor'),
      payload: { durationMs: 12000, sizeAv1: 0, sizeH264: 900, sizeThumb: 80 },
    });
    assert.equal(res.statusCode, 400);
    res = await app.inject({
      method: 'POST',
      url: `/clips/${id}/replace`,
      headers: auth('tok-editor'),
      payload: { durationMs: 12000, sizeAv1: 11 * MB, sizeH264: 900, sizeThumb: 80 },
    });
    assert.equal(res.statusCode, 413);
    assert.equal(res.json().file, 'av1');

    // The replace: same keys, signed for the new sizes, row still readable meanwhile.
    const signed = [];
    const realPresign = app.storage.presignPut;
    app.storage.presignPut = (key, contentType, expires, contentLength) => {
      signed.push([key, contentLength]);
      return realPresign(key, contentType, expires, contentLength);
    };
    res = await app.inject({
      method: 'POST',
      url: `/clips/${id}/replace`,
      headers: auth('tok-editor'),
      payload: { durationMs: 12000, sizeAv1: 500, sizeH264: 900, sizeThumb: 80 },
    });
    assert.equal(res.statusCode, 200, res.body);
    assert.equal(res.json().id, id);
    assert.equal(res.json().expiresIn, 900);
    assert.deepEqual(signed, [
      [keys.av1, 500],
      [keys.h264, 900],
      [keys.thumb, 80],
    ]);
    for (const name of ['av1', 'h264', 'thumb']) {
      assert.equal(new URL(res.json().uploads[name]).pathname, `/test-bucket/${keys[name]}`);
    }
    assert.equal((await app.inject({ method: 'GET', url: `/clips/${id}` })).statusCode, 200);
    assert.equal((await app.inject({ method: 'GET', url: `/clips/${id}/h264` })).statusCode, 302);

    // The second complete records what landed and stays quiet towards the bot.
    objects[keys.av1].size = 512;
    objects[keys.h264].size = 933;
    res = await app.inject({ method: 'POST', url: `/clips/${id}/complete`, headers: auth('tok-editor') });
    assert.equal(res.statusCode, 200, res.body);
    assert.equal(res.json().durationMs, 12000);
    assert.equal(res.json().sizeAv1, 512);
    assert.equal(res.json().sizeH264, 933);
    await sleep(60);
    assert.deepEqual(app.notified, [id], 'no second Discord post');

    // The quota counts the clip's own bytes as freed: with 1004 MB held elsewhere, a 20 MB
    // replacement lands exactly on the 1 GiB line and one byte more does not.
    res = await app.inject({
      method: 'POST',
      url: `/clips/${id}/replace`,
      headers: auth('tok-editor'),
      payload: { durationMs: 12000, sizeAv1: 10 * MB, sizeH264: 10 * MB, sizeThumb: 80 },
    });
    assert.equal(res.statusCode, 200, res.body);
    const elsewhere = await insertReadyClip(app, user, {
      sizeAv1: 502 * MB,
      sizeH264: 502 * MB,
      recordedAt: new Date('2025-06-01T00:00:00Z'),
    });
    res = await app.inject({
      method: 'POST',
      url: `/clips/${id}/replace`,
      headers: auth('tok-editor'),
      payload: { durationMs: 12000, sizeAv1: 10 * MB, sizeH264: 10 * MB, sizeThumb: 80 },
    });
    assert.equal(res.statusCode, 200, 'the clip being replaced does not count against itself');
    await app.db
      .update(clips)
      .set({ sizeH264: 502 * MB + 1 })
      .where(eq(clips.id, elsewhere.id));
    res = await app.inject({
      method: 'POST',
      url: `/clips/${id}/replace`,
      headers: auth('tok-editor'),
      payload: { durationMs: 12000, sizeAv1: 10 * MB, sizeH264: 10 * MB, sizeThumb: 80 },
    });
    assert.equal(res.statusCode, 413);
    assert.equal(res.json().error, 'quota_exceeded');
  } finally {
    await app.close();
  }
});

test('a clip with no game uploads: null means absent, not invalid', async () => {
  // The desktop serialises Rust Option::None as JSON null, which an .optional() schema
  // rejects. That 400'd the whole upload of any clip saved with no game detected - found
  // on a real clip while closing phase 4, so it stays covered here.
  const app = await clipApp();
  try {
    await makeUser(app, '150', 'nogame', 'tok-nogame');
    for (const body of [
      { ...validBody, game: null, title: null },
      { ...validBody, game: null, title: null, width: null, height: null },
      (({ game, title, ...rest }) => rest)(validBody),
    ]) {
      const res = await app.inject({
        method: 'POST',
        url: '/clips',
        headers: auth('tok-nogame'),
        payload: body,
      });
      assert.equal(res.statusCode, 201, res.body);
      const read = await app.inject({ method: 'GET', url: `/clips/${res.json().id}` });
      // Still pending, so the public read is a 404; the row is what matters here.
      assert.equal(read.statusCode, 404);
    }
    // A wrong type is still a 400: nullish widened null, it did not switch validation off.
    const bad = await app.inject({
      method: 'POST',
      url: '/clips',
      headers: auth('tok-nogame'),
      payload: { ...validBody, game: 42 },
    });
    assert.equal(bad.statusCode, 400);
  } finally {
    await app.close();
  }
});

test('POST /clips stores participantDiscordIds as a JSON array, and [] when absent', async () => {
  // Who was in voice with the owner when the hotkey was pressed. Stored as JSON text like
  // guild_settings.seed_emojis, read back only by the bot through GET /internal/clips/:id.
  const app = await clipApp();
  try {
    await makeUser(app, '160', 'voice', 'tok-voice');
    const create = (payload) =>
      app.inject({ method: 'POST', url: '/clips', headers: auth('tok-voice'), payload });
    const stored = async (id) => {
      const [row] = await app.db.select().from(clips).where(eq(clips.id, id));
      return row.participants;
    };

    const withIds = await create({ ...validBody, participantDiscordIds: ['111', '222'] });
    assert.equal(withIds.statusCode, 201, withIds.body);
    assert.equal(await stored(withIds.json().id), '["111","222"]');

    // Absent, explicitly null and an empty list all mean "tag nobody" - the desktop sends
    // null for a Rust None, and the column is NOT NULL, so all three land as '[]'.
    for (const payload of [
      validBody,
      { ...validBody, participantDiscordIds: null },
      { ...validBody, participantDiscordIds: [] },
    ]) {
      const res = await create(payload);
      assert.equal(res.statusCode, 201, res.body);
      assert.equal(await stored(res.json().id), '[]');
    }

    for (const bad of [
      { ...validBody, participantDiscordIds: ['ok', ''] },
      { ...validBody, participantDiscordIds: 'everyone' },
      { ...validBody, participantDiscordIds: [1, 2] },
      // Capped so one clip cannot make the bot write a mention storm.
      { ...validBody, participantDiscordIds: Array.from({ length: 51 }, (_, i) => String(i)) },
    ]) {
      const res = await create(bad);
      assert.equal(res.statusCode, 400, `expected 400 for ${JSON.stringify(bad.participantDiscordIds).slice(0, 40)}`);
    }
  } finally {
    await app.close();
  }
});

test('a clip read publicly never exposes its participants', async () => {
  const app = await clipApp();
  try {
    const user = await makeUser(app, '161', 'private', 'tok-private');
    const clip = await insertReadyClip(app, user, {
      participants: '["999"]',
      game: 'Doom',
      recordedAt: new Date('2026-01-02T03:04:05Z'),
    });
    const res = await app.inject({ method: 'GET', url: `/clips/${clip.id}` });
    assert.equal(res.statusCode, 200);
    assert.ok(!('participants' in res.json()), 'who you played with is not public');

    const list = await app.inject({ method: 'GET', url: '/clips' });
    assert.ok(!('participants' in list.json().items[0]));
  } finally {
    await app.close();
  }
});

test('listing filters, sorting, pagination and rankings', async () => {
  const app = await clipApp();
  try {
    const alice = await makeUser(app, '111', 'alice', 'tok-alice');
    const bob = await makeUser(app, '222', 'bob', 'tok-bob');

    const c1 = await insertReadyClip(app, alice, { game: 'Valorant', recordedAt: new Date('2025-03-01T00:00:00Z') });
    const c2 = await insertReadyClip(app, alice, { game: 'Apex', recordedAt: new Date('2025-06-01T00:00:00Z') });
    const c3 = await insertReadyClip(app, bob, { game: 'Valorant', recordedAt: new Date('2024-05-01T00:00:00Z') });
    await insertReadyClip(app, alice, { game: 'Apex', recordedAt: new Date('2025-08-01T00:00:00Z'), status: 'pending' });
    const c5 = await insertReadyClip(app, bob, { game: 'Apex', recordedAt: new Date('2025-07-01T00:00:00Z') });
    const c6 = await insertReadyClip(app, alice, { game: 'Apex', recordedAt: new Date('2025-01-01T00:00:00Z') });

    const p1 = await insertPost(app, c1.id, 'G1', 'm1');
    const p2 = await insertPost(app, c2.id, 'G1', 'm2');
    const p3 = await insertPost(app, c3.id, 'G1', 'm3');
    const p5 = await insertPost(app, c5.id, 'G2', 'm5');
    const p6 = await insertPost(app, c6.id, 'G1', 'm6');

    // c1: 3 live reactions from 2 users, plus one removed.
    await react(app, p1.id, 'u1', 'fire');
    await react(app, p1.id, 'u2', 'fire');
    await react(app, p1.id, 'u2', 'heart');
    await react(app, p1.id, 'u3', 'fire', true);
    // c2: 2 live from 1 user.
    await react(app, p2.id, 'u1', 'fire');
    await react(app, p2.id, 'u1', 'heart');
    // c3: 5 live (2024, so out of the 2025 rankings).
    for (const u of ['a', 'b', 'c', 'd', 'e']) await react(app, p3.id, u, 'fire');
    // c5: 1 live in another guild.
    await react(app, p5.id, 'u1', 'fire');
    // c6: 3 live from 3 distinct users, beats c1 on distinct reactors.
    await react(app, p6.id, 'u1', 'fire');
    await react(app, p6.id, 'u2', 'fire');
    await react(app, p6.id, 'u3', 'fire');

    const ids = (res) => res.json().items.map((c) => c.id);
    let res;

    res = await app.inject({ method: 'GET', url: '/clips' });
    assert.equal(res.statusCode, 200);
    assert.deepEqual(ids(res), [c5.id, c2.id, c1.id, c6.id, c3.id]);
    assert.equal(res.json().nextCursor, null);
    assert.equal(res.json().items.find((c) => c.id === c1.id).reactions, 3);

    res = await app.inject({ method: 'GET', url: '/clips?user=111' });
    assert.deepEqual(ids(res), [c2.id, c1.id, c6.id]);

    res = await app.inject({ method: 'GET', url: '/clips?game=Valorant' });
    assert.deepEqual(ids(res), [c1.id, c3.id]);

    res = await app.inject({ method: 'GET', url: '/clips?year=2024' });
    assert.deepEqual(ids(res), [c3.id]);

    res = await app.inject({ method: 'GET', url: '/clips?sort=top&year=2025' });
    assert.deepEqual(ids(res), [c1.id, c6.id, c2.id, c5.id]);

    res = await app.inject({ method: 'GET', url: '/clips?sort=top&limit=2' });
    assert.deepEqual(ids(res), [c3.id, c1.id]);
    assert.equal(res.json().nextCursor, '2');
    res = await app.inject({ method: 'GET', url: `/clips?sort=top&limit=2&cursor=2` });
    assert.deepEqual(ids(res), [c6.id, c2.id]);
    assert.equal(res.json().nextCursor, '4');
    res = await app.inject({ method: 'GET', url: `/clips?sort=top&limit=2&cursor=4` });
    assert.deepEqual(ids(res), [c5.id]);
    assert.equal(res.json().nextCursor, null);

    res = await app.inject({ method: 'GET', url: '/clips?limit=500' });
    assert.equal(res.statusCode, 400);
    res = await app.inject({ method: 'GET', url: '/clips?sort=weird' });
    assert.equal(res.statusCode, 400);

    // Rankings for G1 in 2025: c6 (3 reactions, 3 reactors), c1 (3, 2), c2 (2, 1).
    res = await app.inject({ method: 'GET', url: '/rankings?guild=G1&year=2025' });
    assert.equal(res.statusCode, 200, res.body);
    assert.deepEqual(
      res.json().items.map((i) => [i.clip.id, i.reactions, i.distinctReactors]),
      [
        [c6.id, 3, 3],
        [c1.id, 3, 2],
        [c2.id, 2, 1],
      ],
    );
    assert.equal(res.json().items[0].clip.owner.username, 'alice');
    assert.equal(res.json().items[0].clip.reactions, 3);

    res = await app.inject({ method: 'GET', url: '/rankings?guild=G1&year=2024' });
    assert.deepEqual(res.json().items.map((i) => [i.clip.id, i.reactions, i.distinctReactors]), [[c3.id, 5, 5]]);

    res = await app.inject({ method: 'GET', url: '/rankings?guild=G2&year=2025&limit=1' });
    assert.deepEqual(res.json().items.map((i) => i.clip.id), [c5.id]);

    res = await app.inject({ method: 'GET', url: '/rankings?year=2025' });
    assert.equal(res.statusCode, 400);
  } finally {
    await app.close();
  }
});

// --- upload limits ---------------------------------------------------------------------
// The three presigned PUTs are the only bucket write anyone outside the backend holds, so
// these cover what one of them may write (the signed content-length) and how many of them a
// single account may accumulate (the quota).

const MB = 1024 * 1024;
const GB = 1024 * MB;

test('each upload URL is signed for exactly the size that was declared', async () => {
  const app = await clipApp();
  try {
    await makeUser(app, '400', 'signed', 'tok-signed');
    /** @type {Array<[string, number | undefined]>} */
    const signed = [];
    const realPresign = app.storage.presignPut;
    app.storage.presignPut = (key, contentType, expires, contentLength) => {
      signed.push([key.split('/').pop(), contentLength]);
      return realPresign(key, contentType, expires, contentLength);
    };

    const res = await app.inject({
      method: 'POST',
      url: '/clips',
      headers: auth('tok-signed'),
      payload: { ...validBody, sizeAv1: 4242, sizeH264: 8484, sizeThumb: 777 },
    });
    assert.equal(res.statusCode, 201, res.body);
    assert.deepEqual(signed, [
      ['av1.mp4', 4242],
      ['h264.mp4', 8484],
      ['thumb.jpg', 777],
    ]);
  } finally {
    await app.close();
  }
});

test('a size of zero, a missing size or a wrong type is a 400', async () => {
  const app = await clipApp();
  try {
    await makeUser(app, '401', 'sizes', 'tok-sizes');
    for (const payload of [
      { ...validBody, sizeAv1: 0 },
      { ...validBody, sizeH264: -1 },
      (({ sizeThumb, ...rest }) => rest)(validBody),
      { ...validBody, sizeThumb: '100' },
    ]) {
      const res = await app.inject({
        method: 'POST',
        url: '/clips',
        headers: auth('tok-sizes'),
        payload,
      });
      assert.equal(res.statusCode, 400, JSON.stringify(payload));
      assert.equal(res.json().error, 'bad_request');
    }
  } finally {
    await app.close();
  }
});

test('a file over its cap is refused before anything is signed', async () => {
  const app = await clipApp({ MAX_CLIP_MB: '10' });
  try {
    await makeUser(app, '402', 'big', 'tok-big');
    const before = await app.db.select().from(clips);

    for (const [payload, file] of [
      [{ ...validBody, sizeAv1: 11 * MB }, 'av1'],
      [{ ...validBody, sizeH264: 11 * MB }, 'h264'],
      [{ ...validBody, sizeThumb: 3 * MB }, 'thumb'],
    ]) {
      const res = await app.inject({
        method: 'POST',
        url: '/clips',
        headers: auth('tok-big'),
        payload,
      });
      assert.equal(res.statusCode, 413, res.body);
      assert.equal(res.json().error, 'clip_too_large');
      assert.equal(res.json().file, file);
    }

    // A rejected create leaves no row behind, so it costs nothing and reserves nothing.
    assert.equal((await app.db.select().from(clips)).length, before.length);

    const ok = await app.inject({
      method: 'POST',
      url: '/clips',
      headers: auth('tok-big'),
      payload: { ...validBody, sizeAv1: 10 * MB, sizeH264: 10 * MB, sizeThumb: 2 * MB },
    });
    assert.equal(ok.statusCode, 201, ok.body);
  } finally {
    await app.close();
  }
});

test('the per-user quota counts stored and in-flight clips, and only its own user', async () => {
  const app = await clipApp({ USER_QUOTA_GB: '1' });
  try {
    const alice = await makeUser(app, '403', 'alice', 'tok-q-alice');
    await makeUser(app, '404', 'bob', 'tok-q-bob');

    // 600 MB already stored.
    await insertReadyClip(app, alice, {
      sizeAv1: 500 * MB,
      sizeH264: 100 * MB,
      recordedAt: new Date('2025-06-01T00:00:00Z'),
    });

    const create = (token, mb) =>
      app.inject({
        method: 'POST',
        url: '/clips',
        headers: auth(token),
        payload: { ...validBody, sizeAv1: mb * MB, sizeH264: 1, sizeThumb: 100 },
      });

    // 600 + 300 fits under 1 GiB and stays pending: still not uploaded, still reserved.
    const pending = await create('tok-q-alice', 300);
    assert.equal(pending.statusCode, 201, pending.body);

    const over = await create('tok-q-alice', 300);
    assert.equal(over.statusCode, 413, over.body);
    const body = over.json();
    assert.equal(body.error, 'quota_exceeded');
    assert.equal(body.quota, GB);
    assert.equal(body.used, 900 * MB + 1);

    // Bob's quota is his own.
    assert.equal((await create('tok-q-bob', 900)).statusCode, 201);

    // An expired upload URL cannot write any more, but what it wrote before expiring is still
    // in the bucket, so the pending row keeps counting past its TTL...
    const deleted = [];
    app.storage.deleteMany = async (keys) => deleted.push(...keys);
    const age = async (ms) =>
      app.db
        .update(clips)
        .set({ createdAt: new Date(Date.now() - ms) })
        .where(eq(clips.id, pending.json().id));
    await age(60 * 60 * 1000);
    assert.equal((await create('tok-q-alice', 300)).statusCode, 413, 'an hour-old pending still counts');
    assert.deepEqual(deleted, [], 'and is not reaped while a slow PUT could still be landing');

    // ...until the reaper has deleted its objects, and only then does it stop counting.
    await age(2 * 60 * 60 * 1000);
    assert.equal((await create('tok-q-alice', 300)).statusCode, 201);
    const pendingId = pending.json().id;
    assert.deepEqual(deleted, [
      `clips/${alice.id}/${pendingId}/av1.mp4`,
      `clips/${alice.id}/${pendingId}/h264.mp4`,
      `clips/${alice.id}/${pendingId}/thumb.jpg`,
    ]);
    const [reaped] = await app.db.select().from(clips).where(eq(clips.id, pendingId));
    assert.equal(reaped.status, 'deleted');

    // So does a deleted clip: its objects are gone from the bucket.
    await app.db.update(clips).set({ status: 'deleted' }).where(eq(clips.userId, alice.id));
    assert.equal((await create('tok-q-alice', 900)).statusCode, 201);
  } finally {
    await app.close();
  }
});

test('a replace that is never uploaded cannot shrink what the quota counts', async () => {
  const app = await clipApp({ USER_QUOTA_GB: '1' });
  try {
    const user = await makeUser(app, '406', 'hoarder', 'tok-hoarder');
    // 1000 MB really in the bucket, completed.
    const clip = await insertReadyClip(app, user, {
      sizeAv1: 500 * MB,
      sizeH264: 500 * MB,
      recordedAt: new Date('2025-06-01T00:00:00Z'),
    });

    // Declare a one-byte replacement, then never PUT and never complete.
    const res = await app.inject({
      method: 'POST',
      url: `/clips/${clip.id}/replace`,
      headers: auth('tok-hoarder'),
      payload: { durationMs: 1000, sizeAv1: 1, sizeH264: 1, sizeThumb: 1 },
    });
    assert.equal(res.statusCode, 200, res.body);
    const [row] = await app.db.select().from(clips).where(eq(clips.id, clip.id));
    assert.equal(row.sizeAv1, 500 * MB, 'the old objects are still there, so they still count');
    assert.equal(row.sizeH264, 500 * MB);

    // So the room it pretended to free is not there.
    const next = await app.inject({
      method: 'POST',
      url: '/clips',
      headers: auth('tok-hoarder'),
      payload: { ...validBody, sizeAv1: 900 * MB, sizeH264: 1, sizeThumb: 100 },
    });
    assert.equal(next.statusCode, 413, next.body);
    assert.equal(next.json().error, 'quota_exceeded');
  } finally {
    await app.close();
  }
});

test('an abandoned upload the bucket will not delete keeps counting', async () => {
  const app = await clipApp({ USER_QUOTA_GB: '1' });
  try {
    await makeUser(app, '407', 'unlucky', 'tok-unlucky');
    const create = (mb) =>
      app.inject({
        method: 'POST',
        url: '/clips',
        headers: auth('tok-unlucky'),
        payload: { ...validBody, sizeAv1: mb * MB, sizeH264: 1, sizeThumb: 100 },
      });
    const first = await create(900);
    assert.equal(first.statusCode, 201, first.body);
    await app.db
      .update(clips)
      .set({ createdAt: new Date(Date.now() - 3 * 60 * 60 * 1000) })
      .where(eq(clips.id, first.json().id));

    // The objects cannot be confirmed gone, so the row must not stop counting.
    app.storage.deleteMany = async () => {
      throw new Error('bucket unavailable');
    };
    assert.equal((await create(900)).statusCode, 413);
    const [row] = await app.db.select().from(clips).where(eq(clips.id, first.json().id));
    assert.equal(row.status, 'pending');
  } finally {
    await app.close();
  }
});

test('USER_QUOTA_GB=0 disables the quota', async () => {
  const app = await clipApp({ USER_QUOTA_GB: '0' });
  try {
    const user = await makeUser(app, '405', 'unlimited', 'tok-unlimited');
    for (let i = 0; i < 3; i++) {
      await insertReadyClip(app, user, {
        sizeAv1: 900 * MB,
        sizeH264: 900 * MB,
        recordedAt: new Date('2025-06-01T00:00:00Z'),
      });
    }
    const res = await app.inject({
      method: 'POST',
      url: '/clips',
      headers: auth('tok-unlimited'),
      payload: validBody,
    });
    assert.equal(res.statusCode, 201, res.body);
  } finally {
    await app.close();
  }
});

test('complete deletes an object that came back oversized', async () => {
  const app = await clipApp({ MAX_CLIP_MB: '10' });
  try {
    const user = await makeUser(app, '406', 'liar', 'tok-liar');
    const created = await app.inject({
      method: 'POST',
      url: '/clips',
      headers: auth('tok-liar'),
      payload: validBody,
    });
    assert.equal(created.statusCode, 201, created.body);
    const { id } = created.json();

    // What the bucket would report if it had ignored the signed content-length.
    const keys = [`clips/${user.id}/${id}/av1.mp4`, `clips/${user.id}/${id}/h264.mp4`];
    app.storage.head = async (key) => ({
      size: keys.includes(key) ? 50 * MB : 1000,
      contentType: 'video/mp4',
    });
    const deleted = [];
    app.storage.deleteMany = async (k) => deleted.push(...k);

    const res = await app.inject({
      method: 'POST',
      url: `/clips/${id}/complete`,
      headers: auth('tok-liar'),
    });
    assert.equal(res.statusCode, 413, res.body);
    assert.deepEqual(res.json(), { error: 'clip_too_large', files: ['av1', 'h264'] });
    assert.equal(deleted.length, 3);

    const [row] = await app.db.select().from(clips).where(eq(clips.id, id));
    assert.equal(row.status, 'deleted');
    assert.equal((await app.inject({ method: 'GET', url: `/clips/${id}` })).statusCode, 404);
  } finally {
    await app.close();
  }
});
