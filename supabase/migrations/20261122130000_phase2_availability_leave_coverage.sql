-- Phase 2, part 1 (Nov 22): availability, time off, finding coverage, acknowledgements.
--
--  Availability: "I'm available" and "I'm unavailable", weekly (every week or alternating weeks),
--  with effective dates and the clinics it applies to; one-off days or date ranges, full or partial.
--  Time off: leave types configured per account; the reason is visible only to the employee and the
--  people who manage them (not to schedulers); approving can free the employee's shifts at the clinics
--  the approver schedules and tells the other clinics' schedulers.
--  Find coverage: invite eligible employees to an open shift; the first to accept gets it, atomically.
--  Acknowledgements: schedulers see which shift changes employees haven't seen yet and can remind them.

-- ---------------------------------------------------------------- helpers

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
                          'custom_role_assignments', 'shift_swaps', 'shift_claims', 'coverage_rules', 'punch_corrections',
                          'coverage_offers', 'staffing_ratio_rules', 'schedule_templates') then
    select account_id into v_account from public.locations where id = new.location_id;
  elsif TG_TABLE_NAME in ('availability_rules', 'availability_exceptions', 'role_assignments', 'time_off_requests', 'credentials',
                          'time_off_reasons', 'coverage_invites') then
    select account_id into v_account from public.persons where id = new.person_id;
  elsif TG_TABLE_NAME in ('persons', 'job_roles', 'leave_types') then
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

-- People who can schedule at a clinic: owner, admin of its company, its manager, custom roles with "schedule".
create function app.schedulers_of(p_location_id uuid) returns uuid[]
language sql stable security definer set search_path = '' as $$
  select coalesce(array_agg(distinct x.person_id), '{}') from (
    select ra.person_id
    from public.role_assignments ra
    join public.locations l on l.id = p_location_id and l.account_id = ra.account_id
    where ra.role = 'owner'
       or (ra.role = 'company_admin' and ra.company_id = l.company_id)
       or (ra.role = 'clinic_manager' and ra.location_id = l.id)
    union
    select a.person_id
    from public.custom_role_assignments a
    join public.custom_roles r on r.id = a.custom_role_id
    where a.location_id = p_location_id and 'schedule' = any (r.permissions)
  ) x
$$;

create function app.is_admin() returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.role_assignments ra join public.persons p on p.id = ra.person_id
    where p.user_id = app.uid() and ra.role in ('owner', 'company_admin')
  )
$$;

-- ---------------------------------------------------------------- availability

alter table public.availability_rules
  add column kind text not null default 'available' check (kind in ('available', 'unavailable')),
  add column effective_to date,
  add column every_weeks smallint not null default 1 check (every_weeks in (1, 2)),
  -- For alternating weeks: the Monday of a week the rule applies to ("week A").
  add column anchor_week date check (anchor_week is null or extract(isodow from anchor_week) = 1),
  -- Clinics this applies to; null = all of the person's clinics.
  add column location_ids uuid[],
  add constraint availability_rules_effective check (effective_to is null or effective_to >= effective_from);

alter table public.availability_exceptions
  add column kind text not null default 'unavailable' check (kind in ('available', 'unavailable')),
  add column end_date date,
  add column location_ids uuid[],
  add column created_at timestamptz not null default now(),
  add constraint availability_exceptions_range check (end_date is null or (end_date >= date and end_date - date <= 366));

-- Clinics chosen by the employee must be clinics they work at.
create function app.check_availability_locations() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if new.location_ids is not null and exists (
    select 1 from unnest(new.location_ids) as x(id)
    where not exists (
      select 1 from public.employment_locations el join public.employments e on e.id = el.employment_id
      where e.person_id = new.person_id and el.location_id = x.id
    )
  ) then
    raise exception 'A chosen clinic is not one of this person''s clinics' using errcode = '23514';
  end if;
  if new.location_ids is not null and cardinality(new.location_ids) = 0 then
    new.location_ids := null;
  end if;
  return new;
end
$$;
create trigger check_locations before insert or update of location_ids on public.availability_rules
  for each row execute function app.check_availability_locations();
create trigger check_locations before insert or update of location_ids on public.availability_exceptions
  for each row execute function app.check_availability_locations();

