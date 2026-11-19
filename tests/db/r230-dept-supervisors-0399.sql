-- r230-dept-supervisors-0399.sql - R230 (18 Nov 2026): one supervisor per event + department.
-- Proves: structure (RLS on, the log closed to the app, the supervisors readable only in the same studio, grants), assign /
-- same person again (nothing new) / replace / clear (row kept, no person), the history rows, ONE bell notice per new
-- supervisor (only they see it), refused for roles without "Assign & send tasks", wrong person / department refused,
-- another studio blocked (calls + direct read), the late / escalation bell rows of that department's tasks ALSO reach the
-- supervisor (0396 _r396_bell path + a 0369-shaped row), other alerts untouched, re-apply keeps everything.
-- Local disposable PG only. Fake data only. Rolled back.
\set ON_ERROR_STOP 0
set client_min_messages = error;
begin;
\i supabase/migrations/0399_r230_dept_supervisors.sql
\i supabase/migrations/0399_r230_dept_supervisors.sql
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
create or replace function pg_temp.nbell(p_uid text) returns integer language sql as $$
  select count(*)::integer from public.notifications n where n.detail ->> 'source' = '0399' and (n.detail -> 'notify') ? p_uid $$;
grant execute on function pg_temp.res(text, boolean, text), pg_temp.try(text), pg_temp.j(text), pg_temp.put(text, text), pg_temp.get(text)
  to anon, authenticated, service_role;

-- ---- fixture: studio A - a supervisor, a manager, a sales login, a second supervisor; Catering + Decor tasks --------------
do $$
declare orgA uuid := 'a0000000-0000-4000-8000-000000000001'; qA uuid := 'a0000000-0000-4000-8000-00000000da01';
        u_sup uuid; u_mgr uuid; u_crew uuid; u_sup2 uuid; u_bsup uuid;
begin
  u_sup := auth.seed_user('a_sup399@a.test'); u_mgr := auth.seed_user('a_mgr399@a.test'); u_crew := auth.seed_user('a_crew399@a.test');
  u_sup2 := auth.seed_user('a_sup399b@a.test'); u_bsup := auth.seed_user('b_sup399@b.test');
  insert into public.profiles(id, email, full_name, role, org_id, must_change_password, created_at) values
    (u_sup, 'a_sup399@a.test', 'Sunil Supervisor', 'supervisor', orgA, false, now()),
    (u_mgr, 'a_mgr399@a.test', 'Meera Manager', 'manager', orgA, false, now()),
    (u_crew, 'a_crew399@a.test', 'Ravi Sales', 'sales', orgA, false, now()),   -- a role that may not supervise (0398 retires the crew login role)
    (u_sup2, 'a_sup399b@a.test', 'Vivek Lead', 'supervisor', orgA, false, now()),
    (u_bsup, 'b_sup399@b.test', 'Other Studio Sup', 'supervisor', 'b0000000-0000-4000-8000-000000000001', false, now())
  on conflict (id) do update set role = excluded.role, org_id = excluded.org_id, full_name = excluded.full_name;
  insert into public.role_access(role, area, can_view, can_edit, org_id, updated_at) values
    ('manager', 'staff', true, true, orgA, now()), ('supervisor', 'staff', true, false, orgA, now()),
    ('sales', 'staff', false, false, orgA, now()), ('sales', 'tasks', false, false, orgA, now())
  on conflict (role, area, org_id) do update set can_view = excluded.can_view, can_edit = excluded.can_edit;
  delete from public.role_access where org_id = orgA and role = 'supervisor' and area = 'tasks';
  update public.quotes set event_date = current_date + 3, status = 'confirmed' where id = qA;
  insert into public.event_tasks(id, quote_id, org_id, category, title, seq, status, assignee_name) values
    ('a0000000-0000-4000-8000-00000000a399', qA, orgA, 'Catering', 'Cooking', 1, 'assigned', 'Koushik'),
    ('a0000000-0000-4000-8000-00000000b399', qA, orgA, 'Catering', 'Serving counters', 2, 'assigned', 'Vivek'),
    ('a0000000-0000-4000-8000-00000000c399', qA, orgA, 'Decor', 'Welcome board', 3, 'assigned', null);
  perform pg_temp.put('sup', u_sup::text); perform pg_temp.put('mgr', u_mgr::text); perform pg_temp.put('crew', u_crew::text);
  perform pg_temp.put('sup2', u_sup2::text); perform pg_temp.put('bsup', u_bsup::text);
