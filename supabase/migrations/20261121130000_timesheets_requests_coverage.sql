-- Timesheets and payroll, missed-punch requests, time off and availability requests,
-- open-shift coverage, one schedule across companies, coverage by position, credentials,
-- and push notifications when the schedule changes.

-- ================================================================ Settings

alter table public.companies
  add column pay_frequency text not null default 'biweekly' check (pay_frequency in ('weekly', 'biweekly')),
  -- First day of any pay period; the others follow every 7 or 14 days.
  add column pay_period_anchor date not null default date '2026-01-04';

alter table public.employments
  add column payroll_number text check (length(payroll_number) <= 40);

create type public.request_status as enum ('pending', 'approved', 'refused', 'cancelled');

-- ================================================================ Punch history (originals are kept)

create table public.punch_history (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references public.accounts on delete cascade,
  punch_id uuid not null,
  person_id uuid not null,
  location_id uuid not null,
  kind public.punch_kind not null,
  occurred_at timestamptz not null,
  flags text[] not null,
  action text not null check (action in ('update', 'delete')),
  changed_by uuid references public.persons on delete set null,
  changed_at timestamptz not null default now()
);
create index on public.punch_history (punch_id);
create index on public.punch_history (location_id, changed_at desc);

create function app.keep_punch_history() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  -- Deletes cascading from a removed person or account aren't corrections: nothing to keep.
  if TG_OP = 'DELETE' and pg_trigger_depth() > 1 then return old; end if;
  if TG_OP = 'DELETE'
     or new.occurred_at <> old.occurred_at or new.kind <> old.kind or new.location_id <> old.location_id then
    insert into public.punch_history (account_id, punch_id, person_id, location_id, kind, occurred_at, flags, action, changed_by)
    values (old.account_id, old.id, old.person_id, old.location_id, old.kind, old.occurred_at, old.flags,
            lower(TG_OP), app.my_person_id());
  end if;
  return coalesce(new, old);
end
$$;
create trigger keep_punch_history before update or delete on public.punches
  for each row execute function app.keep_punch_history();

-- ================================================================ Missed / wrong punch requests

create table public.punch_corrections (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references public.accounts on delete cascade,
  person_id uuid not null references public.persons on delete cascade,
  employment_id uuid not null references public.employments on delete cascade,
  location_id uuid not null references public.locations on delete cascade,
  -- null: a missed punch to add; otherwise the punch to correct
  punch_id uuid references public.punches on delete set null,
  kind public.punch_kind not null,
  occurred_at timestamptz not null,
  reason text not null check (length(btrim(reason)) between 1 and 500),
  status public.request_status not null default 'pending',
  requested_by uuid references public.persons on delete set null,
  decided_by uuid references public.persons on delete set null,
  decided_at timestamptz,
  manager_note text check (length(manager_note) <= 500),
  created_at timestamptz not null default now()
);
create index on public.punch_corrections (location_id, status);
create index on public.punch_corrections (person_id, created_at desc);

-- ================================================================ Timesheet approvals

create table public.timesheet_approvals (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references public.accounts on delete cascade,
  company_id uuid not null references public.companies on delete cascade,
  person_id uuid not null references public.persons on delete cascade,
  period_start date not null,
  period_end date not null,
  -- what was approved, to spot later changes
  regular_minutes integer not null check (regular_minutes >= 0),
  overtime_minutes integer not null check (overtime_minutes >= 0),
  approved_by uuid references public.persons on delete set null,
  approved_at timestamptz not null default now(),
  unique (company_id, person_id, period_start),
  check (period_end > period_start)
);

-- ================================================================ Time off

create type public.time_off_type as enum ('vacation', 'sick', 'personal', 'unpaid', 'other');

create table public.time_off_requests (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references public.accounts on delete cascade,
  person_id uuid not null references public.persons on delete cascade,
  type public.time_off_type not null,
  start_date date not null,
  end_date date not null,
  -- both set: part of a single day
  start_time time,
  end_time time,
  -- paid hours to send to payroll, set when approving
  paid_hours numeric(6, 2) check (paid_hours >= 0),
  note text check (length(note) <= 500),
  status public.request_status not null default 'pending',
  decided_by uuid references public.persons on delete set null,
  decided_at timestamptz,
  manager_note text check (length(manager_note) <= 500),
  created_at timestamptz not null default now(),
  check (end_date >= start_date and end_date - start_date <= 366),
  check ((start_time is null and end_time is null)
         or (start_time is not null and end_time is not null and start_time < end_time and start_date = end_date))
);
create index on public.time_off_requests (person_id, start_date);
create index on public.time_off_requests (account_id, status);

-- ================================================================ Open-shift claims

create table public.shift_claims (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references public.accounts on delete cascade,
  shift_id uuid not null references public.shifts on delete cascade,
  location_id uuid not null references public.locations on delete cascade,
  employment_id uuid not null references public.employments on delete cascade,
  status public.request_status not null default 'pending',
  created_at timestamptz not null default now(),
  decided_at timestamptz,
  unique (shift_id, employment_id)
);
create index on public.shift_claims (location_id, status);

-- ================================================================ Coverage by position

create table public.coverage_rules (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references public.accounts on delete cascade,
  location_id uuid not null references public.locations on delete cascade,
  job_role_id uuid not null references public.job_roles on delete cascade,
  weekdays smallint[] not null default '{0,1,2,3,4}'
    check (cardinality(weekdays) > 0 and weekdays <@ '{0,1,2,3,4,5,6}'::smallint[]), -- 0 = Monday
  start_time time not null,
  end_time time not null,
  min_count smallint not null default 1 check (min_count between 1 and 20),
  created_at timestamptz not null default now(),
  check (start_time < end_time)
);
create index on public.coverage_rules (location_id);

