/** Settings: four cards, one Save. Developer things sit behind Advanced, because nobody in
 *  the Discord needs a bitrate. */

import { fill, h } from "./dom";
import { hotkeyControl, type HotkeyControl } from "./hotkey";
import * as ipc from "./ipc";
import { renderAvatar } from "./shell";
import { data, loadSettings, loadStatus, on } from "./store";
import type { EncodeEngine, Quality, Settings } from "./types";

/** Measured on a 30 s 1080p60 clip by scripts/bench-encoders.mjs. Quoted in megabytes rather
 *  than bitrate because that is the number people actually feel, in upload time. */
const QUALITIES: { id: Quality; label: string; hint: string }[] = [
  { id: "small", label: "Smaller files", hint: "~3 MB typical, up to 17 MB" },
  { id: "balanced", label: "Balanced", hint: "~6 MB typical, up to 26 MB" },
  { id: "high", label: "Best quality", hint: "~8 MB typical, up to 42 MB" },
];

const ENGINES: { id: EncodeEngine; label: string; hint: string }[] = [
  { id: "cpu", label: "Processor", hint: "smaller and better · about a minute a clip" },
  { id: "gpu", label: "Graphics card", hint: "seconds · bigger files, no size ceiling" },
];

let root: HTMLElement | null = null;
/** The edits in progress. Replaced from the store on mount and after every save. */
let draft: Settings | null = null;
let hotkey: HotkeyControl | null = null;
let message = "";
let messageKind: "" | "ok" | "err" = "";
/** The device login in progress, if any. */
let pendingCode: string | null = null;
let loginNote = "";

export function initSettings(): void {
  on("settings", () => {
    if (root && !draft) render();
  });
}

export function mountSettings(node: HTMLElement): void {
  root = node;
  draft = null;
  hotkey = null;
  message = "";
  messageKind = "";
  void loadSettings().then(() => {
    if (root) render();
  });
  render();
}

export function unmountSettings(): void {
  hotkey?.stop();
  root = null;
  draft = null;
  hotkey = null;
}

/** The account block reacts to the login events main.ts forwards. */
export function onLoginStateChanged(code: string | null, note: string): void {
  pendingCode = code;
  loginNote = note;
  if (root) render();
}

function render(): void {
  if (!root) return;
  if (!draft) {
    if (!data.settings) {
      fill(root, h("div", { class: "settings" }, h("span", { class: "muted", text: "Loading…" })));
      return;
    }
    draft = { ...data.settings };
    hotkey = hotkeyControl(draft.hotkey);
  }
  const s = draft;

  fill(
    root,
    h("div", { class: "settings scroll" }, captureCard(s), behaviourCard(s), encodingCard(s), accountCard(s)),
  );
}

function card(title: string, ...children: (Node | string | null | false)[]): HTMLElement {
  return h("div", { class: "setting-card" }, h("h3", { text: title }), ...children);
}

// ---------------------------------------------------------------------------

function captureCard(s: Settings): HTMLElement {
  return card(
    "Capture",
    hotkey!.node,
    h(
      "div",
      { class: "field-row" },
      h("span", { class: "name", text: "Buffer length" }),
      number(s.buffer_seconds, 5, 300, 1, (v) => (s.buffer_seconds = v)),
      h("span", { class: "hint", text: "seconds · 5–300 · the clip is the last N seconds" }),
    ),
    h(
      "div",
      { class: "field-row" },
      h("span", { class: "name", text: "Clip folder" }),
      h("span", { class: "field mono grow", text: s.clip_dir, title: s.clip_dir }),
      h("button", {
        type: "button",
        class: "btn small",
        text: "Browse…",
        onclick: async () => {
          const dir = await ipc.pickClipDir();
          if (dir) {
            s.clip_dir = dir;
            render();
          }
        },
      }),
    ),
    h("span", { class: "note", text: "Changing a capture setting restarts the recorder for a second or two." }),
  );
}

function behaviourCard(s: Settings): HTMLElement {
  return card(
    "Behaviour",
    toggle("Start with Windows", s.start_with_windows, (v) => (s.start_with_windows = v)),
    toggle("Show a notification when a clip is saved", s.notify_on_save, (v) => (s.notify_on_save = v)),
    toggle("Play a sound when a clip is saved", s.sound_on_save, (v) => (s.sound_on_save = v)),
    toggle(
      "Encode while a game is running",
      s.encode_while_gaming,
      (v) => (s.encode_while_gaming = v),
      "Off: clips wait until you stop playing, so the game keeps every frame. On: clips are ready sooner but encoding may cost frames.",
    ),
  );
}

function encodingCard(s: Settings): HTMLElement {
  return card(
    "Encoding",
    radioCards(
      QUALITIES.map((q) => ({ id: q.id, label: q.label, hint: q.hint })),
      s.quality,
      (id) => {
        s.quality = id as Quality;
        render();
      },
    ),
    h("span", { class: "note", text: "Sizes for a 30 s 1080p60 clip." }),
    radioCards(
      ENGINES.map((e) => ({ id: e.id, label: e.label, hint: e.hint })),
      s.encode_engine,
      (id) => {
        s.encode_engine = id as EncodeEngine;
        render();
      },
    ),
    h(
      "details",
      { class: "advanced" },
      h("summary", { text: "Advanced" }),
      h(
        "div",
        { class: "body" },
        h(
          "div",
          { class: "field-row" },
          h("span", { class: "name", text: "Buffer bitrate" }),
          number(s.video_bitrate_kbps, 2000, 60000, 500, (v) => (s.video_bitrate_kbps = v)),
          h("span", { class: "hint", text: "kbps · 2000–60000" }),
        ),
        h(
          "div",
          { class: "field-row" },
          h("span", { class: "name", text: "Backend URL" }),
          text(s.backend_url, (v) => (s.backend_url = v)),
          h("span", { class: "hint", text: "https:// · http:// only for localhost" }),
        ),
      ),
    ),
  );
}

