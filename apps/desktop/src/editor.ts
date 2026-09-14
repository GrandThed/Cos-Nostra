/** The range editor: one kept range, with a start and an end handle, over the match the clip
 *  was taken in (or over the clip's own recording when that match is gone).
 *
 *  On a match the handles can go past the footage the clip already has, which is drawn as a
 *  band under the filmstrip; Apply then copies the wider range out of the match. Whether that
 *  happens, whether anything is encoded and whether a published clip is replaced are all
 *  decided in Rust (`edit::apply`); the editor only says which range and on which file.
 *
 *  The keys are the ones every clip trimmer shares: I and O set the start and end at the
 *  playhead, [ and ] jump between the edges, Ctrl+Z undoes, Ctrl+Enter applies. */

import { convertFileSrc } from "@tauri-apps/api/core";
import { gameLabel } from "./clips";
import { confirming, fill, h } from "./dom";
import { fmtClock, fmtWhen, hueFor } from "./format";
import { t } from "./i18n";
import * as ipc from "./ipc";
import { frameStep, loopToggle, volume } from "./player";
import { go } from "./router";
import { data } from "./store";
import type { ClipRow, EditSource, Segment } from "./types";

/** Matches `ffmpeg::MIN_SEGMENT_MS`. */
const MIN_MS = 100;
const FALLBACK_FPS = 60;
/** Each zoom step multiplies or divides by this. */
const ZOOM_STEP = 1.5;
/** A match is long, so the deepest zoom depends on it: about 5 s across the view at most. */
const MIN_MAX_ZOOM = 12;
const MAX_MAX_ZOOM = 600;
/** Filmstrip thumbnails: CSS height, and how many the strip will draw at most. */
const FILM_HEIGHT = 56;
const MAX_THUMBS = 60;
/** The timeline's side padding (editor.css), which scrolling counts and the track does not. */
const TRACK_PAD = 6;
const HISTORY = 100;
/** How close to the end of the range playback may get before it counts as there. */
const END_SLACK_MS = 15;

type Drag = { kind: "handle"; edge: "in" | "out"; moved: boolean } | { kind: "scrub" };

interface Editor {
  id: number;
  clip: ClipRow;
  source: EditSource;
  video: HTMLVideoElement;
  /** A second decoder that only ever seeks, for the filmstrip. */
  film: HTMLVideoElement;
  durationMs: number;
  fps: number;
  range: Segment;
  /** The range the editor opened with, for the dirty check and Reset. */
  initial: Segment;
  past: Segment[];
  future: Segment[];
  zoom: number;
  maxZoom: number;
  drag: Drag | null;
  /** Playback that started inside the range stops (or loops) at its end; playback started
   *  outside it is looking around the match and runs on. */
  playingRange: boolean;
  filmGen: number;
  filmTimer: number;
  raf: number;
  lastPainted: number;
  root: HTMLElement;
  timeline: HTMLElement;
  track: HTMLElement;
  ruler: HTMLElement;
  filmCanvas: HTMLCanvasElement;
  before: HTMLElement;
  after: HTMLElement;
  part: HTMLElement;
  partLen: HTMLElement;
  playhead: HTMLElement;
  time: HTMLElement;
  playButton: HTMLElement;
  zoomLabel: HTMLElement;
  inField: HTMLInputElement;
  outField: HTMLInputElement;
  summary: HTMLElement;
  beyond: HTMLElement;
  undoButton: HTMLButtonElement;
  redoButton: HTMLButtonElement;
  applyButton: HTMLButtonElement;
  cancelButton: HTMLButtonElement;
  message: HTMLElement;
  onKey: (e: KeyboardEvent) => void;
  resize: ResizeObserver;
}

let live: Editor | null = null;
/** The root the route asked for, so a source that arrives after the user left is dropped. */
let mountedRoot: HTMLElement | null = null;

export function mountEditor(root: HTMLElement, id: number): void {
  mountedRoot = root;
  const clip = data.clips.find((c) => c.id === id);
  if (!clip) {
    fill(root, h("div", { class: "empty-state", text: t("editor.gone") }));
    return;
  }
  fill(root, h("div", { class: "empty-state", text: t("editor.opening") }));
  ipc
    .editSource(id)
    .then((source) => {
      if (mountedRoot === root) build(root, clip, source);
    })
    .catch((e) => {
      if (mountedRoot !== root) return;
      fill(
        root,
        h(
          "div",
          { class: "empty-state" },
          h("span", { text: ipc.errorText(e) }),
          h("button", {
            type: "button",
            class: "btn small",
            text: t("editor.backToClip"),
            onclick: () => go({ view: "player", id }),
          }),
        ),
      );
    });
}

