/** The window frame: title bar, toolbar, the alarm banners that stack under it on every tab,
 *  and the status popover the recording pill opens. */

import { getCurrentWindow } from "@tauri-apps/api/window";
import { el, fill, h } from "./dom";
import { onLanguage, t } from "./i18n";
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
  // The frame is the only thing that outlives a screen, so it is the only thing that has to
  // repaint itself when the language changes; the router rebuilds whichever screen is up.
  onLanguage(() => {
    renderChrome();
    renderToolbar();
    renderBanners();
    if (panelOpen) renderStatusPanel();
  });
  renderChrome();
}

/** The copy that lives in `index.html`: the tabs, the window buttons and the save button. */
export function renderChrome(): void {
  el("win-minimize").title = t("app.minimise");
  el("win-maximize").title = t("app.maximise");
  el("win-close").title = t("app.closeToTray");
  el("tab-library").textContent = t("app.tabs.library");
  el("tab-matches").textContent = t("app.tabs.matches");
  el("tab-storage").textContent = t("app.tabs.storage");
  el("tab-settings").textContent = t("app.tabs.settings");
  const tabs = document.querySelector(".tabs");
  tabs?.setAttribute("aria-label", t("app.sections"));
  const save = el("save-clip");
  fill(save, `${t("app.saveClip")} `, h("span", { class: "key mono", id: "save-hotkey" }));
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
    lastSave = t("shell.saved", { file: fileName(path) });
  } catch (e) {
    lastSave = t("shell.notSaved", { error: ipc.errorText(e) });
  }
  if (panelOpen) renderStatusPanel();
}

const fileName = (path: string) => path.split(/[\\/]/).pop() ?? path;

/** Called from main when a clip lands via the hotkey or the tray. */
export function noteClipSaved(path: string): void {
  lastSave = t("shell.saved", { file: fileName(path) });
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
      ? t("shell.recordingMatch")
      : t("shell.recordingSession")
    : s?.recording
      ? t("shell.recording")
      : s?.error
        ? t("shell.notRecording")
        : t("shell.starting");
  el("status-game").textContent = session
    ? session.game_name
    : !s?.recording
      ? ""
      : (s.hooked_game?.title ?? s.hooked_game?.executable ?? t("shell.desktop"));

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
      title: t("shell.alarm.recorderFailed"),
      detail: s.error,
      action: { label: t("shell.alarm.retry"), run: () => void retryRecorder() },
    });
  }
  if (s.hotkey_error) {
    list.push({
      tone: "warn",
      title: t("shell.alarm.hotkeyTaken"),
      detail: t("shell.alarm.hotkeyTakenDetail", { hotkey: s.hotkey }),
    });
  }
  if (s.ffmpeg_error) {
    list.push({
      tone: "warn",
      title: t("shell.alarm.cannotEncode"),
      detail: s.ffmpeg_error,
      action: { label: t("shell.alarm.probeAgain"), run: () => void probeEncoders() },
    });
  }
  if (s.conflict) {
    list.push({
      tone: "warn",
      title: t("shell.alarm.conflict", { executable: s.conflict.executable }),
      detail: t("shell.alarm.conflictDetail"),
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
    fill(panel, h("div", { class: "muted", text: t("shell.panel.reading") }));
    return;
  }

  const bufferState = s.recording
    ? h("span", null, h("span", { style: "color:var(--ok)", text: "●" }), ` ${t("shell.panel.running")}`)
    : s.error
      ? h("span", null, h("span", { style: "color:var(--err)", text: "●" }), ` ${t("shell.panel.failed")}`)
      : h("span", null, h("span", { style: "color:var(--mut)", text: "●" }), ` ${t("shell.panel.starting")}`);

  const capturing = s.hooked_game
    ? h(
        "span",
        null,
        s.hooked_game.title || s.hooked_game.executable,
        " ",
        h("span", { class: "mono muted", text: s.hooked_game.executable }),
      )
    : h(
        "span",
        null,
        t("shell.panel.theDesktop"),
        h("span", { class: "muted", text: t("shell.panel.noGameHooked") }),
      );

  const encoders = s.ffmpeg_error
    ? h("span", { class: "muted", text: t("shell.panel.unavailable") })
    : s.encoders
      ? h("span", { class: "mono", text: `${s.encoders.av1} / ${s.encoders.h264}` })
      : h("span", { class: "muted", text: t("shell.panel.probing") });

  const rows: (HTMLElement | string)[] = [
    h("span", { class: "key", text: t("shell.panel.buffer") }),
    h("span", { class: "value" }, bufferState),
    h("span", { class: "key", text: t("shell.panel.capturing") }),
    h(
      "span",
      { class: "value" },
      capturing,
      " ",
      h("span", {
        class: "muted",
        style: "font-size:11px",
        text: t("shell.panel.followsGame"),
      }),
    ),
    h("span", { class: "key", text: t("shell.panel.session") }),
    h(
      "span",
      { class: "value" },
      s.session
        ? `${s.session.game_name} — ${
            s.session.recording
              ? s.session.match_id
                ? t("shell.panel.sessionRecordingMatch")
                : t("shell.panel.sessionRecording")
              : t("shell.panel.betweenGames")
          }`
        : h("span", { class: "muted", text: t("shell.panel.noSupportedGame") }),
    ),
    h("span", { class: "key", text: t("shell.panel.bufferEncoder") }),
    h("span", { class: "value mono", text: s.encoder ?? "–" }),
    h("span", { class: "key", text: t("shell.panel.clipEncoders") }),
    h(
      "span",
      { class: "value" },
      encoders,
      " ",
      h("button", {
        type: "button",
        class: "link",
        text: t("shell.alarm.probeAgain"),
        onclick: () => void probeEncoders(),
      }),
    ),
    h("span", { class: "key", text: t("shell.panel.hotkey") }),
    h("span", {
      class: "value mono",
      text: t("shell.panel.hotkeyValue", { hotkey: s.hotkey, seconds: s.buffer_seconds }),
    }),
    h("span", { class: "key", text: t("shell.panel.folder") }),
    h("span", { class: "value mono", text: s.clip_dir }),
    h("span", { class: "key", text: t("shell.panel.account") }),
    h(
      "span",
      { class: "value" },
      s.account ? s.account.username : t("shell.panel.notLinked"),
      s.account && !s.auto_upload
        ? h("span", { style: "color:var(--warn)", text: t("shell.panel.uploadsOff") })
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
        text: t("shell.panel.saveClipNow"),
        onclick: () => void saveClipNow(),
      }),
      h("span", { class: "result mono", text: lastSave }),
    ),
    h("span", { class: "refresh-note", text: t("shell.panel.refreshNote") }),
  );
}
