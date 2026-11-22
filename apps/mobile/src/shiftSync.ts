/**
 * Keeps the employee's published shifts in a "Clinic Workforce" calendar on the phone (with the clinic
 * address), and schedules local reminder notifications before each shift. Both are opt-in in Setup.
 * Nothing here talks to a push server: reminders are scheduled on the phone itself.
 */
import AsyncStorage from "@react-native-async-storage/async-storage";
import {
  CalendarAccessLevel,
  createCalendar,
  EntityTypes,
  ExpoCalendar,
  ExpoCalendarEvent,
  getDefaultCalendarSync,
  getSourcesSync,
  requestCalendarPermissions,
  SourceType,
} from "expo-calendar";
import * as Notifications from "expo-notifications";
import { Platform } from "react-native";
import { fmtDay, fmtTime } from "./format";
import type { Lang, Strings } from "./i18n";
import { type Employment, type Location, type Shift, supabase } from "./supabase";

const KEY_CAL_ENABLED = "cw-calendar-sync";
const KEY_CAL_ID = "cw-calendar-id";
const KEY_CAL_MAP = "cw-calendar-map";
const KEY_REMINDER = "cw-reminder-minutes";
const KEY_REMINDER_IDS = "cw-reminder-ids";
const CHANNEL = "shifts";
const MAX_REMINDERS = 40; // iOS keeps at most 64 pending local notifications per app

export const REMINDER_CHOICES = [0, 30, 60, 120, 1440] as const;
export type ReminderMinutes = (typeof REMINDER_CHOICES)[number];

export interface SyncPrefs {
  calendar: boolean;
  reminderMinutes: ReminderMinutes;
}

Notifications.setNotificationHandler({
  handleNotification: async () => ({ shouldShowBanner: true, shouldShowList: true, shouldPlaySound: true, shouldSetBadge: false }),
});

export async function loadPrefs(): Promise<SyncPrefs> {
  const [cal, rem] = await Promise.all([AsyncStorage.getItem(KEY_CAL_ENABLED), AsyncStorage.getItem(KEY_REMINDER)]);
  const minutes = Number(rem ?? 0);
  return { calendar: cal === "1", reminderMinutes: (REMINDER_CHOICES as readonly number[]).includes(minutes) ? (minutes as ReminderMinutes) : 0 };
}

export async function savePrefs(p: SyncPrefs): Promise<void> {
  await AsyncStorage.multiSet([
    [KEY_CAL_ENABLED, p.calendar ? "1" : "0"],
    [KEY_REMINDER, String(p.reminderMinutes)],
  ]);
}

/** My published shifts from now to 8 weeks ahead. */
export async function fetchUpcomingShifts(employments: Employment[]): Promise<Shift[]> {
  const empIds = employments.map((e) => e.id);
  const locIds = [...new Set(employments.flatMap((e) => e.employment_locations.map((x) => x.location_id)))];
  if (!empIds.length) return [];
  const until = new Date(Date.now() + 56 * 86_400_000).toISOString();
  const [shifts, weeks] = await Promise.all([
    supabase.from("shifts").select("*").in("employment_id", empIds).gt("ends_at", new Date().toISOString()).lt("starts_at", until).order("starts_at"),
    supabase.from("schedule_weeks").select("location_id, week_start").eq("status", "published").in("location_id", locIds),
  ]);
  // Never act on a failed request: an empty list would delete events and cancel reminders.
  if (shifts.error) throw new Error(shifts.error.message);
  if (weeks.error) throw new Error(weeks.error.message);
  // Managers can read draft weeks too: keep only published ones.
  const published = new Set(((weeks.data as { location_id: string; week_start: string }[]) ?? []).map((w) => `${w.location_id}|${w.week_start}`));
  return ((shifts.data as (Shift & { week_start: string })[]) ?? []).filter((s) => published.has(`${s.location_id}|${s.week_start}`));
}

/**
 * Of these shift ids (on the phone but not in the latest list), which are confirmed gone for me:
 * deleted, given to someone else, or ended. A shift still mine and upcoming (e.g. moved past the
 * 8-week window) is not "gone". Throws if the server can't confirm, so nothing is deleted.
 */
async function confirmGone(shiftIds: string[], employments: Employment[]): Promise<Set<string>> {
  if (!shiftIds.length) return new Set();
  const mine = new Set(employments.map((e) => e.id));
  const { data, error } = await supabase.from("shifts").select("id, employment_id, ends_at").in("id", shiftIds);
  if (error) throw new Error(error.message);
  const stillMine = new Set(
    ((data as { id: string; employment_id: string | null; ends_at: string }[]) ?? [])
      .filter((x) => x.employment_id && mine.has(x.employment_id) && Date.parse(x.ends_at) > Date.now())
      .map((x) => x.id),
  );
  return new Set(shiftIds.filter((id) => !stillMine.has(id)));
}

// ---------------------------------------------------------------- Calendar

type CalMap = Record<string, { e: string; sig: string; end: string }>;

