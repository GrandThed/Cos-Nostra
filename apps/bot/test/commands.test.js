// Slash command tests. Nothing here connects to Discord or to the backend: the client is a
// bare EventEmitter (registerCommands only ever calls client.on) and every interaction is a
// plain object that records the calls made on it.
//
// The one global that gets touched is fetch, in the /clips link fallback test, and it is
// restored in a finally.

import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';

import { ChannelType, MessageFlags, PermissionFlagsBits } from 'discord.js';

import { commands, registerCommands } from '../src/commands.js';

const EPHEMERAL = Number(MessageFlags.Ephemeral);

const CLIP = {
  id: 'abc123456789',
  game: 'Rocket League',
  title: 'Ceiling shot',
  durationMs: 32_500,
  recordedAt: '2026-09-01T12:00:00.000Z',
  owner: { discordId: '1234', username: 'benja', avatar: null },
  urls: {
    av1: 'https://cosnostra.benja.ar/clips/abc123456789/av1',
    h264: 'https://cosnostra.benja.ar/clips/abc123456789/h264',
    thumb: 'https://cosnostra.benja.ar/clips/abc123456789/thumb',
    page: 'https://cosnostra.benja.ar/c/abc123456789',
  },
  reactions: 7,
};

const OTHER_CLIP = {
  ...CLIP,
  id: 'def456789012',
  game: 'Counter-Strike 2',
  title: 'Ace on Mirage',
  owner: { discordId: '5678', username: 'nacho', avatar: null },
  urls: { ...CLIP.urls, page: 'https://cosnostra.benja.ar/c/def456789012' },
  reactions: 3,
};

// ---- fakes -----------------------------------------------------------------------------

function makeLog() {
  const lines = { error: [], warn: [], info: [] };
  return {
    lines,
    error: (message) => lines.error.push(String(message)),
    warn: (message) => lines.warn.push(String(message)),
    info: (message) => lines.info.push(String(message)),
  };
}

/**
 * A chat-input interaction that records what the handler did to it. `responded` resolves on
 * the first reply or editReply, which is how a test knows the async handler is finished.
 */
function makeInteraction({
  sub,
  options = {},
  guildId = 'guild-1',
  user = { id: '1234', username: 'benja' },
  manageGuild = true,
  commandName = 'clips',
  chatInput = true,
} = {}) {
  const calls = { deferReply: [], editReply: [], reply: [], permissionChecks: [] };
  let settle;
  const responded = new Promise((resolve) => {
    settle = resolve;
  });
  const record = (name, finishes) => (payload = null) => {
    calls[name].push(payload);
    if (finishes) settle(payload);
    return Promise.resolve(payload);
  };
  return {
    calls,
    responded,
    commandName,
    guildId,
    user,
    isChatInputCommand: () => chatInput,
    memberPermissions: {
      has: (flag) => {
        calls.permissionChecks.push(flag);
        return manageGuild;
      },
    },
    options: {
      getSubcommand: () => sub,
      getString: (name) => options[name] ?? null,
      getInteger: (name) => options[name] ?? null,
      getChannel: (name) => options[name] ?? null,
    },
    deferReply: record('deferReply', false),
    editReply: record('editReply', true),
    reply: record('reply', true),
  };
}

function textChannel(id = 'chan-9') {
  return { id, name: 'clips', type: ChannelType.GuildText };
}

function withTimeout(promise, ms, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`timed out waiting for ${label}`)), ms);
    timer.unref?.();
  });
  return Promise.race([promise.finally(() => clearTimeout(timer)), timeout]);
}

/** Registers the handler on a fake client, emits the interaction, waits for the reply. */
async function run(interaction, backend, log = makeLog()) {
  const client = new EventEmitter();
  registerCommands({ client, backend, log });
  client.emit('interactionCreate', interaction);
  await withTimeout(interaction.responded, 2_000, `a reply to /clips ${interaction.options.getSubcommand()}`);
  return log;
}

/** Last editReply payload. */
function lastEdit(interaction) {
  const payload = interaction.calls.editReply.at(-1);
  assert.ok(payload, 'expected editReply to have been called');
  return payload;
}

function embedOf(payload) {
  const embed = payload?.embeds?.[0];
  assert.ok(embed, `expected an embed, got ${JSON.stringify(payload)}`);
  return typeof embed.toJSON === 'function' ? embed.toJSON() : embed;
}

// ---- command JSON ----------------------------------------------------------------------

