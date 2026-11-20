-- 1. Staff can only punch: an employee may acknowledge a shift but no longer decline it.
-- 2. Shift exchanges: an employee offers a shift to a colleague (give or swap), the colleague
--    accepts, then a manager approves. Shifts change only on approval.
-- 3. Custom roles with permissions, per company, assigned at clinics. Clinic managers, company
--    admins and owners keep full rights; a custom role grants only the permissions it lists.

-- ---------------------------------------------------------------- Custom roles

create table public.custom_roles (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references public.accounts on delete cascade,
  company_id uuid not null references public.companies on delete cascade,
  name text not null check (length(btrim(name)) between 1 and 80),
  permissions text[] not null default '{}'
    check (permissions <@ array['schedule', 'employees', 'punches', 'clinics', 'kiosks']::text[]),
  created_at timestamptz not null default now(),
  unique (company_id, name)
);
create index on public.custom_roles (account_id);

create table public.custom_role_assignments (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references public.accounts on delete cascade,
  person_id uuid not null references public.persons on delete cascade,
  custom_role_id uuid not null references public.custom_roles on delete cascade,
  location_id uuid not null references public.locations on delete cascade,
  unique (person_id, custom_role_id, location_id)
);
create index on public.custom_role_assignments (location_id);
create index on public.custom_role_assignments (person_id);

-- ---------------------------------------------------------------- Shift exchanges

create type public.swap_status as enum
  ('pending_colleague', 'pending_manager', 'approved', 'refused_colleague', 'refused_manager', 'cancelled');

create table public.shift_swaps (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references public.accounts on delete cascade,
  shift_id uuid not null references public.shifts on delete cascade,
  location_id uuid not null references public.locations on delete cascade,
  requester_employment_id uuid not null references public.employments on delete cascade,
  target_employment_id uuid not null references public.employments on delete cascade,
  -- null: the requester gives the shift away; otherwise the two shifts are exchanged
  target_shift_id uuid references public.shifts on delete cascade,
  target_location_id uuid references public.locations on delete cascade,
  note text check (length(note) <= 500),
  status public.swap_status not null default 'pending_colleague',
  colleague_responded_at timestamptz,
  decided_by uuid references public.persons on delete set null,
  decided_at timestamptz,
  manager_note text check (length(manager_note) <= 500),
  created_at timestamptz not null default now()
);
create unique index shift_swaps_one_open_per_shift on public.shift_swaps (shift_id)
  where status in ('pending_colleague', 'pending_manager');
create index on public.shift_swaps (location_id, status);
create index on public.shift_swaps (target_employment_id, status);
create index on public.shift_swaps (requester_employment_id, status);

-- ---------------------------------------------------------------- account_id from the parent row

create or replace function app.fill_account_id() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  v_account uuid;
begin
  if TG_TABLE_NAME = 'companies' then
    v_account := coalesce(app.my_account_id(), new.account_id);
  elsif TG_TABLE_NAME in ('locations', 'employments', 'custom_roles') then
    select account_id into v_account from public.companies where id = new.company_id;
  elsif TG_TABLE_NAME in ('location_wifi', 'schedule_weeks', 'shifts', 'employment_locations', 'kiosk_devices',
                          'custom_role_assignments', 'shift_swaps') then
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

create trigger fill_account_id before insert or update of account_id on public.custom_roles
  for each row execute function app.fill_account_id();
create trigger fill_account_id before insert or update of account_id on public.custom_role_assignments
  for each row execute function app.fill_account_id();
create trigger fill_account_id before insert or update of account_id on public.shift_swaps
  for each row execute function app.fill_account_id();

-- A custom role is assigned only at clinics of its company, to people of the same account.
create function app.check_custom_role_assignment() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if not exists (
    select 1 from public.custom_roles r
    join public.locations l on l.company_id = r.company_id
    join public.persons p on p.account_id = l.account_id
    where r.id = new.custom_role_id and l.id = new.location_id and p.id = new.person_id
  ) then
    raise exception 'The role, the clinic and the person must belong to the same company' using errcode = '23514';
  end if;
  return new;
end
$$;
create trigger check_custom_role_assignment before insert or update on public.custom_role_assignments
  for each row execute function app.check_custom_role_assignment();

-- ---------------------------------------------------------------- Permission helpers

