// Desktop -> Discord lookups that only the bot's gateway connection can answer. The desktop
// has no Discord session of its own (it holds a device token, not an OAuth token with guild
// scopes), so it asks the backend, which asks the bot over its internal HTTP server.
//
// Two questions, with opposite failure rules:
//
// POST /discord/voice-snapshot is asked the instant the record hotkey is pressed: who else is
// in my voice channel? The answer rides along with POST /clips as participantDiscordIds and
// becomes the @mentions on the Discord post. It never fails. A lookup that times out, a bot
// that is down, a backend with no BOT_INTERNAL_URL: all of them answer `{ participants: [] }`,
// because the caller is in the middle of saving a clip and a missing mention is not worth
// losing it over.
//
// GET /discord/guilds fills the publish dialog: which servers can I post this clip to? That
// one does fail, with a 503, when the bot cannot answer. An empty list would read as "you are
// in none of the servers", and the user would publish web-only without meaning to.

import { asc } from 'drizzle-orm';

import { guildSettings } from '../db/schema.js';
import { guildSummary } from '../lib/publish.js';

/** @param {import('fastify').FastifyInstance} app */
export default async function discordRoutes(app) {
  // Device auth comes from plugins/auth.js; resolved per request so registration order does
  // not matter and tests can substitute their own. Same shape as routes/clips.js.
  function deviceAuth(request, reply, done) {
    if (typeof app.authenticateDevice !== 'function') {
      app.log.error('authenticateDevice decorator missing');
      return reply.code(503).send({ error: 'auth_unavailable' });
    }
    return app.authenticateDevice(request, reply, done);
  }

  // The caller cannot name whose voice channel to look in: it is always the authenticated
  // user's own. Asking about somebody else would be a way to probe who is online and where,
  // using nothing but a device token.
  app.post('/discord/voice-snapshot', { preHandler: deviceAuth }, async (request) => {
    // plugins/bot.js is registered by routes/internal.js; if that file is not present in this
    // build there is no bot to ask, which is the same answer as a bot that cannot say.
    if (!app.hasDecorator('voiceSnapshot')) return { participants: [] };
    return app.voiceSnapshot(request.user.discordId);
  });

  // The guilds the caller may publish to: configured with `/clips setup` (so there is a channel
  // to post in) and confirmed by the bot to have the caller as a member. Membership is asked
  // for the caller only, for the same reason as the voice snapshot. It is checked again by the
  // bot at post time, so this list is a convenience for the dialog, not the enforcement.
  app.get('/discord/guilds', { preHandler: deviceAuth }, async (request, reply) => {
    const rows = await app.db
      .select({
        guildId: guildSettings.guildId,
        name: guildSettings.name,
        icon: guildSettings.icon,
        slug: guildSettings.slug,
      })
      .from(guildSettings)
      .orderBy(asc(guildSettings.name), asc(guildSettings.guildId));
    if (rows.length === 0) return { items: [] };

    // Without plugins/bot.js there is no bot, which is the local-dev case the decorator itself
    // handles for an unset BOT_INTERNAL_URL: every configured guild.
    let members = rows.map((r) => r.guildId);
    if (app.hasDecorator('memberGuilds')) {
      try {
        members = await app.memberGuilds(request.user.discordId, members);
      } catch (err) {
        request.log.warn({ err: err?.message ?? String(err) }, 'memberGuilds failed');
        return reply.code(503).send({ error: 'bot_unavailable' });
      }
    }
    const allowed = new Set(members);
    return { items: rows.filter((r) => allowed.has(r.guildId)).map(guildSummary) };
  });
}
