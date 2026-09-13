/** Settings: four cards, one Save. Developer things sit behind Advanced, because nobody in
 *  the Discord needs a bitrate. */

import { fill, h } from "./dom";
import { onLanguage, t } from "./i18n";
import { hotkeyControl, type HotkeyControl } from "./hotkey";
import * as ipc from "./ipc";
import { renderAvatar } from "./shell";
import { data, loadSettings, loadStatus, on } from "./store";
import type { EncodeEngine, Language, Quality, Settings } from "./types";

/** Measured on a 30 s 1080p60 clip by scripts/bench-encoders.mjs. Quoted in megabytes rather
 *  than bitrate because that is the number people actually feel, in upload time. */
const QUALITIES: Quality[] = ["small", "balanced", "high"];
const ENGINES: EncodeEngine[] = ["cpu", "gpu"];
const LANGUAGES: Language[] = ["es", "en"];

let root: HTMLElement | null = null;
/** The edits in progress. Replaced from the store on mount and after every save. */
let draft: Settings | null = null;
/** What `draft` looked like before any edit, to tell whether the save bar should show. */
let baseline: Settings | null = null;
let hotkey: HotkeyControl | null = null;
/** The save bar, appended to `root` only while there is something to show. */
let saveBar: HTMLElement | null = null;
/** The account card's identity block, kept live so status/login updates can replace just it. */
let accountBlockEl: HTMLElement | null = null;
let message = "";
let messageKind: "" | "ok" | "err" = "";
/** The device login in progress, if any. */
let pendingCode: string | null = null;
let loginNote = "";

export function initSettings(): void {
  on("settings", () => {
    if (root && !draft) render();
  });
  // The account card reads data.status directly. This also fires from the five-second status
  // poll in main.ts, so it must not trigger a full render (that would reset scroll, collapse
  // Advanced, and eat whatever the user is mid-typing elsewhere in the form).
  on("status", () => syncAccountBlock());
  onLanguage(() => {
    if (root) render();
  });
}

export function mountSettings(node: HTMLElement): void {
  root = node;
  draft = null;
  baseline = null;
  hotkey = null;
  saveBar = null;
  accountBlockEl = null;
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
  baseline = null;
  hotkey = null;
  saveBar = null;
  accountBlockEl = null;
}

/** The account block reacts to the login events main.ts forwards. */
export function onLoginStateChanged(code: string | null, note: string): void {
  pendingCode = code;
  loginNote = note;
  if (accountBlockEl) syncAccountBlock();
  else if (root) render();
}

function render(): void {
  if (!root) return;
  if (!draft) {
    if (!data.settings) {
      fill(
        root,
        h("div", { class: "settings" }, h("span", { class: "muted", text: t("settings.loading") })),
      );
      return;
    }
    draft = { ...data.settings };
    baseline = { ...data.settings };
    hotkey = hotkeyControl(draft.hotkey, () => markEdited());
  }
  const s = draft;

  fill(
    root,
    h("div", { class: "settings scroll" }, captureCard(s), behaviourCard(s), encodingCard(s), accountCard(s)),
  );
  saveBar = null;
  syncSaveBar();
}

/** Whether `draft` (plus the hotkey, which lives outside it until save) differs from what was
 *  loaded. Drives whether the save bar shows at all. */
function isDirty(): boolean {
  if (!draft || !baseline || !hotkey) return false;
  return JSON.stringify({ ...draft, hotkey: hotkey.value() }) !== JSON.stringify(baseline);
}

/** Shows, updates or hides the save bar without touching the rest of the form, so typing in a
 *  text field does not lose focus or cursor position on every keystroke. */
function syncSaveBar(): void {
  if (!root || !draft) return;
  if (!isDirty() && !message) {
    saveBar?.remove();
    saveBar = null;
    return;
  }
  if (!saveBar) {
    saveBar = h(
      "div",
      { class: "save-bar" },
      h("button", {
        type: "button",
        class: "btn primary",
        text: t("settings.save"),
        onclick: () => void save(),
      }),
      h("span", { class: "msg" }),
    );
    root.appendChild(saveBar);
  }
  const btn = saveBar.querySelector("button")!;
  btn.textContent = t("settings.save");
  const msg = saveBar.querySelector(".msg")!;
  msg.className = `msg ${messageKind}`;
  msg.textContent = message;
}