end $$;

-- ---- 1) structure ------------------------------------------------------------------------------------------------------------
select pg_temp.res('01 two new tables with RLS on; the history is closed to the app; anon has nothing',
  (select bool_and(c.relrowsecurity) from pg_class c where c.oid in ('public.event_department_supervisors'::regclass, 'public.event_department_supervisor_log'::regclass))
  and not has_table_privilege('authenticated', 'public.event_department_supervisor_log', 'select')
  and not has_table_privilege('authenticated', 'public.event_department_supervisors', 'insert')
  and not has_table_privilege('authenticated', 'public.event_department_supervisors', 'update')
  and not has_table_privilege('anon', 'public.event_department_supervisors', 'select'));
select pg_temp.res('02 grants: the two calls for signed-in only; helpers + trigger function server only; one notify trigger after two runs',
  has_function_privilege('authenticated', 'public.event_department_supervisor_set(uuid,text,uuid)', 'execute')
  and not has_function_privilege('anon', 'public.event_department_supervisor_set(uuid,text,uuid)', 'execute')
  and not has_function_privilege('anon', 'public.event_department_supervisors_get(uuid)', 'execute')
  and not has_function_privilege('authenticated', 'public._r399_role_ok(uuid,uuid)', 'execute')
  and not has_function_privilege('authenticated', 'public._r399_notify_supervisor()', 'execute')
  and (select count(*) from pg_trigger where tgname = 'zz_r399_dept_supervisor_notify' and tgrelid = 'public.notifications'::regclass) = 1
  and (select count(*) from pg_trigger where tgname = 'audit_trg' and tgrelid = 'public.event_department_supervisors'::regclass) = 1);

-- ---- 2) assign -----------------------------------------------------------------------------------------------------------------
select pg_temp.login('a_admin@a.test');
select pg_temp.put('set1', pg_temp.j(format($q$select public.event_department_supervisor_set('a0000000-0000-4000-8000-00000000da01', 'Catering', %L)$q$, pg_temp.get('sup')))::text);
select pg_temp.res('03 admin sets Sunil (Supervisor) as Catering supervisor -> changed, action set, role supervisor',
  (pg_temp.get('set1')::jsonb ->> 'changed') = 'true' and (pg_temp.get('set1')::jsonb ->> 'action') = 'set'
  and (pg_temp.get('set1')::jsonb ->> 'role') = 'supervisor' and (pg_temp.get('set1')::jsonb ->> 'name') = 'Sunil Supervisor', pg_temp.get('set1'));
select pg_temp.put('set2', pg_temp.j(format($q$select public.event_department_supervisor_set('a0000000-0000-4000-8000-00000000da01', ' Catering ', %L)$q$, pg_temp.get('sup')))::text);
select pg_temp.su();
select pg_temp.res('04 the same person again (spaces trimmed) changes nothing: one row, one history row, ONE bell notice',
  (pg_temp.get('set2')::jsonb ->> 'changed') = 'false'
  and (select count(*) from public.event_department_supervisors where quote_id = 'a0000000-0000-4000-8000-00000000da01') = 1
  and (select count(*) from public.event_department_supervisor_log where quote_id = 'a0000000-0000-4000-8000-00000000da01') = 1
  and pg_temp.nbell(pg_temp.get('sup')) = 1, pg_temp.get('set2'));
select pg_temp.res('05 the bell notice names the department and the event, kind task_escalated, only for Sunil',
  (select bool_and(n.kind = 'task_escalated' and n.channel = 'in_app' and n.detail ->> 'label' like 'You are the Catering supervisor for A-0001%'
                   and jsonb_array_length(n.detail -> 'notify') = 1 and n.org_id = 'a0000000-0000-4000-8000-000000000001')
     from public.notifications n where n.detail ->> 'source' = '0399'));
