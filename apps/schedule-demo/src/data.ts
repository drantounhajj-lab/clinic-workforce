/**
 * Sample data for the demo: 4 clinics owned by 4 separate companies, in Quebec and Ontario.
 * All people and companies are fictional.
 */
import {
  addDays,
  type AvailabilityExceptionInput,
  type AvailabilityRuleInput,
  type CredentialInput,
  type EmploymentInput,
  type LocationInput,
} from "@clinic-workforce/rules";

export const TZ = "America/Toronto";

export interface Clinic extends LocationInput {
  name: string;
  companyName: string;
}

export const clinics: Clinic[] = [
  { id: "gatineau", name: "Gatineau", companyId: "co-a", companyName: "Clinique podiatrique Gatineau inc.", province: "QC", timezone: TZ },
  { id: "aylmer", name: "Aylmer", companyId: "co-b", companyName: "Podiatrie Aylmer inc.", province: "QC", timezone: TZ },
  { id: "ottawa", name: "Ottawa Centre", companyId: "co-c", companyName: "Ottawa Centre Foot Clinic Ltd.", province: "ON", timezone: TZ },
  { id: "orleans", name: "Orléans", companyId: "co-d", companyName: "Orléans Podiatry Ltd.", province: "ON", timezone: TZ },
];

export type RoleKey = "reception" | "assistant" | "podiatrist";

export interface Person {
  id: string;
  name: string;
  role: RoleKey;
}

export const persons: Person[] = [
  { id: "marie", name: "Marie Tremblay", role: "reception" },
  { id: "julie", name: "Julie Gagnon", role: "assistant" },
  { id: "karim", name: "Dr Karim Haddad", role: "podiatrist" },
  { id: "sophie", name: "Sophie Roy", role: "reception" },
  { id: "emilie", name: "Dr Émilie Côté", role: "podiatrist" },
  { id: "nadia", name: "Nadia Bouchard", role: "assistant" },
  { id: "luc", name: "Luc Martin", role: "reception" },
  { id: "sarah", name: "Dr Sarah Wilson", role: "podiatrist" },
  { id: "kevin", name: "Kevin Lee", role: "assistant" },
  { id: "ana", name: "Dr Ana Pereira", role: "podiatrist" },
  { id: "chloe", name: "Chloé Lavoie", role: "reception" },
];

const h = (hours: number) => hours * 60;

export const employments: EmploymentInput[] = [
  // Marie works for two companies: Gatineau (QC) and Ottawa Centre (ON)
  { id: "marie-a", personId: "marie", companyId: "co-a", locationIds: ["gatineau"], desiredWeeklyMinutes: h(30), maxWeeklyMinutes: h(35) },
  { id: "marie-c", personId: "marie", companyId: "co-c", locationIds: ["ottawa"], desiredWeeklyMinutes: h(12) },
  { id: "julie-a", personId: "julie", companyId: "co-a", locationIds: ["gatineau"], desiredWeeklyMinutes: h(32) },
  // Dr Haddad works for two Quebec companies
  { id: "karim-a", personId: "karim", companyId: "co-a", locationIds: ["gatineau"], desiredWeeklyMinutes: h(24) },
  { id: "karim-b", personId: "karim", companyId: "co-b", locationIds: ["aylmer"], desiredWeeklyMinutes: h(15) },
  { id: "sophie-b", personId: "sophie", companyId: "co-b", locationIds: ["aylmer"], desiredWeeklyMinutes: h(37.5) },
  { id: "emilie-b", personId: "emilie", companyId: "co-b", locationIds: ["aylmer"], desiredWeeklyMinutes: h(32) },
  { id: "nadia-b", personId: "nadia", companyId: "co-b", locationIds: ["aylmer"], desiredWeeklyMinutes: h(22), minWeeklyMinutes: h(20) },
  { id: "luc-c", personId: "luc", companyId: "co-c", locationIds: ["ottawa"], desiredWeeklyMinutes: h(30) },
  { id: "sarah-c", personId: "sarah", companyId: "co-c", locationIds: ["ottawa"], desiredWeeklyMinutes: h(36) },
  { id: "kevin-d", personId: "kevin", companyId: "co-d", locationIds: ["orleans"], desiredWeeklyMinutes: h(37.5) },
  { id: "ana-d", personId: "ana", companyId: "co-d", locationIds: ["orleans"], desiredWeeklyMinutes: h(32), maxWeeklyMinutes: h(36) },
  { id: "chloe-d", personId: "chloe", companyId: "co-d", locationIds: ["orleans"], desiredWeeklyMinutes: h(37.5) },
];

