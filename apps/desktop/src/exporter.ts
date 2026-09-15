/** The export dialog: a clip into a file of the player's choosing, outside publishing. The
 *  recording as it is, a file that fits a size (a Discord attachment limit, say), or a codec,
 *  resolution, frame rate and quality picked by hand. Rust asks where to save it
 *  (`export_clip`) and reports progress as `export-progress`.
 *
 *  It sits over whatever opened it like the publish dialog and uses the same pieces. */

import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { gameLabel } from "./clips";
import { fill, h } from "./dom";
import { fmtBytes, fmtWhen } from "./format";
import { t } from "./i18n";
import * as ipc from "./ipc";
import { onRoute } from "./router";
import { data } from "./store";
import type { ExportCodec, ExportCodecs, Exported, ExportLevel, ExportMode, ExportOptions } from "./types";

const MODES: ExportMode[] = ["original", "size", "custom"];
const LEVELS: ExportLevel[] = ["low", "medium", "high", "ultra"];
/** `export::HEIGHTS` and `export::RATES`. */
const HEIGHTS = [2160, 1440, 1080, 720, 480];
const RATES = [60, 30];
/** Discord's attachment limits: free, Nitro Basic, Nitro. */
const SIZES = [10, 50, 500];
const MIN_MB = 1;
const MAX_MB = 4096;

type State =
  | { phase: "choosing" }
  | { phase: "running"; percent: number }
  | { phase: "done"; exported: Exported }
  | { phase: "error"; message: string };

interface Dialog {
  id: number;
  scrim: HTMLElement;
  box: HTMLElement;
  options: ExportOptions;
  codecs: ExportCodecs | null;
  micTrack: boolean;
  state: State;
  unlisten: UnlistenFn | null;
}

let dialog: Dialog | null = null;
/** What was picked last time, so a second export starts from it. */
let remembered: ExportOptions | null = null;

export function initExporter(): void {
  onRoute(() => closeExport());
}

export function openExportDialog(id: number): void {
  if (dialog?.id === id) return;
  closeExport();
  const clip = data.clips.find((c) => c.id === id);
  if (!clip) return;

  const box = h("div", { class: "dialog export-dialog", role: "dialog", "aria-modal": "true", tabindex: "-1" });
  const scrim = h("div", { class: "dialog-scrim" }, box);
  scrim.addEventListener("keydown", (e) => {
    e.stopPropagation();
    if (e.key === "Escape" && dialog?.state.phase !== "running") {
      e.preventDefault();
      closeExport();
    }
  });
  scrim.addEventListener("pointerdown", (e) => {
    if (e.target === scrim && dialog?.state.phase !== "running") closeExport();
  });

  const d: Dialog = {
    id,
    scrim,
    box,
    options: {
      ...(remembered ?? {
        mode: "size",
        codec: "h264",
        height: null,
        fps: null,
        level: "high",
        target_mb: 10,
        include_mic: clip.include_mic,
      }),
    },
    codecs: null,
    micTrack: false,
    state: { phase: "choosing" },
    unlisten: null,
  };
  dialog = d;
  document.body.append(scrim);
  draw();
  box.focus();

  void ipc
    .exportCodecs()
    .then((codecs) => {
      if (dialog !== d) return;
      d.codecs = codecs;
      if (!codecs.hevc && d.options.codec === "hevc") d.options.codec = "h264";
      draw();
    })
    .catch((e) => console.warn("export codecs", e));
  void ipc
    .clipAudio(id)
    .then((audio) => {
      if (dialog !== d) return;
      d.micTrack = audio.mic_track;
      draw();
    })
    .catch((e) => console.warn("clip audio", id, e));
}

export function closeExport(): void {
  if (!dialog) return;
  dialog.unlisten?.();
  dialog.scrim.remove();
  dialog = null;
}

// ---------------------------------------------------------------------------
// Drawing