-- Full manager of the clinic, or holds a custom role there that includes the permission.
create function app.can(p_location_id uuid, p_perm text) returns boolean
language sql stable security definer set search_path = '' as $$
  select app.manages_location(p_location_id) or exists (
    select 1 from public.custom_role_assignments a
    join public.custom_roles r on r.id = a.custom_role_id
    join public.persons p on p.id = a.person_id
    where a.location_id = p_location_id and p.user_id = app.uid() and p_perm = any (r.permissions)
  )
$$;

-- Has the permission at one clinic at least (full managers have every permission).
create function app.can_anywhere(p_perm text) returns boolean
language sql stable security definer set search_path = '' as $$
  select app.is_manager() or exists (
    select 1 from public.custom_role_assignments a
    join public.custom_roles r on r.id = a.custom_role_id
    join public.persons p on p.id = a.person_id
    where p.user_id = app.uid() and p_perm = any (r.permissions)
  )
$$;

-- Has the permission at one clinic of the company at least.
create function app.can_in_company(p_company_id uuid, p_perm text) returns boolean
language sql stable security definer set search_path = '' as $$
  select app.manages_any_location_in_company(p_company_id) or exists (
    select 1 from public.locations l where l.company_id = p_company_id and app.can(l.id, p_perm)
  )
$$;

-- The person works at a clinic where I have the permission.
create function app.can_for_person(p_person_id uuid, p_perm text) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.employments e
    join public.employment_locations el on el.employment_id = e.id
    where e.person_id = p_person_id and app.can(el.location_id, p_perm)
  )
$$;

create or replace function app.can_manage_person(p_person_id uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.persons x where x.id = p_person_id and x.account_id = app.my_account_id()
  ) and (
    app.is_owner()
    or (app.can_anywhere('employees') and not exists (select 1 from public.employments e where e.person_id = p_person_id))
    or exists (
      select 1 from public.employments e
      left join public.employment_locations el on el.employment_id = e.id
      where e.person_id = p_person_id
        and (app.manages_company(e.company_id) or (el.location_id is not null and app.can(el.location_id, 'employees')))
    )
  )
$$;

-- ---------------------------------------------------------------- Policies by permission

alter table public.custom_roles enable row level security;
alter table public.custom_role_assignments enable row level security;
alter table public.shift_swaps enable row level security;

create policy "members read custom roles" on public.custom_roles for select to authenticated
  using (account_id = (select app.my_account_id()));
create policy "admins create custom roles" on public.custom_roles for insert to authenticated
  with check (app.manages_company(company_id));
create policy "admins update custom roles" on public.custom_roles for update to authenticated
  using (app.manages_company(company_id)) with check (app.manages_company(company_id));
create policy "admins delete custom roles" on public.custom_roles for delete to authenticated
  using (app.manages_company(company_id));

create policy "members read custom role assignments" on public.custom_role_assignments for select to authenticated
  using (account_id = (select app.my_account_id()));
create policy "managers assign custom roles" on public.custom_role_assignments for insert to authenticated
  with check (app.manages_location(location_id));
create policy "managers remove custom roles" on public.custom_role_assignments for delete to authenticated
  using (app.manages_location(location_id));

create policy "people involved and schedulers read exchanges" on public.shift_swaps for select to authenticated
  using (
    requester_employment_id in (select app.my_employment_ids())
    or target_employment_id in (select app.my_employment_ids())
    or app.can(location_id, 'schedule')
    or (target_location_id is not null and app.can(target_location_id, 'schedule'))
  );

-- Clinics and their Wi-Fi
drop policy "managers update their clinics" on public.locations;
create policy "managers update their clinics" on public.locations for update to authenticated
  using (app.can(id, 'clinics')) with check (app.can(id, 'clinics'));

drop policy "managers read clinic wifi" on public.location_wifi;
drop policy "managers add clinic wifi" on public.location_wifi;
drop policy "managers remove clinic wifi" on public.location_wifi;
create policy "managers read clinic wifi" on public.location_wifi for select to authenticated
  using (app.can(location_id, 'clinics'));
create policy "managers add clinic wifi" on public.location_wifi for insert to authenticated
  with check (app.can(location_id, 'clinics'));
create policy "managers remove clinic wifi" on public.location_wifi for delete to authenticated
  using (app.can(location_id, 'clinics'));

-- People
alter policy "managers add people" on public.persons
  with check (account_id = (select app.my_account_id()) and (select app.can_anywhere('employees'))
              and user_id is null and not password_login_allowed);

