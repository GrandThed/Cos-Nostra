// Browser session auth for the public clip site's login (routes/login.js). Mirrors
// plugins/auth.js's authenticateDevice exactly, but the credential travels in a cookie
// instead of a Bearer header: a random token, only its hash stored in `browser_sessions`, so
// a session can be revoked (logout) by deleting the row - something a sealed cookie or a bare
// JWT could not do. @fastify/jwt (already registered by plugins/auth.js) stays scoped to the
// short-lived OAuth `state` value; it is never used for anything meant to persist.
//
// Exported without an encapsulation context so app.authenticateSession is visible app-wide,
// the same way plugins/auth.js's decorators are.

import cookie from '@fastify/cookie';
import { eq } from 'drizzle-orm';

import { schema } from '../db/index.js';
import { hashToken, newToken } from '../lib/tokens.js';

const LAST_SEEN_INTERVAL_MS = 5 * 60 * 1000;
const SESSION_TTL_MS = 90 * 24 * 60 * 60 * 1000; // 90 days
export const SESSION_COOKIE_NAME = 'cn_session';

/** @param {import('fastify').FastifyInstance} app */
async function plugin(app) {
  await app.register(cookie, { secret: app.config.SESSION_COOKIE_SECRET });

  /**
   * @param {number} userId
   * @returns {Promise<{ token: string, expiresAt: Date }>}
   */
  async function createBrowserSession(userId) {
    const token = newToken();
    const expiresAt = new Date(Date.now() + SESSION_TTL_MS);
    await app.db.insert(schema.browserSessions).values({
      userId,
      tokenHash: hashToken(token),
      expiresAt,
    });
    return { token, expiresAt };
  }

  /** @param {string} token */
  async function destroyBrowserSession(token) {
    await app.db.delete(schema.browserSessions).where(eq(schema.browserSessions.tokenHash, hashToken(token)));
  }

  /** Shared so setting and clearing the cookie can never drift apart. */
  function sessionCookieOptions() {
    return {
      path: '/',
      httpOnly: true,
      secure: 'auto',
      sameSite: 'lax',
      signed: true,
      maxAge: Math.floor(SESSION_TTL_MS / 1000),
    };
  }

  /** @type {import('fastify').preHandlerAsyncHookHandler} */
  async function authenticateSession(request, reply) {
    const raw = request.cookies[SESSION_COOKIE_NAME];
    const unsigned = raw ? request.unsignCookie(raw) : null;
    if (!unsigned?.valid || !unsigned.value) return reply.code(401).send({ error: 'unauthorized' });

    const rows = await app.db
      .select({
        sessionId: schema.browserSessions.id,
        expiresAt: schema.browserSessions.expiresAt,
        lastSeen: schema.browserSessions.lastSeen,
        userId: schema.users.id,
        discordId: schema.users.discordId,
        username: schema.users.username,
        avatar: schema.users.avatar,
      })
      .from(schema.browserSessions)
      .innerJoin(schema.users, eq(schema.users.id, schema.browserSessions.userId))
      .where(eq(schema.browserSessions.tokenHash, hashToken(unsigned.value)))
      .limit(1);
    const row = rows[0];
    if (!row || row.expiresAt.getTime() < Date.now()) {
      return reply.code(401).send({ error: 'unauthorized' });
    }

    request.user = {
      id: row.userId,
      discordId: row.discordId,
      username: row.username,
      avatar: row.avatar,
    };

    const now = Date.now();
    if (!row.lastSeen || now - row.lastSeen.getTime() > LAST_SEEN_INTERVAL_MS) {
      app.db
        .update(schema.browserSessions)
        .set({ lastSeen: new Date(now) })
        .where(eq(schema.browserSessions.id, row.sessionId))
        .catch((err) => app.log.warn({ err }, 'could not update browser_sessions.last_seen'));
    }
  }

  app.decorate('createBrowserSession', createBrowserSession);
  app.decorate('destroyBrowserSession', destroyBrowserSession);
  app.decorate('sessionCookieOptions', sessionCookieOptions);
  app.decorate('authenticateSession', authenticateSession);
}

plugin[Symbol.for('skip-override')] = true;
export default plugin;
