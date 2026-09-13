/** App self-update through `tauri-plugin-updater`. The endpoint and signing key are
 *  `src-tauri/tauri.conf.json`'s `plugins.updater`; only a release built and signed by
 *  `.github/workflows/desktop-release.yml` verifies against that key, so a compromised or
 *  spoofed GitHub release cannot install itself here.
 *
 *  `shell.ts` reads `updateState` to draw the banner; nothing else needs to know this module
 *  exists. */

import { relaunch } from "@tauri-apps/plugin-process";
import { check, type Update } from "@tauri-apps/plugin-updater";
import { emit } from "./store";

export type UpdateState =
  | { phase: "idle" | "checking" }
  | { phase: "available"; version: string }
  | { phase: "downloading"; version: string; percent: number }
  | { phase: "ready"; version: string }
  | { phase: "error"; message: string };

export let updateState: UpdateState = { phase: "idle" };

/** The `Update` handle `check()` returned, held so `installUpdate` has something to call.
 *  Cleared once installed since a `relaunch` is coming and nothing will read it again. */
let pending: Update | null = null;

function setState(next: UpdateState): void {
  updateState = next;
  emit("update");
}

/** Asks GitHub for `latest.json` and compares it against the running version. Safe to call
 *  often: a check already in flight or a download already running is left alone. */
export async function checkForUpdate(): Promise<void> {
  if (updateState.phase === "checking" || updateState.phase === "downloading") return;
  setState({ phase: "checking" });
  try {
    const update = await check();
    if (update) {
      pending = update;
      setState({ phase: "available", version: update.version });
    } else {
      setState({ phase: "idle" });
    }
  } catch (e) {
    setState({ phase: "error", message: e instanceof Error ? e.message : String(e) });
  }
}

/** Downloads and installs the update `checkForUpdate` already found. The new build only takes
 *  effect after `restartToUpdate`, same as the OBS runtime bootstrap's own restart. */
export async function installUpdate(): Promise<void> {
  const update = pending;
  if (!update) return;
  setState({ phase: "downloading", version: update.version, percent: 0 });
  let total = 0;
  let downloaded = 0;
  try {
    await update.downloadAndInstall((event) => {
      if (event.event === "Started") {
        total = event.data.contentLength ?? 0;
      } else if (event.event === "Progress") {
        downloaded += event.data.chunkLength;
        const percent = total ? Math.min(100, Math.round((downloaded / total) * 100)) : 0;
        setState({ phase: "downloading", version: update.version, percent });
      }
    });
    pending = null;
    setState({ phase: "ready", version: update.version });
  } catch (e) {
    setState({ phase: "error", message: e instanceof Error ? e.message : String(e) });
  }
}

export async function restartToUpdate(): Promise<void> {
  await relaunch();
}

const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;

/** Checks once at startup and every six hours after, for an app that is usually left running in
 *  the tray for days. Skipped in `tauri dev`, where there is no installed build to update into
 *  and `relaunch` would just restart the dev process. */
export function initUpdater(): void {
  if (import.meta.env.DEV) return;
  void checkForUpdate();
  window.setInterval(() => void checkForUpdate(), CHECK_INTERVAL_MS);
}
