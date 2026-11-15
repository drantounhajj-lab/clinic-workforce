-- Clinic Workforce — initial schema (Phase 1: pilot core)
--
-- Hierarchy: account (owner / head office) → company (legal employer) → location (clinic).
-- A person has one login (auth.users) and one employment per company they work for.
-- Every table has row-level security. Clients never insert punches directly: they call
-- the punch_* functions below, which check zone, Wi-Fi, clinic code, PIN and schedule
-- on the server.

create extension if not exists pgcrypto with schema extensions;

-- Private helpers live in "app", which the Data API does not expose.
create schema if not exists app;
revoke all on schema app from public, anon;
grant usage on schema app to authenticated;

-- ---------------------------------------------------------------- Types

create type public.province as enum ('AB','BC','MB','NB','NL','NS','NT','NU','ON','PE','QC','SK','YT');
create type public.app_role as enum ('owner','company_admin','clinic_manager');
create type public.punch_kind as enum ('in','out');
create type public.punch_method as enum ('phone_geofence','rotating_qr','kiosk_pin','manual');
create type public.week_status as enum ('draft','published');
create type public.shift_response as enum ('pending','confirmed','declined');
create type public.approval_status as enum ('pending','approved','rejected');

-- ---------------------------------------------------------------- Tables

create table public.accounts (
  id uuid primary key default gen_random_uuid(),
  name text not null check (length(name) between 1 and 200),
  -- Count hours across this account's companies for overtime (related employers).
  combine_related_company_hours boolean not null default false,
  created_at timestamptz not null default now()
);

create table public.companies (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references public.accounts on delete cascade,
  legal_name text not null check (length(legal_name) between 1 and 200),
  created_at timestamptz not null default now()
);
create index on public.companies (account_id);

create table public.locations (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references public.accounts on delete cascade,
  company_id uuid not null references public.companies on delete cascade,
  name text not null check (length(name) between 1 and 120),
  province public.province not null,
  timezone text not null default 'America/Toronto',
  address text,
  latitude double precision check (latitude between -90 and 90),
  longitude double precision check (longitude between -180 and 180),
  geofence_radius_m integer not null default 150 check (geofence_radius_m between 25 and 2000),
  early_punch_limit_min integer not null default 15 check (early_punch_limit_min between 0 and 240),
  created_at timestamptz not null default now()
);
create index on public.locations (company_id);
create index on public.locations (account_id);

-- Secret used to sign the rotating QR code. Never readable by clients.
create table app.location_secrets (
  location_id uuid primary key references public.locations on delete cascade,
  qr_secret bytea not null default extensions.gen_random_bytes(32)
);

create table public.location_wifi (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references public.accounts on delete cascade,
  location_id uuid not null references public.locations on delete cascade,
  ssid text,
  bssid text not null check (bssid = lower(bssid)),
  unique (location_id, bssid)
);

create table public.persons (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references public.accounts on delete cascade,
  user_id uuid unique references auth.users on delete set null,
  first_name text not null check (length(first_name) between 1 and 100),
  last_name text not null check (length(last_name) between 1 and 100),
  email text check (email is null or email = lower(email)),
  phone text,
  preferred_locale text not null default 'fr-CA' check (preferred_locale in ('fr-CA','en-CA')),
  created_at timestamptz not null default now()
);
create unique index persons_account_email_uq on public.persons (account_id, email) where email is not null;
create index on public.persons (account_id);

-- Kiosk PINs, hashed. Never readable by clients.
create table app.person_pins (
  person_id uuid primary key references public.persons on delete cascade,
  pin_hash text not null,
  updated_at timestamptz not null default now()
);

create table public.role_assignments (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references public.accounts on delete cascade,
  person_id uuid not null references public.persons on delete cascade,
  role public.app_role not null,
  company_id uuid references public.companies on delete cascade,
  location_id uuid references public.locations on delete cascade,
  created_at timestamptz not null default now(),
  check (
    (role = 'owner' and company_id is null and location_id is null) or
    (role = 'company_admin' and company_id is not null and location_id is null) or
    (role = 'clinic_manager' and location_id is not null and company_id is null)
  ),
  unique nulls not distinct (person_id, role, company_id, location_id)
);
create index on public.role_assignments (person_id);

create table public.job_roles (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references public.accounts on delete cascade,
  name_fr text not null,
  name_en text not null
);

create table public.employments (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references public.accounts on delete cascade,
  person_id uuid not null references public.persons on delete cascade,
  company_id uuid not null references public.companies on delete cascade,
  job_role_id uuid references public.job_roles on delete set null,
  start_date date not null default current_date,
  end_date date,
  hourly_rate_cents integer check (hourly_rate_cents is null or hourly_rate_cents >= 0),
  desired_weekly_minutes integer check (desired_weekly_minutes is null or desired_weekly_minutes between 0 and 6000),
  min_weekly_minutes integer check (min_weekly_minutes is null or min_weekly_minutes between 0 and 6000),
  max_weekly_minutes integer check (max_weekly_minutes is null or max_weekly_minutes between 0 and 6000),
  availability_notice_days integer not null default 14 check (availability_notice_days between 0 and 90),
  created_at timestamptz not null default now(),
  check (min_weekly_minutes is null or max_weekly_minutes is null or min_weekly_minutes <= max_weekly_minutes),
  check (end_date is null or end_date >= start_date)
);
create index on public.employments (person_id);
create index on public.employments (company_id);

