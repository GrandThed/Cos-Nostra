/** The small round things a clip wears wherever it is shown: the status circle, and the stack of
 *  server icons for the Discord servers it is posted in. One builder each, so the card, the
 *  row, the player rail and the publish dialog cannot drift apart. */

import type { Badge } from "./clips";
import { h } from "./dom";
import { t } from "./i18n";
import type { ClipRow } from "./types";

/** How many server icons a stack shows before it says "+N". */
const MAX_ICONS = 3;
/** Letter circles take one of these, picked by guild id, so two servers without icons do not
 *  look like the same one. All token colours; see `styles/circles.css`. */
const TONES = 4;

/** A status circle for `badge`. Repaint it in place with `paintStatusDot`. */
export function statusDot(badge: Badge): HTMLElement {
  const node = h("span", { class: "status-dot", role: "img" });
  paintStatusDot(node, badge);
  return node;
}

/** Brings a status circle up to date. Cheap enough for every progress tick: a class, one
 *  custom property and the tooltip. */
export function paintStatusDot(node: HTMLElement, badge: Badge): void {
  const ring = badge.circle === "busy" && badge.percent !== undefined;
  const className = `status-dot ${badge.circle}${ring ? " ring" : ""}`;
  if (node.className !== className) node.className = className;
  node.style.setProperty("--p", String(badge.percent ?? 0));
  const tip = badge.title ? `${badge.label} — ${badge.title}` : badge.label;
  if (node.title !== tip) node.title = tip;
  node.setAttribute("aria-label", badge.label);
}

/** One server as a circle: its Discord icon, or its initial on a token colour when it has no
 *  icon or the icon does not load. */
export function guildIcon(guildId: string, name: string | null, iconUrl: string | null): HTMLElement {
  const initial = (name?.trim().charAt(0) || "#").toUpperCase();
  const node = h(
    "span",
    { class: `guild tone-${toneOf(guildId)}`, "aria-hidden": "true" },
    h("span", { class: "initial", text: initial }),
  );
  // Rust only lets Discord's CDN through; checked again here because this is an <img src>.
  if (iconUrl?.startsWith("https://cdn.discordapp.com/")) {
    const img = h("img", { alt: "", src: iconUrl, draggable: "false" }) as HTMLImageElement;
    img.addEventListener("error", () => img.remove());
    node.append(img);
  }
  return node;
}

/** The servers a published clip is posted in, overlapping, at most three and then "+N". A
 *  clip published without a post (web page only) wears one link circle instead; a local clip
 *  wears nothing, which is why this can return null. */
export function serverStack(c: ClipRow): HTMLElement | null {
  if (c.remote_id === null) return null;
  if (!c.posts.length) {
    return h(
      "span",
      { class: "servers", title: t("circles.webOnly") },
      h("span", { class: "guild web", "aria-hidden": "true", html: LINK_ICON }),
    );
  }
  const shown = c.posts.slice(0, MAX_ICONS);
  const more = c.posts.length - shown.length;
  const names = c.posts.map((p) => p.name ?? t("publish.unnamedServer")).join(", ");
  return h(
    "span",
    { class: "servers", title: t("circles.postedIn", { servers: names }) },
    ...shown.map((p) => guildIcon(p.guild_id, p.name, p.icon_url)),
    more > 0 ? h("span", { class: "guild more", text: `+${more}` }) : null,
  );
}

function toneOf(id: string): number {
  let n = 0;
  for (const ch of id) n = (n * 31 + ch.charCodeAt(0)) % 9973;
  return n % TONES;
}

/** A chain link, drawn in the current colour so it follows the theme. */
const LINK_ICON =
  '<svg viewBox="0 0 16 16" width="11" height="11" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M6.6 9.4a3 3 0 0 0 4.2 0l2.1-2.1a3 3 0 0 0-4.2-4.2l-.9.9"/><path d="M9.4 6.6a3 3 0 0 0-4.2 0L3.1 8.7a3 3 0 0 0 4.2 4.2l.9-.9"/></svg>';
