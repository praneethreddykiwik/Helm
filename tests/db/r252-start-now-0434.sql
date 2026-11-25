-- r252-start-now-0434.sql - R252 "You can start now" (0434). Proves: (1) applied twice: privileges (nothing new for anon /
-- authenticated), kept bodies once, the five exact edits are in; (2) the earlier task is completed -> one bell (only the assignee
-- sees it), one e-mail row with the exact words, one WhatsApp row with staff_task_changed and a field count the sender accepts;
-- also for a task WITHOUT a start time; (3) the same completion again = nothing, a reopened and newly completed task = once more;
-- (4) cancelled; (5) a chain of three; two tasks waiting on one; both closed in one statement = nothing; (6) nobody on it ->
-- event manager + department supervisor; vendor -> event manager; unreachable person -> "Tell ..."; (7) turned down -> manager
-- once; (8) free trial = bell only; sample event / studio switch / cancelled event / other event / read-only studio / system
-- change = nothing; another studio untouched; (9) plan lock on; (10) the status change succeeds when every queue insert raises;
-- (11) the claims answer the rows as comms-dispatch reads them, a started task's WhatsApp is dropped; (12) late earlier task: one
-- bell, once; quiet run costs nothing; (13) 0367 / 0369 held while waiting, 0364 / 0369 count from the release; 0396 names the
-- earlier task; (14) settings, worker_get_tasks.waits_for, my_tasks. Local disposable PG only. Fake data only. Rolled back.
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

-- ---- the stored rows the migration must not touch ---------------------------------------------------------------------------------
create temp table _before as select (select md5(coalesce(string_agg(t::text, '|' order by t.id), '')) from public.event_tasks t) as tasks,
  (select md5(coalesce(string_agg(q.id::text || q.status, '|' order by q.id), '')) from public.quotes q) as quotes,
  (select count(*) from public.notifications) as bells;
\ir ../../supabase/migrations/0434_r252_start_now.sql
\ir ../../supabase/migrations/0434_r252_start_now.sql
set client_min_messages = warning;
select pg_temp.t('1a no stored row changed by the migration (twice)', (select b.tasks = md5(coalesce((select string_agg(t::text, '|' order by t.id) from public.event_tasks t), ''))
  and b.quotes = md5(coalesce((select string_agg(q.id::text || q.status, '|' order by q.id) from public.quotes q), '')) and b.bells = (select count(*) from public.notifications) from _before b));
select pg_temp.t('1b no new function may be run by anon / authenticated / service_role', not exists (
  select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace, unnest(array['anon', 'authenticated', 'service_role']) r
   where n.nspname = 'public' and (p.proname like '\_r434\_%' or p.proname like '%\_\_pre0434') and has_function_privilege(r, p.oid, 'execute')));
select pg_temp.t('1c every new function: definer + empty search_path', not exists (
  select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname like '\_r434\_%' and not (p.prosecdef and p.proconfig @> array['search_path=""'])));
select pg_temp.t('1d the ledger: RLS on, no grant to anon / authenticated, service_role reads only',
  (select relrowsecurity from pg_class where oid = 'public.task_start_notices'::regclass)
  and not has_table_privilege('anon', 'public.task_start_notices', 'select') and not has_table_privilege('authenticated', 'public.task_start_notices', 'select')
  and not has_table_privilege('authenticated', 'public.task_start_notices', 'insert') and has_table_privilege('service_role', 'public.task_start_notices', 'select')
  and not has_table_privilege('service_role', 'public.task_start_notices', 'insert'));
select pg_temp.t('1e the wrapped names keep their grants', has_function_privilege('anon', 'public.worker_get_tasks(uuid)', 'execute')
  and has_function_privilege('authenticated', 'public.task_reminder_settings_set(jsonb)', 'execute') and not has_function_privilege('anon', 'public.task_reminder_settings_set(jsonb)', 'execute')
  and not has_function_privilege('authenticated', 'public.task_reminder_tick(timestamptz)', 'execute') and has_function_privilege('service_role', 'public.task_reminder_tick(timestamptz)', 'execute')
  and not has_function_privilege('authenticated', 'public.assign_notify_claim(integer)', 'execute') and has_function_privilege('service_role', 'public.assign_notify_claim(integer)', 'execute')
  and has_function_privilege('authenticated', 'public.my_tasks()', 'execute') and not has_function_privilege('anon', 'public.my_tasks()', 'execute'));
select pg_temp.t('1f the five exact edits are in, ten kept bodies without them', (select bool_and(position('r252-0434' in pg_get_functiondef(f::regprocedure)) > 0)
    from unnest(array['public.task_reminder_tick__pre0367(timestamptz)', 'public._r367_special_tick(timestamptz)', 'public._r369_escalation_tick(timestamptz)',
                      'public.event_ready_alert_tick()', 'public.my_tasks()']) f)
  and (select count(*) = 10 and bool_and(position('r252-0434' in p.prosrc) = 0) from pg_proc p where p.proname like '%\_\_pre0434'));
select pg_temp.t('1g free-trial retention knows the ledger once', (select count(*) = 1 from unnest(public._tr184_purge_tables()) x where x = 'task_start_notices'));

