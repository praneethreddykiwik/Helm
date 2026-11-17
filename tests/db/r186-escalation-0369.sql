-- r186-escalation-0369.sql - R186: a special task NOT STARTED at its start time climbs a ladder: worker + coordinator at the
-- start, + manager at 5 min, + admin / owner at 10 min (studio setting), each person each step once, stops when started.
-- Proves: (1) privileges + the four wraps kept once; (2) nothing before the start; (3) step 1 at the start: one step row,
-- the coordinator (by role) gets a bell notice + an e-mail, the worker gets the normal "not started yet" lane, a log row;
-- (4) the next minute adds nothing; (5) step 2 at +5: + manager (a deactivated manager never), the worker is covered by the
-- 5 minute special reminder (not sent twice); (6) step 3 at +10: + admin; then nothing more; (7) bell + inbox: each person
-- sees only the steps they are on, a sales login none; (8) the e-mail claim: monitor link + step facts; a started task stops
-- the ladder and its waiting e-mails are skipped; (9) event lead (quotes.manager_id) is the coordinator when set; (10) missed
-- steps are recorded, never sent late; (11) Settings get / set (Settings edit only, steps checked) + custom steps obeyed;
-- (12) free trial: bell only, no e-mail, no worker message; (13) the Activity timeline shows the steps; (14) re-run safe.
-- Re-applies 0369 twice. Local disposable PG only. Fake data only. Rolled back.
\set ON_ERROR_STOP 0
set client_min_messages = error;
\ir ../../supabase/migrations/0369_r186_special_escalation.sql
\ir ../../supabase/migrations/0369_r186_special_escalation.sql
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

-- fixture: studio A, a live event without an event lead, a coordinator, two managers (one deactivated), the admin
update public.organizations set timezone = 'Asia/Kolkata' where id = 'a0000000-0000-4000-8000-000000000001';
update public.quotes set deleted_at = null, status = 'confirmed', title = 'Rao Wedding', event_date = (now() + interval '2 days')::date, is_demo = false,
       manager_id = null
 where id = 'a0000000-0000-4000-8000-00000000da01';
delete from public.automation_settings where org_id = 'a0000000-0000-4000-8000-000000000001';
delete from public.task_reminder_settings where org_id = 'a0000000-0000-4000-8000-000000000001';
delete from public.task_escalation_settings where org_id = 'a0000000-0000-4000-8000-000000000001';
do $$ declare e text; u uuid; begin
  foreach e in array array['r186_coord@a.test:coordinator:Cora Coord', 'r186_mgr@a.test:manager:Manu Manager', 'r186_off@a.test:manager:Old Manager'] loop
    select id into u from auth.users where email = split_part(e, ':', 1);
    if u is null then u := auth.seed_user(split_part(e, ':', 1)); end if;
    insert into public.profiles(id, email, full_name, role, org_id, must_change_password, created_at)
      values (u, split_part(e, ':', 1), split_part(e, ':', 3), split_part(e, ':', 2), 'a0000000-0000-4000-8000-000000000001', false, now())
    on conflict (id) do update set role = excluded.role, org_id = excluded.org_id, full_name = excluded.full_name, email = excluded.email;
  end loop;
  insert into public.team_member_status (user_id, org_id, status, deactivated_at)
  values ((select id from auth.users where email = 'r186_off@a.test'), 'a0000000-0000-4000-8000-000000000001', 'deactivated', now())
  on conflict (user_id, org_id) do update set status = 'deactivated';
end $$;
-- other office roles of the fixture studio that would also match: none (keep the ladder people exact)
update public.profiles set role = 'sales' where org_id = 'a0000000-0000-4000-8000-000000000001' and role in ('coordinator', 'supervisor', 'manager')
   and email not like 'r186\_%';
