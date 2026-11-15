/**
 * Schedule validation — pure function, no I/O.
 *
 * The API calls it when a schedule is saved or published; the web app calls it
 * live while a manager builds a schedule. Messages are not built here: each issue
 * carries a stable `code` and `details`, and the UI translates them (fr-CA / en-CA).
 */
import { PROVINCE_RULES, type Province, rulesFor } from "./provinces";
import {
  DAY,
  HOUR,
  MINUTE,
  type Interval,
  addDays,
  isCovered,
  localDate,
  localMinuteOfDay,
  localWeekStart,
  longestRestTouching,
  parseTime,
  weekdayOf,
  zonedToUtc,
} from "./time";

// ---------- Inputs ----------

export interface LocationInput {
  id: string;
  companyId: string;
  province: Province;
  timezone: string;
}

export interface EmploymentInput {
  id: string;
  personId: string;
  companyId: string;
  /** Clinics this employment may be scheduled at. Empty = any clinic of the company. */
  locationIds: string[];
  desiredWeeklyMinutes?: number | null;
  minWeeklyMinutes?: number | null;
  maxWeeklyMinutes?: number | null;
}

export interface ShiftInput {
  id: string;
  /** Null = open shift (skipped by person-based checks). */
  employmentId: string | null;
  locationId: string;
  startsAt: Date;
  endsAt: Date;
  unpaidBreakMinutes: number;
}

export interface AvailabilityRuleInput {
  personId: string;
  /** 0 = Monday … 6 = Sunday */
  weekday: number;
  start: string; // "HH:MM"
  end: string; // "HH:MM"
  status: "pending" | "approved" | "rejected";
}

export interface AvailabilityExceptionInput {
  personId: string;
  date: string; // "YYYY-MM-DD"
  /** Both omitted = unavailable all day. */
  start?: string;
  end?: string;
  status: "pending" | "approved" | "rejected";
}

export interface CredentialInput {
  personId: string;
  name: string;
  expiresOn: string | null; // "YYYY-MM-DD"
  blocksSchedulingWhenExpired: boolean;
}

export interface ValidationInput {
  locations: LocationInput[];
  employments: EmploymentInput[];
  /**
   * Every shift that matters for the people involved, across all clinics and companies
   * of the account, for the weeks being checked (and the week before, for Ontario's
   * 2-week rest rule).
   */
  shifts: ShiftInput[];
  availabilityRules?: AvailabilityRuleInput[];
  availabilityExceptions?: AvailabilityExceptionInput[];
  credentials?: CredentialInput[];
  /** Account setting: count hours across companies for overtime and rest. */
  combineRelatedCompanyHours?: boolean;
  /** Shifts being added or changed now (for the Quebec 5-day notice warning). */
  changedShiftIds?: string[];
  /** Weeks to report on ("YYYY-MM-DD" Mondays). Default: every week that has a shift. */
  weeks?: string[];
  now: Date;
}

// ---------- Outputs ----------

export type IssueCode =
  | "shift_overlap"
  | "location_not_allowed"
  | "credential_expired"
  | "outside_availability"
  | "overtime"
  | "above_max_hours"
  | "below_min_hours"
  | "weekly_rest"
  | "meal_break_missing"
  | "short_notice_refusable"
  | "province_rules_missing";

export interface Issue {
  code: IssueCode;
  severity: "error" | "warning";
  shiftIds: string[];
  personId?: string;
  employmentId?: string;
  week?: string;
  details: Record<string, string | number | boolean>;
}

export interface HoursSummary {
  employmentId: string;
  week: string;
  scheduledMinutes: number;
  desiredWeeklyMinutes: number | null;
  minWeeklyMinutes: number | null;
  maxWeeklyMinutes: number | null;
}

export interface ValidationResult {
  issues: Issue[];
  hours: HoursSummary[];
  /** True when there is no error (warnings allowed). */
  publishable: boolean;
}

// ---------- Implementation ----------

const paidMinutes = (s: ShiftInput) =>
  Math.max(0, (s.endsAt.getTime() - s.startsAt.getTime()) / MINUTE - s.unpaidBreakMinutes);

