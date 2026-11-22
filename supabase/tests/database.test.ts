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

describe("review fixes: acknowledgements, changed shifts, duplicates", () => {
  let ana: TestUser;
  let ben: TestUser;
  const e: Record<string, string> = {};
  const week = () => {
    const d = new Date(`${thisMonday()}T12:00:00Z`);
    d.setUTCDate(d.getUTCDate() + 14);
    return d.toISOString().slice(0, 10);
  };
  const at = (day: number, hour: number) => {
    const d = new Date(`${week()}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() + day);
    d.setUTCHours(hour);
    return d.toISOString();
  };
  const shift = async (emp: string, day: number, from: number, to: number) =>
    (
      await db.as<{ id: string }>(
        julie,
        "insert into public.shifts (location_id, week_start, employment_id, starts_at, ends_at) values ($1, $2, $3, $4, $5) returning id",
        [ids.gat, week(), emp, at(day, from), at(day, to)],
      )
    )[0].id;
  const row = async (id: string) =>
    (await db.admin<{ response: string; employment_id: string }>("select response, employment_id from public.shifts where id = $1", [id]))[0];

  beforeAll(async () => {
    ana = { ...(await db.admin<{ user_id: string }>("select user_id from public.persons where email = 'ana@example.com'").then((r) => ({ id: r[0].user_id }))), email: "ana@example.com", method: "otp" };
    ben = { ...(await db.admin<{ user_id: string }>("select user_id from public.persons where email = 'ben@example.com'").then((r) => ({ id: r[0].user_id }))), email: "ben@example.com", method: "otp" };
    for (const who of ["ana", "ben"]) {
      const [x] = await db.admin<{ id: string }>(
        "select e.id from public.employments e join public.persons p on p.id = e.person_id where p.email = $1",
        [`${who}@example.com`],
      );
      e[who] = x.id;
    }
    await db.as(julie, "insert into public.schedule_weeks (location_id, week_start, status, published_at) values ($1, $2, 'published', now())", [ids.gat, week()]);
  });

  it("a reassigned or moved shift must be acknowledged again", async () => {
    const id = await shift(e.ana, 0, 13, 17);
    await db.rpc(ana, "respond_to_shift", [id, "confirmed"]);
    expect((await row(id)).response).toBe("confirmed");
    await db.as(julie, "update public.shifts set employment_id = $2 where id = $1", [id, e.ben]);
    expect(await row(id)).toMatchObject({ response: "pending", employment_id: e.ben });

    await db.rpc(ben, "respond_to_shift", [id, "confirmed"]);
    await db.as(julie, "update public.shifts set ends_at = ends_at + interval '1 hour' where id = $1", [id]);
    expect((await row(id)).response).toBe("pending");

    // A note or break change doesn't need a new acknowledgement
    await db.rpc(ben, "respond_to_shift", [id, "confirmed"]);
    await db.as(julie, "update public.shifts set unpaid_break_minutes = 30 where id = $1", [id]);
    expect((await row(id)).response).toBe("confirmed");
  });

  it("changing a shift sends an agreed exchange back to the colleague, so nobody is approved for other hours", async () => {
    const id = await shift(e.ana, 1, 13, 17);
    const r = await db.rpc<{ id: string }>(ana, "request_shift_swap", [id, e.ben, null, null]);
    await db.rpc(ben, "respond_to_swap", [r.id, true]);
    await db.as(julie, "update public.shifts set starts_at = $2, ends_at = $3 where id = $1", [id, at(1, 18), at(1, 22)]);
    expect(await db.rpc(julie, "decide_swap", [r.id, true, null])).toMatchObject({ ok: false, reason: "not_pending" });
    expect((await row(id)).employment_id).toBe(e.ana);
    const [swap] = await db.admin<{ status: string }>("select status from public.shift_swaps where id = $1", [r.id]);
    expect(swap.status).toBe("pending_colleague");
  });

  it("an approved exchange leaves both shifts confirmed", async () => {
    const a = await shift(e.ana, 2, 13, 17);
    const b = await shift(e.ben, 3, 13, 17);
    const r = await db.rpc<{ id: string }>(ana, "request_shift_swap", [a, e.ben, b, null]);
    await db.rpc(ben, "respond_to_swap", [r.id, true]);
    expect(await db.rpc(julie, "decide_swap", [r.id, true, null])).toMatchObject({ ok: true });
    expect(await row(a)).toMatchObject({ employment_id: e.ben, response: "confirmed" });
    expect(await row(b)).toMatchObject({ employment_id: e.ana, response: "confirmed" });
    // ...and a later manager change still resets it
    await db.as(julie, "update public.shifts set starts_at = starts_at + interval '30 minutes' where id = $1", [a]);
    expect((await row(a)).response).toBe("pending");
  });

  it("refuses the same shift twice for the same employee, but allows repeated open shifts", async () => {
    await shift(e.ana, 4, 9, 12);
    await expect(shift(e.ana, 4, 9, 12)).rejects.toThrow(/shifts_no_duplicate/);
    const open = "insert into public.shifts (location_id, week_start, employment_id, starts_at, ends_at) values ($1, $2, null, $3, $4)";
    await db.as(julie, open, [ids.gat, week(), at(4, 9), at(4, 12)]);
    await db.as(julie, open, [ids.gat, week(), at(4, 9), at(4, 12)]);
  });
});

describe("timesheets, requests, open shifts, cross-company view, notifications", () => {
  let zoe: TestUser; // employee, Gatineau
  let yan: TestUser; // employee at Gatineau (QC company) and Ottawa (ON company)
  const e: Record<string, string> = {};
  const p: Record<string, string> = {};
  const week = () => {
    const d = new Date(`${thisMonday()}T12:00:00Z`);
    d.setUTCDate(d.getUTCDate() + 21);
    return d.toISOString().slice(0, 10);
  };
  const at = (day: number, hour: number) => {
    const d = new Date(`${week()}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() + day);
    d.setUTCHours(hour);
    return d.toISOString();
  };
  const hoursAgo = (h: number) => new Date(Date.now() - h * 3_600_000).toISOString();

  beforeAll(async () => {
    // Fake pg_net so notifications can be checked
    await db.admin(`
      create schema if not exists net;
      create table if not exists net.calls (id bigserial primary key, url text, body jsonb);
      create or replace function net.http_post(url text, body jsonb default '{}', params jsonb default '{}',
        headers jsonb default '{}', timeout_milliseconds integer default 5000) returns bigint
      language sql as $f$ insert into net.calls (url, body) values (url, body) returning id $f$;
    `);
    const people = await db.as<{ id: string; email: string }>(
      tony,
      "insert into public.persons (first_name, last_name, email) values ('Zoe', 'Roy', 'zoe@example.com'), ('Yan', 'Roy', 'yan@example.com') returning id, email",
    );
    for (const x of people) p[x.email.split("@")[0]] = x.id;
    for (const [key, person, company, loc] of [
      ["zoe", p.zoe, ids.coQc, ids.gat],
      ["yanQc", p.yan, ids.coQc, ids.gat],
      ["yanOn", p.yan, ids.coOn, ids.ott],
    ]) {
      const [row] = await db.as<{ id: string }>(tony, "insert into public.employments (person_id, company_id) values ($1, $2) returning id", [person, company]);
      await db.as(tony, "insert into public.employment_locations (employment_id, location_id) values ($1, $2)", [row.id, loc]);
      e[key] = row.id;
    }
    zoe = await db.createUser("zoe@example.com");
    yan = await db.createUser("yan@example.com");
    await db.as(julie, "insert into public.schedule_weeks (location_id, week_start, status, published_at) values ($1, $2, 'published', now())", [ids.gat, week()]);
    await db.as(tony, "insert into public.schedule_weeks (location_id, week_start, status, published_at) values ($1, $2, 'published', now())", [ids.ott, week()]);
  });

  it("missed punches: employee asks, manager approves, originals are kept", async () => {
    const req = await db.rpc<{ ok: boolean; id: string }>(zoe, "request_punch_correction", [ids.gat, "in", hoursAgo(5), "Oublié en arrivant"]);
    expect(req.ok).toBe(true);
    expect(await db.rpc(zoe, "request_punch_correction", [ids.ott, "in", hoursAgo(5), "x".repeat(5)])).toMatchObject({ reason: "not_assigned" });
    expect(await db.rpc(zoe, "request_punch_correction", [ids.gat, "in", new Date(Date.now() + 3_600_000).toISOString(), "Plus tard"])).toMatchObject({ reason: "future" });
    expect(await db.as(marie, "select * from public.punch_corrections")).toHaveLength(0);
    expect(await db.rpc(zoe, "decide_punch_correction", [req.id, true, null])).toMatchObject({ ok: false, reason: "not_allowed" });
    expect(await db.rpc(julie, "decide_punch_correction", [req.id, true, "OK"])).toMatchObject({ ok: true });
    const [punch] = await db.admin<{ id: string; method: string; flags: string[] }>("select id, method, flags from public.punches where person_id = $1", [p.zoe]);
    expect(punch).toMatchObject({ method: "manual", flags: ["correction"] });

    // Correcting an existing punch keeps the original in the history
    const fix = await db.rpc<{ id: string }>(zoe, "request_punch_correction", [ids.gat, "in", hoursAgo(6), "Arrivée réelle 1 h plus tôt", punch.id]);
    await db.rpc(julie, "decide_punch_correction", [fix.id, true, null]);
    const history = await db.as<{ action: string }>(julie, "select action from public.punch_history where punch_id = $1", [punch.id]);
    expect(history).toEqual([{ action: "update" }]);
    expect(await db.as(zoe, "select id from public.punch_history where punch_id = $1", [punch.id])).toHaveLength(1);

    // A manager adds a forgotten "out"
    expect(await db.rpc(julie, "manager_add_punch", [p.zoe, ids.gat, "out", hoursAgo(1), "Parti sans pointer"])).toMatchObject({ ok: true });
    expect(await db.rpc(julie, "manager_add_punch", [p.zoe, ids.ott, "out", hoursAgo(1), "Pas sa clinique"])).toMatchObject({ ok: false });
    // Notification recorded for the employee
    const notes = await db.admin<{ title: string }>("select title from app.notifications where person_id = $1 order by created_at", [p.zoe]);
    expect(notes.map((n) => n.title)).toContain("Correction de pointage approuvée");
  });

  it("timesheet approvals: payroll people only", async () => {
    const row = [ids.coQc, p.zoe, "2026-11-01", "2026-11-15", 600, 0];
    await expect(
      db.as(zoe, "insert into public.timesheet_approvals (company_id, person_id, period_start, period_end, regular_minutes, overtime_minutes) values ($1, $2, $3, $4, $5, $6)", row),
    ).rejects.toThrow(/row-level security/);
    await db.as(julie, "insert into public.timesheet_approvals (company_id, person_id, period_start, period_end, regular_minutes, overtime_minutes) values ($1, $2, $3, $4, $5, $6)", row);
    expect(await db.as(zoe, "select regular_minutes from public.timesheet_approvals")).toEqual([{ regular_minutes: 600 }]);
  });

  it("time off: request, decision with paid hours, cancel", async () => {
    const r = await db.rpc<{ ok: boolean; id: string }>(zoe, "request_time_off", ["vacation", "2027-01-04", "2027-01-08", null, null, "Ski"]);
    expect(r.ok).toBe(true);
    expect(await db.rpc(zoe, "request_time_off", ["sick", "2027-01-05", "2027-01-04", null, null, null])).toMatchObject({ reason: "invalid_dates" });
    expect(await db.rpc(yan, "decide_time_off", [r.id, true, 40, null])).toMatchObject({ ok: false });
    expect(await db.rpc(julie, "decide_time_off", [r.id, true, 40, "Bonnes vacances"])).toMatchObject({ ok: true });
    const [row] = await db.as<{ status: string; paid_hours: string }>(zoe, "select status, paid_hours from public.time_off_requests where id = $1", [r.id]);
    expect(row).toMatchObject({ status: "approved", paid_hours: "40.00" });
    expect(await db.rpc(zoe, "cancel_time_off", [r.id])).toMatchObject({ ok: true }); // future: can still cancel
    expect(await db.as(marie, "select * from public.time_off_requests")).toHaveLength(0);
  });

  it("availability: new weekly availability replaces the old one when approved", async () => {
    await db.as(zoe, "insert into public.availability_rules (person_id, weekday, start_time, end_time) values ($1, 0, '08:00', '16:00')", [p.zoe]);
    await db.rpc(julie, "decide_availability", [p.zoe, true]);
    await db.as(zoe, "insert into public.availability_rules (person_id, weekday, start_time, end_time) values ($1, 1, '09:00', '17:00')", [p.zoe]);
    expect(await db.rpc(julie, "decide_availability", [p.zoe, true])).toMatchObject({ ok: true });
    const rules = await db.as<{ weekday: number; status: string }>(zoe, "select weekday, status from public.availability_rules where person_id = $1", [p.zoe]);
    expect(rules).toEqual([{ weekday: 1, status: "approved" }]);
  });

  it("open shifts: staff volunteer, a scheduler assigns, others are told no", async () => {
    const [open] = await db.as<{ id: string }>(
      julie,
      "insert into public.shifts (location_id, week_start, employment_id, starts_at, ends_at) values ($1, $2, null, $3, $4) returning id",
      [ids.gat, week(), at(2, 13), at(2, 17)],
    );
    expect(await db.as(zoe, "select id from public.shifts where id = $1", [open.id])).toHaveLength(1); // visible to staff
    expect(await db.rpc(zoe, "claim_open_shift", [open.id])).toMatchObject({ ok: true });
    expect(await db.rpc(yan, "claim_open_shift", [open.id])).toMatchObject({ ok: true });
    expect(await db.rpc(luc, "claim_open_shift", [open.id])).toMatchObject({ ok: false, reason: "not_assigned" });
    const asked = await db.rpc<{ ok: boolean; notified: number }>(julie, "request_coverage", [open.id]);
    expect(asked.ok).toBe(true);
    expect(asked.notified).toBeGreaterThanOrEqual(2);
    expect(await db.as(julie, "select * from public.shift_claims where shift_id = $1", [open.id])).toHaveLength(2);
    expect(await db.rpc(julie, "assign_open_shift", [open.id, e.zoe])).toMatchObject({ ok: true });
    const [s] = await db.admin<{ employment_id: string; response: string }>("select employment_id, response from public.shifts where id = $1", [open.id]);
    expect(s).toMatchObject({ employment_id: e.zoe, response: "confirmed" });
    const claims = await db.as<{ status: string }>(yan, "select status from public.shift_claims where shift_id = $1", [open.id]);
    expect(claims).toEqual([{ status: "refused" }]);
    expect(await db.rpc(julie, "assign_open_shift", [open.id, e.yanQc])).toMatchObject({ ok: false, reason: "not_open" });
  });

  it("one schedule across companies: a QC manager sees the person's Ontario shifts", async () => {
    await db.as(tony, "insert into public.shifts (location_id, week_start, employment_id, starts_at, ends_at) values ($1, $2, $3, $4, $5)", [
      ids.ott, week(), e.yanOn, at(3, 13), at(3, 17),
    ]);
    // Julie can't read Ottawa shifts directly...
    expect(await db.as(julie, "select id from public.shifts where location_id = $1", [ids.ott])).toHaveLength(0);
    // ...but sees when the people she schedules are busy elsewhere
    const busy = await db.rpc<{ shifts: { location_id: string }[]; employments: { company_id: string }[] }>(julie, "busy_shifts", [
      [p.yan, ids.luc], at(0, 0), at(7, 0),
    ]);
    expect(busy.shifts.map((x) => x.location_id)).toContain(ids.ott);
    expect(busy.employments.map((x) => x.company_id).sort()).toEqual([ids.coOn, ids.coQc].sort());
    // Luc doesn't work at her clinic: nothing about him
    expect(busy.employments.every((x) => x.company_id !== ids.coOn || busy.shifts.length > 0)).toBe(true);
    const lucOnly = await db.rpc<{ shifts: unknown[]; employments: unknown[] }>(julie, "busy_shifts", [[ids.luc], at(0, 0), at(7, 0)]);
    expect(lucOnly).toEqual({ shifts: [], employments: [] });
  });

  it("schedule changes are pushed to the people concerned, in their language", async () => {
    expect(await db.rpc(yan, "register_push_token", ["ExponentPushToken[abcdefghijklmn]", "ios"])).toMatchObject({ ok: true });
    expect(await db.rpc(yan, "register_push_token", ["not-a-token", "ios"])).toMatchObject({ ok: false });
    await db.rpc(yan, "set_my_locale", ["en-CA"]);
    await db.admin("delete from net.calls");
    const [shift] = await db.as<{ id: string }>(
      julie,
      "insert into public.shifts (location_id, week_start, employment_id, starts_at, ends_at) values ($1, $2, $3, $4, $5) returning id",
      [ids.gat, week(), e.yanQc, at(4, 13), at(4, 17)],
    );
    await db.as(julie, "update public.shifts set ends_at = $2 where id = $1", [shift.id, at(4, 18)]);
    await db.as(julie, "delete from public.shifts where id = $1", [shift.id]);
    const calls = await db.admin<{ body: { to: string; title: string; body: string }[] }>("select body from net.calls order by id");
    expect(calls.map((c) => c.body[0].title)).toEqual(["New shift", "Shift changed", "Shift cancelled"]);
    expect(calls[0].body[0].to).toBe("ExponentPushToken[abcdefghijklmn]");
    expect(calls[1].body[0].body).toMatch(/Gatineau.*\(was /);
    // Draft weeks don't notify
    const draft = new Date(`${week()}T12:00:00Z`);
    draft.setUTCDate(draft.getUTCDate() + 7);
    await db.as(julie, "insert into public.schedule_weeks (location_id, week_start) values ($1, $2)", [ids.gat, draft.toISOString().slice(0, 10)]);
    await db.admin("delete from net.calls");
    const d = new Date(draft);
    d.setUTCHours(13);
    const d2 = new Date(draft);
    d2.setUTCHours(17);
    await db.as(julie, "insert into public.shifts (location_id, week_start, employment_id, starts_at, ends_at) values ($1, $2, $3, $4, $5)", [
      ids.gat, draft.toISOString().slice(0, 10), e.yanQc, d.toISOString(), d2.toISOString(),
    ]);
    expect(await db.admin("select * from net.calls")).toHaveLength(0);
    // Publishing that week notifies once
    await db.as(julie, "update public.schedule_weeks set status = 'published', published_at = now() where location_id = $1 and week_start = $2", [
      ids.gat, draft.toISOString().slice(0, 10),
    ]);
    const published = await db.admin<{ body: { title: string }[] }>("select body from net.calls");
    expect(published.map((c) => c.body[0].title)).toEqual(["Schedule published"]);
    expect(await db.rpc(yan, "unregister_push_token", ["ExponentPushToken[abcdefghijklmn]"])).toMatchObject({ ok: true, removed: 1 });
  });

  it("coverage rules and credentials follow permissions", async () => {
    const [pos] = await db.as<{ id: string }>(julie, "insert into public.job_roles (name_fr, name_en) values ('Réceptionniste', 'Receptionist') returning id");
    await db.as(julie, "insert into public.coverage_rules (location_id, job_role_id, start_time, end_time, min_count) values ($1, $2, '08:00', '17:00', 1)", [ids.gat, pos.id]);
    await expect(
      db.as(julie, "insert into public.coverage_rules (location_id, job_role_id, start_time, end_time) values ($1, $2, '08:00', '17:00')", [ids.ott, pos.id]),
    ).rejects.toThrow(/row-level security/);
    await db.as(julie, "insert into public.credentials (person_id, name, expires_on) values ($1, 'Permis OPPQ', '2027-03-31')", [p.zoe]);
    await expect(db.as(zoe, "insert into public.credentials (person_id, name) values ($1, 'Faux')", [p.zoe])).rejects.toThrow(/row-level security/);
    expect(await db.as(zoe, "select name from public.credentials")).toEqual([{ name: "Permis OPPQ" }]);
    expect(await db.as(luc, "select name from public.credentials")).toHaveLength(0);
  });

  it("positions: one per name; exchanges, volunteering and 'ask the team' respect them", async () => {
    await expect(db.as(julie, "insert into public.job_roles (name_fr, name_en) values (' réceptionniste ', 'Front desk')")).rejects.toThrow(/job_roles_account_name_key/);
    const [pod] = await db.as<{ id: string }>(julie, "insert into public.job_roles (name_fr, name_en) values ('Podiatre', 'Podiatrist') returning id");
    const [rec] = await db.as<{ id: string }>(julie, "select id from public.job_roles where name_fr = 'Réceptionniste'");
    await db.as(tony, "update public.employments set job_role_id = $1 where id = $2", [rec.id, e.zoe]);
    await db.as(tony, "update public.employments set job_role_id = $1 where id in ($2, $3)", [pod.id, e.yanQc, e.yanOn]);

    // Open podiatrist shift: the receptionist can't volunteer and isn't asked
    const [open] = await db.as<{ id: string }>(
      julie,
      "insert into public.shifts (location_id, week_start, employment_id, job_role_id, starts_at, ends_at) values ($1, $2, null, $3, $4, $5) returning id",
      [ids.gat, week(), pod.id, at(5, 13), at(5, 17)],
    );
    expect(await db.rpc(zoe, "claim_open_shift", [open.id])).toMatchObject({ ok: false, reason: "wrong_position" });
    expect(await db.rpc(yan, "claim_open_shift", [open.id])).toMatchObject({ ok: true });
    await db.rpc(julie, "request_coverage", [open.id]);
    const asked = await db.admin<{ person_id: string }>("select person_id from app.notifications where data ->> 'shift_id' = $1", [open.id]);
    expect(asked.map((x) => x.person_id)).toContain(p.yan);
    expect(asked.map((x) => x.person_id)).not.toContain(p.zoe);

    // The receptionist's shift can't be given to the podiatrist
    const [mine] = await db.as<{ id: string }>(
      julie,
      "insert into public.shifts (location_id, week_start, employment_id, starts_at, ends_at) values ($1, $2, $3, $4, $5) returning id",
      [ids.gat, week(), e.zoe, at(4, 13), at(4, 17)],
    );
    const cands = await db.rpc<{ ok: boolean; colleagues: { person_id: string }[] }>(zoe, "swap_candidates", [mine.id]);
    expect(cands.ok).toBe(true);
    expect(cands.colleagues.map((c) => c.person_id)).not.toContain(p.yan);
    expect(await db.rpc(zoe, "request_shift_swap", [mine.id, e.yanQc, null, null])).toMatchObject({ ok: false, reason: "wrong_position" });
  });
});

describe("phase 1: changed shifts, copy week, cross-company privacy", () => {
  let gina: TestUser; // employee, Gatineau
  let hugo: TestUser; // employee, Gatineau
  let olivia: TestUser; // clinic manager, Ottawa only
  const e: Record<string, string> = {};
  const p: Record<string, string> = {};
  const weekN = (n: number) => {
    const d = new Date(`${thisMonday()}T12:00:00Z`);
    d.setUTCDate(d.getUTCDate() + 7 * n);
    return d.toISOString().slice(0, 10);
  };
  const W1 = () => weekN(6);
  const at = (day: number, hour: number, week = W1()) => {
    const d = new Date(`${week}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() + day);
    d.setUTCHours(hour);
    return d.toISOString();
  };
  const add = async (emp: string | null, day: number, from: number, to: number, week = W1(), loc = ids.gat) =>
    (
      await db.as<{ id: string }>(
        loc === ids.gat ? julie : tony,
        "insert into public.shifts (location_id, week_start, employment_id, starts_at, ends_at) values ($1, $2, $3, $4, $5) returning id",
        [loc, week, emp, at(day, from, week), at(day, to, week)],
      )
    )[0].id;
  const swap = async (id: string) => (await db.admin<{ status: string; colleague_responded_at: string | null }>("select status, colleague_responded_at from public.shift_swaps where id = $1", [id]))[0];
  const row = async (id: string) => (await db.admin<{ employment_id: string; response: string }>("select employment_id, response from public.shifts where id = $1", [id]))[0];
  const notes = (swapId: string) => db.admin<{ person_id: string; title: string; body: string }>("select person_id, title, body from app.notifications where data ->> 'swap_id' = $1 order by created_at", [swapId]);

  beforeAll(async () => {
    const people = await db.as<{ id: string; email: string }>(
      tony,
      `insert into public.persons (first_name, last_name, email) values
         ('Gina', 'Roy', 'gina@example.com'), ('Hugo', 'Roy', 'hugo@example.com'),
         ('Olivia', 'Chen', 'olivia@example.com'), ('Paul', 'Roy', 'paul.r@example.com')
       returning id, email`,
    );
    for (const x of people) p[x.email.split("@")[0].replace(".r", "")] = x.id;
    const hire = async (who: string, company: string, loc: string, extra = "") =>
      (
        await db.as<{ id: string }>(
          tony,
          `insert into public.employments (person_id, company_id${extra ? ", hourly_rate_cents" : ""}) values ($1, $2${extra ? ", 3150" : ""}) returning id`,
          [p[who], company],
        )
      )[0].id;
    e.gina = await hire("gina", ids.coQc, ids.gat);
    e.hugo = await hire("hugo", ids.coQc, ids.gat);
    e.paulQc = await hire("paul", ids.coQc, ids.gat, "rate");
    e.paulOn = await hire("paul", ids.coOn, ids.ott);
    for (const [emp, loc] of [[e.gina, ids.gat], [e.hugo, ids.gat], [e.paulQc, ids.gat], [e.paulOn, ids.ott]]) {
      await db.as(tony, "insert into public.employment_locations (employment_id, location_id) values ($1, $2)", [emp, loc]);
    }
    await db.as(tony, "insert into public.role_assignments (person_id, role, location_id) values ($1, 'clinic_manager', $2)", [p.olivia, ids.ott]);
    gina = await db.createUser("gina@example.com");
    hugo = await db.createUser("hugo@example.com");
    olivia = await db.createUser("olivia@example.com");
    await db.as(julie, "insert into public.schedule_weeks (location_id, week_start, status, published_at) values ($1, $2, 'published', now())", [ids.gat, W1()]);
  });

  it("exchange agreed, then the offered shift's hours change: back to the colleague, who is told", async () => {
    const a = await add(e.gina, 0, 13, 17);
    const r = await db.rpc<{ ok: boolean; id: string }>(gina, "request_shift_swap", [a, e.hugo, null, null]);
    expect(await db.rpc(hugo, "respond_to_swap", [r.id, true])).toMatchObject({ ok: true });
    expect((await swap(r.id)).status).toBe("pending_manager");

    await db.as(julie, "update public.shifts set ends_at = $2 where id = $1", [a, at(0, 19)]);
    expect(await swap(r.id)).toMatchObject({ status: "pending_colleague", colleague_responded_at: null });
    expect(await db.rpc(julie, "decide_swap", [r.id, true, null])).toMatchObject({ ok: false, reason: "not_pending" });
    const [newWhen] = await db.admin<{ w: string }>("select app.fmt_when(starts_at, ends_at, 'America/Toronto', 'fr-CA') as w from public.shifts where id = $1", [a]);
    const told = (await notes(r.id)).filter((n) => n.title === "Échange à reconfirmer");
    expect(told).toHaveLength(1);
    expect(told[0].person_id).toBe(p.hugo);
    expect(told[0].body).toContain(newWhen.w); // the new hours, not the old ones

    expect(await db.rpc(hugo, "respond_to_swap", [r.id, true])).toMatchObject({ ok: true });
    expect(await db.rpc(julie, "decide_swap", [r.id, true, null])).toMatchObject({ ok: true });
    expect(await row(a)).toMatchObject({ employment_id: e.hugo, response: "confirmed" });
  });

  it("the shift asked in return changes, or the offered shift goes to someone else: cancelled, both told", async () => {
    const a = await add(e.gina, 1, 13, 17);
    const b = await add(e.hugo, 2, 13, 17);
    const r = await db.rpc<{ id: string }>(gina, "request_shift_swap", [a, e.hugo, b, null]);
    await db.rpc(hugo, "respond_to_swap", [r.id, true]);
    await db.as(julie, "update public.shifts set starts_at = $2 where id = $1", [b, at(2, 14)]);
    expect((await swap(r.id)).status).toBe("cancelled");
    expect((await notes(r.id)).filter((n) => n.title === "Échange annulé").map((n) => n.person_id).sort()).toEqual([p.gina, p.hugo].sort());

    const c = await add(e.gina, 3, 13, 17);
    const r2 = await db.rpc<{ id: string }>(gina, "request_shift_swap", [c, e.hugo, null, null]);
    await db.as(julie, "update public.shifts set employment_id = $2 where id = $1", [c, e.paulQc]);
    expect((await swap(r2.id)).status).toBe("cancelled");
    // The requester cancelling her own request: only the colleague is told
    const d = await add(e.gina, 4, 13, 17);
    const r3 = await db.rpc<{ id: string }>(gina, "request_shift_swap", [d, e.hugo, null, null]);
    await db.rpc(gina, "cancel_swap", [r3.id]);
    expect((await notes(r3.id)).filter((n) => n.title === "Échange annulé").map((n) => n.person_id)).toEqual([p.hugo]);
  });

  it("copy week: twice, or two managers at once, gives the same result as once; identical open shifts are kept", async () => {
    const from = weekN(9);
    const to = weekN(10);
    await db.as(julie, "insert into public.schedule_weeks (location_id, week_start) values ($1, $2)", [ids.gat, from]);
    await add(e.gina, 0, 13, 21, from);
    await add(null, 1, 13, 17, from);
    await add(null, 1, 13, 17, from); // two identical open shifts on purpose
    await add(e.hugo, 4, 23, 30, from); // overnight
    const count = async () => Number((await db.admin<{ n: string }>("select count(*) as n from public.shifts where location_id = $1 and week_start = $2", [ids.gat, to]))[0].n);

    expect(await db.rpc(gina, "copy_week", [ids.gat, from, to])).toMatchObject({ ok: false, reason: "not_allowed" });
    expect(await db.rpc(olivia, "copy_week", [ids.gat, from, to])).toMatchObject({ ok: false, reason: "not_allowed" });

    expect(await db.rpc(julie, "copy_week", [ids.gat, from, to])).toMatchObject({ ok: true, copied: 4, source: 4 });
    expect(await db.rpc(julie, "copy_week", [ids.gat, from, to])).toMatchObject({ ok: true, copied: 0 });
    expect(await count()).toBe(4);

    await db.admin("delete from public.shifts where location_id = $1 and week_start = $2", [ids.gat, to]);
    const both = await Promise.all([db.rpcConcurrent<{ copied: number }>(julie, "copy_week", [ids.gat, from, to]), db.rpcConcurrent<{ copied: number }>(tony, "copy_week", [ids.gat, from, to])]);
    expect(both.map((x) => x.copied).sort()).toEqual([0, 4]);
    expect(await count()).toBe(4);
    const open = await db.admin<{ n: string }>("select count(*) as n from public.shifts where location_id = $1 and week_start = $2 and employment_id is null", [ids.gat, to]);
    expect(Number(open[0].n)).toBe(2);
  });

  it("copy week keeps local clock times across a daylight-saving change, overnight shifts included", async () => {
    // Daylight saving starts Sunday 2027-03-14 in Gatineau
    await db.as(julie, "insert into public.schedule_weeks (location_id, week_start) values ($1, '2027-03-08')", [ids.gat]);
    const ins = "insert into public.shifts (location_id, week_start, employment_id, starts_at, ends_at) values ($1, '2027-03-08', $2, $3, $4)";
    await db.as(julie, ins, [ids.gat, e.gina, "2027-03-08 09:00-05", "2027-03-08 17:00-05"]);
    await db.as(julie, ins, [ids.gat, e.hugo, "2027-03-12 22:00-05", "2027-03-13 06:00-05"]);
    expect(await db.rpc(julie, "copy_week", [ids.gat, "2027-03-08", "2027-03-15"])).toMatchObject({ ok: true, copied: 2 });
    const rows = await db.admin<{ s: string; e: string }>(
      "select to_char(starts_at at time zone 'America/Toronto', 'YYYY-MM-DD HH24:MI') as s, to_char(ends_at at time zone 'America/Toronto', 'YYYY-MM-DD HH24:MI') as e from public.shifts where week_start = '2027-03-15' order by starts_at",
    );
    expect(rows).toEqual([
      { s: "2027-03-15 09:00", e: "2027-03-15 17:00" },
      { s: "2027-03-19 22:00", e: "2027-03-20 06:00" },
    ]);
  });

  it("an Ottawa manager sees that someone is busy in Gatineau, but nothing private about that job", async () => {
    await db.as(julie, "update public.employments set job_role_id = (select id from public.job_roles where name_fr = 'Réceptionniste') where id = $1", [e.paulQc]);
    const g = await add(e.paulQc, 0, 13, 21);
    await db.as(julie, "update public.shifts set notes = 'Formation confidentielle' where id = $1", [g]);
    // No direct access to the Gatineau shift or employment (pay, position)
    expect(await db.as(olivia, "select id from public.shifts where id = $1", [g])).toHaveLength(0);
    expect(await db.as(olivia, "select hourly_rate_cents from public.employments where id = $1", [e.paulQc])).toHaveLength(0);
    // ...but the conflict is visible
    const busy = await db.rpc<{ shifts: Record<string, unknown>[]; employments: Record<string, unknown>[] }>(olivia, "busy_shifts", [[p.paul], at(0, 0), at(7, 0)]);
    const there = busy.shifts.find((x) => x.id === g)!;
    expect(there).toMatchObject({ location_id: ids.gat, starts_at: expect.any(String), ends_at: expect.any(String) });
    expect(Object.keys(there)).not.toContain("notes");
    expect(Object.keys(there)).not.toContain("job_role_id");
    for (const emp of busy.employments) {
      expect(Object.keys(emp).sort()).toEqual(["company_id", "id", "location_ids", "person_id"]);
    }
    // She schedules Paul in Ottawa at the same time: the schedule checks flag the overlap as an error
    const { validateSchedule } = await import("../../packages/rules/src/index");
    const mine = { id: "new", employmentId: e.paulOn, locationId: ids.ott, startsAt: new Date(at(0, 15)), endsAt: new Date(at(0, 19)), unpaidBreakMinutes: 0 };
    const result = validateSchedule({
      locations: [
        { id: ids.gat, companyId: ids.coQc, province: "QC", timezone: "America/Toronto" },
        { id: ids.ott, companyId: ids.coOn, province: "ON", timezone: "America/Toronto" },
      ],
      employments: busy.employments.map((x) => ({ id: x.id as string, personId: x.person_id as string, companyId: x.company_id as string, locationIds: x.location_ids as string[] })),
      shifts: [
        mine,
        ...busy.shifts.map((x) => ({ id: x.id as string, employmentId: x.employment_id as string, locationId: x.location_id as string, startsAt: new Date(x.starts_at as string), endsAt: new Date(x.ends_at as string), unpaidBreakMinutes: x.unpaid_break_minutes as number })),
      ],
      weeks: [W1()],
      now: new Date(),
    });
    const overlap = result.issues.find((i) => i.code === "shift_overlap");
    expect(overlap?.severity).toBe("error");
    expect(overlap?.shiftIds.sort()).toEqual(["new", g].sort());
  });
});

describe("phase 2: availability, leave, coverage, templates, acknowledgements", () => {
  let mia: TestUser; // clinic manager, Aylmer
  let sam: TestUser; // schedule-only role at Aylmer
  let ava: TestUser; // assistant, Aylmer
  let bea: TestUser; // assistant, Aylmer
  let cal: TestUser; // assistant, Aylmer
  const e: Record<string, string> = {};
  const p: Record<string, string> = {};
  const r: Record<string, string> = {};
  const weekN = (n: number) => {
    const d = new Date(`${thisMonday()}T12:00:00Z`);
    d.setUTCDate(d.getUTCDate() + 7 * n);
    return d.toISOString().slice(0, 10);
  };
  const W = () => weekN(12);
  // Local Gatineau/Aylmer time (EST in these test weeks is not guaranteed, so use the database to convert)
  const local = async (date: string, time: string) =>
    (await db.admin<{ t: string }>("select (($1::date + $2::time) at time zone 'America/Toronto')::text as t", [date, time]))[0].t;
  const dayOf = (week: string, d: number) => {
    const x = new Date(`${week}T12:00:00Z`);
    x.setUTCDate(x.getUTCDate() + d);
    return x.toISOString().slice(0, 10);
  };
  const shiftAt = async (emp: string | null, week: string, d: number, from: string, to: string, role: string | null = null) =>
    (
      await db.as<{ id: string }>(
        mia,
        "insert into public.shifts (location_id, week_start, employment_id, starts_at, ends_at, job_role_id) values ($1, $2, $3, $4, $5, $6) returning id",
        [ids.ayl, week, emp, await local(dayOf(week, d), from), await local(dayOf(week, to <= from ? d + 1 : d), to), role],
      )
    )[0].id;
  const notesFor = (person: string, title: string) =>
    db.admin<{ body: string }>("select body from app.notifications where person_id = $1 and title = $2 order by created_at", [person, title]);

  beforeAll(async () => {
    const [ayl] = await db.as<{ id: string }>(tony, "insert into public.locations (company_id, name, province) values ($1, 'Aylmer', 'QC') returning id", [ids.coQc]);
    ids.ayl = ayl.id;
    const [asst] = await db.as<{ id: string }>(tony, "insert into public.job_roles (name_fr, name_en) values ('Assistante', 'Assistant') returning id");
    r.asst = asst.id;
    r.rec = (await db.as<{ id: string }>(tony, "select id from public.job_roles where name_fr = 'Réceptionniste'"))[0].id;
    const people = await db.as<{ id: string; email: string }>(
      tony,
      `insert into public.persons (first_name, last_name, email) values
         ('Mia', 'Roy', 'mia@example.com'), ('Sam', 'Roy', 'sam@example.com'), ('Ava', 'Roy', 'ava@example.com'),
         ('Bea', 'Roy', 'bea@example.com'), ('Cal', 'Roy', 'cal@example.com'), ('Dan', 'Roy', 'dan@example.com')
       returning id, email`,
    );
    for (const x of people) p[x.email.split("@")[0]] = x.id;
    await db.as(tony, "insert into public.role_assignments (person_id, role, location_id) values ($1, 'clinic_manager', $2)", [p.mia, ids.ayl]);
    const [role] = await db.as<{ id: string }>(tony, "insert into public.custom_roles (company_id, name, permissions) values ($1, 'Horaires Aylmer', '{schedule}') returning id", [ids.coQc]);
    await db.as(tony, "insert into public.custom_role_assignments (person_id, custom_role_id, location_id) values ($1, $2, $3)", [p.sam, role.id, ids.ayl]);
    for (const [who, jr] of [["ava", r.asst], ["bea", r.asst], ["cal", r.asst], ["dan", r.rec]] as const) {
      const [emp] = await db.as<{ id: string }>(tony, "insert into public.employments (person_id, company_id, job_role_id) values ($1, $2, $3) returning id", [p[who], ids.coQc, jr]);
      await db.as(tony, "insert into public.employment_locations (employment_id, location_id) values ($1, $2)", [emp.id, ids.ayl]);
      e[who] = emp.id;
    }
    mia = await db.createUser("mia@example.com");
    sam = await db.createUser("sam@example.com");
    ava = await db.createUser("ava@example.com");
    bea = await db.createUser("bea@example.com");
    cal = await db.createUser("cal@example.com");
    await db.as(mia, "insert into public.schedule_weeks (location_id, week_start, status, published_at) values ($1, $2, 'published', now())", [ids.ayl, W()]);
  });

  it("acceptance 1: Friday afternoon off → gap, approval frees the shift, two accept at once, one gets it", async () => {
    const friday = await shiftAt(e.ava, W(), 4, "13:00", "17:00", null);
    await shiftAt(e.bea, W(), 4, "08:00", "12:00");
    await shiftAt(e.cal, W(), 3, "13:00", "17:00");
    const types = await db.as<{ id: string; name_fr: string }>(ava, "select id, name_fr from public.leave_types where active order by sort");
    expect(types.map((x) => x.name_fr)).toEqual(["Vacances", "Maladie", "Personnel", "Sans solde", "Autre"]);
    const personal = types.find((x) => x.name_fr === "Personnel")!.id;

    const req = await db.rpc<{ ok: boolean; id: string }>(ava, "request_leave", [personal, dayOf(W(), 4), dayOf(W(), 4), "12:30", "17:00", "Rendez-vous médical"]);
    expect(req.ok).toBe(true);
    expect(await db.rpc(ava, "request_leave", [personal, dayOf(W(), 4), dayOf(W(), 4), "14:00", "15:00", null])).toMatchObject({ ok: false, reason: "overlaps" });

    // The reason: Ava and her manager; not the schedule-only role, not a colleague
    expect(await db.as(ava, "select reason from public.time_off_reasons where request_id = $1", [req.id])).toEqual([{ reason: "Rendez-vous médical" }]);
    expect(await db.as(mia, "select reason from public.time_off_reasons where request_id = $1", [req.id])).toHaveLength(1);
    expect(await db.as(sam, "select reason from public.time_off_reasons where request_id = $1", [req.id])).toHaveLength(0);
    expect(await db.as(bea, "select reason from public.time_off_reasons where request_id = $1", [req.id])).toHaveLength(0);
    expect((await db.as<{ note: string | null }>(sam, "select note from public.time_off_requests where id = $1", [req.id]))[0].note).toBeNull();

    // Before deciding: the shifts concerned
    const impact = await db.rpc<{ ok: boolean; shifts: { id: string; can_schedule: boolean }[] }>(mia, "time_off_impact", [req.id]);
    expect(impact.shifts).toEqual([expect.objectContaining({ id: friday, can_schedule: true })]);

    const decided = await db.rpc<{ ok: boolean; released: string[] }>(mia, "decide_leave", [req.id, true, 4.5, "OK, bon rendez-vous", true]);
    expect(decided).toEqual({ ok: true, released: [friday] });
    expect((await db.admin<{ employment_id: string | null; job_role_id: string }>("select employment_id, job_role_id from public.shifts where id = $1", [friday]))[0])
      .toEqual({ employment_id: null, job_role_id: r.asst });
    expect((await notesFor(p.ava, "Congé approuvé")).length).toBe(1);
    expect((await notesFor(p.ava, "Quart retiré")).length).toBe(1);

    // Offer to everyone eligible: the other assistants; not the receptionist, not Ava (on leave)
    const offer = await db.rpc<{ ok: boolean; offer_id: string; invited: number; skipped: { employment_id: string; reason: string }[] }>(mia, "offer_shift", [friday, null]);
    expect(offer.invited).toBe(2);
    expect(Object.fromEntries(offer.skipped.map((x) => [x.employment_id, x.reason]))).toEqual({ [e.dan]: "wrong_position", [e.ava]: "time_off" });
    expect((await notesFor(p.bea, "Quart offert")).length).toBe(1);
    expect(await db.rpc(sam, "offer_shift", [friday, null])).toMatchObject({ ok: true, invited: 0 }); // already invited
    const mine = await db.rpc<{ offer_id: string; status: string }[]>(bea, "my_offers");
    expect(mine).toEqual([expect.objectContaining({ offer_id: offer.offer_id, status: "invited" })]);

    const before = { bea: (await notesFor(p.bea, "Nouveau quart")).length, cal: (await notesFor(p.cal, "Nouveau quart")).length };
    // Both accept at the same moment
    const [a, b] = await Promise.all([
      db.rpcConcurrent<{ ok: boolean; reason?: string }>(bea, "respond_to_offer", [offer.offer_id, true]),
      db.rpcConcurrent<{ ok: boolean; reason?: string }>(cal, "respond_to_offer", [offer.offer_id, true]),
    ]);
    expect([a.ok, b.ok].sort()).toEqual([false, true]);
    expect([a, b].find((x) => !x.ok)?.reason).toBe("taken");
    const winner = a.ok ? "bea" : "cal";
    const user = (who: string) => (who === "bea" ? bea : cal);
    const loser = a.ok ? "cal" : "bea";
    expect((await db.admin<{ employment_id: string; response: string }>("select employment_id, response from public.shifts where id = $1", [friday]))[0])
      .toEqual({ employment_id: e[winner], response: "confirmed" });
    expect((await db.admin<{ status: string }>("select status from public.coverage_offers where id = $1", [offer.offer_id]))[0].status).toBe("filled");
    expect((await notesFor(p[winner], "Nouveau quart")).length).toBe(before[winner] + 1);
    expect((await notesFor(p[loser], "Nouveau quart")).length).toBe(before[loser]);
    expect((await notesFor(p[loser], "Quart déjà pourvu")).length).toBe(1);
    expect((await notesFor(p.mia, "Remplacement trouvé")).length).toBe(1);
    expect(await db.rpc(user(loser), "respond_to_offer", [offer.offer_id, true])).toMatchObject({ ok: false, reason: "taken" });
  });

  it("an open shift assigned by the manager closes its offer and tells the people invited", async () => {
    const open = await shiftAt(null, W(), 2, "09:00", "12:00", r.asst);
    const offer = await db.rpc<{ offer_id: string; invited: number }>(mia, "offer_shift", [open, [e.bea, e.cal, e.dan]]);
    expect(offer.invited).toBe(2);
    expect(await db.rpc(mia, "assign_open_shift", [open, e.ava])).toMatchObject({ ok: true });
    expect((await db.admin<{ status: string }>("select status from public.coverage_offers where id = $1", [offer.offer_id]))[0].status).toBe("filled");
    expect((await notesFor(p.cal, "Quart déjà pourvu")).length).toBeGreaterThan(0);
    expect(await db.rpc(bea, "respond_to_offer", [offer.offer_id, true])).toMatchObject({ ok: false, reason: "taken" });
  });

  it("a new weekly availability replaces the approved one from its start date, keeping the old one", async () => {
    await db.as(ava, "insert into public.availability_rules (person_id, weekday, start_time, end_time, effective_from) values ($1, 0, '08:00', '16:00', '2027-01-04')", [p.ava]);
    await db.rpc(mia, "decide_availability", [p.ava, true]);
    await db.as(
      ava,
      "insert into public.availability_rules (person_id, weekday, start_time, end_time, effective_from, every_weeks, anchor_week, location_ids, kind) values ($1, 1, '09:00', '17:00', '2027-02-01', 2, '2027-02-01', $2, 'available'), ($1, 2, '00:00', '23:59', '2027-02-01', 1, null, null, 'unavailable')",
      [p.ava, [ids.ayl]],
    );
    await expect(
      db.as(ava, "insert into public.availability_rules (person_id, weekday, start_time, end_time, location_ids) values ($1, 3, '09:00', '17:00', $2)", [p.ava, [ids.ott]]),
    ).rejects.toThrow(/not one of this person/);
    expect(await db.rpc(mia, "decide_availability", [p.ava, true])).toMatchObject({ ok: true });
    const rows = await db.admin<{ weekday: number; effective_from: string; effective_to: string | null; status: string }>(
      "select weekday, effective_from::text, effective_to::text, status from public.availability_rules where person_id = $1 order by weekday",
      [p.ava],
    );
    expect(rows).toEqual([
      { weekday: 0, effective_from: "2027-01-04", effective_to: "2027-01-31", status: "approved" },
      { weekday: 1, effective_from: "2027-02-01", effective_to: null, status: "approved" },
      { weekday: 2, effective_from: "2027-02-01", effective_to: null, status: "approved" },
    ]);
    // One-off unavailability, decided separately
    const [x] = await db.as<{ id: string }>(ava, "insert into public.availability_exceptions (person_id, date, end_date, kind) values ($1, '2027-03-01', '2027-03-03', 'unavailable') returning id", [p.ava]);
    expect(await db.rpc(bea, "decide_availability_exception", [x.id, true])).toMatchObject({ ok: false });
    expect(await db.rpc(sam, "decide_availability_exception", [x.id, true])).toMatchObject({ ok: true });
  });

  it("templates and rotations: save weeks, apply them, repeat safely; someone who left becomes an open shift", async () => {
    const A = weekN(14);
    const B = weekN(15);
    await db.as(mia, "insert into public.schedule_weeks (location_id, week_start) values ($1, $2), ($1, $3)", [ids.ayl, A, B]);
    await shiftAt(e.bea, A, 0, "08:00", "16:00");
    await shiftAt(e.cal, B, 0, "08:00", "16:00");
    await shiftAt(null, A, 1, "22:00", "06:00", r.asst); // overnight open shift
    const saved = await db.rpc<{ ok: boolean; id: string; shifts: number }>(mia, "save_template", [ids.ayl, "Rotation A/B", A, 2]);
    expect(saved).toMatchObject({ ok: true, shifts: 3 });
    expect(await db.rpc(bea, "save_template", [ids.ayl, "X", A, 1])).toMatchObject({ ok: false, reason: "not_allowed" });

    const from = weekN(20);
    const applied = await db.rpc<{ added: number }>(mia, "apply_template", [saved.id, from, 4, A]);
    expect(applied.added).toBe(6); // weeks A, B, A, B
    expect(await db.rpc(mia, "apply_template", [saved.id, from, 4, A])).toMatchObject({ added: 0 });
    const monday = await db.admin<{ who: string | null }>(
      "select e.person_id::text as who from public.shifts s left join public.employments e on e.id = s.employment_id where s.location_id = $1 and s.week_start = any ($2::date[]) and extract(isodow from s.starts_at at time zone 'America/Toronto') = 1 order by s.week_start",
      [ids.ayl, [from, weekN(21), weekN(22), weekN(23)]],
    );
    expect(monday.map((x) => x.who)).toEqual([p.bea, p.cal, p.bea, p.cal]);
    const overnight = await db.admin<{ s: string; e: string }>(
      "select to_char(starts_at at time zone 'America/Toronto', 'HH24:MI') as s, to_char(ends_at at time zone 'America/Toronto', 'YYYY-MM-DD HH24:MI') as e from public.shifts where location_id = $1 and week_start = $2 and employment_id is null",
      [ids.ayl, from],
    );
    expect(overnight).toEqual([{ s: "22:00", e: `${dayOf(from, 2)} 06:00` }]);

    // Cal leaves: next time the rotation is applied, his shift is added as an open assistant shift
    await db.as(tony, "update public.employments set end_date = current_date where id = $1", [e.cal]);
    await db.rpc(mia, "apply_template", [saved.id, weekN(25), 1, A]); // week index 1 → week B
    const later = await db.admin<{ employment_id: string | null; job_role_id: string | null }>(
      "select employment_id, job_role_id from public.shifts where location_id = $1 and week_start = $2",
      [ids.ayl, weekN(25)],
    );
    expect(later).toEqual([{ employment_id: null, job_role_id: r.asst }]);
    await db.as(tony, "update public.employments set end_date = null where id = $1", [e.cal]);
  });

  it("recurring shifts: every week until a date, safe to repeat", async () => {
    const start = dayOf(weekN(30), 2);
    const until = dayOf(weekN(33), 2);
    const args = [ids.ayl, e.dan, null, start, "09:00", "13:00", 0, 1, until];
    expect(await db.rpc(mia, "create_recurring_shifts", args)).toMatchObject({ ok: true, added: 4 });
    expect(await db.rpc(mia, "create_recurring_shifts", args)).toMatchObject({ ok: true, added: 0 });
    // every 2 weeks to week 40: weeks 30 and 32 exist already, 34–40 are added
    expect(await db.rpc(mia, "create_recurring_shifts", [ids.ayl, e.dan, null, start, "09:00", "13:00", 0, 2, dayOf(weekN(40), 2)])).toMatchObject({ added: 4 });
    expect(await db.rpc(mia, "create_recurring_shifts", [ids.ott, e.dan, null, start, "09:00", "13:00", 0, 1, until])).toMatchObject({ ok: false, reason: "not_allowed" });
  });

  it("schedulers see shifts not yet acknowledged and can remind, at most once an hour; acknowledging isn't a change", async () => {
    const soon = weekN(2);
    await db.as(mia, "insert into public.schedule_weeks (location_id, week_start, status, published_at) values ($1, $2, 'published', now())", [ids.ayl, soon]);
    const s = await shiftAt(e.dan, soon, 1, "09:00", "12:00");
    const list = await db.rpc<{ id: string }[]>(mia, "unacknowledged_shifts");
    expect(list.map((x) => x.id)).toContain(s);
    expect((await db.rpc<{ id: string }[]>(julie, "unacknowledged_shifts")).map((x) => x.id)).not.toContain(s);
    expect(await db.rpc(mia, "remind_unacknowledged", [[s]])).toEqual({ ok: true, reminded: 1 });
    expect(await db.rpc(mia, "remind_unacknowledged", [[s]])).toEqual({ ok: true, reminded: 0 });
    expect((await notesFor(p.dan, "Quart à confirmer")).length).toBe(1);
    const before = (await db.admin<{ u: string }>("select updated_at::text as u from public.shifts where id = $1", [s]))[0].u;
    await db.as(tony, "insert into public.persons (first_name, last_name, email) values ('X', 'Y', 'dan-login@example.com')").catch(() => undefined);
    const dan = await db.createUser("dan@example.com");
    expect(await db.rpc(dan, "respond_to_shift", [s, "confirmed"])).toMatchObject({ ok: true });
    expect((await db.admin<{ u: string }>("select updated_at::text as u from public.shifts where id = $1", [s]))[0].u).toBe(before);
    expect((await db.rpc<{ id: string }[]>(mia, "unacknowledged_shifts")).map((x) => x.id)).not.toContain(s);
  });

  it("staffing ratios: schedulers of the clinic only", async () => {
    const ins = "insert into public.staffing_ratio_rules (location_id, trigger_job_role_id, trigger_count, required_job_role_id, required_count) values ($1, $2, 2, $3, 1)";
    await db.as(sam, ins, [ids.ayl, r.asst, r.rec]);
    await expect(db.as(julie, ins, [ids.ayl, r.asst, r.rec])).rejects.toThrow(/row-level security/);
    expect(await db.as(bea, "select id from public.staffing_ratio_rules where location_id = $1", [ids.ayl])).toHaveLength(1);
  });
});
