/** What every video in the window shares: the keys, the speed dial, volume, frame step, loop,
 *  fullscreen, and the chip over the picture that says what a key just did.
 *
 *  The keys are YouTube's, because that is what hands already know: Space or K plays and
 *  pauses, ←/→ move 5 s (1 s with Shift), J/L 10 s, `,` and `.` one frame, `<` and `>` the
 *  speed, ↑/↓ the volume, M mutes, 0–9 jump to that tenth of the video, Home and End to the
 *  edges, F is fullscreen. A screen handles its own keys first (I and O, the editor's undo)
 *  and hands the rest to `transportKey`.
 *
 *  No video uses the native `controls`. With them, Space on a focused native button both
 *  pressed the button and toggled the video, so it paused and resumed in one keystroke. */

import { getCurrentWindow } from "@tauri-apps/api/window";
import { h } from "./dom";
import { fmtDecimal } from "./format";
import { t } from "./i18n";

export const SPEEDS = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 1.75, 2];
/** Old clips have no recorded frame rate; 60 is what the recorder has always captured. */
const FALLBACK_FPS = 60;
const VOLUME_STEP = 0.05;
/** How long the chip over the picture stays up after a key. */
const FLASH_MS = 650;

export interface Transport {
  video: HTMLVideoElement;
  fps: number | null;
  /** Play or pause. Defaults to the video's own; the editor holds playback to its range. */
  toggle?: () => void;
  /** Puts the playhead at `seconds`, already clamped to the video. Defaults to `currentTime`. */
  seek?: (seconds: number) => void;
  /** What fullscreen shows. Without it F is left to the screen. */
  fullscreen?: HTMLElement;
  flash?: (text: string) => void;
}

/** True while a key belongs to a text field. The volume slider is not one: its arrow keys
 *  are worth less than Space working after it was dragged. */
export function typing(e: KeyboardEvent): boolean {
  const target = e.target as HTMLElement | null;
  if (!target) return false;
  if (target.isContentEditable || /^(TEXTAREA|SELECT)$/.test(target.tagName)) return true;
  return target instanceof HTMLInputElement && target.type !== "range";
}

export function togglePlay(video: HTMLVideoElement): void {
  if (video.paused) void video.play().catch(() => undefined);
  else video.pause();
}

/** Handles one key for `tr`, returning whether it did (and so called `preventDefault`).
 *  Keys held down repeat seeks and volume but never a toggle. */
export function transportKey(e: KeyboardEvent, tr: Transport): boolean {
  if (typing(e) || e.ctrlKey || e.altKey || e.metaKey) return false;
  const { video } = tr;
  const duration = Number.isFinite(video.duration) && video.duration > 0 ? video.duration : 0;
  const flash = tr.flash ?? (() => undefined);
  const seekTo = (seconds: number) => {
    const at = Math.max(0, duration ? Math.min(seconds, duration) : seconds);
    if (tr.seek) tr.seek(at);
    else video.currentTime = at;
  };
  const seekBy = (seconds: number) => {
    seekTo(video.currentTime + seconds);
    flash(`${seconds < 0 ? "−" : "+"}${Math.abs(seconds)} s`);
  };
  const frame = 1 / (tr.fps && tr.fps > 0 ? tr.fps : FALLBACK_FPS);
  const once = (run: () => void) => {
    if (!e.repeat) run();
  };

  // `<` and `>` are Shift+, and Shift+. on a US layout and a key of their own on a Spanish one.
  const slower = e.key === "<" || (e.shiftKey && e.code === "Comma");
  const faster = e.key === ">" || (e.shiftKey && e.code === "Period");
  if (slower || faster) {
    stepSpeed(video, faster ? 1 : -1);
    flash(speedText(video.playbackRate));
    e.preventDefault();
    return true;
  }

  switch (e.key) {
    case " ":
    case "k":
    case "K":
      once(() => {
        if (tr.toggle) tr.toggle();
        else togglePlay(video);
        flash(video.paused ? "❚❚" : "▶");
      });
      break;
    case "ArrowLeft":
      seekBy(e.shiftKey ? -1 : -5);
      break;
    case "ArrowRight":
      seekBy(e.shiftKey ? 1 : 5);
      break;
    case "j":
    case "J":
      seekBy(-10);
      break;
    case "l":
    case "L":
      seekBy(10);
      break;
    case ",":
      video.pause();
      seekTo(video.currentTime - frame);
      break;
    case ".":
      video.pause();
      seekTo(video.currentTime + frame);
      break;
    case "ArrowUp":
    case "ArrowDown": {
      const up = e.key === "ArrowUp";
      video.volume = clamp(Math.round((video.volume + (up ? VOLUME_STEP : -VOLUME_STEP)) * 100) / 100, 0, 1);
      video.muted = video.volume === 0;
      flash(`${volumeIcon(video)} ${Math.round(video.volume * 100)} %`);
      break;
    }
    case "m":
    case "M":
      once(() => {
        video.muted = !video.muted;
        flash(volumeIcon(video));
      });
      break;
    case "Home":
      seekTo(0);
      break;
    case "End":
      seekTo(duration);
      break;
    case "f":
    case "F":
      if (!tr.fullscreen) return false;
      once(() => toggleFullscreen(tr.fullscreen as HTMLElement));
      break;
    default:
      if (/^[0-9]$/.test(e.key) && !e.shiftKey && duration) {
        seekTo((duration * Number(e.key)) / 10);
        break;
      }
      return false;
  }
  e.preventDefault();
  return true;
}

