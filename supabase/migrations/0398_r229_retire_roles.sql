-- 0398_r229_retire_roles.sql - R229 (owner, 18 Nov 2026). CANONICAL forward-only.
-- REQUIRES the profiles + invitations tables (baseline), auth.uid() / auth.jwt() (Supabase), optional is_platform_admin().
--
-- In plain words:
--   The studio roles "Event coordinator" (coordinator), "Designer" (designer) and "Crew" (crew, as a LOGIN role) are
--   retired. Nobody can be GIVEN one of them any more: a new invitation, an invitation changed to one of them, Add user,
--   or a role change (Settings -> Users & invites, the Staff page, Control Center -> Team) is refused with a plain
--   message: choose another role, for example Event manager or Planner.
--   People who ALREADY have one of these roles keep it and keep working exactly as before, until an admin picks a new
--   role for them. Saving anything else on their row (name, phone, studio...) is never blocked - only a CHANGE TO a
--   retired role is. A person who accepts an invitation that was sent BEFORE this change (with one of these roles)
--   still joins with it (their invitation was already given).
--   Not affected: the database itself (migrations, scheduled jobs), the service role (edge functions) and Helm HQ
--   operators (is_platform_admin). The role_access rows of these roles are kept as they are (nothing deleted), so
--   the existing holders keep the same pages.
--   OWNER SCOPE CHANGE (18 Nov 2026): Event coordinator and Designer are REMOVED for good (Crew stays only disabled):
--   * open (pending) invitations with coordinator / designer are cancelled (status 'revoked', exactly what "Cancel
--     invite" does - the row is kept; a copy of each row goes to the new backup table public._r398_backup first);
--   * no NEW role_access row is ever written for coordinator / designer (new studios' default matrix, re-seeds, saves):
--     a BEFORE INSERT trigger skips such a row; existing rows are NOT deleted here (the separate owner-run file
--     supabase/DELETE-0398-RETIRED-ROLE-USERS.sql deletes them, with a backup, after the people are reassigned / removed);
--   * the role lists _notify_roles() and _r383_roles_all() and the sign-in notice default (_r383_cfg, patched in
--     place) no longer name coordinator / designer.
--   Deleting people is NOT done here - see supabase/DELETE-0398-RETIRED-ROLE-USERS.sql (owner runs it, two steps).
--   No column or policy changed; no profile, user, staff, quote, task or role_access row is deleted or rewritten.
--   New: _r398_retired_roles(), _r398_removed_roles(), _r398_role_label(text), _r398_gate_on(), _r398_tg_profile_role(),
--   _r398_tg_invite_role(), _r398_tg_role_access() + three BEFORE triggers (a398_retired_role_guard on profiles,
--   invitations and role_access) + table public._r398_backup (RLS on, no app privilege).
--   Test switch: helm.retired_role_gate = 'off' turns the guard off (the local test cluster's older suites only;
--   the app's API calls cannot set it). Additive + idempotent (create or replace, drop trigger if exists): safe to
--   run twice. ASCII only.

-- ---- the retired role keys (one place) ------------------------------------------------------------------------------
create or replace function public._r398_retired_roles()
returns text[] language sql immutable set search_path = '' as $$
  -- r229-0398
  select array['coordinator', 'designer', 'crew']::text[];
$$;

create or replace function public._r398_role_label(p_role text)
returns text language sql immutable set search_path = '' as $$
  -- r229-0398
  select case p_role when 'coordinator' then 'Event coordinator' when 'designer' then 'Designer' when 'crew' then 'Crew'
                     else coalesce(p_role, '') end;
$$;

create or replace function public._r398_removed_roles()
returns text[] language sql immutable set search_path = '' as $$
  -- r229-0398: removed for good (owner 18 Nov 2026); crew is only disabled
  select array['coordinator', 'designer']::text[];
$$;

-- ---- backup table: a copy of every row this migration (or the owner-run DELETE file) changes or removes -----------------
create table if not exists public._r398_backup (
  id        bigserial primary key,
  run_at    timestamptz not null default now(),
  kind      text not null,             -- invitation_revoked / role_access / profile / auth_user / staff / ref_nulled / cascade_row
  tbl       text,
  col       text,
  user_id   uuid,
  row_data  jsonb not null
);
alter table public._r398_backup enable row level security;
revoke all on table public._r398_backup from public;
do $r398t$ begin
  if exists (select 1 from pg_roles where rolname = 'anon') then execute 'revoke all on table public._r398_backup from anon'; end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then execute 'revoke all on table public._r398_backup from authenticated'; end if;
  if exists (select 1 from pg_roles where rolname = 'service_role') then execute 'revoke all on table public._r398_backup from service_role'; end if;
  if exists (select 1 from pg_class where relname = '_r398_backup_id_seq' and relnamespace = 'public'::regnamespace) then
    execute 'revoke all on sequence public._r398_backup_id_seq from public';
  end if;
end $r398t$;

-- ---- is this a signed-in app call (the only calls the guard refuses)? ------------------------------------------------
create or replace function public._r398_gate_on()
returns boolean language plpgsql stable security definer set search_path = '' as $$
begin
  -- r229-0398
  if coalesce(current_setting('helm.retired_role_gate', true), '') = 'off' then return false; end if;
  if auth.uid() is null then return false; end if;                                  -- the database itself / scheduled jobs
  if coalesce(auth.jwt() ->> 'role', '') in ('service_role', 'supabase_admin') then return false; end if;
  if coalesce(current_setting('helm.r283_apply', true), '') = 'on' then return false; end if;   -- a change asked for before
  if to_regprocedure('public.is_platform_admin()') is not null then
    begin
      if coalesce(public.is_platform_admin(), false) then return false; end if;     -- Helm HQ
    exception when others then null;
    end;
  end if;
  return true;
end $$;

-- ---- profiles: refuse a CHANGE TO a retired role -----------------------------------------------------------------------
create or replace function public._r398_tg_profile_role()
returns trigger language plpgsql security definer set search_path = '' as $$
declare v_email text;
begin
  -- r229-0398
  if new.role is null or not (new.role = any (public._r398_retired_roles())) then return new; end if;
  if tg_op = 'UPDATE' and old.role is not distinct from new.role then return new; end if;   -- an existing holder: never blocked
  if not public._r398_gate_on() then return new; end if;
  -- the person themselves accepting an invitation sent before 0398 with this role, for their e-mail (or a link-only one)
  if auth.uid() = new.id and new.org_id is not null then
    select lower(u.email) into v_email from auth.users u where u.id = new.id;
    if exists (select 1 from public.invitations i
                where i.org_id = new.org_id and i.role = new.role
                  and (i.status = 'pending' or i.accepted_by = new.id)
                  and (i.email is null or lower(i.email) = coalesce(v_email, lower(new.email)))) then
      return new;
    end if;
  end if;
  raise exception 'The role "%" is retired and can''t be given to anyone new. Choose another role - for example Event manager or Planner.',
    public._r398_role_label(new.role) using errcode = '22023', hint = 'retired_role';
end $$;

-- ---- invitations: refuse a NEW invitation with a retired role (or one changed to it) ---------------------------------
create or replace function public._r398_tg_invite_role()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  -- r229-0398
  if new.role is null or not (new.role = any (public._r398_retired_roles())) then return new; end if;
  if tg_op = 'UPDATE' and old.role is not distinct from new.role then return new; end if;   -- an existing invitation: kept
  if not public._r398_gate_on() then return new; end if;
  raise exception 'The role "%" is retired - invite them with another role, for example Event manager or Planner.',
    public._r398_role_label(new.role) using errcode = '22023', hint = 'retired_role';
end $$;

-- "a398_" sorts before the other BEFORE triggers: the refusal comes first (no two-step prompt, seat count or mail queued)
drop trigger if exists a398_retired_role_guard on public.profiles;
create trigger a398_retired_role_guard before insert or update of role on public.profiles
  for each row execute function public._r398_tg_profile_role();
drop trigger if exists a398_retired_role_guard on public.invitations;
create trigger a398_retired_role_guard before insert or update of role on public.invitations
  for each row execute function public._r398_tg_invite_role();

-- ---- role_access: never a NEW row for a removed role (new studios, re-seeds, saves); existing rows untouched ----------
create or replace function public._r398_tg_role_access()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  -- r229-0398
  if new.role = any (public._r398_removed_roles())
     and coalesce(current_setting('helm.retired_role_gate', true), '') <> 'off' then
    return null;   -- skipped quietly: the seed / save goes on for every other role
  end if;
  return new;
end $$;
drop trigger if exists a398_retired_role_guard on public.role_access;
create trigger a398_retired_role_guard before insert on public.role_access
  for each row execute function public._r398_tg_role_access();

-- ---- open invitations with a removed role: cancelled (= "Cancel invite": status revoked, row kept, copy kept) ---------
insert into public._r398_backup(kind, tbl, row_data)
  select 'invitation_revoked', 'invitations', to_jsonb(i) from public.invitations i
   where i.status = 'pending' and i.role = any (public._r398_removed_roles());
update public.invitations set status = 'revoked'
 where status = 'pending' and role = any (public._r398_removed_roles());

-- ---- role lists without the removed roles ----------------------------------------------------------------------------
create or replace function public._notify_roles()
returns text[] language sql immutable set search_path = '' as $$
  -- r229-0398: coordinator / designer removed
  select array['admin','manager','planner','sales','supervisor','quality','operations','crew','worker']::text[];
$$;
create or replace function public._r383_roles_all()
returns text[] language sql immutable set search_path = '' as $$
  -- r205-0383 / r229-0398: coordinator / designer removed
  select array['admin', 'manager', 'planner', 'sales', 'supervisor', 'quality', 'operations', 'crew']::text[];
$$;
do $r398c$ begin
  if to_regprocedure('public._r383_cfg(uuid)') is not null and to_regprocedure('public._a156_patch(regprocedure,text,text)') is not null
     and position('''coordinator''' in pg_get_functiondef('public._r383_cfg(uuid)'::regprocedure)) > 0 then
    perform public._a156_patch('public._r383_cfg(uuid)'::regprocedure,
      'array[''admin'', ''manager'', ''planner'', ''sales'', ''coordinator'', ''supervisor'', ''quality'', ''operations'', ''designer'']::text[]',
      'array[''admin'', ''manager'', ''planner'', ''sales'', ''supervisor'', ''quality'', ''operations'']::text[] /* r229-0398 */');
  end if;
end $r398c$;

-- server-only helpers: no app privilege
revoke all on function public._r398_retired_roles() from public;
revoke all on function public._r398_role_label(text) from public;
revoke all on function public._r398_gate_on() from public;
revoke all on function public._r398_tg_profile_role() from public;
revoke all on function public._r398_tg_invite_role() from public;
revoke all on function public._r398_tg_role_access() from public;
revoke all on function public._r398_removed_roles() from public;
do $r398$ begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    execute 'revoke all on function public._r398_retired_roles(), public._r398_role_label(text), public._r398_gate_on(), '
         || 'public._r398_tg_profile_role(), public._r398_tg_invite_role(), public._r398_tg_role_access(), public._r398_removed_roles() from anon';
  end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    execute 'revoke all on function public._r398_retired_roles(), public._r398_role_label(text), public._r398_gate_on(), '
         || 'public._r398_tg_profile_role(), public._r398_tg_invite_role(), public._r398_tg_role_access(), public._r398_removed_roles() from authenticated';
  end if;
end $r398$;
