CREATE TYPE "public"."accrual_method" AS ENUM('none', 'per_hour_worked', 'annual_grant');--> statement-breakpoint
CREATE TYPE "public"."approval_status" AS ENUM('pending', 'approved', 'rejected');--> statement-breakpoint
CREATE TYPE "public"."device_kind" AS ENUM('kiosk_ipad', 'nfc_tag');--> statement-breakpoint
CREATE TYPE "public"."locale" AS ENUM('fr-CA', 'en-CA');--> statement-breakpoint
CREATE TYPE "public"."province" AS ENUM('AB', 'BC', 'MB', 'NB', 'NL', 'NS', 'NT', 'NU', 'ON', 'PE', 'QC', 'SK', 'YT');--> statement-breakpoint
CREATE TYPE "public"."punch_kind" AS ENUM('in', 'out');--> statement-breakpoint
CREATE TYPE "public"."punch_method" AS ENUM('kiosk_pin', 'kiosk_qr_badge', 'phone_geofence', 'rotating_qr', 'nfc', 'manual');--> statement-breakpoint
CREATE TYPE "public"."schedule_status" AS ENUM('draft', 'published');--> statement-breakpoint
CREATE TYPE "public"."shift_status" AS ENUM('draft', 'published', 'confirmed', 'declined');--> statement-breakpoint
CREATE TYPE "public"."time_off_kind" AS ENUM('vacation', 'sick', 'family', 'unpaid', 'other');--> statement-breakpoint
CREATE TYPE "public"."timesheet_status" AS ENUM('open', 'flagged', 'approved');--> statement-breakpoint
CREATE TYPE "public"."user_role" AS ENUM('employee', 'clinic_manager', 'company_admin', 'head_office', 'account_owner');--> statement-breakpoint
CREATE TABLE "accounts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"default_locale" "locale" DEFAULT 'fr-CA' NOT NULL,
	"combine_related_company_hours" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "announcement_reads" (
	"account_id" uuid NOT NULL,
	"announcement_id" uuid NOT NULL,
	"person_id" uuid NOT NULL,
	"read_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "announcement_reads_announcement_id_person_id_pk" PRIMARY KEY("announcement_id","person_id")
);
--> statement-breakpoint
CREATE TABLE "announcements" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"author_id" uuid NOT NULL,
	"title_fr" text NOT NULL,
	"title_en" text,
	"body_fr" text NOT NULL,
	"body_en" text,
	"requires_read_confirmation" boolean DEFAULT false NOT NULL,
	"audience" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"publish_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "audit_log" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"account_id" uuid NOT NULL,
	"actor_person_id" uuid,
	"action" text NOT NULL,
	"entity" text NOT NULL,
	"entity_id" text,
	"before" jsonb,
	"after" jsonb,
	"at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "availability_exceptions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"person_id" uuid NOT NULL,
	"date" date NOT NULL,
	"start_time" time,
	"end_time" time,
	"reason" text,
	"status" "approval_status" DEFAULT 'pending' NOT NULL
);
--> statement-breakpoint
CREATE TABLE "availability_rules" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"person_id" uuid NOT NULL,
	"weekday" smallint NOT NULL,
	"start_time" time NOT NULL,
	"end_time" time NOT NULL,
	"effective_from" date NOT NULL,
	"status" "approval_status" DEFAULT 'pending' NOT NULL,
	CONSTRAINT "weekday_range" CHECK ("availability_rules"."weekday" BETWEEN 0 AND 6),
	CONSTRAINT "availability_time_order" CHECK ("availability_rules"."start_time" < "availability_rules"."end_time")
);
--> statement-breakpoint
CREATE TABLE "companies" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"legal_name" text NOT NULL,
	"payroll_export_format" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "credential_types" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"name_fr" text NOT NULL,
	"name_en" text NOT NULL,
	"profession" text,
	"requires_expiry" boolean DEFAULT true NOT NULL,
	"blocks_scheduling_when_expired" boolean DEFAULT false NOT NULL,
	"alert_days_before_expiry" integer DEFAULT 60 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "credentials" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"person_id" uuid NOT NULL,
	"credential_type_id" uuid NOT NULL,
	"number" text,
	"issued_on" date,
	"expires_on" date,
	"document_key" text,
	"status" "approval_status" DEFAULT 'pending' NOT NULL
);
--> statement-breakpoint
CREATE TABLE "devices" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"location_id" uuid NOT NULL,
	"kind" "device_kind" NOT NULL,
	"name" text NOT NULL,
	"identifier" text NOT NULL,
	"active" boolean DEFAULT true NOT NULL
);
--> statement-breakpoint
CREATE TABLE "document_acknowledgements" (
	"account_id" uuid NOT NULL,
	"document_id" uuid NOT NULL,
	"person_id" uuid NOT NULL,
	"acknowledged_at" timestamp with time zone DEFAULT now() NOT NULL,
	"signature_ref" text,
	CONSTRAINT "document_acknowledgements_document_id_person_id_pk" PRIMARY KEY("document_id","person_id")
);
--> statement-breakpoint
CREATE TABLE "documents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"company_id" uuid,
	"person_id" uuid,
	"title" text NOT NULL,
	"locale" "locale" DEFAULT 'fr-CA' NOT NULL,
	"file_key" text NOT NULL,
	"requires_signature" boolean DEFAULT false NOT NULL,
	"expires_on" date,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "employment_locations" (
	"account_id" uuid NOT NULL,
	"employment_id" uuid NOT NULL,
	"location_id" uuid NOT NULL,
	"preferred" boolean DEFAULT false NOT NULL,
	CONSTRAINT "employment_locations_employment_id_location_id_pk" PRIMARY KEY("employment_id","location_id")
);
--> statement-breakpoint
CREATE TABLE "employments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"person_id" uuid NOT NULL,
	"company_id" uuid NOT NULL,
	"job_role_id" uuid,
	"start_date" date NOT NULL,
	"end_date" date,
	"hourly_rate_cents" integer,
	"desired_weekly_minutes" integer,
	"min_weekly_minutes" integer,
	"max_weekly_minutes" integer,
	"availability_notice_days" integer DEFAULT 14 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "weekly_minutes_order" CHECK ("employments"."min_weekly_minutes" IS NULL OR "employments"."max_weekly_minutes" IS NULL OR "employments"."min_weekly_minutes" <= "employments"."max_weekly_minutes")
);
--> statement-breakpoint
CREATE TABLE "job_roles" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"name_fr" text NOT NULL,
	"name_en" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "location_wifi_networks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"location_id" uuid NOT NULL,
	"ssid" text NOT NULL,
	"bssid" text
);
--> statement-breakpoint
CREATE TABLE "locations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"company_id" uuid NOT NULL,
	"name" text NOT NULL,
	"province" "province" NOT NULL,
	"timezone" text DEFAULT 'America/Toronto' NOT NULL,
	"address" text,
	"latitude" double precision,
	"longitude" double precision,
	"geofence_radius_m" integer DEFAULT 150 NOT NULL,
	"early_punch_limit_min" integer DEFAULT 15 NOT NULL,
	"auto_clock_out_after_min" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "geofence_radius_positive" CHECK ("locations"."geofence_radius_m" > 0)
);
--> statement-breakpoint
CREATE TABLE "persons" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"first_name" text NOT NULL,
	"last_name" text NOT NULL,
	"email" text,
	"phone" text,
	"preferred_locale" "locale" DEFAULT 'fr-CA' NOT NULL,
	"kiosk_pin_hash" text,
	"app_role" "user_role" DEFAULT 'employee' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "punch_correction_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"employment_id" uuid NOT NULL,
	"timesheet_entry_id" uuid,
	"request_text" text NOT NULL,
	"proposed_starts_at" timestamp with time zone,
	"proposed_ends_at" timestamp with time zone,
	"status" "approval_status" DEFAULT 'pending' NOT NULL,
	"reviewed_by" uuid,
	"reviewed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "punches" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"employment_id" uuid NOT NULL,
	"location_id" uuid NOT NULL,
	"kind" "punch_kind" NOT NULL,
	"method" "punch_method" NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	"device_id" uuid,
	"latitude" double precision,
	"longitude" double precision,
	"accuracy_m" double precision,
	"wifi_bssid" text,
	"mock_location_detected" boolean DEFAULT false NOT NULL,
	"offline" boolean DEFAULT false NOT NULL,
	"photo_key" text,
	"flags" text[] DEFAULT ARRAY[]::text[] NOT NULL
);
--> statement-breakpoint
CREATE TABLE "schedule_weeks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"location_id" uuid NOT NULL,
	"week_start" date NOT NULL,
	"status" "schedule_status" DEFAULT 'draft' NOT NULL,
	"copied_from_id" uuid,
	"is_template" boolean DEFAULT false NOT NULL,
	"template_name" text,
	"published_at" timestamp with time zone,
	"published_by" uuid
);
--> statement-breakpoint
CREATE TABLE "shift_swap_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"shift_id" uuid NOT NULL,
	"from_employment_id" uuid NOT NULL,
	"to_employment_id" uuid,
	"status" "approval_status" DEFAULT 'pending' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "shifts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"schedule_week_id" uuid NOT NULL,
	"location_id" uuid NOT NULL,
	"employment_id" uuid,
	"job_role_id" uuid,
	"starts_at" timestamp with time zone NOT NULL,
	"ends_at" timestamp with time zone NOT NULL,
	"unpaid_break_minutes" integer DEFAULT 0 NOT NULL,
	"status" "shift_status" DEFAULT 'draft' NOT NULL,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "shift_time_order" CHECK ("shifts"."ends_at" > "shifts"."starts_at")
);
--> statement-breakpoint
CREATE TABLE "time_off_balances" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"employment_id" uuid NOT NULL,
	"policy_id" uuid NOT NULL,
	"balance_minutes" integer DEFAULT 0 NOT NULL,
	"as_of" date NOT NULL
);
--> statement-breakpoint
CREATE TABLE "time_off_policies" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"company_id" uuid NOT NULL,
	"name" text NOT NULL,
	"kind" time_off_kind NOT NULL,
	"accrual_method" "accrual_method" DEFAULT 'none' NOT NULL,
	"accrual_rate" double precision,
	"carryover_limit_minutes" integer
);
--> statement-breakpoint
CREATE TABLE "time_off_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"employment_id" uuid NOT NULL,
	"policy_id" uuid NOT NULL,
	"starts_at" timestamp with time zone NOT NULL,
	"ends_at" timestamp with time zone NOT NULL,
	"minutes" integer NOT NULL,
	"status" "approval_status" DEFAULT 'pending' NOT NULL,
	"reviewed_by" uuid,
	"reviewed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "time_off_time_order" CHECK ("time_off_requests"."ends_at" > "time_off_requests"."starts_at")
);
--> statement-breakpoint
CREATE TABLE "timesheet_entries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"employment_id" uuid NOT NULL,
	"location_id" uuid NOT NULL,
	"shift_id" uuid,
	"clock_in_punch_id" uuid,
	"clock_out_punch_id" uuid,
	"starts_at" timestamp with time zone NOT NULL,
	"ends_at" timestamp with time zone,
	"break_minutes" integer DEFAULT 0 NOT NULL,
	"status" timesheet_status DEFAULT 'open' NOT NULL,
	"approved_by" uuid,
	"approved_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "announcement_reads" ADD CONSTRAINT "announcement_reads_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "announcement_reads" ADD CONSTRAINT "announcement_reads_announcement_id_announcements_id_fk" FOREIGN KEY ("announcement_id") REFERENCES "public"."announcements"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "announcement_reads" ADD CONSTRAINT "announcement_reads_person_id_persons_id_fk" FOREIGN KEY ("person_id") REFERENCES "public"."persons"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "announcements" ADD CONSTRAINT "announcements_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "announcements" ADD CONSTRAINT "announcements_author_id_persons_id_fk" FOREIGN KEY ("author_id") REFERENCES "public"."persons"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_actor_person_id_persons_id_fk" FOREIGN KEY ("actor_person_id") REFERENCES "public"."persons"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "availability_exceptions" ADD CONSTRAINT "availability_exceptions_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "availability_exceptions" ADD CONSTRAINT "availability_exceptions_person_id_persons_id_fk" FOREIGN KEY ("person_id") REFERENCES "public"."persons"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "availability_rules" ADD CONSTRAINT "availability_rules_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "availability_rules" ADD CONSTRAINT "availability_rules_person_id_persons_id_fk" FOREIGN KEY ("person_id") REFERENCES "public"."persons"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "companies" ADD CONSTRAINT "companies_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credential_types" ADD CONSTRAINT "credential_types_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credentials" ADD CONSTRAINT "credentials_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credentials" ADD CONSTRAINT "credentials_person_id_persons_id_fk" FOREIGN KEY ("person_id") REFERENCES "public"."persons"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credentials" ADD CONSTRAINT "credentials_credential_type_id_credential_types_id_fk" FOREIGN KEY ("credential_type_id") REFERENCES "public"."credential_types"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "devices" ADD CONSTRAINT "devices_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "devices" ADD CONSTRAINT "devices_location_id_locations_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."locations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_acknowledgements" ADD CONSTRAINT "document_acknowledgements_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_acknowledgements" ADD CONSTRAINT "document_acknowledgements_document_id_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."documents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_acknowledgements" ADD CONSTRAINT "document_acknowledgements_person_id_persons_id_fk" FOREIGN KEY ("person_id") REFERENCES "public"."persons"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "documents" ADD CONSTRAINT "documents_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "documents" ADD CONSTRAINT "documents_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "documents" ADD CONSTRAINT "documents_person_id_persons_id_fk" FOREIGN KEY ("person_id") REFERENCES "public"."persons"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "employment_locations" ADD CONSTRAINT "employment_locations_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "employment_locations" ADD CONSTRAINT "employment_locations_employment_id_employments_id_fk" FOREIGN KEY ("employment_id") REFERENCES "public"."employments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "employment_locations" ADD CONSTRAINT "employment_locations_location_id_locations_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."locations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "employments" ADD CONSTRAINT "employments_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "employments" ADD CONSTRAINT "employments_person_id_persons_id_fk" FOREIGN KEY ("person_id") REFERENCES "public"."persons"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "employments" ADD CONSTRAINT "employments_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "employments" ADD CONSTRAINT "employments_job_role_id_job_roles_id_fk" FOREIGN KEY ("job_role_id") REFERENCES "public"."job_roles"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_roles" ADD CONSTRAINT "job_roles_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "location_wifi_networks" ADD CONSTRAINT "location_wifi_networks_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "location_wifi_networks" ADD CONSTRAINT "location_wifi_networks_location_id_locations_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."locations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "locations" ADD CONSTRAINT "locations_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "locations" ADD CONSTRAINT "locations_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "persons" ADD CONSTRAINT "persons_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "punch_correction_requests" ADD CONSTRAINT "punch_correction_requests_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "punch_correction_requests" ADD CONSTRAINT "punch_correction_requests_employment_id_employments_id_fk" FOREIGN KEY ("employment_id") REFERENCES "public"."employments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "punch_correction_requests" ADD CONSTRAINT "punch_correction_requests_timesheet_entry_id_timesheet_entries_id_fk" FOREIGN KEY ("timesheet_entry_id") REFERENCES "public"."timesheet_entries"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "punch_correction_requests" ADD CONSTRAINT "punch_correction_requests_reviewed_by_persons_id_fk" FOREIGN KEY ("reviewed_by") REFERENCES "public"."persons"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "punches" ADD CONSTRAINT "punches_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "punches" ADD CONSTRAINT "punches_employment_id_employments_id_fk" FOREIGN KEY ("employment_id") REFERENCES "public"."employments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "punches" ADD CONSTRAINT "punches_location_id_locations_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."locations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "punches" ADD CONSTRAINT "punches_device_id_devices_id_fk" FOREIGN KEY ("device_id") REFERENCES "public"."devices"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "schedule_weeks" ADD CONSTRAINT "schedule_weeks_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "schedule_weeks" ADD CONSTRAINT "schedule_weeks_location_id_locations_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."locations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "schedule_weeks" ADD CONSTRAINT "schedule_weeks_published_by_persons_id_fk" FOREIGN KEY ("published_by") REFERENCES "public"."persons"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shift_swap_requests" ADD CONSTRAINT "shift_swap_requests_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shift_swap_requests" ADD CONSTRAINT "shift_swap_requests_shift_id_shifts_id_fk" FOREIGN KEY ("shift_id") REFERENCES "public"."shifts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shift_swap_requests" ADD CONSTRAINT "shift_swap_requests_from_employment_id_employments_id_fk" FOREIGN KEY ("from_employment_id") REFERENCES "public"."employments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shift_swap_requests" ADD CONSTRAINT "shift_swap_requests_to_employment_id_employments_id_fk" FOREIGN KEY ("to_employment_id") REFERENCES "public"."employments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shifts" ADD CONSTRAINT "shifts_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shifts" ADD CONSTRAINT "shifts_schedule_week_id_schedule_weeks_id_fk" FOREIGN KEY ("schedule_week_id") REFERENCES "public"."schedule_weeks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shifts" ADD CONSTRAINT "shifts_location_id_locations_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."locations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shifts" ADD CONSTRAINT "shifts_employment_id_employments_id_fk" FOREIGN KEY ("employment_id") REFERENCES "public"."employments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shifts" ADD CONSTRAINT "shifts_job_role_id_job_roles_id_fk" FOREIGN KEY ("job_role_id") REFERENCES "public"."job_roles"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "time_off_balances" ADD CONSTRAINT "time_off_balances_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "time_off_balances" ADD CONSTRAINT "time_off_balances_employment_id_employments_id_fk" FOREIGN KEY ("employment_id") REFERENCES "public"."employments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "time_off_balances" ADD CONSTRAINT "time_off_balances_policy_id_time_off_policies_id_fk" FOREIGN KEY ("policy_id") REFERENCES "public"."time_off_policies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "time_off_policies" ADD CONSTRAINT "time_off_policies_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "time_off_policies" ADD CONSTRAINT "time_off_policies_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "time_off_requests" ADD CONSTRAINT "time_off_requests_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "time_off_requests" ADD CONSTRAINT "time_off_requests_employment_id_employments_id_fk" FOREIGN KEY ("employment_id") REFERENCES "public"."employments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "time_off_requests" ADD CONSTRAINT "time_off_requests_policy_id_time_off_policies_id_fk" FOREIGN KEY ("policy_id") REFERENCES "public"."time_off_policies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "time_off_requests" ADD CONSTRAINT "time_off_requests_reviewed_by_persons_id_fk" FOREIGN KEY ("reviewed_by") REFERENCES "public"."persons"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "timesheet_entries" ADD CONSTRAINT "timesheet_entries_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "timesheet_entries" ADD CONSTRAINT "timesheet_entries_employment_id_employments_id_fk" FOREIGN KEY ("employment_id") REFERENCES "public"."employments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "timesheet_entries" ADD CONSTRAINT "timesheet_entries_location_id_locations_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."locations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "timesheet_entries" ADD CONSTRAINT "timesheet_entries_shift_id_shifts_id_fk" FOREIGN KEY ("shift_id") REFERENCES "public"."shifts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "timesheet_entries" ADD CONSTRAINT "timesheet_entries_clock_in_punch_id_punches_id_fk" FOREIGN KEY ("clock_in_punch_id") REFERENCES "public"."punches"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "timesheet_entries" ADD CONSTRAINT "timesheet_entries_clock_out_punch_id_punches_id_fk" FOREIGN KEY ("clock_out_punch_id") REFERENCES "public"."punches"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "timesheet_entries" ADD CONSTRAINT "timesheet_entries_approved_by_persons_id_fk" FOREIGN KEY ("approved_by") REFERENCES "public"."persons"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "audit_account_time_idx" ON "audit_log" USING btree ("account_id","at");--> statement-breakpoint