create table public.employment_locations (
  employment_id uuid not null references public.employments on delete cascade,
  location_id uuid not null references public.locations on delete cascade,
  account_id uuid not null references public.accounts on delete cascade,
  preferred boolean not null default false,
  primary key (employment_id, location_id)
);
create index on public.employment_locations (location_id);

create table public.schedule_weeks (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references public.accounts on delete cascade,
  location_id uuid not null references public.locations on delete cascade,
  week_start date not null check (extract(isodow from week_start) = 1),
  status public.week_status not null default 'draft',
  published_at timestamptz,
  published_by uuid references public.persons on delete set null,
  unique (location_id, week_start)
);

create table public.shifts (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references public.accounts on delete cascade,
  location_id uuid not null references public.locations on delete cascade,
  week_start date not null,
  -- Null = open shift.
  employment_id uuid references public.employments on delete cascade,
  job_role_id uuid references public.job_roles on delete set null,
  starts_at timestamptz not null,
  ends_at timestamptz not null,
  unpaid_break_minutes integer not null default 0 check (unpaid_break_minutes between 0 and 240),
  response public.shift_response not null default 'pending',
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (ends_at > starts_at),
  check (ends_at - starts_at <= interval '24 hours'),
  foreign key (location_id, week_start) references public.schedule_weeks (location_id, week_start) on delete cascade
);
create index on public.shifts (location_id, starts_at);
create index on public.shifts (employment_id, starts_at);

create table public.availability_rules (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references public.accounts on delete cascade,
  person_id uuid not null references public.persons on delete cascade,
  weekday smallint not null check (weekday between 0 and 6), -- 0 = Monday
  start_time time not null,
  end_time time not null,
  effective_from date not null default current_date,
  status public.approval_status not null default 'pending',
  check (start_time < end_time)
);
create index on public.availability_rules (person_id);

create table public.availability_exceptions (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references public.accounts on delete cascade,
  person_id uuid not null references public.persons on delete cascade,
  date date not null,
  start_time time,
  end_time time,
  reason text,
  status public.approval_status not null default 'pending',
  check ((start_time is null and end_time is null) or (start_time is not null and end_time is not null and start_time < end_time))
);
create index on public.availability_exceptions (person_id, date);

create table public.kiosk_devices (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references public.accounts on delete cascade,
  location_id uuid not null references public.locations on delete cascade,
  user_id uuid not null unique references auth.users on delete cascade,
  name text not null default 'iPad',
  created_at timestamptz not null default now()
);

create table app.kiosk_pairings (
  code text primary key,
  user_id uuid not null unique references auth.users on delete cascade,
  expires_at timestamptz not null default now() + interval '15 minutes'
);

create table public.punches (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references public.accounts on delete cascade,
  person_id uuid not null references public.persons on delete cascade,
  employment_id uuid not null references public.employments on delete cascade,
  location_id uuid not null references public.locations on delete cascade,
  kind public.punch_kind not null,
  method public.punch_method not null,
  occurred_at timestamptz not null default now(),
  recorded_at timestamptz not null default now(),
  latitude double precision,
  longitude double precision,
  accuracy_m double precision,
  distance_m integer,
  wifi_bssid text,
  mocked boolean not null default false,
  offline boolean not null default false,
  kiosk_device_id uuid references public.kiosk_devices on delete set null,
  -- e.g. no_shift, outside_geofence_wifi_ok, low_accuracy, offline
  flags text[] not null default '{}'
);
create index on public.punches (person_id, occurred_at desc);
create index on public.punches (location_id, occurred_at desc);

-- ---------------------------------------------------------------- Helper functions (used by policies)

create function app.my_person_id() returns uuid
language sql stable security definer set search_path = '' as $$
  select id from public.persons where user_id = auth.uid()
$$;

create function app.my_account_id() returns uuid
language sql stable security definer set search_path = '' as $$
  select account_id from public.persons where user_id = auth.uid()
$$;

create function app.is_owner() returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.role_assignments ra
    join public.persons p on p.id = ra.person_id
    where p.user_id = auth.uid() and ra.role = 'owner'
  )
$$;

create function app.is_manager() returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.role_assignments ra
    join public.persons p on p.id = ra.person_id
    where p.user_id = auth.uid()
  )
$$;

-- Owner of the account, or admin of the company.
create function app.manages_company(p_company_id uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.companies c
    join public.role_assignments ra on ra.account_id = c.account_id
    join public.persons p on p.id = ra.person_id
    where c.id = p_company_id and p.user_id = auth.uid()
      and (ra.role = 'owner' or (ra.role = 'company_admin' and ra.company_id = c.id))
  )
$$;

-- Owner of the account, admin of the clinic's company, or manager of the clinic.
create function app.manages_location(p_location_id uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.locations l
    join public.role_assignments ra on ra.account_id = l.account_id
    join public.persons p on p.id = ra.person_id
    where l.id = p_location_id and p.user_id = auth.uid()
      and (ra.role = 'owner'
        or (ra.role = 'company_admin' and ra.company_id = l.company_id)
        or (ra.role = 'clinic_manager' and ra.location_id = l.id))
  )
$$;