// ---------------------------------------------------------------------------
// Widgets

/** A chip in the middle of `box` that shows what a key did, YouTube-style. */
export function flasher(box: HTMLElement): (text: string) => void {
  const chip = h("div", { class: "osd", hidden: true });
  box.append(chip);
  let timer = 0;
  return (text) => {
    chip.textContent = text;
    chip.hidden = false;
    // Restart the fade when a second key lands before the first chip is gone.
    chip.classList.remove("show");
    void chip.offsetWidth;
    chip.classList.add("show");
    window.clearTimeout(timer);
    timer = window.setTimeout(() => {
      chip.hidden = true;
    }, FLASH_MS);
  };
}

/** Clicking the picture plays and pauses it; a double click is fullscreen. */
export function clickToPlay(video: HTMLVideoElement, tr: Transport): void {
  video.addEventListener("click", () => {
    if (tr.toggle) tr.toggle();
    else togglePlay(video);
    tr.flash?.(video.paused ? "❚❚" : "▶");
  });
  if (tr.fullscreen) {
    const target = tr.fullscreen;
    video.addEventListener("dblclick", () => toggleFullscreen(target));
  }
}

export function frameStep(video: HTMLVideoElement, fps: number | null): HTMLElement {
  const step = 1 / (fps && fps > 0 ? fps : FALLBACK_FPS);
  const move = (by: number) => {
    video.pause();
    video.currentTime = Math.max(0, video.currentTime + by * step);
  };
  return h(
    "span",
    { class: "frames", title: t("transport.frameStep") },
    h("button", { type: "button", text: "‹", onclick: () => move(-1) }),
    t("transport.frame"),
    h("button", { type: "button", text: "›", onclick: () => move(1) }),
  );
}

export function volume(video: HTMLVideoElement): HTMLElement {
  const slider = h("input", {
    type: "range",
    min: "0",
    max: "1",
    step: "0.05",
    value: String(video.volume),
    title: t("transport.volume"),
    oninput: (e: Event) => {
      video.volume = Number((e.target as HTMLInputElement).value);
      video.muted = video.volume === 0;
    },
  }) as HTMLInputElement;
  const icon = h("button", {
    type: "button",
    text: volumeIcon(video),
    title: t("transport.mute"),
    onclick: () => {
      video.muted = !video.muted;
    },
  });
  video.addEventListener("volumechange", () => {
    slider.value = String(video.muted ? 0 : video.volume);
    icon.textContent = volumeIcon(video);
  });
  return h("span", { class: "volume" }, icon, slider);
}

