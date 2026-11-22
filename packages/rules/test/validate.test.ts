import { describe, expect, it } from "vitest";
import {
  type AvailabilityRuleInput,
  type EmploymentInput,
  type LocationInput,
  type ShiftInput,
  type ValidationInput,
  validateSchedule,
} from "../src";
import { addDays, localWeekStart, longestRestTouching, zonedToUtc } from "../src/time";

const TZ = "America/Toronto";
const WEEK = "2027-01-04"; // Monday

// Two companies, one clinic each: Gatineau (QC) and Ottawa (ON), plus an Alberta clinic.
const locations: LocationInput[] = [
  { id: "gatineau", companyId: "co-qc", province: "QC", timezone: TZ },
  { id: "hull", companyId: "co-qc", province: "QC", timezone: TZ },
  { id: "ottawa", companyId: "co-on", province: "ON", timezone: TZ },
  { id: "calgary", companyId: "co-ab", province: "AB", timezone: "America/Edmonton" },
];

const employments: EmploymentInput[] = [
  // Marie works for both companies
  { id: "marie-qc", personId: "marie", companyId: "co-qc", locationIds: ["gatineau"], desiredWeeklyMinutes: 30 * 60, maxWeeklyMinutes: 35 * 60 },
  { id: "marie-on", personId: "marie", companyId: "co-on", locationIds: ["ottawa"] },
  { id: "luc-on", personId: "luc", companyId: "co-on", locationIds: [], minWeeklyMinutes: 20 * 60 },
  { id: "sam-ab", personId: "sam", companyId: "co-ab", locationIds: [] },
];

let n = 0;
/** Shift on a day of WEEK (0 = Monday), local times. */
function shift(employmentId: string | null, locationId: string, day: number, start: string, end: string, breakMin = 30, week = WEEK): ShiftInput {
  const date = addDays(week, day);
  return {
    id: `s${++n}`,
    employmentId,
    locationId,
    startsAt: zonedToUtc(date, start, TZ),
    endsAt: zonedToUtc(date, end, TZ),
    unpaidBreakMinutes: breakMin,
  };
}

function run(shifts: ShiftInput[], extra: Partial<ValidationInput> = {}) {
  return validateSchedule({
    locations,
    employments,
    shifts,
    weeks: [WEEK],
    now: zonedToUtc("2026-12-20", "09:00", TZ),
    ...extra,
  });
}

const codes = (r: ReturnType<typeof run>) => r.issues.map((i) => i.code).sort();

describe("time helpers", () => {
  it("converts local Toronto time to UTC in winter and summer", () => {
    expect(zonedToUtc("2027-01-04", "09:00", TZ).toISOString()).toBe("2027-01-04T14:00:00.000Z");
    expect(zonedToUtc("2027-07-05", "09:00", TZ).toISOString()).toBe("2027-07-05T13:00:00.000Z");
  });

  it("finds the Monday of the local week, including late Sunday evening", () => {
    // Sunday Jan 10, 23:30 local = Monday Jan 11 04:30 UTC, still in the week of Jan 4
    expect(localWeekStart(new Date("2027-01-11T04:30:00Z"), TZ)).toBe("2027-01-04");
  });

  it("measures rest between known shifts in full, across the window edge", () => {
    const h = 3_600_000;
    // Shift ends at 41h, next one starts at 81h; window ends at 48h → rest = 40h
    expect(longestRestTouching([[0, 8 * h], [33 * h, 41 * h], [81 * h, 89 * h]], 0, 48 * h)).toBe(40 * h);
  });
});

