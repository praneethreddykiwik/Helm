-- APPLY-0415 (R245 fix plan Phase 6, ACC-18 + ACC-24: Helm HQ "Make admin" and "Deactivate login" on a studio's People
-- tab). THIS CHANGES WHO CAN SIGN IN: run on STAGING first and leave it there for a day before production.
-- Safe to run twice. Needs 0283, 0285, 0277, 0328, 0298 - already on both.
-- What it does:
--   * hq_studio_member_promote: the HQ Owner makes a named, active member of a studio an admin (a studio whose only admin
--     left). hq_studio_member_deactivate: the HQ Owner switches a studio login off with the studio's own Deactivate path
--     (never deletes; never the studio owner, never the last admin).
--   * Both need two-step (aal2) + a fresh code, a written reason (20+ characters), at most 5 a day per HQ person, and write
--     a row in the HQ activity log and in the studio's own activity log.
-- 3 new functions. Nothing changed or deleted.
-- Paste the whole file into the Supabase SQL editor and press Run. The last result lists checks - every ok must be true.
begin;
set local lock_timeout = '5s';
set local statement_timeout = '5min';

-- 0415_r245_hq_member_actions.sql - CANONICAL forward-only. R245 (fix plan Phase 6 "Account and team safety", owner
-- approved 20 Nov 2026; ACC-18 + ACC-24). REQUIRES 0283 (team safety: _r283_do_deactivate, owner), 0285 (admin alert),
-- 0277 + 0328 (_hq27_require / _hq_wgate, the HQ gate), 0298 (_r57_mask_email).
--
-- In plain words - two new Helm HQ actions on a studio's People tab, for the HQ OWNER role only, each needing:
-- an HQ person signed in WITH two-step (aal2) + a fresh code (the HQ "sensitive" rule), a written reason (20 to 1000
-- characters: why, and how they checked who is asking), at most 5 per HQ person per 24 hours, and an audit row in BOTH logs
-- (HQ activity + the studio's own activity).
--   1  ACC-18 "Make admin": a studio whose only admin left can be recovered. HQ makes a NAMED, active member of that
--      studio an admin (hq_studio_member_promote). Never a client login, never a deactivated person. The studio's admins
--      get the usual "admin added" alert (0285). The studio owner record is not changed (Recover studio owner does that,
--      once the person is an admin).
--   2  ACC-24 "Deactivate login": HQ switches a studio login off with the SAME path the studio's own Deactivate uses
--      (0283 _r283_do_deactivate: sign-in off, signed out everywhere, work links stopped, seat freed, everything they made
--      kept, Reactivate brings them back). It NEVER deletes. Never the studio owner (recover the owner first) and never the
--      last active admin of the studio. The studio's admins see it in the bell.
--
-- ZERO DATA LOSS: additive + idempotent. 2 new functions; no table, column or existing function changed; nothing deleted.
-- Safe to run twice. ASCII only.

do $$
begin
  if to_regprocedure('public._r283_do_deactivate(uuid,uuid,text,uuid)') is null or to_regprocedure('public._r283_owner(uuid)') is null
     or to_regprocedure('public._r283_active_admin(uuid,uuid)') is null or to_regprocedure('public._r283_is_off(uuid,uuid)') is null
     or to_regprocedure('public._r283_audit(uuid,text,uuid,jsonb,uuid)') is null or to_regprocedure('public._r283_name(uuid)') is null then
    raise exception 'STOP 0415: 0283 (team safety) is not applied'; end if;
  if to_regprocedure('public._hq27_require(text,boolean)') is null or to_regprocedure('public._hq27_write_perm(text)') is null
     or to_regprocedure('public._hq_wgate(text,text,text,jsonb)') is null or to_regprocedure('public.is_platform_admin()') is null then
    raise exception 'STOP 0415: the HQ gate (0277 / 0328) is not applied'; end if;
  if to_regprocedure('public._r57_mask_email(text)') is null then raise exception 'STOP 0415: 0298 (_r57_mask_email) missing'; end if;
end $$;

-- the shared checks: HQ two-step person with the role for p_action, a reason, the studio + member, the daily limit
create or replace function public._r415_hq_member_check(p_action text, p_org uuid, p_user uuid, p_reason text)
returns public.profiles language plpgsql volatile security definer set search_path = '' as $$
-- r245-0415: the HQ role + two-step are checked BEFORE any look-up (like hq_studio_owner_recover, 0330)
declare v_me uuid := auth.uid(); v_reason text := btrim(coalesce(p_reason, '')); t public.profiles;
begin
  if v_me is null or not coalesce(public.is_platform_admin(), false) or coalesce(auth.jwt() ->> 'aal', '') <> 'aal2' then
    raise exception 'not authorized' using errcode = '42501', hint = 'Only a Helm HQ person signed in with two-step can do this.';
  end if;
  perform public._hq27_require(public._hq27_write_perm(p_action), true);
  if char_length(v_reason) < 20 or char_length(v_reason) > 1000 then
    raise exception 'Write 20 to 1000 characters: why, and how you checked who is asking (for example a call back on the registered number).'
      using errcode = '22023', hint = 'reason';
  end if;
  if p_org is null or not exists (select 1 from public.organizations o where o.id = p_org) then
    raise exception 'no such studio' using errcode = 'P0002'; end if;
  select * into t from public.profiles p where p.id = p_user and p.org_id = p_org;
  if t.id is null then raise exception 'This person is not a member of this studio.' using errcode = 'P0002'; end if;
  if coalesce(t.role, '') = 'client' then
    raise exception 'This is a client login, not a team member.' using errcode = '22023', hint = 'client';
  end if;
  if (select count(*) from public.audit_log a where a.actor = v_me and a.action in ('hq.studio.member_promote', 'hq.studio.member_deactivate')
        and a.at > now() - interval '24 hours') >= 5 then
    raise exception 'Too many studio login changes in the last 24 hours. Try again tomorrow.' using errcode = 'P0001', hint = 'rate_limited';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('helm:hq_member:' || p_org::text, 0));
  return t;
