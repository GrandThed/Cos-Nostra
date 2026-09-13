// Device login through Discord OAuth (docs/PLAN.md, "Auth").
//
//   POST   /auth/device            desktop starts a login, gets a code, a URL and a poll secret
//   GET    /auth/discord/start     browser lands here with ?device=CODE, sees a confirmation page
//   POST   /auth/discord/start     the Continue button on that page; sends the user to Discord
//   GET    /auth/discord/callback  Discord sends the user back; links the device
//   GET    /auth/device/:code      desktop polls until the token is ready (needs the poll secret)
//   GET    /auth/me                who am I (device token)
//   DELETE /auth/device            revoke the current device
//
// The pending login lives in `device_logins`. Once the desktop has collected the token the
// row is deleted, so a code can never hand out the same token twice.
//
// Two things keep the flow from being phishable:
//
//  - GET /auth/discord/start never redirects to Discord. It renders an interstitial naming the
//    device and showing the code, and only the POST behind its Continue button starts the OAuth
//    dance. A link mailed to a victim now asks them to check the code against their own screen
//    instead of silently linking the attacker's device to their Discord account. That POST
//    refuses a cross-origin Origin header, so an auto-submitting form cannot stand in for the
//    click either.
//  - The code alone cannot collect the token. POST /auth/device also returns a `pollSecret`
//    (random, never in the URL) whose SHA-256 is stored on the login row; GET /auth/device/:code
//    requires it as a bearer token and answers 401 for a missing, wrong or unknown code alike,
//    so polling cannot even be used to probe which codes exist.

import { and, eq, gt, inArray, lt } from 'drizzle-orm';
import { z } from 'zod';

import { schema } from '../db/index.js';
import { authorizeUrl, exchangeCode, fetchUser } from '../lib/discord.js';
import { bearer } from '../plugins/auth.js';
import {
  CODE_ALPHABET,
  constantTimeEqual,
  hashToken,
  newLoginCode,
  newToken,
} from '../lib/tokens.js';

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

/**
 * Tiny standalone page; the browser tab is the only UI the OAuth dance has.
 * `extra` is raw HTML built here in this file, never anything that came off the wire.
 */