select pg_temp.login('a_sup399@a.test');
select pg_temp.res('06 Sunil sees the notice in his bell', (select count(*) from jsonb_array_elements(public.bell_feed(50) -> 'items') i where i #>> '{detail,source}' = '0399') = 1);
select pg_temp.login('a_mgr399@a.test');
select pg_temp.res('07 the manager (not named) does not see it', not exists (select 1 from jsonb_array_elements(public.bell_feed(50) -> 'items') i where i #>> '{detail,source}' = '0399'));

-- ---- 3) read -----------------------------------------------------------------------------------------------------------------
select pg_temp.login('a_sup399@a.test');
select pg_temp.put('g', pg_temp.j($q$select public.event_department_supervisors_get('a0000000-0000-4000-8000-00000000da01')$q$)::text);
select pg_temp.res('08 Sunil (Staff - Can see, no Assign) reads: Catering = Sunil, can_edit false, candidates = Supervisor / Event manager / Admin only, history 1',
  (select count(*) from jsonb_array_elements(pg_temp.get('g')::jsonb -> 'rows') r where r ->> 'department' = 'Catering' and r ->> 'name' = 'Sunil Supervisor' and r ->> 'role' = 'supervisor') = 1
  and (pg_temp.get('g')::jsonb ->> 'can_edit') = 'false'
  and not exists (select 1 from jsonb_array_elements(pg_temp.get('g')::jsonb -> 'candidates') c where c ->> 'role' not in ('supervisor', 'manager', 'admin'))
  and exists (select 1 from jsonb_array_elements(pg_temp.get('g')::jsonb -> 'candidates') c where c ->> 'name' = 'Meera Manager' and c ->> 'role' = 'manager')
  and not exists (select 1 from jsonb_array_elements(pg_temp.get('g')::jsonb -> 'candidates') c where c ->> 'name' in ('Ravi Sales', 'Other Studio Sup'))
  and jsonb_array_length(pg_temp.get('g')::jsonb -> 'log') = 1, pg_temp.get('g'));
select pg_temp.res('09 same-studio direct read works (RLS), the history table stays closed',
  (select count(*) from public.event_department_supervisors) = 1
  and pg_temp.try('select count(*) from public.event_department_supervisor_log') like '42501%');

-- ---- 4) refused -----------------------------------------------------------------------------------------------------------------
select pg_temp.res('10 a Supervisor WITHOUT "Assign & send tasks" cannot set or clear',
  pg_temp.try(format($q$select public.event_department_supervisor_set('a0000000-0000-4000-8000-00000000da01', 'Decor', %L)$q$, pg_temp.get('sup'))) like '42501%'
  and pg_temp.try($q$select public.event_department_supervisor_set('a0000000-0000-4000-8000-00000000da01', 'Catering', null)$q$) like '42501%');
select pg_temp.login('a_staff@a.test');
select pg_temp.res('11 a role with neither Staff nor Assign (sales) cannot read or set',
  pg_temp.try($q$select public.event_department_supervisors_get('a0000000-0000-4000-8000-00000000da01')$q$) like '42501%'
  and pg_temp.try(format($q$select public.event_department_supervisor_set('a0000000-0000-4000-8000-00000000da01', 'Decor', %L)$q$, pg_temp.get('sup'))) like '42501%');
select pg_temp.login('b_admin@b.test');
select pg_temp.res('12 another studio: the event is not found (read + set) and its direct read sees 0 rows',
  pg_temp.try($q$select public.event_department_supervisors_get('a0000000-0000-4000-8000-00000000da01')$q$) like '%event not found%'
  and pg_temp.try(format($q$select public.event_department_supervisor_set('a0000000-0000-4000-8000-00000000da01', 'Catering', %L)$q$, pg_temp.get('bsup'))) like '%event not found%'
  and (select count(*) from public.event_department_supervisors) = 0);
select pg_temp.login('a_admin@a.test');
select pg_temp.res('13 wrong person refused: a Sales login, another studio''s supervisor; wrong department refused',
  pg_temp.try(format($q$select public.event_department_supervisor_set('a0000000-0000-4000-8000-00000000da01', 'Decor', %L)$q$, pg_temp.get('crew'))) like '%invalid_person%'
  and pg_temp.try(format($q$select public.event_department_supervisor_set('a0000000-0000-4000-8000-00000000da01', 'Decor', %L)$q$, pg_temp.get('bsup'))) like '%invalid_person%'
  and pg_temp.try(format($q$select public.event_department_supervisor_set('a0000000-0000-4000-8000-00000000da01', 'Rocket science', %L)$q$, pg_temp.get('sup'))) like '%invalid_department%'
  and pg_temp.try(format($q$select public.event_department_supervisor_set('a0000000-0000-4000-8000-00000000da01', '', %L)$q$, pg_temp.get('sup'))) like '%invalid_department%');
select pg_temp.anon();
select pg_temp.res('14 anon refused', pg_temp.try($q$select public.event_department_supervisors_get('a0000000-0000-4000-8000-00000000da01')$q$) <> ''
  and pg_temp.try($q$select public.event_department_supervisor_set('a0000000-0000-4000-8000-00000000da01', 'Catering', null)$q$) <> '');

-- ---- 5) with Assign & send tasks: replace, clear ---------------------------------------------------------------------------
select pg_temp.su();
insert into public.role_access(role, area, can_view, can_edit, org_id, updated_at) values ('supervisor', 'tasks', true, true, 'a0000000-0000-4000-8000-000000000001', now())
  on conflict (role, area, org_id) do update set can_view = true, can_edit = true;
select pg_temp.login('a_sup399b@a.test');
select pg_temp.put('rep', pg_temp.j(format($q$select public.event_department_supervisor_set('a0000000-0000-4000-8000-00000000da01', 'Catering', %L)$q$, pg_temp.get('mgr')))::text);
select pg_temp.su();
select pg_temp.res('15 once the Supervisor role has "Assign & send tasks" Vivek may replace Sunil with Meera (Event manager): replaced, still one row, Meera gets one notice, Sunil still one',
  (pg_temp.get('rep')::jsonb ->> 'action') = 'replaced' and (pg_temp.get('rep')::jsonb ->> 'role') = 'manager'
  and (select profile_id::text from public.event_department_supervisors where quote_id = 'a0000000-0000-4000-8000-00000000da01' and department = 'Catering') = pg_temp.get('mgr')
  and (select count(*) from public.event_department_supervisors where quote_id = 'a0000000-0000-4000-8000-00000000da01') = 1
  and pg_temp.nbell(pg_temp.get('mgr')) = 1 and pg_temp.nbell(pg_temp.get('sup')) = 1
  and (select prev_name || ' -> ' || name || ' by ' || actor_name from public.event_department_supervisor_log where action = 'replaced') = 'Sunil Supervisor -> Meera Manager by Vivek Lead', pg_temp.get('rep'));
select pg_temp.login('a_sup399b@a.test');
select pg_temp.put('self', pg_temp.j(format($q$select public.event_department_supervisor_set('a0000000-0000-4000-8000-00000000da01', 'Decor', %L)$q$, pg_temp.get('sup2')))::text);
select pg_temp.put('clr', pg_temp.j($q$select public.event_department_supervisor_set('a0000000-0000-4000-8000-00000000da01', 'Catering', null)$q$)::text);
select pg_temp.put('clr2', pg_temp.j($q$select public.event_department_supervisor_set('a0000000-0000-4000-8000-00000000da01', 'Catering', null)$q$)::text);
select pg_temp.su();
select pg_temp.res('16 picking yourself saves without a bell notice to yourself',
  (pg_temp.get('self')::jsonb ->> 'changed') = 'true' and pg_temp.nbell(pg_temp.get('sup2')) = 0, pg_temp.get('self'));
select pg_temp.res('17 clear: the row is KEPT with no person, history says cleared; clearing again changes nothing',
  (pg_temp.get('clr')::jsonb ->> 'action') = 'cleared' and (pg_temp.get('clr2')::jsonb ->> 'changed') = 'false'
  and exists (select 1 from public.event_department_supervisors where quote_id = 'a0000000-0000-4000-8000-00000000da01' and department = 'Catering' and profile_id is null)
  and (select count(*) from public.event_department_supervisor_log where quote_id = 'a0000000-0000-4000-8000-00000000da01') = 4, pg_temp.get('clr'));
select pg_temp.res('18 the Audit log has the supervisor changes (tg_audit)', to_regclass('public.audit_log') is null
  or (select count(*) from public.audit_log a where a.entity = 'event_department_supervisors') >= 4);

-- ---- 6) late alerts reach the department supervisor -------------------------------------------------------------------------
select pg_temp.login('a_admin@a.test');
select pg_temp.j(format($q$select public.event_department_supervisor_set('a0000000-0000-4000-8000-00000000da01', 'Catering', %L)$q$, pg_temp.get('sup')));
select pg_temp.su();
select pg_temp.put('b396', coalesce((select public._r396_bell('a0000000-0000-4000-8000-000000000001', 'a0000000-0000-4000-8000-00000000da01', 'a0000000-0000-4000-8000-00000000a399',
  'Not started: Cooking - latest start was 2:00 PM', 'latest_late', jsonb_build_array(pg_temp.get('mgr'))) where to_regprocedure('public._r396_bell(uuid,uuid,uuid,text,text,jsonb)') is not null), -1)::text);