describe("validateSchedule", () => {
  it("passes a normal week and reports scheduled vs desired hours", () => {
    const r = run([0, 1, 2, 3].map((d) => shift("marie-qc", "gatineau", d, "09:00", "17:00")));
    expect(r.issues).toEqual([]);
    expect(r.publishable).toBe(true);
    expect(r.hours).toEqual([
      { employmentId: "marie-qc", week: WEEK, scheduledMinutes: 4 * 450, desiredWeeklyMinutes: 1800, minWeeklyMinutes: null, maxWeeklyMinutes: 2100 },
    ]);
  });

  it("flags overtime after 40 h in Quebec but not under 44 h in Ontario", () => {
    // 5 × 8.5 h paid = 42.5 h
    const qc = run([0, 1, 2, 3, 4].map((d) => shift("marie-qc", "gatineau", d, "08:00", "17:00")));
    expect(codes(qc)).toContain("overtime");
    const ot = qc.issues.find((i) => i.code === "overtime")!;
    expect(ot.details.overtimeMinutes).toBe(150);

    const on = run([0, 1, 2, 3, 4].map((d) => shift("luc-on", "ottawa", d, "08:00", "17:00")));
    expect(codes(on)).not.toContain("overtime");
  });

  it("counts overtime per company, or across companies when the account combines them", () => {
    // Marie: 3 days in QC (22.5 h) + 3 days in ON (22.5 h) = 45 h
    const shifts = [
      ...[0, 1, 2].map((d) => shift("marie-qc", "gatineau", d, "08:00", "16:00")),
      ...[3, 4, 5].map((d) => shift("marie-on", "ottawa", d, "08:00", "16:00")),
    ];
    expect(codes(run(shifts))).not.toContain("overtime");
    const combined = run(shifts, { combineRelatedCompanyHours: true });
    expect(codes(combined)).toContain("overtime");
    expect(combined.issues.find((i) => i.code === "overtime")!.details.thresholdMinutes).toBe(40 * 60);
  });

  it("blocks overlapping shifts for the same person across companies", () => {
    const r = run([
      shift("marie-qc", "gatineau", 0, "09:00", "17:00"),
      shift("marie-on", "ottawa", 0, "16:00", "20:00", 0),
    ]);
    expect(codes(r)).toContain("shift_overlap");
    expect(r.publishable).toBe(false);
  });

  it("blocks a clinic outside the employer or outside the allowed clinics", () => {
    const otherCompany = run([shift("marie-qc", "ottawa", 0, "09:00", "13:00", 0)]);
    expect(codes(otherCompany)).toContain("location_not_allowed");
    const notAllowed = run([shift("marie-qc", "hull", 0, "09:00", "13:00", 0)]);
    expect(codes(notAllowed)).toContain("location_not_allowed");
    // Empty list = any clinic of the company
    const anyClinic = run([shift("luc-on", "ottawa", 0, "09:00", "13:00", 0)]);
    expect(codes(anyClinic)).not.toContain("location_not_allowed");
  });

  it("blocks scheduling when a blocking licence has expired", () => {
    const r = run([shift("marie-qc", "gatineau", 2, "09:00", "13:00", 0)], {
      credentials: [{ personId: "marie", name: "OPQ licence", expiresOn: "2027-01-05", blocksSchedulingWhenExpired: true }],
    });
    expect(codes(r)).toContain("credential_expired");
    expect(r.publishable).toBe(false);
  });

  it("warns when a shift is outside approved availability or on a day off", () => {
    const availabilityRules = [0, 1, 2, 3, 4].map((weekday) => ({
      personId: "marie", weekday, start: "08:00", end: "15:00", status: "approved" as const,
    }));
    const availabilityExceptions = [{ personId: "marie", date: addDays(WEEK, 1), status: "approved" as const }];

    const late = run([shift("marie-qc", "gatineau", 0, "09:00", "17:00")], { availabilityRules });
    expect(codes(late)).toContain("outside_availability");

    const ok = run([shift("marie-qc", "gatineau", 0, "09:00", "14:30", 0)], { availabilityRules });
    expect(codes(ok)).not.toContain("outside_availability");

    const dayOff = run([shift("marie-qc", "gatineau", 1, "09:00", "14:30", 0)], { availabilityRules, availabilityExceptions });
    expect(codes(dayOff)).toContain("outside_availability");

    const pendingIgnored = run([shift("marie-qc", "gatineau", 0, "09:00", "17:00")], {
      availabilityRules: availabilityRules.map((r) => ({ ...r, status: "pending" as const })),
    });
    expect(codes(pendingIgnored)).not.toContain("outside_availability");
  });

  it("warns when a shift over 5 h has no 30-minute meal break", () => {
    expect(codes(run([shift("luc-on", "ottawa", 0, "09:00", "17:00", 0)]))).toContain("meal_break_missing");
    expect(codes(run([shift("luc-on", "ottawa", 0, "09:00", "14:00", 0)]))).not.toContain("meal_break_missing");
  });

  it("warns that a Quebec employee may refuse a shift announced less than 5 days ahead", () => {
    const now = zonedToUtc(addDays(WEEK, -3), "09:00", TZ); // Friday before
    const qc = shift("marie-qc", "gatineau", 0, "09:00", "13:00", 0);
    const on = shift("luc-on", "ottawa", 0, "09:00", "13:00", 0);
    const r = run([qc, on], { now, changedShiftIds: [qc.id, on.id] });
    const notice = r.issues.filter((i) => i.code === "short_notice_refusable");
    expect(notice).toHaveLength(1);
    expect(notice[0].shiftIds).toEqual([qc.id]);

    const early = run([qc], { now: zonedToUtc(addDays(WEEK, -6), "09:00", TZ), changedShiftIds: [qc.id] });
    expect(codes(early)).not.toContain("short_notice_refusable");

    const unchanged = run([qc], { now });
    expect(codes(unchanged)).not.toContain("short_notice_refusable");
  });

  it("checks Quebec's 32-hour weekly rest, counting a Saturday-to-Monday rest in full", () => {
    const nextMonday = shift("marie-qc", "gatineau", 0, "09:00", "13:00", 0, addDays(WEEK, 7));
    const monToSat = [0, 1, 2, 3, 4, 5].map((d) => shift("marie-qc", "gatineau", d, "09:00", "13:00", 0));
    expect(codes(run([...monToSat, nextMonday]))).not.toContain("weekly_rest");

    const everyDay = [0, 1, 2, 3, 4, 5, 6].map((d) => shift("marie-qc", "gatineau", d, "09:00", "13:00", 0));
    const r = run([...everyDay, nextMonday]);
    expect(codes(r)).toContain("weekly_rest");
    expect(r.issues.find((i) => i.code === "weekly_rest")!.details.requiredMinutes).toBe(32 * 60);
  });

  it("accepts Ontario's 48 hours over 2 weeks when a week has no 24-hour rest", () => {
    const prevWeek = addDays(WEEK, -7);
    // Previous week: Monday to Friday, then Saturday-Sunday off (well over 48 h)
    const prev = [0, 1, 2, 3, 4].map((d) => shift("luc-on", "ottawa", d, "09:00", "13:00", 0, prevWeek));
    // This week: every day, and next Monday too
    const thisWeek = [0, 1, 2, 3, 4, 5, 6].map((d) => shift("luc-on", "ottawa", d, "09:00", "13:00", 0));
    const nextMonday = shift("luc-on", "ottawa", 0, "09:00", "13:00", 0, addDays(WEEK, 7));
    expect(codes(run([...prev, ...thisWeek, nextMonday]))).not.toContain("weekly_rest");

    // Previous week also every day → no 48 h rest in the 2-week period
    const prevEveryDay = [0, 1, 2, 3, 4, 5, 6].map((d) => shift("luc-on", "ottawa", d, "09:00", "13:00", 0, prevWeek));
    const prevPrevSunday = shift("luc-on", "ottawa", 6, "09:00", "13:00", 0, addDays(WEEK, -14));
    expect(codes(run([prevPrevSunday, ...prevEveryDay, ...thisWeek, nextMonday]))).toContain("weekly_rest");
  });

  it("warns above an employee's maximum and below their minimum hours", () => {
    // Marie max 35 h: 5 × 7.5 h = 37.5 h
    const above = run([0, 1, 2, 3, 4].map((d) => shift("marie-qc", "gatineau", d, "08:00", "16:00")));
    expect(codes(above)).toContain("above_max_hours");
    // Luc min 20 h: 2 × 7.5 h = 15 h
    const below = run([0, 1].map((d) => shift("luc-on", "ottawa", d, "08:00", "16:00")));
    expect(codes(below)).toContain("below_min_hours");
  });

  it("skips open shifts in person checks", () => {
    const r = run([shift(null, "gatineau", 0, "06:00", "18:00", 0)]);
    expect(r.issues).toEqual([]);
    expect(r.hours).toEqual([]);
  });

  it("warns when a clinic is in a province without rules yet", () => {
    const s: ShiftInput = {
      id: "ab1", employmentId: "sam-ab", locationId: "calgary",
      startsAt: zonedToUtc(WEEK, "09:00", "America/Edmonton"), endsAt: zonedToUtc(WEEK, "13:00", "America/Edmonton"),
      unpaidBreakMinutes: 0,
    };
    expect(codes(run([s]))).toEqual(["province_rules_missing"]);
  });
});

