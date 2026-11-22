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
  /** Used to estimate travel time between clinics. */
  latitude?: number | null;
  longitude?: number | null;
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
  /** Position (job title), used for coverage rules. */
  jobRoleId?: string | null;
}

export interface ShiftInput {
  id: string;
  /** Null = open shift (skipped by person-based checks). */
  employmentId: string | null;
  locationId: string;
  startsAt: Date;
  endsAt: Date;
  unpaidBreakMinutes: number;
  /** Position for this shift; defaults to the employment's position. */
  jobRoleId?: string | null;
}

export interface TimeOffInput {
  personId: string;
  startDate: string; // "YYYY-MM-DD"
  endDate: string; // inclusive
  /** Both set: part of a single day. */
  start?: string | null;
  end?: string | null;
  type: string;
}

export interface CoverageRuleInput {
  id: string;
  locationId: string;
  jobRoleId: string;
  /** 0 = Monday … 6 = Sunday */
  weekdays: number[];
  start: string; // "HH:MM"
  end: string;
  minCount: number;
}

export interface AvailabilityRuleInput {
  personId: string;
  /** 0 = Monday … 6 = Sunday */
  weekday: number;
  start: string; // "HH:MM"
  end: string; // "HH:MM"
  status: "pending" | "approved" | "rejected";
  /** "available" (default): may work in this window. "unavailable": may not. */
  kind?: "available" | "unavailable";
  /** First and last day the rule applies ("YYYY-MM-DD"); open-ended when omitted. */
  effectiveFrom?: string;
  effectiveTo?: string | null;
  /** 2 = alternating weeks, counted from anchorWeek (a Monday). */
  everyWeeks?: number;
  anchorWeek?: string | null;
  /** Clinics the rule applies to; all when omitted. */
  locationIds?: string[] | null;
}

export interface AvailabilityExceptionInput {
  personId: string;
  date: string; // "YYYY-MM-DD"
  /** Last day of a range; same day when omitted. */
  endDate?: string | null;
  /** Both omitted = all day. */
  start?: string;
  end?: string;
  status: "pending" | "approved" | "rejected";
  /** "unavailable" (default) or "available" (extra availability that day). */
  kind?: "available" | "unavailable";
  locationIds?: string[] | null;
}

/** Whenever at least triggerCount people of one position are on shift, at least requiredCount of another. */
export interface StaffingRatioInput {
  id: string;
  locationId: string;
  weekdays: number[];
  start: string; // "HH:MM"
  end: string; // "HH:MM" ("24:00" = end of day)
  triggerJobRoleId: string;
  triggerCount: number;
  requiredJobRoleId: string;
  requiredCount: number;
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
  /** Approved time off. */
  timeOff?: TimeOffInput[];
  /** Minimum number of people per position at a clinic during a time window. */
  coverageRules?: CoverageRuleInput[];
  staffingRatios?: StaffingRatioInput[];
  /** Days before expiry to start warning about a credential. Default 30. */
  credentialWarningDays?: number;
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
  | "province_rules_missing"
  | "time_off"
  | "travel_time"
  | "coverage_gap"
  | "staffing_ratio"
  | "credential_expiring"
  | "position_mismatch";

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

