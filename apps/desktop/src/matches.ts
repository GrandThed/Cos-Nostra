/** Matches: every recorded game session cut into its matches, each with the timeline the game
 *  reported, and the place to take clips out of them after playing.
 *
 *  Times on the timeline come from Rust as wall-clock instants. A match file knows when its
 *  first frame was (`file_start_at`), so an event sits at `at - file_start_at` into the video.
 *  The selection and the in/out marks survive a data refresh as long as the match itself did
 *  not change, so a session ending in the background does not reset the video being watched. */

import { convertFileSrc } from "@tauri-apps/api/core";
import { badgeFor } from "./clips";
import { confirming, fill, h } from "./dom";
import { dayLabel, fmtBytes, fmtDuration, fmtTimeOnly, fmtWhenLong, hueFor } from "./format";
import { onLanguage, t } from "./i18n";
import * as ipc from "./ipc";
import { go } from "./router";
import { data, loadClips, loadSessions, on } from "./store";
import type { MatchClip, MatchRow, SessionRow, TimelineEvent } from "./types";

/** Kept after the moment a round is decided when clipping it, for the kill and the reaction. */
const ROUND_TAIL_MS = 3000;
/** Selecting a moment (a kill, a dragon) takes this much before it, for the fight leading up. */
const MOMENT_BEFORE_MS = 12_000;
/** A multikill is stamped at its last kill, so the lead-up is longer. */
const MULTIKILL_BEFORE_MS = 20_000;
const MOMENT_AFTER_MS = 4_000;
const MIN_CLIP_MS = 1000;
/** A pointer that moves less than this on the timeline is a click (seek), not a drag (select). */
const DRAG_PX = 4;

type Selection = { kind: "match"; id: number } | { kind: "session"; id: number } | null;

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
  video: HTMLVideoElement | null;
  bar: HTMLElement | null;
  head: HTMLElement | null;
  sel: HTMLElement | null;
  range: HTMLElement | null;
  clipButton: HTMLButtonElement | null;
  note: HTMLElement | null;
  events: TimelineEvent[];
  rounds: Round[];
  /** Clips taken during this match, as ranges of its file. */
  clips: MatchClip[];
  clipLayer: HTMLElement | null;
  inMs: number | null;
  outMs: number | null;
  frame: number;
  onKey: (e: KeyboardEvent) => void;
}

let view: View | null = null;

const thumbs = new Map<number, { key: string; url: string | null }>();

