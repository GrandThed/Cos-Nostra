/** The cut editor: the clip above a timeline with in and out handles on every kept part.
 *
 *  A cut is a list of kept ranges of the recording. While the original recording is still on
 *  disk it costs nothing to change: the worker re-encodes both outputs from the recording, and
 *  opening the editor again shows the whole recording with the cut drawn on it. Once the
 *  recording is gone the encoded copy is what gets cut, for good, and the rail says so.
 *
 *  The keys are the ones every clip trimmer shares: I and O set the in and out point of the
 *  part under the playhead, S splits it, Delete drops it, Ctrl+Z undoes, Ctrl+Enter applies. */

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
const MAX_ZOOM = 12;
/** Filmstrip thumbnails: CSS height, and how many the strip will draw at most. */
const FILM_HEIGHT = 56;
const MAX_THUMBS = 160;
const HISTORY = 100;
/** How far into a removed range playback may drift before it is jumped. */
const GAP_SLACK_MS = 15;

type Drag = { kind: "handle"; seg: number; edge: "in" | "out"; moved: boolean } | { kind: "scrub" };

interface Editor {
  id: number;
  clip: ClipRow;
  source: EditSource;
  video: HTMLVideoElement;
  /** A second decoder that only ever seeks, for the filmstrip. */
  film: HTMLVideoElement;
  durationMs: number;
  fps: number;
  segments: Segment[];
  /** The segments the editor opened with, for the dirty check. */
  initial: string;
  selected: number | null;
  past: Segment[][];
  future: Segment[][];
  zoom: number;
  skipGaps: boolean;
  drag: Drag | null;
  filmGen: number;
  filmTimer: number;
  raf: number;
  lastPainted: number;
  root: HTMLElement;
  timeline: HTMLElement;
  track: HTMLElement;
  ruler: HTMLElement;
  filmCanvas: HTMLCanvasElement;
  gaps: HTMLElement;
  parts: HTMLElement;
  playhead: HTMLElement;
  time: HTMLElement;
  playButton: HTMLElement;
  zoomLabel: HTMLElement;
  inField: HTMLInputElement;
  outField: HTMLInputElement;
  summary: HTMLElement;
  partList: HTMLElement;
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
  const video = h("video", { preload: "auto", playsinline: true, src: url }) as HTMLVideoElement;
  const film = h("video", { preload: "auto", muted: true, src: url }) as HTMLVideoElement;
  const segments: Segment[] = source.cut?.length
    ? source.cut.map((s) => ({ ...s }))
    : [{ start_ms: 0, end_ms: source.duration_ms }];

  const playButton = h("button", {
    class: "play",
    type: "button",
    text: "▶",
    title: t("editor.play"),
  });
  const time = h("span", { class: "time" });
  const ruler = h("div", { class: "ruler" });
  const filmCanvas = h("canvas", { class: "film" }) as HTMLCanvasElement;
  const gaps = h("div", { class: "gaps" });
  const parts = h("div", { class: "parts" });
  const playhead = h("div", { class: "playhead" }, h("span", { class: "head" }));
  const track = h("div", { class: "track" }, ruler, filmCanvas, gaps, parts, playhead);
  const timeline = h("div", { class: "timeline" }, track);
  const zoomLabel = h("span", { class: "zoom-level", text: "1×" });
  const inField = timeField(t("editor.inField"));
  const outField = timeField(t("editor.outField"));
  const summary = h("div", { class: "summary" });
  const partList = h("div", { class: "part-list" });
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

