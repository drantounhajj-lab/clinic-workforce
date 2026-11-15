import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TestDb, type TestUser } from "./harness";

// Gatineau clinic and points ~40 m and ~5 km away
const GAT = { lat: 45.4765, lon: -75.7013 };
const NEAR = { lat: 45.4768, lon: -75.7016 };
const FAR = { lat: 45.43, lon: -75.69 };

let db: TestDb;
let tony: TestUser; // owner
let julie: TestUser; // clinic manager, Gatineau
let marie: TestUser; // employee, Gatineau
let luc: TestUser; // employee, Ottawa
let stranger: TestUser; // signed in, not invited
let ipad: TestUser; // anonymous kiosk login
const ids: Record<string, string> = {};

beforeAll(async () => {
  db = await TestDb.start();
  tony = await db.createUser("tony@example.com");
  const created = await db.rpc<{ ok: boolean; account_id: string }>(tony, "create_account", ["Pilot group", "Antoun", "Hajj"]);
  expect(created.ok).toBe(true);

  const [coQc] = await db.as<{ id: string }>(tony, "insert into public.companies (legal_name) values ('Clinique Gatineau inc.') returning id");
  const [coOn] = await db.as<{ id: string }>(tony, "insert into public.companies (legal_name) values ('Ottawa Foot Clinic Ltd.') returning id");
  const [gat] = await db.as<{ id: string }>(
    tony,
    "insert into public.locations (company_id, name, province, latitude, longitude) values ($1, 'Gatineau', 'QC', $2, $3) returning id",
    [coQc.id, GAT.lat, GAT.lon],
  );
  const [ott] = await db.as<{ id: string }>(
    tony,
    "insert into public.locations (company_id, name, province, latitude, longitude) values ($1, 'Ottawa', 'ON', 45.4215, -75.6972) returning id",
    [coOn.id],
  );
  Object.assign(ids, { coQc: coQc.id, coOn: coOn.id, gat: gat.id, ott: ott.id });

  const people = await db.as<{ id: string; email: string }>(
    tony,
    `insert into public.persons (first_name, last_name, email) values
       ('Julie', 'Gagnon', 'Julie@Example.com'), ('Marie', 'Tremblay', 'marie@example.com'), ('Luc', 'Martin', 'luc@example.com')
     returning id, email`,
  );
  for (const p of people) ids[p.email.split("@")[0]] = p.id;

  await db.as(tony, "insert into public.role_assignments (person_id, role, location_id) values ($1, 'clinic_manager', $2)", [ids.julie, ids.gat]);
  const [empM] = await db.as<{ id: string }>(tony, "insert into public.employments (person_id, company_id) values ($1, $2) returning id", [ids.marie, ids.coQc]);
  await db.as(tony, "insert into public.employment_locations (employment_id, location_id) values ($1, $2)", [empM.id, ids.gat]);
  const [empL] = await db.as<{ id: string }>(tony, "insert into public.employments (person_id, company_id) values ($1, $2) returning id", [ids.luc, ids.coOn]);
  await db.as(tony, "insert into public.employment_locations (employment_id, location_id) values ($1, $2)", [empL.id, ids.ott]);
  Object.assign(ids, { empMarie: empM.id, empLuc: empL.id });

  // Invited people sign in for the first time
  julie = await db.createUser("julie@example.com");
  marie = await db.createUser("marie@example.com");
  luc = await db.createUser("luc@example.com");
  stranger = await db.createUser("stranger@example.com");
  ipad = await db.createUser(null, true);
}, 120_000);

afterAll(async () => {
  await db?.stop();
});

const thisMonday = () => {
  const d = new Date();
  const day = (d.getUTCDay() + 6) % 7;
  d.setUTCDate(d.getUTCDate() - day);
  return d.toISOString().slice(0, 10);
};

