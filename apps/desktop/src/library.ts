/** The library: clips organised by game, with a cross-game "Recent" view grouped by day.
 *
 *  The selection, the search text, the filter chips and the sort survive a tab switch, so
 *  coming back from Storage puts you where you were. */

import {
  badgeFor,
  clipsNote,
  countByGame,
  FILTERS,
  gameLabel,
  isReleased,
  matchesSearch,
  metaLine,
  sortClips,
  SORTS,
  UNKNOWN,
  type FilterId,
  type SortId,
} from "./clips";
import { confirming, editInline, fill, h } from "./dom";
import { dayLabel, fmtBytes, fmtDuration, fmtTimeOnly, fmtWhen, hueFor } from "./format";
import * as ipc from "./ipc";
import { go } from "./router";
import { data, loadClips, loadStorage, on } from "./store";
import { keepOnly, resetWatches, watch } from "./thumbs";
import type { ClipRow } from "./types";

type Selection = { kind: "recent" } | { kind: "game"; game: string | null };

/** Option values for the compact game dropdown. Real games carry a prefix, so neither
 *  sentinel can ever collide with a game actually called "recent". */
const RECENT = "recent";
const UNKNOWN_KEY = "unknown";
const gameValue = (game: string) => `game:${game}`;

let selection: Selection = { kind: "recent" };
let search = "";
const filters = new Set<FilterId>();
let sort: SortId = "newest";

/** Elements that outlive a redraw, so typing in the search box is not interrupted by one. */
interface Parts {
  sidebarSearch: HTMLInputElement;
  compactSearch: HTMLInputElement;
  compactGames: HTMLSelectElement;
  gameList: HTMLElement;
  storageFoot: HTMLElement;
  head: HTMLElement;
  filterRow: HTMLElement;
  scroll: HTMLElement;
}

let parts: Parts | null = null;

export function initLibrary(): void {
  on("clips", () => {
    if (parts) renderAll();
  });
  on("storage", () => {
    if (parts) renderFooter();
  });
  // A percentage moves several times a second and changes nothing but a badge, so it repaints
  // badges rather than rebuilding a grid of cards under the pointer.
  on("progress", () => {
    if (parts) refreshBadges();
  });
  // The status poll runs every five seconds whether or not anything moved. Only two things in
  // it reach the grid: which game is hooked (a clip waits for it) and the hotkey the empty
  // state names.
  on("status", () => {
    const key = `${data.status?.hooked_game?.executable ?? ""}|${data.status?.hotkey ?? ""}`;
    if (!parts || key === lastStatusKey) return;
    lastStatusKey = key;
    renderMain();
  });
}

let lastStatusKey = "";

export function mountLibrary(root: HTMLElement): void {
  const sidebar = searchBox("Search clips & games");
  const compact = searchBox("Search");
  const compactGames = h("select", {
    class: "field",
    onchange: (e: Event) => {
      const value = (e.target as HTMLSelectElement).value;
      selection =
        value === RECENT
          ? { kind: "recent" }
          : { kind: "game", game: value === UNKNOWN_KEY ? null : value.slice("game:".length) };
      renderAll();
    },
  }) as HTMLSelectElement;

  const gameList = h("div", { class: "game-list scroll" });
  const storageFoot = h("button", {
    type: "button",
    class: "storage-foot",
    onclick: () => go({ view: "storage" }),
  });
  const head = h("div", { class: "game-head" });
  const filterRow = h("div", { class: "filters" });
  const scroll = h("div", { class: "clip-scroll scroll" });

  parts = {
    sidebarSearch: sidebar.input,
    compactSearch: compact.input,
    compactGames,
    gameList,
    storageFoot,
    head,
    filterRow,
    scroll,
  };

  fill(
    root,
    h(
      "div",
      { class: "library" },
      h("aside", { class: "games" }, sidebar.box, gameList, h("span", { class: "grow" }), storageFoot),
      h(
        "section",
        { class: "clips" },
        h("div", { class: "compact-bar" }, compactGames, compact.box, sortSelect()),
        head,
        filterRow,
        scroll,
      ),
    ),
  );

  renderAll();
  // The sidebar footer and the per-game sizes come from the folder scan, which is also what
  // the Storage tab shows. Asking once when the library opens keeps both honest.
  if (!data.storage) void loadStorage();
}

export function unmountLibrary(): void {
  parts = null;
}

/** A search box, as one element with the input inside it. Both copies (sidebar and compact
 *  bar) edit the same text; only one of them is ever on screen. */
