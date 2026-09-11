// Exercises the poster against fake discord.js and backend objects. Nothing here touches
// the gateway or the network: the client is a plain object with a channels.fetch, the
// backend is a plain object with the three methods post.js uses, and fetch is injected.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AttachmentBuilder } from 'discord.js';

import { createPoster, uploadLimitBytes } from '../src/post.js';

const MB = 1024 * 1024;

/**
 * @param {object} [overrides]
 * @returns {import('../src/post.js').Clip}
 */
function makeClip(overrides = {}) {
  return {
    id: 'clip1',
    game: 'Valorant',
    title: 'Ace on Ascent',
    durationMs: 27_400,
    sizeH264: 27 * MB,
    recordedAt: '2026-09-10T12:00:00.000Z',
    owner: { discordId: '4242', username: 'benja' },
    urls: {
      h264: 'https://cosnostra.test/clips/clip1/h264',
      thumb: 'https://cosnostra.test/clips/clip1/thumb',
      page: 'https://cosnostra.test/c/clip1',
    },
    ...overrides,
  };
}

/**
 * @param {string} id
 * @param {{ failEmojis?: string[] }} [opts]
 */
function makeMessage(id, { failEmojis = [] } = {}) {
  return {
    id,
    /** emojis that were accepted, in order */
    reacted: [],
    /** every emoji react() was called with, including the ones that threw */
    attempted: [],
    async react(emoji) {
      this.attempted.push(emoji);
      if (failEmojis.includes(emoji)) throw new Error(`unusable emoji ${emoji}`);
      this.reacted.push(emoji);
      return { emoji };
    },
  };
}

/**
 * @param {object} opts
 * @param {string} opts.channelId
 * @param {string} opts.guildId
 * @param {number} [opts.premiumTier]
 * @param {boolean} [opts.textBased]
 * @param {string} [opts.messageId]
 * @param {string[]} [opts.failEmojis]
 */
function makeChannel({
  channelId,
  guildId,
  premiumTier = 0,
  textBased = true,
  messageId = `msg-${channelId}`,
  failEmojis = [],
}) {
  return {
    id: channelId,
    guild: { id: guildId, premiumTier },
    isTextBased: () => textBased,
    /** @type {any[]} */
    sent: [],
    /** @type {any[]} */
    messages: [],
    async send(payload) {
      this.sent.push(payload);
      const message = makeMessage(messageId, { failEmojis });
      this.messages.push(message);
      return message;
    },
  };
}

/**
 * Fake discord.js client. `channels` maps a channel id to the channel to resolve, or to an
 * Error to make the fetch reject the way a missing-access fetch does.
 * @param {Record<string, any>} channels
 */
function client(channels) {
  /** @type {string[]} */
  const fetched = [];
  return {
    fetched,
    channels: {
      /** @param {string} channelId */
      async fetch(channelId) {
        fetched.push(channelId);
        const entry = channels[channelId];
        if (entry instanceof Error) throw entry;
        return entry ?? null;
      },
    },
  };
}

/**
 * @param {object} opts
 * @param {import('../src/post.js').Clip | null} opts.clip
 * @param {any[]} [opts.guilds]
 * @param {Error} [opts.recordPostError]
 */
function makeBackend({ clip, guilds = [], recordPostError }) {
  return {
    calls: {
      /** @type {string[]} */ getClip: [],
      /** @type {number} */ listGuilds: 0,
      /** @type {any[]} */ recordPost: [],
    },
    async getClip(clipId) {
      this.calls.getClip.push(clipId);
      return clip;
    },
    async listGuilds() {
      this.calls.listGuilds += 1;
      return { items: guilds };
    },
    async recordPost(post) {
      this.calls.recordPost.push(post);
      if (recordPostError) throw recordPostError;
      return { id: this.calls.recordPost.length };
    },
  };
}

/** Collects log lines so a test can assert a warning happened. */
function makeLog() {
  const lines = { info: [], warn: [], error: [] };
  return {
    lines,
    info: (m) => lines.info.push(String(m)),
    warn: (m) => lines.warn.push(String(m)),
    error: (m) => lines.error.push(String(m)),
  };
}

/** @param {{ ok?: boolean, status?: number, body?: Uint8Array }} [answer] */
function makeFetch(answer = {}) {
  const { ok = true, status = 200, body = new Uint8Array([1, 2, 3, 4]) } = answer;
  /** @type {string[]} */
  const calls = [];
  const fn = async (url) => {
    calls.push(String(url));
    return { ok, status, arrayBuffer: async () => body.buffer.slice(0) };
  };
  fn.calls = calls;
  return fn;
}

