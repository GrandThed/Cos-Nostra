/** The whole view layer's vocabulary: build an element, find one, swap one out. No framework,
 *  because every component in the design is one element and one class. */

import { t } from "./i18n";

type Child = Node | string | number | null | undefined | false;

export interface Attrs {
  class?: string;
  text?: string;
  html?: string;
  /** Anything else is set as an attribute, except `on*` (a listener) and `data-*`. */
  [key: string]: unknown;
}

export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs?: Attrs | null,
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs ?? {})) {
    if (value === null || value === undefined || value === false) continue;
    if (key === "class") node.className = String(value);
    else if (key === "text") node.textContent = String(value);
    else if (key === "html") node.innerHTML = String(value);
    else if (key.startsWith("on")) node.addEventListener(key.slice(2), value as EventListener);
    else if (value === true) node.setAttribute(key, "");
    else node.setAttribute(key, String(value));
  }
  append(node, children);
  return node;
}

export function append(parent: Node, children: Child[]): void {
  for (const child of children) {
    if (child === null || child === undefined || child === false) continue;
    parent.appendChild(typeof child === "object" ? child : document.createTextNode(String(child)));
  }
}

export const el = <T extends HTMLElement = HTMLElement>(id: string) =>
  document.getElementById(id) as T;

/** Replaces everything inside `parent`. */
export function fill(parent: HTMLElement, ...children: Child[]): void {
  parent.replaceChildren();
  append(parent, children);
}

/** A button that needs a second click to do anything, re-arming after three seconds.
 *  Used by every destructive action, per the inventory board. */
export function confirming(
  button: HTMLButtonElement,
  idle: string,
  armed: string,
  run: () => void,
  onArm?: (isArmed: boolean) => void,
): HTMLButtonElement {
  let timer = 0;
  const disarm = () => {
    window.clearTimeout(timer);
    timer = 0;
    button.textContent = idle;
    button.classList.remove("armed");
    onArm?.(false);
  };
  button.textContent = idle;
  button.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (timer) {
      disarm();
      run();
      return;
    }
    button.textContent = armed;
    button.classList.add("armed");
    onArm?.(true);
    timer = window.setTimeout(disarm, 3000);
  });
  return button;
}

/** Turns an editable label into a text box until Enter or Esc. Empty saves as `null`, which
 *  is how a clip goes back to "Unknown game". */
export function editInline(
  label: HTMLElement,
  current: string,
  save: (value: string | null) => void,
  opts: { class?: string; placeholder?: string } = {},
): void {
  const box = h("input", {
    type: "text",
    class: opts.class ?? "field",
    value: current,
    placeholder: opts.placeholder ?? t("clips.unknownGame"),
    spellcheck: "false",
  });
  let finished = false;
  const finish = (commit: boolean) => {
    if (finished) return;
    finished = true;
    const value = box.value.trim();
    box.replaceWith(label);
    if (commit && value !== current) save(value || null);
  };
  box.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      finish(true);
    }
    if (e.key === "Escape") {
      e.preventDefault();
      finish(false);
    }
  });
  box.addEventListener("blur", () => finish(true));
  label.replaceWith(box);
  box.focus();
  box.select();
}