-- ================================================================ Credentials (licences, certifications)

create table public.credentials (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references public.accounts on delete cascade,
  person_id uuid not null references public.persons on delete cascade,
  name text not null check (length(btrim(name)) between 1 and 120),
  number text check (length(number) <= 60),
  issuer text check (length(issuer) <= 120),
  expires_on date,
  -- an expired credential blocks publishing a schedule that includes the person
  blocks_scheduling boolean not null default true,
  created_at timestamptz not null default now()
);
create index on public.credentials (person_id);
create index on public.credentials (account_id, expires_on);

-- ================================================================ Push notifications

create table app.push_tokens (
  token text primary key,
  person_id uuid not null references public.persons on delete cascade,
  user_id uuid not null,
  platform text not null check (platform in ('ios', 'android')),
  updated_at timestamptz not null default now()
);
create index on app.push_tokens (person_id);

-- Every notification sent, for support and auditing.
create table app.notifications (
  id uuid primary key default gen_random_uuid(),
  person_id uuid not null references public.persons on delete cascade,
  title text not null,
  body text not null,
  data jsonb not null default '{}',
  tokens integer not null default 0,
  created_at timestamptz not null default now()
);
create index on app.notifications (person_id, created_at desc);

-- pg_net sends the HTTP request to Expo's push service after the transaction commits.
-- (Supabase provides it; other databases simply skip sending.)
do $$
begin
  create extension if not exists pg_net;
exception when others then
  raise notice 'pg_net not available: push notifications will be recorded but not sent';
end
$$;

-- ================================================================ account_id from the parent row

create or replace function app.fill_account_id() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  v_account uuid;
begin
  if TG_TABLE_NAME = 'companies' then
    v_account := coalesce(app.my_account_id(), new.account_id);
  elsif TG_TABLE_NAME in ('locations', 'employments', 'custom_roles', 'timesheet_approvals') then
    select account_id into v_account from public.companies where id = new.company_id;
  elsif TG_TABLE_NAME in ('location_wifi', 'schedule_weeks', 'shifts', 'employment_locations', 'kiosk_devices',
                          'custom_role_assignments', 'shift_swaps', 'shift_claims', 'coverage_rules', 'punch_corrections') then
    select account_id into v_account from public.locations where id = new.location_id;
  elsif TG_TABLE_NAME in ('availability_rules', 'availability_exceptions', 'role_assignments', 'time_off_requests', 'credentials') then
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

create trigger fill_account_id before insert or update of account_id on public.punch_corrections
  for each row execute function app.fill_account_id();
create trigger fill_account_id before insert or update of account_id on public.timesheet_approvals
  for each row execute function app.fill_account_id();
create trigger fill_account_id before insert or update of account_id on public.time_off_requests
  for each row execute function app.fill_account_id();
create trigger fill_account_id before insert or update of account_id on public.shift_claims
  for each row execute function app.fill_account_id();
create trigger fill_account_id before insert or update of account_id on public.coverage_rules
  for each row execute function app.fill_account_id();
create trigger fill_account_id before insert or update of account_id on public.credentials
  for each row execute function app.fill_account_id();

-- Coverage rules: the position must belong to the clinic's account.
create function app.check_coverage_rule() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if not exists (select 1 from public.job_roles j join public.locations l on l.account_id = j.account_id
                 where j.id = new.job_role_id and l.id = new.location_id) then
    raise exception 'Unknown position' using errcode = '23514';
  end if;
  return new;
end
$$;
create trigger check_coverage_rule before insert or update on public.coverage_rules
  for each row execute function app.check_coverage_rule();

-- ================================================================ Row-level security

alter table public.punch_history enable row level security;
alter table public.punch_corrections enable row level security;
alter table public.timesheet_approvals enable row level security;
alter table public.time_off_requests enable row level security;
alter table public.shift_claims enable row level security;
alter table public.coverage_rules enable row level security;
alter table public.credentials enable row level security;

create policy "self and payroll read punch history" on public.punch_history for select to authenticated
  using (person_id = (select app.my_person_id()) or app.can(location_id, 'punches'));

create policy "self and payroll read corrections" on public.punch_corrections for select to authenticated
  using (person_id = (select app.my_person_id()) or app.can(location_id, 'punches'));

create policy "self and payroll read approvals" on public.timesheet_approvals for select to authenticated
  using (person_id = (select app.my_person_id()) or app.can_in_company(company_id, 'punches'));
create policy "payroll approves timesheets" on public.timesheet_approvals for insert to authenticated
  with check (app.can_in_company(company_id, 'punches') and app.can_for_person(person_id, 'punches'));
create policy "payroll withdraws approvals" on public.timesheet_approvals for delete to authenticated
  using (app.can_in_company(company_id, 'punches'));

create policy "self and managers read time off" on public.time_off_requests for select to authenticated
  using (
    person_id = (select app.my_person_id())
    or app.can_manage_person(person_id)
    or app.can_for_person(person_id, 'schedule')
    or app.can_for_person(person_id, 'punches')
  );

create policy "claimant and schedulers read claims" on public.shift_claims for select to authenticated
  using (employment_id in (select app.my_employment_ids()) or app.can(location_id, 'schedule'));

