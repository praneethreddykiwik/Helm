-- r256-layout-lock-0441.sql - R256 (25 Nov 2026): the 2D / 3D layout leaves the event-day lock (0397), everything else stays locked.
-- Proves: structure after two runs (triggers, kept bodies, grants), a LOCKED event takes a layout version (the page call and direct), the current
-- version and the hall size, and still REFUSES the task plan, the run-sheet, Venue opens / Ready by; a CLOSED event refuses a layout; an unlock
-- on the event day holds (during the automatic lock and before it), one from an earlier day is followed by the automatic lock; lock again locks;
-- auto_at / relocks; who may unlock, another studio, anon; the one-line undo. Local disposable PG only. Fake data only. Rolled back.
\set ON_ERROR_STOP 0
set client_min_messages = error;
begin;
create temp table _before as select (select md5(coalesce(string_agg(q::text, '|' order by q.id), '')) from public.quotes q) as qs,
  (select md5(coalesce(string_agg(v::text, '|' order by v.id), '')) from public.quote_versions v) as vs, (select md5(coalesce(string_agg(l::text, '|'), '')) from public.event_plan_locks l) as ls;
\o /dev/null
\i supabase/migrations/0441_r256_layout_not_locked.sql
\i supabase/migrations/0441_r256_layout_not_locked.sql
\o
-- 0442 (R257) removed the event-day lock: this check runs with its one-line switch on (rolled back with the suite)
create or replace function public._r442_lock_on() returns boolean language sql stable set search_path = '' as 'select true';
set client_min_messages = warning;
select set_config('helm.r397_plan_lock', 'on', false);
create temp table _rc(name text, result text); grant all on _rc to anon, authenticated, service_role;
create or replace function pg_temp.su() returns void language plpgsql as $$
begin execute 'reset role'; perform auth.logout(); execute 'reset role'; end $$;
create or replace function pg_temp.login(p_email text) returns void language plpgsql as $$
declare u uuid; begin
  perform pg_temp.su(); select id into u from auth.users where email = p_email;
  perform set_config('request.jwt.claims', jsonb_build_object('sub', u, 'role', 'authenticated', 'email', p_email, 'aal', 'aal1')::text, false);
  perform set_config('role', 'authenticated', false);
end $$;
create or replace function pg_temp.res(p_name text, p_ok boolean, p_detail text default '') returns void language plpgsql as $$
begin insert into _rc values (p_name, case when coalesce(p_ok, false) then 'PASS' else 'FAIL: ' || coalesce(p_detail, '') end); end $$;
create or replace function pg_temp.try(p_sql text) returns text language plpgsql as $$
begin execute p_sql; return ''; exception when others then return sqlstate || ' ' || sqlerrm; end $$;
create or replace function pg_temp.j(p_sql text) returns jsonb language plpgsql as $$
declare v jsonb; begin execute p_sql into v; return v; exception when others then return jsonb_build_object('err', sqlstate || ' ' || sqlerrm); end $$;
-- a page call (security definer) runs as the owner with the caller's claims: keep the claims, drop the role
create or replace function pg_temp.as_definer(p_sql text) returns void language plpgsql as $$
begin execute 'reset role'; execute p_sql; perform set_config('role', 'authenticated', false); exception when others then perform set_config('role', 'authenticated', false); raise; end $$;
grant execute on all functions in schema pg_temp to anon, authenticated, service_role;

-- 1) structure
select pg_temp.res('01 no stored row changed by the file (run twice)', (select b.qs = md5(coalesce((select string_agg(q::text, '|' order by q.id) from public.quotes q), ''))
  and b.vs = md5(coalesce((select string_agg(v::text, '|' order by v.id) from public.quote_versions v), '')) and b.ls = md5(coalesce((select string_agg(l::text, '|') from public.event_plan_locks l), '')) from _before b));
