-- r206-api-timeouts-0384.sql - R206 (0384): the prod "statement timeout" calls on seeded volume. Proves:
-- (1) 0384 applied twice: event_timesheet carries the r206-0384 body, the old body is kept ONCE as event_timesheet__pre0384
--     with no app privilege, grants / definer / empty search_path / stable kept, the 0371 crew reader name still in the body;
-- (2) the five new indexes exist and are valid;
-- (3) the new event_timesheet answers EXACTLY what the old body answers (jsonb equal) for every event of a seeded studio
--     (200 events x 50 tasks, 1500 staff, shifts + claims, cancelled tasks, arrivals, multi-day check-ins, event times),
--     plus the fixture events and an unknown id;
-- (4) authorization unchanged: signed out, a role without staff / command view, another studio = the same refusal as the
--     old body (42501 / P0002), the old body is not callable by the app;
-- (5) bounded work: on an event of a studio with 1500 staff the new body reads less than half the pages of the old one
--     and stays inside a runtime budget; all 200 events read in a few seconds;
-- (6) the indexes fit the queries: arrival mark, a person's tasks on an event, a person's claims, home Recent activity for a
--     small studio next to a busy one (row security on, newest first) uses (org_id, at, id) and reads few pages;
-- (7) runsheet_group_status is unchanged and cheap (a handful of page reads).
-- Local disposable PG only. Fixture studios A + B. Rolled back.
\set ON_ERROR_STOP 0
set client_min_messages = error;
\ir ../../supabase/migrations/0384_r206_api_timeouts.sql
\ir ../../supabase/migrations/0384_r206_api_timeouts.sql
set client_min_messages = warning;
begin;
create temp table _r206(name text, result text); grant all on _r206 to anon, authenticated, service_role;
create temp table _r206kv(k text primary key, v text); grant all on _r206kv to anon, authenticated, service_role;
create or replace function pg_temp.su() returns void language plpgsql as $$
begin execute 'reset role'; perform auth.logout(); execute 'reset role'; end $$;
create or replace function pg_temp.login(p_email text) returns void language plpgsql as $$
declare u uuid; begin
  perform pg_temp.su(); select id into u from auth.users where email = p_email;
  perform set_config('request.jwt.claims', jsonb_build_object('sub', u, 'role', 'authenticated', 'email', p_email, 'aal', 'aal1')::text, false);
  perform set_config('role', 'authenticated', false);
end $$;
create or replace function pg_temp.anon() returns void language plpgsql as $$
begin perform pg_temp.su(); perform set_config('request.jwt.claims', '{"role":"anon"}', false); perform set_config('role', 'anon', false); end $$;
create or replace function pg_temp.res(p_name text, p_ok boolean, p_detail text default '') returns void language plpgsql as $$
begin insert into _r206 values (p_name, case when coalesce(p_ok, false) then 'PASS' else 'FAIL: '||coalesce(p_detail,'') end); end $$;
grant execute on function pg_temp.res(text, boolean, text) to anon, authenticated, service_role;
-- a call's answer as text, an error as "ERR <sqlstate>"
create or replace function pg_temp.ans(p_sql text) returns text language plpgsql as $$
declare v jsonb; begin execute p_sql into v; return coalesce(v::text, 'null'); exception when others then return 'ERR ' || sqlstate; end $$;
grant execute on function pg_temp.ans(text) to anon, authenticated, service_role;
-- pages read (shared hit + read) and ms of one statement, from explain analyze
create or replace function pg_temp.cost(p_sql text) returns jsonb language plpgsql as $$
declare j json; begin
  execute 'explain (analyze, buffers, format json) ' || p_sql into j;
  return jsonb_build_object('pages', ((j -> 0 -> 'Plan' ->> 'Shared Hit Blocks')::int + (j -> 0 -> 'Plan' ->> 'Shared Read Blocks')::int),
                            'ms', (j -> 0 ->> 'Execution Time')::numeric, 'plan', j::text);
end $$;
grant execute on function pg_temp.cost(text) to anon, authenticated, service_role;
create or replace function pg_temp.plan_text(p_sql text) returns text language plpgsql set enable_seqscan = off as $$
declare r record; v text := ''; begin
  for r in execute 'explain (format text) ' || p_sql loop v := v || r."QUERY PLAN" || ' '; end loop; return v; end $$;