create policy "members read coverage rules" on public.coverage_rules for select to authenticated
  using (account_id = (select app.my_account_id()));
create policy "schedulers edit coverage rules" on public.coverage_rules for all to authenticated
  using (app.can(location_id, 'schedule')) with check (app.can(location_id, 'schedule'));

create policy "self and managers read credentials" on public.credentials for select to authenticated
  using (person_id = (select app.my_person_id()) or app.can_manage_person(person_id) or app.can_for_person(person_id, 'schedule'));
create policy "managers add credentials" on public.credentials for insert to authenticated
  with check (app.can_manage_person(person_id));
create policy "managers update credentials" on public.credentials for update to authenticated
  using (app.can_manage_person(person_id)) with check (app.can_manage_person(person_id));
create policy "managers remove credentials" on public.credentials for delete to authenticated
  using (app.can_manage_person(person_id));

-- Schedulers also approve availability.
drop policy "self edits pending, managers approve" on public.availability_rules;
create policy "self edits pending, managers approve" on public.availability_rules for update to authenticated
  using ((person_id = (select app.my_person_id()) and status = 'pending') or app.can_manage_person(person_id) or app.can_for_person(person_id, 'schedule'))
  with check ((person_id = (select app.my_person_id()) and status = 'pending') or app.can_manage_person(person_id) or app.can_for_person(person_id, 'schedule'));

-- ================================================================ Notifications

-- "lun. 23 nov. · 13:00–17:00" / "Mon Nov 23 · 13:00–17:00"
create function app.fmt_when(p_start timestamptz, p_end timestamptz, p_tz text, p_locale text) returns text
language sql immutable set search_path = '' as $$
  select case when p_locale = 'en-CA' then
      (array['Mon','Tue','Wed','Thu','Fri','Sat','Sun'])[extract(isodow from p_start at time zone p_tz)::int] || ' '
      || (array['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'])[extract(month from p_start at time zone p_tz)::int] || ' '
      || extract(day from p_start at time zone p_tz)::int
    else
      (array['lun.','mar.','mer.','jeu.','ven.','sam.','dim.'])[extract(isodow from p_start at time zone p_tz)::int] || ' '
      || extract(day from p_start at time zone p_tz)::int || ' '
      || (array['janv.','févr.','mars','avr.','mai','juin','juil.','août','sept.','oct.','nov.','déc.'])[extract(month from p_start at time zone p_tz)::int]
    end
    || ' · ' || to_char(p_start at time zone p_tz, 'HH24:MI') || '–' || to_char(p_end at time zone p_tz, 'HH24:MI')
$$;

create function app.send_expo_push(p_messages jsonb) returns void
language plpgsql security definer set search_path = '' as $$
begin
  if p_messages is null or jsonb_array_length(p_messages) = 0 then return; end if;
  if to_regprocedure('net.http_post(text,jsonb,jsonb,jsonb,integer)') is null then return; end if;
  execute 'select net.http_post($1, $2, $3, $4, $5)'
    using 'https://exp.host/--/api/v2/push/send', p_messages, '{}'::jsonb,
          '{"Content-Type": "application/json", "Accept": "application/json"}'::jsonb, 10000;
end
$$;

-- Records and sends one notification per person, in the person's language. Never fails the caller.
create function app.notify(p_person_ids uuid[], p_title_fr text, p_body_fr text, p_title_en text, p_body_en text,
                           p_data jsonb default '{}') returns void
language plpgsql security definer set search_path = '' as $$
declare
  v_person record;
  v_messages jsonb := '[]'::jsonb;
  v_title text;
  v_body text;
  v_tokens text[];
begin
  for v_person in
    select p.id, p.preferred_locale from public.persons p where p.id = any (p_person_ids)
  loop
    v_title := case when v_person.preferred_locale = 'en-CA' then p_title_en else p_title_fr end;
    v_body := case when v_person.preferred_locale = 'en-CA' then p_body_en else p_body_fr end;
    select coalesce(array_agg(token), '{}') into v_tokens from app.push_tokens where person_id = v_person.id;
    insert into app.notifications (person_id, title, body, data, tokens) values (v_person.id, v_title, v_body, p_data, cardinality(v_tokens));
    select v_messages || coalesce(jsonb_agg(jsonb_build_object('to', t, 'title', v_title, 'body', v_body, 'data', p_data, 'sound', 'default')), '[]'::jsonb)
      into v_messages from unnest(v_tokens) t;
  end loop;
  -- Expo accepts up to 100 messages per request
  while jsonb_array_length(v_messages) > 0 loop
    perform app.send_expo_push((select jsonb_agg(m) from (select m from jsonb_array_elements(v_messages) m limit 100) x));
    v_messages := coalesce((select jsonb_agg(m) from (select m from jsonb_array_elements(v_messages) m offset 100) x), '[]'::jsonb);
  end loop;
exception when others then
  raise warning 'notify failed: %', sqlerrm;
end
$$;

create function public.register_push_token(p_token text, p_platform text) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_person uuid := app.my_person_id();
begin
  if v_person is null then return jsonb_build_object('ok', false, 'reason', 'not_a_member'); end if;
  if p_token !~ '^Expo(nent)?PushToken\[[A-Za-z0-9_-]{10,}\]$' or p_platform not in ('ios', 'android') then
    return jsonb_build_object('ok', false, 'reason', 'invalid_token');
  end if;
  insert into app.push_tokens (token, person_id, user_id, platform) values (p_token, v_person, auth.uid(), p_platform)
  on conflict (token) do update set person_id = excluded.person_id, user_id = excluded.user_id,
                                    platform = excluded.platform, updated_at = now();
  return jsonb_build_object('ok', true);