end $$;

-- ACC-18: make a named, active member of the studio an admin
create or replace function public.hq_studio_member_promote(p_org uuid, p_user uuid, p_reason text)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
-- r245-0415 ACC-18
declare v_me uuid := auth.uid(); t public.profiles; v_reason text := btrim(coalesce(p_reason, '')); v_by text;
begin
  t := public._r415_hq_member_check('hq.studio.member_promote', p_org, p_user, p_reason);
  if public._r283_is_off(p_user, p_org) then
    raise exception 'This person is deactivated. Ask the studio to reactivate them first, or pick an active member.' using errcode = '22023', hint = 'deactivated';
  end if;
  if t.role = 'admin' then return jsonb_build_object('ok', true, 'already', true); end if;
  perform public._hq_wgate('hq.studio.member_promote', 'profiles', p_user::text,
    jsonb_build_object('org_id', p_org, 'user_id', p_user, 'email', public._r57_mask_email(t.email), 'from_role', t.role, 'reason', v_reason));
  update public.profiles set role = 'admin' where id = p_user and org_id = p_org;
  select lower(u.email) into v_by from auth.users u where u.id = v_me;
  perform public._r283_audit(p_org, 'team.hq_promote', p_user,
    jsonb_build_object('from_role', t.role, 'to_role', 'admin', 'by', 'Helm support', 'reason', left(v_reason, 500)), v_me);
  return jsonb_build_object('ok', true, 'user_id', p_user, 'from_role', t.role, 'role', 'admin');
end $$;

-- ACC-24: switch a studio login off (the 0283 deactivate path) - never a delete
create or replace function public.hq_studio_member_deactivate(p_org uuid, p_user uuid, p_reason text)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
-- r245-0415 ACC-24: deactivate only (never deletes)
declare v_me uuid := auth.uid(); t public.profiles; v_reason text := btrim(coalesce(p_reason, '')); v_end jsonb; v_owner uuid;
begin
  t := public._r415_hq_member_check('hq.studio.member_deactivate', p_org, p_user, p_reason);
  if public._r283_is_off(p_user, p_org) then return jsonb_build_object('ok', true, 'already', true); end if;
  v_owner := public._r283_owner(p_org);
  if v_owner is not null and v_owner = p_user then
    raise exception 'The studio owner can''t be deactivated. Recover the studio owner (another admin) first.' using errcode = '42501', hint = 'owner_protected';
  end if;
  if t.role = 'admin' and not exists (select 1 from public.profiles p where p.org_id = p_org and p.id <> p_user and p.role = 'admin'
                                         and not public._r283_is_off(p.id, p_org)) then
    raise exception 'This is the studio''s last active admin. Make another member an admin first.' using errcode = '42501', hint = 'last_admin';
  end if;
  perform public._hq_wgate('hq.studio.member_deactivate', 'profiles', p_user::text,
    jsonb_build_object('org_id', p_org, 'user_id', p_user, 'email', public._r57_mask_email(t.email), 'role', t.role, 'reason', v_reason));
  v_end := public._r283_do_deactivate(p_org, p_user, left('Helm support: ' || v_reason, 500), v_me);
  -- the studio's admins see it in the bell (no e-mail: the 0283 mailer only knows its own events)
  insert into public.notifications(quote_id, channel, kind, status, detail, org_id)
    values (null, 'in_app', 'team_safety', 'simulated',
            jsonb_build_object('label', left('Helm support deactivated ' || public._r283_name(p_user) || '. Their records are kept; an admin can reactivate them.', 200),
                               'event', 'hq_member_deactivated', 'source', '0415'), p_org);
  return jsonb_build_object('ok', true, 'user_id', p_user, 'deactivated', true, 'sessions', v_end -> 'sessions');
