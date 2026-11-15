-- Demo organization for Apple's App Review team (TestFlight external testing / App Store).
-- It is a separate organization: the reviewer sees none of your real clinics or staff.
--
-- 1. Supabase → Authentication → Users → Add user → Create new user
--      Email: the review email below, a strong password, and check "Auto Confirm User".
-- 2. Change the email on the line marked CHANGE ME so it matches.
-- 3. Supabase → SQL Editor → New query → paste this whole file → Run.
--
-- The reviewer is a clinic manager of the demo clinic, so in the app they can save the clinic
-- location where they are (Setup), then punch in by location. Shifts are published for 4 weeks.

do $$
declare
  v_email text := 'review@example.com';  -- CHANGE ME
  v_tz text := 'America/Toronto';
  v_user uuid;
  v_account uuid;
  v_company uuid;
  v_location uuid;
  v_person uuid;
  v_employment uuid;
  v_monday date := date_trunc('week', now() at time zone 'America/Toronto')::date;
  w int;
  d int;
begin
  select id into v_user from auth.users where lower(email) = lower(v_email);
  if v_user is null then
    raise exception 'No login with email %. Create it first in Authentication → Users (Auto Confirm User checked).', v_email;
  end if;
  if exists (select 1 from public.persons where user_id = v_user) then
    raise exception 'This login is already set up.';
  end if;

  insert into public.accounts (name) values ('Demo — App Review') returning id into v_account;
  insert into public.companies (account_id, legal_name) values (v_account, 'Demo Clinic Inc.') returning id into v_company;
  insert into public.locations (company_id, name, province, timezone, address, latitude, longitude, geofence_radius_m, early_punch_limit_min)
  values (v_company, 'Demo Clinic', 'ON', v_tz, '100 Demo Street, Ottawa, ON', 45.4215, -75.6972, 500, 240)
  returning id into v_location;

  -- password_login_allowed: Apple's reviewers sign in with a password, not an email code.
  insert into public.persons (account_id, user_id, first_name, last_name, email, password_login_allowed)
  values (v_account, v_user, 'App', 'Review', lower(v_email), true)
  returning id into v_person;
  insert into public.role_assignments (person_id, role, location_id) values (v_person, 'clinic_manager', v_location);
  insert into public.employments (person_id, company_id, desired_weekly_minutes) values (v_person, v_company, 2400)
  returning id into v_employment;
  insert into public.employment_locations (employment_id, location_id) values (v_employment, v_location);

  for w in 0..3 loop
    insert into public.schedule_weeks (location_id, week_start, status, published_at, published_by)
    values (v_location, v_monday + w * 7, 'published', now(), v_person);
    for d in 0..4 loop
      insert into public.shifts (location_id, week_start, employment_id, starts_at, ends_at, unpaid_break_minutes)
      values (
        v_location, v_monday + w * 7, v_employment,
        ((v_monday + w * 7 + d) + time '09:00') at time zone v_tz,
        ((v_monday + w * 7 + d) + time '17:00') at time zone v_tz,
        30
      );
    end loop;
  end loop;

  raise notice 'Demo organization ready for %', v_email;
end
$$;
