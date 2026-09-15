/** Matches: every recorded game session cut into its matches, each with the timeline the game
 *  reported, and the place to take clips out of them after playing.
 *
 *  Times on the timeline come from Rust as wall-clock instants. A match file knows when its
 *  first frame was (`file_start_at`), so an event sits at `at - file_start_at` into the video,
 *  plus the match's `event_offset_ms` when the user re-aligned a timeline recorded out of step
 *  with the footage (League matches from before the loading-screen fix are ~20 s early).
 *  The selection and the in/out marks survive a data refresh as long as the match itself did
 *  not change, so a session ending in the background does not reset the video being watched.
 *
 *  The player is the shared transport (`transport.ts`) under a timeline of its own: a ruler,
 *  a lane of markers, the playhead on a progress line, and the clips already taken. Dragging
 *  selects a range, a click jumps, the range's edges and the playhead can be grabbed, and
 *  hovering shows the frame and whatever happened there. */

import { convertFileSrc } from "@tauri-apps/api/core";
import { badgeFor } from "./clips";
import { confirming, fill, h } from "./dom";
import { dayLabel, fmtBytes, fmtClock, fmtDecimal, fmtDuration, fmtTimeOnly, fmtWhenLong, hueFor } from "./format";
import { artTile } from "./gameArt";
import { mapLabel, modeLabel, objectiveLabel, unitLabel } from "./gameTerms";
import { onLanguage, t } from "./i18n";
import * as ipc from "./ipc";
import { go } from "./router";
import { data, loadClips, loadSessions, on } from "./store";
import {
  clickToPlay,
  flasher,
  frameStep,
  fullscreenButton,
  leaveFullscreen,
  speedControl,
  togglePlay,
  type Transport,
  transportKey,
  typing,
  volume,
} from "./transport";
import type { MatchClip, MatchRow, SessionRow, TimelineEvent } from "./types";

/** Kept after the moment a round is decided when clipping it, for the kill and the reaction. */
const ROUND_TAIL_MS = 3000;
/** Selecting a moment (a kill, a dragon) takes this much before it, for the fight leading up. */
const MOMENT_BEFORE_MS = 12_000;
/** A multikill is stamped at its last kill, so the lead-up is longer. */
const MULTIKILL_BEFORE_MS = 20_000;
const MOMENT_AFTER_MS = 4_000;
/** A marker is pressed once whatever was worth it has happened: mostly before, a little after. */
const MARKER_BEFORE_MS = 25_000;
const MARKER_AFTER_MS = 5_000;
/** Jumping to a moment lands this much before it, so pressing play shows it happen. */
const JUMP_LEAD_MS = 2000;
/** Ctrl+← while this close after a moment goes to the one before, like chapters do. */
const PREV_SLACK_MS = 1500;
const MIN_CLIP_MS = 1000;
/** A pointer that moves less than this on the timeline is a click (seek), not a drag (select). */
const DRAG_PX = 4;
/** How near the pointer has to be to a marker, a range edge or the playhead to take it. */
const GRAB_PX = 6;
/** The part of the timeline, from its top, where the pointer snaps to markers (`matches.css`). */
const LANE_BOTTOM_PX = 50;
/** Ruler ticks are at least this far apart. */
const TICK_MIN_PX = 70;
const TICK_STEPS_S = [15, 30, 60, 120, 300, 600, 900, 1800, 3600];
/** The sync panel's nudge, and how far the offset may go (`sessions.rs` clamps the same). */
const NUDGE_MS = 1000;
const MAX_OFFSET_MS = 600_000;

type Selection = { kind: "match"; id: number } | { kind: "session"; id: number } | null;
type Filter = "all" | "marker" | "kill" | "death" | "assist" | "objective" | "round";
const FILTERS: Filter[] = ["all", "marker", "kill", "death", "assist", "objective", "round"];

let selection: Selection = null;
let parts: { list: HTMLElement; main: HTMLElement } | null = null;
/** A clip whose range the route asked to have selected once its match is on screen. */
let pendingClip: number | null = null;

interface Round {
  n: number;
  start: number;
  end: number;
  won: boolean | null;
  ally: number;
  enemy: number;
}

/** The match on screen. Rebuilt only when `key` changes. */
interface View {
  key: string;
  match: MatchRow;
  note: HTMLElement;
  /** Null while the match has no file to play (live, pending, missing, failed). */
  p: Player | null;
}

interface Player {
  session: SessionRow;
  match: MatchRow;
  video: HTMLVideoElement;
  /** A second decoder that follows the pointer over the timeline, for the hover frame. */
  preview: HTMLVideoElement;
  previewWant: number;
  tr: Transport;
  /** What fullscreen shows: the picture, the timeline and the clip controls. */
  root: HTMLElement;
  timeline: HTMLElement;
  ruler: HTMLElement;
  bar: HTMLElement;
  played: HTMLElement;
  head: HTMLElement;
  hover: HTMLElement;
  tip: HTMLElement;
  tipAt: HTMLElement;
  tipWhat: HTMLElement;
  sel: HTMLElement;
  selLen: HTMLElement;
  clipLayer: HTMLElement;
  time: HTMLElement;
  playButton: HTMLElement;
  range: HTMLElement;
  clipButton: HTMLButtonElement;
  rail: HTMLElement;
  filters: HTMLElement;
  syncLink: HTMLButtonElement;
  syncPanel: HTMLElement;
  eventList: HTMLElement;
  events: TimelineEvent[];
  eventsLoaded: boolean;
  rounds: Round[];
  /** Clips taken during this match, as ranges of its file. */
  clips: MatchClip[];
  inMs: number | null;
  outMs: number | null;
  offsetMs: number;
  filter: Filter;
  syncing: boolean;
  /** The rows the list shows, in time order, with where each jumps to. */
  rows: { ms: number; jump: number; el: HTMLElement }[];
  current: HTMLElement | null;
  lastPainted: number;
  frame: number;
  onKey: (e: KeyboardEvent) => void;
  resize: ResizeObserver;
}

let view: View | null = null;

const thumbs = new Map<number, { key: string; url: string | null }>();

export function initMatches(): void {
  on("sessions", () => {
    if (parts) render();
  });
  // A clip saved, published or re-ranged moves its bar; a percentage only recolours it.
  on("clips", () => {
    if (view?.p) void loadMatchClips(view.p);
  });
  on("progress", () => {
    if (view?.p) paintClips(view.p);
  });
  onLanguage(() => {
    if (!parts) return;
    // The match on screen is keyed on its data, which the language does not touch.
    teardown();
    render();
  });
}

