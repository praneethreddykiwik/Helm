-- r254-task-steps-0438.sql - R254 (0438). Proves: (1) applied twice: no stored row changed, privileges; (2) settings: off by default, admin saves,
-- refusals, other studio untouched; (3) every way a task is made gets 'pre' (assign, vendor, direct API, shift claim), a given step stays, auto on =
-- nothing filled in, switching back restores; sample copy / restore / system change untouched; (4) the step calls: atomic, request key, wrong word,
-- rights as the old calls, old calls the same, the setting never leaks; (5) set_task_step: changed / skipped, rights, studio, closed, cancelled,
-- max 200, locked plan refuses all, log row, NO message of any kind; direct change follows the rules; (6) crew_time_clashes: edges, ends, chains,
-- closed, vendors, other studio, rights, names, 60, junk, midnight, DST; nothing written. Local disposable PG only. Fake data only. Rolled back.
\set ON_ERROR_STOP 0
set client_min_messages = error;
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

-- ---- 1) applied twice -------------------------------------------------------------------------------------------------------------------
create temp table _before as select (select md5(coalesce(string_agg((to_jsonb(t) - 'step')::text, '|' order by t.id), '')) from public.event_tasks t) as h_t,
  (select md5(coalesce(string_agg((to_jsonb(s) - 'auto_steps')::text, '|' order by s.org_id), '')) from public.task_reminder_settings s) as h_s, (select count(*) from public.notifications) as n,
  (select count(*) from public.event_tasks where to_jsonb(event_tasks) ->> 'step' is not null) as st;
\ir ../../supabase/migrations/0438_r254_task_steps.sql
\ir ../../supabase/migrations/0438_r254_task_steps.sql
set client_min_messages = warning;
select pg_temp.t('1a no stored row changed (twice), nothing backfilled', (select b.h_t = (select md5(coalesce(string_agg((to_jsonb(t) - 'step')::text, '|' order by t.id), '')) from public.event_tasks t)
  and b.h_s = (select md5(coalesce(string_agg((to_jsonb(s) - 'auto_steps')::text, '|' order by s.org_id), '')) from public.task_reminder_settings s) and b.n = (select count(*) from public.notifications)
  and b.st = (select count(*) from public.event_tasks where step is not null) and not exists (select 1 from public.task_reminder_settings where auto_steps) from _before b));
select pg_temp.t('1b helpers + kept bodies server only, definer + empty search_path', not exists (
  select 1 from pg_proc p, unnest(array['anon', 'authenticated']) r where p.pronamespace = 'public'::regnamespace and (p.proname like '\_r438\_%' or p.proname like '%\_\_pre0438') and has_function_privilege(r, p.oid, 'execute'))
  and not exists (select 1 from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname like '\_r438\_%' and not (p.prosecdef and p.proconfig @> array['search_path=""']))
  and (select count(*) = 2 and bool_and(position('r254-0438' in prosrc) = 0) from pg_proc where proname like '%\_\_pre0438'));
select pg_temp.t('1c the six calls: signed-in only', (select count(*) = 6 and bool_and(has_function_privilege('authenticated', p.oid, 'execute') and has_function_privilege('service_role', p.oid, 'execute') and not has_function_privilege('anon', p.oid, 'execute'))
  from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname in ('assign_tasks_step', 'assign_tasks_step_once', 'assign_tasks_vendor_step', 'assign_tasks_vendor_step_once', 'set_task_step', 'crew_time_clashes')));
-- ---- fixtures: studio A event with a manager + people ------------------------------------------------------------------------------
\set A '\'a0000000-0000-4000-8000-000000000001\''
\set Q '\'a0000000-0000-4000-8000-00000000da01\''
update public.organizations set timezone = 'Asia/Kolkata' where id = :A;
do $$ declare e text; u uuid; begin
  foreach e in array array['r253_mgr@a.test:manager:Mia Manager', 'r253_sup@a.test:supervisor:Sunil Super', 'r253_ravi@a.test:sales:Ravi Kumar', 'r253_off@a.test:sales:Old Login'] loop
    select id into u from auth.users where email = split_part(e, ':', 1);
    if u is null then u := auth.seed_user(split_part(e, ':', 1)); end if;
    insert into public.profiles(id, email, full_name, role, org_id, must_change_password, created_at)
      values (u, split_part(e, ':', 1), split_part(e, ':', 3), split_part(e, ':', 2), 'a0000000-0000-4000-8000-000000000001', false, now())
    on conflict (id) do update set role = excluded.role, org_id = excluded.org_id, full_name = excluded.full_name, email = excluded.email;
  end loop;
  insert into public.team_member_status (user_id, org_id, status, deactivated_at)
  values ((select id from auth.users where email = 'r253_off@a.test'), 'a0000000-0000-4000-8000-000000000001', 'deactivated', now())
  on conflict (user_id, org_id) do update set status = 'deactivated';
end $$;
update public.quotes set deleted_at = null, status = 'confirmed', title = 'Rao wedding', event_date = (now() + interval '1 day')::date, event_time = null, is_demo = false,
       lifecycle_stage = case when lifecycle_stage in ('closed', 'cancelled') then 'execution' else lifecycle_stage end,
       manager_id = (select id from auth.users where email = 'r253_mgr@a.test') where id = :Q;
delete from public.automation_settings where org_id = :A; delete from public.task_reminder_settings where org_id = :A; delete from public.task_escalation_settings where org_id = :A;
insert into public.comms_settings (org_id, studio_whatsapp) values (:A, '919000000001') on conflict (org_id) do update set studio_whatsapp = '919000000001';
insert into public.crew_members (id, name, phone, email, org_id, profile_id, active) values
  ('a0000000-0000-4000-8000-0000000c2531', 'Ravi Kumar', '+91 90000 25311', 'ravi253@example.org', :A, (select id from auth.users where email = 'r253_ravi@a.test'), true),
  ('a0000000-0000-4000-8000-0000000c2532', 'Anu Rao', '+91 90000 25312', 'anu253@example.org', :A, null, true),
  ('a0000000-0000-4000-8000-0000000c2533', 'Nokia Less', '1234567', null, :A, null, true),
  ('a0000000-0000-4000-8000-0000000c2534', 'Old Login', '+91 90000 25314', 'old253@example.org', :A, (select id from auth.users where email = 'r253_off@a.test'), true);