-- ---- fixtures: studio A event with a manager + people ------------------------------------------------------------------------------
\set A '\'a0000000-0000-4000-8000-000000000001\''
\set Q '\'a0000000-0000-4000-8000-00000000da01\''
update public.organizations set timezone = 'Asia/Kolkata' where id = :A;
do $$ declare e text; u uuid; begin
  foreach e in array array['r252_mgr@a.test:manager:Mia Manager', 'r252_sup@a.test:supervisor:Sunil Super', 'r252_ravi@a.test:sales:Ravi Kumar', 'r252_off@a.test:sales:Old Login'] loop
    select id into u from auth.users where email = split_part(e, ':', 1);
    if u is null then u := auth.seed_user(split_part(e, ':', 1)); end if;
    insert into public.profiles(id, email, full_name, role, org_id, must_change_password, created_at)
      values (u, split_part(e, ':', 1), split_part(e, ':', 3), split_part(e, ':', 2), 'a0000000-0000-4000-8000-000000000001', false, now())
    on conflict (id) do update set role = excluded.role, org_id = excluded.org_id, full_name = excluded.full_name, email = excluded.email;
  end loop;
  insert into public.team_member_status (user_id, org_id, status, deactivated_at)
  values ((select id from auth.users where email = 'r252_off@a.test'), 'a0000000-0000-4000-8000-000000000001', 'deactivated', now())
  on conflict (user_id, org_id) do update set status = 'deactivated';
end $$;
update public.quotes set deleted_at = null, status = 'confirmed', title = 'Rao Wedding', event_date = (now() + interval '1 day')::date, event_time = null, is_demo = false,
       lifecycle_stage = case when lifecycle_stage in ('closed', 'cancelled') then 'execution' else lifecycle_stage end,
       manager_id = (select id from auth.users where email = 'r252_mgr@a.test') where id = :Q;
delete from public.automation_settings where org_id = :A; delete from public.task_reminder_settings where org_id = :A; delete from public.task_escalation_settings where org_id = :A;
insert into public.comms_settings (org_id, studio_whatsapp) values (:A, '919000000001') on conflict (org_id) do update set studio_whatsapp = '919000000001';
insert into public.crew_members (id, name, phone, email, org_id, profile_id, active) values
  ('a0000000-0000-4000-8000-0000000c2521', 'Ravi Kumar', '+91 90000 25211', 'ravi252@example.org', :A, (select id from auth.users where email = 'r252_ravi@a.test'), true),
  ('a0000000-0000-4000-8000-0000000c2522', 'Anu Rao', '+91 90000 25212', 'anu252@example.org', :A, null, true),
  ('a0000000-0000-4000-8000-0000000c2523', 'Nokia Less', '1234567', null, :A, null, true),
  ('a0000000-0000-4000-8000-0000000c2524', 'Old Login', '+91 90000 25214', 'old252@example.org', :A, (select id from auth.users where email = 'r252_off@a.test'), true);
insert into public.vendors (id, name, org_id) values ('a0000000-0000-4000-8000-0000000d2521', 'Sri Flowers', :A);
insert into public.event_department_supervisors (org_id, quote_id, department, profile_id) values (:A, :Q, 'Lights252', (select id from auth.users where email = 'r252_sup@a.test'))
  on conflict (quote_id, department) do update set profile_id = excluded.profile_id;
-- helpers: a task; bells / e-mails / WhatsApps about it
create or replace function pg_temp.mk(p_n text, p_title text, p_dep text default null, p_crew text default null, p_cat text default 'Stage252', p_start timestamptz default null,
    p_status text default null, p_special boolean default false, p_kind text default 'in_house') returns uuid language plpgsql as $$
declare v uuid := ('a0000000-0000-4000-8000-00000f25' || p_n)::uuid; c public.crew_members;
begin
  if p_crew is not null then select * into c from public.crew_members x where x.id = ('a0000000-0000-4000-8000-0000000c252' || p_crew)::uuid; end if;
  insert into public.event_tasks (id, quote_id, org_id, category, title, crew_id, assignee_name, assignee_phone, status, planned_start, depends_on, is_special, remind_every_min, remind_before, assignee_kind, vendor_id)
  values (v, 'a0000000-0000-4000-8000-00000000da01', 'a0000000-0000-4000-8000-000000000001', p_cat, p_title, c.id, c.name, c.phone,
          coalesce(p_status, case when c.id is null and p_kind = 'in_house' then 'unassigned' else 'assigned' end), p_start,
          case when p_dep is not null then ('a0000000-0000-4000-8000-00000f25' || p_dep)::uuid end, p_special, 5, '{}', p_kind,
          case when p_kind <> 'in_house' then 'a0000000-0000-4000-8000-0000000d2521'::uuid end);
  -- the "new work for you" messages of the insert are not what this suite looks at
  delete from public.assign_notify_outbox where item_id = v; delete from public.staff_email_outbox where task_id = v;
  return v;
end $$;
create or replace function pg_temp.id(p_n text) returns uuid language sql as $$ select ('a0000000-0000-4000-8000-00000f25' || p_n)::uuid $$;
create or replace function pg_temp.st(p_n text, p_status text) returns void language plpgsql as $$
begin
  perform set_config('helm.r312_cancel', pg_temp.id(p_n)::text, true);
  update public.event_tasks set status = p_status, completed_at = case when p_status = 'completed' then clock_timestamp() else completed_at end,
         cancelled_at = case when p_status = 'cancelled' then clock_timestamp() else cancelled_at end where id = pg_temp.id(p_n);
end $$;
create or replace function pg_temp.bells(p_n text, p_who text default null) returns integer language sql as $$
  select count(*)::integer from public.notifications n where n.kind = 'task_escalated' and n.detail ->> 'source' = '0434' and n.detail ->> 'task_id' = pg_temp.id(p_n)::text
     and (p_who is null or (n.detail -> 'notify') ? (select u.id::text from auth.users u where u.email = p_who)) $$;
create or replace function pg_temp.label(p_n text) returns text language sql as $$
  select n.detail ->> 'label' from public.notifications n where n.detail ->> 'source' = '0434' and n.detail ->> 'task_id' = pg_temp.id(p_n)::text order by n.created_at desc, n.id limit 1 $$;
create or replace function pg_temp.wa(p_n text) returns integer language sql as $$
  select count(*)::integer from public.assign_notify_outbox a where a.item_id = pg_temp.id(p_n) and a.template = 'staff_task_changed' $$;