export function initMatches(): void {
  on("sessions", () => {
    if (parts) render();
  });
  // A clip saved, published or re-ranged moves its bar; a percentage only recolours it.
  on("clips", () => {
    if (view?.clipLayer) void loadMatchClips(view);
  });
  on("progress", () => paintClips());
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
    return s.matches.length > 1
      ? t("matches.recordingN", { n: index + 1 })
      : t("matches.wholeSession");
  }
  const parts = [m.map, m.mode].filter(Boolean);
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
  cancelAnimationFrame(view.frame);
  document.removeEventListener("keydown", view.onKey);
  view.video?.pause();
  view.video?.removeAttribute("src");
  view.video?.load();
  view = null;
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
  const onKey = (e: KeyboardEvent) => handleKey(e);

  if (match.status !== "ready" || !match.path) {
    view = {
      key,
      match,
      video: null,
      bar: null,
      head: null,
      sel: null,
      range: null,
      clipButton: null,
      note,
      events: [],
      rounds: [],
      clips: [],
      clipLayer: null,
      inMs: null,
      outMs: null,
      frame: 0,
      onKey,
    };
    fill(main, header, h("div", { class: "match-body scroll" }, statusPanel(session, match)));
    return;
  }

  const video = h("video", {
    controls: true,
    preload: "metadata",
    src: convertFileSrc(match.path),
  }) as HTMLVideoElement;
  const bar = h("div", { class: "tl-bar" });
  // Its own lane along the bottom, so a clip never sits on top of a kill it contains.
  const clipLayer = h("div", { class: "tl-clips" });
  const sel = h("div", { class: "tl-sel", hidden: true });
  const playhead = h("div", { class: "tl-head" });
  const timeline = h("div", { class: "tl" }, bar, clipLayer, sel, playhead);
  const range = h("span", { class: "range mono" });
  const clipButton = h("button", {
    type: "button",
    class: "btn primary",
    text: t("matches.makeClip"),
    disabled: true,
    onclick: () => void makeClip(),
  }) as HTMLButtonElement;
  const eventList = h("div", { class: "event-list" });

  view = {
    key,
    match,
    video,
    bar,
    head: playhead,
    sel,
    range,
    clipButton,
    note,
    events: [],
    rounds: [],
    clips: [],
    clipLayer,
    inMs: null,
    outMs: null,
    frame: 0,
    onKey,
  };

  wireTimeline(timeline);
  void loadMatchClips(view);
  document.addEventListener("keydown", onKey);

  fill(
    main,
    header,
    h(
      "div",
      { class: "match-body" },
      h(
        "div",
        { class: "match-stage scroll" },
        h("div", { class: "video" }, video),
        timeline,
        h("div", { class: "tl-scale mono" }, h("span", { text: "0:00" }), h("span", { text: fmtDuration(match.duration_ms ?? 0) })),
        h(
          "div",
          { class: "clip-row" },
          h(
            "button",
            { type: "button", class: "btn small", onclick: () => setIn(), title: "I" },
            t("matches.setIn"),
            h("span", { class: "key mono", text: "I" }),
          ),
          h(
            "button",
            { type: "button", class: "btn small", onclick: () => setOut(), title: "O" },
            t("matches.setOut"),
            h("span", { class: "key mono", text: "O" }),
          ),
          range,
          h("span", { class: "grow" }),
          h("button", {
            type: "button",
            class: "btn small",
            text: t("matches.clear"),
            onclick: () => setRange(null, null),
          }),
          clipButton,
        ),
        note,
        h("span", { class: "hint", text: t("matches.hint") }),
      ),
      h(
        "aside",
        { class: "match-rail scroll" },
        h("span", { class: "section-label", text: t("matches.timeline") }),
        eventList,
      ),
    ),
  );

  paintRange();
  const tick = () => {
    if (!view) return;
    paintPlayhead();
    view.frame = requestAnimationFrame(tick);
  };
  view.frame = requestAnimationFrame(tick);

  void ipc
    .matchEvents(match.id)
    .then((events) => {
      if (view?.match.id !== match.id) return;
      view.events = events;
      view.rounds = roundsOf(events, match);
      paintBar();
      fill(eventList, ...eventRows(session, match));
    })
    .catch((e) => fill(eventList, h("span", { class: "muted", text: ipc.errorText(e) })));
  paintBar();
  fill(eventList, h("span", { class: "muted", text: t("matches.readingTimeline") }));
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

function offset(match: MatchRow, at: string): number {
  if (!match.file_start_at) return 0;
  return Date.parse(at) - Date.parse(match.file_start_at);
}

function roundsOf(events: TimelineEvent[], match: MatchRow): Round[] {
  const rounds: Round[] = [];
  const begin = events.find((e) => e.kind === "match_start");
  let start = begin ? offset(match, begin.at) : 0;
  for (const e of events) {
    if (e.kind !== "round_end") continue;
    const end = offset(match, e.at);
    rounds.push({ n: e.round, start, end, won: e.won, ally: e.ally, enemy: e.enemy });
    start = end;
  }
  return rounds;
}

function duration(): number {
  return Math.max(1, view?.match.duration_ms ?? 1);
}

function pct(ms: number): string {
  return `${(Math.min(Math.max(ms / duration(), 0), 1) * 100).toFixed(3)}%`;
}