-- A new weekly pattern replaces the approved one from its start date; the old one is kept as history.
create or replace function public.decide_availability(p_person_id uuid, p_approve boolean) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_from date;
begin
  if not (app.can_manage_person(p_person_id) or app.can_for_person(p_person_id, 'schedule')) then
    return jsonb_build_object('ok', false, 'reason', 'not_allowed');
  end if;
  select min(effective_from) into v_from from public.availability_rules where person_id = p_person_id and status = 'pending';
  if v_from is null then
    return jsonb_build_object('ok', false, 'reason', 'not_pending');
  end if;
  if p_approve then
    delete from public.availability_rules where person_id = p_person_id and status = 'approved' and effective_from >= v_from;
    update public.availability_rules set effective_to = v_from - 1
    where person_id = p_person_id and status = 'approved' and (effective_to is null or effective_to >= v_from);
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

create function public.decide_availability_exception(p_id uuid, p_approve boolean) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_x public.availability_exceptions;
begin
  select * into v_x from public.availability_exceptions where id = p_id for update;
  if v_x.id is null or not (app.can_manage_person(v_x.person_id) or app.can_for_person(v_x.person_id, 'schedule')) then
    return jsonb_build_object('ok', false, 'reason', 'not_allowed');
  end if;
  if v_x.status <> 'pending' then return jsonb_build_object('ok', false, 'reason', 'not_pending'); end if;
  update public.availability_exceptions set status = case when p_approve then 'approved'::public.approval_status else 'rejected'::public.approval_status end
  where id = p_id;
  perform app.notify(array[v_x.person_id],
    case when p_approve then 'Disponibilité approuvée' else 'Disponibilité refusée' end,
    to_char(v_x.date, 'YYYY-MM-DD') || coalesce(' → ' || to_char(v_x.end_date, 'YYYY-MM-DD'), ''),
    case when p_approve then 'Availability approved' else 'Availability refused' end,
    to_char(v_x.date, 'YYYY-MM-DD') || coalesce(' → ' || to_char(v_x.end_date, 'YYYY-MM-DD'), ''),
    jsonb_build_object('type', 'availability'));
  return jsonb_build_object('ok', true);
end
$$;

-- ---------------------------------------------------------------- leave types and private reasons

create table public.leave_types (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references public.accounts on delete cascade,
  -- What payroll sees (vacation, sick, personal, unpaid, other)
  category public.time_off_type not null,
  name_fr text not null check (length(btrim(name_fr)) between 1 and 60),
  name_en text not null check (length(btrim(name_en)) between 1 and 60),
  active boolean not null default true,
  sort smallint not null default 0,
  created_at timestamptz not null default now()
);
create unique index leave_types_account_name_key on public.leave_types (account_id, lower(btrim(name_fr)));
create trigger fill_account_id before insert or update of account_id on public.leave_types
  for each row execute function app.fill_account_id();
alter table public.leave_types enable row level security;
create policy "members read leave types" on public.leave_types for select to authenticated
  using (account_id = (select app.my_account_id()));
create policy "admins add leave types" on public.leave_types for insert to authenticated
  with check (account_id = (select app.my_account_id()) and (select app.is_admin()));
create policy "admins edit leave types" on public.leave_types for update to authenticated
  using (account_id = (select app.my_account_id()) and (select app.is_admin()))
  with check (account_id = (select app.my_account_id()) and (select app.is_admin()));

create function app.seed_leave_types(p_account_id uuid) returns void
language sql volatile security definer set search_path = '' as $$
  insert into public.leave_types (account_id, category, name_fr, name_en, sort) values
    (p_account_id, 'vacation', 'Vacances', 'Vacation', 1),
    (p_account_id, 'sick', 'Maladie', 'Sick leave', 2),
    (p_account_id, 'personal', 'Personnel', 'Personal', 3),
    (p_account_id, 'unpaid', 'Sans solde', 'Unpaid', 4),
    (p_account_id, 'other', 'Autre', 'Other', 5)
  on conflict do nothing
$$;
select app.seed_leave_types(id) from public.accounts;

create function app.on_account_created() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  perform app.seed_leave_types(new.id);
  return null;
end
$$;
create trigger seed_leave_types after insert on public.accounts
  for each row execute function app.on_account_created();

alter table public.time_off_requests add column leave_type_id uuid references public.leave_types on delete set null;
update public.time_off_requests t set leave_type_id = lt.id
from public.leave_types lt where lt.account_id = t.account_id and lt.category = t.type and t.leave_type_id is null;

