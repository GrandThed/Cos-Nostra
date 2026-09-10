// Object storage behind the S3 API (Railway buckets or R2). Decorates `app.storage` with a
// plain object, or null when config.storage is missing so routes can answer 503.
//
// Railway buckets have no public read, so the backend never hands out object URLs directly:
// every read goes through a presigned GET (see the media redirect routes in routes/clips.js).
// Presigning is pure computation, nothing here touches the network except head/deleteMany.

import {
  DeleteObjectsCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

/**
 * Object keys for one clip. Layout from docs/PLAN.md: clips/<user_id>/<clip_id>/<file>.
 * @param {number} userId
 * @param {string} clipId
 */
export function clipKeys(userId, clipId) {
  const prefix = `clips/${userId}/${clipId}`;
  return { av1: `${prefix}/av1.mp4`, h264: `${prefix}/h264.mp4`, thumb: `${prefix}/thumb.jpg` };
}

/**
 * @typedef {object} Storage
 * @property {string} bucket
 * @property {S3Client} client
 * @property {(key: string, contentType: string, expiresSeconds?: number) => Promise<string>} presignPut
 * @property {(key: string, expiresSeconds?: number, responseContentType?: string) => Promise<string>} presignGet
 * @property {(key: string) => Promise<{ size: number, contentType: string | null } | null>} head
 * @property {(keys: string[]) => Promise<void>} deleteMany
 */

/** @param {import('../config.js').Config['storage']} cfg @returns {Storage} */
export function createStorage(cfg) {
  const client = new S3Client({
    endpoint: cfg.endpoint,
    region: cfg.region,
    forcePathStyle: cfg.forcePathStyle,
    credentials: { accessKeyId: cfg.accessKeyId, secretAccessKey: cfg.secretAccessKey },
  });
  const Bucket = cfg.bucket;

  return {
    bucket: Bucket,
    client,

    presignPut(key, contentType, expiresSeconds = 3600) {
      const cmd = new PutObjectCommand({ Bucket, Key: key, ContentType: contentType });
      return getSignedUrl(client, cmd, { expiresIn: expiresSeconds });
    },

    presignGet(key, expiresSeconds = 3600, responseContentType) {
      const cmd = new GetObjectCommand({
        Bucket,
        Key: key,
        ...(responseContentType ? { ResponseContentType: responseContentType } : {}),
      });
      return getSignedUrl(client, cmd, { expiresIn: expiresSeconds });
    },

    async head(key) {
      try {
        const res = await client.send(new HeadObjectCommand({ Bucket, Key: key }));
        return { size: res.ContentLength ?? 0, contentType: res.ContentType ?? null };
      } catch (err) {
        const status = err?.$metadata?.httpStatusCode;
        if (status === 404 || err?.name === 'NotFound' || err?.name === 'NoSuchKey') return null;
        throw err;
      }
    },

    async deleteMany(keys) {
      if (keys.length === 0) return;
      await client.send(
        new DeleteObjectsCommand({
          Bucket,
          Delete: { Objects: keys.map((Key) => ({ Key })), Quiet: true },
        }),
      );
    },
  };
}

/** @param {import('fastify').FastifyInstance} app */
async function storagePlugin(app) {
  const cfg = app.config.storage;
  if (!cfg) {
    app.log.warn('S3_* not configured: upload and media routes will answer 503');
    app.decorate('storage', null);
    return;
  }
  app.decorate('storage', createStorage(cfg));
  app.log.info({ endpoint: cfg.endpoint, bucket: cfg.bucket }, 'object storage ready');
}

// No fastify-plugin dependency: opt out of encapsulation by hand so app.storage is visible
// to every route file.
storagePlugin[Symbol.for('skip-override')] = true;

export default storagePlugin;
