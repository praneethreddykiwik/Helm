-- 0381_r203_test_studio_two_step.sql - CANONICAL forward-only. R203 (owner 18 Nov 2026). ASCII only.
-- REQUIRES 0285 (r35: _r285_step_up and its helpers _r285_flagged / _r285_has_mfa / _r285_mfa_at), 0277 / 0332
--          (_hq27_require: the one HQ permission check - staff, two-step, role), phase29 / phase57 (current_org_id),
--          the organizations and audit_log tables.
--
-- In plain words:
--   The owner's TEST studio ("Helm Studio", slug helm-studio) is shared by many testers on one admin login, so the
--   r35 two-step requirement ("Set up two-step verification on your account first...") blocks "Add user" and
--   "Create invite link" for an Admin there. This file adds a per-studio TEST STUDIO switch that only Helm HQ can set:
--     * NEW table studio_test_mode (one row per studio, two_step_exempt yes / no, default: no row = OFF). RLS on, no
--       privilege for the app at all: a studio (or anyone signed in to the app) can never read or change it. A
--       trigger also refuses any change made by a signed-in app user who is not a Helm HQ staff member.
--     * NEW table studio_test_mode_log: every switch on / off is written here by a trigger (who, when, from where:
--       the HQ call or the SQL editor). Append-only (updates and deletes refused). No app privilege.
--     * NEW hq_set_test_studio(org, on, note): the HQ way to set it - HQ Owner / Admin only (the 0277 'studios.edit'
--       permission: two-step session, role check, IP allow-list), a note of 10+ characters, also written to the HQ
--       audit log (hq.studio.test_mode).
--     * NEW my_test_studio(): yes / no for the caller's OWN studio, so the app can show the banner
--       "Test studio - two-step not enforced". Signed-in only.
--     * _r285_step_up(org) re-issued in place: when the studio's switch is ON the two-step parts (R35_SETUP_2STEP /
--       R35_REAUTH) are skipped for THAT studio only. The "This wasn't us" flag (R35_FLAGGED) is still enforced.
--       Every other studio: exactly the 0285 rule (no row, or a row with two_step_exempt = false).
--   Switch it on for Helm Studio (owner, SQL editor; see APPLY-0381.sql):
--     insert into public.studio_test_mode (studio, two_step_exempt, note) select id, true, 'Shared tester login (R203)' from public.organizations where slug = 'helm-studio' on conflict (studio) do update set two_step_exempt = true, note = excluded.note, set_at = now();
--   Switch it off again:
--     update public.studio_test_mode set two_step_exempt = false, set_at = now() where studio = (select id from public.organizations where slug = 'helm-studio');
-- Changes: 2 NEW tables, 4 NEW functions, 1 function re-issued in place (_r285_step_up, same inputs / result / grants).
-- Nothing is dropped or deleted; no existing row is changed. Safe to run twice.
-- NOTE: re-running 0285 on its own afterwards puts its original _r285_step_up back (the switch then has no effect);
--       run 0381 again after it.
-- Undo (manual): re-run 0285's _r285_step_up definition; drop function public.hq_set_test_studio(uuid, boolean, text);
--   drop function public.my_test_studio(); (the tables can stay - unused)

-- ---- STOP guard ---------------------------------------------------------------------------------------------------
do $$ begin
  if to_regprocedure('public._r285_step_up(uuid)') is null or to_regprocedure('public._r285_flagged(uuid, uuid)') is null
     or to_regprocedure('public._r285_has_mfa(uuid)') is null or to_regprocedure('public._r285_mfa_at()') is null then
    raise exception 'STOP 0381: apply 0285 first (r35 two-step for sensitive changes)'; end if;
  if to_regprocedure('public._hq27_require(text, boolean)') is null or to_regprocedure('public.is_platform_admin()') is null then
    raise exception 'STOP 0381: apply 0277 first (HQ staff roles)'; end if;
  if to_regprocedure('public.current_org_id()') is null or to_regclass('public.organizations') is null
     or to_regclass('public.audit_log') is null then
    raise exception 'STOP 0381: current_org_id / organizations / audit_log missing'; end if;
end $$;

