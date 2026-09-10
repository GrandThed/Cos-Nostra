// Exercises createClient against a stub node:http server. Independent of the backend package:
// the stub records what it received and answers whatever each test tells it to.
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

import { createClient, ApiError } from '../src/index.js';

let server;
let baseUrl;
/** @type {{ method: string, url: string, headers: http.IncomingHttpHeaders, body: string }[]} */
let received = [];
/** @type {{ status: number, body?: unknown, raw?: string }} */
let answer = { status: 200, body: { ok: true } };

before(async () => {
  server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      received.push({ method: req.method, url: req.url, headers: req.headers, body });
      if (answer.raw !== undefined) {
        res.writeHead(answer.status, { 'content-type': 'text/plain' });
        res.end(answer.raw);
        return;
      }
      if (answer.body === undefined) {
        res.writeHead(answer.status);
        res.end();
        return;
      }
      res.writeHead(answer.status, { 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(answer.body));
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  baseUrl = `http://127.0.0.1:${server.address().port}/`; // trailing slash on purpose
});

after(() => new Promise((r) => server.close(r)));

beforeEach(() => {
  received = [];
  answer = { status: 200, body: { ok: true } };
});

const last = () => received.at(-1);

test('createClient requires baseUrl', () => {
  assert.throws(() => createClient({}), TypeError);
});

test('startDeviceLogin posts deviceName without auth', async () => {
  answer = { status: 200, body: { code: 'ABCD', verificationUrl: 'x', expiresIn: 600, interval: 5 } };
  const api = createClient({ baseUrl, token: 'dev-token' });
  const out = await api.startDeviceLogin('Gaming PC');
  assert.equal(out.code, 'ABCD');
  assert.equal(last().method, 'POST');
  assert.equal(last().url, '/auth/device');
  assert.deepEqual(JSON.parse(last().body), { deviceName: 'Gaming PC' });
  assert.equal(last().headers['content-type'], 'application/json');
  assert.equal(last().headers.authorization, undefined);
});

test('pollDeviceLogin encodes the code and sends no auth', async () => {
  answer = { status: 200, body: { status: 'pending' } };
  const api = createClient({ baseUrl, token: 'dev-token' });
  const out = await api.pollDeviceLogin('a b/c');
  assert.equal(out.status, 'pending');
  assert.equal(last().url, '/auth/device/a%20b%2Fc');
  assert.equal(last().headers.authorization, undefined);
});

test('user routes carry the device token as a bearer', async () => {
  const api = createClient({ baseUrl, token: 'dev-token' });
  await api.me();
  assert.equal(last().url, '/auth/me');
  assert.equal(last().headers.authorization, 'Bearer dev-token');
});

test('clip methods hit the documented paths', async () => {
  const api = createClient({ baseUrl, token: 't' });
  const body = {
    game: 'Rust',
    durationMs: 30000,
    width: 1920,
    height: 1080,
    sizeAv1: 1,
    sizeH264: 2,
    recordedAt: 'now',
  };
  await api.createClip(body);
  assert.equal(last().method, 'POST');
  assert.equal(last().url, '/clips');
  assert.deepEqual(JSON.parse(last().body), body);

  await api.completeClip('c1');
  assert.equal(last().method, 'POST');
  assert.equal(last().url, '/clips/c1/complete');
  assert.equal(last().body, '');

  await api.getClip('c1');
  assert.equal(last().method, 'GET');
  assert.equal(last().url, '/clips/c1');

  await api.listClips({ game: 'Rust', year: 2026, sort: 'top', cursor: undefined, limit: null });
  assert.equal(last().url, '/clips?game=Rust&year=2026&sort=top');

  await api.listClips();
  assert.equal(last().url, '/clips');

  await api.deleteClip('c1');
  assert.equal(last().method, 'DELETE');
  assert.equal(last().url, '/clips/c1');

  await api.rankings({ guild: '123', year: 2026 });
  assert.equal(last().url, '/rankings?guild=123&year=2026');
});

test('internal routes use botToken, not the user token', async () => {
  const api = createClient({ baseUrl, token: 'user-token', botToken: 'bot-secret' });
  await api.internalPost({ clipId: 'c1', guildId: 'g', channelId: 'ch', messageId: 'm' });
  assert.equal(last().method, 'POST');
  assert.equal(last().url, '/internal/posts');
  assert.equal(last().headers.authorization, 'Bearer bot-secret');

  await api.internalReaction({ messageId: 'm', userDiscordId: 'u', emoji: 'fire', removed: false });
  assert.equal(last().url, '/internal/reactions');
  assert.equal(JSON.parse(last().body).emoji, 'fire');
  assert.equal(last().headers.authorization, 'Bearer bot-secret');

  await api.internalClip('c1');
  assert.equal(last().method, 'GET');
  assert.equal(last().url, '/internal/clips/c1');
  assert.equal(last().headers.authorization, 'Bearer bot-secret');

  // Still works with only the bot token configured
  const botOnly = createClient({ baseUrl, botToken: 'bot-secret' });
  await botOnly.internalClip('c2');
  assert.equal(last().headers.authorization, 'Bearer bot-secret');
});

test('non-2xx throws ApiError with status and parsed body', async () => {
  answer = { status: 404, body: { statusCode: 404, error: 'Not Found', message: 'clip not found' } };
  const api = createClient({ baseUrl, token: 't' });
  await assert.rejects(api.getClip('nope'), (err) => {
    assert.ok(err instanceof ApiError);
    assert.equal(err.status, 404);
    assert.deepEqual(err.body, { statusCode: 404, error: 'Not Found', message: 'clip not found' });
    assert.equal(err.message, 'clip not found');
    return true;
  });
});

test('non-JSON error bodies are kept as text', async () => {
  answer = { status: 502, raw: 'bad gateway' };
  const api = createClient({ baseUrl, token: 't' });
  await assert.rejects(api.me(), (err) => {
    assert.equal(err.status, 502);
    assert.equal(err.body, 'bad gateway');
    return true;
  });
});

test('empty 204 responses resolve to null', async () => {
  answer = { status: 204 };
  const api = createClient({ baseUrl, token: 't' });
  assert.equal(await api.deleteClip('c1'), null);
});

test('a custom fetch is used when provided', async () => {
  const calls = [];
  const fakeFetch = async (url, init) => {
    calls.push({ url, init });
    return new Response(JSON.stringify({ id: 'u1' }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };
  const api = createClient({ baseUrl: 'https://example.test', token: 't', fetch: fakeFetch });
  const me = await api.me();
  assert.equal(me.id, 'u1');
  assert.equal(calls[0].url, 'https://example.test/auth/me');
  assert.equal(received.length, 0);
});