describe("accounts and invitations", () => {
  it("links an invited person to their login by email (case-insensitive)", async () => {
    const rows = await db.admin<{ email: string; user_id: string | null }>("select email, user_id from public.persons order by email");
    const byEmail = Object.fromEntries(rows.map((r) => [r.email, r.user_id]));
    expect(byEmail["julie@example.com"]).toBe(julie.id);
    expect(byEmail["marie@example.com"]).toBe(marie.id);
  });

  it("gives a signed-in stranger nothing", async () => {
    expect(await db.as(stranger, "select * from public.persons")).toHaveLength(0);
    expect(await db.as(stranger, "select * from public.locations")).toHaveLength(0);
    expect(await db.rpc(stranger, "punch_with_location", [ids.gat, NEAR.lat, NEAR.lon])).toMatchObject({ accepted: false, reason: "not_a_member" });
  });

  it("blocks visitors who are not signed in", async () => {
    await expect(db.as("anon", "select * from public.persons")).rejects.toThrow(/permission denied/);
    await expect(db.as("anon", "select public.kiosk_punch('4821')")).rejects.toThrow(/permission denied/);
  });

  it("refuses a second account for an existing member, and accounts for anonymous logins", async () => {
    expect(await db.rpc(marie, "create_account", ["X", "M", "T"])).toMatchObject({ ok: false, reason: "already_member" });
    expect(await db.rpc(ipad, "create_account", ["X", "I", "P"])).toMatchObject({ ok: false, reason: "sign_in_required" });
  });

  it("does not let anyone attach a login to a profile", async () => {
    await expect(db.as(tony, "update public.persons set user_id = $1 where id = $2", [stranger.id, ids.luc])).rejects.toThrow(/permission denied/);
  });
});

describe("manager permissions", () => {
  it("lets a clinic manager schedule at their clinic only", async () => {
    const week = thisMonday();
    await db.as(julie, "insert into public.schedule_weeks (location_id, week_start) values ($1, $2)", [ids.gat, week]);
    await expect(db.as(julie, "insert into public.schedule_weeks (location_id, week_start) values ($1, $2)", [ids.ott, week])).rejects.toThrow(
      /row-level security/,
    );
  });

  it("does not let a clinic manager edit people from another clinic", async () => {
    const rows = await db.as(julie, "update public.persons set phone = '555' where id = $1 returning id", [ids.luc]);
    expect(rows).toHaveLength(0);
    const own = await db.as(julie, "update public.persons set phone = '555' where id = $1 returning id", [ids.marie]);
    expect(own).toHaveLength(1);
  });

  it("does not let a clinic manager make someone owner", async () => {
    await expect(db.as(julie, "insert into public.role_assignments (person_id, role) values ($1, 'owner')", [ids.marie])).rejects.toThrow(
      /row-level security/,
    );
  });

  it("rejects assigning a clinic of another company to an employment", async () => {
    await expect(
      db.as(tony, "insert into public.employment_locations (employment_id, location_id) values ($1, $2)", [ids.empMarie, ids.ott]),
    ).rejects.toThrow(/another company/);
  });
});

describe("schedules seen by staff", () => {
  it("hides draft weeks and shows published ones", async () => {
    const week = thisMonday();
    const start = new Date(Date.now() + 3 * 3600_000).toISOString();
    const end = new Date(Date.now() + 11 * 3600_000).toISOString();
    const [shift] = await db.as<{ id: string }>(
      julie,
      "insert into public.shifts (location_id, week_start, employment_id, starts_at, ends_at) values ($1, $2, $3, $4, $5) returning id",
      [ids.gat, week, ids.empMarie, start, end],
    );
    ids.shift = shift.id;
    expect(await db.as(marie, "select id from public.shifts")).toHaveLength(0);
    await db.as(julie, "update public.schedule_weeks set status = 'published' where location_id = $1 and week_start = $2", [ids.gat, week]);
    expect(await db.as(marie, "select id from public.shifts")).toHaveLength(1);
    expect(await db.as(luc, "select id from public.shifts")).toHaveLength(0);
  });

  it("lets staff confirm their own shift but not edit it", async () => {
    expect(await db.rpc(marie, "respond_to_shift", [ids.shift, "confirmed"])).toEqual({ ok: true });
    expect(await db.rpc(luc, "respond_to_shift", [ids.shift, "declined"])).toMatchObject({ ok: false });
    const rows = await db.as(marie, "update public.shifts set notes = 'x' where id = $1 returning id", [ids.shift]);
    expect(rows).toHaveLength(0);
  });
});