select pg_temp.res('02 five lock triggers, on; the old bodies kept once, word for word 0397', (select count(*) = 5 and bool_and(tgenabled = 'O') from pg_trigger where tgname = 'zz_r397_plan_lock')
  and (select count(*) = 4 from pg_proc where proname like '%\_\_pre0441') and position('r256-0441' in pg_get_functiondef('public.event_plan_lock_set__pre0441(uuid,boolean,text)'::regprocedure)) = 0
  and position('floor plan' in pg_get_functiondef('public._r397_tg_versions__pre0441()'::regprocedure)) > 0);
select pg_temp.res('03 grants as before: page calls signed in only, helpers + kept bodies server only', has_function_privilege('authenticated', 'public.event_plan_lock_get(uuid)', 'execute')
  and has_function_privilege('authenticated', 'public.event_plan_lock_set(uuid,boolean,text)', 'execute') and not has_function_privilege('anon', 'public.event_plan_lock_set(uuid,boolean,text)', 'execute')
  and (select bool_and(not has_function_privilege('authenticated', oid, 'execute') and not has_function_privilege('anon', oid, 'execute')) from pg_proc where proname like '\_r441\_%' or proname like '%\_\_pre0441'));

-- fixture: studio A, event in 10 days with a stage and 2 tasks; an event today whose first thing is in 3 hours (so the automatic lock starts in 2)
do $$ declare orgA uuid := 'a0000000-0000-4000-8000-000000000001'; q uuid := 'a0000000-0000-4000-8000-0000000d4411'; d uuid := 'a0000000-0000-4000-8000-0000000d4412'; u_sup uuid; u_view uuid; v_tz text; begin
  u_sup := auth.seed_user('a_sup441@a.test'); u_view := auth.seed_user('a_view441@a.test');
  insert into public.profiles(id, email, full_name, role, org_id, must_change_password, created_at) values
    (u_sup, 'a_sup441@a.test', 'Sunil Supervisor', 'supervisor', orgA, false, now()), (u_view, 'a_view441@a.test', 'Vani Viewer', 'coordinator', orgA, false, now())
  on conflict (id) do update set role = excluded.role, org_id = excluded.org_id, full_name = excluded.full_name;
  insert into public.role_access(role, area, can_view, can_edit, org_id, updated_at) values ('supervisor', 'staff', true, false, orgA, now()), ('supervisor', 'tasks', true, true, orgA, now()),
    ('supervisor', 'quotes', true, false, orgA, now()), ('coordinator', 'staff', true, false, orgA, now()), ('coordinator', 'quotes', true, false, orgA, now())
  on conflict (role, area, org_id) do update set can_view = excluded.can_view, can_edit = excluded.can_edit;
  v_tz := public._r23_tz(orgA);
  insert into public.quotes(id, code, title, status, client, pricing, current_version, approval_status, org_id, created_at, updated_at, event_date, event_time, lifecycle_stage) values
    (q, 'A-4411', 'In 10 days', 'confirmed', '{"name": "Alice", "hallLen": 120, "hallWid": 80}'::jsonb, '{}'::jsonb, 1, 'approved', orgA, now(), now(), (now() at time zone v_tz)::date + 10, '18:30', 'planning'),
    (d, 'A-4412', 'Today', 'confirmed', '{}'::jsonb, '{}'::jsonb, 1, 'approved', orgA, now(), now(), (now() at time zone v_tz)::date, null, 'planning');
  insert into public.quote_versions(quote_id, version_no, data, object_count, org_id) values (q, 1, '{"items": []}'::jsonb, 0, orgA);
  insert into public.event_tasks(id, quote_id, org_id, category, title, seq, status, assignee_name) values ('a0000000-0000-4000-8000-00000000a441', q, orgA, 'Stage', 'Stage set-up', 1, 'assigned', 'Ravi');
  insert into public.run_sheet_items(id, quote_id, org_id, start_time, duration_min, title, seq) values ('a0000000-0000-4000-8000-0000000e0441', q, orgA, '17:00', 30, 'Doors', 1);
  -- "today" has a task at the last minute of the studio's day, so the automatic lock starts at 22:59 whatever the hour of this run
  insert into public.event_tasks(id, quote_id, org_id, category, title, seq, status, planned_start) values ('a0000000-0000-4000-8000-00000000b441', d, orgA, 'Stage', 'Last thing', 1, 'assigned', ((now() at time zone v_tz)::date + time '23:59') at time zone v_tz);
