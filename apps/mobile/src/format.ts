import type { Lang } from "./i18n";

export const DEFAULT_TZ = "America/Toronto";

export function fmtTime(iso: string | Date, tz = DEFAULT_TZ): string {
  return new Intl.DateTimeFormat("en-CA", { hour: "2-digit", minute: "2-digit", hourCycle: "h23", timeZone: tz }).format(new Date(iso));
}

/** "lundi 16 nov." / "Monday Nov 16" in the clinic's time zone. */
export function fmtDay(iso: string | Date, lang: Lang, tz = DEFAULT_TZ, withMonth = true): string {
  return new Intl.DateTimeFormat(lang === "fr" ? "fr-CA" : "en-CA", {
    weekday: "long",
    day: "numeric",
    ...(withMonth ? { month: "short" } : {}),
    timeZone: tz,
  }).format(new Date(iso));
}

export function fmtDistance(m: number, lang: Lang): string {
  if (m < 1000) return `${m} m`;
  return `${new Intl.NumberFormat(lang === "fr" ? "fr-CA" : "en-CA", { maximumFractionDigits: 1 }).format(m / 1000)} km`;
}

/** Monday (YYYY-MM-DD) of the week containing the instant, in the time zone. */
export function weekStartOf(iso: string, tz = DEFAULT_TZ): string {
  const parts = new Intl.DateTimeFormat("en-CA", { year: "numeric", month: "2-digit", day: "2-digit", weekday: "short", timeZone: tz }).formatToParts(new Date(iso));
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  const weekday = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].indexOf(get("weekday"));
  const d = new Date(Date.UTC(Number(get("year")), Number(get("month")) - 1, Number(get("day")) - Math.max(0, weekday)));
  return d.toISOString().slice(0, 10);
}