end
$$;

create function public.unregister_push_token(p_token text) returns jsonb
language sql volatile security definer set search_path = '' as $$
  with d as (delete from app.push_tokens where token = p_token and user_id = auth.uid() returning 1)
  select jsonb_build_object('ok', true, 'removed', (select count(*) from d))
$$;

create function public.set_my_locale(p_locale text) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
begin
  if p_locale not in ('fr-CA', 'en-CA') then return jsonb_build_object('ok', false, 'reason', 'invalid_locale'); end if;
  update public.persons set preferred_locale = p_locale where id = app.my_person_id();
  return jsonb_build_object('ok', found);
end
$$;

-- ---------------------------------------------------------------- Schedule notifications

create function app.person_of_employment(p_employment_id uuid) returns uuid
language sql stable security definer set search_path = '' as $$
  select person_id from public.employments where id = p_employment_id
$$;

create function app.notify_week_published() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  v_loc public.locations;
  v_people uuid[];
  v_date_fr text;
  v_date_en text;
begin
  if new.status <> 'published' or old.status = 'published' then return new; end if;
  select * into v_loc from public.locations where id = new.location_id;
  select array_agg(distinct e.person_id) into v_people
  from public.shifts s join public.employments e on e.id = s.employment_id
  where s.location_id = new.location_id and s.week_start = new.week_start;
  if v_people is null then return new; end if;
  v_date_fr := extract(day from new.week_start)::int || ' '
    || (array['janv.','févr.','mars','avr.','mai','juin','juil.','août','sept.','oct.','nov.','déc.'])[extract(month from new.week_start)::int];
  v_date_en := (array['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'])[extract(month from new.week_start)::int]
    || ' ' || extract(day from new.week_start)::int;
  perform app.notify(v_people,
    'Horaire publié', 'Votre horaire de la semaine du ' || v_date_fr || ' à ' || v_loc.name || ' est disponible.',
    'Schedule published', 'Your schedule for the week of ' || v_date_en || ' at ' || v_loc.name || ' is ready.',
    jsonb_build_object('type', 'schedule', 'location_id', new.location_id, 'week_start', new.week_start));
  return new;
end
$$;
create trigger notify_week_published after update of status on public.schedule_weeks
  for each row execute function app.notify_week_published();

-- Changes to a published week reach the people concerned (exchange approvals notify on their own).
create function app.notify_shift_change() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  v_row public.shifts := coalesce(new, old);
  v_loc public.locations;
  v_old_person uuid;
  v_new_person uuid;
  v_data jsonb;
begin
  if current_setting('app.swap_approval', true) = 'on' then return null; end if;
  if not app.is_week_published(v_row.location_id, v_row.week_start) then return null; end if;
  select * into v_loc from public.locations where id = v_row.location_id;
  v_data := jsonb_build_object('type', 'schedule', 'shift_id', v_row.id);
  if TG_OP in ('UPDATE', 'DELETE') and old.employment_id is not null then v_old_person := app.person_of_employment(old.employment_id); end if;
  if TG_OP in ('INSERT', 'UPDATE') and new.employment_id is not null then v_new_person := app.person_of_employment(new.employment_id); end if;

  if TG_OP = 'INSERT' and v_new_person is not null then
    perform app.notify(array[v_new_person],
      'Nouveau quart', app.fmt_when(new.starts_at, new.ends_at, v_loc.timezone, 'fr-CA') || ' · ' || v_loc.name,
      'New shift', app.fmt_when(new.starts_at, new.ends_at, v_loc.timezone, 'en-CA') || ' · ' || v_loc.name, v_data);
  elsif TG_OP = 'DELETE' and v_old_person is not null then
    perform app.notify(array[v_old_person],
      'Quart annulé', app.fmt_when(old.starts_at, old.ends_at, v_loc.timezone, 'fr-CA') || ' · ' || v_loc.name,
      'Shift cancelled', app.fmt_when(old.starts_at, old.ends_at, v_loc.timezone, 'en-CA') || ' · ' || v_loc.name, v_data);
  elsif TG_OP = 'UPDATE' then
    if v_old_person is distinct from v_new_person then
      if v_old_person is not null then
        perform app.notify(array[v_old_person],
          'Quart retiré', app.fmt_when(old.starts_at, old.ends_at, v_loc.timezone, 'fr-CA') || ' · ' || v_loc.name,
          'Shift removed', app.fmt_when(old.starts_at, old.ends_at, v_loc.timezone, 'en-CA') || ' · ' || v_loc.name, v_data);
      end if;
      if v_new_person is not null then
        perform app.notify(array[v_new_person],
          'Nouveau quart', app.fmt_when(new.starts_at, new.ends_at, v_loc.timezone, 'fr-CA') || ' · ' || v_loc.name,
          'New shift', app.fmt_when(new.starts_at, new.ends_at, v_loc.timezone, 'en-CA') || ' · ' || v_loc.name, v_data);
      end if;
    elsif v_new_person is not null and (new.starts_at <> old.starts_at or new.ends_at <> old.ends_at or new.location_id <> old.location_id) then
      perform app.notify(array[v_new_person],
        'Quart modifié', app.fmt_when(new.starts_at, new.ends_at, v_loc.timezone, 'fr-CA') || ' · ' || v_loc.name
          || ' (avant : ' || app.fmt_when(old.starts_at, old.ends_at, v_loc.timezone, 'fr-CA') || ')',
        'Shift changed', app.fmt_when(new.starts_at, new.ends_at, v_loc.timezone, 'en-CA') || ' · ' || v_loc.name
          || ' (was ' || app.fmt_when(old.starts_at, old.ends_at, v_loc.timezone, 'en-CA') || ')', v_data);
    end if;
  end if;
  return null;