create or replace function pg_temp.mails(p_line text) returns integer language sql as $$
  select count(*)::integer from public.staff_update_outbox u where u.changes ? p_line and u.status = 'pending' $$;

-- ---- 2) completed -> one of each (also without a start time: the main gap) -------------------------------------------------------------
select pg_temp.mk('0001', 'Stage build', null, '2'); select pg_temp.mk('0002', 'Drape', '0001', '1');
select pg_temp.st('0001', 'in_progress');
select pg_temp.t('2a nothing while the earlier task is only started', pg_temp.bells('0002') = 0 and pg_temp.wa('0002') = 0);
select pg_temp.st('0001', 'completed');
select pg_temp.t('2b one bell, for the person on it only', pg_temp.bells('0002') = 1 and pg_temp.bells('0002', 'r252_ravi@a.test') = 1
  and pg_temp.label('0002') = 'You can start now: Drape - Stage build is done (Rao Wedding)', pg_temp.bells('0002') || ' ' || coalesce(pg_temp.label('0002'), '-'));
select pg_temp.t('2c one e-mail with the exact words, sent at once', pg_temp.mails('You can start now: Drape - Stage build is done') = 1
  and (select u.recipient = 'ravi252@example.org' and u.not_before <= now() and u.change_count = 1 from public.staff_update_outbox u where u.changes ? 'You can start now: Drape - Stage build is done'));
select pg_temp.t('2d one WhatsApp: staff_task_changed, 4 fields', pg_temp.wa('0002') = 1 and (select a.phone = '919000025211' and a.status = 'pending' and a.params =
   '["Ravi", "Drape", "Rao Wedding", "you can start now - Stage build is done"]'::jsonb from public.assign_notify_outbox a where a.item_id = pg_temp.id('0002') and a.template = 'staff_task_changed'),
   (select a::text from public.assign_notify_outbox a where a.item_id = pg_temp.id('0002') limit 1));
select pg_temp.t('2e the person sees the bell, the office does not', pg_temp.as_val('r252_ravi@a.test', $q$select count(*)::text from public._r401_vis('a0000000-0000-4000-8000-000000000001', auth.uid()) v where v.kind = 'task_escalated' $q$) is not null
  and (select count(*) from public._r401_vis('a0000000-0000-4000-8000-000000000001', (select id from auth.users where email = 'r252_ravi@a.test')) v where v.kind = 'task_escalated') = 1
  and (select count(*) from public._r401_vis('a0000000-0000-4000-8000-000000000001', (select id from auth.users where email = 'r252_sup@a.test')) v where v.kind = 'task_escalated') = 0);
select pg_temp.t('2f the waiting task itself is not changed', (select status = 'assigned' and planned_start is null from public.event_tasks where id = pg_temp.id('0002')));

-- ---- 3) no duplicates; a new completion = once more ------------------------------------------------------------------------------------
select public._r434_closed(t, t.completed_at) from public.event_tasks t where t.id = pg_temp.id('0001');
update public.event_tasks set status = 'completed' where id = pg_temp.id('0001');
select pg_temp.t('3a the same completion again: nothing new', pg_temp.bells('0002') = 1 and pg_temp.wa('0002') = 1 and (select change_count = 1 from public.staff_update_outbox u where u.changes ? 'You can start now: Drape - Stage build is done'));
select pg_temp.st('0001', 'in_progress');
select pg_temp.t('3b reopened: nothing is taken back, nothing sent', pg_temp.bells('0002') = 1 and pg_temp.mails('You can start now: Drape - Stage build is done') = 1);
select pg_temp.st('0001', 'completed');
select pg_temp.t('3c completed again: exactly once more (the same e-mail line is not doubled)', pg_temp.bells('0002') = 2 and pg_temp.wa('0002') = 2 and pg_temp.mails('You can start now: Drape - Stage build is done') = 1, pg_temp.bells('0002')::text);

-- ---- 4) cancelled = the same rule as the reminder hold ----------------------------------------------------------------------------------
select pg_temp.mk('0011', 'Carpet', null, '2'); select pg_temp.mk('0012', 'Chairs', '0011', '2');
select pg_temp.st('0011', 'cancelled');
select pg_temp.t('4 cancelled: e-mail + WhatsApp for a person without a login, no bell', pg_temp.mails('You can start now: Chairs - Carpet was cancelled') = 1 and pg_temp.wa('0012') = 1 and pg_temp.bells('0012') = 0);

-- ---- 5) chain of three, two on one, both in one statement, another event ------------------------------------------------------------------
select pg_temp.mk('0021', 'One', null, '2'); select pg_temp.mk('0022', 'Two', '0021', '1'); select pg_temp.mk('0023', 'Three', '0022', '1');
select pg_temp.st('0021', 'completed');
select pg_temp.t('5a chain: only the next one is told', pg_temp.bells('0022') = 1 and pg_temp.bells('0023') = 0 and pg_temp.wa('0023') = 0);
select pg_temp.st('0022', 'completed');
select pg_temp.t('5b then the third', pg_temp.bells('0023') = 1 and pg_temp.bells('0022') = 1);
select pg_temp.mk('0031', 'Base', null, '2'); select pg_temp.mk('0032', 'Left', '0031', '1'); select pg_temp.mk('0033', 'Right', '0031', '1'); select pg_temp.mk('0034', 'Running', '0031', '1', 'Stage252', null, 'in_progress');
select pg_temp.st('0031', 'completed');
select pg_temp.t('5c two wait on one: both told once, the running one not', pg_temp.bells('0032') = 1 and pg_temp.bells('0033') = 1 and pg_temp.bells('0034') = 0
  and pg_temp.mails('You can start now: Left - Base is done') = 1 and pg_temp.mails('You can start now: Right - Base is done') = 1);