select pg_temp.res('19 a 0396 latest-start red alert for a Catering task goes to the people named AND the Catering supervisor',
  pg_temp.get('b396') = '-1' or exists (select 1 from public.notifications n where n.detail ->> 'source' = '0396' and n.detail ->> 'via' = 'latest_late'
     and n.detail ->> 'task_id' = 'a0000000-0000-4000-8000-00000000a399'
     and (n.detail -> 'notify') ? pg_temp.get('mgr') and (n.detail -> 'notify') ? pg_temp.get('sup') and jsonb_array_length(n.detail -> 'notify') = 2));
insert into public.notifications (quote_id, channel, kind, status, detail, org_id) values
  ('a0000000-0000-4000-8000-00000000da01', 'in_app', 'task_escalated', 'simulated',
   jsonb_build_object('label', 'Special task not started: Serving counters', 'task_id', 'a0000000-0000-4000-8000-00000000b399', 'notify', jsonb_build_array(pg_temp.get('sup'), pg_temp.get('mgr')),
                      'source', '0369', 'via', 'escalation', 'step', 2), 'a0000000-0000-4000-8000-000000000001'),
  ('a0000000-0000-4000-8000-00000000da01', 'in_app', 'task_escalated', 'simulated',
   jsonb_build_object('label', 'Special task not started: Welcome board', 'task_id', 'a0000000-0000-4000-8000-00000000c399', 'notify', jsonb_build_array(pg_temp.get('mgr')),
                      'source', '0369', 'via', 'escalation', 'step', 1), 'a0000000-0000-4000-8000-000000000001'),
  ('a0000000-0000-4000-8000-00000000da01', 'in_app', 'task_escalated', 'simulated',
   jsonb_build_object('label', 'Reminder from the office: Cooking', 'task_id', 'a0000000-0000-4000-8000-00000000a399', 'notify', jsonb_build_array(pg_temp.get('crew')),
                      'source', '0396', 'via', 'office_reminder'), 'a0000000-0000-4000-8000-000000000001');
