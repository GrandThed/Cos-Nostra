/** The library: clips organised by game, with a cross-game "Recent" view grouped by day.
 *
 *  The selection, the search text, the filter chips and the sort survive a tab switch, so
 *  coming back from Storage puts you where you were. */

import { paintStatusDot, serverStack, statusDot } from "./circles";
import {
  badgeFor,
  clipsNote,
  countByGame,
  FILTERS,
  filterLabel,
  gameLabel,
  isReleased,
  matchesSearch,
  metaLine,
  sortClips,
  sortLabel,
  SORTS,
  unknownGame,
  type FilterId,
  type SortId,
} from "./clips";
import { confirming, editInline, fill, h } from "./dom";
import { dayLabel, fmtBytes, fmtDuration, fmtTimeOnly, fmtWhen, hueFor } from "./format";
import { artFor, artTile, forgetArt, onGameArt } from "./gameArt";
import { onLanguage, t } from "./i18n";
import * as ipc from "./ipc";
import { openPublishDialog } from "./publish";
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
  // Which clips have a match arrives a moment after the clips do; it only shows or hides one
  // button per card, so it does not rebuild the grid either.
  on("clipMatches", () => {
    if (parts) refreshMatchButtons();
  });
  // The status poll runs every five seconds whether or not anything moved. Only three things
  // in it reach the grid: which game is hooked (a clip waits for it), whether Discord is
  // linked (a published clip waits for that) and the hotkey the empty state names.
  on("status", () => {
    const key = `${data.status?.hooked_game?.executable ?? ""}|${data.status?.hotkey ?? ""}|${data.status?.account?.discord_id ?? ""}`;
    if (!parts || key === lastStatusKey) return;
    lastStatusKey = key;
    renderMain();
  });
  onLanguage(() => {
    if (parts) renderAll();
  });
  // The tiles repaint themselves; the header only has to show or hide its reset chip once it
  // is known whether the picture is one the user chose.
  onGameArt((game) => {
    if (headArt?.game !== game) return;
    const art = artFor(game, "cover");
    if (art !== undefined) headArt.reset.hidden = !art?.custom;
  });
}

let lastStatusKey = "";

export function mountLibrary(root: HTMLElement): void {
  const sidebar = searchBox(t("library.searchClipsAndGames"));
  const compact = searchBox(t("library.search"));
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
    title: t("library.clear"),
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
  parts.sidebarSearch.placeholder = t("library.searchClipsAndGames");
  parts.compactSearch.placeholder = t("library.search");
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
      title: t("library.sort"),
      onchange: (e: Event) => {
        sort = (e.target as HTMLSelectElement).value as SortId;
        for (const other of document.querySelectorAll<HTMLSelectElement>(".sort-select")) {
          other.value = sort;
        }
        renderMain();
      },
    },
    ...SORTS.map((id) => h("option", { value: id, text: sortLabel(id), selected: id === sort })),
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
    gameItem(t("library.recentAllGames"), null, selection.kind === "recent", () => {
      selection = { kind: "recent" };
      renderAll();
    }),
    h("div", { class: "divider" }),
    ...named.map((g) => {
      const item = gameItem(
        g.game as string,
        String(g.clips),
        selection.kind === "game" && selection.game === g.game,
        () => {
          selection = { kind: "game", game: g.game };
          renderAll();
        },
        "game",
      );
      item.prepend(artTile(h("span"), g.game as string, "icon"));
      return item;
    }),
  ];

  if (unknown) {
    const item = gameItem(
      unknownGame(),
      t("library.unknownCount", { clips: unknown.clips }),
      selection.kind === "game" && selection.game === null,
      () => {
        selection = { kind: "game", game: null };
        renderAll();
      },
      "unknown",
    );
    item.title = t("library.unknownTitle");
    item.prepend(h("span", { class: "dot" }));
    items.push(item);
  }

  fill(parts.gameList, ...items);

  fill(
    parts.compactGames,
    h("option", { value: RECENT, text: t("library.allGames") }),
    ...named.map((g) =>
      h("option", { value: gameValue(g.game as string), text: `${g.game} · ${g.clips}` }),
    ),
    unknown
      ? h("option", { value: UNKNOWN_KEY, text: `${unknownGame()} · ${unknown.clips}` })
      : null,
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
    stats ? `${fmtBytes(stats.total)} · ${clipsNote(stats.clips)} → ` : `${t("library.storage")} `,
    h("em", { text: t("library.storage") }),
  );
}