export function mountMatches(root: HTMLElement, session?: number, match?: number, clip?: number): void {
  if (match !== undefined) selection = { kind: "match", id: match };
  else if (session !== undefined) selection = { kind: "session", id: session };
  pendingClip = clip ?? null;
  const list = h("aside", { class: "session-list scroll" });
  const main = h("section", { class: "match-view" });
  parts = { list, main };
  fill(root, h("div", { class: "matches" }, list, main));
  render();
  void loadSessions();
}

export function unmountMatches(): void {
  teardown();
  parts = null;
}

function render(): void {
  settleSelection();
  renderList();
  renderMain();
}

// ---------------------------------------------------------------------------
// Selection

function findMatch(id: number): { session: SessionRow; match: MatchRow } | null {
  for (const session of data.sessions) {
    const match = session.matches.find((m) => m.id === id);
    if (match) return { session, match };
  }
  return null;
}

/** Keeps the selection pointing at something that exists, and moves from a session to its
 *  first match once the session has one (a session that just ended is cut a moment later). */
function settleSelection(): void {
  if (selection?.kind === "match" && findMatch(selection.id)) return;
  if (selection?.kind === "session") {
    const id = selection.id;
    const session = data.sessions.find((s) => s.id === id);
    if (session && !session.matches.length) return;
    if (session) {
      const pick = session.matches.find((m) => m.status === "ready") ?? session.matches[0];
      selection = { kind: "match", id: pick.id };
      return;
    }
  }
  const newest = data.sessions.find((s) => s.matches.length);
  const pick = newest?.matches.find((m) => m.status === "ready") ?? newest?.matches[0];
  selection = pick ? { kind: "match", id: pick.id } : null;
}

function select(next: Selection): void {
  selection = next;
  renderList();
  renderMain();
}

// ---------------------------------------------------------------------------
// Session list

function renderList(): void {
  if (!parts) return;
  const error = data.errors.sessions;
  if (!data.sessions.length) {
    fill(
      parts.list,
      h(
        "div",
        { class: "session-empty" },
        error
          ? h("span", { class: "muted", text: error })
          : h("span", { class: "muted", text: t("matches.nothingRecorded") }),
      ),
    );
    return;
  }

  const nodes: HTMLElement[] = [];
  let day = "";
  for (const s of data.sessions) {
    const label = dayLabel(s.started_at);
    if (label !== day) {
      day = label;
      nodes.push(h("div", { class: "day-label", text: label }));
    }
    nodes.push(sessionBlock(s));
  }
  fill(parts.list, ...nodes);
}

function sessionBlock(s: SessionRow): HTMLElement {
  const badge =
    s.status === "recording"
      ? h("span", { class: "badge live", text: t("matches.recordingBadge") })
      : s.status === "processing"
        ? h("span", { class: "badge encoding", text: t("matches.cuttingBadge") })
        : s.status === "failed"
          ? h("span", { class: "badge failed", text: t("matches.failedBadge") })
          : null;
  const current = selection?.kind === "session" && selection.id === s.id;
  return h(
    "div",
    { class: "session" },
    h(
      "button",
      {
        type: "button",
        class: "session-head",
        "aria-current": String(current),
        onclick: () => select(s.matches.length ? { kind: "match", id: s.matches[0].id } : { kind: "session", id: s.id }),
      },
      s.game_name ? artTile(h("span"), s.game_name, "icon") : null,
      h("span", { class: "game", text: s.game_name }),
      h("span", { class: "when mono", text: timeRange(s) }),
      badge,
    ),
    ...s.matches.map((m, i) => matchItem(s, m, i)),
    !s.matches.length
      ? h("div", { class: "session-note", text: sessionNote(s) })
      : null,
  );
}

function matchItem(s: SessionRow, m: MatchRow, index: number): HTMLElement {
  const current = selection?.kind === "match" && selection.id === m.id;
  const img = h("img", { alt: "" }) as HTMLImageElement;
  showThumb(img, m);
  return h(
    "button",
    {
      type: "button",
      class: "match-item",
      "aria-current": String(current),
      style: `--hue:${hueFor(m.id)}`,
      onclick: () => select({ kind: "match", id: m.id }),
    },
    h("span", { class: "thumb" }, img),
    h(
      "span",
      { class: "lines" },
      h("span", { class: "title", text: matchTitle(m, index, s) }),
      h("span", { class: "meta", text: matchMeta(m) }),
    ),
    m.result ? h("span", { class: `result ${m.result}`, text: resultLetter(m.result) }) : null,
  );
}

function showThumb(img: HTMLImageElement, m: MatchRow): void {
  if (!m.thumb_path) return;
  const key = `${m.thumb_path}|${m.updated_at}`;
  const hit = thumbs.get(m.id);
  if (hit?.url) img.src = hit.url;
  if (hit?.key === key) return;
  thumbs.set(m.id, { key, url: hit?.url ?? null });
  void ipc
    .matchThumbnail(m.id)
    .then((url) => {
      thumbs.set(m.id, { key, url });
      if (url && img.isConnected) img.src = url;
    })
    .catch((e) => console.warn("match thumbnail", m.id, e));
}

function timeRange(s: SessionRow): string {
  const from = fmtTimeOnly(s.started_at);
  return s.ended_at ? `${from}–${fmtTimeOnly(s.ended_at)}` : `${from}–${t("matches.now")}`;
}

function sessionNote(s: SessionRow): string {
  if (s.status === "recording") return t("matches.noMatchYet");
  if (s.status === "processing") return t("matches.cuttingIntoMatches");
  if (s.status === "failed") return s.error ?? t("matches.couldNotCut");
  return t("matches.noMatches");
}

function matchTitle(m: MatchRow, index: number, s: SessionRow): string {
  if (!m.detected) {
    // A background recording comes in parts, and the oldest go first, so a part is named by
    // when it starts rather than by a number that shifts.
    if (s.game === "other") return t("matches.partFrom", { time: fmtTimeOnly(m.started_at) });
    return s.matches.length > 1
      ? t("matches.recordingN", { n: index + 1 })
      : t("matches.wholeSession");
  }
  const parts = [mapLabel(m.map), modeLabel(m.mode)].filter(Boolean);
  return parts.length ? parts.join(" · ") : t("matches.matchN", { n: index + 1 });
}

function score(m: MatchRow): string | null {
  return m.ally_score !== null && m.enemy_score !== null ? `${m.ally_score}–${m.enemy_score}` : null;
}

