import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

interface HookedGame {
  title: string;
  class: string;
  executable: string;
}

interface CaptureConflict {
  executable: string;
  title: string;
}

interface Encoders {
  av1: string;
  h264: string;
}

interface Account {
  discord_id: string;
  username: string;
  avatar: string | null;
}

interface Status {
  recording: boolean;
  encoder: string | null;
  hotkey: string;
  clip_dir: string;
  buffer_seconds: number;
  error: string | null;
  hotkey_error: string | null;
  hooked_game: HookedGame | null;
  conflict: CaptureConflict | null;
  encoders: Encoders | null;
  ffmpeg_error: string | null;
  account: Account | null;
  auto_upload: boolean;
}

type Quality = "small" | "balanced" | "high";
type EncodeEngine = "cpu" | "gpu";

/** Measured sizes for a 30 s 1080p60 clip, from scripts/bench-encoders.mjs. "typical" is
 *  ordinary gameplay, "up to" is the high-motion worst case where the ceiling engages.
 *  Quoted in megabytes rather than bitrate because that is the number people actually feel,
 *  in upload time and in what the bucket costs. */
const QUALITY_HINT: Record<Quality, string> = {
  small: "~3 MB typical, up to 17 MB",
  balanced: "~6 MB typical, up to 26 MB",
  high: "~8 MB typical, up to 42 MB",
};

const ENGINE_HINT: Record<EncodeEngine, string> = {
  cpu: "smaller and better; about a minute a clip",
  gpu: "seconds, but bigger files and no size ceiling",
};

interface Settings {
  hotkey: string;
  buffer_seconds: number;
  buffer_max_mb: number;
  video_bitrate_kbps: number;
  fps: number;
  clip_dir: string;
  start_with_windows: boolean;
  notify_on_save: boolean;
  sound_on_save: boolean;
  encoders: Encoders | null;
  encode_while_gaming: boolean;
  quality: Quality;
  encode_engine: EncodeEngine;
  backend_url: string;
  device_token: string | null;
  account: Account | null;
  auto_upload: boolean;
}

interface LoginStarted {
  code: string;
  verify_url: string;
}

type ClipStatus = "saved" | "encoding" | "encoded" | "uploading" | "done" | "failed";
type Stage = "encode" | "upload";

interface ClipRow {
  id: number;
  source_path: string;
  game: string | null;
  title: string | null;
  recorded_at: string;
  duration_ms: number;
  width: number;
  height: number;
  size_source: number;
  size_av1: number | null;
  size_h264: number | null;
  av1_path: string | null;
  h264_path: string | null;
  thumb_path: string | null;
  status: ClipStatus;
  error: string | null;
  attempts: number;
  stage: Stage;
  remote_id: string | null;
  page_url: string | null;
}

const el = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const input = (id: string) => el<HTMLInputElement>(id);
const select = (id: string) => el<HTMLSelectElement>(id);

/** Keeps the grey text next to the two encode pickers in step with what is selected. */
function syncEncodeHints(): void {
  const quality = select("quality").value as Quality;
  const engine = select("encode_engine").value as EncodeEngine;
  el("quality_hint").textContent = QUALITY_HINT[quality] ?? "";
  el("encode_engine_hint").textContent = ENGINE_HINT[engine] ?? "";
}

// ---------------------------------------------------------------------------
// Tabs

type Tab = "status" | "clips" | "settings";
const TABS: readonly Tab[] = ["status", "clips", "settings"];
let activeTab: Tab = "status";

function showTab(name: Tab) {
  activeTab = name;
  for (const t of TABS) {
    el(`panel-${t}`).hidden = t !== name;
    el(`tab-${t}`).setAttribute("aria-selected", String(t === name));
  }
  if (name === "settings") void loadSettings();
  if (name === "clips") void loadClips();
}
for (const t of TABS) el(`tab-${t}`).addEventListener("click", () => showTab(t));

// ---------------------------------------------------------------------------
// Status panel