end
$$;
create trigger notify_shift_change after insert or update or delete on public.shifts
  for each row execute function app.notify_shift_change();

-- Exchange requests: the colleague when asked; both people when decided.
create function app.notify_swap() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  v_shift public.shifts;
  v_loc public.locations;
  v_requester uuid := app.person_of_employment(new.requester_employment_id);
  v_target uuid := app.person_of_employment(new.target_employment_id);
  v_name text;
  v_when_fr text;
  v_when_en text;
  v_data jsonb := jsonb_build_object('type', 'swap', 'swap_id', new.id);
begin
  select * into v_shift from public.shifts where id = new.shift_id;
  select * into v_loc from public.locations where id = new.location_id;
  v_when_fr := app.fmt_when(v_shift.starts_at, v_shift.ends_at, v_loc.timezone, 'fr-CA') || ' · ' || v_loc.name;
  v_when_en := app.fmt_when(v_shift.starts_at, v_shift.ends_at, v_loc.timezone, 'en-CA') || ' · ' || v_loc.name;
  if TG_OP = 'INSERT' then
    select first_name into v_name from public.persons where id = v_requester;
    perform app.notify(array[v_target],
      'Demande d''échange', v_name || case when new.target_shift_id is null then ' vous offre un quart : ' else ' vous propose un échange : ' end || v_when_fr,
      'Exchange request', v_name || case when new.target_shift_id is null then ' offers you a shift: ' else ' proposes an exchange: ' end || v_when_en,
      v_data);
  elsif new.status <> old.status then
    if new.status = 'approved' then
      perform app.notify(array[v_requester, v_target], 'Échange approuvé', v_when_fr, 'Exchange approved', v_when_en, v_data);
    elsif new.status = 'refused_manager' then
      perform app.notify(array[v_requester, v_target], 'Échange refusé', v_when_fr, 'Exchange refused', v_when_en, v_data);
    elsif new.status = 'refused_colleague' then
      select first_name into v_name from public.persons where id = v_target;
      perform app.notify(array[v_requester], 'Échange refusé', v_name || ' a refusé : ' || v_when_fr,
        'Exchange refused', v_name || ' refused: ' || v_when_en, v_data);
    end if;
  end if;
  return null;
end
$$;
create trigger notify_swap after insert or update of status on public.shift_swaps
  for each row execute function app.notify_swap();

create function app.notify_request_decision() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  v_fr text;
  v_en text;
begin
  if new.status = old.status or new.status not in ('approved', 'refused') then return null; end if;
  if TG_TABLE_NAME = 'time_off_requests' then
    v_fr := case new.status when 'approved' then 'Congé approuvé' else 'Congé refusé' end;
    v_en := case new.status when 'approved' then 'Time off approved' else 'Time off refused' end;
    perform app.notify(array[new.person_id],
      v_fr, to_char(new.start_date, 'YYYY-MM-DD') || case when new.end_date > new.start_date then ' → ' || to_char(new.end_date, 'YYYY-MM-DD') else '' end
        || coalesce(' · ' || new.manager_note, ''),
      v_en, to_char(new.start_date, 'YYYY-MM-DD') || case when new.end_date > new.start_date then ' → ' || to_char(new.end_date, 'YYYY-MM-DD') else '' end
        || coalesce(' · ' || new.manager_note, ''),
      jsonb_build_object('type', 'time_off', 'id', new.id));
  else
    v_fr := case new.status when 'approved' then 'Correction de pointage approuvée' else 'Correction de pointage refusée' end;
    v_en := case new.status when 'approved' then 'Punch correction approved' else 'Punch correction refused' end;
    perform app.notify(array[new.person_id], v_fr, coalesce(new.manager_note, ''), v_en, coalesce(new.manager_note, ''),
      jsonb_build_object('type', 'punch_correction', 'id', new.id));
  end if;
  return null;
end
$$;
create trigger notify_time_off_decision after update of status on public.time_off_requests
  for each row execute function app.notify_request_decision();

-- ================================================================ Missed-punch functions

create function public.request_punch_correction(p_location_id uuid, p_kind public.punch_kind, p_occurred_at timestamptz,
                                                p_reason text, p_punch_id uuid default null) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_person uuid := app.my_person_id();
  v_employment uuid;
  v_id uuid;
begin
  select e.id into v_employment
  from public.employments e
  join public.employment_locations el on el.employment_id = e.id and el.location_id = p_location_id
  where e.person_id = v_person
  limit 1;
  if v_employment is null then return jsonb_build_object('ok', false, 'reason', 'not_assigned'); end if;
  if p_occurred_at > now() + interval '5 minutes' then return jsonb_build_object('ok', false, 'reason', 'future'); end if;
  if p_occurred_at < now() - interval '31 days' then return jsonb_build_object('ok', false, 'reason', 'too_old'); end if;
  if length(btrim(coalesce(p_reason, ''))) < 3 then return jsonb_build_object('ok', false, 'reason', 'reason_required'); end if;
  if p_punch_id is not null and not exists (select 1 from public.punches where id = p_punch_id and person_id = v_person) then
    return jsonb_build_object('ok', false, 'reason', 'not_allowed');
  end if;
  insert into public.punch_corrections (person_id, employment_id, location_id, punch_id, kind, occurred_at, reason, requested_by)
  values (v_person, v_employment, p_location_id, p_punch_id, p_kind, p_occurred_at, btrim(p_reason), v_person)
  returning id into v_id;
  return jsonb_build_object('ok', true, 'id', v_id);
