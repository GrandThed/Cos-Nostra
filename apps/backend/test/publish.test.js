// Publish on demand: which Discord guilds a clip goes to, posting it to more of them later,
// where it is live, and taking every message down again when it is unpublished or deleted.
//
// The property defended above all is backwards compatibility: a desktop build from before this
// change never sends guildIds, and its clips must post everywhere exactly as they always did.
//
// Building an app costs a PGlite instance and every migration, so almost everything shares one
// app and one stub bot whose answers are swapped per test. Each test makes its own users and
// clips, so nothing one test writes is visible to another's assertions. Only the case that
// needs BOT_INTERNAL_URL unset builds a second app.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import http from 'node:http';
import { setTimeout as sleep } from 'node:timers/promises';

import { eq } from 'drizzle-orm';

import { testApp, testEnv } from './helpers.js';
import { clips, devices, guildSettings, posts, users } from '../src/db/schema.js';
import { randomId } from '../src/lib/ids.js';
import { setRetryDelays } from '../src/plugins/bot.js';

const s3Env = {
  S3_ENDPOINT: 'http://127.0.0.1:9',
  S3_BUCKET: 'test-bucket',
  S3_ACCESS_KEY_ID: 'AKIATEST',
  S3_SECRET_ACCESS_KEY: 'secret-test',
  S3_URL_STYLE: 'path',
};

const sha256 = (s) => createHash('sha256').update(s).digest('hex');
const device = (token) => ({ authorization: `Bearer ${token}` });
const botAuth = { authorization: `Bearer ${testEnv.BOT_SHARED_SECRET}` };

// Three configured guilds, named so that ordering by name is visible: Beta has no icon and
// GAMMA has no name at all (a guild set up before the clip site existed), so it sorts last.
const ALPHA = '1001';
const BETA = '1002';
const GAMMA = '1003';
const UNCONFIGURED = '1999';
const GUILDS = [
  { guildId: ALPHA, channelId: '5001', name: 'Alpha', icon: 'alphaicon', slug: 'alpha' },
  { guildId: BETA, channelId: '5002', name: 'Beta', icon: null, slug: null },
  { guildId: GAMMA, channelId: '5003', name: null, icon: null, slug: 'gamma' },
];
const ALPHA_ICON = 'https://cdn.discordapp.com/icons/1001/alphaicon.png?size=96';

const validBody = {
  game: 'Valorant',
  title: 'ace',
  durationMs: 30000,
  recordedAt: '2026-09-01T12:00:00.000Z',
  sizeAv1: 1000,
  sizeH264: 2000,
  sizeThumb: 100,
};

/** Stand-in for the bot's internal HTTP server. Records every request; answers are swappable. */
async function stubBot() {
  const received = [];
  // By default the caller is a member of every guild asked about, and notifications are taken.
  const defaultAnswer = (req, body) =>
    req.url === '/member-guilds'
      ? { status: 200, body: JSON.stringify({ guildIds: body.guildIds }) }
      : { status: 202 };
  let answer = defaultAnswer;
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      const body = raw ? JSON.parse(raw) : null;
      received.push({ url: req.url, auth: req.headers.authorization, body });
      const out = answer(req, body) ?? {};
      if (out.destroy) return req.socket.destroy();
      res.writeHead(out.status ?? 200, { 'content-type': 'application/json' }).end(out.body ?? '{}');
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    /** Requests to one path, optionally only those about one clip. */
    to: (url, clipId) =>
      received.filter((r) => r.url === url && (clipId === undefined || r.body?.clipId === clipId)),
    answers: (fn) => {
      answer = fn ?? defaultAnswer;
    },
    close: () => new Promise((r) => server.close(r)),
  };
}

/** Polls until `fn` returns something truthy, or gives up and returns its last answer. */
async function waitFor(fn, ms = 2000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = fn();
    if (v) return v;
    await sleep(20);
  }
  return fn();
}

/** The stub's requests to `url` about `clipId`, once at least `count` of them have arrived. */
async function requestsTo(bot, url, clipId, count = 1) {
  await waitFor(() => bot.to(url, clipId).length >= count);
  return bot.to(url, clipId);
}

