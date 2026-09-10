// Shared test setup: an app on a throwaway PGlite database with fake secrets.
import { buildApp } from '../src/app.js';

export const testEnv = {
  NODE_ENV: 'test',
  PUBLIC_URL: 'http://localhost:3000',
  DATABASE_URL: 'pglite://memory',
  JWT_SECRET: 'test-jwt-secret-0123456789',
  BOT_SHARED_SECRET: 'test-bot-secret-0123456789',
  DISCORD_CLIENT_ID: 'client-id',
  DISCORD_CLIENT_SECRET: 'client-secret',
  LOG_LEVEL: 'silent',
};

export async function testApp(extraEnv = {}) {
  const app = await buildApp({ env: { ...testEnv, ...extraEnv }, fastify: { logger: false } });
  await app.ready();
  return app;
}