insert into public.crew_members (id, name, phone, email, org_id, profile_id) values
  ('a0000000-0000-4000-8000-0000000c8601', 'Guest Desk', '+91 90000 86011', 'desk86@example.org', 'a0000000-0000-4000-8000-000000000001', null),
  ('a0000000-0000-4000-8000-0000000c8602', 'Bar Lead', '+91 90000 86012', 'bar86@example.org', 'a0000000-0000-4000-8000-000000000001', null);
create temp table _t as select date_trunc('minute', now()) + interval '2 hours' as t;
grant select on _t to anon, authenticated;
insert into public.event_tasks (id, quote_id, org_id, category, title, crew_id, assignee_name, assignee_phone, status, planned_start, remind_before, is_special, remind_every_min) values
  ('a0000000-0000-4000-8000-0000000f8601', 'a0000000-0000-4000-8000-00000000da01', 'a0000000-0000-4000-8000-000000000001', 'Guests', 'Receive the groom',
   'a0000000-0000-4000-8000-0000000c8601', 'Guest Desk', '+91 90000 86011', 'assigned', (select t from _t), '{}', true, 5),
  -- special, started after step 1: the ladder stops
  ('a0000000-0000-4000-8000-0000000f8602', 'a0000000-0000-4000-8000-00000000da01', 'a0000000-0000-4000-8000-000000000001', 'Bar', 'Open the bar',
   'a0000000-0000-4000-8000-0000000c8602', 'Bar Lead', '+91 90000 86012', 'assigned', (select t from _t), '{}', true, 5),
  -- NOT special: never escalates
  ('a0000000-0000-4000-8000-0000000f8603', 'a0000000-0000-4000-8000-00000000da01', 'a0000000-0000-4000-8000-000000000001', 'Guests', 'Seat plan',
   'a0000000-0000-4000-8000-0000000c8601', 'Guest Desk', '+91 90000 86011', 'assigned', (select t from _t), '{}', false, 5);
insert into public.task_reminder_settings (org_id, enabled, default_before, late_every_min, late_max, alert_office, hold_waiting)
  values ('a0000000-0000-4000-8000-000000000001', true, '{}', 15, 0, false, true)
  on conflict (org_id) do update set default_before = '{}', late_max = 0, alert_office = false, enabled = true;
create or replace function pg_temp.steps(p_task uuid) returns integer language sql as $$
  select count(*)::integer from public.task_escalation_steps where task_id = p_task and status = 'sent' $$;
create or replace function pg_temp.esc_mail(p_task uuid) returns integer language sql as $$
  select count(*)::integer from public.staff_email_outbox where task_id = p_task and kind = 'task_escalation' $$;
create or replace function pg_temp.esc_mail_to(p_task uuid, p_email text) returns integer language sql as $$
  select count(*)::integer from public.staff_email_outbox where task_id = p_task and kind = 'task_escalation' and recipient = p_email $$;
create or replace function pg_temp.bell(p_task uuid) returns integer language sql as $$
  select count(*)::integer from public.notifications where kind = 'task_escalated' and detail ->> 'task_id' = p_task::text $$;
create or replace function pg_temp.uid(p_email text) returns text language sql as $$ select id::text from auth.users where email = p_email $$;

-- ---- 1) privileges + wraps ---------------------------------------------------------------------------------------------------
select pg_temp.t('1a ladder, helpers, timer and kept bodies: server only',
  not has_function_privilege('authenticated', 'public._r369_escalation_tick(timestamptz)', 'execute')
  and not has_function_privilege('anon', 'public._r369_escalation_tick(timestamptz)', 'execute')
  and not has_function_privilege('authenticated', 'public._r369_people(uuid,uuid,uuid,integer)', 'execute')
  and not has_function_privilege('authenticated', 'public.task_reminder_tick(timestamptz)', 'execute')
  and not has_function_privilege('authenticated', 'public.task_reminder_tick__pre0369(timestamptz)', 'execute')
  and not has_function_privilege('authenticated', 'public.staff_email_claim__pre0369(integer)', 'execute')
  and not has_function_privilege('authenticated', 'public.bell_feed__pre0369(integer)', 'execute')
  and has_function_privilege('service_role', 'public.task_reminder_tick(timestamptz)', 'execute'));
