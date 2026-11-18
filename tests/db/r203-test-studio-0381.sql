-- r203-test-studio-0381.sql - R203 (0381): the HQ-only TEST STUDIO switch for the r35 two-step rule. Switch OFF (no row
-- / false) -> an admin without two-step is refused (R35_SETUP_2STEP) when inviting an Admin; switch ON for studio A ->
-- skipped for studio A ONLY (studio B still refused); the "This wasn't us" flag still refuses in a test studio; studio
-- admins / staff / anon can neither read nor change the switch (table, guard trigger, HQ call); the HQ Owner (two-step)
-- can; every change logged (append-only); my_test_studio() for the banner; grants / definer / search_path / markers.
-- Re-applies 0381 twice. Rolled back. Local disposable PG only.
\set ON_ERROR_STOP 0
set client_min_messages = error;
\ir ../../supabase/migrations/0381_r203_test_studio_two_step.sql
\ir ../../supabase/migrations/0381_r203_test_studio_two_step.sql
set client_min_messages = warning;
begin;
create temp table _r203(name text, result text); grant all on _r203 to anon, authenticated, service_role;
create temp table _kv(k text primary key, v text); grant all on _kv to anon, authenticated, service_role;
create or replace function pg_temp.su() returns void language plpgsql as $$
begin execute 'reset role'; perform auth.logout(); execute 'reset role'; end $$;
create or replace function pg_temp.uid(p_email text) returns uuid language sql as $$ select v::uuid from _kv where k = 'uid:' || p_email $$;
grant execute on function pg_temp.uid(text) to anon, authenticated, service_role;
create or replace function pg_temp.as_user(p_email text, p_aal text, p_mfa_min integer default null) returns void language plpgsql as $$
declare c jsonb; begin perform pg_temp.su(); perform auth.login_as(pg_temp.uid(p_email));
  c := auth.jwt() || jsonb_build_object('aal', p_aal);
  if p_mfa_min is not null then
    c := c || jsonb_build_object('amr', jsonb_build_array(jsonb_build_object('method', 'password', 'timestamp', extract(epoch from now()) - 7200),
                                                          jsonb_build_object('method', 'totp', 'timestamp', extract(epoch from now()) - p_mfa_min * 60)));
  end if;
  perform set_config('request.jwt.claims', c::text, false);
  execute 'set role authenticated'; end $$;
create or replace function pg_temp.anon() returns void language plpgsql as $$
begin perform pg_temp.su(); perform set_config('request.jwt.claims', '{"role":"anon"}', false); perform set_config('role', 'anon', false); end $$;
create or replace function pg_temp.res(p_name text, p_ok boolean, p_detail text default '') returns void language plpgsql as $$
begin insert into _r203 values (p_name, case when coalesce(p_ok, false) then 'PASS' else 'FAIL: '||coalesce(p_detail,'') end); end $$;
grant execute on function pg_temp.res(text, boolean, text) to anon, authenticated, service_role;
create or replace function pg_temp.try(p_sql text) returns text language plpgsql as $$
begin execute p_sql; return ''; exception when others then return sqlstate || ' ' || sqlerrm; end $$;
grant execute on function pg_temp.try(text) to anon, authenticated, service_role;
create or replace function pg_temp.b(p_sql text) returns text language plpgsql as $$
declare v boolean; begin execute p_sql into v; return coalesce(v::text, 'null'); exception when others then return sqlstate || ' ' || sqlerrm; end $$;
grant execute on function pg_temp.b(text) to anon, authenticated, service_role;

do $$ begin
  perform pg_temp.su();
  insert into _kv select 'uid:' || u.email, u.id::text from auth.users u
   where u.email in ('a_admin@a.test', 'a_staff@a.test', 'b_admin@b.test') on conflict (k) do nothing;
  if not exists (select 1 from auth.users where email = 'admin@helm.events') then perform auth.seed_user('admin@helm.events'); end if;
  update auth.users set email_confirmed_at = now() where email = 'admin@helm.events';
  insert into public.platform_admins(email, added_by) values ('admin@helm.events', 'test') on conflict do nothing;
  update public.platform_admins set role = 'owner', status = 'active' where email = 'admin@helm.events';
  insert into _kv select 'uid:' || u.email, u.id::text from auth.users u where u.email = 'admin@helm.events' on conflict (k) do nothing;
  delete from auth.mfa_factors where user_id in (pg_temp.uid('a_admin@a.test'), pg_temp.uid('b_admin@b.test'));
  delete from public.studio_test_mode;   -- rolled back