insert into public.vendors (id, name, org_id) values ('a0000000-0000-4000-8000-0000000d2531', 'Sri Flowers', :A);
insert into public.event_department_supervisors (org_id, quote_id, department, profile_id) values (:A, :Q, 'Lights253', (select id from auth.users where email = 'r253_sup@a.test'))
  on conflict (quote_id, department) do update set profile_id = excluded.profile_id;
insert into public.role_access (org_id, role, area, can_view, can_edit) values (:A, 'manager', 'staff', true, true), (:A, 'supervisor', 'staff', true, false), (:A, 'supervisor', 'quotes', false, false), (:A, 'supervisor', 'calendar', false, false),
  (:A, 'sales', 'staff', false, false) on conflict (org_id, role, area) do update set can_view = excluded.can_view, can_edit = excluded.can_edit;
create or replace function pg_temp.id(p_n text) returns uuid language sql as $$ select ('a0000000-0000-4000-8000-00000f54' || p_n)::uuid $$;
create or replace function pg_temp.st(p_title text) returns text language sql as $$ select string_agg(distinct coalesce(t.step, '-'), ',') from public.event_tasks t where t.title = p_title $$;

-- ---- 2) the switch ---------------------------------------------------------------------------------------------------------------------------
select pg_temp.t('2a off by default, in the answer of every studio', pg_temp.as_val('a_admin@a.test', $q$select public.task_reminder_settings_get() ->> 'auto_steps'$q$) = 'ok:false' and pg_temp.as_val('b_admin@b.test', $q$select public.task_reminder_settings_get() ->> 'auto_steps'$q$) = 'ok:false');
select pg_temp.t('2b admin switches it on; the other settings stay', pg_temp.as_val('a_admin@a.test', $q$select (public.task_reminder_settings_set('{"auto_steps": true}') ->> 'auto_steps') || (public.task_reminder_settings_get() ->> 'start_now') || (public.task_reminder_settings_get() ->> 'late_every_min')$q$) = 'ok:truetrue15');
select pg_temp.t('2c saving another setting keeps it; the other studio is untouched', pg_temp.as_val('a_admin@a.test', $q$select public.task_reminder_settings_set('{"late_max": 2, "start_now": true}') ->> 'auto_steps'$q$) = 'ok:true' and pg_temp.as_val('b_admin@b.test', $q$select public.task_reminder_settings_get() ->> 'auto_steps'$q$) = 'ok:false');
select pg_temp.t('2d a wrong value, no Settings edit, signed out: refused', pg_temp.as_val('a_admin@a.test', $q$select public.task_reminder_settings_set('{"auto_steps": "yes"}')::text$q$) like '22023 invalid_auto_steps%'
  and pg_temp.as_val('r253_sup@a.test', $q$select public.task_reminder_settings_set('{"auto_steps": false}')::text$q$) not like 'ok:%' and pg_temp.as_val('anon', $q$select public.task_reminder_settings_set('{"auto_steps": false}')::text$q$) not like 'ok:%'
  and (select auto_steps from public.task_reminder_settings where org_id = :A));
select pg_temp.as_val('a_admin@a.test', $q$select public.task_reminder_settings_set('{"auto_steps": false}')::text$q$);

-- ---- 3) every way a task is made -------------------------------------------------------------------------------------------------------------------
create or replace function pg_temp.asg(p_t text, p_extra text default '') returns text language sql as $$
  select pg_temp.as_val('a_admin@a.test', format('select (public.assign_tasks(''a0000000-0000-4000-8000-00000000da01'', ''S438'', array[%L], ''a0000000-0000-4000-8000-0000000c2532'', ''Anu Rao'', ''+919000025312'')) ->> ''tasks_created''', p_t)) $$;
select pg_temp.t('3a assign_tasks (the old call): pre', pg_temp.asg('T-old') = 'ok:1'); select pg_temp.t('3a2', pg_temp.st('T-old') = 'pre', pg_temp.st('T-old'));
select pg_temp.t('3b the old keyed call', pg_temp.as_val('a_admin@a.test', $q$select (public.assign_tasks_once('a0000000-0000-4000-8000-00000000da01', 'S438', array['T-once'], 'a0000000-0000-4000-8000-0000000c2532', 'Anu Rao', '+919000025312', gen_random_uuid())) ->> 'tasks_created'$q$) = 'ok:1'); select pg_temp.t('3b2 pre', pg_temp.st('T-once') = 'pre');
update public.vendors set phone = '+919000025319' where id = 'a0000000-0000-4000-8000-0000000d2531';
select pg_temp.t('3c vendor (old call)', pg_temp.as_val('a_admin@a.test', $q$select (public.assign_tasks_vendor('a0000000-0000-4000-8000-00000000da01', 'S438', array['T-vend'], 'a0000000-0000-4000-8000-0000000d2531')) ->> 'tasks_created'$q$) = 'ok:1'); select pg_temp.t('3c2 pre', pg_temp.st('T-vend') = 'pre');
select pg_temp.t('3d a direct insert through the API: pre; a given step stays; a wrong word is refused', pg_temp.as_val('a_admin@a.test', $q$insert into public.event_tasks (quote_id, category, title, status) values ('a0000000-0000-4000-8000-00000000da01', 'S438', 'T-api', 'unassigned') returning step$q$) = 'ok:pre'
  and pg_temp.as_val('a_admin@a.test', $q$insert into public.event_tasks (quote_id, category, title, status, step) values ('a0000000-0000-4000-8000-00000000da01', 'S438', 'T-api2', 'unassigned', 'wrapup') returning step$q$) = 'ok:wrapup'
  and pg_temp.as_val('a_admin@a.test', $q$insert into public.event_tasks (quote_id, category, title, status, step) values ('a0000000-0000-4000-8000-00000000da01', 'S438', 'T-api3', 'unassigned', 'lunch') returning step$q$) like '23514%');
