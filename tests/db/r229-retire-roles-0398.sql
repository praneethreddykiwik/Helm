-- r229-retire-roles-0398.sql - R229 (0398): the roles Event coordinator / Designer / Crew are retired for NEW assignment.
-- A signed-in admin can no longer invite with them, change someone to them (team_set_role) or Add user with them;
-- every other role still works. An existing holder keeps the role (re-applying 0398 changes no row), can be moved to
-- another role, and an unchanged-role update of their row is never blocked. An invitation sent BEFORE 0398 with one of
-- these roles is still honoured when the invitee accepts it. The database itself, the service role and Helm HQ are
-- not affected. role_access rows of the retired roles are kept. Helpers closed to the app. Re-applies 0398 twice.
-- Rolled back.
\set ON_ERROR_STOP 0
set client_min_messages = error;
\ir ../../supabase/migrations/0398_r229_retire_roles.sql
\ir ../../supabase/migrations/0398_r229_retire_roles.sql
set client_min_messages = warning;
begin;
-- the guard is ON in this suite (run-all.sh turns it off for the older suites, which invite with 'crew')
select set_config('helm.retired_role_gate', 'on', false);
create temp table _r229(name text, result text); grant all on _r229 to anon, authenticated, service_role;
create or replace function pg_temp.su() returns void language plpgsql as $$
begin execute 'reset role'; perform auth.logout(); execute 'reset role'; perform set_config('helm.retired_role_gate', 'on', false); end $$;
create or replace function pg_temp.login(p_email text) returns void language plpgsql as $$
declare u uuid; begin
  perform pg_temp.su(); select id into u from auth.users where email = p_email;
  perform set_config('request.jwt.claims', jsonb_build_object('sub', u, 'role', 'authenticated', 'email', p_email, 'aal', 'aal2',
    'amr', jsonb_build_array(jsonb_build_object('method', 'totp', 'timestamp', extract(epoch from now())::bigint)))::text, false);
  perform set_config('role', 'authenticated', false);
end $$;
create or replace function pg_temp.res(p_name text, p_ok boolean, p_detail text default '') returns void language plpgsql as $$
begin perform pg_temp.su(); insert into _r229 values (p_name, case when coalesce(p_ok, false) then 'PASS' else 'FAIL: '||coalesce(p_detail,'') end); end $$;
create or replace function pg_temp.try(p_sql text) returns text language plpgsql as $$
declare v_hint text;
begin execute p_sql; return ''; exception when others then get stacked diagnostics v_hint = pg_exception_hint; return sqlstate || ' ' || coalesce(v_hint, '') || ' ' || sqlerrm; end $$;
grant execute on function pg_temp.try(text) to anon, authenticated, service_role;
-- (an API call is a single statement; a rejected one is undone by Postgres - the try() blocks above do the same)

-- fixture: a third member of studio A who already holds each retired role, set up as the database (= before 0398)
do $$ declare orgA uuid := 'a0000000-0000-4000-8000-000000000001'; u uuid; e text; begin
  perform pg_temp.su();
  insert into auth.mfa_factors(user_id, status) select id, 'verified' from auth.users where email = 'a_admin@a.test'
     and not exists (select 1 from auth.mfa_factors f join auth.users x on x.id = f.user_id where x.email = 'a_admin@a.test' and f.status = 'verified');
  foreach e in array array['r229_coord@a.test', 'r229_design@a.test', 'r229_crew@a.test', 'r229_sales@a.test'] loop
    select id into u from auth.users where email = e;
    if u is null then u := auth.seed_user(e); end if;
    insert into public.profiles(id, email, role, org_id, must_change_password, created_at)
      values (u, e, case e when 'r229_coord@a.test' then 'coordinator' when 'r229_design@a.test' then 'designer'
                           when 'r229_crew@a.test' then 'crew' else 'sales' end, orgA, false, now())
      on conflict (id) do update set role = excluded.role, org_id = excluded.org_id;
  end loop;
  -- an invitation sent before 0398 (written as the database) with a retired role
  insert into public.invitations(org_id, email, role, token, invited_by, status, expires_at, created_at)
    select orgA, 'r229_legacy@a.test', 'crew', 'r229-legacy-coord', id, 'pending', now() + interval '6 days', now() - interval '1 day'
      from auth.users where email = 'a_admin@a.test';
end $$;

