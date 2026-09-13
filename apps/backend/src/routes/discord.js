// Desktop -> Discord lookups that only the bot's gateway connection can answer. The desktop
// has no Discord session of its own (it holds a device token, not an OAuth token with guild
// scopes), so it asks the backend, which asks the bot over its internal HTTP server.
//
// Today that is one question, asked the instant the record hotkey is pressed: who else is in
// my voice channel? The answer rides along with POST /clips as participantDiscordIds and
// becomes the @mentions on the Discord post.
//
// Nothing here ever fails. A voice lookup that times out, a bot that is down, a backend with
// no BOT_INTERNAL_URL configured: all of them answer `{ participants: [] }`, because the
// caller is in the middle of saving a clip and a missing mention is not worth losing it over.

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
}
