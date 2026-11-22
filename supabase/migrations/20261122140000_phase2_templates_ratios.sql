-- Phase 2, part 2 (Nov 22): staffing ratios, schedule templates and rotations, recurring shifts.

-- ---------------------------------------------------------------- staffing ratios
-- "Whenever 2 podiatrists are on shift, at least 1 receptionist": one row per required position.

create table public.staffing_ratio_rules (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references public.accounts on delete cascade,
  location_id uuid not null references public.locations on delete cascade,
  weekdays smallint[] not null default '{0,1,2,3,4,5,6}' check (weekdays <@ '{0,1,2,3,4,5,6}'::smallint[] and cardinality(weekdays) > 0),
  start_time time not null default '00:00',
  end_time time not null default '24:00',
  trigger_job_role_id uuid not null references public.job_roles on delete cascade,
  trigger_count smallint not null check (trigger_count between 1 and 50),
  required_job_role_id uuid not null references public.job_roles on delete cascade,
  required_count smallint not null check (required_count between 1 and 50),
  created_at timestamptz not null default now(),
  check (start_time < end_time),
  check (trigger_job_role_id <> required_job_role_id)
);
create index on public.staffing_ratio_rules (location_id);
create trigger fill_account_id before insert or update of account_id on public.staffing_ratio_rules
  for each row execute function app.fill_account_id();
alter table public.staffing_ratio_rules enable row level security;
create policy "members read staffing ratios" on public.staffing_ratio_rules for select to authenticated
  using (account_id = (select app.my_account_id()));
create policy "schedulers edit staffing ratios" on public.staffing_ratio_rules for all to authenticated
  using (app.can(location_id, 'schedule')) with check (app.can(location_id, 'schedule'));

-- ---------------------------------------------------------------- templates and rotations

create table public.schedule_templates (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references public.accounts on delete cascade,
  location_id uuid not null references public.locations on delete cascade,
  name text not null check (length(btrim(name)) between 1 and 80),
  -- 1 = same every week; 2 or more = a rotation (week A, week B, ...)
  weeks smallint not null default 1 check (weeks between 1 and 8),
  created_by uuid references public.persons on delete set null,
  created_at timestamptz not null default now()
);
create unique index schedule_templates_name_key on public.schedule_templates (location_id, lower(btrim(name)));
create trigger fill_account_id before insert or update of account_id on public.schedule_templates
  for each row execute function app.fill_account_id();

create table public.template_shifts (
  id uuid primary key default gen_random_uuid(),
  template_id uuid not null references public.schedule_templates on delete cascade,
  week_index smallint not null check (week_index between 0 and 7),
  weekday smallint not null check (weekday between 0 and 6), -- 0 = Monday
  start_time time not null,
  end_time time not null, -- at or before start_time: ends the next day
  employment_id uuid references public.employments on delete set null,
  job_role_id uuid references public.job_roles on delete set null,
  unpaid_break_minutes integer not null default 0 check (unpaid_break_minutes between 0 and 480),
  notes text check (length(notes) <= 500)
);
create index on public.template_shifts (template_id);

alter table public.schedule_templates enable row level security;
alter table public.template_shifts enable row level security;
create function app.can_template(p_template_id uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.schedule_templates t where t.id = p_template_id and app.can(t.location_id, 'schedule'))
$$;
create policy "schedulers read templates" on public.schedule_templates for select to authenticated
  using (app.can(location_id, 'schedule'));
create policy "schedulers delete templates" on public.schedule_templates for delete to authenticated
  using (app.can(location_id, 'schedule'));
create policy "schedulers read template shifts" on public.template_shifts for select to authenticated
  using (app.can_template(template_id));

-- Save one week, or several consecutive weeks as a rotation. Same name: replaced.
create function public.save_template(p_location_id uuid, p_name text, p_first_week date, p_weeks integer default 1) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_tz text;
  v_id uuid;
  v_count integer;
