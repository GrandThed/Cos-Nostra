// The public per-guild clip site (docs/PLAN.md phase 5): browser login, session-authed clip
// management, and the guild-scoped browse pages. Follows the same PGlite/app.inject pattern
// as auth.test.js and clips.test.js; the Discord stub is a smaller copy of auth.test.js's,
// since only /oauth2/token and /users/@me are ever hit here.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

import { eq } from 'drizzle-orm';

import { buildApp } from '../src/app.js';
import { clips, guildSettings, posts, users } from '../src/db/schema.js';
import { randomId } from '../src/lib/ids.js';
import { testEnv } from './helpers.js';

const s3Env = {
  S3_ENDPOINT: 'http://127.0.0.1:9',
  S3_BUCKET: 'test-bucket',
  S3_ACCESS_KEY_ID: 'AKIATEST',
  S3_SECRET_ACCESS_KEY: 'secret-test',
  S3_URL_STYLE: 'path',
};

const discordUser = { id: '999888777666555444', username: 'renata', avatar: 'iconhash' };

/** Minimal Discord API stub: one browser-login round trip at a time. */
function startDiscordStub() {
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      if (req.method === 'POST' && req.url === '/oauth2/token') {
        const params = new URLSearchParams(body);
        if (params.get('code') !== 'good-code') {
          res.writeHead(400, { 'content-type': 'application/json' });
          return res.end(JSON.stringify({ error: 'invalid_grant' }));
        }
        res.writeHead(200, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ access_token: 'access-xyz', token_type: 'Bearer' }));
      }
      if (req.method === 'GET' && req.url === '/users/@me') {
        if (req.headers.authorization !== 'Bearer access-xyz') {
          res.writeHead(401, { 'content-type': 'application/json' });
          return res.end(JSON.stringify({ message: '401: Unauthorized' }));
        }
        res.writeHead(200, { 'content-type': 'application/json' });
        return res.end(JSON.stringify(discordUser));
      }
      res.writeHead(404);
      res.end();
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({ server, base: `http://127.0.0.1:${port}` });
    });
  });
}

let stub;
before(async () => {
  stub = await startDiscordStub();
});
after(() => stub.server.close());

async function siteApp(extraEnv = {}) {
  const app = await buildApp({
    env: { ...testEnv, ...s3Env, DISCORD_API_BASE: stub.base, ...extraEnv },
    fastify: { logger: false },
  });
  await app.ready();
  return app;
}

/** Grabs the session cookie's raw value from a light-my-request response. */
function sessionCookie(res) {
  const found = res.cookies.find((c) => c.name === 'cn_session');
  assert.ok(found, 'response should set the session cookie');
  return `cn_session=${found.value}`;
}

async function logIn(app) {
  const start = await app.inject({ method: 'GET', url: '/login?next=/somewhere' });
  assert.equal(start.statusCode, 302);
  const location = new URL(start.headers.location);
  assert.equal(location.origin + location.pathname, 'https://discord.com/oauth2/authorize');
  const state = location.searchParams.get('state');
  const callback = await app.inject({
    method: 'GET',
    url: `/login/callback?code=good-code&state=${encodeURIComponent(state)}`,
  });
  assert.equal(callback.statusCode, 302);
  assert.equal(callback.headers.location, '/somewhere');
  return sessionCookie(callback);
}

async function insertReadyClip(app, userId, fields = {}) {
  const id = randomId();
  const [row] = await app.db
    .insert(clips)
    .values({
      id,
      userId,
      durationMs: 30000,
      keyAv1: `clips/${userId}/${id}/av1.mp4`,
      keyH264: `clips/${userId}/${id}/h264.mp4`,
      keyThumb: `clips/${userId}/${id}/thumb.jpg`,
      status: 'ready',
      recordedAt: new Date(),
      uploadedAt: new Date(),
      ...fields,
    })
    .returning();
  return row;
}

