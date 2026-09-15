/** The publish dialog. For a local clip: what it is called, which game, which Discord servers.
 *  For a published one: its link, the servers it is in (with a way to post it in more), and the
 *  two ways to take it down.
 *
 *  It sits on top of whatever screen opened it and redraws from the store like every screen
 *  does, but only when something it shows changed, so a status poll never throws away what is
 *  being typed into it. */

import { badgeFor, gameLabel, isReleased } from "./clips";
import { guildIcon, statusDot } from "./circles";
import { confirming, fill, h } from "./dom";
import { fmtWhen } from "./format";
import { t } from "./i18n";
import * as ipc from "./ipc";
import { current, go, onRoute } from "./router";
import { data, loadClips, loadSettings, on } from "./store";
import type { ClipRow, PublishGuild } from "./types";

type Guilds =
  | { state: "idle" }
  | { state: "loading" }
  | { state: "ready"; list: PublishGuild[] }
  | { state: "error"; message: string };

interface Dialog {
  id: number;
  scrim: HTMLElement;
  box: HTMLElement;
  guilds: Guilds;
  /** Ticked servers. `null` until the list first loads and the defaults are applied. */
  picked: Set<string> | null;
  title: string;
  game: string;
  /** Whether the published copies keep the microphone. Offered only when `micTrack`. */
  includeMic: boolean;
  /** The recording has the microphone on its own track; `null` until probed. */
  micTrack: boolean | null;
  busy: boolean;
  message: { text: string; error: boolean } | null;
  loginCode: string | null;
  /** What the dialog last drew, so a redraw that would change nothing is skipped. */
  key: string;
  /** Repaints the parts that follow the ticks, without rebuilding the checkboxes. */
  sync: () => void;
}

let dialog: Dialog | null = null;

export function initPublish(): void {
  on("clips", () => redraw());
  on("progress", () => redraw());
  on("status", () => {
    if (!dialog) return;
    // Linking Discord from inside the dialog: the servers can be asked for now.
    if (data.status?.account) {
      dialog.loginCode = null;
      if (dialog.guilds.state === "idle") void loadGuilds(dialog);
    }
    redraw();
  });
  // Whatever screen opened it is going away.
  onRoute(() => closePublish());
}

/** Opens the dialog for a clip. Opening it again for the same clip only brings it forward. */
export function openPublishDialog(id: number): void {
  if (dialog?.id === id) return;
  closePublish();
  const clip = data.clips.find((c) => c.id === id);
  if (!clip) return;

  const box = h("div", { class: "dialog", role: "dialog", "aria-modal": "true", tabindex: "-1" });
  const scrim = h("div", { class: "dialog-scrim" }, box);
  // The screens under the dialog listen for keys on the document; none of this dialog's keys
  // are theirs.
  scrim.addEventListener("keydown", (e) => {
    e.stopPropagation();
    if (e.key === "Escape" && !dialog?.busy) {
      e.preventDefault();
      closePublish();
    }
  });
  scrim.addEventListener("pointerdown", (e) => {
    if (e.target === scrim && !dialog?.busy) closePublish();
  });

  dialog = {
    id,
    scrim,
    box,
    guilds: { state: "idle" },
    picked: null,
    title: clip.publish_title ?? clip.game ?? "",
    game: clip.game ?? "",
    includeMic: clip.include_mic,
    micTrack: null,
    busy: false,
    message: null,
    loginCode: null,
    key: "",
    sync: () => undefined,
  };
  document.body.append(scrim);
  redraw();
  box.focus();
  if (!clip.remote_id) {
    const d = dialog;
    void ipc
      .clipAudio(id)
      .then((audio) => {
        if (dialog !== d) return;
        d.micTrack = audio.mic_track;
        redraw();
      })
      .catch((e) => console.warn("clip audio", id, e));
  }
  if (data.status?.account) {
    void loadGuilds(dialog);
    // The cache is minutes old at worst, but this is where someone checks where a clip went.
    // A change arrives as clips-changed and redraws the list.
    if (clip.remote_id) void ipc.refreshPosts().catch((e) => console.warn("refresh posts", e));
  }
}

export function closePublish(): void {
  if (!dialog) return;
  dialog.scrim.remove();
  dialog = null;
}

