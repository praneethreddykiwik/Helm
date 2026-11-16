-- r174b-presence-0366.sql - R174b: chat online status (member_presence + presence_touch / presence_list / presence_set_visible).
-- Proves: (1) the table is closed to the app (RLS on, no grants) and anon cannot call anything; (2) touch writes my row,
-- at most once per 2 minutes; (3) list shows only my studio, never me, never another studio; (4) "Show when I am online"
-- off hides me (no last active time, listed as hidden); (5) re-run safe.
-- Re-applies 0366 twice. Local disposable PG only. Fake data only. Rolled back.
\set ON_ERROR_STOP 0
set client_min_messages = error;
\ir ../../supabase/migrations/0366_r174b_presence.sql
\ir ../../supabase/migrations/0366_r174b_presence.sql
set client_min_messages = warning;
begin;
create temp table _rs(name text, result text); grant all on _rs to anon, authenticated, service_role;
create or replace function pg_temp.t(p_name text, p_ok boolean, p_detail text default '') returns void language plpgsql as $$
begin insert into _rs values (p_name, case when coalesce(p_ok, false) then 'PASS' else 'FAIL: ' || coalesce(p_detail, '') end); end $$;
create or replace function pg_temp.as_val(p_who text, p_sql text) returns text language plpgsql as $$
declare v text;
begin
  if p_who = 'anon' then perform auth.login_anon();
  elsif p_who is not null then perform auth.login_as((select id from auth.users where email = p_who)); end if;
  execute p_sql into v;
  perform auth.logout(); execute 'reset role';
  return 'ok:' || coalesce(v, '<null>');
exception when others then
  perform auth.logout(); execute 'reset role';
  return sqlstate || ' ' || sqlerrm;
end $$;
create temp table _u as select email, id from auth.users where email in ('a_admin@a.test', 'a_staff@a.test', 'b_staff@b.test');
grant select on _u to anon, authenticated, service_role;
create or replace function pg_temp.uid(p_email text) returns uuid language sql as $$ select id from _u where email = p_email $$;
delete from public.member_presence;

-- ---- 1) closed to the app ----------------------------------------------------------------------------------------------
select pg_temp.t('1a table not readable by signed-in people', pg_temp.as_val('a_admin@a.test', 'select count(*)::text from public.member_presence') like '42501%');
select pg_temp.t('1b anon cannot list', pg_temp.as_val('anon', 'select public.presence_list()::text') like '42501%');
select pg_temp.t('1c anon cannot touch', pg_temp.as_val('anon', 'select public.presence_touch()::text') like '42501%');

-- ---- 2) touch + throttle --------------------------------------------------------------------------------------------------
select pg_temp.as_val('a_staff@a.test', 'select public.presence_touch()::text');
select pg_temp.t('2a my row written with my studio', (select org_id = 'a0000000-0000-4000-8000-000000000001' and last_seen_at is not null
  from public.member_presence where user_id = pg_temp.uid('a_staff@a.test')));
update public.member_presence set last_seen_at = now() - interval '1 minute' where user_id = pg_temp.uid('a_staff@a.test');
select pg_temp.as_val('a_staff@a.test', 'select public.presence_touch()::text');
select pg_temp.t('2b a second touch within 2 minutes does not write', (select last_seen_at < now() - interval '50 seconds'
  from public.member_presence where user_id = pg_temp.uid('a_staff@a.test')));
update public.member_presence set last_seen_at = now() - interval '5 minutes' where user_id = pg_temp.uid('a_staff@a.test');
select pg_temp.as_val('a_staff@a.test', 'select public.presence_touch()::text');
select pg_temp.t('2c after 2 minutes it writes again', (select last_seen_at > now() - interval '10 seconds'
  from public.member_presence where user_id = pg_temp.uid('a_staff@a.test')));

-- ---- 3) own studio only, never me ------------------------------------------------------------------------------------------
select pg_temp.as_val('b_staff@b.test', 'select public.presence_touch()::text');
select pg_temp.t('3a my colleague sees me', pg_temp.as_val('a_admin@a.test', $q$select count(*)::text from jsonb_array_elements(public.presence_list()->'people') x
  where (x->>'user_id')::uuid = pg_temp.uid('a_staff@a.test') and x->>'last_seen_at' is not null$q$) = 'ok:1');
select pg_temp.t('3b another studio is never listed', pg_temp.as_val('a_admin@a.test', $q$select count(*)::text from jsonb_array_elements(public.presence_list()->'people') x
  where (x->>'user_id')::uuid = pg_temp.uid('b_staff@b.test')$q$) = 'ok:0');
select pg_temp.t('3c I am not in my own list', pg_temp.as_val('a_staff@a.test', $q$select count(*)::text from jsonb_array_elements(public.presence_list()->'people') x
  where (x->>'user_id')::uuid = pg_temp.uid('a_staff@a.test')$q$) = 'ok:0');
select pg_temp.t('3d my switch defaults to on', pg_temp.as_val('a_staff@a.test', $q$select (public.presence_list()->>'me_show')$q$) = 'ok:true');

-- ---- 4) "Show when I am online" off ----------------------------------------------------------------------------------------
select pg_temp.as_val('a_staff@a.test', 'select public.presence_set_visible(false)::text');
select pg_temp.t('4a hidden: no longer in the people list', pg_temp.as_val('a_admin@a.test', $q$select count(*)::text from jsonb_array_elements(public.presence_list()->'people') x
  where (x->>'user_id')::uuid = pg_temp.uid('a_staff@a.test')$q$) = 'ok:0');
select pg_temp.t('4b ... listed as hidden (so no live dot is shown either)', pg_temp.as_val('a_admin@a.test', $q$select count(*)::text from jsonb_array_elements_text(public.presence_list()->'hidden') x
  where x::uuid = pg_temp.uid('a_staff@a.test')$q$) = 'ok:1');
select pg_temp.t('4c my own switch reads off', pg_temp.as_val('a_staff@a.test', $q$select (public.presence_list()->>'me_show')$q$) = 'ok:false');
select pg_temp.as_val('a_staff@a.test', 'select public.presence_set_visible(true)::text');
select pg_temp.t('4d on again: shown again', pg_temp.as_val('a_admin@a.test', $q$select count(*)::text from jsonb_array_elements(public.presence_list()->'people') x
  where (x->>'user_id')::uuid = pg_temp.uid('a_staff@a.test')$q$) = 'ok:1');

-- ---- 5) re-run safe ------------------------------------------------------------------------------------------------------------
select pg_temp.t('5a one table, RLS on, functions are the R174b ones', to_regclass('public.member_presence') is not null
  and (select relrowsecurity from pg_class where oid = 'public.member_presence'::regclass)
  and position('r174b-0366' in pg_get_functiondef(to_regprocedure('public.presence_touch()'))) > 0);
do $$ declare n int; f int; r record; begin
  select count(*), count(*) filter (where result <> 'PASS') into n, f from _rs;
  for r in select * from _rs where result <> 'PASS' loop raise warning '% -> %', r.name, r.result; end loop;
  if f = 0 then raise warning 'R174B-PRESENCE-0366: ALL PASS (%/%)', n, n;
  else raise warning 'R174B-PRESENCE-0366: % FAILED of %', f, n; end if;
end $$;
rollback;
