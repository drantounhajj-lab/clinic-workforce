/**
 * Timesheets from punches — pure functions, no I/O.
 *
 * Pairs each person's "in" and "out" punches per employer (company), across midnight,
 * deducts the scheduled unpaid break, splits the pay period into weeks and applies the
 * province's weekly overtime threshold. Flags missing punches so payroll isn't closed on
 * incomplete data.
 */
import { addDays, localDate, PROVINCE_RULES, type Province, zonedToUtc } from "@clinic-workforce/rules";

export type PayFrequency = "weekly" | "biweekly";

export interface PayPeriod {
  /** First day, "YYYY-MM-DD" */
  start: string;
  /** Day after the last day (exclusive) */
  end: string;
}

const DAY_MS = 86_400_000;
const daysBetween = (a: string, b: string) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / DAY_MS);

/** The pay period that contains `date`, given any period's first day (`anchor`). */
export function payPeriodFor(anchor: string, frequency: PayFrequency, date: string): PayPeriod {
  const len = frequency === "weekly" ? 7 : 14;
  const offset = ((daysBetween(anchor, date) % len) + len) % len;
  const start = addDays(date, -offset);
  return { start, end: addDays(start, len) };
}

/** `count` periods ending with the one containing `date` (most recent first). */
export function recentPayPeriods(anchor: string, frequency: PayFrequency, date: string, count: number): PayPeriod[] {
  const len = frequency === "weekly" ? 7 : 14;
  const current = payPeriodFor(anchor, frequency, date);
  return Array.from({ length: count }, (_, i) => ({ start: addDays(current.start, -len * i), end: addDays(current.end, -len * i) }));
}

export interface TsLocation {
  id: string;
  companyId: string;
  province: Province;
  timezone: string;
}

export interface TsEmployment {
  id: string;
  personId: string;
  companyId: string;
}

export interface TsPunch {
  id: string;
  personId: string;
  employmentId: string;
  locationId: string;
  kind: "in" | "out";
  occurredAt: Date;
  method: string;
  flags: string[];
}

export interface TsShift {
  id: string;
  employmentId: string | null;
  locationId: string;
  startsAt: Date;
  endsAt: Date;
  unpaidBreakMinutes: number;
}

export interface TsTimeOff {
  personId: string;
  type: string;
  startDate: string;
  endDate: string; // inclusive
  paidHours: number | null;
}

export type EntryIssue = "missing_out" | "missing_in" | "too_long" | "in_progress";

export interface WorkEntry {
  personId: string;
  companyId: string;
  locationId: string;
  /** Local date the work started (or ended, for a missing "in") */
  date: string;
  inAt: Date | null;
  outAt: Date | null;
  inPunchId: string | null;
  outPunchId: string | null;
  /** Elapsed minutes between in and out (0 when one is missing) */
  minutes: number;
  breakMinutes: number;
  paidMinutes: number;
  shiftId: string | null;
  /** Punch methods/flags worth showing (manual, correction, outside geofence…) */
  notes: string[];
  issue: EntryIssue | null;
}

export interface WeekTotal {
  start: string;
  paidMinutes: number;
  regularMinutes: number;
  overtimeMinutes: number;
  thresholdMinutes: number | null;
}

export interface TimesheetRow {
  personId: string;
  companyId: string;
  entries: WorkEntry[];
  weeks: WeekTotal[];
  paidMinutes: number;
  regularMinutes: number;
  overtimeMinutes: number;
  /** Paid time-off minutes by type (vacation, sick…), prorated to the period */
  timeOffMinutes: Record<string, number>;
  issues: EntryIssue[];
}

export interface TimesheetInput {
  period: PayPeriod;
  /** Time zone used to cut the period into days (the company's clinics) */
  timezone: string;
  locations: TsLocation[];
  employments: TsEmployment[];
  /** Punches from at least one day before to one day after the period, for overnight pairing */
  punches: TsPunch[];
  shifts: TsShift[];
  timeOff?: TsTimeOff[];
  now: Date;
  /** A work period longer than this is flagged (default 16 h). */
  maxEntryMinutes?: number;
}

