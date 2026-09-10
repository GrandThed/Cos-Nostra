// Public HTML pages: GET /c/:id plays one clip, GET / lists the most recent ones.
//
// Media never leaves the bucket through here. The page points at /clips/:id/{av1,h264,thumb}
// (served by routes/clips.js as redirects to presigned URLs), so those URLs are stable and
// safe to bake into Open Graph tags that Discord caches. Data comes straight from app.db.

import { and, desc, eq, isNull, sql } from 'drizzle-orm';

import { clips, posts, reactions, users } from '../db/schema.js';
import { escapeHtml, formatDate, formatDuration, layout } from '../lib/html.js';

const RECENT_LIMIT = 30;

/** @type {import('fastify').FastifyPluginAsync} */
export default async function playerRoutes(app) {
  const media = (id, kind) => `${app.config.PUBLIC_URL}/clips/${encodeURIComponent(id)}/${kind}`;

  const clipColumns = {
    id: clips.id,
    game: clips.game,
    title: clips.title,
    durationMs: clips.durationMs,
    width: clips.width,
    height: clips.height,
    recordedAt: clips.recordedAt,
    status: clips.status,
    username: users.username,
    discordId: users.discordId,
    avatar: users.avatar,
  };

  async function findReadyClip(id) {
    const [row] = await app.db
      .select(clipColumns)
      .from(clips)
      .innerJoin(users, eq(users.id, clips.userId))
      .where(and(eq(clips.id, id), eq(clips.status, 'ready')))
      .limit(1);
    return row ?? null;
  }

  async function countReactions(clipId) {
    const [row] = await app.db
      .select({ n: sql`count(*)`.mapWith(Number) })
      .from(reactions)
      .innerJoin(posts, eq(posts.id, reactions.postId))
      .where(and(eq(posts.clipId, clipId), isNull(reactions.removedAt)));
    return row?.n ?? 0;
  }

  function notFound(reply) {
    const body = '<h1>Clip not found</h1><p class="empty">It may still be uploading, or it was deleted. <a href="/">Recent clips</a></p>';
    return reply.code(404).type('text/html; charset=utf-8').send(layout({ title: 'Clip not found', body }));
  }

  app.get('/c/:id', async (req, reply) => {
    const { id } = req.params;
    const clip = await findReadyClip(id);
    if (!clip) return notFound(reply);
    const reactionCount = await countReactions(id);
    reply.type('text/html; charset=utf-8');
    return renderPlayer(clip, reactionCount);
  });

  app.get('/', async (req, reply) => {
    const rows = await app.db
      .select(clipColumns)
      .from(clips)
      .innerJoin(users, eq(users.id, clips.userId))
      .where(eq(clips.status, 'ready'))
      .orderBy(desc(clips.recordedAt), desc(clips.id))
      .limit(RECENT_LIMIT);
    reply.type('text/html; charset=utf-8');
    return renderRecent(rows);
  });

  function clipTitle(clip) {
    return clip.title || clip.game || 'Clip';
  }

  function avatarUrl(clip) {
    return clip.avatar
      ? `https://cdn.discordapp.com/avatars/${encodeURIComponent(clip.discordId)}/${encodeURIComponent(clip.avatar)}.png?size=64`
      : null;
  }

  function ownerHtml(clip) {
    const avatar = avatarUrl(clip);
    const img = avatar ? `<img src="${escapeHtml(avatar)}" alt="" width="24" height="24">` : '';
    return `<span>${img}${escapeHtml(clip.username)}</span>`;
  }

  function renderPlayer(clip, reactionCount) {
    const title = clipTitle(clip);
    const av1 = media(clip.id, 'av1');
    const h264 = media(clip.id, 'h264');
    const thumb = media(clip.id, 'thumb');
    const pageUrl = `${app.config.PUBLIC_URL}/c/${encodeURIComponent(clip.id)}`;
    const description = [
      clip.username,
      clip.game,
      formatDuration(clip.durationMs),
      `${reactionCount} reaction${reactionCount === 1 ? '' : 's'}`,
    ]
      .filter(Boolean)
      .join(' · ');

    const meta = [
      ['og:type', 'video.other'],
      ['og:site_name', 'Cos Nostra'],
      ['og:url', pageUrl],
      ['og:title', title],
      ['og:description', description],
      ['og:image', thumb],
      ['og:video', h264],
      ['og:video:secure_url', h264],
      ['og:video:type', 'video/mp4'],
      ['og:video:width', String(clip.width ?? 1920)],
      ['og:video:height', String(clip.height ?? 1080)],
      ['twitter:card', 'player'],
      ['twitter:title', title],
      ['twitter:description', description],
      ['twitter:image', thumb],
      ['twitter:player', pageUrl],
      ['twitter:player:width', String(clip.width ?? 1920)],
      ['twitter:player:height', String(clip.height ?? 1080)],
      ['twitter:player:stream', h264],
      ['twitter:player:stream:content_type', 'video/mp4'],
    ];
    const head = meta
      .map(([k, v]) => {
        const attr = k.startsWith('twitter:') ? 'name' : 'property';
        return `<meta ${attr}="${k}" content="${escapeHtml(v)}">`;
      })
      .join('');

    const body =
      `<video controls playsinline preload="metadata" poster="${escapeHtml(thumb)}">` +
      `<source src="${escapeHtml(av1)}" type='video/mp4; codecs="av01.0.08M.08"'>` +
      `<source src="${escapeHtml(h264)}" type='video/mp4; codecs="avc1.640028"'>` +
      `Your browser cannot play this video. <a href="${escapeHtml(h264)}">Download</a>.` +
      '</video>' +
      `<h1>${escapeHtml(title)}</h1>` +
      '<div class="meta">' +
      ownerHtml(clip) +
      (clip.game ? `<span>${escapeHtml(clip.game)}</span>` : '') +
      `<span>${escapeHtml(formatDate(clip.recordedAt))}</span>` +
      `<span>${escapeHtml(formatDuration(clip.durationMs))}</span>` +
      `<span>${reactionCount} reaction${reactionCount === 1 ? '' : 's'}</span>` +
      `<a href="${escapeHtml(h264)}" download>Download</a>` +
      '<a href="/">More clips</a>' +
      '</div>';

    return layout({ title, head, body });
  }

  function renderRecent(rows) {
    const cards = rows
      .map((clip) => {
        const href = `/c/${encodeURIComponent(clip.id)}`;
        return (
          `<a class="card" href="${escapeHtml(href)}">` +
          `<img src="${escapeHtml(media(clip.id, 'thumb'))}" alt="" loading="lazy">` +
          `<div><strong>${escapeHtml(clipTitle(clip))}</strong>` +
          `<small>${escapeHtml(clip.username)} · ${escapeHtml(formatDate(clip.recordedAt))}</small></div>` +
          '</a>'
        );
      })
      .join('');
    const body =
      '<h1>Recent clips</h1>' +
      (cards ? `<div class="grid">${cards}</div>` : '<p class="empty">No clips yet.</p>');
    return layout({ title: 'Cos Nostra', body });
  }
}
