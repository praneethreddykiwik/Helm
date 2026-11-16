-- r173-task-timing-0364.sql - R173: reminders at an exact clock time (event_tasks.remind_at), set_task_reminder_times, and
-- e-mail-only reminders for a person with no phone number on the task.
-- Proves: (1) privileges + the timer wrapped once; (2) set_task_reminder_times: own studio + Staff edit only, saves sorted
-- times, refuses after-the-start / more than 24 h before / a new time in the past / no start time / more than 8;
-- (3) an exact-time reminder is queued once when its time comes (and e-mailed once), never twice for the same moment as a
-- minutes-before reminder, and a time missed by 10+ minutes is skipped, never sent late; (4) a task with no phone number but
-- a staff e-mail gets its reminders by e-mail only (WhatsApp never queued); (5) re-run safe.
-- Re-applies 0364 twice. Local disposable PG only. Fake data only. Rolled back.
\set ON_ERROR_STOP 0
set client_min_messages = error;
\ir ../../supabase/migrations/0364_r173_task_timing.sql
\ir ../../supabase/migrations/0364_r173_task_timing.sql
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

-- fixture: studio A, a live future event, staff with e-mail + phone
update public.organizations set timezone = 'Asia/Kolkata' where id = 'a0000000-0000-4000-8000-000000000001';
update public.quotes set deleted_at = null, status = 'confirmed', title = 'Rao Wedding', event_date = (now() + interval '2 days')::date, is_demo = false,
       manager_id = (select id from auth.users where email = 'a_admin@a.test')
 where id = 'a0000000-0000-4000-8000-00000000da01';
delete from public.automation_settings where org_id = 'a0000000-0000-4000-8000-000000000001';
delete from public.task_reminder_settings where org_id = 'a0000000-0000-4000-8000-000000000001';
insert into public.crew_members (id, name, phone, email, org_id, profile_id) values
  ('a0000000-0000-4000-8000-0000000c3731', 'Guest Desk', '+91 90000 37311', 'desk73@example.org', 'a0000000-0000-4000-8000-000000000001', null),
  ('a0000000-0000-4000-8000-0000000c3732', 'Cater Lead', '+91 90000 37312', 'cater73@example.org', 'a0000000-0000-4000-8000-000000000001', null);
-- guests arrive at T (a whole minute, 2 hours from now)
create temp table _t as select date_trunc('minute', now()) + interval '2 hours' as t;
insert into public.event_tasks (id, quote_id, org_id, category, title, crew_id, assignee_name, assignee_phone, status, planned_start, remind_before) values
  -- exact time only (no minutes-before reminders)
  ('a0000000-0000-4000-8000-0000000f3731', 'a0000000-0000-4000-8000-00000000da01', 'a0000000-0000-4000-8000-000000000001', 'Guests', 'Receive guests',
   'a0000000-0000-4000-8000-0000000c3731', 'Guest Desk', '+91 90000 37311', 'assigned', (select t from _t), '{}'),
  -- no phone on the task: e-mail only
  ('a0000000-0000-4000-8000-0000000f3732', 'a0000000-0000-4000-8000-00000000da01', 'a0000000-0000-4000-8000-000000000001', 'Catering', 'Welcome drinks',
   'a0000000-0000-4000-8000-0000000c3732', 'Cater Lead', null, 'assigned', (select t from _t), '{10}'),
  -- no start time yet
  ('a0000000-0000-4000-8000-0000000f3733', 'a0000000-0000-4000-8000-00000000da01', 'a0000000-0000-4000-8000-000000000001', 'Guests', 'Seat plan',
   'a0000000-0000-4000-8000-0000000c3731', 'Guest Desk', '+91 90000 37311', 'assigned', null, null);
update public.event_tasks set remind_before = null where id = 'a0000000-0000-4000-8000-0000000f3731' and remind_before = '{}';
create or replace function pg_temp.rem(p_task uuid) returns integer language sql as $$
  select count(*)::integer from public.staff_email_outbox where task_id = p_task and kind = 'task_reminder' $$;
-- the studio default (10 and 5 min before) would add reminders to task 1: switch the default off for this suite
insert into public.task_reminder_settings (org_id, enabled, default_before, late_every_min, late_max, alert_office, hold_waiting)
  values ('a0000000-0000-4000-8000-000000000001', true, '{}', 15, 0, false, true)
  on conflict (org_id) do update set default_before = '{}', late_max = 0, alert_office = false, enabled = true;

-- ---- 1) privileges ----------------------------------------------------------------------------------------------------------
select pg_temp.t('1a save exact times: signed-in staff only', has_function_privilege('authenticated', 'public.set_task_reminder_times(uuid,timestamptz[])', 'execute')
  and not has_function_privilege('anon', 'public.set_task_reminder_times(uuid,timestamptz[])', 'execute'));
