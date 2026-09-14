// Taking a clip down. Extracted from DELETE /clips/:id so the bot's manage menu
// (DELETE /internal/clips/:id) takes exactly the same path: one definition of what "deleted"
// means, so the two routes can never drift into deleting different things.
//
// Objects go first and the row is marked after, the same order reapAbandoned uses: a bucket
// failure then leaves a `ready` row whose objects may be gone, which a retry fixes, rather
// than a `deleted` row still holding bytes nobody will ever collect.
//
// Since publish-on-demand this is also "unpublish": the desktop calls DELETE /clips/:id for
// both and only differs in what it keeps locally. So a purge takes the clip off Discord too.
// The live posts are marked removed and the bot is told to delete the messages, fire and
// forget. That comes last, after the objects and the row, so a bucket failure leaves the clip
// still fully published and a retry does the whole thing, instead of a clip that plays on the
// site but has already vanished from Discord.

import { and, eq, isNull } from 'drizzle-orm';

import { clips, posts } from '../db/schema.js';

/**
 * Deletes a clip's three objects, marks the row deleted, marks its live posts removed and asks
 * the bot to delete those Discord messages. The rows themselves are kept: posts and reactions
 * reference the clip and the yearly recap replays history.
 *
 * @param {import('fastify').FastifyInstance} app
 * @param {{ id: string, keyAv1: string, keyH264: string, keyThumb: string }} clip
 */
export async function purgeClip(app, clip) {
  await app.storage.deleteMany([clip.keyAv1, clip.keyH264, clip.keyThumb]);
  // Keep the row: posts and reactions reference it and the recap replays history.
  await app.db.update(clips).set({ status: 'deleted' }).where(eq(clips.id, clip.id));

  // Only posts still live: one Hide already took down keeps the removed_at it got then, and
  // the bot is not asked to delete a message that is already gone.
  const removed = await app.db
    .update(posts)
    .set({ removedAt: new Date() })
    .where(and(eq(posts.clipId, clip.id), isNull(posts.removedAt)))
    .returning({ guildId: posts.guildId, channelId: posts.channelId, messageId: posts.messageId });
  app.log.info({ clipId: clip.id, postsRemoved: removed.length }, 'clip deleted');

  if (removed.length > 0 && app.hasDecorator('unpostBot')) {
    // unpostBot never rejects by design; the catch only keeps a bug there from surfacing as an
    // unhandled rejection after the request has already answered.
    Promise.resolve()
      .then(() => app.unpostBot(clip.id, removed))
      .catch((err) => app.log.warn({ err, clipId: clip.id }, 'unpostBot failed'));
  }
}
