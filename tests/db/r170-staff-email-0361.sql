-- r170-staff-email-0361.sql - R170: tasks and task reminders by e-mail to staff (staff_email_outbox).
-- Proves: (1) structure + privileges; (2) a task given to someone queues ONE e-mail per person per event (tasks given together
-- merge), waiting one minute; (3) the address comes from the staff record, else the linked login; no address = nothing;
-- vendor tasks and the switch off = nothing; (4) claim lists that person's open tasks, with the studio identity and work link;
-- (5) a reassigned task: the new person is queued, the old e-mail fails closed at claim; (6) every queued WhatsApp reminder is
-- also an e-mail (late too), skipped ones are not, the office alert goes to the event manager even with no manager phone;
-- (7) a changed start time = the reminder e-mail is skipped at claim; (8) Send by email buttons: own studio + Staff edit only,
-- address never from the page, masked answer, one per 2 minutes, no address -> no_email; (9) the assign-form box unticked
-- cancels the waiting e-mail; (10) Settings -> Automations switch; other switches unchanged; (11) mark; (12) re-run safe.
-- Re-applies 0361 twice. Local disposable PG only. Fake data only. Rolled back.
\set ON_ERROR_STOP 0
set client_min_messages = error;
\ir ../../supabase/migrations/0361_r170_staff_email.sql
\ir ../../supabase/migrations/0361_r170_staff_email.sql
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
-- every waiting row is due now (the one-minute merge wait is proven separately)
create or replace function pg_temp.due() returns void language sql as $$ update public.staff_email_outbox set not_before = now() - interval '1 second' where sent_at is null $$;
create or replace function pg_temp.n(p_kind text, p_to text, p_status text default 'pending') returns integer language sql as $$
  select count(*)::integer from public.staff_email_outbox where kind = p_kind and recipient = p_to and status = p_status $$;

-- fixture: studio A, a live event with a manager, three staff (with e-mail / linked login only / no e-mail)
update public.quotes set deleted_at = null, status = 'confirmed', title = 'Rao Wedding', event_date = '2026-12-01', is_demo = false,
       manager_id = (select id from auth.users where email = 'a_admin@a.test')
 where id = 'a0000000-0000-4000-8000-00000000da01';
delete from public.automation_settings where org_id = 'a0000000-0000-4000-8000-000000000001';
insert into public.crew_members (id, name, phone, email, org_id, profile_id) values
  ('a0000000-0000-4000-8000-0000000c3601', 'Ravi Kumar', '+91 90000 36101', 'Ravi.K@Example.org', 'a0000000-0000-4000-8000-000000000001', null),
  ('a0000000-0000-4000-8000-0000000c3602', 'Staff Login', '+91 90000 36102', null, 'a0000000-0000-4000-8000-000000000001', (select id from auth.users where email = 'a_staff@a.test')),
  ('a0000000-0000-4000-8000-0000000c3603', 'No Mail', '+91 90000 36103', null, 'a0000000-0000-4000-8000-000000000001', null);

-- ---- 1) structure ------------------------------------------------------------------------------------------------------
select pg_temp.t('1a the queue is closed to the app', not has_table_privilege('authenticated', 'public.staff_email_outbox', 'select')
  and not has_table_privilege('anon', 'public.staff_email_outbox', 'select') and not has_table_privilege('authenticated', 'public.staff_email_outbox', 'insert'));
select pg_temp.t('1b claim / mark: server only', not has_function_privilege('authenticated', 'public.staff_email_claim(integer)', 'execute')
  and not has_function_privilege('anon', 'public.staff_email_mark(uuid,text)', 'execute') and has_function_privilege('service_role', 'public.staff_email_claim(integer)', 'execute'));
select pg_temp.t('1c buttons: signed-in only', has_function_privilege('authenticated', 'public.staff_email_send(uuid,boolean)', 'execute')
  and not has_function_privilege('anon', 'public.staff_email_send(uuid,boolean)', 'execute')
  and not has_function_privilege('anon', 'public.staff_email_hold(uuid,uuid)', 'execute'));