function paintBar(): void {
  if (!view?.bar) return;
  const nodes: HTMLElement[] = view.rounds.map((r) =>
    h("span", {
      class: `tl-round ${r.won === true ? "won" : r.won === false ? "lost" : ""}`,
      style: `left:${pct(r.start)};width:calc(${pct(r.end)} - ${pct(r.start)})`,
      title: t("matches.roundTitle", { n: r.n, ally: r.ally, enemy: r.enemy }),
    }),
  );
  for (const e of view.events) {
    const at = offset(view.match, e.at);
    if (e.kind === "match_start" || e.kind === "match_end") {
      nodes.push(h("span", { class: "tl-edge", style: `left:${pct(at)}`, title: eventLabel(e) }));
    } else if (e.kind !== "round_end") {
      const side = e.kind === "objective" ? (e.ours === true ? " ours" : e.ours === false ? " theirs" : "") : "";
      nodes.push(h("span", { class: `tl-dot ${e.kind}${side}`, style: `left:${pct(at)}`, title: eventLabel(e) }));
    }
  }
  fill(view.bar, ...nodes);
}

function paintPlayhead(): void {
  if (!view?.video || !view.head) return;
  view.head.style.left = pct(view.video.currentTime * 1000);
}

/** Loads the clips taken during the match on screen. A burst of clip changes collapses into
 *  one reload running and at most one more queued behind it. */
let clipsLoading = false;
let clipsAgain = false;

async function loadMatchClips(v: View): Promise<void> {
  if (clipsLoading) {
    clipsAgain = true;
    return;
  }
  clipsLoading = true;
  try {
    const clips = await ipc.clipsForMatch(v.match.id);
    if (view !== v) return;
    v.clips = clips;
    paintClips();
    if (pendingClip !== null && clips.some((c) => c.clip_id === pendingClip)) {
      selectClip(pendingClip);
      pendingClip = null;
    }
  } catch (e) {
    console.warn("clips for match", v.match.id, e);
  } finally {
    clipsLoading = false;
    if (clipsAgain && view) {
      clipsAgain = false;
      void loadMatchClips(view);
    }
  }
}

/** Each clip as a bar in the bottom lane, coloured like its status circle in the library. */
function paintClips(): void {
  if (!view?.clipLayer) return;
  const byId = new Map(data.clips.map((c) => [c.id, c]));
  fill(
    view.clipLayer,
    ...view.clips.map((mc) => {
      const row = byId.get(mc.clip_id);
      const badge = row ? badgeFor(row, data.progress.get(row.id), data.status, data.settings) : null;
      const kind = badge?.circle ?? (mc.published ? "published" : "local");
      return h("button", {
        type: "button",
        class: `tl-clip ${kind}`,
        "data-clip": mc.clip_id,
        style: `left:${pct(mc.start_ms)};width:calc(${pct(mc.end_ms)} - ${pct(mc.start_ms)})`,
        title: t("matches.clipTitle", {
          status: badge?.label ?? "",
          in: fmtPrecise(mc.start_ms),
          out: fmtPrecise(mc.end_ms),
        }),
        onclick: () => selectClip(mc.clip_id),
      });
    }),
  );
}

/** Selects a clip's range, puts the playhead at its start and offers the clip itself. */
function selectClip(clipId: number): void {
  const mc = view?.clips.find((c) => c.clip_id === clipId);
  if (!view || !mc || !view.note) return;
  setRange(mc.start_ms, mc.end_ms);
  seek(mc.start_ms);
  view.note.className = "match-msg ok";
  fill(
    view.note,
    t("matches.clipSelected", { length: fmtLength(mc.end_ms - mc.start_ms) }),
    h("button", {
      type: "button",
      class: "link",
      text: t("matches.openClip"),
      onclick: () => go({ view: "player", id: clipId }),
    }),
  );
}

