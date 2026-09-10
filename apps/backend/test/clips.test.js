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
    assert.equal(expiresIn, 3600);
    for (const [name, file] of [['av1', 'av1.mp4'], ['h264', 'h264.mp4'], ['thumb', 'thumb.jpg']]) {
      const url = new URL(uploads[name]);
      assert.equal(url.origin, 'http://127.0.0.1:9');
      assert.equal(url.pathname, `/test-bucket/clips/${user.id}/${id}/${file}`);
      assert.equal(url.searchParams.get('X-Amz-Algorithm'), 'AWS4-HMAC-SHA256');
      assert.equal(url.searchParams.get('X-Amz-Expires'), '3600');
      assert.ok(url.searchParams.get('X-Amz-Signature'));
      // The SDK leaves content-type unsigned so the uploader sets it on the PUT itself.
      assert.equal(url.searchParams.get('X-Amz-SignedHeaders'), 'host');
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