function draw(): void {
  const d = dialog;
  if (!d) return;
  const clip = data.clips.find((c) => c.id === d.id);
  if (!clip) {
    closeExport();
    return;
  }
  const running = d.state.phase === "running";
  const head = h(
    "div",
    { class: "dialog-head" },
    h(
      "div",
      { class: "titles" },
      h("h2", { id: "export-heading", text: t("exporter.title") }),
      h("span", { class: "sub", text: `${gameLabel(clip.game)} · ${fmtWhen(clip.recorded_at)}` }),
    ),
    h("button", {
      type: "button",
      class: "x",
      text: "✕",
      title: t("exporter.close"),
      disabled: running,
      onclick: () => closeExport(),
    }),
  );
  d.box.setAttribute("aria-labelledby", "export-heading");

  if (d.state.phase === "done") {
    const exported = d.state.exported;
    fill(
      d.box,
      head,
      h(
        "div",
        { class: "dialog-body" },
        h("b", { class: "lead-title", text: t("exporter.done", { size: fmtBytes(exported.size) }) }),
        h("span", { class: "note mono export-path", text: exported.path, title: exported.path }),
      ),
      h(
        "div",
        { class: "dialog-foot" },
        h("span", { class: "grow" }),
        h("button", {
          type: "button",
          class: "btn",
          text: t("exporter.showInFolder"),
          onclick: () => void ipc.revealExport(exported.path).catch((e) => console.warn("reveal export", e)),
        }),
        h("button", { type: "button", class: "btn primary", text: t("exporter.close"), onclick: () => closeExport() }),
      ),
    );
    return;
  }

  const o = d.options;
  const body = h(
    "div",
    { class: "dialog-body scroll" },
    modeCards(d),
    o.mode === "original" ? h("p", { class: "note", text: t("exporter.originalNote") }) : null,
    o.mode === "size" ? sizeFields(d) : null,
    o.mode === "custom" ? customFields(d, clip.height) : null,
    d.micTrack ? micCheck(d) : null,
  );
  // Nothing can change mid-export.
  for (const input of body.querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLButtonElement>("input, select, button")) {
    if (running) input.disabled = true;
  }

  const message =
    d.state.phase === "running"
      ? h("span", { class: "dialog-msg" }, h("span", { class: "spinner" }), ` ${t("exporter.running", { percent: d.state.percent })}`)
      : d.state.phase === "error"
        ? h("span", { class: "dialog-msg err", text: d.state.message })
        : null;
  fill(
    d.box,
    head,
    body,
    h(
      "div",
      { class: "dialog-foot" },
      message,
      h("span", { class: "grow" }),
      h("button", { type: "button", class: "btn", text: t("exporter.cancel"), disabled: running, onclick: () => closeExport() }),
      h("button", {
        type: "button",
        class: "btn primary",
        text: running ? t("exporter.exporting") : t("exporter.export"),
        disabled: running,
        onclick: () => void run(d),
      }),
    ),
  );
}

function modeCards(d: Dialog): HTMLElement {
  const group = h("div", { class: "cards wrap", role: "radiogroup" });
  for (const mode of MODES) {
    group.append(
      h(
        "button",
        {
          type: "button",
          class: "radio-card",
          role: "radio",
          "aria-checked": String(d.options.mode === mode),
          onclick: () => {
            d.options.mode = mode;
            if (d.state.phase === "error") d.state = { phase: "choosing" };
            draw();
          },
        },
        h("b", { text: t(`exporter.mode.${mode}.label`) }),
        h("small", { text: t(`exporter.mode.${mode}.hint`) }),
      ),
    );
  }
  return group;
}

function codecSelect(d: Dialog): HTMLElement {
  const codecs: ExportCodec[] = ["h264", "hevc", "av1"];
  const select = h("select", {
    class: "field",
    onchange: (e: Event) => {
      d.options.codec = (e.target as HTMLSelectElement).value as ExportCodec;
    },
  }) as HTMLSelectElement;
  for (const codec of codecs) {
    const unavailable = codec === "hevc" && d.codecs !== null && !d.codecs.hevc;
    select.append(
      h("option", {
        value: codec,
        text: unavailable ? t("exporter.codec.hevcMissing") : t(`exporter.codec.${codec}`),
        disabled: unavailable || (codec === "hevc" && d.codecs === null),
      }),
    );
  }
  select.value = d.options.codec;
  return h("label", { class: "dialog-field" }, h("span", { class: "label", text: t("exporter.codecLabel") }), select);
}

function sizeFields(d: Dialog): HTMLElement {
  const o = d.options;
  const input = h("input", {
    type: "number",
    class: "field num mono",
    min: String(MIN_MB),
    max: String(MAX_MB),
    step: "1",
    value: String(o.target_mb ?? 10),
  }) as HTMLInputElement;
  input.addEventListener("input", () => {
    const mb = Number(input.value);
    o.target_mb = Number.isFinite(mb) ? mb : null;
    for (const chip of chips.children) chip.setAttribute("aria-pressed", String(Number((chip as HTMLElement).dataset.mb) === mb));
  });
  const chips = h(
    "div",
    { class: "chips" },
    ...SIZES.map((mb) =>
      h("button", {
        type: "button",
        class: "chip",
        "data-mb": String(mb),
        "aria-pressed": String(o.target_mb === mb),
        text: t(`exporter.size.chip${mb}` as "exporter.size.chip10"),
        onclick: () => {
          o.target_mb = mb;
          input.value = String(mb);
          for (const chip of chips.children) chip.setAttribute("aria-pressed", String(chip.getAttribute("data-mb") === String(mb)));
        },
      }),
    ),
  );
  return h(
    "div",
    { class: "export-fields" },
    h(
      "div",
      { class: "dialog-field" },
      h("span", { class: "label", text: t("exporter.size.label") }),
      h("div", { class: "field-row" }, input, h("span", { class: "hint", text: "MB" }), chips),
    ),
    codecSelect(d),
    h("p", { class: "note", text: t("exporter.size.note") }),
  );
}

