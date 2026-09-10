// Authentication decorators. Registers @fastify/jwt (used for the OAuth `state` parameter)
// and exposes two preHandlers other route files use as `{ preHandler: app.authenticateDevice }`:
//
//   authenticateDevice  Bearer <device token>  -> request.user, request.device
//   authenticateBot     Bearer <BOT_SHARED_SECRET>
//
// Exported without an encapsulation context so the decorators are visible app-wide.

import { timingSafeEqual } from 'node:crypto';

import jwt from '@fastify/jwt';
import { eq } from 'drizzle-orm';

import { schema } from '../db/index.js';
import { hashToken } from '../lib/tokens.js';

const LAST_SEEN_INTERVAL_MS = 5 * 60 * 1000;

/**
 * @typedef {{ id: number, discordId: string, username: string, avatar: string | null }} AuthUser
 * @typedef {{ id: number, name: string }} AuthDevice
 */

/** @param {import('fastify').FastifyRequest} request */
function bearer(request) {
  const header = request.headers.authorization;
  if (typeof header !== 'string') return null;
  const [scheme, value, ...rest] = header.trim().split(/\s+/);
  if (!value || rest.length || scheme.toLowerCase() !== 'bearer') return null;
  return value;
}

function constantEqual(a, b) {
  const ab = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

/** @param {import('fastify').FastifyInstance} app */
async function plugin(app) {
  await app.register(jwt, { secret: app.config.JWT_SECRET });

  // @fastify/jwt already decorates request.user; we only add request.device.
  app.decorateRequest('device', null);

  /** @type {import('fastify').preHandlerAsyncHookHandler} */
  async function authenticateDevice(request, reply) {
    const token = bearer(request);
    if (!token) return reply.code(401).send({ error: 'unauthorized' });

    const rows = await app.db
      .select({
        deviceId: schema.devices.id,
        deviceName: schema.devices.name,
        lastSeen: schema.devices.lastSeen,
        userId: schema.users.id,
        discordId: schema.users.discordId,
        username: schema.users.username,
        avatar: schema.users.avatar,
      })
      .from(schema.devices)
      .innerJoin(schema.users, eq(schema.users.id, schema.devices.userId))
      .where(eq(schema.devices.tokenHash, hashToken(token)))
      .limit(1);
    const row = rows[0];
    if (!row) return reply.code(401).send({ error: 'unauthorized' });

    request.user = {
      id: row.userId,
      discordId: row.discordId,
      username: row.username,
      avatar: row.avatar,
    };
    request.device = { id: row.deviceId, name: row.deviceName };

    const now = Date.now();
    if (!row.lastSeen || now - row.lastSeen.getTime() > LAST_SEEN_INTERVAL_MS) {
      // Best effort; a failed touch must not fail the request.
      app.db
        .update(schema.devices)
        .set({ lastSeen: new Date(now) })
        .where(eq(schema.devices.id, row.deviceId))
        .catch((err) => app.log.warn({ err }, 'could not update devices.last_seen'));
    }
  }

  /** @type {import('fastify').preHandlerAsyncHookHandler} */
  async function authenticateBot(request, reply) {
    const token = bearer(request);
    if (!token || !constantEqual(token, app.config.BOT_SHARED_SECRET)) {
      return reply.code(401).send({ error: 'unauthorized' });
    }
  }

  app.decorate('authenticateDevice', authenticateDevice);
  app.decorate('authenticateBot', authenticateBot);
}

plugin[Symbol.for('skip-override')] = true;
export default plugin;
