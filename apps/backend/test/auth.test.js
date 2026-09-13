// Device login flow end to end against a stub Discord server, plus the bot preHandler.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { eq } from 'drizzle-orm';

import { testApp } from './helpers.js';
import { schema } from '../src/db/index.js';
import { hashToken, newToken } from '../src/lib/tokens.js';

const discordUser = { id: '123456789012345678', username: 'benja', avatar: 'abc123' };

/** Minimal Discord API stub: records the token request, answers users/@me. */
function startDiscordStub() {
  const seen = { tokenRequests: [], userRequests: [] };
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      if (req.method === 'POST' && req.url === '/oauth2/token') {
        const params = new URLSearchParams(body);
        seen.tokenRequests.push(Object.fromEntries(params));
        if (params.get('code') !== 'good-code') {
          res.writeHead(400, { 'content-type': 'application/json' });
          return res.end(JSON.stringify({ error: 'invalid_grant' }));
        }
        res.writeHead(200, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ access_token: 'access-xyz', token_type: 'Bearer' }));
      }
      if (req.method === 'GET' && req.url === '/users/@me') {
        seen.userRequests.push(req.headers.authorization);
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
      resolve({ server, seen, base: `http://127.0.0.1:${port}` });
    });
  });
}

let stub;
before(async () => {
  stub = await startDiscordStub();
});
after(() => stub.server.close());

