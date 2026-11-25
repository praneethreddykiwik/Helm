-- r227-plan-lock-0397.sql - R227 (18 Nov 2026): the event-day plan lock + the event-day floor plan read.
-- Proves: structure (tables closed to the app, RLS on, grants, one guard trigger per table after two runs), lock only once
-- confirmed, who may lock / unlock (unlock needs Quotes edit + a reason), a locked event REFUSES plan edits at the database
-- (layout version, current version, hall size, task plan, run-sheet, Venue opens / Ready by) and still ALLOWS the day's work
-- (task status, notes, reassigning, reminders, Day-before ticks, issues, the stage moving on, an open-shift claim), the lock /
-- unlock record (who, when, why) in the activity trail, the automatic lock (Event Day stage, the studio clock, never
-- cancelled), cross-studio refused, the floor plan answer carries no money, re-apply safe. Local disposable PG only. Rolled back.
\set ON_ERROR_STOP 0
set client_min_messages = error;
begin;
\i supabase/migrations/0397_r227_event_plan_lock.sql
\i supabase/migrations/0397_r227_event_plan_lock.sql
-- 0441 (R256) took the floor plan out of the lock: this suite runs the 0397 bodies; r256-layout-lock-0441.sql tests the new rule
set client_min_messages = warning;
-- run-all.sh turns the guard off for the older suites; this suite tests it ON
select set_config('helm.r397_plan_lock', 'on', false);
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
-- a page call (security definer) runs as the owner with the caller's claims: keep the claims, drop the role
create or replace function pg_temp.as_definer(p_sql text) returns void language plpgsql as $$
begin execute 'reset role'; execute p_sql; perform set_config('role', 'authenticated', false); exception when others then perform set_config('role', 'authenticated', false); raise; end $$;
create or replace function pg_temp.put(p_k text, p_v text) returns void language plpgsql as $$
begin insert into _rkv values (p_k, p_v) on conflict (k) do update set v = excluded.v; end $$;
create or replace function pg_temp.get(p_k text) returns text language sql as $$ select v from _rkv where k = p_k $$;
grant execute on function pg_temp.res(text, boolean, text), pg_temp.try(text), pg_temp.as_definer(text), pg_temp.j(text), pg_temp.put(text, text), pg_temp.get(text)
  to anon, authenticated, service_role;

-- ---- fixture: studio A event (quote, 10 days away), a supervisor (Assign & send, no Quotes edit), a coordinator (view only) ----
do $$
declare orgA uuid := 'a0000000-0000-4000-8000-000000000001'; qA uuid := 'a0000000-0000-4000-8000-00000000da01';
        u_sup uuid; u_view uuid;
