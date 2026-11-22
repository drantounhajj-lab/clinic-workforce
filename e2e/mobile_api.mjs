// Runs every query and server function the phone app uses, as real users, against the local backend.
import { createClient } from "@supabase/supabase-js";

const URL_ = "http://localhost:54321";
const problems = [];
const memory = () => {
  const m = new Map();
  return { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => m.set(k, v), removeItem: (k) => m.delete(k) };
};
async function client(email) {
  const sb = createClient(URL_, "local-anon", { auth: { storage: memory(), persistSession: true, autoRefreshToken: false } });
  if (email) {
    const a = await sb.auth.signInWithOtp({ email });
    if (a.error) problems.push(`otp ${email}: ${a.error.message}`);
    const v = await sb.auth.verifyOtp({ email, token: "123456", type: "email" });
    if (v.error) problems.push(`verify ${email}: ${v.error.message}`);
  }
  return sb;
}
async function check(label, p, expectOk = true) {
  const { data, error } = await p;
  if (error) problems.push(`${label}: ${error.message}`);
  else if (expectOk && data && typeof data === "object" && "ok" in data && !data.ok && !("accepted" in data)) problems.push(`${label}: ok=false ${JSON.stringify(data)}`);
  else if (data && typeof data === "object" && "accepted" in data && !data.accepted && expectOk) problems.push(`${label}: refused ${JSON.stringify(data)}`);
  console.log(`  ${error ? "✗" : "✓"} ${label}${error ? "" : `: ${JSON.stringify(data)?.slice(0, 140)}`}`);
  return data;
}

// ---- Marie, employee
const sb = await client("marie@example.com");
console.log("Marie (employee)");
const { data: { user } } = await sb.auth.getUser();
const me = (await check("persons me", sb.from("persons").select("*").eq("user_id", user.id).maybeSingle()));
const emps = await check("employments", sb.from("employments").select("id, company_id, job_role_id, employment_locations(location_id)").eq("person_id", me.id));
await check("locations", sb.from("locations").select("id, company_id, name, province, timezone, address, latitude, longitude, geofence_radius_m, early_punch_limit_min").order("name"));
await check("role_assignments", sb.from("role_assignments").select("role, company_id, location_id").eq("person_id", me.id));
await check("custom roles", sb.from("custom_role_assignments").select("location_id, custom_roles(name, permissions)").eq("person_id", me.id));
await check("job_roles", sb.from("job_roles").select("id, name_fr, name_en"));
const empIds = emps.map((e) => e.id);
const locIds = [...new Set(emps.flatMap((e) => e.employment_locations.map((x) => x.location_id)))];
await check("recent punches", sb.from("punches").select("id, location_id, kind, method, occurred_at, flags").eq("person_id", me.id).order("occurred_at", { ascending: false }).limit(12));
await check("next shift", sb.from("shifts").select("*").in("employment_id", empIds).gt("ends_at", new Date().toISOString()).neq("response", "declined").order("starts_at").limit(1));
const upcoming = await check("upcoming shifts", sb.from("shifts").select("*").in("employment_id", empIds).gt("ends_at", new Date().toISOString()).lt("starts_at", new Date(Date.now() + 56 * 864e5).toISOString()).order("starts_at"));
await check("published weeks", sb.from("schedule_weeks").select("location_id, week_start").eq("status", "published").in("location_id", locIds));
await check("my_swaps", sb.rpc("my_swaps"));
const open = await check("open shifts", sb.from("shifts").select("*").is("employment_id", null).in("location_id", locIds).gt("starts_at", new Date().toISOString()).order("starts_at").limit(30));
await check("my claims", sb.from("shift_claims").select("shift_id, status"));
await check("time off list", sb.from("time_off_requests").select("*").eq("person_id", me.id).order("start_date", { ascending: false }).limit(20));
await check("availability", sb.from("availability_rules").select("weekday, start_time, end_time, status").eq("person_id", me.id));
await check("corrections", sb.from("punch_corrections").select("id, location_id, kind, occurred_at, status, manager_note").eq("person_id", me.id).order("created_at", { ascending: false }).limit(10));
await check("has_pin", sb.rpc("has_pin"));
await check("set_my_pin", sb.rpc("set_my_pin", { p_pin: "4827" }));
await check("set_my_locale", sb.rpc("set_my_locale", { p_locale: "fr-CA" }));
await check("register_push_token", sb.rpc("register_push_token", { p_token: "ExponentPushToken[marie1234567890]", p_platform: "ios" }));
await check("punch_with_location (far away, refused expected)", sb.rpc("punch_with_location", { p_location_id: locIds[0], p_latitude: 45.0, p_longitude: -75.0, p_accuracy_m: 10, p_wifi_bssid: null, p_mocked: false }), false);
await check("punch_with_location (at clinic)", sb.rpc("punch_with_location", { p_location_id: locIds[0], p_latitude: 45.4765, p_longitude: -75.7013, p_accuracy_m: 10, p_wifi_bssid: null, p_mocked: false }));
await check("request_time_off partial (old app versions)", sb.rpc("request_time_off", { p_type: "personal", p_start: "2026-12-02", p_end: "2026-12-02", p_start_time: "09:00", p_end_time: "11:00", p_note: null }));
const leaveTypes = await check("leave types", sb.from("leave_types").select("id, name_fr, name_en, category").eq("active", true).order("sort"));
await check("request_leave with private reason", sb.rpc("request_leave", { p_leave_type_id: leaveTypes[0].id, p_start: "2026-12-14", p_end: "2026-12-18", p_start_time: null, p_end_time: null, p_reason: "Voyage" }));
await check("my reasons", sb.from("time_off_reasons").select("request_id, reason"));
await check("one-off unavailable range", sb.from("availability_exceptions").insert({ person_id: me.id, date: "2026-12-21", end_date: "2026-12-23", kind: "unavailable" }));
await check("one-off extra availability", sb.from("availability_exceptions").insert({ person_id: me.id, date: "2026-12-26", start_time: "09:00", end_time: "13:00", kind: "available" }));
await check("my one-offs", sb.from("availability_exceptions").select("*").eq("person_id", me.id));
await check("my_offers", sb.rpc("my_offers"));
await check("delete pending availability", sb.from("availability_rules").delete().eq("person_id", me.id).eq("status", "pending"));
await check("insert availability (alternating weeks, effective dates, clinics)", sb.from("availability_rules").insert([
  { person_id: me.id, weekday: 1, start_time: "09:00", end_time: "17:00", effective_from: "2026-12-07", every_weeks: 2, anchor_week: "2026-12-07", location_ids: locIds.slice(0, 1) },
  { person_id: me.id, weekday: 3, start_time: "00:00", end_time: "23:59", effective_from: "2026-12-07", kind: "unavailable" },
], { defaultToNull: false }));
await check("request_punch_correction", sb.rpc("request_punch_correction", { p_location_id: locIds[0], p_kind: "out", p_occurred_at: new Date(Date.now() - 3 * 3600e3).toISOString(), p_reason: "Forgot" }));
const future = upcoming.find((s) => Date.parse(s.starts_at) > Date.now());
if (future) {
  await check("respond_to_shift confirmed", sb.rpc("respond_to_shift", { p_shift_id: future.id, p_response: "confirmed" }), false);
  const cands = await check("swap_candidates", sb.rpc("swap_candidates", { p_shift_id: future.id }), false);
  console.log("    colleagues:", cands?.colleagues?.map((c) => c.first_name));
}
if (open?.length) await check("claim_open_shift", sb.rpc("claim_open_shift", { p_shift_id: open[0].id }), false);
await check("unregister_push_token", sb.rpc("unregister_push_token", { p_token: "ExponentPushToken[marie1234567890]" }));