grant execute on function pg_temp.plan_text(text) to anon, authenticated, service_role;
create or replace function pg_temp.put(p_k text, p_v text) returns void language plpgsql as $$
begin insert into _r206kv values (p_k, p_v) on conflict (k) do update set v = excluded.v; end $$;
grant execute on function pg_temp.put(text, text) to anon, authenticated, service_role;
create or replace function pg_temp.get(p_k text) returns text language sql as $$ select v from _r206kv where k = p_k $$;
grant execute on function pg_temp.get(text) to anon, authenticated, service_role;

-- ---- (1) applied twice, old body kept once, privileges ------------------------------------------------------------------
select pg_temp.su();
select pg_temp.res('01 event_timesheet carries the r206-0384 body; the old body kept once as __pre0384 (0265 / 0371 text)',
  position('r206-0384' in pg_get_functiondef('public.event_timesheet(uuid)'::regprocedure)) > 0
  and to_regprocedure('public.event_timesheet__pre0384(uuid)') is not null
  and position('r206-0384' in pg_get_functiondef('public.event_timesheet__pre0384(uuid)'::regprocedure)) = 0
  and position('r23-crew-0265' in pg_get_functiondef('public.event_timesheet__pre0384(uuid)'::regprocedure)) > 0
  and (select count(*) from pg_proc where proname like 'event_timesheet%' and pronamespace = 'public'::regnamespace) = 2);
select pg_temp.res('02 grants: signed-in staff keep execute, signed out none; the kept body has no app privilege',
  has_function_privilege('authenticated', 'public.event_timesheet(uuid)', 'execute')
  and not has_function_privilege('anon', 'public.event_timesheet(uuid)', 'execute')
  and not has_function_privilege('authenticated', 'public.event_timesheet__pre0384(uuid)', 'execute')
  and not has_function_privilege('anon', 'public.event_timesheet__pre0384(uuid)', 'execute'));
select pg_temp.res('03 definer + empty search_path + stable kept; still reads the crew settings through _r25_crew_cfg (0371)',
  (select bool_and(p.prosecdef and p.provolatile = 's' and coalesce(p.proconfig, '{}') @> array['search_path=""']) from pg_proc p
     where p.oid in ('public.event_timesheet(uuid)'::regprocedure, 'public.event_timesheet__pre0384(uuid)'::regprocedure))
  and position('public._r25_crew_cfg(' in pg_get_functiondef('public.event_timesheet(uuid)'::regprocedure)) > 0
  and position('public._r23_cfg(' in pg_get_functiondef('public.event_timesheet(uuid)'::regprocedure)) = 0);
select pg_temp.res('04 the five 0384 indexes exist and are valid',
  (select count(*) from pg_index i join pg_class c on c.oid = i.indexrelid
    where c.relname in ('ix_event_tasks_quote_crew_0384', 'ix_event_day_arrival_ref_0384', 'ix_open_shift_claims_crew_0384',
                        'ix_event_task_log_crew_0384', 'ix_audit_log_org_at_id_0384') and i.indisvalid) = 5
  and position('(org_id, at DESC, id DESC)' in pg_get_indexdef('public.ix_audit_log_org_at_id_0384'::regclass)) > 0);
select pg_temp.res('05 runsheet_group_status is not changed (still the 0132 body)',
  position('r206' in pg_get_functiondef('public.runsheet_group_status(uuid)'::regprocedure)) = 0
  and has_function_privilege('authenticated', 'public.runsheet_group_status(uuid)', 'execute')
  and not has_function_privilege('anon', 'public.runsheet_group_status(uuid)', 'execute'));

