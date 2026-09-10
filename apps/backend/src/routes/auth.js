// Device login through Discord OAuth (docs/PLAN.md, "Auth").
//
//   POST   /auth/device            desktop starts a login, gets a code and a URL to open
//   GET    /auth/discord/start     browser lands here with ?device=CODE, is sent to Discord
//   GET    /auth/discord/callback  Discord sends the user back; links the device
//   GET    /auth/device/:code      desktop polls until the token is ready
//   GET    /auth/me                who am I (device token)
//   DELETE /auth/device            revoke the current device
//
// The pending login lives in `device_logins`. Once the desktop has collected the token the
// row is deleted, so a code can never hand out the same token twice.

import { and, eq, gt, lt } from 'drizzle-orm';
import { z } from 'zod';

import { schema } from '../db/index.js';
import { authorizeUrl, exchangeCode, fetchUser } from '../lib/discord.js';
import { CODE_ALPHABET, hashToken, newLoginCode, newToken } from '../lib/tokens.js';

const LOGIN_TTL_MS = 10 * 60 * 1000;
const CODE_PATTERN = new RegExp(`^[${CODE_ALPHABET}]{8}$`);

const startBody = z.object({
  deviceName: z.string().trim().min(1).max(100),
});
const codeParam = z.object({ code: z.string().trim().toUpperCase().regex(CODE_PATTERN) });
const startQuery = z.object({ device: z.string().trim().toUpperCase().regex(CODE_PATTERN) });
const callbackQuery = z.object({
  code: z.string().min(1).optional(),
  state: z.string().min(1),
  error: z.string().optional(),
  error_description: z.string().optional(),
});

function escapeHtml(s) {
  return String(s).replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
  );
}