test('uploadLimitBytes returns the documented limit per boost tier', () => {
  assert.equal(uploadLimitBytes(0), 10 * MB);
  assert.equal(uploadLimitBytes(1), 10 * MB);
  assert.equal(uploadLimitBytes(2), 50 * MB);
  assert.equal(uploadLimitBytes(3), 100 * MB);
  // Unknown or missing tiers fall back to the safe floor rather than over-promising.
  assert.equal(uploadLimitBytes(undefined), 10 * MB);
  assert.equal(uploadLimitBytes(9), 10 * MB);
});

test('an unknown clip is a warning, not an error, and posts nothing', async () => {
  const log = makeLog();
  const backend = makeBackend({ clip: null, guilds: [{ guildId: 'g1', channelId: 'c1', seedEmojis: [] }] });
  const poster = createPoster({ client: client({}), backend, log, fetch: makeFetch() });

  const posted = await poster.postClip('gone');

  assert.deepEqual(posted, []);
  assert.deepEqual(backend.calls.getClip, ['gone']);
  assert.equal(backend.calls.listGuilds, 0);
  assert.equal(backend.calls.recordPost.length, 0);
  assert.equal(log.lines.warn.length, 1);
  assert.match(log.lines.warn[0], /unknown to the backend/);
});

test('a small clip in a tier 3 guild is posted as an H.264 attachment', async () => {
  const clip = makeClip({ sizeH264: 2 * MB });
  const channel = makeChannel({ channelId: 'c1', guildId: 'g1', premiumTier: 3, messageId: 'm1' });
  const backend = makeBackend({
    clip,
    guilds: [{ guildId: 'g1', channelId: 'c1', seedEmojis: [] }],
  });
  const fetchStub = makeFetch({ body: new Uint8Array([9, 8, 7]) });
  const poster = createPoster({ client: client({ c1: channel }), backend, log: makeLog(), fetch: fetchStub });

  const posted = await poster.postClip('clip1');

  assert.deepEqual(posted, [{ guildId: 'g1', channelId: 'c1', messageId: 'm1' }]);
  assert.deepEqual(fetchStub.calls, [clip.urls.h264]);
  const payload = channel.sent[0];
  assert.equal(payload.embeds, undefined);
  assert.equal(payload.files.length, 1);
  const file = payload.files[0];
  assert.ok(file instanceof AttachmentBuilder);
  assert.equal(file.name, 'valorant-clip1.mp4');
  assert.deepEqual([...file.attachment], [9, 8, 7]);
  assert.deepEqual(backend.calls.recordPost, [
    { clipId: 'clip1', guildId: 'g1', channelId: 'c1', messageId: 'm1' },
  ]);
});

test('a 27 MB clip in a tier 0 guild is posted as an embed with the player link', async () => {
  const clip = makeClip();
  const channel = makeChannel({ channelId: 'c1', guildId: 'g1', premiumTier: 0, messageId: 'm1' });
  const backend = makeBackend({
    clip,
    guilds: [{ guildId: 'g1', channelId: 'c1', seedEmojis: [] }],
  });
  const fetchStub = makeFetch();
  const poster = createPoster({ client: client({ c1: channel }), backend, log: makeLog(), fetch: fetchStub });

  const posted = await poster.postClip('clip1');

  assert.equal(posted.length, 1);
  assert.deepEqual(fetchStub.calls, [], 'the link path must not download the video');
  const payload = channel.sent[0];
  assert.equal(payload.files, undefined);
  // No embed of our own: Discord drops the link preview on any message that carries one,
  // and that preview is the video player. This is the whole point of the link path.
  assert.equal(payload.embeds, undefined, 'an embed here would suppress Discord’s player');
  assert.ok(
    payload.content.includes(clip.urls.page),
    `content ${JSON.stringify(payload.content)} must carry the player URL`,
  );
  assert.ok(
    !payload.content.includes(`<${clip.urls.page}>`),
    'the URL must not be wrapped in angle brackets, which suppresses the preview',
  );
  assert.ok(payload.content.includes('Ace on Ascent'), 'content still names the clip');
  assert.ok(payload.content.includes('benja'), 'content still names the owner');
});