-- an earlier suite in run-all may have put the 0266 _r23_tz back (it reads every time zone name of Postgres on each call - the
-- old body calls it once per person, so 200 events x 50 people takes minutes). Put the 0358 one back for this test (rolled back).
set client_min_messages = error;
\ir ../../supabase/migrations/0358_r163_catalog_tz_speed.sql
set client_min_messages = warning;
-- ---- seeded volume: studio A gets 1500 staff, 200 events x 50 tasks, shifts, claims, arrivals, check-ins, a busy log ---------
-- (bulk rows written with triggers off - this suite measures reads; rolled back)
select pg_temp.su();
set local session_replication_role = replica;
do $$ declare a uuid := 'a0000000-0000-4000-8000-000000000001'; b uuid := 'b0000000-0000-4000-8000-000000000001'; begin
  update public.organizations set timezone = 'Asia/Kolkata' where id = a;
  insert into public.crew_members(id, org_id, name, phone, active)
    select ('c2060000-0000-4000-8000-' || lpad(g::text, 12, '0'))::uuid, a, 'Crew ' || lpad((g % 97)::text, 2, '0'), '+9190000' || lpad(g::text, 5, '0'), true
      from generate_series(1, 1500) g;
  -- one staff member of studio B wrongly put on an A task: never listed for A (the old body filtered on the studio too)
  insert into public.crew_members(id, org_id, name, phone, active) values ('c2060000-0000-4000-8000-00000000b001', b, 'B crew', '+9191111100001', true);
  insert into public.quotes(id, org_id, code, event_date, event_time)
    select ('e2060000-0000-4000-8000-' || lpad(g::text, 12, '0'))::uuid, a, 'R206-' || g, current_date - 100 + g,
           case g % 4 when 0 then '18:30' when 1 then '7 pm' when 2 then null else 'soon' end
      from generate_series(1, 200) g;
  insert into public.event_tasks(quote_id, org_id, category, title, seq, crew_id, status, planned_start)
    select ('e2060000-0000-4000-8000-' || lpad(e::text, 12, '0'))::uuid, a, 'setup', 'T' || t, t,
           case when t = 50 then null else ('c2060000-0000-4000-8000-' || lpad((1 + (e * 7 + t) % 1500)::text, 12, '0'))::uuid end,
           case when t % 9 = 0 then 'cancelled' when t % 11 = 0 then 'rejected' when t % 5 = 0 then 'completed' else 'assigned' end,
           case when t % 4 = 0 then null else (current_date - 100 + e)::timestamp + make_interval(hours => 6 + t % 10) end
      from generate_series(1, 200) e, generate_series(1, 50) t;
  insert into public.event_tasks(quote_id, org_id, category, title, seq, crew_id, status)
    values ('e2060000-0000-4000-8000-000000000100', a, 'setup', 'B', 99, 'c2060000-0000-4000-8000-00000000b001', 'assigned');
  insert into public.open_shifts(id, org_id, quote_id, title, shift_date, start_time, end_time)
    select ('f2060000-0000-4000-8000-' || lpad(g::text, 12, '0'))::uuid, a, ('e2060000-0000-4000-8000-' || lpad(g::text, 12, '0'))::uuid,
           'Shift ' || g, current_date - 100 + g, case when g % 3 = 0 then null else time '05:15' end, '20:00'
      from generate_series(1, 200) g;
  insert into public.open_shift_claims(org_id, shift_id, quote_id, crew_id, status)
    select a, ('f2060000-0000-4000-8000-' || lpad(g::text, 12, '0'))::uuid, ('e2060000-0000-4000-8000-' || lpad(g::text, 12, '0'))::uuid,
           ('c2060000-0000-4000-8000-' || lpad((1 + (g * 13 + j) % 1500)::text, 12, '0'))::uuid, case when j % 3 = 0 then 'pending' else 'approved' end
      from generate_series(1, 200) g, generate_series(1, 6) j;
  insert into public.event_day(quote_id, org_id, kind, who, ref_id, status, updated_at)
    select distinct on (t.quote_id, t.crew_id) t.quote_id, a, 'arrival', 'x', t.crew_id,
           case (hashtext(t.crew_id::text) & 3) when 0 then 'no_show' when 1 then 'arrived' when 2 then 'expected' else 'left' end, now() - interval '1 hour'
      from public.event_tasks t where t.org_id = a and t.quote_id::text like 'e2060000%' and t.crew_id is not null and (t.seq % 3) = 0;
  insert into public.crew_checkins(org_id, quote_id, crew_id, work_day, check_in_at, check_out_at, late_min)
    select distinct on (t.quote_id, t.crew_id) a, t.quote_id, t.crew_id, case when t.seq % 10 = 2 then current_date else (current_date - 100 + substr(t.quote_id::text, 25)::int) end,
           now() - interval '5 hours', case when t.seq % 3 = 0 then null else now() - interval '1 hour' end, (t.seq * 7) % 40
      from public.event_tasks t where t.org_id = a and t.quote_id::text like 'e2060000%' and t.crew_id is not null and (t.seq % 2) = 0;
  insert into public.crew_checkins(org_id, quote_id, crew_id, work_day, check_in_at, check_out_at, late_min)
    select org_id, quote_id, crew_id, work_day + 1, check_in_at + interval '1 day', check_out_at + interval '1 day', 2
      from public.crew_checkins where quote_id::text like 'e2060000%' and (hashtext(id::text) & 7) = 0 on conflict do nothing;
  -- the log: 60,000 newer rows of busy studio A, then 30 older rows of small studio B
  insert into public.audit_log(org_id, action, entity, quote_id, at)
    select a, 'quote.update', 'quotes', ('e2060000-0000-4000-8000-' || lpad((1 + g % 200)::text, 12, '0'))::uuid, now() - make_interval(secs => g)
      from generate_series(1, 60000) g;
  insert into public.audit_log(org_id, action, entity, at)
    select b, 'quote.update', 'quotes', now() - interval '3 days' - make_interval(mins => g) from generate_series(1, 30) g;
  -- and 40 other small studios (production has many trial studios, so the planner knows one studio is a small part of the log)
  insert into public.audit_log(org_id, action, entity, at)
    select ('d2060000-0000-4000-8000-' || lpad(s::text, 12, '0'))::uuid, 'quote.update', 'quotes', now() - make_interval(mins => s * 37 + g)
      from generate_series(1, 40) s, generate_series(1, 400) g;