-- Manages at least one clinic of the company (lets clinic managers hire for their company).
create function app.manages_any_location_in_company(p_company_id uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select app.manages_company(p_company_id) or exists (
    select 1 from public.locations l where l.company_id = p_company_id and app.manages_location(l.id)
  )
$$;

-- A manager may manage a person who has no employment yet, or works at a clinic they manage.
create function app.can_manage_person(p_person_id uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.persons x where x.id = p_person_id and x.account_id = app.my_account_id()
  ) and (
    app.is_owner()
    or (app.is_manager() and not exists (select 1 from public.employments e where e.person_id = p_person_id))
    or exists (
      select 1 from public.employments e
      left join public.employment_locations el on el.employment_id = e.id
      where e.person_id = p_person_id
        and (app.manages_company(e.company_id) or (el.location_id is not null and app.manages_location(el.location_id)))
    )
  )
$$;

create function app.my_employment_ids() returns setof uuid
language sql stable security definer set search_path = '' as $$
  select e.id from public.employments e
  join public.persons p on p.id = e.person_id
  where p.user_id = auth.uid()
$$;

-- Clinics where I currently work.
create function app.my_location_ids() returns setof uuid
language sql stable security definer set search_path = '' as $$
  select el.location_id from public.employment_locations el
  join public.employments e on e.id = el.employment_id
  join public.persons p on p.id = e.person_id
  where p.user_id = auth.uid() and (e.end_date is null or e.end_date >= current_date)
$$;

create function app.is_week_published(p_location_id uuid, p_week_start date) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.schedule_weeks w
    where w.location_id = p_location_id and w.week_start = p_week_start and w.status = 'published'
  )
$$;

grant execute on all functions in schema app to authenticated;

-- ---------------------------------------------------------------- account_id always comes from the parent row

create function app.fill_account_id() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  v_account uuid;
begin
  if TG_TABLE_NAME = 'companies' then
    v_account := coalesce(app.my_account_id(), new.account_id);
  elsif TG_TABLE_NAME in ('locations', 'employments') then
    select account_id into v_account from public.companies where id = new.company_id;
  elsif TG_TABLE_NAME in ('location_wifi', 'schedule_weeks', 'shifts', 'employment_locations', 'kiosk_devices') then
    select account_id into v_account from public.locations where id = new.location_id;
  elsif TG_TABLE_NAME in ('availability_rules', 'availability_exceptions', 'role_assignments') then
    select account_id into v_account from public.persons where id = new.person_id;
  elsif TG_TABLE_NAME in ('persons', 'job_roles') then
    v_account := coalesce(app.my_account_id(), new.account_id);
  else
    v_account := new.account_id;
  end if;
  if v_account is null then
    raise exception 'Cannot determine the account for %', TG_TABLE_NAME using errcode = '23502';
  end if;
  new.account_id := v_account;
  return new;
end
$$;

