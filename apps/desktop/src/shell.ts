/** The window frame: title bar, toolbar, the alarm banners that stack under it on every tab,
 *  and the status popover the recording pill opens. */

import { getCurrentWindow } from "@tauri-apps/api/window";
import { el, fill, h } from "./dom";
import * as ipc from "./ipc";
import { data, loadSettings, loadStatus, on } from "./store";
import type { Account, Status } from "./types";

/** Result of the last "Save clip now", shown in the panel. */
let lastSave = "";
let panelOpen = false;

export function initShell(): void {
  const win = getCurrentWindow();
  el("win-minimize").addEventListener("click", () => void win.minimize());
  el("win-maximize").addEventListener("click", () => void win.toggleMaximize());
  // Closing hides to the tray; Rust explains that with a toast the first time.
  el("win-close").addEventListener("click", () => void win.close());

  const trackMaximized = async () => {
    document.body.classList.toggle("maximized", await win.isMaximized());
  };
  void trackMaximized();
  void win.onResized(trackMaximized);

  el("save-clip").addEventListener("click", () => void saveClipNow());

  el("status-pill").addEventListener("click", (e) => {
    e.stopPropagation();
    setPanel(!panelOpen);
  });
  document.addEventListener("click", (e) => {
    if (panelOpen && !el("status-panel").contains(e.target as Node)) setPanel(false);
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && panelOpen) setPanel(false);
  });

  on("status", () => {
    renderToolbar();
    renderBanners();
    if (panelOpen) renderStatusPanel();
  });
  on("settings", () => {
    renderToolbar();
    if (panelOpen) renderStatusPanel();
  });
}

function setPanel(open: boolean): void {
  panelOpen = open;
  el("status-panel").hidden = !open;
  el("status-pill").setAttribute("aria-expanded", String(open));
  if (open) renderStatusPanel();
}

async function saveClipNow(): Promise<void> {
  try {
    const path = await ipc.saveClip();
    lastSave = `saved ${path.split(/[\\/]/).pop() ?? path}`;
  } catch (e) {
    lastSave = `not saved: ${ipc.errorText(e)}`;
  }
  if (panelOpen) renderStatusPanel();
}

/** Called from main when a clip lands via the hotkey or the tray. */
export function noteClipSaved(path: string): void {
  lastSave = `saved ${path.split(/[\\/]/).pop() ?? path}`;
  if (panelOpen) renderStatusPanel();
}

// ---------------------------------------------------------------------------
// Toolbar

export function renderToolbar(): void {
  const s = data.status;
  const dot = el("status-dot");
  dot.className = `dot${s?.recording ? " live" : s?.error ? " bad" : ""}`;

  // A session being recorded is the bigger news than the buffer: say which game and whether a
  // match is on right now.
  const session = s?.recording && s.session?.recording ? s.session : null;
  el("status-label").textContent = session
    ? session.match_id
      ? "Recording match"
      : "Recording session"
    : s?.recording
      ? "Recording"
      : s?.error
        ? "Not recording"
        : "Starting…";
  el("status-game").textContent = session
    ? session.game_name
    : !s?.recording
      ? ""
      : (s.hooked_game?.title ?? s.hooked_game?.executable ?? "desktop");

  el("save-hotkey").textContent = s?.hotkey ?? "";
  renderAvatar(el("account-avatar"), s?.account ?? null);
}

/** Discord's own shapes: a snowflake is digits, an avatar hash is lowercase hex with an
 *  `a_` prefix on animated ones. Both go straight into a CSS `url()`, and both come from the
 *  backend, so anything else is treated as "no avatar" rather than trusted into the stylesheet. */
const DISCORD_ID = /^\d+$/;
const AVATAR_HASH = /^[a-f0-9_]+$/;

export function renderAvatar(node: HTMLElement, account: Account | null): void {
  node.hidden = !account;
  if (!account) return;
  node.title = account.username;
  node.textContent = initials(account.username);
  const image =
    account.avatar && AVATAR_HASH.test(account.avatar) && DISCORD_ID.test(account.discord_id);
  node.style.backgroundImage = image
    ? `url("https://cdn.discordapp.com/avatars/${account.discord_id}/${account.avatar}.png?size=64")`
    : "";
  if (image) node.textContent = "";
}

function initials(name: string): string {
  const parts = name.split(/[\s_.-]+/).filter(Boolean);
  const letters = parts.length > 1 ? `${parts[0][0]}${parts[1][0]}` : name.slice(0, 2);
  return letters.toUpperCase();
}

// ---------------------------------------------------------------------------
// Banners

interface Alarm {
  tone: "err" | "warn";
  title: string;
  detail: string;
  action?: { label: string; run: () => void };
}

/** Everything worth interrupting for, in the order it should be dealt with. The same list
 *  renders as banners under the toolbar and at the top of the status panel. */
