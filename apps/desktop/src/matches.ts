/** Matches: every recorded game session cut into its matches, each with the timeline the game
 *  reported, and the place to take clips out of them after playing.
 *
 *  Times on the timeline come from Rust as wall-clock instants. A match file knows when its
 *  first frame was (`file_start_at`), so an event sits at `at - file_start_at` into the video.
 *  The selection and the in/out marks survive a data refresh as long as the match itself did
 *  not change, so a session ending in the background does not reset the video being watched. */

import { convertFileSrc } from "@tauri-apps/api/core";
import { confirming, fill, h } from "./dom";
import { dayLabel, fmtBytes, fmtDuration, fmtTimeOnly, fmtWhenLong, hueFor } from "./format";
import * as ipc from "./ipc";
import { go } from "./router";
import { data, loadClips, loadSessions, on } from "./store";
import type { MatchRow, SessionRow, TimelineEvent } from "./types";

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
}

export function mountMatches(root: HTMLElement, session?: number, match?: number): void {
  if (match !== undefined) selection = { kind: "match", id: match };
  else if (session !== undefined) selection = { kind: "session", id: session };
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
          : h(
              "span",
              { class: "muted" },
              "Nothing recorded yet. Play Valorant, League of Legends or Counter-Strike and every match lands here when you close the game.",
            ),
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
      ? h("span", { class: "badge live", text: "● Recording" })
      : s.status === "processing"
        ? h("span", { class: "badge encoding", text: "Cutting…" })
        : s.status === "failed"
          ? h("span", { class: "badge failed", text: "Failed" })
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
  return s.ended_at ? `${from}–${fmtTimeOnly(s.ended_at)}` : `${from}–now`;
}

function sessionNote(s: SessionRow): string {
  if (s.status === "recording") return "No match yet.";
  if (s.status === "processing") return "Cutting into matches…";
  if (s.status === "failed") return s.error ?? "Could not be cut.";
  return "No matches.";
}

function matchTitle(m: MatchRow, index: number, s: SessionRow): string {
  if (!m.detected) return s.matches.length > 1 ? `Recording ${index + 1}` : "Whole session";
  const parts = [m.map, m.mode].filter(Boolean);
  return parts.length ? parts.join(" · ") : `Match ${index + 1}`;
}

function score(m: MatchRow): string | null {
  return m.ally_score !== null && m.enemy_score !== null ? `${m.ally_score}–${m.enemy_score}` : null;
}

function matchMeta(m: MatchRow): string {
  switch (m.status) {
    case "live":
      return ["in progress", score(m)].filter(Boolean).join(" · ");
    case "pending":
      return "waiting to be cut";
    case "missing":
      return "no footage";
    case "failed":
      return "could not be cut";
    case "ready":
      return [fmtDuration(m.duration_ms ?? 0), score(m)].filter(Boolean).join(" · ");
  }
}