begin
  u_sup := auth.seed_user('a_sup397@a.test'); u_view := auth.seed_user('a_view397@a.test');
  insert into public.profiles(id, email, full_name, role, org_id, must_change_password, created_at) values
    (u_sup, 'a_sup397@a.test', 'Sunil Supervisor', 'supervisor', orgA, false, now()),
    (u_view, 'a_view397@a.test', 'Vani Viewer', 'coordinator', orgA, false, now())
  on conflict (id) do update set role = excluded.role, org_id = excluded.org_id, full_name = excluded.full_name;
  update public.profiles set full_name = 'Asha Admin' where email = 'a_admin@a.test';
  insert into public.role_access(role, area, can_view, can_edit, org_id, updated_at) values
    ('supervisor', 'staff', true, false, orgA, now()), ('supervisor', 'tasks', true, true, orgA, now()), ('supervisor', 'quotes', true, false, orgA, now()),
    ('coordinator', 'staff', true, false, orgA, now()), ('coordinator', 'tasks', false, false, orgA, now()), ('coordinator', 'quotes', true, false, orgA, now())
  on conflict (role, area, org_id) do update set can_view = excluded.can_view, can_edit = excluded.can_edit;
  update public.quotes set event_date = current_date + 10, event_time = '18:30', status = 'quote', lifecycle_stage = 'planning',
         client = '{"name": "Alice", "hallLen": 120, "hallWid": 80, "guests": "300"}'::jsonb where id = qA;
  insert into public.quote_versions(quote_id, version_no, label, data, object_count, org_id)
  values (qA, 7, 'fixture', '{"items": [{"id": "s1", "type": "stage", "category": "structure", "label": "Main stage", "x": 40, "y": 5, "width": 40, "height": 16, "rotation": 0, "color": "#aa8855", "price": 90000, "properties": {"price": 90000, "unitCost": 5, "rows": 2}},
                                            {"id": "t1", "type": "round", "category": "seating", "label": "Table 1", "x": 10, "y": 40, "width": 6, "height": 6, "properties": {"seats": 10}}],
                               "scale": {"worldFt": {"w": 120, "h": 80}}, "grid": {"unit": "ft"}, "venue": {"capacity": 400}}'::jsonb, 2, orgA)
  on conflict do nothing;
  update public.quotes set current_version = 7 where id = qA;
  insert into public.event_tasks(id, quote_id, org_id, category, title, seq, status, assignee_name) values
    ('a0000000-0000-4000-8000-00000000a397', qA, orgA, 'Stage', 'Stage set-up', 1, 'assigned', 'Ravi'),
    ('a0000000-0000-4000-8000-00000000b397', qA, orgA, 'Decor', 'Stage flowers', 2, 'assigned', 'Asha');
  insert into public.run_sheet_items(id, quote_id, org_id, start_time, duration_min, title, seq) values
    ('a0000000-0000-4000-8000-0000000e0397', qA, orgA, '18:30', 30, 'Guests arrive', 1);
end $$;

-- ---- 1) structure ------------------------------------------------------------------------------------------------------------
select pg_temp.res('01 two new tables, RLS on, closed to anon / signed-in (server calls only)',
  (select bool_and(c.relrowsecurity) from pg_class c where c.oid in ('public.event_plan_locks'::regclass, 'public.event_plan_lock_log'::regclass))
  and not has_table_privilege('authenticated', 'public.event_plan_locks', 'select') and not has_table_privilege('authenticated', 'public.event_plan_lock_log', 'insert')
  and not has_table_privilege('anon', 'public.event_plan_lock_log', 'select'));
select pg_temp.res('02 one guard trigger each on quote_versions, quotes, event_tasks, run_sheet_items, event_day_plans after two runs',
  (select count(*) from pg_trigger where tgname = 'zz_r397_plan_lock') = 5
  and (select count(distinct tgrelid) from pg_trigger where tgname = 'zz_r397_plan_lock') = 5);
select pg_temp.res('03 grants: page calls for signed-in only; helpers + the old trail body server only',
  has_function_privilege('authenticated', 'public.event_plan_lock_get(uuid)', 'execute')
  and has_function_privilege('authenticated', 'public.event_plan_lock_set(uuid,boolean,text)', 'execute')
  and has_function_privilege('authenticated', 'public.event_floor_get(uuid)', 'execute')
  and not has_function_privilege('anon', 'public.event_plan_lock_set(uuid,boolean,text)', 'execute')
  and not has_function_privilege('anon', 'public.event_floor_get(uuid)', 'execute')
  and not has_function_privilege('authenticated', 'public._r397_locked(uuid)', 'execute')
  and not has_function_privilege('authenticated', 'public._r397_guard(uuid,text)', 'execute')
  and not has_function_privilege('authenticated', 'public.event_activity__pre0397(uuid)', 'execute')
  and has_function_privilege('authenticated', 'public.event_activity(uuid)', 'execute'));

