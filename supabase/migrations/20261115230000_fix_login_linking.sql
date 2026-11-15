-- Fix: logins created by email code were never linked to invited employees.
-- Supabase gives every email-code sign-up a hidden random password, so the previous rule
-- ("never link a login that has a password") blocked everyone.
--
-- New rule: link any confirmed login by email, but a session that was opened WITH A PASSWORD
-- gets no access to the person it is linked to, unless that person is explicitly allowed to use a
-- password (only the Apple review account, set from the SQL editor). This still blocks someone who
-- registers an employee's email with a password before the employee's first sign-in.

alter table public.persons add column password_login_allowed boolean not null default false;

alter policy "managers add people" on public.persons
  with check (account_id = (select app.my_account_id()) and (select app.is_manager()) and user_id is null and not password_login_allowed);

-- True when the current session was opened with a password (Supabase puts the sign-in method in
-- the "amr" claim of the access token, and keeps it when the token is refreshed).
create function app.password_session() returns boolean
language sql stable set search_path = '' as $$
  select exists (
    select 1
    from jsonb_array_elements(case when jsonb_typeof(auth.jwt() -> 'amr') = 'array' then auth.jwt() -> 'amr' else '[]'::jsonb end) e
    where coalesce(e ->> 'method', e #>> '{}') = 'password'
  )
$$;

-- The signed-in login, or null for a password session that isn't allowed one.
create function app.uid() returns uuid
language sql stable security definer set search_path = '' as $$
  select case
    when auth.uid() is null then null
    when not app.password_session() then auth.uid()
    when exists (select 1 from public.persons where user_id = auth.uid() and password_login_allowed) then auth.uid()
    else null
  end
$$;
grant execute on function app.uid() to authenticated;
grant execute on function app.password_session() to authenticated;

create or replace function app.my_person_id() returns uuid
language sql stable security definer set search_path = '' as $$
  select id from public.persons where user_id = app.uid()
$$;

create or replace function app.my_account_id() returns uuid
language sql stable security definer set search_path = '' as $$
  select account_id from public.persons where user_id = app.uid()
$$;

create or replace function app.is_owner() returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.role_assignments ra
    join public.persons p on p.id = ra.person_id
    where p.user_id = app.uid() and ra.role = 'owner'
  )
$$;

create or replace function app.is_manager() returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.role_assignments ra
    join public.persons p on p.id = ra.person_id
    where p.user_id = app.uid()
  )
$$;

create or replace function app.manages_company(p_company_id uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.companies c
    join public.role_assignments ra on ra.account_id = c.account_id
    join public.persons p on p.id = ra.person_id
    where c.id = p_company_id and p.user_id = app.uid()
      and (ra.role = 'owner' or (ra.role = 'company_admin' and ra.company_id = c.id))
  )
$$;

create or replace function app.manages_location(p_location_id uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.locations l
    join public.role_assignments ra on ra.account_id = l.account_id
    join public.persons p on p.id = ra.person_id
    where l.id = p_location_id and p.user_id = app.uid()
      and (ra.role = 'owner'
        or (ra.role = 'company_admin' and ra.company_id = l.company_id)
        or (ra.role = 'clinic_manager' and ra.location_id = l.id))
  )
$$;

create or replace function app.my_employment_ids() returns setof uuid
language sql stable security definer set search_path = '' as $$
  select e.id from public.employments e
  join public.persons p on p.id = e.person_id
  where p.user_id = app.uid()
$$;

create or replace function app.my_location_ids() returns setof uuid
language sql stable security definer set search_path = '' as $$
  select el.location_id from public.employment_locations el
  join public.employments e on e.id = el.employment_id
  join public.persons p on p.id = e.person_id
  where p.user_id = app.uid() and (e.end_date is null or e.end_date >= current_date)
$$;

create or replace function app.punch_context(p_location_id uuid, p_at timestamptz,
  out person public.persons, out location public.locations, out employment_id uuid,
  out kind public.punch_kind, out shift public.shifts, out rejection jsonb)
language plpgsql stable security definer set search_path = '' as $$
begin
  select * into person from public.persons where user_id = app.uid();
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

create or replace function public.set_my_pin(p_pin text) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_person public.persons;
begin
  select * into v_person from public.persons where user_id = app.uid();
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

create or replace function public.has_pin() returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from app.person_pins pp join public.persons p on p.id = pp.person_id where p.user_id = app.uid())
$$;