select pg_temp.t('1b bell still for signed-in staff, Settings functions for signed-in staff, nothing for anon',
  has_function_privilege('authenticated', 'public.bell_feed(integer)', 'execute') and not has_function_privilege('anon', 'public.bell_feed(integer)', 'execute')
  and has_function_privilege('authenticated', 'public.task_escalation_settings_get(text)', 'execute')
  and not has_function_privilege('anon', 'public.task_escalation_settings_get(text)', 'execute'));
select pg_temp.t('1c the new tables are closed to the app',
  not has_table_privilege('authenticated', 'public.task_escalation_steps', 'select') and not has_table_privilege('anon', 'public.task_escalation_steps', 'select')
  and not has_table_privilege('authenticated', 'public.task_escalation_settings', 'insert'));

-- ---- 2) before the start: nothing ----------------------------------------------------------------------------------------------
select public.task_reminder_tick((select t from _t) - interval '1 minute');
select pg_temp.t('2a one minute before: no step', pg_temp.steps('a0000000-0000-4000-8000-0000000f8601') = 0 and pg_temp.bell('a0000000-0000-4000-8000-0000000f8601') = 0);

-- ---- 3) step 1 at the start time ------------------------------------------------------------------------------------------------
select public.task_reminder_tick((select t from _t));
select pg_temp.t('3a at the start: one step row', pg_temp.steps('a0000000-0000-4000-8000-0000000f8601') = 1,
  pg_temp.steps('a0000000-0000-4000-8000-0000000f8601')::text);
select pg_temp.t('3b the coordinator gets the e-mail (and nobody else yet)',
  pg_temp.esc_mail('a0000000-0000-4000-8000-0000000f8601') = 1 and pg_temp.esc_mail_to('a0000000-0000-4000-8000-0000000f8601', 'r186_coord@a.test') = 1,
  pg_temp.esc_mail('a0000000-0000-4000-8000-0000000f8601')::text);
select pg_temp.t('3c one bell notice, named for the coordinator only', pg_temp.bell('a0000000-0000-4000-8000-0000000f8601') = 1
  and (select detail -> 'notify' = jsonb_build_array(pg_temp.uid('r186_coord@a.test')) and detail ->> 'level' = 'coordinator'
         from public.notifications where kind = 'task_escalated' and detail ->> 'task_id' = 'a0000000-0000-4000-8000-0000000f8601'),
  (select string_agg(detail::text, ' ') from public.notifications where kind = 'task_escalated'));
select pg_temp.t('3d the worker gets the normal "not started yet" (WhatsApp row + e-mail mirror)',
  exists (select 1 from public.task_wa_outbox where task_id = 'a0000000-0000-4000-8000-0000000f8601' and slot = 'esc0' and kind = 'late' and status = 'queued')
  and exists (select 1 from public.staff_email_outbox where task_id = 'a0000000-0000-4000-8000-0000000f8601' and kind = 'task_late' and recipient = 'desk86@example.org'));
select pg_temp.t('3e the activity log has the step', exists (select 1 from public.event_task_log where task_id = 'a0000000-0000-4000-8000-0000000f8601'
  and kind = 'escalated' and detail ->> 'level' = 'coordinator' and (detail ->> 'step')::int = 1 and detail -> 'to' ? 'Cora Coord'));
select pg_temp.t('3f a task that is not special: nothing', pg_temp.steps('a0000000-0000-4000-8000-0000000f8603') = 0
  and pg_temp.bell('a0000000-0000-4000-8000-0000000f8603') = 0);

