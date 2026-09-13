// Public per-guild clip site (docs/PLAN.md phase 5): browse a guild's clips by game and by
// user, each with Discord avatars, no login required. Viewing is open on purpose; only
// managing a clip you own needs a session (see routes/login.js and the PATCH/DELETE routes in
// routes/clips.js). A guild only has a site once a human sets its slug via `/clips setup`.
//
// Every listing here is the same join shape GET /rankings in routes/clips.js already uses
// (clips joined through posts on guildId), just with different filters - clips itself has no
// guildId column, only posts does, since a clip can in principle be posted to more than one
// guild.
//
// Clip pages are never rendered here: GET /:slug/c/:id redirects to the one place a clip is
// ever rendered (routes/player.js), so the Discord-unfurl-critical Open Graph tags can never
// diverge between the two.

import { and, asc, desc, eq, isNotNull } from 'drizzle-orm';

import { clips, posts, users } from '../db/schema.js';
import { findGuildBySlug } from '../lib/guildSlug.js';
import { avatarUrl, clipCard, escapeHtml, guildIconUrl, layout, userCard } from '../lib/html.js';

// Reserved so a guild's slug can never shadow a real top-level route. Fastify's router tries
// static routes before the parametric `/:slug` regardless of registration order, so a
// collision would just make the guild's site unreachable rather than break the other route -
// but a slug this project's own routes already use would be a confusing dead end, so
// routes/internal.js's PUT handler refuses to save one of these.
export const RESERVED_SLUGS = new Set([
  'health',
  'clips',
  'rankings',
  'login',
  'logout',
  'auth',
  'internal',
  'c',
  'favicon.ico',
  'robots.txt',
  'static',
  'api',
]);

const LIST_LIMIT = 60;
const ownerColumns = { discordId: users.discordId, username: users.username, avatar: users.avatar };