export function unmountEditor(): void {
  mountedRoot = null;
  if (!live) return;
  cancelAnimationFrame(live.raf);
  window.clearTimeout(live.filmTimer);
  live.filmGen++;
  document.removeEventListener("keydown", live.onKey);
  live.resize.disconnect();
  for (const v of [live.video, live.film]) {
    v.pause();
    v.removeAttribute("src");
    v.load();
  }
  live = null;
}

// ---------------------------------------------------------------------------
// Build

function build(root: HTMLElement, clip: ClipRow, source: EditSource): void {
  const url = convertFileSrc(source.path);
  // A match file is gigabytes; let the decoder fetch what it needs rather than buffer ahead.
  const preload = source.kind === "match" ? "metadata" : "auto";
  const video = h("video", { preload, playsinline: true, src: url }) as HTMLVideoElement;
  const film = h("video", { preload: "metadata", muted: true, src: url }) as HTMLVideoElement;
  const durationMs = Math.max(source.duration_ms, MIN_MS);
  const range = {
    start_ms: clamp(source.range.start_ms, 0, durationMs - MIN_MS),
    end_ms: clamp(source.range.end_ms, MIN_MS, durationMs),
  };
  if (range.end_ms - range.start_ms < MIN_MS) range.end_ms = Math.min(durationMs, range.start_ms + MIN_MS);
  const published = clip.remote_id !== null || clip.publish;
  // Cutting the only copy of a clip earns the second click every destructive action gets.
  const permanent = source.kind === "clip" && !source.original;

  const playButton = h("button", {
    class: "play",
    type: "button",
    text: "▶",
    title: t("editor.play"),
  });
  const time = h("span", { class: "time" });
  const ruler = h("div", { class: "ruler" });
  const filmCanvas = h("canvas", { class: "film" }) as HTMLCanvasElement;
  const footage = source.clip_span
    ? h("div", {
        class: "footage",
        style: `left:${(source.clip_span.start_ms / durationMs) * 100}%;width:${
          ((source.clip_span.end_ms - source.clip_span.start_ms) / durationMs) * 100
        }%`,
        title: t("editor.footageTitle", {
          in: fmtPrecise(source.clip_span.start_ms),
          out: fmtPrecise(source.clip_span.end_ms),
        }),
      })
    : null;
  const before = h("div", { class: "outside" });
  const after = h("div", { class: "outside" });
  const partLen = h("span", { class: "len" });
  const part = h(
    "div",
    { class: "part selected" },
    h("span", { class: "handle in", "data-edge": "in", title: t("editor.dragStart") }),
    partLen,
    h("span", { class: "handle out", "data-edge": "out", title: t("editor.dragEnd") }),
  );
  const playhead = h("div", { class: "playhead" }, h("span", { class: "head" }));
  const track = h("div", { class: "track" }, ruler, filmCanvas, before, after, footage, part, playhead);
  const timeline = h("div", { class: "timeline" }, track);
  const zoomLabel = h("span", { class: "zoom-level", text: "1×" });
  const inField = timeField(t("editor.inField"));
  const outField = timeField(t("editor.outField"));
  const summary = h("div", { class: "summary" });
  const beyond = h("span", { class: "note beyond", text: t("editor.beyond"), hidden: true });
  const message = h("div", { class: "rail-msg" });

  const undoButton = h("button", {
    type: "button",
    class: "btn small",
    text: t("editor.undo"),
    title: t("editor.undoTitle"),
    onclick: () => undo(),
  }) as HTMLButtonElement;
  const redoButton = h("button", {
    type: "button",
    class: "btn small",
    text: t("editor.redo"),
    title: t("editor.redoTitle"),
    onclick: () => redo(),
  }) as HTMLButtonElement;

  const applyButton = h("button", {
    type: "button",
    class: permanent ? "btn warn" : "btn primary",
    title: t("editor.applyTitle"),
  }) as HTMLButtonElement;
  if (permanent) {
    confirming(applyButton, t("editor.applyArm"), t("editor.applyConfirm"), () => void apply());
  } else {
    applyButton.textContent = t("editor.apply");
    applyButton.addEventListener("click", () => void apply());
  }
  const cancelButton = confirming(
    h("button", { type: "button", class: "btn" }) as HTMLButtonElement,
    t("editor.cancel"),
    t("editor.cancelConfirm"),
    () => go({ view: "player", id: clip.id }),
  );

  const bigPlay = h(
    "button",
    { type: "button", class: "big-play", title: t("editor.playPlain") },
    h("span", { text: "▶" }),
  );

  const note =
    source.kind === "match"
      ? published
        ? t("editor.noteMatchPublished")
        : t("editor.noteMatchLocal")
      : !source.original
        ? t("editor.noteEncoded")
        : published
          ? t("editor.notePublished")
          : t("editor.noteLocal");

  const page = h(
    "div",
    { class: "player editor", style: `--hue:${hueFor(clip.id)}` },
    h(
      "div",
      { class: "player-head" },
      h(
        "button",
        { type: "button", class: "back", onclick: () => cancelButton.click() },
        "← ",
        h("b", { text: gameLabel(clip.game) }),
        ` / ${fmtWhen(clip.recorded_at)}`,
      ),
      h("span", {
        class: "mode",
        text: source.kind === "match" ? t("editor.modeMatch") : t("editor.mode"),
      }),
      h("span", { class: "grow" }),
      h(
        "div",
        { class: "steps" },
        undoButton,
        redoButton,
        h("button", {
          type: "button",
          class: "btn small",
          text: t("editor.reset"),
          title: t("editor.resetTitle"),
          onclick: () => reset(),
        }),
      ),
    ),
    h(
      "div",
      { class: "player-body" },
      h(
        "div",
        { class: "stage" },
        h("div", { class: "video" }, video, bigPlay),
        h(
          "div",
          { class: "transport" },
          h(
            "div",
            { class: "controls" },
            playButton,
            time,
            frameStep(video, { fps: source.fps || clip.fps }),
            h("span", { class: "grow" }),
            loopToggle(video),
            volume(video),
            h(
              "span",
              { class: "zoom", title: t("editor.zoomTitle") },
              h("button", { type: "button", text: "−", onclick: () => zoomBy(-1) }),
              zoomLabel,
              h("button", { type: "button", text: "+", onclick: () => zoomBy(1) }),
            ),
          ),
          timeline,
          h(
            "div",
            { class: "cut-bar" },
            h("button", {
              type: "button",
              class: "btn small",
              text: t("editor.setIn"),
              title: t("editor.setInTitle"),
              onclick: () => setIn(),
            }),
            h("button", {
              type: "button",
              class: "btn small",
              text: t("editor.setOut"),
              title: t("editor.setOutTitle"),
              onclick: () => setOut(),
            }),
            h("span", { class: "grow" }),
            h("label", { class: "field-label", text: t("editor.inLabel") }),
            inField,
            h("label", { class: "field-label", text: t("editor.outLabel") }),
            outField,
          ),
          h(
            "div",
            { class: "keys" },
            h("span", { text: t("editor.keys.inOut") }),
            h("span", { text: t("editor.keys.jump") }),
            h("span", { text: t("editor.keys.play") }),
            h("span", { text: t("editor.keys.seek") }),
            h("span", { text: t("editor.keys.frame") }),
            h("span", { text: t("editor.keys.undo") }),
            h("span", { text: t("editor.keys.apply") }),
            h("span", { text: t("editor.keys.back") }),
          ),
        ),
      ),
      h(
        "aside",
        { class: "rail" },
        h("span", { class: "label", text: t("editor.railLabel") }),
        summary,
        beyond,
        source.multi_part ? h("span", { class: "note warn", text: t("editor.multiPart") }) : null,
        h("div", { class: "buttons" }, applyButton, cancelButton),
        message,
        h("span", { class: "grow" }),
        h("span", { class: "note", text: note }),
      ),
    ),
  );

  fill(root, page);

  const maxZoom = clamp(durationMs / 5000, MIN_MAX_ZOOM, MAX_MAX_ZOOM);
  const editor: Editor = {
    id: clip.id,
    clip,
    source,
    video,
    film,
    durationMs,
    fps: source.fps > 0 ? source.fps : clip.fps && clip.fps > 0 ? clip.fps : FALLBACK_FPS,
    range,
    initial: { ...range },
    past: [],
    future: [],
    zoom: 1,
    maxZoom,
    drag: null,
    playingRange: false,
    filmGen: 0,
    filmTimer: 0,
    raf: 0,
    lastPainted: -1,
    root: page,
    timeline,
    track,
    ruler,
    filmCanvas,
    before,
    after,
    part,
    partLen,
    playhead,
    time,
    playButton,
    zoomLabel,
    inField,
    outField,
    summary,
    beyond,
    undoButton,
    redoButton,
    applyButton,
    cancelButton,
    message,
    onKey: (e) => handleKey(e),
    resize: new ResizeObserver(() => {
      if (!live) return;
      paintRuler(live);
      scheduleFilm(live);
    }),
  };
  live = editor;

  wireVideo(editor, bigPlay);
  wireTimeline(editor);
  wireFields(editor);
  playButton.addEventListener("click", () => togglePlay(editor));
  bigPlay.addEventListener("click", () => togglePlay(editor));
  document.addEventListener("keydown", editor.onKey);
  editor.resize.observe(timeline);

  paintRange(editor);
  // A range of a few seconds on a forty-minute match would be a sliver: open zoomed so it
  // takes about two fifths of the view, centred.
  const span = range.end_ms - range.start_ms;
  if (source.kind === "match" && span > 0) {
    setZoom(editor, durationMs / (span * 2.5));
    const centre = (range.start_ms + range.end_ms) / 2;
    timeline.scrollLeft = (centre / durationMs) * track.clientWidth - (timeline.clientWidth - TRACK_PAD * 2) / 2;
  }
  paintRuler(editor);
  paintPlayhead(editor, true);
  scheduleFilm(editor, 0);
  video.addEventListener(
    "loadedmetadata",
    () => {
      if (live === editor && range.start_ms > 0) seek(editor, range.start_ms);
    },
    { once: true },
  );
  tick(editor);
}