end $$;
set local session_replication_role = origin;
analyze public.crew_members; analyze public.quotes; analyze public.event_tasks; analyze public.open_shifts; analyze public.open_shift_claims;
analyze public.event_day; analyze public.crew_checkins; analyze public.audit_log;
grant execute on function public.event_timesheet__pre0384(uuid) to authenticated;   -- only inside this rolled-back test, to compare

-- ---- (3) the same answer, key for key ------------------------------------------------------------------------------------
select pg_temp.login('a_admin@a.test');
select pg_temp.put('same', (select count(*)::text from public.quotes q where q.code like 'R206-%'
   and pg_temp.ans(format('select public.event_timesheet(%L)', q.id)) = pg_temp.ans(format('select public.event_timesheet__pre0384(%L)', q.id))));
select pg_temp.put('rows', (select sum(jsonb_array_length(public.event_timesheet(q.id) -> 'rows'))::text from public.quotes q where q.code like 'R206-%'));
select pg_temp.put('flags', (select string_agg(distinct coalesce(r ->> 'flag', '-'), ',' order by coalesce(r ->> 'flag', '-'))
   from public.quotes q, jsonb_array_elements(public.event_timesheet(q.id) -> 'rows') r where q.code like 'R206-%'));
select pg_temp.put('rosters', (select string_agg(distinct coalesce(r ->> 'roster', '-'), ',' order by coalesce(r ->> 'roster', '-'))
   from public.quotes q, jsonb_array_elements(public.event_timesheet(q.id) -> 'rows') r where q.code like 'R206-%'));
select pg_temp.put('starts', (select count(*)::text from public.quotes q, jsonb_array_elements(public.event_timesheet(q.id) -> 'rows') r
   where q.code like 'R206-%' and r ->> 'expected_start' is not null));
select pg_temp.put('multi', (select count(*)::text from public.quotes q, jsonb_array_elements(public.event_timesheet(q.id) -> 'rows') r
   where q.code like 'R206-%' and jsonb_array_length(r -> 'entries') > 1));
select pg_temp.put('bcrew', (select count(*)::text from jsonb_array_elements(public.event_timesheet('e2060000-0000-4000-8000-000000000100') -> 'rows') r
   where r ->> 'crew_id' = 'c2060000-0000-4000-8000-00000000b001'));
select pg_temp.put('fixture', (pg_temp.ans($q$select public.event_timesheet('a0000000-0000-4000-8000-00000000da01')$q$)
   = pg_temp.ans($q$select public.event_timesheet__pre0384('a0000000-0000-4000-8000-00000000da01')$q$))::text);
select pg_temp.put('unknown', pg_temp.ans($q$select public.event_timesheet('a0000000-0000-4000-8000-0000000fffff')$q$) || ' | '
   || pg_temp.ans($q$select public.event_timesheet__pre0384('a0000000-0000-4000-8000-0000000fffff')$q$));
