// Resolves a guild site's URL segment (e.g. "famafia") to its guild_settings row. Slugs are
// set once by a human re-running `/clips setup` (routes/internal.js); a guild with none is
// simply unreachable by its own site yet.

import { eq } from 'drizzle-orm';

import { guildSettings } from '../db/schema.js';

/**
 * @param {import('fastify').FastifyInstance} app
 * @param {string} slug
 * @returns {Promise<typeof guildSettings.$inferSelect | null>}
 */
export async function findGuildBySlug(app, slug) {
  if (!slug) return null;
  const [row] = await app.db
    .select()
    .from(guildSettings)
    .where(eq(guildSettings.slug, slug.toLowerCase()))
    .limit(1);
  return row ?? null;
}