insert into public.event_tasks (quote_id, org_id, category, title, seq, status, note) values (:Q, :A, 'Staff', 'Shift: Loader', 900, 'accepted', 'Claimed from an open shift');
select pg_temp.t('3e a server path without a maker (shift claim): pre', pg_temp.st('Shift: Loader') = 'pre');
update public.task_reminder_settings set auto_steps = true where org_id = :A;
select pg_temp.asg('T-auto'); select pg_temp.t('3f auto on: nothing filled in', pg_temp.st('T-auto') = '-', pg_temp.st('T-auto'));
select pg_temp.t('3g auto on: a given step is kept', pg_temp.as_val('a_admin@a.test', $q$insert into public.event_tasks (quote_id, category, title, status, step) values ('a0000000-0000-4000-8000-00000000da01', 'S438', 'T-auto2', 'unassigned', 'onday') returning step$q$) = 'ok:onday');
update public.task_reminder_settings set auto_steps = false where org_id = :A;
select pg_temp.t('3h switched back: the saved steps are still there, the old ones still empty', pg_temp.st('T-api2') = 'wrapup' and pg_temp.st('T-auto2') = 'onday' and pg_temp.st('T-auto') = '-');
select set_config('helm.maintenance', 'on', true);
insert into public.event_tasks (quote_id, org_id, category, title, status) values (:Q, :A, 'S438', 'T-restore', 'unassigned'); insert into public.event_tasks (quote_id, org_id, category, title, status, step) values (:Q, :A, 'S438', 'T-restore2', 'unassigned', 'daybefore');
select set_config('helm.maintenance', 'off', true);
select pg_temp.t('3i a restore / the SQL editor: untouched', pg_temp.st('T-restore') = '-' and pg_temp.st('T-restore2') = 'daybefore');
insert into public.event_tasks (quote_id, org_id, category, title, status, step) select quote_id, org_id, category, 'Copy ' || title, 'unassigned', step from public.event_tasks where title in ('T-api2', 'T-old');
select pg_temp.t('3j a copy keeps the source step', pg_temp.st('Copy T-api2') = 'wrapup' and pg_temp.st('Copy T-old') = 'pre');
update public.quotes set is_demo = true where id = :Q;
insert into public.event_tasks (quote_id, org_id, category, title, status) values (:Q, :A, 'S438', 'T-sample', 'unassigned'); select pg_temp.asg('T-demo-user');
select pg_temp.t('3k sample data copied for a trial (no maker): as it is; a person working on a sample event: pre', pg_temp.st('T-sample') = '-' and pg_temp.st('T-demo-user') = 'pre', pg_temp.st('T-sample') || pg_temp.st('T-demo-user'));
update public.quotes set is_demo = false where id = :Q;
select pg_temp.t('3l studio B with auto on / A off do not mix', pg_temp.as_val('b_admin@b.test', $q$select public.task_reminder_settings_set('{"auto_steps": true}') ->> 'auto_steps'$q$) = 'ok:true' and pg_temp.as_val('a_admin@a.test', $q$insert into public.event_tasks (quote_id, category, title, status) values ('a0000000-0000-4000-8000-00000000da01', 'S438', 'T-mix', 'unassigned') returning step$q$) = 'ok:pre');

-- ---- 4) the step calls --------------------------------------------------------------------------------------------------------------------------------
create or replace function pg_temp.sc(p_who text, p_title text, p_step text) returns text language sql as $$
  select pg_temp.as_val(p_who, format('select (public.assign_tasks_step(''a0000000-0000-4000-8000-00000000da01'', ''S438'', array[%L, %L], ''a0000000-0000-4000-8000-0000000c2532'', ''Anu Rao'', ''+919000025312'', %L))::text', p_title, p_title, p_step)) $$;
select pg_temp.t('4a two tasks with the picked step, the answer of assign_tasks', pg_temp.sc('a_admin@a.test', 'S-wrap', 'wrapup') like 'ok:%"tasks_created": 2%'); select pg_temp.t('4a2', pg_temp.st('S-wrap') = 'wrapup' and (select count(*) = 2 from public.event_tasks where title = 'S-wrap'));
select pg_temp.asg('S-after'); select pg_temp.t('4b the picked step does not leak into the next call of the same transaction', pg_temp.st('S-after') = 'pre', pg_temp.st('S-after'));
select pg_temp.t('4c no step: the default', pg_temp.sc('a_admin@a.test', 'S-null', null) like 'ok:%'); select pg_temp.t('4c2', pg_temp.st('S-null') = 'pre');
select pg_temp.t('4d a wrong word: refused, nothing made', pg_temp.sc('a_admin@a.test', 'S-bad', 'lunch') like '22023 invalid_step%' and not exists (select 1 from public.event_tasks where title = 'S-bad'));
select pg_temp.t('4e rights as the old call: view-only, sales, other studio, signed out refused', pg_temp.sc('r253_sup@a.test', 'S-no', 'pre') like '42501%' and pg_temp.sc('r253_ravi@a.test', 'S-no', 'pre') like '42501%' and pg_temp.sc('b_admin@b.test', 'S-no', 'pre') not like 'ok:%' and pg_temp.sc('anon', 'S-no', 'pre') not like 'ok:%'
  and not exists (select 1 from public.event_tasks where title = 'S-no'));
