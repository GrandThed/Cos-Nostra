/** The player, which doubles as the clip detail view.
 *
 *  Prev and Next step through whatever the library is currently showing, so a filter or a
 *  search narrows the player too. */

import { serverStack, statusDot } from "./circles";
import { badgeFor, canEdit, cutLabel, gameLabel, isReleased, mediaFor, unknownGame } from "./clips";
import { confirming, editInline, fill, h } from "./dom";
import { fmtBytes, fmtClock, fmtDuration, fmtWhen, fmtWhenLong, hueFor } from "./format";
import { t } from "./i18n";
import * as ipc from "./ipc";
import { copyLinkButton, selectionLabel, showInMatch, visibleClips } from "./library";
import { openExportDialog } from "./exporter";
import { openPublishDialog } from "./publish";
import { go } from "./router";
import { data, loadClips, on } from "./store";
import {
  clickToPlay,
  flasher,
  frameStep,
  fullscreenButton,
  leaveFullscreen,
  loopToggle,
  speedControl,
  togglePlay,
  type Transport,
  transportKey,
  typing,
  volume,
} from "./transport";
import type { ClipRow } from "./types";

interface Live {
  id: number;
  video: HTMLVideoElement;
  preview: HTMLVideoElement | null;
  /** The frame of the transport that is cheap to redraw on every timeupdate. */
  played: HTMLElement;
  buffered: HTMLElement;
  knob: HTMLElement;
  time: HTMLElement;
  playButton: HTMLElement;
  scrubber: HTMLElement;
  previewBox: HTMLElement;
  previewAt: HTMLElement;
  root: HTMLElement;
  message: HTMLElement;
  /** The Trim & cut strip under the transport, redrawn with the rail. */
  strip: HTMLElement;
  onKey: (e: KeyboardEvent) => void;
}

let live: Live | null = null;
let theatre = false;

export function initPlayer(): void {
  // A clip that changes while it is open (encode finishes, upload lands) redraws the rail,
  // but never interrupts what is playing. A clip that only now arrived builds the player.
  on("clips", () => {
    if (live) renderRail();
    else show();
  });
  on("progress", () => {
    if (live) renderRail();
  });
  // Both only reach the rail when something it shows moved (see `railKey`).
  on("clipMatches", () => {
    if (live) renderRail();
  });
  on("status", () => {
    if (live) renderRail();
  });
}

/** What the route asked for, which is not always something the store has yet. */
let wanted: { root: HTMLElement; id: number } | null = null;

export function mountPlayer(root: HTMLElement, id: number): void {
  wanted = { root, id };
  show();
}

/** Builds the player if the clip is known, and says why not if it is not. The queue opens a
 *  moment after the window does, so an empty list this early means "not yet", not "gone". */
function show(): void {
  if (!wanted || live) return;
  const clip = data.clips.find((c) => c.id === wanted?.id);
  if (!clip) {
    fill(
      wanted.root,
      h("div", {
        class: "empty-state",
        text: data.clips.length ? t("player.gone") : t("player.opening"),
      }),
    );
    return;
  }
  build(wanted.root, clip);
}

