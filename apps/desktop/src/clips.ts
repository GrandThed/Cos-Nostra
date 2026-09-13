/** What a clip row means: the badge it wears, the line under it, where its video is, and the
 *  filters the library offers. One place, because the card, the row and the player rail all
 *  have to agree. */

import { convertFileSrc } from "@tauri-apps/api/core";
import { fmtBytes, fmtCount } from "./format";
import { t } from "./i18n";
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
  return cut.length === 1 ? t("clips.trimmed") : t("clips.partsKept", { n: cut.length });
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
  const retrying = (): Badge => ({
    kind: "retrying",
    label: t("clips.badge.retrying", { attempts: c.attempts, max: MAX_ATTEMPTS }),
    title: c.error
      ? t("clips.badge.attemptFailed", { attempts: c.attempts, error: c.error })
      : undefined,
  });
  switch (c.status) {
    case "saved":
      if (c.attempts > 0) return retrying();
      if (encodingIsWaiting(status, settings)) {
        return {
          kind: "waiting",
          label: t("clips.badge.waiting"),
          title: t("clips.badge.waitingTitle"),
        };
      }
      // A clip that has outputs and is `saved` again is one the editor sent back.
      return c.cut || c.av1_path
        ? {
            kind: "saved",
            label: t("clips.badge.cutQueued"),
            title: t("clips.badge.cutQueuedTitle"),
          }
        : { kind: "saved", label: t("clips.badge.saved"), title: t("clips.badge.savedTitle") };
    case "encoding":
      return {
        kind: "encoding",
        label: `${c.cut ? t("clips.badge.cutting") : t("clips.badge.encoding")}${percent}`,
      };
    case "encoded":
      if (c.attempts > 0) return retrying();
      return {
        kind: "ready",
        label: t("clips.badge.ready"),
        title: settings?.auto_upload === false ? t("clips.badge.readyUploadsOff") : undefined,
      };
    case "uploading":
      return { kind: "uploading", label: `${t("clips.badge.uploading")}${percent}` };
    case "done":
      return isReleased(c)
        ? {
            kind: "released",
            label: t("clips.badge.released"),
            title: t("clips.badge.releasedTitle"),
          }
        : { kind: "done", label: t("clips.badge.done") };
    case "failed":
      return {
        kind: "failed",
        label: c.stage === "upload" ? t("clips.badge.uploadFailed") : t("clips.badge.failed"),
        title: c.error ?? undefined,
      };
  }
}

/** The grey line under a card's title: what this clip cost, or why it is where it is. */
export function metaLine(c: ClipRow, settings: Settings | null): string {
  const source = fmtBytes(c.size_source);
  switch (c.status) {
    case "saved":
      if (c.attempts > 0) {
        return t("clips.meta.attempt", { attempts: c.attempts, max: MAX_ATTEMPTS });
      }
      return c.cut || c.av1_path
        ? t("clips.meta.waitingToCut", { size: source })
        : t("clips.meta.waitingToEncode", { size: source });
    case "encoding":
      return c.cut
        ? t("clips.meta.cutting", { size: source })
        : t("clips.meta.encoding", { size: source });
    case "encoded":
      return t("clips.meta.encoded", {
        source,
        encoded: fmtBytes(c.size_av1),
        uploads: settings?.auto_upload === false ? t("clips.meta.uploadsOff") : "",
      });
    case "uploading":
      return t("clips.meta.uploading", { size: fmtBytes(c.size_av1) });
    case "done":
      return isReleased(c)
        ? t("clips.meta.released")
        : t("clips.meta.done", { source, encoded: fmtBytes(c.size_av1) });
    case "failed":
      return c.error ? firstLine(c.error) : t("clips.meta.failed");
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
export function unknownGame(): string {
  return t("clips.unknownGame");
}

export function gameLabel(game: string | null): string {
  return game ?? unknownGame();
}

// ---------------------------------------------------------------------------
// Filters, sorting and grouping

export type FilterId = "not-uploaded" | "failed" | "released" | "local";

export const FILTERS: { id: FilterId; match: (c: ClipRow) => boolean }[] = [
  { id: "not-uploaded", match: (c) => c.remote_id === null },
  { id: "failed", match: (c) => c.status === "failed" },
  { id: "released", match: isReleased },
  { id: "local", match: isLocal },
];

export function filterLabel(id: FilterId): string {
  return t(`clips.filter.${id}`);
}

/** Search matches the game name or the window title the clip was saved from, which is how
 *  someone finds "the kitchen one" without remembering the game. */
export function matchesSearch(c: ClipRow, needle: string): boolean {
  if (!needle) return true;
  const hay = `${gameLabel(c.game)} ${c.title ?? ""}`.toLowerCase();
  return hay.includes(needle.toLowerCase());
}

export type SortId = "newest" | "oldest" | "longest";

export const SORTS: SortId[] = ["newest", "oldest", "longest"];

export function sortLabel(id: SortId): string {
  return t(`clips.sort.${id}`);
}

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
  return fmtCount(n, t("clips.one"), t("clips.many"));
}
