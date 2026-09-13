// Translation tests. Nothing here touches Discord or the backend: localeForGuild takes a
// plain object with a getGuild method.

import assert from 'node:assert/strict';
import test from 'node:test';

import { DEFAULT_LOCALE, SUPPORTED_LOCALES } from '@cos-nostra/shared';

import { localeForGuild, resolveLocale, t } from '../src/i18n.js';
import { es } from '../src/locales/es.js';
import { en } from '../src/locales/en.js';

/** Every dot path that leads to a string, so the two dictionaries can be compared. */
function keyPaths(node, prefix = '') {
  if (typeof node === 'string') return [prefix];
  if (node === null || typeof node !== 'object') return [];
  return Object.entries(node).flatMap(([name, value]) =>
    keyPaths(value, prefix ? `${prefix}.${name}` : name),
  );
}

test('the default locale is Spanish and both dictionaries are supported', () => {
  assert.equal(DEFAULT_LOCALE, 'es');
  assert.deepEqual([...SUPPORTED_LOCALES].sort(), ['en', 'es']);
});

test('English covers every key Spanish has', () => {
  // Spanish is the fallback dictionary, so a key missing there is a reply that reads as a
  // dot path; a key missing in English is a silent switch back to Spanish mid-sentence.
  const spanish = keyPaths(es).sort();
  const english = keyPaths(en).sort();
  assert.deepEqual(english, spanish);
});

test('resolveLocale accepts the supported codes and defaults everything else', () => {
  assert.equal(resolveLocale('en'), 'en');
  assert.equal(resolveLocale('es'), 'es');
  for (const value of [undefined, null, '', 'fr', 'EN', 'es-419', 7, {}, ['en']]) {
    assert.equal(resolveLocale(value), DEFAULT_LOCALE, `resolveLocale(${JSON.stringify(value)})`);
  }
});

test('t looks a key up by dot path', () => {
  assert.equal(t('en', 'mine.title'), 'Your clips');
  assert.equal(t('es', 'mine.title'), 'Tus clips');
});

test('t substitutes every occurrence of a placeholder', () => {
  assert.equal(t('en', 'top.title', { year: 2026 }), 'Top clips of 2026');
  assert.equal(t('en', 'post.byOwner', { title: 'Ace', user: 'benja' }), 'Ace - by benja');
  // A placeholder with nothing to put in it is left visible rather than blanked out.
  assert.equal(t('en', 'top.title', {}), 'Top clips of {year}');
  assert.equal(t('en', 'top.title'), 'Top clips of {year}');
});

test('t falls back to Spanish for a key the locale is missing', () => {
  const missing = 'setup.seedLine';
  assert.ok(keyPaths(es).includes(missing));
  // Simulated by asking for a locale that has no dictionary at all: it resolves to Spanish.
  assert.equal(t('fr', missing, { emojis: '🔥' }), t('es', missing, { emojis: '🔥' }));
});

test('t returns the key itself rather than throwing on a missing translation', () => {
  assert.equal(t('en', 'nope.not.here'), 'nope.not.here');
  assert.equal(t('es', 'nope.not.here'), 'nope.not.here');
  // A path that stops on a nested object is as missing as one that stops on nothing.
  assert.equal(t('en', 'setup.languages'), 'setup.languages');
  assert.equal(t('en', ''), '');
});

test('localeForGuild reads the language off the guild config', async () => {
  const asked = [];
  const backend = {
    getGuild: async (guildId) => {
      asked.push(guildId);
      return { guildId, channelId: 'c1', seedEmojis: [], locale: 'en' };
    },
  };
  assert.equal(await localeForGuild(backend, 'guild-1'), 'en');
  assert.deepEqual(asked, ['guild-1']);
});

test('localeForGuild defaults for a DM, an unknown guild and a broken backend', async () => {
  const never = { getGuild: async () => assert.fail('no guild to read') };
  for (const guildId of [null, undefined, '']) {
    assert.equal(await localeForGuild(never, guildId), DEFAULT_LOCALE);
  }
  // A guild nobody has set up, a backend that is down, and one with no getGuild at all.
  assert.equal(await localeForGuild({ getGuild: async () => null }, 'g1'), DEFAULT_LOCALE);
  assert.equal(
    await localeForGuild(
      {
        getGuild: async () => {
          throw new Error('502');
        },
      },
      'g1',
    ),
    DEFAULT_LOCALE,
  );
  assert.equal(await localeForGuild({}, 'g1'), DEFAULT_LOCALE);
  assert.equal(await localeForGuild(undefined, 'g1'), DEFAULT_LOCALE);
});

test('localeForGuild sanitises a language the backend should never have stored', async () => {
  const backend = { getGuild: async () => ({ guildId: 'g1', locale: 'fr' }) };
  assert.equal(await localeForGuild(backend, 'g1'), DEFAULT_LOCALE);
});
