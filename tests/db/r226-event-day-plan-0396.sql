-- r226-event-day-plan-0396.sql - R226 (18 Nov 2026): the event day plan (Venue opens / Ready by / Day-before ticks), task
-- durations, the backward schedule, learned durations, the alert settings, the 5-minute bell job and Remind -> Bell.
-- Proves: structure (tables closed to the app, RLS on, grants), same-studio only, Staff view to read, Assign & send to save,
-- Controls edit for settings, the latest-start sums (buffer through the "needs first" chain, a loop never hangs), the
-- "starts in 1 hour" + latest-start alerts go ONCE and only to the people named (bell_feed), Remind -> Bell needs a login
-- and goes once per 5 min, nothing is deleted, re-apply safe. Local disposable PG only. Fake data only. Rolled back.
\set ON_ERROR_STOP 0
set client_min_messages = error;
begin;
\i supabase/migrations/0396_r226_event_day_plan.sql
\i supabase/migrations/0396_r226_event_day_plan.sql
set client_min_messages = warning;
create temp table _rc(name text, result text); grant all on _rc to anon, authenticated, service_role;
create temp table _rkv(k text primary key, v text); grant all on _rkv to anon, authenticated, service_role;
create or replace function pg_temp.su() returns void language plpgsql as $$
begin execute 'reset role'; perform auth.logout(); execute 'reset role'; end $$;
create or replace function pg_temp.login(p_email text) returns void language plpgsql as $$
declare u uuid; begin
  perform pg_temp.su(); select id into u from auth.users where email = p_email;
  perform set_config('request.jwt.claims', jsonb_build_object('sub', u, 'role', 'authenticated', 'email', p_email, 'aal', 'aal1')::text, false);
  perform set_config('role', 'authenticated', false);
end $$;
create or replace function pg_temp.anon() returns void language plpgsql as $$
begin perform pg_temp.su(); perform auth.login_anon(); end $$;
create or replace function pg_temp.res(p_name text, p_ok boolean, p_detail text default '') returns void language plpgsql as $$
begin insert into _rc values (p_name, case when coalesce(p_ok, false) then 'PASS' else 'FAIL: ' || coalesce(p_detail, '') end); end $$;
create or replace function pg_temp.try(p_sql text) returns text language plpgsql as $$
begin execute p_sql; return ''; exception when others then return sqlstate || ' ' || sqlerrm; end $$;
create or replace function pg_temp.j(p_sql text) returns jsonb language plpgsql as $$
declare v jsonb; begin execute p_sql into v; return v; exception when others then return jsonb_build_object('err', sqlstate || ' ' || sqlerrm); end $$;
create or replace function pg_temp.put(p_k text, p_v text) returns void language plpgsql as $$
begin insert into _rkv values (p_k, p_v) on conflict (k) do update set v = excluded.v; end $$;
create or replace function pg_temp.get(p_k text) returns text language sql as $$ select v from _rkv where k = p_k $$;
grant execute on function pg_temp.res(text, boolean, text), pg_temp.try(text), pg_temp.j(text), pg_temp.put(text, text), pg_temp.get(text)
  to anon, authenticated, service_role;

-- ---- fixture: a manager + a supervisor login in studio A, a sales person with no Staff access, three timed jobs ------------------
do $$
declare orgA uuid := 'a0000000-0000-4000-8000-000000000001'; qA uuid := 'a0000000-0000-4000-8000-00000000da01';
        u_mgr uuid; u_sup uuid; u_crew uuid; v_now timestamp := now() at time zone 'Asia/Kolkata';