select pg_temp.su();
select pg_temp.res('06 all 200 seeded events: the new answer equals the old body exactly', pg_temp.get('same') = '200', pg_temp.get('same'));
select pg_temp.res('07 the seed covers every branch (late / no-show / suspected / none, every roster mark, expected starts, multi-day)',
  pg_temp.get('flags') = '-,late,no_show,no_show_suspected' and pg_temp.get('rosters') = '-,arrived,expected,left,no_show'
  and pg_temp.get('starts')::int > 1000 and pg_temp.get('multi')::int > 50 and pg_temp.get('rows')::int > 5000,
  pg_temp.get('flags') || ' / ' || pg_temp.get('rosters') || ' / ' || pg_temp.get('starts') || ' / ' || pg_temp.get('multi') || ' / ' || pg_temp.get('rows'));
select pg_temp.res('08 another studio''s staff member on an A task is not listed (same as before)', pg_temp.get('bcrew') = '0', pg_temp.get('bcrew'));
select pg_temp.res('09 the fixture event: same answer; an unknown event: the same P0002 as before',
  pg_temp.get('fixture') = 'true' and pg_temp.get('unknown') = 'ERR P0002 | ERR P0002', pg_temp.get('fixture') || ' ' || pg_temp.get('unknown'));

-- ---- (4) authorization unchanged ----------------------------------------------------------------------------------------
select pg_temp.anon();
select pg_temp.put('anon', pg_temp.ans($q$select public.event_timesheet('e2060000-0000-4000-8000-000000000100')$q$));
select pg_temp.login('a_staff@a.test');   -- sales: no staff / command view in the fixture
select pg_temp.put('sales', pg_temp.ans($q$select public.event_timesheet('e2060000-0000-4000-8000-000000000100')$q$) || ' | '
   || pg_temp.ans($q$select public.event_timesheet__pre0384('e2060000-0000-4000-8000-000000000100')$q$));
select pg_temp.login('b_admin@b.test');   -- another studio
select pg_temp.put('other', pg_temp.ans($q$select public.event_timesheet('e2060000-0000-4000-8000-000000000100')$q$) || ' | '
   || pg_temp.ans($q$select public.event_timesheet__pre0384('e2060000-0000-4000-8000-000000000100')$q$));
select pg_temp.su();
revoke execute on function public.event_timesheet__pre0384(uuid) from authenticated;
select pg_temp.login('a_admin@a.test');
select pg_temp.put('pre_app', pg_temp.ans($q$select public.event_timesheet__pre0384('e2060000-0000-4000-8000-000000000100')$q$));
select pg_temp.su();
select pg_temp.res('10 signed out: refused (no execute)', pg_temp.get('anon') = 'ERR 42501', pg_temp.get('anon'));
select pg_temp.res('11 a role without staff / command view: refused exactly like the old body', pg_temp.get('sales') = 'ERR 42501 | ERR 42501', pg_temp.get('sales'));
select pg_temp.res('12 another studio: "no such event" exactly like the old body (nothing revealed)', pg_temp.get('other') = 'ERR P0002 | ERR P0002', pg_temp.get('other'));
select pg_temp.res('13 the kept old body is not callable by the app', pg_temp.get('pre_app') = 'ERR 42501', pg_temp.get('pre_app'));
grant execute on function public.event_timesheet__pre0384(uuid) to authenticated;

-- ---- (5) bounded work on seeded volume -----------------------------------------------------------------------------------
select pg_temp.login('a_admin@a.test');
select public.event_timesheet('e2060000-0000-4000-8000-000000000101'), public.event_timesheet__pre0384('e2060000-0000-4000-8000-000000000101');   -- warm both
select pg_temp.put('new', pg_temp.cost($q$select public.event_timesheet('e2060000-0000-4000-8000-000000000100')$q$)::text);
select pg_temp.put('old', pg_temp.cost($q$select public.event_timesheet__pre0384('e2060000-0000-4000-8000-000000000100')$q$)::text);
select pg_temp.put('t0', clock_timestamp()::text);
select count(*) from public.quotes q where q.code like 'R206-%' and public.event_timesheet(q.id) is not null;
select pg_temp.put('all_ms', (extract(epoch from clock_timestamp() - pg_temp.get('t0')::timestamptz) * 1000)::int::text);
select pg_temp.su();
select pg_temp.res('14 one event of a 1500-staff studio: under half the page reads of the old body',
  (pg_temp.get('new')::jsonb ->> 'pages')::int * 2 < (pg_temp.get('old')::jsonb ->> 'pages')::int,
  'new ' || (pg_temp.get('new')::jsonb ->> 'pages') || ' pages / old ' || (pg_temp.get('old')::jsonb ->> 'pages'));