test('commands is JSON for one /clips command with the five subcommands', () => {
  assert.ok(Array.isArray(commands));
  assert.equal(commands.length, 1);
  // Everything below runs on the serialized copy, which is what the REST client actually
  // sends: it proves the payload survives JSON (no builder instances, no BigInt permission
  // flags) as well as having the right shape. The builder leaves explicit `undefined` keys
  // in place, and those are the only difference JSON.stringify makes.
  const [clips] = JSON.parse(JSON.stringify(commands));
  assert.equal(clips.name, 'clips');
  assert.equal(typeof clips.description, 'string');

  const subs = clips.options.filter((opt) => opt.type === 1);
  assert.deepEqual(
    subs.map((opt) => opt.name),
    ['setup', 'latest', 'top', 'mine', 'link'],
  );

  const setup = subs.find((opt) => opt.name === 'setup');
  const channel = setup.options.find((opt) => opt.name === 'channel');
  assert.equal(channel.required, true);
  assert.ok(channel.channel_types.includes(ChannelType.GuildText));

  const top = subs.find((opt) => opt.name === 'top');
  const byName = Object.fromEntries(top.options.map((opt) => [opt.name, opt]));
  assert.equal(byName.year.required, false);
  assert.equal(byName.game.required, false);
});

// ---- /clips setup ----------------------------------------------------------------------

