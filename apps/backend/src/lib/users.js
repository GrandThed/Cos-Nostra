// Shared "log this Discord user in" step. Both the desktop device flow (routes/auth.js) and
// the browser flow (routes/login.js) end at the same place: upsert the user by discordId,
// refreshing username/avatar, then issue whatever credential that flow hands out.

import { schema } from '../db/index.js';

/**
 * @param {import('../db/index.js').Database['db']} dbOrTx
 * @param {import('./discord.js').DiscordUser} discordUser
 * @returns {Promise<{ id: number }>}
 */
export async function upsertDiscordUser(dbOrTx, discordUser) {
  const [user] = await dbOrTx
    .insert(schema.users)
    .values({
      discordId: discordUser.id,
      username: discordUser.username,
      avatar: discordUser.avatar,
    })
    .onConflictDoUpdate({
      target: schema.users.discordId,
      set: { username: discordUser.username, avatar: discordUser.avatar },
    })
    .returning({ id: schema.users.id });
  return user;
}