end $$;
\set Q '\'a0000000-0000-4000-8000-0000000d4411\''
\set D '\'a0000000-0000-4000-8000-0000000d4412\''

-- 2) the answer while open
select pg_temp.login('a_admin@a.test');
create temp table _o as select pg_temp.j(format('select public.event_plan_lock_get(%L)', :Q)) as g; grant all on _o to authenticated;
select pg_temp.res('04 open, 10 days away: not locked, auto_at = 1 hour before the first thing (16:00 studio clock), relocks', (select (g ->> 'locked') = 'false' and (g ->> 'relocks') = 'true'
  and to_char((g ->> 'auto_at')::timestamptz at time zone 'Asia/Kolkata', 'HH24:MI') = '16:00' from _o), (select g::text from _o));
select pg_temp.su();
select pg_temp.res('05 auto_at agrees with the automatic lock (0397): on or after it = locked', (select bool_and(public._r397_auto(q.id) = coalesce(now() >= public._r441_auto_at(q.id), false))
  from public.quotes q where coalesce(q.lifecycle_stage, '') not in ('event_day', 'settlement', 'closed')) and public._r441_auto_at(:Q) is not null);

-- 3) locked: the layout is free, the plan is not
select pg_temp.login('a_admin@a.test');
select pg_temp.res('06 lock it', (pg_temp.j(format('select public.event_plan_lock_set(%L, true, %L)', :Q, 'Final')) ->> 'locked') = 'true');
create temp table _s as select pg_temp.try(format('select public.add_quote_version_checked(%L, null, ''{"items": []}''::jsonb, 0, 1, false)', :Q)) as a,
  pg_temp.try(format('select public.add_quote_version(%L, ''x'', ''{"items": []}''::jsonb, 0)', :Q)) as b; grant all on _s to authenticated;
select pg_temp.res('07 locked: the planner saves a new layout version (checked + old call)', (select a = '' and b = '' from _s) and (select count(*) = 3 from public.quote_versions where quote_id = :Q), (select a || b from _s));
create temp table _s2 as select pg_temp.try(format('select pg_temp.as_definer(%L)', format('update public.quotes set current_version = 1 where id = %L', :Q))) as a,
  pg_temp.try(format('update public.quotes set client = client || ''{"hallLen": 150, "venueWid": 90}''::jsonb where id = %L', :Q)) as b; grant all on _s2 to authenticated;
select pg_temp.res('08 locked: the current version and the hall size can be changed', (select a = '' and b = '' from _s2) and (select client ->> 'hallLen' = '150' and current_version = 1 from public.quotes where id = :Q), (select a || b from _s2));
select pg_temp.res('09 locked: new task, rename, time refused', pg_temp.try(format('insert into public.event_tasks(quote_id, category, title, seq, status) values (%L, ''Decor'', ''Arch'', 9, ''assigned'')', :Q)) like '%plan_locked%task plan%'
  and pg_temp.try('update public.event_tasks set title = ''x'' where id = ''a0000000-0000-4000-8000-00000000a441''') like '%plan_locked%'
  and pg_temp.try('select public.set_task_schedule(''a0000000-0000-4000-8000-00000000a441'', now() + interval ''10 days'', null, null)') like '%plan_locked%');