select pg_temp.mk('0041', 'P', null, '2'); select pg_temp.mk('0042', 'Q', '0041', '1');
update public.event_tasks set status = 'completed', completed_at = now() where id in (pg_temp.id('0041'), pg_temp.id('0042'));
select pg_temp.t('5d both finished in one statement: nothing', pg_temp.bells('0042') = 0 and pg_temp.wa('0042') = 0);

-- ---- 6) nobody / vendor / unreachable / a phone-only person -------------------------------------------------------------------------------
select pg_temp.mk('0051', 'Truss', null, '2'); select pg_temp.mk('0052', 'Lamps', '0051', null, 'Lights252'); select pg_temp.mk('0053', 'Flowers', '0051', null, 'Decor252', null, null, false, 'outsourced');
select pg_temp.mk('0054', 'Cables', '0051', '3'); select pg_temp.mk('0055', 'Switch off', '0051', '4');
select pg_temp.st('0051', 'completed');
select pg_temp.t('6a nobody on it: the event manager and the department supervisor, one bell row', pg_temp.bells('0052') = 1 and pg_temp.bells('0052', 'r252_mgr@a.test') = 1 and pg_temp.bells('0052', 'r252_sup@a.test') = 1
  and pg_temp.label('0052') = 'Lamps can start now - Truss is done. Nobody is on it yet (Rao Wedding)', pg_temp.label('0052'));
select pg_temp.t('6b vendor: the event manager only, nothing leaves Helm', pg_temp.bells('0053') = 1 and pg_temp.bells('0053', 'r252_mgr@a.test') = 1 and pg_temp.bells('0053', 'r252_sup@a.test') = 0 and pg_temp.wa('0053') = 0
  and pg_temp.label('0053') = 'Sri Flowers (vendor) can start now: Flowers - Truss is done (Rao Wedding)', pg_temp.label('0053'));
select pg_temp.t('6c unreachable person: the event manager tells them', pg_temp.bells('0054') = 1 and pg_temp.bells('0054', 'r252_mgr@a.test') = 1 and pg_temp.label('0054') like 'Tell Nokia Less: Cables can start now - Truss is done.%', pg_temp.label('0054'));
select pg_temp.t('6d a deactivated login gets no bell, e-mail or WhatsApp (the manager is told)', pg_temp.bells('0055', 'r252_off@a.test') = 0 and pg_temp.bells('0055', 'r252_mgr@a.test') = 1
  and pg_temp.wa('0055') = 0 and pg_temp.mails('You can start now: Switch off - Truss is done') = 0, pg_temp.wa('0055') || ' ' || coalesce(pg_temp.label('0055'), '-'));
update public.quotes set manager_id = null where id = :Q;
select pg_temp.mk('0056', 'Rig', null, '2'); select pg_temp.mk('0057', 'Nobody2', '0056', null, 'X252'); select pg_temp.st('0056', 'completed');
select pg_temp.t('6e no event manager: the admins', pg_temp.bells('0057', 'a_admin@a.test') = 1 and pg_temp.bells('0057', 'r252_mgr@a.test') = 0);
update public.quotes set manager_id = (select id from auth.users where email = 'r252_mgr@a.test') where id = :Q;

-- ---- 7) turned down --------------------------------------------------------------------------------------------------------------------
select pg_temp.mk('0061', 'Sound', null, '2'); select pg_temp.mk('0062', 'Mic check', '0061', '1');
select pg_temp.st('0061', 'rejected');
select pg_temp.t('7a turned down: one bell for the event manager, nothing for the person', pg_temp.bells('0062') = 1 and pg_temp.bells('0062', 'r252_mgr@a.test') = 1 and pg_temp.wa('0062') = 0
  and pg_temp.label('0062') = 'Mic check is waiting for Sound, which was turned down by Anu Rao. Give it to someone else (Rao Wedding)', pg_temp.label('0062'));
update public.event_tasks set note = 'x' where id = pg_temp.id('0061');
select pg_temp.t('7b once', pg_temp.bells('0062') = 1);

-- ---- 8) who never gets anything ----------------------------------------------------------------------------------------------------------
create or replace function pg_temp.pair(p_a text, p_b text) returns void language plpgsql as $$
begin perform pg_temp.mk(p_a, 'E' || p_a, null, '2'); perform pg_temp.mk(p_b, 'W' || p_b, p_a, '1'); perform pg_temp.st(p_a, 'completed'); end $$;
create or replace function pg_temp.any_sent(p_b text) returns text language sql as $$
  select pg_temp.bells(p_b) || '/' || pg_temp.wa(p_b) || '/' || (select count(*) from public.staff_update_outbox u where u.changes::text like '%: W' || p_b || ' -%') || '/' ||
         (select count(*) from public.task_start_notices n where n.task_id = pg_temp.id(p_b)) $$;
