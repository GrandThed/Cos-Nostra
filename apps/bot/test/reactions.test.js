// Unit tests for the reaction tracker. No gateway, no network: discord.js Client extends
// EventEmitter, so a bare EventEmitter with a `user` is enough to drive the handlers, and the
// backend and outbox are fakes that record what they were asked to do.
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { setTimeout as sleep } from 'node:timers/promises';

import { registerReactions, emojiKey } from '../src/reactions.js';

const FIRE = '\u{1F525}'; // written escaped so this file stays ASCII

/** Lets every pending handler run to completion: the fakes resolve on the microtask queue. */
async function flush(turns = 4) {
  for (let i = 0; i < turns; i++) await new Promise((resolve) => setImmediate(resolve));
}

/**
 * @param {object} [options]
 * @param {string[]} [options.known]  message ids the backend has a post row for
 * @param {(messageId: string) => unknown} [options.getPost]  overrides the answer entirely
 */
function setup({ known = ['m1'], getPost } = {}) {
  const client = new EventEmitter();
  client.user = { id: 'bot-1' };

  const calls = { getPost: [] };
  const order = [];
  const backend = {
    async getPost(messageId) {
      calls.getPost.push(messageId);
      order.push(`getPost:${messageId}`);
      if (getPost) return getPost(messageId);
      return known.includes(messageId) ? { clipId: 'clip-1', messageId, open: 0 } : null;
    },
  };

  const jobs = [];
  const outbox = {
    enqueue: (job) => jobs.push(job),
    size: () => jobs.length,
    drain: async () => {},
    stop: () => {},
  };

  // Same shape as the console logger index.js builds: one string per call.
  const logged = { debug: [], info: [], warn: [], error: [] };
  const log = {
    debug: (line) => logged.debug.push(line),
    info: (line) => logged.info.push(line),
    warn: (line) => logged.warn.push(line),
    error: (line) => logged.error.push(line),
  };

  registerReactions({ client, backend, outbox, log });
  return { client, backend, outbox, jobs, calls, logged, order };
}

/**
 * A stand-in for MessageReaction. `partial` flips to false when fetch() succeeds, exactly as
 * discord.js patches the structure.
 */
function makeReaction({
  messageId = 'm1',
  emoji = { id: null, name: FIRE },
  partial = false,
  messagePartial = false,
  fetchError = null,
  messageFetchError = null,
  order = [],
} = {}) {
  const message = {
    id: messageId,
    partial: messagePartial,
    async fetch() {
      order.push('message.fetch');
      if (messageFetchError) throw messageFetchError;
      message.partial = false;
      return message;
    },
  };
  const reaction = {
    emoji,
    message,
    partial,
    async fetch() {
      order.push('reaction.fetch');
      if (fetchError) throw fetchError;
      reaction.partial = false;
      message.partial = false; // MessageReaction#fetch fetches the message as well
      return reaction;
    },
  };
  return reaction;
}

const human = { id: 'user-9', bot: false };

test('an add on a known message enqueues the job the backend expects', async () => {
  const h = setup();
  h.client.emit('messageReactionAdd', makeReaction(), human);
  await flush();

  assert.deepEqual(h.jobs, [
    { messageId: 'm1', userDiscordId: 'user-9', emoji: FIRE, action: 'add' },
  ]);
  // The job is passed verbatim to backend.recordReaction, so it must carry nothing else.
  assert.deepEqual(Object.keys(h.jobs[0]).sort(), [
    'action',
    'emoji',
    'messageId',
    'userDiscordId',
  ]);
  // Accepted votes are logged at info with the message id, the emoji and the action.
  assert.equal(h.logged.info.length, 1);
  const line = h.logged.info.at(-1);
  assert.match(line, /\bm1\b/);
  assert.match(line, /\badd\b/);
  assert.ok(line.includes(FIRE), `emoji missing from the log line: ${line}`);
  assert.deepEqual(h.logged.warn, []);
  assert.deepEqual(h.logged.error, []);
});

test('a remove enqueues the same key with action remove', async () => {
  const h = setup();
  h.client.emit('messageReactionRemove', makeReaction(), human);
  await flush();

  assert.deepEqual(h.jobs, [
    { messageId: 'm1', userDiscordId: 'user-9', emoji: FIRE, action: 'remove' },
  ]);
});

