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
  /** @type {Array<string[] | undefined>} the guildIds each call was given */
  const targets = [];
  /** @type {() => void} */
  let resolveDone = () => {};
  const done = new Promise((r) => (resolveDone = r));
  return {
    calls,
    targets,
    done,
    /** @param {string} clipId @param {string[]} [guildIds] */
    postClip(clipId, guildIds) {
      calls.push(clipId);
      targets.push(guildIds);
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

/**
 * @param {{ poster?: ReturnType<typeof fakePoster>, client?: any, memberGuildsTimeoutMs?: number }} [opts]
 */
async function start(opts = {}) {
  // BOT_PORT 0 keeps parallel test runs from colliding.
  poster = opts.poster ?? fakePoster();
  server = createServer({
    config: { BOT_SHARED_SECRET: SECRET, BOT_PORT: 0 },
    poster,
    log,
    client: opts.client,
    ...(opts.memberGuildsTimeoutMs ? { memberGuildsTimeoutMs: opts.memberGuildsTimeoutMs } : {}),
  });
  await server.listen();
  return `http://127.0.0.1:${server.port}`;
}

/**
 * POSTs JSON (or a raw string) to one of the server's routes with the shared secret.
 * @param {string} base @param {string} path @param {unknown} body @param {string} [authorization]
 */
function postTo(base, path, body, authorization = `Bearer ${SECRET}`) {
  return fetch(`${base}${path}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(authorization ? { authorization } : {}),
    },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

/** @param {string} base @param {unknown} body @param {string} [authorization] */
function snapshot(base, body, authorization = `Bearer ${SECRET}`) {
  return postTo(base, '/voice-snapshot', body, authorization);
}

/**
 * Resolves once `check()` is true, polling on the event loop. For work the server does after
 * it has already answered.
 * @param {() => boolean} check @param {string} label
 */
async function eventually(check, label, ms = 2_000) {
  const until = Date.now() + ms;
  while (!check()) {
    if (Date.now() > until) throw new Error(`timed out waiting for ${label}`);
    await new Promise((r) => setTimeout(r, 5));
  }
}

/** A Discord error shaped the way discord.js throws one. */
function discordError(message, code) {
  return Object.assign(new Error(message), { code });
}

/**
 * A client for /member-guilds: each guild's members.fetch answers from `members`, throws
 * Unknown Member for anyone else, throws `error`, or never settles when `hang` is set.
 * @param {Record<string, { members?: string[], error?: Error, hang?: boolean }>} guilds
 */
function memberClient(guilds) {
  /** @type {Array<[string, any]>} */
  const fetches = [];
  const cache = new Map(
    Object.entries(guilds).map(([guildId, { members = [], error, hang }]) => [
      guildId,
      {
        id: guildId,
        members: {
          fetch(options) {
            fetches.push([guildId, options]);
            if (hang) return new Promise(() => {});
            if (error) return Promise.reject(error);
            if (members.includes(options?.user)) return Promise.resolve({ id: options.user });
            return Promise.reject(discordError('Unknown Member', 10007));
          },
        },
      },
    ]),
  );
  return { fetches, guilds: { cache } };
}

/**
 * A client for /unpost whose channels record deletes, and whose `gone` message ids answer
 * Unknown Message the way a message someone already deleted does.
 * @param {{ gone?: string[], missingChannels?: string[] }} [opts]
 */
function deletingClient({ gone = [], missingChannels = [] } = {}) {
  /** @type {string[]} */
  const attempted = [];
  /** @type {string[]} */
  const deleted = [];
  return {
    attempted,
    deleted,
    channels: {
      async fetch(channelId) {
        if (missingChannels.includes(channelId)) throw discordError('Unknown Channel', 10003);
        return {
          messages: {
            async delete(messageId) {
              attempted.push(`${channelId}/${messageId}`);
              if (gone.includes(messageId)) throw discordError('Unknown Message', 10008);
              deleted.push(`${channelId}/${messageId}`);
            },
          },
        };
      },
    },
  };
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

// ---- POST /post guildIds -----------------------------------------------------------------

test('POST /post hands guildIds to the poster, and absent or null as no override', async () => {
  const base = await start();
  const cases = [
    [{ clipId: 'a', guildIds: ['1', '2'] }, ['1', '2']],
    [{ clipId: 'b', guildIds: [] }, []],
    [{ clipId: 'c' }, undefined],
    [{ clipId: 'd', guildIds: null }, undefined],
  ];
  for (const [body, expected] of cases) {
    const res = await postTo(base, '/post', body);
    assert.equal(res.status, 202, `for ${JSON.stringify(body)}`);
    await res.text();
  }
  await eventually(() => poster.targets.length === cases.length, 'every post to reach the poster');
  assert.deepEqual(poster.calls, ['a', 'b', 'c', 'd']);
  assert.deepEqual(
    poster.targets,
    cases.map(([, expected]) => expected),
  );
});

test('POST /post rejects guildIds that are not a list of ids', async () => {
  const base = await start();
  for (const guildIds of ['1', 1, {}, [1], [''], ['1', null], true]) {
    const res = await postTo(base, '/post', { clipId: 'x', guildIds });
    assert.equal(res.status, 400, `expected 400 for ${JSON.stringify(guildIds)}`);
    assert.equal((await res.json()).error, 'bad_request');
  }
  assert.deepEqual(poster.calls, []);
});

// ---- POST /member-guilds -----------------------------------------------------------------

test('/member-guilds keeps only the guilds the bot is in and the user is a member of', async () => {
  const client = memberClient({
    member: { members: ['4242'] },
    stranger: { members: ['99'] },
    broken: { error: discordError('Service Unavailable', 0) },
    alsoMember: { members: ['4242'] },
  });
  const base = await start({ client });

  const res = await postTo(base, '/member-guilds', {
    discordId: '4242',
    guildIds: ['alsoMember', 'notInCache', 'broken', 'member', 'stranger', 'member'],
  });

  assert.equal(res.status, 200);
  // In the order asked, deduped. A guild missing from the cache is never fetched at all.
  assert.deepEqual(await res.json(), { guildIds: ['alsoMember', 'member'] });
  assert.deepEqual(
    client.fetches.map(([guildId]) => guildId).sort(),
    ['alsoMember', 'broken', 'member', 'stranger'],
  );
  for (const [, options] of client.fetches) {
    assert.deepEqual(options, { user: '4242', force: true, cache: false });
  }
  // Unknown Member is an answer; any other error is a warning.
  const warnings = logged.filter((line) => line.startsWith('warn'));
  assert.equal(warnings.length, 1, JSON.stringify(warnings));
  assert.match(warnings[0], /broken.*Service Unavailable/);
});

test('/member-guilds answers within its bound when Discord does not', async () => {
  const client = memberClient({ fast: { members: ['4242'] }, slow: { hang: true } });
  const base = await start({ client, memberGuildsTimeoutMs: 150 });

  const began = Date.now();
  const res = await postTo(base, '/member-guilds', { discordId: '4242', guildIds: ['slow', 'fast'] });
  const took = Date.now() - began;

  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { guildIds: ['fast'] });
  assert.ok(took >= 140 && took < 1_500, `answered after ${took} ms`);
  assert.ok(logged.some((line) => line.startsWith('warn') && line.includes('slow')));
});

test('/member-guilds is an empty list without a client, and fast when nothing is pending', async () => {
  const base = await start({ client: undefined, memberGuildsTimeoutMs: 5_000 });
  const began = Date.now();
  const res = await postTo(base, '/member-guilds', { discordId: '4242', guildIds: ['1'] });
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { guildIds: [] });
  assert.ok(Date.now() - began < 1_000, 'the timeout is a bound, not a wait');
});

test('/member-guilds needs the shared secret and a well-formed body', async () => {
  const base = await start({ client: memberClient({ g: { members: ['4242'] } }) });
  for (const authorization of [`Bearer ${'y'.repeat(SECRET.length)}`, SECRET, '']) {
    const res = await postTo(base, '/member-guilds', { discordId: '4242', guildIds: ['g'] }, authorization);
    assert.equal(res.status, 401);
    assert.deepEqual(await res.json(), { error: 'unauthorized' });
  }
  for (const body of [
    '{}',
    '{"discordId":"4242"}',
    '{"guildIds":["g"]}',
    '{"discordId":"","guildIds":["g"]}',
    '{"discordId":4242,"guildIds":["g"]}',
    '{"discordId":"4242","guildIds":"g"}',
    '{"discordId":"4242","guildIds":[7]}',
    'null',
    '[]',
  ]) {
    const res = await postTo(base, '/member-guilds', body);
    assert.equal(res.status, 400, `expected 400 for ${body}`);
    assert.equal((await res.json()).error, 'bad_request');
  }
  const bad = await postTo(base, '/member-guilds', '{not json');
  assert.deepEqual(await bad.json(), { error: 'bad_json' });
});

// ---- POST /unpost ------------------------------------------------------------------------

test('/unpost answers 202 and deletes every message, past one that is already gone', async () => {
  const client = deletingClient({ gone: ['m1'], missingChannels: ['c3'] });
  const base = await start({ client });

  const res = await postTo(base, '/unpost', {
    clipId: 'clip-1',
    posts: [
      { guildId: 'g1', channelId: 'c1', messageId: 'm1' },
      { guildId: 'g3', channelId: 'c3', messageId: 'm3' },
      { guildId: 'g2', channelId: 'c2', messageId: 'm2' },
    ],
  });

  assert.equal(res.status, 202);
  assert.deepEqual(await res.json(), { ok: true, clipId: 'clip-1' });
  await eventually(() => logged.some((line) => line.includes('took down')), 'the removal to finish');
  // A gone message and a gone channel are warnings, and neither stops the next delete.
  assert.deepEqual(client.attempted, ['c1/m1', 'c2/m2']);
  assert.deepEqual(client.deleted, ['c2/m2']);
  assert.ok(logged.some((line) => line.startsWith('warn') && line.includes('Unknown Message')));
  assert.ok(logged.some((line) => line.startsWith('warn') && line.includes('Unknown Channel')));
  assert.deepEqual(logged.filter((line) => line.startsWith('error')), []);
  assert.equal((await fetch(`${base}/health`)).status, 200);
});

test('/unpost does not wait for Discord before answering', async () => {
  /** @type {() => void} */
  let release = () => {};
  const client = {
    channels: {
      fetch: () => new Promise((r) => (release = () => r({ messages: { delete: async () => {} } }))),
    },
  };
  const base = await start({ client });
  const res = await postTo(base, '/unpost', {
    clipId: 'clip-1',
    posts: [{ guildId: 'g1', channelId: 'c1', messageId: 'm1' }],
  });
  assert.equal(res.status, 202);
  await res.text();
  release();
});

test('/unpost needs the shared secret and a well-formed body', async () => {
  const client = deletingClient();
  const base = await start({ client });
  const good = { clipId: 'clip-1', posts: [{ guildId: 'g1', channelId: 'c1', messageId: 'm1' }] };
  for (const authorization of [`Bearer ${'y'.repeat(SECRET.length)}`, SECRET, '']) {
    const res = await postTo(base, '/unpost', good, authorization);
    assert.equal(res.status, 401);
  }
  for (const body of [
    {},
    { clipId: 'clip-1' },
    { posts: good.posts },
    { clipId: '', posts: good.posts },
    { clipId: 'clip-1', posts: 'm1' },
    { clipId: 'clip-1', posts: [null] },
    { clipId: 'clip-1', posts: [{ guildId: 'g1', channelId: 'c1' }] },
    { clipId: 'clip-1', posts: [{ guildId: 'g1', channelId: '', messageId: 'm1' }] },
    { clipId: 'clip-1', posts: [{ guildId: 1, channelId: 'c1', messageId: 'm1' }] },
  ]) {
    const res = await postTo(base, '/unpost', body);
    assert.equal(res.status, 400, `expected 400 for ${JSON.stringify(body)}`);
    assert.equal((await res.json()).error, 'bad_request');
  }
  await new Promise((r) => setTimeout(r, 20));
  assert.deepEqual(client.attempted, [], 'a rejected request deletes nothing');

  // An empty list is valid: the clip simply had no live posts.
  const empty = await postTo(base, '/unpost', { clipId: 'clip-1', posts: [] });
  assert.equal(empty.status, 202);
});

test('close() is safe to call twice', async () => {
  await start();
  await server.close();
  await server.close();
  server = null;
});
