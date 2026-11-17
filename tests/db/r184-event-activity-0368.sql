-- r184-event-activity-0368.sql - R184: event_task_log + its two triggers + event_day_activity (the Event day monitor timeline).
-- Proves: (1) the log is closed to the app and the timeline is for signed-in office users of the event's own studio only;
-- (2) giving work out, giving it to someone else, a new start time, special on/off and every status step each write ONE
-- log row; (3) check-in and check-out write rows; (4) the timeline merges the log, older task step times (no doubles),
-- older check-ins and sent e-mails, newest first; (5) a failing log write never blocks the task change; (6) re-run safe and
-- the free-trial purge knows the table.
-- Re-applies 0368 twice. Local disposable PG only. Fake data only. Rolled back.
\set ON_ERROR_STOP 0
set client_min_messages = error;
\ir ../../supabase/migrations/0368_r184_event_activity.sql
\ir ../../supabase/migrations/0368_r184_event_activity.sql
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

-- fixture: studio A event, two staff
update public.quotes set deleted_at = null, status = 'confirmed', title = 'Rao Wedding', event_date = (now() + interval '1 day')::date, is_demo = false
 where id = 'a0000000-0000-4000-8000-00000000da01';
insert into public.crew_members (id, name, phone, email, org_id) values
  ('a0000000-0000-4000-8000-0000000c8401', 'Ravi Desk', '+91 90000 84011', 'ravi84@example.org', 'a0000000-0000-4000-8000-000000000001'),
  ('a0000000-0000-4000-8000-0000000c8402', 'Mala Cater', '+91 90000 84012', 'mala84@example.org', 'a0000000-0000-4000-8000-000000000001');
create or replace function pg_temp.n(p_task uuid, p_kind text) returns integer language sql as $$
  select count(*)::integer from public.event_task_log where task_id = p_task and kind = p_kind $$;

-- ---- 1) closed table + who may read the timeline ---------------------------------------------------------------------------------
select pg_temp.t('1a log table: RLS on, no app grants',
  coalesce((select relrowsecurity from pg_class where oid = 'public.event_task_log'::regclass), false)
  and not has_table_privilege('authenticated', 'public.event_task_log', 'select')
  and not has_table_privilege('anon', 'public.event_task_log', 'select'));
select pg_temp.t('1b timeline: signed-in only, helpers server only',
  has_function_privilege('authenticated', 'public.event_day_activity(uuid,integer)', 'execute')
  and not has_function_privilege('anon', 'public.event_day_activity(uuid,integer)', 'execute')
  and not has_function_privilege('authenticated', 'public._r368_task_log()', 'execute'));

-- ---- 2) task changes write one row each -----------------------------------------------------------------------------------------------
insert into public.event_tasks (id, quote_id, org_id, category, title, crew_id, assignee_name, assignee_phone, status) values
  ('a0000000-0000-4000-8000-0000000f8401', 'a0000000-0000-4000-8000-00000000da01', 'a0000000-0000-4000-8000-000000000001', 'Guests', 'Receive guests',
   'a0000000-0000-4000-8000-0000000c8401', 'Ravi Desk', '+91 90000 84011', 'assigned'),
  ('a0000000-0000-4000-8000-0000000f8402', 'a0000000-0000-4000-8000-00000000da01', 'a0000000-0000-4000-8000-000000000001', 'Guests', 'Open task',
   null, null, null, 'unassigned');
select pg_temp.t('2a given out: one "assigned" row; an unassigned task writes nothing',
  pg_temp.n('a0000000-0000-4000-8000-0000000f8401', 'assigned') = 1
  and not exists (select 1 from public.event_task_log where task_id = 'a0000000-0000-4000-8000-0000000f8402'));
update public.event_tasks set crew_id = 'a0000000-0000-4000-8000-0000000c8402', assignee_name = 'Mala Cater', assignee_phone = '+91 90000 84012'
 where id = 'a0000000-0000-4000-8000-0000000f8401';
select pg_temp.t('2b given to someone else: "reassigned" from Ravi to Mala',
  exists (select 1 from public.event_task_log where task_id = 'a0000000-0000-4000-8000-0000000f8401' and kind = 'reassigned'
           and detail ->> 'from' = 'Ravi Desk' and detail ->> 'to' = 'Mala Cater' and crew_id = 'a0000000-0000-4000-8000-0000000c8402'));
update public.event_tasks set planned_start = now() + interval '1 day' where id = 'a0000000-0000-4000-8000-0000000f8401';
update public.event_tasks set planned_start = now() + interval '1 day 30 minutes' where id = 'a0000000-0000-4000-8000-0000000f8401';
select pg_temp.t('2c two new start times: two "time_changed" rows', pg_temp.n('a0000000-0000-4000-8000-0000000f8401', 'time_changed') = 2);
update public.event_tasks set note = 'bring the list' where id = 'a0000000-0000-4000-8000-0000000f8401';
select pg_temp.t('2d a note-only change writes nothing new',
  (select count(*) from public.event_task_log where task_id = 'a0000000-0000-4000-8000-0000000f8401') = 4);
