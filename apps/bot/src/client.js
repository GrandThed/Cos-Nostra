// Gateway client options.
//
// They live apart from index.js because index.js logs in as soon as it is imported: a test
// that wants to assert on these options cannot import that file. Everything security
// relevant about the client is in this one object.

import { Client, GatewayIntentBits, Partials } from 'discord.js';

/**
 * Options for the gateway client.
 *
 * `allowedMentions: { parse: [] }` is the one that matters most: it strips @everyone, @here,
 * role and user mentions out of everything the bot sends. Clip titles are typed by whoever
 * recorded the clip and the /clips top `game` option is free text from any member, and both
 * end up in message content, so without this a title of "@everyone" would ping the server.
 * `repliedUser: false` keeps a reply from pinging the person it answers. post.js and
 * commands.js pass `allowedMentions` on their payloads as well, so changing this default can
 * never silently re-open the hole.
 *
 * Partials cover reactions on messages the bot never saw, which is every message after a
 * deploy. `Partials.User` is as necessary as the other two: without it discord.js drops
 * `messageReactionRemove` entirely whenever the reacting user is not in the cache (its
 * MessageReactionRemove action returns early when getUser() has nothing), so an un-reaction
 * would leave the vote row open forever and the rankings would keep counting it.
 *
 * `GuildVoiceStates` keeps `guild.voiceStates.cache` filled, which is the whole of
 * POST /voice-snapshot in server.js: the desktop app asks who was in the recorder's voice
 * channel at the moment the hotkey was pressed, and those people get mentioned on the post.
 * It is not a privileged intent, so nothing has to be toggled in the developer portal.
 *
 * `GuildMembers` is deliberately *not* requested. A voice state carries the user id on the
 * gateway payload whatever the intents are, and `<@id>` renders the right name client-side
 * without the bot ever holding a GuildMember or User object, so the snapshot needs nothing
 * more. The accepted cost is that a *bot* sitting in the same voice channel cannot be told
 * apart from a person and would be mentioned like one; fixing that would mean asking for a
 * privileged intent to cache members, which is not worth it for a music bot in the corner.
 *
 * @type {import('discord.js').ClientOptions}
 */
export const clientOptions = {
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.GuildMessageReactions,
    GatewayIntentBits.GuildVoiceStates,
  ],
  partials: [Partials.Message, Partials.Reaction, Partials.User],
  allowedMentions: { parse: [], repliedUser: false },
};

/**
 * The gateway client, unconnected. Kept as a function so index.js never re-states the options.
 * @returns {Client}
 */
export function createClient() {
  return new Client(clientOptions);
}
