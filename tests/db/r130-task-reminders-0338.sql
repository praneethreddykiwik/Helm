-- r130-task-reminders-0338.sql - R130: WhatsApp task reminders (studio's own number), late reminders, office alert, statuses.
-- Proves: (1) structure + privileges; (2) settings: defaults, who may read / change, bad values refused; (3) per-task times;
-- (4) the owner's example: a 12:30 task with 10, 5, 3 ticked queues at 12:20, 12:25, 12:27, and marking it done at 12:26
-- stops the last one; (5) missed times: only the latest goes, the rest "skipped"; (6) late: every 15 min up to 3, then the
-- office (bell + event manager); (7) hold while waiting, then one reminder once the earlier task is done; (8) a new person or
-- a new time = a fresh set, the old queued row is skipped at claim; (9) studio switch off = nothing; (10) task assigned /
-- open shift fields filled on insert; (11) Meta ticks move the status forward only; (12) Live Status summary has no phone;
-- (13) re-run safe. Re-applies 0338 twice. Local disposable PG only. Fake data only. Rolled back.
\set ON_ERROR_STOP 0
set client_min_messages = error;
\ir ../../supabase/migrations/0338_r130_task_reminders.sql
\ir ../../supabase/migrations/0338_r130_task_reminders.sql
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
-- 12:30 India on 1 Dec 2026 = 07:00 UTC; ist('12:20') -> that minute
create or replace function pg_temp.ist(p text) returns timestamptz language sql as $$ select ('2026-12-01 ' || p || ':00+05:30')::timestamptz $$;
create or replace function pg_temp.rows(p_task uuid, p_status text default null) returns text language sql as $$
  select coalesce(string_agg(slot, ',' order by due_at, slot), '') from public.task_wa_outbox where task_id = p_task and (p_status is null or status = p_status) $$;

-- fixture: studio A in India time, an event, its manager on the staff list, tasks
update public.organizations set timezone = 'Asia/Kolkata' where id = 'a0000000-0000-4000-8000-000000000001';
update public.quotes set deleted_at = null, status = 'confirmed', title = 'Rao Wedding', event_date = '2026-12-01',
       manager_id = (select id from auth.users where email = 'a_admin@a.test')
 where id = 'a0000000-0000-4000-8000-00000000da01';
insert into public.crew_members (id, name, phone, org_id, profile_id) values
  ('a0000000-0000-4000-8000-0000000c0338', 'Asha Manager', '+91 90000 03380', 'a0000000-0000-4000-8000-000000000001', (select id from auth.users where email = 'a_admin@a.test'));
delete from public.task_reminder_settings where org_id in ('a0000000-0000-4000-8000-000000000001', 'b0000000-0000-4000-8000-000000000001');
insert into public.event_tasks (id, quote_id, org_id, category, title, assignee_name, assignee_phone, status, planned_start, remind_before) values
  ('a0000000-0000-4000-8000-0000000f0001', 'a0000000-0000-4000-8000-00000000da01', 'a0000000-0000-4000-8000-000000000001', 'Stage', 'Stage lights', 'Ravi Kumar', '9000003381', 'accepted', pg_temp.ist('12:30'), '{10,5,3}'),
  ('a0000000-0000-4000-8000-0000000f0002', 'a0000000-0000-4000-8000-00000000da01', 'a0000000-0000-4000-8000-000000000001', 'Stage', 'Sound check', 'Meena', '9000003382', 'assigned', pg_temp.ist('12:30'), null),
  ('a0000000-0000-4000-8000-0000000f0003', 'a0000000-0000-4000-8000-00000000da01', 'a0000000-0000-4000-8000-000000000001', 'Decor', 'Flower arch', 'Kiran', '9000003383', 'unassigned', pg_temp.ist('12:30'), '{10,5,3}'),
  ('a0000000-0000-4000-8000-0000000f0004', 'a0000000-0000-4000-8000-00000000da01', 'a0000000-0000-4000-8000-000000000001', 'Decor', 'Stage decor', 'Lata', '9000003384', 'assigned', pg_temp.ist('13:00'), '{10}');
update public.event_tasks set depends_on = 'a0000000-0000-4000-8000-0000000f0003' where id = 'a0000000-0000-4000-8000-0000000f0004';

-- ---- 1) structure ---------------------------------------------------------------------------------------------------------
select pg_temp.t('1a server-only: the app cannot run the job, claim or mark',
  not has_function_privilege('authenticated', 'public.task_reminder_tick(timestamptz)', 'execute')
  and not has_function_privilege('anon', 'public.task_reminder_tick(timestamptz)', 'execute')
  and not has_function_privilege('authenticated', 'public.task_wa_claim(integer)', 'execute')
  and not has_function_privilege('authenticated', 'public.task_wa_mark(uuid,text,text,text)', 'execute')
  and not has_function_privilege('authenticated', 'public.assign_notify_wamid(uuid,text,text)', 'execute')
  and has_function_privilege('service_role', 'public.task_wa_claim(integer)', 'execute'));