function searchBox(placeholder: string): { box: HTMLElement; input: HTMLInputElement } {
  const input = h("input", {
    type: "search",
    placeholder,
    value: search,
    oninput: (e: Event) => {
      search = (e.target as HTMLInputElement).value;
      syncSearchBoxes();
      renderMain();
    },
  }) as HTMLInputElement;
  const clear = h("button", {
    type: "button",
    class: "clear",
    text: "✕",
    title: "Clear",
    onclick: () => {
      search = "";
      syncSearchBoxes();
      renderMain();
    },
  });
  const box = h("div", { class: "search" }, h("span", { class: "glyph", text: "⌕" }), input, clear);
  return { box, input };
}

function syncSearchBoxes(): void {
  if (!parts) return;
  for (const box of [parts.sidebarSearch, parts.compactSearch]) {
    if (box.value !== search) box.value = search;
    const clear = box.nextElementSibling as HTMLElement | null;
    if (clear) clear.hidden = search === "";
  }
}

function sortSelect(): HTMLSelectElement {
  const select = h(
    "select",
    {
      class: "field",
      title: "Sort",
      onchange: (e: Event) => {
        sort = (e.target as HTMLSelectElement).value as SortId;
        for (const other of document.querySelectorAll<HTMLSelectElement>(".sort-select")) {
          other.value = sort;
        }
        renderMain();
      },
    },
    ...SORTS.map((s) => h("option", { value: s.id, text: s.label, selected: s.id === sort })),
  ) as HTMLSelectElement;
  select.classList.add("sort-select");
  select.value = sort;
  return select;
}

function renderAll(): void {
  renderSidebar();
  renderFooter();
  renderMain();
  syncSearchBoxes();
  keepOnly(new Set(data.clips.map((c) => c.id)));
}

// ---------------------------------------------------------------------------
// Sidebar

function renderSidebar(): void {
  if (!parts) return;
  const counts = countByGame(data.clips);
  const named = counts.filter((g) => g.game !== null);
  const unknown = counts.find((g) => g.game === null);

  const items: HTMLElement[] = [
    gameItem("Recent — all games", null, selection.kind === "recent", () => {
      selection = { kind: "recent" };
      renderAll();
    }),
    h("div", { class: "divider" }),
    ...named.map((g) =>
      gameItem(
        g.game as string,
        String(g.clips),
        selection.kind === "game" && selection.game === g.game,
        () => {
          selection = { kind: "game", game: g.game };
          renderAll();
        },
        "game",
      ),
    ),
  ];

  if (unknown) {
    const item = gameItem(
      UNKNOWN,
      `${unknown.clips} · fix`,
      selection.kind === "game" && selection.game === null,
      () => {
        selection = { kind: "game", game: null };
        renderAll();
      },
      "unknown",
    );
    item.title = "Clips whose game could not be detected. Open one and name it.";
    item.prepend(h("span", { class: "dot" }));
    items.push(item);
  }

  fill(parts.gameList, ...items);

  fill(
    parts.compactGames,
    h("option", { value: RECENT, text: "All games" }),
    ...named.map((g) =>
      h("option", { value: gameValue(g.game as string), text: `${g.game} · ${g.clips}` }),
    ),
    unknown ? h("option", { value: UNKNOWN_KEY, text: `${UNKNOWN} · ${unknown.clips}` }) : null,
  );
  parts.compactGames.value =
    selection.kind === "recent"
      ? RECENT
      : selection.game === null
        ? UNKNOWN_KEY
        : gameValue(selection.game);
}

function gameItem(
  name: string,
  count: string | null,
  selected: boolean,
  onclick: () => void,
  extra = "",
): HTMLElement {
  return h(
    "button",
    { type: "button", class: `game-item ${extra}`.trim(), "aria-current": String(selected), onclick },
    h("span", { class: "name", text: name, title: name }),
    count && h("span", { class: "count", text: count }),
  );
}

function renderFooter(): void {
  if (!parts) return;
  const stats = data.storage;
  fill(
    parts.storageFoot,
    stats ? `${fmtBytes(stats.total)} · ${clipsNote(stats.clips)} → ` : "Storage ",
    h("em", { text: "Storage" }),
  );
}

// ---------------------------------------------------------------------------
// Main column

/** What the player calls the list it is stepping through: "in this game", or what narrowed it. */
export function selectionLabel(): string {
  if (search) return `matching “${search}”`;
  if (filters.size) return "in this filter";
  return selection.kind === "game" ? "in this game" : "across all games";
}

/** The clips the current game, search and filters leave, in the current order. The player
 *  steps through exactly this list. */