/** main.ts forwards a failed device login here too, for a login started from the dialog. */
export function publishLoginFailed(message: string): void {
  if (!dialog?.loginCode) return;
  dialog.loginCode = null;
  dialog.message = { text: message, error: true };
  redraw();
}

async function loadGuilds(d: Dialog): Promise<void> {
  d.guilds = { state: "loading" };
  redraw();
  try {
    const list = await ipc.listPublishGuilds();
    if (dialog !== d) return;
    d.guilds = { state: "ready", list };
    // A new clip starts from last time's choice; "post to more" starts from nothing, since
    // every server it offers is one the clip was deliberately left out of.
    const published = data.clips.find((c) => c.id === d.id)?.remote_id != null;
    if (d.picked === null) d.picked = published ? new Set() : defaultPick(list);
  } catch (e) {
    if (dialog !== d) return;
    d.guilds = { state: "error", message: explain(e) };
  }
  redraw();
}

/** Last time's servers that are still on offer, or all of them when none are. */
function defaultPick(list: PublishGuild[]): Set<string> {
  const offered = new Set(list.map((g) => g.guild_id));
  const last = (data.settings?.last_publish_guilds ?? []).filter((id) => offered.has(id));
  return new Set(last.length ? last : offered);
}

function explain(e: unknown): string {
  const text = ipc.errorText(e);
  if (text === "bot_unavailable") return t("publish.botUnavailable");
  if (text === "not_logged_in") return t("publish.notLoggedIn");
  return text;
}

// ---------------------------------------------------------------------------
// Drawing

function redraw(): void {
  const d = dialog;
  if (!d) return;
  const clip = data.clips.find((c) => c.id === d.id);
  if (!clip) {
    closePublish();
    return;
  }
  const badge = badgeFor(clip, data.progress.get(clip.id), data.status, data.settings);
  const mode = clip.remote_id ? "published" : clip.publish ? "publishing" : "new";
  const key = JSON.stringify([
    clip.remote_id,
    clip.page_url,
    clip.publish,
    clip.status,
    // Only the in-progress view shows the percentage. Anywhere else a rebuild per tick would
    // disarm a confirm button and drop the focus from a checkbox.
    mode === "publishing" ? badge.label : badge.kind,
    clip.posts,
    data.status?.account?.discord_id ?? null,
    d.guilds,
    d.busy,
    d.message,
    d.loginCode,
    d.micTrack,
  ]);
  if (key === d.key) return;
  d.key = key;
  d.sync = () => undefined;

  const heading =
    mode === "published"
      ? t("publish.titlePublished")
      : mode === "publishing"
        ? t("publish.titlePublishing")
        : t("publish.titleNew");

  const closeButton = h("button", {
    type: "button",
    class: "x",
    text: "✕",
    title: t("publish.close"),
    disabled: d.busy,
    onclick: () => closePublish(),
  });
  const head = h(
    "div",
    { class: "dialog-head" },
    statusDot(badge),
    h(
      "div",
      { class: "titles" },
      h("h2", { id: "publish-heading", text: heading }),
      h("span", { class: "sub", text: `${gameLabel(clip.game)} · ${fmtWhen(clip.recorded_at)}` }),
    ),
    closeButton,
  );
  d.box.setAttribute("aria-labelledby", "publish-heading");

  let body: HTMLElement[];
  let foot: HTMLElement[];
  if (mode === "new" && !data.status?.account) [body, foot] = loginView(d);
  else if (mode === "new") [body, foot] = newView(d, clip);
  else if (mode === "publishing") [body, foot] = publishingView(d, clip);
  else [body, foot] = publishedView(d, clip);

  const message = d.message
    ? h("span", { class: `dialog-msg${d.message.error ? " err" : " ok"}`, text: d.message.text })
    : null;
  fill(
    d.box,
    head,
    h("div", { class: "dialog-body scroll" }, ...body),
    h("div", { class: "dialog-foot" }, message, h("span", { class: "grow" }), ...foot),
  );
  d.sync();
}

