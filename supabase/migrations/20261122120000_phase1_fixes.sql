-- Phase 1 (Nov 22)
--  1. Exchange agreed, then a shift changes:
--     - the offered shift's hours or clinic change → back to the colleague, who must accept again;
--     - the shift is given to someone else, or the shift asked in return changes → the request is cancelled.
--     Both people are told. The manager can only approve after a fresh acceptance.
--  2. Copy week runs on the server: one copy at a time per clinic and week, and copying again,
--     retrying or two managers at once give the same result as copying once. Identical open shifts
--     are kept as many times as in the source week.
--  3. Busy time at other clinics/companies: enough to detect conflicts (times, clinic, employer),
--     nothing about positions there.

-- ---------------------------------------------------------------- 1

alter table public.shift_swaps add column reset_count integer not null default 0;

create or replace function app.on_shift_change() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  -- An approved exchange moves shifts between two people who both accepted them.
  if current_setting('app.swap_approval', true) = 'on' then
    return new;
  end if;
  if new.employment_id is distinct from old.employment_id
     or new.starts_at <> old.starts_at
     or new.ends_at <> old.ends_at
     or new.location_id <> old.location_id then
    new.response := 'pending';
  end if;
  return new;
end
$$;

-- After the change is saved (so notifications show the new hours).
create function app.on_shift_changed_swaps() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if current_setting('app.swap_approval', true) = 'on' then
    return null;
  end if;
  if new.employment_id is distinct from old.employment_id
     or new.starts_at <> old.starts_at
     or new.ends_at <> old.ends_at
     or new.location_id <> old.location_id then
    -- Requests where this is the shift asked in return, or that now belongs to someone else: no longer valid.
    update public.shift_swaps
    set status = 'cancelled',
        manager_note = coalesce(manager_note, 'Quart modifié par un gestionnaire / Shift changed by a manager')
    where status in ('pending_colleague', 'pending_manager')
      and (target_shift_id = new.id or (shift_id = new.id and new.employment_id is distinct from old.employment_id));
    -- The offered shift moved: the colleague must accept the new hours.
    update public.shift_swaps
    set status = 'pending_colleague', colleague_responded_at = null, reset_count = reset_count + 1
    where status in ('pending_colleague', 'pending_manager')
      and shift_id = new.id
      and new.employment_id is not distinct from old.employment_id;
  end if;
  return null;
end
$$;

create trigger on_shift_changed_swaps after update on public.shifts
  for each row execute function app.on_shift_changed_swaps();

create or replace function app.notify_swap() returns trigger
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
  elsif new.reset_count > old.reset_count then
    perform app.notify(array[v_target],
      'Échange à reconfirmer', 'Les heures ont changé : ' || v_when_fr || '. Acceptez ou refusez de nouveau.',
      'Exchange to confirm again', 'The hours changed: ' || v_when_en || '. Accept or refuse again.', v_data);
  elsif new.status <> old.status then
    if new.status = 'approved' then
      perform app.notify(array[v_requester, v_target], 'Échange approuvé', v_when_fr, 'Exchange approved', v_when_en, v_data);
    elsif new.status = 'refused_manager' then
      perform app.notify(array[v_requester, v_target], 'Échange refusé', v_when_fr, 'Exchange refused', v_when_en, v_data);
    elsif new.status = 'refused_colleague' then
      select first_name into v_name from public.persons where id = v_target;
      perform app.notify(array[v_requester], 'Échange refusé', v_name || ' a refusé : ' || v_when_fr,
        'Exchange refused', v_name || ' refused: ' || v_when_en, v_data);
    elsif new.status = 'cancelled' then
      -- Whoever cancelled (the requester, or a manager changing a shift) isn't told about their own action.
      perform app.notify(array_remove(array[v_requester, v_target], app.my_person_id()),
        'Échange annulé', v_when_fr, 'Exchange cancelled', v_when_en, v_data);
    end if;
  end if;
  return null;
end
$$;

-- ---------------------------------------------------------------- 2

create function public.copy_week(p_location_id uuid, p_from_week date, p_to_week date) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_tz text;
  v_days integer := p_to_week - p_from_week;
  v_source integer;
  v_copied integer;
