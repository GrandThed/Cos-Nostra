// POST /discord/voice-snapshot and the app.voiceSnapshot decorator behind it.
//
// The one property worth defending here is that nothing fails. The desktop asks this question
// with the record hotkey already pressed and a clip waiting to be created, so every way the
// bot can let us down - down, slow, wrong status, garbage body, not configured at all - has to
// come back as `{ participants: [] }` rather than an error the desktop has to handle.
//
// Building an app costs a PGlite instance and five migrations, so the cases that only differ
// in what the bot answers share one app and one stub whose reply is swapped between them; only
// the two that need a different BOT_INTERNAL_URL build their own.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import http from 'node:http';

import { testApp, testEnv } from './helpers.js';
import { devices, users } from '../src/db/schema.js';

const sha256 = (s) => createHash('sha256').update(s).digest('hex');
const authHeader = (token) => ({ authorization: `Bearer ${token}` });

const DISCORD_ID = '900000000000000001';
const TOKEN = 'tok-voice';

async function makeDevice(app, discordId = DISCORD_ID, token = TOKEN) {
  const [user] = await app.db
    .insert(users)
    .values({ discordId, username: 'ben', avatar: null })
    .returning();
  await app.db.insert(devices).values({ userId: user.id, name: 'pc', tokenHash: sha256(token) });
  return user;
}

/** Stand-in for the bot's internal HTTP server. `answer` is swapped per test. */
async function stubBot() {
  const received = [];
  let answer = () => ({ body: '{}' });
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      received.push({ url: req.url, auth: req.headers.authorization, body });
      const { status = 200, body: out = '{}' } = answer(req, body) ?? {};
      res.writeHead(status, { 'content-type': 'application/json' }).end(out);
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    received,
    answers: (fn) => {
      answer = fn;
      received.length = 0;
    },
    close: () => new Promise((r) => server.close(r)),
  };
}

/** @type {{ app: import('fastify').FastifyInstance, bot: Awaited<ReturnType<typeof stubBot>> }} */
const ctx = {};

before(async () => {
  ctx.bot = await stubBot();
  ctx.app = await testApp({ BOT_INTERNAL_URL: ctx.bot.url });
  await makeDevice(ctx.app);
});

after(async () => {
  await ctx.app?.close();
  await ctx.bot?.close();
});

const replies = (participants) => () => ({ body: JSON.stringify({ participants }) });

test('voiceSnapshot asks the bot with the shared secret and returns the ids', async () => {
  ctx.bot.answers(replies(['1', '2']));
  assert.deepEqual(await ctx.app.voiceSnapshot(DISCORD_ID), { participants: ['1', '2'] });
  assert.equal(ctx.bot.received.length, 1);
  assert.equal(ctx.bot.received[0].url, '/voice-snapshot');
  assert.equal(ctx.bot.received[0].auth, `Bearer ${testEnv.BOT_SHARED_SECRET}`);
  assert.deepEqual(JSON.parse(ctx.bot.received[0].body), { discordId: DISCORD_ID });
});

test('voiceSnapshot is empty on every failure and never rejects', async () => {
  // Each case is one way the lookup can go wrong; all of them mean "tag nobody".
  const cases = [
    ['non-2xx', () => ({ status: 500 })],
    ['a body that is not JSON', () => ({ body: 'not json at all' })],
    ['participants missing', () => ({ body: '{}' })],
    ['participants not an array', () => ({ body: '{"participants":"everyone"}' })],
    ['participants null', () => ({ body: '{"participants":null}' })],
  ];
  for (const [name, answer] of cases) {
    ctx.bot.answers(answer);
    const got = await ctx.app.voiceSnapshot(DISCORD_ID);
    assert.deepEqual(got, { participants: [] }, `expected no participants for ${name}`);
  }
});

test('POST /discord/voice-snapshot needs a device token', async () => {
  ctx.bot.answers(replies(['1']));
  for (const headers of [undefined, authHeader('not-a-real-token'), { authorization: 'nonsense' }]) {
    const res = await ctx.app.inject({ method: 'POST', url: '/discord/voice-snapshot', headers });
    assert.equal(res.statusCode, 401);
  }
  assert.equal(ctx.bot.received.length, 0, 'an unauthenticated call must not reach the bot');
});

test('POST /discord/voice-snapshot asks about the caller and returns the answer verbatim', async () => {
  ctx.bot.answers(replies(['7', '8']));
  const res = await ctx.app.inject({
    method: 'POST',
    url: '/discord/voice-snapshot',
    headers: authHeader(TOKEN),
  });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.json(), { participants: ['7', '8'] });
  // The caller never names a user: it is always the token's own owner.
  assert.deepEqual(JSON.parse(ctx.bot.received[0].body), { discordId: DISCORD_ID });
});

test('a bot that cannot be reached at all is still a 200 with no participants', async () => {
  // Port 1 refuses, so fetch itself rejects: this is the catch path, not a bad status.
  const app = await testApp({ BOT_INTERNAL_URL: 'http://127.0.0.1:1' });
  try {
    await makeDevice(app);
    await assert.doesNotReject(app.voiceSnapshot(DISCORD_ID));
    assert.deepEqual(await app.voiceSnapshot(DISCORD_ID), { participants: [] });

    const res = await app.inject({
      method: 'POST',
      url: '/discord/voice-snapshot',
      headers: authHeader(TOKEN),
    });
    assert.equal(res.statusCode, 200, 'a clip must never fail over a voice lookup');
    assert.deepEqual(res.json(), { participants: [] });
  } finally {
    await app.close();
  }
});

test('without BOT_INTERNAL_URL there is nobody to ask, and that is not an error', async () => {
  const app = await testApp();
  try {
    await makeDevice(app);
    assert.deepEqual(await app.voiceSnapshot(DISCORD_ID), { participants: [] });
    const res = await app.inject({
      method: 'POST',
      url: '/discord/voice-snapshot',
      headers: authHeader(TOKEN),
    });
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.json(), { participants: [] });
  } finally {
    await app.close();
  }
});