  // Applying on the original is reversible, so one click. On the encoded copy it is the
  // only copy being cut, which earns the same second click every destructive action gets.
  const applyButton = h("button", {
    type: "button",
    class: source.original ? "btn primary" : "btn warn",
    title: t("editor.applyTitle"),
  }) as HTMLButtonElement;
  if (source.original) {
    applyButton.textContent = t("editor.apply");
    applyButton.addEventListener("click", () => void apply());
  } else {
    confirming(applyButton, t("editor.applyArm"), t("editor.applyConfirm"), () => void apply());
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
      h("span", { class: "mode", text: t("editor.mode") }),
      h("span", { class: "grow" }),
      h("div", { class: "steps" }, undoButton, redoButton, h("button", {
        type: "button",
        class: "btn small",
        text: t("editor.reset"),
        title: t("editor.resetTitle"),
        onclick: () => reset(),
      })),
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
            h("button", {
              type: "button",
              class: "loop skip",
              text: t("editor.skipRemoved"),
              title: t("editor.skipRemovedTitle"),
              "aria-pressed": "true",
              onclick: (e: Event) => {
                const button = e.currentTarget as HTMLElement;
                if (!live) return;
                live.skipGaps = !live.skipGaps;
                button.setAttribute("aria-pressed", String(live.skipGaps));
              },
            }),
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
            h("button", {
              type: "button",
              class: "btn small",
              text: t("editor.split"),
              title: t("editor.splitTitle"),
              onclick: () => split(),
            }),
            h("button", {
              type: "button",
              class: "btn small danger",
              text: t("editor.removePart"),
              title: t("editor.removePartTitle"),
              onclick: () => removeSelected(),
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
            h("span", { text: t("editor.keys.split") }),
            h("span", { text: t("editor.keys.remove") }),
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
        partList,
        h("div", { class: "buttons" }, applyButton, cancelButton),
        message,
        h("span", { class: "grow" }),
        h("span", {
          class: "note",
          text: source.original ? t("editor.noteOriginal") : t("editor.noteEncoded"),
        }),
      ),
    ),
  );

  fill(root, page);