async function seedGuilds(app) {
  await app.db.insert(guildSettings).values(GUILDS);
}

async function makeUser(app, discordId, token) {
  const [user] = await app.db
    .insert(users)
    .values({ discordId, username: `user${discordId}`, avatar: null })
    .returning();
  await app.db.insert(devices).values({ userId: user.id, name: 'pc', tokenHash: sha256(token) });
  return user;
}

async function insertClip(app, user, fields = {}) {
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
      recordedAt: new Date('2026-09-01T00:00:00Z'),
      status: 'ready',
      uploadedAt: new Date(),
      ...fields,
    })
    .returning();
  return row;
}

async function insertPost(app, clipId, guildId, messageId, fields = {}) {
  const [row] = await app.db
    .insert(posts)
    .values({ clipId, guildId, channelId: `chan-${guildId}`, messageId, ...fields })
    .returning();
  return row;
}

const clipRow = async (app, id) => (await app.db.select().from(clips).where(eq(clips.id, id)))[0];
const postRow = async (app, messageId) =>
  (await app.db.select().from(posts).where(eq(posts.messageId, messageId)))[0];

/** @type {{ app: import('fastify').FastifyInstance, bot: Awaited<ReturnType<typeof stubBot>> }} */
const ctx = {};

before(async () => {
  ctx.bot = await stubBot();
  ctx.app = await testApp({ ...s3Env, BOT_INTERNAL_URL: ctx.bot.url });
  await seedGuilds(ctx.app);
  // Every object an upload could have written is there; /complete only needs HEADs to succeed.
  ctx.app.storage.head = async () => ({ size: 1000, contentType: 'video/mp4' });
  ctx.app.storage.deleteMany = async () => {};
});

after(async () => {
  await ctx.app?.close();
  await ctx.bot?.close();
});

// ---- POST /clips guildIds and /complete ---------------------------------------------------

test('a create without guildIds is the legacy path: no targets, and complete posts everywhere', async () => {
  const { app, bot } = ctx;
  await makeUser(app, '2001', 'tok-legacy');
  const ids = [];
  for (const payload of [validBody, { ...validBody, guildIds: null }]) {
    const res = await app.inject({ method: 'POST', url: '/clips', headers: device('tok-legacy'), payload });
    assert.equal(res.statusCode, 201, res.body);
    ids.push(res.json().id);
    assert.equal((await clipRow(app, res.json().id)).targetGuilds, null);
  }

  for (const id of ids) {
    const res = await app.inject({ method: 'POST', url: `/clips/${id}/complete`, headers: device('tok-legacy') });
    assert.equal(res.statusCode, 200, res.body);
    const [notified] = await requestsTo(bot, '/post', id);
    // Exactly the body an old bot has always received: no guildIds key at all.
    assert.deepEqual(notified.body, { clipId: id });
    assert.equal(notified.auth, botAuth.authorization);

    const internal = await app.inject({ method: 'GET', url: `/internal/clips/${id}`, headers: botAuth });
    assert.equal(internal.json().targetGuildIds, null);
  }
});

test('guildIds: [] is web page only, and complete never asks the bot to post', async () => {
  const { app, bot } = ctx;
  await makeUser(app, '2002', 'tok-webonly');
  const created = await app.inject({
    method: 'POST',
    url: '/clips',
    headers: device('tok-webonly'),
    payload: { ...validBody, guildIds: [] },
  });
  assert.equal(created.statusCode, 201, created.body);
  const { id } = created.json();
  assert.equal((await clipRow(app, id)).targetGuilds, '[]');

  const res = await app.inject({ method: 'POST', url: `/clips/${id}/complete`, headers: device('tok-webonly') });
  assert.equal(res.statusCode, 200, res.body);
  assert.equal(res.json().id, id, 'the clip is still ready and public');
  await sleep(200);
  assert.deepEqual(bot.to('/post', id), [], 'nothing to post');

  const internal = await app.inject({ method: 'GET', url: `/internal/clips/${id}`, headers: botAuth });
  assert.deepEqual(internal.json().targetGuildIds, []);
});

