-- r179-special-reminders-0367.sql - R179: special tasks get reminders, and the permanent staff link gives each event its id.
-- Proves: (1) privileges + the timer / link page wrapped once; (2) a special task with no reminder times anywhere gets the
-- 10 and 5 minute reminders (once each, by e-mail too); (3) a special task the normal timer already reminds is never
-- reminded twice for the same moment; (4) not started after the start: "not started yet" every remind_every_min minutes,
-- up to 6, then nothing; a started task gets nothing more; (5) a task that is NOT special gets nothing extra;
-- (6) staff_link_view gives quote_id on each event (so the event opens inside the permanent link); (7) re-run safe.
-- Re-applies 0367 twice. Local disposable PG only. Fake data only. Rolled back.
\set ON_ERROR_STOP 0
set client_min_messages = error;
\ir ../../supabase/migrations/0367_r179_special_reminders_staff_link_event.sql
\ir ../../supabase/migrations/0367_r179_special_reminders_staff_link_event.sql
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

-- fixture: studio A, a live future event, two staff with e-mail + phone
update public.organizations set timezone = 'Asia/Kolkata' where id = 'a0000000-0000-4000-8000-000000000001';
update public.quotes set deleted_at = null, status = 'confirmed', title = 'Rao Wedding', event_date = (now() + interval '2 days')::date, is_demo = false,
       manager_id = (select id from auth.users where email = 'a_admin@a.test')
 where id = 'a0000000-0000-4000-8000-00000000da01';
delete from public.automation_settings where org_id = 'a0000000-0000-4000-8000-000000000001';
delete from public.task_reminder_settings where org_id = 'a0000000-0000-4000-8000-000000000001';
insert into public.crew_members (id, name, phone, email, org_id, profile_id) values
  ('a0000000-0000-4000-8000-0000000c7901', 'Guest Desk', '+91 90000 79011', 'desk79@example.org', 'a0000000-0000-4000-8000-000000000001', null),
  ('a0000000-0000-4000-8000-0000000c7902', 'Cater Lead', '+91 90000 79012', 'cater79@example.org', 'a0000000-0000-4000-8000-000000000001', null);
create temp table _t as select date_trunc('minute', now()) + interval '2 hours' as t;
insert into public.event_tasks (id, quote_id, org_id, category, title, crew_id, assignee_name, assignee_phone, status, planned_start, remind_before, is_special, remind_every_min) values
  -- special, no reminder times on the task, studio default off below
  ('a0000000-0000-4000-8000-0000000f7901', 'a0000000-0000-4000-8000-00000000da01', 'a0000000-0000-4000-8000-000000000001', 'Guests', 'Receive guests',
   'a0000000-0000-4000-8000-0000000c7901', 'Guest Desk', '+91 90000 79011', 'assigned', (select t from _t), '{}', true, 5),
  -- special AND the normal timer reminds it at 10 min: never twice
  ('a0000000-0000-4000-8000-0000000f7902', 'a0000000-0000-4000-8000-00000000da01', 'a0000000-0000-4000-8000-000000000001', 'Catering', 'Welcome drinks',
   'a0000000-0000-4000-8000-0000000c7902', 'Cater Lead', '+91 90000 79012', 'assigned', (select t from _t), '{10}', true, 5),
  -- NOT special, no reminder times: nothing
  ('a0000000-0000-4000-8000-0000000f7903', 'a0000000-0000-4000-8000-00000000da01', 'a0000000-0000-4000-8000-000000000001', 'Guests', 'Seat plan',
   'a0000000-0000-4000-8000-0000000c7901', 'Guest Desk', '+91 90000 79011', 'assigned', (select t from _t), '{}', false, 5);
-- studio default off, no normal late reminders, no office alert: only the special part can add anything for tasks 1 and 3
insert into public.task_reminder_settings (org_id, enabled, default_before, late_every_min, late_max, alert_office, hold_waiting)
  values ('a0000000-0000-4000-8000-000000000001', true, '{}', 15, 0, false, true)
  on conflict (org_id) do update set default_before = '{}', late_max = 0, alert_office = false, enabled = true;