end
$$;

create function public.cancel_punch_correction(p_id uuid) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
begin
  update public.punch_corrections set status = 'cancelled'
  where id = p_id and status = 'pending' and person_id = app.my_person_id();
  return jsonb_build_object('ok', found);
end
$$;

create function public.decide_punch_correction(p_id uuid, p_approve boolean, p_note text default null) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_c public.punch_corrections;
begin
  select * into v_c from public.punch_corrections where id = p_id for update;
  if v_c.id is null or not app.can(v_c.location_id, 'punches') then return jsonb_build_object('ok', false, 'reason', 'not_allowed'); end if;
  if v_c.status <> 'pending' then return jsonb_build_object('ok', false, 'reason', 'not_pending'); end if;
  if p_approve then
    if v_c.punch_id is null then
      insert into public.punches (account_id, person_id, employment_id, location_id, kind, method, occurred_at, flags)
      values (v_c.account_id, v_c.person_id, v_c.employment_id, v_c.location_id, v_c.kind, 'manual', v_c.occurred_at, array['correction']);
    else
      update public.punches
      set occurred_at = v_c.occurred_at, kind = v_c.kind,
          flags = case when 'corrected' = any (flags) then flags else array_append(flags, 'corrected') end
      where id = v_c.punch_id;
    end if;
  end if;
  update public.punch_corrections
  set status = case when p_approve then 'approved'::public.request_status else 'refused'::public.request_status end,
      decided_by = app.my_person_id(), decided_at = now(), manager_note = nullif(btrim(coalesce(p_note, '')), '')
  where id = p_id;
  return jsonb_build_object('ok', true);
end
$$;
create trigger notify_punch_correction_decision after update of status on public.punch_corrections
  for each row execute function app.notify_request_decision();

-- A manager adds a forgotten punch directly; it's logged as an approved correction.
create function public.manager_add_punch(p_person_id uuid, p_location_id uuid, p_kind public.punch_kind,
                                         p_occurred_at timestamptz, p_note text) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_employment uuid;
  v_account uuid;
begin
  if not app.can(p_location_id, 'punches') then return jsonb_build_object('ok', false, 'reason', 'not_allowed'); end if;
  if length(btrim(coalesce(p_note, ''))) < 3 then return jsonb_build_object('ok', false, 'reason', 'reason_required'); end if;
  if p_occurred_at > now() + interval '5 minutes' then return jsonb_build_object('ok', false, 'reason', 'future'); end if;
  select e.id, e.account_id into v_employment, v_account
  from public.employments e
  join public.employment_locations el on el.employment_id = e.id and el.location_id = p_location_id
  where e.person_id = p_person_id
  limit 1;
  if v_employment is null then return jsonb_build_object('ok', false, 'reason', 'not_assigned'); end if;
  insert into public.punches (account_id, person_id, employment_id, location_id, kind, method, occurred_at, flags)
  values (v_account, p_person_id, v_employment, p_location_id, p_kind, 'manual', p_occurred_at, array['added_by_manager']);
  insert into public.punch_corrections (person_id, employment_id, location_id, kind, occurred_at, reason, status,
                                        requested_by, decided_by, decided_at)
  values (p_person_id, v_employment, p_location_id, p_kind, p_occurred_at, btrim(p_note), 'approved',
          app.my_person_id(), app.my_person_id(), now());
  return jsonb_build_object('ok', true);
end
$$;

-- ================================================================ Time off and availability functions

create function public.request_time_off(p_type public.time_off_type, p_start date, p_end date,
                                        p_start_time time default null, p_end_time time default null,
                                        p_note text default null) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_person uuid := app.my_person_id();
  v_id uuid;
begin
  if v_person is null then return jsonb_build_object('ok', false, 'reason', 'not_a_member'); end if;
  if p_end < p_start or p_end - p_start > 366 then return jsonb_build_object('ok', false, 'reason', 'invalid_dates'); end if;
  if (p_start_time is null) <> (p_end_time is null)
     or (p_start_time is not null and (p_start_time >= p_end_time or p_start <> p_end)) then
    return jsonb_build_object('ok', false, 'reason', 'invalid_times');
  end if;
  if p_end < current_date - 31 then return jsonb_build_object('ok', false, 'reason', 'too_old'); end if;
  insert into public.time_off_requests (person_id, type, start_date, end_date, start_time, end_time, note)
  values (v_person, p_type, p_start, p_end, p_start_time, p_end_time, nullif(btrim(coalesce(p_note, '')), ''))
  returning id into v_id;
  return jsonb_build_object('ok', true, 'id', v_id);
end
$$;

create function public.cancel_time_off(p_id uuid) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
begin
  update public.time_off_requests set status = 'cancelled'
  where id = p_id and person_id = app.my_person_id()
    and (status = 'pending' or (status = 'approved' and start_date > current_date));
  return jsonb_build_object('ok', found);
end
$$;