begin
  if not app.can(p_location_id, 'schedule') then return jsonb_build_object('ok', false, 'reason', 'not_allowed'); end if;
  if extract(isodow from p_first_week) <> 1 or p_weeks not between 1 and 8 or length(btrim(coalesce(p_name, ''))) = 0 then
    return jsonb_build_object('ok', false, 'reason', 'invalid');
  end if;
  select timezone into v_tz from public.locations where id = p_location_id;
  select id into v_id from public.schedule_templates where location_id = p_location_id and lower(btrim(name)) = lower(btrim(p_name));
  if v_id is null then
    insert into public.schedule_templates (location_id, name, weeks, created_by)
    values (p_location_id, btrim(p_name), p_weeks, app.my_person_id()) returning id into v_id;
  else
    update public.schedule_templates set weeks = p_weeks where id = v_id;
    delete from public.template_shifts where template_id = v_id;
  end if;
  insert into public.template_shifts (template_id, week_index, weekday, start_time, end_time, employment_id, job_role_id, unpaid_break_minutes, notes)
  select v_id, (s.week_start - p_first_week) / 7,
         extract(isodow from (s.starts_at at time zone v_tz))::int - 1,
         (s.starts_at at time zone v_tz)::time, (s.ends_at at time zone v_tz)::time,
         s.employment_id, s.job_role_id, s.unpaid_break_minutes, s.notes
  from public.shifts s
  where s.location_id = p_location_id and s.week_start >= p_first_week and s.week_start < p_first_week + 7 * p_weeks;
  get diagnostics v_count = row_count;
  return jsonb_build_object('ok', true, 'id', v_id, 'shifts', v_count);
end
$$;

-- Put a template on weeks [p_from_week, p_from_week + p_weeks). For a rotation, p_rotation_start is a Monday
-- that is "week A" (defaults to p_from_week). Safe to repeat: nothing is added twice.
-- Someone who no longer works at the clinic: their shift is added as an open shift for their position.
create function public.apply_template(p_template_id uuid, p_from_week date, p_weeks integer default 1, p_rotation_start date default null) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_t public.schedule_templates;
  v_tz text;
  v_week date;
  v_index integer;
  v_added integer := 0;
  v_n integer;
  v_start date := coalesce(p_rotation_start, p_from_week);
begin
  select * into v_t from public.schedule_templates where id = p_template_id;
  if v_t.id is null or not app.can(v_t.location_id, 'schedule') then return jsonb_build_object('ok', false, 'reason', 'not_allowed'); end if;
  if extract(isodow from p_from_week) <> 1 or extract(isodow from v_start) <> 1 or p_weeks not between 1 and 26 then
    return jsonb_build_object('ok', false, 'reason', 'invalid');
  end if;
  select timezone into v_tz from public.locations where id = v_t.location_id;
  for i in 0 .. p_weeks - 1 loop
    v_week := p_from_week + 7 * i;
    v_index := (((v_week - v_start) / 7) % v_t.weeks + v_t.weeks) % v_t.weeks;
    perform pg_advisory_xact_lock(hashtextextended('copy_week|' || v_t.location_id::text || '|' || v_week::text, 0));
    insert into public.schedule_weeks (location_id, week_start) values (v_t.location_id, v_week)
    on conflict (location_id, week_start) do nothing;
    with base as (
      select ts.*, e.job_role_id as emp_role,
             (e.id is not null and (e.end_date is null or e.end_date >= v_week + ts.weekday)
              and exists (select 1 from public.employment_locations el where el.employment_id = e.id and el.location_id = v_t.location_id)) as still_here
      from public.template_shifts ts
      left join public.employments e on e.id = ts.employment_id
      where ts.template_id = v_t.id and ts.week_index = v_index
    ), src as (
      select case when b.still_here then b.employment_id end as employment_id,
             case when b.still_here then b.job_role_id else coalesce(b.job_role_id, b.emp_role) end as job_role_id,
             b.unpaid_break_minutes, b.notes,
             ((v_week + b.weekday) + b.start_time) at time zone v_tz as starts_at,
             ((v_week + b.weekday + case when b.end_time <= b.start_time then 1 else 0 end) + b.end_time) at time zone v_tz as ends_at
      from base b
    ), numbered as (
      select src.*, row_number() over (partition by employment_id, starts_at, ends_at, job_role_id) as n from src
    ), dst as (
      select s.employment_id, s.job_role_id, s.starts_at, s.ends_at,
             row_number() over (partition by s.employment_id, s.starts_at, s.ends_at, s.job_role_id order by s.created_at, s.id) as n
      from public.shifts s where s.location_id = v_t.location_id and s.week_start = v_week
    ), ins as (
      insert into public.shifts (location_id, week_start, employment_id, starts_at, ends_at, unpaid_break_minutes, job_role_id, notes)
      select v_t.location_id, v_week, x.employment_id, x.starts_at, x.ends_at, x.unpaid_break_minutes, x.job_role_id, x.notes
      from numbered x
      where not exists (
        select 1 from dst
        where dst.starts_at = x.starts_at and dst.ends_at = x.ends_at
          and ((x.employment_id is not null and dst.employment_id = x.employment_id)
               or (x.employment_id is null and dst.employment_id is null and dst.job_role_id is not distinct from x.job_role_id and dst.n = x.n))
      )
      on conflict on constraint shifts_no_duplicate do nothing
      returning 1
    )
    select count(*) into v_n from ins;
    v_added := v_added + v_n;
  end loop;
  return jsonb_build_object('ok', true, 'added', v_added);