function loginView(d: Dialog): [HTMLElement[], HTMLElement[]] {
  const body = d.loginCode
    ? [
        h("p", { class: "lead", text: t("publish.notLinkedDetail") }),
        h("div", { class: "device-code", text: d.loginCode }),
        h("div", { class: "note" }, h("span", { class: "spinner" }), t("publish.waitingBrowser")),
      ]
    : [
        h("b", { class: "lead-title", text: t("publish.notLinked") }),
        h("p", { class: "lead", text: t("publish.notLinkedDetail") }),
      ];
  const link = h("button", {
    type: "button",
    class: "btn primary",
    text: t("publish.linkDiscord"),
    disabled: d.busy || !!d.loginCode,
    onclick: () => void startLogin(d),
  });
  return [body, [cancelButton(d), link]];
}

function newView(d: Dialog, clip: ClipRow): [HTMLElement[], HTMLElement[]] {
  const title = h("input", {
    type: "text",
    class: "field",
    maxlength: "100",
    value: d.title,
    placeholder: t("publish.namePlaceholder"),
    spellcheck: "false",
    disabled: d.busy,
    oninput: (e: Event) => {
      d.title = (e.target as HTMLInputElement).value;
    },
  });
  const games = [...new Set(data.clips.map((c) => c.game).filter((g): g is string => !!g))].sort();
  const game = h("input", {
    type: "text",
    class: "field",
    maxlength: "100",
    value: d.game,
    list: "publish-games",
    placeholder: gameLabel(null),
    spellcheck: "false",
    disabled: d.busy,
    oninput: (e: Event) => {
      d.game = (e.target as HTMLInputElement).value;
    },
  });

  const note = h("p", { class: "note webonly", text: t("publish.webOnly") });
  const publish = h("button", {
    type: "button",
    class: "btn primary",
    text: d.busy ? t("publish.publishing") : t("publish.publish"),
    onclick: () => void doPublish(d, clip.id),
  }) as HTMLButtonElement;
  d.sync = () => {
    const g = d.guilds;
    note.hidden = g.state !== "ready" || (d.picked?.size ?? 0) > 0 || g.list.length === 0;
    publish.disabled = d.busy || g.state !== "ready";
  };

  const body = [
    h("label", { class: "dialog-field" }, h("span", { class: "label", text: t("publish.nameLabel") }), title),
    h(
      "label",
      { class: "dialog-field" },
      h("span", { class: "label", text: t("publish.gameLabel") }),
      game,
      h("datalist", { id: "publish-games" }, ...games.map((g) => h("option", { value: g }))),
    ),
    d.micTrack ? micCheck(d) : null,
    h("span", { class: "section-label", text: t("publish.servers") }),
    guildList(d, clip, []),
    note,
  ].filter((n): n is HTMLElement => n !== null);
  return [body, [cancelButton(d), publish]];
}

/** Keep or drop the microphone track. The player plays the mix, so what is heard there is the
 *  ticked state. */
function micCheck(d: Dialog): HTMLElement {
  const input = h("input", { type: "checkbox", checked: d.includeMic, disabled: d.busy }) as HTMLInputElement;
  input.addEventListener("change", () => {
    d.includeMic = input.checked;
  });
  return h(
    "label",
    { class: "guild-row mic-row" },
    h("span", { class: "check" }, input, h("span", { class: "box" })),
    h(
      "span",
      { class: "name" },
      t("publish.includeMic"),
      h("small", { class: "note", text: t("publish.includeMicNote") }),
    ),
  );
}

function publishingView(d: Dialog, clip: ClipRow): [HTMLElement[], HTMLElement[]] {
  const badge = badgeFor(clip, data.progress.get(clip.id), data.status, data.settings);
  const stop = confirming(
    h("button", { type: "button", class: "btn danger", disabled: d.busy }) as HTMLButtonElement,
    t("publish.stopPublishing"),
    t("publish.confirmStop"),
    () => void doUnpublish(d, clip.id),
  );
  const body = [
    h("div", { class: "dialog-status" }, statusDot(badge), h("b", { text: badge.label })),
    h("p", { class: "lead", text: t("publish.inProgress") }),
  ];
  return [body, [stop, closeFooterButton()]];
}