/** @type {import('fastify').FastifyPluginAsync} */
export default async function guildSiteRoutes(app) {
  function notFound(reply, title, message) {
    const body = `<h1>${escapeHtml(title)}</h1><p class="empty">${escapeHtml(message)}</p>`;
    return reply.code(404).type('text/html; charset=utf-8').send(layout({ title, body }));
  }

  /** Resolves :slug or sends a 404 page; returns null in the latter case. */
  async function requireGuild(request, reply) {
    const slug = String(request.params.slug ?? '');
    if (RESERVED_SLUGS.has(slug.toLowerCase())) return null;
    const guild = await findGuildBySlug(app, slug);
    if (!guild) {
      notFound(reply, 'Server not found', 'No clip site is set up at this address.');
      return null;
    }
    return guild;
  }

  function header(guild) {
    const icon = guildIconUrl(guild.guildId, guild.icon);
    const img = icon
      ? `<img src="${escapeHtml(icon)}" alt="">`
      : '<img src="data:image/gif;base64,R0lGODlhAQABAAAAACH5BAEKAAEALAAAAAABAAEAAAICTAEAOw==" alt="">';
    const name = guild.name || guild.guildId;
    return (
      `<div class="guild-header">${img}<h1>${escapeHtml(name)}</h1></div>` +
      `<p class="crumbs"><a href="/${encodeURIComponent(guild.slug)}">Home</a> · ` +
      `<a href="/${encodeURIComponent(guild.slug)}/games">Games</a> · ` +
      `<a href="/${encodeURIComponent(guild.slug)}/users">Users</a></p>`
    );
  }

  function grid(cards, emptyMessage) {
    return cards.length ? `<div class="grid">${cards.join('')}</div>` : `<p class="empty">${escapeHtml(emptyMessage)}</p>`;
  }

  function clipHref(guild, id) {
    return `/${encodeURIComponent(guild.slug)}/c/${encodeURIComponent(id)}`;
  }

  function clipCards(guild, rows) {
    return rows.map((r) =>
      clipCard(
        {
          id: r.clip.id,
          title: r.clip.title,
          game: r.clip.game,
          username: r.owner.username,
          thumbUrl: `${app.config.PUBLIC_URL}/clips/${encodeURIComponent(r.clip.id)}/thumb`,
          recordedAt: r.clip.recordedAt,
        },
        clipHref(guild, r.clip.id),
      ),
    );
  }

  async function recentInGuild(guildId, extra = []) {
    return app.db
      .select({ clip: clips, owner: ownerColumns })
      .from(clips)
      .innerJoin(users, eq(users.id, clips.userId))
      .innerJoin(posts, eq(posts.clipId, clips.id))
      .where(and(eq(clips.status, 'ready'), eq(posts.guildId, guildId), ...extra))
      .orderBy(desc(clips.recordedAt), desc(clips.id))
      .limit(LIST_LIMIT);
  }

  // ---- guild home ---------------------------------------------------------------------

  app.get('/:slug', async (request, reply) => {
    const guild = await requireGuild(request, reply);
    if (!guild) return reply;
    const rows = await recentInGuild(guild.guildId);
    const body = header(guild) + '<h2>Recent clips</h2>' + grid(clipCards(guild, rows), 'No clips yet.');
    reply.type('text/html; charset=utf-8');
    return layout({ title: guild.name || guild.guildId, body });
  });

  // ---- browse by game -------------------------------------------------------------------

  app.get('/:slug/games', async (request, reply) => {
    const guild = await requireGuild(request, reply);
    if (!guild) return reply;
    const rows = await app.db
      .selectDistinct({ game: clips.game })
      .from(clips)
      .innerJoin(posts, eq(posts.clipId, clips.id))
      .where(and(eq(clips.status, 'ready'), eq(posts.guildId, guild.guildId), isNotNull(clips.game)))
      .orderBy(asc(clips.game));
    const links = rows
      .map(
        (r) =>
          `<a class="card" href="/${encodeURIComponent(guild.slug)}/g/${encodeURIComponent(r.game)}">` +
          `<div><strong>${escapeHtml(r.game)}</strong></div></a>`,
      )
      .join('');
    const body = header(guild) + '<h2>Games</h2>' + (links ? `<div class="grid">${links}</div>` : '<p class="empty">No games yet.</p>');
    reply.type('text/html; charset=utf-8');
    return layout({ title: `Games · ${guild.name || guild.guildId}`, body });
  });

  app.get('/:slug/g/:game', async (request, reply) => {
    const guild = await requireGuild(request, reply);
    if (!guild) return reply;
    const game = String(request.params.game ?? '');
    const rows = await recentInGuild(guild.guildId, [eq(clips.game, game)]);
    const body = header(guild) + `<h2>${escapeHtml(game)}</h2>` + grid(clipCards(guild, rows), 'No clips for this game yet.');
    reply.type('text/html; charset=utf-8');
    return layout({ title: `${game} · ${guild.name || guild.guildId}`, body });
  });

  // ---- browse by user ---------------------------------------------------------------------

  app.get('/:slug/users', async (request, reply) => {
    const guild = await requireGuild(request, reply);
    if (!guild) return reply;
    const rows = await app.db
      .selectDistinct(ownerColumns)
      .from(clips)
      .innerJoin(users, eq(users.id, clips.userId))
      .innerJoin(posts, eq(posts.clipId, clips.id))
      .where(and(eq(clips.status, 'ready'), eq(posts.guildId, guild.guildId)))
      .orderBy(asc(users.username));
    const cards = rows.map((r) =>
      userCard(r.discordId, r.avatar, r.username, `/${encodeURIComponent(guild.slug)}/u/${encodeURIComponent(r.discordId)}`),
    );
    const body = header(guild) + '<h2>Users</h2>' + grid(cards, 'No clips from anyone yet.');
    reply.type('text/html; charset=utf-8');
    return layout({ title: `Users · ${guild.name || guild.guildId}`, body });
  });

  app.get('/:slug/u/:discordId', async (request, reply) => {
    const guild = await requireGuild(request, reply);
    if (!guild) return reply;
    const discordId = String(request.params.discordId ?? '');
    const rows = await recentInGuild(guild.guildId, [eq(users.discordId, discordId)]);
    if (rows.length === 0) {
      // Distinguish "user exists but has no clips here" from "no such user" only loosely:
      // either way there is nothing to show, and a 404 avoids leaking which discordIds exist.
      return notFound(reply, 'No clips', 'This user has no clips in this server yet.');
    }
    const owner = rows[0].owner;
    const avatar = avatarUrl(owner.discordId, owner.avatar, 80);
    const img = avatar
      ? `<img src="${escapeHtml(avatar)}" alt="">`
      : '<img src="data:image/gif;base64,R0lGODlhAQABAAAAACH5BAEKAAEALAAAAAABAAEAAAICTAEAOw==" alt="">';
    const body =
      header(guild) +
      `<div class="guild-header">${img}<h1>${escapeHtml(owner.username)}</h1></div>` +
      grid(clipCards(guild, rows), 'No clips yet.');
    reply.type('text/html; charset=utf-8');
    return layout({ title: `${owner.username} · ${guild.name || guild.guildId}`, body });
  });

  // ---- clip redirect ---------------------------------------------------------------------

  app.get('/:slug/c/:id', async (request, reply) => {
    const guild = await requireGuild(request, reply);
    if (!guild) return reply;
    const id = String(request.params.id ?? '');
    const [post] = await app.db
      .select({ id: posts.id })
      .from(posts)
      .where(and(eq(posts.clipId, id), eq(posts.guildId, guild.guildId)))
      .limit(1);
    if (!post) return notFound(reply, 'Clip not found', 'This clip is not part of this server.');
    return reply.redirect(`/c/${encodeURIComponent(id)}?guild=${encodeURIComponent(guild.slug)}`, 302);
  });
}