-- ---- 4) the next minute: nothing new --------------------------------------------------------------------------------------------
select public.task_reminder_tick((select t from _t) + interval '1 minute');
select pg_temp.t('4a next minute: still one step, one e-mail, one bell', pg_temp.steps('a0000000-0000-4000-8000-0000000f8601') = 1
  and pg_temp.esc_mail('a0000000-0000-4000-8000-0000000f8601') = 1 and pg_temp.bell('a0000000-0000-4000-8000-0000000f8601') = 1);

-- the bar task gets started: its ladder stops; its waiting escalation e-mail will be skipped at claim time
update public.event_tasks set status = 'in_progress', started_at = now() where id = 'a0000000-0000-4000-8000-0000000f8602';

-- ---- 5) step 2 at +5 min ---------------------------------------------------------------------------------------------------------
select public.task_reminder_tick((select t from _t) + interval '5 minutes');
select pg_temp.t('5a +5 min: second step', pg_temp.steps('a0000000-0000-4000-8000-0000000f8601') = 2);
select pg_temp.t('5b coordinator + manager e-mailed for step 2; the deactivated manager never',
  pg_temp.esc_mail_to('a0000000-0000-4000-8000-0000000f8601', 'r186_coord@a.test') = 2
  and pg_temp.esc_mail_to('a0000000-0000-4000-8000-0000000f8601', 'r186_mgr@a.test') = 1
  and pg_temp.esc_mail_to('a0000000-0000-4000-8000-0000000f8601', 'r186_off@a.test') = 0
  and pg_temp.esc_mail_to('a0000000-0000-4000-8000-0000000f8601', 'a_admin@a.test') = 0,
  pg_temp.esc_mail('a0000000-0000-4000-8000-0000000f8601')::text);
select pg_temp.t('5c the worker: the 5 minute special reminder counts, the ladder one is covered (not sent twice)',
  exists (select 1 from public.task_wa_outbox where task_id = 'a0000000-0000-4000-8000-0000000f8601' and slot = 'sp1' and status = 'queued')
  and exists (select 1 from public.task_wa_outbox where task_id = 'a0000000-0000-4000-8000-0000000f8601' and slot = 'esc1' and status = 'skipped' and reason = 'covered'));
select pg_temp.t('5d the started task: no second step', pg_temp.steps('a0000000-0000-4000-8000-0000000f8602') = 1);

-- ---- 6) step 3 at +10 min, then nothing more ---------------------------------------------------------------------------------
select public.task_reminder_tick((select t from _t) + interval '10 minutes');
select pg_temp.t('6a +10 min: third step to coordinator + manager + admin',
  pg_temp.steps('a0000000-0000-4000-8000-0000000f8601') = 3
  and pg_temp.esc_mail_to('a0000000-0000-4000-8000-0000000f8601', 'a_admin@a.test') = 1
  and pg_temp.esc_mail_to('a0000000-0000-4000-8000-0000000f8601', 'r186_mgr@a.test') = 2
  and pg_temp.esc_mail_to('a0000000-0000-4000-8000-0000000f8601', 'r186_coord@a.test') = 3,
  pg_temp.esc_mail('a0000000-0000-4000-8000-0000000f8601')::text);
select public.task_reminder_tick((select t from _t) + make_interval(mins => g)) from generate_series(11, 40, 3) g;
select pg_temp.t('6b after step 3: nothing more (3 steps, 6 e-mails, 3 bells)', pg_temp.steps('a0000000-0000-4000-8000-0000000f8601') = 3
  and pg_temp.esc_mail('a0000000-0000-4000-8000-0000000f8601') = 6 and pg_temp.bell('a0000000-0000-4000-8000-0000000f8601') = 3,
  pg_temp.esc_mail('a0000000-0000-4000-8000-0000000f8601')::text || ' / ' || pg_temp.bell('a0000000-0000-4000-8000-0000000f8601')::text);
select pg_temp.t('6c dedupe: no recipient twice for the same step', not exists (
  select 1 from public.staff_email_outbox where kind = 'task_escalation' group by split_part(dedupe_key, '|', 2), recipient having count(*) > 1));