test('an add and a remove of the same emoji produce the same emoji key', async () => {
  const h = setup();
  h.client.emit('messageReactionAdd', makeReaction({ emoji: { id: null, name: FIRE } }), human);
  h.client.emit('messageReactionRemove', makeReaction({ emoji: { id: null, name: FIRE } }), human);
  await flush();

  assert.equal(h.jobs.length, 2);
  assert.equal(h.jobs[0].emoji, h.jobs[1].emoji);
  assert.deepEqual(
    h.jobs.map((j) => j.action),
    ['add', 'remove'],
  );
});

test("the bot's own reaction is ignored", async () => {
  const h = setup();
  // The poster seeds emojis as the bot itself; those must never count as votes.
  h.client.emit('messageReactionAdd', makeReaction(), { id: 'bot-1', bot: true });
  await flush();

  assert.deepEqual(h.jobs, []);
  assert.deepEqual(h.calls.getPost, []);
});

test("another bot's reaction is ignored", async () => {
  const h = setup();
  h.client.emit('messageReactionAdd', makeReaction(), { id: 'other-bot', bot: true });
  await flush();

  assert.deepEqual(h.jobs, []);
  assert.deepEqual(h.calls.getPost, []);
});

test('a reaction on a message the backend does not know enqueues nothing', async () => {
  const h = setup({ known: ['m1'] });
  h.client.emit('messageReactionAdd', makeReaction({ messageId: 'chatter' }), human);
  await flush();

  assert.deepEqual(h.jobs, []);
  assert.deepEqual(h.calls.getPost, ['chatter']);
  assert.equal(h.logged.warn.length, 0, 'an unrelated message is a debug-level skip');
  assert.equal(h.logged.debug.length, 1);
});

test('a partial reaction is fetched before it is handled', async () => {
  const h = setup();
  const reaction = makeReaction({ partial: true, order: h.order });
  h.client.emit('messageReactionAdd', reaction, human);
  await flush();

  assert.equal(reaction.partial, false);
  assert.deepEqual(h.order, ['reaction.fetch', 'getPost:m1'], 'fetch happens before the lookup');
  assert.deepEqual(h.jobs, [
    { messageId: 'm1', userDiscordId: 'user-9', emoji: FIRE, action: 'add' },
  ]);
});

test('a partial message on a complete reaction is fetched too', async () => {
  const h = setup();
  const reaction = makeReaction({ messagePartial: true, order: h.order });
  h.client.emit('messageReactionAdd', reaction, human);
  await flush();

  assert.deepEqual(h.order, ['message.fetch', 'getPost:m1']);
  assert.equal(h.jobs.length, 1);
});

test('a reaction whose fetch rejects is skipped without throwing or rejecting', async () => {
  const unhandled = [];
  const onUnhandled = (err) => unhandled.push(err);
  process.on('unhandledRejection', onUnhandled);
  try {
    const h = setup();
    const reaction = makeReaction({
      partial: true,
      fetchError: new Error('Unknown Message'),
      order: h.order,
    });

    // The emit itself must not throw: discord.js calls listeners synchronously.
    assert.doesNotThrow(() => h.client.emit('messageReactionAdd', reaction, human));
    await flush();
    await sleep(20); // unhandledRejection fires a turn after the rejection

    assert.deepEqual(h.jobs, []);
    assert.deepEqual(h.calls.getPost, [], 'a failed fetch stops before the lookup');
    assert.equal(h.logged.warn.length, 1, 'a failed fetch is warned about');
    assert.deepEqual(unhandled, [], 'no unhandled rejection escaped the handler');
  } finally {
    process.off('unhandledRejection', onUnhandled);
  }
});

test('a failing message fetch is skipped the same way', async () => {
  const h = setup();
  const reaction = makeReaction({
    messagePartial: true,
    messageFetchError: new Error('Missing Access'),
  });
  assert.doesNotThrow(() => h.client.emit('messageReactionAdd', reaction, human));
  await flush();

  assert.deepEqual(h.jobs, []);
  assert.equal(h.logged.warn.length, 1);
});

test('repeated reactions on the same unknown message hit getPost once', async () => {
  const h = setup({ known: [] });
  for (let i = 0; i < 5; i++) {
    h.client.emit('messageReactionAdd', makeReaction({ messageId: 'chatter' }), {
      id: `user-${i}`,
      bot: false,
    });
    await flush(); // serial, so the cache is already warm for the next event
  }

  assert.deepEqual(h.calls.getPost, ['chatter'], 'the 404 is cached');
  assert.deepEqual(h.jobs, []);
});

