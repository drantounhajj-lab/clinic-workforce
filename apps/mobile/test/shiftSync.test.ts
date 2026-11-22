// Phone calendar + reminders: a failed or partial refresh must never delete or duplicate anything.
// The phone's modules (calendar, notifications, storage) and the server are replaced by small fakes.
import { beforeEach, describe, expect, it, vi } from "vitest";

const store = new Map<string, string>();
const events = new Map<string, { title: string; startDate: Date; location: string }>();
const reminders = new Map<string, { date: number }>();
const fail = { createAfter: Infinity, notifPermission: true };
let nextEvent = 1;

vi.mock("react-native", () => ({ Platform: { OS: "ios" } }));
vi.mock("@react-native-async-storage/async-storage", () => ({
  default: {
    getItem: async (k: string) => store.get(k) ?? null,
    setItem: async (k: string, v: string) => void store.set(k, v),
    multiSet: async (kv: [string, string][]) => kv.forEach(([k, v]) => store.set(k, v)),
    multiRemove: async (ks: string[]) => ks.forEach((k) => store.delete(k)),
  },
}));
vi.mock("expo-calendar", () => {
  const event = (id: string) => ({
    update: async (d: { title: string; startDate: Date; location: string }) => void events.set(id, d),
    delete: async () => void events.delete(id),
  });
  return {
    CalendarAccessLevel: { OWNER: "owner" },
    EntityTypes: { EVENT: "event" },
    SourceType: { LOCAL: "local" },
    requestCalendarPermissions: async () => ({ granted: true }),
    getDefaultCalendarSync: () => ({ source: { id: "icloud", type: "caldav", name: "iCloud" } }),
    getSourcesSync: () => [],
    createCalendar: async () => ({
      id: "cal1",
      createEvent: async (d: { title: string; startDate: Date; location: string }) => {
        if (events.size >= fail.createAfter) throw new Error("calendar busy");
        const id = `ev${nextEvent++}`;
        events.set(id, d);
        return { id };
      },
    }),
    ExpoCalendar: {
      get: async () => ({
        id: "cal1",
        createEvent: async (d: { title: string; startDate: Date; location: string }) => {
          if (events.size >= fail.createAfter) throw new Error("calendar busy");
          const id = `ev${nextEvent++}`;
          events.set(id, d);
          return { id };
        },
      }),
    },
    ExpoCalendarEvent: {
      get: async (id: string) => {
        if (!events.has(id)) throw new Error("no such event");
        return event(id);
      },
    },
  };
});
vi.mock("expo-notifications", () => ({
  setNotificationHandler: () => undefined,
  getPermissionsAsync: async () => ({ granted: fail.notifPermission }),
  requestPermissionsAsync: async () => ({ granted: fail.notifPermission }),
  setNotificationChannelAsync: async () => undefined,
  scheduleNotificationAsync: async (r: { identifier: string; trigger: { date: number } }) => {
    reminders.set(r.identifier, { date: r.trigger.date });
    return r.identifier;
  },
  cancelScheduledNotificationAsync: async (id: string) => void reminders.delete(id),
  SchedulableTriggerInputTypes: { DATE: "date" },
  AndroidImportance: { HIGH: 4 },
}));

// Fake server: the shifts I see in lists, all shifts by id, and which requests fail.
type Row = { id: string; employment_id: string | null; location_id: string; week_start: string; starts_at: string; ends_at: string; unpaid_break_minutes: number };
const server = { list: [] as Row[], byId: new Map<string, Row>(), failList: false, failConfirm: false };
vi.mock("../src/supabase", () => ({
  supabase: {
    from(table: string) {
      let columns = "";
      let byIds: string[] | null = null;
      const q = {
        select(c: string) {
          columns = c;
          return q;
        },
        in(col: string, v: string[]) {
          if (col === "id") byIds = v;
          return q;
        },
        eq: () => q,
        gt: () => q,
        lt: () => q,
        order: () => q,
        then(resolve: (r: { data: unknown; error: { message: string } | null }) => void) {
          if (table === "schedule_weeks") return resolve({ data: [{ location_id: "gat", week_start: "2030-01-07" }], error: null });
          if (byIds) {
            if (server.failConfirm) return resolve({ data: null, error: { message: "timeout" } });
            return resolve({ data: byIds.map((id) => server.byId.get(id)).filter(Boolean), error: null });
          }
          if (server.failList) return resolve({ data: null, error: { message: "timeout" } });
          void columns;
          return resolve({ data: server.list, error: null });
        },
      };
      return q;
    },
  },
}));

