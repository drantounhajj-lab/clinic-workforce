/**
 * Timezone helpers built on Intl only (no dependencies).
 * All instants are JS Dates (UTC). Local dates are "YYYY-MM-DD", local times "HH:MM".
 */

export const MINUTE = 60_000;
export const HOUR = 60 * MINUTE;
export const DAY = 24 * HOUR;

interface LocalParts {
  year: number;
  month: number; // 1-12
  day: number;
  hour: number;
  minute: number;
  second: number;
}

const formatterCache = new Map<string, Intl.DateTimeFormat>();

function formatter(timeZone: string): Intl.DateTimeFormat {
  let f = formatterCache.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat("en-CA", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
    formatterCache.set(timeZone, f);
  }
  return f;
}

export function localParts(instant: Date, timeZone: string): LocalParts {
  const parts = formatter(timeZone).formatToParts(instant);
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value);
  return {
    year: get("year"),
    month: get("month"),
    day: get("day"),
    hour: get("hour"),
    minute: get("minute"),
    second: get("second"),
  };
}

const pad = (n: number) => String(n).padStart(2, "0");

/** Local calendar date of an instant, "YYYY-MM-DD". */
export function localDate(instant: Date, timeZone: string): string {
  const p = localParts(instant, timeZone);
  return `${p.year}-${pad(p.month)}-${pad(p.day)}`;
}

/** Minutes since local midnight. */
export function localMinuteOfDay(instant: Date, timeZone: string): number {
  const p = localParts(instant, timeZone);
  return p.hour * 60 + p.minute;
}

/** 0 = Monday … 6 = Sunday, for a "YYYY-MM-DD" date. */
export function weekdayOf(date: string): number {
  const [y, m, d] = date.split("-").map(Number);
  const jsDay = new Date(Date.UTC(y, m - 1, d)).getUTCDay(); // 0 = Sunday
  return (jsDay + 6) % 7;
}

export function addDays(date: string, days: number): string {
  const [y, m, d] = date.split("-").map(Number);
  const t = new Date(Date.UTC(y, m - 1, d) + days * DAY);
  return `${t.getUTCFullYear()}-${pad(t.getUTCMonth() + 1)}-${pad(t.getUTCDate())}`;
}

/** Monday of the local week containing the instant. */
export function localWeekStart(instant: Date, timeZone: string): string {
  const date = localDate(instant, timeZone);
  return addDays(date, -weekdayOf(date));
}

/** Offset of the zone from UTC at an instant, in ms (e.g. -5h for Toronto in winter). */
function zoneOffset(instant: Date, timeZone: string): number {
  const p = localParts(instant, timeZone);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return asUtc - Math.floor(instant.getTime() / 1000) * 1000;
}

/** The UTC instant of a local date and time in a zone ("2027-01-04", "09:00"). */
export function zonedToUtc(date: string, time: string, timeZone: string): Date {
  const [y, m, d] = date.split("-").map(Number);
  const [hh, mm] = time.split(":").map(Number);
  const naive = Date.UTC(y, m - 1, d, hh, mm);
  let guess = naive - zoneOffset(new Date(naive), timeZone);
  // Second pass handles DST transitions between the naive guess and the result.
  guess = naive - zoneOffset(new Date(guess), timeZone);
  return new Date(guess);
}

export function parseTime(time: string): number {
  const [hh, mm] = time.split(":").map(Number);
  return hh * 60 + mm;
}

export type Interval = [number, number];

/** Merge overlapping or touching intervals (sorted output). */
export function mergeIntervals(intervals: Interval[]): Interval[] {
  const sorted = [...intervals].sort((a, b) => a[0] - b[0]);
  const out: Interval[] = [];
  for (const [s, e] of sorted) {
    const last = out[out.length - 1];
    if (last && s <= last[1]) last[1] = Math.max(last[1], e);
    else out.push([s, e]);
  }
  return out;
}

/** Longest stretch inside [windowStart, windowEnd] not covered by any interval. */
export function longestGap(intervals: Interval[], windowStart: number, windowEnd: number): number {
  const clipped = intervals
    .map(([s, e]) => [Math.max(s, windowStart), Math.min(e, windowEnd)] as Interval)
    .filter(([s, e]) => e > s);
  const merged = mergeIntervals(clipped);
  let cursor = windowStart;
  let best = 0;
  for (const [s, e] of merged) {
    best = Math.max(best, s - cursor);
    cursor = Math.max(cursor, e);
  }
  return Math.max(best, windowEnd - cursor);
}

/**
 * Longest rest period that touches [windowStart, windowEnd].
 * Rest between two known shifts is measured in full, even when it runs past the
 * window (a Saturday-evening-to-Monday rest counts whole). Rest before the first
 * known shift starts at windowStart, and rest after the last known shift ends at
 * windowEnd, because what happens outside the data is unknown: pass the adjacent
 * weeks' shifts for an exact result.
 */
export function longestRestTouching(intervals: Interval[], windowStart: number, windowEnd: number): number {
  const merged = mergeIntervals(intervals.filter(([s, e]) => e > s));
  const gaps: Interval[] = [];
  if (merged.length === 0) return windowEnd - windowStart;
  gaps.push([Math.min(windowStart, merged[0][0]), merged[0][0]]);
  for (let i = 0; i < merged.length - 1; i++) gaps.push([merged[i][1], merged[i + 1][0]]);
  const last = merged[merged.length - 1][1];
  gaps.push([last, Math.max(windowEnd, last)]);
  let best = 0;
  for (const [s, e] of gaps) {
    if (s < windowEnd && e > windowStart) best = Math.max(best, e - s);
  }
  return best;
}

/** True when [start, end] is fully covered by the union of intervals. */
export function isCovered(start: number, end: number, intervals: Interval[]): boolean {
  let cursor = start;
  for (const [s, e] of mergeIntervals(intervals)) {
    if (s > cursor) break;
    if (e > cursor) cursor = e;
    if (cursor >= end) return true;
  }
  return cursor >= end;
}
