// Taking a clip down. Extracted from DELETE /clips/:id so the bot's manage menu
// (DELETE /internal/clips/:id) takes exactly the same path: one definition of what "deleted"
// means, so the two routes can never drift into deleting different things.
//
// Objects go first and the row is marked after, the same order reapAbandoned uses: a bucket
// failure then leaves a `ready` row whose objects may be gone, which a retry fixes, rather
// than a `deleted` row still holding bytes nobody will ever collect.

import { eq } from 'drizzle-orm';

import { clips } from '../db/schema.js';

/**
 * Deletes a clip's three objects and marks the row deleted. The row itself is kept: posts and
 * reactions reference it and the yearly recap replays history.
 *
 * @param {import('fastify').FastifyInstance} app
 * @param {{ id: string, keyAv1: string, keyH264: string, keyThumb: string }} clip
 */
export async function purgeClip(app, clip) {
  await app.storage.deleteMany([clip.keyAv1, clip.keyH264, clip.keyThumb]);
  // Keep the row: posts and reactions reference it and the recap replays history.
  await app.db.update(clips).set({ status: 'deleted' }).where(eq(clips.id, clip.id));
  app.log.info({ clipId: clip.id }, 'clip deleted');
}
