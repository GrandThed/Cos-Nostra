// loadConfig is the only thing between a typo in a Railway variable and a bot that boots
// half configured, so every branch is exercised here, including the multi-problem message.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { loadConfig } from '../src/config.js';

/** A minimal environment that passes. Tests copy it and break one thing. */
const valid = () => ({
  DISCORD_TOKEN: 'discord-token',
  DISCORD_CLIENT_ID: '1234567890',
  BOT_SHARED_SECRET: 'a'.repeat(16),
  BACKEND_URL: 'http://localhost:3000',
});

/** @param {Record<string, string | undefined>} env */
const problems = (env) => {
  try {
    loadConfig(env);
  } catch (err) {
    return err.message;
  }
  return null;
};

test('a valid environment returns the parsed config with defaults applied', () => {
  const config = loadConfig(valid());
  assert.deepEqual(config, {
    DISCORD_TOKEN: 'discord-token',
    DISCORD_CLIENT_ID: '1234567890',
    BOT_SHARED_SECRET: 'a'.repeat(16),
    BACKEND_URL: 'http://localhost:3000',
    BOT_PORT: 3001,
    DISCORD_DEV_GUILD_ID: undefined,
    LOG_LEVEL: 'info',
  });
});

test('optional variables are read when set', () => {
  const config = loadConfig({
    ...valid(),
    BOT_PORT: '4000',
    DISCORD_DEV_GUILD_ID: '999',
    LOG_LEVEL: 'debug',
  });
  assert.equal(config.BOT_PORT, 4000);
  assert.equal(typeof config.BOT_PORT, 'number');
  assert.equal(config.DISCORD_DEV_GUILD_ID, '999');
  assert.equal(config.LOG_LEVEL, 'debug');
});

test('trailing slashes are stripped from BACKEND_URL', () => {
  assert.equal(loadConfig({ ...valid(), BACKEND_URL: 'https://x.test///' }).BACKEND_URL, 'https://x.test');
  assert.equal(
    loadConfig({ ...valid(), BACKEND_URL: 'https://x.test/api/' }).BACKEND_URL,
    'https://x.test/api',
  );
});

test('values are trimmed, so a pasted token with a newline still works', () => {
  const config = loadConfig({
    DISCORD_TOKEN: '  token  ',
    DISCORD_CLIENT_ID: '1\n',
    BOT_SHARED_SECRET: ` ${'s'.repeat(16)}\n`,
    BACKEND_URL: ' http://localhost:3000 ',
  });
  assert.equal(config.DISCORD_TOKEN, 'token');
  assert.equal(config.DISCORD_CLIENT_ID, '1');
  assert.equal(config.BOT_SHARED_SECRET, 's'.repeat(16));
  assert.equal(config.BACKEND_URL, 'http://localhost:3000');
});

test('an empty optional variable falls back to the default', () => {
  // Railway sets variables you cleared to the empty string rather than unsetting them.
  const config = loadConfig({ ...valid(), BOT_PORT: '', DISCORD_DEV_GUILD_ID: '', LOG_LEVEL: '' });
  assert.equal(config.BOT_PORT, 3001);
  assert.equal(config.DISCORD_DEV_GUILD_ID, undefined);
  assert.equal(config.LOG_LEVEL, 'info');
});

test('each required variable is reported by name when missing', () => {
  for (const name of ['DISCORD_TOKEN', 'DISCORD_CLIENT_ID', 'BOT_SHARED_SECRET', 'BACKEND_URL']) {
    const env = valid();
    delete env[name];
    const message = problems(env);
    assert.match(message, /^invalid environment:\n/);
    assert.match(message, new RegExp(`\n {2}${name}: required$`, 'm'));
  }
});

test('an empty required variable counts as missing', () => {
  assert.match(problems({ ...valid(), DISCORD_TOKEN: '   ' }), /DISCORD_TOKEN: required/);
});

test('BOT_SHARED_SECRET must be at least 16 characters', () => {
  const message = problems({ ...valid(), BOT_SHARED_SECRET: 'short' });
  assert.match(message, /BOT_SHARED_SECRET: must be at least 16 characters/);
  // Exactly 16 is fine.
  assert.equal(loadConfig({ ...valid(), BOT_SHARED_SECRET: 'b'.repeat(16) }).BOT_SHARED_SECRET.length, 16);
});

test('BACKEND_URL must be an http or https URL', () => {
  for (const bad of ['not a url', 'localhost:3000', 'ftp://x.test', 'ws://x.test', '/relative']) {
    assert.match(
      problems({ ...valid(), BACKEND_URL: bad }),
      /BACKEND_URL: must be an http or https URL/,
      `expected ${bad} to be rejected`,
    );
  }
  assert.equal(loadConfig({ ...valid(), BACKEND_URL: 'https://a.b' }).BACKEND_URL, 'https://a.b');
});

test('BOT_PORT must be an integer in range', () => {
  for (const bad of ['abc', '3000.5', '-1', '70000', '3000abc']) {
    assert.match(
      problems({ ...valid(), BOT_PORT: bad }),
      /BOT_PORT: must be an integer between 0 and 65535/,
      `expected ${bad} to be rejected`,
    );
  }
  // 0 is allowed: the tests bind an ephemeral port with it.
  assert.equal(loadConfig({ ...valid(), BOT_PORT: '0' }).BOT_PORT, 0);
});

test('every problem is listed at once, one indented line each', () => {
  const message = problems({ BOT_SHARED_SECRET: 'tooshort', BACKEND_URL: 'nope' });
  assert.equal(
    message,
    [
      'invalid environment:',
      '  DISCORD_TOKEN: required',
      '  DISCORD_CLIENT_ID: required',
      '  BOT_SHARED_SECRET: must be at least 16 characters',
      '  BACKEND_URL: must be an http or https URL',
    ].join('\n'),
  );
});

test('an entirely empty environment lists all four required variables', () => {
  const message = problems({});
  assert.equal(message.split('\n').length, 5);
  assert.ok(message.includes('  BACKEND_URL: required'));
});