function build(root: HTMLElement, clip: ClipRow): void {
  const id = clip.id;
  const media = mediaFor(clip, data.settings);
  const list = siblings(id);
  const index = list.findIndex((c) => c.id === id);

  const video = h("video", {
    preload: "metadata",
    playsinline: true,
    src: media?.url ?? "",
  }) as HTMLVideoElement;

  // A second decoder, seeked to wherever the pointer is on the scrubber. Only for local
  // files: doing this against the site would re-request the clip on every mouse move.
  const preview =
    media && !media.streaming
      ? (h("video", { preload: "metadata", muted: true, src: media.url }) as HTMLVideoElement)
      : null;

  const played = h("span", { class: "played" });
  const buffered = h("span", { class: "buffered" });
  const knob = h("span", { class: "knob" });
  const previewAt = h("span", { class: "at" });
  const previewBox = h("div", { class: "preview", hidden: true }, preview, previewAt);
  const scrubber = h("div", { class: "scrubber" }, buffered, played, knob, previewBox);
  const time = h("span", { class: "time" });
  const playButton = h("button", {
    class: "play",
    type: "button",
    text: "▶",
    title: t("player.play"),
  });
  const message = h("div", { class: "rail-msg" });
  const strip = h("div", { class: "trim-slot" });

  const bigPlay = h(
    "button",
    { type: "button", class: "big-play", title: t("player.play") },
    h("span", { text: "▶" }),
  );

  const box = h(
    "div",
    { class: "video" },
    media ? video : null,
    media?.streaming
      ? h("span", { class: "source-note", text: t("player.streaming") })
      : null,
    media ? bigPlay : h("div", { class: "trouble", text: t("player.noVideo") }),
  );
  const stage = h("div", { class: "stage" });
  const tr: Transport = { video, fps: clip.fps, flash: flasher(box), fullscreen: stage };
  stage.append(
    box,
    h(
      "div",
      { class: "transport" },
      scrubber,
      h(
        "div",
        { class: "controls" },
        playButton,
        time,
        frameStep(video, clip.fps),
        h("span", { class: "grow" }),
        volume(video),
        speedControl(video),
        loopToggle(video),
        h("button", {
          type: "button",
          class: "theatre",
          title: t("player.theatre"),
          text: "▭",
          onclick: () => toggleTheatre(),
        }),
        fullscreenButton(stage),
      ),
      h(
        "div",
        { class: "keys" },
        ...(["play", "seek", "frame", "speed", "volume", "screen", "edit"] as const).map((k) =>
          h("span", { text: t(`player.keys.${k}`) }),
        ),
      ),
    ),
    strip,
  );

  const player = h(
    "div",
    { class: `player${theatre ? " theatre" : ""}`, style: `--hue:${hueFor(clip.id)}` },
    h(
      "div",
      { class: "player-head" },
      h(
        "button",
        { type: "button", class: "back", onclick: () => go({ view: "library" }) },
        "← ",
        h("b", { text: gameLabel(clip.game) }),
        ` / ${fmtWhen(clip.recorded_at)}`,
      ),
      h("span", { class: "grow" }),
      h("span", {
        class: "position",
        text:
          index >= 0
            ? t("player.position", {
                n: index + 1,
                total: list.length,
                scope: selectionLabel(),
              })
            : t("player.positionPlain", { total: list.length }),
      }),
      h(
        "div",
        { class: "steps" },
        h("button", {
          type: "button",
          class: "btn small",
          text: t("player.prev"),
          disabled: index <= 0,
          onclick: () => go({ view: "player", id: list[index - 1].id }),
        }),
        h("button", {
          type: "button",
          class: "btn small",
          text: t("player.next"),
          disabled: index < 0 || index >= list.length - 1,
          onclick: () => go({ view: "player", id: list[index + 1].id }),
        }),
      ),
    ),
    h(
      "div",
      { class: "player-body" },
      stage,
      h("aside", { class: "rail" }),
    ),
  );

  fill(root, player);

  const onKey = (e: KeyboardEvent) => handleKey(e, tr, clip);
  live = {
    id,
    video,
    preview,
    played,
    buffered,
    knob,
    time,
    playButton,
    scrubber,
    previewBox,
    previewAt,
    root: player,
    message,
    strip,
    onKey,
  };

  wireVideo(video, media?.streaming ?? false);
  wireScrubber(scrubber, video, preview, previewBox, previewAt);
  clickToPlay(video, tr);
  playButton.addEventListener("click", () => togglePlay(video));
  bigPlay.addEventListener("click", () => togglePlay(video));
  document.addEventListener("keydown", onKey);

  renderRail();
  paint();
  if (media) void video.play().catch(() => undefined);
}

export function unmountPlayer(): void {
  wanted = null;
  railKey = "";
  if (!live) return;
  if (document.fullscreenElement && live.root.contains(document.fullscreenElement)) leaveFullscreen();
  document.removeEventListener("keydown", live.onKey);
  // Both are decoders holding a file open; the scrub preview is easy to forget.
  for (const video of [live.video, live.preview]) {
    if (!video) continue;
    video.pause();
    video.removeAttribute("src");
    video.load();
  }
  live = null;
}

/** The clips the library is showing, so Prev and Next honour the current game and filters. */
function siblings(id: number): ClipRow[] {
  const shown = visibleClips();
  return shown.some((c) => c.id === id) ? shown : data.clips;
}