async function readMap(): Promise<CalMap> {
  try {
    return JSON.parse((await AsyncStorage.getItem(KEY_CAL_MAP)) ?? "{}") as CalMap;
  } catch {
    return {};
  }
}

async function ensureCalendar(t: Strings): Promise<ExpoCalendar> {
  const savedId = await AsyncStorage.getItem(KEY_CAL_ID);
  if (savedId) {
    try {
      return await ExpoCalendar.get(savedId);
    } catch {
      await AsyncStorage.multiRemove([KEY_CAL_ID, KEY_CAL_MAP]);
    }
  }
  const make = (source: { id?: string; type: string; name: string; isLocalAccount?: boolean }) =>
    createCalendar({
      title: t.calendarName,
      name: "clinic-workforce",
      color: "#0B6E7F",
      entityType: EntityTypes.EVENT,
      source,
      sourceId: source.id,
      ownerAccount: "clinic-workforce",
      accessLevel: CalendarAccessLevel.OWNER,
    });
  let cal: ExpoCalendar;
  if (Platform.OS === "ios") {
    try {
      // Same account as the phone's default calendar (usually iCloud), so it shows on the user's other devices.
      cal = await make(getDefaultCalendarSync().source);
    } catch {
      const local = getSourcesSync().find((x) => x.type === SourceType.LOCAL);
      if (!local) throw new Error("No calendar account on this iPhone");
      cal = await make(local);
    }
  } else {
    cal = await make({ isLocalAccount: true, name: t.calendarName, type: "LOCAL" });
  }
  await AsyncStorage.setItem(KEY_CAL_ID, cal.id);
  return cal;
}

/** Removes the app's calendar (and all its events) from the phone. */
export async function removeCalendar(): Promise<void> {
  const id = await AsyncStorage.getItem(KEY_CAL_ID);
  if (id) {
    try {
      await (await ExpoCalendar.get(id)).delete();
    } catch {
      /* already gone */
    }
  }
  await AsyncStorage.multiRemove([KEY_CAL_ID, KEY_CAL_MAP]);
}

export type SyncOutcome = { ok: true; count: number } | { ok: false; reason: "calendar_denied" | "notifications_denied" | "error"; message?: string };

async function syncCalendar(shifts: Shift[], locations: Location[], employments: Employment[], t: Strings): Promise<SyncOutcome> {
  const perm = await requestCalendarPermissions();
  if (!perm.granted) return { ok: false, reason: "calendar_denied" };
  const cal = await ensureCalendar(t);
  const map = await readMap();
  // Start from what's on the phone; each step updates it and it's saved even if a later step fails,
  // so a failure never loses track of events (no duplicates, no orphans).
  const next: CalMap = { ...map };
  try {
    for (const s of shifts) {
      const loc = locations.find((l) => l.id === s.location_id);
      const where = [loc?.name, loc?.address].filter(Boolean).join(", ");
      const details = {
        title: t.calendarEventTitle(loc?.name ?? ""),
        startDate: new Date(s.starts_at),
        endDate: new Date(s.ends_at),
        location: where,
        notes: s.unpaid_break_minutes ? t.calendarBreak(s.unpaid_break_minutes) : "",
        timeZone: loc?.timezone,
      };
      const sig = `${s.starts_at}|${s.ends_at}|${where}|${s.unpaid_break_minutes}`;
      const known = map[s.id];
      if (known && known.sig === sig) continue;
      let eventId: string | null = null;
      if (known) {
        try {
          const ev = await ExpoCalendarEvent.get(known.e);
          await ev.update(details);
          eventId = known.e;
        } catch {
          eventId = null;
        }
      }
      if (!eventId) eventId = (await cal.createEvent(details)).id;
      next[s.id] = { e: eventId, sig, end: s.ends_at };
    }
    // Events whose shift is no longer in the list: delete only those the server confirms are gone.
    const listed = new Set(shifts.map((s) => s.id));
    const missing = Object.keys(map).filter((id) => !listed.has(id));
    const gone = await confirmGone(missing, employments);
    for (const shiftId of missing) {
      const entry = map[shiftId];
      if (Date.parse(entry.end) <= Date.now()) {
        delete next[shiftId]; // past: keep the event as history, stop tracking it
      } else if (gone.has(shiftId)) {
        try {
          await (await ExpoCalendarEvent.get(entry.e)).delete();
        } catch {
          /* already gone */
        }
        delete next[shiftId];
      }
    }
  } finally {
    await AsyncStorage.setItem(KEY_CAL_MAP, JSON.stringify(next));
  }
  return { ok: true, count: shifts.length };
}

// ---------------------------------------------------------------- Reminders

// Reminders are scheduled with a fixed id per shift ("cw-shift-<id>"): scheduling again replaces it.
// The phone keeps { shiftId: signature } so unchanged reminders are left alone.
type ReminderMap = Record<string, string>;