async function refresh() {
  let s: Status;
  try {
    s = await invoke<Status>("get_status");
  } catch (e) {
    el("error").textContent = String(e);
    return;
  }
  el("recording").textContent = s.recording ? "running" : s.error ? "failed" : "starting…";
  el("game").textContent = !s.recording
    ? "–"
    : s.hooked_game
      ? `Recording: ${s.hooked_game.title || s.hooked_game.executable}`
      : "No game hooked, recording the desktop";
  el("encoder").textContent = s.encoder ?? "–";
  el("encoders").textContent = s.ffmpeg_error
    ? "unavailable"
    : s.encoders
      ? `${s.encoders.av1} / ${s.encoders.h264}`
      : "probing…";
  el("hotkey").textContent = s.hotkey;
  el("seconds").textContent = `${s.buffer_seconds}s`;
  el("dir").textContent = s.clip_dir;
  el("account").textContent = s.account
    ? `${s.account.username}${s.auto_upload ? "" : " (uploads off)"}`
    : "not linked";
  el("conflict").textContent = s.conflict
    ? `${s.conflict.executable} is already captured by another tool (OBS, Discord, GeForce Experience...). Close it or clips will be black.`
    : "";
  const errors = [s.error, s.hotkey_error, s.ffmpeg_error && `ffmpeg: ${s.ffmpeg_error}`].filter(
    (x): x is string => !!x,
  );
  el("error").textContent = errors.join("\n");
  el("retry").hidden = !s.error;
}

el("save").addEventListener("click", async () => {
  try {
    const path = await invoke<string>("save_clip");
    el("last").textContent = `Saved ${path}`;
  } catch (e) {
    el("last").textContent = `Save failed: ${String(e)}`;
  }
});

el("retry").addEventListener("click", async () => {
  el("recording").textContent = "starting…";
  el("retry").hidden = true;
  try {
    await invoke("retry_recorder");
  } catch (e) {
    el("error").textContent = String(e);
  }
});

listen<{ path: string }>("clip-saved", (e) => {
  el("last").textContent = `Saved ${e.payload.path}`;
});
listen("status-changed", refresh);

refresh();
setInterval(refresh, 5000);

// ---------------------------------------------------------------------------
// Settings panel

let current: Settings | null = null;
let pendingHotkey = "";

function setMsg(text: string, kind: "ok" | "err" | "" = "") {
  const m = el("settings_msg");
  m.textContent = text;
  m.className = kind ? `hint ${kind}` : "hint";
}

async function loadSettings() {
  try {
    current = await invoke<Settings>("get_settings");
  } catch (e) {
    setMsg(String(e), "err");
    return;
  }
  pendingHotkey = current.hotkey;
  el("hotkey_display").textContent = current.hotkey;
  input("buffer_seconds").value = String(current.buffer_seconds);
  input("video_bitrate_kbps").value = String(current.video_bitrate_kbps);
  input("clip_dir").value = current.clip_dir;
  input("start_with_windows").checked = current.start_with_windows;
  input("notify_on_save").checked = current.notify_on_save;
  input("sound_on_save").checked = current.sound_on_save;
  input("encode_while_gaming").checked = current.encode_while_gaming;
  select("quality").value = current.quality;
  select("encode_engine").value = current.encode_engine;
  syncEncodeHints();
  input("backend_url").value = current.backend_url;
  input("auto_upload").checked = current.auto_upload;
  renderAccount(current.account);
  setMsg("");
}

// ---------------------------------------------------------------------------
// Account block

/** Code of the device login in progress, or null. */
let loginPending: string | null = null;

function setLoginMsg(text: string, kind: "ok" | "err" | "" = "") {
  const m = el("login_msg");
  m.textContent = text;
  m.className = kind ? `full hint ${kind}` : "full hint";
}

function renderAccount(account: Account | null) {
  el("account_logged_out").hidden = !!account || loginPending !== null;
  el("account_pending").hidden = !!account || loginPending === null;
  el("account_logged_in").hidden = !account;
  el("account_name").textContent = account ? `Logged in as ${account.username}` : "";
  el("login_code").textContent = loginPending ?? "–";
}

el("login").addEventListener("click", async () => {
  const btn = el<HTMLButtonElement>("login");
  btn.disabled = true;
  setLoginMsg("Contacting the backend…");
  try {
    const started = await invoke<LoginStarted>("start_login");
    loginPending = started.code;
    setLoginMsg(`If the browser did not open, go to ${started.verify_url}`);
    renderAccount(null);
  } catch (e) {
    setLoginMsg(String(e), "err");
  } finally {
    btn.disabled = false;
  }
});