function resultLetter(r: NonNullable<MatchRow["result"]>): string {
  return r === "win" ? "W" : r === "loss" ? "L" : "D";
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
      h("div", { class: "empty-state" }, session ? sessionNote(session) : "That session is gone."),
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
        h(
          "span",
          null,
          data.sessions.length
            ? "Pick a match on the left."
            : "Close a game you played and its matches show up here, ready to clip.",
        ),
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
    match.result ? { win: "Win", loss: "Loss", draw: "Draw" }[match.result] : null,
    match.size ? fmtBytes(match.size) : null,
  ].filter(Boolean);

  const actions = h("div", { class: "actions" });
  if (match.path) {
    actions.append(
      h("button", {
        type: "button",
        class: "btn small",
        text: "Open folder",
        onclick: () => void ipc.openMatchFolder(match.id),
      }),
    );
  }
  const busy = session.status === "recording" || session.status === "processing";
  if (!busy) {
    actions.append(
      confirming(
        h("button", { type: "button", class: "btn small danger" }) as HTMLButtonElement,
        "Delete match",
        "Confirm delete",
        () => void removeMatch(match.id),
      ),
    );
    if (session.matches.length > 1) {
      actions.append(
        confirming(
          h("button", { type: "button", class: "btn small danger" }) as HTMLButtonElement,
          "Delete session",
          `Delete all ${session.matches.length}`,
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
  const sel = h("div", { class: "tl-sel", hidden: true });
  const playhead = h("div", { class: "tl-head" });
  const timeline = h("div", { class: "tl" }, bar, sel, playhead);
  const range = h("span", { class: "range mono" });
  const clipButton = h("button", {
    type: "button",
    class: "btn primary",
    text: "Make clip",
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
    inMs: null,
    outMs: null,
    frame: 0,
    onKey,
  };

  wireTimeline(timeline);
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
          h("button", { type: "button", class: "btn small", onclick: () => setIn(), title: "I" }, "Set in ", h("span", { class: "key mono", text: "I" })),
          h("button", { type: "button", class: "btn small", onclick: () => setOut(), title: "O" }, "Set out ", h("span", { class: "key mono", text: "O" })),
          range,
          h("span", { class: "grow" }),
          h("button", { type: "button", class: "btn small", text: "Clear", onclick: () => setRange(null, null) }),
          clipButton,
        ),
        note,
        h("span", {
          class: "hint",
          text: "Drag across the timeline to pick a clip, click it to jump. The clip goes to the library with a little extra either side, so you can still trim it there.",
        }),
      ),
      h("aside", { class: "match-rail scroll" }, h("span", { class: "section-label", text: "Timeline" }), eventList),
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
  fill(eventList, h("span", { class: "muted", text: "Reading the timeline…" }));
}

function statusPanel(session: SessionRow, match: MatchRow): HTMLElement {
  let text: string;
  if (match.status === "live") text = "This match is being played right now. It will be here once you close the game.";
  else if (match.status === "pending") text = "Cutting this match out of the session recording…";
  else if (match.status === "missing")
    text = "Nothing was recorded while this match was played. The recorder was not running at the time.";
  else text = match.error ?? "This match could not be cut.";
  return h(
    "div",
    { class: "empty-state" },
    h("span", null, text),
    session.status === "failed"
      ? h("button", {
          type: "button",
          class: "btn small",
          text: "Try again",
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
      title: `Round ${r.n} · ${r.ally}–${r.enemy}`,
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

function wireTimeline(timeline: HTMLElement): void {
  const msAt = (e: PointerEvent) => {
    const box = timeline.getBoundingClientRect();
    return Math.round(Math.min(Math.max((e.clientX - box.left) / box.width, 0), 1) * duration());
  };
  timeline.addEventListener("pointerdown", (down) => {
    if (!view?.video) return;
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
      ? `in ${fmtPrecise(inMs)} · set the out point`
      : "No clip selected";
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
          ? "The game reported nothing else about this match."
          : `${undetectedReason(session)}, so the whole recording was kept. Drag across the timeline to pick a clip.`,
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
          title: "Jump here",
          onclick: () => seek(round ? round.start : at),
        },
        h("span", { class: "at mono", text: fmtDuration(Math.max(0, at)) }),
        h("span", { class: "what", text: eventLabel(e) }),
      ),
      range
        ? h("button", {
            type: "button",
            class: "btn small",
            text: "Select",
            title: round ? "Select this round on the timeline" : "Select the moments around this on the timeline",
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
    return session.provider_reached
      ? "Valorant reported no match while this was recorded"
      : "Valorant's status could not be read from the Riot Client while this was recorded";
  }
  if (session.game === "league") {
    return session.provider_reached
      ? "League reported no match while this was recorded"
      : "League's live game data was not available while this was recorded (sessions from before match detection look like this too)";
  }
  return `${session.game_name} has no match detection yet`;
}

function eventLabel(e: TimelineEvent): string {
  switch (e.kind) {
    case "match_start":
      return ["Match start", e.map, e.mode].filter(Boolean).join(" · ");
    case "round_end": {
      const verdict = e.won === true ? "won" : e.won === false ? "lost" : "decided";
      return `Round ${e.round} ${verdict} · ${e.ally}–${e.enemy}`;
    }
    case "match_end": {
      const result = e.result ? { win: "Win", loss: "Loss", draw: "Draw" }[e.result] : null;
      const why =
        e.reason === "lost"
          ? "the game went quiet"
          : e.reason === "session_ended"
            ? "the game closed"
            : e.reason === "superseded"
              ? "another match started"
              : null;
      const scoreText = e.ally !== null && e.enemy !== null ? `${e.ally}–${e.enemy}` : null;
      return ["Match end", result, scoreText, why].filter(Boolean).join(" · ");
    }
    case "kill":
      return ["Kill", e.victim, e.weapon, e.headshot ? "headshot" : null].filter(Boolean).join(" · ");
    case "death":
      return ["Death", e.killer, e.weapon].filter(Boolean).join(" · ");
    case "assist":
      return ["Assist", e.victim].filter(Boolean).join(" · ");
    case "multikill":
      return MULTIKILLS[e.count] ?? `${e.count} kills`;
    case "objective":
      return [e.name, e.ours === true ? "your team" : e.ours === false ? "enemy team" : null]
        .filter(Boolean)
        .join(" · ");
  }
}

const MULTIKILLS: Record<number, string> = {
  2: "Double kill",
  3: "Triple kill",
  4: "Quadra kill",
  5: "Penta kill",
};

// ---------------------------------------------------------------------------
// Actions

async function makeClip(): Promise<void> {
  if (!view?.clipButton || !view.note) return;
  const { inMs, outMs, match, note, clipButton } = view;
  if (inMs === null || outMs === null) return;
  clipButton.disabled = true;
  note.className = "match-msg";
  fill(note, "Copying the footage…");
  try {
    const id = await ipc.clipFromMatch(match.id, inMs, outMs);
    void loadClips();
    if (view?.note !== note) return;
    note.className = "match-msg ok";
    fill(
      note,
      `Clip added to the library (${fmtLength(outMs - inMs)}). `,
      h("button", { type: "button", class: "link", text: "Open it", onclick: () => go({ view: "player", id }) }),
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