exception when others then perform pg_temp.su(); insert into _r203 values ('00 setup', 'FAIL: '||sqlstate||' '||sqlerrm); end $$;

-- ---- 1) switch OFF: the r35 gate is enforced ------------------------------------------------------------------------
do $$ declare e text; begin
  perform pg_temp.as_user('a_admin@a.test', 'aal1');
  e := pg_temp.try($q$select public.create_invitation('r203new1@studioa.in', 'admin')$q$);
  perform pg_temp.res('01 switch off (no row): inviting an Admin without two-step is refused R35_SETUP_2STEP', e like '42501%R35_SETUP_2STEP%', e);
  perform pg_temp.su();
  insert into public.studio_test_mode(studio, two_step_exempt, note) values ('a0000000-0000-4000-8000-000000000001', false, 'present but off');
  perform pg_temp.as_user('a_admin@a.test', 'aal1');
  e := pg_temp.try($q$select public.create_invitation('r203new1@studioa.in', 'admin')$q$);
  perform pg_temp.res('02 switch row present but OFF: still refused', e like '42501%R35_SETUP_2STEP%', e);
  perform pg_temp.res('03 my_test_studio() is false while off', pg_temp.b('select public.my_test_studio()') = 'false', pg_temp.b('select public.my_test_studio()'));
exception when others then perform pg_temp.su(); insert into _r203 values ('1x', 'FAIL: '||sqlstate||' '||sqlerrm); end $$;

-- ---- 2) studio admins / staff / anon cannot set or read the switch ----------------------------------------------------
do $$ declare e text; begin
  perform pg_temp.as_user('a_admin@a.test', 'aal1');
  e := pg_temp.try($q$update public.studio_test_mode set two_step_exempt = true where studio = 'a0000000-0000-4000-8000-000000000001'$q$);
  perform pg_temp.res('04 a studio admin cannot update the switch (42501)', e like '42501%', e);
  e := pg_temp.try($q$insert into public.studio_test_mode(studio, two_step_exempt) values ('b0000000-0000-4000-8000-000000000001', true)$q$);
  perform pg_temp.res('05 a studio admin cannot insert a switch row (42501)', e like '42501%', e);
  e := pg_temp.try($q$select count(*) from public.studio_test_mode$q$);
  perform pg_temp.res('06 a studio admin cannot read the switch table', e like '42501%', e);
  e := pg_temp.try($q$select public.hq_set_test_studio('a0000000-0000-4000-8000-000000000001', true, 'I want no two-step')$q$);
  perform pg_temp.res('07 a studio admin cannot use the HQ call (42501)', e like '42501%', e);
  e := pg_temp.try($q$select public._r381_two_step_exempt('a0000000-0000-4000-8000-000000000001')$q$);
  perform pg_temp.res('08 the server-only helper is not callable from the app', e like '42501%', e);
  perform pg_temp.as_user('a_admin@a.test', 'aal2', 1);
  e := pg_temp.try($q$select public.hq_set_test_studio('a0000000-0000-4000-8000-000000000001', true, 'I want no two-step')$q$);
  perform pg_temp.res('09 even with two-step, a studio admin is not HQ', e like '42501%', e);
  perform pg_temp.anon();
  e := pg_temp.try($q$select public.my_test_studio()$q$);
  perform pg_temp.res('10 anon cannot call my_test_studio', e like '42501%', e);
  perform pg_temp.su();
  perform pg_temp.res('11 nothing was switched on by those attempts',
    not public._r381_two_step_exempt('a0000000-0000-4000-8000-000000000001') and not public._r381_two_step_exempt('b0000000-0000-4000-8000-000000000001'));
  -- the guard trigger also stops a signed-in non-HQ caller that got past the missing grants (defence in depth): the
  -- database owner role with a_admin's sign-in claims (RLS / grants bypassed, the trigger still runs)
  perform pg_temp.su();
  perform set_config('request.jwt.claims', jsonb_build_object('sub', pg_temp.uid('a_admin@a.test'), 'role', 'authenticated', 'aal', 'aal2')::text, false);
  e := pg_temp.try($q$update public.studio_test_mode set two_step_exempt = true where studio = 'a0000000-0000-4000-8000-000000000001'$q$);
  perform pg_temp.res('12 guard trigger: a signed-in non-HQ caller is refused even past the grants', e like '42501%only Helm HQ%', e);
  perform pg_temp.su();