function matchMeta(m: MatchRow): string {
  switch (m.status) {
    case "live":
      return [t("matches.metaInProgress"), score(m)].filter(Boolean).join(" · ");
    case "pending":
      return t("matches.metaPending");
    case "missing":
      return t("matches.metaMissing");
    case "failed":
      return t("matches.metaFailed");
    case "ready":
      return [fmtDuration(m.duration_ms ?? 0), score(m)].filter(Boolean).join(" · ");
  }
}

function resultLetter(r: NonNullable<MatchRow["result"]>): string {
  return t(`matches.resultLetter.${r}`);
}

// ---------------------------------------------------------------------------
// The match on screen

function renderMain(): void {
  if (!parts) return;
  const main = parts.main;

  if (selection?.kind === "session") {
    const id = selection.id;
    const session = data.sessions.find((s) => s.id === id);
    teardown();
    fill(
      main,
      h(
        "div",
        { class: "empty-state" },
        session ? sessionNote(session) : t("matches.sessionGone"),
      ),
    );
    return;
  }
  const found = selection?.kind === "match" ? findMatch(selection.id) : null;
  if (!found) {
    teardown();
    fill(
      main,
      h(
        "div",
        { class: "empty-state" },
        h("span", { class: "blob" }),
        h("span", {
          text: data.sessions.length ? t("matches.pickMatch") : t("matches.closeAGame"),
        }),
      ),
    );
    return;
  }

  const { session, match } = found;
  const key = `${match.id}|${match.status}|${match.updated_at}|${session.status}`;
  if (view?.key === key) return;
  teardown();
  build(main, session, match, key);
}

function teardown(): void {
  if (!view) return;
  const p = view.p;
  view = null;
  if (!p) return;
  cancelAnimationFrame(p.frame);
  document.removeEventListener("keydown", p.onKey);
  p.resize.disconnect();
  if (document.fullscreenElement && p.root.contains(document.fullscreenElement)) leaveFullscreen();
  // Both are decoders holding a multi-gigabyte file open.
  for (const video of [p.video, p.preview]) {
    video.pause();
    video.removeAttribute("src");
    video.load();
  }
}

function build(main: HTMLElement, session: SessionRow, match: MatchRow, key: string): void {
  const index = session.matches.findIndex((m) => m.id === match.id);
  const title = matchTitle(match, index, session);
  const facts = [
    fmtWhenLong(match.started_at),
    match.duration_ms ? fmtDuration(match.duration_ms) : null,
    score(match),
    match.result ? t(`matches.result.${match.result}`) : null,
    match.size ? fmtBytes(match.size) : null,
  ].filter(Boolean);

  const actions = h("div", { class: "actions" });
  if (match.path) {
    actions.append(
      h("button", {
        type: "button",
        class: "btn small",
        text: t("matches.openFolder"),
        onclick: () => void ipc.openMatchFolder(match.id),
      }),
    );
  }
  const busy = session.status === "recording" || session.status === "processing";
  if (!busy) {
    actions.append(
      confirming(
        h("button", { type: "button", class: "btn small danger" }) as HTMLButtonElement,
        t("matches.deleteMatch"),
        t("matches.confirmDelete"),
        () => void removeMatch(match.id),
      ),
    );
    if (session.matches.length > 1) {
      actions.append(
        confirming(
          h("button", { type: "button", class: "btn small danger" }) as HTMLButtonElement,
          t("matches.deleteSession"),
          t("matches.deleteAll", { n: session.matches.length }),
          () => void removeSession(session.id),
        ),
      );
    }
  }

  const header = h(
    "div",
    { class: "match-head" },
    h(
      "div",
      { class: "titles" },
      h("span", { class: "label", text: session.game_name }),
      h("h2", { text: title }),
      h("span", { class: "facts", text: facts.join(" · ") }),
    ),
    actions,
  );

  const note = h("div", { class: "match-msg" });

  if (match.status !== "ready" || !match.path) {
    view = { key, match, note, p: null };
    fill(main, header, h("div", { class: "match-body scroll" }, statusPanel(session, match)));
    return;
  }

  const p = buildPlayer(session, match, match.path, note);
  view = { key, match, note, p };

  fill(
    main,
    header,
    h(
      "div",
      { class: "match-body" },
      h(
        "div",
        { class: "match-stage scroll" },
        p.root,
        h(
          "div",
          { class: "keys" },
          ...(["play", "seek", "frame", "speed", "marks", "events", "fullscreen"] as const).map((k) =>
            h("span", { text: t(`matches.keys.${k}`) }),
          ),
        ),
        h("span", { class: "hint", text: t("matches.hint") }),
      ),
      p.rail,
    ),
  );

  wireTimeline(p);
  void loadMatchClips(p);
  document.addEventListener("keydown", p.onKey);
  p.resize.observe(p.timeline);
  paintRange(p);
  paintRuler(p);
  paintSync(p);
  const tick = () => {
    if (view?.p !== p) return;
    paintPlayhead(p, false);
    p.frame = requestAnimationFrame(tick);
  };
  p.frame = requestAnimationFrame(tick);

  fill(p.eventList, h("span", { class: "muted", text: t("matches.readingTimeline") }));
  void ipc
    .matchEvents(match.id)
    .then((events) => {
      if (view?.p !== p) return;
      p.events = events;
      p.eventsLoaded = true;
      paintEvents(p);
    })
    .catch((e) => fill(p.eventList, h("span", { class: "muted", text: ipc.errorText(e) })));
}