test('device flow: start, confirm, callback, poll, me, revoke', async () => {
  const app = await testApp({ DISCORD_API_BASE: stub.base });
  try {
    // 1. Desktop starts a login.
    const start = await app.inject({
      method: 'POST',
      url: '/auth/device',
      payload: { deviceName: 'gaming-pc' },
    });
    assert.equal(start.statusCode, 200);
    const { code, verifyUrl, pollSecret, expiresIn } = start.json();
    assert.match(code, /^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{8}$/);
    assert.equal(verifyUrl, `http://localhost:3000/auth/discord/start?device=${code}`);
    assert.equal(expiresIn, 600);
    // The poll secret is a fresh 32-byte token, and only its hash is stored.
    assert.match(pollSecret, /^[A-Za-z0-9_-]{43}$/);
    const [loginRow] = await app.db.select().from(schema.deviceLogins);
    assert.equal(loginRow.pollSecretHash, hashToken(pollSecret));
    assert.notEqual(loginRow.pollSecretHash, pollSecret);

    const poll = (secret) =>
      app.inject({
        method: 'GET',
        url: `/auth/device/${code}`,
        ...(secret === undefined ? {} : { headers: { authorization: `Bearer ${secret}` } }),
      });

    // 2. Polling before the browser finished is pending, but only for the holder of the secret.
    let polled = await poll(pollSecret);
    assert.equal(polled.statusCode, 200);
    assert.deepEqual(polled.json(), { status: 'pending' });

    // 3. Browser opens the verify URL. It must NOT be sent to Discord: it gets a confirmation
    // page naming the device and the code first.
    const confirm = await app.inject({ method: 'GET', url: `/auth/discord/start?device=${code}` });
    assert.equal(confirm.statusCode, 200);
    assert.match(confirm.headers['content-type'], /text\/html/);
    assert.equal(confirm.headers.location, undefined, 'GET start must never redirect');
    assert.match(confirm.body, /gaming-pc/);
    assert.ok(confirm.body.includes(code), 'the page shows the code to check against the app');
    assert.match(confirm.body, /Only continue if this code is showing in the Cos Nostra app/);
    assert.match(confirm.body, /<form method="post" action="\/auth\/discord\/start">/);

    // An auto-submitting form on someone else's page cannot stand in for that click.
    const crossSite = await app.inject({
      method: 'POST',
      url: '/auth/discord/start',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        origin: 'https://evil.example',
      },
      payload: `device=${code}`,
    });
    assert.equal(crossSite.statusCode, 403);
    assert.equal(crossSite.headers.location, undefined);

    // Neither can a sandboxed iframe or a data: page, which send the literal "null" origin.
    const nullOrigin = await app.inject({
      method: 'POST',
      url: '/auth/discord/start',
      headers: { 'content-type': 'application/x-www-form-urlencoded', origin: 'null' },
      payload: `device=${code}`,
    });
    assert.equal(nullOrigin.statusCode, 403);
    assert.equal(nullOrigin.headers.location, undefined);

    // 4. Clicking Continue posts the form and only then are we sent to Discord with our state.
    const redirect = await app.inject({
      method: 'POST',
      url: '/auth/discord/start',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        origin: 'http://localhost:3000',
      },
      payload: `device=${code}`,
    });
    assert.equal(redirect.statusCode, 302);
    const location = new URL(redirect.headers.location);
    assert.equal(location.origin + location.pathname, 'https://discord.com/oauth2/authorize');
    assert.equal(location.searchParams.get('client_id'), 'client-id');
    assert.equal(location.searchParams.get('scope'), 'identify');
    assert.equal(location.searchParams.get('response_type'), 'code');
    assert.equal(
      location.searchParams.get('redirect_uri'),
      'http://localhost:3000/auth/discord/callback',
    );
    const state = location.searchParams.get('state');
    assert.ok(state);
    assert.deepEqual(app.jwt.verify(state).device, code);

    // 5. Discord sends the browser back; the backend links the device.
    const callback = await app.inject({
      method: 'GET',
      url: `/auth/discord/callback?code=good-code&state=${encodeURIComponent(state)}`,
    });
    assert.equal(callback.statusCode, 200);
    assert.match(callback.headers['content-type'], /text\/html/);
    assert.match(callback.body, /Device linked/);
    // The success page names the device again, so linking the wrong machine is visible.
    assert.match(callback.body, /Linked gaming-pc\. You can close this tab\./);
    assert.equal(stub.seen.tokenRequests.length, 1);
    assert.equal(stub.seen.tokenRequests[0].client_secret, 'client-secret');
    assert.equal(stub.seen.tokenRequests[0].grant_type, 'authorization_code');
    assert.equal(
      stub.seen.tokenRequests[0].redirect_uri,
      'http://localhost:3000/auth/discord/callback',
    );
    assert.deepEqual(stub.seen.userRequests, ['Bearer access-xyz']);

    const users = await app.db.select().from(schema.users);
    assert.equal(users.length, 1);
    assert.equal(users[0].discordId, discordUser.id);
    assert.equal(users[0].username, 'benja');
    const devices = await app.db.select().from(schema.devices);
    assert.equal(devices.length, 1);
    assert.equal(devices[0].name, 'gaming-pc');
    assert.equal(devices[0].userId, users[0].id);

    // Reusing the same state after linking is refused.
    const again = await app.inject({
      method: 'GET',
      url: `/auth/discord/callback?code=good-code&state=${encodeURIComponent(state)}`,
    });
    assert.equal(again.statusCode, 400);
    assert.match(again.body, /Already linked/);

    // 6. A poll without the secret, or with the wrong one, cannot collect the ready token.
    for (const secret of [undefined, newToken(), '', hashToken(pollSecret)]) {
      polled = await poll(secret);
      assert.equal(polled.statusCode, 401, `should reject poll secret ${JSON.stringify(secret)}`);
      assert.deepEqual(polled.json(), { error: 'unauthorized' });
    }
    assert.equal(
      (await app.db.select().from(schema.deviceLogins)).length,
      1,
      'a refused poll leaves the login row alone',
    );

    // 7. The right secret returns the token exactly once.
    polled = await poll(pollSecret);
    assert.equal(polled.statusCode, 200);
    const ready = polled.json();
    assert.equal(ready.status, 'ready');
    assert.equal(typeof ready.token, 'string');
    assert.equal(hashToken(ready.token), devices[0].tokenHash);
    assert.deepEqual(ready.user, {
      id: users[0].id,
      discordId: discordUser.id,
      username: 'benja',
      avatar: 'abc123',
    });
    // The row is gone, so even the rightful holder now looks like anyone else: 401, not 404.
    polled = await poll(pollSecret);
    assert.equal(polled.statusCode, 401);
    assert.deepEqual(polled.json(), { error: 'unauthorized' });
    const logins = await app.db.select().from(schema.deviceLogins);
    assert.equal(logins.length, 0, 'login row is gone once the token was collected');

    // 8. The token authenticates; nothing else does.
    const me = await app.inject({
      method: 'GET',
      url: '/auth/me',
      headers: { authorization: `Bearer ${ready.token}` },
    });
    assert.equal(me.statusCode, 200);
    assert.deepEqual(me.json(), {
      user: { id: users[0].id, discordId: discordUser.id, username: 'benja', avatar: 'abc123' },
      device: { id: devices[0].id, name: 'gaming-pc' },
    });
    const [touched] = await app.db.select().from(schema.devices);
    assert.ok(touched.lastSeen instanceof Date, 'last_seen is set after first use');

    for (const headers of [{}, { authorization: `Bearer ${newToken()}` }, { authorization: 'Basic x' }]) {
      const res = await app.inject({ method: 'GET', url: '/auth/me', headers });
      assert.equal(res.statusCode, 401);
      assert.deepEqual(res.json(), { error: 'unauthorized' });
    }

    // 9. Revoke, then the token is dead.
    const revoke = await app.inject({
      method: 'DELETE',
      url: '/auth/device',
      headers: { authorization: `Bearer ${ready.token}` },
    });
    assert.equal(revoke.statusCode, 204);
    const after = await app.inject({
      method: 'GET',
      url: '/auth/me',
      headers: { authorization: `Bearer ${ready.token}` },
    });
    assert.equal(after.statusCode, 401);
    assert.equal((await app.db.select().from(schema.devices)).length, 0);
  } finally {
    await app.close();
  }
});

