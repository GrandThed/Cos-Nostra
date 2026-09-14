// Exercises the poster against fake discord.js and backend objects. Nothing here touches
// the gateway or the network: the client is a plain object with a channels.fetch, the
// backend is a plain object with the three methods post.js uses, and fetch is injected.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AttachmentBuilder } from 'discord.js';

import { createPoster, mentionedIds, uploadLimitBytes } from '../src/post.js';

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
    participants: [],
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
 * A Discord error shaped the way discord.js throws one: the JSON error code on `.code`.
 * @param {string} message
 * @param {number} code
 */
function discordError(message, code) {
  return Object.assign(new Error(message), { code });
}

/**
 * Fake guild whose members.fetch knows `members`, answers Unknown Member (10007) for anyone
 * else, or throws `error` for everyone. Every fetch is recorded.
 * @param {{ members?: string[], error?: Error }} [opts]
 */
function makeGuild({ members = [], error } = {}) {
  /** @type {any[]} */
  const memberFetches = [];
  return {
    memberFetches,
    members: {
      async fetch(options) {
        memberFetches.push(options);
        if (error) throw error;
        const user = typeof options === 'string' ? options : options?.user;
        if (members.includes(user)) return { id: user };
        throw discordError('Unknown Member', 10007);
      },
    },
  };
}

/**
 * Fake discord.js client. `channels` maps a channel id to the channel to resolve, or to an
 * Error to make the fetch reject the way a missing-access fetch does. `guilds` is the guild
 * cache; a guild missing from it is not fetchable either.
 * @param {Record<string, any>} channels
 * @param {Record<string, ReturnType<typeof makeGuild>>} [guilds]
 */
