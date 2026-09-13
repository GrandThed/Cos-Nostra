/** What the clips cost on this PC: where the bytes went, what can be given back, and the cap
 *  that keeps it from happening again. */

import { clipsNote } from "./clips";
import { confirming, fill, h } from "./dom";
import { fmtBytes, fmtCount } from "./format";
import * as ipc from "./ipc";
import { data, loadSettings, loadStorage, on } from "./store";
import type { Bucket, CleanTarget, Settings, StorageStats } from "./types";

/** Distinct at 14 px in both themes, and fixed so a game keeps its colour when the theme
 *  flips. The last two are reserved for the "more games" and "other files" slices. */
const PALETTE = [
  "#c96a3f",
  "#8f9a54",
  "#4f8a96",
  "#9a6f9a",
  "#b8963f",
  "#6f7fb8",
  "#7a9a6f",
];
const COLOR_REST = "#8a7f6f";
const COLOR_FOREIGN = "#5a5248";

/** Games past this fold into one slice so the bar stays readable. */
const MAX_SLICES = 7;
const GB = 1024 * 1024 * 1024;

interface Slice {
  label: string;
  color: string;
  note: string;
  bytes: number;
}

const CLEANERS: {
  target: CleanTarget;
  label: string;
  note: string;
  verb: string;
  confirmVerb: string;
  of: (s: StorageStats) => Bucket;
}[] = [
  {
    target: "sources",
    label: "Original recordings",
    note: "The raw buffer file of clips that already encoded. AV1 and H.264 stay.",
    verb: "Delete",
    confirmVerb: "delete",
    of: (s) => s.reclaim_sources,
  },
  {
    target: "published",
    label: "Clips already on the site",
    note: "Removes the video from this PC. Thumbnail, link and Discord post stay.",
    verb: "Remove",
    confirmVerb: "remove",
    of: (s) => s.reclaim_published,
  },
  {
    target: "failed",
    label: "Clips that failed",
    note: "Deletes the clip and every file it owns, for good.",
    verb: "Delete",
    confirmVerb: "delete",
    of: (s) => s.reclaim_failed,
  },
];

let root: HTMLElement | null = null;
/** Result of the last cleanup, which survives the redraw that follows it. */
let cleanResult: { text: string; bad: boolean } | null = null;
let saveMsg = "";

export function initStorage(): void {
  on("storage", () => {
    if (root) render();
  });
  on("settings", () => {
    if (root) render();
  });
}

export function mountStorage(node: HTMLElement): void {
  root = node;
  render();
  void loadStorage();
  if (!data.settings) void loadSettings();
}

export function unmountStorage(): void {
  root = null;
  cleanResult = null;
  saveMsg = "";
}

function render(): void {
  if (!root) return;
  const stats = data.storage;
  const settings = data.settings;

  if (data.errors.storage) {
    fill(root, h("div", { class: "storage" }, h("div", { class: "banner err" }, h("div", { class: "body" }, h("b", { text: "Could not read the clip folder" }), h("div", { class: "detail", text: data.errors.storage })))));
    return;
  }
  if (!stats || !settings) {
    fill(root, h("div", { class: "storage" }, h("span", { class: "muted", text: "Reading the folder…" })));
    return;
  }

  const games = gameSlices(stats);

  fill(
    root,
    h(
      "div",
      { class: "storage scroll" },
      headline(stats),
      block(
        "By game",
        bar(games, games.reduce((n, s) => n + s.bytes, 0)),
        legend(games),
      ),
      kinds(stats),
      whereClipsLive(stats),
      freeUpSpace(stats),
      keepInCheck(stats, settings),
    ),
  );
}

function headline(s: StorageStats): HTMLElement {
  const sub = [clipsNote(s.clips)];
  if (s.free_space !== null) sub.push(`${fmtBytes(s.free_space)} free on ${driveOf(s.clip_dir)}`);
  return h(
    "div",
    { class: "headline" },
    h("span", { class: "total", text: fmtBytes(s.total) }),
    h("span", { class: "sub", text: sub.join(" · "), title: s.clip_dir }),
    h("span", { class: "grow" }),
    h("button", {
      type: "button",
      class: "btn small",
      text: "Open folder",
      onclick: () => void ipc.openClipDir(),
    }),
  );
}