describe("validateSchedule: travel, time off, coverage, expiring credentials", () => {
  const withCoords: LocationInput[] = [
    { id: "gatineau", companyId: "co-qc", province: "QC", timezone: TZ, latitude: 45.4765, longitude: -75.7013 },
    { id: "hull", companyId: "co-qc", province: "QC", timezone: TZ, latitude: 45.4283, longitude: -75.7131 },
    { id: "ottawa", companyId: "co-on", province: "ON", timezone: TZ, latitude: 45.4215, longitude: -75.6972 },
    { id: "calgary", companyId: "co-ab", province: "AB", timezone: "America/Edmonton" },
  ];

  it("warns when two clinics are too close in time to travel between them", () => {
    const r = run([shift("marie-qc", "gatineau", 0, "08:00", "12:00", 0), shift("marie-on", "ottawa", 0, "12:05", "16:00", 0)], { locations: withCoords });
    const travel = r.issues.find((i) => i.code === "travel_time");
    expect(travel?.details).toMatchObject({ gapMinutes: 5 });
    expect(Number(travel?.details.requiredMinutes)).toBeGreaterThanOrEqual(15);
    const ok = run([shift("marie-qc", "gatineau", 0, "08:00", "12:00", 0), shift("marie-on", "ottawa", 0, "13:00", "16:00", 0)], { locations: withCoords });
    expect(codes(ok)).not.toContain("travel_time");
  });

  it("blocks a shift during approved time off, full day or part of a day", () => {
    const vacation = run([shift("marie-qc", "gatineau", 1, "09:00", "15:00")], {
      timeOff: [{ personId: "marie", startDate: addDays(WEEK, 0), endDate: addDays(WEEK, 2), type: "vacation" }],
    });
    expect(vacation.issues.find((i) => i.code === "time_off")?.severity).toBe("error");
    expect(vacation.publishable).toBe(false);
    const appointment = { personId: "marie", startDate: addDays(WEEK, 1), endDate: addDays(WEEK, 1), start: "16:00", end: "17:00", type: "personal" };
    expect(codes(run([shift("marie-qc", "gatineau", 1, "09:00", "15:00")], { timeOff: [appointment] }))).not.toContain("time_off");
    expect(codes(run([shift("marie-qc", "gatineau", 1, "09:00", "16:30")], { timeOff: [appointment] }))).toContain("time_off");
  });

  it("reports when a clinic lacks a position during the required hours", () => {
    const emps: EmploymentInput[] = employments.map((e) => (e.id === "marie-qc" ? { ...e, jobRoleId: "reception" } : e));
    const rule = { id: "r1", locationId: "gatineau", jobRoleId: "reception", weekdays: [0], start: "08:00", end: "17:00", minCount: 1 };
    const r = run([shift("marie-qc", "gatineau", 0, "08:00", "12:00", 0)], { employments: emps, coverageRules: [rule] });
    const gaps = r.issues.filter((i) => i.code === "coverage_gap");
    expect(gaps).toHaveLength(1);
    expect(gaps[0].details).toMatchObject({ from: "12:00", to: "17:00", needed: 1, scheduled: 0 });
    const full = run([shift("marie-qc", "gatineau", 0, "08:00", "17:00", 0)], { employments: emps, coverageRules: [rule] });
    expect(codes(full)).not.toContain("coverage_gap");
    // The shift's own position wins over the employee's
    const other = run([{ ...shift("marie-qc", "gatineau", 0, "08:00", "17:00", 0), jobRoleId: "podiatrist" }], { employments: emps, coverageRules: [rule] });
    expect(codes(other)).toContain("coverage_gap");
  });

  it("warns when a shift is for a position the employee doesn't hold", () => {
    const emps: EmploymentInput[] = employments.map((e) => (e.id === "marie-qc" ? { ...e, jobRoleId: "reception" } : e));
    const pod = { ...shift("marie-qc", "gatineau", 0, "09:00", "12:00", 0), jobRoleId: "podiatrist" };
    const r = run([pod], { employments: emps });
    expect(r.issues.find((i) => i.code === "position_mismatch")?.severity).toBe("warning");
    expect(codes(run([{ ...pod, jobRoleId: "reception" }], { employments: emps }))).not.toContain("position_mismatch");
    // Employee without a position: nothing to compare
    expect(codes(run([pod]))).not.toContain("position_mismatch");
  });

  it("warns once when a credential expires within 30 days", () => {
    const cred = { personId: "marie", name: "Permis OPPQ", expiresOn: addDays(WEEK, 10), blocksSchedulingWhenExpired: true };
    const r = run([shift("marie-qc", "gatineau", 0, "09:00", "12:00", 0), shift("marie-qc", "gatineau", 1, "09:00", "12:00", 0)], { credentials: [cred] });
    expect(r.issues.filter((i) => i.code === "credential_expiring")).toHaveLength(1);
    expect(r.publishable).toBe(true);
  });
});