// ---- Tony on the phone (manager tools)
console.log("Tony (manager tools)");
const t = await client("tony@example.com");
await check("update clinic position", t.from("locations").update({ latitude: 45.4766, longitude: -75.7012 }).eq("id", locIds[0]));
await check("add wifi", t.from("location_wifi").upsert({ location_id: locIds[0], ssid: "Clinique", bssid: "aa:bb:cc:dd:ee:ff" }, { onConflict: "location_id,bssid", ignoreDuplicates: true }));
await check("add wifi again (no duplicate)", t.from("location_wifi").upsert({ location_id: locIds[0], ssid: "Clinique", bssid: "aa:bb:cc:dd:ee:ff" }, { onConflict: "location_id,bssid", ignoreDuplicates: true }));

// ---- Clinic iPad
console.log("iPad (kiosk)");
const k = createClient(URL_, "local-anon", { auth: { storage: memory(), autoRefreshToken: false } });
await check("anonymous sign-in", k.auth.signInAnonymously());
const pair = await check("kiosk_request_pairing", k.rpc("kiosk_request_pairing"));
await check("kiosk_me before", k.rpc("kiosk_me"), false);
await check("kiosk_approve_pairing (manager)", t.rpc("kiosk_approve_pairing", { p_code: pair.code, p_location_id: locIds[0], p_name: "iPad accueil" }));
await check("kiosk_me after", k.rpc("kiosk_me"));
const code = await check("kiosk_current_code", k.rpc("kiosk_current_code", { p_location_id: locIds[0] }));
await check("kiosk_punch wrong PIN", k.rpc("kiosk_punch", { p_pin: "0000" }), false);
await check("kiosk_punch Marie's PIN", k.rpc("kiosk_punch", { p_pin: "4827" }));
await check("punch_with_qr (Marie)", sb.rpc("punch_with_qr", { p_location_id: locIds[0], p_code: code.code }));

console.log(`\n${problems.length} problem(s)`);
for (const p of problems) console.log("  -", p);