select pg_temp.t('1d switch default on', public._r361_on('a0000000-0000-4000-8000-000000000001'));

-- ---- 2) a task given to someone ----------------------------------------------------------------------------------------
insert into public.event_tasks (id, quote_id, org_id, category, title, crew_id, assignee_name, assignee_phone, status, planned_start) values
  ('a0000000-0000-4000-8000-0000000f3601', 'a0000000-0000-4000-8000-00000000da01', 'a0000000-0000-4000-8000-000000000001', 'Stage', 'Stage lights', 'a0000000-0000-4000-8000-0000000c3601', 'Ravi Kumar', '+91 90000 36101', 'assigned', '2026-12-01 12:30+05:30'),
  ('a0000000-0000-4000-8000-0000000f3602', 'a0000000-0000-4000-8000-00000000da01', 'a0000000-0000-4000-8000-000000000001', 'Stage', 'Sound check', 'a0000000-0000-4000-8000-0000000c3601', 'Ravi Kumar', '+91 90000 36101', 'assigned', '2026-12-01 12:00+05:30'),
  ('a0000000-0000-4000-8000-0000000f3603', 'a0000000-0000-4000-8000-00000000da01', 'a0000000-0000-4000-8000-000000000001', 'Decor', 'Flower arch', 'a0000000-0000-4000-8000-0000000c3601', 'Ravi Kumar', '+91 90000 36101', 'assigned', null);
select pg_temp.t('2a three tasks given together = ONE e-mail, to the lower-cased staff address', pg_temp.n('task_assigned', 'ravi.k@example.org') = 1,
  (select count(*)::text from public.staff_email_outbox));
select pg_temp.t('2b it waits about a minute (so more tasks can join it)', (select bool_and(not_before > now() + interval '50 seconds') from public.staff_email_outbox where kind = 'task_assigned'));
select pg_temp.t('2c nothing is claimed before the wait is over', jsonb_array_length(public.staff_email_claim(25)) = 0);
-- a later task (another transaction) joins the same waiting e-mail
update public.staff_email_outbox set created_at = now() - interval '30 seconds' where kind = 'task_assigned';
insert into public.event_tasks (id, quote_id, org_id, category, title, crew_id, assignee_name, assignee_phone, status) values
  ('a0000000-0000-4000-8000-0000000f3604', 'a0000000-0000-4000-8000-00000000da01', 'a0000000-0000-4000-8000-000000000001', 'Decor', 'Table runners', 'a0000000-0000-4000-8000-0000000c3601', 'Ravi Kumar', '+91 90000 36101', 'assigned');
select pg_temp.t('2d a later task joins the waiting e-mail (still one)', pg_temp.n('task_assigned', 'ravi.k@example.org') = 1);
-- an edit that does not change the person queues nothing new
update public.event_tasks set title = 'Stage lights + spots' where id = 'a0000000-0000-4000-8000-0000000f3601';
select pg_temp.t('2e a title change does not queue another e-mail', (select count(*) from public.staff_email_outbox) = 1);

-- ---- 3) the address ----------------------------------------------------------------------------------------------------
insert into public.event_tasks (id, quote_id, org_id, category, title, crew_id, assignee_name, assignee_phone, status) values
  ('a0000000-0000-4000-8000-0000000f3605', 'a0000000-0000-4000-8000-00000000da01', 'a0000000-0000-4000-8000-000000000001', 'Food', 'Buffet', 'a0000000-0000-4000-8000-0000000c3602', 'Staff Login', '+91 90000 36102', 'assigned'),
  ('a0000000-0000-4000-8000-0000000f3606', 'a0000000-0000-4000-8000-00000000da01', 'a0000000-0000-4000-8000-000000000001', 'Food', 'Drinks', 'a0000000-0000-4000-8000-0000000c3603', 'No Mail', '+91 90000 36103', 'assigned');