function timeField(title: string): HTMLInputElement {
  return h("input", {
    type: "text",
    class: "field mono",
    title,
    spellcheck: "false",
    placeholder: "—",
  }) as HTMLInputElement;
}

// ---------------------------------------------------------------------------
// Video

function wireVideo(ed: Editor, bigPlay: HTMLElement): void {
  const { video } = ed;
  video.addEventListener("play", () => {
    bigPlay.hidden = true;
    const at = now(ed);
    ed.playingRange = at >= ed.range.start_ms - END_SLACK_MS && at < ed.range.end_ms - END_SLACK_MS;
    paintPlayhead(ed, true);
  });
  video.addEventListener("pause", () => {
    bigPlay.hidden = false;
    paintPlayhead(ed, true);
  });
  video.addEventListener("seeked", () => paintPlayhead(ed, true));
  video.addEventListener("error", () => {
    const box = ed.root.querySelector(".video");
    if (box && !box.querySelector(".trouble")) {
      box.appendChild(h("div", { class: "trouble", text: t("editor.playbackError") }));
    }
  });
}

function now(ed: Editor): number {
  return Math.round(ed.video.currentTime * 1000);
}

function seek(ed: Editor, ms: number): void {
  ed.video.currentTime = clamp(ms, 0, ed.durationMs) / 1000;
  paintPlayhead(ed, true);
}