const weekdays = (days: number[], start: string, end: string, personId: string): AvailabilityRuleInput[] =>
  days.map((weekday) => ({ personId, weekday, start, end, status: "approved" }));

/** Recurring availability. People with no rules are treated as always available. */
export const availabilityRules: AvailabilityRuleInput[] = [
  // Julie: school pick-up, available weekdays 8:00–15:00 only
  ...weekdays([0, 1, 2, 3, 4], "08:00", "15:00", "julie"),
  // Luc: not available on Wednesdays
  ...weekdays([0, 1, 3, 4, 5], "07:00", "19:00", "luc"),
];

export function availabilityExceptions(w0: string): AvailabilityExceptionInput[] {
  return [
    // Sophie: day off on Friday of the current week
    { personId: "sophie", date: addDays(w0, 4), status: "approved" },
  ];
}

export function credentials(w0: string): CredentialInput[] {
  return [
    // Dr Côté's licence expires on Wednesday of the following week
    { personId: "emilie", name: "OPQ licence", expiresOn: addDays(w0, 9), blocksSchedulingWhenExpired: true },
  ];
}

export interface DemoShift {
  id: string;
  employmentId: string | null;
  locationId: string;
  date: string; // "YYYY-MM-DD"
  start: string; // "HH:MM"
  end: string; // "HH:MM"
  breakMin: number;
}

let seq = 0;
const nextId = () => `seed-${++seq}`;

function pattern(week: string, employmentId: string | null, locationId: string, days: number[], start: string, end: string, breakMin: number): DemoShift[] {
  return days.map((d) => ({ id: nextId(), employmentId, locationId, date: addDays(week, d), start, end, breakMin }));
}

function regularWeek(week: string): DemoShift[] {
  return [
    // Gatineau (QC)
    ...pattern(week, "marie-a", "gatineau", [0, 1, 2, 3], "08:00", "16:00", 30),
    ...pattern(week, "julie-a", "gatineau", [0, 1, 2, 3, 4], "08:00", "15:00", 30),
    ...pattern(week, "karim-a", "gatineau", [0, 2, 4], "08:30", "17:00", 30),
    // Aylmer (QC)
    ...pattern(week, "sophie-b", "aylmer", [0, 1, 2, 3], "09:00", "17:00", 30),
    ...pattern(week, "emilie-b", "aylmer", [0, 1, 2, 3], "09:00", "17:30", 30),
    ...pattern(week, "karim-b", "aylmer", [1, 3], "09:00", "17:00", 30),
    ...pattern(week, "nadia-b", "aylmer", [0, 1, 2, 3], "09:00", "15:00", 30),
    // Ottawa Centre (ON)
    ...pattern(week, "marie-c", "ottawa", [4], "08:00", "16:00", 30),
    ...pattern(week, "marie-c", "ottawa", [5], "09:00", "13:00", 0),
    ...pattern(week, "luc-c", "ottawa", [0, 1, 3], "08:00", "16:00", 30),
    ...pattern(week, "sarah-c", "ottawa", [0, 1, 2, 3], "08:00", "16:30", 30),
    // Orléans (ON)
    ...pattern(week, "kevin-d", "orleans", [0, 1, 2, 3, 4], "08:30", "16:30", 30),
    ...pattern(week, "ana-d", "orleans", [0, 1, 3, 4], "08:30", "17:00", 30),
    ...pattern(week, "chloe-d", "orleans", [0, 1, 2, 3, 4], "08:00", "16:00", 30),
  ];
}

/** Previous week and current week filled; the following week is left empty to try "Copy previous week". */
export function seedShifts(w0: string): DemoShift[] {
  seq = 0;
  const previous = regularWeek(addDays(w0, -7));
  const current = regularWeek(w0);
  // A few things for the rules engine to catch in the current week:
  current.push(
    // Julie is only available until 15:00
    { id: nextId(), employmentId: "julie-a", locationId: "gatineau", date: addDays(w0, 5), start: "09:00", end: "13:00", breakMin: 0 },
    // Dr Wilson's Friday has no meal break
    { id: nextId(), employmentId: "sarah-c", locationId: "ottawa", date: addDays(w0, 4), start: "08:00", end: "16:30", breakMin: 0 },
    // An open shift at Orléans on Saturday
    { id: nextId(), employmentId: null, locationId: "orleans", date: addDays(w0, 5), start: "09:00", end: "13:00", breakMin: 0 },
  );
  return [...previous, ...current];
}