select pg_temp.t('3a no e-mail on the staff record -> the linked login e-mail', pg_temp.n('task_assigned', 'a_staff@a.test') = 1);
select pg_temp.t('3b no address at all -> nothing queued', (select count(*) from public.staff_email_outbox where crew_id = 'a0000000-0000-4000-8000-0000000c3603') = 0);
insert into public.event_tasks (id, quote_id, org_id, category, title, assignee_name, assignee_kind, status) values
  ('a0000000-0000-4000-8000-0000000f3607', 'a0000000-0000-4000-8000-00000000da01', 'a0000000-0000-4000-8000-000000000001', 'Decor', 'Lights hire', 'Vendor Co', 'outsourced', 'assigned');
select pg_temp.t('3c a vendor task -> nothing here', (select count(*) from public.staff_email_outbox where task_id = 'a0000000-0000-4000-8000-0000000f3607') = 0);
insert into public.automation_settings (org_id, staff_email_enabled) values ('a0000000-0000-4000-8000-000000000001', false);
update public.event_tasks set crew_id = 'a0000000-0000-4000-8000-0000000c3602', assignee_name = 'Staff Login', assignee_phone = '+91 90000 36102'
 where id = 'a0000000-0000-4000-8000-0000000f3606';
select pg_temp.t('3d studio switch off -> the automatic e-mail is not queued', pg_temp.n('task_assigned', 'a_staff@a.test') = 1);
update public.automation_settings set staff_email_enabled = true where org_id = 'a0000000-0000-4000-8000-000000000001';
update public.event_tasks set crew_id = 'a0000000-0000-4000-8000-0000000c3603', assignee_name = 'No Mail', assignee_phone = '+91 90000 36103'
 where id = 'a0000000-0000-4000-8000-0000000f3606';

-- ---- 4) claim -----------------------------------------------------------------------------------------------------------
select pg_temp.due();
create temp table _c as select x from jsonb_array_elements(public.staff_email_claim(25)) x;
select pg_temp.t('4a two e-mails claimed (Ravi, the linked login)', (select count(*) from _c) = 2, (select count(*)::text from _c));
select pg_temp.t('4b Ravi gets his four open tasks, earliest start first, event + studio + identity',
  (select jsonb_array_length(x -> 'tasks') = 4 and x -> 'tasks' -> 0 ->> 'title' = 'Sound check' and x ->> 'event' = 'Rao Wedding'
          and x ->> 'studio' is not null and x ? 'identity' and x ->> 'kind' = 'task_assigned'
     from _c where x ->> 'to' = 'ravi.k@example.org'), (select x::text from _c where x ->> 'to' = 'ravi.k@example.org'));
select pg_temp.t('4c a claimed row is not handed out twice', jsonb_array_length(public.staff_email_claim(25)) = 0);

-- ---- 5) reassigned -------------------------------------------------------------------------------------------------------
update public.staff_email_outbox set status = 'sent', sent_at = now() where sent_at is null;
update public.event_tasks set crew_id = 'a0000000-0000-4000-8000-0000000c3602', assignee_name = 'Staff Login', assignee_phone = '+91 90000 36102'
 where id = 'a0000000-0000-4000-8000-0000000f3604';
select pg_temp.t('5a the new person gets an e-mail', pg_temp.n('task_assigned', 'a_staff@a.test') = 1);
insert into public.staff_email_outbox (org_id, quote_id, task_id, crew_id, phone, kind, recipient, name, dedupe_key)
  values ('a0000000-0000-4000-8000-000000000001', 'a0000000-0000-4000-8000-00000000da01', 'a0000000-0000-4000-8000-0000000f3604',
          'a0000000-0000-4000-8000-0000000c3601', '919000036101', 'task_one', 'ravi.k@example.org', 'Ravi Kumar', 'test|old-person');