const { syncShifts, savePrefs } = await import("../src/shiftSync");
const t = {
  calendarName: "Clinic Workforce",
  calendarEventTitle: (c: string) => `Shift · ${c}`,
  calendarBreak: (m: number) => `Break ${m}`,
  reminderChannel: "Reminders",
  reminderTitle: (d: string, h: string, c: string) => `${d} ${h} ${c}`,
} as never;
const employments = [{ id: "emp1", company_id: "co", job_role_id: null, employment_locations: [{ location_id: "gat" }] }] as never;
const locations = [{ id: "gat", name: "Gatineau", address: "100 Rue Principale", timezone: "America/Toronto" }] as never;
const shift = (id: string, day: number, hour = 9): Row => ({
  id,
  employment_id: "emp1",
  location_id: "gat",
  week_start: "2030-01-07",
  starts_at: new Date(Date.UTC(2030, 0, 7 + day, hour + 5)).toISOString(),
  ends_at: new Date(Date.UTC(2030, 0, 7 + day, hour + 13)).toISOString(),
  unpaid_break_minutes: 30,
});
const publish = (...rows: Row[]) => {
  server.list = rows;
  for (const r of rows) server.byId.set(r.id, r);
};
const sync = () => syncShifts({ employments, locations, t, lang: "fr" });

beforeEach(async () => {
  store.clear();
  events.clear();
  reminders.clear();
  server.byId.clear();
  Object.assign(server, { list: [], failList: false, failConfirm: false });
  Object.assign(fail, { createAfter: Infinity, notifPermission: true });
  await savePrefs({ calendar: true, reminderMinutes: 60 });
  publish(shift("a", 0), shift("b", 1));
  expect(await sync()).toEqual([
    { ok: true, count: 2 },
    { ok: true, count: 2 },
  ]);
  expect(events.size).toBe(2);
  expect([...reminders.keys()].sort()).toEqual(["cw-shift-a", "cw-shift-b"]);
});

describe("calendar and reminders", () => {
  it("a failed schedule request changes nothing", async () => {
    server.failList = true;
    expect((await sync())[0]).toMatchObject({ ok: false, reason: "error" });
    expect(events.size).toBe(2);
    expect(reminders.size).toBe(2);
  });

  it("a shift missing from the list is kept until the server confirms it's gone", async () => {
    server.list = [server.byId.get("a")!]; // b no longer listed
    server.failConfirm = true; // ...and the confirmation fails
    expect((await sync())[0]).toMatchObject({ ok: false });
    expect(events.size).toBe(2);
    expect(reminders.has("cw-shift-b")).toBe(true);

    server.failConfirm = false; // b still mine (e.g. moved past 8 weeks): keep
    await sync();
    expect(events.size).toBe(2);
    expect(reminders.has("cw-shift-b")).toBe(true);

    server.byId.set("b", { ...server.byId.get("b")!, employment_id: "someone-else" }); // given away: remove
    await sync();
    expect(events.size).toBe(1);
    expect(reminders.has("cw-shift-b")).toBe(false);
  });

  it("a changed shift updates its event and reminder in place", async () => {
    publish(shift("a", 0, 11), shift("b", 1));
    await sync();
    expect(events.size).toBe(2);
    expect([...events.values()].map((e) => e.startDate.toISOString())).toContain(shift("a", 0, 11).starts_at);
    expect(reminders.get("cw-shift-a")?.date).toBe(Date.parse(shift("a", 0, 11).starts_at) - 3_600_000);
  });

  it("a calendar error half-way leaves no duplicates on the next sync", async () => {
    publish(shift("a", 0), shift("b", 1), shift("c", 2), shift("d", 3));
    fail.createAfter = 3; // the 4th event can't be created
    expect((await sync())[0]).toMatchObject({ ok: false });
    expect(events.size).toBe(3);
    fail.createAfter = Infinity;
    await sync();
    expect(events.size).toBe(4);
  });

  it("notifications turned off in iOS settings: existing reminders stay", async () => {
    fail.notifPermission = false;
    publish(shift("a", 0));
    server.byId.delete("b");
    expect(await sync()).toContainEqual({ ok: false, reason: "notifications_denied" });
    expect(reminders.size).toBe(2);
  });

  it("reminders from version 0.3 (random ids) are replaced, not doubled", async () => {
    reminders.clear();
    reminders.set("random-1", { date: 1 });
    store.set("cw-reminder-ids", JSON.stringify(["random-1"]));
    await sync();
    expect([...reminders.keys()].sort()).toEqual(["cw-shift-a", "cw-shift-b"]);
  });
});