do $$
declare t text;
begin
  foreach t in array array['companies','locations','location_wifi','persons','role_assignments','job_roles',
    'employments','employment_locations','schedule_weeks','shifts','availability_rules','availability_exceptions','kiosk_devices']
  loop
    execute format('create trigger fill_account_id before insert or update of account_id on public.%I
      for each row execute function app.fill_account_id()', t);
  end loop;
end $$;

-- An employment's clinics must belong to its company.
create function app.check_employment_location() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if not exists (
    select 1 from public.employments e join public.locations l on l.company_id = e.company_id
    where e.id = new.employment_id and l.id = new.location_id
  ) then
    raise exception 'This clinic belongs to another company' using errcode = '23514';
  end if;
  return new;
end
$$;
create trigger check_employment_location before insert or update on public.employment_locations
  for each row execute function app.check_employment_location();

-- Each new clinic gets its own QR secret.
create function app.create_location_secret() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  insert into app.location_secrets (location_id) values (new.id);
  return new;
end
$$;
create trigger create_location_secret after insert on public.locations
  for each row execute function app.create_location_secret();

create function app.touch_updated_at() returns trigger
language plpgsql set search_path = '' as $$
begin
  new.updated_at := now();
  return new;
end
$$;
create trigger touch_updated_at before update on public.shifts
  for each row execute function app.touch_updated_at();

-- When an invited employee signs in for the first time, link their login to their profile.
create function app.link_new_user() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if new.email is not null then
    update public.persons set user_id = new.id
    where id = (
      select id from public.persons
      where email = lower(new.email) and user_id is null
      order by created_at limit 1
    );
  end if;
  return new;
end
$$;
create trigger link_new_user after insert on auth.users
  for each row execute function app.link_new_user();

-- Emails are stored lower-case and trimmed.
create function app.normalize_person() returns trigger
language plpgsql set search_path = '' as $$
begin
  new.email := nullif(lower(trim(new.email)), '');
  return new;
end
$$;
create trigger normalize_person before insert or update of email on public.persons
  for each row execute function app.normalize_person();

-- ---------------------------------------------------------------- Row-level security

alter table public.accounts enable row level security;
alter table public.companies enable row level security;
alter table public.locations enable row level security;
alter table public.location_wifi enable row level security;
alter table public.persons enable row level security;
alter table public.role_assignments enable row level security;
alter table public.job_roles enable row level security;
alter table public.employments enable row level security;
alter table public.employment_locations enable row level security;
alter table public.schedule_weeks enable row level security;
alter table public.shifts enable row level security;
alter table public.availability_rules enable row level security;
alter table public.availability_exceptions enable row level security;
alter table public.kiosk_devices enable row level security;
alter table public.punches enable row level security;
alter table app.location_secrets enable row level security;
alter table app.person_pins enable row level security;
alter table app.kiosk_pairings enable row level security;

-- Accounts
create policy "members read their account" on public.accounts for select to authenticated
  using (id = (select app.my_account_id()));
create policy "owner updates the account" on public.accounts for update to authenticated
  using (id = (select app.my_account_id()) and (select app.is_owner()));

-- Companies
create policy "members read companies" on public.companies for select to authenticated
  using (account_id = (select app.my_account_id()));
create policy "owner creates companies" on public.companies for insert to authenticated
  with check (account_id = (select app.my_account_id()) and (select app.is_owner()));
create policy "admins update companies" on public.companies for update to authenticated
  using (app.manages_company(id)) with check (app.manages_company(id));
create policy "owner deletes companies" on public.companies for delete to authenticated
  using (account_id = (select app.my_account_id()) and (select app.is_owner()));

-- Clinics
create policy "members read clinics" on public.locations for select to authenticated
  using (account_id = (select app.my_account_id()));
create policy "admins create clinics" on public.locations for insert to authenticated
  with check (app.manages_company(company_id));
create policy "managers update their clinics" on public.locations for update to authenticated
  using (app.manages_location(id)) with check (app.manages_location(id));
create policy "admins delete clinics" on public.locations for delete to authenticated
  using (app.manages_company(company_id));

-- Clinic Wi-Fi
create policy "managers read clinic wifi" on public.location_wifi for select to authenticated
  using (app.manages_location(location_id));
create policy "managers add clinic wifi" on public.location_wifi for insert to authenticated
  with check (app.manages_location(location_id));
create policy "managers remove clinic wifi" on public.location_wifi for delete to authenticated
  using (app.manages_location(location_id));

-- People (staff directory is visible to the whole account)
create policy "members read people" on public.persons for select to authenticated
  using (account_id = (select app.my_account_id()));
create policy "managers add people" on public.persons for insert to authenticated
  with check (account_id = (select app.my_account_id()) and (select app.is_manager()) and user_id is null);
create policy "managers update people" on public.persons for update to authenticated
  using (app.can_manage_person(id)) with check (app.can_manage_person(id));
create policy "owner removes people" on public.persons for delete to authenticated
  using (account_id = (select app.my_account_id()) and (select app.is_owner()));

-- Roles
create policy "members read roles" on public.role_assignments for select to authenticated
  using (account_id = (select app.my_account_id()));
create policy "owner or company admin assigns roles" on public.role_assignments for insert to authenticated
  with check (
    account_id = (select app.my_account_id()) and (
      (select app.is_owner())
      or (role = 'clinic_manager' and app.manages_company((select l.company_id from public.locations l where l.id = location_id)))
    )
  );
create policy "owner or company admin removes roles" on public.role_assignments for delete to authenticated
  using (
    account_id = (select app.my_account_id()) and (
      (select app.is_owner())
      or (role = 'clinic_manager' and app.manages_company((select l.company_id from public.locations l where l.id = location_id)))
    )
  );

-- Job roles
create policy "members read job roles" on public.job_roles for select to authenticated
  using (account_id = (select app.my_account_id()));
create policy "managers edit job roles" on public.job_roles for all to authenticated
  using (account_id = (select app.my_account_id()) and (select app.is_manager()))
  with check (account_id = (select app.my_account_id()) and (select app.is_manager()));

-- Employments
create policy "self and managers read employments" on public.employments for select to authenticated
  using (
    person_id = (select app.my_person_id())
    or app.manages_company(company_id)
    or exists (select 1 from public.employment_locations el where el.employment_id = id and app.manages_location(el.location_id))
  );
create policy "managers hire" on public.employments for insert to authenticated
  with check (app.manages_any_location_in_company(company_id) and app.can_manage_person(person_id));
create policy "managers update employments" on public.employments for update to authenticated
  using (app.manages_company(company_id) or exists (
    select 1 from public.employment_locations el where el.employment_id = id and app.manages_location(el.location_id)))
  with check (app.manages_any_location_in_company(company_id));
create policy "admins delete employments" on public.employments for delete to authenticated
  using (app.manages_company(company_id));

-- Employment ↔ clinic
create policy "self and managers read employment clinics" on public.employment_locations for select to authenticated
  using (employment_id in (select app.my_employment_ids()) or app.manages_location(location_id));
create policy "managers assign clinics" on public.employment_locations for insert to authenticated
  with check (app.manages_location(location_id));
create policy "managers update clinic assignment" on public.employment_locations for update to authenticated
  using (app.manages_location(location_id)) with check (app.manages_location(location_id));
create policy "managers unassign clinics" on public.employment_locations for delete to authenticated
  using (app.manages_location(location_id));

-- Schedule weeks
create policy "managers and staff read schedule weeks" on public.schedule_weeks for select to authenticated
  using (app.manages_location(location_id) or (status = 'published' and location_id in (select app.my_location_ids())));
create policy "managers edit schedule weeks" on public.schedule_weeks for all to authenticated
  using (app.manages_location(location_id)) with check (app.manages_location(location_id));

-- Shifts: staff see published shifts at their clinics; managers see and edit everything at theirs
create policy "managers and staff read shifts" on public.shifts for select to authenticated
  using (
    app.manages_location(location_id)
    or (location_id in (select app.my_location_ids()) and app.is_week_published(location_id, week_start))
  );
create policy "managers edit shifts" on public.shifts for all to authenticated
  using (app.manages_location(location_id)) with check (app.manages_location(location_id));

-- Availability: employees submit (pending), managers approve
create policy "self and managers read availability" on public.availability_rules for select to authenticated
  using (person_id = (select app.my_person_id()) or app.can_manage_person(person_id));
create policy "self submits availability" on public.availability_rules for insert to authenticated
  with check ((person_id = (select app.my_person_id()) and status = 'pending') or app.can_manage_person(person_id));
create policy "self edits pending, managers approve" on public.availability_rules for update to authenticated
  using ((person_id = (select app.my_person_id()) and status = 'pending') or app.can_manage_person(person_id))
  with check ((person_id = (select app.my_person_id()) and status = 'pending') or app.can_manage_person(person_id));
create policy "self deletes pending, managers delete" on public.availability_rules for delete to authenticated
  using ((person_id = (select app.my_person_id()) and status = 'pending') or app.can_manage_person(person_id));

create policy "self and managers read exceptions" on public.availability_exceptions for select to authenticated
  using (person_id = (select app.my_person_id()) or app.can_manage_person(person_id));
create policy "self submits exceptions" on public.availability_exceptions for insert to authenticated
  with check ((person_id = (select app.my_person_id()) and status = 'pending') or app.can_manage_person(person_id));
create policy "self edits pending exceptions, managers approve" on public.availability_exceptions for update to authenticated
  using ((person_id = (select app.my_person_id()) and status = 'pending') or app.can_manage_person(person_id))
  with check ((person_id = (select app.my_person_id()) and status = 'pending') or app.can_manage_person(person_id));
create policy "self deletes pending exceptions" on public.availability_exceptions for delete to authenticated
  using ((person_id = (select app.my_person_id()) and status = 'pending') or app.can_manage_person(person_id));

-- Kiosk devices: created only through kiosk_approve_pairing()
create policy "managers and the device read kiosks" on public.kiosk_devices for select to authenticated
  using (app.manages_location(location_id) or user_id = (select auth.uid()));
create policy "managers remove kiosks" on public.kiosk_devices for delete to authenticated
  using (app.manages_location(location_id));

-- Punches: created only through the punch functions; managers can correct them
create policy "self and managers read punches" on public.punches for select to authenticated
  using (person_id = (select app.my_person_id()) or app.manages_location(location_id));
create policy "managers correct punches" on public.punches for update to authenticated
  using (app.manages_location(location_id)) with check (app.manages_location(location_id));

-- ---------------------------------------------------------------- Server-side logic

create function app.distance_m(lat1 double precision, lon1 double precision, lat2 double precision, lon2 double precision)
returns double precision language sql immutable set search_path = '' as $$
  select 2 * 6371000 * asin(sqrt(
    power(sin(radians(lat2 - lat1) / 2), 2) +
    cos(radians(lat1)) * cos(radians(lat2)) * power(sin(radians(lon2 - lon1) / 2), 2)
  ))
$$;

create function app.qr_window(p_at timestamptz) returns bigint
language sql immutable set search_path = '' as $$
  select floor(extract(epoch from p_at) / 30)::bigint
$$;

-- 6-character code for a clinic and a 30-second window, signed with the clinic's secret (HMAC-SHA256).
create function app.qr_code(p_location_id uuid, p_window bigint) returns text
language sql stable security definer set search_path = '' as $$
  select string_agg(substr('ABCDEFGHJKLMNPQRSTUVWXYZ23456789', (get_byte(x.h, i) % 32) + 1, 1), '' order by i)
  from (
    select extensions.hmac(convert_to(p_location_id::text || ':' || p_window::text, 'UTF8'), s.qr_secret, 'sha256') as h
    from app.location_secrets s where s.location_id = p_location_id
  ) x, generate_series(0, 5) as i
$$;

create function app.next_punch_kind(p_person_id uuid) returns public.punch_kind
language sql stable security definer set search_path = '' as $$
  select case when (
    select kind from public.punches where person_id = p_person_id order by occurred_at desc, recorded_at desc limit 1
  ) = 'in' then 'out'::public.punch_kind else 'in'::public.punch_kind end
$$;

-- The published shift being started or worked around a moment.
create function app.relevant_shift(p_employment_id uuid, p_location_id uuid, p_at timestamptz) returns public.shifts
language sql stable security definer set search_path = '' as $$
  select s.* from public.shifts s
  where s.employment_id = p_employment_id and s.location_id = p_location_id
    and s.ends_at > p_at and s.starts_at < p_at + interval '12 hours'
    and s.response <> 'declined'
    and app.is_week_published(s.location_id, s.week_start)
  order by s.starts_at limit 1
$$;

-- Common checks for a phone punch. Returns the employment and the decision so far.
create function app.punch_context(p_location_id uuid, p_at timestamptz,
  out person public.persons, out location public.locations, out employment_id uuid,
  out kind public.punch_kind, out shift public.shifts, out rejection jsonb)
language plpgsql stable security definer set search_path = '' as $$
begin
  select * into person from public.persons where user_id = auth.uid();
  if person.id is null then
    rejection := jsonb_build_object('accepted', false, 'reason', 'not_a_member');
    return;
  end if;
  select * into location from public.locations where id = p_location_id and account_id = person.account_id;
  if location.id is null then
    rejection := jsonb_build_object('accepted', false, 'reason', 'unknown_location');
    return;
  end if;
  select e.id into employment_id from public.employments e
  join public.employment_locations el on el.employment_id = e.id
  where e.person_id = person.id and el.location_id = p_location_id
    and e.start_date <= (p_at at time zone location.timezone)::date
    and (e.end_date is null or e.end_date >= (p_at at time zone location.timezone)::date)
  limit 1;
  if employment_id is null then
    rejection := jsonb_build_object('accepted', false, 'reason', 'not_assigned');
    return;
  end if;
  kind := app.next_punch_kind(person.id);
  shift := app.relevant_shift(employment_id, p_location_id, p_at);
  if kind = 'in' and shift.id is not null
     and p_at < shift.starts_at - make_interval(mins => location.early_punch_limit_min) then
    rejection := jsonb_build_object(
      'accepted', false, 'reason', 'too_early',
      'opens_in_min', ceil(extract(epoch from (shift.starts_at - make_interval(mins => location.early_punch_limit_min) - p_at)) / 60)::int,
      'early_limit_min', location.early_punch_limit_min);
  end if;
end
$$;

-- Accept a device time only for offline punches from the last 24 hours.
create function app.punch_time(p_offline boolean, p_occurred_at timestamptz) returns timestamptz
language sql stable set search_path = '' as $$
  select case
    when p_offline and p_occurred_at between now() - interval '24 hours' and now() + interval '5 minutes' then p_occurred_at
    else now()
  end
$$;

create function public.punch_with_location(
  p_location_id uuid,
  p_latitude double precision default null,
  p_longitude double precision default null,
  p_accuracy_m double precision default null,
  p_wifi_bssid text default null,
  p_mocked boolean default false,
  p_offline boolean default false,
  p_occurred_at timestamptz default null
) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_at timestamptz := app.punch_time(p_offline, p_occurred_at);
  c record;
  v_flags text[] := '{}';
  v_distance integer;
  v_wifi_ok boolean;
  v_id uuid;
begin
  select * into c from app.punch_context(p_location_id, v_at);
  if c.rejection is not null then return c.rejection; end if;

  if p_mocked then
    return jsonb_build_object('accepted', false, 'reason', 'mock_location');
  end if;

  v_wifi_ok := p_wifi_bssid is not null and exists (
    select 1 from public.location_wifi w where w.location_id = p_location_id and w.bssid = lower(p_wifi_bssid));

  if p_latitude is null or p_longitude is null or (c.location).latitude is null then
    if not v_wifi_ok then
      return jsonb_build_object('accepted', false,
        'reason', case when (c.location).latitude is null then 'location_not_configured' else 'no_position' end);
    end if;
  else
    v_distance := round(app.distance_m(p_latitude, p_longitude, (c.location).latitude, (c.location).longitude));
    if p_accuracy_m is not null and p_accuracy_m > 100 then v_flags := array_append(v_flags, 'low_accuracy'); end if;
    if v_distance > (c.location).geofence_radius_m then
      if not v_wifi_ok then
        return jsonb_build_object('accepted', false, 'reason', 'outside_geofence',
          'distance_m', v_distance, 'radius_m', (c.location).geofence_radius_m);
      end if;
      v_flags := array_append(v_flags, 'outside_geofence_wifi_ok');
    end if;
  end if;

  if c.kind = 'in' and (c.shift).id is null then v_flags := array_append(v_flags, 'no_shift'); end if;
  if p_offline then v_flags := array_append(v_flags, 'offline'); end if;

  insert into public.punches (account_id, person_id, employment_id, location_id, kind, method, occurred_at,
    latitude, longitude, accuracy_m, distance_m, wifi_bssid, mocked, offline, flags)
  values ((c.person).account_id, (c.person).id, c.employment_id, p_location_id, c.kind, 'phone_geofence', v_at,
    p_latitude, p_longitude, p_accuracy_m, v_distance, lower(p_wifi_bssid), false, p_offline, v_flags)
  returning id into v_id;

  return jsonb_build_object('accepted', true, 'punch_id', v_id, 'kind', c.kind, 'occurred_at', v_at,
    'flags', to_jsonb(v_flags), 'distance_m', v_distance, 'radius_m', (c.location).geofence_radius_m);
end
$$;

create function public.punch_with_qr(p_location_id uuid, p_code text, p_offline boolean default false,
  p_occurred_at timestamptz default null) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_at timestamptz := app.punch_time(p_offline, p_occurred_at);
  v_window bigint := app.qr_window(v_at);
  c record;
  v_flags text[] := '{}';
  v_id uuid;
begin
  select * into c from app.punch_context(p_location_id, v_at);
  if c.rejection is not null then return c.rejection; end if;

  if p_code is null or upper(p_code) not in (app.qr_code(p_location_id, v_window), app.qr_code(p_location_id, v_window - 1)) then
    return jsonb_build_object('accepted', false, 'reason', 'invalid_qr');
  end if;

  if c.kind = 'in' and (c.shift).id is null then v_flags := array_append(v_flags, 'no_shift'); end if;
  if p_offline then v_flags := array_append(v_flags, 'offline'); end if;

  insert into public.punches (account_id, person_id, employment_id, location_id, kind, method, occurred_at, offline, flags)
  values ((c.person).account_id, (c.person).id, c.employment_id, p_location_id, c.kind, 'rotating_qr', v_at, p_offline, v_flags)
  returning id into v_id;

  return jsonb_build_object('accepted', true, 'punch_id', v_id, 'kind', c.kind, 'occurred_at', v_at, 'flags', to_jsonb(v_flags));
end
$$;

-- Employees choose their own kiosk PIN (4–6 digits, unique within the account).
create function public.set_my_pin(p_pin text) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_person public.persons;
begin
  select * into v_person from public.persons where user_id = auth.uid();
  if v_person.id is null then return jsonb_build_object('ok', false, 'reason', 'not_a_member'); end if;
  if p_pin !~ '^[0-9]{4,6}$' then return jsonb_build_object('ok', false, 'reason', 'invalid_pin'); end if;
  if p_pin in ('0000','1111','1234','12345','123456','2222','9999') then
    return jsonb_build_object('ok', false, 'reason', 'pin_too_simple');
  end if;
  if exists (
    select 1 from app.person_pins pp join public.persons p on p.id = pp.person_id
    where p.account_id = v_person.account_id and p.id <> v_person.id
      and pp.pin_hash = extensions.crypt(p_pin, pp.pin_hash)
  ) then
    return jsonb_build_object('ok', false, 'reason', 'pin_taken');
  end if;
  insert into app.person_pins (person_id, pin_hash, updated_at)
  values (v_person.id, extensions.crypt(p_pin, extensions.gen_salt('bf', 8)), now())
  on conflict (person_id) do update set pin_hash = excluded.pin_hash, updated_at = now();
  return jsonb_build_object('ok', true);
end
$$;

create function public.has_pin() returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from app.person_pins pp join public.persons p on p.id = pp.person_id where p.user_id = auth.uid())
$$;