function nudge(ed: Editor, byMs: number): void {
  seek(ed, now(ed) + byMs);
}

function togglePlay(ed: Editor): void {
  const { video } = ed;
  if (!video.paused) {
    video.pause();
    return;
  }
  // Play from the end of the range plays the range again rather than what follows it.
  const at = now(ed);
  if (Math.abs(at - ed.range.end_ms) <= END_SLACK_MS * 2) seek(ed, ed.range.start_ms);
  void video.play().catch(() => undefined);
}

/** One frame of the editor's own loop: hold playback to the range when it started inside it,
 *  keep the playhead in view, and repaint it only when it moved. */
function tick(ed: Editor): void {
  ed.raf = requestAnimationFrame(() => tick(ed));
  if (!ed.video.paused) {
    holdToRange(ed);
    keepPlayheadVisible(ed);
  }
  paintPlayhead(ed, false);
}

function holdToRange(ed: Editor): void {
  if (!ed.playingRange || ed.drag) return;
  if (now(ed) < ed.range.end_ms - END_SLACK_MS) return;
  if (ed.video.loop) {
    seek(ed, ed.range.start_ms);
  } else {
    ed.video.pause();
    seek(ed, ed.range.end_ms);
  }
}

// ---------------------------------------------------------------------------
// Timeline

function pct(ed: Editor, ms: number): string {
  return `${(ms / ed.durationMs) * 100}%`;
}

function msAt(ed: Editor, e: PointerEvent): number {
  const box = ed.track.getBoundingClientRect();
  if (!box.width) return 0;
  return clamp(Math.round(((e.clientX - box.left) / box.width) * ed.durationMs), 0, ed.durationMs);
}