// ---------------------------------------------------------------------------
// Main column

/** What the player calls the list it is stepping through: "in this game", or what narrowed it. */
export function selectionLabel(): string {
  if (search) return t("library.scopeSearch", { search });
  if (filters.size) return t("library.scopeFilter");
  return selection.kind === "game" ? t("library.scopeGame") : t("library.scopeAll");
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

/** The status elements on screen, per clip: the circle over the thumbnail for the grid, and
 *  the text badge at the end of the row for the compact layout. */
const cardBadges = new Map<number, { dot: HTMLElement; trail: HTMLElement }>();
/** Each card's "Show in match" button, shown only while the clip has a match to show. */
const matchButtons = new Map<number, HTMLElement>();
/** The game header's picture and its reset chip, which shows only while the picture is one the
 *  user chose. */
let headArt: { game: string; cover: HTMLButtonElement; reset: HTMLElement } | null = null;
/** A picture's file picker is open. The header can be rebuilt under it, and the new button
 *  must not open a second one. */
let choosingArt = false;

/** Repaints every card's circle and badge in place, leaving the rest of the grid alone: a
 *  percentage moves several times a second. */
function refreshBadges(): void {
  const byId = new Map(data.clips.map((c) => [c.id, c]));
  for (const [id, { dot, trail }] of cardBadges) {
    const clip = byId.get(id);
    if (!clip) continue;
    const badge = badgeFor(clip, data.progress.get(id), data.status, data.settings);
    paintStatusDot(dot, badge);
    if (trail.textContent === badge.label) continue;
    trail.textContent = badge.label;
    trail.className = `badge trail ${badge.kind}`;
    if (badge.title) trail.title = badge.title;
    else trail.removeAttribute("title");
  }
}

function refreshMatchButtons(): void {
  for (const [id, button] of matchButtons) button.hidden = !data.clipMatches.has(id);
}

function renderMain(): void {
  if (!parts) return;
  resetWatches();
  cardBadges.clear();
  matchButtons.clear();
  headArt = null;
  const clips = visibleClips();
  const recent = selection.kind === "recent";

  const chips = FILTERS.map((f) => filterChip(f.id, filterLabel(f.id)));
  if (recent) {
    fill(
      parts.head,
      search
        ? h("span", {
            class: "match-note",
            text: t("library.matchesSearchLong", { count: clipsNote(clips.length), search }),
          })
        : h("h2", { text: t("library.recent") }),
      h("span", { class: "grow" }),
      ...chips,
      sortSelect(),
    );
    fill(parts.filterRow);
    parts.filterRow.hidden = true;
  } else {
    const game = selection.kind === "game" ? selection.game : null;
    const art = game !== null ? artControls(game) : null;
    fill(
      parts.head,
      art?.cover,
      h("h2", { text: gameLabel(game), title: gameLabel(game) }),
      h("span", { class: "count", text: gameSummary(game) }),
      renameChip(game),
      art?.reset,
      search
        ? h("span", {
            class: "match-note",
            text: t("library.matchesSearch", { count: clipsNote(clips.length), search }),
          })
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
      h("div", { class: "empty-state" }, h("span", { text: t("library.nothingMatchesFilters") })),
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
  const showCount = id === "local" || id === "failed";
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
    { type: "button", class: "chip dashed", title: t("library.renameMergeTitle") },
    t("library.renameMerge"),
    h("b", { class: "new", text: t("library.new") }),
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
            // The pictures travel with the name, so whatever was known under either is stale.
            if (game !== null) forgetArt(game);
            if (value !== null) forgetArt(value);
            void loadClips();
            void loadStorage();
          })
          .catch((e) => console.error("rename", e));
      },
      { placeholder: unknownGame() },
    );
  });
  return chip;
}