select pg_temp.res('15 one event: inside a 1 second budget (the API limit is 8 s)', (pg_temp.get('new')::jsonb ->> 'ms')::numeric < 1000,
  (pg_temp.get('new')::jsonb ->> 'ms') || ' ms');
select pg_temp.res('16 all 200 events one after another: inside a 20 second budget', pg_temp.get('all_ms')::int < 20000, pg_temp.get('all_ms') || ' ms');

-- ---- (6) the indexes fit the queries ---------------------------------------------------------------------------------------
select pg_temp.res('17 the latest arrival mark of one person on one event uses the arrival index',
  position('ix_event_day_arrival_ref_0384' in pg_temp.plan_text($q$select d.status from public.event_day d
     where d.quote_id = 'e2060000-0000-4000-8000-000000000100' and d.kind = 'arrival' and d.ref_id = 'c2060000-0000-4000-8000-000000000001'
     order by d.updated_at desc limit 1$q$)) > 0);
select pg_temp.res('18 one person''s tasks on one event use (quote_id, crew_id)',
  position('ix_event_tasks_quote_crew_0384' in pg_temp.plan_text($q$select min(t.planned_start) from public.event_tasks t
     where t.quote_id = 'e2060000-0000-4000-8000-000000000100' and t.crew_id = 'c2060000-0000-4000-8000-000000000001'$q$)) > 0);
select pg_temp.res('19 a staff member''s claims and task history use the new crew_id indexes',
  position('ix_open_shift_claims_crew_0384' in pg_temp.plan_text($q$select 1 from public.open_shift_claims c where c.crew_id = 'c2060000-0000-4000-8000-000000000001'$q$)) > 0
  and position('ix_event_task_log_crew_0384' in pg_temp.plan_text($q$select 1 from public.event_task_log l where l.crew_id = 'c2060000-0000-4000-8000-000000000001'$q$)) > 0);
select pg_temp.login('b_admin@b.test');
select count(*) from public.audit_log;   -- warm
select pg_temp.put('audit', pg_temp.cost($q$select * from public.audit_log order by at desc, id desc limit 51$q$)::text);
select pg_temp.put('audit_n', (select count(*)::text from (select 1 from public.audit_log order by at desc, id desc limit 51) x));
select pg_temp.su();
select pg_temp.res('20 Recent activity of a small studio next to 60,000 newer rows of another: (org_id, at, id) index, few pages, own rows only',
  position('ix_audit_log_org_at_id_0384' in (pg_temp.get('audit')::jsonb ->> 'plan')) > 0
  and (pg_temp.get('audit')::jsonb ->> 'pages')::int < 3000 and pg_temp.get('audit_n')::int between 30 and 51,
  (pg_temp.get('audit')::jsonb ->> 'pages') || ' pages, ' || pg_temp.get('audit_n') || ' rows');

-- ---- (7) runsheet_group_status: cheap, unchanged answer -------------------------------------------------------------------
select pg_temp.login('a_admin@a.test');
select public.runsheet_group_status('e2060000-0000-4000-8000-000000000100');   -- warm
select pg_temp.put('rgs', pg_temp.cost($q$select public.runsheet_group_status('e2060000-0000-4000-8000-000000000100')$q$)::text);
select pg_temp.put('rgs_v', pg_temp.ans($q$select public.runsheet_group_status('e2060000-0000-4000-8000-000000000100')$q$));
select pg_temp.su();
select pg_temp.res('21 runsheet_group_status: same answer, a handful of page reads (it was waiting, not working)',
  pg_temp.get('rgs_v') = '{"member": false, "has_group": false}' and (pg_temp.get('rgs')::jsonb ->> 'pages')::int < 200,
  pg_temp.get('rgs_v') || ' ' || (pg_temp.get('rgs')::jsonb ->> 'pages') || ' pages');

select pg_temp.su();
do $$ declare n int; f int; r record; begin
  select count(*), count(*) filter (where result <> 'PASS') into n, f from _r206;
  for r in select * from _r206 where result <> 'PASS' loop raise warning '% -> %', r.name, r.result; end loop;
  if f = 0 then raise warning 'R206-API-TIMEOUTS-0384: ALL PASS (%/%)', n, n;
  else raise warning 'R206-API-TIMEOUTS-0384: % FAILED of %', f, n; end if;
end $$;
rollback;
