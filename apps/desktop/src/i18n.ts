/** Every user-facing string, looked up by a dotted path into the chosen language.
 *
 *  `t("player.rail.length")` walks `locales/<lang>.ts`; `{name}` anywhere in a string is
 *  replaced by `params.name`, so `t("clips.badge.retrying", { attempts: 2, max: 5 })` fills
 *  both. That is the whole substitution convention: no plurals, no formats, just names in
 *  braces. Spanish is the canonical dictionary — a key missing from another language falls
 *  back to it, and then to the key itself, so a typo shows up on screen instead of throwing. */

import en from "./locales/en";
import es from "./locales/es";
import { data, on } from "./store";
import type { Language } from "./types";

type Dict = { [key: string]: string | Dict };

type Dotted<T> = {
  [K in keyof T & string]: T[K] extends string ? K : `${K}.${Dotted<T[K]>}`;
}[keyof T & string];

export type Key = Dotted<typeof es>;

const DICTS: Record<Language, Dict> = { en, es };

/** Rust defaults to Spanish, so settings that have not loaded yet read as Spanish too. */
export function language(): Language {
  return data.settings?.language ?? "es";
}

/** The tag `Intl` formats dates with. */
export function locale(): string {
  return language() === "en" ? "en-GB" : "es-ES";
}

function lookup(dict: Dict, key: string): string | undefined {
  let node: string | Dict | undefined = dict;
  for (const part of key.split(".")) {
    if (typeof node !== "object") return undefined;
    node = node[part];
  }
  return typeof node === "string" ? node : undefined;
}

export function t(key: Key, params?: Record<string, string | number>): string {
  const raw = lookup(DICTS[language()], key) ?? lookup(es, key) ?? key;
  if (!params) return raw;
  return raw.replace(/\{(\w+)\}/g, (whole, name: string) =>
    name in params ? String(params[name]) : whole,
  );
}

/** Runs `fn` when the language actually changed. Settings reload for a dozen other reasons,
 *  and a screen that redraws wholesale should not do it on every one of them. */
export function onLanguage(fn: () => void): void {
  let seen = language();
  on("settings", () => {
    if (language() === seen) return;
    seen = language();
    fn();
  });
}
