import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { setTimeout as sleep } from 'node:timers/promises';

import { testApp, testEnv } from './helpers.js';
import { clips, posts, reactions, users } from '../src/db/schema.js';
import { setRetryDelays } from '../src/plugins/bot.js';

const auth = { authorization: `Bearer ${testEnv.BOT_SHARED_SECRET}` };
const CLIP = 'abcdefghijkl';
const postBody = { clipId: CLIP, guildId: 'g1', channelId: 'c1', messageId: 'm1' };

async function seed(app, { status = 'ready' } = {}) {
  const [user] = await app.db
    .insert(users)
    .values({ discordId: '111', username: 'ben' })
    .returning({ id: users.id });
  await app.db.insert(clips).values({
    id: CLIP,
    userId: user.id,
    game: 'Doom',
    title: 'nice',
    durationMs: 30_000,
    sizeH264: 12345,
    keyAv1: 'k/av1.mp4',
    keyH264: 'k/h264.mp4',
    keyThumb: 'k/thumb.jpg',
    recordedAt: new Date('2026-01-02T03:04:05Z'),
    status,
  });
}

test('/internal rejects missing or wrong secret', async () => {
  const app = await testApp();
  try {
    let res = await app.inject({ method: 'POST', url: '/internal/posts', payload: postBody });
    assert.equal(res.statusCode, 401);
    res = await app.inject({
      method: 'POST',
      url: '/internal/posts',
      headers: { authorization: 'Bearer wrong-secret-0123456789' },
      payload: postBody,
    });
    assert.equal(res.statusCode, 401);
    res = await app.inject({ method: 'GET', url: '/internal/posts/m1' });
    assert.equal(res.statusCode, 401);
  } finally {
    await app.close();
  }
});

test('posts upsert on messageId, 404 for unknown clip, 400 for bad body', async () => {
  const app = await testApp();
  try {
    await seed(app);
    let res = await app.inject({ method: 'POST', url: '/internal/posts', headers: auth, payload: postBody });
    assert.equal(res.statusCode, 201);
    const { id } = res.json();
    res = await app.inject({
      method: 'POST',
      url: '/internal/posts',
      headers: auth,
      payload: { ...postBody, channelId: 'c2' },
    });
    assert.equal(res.statusCode, 201);
    assert.equal(res.json().id, id);
    const rows = await app.db.select().from(posts);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].channelId, 'c2');

    res = await app.inject({
      method: 'POST',
      url: '/internal/posts',
      headers: auth,
      payload: { ...postBody, clipId: 'nope' },
    });
    assert.equal(res.statusCode, 404);

    res = await app.inject({ method: 'POST', url: '/internal/posts', headers: auth, payload: { clipId: 'x' } });
    assert.equal(res.statusCode, 400);
    assert.equal(res.json().error, 'bad_request');
  } finally {
    await app.close();
  }
});

test('reactions: add is idempotent, remove closes, re-add opens a new row', async () => {
  const app = await testApp();
  try {
    await seed(app);
    await app.inject({ method: 'POST', url: '/internal/posts', headers: auth, payload: postBody });
    const react = (action, extra = {}) =>
      app.inject({
        method: 'POST',
        url: '/internal/reactions',
        headers: auth,
        payload: { messageId: 'm1', userDiscordId: 'u1', emoji: '🔥', action, ...extra },
      });

    let res = await react('add');
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.json(), { ok: true, open: 1 });
    res = await react('add');
    assert.deepEqual(res.json(), { ok: true, open: 1 });
    res = await react('add', { userDiscordId: 'u2' });
    assert.deepEqual(res.json(), { ok: true, open: 2 });
    res = await react('remove');
    assert.deepEqual(res.json(), { ok: true, open: 1 });
    res = await react('remove');
    assert.deepEqual(res.json(), { ok: true, open: 1 });
    res = await react('add');
    assert.deepEqual(res.json(), { ok: true, open: 2 });

    const rows = await app.db.select().from(reactions);
    const u1 = rows.filter((r) => r.userDiscordId === 'u1');
    assert.equal(rows.length, 3);
    assert.equal(u1.length, 2);
    assert.equal(u1.filter((r) => r.removedAt === null).length, 1);

    res = await react('add', { messageId: 'unknown' });
    assert.equal(res.statusCode, 404);
    assert.deepEqual(res.json(), { error: 'unknown_message' });
  } finally {
    await app.close();
  }
});