-- ---- 01-03 new invitations with a retired role are refused, plain words, other roles work ---------------------------
do $$ declare e1 text; e2 text; e3 text; ok text; begin
  perform pg_temp.login('a_admin@a.test');
  e1 := pg_temp.try($q$select public.create_invitation('r229_n1@x.test', 'coordinator')$q$);
  e2 := pg_temp.try($q$select public.create_invitation('r229_n2@x.test', 'designer')$q$);
  e3 := pg_temp.try($q$select public.create_invitation('r229_n3@x.test', 'crew')$q$);
  ok := pg_temp.try($q$select public.create_invitation('r229_n4@x.test', 'planner')$q$);
  perform pg_temp.su();
  perform pg_temp.res('01 invite as Event coordinator / Designer / Crew refused (22023, hint retired_role, plain words)',
    e1 like '22023 retired_role %Event coordinator%retired%' and e2 like '22023 retired_role %Designer%' and e3 like '22023 retired_role %Crew%'
    and position('Event manager or Planner' in e1) > 0, e1 || ' | ' || e2 || ' | ' || e3);
  perform pg_temp.res('02 nothing was written for the refused invitations',
    not exists (select 1 from public.invitations where email in ('r229_n1@x.test', 'r229_n2@x.test', 'r229_n3@x.test')));
  perform pg_temp.res('03 invite as Planner still works', ok = '' and exists (select 1 from public.invitations where email = 'r229_n4@x.test' and role = 'planner'), ok);
end $$;

-- ---- 04-06 role changes: TO a retired role refused, FROM one allowed, others work ------------------------------------
do $$ declare s uuid; c uuid; e1 text; e2 text; ok text; okm text; begin
  perform pg_temp.su();
  select id into s from auth.users where email = 'r229_sales@a.test';
  select id into c from auth.users where email = 'r229_crew@a.test';
  perform pg_temp.login('a_admin@a.test');
  e1 := pg_temp.try(format('select public.team_set_role(%L, %L)', s, 'coordinator'));
  e2 := pg_temp.try(format('select public.team_set_role(%L, %L)', s, 'crew'));
  ok := pg_temp.try(format('select public.team_set_role(%L, %L)', s, 'operations'));
  okm := pg_temp.try(format('select public.team_set_role(%L, %L)', c, 'manager'));
  perform pg_temp.su();
  perform pg_temp.res('04 changing someone TO Event coordinator / Crew refused (22023 retired_role), their role unchanged',
    e1 like '22023 retired_role %' and e2 like '22023 retired_role %', e1 || ' | ' || e2);
  perform pg_temp.res('05 changing to another role (Operations) still works', ok = '' and (select role from public.profiles where id = s) = 'operations', ok);
  perform pg_temp.res('06 an existing Crew holder can be moved to Event manager (change FROM a retired role)',
    okm = '' and (select role from public.profiles where id = c) = 'manager', okm);
end $$;

-- ---- 07-08 Add user with a retired role refused; with another role works -----------------------------------------------
do $$ declare e1 text; ok text; begin
  perform pg_temp.login('a_admin@a.test');
  e1 := pg_temp.try($q$select public.admin_create_user_temp('r229_add1@a.test', 'designer')$q$);
  ok := pg_temp.try($q$select public.admin_create_user_temp('r229_add2@a.test', 'planner')$q$);
  perform pg_temp.su();
  perform pg_temp.res('07 Add user as Designer refused (22023 retired_role), no login left behind',
    e1 like '22023 retired_role %' and not exists (select 1 from auth.users where email = 'r229_add1@a.test'), e1);
  perform pg_temp.res('08 Add user as Planner still works',
    ok = '' and (select p.role from public.profiles p join auth.users u on u.id = p.id where u.email = 'r229_add2@a.test') = 'planner', ok);
end $$;

-- ---- 09-10 existing holders are never blocked ----------------------------------------------------------------------------
do $$ declare c uuid; d uuid; e1 text; begin
  perform pg_temp.su();
  select id into c from auth.users where email = 'r229_coord@a.test';
  select id into d from auth.users where email = 'r229_design@a.test';
  -- a signed-in save of their row that names the SAME role (e.g. a profile form posting every column)
  perform set_config('request.jwt.claims', jsonb_build_object('sub', c, 'role', 'authenticated', 'email', 'r229_coord@a.test')::text, false);
  e1 := pg_temp.try(format('update public.profiles set role = %L, email = email where id = %L', 'coordinator', c));
  perform pg_temp.su();
  perform pg_temp.res('09 an unchanged-role save of an Event coordinator''s own row is not blocked', e1 = '', e1);
  perform pg_temp.res('10 existing holders keep their role (0398 applied twice changed no row)',
    (select role from public.profiles where id = c) = 'coordinator' and (select role from public.profiles where id = d) = 'designer');