function buildPlayer(session: SessionRow, match: MatchRow, path: string, note: HTMLElement): Player {
  const src = convertFileSrc(path);
  const video = h("video", { preload: "metadata", playsinline: true, src }) as HTMLVideoElement;
  const preview = h("video", { preload: "metadata", muted: true, src }) as HTMLVideoElement;
  const box = h("div", { class: "video" }, video);

  const ruler = h("div", { class: "tl-ruler" });
  const bar = h("div", { class: "tl-bar" });
  const played = h("span", { class: "tl-played" });
  // Its own lane along the bottom, so a clip never sits on top of a kill it contains.
  const clipLayer = h("div", { class: "tl-clips" });
  const selLen = h("span", { class: "tl-len mono" });
  const sel = h(
    "div",
    { class: "tl-sel", hidden: true },
    h("span", { class: "tl-grip in" }),
    selLen,
    h("span", { class: "tl-grip out" }),
  );
  const hover = h("div", { class: "tl-hover", hidden: true });
  const head = h("div", { class: "tl-head" }, h("span", { class: "knob" }));
  const timeline = h(
    "div",
    { class: "tl" },
    ruler,
    bar,
    h("div", { class: "tl-track" }, played),
    clipLayer,
    sel,
    hover,
    head,
  );
  const tipAt = h("span", { class: "at mono" });
  const tipWhat = h("span", { class: "what" });
  const tip = h("div", { class: "tl-tip", hidden: true }, preview, tipAt, tipWhat);

  const playButton = h("button", { type: "button", class: "play", text: "▶", title: t("transport.play") });
  const time = h("span", { class: "time" });
  const range = h("span", { class: "range mono" });
  const clipButton = h("button", {
    type: "button",
    class: "btn primary",
    text: t("matches.makeClip"),
    disabled: true,
    onclick: () => void makeClip(),
  }) as HTMLButtonElement;

  const root = h("div", { class: "match-player" });
  const flash = flasher(box);
  const syncLink = h("button", {
    type: "button",
    class: "link sync-link",
    onclick: () => {
      if (view?.p) setSyncing(view.p, !view.p.syncing);
    },
  }) as HTMLButtonElement;
  const filters = h("div", { class: "filters" });
  const syncPanel = h("div", { class: "sync-panel", hidden: true });
  const eventList = h("div", { class: "event-list" });
  const rail = h(
    "aside",
    { class: "match-rail scroll" },
    h(
      "div",
      { class: "rail-head" },
      h("span", { class: "section-label", text: t("matches.timeline") }),
      h("span", { class: "grow" }),
      syncLink,
    ),
    syncPanel,
    filters,
    eventList,
  );

  const p: Player = {
    session,
    match,
    video,
    preview,
    previewWant: -1,
    tr: { video, fps: null, flash, fullscreen: root, seek: (s) => seek(p, s * 1000) },
    root,
    timeline,
    ruler,
    bar,
    played,
    head,
    hover,
    tip,
    tipAt,
    tipWhat,
    sel,
    selLen,
    clipLayer,
    time,
    playButton,
    range,
    clipButton,
    rail,
    filters,
    syncLink,
    syncPanel,
    eventList,
    events: [],
    eventsLoaded: false,
    rounds: [],
    clips: [],
    inMs: null,
    outMs: null,
    offsetMs: match.event_offset_ms ?? 0,
    filter: "all",
    syncing: false,
    rows: [],
    current: null,
    lastPainted: -1,
    frame: 0,
    onKey: (e) => handleKey(e),
    resize: new ResizeObserver(() => {
      if (view?.p === p) paintRuler(p);
    }),
  };

  clickToPlay(video, p.tr);
  playButton.addEventListener("click", () => togglePlay(video));
  video.addEventListener("error", () => {
    if (!box.querySelector(".trouble")) box.append(h("div", { class: "trouble", text: t("player.errorLocal") }));
  });
  for (const event of ["play", "pause", "seeked", "durationchange"]) {
    video.addEventListener(event, () => paintPlayhead(p, true));
  }
  // The hover frame seeks one position at a time; a pointer that moved on meanwhile is caught
  // up when the seek lands, instead of queueing every position it passed.
  const catchUp = () => {
    if (p.previewWant >= 0 && Math.abs(preview.currentTime - p.previewWant) > 0.25) preview.currentTime = p.previewWant;
  };
  preview.addEventListener("seeked", catchUp);
  preview.addEventListener("loadedmetadata", catchUp);

  fill(
    root,
    box,
    h("div", { class: "tl-wrap" }, timeline, tip),
    h(
      "div",
      { class: "controls" },
      playButton,
      time,
      frameStep(video, null),
      h(
        "span",
        { class: "event-steps" },
        h("button", { type: "button", text: "⏮", title: t("matches.prevEvent"), onclick: () => stepEvent(p, -1) }),
        h("button", { type: "button", text: "⏭", title: t("matches.nextEvent"), onclick: () => stepEvent(p, 1) }),
      ),
      h("span", { class: "grow" }),
      volume(video),
      speedControl(video),
      fullscreenButton(root),
    ),
    h(
      "div",
      { class: "clip-row" },
      h(
        "button",
        { type: "button", class: "btn small", onclick: () => setIn(p), title: "I" },
        t("matches.setIn"),
        h("span", { class: "key mono", text: "I" }),
      ),
      h(
        "button",
        { type: "button", class: "btn small", onclick: () => setOut(p), title: "O" },
        t("matches.setOut"),
        h("span", { class: "key mono", text: "O" }),
      ),
      range,
      h("span", { class: "grow" }),
      h("button", {
        type: "button",
        class: "btn small",
        text: t("matches.clear"),
        onclick: () => setRange(p, null, null),
      }),
      clipButton,
    ),
    note,
  );
  return p;
}

function statusPanel(session: SessionRow, match: MatchRow): HTMLElement {
  let text: string;
  if (match.status === "live") text = t("matches.statusLive");
  else if (match.status === "pending") text = t("matches.statusPending");
  else if (match.status === "missing") text = t("matches.statusMissing");
  else text = match.error ?? t("matches.statusFailed");
  return h(
    "div",
    { class: "empty-state" },
    h("span", null, text),
    session.status === "failed"
      ? h("button", {
          type: "button",
          class: "btn small",
          text: t("matches.tryAgain"),
          onclick: () => void ipc.retrySession(session.id).then(() => loadSessions()),
        })
      : null,
  );
}

// ---------------------------------------------------------------------------
// Timeline

/** Where an event is in the match file, in milliseconds. */
function eventMs(p: Player, at: string): number {
  if (!p.match.file_start_at) return p.offsetMs;
  return Date.parse(at) - Date.parse(p.match.file_start_at) + p.offsetMs;
}

function roundsOf(p: Player): Round[] {
  const rounds: Round[] = [];
  const begin = p.events.find((e) => e.kind === "match_start");
  let start = begin ? eventMs(p, begin.at) : 0;
  for (const e of p.events) {
    if (e.kind !== "round_end") continue;
    const end = eventMs(p, e.at);
    rounds.push({ n: e.round, start, end, won: e.won, ally: e.ally, enemy: e.enemy });
    start = end;
  }
  return rounds;
}

function duration(p: Player): number {
  const fromFile = Number.isFinite(p.video.duration) ? p.video.duration * 1000 : 0;
  return Math.max(1, p.match.duration_ms ?? fromFile);
}

function pct(p: Player, ms: number): string {
  return `${(Math.min(Math.max(ms / duration(p), 0), 1) * 100).toFixed(3)}%`;
}

function filterOf(e: TimelineEvent): Filter | null {
  switch (e.kind) {
    case "kill":
    case "multikill":
      return "kill";
    case "death":
    case "assist":
    case "objective":
    case "marker":
      return e.kind;
    case "round_end":
      return "round";
    default:
      return null;
  }
}

function shown(p: Player, e: TimelineEvent): boolean {
  const f = filterOf(e);
  return p.filter === "all" || f === null || f === p.filter;
}

