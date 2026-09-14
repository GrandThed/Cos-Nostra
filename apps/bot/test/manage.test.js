// The clip management buttons. Nothing here connects: the client is a bare EventEmitter with
// a channels.fetch, every interaction is a plain object recording what was done to it, and
// the components are the real discord.js builders, asserted through toJSON() so the payloads
// pass discord.js's own validation the way a real send would.

import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';

import { MessageFlags, PermissionFlagsBits } from 'discord.js';

import { manageRow, registerManage } from '../src/manage.js';

const EPHEMERAL = Number(MessageFlags.Ephemeral);

// Real-shaped ids: 12 url-safe characters for the clip, snowflakes for Discord.
const CLIP_ID = 'abc123456789';
const CHANNEL_ID = '900000000000000001';
const MESSAGE_ID = '900000000000000002';
const OWNER_ID = '1234';

const CLIP = {
  id: CLIP_ID,
  game: 'Rocket League',
  title: 'Ceiling shot',
  owner: { discordId: OWNER_ID, username: 'benja' },
  participants: [],
};

// ---- fakes -------------------------------------------------------------------------------

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
 * A button interaction. `responded` resolves on the first reply, update or editReply, which
 * is how a test knows the async handler is finished.
 */
function makeButton({
  customId,
  user = { id: OWNER_ID },
  manageGuild = false,
  guildId = 'guild-1',
  message = { id: MESSAGE_ID, channelId: CHANNEL_ID },
  isButton = true,
} = {}) {
  const calls = { deferReply: [], editReply: [], reply: [], update: [], permissionChecks: [] };
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
    customId,
    guildId,
    user,
    message,
    isButton: () => isButton,
    memberPermissions: {
      has: (flag) => {
        calls.permissionChecks.push(flag);
        return manageGuild;
      },
    },
    deferReply: record('deferReply', false),
    editReply: record('editReply', true),
    reply: record('reply', true),
    update: record('update', true),
  };
}

/**
 * A client whose channels.fetch answers a channel that records deleted message ids, or throws
 * the way a fetch for a channel the bot cannot see does.
 * @param {{ deleteError?: Error, fetchError?: Error }} [opts]
 */
function makeClient({ deleteError, fetchError } = {}) {
  const client = new EventEmitter();
  const deleted = [];
  client.deleted = deleted;
  client.channels = {
    async fetch(channelId) {
      if (fetchError) throw fetchError;
      return {
        id: channelId,
        messages: {
          async delete(messageId) {
            if (deleteError) throw deleteError;
            deleted.push(`${channelId}/${messageId}`);
            return { id: messageId };
          },
        },
      };
    },
  };
  return client;
}

/**
 * @param {object} [opts]
 * @param {any} [opts.clip] what getClip answers, null for a clip that is gone
 * @param {Error} [opts.deleteError] what deleteClip throws
 * @param {Error} [opts.removePostError] what removePost throws
 */
function makeBackend({ clip = CLIP, deleteError, removePostError } = {}) {
  const calls = { getClip: [], deleteClip: [], removePost: [] };
  return {
    calls,
    getGuild: async () => ({ guildId: 'guild-1', channelId: CHANNEL_ID, seedEmojis: [] }),
    getClip: async (clipId) => {
      calls.getClip.push(clipId);
      return clip;
    },
    deleteClip: async (clipId) => {
      calls.deleteClip.push(clipId);
      if (deleteError) throw deleteError;
    },
    removePost: async (messageId) => {
      calls.removePost.push(messageId);
      if (removePostError) throw removePostError;
      return null;
    },
  };
}

/** An error shaped like the shared client's ApiError, which is all manage.js looks at. */
function apiError(status, message = `status ${status}`) {
  return Object.assign(new Error(message), { name: 'ApiError', status });
}

function withTimeout(promise, ms, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`timed out waiting for ${label}`)), ms);
    timer.unref?.();
  });
  return Promise.race([promise.finally(() => clearTimeout(timer)), timeout]);
}