begin
  u_mgr := auth.seed_user('a_mgr396@a.test'); u_sup := auth.seed_user('a_sup396@a.test'); u_crew := auth.seed_user('a_crew396@a.test');
  insert into public.profiles(id, email, full_name, role, org_id, must_change_password, created_at) values
    (u_mgr, 'a_mgr396@a.test', 'Meera Manager', 'manager', orgA, false, now()),
    (u_sup, 'a_sup396@a.test', 'Sunil Supervisor', 'supervisor', orgA, false, now()),
    (u_crew, 'a_crew396@a.test', 'Ravi Crew', 'crew', orgA, false, now())
  on conflict (id) do update set role = excluded.role, org_id = excluded.org_id, full_name = excluded.full_name;
  insert into public.role_access(role, area, can_view, can_edit, org_id, updated_at) values
    ('sales', 'staff', false, false, orgA, now()), ('sales', 'tasks', false, false, orgA, now()),
    ('manager', 'staff', true, true, orgA, now()), ('supervisor', 'staff', true, false, orgA, now()),
    ('supervisor', 'controls', true, false, orgA, now())
  on conflict (role, area, org_id) do update set can_view = excluded.can_view, can_edit = excluded.can_edit;
  -- the event: today (studio clock), guests arrive 30 minutes from now
  update public.quotes set event_date = (v_now + interval '30 minutes')::date, event_time = to_char(v_now + interval '30 minutes', 'HH24:MI'),
         status = 'confirmed', lifecycle_stage = 'event_day' where id = qA;
  insert into public.crew_members(id, org_id, name, phone, active, profile_id) values
    ('a0000000-0000-4000-8000-0000000c0396', orgA, 'Ravi Crew', '9000000396', true, u_crew),
    ('a0000000-0000-4000-8000-0000000c0397', orgA, 'Asha NoLogin', '9000000397', true, null);
  insert into public.event_tasks(id, quote_id, org_id, category, title, seq, status, crew_id, assignee_name) values
    ('a0000000-0000-4000-8000-00000000a396', qA, orgA, 'Stage', 'Stage set-up', 1, 'assigned', 'a0000000-0000-4000-8000-0000000c0396', 'Ravi Crew'),
    ('a0000000-0000-4000-8000-00000000b396', qA, orgA, 'Decor', 'Stage flowers', 2, 'accepted', 'a0000000-0000-4000-8000-0000000c0397', 'Asha NoLogin'),
    ('a0000000-0000-4000-8000-00000000c396', qA, orgA, 'Decor', 'Welcome board', 3, 'assigned', null, null);
  update public.event_tasks set depends_on = 'a0000000-0000-4000-8000-00000000a396' where id = 'a0000000-0000-4000-8000-00000000b396';
  -- a past event of the same studio: "Stage set-up" really took 100 and 140 minutes -> learned 120
  insert into public.quotes(id, code, title, status, client, pricing, current_version, approval_status, org_id, created_at, updated_at, event_date)
    values ('a0000000-0000-4000-8000-00000000da96', 'A-0396', 'Past wedding', 'confirmed', '{}'::jsonb, '{}'::jsonb, 1, 'approved', orgA, now(), now(), current_date - 30);
  insert into public.event_tasks(quote_id, org_id, category, title, seq, status, started_at, completed_at) values
    ('a0000000-0000-4000-8000-00000000da96', orgA, 'Stage', 'Stage set-up', 1, 'completed', now() - interval '30 days 3 hours', now() - interval '30 days 3 hours' + interval '100 minutes'),
    ('a0000000-0000-4000-8000-00000000da96', orgA, 'Stage', 'stage set-up ', 2, 'completed', now() - interval '30 days 6 hours', now() - interval '30 days 6 hours' + interval '140 minutes');
end $$;

-- ---- 1) structure ------------------------------------------------------------------------------------------------------------
select pg_temp.res('01 three new tables, RLS on, closed to anon / signed-in (server calls only)',
  (select bool_and(c.relrowsecurity) from pg_class c where c.oid in ('public.event_day_plans'::regclass, 'public.event_ready_alert_settings'::regclass, 'public.event_ready_alert_sends'::regclass))
  and not has_table_privilege('authenticated', 'public.event_day_plans', 'select')
  and not has_table_privilege('authenticated', 'public.event_ready_alert_sends', 'insert')
  and not has_table_privilege('anon', 'public.event_ready_alert_settings', 'select'));
select pg_temp.res('02 event_tasks.duration_min added (nullable, 1..1440), one check constraint after two runs',
  exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'event_tasks' and column_name = 'duration_min' and is_nullable = 'YES')
  and (select count(*) from pg_constraint where conname = 'event_tasks_duration_chk396') = 1);