/** The marker class an event draws with, on the timeline and beside its row alike. */
function markOf(e: TimelineEvent): string {
  switch (e.kind) {
    case "objective":
      return `objective${e.ours === true ? " ours" : e.ours === false ? " theirs" : ""}`;
    case "round_end":
      return `round${e.won === true ? " won" : e.won === false ? " lost" : ""}`;
    case "match_start":
    case "match_end":
      return "edge";
    default:
      return e.kind;
  }
}

/** Where selecting an event jumps to. */
function jumpOf(p: Player, e: TimelineEvent): number {
  if (e.kind === "round_end") {
    const round = p.rounds.find((r) => r.n === e.round);
    if (round) return round.start;
  }
  const at = eventMs(p, e.at);
  return e.kind === "match_start" || e.kind === "match_end" ? at : at - JUMP_LEAD_MS;
}

/** Everything the offset moves: the rounds, the markers, the list. */
function paintEvents(p: Player): void {
  p.rounds = roundsOf(p);
  paintBar(p);
  paintFilters(p);
  paintList(p);
  paintSync(p);
}

function paintBar(p: Player): void {
  const nodes: HTMLElement[] = p.rounds.map((r) =>
    h("span", {
      class: `tl-round ${r.won === true ? "won" : r.won === false ? "lost" : ""}${p.filter === "all" || p.filter === "round" ? "" : " dim"}`,
      style: `left:${pct(p, r.start)};width:calc(${pct(p, r.end)} - ${pct(p, r.start)})`,
    }),
  );
  for (const e of p.events) {
    if (e.kind === "round_end") continue;
    const dim = shown(p, e) ? "" : " dim";
    nodes.push(h("span", { class: `mk ${markOf(e)}${dim}`, style: `left:${pct(p, eventMs(p, e.at))}` }));
  }
  fill(p.bar, ...nodes);
}

function paintRuler(p: Player): void {
  const width = p.timeline.clientWidth;
  const secs = duration(p) / 1000;
  if (!width || secs <= 1) return;
  const step = TICK_STEPS_S.find((s) => (s / secs) * width >= TICK_MIN_PX) ?? TICK_STEPS_S[TICK_STEPS_S.length - 1];
  const nodes: HTMLElement[] = [];
  // The last label stays off the right edge, where it would be cut in half.
  for (let s = step; s < secs - step * 0.4; s += step) {
    nodes.push(h("span", { class: "tl-tick", style: `left:${pct(p, s * 1000)}` }, h("i", { text: fmtClock(s) })));
  }
  fill(p.ruler, ...nodes);
}

function paintPlayhead(p: Player, force: boolean): void {
  const ms = Math.round(p.video.currentTime * 1000);
  if (!force && ms === p.lastPainted) return;
  p.lastPainted = ms;
  const at = pct(p, ms);
  p.head.style.left = at;
  p.played.style.width = at;
  fill(p.time, fmtClock(p.video.currentTime), h("span", { class: "total", text: ` / ${fmtDuration(duration(p))}` }));
  p.playButton.textContent = p.video.paused ? "▶" : "❚❚";
  p.playButton.title = p.video.paused ? t("transport.play") : t("transport.pause");
  paintCurrent(p, ms);
}

/** Marks the row of the last moment the playhead passed, and keeps it in view while playing
 *  unless the pointer is over the list. */
function paintCurrent(p: Player, ms: number): void {
  let pick: HTMLElement | null = null;
  for (const row of p.rows) {
    if (row.ms > ms + 250) break;
    pick = row.el;
  }
  if (pick === p.current) return;
  p.current?.removeAttribute("aria-current");
  pick?.setAttribute("aria-current", "true");
  p.current = pick;
  if (pick && !p.video.paused && !p.rail.matches(":hover")) pick.scrollIntoView({ block: "nearest" });
}

/** Loads the clips taken during the match on screen. A burst of clip changes collapses into
 *  one reload running and at most one more queued behind it. */
let clipsLoading = false;
let clipsAgain = false;

async function loadMatchClips(p: Player): Promise<void> {
  if (clipsLoading) {
    clipsAgain = true;
    return;
  }
  clipsLoading = true;
  try {
    const clips = await ipc.clipsForMatch(p.match.id);
    if (view?.p !== p) return;
    p.clips = clips;
    paintClips(p);
    if (pendingClip !== null && clips.some((c) => c.clip_id === pendingClip)) {
      selectClip(p, pendingClip);
      pendingClip = null;
    }
  } catch (e) {
    console.warn("clips for match", p.match.id, e);
  } finally {
    clipsLoading = false;
    if (clipsAgain && view?.p) {
      clipsAgain = false;
      void loadMatchClips(view.p);
    }
  }
}

/** Each clip as a bar in the bottom lane, coloured like its status circle in the library. */
function paintClips(p: Player): void {
  const byId = new Map(data.clips.map((c) => [c.id, c]));
  fill(
    p.clipLayer,
    ...p.clips.map((mc) => {
      const row = byId.get(mc.clip_id);
      const badge = row ? badgeFor(row, data.progress.get(row.id), data.status, data.settings) : null;
      const kind = badge?.circle ?? (mc.published ? "published" : "local");
      return h("button", {
        type: "button",
        class: `tl-clip ${kind}`,
        "data-clip": mc.clip_id,
        style: `left:${pct(p, mc.start_ms)};width:calc(${pct(p, mc.end_ms)} - ${pct(p, mc.start_ms)})`,
        title: t("matches.clipTitle", {
          status: badge?.label ?? "",
          in: fmtPrecise(mc.start_ms),
          out: fmtPrecise(mc.end_ms),
        }),
        onclick: () => selectClip(p, mc.clip_id),
      });
    }),
  );
}

/** Selects a clip's range, puts the playhead at its start and offers the clip itself. */
function selectClip(p: Player, clipId: number): void {
  const mc = p.clips.find((c) => c.clip_id === clipId);
  const note = view?.note;
  if (!mc || !note) return;
  setRange(p, mc.start_ms, mc.end_ms);
  seek(p, mc.start_ms);
  note.className = "match-msg ok";
  fill(
    note,
    t("matches.clipSelected", { length: fmtLength(mc.end_ms - mc.start_ms) }),
    h("button", {
      type: "button",
      class: "link",
      text: t("matches.openClip"),
      onclick: () => go({ view: "player", id: clipId }),
    }),
  );
}

