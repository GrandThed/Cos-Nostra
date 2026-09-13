/** Numbers and dates as the design writes them. */

/** Sizes as the design writes them: three significant figures at most, so "212 MB" and
 *  "6.1 MB" and "51.5 GB" but never "212.4 MB". */
export function fmtBytes(n: number | null | undefined): string {
  if (n === null || n === undefined || n < 0) return "–";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  if (n < 1024 * 1024 * 1024) {
    const mb = n / (1024 * 1024);
    return `${mb >= 100 ? Math.round(mb) : mb.toFixed(1)} MB`;
  }
  const gb = n / (1024 * 1024 * 1024);
  return `${gb >= 100 ? Math.round(gb) : gb.toFixed(1)} GB`;
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

/** The day a clip belongs to, as a heading: "Tonight", "Yesterday", "Tuesday", "12 August". */
export function dayLabel(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "Earlier";
  const ago = daysAgo(d);
  if (ago <= 0) return "Tonight";
  if (ago === 1) return "Yesterday";
  if (ago < 7) return d.toLocaleDateString(undefined, { weekday: "long" });
  return d.toLocaleDateString(undefined, { day: "numeric", month: "long" });
}

/** "Tonight 01:12" — the day label plus the clock, which is how every clip is named. */
export function fmtWhen(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return `${dayLabel(iso)} ${d.toLocaleTimeString(undefined, TIME)}`;
}

/** The same, with a comma, for the metadata grid: "Tonight, 01:12". */
export function fmtWhenLong(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return `${dayLabel(iso)}, ${d.toLocaleTimeString(undefined, TIME)}`;
}

export function fmtTimeOnly(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleTimeString(undefined, TIME);
}

/** A stable hue per clip, so the placeholder behind a missing thumbnail is at least its own. */
export function hueFor(id: number): number {
  return (id * 47) % 360;
}