test('repeated reactions on the same known message hit getPost once and still all count', async () => {
  const h = setup({ known: ['m1'] });
  for (let i = 0; i < 3; i++) {
    h.client.emit('messageReactionAdd', makeReaction(), { id: `user-${i}`, bot: false });
    await flush();
  }

  assert.deepEqual(h.calls.getPost, ['m1']);
  assert.equal(h.jobs.length, 3);
  assert.deepEqual(
    h.jobs.map((j) => j.userDiscordId),
    ['user-0', 'user-1', 'user-2'],
  );
});

test('a burst of reactions on one message shares a single lookup', async () => {
  // Five people react to a fresh clip in the same tick, before any answer has been cached.
  let resolveLookup;
  const h = setup({
    getPost: () => new Promise((resolve) => (resolveLookup = () => resolve({ clipId: 'c' }))),
  });

  for (let i = 0; i < 5; i++) {
    h.client.emit('messageReactionAdd', makeReaction(), { id: `user-${i}`, bot: false });
  }
  await flush();
  assert.deepEqual(h.calls.getPost, ['m1'], 'in-flight lookups are coalesced');

  resolveLookup();
  await flush();
  assert.equal(h.jobs.length, 5, 'every vote in the burst is still reported');
  assert.deepEqual(h.calls.getPost, ['m1']);
});

test('a burst that fails is not cached and the next reaction asks again', async () => {
  const unhandled = [];
  const onUnhandled = (err) => unhandled.push(err);
  process.on('unhandledRejection', onUnhandled);
  try {
    let fail;
    const h = setup({
      getPost: () => new Promise((_resolve, reject) => (fail = () => reject(new Error('boom')))),
    });
    for (let i = 0; i < 3; i++) {
      h.client.emit('messageReactionAdd', makeReaction(), { id: `user-${i}`, bot: false });
    }
    await flush();
    fail(); // one rejection, three awaiters, plus the internal cleanup handler
    await flush();
    await sleep(20);

    assert.deepEqual(h.jobs, []);
    assert.equal(h.logged.warn.length, 3, 'each skipped reaction says so once');
    assert.deepEqual(unhandled, [], 'the shared lookup does not leak an unhandled rejection');

    // The failed lookup left nothing behind, neither cached nor in flight.
    h.client.emit('messageReactionAdd', makeReaction(), human);
    await flush();
    assert.equal(h.calls.getPost.length, 2);
  } finally {
    process.off('unhandledRejection', onUnhandled);
  }
});

test('the cache is bounded: the oldest message id is evicted', async () => {
  const h = setup({ known: [] });
  const cap = 500;
  for (let i = 0; i <= cap; i++) {
    h.client.emit('messageReactionAdd', makeReaction({ messageId: `x${i}` }), human);
    await flush(1);
  }
  await flush();
  assert.equal(h.calls.getPost.length, cap + 1);

  // x0 was pushed out by x500, so it is looked up again.
  h.client.emit('messageReactionAdd', makeReaction({ messageId: 'x0' }), human);
  await flush();
  assert.equal(h.calls.getPost.length, cap + 2);

  // The most recent id is still cached, so it is not.
  h.client.emit('messageReactionAdd', makeReaction({ messageId: `x${cap}` }), human);
  await flush();
  assert.equal(h.calls.getPost.length, cap + 2);
});

test('a cached 404 expires so a post registered later still counts', async () => {
  mock.timers.enable({ apis: ['Date'], now: 0 });
  try {
    let registered = false;
    const h = setup({ getPost: () => (registered ? { clipId: 'clip-1' } : null) });

    h.client.emit('messageReactionAdd', makeReaction(), human);
    await flush();
    assert.deepEqual(h.jobs, []);

    registered = true; // the bot's POST /internal/posts landed just after the reaction
    mock.timers.tick(61_000);
    h.client.emit('messageReactionAdd', makeReaction(), human);
    await flush();

    assert.equal(h.calls.getPost.length, 2);
    assert.equal(h.jobs.length, 1);
  } finally {
    mock.timers.reset();
  }
});