update public.quotes set is_demo = true where id = :Q; select pg_temp.pair('0071', '0072');
select pg_temp.t('8a sample event: nothing', pg_temp.any_sent('0072') = '0/0/0/0', pg_temp.any_sent('0072'));
update public.quotes set is_demo = false where id = :Q;
insert into public.task_reminder_settings (org_id, start_now) values (:A, false) on conflict (org_id) do update set start_now = false;
select pg_temp.pair('0073', '0074');
select pg_temp.t('8b studio switch off: nothing', pg_temp.any_sent('0074') = '0/0/0/0', pg_temp.any_sent('0074'));
update public.task_reminder_settings set start_now = true, enabled = false where org_id = :A; select pg_temp.pair('0075', '0076');
select pg_temp.t('8c task reminders off: nothing', pg_temp.any_sent('0076') = '0/0/0/0', pg_temp.any_sent('0076'));
update public.task_reminder_settings set enabled = true where org_id = :A;
select set_config('helm.maintenance', 'on', true); select pg_temp.pair('0077', '0078');
select pg_temp.t('8d a system change (SQL editor, migration): nothing', pg_temp.any_sent('0078') = '0/0/0/0', pg_temp.any_sent('0078'));
select set_config('helm.maintenance', 'off', true);
update public.quotes set event_date = (now() - interval '5 days')::date where id = :Q; select pg_temp.pair('0079', '0080');
select pg_temp.t('8e an event over for 5 days: nothing', pg_temp.any_sent('0080') = '0/0/0/0', pg_temp.any_sent('0080'));
update public.quotes set event_date = (now() + interval '1 day')::date where id = :Q;
-- free trial: the bell only
savepoint tr;
insert into public.studio_subscriptions (org_id, status, trial_ends_at) values (:A, 'trial', now() + interval '5 days') on conflict (org_id) do update set status = 'trial', trial_ends_at = now() + interval '5 days', current_period_end = null;
update public.organizations set trial_ends_at = now() + interval '5 days' where id = :A;
delete from public.subscription_payments where org_id = :A;
select pg_temp.t('8f0 the studio is on a free trial here', public.trial_send_blocked(:A, :Q, null));
select pg_temp.pair('0081', '0082');
select pg_temp.t('8f free trial: bell inside Helm, no e-mail, no WhatsApp', pg_temp.any_sent('0082') = '1/0/0/1', pg_temp.any_sent('0082'));
select coalesce(jsonb_agg(to_jsonb(r)), '[]') as keep from _rs r \gset
rollback to savepoint tr;
insert into _rs select x ->> 'name', x ->> 'result' from jsonb_array_elements((:'keep')::jsonb) x where not exists (select 1 from _rs r where r.name = x ->> 'name');
-- read-only studio (suspended): the app cannot change it; a server change tells nobody
savepoint ro;
insert into public.studio_subscriptions (org_id, status) values (:A, 'suspended') on conflict (org_id) do update set status = 'suspended';
select pg_temp.pair('0083', '0084');
select pg_temp.t('8g read-only studio: a server change goes through, nobody is told', pg_temp.any_sent('0084') = '0/0/0/0' and (select status = 'completed' from public.event_tasks where id = pg_temp.id('0083')), pg_temp.any_sent('0084'));
select pg_temp.t('8h read-only studio: the app is still refused', pg_temp.as_val('a_admin@a.test', $q$update public.event_tasks set status = 'accepted' where id = 'a0000000-0000-4000-8000-00000f250084' returning status$q$) like '25006%');
select coalesce(jsonb_agg(to_jsonb(r)), '[]') as keep from _rs r \gset
rollback to savepoint ro;
insert into _rs select x ->> 'name', x ->> 'result' from jsonb_array_elements((:'keep')::jsonb) x where not exists (select 1 from _rs r where r.name = x ->> 'name');
select pg_temp.t('8i another studio: no row of any kind', not exists (select 1 from public.task_start_notices where org_id <> :A)
  and not exists (select 1 from public.notifications where detail ->> 'source' = '0434' and org_id <> :A)
  and not exists (select 1 from public.staff_update_outbox where org_id <> :A and changes::text like '%You can start now%'));
update public.quotes set status = 'cancelled' where id = :Q; select pg_temp.pair('0085', '0086');
select pg_temp.t('8j cancelled event: nothing', pg_temp.any_sent('0086') = '0/0/0/0', pg_temp.any_sent('0086'));
update public.quotes set status = 'confirmed' where id = :Q;

-- ---- 9) plan lock on + the real ways a task is finished (office, worker link) --------------------------------------------------------------
select pg_temp.mk('0091', 'Locked one', null, '2'); select pg_temp.mk('0092', 'Locked two', '0091', '1');
-- 0442 (R257) removed the event-day lock: this check runs with its one-line switch on (rolled back with the suite)
create or replace function public._r442_lock_on() returns boolean language sql stable set search_path = '' as 'select true';
insert into public.event_plan_locks (quote_id, org_id, state) values (:Q, :A, 'locked') on conflict (quote_id) do update set state = 'locked';
select set_config('helm.r397_plan_lock', 'on', true);
select pg_temp.t('9 the plan is locked here', public._r397_locked(:Q) and pg_temp.as_val('a_admin@a.test', $q$update public.event_tasks set title = 'x' where id = 'a0000000-0000-4000-8000-00000f250092' returning title$q$) like '%plan_locked%');
insert into public.work_tokens (quote_id, phone, name, org_id, token) values (:Q, '+91 90000 25212', 'Anu Rao', :A, 'a0000000-0000-4000-8000-000000252001');
select pg_temp.t('9a worker link accepts + completes on a locked plan', pg_temp.as_val('anon', $q$select (public.worker_respond('a0000000-0000-4000-8000-000000252001', 'a0000000-0000-4000-8000-00000f250091', 'accept') ->> 'ok')
   || (public.worker_respond('a0000000-0000-4000-8000-000000252001', 'a0000000-0000-4000-8000-00000f250091', 'complete') ->> 'ok')$q$) = 'ok:truetrue',
   pg_temp.as_val('anon', $q$select public.worker_respond('a0000000-0000-4000-8000-000000252001', 'a0000000-0000-4000-8000-00000f250091', 'complete')::text$q$));
select pg_temp.t('9b and the waiting person is told', pg_temp.bells('0092', 'r252_ravi@a.test') = 1 and pg_temp.wa('0092') = 1, pg_temp.any_sent('0092'));
select set_config('helm.r397_plan_lock', 'off', true);
select pg_temp.mk('0093', 'Office one', null, '2', 'Stage252', null, 'in_progress'); select pg_temp.mk('0094', 'Office two', '0093', '1');
select pg_temp.t('9c the office cancels it (cancel_task)', pg_temp.as_val('a_admin@a.test', $q$select public.cancel_task('a0000000-0000-4000-8000-00000f250093', 'not needed') ->> 'ok'$q$) = 'ok:true');
select pg_temp.t('9d told once', pg_temp.bells('0094', 'r252_ravi@a.test') = 1 and pg_temp.label('0094') like '%Office one was cancelled%', pg_temp.label('0094'));

