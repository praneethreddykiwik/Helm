-- 0413_r245_login_delete_guard.sql - CANONICAL forward-only. R245 (fix plan Phase 6 "Account and team safety", owner
-- approved 20 Nov 2026; ACC-05). REQUIRES 0283 (team safety) + 0296 (_r55_purge_allowed, the purge marks).
--
-- In plain words:
--   Deleting a studio team member's LOGIN in the Supabase dashboard (Authentication -> Users -> Delete user, or a
--   "delete from auth.users" typed in the SQL editor) skipped every Helm guard: the dashboard is an admin role, so the
--   app's own checks never ran and the database simply cascaded / emptied the member's links. From now on such a delete
--   is REFUSED with a plain message ("Deactivate them in Settings -> Team instead"). Nothing is deleted or changed.
--
--   Refused: a login whose Helm profile belongs to a studio (profiles.org_id is set) and that has been used (confirmed
--   e-mail or signed in at least once).
--   Still allowed, exactly as before:
--     * logins with no studio (HQ staff, people who never finished sign-up, orphans) - the ACC-03 report lists the
--       unconfirmed ones; removing them stays an owner decision;
--     * a login that was never confirmed AND never signed in (an invitation nobody accepted). Supabase Auth may replace
--       such a row by itself while linking a Google sign-in to the same address - that internal flow must never break;
--     * every server path that already marks its transaction: the free-trial purge (helm.trial_purge_org = that studio),
--       helm.allow_purge / helm.allow_org_purge (0296 marks, never usable by an app user), and the owner-run scripts that
--       delete the profile first (DELETE-0398 pattern: the profile is gone, so this guard has nothing to protect);
--     * the documented owner flag below.
--
--   THE OWNER FLAG (deliberate removal, Supabase -> SQL editor, staging first; take a backup / copy the rows first):
--       begin;
--       select set_config('helm.allow_login_delete', '<the login''s user id>', true);   -- 'on' = any login, this transaction only
--       delete from auth.users where id = '<the login''s user id>';
--       commit;
--     The flag lives only inside that one transaction (set_config(..., true)); it is gone at commit / rollback.
--
--   A bug inside the check never blocks a delete (it fails open, like the 0403 e-mail guard): this guard may only ever
--   say "no" on purpose, never by accident, so Supabase's own flows can not be broken by it.
--
-- ROLLBACK (manual, only if ever needed): drop trigger if exists a0_r413_login_delete_guard on auth.users;
-- ZERO DATA LOSS: additive + idempotent. 2 functions + 1 trigger. No table, column or row is changed. Safe to run twice.
-- ASCII only.

do $$
begin
  if to_regclass('auth.users') is null or to_regclass('public.profiles') is null then
    raise exception 'STOP 0413: auth.users / public.profiles missing'; end if;
  if to_regprocedure('public._r55_purge_allowed(uuid,boolean)') is null then
    raise exception 'STOP 0413: _r55_purge_allowed missing - run 0296 first'; end if;
  if to_regclass('public.team_member_status') is null then
    raise exception 'STOP 0413: team_member_status missing - run 0283 first'; end if;
end $$;

-- is this delete of a studio member's login marked as deliberate for this transaction?
create or replace function public._r413_login_delete_allowed(p_user uuid, p_org uuid)
returns boolean language sql stable set search_path = '' as $$
  -- r245-0413: the owner flag (this login / 'on') or an existing server purge mark (0184 trial purge, 0296 marks)
  select coalesce(current_setting('helm.allow_login_delete', true), '') in ('on', coalesce(p_user::text, 'on'))
      or coalesce(public._r55_purge_allowed(p_org, false), false)
$$;
revoke all on function public._r413_login_delete_allowed(uuid, uuid) from public;

-- BEFORE DELETE row guard on auth.users (definer: the dashboard deletes as supabase_auth_admin, which cannot read profiles)
create or replace function public._r413_tg_login_delete_guard()
returns trigger language plpgsql security definer set search_path = '' as $$
-- r245-0413 ACC-05
declare v_org uuid; v_used boolean := false; v_block boolean := false; j jsonb;
begin
  begin
    select p.org_id into v_org from public.profiles p where p.id = old.id;
    if v_org is not null then
      j := to_jsonb(old);
      v_used := coalesce(j ->> 'email_confirmed_at', j ->> 'phone_confirmed_at', j ->> 'last_sign_in_at') is not null;
      v_block := v_used and not public._r413_login_delete_allowed(old.id, v_org);
    end if;
  exception when others then v_block := false;   -- a bug in the check never blocks
  end;
  if v_block then
    raise exception 'This login belongs to a member of a studio team and is not deleted here. Deactivate them in Settings -> Team instead - nothing is lost and they can be reactivated.'
      using errcode = '42501', hint = 'login_delete_refused',
            detail = 'r245-0413: an owner-run script may set helm.allow_login_delete (this login id, this transaction only) - see migration 0413.';
  end if;
  return old;
end $$;
revoke all on function public._r413_tg_login_delete_guard() from public;
do $$ declare r text; begin
  foreach r in array array['anon', 'authenticated', 'service_role'] loop
    if exists (select 1 from pg_roles where rolname = r) then
      execute format('revoke all on function public._r413_login_delete_allowed(uuid, uuid) from %I', r);
      execute format('revoke all on function public._r413_tg_login_delete_guard() from %I', r);
    end if;
  end loop;
end $$;

-- attach (named a0_ so it runs before anything else on a delete). On a project that refuses triggers on auth.users the
-- file still finishes; check row 01 of APPLY-0413 then shows false.
do $$
begin
  drop trigger if exists a0_r413_login_delete_guard on auth.users;
  create trigger a0_r413_login_delete_guard before delete on auth.users
    for each row execute function public._r413_tg_login_delete_guard();
exception when insufficient_privilege then
  raise notice '0413: could not add the delete guard on auth.users (%). Keep the owner rule: never delete members in the dashboard.', sqlerrm;
end $$;

do $$ begin
  if to_regclass('public.helm_schema_markers') is not null then
    insert into public.helm_schema_markers(num, name) values (413, '0413_r245_login_delete_guard') on conflict (num) do nothing;
  end if;
end $$;