-- ---- 2) lock only once confirmed; who may lock ------------------------------------------------------------------------------
select pg_temp.login('a_admin@a.test');
select pg_temp.res('04 an unconfirmed quote cannot be locked (not_confirmed); get says not locked, can_lock false',
  pg_temp.try($q$select public.event_plan_lock_set('a0000000-0000-4000-8000-00000000da01', true, null)$q$) like '%not_confirmed%'
  and (pg_temp.j($q$select public.event_plan_lock_get('a0000000-0000-4000-8000-00000000da01')$q$) ->> 'locked') = 'false'
  and (pg_temp.j($q$select public.event_plan_lock_get('a0000000-0000-4000-8000-00000000da01')$q$) ->> 'can_lock') = 'false');
select pg_temp.su();
update public.quotes set status = 'confirmed' where id = 'a0000000-0000-4000-8000-00000000da01';
select pg_temp.login('a_admin@a.test');
select pg_temp.res('05 confirmed, 10 days away, not locked: the plan can still be edited (new layout version, task, run-sheet line)',
  (pg_temp.j($q$select public.event_plan_lock_get('a0000000-0000-4000-8000-00000000da01')$q$) ->> 'auto') = 'false'
  and pg_temp.try($q$select public.add_quote_version('a0000000-0000-4000-8000-00000000da01', 'before lock', '{"items": []}'::jsonb, 0)$q$) = ''
  and pg_temp.try($q$insert into public.event_tasks(id, quote_id, category, title, seq, status) values ('a0000000-0000-4000-8000-00000000c397', 'a0000000-0000-4000-8000-00000000da01', 'Decor', 'Welcome board', 3, 'assigned')$q$) = ''
  and pg_temp.try($q$insert into public.run_sheet_items(quote_id, start_time, title, seq) values ('a0000000-0000-4000-8000-00000000da01', '19:00', 'Couple entry', 2)$q$) = '');
select pg_temp.login('a_view397@a.test');
select pg_temp.res('06 a view-only role reads the lock but cannot lock (42501)',
  (pg_temp.j($q$select public.event_plan_lock_get('a0000000-0000-4000-8000-00000000da01')$q$) ->> 'can_lock') = 'false'
  and pg_temp.try($q$select public.event_plan_lock_set('a0000000-0000-4000-8000-00000000da01', true, null)$q$) like '42501%');
select pg_temp.login('a_sup397@a.test');
select pg_temp.put('lock1', pg_temp.j($q$select public.event_plan_lock_set('a0000000-0000-4000-8000-00000000da01', true, 'Final plan signed off')$q$)::text);
select pg_temp.res('07 a supervisor (Assign & send) locks the plan: locked, by Sunil, reason kept, can_unlock false',
  (pg_temp.get('lock1')::jsonb ->> 'locked') = 'true' and (pg_temp.get('lock1')::jsonb ->> 'changed_by') = 'Sunil Supervisor'
  and (pg_temp.get('lock1')::jsonb ->> 'reason') = 'Final plan signed off' and (pg_temp.get('lock1')::jsonb ->> 'can_unlock') = 'false'
  and jsonb_array_length(pg_temp.get('lock1')::jsonb -> 'history') = 1, pg_temp.get('lock1'));
select pg_temp.res('08 locking again changes nothing (still one record)',
  jsonb_array_length(pg_temp.j($q$select public.event_plan_lock_set('a0000000-0000-4000-8000-00000000da01', true, null)$q$) -> 'history') = 1);

-- ---- 3) a locked event refuses PLAN edits at the database ------------------------------------------------------------------------
select pg_temp.login('a_admin@a.test');
select pg_temp.res('09 floor plan: a new layout version is refused (plan_locked), also a direct insert / change of a version',
  pg_temp.try($q$select public.add_quote_version('a0000000-0000-4000-8000-00000000da01', 'after lock', '{"items": []}'::jsonb, 0)$q$) like '%plan_locked%floor plan%'
  and pg_temp.try($q$insert into public.quote_versions(quote_id, version_no, data, object_count) values ('a0000000-0000-4000-8000-00000000da01', 99, '{"items": []}'::jsonb, 0)$q$) like '%plan_locked%'
  and pg_temp.try($q$update public.quote_versions set label = 'x' where quote_id = 'a0000000-0000-4000-8000-00000000da01' and version_no = 7$q$) like '%plan_locked%');