  const editor: Editor = {
    id: clip.id,
    clip,
    source,
    video,
    film,
    durationMs: Math.max(source.duration_ms, MIN_MS),
    fps: source.fps > 0 ? source.fps : clip.fps && clip.fps > 0 ? clip.fps : FALLBACK_FPS,
    segments,
    initial: JSON.stringify(segments),
    selected: segments.length === 1 ? 0 : null,
    past: [],
    future: [],
    zoom: 1,
    skipGaps: true,
    drag: null,
    filmGen: 0,
    filmTimer: 0,
    raf: 0,
    lastPainted: -1,
    root: page,
    timeline,
    track,
    ruler,
    filmCanvas,
    gaps,
    parts,
    playhead,
    time,
    playButton,
    zoomLabel,
    inField,
    outField,
    summary,
    partList,
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

  paintParts(editor);
  paintRuler(editor);
  paintPlayhead(editor, true);
  scheduleFilm(editor, 0);
  // Open on the first kept frame rather than frame zero of a trimmed recording.
  video.addEventListener(
    "loadedmetadata",
    () => {
      if (live === editor && segments[0].start_ms > 0) seek(editor, segments[0].start_ms);
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
    paintPlayhead(ed, true);
  });
  video.addEventListener("pause", () => {
    bigPlay.hidden = false;
    paintPlayhead(ed, true);
  });
  video.addEventListener("seeked", () => paintPlayhead(ed, true));
  video.addEventListener("ended", () => {
    // Native loop restarts at frame zero; with gaps skipped that means the first kept part.
    if (video.loop && ed.skipGaps) {
      seek(ed, ed.segments[0].start_ms);
      void video.play().catch(() => undefined);
    }
  });
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
  const clamped = clamp(ms, 0, ed.durationMs);
  ed.video.currentTime = clamped / 1000;
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
  // Pressing play at the end of the kept footage starts it over rather than playing the
  // removed tail.
  const last = ed.segments[ed.segments.length - 1];
  if (ed.skipGaps && now(ed) >= last.end_ms - GAP_SLACK_MS) seek(ed, ed.segments[0].start_ms);
  void video.play().catch(() => undefined);
}

/** One frame of the editor's own loop: jump over removed ranges while playing, keep the
 *  playhead in view, and repaint it only when it moved. */
function tick(ed: Editor): void {
  ed.raf = requestAnimationFrame(() => tick(ed));
  if (!ed.video.paused) {
    enforceGaps(ed);
    keepPlayheadVisible(ed);
  }
  paintPlayhead(ed, false);
}

function enforceGaps(ed: Editor): void {
  if (!ed.skipGaps || ed.drag) return;
  const t = now(ed);
  const segs = ed.segments;
  const next = segs.find((s) => t < s.end_ms - GAP_SLACK_MS);
  if (!next) {
    if (ed.video.loop) seek(ed, segs[0].start_ms);
    else {
      ed.video.pause();
      seek(ed, segs[segs.length - 1].end_ms);
    }
    return;
  }
  if (t < next.start_ms - GAP_SLACK_MS) seek(ed, next.start_ms);
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
    if (target.closest(".restore")) return;
    track.setPointerCapture(e.pointerId);
    ed.video.pause();
    const handle = target.closest<HTMLElement>(".handle");
    if (handle) {
      push(ed);
      ed.drag = {
        kind: "handle",
        seg: Number(handle.dataset.seg),
        edge: handle.dataset.edge === "out" ? "out" : "in",
        moved: false,
      };
      select(ed, ed.drag.seg);
    } else {
      const part = target.closest<HTMLElement>(".part");
      if (part) select(ed, Number(part.dataset.seg));
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
    if (ed.drag.kind === "handle") {
      // A click that never dragged is not an edit worth an undo step.
      if (!ed.drag.moved) ed.past.pop();
      mergeTouching(ed);
      paintParts(ed);
    }
    ed.drag = null;
  };
  track.addEventListener("pointerup", finish);
  track.addEventListener("pointercancel", finish);

  // Ctrl+wheel zooms; a plain wheel scrolls a zoomed timeline sideways, since it has no
  // vertical extent to scroll.
  timeline.addEventListener(
    "wheel",
    (e) => {
      if (e.ctrlKey) {
        e.preventDefault();
        zoomBy(e.deltaY < 0 ? 1 : -1);
      } else if (ed.zoom > 1 && Math.abs(e.deltaY) > Math.abs(e.deltaX)) {
        e.preventDefault();
        timeline.scrollLeft += e.deltaY;
      }
    },
    { passive: false },
  );
}

function moveHandle(ed: Editor, ms: number): void {
  const d = ed.drag;
  if (!d || d.kind !== "handle") return;
  const segs = ed.segments;
  const s = segs[d.seg];
  const lo = d.seg > 0 ? segs[d.seg - 1].end_ms : 0;
  const hi = d.seg < segs.length - 1 ? segs[d.seg + 1].start_ms : ed.durationMs;
  if (d.edge === "in") s.start_ms = clamp(ms, lo, s.end_ms - MIN_MS);
  else s.end_ms = clamp(ms, s.start_ms + MIN_MS, hi);
  d.moved = true;
  // The preview follows the handle, which is how you see the frame you are cutting on.
  seek(ed, d.edge === "in" ? s.start_ms : s.end_ms);
  paintParts(ed);
}

/** Two parts whose edges meet are one part. Dragging a handle up to its neighbour is the
 *  natural way to close a cut, so this runs after every drag and field edit. */
function mergeTouching(ed: Editor): void {
  const merged: Segment[] = [];
  for (const s of ed.segments) {
    const last = merged[merged.length - 1];
    if (last && s.start_ms <= last.end_ms) last.end_ms = Math.max(last.end_ms, s.end_ms);
    else merged.push(s);
  }
  if (merged.length !== ed.segments.length) {
    ed.segments = merged;
    if (ed.selected !== null && ed.selected >= merged.length) ed.selected = merged.length - 1;
  }
}

function keepPlayheadVisible(ed: Editor): void {
  if (ed.zoom === 1) return;
  const tl = ed.timeline;
  const x = (now(ed) / ed.durationMs) * ed.track.clientWidth;
  if (x < tl.scrollLeft || x > tl.scrollLeft + tl.clientWidth) {
    tl.scrollLeft = Math.max(0, x - tl.clientWidth * 0.2);
  }
}

function zoomBy(by: number): void {
  if (live) setZoom(live, live.zoom + by);
}

function setZoom(ed: Editor, zoom: number): void {
  zoom = clamp(zoom, 1, MAX_ZOOM);
  if (zoom === ed.zoom) return;
  const tl = ed.timeline;
  // Keep whatever is under the middle of the view under the middle of the view.
  const centre = ed.track.clientWidth
    ? (tl.scrollLeft + tl.clientWidth / 2) / ed.track.clientWidth
    : 0.5;
  ed.zoom = zoom;
  ed.track.style.width = `${zoom * 100}%`;
  tl.scrollLeft = centre * ed.track.clientWidth - tl.clientWidth / 2;
  ed.zoomLabel.textContent = `${zoom}×`;
  paintRuler(ed);
  scheduleFilm(ed);
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

function paintParts(ed: Editor): void {
  const segs = ed.segments;
  const width = ed.track.clientWidth || 1;
  const gapNodes: HTMLElement[] = [];
  let cursor = 0;
  segs.forEach((s, i) => {
    if (s.start_ms > cursor) gapNodes.push(gapNode(ed, cursor, s.start_ms, i));
    cursor = s.end_ms;
  });
  if (cursor < ed.durationMs) gapNodes.push(gapNode(ed, cursor, ed.durationMs, segs.length));
  fill(ed.gaps, ...gapNodes);
  fill(
    ed.parts,
    ...segs.map((s, i) => {
      const len = s.end_ms - s.start_ms;
      const node = h(
        "div",
        {
          class: `part${i === ed.selected ? " selected" : ""}`,
          "data-seg": i,
          style: `left:${pct(ed, s.start_ms)};width:${pct(ed, len)}`,
          title: t("editor.partTitle", {
            n: i + 1,
            in: fmtPrecise(s.start_ms),
            out: fmtPrecise(s.end_ms),
          }),
        },
        h("span", {
          class: "handle in",
          "data-seg": i,
          "data-edge": "in",
          title: t("editor.dragStart"),
        }),
        h("span", { class: "len", text: fmtLen(len) }),
        h("span", {
          class: "handle out",
          "data-seg": i,
          "data-edge": "out",
          title: t("editor.dragEnd"),
        }),
      );
      if ((len / ed.durationMs) * width < 64) node.setAttribute("data-narrow", "");
      return node;
    }),
  );
  paintFields(ed);
  paintSummary(ed);
  paintPartList(ed);
  ed.undoButton.disabled = ed.past.length === 0;
  ed.redoButton.disabled = ed.future.length === 0;
}

/** A removed range. `before` is the index of the part that follows it, which is what
 *  restoring it has to join. */
function gapNode(ed: Editor, from: number, to: number, before: number): HTMLElement {
  return h(
    "div",
    {
      class: "gap",
      style: `left:${pct(ed, from)};width:${pct(ed, to - from)}`,
      title: t("editor.removed"),
    },
    h("button", {
      type: "button",
      class: "restore",
      text: t("editor.restore"),
      title: t("editor.restoreTitle"),
      onclick: (e: Event) => {
        e.stopPropagation();
        restoreGap(ed, before);
      },
    }),
  );
}

function paintRuler(ed: Editor): void {
  const width = ed.track.clientWidth;
  const secs = ed.durationMs / 1000;
  if (!width || !secs) return;
  const pxPerSec = width / secs;
  const steps = [0.1, 0.25, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300];
  const step = steps.find((s) => s * pxPerSec >= 72) ?? steps[steps.length - 1];
  const minor = step / 5;
  const nodes: HTMLElement[] = [];
  const count = Math.floor(secs / minor + 1e-6);
  for (let i = 0; i <= count; i++) {
    const t = i * minor;
    const major = i % 5 === 0;
    nodes.push(
      h(
        "span",
        { class: major ? "tick major" : "tick", style: `left:${(t / secs) * 100}%` },
        major ? h("i", { text: fmtTick(t, step) }) : null,
      ),
    );
  }
  fill(ed.ruler, ...nodes);
}

function paintFields(ed: Editor): void {
  const s = ed.selected !== null ? ed.segments[ed.selected] : null;
  for (const [field, value] of [
    [ed.inField, s?.start_ms],
    [ed.outField, s?.end_ms],
  ] as const) {
    field.disabled = !s;
    if (document.activeElement !== field) field.value = value === undefined ? "" : fmtPrecise(value);
  }
}

function paintSummary(ed: Editor): void {
  const kept = ed.segments.reduce((sum, s) => sum + s.end_ms - s.start_ms, 0);
  const parts = ed.segments.length;
  const whole = isWhole(ed);
  fill(
    ed.summary,
    h("b", {
      text: whole
        ? t("editor.wholeRecording")
        : t("editor.keeps", {
            kept: fmtClock(kept / 1000),
            total: fmtClock(ed.durationMs / 1000),
          }),
    }),
    h("span", {
      class: "muted",
      text: whole
        ? ` · ${fmtClock(ed.durationMs / 1000)}`
        : ` · ${parts} ${parts === 1 ? t("editor.partOne") : t("editor.partMany")}`,
    }),
  );
  ed.applyButton.disabled = !isDirty(ed) && !(ed.clip.cut && whole);
}

function paintPartList(ed: Editor): void {
  fill(
    ed.partList,
    ...ed.segments.map((s, i) =>
      h(
        "button",
        {
          type: "button",
          class: `part-row${i === ed.selected ? " selected" : ""}`,
          onclick: () => {
            select(ed, i);
            seek(ed, s.start_ms);
          },
        },
        h("span", { class: "n", text: String(i + 1) }),
        h("span", { class: "range mono", text: `${fmtPrecise(s.start_ms)} → ${fmtPrecise(s.end_ms)}` }),
        h("span", { class: "muted mono", text: fmtLen(s.end_ms - s.start_ms) }),
      ),
    ),
  );
}

function select(ed: Editor, i: number | null): void {
  ed.selected = i;
  for (const node of ed.parts.querySelectorAll<HTMLElement>(".part")) {
    node.classList.toggle("selected", Number(node.dataset.seg) === i);
  }
  for (const node of ed.partList.querySelectorAll<HTMLElement>(".part-row")) {
    node.classList.toggle("selected", [...ed.partList.children].indexOf(node) === i);
  }
  paintFields(ed);
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

/** Draws one frame per slot across the track. Sequential seeks on the hidden decoder, each
 *  drawn as it lands, so a wide zoom fills in from the left rather than all at once. */
async function buildFilm(ed: Editor): Promise<void> {
  const gen = ++ed.filmGen;
  const width = ed.track.clientWidth;
  if (!width) return;
  const aspect = ed.source.width && ed.source.height ? ed.source.width / ed.source.height : 16 / 9;
  const thumbW = Math.max(40, Math.round(FILM_HEIGHT * aspect));
  const n = Math.min(MAX_THUMBS, Math.max(1, Math.ceil(width / thumbW)));
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const canvas = ed.filmCanvas;
  canvas.width = Math.round(n * thumbW * dpr);
  canvas.height = Math.round(FILM_HEIGHT * dpr);
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  ctx.scale(dpr, dpr);
  if (!(await decoderReady(ed.film))) return;
  for (let i = 0; i < n; i++) {
    if (ed.filmGen !== gen) return;
    const at = (((i + 0.5) / n) * ed.durationMs) / 1000;
    const ok = await seekDecoder(ed.film, at);
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
  ed.past.push(ed.segments.map((s) => ({ ...s })));
  if (ed.past.length > HISTORY) ed.past.shift();
  ed.future = [];
}

function undo(): void {
  const ed = live;
  if (!ed) return;
  const prev = ed.past.pop();
  if (!prev) return;
  ed.future.push(ed.segments.map((s) => ({ ...s })));
  ed.segments = prev;
  clampSelection(ed);
  paintParts(ed);
}

function redo(): void {
  const ed = live;
  if (!ed) return;
  const next = ed.future.pop();
  if (!next) return;
  ed.past.push(ed.segments.map((s) => ({ ...s })));
  ed.segments = next;
  clampSelection(ed);
  paintParts(ed);
}

function clampSelection(ed: Editor): void {
  if (ed.selected !== null && ed.selected >= ed.segments.length) ed.selected = ed.segments.length - 1;
}

function reset(): void {
  const ed = live;
  if (!ed || isWhole(ed)) return;
  push(ed);
  ed.segments = [{ start_ms: 0, end_ms: ed.durationMs }];
  ed.selected = 0;
  paintParts(ed);
}

/** The part that starts at or after the playhead becomes the one that starts here: inside a
 *  part that trims its head, in a removed range it grows the next part back to cover it. */
function setIn(): void {
  const ed = live;
  if (!ed) return;
  const at = now(ed);
  const segs = ed.segments;
  const i = segs.findIndex((s) => at < s.end_ms - MIN_MS);
  if (i < 0) {
    note(ed, t("editor.nothingAfter"));
    return;
  }
  push(ed);
  const lo = i > 0 ? segs[i - 1].end_ms : 0;
  segs[i].start_ms = Math.max(at, lo);
  ed.selected = i;
  mergeTouching(ed);
  paintParts(ed);
  note(ed, "");
}

function setOut(): void {
  const ed = live;
  if (!ed) return;
  const at = now(ed);
  const segs = ed.segments;
  let i = -1;
  segs.forEach((s, k) => {
    if (s.start_ms + MIN_MS <= at) i = k;
  });
  if (i < 0) {
    note(ed, t("editor.nothingBefore"));
    return;
  }
  push(ed);
  const hi = i < segs.length - 1 ? segs[i + 1].start_ms : ed.durationMs;
  segs[i].end_ms = Math.min(at, hi);
  ed.selected = i;
  mergeTouching(ed);
  paintParts(ed);
  note(ed, "");
}

function split(): void {
  const ed = live;
  if (!ed) return;
  const at = now(ed);
  const segs = ed.segments;
  const i = segs.findIndex((s) => at - s.start_ms >= MIN_MS && s.end_ms - at >= MIN_MS);
  if (i < 0) {
    note(ed, t("editor.splitInside"));
    return;
  }
  push(ed);
  const s = segs[i];
  segs.splice(i, 1, { start_ms: s.start_ms, end_ms: at }, { start_ms: at, end_ms: s.end_ms });
  ed.selected = i + 1;
  paintParts(ed);
  note(ed, "");
}

function removeSelected(): void {
  const ed = live;
  if (!ed) return;
  const at = now(ed);
  const i = ed.selected ?? ed.segments.findIndex((s) => at >= s.start_ms && at <= s.end_ms);
  if (i === null || i < 0) {
    note(ed, t("editor.pickPart"));
    return;
  }
  if (ed.segments.length === 1) {
    note(ed, t("editor.onePartStays"));
    return;
  }
  push(ed);
  ed.segments.splice(i, 1);
  ed.selected = null;
  paintParts(ed);
  note(ed, "");
}

function restoreGap(ed: Editor, before: number): void {
  push(ed);
  const segs = ed.segments;
  if (before === 0) segs[0].start_ms = 0;
  else if (before >= segs.length) segs[segs.length - 1].end_ms = ed.durationMs;
  else {
    segs[before - 1].end_ms = segs[before].end_ms;
    segs.splice(before, 1);
    if (ed.selected !== null && ed.selected >= before) ed.selected = Math.max(0, ed.selected - 1);
  }
  mergeTouching(ed);
  paintParts(ed);
}

/** Every edge of every part, for [ and ] to hop between. */
function jumpCut(ed: Editor, direction: -1 | 1): void {
  const t = now(ed);
  const edges = ed.segments.flatMap((s) => [s.start_ms, s.end_ms]).sort((a, b) => a - b);
  const target = direction > 0 ? edges.find((e) => e > t + 1) : [...edges].reverse().find((e) => e < t - 1);
  seek(ed, target ?? (direction > 0 ? ed.durationMs : 0));
}

function wireFields(ed: Editor): void {
  const commit = (field: HTMLInputElement, edge: "in" | "out") => {
    if (ed.selected === null) return;
    const ms = parseTime(field.value);
    if (ms === null) {
      paintFields(ed);
      return;
    }
    const segs = ed.segments;
    const i = ed.selected;
    const s = segs[i];
    const lo = i > 0 ? segs[i - 1].end_ms : 0;
    const hi = i < segs.length - 1 ? segs[i + 1].start_ms : ed.durationMs;
    push(ed);
    if (edge === "in") s.start_ms = clamp(ms, lo, s.end_ms - MIN_MS);
    else s.end_ms = clamp(ms, s.start_ms + MIN_MS, hi);
    mergeTouching(ed);
    paintParts(ed);
    seek(ed, edge === "in" ? s.start_ms : s.end_ms);
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

function isWhole(ed: Editor): boolean {
  const s = ed.segments;
  return s.length === 1 && s[0].start_ms <= 0 && s[0].end_ms >= ed.durationMs;
}

function isDirty(ed: Editor): boolean {
  return JSON.stringify(ed.segments) !== ed.initial;
}

async function apply(): Promise<void> {
  const ed = live;
  if (!ed) return;
  const payload = isWhole(ed)
    ? []
    : ed.segments.map((s) => ({ start_ms: Math.round(s.start_ms), end_ms: Math.round(s.end_ms) }));
  ed.applyButton.disabled = true;
  note(ed, t("editor.queuing"));
  try {
    await ipc.applyCut(ed.id, payload);
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
    case "s":
    case "S":
      split();
      break;
    case "Delete":
    case "Backspace":
      removeSelected();
      break;
    case "[":
      jumpCut(ed, -1);
      break;
    case "]":
      jumpCut(ed, 1);
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

/** m:ss.mmm, the precision a cut is stored at. */
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
  const t = text.trim();
  const clock = /^(\d+):(\d{1,2})(?:\.(\d{1,3}))?$/.exec(t);
  if (clock) {
    const frac = (clock[3] ?? "").padEnd(3, "0");
    return Number(clock[1]) * 60000 + Number(clock[2]) * 1000 + Number(frac);
  }
  const plain = /^(\d+)(?:\.(\d{1,3}))?$/.exec(t);
  if (plain) return Number(plain[1]) * 1000 + Number((plain[2] ?? "").padEnd(3, "0"));
  return null;
}