test('/clips setup stores the channel and confirms ephemerally', async () => {
  const putCalls = [];
  const backend = {
    getGuild: async () => ({ guildId: 'guild-1', channelId: null, seedEmojis: ['🔥', '😂'] }),
    putGuild: async (guildId, body) => {
      putCalls.push([guildId, body]);
      return { guildId, channelId: body.channelId, seedEmojis: body.seedEmojis };
    },
  };
  const interaction = makeInteraction({ sub: 'setup', options: { channel: textChannel() } });
  await run(interaction, backend);

  assert.equal(interaction.calls.deferReply.length, 1);
  assert.equal(interaction.calls.deferReply[0].flags, EPHEMERAL);
  // Seed emojis survive a PUT that only meant to change the channel.
  assert.deepEqual(putCalls, [['guild-1', { channelId: 'chan-9', seedEmojis: ['🔥', '😂'] }]]);
  assert.match(lastEdit(interaction).content, /<#chan-9>/);
});

test('/clips setup is refused for a member without Manage Guild', async () => {
  const backend = {
    getGuild: async () => assert.fail('getGuild must not be called'),
    putGuild: async () => assert.fail('putGuild must not be called'),
  };
  const interaction = makeInteraction({
    sub: 'setup',
    options: { channel: textChannel() },
    manageGuild: false,
  });
  await run(interaction, backend);

  assert.equal(interaction.calls.deferReply[0].flags, EPHEMERAL);
  assert.match(lastEdit(interaction).content, /Manage Server/);
  // The refusal is about Manage Guild specifically, not some other permission.
  assert.deepEqual(interaction.calls.permissionChecks, [PermissionFlagsBits.ManageGuild]);
});

test('/clips setup rejects a channel it cannot post clips into', async () => {
  const backend = {
    getGuild: async () => assert.fail('getGuild must not be called'),
    putGuild: async () => assert.fail('putGuild must not be called'),
  };
  const interaction = makeInteraction({
    sub: 'setup',
    options: { channel: { id: 'voice-1', name: 'General', type: ChannelType.GuildVoice } },
  });
  await run(interaction, backend);

  assert.match(lastEdit(interaction).content, /text channel/i);
});

// ---- /clips latest ---------------------------------------------------------------------

test('/clips latest embeds the newest clip with its thumbnail and player page', async () => {
  const queries = [];
  const backend = {
    listClips: async (query) => {
      queries.push(query);
      return { items: [CLIP], nextCursor: null };
    },
  };
  const interaction = makeInteraction({ sub: 'latest' });
  await run(interaction, backend);

  assert.deepEqual(queries, [{ sort: 'recent', limit: 1 }]);
  // Public: the defer carries no ephemeral flag.
  assert.equal(interaction.calls.deferReply[0].flags, undefined);

  const embed = embedOf(lastEdit(interaction));
  assert.equal(embed.title, 'Ceiling shot');
  assert.equal(embed.url, CLIP.urls.page);
  assert.equal(embed.image.url, CLIP.urls.thumb);
  const fields = Object.fromEntries(embed.fields.map((f) => [f.name, f.value]));
  assert.equal(fields.Game, 'Rocket League');
  assert.equal(fields.Length, '0:33');
  assert.equal(fields.Reactions, '7');
  assert.match(embed.footer.text, /benja/);
});

test('/clips latest says something friendly when there are no clips', async () => {
  const backend = { listClips: async () => ({ items: [], nextCursor: null }) };
  const interaction = makeInteraction({ sub: 'latest' });
  await run(interaction, backend);

  const payload = lastEdit(interaction);
  assert.equal(payload.embeds, undefined);
  assert.match(payload.content, /no clips/i);
});

// ---- /clips top ------------------------------------------------------------------------

test('/clips top ranks this guild for the current UTC year', async () => {
  const queries = [];
  const backend = {
    getRankings: async (query) => {
      queries.push(query);
      return {
        items: [
          { clip: CLIP, reactions: 7, distinctReactors: 5 },
          { clip: OTHER_CLIP, reactions: 3, distinctReactors: 1 },
        ],
      };
    },
  };
  const interaction = makeInteraction({ sub: 'top' });
  await run(interaction, backend);

  assert.deepEqual(queries, [
    { guild: 'guild-1', year: new Date().getUTCFullYear(), limit: 10 },
  ]);

  const embed = embedOf(lastEdit(interaction));
  assert.match(embed.title, new RegExp(String(new Date().getUTCFullYear())));
  const lines = embed.description.split('\n');
  assert.equal(lines.length, 2);
  assert.match(lines[0], /\*\*1\.\*\*/);
  assert.match(lines[0], /\[Ceiling shot\]\(https:\/\/cosnostra\.benja\.ar\/c\/abc123456789\)/);
  assert.match(lines[0], /benja/);
  assert.match(lines[0], /Rocket League/);
  assert.match(lines[0], /5 reactors/);
  assert.match(lines[1], /\*\*2\.\*\*/);
  assert.match(lines[1], /1 reactor\b/);
});

test('/clips top filters by game client-side, case-insensitively', async () => {
  const backend = {
    getRankings: async () => ({
      items: [
        { clip: OTHER_CLIP, reactions: 3, distinctReactors: 4 },
        { clip: CLIP, reactions: 7, distinctReactors: 2 },
      ],
    }),
  };
  const interaction = makeInteraction({ sub: 'top', options: { game: 'rocket league' } });
  await run(interaction, backend);

  const embed = embedOf(lastEdit(interaction));
  assert.match(embed.description, /Ceiling shot/);
  assert.doesNotMatch(embed.description, /Ace on Mirage/);
  // Renumbered from 1 after the filter.
  assert.match(embed.description, /^\*\*1\.\*\*/);
  // And it admits the filter is applied to the top ten, not to the whole year.
  assert.match(embed.footer.text, /rocket league/i);
});

test('/clips top with a year and no matching game says so', async () => {
  const queries = [];
  const backend = {
    getRankings: async (query) => {
      queries.push(query);
      return { items: [{ clip: CLIP, reactions: 7, distinctReactors: 5 }] };
    },
  };
  const interaction = makeInteraction({
    sub: 'top',
    options: { year: 2024, game: 'Minecraft' },
  });
  await run(interaction, backend);

  assert.equal(queries[0].year, 2024);
  const payload = lastEdit(interaction);
  assert.equal(payload.embeds, undefined);
  assert.match(payload.content, /Minecraft/);
  assert.match(payload.content, /2024/);
});

// ---- /clips mine -----------------------------------------------------------------------

test('/clips mine lists the caller own clips, ephemerally', async () => {
  const queries = [];
  const backend = {
    listClips: async (query) => {
      queries.push(query);
      return { items: [CLIP], nextCursor: null };
    },
  };
  const interaction = makeInteraction({ sub: 'mine' });
  await run(interaction, backend);

  // The backend `user` filter matches users.discord_id.
  assert.deepEqual(queries, [{ user: '1234', limit: 5 }]);
  assert.equal(interaction.calls.deferReply[0].flags, EPHEMERAL);
  const embed = embedOf(lastEdit(interaction));
  assert.match(embed.description, /\[Ceiling shot\]\(https:\/\/cosnostra\.benja\.ar\/c\//);
});

// ---- /clips link -----------------------------------------------------------------------

test('/clips link replies ephemerally with the code and the verify URL', async () => {
  const names = [];
  const backend = {
    startDeviceLogin: async (deviceName) => {
      names.push(deviceName);
      return {
        code: 'ABCD2345',
        verifyUrl: 'https://cosnostra.benja.ar/auth/discord/start?device=ABCD2345',
        expiresIn: 600,
      };
    },
  };
  const interaction = makeInteraction({ sub: 'link' });
  await run(interaction, backend);

  assert.deepEqual(names, ['Discord benja']);
  // The code is credential-ish: the only response must be the ephemeral deferred one.
  assert.equal(interaction.calls.reply.length, 0);
  assert.equal(interaction.calls.deferReply.length, 1);
  assert.equal(interaction.calls.deferReply[0].flags, EPHEMERAL);
  assert.equal(interaction.calls.editReply.length, 1);

  const { content } = lastEdit(interaction);
  assert.match(content, /ABCD2345/);
  assert.match(content, /https:\/\/cosnostra\.benja\.ar\/auth\/discord\/start\?device=ABCD2345/);
  assert.match(content, /10 minutes/);
});

test('/clips link falls back to POST /auth/device when the backend has no login method', async () => {
  const realFetch = globalThis.fetch;
  const realUrl = process.env.BACKEND_URL;
  const requests = [];
  process.env.BACKEND_URL = 'https://cosnostra.benja.ar/';
  globalThis.fetch = async (url, init) => {
    requests.push({ url, init });
    return {
      ok: true,
      status: 200,
      json: async () => ({ code: 'ZZZZ9999', verifyUrl: 'https://example.test/verify' }),
    };
  };
  try {
    const interaction = makeInteraction({ sub: 'link' });
    await run(interaction, { listClips: async () => ({ items: [] }) });

    assert.equal(requests.length, 1);
    assert.equal(requests[0].url, 'https://cosnostra.benja.ar/auth/device');
    assert.equal(requests[0].init.method, 'POST');
    assert.deepEqual(JSON.parse(requests[0].init.body), { deviceName: 'Discord benja' });
    assert.equal(interaction.calls.deferReply[0].flags, EPHEMERAL);
    assert.match(lastEdit(interaction).content, /ZZZZ9999/);
  } finally {
    globalThis.fetch = realFetch;
    if (realUrl === undefined) delete process.env.BACKEND_URL;
    else process.env.BACKEND_URL = realUrl;
  }
});

// ---- failures --------------------------------------------------------------------------

test('a backend rejection edits the deferred reply and is logged', async () => {
  const err = new Error('backend is redeploying');
  err.name = 'ApiError';
  err.status = 503;
  const backend = {
    listClips: async () => {
      throw err;
    },
  };
  const interaction = makeInteraction({ sub: 'latest' });
  const log = await run(interaction, backend);

  const payload = lastEdit(interaction);
  assert.equal(typeof payload.content, 'string');
  assert.match(payload.content, /backend/i);
  // The embeds are cleared so a previous render cannot linger next to the error.
  assert.deepEqual(payload.embeds, []);
  assert.equal(log.lines.error.length, 1);
  assert.match(log.lines.error[0], /status 503/);
});

test('an editReply that also fails is logged instead of escaping', async () => {
  const backend = {
    listClips: async () => {
      throw new Error('boom');
    },
  };
  const interaction = makeInteraction({ sub: 'latest' });
  const failing = [];
  interaction.editReply = (payload) => {
    failing.push(payload);
    return Promise.reject(new Error('Unknown interaction'));
  };
  const log = makeLog();
  const client = new EventEmitter();
  registerCommands({ client, backend, log });
  client.emit('interactionCreate', interaction);
  // Nothing resolves `responded` here, so wait for the handler to have run instead.
  await withTimeout(
    (async () => {
      for (let i = 0; i < 50 && log.lines.warn.length === 0; i++) await new Promise((r) => setImmediate(r));
    })(),
    2_000,
    'the failed edit to be logged',
  );

  assert.equal(failing.length, 1);
  assert.equal(log.lines.error.length, 1);
  assert.equal(log.lines.warn.length, 1);
  assert.match(log.lines.warn[0], /could not edit/i);
});

test('interactions that are not /clips chat input are ignored', async () => {
  const backend = {
    listClips: async () => assert.fail('the backend must not be touched'),
    getRankings: async () => assert.fail('the backend must not be touched'),
  };
  const other = makeInteraction({ sub: 'latest', commandName: 'recap' });
  const button = makeInteraction({ sub: 'latest', chatInput: false });
  const log = makeLog();
  const client = new EventEmitter();
  registerCommands({ client, backend, log });
  client.emit('interactionCreate', other);
  client.emit('interactionCreate', button);
  client.emit('interactionCreate', undefined);
  await new Promise((r) => setImmediate(r));

  for (const interaction of [other, button]) {
    assert.equal(interaction.calls.deferReply.length, 0);
    assert.equal(interaction.calls.reply.length, 0);
    assert.equal(interaction.calls.editReply.length, 0);
  }
  assert.deepEqual(log.lines.error, []);
});

test('an unknown subcommand is logged and never left hanging', async () => {
  const log = makeLog();
  const client = new EventEmitter();
  const interaction = makeInteraction({ sub: 'nope' });
  registerCommands({ client, backend: {}, log });
  client.emit('interactionCreate', interaction);
  await new Promise((r) => setImmediate(r));

  assert.equal(interaction.calls.deferReply.length, 0);
  assert.equal(log.lines.warn.length, 1);
  assert.match(log.lines.warn[0], /unknown \/clips subcommand/);
});

test('registerCommands rejects a missing client or backend', () => {
  assert.throws(() => registerCommands({ backend: {} }), TypeError);
  assert.throws(() => registerCommands({ client: new EventEmitter() }), TypeError);
});