function client(channels, guilds = {}) {
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
    guilds: {
      cache: new Map(Object.entries(guilds)),
      /** @param {string} guildId */
      async fetch(guildId) {
        throw discordError(`Unknown Guild ${guildId}`, 10004);
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
  // The owner is a real mention now, not the stored username: it pings, it renders the
  // nickname each reader knows, and it survives a rename.
  assert.ok(payload.content.includes('<@4242>'), 'content mentions the owner');
  // A guild with no stored language gets Spanish, the community default.
  assert.ok(payload.content.startsWith('Ace on Ascent - por <@4242>'), payload.content);
});

test('the message is written in each guild own language', async () => {
  const clip = makeClip();
  const spanish = makeChannel({ channelId: 'c1', guildId: 'g1', premiumTier: 0, messageId: 'm1' });
  const english = makeChannel({ channelId: 'c2', guildId: 'g2', premiumTier: 0, messageId: 'm2' });
  const backend = makeBackend({
    clip,
    guilds: [
      { guildId: 'g1', channelId: 'c1', seedEmojis: [], locale: 'es' },
      { guildId: 'g2', channelId: 'c2', seedEmojis: [], locale: 'en' },
    ],
  });
  const poster = createPoster({
    client: client({ c1: spanish, c2: english }),
    backend,
    log: makeLog(),
    fetch: makeFetch(),
  });

  await poster.postClip('clip1');

  // One clip, one postClip call, two languages: the locale belongs to the destination.
  assert.ok(spanish.sent[0].content.startsWith('Ace on Ascent - por <@4242>'));
  assert.ok(english.sent[0].content.startsWith('Ace on Ascent - by <@4242>'));
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

// ---- mentions ----------------------------------------------------------------------------

test('mentionedIds is the owner plus the voice channel, deduped', () => {
  const clip = makeClip({ participants: ['99', '100'] });
  assert.deepEqual(mentionedIds(clip, { tagVoiceMembers: true }), ['4242', '99', '100']);
  // Undefined is on: it is what a guild that has never touched the setting looks like, and
  // the backend column defaults to true.
  assert.deepEqual(mentionedIds(clip, {}), ['4242', '99', '100']);
  assert.deepEqual(mentionedIds(clip, undefined), ['4242', '99', '100']);
  // Off drops the participants and keeps the owner: the owner is not a "voice member".
  assert.deepEqual(mentionedIds(clip, { tagVoiceMembers: false }), ['4242']);
});

test('mentionedIds never lists anyone twice or lists a non-id', () => {
  // The desktop app builds `participants` from the bot's own voice snapshot, which excludes
  // the recorder - but a duplicate here would mean the same person pinged twice in one line.
  const clip = makeClip({ participants: ['99', '4242', '99'] });
  assert.deepEqual(mentionedIds(clip, {}), ['4242', '99']);

  assert.deepEqual(mentionedIds(makeClip({ participants: undefined }), {}), ['4242']);
  assert.deepEqual(
    mentionedIds(makeClip({ participants: ['', null, undefined, 7, '99'] }), {}),
    ['4242', '99'],
    'anything that is not a snowflake string would make discord.js throw at send time',
  );
  assert.deepEqual(mentionedIds(makeClip({ owner: { username: 'benja' }, participants: ['99'] }), {}), [
    '99',
  ]);
});

test('the post mentions the people who were in voice, in the guild language', async () => {
  const clip = makeClip({ participants: ['99', '100'] });
  const spanish = makeChannel({ channelId: 'c1', guildId: 'g1', messageId: 'm1' });
  const english = makeChannel({ channelId: 'c2', guildId: 'g2', messageId: 'm2' });
  const backend = makeBackend({
    clip,
    guilds: [
      { guildId: 'g1', channelId: 'c1', seedEmojis: [] },
      { guildId: 'g2', channelId: 'c2', seedEmojis: [], locale: 'en' },
    ],
  });
  const poster = createPoster({
    client: client({ c1: spanish, c2: english }),
    backend,
    log: makeLog(),
    fetch: makeFetch(),
  });

  await poster.postClip('clip1');

  assert.ok(
    spanish.sent[0].content.startsWith('Ace on Ascent - por <@4242> con <@99> <@100>'),
    spanish.sent[0].content,
  );
  assert.ok(
    english.sent[0].content.startsWith('Ace on Ascent - by <@4242> with <@99> <@100>'),
    english.sent[0].content,
  );
  assert.deepEqual(spanish.sent[0].allowedMentions, { parse: [], users: ['4242', '99', '100'] });
});

test('a guild with tagVoiceMembers off mentions only the owner', async () => {
  const clip = makeClip({ participants: ['99', '100'] });
  const channel = makeChannel({ channelId: 'c1', guildId: 'g1', messageId: 'm1' });
  const backend = makeBackend({
    clip,
    guilds: [{ guildId: 'g1', channelId: 'c1', seedEmojis: [], tagVoiceMembers: false }],
  });
  const poster = createPoster({
    client: client({ c1: channel }),
    backend,
    log: makeLog(),
    fetch: makeFetch(),
  });

  await poster.postClip('clip1');

  const payload = channel.sent[0];
  assert.deepEqual(payload.allowedMentions, { parse: [], users: ['4242'] });
  assert.ok(!payload.content.includes('<@99>'), payload.content);
  assert.ok(payload.content.startsWith('Ace on Ascent - por <@4242>\n'), payload.content);
});

test('the same clip tags voice members in one guild and not in another', async () => {
  // The setting belongs to the destination guild, like the language does.
  const clip = makeClip({ participants: ['99'] });
  const on = makeChannel({ channelId: 'c1', guildId: 'g1', messageId: 'm1' });
  const off = makeChannel({ channelId: 'c2', guildId: 'g2', messageId: 'm2' });
  const backend = makeBackend({
    clip,
    guilds: [
      { guildId: 'g1', channelId: 'c1', seedEmojis: [], tagVoiceMembers: true },
      { guildId: 'g2', channelId: 'c2', seedEmojis: [], tagVoiceMembers: false },
    ],
  });
  const poster = createPoster({
    client: client({ c1: on, c2: off }),
    backend,
    log: makeLog(),
    fetch: makeFetch(),
  });

  await poster.postClip('clip1');

  assert.deepEqual(on.sent[0].allowedMentions.users, ['4242', '99']);
  assert.deepEqual(off.sent[0].allowedMentions.users, ['4242']);
});

test('every message carries the manage button, on both paths', async () => {
  const clip = makeClip();
  const attached = makeChannel({ channelId: 'c1', guildId: 'g1', premiumTier: 3, messageId: 'm1' });
  const linked = makeChannel({ channelId: 'c2', guildId: 'g2', premiumTier: 0, messageId: 'm2' });
  const backend = makeBackend({
    clip,
    guilds: [
      { guildId: 'g1', channelId: 'c1', seedEmojis: [] },
      { guildId: 'g2', channelId: 'c2', seedEmojis: [] },
    ],
  });
  const poster = createPoster({
    client: client({ c1: attached, c2: linked }),
    backend,
    log: makeLog(),
    fetch: makeFetch(),
  });

  await poster.postClip('clip1');

  for (const channel of [attached, linked]) {
    const payload = channel.sent[0];
    assert.equal(payload.components.length, 1);
    const row = payload.components[0].toJSON();
    assert.equal(row.components.length, 1);
    assert.equal(row.components[0].custom_id, 'clip:menu:clip1');
    // Components are not embeds: the link path still carries no embeds[] and so keeps the
    // video preview Discord builds from the player page.
    assert.equal(payload.embeds, undefined);
  }
  assert.ok(attached.sent[0].files, 'expected the attachment path in the tier 3 guild');
  assert.equal(linked.sent[0].files, undefined, 'expected the link path in the tier 0 guild');
});

test('every message allows only the ids it means to mention, on both paths', async () => {
  // The content carries a clip title and an owner username, neither of which the bot controls.
  // 27 MB fits under the tier 3 limit and not under the tier 0 one, so one post takes each path.
  const clip = makeClip();
  const attached = makeChannel({ channelId: 'c1', guildId: 'g1', premiumTier: 3, messageId: 'm1' });
  const linked = makeChannel({ channelId: 'c2', guildId: 'g2', premiumTier: 0, messageId: 'm2' });
  const backend = makeBackend({
    clip,
    guilds: [
      { guildId: 'g1', channelId: 'c1', seedEmojis: [] },
      { guildId: 'g2', channelId: 'c2', seedEmojis: [] },
    ],
  });
  backend.getClip = async () => clip;
  const poster = createPoster({
    client: client({ c1: attached, c2: linked }),
    backend,
    log: makeLog(),
    fetch: makeFetch(),
  });

  await poster.postClip('clip1');

  assert.ok(attached.sent[0].files, 'expected the attachment path in the tier 3 guild');
  // parse: [] stays: it is what keeps @everyone and role syntax in the title inert. `users`
  // is an allow-list of ids, not permission for whatever the content happens to contain.
  assert.deepEqual(attached.sent[0].allowedMentions, { parse: [], users: ['4242'] });
  assert.equal(linked.sent[0].files, undefined, 'expected the link path in the tier 0 guild');
  assert.deepEqual(linked.sent[0].allowedMentions, { parse: [], users: ['4242'] });
  // A fresh object per message: discord.js resolves the payload it is handed in place.
  assert.notEqual(attached.sent[0].allowedMentions, linked.sent[0].allowedMentions);
  assert.notEqual(attached.sent[0].allowedMentions.users, linked.sent[0].allowedMentions.users);
});

test('a clip titled @everyone is posted as text that cannot ping', async () => {
  const clip = makeClip({
    title: '@everyone look at this <@999> <@&1234567890>',
    owner: { discordId: '4242', username: '<@&1234567890>' },
  });
  const channel = makeChannel({ channelId: 'c1', guildId: 'g1', messageId: 'm1' });
  const backend = makeBackend({ clip, guilds: [{ guildId: 'g1', channelId: 'c1', seedEmojis: [] }] });
  const poster = createPoster({ client: client({ c1: channel }), backend, log: makeLog(), fetch: makeFetch() });

  await poster.postClip('clip1');

  const payload = channel.sent[0];
  // The text is sent as typed - it is allowedMentions, not escaping, that makes it inert.
  assert.ok(payload.content.includes('@everyone look at this'));
  // A user id in the title is not in the allow-list, so it renders as a name and notifies
  // nobody: `users` lists who may be pinged, it does not bless what the content contains.
  assert.deepEqual(payload.allowedMentions, { parse: [], users: ['4242'] });
  assert.ok(!payload.allowedMentions.users.includes('999'));
});

// ---- target resolution -------------------------------------------------------------------

/** Three configured guilds, each with its own channel c<n> posting as message m<n>. */
function threeGuilds() {
  const channels = {
    c1: makeChannel({ channelId: 'c1', guildId: 'g1', messageId: 'm1' }),
    c2: makeChannel({ channelId: 'c2', guildId: 'g2', messageId: 'm2' }),
    c3: makeChannel({ channelId: 'c3', guildId: 'g3', messageId: 'm3' }),
  };
  const guilds = [
    { guildId: 'g1', channelId: 'c1', seedEmojis: [] },
    { guildId: 'g2', channelId: 'c2', seedEmojis: [] },
    { guildId: 'g3', channelId: 'c3', seedEmojis: [] },
  ];
  return { channels, guilds };
}

test('a clip with null targets posts to every configured guild without asking who is in them', async () => {
  const { channels, guilds } = threeGuilds();
  // Nobody is a member anywhere: a membership check would post nothing, so posting everywhere
  // proves the legacy path never asked.
  const discordGuilds = { g1: makeGuild(), g2: makeGuild(), g3: makeGuild() };
  const backend = makeBackend({ clip: makeClip({ targetGuildIds: null, posts: [] }), guilds });
  const poster = createPoster({
    client: client(channels, discordGuilds),
    backend,
    log: makeLog(),
    fetch: makeFetch(),
  });

  const posted = await poster.postClip('clip1');

  assert.deepEqual(posted.map((p) => p.guildId), ['g1', 'g2', 'g3']);
  for (const guild of Object.values(discordGuilds)) assert.deepEqual(guild.memberFetches, []);
});

test('explicit targets post only to configured guilds the owner is a member of', async () => {
  const { channels, guilds } = threeGuilds();
  const discordGuilds = {
    g1: makeGuild({ members: ['4242'] }),
    g2: makeGuild({ members: ['someone-else'] }),
    g3: makeGuild({ members: ['4242'] }),
  };
  // g3 is configured and the owner is in it, but was not picked; g9 was picked and is not set up.
  const backend = makeBackend({
    clip: makeClip({ targetGuildIds: ['g1', 'g2', 'g9'], posts: [] }),
    guilds,
  });
  const log = makeLog();
  const fake = client(channels, discordGuilds);
  const poster = createPoster({ client: fake, backend, log, fetch: makeFetch() });

  const posted = await poster.postClip('clip1');

  assert.deepEqual(posted, [{ guildId: 'g1', channelId: 'c1', messageId: 'm1' }]);
  assert.deepEqual(fake.fetched, ['c1'], 'a skipped guild never has its channel fetched');
  // The check goes past the cache: without the GuildMembers intent a cached member can be stale.
  assert.deepEqual(discordGuilds.g1.memberFetches, [{ user: '4242', force: true, cache: false }]);
  assert.deepEqual(discordGuilds.g3.memberFetches, [], 'an unpicked guild is not even checked');
  assert.ok(log.lines.warn.some((l) => l.includes('g2') && l.includes('not a member')));
  assert.ok(log.lines.info.some((l) => l.includes('g9') && l.includes('not configured')));
});

test('a membership check that fails, or a guild the bot cannot reach, skips only that guild', async () => {
  const { channels, guilds } = threeGuilds();
  const discordGuilds = {
    g1: makeGuild({ error: discordError('Internal Server Error', 0) }),
    // g2 is not in the cache, and the fake client cannot fetch it.
    g3: makeGuild({ members: ['4242'] }),
  };
  const backend = makeBackend({
    clip: makeClip({ targetGuildIds: ['g1', 'g2', 'g3'], posts: [] }),
    guilds,
  });
  const log = makeLog();
  const poster = createPoster({
    client: client(channels, discordGuilds),
    backend,
    log,
    fetch: makeFetch(),
  });

  const posted = await poster.postClip('clip1');

  assert.deepEqual(posted.map((p) => p.guildId), ['g3']);
  assert.ok(log.lines.warn.some((l) => l.includes('g1') && l.includes('Internal Server Error')));
  assert.ok(log.lines.warn.some((l) => l.includes('g2') && l.includes('not reachable')));
  assert.deepEqual(log.lines.error, [], 'a skipped guild is a warning, not a failed post');
});

test('a guild that already has a live post of the clip is skipped, targets or not', async () => {
  for (const targetGuildIds of [null, ['g1', 'g2']]) {
    const { channels, guilds } = threeGuilds();
    const discordGuilds = {
      g1: makeGuild({ members: ['4242'] }),
      g2: makeGuild({ members: ['4242'] }),
    };
    const backend = makeBackend({
      clip: makeClip({
        targetGuildIds,
        posts: [{ guildId: 'g1', channelId: 'c1', messageId: 'old' }],
      }),
      guilds,
    });
    const poster = createPoster({
      client: client(channels, discordGuilds),
      backend,
      log: makeLog(),
      fetch: makeFetch(),
    });

    const posted = await poster.postClip('clip1');

    const expected = targetGuildIds ? ['g2'] : ['g2', 'g3'];
    assert.deepEqual(posted.map((p) => p.guildId), expected, `for ${JSON.stringify(targetGuildIds)}`);
    assert.equal(channels.c1.sent.length, 0, 'a retried notification must not double-post');
    assert.deepEqual(discordGuilds.g1.memberFetches, [], 'no membership check for a skipped guild');
  }
});

test('guildIds passed to postClip override the clip own targets', async () => {
  const { channels, guilds } = threeGuilds();
  const discordGuilds = {
    g1: makeGuild({ members: ['4242'] }),
    g2: makeGuild({ members: ['4242'] }),
    g3: makeGuild({ members: ['4242'] }),
  };
  const backend = makeBackend({
    clip: makeClip({ targetGuildIds: ['g1'], posts: [] }),
    guilds,
  });
  const poster = createPoster({
    client: client(channels, discordGuilds),
    backend,
    log: makeLog(),
    fetch: makeFetch(),
  });

  assert.deepEqual((await poster.postClip('clip1', ['g3'])).map((p) => p.guildId), ['g3']);
  assert.equal(channels.c1.sent.length, 0);
});

test('explicit guildIds on a legacy clip still require the owner to be a member', async () => {
  const { channels, guilds } = threeGuilds();
  const discordGuilds = { g1: makeGuild({ members: ['4242'] }), g2: makeGuild() };
  const backend = makeBackend({ clip: makeClip({ targetGuildIds: null, posts: [] }), guilds });
  const poster = createPoster({
    client: client(channels, discordGuilds),
    backend,
    log: makeLog(),
    fetch: makeFetch(),
  });

  assert.deepEqual((await poster.postClip('clip1', ['g1', 'g2'])).map((p) => p.guildId), ['g1']);
});

test('an empty target list posts nowhere, and a malformed one rejects instead of posting everywhere', async () => {
  const { channels, guilds } = threeGuilds();
  const fake = client(channels, { g1: makeGuild({ members: ['4242'] }) });

  const empty = makeBackend({ clip: makeClip({ targetGuildIds: [], posts: [] }), guilds });
  const poster = createPoster({ client: fake, backend: empty, log: makeLog(), fetch: makeFetch() });
  assert.deepEqual(await poster.postClip('clip1'), []);

  const broken = makeBackend({ clip: makeClip({ targetGuildIds: 'g1', posts: [] }), guilds });
  const brokenPoster = createPoster({
    client: fake,
    backend: broken,
    log: makeLog(),
    fetch: makeFetch(),
  });
  await assert.rejects(() => brokenPoster.postClip('clip1'), /not an array/);
  assert.deepEqual(fake.fetched, []);
});
