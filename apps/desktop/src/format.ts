/** Numbers and dates as the design writes them. */

import { locale, t } from "./i18n";

/** Sizes as the design writes them: three significant figures at most, so "212 MB" and
 *  "6.1 MB" and "51.5 GB" but never "212.4 MB". The decimal mark is the language's, so Spanish
 *  reads "6,1 MB". */
export function fmtBytes(n: number | null | undefined): string {
  if (n === null || n === undefined || n < 0) return "–";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  if (n < 1024 * 1024 * 1024) {
    const mb = n / (1024 * 1024);
    return `${mb >= 100 ? Math.round(mb) : fmtDecimal(mb, 1)} MB`;
  }
  const gb = n / (1024 * 1024 * 1024);
  return `${gb >= 100 ? Math.round(gb) : fmtDecimal(gb, 1)} GB`;
}

/** `toFixed` with the language's decimal mark and no grouping, so "12,5" in Spanish and a
 *  four-digit count never grows a thousands separator. */
export function fmtDecimal(n: number, digits: number): string {
  return n.toLocaleString(locale(), {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
    useGrouping: false,
  });
}

/** m:ss, which is what a clip always is. */
export function fmtDuration(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}

export function fmtClock(seconds: number): string {
  return fmtDuration(seconds * 1000);
}

export function fmtCount(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

function startOfDay(d: Date): number {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}

/** Days between `then` and today: 0 today, 1 yesterday, and so on. */
function daysAgo(then: Date): number {
  const day = 24 * 60 * 60 * 1000;
  return Math.round((startOfDay(new Date()) - startOfDay(then)) / day);
}

const TIME: Intl.DateTimeFormatOptions = { hour: "2-digit", minute: "2-digit", hour12: false };

/** The day a clip belongs to, as a heading: "Today", "Yesterday", "Tuesday", "12 August". */
export function dayLabel(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return t("format.earlier");
  const ago = daysAgo(d);
  if (ago <= 0) return t("format.tonight");
  if (ago === 1) return t("format.yesterday");
  if (ago < 7) return d.toLocaleDateString(locale(), { weekday: "long" });
  return d.toLocaleDateString(locale(), { day: "numeric", month: "long" });
}

/** "Today 01:12" — the day label plus the clock, which is how every clip is named. */
export function fmtWhen(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return `${dayLabel(iso)} ${d.toLocaleTimeString(locale(), TIME)}`;
}

/** The same, with a comma, for the metadata grid: "Today, 01:12". */
export function fmtWhenLong(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return `${dayLabel(iso)}, ${d.toLocaleTimeString(locale(), TIME)}`;
}

export function fmtTimeOnly(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleTimeString(locale(), TIME);
}

/** A stable hue per clip, so the placeholder behind a missing thumbnail is at least its own. */
export function hueFor(id: number): number {
  return (id * 47) % 360;
}