/** Registers the handler on a fake client, emits the click, waits for the answer. */
async function click(interaction, backend, { client = makeClient(), log = makeLog() } = {}) {
  registerManage({ client, backend, log });
  client.emit('interactionCreate', interaction);
  await withTimeout(interaction.responded, 2_000, `an answer to ${interaction.customId}`);
  return { client, log };
}

/** The payload of whichever call answered this interaction. */
function answer(interaction) {
  const payload =
    interaction.calls.update.at(-1) ??
    interaction.calls.editReply.at(-1) ??
    interaction.calls.reply.at(-1);
  assert.ok(payload, 'expected the interaction to have been answered');
  return payload;
}

/** Every custom_id in an answered payload's components, in order. */
function customIds(payload) {
  return (payload.components ?? []).flatMap((row) =>
    row.toJSON().components.map((component) => component.custom_id),
  );
}

// ---- the button on the post --------------------------------------------------------------

test('manageRow is one secondary button carrying the clip id', () => {
  const row = manageRow(CLIP_ID).toJSON();
  assert.equal(row.components.length, 1);
  const [button] = row.components;
  assert.equal(button.custom_id, `clip:menu:${CLIP_ID}`);
  // Style 2 is Secondary: chrome next to the clip, not a call to action.
  assert.equal(button.style, 2);
  // The label is locale-neutral on purpose: Discord bakes component labels into the message
  // and does not localize them per viewer, so it cannot follow the guild's language.
  assert.ok(button.label.length > 0);
});

// ---- clip:menu ---------------------------------------------------------------------------

test('the owner gets the hide and delete buttons, aimed at the message they clicked', async () => {
  const backend = makeBackend();
  const interaction = makeButton({ customId: `clip:menu:${CLIP_ID}` });
  await click(interaction, backend);

  // Ephemeral, and deferred rather than updated: the button is on the public post, which
  // must not be edited.
  assert.equal(interaction.calls.deferReply.length, 1);
  assert.equal(interaction.calls.deferReply[0].flags, EPHEMERAL);
  assert.equal(interaction.calls.update.length, 0);

  const payload = answer(interaction);
  assert.deepEqual(customIds(payload), [
    `clip:hide:${CLIP_ID}:${CHANNEL_ID}:${MESSAGE_ID}`,
    `clip:delcfm:${CLIP_ID}:${CHANNEL_ID}:${MESSAGE_ID}`,
  ]);
  // The clip title is quoted, so a title full of markdown cannot restyle the panel, and the
  // panel can never ping anyone either.
  assert.match(payload.content, /`Ceiling shot`/);
  assert.deepEqual(payload.allowedMentions, { parse: [] });
  assert.deepEqual(backend.calls.getClip, [CLIP_ID]);
});

test('someone with Manage Server may manage a clip that is not theirs', async () => {
  const backend = makeBackend();
  const interaction = makeButton({
    customId: `clip:menu:${CLIP_ID}`,
    user: { id: '9999' },
    manageGuild: true,
  });
  await click(interaction, backend);

  assert.deepEqual(interaction.calls.permissionChecks, [PermissionFlagsBits.ManageGuild]);
  assert.equal(customIds(answer(interaction)).length, 2);
});

test('anyone else is refused, and gets no buttons to try again with', async () => {
  const backend = makeBackend();
  const interaction = makeButton({
    customId: `clip:menu:${CLIP_ID}`,
    user: { id: '9999' },
    manageGuild: false,
  });
  const { log } = await click(interaction, backend);

  const payload = answer(interaction);
  assert.match(payload.content, /no es tuyo/i);
  assert.deepEqual(payload.components, []);
  assert.equal(interaction.calls.deferReply[0].flags, EPHEMERAL, 'the refusal is private');
  assert.ok(log.lines.info.some((line) => line.includes('9999')));
});