select pg_temp.t('4f a refusal inside leaves no step behind', pg_temp.as_val('a_admin@a.test', $q$select (public.assign_tasks_step('a0000000-0000-4000-8000-00000000da01', 'S438', array['S-ph'], null, 'X', '12', 'wrapup'))::text$q$) not like 'ok:%' and coalesce(current_setting('helm.task_step', true), '') = '');
select pg_temp.t('4g keyed: once', pg_temp.as_val('a_admin@a.test', $q$select (public.assign_tasks_step_once('a0000000-0000-4000-8000-00000000da01', 'S438', array['S-key'], 'a0000000-0000-4000-8000-0000000c2532', 'Anu Rao', '+919000025312', 'onday', 'a0000000-0000-4000-8000-00000438aa01')) ->> 'tasks_created'$q$) = 'ok:1');
select pg_temp.t('4h the same key again: the first answer, nothing made', pg_temp.as_val('a_admin@a.test', $q$select (public.assign_tasks_step_once('a0000000-0000-4000-8000-00000000da01', 'S438', array['S-key'], 'a0000000-0000-4000-8000-0000000c2532', 'Anu Rao', '+919000025312', 'onday', 'a0000000-0000-4000-8000-00000438aa01')) ->> 'replayed'$q$) = 'ok:true' and (select count(*) = 1 from public.event_tasks where title = 'S-key' and step = 'onday'));
select pg_temp.t('4i the same key, another step: refused', pg_temp.as_val('a_admin@a.test', $q$select (public.assign_tasks_step_once('a0000000-0000-4000-8000-00000000da01', 'S438', array['S-key'], 'a0000000-0000-4000-8000-0000000c2532', 'Anu Rao', '+919000025312', 'pre', 'a0000000-0000-4000-8000-00000438aa01'))::text$q$) like '22023%');
select pg_temp.t('4j vendor with a step, plain and keyed', pg_temp.as_val('a_admin@a.test', $q$select (public.assign_tasks_vendor_step('a0000000-0000-4000-8000-00000000da01', 'S438', array['V-step'], 'a0000000-0000-4000-8000-0000000d2531', 'daybefore')) ->> 'tasks_created'$q$) = 'ok:1'
  and pg_temp.as_val('a_admin@a.test', $q$select (public.assign_tasks_vendor_step_once('a0000000-0000-4000-8000-00000000da01', 'S438', array['V-step2'], 'a0000000-0000-4000-8000-0000000d2531', 'wrapup', 'a0000000-0000-4000-8000-00000438aa02')) ->> 'tasks_created'$q$) = 'ok:1'
  and pg_temp.as_val('a_admin@a.test', $q$select (public.assign_tasks_vendor_step('a0000000-0000-4000-8000-00000000da01', 'S438', array['V-no'], 'a0000000-0000-4000-8000-0000000d2531', 'x'))::text$q$) like '22023 invalid_step%');
select pg_temp.t('4j2', pg_temp.st('V-step') = 'daybefore' and pg_temp.st('V-step2') = 'wrapup');
insert into public.event_plan_locks (quote_id, org_id, state) values (:Q, :A, 'locked') on conflict (quote_id) do update set state = 'locked'; select set_config('helm.r397_plan_lock', 'on', true);
select pg_temp.t('4k2 locked plan', pg_temp.sc('a_admin@a.test', 'S-lock', 'pre') like 'P0001 plan_locked%' and not exists (select 1 from public.event_tasks where title = 'S-lock'));
select set_config('helm.r397_plan_lock', 'off', true);

-- ---- 5) moving tasks -----------------------------------------------------------------------------------------------------------------------------------
insert into public.quotes (id, code, title, org_id, status, event_date, lifecycle_stage) values ('a0000000-0000-4000-8000-00000da04380', 'R438-CLOSED', 'Closed one', :A, 'confirmed', current_date - 30, 'closed'), ('a0000000-0000-4000-8000-00000da04381', 'R438-X', 'Cancelled one', :A, 'cancelled', current_date + 5, 'planning'),
  ('a0000000-0000-4000-8000-00000da04382', 'R438-OTHER', 'Sharma wedding', :A, 'confirmed', current_date + 5, 'planning');
insert into public.event_tasks (id, quote_id, org_id, category, title, status, step, crew_id, assignee_name, assignee_phone) values (pg_temp.id('0001'), :Q, :A, 'M', 'M1', 'assigned', 'pre', 'a0000000-0000-4000-8000-0000000c2532', 'Anu Rao', '+919000025312'), (pg_temp.id('0002'), :Q, :A, 'M', 'M2', 'completed', 'pre', null, null, null), (pg_temp.id('0003'), :Q, :A, 'M', 'M3', 'cancelled', 'pre', null, null, null),
  (pg_temp.id('0004'), 'a0000000-0000-4000-8000-00000da04380', :A, 'M', 'M4', 'assigned', 'pre', null, null, null), (pg_temp.id('0005'), 'a0000000-0000-4000-8000-00000da04381', :A, 'M', 'M5', 'assigned', 'pre', null, null, null), (pg_temp.id('0006'), :Q, :A, 'M', 'M6', 'assigned', 'wrapup', null, null, null),
  (pg_temp.id('0008'), 'a0000000-0000-4000-8000-00000da04382', :A, 'M', 'M8', 'assigned', 'pre', null, null, null);