/** Marks the draft touched: clears any stale confirmation/error from a previous save and
 *  refreshes the save bar. Called from every field's change handler. */
function markEdited(): void {
  message = "";
  messageKind = "";
  syncSaveBar();
}

function card(title: string, ...children: (Node | string | null | false)[]): HTMLElement {
  return h("div", { class: "setting-card" }, h("h3", { text: title }), ...children);
}

// ---------------------------------------------------------------------------

function captureCard(s: Settings): HTMLElement {
  return card(
    t("settings.capture"),
    hotkey!.node,
    h(
      "div",
      { class: "field-row" },
      h("span", { class: "name", text: t("settings.bufferLength.name") }),
      number(s.buffer_seconds, 5, 300, 1, (v) => (s.buffer_seconds = v)),
      h("span", { class: "hint", text: t("settings.bufferLength.hint") }),
    ),
    h(
      "div",
      { class: "field-row" },
      h("span", { class: "name", text: t("settings.clipFolder") }),
      h("span", { class: "field mono grow", text: s.clip_dir, title: s.clip_dir }),
      h("button", {
        type: "button",
        class: "btn small",
        text: t("settings.browse"),
        onclick: async () => {
          const dir = await ipc.pickClipDir();
          if (dir) {
            s.clip_dir = dir;
            message = "";
            messageKind = "";
            render();
          }
        },
      }),
    ),
    h("span", { class: "note", text: t("settings.captureNote") }),
  );
}

function behaviourCard(s: Settings): HTMLElement {
  return card(
    t("settings.behaviour"),
    languageRow(s),
    toggle(t("settings.startWithWindows"), s.start_with_windows, (v) => (s.start_with_windows = v)),
    toggle(t("settings.notifyOnSave"), s.notify_on_save, (v) => (s.notify_on_save = v)),
    toggle(t("settings.soundOnSave"), s.sound_on_save, (v) => (s.sound_on_save = v)),
    toggle(
      t("settings.encodeWhileGaming.name"),
      s.encode_while_gaming,
      (v) => (s.encode_while_gaming = v),
      t("settings.encodeWhileGaming.detail"),
    ),
    toggle(
      t("settings.recordSessions.name"),
      s.record_sessions,
      (v) => (s.record_sessions = v),
      t("settings.recordSessions.detail"),
    ),
    toggle(
      t("settings.openAfterSession"),
      s.open_after_session,
      (v) => (s.open_after_session = v),
    ),
  );
}

function encodingCard(s: Settings): HTMLElement {
  return card(
    t("settings.encoding"),
    radioCards(
      QUALITIES.map((id) => ({
        id,
        label: t(`settings.quality.${id}.label`),
        hint: t(`settings.quality.${id}.hint`),
      })),
      s.quality,
      (id) => {
        s.quality = id as Quality;
        message = "";
        messageKind = "";
        render();
      },
    ),
    h("span", { class: "note", text: t("settings.sizesNote") }),
    radioCards(
      ENGINES.map((id) => ({
        id,
        label: t(`settings.engine.${id}.label`),
        hint: t(`settings.engine.${id}.hint`),
      })),
      s.encode_engine,
      (id) => {
        s.encode_engine = id as EncodeEngine;
        message = "";
        messageKind = "";
        render();
      },
    ),
    h(
      "details",
      { class: "advanced" },
      h("summary", { text: t("settings.advanced") }),
      h(
        "div",
        { class: "body" },
        h(
          "div",
          { class: "field-row" },
          h("span", { class: "name", text: t("settings.bufferBitrate.name") }),
          number(s.video_bitrate_kbps, 2000, 60000, 500, (v) => (s.video_bitrate_kbps = v)),
          h("span", { class: "hint", text: t("settings.bufferBitrate.hint") }),
        ),
        h(
          "div",
          { class: "field-row" },
          h("span", { class: "name", text: t("settings.backendUrl.name") }),
          text(s.backend_url, (v) => (s.backend_url = v)),
          h("span", { class: "hint", text: t("settings.backendUrl.hint") }),
        ),
        h(
          "div",
          { class: "field-row" },
          h("span", { class: "name", text: t("settings.valorantShard.name") }),
          text(s.valorant_shard, (v) => (s.valorant_shard = v.toLowerCase())),
          h("span", { class: "hint", text: t("settings.valorantShard.hint") }),
        ),
      ),
    ),
  );
}

