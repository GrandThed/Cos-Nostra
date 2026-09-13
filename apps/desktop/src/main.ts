/** Wiring: mount the shell, route between the six screens, and keep the store fed from the
 *  five second poll and the events Rust pushes. */

import "./styles/index.css";

import { listen } from "@tauri-apps/api/event";
import { el } from "./dom";
import { mountEditor, unmountEditor } from "./editor";
import { initFirstRun, loginFailed, syncFirstRun } from "./firstrun";
import { t } from "./i18n";
import { initLibrary, mountLibrary, unmountLibrary } from "./library";
import { initMatches, mountMatches, unmountMatches } from "./matches";
import { initPlayer, mountPlayer, unmountPlayer } from "./player";
import { activeTab, current, go, onRoute, type Route, type Tab } from "./router";
import { initSettings, mountSettings, onLoginStateChanged, unmountSettings } from "./settings";
import { initShell, noteClipSaved, renderBanners, renderToolbar } from "./shell";
import { initStorage, mountStorage, unmountStorage } from "./storage";
import {
  applyProgress,
  data,
  loadBootstrap,
  loadClips,
  loadProgress,
  loadSessions,
  loadSettings,
  loadStatus,
  loadStorage,
  setBootstrap,
} from "./store";
import type { Account, Bootstrap, ClipProgress } from "./types";

const TABS: Tab[] = ["library", "matches", "storage", "settings"];

initShell();
initLibrary();
initPlayer();
initMatches();
initStorage();
initSettings();
initFirstRun();

for (const tab of TABS) {
  el(`tab-${tab}`).addEventListener("click", () => go({ view: tab }));
}

let mounted: Route | null = null;

onRoute(mount);

function mount(route: Route): void {
  // Leaving a screen is its chance to stop a video, forget a draft, drop a listener.
  if (mounted) {
    if (mounted.view === "library") unmountLibrary();
    else if (mounted.view === "matches") unmountMatches();
    else if (mounted.view === "player") unmountPlayer();
    else if (mounted.view === "editor") unmountEditor();
    else if (mounted.view === "storage") unmountStorage();
    else if (mounted.view === "settings") unmountSettings();
  }
  mounted = route;

  const view = el("view");
  if (route.view === "library") mountLibrary(view);
  else if (route.view === "matches") mountMatches(view, route.session, route.match);
  else if (route.view === "player") mountPlayer(view, route.id);
  else if (route.view === "editor") mountEditor(view, route.id);
  else if (route.view === "storage") mountStorage(view);
  else mountSettings(view);

  for (const tab of TABS) {
    el(`tab-${tab}`).setAttribute("aria-selected", String(tab === activeTab()));
  }
}

// ---------------------------------------------------------------------------
// Events pushed from Rust

void listen<{ path: string }>("clip-saved", (e) => {
  noteClipSaved(e.payload.path);
  void loadClips();
});

void listen("status-changed", () => {
  void loadStatus();
  void loadSettings();
});

void listen("clips-changed", () => {
  void loadClips();
  // The folder scan is the expensive one, so it only runs where its numbers are on screen.
  if (current().view === "storage" || current().view === "library") void loadStorage();
});

void listen<ClipProgress>("clip-progress", (e) => applyProgress(e.payload));

void listen("sessions-changed", () => void loadSessions());

// The player left a game: Rust has already brought the window up, so show that session.
// Not while the editor is open, where jumping away would throw a cut in progress away.
void listen<{ id: number }>("session-ended", (e) => {
  void loadSessions();
  if (current().view !== "editor") go({ view: "matches", session: e.payload.id });
});

void listen<Bootstrap>("obs-bootstrap", (e) => {
  setBootstrap(e.payload);
  syncFirstRun();
});

void listen<Account | null>("account-changed", (e) => {
  onLoginStateChanged(
    null,
    e.payload
      ? t("settings.loggedInAs", { username: e.payload.username })
      : t("settings.loggedOut"),
  );
  void loadStatus();
  void loadSettings().then(syncFirstRun);
});

void listen<string>("login-failed", (e) => {
  onLoginStateChanged(null, e.payload);
  loginFailed(e.payload);
});

// ---------------------------------------------------------------------------
// First load, then a five second heartbeat for anything without an event

async function start(): Promise<void> {
  await Promise.all([
    loadStatus(),
    loadSettings(),
    loadBootstrap(),
    loadClips(),
    loadProgress(),
    loadSessions(),
  ]);
  renderToolbar();
  renderBanners();
  syncFirstRun();
  mount(current());
}

void start();

window.setInterval(() => {
  void loadStatus();
  if (data.progress.size) void loadProgress();
}, 5000);
