// Environment validation. Fails fast at startup and names every missing variable, which is
// what the railway-deploy skill tells you to look for when a deploy crashes.
//
// Storage is optional so the API can run locally without a bucket: upload routes then
// answer 503. Railway buckets expose their credentials as reference variables
// (ENDPOINT, REGION, BUCKET, ACCESS_KEY_ID, SECRET_ACCESS_KEY); map them to S3_* in the
// service settings.

import { z } from 'zod';

const schema = z.object({
  NODE_ENV: z.string().default('development'),
  PORT: z.coerce.number().int().positive().default(3000),
  PUBLIC_URL: z.url().transform((u) => u.replace(/\/+$/, '')),
  // postgres://... in production, pglite://<dir> or pglite://memory for local runs and tests.
  DATABASE_URL: z.string().min(1),
  JWT_SECRET: z.string().min(16, 'JWT_SECRET must be at least 16 characters'),
  BOT_SHARED_SECRET: z.string().min(16, 'BOT_SHARED_SECRET must be at least 16 characters'),
  DISCORD_CLIENT_ID: z.string().min(1),
  DISCORD_CLIENT_SECRET: z.string().min(1),
  // Base of the Discord REST API. Tests point it at a local stub server.
  DISCORD_API_BASE: z
    .string()
    .default('https://discord.com/api')
    .transform((u) => u.replace(/\/+$/, '')),
  // Where the backend reaches the bot's internal HTTP server. Optional until phase 4.
  BOT_INTERNAL_URL: z
    .string()
    .optional()
    .transform((u) => (u ? u.replace(/\/+$/, '') : undefined)),
  S3_ENDPOINT: z.string().optional(),
  S3_REGION: z.string().default('auto'),
  S3_BUCKET: z.string().optional(),
  S3_ACCESS_KEY_ID: z.string().optional(),
  S3_SECRET_ACCESS_KEY: z.string().optional(),
  // "virtual" (default, Railway and R2) or "path" for older buckets.
  S3_URL_STYLE: z.enum(['virtual', 'path']).default('virtual'),
  LOG_LEVEL: z.string().default('info'),
});

/**
 * @typedef {z.infer<typeof schema> & { storage: null | {
 *   endpoint: string, region: string, bucket: string, accessKeyId: string,
 *   secretAccessKey: string, forcePathStyle: boolean } }} Config
 */

/** @returns {Config} */
export function loadConfig(env = process.env) {
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    const lines = parsed.error.issues.map((i) => `  ${i.path.join('.') || '?'}: ${i.message}`);
    throw new Error(`invalid environment:\n${lines.join('\n')}`);
  }
  const c = parsed.data;
  const storageVars = [c.S3_ENDPOINT, c.S3_BUCKET, c.S3_ACCESS_KEY_ID, c.S3_SECRET_ACCESS_KEY];
  const storage = storageVars.every(Boolean)
    ? {
        endpoint: c.S3_ENDPOINT,
        region: c.S3_REGION,
        bucket: c.S3_BUCKET,
        accessKeyId: c.S3_ACCESS_KEY_ID,
        secretAccessKey: c.S3_SECRET_ACCESS_KEY,
        forcePathStyle: c.S3_URL_STYLE === 'path',
      }
    : null;
  return { ...c, storage };
}
