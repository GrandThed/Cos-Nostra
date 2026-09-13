// Browser login through Discord OAuth, for the public clip site (docs/PLAN.md phase 5).
// Distinct from the desktop's device-code flow in routes/auth.js: this is a direct button
// click on our own site, not a link that could be mailed to a stranger, so there is no
// interstitial confirmation page - clicking "Log in with Discord" goes straight to Discord.
//
//   GET  /login?next=<path>   redirect to Discord
//   GET  /login/callback      Discord sends the user back; sets the session cookie
//   POST /logout              clears the session cookie and revokes it server-side
//
// plugins/session.js (app.createBrowserSession, app.sessionCookieOptions, ...) is registered
// by app.js alongside plugins/auth.js, before this file, the same way plugins/storage.js is.

import { z } from 'zod';

import { SESSION_COOKIE_NAME } from '../plugins/session.js';
import { authorizeUrl, exchangeCode, fetchUser } from '../lib/discord.js';
import { upsertDiscordUser } from '../lib/users.js';

const CALLBACK_PATH = '/login/callback';
const STATE_TTL = '10m';

// Only a same-origin relative path is a safe redirect target: "//evil.com" and
// "https://evil.com" are both rejected by requiring a single leading slash.
const NEXT_PATTERN = /^\/(?!\/)/;
const nextQuery = z.object({ next: z.string().max(2048).regex(NEXT_PATTERN).optional() });
const callbackQuery = z.object({
  code: z.string().min(1).optional(),
  state: z.string().min(1),
  error: z.string().optional(),
});

function safeNext(next) {
  return next && NEXT_PATTERN.test(next) ? next : '/';
}

/** @type {import('fastify').FastifyPluginAsync} */
export default async function loginRoutes(app) {
  const { config } = app;

  app.get('/login', async (request, reply) => {
    const parsed = nextQuery.safeParse(request.query);
    const next = safeNext(parsed.success ? parsed.data.next : undefined);
    const state = app.jwt.sign({ next }, { expiresIn: STATE_TTL });
    return reply.redirect(authorizeUrl(config, state, CALLBACK_PATH), 302);
  });

  app.get('/login/callback', async (request, reply) => {
    const parsed = callbackQuery.safeParse(request.query);
    if (!parsed.success) return reply.code(400).send({ error: 'bad_request' });
    const q = parsed.data;

    let next = '/';
    try {
      next = safeNext(app.jwt.verify(q.state).next);
    } catch (err) {
      app.log.info({ err }, 'browser login callback with bad state');
      return reply.code(400).send({ error: 'invalid_state' });
    }

    if (q.error || !q.code) {
      app.log.info({ error: q.error }, 'discord denied browser login');
      return reply.redirect(next, 302);
    }

    let discordUser;
    try {
      const { accessToken } = await exchangeCode(config, q.code, CALLBACK_PATH);
      discordUser = await fetchUser(config, accessToken);
    } catch (err) {
      app.log.error({ err }, 'discord oauth failed (browser login)');
      return reply.code(502).send({ error: 'discord_unreachable' });
    }

    const user = await upsertDiscordUser(app.db, discordUser);
    const { token } = await app.createBrowserSession(user.id);
    reply.setCookie(SESSION_COOKIE_NAME, token, app.sessionCookieOptions());
    app.log.info({ discordId: discordUser.id }, 'browser session started');
    return reply.redirect(next, 302);
  });

  app.post('/logout', async (request, reply) => {
    const raw = request.cookies[SESSION_COOKIE_NAME];
    const unsigned = raw ? request.unsignCookie(raw) : null;
    if (unsigned?.valid && unsigned.value) {
      await app.destroyBrowserSession(unsigned.value);
    }
    reply.clearCookie(SESSION_COOKIE_NAME, { path: '/' });
    const parsed = nextQuery.safeParse(request.query);
    return reply.redirect(safeNext(parsed.success ? parsed.data.next : undefined), 302);
  });
}
