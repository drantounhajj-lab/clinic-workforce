import { zonedToUtc } from "@clinic-workforce/rules";
import { describe, expect, it } from "vitest";
import { buildTimesheets, payPeriodFor, recentPayPeriods, type TimesheetInput, type TsPunch, type TsShift, toHours } from "../src";

const TZ = "America/Toronto";
const at = (date: string, time: string) => zonedToUtc(date, time, TZ);
let n = 0;
const punch = (kind: "in" | "out", date: string, time: string, extra: Partial<TsPunch> = {}): TsPunch => ({
  id: `p${++n}`,
  personId: "marie",
  employmentId: "marie-qc",
  locationId: "gatineau",
  kind,
  occurredAt: at(date, time),
  method: "phone_geofence",
  flags: [],
  ...extra,
});
const shift = (date: string, start: string, end: string, breakMin = 30, endDate = date): TsShift => ({
  id: `s${++n}`,
  employmentId: "marie-qc",
  locationId: "gatineau",
  startsAt: at(date, start),
  endsAt: at(endDate, end),
  unpaidBreakMinutes: breakMin,
});

const base = (punches: TsPunch[], shifts: TsShift[] = [], extra: Partial<TimesheetInput> = {}): TimesheetInput => ({
  period: { start: "2027-01-03", end: "2027-01-17" }, // two weeks, Sunday to Saturday
  timezone: TZ,
  locations: [
    { id: "gatineau", companyId: "co-qc", province: "QC", timezone: TZ },
    { id: "ottawa", companyId: "co-on", province: "ON", timezone: TZ },
  ],
  employments: [
    { id: "marie-qc", personId: "marie", companyId: "co-qc" },
    { id: "marie-on", personId: "marie", companyId: "co-on" },
  ],
  punches,
  shifts,
  now: at("2027-01-20", "12:00"),
  ...extra,
});

describe("pay periods", () => {
  it("finds the biweekly period containing a date from any anchor", () => {
    expect(payPeriodFor("2026-01-04", "biweekly", "2027-01-05")).toEqual({ start: "2027-01-03", end: "2027-01-17" });
    expect(payPeriodFor("2026-01-04", "weekly", "2027-01-05")).toEqual({ start: "2027-01-03", end: "2027-01-10" });
    expect(payPeriodFor("2027-06-06", "biweekly", "2027-01-05")).toEqual({ start: "2027-01-03", end: "2027-01-17" });
    expect(recentPayPeriods("2026-01-04", "biweekly", "2027-01-05", 2).map((p) => p.start)).toEqual(["2027-01-03", "2026-12-20"]);
  });
});

describe("buildTimesheets", () => {
  it("pairs in/out and deducts the scheduled unpaid break once", () => {
    const [row] = buildTimesheets(base([punch("in", "2027-01-04", "08:58"), punch("out", "2027-01-04", "17:02")], [shift("2027-01-04", "09:00", "17:00")]));
    expect(row.entries).toHaveLength(1);
    expect(row.entries[0]).toMatchObject({ minutes: 484, breakMinutes: 30, paidMinutes: 454, issue: null });
    expect(row.regularMinutes).toBe(454);
  });

  it("keeps a shift that crosses midnight on the day it started", () => {
    const [row] = buildTimesheets(base([punch("in", "2027-01-08", "22:00"), punch("out", "2027-01-09", "06:00")], [shift("2027-01-08", "22:00", "06:00", 0, "2027-01-09")]));
    expect(row.entries[0]).toMatchObject({ date: "2027-01-08", minutes: 480, paidMinutes: 480 });
  });

  it("flags a missing out and a missing in", () => {
    const [row] = buildTimesheets(base([punch("in", "2027-01-04", "09:00"), punch("in", "2027-01-05", "09:00"), punch("out", "2027-01-05", "17:00"), punch("out", "2027-01-06", "17:00")]));
    expect(row.entries.map((e) => e.issue)).toEqual(["missing_out", null, "missing_in"]);
    expect(row.issues).toEqual(["missing_out", "missing_in"]);
    expect(row.paidMinutes).toBe(480);
  });

  it("splits overtime per week: Quebec after 40 h", () => {
    const punches: TsPunch[] = [];
    for (const d of ["2027-01-04", "2027-01-05", "2027-01-06", "2027-01-07", "2027-01-08"]) {
      punches.push(punch("in", d, "08:00"), punch("out", d, "17:00")); // 9 h × 5 = 45 h
    }
    const [row] = buildTimesheets(base(punches));
    expect(row.weeks[0]).toMatchObject({ paidMinutes: 45 * 60, regularMinutes: 40 * 60, overtimeMinutes: 5 * 60, thresholdMinutes: 40 * 60 });
    expect(row.weeks[1].paidMinutes).toBe(0);
    expect(toHours(row.overtimeMinutes)).toBe(5);
  });

  it("keeps each employer separate and adds prorated paid time off", () => {
    const rows = buildTimesheets(
      base([
        punch("in", "2027-01-04", "09:00"),
        punch("out", "2027-01-04", "13:00"),
        punch("in", "2027-01-05", "09:00", { employmentId: "marie-on", locationId: "ottawa" }),
        punch("out", "2027-01-05", "13:00", { employmentId: "marie-on", locationId: "ottawa" }),
      ], [], { timeOff: [{ personId: "marie", type: "vacation", startDate: "2027-01-14", endDate: "2027-01-19", paidHours: 36 }] }),
    );
    expect(rows.map((r) => r.companyId).sort()).toEqual(["co-on", "co-qc"]);
    const qc = rows.find((r) => r.companyId === "co-qc")!;
    expect(qc.paidMinutes).toBe(240);
    // 3 of the 6 vacation days fall in this period: 18 h
    expect(qc.timeOffMinutes.vacation).toBe(18 * 60);
  });

  it("marks an open punch from today as in progress, not as an issue", () => {
    const [row] = buildTimesheets(base([punch("in", "2027-01-15", "09:00")], [], { now: at("2027-01-15", "11:00") }));
    expect(row.entries[0].issue).toBe("in_progress");
    expect(row.issues).toEqual([]);
  });
});