end $$;

revoke all on function public._r415_hq_member_check(text, uuid, uuid, text) from public;
revoke all on function public.hq_studio_member_promote(uuid, uuid, text) from public;
revoke all on function public.hq_studio_member_deactivate(uuid, uuid, text) from public;
do $$ declare r text; begin
  foreach r in array array['anon', 'authenticated'] loop
    if exists (select 1 from pg_roles where rolname = r) then
      execute format('revoke all on function public._r415_hq_member_check(text, uuid, uuid, text) from %I', r);
      execute format('revoke all on function public.hq_studio_member_promote(uuid, uuid, text) from %I', r);
      execute format('revoke all on function public.hq_studio_member_deactivate(uuid, uuid, text) from %I', r);
    end if;
  end loop;
  -- signed-in only: the HQ role, two-step and fresh code are checked inside
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    execute 'grant execute on function public.hq_studio_member_promote(uuid, uuid, text) to authenticated';
    execute 'grant execute on function public.hq_studio_member_deactivate(uuid, uuid, text) to authenticated';
  end if;
end $$;

do $$ begin
  if to_regclass('public.helm_schema_markers') is not null then
    insert into public.helm_schema_markers(num, name) values (415, '0415_r245_hq_member_actions') on conflict (num) do nothing;
  end if;
end $$;

-- ---- checks (every ok must be true) --------------------------------------------------------------------------------------
select item, ok, note from (
  select '01 hq_studio_member_promote + hq_studio_member_deactivate: signed-in only (HQ role + two-step checked inside)' as item,
     has_function_privilege('authenticated', 'public.hq_studio_member_promote(uuid,uuid,text)', 'execute')
     and has_function_privilege('authenticated', 'public.hq_studio_member_deactivate(uuid,uuid,text)', 'execute')
     and not has_function_privilege('anon', 'public.hq_studio_member_promote(uuid,uuid,text)', 'execute')
     and not has_function_privilege('anon', 'public.hq_studio_member_deactivate(uuid,uuid,text)', 'execute')
     and not has_function_privilege('authenticated', 'public._r415_hq_member_check(text,uuid,uuid,text)', 'execute') as ok, '' as note
  union all
  select '02 definer + empty search_path on all three',
     (select bool_and(p.prosecdef and p.proconfig @> array['search_path=""']) from pg_proc p
       where p.oid in ('public.hq_studio_member_promote(uuid,uuid,text)'::regprocedure, 'public.hq_studio_member_deactivate(uuid,uuid,text)'::regprocedure,
                       'public._r415_hq_member_check(text,uuid,uuid,text)'::regprocedure)), ''
  union all
  select '03 deactivate never deletes (uses the 0283 deactivate path)',
     (select position('delete ' in lower(p.prosrc)) = 0 and position('_r283_do_deactivate' in p.prosrc) > 0
        from pg_proc p where p.oid = 'public.hq_studio_member_deactivate(uuid,uuid,text)'::regprocedure), ''
  union all
  select '04 two-step (aal2) + reason checked before anything else',
     (select position('aal2' in p.prosrc) > 0 and position('_hq27_require' in p.prosrc) > 0 and position('char_length(v_reason) < 20' in p.prosrc) > 0
        from pg_proc p where p.oid = 'public._r415_hq_member_check(text,uuid,uuid,text)'::regprocedure), ''
) v order by item;
commit;