describe("punch by location", () => {
  it("refuses clocking in more than 15 minutes before the shift", async () => {
    // Marie's shift starts in 3 hours
    expect(await db.rpc(marie, "punch_with_location", [ids.gat, NEAR.lat, NEAR.lon, 10])).toMatchObject({
      accepted: false,
      reason: "too_early",
    });
  });

  it("accepts inside the zone once the shift is near, then clocks out", async () => {
    await db.admin("update public.shifts set starts_at = now() + interval '5 minutes', ends_at = now() + interval '8 hours' where id = $1", [ids.shift]);
    const inPunch = await db.rpc<{ accepted: boolean; kind: string; distance_m: number }>(marie, "punch_with_location", [ids.gat, NEAR.lat, NEAR.lon, 10]);
    expect(inPunch).toMatchObject({ accepted: true, kind: "in" });
    expect(inPunch.distance_m).toBeGreaterThan(20);
    expect(inPunch.distance_m).toBeLessThan(60);
    const outPunch = await db.rpc(marie, "punch_with_location", [ids.gat, NEAR.lat, NEAR.lon, 10]);
    expect(outPunch).toMatchObject({ accepted: true, kind: "out" });
  });

  it("refuses outside the zone, unless the phone is on the clinic Wi-Fi", async () => {
    const far = await db.rpc<{ accepted: boolean; reason: string; distance_m: number }>(marie, "punch_with_location", [ids.gat, FAR.lat, FAR.lon, 10]);
    expect(far).toMatchObject({ accepted: false, reason: "outside_geofence" });
    expect(far.distance_m).toBeGreaterThan(4000);

    await db.as(julie, "insert into public.location_wifi (location_id, ssid, bssid) values ($1, 'Clinique', 'aa:bb:cc:dd:ee:01')", [ids.gat]);
    const wifi = await db.rpc<{ accepted: boolean; flags: string[] }>(marie, "punch_with_location", [ids.gat, FAR.lat, FAR.lon, 10, "AA:BB:CC:DD:EE:01"]);
    expect(wifi.accepted).toBe(true);
    expect(wifi.flags).toContain("outside_geofence_wifi_ok");
  });

  it("refuses a fake location", async () => {
    expect(await db.rpc(marie, "punch_with_location", [ids.gat, NEAR.lat, NEAR.lon, 10, null, true])).toMatchObject({
      accepted: false,
      reason: "mock_location",
    });
  });

  it("refuses a clinic where the person doesn't work", async () => {
    expect(await db.rpc(marie, "punch_with_location", [ids.ott, 45.4215, -75.6972, 10])).toMatchObject({ accepted: false, reason: "not_assigned" });
  });

  it("never lets staff write punches directly", async () => {
    await expect(
      db.as(marie, "insert into public.punches (person_id, employment_id, location_id, kind, method) values ($1, $2, $3, 'in', 'manual')", [
        ids.marie,
        ids.empMarie,
        ids.gat,
      ]),
    ).rejects.toThrow(/row-level security/);
  });

  it("shows punches to the person and their clinic's managers only", async () => {
    expect((await db.as(marie, "select id from public.punches")).length).toBeGreaterThan(0);
    expect((await db.as(julie, "select id from public.punches")).length).toBeGreaterThan(0);
    expect(await db.as(luc, "select id from public.punches")).toHaveLength(0);
  });
});