describe("availability patterns (phase 2)", () => {
  const avail = (extra: Partial<AvailabilityRuleInput> & Pick<AvailabilityRuleInput, "weekday" | "start" | "end">): AvailabilityRuleInput => ({
    personId: "marie",
    status: "approved",
    ...extra,
  });
  const out = (s: ShiftInput, extra: Partial<ValidationInput>) => codes(run([s], extra)).includes("outside_availability");

  it("alternating weeks: available Mondays of week A only", () => {
    const rules = [avail({ weekday: 0, start: "08:00", end: "17:00", everyWeeks: 2, anchorWeek: WEEK })];
    expect(out(shift("marie-qc", "gatineau", 0, "09:00", "16:00"), { availabilityRules: rules })).toBe(false);
    const weekB = addDays(WEEK, 7);
    expect(out(shift("marie-qc", "gatineau", 0, "09:00", "16:00", 30, weekB), { availabilityRules: rules, weeks: [weekB] })).toBe(true);
    const weekA2 = addDays(WEEK, 14);
    expect(out(shift("marie-qc", "gatineau", 0, "09:00", "16:00", 30, weekA2), { availabilityRules: rules, weeks: [weekA2] })).toBe(false);
  });

  it("effective dates: a pattern that ended no longer restricts; one not started yet doesn't either", () => {
    const ended = [avail({ weekday: 1, start: "08:00", end: "10:00", effectiveFrom: "2026-01-05", effectiveTo: "2026-12-31" })];
    expect(out(shift("marie-qc", "gatineau", 0, "13:00", "17:00"), { availabilityRules: ended })).toBe(false);
    const future = [avail({ weekday: 1, start: "08:00", end: "10:00", effectiveFrom: "2027-02-01" })];
    expect(out(shift("marie-qc", "gatineau", 0, "13:00", "17:00"), { availabilityRules: future })).toBe(false);
  });

  it("clinics: available Mondays at Hull only → a Gatineau shift is outside availability", () => {
    const rules = [avail({ weekday: 0, start: "08:00", end: "17:00", locationIds: ["hull"] })];
    expect(out(shift("marie-qc", "hull", 0, "09:00", "16:00"), { availabilityRules: rules })).toBe(false);
    expect(out(shift("marie-qc", "gatineau", 0, "09:00", "16:00"), { availabilityRules: rules })).toBe(true);
  });

  it("weekly 'unavailable' and one-off days: unavailable wins, one-off available adds a window", () => {
    const rules = [avail({ weekday: 2, start: "12:00", end: "18:00", kind: "unavailable" })];
    expect(out(shift("marie-qc", "gatineau", 2, "13:00", "17:00"), { availabilityRules: rules })).toBe(true);
    expect(out(shift("marie-qc", "gatineau", 2, "08:00", "12:00"), { availabilityRules: rules })).toBe(false);
    const range = [{ personId: "marie", date: addDays(WEEK, 3), endDate: addDays(WEEK, 4), status: "approved" as const }];
    expect(out(shift("marie-qc", "gatineau", 4, "09:00", "12:00"), { availabilityExceptions: range })).toBe(true);
    const pattern = [avail({ weekday: 0, start: "08:00", end: "12:00" })];
    const extra = [{ personId: "marie", date: addDays(WEEK, 5), start: "09:00", end: "15:00", kind: "available" as const, status: "approved" as const }];
    expect(out(shift("marie-qc", "gatineau", 5, "10:00", "14:00"), { availabilityRules: pattern })).toBe(true);
    expect(out(shift("marie-qc", "gatineau", 5, "10:00", "14:00"), { availabilityRules: pattern, availabilityExceptions: extra })).toBe(false);
  });
});