select pg_temp.res('10 locked: run-sheet add / change / remove refused', pg_temp.try(format('insert into public.run_sheet_items(quote_id, start_time, title, seq) values (%L, ''20:00'', ''Dinner'', 3)', :Q)) like '%plan_locked%run-sheet%'
  and pg_temp.try('update public.run_sheet_items set start_time = ''18:45'' where id = ''a0000000-0000-4000-8000-0000000e0441''') like '%plan_locked%'
  and pg_temp.try('delete from public.run_sheet_items where id = ''a0000000-0000-4000-8000-0000000e0441''') like '%plan_locked%');
select pg_temp.res('11 locked: Venue opens / Ready by refused', pg_temp.try(format('select public.event_day_plan_set(%L, ''09:00'', ''17:30'')', :Q)) like '%plan_locked%Ready by%');
select pg_temp.res('12 locked: status, reassigning, client phone still work', pg_temp.try('update public.event_tasks set status = ''accepted'', responded_at = now() where id = ''a0000000-0000-4000-8000-00000000a441''') = ''
  and pg_temp.try('update public.event_tasks set assignee_name = ''Kiran'' where id = ''a0000000-0000-4000-8000-00000000a441''') = ''
  and pg_temp.try(format('update public.quotes set client = client || ''{"phone": "9000000001"}''::jsonb where id = %L', :Q)) = '');

-- 4) who may unlock; an unlock days before is followed by the automatic lock
select pg_temp.login('a_sup441@a.test');
select pg_temp.res('13 a supervisor (no Quotes edit) cannot unlock', pg_temp.try(format('select public.event_plan_lock_set(%L, false, ''need it'')', :Q)) like '42501%');
select pg_temp.login('a_view441@a.test');
select pg_temp.res('14 a viewer cannot unlock, and cannot save a layout (the role check is not the lock)', pg_temp.try(format('select public.event_plan_lock_set(%L, false, ''need it'')', :Q)) like '42501%'
  and pg_temp.try(format('select public.add_quote_version(%L, ''x'', ''{"items": []}''::jsonb, 0)', :Q)) like '42501%');
select pg_temp.login('b_admin@b.test');
select pg_temp.res('15 another studio: not found, no layout', pg_temp.try(format('select public.event_plan_lock_set(%L, false, ''need it'')', :Q)) <> '' and pg_temp.try(format('select public.event_plan_lock_get(%L)', :Q)) like '%event not found%'
  and pg_temp.try(format('select public.add_quote_version(%L, ''x'', ''{"items": []}''::jsonb, 0)', :Q)) <> '');
select pg_temp.login('a_admin@a.test');
select pg_temp.res('16 no reason = refused', pg_temp.try(format('select public.event_plan_lock_set(%L, false, '' x '')', :Q)) like '%reason_required%');
create temp table _u as select pg_temp.j(format('select public.event_plan_lock_set(%L, false, ''too early'')', :Q)) as g; grant all on _u to authenticated;
select pg_temp.res('17 unlocked 10 days before: open, relocks, with the time', (select (g ->> 'locked') = 'false' and (g ->> 'relocks') = 'true' and g ->> 'auto_at' is not null from _u)
  and pg_temp.try('update public.event_tasks set title = ''Stage set-up 2'' where id = ''a0000000-0000-4000-8000-00000000a441''') = '', (select g::text from _u));
select pg_temp.su();
update public.quotes set lifecycle_stage = 'event_day' where id = :Q;
select pg_temp.res('18 ... and locks by itself again on the day', public._r397_locked(:Q));
select pg_temp.login('a_admin@a.test');
create temp table _u2 as select pg_temp.j(format('select public.event_plan_lock_set(%L, false, ''on the day'')', :Q)) as g; grant all on _u2 to authenticated;
select pg_temp.res('19 unlocked while the automatic lock applies: stays open (relocks false), tasks and times can be changed', (select (g ->> 'locked') = 'false' and (g ->> 'relocks') = 'false' from _u2)
  and pg_temp.try('update public.event_tasks set title = ''Stage set-up 3'' where id = ''a0000000-0000-4000-8000-00000000a441''') = ''
  and pg_temp.try('update public.run_sheet_items set start_time = ''18:45'' where id = ''a0000000-0000-4000-8000-0000000e0441''') = '', (select g::text from _u2));

