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
}

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
}

const el = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const input = (id: string) => el<HTMLInputElement>(id);

// ---------------------------------------------------------------------------
// Tabs

function showTab(name: "status" | "settings") {
  for (const t of ["status", "settings"] as const) {
    el(`panel-${t}`).hidden = t !== name;
    el(`tab-${t}`).setAttribute("aria-selected", String(t === name));
  }
  if (name === "settings") void loadSettings();
}
el("tab-status").addEventListener("click", () => showTab("status"));
el("tab-settings").addEventListener("click", () => showTab("settings"));

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
  el("hotkey").textContent = s.hotkey;
  el("seconds").textContent = `${s.buffer_seconds}s`;
  el("dir").textContent = s.clip_dir;
  el("conflict").textContent = s.conflict
    ? `${s.conflict.executable} is already captured by another tool (OBS, Discord, GeForce Experience...). Close it or clips will be black.`
    : "";
  const errors = [s.error, s.hotkey_error].filter((x): x is string => !!x);
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
  setMsg("");
}

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