// ---------------------------------------------------------------------------
// Transport

function wireVideo(video: HTMLVideoElement, streaming: boolean): void {
  for (const event of ["timeupdate", "durationchange", "progress", "seeked", "play", "pause"]) {
    video.addEventListener(event, paint);
  }
  video.addEventListener("error", () => {
    if (!live) return;
    const why = streaming ? t("player.errorStreaming") : t("player.errorLocal");
    const box = live.root.querySelector(".video");
    if (box && !box.querySelector(".trouble")) {
      box.appendChild(h("div", { class: "trouble", text: why }));
    }
  });
  video.addEventListener("play", () => {
    const big = live?.root.querySelector<HTMLElement>(".big-play");
    if (big) big.hidden = true;
  });
  video.addEventListener("pause", () => {
    const big = live?.root.querySelector<HTMLElement>(".big-play");
    if (big) big.hidden = false;
  });
}

function paint(): void {
  if (!live) return;
  const { video } = live;
  const duration = Number.isFinite(video.duration) && video.duration > 0 ? video.duration : 0;
  const at = duration ? Math.min(video.currentTime / duration, 1) : 0;
  live.played.style.width = `${at * 100}%`;
  live.knob.style.left = `${at * 100}%`;
  const end = video.buffered.length ? video.buffered.end(video.buffered.length - 1) : 0;
  live.buffered.style.width = duration ? `${Math.min(end / duration, 1) * 100}%` : "0";
  fill(
    live.time,
    fmtClock(video.currentTime || 0),
    h("span", { class: "total", text: ` / ${fmtClock(duration)}` }),
  );
  live.playButton.textContent = video.paused ? "▶" : "⏸";
  live.playButton.title = video.paused ? t("player.play") : t("player.pause");
}

function wireScrubber(
  scrubber: HTMLElement,
  video: HTMLVideoElement,
  preview: HTMLVideoElement | null,
  previewBox: HTMLElement,
  previewAt: HTMLElement,
): void {
  const fraction = (e: PointerEvent | MouseEvent): number => {
    const box = scrubber.getBoundingClientRect();
    return Math.min(Math.max((e.clientX - box.left) / box.width, 0), 1);
  };
  const seek = (e: PointerEvent) => {
    if (!Number.isFinite(video.duration)) return;
    video.currentTime = fraction(e) * video.duration;
  };

  scrubber.addEventListener("pointerdown", (e) => {
    scrubber.setPointerCapture(e.pointerId);
    seek(e);
  });
  scrubber.addEventListener("pointermove", (e) => {
    if (scrubber.hasPointerCapture(e.pointerId)) seek(e);
    if (!Number.isFinite(video.duration) || video.duration <= 0) return;
    const at = fraction(e) * video.duration;
    previewBox.hidden = false;
    previewBox.style.left = `${fraction(e) * 100}%`;
    previewAt.textContent = fmtClock(at);
    if (preview && Math.abs(preview.currentTime - at) > 0.2) preview.currentTime = at;
  });
  scrubber.addEventListener("pointerleave", () => {
    previewBox.hidden = true;
  });
  scrubber.addEventListener("pointerup", (e) => scrubber.releasePointerCapture(e.pointerId));
}

function toggleTheatre(): void {
  theatre = !theatre;
  live?.root.classList.toggle("theatre", theatre);
}

function handleKey(e: KeyboardEvent, tr: Transport, clip: ClipRow): void {
  if (typing(e) || e.ctrlKey || e.altKey || e.metaKey) return;
  switch (e.key) {
    case "t":
    case "T":
      if (!e.repeat) toggleTheatre();
      break;
    case "e":
    case "E": {
      const now = data.clips.find((c) => c.id === clip.id);
      if (now && canEdit(now, data.clipMatches.has(now.id))) go({ view: "editor", id: clip.id });
      break;
    }
    case "Escape":
      // Fullscreen is the webview's to leave.
      if (document.fullscreenElement) return;
      if (theatre) toggleTheatre();
      else go({ view: "library" });
      break;
    default:
      transportKey(e, tr);
      return;
  }
  e.preventDefault();
}