/** The markers within grabbing distance of a pointer, nearest first. */
function eventsNear(p: Player, clientX: number): TimelineEvent[] {
  const box = p.timeline.getBoundingClientRect();
  if (!box.width) return [];
  const x = clientX - box.left;
  const px = (e: TimelineEvent) => (eventMs(p, e.at) / duration(p)) * box.width;
  return p.events
    .filter((e) => e.kind !== "round_end" && shown(p, e) && Math.abs(px(e) - x) <= GRAB_PX)
    .sort((a, b) => Math.abs(px(a) - x) - Math.abs(px(b) - x));
}

type Grab = "in" | "out" | "head" | null;

/** What a press at `clientX` takes hold of: a range edge, the playhead, or nothing. */
function grabAt(p: Player, clientX: number): Grab {
  const box = p.timeline.getBoundingClientRect();
  if (!box.width) return null;
  const x = clientX - box.left;
  const near = (ms: number | null) => ms !== null && Math.abs((ms / duration(p)) * box.width - x) <= GRAB_PX;
  if (p.inMs !== null && p.outMs !== null) {
    if (near(p.outMs)) return "out";
    if (near(p.inMs)) return "in";
  }
  return near(p.video.currentTime * 1000) ? "head" : null;
}

function wireTimeline(p: Player): void {
  const { timeline } = p;
  const msAt = (clientX: number) => {
    const box = timeline.getBoundingClientRect();
    return Math.round(Math.min(Math.max((clientX - box.left) / box.width, 0), 1) * duration(p));
  };
  const inLane = (clientY: number) => clientY - timeline.getBoundingClientRect().top < LANE_BOTTOM_PX;
  let pressed = false;

  timeline.addEventListener("pointermove", (e) => {
    showHover(p, e.clientX, !pressed && inLane(e.clientY));
    if (pressed) return;
    const grab = grabAt(p, e.clientX);
    timeline.style.cursor =
      grab === "in" || grab === "out"
        ? "ew-resize"
        : grab === "head"
          ? "grab"
          : inLane(e.clientY) && eventsNear(p, e.clientX).length
            ? "pointer"
            : "";
  });
  timeline.addEventListener("pointerleave", () => {
    if (!pressed) hideHover(p);
  });

  timeline.addEventListener("pointerdown", (down) => {
    if (down.button !== 0) return;
    // A clip bar is a button of its own; its click selects it.
    if ((down.target as HTMLElement).closest(".tl-clip")) return;
    down.preventDefault();
    timeline.setPointerCapture(down.pointerId);
    pressed = true;
    const grab = grabAt(p, down.clientX);
    const startX = down.clientX;
    const anchor = msAt(down.clientX);
    let dragging = false;
    const move = (e: PointerEvent) => {
      if (!dragging && Math.abs(e.clientX - startX) < DRAG_PX) return;
      dragging = true;
      const at = msAt(e.clientX);
      if (grab === "head") {
        seek(p, at);
      } else if (grab === "in" && p.outMs !== null) {
        const edge = Math.min(at, p.outMs - MIN_CLIP_MS);
        setRange(p, Math.max(0, edge), p.outMs);
        seek(p, edge);
      } else if (grab === "out" && p.inMs !== null) {
        const edge = Math.max(at, p.inMs + MIN_CLIP_MS);
        setRange(p, p.inMs, Math.min(duration(p), edge));
        seek(p, edge);
      } else {
        setRange(p, Math.min(anchor, at), Math.max(anchor, at));
      }
    };
    const up = (e: PointerEvent) => {
      timeline.removeEventListener("pointermove", move);
      timeline.removeEventListener("pointerup", up);
      timeline.removeEventListener("pointercancel", up);
      pressed = false;
      if (dragging || e.type === "pointercancel") return;
      const near = inLane(e.clientY) ? eventsNear(p, e.clientX)[0] : undefined;
      seek(p, near ? jumpOf(p, near) : msAt(e.clientX));
    };
    timeline.addEventListener("pointermove", move);
    timeline.addEventListener("pointerup", up);
    timeline.addEventListener("pointercancel", up);
  });
}

/** The hover line and the tip above it: the frame there, its time, and what happened. */
function showHover(p: Player, clientX: number, snap: boolean): void {
  const box = p.timeline.getBoundingClientRect();
  if (!box.width) return;
  const near = snap ? eventsNear(p, clientX) : [];
  const ms = near.length
    ? eventMs(p, near[0].at)
    : Math.round(Math.min(Math.max((clientX - box.left) / box.width, 0), 1) * duration(p));
  p.hover.hidden = false;
  p.hover.style.left = pct(p, ms);
  p.tip.hidden = false;
  // Kept inside the timeline's width so it never runs off the stage.
  const half = p.tip.offsetWidth / 2;
  const x = (ms / duration(p)) * box.width;
  p.tip.style.left = `${Math.min(Math.max(x, half), box.width - half)}px`;
  p.tipAt.textContent = fmtPrecise(ms);
  fill(
    p.tipWhat,
    ...near.slice(0, 3).map((e) => h("span", null, h("i", { class: `mk ${markOf(e)}` }), eventLabel(e))),
  );
  p.previewWant = ms / 1000;
  if (!p.preview.seeking && p.preview.readyState >= 1 && Math.abs(p.preview.currentTime - p.previewWant) > 0.25) {
    p.preview.currentTime = p.previewWant;
  }
}

function hideHover(p: Player): void {
  p.hover.hidden = true;
  p.tip.hidden = true;
  p.timeline.style.cursor = "";
}

function seek(p: Player, ms: number): void {
  p.video.currentTime = Math.min(Math.max(ms, 0), duration(p)) / 1000;
  paintPlayhead(p, true);
}

function nowMs(p: Player): number {
  return Math.round(p.video.currentTime * 1000);
}

/** Jumps to the next or previous moment the list shows. */
function stepEvent(p: Player, direction: 1 | -1): void {
  const now = nowMs(p);
  const jumps = p.rows.map((r) => r.jump).sort((a, b) => a - b);
  const target =
    direction > 0
      ? jumps.find((j) => j > now + 100)
      : [...jumps].reverse().find((j) => j < now - PREV_SLACK_MS);
  if (target === undefined) return;
  seek(p, target);
}

function setIn(p: Player): void {
  const at = nowMs(p);
  setRange(p, at, p.outMs !== null && p.outMs > at ? p.outMs : null);
}

function setOut(p: Player): void {
  const at = nowMs(p);
  setRange(p, p.inMs !== null && p.inMs < at ? p.inMs : 0, at);
}

function setRange(p: Player, inMs: number | null, outMs: number | null): void {
  p.inMs = inMs;
  p.outMs = outMs;
  paintRange(p);
}

