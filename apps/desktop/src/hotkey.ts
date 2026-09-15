/** The hotkey picker, for saving clips and for markers.
 *
 *  Builds a Tauri shortcut string such as "Alt+F10" or "Ctrl+Shift+F9" from
 *  `KeyboardEvent.code`, which the global-hotkey parser accepts verbatim (KeyA, Digit1, F10).
 *  Keyboard-first: the control takes focus, Enter starts listening, Esc cancels. An optional
 *  hotkey also has a way to turn it off, which is the empty string. */

import { h } from "./dom";
import { t } from "./i18n";

const MODIFIER_CODES = new Set([
  "ControlLeft",
  "ControlRight",
  "ShiftLeft",
  "ShiftRight",
  "AltLeft",
  "AltRight",
  "MetaLeft",
  "MetaRight",
]);

const F_KEY = /^F([1-9]|1[0-9]|2[0-4])$/;

function prettyKey(code: string): string {
  if (code.startsWith("Key") && code.length === 4) return code.slice(3);
  if (code.startsWith("Digit") && code.length === 6) return code.slice(5);
  return code;
}

/** Injected input (SendKeys, some remote tools) arrives with an empty `code`. */
function codeFromKey(key: string): string {
  if (F_KEY.test(key)) return key;
  if (/^[a-zA-Z]$/.test(key)) return `Key${key.toUpperCase()}`;
  if (/^[0-9]$/.test(key)) return `Digit${key}`;
  return "";
}

function modifiers(e: KeyboardEvent): string[] {
  const mods: string[] = [];
  if (e.ctrlKey) mods.push("Ctrl");
  if (e.altKey) mods.push("Alt");
  if (e.shiftKey) mods.push("Shift");
  if (e.metaKey) mods.push("Super");
  return mods;
}

export interface HotkeyControl {
  /** The whole block: the key box, the cancel button and the two hint lines. */
  node: HTMLElement;
  /** The shortcut as it stands, which is what a save should send. */
  value(): string;
  /** Leaves listening mode, keeping whatever was chosen. Called before saving. */
  stop(): void;
  /** Replaces the shortcut, e.g. after the backend rejected a new one. */
  set(hotkey: string): void;
}

export interface HotkeyOptions {
  name: string;
  note: string;
  /** Offer a way to turn the hotkey off. */
  optional?: boolean;
}

export function hotkeyControl(
  initial: string,
  onChange?: (hotkey: string) => void,
  options: HotkeyOptions = { name: t("hotkey.name"), note: t("hotkey.note") },
): HotkeyControl {
  let value = initial;
  let listening = false;

  const shown = () => value || t("hotkey.off");
  const box = h("button", { type: "button", class: "hotkey mono", text: shown() });
  const off = options.optional
    ? (h("button", {
        type: "button",
        class: "btn small",
        text: t("hotkey.turnOff"),
        hidden: !value,
        onclick: () => {
          value = "";
          stop();
          paint();
          onChange?.(value);
        },
      }) as HTMLButtonElement)
    : null;
  const cancel = h("button", {
    type: "button",
    class: "btn small",
    hidden: true,
    title: t("hotkey.stopListening"),
  });
  cancel.append(
    t("hotkey.cancel"),
    h("span", { class: "mono", style: "font-size:11px", text: "Esc" }),
  );
  const warn = h("span", { class: "warn" });

  const paint = () => {
    box.classList.toggle("listening", listening);
    box.classList.toggle("off", !value && !listening);
    cancel.hidden = !listening;
    if (off) off.hidden = listening || !value;
    if (!listening) box.textContent = shown();
  };

  const showHeld = (mods: string[]) => {
    box.replaceChildren(
      mods.length ? `${mods.join("+")}+` : "",
      h("span", { class: "caret", text: "…" }),
    );
  };

  const onKey = (e: KeyboardEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (e.code === "Escape" || e.key === "Escape") {
      stop();
      warn.textContent = "";
      return;
    }
    const mods = modifiers(e);
    const code = e.code || codeFromKey(e.key);
    if (!code || MODIFIER_CODES.has(code) || ["Control", "Shift", "Alt", "Meta"].includes(e.key)) {
      showHeld(mods);
      return;
    }
    if (!mods.length && !F_KEY.test(code)) {
      showHeld([]);
      warn.textContent = t("hotkey.needsModifier");
      return;
    }
    value = [...mods, prettyKey(code)].join("+");
    warn.textContent = "";
    stop();
    onChange?.(value);
  };

  const start = () => {
    if (listening) return;
    listening = true;
    warn.textContent = "";
    showHeld([]);
    paint();
    window.addEventListener("keydown", onKey, true);
  };

  const stop = () => {
    if (!listening) return;
    listening = false;
    window.removeEventListener("keydown", onKey, true);
    paint();
  };

  box.addEventListener("click", () => (listening ? stop() : start()));
  box.addEventListener("keydown", (e) => {
    // Enter on the focused control starts listening; after that the capture handler has it.
    if (!listening && e.key === "Enter") {
      e.preventDefault();
      start();
    }
  });
  cancel.addEventListener("click", stop);

  const node = h(
    "div",
    { class: "hotkey-block" },
    h("span", { class: "name", text: options.name }),
    h("div", { class: "hotkey-row" }, box, cancel, off),
    warn,
    h("span", { class: "note", text: options.note }),
  );
  paint();

  return {
    node,
    value: () => value,
    stop,
    set(hotkey: string) {
      value = hotkey;
      stop();
      paint();
    },
  };
}
