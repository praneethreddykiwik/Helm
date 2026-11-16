-- r171-staff-reminders-0362.sql - R171: timed reminder e-mails (10 / 5 min / at the start), the Send on WhatsApp button,
-- and the too-late guard on before-the-start reminder e-mails.
-- Proves: (1) privileges; (2) the every-minute timer + 0361 mirror give one e-mail per ticked time (10, 5, at the start) for
-- a task, each exactly once, nothing for a done task; (3) a before-the-start reminder e-mail still waiting 5+ minutes after
-- the start is skipped (too_late), a fresh one and a late reminder are not; (4) Send on WhatsApp: no connected number ->
-- wa_not_set_up and nothing queued; connected -> the 0132 assignment message is queued for that phone; again within 10
-- minutes -> just_sent; vendor / closed / other studio / anon refused; (5) re-run safe (old claim body kept once).
-- Re-applies 0362 twice (after 0361 if an older suite re-applied it). Local disposable PG only. Fake data only. Rolled back.
\set ON_ERROR_STOP 0
set client_min_messages = error;
\ir ../../supabase/migrations/0362_r171_staff_reminders.sql
\ir ../../supabase/migrations/0362_r171_staff_reminders.sql
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

-- fixture: studio A, a live future event, one staff member with e-mail + phone, one with phone but no e-mail
update public.organizations set timezone = 'Asia/Kolkata' where id = 'a0000000-0000-4000-8000-000000000001';
update public.quotes set deleted_at = null, status = 'confirmed', title = 'Rao Wedding', event_date = (now() + interval '2 days')::date, is_demo = false,
       manager_id = (select id from auth.users where email = 'a_admin@a.test')
 where id = 'a0000000-0000-4000-8000-00000000da01';
delete from public.automation_settings where org_id = 'a0000000-0000-4000-8000-000000000001';
delete from public.task_reminder_settings where org_id = 'a0000000-0000-4000-8000-000000000001';
delete from public.org_whatsapp_accounts where org_id = 'a0000000-0000-4000-8000-000000000001';
insert into public.crew_members (id, name, phone, email, org_id, profile_id) values
  ('a0000000-0000-4000-8000-0000000c3711', 'Guest Desk', '+91 90000 37111', 'desk@example.org', 'a0000000-0000-4000-8000-000000000001', null),
  ('a0000000-0000-4000-8000-0000000c3712', 'Cater Lead', '+91 90000 37112', 'cater@example.org', 'a0000000-0000-4000-8000-000000000001', null);
-- guests arrive at T (a whole minute, 2 hours from now); reminders ticked 10, 5 and at the start time
create temp table _t as select date_trunc('minute', now()) + interval '2 hours' as t;
insert into public.event_tasks (id, quote_id, org_id, category, title, crew_id, assignee_name, assignee_phone, status, planned_start, remind_before) values
  ('a0000000-0000-4000-8000-0000000f3711', 'a0000000-0000-4000-8000-00000000da01', 'a0000000-0000-4000-8000-000000000001', 'Guests', 'Receive guests',
   'a0000000-0000-4000-8000-0000000c3711', 'Guest Desk', '+91 90000 37111', 'assigned', (select t from _t), '{10,5,0}'),
  ('a0000000-0000-4000-8000-0000000f3712', 'a0000000-0000-4000-8000-00000000da01', 'a0000000-0000-4000-8000-000000000001', 'Catering', 'Welcome drinks',
   'a0000000-0000-4000-8000-0000000c3712', 'Cater Lead', '+91 90000 37112', 'completed', (select t from _t), '{10,5,0}');
create or replace function pg_temp.rem(p_task uuid) returns integer language sql as $$
  select count(*)::integer from public.staff_email_outbox where task_id = p_task and kind = 'task_reminder' $$;

-- ---- 1) privileges ----------------------------------------------------------------------------------------------------------
select pg_temp.t('1a Send on WhatsApp: signed-in staff only', has_function_privilege('authenticated', 'public.staff_whatsapp_send(uuid)', 'execute')
  and not has_function_privilege('anon', 'public.staff_whatsapp_send(uuid)', 'execute'));
select pg_temp.t('1b claim (old + new) and timer info: server only', not has_function_privilege('authenticated', 'public.staff_email_claim(integer)', 'execute')
  and not has_function_privilege('authenticated', 'public.staff_email_claim__pre0362(integer)', 'execute')
  and not has_function_privilege('anon', 'public._r362_dispatch_schedule()', 'execute')
  and has_function_privilege('service_role', 'public.staff_email_claim(integer)', 'execute'));
select pg_temp.t('1c timer info answers text without failing', length(public._r362_dispatch_schedule()) > 0);

