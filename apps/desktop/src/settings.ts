/** Settings: four cards, one Save. Developer things sit behind Advanced, because nobody in
 *  the Discord needs a bitrate. */

import { fill, h } from "./dom";
import { onLanguage, t } from "./i18n";
import { hotkeyControl, type HotkeyControl } from "./hotkey";
import * as ipc from "./ipc";
import { renderAvatar } from "./shell";
import { data, loadSettings, loadStatus, on } from "./store";
import type { AudioDevice, AudioSource, EncodeEngine, Language, Quality, Settings } from "./types";

/** Measured on a 30 s 1080p60 clip by scripts/bench-encoders.mjs. Quoted in megabytes rather
 *  than bitrate because that is the number people actually feel, in upload time. */
const QUALITIES: Quality[] = ["small", "balanced", "high"];
const ENGINES: EncodeEngine[] = ["cpu", "gpu"];
const LANGUAGES: Language[] = ["es", "en"];
const AUDIO_SOURCES: AudioSource[] = ["system", "game", "game_and_apps"];
/** `settings::MAX_MIC_VOLUME` and `MAX_AUDIO_APPS`. */
const MAX_MIC_VOLUME = 200;
const MAX_AUDIO_APPS = 16;

/** Recording quality presets, as the replay buffer's bitrate. */
const RECORD_QUALITIES: { id: "low" | "medium" | "high" | "ultra"; kbps: number }[] = [
  { id: "low", kbps: 10_000 },
  { id: "medium", kbps: 15_000 },
  { id: "high", kbps: 20_000 },
  { id: "ultra", kbps: 40_000 },
];
const RECORD_HEIGHTS = [0, 1440, 1080, 720];
const RECORD_RATES = [60, 30];
/** The bitrate box under Advanced, which the presets keep in step. */
let bitrateInput: HTMLInputElement | null = null;

/** The microphones and the apps with sound, asked for once per visit to the screen. */
let microphones: AudioDevice[] | null = null;
let audioApps: string[] | null = null;

let root: HTMLElement | null = null;
/** The edits in progress. Replaced from the store on mount and after every save. */
let draft: Settings | null = null;
/** What `draft` looked like before any edit, to tell whether the save bar should show. */
let baseline: Settings | null = null;
let hotkey: HotkeyControl | null = null;
/** The marker hotkey, which writes straight into `draft` as it changes. */
let markerKey: HotkeyControl | null = null;
/** The save bar, appended to `root` only while there is something to show. */
let saveBar: HTMLElement | null = null;
/** The account card's identity block, kept live so status/login updates can replace just it. */
let accountBlockEl: HTMLElement | null = null;
let message = "";
let messageKind: "" | "ok" | "err" = "";
/** A save is in flight: the button stays up, disabled, until it lands. */
let saving = false;
/** Clears the "Saved" confirmation, so the bar goes away on its own after a good save. */
let messageTimer: number | undefined;
const SAVED_MESSAGE_MS = 2500;
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
  // A microphone plugged in since the last visit shows up.
  microphones = null;
  audioApps = null;
  void loadSettings().then(() => {
    if (root) render();
  });
  render();
}

export function unmountSettings(): void {
  hotkey?.stop();
  markerKey?.stop();
  markerKey = null;
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
    const edited = draft;
    markerKey = hotkeyControl(
      edited.marker_hotkey,
      (value) => {
        edited.marker_hotkey = value;
        markEdited();
      },
      { name: t("hotkey.markerName"), note: t("hotkey.markerNote"), optional: true },
    );
  }
  const s = draft;

  // A full render replaces the scrolling panel, which would jump back to the top and fold
  // Advanced away; carry both over. Edits update their own controls and never come here.
  const scrollTop = root.querySelector<HTMLElement>(".settings.scroll")?.scrollTop ?? 0;
  const advancedOpen = root.querySelector<HTMLDetailsElement>("details.advanced")?.open ?? false;
  const panel = h(
    "div",
    { class: "settings scroll" },
    captureCard(s),
    audioCard(s),
    behaviourCard(s),
    encodingCard(s),
    accountCard(),
  );
  fill(root, panel);
  const advanced = panel.querySelector<HTMLDetailsElement>("details.advanced");
  if (advanced) advanced.open = advancedOpen;
  panel.scrollTop = scrollTop;
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
 *  text field does not lose focus or cursor position on every keystroke. The button only shows
 *  while there is something to save; after a save the bar carries just the result. */