el("login_cancel").addEventListener("click", async () => {
  loginPending = null;
  setLoginMsg("");
  try {
    await invoke("cancel_login");
  } catch (e) {
    setLoginMsg(String(e), "err");
  }
  renderAccount(current?.account ?? null);
});

el("logout").addEventListener("click", async () => {
  const btn = el<HTMLButtonElement>("logout");
  btn.disabled = true;
  try {
    await invoke("logout");
    setLoginMsg("Logged out", "ok");
  } catch (e) {
    setLoginMsg(String(e), "err");
  } finally {
    btn.disabled = false;
  }
});

listen<Account | null>("account-changed", (e) => {
  loginPending = null;
  if (current) current.account = e.payload;
  if (e.payload) setLoginMsg(`Logged in as ${e.payload.username}`, "ok");
  renderAccount(e.payload);
  void refresh();
});

listen<string>("login-failed", (e) => {
  loginPending = null;
  setLoginMsg(e.payload, "err");
  renderAccount(current?.account ?? null);
});

// Hotkey capture. Builds a Tauri shortcut string such as "Alt+F10" or "Ctrl+Shift+F9" from
// KeyboardEvent.code, which the global-hotkey parser accepts verbatim (KeyA, Digit1, F10...).
const MODIFIER_CODES = new Set([
  "ControlLeft", "ControlRight", "ShiftLeft", "ShiftRight",
  "AltLeft", "AltRight", "MetaLeft", "MetaRight",
]);

function prettyKey(code: string): string {
  if (code.startsWith("Key") && code.length === 4) return code.slice(3);
  if (code.startsWith("Digit") && code.length === 6) return code.slice(5);
  return code;
}

function codeFromKey(key: string): string {
  if (/^F([1-9]|1[0-9]|2[0-4])$/.test(key)) return key;
  if (/^[a-zA-Z]$/.test(key)) return `Key${key.toUpperCase()}`;
  if (/^[0-9]$/.test(key)) return `Digit${key}`;
  return "";
}

function modifierPrefix(e: KeyboardEvent): string[] {
  const mods: string[] = [];
  if (e.ctrlKey) mods.push("Ctrl");
  if (e.altKey) mods.push("Alt");
  if (e.shiftKey) mods.push("Shift");
  if (e.metaKey) mods.push("Super");
  return mods;
}

let capturing = false;

function stopCapture(restoreTo: string) {
  capturing = false;
  window.removeEventListener("keydown", onCaptureKey, true);
  el("hotkey_display").textContent = restoreTo;
  el("hotkey_bind").textContent = "Press keys";
}

function onCaptureKey(e: KeyboardEvent) {
  e.preventDefault();
  e.stopPropagation();
  if (e.code === "Escape") {
    stopCapture(pendingHotkey);
    setMsg("Hotkey change cancelled");
    return;
  }
  const mods = modifierPrefix(e);
  // Injected input (SendKeys, some remote tools) arrives with an empty `code`; derive it from
  // `key` in that case, and treat a key we cannot name like a bare modifier press.
  const code = e.code || codeFromKey(e.key);
  if (!code || MODIFIER_CODES.has(code) || ["Control", "Shift", "Alt", "Meta"].includes(e.key)) {
    el("hotkey_display").textContent = mods.length ? `${mods.join("+")}+…` : "…";
    return;
  }
  const isFKey = /^F([1-9]|1[0-9]|2[0-4])$/.test(code);
  if (!mods.length && !isFKey) {
    el("hotkey_display").textContent = "…";
    setMsg("Add a modifier (Ctrl, Alt, Shift) or use an F-key", "err");
    return;
  }
  pendingHotkey = [...mods, prettyKey(code)].join("+");
  stopCapture(pendingHotkey);
  setMsg("");
}

for (const id of ["quality", "encode_engine"]) {
  select(id).addEventListener("change", syncEncodeHints);
}

el("hotkey_bind").addEventListener("click", () => {
  if (capturing) {
    stopCapture(pendingHotkey);
    return;
  }
  capturing = true;
  el("hotkey_display").textContent = "…";
  el("hotkey_bind").textContent = "Cancel";
  window.addEventListener("keydown", onCaptureKey, true);
});