function paintRange(p: Player): void {
  const { inMs, outMs } = p;
  const complete = inMs !== null && outMs !== null;
  p.sel.hidden = inMs === null;
  if (inMs !== null) {
    const end = outMs ?? inMs;
    p.sel.style.left = pct(p, inMs);
    p.sel.style.width = `calc(${pct(p, end)} - ${pct(p, inMs)})`;
    p.sel.classList.toggle("open", outMs === null);
    p.selLen.textContent = complete ? fmtLength(outMs - inMs) : "";
  }
  p.range.textContent = complete
    ? `${fmtPrecise(inMs)} → ${fmtPrecise(outMs)} · ${fmtLength(outMs - inMs)}`
    : inMs !== null
      ? t("matches.rangeOpen", { in: fmtPrecise(inMs) })
      : t("matches.rangeNone");
  p.clipButton.disabled = !complete || outMs - inMs < MIN_CLIP_MS;
}

function handleKey(e: KeyboardEvent): void {
  const p = view?.p;
  if (!p || typing(e)) return;
  if ((e.ctrlKey || e.metaKey) && !e.altKey && (e.key === "ArrowLeft" || e.key === "ArrowRight")) {
    e.preventDefault();
    stepEvent(p, e.key === "ArrowRight" ? 1 : -1);
    return;
  }
  if (e.ctrlKey || e.altKey || e.metaKey) return;
  switch (e.key) {
    case "i":
    case "I":
      setIn(p);
      break;
    case "o":
    case "O":
      setOut(p);
      break;
    case "Escape":
      // Fullscreen is the webview's to leave.
      if (document.fullscreenElement) return;
      if (p.syncing) setSyncing(p, false);
      else if (p.inMs !== null) setRange(p, null, null);
      else return;
      break;
    default:
      transportKey(e, p.tr);
      return;
  }
  e.preventDefault();
}

// ---------------------------------------------------------------------------
// Event list

function paintFilters(p: Player): void {
  const counts = new Map<Filter, number>();
  for (const e of p.events) {
    const f = filterOf(e);
    if (f) counts.set(f, (counts.get(f) ?? 0) + 1);
  }
  // One kind of event needs no filter.
  if (counts.size < 2) {
    p.filter = "all";
    fill(p.filters);
    return;
  }
  if (p.filter !== "all" && !counts.has(p.filter)) p.filter = "all";
  fill(
    p.filters,
    ...FILTERS.filter((f) => f === "all" || counts.has(f)).map((f) =>
      h(
        "button",
        {
          type: "button",
          class: "chip",
          "aria-pressed": String(p.filter === f),
          onclick: () => {
            p.filter = f;
            paintBar(p);
            paintFilters(p);
            paintList(p);
          },
        },
        t(`matches.filter.${f}`),
        f === "all" ? null : h("span", { class: "count", text: String(counts.get(f) ?? 0) }),
      ),
    ),
  );
}

function paintList(p: Player): void {
  p.rows = [];
  p.current = null;
  if (!p.events.length) {
    fill(
      p.eventList,
      h("span", {
        class: "muted",
        text: p.match.detected
          ? t("matches.nothingElse")
          : t("matches.undetected", { reason: undetectedReason(p.session) }),
      }),
    );
    return;
  }
  const rounds = new Map(p.rounds.map((r) => [r.n, r]));
  const nodes: HTMLElement[] = [];
  for (const e of p.events) {
    if (!shown(p, e)) continue;
    const at = eventMs(p, e.at);
    const round = e.kind === "round_end" ? rounds.get(e.round) : undefined;
    // A round selects itself; a moment selects the fight around it.
    const range: [number, number] | null = round
      ? [round.start, round.end + ROUND_TAIL_MS]
      : e.kind === "match_start" || e.kind === "match_end"
        ? null
        : e.kind === "marker"
          ? [at - MARKER_BEFORE_MS, at + MARKER_AFTER_MS]
          : [at - (e.kind === "multikill" ? MULTIKILL_BEFORE_MS : MOMENT_BEFORE_MS), at + MOMENT_AFTER_MS];
    const jump = jumpOf(p, e);
    const [what, detail] = eventParts(e);
    let action: HTMLElement | null = null;
    if (p.syncing) {
      action = h("button", {
        type: "button",
        class: "btn small here",
        text: t("matches.sync.here"),
        title: t("matches.sync.hereTitle"),
        onclick: () => void setOffset(p, p.offsetMs + nowMs(p) - at),
      });
    } else if (range) {
      action = h("button", {
        type: "button",
        class: "pick",
        text: "✂",
        title: round ? t("matches.selectRound") : t("matches.selectMoment"),
        onclick: () => {
          const from = Math.max(0, range[0]);
          setRange(p, from, Math.min(duration(p), range[1]));
          seek(p, from);
        },
      });
    }
    const row = h(
      "div",
      { class: `event ${e.kind}` },
      h(
        "button",
        { type: "button", class: "jump", title: t("matches.jumpHere"), onclick: () => seek(p, jump) },
        h("span", { class: "at mono", text: fmtDuration(Math.max(0, at)) }),
        h("span", { class: `mk ${markOf(e)}` }),
        h("span", { class: "what" }, what, detail ? h("span", { class: "detail", text: detail }) : null),
      ),
      action,
    );
    nodes.push(row);
    p.rows.push({ ms: round ? round.start : at, jump, el: row });
  }
  p.rows.sort((a, b) => a.ms - b.ms);
  fill(p.eventList, ...(nodes.length ? nodes : [h("span", { class: "muted", text: t("matches.filter.none") })]));
  paintPlayhead(p, true);
}

/** Why a recording carries no matches. Valorant, League and Counter-Strike have providers
 *  (`providers/mod.rs`). */
function undetectedReason(session: SessionRow): string {
  if (session.game === "valorant") {
    return session.provider_reached ? t("matches.noMatchReported") : t("matches.statusUnreadable");
  }
  if (session.game === "league") {
    return session.provider_reached ? t("matches.leagueNoMatchReported") : t("matches.leagueUnavailable");
  }
  if (session.game === "counter_strike") {
    return session.provider_reached ? t("matches.csNoMatchReported") : t("matches.csUnavailable");
  }
  if (session.game === "other") {
    return t("matches.backgroundRecording", { hours: data.settings?.other_games_hours ?? 2 });
  }
  return t("matches.noDetection", { game: session.game_name });
}

function eventLabel(e: TimelineEvent): string {
  return eventParts(e).filter(Boolean).join(" · ");
}

