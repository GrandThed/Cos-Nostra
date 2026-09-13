/** What a clip row means: the badge it wears, the line under it, where its video is, and the
 *  filters the library offers. One place, because the card, the row and the player rail all
 *  have to agree. */

import { convertFileSrc } from "@tauri-apps/api/core";
import { fmtBytes, fmtCount } from "./format";
import type { ClipProgress, ClipRow, Segment, Settings, Status } from "./types";

/** Matches `queue::MAX_ATTEMPTS`. */
export const MAX_ATTEMPTS = 5;

export type BadgeKind =
  | "saved"
  | "waiting"
  | "encoding"
  | "ready"
  | "uploading"
  | "retrying"
  | "done"
  | "failed"
  | "released";

export interface Badge {
  kind: BadgeKind;
  label: string;
  /** Hover text, for the states that have a reason worth reading. */
  title?: string;
}

/** True once the clip's video is only on the site: the row, the thumbnail and the link are
 *  still here, the file is not. */
export function isReleased(c: ClipRow): boolean {
  return c.status === "done" && !c.av1_path && !c.h264_path;
}

/** True while this PC still holds something playable. */
export function isLocal(c: ClipRow): boolean {
  return !!(c.av1_path || c.h264_path) || c.status === "saved" || c.status === "encoding";
}

/** True when the editor can open the clip: there is a file here to cut, and no job is busy
 *  writing the outputs a cut would replace. Rust checks the same thing before it acts. */
export function canEdit(c: ClipRow): boolean {
  if (c.status === "encoding" || c.status === "uploading") return false;
  return !!(c.av1_path || c.h264_path) || c.status === "saved" || c.status === "failed";
}

/** "Trimmed", "3 parts kept": how a cut reads in one phrase. */
export function cutLabel(cut: Segment[]): string {
  return cut.length === 1 ? "Trimmed" : `${cut.length} parts kept`;
}

/** Encoding waits for the game to close unless the user opted out of that. The status only
 *  reports the hooked game, which is the case the copy is about. */
export function encodingIsWaiting(status: Status | null, settings: Settings | null): boolean {
  return !!status?.hooked_game && settings?.encode_while_gaming === false;
}

export function badgeFor(
  c: ClipRow,
  progress: ClipProgress | undefined,
  status: Status | null,
  settings: Settings | null,
): Badge {
  const percent = progress ? ` · ${progress.percent}%` : "";
  switch (c.status) {
    case "saved":
      if (c.attempts > 0) {
        return {
          kind: "retrying",
          label: `Retrying · ${c.attempts}/${MAX_ATTEMPTS}`,
          title: c.error ? `Attempt ${c.attempts} failed: ${c.error}` : undefined,
        };
      }
      if (encodingIsWaiting(status, settings)) {
        return { kind: "waiting", label: "Waiting", title: "Encodes when you stop playing" };
      }
      // A clip that has outputs and is `saved` again is one the editor sent back.
      return c.cut || c.av1_path
        ? { kind: "saved", label: "Cut queued", title: "Re-encodes with your cut" }
        : { kind: "saved", label: "Saved", title: "Just captured — original file only" };
    case "encoding":
      return { kind: "encoding", label: `${c.cut ? "Cutting" : "Encoding"}${percent}` };
    case "encoded":
      if (c.attempts > 0) {
        return {
          kind: "retrying",
          label: `Retrying · ${c.attempts}/${MAX_ATTEMPTS}`,
          title: c.error ? `Attempt ${c.attempts} failed: ${c.error}` : undefined,
        };
      }
      return {
        kind: "ready",
        label: "Ready",
        title: settings?.auto_upload === false ? "Uploads are off, so it stops here" : undefined,
      };
    case "uploading":
      return { kind: "uploading", label: `Uploading${percent}` };
    case "done":
      return isReleased(c)
        ? { kind: "released", label: "On the site only", title: "Local video freed — the link still works" }
        : { kind: "done", label: "On the site" };
    case "failed":
      return {
        kind: "failed",
        label: c.stage === "upload" ? "Upload failed" : "Failed",
        title: c.error ?? undefined,
      };
  }
}