export function validateSchedule(input: ValidationInput): ValidationResult {
  const issues: Issue[] = [];
  const locations = new Map(input.locations.map((l) => [l.id, l]));
  const employments = new Map(input.employments.map((e) => [e.id, e]));

  const loc = (id: string) => {
    const l = locations.get(id);
    if (!l) throw new Error(`Unknown location ${id}`);
    return l;
  };
  const emp = (id: string) => {
    const e = employments.get(id);
    if (!e) throw new Error(`Unknown employment ${id}`);
    return e;
  };

  const assigned = input.shifts.filter((s): s is ShiftInput & { employmentId: string } => s.employmentId !== null);
  const weekOf = (s: ShiftInput) => localWeekStart(s.startsAt, loc(s.locationId).timezone);
  const weeks = new Set(input.weeks ?? input.shifts.map(weekOf));
  const inReportedWeeks = (s: ShiftInput) => weeks.has(weekOf(s));

  // Provinces without rules
  for (const l of input.locations) {
    if (!rulesFor(l.province) && input.shifts.some((s) => s.locationId === l.id && inReportedWeeks(s))) {
      issues.push({
        code: "province_rules_missing",
        severity: "warning",
        shiftIds: [],
        details: { locationId: l.id, province: l.province },
      });
    }
  }

  // 1. Overlaps for the same person, across companies and clinics
  const byPerson = groupBy(assigned, (s) => emp(s.employmentId).personId);
  for (const [personId, list] of byPerson) {
    const sorted = [...list].sort((a, b) => a.startsAt.getTime() - b.startsAt.getTime());
    for (let i = 0; i < sorted.length; i++) {
      for (let j = i + 1; j < sorted.length && sorted[j].startsAt < sorted[i].endsAt; j++) {
        if (!inReportedWeeks(sorted[i]) && !inReportedWeeks(sorted[j])) continue;
        issues.push({
          code: "shift_overlap",
          severity: "error",
          shiftIds: [sorted[i].id, sorted[j].id],
          personId,
          details: {},
        });
      }
    }
  }

  for (const s of assigned.filter(inReportedWeeks)) {
    const e = emp(s.employmentId);
    const l = loc(s.locationId);
    const rules = rulesFor(l.province);

    // 2. Clinic must belong to the employer and be allowed for this employment
    if (l.companyId !== e.companyId || (e.locationIds.length > 0 && !e.locationIds.includes(l.id))) {
      issues.push({
        code: "location_not_allowed",
        severity: "error",
        shiftIds: [s.id],
        personId: e.personId,
        employmentId: e.id,
        details: { locationId: l.id, sameCompany: l.companyId === e.companyId },
      });
    }

    // 3. Expired blocking credential on the shift date
    const shiftDate = localDate(s.startsAt, l.timezone);
    for (const c of input.credentials ?? []) {
      if (c.personId === e.personId && c.blocksSchedulingWhenExpired && c.expiresOn !== null && c.expiresOn < shiftDate) {
        issues.push({
          code: "credential_expired",
          severity: "error",
          shiftIds: [s.id],
          personId: e.personId,
          employmentId: e.id,
          details: { credential: c.name, expiredOn: c.expiresOn },
        });
      }
    }

    // 4. Availability
    if (!isWithinAvailability(s, e.personId, l.timezone, input)) {
      issues.push({
        code: "outside_availability",
        severity: "warning",
        shiftIds: [s.id],
        personId: e.personId,
        employmentId: e.id,
        details: {},
      });
    }

    // 5. Meal break
    if (rules) {
      const workedMinutes = (s.endsAt.getTime() - s.startsAt.getTime()) / MINUTE;
      if (workedMinutes > rules.mealBreakAfterMinutes && s.unpaidBreakMinutes < rules.mealBreakMinutes) {
        issues.push({
          code: "meal_break_missing",
          severity: "warning",
          shiftIds: [s.id],
          personId: e.personId,
          employmentId: e.id,
          details: { requiredMinutes: rules.mealBreakMinutes, province: l.province },
        });
      }

      // 6. Quebec: employee may refuse a shift announced less than 5 days ahead
      if (rules.scheduleNoticeDays !== undefined && input.changedShiftIds?.includes(s.id)) {
        const noticeMs = s.startsAt.getTime() - input.now.getTime();
        if (noticeMs < rules.scheduleNoticeDays * DAY) {
          issues.push({
            code: "short_notice_refusable",
            severity: "warning",
            shiftIds: [s.id],
            personId: e.personId,
            employmentId: e.id,
            details: {
              noticeHours: Math.max(0, Math.floor(noticeMs / HOUR)),
              requiredDays: rules.scheduleNoticeDays,
              province: l.province,
            },
          });
        }
      }
    }
  }

  // 7. Weekly hours: per company, or per person when related companies are combined
  const groupKey = (s: ShiftInput & { employmentId: string }) => {
    const e = emp(s.employmentId);
    return input.combineRelatedCompanyHours ? e.personId : `${e.personId}|${e.companyId}`;
  };

  for (const [key, list] of groupBy(assigned, groupKey)) {
    const personId = emp(list[0].employmentId).personId;
    for (const [week, weekShifts] of groupBy(list, weekOf)) {
      if (!weeks.has(week)) continue;
      const total = sum(weekShifts.map(paidMinutes));
      const provinces = unique(weekShifts.map((s) => loc(s.locationId).province));
      const known = provinces.map((p) => [p, PROVINCE_RULES[p]] as const).filter(([, r]) => r !== undefined);
      if (known.length > 0) {
        const threshold = Math.min(...known.map(([, r]) => r!.overtimeWeeklyMinutes));
        if (total > threshold) {
          issues.push({
            code: "overtime",
            severity: "warning",
            shiftIds: weekShifts.map((s) => s.id),
            personId,
            week,
            details: { scheduledMinutes: total, thresholdMinutes: threshold, overtimeMinutes: total - threshold, group: key },
          });
        }
      }

      // 8. Weekly rest, per province present that week
      const tz = loc(weekShifts[0].locationId).timezone;
      const weekStartMs = zonedToUtc(week, "00:00", tz).getTime();
      const weekEndMs = zonedToUtc(addDays(week, 7), "00:00", tz).getTime();
      const intervals: Interval[] = list.map((s) => [s.startsAt.getTime(), s.endsAt.getTime()]);
      const gap = longestRestTouching(intervals, weekStartMs, weekEndMs);
      for (const [province, rules] of known) {
        if (gap >= rules!.weeklyRestMinutes * MINUTE) continue;
        if (rules!.biweeklyRestMinutes !== undefined) {
          const prevStartMs = zonedToUtc(addDays(week, -7), "00:00", tz).getTime();
          if (longestRestTouching(intervals, prevStartMs, weekEndMs) >= rules!.biweeklyRestMinutes * MINUTE) continue;
        }
        issues.push({
          code: "weekly_rest",
          severity: "warning",
          shiftIds: weekShifts.map((s) => s.id),
          personId,
          week,
          details: {
            longestRestMinutes: Math.floor(gap / MINUTE),
            requiredMinutes: rules!.weeklyRestMinutes,
            province,
          },
        });
      }
    }
  }

  // 9. Employment targets and the hours counter (scheduled vs desired)
  const hours: HoursSummary[] = [];
  for (const [employmentId, list] of groupBy(assigned, (s) => s.employmentId)) {
    const e = emp(employmentId);
    for (const [week, weekShifts] of groupBy(list, weekOf)) {
      if (!weeks.has(week)) continue;
      const scheduled = sum(weekShifts.map(paidMinutes));
      hours.push({
        employmentId,
        week,
        scheduledMinutes: scheduled,
        desiredWeeklyMinutes: e.desiredWeeklyMinutes ?? null,
        minWeeklyMinutes: e.minWeeklyMinutes ?? null,
        maxWeeklyMinutes: e.maxWeeklyMinutes ?? null,
      });
      if (e.maxWeeklyMinutes != null && scheduled > e.maxWeeklyMinutes) {
        issues.push({
          code: "above_max_hours",
          severity: "warning",
          shiftIds: weekShifts.map((s) => s.id),
          personId: e.personId,
          employmentId,
          week,
          details: { scheduledMinutes: scheduled, maxWeeklyMinutes: e.maxWeeklyMinutes },
        });
      }
      if (e.minWeeklyMinutes != null && scheduled < e.minWeeklyMinutes) {
        issues.push({
          code: "below_min_hours",
          severity: "warning",
          shiftIds: weekShifts.map((s) => s.id),
          personId: e.personId,
          employmentId,
          week,
          details: { scheduledMinutes: scheduled, minWeeklyMinutes: e.minWeeklyMinutes },
        });
      }
    }
  }

  return { issues, hours, publishable: !issues.some((i) => i.severity === "error") };
}