/** The way into the editor: a sketch of the clip's current range on its recording (or its
 *  whole length) that opens the timeline. Disabled, with the reason, while there is nothing
 *  here to cut. */
function cutStrip(clip: ClipRow): HTMLElement {
  const editable = canEdit(clip, data.clipMatches.has(clip.id));
  const cut = clip.cut;
  // The sketch is in source time, and after a cut the row's duration is the kept length, so
  // the last segment's end is the better guess at how long the recording is. Several parts
  // from before the range editor are drawn as their outer span, which is what the editor
  // opens them as.
  const scale = Math.max(clip.duration_ms, cut?.[cut.length - 1]?.end_ms ?? 0, 1);
  const span = cut?.length
    ? { start_ms: cut[0].start_ms, end_ms: cut[cut.length - 1].end_ms }
    : { start_ms: 0, end_ms: scale };
  const keeps = [span].map((s) =>
    h("span", {
      class: "keep",
      style: `left:${(s.start_ms / scale) * 100}%;width:${((s.end_ms - s.start_ms) / scale) * 100}%`,
    }),
  );
  const note = !editable
    ? isReleased(clip)
      ? t("player.cut.released")
      : t("player.cut.busy")
    : cut
      ? t("player.cut.change", { cut: cutLabel(cut) })
      : t("player.cut.invite");
  return h(
    "button",
    {
      type: "button",
      class: "trim",
      disabled: !editable,
      title: t("player.cut.title"),
      onclick: () => go({ view: "editor", id: clip.id }),
    },
    h("span", {
      class: `tag${cut ? " cut" : ""}`,
      text: cut ? t("player.cut.tagCut") : t("player.cut.tagTrim"),
    }),
    h("span", { class: "strip" }, ...keeps),
    h("span", { class: "note", text: note }),
  );
}

// ---------------------------------------------------------------------------
// Rail

/** What the rail is currently showing, so a poll that changed nothing does not rebuild it.
 *  Rebuilding would also disarm a Delete waiting for its second click. */
let railKey = "";