/** The grey line under a card's title: what this clip cost, or why it is where it is. */
export function metaLine(c: ClipRow, settings: Settings | null): string {
  const source = fmtBytes(c.size_source);
  switch (c.status) {
    case "saved":
      if (c.attempts > 0) return `Attempt ${c.attempts} of ${MAX_ATTEMPTS} — hover for why`;
      return c.cut || c.av1_path ? `${source} · waiting to cut` : `${source} · waiting to encode`;
    case "encoding":
      return `${source} · ${c.cut ? "cutting" : "encoding"}`;
    case "encoded":
      return `${source} → ${fmtBytes(c.size_av1)}${settings?.auto_upload === false ? " · uploads off" : ""}`;
    case "uploading":
      return `${fmtBytes(c.size_av1)} · uploading`;
    case "done":
      return isReleased(c)
        ? "Local video freed · link works"
        : `${source} → ${fmtBytes(c.size_av1)}`;
    case "failed":
      return c.error ? firstLine(c.error) : "Failed";
  }
}

function firstLine(text: string): string {
  const line = text.split("\n")[0].trim();
  return line.length > 90 ? `${line.slice(0, 89)}…` : line;
}

/** Where to play the clip from, and whether that means the network.
 *
 *  Local H.264 first because it is the copy every player handles; the untouched recording
 *  while the encode has not finished; the site for a clip whose local video was freed. */
export function mediaFor(
  c: ClipRow,
  settings: Settings | null,
): { url: string; streaming: boolean } | null {
  if (c.h264_path) return { url: convertFileSrc(c.h264_path), streaming: false };
  if (c.av1_path) return { url: convertFileSrc(c.av1_path), streaming: false };
  if (c.status === "saved" || c.status === "encoding") {
    return { url: convertFileSrc(c.source_path), streaming: false };
  }
  if (c.remote_id && settings?.backend_url) {
    return { url: `${settings.backend_url}/clips/${c.remote_id}/h264`, streaming: true };
  }
  return null;
}

/** The name a clip is filed under. `null` is its own pile, never the string "Unknown game". */
export const UNKNOWN = "Unknown game";

export function gameLabel(game: string | null): string {
  return game ?? UNKNOWN;
}

// ---------------------------------------------------------------------------
// Filters, sorting and grouping

export type FilterId = "not-uploaded" | "failed" | "released" | "local";

export const FILTERS: { id: FilterId; label: string; match: (c: ClipRow) => boolean }[] = [
  { id: "not-uploaded", label: "Not uploaded", match: (c) => c.remote_id === null },
  { id: "failed", label: "Failed", match: (c) => c.status === "failed" },
  { id: "released", label: "On the site only", match: isReleased },
  { id: "local", label: "Still on this PC", match: isLocal },
];

/** Search matches the game name or the window title the clip was saved from, which is how
 *  someone finds "the kitchen one" without remembering the game. */
export function matchesSearch(c: ClipRow, needle: string): boolean {
  if (!needle) return true;
  const hay = `${gameLabel(c.game)} ${c.title ?? ""}`.toLowerCase();
  return hay.includes(needle.toLowerCase());
}

export type SortId = "newest" | "oldest" | "longest";

export const SORTS: { id: SortId; label: string }[] = [
  { id: "newest", label: "Newest" },
  { id: "oldest", label: "Oldest" },
  { id: "longest", label: "Longest" },
];

export function sortClips(clips: ClipRow[], sort: SortId): ClipRow[] {
  const by = [...clips];
  if (sort === "longest") by.sort((a, b) => b.duration_ms - a.duration_ms);
  else {
    by.sort((a, b) => a.recorded_at.localeCompare(b.recorded_at));
    if (sort === "newest") by.reverse();
  }
  return by;
}

/** Clips per game, biggest pile first, with the unknown pile counted separately. */
export function countByGame(clips: ClipRow[]): { game: string | null; clips: number }[] {
  const counts = new Map<string | null, number>();
  for (const c of clips) counts.set(c.game, (counts.get(c.game) ?? 0) + 1);
  return [...counts.entries()]
    .map(([game, n]) => ({ game, clips: n }))
    .sort((a, b) => b.clips - a.clips || gameLabel(a.game).localeCompare(gameLabel(b.game)));
}

export function clipsNote(n: number): string {
  return fmtCount(n, "clip");
}