exception when others then perform pg_temp.su(); insert into _r203 values ('2x', 'FAIL: '||sqlstate||' '||sqlerrm); end $$;

-- ---- 3) switch ON for studio A (SQL editor one-liner path): skipped for A only -----------------------------------------
do $$ declare e text; n int; begin
  perform pg_temp.su();
  update public.studio_test_mode set two_step_exempt = true, note = 'Shared tester login (R203)', set_at = now()
   where studio = 'a0000000-0000-4000-8000-000000000001';
  select count(*) into n from public.studio_test_mode_log where studio = 'a0000000-0000-4000-8000-000000000001' and two_step_exempt and via = 'sql_editor' and was = false;
  perform pg_temp.res('13 switching on from the SQL editor is logged (via sql_editor, was off)', n = 1, 'n=' || n);
  perform pg_temp.as_user('a_admin@a.test', 'aal1');
  e := pg_temp.try($q$select public.create_invitation('r203new2@studioa.in', 'admin')$q$);
  perform pg_temp.res('14 switch ON: studio A admin without two-step can invite an Admin', e = '', e);
  e := pg_temp.try(format('select public.admin_set_role(%L, ''admin'')', pg_temp.uid('a_staff@a.test')));
  perform pg_temp.res('15 switch ON: studio A admin can make someone an Admin without two-step', e = '', e);
  perform pg_temp.res('16 my_test_studio() is true for studio A', pg_temp.b('select public.my_test_studio()') = 'true', pg_temp.b('select public.my_test_studio()'));
  perform pg_temp.as_user('b_admin@b.test', 'aal1');
  e := pg_temp.try($q$select public.create_invitation('r203new3@studiob.in', 'admin')$q$);
  perform pg_temp.res('17 studio B (no switch) is still refused R35_SETUP_2STEP', e like '42501%R35_SETUP_2STEP%', e);
  perform pg_temp.res('18 my_test_studio() is false for studio B', pg_temp.b('select public.my_test_studio()') = 'false', pg_temp.b('select public.my_test_studio()'));
  -- a flagged account is still refused in the test studio
  perform pg_temp.su();
  insert into public.studio_account_flags(org_id, user_id, reason) values ('a0000000-0000-4000-8000-000000000001', pg_temp.uid('a_admin@a.test'), 'test: flagged in a test studio');
  perform pg_temp.as_user('a_admin@a.test', 'aal1');
  e := pg_temp.try($q$select public.create_invitation('r203new4@studioa.in', 'admin')$q$);
  perform pg_temp.res('19 a flagged account is still refused in a test studio (R35_FLAGGED)', e like '42501%R35_FLAGGED%', e);
  perform pg_temp.su(); update public.studio_account_flags set cleared_at = now() where user_id = pg_temp.uid('a_admin@a.test') and cleared_at is null;
exception when others then perform pg_temp.su(); insert into _r203 values ('3x', 'FAIL: '||sqlstate||' '||sqlerrm); end $$;