create or replace function public.kiosk_request_pairing() returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_code text;
begin
  if app.uid() is null then raise exception 'Sign in first' using errcode = '42501'; end if;
  if exists (select 1 from public.persons where user_id = app.uid()) then
    return jsonb_build_object('ok', false, 'reason', 'staff_account');
  end if;
  if exists (select 1 from public.kiosk_devices where user_id = app.uid()) then
    return jsonb_build_object('ok', false, 'reason', 'already_paired');
  end if;
  delete from app.kiosk_pairings where user_id = app.uid() or expires_at < now();
  loop
    v_code := lpad((floor(random() * 1000000))::int::text, 6, '0');
    begin
      insert into app.kiosk_pairings (code, user_id) values (v_code, app.uid());
      exit;
    exception when unique_violation then
      -- try another code
    end;
  end loop;
  return jsonb_build_object('ok', true, 'code', v_code, 'expires_in_s', 900);
end
$$;

create or replace function public.kiosk_me() returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object('kiosk_id', k.id, 'location_id', l.id, 'location_name', l.name, 'province', l.province, 'timezone', l.timezone)
  from public.kiosk_devices k join public.locations l on l.id = k.location_id
  where k.user_id = app.uid()
$$;

create or replace function public.kiosk_current_code(p_location_id uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v_window bigint := app.qr_window(now());
  v_code text;
begin
  if not (exists (select 1 from public.kiosk_devices where user_id = app.uid() and location_id = p_location_id)
          or app.manages_location(p_location_id)) then
    return jsonb_build_object('ok', false, 'reason', 'not_allowed');
  end if;
  v_code := app.qr_code(p_location_id, v_window);
  return jsonb_build_object('ok', true, 'code', v_code,
    'payload', 'cw1:' || p_location_id::text || ':' || v_code,
    'seconds_left', 30 - (floor(extract(epoch from now()))::bigint % 30));
end
$$;

create or replace function public.kiosk_punch(p_pin text) returns jsonb
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
  select * into v_kiosk from public.kiosk_devices where user_id = app.uid();
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

create or replace function public.create_account(p_account_name text, p_first_name text, p_last_name text) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_account uuid;
  v_person uuid;
  v_email text := lower(auth.jwt() ->> 'email');
begin
  if app.uid() is null or coalesce((auth.jwt() ->> 'is_anonymous')::boolean, false) then
    return jsonb_build_object('ok', false, 'reason', 'sign_in_required');
  end if;
  if exists (select 1 from public.persons where user_id = app.uid())
     or exists (select 1 from public.kiosk_devices where user_id = app.uid()) then
    return jsonb_build_object('ok', false, 'reason', 'already_member');
  end if;
  insert into public.accounts (name) values (p_account_name) returning id into v_account;
  insert into public.persons (account_id, user_id, first_name, last_name, email)
  values (v_account, app.uid(), p_first_name, p_last_name, nullif(v_email, ''))
  returning id into v_person;
  insert into public.role_assignments (account_id, person_id, role) values (v_account, v_person, 'owner');
  return jsonb_build_object('ok', true, 'account_id', v_account, 'person_id', v_person);
end
$$;

-- Linking: any confirmed, non-anonymous login (passwords no longer matter here).
create or replace function app.link_new_user() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if new.email is not null
     and new.email_confirmed_at is not null
     and not coalesce(new.is_anonymous, false)
     and not exists (select 1 from public.persons where user_id = new.id) then
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

create or replace function app.link_existing_user() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  v_user uuid;
begin
  if new.user_id is null and new.email is not null then
    select u.id into v_user
    from auth.users u
    where lower(u.email) = new.email
      and u.email_confirmed_at is not null
      and not coalesce(u.is_anonymous, false)
      and not exists (select 1 from public.persons p where p.user_id = u.id)
    limit 1;
    if v_user is not null then
      update public.persons set user_id = v_user where id = new.id and user_id is null;
    end if;
  end if;
  return null;
end
$$;

-- Link the people who already signed in while the old rule was in place.
create function app.link_pending_logins() returns integer
language plpgsql security definer set search_path = '' as $$
declare
  u record;
  n integer := 0;
  v_rows integer;
begin
  for u in
    select id, email from auth.users
    where email is not null and email_confirmed_at is not null and not coalesce(is_anonymous, false)
      and not exists (select 1 from public.persons p where p.user_id = auth.users.id)
    order by created_at
  loop
    update public.persons set user_id = u.id
    where id = (select id from public.persons where email = lower(u.email) and user_id is null order by created_at limit 1);
    get diagnostics v_rows = row_count;
    n := n + v_rows;
  end loop;
  return n;
end
$$;
revoke execute on function app.link_pending_logins() from public;
select app.link_pending_logins();