-- Employments
drop policy "self and managers read employments" on public.employments;
create policy "self and managers read employments" on public.employments for select to authenticated
  using (
    person_id = (select app.my_person_id())
    or app.manages_company(company_id)
    or exists (
      select 1 from public.employment_locations el
      where el.employment_id = id
        and (app.can(el.location_id, 'employees') or app.can(el.location_id, 'schedule') or app.can(el.location_id, 'punches'))
    )
  );
drop policy "managers hire" on public.employments;
create policy "managers hire" on public.employments for insert to authenticated
  with check (app.can_in_company(company_id, 'employees') and app.can_manage_person(person_id));
drop policy "managers update employments" on public.employments;
create policy "managers update employments" on public.employments for update to authenticated
  using (app.manages_company(company_id) or exists (
    select 1 from public.employment_locations el where el.employment_id = id and app.can(el.location_id, 'employees')))
  with check (app.can_in_company(company_id, 'employees'));

drop policy "self and managers read employment clinics" on public.employment_locations;
drop policy "managers assign clinics" on public.employment_locations;
drop policy "managers update clinic assignment" on public.employment_locations;
drop policy "managers unassign clinics" on public.employment_locations;
create policy "self and managers read employment clinics" on public.employment_locations for select to authenticated
  using (
    employment_id in (select app.my_employment_ids())
    or app.can(location_id, 'employees') or app.can(location_id, 'schedule') or app.can(location_id, 'punches')
  );
create policy "managers assign clinics" on public.employment_locations for insert to authenticated
  with check (app.can(location_id, 'employees'));
create policy "managers update clinic assignment" on public.employment_locations for update to authenticated
  using (app.can(location_id, 'employees')) with check (app.can(location_id, 'employees'));
create policy "managers unassign clinics" on public.employment_locations for delete to authenticated
  using (app.can(location_id, 'employees'));

-- Schedule
drop policy "managers and staff read schedule weeks" on public.schedule_weeks;
drop policy "managers edit schedule weeks" on public.schedule_weeks;
create policy "managers and staff read schedule weeks" on public.schedule_weeks for select to authenticated
  using (app.can(location_id, 'schedule') or (status = 'published' and location_id in (select app.my_location_ids())));
create policy "managers edit schedule weeks" on public.schedule_weeks for all to authenticated
  using (app.can(location_id, 'schedule')) with check (app.can(location_id, 'schedule'));

drop policy "managers and staff read shifts" on public.shifts;
drop policy "managers edit shifts" on public.shifts;
create policy "managers and staff read shifts" on public.shifts for select to authenticated
  using (
    app.can(location_id, 'schedule')
    or (location_id in (select app.my_location_ids()) and app.is_week_published(location_id, week_start))
  );
create policy "managers edit shifts" on public.shifts for all to authenticated
  using (app.can(location_id, 'schedule')) with check (app.can(location_id, 'schedule'));

-- Schedulers see the availability of the people they schedule
drop policy "self and managers read availability" on public.availability_rules;
create policy "self and managers read availability" on public.availability_rules for select to authenticated
  using (person_id = (select app.my_person_id()) or app.can_manage_person(person_id) or app.can_for_person(person_id, 'schedule'));
drop policy "self and managers read exceptions" on public.availability_exceptions;
create policy "self and managers read exceptions" on public.availability_exceptions for select to authenticated
  using (person_id = (select app.my_person_id()) or app.can_manage_person(person_id) or app.can_for_person(person_id, 'schedule'));

-- Clinic iPads
drop policy "managers and the device read kiosks" on public.kiosk_devices;
drop policy "managers remove kiosks" on public.kiosk_devices;
create policy "managers and the device read kiosks" on public.kiosk_devices for select to authenticated
  using (app.can(location_id, 'kiosks') or user_id = (select auth.uid()));
create policy "managers remove kiosks" on public.kiosk_devices for delete to authenticated
  using (app.can(location_id, 'kiosks'));

-- Punches
drop policy "self and managers read punches" on public.punches;
drop policy "managers correct punches" on public.punches;
create policy "self and managers read punches" on public.punches for select to authenticated
  using (person_id = (select app.my_person_id()) or app.can(location_id, 'punches'));
create policy "managers correct punches" on public.punches for update to authenticated
  using (app.can(location_id, 'punches')) with check (app.can(location_id, 'punches'));