create function public.decide_time_off(p_id uuid, p_approve boolean, p_paid_hours numeric default null, p_note text default null) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_r public.time_off_requests;
begin
  select * into v_r from public.time_off_requests where id = p_id for update;
  if v_r.id is null or not (app.can_manage_person(v_r.person_id) or app.can_for_person(v_r.person_id, 'schedule')) then
    return jsonb_build_object('ok', false, 'reason', 'not_allowed');
  end if;
  if v_r.status <> 'pending' then return jsonb_build_object('ok', false, 'reason', 'not_pending'); end if;
  update public.time_off_requests
  set status = case when p_approve then 'approved'::public.request_status else 'refused'::public.request_status end,
      paid_hours = case when p_approve then p_paid_hours else null end,
      decided_by = app.my_person_id(), decided_at = now(), manager_note = nullif(btrim(coalesce(p_note, '')), '')
  where id = p_id;
  return jsonb_build_object('ok', true);
end
$$;

-- New weekly availability replaces the approved one when a manager approves it.
create function public.decide_availability(p_person_id uuid, p_approve boolean) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
begin
  if not (app.can_manage_person(p_person_id) or app.can_for_person(p_person_id, 'schedule')) then
    return jsonb_build_object('ok', false, 'reason', 'not_allowed');
  end if;
  if not exists (select 1 from public.availability_rules where person_id = p_person_id and status = 'pending') then
    return jsonb_build_object('ok', false, 'reason', 'not_pending');
  end if;
  if p_approve then
    delete from public.availability_rules where person_id = p_person_id and status = 'approved';
    update public.availability_rules set status = 'approved' where person_id = p_person_id and status = 'pending';
  else
    delete from public.availability_rules where person_id = p_person_id and status = 'pending';
  end if;
  perform app.notify(array[p_person_id],
    case when p_approve then 'Disponibilités approuvées' else 'Disponibilités refusées' end, '',
    case when p_approve then 'Availability approved' else 'Availability refused' end, '',
    jsonb_build_object('type', 'availability'));
  return jsonb_build_object('ok', true);
end
$$;

-- ================================================================ Open-shift coverage functions

create function app.open_shift_ok(p_shift public.shifts) returns boolean
language sql stable security definer set search_path = '' as $$
  select p_shift.id is not null and p_shift.employment_id is null and p_shift.starts_at > now()
         and app.is_week_published(p_shift.location_id, p_shift.week_start)
$$;

create function public.claim_open_shift(p_shift_id uuid) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_shift public.shifts;
  v_employment uuid;
begin
  select * into v_shift from public.shifts where id = p_shift_id;
  if not coalesce(app.open_shift_ok(v_shift), false) then return jsonb_build_object('ok', false, 'reason', 'not_open'); end if;
  select e.id into v_employment
  from public.employments e
  join public.employment_locations el on el.employment_id = e.id and el.location_id = v_shift.location_id
  where e.person_id = app.my_person_id() and (e.end_date is null or e.end_date >= current_date)
  limit 1;
  if v_employment is null then return jsonb_build_object('ok', false, 'reason', 'not_assigned'); end if;
  if app.person_busy(v_employment, v_shift.starts_at, v_shift.ends_at, '{}') then
    return jsonb_build_object('ok', false, 'reason', 'busy');
  end if;
  insert into public.shift_claims (shift_id, location_id, employment_id) values (v_shift.id, v_shift.location_id, v_employment)
  on conflict (shift_id, employment_id) do update set status = 'pending', created_at = now(), decided_at = null;
  return jsonb_build_object('ok', true);
end
$$;

create function public.withdraw_claim(p_shift_id uuid) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
begin
  update public.shift_claims set status = 'cancelled'
  where shift_id = p_shift_id and status = 'pending' and employment_id in (select app.my_employment_ids());
  return jsonb_build_object('ok', found);
end
$$;

-- A scheduler gives an open shift to someone (a volunteer or anyone assigned to the clinic).
create function public.assign_open_shift(p_shift_id uuid, p_employment_id uuid) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_shift public.shifts;
  v_claimed boolean;
begin
  select * into v_shift from public.shifts where id = p_shift_id for update;
  if v_shift.id is null or not app.can(v_shift.location_id, 'schedule') then return jsonb_build_object('ok', false, 'reason', 'not_allowed'); end if;
  if v_shift.employment_id is not null then return jsonb_build_object('ok', false, 'reason', 'not_open'); end if;
  if not exists (
    select 1 from public.employments e
    join public.employment_locations el on el.employment_id = e.id and el.location_id = v_shift.location_id
    where e.id = p_employment_id and (e.end_date is null or e.end_date >= current_date)
  ) then
    return jsonb_build_object('ok', false, 'reason', 'not_assigned');
  end if;
  if app.person_busy(p_employment_id, v_shift.starts_at, v_shift.ends_at, array[v_shift.id]) then
    return jsonb_build_object('ok', false, 'reason', 'overlap');
  end if;
  v_claimed := exists (select 1 from public.shift_claims where shift_id = p_shift_id and employment_id = p_employment_id and status = 'pending');
  update public.shifts set employment_id = p_employment_id where id = p_shift_id;
  -- A volunteer already said yes: no new acknowledgement needed
  if v_claimed then
    perform set_config('app.swap_approval', 'on', true);
    update public.shifts set response = 'confirmed' where id = p_shift_id;
    perform set_config('app.swap_approval', 'off', true);
  end if;
  update public.shift_claims
  set status = case when employment_id = p_employment_id then 'approved'::public.request_status else 'refused'::public.request_status end,
      decided_at = now()
  where shift_id = p_shift_id and status = 'pending';
  return jsonb_build_object('ok', true);