-- The reason: only the employee and the people who manage them (owner, employer's admins,
-- clinic managers or roles with the "employees" permission at their clinics).
create table public.time_off_reasons (
  request_id uuid primary key references public.time_off_requests on delete cascade,
  account_id uuid not null references public.accounts on delete cascade,
  person_id uuid not null references public.persons on delete cascade,
  reason text not null check (length(reason) between 1 and 500)
);
create trigger fill_account_id before insert or update of account_id on public.time_off_reasons
  for each row execute function app.fill_account_id();
alter table public.time_off_reasons enable row level security;
create policy "employee and their managers read reasons" on public.time_off_reasons for select to authenticated
  using (person_id = (select app.my_person_id()) or app.can_manage_person(person_id));

insert into public.time_off_reasons (request_id, account_id, person_id, reason)
select id, account_id, person_id, note from public.time_off_requests where note is not null;
update public.time_off_requests set note = null where note is not null;
alter table public.time_off_requests add constraint time_off_note_moved check (note is null);

-- Overlap of a leave with a shift, in the clinic's time zone.
create function app.leave_range(p_r public.time_off_requests, p_tz text) returns tstzrange
language sql stable set search_path = '' as $$
  select tstzrange(
    (p_r.start_date + coalesce(p_r.start_time, time '00:00')) at time zone p_tz,
    case when p_r.end_time is not null then (p_r.end_date + p_r.end_time) at time zone p_tz
         else ((p_r.end_date + 1) + time '00:00') at time zone p_tz end,
    '[)')
$$;

create function public.request_leave(p_leave_type_id uuid, p_start date, p_end date,
                                     p_start_time time default null, p_end_time time default null,
                                     p_reason text default null) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_person uuid := app.my_person_id();
  v_type public.leave_types;
  v_id uuid;
  v_reason text := nullif(btrim(coalesce(p_reason, '')), '');
begin
  if v_person is null then return jsonb_build_object('ok', false, 'reason', 'not_a_member'); end if;
  select * into v_type from public.leave_types where id = p_leave_type_id and account_id = app.my_account_id() and active;
  if v_type.id is null then return jsonb_build_object('ok', false, 'reason', 'bad_type'); end if;
  if p_end < p_start or p_end - p_start > 366 then return jsonb_build_object('ok', false, 'reason', 'invalid_dates'); end if;
  if (p_start_time is null) <> (p_end_time is null)
     or (p_start_time is not null and (p_start_time >= p_end_time or p_start <> p_end)) then
    return jsonb_build_object('ok', false, 'reason', 'invalid_times');
  end if;
  if p_end < current_date - 31 then return jsonb_build_object('ok', false, 'reason', 'too_old'); end if;
  if length(v_reason) > 500 then return jsonb_build_object('ok', false, 'reason', 'too_long'); end if;
  if exists (
    select 1 from public.time_off_requests t
    where t.person_id = v_person and t.status in ('pending', 'approved')
      and t.start_date <= p_end and t.end_date >= p_start
      and (t.start_time is null or p_start_time is null or (t.start_time < p_end_time and t.end_time > p_start_time))
  ) then
    return jsonb_build_object('ok', false, 'reason', 'overlaps');
  end if;
  insert into public.time_off_requests (person_id, type, leave_type_id, start_date, end_date, start_time, end_time)
  values (v_person, v_type.category, v_type.id, p_start, p_end, p_start_time, p_end_time)
  returning id into v_id;
  if v_reason is not null then
    insert into public.time_off_reasons (request_id, person_id, reason) values (v_id, v_person, v_reason);
  end if;
  return jsonb_build_object('ok', true, 'id', v_id);
end
$$;

-- Older phone versions (0.3, 0.4) call this one: same rules, reason kept private.
create or replace function public.request_time_off(p_type public.time_off_type, p_start date, p_end date,
                                                   p_start_time time default null, p_end_time time default null,
                                                   p_note text default null) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_type uuid;
begin
  select id into v_type from public.leave_types
  where account_id = app.my_account_id() and category = p_type and active order by sort limit 1;
  if v_type is null then return jsonb_build_object('ok', false, 'reason', 'bad_type'); end if;
  return public.request_leave(v_type, p_start, p_end, p_start_time, p_end_time, p_note);
end
$$;