insert into public.event_tasks (id, quote_id, org_id, category, title, status, step) select pg_temp.id('0007'), q.id, q.org_id, 'M', 'B task', 'assigned', 'pre' from public.quotes q where q.org_id = 'b0000000-0000-4000-8000-000000000001' and q.deleted_at is null limit 1;
create temp table _msg as select (select count(*) from public.notifications) as n, (select count(*) from public.staff_update_outbox) as s, (select count(*) from public.assign_notify_outbox) as a, (select count(*) from public.staff_email_outbox) as e, (select count(*) from public.task_wa_outbox) as w, (select count(*) from public.comms_outbox) as c;
create or replace function pg_temp.mv(p_who text, p_step text, variadic p_n text[]) returns text language sql as $$ select pg_temp.as_val(p_who, format('select public.set_task_step(%L::uuid[], %L)::text', (select array_agg(pg_temp.id(x)) from unnest(p_n) x), p_step)) $$;
create temp table _r as select pg_temp.mv('a_admin@a.test', 'wrapup', '0001', '0001', '0002', '0003', '0004', '0005', '0006', '0007', '0099') as r;
select pg_temp.t('5a changed and skipped with reasons (a doubled id counts once)', (select substr(r, 4)::jsonb ->> 'changed' = '2' and (select string_agg(x ->> 'reason', ',' order by x ->> 'id') from jsonb_array_elements(substr(r, 4)::jsonb -> 'skipped') x) = 'cancelled,event_closed,event_closed,same,not_found,not_found' from _r), (select r from _r));
select pg_temp.t('5b exactly those changed', pg_temp.st('M1') = 'wrapup' and pg_temp.st('M2') = 'wrapup' and pg_temp.st('M3') = 'pre' and pg_temp.st('M4') = 'pre' and pg_temp.st('M5') = 'pre' and pg_temp.st('B task') = 'pre');
select pg_temp.t('5c one log row per change with from / to and the actor', (select count(*) = 2 and bool_and(detail = '{"from": "pre", "to": "wrapup"}'::jsonb and actor = (select id from auth.users where email = 'a_admin@a.test') and actor_kind = 'office') from public.event_task_log where kind = 'step_changed'));
select pg_temp.t('5d the activity list answers it', pg_temp.as_val('a_admin@a.test', $q$select count(*)::text from jsonb_array_elements(public.event_day_activity('a0000000-0000-4000-8000-00000000da01', 200)) x where x ->> 'kind' = 'step_changed'$q$) = 'ok:2');
select pg_temp.t('5e NO message of any kind', (select n = (select count(*) from public.notifications) and s = (select count(*) from public.staff_update_outbox) and a = (select count(*) from public.assign_notify_outbox) and e = (select count(*) from public.staff_email_outbox) and w = (select count(*) from public.task_wa_outbox) and c = (select count(*) from public.comms_outbox) from _msg));
select pg_temp.t('5f rights: Staff view only, sales, other studio, signed out', pg_temp.mv('r253_sup@a.test', 'pre', '0001') like '42501%' and pg_temp.mv('r253_ravi@a.test', 'pre', '0001') like '42501%' and pg_temp.mv('anon', 'pre', '0001') not like 'ok:%'
  and pg_temp.mv('b_admin@b.test', 'pre', '0001') like 'ok:{"changed": 0,%not_found%' and pg_temp.st('M1') = 'wrapup', pg_temp.mv('b_admin@b.test', 'pre', '0001'));
insert into public.role_access (org_id, role, area, can_view, can_edit) values (:A, 'supervisor', 'tasks', true, true) on conflict (org_id, role, area) do update set can_view = true, can_edit = true;
select pg_temp.t('5g the Assign & send tasks right (0385) is enough', pg_temp.mv('r253_sup@a.test', 'pre', '0001') like 'ok:{"changed": 1,%');
delete from public.role_access where org_id = :A and role = 'supervisor' and area = 'tasks';
select pg_temp.t('5h wrong word / none / empty / more than 200', pg_temp.mv('a_admin@a.test', 'lunch', '0001') like '22023 invalid_step%' and pg_temp.mv('a_admin@a.test', null, '0001') like '22023 invalid_step%'
  and pg_temp.as_val('a_admin@a.test', $q$select public.set_task_step('{}', 'pre')::text$q$) = 'ok:{"changed": 0, "skipped": []}' and pg_temp.as_val('a_admin@a.test', $q$select public.set_task_step((select array_agg(gen_random_uuid()) from generate_series(1, 201)), 'pre')::text$q$) like '22023 too_many_tasks%');
select set_config('helm.r397_plan_lock', 'on', true);
select pg_temp.t('5i locked plan: refused like a time change, nothing moves - not even another event in the same call', pg_temp.mv('a_admin@a.test', 'onday', '0008', '0001') like 'P0001 plan_locked%' and pg_temp.mv('a_admin@a.test', 'onday', '0001', '0008') like 'P0001 plan_locked%' and pg_temp.st('M8') = 'pre' and pg_temp.st('M1') = 'pre'
  and pg_temp.as_val('a_admin@a.test', $q$select (public.set_task_schedule('a0000000-0000-4000-8000-00000f540001', now(), null, null)).id::text$q$) like 'P0001 plan_locked%');
select pg_temp.t('5j a direct change is refused too while locked; another field of the same task is not', pg_temp.as_val('a_admin@a.test', $q$update public.event_tasks set step = 'onday' where title = 'M1' returning step$q$) like 'P0001 plan_locked%' and pg_temp.as_val('a_admin@a.test', $q$update public.event_tasks set verify_note = null, step = step where title = 'M1' returning step$q$) like '%pre');
select set_config('helm.r397_plan_lock', 'off', true); update public.event_plan_locks set state = 'unlocked' where quote_id = :Q;
select pg_temp.t('5k a direct change with the right works and is logged', pg_temp.as_val('a_admin@a.test', $q$update public.event_tasks set step = 'onday' where title = 'M1' returning step$q$) = 'ok:onday');
select pg_temp.t('5k2', exists (select 1 from public.event_task_log where task_id = pg_temp.id('0001') and kind = 'step_changed' and detail ->> 'to' = 'onday'));
insert into public.role_access (org_id, role, area, can_view, can_edit) values (:A, 'manager', 'tasks', true, false) on conflict (org_id, role, area) do update set can_view = true, can_edit = false;
select pg_temp.t('5l a direct change without the Assign right is refused even with Staff edit', pg_temp.as_val('r253_mgr@a.test', $q$update public.event_tasks set step = 'pre' where title = 'M1' returning step$q$) like '42501%');
delete from public.role_access where org_id = :A and role = 'manager' and area = 'tasks';
savepoint lg; create or replace function pg_temp.boom() returns trigger language plpgsql as $$ begin raise exception 'log down'; end $$; create trigger a_boom before insert on public.event_task_log for each row execute function pg_temp.boom();
select pg_temp.t('5m the log is down: the move goes through', pg_temp.mv('a_admin@a.test', 'daybefore', '0001') like 'ok:{"changed": 1,%');
select coalesce(jsonb_agg(to_jsonb(r)), '[]') as keep from _rs r \gset
rollback to savepoint lg;
insert into _rs select x ->> 'name', x ->> 'result' from jsonb_array_elements((:'keep')::jsonb) x where not exists (select 1 from _rs r where r.name = x ->> 'name');
savepoint ro; insert into public.studio_subscriptions (org_id, status) values (:A, 'suspended') on conflict (org_id) do update set status = 'suspended';
select pg_temp.t('5n read-only studio: refused', pg_temp.mv('a_admin@a.test', 'daybefore', '0001') like '25006%');
select coalesce(jsonb_agg(to_jsonb(r)), '[]') as keep from _rs r \gset
rollback to savepoint ro;
insert into _rs select x ->> 'name', x ->> 'result' from jsonb_array_elements((:'keep')::jsonb) x where not exists (select 1 from _rs r where r.name = x ->> 'name');