select pg_temp.due();
select public.staff_email_claim(25);
select pg_temp.t('5b the old person''s single-task e-mail fails closed (task moved)',
  (select status || '/' || reason from public.staff_email_outbox where dedupe_key = 'test|old-person') = 'skipped/task_changed',
  (select status || '/' || coalesce(reason, '') from public.staff_email_outbox where dedupe_key = 'test|old-person'));
update public.staff_email_outbox set status = 'sent', sent_at = now() where sent_at is null;

-- ---- 6) reminders --------------------------------------------------------------------------------------------------------
insert into public.task_wa_outbox (org_id, quote_id, task_id, kind, slot, slot_key, phone, name, template, status, reason) values
  ('a0000000-0000-4000-8000-000000000001', 'a0000000-0000-4000-8000-00000000da01', 'a0000000-0000-4000-8000-0000000f3601', 'reminder', 'b10', 'r170|b10', '919000036101', 'Ravi Kumar', 'staff_task_reminder', 'queued', null),
  ('a0000000-0000-4000-8000-000000000001', 'a0000000-0000-4000-8000-00000000da01', 'a0000000-0000-4000-8000-0000000f3601', 'reminder', 'b30', 'r170|b30', '919000036101', 'Ravi Kumar', 'staff_task_reminder', 'skipped', 'superseded'),
  ('a0000000-0000-4000-8000-000000000001', 'a0000000-0000-4000-8000-00000000da01', 'a0000000-0000-4000-8000-0000000f3602', 'late', 'late1', 'r170|late1', '919000036101', 'Ravi Kumar', 'staff_task_overdue', 'queued', null),
  ('a0000000-0000-4000-8000-000000000001', 'a0000000-0000-4000-8000-00000000da01', 'a0000000-0000-4000-8000-0000000f3602', 'office_alert', 'alert', 'r170|alert', null, null, 'office_staff_alert', 'skipped', 'no_event_manager_phone');
select pg_temp.t('6a a queued reminder is also an e-mail', pg_temp.n('task_reminder', 'ravi.k@example.org') = 1);
select pg_temp.t('6b a skipped (superseded) reminder is not', (select count(*) from public.staff_email_outbox where dedupe_key = 'rem|r170|b30') = 0);
select pg_temp.t('6c late reminder e-mailed too', pg_temp.n('task_late', 'ravi.k@example.org') = 1);
select pg_temp.t('6d office alert goes to the event manager by e-mail even without a manager phone', pg_temp.n('office_alert', 'a_admin@a.test') = 1);
insert into public.task_wa_outbox (org_id, quote_id, task_id, kind, slot, slot_key, phone, name, template, status)
  values ('a0000000-0000-4000-8000-000000000001', 'a0000000-0000-4000-8000-00000000da01', 'a0000000-0000-4000-8000-0000000f3601', 'reminder', 'b10', 'r170|b10', '919000036101', 'Ravi Kumar', 'staff_task_reminder', 'queued')
  on conflict (slot_key) do nothing;
select pg_temp.t('6e the same reminder slot never queues twice', pg_temp.n('task_reminder', 'ravi.k@example.org') = 1);

-- ---- 7) claim of reminders ------------------------------------------------------------------------------------------------
update public.event_tasks set planned_start = '2026-12-01 13:30+05:30' where id = 'a0000000-0000-4000-8000-0000000f3602';
create temp table _r as select x from jsonb_array_elements(public.staff_email_claim(25)) x;
select pg_temp.t('7a reminder claimed with task, start and work link fields',
  (select x ->> 'task' = 'Stage lights + spots' and x ->> 'start' is not null and x ? 'minutes' from _r where x ->> 'kind' = 'task_reminder'),
  (select string_agg(x::text, ' ; ') from _r));
select pg_temp.t('7b a changed start time -> the late e-mail is skipped at claim',
  (select status || '/' || reason from public.staff_email_outbox where kind = 'task_late') = 'skipped/task_changed');