test('unknown guild ids are dropped at create, malformed ones are a 400', async () => {
  const { app, bot } = ctx;
  await makeUser(app, '2003', 'tok-targets');
  const create = (guildIds) =>
    app.inject({ method: 'POST', url: '/clips', headers: device('tok-targets'), payload: { ...validBody, guildIds } });

  const created = await create([BETA, UNCONFIGURED, ALPHA, BETA]);
  assert.equal(created.statusCode, 201, created.body);
  const { id } = created.json();
  // Configured only, deduplicated, in the order the user picked them.
  assert.equal((await clipRow(app, id)).targetGuilds, JSON.stringify([BETA, ALPHA]));

  // Only unknown ids leaves nothing, which is the same as asking for the web page only.
  const onlyUnknown = await create([UNCONFIGURED]);
  assert.equal(onlyUnknown.statusCode, 201, onlyUnknown.body);
  assert.equal((await clipRow(app, onlyUnknown.json().id)).targetGuilds, '[]');

  const res = await app.inject({ method: 'POST', url: `/clips/${id}/complete`, headers: device('tok-targets') });
  assert.equal(res.statusCode, 200, res.body);
  const [notified] = await requestsTo(bot, '/post', id);
  // The first post carries no guildIds: the bot reads the stored targets.
  assert.deepEqual(notified.body, { clipId: id });
  const internal = await app.inject({ method: 'GET', url: `/internal/clips/${id}`, headers: botAuth });
  assert.deepEqual(internal.json().targetGuildIds, [BETA, ALPHA]);

  for (const bad of [
    ['not-a-snowflake'],
    [''],
    [1001],
    'everyone',
    Array.from({ length: 26 }, (_, i) => String(3000 + i)),
  ]) {
    const r = await create(bad);
    assert.equal(r.statusCode, 400, `expected 400 for ${JSON.stringify(bad).slice(0, 40)}`);
    assert.equal(r.json().error, 'bad_request');
  }
});

// ---- POST /clips/:id/posts ----------------------------------------------------------------

test('POST /clips/:id/posts queues only configured guilds the clip is not live in', async () => {
  const { app, bot } = ctx;
  const owner = await makeUser(app, '2004', 'tok-more');
  await makeUser(app, '2005', 'tok-stranger');
  const addPosts = (id, payload, token = 'tok-more') =>
    app.inject({ method: 'POST', url: `/clips/${id}/posts`, headers: token ? device(token) : {}, payload });

  // A legacy clip, live in Alpha, taken down (Hide) in Beta.
  const clip = await insertClip(app, owner);
  await insertPost(app, clip.id, ALPHA, 'more-a');
  await insertPost(app, clip.id, BETA, 'more-b', { removedAt: new Date() });

  assert.equal((await addPosts(clip.id, { guildIds: [GAMMA] }, null)).statusCode, 401);
  assert.equal((await addPosts(clip.id, { guildIds: [GAMMA] }, 'tok-stranger')).statusCode, 403);
  const unknown = await addPosts('zzzzzzzzzzzz', { guildIds: [GAMMA] });
  assert.equal(unknown.statusCode, 404);
  assert.deepEqual(unknown.json(), { error: 'not_found' });
  for (const payload of [{}, { guildIds: [] }, { guildIds: ['abc'] }, { guildIds: GAMMA }]) {
    const r = await addPosts(clip.id, payload);
    assert.equal(r.statusCode, 400, JSON.stringify(payload));
    assert.equal(r.json().error, 'bad_request');
  }
  assert.deepEqual(bot.to('/post', clip.id), [], 'nothing refused reaches the bot');

  // Alpha is already live, 1999 is not configured; Beta's post was removed, so it can go again.
  let res = await addPosts(clip.id, { guildIds: [ALPHA, BETA, GAMMA, UNCONFIGURED] });
  assert.equal(res.statusCode, 202, res.body);
  assert.deepEqual(res.json(), { queued: [BETA, GAMMA] });
  // A null target becomes where it is live plus the new guilds.
  assert.equal((await clipRow(app, clip.id)).targetGuilds, JSON.stringify([ALPHA, BETA, GAMMA]));
  const [notified] = await requestsTo(bot, '/post', clip.id);
  assert.deepEqual(notified.body, { clipId: clip.id, guildIds: [BETA, GAMMA] });

  // Asking again for a guild it is live in queues nothing and bothers nobody.
  res = await addPosts(clip.id, { guildIds: [ALPHA, ALPHA] });
  assert.equal(res.statusCode, 202, res.body);
  assert.deepEqual(res.json(), { queued: [] });
  await sleep(200);
  assert.equal(bot.to('/post', clip.id).length, 1);
  assert.equal((await clipRow(app, clip.id)).targetGuilds, JSON.stringify([ALPHA, BETA, GAMMA]));

  // Stored targets are merged into, not replaced.
  const targeted = await insertClip(app, owner, { targetGuilds: JSON.stringify([BETA]) });
  res = await addPosts(targeted.id, { guildIds: [GAMMA, BETA] });
  assert.equal(res.statusCode, 202, res.body);
  assert.deepEqual(res.json(), { queued: [GAMMA, BETA] });
  assert.equal((await clipRow(app, targeted.id)).targetGuilds, JSON.stringify([BETA, GAMMA]));
});