-- ---- 1) the switch + its log (private: RLS on, no app privilege) -----------------------------------------------------
create table if not exists public.studio_test_mode (
  studio          uuid        primary key,   -- organizations.id (no org_id column / FK: studio purges and org-table sweeps leave it alone)
  two_step_exempt boolean     not null default false,
  note            text        check (note is null or char_length(note) <= 300),
  set_by          uuid,
  set_at          timestamptz not null default now()
);
create table if not exists public.studio_test_mode_log (
  id              bigint generated always as identity primary key,
  studio          uuid        not null,
  two_step_exempt boolean     not null,
  was             boolean,
  note            text,
  changed_by      uuid,
  via             text        not null check (via in ('hq', 'sql_editor', 'service')),
  at              timestamptz not null default now()
);
do $$ declare t text; begin
  foreach t in array array['studio_test_mode', 'studio_test_mode_log'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on table public.%I from public', t);
    if exists (select 1 from pg_roles where rolname = 'anon') then execute format('revoke all on table public.%I from anon', t); end if;
    if exists (select 1 from pg_roles where rolname = 'authenticated') then execute format('revoke all on table public.%I from authenticated', t); end if;
    if exists (select 1 from pg_roles where rolname = 'service_role') then execute format('grant select on table public.%I to service_role', t); end if;
  end loop;
end $$;

-- who is changing the switch: refused for a signed-in app user who is not Helm HQ staff (defence in depth - the
-- table has no app privilege at all); the database itself (SQL editor), the service role and HQ pass
create or replace function public._r381_tg_test_mode_guard()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  -- r203-0381
  if auth.uid() is not null and coalesce(auth.jwt() ->> 'role', '') not in ('service_role', 'supabase_admin')
     and not coalesce(public.is_platform_admin(), false) then
    raise exception 'not authorized: only Helm HQ can change the test studio switch' using errcode = '42501';
  end if;
  return case when tg_op = 'DELETE' then old else new end;
end $$;

create or replace function public._r381_tg_test_mode_log()
returns trigger language plpgsql security definer set search_path = '' as $$
declare v_via text;
begin
  -- r203-0381: every switch on / off is logged (who, when, from where)
  v_via := case when coalesce(auth.jwt() ->> 'role', '') in ('service_role', 'supabase_admin') then 'service'
                when auth.uid() is null then 'sql_editor' else 'hq' end;
  if tg_op = 'DELETE' then
    insert into public.studio_test_mode_log(studio, two_step_exempt, was, note, changed_by, via)
      values (old.studio, false, old.two_step_exempt, 'row removed', auth.uid(), v_via);
    return old;
  end if;
  if tg_op = 'UPDATE' and new.two_step_exempt is not distinct from old.two_step_exempt
     and new.note is not distinct from old.note then return new; end if;
  insert into public.studio_test_mode_log(studio, two_step_exempt, was, note, changed_by, via)
    values (new.studio, new.two_step_exempt, case when tg_op = 'UPDATE' then old.two_step_exempt end, new.note, auth.uid(), v_via);
  return new;
end $$;

create or replace function public._r381_tg_log_append_only()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  -- r203-0381
  raise exception 'studio_test_mode_log is append-only' using errcode = '42501';
end $$;

do $$ declare f text; begin
  foreach f in array array['public._r381_tg_test_mode_guard()', 'public._r381_tg_test_mode_log()', 'public._r381_tg_log_append_only()'] loop
    execute format('revoke all on function %s from public', f);
    if exists (select 1 from pg_roles where rolname = 'anon') then execute format('revoke all on function %s from anon', f); end if;
    if exists (select 1 from pg_roles where rolname = 'authenticated') then execute format('revoke all on function %s from authenticated', f); end if;
  end loop;
end $$;
drop trigger if exists zz_r381_guard on public.studio_test_mode;
create trigger zz_r381_guard before insert or update or delete on public.studio_test_mode
  for each row execute function public._r381_tg_test_mode_guard();
drop trigger if exists zz_r381_log on public.studio_test_mode;
create trigger zz_r381_log after insert or update or delete on public.studio_test_mode
  for each row execute function public._r381_tg_test_mode_log();
drop trigger if exists zz_r381_append_only on public.studio_test_mode_log;
create trigger zz_r381_append_only before update or delete on public.studio_test_mode_log
  for each row execute function public._r381_tg_log_append_only();

-- ---- 2) is this studio's two-step exempt? (server-only) ---------------------------------------------------------------
create or replace function public._r381_two_step_exempt(p_org uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  -- r203-0381
  select p_org is not null and coalesce((select t.two_step_exempt from public.studio_test_mode t where t.studio = p_org), false)
$$;

-- ---- 3) THE r35 check, re-issued in place: the 0285 rule + the test-studio exemption -------------------------------
create or replace function public._r285_step_up(p_org uuid)
returns void language plpgsql stable security definer set search_path = '' as $$
-- r35-0285
-- r203-0381: a studio whose HQ test-studio switch is ON skips the two-step parts (the flag check stays)
declare v_at timestamptz;
begin
  if auth.uid() is null then raise exception 'not authorized' using errcode = '42501'; end if;
  if p_org is not null and public._r285_flagged(p_org, auth.uid()) then
    raise exception 'R35_FLAGGED: This account was flagged after a "This wasn''t us". Another admin has to clear the flag before it can change sensitive settings.'
      using errcode = '42501', hint = 'flagged';
  end if;
  if public._r381_two_step_exempt(p_org) then return; end if;
  if not public._r285_has_mfa(auth.uid()) then
    raise exception 'R35_SETUP_2STEP: Set up two-step verification on your account first. Payment details and other sensitive studio settings can only be changed with two-step.'
      using errcode = '42501', hint = 'setup_2step';
  end if;
  v_at := public._r285_mfa_at();
  if coalesce(auth.jwt() ->> 'aal', '') <> 'aal2' or v_at is null or v_at < now() - interval '15 minutes' then
    raise exception 'R35_REAUTH: Enter a fresh two-step code to confirm this change.' using errcode = '42501', hint = 'reauth';
  end if;