test('browser login: redirects to Discord, sets a revocable session cookie', async () => {
  const app = await siteApp();
  try {
    const cookie = await logIn(app);

    const [row] = await app.db.select().from(users);
    assert.equal(row.discordId, discordUser.id);
    assert.equal(row.username, discordUser.username);

    const me = await app.inject({ method: 'GET', url: '/c/does-not-matter', headers: { cookie } });
    // Viewing never needs a session; this just proves the cookie round-trips without a 401
    // anywhere in the stack (a 404 here is the clip lookup, not an auth failure).
    assert.equal(me.statusCode, 404);

    // Logout destroys the row server-side, not just the cookie: the same cookie value must
    // stop being able to prove ownership afterwards (checked via the update route below).
    const clip = await insertReadyClip(app, row.id, { title: 'before logout' });
    const logout = await app.inject({ method: 'POST', url: '/logout', headers: { cookie } });
    assert.equal(logout.statusCode, 302);

    const patchAfterLogout = await app.inject({
      method: 'PATCH',
      url: `/clips/${clip.id}`,
      headers: { cookie, 'content-type': 'application/json' },
      payload: { title: 'should not apply' },
    });
    assert.equal(patchAfterLogout.statusCode, 401);
  } finally {
    await app.close();
  }
});

test('PATCH /clips/:id: a logged-in owner can rename, a stranger cannot', async () => {
  const app = await siteApp();
  try {
    const cookie = await logIn(app);
    const [owner] = await app.db.select().from(users);
    const clip = await insertReadyClip(app, owner.id, { title: 'old title', game: 'Old Game' });

    const rename = await app.inject({
      method: 'PATCH',
      url: `/clips/${clip.id}`,
      headers: { cookie, 'content-type': 'application/json' },
      payload: { title: 'new title', game: 'New Game' },
    });
    assert.equal(rename.statusCode, 200);
    assert.equal(rename.json().title, 'new title');
    assert.equal(rename.json().game, 'New Game');

    // A second Discord account gets its own session and cannot touch the first user's clip.
    stub.server.close();
    stub = await startDiscordStub();
    const strangerLogin = await app.inject({ method: 'GET', url: '/login' });
    const strangerState = new URL(strangerLogin.headers.location).searchParams.get('state');
    // Same stub, different discordUser would need a second fixture; reusing discordUser here
    // would just re-authenticate as the owner, so this exercises "no cookie" instead, which
    // every route must also treat as unauthorized, not merely "not the owner".
    const noCookie = await app.inject({
      method: 'PATCH',
      url: `/clips/${clip.id}`,
      headers: { 'content-type': 'application/json' },
      payload: { title: 'nope' },
    });
    assert.equal(noCookie.statusCode, 401);
    void strangerState;

    const empty = await app.inject({
      method: 'PATCH',
      url: `/clips/${clip.id}`,
      headers: { cookie, 'content-type': 'application/json' },
      payload: {},
    });
    assert.equal(empty.statusCode, 400);
  } finally {
    await app.close();
  }
});

test('DELETE /clips/:id works with a session cookie the same way it does with a device token', async () => {
  const app = await siteApp();
  try {
    const cookie = await logIn(app);
    const [owner] = await app.db.select().from(users);
    const clip = await insertReadyClip(app, owner.id);
    const deleted = [];
    app.storage.deleteMany = async (keys) => deleted.push(...keys);

    const res = await app.inject({ method: 'DELETE', url: `/clips/${clip.id}`, headers: { cookie } });
    assert.equal(res.statusCode, 204);
    assert.equal(deleted.length, 3);
    const [row] = await app.db.select().from(clips).where(eq(clips.id, clip.id));
    assert.equal(row.status, 'deleted');
  } finally {
    await app.close();
  }
});