test('GET /internal/posts/:messageId', async () => {
  const app = await testApp();
  try {
    await seed(app);
    await app.inject({ method: 'POST', url: '/internal/posts', headers: auth, payload: postBody });
    await app.inject({
      method: 'POST',
      url: '/internal/reactions',
      headers: auth,
      payload: { messageId: 'm1', userDiscordId: 'u1', emoji: '👍', action: 'add' },
    });
    let res = await app.inject({ method: 'GET', url: '/internal/posts/m1', headers: auth });
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.json(), { ...postBody, open: 1 });
    res = await app.inject({ method: 'GET', url: '/internal/posts/m9', headers: auth });
    assert.equal(res.statusCode, 404);
  } finally {
    await app.close();
  }
});

test('GET /internal/clips/:id for the bot', async () => {
  const app = await testApp();
  try {
    await seed(app);
    const res = await app.inject({ method: 'GET', url: `/internal/clips/${CLIP}`, headers: auth });
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.json(), {
      id: CLIP,
      game: 'Doom',
      title: 'nice',
      durationMs: 30_000,
      sizeH264: 12345,
      recordedAt: '2026-01-02T03:04:05.000Z',
      owner: { discordId: '111', username: 'ben' },
      urls: {
        h264: `http://localhost:3000/clips/${CLIP}/h264`,
        thumb: `http://localhost:3000/clips/${CLIP}/thumb`,
        page: `http://localhost:3000/c/${CLIP}`,
      },
    });
    const missing = await app.inject({ method: 'GET', url: '/internal/clips/zzz', headers: auth });
    assert.equal(missing.statusCode, 404);
  } finally {
    await app.close();
  }
});

test('GET /internal/clips/:id is 404 while pending', async () => {
  const app = await testApp();
  try {
    await seed(app, { status: 'pending' });
    const res = await app.inject({ method: 'GET', url: `/internal/clips/${CLIP}`, headers: auth });
    assert.equal(res.statusCode, 404);
  } finally {
    await app.close();
  }
});

/** Stub bot server; `status` is the HTTP status it answers with. */
function stubBot(status = 200) {
  const received = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      received.push({ url: req.url, auth: req.headers.authorization, body });
      res.writeHead(status, { 'content-type': 'application/json' }).end('{}');
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const url = `http://127.0.0.1:${server.address().port}`;
      resolve({ url, received, close: () => new Promise((r) => server.close(r)) });
    });
  });
}

test('notifyBot posts the clip id with the shared secret', async () => {
  const bot = await stubBot(200);
  const app = await testApp({ BOT_INTERNAL_URL: bot.url });
  try {
    await app.notifyBot('abc');
    for (let i = 0; i < 50 && bot.received.length === 0; i++) await sleep(20);
    assert.equal(bot.received.length, 1);
    assert.equal(bot.received[0].url, '/post');
    assert.equal(bot.received[0].auth, auth.authorization);
    assert.deepEqual(JSON.parse(bot.received[0].body), { clipId: 'abc' });
  } finally {
    await app.close();
    await bot.close();
  }
});

test('notifyBot retries when the bot fails and never throws', async () => {
  setRetryDelays([20, 20, 20]);
  const bot = await stubBot(500);
  const app = await testApp({ BOT_INTERNAL_URL: bot.url });
  try {
    await assert.doesNotReject(app.notifyBot('abc'));
    for (let i = 0; i < 100 && bot.received.length < 4; i++) await sleep(20);
    assert.ok(bot.received.length >= 2, `expected retries, got ${bot.received.length}`);
    assert.equal(bot.received.length, 4);
  } finally {
    setRetryDelays(null);
    await app.close();
    await bot.close();
  }
});

test('notifyBot is a no-op without BOT_INTERNAL_URL', async () => {
  const app = await testApp();
  try {
    await assert.doesNotReject(app.notifyBot('abc'));
  } finally {
    await app.close();
  }
});
