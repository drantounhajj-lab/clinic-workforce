import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
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

  it("gives a password session nothing, even once linked", async () => {
    await db.as(tony, "insert into public.persons (first_name, last_name, email) values ('Paul', 'Roy', 'paul@example.com')");
    // Someone registers Paul's email with a password before Paul's first sign-in...
    const squatter = await db.createUser("paul@example.com", false, { confirmed: false, password: true });
    // ...then Paul signs in with his email code, which confirms that same login.
    await db.admin("update auth.users set email_confirmed_at = now() where id = $1", [squatter.id]);
    expect(await linkedUser("paul@example.com")).toBe(squatter.id);
    // Paul's code session works; the squatter's password session sees nothing and can't punch.
    const paulByCode: TestUser = { ...squatter, method: "otp" };
    expect(await db.as(paulByCode, "select first_name from public.persons where user_id = auth.uid()")).toEqual([{ first_name: "Paul" }]);
    expect(await db.as(squatter, "select * from public.persons")).toHaveLength(0);
    expect(await db.rpc(squatter, "punch_with_location", [ids.gat, NEAR.lat, NEAR.lon])).toMatchObject({ accepted: false, reason: "not_a_member" });
    expect(await db.rpc(squatter, "create_account", ["X", "Y", "Z"])).toMatchObject({ ok: false });
  });

  it("does not let a manager create a password-allowed person", async () => {
    await expect(
      db.as(tony, "insert into public.persons (first_name, last_name, email, password_login_allowed) values ('A', 'B', 'ab@example.com', true)"),
    ).rejects.toThrow(/row-level security/);
    await expect(db.as(tony, "update public.persons set password_login_allowed = true where id = $1", [ids.marie])).rejects.toThrow(/permission denied/);
  });

  it("links logins that signed in before this fix", async () => {
    await db.as(tony, "insert into public.persons (first_name, last_name, email) values ('Old', 'Login', 'old@example.com')");
    const old = await db.createUser("old@example.com");
    await db.admin("update public.persons set user_id = null where email = 'old@example.com'");
    const [{ n }] = await db.admin<{ n: number }>("select app.link_pending_logins() as n");
    expect(n).toBeGreaterThanOrEqual(1);
    expect(await linkedUser("old@example.com")).toBe(old.id);
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

describe("App Review demo account (supabase/snippets/review-account.sql)", () => {
  it("creates a separate demo organization the reviewer can use", async () => {
    const reviewer = await db.createUser("apple.review@example.com", false, { password: true });
    const sql = readFileSync(new URL("../snippets/review-account.sql", import.meta.url), "utf8").replace("'review@example.com'", "'apple.review@example.com'");
    await db.admin(sql);

    const me = await db.as<{ first_name: string }>(reviewer, "select first_name from public.persons where user_id = auth.uid()");
    expect(me).toEqual([{ first_name: "App" }]);
    // Sees only the demo organization
    const clinics = await db.as<{ name: string }>(reviewer, "select name from public.locations");
    expect(clinics.map((c) => c.name)).toEqual(["Demo Clinic"]);
    expect(await db.as(reviewer, "select * from public.persons where email = 'marie@example.com'")).toHaveLength(0);
    // Sees published shifts and can punch at the demo clinic once it saves its location there
    const shifts = await db.as(reviewer, "select id from public.shifts");
    expect(shifts).toHaveLength(20);
    const [loc] = await db.as<{ id: string }>(reviewer, "update public.locations set latitude = 37.3349, longitude = -122.009 returning id");
    const punch = await db.rpc(reviewer, "punch_with_location", [loc.id, 37.335, -122.0091, 10]);
    expect(punch).toMatchObject({ accepted: true });
    // Running it twice is refused
    await expect(db.admin(sql)).rejects.toThrow(/already set up/);
  });
});

describe("punch-only staff, shift exchanges and custom roles", () => {
  let ana: TestUser; // employee, Gatineau
  let ben: TestUser; // employee, Gatineau
  let coord: TestUser; // custom role "Coordonnatrice" (schedule only), Gatineau
  const s: Record<string, string> = {};
  const nextMonday = () => {
    const d = new Date(`${thisMonday()}T12:00:00Z`);
    d.setUTCDate(d.getUTCDate() + 7);
    return d.toISOString().slice(0, 10);
  };
  const at = (day: number, hour: number) => {
    const d = new Date(`${nextMonday()}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() + day);
    d.setUTCHours(hour);
    return d.toISOString();
  };
  const addShift = async (emp: string, day: number, from: number, to: number) =>
    (
      await db.as<{ id: string }>(
        julie,
        "insert into public.shifts (location_id, week_start, employment_id, starts_at, ends_at) values ($1, $2, $3, $4, $5) returning id",
        [ids.gat, nextMonday(), emp, at(day, from), at(day, to)],
      )
    )[0].id;
  const ownerOf = async (shift: string) =>
    (await db.admin<{ employment_id: string }>("select employment_id from public.shifts where id = $1", [shift]))[0].employment_id;

  beforeAll(async () => {
    const people = await db.as<{ id: string; email: string }>(
      tony,
      `insert into public.persons (first_name, last_name, email) values
         ('Ana', 'Roy', 'ana@example.com'), ('Ben', 'Roy', 'ben@example.com'), ('Coord', 'Roy', 'coord@example.com')
       returning id, email`,
    );
    for (const p of people) s[p.email.split("@")[0]] = p.id;
    for (const who of ["ana", "ben", "coord"]) {
      const [e] = await db.as<{ id: string }>(tony, "insert into public.employments (person_id, company_id) values ($1, $2) returning id", [s[who], ids.coQc]);
      await db.as(tony, "insert into public.employment_locations (employment_id, location_id) values ($1, $2)", [e.id, ids.gat]);
      s[`emp_${who}`] = e.id;
    }
    ana = await db.createUser("ana@example.com");
    ben = await db.createUser("ben@example.com");
    coord = await db.createUser("coord@example.com");
    await db.as(julie, "insert into public.schedule_weeks (location_id, week_start, status, published_at) values ($1, $2, 'published', now())", [ids.gat, nextMonday()]);
    s.anaMon = await addShift(s.emp_ana, 0, 13, 21);
    s.benTue = await addShift(s.emp_ben, 1, 13, 21);
    s.anaWed = await addShift(s.emp_ana, 2, 13, 21);
    s.benWed = await addShift(s.emp_ben, 2, 14, 18);
  });

  it("staff can't create, edit or decline shifts, only acknowledge them", async () => {
    await expect(
      db.as(ana, "insert into public.shifts (location_id, week_start, employment_id, starts_at, ends_at) values ($1, $2, $3, $4, $5)", [
        ids.gat, nextMonday(), s.emp_ana, at(3, 13), at(3, 21),
      ]),
    ).rejects.toThrow(/row-level security/);
    expect(await db.as(ana, "update public.shifts set ends_at = ends_at + interval '2 hours' where id = $1 returning id", [s.anaMon])).toHaveLength(0);
    expect(await db.as(ana, "delete from public.shifts where id = $1 returning id", [s.anaMon])).toHaveLength(0);
    expect(await db.rpc(ana, "respond_to_shift", [s.anaMon, "declined"])).toMatchObject({ ok: false });
    expect(await db.rpc(ana, "respond_to_shift", [s.anaMon, "confirmed"])).toMatchObject({ ok: true });
  });

  it("gives a shift away: colleague accepts, manager approves", async () => {
    const cands = await db.rpc<{ ok: boolean; colleagues: { employment_id: string; first_name: string }[] }>(ana, "swap_candidates", [s.anaMon]);
    expect(cands.colleagues.map((c) => c.first_name)).toEqual(expect.arrayContaining(["Ben", "Marie"]));
    expect(cands.colleagues.map((c) => c.first_name)).not.toContain("Ana");
    expect(await db.rpc(ben, "swap_candidates", [s.anaMon])).toMatchObject({ ok: false });

    const req = await db.rpc<{ ok: boolean; id: string }>(ana, "request_shift_swap", [s.anaMon, s.emp_ben, null, "Rendez-vous"]);
    expect(req.ok).toBe(true);
    expect(await db.rpc(ana, "request_shift_swap", [s.anaMon, s.emp_ben, null, null])).toMatchObject({ ok: false, reason: "already_requested" });
    // Not visible to people outside the exchange; the manager can't approve before the colleague accepts
    expect(await db.as(marie, "select * from public.shift_swaps")).toHaveLength(0);
    expect(await db.rpc(julie, "decide_swap", [req.id, true, null])).toMatchObject({ ok: false, reason: "not_pending" });
    expect(await db.rpc(ana, "respond_to_swap", [req.id, true])).toMatchObject({ ok: false });
    expect(await db.rpc(ben, "respond_to_swap", [req.id, true])).toMatchObject({ ok: true });
    expect(await db.rpc(ben, "decide_swap", [req.id, true, null])).toMatchObject({ ok: false, reason: "not_allowed" });
    expect(await db.rpc(julie, "decide_swap", [req.id, true, "OK"])).toMatchObject({ ok: true });
    expect(await ownerOf(s.anaMon)).toBe(s.emp_ben);
  });

  it("exchanges two shifts, and refuses one that would overlap", async () => {
    // Ana gives Wednesday to Ben, who already works Wednesday afternoon: refused for overlap
    const clash = await db.rpc<{ id: string }>(ana, "request_shift_swap", [s.anaWed, s.emp_ben, null, null]);
    await db.rpc(ben, "respond_to_swap", [clash.id, true]);
    expect(await db.rpc(julie, "decide_swap", [clash.id, true, null])).toMatchObject({ ok: false, reason: "overlap" });
    expect(await db.rpc(julie, "decide_swap", [clash.id, false, "Conflit"])).toMatchObject({ ok: true });

    // Ana's Wednesday for Ben's Tuesday
    const ex = await db.rpc<{ ok: boolean; id: string }>(ana, "request_shift_swap", [s.anaWed, s.emp_ben, s.benTue, null]);
    expect(ex.ok).toBe(true);
    await db.rpc(ben, "respond_to_swap", [ex.id, true]);
    expect(await db.rpc(julie, "decide_swap", [ex.id, true, null])).toMatchObject({ ok: false, reason: "overlap" });
    // Remove the overlap (Ben's other Wednesday shift), then it goes through
    await db.as(julie, "delete from public.shifts where id = $1", [s.benWed]);
    expect(await db.rpc(julie, "decide_swap", [ex.id, true, null])).toMatchObject({ ok: true });
    expect(await ownerOf(s.anaWed)).toBe(s.emp_ben);
    expect(await ownerOf(s.benTue)).toBe(s.emp_ana);
  });

  it("lets the colleague refuse and the requester cancel", async () => {
    const r1 = await db.rpc<{ id: string }>(ana, "request_shift_swap", [s.benTue, s.emp_ben, null, null]);
    expect(await db.rpc(ben, "respond_to_swap", [r1.id, false])).toMatchObject({ ok: true });
    const r2 = await db.rpc<{ id: string }>(ana, "request_shift_swap", [s.benTue, s.emp_ben, null, null]);
    expect(await db.rpc(ana, "cancel_swap", [r2.id])).toMatchObject({ ok: true });
    const rows = await db.as<{ status: string }>(ana, "select status from public.shift_swaps where id in ($1, $2) order by created_at", [r1.id, r2.id]);
    expect(rows.map((r) => r.status)).toEqual(["refused_colleague", "cancelled"]);
    // The phone app's list: names and times for both people, nothing for others
    const mine = await db.rpc<{ incoming: boolean; requester_name: string; target_name: string; shift: { starts_at: string } }[]>(ben, "my_swaps", []);
    expect(mine.length).toBeGreaterThanOrEqual(4);
    expect(mine.every((m) => m.incoming)).toBe(true);
    expect(mine[0]).toMatchObject({ requester_name: "Ana Roy", target_name: "Ben Roy" });
    expect(await db.rpc(marie, "my_swaps", [])).toEqual([]);
  });

  it("custom roles grant only their permissions, at the clinics where they're assigned", async () => {
    await expect(
      db.as(julie, "insert into public.custom_roles (company_id, name, permissions) values ($1, 'X', '{schedule}')", [ids.coQc]),
    ).rejects.toThrow(/row-level security/);
    await expect(
      db.as(tony, "insert into public.custom_roles (company_id, name, permissions) values ($1, 'Bad', '{everything}')", [ids.coQc]),
    ).rejects.toThrow(/check constraint/);
    const [role] = await db.as<{ id: string }>(
      tony,
      "insert into public.custom_roles (company_id, name, permissions) values ($1, 'Coordonnatrice', '{schedule}') returning id",
      [ids.coQc],
    );
    // Clinic manager assigns it at her clinic; not at a clinic of another company
    await db.as(julie, "insert into public.custom_role_assignments (person_id, custom_role_id, location_id) values ($1, $2, $3)", [s.coord, role.id, ids.gat]);
    await expect(
      db.as(tony, "insert into public.custom_role_assignments (person_id, custom_role_id, location_id) values ($1, $2, $3)", [s.coord, role.id, ids.ott]),
    ).rejects.toThrow(/same company/);

    // Schedule: yes
    await db.as(coord, "insert into public.shifts (location_id, week_start, employment_id, starts_at, ends_at) values ($1, $2, $3, $4, $5)", [
      ids.gat, nextMonday(), s.emp_ana, at(4, 13), at(4, 17),
    ]);
    expect(await db.as(coord, "select id from public.shifts where location_id = $1", [ids.ott])).toHaveLength(0);
    // Employees, punches, clinic settings, iPads: no
    await expect(
      db.as(coord, "insert into public.employment_locations (employment_id, location_id) values ($1, $2)", [ids.empLuc, ids.gat]),
    ).rejects.toThrow();
    expect(await db.as(coord, "select * from public.punches where person_id <> app.my_person_id()")).toHaveLength(0);
    expect(await db.as(coord, "update public.locations set geofence_radius_m = 999 where id = $1 returning id", [ids.gat])).toHaveLength(0);
    expect(await db.rpc(coord, "kiosk_current_code", [ids.gat])).toMatchObject({ ok: false });

    // ...and she can approve exchanges at that clinic
    const shift = await addShift(s.emp_ana, 5, 13, 17);
    const r = await db.rpc<{ id: string }>(ana, "request_shift_swap", [shift, s.emp_ben, null, null]);
    await db.rpc(ben, "respond_to_swap", [r.id, true]);
    expect(await db.rpc(coord, "decide_swap", [r.id, true, null])).toMatchObject({ ok: true });

    // Removing the role removes the rights
    await db.as(julie, "delete from public.custom_role_assignments where person_id = $1", [s.coord]);
    await expect(
      db.as(coord, "insert into public.shifts (location_id, week_start, employment_id, starts_at, ends_at) values ($1, $2, $3, $4, $5)", [
        ids.gat, nextMonday(), s.emp_ana, at(6, 13), at(6, 17),
      ]),
    ).rejects.toThrow(/row-level security/);
  });
});