  const expiringSeen = new Set<string>();
  // 1b. Not enough time to travel between two clinics
  for (const [personId, list] of byPerson) {
    const sorted = [...list].sort((a, b) => a.startsAt.getTime() - b.startsAt.getTime());
    for (let i = 0; i + 1 < sorted.length; i++) {
      const a = sorted[i];
      const b = sorted[i + 1];
      if (a.locationId === b.locationId || b.startsAt < a.endsAt) continue;
      if (!inReportedWeeks(a) && !inReportedWeeks(b)) continue;
      const gapMinutes = Math.round((b.startsAt.getTime() - a.endsAt.getTime()) / MINUTE);
      if (gapMinutes >= 12 * 60) continue;
      const required = travelMinutes(loc(a.locationId), loc(b.locationId));
      if (gapMinutes < required) {
        issues.push({
          code: "travel_time",
          severity: "warning",
          shiftIds: [a.id, b.id],
          personId,
          details: { fromLocationId: a.locationId, toLocationId: b.locationId, gapMinutes, requiredMinutes: required },
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

    // 2b. Shift for a position the employee doesn't hold (both known)
    if (s.jobRoleId && e.jobRoleId && s.jobRoleId !== e.jobRoleId) {
      issues.push({
        code: "position_mismatch",
        severity: "warning",
        shiftIds: [s.id],
        personId: e.personId,
        employmentId: e.id,
        details: { shiftJobRoleId: s.jobRoleId, employeeJobRoleId: e.jobRoleId },
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

    // 3b. Credential expiring soon (once per person and credential)
    const warnDays = input.credentialWarningDays ?? 30;
    for (const c of input.credentials ?? []) {
      if (c.personId !== e.personId || c.expiresOn === null || c.expiresOn < shiftDate) continue;
      if (c.expiresOn > addDays(shiftDate, warnDays)) continue;
      const key = `${e.personId}|${c.name}`;
      if (expiringSeen.has(key)) continue;
      expiringSeen.add(key);
      issues.push({
        code: "credential_expiring",
        severity: "warning",
        shiftIds: [s.id],
        personId: e.personId,
        employmentId: e.id,
        details: { credential: c.name, expiresOn: c.expiresOn },
      });
    }

    // 3c. Approved time off
    const off = (input.timeOff ?? []).find((t) => t.personId === e.personId && overlapsTimeOff(s, t, l.timezone));
    if (off) {
      issues.push({
        code: "time_off",
        severity: "error",
        shiftIds: [s.id],
        personId: e.personId,
        employmentId: e.id,
        details: { type: off.type, startDate: off.startDate, endDate: off.endDate },
      });
    }

    // 4. Availability
    if (!isWithinAvailability(s, e.personId, l.timezone, input, l.id)) {
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

  // 10. Coverage by position
  for (const rule of input.coverageRules ?? []) {
    const l = locations.get(rule.locationId);
    if (!l) continue;
    const positionOf = (s: ShiftInput & { employmentId: string }) => s.jobRoleId ?? emp(s.employmentId).jobRoleId ?? null;
    const staffed: Interval[] = assigned
      .filter((s) => s.locationId === rule.locationId && positionOf(s) === rule.jobRoleId)
      .map((s) => [s.startsAt.getTime(), s.endsAt.getTime()]);
    for (const week of weeks) {
      for (let d = 0; d < 7; d++) {
        const date = addDays(week, d);
        if (!rule.weekdays.includes(weekdayOf(date))) continue;
        const from = zonedToUtc(date, rule.start, l.timezone).getTime();
        const to = zonedToUtc(date, rule.end, l.timezone).getTime();
        for (const [gs, ge, count] of coverageGaps(staffed, from, to, rule.minCount)) {
          issues.push({
            code: "coverage_gap",
            severity: "warning",
            shiftIds: [],
            week,
            details: {
              locationId: rule.locationId,
              jobRoleId: rule.jobRoleId,
              date,
              from: hhmm(new Date(gs), l.timezone),
              to: hhmm(new Date(ge), l.timezone),
              needed: rule.minCount,
              scheduled: count,
            },
          });
        }
      }
    }
  }

  // 11. Staffing ratios: "whenever 2 podiatrists, at least 1 receptionist"
  for (const rule of input.staffingRatios ?? []) {
    const l = locations.get(rule.locationId);
    if (!l) continue;
    const positionOf = (s: ShiftInput & { employmentId: string }) => s.jobRoleId ?? emp(s.employmentId).jobRoleId ?? null;
    const here = assigned.filter((s) => s.locationId === rule.locationId);
    const of = (jobRoleId: string): Interval[] => here.filter((s) => positionOf(s) === jobRoleId).map((s) => [s.startsAt.getTime(), s.endsAt.getTime()]);
    const trigger = of(rule.triggerJobRoleId);
    const required = of(rule.requiredJobRoleId);
    if (trigger.length < rule.triggerCount) continue;
    for (const week of weeks) {
      for (let d = 0; d < 7; d++) {
        const date = addDays(week, d);
        if (!rule.weekdays.includes(weekdayOf(date))) continue;
        const from = zonedToUtc(date, rule.start, l.timezone).getTime();
        const to = rule.end === "24:00" ? zonedToUtc(addDays(date, 1), "00:00", l.timezone).getTime() : zonedToUtc(date, rule.end, l.timezone).getTime();
        // Split the window at every start and end, then check each piece.
        const points = new Set<number>([from, to]);
        for (const [a, b] of [...trigger, ...required]) {
          if (a > from && a < to) points.add(a);
          if (b > from && b < to) points.add(b);
        }
        const sorted = [...points].sort((x, y) => x - y);
        let open: { a: number; b: number; have: number; triggered: number } | null = null;
        const flush = () => {
          if (!open) return;
          issues.push({
            code: "staffing_ratio",
            severity: "warning",
            shiftIds: [],
            week,
            details: {
              locationId: rule.locationId,
              ruleId: rule.id,
              date,
              from: hhmm(new Date(open.a), l.timezone),
              to: hhmm(new Date(open.b), l.timezone),
              triggerJobRoleId: rule.triggerJobRoleId,
              triggerScheduled: open.triggered,
              requiredJobRoleId: rule.requiredJobRoleId,
              needed: rule.requiredCount,
              scheduled: open.have,
            },
          });
          open = null;
        };
        for (let i = 0; i + 1 < sorted.length; i++) {
          const a = sorted[i];
          const b = sorted[i + 1];
          const t = trigger.filter(([x, y]) => x <= a && y >= b).length;
          const have = required.filter(([x, y]) => x <= a && y >= b).length;
          if (t >= rule.triggerCount && have < rule.requiredCount) {
            if (open && open.b === a) {
              open.b = b;
              open.have = Math.min(open.have, have);
              open.triggered = Math.max(open.triggered, t);
            } else {
              flush();
              open = { a, b, have, triggered: t };
            }
          } else flush();
        }
        flush();
      }
    }
  }

  return { issues, hours, publishable: !issues.some((i) => i.severity === "error") };
}

function hhmm(d: Date, timezone: string): string {
  const m = localMinuteOfDay(d, timezone);
  return `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
}

/** Periods inside [from, to) where fewer than `min` intervals overlap, with the lowest count in each. */
function coverageGaps(intervals: Interval[], from: number, to: number, min: number): Array<[number, number, number]> {
  const points = new Set<number>([from, to]);
  for (const [a, b] of intervals) {
    if (a > from && a < to) points.add(a);
    if (b > from && b < to) points.add(b);
  }
  const sorted = [...points].sort((x, y) => x - y);
  const gaps: Array<[number, number, number]> = [];
  for (let i = 0; i + 1 < sorted.length; i++) {
    const a = sorted[i];
    const b = sorted[i + 1];
    const count = intervals.filter(([s, e]) => s <= a && e >= b).length;
    if (count >= min) continue;
    const last = gaps[gaps.length - 1];
    if (last && last[1] === a) {
      last[1] = b;
      last[2] = Math.min(last[2], count);
    } else gaps.push([a, b, count]);
  }
  return gaps;
}

/** Minutes needed to go from one clinic to another: about 50 km/h plus 10 minutes, at least 15; 30 if unknown. */
export function travelMinutes(a: LocationInput, b: LocationInput): number {
  if (a.latitude == null || a.longitude == null || b.latitude == null || b.longitude == null) return 30;
  const toRad = (x: number) => (x * Math.PI) / 180;
  const dLat = toRad(b.latitude - a.latitude);
  const dLon = toRad(b.longitude - a.longitude);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.latitude)) * Math.cos(toRad(b.latitude)) * Math.sin(dLon / 2) ** 2;
  const km = 2 * 6371 * Math.asin(Math.sqrt(h));
  return Math.max(15, Math.round((km / 50) * 60) + 10);
}

function overlapsTimeOff(s: ShiftInput, t: TimeOffInput, timezone: string): boolean {
  for (const [date, startMin, endMin] of splitByLocalDay(s, timezone)) {
    if (date < t.startDate || date > t.endDate) continue;
    if (!t.start || !t.end) return true;
    if (startMin < parseTime(t.end) && endMin > parseTime(t.start)) return true;
  }
  return false;
}

/**
 * A shift is within availability when every local day it touches is covered by the
 * person's approved recurring windows and no approved exception blocks it.
 * A person with no approved recurring windows is treated as always available.
 */
function isWithinAvailability(s: ShiftInput, personId: string, timezone: string, input: ValidationInput, locationId: string): boolean {
  const atClinic = (ids?: string[] | null) => !ids || ids.length === 0 || ids.includes(locationId);
  const rules = (input.availabilityRules ?? []).filter((r) => r.personId === personId && r.status === "approved");
  const exceptions = (input.availabilityExceptions ?? []).filter((x) => x.personId === personId && x.status === "approved");
  const inEffect = (r: AvailabilityRuleInput, date: string) =>
    (!r.effectiveFrom || r.effectiveFrom <= date) && (!r.effectiveTo || r.effectiveTo >= date);
  const weekMatches = (r: AvailabilityRuleInput, date: string) => {
    const every = r.everyWeeks ?? 1;
    if (every <= 1) return true;
    const anchor = r.anchorWeek ?? r.effectiveFrom ?? date;
    const weeksApart = Math.round((Date.parse(`${mondayOf(date)}T12:00:00Z`) - Date.parse(`${mondayOf(anchor)}T12:00:00Z`)) / (7 * 86_400_000));
    return ((weeksApart % every) + every) % every === 0;
  };

  for (const [date, startMin, endMin] of splitByLocalDay(s, timezone)) {
    const today = exceptions.filter((x) => x.date <= date && (x.endDate ?? x.date) >= date && atClinic(x.locationIds));
    const window = (x: { start?: string; end?: string }): Interval => [x.start ? parseTime(x.start) : 0, x.end ? parseTime(x.end) : 24 * 60];
    const overlaps = ([a, b]: Interval) => startMin < b && endMin > a;
    // One-off "unavailable" always wins.
    if (today.some((x) => (x.kind ?? "unavailable") === "unavailable" && overlaps(window(x)))) return false;
    const rulesNow = rules.filter((r) => inEffect(r, date));
    const todays = rulesNow.filter((r) => r.weekday === weekdayOf(date) && weekMatches(r, date));
    // Weekly "unavailable" for this clinic and time
    if (todays.some((r) => r.kind === "unavailable" && atClinic(r.locationIds) && overlaps([parseTime(r.start), parseTime(r.end)]))) return false;
    // No weekly availability in effect: anything not excluded is fine.
    const availablePattern = rulesNow.filter((r) => (r.kind ?? "available") === "available");
    if (availablePattern.length === 0) continue;
    const windows: Interval[] = [
      ...todays.filter((r) => (r.kind ?? "available") === "available" && atClinic(r.locationIds)).map((r): Interval => [parseTime(r.start), parseTime(r.end)]),
      ...today.filter((x) => x.kind === "available").map(window),
    ];
    if (!isCovered(startMin, endMin, windows)) return false;
  }
  return true;
}

function mondayOf(date: string): string {
  return addDays(date, -weekdayOf(date));
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