end
$$;

-- One shift repeated every week or every 2 weeks until a date (at most 52 times). Safe to repeat.
create function public.create_recurring_shifts(p_location_id uuid, p_employment_id uuid, p_job_role_id uuid,
                                               p_first_date date, p_start time, p_end time, p_break integer,
                                               p_every_weeks integer, p_until date) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_tz text;
  v_date date := p_first_date;
  v_week date;
  v_starts timestamptz;
  v_ends timestamptz;
  v_added integer := 0;
  v_i integer := 0;
begin
  if not app.can(p_location_id, 'schedule') then return jsonb_build_object('ok', false, 'reason', 'not_allowed'); end if;
  if p_every_weeks not in (1, 2) or p_until < p_first_date or p_until > p_first_date + 366 then
    return jsonb_build_object('ok', false, 'reason', 'invalid');
  end if;
  if p_employment_id is not null and not exists (
    select 1 from public.employment_locations el join public.employments e on e.id = el.employment_id
    where el.employment_id = p_employment_id and el.location_id = p_location_id
  ) then
    return jsonb_build_object('ok', false, 'reason', 'not_assigned');
  end if;
  select timezone into v_tz from public.locations where id = p_location_id;
  while v_date <= p_until and v_i < 52 loop
    v_week := v_date - (extract(isodow from v_date)::int - 1);
    v_starts := (v_date + p_start) at time zone v_tz;
    v_ends := ((v_date + case when p_end <= p_start then 1 else 0 end) + p_end) at time zone v_tz;
    perform pg_advisory_xact_lock(hashtextextended('copy_week|' || p_location_id::text || '|' || v_week::text, 0));
    insert into public.schedule_weeks (location_id, week_start) values (p_location_id, v_week)
    on conflict (location_id, week_start) do nothing;
    if not exists (
      select 1 from public.shifts s
      where s.location_id = p_location_id and s.starts_at = v_starts and s.ends_at = v_ends
        and s.employment_id is not distinct from p_employment_id
        and (p_employment_id is not null or s.job_role_id is not distinct from p_job_role_id)
    ) then
      insert into public.shifts (location_id, week_start, employment_id, starts_at, ends_at, unpaid_break_minutes, job_role_id)
      values (p_location_id, v_week, p_employment_id, v_starts, v_ends, coalesce(p_break, 0), p_job_role_id)
      on conflict on constraint shifts_no_duplicate do nothing;
      if found then v_added := v_added + 1; end if;
    end if;
    v_date := v_date + 7 * p_every_weeks;
    v_i := v_i + 1;
  end loop;
  return jsonb_build_object('ok', true, 'added', v_added);
end
$$;

do $$
declare f text;
begin
  foreach f in array array[
    'public.save_template(uuid, text, date, integer)',
    'public.apply_template(uuid, date, integer, date)',
    'public.create_recurring_shifts(uuid, uuid, uuid, date, time, time, integer, integer, date)'
  ] loop
    execute format('revoke execute on function %s from public, anon', f);
    execute format('grant execute on function %s to authenticated', f);
  end loop;
end
$$;