-- ---- 4) the HQ Owner sets it off again through the HQ call (audited) ------------------------------------------------------
do $$ declare e text; begin
  perform pg_temp.as_user('admin@helm.events', 'aal2', 1);
  e := pg_temp.try($q$select public.hq_set_test_studio('a0000000-0000-4000-8000-000000000001', false, 'short')$q$);
  perform pg_temp.res('20 the HQ call needs a note of 10+ characters', e like '22023%10 characters%', e);
  e := pg_temp.try($q$select public.hq_set_test_studio('a0000000-0000-4000-8000-000000000001', false, 'R203 test over, two-step back on')$q$);
  perform pg_temp.su();
  perform pg_temp.res('21 the HQ Owner switches it off: logged (via hq) + HQ audit row',
    e = '' and not public._r381_two_step_exempt('a0000000-0000-4000-8000-000000000001')
    and exists (select 1 from public.studio_test_mode_log l where l.studio = 'a0000000-0000-4000-8000-000000000001' and l.via = 'hq' and not l.two_step_exempt and l.was)
    and exists (select 1 from public.audit_log a where a.action = 'hq.studio.test_mode' and a.entity_id = 'a0000000-0000-4000-8000-000000000001' and a.org_id is null), e);
  perform pg_temp.as_user('a_admin@a.test', 'aal1');
  e := pg_temp.try($q$select public.create_invitation('r203new5@studioa.in', 'admin')$q$);
  perform pg_temp.res('22 switched off again: studio A is refused again', e like '42501%R35_SETUP_2STEP%', e);
  perform pg_temp.su();
  e := pg_temp.try($q$update public.studio_test_mode_log set note = 'x'$q$);
  perform pg_temp.res('23 the log is append-only (update refused, even for the database owner)', e like '42501%append-only%', e);
  e := pg_temp.try($q$delete from public.studio_test_mode_log$q$);
  perform pg_temp.res('24 the log is append-only (delete refused)', e like '42501%append-only%', e);
exception when others then perform pg_temp.su(); insert into _r203 values ('4x', 'FAIL: '||sqlstate||' '||sqlerrm); end $$;

-- ---- 5) objects ---------------------------------------------------------------------------------------------------------
select pg_temp.su();
select pg_temp.res('25 tables: RLS on, no app privilege',
  (select count(*) from pg_class c where c.relnamespace = 'public'::regnamespace and c.relname in ('studio_test_mode', 'studio_test_mode_log') and c.relrowsecurity) = 2
  and not has_table_privilege('authenticated', 'public.studio_test_mode', 'select')
  and not has_table_privilege('anon', 'public.studio_test_mode', 'select')
  and not has_table_privilege('authenticated', 'public.studio_test_mode_log', 'select'));
select pg_temp.res('26 grants: HQ call + my_test_studio for signed-in (gate inside), never anon; helper / _r285_step_up server-only',
  has_function_privilege('authenticated', 'public.hq_set_test_studio(uuid, boolean, text)', 'execute')
  and not has_function_privilege('anon', 'public.hq_set_test_studio(uuid, boolean, text)', 'execute')
  and has_function_privilege('authenticated', 'public.my_test_studio()', 'execute')
  and not has_function_privilege('anon', 'public.my_test_studio()', 'execute')
  and not has_function_privilege('authenticated', 'public._r381_two_step_exempt(uuid)', 'execute')
  and not has_function_privilege('authenticated', 'public._r285_step_up(uuid)', 'execute'));
select pg_temp.res('27 definer + empty search_path + r203-0381 marker on every new / re-issued function (and r35-0285 kept)',
  (select bool_and(p.prosecdef and coalesce(p.proconfig, '{}') @> array['search_path=""'] and position('r203-0381' in p.prosrc) > 0)
     from pg_proc p where p.oid in ('public._r381_two_step_exempt(uuid)'::regprocedure, 'public.hq_set_test_studio(uuid, boolean, text)'::regprocedure,
       'public.my_test_studio()'::regprocedure, 'public._r285_step_up(uuid)'::regprocedure, 'public._r381_tg_test_mode_guard()'::regprocedure,
       'public._r381_tg_test_mode_log()'::regprocedure))
  and position('r35-0285' in pg_get_functiondef('public._r285_step_up(uuid)'::regprocedure)) > 0);

select pg_temp.su();
do $$ declare n int; f int; r record; begin
  select count(*), count(*) filter (where result <> 'PASS') into n, f from _r203;
  for r in select * from _r203 where result <> 'PASS' loop raise warning '% -> %', r.name, r.result; end loop;
  if f = 0 then raise warning 'R203-TEST-STUDIO-0381: ALL PASS (%/%)', n, n;
  else raise warning 'R203-TEST-STUDIO-0381: % FAILED of %', f, n; end if;
end $$;
rollback;