update public.event_tasks set is_special = true where id = 'a0000000-0000-4000-8000-0000000f8401';
update public.event_tasks set is_special = false where id = 'a0000000-0000-4000-8000-0000000f8401';
select pg_temp.t('2e special on, then off', pg_temp.n('a0000000-0000-4000-8000-0000000f8401', 'special_on') = 1
  and pg_temp.n('a0000000-0000-4000-8000-0000000f8401', 'special_off') = 1);
update public.event_tasks set status = 'accepted', responded_at = now() where id = 'a0000000-0000-4000-8000-0000000f8401';
update public.event_tasks set status = 'in_progress', started_at = now() where id = 'a0000000-0000-4000-8000-0000000f8401';
update public.event_tasks set status = 'completed', completed_at = now() where id = 'a0000000-0000-4000-8000-0000000f8401';
select pg_temp.t('2f accepted, started, done: one row each',
  pg_temp.n('a0000000-0000-4000-8000-0000000f8401', 'accepted') = 1 and pg_temp.n('a0000000-0000-4000-8000-0000000f8401', 'started') = 1
  and pg_temp.n('a0000000-0000-4000-8000-0000000f8401', 'completed') = 1);
select pg_temp.t('2g the database editor is "system" (no signed-in user, no API call)',
  not exists (select 1 from public.event_task_log where task_id = 'a0000000-0000-4000-8000-0000000f8401' and actor_kind <> 'system'));

-- ---- 3) check-in / check-out ---------------------------------------------------------------------------------------------------------
insert into public.crew_checkins (org_id, quote_id, crew_id, work_day, check_in_at, late_min)
  values ('a0000000-0000-4000-8000-000000000001', 'a0000000-0000-4000-8000-00000000da01', 'a0000000-0000-4000-8000-0000000c8402',
          current_date, now() - interval '2 hours', 12);
update public.crew_checkins set check_out_at = now() - interval '10 minutes'
 where quote_id = 'a0000000-0000-4000-8000-00000000da01' and crew_id = 'a0000000-0000-4000-8000-0000000c8402';
select pg_temp.t('3a check-in and check-out rows, with the day and late minutes',
  exists (select 1 from public.event_task_log where crew_id = 'a0000000-0000-4000-8000-0000000c8402' and kind = 'check_in'
           and (detail ->> 'late_min')::int = 12 and detail ->> 'day' = current_date::text)
  and exists (select 1 from public.event_task_log where crew_id = 'a0000000-0000-4000-8000-0000000c8402' and kind = 'check_out'));

-- ---- 4) the timeline -------------------------------------------------------------------------------------------------------------------
-- an older task (made before 0368: no log rows) with step times, and a sent e-mail
alter table public.event_tasks disable trigger zzz_r368_task_log;
insert into public.event_tasks (id, quote_id, org_id, category, title, crew_id, assignee_name, assignee_phone, status, created_at, responded_at, started_at) values
  ('a0000000-0000-4000-8000-0000000f8403', 'a0000000-0000-4000-8000-00000000da01', 'a0000000-0000-4000-8000-000000000001', 'Catering', 'Welcome drinks',
   'a0000000-0000-4000-8000-0000000c8401', 'Ravi Desk', '+91 90000 84011', 'in_progress', now() - interval '3 days', now() - interval '2 days', now() - interval '1 day');
alter table public.event_tasks enable trigger zzz_r368_task_log;
insert into public.staff_email_outbox (org_id, quote_id, task_id, crew_id, kind, recipient, name, dedupe_key, status, sent_at)
  values ('a0000000-0000-4000-8000-000000000001', 'a0000000-0000-4000-8000-00000000da01', 'a0000000-0000-4000-8000-0000000f8401',
          'a0000000-0000-4000-8000-0000000c8402', 'task_reminder', 'mala84@example.org', 'Mala Cater', 'r184-test-1', 'sent', now() - interval '5 minutes');
insert into public.staff_update_outbox (org_id, quote_id, crew_id, recipient, name, changes, change_count, status, sent_at)
  values ('a0000000-0000-4000-8000-000000000001', 'a0000000-0000-4000-8000-00000000da01', 'a0000000-0000-4000-8000-0000000c8401',
          'ravi84@example.org', 'Ravi Desk', '[{"x":1}]'::jsonb, 1, 'sent', now() - interval '3 minutes');
create temp table _tl as select substr(pg_temp.as_val('a_admin@a.test', 'select public.event_day_activity(''a0000000-0000-4000-8000-00000000da01'', 200)::text'), 4)::jsonb as j;
grant select on _tl to anon, authenticated, service_role;
select pg_temp.t('4a as the studio admin: the timeline answers',
  pg_temp.as_val('a_admin@a.test', 'select jsonb_array_length(public.event_day_activity(''a0000000-0000-4000-8000-00000000da01'', 200))::text') ~ '^ok:[0-9]+$',
  pg_temp.as_val('a_admin@a.test', 'select jsonb_array_length(public.event_day_activity(''a0000000-0000-4000-8000-00000000da01'', 200))::text'));