function renderRail(): void {
  if (!live) return;
  const rail = live.root.querySelector<HTMLElement>(".rail");
  const clip = data.clips.find((c) => c.id === live?.id);
  if (!rail || !clip) return;

  const badge = badgeFor(clip, data.progress.get(clip.id), data.status, data.settings);
  const released = isReleased(clip);
  const inMatch = data.clipMatches.has(clip.id);

  const key = [
    clip.game,
    clip.title,
    clip.size_source,
    clip.size_av1,
    clip.size_h264,
    clip.page_url,
    clip.status,
    clip.publish,
    clip.remote_id,
    JSON.stringify(clip.posts),
    badge.label,
    released,
    clip.duration_ms,
    JSON.stringify(clip.cut),
    inMatch,
  ].join("");
  if (key === railKey) return;
  railKey = key;

  fill(live.strip, cutStrip(clip));
  const editable = canEdit(clip, inMatch);

  const name = h("button", {
    type: "button",
    class: "game-name",
    text: `${gameLabel(clip.game)} ✎`,
    title: t("player.rail.renameTitle"),
  });
  name.addEventListener("click", () =>
    editInline(name, clip.game ?? "", (value) => void ipc.setClipGame(clip.id, value).then(loadClips), {
      class: "game-edit",
      placeholder: unknownGame(),
    }),
  );

  const openFolder = h("button", {
    type: "button",
    class: "btn",
    text: released ? t("player.rail.openFolderReleased") : t("player.rail.openFolder"),
    disabled: released,
    onclick: () => void ipc.openClipFolder(clip.id),
  }) as HTMLButtonElement;

  fill(
    rail,
    h(
      "div",
      { class: "game-block" },
      h("span", { class: "label", text: t("player.rail.gameLabel") }),
      name,
      clip.title
        ? h("span", {
            class: "window-title",
            text: t("player.rail.windowTitle", { title: clip.title }),
          })
        : null,
    ),
    h(
      "div",
      { class: "status-row" },
      statusDot(badge),
      h("span", { class: `badge ${badge.kind}`, text: badge.label, title: badge.title }),
      h("span", { class: "grow" }),
      serverStack(clip),
    ),
    h(
      "div",
      { class: "facts" },
      h("span", { class: "k", text: t("player.rail.recorded") }),
      h("span", { class: "v", text: fmtWhenLong(clip.recorded_at) }),
      h("span", { class: "k", text: t("player.rail.length") }),
      h("span", { class: "v mono", text: fmtDuration(clip.duration_ms) }),
      h("span", { class: "k", text: t("player.rail.video") }),
      h("span", { class: "v mono", text: videoLine(clip) }),
      h("span", { class: "k", text: t("player.rail.original") }),
      h("span", {
        class: "v mono",
        text: released
          ? t("player.rail.originalFreed", { size: fmtBytes(clip.size_source) })
          : fmtBytes(clip.size_source),
      }),
      h("span", { class: "k", text: t("player.rail.sizes") }),
      h("span", {
        class: "v mono",
        text: `${fmtBytes(clip.size_av1)} / ${fmtBytes(clip.size_h264)}`,
      }),
      clip.cut ? h("span", { class: "k", text: t("player.rail.cut") }) : null,
      clip.cut ? h("span", { class: "v", text: cutLabel(clip.cut) }) : null,
    ),
    h(
      "div",
      { class: "buttons" },
      ...publishButtons(clip),
      h("button", {
        type: "button",
        class: "btn",
        text: t("player.rail.export"),
        title: released ? t("player.rail.exportReleased") : t("player.rail.exportTitle"),
        disabled: released,
        onclick: () => openExportDialog(clip.id),
      }),
      h("button", {
        type: "button",
        class: "btn",
        text: t("player.rail.trimCut"),
        disabled: !editable,
        title: editable ? t("player.rail.trimCutTitle") : t("player.rail.trimCutDisabled"),
        onclick: () => go({ view: "editor", id: clip.id }),
      }),
      inMatch
        ? h("button", {
            type: "button",
            class: "btn",
            text: t("player.rail.showInMatch"),
            onclick: () => showInMatch(clip.id),
          })
        : null,
      openFolder,
      clip.status === "failed"
        ? h("button", {
            type: "button",
            class: "btn",
            text: t("player.rail.retry"),
            onclick: () => void ipc.retryClip(clip.id),
          })
        : null,
      confirming(
        h("button", { type: "button", class: "btn danger" }) as HTMLButtonElement,
        clip.remote_id ? t("player.rail.delete") : t("player.rail.deleteLocal"),
        t("player.rail.confirmDelete"),
        () => void deleteClip(clip.id),
      ),
    ),
    live.message,
    h("span", { class: "grow" }),
    h("span", {
      class: "note",
      text: clip.remote_id ? t("player.rail.noteRemote") : t("player.rail.noteLocal"),
    }),
  );
}

/** The rail's first buttons, which say where the clip stands: Publish for a local clip, the
 *  link and the servers for a published one, and a way to watch or stop a publish underway. */
function publishButtons(clip: ClipRow): HTMLElement[] {
  const dialog = (text: string, className: string, title?: string) =>
    h("button", { type: "button", class: className, text, title, onclick: () => openPublishDialog(clip.id) });
  if (clip.remote_id) {
    return [
      clip.page_url
        ? copyLinkButton(clip.page_url, "btn primary")
        : h("button", { type: "button", class: "btn", text: t("library.copyLink"), disabled: true }),
      dialog(t("player.rail.servers"), "btn"),
    ];
  }
  if (clip.publish) return [dialog(t("player.rail.publishing"), "btn")];
  return [dialog(t("player.rail.publish"), "btn primary", t("player.rail.publishTitle"))];
}

function videoLine(clip: ClipRow): string {
  const size =
    clip.width && clip.height ? `${clip.width}×${clip.height}` : t("player.rail.unknownSize");
  return clip.fps ? t("player.rail.fps", { size, fps: Math.round(clip.fps) }) : size;
}

async function deleteClip(id: number): Promise<void> {
  if (!live) return;
  live.message.textContent = t("player.rail.deleting");
  live.message.className = "rail-msg";
  try {
    await ipc.deleteClip(id);
    go({ view: "library" });
  } catch (e) {
    live.message.textContent = ipc.errorText(e);
    live.message.className = "rail-msg err";
  }
}
