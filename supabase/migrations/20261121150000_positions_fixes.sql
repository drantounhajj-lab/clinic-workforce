-- Fixes found by end-to-end testing (Nov 21):
--  1. Two positions with the same name could be created. Merge existing duplicates, then refuse new ones.
--  2. Exchanges, volunteering for open shifts and "ask the team" ignored the position:
--     a receptionist could be offered a podiatrist's shift. A shift's position is its own,
--     else its employee's. When both sides have a position, they must match.

-- 1. One position per name per account ------------------------------------------------------------
create temporary table dup_job_roles on commit drop as
select id, keep_id from (
  select id, first_value(id) over (partition by account_id, lower(btrim(name_fr)) order by id) as keep_id
  from public.job_roles
) r
where id <> keep_id;

update public.employments e set job_role_id = d.keep_id from dup_job_roles d where e.job_role_id = d.id;
update public.shifts s set job_role_id = d.keep_id from dup_job_roles d where s.job_role_id = d.id;
update public.coverage_rules c set job_role_id = d.keep_id from dup_job_roles d where c.job_role_id = d.id;
delete from public.job_roles j using dup_job_roles d where j.id = d.id;

create unique index job_roles_account_name_key on public.job_roles (account_id, lower(btrim(name_fr)));

-- 2. Positions in exchanges and open shifts -------------------------------------------------------
create function app.shift_position(p_shift public.shifts) returns uuid
language sql stable security definer set search_path = '' as $$
  select coalesce(p_shift.job_role_id, (select e.job_role_id from public.employments e where e.id = p_shift.employment_id))
$$;

-- True when this employment can work a shift needing this position. Unknown on either side = yes.
create function app.position_fits(p_employment_id uuid, p_position uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select p_position is null
      or coalesce((select e.job_role_id from public.employments e where e.id = p_employment_id), p_position) = p_position
$$;

create or replace function public.swap_candidates(p_shift_id uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v_shift public.shifts;
  v_me uuid := app.my_person_id();
  v_position uuid;
begin
  v_shift := app.my_open_shift(p_shift_id);
  if v_shift.id is null then
    return jsonb_build_object('ok', false, 'reason', 'not_allowed');
  end if;
  v_position := app.shift_position(v_shift);
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
            and app.position_fits(v_shift.employment_id, app.shift_position(s))
        ), '[]'::jsonb)
      ) as c
      from public.employments e
      join public.persons p on p.id = e.person_id
      join public.employment_locations el on el.employment_id = e.id and el.location_id = v_shift.location_id
      where p.id <> v_me
        and (e.end_date is null or e.end_date >= current_date)
        and app.position_fits(e.id, v_position)
    ) x
  ), '[]'::jsonb));
end
$$;

create or replace function public.request_shift_swap(p_shift_id uuid, p_target_employment_id uuid,
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
  if not app.position_fits(p_target_employment_id, app.shift_position(v_shift)) then
    return jsonb_build_object('ok', false, 'reason', 'wrong_position');
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
    if not app.position_fits(v_shift.employment_id, app.shift_position(v_target)) then
      return jsonb_build_object('ok', false, 'reason', 'wrong_position');
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

create or replace function public.claim_open_shift(p_shift_id uuid) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_shift public.shifts;
  v_employment uuid;
begin
  select * into v_shift from public.shifts where id = p_shift_id;
  if not coalesce(app.open_shift_ok(v_shift), false) then return jsonb_build_object('ok', false, 'reason', 'not_open'); end if;
  if not exists (
    select 1 from public.employments e
    join public.employment_locations el on el.employment_id = e.id and el.location_id = v_shift.location_id
    where e.person_id = app.my_person_id() and (e.end_date is null or e.end_date >= current_date)
  ) then
    return jsonb_build_object('ok', false, 'reason', 'not_assigned');
  end if;
  select e.id into v_employment
  from public.employments e
  join public.employment_locations el on el.employment_id = e.id and el.location_id = v_shift.location_id
  where e.person_id = app.my_person_id() and (e.end_date is null or e.end_date >= current_date)
    and app.position_fits(e.id, v_shift.job_role_id)
  order by (e.job_role_id = v_shift.job_role_id) desc nulls last
  limit 1;
  if v_employment is null then return jsonb_build_object('ok', false, 'reason', 'wrong_position'); end if;
  if app.person_busy(v_employment, v_shift.starts_at, v_shift.ends_at, '{}') then
    return jsonb_build_object('ok', false, 'reason', 'busy');
  end if;
  insert into public.shift_claims (shift_id, location_id, employment_id) values (v_shift.id, v_shift.location_id, v_employment)
  on conflict (shift_id, employment_id) do update set status = 'pending', created_at = now(), decided_at = null;
  return jsonb_build_object('ok', true);
end
$$;

create or replace function public.request_coverage(p_shift_id uuid) returns jsonb
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
    and app.position_fits(e.id, v_shift.job_role_id)
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
