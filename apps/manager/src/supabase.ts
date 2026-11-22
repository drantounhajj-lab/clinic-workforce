import { createClient } from "@supabase/supabase-js";

// Public values: the project URL and the publishable key are meant to be shipped in apps.
// Data is protected by row-level security on the server.
// VITE_SUPABASE_URL / VITE_SUPABASE_PUBLISHABLE_KEY point the page at a local test backend (e2e/stack.mjs).
export const SUPABASE_URL: string = import.meta.env.VITE_SUPABASE_URL ?? "https://tmxnbqjlagsyoujppkpb.supabase.co";
export const SUPABASE_PUBLISHABLE_KEY: string = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY ?? "sb_publishable_LCXXQ4bJc_tu0U6Xiq4Rrw_5BLjdmpJ";

export const supabase = createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, {
  auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: false },
});

// ---------- Row types (match supabase/migrations) ----------

export type Province = "AB" | "BC" | "MB" | "NB" | "NL" | "NS" | "NT" | "NU" | "ON" | "PE" | "QC" | "SK" | "YT";

export interface Account {
  id: string;
  name: string;
  /** Overtime and weekly limits count hours across all of this account's companies. */
  combine_related_company_hours: boolean;
}

export interface Company {
  id: string;
  account_id: string;
  legal_name: string;
  pay_frequency: "weekly" | "biweekly";
  pay_period_anchor: string;
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
  payroll_number: string | null;
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
  id?: string;
  person_id: string;
  weekday: number;
  start_time: string;
  end_time: string;
  status: "pending" | "approved" | "rejected";
  kind: "available" | "unavailable";
  effective_from: string;
  effective_to: string | null;
  every_weeks: number;
  anchor_week: string | null;
  location_ids: string[] | null;
}

export interface AvailabilityException {
  id: string;
  person_id: string;
  date: string;
  end_date: string | null;
  start_time: string | null;
  end_time: string | null;
  kind: "available" | "unavailable";
  location_ids: string[] | null;
  reason: string | null;
  status: "pending" | "approved" | "rejected";
}

export interface LeaveType {
  id: string;
  category: TimeOffType;
  name_fr: string;
  name_en: string;
  active: boolean;
  sort: number;
}

export interface StaffingRatioRule {
  id: string;
  location_id: string;
  weekdays: number[];
  start_time: string;
  end_time: string;
  trigger_job_role_id: string;
  trigger_count: number;
  required_job_role_id: string;
  required_count: number;
}

export interface ScheduleTemplate {
  id: string;
  location_id: string;
  name: string;
  weeks: number;
  created_at: string;
}

/** A person's shift during a leave, at any clinic (time_off_impact). */
export interface ImpactShift {
  id: string;
  location_id: string;
  location_name: string;
  starts_at: string;
  ends_at: string;
  week_start: string;
  can_schedule: boolean;
}

export interface CoverageOffer {
  id: string;
  shift_id: string;
  location_id: string;
  status: "open" | "filled" | "cancelled";
  filled_employment_id: string | null;
  created_at: string;
}

export interface CoverageInvite {
  offer_id: string;
  employment_id: string;
  person_id: string;
  status: "invited" | "accepted" | "declined" | "expired";
  responded_at: string | null;
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
  employment_id: string;
  location_id: string;
  kind: "in" | "out";
  method: "phone_geofence" | "rotating_qr" | "kiosk_pin" | "manual";
  occurred_at: string;
  distance_m: number | null;
  flags: string[];
}

/** Throws a readable error when a Supabase call fails. */
export class DbError extends Error {
  code?: string;
  constructor(message: string, code?: string) {
    super(message);
    this.code = code;
  }
}

export function must<T>(res: { data: T | null; error: { message: string; code?: string } | null }): T {
  if (res.error) throw new DbError(res.error.message, res.error.code);
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

export type RequestStatus = "pending" | "approved" | "refused" | "cancelled";
export type TimeOffType = "vacation" | "sick" | "personal" | "unpaid" | "other";

export interface TimeOffRequest {
  id: string;
  person_id: string;
  type: TimeOffType;
  start_date: string;
  end_date: string;
  start_time: string | null;
  end_time: string | null;
  paid_hours: number | null;
  /** Moved to time_off_reasons (private); always null now. */
  note: string | null;
  leave_type_id: string | null;
  status: RequestStatus;
  manager_note: string | null;
  created_at: string;
}

export interface PunchCorrection {
  id: string;
  person_id: string;
  employment_id: string;
  location_id: string;
  punch_id: string | null;
  kind: "in" | "out";
  occurred_at: string;
  reason: string;
  status: RequestStatus;
  requested_by: string | null;
  manager_note: string | null;
  created_at: string;
}

export interface TimesheetApproval {
  id: string;
  company_id: string;
  person_id: string;
  period_start: string;
  period_end: string;
  regular_minutes: number;
  overtime_minutes: number;
  approved_by: string | null;
  approved_at: string;
}

export interface Credential {
  id: string;
  person_id: string;
  name: string;
  number: string | null;
  issuer: string | null;
  expires_on: string | null;
  blocks_scheduling: boolean;
}

export interface CoverageRule {
  id: string;
  location_id: string;
  job_role_id: string;
  weekdays: number[];
  start_time: string;
  end_time: string;
  min_count: number;
}

export interface ShiftClaim {
  id: string;
  shift_id: string;
  employment_id: string;
  status: RequestStatus;
  created_at: string;
}

/** Shifts of the people I schedule at clinics I can't see (other companies), from busy_shifts(). */
export interface BusyShifts {
  /** Other employers' records: employer and clinics only (pay and position stay private). */
  employments: { id: string; person_id: string; company_id: string; location_ids: string[] }[];
  shifts: {
    id: string;
    employment_id: string;
    location_id: string;
    week_start: string;
    starts_at: string;
    ends_at: string;
    unpaid_break_minutes: number;
    published: boolean;
  }[];
}