-- 5) the event day, before the automatic lock has started (locked by hand, unlocked the same day)
select pg_temp.su();
select set_config('r441.before', case when (now() at time zone 'Asia/Kolkata')::time < time '22:59' then '1' else '' end, false);
select pg_temp.login('a_admin@a.test');
select pg_temp.j(format('select public.event_plan_lock_set(%L, true, null)', :D)) is not null as locked \gset
create temp table _l3 as select pg_temp.j(format('select public.event_plan_lock_get(%L)', :D)) as g; grant all on _l3 to authenticated;
create temp table _u3 as select pg_temp.j(format('select public.event_plan_lock_set(%L, false, ''morning change'')', :D)) as g; grant all on _u3 to authenticated;
select pg_temp.res('20 the event day: before the unlock the answer already says it will hold; after it: open, relocks false', (select (g ->> 'locked') = 'true' and (g ->> 'relocks') = 'false' from _l3)
  and (select (g ->> 'locked') = 'false' and (g ->> 'relocks') = 'false' from _u3), (select g::text from _u3));
select pg_temp.su();
update public.event_tasks set planned_start = now() - interval '1 minute' where id = 'a0000000-0000-4000-8000-00000000b441';
select pg_temp.res('21 ... also once the automatic lock starts (0397 alone locked it again); until someone locks it', not public._r397_locked(:D)
  and (public._r397_auto(:D) or current_setting('r441.before') = '' or (now() at time zone 'Asia/Kolkata')::time < time '00:01'));
select pg_temp.login('a_admin@a.test');
select pg_temp.res('22 lock again locks; the log has every step with who and why', (pg_temp.j(format('select public.event_plan_lock_set(%L, true, null)', :D)) ->> 'locked') = 'true'
  and jsonb_array_length(pg_temp.j(format('select public.event_plan_lock_get(%L)', :D)) -> 'history') = 3);

-- 6) a closed event still refuses a layout, the undo line
select pg_temp.j(format('select public.event_plan_lock_set(%L, true, null)', :Q)) is not null as l2 \gset
select pg_temp.su();
update public.quotes set lifecycle_stage = 'closed' where id = :Q;
select pg_temp.login('a_admin@a.test');
select pg_temp.res('23 closed: layout, current version, hall size refused in plain words', pg_temp.try(format('select public.add_quote_version(%L, ''x'', ''{"items": []}''::jsonb, 0)', :Q)) like '42501 This event is closed, so its floor plan%'
  and pg_temp.try(format('update public.quotes set client = client || ''{"hallLen": 99}''::jsonb where id = %L', :Q)) like '42501 This event is closed, so its hall size%');
select pg_temp.su();
update public.quotes set lifecycle_stage = 'planning' where id = :Q;
create or replace function public._r441_floor_in_lock() returns boolean language sql stable set search_path = '' as 'select true';
select pg_temp.login('a_admin@a.test');
select pg_temp.res('24 the one-line undo: the layout is in the lock again', pg_temp.try(format('select public.add_quote_version(%L, ''x'', ''{"items": []}''::jsonb, 0)', :Q)) like '%plan_locked%floor plan%'
  and pg_temp.try(format('update public.quotes set client = client || ''{"hallLen": 99}''::jsonb where id = %L', :Q)) like '%plan_locked%hall size%');

select pg_temp.su();
select name, result from _rc where result <> 'PASS' order by name;
select 'R256-LAYOUT-LOCK-0441: ' || case when count(*) filter (where result <> 'PASS') = 0 then 'ALL PASS' else 'FAIL' end || ' (' || count(*) filter (where result = 'PASS') || '/' || count(*) || ')' from _rc;
rollback;