function syncSaveBar(): void {
  if (!root || !draft) return;
  const dirty = isDirty();
  if (!dirty && !saving && !message) {
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
  btn.hidden = !dirty && !saving;
  btn.disabled = saving;
  const msg = saveBar.querySelector(".msg")!;
  msg.className = `msg ${messageKind}`;
  msg.textContent = message;
}

/** Marks the draft touched: clears any stale confirmation/error from a previous save and
 *  refreshes the save bar. Called from every field's change handler. */
function markEdited(): void {
  window.clearTimeout(messageTimer);
  message = "";
  messageKind = "";
  syncSaveBar();
}

function card(title: string, ...children: (Node | string | null | false)[]): HTMLElement {
  return h("div", { class: "setting-card" }, h("h3", { text: title }), ...children);
}

// ---------------------------------------------------------------------------

function captureCard(s: Settings): HTMLElement {
  const folder = h("span", { class: "field mono grow", text: s.clip_dir, title: s.clip_dir });
  return card(
    t("settings.capture"),
    hotkey!.node,
    markerKey!.node,
    h(
      "div",
      { class: "field-row" },
      h("span", { class: "name", text: t("settings.bufferLength.name") }),
      number(s.buffer_seconds, 5, 300, 1, (v) => (s.buffer_seconds = v)),
      h("span", { class: "hint", text: t("settings.bufferLength.hint") }),
    ),
    recordingRows(s),
    h(
      "div",
      { class: "field-row" },
      h("span", { class: "name", text: t("settings.clipFolder") }),
      folder,
      h("button", {
        type: "button",
        class: "btn small",
        text: t("settings.browse"),
        onclick: async () => {
          const dir = await ipc.pickClipDir();
          if (dir) {
            s.clip_dir = dir;
            folder.textContent = dir;
            folder.title = dir;
            markEdited();
          }
        },
      }),
    ),
    h("span", { class: "note", text: t("settings.captureNote") }),
  );
}

/** How the recording looks: resolution, frame rate and a quality preset, which is the replay
 *  buffer's bitrate. A bitrate typed under Advanced that no preset has leaves none picked. */
function recordingRows(s: Settings): HTMLElement {
  const select = (values: number[], current: number, name: (v: number) => string, set: (v: number) => void) => {
    const list = values.includes(current) ? values : [...values, current];
    const node = h("select", {
      class: "field",
      onchange: (e: Event) => {
        set(Number((e.target as HTMLSelectElement).value));
        markEdited();
      },
    }) as HTMLSelectElement;
    for (const v of list) node.append(h("option", { value: String(v), text: name(v) }));
    node.value = String(current);
    return node;
  };
  const presets = radioCards(
    RECORD_QUALITIES.map((q) => ({
      id: q.id,
      label: t(`settings.recordQuality.${q.id}`),
      hint: t("settings.recordQuality.mbps", { mbps: q.kbps / 1000 }),
    })),
    RECORD_QUALITIES.find((q) => q.kbps === s.video_bitrate_kbps)?.id ?? "",
    (id) => {
      const kbps = RECORD_QUALITIES.find((q) => q.id === id)?.kbps;
      if (!kbps) return;
      s.video_bitrate_kbps = kbps;
      if (bitrateInput) bitrateInput.value = String(kbps);
      markEdited();
    },
    "wrap four",
  );
  return h(
    "div",
    { class: "stack" },
    h(
      "div",
      { class: "field-row" },
      h("span", { class: "name", text: t("settings.resolution.name") }),
      select(RECORD_HEIGHTS, s.record_height, (v) => (v === 0 ? t("settings.resolution.screen") : `${v}p`), (v) => (s.record_height = v)),
      h("span", { class: "name", text: t("settings.frameRate") }),
      select(RECORD_RATES, s.fps, (v) => `${v} fps`, (v) => (s.fps = v)),
    ),
    h("span", { class: "name", text: t("settings.recordQuality.name") }),
    presets,
    h("span", { class: "note", text: t("settings.recordQuality.note") }),
  );
}

/** What the recording hears: the desktop, the game, or the game and some apps, and the
 *  microphone on a track of its own. */
function audioCard(s: Settings): HTMLElement {
  const apps = h("div", { class: "audio-apps", hidden: s.audio_source !== "game_and_apps" });
  paintApps(apps, s);

  const micBlock = h("div", { class: "mic-block", hidden: !s.mic_enabled });
  paintMic(micBlock, s);

  return card(
    t("settings.audio.title"),
    radioCards(
      AUDIO_SOURCES.map((id) => ({
        id,
        label: t(`settings.audio.source.${id}.label`),
        hint: t(`settings.audio.source.${id}.hint`),
      })),
      s.audio_source,
      (id) => {
        s.audio_source = id as AudioSource;
        apps.hidden = id !== "game_and_apps";
        markEdited();
      },
      "wrap",
    ),
    apps,
    toggle(
      t("settings.audio.mic.name"),
      s.mic_enabled,
      (v) => {
        s.mic_enabled = v;
        micBlock.hidden = !v;
      },
      t("settings.audio.mic.detail"),
    ),
    micBlock,
  );
}

/** The apps recorded next to the game: one chip each, and a box to add another, suggesting the
 *  apps that have sound right now. */
function paintApps(box: HTMLElement, s: Settings): void {
  const chips = s.audio_apps.map((app) =>
    h(
      "span",
      { class: "chip app" },
      app,
      h("button", {
        type: "button",
        class: "remove",
        text: "✕",
        title: t("settings.audio.apps.remove", { app }),
        onclick: () => {
          s.audio_apps = s.audio_apps.filter((a) => a !== app);
          paintApps(box, s);
          markEdited();
        },
      }),
    ),
  );
  const suggestions = (audioApps ?? []).filter((a) => !s.audio_apps.some((have) => have.toLowerCase() === a.toLowerCase()));
  const input = h("input", {
    type: "text",
    class: "field mono grow",
    list: "audio-app-suggestions",
    placeholder: t("settings.audio.apps.placeholder"),
    spellcheck: "false",
  }) as HTMLInputElement;
  const warn = h("span", { class: "hint warn" });
  const add = () => {
    let name = input.value.trim();
    if (!name) return;
    if (!/\.exe$/i.test(name)) name = `${name}.exe`;
    if (/[\\/:#"]/.test(name) || name.length <= 4) {
      warn.textContent = t("settings.audio.apps.invalid");
      return;
    }
    if (s.audio_apps.length >= MAX_AUDIO_APPS) {
      warn.textContent = t("settings.audio.apps.tooMany", { n: MAX_AUDIO_APPS });
      return;
    }
    if (!s.audio_apps.some((a) => a.toLowerCase() === name.toLowerCase())) s.audio_apps = [...s.audio_apps, name];
    paintApps(box, s);
    markEdited();
    box.querySelector<HTMLInputElement>("input")?.focus();
  };
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      add();
    }
  });
  fill(
    box,
    h("span", { class: "note", text: t("settings.audio.apps.note") }),
    chips.length ? h("div", { class: "chips" }, ...chips) : h("span", { class: "note", text: t("settings.audio.apps.none") }),
    h(
      "div",
      { class: "field-row" },
      input,
      h("datalist", { id: "audio-app-suggestions" }, ...suggestions.map((a) => h("option", { value: a }))),
      h("button", { type: "button", class: "btn small", text: t("settings.audio.apps.add"), onclick: add }),
      warn,
    ),
  );
  if (audioApps === null) {
    audioApps = [];
    void ipc
      .listAudioApps()
      .then((list) => {
        audioApps = list;
        // Only the suggestions change; the box keeps whatever is being typed.
        const datalist = box.querySelector("datalist");
        if (datalist && box.isConnected) {
          fill(
            datalist,
            ...list
              .filter((a) => !s.audio_apps.some((have) => have.toLowerCase() === a.toLowerCase()))
              .map((a) => h("option", { value: a })),
          );
        }
      })
      .catch((e) => console.warn("audio apps", e));
  }
}