-- Kiosk pairing: the iPad signs in anonymously and shows a code; a manager enters it on the web.
create function public.kiosk_request_pairing() returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_code text;
begin
  if auth.uid() is null then raise exception 'Sign in first' using errcode = '42501'; end if;
  if exists (select 1 from public.persons where user_id = auth.uid()) then
    return jsonb_build_object('ok', false, 'reason', 'staff_account');
  end if;
  if exists (select 1 from public.kiosk_devices where user_id = auth.uid()) then
    return jsonb_build_object('ok', false, 'reason', 'already_paired');
  end if;
  delete from app.kiosk_pairings where user_id = auth.uid() or expires_at < now();
  loop
    v_code := lpad((floor(random() * 1000000))::int::text, 6, '0');
    begin
      insert into app.kiosk_pairings (code, user_id) values (v_code, auth.uid());
      exit;
    exception when unique_violation then
      -- try another code
    end;
  end loop;
  return jsonb_build_object('ok', true, 'code', v_code, 'expires_in_s', 900);
end
$$;

create function public.kiosk_approve_pairing(p_code text, p_location_id uuid, p_name text default 'iPad') returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_pairing app.kiosk_pairings;
  v_id uuid;
begin
  if not app.manages_location(p_location_id) then
    return jsonb_build_object('ok', false, 'reason', 'not_allowed');
  end if;
  select * into v_pairing from app.kiosk_pairings where code = p_code and expires_at > now();
  if v_pairing.code is null then
    return jsonb_build_object('ok', false, 'reason', 'invalid_code');
  end if;
  insert into public.kiosk_devices (location_id, user_id, name) values (p_location_id, v_pairing.user_id, coalesce(nullif(p_name, ''), 'iPad'))
  returning id into v_id;
  delete from app.kiosk_pairings where code = p_code;
  return jsonb_build_object('ok', true, 'kiosk_id', v_id);
