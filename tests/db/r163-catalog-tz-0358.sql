-- r163-catalog-tz-0358.sql - behavioral proof for 0358. notification_catalog() answers exactly the 0354 list (kept body
-- notification_catalog__pre0358) and builds it once per request; my_notification_prefs / admin_get_notification_prefs answer the
-- same as with the 0354 catalog and much faster; _r23_tz answers exactly the 0266 body for valid, unknown, abbreviated, offset,
-- empty and missing time zones and a missing studio; kept bodies and the names copy have no app privilege; re-run safe.
-- Local disposable PG only. Rolled back.
\set ON_ERROR_STOP 0
set client_min_messages = warning;
begin;
create temp table _ct(name text, result text); grant all on _ct to anon, authenticated;
\i supabase/migrations/0358_r163_catalog_tz_speed.sql
\i supabase/migrations/0358_r163_catalog_tz_speed.sql

do $$ declare org uuid := 'a0000000-0000-4000-8000-000000000001'; a_admin uuid; tz text; bad int := 0; n int := 0;
  p_new jsonb; p_old jsonb; a_new jsonb; a_old jsonb; t0 timestamptz; t_new interval; t_old interval; src text; begin
  execute 'reset role';
  select id into a_admin from auth.users where email='a_admin@a.test';
  -- 1 the catalog
  insert into _ct values ('01 notification_catalog = the 0354 list (plan_active + wa_templates once)',
    case when public.notification_catalog() = public.notification_catalog__pre0358()
          and (select count(*) from jsonb_array_elements(public.notification_catalog()) e where e ->> 'type' in ('plan_active', 'wa_templates')) = 2
          and public.notification_catalog() = public.notification_catalog() then 'PASS' else 'FAIL' end);
  insert into _ct values ('02 the answer is kept for the request (transaction-local setting)',
    case when coalesce(current_setting('helm.r358_cat', true), '') <> '' and current_setting('helm.r358_cat', true)::jsonb = public.notification_catalog__pre0358() then 'PASS' else 'FAIL' end);

  -- 3-4 the prefs pages: same answer as with the 0354 catalog, faster
  perform auth.login_as(a_admin); execute 'reset role';
  t0 := clock_timestamp(); p_new := public.my_notification_prefs(); a_new := public.admin_get_notification_prefs(); t_new := clock_timestamp() - t0;
  -- the same pages with the 0354 body put back for a moment (inside this rolled-back transaction)
  alter function public.notification_catalog() rename to notification_catalog__r358new;
  alter function public.notification_catalog__pre0358() rename to notification_catalog;
  t0 := clock_timestamp(); p_old := public.my_notification_prefs(); a_old := public.admin_get_notification_prefs(); t_old := clock_timestamp() - t0;
  alter function public.notification_catalog() rename to notification_catalog__pre0358;
  alter function public.notification_catalog__r358new() rename to notification_catalog;
  insert into _ct values ('03 my_notification_prefs + admin_get_notification_prefs answer the same', case when p_new = p_old and a_new = a_old then 'PASS' else 'FAIL' end);
  insert into _ct values ('04 the prefs pages at least 2x faster', case when t_new * 2 < t_old then 'PASS' else 'FAIL old ' || t_old || ' new ' || t_new end);

  -- 5 _r23_tz = the 0266 answer for every kind of time zone value
  foreach tz in array array['Asia/Dubai', 'Asia/Kolkata', 'America/New_York', 'UTC', 'Etc/GMT+5', 'EST5EDT', 'IST', '+05:30', 'Not/AZone', '', 'asia/dubai'] loop
    execute 'alter table public.organizations disable trigger user';
    update public.organizations set timezone = tz where id = org;
    execute 'alter table public.organizations enable trigger user';
    n := n + 1;
    if public._r23_tz(org) is distinct from public._r23_tz__pre0358(org) then bad := bad + 1; raise warning 'tz % differs: % vs %', tz, public._r23_tz(org), public._r23_tz__pre0358(org); end if;
  end loop;
  if public._r23_tz(gen_random_uuid()) is distinct from public._r23_tz__pre0358(gen_random_uuid()) then bad := bad + 1; end if;
  insert into _ct values ('05 _r23_tz answers exactly as the 0266 body (11 values + missing studio)', case when bad = 0 and n = 11 then 'PASS' else 'FAIL ' || bad end);
  -- 6 faster for a valid zone
  execute 'alter table public.organizations disable trigger user';
  update public.organizations set timezone = 'Asia/Dubai' where id = org;
  execute 'alter table public.organizations enable trigger user';
  t0 := clock_timestamp(); for n in 1..30 loop perform public._r23_tz__pre0358(org); end loop; t_old := clock_timestamp() - t0;
  t0 := clock_timestamp(); for n in 1..30 loop perform public._r23_tz(org); end loop; t_new := clock_timestamp() - t0;
  insert into _ct values ('06 _r23_tz at least 5x faster for a valid zone', case when t_new * 5 < t_old and public._r23_tz(org) = 'Asia/Dubai' then 'PASS' else 'FAIL old ' || t_old || ' new ' || t_new end);

  -- 7-9 bodies + privileges
  select p.prosrc into src from pg_proc p where p.oid = to_regprocedure('public.notification_catalog()');
  insert into _ct values ('07 new bodies carry r163-0358 (+ the 0354 marker the checker reads)',
    case when position('r163-0358' in src) > 0 and position('r156-0354' in src) > 0
          and position('r163-0358' in (select p.prosrc from pg_proc p where p.oid = to_regprocedure('public._r23_tz(uuid)'))) > 0 then 'PASS' else 'FAIL' end);
  insert into _ct values ('08 kept bodies + the names copy: no app privilege',
    case when not has_function_privilege('authenticated', 'public.notification_catalog__pre0358()', 'execute')
          and not has_function_privilege('service_role', 'public.notification_catalog__pre0358()', 'execute')
          and not has_function_privilege('authenticated', 'public._r23_tz__pre0358(uuid)', 'execute')
          and not has_table_privilege('authenticated', 'public._r358_tz_names', 'select')
          and not has_table_privilege('anon', 'public._r358_tz_names', 'select')
          and (select relrowsecurity from pg_class where oid = 'public._r358_tz_names'::regclass)
          and (select count(*) from public._r358_tz_names) > 300 then 'PASS' else 'FAIL' end);
  insert into _ct values ('09 grants as before (catalog: signed-in + service role; _r23_tz: service role only)',
    case when has_function_privilege('authenticated', 'public.notification_catalog()', 'execute')
          and not has_function_privilege('anon', 'public.notification_catalog()', 'execute')
          and has_function_privilege('service_role', 'public._r23_tz(uuid)', 'execute')
          and not has_function_privilege('authenticated', 'public._r23_tz(uuid)', 'execute') then 'PASS' else 'FAIL' end);
end $$;

select name, result from _ct order by name;
select case when count(*) filter (where result <> 'PASS') = 0 and count(*) = 9
            then 'R163-CATALOG-TZ-0358: ALL PASS (' || count(*) || '/' || count(*) || ')'
            else 'R163-CATALOG-TZ-0358: FAIL (' || count(*) filter (where result = 'PASS') || '/' || count(*) || ')' end
  from _ct;
rollback;
