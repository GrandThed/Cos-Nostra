/** Thumbnails come back from Rust as data URLs, which are cheap to show and expensive to hold
 *  a few hundred of. So they are fetched only once a card is actually on screen, and cached by
 *  the path they were made from plus the row's last change: a re-encode (a cut, a retry)
 *  rewrites the thumbnail under the same path, and the row's `updated_at` is what moves. */

import { getThumbnail } from "./ipc";

const cache = new Map<number, { key: string; url: string | null }>();
const pending = new Set<number>();

const observer = new IntersectionObserver(
  (entries) => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      const img = entry.target as HTMLImageElement;
      observer.unobserve(img);
      void load(img);
    }
  },
  { rootMargin: "200px" },
);

/** Shows the thumbnail for `id` in `img` once it scrolls into view. `path` is the clip's
 *  current `thumb_path` (`null` when it has none yet) and `version` its `updated_at`. */
export function watch(img: HTMLImageElement, id: number, path: string | null, version: string): void {
  const key = path ? `${path}|${version}` : "";
  img.dataset.clip = String(id);
  img.dataset.key = key;
  const hit = cache.get(id);
  if (hit && hit.key === key) {
    if (hit.url) img.src = hit.url;
    return;
  }
  // Show what we have while the fresh one loads, so a re-encode does not blank the card.
  if (hit?.url) img.src = hit.url;
  if (key) observer.observe(img);
}

async function load(img: HTMLImageElement): Promise<void> {
  const id = Number(img.dataset.clip);
  const key = img.dataset.key ?? "";
  if (!key || pending.has(id)) return;
  pending.add(id);
  try {
    const url = await getThumbnail(id);
    cache.set(id, { key, url });
    if (url && img.isConnected) img.src = url;
  } catch (e) {
    console.warn("thumbnail", id, e);
  } finally {
    pending.delete(id);
  }
}

/** Forgets every pending watch. Call before rebuilding a list: the observer holds its targets,
 *  so the images of the grid being replaced would otherwise pile up for the life of the app. */
export function resetWatches(): void {
  observer.disconnect();
}

/** Drops thumbnails of clips that no longer exist, so a long session does not grow forever. */
export function keepOnly(ids: Set<number>): void {
  for (const id of cache.keys()) {
    if (!ids.has(id)) cache.delete(id);
  }
}
