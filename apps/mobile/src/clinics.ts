import { addDays, localDate, weekdayOf, zonedToUtc } from "@clinic-workforce/rules";
import { clinics, type DemoShift, employments, persons, seedShifts, TZ } from "@clinic-workforce/sample-data";
import type { PunchLocation } from "@clinic-workforce/timeclock";
import type { ClinicOverride } from "./settings";

/** Sample coordinates. Replace them from the Setup screen while standing in each clinic. */
export const SAMPLE_GEO: Record<string, { latitude: number; longitude: number }> = {
  gatineau: { latitude: 45.4765, longitude: -75.7013 },
  aylmer: { latitude: 45.396, longitude: -75.844 },
  ottawa: { latitude: 45.4215, longitude: -75.6972 },
  orleans: { latitude: 45.48, longitude: -75.51 },
};

/** Demo PINs for the kiosk. Real PINs are set per employee and stored hashed on the server. */
export const DEMO_PINS: Record<string, string> = {
  marie: "1234", julie: "2345", karim: "3456", sophie: "4567", emilie: "5678", nadia: "6789",
  luc: "1111", sarah: "2222", kevin: "3333", ana: "4444", chloe: "5555",
};

export const clinicById = (id: string) => clinics.find((c) => c.id === id)!;

export function punchLocationFor(clinicId: string, overrides: Record<string, ClinicOverride>): PunchLocation {
  const o = overrides[clinicId] ?? {};
  const geo = SAMPLE_GEO[clinicId];
  return {
    id: clinicId,
    latitude: o.latitude ?? geo.latitude,
    longitude: o.longitude ?? geo.longitude,
    geofenceRadiusM: o.radiusM ?? 150,
    earlyPunchLimitMin: 15,
    wifiBssids: o.wifiBssids ?? [],
    // Demo secret shared by the iPad and the phones. Production: signed by the server.
    qrSecret: `demo-secret-${clinicId}`,
  };
}

export function upcomingMonday(): string {
  const today = localDate(new Date(), TZ);
  return addDays(today, 7 - weekdayOf(today));
}

export const shiftStart = (s: DemoShift) => zonedToUtc(s.date, s.start, TZ);
export const shiftEnd = (s: DemoShift) => zonedToUtc(s.date, s.end, TZ);

export function myShifts(personId: string): DemoShift[] {
  const mine = new Set(employments.filter((e) => e.personId === personId).map((e) => e.id));
  return seedShifts(upcomingMonday())
    .filter((s) => s.employmentId && mine.has(s.employmentId))
    .sort((a, b) => shiftStart(a).getTime() - shiftStart(b).getTime());
}

export function myClinicIds(personId: string): string[] {
  return [...new Set(employments.filter((e) => e.personId === personId).flatMap((e) => e.locationIds))];
}

export const personById = (id: string | null) => persons.find((p) => p.id === id);

export function fmtTime(d: Date): string {
  return new Intl.DateTimeFormat("en-CA", { hour: "2-digit", minute: "2-digit", hourCycle: "h23", timeZone: TZ }).format(d);
}

export function fmtDay(date: string, lang: "fr" | "en", daysLong: string[], withMonth = true): string {
  const [y, m, d] = date.split("-").map(Number);
  const label = new Date(Date.UTC(y, m - 1, d, 12)).toLocaleDateString(lang === "fr" ? "fr-CA" : "en-CA", {
    timeZone: "UTC",
    day: "numeric",
    ...(withMonth ? { month: "short" } : {}),
  });
  return `${daysLong[weekdayOf(date)]} ${label}`;
}

export function fmtDistance(m: number, lang: "fr" | "en"): string {
  if (m < 1000) return `${m} m`;
  return `${new Intl.NumberFormat(lang === "fr" ? "fr-CA" : "en-CA", { maximumFractionDigits: 1 }).format(m / 1000)} km`;
}