select pg_temp.t('1b the queue and the settings table are not readable by the app',
  not has_table_privilege('authenticated', 'public.task_wa_outbox', 'select') and not has_table_privilege('anon', 'public.task_wa_outbox', 'select')
  and not has_table_privilege('authenticated', 'public.task_reminder_settings', 'select'));
select pg_temp.t('1c page RPCs: members only, never anon',
  has_function_privilege('authenticated', 'public.task_wa_status(uuid)', 'execute') and not has_function_privilege('anon', 'public.task_wa_status(uuid)', 'execute')
  and has_function_privilege('authenticated', 'public.set_task_reminders(uuid,integer[])', 'execute') and not has_function_privilege('anon', 'public.task_reminder_settings_set(jsonb)', 'execute'));

-- ---- 2) settings ------------------------------------------------------------------------------------------------------------
select pg_temp.t('2a defaults: 10 + 5 before, every 15 min up to 3, office on, hold on', pg_temp.as_val('a_admin@a.test',
  $q$select (s -> 'default_before')::text || '|' || (s ->> 'late_every_min') || '|' || (s ->> 'late_max') || '|' || (s ->> 'alert_office') || '|' || (s ->> 'hold_waiting')
     from (select public.task_reminder_settings_get() s) x$q$) = 'ok:[10, 5]|15|3|true|true');
select pg_temp.t('2b anon refused', pg_temp.as_val('anon', 'select public.task_reminder_settings_get()::text') like '42501%');
select pg_temp.t('2c bad values refused', pg_temp.as_val('a_admin@a.test', $q$select public.task_reminder_settings_set('{"late_every_min": 2}')::text$q$) like '22023%'
  and pg_temp.as_val('a_admin@a.test', $q$select public.task_reminder_settings_set('{"default_before": [5, "x"]}')::text$q$) like '22023%'
  and pg_temp.as_val('a_admin@a.test', $q$select public.task_reminder_settings_set('{"late_max": 11}')::text$q$) like '22023%');
select pg_temp.t('2d custom times saved, sorted, duplicates removed', pg_temp.as_val('a_admin@a.test',
  $q$select (public.task_reminder_settings_set('{"default_before": [5, 20, 10, 5]}') -> 'default_before')::text$q$) = 'ok:[20, 10, 5]');
select pg_temp.t('2e studio B''s settings untouched', (public._r338_cfg('b0000000-0000-4000-8000-000000000001') ->> 'saved') = 'false');
select pg_temp.as_val('a_admin@a.test', $q$select public.task_reminder_settings_set('{"default_before": [10, 5]}')::text$q$);

-- ---- 3) per-task times ------------------------------------------------------------------------------------------------------
select pg_temp.t('3a another studio cannot change this task', pg_temp.as_val('b_admin@b.test',
  $q$select public.set_task_reminders('a0000000-0000-4000-8000-0000000f0002', '{15}')::text$q$) like 'P0002%');
select pg_temp.t('3b bad minutes refused', pg_temp.as_val('a_admin@a.test',
  $q$select public.set_task_reminders('a0000000-0000-4000-8000-0000000f0002', '{-1}')::text$q$) like '22023%');
select pg_temp.t('3c empty = the studio default', pg_temp.as_val('a_admin@a.test',
  $q$select public.set_task_reminders('a0000000-0000-4000-8000-0000000f0002', '{}')::text$q$) like 'ok:%'
  and (select remind_before is null from public.event_tasks where id = 'a0000000-0000-4000-8000-0000000f0002'));