select pg_temp.res('20 an escalation row already naming the supervisor is not doubled; Decor (Vivek supervises it) gets Vivek; an office reminder to the crew is untouched',
  (select jsonb_array_length(n.detail -> 'notify') from public.notifications n where n.detail ->> 'label' = 'Special task not started: Serving counters') = 2
  and (select (n.detail -> 'notify') ? pg_temp.get('sup2') and (n.detail -> 'notify') ? pg_temp.get('mgr') from public.notifications n where n.detail ->> 'label' = 'Special task not started: Welcome board')
  and (select n.detail -> 'notify' = jsonb_build_array(pg_temp.get('crew')) from public.notifications n where n.detail ->> 'label' = 'Reminder from the office: Cooking'));
select pg_temp.login('a_sup399@a.test');
select pg_temp.res('21 Sunil sees the Catering late alert in his bell', pg_temp.get('b396') = '-1'
  or exists (select 1 from jsonb_array_elements(public.bell_feed(50) -> 'items') i where i #>> '{detail,source}' = '0396' and i #>> '{detail,via}' = 'latest_late'));
select pg_temp.su();
select pg_temp.res('22 other notification kinds never pass through the trigger (WHEN kind = task_escalated)',
  (select pg_get_triggerdef(t.oid) like '%WHEN ((new.kind = ''task_escalated''::text))%' from pg_trigger t where t.tgname = 'zz_r399_dept_supervisor_notify'));

-- ---- 7) re-apply + trial retention ------------------------------------------------------------------------------------------
set client_min_messages = error;
\i supabase/migrations/0399_r230_dept_supervisors.sql
set client_min_messages = warning;
select pg_temp.res('23 re-apply keeps every row and the history; still one notify trigger',
  (select count(*) from public.event_department_supervisors where quote_id = 'a0000000-0000-4000-8000-00000000da01') = 2
  and (select count(*) from public.event_department_supervisor_log where quote_id = 'a0000000-0000-4000-8000-00000000da01') = 5
  and (select count(*) from pg_trigger where tgname = 'zz_r399_dept_supervisor_notify') = 1);
select pg_temp.res('24 free-trial retention purges the new rows with the studio''s events (or 0184 is absent)',
  to_regprocedure('public._tr184_purge_tables()') is null
  or array['event_department_supervisors', 'event_department_supervisor_log']::text[] <@ public._tr184_purge_tables());

-- ---- 8) R227 plan lock (0397): choosing a supervisor is execution, allowed while locked; adding a task stays refused ----------
-- run-all starts the older suites with helm.r397_plan_lock=off; this check needs the lock enforced (like r227-plan-lock-0397.sql)
select pg_temp.su();
select set_config('helm.r397_plan_lock', 'on', false);
select pg_temp.login('a_admin@a.test');
select pg_temp.put('lk', coalesce((select pg_temp.j($q$select public.event_plan_lock_set('a0000000-0000-4000-8000-00000000da01', true, 'final plan')$q$)::text
  where to_regprocedure('public.event_plan_lock_set(uuid,boolean,text)') is not null), 'none'));