/** The game's box art, which is also the button that changes it, and the chip that puts back
 *  the picture a lookup found. */
function artControls(game: string): { cover: HTMLButtonElement; reset: HTMLElement } {
  const cover = artTile(
    h("button", {
      type: "button",
      title: t("library.changeImage"),
      "aria-label": t("library.changeImage"),
      disabled: choosingArt,
    }),
    game,
    "cover",
  );
  cover.addEventListener("click", () => {
    choosingArt = true;
    cover.disabled = true;
    void ipc
      .chooseGameArt(game)
      .then((chosen) => {
        if (chosen) forgetArt(game);
      })
      .catch((e) => console.warn("choose game art", game, e))
      .finally(() => {
        choosingArt = false;
        if (headArt) headArt.cover.disabled = false;
      });
  });

  const reset = h("button", {
    type: "button",
    class: "chip dashed",
    text: t("library.resetImage"),
    title: t("library.resetImageTitle"),
    hidden: !artFor(game, "cover")?.custom,
    onclick: () => {
      reset.hidden = true;
      void ipc
        .resetGameArt(game)
        .then(() => forgetArt(game))
        .catch((e) => {
          console.warn("reset game art", game, e);
          forgetArt(game);
        });
    },
  });

  headArt = { game, cover, reset };
  return { cover, reset };
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
  // Both are kept so a progress tick can repaint them in place.
  const dot = statusDot(badge);
  const trail = h("span", { class: `badge trail ${badge.kind}`, text: badge.label, title: badge.title });
  cardBadges.set(c.id, { dot, trail });

  const img = h("img", { alt: "" }) as HTMLImageElement;
  watch(img, c.id, c.thumb_path, c.updated_at);

  const actions = h("div", { class: "actions" });
  if (c.page_url) {
    actions.append(copyLinkButton(c.page_url, "btn small"));
  }
  // A clip on its way up has nothing to choose yet; its card says how far it got.
  if (c.remote_id || !c.publish) {
    actions.append(
      h("button", {
        type: "button",
        class: c.remote_id ? "btn small" : "btn small publish",
        text: c.remote_id ? t("library.servers") : t("library.publish"),
        onclick: () => openPublishDialog(c.id),
      }),
    );
  }
  const inMatch = h("button", {
    type: "button",
    class: "btn small",
    text: t("library.showInMatch"),
    hidden: !data.clipMatches.has(c.id),
    onclick: () => showInMatch(c.id),
  });
  matchButtons.set(c.id, inMatch);
  actions.append(inMatch);
  if (!released) {
    actions.append(
      h("button", {
        type: "button",
        class: "btn small",
        text: t("library.openFolder"),
        onclick: () => void ipc.openClipFolder(c.id),
      }),
    );
  }
  actions.append(
    confirming(
      h("button", { type: "button", class: "btn small danger" }) as HTMLButtonElement,
      t("library.delete"),
      t("library.confirmDelete"),
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
      dot,
      serverStack(c),
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
          text: byGame ? recentMeta(c) : metaLine(c, data.status),
          title: c.title ?? undefined,
        }),
      ),
      serverStack(c),
      c.status === "failed"
        ? h("button", {
            type: "button",
            class: "btn retry",
            text: t("library.retry"),
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

/** Opens the Matches tab on the match a clip was taken in, with the clip's range selected. */
export function showInMatch(clipId: number): void {
  const ref = data.clipMatches.get(clipId);
  if (ref) go({ view: "matches", session: ref.session_id, match: ref.match_id, clip: clipId });
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
    text: t("library.copyLink"),
  }) as HTMLButtonElement;
  button.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(url);
      button.textContent = t("library.copied");
      window.setTimeout(() => {
        button.textContent = t("library.copyLink");
      }, 1500);
    } catch {
      button.textContent = t("library.copyFailed");
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
      t("library.noClipsYet"),
      h("span", { class: "key", text: data.status?.hotkey ?? t("library.theHotkey") }),
      t("library.whilePlaying"),
    ),
  );
}