export function visibleClips(): ClipRow[] {
  const where = selection;
  let clips = data.clips;
  if (where.kind === "game") clips = clips.filter((c) => c.game === where.game);
  if (search) clips = clips.filter((c) => matchesSearch(c, search));
  for (const id of filters) {
    const filter = FILTERS.find((f) => f.id === id);
    if (filter) clips = clips.filter(filter.match);
  }
  return sortClips(clips, sort);
}

/** The badge elements on screen, per clip: a card carries two, one over the thumbnail for the
 *  grid and one at the end of the row for the compact layout. */
const cardBadges = new Map<number, HTMLElement[]>();

/** Repaints the badges whose clip has a live percentage, leaving the rest of the grid alone. */
function refreshBadges(): void {
  const byId = new Map(data.clips.map((c) => [c.id, c]));
  for (const [id, nodes] of cardBadges) {
    const clip = byId.get(id);
    if (!clip) continue;
    const badge = badgeFor(clip, data.progress.get(id), data.status, data.settings);
    for (const node of nodes) {
      if (node.textContent === badge.label) continue;
      node.textContent = badge.label;
      node.className = `badge ${node.classList.contains("over") ? "over" : "trail"} ${badge.kind}`;
      if (badge.title) node.title = badge.title;
      else node.removeAttribute("title");
    }
  }
}

function renderMain(): void {
  if (!parts) return;
  resetWatches();
  cardBadges.clear();
  const clips = visibleClips();
  const recent = selection.kind === "recent";

  const chips = FILTERS.map((f) => filterChip(f.id, f.label));
  if (recent) {
    fill(
      parts.head,
      search
        ? h("span", {
            class: "match-note",
            text: `${clipsNote(clips.length)} match “${search}” — game name or window title`,
          })
        : h("h2", { text: "Recent" }),
      h("span", { class: "grow" }),
      ...chips,
      sortSelect(),
    );
    fill(parts.filterRow);
    parts.filterRow.hidden = true;
  } else {
    const game = selection.kind === "game" ? selection.game : null;
    fill(
      parts.head,
      h("h2", { text: gameLabel(game), title: gameLabel(game) }),
      h("span", { class: "count", text: gameSummary(game) }),
      renameChip(game),
      search
        ? h("span", { class: "match-note", text: `${clipsNote(clips.length)} match “${search}”` })
        : null,
      h("span", { class: "grow" }),
      sortSelect(),
    );
    fill(parts.filterRow, ...chips);
    parts.filterRow.hidden = false;
  }

  if (!data.clips.length) {
    // The clip queue opens a moment after the window, so "no clips" this early is the queue
    // not being ready, not an empty library. Inviting someone to press the hotkey then would
    // be wrong twice over.
    fill(
      parts.scroll,
      data.errors.clips
        ? h("div", { class: "empty-state", text: data.errors.clips })
        : emptyLibrary(),
    );
    return;
  }
  if (!clips.length) {
    fill(
      parts.scroll,
      h("div", { class: "empty-state" }, h("span", { text: "Nothing here matches those filters." })),
    );
    return;
  }

  fill(parts.scroll, ...(recent ? byDay(clips) : [grid(clips, false)]));
}

function gameSummary(game: string | null): string {
  const clips = data.clips.filter((c) => c.game === game).length;
  const usage = data.storage?.games.find((g) => g.game === game);
  return usage ? `${clipsNote(clips)} · ${fmtBytes(usage.bytes)}` : clipsNote(clips);
}

function filterChip(id: FilterId, label: string): HTMLElement {
  const filter = FILTERS.find((f) => f.id === id)!;
  // The count is of what this chip would add on its own, which is the number worth knowing
  // before clicking it.
  const where = selection;
  const scope =
    where.kind === "game" ? data.clips.filter((c) => c.game === where.game) : data.clips;
  const n = scope.filter(filter.match).length;
  const showCount = id === "not-uploaded" || id === "failed";
  return h("button", {
    type: "button",
    class: "chip",
    "aria-pressed": String(filters.has(id)),
    text: showCount ? `${label} · ${n}` : label,
    onclick: () => {
      if (filters.has(id)) filters.delete(id);
      else filters.add(id);
      renderMain();
    },
  });
}

/** Renaming a game renames every clip in it, so pointing two spellings at one name merges
 *  them. That is the only way to fix a batch of clips a window title got wrong. */
function renameChip(game: string | null): HTMLElement {
  const chip = h(
    "button",
    { type: "button", class: "chip dashed", title: "Rename this game on every clip, or merge it into another" },
    "Rename / merge game… ",
    h("b", { class: "new", text: "NEW" }),
  );
  chip.addEventListener("click", () => {
    editInline(
      chip,
      game ?? "",
      (value) => {
        if (value === game) return;
        void ipc
          .renameGame(game, value)
          .then(() => {
            selection = { kind: "game", game: value };
            void loadClips();
            void loadStorage();
          })
          .catch((e) => console.error("rename", e));
      },
      { placeholder: UNKNOWN },
    );
  });
  return chip;
}