function wireTimeline(timeline: HTMLElement): void {
  const msAt = (e: PointerEvent) => {
    const box = timeline.getBoundingClientRect();
    return Math.round(Math.min(Math.max((e.clientX - box.left) / box.width, 0), 1) * duration());
  };
  timeline.addEventListener("pointerdown", (down) => {
    if (!view?.video) return;
    // A clip bar is a button of its own; its click selects it.
    if ((down.target as HTMLElement).closest(".tl-clip")) return;
    down.preventDefault();
    timeline.setPointerCapture(down.pointerId);
    const startX = down.clientX;
    const anchor = msAt(down);
    let dragging = false;
    const move = (e: PointerEvent) => {
      if (!dragging && Math.abs(e.clientX - startX) < DRAG_PX) return;
      dragging = true;
      const at = msAt(e);
      setRange(Math.min(anchor, at), Math.max(anchor, at));
    };
    const up = (e: PointerEvent) => {
      timeline.removeEventListener("pointermove", move);
      timeline.removeEventListener("pointerup", up);
      if (!dragging) seek(msAt(e));
    };
    timeline.addEventListener("pointermove", move);
    timeline.addEventListener("pointerup", up);
  });
}

function seek(ms: number): void {
  if (!view?.video) return;
  view.video.currentTime = Math.min(Math.max(ms, 0), duration()) / 1000;
  paintPlayhead();
}

function nowMs(): number {
  return Math.round((view?.video?.currentTime ?? 0) * 1000);
}

function setIn(): void {
  if (!view) return;
  const at = nowMs();
  setRange(at, view.outMs !== null && view.outMs > at ? view.outMs : null);
}

function setOut(): void {
  if (!view) return;
  const at = nowMs();
  setRange(view.inMs !== null && view.inMs < at ? view.inMs : 0, at);
}

function setRange(inMs: number | null, outMs: number | null): void {
  if (!view) return;
  view.inMs = inMs;
  view.outMs = outMs;
  paintRange();
}

function paintRange(): void {
  if (!view?.sel || !view.range || !view.clipButton) return;
  const { inMs, outMs } = view;
  const complete = inMs !== null && outMs !== null;
  view.sel.hidden = !complete && inMs === null;
  if (inMs !== null) {
    const end = outMs ?? inMs;
    view.sel.style.left = pct(inMs);
    view.sel.style.width = `calc(${pct(end)} - ${pct(inMs)})`;
    view.sel.classList.toggle("open", outMs === null);
  }
  view.range.textContent = complete
    ? `${fmtPrecise(inMs)} → ${fmtPrecise(outMs)} · ${fmtLength(outMs - inMs)}`
    : inMs !== null
      ? t("matches.rangeOpen", { in: fmtPrecise(inMs) })
      : t("matches.rangeNone");
  view.clipButton.disabled = !complete || outMs - inMs < MIN_CLIP_MS;
}

function handleKey(e: KeyboardEvent): void {
  const target = e.target as HTMLElement | null;
  if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable)) return;
  if (e.ctrlKey || e.altKey || e.metaKey) return;
  const key = e.key.toLowerCase();
  if (key === "i") {
    e.preventDefault();
    setIn();
  } else if (key === "o") {
    e.preventDefault();
    setOut();
  }
}

// ---------------------------------------------------------------------------
// Event list

