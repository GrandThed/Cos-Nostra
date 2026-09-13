/** What the clips cost on this PC: where the bytes went, what can be given back, and the cap
 *  that keeps it from happening again. */

import { clipsNote, gameLabel } from "./clips";
import { confirming, fill, h } from "./dom";
import { fmtBytes, fmtCount } from "./format";
import { onLanguage, t } from "./i18n";
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

const CLEANERS: { target: CleanTarget; of: (s: StorageStats) => Bucket }[] = [
  { target: "sources", of: (s) => s.reclaim_sources },
  { target: "published", of: (s) => s.reclaim_published },
  { target: "failed", of: (s) => s.reclaim_failed },
];

let root: HTMLElement | null = null;
/** Result of the last cleanup, which survives the redraw that follows it. */
let cleanResult: { text: string; bad: boolean } | null = null;
let saveMsg: { text: string; kind: "" | "ok" | "err" } | null = null;

export function initStorage(): void {
  on("storage", () => {
    if (root) render();
  });
  on("settings", () => {
    if (root) render();
  });
  onLanguage(() => {
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
  saveMsg = null;
}

function render(): void {
  if (!root) return;
  const stats = data.storage;
  const settings = data.settings;

  if (data.errors.storage) {
    fill(
      root,
      h(
        "div",
        { class: "storage" },
        h(
          "div",
          { class: "banner err" },
          h(
            "div",
            { class: "body" },
            h("b", { text: t("storage.couldNotRead") }),
            h("div", { class: "detail", text: data.errors.storage }),
          ),
        ),
      ),
    );
    return;
  }
  if (!stats || !settings) {
    fill(
      root,
      h("div", { class: "storage" }, h("span", { class: "muted", text: t("storage.reading") })),
    );
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
        t("storage.byGame"),
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
  if (s.free_space !== null) {
    sub.push(t("storage.freeOn", { size: fmtBytes(s.free_space), drive: driveOf(s.clip_dir) }));
  }
  return h(
    "div",
    { class: "headline" },
    h("span", { class: "total", text: fmtBytes(s.total) }),
    h("span", { class: "sub", text: sub.join(" · "), title: s.clip_dir }),
    h("span", { class: "grow" }),
    h("button", {
      type: "button",
      class: "btn small",
      text: t("storage.openFolder"),
      onclick: () => void ipc.openClipDir(),
    }),
  );
}

/** "D:" out of "D:\Videos\Cos Nostra", or "the drive" for a path with no letter. */
function driveOf(dir: string): string {
  return /^[A-Za-z]:/.test(dir) ? dir.slice(0, 2).toUpperCase() : t("storage.theDrive");
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
    label: gameLabel(g.game),
    color: PALETTE[i % PALETTE.length],
    note: clipsNote(g.clips),
    bytes: g.bytes,
  }));
  const rest = used.slice(MAX_SLICES);
  if (rest.length) {
    slices.push({
      label: t("storage.moreGames", { n: rest.length }),
      color: COLOR_REST,
      note: clipsNote(rest.reduce((n, g) => n + g.clips, 0)),
      bytes: rest.reduce((n, g) => n + g.bytes, 0),
    });
  }
  if (s.kinds.other > 0) {
    slices.push({
      label: t("storage.otherInFolder"),
      color: COLOR_FOREIGN,
      note: fmtCount(s.kinds.other_files, t("storage.fileOne"), t("storage.fileMany")),
      bytes: s.kinds.other,
    });
  }
  return slices;
}

function kinds(s: StorageStats): HTMLElement {
  const parts: [string, number][] = [
    [t("storage.kinds.originals"), s.kinds.sources],
    ["AV1", s.kinds.av1],
    ["H.264", s.kinds.h264],
    [t("storage.kinds.thumbnails"), s.kinds.thumbs],
    [t("storage.kinds.other"), s.kinds.other],
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
    t("storage.whereClipsLive"),
    bar(
      [
        { label: t("storage.onSite"), color: "var(--ok)", note: "", bytes: s.published.bytes },
        {
          label: t("storage.onlyHere"),
          color: "var(--panel2)",
          note: "",
          bytes: s.local_only.bytes,
        },
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
        t("storage.onSiteLine", {
          count: clipsNote(s.published.clips),
          size: fmtBytes(s.published.bytes),
        }),
      ),
      h(
        "span",
        null,
        h("span", { text: "●" }),
        t("storage.onlyHereLine", {
          count: clipsNote(s.local_only.clips),
          size: fmtBytes(s.local_only.bytes),
        }),
      ),
    ),
  );
}

function freeUpSpace(s: StorageStats): HTMLElement {
  const cards = CLEANERS.map((c) => {
    const bucket = c.of(s);
    const empty = bucket.clips === 0;
    const size = fmtBytes(bucket.bytes);
    const card = h(
      "div",
      { class: `cleaner${empty ? " nothing" : ""}` },
      h("b", { text: t(`storage.cleaner.${c.target}.label`) }),
      h("span", { class: "note", text: t(`storage.cleaner.${c.target}.note`) }),
    );
    const button = h("button", {
      type: "button",
      class: "btn warn",
      disabled: empty,
    }) as HTMLButtonElement;
    if (empty) {
      button.textContent = t("storage.nothingToFree");
    } else {
      confirming(
        button,
        t("storage.freeButton", {
          verb: t(`storage.cleaner.${c.target}.verb`),
          size,
          count: clipsNote(bucket.clips),
        }),
        t("storage.freeConfirm", {
          verb: t(`storage.cleaner.${c.target}.confirmVerb`),
          size,
        }),
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
          text: t("storage.leftovers", {
            count: fmtCount(
              s.kinds.other_files,
              t("storage.leftoverOne"),
              t("storage.leftoverMany"),
            ),
            size: fmtBytes(s.kinds.other),
          }),
        })
      : null;

  return block(
    t("storage.freeUpSpace"),
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
  cleanResult = { text: t("storage.working"), bad: false };
  render();
  try {
    const freed = await ipc.cleanStorage(target);
    cleanResult = {
      text: freed.clips
        ? t("storage.freed", { size: fmtBytes(freed.bytes), count: clipsNote(freed.clips) })
        : t("storage.nothingLeft"),
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
    text: t("storage.save"),
    onclick: async () => {
      saveMsg = { text: t("storage.saving"), kind: "" };
      render();
      try {
        await ipc.saveSettings({
          ...settings,
          delete_source_after_encode: deleteSources.checked,
          storage_limit_gb: Number(limit.value),
        });
        saveMsg = { text: t("storage.saved"), kind: "ok" };
        await loadSettings();
        await loadStorage();
      } catch (e) {
        saveMsg = { text: ipc.errorText(e), kind: "err" };
        render();
      }
    },
  });

  return h(
    "div",
    { class: "cap" },
    h("span", { class: "section-label", text: t("storage.keepInCheck") }),
    h(
      "label",
      { class: "check" },
      deleteSources,
      h("span", { class: "box" }),
      t("storage.deleteSources"),
    ),
    h(
      "div",
      { class: "limit" },
      t("storage.keepAtMost"),
      limit,
      "GB",
      h("span", { class: "note", text: t("storage.limitNote") }),
    ),
    over
      ? h("div", {
          class: "over",
          text: t("storage.over", {
            limit: settings.storage_limit_gb,
            size: fmtBytes(s.total - cap),
          }),
        })
      : null,
    h(
      "div",
      { class: "save-row" },
      save,
      h("span", {
        class: `msg${saveMsg?.kind ? ` ${saveMsg.kind}` : ""}`,
        text: saveMsg?.text ?? "",
      }),
    ),
  );
}