end
$$;

create function public.kiosk_me() returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object('kiosk_id', k.id, 'location_id', l.id, 'location_name', l.name, 'province', l.province, 'timezone', l.timezone)
  from public.kiosk_devices k join public.locations l on l.id = k.location_id
  where k.user_id = auth.uid()
$$;

-- Current code for the iPad screen (kiosk of that clinic, or a manager of it).
create function public.kiosk_current_code(p_location_id uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v_window bigint := app.qr_window(now());
  v_code text;
begin
  if not (exists (select 1 from public.kiosk_devices where user_id = auth.uid() and location_id = p_location_id)
          or app.manages_location(p_location_id)) then
    return jsonb_build_object('ok', false, 'reason', 'not_allowed');
  end if;
  v_code := app.qr_code(p_location_id, v_window);
  return jsonb_build_object('ok', true, 'code', v_code,
    'payload', 'cw1:' || p_location_id::text || ':' || v_code,
    'seconds_left', 30 - (floor(extract(epoch from now()))::bigint % 30));
end
$$;

-- PIN punch on the clinic iPad.
create function public.kiosk_punch(p_pin text) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_kiosk public.kiosk_devices;
  v_loc public.locations;
  v_person public.persons;
  v_employment uuid;
  v_kind public.punch_kind;
  v_shift public.shifts;
  v_flags text[] := '{}';
  v_at timestamptz := now();
begin
  select * into v_kiosk from public.kiosk_devices where user_id = auth.uid();
  if v_kiosk.id is null then return jsonb_build_object('accepted', false, 'reason', 'not_a_kiosk'); end if;
  if p_pin is null or p_pin !~ '^[0-9]{4,6}$' then return jsonb_build_object('accepted', false, 'reason', 'wrong_pin'); end if;
  select * into v_loc from public.locations where id = v_kiosk.location_id;

  select p.* into v_person from public.persons p
  join app.person_pins pp on pp.person_id = p.id
  where p.account_id = v_kiosk.account_id and pp.pin_hash = extensions.crypt(p_pin, pp.pin_hash)
  limit 1;
  if v_person.id is null then return jsonb_build_object('accepted', false, 'reason', 'wrong_pin'); end if;

  select e.id into v_employment from public.employments e
  join public.employment_locations el on el.employment_id = e.id
  where e.person_id = v_person.id and el.location_id = v_loc.id
    and (e.end_date is null or e.end_date >= (v_at at time zone v_loc.timezone)::date)
  limit 1;
  if v_employment is null then
    return jsonb_build_object('accepted', false, 'reason', 'not_assigned', 'first_name', v_person.first_name);
  end if;

  v_kind := app.next_punch_kind(v_person.id);
  v_shift := app.relevant_shift(v_employment, v_loc.id, v_at);
  if v_kind = 'in' and v_shift.id is not null
     and v_at < v_shift.starts_at - make_interval(mins => v_loc.early_punch_limit_min) then
    return jsonb_build_object('accepted', false, 'reason', 'too_early', 'first_name', v_person.first_name,
      'opens_in_min', ceil(extract(epoch from (v_shift.starts_at - make_interval(mins => v_loc.early_punch_limit_min) - v_at)) / 60)::int);
  end if;
  if v_kind = 'in' and v_shift.id is null then v_flags := array_append(v_flags, 'no_shift'); end if;

  insert into public.punches (account_id, person_id, employment_id, location_id, kind, method, occurred_at, kiosk_device_id, flags)
  values (v_kiosk.account_id, v_person.id, v_employment, v_loc.id, v_kind, 'kiosk_pin', v_at, v_kiosk.id, v_flags);

  return jsonb_build_object('accepted', true, 'kind', v_kind, 'occurred_at', v_at,
    'first_name', v_person.first_name, 'flags', to_jsonb(v_flags));
end
$$;

-- Employees confirm or decline their own published, upcoming shifts.
create function public.respond_to_shift(p_shift_id uuid, p_response public.shift_response) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
begin
  update public.shifts s set response = p_response
  where s.id = p_shift_id
    and s.employment_id in (select app.my_employment_ids())
    and s.starts_at > now()
    and app.is_week_published(s.location_id, s.week_start);
  if not found then return jsonb_build_object('ok', false, 'reason', 'not_allowed'); end if;
  return jsonb_build_object('ok', true);
end
$$;

-- Self-serve start: a signed-in user with no account creates one and becomes its owner.
create function public.create_account(p_account_name text, p_first_name text, p_last_name text) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_account uuid;
  v_person uuid;
  v_email text := lower(auth.jwt() ->> 'email');
begin
  if auth.uid() is null or coalesce((auth.jwt() ->> 'is_anonymous')::boolean, false) then
    return jsonb_build_object('ok', false, 'reason', 'sign_in_required');
  end if;
  if exists (select 1 from public.persons where user_id = auth.uid())
     or exists (select 1 from public.kiosk_devices where user_id = auth.uid()) then
    return jsonb_build_object('ok', false, 'reason', 'already_member');
  end if;
  insert into public.accounts (name) values (p_account_name) returning id into v_account;
  insert into public.persons (account_id, user_id, first_name, last_name, email)
  values (v_account, auth.uid(), p_first_name, p_last_name, nullif(v_email, ''))
  returning id into v_person;
  insert into public.role_assignments (account_id, person_id, role) values (v_account, v_person, 'owner');
  return jsonb_build_object('ok', true, 'account_id', v_account, 'person_id', v_person);
end
$$;

-- Only signed-in users may call the functions above.
revoke execute on function public.punch_with_location(uuid, double precision, double precision, double precision, text, boolean, boolean, timestamptz) from public, anon;
revoke execute on function public.punch_with_qr(uuid, text, boolean, timestamptz) from public, anon;
revoke execute on function public.set_my_pin(text) from public, anon;
revoke execute on function public.has_pin() from public, anon;
revoke execute on function public.kiosk_request_pairing() from public, anon;
revoke execute on function public.kiosk_approve_pairing(text, uuid, text) from public, anon;
revoke execute on function public.kiosk_me() from public, anon;
revoke execute on function public.kiosk_current_code(uuid) from public, anon;
revoke execute on function public.kiosk_punch(text) from public, anon;
revoke execute on function public.respond_to_shift(uuid, public.shift_response) from public, anon;
revoke execute on function public.create_account(text, text, text) from public, anon;

grant execute on function public.punch_with_location(uuid, double precision, double precision, double precision, text, boolean, boolean, timestamptz) to authenticated;
grant execute on function public.punch_with_qr(uuid, text, boolean, timestamptz) to authenticated;
grant execute on function public.set_my_pin(text) to authenticated;
grant execute on function public.has_pin() to authenticated;
grant execute on function public.kiosk_request_pairing() to authenticated;
grant execute on function public.kiosk_approve_pairing(text, uuid, text) to authenticated;
grant execute on function public.kiosk_me() to authenticated;
grant execute on function public.kiosk_current_code(uuid) to authenticated;
grant execute on function public.kiosk_punch(text) to authenticated;
grant execute on function public.respond_to_shift(uuid, public.shift_response) to authenticated;
grant execute on function public.create_account(text, text, text) to authenticated;

-- Signed-in users reach the tables only through the row-level security policies above.
-- (Explicit, so it works whether or not the project exposes new tables automatically.)
grant usage on schema public to authenticated;
grant select, insert, update, delete on all tables in schema public to authenticated;

-- Anonymous visitors get nothing from the tables.
revoke all on all tables in schema public from anon;

-- Logins are linked by the server only; managers may correct only the time, type and flags of a punch.
revoke update on public.persons from authenticated;
grant update (first_name, last_name, email, phone, preferred_locale) on public.persons to authenticated;
revoke update on public.punches from authenticated;
grant update (occurred_at, kind, flags) on public.punches to authenticated;
revoke insert, update on public.kiosk_devices from authenticated;