/** What happened, and the detail that goes after it in quieter type: who, which side, how. */
function eventParts(e: TimelineEvent): [string, string | null] {
  const rest = (...bits: (string | null | undefined | false)[]) => bits.filter(Boolean).join(" · ") || null;
  switch (e.kind) {
    case "match_start":
      return [t("matches.event.matchStart"), rest(mapLabel(e.map), modeLabel(e.mode))];
    case "round_end": {
      const verdict =
        e.won === true
          ? t("matches.event.won")
          : e.won === false
            ? t("matches.event.lost")
            : t("matches.event.decided");
      return [t("matches.event.round", { n: e.round, verdict, ally: e.ally, enemy: e.enemy }), null];
    }
    case "match_end": {
      const result = e.result ? t(`matches.result.${e.result}`) : null;
      const why =
        e.reason === "lost"
          ? t("matches.event.reasonLost")
          : e.reason === "session_ended"
            ? t("matches.event.reasonSessionEnded")
            : e.reason === "superseded"
              ? t("matches.event.reasonSuperseded")
              : null;
      const scoreText = e.ally !== null && e.enemy !== null ? `${e.ally}–${e.enemy}` : null;
      return [t("matches.event.matchEnd"), rest(result, scoreText, why)];
    }
    case "kill":
      return [t("matches.event.kill"), rest(unitLabel(e.victim), e.weapon, e.headshot && t("matches.event.headshot"))];
    case "death":
      return [t("matches.event.death"), rest(unitLabel(e.killer), e.weapon)];
    case "assist":
      return [t("matches.event.assist"), rest(unitLabel(e.victim))];
    case "multikill":
      return [multikillLabel(e.count), null];
    case "objective":
      return [
        objectiveLabel(e.name),
        rest(e.ours === true ? t("matches.event.yourTeam") : e.ours === false ? t("matches.event.enemyTeam") : null),
      ];
    case "marker":
      return [t("matches.event.marker"), null];
  }
}

function multikillLabel(count: number): string {
  switch (count) {
    case 2:
      return t("matches.event.doubleKill");
    case 3:
      return t("matches.event.tripleKill");
    case 4:
      return t("matches.event.quadraKill");
    case 5:
      return t("matches.event.pentaKill");
    default:
      return t("matches.event.nKills", { n: count });
  }
}

// ---------------------------------------------------------------------------
// Sync: moving every event on a match by the same amount

function setSyncing(p: Player, on: boolean): void {
  p.syncing = on;
  paintSync(p);
  paintList(p);
}

function paintSync(p: Player): void {
  const offset = p.offsetMs ? t("matches.sync.shifted", { offset: fmtOffset(p.offsetMs) }) : null;
  p.syncLink.hidden = !p.eventsLoaded || !p.events.length || !p.match.file_start_at;
  p.syncLink.textContent = p.syncing ? t("matches.sync.done") : offset ? `${offset} · ${t("matches.sync.open")}` : t("matches.sync.open");
  p.syncPanel.hidden = !p.syncing;
  if (!p.syncing) return;
  const nudge = (by: number) =>
    h("button", {
      type: "button",
      class: "btn small",
      text: `${by < 0 ? "−" : "+"}${Math.abs(by) / 1000} s`,
      onclick: () => void setOffset(p, p.offsetMs + by),
    });
  fill(
    p.syncPanel,
    h("span", { class: "help", text: t("matches.sync.help") }),
    h(
      "div",
      { class: "sync-row" },
      nudge(-NUDGE_MS),
      h("span", { class: "offset mono", text: fmtOffset(p.offsetMs) }),
      nudge(NUDGE_MS),
      h("span", { class: "grow" }),
      h("button", {
        type: "button",
        class: "btn small",
        text: t("matches.sync.reset"),
        disabled: p.offsetMs === 0,
        onclick: () => void setOffset(p, 0),
      }),
    ),
  );
}

async function setOffset(p: Player, ms: number): Promise<void> {
  const next = Math.round(Math.min(Math.max(ms, -MAX_OFFSET_MS), MAX_OFFSET_MS));
  const before = p.offsetMs;
  if (next === before) return;
  p.offsetMs = next;
  paintEvents(p);
  try {
    // Rust announces the change, which reloads the sessions; the view is keyed so it stays.
    await ipc.setMatchEventOffset(p.match.id, next);
  } catch (e) {
    if (view?.p !== p || p.offsetMs !== next) return;
    p.offsetMs = before;
    paintEvents(p);
    if (view.note) {
      view.note.className = "match-msg err";
      fill(view.note, t("matches.sync.failed", { error: ipc.errorText(e) }));
    }
  }
}

function fmtOffset(ms: number): string {
  return `${ms < 0 ? "−" : "+"}${fmtDecimal(Math.abs(ms) / 1000, 1)} s`;
}

// ---------------------------------------------------------------------------
// Actions

async function makeClip(): Promise<void> {
  const p = view?.p;
  const note = view?.note;
  if (!p || !note) return;
  const { inMs, outMs, match, clipButton } = p;
  if (inMs === null || outMs === null) return;
  clipButton.disabled = true;
  note.className = "match-msg";
  fill(note, t("matches.copying"));
  try {
    const id = await ipc.clipFromMatch(match.id, inMs, outMs);
    void loadClips();
    if (view?.note !== note) return;
    note.className = "match-msg ok";
    fill(
      note,
      t("matches.clipAdded", { length: fmtLength(outMs - inMs) }),
      h("button", {
        type: "button",
        class: "link",
        text: t("matches.openIt"),
        onclick: () => go({ view: "player", id }),
      }),
    );
  } catch (e) {
    if (view?.note !== note) return;
    note.className = "match-msg err";
    fill(note, ipc.errorText(e));
  } finally {
    if (view?.p === p) paintRange(p);
  }
}

async function removeMatch(id: number): Promise<void> {
  try {
    await ipc.deleteMatch(id);
    selection = null;
  } catch (e) {
    if (view?.note) {
      view.note.className = "match-msg err";
      fill(view.note, ipc.errorText(e));
    }
  }
  await loadSessions();
}

async function removeSession(id: number): Promise<void> {
  try {
    await ipc.deleteSession(id);
    selection = null;
  } catch (e) {
    if (view?.note) {
      view.note.className = "match-msg err";
      fill(view.note, ipc.errorText(e));
    }
  }
  await loadSessions();
}

// ---------------------------------------------------------------------------
// Formatting

function fmtPrecise(ms: number): string {
  const total = Math.max(0, ms) / 1000;
  const m = Math.floor(total / 60);
  const s = total - m * 60;
  return `${m}:${s.toFixed(1).padStart(4, "0")}`;
}

function fmtLength(ms: number): string {
  return ms < 60_000 ? `${fmtDecimal(ms / 1000, 1)} s` : fmtDuration(ms);
}