end $$;

-- ---- 11 an invitation sent before 0398 is honoured ---------------------------------------------------------------------
do $$ declare u uuid; r text; begin
  perform pg_temp.su();
  u := auth.seed_user('r229_legacy@a.test');
  insert into public.profiles(id, email, role, org_id, must_change_password, created_at)
    values (u, 'r229_legacy@a.test', 'client', null, false, now()) on conflict (id) do nothing;
  perform pg_temp.login('r229_legacy@a.test');
  r := pg_temp.try($q$select public.accept_invitation('r229-legacy-coord')$q$);
  perform pg_temp.su();
  perform pg_temp.res('11 a Crew invitation sent before 0398 still joins the invitee with that role',
    r = '' and (select role || '/' || coalesce(org_id::text, '') from public.profiles where id = u) = 'crew/a0000000-0000-4000-8000-000000000001', r);
end $$;

-- ---- 12 the same person cannot then be changed by someone else into another retired role ----------------------------------
do $$ declare s uuid; e1 text; begin
  perform pg_temp.su();
  select id into s from auth.users where email = 'a_staff@a.test';
  -- a signed-in caller (not the person, no invitation) writing a retired role straight onto a row
  perform set_config('request.jwt.claims', jsonb_build_object('sub', (select id from auth.users where email = 'a_admin@a.test'), 'role', 'authenticated')::text, false);
  e1 := pg_temp.try(format('update public.profiles set role = %L where id = %L', 'designer', s));
  perform pg_temp.su();
  perform pg_temp.res('12 any signed-in write that CHANGES a row to a retired role is refused (not only the RPCs)',
    e1 like '22023 retired_role %' and (select role from public.profiles where id = s) = 'sales', e1);
end $$;

-- ---- 13-14 the database itself / service role / Helm HQ are not affected -------------------------------------------------
do $$ declare s uuid; e1 text; e2 text; begin
  perform pg_temp.su();
  select id into s from auth.users where email = 'a_staff@a.test';
  begin
    e1 := pg_temp.try(format('update public.profiles set role = %L where id = %L', 'crew', s));
    raise exception 'undo' using errcode = 'P0R29';
  exception when sqlstate 'P0R29' then null; end;
  perform set_config('request.jwt.claims', jsonb_build_object('sub', s, 'role', 'service_role')::text, false);
  begin
    e2 := pg_temp.try(format('insert into public.invitations(org_id, email, role, token, status, expires_at) values (%L, %L, %L, %L, %L, now() + interval ''1 day'')',
      'a0000000-0000-4000-8000-000000000001', 'r229_svc@x.test', 'crew', 'r229-svc', 'pending'));
    raise exception 'undo' using errcode = 'P0R29';
  exception when sqlstate 'P0R29' then null; end;
  perform pg_temp.su();
  perform pg_temp.res('13 the database itself (migrations, jobs) can still write a retired role', e1 = '', e1);
  perform pg_temp.res('14 the service role (edge functions) is not affected', e2 = '', e2);
end $$;

-- ---- 15 the guard switch is honoured (test cluster only) --------------------------------------------------------------
do $$ declare e1 text; begin
  perform pg_temp.login('a_admin@a.test');
  perform set_config('helm.retired_role_gate', 'off', false);
  e1 := pg_temp.try($q$select public.create_invitation('r229_off@x.test', 'crew')$q$);
  perform pg_temp.su();
  perform pg_temp.res('15 helm.retired_role_gate = off turns the guard off (older suites)', e1 = '', e1);
end $$;

-- ---- 16-20 owner scope change: coordinator / designer removed for good (crew only disabled) ----------------------------
do $$ declare orgA uuid := 'a0000000-0000-4000-8000-000000000001'; begin
  perform pg_temp.su();
  -- a role_access row from before 0398 + an open Designer invitation from before 0398 (written with the guard off)
  perform set_config('helm.retired_role_gate', 'off', false);
  insert into public.role_access(role, area, can_view, can_edit, org_id, updated_at)
    values ('coordinator', 'quotes', true, false, orgA, now()) on conflict (role, area, org_id) do nothing;
  insert into public.invitations(org_id, email, role, token, status, expires_at, created_at)
    values (orgA, 'r229_oldd@x.test', 'designer', 'r229-old-designer', 'pending', now() + interval '5 days', now());
  perform set_config('helm.retired_role_gate', 'on', false);
  perform pg_temp.res('16 setup: an old coordinator role_access row and an open Designer invitation exist',
    exists (select 1 from public.role_access where role = 'coordinator' and org_id = orgA)
    and (select status from public.invitations where token = 'r229-old-designer') = 'pending');