function wireTimeline(ed: Editor): void {
  const { track, timeline } = ed;

  track.addEventListener("pointerdown", (e) => {
    if (e.button !== 0) return;
    const target = e.target as HTMLElement;
    track.setPointerCapture(e.pointerId);
    ed.video.pause();
    const handle = target.closest<HTMLElement>(".handle");
    if (handle) {
      push(ed);
      ed.drag = { kind: "handle", edge: handle.dataset.edge === "out" ? "out" : "in", moved: false };
    } else {
      ed.drag = { kind: "scrub" };
      seek(ed, msAt(ed, e));
    }
    e.preventDefault();
  });

  track.addEventListener("pointermove", (e) => {
    if (!ed.drag || !track.hasPointerCapture(e.pointerId)) return;
    if (ed.drag.kind === "handle") moveHandle(ed, msAt(ed, e));
    else seek(ed, msAt(ed, e));
  });

  const finish = (e: PointerEvent) => {
    if (!ed.drag) return;
    if (track.hasPointerCapture(e.pointerId)) track.releasePointerCapture(e.pointerId);
    // A click on a handle that never dragged is not an edit worth an undo step.
    if (ed.drag.kind === "handle" && !ed.drag.moved) ed.past.pop();
    ed.drag = null;
    paintRange(ed);
  };
  track.addEventListener("pointerup", finish);
  track.addEventListener("pointercancel", finish);

  // Ctrl+wheel zooms around the pointer; a plain wheel scrolls a zoomed timeline sideways,
  // since it has no vertical extent to scroll.
  timeline.addEventListener(
    "wheel",
    (e) => {
      if (e.ctrlKey) {
        e.preventDefault();
        const box = track.getBoundingClientRect();
        const at = box.width ? ((e.clientX - box.left) / box.width) * ed.durationMs : undefined;
        setZoom(ed, e.deltaY < 0 ? ed.zoom * ZOOM_STEP : ed.zoom / ZOOM_STEP, at);
      } else if (ed.zoom > 1 && Math.abs(e.deltaY) > Math.abs(e.deltaX)) {
        e.preventDefault();
        timeline.scrollLeft += e.deltaY;
      }
    },
    { passive: false },
  );
  // The ruler and the filmstrip only draw what is in view, so scrolling redraws them.
  timeline.addEventListener("scroll", () => {
    paintRuler(ed);
    scheduleFilm(ed, 120);
  });
}

function moveHandle(ed: Editor, ms: number): void {
  const d = ed.drag;
  if (!d || d.kind !== "handle") return;
  const r = ed.range;
  if (d.edge === "in") r.start_ms = clamp(ms, 0, r.end_ms - MIN_MS);
  else r.end_ms = clamp(ms, r.start_ms + MIN_MS, ed.durationMs);
  d.moved = true;
  // The preview follows the handle, which is how you see the frame you are cutting on.
  seek(ed, d.edge === "in" ? r.start_ms : r.end_ms);
  paintRange(ed);
}

function keepPlayheadVisible(ed: Editor): void {
  if (ed.zoom === 1) return;
  const tl = ed.timeline;
  const x = (now(ed) / ed.durationMs) * ed.track.clientWidth;
  if (x < tl.scrollLeft || x > tl.scrollLeft + tl.clientWidth - TRACK_PAD * 2) {
    tl.scrollLeft = Math.max(0, x - tl.clientWidth * 0.2);
  }
}

function zoomBy(direction: 1 | -1): void {
  if (live) setZoom(live, direction > 0 ? live.zoom * ZOOM_STEP : live.zoom / ZOOM_STEP);
}

/** Zooms to `zoom`, keeping `aroundMs` (by default whatever is mid-view) where it was. */
function setZoom(ed: Editor, zoom: number, aroundMs?: number): void {
  zoom = clamp(zoom, 1, ed.maxZoom);
  if (Math.abs(zoom - ed.zoom) < 0.001) return;
  const tl = ed.timeline;
  const oldWidth = ed.track.clientWidth || 1;
  const view = tl.clientWidth - TRACK_PAD * 2;
  const centreMs = aroundMs ?? ((tl.scrollLeft + view / 2) / oldWidth) * ed.durationMs;
  // Where on screen the anchor sits now, so it stays under the pointer after the zoom.
  const anchorX = aroundMs === undefined ? view / 2 : (aroundMs / ed.durationMs) * oldWidth - tl.scrollLeft;
  ed.zoom = zoom;
  ed.track.style.width = `${zoom * 100}%`;
  const newWidth = ed.track.clientWidth || 1;
  tl.scrollLeft = (centreMs / ed.durationMs) * newWidth - clamp(anchorX, 0, view);
  ed.zoomLabel.textContent = `${zoom < 10 ? zoom.toFixed(1) : Math.round(zoom)}×`;
  paintRange(ed);
  paintRuler(ed);
  scheduleFilm(ed);
}

/** The part of the track in view, in track pixels. */
function visibleTrack(ed: Editor): { from: number; width: number } {
  const trackWidth = ed.track.clientWidth;
  const from = clamp(ed.timeline.scrollLeft - TRACK_PAD, 0, trackWidth);
  const width = clamp(ed.timeline.clientWidth, 0, trackWidth - from);
  return { from, width };
}

// ---------------------------------------------------------------------------
// Painting

function paintPlayhead(ed: Editor, force: boolean): void {
  const ms = now(ed);
  if (!force && ms === ed.lastPainted) return;
  ed.lastPainted = ms;
  ed.playhead.style.left = pct(ed, ms);
  fill(ed.time, fmtPrecise(ms), h("span", { class: "total", text: ` / ${fmtClock(ed.durationMs / 1000)}` }));
  ed.playButton.textContent = ed.video.paused ? "▶" : "⏸";
  ed.playButton.title = ed.video.paused ? t("editor.play") : t("editor.pause");
}