test('the safety margin keeps a clip just under the raw limit off the attachment path', async () => {
  // 9.8 MB is under the 10 MB tier 0 limit but over the 95% margin, so it must go as a link.
  const clip = makeClip({ sizeH264: Math.round(9.8 * MB) });
  const channel = makeChannel({ channelId: 'c1', guildId: 'g1', premiumTier: 0 });
  const backend = makeBackend({ clip, guilds: [{ guildId: 'g1', channelId: 'c1', seedEmojis: [] }] });
  const fetchStub = makeFetch();
  const poster = createPoster({ client: client({ c1: channel }), backend, log: makeLog(), fetch: fetchStub });

  await poster.postClip('clip1');

  assert.equal(channel.sent[0].files, undefined);
  assert.equal(channel.sent[0].embeds, undefined);
  assert.ok(channel.sent[0].content.includes(clip.urls.page));
  assert.deepEqual(fetchStub.calls, []);
});

test('two configured guilds get two messages and two recordPost calls', async () => {
  const clip = makeClip({ sizeH264: 2 * MB });
  const a = makeChannel({ channelId: 'c1', guildId: 'g1', premiumTier: 3, messageId: 'm1' });
  const b = makeChannel({ channelId: 'c2', guildId: 'g2', premiumTier: 3, messageId: 'm2' });
  const backend = makeBackend({
    clip,
    guilds: [
      { guildId: 'g1', channelId: 'c1', seedEmojis: [] },
      { guildId: 'g2', channelId: 'c2', seedEmojis: [] },
    ],
  });
  const fetchStub = makeFetch();
  const poster = createPoster({
    client: client({ c1: a, c2: b }),
    backend,
    log: makeLog(),
    fetch: fetchStub,
  });

  const posted = await poster.postClip('clip1');

  assert.deepEqual(posted, [
    { guildId: 'g1', channelId: 'c1', messageId: 'm1' },
    { guildId: 'g2', channelId: 'c2', messageId: 'm2' },
  ]);
  assert.equal(a.sent.length, 1);
  assert.equal(b.sent.length, 1);
  assert.deepEqual(backend.calls.recordPost.map((p) => p.messageId), ['m1', 'm2']);
  assert.equal(fetchStub.calls.length, 1, 'the video is downloaded once and reused per post');
});

test('a channel that fails to fetch is skipped and the other guild still gets the clip', async () => {
  const clip = makeClip();
  const good = makeChannel({ channelId: 'c2', guildId: 'g2', messageId: 'm2' });
  const backend = makeBackend({
    clip,
    guilds: [
      { guildId: 'g1', channelId: 'c1', seedEmojis: [] },
      { guildId: 'g2', channelId: 'c2', seedEmojis: [] },
    ],
  });
  const log = makeLog();
  const poster = createPoster({
    client: client({ c1: new Error('Missing Access'), c2: good }),
    backend,
    log,
    fetch: makeFetch(),
  });

  const posted = await poster.postClip('clip1');

  assert.deepEqual(posted, [{ guildId: 'g2', channelId: 'c2', messageId: 'm2' }]);
  assert.equal(backend.calls.recordPost.length, 1);
  assert.ok(log.lines.warn.some((l) => l.includes('c1') && l.includes('Missing Access')));
});

test('a channel that is not text based is skipped', async () => {
  const clip = makeClip();
  const voice = makeChannel({ channelId: 'c1', guildId: 'g1', textBased: false });
  const backend = makeBackend({ clip, guilds: [{ guildId: 'g1', channelId: 'c1', seedEmojis: [] }] });
  const log = makeLog();
  const poster = createPoster({ client: client({ c1: voice }), backend, log, fetch: makeFetch() });

  const posted = await poster.postClip('clip1');

  assert.deepEqual(posted, []);
  assert.equal(voice.sent.length, 0);
  assert.equal(backend.calls.recordPost.length, 0);
  assert.ok(log.lines.warn.some((l) => l.includes('not a text channel')));
});

test('a missing channel (fetch resolves null) is skipped', async () => {
  const clip = makeClip();
  const backend = makeBackend({ clip, guilds: [{ guildId: 'g1', channelId: 'gone', seedEmojis: [] }] });
  const log = makeLog();
  const poster = createPoster({ client: client({}), backend, log, fetch: makeFetch() });

  assert.deepEqual(await poster.postClip('clip1'), []);
  assert.ok(log.lines.warn.some((l) => l.includes('missing or not a text channel')));
});