-- ---- 6) one person, two works at the same time ------------------------------------------------------------------------------------------------------------
delete from public.event_tasks where org_id = :A and category in ('M', 'S438');
\set X '\'a0000000-0000-4000-8000-00000da04382\''
-- Anu (c2532): 17:00-19:00 on the other event; people of other kinds around it
insert into public.event_tasks (id, quote_id, org_id, category, title, status, step, crew_id, planned_start, planned_end, duration_min, depends_on, assignee_kind, vendor_id) values
 (pg_temp.id('0101'), :X, :A, 'K', 'Stage set-up', 'assigned', 'pre', 'a0000000-0000-4000-8000-0000000c2532', '2027-03-01 17:00+05:30', '2027-03-01 19:00+05:30', null, null, 'in_house', null),
 (pg_temp.id('0102'), :X, :A, 'K', 'No end', 'accepted', 'pre', 'a0000000-0000-4000-8000-0000000c2532', '2027-03-02 10:00+05:30', null, null, null, 'in_house', null),
 (pg_temp.id('0103'), :X, :A, 'K', 'Long', 'in_progress', 'pre', 'a0000000-0000-4000-8000-0000000c2532', '2027-03-03 10:00+05:30', null, 180, null, 'in_house', null),
 (pg_temp.id('0104'), :X, :A, 'K', 'Done', 'completed', 'pre', 'a0000000-0000-4000-8000-0000000c2532', '2027-03-01 17:00+05:30', null, null, null, 'in_house', null),
 (pg_temp.id('0105'), :X, :A, 'K', 'Gone', 'cancelled', 'pre', 'a0000000-0000-4000-8000-0000000c2532', '2027-03-01 17:00+05:30', null, null, null, 'in_house', null),
 (pg_temp.id('0106'), :X, :A, 'K', 'Refused', 'rejected', 'pre', 'a0000000-0000-4000-8000-0000000c2532', '2027-03-01 17:00+05:30', null, null, null, 'in_house', null),
 (pg_temp.id('0107'), :X, :A, 'K', 'No time', 'assigned', 'pre', 'a0000000-0000-4000-8000-0000000c2532', null, null, 600, null, 'in_house', null),
 (pg_temp.id('0108'), :X, :A, 'K', 'Vendor one', 'assigned', 'pre', 'a0000000-0000-4000-8000-0000000c2532', '2027-03-01 17:00+05:30', null, null, null, 'outsourced', 'a0000000-0000-4000-8000-0000000d2531'),
 (pg_temp.id('0109'), :X, :A, 'K', 'Someone else', 'assigned', 'pre', 'a0000000-0000-4000-8000-0000000c2531', '2027-03-01 17:00+05:30', null, null, null, 'in_house', null),
 (pg_temp.id('0110'), 'a0000000-0000-4000-8000-00000da04380', :A, 'K', 'Closed event', 'assigned', 'pre', 'a0000000-0000-4000-8000-0000000c2532', '2027-03-01 17:00+05:30', null, null, null, 'in_house', null),
 (pg_temp.id('0111'), 'a0000000-0000-4000-8000-00000da04381', :A, 'K', 'Cancelled event', 'assigned', 'pre', 'a0000000-0000-4000-8000-0000000c2532', '2027-03-01 17:00+05:30', null, null, null, 'in_house', null),
 (pg_temp.id('0112'), :Q, :A, 'K', 'Night', 'assigned', 'pre', 'a0000000-0000-4000-8000-0000000c2532', '2027-03-05 23:30+05:30', '2027-03-06 01:00+05:30', null, null, 'in_house', null),
 (pg_temp.id('0121'), :Q, :A, 'K', 'First', 'assigned', 'pre', 'a0000000-0000-4000-8000-0000000c2532', '2027-03-07 10:00+05:30', '2027-03-07 12:00+05:30', null, null, 'in_house', null);
insert into public.event_tasks (id, quote_id, org_id, category, title, status, step, crew_id, planned_start, depends_on) values
 (pg_temp.id('0122'), :Q, :A, 'K', 'Middle', 'unassigned', 'pre', null, null, pg_temp.id('0121')), (pg_temp.id('0123'), :Q, :A, 'K', 'Last', 'assigned', 'pre', 'a0000000-0000-4000-8000-0000000c2532', '2027-03-07 11:00+05:30', pg_temp.id('0122'));
create or replace function pg_temp.cl(p_who text, p_items text, p_ex text default 'null') returns jsonb language sql as $$ select case when r like 'ok:%' then substr(r, 4)::jsonb else to_jsonb(r) end from (select pg_temp.as_val(p_who, format('select public.crew_time_clashes(%L::jsonb, %s)::text', p_items, p_ex)) r) z $$;
create or replace function pg_temp.one(p_s text, p_e text default null, p_more text default '{}', p_who text default 'a_admin@a.test') returns text language sql as $$
  select coalesce((select string_agg(x ->> 'title', ',') from jsonb_array_elements(pg_temp.cl(p_who, jsonb_build_array(jsonb_strip_nulls(jsonb_build_object('crew_id', 'a0000000-0000-4000-8000-0000000c2532', 'start', p_s, 'end', p_e)) || p_more::jsonb)::text) -> 0 -> 'clashes') x), '-') $$;