test('a clip that has already been deleted says so instead of offering to delete it', async () => {
  const backend = makeBackend({ clip: null });
  const interaction = makeButton({ customId: `clip:menu:${CLIP_ID}` });
  await click(interaction, backend);

  const payload = answer(interaction);
  assert.match(payload.content, /ya no existe/i);
  assert.deepEqual(payload.components, []);
});

test('the panel is written in the guild language', async () => {
  const backend = makeBackend();
  backend.getGuild = async () => ({ guildId: 'guild-1', channelId: CHANNEL_ID, locale: 'en' });
  const interaction = makeButton({ customId: `clip:menu:${CLIP_ID}` });
  await click(interaction, backend);

  const payload = answer(interaction);
  assert.match(payload.content, /Managing/);
  const labels = payload.components[0].toJSON().components.map((c) => c.label);
  assert.deepEqual(labels, ['Hide here', 'Delete everywhere']);
});

// ---- clip:hide ---------------------------------------------------------------------------

test('hide deletes the Discord message and nothing else', async () => {
  const backend = makeBackend();
  const interaction = makeButton({
    customId: `clip:hide:${CLIP_ID}:${CHANNEL_ID}:${MESSAGE_ID}`,
  });
  const { client } = await click(interaction, backend);

  assert.deepEqual(client.deleted, [`${CHANNEL_ID}/${MESSAGE_ID}`]);
  assert.deepEqual(backend.calls.deleteClip, [], 'hide must never touch the clip itself');
  // The post row is marked removed, so it stops counting as live on the desktop.
  assert.deepEqual(backend.calls.removePost, [MESSAGE_ID]);
  assert.match(answer(interaction).content, /Oculto/i);
});

test('hide tolerates a post the backend never recorded', async () => {
  const backend = makeBackend({ removePostError: apiError(404, 'unknown_message') });
  const interaction = makeButton({
    customId: `clip:hide:${CLIP_ID}:${CHANNEL_ID}:${MESSAGE_ID}`,
  });
  const { client, log } = await click(interaction, backend);

  assert.deepEqual(client.deleted, [`${CHANNEL_ID}/${MESSAGE_ID}`]);
  assert.deepEqual(backend.calls.removePost, [MESSAGE_ID]);
  assert.match(answer(interaction).content, /Oculto/i);
  assert.deepEqual(log.lines.error, []);
  assert.deepEqual(log.lines.warn, []);
});

test('hide logs a failure to mark the post removed but still tells the user it is hidden', async () => {
  const backend = makeBackend({ removePostError: apiError(503, 'backend is redeploying') });
  const interaction = makeButton({
    customId: `clip:hide:${CLIP_ID}:${CHANNEL_ID}:${MESSAGE_ID}`,
  });
  const { client, log } = await click(interaction, backend);

  // The message is gone either way, which is what was asked for.
  assert.deepEqual(client.deleted, [`${CHANNEL_ID}/${MESSAGE_ID}`]);
  const payload = answer(interaction);
  assert.match(payload.content, /Oculto/i);
  assert.equal(log.lines.error.length, 1);
  assert.match(log.lines.error[0], /status 503/);
  assert.match(log.lines.error[0], new RegExp(MESSAGE_ID));
});

test('hide is refused for someone who may not manage the clip', async () => {
  const backend = makeBackend();
  const interaction = makeButton({
    customId: `clip:hide:${CLIP_ID}:${CHANNEL_ID}:${MESSAGE_ID}`,
    user: { id: '9999' },
  });
  const { client } = await click(interaction, backend);

  // Authorization is re-read on every click, never carried over from the menu click before.
  assert.deepEqual(client.deleted, []);
  assert.match(answer(interaction).content, /no es tuyo/i);
});