/** "D:" out of "D:\Videos\Cos Nostra", or "the drive" for a path with no letter. */
function driveOf(dir: string): string {
  return /^[A-Za-z]:/.test(dir) ? dir.slice(0, 2).toUpperCase() : "the drive";
}

function block(label: string, ...children: HTMLElement[]): HTMLElement {
  return h("div", { class: "block" }, h("span", { class: "section-label", text: label }), ...children);
}

function bar(slices: Slice[], total: number): HTMLElement {
  return h(
    "div",
    { class: "bar" },
    ...slices.map((s) =>
      h("span", {
        style: `width:${total > 0 ? (s.bytes / total) * 100 : 0}%;background:${s.color}`,
        title: `${s.label} — ${fmtBytes(s.bytes)}`,
      }),
    ),
  );
}

function legend(slices: Slice[]): HTMLElement {
  return h(
    "div",
    { class: "legend" },
    ...slices.map((s) =>
      h(
        "div",
        { class: "row", title: `${s.label} — ${s.note}` },
        h("span", { class: "swatch", style: `background:${s.color}` }),
        h("span", { class: "name", text: s.label }),
        h("span", { class: "size", text: fmtBytes(s.bytes) }),
      ),
    ),
  );
}

/** The biggest games, then everything else, then whatever the app did not put there. */
function gameSlices(s: StorageStats): Slice[] {
  const used = s.games.filter((g) => g.bytes > 0);
  const slices: Slice[] = used.slice(0, MAX_SLICES).map((g, i) => ({
    label: g.game ?? "Unknown game",
    color: PALETTE[i % PALETTE.length],
    note: clipsNote(g.clips),
    bytes: g.bytes,
  }));
  const rest = used.slice(MAX_SLICES);
  if (rest.length) {
    slices.push({
      label: `${rest.length} more games`,
      color: COLOR_REST,
      note: clipsNote(rest.reduce((n, g) => n + g.clips, 0)),
      bytes: rest.reduce((n, g) => n + g.bytes, 0),
    });
  }
  if (s.kinds.other > 0) {
    slices.push({
      label: "Other files in the folder",
      color: COLOR_FOREIGN,
      note: fmtCount(s.kinds.other_files, "file"),
      bytes: s.kinds.other,
    });
  }
  return slices;
}

function kinds(s: StorageStats): HTMLElement {
  const parts: [string, number][] = [
    ["Originals", s.kinds.sources],
    ["AV1", s.kinds.av1],
    ["H.264", s.kinds.h264],
    ["Thumbnails", s.kinds.thumbs],
    ["Other files", s.kinds.other],
  ];
  return h(
    "div",
    { class: "kinds" },
    ...parts.map(([name, bytes]) =>
      h(
        "div",
        { class: "kind" },
        h("span", { class: "k", text: name }),
        h("span", { class: "v", text: fmtBytes(bytes) }),
      ),
    ),
  );
}

function whereClipsLive(s: StorageStats): HTMLElement {
  const total = s.published.bytes + s.local_only.bytes;
  return block(
    "Where clips live",
    bar(
      [
        { label: "On the site", color: "var(--ok)", note: "", bytes: s.published.bytes },
        { label: "Only on this PC", color: "var(--panel2)", note: "", bytes: s.local_only.bytes },
      ],
      total,
    ),
    h(
      "div",
      { class: "where-legend" },
      h(
        "span",
        null,
        h("span", { class: "on-site", text: "●" }),
        ` On the site · ${clipsNote(s.published.clips)} · ${fmtBytes(s.published.bytes)} local`,
      ),
      h(
        "span",
        null,
        h("span", { text: "●" }),
        ` Only on this PC · ${clipsNote(s.local_only.clips)} · ${fmtBytes(s.local_only.bytes)}`,
      ),
    ),
  );
}