function customFields(d: Dialog, sourceHeight: number): HTMLElement {
  const o = d.options;
  const select = (label: string, values: (number | null)[], current: number | null, set: (v: number | null) => void, name: (v: number | null) => string) => {
    const node = h("select", {
      class: "field",
      onchange: (e: Event) => {
        const v = (e.target as HTMLSelectElement).value;
        set(v === "" ? null : Number(v));
      },
    }) as HTMLSelectElement;
    for (const v of values) node.append(h("option", { value: v === null ? "" : String(v), text: name(v) }));
    node.value = current === null ? "" : String(current);
    return h("label", { class: "dialog-field" }, h("span", { class: "label", text: label }), node);
  };
  // Only heights below the recording's: exporting never scales up.
  const heights = HEIGHTS.filter((height) => !sourceHeight || height < sourceHeight);
  if (o.height !== null && !heights.includes(o.height)) o.height = null;
  const levels = h("div", { class: "cards wrap", role: "radiogroup" });
  for (const level of LEVELS) {
    const card = h(
      "button",
      {
        type: "button",
        class: "radio-card",
        role: "radio",
        "aria-checked": String(o.level === level),
        onclick: () => {
          o.level = level;
          for (const other of levels.children) other.setAttribute("aria-checked", String(other === card));
        },
      },
      h("b", { text: t(`exporter.level.${level}`) }),
    );
    levels.append(card);
  }
  return h(
    "div",
    { class: "export-fields" },
    codecSelect(d),
    h(
      "div",
      { class: "export-pair" },
      select(t("exporter.resolution"), [null, ...heights], o.height, (v) => (o.height = v), (v) =>
        v === null ? t("exporter.asRecorded", { value: sourceHeight ? `${sourceHeight}p` : "" }) : `${v}p`,
      ),
      select(t("exporter.frameRate"), [null, ...RATES], o.fps, (v) => (o.fps = v), (v) =>
        v === null ? t("exporter.asRecordedPlain") : `${v} fps`,
      ),
    ),
    h("span", { class: "label section-label", text: t("exporter.quality") }),
    levels,
  );
}

function micCheck(d: Dialog): HTMLElement {
  const input = h("input", { type: "checkbox", checked: d.options.include_mic }) as HTMLInputElement;
  input.addEventListener("change", () => {
    d.options.include_mic = input.checked;
  });
  return h(
    "label",
    { class: "guild-row mic-row" },
    h("span", { class: "check" }, input, h("span", { class: "box" })),
    h("span", { class: "name" }, t("publish.includeMic"), h("small", { class: "note", text: t("exporter.micNote") })),
  );
}

// ---------------------------------------------------------------------------
// Running

async function run(d: Dialog): Promise<void> {
  const o = d.options;
  if (o.mode === "size" && (o.target_mb === null || o.target_mb < MIN_MB || o.target_mb > MAX_MB)) {
    d.state = { phase: "error", message: t("exporter.size.invalid", { min: MIN_MB, max: MAX_MB }) };
    draw();
    return;
  }
  remembered = { ...o };
  d.state = { phase: "running", percent: 0 };
  d.unlisten?.();
  d.unlisten = await listen<{ id: number; percent: number }>("export-progress", (e) => {
    if (dialog !== d || e.payload.id !== d.id || d.state.phase !== "running") return;
    d.state = { phase: "running", percent: e.payload.percent };
    const msg = d.box.querySelector(".dialog-msg");
    if (msg) fill(msg as HTMLElement, h("span", { class: "spinner" }), ` ${t("exporter.running", { percent: e.payload.percent })}`);
  });
  draw();
  try {
    const exported = await ipc.exportClip(d.id, {
      ...o,
      // Only what the mode uses travels, so a stale pick never changes the file.
      height: o.mode === "custom" ? o.height : null,
      fps: o.mode === "custom" ? o.fps : null,
      target_mb: o.mode === "size" ? o.target_mb : null,
    });
    if (dialog !== d) return;
    d.state = exported ? { phase: "done", exported } : { phase: "choosing" };
  } catch (e) {
    if (dialog !== d) return;
    d.state = { phase: "error", message: ipc.errorText(e) };
  } finally {
    d.unlisten?.();
    d.unlisten = null;
  }
  draw();
}