/** Tiny standalone page; the browser tab is the only UI the OAuth dance has. */
function page(title, message) {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(title)} - Cos Nostra</title>
<style>
  body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;
       font:16px/1.5 system-ui,sans-serif;background:#111;color:#eee}
  main{max-width:28rem;padding:2rem;text-align:center}
  h1{font-size:1.4rem;margin:0 0 .5rem}
  p{margin:0;color:#bbb}
</style></head>
<body><main><h1>${escapeHtml(title)}</h1><p>${escapeHtml(message)}</p></main></body></html>`;
}

function badRequest(reply, issues) {
  return reply.code(400).send({ error: 'bad_request', issues });
}

/** @param {import('fastify').FastifyInstance} app */
export default async function authRoutes(app) {
  const { db, config } = app;

  async function deleteExpiredLogins() {
    try {
      await db.delete(schema.deviceLogins).where(lt(schema.deviceLogins.expiresAt, new Date()));
    } catch (err) {
      app.log.warn({ err }, 'could not delete expired device logins');
    }
  }

  /** Returns the live login row for a code, or null if unknown or expired. */
  async function findLogin(code) {
    const rows = await db
      .select()
      .from(schema.deviceLogins)
      .where(and(eq(schema.deviceLogins.code, code), gt(schema.deviceLogins.expiresAt, new Date())))
      .limit(1);
    return rows[0] ?? null;
  }

  app.post(
    '/auth/device',
    { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } },
    async (request, reply) => {
      const parsed = startBody.safeParse(request.body ?? {});
      if (!parsed.success) return badRequest(reply, parsed.error.issues);

      await deleteExpiredLogins();
      const expiresAt = new Date(Date.now() + LOGIN_TTL_MS);
      let code;
      // The code space is 32^8; a collision is unlikely but cheap to retry.
      for (let attempt = 0; ; attempt++) {
        code = newLoginCode();
        try {
          await db
            .insert(schema.deviceLogins)
            .values({ code, deviceName: parsed.data.deviceName, expiresAt });
          break;
        } catch (err) {
          if (attempt >= 3) throw err;
        }
      }
      return {
        code,
        verifyUrl: `${config.PUBLIC_URL}/auth/discord/start?device=${code}`,
        expiresIn: Math.floor(LOGIN_TTL_MS / 1000),
      };
    },
  );

  app.get('/auth/discord/start', async (request, reply) => {
    const parsed = startQuery.safeParse(request.query);
    const login = parsed.success ? await findLogin(parsed.data.device) : null;
    if (!login) {
      return reply
        .code(400)
        .type('text/html')
        .send(page('Unknown or expired code', 'Start the login again from the Cos Nostra app.'));
    }
    const state = app.jwt.sign({ device: login.code }, { expiresIn: '10m' });
    return reply.redirect(authorizeUrl(config, state), 302);
  });

  app.get('/auth/discord/callback', async (request, reply) => {
    const html = (status, title, message) =>
      reply.code(status).type('text/html').send(page(title, message));

    const parsed = callbackQuery.safeParse(request.query);
    if (!parsed.success) return html(400, 'Login failed', 'The callback was missing parameters.');
    const q = parsed.data;

    let deviceCode;
    try {
      deviceCode = app.jwt.verify(q.state).device;
    } catch (err) {
      app.log.info({ err }, 'oauth callback with bad state');
      return html(400, 'Login failed', 'This login link is invalid or has expired.');
    }
    if (typeof deviceCode !== 'string') {
      return html(400, 'Login failed', 'This login link is invalid.');
    }

    const login = await findLogin(deviceCode);
    if (!login) {
      return html(400, 'Unknown or expired code', 'Start the login again from the Cos Nostra app.');
    }
    if (login.deviceId) {
      return html(400, 'Already linked', 'This code was already used. Start a new login if needed.');
    }
    if (q.error || !q.code) {
      app.log.info({ error: q.error, description: q.error_description }, 'discord denied login');
      return html(400, 'Login cancelled', 'Discord did not authorize the login. You can close this tab.');
    }

    let discordUser;
    try {
      const { accessToken } = await exchangeCode(config, q.code);
      discordUser = await fetchUser(config, accessToken);
    } catch (err) {
      app.log.error({ err }, 'discord oauth failed');
      return html(502, 'Login failed', 'Discord could not be reached. Try again in a moment.');
    }

    const token = newToken();
    await db.transaction(async (tx) => {
      const [user] = await tx
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
      const [device] = await tx
        .insert(schema.devices)
        .values({ userId: user.id, name: login.deviceName, tokenHash: hashToken(token) })
        .returning({ id: schema.devices.id });
      await tx
        .update(schema.deviceLogins)
        .set({ deviceId: device.id, token })
        .where(eq(schema.deviceLogins.id, login.id));
    });

    app.log.info({ discordId: discordUser.id, device: login.deviceName }, 'device linked');
    return html(200, 'Device linked', 'You can close this tab and go back to the Cos Nostra app.');
  });

  app.get('/auth/device/:code', async (request, reply) => {
    const parsed = codeParam.safeParse(request.params);
    if (!parsed.success) return reply.code(404).send({ error: 'unknown_code' });

    await deleteExpiredLogins();
    const login = await findLogin(parsed.data.code);
    if (!login) return reply.code(404).send({ error: 'unknown_code' });
    if (!login.deviceId || !login.token) return { status: 'pending' };

    // Hand the token out exactly once: the row goes away with it.
    const [claimed] = await db
      .delete(schema.deviceLogins)
      .where(and(eq(schema.deviceLogins.id, login.id), eq(schema.deviceLogins.token, login.token)))
      .returning({ token: schema.deviceLogins.token });
    if (!claimed) return reply.code(404).send({ error: 'unknown_code' });

    const [row] = await db
      .select({
        id: schema.users.id,
        discordId: schema.users.discordId,
        username: schema.users.username,
        avatar: schema.users.avatar,
      })
      .from(schema.devices)
      .innerJoin(schema.users, eq(schema.users.id, schema.devices.userId))
      .where(eq(schema.devices.id, login.deviceId))
      .limit(1);
    return { status: 'ready', token: claimed.token, user: row ?? null };
  });

  app.get('/auth/me', { preHandler: app.authenticateDevice }, async (request) => ({
    user: request.user,
    device: request.device,
  }));

  app.delete('/auth/device', { preHandler: app.authenticateDevice }, async (request, reply) => {
    await db.delete(schema.devices).where(eq(schema.devices.id, request.device.id));
    app.log.info({ userId: request.user.id, deviceId: request.device.id }, 'device revoked');
    return reply.code(204).send();
  });
}