function accountCard(s: Settings): HTMLElement {
  const account = data.status?.account ?? s.account;
  const avatar = h("span", { class: "avatar" });
  if (account) renderAvatar(avatar, account);

  const identity = account
    ? h(
        "div",
        { class: "account" },
        avatar,
        h(
          "div",
          { class: "who" },
          h("b", { text: `Logged in as ${account.username}` }),
          h("small", { text: "via Discord — the only login there is" }),
        ),
        h("button", {
          type: "button",
          class: "btn small",
          text: "Log out",
          onclick: () => void logOut(),
        }),
      )
    : pendingCode
      ? h(
          "div",
          { class: "account-pending" },
          h("div", { class: "device-code", text: pendingCode }),
          h(
            "div",
            { class: "note" },
            h("span", { class: "spinner" }),
            " waiting for the browser… times out in 10 min",
          ),
          h("button", {
            type: "button",
            class: "btn small",
            text: "Cancel",
            onclick: () => void ipc.cancelLogin().then(() => onLoginStateChanged(null, "")),
          }),
        )
      : h(
          "div",
          { class: "account" },
          h(
            "div",
            { class: "who" },
            h("b", { text: "Not linked" }),
            h("small", { text: "Clips stay on this PC until you link Discord." }),
          ),
          h("button", {
            type: "button",
            class: "btn primary small",
            text: "Link Discord",
            onclick: () => void startLogin(),
          }),
        );

  return card(
    "Account & uploads",
    identity,
    loginNote ? h("span", { class: "note", text: loginNote }) : null,
    toggle(
      "Upload clips automatically",
      s.auto_upload,
      (v) => (s.auto_upload = v),
      'Off: clips stop at "Ready" and stay on this PC until you say so.',
    ),
    h("span", { class: "grow" }),
    h(
      "div",
      { class: "save-row" },
      h("button", {
        type: "button",
        class: "btn primary",
        text: "Save settings",
        onclick: () => void save(),
      }),
      h("span", { class: `msg ${messageKind}`, text: message }),
    ),
  );
}

// ---------------------------------------------------------------------------
// Small controls

function toggle(
  label: string,
  checked: boolean,
  set: (v: boolean) => void,
  detail?: string,
): HTMLElement {
  const input = h("input", { type: "checkbox", checked }) as HTMLInputElement;
  input.addEventListener("change", () => set(input.checked));
  return h(
    "label",
    { class: "toggle" },
    input,
    h("span", { class: "track" }),
    h("span", { class: "label" }, label, detail ? h("small", { text: detail }) : null),
  );
}

function number(
  value: number,
  min: number,
  max: number,
  step: number,
  set: (v: number) => void,
): HTMLInputElement {
  const input = h("input", {
    type: "number",
    class: "field num mono",
    min: String(min),
    max: String(max),
    step: String(step),
    value: String(value),
  }) as HTMLInputElement;
  input.addEventListener("input", () => set(Number(input.value)));
  return input;
}

function text(value: string, set: (v: string) => void): HTMLInputElement {
  const input = h("input", {
    type: "text",
    class: "field mono grow",
    spellcheck: "false",
    value,
  }) as HTMLInputElement;
  input.addEventListener("input", () => set(input.value.trim()));
  return input;
}

function radioCards(
  options: { id: string; label: string; hint: string }[],
  selected: string,
  pick: (id: string) => void,
): HTMLElement {
  return h(
    "div",
    { class: "cards", role: "radiogroup" },
    ...options.map((o) =>
      h(
        "button",
        {
          type: "button",
          class: "radio-card",
          role: "radio",
          "aria-checked": String(o.id === selected),
          onclick: () => pick(o.id),
        },
        h("b", { text: o.label }),
        h("small", { text: o.hint }),
      ),
    ),
  );
}

// ---------------------------------------------------------------------------
// Actions

async function save(): Promise<void> {
  const keys = hotkey;
  if (!draft || !keys) return;
  keys.stop();
  const next: Settings = { ...draft, hotkey: keys.value() };
  message = "Saving…";
  messageKind = "";
  render();
  try {
    await ipc.saveSettings(next);
    message = "Saved";
    messageKind = "ok";
    draft = null;
    hotkey = null;
    await loadSettings();
    await loadStatus();
    render();
  } catch (e) {
    // A rejected hotkey is the common failure and the old one is still registered, so say so
    // rather than leaving the box showing something that is not in force.
    message = ipc.errorText(e);
    messageKind = "err";
    await loadSettings();
    if (data.settings) keys.set(data.settings.hotkey);
    render();
  }
}

async function startLogin(): Promise<void> {
  onLoginStateChanged(null, "Contacting the backend…");
  try {
    const started = await ipc.startLogin();
    onLoginStateChanged(started.code, `If the browser did not open, go to ${started.verify_url}`);
  } catch (e) {
    onLoginStateChanged(null, ipc.errorText(e));
  }
}

async function logOut(): Promise<void> {
  try {
    await ipc.logout();
    onLoginStateChanged(null, "Logged out");
  } catch (e) {
    onLoginStateChanged(null, ipc.errorText(e));
  }
  await loadSettings();
  await loadStatus();
}