/**
 * A shift is within availability when every local day it touches is covered by the
 * person's approved recurring windows and no approved exception blocks it.
 * A person with no approved recurring windows is treated as always available.
 */
function isWithinAvailability(s: ShiftInput, personId: string, timezone: string, input: ValidationInput): boolean {
  const rules = (input.availabilityRules ?? []).filter((r) => r.personId === personId && r.status === "approved");
  const exceptions = (input.availabilityExceptions ?? []).filter((x) => x.personId === personId && x.status === "approved");

  for (const [date, startMin, endMin] of splitByLocalDay(s, timezone)) {
    const dayExceptions = exceptions.filter((x) => x.date === date);
    for (const x of dayExceptions) {
      if (!x.start || !x.end) return false;
      if (startMin < parseTime(x.end) && endMin > parseTime(x.start)) return false;
    }
    if (rules.length === 0) continue;
    const windows: Interval[] = rules
      .filter((r) => r.weekday === weekdayOf(date))
      .map((r) => [parseTime(r.start), parseTime(r.end)]);
    if (!isCovered(startMin, endMin, windows)) return false;
  }
  return true;
}

/** Split a shift into [localDate, startMinute, endMinute] pieces, one per local day. */
function splitByLocalDay(s: ShiftInput, timezone: string): Array<[string, number, number]> {
  const pieces: Array<[string, number, number]> = [];
  let cursor = s.startsAt;
  while (cursor < s.endsAt) {
    const date = localDate(cursor, timezone);
    const nextMidnight = zonedToUtc(addDays(date, 1), "00:00", timezone);
    const pieceEnd = nextMidnight < s.endsAt ? nextMidnight : s.endsAt;
    const startMin = localMinuteOfDay(cursor, timezone);
    const endMin = pieceEnd.getTime() === nextMidnight.getTime() ? 24 * 60 : localMinuteOfDay(pieceEnd, timezone);
    pieces.push([date, startMin, endMin]);
    cursor = pieceEnd;
  }
  return pieces;
}

function groupBy<T, K>(items: T[], key: (item: T) => K): Map<K, T[]> {
  const map = new Map<K, T[]>();
  for (const item of items) {
    const k = key(item);
    const list = map.get(k);
    if (list) list.push(item);
    else map.set(k, [item]);
  }
  return map;
}

const sum = (values: number[]) => values.reduce((a, b) => a + b, 0);
const unique = <T>(values: T[]) => [...new Set(values)];