test('a rejecting recordPost still reports the message that was posted', async () => {
  const clip = makeClip();
  const channel = makeChannel({ channelId: 'c1', guildId: 'g1', messageId: 'm1' });
  const backend = makeBackend({
    clip,
    guilds: [{ guildId: 'g1', channelId: 'c1', seedEmojis: ['\u{1F525}'] }],
    recordPostError: new Error('backend deploying'),
  });
  const log = makeLog();
  const poster = createPoster({ client: client({ c1: channel }), backend, log, fetch: makeFetch() });

  const posted = await poster.postClip('clip1');

  assert.deepEqual(posted, [{ guildId: 'g1', channelId: 'c1', messageId: 'm1' }]);
  assert.ok(log.lines.error.some((l) => l.includes('recordPost failed')));
  // The rest of the guild's work still ran.
  assert.deepEqual(channel.messages[0].reacted, ['\u{1F525}']);
});

test('seed emojis are added in order and one unusable emoji does not stop the others', async () => {
  const clip = makeClip();
  const seeds = ['\u{1F525}', '<:notmine:123>', '\u{1F602}'];
  const channel = makeChannel({
    channelId: 'c1',
    guildId: 'g1',
    messageId: 'm1',
    failEmojis: ['<:notmine:123>'],
  });
  const backend = makeBackend({ clip, guilds: [{ guildId: 'g1', channelId: 'c1', seedEmojis: seeds }] });
  const log = makeLog();
  const poster = createPoster({ client: client({ c1: channel }), backend, log, fetch: makeFetch() });

  const posted = await poster.postClip('clip1');

  assert.equal(posted.length, 1);
  const message = channel.messages[0];
  assert.deepEqual(message.attempted, seeds, 'every configured emoji is attempted');
  assert.deepEqual(message.reacted, ['\u{1F525}', '\u{1F602}']);
  assert.ok(log.lines.warn.some((l) => l.includes('<:notmine:123>')));
});

test('a guild with no seedEmojis field posts without reacting', async () => {
  const clip = makeClip();
  const channel = makeChannel({ channelId: 'c1', guildId: 'g1', messageId: 'm1' });
  const backend = makeBackend({ clip, guilds: [{ guildId: 'g1', channelId: 'c1' }] });
  const poster = createPoster({ client: client({ c1: channel }), backend, log: makeLog(), fetch: makeFetch() });

  assert.equal((await poster.postClip('clip1')).length, 1);
  assert.deepEqual(channel.messages[0].attempted, []);
});

test('a failed H.264 download falls back to the embed instead of losing the post', async () => {
  const clip = makeClip({ sizeH264: 2 * MB });
  const channel = makeChannel({ channelId: 'c1', guildId: 'g1', premiumTier: 3, messageId: 'm1' });
  const backend = makeBackend({ clip, guilds: [{ guildId: 'g1', channelId: 'c1', seedEmojis: [] }] });
  const log = makeLog();
  const poster = createPoster({
    client: client({ c1: channel }),
    backend,
    log,
    fetch: makeFetch({ ok: false, status: 502 }),
  });

  const posted = await poster.postClip('clip1');

  assert.deepEqual(posted, [{ guildId: 'g1', channelId: 'c1', messageId: 'm1' }]);
  assert.equal(channel.sent[0].files, undefined);
  assert.equal(channel.sent[0].embeds, undefined);
  assert.ok(channel.sent[0].content.includes(clip.urls.page));
  assert.ok(log.lines.warn.some((l) => l.includes('502')));
});

// One clip, two guilds, two different paths: 27 MB is under tier 3's 100 MB limit and over
// tier 0's 10 MB one, which is exactly the per-guild decision the poster has to make.
test('the same clip attaches in a tier 3 guild and embeds in a tier 0 guild', async () => {
  const clip = makeClip({ title: null, game: null, sizeH264: 27 * MB, durationMs: 3_723_000 });
  const tier3 = makeChannel({ channelId: 'c1', guildId: 'g1', premiumTier: 3, messageId: 'm1' });
  const tier0 = makeChannel({ channelId: 'c2', guildId: 'g2', premiumTier: 0, messageId: 'm2' });
  const backend = makeBackend({
    clip,
    guilds: [
      { guildId: 'g1', channelId: 'c1', seedEmojis: [] },
      { guildId: 'g2', channelId: 'c2', seedEmojis: [] },
    ],
  });
  const poster = createPoster({
    client: client({ c1: tier3, c2: tier0 }),
    backend,
    log: makeLog(),
    fetch: makeFetch(),
  });

  await poster.postClip('clip1');

  // No game to name the file after, so the clip id carries it.
  assert.equal(tier3.sent[0].files.length, 1);
  assert.equal(tier3.sent[0].files[0].name, 'clip1.mp4');
  assert.equal(tier3.sent[0].embeds, undefined);

  // The tier 0 guild gets the bare player link so Discord can build the video preview,
  // while the tier 3 guild's attachment keeps its link wrapped to avoid a second player.
  assert.equal(tier0.sent[0].files, undefined);
  assert.equal(tier0.sent[0].embeds, undefined);
  assert.ok(tier0.sent[0].content.includes(clip.urls.page));
  assert.ok(!tier0.sent[0].content.includes(`<${clip.urls.page}>`));
  assert.ok(tier3.sent[0].content.includes(`<${clip.urls.page}>`));
});