function alarms(s: Status | null): Alarm[] {
  if (!s) return [];
  const list: Alarm[] = [];
  if (s.error) {
    list.push({
      tone: "err",
      title: "Recorder failed",
      detail: s.error,
      action: { label: "Retry", run: () => void retryRecorder() },
    });
  }
  if (s.hotkey_error) {
    list.push({
      tone: "warn",
      title: "Hotkey taken",
      detail: `${s.hotkey} could not be registered. Pick a new one in Settings.`,
    });
  }
  if (s.ffmpeg_error) {
    list.push({
      tone: "warn",
      title: "Clips can't encode",
      detail: s.ffmpeg_error,
      action: { label: "Probe again", run: () => void probeEncoders() },
    });
  }
  if (s.conflict) {
    list.push({
      tone: "warn",
      title: `${s.conflict.executable} is already captured by another tool`,
      detail: "Close OBS, Discord or GeForce Experience, or clips will be black.",
    });
  }
  return list;
}

function bannerNode(a: Alarm): HTMLElement {
  return h(
    "div",
    { class: `banner ${a.tone}` },
    h("div", { class: "body" }, h("b", { text: a.title }), h("div", { class: "detail", text: a.detail })),
    a.action &&
      h("button", { type: "button", class: "btn small", text: a.action.label, onclick: a.action.run }),
  );
}

export function renderBanners(): void {
  fill(el("banners"), ...alarms(data.status).map(bannerNode));
}

async function retryRecorder(): Promise<void> {
  try {
    await ipc.retryRecorder();
  } finally {
    void loadStatus();
  }
}

async function probeEncoders(): Promise<void> {
  try {
    await ipc.reprobeEncoders();
  } catch {
    /* the failure shows up in the status the reload fetches */
  }
  void loadStatus();
  void loadSettings();
}

// ---------------------------------------------------------------------------
// Status panel (the popover behind the recording pill)

function renderStatusPanel(): void {
  const panel = el("status-panel");
  const s = data.status;
  if (!s) {
    fill(panel, h("div", { class: "muted", text: "Reading the recorder…" }));
    return;
  }

  const bufferState = s.recording
    ? h("span", null, h("span", { style: "color:var(--ok)", text: "●" }), " Running")
    : s.error
      ? h("span", null, h("span", { style: "color:var(--err)", text: "●" }), " Failed — retry above")
      : h("span", null, h("span", { style: "color:var(--mut)", text: "●" }), " Starting…");

  const capturing = s.hooked_game
    ? h(
        "span",
        null,
        s.hooked_game.title || s.hooked_game.executable,
        " ",
        h("span", { class: "mono muted", text: s.hooked_game.executable }),
      )
    : h("span", null, "The desktop ", h("span", { class: "muted", text: "— no game hooked" }));

  const encoders = s.ffmpeg_error
    ? h("span", { class: "muted", text: "unavailable" })
    : s.encoders
      ? h("span", { class: "mono", text: `${s.encoders.av1} / ${s.encoders.h264}` })
      : h("span", { class: "muted", text: "probing…" });

  const rows: (HTMLElement | string)[] = [
    h("span", { class: "key", text: "Buffer" }),
    h("span", { class: "value" }, bufferState),
    h("span", { class: "key", text: "Capturing" }),
    h(
      "span",
      { class: "value" },
      capturing,
      " ",
      h("span", { class: "muted", style: "font-size:11px", text: "— follows the game you're in" }),
    ),
    h("span", { class: "key", text: "Session" }),
    h(
      "span",
      { class: "value" },
      s.session
        ? `${s.session.game_name} — ${
            s.session.recording
              ? s.session.match_id
                ? "recording, match in progress"
                : "recording"
              : "between games"
          }`
        : h("span", { class: "muted", text: "no supported game running" }),
    ),
    h("span", { class: "key", text: "Buffer encoder" }),
    h("span", { class: "value mono", text: s.encoder ?? "–" }),
    h("span", { class: "key", text: "Clip encoders" }),
    h(
      "span",
      { class: "value" },
      encoders,
      " ",
      h("button", { type: "button", class: "link", text: "Probe again", onclick: () => void probeEncoders() }),
    ),
    h("span", { class: "key", text: "Hotkey" }),
    h("span", { class: "value mono", text: `${s.hotkey} · ${s.buffer_seconds} s buffer` }),
    h("span", { class: "key", text: "Folder" }),
    h("span", { class: "value mono", text: s.clip_dir }),
    h("span", { class: "key", text: "Account" }),
    h(
      "span",
      { class: "value" },
      s.account ? s.account.username : "not linked",
      s.account && !s.auto_upload
        ? h("span", { style: "color:var(--warn)", text: " (uploads off)" })
        : null,
    ),
  ];

  const banners = alarms(s);
  fill(
    panel,
    ...banners.map(bannerNode),
    banners.length ? h("hr") : null,
    h("div", { class: "rows" }, ...rows),
    h(
      "div",
      { class: "foot" },
      h("button", {
        type: "button",
        class: "btn primary small",
        text: "Save clip now",
        onclick: () => void saveClipNow(),
      }),
      h("span", { class: "result mono", text: lastSave }),
    ),
    h("span", { class: "refresh-note", text: "Refreshes every 5 s and on recorder events." }),
  );
}