-- ---- 10) sending never blocks the status change ---------------------------------------------------------------------------------------------
create or replace function pg_temp.boom() returns trigger language plpgsql as $$ begin raise exception 'queue down'; end $$;
set client_min_messages = error;
savepoint bm;
create trigger a_boom before insert on public.assign_notify_outbox for each row execute function pg_temp.boom();
create trigger a_boom before insert on public.staff_update_outbox for each row execute function pg_temp.boom();
select pg_temp.mk('0101', 'Boom one', null, null); select pg_temp.mk('0102', 'Boom two', '0101', null);
update public.event_tasks set crew_id = 'a0000000-0000-4000-8000-0000000c2521', assignee_name = 'Ravi Kumar', status = 'assigned' where id = pg_temp.id('0102');
select pg_temp.st('0101', 'completed');
select pg_temp.t('10a e-mail + WhatsApp queues raise: the task is completed, the bell still comes', (select status = 'completed' from public.event_tasks where id = pg_temp.id('0101')) and pg_temp.bells('0102', 'r252_ravi@a.test') = 1, pg_temp.any_sent('0102'));
create trigger a_boom before insert on public.notifications for each row execute function pg_temp.boom();
create trigger a_boom before insert on public.task_start_notices for each row execute function pg_temp.boom();
select pg_temp.mk('0103', 'Boom three', null, null); select pg_temp.mk('0104', 'Boom four', '0103', null);
select pg_temp.st('0103', 'completed');
select pg_temp.t('10b every insert raises: the task is completed all the same', (select status = 'completed' from public.event_tasks where id = pg_temp.id('0103')));
select coalesce(jsonb_agg(to_jsonb(r)), '[]') as keep from _rs r \gset
rollback to savepoint bm;
insert into _rs select x ->> 'name', x ->> 'result' from jsonb_array_elements((:'keep')::jsonb) x where not exists (select 1 from _rs r where r.name = x ->> 'name');
savepoint bm2;
drop function public._r434_event(uuid, uuid);
select pg_temp.mk('0105', 'Boom five', null, null); select pg_temp.mk('0106', 'Boom six', '0105', null);
select pg_temp.st('0105', 'completed');
select pg_temp.t('10c a broken helper: the task is completed all the same', (select status = 'completed' from public.event_tasks where id = pg_temp.id('0105')));
select coalesce(jsonb_agg(to_jsonb(r)), '[]') as keep from _rs r \gset
rollback to savepoint bm2;
insert into _rs select x ->> 'name', x ->> 'result' from jsonb_array_elements((:'keep')::jsonb) x where not exists (select 1 from _rs r where r.name = x ->> 'name');
set client_min_messages = warning;

-- ---- 11) what comms-dispatch reads ------------------------------------------------------------------------------------------------------------
delete from public.assign_notify_outbox where template is distinct from 'staff_task_changed';
delete from public.assign_notify_outbox where item_id not in (pg_temp.id('0002'), pg_temp.id('0012'));
update public.assign_notify_outbox set updated_at = now() - interval '2 minutes', created_at = now() - interval '2 minutes';
update public.event_tasks set status = 'in_progress' where id = pg_temp.id('0012');
create temp table _claim as select public.assign_notify_claim(50) as j;
select pg_temp.t('11a WhatsApp claim: the waiting task''s rows, not the one that has started', (select jsonb_array_length(j) = 2 and bool_and(x ->> 'to' = '919000025211' and x ->> 'text' like 'Hi Ravi, you can start now: Drape (Rao Wedding). Stage build is done.%')
    from _claim, jsonb_array_elements(j) x group by j)
  and (select status = 'skipped' from public.assign_notify_outbox where item_id = pg_temp.id('0012')), (select j::text from _claim));
create temp table _mclaim as select public.staff_update_claim(50) as j;
select pg_temp.t('11b e-mail claim: task_update with the line and the open tasks', (select count(*) = 1 from _mclaim, jsonb_array_elements(j) x
   where x ->> 'kind' = 'task_update' and x ->> 'to' = 'ravi252@example.org' and x -> 'changes' ? 'You can start now: Drape - Stage build is done' and jsonb_array_length(x -> 'tasks') > 0), (select left(j::text, 600) from _mclaim));

-- ---- 12) the earlier task is late ----------------------------------------------------------------------------------------------------------------
delete from public.event_tasks where quote_id = :Q and org_id = :A;
create temp table _t as select date_trunc('minute', now()) as t; grant select on _t to anon, authenticated;
select pg_temp.mk('0111', 'Stage build', null, '2', 'Stage252', (select t from _t)); select pg_temp.mk('0112', 'Drape', '0111', '1');
select pg_temp.t('12a 10 minutes late: not yet', public._r434_wait_tick((select t + interval '10 minutes' from _t)) = 0);
select public.task_reminder_tick((select t + interval '25 minutes' from _t));
select pg_temp.t('12b 25 minutes late (through the every-minute job): one bell for the manager about the EARLIER task', pg_temp.bells('0111', 'r252_mgr@a.test') = 1
  and pg_temp.label('0111') = 'Drape is waiting for Stage build, which is 25 min late (Anu Rao) - Rao Wedding', pg_temp.label('0111'));