test('no configured guilds is a no-op', async () => {
  const backend = makeBackend({ clip: makeClip(), guilds: [] });
  const log = makeLog();
  const poster = createPoster({ client: client({}), backend, log, fetch: makeFetch() });

  assert.deepEqual(await poster.postClip('clip1'), []);
  assert.equal(backend.calls.recordPost.length, 0);
  assert.ok(log.lines.warn.some((l) => l.includes('no guild')));
});

test('a send that is refused by Discord does not abort the other guild', async () => {
  const clip = makeClip();
  const denied = makeChannel({ channelId: 'c1', guildId: 'g1' });
  denied.send = async () => {
    throw new Error('Missing Permissions');
  };
  const good = makeChannel({ channelId: 'c2', guildId: 'g2', messageId: 'm2' });
  const backend = makeBackend({
    clip,
    guilds: [
      { guildId: 'g1', channelId: 'c1', seedEmojis: [] },
      { guildId: 'g2', channelId: 'c2', seedEmojis: [] },
    ],
  });
  const log = makeLog();
  const poster = createPoster({
    client: client({ c1: denied, c2: good }),
    backend,
    log,
    fetch: makeFetch(),
  });

  const posted = await poster.postClip('clip1');

  assert.deepEqual(posted, [{ guildId: 'g2', channelId: 'c2', messageId: 'm2' }]);
  assert.deepEqual(backend.calls.recordPost.map((p) => p.guildId), ['g2']);
  assert.ok(log.lines.error.some((l) => l.includes('g1') && l.includes('Missing Permissions')));
});

test('a guild whose clip channel is not set up yet is skipped without a fetch', async () => {
  const clip = makeClip();
  const good = makeChannel({ channelId: 'c2', guildId: 'g2', messageId: 'm2' });
  const backend = makeBackend({
    clip,
    guilds: [
      { guildId: 'g1', channelId: null, seedEmojis: [] },
      { guildId: 'g2', channelId: 'c2', seedEmojis: [] },
    ],
  });
  const log = makeLog();
  const fake = client({ c2: good });
  const poster = createPoster({ client: fake, backend, log, fetch: makeFetch() });

  const posted = await poster.postClip('clip1');

  assert.deepEqual(posted, [{ guildId: 'g2', channelId: 'c2', messageId: 'm2' }]);
  assert.deepEqual(fake.fetched, ['c2'], 'a null channelId is never handed to channels.fetch');
  assert.ok(log.lines.warn.some((l) => l.includes('no clip channel')));
});

test('listGuilds answering a bare array is handled as well as { items }', async () => {
  // GET /internal/guilds returns { items }, but the shared client types it as an array;
  // whichever shape shows up must not turn posting into a silent no-op.
  const clip = makeClip();
  const channel = makeChannel({ channelId: 'c1', guildId: 'g1', messageId: 'm1' });
  const backend = makeBackend({ clip });
  backend.listGuilds = async () => [{ guildId: 'g1', channelId: 'c1', seedEmojis: [] }];
  const poster = createPoster({ client: client({ c1: channel }), backend, log: makeLog(), fetch: makeFetch() });

  assert.deepEqual(await poster.postClip('clip1'), [
    { guildId: 'g1', channelId: 'c1', messageId: 'm1' },
  ]);
});

test('a clip that cannot be loaded rejects so the caller can retry the whole post', async () => {
  const backend = makeBackend({ clip: null });
  backend.getClip = async () => {
    throw new Error('backend down');
  };
  const poster = createPoster({ client: client({}), backend, log: makeLog(), fetch: makeFetch() });

  await assert.rejects(() => poster.postClip('clip1'), /backend down/);
});