select pg_temp.t('7c office alert claimed with the Live Status link',
  (select x ->> 'link_path' = 'ops.html?quote=a0000000-0000-4000-8000-00000000da01' from _r where x ->> 'kind' = 'office_alert'));

-- ---- 8) Send by email buttons -----------------------------------------------------------------------------------------------
select pg_temp.t('8a the office sends a task list: ok + masked address only',
  pg_temp.as_val('a_admin@a.test', $q$select public.staff_email_send('a0000000-0000-4000-8000-0000000f3601', true)::text$q$)
    like 'ok:%"ok": true%"masked": "r***@example.org"%',
  pg_temp.as_val('a_admin@a.test', $q$select public.staff_email_send('a0000000-0000-4000-8000-0000000f3601', true)::text$q$));
select pg_temp.t('8b a second click within 2 minutes is not sent again',
  pg_temp.as_val('a_admin@a.test', $q$select public.staff_email_send('a0000000-0000-4000-8000-0000000f3601', true) ->> 'reason'$q$) = 'ok:just_sent');
select pg_temp.t('8c one task only is its own e-mail', pg_temp.as_val('a_admin@a.test',
  $q$select public.staff_email_send('a0000000-0000-4000-8000-0000000f3601', false) ->> 'ok'$q$) = 'ok:true' and pg_temp.n('task_one', 'ravi.k@example.org') = 1);
select pg_temp.t('8d staff with no address -> no_email (nothing queued)', pg_temp.as_val('a_admin@a.test',
  $q$select public.staff_email_send('a0000000-0000-4000-8000-0000000f3606', true) ->> 'reason'$q$) = 'ok:no_email');
select pg_temp.t('8e another studio cannot send for this task', pg_temp.as_val('b_admin@b.test',
  $q$select public.staff_email_send('a0000000-0000-4000-8000-0000000f3601', true)::text$q$) like 'P0002%');
select pg_temp.t('8f anon refused', pg_temp.as_val('anon', $q$select public.staff_email_send('a0000000-0000-4000-8000-0000000f3601', true)::text$q$) like '42501%');
select pg_temp.t('8g a vendor task is not e-mailed from here', pg_temp.as_val('a_admin@a.test',
  $q$select public.staff_email_send('a0000000-0000-4000-8000-0000000f3607', true) ->> 'reason'$q$) = 'ok:vendor');

-- ---- 9) assign form box unticked -------------------------------------------------------------------------------------------
update public.staff_email_outbox set status = 'sent', sent_at = now() where sent_at is null;
insert into public.event_tasks (id, quote_id, org_id, category, title, crew_id, assignee_name, assignee_phone, status) values
  ('a0000000-0000-4000-8000-0000000f3608', 'a0000000-0000-4000-8000-00000000da01', 'a0000000-0000-4000-8000-000000000001', 'Stage', 'Mic check', 'a0000000-0000-4000-8000-0000000c3601', 'Ravi Kumar', '+91 90000 36101', 'assigned');
select pg_temp.t('9a unticked: the waiting e-mail is cancelled', pg_temp.as_val('a_admin@a.test',
  $q$select public.staff_email_hold('a0000000-0000-4000-8000-00000000da01', 'a0000000-0000-4000-8000-0000000c3601')::text$q$) = 'ok:1'
  and pg_temp.n('task_assigned', 'ravi.k@example.org', 'skipped') = 1);
select pg_temp.t('9b another studio cancels nothing', pg_temp.as_val('b_admin@b.test',
  $q$select public.staff_email_hold('a0000000-0000-4000-8000-00000000da01', 'a0000000-0000-4000-8000-0000000c3601')::text$q$) = 'ok:0');