test('POST /clips/:id/posts is a 409 until the clip is ready, and a 404 once deleted', async () => {
  const { app, bot } = ctx;
  const owner = await makeUser(app, '2006', 'tok-early');
  const pending = await insertClip(app, owner, { status: 'pending', uploadedAt: null });
  let res = await app.inject({
    method: 'POST',
    url: `/clips/${pending.id}/posts`,
    headers: device('tok-early'),
    payload: { guildIds: [ALPHA] },
  });
  assert.equal(res.statusCode, 409);
  assert.deepEqual(res.json(), { error: 'not_ready' });

  const deleted = await insertClip(app, owner, { status: 'deleted' });
  res = await app.inject({
    method: 'POST',
    url: `/clips/${deleted.id}/posts`,
    headers: device('tok-early'),
    payload: { guildIds: [ALPHA] },
  });
  assert.equal(res.statusCode, 404);

  await sleep(100);
  assert.deepEqual([...bot.to('/post', pending.id), ...bot.to('/post', deleted.id)], []);
});

// ---- GET /me/posts ------------------------------------------------------------------------

test('GET /me/posts lists only the live posts of your own ready clips, oldest first', async () => {
  const { app } = ctx;
  const me = await makeUser(app, '2007', 'tok-mine');
  const other = await makeUser(app, '2008', 'tok-theirs');
  const at = (minute) => new Date(Date.UTC(2026, 8, 10, 12, minute));

  const mine = await insertClip(app, me);
  await insertPost(app, mine.id, ALPHA, 'mine-a', { postedAt: at(2) });
  await insertPost(app, mine.id, GAMMA, 'mine-g', { postedAt: at(1) });
  await insertPost(app, mine.id, BETA, 'mine-b', { postedAt: at(0), removedAt: at(5) });
  // A post in a guild whose settings were since deleted still shows, just without a name.
  await insertPost(app, mine.id, UNCONFIGURED, 'mine-u', { postedAt: at(3) });

  const pending = await insertClip(app, me, { status: 'pending' });
  await insertPost(app, pending.id, ALPHA, 'mine-pending', { postedAt: at(0) });
  const deleted = await insertClip(app, me, { status: 'deleted' });
  await insertPost(app, deleted.id, ALPHA, 'mine-deleted', { postedAt: at(0) });
  const theirs = await insertClip(app, other);
  await insertPost(app, theirs.id, ALPHA, 'theirs-a', { postedAt: at(0) });

  assert.equal((await app.inject({ method: 'GET', url: '/me/posts' })).statusCode, 401);

  const res = await app.inject({ method: 'GET', url: '/me/posts', headers: device('tok-mine') });
  assert.equal(res.statusCode, 200, res.body);
  const item = (guildId, messageId, name, iconUrl, minute) => ({
    clipId: mine.id,
    guildId,
    name,
    iconUrl,
    channelId: `chan-${guildId}`,
    messageId,
    messageUrl: `https://discord.com/channels/${guildId}/chan-${guildId}/${messageId}`,
    postedAt: at(minute).toISOString(),
  });
  assert.deepEqual(res.json(), {
    items: [
      item(GAMMA, 'mine-g', null, null, 1),
      item(ALPHA, 'mine-a', 'Alpha', ALPHA_ICON, 2),
      item(UNCONFIGURED, 'mine-u', null, null, 3),
    ],
  });

  const theirsRes = await app.inject({ method: 'GET', url: '/me/posts', headers: device('tok-theirs') });
  assert.deepEqual(theirsRes.json().items.map((p) => p.messageId), ['theirs-a']);
});