function paintRange(ed: Editor): void {
  const r = ed.range;
  const len = r.end_ms - r.start_ms;
  ed.before.style.left = "0";
  ed.before.style.width = pct(ed, r.start_ms);
  ed.after.style.left = pct(ed, r.end_ms);
  ed.after.style.width = pct(ed, ed.durationMs - r.end_ms);
  ed.part.style.left = pct(ed, r.start_ms);
  ed.part.style.width = pct(ed, len);
  ed.part.title = t("editor.rangeTitle", { in: fmtPrecise(r.start_ms), out: fmtPrecise(r.end_ms) });
  ed.partLen.textContent = fmtLen(len);
  const width = ed.track.clientWidth || 1;
  ed.part.toggleAttribute("data-narrow", (len / ed.durationMs) * width < 64);
  paintFields(ed);
  paintSummary(ed);
  ed.undoButton.disabled = ed.past.length === 0;
  ed.redoButton.disabled = ed.future.length === 0;
}

function paintRuler(ed: Editor): void {
  const width = ed.track.clientWidth;
  const secs = ed.durationMs / 1000;
  if (!width || !secs) return;
  const pxPerSec = width / secs;
  const steps = [0.1, 0.25, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800];
  const step = steps.find((s) => s * pxPerSec >= 72) ?? steps[steps.length - 1];
  const minor = step / 5;
  // Only what is in view, plus a screen either side: a zoomed match is tens of thousands of
  // pixels wide and would otherwise be tens of thousands of ticks.
  const { from, width: shown } = visibleTrack(ed);
  const first = Math.max(0, Math.floor((from - shown) / pxPerSec / minor));
  const last = Math.min(Math.floor(secs / minor + 1e-6), Math.ceil((from + shown * 2) / pxPerSec / minor));
  const nodes: HTMLElement[] = [];
  for (let i = first; i <= last; i++) {
    const at = i * minor;
    const major = i % 5 === 0;
    nodes.push(
      h(
        "span",
        { class: major ? "tick major" : "tick", style: `left:${(at / secs) * 100}%` },
        major ? h("i", { text: fmtTick(at, step) }) : null,
      ),
    );
  }
  fill(ed.ruler, ...nodes);
}

function paintFields(ed: Editor): void {
  for (const [field, value] of [
    [ed.inField, ed.range.start_ms],
    [ed.outField, ed.range.end_ms],
  ] as const) {
    if (document.activeElement !== field) field.value = fmtPrecise(value);
  }
}

function paintSummary(ed: Editor): void {
  const r = ed.range;
  const kept = r.end_ms - r.start_ms;
  const whole = ed.source.kind === "clip" && r.start_ms <= 0 && r.end_ms >= ed.durationMs;
  fill(
    ed.summary,
    h("b", {
      text: whole
        ? t("editor.wholeRecording")
        : t("editor.keeps", { kept: fmtClock(kept / 1000), total: fmtClock(ed.durationMs / 1000) }),
    }),
    h("span", { class: "muted mono range", text: `${fmtPrecise(r.start_ms)} → ${fmtPrecise(r.end_ms)}` }),
  );
  const span = ed.source.clip_span;
  ed.beyond.hidden =
    ed.source.kind !== "match" || (!!span && r.start_ms >= span.start_ms && r.end_ms <= span.end_ms);
  // Several old parts become one range even when the outer span is left as it is.
  ed.applyButton.disabled = !isDirty(ed) && !ed.source.multi_part;
}

function note(ed: Editor, text: string, isError = false): void {
  ed.message.textContent = text;
  ed.message.className = `rail-msg${isError ? " err" : ""}`;
}

// ---------------------------------------------------------------------------
// Filmstrip

function scheduleFilm(ed: Editor, delay = 200): void {
  window.clearTimeout(ed.filmTimer);
  ed.filmTimer = window.setTimeout(() => void buildFilm(ed), delay);
}

/** Draws one frame per slot across the part of the track in view. Sequential seeks on the
 *  hidden decoder, each drawn as it lands, so the strip fills in from the left. */
async function buildFilm(ed: Editor): Promise<void> {
  const gen = ++ed.filmGen;
  const trackWidth = ed.track.clientWidth;
  const { from, width } = visibleTrack(ed);
  if (!trackWidth || !width) return;
  const aspect = ed.source.width && ed.source.height ? ed.source.width / ed.source.height : 16 / 9;
  const thumbW = Math.max(40, Math.round(FILM_HEIGHT * aspect));
  const n = Math.min(MAX_THUMBS, Math.max(1, Math.ceil(width / thumbW)));
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const canvas = ed.filmCanvas;
  canvas.style.left = `${from}px`;
  canvas.style.width = `${n * thumbW}px`;
  canvas.width = Math.round(n * thumbW * dpr);
  canvas.height = Math.round(FILM_HEIGHT * dpr);
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  ctx.scale(dpr, dpr);
  if (!(await decoderReady(ed.film))) return;
  for (let i = 0; i < n; i++) {
    if (ed.filmGen !== gen) return;
    const x = from + (i + 0.5) * thumbW;
    const at = ((x / trackWidth) * ed.durationMs) / 1000;
    const ok = await seekDecoder(ed.film, Math.min(at, ed.durationMs / 1000));
    if (ed.filmGen !== gen) return;
    if (ok) ctx.drawImage(ed.film, i * thumbW, 0, thumbW, FILM_HEIGHT);
  }
}