/** The playback speed: a button that opens the list of speeds, and turns like a dial under
 *  the mouse wheel. */
export function speedControl(video: HTMLVideoElement): HTMLElement {
  const button = h("button", { type: "button", class: "speed", title: t("transport.speed") });
  const options = SPEEDS.map((speed) =>
    h("button", {
      type: "button",
      role: "menuitemradio",
      text: speed === 1 ? t("transport.normal") : speedText(speed),
      onclick: () => {
        video.playbackRate = speed;
        close();
      },
    }),
  );
  const menu = h("div", { class: "speed-menu", role: "menu", hidden: true }, ...options);
  const wrap = h("span", { class: "speed-dial" }, button, menu);

  const outside = (e: PointerEvent) => {
    if (!wrap.contains(e.target as Node)) close();
  };
  function close(): void {
    menu.hidden = true;
    document.removeEventListener("pointerdown", outside, true);
  }
  button.addEventListener("click", () => {
    if (!menu.hidden) return close();
    menu.hidden = false;
    document.addEventListener("pointerdown", outside, true);
  });
  wrap.addEventListener(
    "wheel",
    (e) => {
      e.preventDefault();
      stepSpeed(video, e.deltaY < 0 ? 1 : -1);
    },
    { passive: false },
  );
  const paint = () => {
    button.textContent = speedText(video.playbackRate);
    button.classList.toggle("changed", video.playbackRate !== 1);
    SPEEDS.forEach((speed, i) => options[i].setAttribute("aria-checked", String(speed === video.playbackRate)));
  };
  video.addEventListener("ratechange", paint);
  paint();
  return wrap;
}

export function loopToggle(video: HTMLVideoElement): HTMLElement {
  const button = h("button", {
    type: "button",
    class: "loop",
    text: t("transport.loop"),
    "aria-pressed": "false",
  });
  button.addEventListener("click", () => {
    video.loop = !video.loop;
    button.setAttribute("aria-pressed", String(video.loop));
  });
  return button;
}

export function fullscreenButton(target: HTMLElement): HTMLElement {
  return h("button", {
    type: "button",
    class: "fullscreen",
    text: "⛶",
    title: t("transport.fullscreen"),
    onclick: () => toggleFullscreen(target),
  });
}

// ---------------------------------------------------------------------------
// Fullscreen

let fullscreenWired = false;

/** Element fullscreen only fills the webview, which is the window's size; the window follows
 *  it in and out, so Esc (which the webview handles itself) also restores the window. */
export function toggleFullscreen(target: HTMLElement): void {
  if (!fullscreenWired) {
    fullscreenWired = true;
    document.addEventListener("fullscreenchange", () => {
      void getCurrentWindow()
        .setFullscreen(document.fullscreenElement !== null)
        .catch((e) => console.warn("window fullscreen", e));
    });
  }
  if (document.fullscreenElement) void document.exitFullscreen().catch(() => undefined);
  else void target.requestFullscreen().catch((e) => console.warn("fullscreen", e));
}

/** For a screen going away while one of its elements is fullscreen. */
export function leaveFullscreen(): void {
  if (document.fullscreenElement) void document.exitFullscreen().catch(() => undefined);
}

// ---------------------------------------------------------------------------
// Helpers

function stepSpeed(video: HTMLVideoElement, direction: 1 | -1): void {
  const at = SPEEDS.indexOf(video.playbackRate);
  const index = at < 0 ? SPEEDS.indexOf(1) : at + direction;
  video.playbackRate = SPEEDS[clamp(index, 0, SPEEDS.length - 1)];
}

export function speedText(speed: number): string {
  return `${fmtDecimal(speed, speed % 1 ? (speed * 10) % 1 ? 2 : 1 : 0)}×`;
}

function volumeIcon(video: HTMLVideoElement): string {
  if (video.muted || video.volume === 0) return "🔇";
  return video.volume < 0.5 ? "🔉" : "🔊";
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.min(Math.max(n, lo), hi);
}