// ---- bot side: /internal ------------------------------------------------------------------

test('GET /internal/clips/:id carries the targets and only the live posts', async () => {
  const { app } = ctx;
  const owner = await makeUser(app, '2009', 'tok-internal');
  const clip = await insertClip(app, owner, { targetGuilds: JSON.stringify([ALPHA, BETA]) });
  await insertPost(app, clip.id, ALPHA, 'int-a');
  await insertPost(app, clip.id, BETA, 'int-b', { removedAt: new Date() });

  let res = await app.inject({ method: 'GET', url: `/internal/clips/${clip.id}`, headers: botAuth });
  assert.equal(res.statusCode, 200, res.body);
  assert.deepEqual(res.json().targetGuildIds, [ALPHA, BETA]);
  assert.deepEqual(res.json().posts, [{ guildId: ALPHA, channelId: `chan-${ALPHA}`, messageId: 'int-a' }]);

  // A hand-mangled column must not 500 the bot's read; it degrades to no targets, which posts
  // nowhere rather than everywhere.
  for (const garbage of ['not json', '{"not":"an array"}']) {
    await app.db.update(clips).set({ targetGuilds: garbage }).where(eq(clips.id, clip.id));
    res = await app.inject({ method: 'GET', url: `/internal/clips/${clip.id}`, headers: botAuth });
    assert.equal(res.statusCode, 200, res.body);
    assert.deepEqual(res.json().targetGuildIds, []);
  }
});

test('DELETE /internal/posts/:messageId marks the post removed and keeps the row', async () => {
  const { app } = ctx;
  const owner = await makeUser(app, '2010', 'tok-hide');
  const clip = await insertClip(app, owner);
  await insertPost(app, clip.id, ALPHA, 'hide-me');

  let res = await app.inject({ method: 'DELETE', url: '/internal/posts/hide-me' });
  assert.equal(res.statusCode, 401);
  res = await app.inject({
    method: 'DELETE',
    url: '/internal/posts/hide-me',
    headers: { authorization: 'Bearer wrong-secret-0123456789' },
  });
  assert.equal(res.statusCode, 401);
  assert.equal((await postRow(app, 'hide-me')).removedAt, null, 'refused calls change nothing');

  res = await app.inject({ method: 'DELETE', url: '/internal/posts/hide-me', headers: botAuth });
  assert.equal(res.statusCode, 204);
  const first = (await postRow(app, 'hide-me')).removedAt;
  assert.ok(first instanceof Date, 'removed_at is set');

  // No longer live anywhere the publish routes look...
  const internal = await app.inject({ method: 'GET', url: `/internal/clips/${clip.id}`, headers: botAuth });
  assert.deepEqual(internal.json().posts, []);
  const mine = await app.inject({ method: 'GET', url: '/me/posts', headers: device('tok-hide') });
  assert.deepEqual(mine.json().items, []);
  // ...but the row is still there for the rankings and the guild site.
  assert.equal((await app.inject({ method: 'GET', url: '/internal/posts/hide-me', headers: botAuth })).statusCode, 200);

  // A retried call is still a 204 and does not move the timestamp.
  await sleep(10);
  res = await app.inject({ method: 'DELETE', url: '/internal/posts/hide-me', headers: botAuth });
  assert.equal(res.statusCode, 204);
  assert.equal((await postRow(app, 'hide-me')).removedAt.getTime(), first.getTime());

  res = await app.inject({ method: 'DELETE', url: '/internal/posts/never-posted', headers: botAuth });
  assert.equal(res.statusCode, 404);
  assert.deepEqual(res.json(), { error: 'unknown_message' });
});