async function readReminders(): Promise<ReminderMap> {
  let raw: unknown = {};
  try {
    raw = JSON.parse((await AsyncStorage.getItem(KEY_REMINDER_IDS)) ?? "{}");
  } catch {
    raw = {};
  }
  if (!Array.isArray(raw)) return raw as ReminderMap;
  // Version 0.3 stored a list of random ids: cancel those once, they'll be rescheduled with fixed ids.
  await Promise.all((raw as string[]).map((id) => Notifications.cancelScheduledNotificationAsync(id).catch(() => undefined)));
  await AsyncStorage.setItem(KEY_REMINDER_IDS, "{}");
  return {};
}

const reminderId = (shiftId: string) => `cw-shift-${shiftId}`;

async function cancelReminders(): Promise<void> {
  const map = await readReminders();
  await Promise.all(Object.keys(map).map((id) => Notifications.cancelScheduledNotificationAsync(reminderId(id)).catch(() => undefined)));
  await AsyncStorage.setItem(KEY_REMINDER_IDS, "{}");
}

async function syncReminders(shifts: Shift[], locations: Location[], employments: Employment[], minutes: number, t: Strings, lang: Lang): Promise<SyncOutcome> {
  if (!minutes) {
    await cancelReminders(); // turned off by the employee
    return { ok: true, count: 0 };
  }
  let perm = await Notifications.getPermissionsAsync();
  if (!perm.granted) perm = await Notifications.requestPermissionsAsync();
  if (!perm.granted) return { ok: false, reason: "notifications_denied" }; // leave existing reminders as they are
  if (Platform.OS === "android") {
    await Notifications.setNotificationChannelAsync(CHANNEL, { name: t.reminderChannel, importance: Notifications.AndroidImportance.HIGH });
  }
  const old = await readReminders();
  const next: ReminderMap = { ...old };
  const wanted = new Set<string>();
  try {
    for (const s of shifts) {
      if (wanted.size >= MAX_REMINDERS) break;
      const at = Date.parse(s.starts_at) - minutes * 60_000;
      if (at < Date.now() + 30_000) continue;
      wanted.add(s.id);
      const loc = locations.find((l) => l.id === s.location_id);
      const tz = loc?.timezone;
      const sig = `${at}|${loc?.name ?? ""}|${loc?.address ?? ""}|${lang}`;
      if (old[s.id] === sig) continue;
      await Notifications.scheduleNotificationAsync({
        identifier: reminderId(s.id),
        content: {
          title: t.reminderTitle(fmtDay(s.starts_at, lang, tz), fmtTime(s.starts_at, tz), loc?.name ?? ""),
          body: loc?.address ?? loc?.name ?? "",
        },
        trigger: { type: Notifications.SchedulableTriggerInputTypes.DATE, date: at, channelId: CHANNEL },
      });
      next[s.id] = sig;
    }
    // Reminders for shifts not in the list: cancel when the server confirms the shift is gone,
    // or when the reminder is no longer wanted (too soon, past, beyond the limit) but the shift is in the list.
    const listed = new Set(shifts.map((s) => s.id));
    const missing = Object.keys(old).filter((id) => !listed.has(id));
    const gone = await confirmGone(missing, employments);
    for (const id of Object.keys(old)) {
      if (wanted.has(id)) continue;
      if (listed.has(id) || gone.has(id)) {
        await Notifications.cancelScheduledNotificationAsync(reminderId(id)).catch(() => undefined);
        delete next[id];
      }
    }
  } finally {
    await AsyncStorage.setItem(KEY_REMINDER_IDS, JSON.stringify(next));
  }
  return { ok: true, count: wanted.size };
}

// ---------------------------------------------------------------- Both

let chain: Promise<unknown> = Promise.resolve();

/** Fetch my shifts and bring the calendar and reminders up to date with the saved preferences (one sync at a time). */
export function syncShifts(opts: { employments: Employment[]; locations: Location[]; t: Strings; lang: Lang }): Promise<SyncOutcome[]> {
  const run = chain.then(async (): Promise<SyncOutcome[]> => {
    try {
      const prefs = await loadPrefs();
      if (!prefs.calendar && !prefs.reminderMinutes) {
        await cancelReminders();
        return [];
      }
      // Profile or clinics didn't load: leave the phone as it is (an empty list would delete everything).
      if (opts.employments.length === 0) return [{ ok: false, reason: "error", message: "no_employments" }];
      if (opts.locations.length === 0) return [{ ok: false, reason: "error", message: "no_locations" }];
      const shifts = await fetchUpcomingShifts(opts.employments);
      const out: SyncOutcome[] = [];
      if (prefs.calendar) out.push(await syncCalendar(shifts, opts.locations, opts.employments, opts.t));
      out.push(await syncReminders(shifts, opts.locations, opts.employments, prefs.reminderMinutes, opts.t, opts.lang));
      return out;
    } catch (e) {
      return [{ ok: false, reason: "error", message: (e as Error).message }];
    }
  });
  chain = run.catch(() => undefined);
  return run;
}

/** Turn everything off and clean up (sign-out). */
export async function clearShiftSync(): Promise<void> {
  await cancelReminders().catch(() => undefined);
  await removeCalendar().catch(() => undefined);
  await AsyncStorage.multiRemove([KEY_CAL_ENABLED, KEY_REMINDER]).catch(() => undefined);
}
