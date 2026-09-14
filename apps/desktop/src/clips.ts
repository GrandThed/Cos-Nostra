/** What a clip row means: the badge it wears, the line under it, where its video is, and the
 *  filters the library offers. One place, because the card, the row, the player rail, the
 *  match timeline and the publish dialog all have to agree. */

import { convertFileSrc } from "@tauri-apps/api/core";
import { fmtBytes, fmtCount } from "./format";
import { t } from "./i18n";
import type { ClipProgress, ClipRow, Segment, Settings, Status } from "./types";

/** Matches `queue::MAX_ATTEMPTS`. */
export const MAX_ATTEMPTS = 5;

/** How much of "Publishing · N%" the encode is. It is most of the wait: a minute of software
 *  encoding against a few seconds of upload for a typical clip. */
const ENCODE_SHARE = 0.85;

export type BadgeKind =
  | "local"
  | "queued"
  | "waiting"
  | "publishing"
  | "retrying"
  | "published"
  | "failed"
  | "released";

/** The status circle's five looks: outlined, accent (with a ring or a pulse), green, amber,
 *  red. Every badge maps to exactly one. */
export type CircleKind = "local" | "busy" | "published" | "retrying" | "failed";

export interface Badge {
  kind: BadgeKind;
  label: string;
  /** Hover text, for the states that have a reason worth reading. */
  title?: string;
  circle: CircleKind;
  /** 0–100 while a job with a percentage runs, for the circle's ring. */
  percent?: number;
}

/** True once the clip's video is only on the site: the row, the thumbnail and the link are
 *  still here, the file is not. */
export function isReleased(c: ClipRow): boolean {
  return c.status === "done" && !c.av1_path && !c.h264_path;
}

/** A clip nobody published: it lives on this PC and nothing will encode or upload it. */
export function isLocalClip(c: ClipRow): boolean {
  return !c.publish && c.remote_id === null;
}

/** True when the editor can open the clip: there is a file here to cut (or the match it was
 *  taken in), and no job is busy writing the outputs a cut would replace. Rust checks the
 *  same thing before it acts. */
export function canEdit(c: ClipRow, hasMatch = false): boolean {
  if (c.status === "encoding" || c.status === "uploading") return false;
  if (hasMatch) return true;
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

/** The encode and the upload as one percentage, so the ring never runs backwards between
 *  the two. */
function overallPercent(progress: ClipProgress | undefined): number | undefined {
  if (!progress || progress.stage === "idle") return undefined;
  const p = Math.min(Math.max(progress.percent, 0), 100);
  const share = ENCODE_SHARE * 100;
  return Math.round(progress.stage === "encode" ? (p * share) / 100 : share + (p * (100 - share)) / 100);
}

export function badgeFor(
  c: ClipRow,
  progress: ClipProgress | undefined,
  status: Status | null,
  settings: Settings | null,
): Badge {
  // Once the site has it, every job is an update of the published clip rather than a first
  // publish, and the copy says so.
  const updating = c.remote_id !== null;
  const retrying = (): Badge => ({
    kind: "retrying",
    circle: "retrying",
    label: t("clips.badge.retrying", { attempts: c.attempts, max: MAX_ATTEMPTS }),
    title: c.error
      ? t("clips.badge.attemptFailed", { attempts: c.attempts, error: c.error })
      : undefined,
  });
  const publishing = (): Badge => {
    const percent = overallPercent(progress);
    const verb = updating ? t("clips.badge.updating") : t("clips.badge.publishing");
    return {
      kind: "publishing",
      circle: "busy",
      label: percent === undefined ? verb : `${verb} · ${percent}%`,
      percent,
    };
  };
  const queued = (): Badge =>
    updating
      ? {
          kind: "queued",
          circle: "busy",
          label: t("clips.badge.updateQueued"),
          title: t("clips.badge.updateQueuedTitle"),
        }
      : {
          kind: "queued",
          circle: "busy",
          label: t("clips.badge.queued"),
          title: t("clips.badge.queuedTitle"),
        };

  if (c.status === "failed") {
    return {
      kind: "failed",
      circle: "failed",
      label: c.stage === "upload" ? t("clips.badge.uploadFailed") : t("clips.badge.failed"),
      title: c.error ?? undefined,
    };
  }
  if (isLocalClip(c)) {
    return {
      kind: "local",
      circle: "local",
      label: t("clips.badge.local"),
      title: t("clips.badge.localTitle"),
    };
  }
  switch (c.status) {
    case "saved":
      if (c.attempts > 0) return retrying();
      if (encodingIsWaiting(status, settings)) {
        return {
          kind: "waiting",
          circle: "busy",
          label: t("clips.badge.waiting"),
          title: t("clips.badge.waitingTitle"),
        };
      }
      return queued();
    case "encoding":
    case "uploading":
      return publishing();
    case "encoded":
      if (c.attempts > 0) return retrying();
      // The upload gate is the login and nothing else.
      if (status && !status.account) {
        return {
          kind: "waiting",
          circle: "busy",
          label: t("clips.badge.waitingLogin"),
          title: t("clips.badge.waitingLoginTitle"),
        };
      }
      return queued();
    case "done":
      return isReleased(c)
        ? {
            kind: "released",
            circle: "published",
            label: t("clips.badge.released"),
            title: t("clips.badge.releasedTitle"),
          }
        : {
            kind: "published",
            circle: "published",
            label: t("clips.badge.published"),
            title: t("clips.badge.publishedTitle"),
          };
  }
}

/** The grey line under a card's title: what this clip cost, or why it is where it is. */
export function metaLine(c: ClipRow, status: Status | null): string {
  const source = fmtBytes(c.size_source);
  if (c.status === "failed") return c.error ? firstLine(c.error) : t("clips.meta.failed");
  if (isLocalClip(c)) return t("clips.meta.local", { size: source });
  switch (c.status) {
    case "saved":
      if (c.attempts > 0) {
        return t("clips.meta.attempt", { attempts: c.attempts, max: MAX_ATTEMPTS });
      }
      return t("clips.meta.waitingToEncode", { size: source });
    case "encoding":
      return t("clips.meta.encoding", { size: source });
    case "encoded":
      return t(status && !status.account ? "clips.meta.encodedLogin" : "clips.meta.encoded", {
        source,
        encoded: fmtBytes(c.size_av1),
      });
    case "uploading":
      return t("clips.meta.uploading", { size: fmtBytes(c.size_av1) });
    case "done":
      return isReleased(c)
        ? t("clips.meta.released")
        : t("clips.meta.done", { source, encoded: fmtBytes(c.size_av1) });
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

export type FilterId = "local" | "published" | "failed" | "released";

/** Local and Published split the library on whether the site has the clip, so a clip on its
 *  way up for the first time still counts as local until it lands. */
export const FILTERS: { id: FilterId; match: (c: ClipRow) => boolean }[] = [
  { id: "local", match: (c) => c.remote_id === null },
  { id: "published", match: (c) => c.remote_id !== null },
  { id: "failed", match: (c) => c.status === "failed" },
  { id: "released", match: isReleased },
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