describe("clinic iPad", () => {
  it("pairs an iPad with a clinic using a code entered by a manager", async () => {
    const pairing = await db.rpc<{ ok: boolean; code: string }>(ipad, "kiosk_request_pairing");
    expect(pairing.ok).toBe(true);
    expect(pairing.code).toMatch(/^\d{6}$/);
    expect(await db.rpc(julie, "kiosk_approve_pairing", [pairing.code, ids.ott, "iPad"])).toMatchObject({ ok: false, reason: "not_allowed" });
    expect(await db.rpc(julie, "kiosk_approve_pairing", ["000000", ids.gat, "iPad"])).toMatchObject({ ok: false });
    expect(await db.rpc(julie, "kiosk_approve_pairing", [pairing.code, ids.gat, "iPad accueil"])).toMatchObject({ ok: true });
    expect(await db.rpc(ipad, "kiosk_me")).toMatchObject({ location_name: "Gatineau" });
  });

  it("shows a code on the iPad that staff can scan, and rejects stale codes", async () => {
    const code = await db.rpc<{ ok: boolean; code: string; payload: string }>(ipad, "kiosk_current_code", [ids.gat]);
    expect(code.ok).toBe(true);
    expect(code.code).toMatch(/^[A-Z2-9]{6}$/);
    expect(code.payload).toBe(`cw1:${ids.gat}:${code.code}`);
    expect(await db.rpc(ipad, "kiosk_current_code", [ids.ott])).toMatchObject({ ok: false });

    expect(await db.rpc(marie, "punch_with_qr", [ids.gat, code.code])).toMatchObject({ accepted: true });
    expect(await db.rpc(marie, "punch_with_qr", [ids.gat, "AAAAAA"])).toMatchObject({ accepted: false, reason: "invalid_qr" });
  });

  it("punches with a personal PIN, unique within the account", async () => {
    expect(await db.rpc(marie, "set_my_pin", ["1234"])).toMatchObject({ ok: false, reason: "pin_too_simple" });
    expect(await db.rpc(marie, "set_my_pin", ["48a1"])).toMatchObject({ ok: false, reason: "invalid_pin" });
    expect(await db.rpc(marie, "set_my_pin", ["4821"])).toEqual({ ok: true });
    expect(await db.rpc(luc, "set_my_pin", ["4821"])).toMatchObject({ ok: false, reason: "pin_taken" });
    expect(await db.rpc(marie, "has_pin")).toBe(true);

    expect(await db.rpc(ipad, "kiosk_punch", ["9876"])).toMatchObject({ accepted: false, reason: "wrong_pin" });
    expect(await db.rpc(ipad, "kiosk_punch", ["4821"])).toMatchObject({ accepted: true, first_name: "Marie" });
    expect(await db.rpc(marie, "kiosk_punch", ["4821"])).toMatchObject({ accepted: false, reason: "not_a_kiosk" });

    await db.rpc(luc, "set_my_pin", ["5937"]);
    expect(await db.rpc(ipad, "kiosk_punch", ["5937"])).toMatchObject({ accepted: false, reason: "not_assigned" });
  });

  it("never exposes PINs or QR secrets", async () => {
    await expect(db.as(tony, "select * from app.person_pins")).rejects.toThrow(/permission denied/);
    await expect(db.as(tony, "select * from app.location_secrets")).rejects.toThrow(/permission denied/);
  });
});

describe("linking logins to invited people", () => {
  const linkedUser = async (email: string) =>
    (await db.admin<{ user_id: string | null }>("select user_id from public.persons where email = $1", [email]))[0]?.user_id ?? null;

  it("links only once the email code is confirmed", async () => {
    await db.as(tony, "insert into public.persons (first_name, last_name, email) values ('Nadia', 'Roy', 'nadia@example.com')");
    const nadia = await db.createUser("nadia@example.com", false, { confirmed: false });
    expect(await linkedUser("nadia@example.com")).toBeNull();
    await db.admin("update auth.users set email_confirmed_at = now() where id = $1", [nadia.id]);
    expect(await linkedUser("nadia@example.com")).toBe(nadia.id);
  });

  it("never links a login created with a password", async () => {
    await db.as(tony, "insert into public.persons (first_name, last_name, email) values ('Paul', 'Roy', 'paul@example.com')");
    const squatter = await db.createUser("paul@example.com", false, { confirmed: false, password: true });
    await db.admin("update auth.users set email_confirmed_at = now() where id = $1", [squatter.id]);
    expect(await linkedUser("paul@example.com")).toBeNull();
  });

  it("links someone who signed in before a manager added them", async () => {
    const early = await db.createUser("early@example.com");
    await db.as(tony, "insert into public.persons (first_name, last_name, email) values ('Eve', 'Early', ' Early@Example.com ')");
    expect(await linkedUser("early@example.com")).toBe(early.id);
    expect(await db.as(early, "select first_name from public.persons where user_id = auth.uid()")).toEqual([{ first_name: "Eve" }]);
  });

  it("does not move a login that already belongs to someone", async () => {
    await db.as(tony, "insert into public.persons (first_name, last_name, email) values ('Copy', 'Marie', 'marie.copy@example.com')");
    await db.as(tony, "update public.persons set email = 'stranger2@example.com' where email = 'marie.copy@example.com'");
    const rows = await db.admin<{ n: number }>("select count(*)::int as n from public.persons where user_id = $1", [marie.id]);
    expect(rows[0].n).toBe(1);
  });
});
