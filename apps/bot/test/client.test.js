// The gateway client options. Nothing here connects: clientOptions is a plain object and
// createClient() builds a discord.js Client without logging in, which is what index.js does
// before it calls login().
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { GatewayIntentBits, Partials } from 'discord.js';

import { clientOptions, createClient } from '../src/client.js';

test('the client never mentions anyone by default', () => {
  // Clip titles and usernames go into message content, so an "@everyone" title must not be
  // able to ping the server. parse: [] is what stops it; an empty array, not a missing key.
  assert.deepEqual(clientOptions.allowedMentions, { parse: [], repliedUser: false });
});

test('the client requests the partials reaction tracking needs', () => {
  // Partials.User is as load-bearing as the other two: without it discord.js never emits
  // messageReactionRemove for a user that is not cached, so un-reactions after a deploy are
  // dropped and the open vote rows keep counting.
  assert.deepEqual([...clientOptions.partials].sort(), [
    Partials.Message,
    Partials.Reaction,
    Partials.User,
  ].sort());
});

test('the client asks for the three intents the bot uses and no more', () => {
  assert.deepEqual(clientOptions.intents, [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.GuildMessageReactions,
  ]);
});

test('createClient builds a client discord.js accepts, still logged out', () => {
  const client = createClient();
  try {
    assert.equal(client.token, null);
    // discord.js normalizes the options it was given; the mention default must survive that.
    assert.deepEqual(client.options.allowedMentions, { parse: [], repliedUser: false });
    assert.ok(client.options.partials.includes(Partials.User));
  } finally {
    client.destroy();
  }
});