select pg_temp.put('lks', pg_temp.j(format($q$select public.event_department_supervisor_set('a0000000-0000-4000-8000-00000000da01', 'Decor', %L)$q$, pg_temp.get('mgr')))::text);
select pg_temp.put('lkt', pg_temp.try($q$select public.assign_tasks('a0000000-0000-4000-8000-00000000da01', 'Decor', array['Lock test'], null, 'Nobody', '9000000399')$q$));
select pg_temp.res('25 with the plan locked (0397) the supervisor can still be changed; adding a task to the department is refused (plan_locked)',
  pg_temp.get('lk') = 'none' or ((pg_temp.get('lk')::jsonb ->> 'locked') = 'true' and (pg_temp.get('lks')::jsonb ->> 'changed') = 'true'
    and pg_temp.get('lkt') like '%plan_locked%'), pg_temp.get('lk') || ' / ' || pg_temp.get('lks') || ' / ' || pg_temp.get('lkt'));

select name, result from _rc order by name;
select case when (select count(*) from _rc where result <> 'PASS') = 0
            then 'R230-DEPT-SUPERVISORS-0399: ALL PASS (' || (select count(*) from _rc) || '/' || (select count(*) from _rc) || ')'
            else 'R230-DEPT-SUPERVISORS-0399: FAILURES' end as summary;
rollback;