end $$;
-- the migration again (as the owner runs APPLY-0398 after those rows exist)
set client_min_messages = error;
\ir ../../supabase/migrations/0398_r229_retire_roles.sql
set client_min_messages = warning;
do $$ declare orgA uuid := 'a0000000-0000-4000-8000-000000000001'; n int; e1 text; begin
  perform pg_temp.su();
  perform pg_temp.res('17 an open Designer invitation is cancelled (status revoked, row kept) and copied to _r398_backup first',
    (select status from public.invitations where token = 'r229-old-designer') = 'revoked'
    and exists (select 1 from public._r398_backup b where b.kind = 'invitation_revoked' and b.row_data ->> 'token' = 'r229-old-designer'
                  and b.row_data ->> 'status' = 'pending'));
  perform pg_temp.res('18 existing role_access rows of the removed roles are not deleted by 0398',
    exists (select 1 from public.role_access where role = 'coordinator' and area = 'quotes' and org_id = orgA));
  insert into public.role_access(role, area, can_view, can_edit, org_id, updated_at)
    values ('designer', 'media', true, true, orgA, now()), ('planner', 'media', true, true, orgA, now())
    on conflict (role, area, org_id) do update set can_view = excluded.can_view;
  perform pg_temp.res('19 no NEW role_access row for Designer / Event coordinator (skipped), other roles still saved',
    not exists (select 1 from public.role_access where role = 'designer' and area = 'media' and org_id = orgA)
    and exists (select 1 from public.role_access where role = 'planner' and area = 'media' and org_id = orgA));
  perform pg_temp.res('20 role lists without coordinator / designer (notification roles, sign-in notice roles + default), crew kept',
    not (public._notify_roles() && array['coordinator', 'designer']) and 'crew' = any (public._notify_roles())
    and not (public._r383_roles_all() && array['coordinator', 'designer'])
    and position('''coordinator''' in pg_get_functiondef('public._r383_cfg(uuid)'::regprocedure)) = 0);
  perform pg_temp.res('21 _r398_backup: RLS on, no app privilege',
    (select relrowsecurity from pg_class where oid = 'public._r398_backup'::regclass)
    and not has_table_privilege('authenticated', 'public._r398_backup', 'select') and not has_table_privilege('anon', 'public._r398_backup', 'select'));
end $$;
set client_min_messages = warning;

-- ---- 22 grants / definer / search_path / markers / triggers ---------------------------------------------------------------
select pg_temp.res('22 helpers closed to the app, r229-0398 markers, empty search_path, both triggers BEFORE + enabled',
  (select bool_and(coalesce(p.proconfig, '{}') @> array['search_path=""'] and position('r229-0398' in p.prosrc) > 0
                   and not has_function_privilege('authenticated', p.oid, 'execute') and not has_function_privilege('anon', p.oid, 'execute'))
     from pg_proc p where p.oid in ('public._r398_retired_roles()'::regprocedure, 'public._r398_role_label(text)'::regprocedure,
       'public._r398_gate_on()'::regprocedure, 'public._r398_tg_profile_role()'::regprocedure, 'public._r398_tg_invite_role()'::regprocedure,
       'public._r398_tg_role_access()'::regprocedure, 'public._r398_removed_roles()'::regprocedure))
  and (select count(*) from pg_trigger t where t.tgname = 'a398_retired_role_guard' and t.tgenabled = 'O' and (t.tgtype & 2) = 2
         and t.tgrelid in ('public.profiles'::regclass, 'public.invitations'::regclass, 'public.role_access'::regclass)) = 3);

select pg_temp.su();
do $$ declare n int; f int; r record; begin
  select count(*), count(*) filter (where result <> 'PASS') into n, f from _r229;
  for r in select * from _r229 where result <> 'PASS' loop raise warning '% -> %', r.name, r.result; end loop;
  if f = 0 then raise warning 'R229-RETIRE-ROLES-0398: ALL PASS (%/%)', n, n;
  else raise warning 'R229-RETIRE-ROLES-0398: % FAILED of %', f, n; end if;
end $$;
rollback;
