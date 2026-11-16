-- r174-event-day-board-0365.sql - R174: crew_schedule day in the studio time zone, live_events_today (event-day progress for
-- the home card and the Calendar "Live today" tab), crew_unavailable_conflicts (work given on a day marked unavailable).
-- Proves: (1) privileges (anon refused everywhere); (2) a task at 01:30 India time is on THAT India day in crew_schedule (it
-- used to land on the previous UTC day); (3) live_events_today counts every status right, flags late tasks, lists them,
-- shows the latest activity, and never shows another studio; (4) crew_unavailable_conflicts lists a person given work on a
-- day they marked unavailable, own studio only; (5) re-run safe.
-- Re-applies 0365 twice. Local disposable PG only. Fake data only. Rolled back.
\set ON_ERROR_STOP 0
set client_min_messages = error;
\ir ../../supabase/migrations/0365_r174_event_day_board.sql
\ir ../../supabase/migrations/0365_r174_event_day_board.sql
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

-- fixture: studio A in India time, a live event TODAY (India day), four staff, tasks in every state
update public.organizations set timezone = 'Asia/Kolkata' where id = 'a0000000-0000-4000-8000-000000000001';
create temp table _d as select (now() at time zone 'Asia/Kolkata')::date as today;
grant select on _d to anon, authenticated, service_role;
update public.quotes set deleted_at = null, status = 'confirmed', title = 'Rao Wedding', event_date = (select today from _d),
       lifecycle_stage = null, is_demo = false
 where id = 'a0000000-0000-4000-8000-00000000da01';
insert into public.crew_members (id, name, phone, email, org_id) values
  ('a0000000-0000-4000-8000-0000000c3741', 'Ravi Desk',  '+91 90000 37411', 'ravi74@example.org',  'a0000000-0000-4000-8000-000000000001'),
  ('a0000000-0000-4000-8000-0000000c3742', 'Sita Cater', '+91 90000 37412', 'sita74@example.org',  'a0000000-0000-4000-8000-000000000001'),
  ('a0000000-0000-4000-8000-0000000c3743', 'Arun Lights','+91 90000 37413', 'arun74@example.org',  'a0000000-0000-4000-8000-000000000001'),
  ('a0000000-0000-4000-8000-0000000c3744', 'Night Crew', '+91 90000 37414', 'night74@example.org', 'a0000000-0000-4000-8000-000000000001');
insert into public.event_tasks (id, quote_id, org_id, category, title, crew_id, assignee_name, assignee_phone, status, planned_start,
                                responded_at, started_at, completed_at) values
  -- done
  ('a0000000-0000-4000-8000-0000000f3741', 'a0000000-0000-4000-8000-00000000da01', 'a0000000-0000-4000-8000-000000000001', 'Decor', 'Backdrop florals',
   'a0000000-0000-4000-8000-0000000c3741', 'Ravi Desk', '+91 90000 37411', 'completed', now() - interval '3 hours',
   now() - interval '4 hours', now() - interval '3 hours', now() - interval '1 hour'),
  -- started
  ('a0000000-0000-4000-8000-0000000f3742', 'a0000000-0000-4000-8000-00000000da01', 'a0000000-0000-4000-8000-000000000001', 'Catering', 'Welcome drinks',
   'a0000000-0000-4000-8000-0000000c3742', 'Sita Cater', '+91 90000 37412', 'in_progress', now() - interval '20 minutes',
   now() - interval '2 hours', now() - interval '10 minutes', null),
  -- accepted, start passed, not started = LATE
  ('a0000000-0000-4000-8000-0000000f3743', 'a0000000-0000-4000-8000-00000000da01', 'a0000000-0000-4000-8000-000000000001', 'Lighting', 'Stage lights',
   'a0000000-0000-4000-8000-0000000c3743', 'Arun Lights', '+91 90000 37413', 'accepted', now() - interval '15 minutes',
   now() - interval '1 hour', null, null),
  -- waiting for a yes, starts later (not late)
  ('a0000000-0000-4000-8000-0000000f3744', 'a0000000-0000-4000-8000-00000000da01', 'a0000000-0000-4000-8000-000000000001', 'Lighting', 'Dance floor lights',
   'a0000000-0000-4000-8000-0000000c3743', 'Arun Lights', '+91 90000 37413', 'assigned', now() + interval '2 hours',
   null, null, null),
  -- turned down
  ('a0000000-0000-4000-8000-0000000f3745', 'a0000000-0000-4000-8000-00000000da01', 'a0000000-0000-4000-8000-000000000001', 'Catering', 'Plate count',
   'a0000000-0000-4000-8000-0000000c3742', 'Sita Cater', '+91 90000 37412', 'rejected', now() + interval '1 hour',
   now() - interval '30 minutes', null, null),
  -- cancelled: never counted
  ('a0000000-0000-4000-8000-0000000f3746', 'a0000000-0000-4000-8000-00000000da01', 'a0000000-0000-4000-8000-000000000001', 'Decor', 'Old task',
   'a0000000-0000-4000-8000-0000000c3741', 'Ravi Desk', '+91 90000 37411', 'cancelled', now(), null, null, null),
  -- 01:30 India time tomorrow (= 20:00 UTC today): the schedule must put it on TOMORROW (India day)
  ('a0000000-0000-4000-8000-0000000f3747', 'a0000000-0000-4000-8000-00000000da01', 'a0000000-0000-4000-8000-000000000001', 'Decor', 'Night set-up',
   'a0000000-0000-4000-8000-0000000c3744', 'Night Crew', '+91 90000 37414', 'assigned',
   ((select today from _d) + 1 + time '01:30') at time zone 'Asia/Kolkata', null, null, null);