function publishedView(d: Dialog, clip: ClipRow): [HTMLElement[], HTMLElement[]] {
  const posted = new Set(clip.posts.map((p) => p.guild_id));
  const more = h("button", { type: "button", class: "btn primary" }) as HTMLButtonElement;
  more.addEventListener("click", () => void doPostMore(d, clip.id));
  d.sync = () => {
    const n = [...(d.picked ?? [])].filter((id) => !posted.has(id)).length;
    more.textContent = d.busy ? t("publish.posting") : n ? t("publish.postMore", { n }) : t("publish.postMoreNone");
    more.disabled = d.busy || n === 0;
  };

  const link = clip.page_url
    ? h(
        "div",
        { class: "dialog-link" },
        h("span", { class: "url mono", text: clip.page_url, title: clip.page_url }),
        copyButton(clip.page_url),
      )
    : null;

  // A clip whose local video the Storage tab released lives only on the site: unpublishing it
  // would delete the last copy. Rust refuses it too; this says why before anyone tries.
  const released = isReleased(clip);
  const unpublishWarning = h("p", {
    class: "note warn",
    text: t(released ? "publish.unpublishReleased" : "publish.unpublishWarning"),
    hidden: !released,
  });
  const deleteWarning = h("p", { class: "note warn", text: t("publish.deleteWarning"), hidden: true });
  const unpublish = confirming(
    h("button", { type: "button", class: "btn danger small", disabled: d.busy || released }) as HTMLButtonElement,
    t("publish.unpublish"),
    t("publish.confirmUnpublish"),
    () => void doUnpublish(d, clip.id),
    (armed) => {
      unpublishWarning.hidden = !armed && !released;
    },
  );
  const remove = confirming(
    h("button", { type: "button", class: "btn danger small", disabled: d.busy }) as HTMLButtonElement,
    t("publish.deleteEverywhere"),
    t("publish.confirmDelete"),
    () => void doDelete(d, clip.id),
    (armed) => {
      deleteWarning.hidden = !armed;
    },
  );

  const body = [
    link ? h("span", { class: "section-label", text: t("publish.link") }) : null,
    link,
    h("span", { class: "section-label", text: t("publish.servers") }),
    guildList(d, clip, clip.posts.map((p) => p.guild_id)),
    clip.posts.length ? null : h("p", { class: "note", text: t("publish.notPosted") }),
    h(
      "div",
      { class: "danger-zone" },
      h("span", { class: "section-label", text: t("publish.takeDown") }),
      h("div", { class: "row" }, unpublish, remove),
      unpublishWarning,
      deleteWarning,
    ),
  ].filter((n): n is HTMLElement => n !== null);
  return [body, [closeFooterButton(), more]];
}

/** The server checklist. `posted` servers come first, ticked and locked, each with its way to
 *  Discord; the rest are whatever the backend offers. A failed list is a line and a retry,
 *  and the posted part still shows. */
function guildList(d: Dialog, clip: ClipRow, posted: string[]): HTMLElement {
  const rows: HTMLElement[] = [];
  for (const post of clip.posts.filter((p) => posted.includes(p.guild_id))) {
    rows.push(
      h(
        "div",
        { class: "guild-row posted" },
        h("span", { class: "check" }, h("input", { type: "checkbox", checked: true, disabled: true }), h("span", { class: "box" })),
        guildIcon(post.guild_id, post.name, post.icon_url),
        h("span", { class: "name", text: post.name ?? t("publish.unnamedServer") }),
        h("button", {
          type: "button",
          class: "link",
          text: t("publish.openInDiscord"),
          onclick: () =>
            void ipc.openClipPost(clip.id, post.guild_id).catch((e) => {
              if (dialog !== d) return;
              d.message = { text: ipc.errorText(e), error: true };
              redraw();
            }),
        }),
      ),
    );
  }

  const g = d.guilds;
  if (g.state === "loading" || g.state === "idle") {
    rows.push(h("div", { class: "guild-state muted" }, h("span", { class: "spinner" }), ` ${t("publish.loadingServers")}`));
  } else if (g.state === "error") {
    rows.push(
      h(
        "div",
        { class: "guild-state err" },
        h("span", { text: g.message }),
        h("button", {
          type: "button",
          class: "btn small",
          text: t("publish.retry"),
          onclick: () => void loadGuilds(d),
        }),
      ),
    );
  } else {
    const offered = g.list.filter((guild) => !posted.includes(guild.guild_id));
    if (!g.list.length) rows.push(h("p", { class: "note", text: t("publish.noServers") }));
    for (const guild of offered) {
      const input = h("input", {
        type: "checkbox",
        checked: d.picked?.has(guild.guild_id) ?? false,
        disabled: d.busy,
      }) as HTMLInputElement;
      input.addEventListener("change", () => {
        d.picked ??= new Set();
        if (input.checked) d.picked.add(guild.guild_id);
        else d.picked.delete(guild.guild_id);
        d.sync();
      });
      rows.push(
        h(
          "label",
          { class: "guild-row" },
          h("span", { class: "check" }, input, h("span", { class: "box" })),
          guildIcon(guild.guild_id, guild.name, guild.icon_url),
          h("span", { class: "name", text: guild.name ?? t("publish.unnamedServer") }),
        ),
      );
    }
  }
  return h("div", { class: "guild-list" }, ...rows);
}