-- ---- 2) 10 min, 5 min, at the start: one e-mail each -------------------------------------------------------------------------
select public.task_reminder_tick((select t from _t) - interval '10 minutes');
select pg_temp.t('2a 10 minutes before: one reminder e-mail', pg_temp.rem('a0000000-0000-4000-8000-0000000f3711') = 1,
  pg_temp.rem('a0000000-0000-4000-8000-0000000f3711')::text);
select public.task_reminder_tick((select t from _t) - interval '10 minutes' + interval '30 seconds');
select pg_temp.t('2b the same minute again: still one', pg_temp.rem('a0000000-0000-4000-8000-0000000f3711') = 1);
select public.task_reminder_tick((select t from _t) - interval '5 minutes');
select pg_temp.t('2c 5 minutes before: a second e-mail', pg_temp.rem('a0000000-0000-4000-8000-0000000f3711') = 2);
select public.task_reminder_tick((select t from _t));
select pg_temp.t('2d at the start time: a third e-mail (due now)', pg_temp.rem('a0000000-0000-4000-8000-0000000f3711') = 3);
select public.task_reminder_tick((select t from _t) + interval '1 minute');
select pg_temp.t('2e nothing more before the late window', pg_temp.rem('a0000000-0000-4000-8000-0000000f3711') = 3);
select pg_temp.t('2f the e-mails go to the staff record address, keyed per reminder time',
  (select count(distinct dedupe_key) = 3 and bool_and(recipient = 'desk@example.org') and bool_and(ref_start = (select t from _t))
     from public.staff_email_outbox where task_id = 'a0000000-0000-4000-8000-0000000f3711' and kind = 'task_reminder'));
select pg_temp.t('2g a completed task gets no reminder', pg_temp.rem('a0000000-0000-4000-8000-0000000f3712') = 0);
-- the reminders are due now and the start is in the future: the claim sends them (not too late)
update public.staff_email_outbox set not_before = now() - interval '1 second' where sent_at is null;
create temp table _c as select x from jsonb_array_elements(public.staff_email_claim(25)) x;
select pg_temp.t('2h the claim hands the reminders to comms-dispatch', (select count(*) from _c where x ->> 'kind' = 'task_reminder') = 3,
  (select count(*)::text from _c));
select pg_temp.t('2i minutes left is filled in at send time', (select bool_and((x ->> 'minutes')::integer between 100 and 121) from _c where x ->> 'kind' = 'task_reminder'));

-- ---- 3) too late ------------------------------------------------------------------------------------------------------------
update public.staff_email_outbox set status = 'sent', sent_at = now() where sent_at is null;
update public.event_tasks set planned_start = now() - interval '10 minutes' where id = 'a0000000-0000-4000-8000-0000000f3711';
insert into public.staff_email_outbox (org_id, quote_id, task_id, crew_id, phone, kind, recipient, name, dedupe_key, ref_start, not_before) values
  ('a0000000-0000-4000-8000-000000000001', 'a0000000-0000-4000-8000-00000000da01', 'a0000000-0000-4000-8000-0000000f3711', 'a0000000-0000-4000-8000-0000000c3711',
   '919000037111', 'task_reminder', 'desk@example.org', 'Guest Desk', 'r171|old-before', (select planned_start from public.event_tasks where id = 'a0000000-0000-4000-8000-0000000f3711'), now() - interval '1 minute'),
  ('a0000000-0000-4000-8000-000000000001', 'a0000000-0000-4000-8000-00000000da01', 'a0000000-0000-4000-8000-0000000f3711', 'a0000000-0000-4000-8000-0000000c3711',
   '919000037111', 'task_late', 'desk@example.org', 'Guest Desk', 'r171|late', (select planned_start from public.event_tasks where id = 'a0000000-0000-4000-8000-0000000f3711'), now() - interval '1 minute');
create temp table _c2 as select x from jsonb_array_elements(public.staff_email_claim(25)) x;
select pg_temp.t('3a a before-the-start reminder 10 minutes after the start is not sent (too_late)',
  (select status || '/' || reason from public.staff_email_outbox where dedupe_key = 'r171|old-before') = 'skipped/too_late',
  (select status || '/' || coalesce(reason, '') from public.staff_email_outbox where dedupe_key = 'r171|old-before'));
select pg_temp.t('3b a late reminder for the same time still goes', (select count(*) from _c2 where x ->> 'kind' = 'task_late') = 1);
update public.staff_email_outbox set status = 'sent', sent_at = now() where sent_at is null;
update public.event_tasks set planned_start = now() - interval '2 minutes' where id = 'a0000000-0000-4000-8000-0000000f3711';
insert into public.staff_email_outbox (org_id, quote_id, task_id, crew_id, phone, kind, recipient, name, dedupe_key, ref_start, not_before) values
  ('a0000000-0000-4000-8000-000000000001', 'a0000000-0000-4000-8000-00000000da01', 'a0000000-0000-4000-8000-0000000f3711', 'a0000000-0000-4000-8000-0000000c3711',
   '919000037111', 'task_reminder', 'desk@example.org', 'Guest Desk', 'r171|due-now', (select planned_start from public.event_tasks where id = 'a0000000-0000-4000-8000-0000000f3711'), now() - interval '1 minute');