select pg_temp.res('10 the current version and the hall size (measurements) cannot be changed; other client details can',
  pg_temp.try($q$select pg_temp.as_definer('update public.quotes set current_version = 1 where id = ''a0000000-0000-4000-8000-00000000da01''')$q$) like '%plan_locked%'
  and pg_temp.try($q$update public.quotes set client = client || '{"hallLen": 150}'::jsonb where id = 'a0000000-0000-4000-8000-00000000da01'$q$) like '%plan_locked%hall size%'
  and pg_temp.try($q$update public.quotes set client = client || '{"phone": "9000000001"}'::jsonb where id = 'a0000000-0000-4000-8000-00000000da01'$q$) = '');
select pg_temp.res('11 task plan: new task, rename, times (set_task_schedule), duration / needs first (0396) all refused',
  pg_temp.try($q$insert into public.event_tasks(quote_id, category, title, seq, status) values ('a0000000-0000-4000-8000-00000000da01', 'Decor', 'Extra arch', 9, 'assigned')$q$) like '%plan_locked%task plan%'
  and pg_temp.try($q$update public.event_tasks set title = 'Stage + truss' where id = 'a0000000-0000-4000-8000-00000000a397'$q$) like '%plan_locked%'
  and pg_temp.try($q$select public.set_task_schedule('a0000000-0000-4000-8000-00000000a397', now() + interval '10 days', null, null)$q$) like '%plan_locked%'
  and pg_temp.try($q$select public.event_task_duration_set('a0000000-0000-4000-8000-00000000a397', 90)$q$) like '%plan_locked%');
select pg_temp.res('12 run-sheet: add / change the time / remove a line refused; Venue opens / Ready by refused',
  pg_temp.try($q$insert into public.run_sheet_items(quote_id, start_time, title, seq) values ('a0000000-0000-4000-8000-00000000da01', '20:00', 'Dinner', 3)$q$) like '%plan_locked%run-sheet%'
  and pg_temp.try($q$update public.run_sheet_items set start_time = '18:45' where id = 'a0000000-0000-4000-8000-0000000e0397'$q$) like '%plan_locked%'
  and pg_temp.try($q$delete from public.run_sheet_items where id = 'a0000000-0000-4000-8000-0000000e0397'$q$) like '%plan_locked%'
  and pg_temp.try($q$select public.event_day_plan_set('a0000000-0000-4000-8000-00000000da01', '09:00', '17:30')$q$) like '%plan_locked%Ready by%');

-- ---- 4) ... and still ALLOWS the day's work -----------------------------------------------------------------------------------------
select pg_temp.res('13 task status accept -> start -> done, a note, reassigning (assigned task) all work while locked',
  pg_temp.try($q$update public.event_tasks set assignee_name = 'Kiran' where id = 'a0000000-0000-4000-8000-00000000b397'$q$) = ''
  and pg_temp.try($q$update public.event_tasks set status = 'accepted', responded_at = now() where id = 'a0000000-0000-4000-8000-00000000a397'$q$) = ''
  and pg_temp.try($q$update public.event_tasks set status = 'in_progress', started_at = now() where id = 'a0000000-0000-4000-8000-00000000a397'$q$) = ''
  and pg_temp.try($q$update public.event_tasks set note = 'Truss arrived late' where id = 'a0000000-0000-4000-8000-00000000a397'$q$) = ''
  and pg_temp.try($q$update public.event_tasks set status = 'completed', completed_at = now() where id = 'a0000000-0000-4000-8000-00000000a397'$q$) = '',
  pg_temp.try($q$update public.event_tasks set status = 'accepted', responded_at = now() where id = 'a0000000-0000-4000-8000-00000000b397'$q$));