select public.task_reminder_tick((select t + interval '26 minutes' from _t)); select public.task_reminder_tick((select t + interval '3 hours' from _t));
select pg_temp.t('12c once, not every minute', pg_temp.bells('0111') = 1);
select pg_temp.st('0111', 'completed');
select pg_temp.t('12d done: the cheap check is quiet', not public._r434_wait_due((select t + interval '30 minutes' from _t)));
select pg_temp.mk('0113', 'Untimed', null, '2'); select pg_temp.mk('0114', 'Timed', '0113', '1', 'Stage252', (select t from _t));
select public._r434_wait_tick((select t + interval '20 minutes' from _t));
select pg_temp.t('12e the waiting task is overdue because of an untimed task', pg_temp.bells('0113', 'r252_mgr@a.test') = 1 and pg_temp.label('0113') like 'Timed was due at % and is waiting for Untimed, which is not done yet (Anu Rao) - Rao Wedding', pg_temp.label('0113'));
select pg_temp.mk('0115', 'Long', null, '2', 'Stage252', (select t - interval '1 hour' from _t), 'in_progress'); update public.event_tasks set planned_end = (select t from _t) where id = pg_temp.id('0115');
select pg_temp.mk('0116', 'After long', '0115', '1');
select public._r434_wait_tick((select t + interval '40 minutes' from _t));
select pg_temp.t('12f running over its end time counts too', pg_temp.label('0115') like 'After long is waiting for Long, which is 40 min late%', pg_temp.label('0115'));
update public.task_reminder_settings set alert_office = false where org_id = :A;
select pg_temp.mk('0117', 'Quiet', null, '2', 'Stage252', (select t from _t)); select pg_temp.mk('0118', 'After quiet', '0117', '1');
select pg_temp.t('12g office alerts off: none', public._r434_wait_tick((select t + interval '40 minutes' from _t)) = 0 and pg_temp.bells('0117') = 0);
update public.task_reminder_settings set alert_office = true where org_id = :A;

-- ---- 13) nobody is blamed while waiting -------------------------------------------------------------------------------------------------------------
delete from public.event_tasks where quote_id = :Q and org_id = :A;
select pg_temp.mk('0121', 'Before', null, '2'); select pg_temp.mk('0122', 'Special', '0121', '1', 'Stage252', (select t from _t), null, true);
select pg_temp.mk('0123', 'Free special', null, '2', 'Stage252', (select t from _t), null, true);
select public.task_reminder_tick((select t + interval '1 minute' from _t)); select public.task_reminder_tick((select t + interval '11 minutes' from _t));
select pg_temp.t('13a held special: no reminder, no escalation; a special that waits for nothing: both, as before',
  not exists (select 1 from public.task_wa_outbox where task_id = pg_temp.id('0122')) and not exists (select 1 from public.task_escalation_steps where task_id = pg_temp.id('0122'))
  and exists (select 1 from public.task_wa_outbox where task_id = pg_temp.id('0123')) and exists (select 1 from public.task_escalation_steps where task_id = pg_temp.id('0123') and status = 'sent'));
update public.task_reminder_settings set hold_waiting = false where org_id = :A;
savepoint h; select public.task_reminder_tick((select t + interval '12 minutes' from _t));
select pg_temp.t('13b the studio does not hold waiting tasks: exactly as before 0434', exists (select 1 from public.task_escalation_steps where task_id = pg_temp.id('0122')));
select coalesce(jsonb_agg(to_jsonb(r)), '[]') as keep from _rs r \gset
rollback to savepoint h;
insert into _rs select x ->> 'name', x ->> 'result' from jsonb_array_elements((:'keep')::jsonb) x where not exists (select 1 from _rs r where r.name = x ->> 'name');
update public.task_reminder_settings set hold_waiting = true where org_id = :A;
-- released 90 minutes before now's "now": completed_at = now() here, so the old start time is moved back
update public.event_tasks set planned_start = (select t - interval '100 minutes' from _t) where id = pg_temp.id('0122');
select pg_temp.st('0121', 'completed');
update public.event_tasks set completed_at = (select t from _t) where id = pg_temp.id('0121');
select public.task_reminder_tick((select t + interval '2 minutes' from _t));
select pg_temp.t('13c released 100 min after its start time: the ladder starts at step 1 (not straight at admin), the 5 min nag not yet',
  (select count(*) = 1 and bool_and(step = 0 and status = 'sent') from public.task_escalation_steps where task_id = pg_temp.id('0122')),
  (select string_agg(step || ':' || status, ',') from public.task_escalation_steps where task_id = pg_temp.id('0122')));
select pg_temp.mk('0124', 'Plain before', null, '2'); select pg_temp.mk('0125', 'Plain', '0124', '1', 'Stage252', (select t - interval '100 minutes' from _t));
update public.event_tasks set status = 'completed', completed_at = (select t from _t) where id = pg_temp.id('0124');
select public.task_reminder_tick((select t + interval '10 minutes' from _t));
select pg_temp.t('13d plain task: no "not started" 10 min after the release', not exists (select 1 from public.task_wa_outbox where task_id = pg_temp.id('0125') and kind = 'late' and status = 'queued'));
select public.task_reminder_tick((select t + interval '16 minutes' from _t));
select pg_temp.t('13e but 15 min after it (before 0434: never, the 75 min window from the old start was over)', (select count(*) = 1 from public.task_wa_outbox where task_id = pg_temp.id('0125') and kind = 'late' and slot = 'late1' and status = 'queued'));
select public.task_reminder_tick((select t + interval '46 minutes' from _t));
select pg_temp.t('13f and the office alert after the last one, once', (select count(*) = 1 from public.task_wa_outbox where task_id = pg_temp.id('0125') and kind = 'office_alert'));
-- 0396: names the earlier task
select pg_temp.mk('0126', 'Anchor', null, '2'); select pg_temp.mk('0127', 'Backdrop', '0126', '1'); select pg_temp.mk('0128', 'Solo', null, '1');
update public.event_tasks set duration_min = 60 where id in (pg_temp.id('0127'), pg_temp.id('0128'));
update public.quotes set event_date = ((now() + interval '30 minutes') at time zone 'Asia/Kolkata')::date, event_time = to_char((now() + interval '30 minutes') at time zone 'Asia/Kolkata', 'HH24:MI') where id = :Q;
insert into public.event_day_plans (quote_id, org_id, ready_by) values (:Q, :A, to_char((now() + interval '30 minutes') at time zone 'Asia/Kolkata', 'HH24:MI')) on conflict (quote_id) do update set ready_by = excluded.ready_by;
select public.event_ready_alert_tick();
select pg_temp.t('13g red latest-start bell: still comes, names the earlier task; a job that waits for nothing: the old words',
  exists (select 1 from public.notifications where detail ->> 'source' = '0396' and detail ->> 'task_id' = pg_temp.id('0127')::text and detail ->> 'label' like 'Waiting for Anchor: Backdrop - latest start was %is at risk%')
  and exists (select 1 from public.notifications where detail ->> 'source' = '0396' and detail ->> 'task_id' = pg_temp.id('0128')::text and detail ->> 'label' like 'Not started: Solo - latest start was %'),
  (select string_agg(detail ->> 'label', ' | ') from public.notifications where detail ->> 'source' = '0396'));