select pg_temp.t('4b newest first',
  (select bool_and(coalesce((a.e ->> 'at')::timestamptz >= (b.e ->> 'at')::timestamptz, true))
     from (select e, row_number() over () as i from jsonb_array_elements((select j from _tl)) e) a
     join (select e, row_number() over () as i from jsonb_array_elements((select j from _tl)) e) b on b.i = a.i + 1));
select pg_temp.t('4c older task: assigned, accepted, started come from its step times (source task)',
  (select count(*) from jsonb_array_elements((select j from _tl)) e
    where e ->> 'task_id' = 'a0000000-0000-4000-8000-0000000f8403' and e ->> 'source' = 'task'
      and e ->> 'kind' in ('assigned', 'accepted', 'started')) = 3);
select pg_temp.t('4d logged task: no doubles from its step times (accepted / started / done appear once)',
  (select count(*) from jsonb_array_elements((select j from _tl)) e
    where e ->> 'task_id' = 'a0000000-0000-4000-8000-0000000f8401' and e ->> 'kind' in ('accepted', 'started', 'completed')) = 3);
select pg_temp.t('4e check-in / check-out once each (log, not doubled by the check-in table)',
  (select count(*) from jsonb_array_elements((select j from _tl)) e
    where e ->> 'crew_id' = 'a0000000-0000-4000-8000-0000000c8402' and e ->> 'kind' in ('check_in', 'check_out')) = 2);
select pg_temp.t('4f the sent reminder e-mail is listed, with its name',
  exists (select 1 from jsonb_array_elements((select j from _tl)) e where e ->> 'kind' = 'email_sent' and e ->> 'name' = 'Mala Cater'
           and e -> 'detail' ->> 'email_kind' = 'task_reminder'));
select pg_temp.t('4f2 the "your tasks were updated" e-mail is listed too',
  exists (select 1 from jsonb_array_elements((select j from _tl)) e where e ->> 'kind' = 'email_sent' and e ->> 'name' = 'Ravi Desk'
           and e -> 'detail' ->> 'email_kind' = 'task_update'));
select pg_temp.t('4g limit is honoured', pg_temp.as_val('a_admin@a.test', 'select jsonb_array_length(public.event_day_activity(''a0000000-0000-4000-8000-00000000da01'', 3))::text') = 'ok:3');
select pg_temp.t('4h another studio: refused', pg_temp.as_val('b_staff@b.test',
  'select public.event_day_activity(''a0000000-0000-4000-8000-00000000da01'', 50)::text') !~ '^ok:',
  pg_temp.as_val('b_staff@b.test', 'select public.event_day_activity(''a0000000-0000-4000-8000-00000000da01'', 50)::text'));
select pg_temp.t('4i anon: refused', pg_temp.as_val('anon',
  'select public.event_day_activity(''a0000000-0000-4000-8000-00000000da01'', 50)::text') !~ '^ok:');

-- ---- 5) a failing log write never blocks the task change -----------------------------------------------------------------------------
alter table public.event_task_log add constraint r184_test_block check (kind <> 'time_changed') not valid;
update public.event_tasks set planned_start = now() + interval '2 days' where id = 'a0000000-0000-4000-8000-0000000f8403';
select pg_temp.t('5a the start time still saved while the log refused the row',
  (select planned_start > now() + interval '1 day' from public.event_tasks where id = 'a0000000-0000-4000-8000-0000000f8403')
  and pg_temp.n('a0000000-0000-4000-8000-0000000f8403', 'time_changed') = 0);
alter table public.event_task_log drop constraint r184_test_block;

-- ---- 6) re-run safe + free-trial purge -------------------------------------------------------------------------------------------------
select pg_temp.t('6a triggers exist exactly once after two runs',
  (select count(*) from pg_trigger where tgrelid = 'public.event_tasks'::regclass and tgname = 'zzz_r368_task_log') = 1
  and (select count(*) from pg_trigger where tgrelid = 'public.crew_checkins'::regclass and tgname = 'zzz_r368_checkin_log') = 1);
select pg_temp.t('6b free-trial purge lists the log once',
  to_regprocedure('public._tr184_purge_tables()') is null
  or (length(pg_get_functiondef('public._tr184_purge_tables()'::regprocedure))
      - length(replace(pg_get_functiondef('public._tr184_purge_tables()'::regprocedure), '''event_task_log''', ''))) = length('''event_task_log'''));

select name, result from _rs order by name;
select case when (select count(*) from _rs where result <> 'PASS') = 0
            then 'R184-EVENT-ACTIVITY-0368: ALL PASS (' || (select count(*) from _rs) || '/' || (select count(*) from _rs) || ')'
            else 'R184-EVENT-ACTIVITY-0368: FAILURES' end as summary;
rollback;
