/** Everything the app knows, in one place, with a subscription per topic.
 *
 *  The views are plain functions that redraw from this; nothing renders from an event payload
 *  directly. That keeps a status push, a five second poll and a tab switch on the same path. */

import * as ipc from "./ipc";
import type { Bootstrap, ClipProgress, ClipRow, Settings, Status, StorageStats } from "./types";

export type Topic = "status" | "settings" | "clips" | "storage" | "progress" | "bootstrap";

interface Data {
  status: Status | null;
  settings: Settings | null;
  clips: ClipRow[];
  storage: StorageStats | null;
  /** Live percentages, keyed by clip id. Only clips mid-job are in here. */
  progress: Map<number, ClipProgress>;
  bootstrap: Bootstrap;
  /** Last error from each loader, shown where that data would have been. */
  errors: Partial<Record<Topic, string>>;
}

export const data: Data = {
  status: null,
  settings: null,
  clips: [],
  storage: null,
  progress: new Map(),
  bootstrap: { phase: "ready" },
  errors: {},
};

const listeners = new Map<Topic, Set<() => void>>();

export function on(topic: Topic, fn: () => void): void {
  const set = listeners.get(topic) ?? new Set();
  set.add(fn);
  listeners.set(topic, set);
}

export function emit(topic: Topic): void {
  for (const fn of listeners.get(topic) ?? []) fn();
}

/** Runs `load`, storing either the value or the error text, then notifies. One call at a time
 *  per topic: a burst of clips-changed events must not stack up scans of the clip folder. */
function loader<T>(topic: Topic, load: () => Promise<T>, keep: (value: T) => void) {
  let running = false;
  let again = false;
  const run = async (): Promise<void> => {
    if (running) {
      again = true;
      return;
    }
    running = true;
    try {
      keep(await load());
      delete data.errors[topic];
    } catch (e) {
      data.errors[topic] = ipc.errorText(e);
    } finally {
      running = false;
      emit(topic);
      if (again) {
        again = false;
        void run();
      }
    }
  };
  return run;
}

export const loadStatus = loader("status", ipc.getStatus, (s) => {
  data.status = s;
});

export const loadSettings = loader("settings", ipc.getSettings, (s) => {
  data.settings = s;
});

export const loadClips = loader("clips", ipc.listClips, (c) => {
  data.clips = c;
});

export const loadStorage = loader("storage", ipc.storageStats, (s) => {
  data.storage = s;
});

export const loadProgress = loader("progress", ipc.clipProgress, (list) => {
  data.progress = new Map(list.map((p) => [p.id, p]));
});

export const loadBootstrap = loader("bootstrap", ipc.getBootstrap, (b) => {
  data.bootstrap = b;
});

/** Applies one pushed progress event without a round trip. */
export function applyProgress(p: ClipProgress): void {
  if (p.stage === "idle") data.progress.delete(p.id);
  else data.progress.set(p.id, p);
  emit("progress");
}

export function setBootstrap(b: Bootstrap): void {
  data.bootstrap = b;
  emit("bootstrap");
}