end $$;

-- ---- 4) the HQ way to set it (HQ Owner / Admin, two-step, audited) ---------------------------------------------------
create or replace function public.hq_set_test_studio(p_org uuid, p_on boolean, p_note text)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
-- r203-0381
declare v_note text := left(btrim(coalesce(p_note, '')), 300);
begin
  perform public._hq27_require('studios.edit', true);   -- HQ staff + two-step + Owner / Admin role (0277 / 0332)
  if p_org is null or not exists (select 1 from public.organizations o where o.id = p_org) then
    raise exception 'Studio not found.' using errcode = '22023'; end if;
  if p_on is null then raise exception 'Say on or off.' using errcode = '22023'; end if;
  if char_length(v_note) < 10 then raise exception 'Write why (at least 10 characters).' using errcode = '22023'; end if;
  insert into public.studio_test_mode(studio, two_step_exempt, note, set_by, set_at)
    values (p_org, p_on, v_note, auth.uid(), now())
    on conflict (studio) do update set two_step_exempt = excluded.two_step_exempt, note = excluded.note,
      set_by = excluded.set_by, set_at = excluded.set_at;
  insert into public.audit_log(actor, actor_email, action, entity, entity_id, changed, org_id, at)
    select auth.uid(), u.email, 'hq.studio.test_mode', 'organizations', p_org::text,
           jsonb_build_object('two_step_exempt', p_on, 'note', v_note), null, now()
      from auth.users u where u.id = auth.uid();
  return jsonb_build_object('org_id', p_org, 'two_step_exempt', p_on);
end $$;

-- ---- 5) the banner: is MY studio a test studio? -----------------------------------------------------------------------
create or replace function public.my_test_studio()
returns boolean language plpgsql stable security definer set search_path = '' as $$
-- r203-0381
begin
  if auth.uid() is null then return false; end if;
  return public._r381_two_step_exempt(public.current_org_id());
end $$;

-- ---- grants -----------------------------------------------------------------------------------------------------------
do $$ begin
  revoke all on function public._r381_two_step_exempt(uuid) from public;
  revoke all on function public.hq_set_test_studio(uuid, boolean, text) from public;
  revoke all on function public.my_test_studio() from public;
  if exists (select 1 from pg_roles where rolname = 'anon') then
    revoke all on function public._r381_two_step_exempt(uuid) from anon;
    revoke all on function public.hq_set_test_studio(uuid, boolean, text) from anon;
    revoke all on function public.my_test_studio() from anon;
  end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    revoke all on function public._r381_two_step_exempt(uuid) from authenticated;
    grant execute on function public.hq_set_test_studio(uuid, boolean, text) to authenticated;   -- HQ gate inside
    grant execute on function public.my_test_studio() to authenticated;
  end if;
end $$;