create or replace function pg_temp.em(p_task uuid, p_kind text) returns integer language sql as $$
  select count(*)::integer from public.staff_email_outbox where task_id = p_task and kind = p_kind $$;

-- ---- 1) privileges + wrapped once --------------------------------------------------------------------------------------------
select pg_temp.t('1a timer, special part and kept body: server only',
  not has_function_privilege('authenticated', 'public.task_reminder_tick(timestamptz)', 'execute')
  and not has_function_privilege('anon', 'public._r367_special_tick(timestamptz)', 'execute')
  and not has_function_privilege('authenticated', 'public._r367_special_tick(timestamptz)', 'execute')
  and not has_function_privilege('authenticated', 'public.task_reminder_tick__pre0367(timestamptz)', 'execute')
  and has_function_privilege('service_role', 'public.task_reminder_tick(timestamptz)', 'execute'));
select pg_temp.t('1b link page open to a link holder, kept body closed',
  has_function_privilege('anon', 'public.staff_link_view(text)', 'execute')
  and not has_function_privilege('anon', 'public.staff_link_view__pre0367(text)', 'execute')
  and not has_function_privilege('authenticated', 'public.staff_link_view__pre0367(text)', 'execute'));

-- ---- 2) a special task with no reminder times anywhere: 10 and 5 minutes before ---------------------------------------------------
select public.task_reminder_tick((select t from _t) - interval '20 minutes');
select pg_temp.t('2a 20 min before: nothing yet', pg_temp.em('a0000000-0000-4000-8000-0000000f7901', 'task_reminder') = 0);
select public.task_reminder_tick((select t from _t) - interval '10 minutes');
select pg_temp.t('2b 10 min before: one reminder e-mail', pg_temp.em('a0000000-0000-4000-8000-0000000f7901', 'task_reminder') = 1,
  pg_temp.em('a0000000-0000-4000-8000-0000000f7901', 'task_reminder')::text);
select public.task_reminder_tick((select t from _t) - interval '9 minutes');
select pg_temp.t('2c next minute: still one', pg_temp.em('a0000000-0000-4000-8000-0000000f7901', 'task_reminder') = 1);
select public.task_reminder_tick((select t from _t) - interval '5 minutes');
select pg_temp.t('2d 5 min before: a second one', pg_temp.em('a0000000-0000-4000-8000-0000000f7901', 'task_reminder') = 2,
  pg_temp.em('a0000000-0000-4000-8000-0000000f7901', 'task_reminder')::text);
select pg_temp.t('2e the WhatsApp rows are the normal b10 / b5 slots (queued)', (select count(*) = 2 and bool_and(status = 'queued')
  from public.task_wa_outbox where task_id = 'a0000000-0000-4000-8000-0000000f7901' and slot in ('b10', 'b5')));
select pg_temp.t('2f ... to the staff record address', (select bool_and(recipient = 'desk79@example.org') from public.staff_email_outbox
  where task_id = 'a0000000-0000-4000-8000-0000000f7901'));

-- ---- 3) special + the normal 10 min reminder: once only ------------------------------------------------------------------------
select pg_temp.t('3a the 10 min reminder of the task with its own 10 min: one, not two', pg_temp.em('a0000000-0000-4000-8000-0000000f7902', 'task_reminder') = 2
  and (select count(*) = 1 from public.task_wa_outbox where task_id = 'a0000000-0000-4000-8000-0000000f7902' and slot = 'b10'),
  pg_temp.em('a0000000-0000-4000-8000-0000000f7902', 'task_reminder')::text);

-- ---- 4) not started after the start: every 5 minutes, up to 6 ------------------------------------------------------------------
select public.task_reminder_tick((select t from _t) + interval '5 minutes');
select pg_temp.t('4a 5 min after: one "not started yet" e-mail', pg_temp.em('a0000000-0000-4000-8000-0000000f7901', 'task_late') = 1,
  pg_temp.em('a0000000-0000-4000-8000-0000000f7901', 'task_late')::text);