function decoderReady(v: HTMLVideoElement): Promise<boolean> {
  if (v.readyState >= 2) return Promise.resolve(true);
  return new Promise((resolve) => {
    const done = (ok: boolean) => {
      v.removeEventListener("loadeddata", onLoad);
      v.removeEventListener("error", onError);
      window.clearTimeout(timer);
      resolve(ok);
    };
    const onLoad = () => done(true);
    const onError = () => done(false);
    const timer = window.setTimeout(() => done(false), 8000);
    v.addEventListener("loadeddata", onLoad);
    v.addEventListener("error", onError);
  });
}

function seekDecoder(v: HTMLVideoElement, seconds: number): Promise<boolean> {
  return new Promise((resolve) => {
    const done = (ok: boolean) => {
      v.removeEventListener("seeked", onSeeked);
      window.clearTimeout(timer);
      resolve(ok);
    };
    const onSeeked = () => done(true);
    const timer = window.setTimeout(() => done(false), 2000);
    v.addEventListener("seeked", onSeeked);
    v.currentTime = seconds;
  });
}

// ---------------------------------------------------------------------------
// Edits

function push(ed: Editor): void {
  ed.past.push({ ...ed.range });
  if (ed.past.length > HISTORY) ed.past.shift();
  ed.future = [];
}

function undo(): void {
  const ed = live;
  const prev = ed?.past.pop();
  if (!ed || !prev) return;
  ed.future.push({ ...ed.range });
  ed.range = prev;
  paintRange(ed);
}

function redo(): void {
  const ed = live;
  const next = ed?.future.pop();
  if (!ed || !next) return;
  ed.past.push({ ...ed.range });
  ed.range = next;
  paintRange(ed);
}

function reset(): void {
  const ed = live;
  if (!ed || !isDirty(ed)) return;
  push(ed);
  ed.range = { ...ed.initial };
  paintRange(ed);
}

/** Starts the range at the playhead. Past the current end, the range moves there whole
 *  rather than collapsing, which is what pressing I further along means. */
function setIn(): void {
  const ed = live;
  if (!ed) return;
  const at = clamp(now(ed), 0, ed.durationMs - MIN_MS);
  push(ed);
  const length = ed.range.end_ms - ed.range.start_ms;
  ed.range.start_ms = at;
  if (ed.range.end_ms - at < MIN_MS) ed.range.end_ms = Math.min(ed.durationMs, at + length);
  paintRange(ed);
  note(ed, "");
}

function setOut(): void {
  const ed = live;
  if (!ed) return;
  const at = clamp(now(ed), MIN_MS, ed.durationMs);
  push(ed);
  const length = ed.range.end_ms - ed.range.start_ms;
  ed.range.end_ms = at;
  if (at - ed.range.start_ms < MIN_MS) ed.range.start_ms = Math.max(0, at - length);
  paintRange(ed);
  note(ed, "");
}

/** The range's edges and the saved footage's, for [ and ] to hop between. */
function jumpEdge(ed: Editor, direction: -1 | 1): void {
  const at = now(ed);
  const span = ed.source.clip_span;
  const edges = [ed.range.start_ms, ed.range.end_ms, ...(span ? [span.start_ms, span.end_ms] : [])].sort(
    (a, b) => a - b,
  );
  const target =
    direction > 0 ? edges.find((e) => e > at + 1) : [...edges].reverse().find((e) => e < at - 1);
  seek(ed, target ?? (direction > 0 ? ed.durationMs : 0));
}

function wireFields(ed: Editor): void {
  const commit = (field: HTMLInputElement, edge: "in" | "out") => {
    const ms = parseTime(field.value);
    if (ms === null) {
      paintFields(ed);
      return;
    }
    push(ed);
    const r = ed.range;
    if (edge === "in") r.start_ms = clamp(ms, 0, r.end_ms - MIN_MS);
    else r.end_ms = clamp(ms, r.start_ms + MIN_MS, ed.durationMs);
    paintRange(ed);
    seek(ed, edge === "in" ? r.start_ms : r.end_ms);
  };
  for (const [field, edge] of [
    [ed.inField, "in"],
    [ed.outField, "out"],
  ] as const) {
    field.addEventListener("change", () => commit(field, edge));
    field.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        commit(field, edge);
        field.blur();
      } else if (e.key === "Escape") {
        e.preventDefault();
        paintFields(ed);
        field.blur();
      }
    });
  }
}