select pg_temp.t('6a overlap: the task, its event, its times', (select j -> 0 ->> 'i' = '0' and j #> '{0,clashes,0}' = jsonb_build_object('task_id', pg_temp.id('0101'), 'quote_id', 'a0000000-0000-4000-8000-00000da04382', 'code', 'R438-OTHER', 'title', 'Stage set-up', 'event_title', 'Sharma wedding',
   'start', '2027-03-01T11:30:00+00:00', 'end', '2027-03-01T13:30:00+00:00', 'about', false, 'same_event', false) and jsonb_array_length(j #> '{0,clashes}') = 1 from (select pg_temp.cl('a_admin@a.test', '[{"crew_id":"a0000000-0000-4000-8000-0000000c2532","start":"2027-03-01T18:00:00+05:30","end":"2027-03-01T20:00:00+05:30"}]') j) z),
   pg_temp.cl('a_admin@a.test', '[{"crew_id":"a0000000-0000-4000-8000-0000000c2532","start":"2027-03-01T18:00:00+05:30","end":"2027-03-01T20:00:00+05:30"}]')::text);
select pg_temp.t('6b edges: end = start is no clash on either side; one minute is', pg_temp.one('2027-03-01T19:00:00+05:30', '2027-03-01T20:00:00+05:30') = '-' and pg_temp.one('2027-03-01T16:00:00+05:30', '2027-03-01T17:00:00+05:30') = '-'
  and pg_temp.one('2027-03-01T18:59:00+05:30', '2027-03-01T20:00:00+05:30') = 'Stage set-up' and pg_temp.one('2027-03-01T16:00:00+05:30', '2027-03-01T17:01:00+05:30') = 'Stage set-up' and pg_temp.one('2027-03-01T17:30:00+05:30', '2027-03-01T18:00:00+05:30') = 'Stage set-up' and pg_temp.one('2027-03-01T09:00:00+05:30', '2027-03-01T23:00:00+05:30') = 'Stage set-up');
select pg_temp.t('6c no end: about one hour, for the other task and for the asked one; a length; an end before the start counts as none', pg_temp.one('2027-03-02T10:59:00+05:30', '2027-03-02T12:00:00+05:30') = 'No end' and pg_temp.one('2027-03-02T11:00:00+05:30', '2027-03-02T12:00:00+05:30') = '-'
  and pg_temp.one('2027-03-02T09:01:00+05:30') = 'No end' and pg_temp.one('2027-03-02T09:00:00+05:30') = '-' and pg_temp.one('2027-03-02T08:00:00+05:30', null, '{"duration_min":121}') = 'No end' and pg_temp.one('2027-03-02T08:00:00+05:30', null, '{"duration_min":120}') = '-'
  and pg_temp.one('2027-03-02T09:30:00+05:30', '2027-03-02T09:00:00+05:30') = 'No end' and pg_temp.one('2027-03-03T12:59:00+05:30') = 'Long' and pg_temp.one('2027-03-03T13:00:00+05:30') = '-');
select pg_temp.t('6d about: true only without an end and a length', (pg_temp.cl('a_admin@a.test', '[{"crew_id":"a0000000-0000-4000-8000-0000000c2532","start":"2027-03-02T10:00:00+05:30"},{"crew_id":"a0000000-0000-4000-8000-0000000c2532","start":"2027-03-03T10:00:00+05:30"}]') #>> '{0,clashes,0,about}') = 'true'
  and (pg_temp.cl('a_admin@a.test', '[{"crew_id":"a0000000-0000-4000-8000-0000000c2532","start":"2027-03-02T10:00:00+05:30"},{"crew_id":"a0000000-0000-4000-8000-0000000c2532","start":"2027-03-03T10:00:00+05:30"}]') #>> '{1,clashes,0,about}') = 'false');
select pg_temp.t('6e done, cancelled, refused, no time, vendor, somebody else, closed and cancelled events: never', pg_temp.one('2027-03-01T17:00:00+05:30', '2027-03-01T17:30:00+05:30') = 'Stage set-up');
update public.quotes set deleted_at = now() where id = :X; select pg_temp.t('6f a deleted event: never', pg_temp.one('2027-03-01T17:00:00+05:30', '2027-03-01T17:30:00+05:30') = '-'); update public.quotes set deleted_at = null where id = :X;
select pg_temp.t('6g midnight', pg_temp.one('2027-03-06T00:30:00+05:30', '2027-03-06T02:00:00+05:30') = 'Night' and pg_temp.one('2027-03-06T01:00:00+05:30') = '-' and pg_temp.one('2027-03-05T19:30:00Z', '2027-03-05T20:00:00Z') = '-' and pg_temp.one('2027-03-05T19:29:00Z', '2027-03-05T20:00:00Z') = 'Night');
insert into public.event_tasks (id, quote_id, org_id, category, title, status, step, crew_id, planned_start, planned_end) values (pg_temp.id('0131'), :Q, :A, 'K', 'Clock change', 'assigned', 'pre', 'a0000000-0000-4000-8000-0000000c2532', '2027-03-14 01:30 America/New_York', '2027-03-14 03:30 America/New_York');
select pg_temp.t('6h a clock change (DST): real instants - 01:30 to 03:30 is one hour', (select planned_end - planned_start = interval '1 hour' from public.event_tasks where id = pg_temp.id('0131')) and pg_temp.one('2027-03-14T07:30:00Z') = '-' and pg_temp.one('2027-03-14T07:29:00Z') = 'Clock change');
select pg_temp.t('6i waits for the other one, directly or through a chain: no clash, both ways', pg_temp.one('2027-03-07T11:30:00+05:30', '2027-03-07T11:45:00+05:30', format('{"depends_on":"%s"}', pg_temp.id('0121'))) = 'Last' and pg_temp.one('2027-03-07T10:10:00+05:30', '2027-03-07T10:20:00+05:30', format('{"depends_on":"%s"}', pg_temp.id('0122'))) = '-'
  and pg_temp.one('2027-03-07T11:10:00+05:30', '2027-03-07T11:20:00+05:30', format('{"id":"%s"}', pg_temp.id('0123'))) = '-' and pg_temp.one('2027-03-07T11:10:00+05:30', '2027-03-07T11:20:00+05:30', format('{"id":"%s"}', pg_temp.id('0121'))) = '-'
  and pg_temp.one('2027-03-07T11:10:00+05:30', '2027-03-07T11:20:00+05:30', format('{"id":"%s","depends_on":null}', pg_temp.id('0123'))) = 'First', pg_temp.one('2027-03-07T11:10:00+05:30', '2027-03-07T11:20:00+05:30', format('{"id":"%s"}', pg_temp.id('0121'))));
select pg_temp.t('6j same event: by quote_id, by the task, else no', (pg_temp.cl('a_admin@a.test', format('[{"crew_id":"a0000000-0000-4000-8000-0000000c2532","start":"2027-03-01T17:00:00+05:30","quote_id":"%s"}]', 'a0000000-0000-4000-8000-00000da04382')) #>> '{0,clashes,0,same_event}') = 'true'
  and (pg_temp.cl('a_admin@a.test', format('[{"crew_id":"a0000000-0000-4000-8000-0000000c2532","start":"2027-03-01T17:00:00+05:30","id":"%s"}]', pg_temp.id('0102'))) #>> '{0,clashes,0,same_event}') = 'true');
select pg_temp.t('6k left out on request', jsonb_array_length(pg_temp.cl('a_admin@a.test', '[{"crew_id":"a0000000-0000-4000-8000-0000000c2532","start":"2027-03-01T17:00:00+05:30"}]', format('array[%L::uuid]', pg_temp.id('0101'))) #> '{0,clashes}') = 0);
select pg_temp.t('6l rights: Staff view is enough, without it / signed out refused', pg_temp.one('2027-03-01T17:00:00+05:30', null, '{}', 'r253_sup@a.test') = 'Stage set-up' and pg_temp.cl('r253_ravi@a.test', '[]')::text like '"42501%' and pg_temp.cl('anon', '[]')::text not like '[%');
select pg_temp.t('6m who may not see events: the code as today, not the name', (select (j #>> '{0,clashes,0,code}') = 'R438-OTHER' and (j #> '{0,clashes,0,event_title}') = 'null'::jsonb and (j #>> '{0,clashes,0,start}') is not null from (select pg_temp.cl('r253_sup@a.test', '[{"crew_id":"a0000000-0000-4000-8000-0000000c2532","start":"2027-03-01T17:00:00+05:30"}]') j) z));
select pg_temp.t('6n another studio: nothing of this one, whatever ids it sends', pg_temp.one('2027-03-01T17:00:00+05:30', null, format('{"id":"%s","quote_id":"a0000000-0000-4000-8000-00000da04382"}', pg_temp.id('0102')), 'b_admin@b.test') = '-');
select pg_temp.t('6o 60 items in order, 61 and a non-list refused', (select jsonb_array_length(j) = 60 and (j -> 59 ->> 'i') = '59' and (select bool_and(jsonb_array_length(x -> 'clashes') = 1) from jsonb_array_elements(j) x) from (select pg_temp.cl('a_admin@a.test', (select jsonb_agg(jsonb_build_object('crew_id', 'a0000000-0000-4000-8000-0000000c2532', 'start', '2027-03-01T17:00:00+05:30')) from generate_series(1, 60))::text) j) z)
  and pg_temp.cl('a_admin@a.test', (select jsonb_agg('{}'::jsonb) from generate_series(1, 61))::text)::text like '"22023 too_many_items%' and pg_temp.cl('a_admin@a.test', '{}')::text like '"22023 invalid_items%' and pg_temp.cl('a_admin@a.test', '[]') = '[]'::jsonb);
select pg_temp.t('6p junk in one item does not spoil the others', (select jsonb_array_length(j) = 6 and (select string_agg(jsonb_array_length(x -> 'clashes')::text, '' order by (x ->> 'i')::int) from jsonb_array_elements(j) x) = '000001' from (select pg_temp.cl('a_admin@a.test', '[{"crew_id":"x","start":"2027-03-01"},{"crew_id":"a0000000-0000-4000-8000-0000000c2532","start":"soon"},{},null,{"crew_id":"a0000000-0000-4000-8000-0000000c2532","start":"infinity","duration_min":"many"},{"crew_id":"a0000000-0000-4000-8000-0000000c2532","start":"2027-03-01T17:00:00+05:30"}]') j) z),
  pg_temp.cl('a_admin@a.test', '[{"crew_id":"x","start":"2027-03-01"},{"crew_id":"a0000000-0000-4000-8000-0000000c2532","start":"soon"},{},null,{"crew_id":"a0000000-0000-4000-8000-0000000c2532","start":"infinity","duration_min":"many"},{"crew_id":"a0000000-0000-4000-8000-0000000c2532","start":"2027-03-01T17:00:00+05:30"}]')::text);
insert into public.event_tasks (quote_id, org_id, category, title, status, step, crew_id, planned_start, planned_end) select :Q, :A, 'K', 'Many ' || g, 'assigned', 'pre', 'a0000000-0000-4000-8000-0000000c2532', '2027-04-01 10:00+05:30'::timestamptz + make_interval(mins => g), '2027-04-01 18:00+05:30' from generate_series(1, 8) g;
select pg_temp.t('6q at most 5, soonest first', pg_temp.one('2027-04-01T12:00:00+05:30') = 'Many 1,Many 2,Many 3,Many 4,Many 5');
select set_config('helm.r397_plan_lock', 'on', true); update public.event_plan_locks set state = 'locked' where quote_id = :Q;
create temp table _dg as select md5(string_agg(to_jsonb(t)::text, '' order by t.id)) as d from public.event_tasks t;
select pg_temp.t('6r a locked plan does not matter (read only), nothing is written', pg_temp.one('2027-04-01T12:00:00+05:30') like 'Many 1%' and (select d = (select md5(string_agg(to_jsonb(t)::text, '' order by t.id)) from public.event_tasks t) from _dg));
select set_config('helm.r397_plan_lock', 'off', true);
select pg_temp.t('6s the index is used for the person', exists (select 1 from pg_indexes where indexname = 'ix_event_tasks_crew_start_0438'));

select name, result from _rs where result <> 'PASS' order by name;
select case when count(*) filter (where result <> 'PASS') = 0
            then 'R254-TASK-STEPS-0438: ALL PASS (' || count(*) || '/' || count(*) || ')'
            else 'R254-TASK-STEPS-0438: FAILURES (' || count(*) filter (where result <> 'PASS') || ' of ' || count(*) || ')' end as summary
  from _rs;
rollback;
