// Exercises the internal HTTP server with a fake poster. The property the backend depends on
// (see apps/backend/src/plugins/bot.js) is that POST /post answers 202 before the poster runs,
// and that a poster which rejects neither delays the response nor takes the process down.
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { createServer } from '../src/server.js';

const SECRET = 'x'.repeat(24);

/** @type {ReturnType<typeof createServer> | null} */
let server = null;
/** @type {ReturnType<typeof fakePoster>} */
let poster;
/** @type {string[]} */
let logged;

/**
 * Records what the poster was asked to do and lets a test await the background call.
 * @param {(clipId: string) => unknown} [settle]
 */
function fakePoster(settle = async () => {}) {
  /** @type {string[]} */
  const calls = [];
  /** @type {() => void} */
  let resolveDone = () => {};
  const done = new Promise((r) => (resolveDone = r));
  return {
    calls,
    done,
    /** @param {string} clipId */
    postClip(clipId) {
      calls.push(clipId);
      try {
        return settle(clipId);
      } finally {
        // Let the assertion run after postClip returned, however it returned.
        setImmediate(resolveDone);
      }
    },
  };
}

const log = {
  info: (...a) => logged.push(`info ${a.join(' ')}`),
  warn: (...a) => logged.push(`warn ${a.join(' ')}`),
  error: (...a) => logged.push(`error ${a.join(' ')}`),
  debug: (...a) => logged.push(`debug ${a.join(' ')}`),
};

/**
 * A fake discord.js client whose guilds and voice states are the same Map-shaped caches
 * discord.js hands out: `.get(id)` and `.values()` are all the route uses.
 * @param {Array<Record<string, string | null>>} guilds  one object per guild, user id to channel id
 */
function fakeClient(guilds) {
  const built = guilds.map((states) => ({
    voiceStates: {
      cache: new Map(
        Object.entries(states).map(([id, channelId]) => [id, { id, channelId }]),
      ),
    },
  }));
  return { guilds: { cache: new Map(built.map((guild, i) => [`g${i}`, guild])) } };
}

/** @param {{ poster?: ReturnType<typeof fakePoster>, client?: any }} [opts] */
async function start(opts = {}) {
  // BOT_PORT 0 keeps parallel test runs from colliding.
  poster = opts.poster ?? fakePoster();
  server = createServer({
    config: { BOT_SHARED_SECRET: SECRET, BOT_PORT: 0 },
    poster,
    log,
    client: opts.client,
  });
  await server.listen();
  return `http://127.0.0.1:${server.port}`;
}

/** @param {string} base @param {unknown} body @param {string} [authorization] */
function snapshot(base, body, authorization = `Bearer ${SECRET}`) {
  return fetch(`${base}/voice-snapshot`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(authorization ? { authorization } : {}),
    },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

beforeEach(() => {
  logged = [];
});

afterEach(async () => {
  await server?.close();
  server = null;
});

test('GET /health answers 200 with ok', async () => {
  const base = await start();
  const res = await fetch(`${base}/health`);
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true });
});

test('listen() binds an ephemeral port and port reports it', async () => {
  await start();
  assert.ok(server.port > 0);
});

test('POST /post answers 202 and posts the clip in the background', async () => {
  const base = await start();
  const res = await fetch(`${base}/post`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${SECRET}` },
    body: JSON.stringify({ clipId: 'clip-1' }),
  });
  assert.equal(res.status, 202);
  assert.deepEqual(await res.json(), { ok: true, clipId: 'clip-1' });
  await poster.done;
  assert.deepEqual(poster.calls, ['clip-1']);
});

test('the response does not wait for the poster', async () => {
  /** @type {() => void} */
  let release = () => {};
  const slow = fakePoster(() => new Promise((r) => (release = r)));
  const base = await start({ poster: slow });
  const res = await fetch(`${base}/post`, {
    method: 'POST',
    headers: { authorization: `Bearer ${SECRET}` },
    body: JSON.stringify({ clipId: 'slow' }),
  });
  assert.equal(res.status, 202);
  await res.text();
  assert.deepEqual(slow.calls, ['slow']);
  release();
});

test('a poster that rejects still returns 202 and is only logged', async () => {
  const failing = fakePoster(async () => {
    throw new Error('discord is down');
  });
  const base = await start({ poster: failing });
  const res = await fetch(`${base}/post`, {
    method: 'POST',
    headers: { authorization: `Bearer ${SECRET}` },
    body: JSON.stringify({ clipId: 'boom' }),
  });
  assert.equal(res.status, 202);
  await failing.done;
  // The rejection is handled in a microtask; give the catch a turn before asserting.
  await new Promise((r) => setImmediate(r));
  assert.ok(
    logged.some((line) => line.startsWith('error') && line.includes('discord is down')),
    `expected the failure to be logged, got ${JSON.stringify(logged)}`,
  );
  // The server is still up.
  assert.equal((await fetch(`${base}/health`)).status, 200);
});

test('a poster that throws synchronously does not crash the request', async () => {
  const throwing = fakePoster(() => {
    throw new Error('sync boom');
  });
  const base = await start({ poster: throwing });
  const res = await fetch(`${base}/post`, {
    method: 'POST',
    headers: { authorization: `Bearer ${SECRET}` },
    body: JSON.stringify({ clipId: 'sync' }),
  });
  assert.equal(res.status, 202);
  await throwing.done;
  await new Promise((r) => setImmediate(r));
  assert.ok(logged.some((line) => line.includes('sync boom')));
  assert.equal((await fetch(`${base}/health`)).status, 200);
});

test('a wrong secret answers 401 and never reaches the poster', async () => {
  const base = await start();
  const wrongSameLength = `Bearer ${'y'.repeat(SECRET.length)}`;
  for (const authorization of [wrongSameLength, 'Bearer short', SECRET, '']) {
    const res = await fetch(`${base}/post`, {
      method: 'POST',
      headers: authorization ? { authorization } : {},
      body: JSON.stringify({ clipId: 'nope' }),
    });
    assert.equal(res.status, 401, `expected 401 for ${JSON.stringify(authorization)}`);
    assert.deepEqual(await res.json(), { error: 'unauthorized' });
  }
  assert.deepEqual(poster.calls, []);
});

test('an unknown path answers 404', async () => {
  const base = await start();
  for (const path of ['/', '/nope', '/post/extra', '/internal/post']) {
    const res = await fetch(`${base}${path}`);
    assert.equal(res.status, 404, `expected 404 for ${path}`);
    assert.deepEqual(await res.json(), { error: 'not_found' });
  }
});

test('a wrong method on a known path answers 404', async () => {
  const base = await start();
  assert.equal((await fetch(`${base}/post`)).status, 404);
  assert.equal((await fetch(`${base}/health`, { method: 'POST' })).status, 404);
});

test('a query string on /health still routes', async () => {
  const base = await start();
  assert.equal((await fetch(`${base}/health?from=railway`)).status, 200);
});

test('malformed JSON answers 400', async () => {
  const base = await start();
  const res = await fetch(`${base}/post`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${SECRET}` },
    body: '{not json',
  });
  assert.equal(res.status, 400);
  assert.deepEqual(await res.json(), { error: 'bad_json' });
  assert.deepEqual(poster.calls, []);
});

