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
// What a guild row answers with when nobody has configured these: tagging is on by default and
// the clip-site fields are only set by `/clips setup`. Spread into the whole-object assertions
// so adding a column means changing this line, not every test.
const UNCONFIGURED = { tagVoiceMembers: true, name: null, icon: null, slug: null };

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
      locale: 'es',
      ...UNCONFIGURED,
    });

    const res = await get(app, `/internal/guilds/${GUILD}`);
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.json(), {
      guildId: GUILD,
      channelId: CHANNEL,
      seedEmojis: ['🍿', '🎯'],
      locale: 'es',
      ...UNCONFIGURED,
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
    assert.deepEqual(res.json(), {
      guildId: GUILD,
      channelId: other,
      seedEmojis: ['🥇'],
      locale: 'es',
      ...UNCONFIGURED,
    });

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
        { guildId: '111111111111111111', channelId: '2', seedEmojis: ['a'], locale: 'es', ...UNCONFIGURED },
        { guildId: '222222222222222222', channelId: '3', seedEmojis: DEFAULT_EMOJIS, locale: 'es', ...UNCONFIGURED },
        { guildId: '333333333333333333', channelId: '1', seedEmojis: ['c'], locale: 'es', ...UNCONFIGURED },
      ],
    });
  } finally {
    await app.close();
  }
});

test('PUT round-trips tagVoiceMembers and leaves it alone when omitted', async () => {
  const app = await testApp();
  try {
    // On by default, so the interesting value is false - and `false` is exactly the value a
    // truthiness check would silently drop.
    const created = await put(app, GUILD, { channelId: CHANNEL });
    assert.equal(created.json().tagVoiceMembers, true, 'guilds tag by default');

    const off = await put(app, GUILD, { channelId: CHANNEL, tagVoiceMembers: false });
    assert.equal(off.statusCode, 200);
    assert.equal(off.json().tagVoiceMembers, false);
    assert.equal((await get(app, `/internal/guilds/${GUILD}`)).json().tagVoiceMembers, false);

    // A later PUT that only moves the channel must not turn tagging back on.
    const moved = await put(app, GUILD, { channelId: '444444444444444444' });
    assert.equal(moved.json().channelId, '444444444444444444');
    assert.equal(moved.json().tagVoiceMembers, false, 'omitting it must leave it alone');

    const on = await put(app, GUILD, { channelId: CHANNEL, tagVoiceMembers: true });
    assert.equal(on.json().tagVoiceMembers, true);

    const bad = await put(app, GUILD, { channelId: CHANNEL, tagVoiceMembers: 'yes' });
    assert.equal(bad.statusCode, 400);
    assert.equal(bad.json().error, 'bad_request');

    const rows = await app.db.select().from(guildSettings);
    assert.equal(rows.length, 1, 'upsert must not insert a second row');
    assert.equal(rows[0].tagVoiceMembers, true, 'the column is a real boolean');
  } finally {
    await app.close();
  }
});

test('PUT accepts a locale, GET returns it, and an unknown locale is rejected', async () => {
  const app = await testApp();
  try {
    const res = await put(app, GUILD, { channelId: CHANNEL, locale: 'en' });
    assert.equal(res.statusCode, 200);
    assert.equal(res.json().locale, 'en');

    const kept = await put(app, GUILD, { channelId: CHANNEL });
    assert.equal(kept.json().locale, 'en', 'omitting locale must leave it alone');

    const bad = await put(app, GUILD, { channelId: CHANNEL, locale: 'fr' });
    assert.equal(bad.statusCode, 400);
  } finally {
    await app.close();
  }
});
