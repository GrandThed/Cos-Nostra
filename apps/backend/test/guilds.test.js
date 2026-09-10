// Guild settings for the bot's `/clips setup`. seed_emojis is stored as a JSON array string,
// so every assertion here also pins down that the wire shape is a real array.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { eq } from 'drizzle-orm';

import { testApp, testEnv } from './helpers.js';
import { guildSettings } from '../src/db/schema.js';

const auth = { authorization: `Bearer ${testEnv.BOT_SHARED_SECRET}` };
const GUILD = '222222222222222222';
const CHANNEL = '333333333333333333';
const DEFAULT_EMOJIS = ['🔥', '😂', '💀'];

const put = (app, guildId, payload) =>
  app.inject({ method: 'PUT', url: `/internal/guilds/${guildId}`, headers: auth, payload });

const get = (app, path) => app.inject({ method: 'GET', url: path, headers: auth });

test('/internal/guilds rejects a missing or wrong secret', async () => {
  const app = await testApp();
  try {
    let res = await app.inject({ method: 'GET', url: `/internal/guilds/${GUILD}` });
    assert.equal(res.statusCode, 401);
    res = await app.inject({
      method: 'PUT',
      url: `/internal/guilds/${GUILD}`,
      headers: { authorization: 'Bearer wrong-secret-0123456789' },
      payload: { channelId: CHANNEL },
    });
    assert.equal(res.statusCode, 401);
    res = await app.inject({ method: 'GET', url: '/internal/guilds' });
    assert.equal(res.statusCode, 401);
  } finally {
    await app.close();
  }
});

test('GET /internal/guilds/:guildId is 404 for an unknown guild', async () => {
  const app = await testApp();
  try {
    const res = await get(app, `/internal/guilds/${GUILD}`);
    assert.equal(res.statusCode, 404);
    assert.deepEqual(res.json(), { error: 'unknown_guild' });
    assert.deepEqual((await get(app, '/internal/guilds')).json(), { items: [] });
  } finally {
    await app.close();
  }
});

test('PUT creates a guild, GET returns seedEmojis as an array', async () => {
  const app = await testApp();
  try {
    const created = await put(app, GUILD, { channelId: CHANNEL, seedEmojis: ['🍿', '🎯'] });
    assert.equal(created.statusCode, 200);
    assert.deepEqual(created.json(), {
      guildId: GUILD,
      channelId: CHANNEL,
      seedEmojis: ['🍿', '🎯'],
    });

    const res = await get(app, `/internal/guilds/${GUILD}`);
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.json(), {
      guildId: GUILD,
      channelId: CHANNEL,
      seedEmojis: ['🍿', '🎯'],
    });
    assert.ok(Array.isArray(res.json().seedEmojis));

    // The column itself holds the JSON text, not the array.
    const [row] = await app.db.select().from(guildSettings);
    assert.equal(row.seedEmojis, '["🍿","🎯"]');
    assert.ok(row.updatedAt instanceof Date);
  } finally {
    await app.close();
  }
});

test('PUT without seedEmojis falls back to the column default on a new row', async () => {
  const app = await testApp();
  try {
    const res = await put(app, GUILD, { channelId: CHANNEL });
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.json().seedEmojis, DEFAULT_EMOJIS);
  } finally {
    await app.close();
  }
});

test('PUT with only channelId keeps the stored emojis and refreshes updated_at', async () => {
  const app = await testApp();
  try {
    await put(app, GUILD, { channelId: CHANNEL, seedEmojis: ['🥇'] });
    const stale = new Date('2020-01-01T00:00:00Z');
    await app.db
      .update(guildSettings)
      .set({ updatedAt: stale })
      .where(eq(guildSettings.guildId, GUILD));

    const other = '444444444444444444';
    const res = await put(app, GUILD, { channelId: other });
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.json(), { guildId: GUILD, channelId: other, seedEmojis: ['🥇'] });

    const rows = await app.db.select().from(guildSettings);
    assert.equal(rows.length, 1, 'upsert must not insert a second row');
    assert.equal(rows[0].seedEmojis, '["🥇"]');
    assert.ok(rows[0].updatedAt > stale, 'updated_at should move forward');
  } finally {
    await app.close();
  }
});

test('PUT rejects a non-snowflake channelId, too many emojis and an empty one', async () => {
  const app = await testApp();
  try {
    for (const payload of [
      { channelId: 'general' },
      { channelId: '' },
      { channelId: CHANNEL, seedEmojis: ['1', '2', '3', '4', '5', '6'] },
      { channelId: CHANNEL, seedEmojis: [] },
      { channelId: CHANNEL, seedEmojis: [''] },
      {},
    ]) {
      const res = await put(app, GUILD, payload);
      assert.equal(res.statusCode, 400, `expected 400 for ${JSON.stringify(payload)}`);
      assert.equal(res.json().error, 'bad_request');
      assert.ok(Array.isArray(res.json().issues));
    }
    assert.deepEqual(await app.db.select().from(guildSettings), []);
  } finally {
    await app.close();
  }
});

test('GET /internal/guilds lists every guild in guild_id order', async () => {
  const app = await testApp();
  try {
    await put(app, '333333333333333333', { channelId: '1', seedEmojis: ['c'] });
    await put(app, '111111111111111111', { channelId: '2', seedEmojis: ['a'] });
    await put(app, '222222222222222222', { channelId: '3' });

    const res = await get(app, '/internal/guilds');
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.json(), {
      items: [
        { guildId: '111111111111111111', channelId: '2', seedEmojis: ['a'] },
        { guildId: '222222222222222222', channelId: '3', seedEmojis: DEFAULT_EMOJIS },
        { guildId: '333333333333333333', channelId: '1', seedEmojis: ['c'] },
      ],
    });
  } finally {
    await app.close();
  }
});