-- The person's shifts during a leave, at every clinic (times and clinic only).
create function public.time_off_impact(p_id uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v_r public.time_off_requests;
begin
  select * into v_r from public.time_off_requests where id = p_id;
  if v_r.id is null or not (v_r.person_id = app.my_person_id() or app.can_manage_person(v_r.person_id)
                            or app.can_for_person(v_r.person_id, 'schedule')) then
    return jsonb_build_object('ok', false, 'reason', 'not_allowed');
  end if;
  return jsonb_build_object('ok', true, 'shifts', coalesce((
    select jsonb_agg(jsonb_build_object(
      'id', s.id, 'location_id', s.location_id, 'location_name', l.name, 'starts_at', s.starts_at, 'ends_at', s.ends_at,
      'week_start', s.week_start, 'can_schedule', app.can(s.location_id, 'schedule')) order by s.starts_at)
    from public.shifts s
    join public.employments e on e.id = s.employment_id
    join public.locations l on l.id = s.location_id
    where e.person_id = v_r.person_id and tstzrange(s.starts_at, s.ends_at) && app.leave_range(v_r, l.timezone)
  ), '[]'::jsonb));
end
$$;

create function public.decide_leave(p_id uuid, p_approve boolean, p_paid_hours numeric default null,
                                    p_note text default null, p_release_shifts boolean default false) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_r public.time_off_requests;
  v_released uuid[] := '{}';
  v_loc record;
  v_name text;
  v_when text;
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
  where id = p_id
  returning * into v_r;
  if not p_approve then return jsonb_build_object('ok', true, 'released', '[]'::jsonb); end if;

  -- Free the shifts at the clinics the approver schedules: they become open shifts for the same position.
  if p_release_shifts then
    with affected as (
      select s.id, e.job_role_id
      from public.shifts s
      join public.employments e on e.id = s.employment_id
      join public.locations l on l.id = s.location_id
      where e.person_id = v_r.person_id and s.starts_at > now()
        and tstzrange(s.starts_at, s.ends_at) && app.leave_range(v_r, l.timezone)
        and app.can(s.location_id, 'schedule')
      for update of s
    ), freed as (
      update public.shifts s set employment_id = null, job_role_id = coalesce(s.job_role_id, a.job_role_id)
      from affected a where s.id = a.id
      returning s.id
    )
    select coalesce(array_agg(id), '{}') into v_released from freed;
  end if;

  -- Other clinics where the person still has shifts during the leave: tell their schedulers.
  select first_name || ' ' || last_name into v_name from public.persons where id = v_r.person_id;
  v_when := to_char(v_r.start_date, 'YYYY-MM-DD') || case when v_r.end_date > v_r.start_date then ' → ' || to_char(v_r.end_date, 'YYYY-MM-DD') else '' end;
  for v_loc in
    select distinct l.id, l.name
    from public.shifts s
    join public.employments e on e.id = s.employment_id
    join public.locations l on l.id = s.location_id
    where e.person_id = v_r.person_id and s.starts_at > now()
      and tstzrange(s.starts_at, s.ends_at) && app.leave_range(v_r, l.timezone)
  loop
    perform app.notify(array_remove(app.schedulers_of(v_loc.id), app.my_person_id()),
      'Absence approuvée', v_name || ' sera absent(e) ' || v_when || ' et a un quart à ' || v_loc.name || '. À remplacer.',
      'Leave approved', v_name || ' will be away ' || v_when || ' and has a shift at ' || v_loc.name || '. Needs cover.',
      jsonb_build_object('type', 'schedule', 'location_id', v_loc.id));
  end loop;
  return jsonb_build_object('ok', true, 'released', to_jsonb(v_released));
end
$$;

create or replace function public.decide_time_off(p_id uuid, p_approve boolean, p_paid_hours numeric default null, p_note text default null) returns jsonb
language sql volatile security definer set search_path = '' as $$
  select public.decide_leave(p_id, p_approve, p_paid_hours, p_note, false)
$$;

-- ---------------------------------------------------------------- find coverage

create type public.offer_status as enum ('open', 'filled', 'cancelled');
create type public.invite_status as enum ('invited', 'accepted', 'declined', 'expired');

create table public.coverage_offers (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references public.accounts on delete cascade,
  shift_id uuid not null references public.shifts on delete cascade,
  location_id uuid not null references public.locations on delete cascade,
  status public.offer_status not null default 'open',
  created_by uuid references public.persons on delete set null,
  filled_employment_id uuid references public.employments on delete set null,
  filled_at timestamptz,
  created_at timestamptz not null default now()
);
create unique index coverage_offers_one_open on public.coverage_offers (shift_id) where status = 'open';
create index on public.coverage_offers (location_id, status);
create trigger fill_account_id before insert or update of account_id on public.coverage_offers
  for each row execute function app.fill_account_id();

create table public.coverage_invites (
  offer_id uuid not null references public.coverage_offers on delete cascade,
  employment_id uuid not null references public.employments on delete cascade,
  person_id uuid not null references public.persons on delete cascade,
  account_id uuid not null references public.accounts on delete cascade,
  status public.invite_status not null default 'invited',
  invited_at timestamptz not null default now(),
  responded_at timestamptz,
  primary key (offer_id, employment_id)
);
create index on public.coverage_invites (person_id, status);
create trigger fill_account_id before insert or update of account_id on public.coverage_invites
  for each row execute function app.fill_account_id();

alter table public.coverage_offers enable row level security;
alter table public.coverage_invites enable row level security;
-- (Helpers instead of cross-table policies, which would refer to each other.)
create function app.invited_to(p_offer_id uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.coverage_invites i where i.offer_id = p_offer_id and i.person_id = app.my_person_id())
$$;
create function app.schedules_offer(p_offer_id uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.coverage_offers o where o.id = p_offer_id and app.can(o.location_id, 'schedule'))
$$;
create policy "schedulers and invitees read offers" on public.coverage_offers for select to authenticated
  using (app.can(location_id, 'schedule') or app.invited_to(id));
create policy "schedulers and the invitee read invites" on public.coverage_invites for select to authenticated
  using (person_id = (select app.my_person_id()) or app.schedules_offer(offer_id));

-- Why this employment can't take this shift, or null if it can.
create function app.shift_ineligibility(p_employment_id uuid, p_shift public.shifts) returns text
language plpgsql stable security definer set search_path = '' as $$
declare
  v_e public.employments;
  v_tz text;
  v_day date;
begin
  select * into v_e from public.employments where id = p_employment_id;
  if v_e.id is null or (v_e.end_date is not null and v_e.end_date < current_date) then return 'ended'; end if;
  if not exists (select 1 from public.employment_locations where employment_id = v_e.id and location_id = p_shift.location_id) then
    return 'not_assigned';
  end if;
  if not app.position_fits(v_e.id, p_shift.job_role_id) then return 'wrong_position'; end if;
  if app.person_busy(v_e.id, p_shift.starts_at, p_shift.ends_at, array[p_shift.id]) then return 'busy'; end if;
  select timezone into v_tz from public.locations where id = p_shift.location_id;
  if exists (
    select 1 from public.time_off_requests t
    where t.person_id = v_e.person_id and t.status = 'approved'
      and app.leave_range(t, v_tz) && tstzrange(p_shift.starts_at, p_shift.ends_at)
  ) then
    return 'time_off';
  end if;
  v_day := (p_shift.starts_at at time zone v_tz)::date;
  if exists (
    select 1 from public.credentials c
    where c.person_id = v_e.person_id and c.blocks_scheduling and c.expires_on is not null and c.expires_on < v_day
  ) then
    return 'credential_expired';
  end if;
  return null;
end
$$;

-- Invite people to an open shift (all eligible people when the list is null). The first to accept gets it.
create function public.offer_shift(p_shift_id uuid, p_employment_ids uuid[] default null) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_shift public.shifts;
  v_loc public.locations;
  v_offer uuid;
  v_emp record;
  v_reason text;
  v_invited uuid[] := '{}';
  v_skipped jsonb := '[]'::jsonb;
begin
  select * into v_shift from public.shifts where id = p_shift_id for update;
  if v_shift.id is null or not app.can(v_shift.location_id, 'schedule') then return jsonb_build_object('ok', false, 'reason', 'not_allowed'); end if;
  if v_shift.employment_id is not null then return jsonb_build_object('ok', false, 'reason', 'not_open'); end if;
  if v_shift.starts_at <= now() then return jsonb_build_object('ok', false, 'reason', 'started'); end if;
  select * into v_loc from public.locations where id = v_shift.location_id;

  insert into public.coverage_offers (shift_id, location_id, created_by)
  values (v_shift.id, v_shift.location_id, app.my_person_id())
  on conflict (shift_id) where status = 'open' do nothing;
  select id into v_offer from public.coverage_offers where shift_id = v_shift.id and status = 'open';

  for v_emp in
    select e.id, e.person_id from public.employments e
    join public.employment_locations el on el.employment_id = e.id and el.location_id = v_shift.location_id
    where (p_employment_ids is null or e.id = any (p_employment_ids))
      and e.account_id = v_shift.account_id
  loop
    v_reason := app.shift_ineligibility(v_emp.id, v_shift);
    if v_reason is not null then
      v_skipped := v_skipped || jsonb_build_object('employment_id', v_emp.id, 'reason', v_reason);
      continue;
    end if;
    insert into public.coverage_invites (offer_id, employment_id, person_id)
    values (v_offer, v_emp.id, v_emp.person_id)
    on conflict (offer_id, employment_id) do update
      set status = 'invited', invited_at = now(), responded_at = null
      where p_employment_ids is not null and public.coverage_invites.status in ('declined', 'expired');
    if found then v_invited := v_invited || v_emp.person_id; end if;
  end loop;

  if cardinality(v_invited) > 0 then
    perform app.notify(v_invited,
      'Quart offert', v_loc.name || ' · ' || app.fmt_when(v_shift.starts_at, v_shift.ends_at, v_loc.timezone, 'fr-CA') || '. Le premier qui accepte l''obtient.',
      'Shift offered', v_loc.name || ' · ' || app.fmt_when(v_shift.starts_at, v_shift.ends_at, v_loc.timezone, 'en-CA') || '. First to accept gets it.',
      jsonb_build_object('type', 'offer', 'offer_id', v_offer, 'shift_id', v_shift.id));
  end if;
  return jsonb_build_object('ok', true, 'offer_id', v_offer, 'invited', cardinality(v_invited), 'notified', cardinality(v_invited), 'skipped', v_skipped);
end
$$;

-- "Ask the team" from earlier versions: offer to everyone eligible.
create or replace function public.request_coverage(p_shift_id uuid) returns jsonb
language sql volatile security definer set search_path = '' as $$
  select public.offer_shift(p_shift_id, null)
$$;

create function public.respond_to_offer(p_offer_id uuid, p_accept boolean) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_inv public.coverage_invites;
  v_offer public.coverage_offers;
  v_shift public.shifts;
  v_loc public.locations;
  v_reason text;
  v_name text;
  v_others uuid[];
begin
  select * into v_inv from public.coverage_invites
  where offer_id = p_offer_id and person_id = app.my_person_id()
  order by (status = 'invited') desc, invited_at limit 1;
  if v_inv.offer_id is null then return jsonb_build_object('ok', false, 'reason', 'not_invited'); end if;
  if v_inv.status <> 'invited' then
    -- Someone else took it (or the manager closed it) since the invitation
    return jsonb_build_object('ok', false, 'reason', case when v_inv.status = 'expired' then 'taken' else 'already_answered' end);
  end if;
  if not p_accept then
    update public.coverage_invites set status = 'declined', responded_at = now()
    where offer_id = v_inv.offer_id and employment_id = v_inv.employment_id;
    return jsonb_build_object('ok', true);
  end if;

  -- One acceptance at a time for this offer: a second person waits here, then finds it filled.
  select * into v_offer from public.coverage_offers where id = p_offer_id for update;
  select * into v_shift from public.shifts where id = v_offer.shift_id for update;
  if v_offer.status <> 'open' or v_shift.employment_id is not null then
    update public.coverage_invites set status = 'expired', responded_at = now()
    where offer_id = v_inv.offer_id and employment_id = v_inv.employment_id;
    return jsonb_build_object('ok', false, 'reason', 'taken');
  end if;
  v_reason := app.shift_ineligibility(v_inv.employment_id, v_shift);
  if v_reason is not null then return jsonb_build_object('ok', false, 'reason', v_reason); end if;

  update public.coverage_offers set status = 'filled', filled_employment_id = v_inv.employment_id, filled_at = now() where id = v_offer.id;
  update public.coverage_invites set status = 'accepted', responded_at = now()
  where offer_id = v_inv.offer_id and employment_id = v_inv.employment_id;
  with expired as (
    update public.coverage_invites set status = 'expired', responded_at = now()
    where offer_id = v_offer.id and status = 'invited'
    returning person_id
  )
  select coalesce(array_agg(distinct person_id), '{}') into v_others from expired;

  update public.shifts set employment_id = v_inv.employment_id where id = v_shift.id;
  -- They just accepted it: no separate acknowledgement needed.
  perform set_config('app.swap_approval', 'on', true);
  update public.shifts set response = 'confirmed' where id = v_shift.id;
  perform set_config('app.swap_approval', 'off', true);
  update public.shift_claims
  set status = case when employment_id = v_inv.employment_id then 'approved'::public.request_status else 'refused'::public.request_status end,
      decided_at = now()
  where shift_id = v_shift.id and status = 'pending';

  select * into v_loc from public.locations where id = v_shift.location_id;
  select first_name || ' ' || last_name into v_name from public.persons where id = v_inv.person_id;
  if cardinality(v_others) > 0 then
    perform app.notify(array_remove(v_others, v_inv.person_id),
      'Quart déjà pourvu', v_loc.name || ' · ' || app.fmt_when(v_shift.starts_at, v_shift.ends_at, v_loc.timezone, 'fr-CA'),
      'Shift already taken', v_loc.name || ' · ' || app.fmt_when(v_shift.starts_at, v_shift.ends_at, v_loc.timezone, 'en-CA'),
      jsonb_build_object('type', 'offer', 'offer_id', v_offer.id));
  end if;
  perform app.notify(array_remove(app.schedulers_of(v_shift.location_id), v_inv.person_id),
    'Remplacement trouvé', v_name || ' a pris le quart : ' || v_loc.name || ' · ' || app.fmt_when(v_shift.starts_at, v_shift.ends_at, v_loc.timezone, 'fr-CA'),
    'Cover found', v_name || ' took the shift: ' || v_loc.name || ' · ' || app.fmt_when(v_shift.starts_at, v_shift.ends_at, v_loc.timezone, 'en-CA'),
    jsonb_build_object('type', 'schedule', 'shift_id', v_shift.id));
  return jsonb_build_object('ok', true, 'shift_id', v_shift.id);
end
$$;

create function public.cancel_offer(p_offer_id uuid) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_offer public.coverage_offers;
begin
  select * into v_offer from public.coverage_offers where id = p_offer_id for update;
  if v_offer.id is null or not app.can(v_offer.location_id, 'schedule') then return jsonb_build_object('ok', false, 'reason', 'not_allowed'); end if;
  if v_offer.status <> 'open' then return jsonb_build_object('ok', false, 'reason', 'not_open'); end if;
  update public.coverage_offers set status = 'cancelled' where id = p_offer_id;
  update public.coverage_invites set status = 'expired', responded_at = now() where offer_id = p_offer_id and status = 'invited';
  return jsonb_build_object('ok', true);
end
$$;

-- Offers for me (open ones, plus the last 14 days' answers).
create function public.my_offers() returns jsonb
language sql stable security definer set search_path = '' as $$
  select coalesce(jsonb_agg(jsonb_build_object(
      'offer_id', o.id, 'status', i.status, 'offer_status', o.status,
      'shift', jsonb_build_object('id', s.id, 'location_id', s.location_id, 'starts_at', s.starts_at, 'ends_at', s.ends_at,
                                  'unpaid_break_minutes', s.unpaid_break_minutes),
      'location_name', l.name, 'invited_at', i.invited_at
    ) order by s.starts_at), '[]'::jsonb)
  from public.coverage_invites i
  join public.coverage_offers o on o.id = i.offer_id
  join public.shifts s on s.id = o.shift_id
  join public.locations l on l.id = s.location_id
  where i.person_id = app.my_person_id()
    and (i.status = 'invited' or i.responded_at > now() - interval '14 days')
    and s.ends_at > now()
$$;

-- Assigned another way (manager, volunteer, exchange): the offer is closed and invitees are told.
create function app.close_offers_on_assign() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  v_people uuid[];
  v_loc public.locations;
begin
  if old.employment_id is null and new.employment_id is not null then
    update public.coverage_offers set status = 'filled', filled_employment_id = new.employment_id, filled_at = now()
    where shift_id = new.id and status = 'open';
    with expired as (
      update public.coverage_invites i set status = 'expired', responded_at = now()
      from public.coverage_offers o
      where o.id = i.offer_id and o.shift_id = new.id and i.status = 'invited'
      returning i.person_id
    )
    select coalesce(array_agg(distinct person_id), '{}') into v_people from expired;
    if cardinality(v_people) > 0 then
      select * into v_loc from public.locations where id = new.location_id;
      perform app.notify(v_people,
        'Quart déjà pourvu', v_loc.name || ' · ' || app.fmt_when(new.starts_at, new.ends_at, v_loc.timezone, 'fr-CA'),
        'Shift already taken', v_loc.name || ' · ' || app.fmt_when(new.starts_at, new.ends_at, v_loc.timezone, 'en-CA'),
        jsonb_build_object('type', 'offer'));
    end if;
  end if;
  return null;
end
$$;
create trigger close_offers_on_assign after update of employment_id on public.shifts
  for each row execute function app.close_offers_on_assign();

-- ---------------------------------------------------------------- acknowledgements

-- "Last changed" means a change the employee cares about: acknowledging, reminders or
-- bookkeeping don't count (they used to make acknowledged shifts look modified after publishing).
create or replace function app.touch_updated_at() returns trigger
language plpgsql set search_path = '' as $$
begin
  if (new.employment_id, new.location_id, new.starts_at, new.ends_at, new.unpaid_break_minutes, new.job_role_id, new.notes)
     is distinct from (old.employment_id, old.location_id, old.starts_at, old.ends_at, old.unpaid_break_minutes, old.job_role_id, old.notes) then
    new.updated_at := now();
  else
    new.updated_at := old.updated_at;
  end if;
  return new;
end
$$;

alter table public.shifts add column ack_reminded_at timestamptz;

-- Upcoming shifts in published weeks that the employee hasn't acknowledged yet, at clinics I schedule.
create function public.unacknowledged_shifts() returns jsonb
language sql stable security definer set search_path = '' as $$
  select coalesce(jsonb_agg(jsonb_build_object(
      'id', s.id, 'location_id', s.location_id, 'employment_id', s.employment_id, 'person_id', e.person_id,
      'starts_at', s.starts_at, 'ends_at', s.ends_at, 'updated_at', s.updated_at,
      'changed_after_publish', s.updated_at > w.published_at, 'reminded_at', s.ack_reminded_at
    ) order by s.starts_at), '[]'::jsonb)
  from public.shifts s
  join public.schedule_weeks w on w.location_id = s.location_id and w.week_start = s.week_start and w.status = 'published'
  join public.employments e on e.id = s.employment_id
  where s.response = 'pending' and s.starts_at > now() and s.starts_at < now() + interval '60 days'
    and s.account_id = app.my_account_id() and app.can(s.location_id, 'schedule')
$$;

create function public.remind_unacknowledged(p_shift_ids uuid[]) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_s record;
  v_count integer := 0;
begin
  for v_s in
    select s.*, e.person_id, l.name as location_name, l.timezone
    from public.shifts s
    join public.employments e on e.id = s.employment_id
    join public.locations l on l.id = s.location_id
    where s.id = any (p_shift_ids) and s.response = 'pending' and s.starts_at > now()
      and app.can(s.location_id, 'schedule')
      and (s.ack_reminded_at is null or s.ack_reminded_at < now() - interval '1 hour')
    for update of s
  loop
    perform app.notify(array[v_s.person_id],
      'Quart à confirmer', v_s.location_name || ' · ' || app.fmt_when(v_s.starts_at, v_s.ends_at, v_s.timezone, 'fr-CA') || '. Ouvrez l''application et touchez « J''ai vu ».',
      'Shift to acknowledge', v_s.location_name || ' · ' || app.fmt_when(v_s.starts_at, v_s.ends_at, v_s.timezone, 'en-CA') || '. Open the app and tap "Got it".',
      jsonb_build_object('type', 'schedule', 'shift_id', v_s.id));
    perform set_config('app.swap_approval', 'on', true);
    update public.shifts set ack_reminded_at = now() where id = v_s.id;
    perform set_config('app.swap_approval', 'off', true);
    v_count := v_count + 1;
  end loop;
  return jsonb_build_object('ok', true, 'reminded', v_count);
end
$$;

-- ---------------------------------------------------------------- grants

do $$
declare f text;
begin
  foreach f in array array[
    'public.decide_availability_exception(uuid, boolean)',
    'public.request_leave(uuid, date, date, time, time, text)',
    'public.time_off_impact(uuid)',
    'public.decide_leave(uuid, boolean, numeric, text, boolean)',
    'public.offer_shift(uuid, uuid[])',
    'public.respond_to_offer(uuid, boolean)',
    'public.cancel_offer(uuid)',
    'public.my_offers()',
    'public.unacknowledged_shifts()',
    'public.remind_unacknowledged(uuid[])'
  ] loop
    execute format('revoke execute on function %s from public, anon', f);
    execute format('grant execute on function %s to authenticated', f);
  end loop;
end
$$;