begin
  if not app.can(p_location_id, 'schedule') then
    return jsonb_build_object('ok', false, 'reason', 'not_allowed');
  end if;
  if v_days = 0 or extract(isodow from p_from_week) <> 1 or extract(isodow from p_to_week) <> 1 then
    return jsonb_build_object('ok', false, 'reason', 'bad_week');
  end if;
  -- One copy at a time for this clinic and week: a double click, a retry or a second manager waits here,
  -- then finds the shifts already there.
  perform pg_advisory_xact_lock(hashtextextended('copy_week|' || p_location_id::text || '|' || p_to_week::text, 0));
  select timezone into v_tz from public.locations where id = p_location_id;
  insert into public.schedule_weeks (location_id, week_start) values (p_location_id, p_to_week)
  on conflict (location_id, week_start) do nothing;

  select count(*) into v_source from public.shifts where location_id = p_location_id and week_start = p_from_week;

  with src as (
    -- Same local clock times, even across a daylight-saving change.
    select s.employment_id, s.job_role_id, s.unpaid_break_minutes, s.notes,
           ((s.starts_at at time zone v_tz) + v_days * interval '1 day') at time zone v_tz as starts_at,
           ((s.ends_at at time zone v_tz) + v_days * interval '1 day') at time zone v_tz as ends_at,
           row_number() over (partition by s.employment_id, s.starts_at, s.ends_at, s.job_role_id order by s.created_at, s.id) as n
    from public.shifts s
    where s.location_id = p_location_id and s.week_start = p_from_week
  ),
  dst as (
    select s.employment_id, s.job_role_id, s.starts_at, s.ends_at,
           row_number() over (partition by s.employment_id, s.starts_at, s.ends_at, s.job_role_id order by s.created_at, s.id) as n
    from public.shifts s
    where s.location_id = p_location_id and s.week_start = p_to_week
  ),
  ins as (
    insert into public.shifts (location_id, week_start, employment_id, starts_at, ends_at, unpaid_break_minutes, job_role_id, notes)
    select p_location_id, p_to_week, src.employment_id, src.starts_at, src.ends_at, src.unpaid_break_minutes, src.job_role_id, src.notes
    from src
    where not exists (
      select 1 from dst
      where dst.starts_at = src.starts_at and dst.ends_at = src.ends_at
        and (
          -- someone's shift: already there
          (src.employment_id is not null and dst.employment_id = src.employment_id)
          -- open shift: the n-th identical one is already there
          or (src.employment_id is null and dst.employment_id is null
              and dst.job_role_id is not distinct from src.job_role_id and dst.n = src.n)
        )
    )
    on conflict on constraint shifts_no_duplicate do nothing
    returning 1
  )
  select count(*) into v_copied from ins;
  return jsonb_build_object('ok', true, 'copied', v_copied, 'source', v_source);
end
$$;
revoke execute on function public.copy_week(uuid, date, date) from public, anon;
grant execute on function public.copy_week(uuid, date, date) to authenticated;

-- ---------------------------------------------------------------- 3

create or replace function public.busy_shifts(p_person_ids uuid[], p_from timestamptz, p_to timestamptz) returns jsonb
language sql stable security definer set search_path = '' as $$
  with people as (
    select id from public.persons
    where id = any (p_person_ids) and account_id = app.my_account_id() and app.can_for_person(id, 'schedule')
  ),
  emps as (
    select e.* from public.employments e where e.person_id in (select id from people)
  )
  select jsonb_build_object(
    -- Employer and clinics only: pay, payroll number and position at another employer stay private.
    'employments', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', e.id, 'person_id', e.person_id, 'company_id', e.company_id,
        'location_ids', coalesce((select jsonb_agg(el.location_id) from public.employment_locations el where el.employment_id = e.id), '[]'::jsonb)))
      from emps e), '[]'::jsonb),
    -- When and where: enough for overlaps, travel time, rest and weekly hours. Notes and positions stay private.
    'shifts', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', s.id, 'employment_id', s.employment_id, 'location_id', s.location_id, 'week_start', s.week_start,
        'starts_at', s.starts_at, 'ends_at', s.ends_at, 'unpaid_break_minutes', s.unpaid_break_minutes,
        'published', app.is_week_published(s.location_id, s.week_start)))
      from public.shifts s
      where s.employment_id in (select id from emps) and s.starts_at < p_to and s.ends_at > p_from), '[]'::jsonb)
  )
$$;

-- The phone shows "hours changed, accept again" on an exchange sent back to the colleague.
create or replace function public.my_swaps() returns jsonb
language sql stable security definer set search_path = '' as $$
  select coalesce(jsonb_agg(jsonb_build_object(
      'id', w.id,
      'status', w.status,
      'incoming', w.target_employment_id in (select app.my_employment_ids()),
      'note', w.note,
      'manager_note', w.manager_note,
      'reset_count', w.reset_count,
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
