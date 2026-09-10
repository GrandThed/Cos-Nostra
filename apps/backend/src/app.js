// Builds the Fastify app. Kept separate from index.js so tests can build an app against a
// PGlite database without listening on a port.
//
// Route files register themselves; each owns one resource:
//   routes/auth.js      device login, Discord OAuth
//   routes/clips.js     clip records, presigned uploads, media redirects, listing, rankings
//   routes/internal.js  bot -> backend: posts and reactions (shared secret)
//   routes/player.js    GET /c/:id player page
// Cross-cutting concerns are plugins under plugins/.

import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import Fastify from 'fastify';
import cors from '@fastify/cors';
import rateLimit from '@fastify/rate-limit';

import { loadConfig } from './config.js';
import { openDatabase } from './db/index.js';

/**
 * @param {object} [opts]
 * @param {NodeJS.ProcessEnv} [opts.env]  environment to validate (default process.env)
 * @param {boolean} [opts.migrate]  run migrations after opening the database (default true)
 * @param {import('fastify').FastifyServerOptions} [opts.fastify]
 */
export async function buildApp(opts = {}) {
  const config = loadConfig(opts.env ?? process.env);
  const database = await openDatabase(config.DATABASE_URL);
  if (opts.migrate ?? true) {
    await database.applyMigrations();
  }

  const app = Fastify({
    logger: opts.fastify?.logger ?? {
      level: config.LOG_LEVEL,
      ...(config.NODE_ENV === 'development' ? { transport: { target: 'pino-pretty' } } : {}),
    },
    trustProxy: true,
    ...opts.fastify,
  });

  app.decorate('config', config);
  app.decorate('db', database.db);
  app.decorate('database', database);
  app.addHook('onClose', async () => {
    await database.close();
  });

  await app.register(cors, { origin: true });
  await app.register(rateLimit, { max: 300, timeWindow: '1 minute' });

  app.get('/health', async () => ({ ok: true, driver: database.driver }));

  // Plugins and routes are registered here as the phase 3 packages land.
  const modules = [
    './plugins/auth.js',
    './plugins/storage.js',
    './routes/auth.js',
    './routes/clips.js',
    './routes/internal.js',
    './routes/player.js',
  ];
  const here = path.dirname(fileURLToPath(import.meta.url));
  for (const m of modules) {
    if (!existsSync(path.join(here, m))) {
      app.log.warn(`${m} not present yet, skipping`);
      continue;
    }
    const mod = await import(m);
    await app.register(mod.default);
  }

  return app;
}