insert into public.crew_checkins (org_id, quote_id, crew_id, work_day, check_in_at, source) values
  ('a0000000-0000-4000-8000-000000000001', 'a0000000-0000-4000-8000-00000000da01', 'a0000000-0000-4000-8000-0000000c3742',
   (select today from _d), now() - interval '1 hour', 'crew');
-- Arun marked TODAY as cannot work (but has two tasks today)
insert into public.crew_availability (org_id, crew_id, day, status, note, source) values
  ('a0000000-0000-4000-8000-000000000001', 'a0000000-0000-4000-8000-0000000c3743', (select today from _d), 'unavailable', 'family function', 'crew');

-- ---- 1) privileges ------------------------------------------------------------------------------------------------------------
select pg_temp.t('1a anon cannot read the live board', pg_temp.as_val('anon', 'select public.live_events_today(24)::text') like '42501%');
select pg_temp.t('1b anon cannot read unavailable conflicts', pg_temp.as_val('anon', $q$select public.crew_unavailable_conflicts(current_date, current_date + 5)::text$q$) like '42501%');
select pg_temp.t('1c anon cannot read the schedule', pg_temp.as_val('anon', $q$select count(*)::text from public.crew_schedule(current_date, current_date + 5)$q$) like '42501%');

-- ---- 2) schedule day in the studio time zone -----------------------------------------------------------------------------------
select pg_temp.t('2a a 01:30 India task is on that India day',
  pg_temp.as_val('a_admin@a.test', $q$select sched_date::text from public.crew_schedule((select today from _d), (select today from _d) + 2)
                                     where task_id = 'a0000000-0000-4000-8000-0000000f3747'$q$) = 'ok:' || ((select today from _d) + 1)::text,
  pg_temp.as_val('a_admin@a.test', $q$select sched_date::text from public.crew_schedule((select today from _d), (select today from _d) + 2)
                                     where task_id = 'a0000000-0000-4000-8000-0000000f3747'$q$));
select pg_temp.t('2b ... and NOT in a range that ends the day before',
  pg_temp.as_val('a_admin@a.test', $q$select count(*)::text from public.crew_schedule((select today from _d) - 1, (select today from _d))
                                     where task_id = 'a0000000-0000-4000-8000-0000000f3747'$q$) = 'ok:0');

-- ---- 3) live_events_today --------------------------------------------------------------------------------------------------------
create temp table _lv as select null::jsonb as j; grant all on _lv to anon, authenticated, service_role;
select auth.login_as((select id from auth.users where email = 'a_admin@a.test'));
update _lv set j = (select e from jsonb_array_elements(public.live_events_today(24) -> 'events') e
                    where e ->> 'quote_id' = 'a0000000-0000-4000-8000-00000000da01');