CREATE INDEX "companies_account_idx" ON "companies" USING btree ("account_id");--> statement-breakpoint
CREATE INDEX "credentials_expiry_idx" ON "credentials" USING btree ("expires_on");--> statement-breakpoint
CREATE UNIQUE INDEX "devices_identifier_uq" ON "devices" USING btree ("account_id","identifier");--> statement-breakpoint
CREATE UNIQUE INDEX "employments_person_company_uq" ON "employments" USING btree ("person_id","company_id","start_date");--> statement-breakpoint
CREATE INDEX "locations_company_idx" ON "locations" USING btree ("company_id");--> statement-breakpoint
CREATE INDEX "persons_account_idx" ON "persons" USING btree ("account_id");--> statement-breakpoint
CREATE INDEX "punches_employment_time_idx" ON "punches" USING btree ("employment_id","occurred_at");--> statement-breakpoint
CREATE UNIQUE INDEX "schedule_weeks_location_week_uq" ON "schedule_weeks" USING btree ("location_id","week_start") WHERE "schedule_weeks"."is_template" = false;--> statement-breakpoint
CREATE INDEX "shifts_employment_time_idx" ON "shifts" USING btree ("employment_id","starts_at");--> statement-breakpoint
CREATE INDEX "shifts_location_time_idx" ON "shifts" USING btree ("location_id","starts_at");--> statement-breakpoint
CREATE UNIQUE INDEX "time_off_balance_uq" ON "time_off_balances" USING btree ("employment_id","policy_id");--> statement-breakpoint
CREATE INDEX "timesheet_employment_time_idx" ON "timesheet_entries" USING btree ("employment_id","starts_at");