select pg_temp.res('03 grants: page calls for signed-in only; the job + helpers server only',
  has_function_privilege('authenticated', 'public.event_day_plan_get(uuid)', 'execute')
  and not has_function_privilege('anon', 'public.event_day_plan_get(uuid)', 'execute')
  and not has_function_privilege('anon', 'public.event_task_remind_bell(uuid)', 'execute')
  and not has_function_privilege('authenticated', 'public.event_ready_alert_tick()', 'execute')
  and not has_function_privilege('authenticated', 'public._r396_bell(uuid,uuid,uuid,text,text,jsonb)', 'execute')
  and not has_function_privilege('authenticated', 'public._r396_schedule(uuid)', 'execute')
  and has_function_privilege('service_role', 'public.event_ready_alert_tick()', 'execute'));

-- ---- 2) Venue opens / Ready by -------------------------------------------------------------------------------------------------
select pg_temp.login('a_admin@a.test');
select pg_temp.put('set', pg_temp.j($q$select public.event_day_plan_set('a0000000-0000-4000-8000-00000000da01', '9 am', '5:00 pm')$q$)::text);
select pg_temp.res('04 admin saves Venue opens 9 am / Ready by 5 pm -> 09:00 / 17:00', (pg_temp.get('set')::jsonb ->> 'venue_access') = '09:00'
  and (pg_temp.get('set')::jsonb ->> 'ready_by') = '17:00', pg_temp.get('set'));
select pg_temp.res('05 nonsense time refused (invalid_time), nothing changed',
  pg_temp.try($q$select public.event_day_plan_set('a0000000-0000-4000-8000-00000000da01', 'soon', '17:00')$q$) like '%invalid_time%');
select pg_temp.login('b_admin@b.test');
select pg_temp.res('06 another studio: the event is not found (read and save)',
  pg_temp.try($q$select public.event_day_plan_get('a0000000-0000-4000-8000-00000000da01')$q$) like '%event not found%'
  and pg_temp.try($q$select public.event_day_plan_set('a0000000-0000-4000-8000-00000000da01', '', '')$q$) like '%event not found%');
select pg_temp.login('a_staff@a.test');
select pg_temp.res('07 a role without Staff access cannot read; without Assign & send cannot save',
  pg_temp.try($q$select public.event_day_plan_get('a0000000-0000-4000-8000-00000000da01')$q$) like '42501%'
  and pg_temp.try($q$select public.event_day_check_set('a0000000-0000-4000-8000-00000000da01', 'vendors', true)$q$) like '42501%');
select pg_temp.anon();
select pg_temp.res('08 anon refused', pg_temp.try($q$select public.event_day_plan_get('a0000000-0000-4000-8000-00000000da01')$q$) <> '');