-- ---- 7) bell + inbox: each person sees only their steps ------------------------------------------------------------------------
select pg_temp.t('7a coordinator sees all 4 escalation notices in the bell (3 steps + the bar task step 1)', pg_temp.as_val('r186_coord@a.test',
  $q$select count(*) from jsonb_array_elements(public.bell_feed(100) -> 'items') i where i ->> 'kind' = 'task_escalated'$q$) = 'ok:4',
  pg_temp.as_val('r186_coord@a.test', $q$select count(*) from jsonb_array_elements(public.bell_feed(100) -> 'items') i where i ->> 'kind' = 'task_escalated'$q$));
select pg_temp.t('7b manager sees 2, admin sees 1', pg_temp.as_val('r186_mgr@a.test',
  $q$select count(*) from jsonb_array_elements(public.bell_feed(100) -> 'items') i where i ->> 'kind' = 'task_escalated'$q$) = 'ok:2'
  and pg_temp.as_val('a_admin@a.test',
  $q$select count(*) from jsonb_array_elements(public.bell_feed(100) -> 'items') i where i ->> 'kind' = 'task_escalated'$q$) = 'ok:1',
  pg_temp.as_val('a_admin@a.test', $q$select count(*) from jsonb_array_elements(public.bell_feed(100) -> 'items') i where i ->> 'kind' = 'task_escalated'$q$));
select pg_temp.t('7c a sales login sees none (bell and inbox rule)', pg_temp.as_val('a_staff@a.test',
  $q$select count(*) from jsonb_array_elements(public.bell_feed(100) -> 'items') i where i ->> 'kind' = 'task_escalated'$q$) = 'ok:0'
  and (select count(*) from public._r23_visible('a0000000-0000-4000-8000-000000000001', pg_temp.uid('a_staff@a.test')::uuid) v where v.kind = 'task_escalated') = 0
  and (select count(*) from public._r23_visible('a0000000-0000-4000-8000-000000000001', pg_temp.uid('r186_coord@a.test')::uuid) v where v.kind = 'task_escalated') = 4);
select pg_temp.t('7d other notices still reach everyone (the wrap only touches escalation rows)',
  (select count(*) from public._r23_visible('a0000000-0000-4000-8000-000000000001', pg_temp.uid('a_staff@a.test')::uuid) v)
  = (select count(*) from public._r23_visible__pre0369('a0000000-0000-4000-8000-000000000001', pg_temp.uid('a_staff@a.test')::uuid) v where coalesce(v.kind, '') <> 'task_escalated'));

-- ---- 8) the e-mail claim ---------------------------------------------------------------------------------------------------------
create temp table _c as select public.staff_email_claim(100) as v;
select pg_temp.t('8a escalation e-mails claimed with the monitor link and the step facts', (select bool_and(
    x ->> 'link_path' = 'monitor.html?quote=a0000000-0000-4000-8000-00000000da01' and (x ->> 'step')::int between 1 and 3
    and x ->> 'my_level' in ('coordinator', 'manager', 'admin') and (x ->> 'task') = 'Receive the groom' and x ? 'late_min')
  from _c, jsonb_array_elements(_c.v) x where x ->> 'kind' = 'task_escalation') and (select count(*) from _c, jsonb_array_elements(_c.v) x where x ->> 'kind' = 'task_escalation') > 0,
  (select string_agg(x::text, ' | ') from _c, jsonb_array_elements(_c.v) x where x ->> 'kind' = 'task_escalation'));
select pg_temp.t('8b the started task: its waiting escalation e-mail is skipped (task_changed), never sent',
  exists (select 1 from public.staff_email_outbox where task_id = 'a0000000-0000-4000-8000-0000000f8602' and kind = 'task_escalation'
            and status = 'skipped' and reason = 'task_changed')
  and not exists (select 1 from _c, jsonb_array_elements(_c.v) x where x ->> 'task' = 'Open the bar' and x ->> 'kind' = 'task_escalation'));
