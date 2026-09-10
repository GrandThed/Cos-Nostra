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
  '.empty{color:#aaa;text-align:center;padding:48px 0}';

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