create temp table _c3 as select x from jsonb_array_elements(public.staff_email_claim(25)) x;
select pg_temp.t('3c a due-now reminder 2 minutes after the start still goes', (select count(*) from _c3 where x ->> 'kind' = 'task_reminder') = 1);
update public.staff_email_outbox set status = 'sent', sent_at = now() where sent_at is null;
update public.event_tasks set planned_start = (select t from _t) where id = 'a0000000-0000-4000-8000-0000000f3711';

-- ---- 4) Send on WhatsApp ------------------------------------------------------------------------------------------------------
delete from public.assign_notify_outbox where org_id = 'a0000000-0000-4000-8000-000000000001';
select pg_temp.t('4a no WhatsApp number connected -> wa_not_set_up', pg_temp.as_val('a_admin@a.test',
  $q$select public.staff_whatsapp_send('a0000000-0000-4000-8000-0000000f3711') ->> 'reason'$q$) = 'ok:wa_not_set_up');
select pg_temp.t('4b ... and nothing is queued', (select count(*) from public.assign_notify_outbox where org_id = 'a0000000-0000-4000-8000-000000000001') = 0);
insert into public.org_whatsapp_accounts (org_id, waba_id, phone_number_id, display_phone, token_secret_id, status)
  values ('a0000000-0000-4000-8000-000000000001', '1234567', '7654321', '+91 90000 00000', gen_random_uuid(), 'connected');
select pg_temp.t('4c connected -> queued', pg_temp.as_val('a_admin@a.test',
  $q$select public.staff_whatsapp_send('a0000000-0000-4000-8000-0000000f3711') ->> 'ok'$q$) = 'ok:true');
select pg_temp.t('4d the 0132 assignment message for that person and task', (select count(*) = 1 and bool_and(item_kind = 'task' and phone = '919000037111')
  from public.assign_notify_outbox where item_id = 'a0000000-0000-4000-8000-0000000f3711'),
  (select string_agg(item_kind || ':' || phone, ',') from public.assign_notify_outbox where item_id = 'a0000000-0000-4000-8000-0000000f3711'));
update public.assign_notify_outbox set claimed_at = now(), sent_at = now(), status = 'sent' where item_id = 'a0000000-0000-4000-8000-0000000f3711';
select pg_temp.t('4e again within 10 minutes -> just_sent', pg_temp.as_val('a_admin@a.test',
  $q$select public.staff_whatsapp_send('a0000000-0000-4000-8000-0000000f3711') ->> 'reason'$q$) = 'ok:just_sent');
select pg_temp.t('4f a completed task -> closed', pg_temp.as_val('a_admin@a.test',
  $q$select public.staff_whatsapp_send('a0000000-0000-4000-8000-0000000f3712') ->> 'reason'$q$) = 'ok:closed');
select pg_temp.t('4g another studio cannot use it on this task', pg_temp.as_val('b_admin@b.test',
  $q$select public.staff_whatsapp_send('a0000000-0000-4000-8000-0000000f3711')::text$q$) not like 'ok:%');
select pg_temp.t('4h not signed in -> refused', pg_temp.as_val('anon',
  $q$select public.staff_whatsapp_send('a0000000-0000-4000-8000-0000000f3711')::text$q$) not like 'ok:%');
update public.event_tasks set assignee_kind = 'outsourced' where id = 'a0000000-0000-4000-8000-0000000f3711';
select pg_temp.t('4i a vendor task -> vendor', pg_temp.as_val('a_admin@a.test',
  $q$select public.staff_whatsapp_send('a0000000-0000-4000-8000-0000000f3711') ->> 'reason'$q$) = 'ok:vendor');

-- ---- 5) re-run safe ---------------------------------------------------------------------------------------------------------
select pg_temp.t('5a old claim body kept once, the new claim is the R171 one',
  to_regprocedure('public.staff_email_claim__pre0362(integer)') is not null and to_regprocedure('public.staff_email_claim__pre0362__pre0362(integer)') is null
  and position('r171-0362' in pg_get_functiondef(to_regprocedure('public.staff_email_claim(integer)'))) > 0
  and position('r171-0362' in pg_get_functiondef(to_regprocedure('public.staff_email_claim__pre0362(integer)'))) = 0);

do $$ declare n int; f int; r record; begin
  select count(*), count(*) filter (where result <> 'PASS') into n, f from _rs;
  for r in select * from _rs where result <> 'PASS' loop raise warning '% -> %', r.name, r.result; end loop;
  if f = 0 then raise warning 'R171-STAFF-REMINDERS-0362: ALL PASS (%/%)', n, n;
  else raise warning 'R171-STAFF-REMINDERS-0362: % FAILED of %', f, n; end if;
end $$;
rollback;
