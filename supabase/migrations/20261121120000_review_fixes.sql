-- Fixes from an outside code review (Nov 21):
-- 1. A shift whose employee, times or clinic change goes back to "not acknowledged".
-- 2. Changing a shift cancels open exchange requests on it, so nobody is approved for
--    hours they didn't accept.
-- 3. The same shift can't be created twice for the same employee (copying a week twice).

-- ---------------------------------------------------------------- 1 and 2

create function app.on_shift_change() returns trigger
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
    update public.shift_swaps
    set status = 'cancelled',
        manager_note = coalesce(manager_note, 'Quart modifié par un gestionnaire / Shift changed by a manager')
    where status in ('pending_colleague', 'pending_manager')
      and (shift_id = new.id or target_shift_id = new.id);
  end if;
  return new;
end
$$;

create trigger on_shift_change before update on public.shifts
  for each row execute function app.on_shift_change();

create or replace function public.decide_swap(p_swap_id uuid, p_approve boolean, p_note text default null) returns jsonb
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

  -- Both people agreed to these exact shifts: keep them confirmed (see app.on_shift_change).
  perform set_config('app.swap_approval', 'on', true);
  update public.shifts set employment_id = v_swap.target_employment_id, response = 'confirmed' where id = v_shift.id;
  if v_target.id is not null then
    update public.shifts set employment_id = v_swap.requester_employment_id, response = 'confirmed' where id = v_target.id;
  end if;
  perform set_config('app.swap_approval', 'off', true);
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

-- ---------------------------------------------------------------- 3

-- Remove exact copies made before this fix (same employee, clinic, start and end), keeping the first.
delete from public.shifts a
using public.shifts b
where a.employment_id = b.employment_id
  and a.location_id = b.location_id
  and a.starts_at = b.starts_at
  and a.ends_at = b.ends_at
  and (a.created_at, a.id) > (b.created_at, b.id);

-- Open shifts (no employee) may repeat: NULLs are distinct in a unique constraint.
alter table public.shifts
  add constraint shifts_no_duplicate unique (employment_id, location_id, starts_at, ends_at);