update public.event_tasks set status = 'in_progress', started_at = now() where id = 'a0000000-0000-4000-8000-0000000f7902';
select public.task_reminder_tick((select t from _t) + interval '6 minutes');
select pg_temp.t('4b next minute: still one', pg_temp.em('a0000000-0000-4000-8000-0000000f7901', 'task_late') = 1);
select public.task_reminder_tick((select t from _t) + make_interval(mins => g)) from generate_series(10, 30, 5) g;
select pg_temp.t('4c every 5 minutes up to 30: six', pg_temp.em('a0000000-0000-4000-8000-0000000f7901', 'task_late') = 6,
  pg_temp.em('a0000000-0000-4000-8000-0000000f7901', 'task_late')::text);
select public.task_reminder_tick((select t from _t) + interval '35 minutes');
select public.task_reminder_tick((select t from _t) + interval '60 minutes');
select pg_temp.t('4d after six: no more', pg_temp.em('a0000000-0000-4000-8000-0000000f7901', 'task_late') = 6);
select pg_temp.t('4e started after the first one: no more for it', pg_temp.em('a0000000-0000-4000-8000-0000000f7902', 'task_late') = 1,
  pg_temp.em('a0000000-0000-4000-8000-0000000f7902', 'task_late')::text);

-- ---- 5) not special: nothing extra ----------------------------------------------------------------------------------------------
select pg_temp.t('5a a task that is not special and has no reminder times got nothing',
  pg_temp.em('a0000000-0000-4000-8000-0000000f7903', 'task_reminder') = 0 and pg_temp.em('a0000000-0000-4000-8000-0000000f7903', 'task_late') = 0
  and not exists (select 1 from public.task_wa_outbox where task_id = 'a0000000-0000-4000-8000-0000000f7903'));

-- ---- 6) the permanent link page gives each event its id --------------------------------------------------------------------------
create temp table _l as select substring(pg_temp.as_val('a_admin@a.test',
  $q$select public.staff_link_get('a0000000-0000-4000-8000-0000000c7901') ->> 'path'$q$) from 'staff=([0-9a-f]{64})') as tok;
grant select on _l to anon, authenticated;
select pg_temp.t('6a a permanent link was made', (select tok ~ '^[0-9a-f]{64}$' from _l), (select coalesce(tok, '<null>') from _l));
select pg_temp.t('6b the link page lists the event with its id (quote_id)', pg_temp.as_val('anon', format(
  $q$select (public.staff_link_view(%L) -> 'events') @> '[{"quote_id": "a0000000-0000-4000-8000-00000000da01"}]'::jsonb$q$, (select tok from _l))) = 'ok:true',
  pg_temp.as_val('anon', format($q$select public.staff_link_view(%L)::text$q$, (select tok from _l))));
select pg_temp.t('6c a bad link still answers bad_link', pg_temp.as_val('anon',
  $q$select public.staff_link_view(repeat('0', 64)) ->> 'reason'$q$) = 'ok:bad_link');

-- ---- 7) re-run safe ---------------------------------------------------------------------------------------------------------------
select pg_temp.t('7a timer kept once, the new timer is the R179 one',
  to_regprocedure('public.task_reminder_tick__pre0367(timestamptz)') is not null and to_regprocedure('public.task_reminder_tick__pre0367__pre0367(timestamptz)') is null
  and position('r179-0367' in pg_get_functiondef(to_regprocedure('public.task_reminder_tick(timestamptz)'))) > 0
  and position('r179-0367' in pg_get_functiondef(to_regprocedure('public.task_reminder_tick__pre0367(timestamptz)'))) = 0);
select pg_temp.t('7b link page kept once, the new one is the R179 one',
  to_regprocedure('public.staff_link_view__pre0367(text)') is not null
  and position('r179-0367' in pg_get_functiondef(to_regprocedure('public.staff_link_view(text)'))) > 0
  and position('r179-0367' in pg_get_functiondef(to_regprocedure('public.staff_link_view__pre0367(text)'))) = 0);
do $$ declare n int; f int; r record; begin
  select count(*), count(*) filter (where result <> 'PASS') into n, f from _rs;
  for r in select * from _rs where result <> 'PASS' loop raise warning '% -> %', r.name, r.result; end loop;
  if f = 0 then raise warning 'R179-SPECIAL-REMINDERS-0367: ALL PASS (%/%)', n, n;
  else raise warning 'R179-SPECIAL-REMINDERS-0367: % FAILED of %', f, n; end if;
end $$;
rollback;
