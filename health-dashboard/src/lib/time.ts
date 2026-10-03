import { config } from "../config";

const TZ = config.timezone;

const partsFmt = new Intl.DateTimeFormat("en-CA", {
  timeZone: TZ,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hourCycle: "h23",
});

export interface LocalParts {
  date: string; // YYYY-MM-DD
  hour: number;
  minute: number;
}

/** Offset of the home timezone from UTC at `ts`, in seconds (slow path via Intl). */
function intlOffsetSec(ts: number): number {
  const p: Record<string, string> = {};
  for (const x of partsFmt.formatToParts(new Date(ts * 1000))) p[x.type] = x.value;
  const asUtc = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second) / 1000;
  return asUtc - Math.floor(ts);
}

// Offsets only change on the hour (DST), so cache per hour: Intl is ~5 µs a call,
// which adds up on the free plan's 10 ms CPU budget when parsing thousands of samples.
const offsetCache = new Map<number, number>();

/** Offset of the home timezone from UTC at `ts`, in seconds. */
export function tzOffsetSec(ts: number): number {
  const key = Math.floor(ts / 3600);
  let off = offsetCache.get(key);
  if (off === undefined) {
    if (offsetCache.size > 20000) offsetCache.clear();
    off = intlOffsetSec(key * 3600);
    offsetCache.set(key, off);
  }
  return off;
}

/** Local (home timezone) calendar parts of a unix-seconds instant. */
export function localParts(ts: number): LocalParts {
  const t = new Date((Math.floor(ts) + tzOffsetSec(ts)) * 1000);
  return { date: t.toISOString().slice(0, 10), hour: t.getUTCHours(), minute: t.getUTCMinutes() };
}

export const localDate = (ts: number) => localParts(ts).date;

/** Unix seconds of local midnight starting `date` (home timezone). */
export function startOfLocalDay(date: string): number {
  const [y, m, d] = date.split("-").map(Number);
  const guess = Date.UTC(y, m - 1, d) / 1000;
  // Two passes handle DST edges for timezones that have them (Bali doesn't).
  let ts = guess - tzOffsetSec(guess);
  ts = guess - tzOffsetSec(ts);
  return ts;
}

/** Local wall-clock time on `date` ("HH:MM") → unix seconds. */
export function localTimeOn(date: string, hhmm: string): number {
  const [h, m] = hhmm.split(":").map(Number);
  return startOfLocalDay(date) + h * 3600 + m * 60;
}

export function addDays(date: string, n: number): string {
  const [y, m, d] = date.split("-").map(Number);
  const t = new Date(Date.UTC(y, m - 1, d + n));
  return t.toISOString().slice(0, 10);
}

/** Inclusive list of dates from `from` to `to`. */
export function dateRange(from: string, to: string): string[] {
  const out: string[] = [];
  for (let d = from; d <= to; d = addDays(d, 1)) out.push(d);
  return out;
}

export function weekday(date: string): string {
  const [y, m, d] = date.split("-").map(Number);
  return ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][new Date(Date.UTC(y, m - 1, d)).getUTCDay()];
}

export function fmtTime(ts: number): string {
  const p = localParts(ts);
  return `${String(p.hour).padStart(2, "0")}:${String(p.minute).padStart(2, "0")}`;
}

export const nowSec = () => Math.floor(Date.now() / 1000);

/**
 * Parse a Health Auto Export timestamp. HAE uses "2026-10-02 23:14:05 +0800";
 * also accepts ISO-8601. Returns unix seconds, or null.
 */
export function parseHaeDate(s: unknown): number | null {
  if (typeof s !== "string" || !s) return null;
  const m = s.trim().match(/^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?)\s*(Z|[+-]\d{2}:?\d{2})?$/);
  let iso: string;
  if (m) {
    let off = m[3] ?? "";
    if (/^[+-]\d{4}$/.test(off)) off = `${off.slice(0, 3)}:${off.slice(3)}`;
    if (!off) {
      // No offset: interpret as home-timezone wall clock.
      const [hh, mm, ss] = m[2].split(":");
      return startOfLocalDay(m[1]) + +hh * 3600 + +mm * 60 + Math.floor(+(ss ?? 0));
    }
    iso = `${m[1]}T${m[2]}${off}`;
  } else {
    iso = s;
  }
  const t = Date.parse(iso);
  return Number.isNaN(t) ? null : Math.floor(t / 1000);
}

/**
 * The "night" a piece of sleep belongs to: the local date you woke up.
 * Anything ending after 18:00 counts toward the next morning.
 */
export function nightDateFor(endTs: number): string {
  return localDate(endTs + 6 * 3600);
}