function languageRow(s: Settings): HTMLElement {
  const select = h(
    "select",
    {
      class: "field",
      onchange: (e: Event) => {
        s.language = (e.target as HTMLSelectElement).value as Language;
        message = "";
        messageKind = "";
        render();
      },
    },
    ...LANGUAGES.map((id) =>
      h("option", { value: id, text: t(`settings.language.${id}`), selected: id === s.language }),
    ),
  ) as HTMLSelectElement;
  select.value = s.language;
  return h(
    "div",
    { class: "field-row" },
    h("span", { class: "name", text: t("settings.language.name") }),
    select,
    h("span", { class: "hint", text: t("settings.language.hint") }),
  );
}

/** The identity + login-state part of the account card, rebuilt on its own by `syncAccountBlock`
 *  so a status poll or a login event never has to re-render the whole form (and cost the user
 *  their cursor position in a text field, or collapse the Advanced disclosure). */
function accountBlock(): HTMLElement {
  const account = data.status?.account ?? draft?.account ?? null;
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
          h("b", { text: t("settings.loggedInAs", { username: account.username }) }),
          h("small", { text: t("settings.viaDiscord") }),
        ),
        h("button", {
          type: "button",
          class: "btn small",
          text: t("settings.logOut"),
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
            t("settings.waitingBrowser"),
          ),
          h("button", {
            type: "button",
            class: "btn small",
            text: t("settings.cancel"),
            onclick: () => void ipc.cancelLogin().then(() => onLoginStateChanged(null, "")),
          }),
        )
      : h(
          "div",
          { class: "account" },
          h(
            "div",
            { class: "who" },
            h("b", { text: t("settings.notLinked") }),
            h("small", { text: t("settings.notLinkedDetail") }),
          ),
          h("button", {
            type: "button",
            class: "btn primary small",
            text: t("settings.linkDiscord"),
            onclick: () => void startLogin(),
          }),
        );

  return h(
    "div",
    { class: "account-block" },
    identity,
    loginNote ? h("span", { class: "note", text: loginNote }) : null,
  );
}

/** Swaps the live account block for a freshly built one. No-op before the card has mounted. */
function syncAccountBlock(): void {
  if (!accountBlockEl) return;
  const fresh = accountBlock();
  accountBlockEl.replaceWith(fresh);
  accountBlockEl = fresh;
}

function accountCard(s: Settings): HTMLElement {
  accountBlockEl = accountBlock();
  return card(
    t("settings.account"),
    accountBlockEl,
    toggle(
      t("settings.autoUpload.name"),
      s.auto_upload,
      (v) => (s.auto_upload = v),
      t("settings.autoUpload.detail"),
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
  input.addEventListener("change", () => {
    set(input.checked);
    markEdited();
  });
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
  input.addEventListener("input", () => {
    set(Number(input.value));
    markEdited();
  });
  return input;
}

function text(value: string, set: (v: string) => void): HTMLInputElement {
  const input = h("input", {
    type: "text",
    class: "field mono grow",
    spellcheck: "false",
    value,
  }) as HTMLInputElement;
  input.addEventListener("input", () => {
    set(input.value.trim());
    markEdited();
  });
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
  message = t("settings.saving");
  messageKind = "";
  render();
  try {
    await ipc.saveSettings(next);
    draft = null;
    hotkey = null;
    await loadSettings();
    await loadStatus();
    // After the reload, so a language that just changed names the confirmation.
    message = t("settings.saved");
    messageKind = "ok";
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
  onLoginStateChanged(null, t("settings.contacting"));
  try {
    const started = await ipc.startLogin();
    onLoginStateChanged(
      started.code,
      t("settings.browserFallback", { url: started.verify_url }),
    );
  } catch (e) {
    onLoginStateChanged(null, ipc.errorText(e));
  }
}

async function logOut(): Promise<void> {
  try {
    await ipc.logout();
    onLoginStateChanged(null, t("settings.loggedOut"));
  } catch (e) {
    onLoginStateChanged(null, ipc.errorText(e));
  }
  await loadSettings();
  await loadStatus();
}