-- ---------------------------------------------------------------- Functions that checked full manager rights

create or replace function public.kiosk_approve_pairing(p_code text, p_location_id uuid, p_name text default 'iPad') returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_pairing app.kiosk_pairings;
  v_id uuid;
begin
  if not app.can(p_location_id, 'kiosks') then
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

create or replace function public.kiosk_current_code(p_location_id uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v_window bigint := app.qr_window(now());
  v_code text;
begin
  if not (exists (select 1 from public.kiosk_devices where user_id = app.uid() and location_id = p_location_id)
          or app.can(p_location_id, 'kiosks')) then
    return jsonb_build_object('ok', false, 'reason', 'not_allowed');
  end if;
  v_code := app.qr_code(p_location_id, v_window);
  return jsonb_build_object('ok', true, 'code', v_code,
    'payload', 'cw1:' || p_location_id::text || ':' || v_code,
    'seconds_left', 30 - (floor(extract(epoch from now()))::bigint % 30));
end
$$;

-- Staff only acknowledge a shift; changes go through a manager or an exchange request.
create or replace function public.respond_to_shift(p_shift_id uuid, p_response public.shift_response) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
begin
  if p_response <> 'confirmed' then
    return jsonb_build_object('ok', false, 'reason', 'not_allowed');
  end if;
  update public.shifts s set response = 'confirmed'
  where s.id = p_shift_id
    and s.employment_id in (select app.my_employment_ids())
    and s.starts_at > now()
    and app.is_week_published(s.location_id, s.week_start);
  if not found then return jsonb_build_object('ok', false, 'reason', 'not_allowed'); end if;
  return jsonb_build_object('ok', true);
end
$$;

-- ---------------------------------------------------------------- Exchange functions

-- A shift of mine that can still be exchanged: published and not started.
create function app.my_open_shift(p_shift_id uuid) returns public.shifts
language sql stable security definer set search_path = '' as $$
  select s.* from public.shifts s
  where s.id = p_shift_id
    and s.employment_id in (select app.my_employment_ids())
    and s.starts_at > now()
    and app.is_week_published(s.location_id, s.week_start)
$$;

-- Colleagues who can take my shift (they work at that clinic), and their shifts I could take in exchange.
create function public.swap_candidates(p_shift_id uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v_shift public.shifts;
  v_me uuid := app.my_person_id();
begin
  v_shift := app.my_open_shift(p_shift_id);
  if v_shift.id is null then
    return jsonb_build_object('ok', false, 'reason', 'not_allowed');
  end if;
  return jsonb_build_object('ok', true, 'colleagues', coalesce((
    select jsonb_agg(c order by c ->> 'last_name', c ->> 'first_name')
    from (
      select jsonb_build_object(
        'employment_id', e.id,
        'person_id', p.id,
        'first_name', p.first_name,
        'last_name', p.last_name,
        'shifts', coalesce((
          select jsonb_agg(jsonb_build_object('id', s.id, 'location_id', s.location_id, 'starts_at', s.starts_at, 'ends_at', s.ends_at)
                           order by s.starts_at)
          from public.shifts s
          where s.employment_id = e.id
            and s.starts_at > now()
            and app.is_week_published(s.location_id, s.week_start)
            and exists (select 1 from public.employment_locations mine
                        where mine.employment_id = v_shift.employment_id and mine.location_id = s.location_id)
        ), '[]'::jsonb)
      ) as c
      from public.employments e
      join public.persons p on p.id = e.person_id
      join public.employment_locations el on el.employment_id = e.id and el.location_id = v_shift.location_id
      where p.id <> v_me and (e.end_date is null or e.end_date >= current_date)
    ) x
  ), '[]'::jsonb));
end
$$;

create function public.request_shift_swap(p_shift_id uuid, p_target_employment_id uuid,
                                          p_target_shift_id uuid default null, p_note text default null) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_shift public.shifts;
  v_target public.shifts;
  v_id uuid;
begin
  v_shift := app.my_open_shift(p_shift_id);
  if v_shift.id is null then
    return jsonb_build_object('ok', false, 'reason', 'not_allowed');
  end if;
  -- The colleague works at the clinic of my shift, is someone else, and is still employed.
  if not exists (
    select 1 from public.employments e
    join public.employment_locations el on el.employment_id = e.id and el.location_id = v_shift.location_id
    where e.id = p_target_employment_id
      and e.person_id <> app.my_person_id()
      and (e.end_date is null or e.end_date >= current_date)
  ) then
    return jsonb_build_object('ok', false, 'reason', 'colleague_not_allowed');
  end if;
  if p_target_shift_id is not null then
    select s.* into v_target from public.shifts s
    where s.id = p_target_shift_id
      and s.employment_id = p_target_employment_id
      and s.starts_at > now()
      and app.is_week_published(s.location_id, s.week_start)
      and exists (select 1 from public.employment_locations mine
                  where mine.employment_id = v_shift.employment_id and mine.location_id = s.location_id);
    if v_target.id is null then
      return jsonb_build_object('ok', false, 'reason', 'target_shift_not_allowed');
    end if;
  end if;
  begin
    insert into public.shift_swaps (shift_id, location_id, requester_employment_id, target_employment_id,
                                    target_shift_id, target_location_id, note)
    values (v_shift.id, v_shift.location_id, v_shift.employment_id, p_target_employment_id,
            v_target.id, v_target.location_id, nullif(btrim(coalesce(p_note, '')), ''))
    returning id into v_id;
  exception when unique_violation then
    return jsonb_build_object('ok', false, 'reason', 'already_requested');
  end;
  return jsonb_build_object('ok', true, 'id', v_id);
end
$$;

create function public.respond_to_swap(p_swap_id uuid, p_accept boolean) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
begin
  update public.shift_swaps
  set status = case when p_accept then 'pending_manager'::public.swap_status else 'refused_colleague'::public.swap_status end,
      colleague_responded_at = now()
  where id = p_swap_id
    and status = 'pending_colleague'
    and target_employment_id in (select app.my_employment_ids());
  if not found then return jsonb_build_object('ok', false, 'reason', 'not_allowed'); end if;
  return jsonb_build_object('ok', true);
end
$$;

create function public.cancel_swap(p_swap_id uuid) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
begin
  update public.shift_swaps set status = 'cancelled'
  where id = p_swap_id
    and status in ('pending_colleague', 'pending_manager')
    and requester_employment_id in (select app.my_employment_ids());
  if not found then return jsonb_build_object('ok', false, 'reason', 'not_allowed'); end if;
  return jsonb_build_object('ok', true);
end
$$;

-- True if the person already works another shift overlapping [p_start, p_end), ignoring the given shifts.
create function app.person_busy(p_employment_id uuid, p_start timestamptz, p_end timestamptz, p_ignore uuid[]) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.shifts s
    join public.employments e on e.id = s.employment_id
    where e.person_id = (select person_id from public.employments where id = p_employment_id)
      and s.id <> all (p_ignore)
      and s.starts_at < p_end and s.ends_at > p_start
  )
$$;

create function public.decide_swap(p_swap_id uuid, p_approve boolean, p_note text default null) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_swap public.shift_swaps;
  v_shift public.shifts;
  v_target public.shifts;
  v_ignore uuid[];
begin
  select * into v_swap from public.shift_swaps where id = p_swap_id for update;
  if v_swap.id is null
     or not app.can(v_swap.location_id, 'schedule')
     or (v_swap.target_location_id is not null and not app.can(v_swap.target_location_id, 'schedule')) then
    return jsonb_build_object('ok', false, 'reason', 'not_allowed');
  end if;
  if v_swap.status <> 'pending_manager' then
    return jsonb_build_object('ok', false, 'reason', 'not_pending');
  end if;

  if not p_approve then
    update public.shift_swaps
    set status = 'refused_manager', decided_by = app.my_person_id(), decided_at = now(),
        manager_note = nullif(btrim(coalesce(p_note, '')), '')
    where id = p_swap_id;
    return jsonb_build_object('ok', true);
  end if;

  select * into v_shift from public.shifts where id = v_swap.shift_id for update;
  if v_swap.target_shift_id is not null then
    select * into v_target from public.shifts where id = v_swap.target_shift_id for update;
  end if;
  -- Nothing changed since the request, and nothing has started.
  if v_shift.id is null or v_shift.employment_id <> v_swap.requester_employment_id or v_shift.starts_at <= now()
     or (v_swap.target_shift_id is not null and (v_target.id is null or v_target.employment_id <> v_swap.target_employment_id
                                                 or v_target.starts_at <= now())) then
    return jsonb_build_object('ok', false, 'reason', 'shift_changed');
  end if;
  v_ignore := array_remove(array[v_shift.id, v_target.id], null);
  if app.person_busy(v_swap.target_employment_id, v_shift.starts_at, v_shift.ends_at, v_ignore)
     or (v_target.id is not null and app.person_busy(v_swap.requester_employment_id, v_target.starts_at, v_target.ends_at, v_ignore)) then
    return jsonb_build_object('ok', false, 'reason', 'overlap');
  end if;

  update public.shifts set employment_id = v_swap.target_employment_id, response = 'confirmed' where id = v_shift.id;
  if v_target.id is not null then
    update public.shifts set employment_id = v_swap.requester_employment_id, response = 'confirmed' where id = v_target.id;
  end if;
  update public.shift_swaps
  set status = 'approved', decided_by = app.my_person_id(), decided_at = now(),
      manager_note = nullif(btrim(coalesce(p_note, '')), '')
  where id = p_swap_id;
  -- Other open requests on these shifts no longer make sense.
  update public.shift_swaps set status = 'cancelled'
  where id <> p_swap_id
    and status in ('pending_colleague', 'pending_manager')
    and (shift_id = any (v_ignore) or target_shift_id = any (v_ignore));
  return jsonb_build_object('ok', true);
end
$$;

-- ---------------------------------------------------------------- Grants

revoke all on public.custom_roles, public.custom_role_assignments, public.shift_swaps from anon;
grant select, insert, update, delete on public.custom_roles, public.custom_role_assignments to authenticated;
grant select on public.shift_swaps to authenticated;
revoke insert, update, delete on public.shift_swaps from authenticated;
revoke update on public.custom_role_assignments from authenticated;

revoke execute on function public.swap_candidates(uuid) from public, anon;
revoke execute on function public.request_shift_swap(uuid, uuid, uuid, text) from public, anon;
revoke execute on function public.respond_to_swap(uuid, boolean) from public, anon;
revoke execute on function public.cancel_swap(uuid) from public, anon;
revoke execute on function public.decide_swap(uuid, boolean, text) from public, anon;
grant execute on function public.swap_candidates(uuid) to authenticated;
grant execute on function public.request_shift_swap(uuid, uuid, uuid, text) to authenticated;
grant execute on function public.respond_to_swap(uuid, boolean) to authenticated;
grant execute on function public.cancel_swap(uuid) to authenticated;
grant execute on function public.decide_swap(uuid, boolean, text) to authenticated;

grant execute on function app.can(uuid, text), app.can_anywhere(text), app.can_in_company(uuid, text),
  app.can_for_person(uuid, text), app.my_open_shift(uuid), app.person_busy(uuid, timestamptz, timestamptz, uuid[])
  to authenticated;

-- Exchange requests I made or received (last 60 days), with names and times, for the phone app.
create function public.my_swaps() returns jsonb
language sql stable security definer set search_path = '' as $$
  select coalesce(jsonb_agg(jsonb_build_object(
      'id', w.id,
      'status', w.status,
      'incoming', w.target_employment_id in (select app.my_employment_ids()),
      'note', w.note,
      'manager_note', w.manager_note,
      'created_at', w.created_at,
      'requester_name', rp.first_name || ' ' || rp.last_name,
      'target_name', tp.first_name || ' ' || tp.last_name,
      'shift', jsonb_build_object('id', s.id, 'location_id', s.location_id, 'starts_at', s.starts_at, 'ends_at', s.ends_at),
      'target_shift', case when ts.id is null then null
                      else jsonb_build_object('id', ts.id, 'location_id', ts.location_id, 'starts_at', ts.starts_at, 'ends_at', ts.ends_at) end
    ) order by w.created_at desc), '[]'::jsonb)
  from public.shift_swaps w
  join public.shifts s on s.id = w.shift_id
  left join public.shifts ts on ts.id = w.target_shift_id
  join public.employments re on re.id = w.requester_employment_id
  join public.persons rp on rp.id = re.person_id
  join public.employments te on te.id = w.target_employment_id
  join public.persons tp on tp.id = te.person_id
  where (w.requester_employment_id in (select app.my_employment_ids())
         or w.target_employment_id in (select app.my_employment_ids()))
    and w.created_at > now() - interval '60 days'
$$;
revoke execute on function public.my_swaps() from public, anon;
grant execute on function public.my_swaps() to authenticated;
