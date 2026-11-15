import { describe, expect, it } from "vitest";
import {
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