-- ---- 3) Day-before ticks -------------------------------------------------------------------------------------------------------
select pg_temp.login('a_mgr396@a.test');
select pg_temp.put('tick', pg_temp.j($q$select public.event_day_check_set('a0000000-0000-4000-8000-00000000da01', 'headcount', true)$q$)::text);
select pg_temp.res('09 manager ticks "final head count" - done, by Meera Manager', (pg_temp.get('tick')::jsonb #>> '{item,done}') = 'true'
  and (pg_temp.get('tick')::jsonb #>> '{item,by}') = 'Meera Manager', pg_temp.get('tick'));
select pg_temp.j($q$select public.event_day_check_set('a0000000-0000-4000-8000-00000000da01', 'vendors', true)$q$);
select pg_temp.j($q$select public.event_day_check_set('a0000000-0000-4000-8000-00000000da01', 'vendors', false)$q$);
select pg_temp.su();
select pg_temp.res('10 an untick is kept (done false + who), the other tick and the times untouched',
  (select (p.checks #>> '{vendors,done}') = 'false' and (p.checks #>> '{headcount,done}') = 'true' and p.ready_by = '17:00' and p.venue_access = '09:00'
     from public.event_day_plans p where p.quote_id = 'a0000000-0000-4000-8000-00000000da01'));
select pg_temp.login('a_mgr396@a.test');
select pg_temp.res('11 an unknown checklist key is refused', pg_temp.try($q$select public.event_day_check_set('a0000000-0000-4000-8000-00000000da01', 'drop_table', true)$q$) like '%invalid_key%');

-- ---- 4) durations + the backward schedule -------------------------------------------------------------------------------------
select pg_temp.j($q$select public.event_task_duration_set('a0000000-0000-4000-8000-00000000a396', 120)$q$);
select pg_temp.j($q$select public.event_task_duration_set('a0000000-0000-4000-8000-00000000b396', 60)$q$);
select pg_temp.res('12a needs first: itself / another event / a loop refused; a good one saved',
  pg_temp.try($q$select public.event_task_duration_set('a0000000-0000-4000-8000-00000000a396', 120, 'a0000000-0000-4000-8000-00000000a396', true)$q$) like '%invalid_needs%'
  and pg_temp.try($q$select public.event_task_duration_set('a0000000-0000-4000-8000-00000000a396', 120, 'b0000000-0000-4000-8000-00000000da01', true)$q$) like '%invalid_needs%'
  and pg_temp.try($q$select public.event_task_duration_set('a0000000-0000-4000-8000-00000000a396', 120, 'a0000000-0000-4000-8000-00000000b396', true)$q$) like '%needs_loop%'
  and (pg_temp.j($q$select public.event_task_duration_set('a0000000-0000-4000-8000-00000000c396', null, 'a0000000-0000-4000-8000-00000000a396', true)$q$) ->> 'depends_on') = 'a0000000-0000-4000-8000-00000000a396'
  and (pg_temp.j($q$select public.event_task_duration_set('a0000000-0000-4000-8000-00000000c396', null, null, true)$q$) ->> 'ok') = 'true');
select pg_temp.res('12 out-of-range minutes refused', pg_temp.try($q$select public.event_task_duration_set('a0000000-0000-4000-8000-00000000b396', 0)$q$) like '%invalid_minutes%'
  and pg_temp.try($q$select public.event_task_duration_set('a0000000-0000-4000-8000-00000000b396', 2000)$q$) like '%invalid_minutes%');
select pg_temp.put('plan', pg_temp.j($q$select public.event_day_plan_get('a0000000-0000-4000-8000-00000000da01')$q$)::text);
-- Ready by 17:00 IST. Flowers (60 min + 15 % = 69) needs the stage first: flowers latest start 15:51, stage latest finish 15:51,
-- stage (120 + 15 % = 138) latest start 13:33. The welcome board has no duration -> not a timed job.
select pg_temp.res('13 schedule: flowers by 15:51, stage by 13:33 (finish 15:51), welcome board not timed',
  (select count(*) from jsonb_array_elements(pg_temp.get('plan')::jsonb -> 'schedule')) = 2
  and (select to_char(((x ->> 'latest_start')::timestamptz) at time zone 'Asia/Kolkata', 'HH24:MI') from jsonb_array_elements(pg_temp.get('plan')::jsonb -> 'schedule') x
        where x ->> 'task_id' = 'a0000000-0000-4000-8000-00000000b396') = '15:51'
  and (select to_char(((x ->> 'latest_start')::timestamptz) at time zone 'Asia/Kolkata', 'HH24:MI') || '/' || to_char(((x ->> 'latest_finish')::timestamptz) at time zone 'Asia/Kolkata', 'HH24:MI')
         from jsonb_array_elements(pg_temp.get('plan')::jsonb -> 'schedule') x where x ->> 'task_id' = 'a0000000-0000-4000-8000-00000000a396') = '13:33/15:51',
  pg_temp.get('plan'));
select pg_temp.res('14 learned: "Stage set-up" took 120 min (middle of 100 and 140) on 2 past events; no money keys in the answer',
  exists (select 1 from jsonb_array_elements(pg_temp.get('plan')::jsonb -> 'learned') x where x ->> 'title' = 'stage set-up' and (x ->> 'minutes')::int = 120 and (x ->> 'n')::int = 2)
  and pg_temp.get('plan') !~* '(price|total|amount|pricing|subtotal)', pg_temp.get('plan'));
select pg_temp.res('15 can_edit true for the manager; settings default (on, 60 min, manager + supervisor, 30 min, 15 %)',
  (pg_temp.get('plan')::jsonb ->> 'can_edit') = 'true' and (pg_temp.get('plan')::jsonb #>> '{settings,hour_before_min}') = '60'
  and (pg_temp.get('plan')::jsonb #>> '{settings,buffer_pct}') = '15' and (pg_temp.get('plan')::jsonb -> 'settings' -> 'notify_roles') = '["manager", "supervisor"]'::jsonb);
-- a loop in the links (stage needs flowers, flowers needs stage) never hangs: both timed from Ready by
select pg_temp.su();
update public.event_tasks set depends_on = 'a0000000-0000-4000-8000-00000000b396' where id = 'a0000000-0000-4000-8000-00000000a396';
select pg_temp.res('16 a loop in "needs first" -> both from Ready by (stage 14:42, flowers 15:51)',
  (select string_agg(to_char(s.latest_start at time zone 'Asia/Kolkata', 'HH24:MI'), ',' order by s.latest_start) from public._r396_schedule('a0000000-0000-4000-8000-00000000da01') s) = '14:42,15:51');
update public.event_tasks set depends_on = null where id = 'a0000000-0000-4000-8000-00000000a396';

-- ---- 5) settings -------------------------------------------------------------------------------------------------------------
select pg_temp.login('a_sup396@a.test');
select pg_temp.res('17 supervisor (Controls - Can see) reads the settings, cannot change them',
  (pg_temp.j($q$select public.event_ready_settings_get()$q$) ->> 'can_edit') = 'false'
  and pg_temp.try($q$select public.event_ready_settings_set('{"buffer_pct": 20}'::jsonb)$q$) like '42501%');
select pg_temp.login('a_admin@a.test');
select pg_temp.res('18 admin: buffer 500 refused, buffer 20 saved', pg_temp.try($q$select public.event_ready_settings_set('{"buffer_pct": 500}'::jsonb)$q$) like '%invalid_settings%'
  and (pg_temp.j($q$select public.event_ready_settings_set('{"buffer_pct": 20}'::jsonb)$q$) ->> 'buffer_pct') = '20');
select pg_temp.j($q$select public.event_ready_settings_set('{"buffer_pct": 15}'::jsonb)$q$);
select pg_temp.login('b_admin@b.test');
select pg_temp.res('19 the other studio still has the defaults (its own row only)', (pg_temp.j($q$select public.event_ready_settings_get()$q$) ->> 'saved') = 'false');

-- ---- 6) the 5-minute job ---------------------------------------------------------------------------------------------------------
-- clear Ready by -> it falls back to 1 h before Guests arrive (= 30 min ago): both jobs' latest starts have passed
select pg_temp.login('a_admin@a.test');
select pg_temp.j($q$select public.event_day_plan_set('a0000000-0000-4000-8000-00000000da01', '09:00', '')$q$);
select pg_temp.su();
create temp table _n0 as select id from public.notifications;
select pg_temp.put('tick1', public.event_ready_alert_tick()::text);
select pg_temp.res('20 job: one "starts in" alert + two "not started" red alerts (bell, kind task_escalated, via 0396)',
  (select count(*) from public.notifications n where n.id not in (select id from _n0) and n.kind = 'task_escalated' and n.detail ->> 'source' = '0396' and n.detail ->> 'via' = 'ready_check') = 1
  and (select count(*) from public.notifications n where n.id not in (select id from _n0) and n.detail ->> 'via' = 'latest_late') = 2,
  'tick=' || pg_temp.get('tick1'));
select pg_temp.res('21 "Event starts in 30 min - ready? 0/3 done (A-0001)" names managers + supervisors, not the admin / sales / crew',
  (select n.detail ->> 'label' from public.notifications n where n.id not in (select id from _n0) and n.detail ->> 'via' = 'ready_check') ~ '^Event starts in (29|30|31) min - ready\? 0/3 done'
  and (select (n.detail -> 'notify') ? (select id::text from auth.users where email = 'a_mgr396@a.test')
            and (n.detail -> 'notify') ? (select id::text from auth.users where email = 'a_sup396@a.test')
            and not (n.detail -> 'notify') ? (select id::text from auth.users where email = 'a_admin@a.test')
            and not (n.detail -> 'notify') ? (select id::text from auth.users where email = 'a_staff@a.test')
            and not (n.detail -> 'notify') ? (select id::text from auth.users where email = 'a_crew396@a.test')
         from public.notifications n where n.id not in (select id from _n0) and n.detail ->> 'via' = 'ready_check'),
  (select n.detail::text from public.notifications n where n.id not in (select id from _n0) and n.detail ->> 'via' = 'ready_check'));
select pg_temp.res('22 a second run sends nothing again', public.event_ready_alert_tick() = 0
  and (select count(*) from public.notifications n where n.id not in (select id from _n0) and n.detail ->> 'source' = '0396') = 3);
select pg_temp.login('a_mgr396@a.test');
select pg_temp.res('23 the manager sees the alerts in the bell',
  (select count(*) from jsonb_array_elements(public.bell_feed(50) -> 'items') i where i #>> '{detail,source}' = '0396') >= 1);
select pg_temp.login('a_admin@a.test');
select pg_temp.res('24 the admin (not named) does not see them', not exists (select 1 from jsonb_array_elements(public.bell_feed(50) -> 'items') i where i #>> '{detail,source}' = '0396'));
-- switched off -> nothing
select pg_temp.j($q$select public.event_ready_settings_set('{"enabled": false}'::jsonb)$q$);
select pg_temp.su();
delete from public.event_ready_alert_sends where quote_id = 'a0000000-0000-4000-8000-00000000da01';   -- test only: forget the sends
select pg_temp.res('25 studio switch off -> the job sends nothing', public.event_ready_alert_tick() = 0);

-- ---- 7) Remind -> Bell ----------------------------------------------------------------------------------------------------------
select pg_temp.login('a_mgr396@a.test');
select pg_temp.put('b1', pg_temp.j($q$select public.event_task_remind_bell('a0000000-0000-4000-8000-00000000a396')$q$)::text);
select pg_temp.put('b2', pg_temp.j($q$select public.event_task_remind_bell('a0000000-0000-4000-8000-00000000a396')$q$)::text);
select pg_temp.put('b3', pg_temp.j($q$select public.event_task_remind_bell('a0000000-0000-4000-8000-00000000b396')$q$)::text);
select pg_temp.res('26 Bell: ok for a login, just_sent the second time, no_login for a person without one',
  (pg_temp.get('b1')::jsonb ->> 'ok') = 'true' and (pg_temp.get('b2')::jsonb ->> 'reason') = 'just_sent' and (pg_temp.get('b3')::jsonb ->> 'reason') = 'no_login',
  pg_temp.get('b1') || pg_temp.get('b2') || pg_temp.get('b3'));
select pg_temp.su();
select pg_temp.res('27 the bell reminder names only that person',
  (select n.detail -> 'notify' from public.notifications n where n.detail ->> 'via' = 'office_reminder' order by n.created_at desc limit 1)
    = jsonb_build_array((select id::text from auth.users where email = 'a_crew396@a.test')));
select pg_temp.login('b_admin@b.test');
select pg_temp.res('28 another studio cannot ring the bell on studio A tasks', pg_temp.try($q$select public.event_task_remind_bell('a0000000-0000-4000-8000-00000000a396')$q$) like '%event not found%');

-- ---- 8) nothing lost ------------------------------------------------------------------------------------------------------------
select pg_temp.su();
select pg_temp.res('29 tasks untouched apart from duration (titles, status, people, times)',
  (select count(*) from public.event_tasks where quote_id = 'a0000000-0000-4000-8000-00000000da01') = 3
  and (select status from public.event_tasks where id = 'a0000000-0000-4000-8000-00000000a396') = 'assigned'
  and (select crew_id from public.event_tasks where id = 'a0000000-0000-4000-8000-00000000b396') = 'a0000000-0000-4000-8000-0000000c0397');
\i supabase/migrations/0396_r226_event_day_plan.sql
select pg_temp.res('30 re-apply keeps the saved plan, durations and settings',
  (select checks #>> '{headcount,done}' from public.event_day_plans where quote_id = 'a0000000-0000-4000-8000-00000000da01') = 'true'
  and (select duration_min from public.event_tasks where id = 'a0000000-0000-4000-8000-00000000a396') = 120
  and (select enabled from public.event_ready_alert_settings where org_id = 'a0000000-0000-4000-8000-000000000001') = false);

select pg_temp.res('31 free-trial retention: event rows purged, settings kept; anon runs no 0396 function',
  array['event_day_plans', 'event_ready_alert_sends']::text[] <@ public._tr184_purge_tables() and 'event_ready_alert_settings' = any (public._tr184_keep_tables())
  and not has_function_privilege('anon', 'public._r396_check_keys()', 'execute') and not has_function_privilege('anon', 'public._r396_hhmm(text)', 'execute'));

select name, result from _rc order by name;
select case when (select count(*) from _rc where result <> 'PASS') = 0
            then 'R226-EVENT-DAY-PLAN-0396: ALL PASS (' || (select count(*) from _rc) || '/' || (select count(*) from _rc) || ')'
            else 'R226-EVENT-DAY-PLAN-0396: FAILURES' end as summary;
rollback;