function paintMic(box: HTMLElement, s: Settings): void {
  const select = h("select", {
    class: "field grow",
    onchange: (e: Event) => {
      s.mic_device = (e.target as HTMLSelectElement).value;
      markEdited();
    },
  }) as HTMLSelectElement;
  const options = () => {
    const list = microphones ?? [];
    const known = s.mic_device === "default" || list.some((d) => d.id === s.mic_device);
    fill(
      select,
      h("option", { value: "default", text: t("settings.audio.mic.default") }),
      ...list.map((d) => h("option", { value: d.id, text: d.name })),
      // A microphone that is unplugged right now stays chosen, and says so.
      known ? null : h("option", { value: s.mic_device, text: t("settings.audio.mic.missing") }),
    );
    select.value = s.mic_device;
  };
  options();
  if (microphones === null) {
    microphones = [];
    void ipc
      .listMicrophones()
      .then((list) => {
        microphones = list;
        if (select.isConnected) options();
      })
      .catch((e) => console.warn("microphones", e));
  }
  fill(
    box,
    h("div", { class: "field-row" }, h("span", { class: "name", text: t("settings.audio.mic.device") }), select),
    h(
      "div",
      { class: "field-row" },
      h("span", { class: "name", text: t("settings.audio.mic.volume") }),
      number(s.mic_volume, 0, MAX_MIC_VOLUME, 5, (v) => (s.mic_volume = v)),
      h("span", { class: "hint", text: t("settings.audio.mic.volumeHint") }),
    ),
    toggle(
      t("settings.audio.mic.noise.name"),
      s.mic_noise_suppression,
      (v) => (s.mic_noise_suppression = v),
      t("settings.audio.mic.noise.detail"),
    ),
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
    otherGamesRows(s),
    toggle(
      t("settings.openAfterSession"),
      s.open_after_session,
      (v) => (s.open_after_session = v),
    ),
  );
}