-- ---- 4) the owner's example: 12:30 with 10, 5, 3 --------------------------------------------------------------------------------
select public.task_reminder_tick(pg_temp.ist('12:19'));
select pg_temp.t('4a 12:19: nothing yet', pg_temp.rows('a0000000-0000-4000-8000-0000000f0001') = '');
select public.task_reminder_tick(pg_temp.ist('12:20'));
select pg_temp.t('4b 12:20: the 10-minute reminder', pg_temp.rows('a0000000-0000-4000-8000-0000000f0001') = 'b10', pg_temp.rows('a0000000-0000-4000-8000-0000000f0001'));
select pg_temp.t('4c fields: name, task, event, time, minutes left, link marker; template staff_task_reminder',
  (select params = '["Ravi", "Stage lights", "Rao Wedding", "12:30 PM", "10", "@link"]'::jsonb and template = 'staff_task_reminder' and phone = '919000003381'
     from public.task_wa_outbox where task_id = 'a0000000-0000-4000-8000-0000000f0001' and slot = 'b10'),
  (select params::text from public.task_wa_outbox where task_id = 'a0000000-0000-4000-8000-0000000f0001' and slot = 'b10'));
select public.task_reminder_tick(pg_temp.ist('12:21')); select public.task_reminder_tick(pg_temp.ist('12:22'));
select pg_temp.t('4d each time goes once', pg_temp.rows('a0000000-0000-4000-8000-0000000f0001') = 'b10');
select public.task_reminder_tick(pg_temp.ist('12:25'));
select pg_temp.t('4e 12:25: the 5-minute reminder', pg_temp.rows('a0000000-0000-4000-8000-0000000f0001') = 'b10,b5');
update public.event_tasks set status = 'completed', completed_at = pg_temp.ist('12:26') where id = 'a0000000-0000-4000-8000-0000000f0001';
update public.event_tasks set status = 'assigned' where id = 'a0000000-0000-4000-8000-0000000f0003';   -- Flower arch is first seen at 12:27
select public.task_reminder_tick(pg_temp.ist('12:27')); select public.task_reminder_tick(pg_temp.ist('12:40'));
select pg_temp.t('4f done at 12:26: no 12:27 reminder, nothing late', pg_temp.rows('a0000000-0000-4000-8000-0000000f0001') = 'b10,b5');

-- ---- 5) studio default (10, 5) on another task + a stale queued row is skipped at claim when the task is done -----------------
select pg_temp.t('5a the studio default applied (10 and 5 queued for Sound check)', pg_temp.rows('a0000000-0000-4000-8000-0000000f0002') = 'b10,b5');
select pg_temp.t('5b missed times: Flower arch first seen at 12:27 -> only the 3-minute one, 10 and 5 skipped',
  pg_temp.rows('a0000000-0000-4000-8000-0000000f0003') = 'b10,b5,b3' and pg_temp.rows('a0000000-0000-4000-8000-0000000f0003', 'queued') = 'b3'
  and (select bool_and(reason = 'superseded') from public.task_wa_outbox where task_id = 'a0000000-0000-4000-8000-0000000f0003' and status = 'skipped'),
  pg_temp.rows('a0000000-0000-4000-8000-0000000f0003'));

-- ---- 6) late (not started): every 15 min up to 3, then the office ----------------------------------------------------------------
select public.task_reminder_tick(pg_temp.ist('12:44'));
select pg_temp.t('6a 12:44: not late yet', position('late' in pg_temp.rows('a0000000-0000-4000-8000-0000000f0002')) = 0);
select public.task_reminder_tick(pg_temp.ist('12:45')); select public.task_reminder_tick(pg_temp.ist('13:00')); select public.task_reminder_tick(pg_temp.ist('13:15'));
select pg_temp.t('6b 12:45, 13:00, 13:15: three late reminders', pg_temp.rows('a0000000-0000-4000-8000-0000000f0002') = 'b10,b5,late1,late2,alert,late3',
  pg_temp.rows('a0000000-0000-4000-8000-0000000f0002'));
select pg_temp.t('6c the office alert goes to the event manager''s number with the Live Status link',
  (select phone = '919000003380' and template = 'office_staff_alert' and link_path = 'ops.html?quote=a0000000-0000-4000-8000-00000000da01' and status = 'queued'
     from public.task_wa_outbox where task_id = 'a0000000-0000-4000-8000-0000000f0002' and slot = 'alert'));
select pg_temp.t('6d ... and a bell notice', exists (select 1 from public.notifications n where n.kind = 'task_overdue' and n.detail ->> 'task_id' = 'a0000000-0000-4000-8000-0000000f0002'));
select public.task_reminder_tick(pg_temp.ist('13:30')); select public.task_reminder_tick(pg_temp.ist('13:45'));
select pg_temp.t('6e no more after the third + the alert', pg_temp.rows('a0000000-0000-4000-8000-0000000f0002') = 'b10,b5,late1,late2,alert,late3');