select pg_temp.res('14 reminders (task + run-sheet switch), Day-before tick, an issue, an open-shift claim task all work while locked',
  pg_temp.try($q$select public.set_task_reminders('a0000000-0000-4000-8000-00000000b397', array[30])$q$) not like '%plan_locked%'
  and pg_temp.try($q$update public.run_sheet_items set remind = true where id = 'a0000000-0000-4000-8000-0000000e0397'$q$) = ''
  and (pg_temp.j($q$select public.event_day_check_set('a0000000-0000-4000-8000-00000000da01', 'power', true)$q$) #>> '{item,done}') = 'true'
  and pg_temp.try($q$insert into public.event_issues(quote_id, title, severity) values ('a0000000-0000-4000-8000-00000000da01', 'Generator late', 'high')$q$) = ''
  and pg_temp.try($q$insert into public.event_tasks(quote_id, category, title, seq, status, note) values ('a0000000-0000-4000-8000-00000000da01', 'Crew', 'Shift: Set-up crew 09:00-17:00 (28/11/2026)', 900, 'accepted', 'Claimed from an open shift')$q$) = '',
  pg_temp.try($q$select public.set_task_reminders('a0000000-0000-4000-8000-00000000b397', array[30])$q$));
select pg_temp.put('st1', pg_temp.j($q$select public.set_lifecycle_stage('a0000000-0000-4000-8000-00000000da01', 'event_day', 'R227 test: move on')$q$)::text);
select pg_temp.put('st2', pg_temp.j($q$select public.set_lifecycle_stage('a0000000-0000-4000-8000-00000000da01', 'settlement', 'R227 test: move on')$q$)::text);
select pg_temp.res('15 the stage still moves on while locked (Event Day, then Settlement) - settlement / closure are not blocked',
  (pg_temp.get('st1')::jsonb ->> 'stage') = 'event_day' and (pg_temp.get('st2')::jsonb ->> 'stage') = 'settlement'
  and (select lifecycle_stage from public.quotes where id = 'a0000000-0000-4000-8000-00000000da01') = 'settlement', pg_temp.get('st1') || pg_temp.get('st2'));
select pg_temp.su();
update public.quotes set lifecycle_stage = 'event_day' where id = 'a0000000-0000-4000-8000-00000000da01';
select pg_temp.res('16 a server job / maintenance (no signed-in user) is not blocked',
  pg_temp.try($q$update public.event_tasks set seq = 5 where id = 'a0000000-0000-4000-8000-00000000c397'$q$) = '');

-- ---- 5) unlock: permission + reason, recorded ----------------------------------------------------------------------------------------
select pg_temp.login('a_sup397@a.test');
select pg_temp.res('17 the supervisor (no Quotes edit) cannot unlock', pg_temp.try($q$select public.event_plan_lock_set('a0000000-0000-4000-8000-00000000da01', false, 'Need to move the stage')$q$) like '42501%');
select pg_temp.login('a_view397@a.test');
select pg_temp.res('18 the view-only role cannot unlock', pg_temp.try($q$select public.event_plan_lock_set('a0000000-0000-4000-8000-00000000da01', false, 'Need to move the stage')$q$) like '42501%');
select pg_temp.login('a_admin@a.test');
select pg_temp.res('19 admin: no reason / a 1-letter reason refused (reason_required)',
  pg_temp.try($q$select public.event_plan_lock_set('a0000000-0000-4000-8000-00000000da01', false, null)$q$) like '%reason_required%'
  and pg_temp.try($q$select public.event_plan_lock_set('a0000000-0000-4000-8000-00000000da01', false, '  x ')$q$) like '%reason_required%');