el("pick_dir").addEventListener("click", async () => {
  try {
    const dir = await invoke<string | null>("pick_clip_dir");
    if (dir) input("clip_dir").value = dir;
  } catch (e) {
    setMsg(String(e), "err");
  }
});

el<HTMLFormElement>("settings-form").addEventListener("submit", async (ev) => {
  ev.preventDefault();
  if (!current) return;
  if (capturing) stopCapture(pendingHotkey);
  const next: Settings = {
    ...current,
    hotkey: pendingHotkey,
    buffer_seconds: Number(input("buffer_seconds").value),
    video_bitrate_kbps: Number(input("video_bitrate_kbps").value),
    clip_dir: input("clip_dir").value,
    start_with_windows: input("start_with_windows").checked,
    notify_on_save: input("notify_on_save").checked,
    sound_on_save: input("sound_on_save").checked,
    encode_while_gaming: input("encode_while_gaming").checked,
    quality: select("quality").value as Quality,
    encode_engine: select("encode_engine").value as EncodeEngine,
    backend_url: input("backend_url").value.trim(),
    auto_upload: input("auto_upload").checked,
  };
  const btn = el<HTMLButtonElement>("settings_save");
  btn.disabled = true;
  setMsg("Saving…");
  try {
    await invoke("save_settings", { settings: next });
    setMsg("Saved", "ok");
    await loadSettings();
    await refresh();
  } catch (e) {
    setMsg(String(e), "err");
    // Settings may have been partially applied (e.g. autostart failure after persisting).
    void refresh();
  } finally {
    btn.disabled = false;
  }
});

// ---------------------------------------------------------------------------
// Clips panel

/** Thumbnails already fetched, keyed by clip id. Cleared when a clip's thumb path changes. */
const thumbCache = new Map<number, { path: string; url: string | null }>();
/** Clip id whose Delete button is waiting for its confirming second click. */
let pendingDelete: number | null = null;
let clipsLoading = false;
let clipsDirty = false;

function fmtBytes(n: number | null): string {
  if (n === null || n < 0) return "–";
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

function fmtDuration(ms: number): string {
  const s = Math.round(ms / 1000);
  const m = Math.floor(s / 60);
  return m ? `${m}:${String(s % 60).padStart(2, "0")}` : `${s}s`;
}

function fmtDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString(undefined, {
    month: "short", day: "numeric", hour: "2-digit", minute: "2-digit",
  });
}

function badgeText(c: ClipRow): string {
  switch (c.status) {
    case "saved": return c.attempts > 0 ? "retrying" : "saved";
    case "encoding": return "encoding";
    case "encoded": return "encoded";
    case "uploading": return "uploading";
    case "done": return "done";
    case "failed": return c.stage === "upload" ? "upload failed" : "failed";
  }
}

function setClipsError(text: string) {
  el("clips_error").textContent = text;
}

async function loadClips() {
  if (clipsLoading) {
    clipsDirty = true;
    return;
  }
  clipsLoading = true;
  try {
    let clips: ClipRow[];
    try {
      clips = await invoke<ClipRow[]>("list_clips");
    } catch (e) {
      setClipsError(String(e));
      return;
    }
    setClipsError("");
    renderClips(clips);
  } finally {
    clipsLoading = false;
    if (clipsDirty) {
      clipsDirty = false;
      void loadClips();
    }
  }
}

function renderClips(clips: ClipRow[]) {
  const list = el("clips");
  list.replaceChildren(...clips.map(renderClip));
  el("clips_empty").hidden = clips.length > 0;
  if (pendingDelete !== null && !clips.some((c) => c.id === pendingDelete)) pendingDelete = null;
  for (const id of thumbCache.keys()) {
    if (!clips.some((c) => c.id === id)) thumbCache.delete(id);
  }
}