end
$$;

-- Ask everyone who could take an open shift (assigned to the clinic, not already working then).
create function public.request_coverage(p_shift_id uuid) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_shift public.shifts;
  v_loc public.locations;
  v_people uuid[];
begin
  select * into v_shift from public.shifts where id = p_shift_id;
  if v_shift.id is null or not app.can(v_shift.location_id, 'schedule') then return jsonb_build_object('ok', false, 'reason', 'not_allowed'); end if;
  if not app.open_shift_ok(v_shift) then return jsonb_build_object('ok', false, 'reason', 'not_open'); end if;
  select * into v_loc from public.locations where id = v_shift.location_id;
  select array_agg(distinct e.person_id) into v_people
  from public.employments e
  join public.employment_locations el on el.employment_id = e.id and el.location_id = v_shift.location_id
  where (e.end_date is null or e.end_date >= current_date)
    and not app.person_busy(e.id, v_shift.starts_at, v_shift.ends_at, '{}')
    and not exists (
      select 1 from public.time_off_requests t
      where t.person_id = e.person_id and t.status = 'approved'
        and (v_shift.starts_at at time zone v_loc.timezone)::date between t.start_date and t.end_date
    );
  if v_people is not null then
    perform app.notify(v_people,
      'Quart disponible', v_loc.name || ' · ' || app.fmt_when(v_shift.starts_at, v_shift.ends_at, v_loc.timezone, 'fr-CA') || '. Ouvrez l''application pour le prendre.',
      'Shift available', v_loc.name || ' · ' || app.fmt_when(v_shift.starts_at, v_shift.ends_at, v_loc.timezone, 'en-CA') || '. Open the app to take it.',
      jsonb_build_object('type', 'open_shift', 'shift_id', v_shift.id));
  end if;
  return jsonb_build_object('ok', true, 'notified', coalesce(cardinality(v_people), 0));
end
$$;

-- ================================================================ One schedule across companies

-- The shifts of the people I schedule, at every clinic of the account (other companies included),
-- with the employments they belong to, so the rules see overlaps, weekly hours and rest.
create function public.busy_shifts(p_person_ids uuid[], p_from timestamptz, p_to timestamptz) returns jsonb
language sql stable security definer set search_path = '' as $$
  with people as (
    select id from public.persons
    where id = any (p_person_ids) and account_id = app.my_account_id() and app.can_for_person(id, 'schedule')
  ),
  emps as (
    select e.* from public.employments e where e.person_id in (select id from people)
  )
  select jsonb_build_object(
    'employments', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', e.id, 'person_id', e.person_id, 'company_id', e.company_id, 'job_role_id', e.job_role_id,
        'location_ids', coalesce((select jsonb_agg(el.location_id) from public.employment_locations el where el.employment_id = e.id), '[]'::jsonb)))
      from emps e), '[]'::jsonb),
    'shifts', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', s.id, 'employment_id', s.employment_id, 'location_id', s.location_id, 'week_start', s.week_start,
        'starts_at', s.starts_at, 'ends_at', s.ends_at, 'unpaid_break_minutes', s.unpaid_break_minutes,
        'job_role_id', s.job_role_id, 'published', app.is_week_published(s.location_id, s.week_start)))
      from public.shifts s
      where s.employment_id in (select id from emps) and s.starts_at < p_to and s.ends_at > p_from), '[]'::jsonb)
  )
$$;

-- ================================================================ Grants

revoke all on public.punch_history, public.punch_corrections, public.timesheet_approvals, public.time_off_requests,
  public.shift_claims, public.coverage_rules, public.credentials from anon;
grant select on public.punch_history, public.punch_corrections, public.time_off_requests, public.shift_claims to authenticated;
revoke insert, update, delete on public.punch_history, public.punch_corrections, public.time_off_requests, public.shift_claims from authenticated;
grant select, insert, delete on public.timesheet_approvals to authenticated;
revoke update on public.timesheet_approvals from authenticated;
grant select, insert, update, delete on public.coverage_rules, public.credentials to authenticated;

do $$
declare
  f text;
begin
  foreach f in array array[
    'public.register_push_token(text, text)', 'public.unregister_push_token(text)', 'public.set_my_locale(text)',
    'public.request_punch_correction(uuid, public.punch_kind, timestamptz, text, uuid)', 'public.cancel_punch_correction(uuid)',
    'public.decide_punch_correction(uuid, boolean, text)', 'public.manager_add_punch(uuid, uuid, public.punch_kind, timestamptz, text)',
    'public.request_time_off(public.time_off_type, date, date, time, time, text)', 'public.cancel_time_off(uuid)',
    'public.decide_time_off(uuid, boolean, numeric, text)', 'public.decide_availability(uuid, boolean)',
    'public.claim_open_shift(uuid)', 'public.withdraw_claim(uuid)', 'public.assign_open_shift(uuid, uuid)',
    'public.request_coverage(uuid)', 'public.busy_shifts(uuid[], timestamptz, timestamptz)'
  ] loop
    execute format('revoke execute on function %s from public, anon', f);
    execute format('grant execute on function %s to authenticated', f);
  end loop;
end
$$;

-- Internal helpers: not callable by clients.
revoke execute on function app.notify(uuid[], text, text, text, text, jsonb), app.send_expo_push(jsonb) from public;
grant execute on function app.fmt_when(timestamptz, timestamptz, text, text), app.person_of_employment(uuid),
  app.open_shift_ok(public.shifts) to authenticated;
