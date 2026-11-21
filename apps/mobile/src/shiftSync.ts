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

async function syncCalendar(shifts: Shift[], locations: Location[], t: Strings): Promise<SyncOutcome> {
  const perm = await requestCalendarPermissions();
  if (!perm.granted) return { ok: false, reason: "calendar_denied" };
  const cal = await ensureCalendar(t);
  const map = await readMap();
  const next: CalMap = {};
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
    if (known && known.sig === sig) {
      next[s.id] = known;
      continue;
    }
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
  // Shifts that disappeared (given away, removed): delete their future events.
  for (const [shiftId, entry] of Object.entries(map)) {
    if (next[shiftId]) continue;
    if (Date.parse(entry.end) > Date.now()) {
      try {
        await (await ExpoCalendarEvent.get(entry.e)).delete();
      } catch {
        /* already gone */
      }
    }
  }
  await AsyncStorage.setItem(KEY_CAL_MAP, JSON.stringify(next));
  return { ok: true, count: shifts.length };
}

// ---------------------------------------------------------------- Reminders

async function cancelReminders(): Promise<void> {
  let ids: string[] = [];
  try {
    ids = JSON.parse((await AsyncStorage.getItem(KEY_REMINDER_IDS)) ?? "[]") as string[];
  } catch {
    ids = [];
  }
  await Promise.all(ids.map((id) => Notifications.cancelScheduledNotificationAsync(id).catch(() => undefined)));
  await AsyncStorage.setItem(KEY_REMINDER_IDS, "[]");
}

async function syncReminders(shifts: Shift[], locations: Location[], minutes: number, t: Strings, lang: Lang): Promise<SyncOutcome> {
  await cancelReminders();
  if (!minutes) return { ok: true, count: 0 };
  let perm = await Notifications.getPermissionsAsync();
  if (!perm.granted) perm = await Notifications.requestPermissionsAsync();
  if (!perm.granted) return { ok: false, reason: "notifications_denied" };
  if (Platform.OS === "android") {
    await Notifications.setNotificationChannelAsync(CHANNEL, { name: t.reminderChannel, importance: Notifications.AndroidImportance.HIGH });
  }
  const ids: string[] = [];
  for (const s of shifts) {
    if (ids.length >= MAX_REMINDERS) break;
    const at = Date.parse(s.starts_at) - minutes * 60_000;
    if (at < Date.now() + 30_000) continue;
    const loc = locations.find((l) => l.id === s.location_id);
    const tz = loc?.timezone;
    const id = await Notifications.scheduleNotificationAsync({
      content: {
        title: t.reminderTitle(fmtDay(s.starts_at, lang, tz), fmtTime(s.starts_at, tz), loc?.name ?? ""),
        body: loc?.address ?? loc?.name ?? "",
      },
      trigger: { type: Notifications.SchedulableTriggerInputTypes.DATE, date: at, channelId: CHANNEL },
    });
    ids.push(id);
  }
  await AsyncStorage.setItem(KEY_REMINDER_IDS, JSON.stringify(ids));
  return { ok: true, count: ids.length };
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
      // No employment loaded (e.g. the profile didn't load): leave the phone as it is.
      if (opts.employments.length === 0) return [{ ok: false, reason: "error", message: "no_employments" }];
      const shifts = await fetchUpcomingShifts(opts.employments);
      const out: SyncOutcome[] = [];
      if (prefs.calendar) out.push(await syncCalendar(shifts, opts.locations, opts.t));
      out.push(await syncReminders(shifts, opts.locations, prefs.reminderMinutes, opts.t, opts.lang));
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
