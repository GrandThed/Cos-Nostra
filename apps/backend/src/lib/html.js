// Tiny HTML helpers for the server-rendered pages (player page, recent clips). No template
// engine: pages are small enough that string building with a shared layout is plenty.
// Everything user-controlled must go through escapeHtml before it lands in a page.

const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

/** @param {unknown} s */
export function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ESCAPES[c]);
}

// Shared inline CSS. Dark, system font, video fills the width so phones are fine.
const CSS =
  'body{margin:0;background:#111;color:#eee;font:16px/1.4 system-ui,sans-serif}' +
  'a{color:#8ab4f8;text-decoration:none}a:hover{text-decoration:underline}' +
  'main{max-width:960px;margin:0 auto;padding:16px}' +
  'video{width:100%;max-width:100%;background:#000;border-radius:8px}' +
  'h1{font-size:1.25rem;margin:12px 0 4px}' +
  '.meta{display:flex;flex-wrap:wrap;gap:8px 16px;align-items:center;color:#aaa;font-size:.9rem}' +
  '.meta img{width:24px;height:24px;border-radius:50%;vertical-align:middle;margin-right:6px}' +
  '.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(240px,1fr));gap:16px}' +
  '.card{background:#1c1c1c;border-radius:8px;overflow:hidden;color:inherit}' +
  '.card img{display:block;width:100%;aspect-ratio:16/9;object-fit:cover;background:#000}' +
  '.card div{padding:8px 10px}.card small{display:block;color:#aaa}' +
  '.empty{color:#aaa;text-align:center;padding:48px 0}' +
  // Guild site additions (docs/PLAN.md phase 5): a header banner with the guild's icon, a
  // breadcrumb trail back to it, round-avatar user cards, and a small owner-only panel.
  '.guild-header{display:flex;align-items:center;gap:12px;margin-bottom:16px}' +
  '.guild-header img{width:48px;height:48px;border-radius:50%;background:#222}' +
  '.guild-header h1{margin:0}' +
  '.crumbs{color:#aaa;font-size:.9rem;margin-bottom:12px}' +
  '.crumbs a{color:#8ab4f8}' +
  '.user-card{display:flex;align-items:center;gap:10px;background:#1c1c1c;border-radius:8px;padding:10px;color:inherit}' +
  '.user-card img{width:40px;height:40px;border-radius:50%;background:#222}' +
  '.panel{margin-top:16px;padding:12px;background:#1c1c1c;border-radius:8px}' +
  '.panel label{display:block;margin:8px 0 4px;color:#aaa;font-size:.85rem}' +
  '.panel input{width:100%;box-sizing:border-box;padding:6px 8px;background:#111;color:#eee;border:1px solid #333;border-radius:4px;font:inherit}' +
  '.panel .row{display:flex;gap:8px;margin-top:10px}' +
  '.panel button{font:inherit;padding:.4rem 1rem;border:0;border-radius:4px;cursor:pointer}' +
  '.panel .save{background:#5865f2;color:#fff}.panel .danger{background:#a33;color:#fff}' +
  '.panel .err{color:#f28b82;font-size:.85rem;margin-top:6px;display:none}';

/**
 * Wrap a page body in the shared document shell.
 * @param {{ title: string, head?: string, body: string }} page  title is escaped here;
 *   head and body are trusted HTML the caller already escaped.
 */
export function layout({ title, head = '', body }) {
  return (
    '<!doctype html><html lang="en"><head><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width,initial-scale=1">' +
    `<title>${escapeHtml(title)}</title>${head}<style>${CSS}</style></head>` +
    `<body><main>${body}</main></body></html>`
  );
}

/** 754321 -> "12:34"; 3754321 -> "1:02:34". */
export function formatDuration(ms) {
  const total = Math.max(0, Math.round((Number(ms) || 0) / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const mm = h ? String(m).padStart(2, '0') : String(m);
  return `${h ? `${h}:` : ''}${mm}:${String(s).padStart(2, '0')}`;
}

/** Date -> "2026-09-10" (UTC). Falls back to an empty string for bad input. */
export function formatDate(date) {
  const d = date instanceof Date ? date : new Date(date);
  return Number.isNaN(d.getTime()) ? '' : d.toISOString().slice(0, 10);
}

/**
 * A Discord avatar CDN URL, or null with no avatar hash. Bare hashes are the only thing ever
 * stored (`users.avatar`, `guild_settings.icon`); the URL is built only at render time.
 * @param {'avatars' | 'icons'} kind
 * @param {string} id  discordId for a user, guildId for a guild
 * @param {string | null | undefined} hash
 * @param {number} [size]
 */
export function discordCdnUrl(kind, id, hash, size = 64) {
  if (!hash) return null;
  return `https://cdn.discordapp.com/${kind}/${encodeURIComponent(id)}/${encodeURIComponent(hash)}.png?size=${size}`;
}

/** @param {string} discordId @param {string | null | undefined} avatarHash @param {number} [size] */
export function avatarUrl(discordId, avatarHash, size = 64) {
  return discordCdnUrl('avatars', discordId, avatarHash, size);
}

/** @param {string} guildId @param {string | null | undefined} iconHash @param {number} [size] */
export function guildIconUrl(guildId, iconHash, size = 96) {
  return discordCdnUrl('icons', guildId, iconHash, size);
}

/** `<span><img>username</span>`, reused by the player page and the guild site's cards. */
export function ownerHtml(discordId, avatarHash, username) {
  const avatar = avatarUrl(discordId, avatarHash);
  const img = avatar ? `<img src="${escapeHtml(avatar)}" alt="" width="24" height="24">` : '';
  return `<span>${img}${escapeHtml(username)}</span>`;
}

/**
 * One clip card for a `.grid`, linking to `href`.
 * @param {{ id: string, title: string | null, game: string | null, username: string, thumbUrl: string, recordedAt: Date | string }} clip
 * @param {string} href
 */
export function clipCard(clip, href) {
  const label = clip.title || clip.game || 'Clip';
  return (
    `<a class="card" href="${escapeHtml(href)}">` +
    `<img src="${escapeHtml(clip.thumbUrl)}" alt="" loading="lazy">` +
    `<div><strong>${escapeHtml(label)}</strong>` +
    `<small>${escapeHtml(clip.username)} · ${escapeHtml(formatDate(clip.recordedAt))}</small></div>` +
    '</a>'
  );
}

/** One user card for a `.grid`, linking to `href`. */
export function userCard(discordId, avatarHash, username, href) {
  const avatar = avatarUrl(discordId, avatarHash, 80);
  const img = avatar
    ? `<img src="${escapeHtml(avatar)}" alt="">`
    : '<img src="data:image/gif;base64,R0lGODlhAQABAAAAACH5BAEKAAEALAAAAAABAAEAAAICTAEAOw==" alt="">';
  return `<a class="user-card" href="${escapeHtml(href)}">${img}<strong>${escapeHtml(username)}</strong></a>`;
}