select pg_temp.t('8c the admin step e-mail says admin', exists (select 1 from _c, jsonb_array_elements(_c.v) x
  where x ->> 'kind' = 'task_escalation' and x ->> 'to' = 'a_admin@a.test' and x ->> 'my_level' = 'admin' and (x ->> 'step')::int = 3));

-- ---- 9) the event lead is the coordinator when set ----------------------------------------------------------------------------------
update public.quotes set manager_id = (select id from auth.users where email = 'r186_mgr@a.test') where id = 'a0000000-0000-4000-8000-00000000da01';
select pg_temp.t('9a event lead set: step 1 goes to the lead, not to the coordinator role',
  (select jsonb_agg(x ->> 'name') from jsonb_array_elements(public._r369_people('a0000000-0000-4000-8000-000000000001', 'a0000000-0000-4000-8000-00000000da01', null, 0)) x)
  = '["Manu Manager"]'::jsonb,
  public._r369_people('a0000000-0000-4000-8000-000000000001', 'a0000000-0000-4000-8000-00000000da01', null, 0)::text);
select pg_temp.t('9b step 3 people: lead + admin, each once', (select count(*) = 2 and count(distinct x ->> 'profile_id') = 2
  from jsonb_array_elements(public._r369_people('a0000000-0000-4000-8000-000000000001', 'a0000000-0000-4000-8000-00000000da01', null, 2)) x));
update public.quotes set manager_id = (select id from auth.users where email = 'r186_off@a.test') where id = 'a0000000-0000-4000-8000-00000000da01';
select pg_temp.t('9c a deactivated lead does not count: back to the coordinator role',
  (select jsonb_agg(x ->> 'name') from jsonb_array_elements(public._r369_people('a0000000-0000-4000-8000-000000000001', 'a0000000-0000-4000-8000-00000000da01', null, 0)) x)
  = '["Cora Coord"]'::jsonb);
update public.quotes set manager_id = null where id = 'a0000000-0000-4000-8000-00000000da01';

-- ---- 10) missed steps: recorded, never sent late ---------------------------------------------------------------------------------
insert into public.event_tasks (id, quote_id, org_id, category, title, crew_id, assignee_name, assignee_phone, status, planned_start, remind_before, is_special, remind_every_min) values
  ('a0000000-0000-4000-8000-0000000f8604', 'a0000000-0000-4000-8000-00000000da01', 'a0000000-0000-4000-8000-000000000001', 'Guests', 'Old late one',
   'a0000000-0000-4000-8000-0000000c8601', 'Guest Desk', '+91 90000 86011', 'assigned', (select t from _t) - interval '40 minutes', '{}', true, 5);
select public._r369_escalation_tick((select t from _t));
select pg_temp.t('10a 40 min late with nothing recorded: steps 1-2 superseded, step 3 missed, nothing sent',
  (select count(*) filter (where status = 'superseded') = 2 and count(*) filter (where status = 'missed') = 1 and count(*) filter (where status = 'sent') = 0
     from public.task_escalation_steps where task_id = 'a0000000-0000-4000-8000-0000000f8604')
  and pg_temp.bell('a0000000-0000-4000-8000-0000000f8604') = 0 and pg_temp.esc_mail('a0000000-0000-4000-8000-0000000f8604') = 0);

-- ---- 11) Settings ----------------------------------------------------------------------------------------------------------------
select pg_temp.t('11a defaults 0 / 5 / 10, on', pg_temp.as_val('a_admin@a.test',
  $q$select (public.task_escalation_settings_get() ->> 'steps') || (public.task_escalation_settings_get() ->> 'enabled')$q$) = 'ok:[0, 5, 10]true',
  pg_temp.as_val('a_admin@a.test', $q$select public.task_escalation_settings_get()::text$q$));