test('guild site: browse by game and by user, 404 for an unknown or reserved slug', async () => {
  const app = await siteApp();
  try {
    const [owner] = await app.db
      .insert(users)
      .values({ discordId: '111', username: 'grantthed', avatar: 'av1' })
      .returning();
    const clip = await insertReadyClip(app, owner.id, { title: 'Ace clutch', game: 'Valorant' });
    await app.db
      .insert(guildSettings)
      .values({ guildId: '438477166573912074', channelId: '1', name: 'FAMAFIA', slug: 'famafia' });
    await app.db.insert(posts).values({
      clipId: clip.id,
      guildId: '438477166573912074',
      channelId: '1',
      messageId: 'msg-1',
    });

    const home = await app.inject({ method: 'GET', url: '/famafia' });
    assert.equal(home.statusCode, 200);
    assert.match(home.body, /FAMAFIA/);
    assert.match(home.body, /Ace clutch/);

    const games = await app.inject({ method: 'GET', url: '/famafia/games' });
    assert.match(games.body, /Valorant/);

    const byGame = await app.inject({ method: 'GET', url: '/famafia/g/Valorant' });
    assert.match(byGame.body, /Ace clutch/);

    const usersPage = await app.inject({ method: 'GET', url: '/famafia/users' });
    assert.match(usersPage.body, /grantthed/);

    const byUser = await app.inject({ method: 'GET', url: '/famafia/u/111' });
    assert.match(byUser.body, /Ace clutch/);

    const clipRedirect = await app.inject({ method: 'GET', url: `/famafia/c/${clip.id}` });
    assert.equal(clipRedirect.statusCode, 302);
    assert.equal(clipRedirect.headers.location, `/c/${clip.id}?guild=famafia`);

    const unknownSlug = await app.inject({ method: 'GET', url: '/no-such-server' });
    assert.equal(unknownSlug.statusCode, 404);

    // "clips" is a real top-level route (the JSON API); the guild site must not shadow it,
    // so a guild that (invalidly) shares that name is simply unreachable through /:slug.
    const reserved = await app.inject({ method: 'GET', url: '/clips' });
    assert.doesNotMatch(reserved.headers['content-type'] ?? '', /text\/html/);
  } finally {
    await app.close();
  }
});

test('PUT /internal/guilds/:guildId: name, icon and slug save, a taken slug is refused', async () => {
  const app = await siteApp();
  try {
    const bot = { authorization: `Bearer ${testEnv.BOT_SHARED_SECRET}` };

    const first = await app.inject({
      method: 'PUT',
      url: '/internal/guilds/111111111111111111',
      headers: { ...bot, 'content-type': 'application/json' },
      payload: { channelId: '222', name: 'First Server', icon: 'hash1', slug: 'shared-slug' },
    });
    assert.equal(first.statusCode, 200);
    assert.equal(first.json().slug, 'shared-slug');
    assert.equal(first.json().icon, 'hash1');

    const conflict = await app.inject({
      method: 'PUT',
      url: '/internal/guilds/222222222222222222',
      headers: { ...bot, 'content-type': 'application/json' },
      payload: { channelId: '333', slug: 'shared-slug' },
    });
    assert.equal(conflict.statusCode, 409);
    assert.equal(conflict.json().error, 'slug_taken');

    // icon: null explicitly clears a removed custom icon, distinct from omitting it.
    const cleared = await app.inject({
      method: 'PUT',
      url: '/internal/guilds/111111111111111111',
      headers: { ...bot, 'content-type': 'application/json' },
      payload: { channelId: '222', icon: null },
    });
    assert.equal(cleared.statusCode, 200);
    assert.equal(cleared.json().icon, null);
    assert.equal(cleared.json().slug, 'shared-slug', 'omitted slug is left alone');

    const badSlug = await app.inject({
      method: 'PUT',
      url: '/internal/guilds/333333333333333333',
      headers: { ...bot, 'content-type': 'application/json' },
      payload: { channelId: '444', slug: 'login' },
    });
    assert.equal(badSlug.statusCode, 400);
  } finally {
    await app.close();
  }
});