select pg_temp.t('1b timer (new + kept) server only', not has_function_privilege('authenticated', 'public.task_reminder_tick(timestamptz)', 'execute')
  and not has_function_privilege('anon', 'public.task_reminder_tick(timestamptz)', 'execute')
  and not has_function_privilege('authenticated', 'public.task_reminder_tick__pre0364(timestamptz)', 'execute')
  and has_function_privilege('service_role', 'public.task_reminder_tick(timestamptz)', 'execute'));

-- ---- 2) saving exact times ------------------------------------------------------------------------------------------------------
select pg_temp.t('2a two times saved, sorted', pg_temp.as_val('a_admin@a.test', format(
  $q$select jsonb_array_length(public.set_task_reminder_times('a0000000-0000-4000-8000-0000000f3731', array[%L::timestamptz, %L::timestamptz]) -> 'remind_at')$q$,
  (select t from _t) - interval '28 minutes', (select t from _t) - interval '60 minutes')) = 'ok:2');
select pg_temp.t('2b stored earliest first', (select remind_at[1] = (select t from _t) - interval '60 minutes' from public.event_tasks where id = 'a0000000-0000-4000-8000-0000000f3731'));
select pg_temp.t('2c after the start -> after_start', pg_temp.as_val('a_admin@a.test', format(
  $q$select public.set_task_reminder_times('a0000000-0000-4000-8000-0000000f3731', array[%L::timestamptz])::text$q$, (select t from _t) + interval '1 minute')) like '22023%after_start%');
select pg_temp.t('2d more than 24 h before -> too_early', pg_temp.as_val('a_admin@a.test', format(
  $q$select public.set_task_reminder_times('a0000000-0000-4000-8000-0000000f3731', array[%L::timestamptz])::text$q$, (select t from _t) - interval '25 hours')) like '22023%too_early%');
update public.event_tasks set planned_start = now() + interval '30 minutes' where id = 'a0000000-0000-4000-8000-0000000f3733';
select pg_temp.t('2e a new time in the past -> in_past', pg_temp.as_val('a_admin@a.test', format(
  $q$select public.set_task_reminder_times('a0000000-0000-4000-8000-0000000f3733', array[%L::timestamptz])::text$q$, now() - interval '10 minutes')) like '22023%in_past%');
update public.event_tasks set planned_start = null where id = 'a0000000-0000-4000-8000-0000000f3733';
select pg_temp.t('2f no start time -> no_start_time', pg_temp.as_val('a_admin@a.test', format(
  $q$select public.set_task_reminder_times('a0000000-0000-4000-8000-0000000f3733', array[%L::timestamptz])::text$q$, now() + interval '1 hour')) like '22023%no_start_time%');
select pg_temp.t('2g more than 8 -> invalid_times', pg_temp.as_val('a_admin@a.test', format(
  $q$select public.set_task_reminder_times('a0000000-0000-4000-8000-0000000f3731', (select array_agg(%L::timestamptz - make_interval(mins => g)) from generate_series(1, 9) g))::text$q$, (select t from _t))) like '22023%invalid_times%');
select pg_temp.t('2h another studio cannot change it', pg_temp.as_val('b_admin@b.test',
  $q$select public.set_task_reminder_times('a0000000-0000-4000-8000-0000000f3731', null)::text$q$) not like 'ok:%');
select pg_temp.t('2i not signed in -> refused', pg_temp.as_val('anon',
  $q$select public.set_task_reminder_times('a0000000-0000-4000-8000-0000000f3731', null)::text$q$) not like 'ok:%');
select pg_temp.t('2j the refusals left the saved times alone', (select cardinality(remind_at) = 2 from public.event_tasks where id = 'a0000000-0000-4000-8000-0000000f3731'));

-- ---- 3) exact-time reminders -------------------------------------------------------------------------------------------------------
-- the T-60 time is missed by 15 minutes (the timer only runs at T-45): skipped, never sent late
select public.task_reminder_tick((select t from _t) - interval '45 minutes');
select pg_temp.t('3a a time missed by 10+ minutes is skipped (missed), no e-mail', pg_temp.rem('a0000000-0000-4000-8000-0000000f3731') = 0
  and (select count(*) = 1 and bool_and(status = 'skipped' and reason = 'missed') from public.task_wa_outbox where task_id = 'a0000000-0000-4000-8000-0000000f3731' and slot like 'at%'),
  (select string_agg(slot || ':' || status || ':' || coalesce(reason, ''), ',') from public.task_wa_outbox where task_id = 'a0000000-0000-4000-8000-0000000f3731'));
select public.task_reminder_tick((select t from _t) - interval '28 minutes');
select pg_temp.t('3b at 28 minutes before (the exact time): one reminder e-mail', pg_temp.rem('a0000000-0000-4000-8000-0000000f3731') = 1,
  pg_temp.rem('a0000000-0000-4000-8000-0000000f3731')::text);