function renderClip(c: ClipRow): HTMLElement {
  const row = document.createElement("div");
  row.className = "clip";
  row.dataset.id = String(c.id);

  const img = document.createElement("img");
  img.className = "thumb";
  img.alt = "";
  row.append(img);
  void loadThumb(c, img);

  const meta = document.createElement("div");
  meta.className = "meta";

  const top = document.createElement("div");
  top.className = "top";
  const game = document.createElement("span");
  game.className = "game";
  game.textContent = c.game ?? "";
  game.title = c.title ? `${c.title}\nClick to edit` : "Click to edit";
  game.addEventListener("click", () => editGame(c, game));
  const badge = document.createElement("span");
  badge.className = `badge ${c.status}`;
  badge.textContent = badgeText(c);
  if (c.status === "failed" && c.error) badge.title = c.error;
  else if (c.status === "saved" && c.attempts > 0 && c.error) badge.title = `Attempt ${c.attempts} failed: ${c.error}`;
  top.append(game, badge);

  const detail = document.createElement("div");
  detail.className = "detail";
  const sizes = c.size_av1 !== null
    ? `${fmtBytes(c.size_source)} → ${fmtBytes(c.size_av1)}`
    : fmtBytes(c.size_source);
  detail.textContent = `${fmtDate(c.recorded_at)} · ${fmtDuration(c.duration_ms)} · ${sizes}`;

  const buttons = document.createElement("div");
  buttons.className = "buttons";
  const open = document.createElement("button");
  open.type = "button";
  open.textContent = "Open folder";
  open.addEventListener("click", () => run(invoke("open_clip_folder", { id: c.id })));
  buttons.append(open);
  if (c.status === "done" && c.page_url) {
    const url = c.page_url;
    const copy = document.createElement("button");
    copy.type = "button";
    copy.textContent = "Copy link";
    copy.addEventListener("click", async () => {
      try {
        await navigator.clipboard.writeText(url);
        copy.textContent = "Copied";
        setTimeout(() => { copy.textContent = "Copy link"; }, 1500);
      } catch (e) {
        setClipsError(`Could not copy: ${String(e)}`);
      }
    });
    buttons.append(copy);
  }
  if (c.status === "failed") {
    const retry = document.createElement("button");
    retry.type = "button";
    retry.textContent = "Retry";
    retry.addEventListener("click", () => run(invoke("retry_clip", { id: c.id })));
    buttons.append(retry);
  }
  const del = document.createElement("button");
  del.type = "button";
  del.textContent = pendingDelete === c.id ? "Confirm delete" : "Delete";
  del.addEventListener("click", () => {
    if (pendingDelete !== c.id) {
      pendingDelete = c.id;
      del.textContent = "Confirm delete";
      return;
    }
    pendingDelete = null;
    del.disabled = true;
    run(invoke("delete_clip", { id: c.id }));
  });
  buttons.append(del);

  meta.append(top, detail);
  if (c.status === "done" && c.page_url) {
    const link = document.createElement("div");
    link.className = "link";
    link.textContent = c.page_url;
    link.title = c.page_url;
    meta.append(link);
  }
  meta.append(buttons);
  row.append(meta);
  return row;
}

/** Runs a clip command, surfacing its error in the banner. The list refreshes via clips-changed. */
function run(p: Promise<unknown>) {
  p.then(() => setClipsError("")).catch((e) => setClipsError(String(e)));
}

async function loadThumb(c: ClipRow, img: HTMLImageElement) {
  if (!c.thumb_path) return;
  const cached = thumbCache.get(c.id);
  if (cached && cached.path === c.thumb_path) {
    if (cached.url) img.src = cached.url;
    return;
  }
  try {
    const url = await invoke<string | null>("get_thumbnail", { id: c.id });
    thumbCache.set(c.id, { path: c.thumb_path, url });
    if (url && img.isConnected) img.src = url;
  } catch (e) {
    console.warn("thumbnail", c.id, e);
  }
}

function editGame(c: ClipRow, span: HTMLSpanElement) {
  const box = document.createElement("input");
  box.type = "text";
  box.className = "game-edit";
  box.value = c.game ?? "";
  box.placeholder = "Game name";
  let finished = false;
  const finish = (save: boolean) => {
    if (finished) return;
    finished = true;
    const value = box.value.trim();
    box.replaceWith(span);
    if (save && value !== (c.game ?? "")) {
      span.textContent = value;
      run(invoke("set_clip_game", { id: c.id, game: value || null }));
    }
  };
  box.addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); finish(true); }
    if (e.key === "Escape") { e.preventDefault(); finish(false); }
  });
  box.addEventListener("blur", () => finish(true));
  span.replaceWith(box);
  box.focus();
  box.select();
}

listen<{ id: number | null }>("clips-changed", () => {
  if (activeTab === "clips") void loadClips();
});