function page(title, message, extra = '') {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(title)} - Cos Nostra</title>
<style>
  body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;
       font:16px/1.5 system-ui,sans-serif;background:#111;color:#eee}
  main{max-width:28rem;padding:2rem;text-align:center}
  h1{font-size:1.4rem;margin:0 0 .5rem}
  p{margin:0;color:#bbb}
  .code{margin:1.25rem 0;font:700 2rem/1 ui-monospace,SFMono-Regular,Menlo,monospace;
        letter-spacing:.35em;text-indent:.35em;color:#fff}
  .warn{margin:0 0 1.5rem;color:#f0c674}
  button{font:inherit;padding:.6rem 1.6rem;border:0;border-radius:.4rem;
         background:#5865f2;color:#fff;cursor:pointer}
  button:hover{background:#4752c4}
</style></head>
<body><main><h1>${escapeHtml(title)}</h1><p>${escapeHtml(message)}</p>${extra}</main></body></html>`;
}

/**
 * The interstitial GET /auth/discord/start renders instead of redirecting. Showing the device
 * name and the code, and requiring a click, is what makes a mailed login link survivable.
 * @param {{ code: string, deviceName: string }} login
 */
function confirmPage(login) {
  const code = escapeHtml(login.code);
  return page(
    'Link this device?',
    `A Cos Nostra app calling itself "${login.deviceName}" wants to link your Discord account.`,
    `<p class="code">${code}</p>
<p class="warn">Only continue if this code is showing in the Cos Nostra app on that computer right now. If you did not start this, close the tab.</p>
<form method="post" action="/auth/discord/start">
<input type="hidden" name="device" value="${code}">
<button type="submit">Continue</button>
</form>`,
  );
}

function badRequest(reply, issues) {
  return reply.code(400).send({ error: 'bad_request', issues });
}

/** @param {import('fastify').FastifyInstance} app */
export default async function authRoutes(app) {
  const { db, config } = app;
  // What a browser puts in Origin when it submits the interstitial's form back to us.
  const ownOrigin = new URL(config.PUBLIC_URL).origin;

  // The Continue button on the interstitial is a plain HTML form, and the only form-encoded body
  // the API takes. Parsing the handful of bytes here beats adding @fastify/formbody; this parser
  // is scoped to the routes in this file because route files register encapsulated.
  app.addContentTypeParser(
    'application/x-www-form-urlencoded',
    { parseAs: 'string', bodyLimit: 1024 },
    (_request, body, done) => {
      try {
        done(null, Object.fromEntries(new URLSearchParams(body)));
      } catch (err) {
        done(err, undefined);
      }
    },
  );

  async function deleteExpiredLogins() {
    try {
      const gone = await db
        .delete(schema.deviceLogins)
        .where(lt(schema.deviceLogins.expiresAt, new Date()))
        .returning({ deviceId: schema.deviceLogins.deviceId });
      // A login that expired with a device_id set was linked in the browser but never polled,
      // so its token was never handed to anybody. Leaving the device row behind would leave a
      // working credential nobody holds sitting in the user's device list.
      const orphans = gone.map((row) => row.deviceId).filter((id) => id != null);
      if (orphans.length) {
        await db.delete(schema.devices).where(inArray(schema.devices.id, orphans));
      }
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
      // Handed to the caller once and never stored in the clear, like a device token. It is what
      // proves a later poll comes from the app that started this login and not from a bystander
      // who read the code off a stream.
      const pollSecret = newToken();
      const pollSecretHash = hashToken(pollSecret);
      let code;
      // The code space is 32^8; a collision is unlikely but cheap to retry.
      for (let attempt = 0; ; attempt++) {
        code = newLoginCode();
        try {
          await db
            .insert(schema.deviceLogins)
            .values({ code, deviceName: parsed.data.deviceName, expiresAt, pollSecretHash });
          break;
        } catch (err) {
          if (attempt >= 3) throw err;
        }
      }
      return {
        code,
        verifyUrl: `${config.PUBLIC_URL}/auth/discord/start?device=${code}`,
        pollSecret,
        expiresIn: Math.floor(LOGIN_TTL_MS / 1000),
      };
    },
  );

  /** Resolves ?device= or the form field to a live login row, or sends the "unknown code" page. */
  async function requireLogin(input, reply) {
    const parsed = startQuery.safeParse(input ?? {});
    const login = parsed.success ? await findLogin(parsed.data.device) : null;
    if (!login) {
      reply
        .code(400)
        .type('text/html')
        .send(page('Unknown or expired code', 'Start the login again from the Cos Nostra app.'));
      return null;
    }
    return login;
  }

  // Deliberately not a redirect: the user has to see which device is asking and confirm.
  app.get('/auth/discord/start', async (request, reply) => {
    const login = await requireLogin(request.query, reply);
    if (!login) return reply;
    return reply.code(200).type('text/html').send(confirmPage(login));
  });

  // The Continue button on that page. This is the only way into Discord's authorize URL.
  app.post('/auth/discord/start', async (request, reply) => {
    // Without this an attacker could skip the interstitial with an auto-submitting form on their
    // own page: a victim who has already authorized the Discord app would sail through the
    // consent screen and link the attacker's device without ever seeing the code. Browsers send
    // Origin on every form POST; a request that does not carry one at all is left alone so a
    // header-stripping proxy cannot lock a real user out. The literal "null" is refused: it is
    // what a sandboxed iframe or a data: page sends, which is exactly the attacker's form.
    const origin = request.headers.origin;
    if (typeof origin === 'string' && origin !== ownOrigin) {
      app.log.info({ origin }, 'cross-origin POST /auth/discord/start refused');
      return reply
        .code(403)
        .type('text/html')
        .send(page('Login failed', 'Start the login again from the Cos Nostra app.'));
    }

    const login = await requireLogin(request.body, reply);
    if (!login) return reply;
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
    // Naming the device again here is the last chance the user has to notice they just linked
    // a machine that is not theirs.
    return html(200, 'Device linked', `Linked ${login.deviceName}. You can close this tab.`);
  });

  app.get('/auth/device/:code', async (request, reply) => {
    // Every failure answers the same 401, so polling cannot be used to find out whether a code
    // exists, is still pending, or was already claimed.
    const unauthorized = () => reply.code(401).send({ error: 'unauthorized' });

    const parsed = codeParam.safeParse(request.params);
    const secret = bearer(request);
    if (!parsed.success || !secret) return unauthorized();

    await deleteExpiredLogins();
    const login = await findLogin(parsed.data.code);
    // An empty stored hash (the migration default on a pre-existing row) matches nothing:
    // hashToken always returns 64 hex characters.
    if (!login || !constantTimeEqual(hashToken(secret), login.pollSecretHash)) {
      return unauthorized();
    }
    if (!login.deviceId || !login.token) return { status: 'pending' };

    // Hand the token out exactly once: the row goes away with it.
    const [claimed] = await db
      .delete(schema.deviceLogins)
      .where(and(eq(schema.deviceLogins.id, login.id), eq(schema.deviceLogins.token, login.token)))
      .returning({ token: schema.deviceLogins.token });
    if (!claimed) return unauthorized();

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