select public.task_reminder_tick((select t from _t) - interval '27 minutes');
select pg_temp.t('3c the next minutes: still one', pg_temp.rem('a0000000-0000-4000-8000-0000000f3731') = 1);
select pg_temp.t('3d the WhatsApp row for it is queued with minutes left = 28', (select count(*) = 1 and bool_and(status = 'queued' and params ->> 4 = '28')
  from public.task_wa_outbox where task_id = 'a0000000-0000-4000-8000-0000000f3731' and status = 'queued'));
-- the same moment as a minutes-before reminder: once only
update public.event_tasks set remind_before = '{10}', remind_at = array[(select t from _t) - interval '10 minutes'] where id = 'a0000000-0000-4000-8000-0000000f3731';
select public.task_reminder_tick((select t from _t) - interval '10 minutes');
select pg_temp.t('3e 10 min before + an exact time at the same moment: one more e-mail, not two', pg_temp.rem('a0000000-0000-4000-8000-0000000f3731') = 2,
  pg_temp.rem('a0000000-0000-4000-8000-0000000f3731')::text);
select public.task_reminder_tick((select t from _t) - interval '9 minutes');
select pg_temp.t('3f ... and the exact one is marked same_time', (select count(*) = 1 from public.task_wa_outbox where task_id = 'a0000000-0000-4000-8000-0000000f3731'
  and slot like 'at%' and status = 'skipped' and reason = 'same_time'));

-- ---- 4) no phone number on the task: e-mail only ---------------------------------------------------------------------------------
select public.task_reminder_tick((select t from _t) - interval '10 minutes');
select pg_temp.t('4a no phone: the 10 min reminder goes by e-mail', pg_temp.rem('a0000000-0000-4000-8000-0000000f3732') = 1,
  pg_temp.rem('a0000000-0000-4000-8000-0000000f3732')::text);
select pg_temp.t('4b ... to the staff record address', (select bool_and(recipient = 'cater73@example.org' and phone is null) from public.staff_email_outbox
  where task_id = 'a0000000-0000-4000-8000-0000000f3732' and kind = 'task_reminder'));
select pg_temp.t('4c WhatsApp is never queued for it (email_only)', (select count(*) filter (where status = 'queued') = 0
  and count(*) filter (where status = 'skipped' and reason = 'email_only') = 1 from public.task_wa_outbox where task_id = 'a0000000-0000-4000-8000-0000000f3732'));
select public.task_reminder_tick((select t from _t) - interval '9 minutes');
select pg_temp.t('4d once only', pg_temp.rem('a0000000-0000-4000-8000-0000000f3732') = 1);
update public.automation_settings set staff_email_enabled = false where org_id = 'a0000000-0000-4000-8000-000000000001';
insert into public.automation_settings (org_id, staff_email_enabled) select 'a0000000-0000-4000-8000-000000000001', false
  where not exists (select 1 from public.automation_settings where org_id = 'a0000000-0000-4000-8000-000000000001');
update public.event_tasks set remind_before = '{5}' where id = 'a0000000-0000-4000-8000-0000000f3732';
select public.task_reminder_tick((select t from _t) - interval '5 minutes');
select pg_temp.t('4e switch "E-mail staff their tasks" off: no e-mail', pg_temp.rem('a0000000-0000-4000-8000-0000000f3732') = 1);

-- ---- 5) re-run safe -----------------------------------------------------------------------------------------------------------------
select pg_temp.t('5a old timer body kept once, the new timer is the R173 one',
  to_regprocedure('public.task_reminder_tick__pre0364(timestamptz)') is not null and to_regprocedure('public.task_reminder_tick__pre0364__pre0364(timestamptz)') is null
  and position('r173-0364' in pg_get_functiondef(to_regprocedure('public.task_reminder_tick(timestamptz)'))) > 0
  and position('r173-0364' in pg_get_functiondef(to_regprocedure('public.task_reminder_tick__pre0364(timestamptz)'))) = 0);
select pg_temp.t('5b one e-mail-only trigger', (select count(*) = 1 from pg_trigger where tgrelid = 'public.task_wa_outbox'::regclass and tgname = 'zzz_r364_email_only'));
do $$ declare n int; f int; r record; begin
  select count(*), count(*) filter (where result <> 'PASS') into n, f from _rs;
  for r in select * from _rs where result <> 'PASS' loop raise warning '% -> %', r.name, r.result; end loop;
  if f = 0 then raise warning 'R173-TASK-TIMING-0364: ALL PASS (%/%)', n, n;
  else raise warning 'R173-TASK-TIMING-0364: % FAILED of %', f, n; end if;
end $$;
rollback;