test('a body without a usable clipId answers 400', async () => {
  const base = await start();
  for (const body of ['{}', '{"clipId":""}', '{"clipId":42}', 'null', '[]']) {
    const res = await fetch(`${base}/post`, {
      method: 'POST',
      headers: { authorization: `Bearer ${SECRET}` },
      body,
    });
    assert.equal(res.status, 400, `expected 400 for ${body}`);
    assert.equal((await res.json()).error, 'bad_request');
  }
  assert.deepEqual(poster.calls, []);
});

// ---- POST /voice-snapshot ----------------------------------------------------------------

test('/voice-snapshot answers with everyone else in the caller voice channel', async () => {
  // Two guilds, and the user is only in voice in the second one: the route has to look past
  // a guild that knows the user but has them nowhere.
  const client = fakeClient([
    { '1': 'chan-a', '2': 'chan-a' },
    { '4242': 'chan-b', '99': 'chan-b', '100': 'chan-b', '7': 'other-chan' },
  ]);
  const base = await start({ client });

  const res = await snapshot(base, { discordId: '4242' });

  assert.equal(res.status, 200);
  const { participants } = await res.json();
  // The caller is never in their own participant list, and neither is someone in another
  // channel of the same guild.
  assert.deepEqual([...participants].sort(), ['100', '99']);
});

test('/voice-snapshot answers an empty list when the user is in no voice channel', async () => {
  const client = fakeClient([{ '1': 'chan-a' }, { '4242': null, '99': 'chan-b' }]);
  const base = await start({ client });

  for (const discordId of ['4242', 'nobody']) {
    const res = await snapshot(base, { discordId });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { participants: [] }, `for ${discordId}`);
  }
});

test('/voice-snapshot is empty rather than broken without a client or a cache', async () => {
  // index.js always passes one, but a route that answers 500 here would fail an upload.
  const base = await start({ client: undefined });
  const res = await snapshot(base, { discordId: '4242' });
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { participants: [] });
});

test('/voice-snapshot alone in the channel is an empty list, not the caller', async () => {
  const base = await start({ client: fakeClient([{ '4242': 'chan-a' }]) });
  const res = await snapshot(base, { discordId: '4242' });
  assert.deepEqual(await res.json(), { participants: [] });
});

test('/voice-snapshot needs the shared secret', async () => {
  const base = await start({ client: fakeClient([{ '4242': 'chan-a', '99': 'chan-a' }]) });
  for (const authorization of [`Bearer ${'y'.repeat(SECRET.length)}`, 'Bearer short', SECRET, '']) {
    const res = await snapshot(base, { discordId: '4242' }, authorization);
    assert.equal(res.status, 401, `expected 401 for ${JSON.stringify(authorization)}`);
    assert.deepEqual(await res.json(), { error: 'unauthorized' });
  }
});

test('/voice-snapshot rejects a body without a usable discordId', async () => {
  const base = await start({ client: fakeClient([{ '4242': 'chan-a', '99': 'chan-a' }]) });
  for (const body of ['{}', '{"discordId":""}', '{"discordId":42}', 'null', '[]']) {
    const res = await snapshot(base, body);
    assert.equal(res.status, 400, `expected 400 for ${body}`);
    assert.equal((await res.json()).error, 'bad_request');
  }
  const bad = await snapshot(base, '{not json');
  assert.equal(bad.status, 400);
  assert.deepEqual(await bad.json(), { error: 'bad_json' });
});

test('a GET on /voice-snapshot is a 404 like any other unknown route', async () => {
  const base = await start({ client: fakeClient([]) });
  assert.equal((await fetch(`${base}/voice-snapshot`)).status, 404);
});

test('close() is safe to call twice', async () => {
  await start();
  await server.close();
  await server.close();
  server = null;
});