function byDay(clips: ClipRow[]): HTMLElement[] {
  const out: HTMLElement[] = [];
  let day = "";
  let bucket: ClipRow[] = [];
  const flush = () => {
    if (!bucket.length) return;
    out.push(h("div", { class: "day-label", text: day }), grid(bucket, true));
    bucket = [];
  };
  for (const c of clips) {
    const label = dayLabel(c.recorded_at);
    if (label !== day) {
      flush();
      day = label;
    }
    bucket.push(c);
  }
  flush();
  return out;
}

function grid(clips: ClipRow[], byGame: boolean): HTMLElement {
  return h("div", { class: "grid" }, ...clips.map((c) => card(c, byGame)));
}

// ---------------------------------------------------------------------------
// Clip card

function card(c: ClipRow, byGame: boolean): HTMLElement {
  const badge = badgeFor(c, data.progress.get(c.id), data.status, data.settings);
  const released = isReleased(c);
  // Both copies of the badge are kept so a progress tick can repaint them in place.
  const over = h("span", { class: `badge over ${badge.kind}`, text: badge.label, title: badge.title });
  const trail = h("span", { class: `badge trail ${badge.kind}`, text: badge.label, title: badge.title });
  cardBadges.set(c.id, [over, trail]);

  const img = h("img", { alt: "" }) as HTMLImageElement;
  watch(img, c.id, c.thumb_path, c.updated_at);

  const actions = h("div", { class: "actions" });
  if (c.page_url) {
    actions.append(copyLinkButton(c.page_url, "btn small"));
  }
  if (!released) {
    actions.append(
      h("button", {
        type: "button",
        class: "btn small",
        text: "Open folder",
        onclick: () => void ipc.openClipFolder(c.id),
      }),
    );
  }
  actions.append(
    confirming(
      h("button", { type: "button", class: "btn small danger" }) as HTMLButtonElement,
      "Delete",
      "Confirm delete",
      () => void ipc.deleteClip(c.id),
    ),
  );
  for (const button of actions.querySelectorAll("button")) {
    button.addEventListener("click", (e) => e.stopPropagation());
  }

  const node = h(
    "article",
    {
      class: `card${byGame ? " by-game" : ""}`,
      role: "button",
      tabindex: "0",
      style: `--hue:${hueFor(c.id)}`,
      onclick: () => go({ view: "player", id: c.id }),
      onkeydown: (e: KeyboardEvent) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          go({ view: "player", id: c.id });
        }
      },
    },
    h(
      "div",
      { class: "shot" },
      img,
      over,
      h("span", { class: "dur", text: fmtDuration(c.duration_ms) }),
      actions,
    ),
    h(
      "div",
      { class: "foot" },
      h(
        "div",
        { class: "lines" },
        h("span", {
          class: "title",
          text: byGame ? gameLabel(c.game) : fmtWhen(c.recorded_at),
          title: byGame ? gameLabel(c.game) : fmtWhen(c.recorded_at),
        }),
        h("span", {
          class: "meta",
          text: byGame ? recentMeta(c) : metaLine(c, data.settings),
          title: c.title ?? undefined,
        }),
      ),
      c.status === "failed"
        ? h("button", {
            type: "button",
            class: "btn retry",
            text: "Retry",
            onclick: (e: Event) => {
              e.stopPropagation();
              void ipc.retryClip(c.id);
            },
          })
        : null,
      trail,
    ),
  );
  return node;
}

/** In the cross-game view the card is titled with the game, so the second line carries the
 *  time and, when there is one, the window the clip came from. */
function recentMeta(c: ClipRow): string {
  const time = fmtTimeOnly(c.recorded_at);
  return c.title ? `${time} · “${c.title}”` : time;
}

export function copyLinkButton(url: string, className: string): HTMLButtonElement {
  const button = h("button", {
    type: "button",
    class: className,
    text: "Copy link",
  }) as HTMLButtonElement;
  button.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(url);
      button.textContent = "Copied";
      window.setTimeout(() => {
        button.textContent = "Copy link";
      }, 1500);
    } catch {
      button.textContent = "Could not copy";
    }
  });
  return button;
}

function emptyLibrary(): HTMLElement {
  return h(
    "div",
    { class: "empty-state" },
    h("span", { class: "blob" }),
    h(
      "span",
      null,
      "No clips yet. Press ",
      h("span", { class: "key", text: data.status?.hotkey ?? "the hotkey" }),
      " while playing.",
    ),
  );
}