select pg_temp.t('11b bad steps refused (22023)', pg_temp.as_val('a_admin@a.test',
  $q$select public.task_escalation_settings_set('not_started', true, '{5,5,10}')::text$q$) like '22023%'
  and pg_temp.as_val('a_admin@a.test', $q$select public.task_escalation_settings_set('not_started', true, '{0,5}')::text$q$) like '22023%'
  and pg_temp.as_val('a_admin@a.test', $q$select public.task_escalation_settings_set('not_completed', true, '{0,5,10}')::text$q$) like '22023%');
select pg_temp.t('11c a coordinator (no Settings edit) cannot change it (42501); anon cannot read it', pg_temp.as_val('r186_coord@a.test',
  $q$select public.task_escalation_settings_set('not_started', true, '{0,3,6}')::text$q$) like '42501%'
  and pg_temp.as_val('anon', $q$select public.task_escalation_settings_get()::text$q$) like '42501%',
  pg_temp.as_val('r186_coord@a.test', $q$select public.task_escalation_settings_set('not_started', true, '{0,3,6}')::text$q$));
select pg_temp.t('11d the admin saves 0 / 3 / 6', pg_temp.as_val('a_admin@a.test',
  $q$select public.task_escalation_settings_set('not_started', true, '{0,3,6}') ->> 'steps'$q$) = 'ok:[0, 3, 6]');
insert into public.event_tasks (id, quote_id, org_id, category, title, crew_id, assignee_name, assignee_phone, status, planned_start, remind_before, is_special, remind_every_min) values
  ('a0000000-0000-4000-8000-0000000f8605', 'a0000000-0000-4000-8000-00000000da01', 'a0000000-0000-4000-8000-000000000001', 'Guests', 'Custom steps',
   'a0000000-0000-4000-8000-0000000c8601', 'Guest Desk', '+91 90000 86011', 'assigned', (select t from _t) + interval '1 hour', '{}', true, 5);
select public.task_reminder_tick((select t from _t) + interval '1 hour 3 minutes');
select pg_temp.t('11e custom steps: at +3 min the manager step (step 1 superseded, nothing late)',
  (select string_agg(step::text || status, ',' order by step) from public.task_escalation_steps where task_id = 'a0000000-0000-4000-8000-0000000f8605') = '0superseded,1sent',
  (select string_agg(step::text || status, ',' order by step) from public.task_escalation_steps where task_id = 'a0000000-0000-4000-8000-0000000f8605'));
select pg_temp.as_val('a_admin@a.test', $q$select public.task_escalation_settings_set('not_started', false, '{0,3,6}')::text$q$);
select public.task_reminder_tick((select t from _t) + interval '1 hour 6 minutes');
select pg_temp.t('11f switched off: no further step', pg_temp.steps('a0000000-0000-4000-8000-0000000f8605') = 1);
select pg_temp.as_val('a_admin@a.test', $q$select public.task_escalation_settings_set('not_started', true, '{0,5,10}')::text$q$);

-- ---- 12) free trial: bell only ----------------------------------------------------------------------------------------------------
insert into public.event_tasks (id, quote_id, org_id, category, title, crew_id, assignee_name, assignee_phone, status, planned_start, remind_before, is_special, remind_every_min) values
  ('a0000000-0000-4000-8000-0000000f8606', 'a0000000-0000-4000-8000-00000000da01', 'a0000000-0000-4000-8000-000000000001', 'Guests', 'Trial task',
   'a0000000-0000-4000-8000-0000000c8601', 'Guest Desk', '+91 90000 86011', 'assigned', (select t from _t) + interval '3 hours', '{}', true, 5);
insert into public.studio_subscriptions (org_id, status, trial_ends_at) values ('a0000000-0000-4000-8000-000000000001', 'trial', (now() + interval '10 days')::date)
  on conflict (org_id) do update set status = 'trial', trial_ends_at = (now() + interval '10 days')::date;