function freeUpSpace(s: StorageStats): HTMLElement {
  const cards = CLEANERS.map((c) => {
    const bucket = c.of(s);
    const empty = bucket.clips === 0;
    const card = h(
      "div",
      { class: `cleaner${empty ? " nothing" : ""}` },
      h("b", { text: c.label }),
      h("span", { class: "note", text: c.note }),
    );
    const button = h("button", {
      type: "button",
      class: "btn warn",
      disabled: empty,
    }) as HTMLButtonElement;
    if (empty) {
      button.textContent = "Nothing to free";
    } else {
      confirming(
        button,
        `${c.verb} · frees ${fmtBytes(bucket.bytes)} / ${clipsNote(bucket.clips)}`,
        `Confirm — ${c.confirmVerb} ${fmtBytes(bucket.bytes)}?`,
        () => void runClean(c.target),
        (armed) => card.classList.toggle("armed", armed),
      );
    }
    card.appendChild(button);
    return card;
  });

  const leftovers =
    s.kinds.other_files > 0
      ? h("span", {
          class: "aside",
          text: ` · ${fmtCount(s.kinds.other_files, "leftover file")} the app doesn't own (${fmtBytes(s.kinds.other)}) are counted but never deleted.`,
        })
      : null;

  return block(
    "Free up space",
    h("div", { class: "cleaners" }, ...cards),
    h(
      "span",
      { class: `clean-result${cleanResult?.bad ? " err" : ""}` },
      cleanResult?.text ?? "",
      leftovers,
    ),
  );
}

async function runClean(target: CleanTarget): Promise<void> {
  cleanResult = { text: "Working…", bad: false };
  render();
  try {
    const freed = await ipc.cleanStorage(target);
    cleanResult = {
      text: freed.clips
        ? `Freed ${fmtBytes(freed.bytes)} from ${clipsNote(freed.clips)}.`
        : "Nothing left to free there.",
      bad: false,
    };
  } catch (e) {
    cleanResult = { text: ipc.errorText(e), bad: true };
  }
  // The cleanup emits clips-changed, but reload here too so the numbers refresh even when the
  // Rust side had nothing to report.
  await loadStorage();
}

function keepInCheck(s: StorageStats, settings: Settings): HTMLElement {
  const deleteSources = h("input", {
    type: "checkbox",
    checked: settings.delete_source_after_encode,
  }) as HTMLInputElement;
  const limit = h("input", {
    type: "number",
    class: "field",
    min: "0",
    max: "100000",
    step: "1",
    value: String(settings.storage_limit_gb),
  }) as HTMLInputElement;

  const cap = settings.storage_limit_gb * GB;
  const over = cap > 0 && s.total > cap;

  const save = h("button", {
    type: "button",
    class: "btn primary",
    text: "Save",
    onclick: async () => {
      saveMsg = "Saving…";
      render();
      try {
        await ipc.saveSettings({
          ...settings,
          delete_source_after_encode: deleteSources.checked,
          storage_limit_gb: Number(limit.value),
        });
        saveMsg = "Saved";
        await loadSettings();
        await loadStorage();
      } catch (e) {
        saveMsg = ipc.errorText(e);
        render();
      }
    },
  });

  return h(
    "div",
    { class: "cap" },
    h("span", { class: "section-label", text: "Keep it in check" }),
    h(
      "label",
      { class: "check" },
      deleteSources,
      h("span", { class: "box" }),
      "Delete the original recording after encoding",
    ),
    h(
      "div",
      { class: "limit" },
      "Keep at most",
      limit,
      "GB",
      h("span", {
        class: "note",
        text: "· 0 for no limit. Over the limit, the oldest clips the site already has give up their local video; clips only on this PC are never touched.",
      }),
    ),
    over
      ? h("div", {
          class: "over",
          text: `Over the ${settings.storage_limit_gb} GB limit by ${fmtBytes(s.total - cap)}. Nothing more can go automatically: what is left is not on the site yet.`,
        })
      : null,
    h(
      "div",
      { class: "save-row" },
      save,
      h("span", {
        class: `msg${saveMsg === "Saved" ? " ok" : saveMsg && saveMsg !== "Saving…" ? " err" : ""}`,
        text: saveMsg,
      }),
    ),
  );
}