-- ---- 10) Settings -> Automations ---------------------------------------------------------------------------------------------
select pg_temp.t('10a the overview shows the staff e-mail switch (on)', pg_temp.as_val('a_admin@a.test',
  $q$select public.automation_overview() -> 'on' ->> 'staff_email'$q$) = 'ok:true');
insert into public.event_tasks (id, quote_id, org_id, category, title, crew_id, assignee_name, assignee_phone, status) values
  ('a0000000-0000-4000-8000-0000000f3609', 'a0000000-0000-4000-8000-00000000da01', 'a0000000-0000-4000-8000-000000000001', 'Stage', 'Cables', 'a0000000-0000-4000-8000-0000000c3601', 'Ravi Kumar', '+91 90000 36101', 'assigned');
create temp table _sw as select pg_temp.as_val('a_admin@a.test', $q$select public.automation_switch('staff_email', false) -> 'on' ->> 'staff_email'$q$) v;
select pg_temp.t('10b switching off: saved, and the waiting automatic e-mail is not sent', (select v from _sw) = 'ok:false'
  and (select reason from public.staff_email_outbox where task_id = 'a0000000-0000-4000-8000-0000000f3609') = 'switched_off', (select v from _sw));
select pg_temp.t('10c other switches still go through the 0274 body', pg_temp.as_val('a_admin@a.test',
  $q$select public.automation_switch('assign_whatsapp', true) -> 'on' ->> 'assign_whatsapp'$q$) = 'ok:true');
select pg_temp.t('10d anon cannot switch it', pg_temp.as_val('anon',
  $q$select public.automation_switch('staff_email', true)::text$q$) like '42501%');
select pg_temp.t('10e the buttons still work with the switch off (an office action)', pg_temp.as_val('a_admin@a.test',
  $q$select public.staff_email_send('a0000000-0000-4000-8000-0000000f3609', false) ->> 'ok'$q$) = 'ok:true');

-- ---- 11) mark --------------------------------------------------------------------------------------------------------------
update public.automation_settings set staff_email_enabled = true where org_id = 'a0000000-0000-4000-8000-000000000001';
select pg_temp.due();
create temp table _m as select x from jsonb_array_elements(public.staff_email_claim(25)) x;
create temp table _m1 as select ((select x from _m limit 1) ->> 'id')::uuid id, public.staff_email_mark(((select x from _m limit 1) ->> 'id')::uuid, 'retry') r;
select pg_temp.t('11a retry hands the row back', (select r from _m1) = 'pending'
  and (select claimed_at is null and status = 'pending' from public.staff_email_outbox where id = (select id from _m1)));
create temp table _m2 as select public.staff_email_mark((select id from _m1), 'sent') r;
select pg_temp.t('11b sent is final', (select r from _m2) = 'sent'
  and (select status from public.staff_email_outbox where id = (select id from _m1)) = 'sent');
select pg_temp.t('11c a bad status is refused', pg_temp.as_val(null, $q$select public.staff_email_mark(gen_random_uuid(), 'boom')$q$) like '22023%');

-- ---- 12) re-run safe ---------------------------------------------------------------------------------------------------------
select pg_temp.t('12a one trigger each, kept bodies once', (select count(*) = 1 from pg_trigger where tgname = 'zzz_r361_task_email')
  and (select count(*) = 1 from pg_trigger where tgname = 'zzz_r361_reminder_email')
  and to_regprocedure('public.automation_overview__pre0361()') is not null and to_regprocedure('public.automation_overview__pre0361__pre0361()') is null);

do $$ declare n int; f int; r record; begin
  select count(*), count(*) filter (where result <> 'PASS') into n, f from _rs;
  for r in select * from _rs where result <> 'PASS' loop raise warning '% -> %', r.name, r.result; end loop;
  if f = 0 then raise warning 'R170-STAFF-EMAIL-0361: ALL PASS (%/%)', n, n;
  else raise warning 'R170-STAFF-EMAIL-0361: % FAILED of %', f, n; end if;
end $$;
rollback;