function eventRows(session: SessionRow, match: MatchRow): HTMLElement[] {
  if (!view) return [];
  if (!view.events.length) {
    return [
      h("span", {
        class: "muted",
        text: match.detected
          ? t("matches.nothingElse")
          : t("matches.undetected", { reason: undetectedReason(session) }),
      }),
    ];
  }
  const rounds = new Map(view.rounds.map((r) => [r.n, r]));
  return view.events.map((e) => {
    const at = offset(match, e.at);
    const round = e.kind === "round_end" ? rounds.get(e.round) : undefined;
    const tone = toneOf(e);
    // A round selects itself; a moment selects the fight around it.
    const range: [number, number] | null = round
      ? [round.start, round.end + ROUND_TAIL_MS]
      : e.kind === "match_start" || e.kind === "match_end"
        ? null
        : [at - (e.kind === "multikill" ? MULTIKILL_BEFORE_MS : MOMENT_BEFORE_MS), at + MOMENT_AFTER_MS];
    return h(
      "div",
      { class: `event ${e.kind} ${tone}`.trim() },
      h(
        "button",
        {
          type: "button",
          class: "jump",
          title: t("matches.jumpHere"),
          onclick: () => seek(round ? round.start : at),
        },
        h("span", { class: "at mono", text: fmtDuration(Math.max(0, at)) }),
        h("span", { class: "what", text: eventLabel(e) }),
      ),
      range
        ? h("button", {
            type: "button",
            class: "btn small",
            text: t("matches.select"),
            title: round ? t("matches.selectRound") : t("matches.selectMoment"),
            onclick: () => {
              const from = Math.max(0, range[0]);
              setRange(from, Math.min(duration(), range[1]));
              seek(from);
            },
          })
        : null,
    );
  });
}

/** The edge colour of a row: green for what went the player's way, red for what did not. */
function toneOf(e: TimelineEvent): "won" | "lost" | "" {
  const good = (yes: boolean | null) => (yes === true ? "won" : yes === false ? "lost" : "");
  switch (e.kind) {
    case "round_end":
      return good(e.won);
    case "match_end":
      return good(e.result === "win" ? true : e.result === "loss" ? false : null);
    case "objective":
      return good(e.ours);
    case "kill":
    case "multikill":
      return "won";
    case "death":
      return "lost";
    default:
      return "";
  }
}

/** Why a recording carries no matches. Valorant and League have providers (`providers/mod.rs`). */
function undetectedReason(session: SessionRow): string {
  if (session.game === "valorant") {
    return session.provider_reached ? t("matches.noMatchReported") : t("matches.statusUnreadable");
  }
  if (session.game === "league") {
    return session.provider_reached ? t("matches.leagueNoMatchReported") : t("matches.leagueUnavailable");
  }
  return t("matches.noDetection", { game: session.game_name });
}

function eventLabel(e: TimelineEvent): string {
  switch (e.kind) {
    case "match_start":
      return [t("matches.event.matchStart"), e.map, e.mode].filter(Boolean).join(" · ");
    case "round_end": {
      const verdict =
        e.won === true
          ? t("matches.event.won")
          : e.won === false
            ? t("matches.event.lost")
            : t("matches.event.decided");
      return t("matches.event.round", {
        n: e.round,
        verdict,
        ally: e.ally,
        enemy: e.enemy,
      });
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
      return [t("matches.event.matchEnd"), result, scoreText, why].filter(Boolean).join(" · ");
    }
    case "kill":
      return [t("matches.event.kill"), e.victim, e.weapon, e.headshot ? t("matches.event.headshot") : null]
        .filter(Boolean)
        .join(" · ");
    case "death":
      return [t("matches.event.death"), e.killer, e.weapon].filter(Boolean).join(" · ");
    case "assist":
      return [t("matches.event.assist"), e.victim].filter(Boolean).join(" · ");
    case "multikill":
      return multikillLabel(e.count);
    case "objective":
      return [
        e.name,
        e.ours === true ? t("matches.event.yourTeam") : e.ours === false ? t("matches.event.enemyTeam") : null,
      ]
        .filter(Boolean)
        .join(" · ");
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
// Actions

async function makeClip(): Promise<void> {
  if (!view?.clipButton || !view.note) return;
  const { inMs, outMs, match, note, clipButton } = view;
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
    if (view?.note === note) paintRange();
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
  return ms < 60_000 ? `${(ms / 1000).toFixed(1)} s` : fmtDuration(ms);
}