select auth.logout(); reset role;
select pg_temp.t('3a today''s event is on the board', (select j is not null from _lv));
select pg_temp.t('3b counts: 6 live tasks (cancelled not counted)', (select (j ->> 'total')::int = 6 from _lv), (select j ->> 'total' from _lv));
select pg_temp.t('3c done 1, started 1, accepted 1, waiting 2, turned down 1',
  (select (j->>'done')::int = 1 and (j->>'started')::int = 1 and (j->>'accepted')::int = 1 and (j->>'waiting')::int = 2 and (j->>'rejected')::int = 1 from _lv),
  (select j::text from _lv));
select pg_temp.t('3d one late task: Stage lights', (select (j->>'late')::int = 1 and j->'late_tasks'->0->>'title' = 'Stage lights'
  and j->'late_tasks'->0->>'who' = 'Arun Lights' from _lv), (select (j->'late_tasks')::text from _lv));
select pg_temp.t('3e staff 4, confirmed 3, checked in 1', (select (j->>'staff')::int = 4 and (j->>'staff_confirmed')::int = 3 and (j->>'checked_in')::int = 1 from _lv),
  (select j::text from _lv));
select pg_temp.t('3f latest activity = Sita started Welcome drinks', (select j->'last'->>'kind' = 'started' and j->'last'->>'who' = 'Sita Cater'
  and j->'last'->>'title' = 'Welcome drinks' from _lv), (select (j->'last')::text from _lv));
select pg_temp.t('3g marked as today', (select (j->>'is_today')::boolean from _lv));
select pg_temp.t('3h another studio sees none of it',
  pg_temp.as_val('b_admin@b.test', $q$select count(*)::text from jsonb_array_elements(public.live_events_today(24)->'events') e
                                    where e->>'quote_id' = 'a0000000-0000-4000-8000-00000000da01'$q$) = 'ok:0');
select pg_temp.t('3i hours are capped (1..72)', pg_temp.as_val('a_admin@a.test', 'select (public.live_events_today(500)->>''hours'')') = 'ok:72');

-- ---- 4) unavailable-day conflicts ------------------------------------------------------------------------------------------------
select pg_temp.t('4a Arun is listed: given work on a day marked cannot work',
  pg_temp.as_val('a_admin@a.test', $q$select (x->>'name') || '|' || (x->>'note') || '|' || (x->'events'->0->>'code')
     from jsonb_array_elements(public.crew_unavailable_conflicts((select today from _d) - 1, (select today from _d) + 1)) x
     where x->>'crew_id' = 'a0000000-0000-4000-8000-0000000c3743'$q$) like 'ok:Arun Lights|family function|%');
select pg_temp.t('4b nobody else is listed', pg_temp.as_val('a_admin@a.test', $q$select count(*)::text
     from jsonb_array_elements(public.crew_unavailable_conflicts((select today from _d) - 1, (select today from _d) + 1)) x$q$) = 'ok:1');
select pg_temp.t('4c another studio sees none of it', pg_temp.as_val('b_admin@b.test', $q$select count(*)::text
     from jsonb_array_elements(public.crew_unavailable_conflicts((select today from _d) - 1, (select today from _d) + 1)) x
     where x->>'crew_id' = 'a0000000-0000-4000-8000-0000000c3743'$q$) = 'ok:0');
select pg_temp.t('4d a range over 92 days is refused', pg_temp.as_val('a_admin@a.test', 'select public.crew_unavailable_conflicts(current_date, current_date + 120)::text') like '22023%');

-- ---- 5) re-run safe -------------------------------------------------------------------------------------------------------------
select pg_temp.t('5a schedule body is the R174 one (no UTC day)', position('r174-0365' in pg_get_functiondef(to_regprocedure('public.crew_schedule(date,date,uuid)'))) > 0
  and position('UTC' in pg_get_functiondef(to_regprocedure('public.crew_schedule(date,date,uuid)'))) = 0);
do $$ declare n int; f int; r record; begin
  select count(*), count(*) filter (where result <> 'PASS') into n, f from _rs;
  for r in select * from _rs where result <> 'PASS' loop raise warning '% -> %', r.name, r.result; end loop;
  if f = 0 then raise warning 'R174-EVENT-DAY-BOARD-0365: ALL PASS (%/%)', n, n;
  else raise warning 'R174-EVENT-DAY-BOARD-0365: % FAILED of %', f, n; end if;
end $$;
rollback;