// ---- purge: unpublish and delete ----------------------------------------------------------

test('deleting a clip marks its live posts removed and asks the bot to unpost them', async () => {
  const { app, bot } = ctx;
  const owner = await makeUser(app, '2011', 'tok-purge');
  const hiddenAt = new Date('2026-09-02T00:00:00Z');
  const byMessage = (a, b) => a.messageId.localeCompare(b.messageId);

  // Through the owner's DELETE /clips/:id, which is also what "unpublish" calls.
  const clip = await insertClip(app, owner);
  await insertPost(app, clip.id, ALPHA, 'purge-a');
  await insertPost(app, clip.id, BETA, 'purge-b');
  await insertPost(app, clip.id, GAMMA, 'purge-g', { removedAt: hiddenAt });

  let res = await app.inject({ method: 'DELETE', url: `/clips/${clip.id}`, headers: device('tok-purge') });
  assert.equal(res.statusCode, 204);
  assert.equal((await clipRow(app, clip.id)).status, 'deleted');
  assert.ok((await postRow(app, 'purge-a')).removedAt instanceof Date);
  assert.ok((await postRow(app, 'purge-b')).removedAt instanceof Date);
  assert.equal(
    (await postRow(app, 'purge-g')).removedAt.getTime(),
    hiddenAt.getTime(),
    'a post already hidden keeps the time it was hidden',
  );

  const [unpost] = await requestsTo(bot, '/unpost', clip.id);
  assert.equal(unpost.auth, botAuth.authorization);
  assert.equal(unpost.body.clipId, clip.id);
  assert.deepEqual(unpost.body.posts.sort(byMessage), [
    { guildId: ALPHA, channelId: `chan-${ALPHA}`, messageId: 'purge-a' },
    { guildId: BETA, channelId: `chan-${BETA}`, messageId: 'purge-b' },
  ]);

  // Through the bot's manage menu, which takes the same path.
  const fromDiscord = await insertClip(app, owner);
  await insertPost(app, fromDiscord.id, ALPHA, 'purge-menu');
  res = await app.inject({ method: 'DELETE', url: `/internal/clips/${fromDiscord.id}`, headers: botAuth });
  assert.equal(res.statusCode, 204);
  assert.ok((await postRow(app, 'purge-menu')).removedAt instanceof Date);
  const [menuUnpost] = await requestsTo(bot, '/unpost', fromDiscord.id);
  assert.deepEqual(menuUnpost.body, {
    clipId: fromDiscord.id,
    posts: [{ guildId: ALPHA, channelId: `chan-${ALPHA}`, messageId: 'purge-menu' }],
  });

  // A clip that was never on Discord has nothing to unpost, so the bot is not called.
  const webOnly = await insertClip(app, owner, { targetGuilds: '[]' });
  res = await app.inject({ method: 'DELETE', url: `/clips/${webOnly.id}`, headers: device('tok-purge') });
  assert.equal(res.statusCode, 204);
  await sleep(200);
  assert.deepEqual(bot.to('/unpost', webOnly.id), []);

  // And a second delete is still the 404 the desktop treats as done.
  res = await app.inject({ method: 'DELETE', url: `/clips/${clip.id}`, headers: device('tok-purge') });
  assert.equal(res.statusCode, 404);
});

