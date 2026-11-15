/**
 * Database schema — Phase 1 (pilot core).
 *
 * Hierarchy: account → company (legal employer) → location (clinic).
 * People have one profile and one employment per company they work for.
 * Every table carries account_id for tenant isolation (row-level security in the API).
 */
import { sql } from "drizzle-orm";
import {
  bigserial,
  boolean,
  check,
  date,
  doublePrecision,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  primaryKey,
  smallint,
  text,
  time,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

// ---------- Enums ----------

export const province = pgEnum("province", [
  "AB", "BC", "MB", "NB", "NL", "NS", "NT", "NU", "ON", "PE", "QC", "SK", "YT",
]);
export const locale = pgEnum("locale", ["fr-CA", "en-CA"]);
export const scheduleStatus = pgEnum("schedule_status", ["draft", "published"]);
export const shiftStatus = pgEnum("shift_status", ["draft", "published", "confirmed", "declined"]);
export const approvalStatus = pgEnum("approval_status", ["pending", "approved", "rejected"]);
export const punchKind = pgEnum("punch_kind", ["in", "out"]);
export const punchMethod = pgEnum("punch_method", [
  "kiosk_pin", "kiosk_qr_badge", "phone_geofence", "rotating_qr", "nfc", "manual",
]);
export const deviceKind = pgEnum("device_kind", ["kiosk_ipad", "nfc_tag"]);
export const timesheetStatus = pgEnum("timesheet_status", ["open", "flagged", "approved"]);
export const timeOffKind = pgEnum("time_off_kind", ["vacation", "sick", "family", "unpaid", "other"]);
export const accrualMethod = pgEnum("accrual_method", ["none", "per_hour_worked", "annual_grant"]);
export const userRole = pgEnum("user_role", [
  "employee", "clinic_manager", "company_admin", "head_office", "account_owner",
]);

const id = () => uuid("id").primaryKey().default(sql`gen_random_uuid()`);
const accountId = () => uuid("account_id").notNull().references(() => accounts.id, { onDelete: "cascade" });
const createdAt = () => timestamp("created_at", { withTimezone: true }).notNull().defaultNow();

// ---------- Tenancy ----------

export const accounts = pgTable("accounts", {
  id: id(),
  name: text("name").notNull(),
  defaultLocale: locale("default_locale").notNull().default("fr-CA"),
  /** Merge hours across this account's companies for overtime (related employers). */
  combineRelatedCompanyHours: boolean("combine_related_company_hours").notNull().default(false),
  createdAt: createdAt(),
});

export const companies = pgTable("companies", {
  id: id(),
  accountId: accountId(),
  legalName: text("legal_name").notNull(),
  payrollExportFormat: text("payroll_export_format"),
  createdAt: createdAt(),
}, (t) => [index("companies_account_idx").on(t.accountId)]);

export const locations = pgTable("locations", {
  id: id(),
  accountId: accountId(),
  companyId: uuid("company_id").notNull().references(() => companies.id),
  name: text("name").notNull(),
  province: province("province").notNull(),
  timezone: text("timezone").notNull().default("America/Toronto"),
  address: text("address"),
  latitude: doublePrecision("latitude"),
  longitude: doublePrecision("longitude"),
  geofenceRadiusM: integer("geofence_radius_m").notNull().default(150),
  earlyPunchLimitMin: integer("early_punch_limit_min").notNull().default(15),
  /** Auto clock-out this many minutes after the scheduled end. Null = off. */
  autoClockOutAfterMin: integer("auto_clock_out_after_min"),
  createdAt: createdAt(),
}, (t) => [
  index("locations_company_idx").on(t.companyId),
  check("geofence_radius_positive", sql`${t.geofenceRadiusM} > 0`),
]);

export const locationWifiNetworks = pgTable("location_wifi_networks", {
  id: id(),
  accountId: accountId(),
  locationId: uuid("location_id").notNull().references(() => locations.id, { onDelete: "cascade" }),
  ssid: text("ssid").notNull(),
  bssid: text("bssid"),
});

export const devices = pgTable("devices", {
  id: id(),
  accountId: accountId(),
  locationId: uuid("location_id").notNull().references(() => locations.id, { onDelete: "cascade" }),
  kind: deviceKind("kind").notNull(),
  name: text("name").notNull(),
  identifier: text("identifier").notNull(),
  active: boolean("active").notNull().default(true),
}, (t) => [uniqueIndex("devices_identifier_uq").on(t.accountId, t.identifier)]);

// ---------- People and employment ----------

export const persons = pgTable("persons", {
  id: id(),
  accountId: accountId(),
  firstName: text("first_name").notNull(),
  lastName: text("last_name").notNull(),
  email: text("email"),
  phone: text("phone"),
  preferredLocale: locale("preferred_locale").notNull().default("fr-CA"),
  kioskPinHash: text("kiosk_pin_hash"),
  appRole: userRole("app_role").notNull().default("employee"),
  createdAt: createdAt(),
}, (t) => [index("persons_account_idx").on(t.accountId)]);

/** Configurable job roles (receptionist, assistant, podiatrist, orthotic tech…). */
export const jobRoles = pgTable("job_roles", {
  id: id(),
  accountId: accountId(),
  nameFr: text("name_fr").notNull(),
  nameEn: text("name_en").notNull(),
});

export const employments = pgTable("employments", {
  id: id(),
  accountId: accountId(),
  personId: uuid("person_id").notNull().references(() => persons.id, { onDelete: "cascade" }),
  companyId: uuid("company_id").notNull().references(() => companies.id),
  jobRoleId: uuid("job_role_id").references(() => jobRoles.id),
  startDate: date("start_date").notNull(),
  endDate: date("end_date"),
  hourlyRateCents: integer("hourly_rate_cents"),
  desiredWeeklyMinutes: integer("desired_weekly_minutes"),
  minWeeklyMinutes: integer("min_weekly_minutes"),
  maxWeeklyMinutes: integer("max_weekly_minutes"),
  /** Days of notice required before an availability change takes effect. */
  availabilityNoticeDays: integer("availability_notice_days").notNull().default(14),
  createdAt: createdAt(),
}, (t) => [
  uniqueIndex("employments_person_company_uq").on(t.personId, t.companyId, t.startDate),
  check("weekly_minutes_order", sql`${t.minWeeklyMinutes} IS NULL OR ${t.maxWeeklyMinutes} IS NULL OR ${t.minWeeklyMinutes} <= ${t.maxWeeklyMinutes}`),
]);

/** Which clinics an employment may be scheduled at (preferred clinics). */
export const employmentLocations = pgTable("employment_locations", {
  accountId: accountId(),
  employmentId: uuid("employment_id").notNull().references(() => employments.id, { onDelete: "cascade" }),
  locationId: uuid("location_id").notNull().references(() => locations.id, { onDelete: "cascade" }),
  preferred: boolean("preferred").notNull().default(false),
}, (t) => [primaryKey({ columns: [t.employmentId, t.locationId] })]);

// ---------- Availability ----------

export const availabilityRules = pgTable("availability_rules", {
  id: id(),
  accountId: accountId(),
  personId: uuid("person_id").notNull().references(() => persons.id, { onDelete: "cascade" }),
  /** 0 = Monday … 6 = Sunday */
  weekday: smallint("weekday").notNull(),
  startTime: time("start_time").notNull(),
  endTime: time("end_time").notNull(),
  effectiveFrom: date("effective_from").notNull(),
  status: approvalStatus("status").notNull().default("pending"),
}, (t) => [
  check("weekday_range", sql`${t.weekday} BETWEEN 0 AND 6`),
  check("availability_time_order", sql`${t.startTime} < ${t.endTime}`),
]);

export const availabilityExceptions = pgTable("availability_exceptions", {
  id: id(),
  accountId: accountId(),
  personId: uuid("person_id").notNull().references(() => persons.id, { onDelete: "cascade" }),
  date: date("date").notNull(),
  /** Both null = unavailable all day. */
  startTime: time("start_time"),
  endTime: time("end_time"),
  reason: text("reason"),
  status: approvalStatus("status").notNull().default("pending"),
});

// ---------- Scheduling ----------

export const scheduleWeeks = pgTable("schedule_weeks", {
  id: id(),
  accountId: accountId(),
  locationId: uuid("location_id").notNull().references(() => locations.id, { onDelete: "cascade" }),
  /** Monday of the week, in the location's timezone. */
  weekStart: date("week_start").notNull(),
  status: scheduleStatus("status").notNull().default("draft"),
  /** Week this one was copied from, if any. */
  copiedFromId: uuid("copied_from_id"),
  isTemplate: boolean("is_template").notNull().default(false),
  templateName: text("template_name"),
  publishedAt: timestamp("published_at", { withTimezone: true }),
  publishedBy: uuid("published_by").references(() => persons.id),
}, (t) => [uniqueIndex("schedule_weeks_location_week_uq").on(t.locationId, t.weekStart).where(sql`${t.isTemplate} = false`)]);

export const shifts = pgTable("shifts", {
  id: id(),
  accountId: accountId(),
  scheduleWeekId: uuid("schedule_week_id").notNull().references(() => scheduleWeeks.id, { onDelete: "cascade" }),
  locationId: uuid("location_id").notNull().references(() => locations.id),
  /** Null = open shift. */
  employmentId: uuid("employment_id").references(() => employments.id),
  jobRoleId: uuid("job_role_id").references(() => jobRoles.id),
  startsAt: timestamp("starts_at", { withTimezone: true }).notNull(),
  endsAt: timestamp("ends_at", { withTimezone: true }).notNull(),
  unpaidBreakMinutes: integer("unpaid_break_minutes").notNull().default(0),
  status: shiftStatus("status").notNull().default("draft"),
  notes: text("notes"),
  createdAt: createdAt(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index("shifts_employment_time_idx").on(t.employmentId, t.startsAt),
  index("shifts_location_time_idx").on(t.locationId, t.startsAt),
  check("shift_time_order", sql`${t.endsAt} > ${t.startsAt}`),
]);

export const shiftSwapRequests = pgTable("shift_swap_requests", {
  id: id(),
  accountId: accountId(),
  shiftId: uuid("shift_id").notNull().references(() => shifts.id, { onDelete: "cascade" }),
  fromEmploymentId: uuid("from_employment_id").notNull().references(() => employments.id),
  toEmploymentId: uuid("to_employment_id").references(() => employments.id),
  status: approvalStatus("status").notNull().default("pending"),
  createdAt: createdAt(),
});

// ---------- Time clock ----------

export const punches = pgTable("punches", {
  id: id(),
  accountId: accountId(),
  employmentId: uuid("employment_id").notNull().references(() => employments.id),
  locationId: uuid("location_id").notNull().references(() => locations.id),
  kind: punchKind("kind").notNull(),
  method: punchMethod("method").notNull(),
  /** When the punch happened (device time for offline punches). */
  occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull(),
  /** When the server received it. */
  recordedAt: timestamp("recorded_at", { withTimezone: true }).notNull().defaultNow(),
  deviceId: uuid("device_id").references(() => devices.id),
  latitude: doublePrecision("latitude"),
  longitude: doublePrecision("longitude"),
  accuracyM: doublePrecision("accuracy_m"),
  wifiBssid: text("wifi_bssid"),
  mockLocationDetected: boolean("mock_location_detected").notNull().default(false),
  offline: boolean("offline").notNull().default(false),
  photoKey: text("photo_key"),
  /** e.g. outside_geofence, early_punch, clock_drift */
  flags: text("flags").array().notNull().default(sql`ARRAY[]::text[]`),
}, (t) => [index("punches_employment_time_idx").on(t.employmentId, t.occurredAt)]);

export const timesheetEntries = pgTable("timesheet_entries", {
  id: id(),
  accountId: accountId(),
  employmentId: uuid("employment_id").notNull().references(() => employments.id),
  locationId: uuid("location_id").notNull().references(() => locations.id),
  shiftId: uuid("shift_id").references(() => shifts.id),
  clockInPunchId: uuid("clock_in_punch_id").references(() => punches.id),
  clockOutPunchId: uuid("clock_out_punch_id").references(() => punches.id),
  startsAt: timestamp("starts_at", { withTimezone: true }).notNull(),
  endsAt: timestamp("ends_at", { withTimezone: true }),
  breakMinutes: integer("break_minutes").notNull().default(0),
  status: timesheetStatus("status").notNull().default("open"),
  approvedBy: uuid("approved_by").references(() => persons.id),
  approvedAt: timestamp("approved_at", { withTimezone: true }),
}, (t) => [index("timesheet_employment_time_idx").on(t.employmentId, t.startsAt)]);

export const punchCorrectionRequests = pgTable("punch_correction_requests", {
  id: id(),
  accountId: accountId(),
  employmentId: uuid("employment_id").notNull().references(() => employments.id),
  timesheetEntryId: uuid("timesheet_entry_id").references(() => timesheetEntries.id),
  /** What the employee typed, e.g. "forgot to punch out yesterday, left at 5:30". */
  requestText: text("request_text").notNull(),
  proposedStartsAt: timestamp("proposed_starts_at", { withTimezone: true }),
  proposedEndsAt: timestamp("proposed_ends_at", { withTimezone: true }),
  status: approvalStatus("status").notNull().default("pending"),
  reviewedBy: uuid("reviewed_by").references(() => persons.id),
  reviewedAt: timestamp("reviewed_at", { withTimezone: true }),
  createdAt: createdAt(),
});

// ---------- Time off ----------

export const timeOffPolicies = pgTable("time_off_policies", {
  id: id(),
  accountId: accountId(),
  companyId: uuid("company_id").notNull().references(() => companies.id),
  name: text("name").notNull(),
  kind: timeOffKind("kind").notNull(),
  accrualMethod: accrualMethod("accrual_method").notNull().default("none"),
  /** Minutes accrued per hour worked, or minutes granted per year. */
  accrualRate: doublePrecision("accrual_rate"),
  carryoverLimitMinutes: integer("carryover_limit_minutes"),
});

export const timeOffBalances = pgTable("time_off_balances", {
  id: id(),
  accountId: accountId(),
  employmentId: uuid("employment_id").notNull().references(() => employments.id, { onDelete: "cascade" }),
  policyId: uuid("policy_id").notNull().references(() => timeOffPolicies.id),
  balanceMinutes: integer("balance_minutes").notNull().default(0),
  asOf: date("as_of").notNull(),
}, (t) => [uniqueIndex("time_off_balance_uq").on(t.employmentId, t.policyId)]);

export const timeOffRequests = pgTable("time_off_requests", {
  id: id(),
  accountId: accountId(),
  employmentId: uuid("employment_id").notNull().references(() => employments.id),
  policyId: uuid("policy_id").notNull().references(() => timeOffPolicies.id),
  startsAt: timestamp("starts_at", { withTimezone: true }).notNull(),
  endsAt: timestamp("ends_at", { withTimezone: true }).notNull(),
  minutes: integer("minutes").notNull(),
  status: approvalStatus("status").notNull().default("pending"),
  reviewedBy: uuid("reviewed_by").references(() => persons.id),
  reviewedAt: timestamp("reviewed_at", { withTimezone: true }),
  createdAt: createdAt(),
}, (t) => [check("time_off_time_order", sql`${t.endsAt} > ${t.startsAt}`)]);

// ---------- Credentials (medical) ----------

/** Configurable per profession: OPQ licence, CCO registration, CPR, WHMIS, liability insurance… */
export const credentialTypes = pgTable("credential_types", {
  id: id(),
  accountId: accountId(),
  nameFr: text("name_fr").notNull(),
  nameEn: text("name_en").notNull(),
  profession: text("profession"),
  requiresExpiry: boolean("requires_expiry").notNull().default(true),
  blocksSchedulingWhenExpired: boolean("blocks_scheduling_when_expired").notNull().default(false),
  alertDaysBeforeExpiry: integer("alert_days_before_expiry").notNull().default(60),
});

export const credentials = pgTable("credentials", {
  id: id(),
  accountId: accountId(),
  personId: uuid("person_id").notNull().references(() => persons.id, { onDelete: "cascade" }),
  credentialTypeId: uuid("credential_type_id").notNull().references(() => credentialTypes.id),
  number: text("number"),
  issuedOn: date("issued_on"),
  expiresOn: date("expires_on"),
  documentKey: text("document_key"),
  status: approvalStatus("status").notNull().default("pending"),
}, (t) => [index("credentials_expiry_idx").on(t.expiresOn)]);

// ---------- Documents and announcements ----------

export const documents = pgTable("documents", {
  id: id(),
  accountId: accountId(),
  companyId: uuid("company_id").references(() => companies.id),
  /** Null = document for everyone in scope; set = a personal document. */
  personId: uuid("person_id").references(() => persons.id, { onDelete: "cascade" }),
  title: text("title").notNull(),
  locale: locale("locale").notNull().default("fr-CA"),
  fileKey: text("file_key").notNull(),
  requiresSignature: boolean("requires_signature").notNull().default(false),
  expiresOn: date("expires_on"),
  createdAt: createdAt(),
});

export const documentAcknowledgements = pgTable("document_acknowledgements", {
  accountId: accountId(),
  documentId: uuid("document_id").notNull().references(() => documents.id, { onDelete: "cascade" }),
  personId: uuid("person_id").notNull().references(() => persons.id, { onDelete: "cascade" }),
  acknowledgedAt: timestamp("acknowledged_at", { withTimezone: true }).notNull().defaultNow(),
  signatureRef: text("signature_ref"),
}, (t) => [primaryKey({ columns: [t.documentId, t.personId] })]);

export const announcements = pgTable("announcements", {
  id: id(),
  accountId: accountId(),
  authorId: uuid("author_id").notNull().references(() => persons.id),
  titleFr: text("title_fr").notNull(),
  titleEn: text("title_en"),
  bodyFr: text("body_fr").notNull(),
  bodyEn: text("body_en"),
  requiresReadConfirmation: boolean("requires_read_confirmation").notNull().default(false),
  /** Smart-group filter, e.g. {"locationIds": [...], "jobRoleIds": [...]} */
  audience: jsonb("audience").notNull().default(sql`'{}'::jsonb`),
  publishAt: timestamp("publish_at", { withTimezone: true }).notNull().defaultNow(),
});

export const announcementReads = pgTable("announcement_reads", {
  accountId: accountId(),
  announcementId: uuid("announcement_id").notNull().references(() => announcements.id, { onDelete: "cascade" }),
  personId: uuid("person_id").notNull().references(() => persons.id, { onDelete: "cascade" }),
  readAt: timestamp("read_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [primaryKey({ columns: [t.announcementId, t.personId] })]);

// ---------- Audit ----------

export const auditLog = pgTable("audit_log", {
  id: bigserial("id", { mode: "number" }).primaryKey(),
  accountId: accountId(),
  actorPersonId: uuid("actor_person_id").references(() => persons.id),
  action: text("action").notNull(),
  entity: text("entity").notNull(),
  entityId: text("entity_id"),
  before: jsonb("before"),
  after: jsonb("after"),
  at: timestamp("at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [index("audit_account_time_idx").on(t.accountId, t.at)]);
