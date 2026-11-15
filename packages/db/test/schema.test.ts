import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { eq } from "drizzle-orm";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import * as s from "../src/schema";

const migrationsFolder = fileURLToPath(new URL("../migrations", import.meta.url));

let db: ReturnType<typeof drizzle<typeof s>>;
let ids: Record<string, string> = {};

beforeAll(async () => {
  const client = new PGlite();
  db = drizzle(client, { schema: s });
  await migrate(db, { migrationsFolder });

  // Pilot-like setup: one account, two companies, one QC clinic, one ON clinic.
  const [account] = await db.insert(s.accounts).values({ name: "Pilot group" }).returning();
  const [coQc, coOn] = await db.insert(s.companies).values([
    { accountId: account.id, legalName: "Clinique Gatineau inc." },
    { accountId: account.id, legalName: "Ottawa Foot Clinic Ltd." },
  ]).returning();
  const [locQc, locOn] = await db.insert(s.locations).values([
    { accountId: account.id, companyId: coQc.id, name: "Gatineau", province: "QC" },
    { accountId: account.id, companyId: coOn.id, name: "Ottawa", province: "ON", timezone: "America/Toronto" },
  ]).returning();
  const [person] = await db.insert(s.persons).values({
    accountId: account.id, firstName: "Marie", lastName: "Tremblay",
  }).returning();
  ids = { account: account.id, coQc: coQc.id, coOn: coOn.id, locQc: locQc.id, locOn: locOn.id, person: person.id };
});

describe("schema", () => {
  it("lets one person hold an employment in two companies", async () => {
    const rows = await db.insert(s.employments).values([
      { accountId: ids.account, personId: ids.person, companyId: ids.coQc, startDate: "2027-01-04", desiredWeeklyMinutes: 1800, maxWeeklyMinutes: 2100 },
      { accountId: ids.account, personId: ids.person, companyId: ids.coOn, startDate: "2027-01-04" },
    ]).returning();
    expect(rows).toHaveLength(2);
    ids.empQc = rows[0].id;
    ids.empOn = rows[1].id;

    await db.insert(s.employmentLocations).values([
      { accountId: ids.account, employmentId: ids.empQc, locationId: ids.locQc, preferred: true },
      { accountId: ids.account, employmentId: ids.empOn, locationId: ids.locOn },
    ]);
    const found = await db.select().from(s.employments).where(eq(s.employments.personId, ids.person));
    expect(found).toHaveLength(2);
  });

  it("rejects min weekly minutes above max", async () => {
    await expect(db.insert(s.employments).values({
      accountId: ids.account, personId: ids.person, companyId: ids.coQc, startDate: "2027-06-01",
      minWeeklyMinutes: 2400, maxWeeklyMinutes: 1200,
    })).rejects.toThrow();
  });

  it("creates a schedule week with shifts and an open shift", async () => {
    const [week] = await db.insert(s.scheduleWeeks).values({
      accountId: ids.account, locationId: ids.locQc, weekStart: "2027-01-04",
    }).returning();
    ids.week = week.id;
    const shifts = await db.insert(s.shifts).values([
      { accountId: ids.account, scheduleWeekId: week.id, locationId: ids.locQc, employmentId: ids.empQc,
        startsAt: new Date("2027-01-04T13:00:00Z"), endsAt: new Date("2027-01-04T21:00:00Z"), unpaidBreakMinutes: 30 },
      { accountId: ids.account, scheduleWeekId: week.id, locationId: ids.locQc, employmentId: null,
        startsAt: new Date("2027-01-05T13:00:00Z"), endsAt: new Date("2027-01-05T17:00:00Z") },
    ]).returning();
    expect(shifts[1].employmentId).toBeNull();
    expect(shifts[0].status).toBe("draft");
  });

  it("rejects a shift that ends before it starts", async () => {
    await expect(db.insert(s.shifts).values({
      accountId: ids.account, scheduleWeekId: ids.week, locationId: ids.locQc, employmentId: ids.empQc,
      startsAt: new Date("2027-01-06T21:00:00Z"), endsAt: new Date("2027-01-06T13:00:00Z"),
    })).rejects.toThrow();
  });

  it("allows one real schedule per clinic per week, but any number of templates", async () => {
    await expect(db.insert(s.scheduleWeeks).values({
      accountId: ids.account, locationId: ids.locQc, weekStart: "2027-01-04",
    })).rejects.toThrow();

    const templates = await db.insert(s.scheduleWeeks).values([
      { accountId: ids.account, locationId: ids.locQc, weekStart: "2027-01-04", isTemplate: true, templateName: "Standard week" },
      { accountId: ids.account, locationId: ids.locQc, weekStart: "2027-01-04", isTemplate: true, templateName: "Summer" },
    ]).returning();
    expect(templates).toHaveLength(2);
  });

  it("stores punches with method, location check data and flags", async () => {
    const [punch] = await db.insert(s.punches).values({
      accountId: ids.account, employmentId: ids.empQc, locationId: ids.locQc,
      kind: "in", method: "phone_geofence", occurredAt: new Date("2027-01-04T12:55:00Z"),
      latitude: 45.43, longitude: -75.71, accuracyM: 12, wifiBssid: "aa:bb:cc:dd:ee:ff",
      flags: ["early_punch"],
    }).returning();
    expect(punch.flags).toEqual(["early_punch"]);
    expect(punch.mockLocationDetected).toBe(false);
  });

  it("rejects an unknown province", async () => {
    await expect(db.insert(s.locations).values({
      accountId: ids.account, companyId: ids.coQc, name: "Nowhere", province: "XX" as never,
    })).rejects.toThrow();
  });

  it("deletes everything with the account (tenant offboarding)", async () => {
    const [other] = await db.insert(s.accounts).values({ name: "Temp" }).returning();
    const [co] = await db.insert(s.companies).values({ accountId: other.id, legalName: "Temp inc." }).returning();
    await db.insert(s.locations).values({ accountId: other.id, companyId: co.id, name: "Temp", province: "ON" });
    await db.delete(s.accounts).where(eq(s.accounts.id, other.id));
    const left = await db.select().from(s.companies).where(eq(s.companies.accountId, other.id));
    expect(left).toHaveLength(0);
  });
});
