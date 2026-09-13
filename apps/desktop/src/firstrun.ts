/** Three steps on a fresh install, then out of the way for good.
 *
 *  Step 1 is the OBS runtime download, which is why the window opens before the recorder does:
 *  400 MB with no explanation is the worst first minute an app can have. Step 2 is the encoder
 *  probe. Step 3 links Discord, and can be skipped — clips just stay on this PC. */

import { el, fill, h } from "./dom";
import * as ipc from "./ipc";
import { data, loadSettings, loadStatus, on } from "./store";

type Step = "runtime" | "probe" | "discord";

let visible = false;
/** Set while `finish` is in flight, so a status poll cannot start a second one. */
let closing = false;
let pendingCode: string | null = null;
let verifyUrl = "";
let note = "";

export function initFirstRun(): void {
  for (const topic of ["bootstrap", "status", "settings"] as const) {
    on(topic, () => {
      if (visible) render();
    });
  }
}

/** Shows the flow when this machine has never run the app, or whenever the runtime is still
 *  being installed — a fresh install is not the only way to meet that wait. */
export function syncFirstRun(): void {
  const settings = data.settings;
  const installing = data.bootstrap.phase !== "ready" && data.bootstrap.phase !== "failed";
  const wanted = installing || settings?.first_run_done === false;
  if (wanted === visible) {
    if (visible) render();
    return;
  }
  visible = wanted;
  el("first-run").hidden = !visible;
  if (visible) render();
}


function currentStep(): Step {
  if (data.bootstrap.phase !== "ready" && data.bootstrap.phase !== "failed") return "runtime";
  // The probe writes the encoders into settings, so having them is what "done" means here.
  if (!data.status?.encoders && !data.status?.ffmpeg_error) return "probe";
  return "discord";
}

function render(): void {
  const step = currentStep();
  // The link landed: close the flow rather than making them press anything. Guarded because
  // render runs on every status poll, and finishing is a write.
  if (step === "discord" && data.status?.account && !closing) {
    closing = true;
    void finish();
    return;
  }
  fill(
    el("first-run"),
    step === "runtime" ? runtimeStep() : step === "probe" ? probeStep() : discordStep(),
  );
}

function stepOf(n: number): HTMLElement {
  return h("span", { class: "of", text: `Step ${n} of 3` });
}

function runtimeStep(): HTMLElement {
  const b = data.bootstrap;
  const progress = b.phase === "downloading" || b.phase === "extracting" ? b.progress : 0;
  const extracting = b.phase === "extracting";
  return h(
    "div",
    { class: "step" },
    h("span", { class: "mark" }),
    h("h2", { text: extracting ? "Unpacking the recorder" : "Getting the recorder" }),
    h("span", {
      class: "blurb",
      text: "Cos Nostra needs its recording engine — about 400 MB, downloaded once. The app restarts by itself when it's done.",
    }),
    h("div", { class: "progress" }, h("span", { style: `width:${Math.round(progress * 100)}%` })),
    h("span", {
      class: "counter",
      text:
        b.phase === "restarting"
          ? "restarting…"
          : b.phase === "downloading" || b.phase === "extracting"
            ? (b.message || `${Math.round(progress * 100)}%`)
            : "starting…",
    }),
    stepOf(1),
  );
}

function probeStep(): HTMLElement {
  const s = data.status;
  const encoders = s?.encoders;
  const line = (label: string, value: string | null) =>
    h(
      "span",
      { class: value ? "done" : "pending" },
      h("span", { text: "●" }),
      h("span", { class: "muted" }, ` ${label} — `),
      value ? h("span", { class: "mono", text: value }) : h("span", { text: "probing…" }),
    );

  return h(
    "div",
    { class: "step" },
    h("span", { class: "big-spinner" }),
    h("h2", { text: "Checking what your PC can do" }),
    h("span", { class: "blurb", text: "Looking for hardware encoders so clips are ready in seconds." }),
    h(
      "div",
      { class: "checklist" },
      line("Replay buffer", s?.encoder ?? null),
      line("AV1", encoders?.av1 ?? null),
      line("H.264", encoders?.h264 ?? null),
    ),
    s?.ffmpeg_error
      ? h("span", {
          class: "failure",
          text: `ffmpeg is not available, so clips cannot be encoded: ${s.ffmpeg_error}`,
        })
      : null,
    h(
      "div",
      { class: "buttons" },
      h("button", { type: "button", class: "btn", text: "Skip", onclick: () => void finish() }),
    ),
    stepOf(2),
  );
}

function discordStep(): HTMLElement {
  return h(
    "div",
    { class: "step" },
    h("h2", { text: "Link Discord" }),
    h("span", {
      class: "blurb",
      text: pendingCode
        ? "So your clips can land in the server. Your browser just opened — check this code matches:"
        : "So your clips can land in the server. This opens your browser to log in with Discord.",
    }),
    pendingCode ? h("span", { class: "code", text: pendingCode }) : null,
    pendingCode
      ? h(
          "span",
          { class: "waiting" },
          h("span", { class: "spinner" }),
          " waiting for the browser… times out in 10 min",
        )
      : null,
    pendingCode && verifyUrl
      ? h("span", { class: "fallback" }, "Browser didn't open? Go to ", h("em", { text: verifyUrl }))
      : null,
    note ? h("span", { class: "failure", text: note }) : null,
    h(
      "div",
      { class: "buttons" },
      pendingCode
        ? h("button", {
            type: "button",
            class: "btn",
            text: "Cancel",
            onclick: () => {
              pendingCode = null;
              void ipc.cancelLogin();
              render();
            },
          })
        : h("button", {
            type: "button",
            class: "btn primary",
            text: "Link Discord",
            onclick: () => void startLogin(),
          }),
      h("button", {
        type: "button",
        class: "btn",
        text: "Skip — clips stay on this PC",
        onclick: () => void finish(),
      }),
    ),
    stepOf(3),
  );
}

async function startLogin(): Promise<void> {
  note = "";
  try {
    const started = await ipc.startLogin();
    pendingCode = started.code;
    verifyUrl = started.verify_url;
  } catch (e) {
    note = ipc.errorText(e);
  }
  render();
}

/** Tells the first-run flow how the device login is going, from main's event listeners. */
export function loginFailed(message: string): void {
  pendingCode = null;
  note = message;
  if (visible) render();
}

async function finish(): Promise<void> {
  pendingCode = null;
  try {
    await ipc.finishFirstRun();
  } catch (e) {
    console.error("finishing the first run", e);
  }
  await loadSettings();
  void loadStatus();
  syncFirstRun();
}