select pg_temp.t('12-0 the studio is on a free trial (not read-only)', public._is_trial_org('a0000000-0000-4000-8000-000000000001')
  and not coalesce(public._trial_locked('a0000000-0000-4000-8000-000000000001'), false));
select public._r369_escalation_tick((select t from _t) + interval '3 hours');
select pg_temp.t('12a trial: the step is recorded and the bell rings', pg_temp.steps('a0000000-0000-4000-8000-0000000f8606') = 1
  and pg_temp.bell('a0000000-0000-4000-8000-0000000f8606') = 1);
select pg_temp.t('12b trial: no e-mail, no worker message', pg_temp.esc_mail('a0000000-0000-4000-8000-0000000f8606') = 0
  and not exists (select 1 from public.task_wa_outbox where task_id = 'a0000000-0000-4000-8000-0000000f8606'));

-- ---- 13) the Activity timeline -------------------------------------------------------------------------------------------------------
select pg_temp.t('13a event_day_activity shows the escalation steps to the office', pg_temp.as_val('a_admin@a.test',
  $q$select count(*) from jsonb_array_elements(public.event_day_activity('a0000000-0000-4000-8000-00000000da01', 500)) a
      where a ->> 'kind' = 'escalated' and a ->> 'task_id' = 'a0000000-0000-4000-8000-0000000f8601'$q$) = 'ok:3',
  pg_temp.as_val('a_admin@a.test', $q$select count(*) from jsonb_array_elements(public.event_day_activity('a0000000-0000-4000-8000-00000000da01', 500)) a where a ->> 'kind' = 'escalated'$q$));

-- ---- 14) re-run safe ---------------------------------------------------------------------------------------------------------------
select pg_temp.t('14a every wrap kept once, the live bodies are the R186 ones',
  to_regprocedure('public.task_reminder_tick__pre0369__pre0369(timestamptz)') is null
  and position('r186-0369' in pg_get_functiondef(to_regprocedure('public.task_reminder_tick(timestamptz)'))) > 0
  and position('r186-0369' in pg_get_functiondef(to_regprocedure('public.task_reminder_tick__pre0369(timestamptz)'))) = 0
  and position('r179-0367' in pg_get_functiondef(to_regprocedure('public.task_reminder_tick__pre0369(timestamptz)'))) > 0
  and position('r186-0369' in pg_get_functiondef(to_regprocedure('public.staff_email_claim__pre0369(integer)'))) = 0
  and position('r186-0369' in pg_get_functiondef(to_regprocedure('public.bell_feed__pre0369(integer)'))) = 0
  and position('r186-0369' in pg_get_functiondef(to_regprocedure('public._r23_visible__pre0369(uuid,uuid)'))) = 0);
select pg_temp.t('14b one kind rule per table, all old values kept',
  (select count(*) from pg_constraint x where x.conrelid = 'public.staff_email_outbox'::regclass and x.contype = 'c' and pg_get_constraintdef(x.oid) ~ '[(]kind = ANY') = 1
  and (select count(*) from pg_constraint x where x.conrelid = 'public.event_task_log'::regclass and x.contype = 'c' and pg_get_constraintdef(x.oid) ~ '[(]kind = ANY') = 1
  and (select pg_get_constraintdef(x.oid) like '%''task_list''%' from pg_constraint x where x.conname = 'staff_email_outbox_kind_chk369')
  and (select pg_get_constraintdef(x.oid) like '%''check_out''%' from pg_constraint x where x.conname = 'event_task_log_kind_chk369'));
do $$ declare n int; f int; r record; begin
  select count(*), count(*) filter (where result <> 'PASS') into n, f from _rs;
  for r in select * from _rs where result <> 'PASS' loop raise warning '% -> %', r.name, r.result; end loop;
  if f = 0 then raise warning 'R186-ESCALATION-0369: ALL PASS (%/%)', n, n;
  else raise warning 'R186-ESCALATION-0369: % FAILED of %', f, n; end if;
end $$;
rollback;
