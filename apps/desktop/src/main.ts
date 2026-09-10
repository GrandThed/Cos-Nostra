import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

interface Status {
  recording: boolean;
  encoder: string | null;
  hotkey: string;
  clip_dir: string;
  buffer_seconds: number;
  error: string | null;
}

const el = (id: string) => document.getElementById(id)!;

async function refresh() {
  const s = await invoke<Status>("get_status");
  el("recording").textContent = s.recording ? "running" : s.error ? "failed" : "starting…";
  el("encoder").textContent = s.encoder ?? "–";
  el("hotkey").textContent = s.hotkey;
  el("seconds").textContent = `${s.buffer_seconds}s`;
  el("dir").textContent = s.clip_dir;
  el("error").textContent = s.error ?? "";
}

el("save").addEventListener("click", async () => {
  try {
    const path = await invoke<string>("save_clip");
    el("last").textContent = `Saved ${path}`;
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