describe("staffing ratios (phase 2)", () => {
  const emps: EmploymentInput[] = [
    { id: "p1", personId: "p1", companyId: "co-qc", locationIds: ["gatineau"], jobRoleId: "pod" },
    { id: "p2", personId: "p2", companyId: "co-qc", locationIds: ["gatineau"], jobRoleId: "pod" },
    { id: "r1", personId: "r1", companyId: "co-qc", locationIds: ["gatineau"], jobRoleId: "rec" },
    { id: "a1", personId: "a1", companyId: "co-qc", locationIds: ["gatineau"], jobRoleId: "asst" },
  ];
  const ratios = [
    { id: "need-rec", locationId: "gatineau", weekdays: [0, 1, 2, 3, 4], start: "00:00", end: "24:00", triggerJobRoleId: "pod", triggerCount: 2, requiredJobRoleId: "rec", requiredCount: 1 },
    { id: "need-asst", locationId: "gatineau", weekdays: [0, 1, 2, 3, 4], start: "00:00", end: "24:00", triggerJobRoleId: "pod", triggerCount: 2, requiredJobRoleId: "asst", requiredCount: 1 },
  ];
  const gaps = (shifts: ShiftInput[]) =>
    run(shifts, { employments: emps, staffingRatios: ratios }).issues.filter((i) => i.code === "staffing_ratio").map((i) => `${i.details.ruleId} ${i.details.from}-${i.details.to}`);

  it("two podiatrists 09–17 with a receptionist 09–13 and an assistant all day: receptionist missing 13–17", () => {
    expect(gaps([
      shift("p1", "gatineau", 0, "09:00", "17:00"),
      shift("p2", "gatineau", 0, "09:00", "17:00"),
      shift("r1", "gatineau", 0, "09:00", "13:00"),
      shift("a1", "gatineau", 0, "08:00", "18:00"),
    ])).toEqual(["need-rec 13:00-17:00"]);
  });

  it("one podiatrist: no requirement; two only overlapping 11–14: needs only then", () => {
    expect(gaps([shift("p1", "gatineau", 0, "09:00", "17:00")])).toEqual([]);
    expect(gaps([
      shift("p1", "gatineau", 0, "08:00", "14:00"),
      shift("p2", "gatineau", 0, "11:00", "17:00"),
      shift("r1", "gatineau", 0, "08:00", "17:00"),
    ])).toEqual(["need-asst 11:00-14:00"]);
  });
});