/** The background recording of every other game: the switch, and how much of it to keep. */
function otherGamesRows(s: Settings): HTMLElement {
  const hours = h(
    "div",
    { class: "field-row indent", hidden: !s.record_other_games },
    h("span", { class: "name", text: t("settings.otherGames.keep") }),
    number(s.other_games_hours, 1, 48, 1, (v) => (s.other_games_hours = v)),
    h("span", { class: "hint", text: t("settings.otherGames.keepHint") }),
  );
  return h(
    "div",
    { class: "stack" },
    toggle(
      t("settings.otherGames.name"),
      s.record_other_games,
      (v) => {
        s.record_other_games = v;
        hours.hidden = !v;
      },
      t("settings.otherGames.detail"),
    ),
    hours,
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
        markEdited();
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
        markEdited();
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
          (bitrateInput = number(s.video_bitrate_kbps, 2000, 60000, 500, (v) => (s.video_bitrate_kbps = v))),
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
      // The form switches language once the save lands (onLanguage re-renders it), not on pick.
      onchange: (e: Event) => {
        s.language = (e.target as HTMLSelectElement).value as Language;
        markEdited();
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

function accountCard(): HTMLElement {
  accountBlockEl = accountBlock();
  // There is no upload switch any more: a clip goes up when, and only when, someone presses
  // Publish on it. The note says so where the switch used to be, for anyone looking for it.
  return card(t("settings.account"), accountBlockEl, h("span", { class: "note", text: t("settings.publishNote") }));
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
  extraClass = "",
): HTMLElement {
  // Picking marks the cards in place rather than re-rendering the form.
  const group = h("div", { class: `cards ${extraClass}`.trim(), role: "radiogroup" });
  for (const o of options) {
    const card = h(
      "button",
      {
        type: "button",
        class: "radio-card",
        role: "radio",
        "aria-checked": String(o.id === selected),
        onclick: () => {
          for (const other of group.children) other.setAttribute("aria-checked", String(other === card));
          pick(o.id);
        },
      },
      h("b", { text: o.label }),
      h("small", { text: o.hint }),
    );
    group.appendChild(card);
  }
  return group;
}

// ---------------------------------------------------------------------------
// Actions

async function save(): Promise<void> {
  const keys = hotkey;
  if (!draft || !keys || saving) return;
  keys.stop();
  markerKey?.stop();
  const next: Settings = { ...draft, hotkey: keys.value() };
  window.clearTimeout(messageTimer);
  saving = true;
  message = t("settings.saving");
  messageKind = "";
  syncSaveBar();
  try {
    await ipc.saveSettings(next);
    saving = false;
    draft = null;
    hotkey = null;
    markerKey = null;
    await loadSettings();
    await loadStatus();
    // After the reload, so a language that just changed names the confirmation. Nothing is
    // left to save, so the bar shows only this and then goes away.
    message = t("settings.saved");
    messageKind = "ok";
    render();
    messageTimer = window.setTimeout(() => {
      if (messageKind !== "ok") return;
      message = "";
      messageKind = "";
      syncSaveBar();
    }, SAVED_MESSAGE_MS);
  } catch (e) {
    saving = false;
    // A rejected hotkey is the common failure and the old one is still registered, so say so
    // rather than leaving the box showing something that is not in force.
    message = saveError(ipc.errorText(e));
    messageKind = "err";
    await loadSettings();
    if (data.settings) {
      keys.set(data.settings.hotkey);
      markerKey?.set(data.settings.marker_hotkey);
      if (draft) draft.marker_hotkey = data.settings.marker_hotkey;
    }
    render();
  }
}

/** `save_settings` wraps a hotkey the OS would not register as `registering hotkey "Alt+F10": …`
 *  (`lib.rs`), in English and with the plugin's own wording after it. That is the failure people
 *  actually meet, so it gets a sentence of its own; anything else is shown as it came. */
function saveError(text: string): string {
  const hotkey = /^registering (?:marker )?hotkey "([^"]+)"/.exec(text)?.[1];
  if (hotkey) return t("settings.hotkeyRejected", { hotkey });
  if (text.startsWith("the marker hotkey must differ")) return t("settings.markerSameAsSave");
  return text;
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