test('hide treats a message that is already gone as done', async () => {
  const backend = makeBackend();
  const client = makeClient({ deleteError: new Error('Unknown Message') });
  const interaction = makeButton({
    customId: `clip:hide:${CLIP_ID}:${CHANNEL_ID}:${MESSAGE_ID}`,
  });
  const { log } = await click(interaction, backend, { client });

  assert.match(answer(interaction).content, /Oculto/i);
  assert.ok(log.lines.warn.some((line) => line.includes('Unknown Message')));
  assert.deepEqual(log.lines.error, []);
});

// ---- clip:delcfm and clip:delcancel -------------------------------------------------------

test('delete asks first, in place, with the confirm styled as the dangerous one', async () => {
  const backend = makeBackend();
  const interaction = makeButton({
    customId: `clip:delcfm:${CLIP_ID}:${CHANNEL_ID}:${MESSAGE_ID}`,
  });
  await click(interaction, backend);

  // update(), not a new reply: the ephemeral panel turns into the confirmation.
  assert.equal(interaction.calls.update.length, 1);
  assert.equal(interaction.calls.deferReply.length, 0);

  const payload = answer(interaction);
  assert.deepEqual(customIds(payload), [
    `clip:delgo:${CLIP_ID}:${CHANNEL_ID}:${MESSAGE_ID}`,
    `clip:delcancel:${CLIP_ID}:${CHANNEL_ID}:${MESSAGE_ID}`,
  ]);
  // Style 4 is Danger.
  assert.equal(payload.components[0].toJSON().components[0].style, 4);
  // And it says what "delete" means, because nothing undoes it.
  assert.match(payload.content, /para siempre/i);
  assert.deepEqual(backend.calls.deleteClip, []);
});

test('cancel goes back to the menu and deletes nothing', async () => {
  const backend = makeBackend();
  const client = makeClient();
  const interaction = makeButton({
    customId: `clip:delcancel:${CLIP_ID}:${CHANNEL_ID}:${MESSAGE_ID}`,
  });
  await click(interaction, backend, { client });

  assert.deepEqual(customIds(answer(interaction)), [
    `clip:hide:${CLIP_ID}:${CHANNEL_ID}:${MESSAGE_ID}`,
    `clip:delcfm:${CLIP_ID}:${CHANNEL_ID}:${MESSAGE_ID}`,
  ]);
  assert.deepEqual(backend.calls.deleteClip, []);
  assert.deepEqual(client.deleted, []);
});

// ---- clip:delgo --------------------------------------------------------------------------

test('confirming deletes the clip everywhere and takes the message down with it', async () => {
  const backend = makeBackend();
  const interaction = makeButton({
    customId: `clip:delgo:${CLIP_ID}:${CHANNEL_ID}:${MESSAGE_ID}`,
  });
  const { client } = await click(interaction, backend);

  assert.deepEqual(backend.calls.deleteClip, [CLIP_ID]);
  assert.deepEqual(client.deleted, [`${CHANNEL_ID}/${MESSAGE_ID}`]);
  // The backend's purge marks every post removed itself; a separate call would only 404.
  assert.deepEqual(backend.calls.removePost, []);
  const payload = answer(interaction);
  assert.match(payload.content, /borrado/i);
  assert.deepEqual(payload.components, []);
});

test('a 404 from the backend means someone got there first, which is success', async () => {
  const gone = new Error('Not Found');
  gone.name = 'ApiError';
  gone.status = 404;
  const backend = makeBackend({ deleteError: gone });
  const interaction = makeButton({
    customId: `clip:delgo:${CLIP_ID}:${CHANNEL_ID}:${MESSAGE_ID}`,
  });
  const { client, log } = await click(interaction, backend);

  assert.match(answer(interaction).content, /borrado/i);
  // The message still comes down, and the failure is not reported to the user.
  assert.deepEqual(client.deleted, [`${CHANNEL_ID}/${MESSAGE_ID}`]);
  assert.deepEqual(log.lines.error, []);
});