-- ---- 7) waiting on an unfinished earlier task: hold, then one reminder -------------------------------------------------------------
select pg_temp.t('7a Stage decor (13:00, waits on Flower arch) held through every tick so far', pg_temp.rows('a0000000-0000-4000-8000-0000000f0004') = '');
update public.event_tasks set status = 'completed' where id = 'a0000000-0000-4000-8000-0000000f0003';
select public.task_reminder_tick(pg_temp.ist('12:55'));
select pg_temp.t('7b earlier task done -> one reminder at the next minute', pg_temp.rows('a0000000-0000-4000-8000-0000000f0004') = 'b10');

-- ---- 8) a new person / a new time = a fresh set; the old queued row is skipped at claim ------------------------------------------
update public.event_tasks set assignee_phone = '9000003399', assignee_name = 'Suresh' where id = 'a0000000-0000-4000-8000-0000000f0004';
select public.task_reminder_tick(pg_temp.ist('12:56'));
select pg_temp.t('8a the new person gets the reminder too', (select count(*) = 1 from public.task_wa_outbox where task_id = 'a0000000-0000-4000-8000-0000000f0004' and phone = '919000003399'));
select public.task_wa_claim(100);
select pg_temp.t('8b claim: the old person''s row is skipped (task changed), done tasks too',
  (select status = 'skipped' and reason = 'task_changed' from public.task_wa_outbox where task_id = 'a0000000-0000-4000-8000-0000000f0004' and phone = '919000003384')
  and (select bool_and(status = 'skipped') from public.task_wa_outbox where task_id = 'a0000000-0000-4000-8000-0000000f0001'));
select pg_temp.t('8c claim hands out the live rows only', (select count(*) > 0 from public.task_wa_outbox where claimed_at is not null and status = 'queued'));

-- ---- 9) studio switch off = nothing --------------------------------------------------------------------------------------------------
select pg_temp.as_val('a_admin@a.test', $q$select public.task_reminder_settings_set('{"enabled": false}')::text$q$);
update public.event_tasks set planned_start = pg_temp.ist('14:00'), status = 'assigned' where id = 'a0000000-0000-4000-8000-0000000f0001';
select public.task_reminder_tick(pg_temp.ist('13:50'));
select pg_temp.t('9a reminders off for the studio: nothing new', (select count(*) = 0 from public.task_wa_outbox where task_id = 'a0000000-0000-4000-8000-0000000f0001' and due_at > pg_temp.ist('13:00')));
select pg_temp.as_val('a_admin@a.test', $q$select public.task_reminder_settings_set('{"enabled": true}')::text$q$);
select public.task_reminder_tick(pg_temp.ist('13:50'));
select pg_temp.t('9b back on: a new time = a fresh set', (select count(*) = 1 from public.task_wa_outbox where task_id = 'a0000000-0000-4000-8000-0000000f0001' and due_at > pg_temp.ist('13:00') and status = 'queued'));

-- ---- 10) fields for task assigned / open shift -----------------------------------------------------------------------------------------
insert into public.assign_notify_outbox (org_id, quote_id, item_kind, item_id, phone, name, body)
  values ('a0000000-0000-4000-8000-000000000001', 'a0000000-0000-4000-8000-00000000da01', 'task', 'a0000000-0000-4000-8000-0000000f0002', '919000003382', 'Meena Rao', 'New task: Sound check');
select pg_temp.t('10a task assigned: template + 7 fields, the old text kept',
  (select template = 'staff_task_assigned' and params = '["Meena", "Sound check", "Rao Wedding", "1 Dec 2026", "12:30 PM", "venue to be confirmed", "@link"]'::jsonb and body = 'New task: Sound check'
     from public.assign_notify_outbox where item_id = 'a0000000-0000-4000-8000-0000000f0002' order by created_at desc limit 1),
  (select coalesce(template, 'null') || ' ' || coalesce(params::text, 'null') from public.assign_notify_outbox where item_id = 'a0000000-0000-4000-8000-0000000f0002' order by created_at desc limit 1));
insert into public.open_shifts (id, org_id, quote_id, title, department, shift_date, start_time, end_time)
  values ('a0000000-0000-4000-8000-0000000e0338', 'a0000000-0000-4000-8000-000000000001', 'a0000000-0000-4000-8000-00000000da01', 'Helper', 'Decoration', '2026-12-01', '10:00', '18:00');