/** Build one row per person and employer with work in the period (or paid time off). */
export function buildTimesheets(input: TimesheetInput): TimesheetRow[] {
  const loc = new Map(input.locations.map((l) => [l.id, l]));
  const emp = new Map(input.employments.map((e) => [e.id, e]));
  const maxMinutes = input.maxEntryMinutes ?? 16 * 60;
  const periodStart = zonedToUtc(input.period.start, "00:00", input.timezone).getTime();
  const periodEnd = zonedToUtc(input.period.end, "00:00", input.timezone).getTime();

  const companyOf = (p: TsPunch) => emp.get(p.employmentId)?.companyId ?? loc.get(p.locationId)?.companyId ?? "";
  const groups = new Map<string, TsPunch[]>();
  for (const p of input.punches) {
    const key = `${p.personId}|${companyOf(p)}`;
    groups.set(key, [...(groups.get(key) ?? []), p]);
  }

  const usedBreaks = new Set<string>();
  const shiftsByPerson = new Map<string, TsShift[]>();
  for (const s of input.shifts) {
    const e = s.employmentId ? emp.get(s.employmentId) : undefined;
    if (!e) continue;
    shiftsByPerson.set(e.personId, [...(shiftsByPerson.get(e.personId) ?? []), s]);
  }

  const rows = new Map<string, TimesheetRow>();
  const rowFor = (personId: string, companyId: string) => {
    const key = `${personId}|${companyId}`;
    let r = rows.get(key);
    if (!r) {
      r = { personId, companyId, entries: [], weeks: [], paidMinutes: 0, regularMinutes: 0, overtimeMinutes: 0, timeOffMinutes: {}, issues: [] };
      rows.set(key, r);
    }
    return r;
  };

  for (const [key, list] of groups) {
    const [personId, companyId] = key.split("|");
    const sorted = [...list].sort((a, b) => a.occurredAt.getTime() - b.occurredAt.getTime());
    const entries: WorkEntry[] = [];
    let open: TsPunch | null = null;
    const make = (inP: TsPunch | null, outP: TsPunch | null): WorkEntry => {
      const ref = inP ?? outP!;
      const l = loc.get(ref.locationId);
      const minutes = inP && outP ? Math.round((outP.occurredAt.getTime() - inP.occurredAt.getTime()) / 60000) : 0;
      const notes = [...new Set([inP, outP].filter((x): x is TsPunch => !!x).flatMap((x) => [...(x.method === "manual" ? ["manual"] : []), ...x.flags]))];
      return {
        personId,
        companyId,
        locationId: ref.locationId,
        date: localDate(ref.occurredAt, l?.timezone ?? input.timezone),
        inAt: inP?.occurredAt ?? null,
        outAt: outP?.occurredAt ?? null,
        inPunchId: inP?.id ?? null,
        outPunchId: outP?.id ?? null,
        minutes,
        breakMinutes: 0,
        paidMinutes: minutes,
        shiftId: null,
        notes,
        issue: null,
      };
    };
    for (const p of sorted) {
      if (p.kind === "in") {
        if (open) entries.push({ ...make(open, null), issue: "missing_out" });
        open = p;
      } else if (open) {
        entries.push(make(open, p));
        open = null;
      } else {
        entries.push({ ...make(null, p), issue: "missing_in" });
      }
    }
    if (open) {
      const still = input.now.getTime() - open.occurredAt.getTime() < maxMinutes * 60000;
      entries.push({ ...make(open, null), issue: still ? "in_progress" : "missing_out" });
    }

    for (const e of entries) {
      const startMs = (e.inAt ?? e.outAt)!.getTime();
      if (startMs < periodStart || startMs >= periodEnd) continue;
      if (e.inAt && e.outAt) {
        if (e.minutes > maxMinutes) e.issue = "too_long";
        // Deduct the unpaid break of the shift this work overlaps the most (once per shift)
        let best: TsShift | null = null;
        let bestOverlap = 0;
        for (const s of shiftsByPerson.get(personId) ?? []) {
          const overlap = Math.min(s.endsAt.getTime(), e.outAt.getTime()) - Math.max(s.startsAt.getTime(), e.inAt.getTime());
          if (overlap > bestOverlap) {
            best = s;
            bestOverlap = overlap;
          }
        }
        if (best) {
          e.shiftId = best.id;
          if (!usedBreaks.has(best.id) && best.unpaidBreakMinutes > 0 && e.minutes > best.unpaidBreakMinutes) {
            e.breakMinutes = best.unpaidBreakMinutes;
            usedBreaks.add(best.id);
          }
        } else if (!e.notes.includes("no_shift")) {
          e.notes.push("no_shift");
        }
        e.paidMinutes = Math.max(0, e.minutes - e.breakMinutes);
      }
      rowFor(personId, companyId).entries.push(e);
    }
  }

  // Paid time off, prorated to the days inside the period
  for (const t of input.timeOff ?? []) {
    if (!t.paidHours) continue;
    const from = t.startDate > input.period.start ? t.startDate : input.period.start;
    const lastDay = addDays(input.period.end, -1);
    const to = t.endDate < lastDay ? t.endDate : lastDay;
    if (from > to) continue;
    const inPeriod = daysBetween(from, to) + 1;
    const total = daysBetween(t.startDate, t.endDate) + 1;
    const minutes = Math.round((t.paidHours * 60 * inPeriod) / total);
    const companies = [...new Set(input.employments.filter((e) => e.personId === t.personId).map((e) => e.companyId))];
    const withWork = companies.find((c) => rows.has(`${t.personId}|${c}`)) ?? companies[0];
    if (!withWork) continue;
    const r = rowFor(t.personId, withWork);
    r.timeOffMinutes[t.type] = (r.timeOffMinutes[t.type] ?? 0) + minutes;
  }

  // Weekly totals and overtime
  const weekCount = Math.max(1, Math.round(daysBetween(input.period.start, input.period.end) / 7));
  for (const r of rows.values()) {
    r.entries.sort((a, b) => (a.inAt ?? a.outAt)!.getTime() - (b.inAt ?? b.outAt)!.getTime());
    for (let w = 0; w < weekCount; w++) {
      const start = addDays(input.period.start, w * 7);
      const end = addDays(start, 7);
      const inWeek = r.entries.filter((e) => e.date >= start && e.date < end);
      const paid = inWeek.reduce((a, e) => a + e.paidMinutes, 0);
      const thresholds = [...new Set(inWeek.map((e) => loc.get(e.locationId)?.province))]
        .map((p) => (p ? PROVINCE_RULES[p]?.overtimeWeeklyMinutes : undefined))
        .filter((x): x is number => x !== undefined);
      const threshold = thresholds.length ? Math.min(...thresholds) : null;
      const overtime = threshold !== null ? Math.max(0, paid - threshold) : 0;
      r.weeks.push({ start, paidMinutes: paid, regularMinutes: paid - overtime, overtimeMinutes: overtime, thresholdMinutes: threshold });
    }
    r.paidMinutes = r.weeks.reduce((a, w) => a + w.paidMinutes, 0);
    r.overtimeMinutes = r.weeks.reduce((a, w) => a + w.overtimeMinutes, 0);
    r.regularMinutes = r.paidMinutes - r.overtimeMinutes;
    r.issues = r.entries.map((e) => e.issue).filter((x): x is EntryIssue => x !== null && x !== "in_progress");
  }

  return [...rows.values()];
}

/** Minutes as decimal hours, rounded to 2 decimals (what payroll systems import). */
export const toHours = (minutes: number) => Math.round((minutes / 60) * 100) / 100;