function cancelButton(d: Dialog): HTMLElement {
  return h("button", {
    type: "button",
    class: "btn",
    text: t("publish.cancel"),
    disabled: d.busy,
    onclick: () => closePublish(),
  });
}

function closeFooterButton(): HTMLElement {
  return h("button", { type: "button", class: "btn", text: t("publish.close"), onclick: () => closePublish() });
}

function copyButton(url: string): HTMLButtonElement {
  const button = h("button", { type: "button", class: "btn small", text: t("publish.copyLink") }) as HTMLButtonElement;
  button.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(url);
      button.textContent = t("library.copied");
    } catch {
      button.textContent = t("library.copyFailed");
    }
    window.setTimeout(() => {
      button.textContent = t("publish.copyLink");
    }, 1500);
  });
  return button;
}

// ---------------------------------------------------------------------------
// Actions

/** Runs one action with the dialog locked, and keeps it open with the error when it fails. */
async function run(d: Dialog, pending: string, action: () => Promise<string | null>): Promise<void> {
  d.busy = true;
  d.message = { text: pending, error: false };
  redraw();
  try {
    const done = await action();
    if (dialog !== d) return;
    d.busy = false;
    d.message = done ? { text: done, error: false } : null;
  } catch (e) {
    if (dialog !== d) return;
    d.busy = false;
    d.message = { text: explain(e), error: true };
  }
  redraw();
}

async function doPublish(d: Dialog, id: number): Promise<void> {
  const title = d.title.trim() || null;
  const game = d.game.trim() || null;
  await run(d, t("publish.publishing"), async () => {
    await ipc.publishClip(id, title, game, [...(d.picked ?? [])], d.includeMic);
    await Promise.all([loadClips(), loadSettings()]);
    closePublish();
    return null;
  });
}

async function doPostMore(d: Dialog, id: number): Promise<void> {
  const clip = data.clips.find((c) => c.id === id);
  const posted = new Set(clip?.posts.map((p) => p.guild_id) ?? []);
  const wanted = [...(d.picked ?? [])].filter((g) => !posted.has(g));
  if (!wanted.length) return;
  await run(d, t("publish.posting"), async () => {
    await ipc.addClipPosts(id, wanted);
    for (const g of wanted) d.picked?.delete(g);
    return t("publish.posted");
  });
}

async function doUnpublish(d: Dialog, id: number): Promise<void> {
  await run(d, t("publish.unpublishing"), async () => {
    await ipc.unpublishClip(id);
    await loadClips();
    closePublish();
    return null;
  });
}

async function doDelete(d: Dialog, id: number): Promise<void> {
  await run(d, t("publish.deleting"), async () => {
    await ipc.deleteClip(id);
    closePublish();
    const route = current();
    if (route.view === "player" || route.view === "editor") {
      if (route.id === id) go({ view: "library" });
    }
    await loadClips();
    return null;
  });
}

async function startLogin(d: Dialog): Promise<void> {
  await run(d, t("settings.contacting"), async () => {
    const started = await ipc.startLogin();
    d.loginCode = started.code;
    return t("settings.browserFallback", { url: started.verify_url });
  });
}
