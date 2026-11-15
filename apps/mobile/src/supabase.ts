import "react-native-url-polyfill/auto";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { createClient } from "@supabase/supabase-js";
import { AppState } from "react-native";

// Public values (safe to ship). Data is protected by row-level security on the server.
const SUPABASE_URL = "https://tmxnbqjlagsyoujppkpb.supabase.co";
const SUPABASE_PUBLISHABLE_KEY = "sb_publishable_LCXXQ4bJc_tu0U6Xiq4Rrw_5BLjdmpJ";

export const supabase = createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, {
  auth: {
    storage: AsyncStorage,
    persistSession: true,
    autoRefreshToken: true,
    detectSessionInUrl: false,
  },
});

// Refresh the login only while the app is in the foreground.
AppState.addEventListener("change", (state) => {
  if (state === "active") supabase.auth.startAutoRefresh();
  else supabase.auth.stopAutoRefresh();
});

export interface Person {
  id: string;
  account_id: string;
  first_name: string;
  last_name: string;
  email: string | null;
}

export interface Location {
  id: string;
  company_id: string;
  name: string;
  province: string;
  timezone: string;
  latitude: number | null;
  longitude: number | null;
  geofence_radius_m: number;
  early_punch_limit_min: number;
}

export interface Employment {
  id: string;
  company_id: string;
  employment_locations: { location_id: string }[];
}

export interface RoleAssignment {
  role: "owner" | "company_admin" | "clinic_manager";
  company_id: string | null;
  location_id: string | null;
}

export interface Shift {
  id: string;
  location_id: string;
  employment_id: string | null;
  starts_at: string;
  ends_at: string;
  unpaid_break_minutes: number;
  response: "pending" | "confirmed" | "declined";
}

export interface Punch {
  id: string;
  location_id: string;
  kind: "in" | "out";
  method: "phone_geofence" | "rotating_qr" | "kiosk_pin" | "manual";
  occurred_at: string;
  flags: string[];
}

export interface PunchResult {
  accepted: boolean;
  reason?: string;
  kind?: "in" | "out";
  occurred_at?: string;
  flags?: string[];
  distance_m?: number;
  radius_m?: number;
  opens_in_min?: number;
  first_name?: string;
}