test('second login for the same Discord user updates the profile instead of duplicating it', async () => {
  const app = await testApp({ DISCORD_API_BASE: stub.base });
  try {
    await app.db
      .insert(schema.users)
      .values({ discordId: discordUser.id, username: 'old-name', avatar: null });
    const { code } = (
      await app.inject({ method: 'POST', url: '/auth/device', payload: { deviceName: 'laptop' } })
    ).json();
    const state = app.jwt.sign({ device: code }, { expiresIn: '10m' });
    const callback = await app.inject({
      method: 'GET',
      url: `/auth/discord/callback?code=good-code&state=${encodeURIComponent(state)}`,
    });
    assert.equal(callback.statusCode, 200);
    const users = await app.db.select().from(schema.users);
    assert.equal(users.length, 1);
    assert.equal(users[0].username, 'benja');
    assert.equal(users[0].avatar, 'abc123');
  } finally {
    await app.close();
  }
});

test('bad input: unknown codes, bad state, discord failures, expired logins', async () => {
  const app = await testApp({ DISCORD_API_BASE: stub.base });
  try {
    let res = await app.inject({ method: 'POST', url: '/auth/device', payload: {} });
    assert.equal(res.statusCode, 400);
    assert.equal(res.json().error, 'bad_request');
    assert.ok(Array.isArray(res.json().issues));

    // A malformed code, an unknown code and a real code polled without a secret are all the
    // same 401, so polling tells an attacker nothing about which codes exist.
    for (const url of ['/auth/device/NOPE', '/auth/device/ABCDEFGH']) {
      for (const headers of [{}, { authorization: `Bearer ${newToken()}` }]) {
        res = await app.inject({ method: 'GET', url, headers });
        assert.equal(res.statusCode, 401);
        assert.deepEqual(res.json(), { error: 'unauthorized' });
      }
    }

    res = await app.inject({ method: 'GET', url: '/auth/discord/start?device=ABCDEFGH' });
    assert.equal(res.statusCode, 400);
    assert.match(res.headers['content-type'], /text\/html/);
    assert.match(res.body, /Unknown or expired code/);
    res = await app.inject({ method: 'GET', url: '/auth/discord/start' });
    assert.equal(res.statusCode, 400);

    // The POST behind Continue validates the code the same way, so it cannot be used to skip
    // the interstitial with a stale or made-up code.
    for (const payload of ['device=ABCDEFGH', 'device=nope', '']) {
      res = await app.inject({
        method: 'POST',
        url: '/auth/discord/start',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        payload,
      });
      assert.equal(res.statusCode, 400, `should refuse body ${JSON.stringify(payload)}`);
      assert.match(res.headers['content-type'], /text\/html/);
      assert.equal(res.headers.location, undefined);
    }

    res = await app.inject({ method: 'GET', url: '/auth/discord/callback?code=x&state=garbage' });
    assert.equal(res.statusCode, 400);
    assert.match(res.body, /invalid or has expired/);

    // Valid state but Discord rejects the code -> 502, nothing linked.
    const { code, pollSecret } = (
      await app.inject({ method: 'POST', url: '/auth/device', payload: { deviceName: 'pc' } })
    ).json();
    const auth = { authorization: `Bearer ${pollSecret}` };
    const state = app.jwt.sign({ device: code }, { expiresIn: '10m' });
    res = await app.inject({
      method: 'GET',
      url: `/auth/discord/callback?code=bad-code&state=${encodeURIComponent(state)}`,
    });
    assert.equal(res.statusCode, 502);
    assert.equal((await app.db.select().from(schema.devices)).length, 0);
    res = await app.inject({ method: 'GET', url: `/auth/device/${code}`, headers: auth });
    assert.deepEqual(res.json(), { status: 'pending' });

    // User cancels on Discord -> 400, still pending.
    res = await app.inject({
      method: 'GET',
      url: `/auth/discord/callback?error=access_denied&state=${encodeURIComponent(state)}`,
    });
    assert.equal(res.statusCode, 400);
    assert.match(res.body, /cancelled/);

    // Expire the login: start refuses it, poll 401s and the row is cleaned up.
    await app.db
      .update(schema.deviceLogins)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(schema.deviceLogins.code, code));
    res = await app.inject({ method: 'GET', url: `/auth/discord/start?device=${code}` });
    assert.equal(res.statusCode, 400);
    res = await app.inject({ method: 'GET', url: `/auth/device/${code}`, headers: auth });
    assert.equal(res.statusCode, 401);
    assert.equal((await app.db.select().from(schema.deviceLogins)).length, 0);
  } finally {
    await app.close();
  }
});