-- ---- 14) settings, worker page, my tasks ---------------------------------------------------------------------------------------------------------------
select pg_temp.t('14a settings answer start_now, default on', pg_temp.as_val('b_admin@b.test', $q$select public.task_reminder_settings_get() ->> 'start_now'$q$) = 'ok:true');
select pg_temp.t('14b off and on again by an admin; the other settings stay', pg_temp.as_val('a_admin@a.test', $q$select (public.task_reminder_settings_set('{"start_now": false}') ->> 'start_now') || (public.task_reminder_settings_get() ->> 'late_every_min')$q$) = 'ok:false15'
  and pg_temp.as_val('a_admin@a.test', $q$select public.task_reminder_settings_set('{"late_max": 2}') ->> 'start_now'$q$) = 'ok:false'
  and pg_temp.as_val('a_admin@a.test', $q$select public.task_reminder_settings_set('{"start_now": true, "late_max": 3}') ->> 'start_now'$q$) = 'ok:true');
select pg_temp.t('14c a wrong value and a person without Settings edit are refused', pg_temp.as_val('a_admin@a.test', $q$select public.task_reminder_settings_set('{"start_now": "x"}')::text$q$) like '22023%'
  and pg_temp.as_val('r252_sup@a.test', $q$select public.task_reminder_settings_set('{"start_now": false}')::text$q$) not like 'ok:%'
  and pg_temp.as_val('anon', $q$select public.task_reminder_settings_set('{"start_now": false}')::text$q$) not like 'ok:%'
  and pg_temp.as_val('b_admin@b.test', $q$select public.task_reminder_settings_set('{"start_now": false}') ->> 'start_now'$q$) = 'ok:false' and (select start_now from public.task_reminder_settings where org_id = :A),
  pg_temp.as_val('a_admin@a.test', $q$select public.task_reminder_settings_set('{"start_now": "x"}')::text$q$) || ' / ' || pg_temp.as_val('r252_sup@a.test', $q$select public.task_reminder_settings_set('{"start_now": true}')::text$q$) || ' / ' || pg_temp.as_val('b_admin@b.test', $q$select public.task_reminder_settings_set('{"start_now": false}') ->> 'start_now'$q$));
delete from public.event_tasks where quote_id = :Q and org_id = :A;
select pg_temp.mk('0131', 'Ladder', null, '1'); select pg_temp.mk('0132', 'Ceiling', '0131', '2'); select pg_temp.mk('0133', 'Plain', null, '2');
create temp table _wg as select public.worker_get_tasks('a0000000-0000-4000-8000-000000252001') as j, public.worker_get_tasks__pre0434('a0000000-0000-4000-8000-000000252001') as k;
select pg_temp.t('14d worker page: waits_for on the waiting task, null on the other, everything else identical', (select
   (select x -> 'waits_for' from jsonb_array_elements(j -> 'tasks') x where x ->> 'title' = 'Ceiling') = '{"title": "Ladder", "done": false}'::jsonb
   and (select x -> 'waits_for' from jsonb_array_elements(j -> 'tasks') x where x ->> 'title' = 'Plain') = 'null'::jsonb
   and (j - 'tasks') = (k - 'tasks') and (select jsonb_agg(x - 'waits_for' order by o) from jsonb_array_elements(j -> 'tasks') with ordinality e(x, o)) = k -> 'tasks' from _wg), (select j::text from _wg));
select pg_temp.t('14e worker page: a wrong link is refused as before', pg_temp.as_val('anon', $q$select public.worker_get_tasks('a0000000-0000-4000-8000-000000252fff')::text$q$) not like 'ok:%');
select pg_temp.mk('0134', 'Gone', null, '2'); select pg_temp.mk('0135', 'Mine', '0134', '1'); select pg_temp.st('0134', 'cancelled');
select pg_temp.mk('0136', 'Still open', null, '2'); select pg_temp.mk('0137', 'Mine too', '0136', '1');
select pg_temp.t('14f my_tasks: a cancelled earlier task blocks nothing, an open one still does', pg_temp.as_val('r252_ravi@a.test',
  $q$select string_agg(x ->> 'title', ',') from jsonb_array_elements(public.my_tasks() -> 'blocked') x where x ->> 'title' like 'Mine%'$q$) = 'ok:Mine too');

select name, result from _rs where result <> 'PASS' order by name;
select case when count(*) filter (where result <> 'PASS') = 0
            then 'R252-START-NOW-0434: ALL PASS (' || count(*) || '/' || count(*) || ')'
            else 'R252-START-NOW-0434: FAILURES (' || count(*) filter (where result <> 'PASS') || ' of ' || count(*) || ')' end as summary
  from _rs;
rollback;