insert into public.assign_notify_outbox (org_id, quote_id, item_kind, item_id, phone, name, body)
  values ('a0000000-0000-4000-8000-000000000001', 'a0000000-0000-4000-8000-00000000da01', 'open_shift', 'a0000000-0000-4000-8000-0000000e0338', '919000003385', 'Kavya', 'open shift');
select pg_temp.t('10b open shift: its own template + 8 fields',
  (select template = 'staff_open_shift' and params = '["Kavya", "Decoration", "Rao Wedding", "1 Dec 2026", "10:00 AM", "6:00 PM", "venue to be confirmed", "@link"]'::jsonb
     from public.assign_notify_outbox where item_id = 'a0000000-0000-4000-8000-0000000e0338'),
  (select coalesce(params::text, 'null') from public.assign_notify_outbox where item_id = 'a0000000-0000-4000-8000-0000000e0338'));
insert into public.assign_notify_outbox (org_id, quote_id, item_kind, item_id, phone, body)
  values ('a0000000-0000-4000-8000-000000000001', 'a0000000-0000-4000-8000-00000000da01', 'task', 'a0000000-0000-4000-8000-00000000dead', '919000003386', 'r130 unknown');
select pg_temp.t('10c a failed lookup never blocks the insert (unknown task -> no template, row kept)',
  (select template is null from public.assign_notify_outbox where body = 'r130 unknown'));

-- ---- 11) Meta ticks: forward only ------------------------------------------------------------------------------------------------------
update public.task_wa_outbox set status = 'sent', wamid = 'wamid.R130A' where task_id = 'a0000000-0000-4000-8000-0000000f0002' and slot = 'late3';
update public.assign_notify_outbox set wamid = 'wamid.R130B', wa_status = 'sent' where item_id = 'a0000000-0000-4000-8000-0000000f0002';
insert into public.integration_webhook_events (provider, event_id, event_type, ref, status) values ('whatsapp', 'r130-1', 'message_status', 'wamid.R130A', 'read'),
  ('whatsapp', 'r130-2', 'message_status', 'wamid.R130A', 'delivered'), ('whatsapp', 'r130-3', 'message_status', 'wamid.R130B', 'delivered');
select pg_temp.t('11a read stays read (a late "delivered" never moves it back); the assignment shows delivered',
  (select status from public.task_wa_outbox where wamid = 'wamid.R130A') = 'read'
  and (select wa_status from public.assign_notify_outbox where wamid = 'wamid.R130B') = 'delivered');

-- ---- 12) Live Status summary ----------------------------------------------------------------------------------------------------------
select pg_temp.t('12a members with Staff view see one line per task, never a phone number', pg_temp.as_val('a_admin@a.test',
  $q$select (jsonb_array_length(public.task_wa_status('a0000000-0000-4000-8000-00000000da01') -> 'tasks') >= 3)::text || '|' ||
            (public.task_wa_status('a0000000-0000-4000-8000-00000000da01')::text ~ '9000003')::text$q$) = 'ok:true|false');
select pg_temp.t('12b another studio gets nothing', pg_temp.as_val('b_admin@b.test',
  $q$select jsonb_array_length(public.task_wa_status('a0000000-0000-4000-8000-00000000da01') -> 'tasks')::text$q$) = 'ok:0');
select pg_temp.t('12d a member without Staff view is refused', pg_temp.as_val('a_staff@a.test', $q$select public.task_wa_status('a0000000-0000-4000-8000-00000000da01')::text$q$) like '42501%');
select pg_temp.t('12c anon refused', pg_temp.as_val('anon', $q$select public.task_wa_status('a0000000-0000-4000-8000-00000000da01')::text$q$) like '42501%');

-- ---- 13) re-run safe ----------------------------------------------------------------------------------------------------------------------
select pg_temp.t('13a one trigger each, one queue index', (select count(*) = 1 from pg_trigger where tgname = 'zz_r338_assign_fields')
  and (select count(*) = 1 from pg_trigger where tgname = 'zz_r338_wa_tick') and to_regclass('public.task_wa_outbox_slot_uk338') is not null);

do $$ declare n int; f int; r record; begin
  select count(*), count(*) filter (where result <> 'PASS') into n, f from _rs;
  for r in select * from _rs where result <> 'PASS' loop raise warning '% -> %', r.name, r.result; end loop;
  if f = 0 then raise warning 'R130-TASK-REMINDERS-0338: ALL PASS (%/%)', n, n;
  else raise warning 'R130-TASK-REMINDERS-0338: % FAILED of %', f, n; end if;
end $$;
rollback;
