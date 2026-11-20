import { createClient } from "@supabase/supabase-js";

// Public values: the project URL and the publishable key are meant to be shipped in apps.
// Data is protected by row-level security on the server.
export const SUPABASE_URL = "https://tmxnbqjlagsyoujppkpb.supabase.co";
export const SUPABASE_PUBLISHABLE_KEY = "sb_publishable_LCXXQ4bJc_tu0U6Xiq4Rrw_5BLjdmpJ";

export const supabase = createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, {
  auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: false },
});

// ---------- Row types (match supabase/migrations) ----------

export type Province = "AB" | "BC" | "MB" | "NB" | "NL" | "NS" | "NT" | "NU" | "ON" | "PE" | "QC" | "SK" | "YT";

export interface Company {
  id: string;
  account_id: string;
  legal_name: string;
}

export interface Location {
  id: string;
  account_id: string;
  company_id: string;
  name: string;
  province: Province;
  timezone: string;
  address: string | null;
  latitude: number | null;
  longitude: number | null;
  geofence_radius_m: number;
  early_punch_limit_min: number;
}

export interface LocationWifi {
  id: string;
  location_id: string;
  ssid: string | null;
  bssid: string;
}

export interface Person {
  id: string;
  account_id: string;
  user_id: string | null;
  first_name: string;
  last_name: string;
  email: string | null;
  phone: string | null;
  preferred_locale: "fr-CA" | "en-CA";
}

export interface RoleAssignment {
  id: string;
  person_id: string;
  role: "owner" | "company_admin" | "clinic_manager";
  company_id: string | null;
  location_id: string | null;
}

export interface Employment {
  id: string;
  person_id: string;
  company_id: string;
  start_date: string;
  end_date: string | null;
  desired_weekly_minutes: number | null;
  min_weekly_minutes: number | null;
  max_weekly_minutes: number | null;
  job_role_id: string | null;
  employment_locations: { location_id: string }[];
}

export interface ScheduleWeek {
  id: string;
  location_id: string;
  week_start: string;
  status: "draft" | "published";
  published_at: string | null;
}

export interface Shift {
  id: string;
  location_id: string;
  week_start: string;
  employment_id: string | null;
  starts_at: string;
  ends_at: string;
  unpaid_break_minutes: number;
  response: "pending" | "confirmed" | "declined";
  job_role_id: string | null;
  notes: string | null;
  updated_at: string;
}

export interface AvailabilityRule {
  person_id: string;
  weekday: number;
  start_time: string;
  end_time: string;
  status: "pending" | "approved" | "rejected";
}

export interface AvailabilityException {
  person_id: string;
  date: string;
  start_time: string | null;
  end_time: string | null;
  status: "pending" | "approved" | "rejected";
}

export interface KioskDevice {
  id: string;
  location_id: string;
  name: string;
  created_at: string;
}

export interface Punch {
  id: string;
  person_id: string;
  location_id: string;
  kind: "in" | "out";
  method: "phone_geofence" | "rotating_qr" | "kiosk_pin" | "manual";
  occurred_at: string;
  distance_m: number | null;
  flags: string[];
}

/** Throws a readable error when a Supabase call fails. */
export function must<T>(res: { data: T | null; error: { message: string } | null }): T {
  if (res.error) throw new Error(res.error.message);
  return res.data as T;
}

export type Permission = "schedule" | "employees" | "punches" | "clinics" | "kiosks";
export const PERMISSIONS: Permission[] = ["schedule", "employees", "punches", "clinics", "kiosks"];

export interface JobRole {
  id: string;
  account_id: string;
  name_fr: string;
  name_en: string;
}

export interface CustomRole {
  id: string;
  account_id: string;
  company_id: string;
  name: string;
  permissions: Permission[];
}

export interface CustomRoleAssignment {
  id: string;
  person_id: string;
  custom_role_id: string;
  location_id: string;
}

export type SwapStatus = "pending_colleague" | "pending_manager" | "approved" | "refused_colleague" | "refused_manager" | "cancelled";

export interface ShiftSwap {
  id: string;
  shift_id: string;
  location_id: string;
  requester_employment_id: string;
  target_employment_id: string;
  target_shift_id: string | null;
  target_location_id: string | null;
  note: string | null;
  status: SwapStatus;
  colleague_responded_at: string | null;
  decided_by: string | null;
  decided_at: string | null;
  manager_note: string | null;
  created_at: string;
}
