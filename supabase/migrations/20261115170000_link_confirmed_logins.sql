-- Link a login to an invited employee only when it is safe:
--   * Supabase has confirmed the email (the person typed the emailed code), and
--   * the login has no password (the app only uses email codes).
-- Without this, someone could register an employee's email with a password before the employee's
-- first sign-in, then reuse that password once the employee confirms the email.
-- Also links people who signed in before a manager added them.

create or replace function app.link_new_user() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if new.email is not null
     and new.email_confirmed_at is not null
     and coalesce(new.encrypted_password, '') = ''
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

-- The existing insert trigger now uses the stricter function above. This one links at the moment
-- the email gets confirmed.
create trigger link_confirmed_user after update of email_confirmed_at, encrypted_password on auth.users
  for each row execute function app.link_new_user();

-- When a manager adds someone (or fixes their email) who already signed in once, link them.
-- Runs after the row is saved: managers themselves may not set user_id (row-level security).
create function app.link_existing_user() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  v_user uuid;
begin
  if new.user_id is null and new.email is not null then
    select u.id into v_user
    from auth.users u
    where lower(u.email) = new.email
      and u.email_confirmed_at is not null
      and coalesce(u.encrypted_password, '') = ''
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
create trigger persons_link_login after insert or update of email on public.persons
  for each row execute function app.link_existing_user();