test('any other delete failure is reported and leaves the message alone', async () => {
  const boom = new Error('backend is redeploying');
  boom.name = 'ApiError';
  boom.status = 503;
  const backend = makeBackend({ deleteError: boom });
  const interaction = makeButton({
    customId: `clip:delgo:${CLIP_ID}:${CHANNEL_ID}:${MESSAGE_ID}`,
  });
  const { client, log } = await click(interaction, backend);

  assert.match(answer(interaction).content, /no se cambió nada/i);
  assert.deepEqual(client.deleted, [], 'the post stays up when the clip is still there');
  assert.equal(log.lines.error.length, 1);
  assert.match(log.lines.error[0], /status 503/);
});

test('delete is refused for someone who may not manage the clip', async () => {
  const backend = makeBackend();
  const interaction = makeButton({
    customId: `clip:delgo:${CLIP_ID}:${CHANNEL_ID}:${MESSAGE_ID}`,
    user: { id: '9999' },
  });
  const { client } = await click(interaction, backend);

  assert.deepEqual(backend.calls.deleteClip, []);
  assert.deepEqual(client.deleted, []);
  assert.match(answer(interaction).content, /no es tuyo/i);
});

// ---- everything that is not one of ours ---------------------------------------------------

test('a customId that is not ours is left for whoever it belongs to', async () => {
  const backend = makeBackend();
  const log = makeLog();
  const client = makeClient();
  registerManage({ client, backend, log });

  const others = [
    'recap:menu:abc123456789',
    'clip',
    'clip:',
    'clip:nope:abc123456789',
    `clip:menu:${CLIP_ID}:extra`,
    `clip:menu:${CLIP_ID}:${CHANNEL_ID}:${MESSAGE_ID}`,
    'clip:hide:abc123456789',
    `clip:hide:abc123456789:not-a-snowflake:${MESSAGE_ID}`,
    `clip:hide:abc 123:${CHANNEL_ID}:${MESSAGE_ID}`,
    `clip:hide:${CLIP_ID}:${CHANNEL_ID}:${MESSAGE_ID}:extra`,
    'clip:menu:',
    undefined,
    42,
  ];
  const interactions = others.map((customId) => makeButton({ customId }));
  for (const interaction of interactions) client.emit('interactionCreate', interaction);
  // A chat-input interaction (isButton() false) and a malformed event go past too.
  client.emit('interactionCreate', makeButton({ customId: `clip:menu:${CLIP_ID}`, isButton: false }));
  client.emit('interactionCreate', undefined);
  await new Promise((r) => setImmediate(r));

  for (const interaction of interactions) {
    assert.deepEqual(interaction.calls.deferReply, [], `${interaction.customId} was answered`);
    assert.deepEqual(interaction.calls.reply, []);
    assert.deepEqual(interaction.calls.update, []);
  }
  assert.deepEqual(backend.calls.getClip, []);
  assert.deepEqual(log.lines.error, [], 'a customId we do not understand is not an error');
});

test('a menu click on a message with no usable ids is answered, not crashed', async () => {
  const backend = makeBackend();
  const interaction = makeButton({ customId: `clip:menu:${CLIP_ID}`, message: {} });
  const { log } = await click(interaction, backend);

  assert.deepEqual(answer(interaction).components, []);
  assert.ok(log.lines.warn.some((line) => line.includes('no usable ids')));
});

test('a backend that is down is reported on the reply that was already opened', async () => {
  const backend = makeBackend();
  backend.getClip = async () => {
    throw new Error('backend down');
  };
  const interaction = makeButton({ customId: `clip:menu:${CLIP_ID}` });
  const { log } = await click(interaction, backend);

  assert.match(answer(interaction).content, /Algo salió mal/i);
  assert.equal(log.lines.error.length, 1);
});

test('registerManage rejects a missing client or backend', () => {
  assert.throws(() => registerManage({ backend: {} }), TypeError);
  assert.throws(() => registerManage({ client: new EventEmitter() }), TypeError);
});