function isDirty(ed: Editor): boolean {
  return ed.range.start_ms !== ed.initial.start_ms || ed.range.end_ms !== ed.initial.end_ms;
}

async function apply(): Promise<void> {
  const ed = live;
  if (!ed) return;
  ed.applyButton.disabled = true;
  note(ed, t("editor.queuing"));
  try {
    await ipc.applyRange(
      ed.id,
      ed.source.kind,
      Math.round(ed.range.start_ms),
      Math.round(ed.range.end_ms),
    );
    go({ view: "player", id: ed.id });
  } catch (e) {
    if (live !== ed) return;
    note(ed, ipc.errorText(e), true);
    ed.applyButton.disabled = false;
  }
}

// ---------------------------------------------------------------------------
// Keys

function handleKey(e: KeyboardEvent): void {
  const ed = live;
  if (!ed) return;
  const target = e.target as HTMLElement | null;
  if (target && (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName))) {
    return;
  }
  const ctrl = e.ctrlKey || e.metaKey;
  if (ctrl) {
    switch (e.key) {
      case "z":
      case "Z":
        if (e.shiftKey) redo();
        else undo();
        break;
      case "y":
      case "Y":
        redo();
        break;
      case "Enter":
        if (!ed.applyButton.disabled) ed.applyButton.click();
        break;
      default:
        return;
    }
    e.preventDefault();
    return;
  }
  const frame = 1000 / ed.fps;
  switch (e.key) {
    case " ":
      togglePlay(ed);
      break;
    case "ArrowLeft":
      nudge(ed, e.shiftKey ? -1000 : -5000);
      break;
    case "ArrowRight":
      nudge(ed, e.shiftKey ? 1000 : 5000);
      break;
    case "j":
    case "J":
      nudge(ed, -10000);
      break;
    case "l":
    case "L":
      nudge(ed, 10000);
      break;
    case "k":
    case "K":
      ed.video.pause();
      break;
    case ",":
      ed.video.pause();
      nudge(ed, -frame);
      break;
    case ".":
      ed.video.pause();
      nudge(ed, frame);
      break;
    case "i":
    case "I":
      setIn();
      break;
    case "o":
    case "O":
      setOut();
      break;
    case "[":
      jumpEdge(ed, -1);
      break;
    case "]":
      jumpEdge(ed, 1);
      break;
    case "Home":
      seek(ed, 0);
      break;
    case "End":
      seek(ed, ed.durationMs);
      break;
    case "m":
    case "M":
      ed.video.muted = !ed.video.muted;
      break;
    case "+":
    case "=":
      zoomBy(1);
      break;
    case "-":
    case "_":
      zoomBy(-1);
      break;
    case "Escape":
      // Armed Cancel needs a second press when there is something to lose.
      if (isDirty(ed)) ed.cancelButton.click();
      else go({ view: "player", id: ed.id });
      break;
    default:
      return;
  }
  e.preventDefault();
}

// ---------------------------------------------------------------------------
// Small helpers

function clamp(n: number, lo: number, hi: number): number {
  return Math.min(Math.max(n, lo), hi);
}

/** m:ss.mmm, the precision a range is stored at. Hours roll into the minutes, which is how a
 *  long match reads anyway. */
function fmtPrecise(ms: number): string {
  const total = Math.max(0, Math.round(ms));
  const m = Math.floor(total / 60000);
  const s = Math.floor((total % 60000) / 1000);
  const frac = total % 1000;
  return `${m}:${String(s).padStart(2, "0")}.${String(frac).padStart(3, "0")}`;
}

function fmtLen(ms: number): string {
  return `${(ms / 1000).toFixed(1)} s`;
}

function fmtTick(seconds: number, step: number): string {
  const m = Math.floor(seconds / 60);
  const s = seconds - m * 60;
  if (step < 1) return `${m}:${s.toFixed(1).padStart(4, "0")}`;
  return `${m}:${String(Math.round(s)).padStart(2, "0")}`;
}

/** Accepts "1:23.456", "1:23", "83.4" or "83"; null for anything else. */
function parseTime(text: string): number | null {
  const s = text.trim();
  const clock = /^(\d+):(\d{1,2})(?:\.(\d{1,3}))?$/.exec(s);
  if (clock) {
    const frac = (clock[3] ?? "").padEnd(3, "0");
    return Number(clock[1]) * 60000 + Number(clock[2]) * 1000 + Number(frac);
  }
  const plain = /^(\d+)(?:\.(\d{1,3}))?$/.exec(s);
  if (plain) return Number(plain[1]) * 1000 + Number((plain[2] ?? "").padEnd(3, "0"));
  return null;
}