test('a login that expires after linking takes its uncollected device with it', async () => {
  const app = await testApp({ DISCORD_API_BASE: stub.base });
  try {
    const { code, pollSecret } = (
      await app.inject({ method: 'POST', url: '/auth/device', payload: { deviceName: 'orphan-pc' } })
    ).json();
    const state = app.jwt.sign({ device: code }, { expiresIn: '10m' });
    const callback = await app.inject({
      method: 'GET',
      url: `/auth/discord/callback?code=good-code&state=${encodeURIComponent(state)}`,
    });
    assert.equal(callback.statusCode, 200);
    assert.equal((await app.db.select().from(schema.devices)).length, 1);

    // The desktop never came back for the token, and the code ran out. The device row holds a
    // working credential nobody was ever handed, so it must not survive the login row.
    await app.db
      .update(schema.deviceLogins)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(schema.deviceLogins.code, code));
    const res = await app.inject({
      method: 'GET',
      url: `/auth/device/${code}`,
      headers: { authorization: `Bearer ${pollSecret}` },
    });
    assert.equal(res.statusCode, 401);
    assert.equal((await app.db.select().from(schema.deviceLogins)).length, 0);
    assert.equal(
      (await app.db.select().from(schema.devices)).length,
      0,
      'the orphaned device is deleted with the expired login',
    );
    // The user row stays: it is not the login's to delete.
    assert.equal((await app.db.select().from(schema.users)).length, 1);
  } finally {
    await app.close();
  }
});

test('authenticateBot accepts the shared secret and rejects anything else', async () => {
  const app = await testApp();
  try {
    assert.equal(typeof app.authenticateBot, 'function');
    assert.equal(typeof app.authenticateDevice, 'function');

    // Call the preHandler directly with a fake reply.
    const fakeReply = () => {
      const r = { statusCode: 200, body: undefined };
      r.code = (c) => ((r.statusCode = c), r);
      r.send = (b) => ((r.body = b), r);
      return r;
    };
    let reply = fakeReply();
    await app.authenticateBot({ headers: { authorization: 'Bearer test-bot-secret-0123456789' } }, reply);
    assert.equal(reply.statusCode, 200);
    assert.equal(reply.body, undefined);

    for (const authorization of [
      'Bearer wrong-secret-0123456789xx',
      'Bearer test-bot-secret-012345678',
      'test-bot-secret-0123456789',
      undefined,
    ]) {
      reply = fakeReply();
      await app.authenticateBot({ headers: { authorization } }, reply);
      assert.equal(reply.statusCode, 401, `should reject ${authorization}`);
      assert.deepEqual(reply.body, { error: 'unauthorized' });
    }
  } finally {
    await app.close();
  }
});