test('a custom emoji is stable and distinct from a unicode emoji of the same name', async () => {
  const h = setup();
  const custom = { id: '112233', name: 'pog', animated: false };
  const animatedSamePayload = { id: '112233', name: 'pog' }; // remove payloads omit `animated`
  const unicode = { id: null, name: 'pog' };

  h.client.emit('messageReactionAdd', makeReaction({ emoji: custom }), human);
  h.client.emit('messageReactionRemove', makeReaction({ emoji: animatedSamePayload }), human);
  h.client.emit('messageReactionAdd', makeReaction({ emoji: unicode }), human);
  await flush();

  assert.deepEqual(
    h.jobs.map((j) => j.emoji),
    ['pog:112233', 'pog:112233', 'pog'],
  );
  assert.notEqual(h.jobs[0].emoji, h.jobs[2].emoji);
});

test('emojiKey covers the shapes Discord sends', () => {
  assert.equal(emojiKey({ id: null, name: FIRE }), FIRE);
  assert.equal(emojiKey({ id: '1', name: 'pog' }), 'pog:1');
  // An animated custom emoji must key like the non-animated payload of the same emoji, which is
  // why emoji.identifier (which prefixes "a:") is not used.
  assert.equal(emojiKey({ id: '1', name: 'pog', animated: true }), 'pog:1');
  assert.equal(emojiKey({ id: '1', name: null }), '1', 'a deleted custom emoji still pairs');
  assert.equal(emojiKey({ id: null, name: null }), null);
  assert.equal(emojiKey(undefined), null);
});

test('a reaction with no usable emoji is skipped, never enqueued', async () => {
  const h = setup();
  h.client.emit('messageReactionAdd', makeReaction({ emoji: { id: null, name: null } }), human);
  await flush();

  assert.deepEqual(h.jobs, []);
  assert.equal(h.logged.warn.length, 1);
});

test('a thrown 404 counts as an unknown message and is cached like a null', async () => {
  // The real backend.js does not return null for an unknown message: it lets the shared
  // client's ApiError through, so this is the contract that runs in production.
  const notFound = Object.assign(new Error('API request failed with status 404'), {
    name: 'ApiError',
    status: 404,
    body: { error: 'unknown_message' },
  });
  const h = setup({
    getPost: () => {
      throw notFound;
    },
  });

  for (let i = 0; i < 3; i++) {
    h.client.emit('messageReactionAdd', makeReaction({ messageId: 'chatter' }), human);
    await flush();
  }

  assert.deepEqual(h.jobs, []);
  assert.deepEqual(h.calls.getPost, ['chatter'], 'the thrown 404 is cached, not retried');
  assert.equal(h.logged.warn.length, 0, 'an unrelated message must not log a warning per event');
  assert.equal(h.logged.debug.length, 3);
});

test('a backend failure other than 404 skips the reaction and is not cached', async () => {
  // A deploy answers 502 for a minute. That is not "unknown message", so nothing is cached.
  const h = setup({
    getPost: () => {
      throw Object.assign(new Error('API request failed with status 502'), {
        name: 'ApiError',
        status: 502,
      });
    },
  });
  h.client.emit('messageReactionAdd', makeReaction(), human);
  await flush();
  assert.deepEqual(h.jobs, []);
  assert.equal(h.logged.warn.length, 1);

  // Nothing was cached, so the next reaction asks again instead of inheriting the failure.
  h.client.emit('messageReactionAdd', makeReaction(), human);
  await flush();
  assert.equal(h.calls.getPost.length, 2);
});

test('registerReactions attaches both handlers and validates its dependencies', () => {
  const client = new EventEmitter();
  client.user = { id: 'bot-1' };
  const deps = { client, backend: { getPost: async () => null }, outbox: { enqueue: () => {} } };

  registerReactions(deps); // log is optional
  assert.equal(client.listenerCount('messageReactionAdd'), 1);
  assert.equal(client.listenerCount('messageReactionRemove'), 1);

  assert.throws(() => registerReactions({ ...deps, client: undefined }), TypeError);
  assert.throws(() => registerReactions({ ...deps, backend: {} }), TypeError);
  assert.throws(() => registerReactions({ ...deps, outbox: {} }), TypeError);
});

test('a client that has not logged in yet does not break the bot check', async () => {
  const client = new EventEmitter();
  client.user = null; // before clientReady
  const jobs = [];
  registerReactions({
    client,
    backend: { getPost: async () => ({ clipId: 'clip-1' }) },
    outbox: { enqueue: (job) => jobs.push(job) },
    log: undefined,
  });

  client.emit('messageReactionAdd', makeReaction(), human);
  await flush();
  assert.equal(jobs.length, 1);
});