test('unpostBot retries like notifyBot and never rejects', async () => {
  const { app, bot } = ctx;
  setRetryDelays([20, 20, 20]);
  bot.answers((req) => (req.url === '/unpost' ? { status: 500 } : { status: 202 }));
  try {
    const post = { guildId: ALPHA, channelId: 'c', messageId: 'm', extra: 'dropped' };
    await assert.doesNotReject(app.unpostBot('retryclip01', [post]));
    const attempts = await requestsTo(bot, '/unpost', 'retryclip01', 4);
    assert.equal(attempts.length, 4, 'one attempt and three retries');
    assert.deepEqual(attempts[0].body, {
      clipId: 'retryclip01',
      posts: [{ guildId: ALPHA, channelId: 'c', messageId: 'm' }],
    });

    await assert.doesNotReject(app.unpostBot('retryclip02', []));
    await sleep(100);
    assert.deepEqual(bot.to('/unpost', 'retryclip02'), [], 'no posts, no request');
  } finally {
    setRetryDelays(null);
    bot.answers(null);
  }
});

// ---- GET /discord/guilds ------------------------------------------------------------------

test('GET /discord/guilds lists the configured guilds the bot says the caller is in, by name', async () => {
  const { app, bot } = ctx;
  await makeUser(app, '2012', 'tok-dialog');
  // The bot also names a guild nobody asked about; it can only narrow the list, never widen it.
  bot.answers((req) =>
    req.url === '/member-guilds'
      ? { status: 200, body: JSON.stringify({ guildIds: [GAMMA, ALPHA, '4242'] }) }
      : { status: 202 },
  );
  try {
    const before = bot.to('/member-guilds').length;
    assert.equal((await app.inject({ method: 'GET', url: '/discord/guilds' })).statusCode, 401);
    assert.equal(bot.to('/member-guilds').length, before, 'an unauthenticated call must not reach the bot');

    const res = await app.inject({ method: 'GET', url: '/discord/guilds', headers: device('tok-dialog') });
    assert.equal(res.statusCode, 200, res.body);
    assert.deepEqual(res.json(), {
      items: [
        { guildId: ALPHA, name: 'Alpha', iconUrl: ALPHA_ICON, slug: 'alpha' },
        { guildId: GAMMA, name: null, iconUrl: null, slug: 'gamma' },
      ],
    });

    const asked = bot.to('/member-guilds').at(-1);
    assert.equal(asked.auth, botAuth.authorization);
    // Always about the caller, and about every configured guild.
    assert.deepEqual(asked.body, { discordId: '2012', guildIds: [ALPHA, BETA, GAMMA] });
  } finally {
    bot.answers(null);
  }
});

test('GET /discord/guilds is a 503 when the bot cannot say', async () => {
  const { app, bot } = ctx;
  await makeUser(app, '2013', 'tok-botdown');
  const cases = [
    ['a non-2xx', { status: 500 }],
    ['a body that is not JSON', { status: 200, body: 'not json' }],
    ['guildIds missing', { status: 200, body: '{}' }],
    ['guildIds not an array', { status: 200, body: '{"guildIds":"all"}' }],
    ['a dropped connection', { destroy: true }],
  ];
  try {
    for (const [name, out] of cases) {
      bot.answers((req) => (req.url === '/member-guilds' ? out : { status: 202 }));
      const res = await app.inject({ method: 'GET', url: '/discord/guilds', headers: device('tok-botdown') });
      assert.equal(res.statusCode, 503, `expected 503 for ${name}: ${res.body}`);
      assert.deepEqual(res.json(), { error: 'bot_unavailable' });
    }
  } finally {
    bot.answers(null);
  }
});

test('GET /discord/guilds without BOT_INTERNAL_URL lists every configured guild', async () => {
  const app = await testApp();
  try {
    await makeUser(app, '2014', 'tok-localdev');
    let res = await app.inject({ method: 'GET', url: '/discord/guilds', headers: device('tok-localdev') });
    assert.equal(res.statusCode, 200, res.body);
    assert.deepEqual(res.json(), { items: [] }, 'no guild configured yet');

    await seedGuilds(app);
    res = await app.inject({ method: 'GET', url: '/discord/guilds', headers: device('tok-localdev') });
    assert.equal(res.statusCode, 200, res.body);
    assert.deepEqual(res.json().items.map((g) => g.guildId), [ALPHA, BETA, GAMMA]);
    assert.deepEqual(res.json().items[1], { guildId: BETA, name: 'Beta', iconUrl: null, slug: null });
  } finally {
    await app.close();
  }
});
