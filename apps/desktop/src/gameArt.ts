/** Game pictures: an icon for lists and box art for the game header, both data URLs from Rust.
 *
 *  Each game is asked about once per kind and the answer kept, a `null` included, so a game
 *  with no picture is not asked again on every redraw. Rust says `game-art-changed` when a
 *  lookup lands or a picture is chosen or reset, and only then is that game asked again.
 *
 *  A tile repaints itself in place when its game's picture changes, so the list it sits in is
 *  never rebuilt for it and a search box beside it is never disturbed. */

import { listen } from "@tauri-apps/api/event";
import { h } from "./dom";
import { hueFor } from "./format";
import { getGameArt } from "./ipc";
import type { ArtKind, GameArtImage } from "./types";

const KINDS: ArtKind[] = ["icon", "cover"];

const cache = new Map<string, GameArtImage | null>();
/** What a game showed before its entry was dropped, painted until the fresh answer lands, so a
 *  changed picture does not blink through the placeholder on its way. */
const stale = new Map<string, GameArtImage | null>();
/** A token per request in flight. Dropping an entry orphans its token, so an answer that was
 *  already on its way when the picture changed is thrown away rather than cached. */
const pending = new Map<string, object>();
const listeners = new Set<(game: string) => void>();

const keyOf = (game: string, kind: ArtKind) => `${game}|${kind}`;

void listen<{ game: string }>("game-art-changed", (e) => forgetArt(e.payload.game));

/** The picture if it is known (`null` for none), or `undefined` while it is being asked for. */
export function artFor(game: string, kind: ArtKind): GameArtImage | null | undefined {
  const key = keyOf(game, kind);
  if (cache.has(key)) return cache.get(key);
  void load(game, kind);
  return undefined;
}

/** Runs `fn` with a game's name whenever what is known about its pictures changes. */
export function onGameArt(fn: (game: string) => void): void {
  listeners.add(fn);
}

/** Drops what is known about a game's pictures and asks again. For after anything that changes
 *  them from this side, since the event from Rust may come a moment later. */
export function forgetArt(game: string): void {
  for (const kind of KINDS) {
    const key = keyOf(game, kind);
    const was = cache.get(key);
    if (was !== undefined) stale.set(key, was);
    cache.delete(key);
    pending.delete(key);
  }
  changed(game);
}

/** Makes `tile` show `game`'s picture, or the game's initial on a tint of its own until there
 *  is one, and keeps it that way as pictures arrive. */
export function artTile<T extends HTMLElement>(tile: T, game: string, kind: ArtKind): T {
  tile.classList.add("art-tile", `art-${kind}`);
  tile.dataset.artGame = game;
  tile.dataset.artKind = kind;
  tile.style.setProperty("--hue", String(hueOf(game)));
  paint(tile);
  return tile;
}

async function load(game: string, kind: ArtKind): Promise<void> {
  const key = keyOf(game, kind);
  if (pending.has(key)) return;
  const token = {};
  pending.set(key, token);
  let art: GameArtImage | null = null;
  try {
    art = await getGameArt(game, kind);
  } catch (e) {
    // Kept as none: a failing lookup is not worth repeating on every redraw. The next change
    // to the game asks again.
    console.warn("game art", game, kind, e);
  }
  if (pending.get(key) !== token) return;
  pending.delete(key);
  cache.set(key, art);
  stale.delete(key);
  changed(game);
}

function changed(game: string): void {
  for (const tile of document.querySelectorAll<HTMLElement>("[data-art-game]")) {
    if (tile.dataset.artGame === game) paint(tile);
  }
  for (const fn of listeners) fn(game);
}

function paint(tile: HTMLElement): void {
  const game = tile.dataset.artGame;
  const kind = tile.dataset.artKind as ArtKind | undefined;
  if (game === undefined || kind === undefined) return;
  const fresh = artFor(game, kind);
  const art = fresh !== undefined ? fresh : stale.get(keyOf(game, kind));
  const img = tile.querySelector("img");
  if (art) {
    if (img?.getAttribute("src") === art.url) return;
    const next = h("img", { alt: "", draggable: "false", src: art.url });
    // A picture the WebView cannot decode is no picture.
    next.addEventListener("error", () => next.replaceWith(initial(game)), { once: true });
    tile.replaceChildren(next);
  } else if (img || !tile.firstChild) {
    tile.replaceChildren(initial(game));
  }
}

function initial(game: string): HTMLElement {
  const letter = game.match(/[\p{L}\p{N}]/u)?.[0] ?? Array.from(game.trim())[0] ?? "?";
  return h("span", { class: "letter", text: letter.toLocaleUpperCase() });
}

/** A stable hue per game name, the way `hueFor` gives one per clip. */
function hueOf(game: string): number {
  let hash = 0;
  for (const ch of game) hash = (hash * 31 + (ch.codePointAt(0) ?? 0)) >>> 0;
  return hueFor(hash);
}
