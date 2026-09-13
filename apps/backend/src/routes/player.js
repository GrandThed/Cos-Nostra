// Public HTML pages: GET /c/:id plays one clip, GET / lists the most recent ones.
//
// Media never leaves the bucket through here. The page points at /clips/:id/{av1,h264,thumb}
// (served by routes/clips.js as redirects to presigned URLs), so those URLs are stable and
// safe to bake into Open Graph tags that Discord caches. Data comes straight from app.db.

import { and, desc, eq, isNull, sql } from 'drizzle-orm';

import { browserSessions, clips, posts, reactions, users } from '../db/schema.js';
import { escapeHtml, formatDate, formatDuration, layout } from '../lib/html.js';
import { SESSION_COOKIE_NAME } from '../plugins/session.js';
import { hashToken } from '../lib/tokens.js';

const RECENT_LIMIT = 30;
// A guild query param is only ever the "back to <guild>" link guildSite.js's redirect
// attaches; it never gates anything, so a stray or stale value just makes that link vanish.
const SLUG_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,48}[a-z0-9])?$/;

/** @type {import('fastify').FastifyPluginAsync} */
export default async function playerRoutes(app) {
  const media = (id, kind) => `${app.config.PUBLIC_URL}/clips/${encodeURIComponent(id)}/${kind}`;

  const clipColumns = {
    id: clips.id,
    userId: clips.userId,
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

  // Never fails the request: an invalid, expired or missing cookie just means "not logged
  // in", the same as any other anonymous viewer - viewing a clip never requires a session.
  async function currentUserId(request) {
    const raw = request.cookies?.[SESSION_COOKIE_NAME];
    const unsigned = raw ? request.unsignCookie(raw) : null;
    if (!unsigned?.valid || !unsigned.value) return null;
    const [row] = await app.db
      .select({ userId: browserSessions.userId, expiresAt: browserSessions.expiresAt })
      .from(browserSessions)
      .where(eq(browserSessions.tokenHash, hashToken(unsigned.value)))
      .limit(1);
    if (!row || row.expiresAt.getTime() < Date.now()) return null;
    return row.userId;
  }

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
    const viewerId = await currentUserId(req);
    const rawGuild = typeof req.query.guild === 'string' ? req.query.guild.toLowerCase() : '';
    const guildSlug = SLUG_PATTERN.test(rawGuild) ? rawGuild : null;
    reply.type('text/html; charset=utf-8');
    return renderPlayer(clip, reactionCount, { viewerId, guildSlug });
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

  /** The management panel's inline script, sharing one clip id/CSS class with the markup. */
  function managePanelHtml(clip) {
    const id = escapeHtml(clip.id);
    return (
      `<div class="panel" id="manage">` +
      `<label for="manage-title">Title</label><input id="manage-title" value="${escapeHtml(clip.title ?? '')}">` +
      `<label for="manage-game">Game</label><input id="manage-game" value="${escapeHtml(clip.game ?? '')}">` +
      '<div class="row">' +
      '<button class="save" type="button" onclick="cnSave()">Save</button>' +
      '<button class="danger" type="button" onclick="cnDelete()">Delete</button>' +
      '</div><p class="err" id="manage-err"></p></div>' +
      '<script>' +
      `(function(){var id=${JSON.stringify(id)};` +
      'function err(m){var e=document.getElementById("manage-err");e.textContent=m;e.style.display="block";}' +
      'window.cnSave=async function(){' +
      'try{var r=await fetch("/clips/"+id,{method:"PATCH",credentials:"same-origin",' +
      'headers:{"content-type":"application/json"},' +
      'body:JSON.stringify({title:document.getElementById("manage-title").value,' +
      'game:document.getElementById("manage-game").value})});' +
      'if(!r.ok)throw new Error("save failed");location.reload();' +
      '}catch(e){err("Could not save. Try again.");}};' +
      'window.cnDelete=async function(){' +
      'if(!confirm("Delete this clip? This cannot be undone."))return;' +
      'try{var r=await fetch("/clips/"+id,{method:"DELETE",credentials:"same-origin"});' +
      'if(!r.ok)throw new Error("delete failed");location.href="/";' +
      '}catch(e){err("Could not delete. Try again.");}};' +
      '})();' +
      '</script>'
    );
  }

  function renderPlayer(clip, reactionCount, { viewerId = null, guildSlug = null } = {}) {
    const title = clipTitle(clip);
    const av1 = media(clip.id, 'av1');
    const h264 = media(clip.id, 'h264');
    const thumb = media(clip.id, 'thumb');
    const pageUrl = `${app.config.PUBLIC_URL}/c/${encodeURIComponent(clip.id)}`;
    // No reaction count in here. Discord caches an embed when it first crawls the page and
    // does not re-crawl as votes come in, so a count baked into og:description would freeze
    // at whatever it was seconds after posting - almost always "0 reactions". The page body
    // below shows the live count instead.
    const description = [clip.username, clip.game, formatDuration(clip.durationMs)]
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

    const backLink = guildSlug
      ? `<a href="/${encodeURIComponent(guildSlug)}">&larr; Back to ${escapeHtml(guildSlug)}</a>`
      : '<a href="/">More clips</a>';

    const isOwner = viewerId != null && viewerId === clip.userId;
    const loginNext = `/c/${encodeURIComponent(clip.id)}${guildSlug ? `?guild=${encodeURIComponent(guildSlug)}` : ''}`;
    const manageHtml = isOwner
      ? managePanelHtml(clip)
      : viewerId == null
        ? `<p class="crumbs"><a href="/login?next=${encodeURIComponent(loginNext)}">Log in with Discord to manage your clips</a></p>`
        : '';

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
      backLink +
      '</div>' +
      manageHtml;

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