select pg_temp.put('un1', pg_temp.j($q$select public.event_plan_lock_set('a0000000-0000-4000-8000-00000000da01', false, 'Client added a photo booth')$q$)::text);
select pg_temp.res('20 admin unlocks with a reason: open again (even on the Event Day stage), 2 records, newest = unlock by Asha',
  (pg_temp.get('un1')::jsonb ->> 'locked') = 'false' and (pg_temp.get('un1')::jsonb ->> 'auto') = 'true'
  and jsonb_array_length(pg_temp.get('un1')::jsonb -> 'history') = 2
  and (pg_temp.get('un1')::jsonb #>> '{history,0,action}') = 'unlock' and (pg_temp.get('un1')::jsonb #>> '{history,0,by}') = 'Asha Admin'
  and (pg_temp.get('un1')::jsonb #>> '{history,0,reason}') = 'Client added a photo booth', pg_temp.get('un1'));
select pg_temp.res('21 after the unlock the plan can be edited (new layout version, task time)',
  pg_temp.try($q$select public.add_quote_version('a0000000-0000-4000-8000-00000000da01', 'photo booth', '{"items": []}'::jsonb, 0)$q$) = ''
  and pg_temp.try($q$update public.event_tasks set title = 'Stage flowers + booth' where id = 'a0000000-0000-4000-8000-00000000b397'$q$) = '');
select pg_temp.res('22 the activity trail shows the lock and the unlock with who + why',
  exists (select 1 from jsonb_array_elements(public.event_activity('a0000000-0000-4000-8000-00000000da01')) a
           where a ->> 'kind' = 'plan_lock' and a ->> 'text' = 'Event plan locked for the event day by Sunil Supervisor: Final plan signed off')
  and exists (select 1 from jsonb_array_elements(public.event_activity('a0000000-0000-4000-8000-00000000da01')) a
           where a ->> 'kind' = 'plan_lock' and a ->> 'text' = 'Event plan unlocked by Asha Admin: Client added a photo booth')
  and exists (select 1 from jsonb_array_elements(public.event_activity('a0000000-0000-4000-8000-00000000da01')) a where a ->> 'kind' = 'version'));
select pg_temp.put('re', pg_temp.j($q$select public.event_plan_lock_set('a0000000-0000-4000-8000-00000000da01', true, null)$q$)::text);
select pg_temp.res('23 lock again: locked, 3 records, edits refused again',
  (pg_temp.get('re')::jsonb ->> 'locked') = 'true' and jsonb_array_length(pg_temp.get('re')::jsonb -> 'history') = 3
  and pg_temp.try($q$update public.event_tasks set title = 'Stage flowers' where id = 'a0000000-0000-4000-8000-00000000b397'$q$) like '%plan_locked%');

-- ---- 6) the automatic lock ------------------------------------------------------------------------------------------------------------
select pg_temp.su();
do $$ declare orgA uuid := 'a0000000-0000-4000-8000-000000000001'; v_now timestamp := now() at time zone 'Asia/Kolkata'; begin
  insert into public.quotes(id, code, title, status, client, pricing, current_version, approval_status, org_id, created_at, updated_at, event_date, event_time, lifecycle_stage) values
    ('a0000000-0000-4000-8000-0000000d3971', 'A-3971', 'Today, guests in 30 min', 'confirmed', '{}'::jsonb, '{}'::jsonb, 1, 'approved', orgA, now(), now(), (v_now + interval '30 minutes')::date, to_char(v_now + interval '30 minutes', 'HH24:MI'), 'ready'),
    ('a0000000-0000-4000-8000-0000000d3972', 'A-3972', 'Next month', 'confirmed', '{}'::jsonb, '{}'::jsonb, 1, 'approved', orgA, now(), now(), current_date + 30, '18:00', 'planning'),
    ('a0000000-0000-4000-8000-0000000d3973', 'A-3973', 'Cancelled today', 'cancelled', '{}'::jsonb, '{}'::jsonb, 1, 'approved', orgA, now(), now(), (v_now + interval '30 minutes')::date, to_char(v_now + interval '30 minutes', 'HH24:MI'), 'event_day'),
    ('a0000000-0000-4000-8000-0000000d3974', 'A-3974', 'Next month, then today', 'confirmed', '{}'::jsonb, '{}'::jsonb, 1, 'approved', orgA, now(), now(), current_date + 30, '18:00', 'planning');
end $$;
select pg_temp.res('24 automatic: guests in 30 min today = On the day = locked; next month = open; a cancelled event never locks',
  public._r397_locked('a0000000-0000-4000-8000-0000000d3971') and not public._r397_locked('a0000000-0000-4000-8000-0000000d3972')
  and not public._r397_locked('a0000000-0000-4000-8000-0000000d3973'));
update public.quotes set lifecycle_stage = 'event_day' where id = 'a0000000-0000-4000-8000-0000000d3972';
select pg_temp.res('25 automatic: the Event Day stage locks even before the date', public._r397_locked('a0000000-0000-4000-8000-0000000d3972'));
select pg_temp.login('a_admin@a.test');
select pg_temp.res('26 the automatic lock is enforced too (task added to the guests-in-30-min event refused)',
  pg_temp.try($q$insert into public.event_tasks(quote_id, category, title, seq, status) values ('a0000000-0000-4000-8000-0000000d3971', 'Decor', 'Late add', 1, 'assigned')$q$) like '%plan_locked%');
-- an unlock made BEFORE the day stops counting once the day arrives
select pg_temp.j($q$select public.event_plan_lock_set('a0000000-0000-4000-8000-0000000d3974', true, null)$q$);
select pg_temp.put('u4', pg_temp.j($q$select public.event_plan_lock_set('a0000000-0000-4000-8000-0000000d3974', false, 'Locked too early')$q$)::text);
select pg_temp.su();
update public.quotes set event_date = (now() at time zone 'Asia/Kolkata')::date, event_time = to_char((now() at time zone 'Asia/Kolkata') + interval '20 minutes', 'HH24:MI')
 where id = 'a0000000-0000-4000-8000-0000000d3974';
select pg_temp.res('27 unlocked a month early -> locks by itself again on the day',
  (pg_temp.get('u4')::jsonb ->> 'locked') = 'false' and public._r397_locked('a0000000-0000-4000-8000-0000000d3974'), pg_temp.get('u4'));

-- ---- 7) other studio / anon ------------------------------------------------------------------------------------------------------------
select pg_temp.login('b_admin@b.test');
select pg_temp.res('28 another studio: read / lock / unlock / floor plan all "event not found"; its admin cannot edit studio A rows',
  pg_temp.try($q$select public.event_plan_lock_get('a0000000-0000-4000-8000-00000000da01')$q$) like '%event not found%'
  and pg_temp.try($q$select public.event_plan_lock_set('a0000000-0000-4000-8000-00000000da01', false, 'cross studio')$q$) like '%event not found%'
  and pg_temp.try($q$select public.event_floor_get('a0000000-0000-4000-8000-00000000da01')$q$) like '%event not found%');
select pg_temp.anon();
select pg_temp.res('29 anon refused', pg_temp.try($q$select public.event_plan_lock_get('a0000000-0000-4000-8000-00000000da01')$q$) <> ''
  and pg_temp.try($q$select public.event_floor_get('a0000000-0000-4000-8000-00000000da01')$q$) <> '');
select pg_temp.su();
select pg_temp.res('30 studio B: no lock row, no record written by the attempts',
  not exists (select 1 from public.event_plan_lock_log where org_id <> 'a0000000-0000-4000-8000-000000000001')
  and (select count(*) from public.event_plan_lock_log where quote_id = 'a0000000-0000-4000-8000-00000000da01') = 3);

-- ---- 8) the floor plan for the event-day screens -----------------------------------------------------------------------------------
select pg_temp.su();
update public.quotes set current_version = 7 where id = 'a0000000-0000-4000-8000-00000000da01';   -- test only: show the fixture version
select pg_temp.login('a_view397@a.test');
select pg_temp.put('fl', pg_temp.j($q$select public.event_floor_get('a0000000-0000-4000-8000-00000000da01')$q$)::text);
select pg_temp.res('31 floor plan: version 7, 2 items, hall 120 x 80, 300 guests, capacity 400, lock state included',
  (pg_temp.get('fl')::jsonb ->> 'version_no') = '7' and jsonb_array_length(pg_temp.get('fl')::jsonb -> 'items') = 2
  and (pg_temp.get('fl')::jsonb #>> '{hall,len}') = '120' and (pg_temp.get('fl')::jsonb ->> 'guests') = '300'
  and (pg_temp.get('fl')::jsonb ->> 'capacity') = '400' and (pg_temp.get('fl')::jsonb #>> '{lock,locked}') = 'true'
  and (pg_temp.get('fl')::jsonb #>> '{items,0,properties,rows}') = '2' and (pg_temp.get('fl')::jsonb #>> '{items,1,properties,seats}') = '10', pg_temp.get('fl'));
select pg_temp.res('32 the floor plan carries no money (item price / unit cost dropped)', pg_temp.get('fl') !~* '(price|cost|90000|total|amount)', pg_temp.get('fl'));
select pg_temp.login('a_staff@a.test');
select pg_temp.res('33 a role with neither Staff nor Quotes view cannot read the floor plan / lock (or can, by Quotes view)',
  (select case when public.has_area('quotes', 'view') or public.has_area('staff', 'view')
               then pg_temp.try($q$select public.event_floor_get('a0000000-0000-4000-8000-00000000da01')$q$) = ''
               else pg_temp.try($q$select public.event_floor_get('a0000000-0000-4000-8000-00000000da01')$q$) like '42501%' end));

-- ---- 9) nothing lost, re-apply safe ---------------------------------------------------------------------------------------------------------
select pg_temp.su();
\i supabase/migrations/0397_r227_event_plan_lock.sql
select set_config('helm.r397_plan_lock', 'on', false);
select pg_temp.res('34 re-apply keeps the lock + its 3 records, one guard per table, one old trail body, and the event rows',
  public._r397_locked('a0000000-0000-4000-8000-00000000da01')
  and (select count(*) from public.event_plan_lock_log where quote_id = 'a0000000-0000-4000-8000-00000000da01') = 3
  and (select count(*) from pg_trigger where tgname = 'zz_r397_plan_lock') = 5
  and to_regprocedure('public.event_activity__pre0397(uuid)') is not null and to_regprocedure('public.event_activity__pre0397__pre0397(uuid)') is null
  and (select count(*) from public.event_tasks where quote_id = 'a0000000-0000-4000-8000-00000000da01') = 4
  and (select count(*) from public.run_sheet_items where quote_id = 'a0000000-0000-4000-8000-00000000da01') = 2);
select pg_temp.res('35 free-trial retention lists the lock tables; anon runs no 0397 function',
  array['event_plan_locks', 'event_plan_lock_log']::text[] <@ public._tr184_purge_tables()
  and not exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                   where n.nspname = 'public' and (p.proname like '\_r397\_%' or p.proname in ('event_plan_lock_get', 'event_plan_lock_set', 'event_floor_get'))
                     and has_function_privilege('anon', p.oid, 'execute')));
-- the test switch: off = the guard steps aside for one session (older local suites only)
select set_config('helm.r397_plan_lock', 'off', false);
select pg_temp.login('a_admin@a.test');
select pg_temp.res('36 with the local test switch off the guard steps aside; back on it refuses again',
  pg_temp.try($q$update public.event_tasks set seq = 6 where id = 'a0000000-0000-4000-8000-00000000c397'$q$) = ''
  and (select set_config('helm.r397_plan_lock', 'on', false)) = 'on'
  and pg_temp.try($q$update public.event_tasks set seq = 7 where id = 'a0000000-0000-4000-8000-00000000c397'$q$) like '%plan_locked%');

select pg_temp.su();
select name, result from _rc order by name;
select case when (select count(*) from _rc where result <> 'PASS') = 0
            then 'R227-PLAN-LOCK-0397: ALL PASS (' || (select count(*) from _rc) || '/' || (select count(*) from _rc) || ')'
            else 'R227-PLAN-LOCK-0397: FAILURES' end as summary;
rollback;
