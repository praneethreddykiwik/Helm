-- r253-start-now-mail-0436.sql - R253 "stage is done -> the flowers crew is told" end to end (0436). Proves: (1) applied twice: no stored
-- row changed, privileges, kept bodies once; (2) EVERY way a task becomes done tells the waiting person exactly once: worker link, worker
-- link with the photo sheet, signed-in crew, office direct update, vendor's link, several in one statement, cancel_task - and the later
-- quality check (pass) sends nothing more; (3) the e-mail queue answers the facts (start_now) next to the old line, stale lines are left
-- out; (4) rework: hold to everyone waiting and not done (bell, e-mail, WhatsApp), ONE bell for the manager, once per rejection, done again
-- = start again / go on; (5) trial = bell only, sample / switch / cancelled / system / read-only / other studio = nothing, deactivated login
-- and inactive staff record -> manager, broken queues never block the check; (6) the department supervisor's check and every refusal;
-- (7) waits_for on the four task pages. Local disposable PG only. Fake data only. Rolled back.
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
\ir ../../supabase/migrations/0436_r253_start_now_mail.sql
\ir ../../supabase/migrations/0436_r253_start_now_mail.sql
set client_min_messages = warning;
select pg_temp.t('1a no stored row changed by the migration (twice)', (select b.tasks = md5(coalesce((select string_agg(t::text, '|' order by t.id) from public.event_tasks t), ''))
  and b.quotes = md5(coalesce((select string_agg(q.id::text || q.status, '|' order by q.id) from public.quotes q), '')) and b.bells = (select count(*) from public.notifications) from _before b));
select pg_temp.t('1b no new function may be run by anon / authenticated / service_role', not exists (
  select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace, unnest(array['anon', 'authenticated', 'service_role']) r
   where n.nspname = 'public' and (p.proname like '\_r436\_%' or p.proname like '%\_\_pre0436') and has_function_privilege(r, p.oid, 'execute')));
select pg_temp.t('1c every new function: definer + empty search_path', not exists (
  select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname like '\_r436\_%' and not (p.prosecdef and p.proconfig @> array['search_path=""'])));
select pg_temp.t('1d the wrapped names keep their grants', has_function_privilege('anon', 'public.worker_get_tasks(uuid)', 'execute')
  and not has_function_privilege('authenticated', 'public.staff_update_claim(integer)', 'execute') and has_function_privilege('service_role', 'public.staff_update_claim(integer)', 'execute')
  and not has_function_privilege('anon', 'public.staff_update_claim(integer)', 'execute')
  and not has_function_privilege('authenticated', 'public.assign_notify_claim(integer)', 'execute') and has_function_privilege('service_role', 'public.assign_notify_claim(integer)', 'execute')
  and has_function_privilege('authenticated', 'public.verify_task(uuid,boolean,text)', 'execute') and not has_function_privilege('anon', 'public.verify_task(uuid,boolean,text)', 'execute')
  and has_function_privilege('authenticated', 'public.event_department_supervisors_get(uuid)', 'execute') and not has_function_privilege('anon', 'public.event_department_supervisors_get(uuid)', 'execute')
  and has_function_privilege('authenticated', 'public.my_tasks()', 'execute') and not has_function_privilege('anon', 'public.my_tasks()', 'execute')
  and has_function_privilege('authenticated', 'public.crew_event_brief(uuid)', 'execute') and not has_function_privilege('anon', 'public.crew_event_brief(uuid)', 'execute')
  and has_function_privilege('anon', 'public.staff_link_view(text)', 'execute') and not has_function_privilege('anon', 'public.staff_link_view__pre0367(text)', 'execute'));
select pg_temp.t('1e kept bodies once, without the new text; the 0434 trigger function is redirected', (select count(*) = 8 and bool_and(position('r253-0436' in p.prosrc) = 0) from pg_proc p where p.proname like '%\_\_pre0436')
  and position('_r436_closed' in pg_get_functiondef('public._r434_tg_start_now()'::regprocedure)) > 0 and position('_r434_closed' in pg_get_functiondef('public._r436_kept_tg_start_now()'::regprocedure)) > 0,
  (select string_agg(p.proname, ',') from pg_proc p where p.proname like '%\_\_pre0436'));

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
-- helpers: a task; bells / e-mails / WhatsApps about it
create or replace function pg_temp.mk(p_n text, p_title text, p_dep text default null, p_crew text default null, p_cat text default 'Stage253', p_start timestamptz default null,
    p_status text default null, p_special boolean default false, p_kind text default 'in_house') returns uuid language plpgsql as $$
declare v uuid := ('a0000000-0000-4000-8000-00000f53' || p_n)::uuid; c public.crew_members;
begin
  if p_crew is not null then select * into c from public.crew_members x where x.id = ('a0000000-0000-4000-8000-0000000c253' || p_crew)::uuid; end if;
  insert into public.event_tasks (id, quote_id, org_id, category, title, crew_id, assignee_name, assignee_phone, status, planned_start, depends_on, is_special, remind_every_min, remind_before, assignee_kind, vendor_id)
  values (v, 'a0000000-0000-4000-8000-00000000da01', 'a0000000-0000-4000-8000-000000000001', p_cat, p_title, c.id, c.name, c.phone,
          coalesce(p_status, case when c.id is null and p_kind = 'in_house' then 'unassigned' else 'assigned' end), p_start,
          case when p_dep is not null then ('a0000000-0000-4000-8000-00000f53' || p_dep)::uuid end, p_special, 5, '{}', p_kind,
          case when p_kind <> 'in_house' then 'a0000000-0000-4000-8000-0000000d2531'::uuid end);
  -- the "new work for you" messages of the insert are not what this suite looks at
  delete from public.assign_notify_outbox where item_id = v; delete from public.staff_email_outbox where task_id = v;
  return v;
end $$;
create or replace function pg_temp.id(p_n text) returns uuid language sql as $$ select ('a0000000-0000-4000-8000-00000f53' || p_n)::uuid $$;
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

insert into public.crew_members (id, name, phone, email, org_id, profile_id, active) values
  ('a0000000-0000-4000-8000-0000000c2535', 'Left Us', '+91 90000 25315', 'left253@example.org', :A, null, false);
-- how many notices of a kind / any kind about a waiting task
create or replace function pg_temp.n(p_n text, p_kind text default 'start_now') returns integer language sql as $$
  select count(*)::integer from public.task_start_notices n where n.task_id = pg_temp.id(p_n) and n.kind = p_kind $$;

-- ---- 2) every way a task becomes done -> told exactly once ------------------------------------------------------------------------------
insert into public.work_tokens (quote_id, phone, name, org_id, token) values (:Q, '+91 90000 25312', 'Anu Rao', :A, 'a0000000-0000-4000-8000-000000253001');
select pg_temp.mk('0001', 'Stage set-up', null, '2'); select pg_temp.mk('0002', 'Flowers', '0001', '1', 'Decor253', now() + interval '3 hours');
select pg_temp.t('2a worker link: accept + start tell nobody', pg_temp.as_val('anon', $q$select (public.worker_respond('a0000000-0000-4000-8000-000000253001', 'a0000000-0000-4000-8000-00000f530001', 'accept') ->> 'ok')
   || (public.worker_respond('a0000000-0000-4000-8000-000000253001', 'a0000000-0000-4000-8000-00000f530001', 'start') ->> 'ok')$q$) = 'ok:truetrue' and pg_temp.n('0002') = 0);
select pg_temp.t('2b worker link: Mark done -> one notice: bell for the person, e-mail, WhatsApp', pg_temp.as_val('anon', $q$select public.worker_respond('a0000000-0000-4000-8000-000000253001', 'a0000000-0000-4000-8000-00000f530001', 'complete') ->> 'status'$q$) = 'ok:completed'
  and pg_temp.n('0002') = 1 and pg_temp.bells('0002', 'r253_ravi@a.test') = 1 and pg_temp.mails('You can start now: Flowers - Stage set-up is done') = 1 and pg_temp.wa('0002') = 1
  and pg_temp.label('0002') = 'You can start now: Flowers - Stage set-up is done (Rao wedding)', pg_temp.n('0002') || ' ' || coalesce(pg_temp.label('0002'), '-'));
select pg_temp.t('2c told when DONE, not after the check (verify_status is still pending)', (select verify_status = 'pending' from public.event_tasks where id = pg_temp.id('0001')));
select pg_temp.t('2d a second press is refused, nothing more goes out', pg_temp.as_val('anon', $q$select public.worker_respond('a0000000-0000-4000-8000-000000253001', 'a0000000-0000-4000-8000-00000f530001', 'complete')::text$q$) like '22023%' and pg_temp.n('0002') = 1);
select pg_temp.t('2e the quality check passes: nothing more goes out', pg_temp.as_val('a_admin@a.test', $q$select (public.verify_task('a0000000-0000-4000-8000-00000f530001', true, null)).verify_status$q$) = 'ok:passed' and pg_temp.n('0002') = 1 and pg_temp.bells('0002') = 1 and pg_temp.n('0002', 'hold') = 0);
select pg_temp.t('2f the bell is seen by the person, not by the rest of the office', (select count(*) = 1 from public._r401_vis('a0000000-0000-4000-8000-000000000001', (select id from auth.users where email = 'r253_ravi@a.test')) v join public.notifications n on n.id = v.id where n.detail ->> 'task_id' = pg_temp.id('0002')::text)
  and (select count(*) = 0 from public._r401_vis('a0000000-0000-4000-8000-000000000001', (select id from auth.users where email = 'r253_sup@a.test')) v join public.notifications n on n.id = v.id where n.detail ->> 'task_id' = pg_temp.id('0002')::text));
select pg_temp.t('2g the WhatsApp: the existing template, 4 fields', (select a.params = '["Ravi", "Flowers", "Rao wedding", "you can start now - Stage set-up is done"]'::jsonb and a.status = 'pending' from public.assign_notify_outbox a where a.item_id = pg_temp.id('0002') and a.template = 'staff_task_changed'),
  (select a.params::text from public.assign_notify_outbox a where a.item_id = pg_temp.id('0002')));
select pg_temp.mk('0011', 'Carpet', null, '2', 'Stage253', null, 'in_progress'); select pg_temp.mk('0012', 'Chairs', '0011', '1');
select pg_temp.t('2h worker link with the photo sheet (worker_respond_evidence): once', pg_temp.as_val('anon', $q$select public.worker_respond_evidence('a0000000-0000-4000-8000-000000253001', 'a0000000-0000-4000-8000-00000f530011', 'complete', null, null, null, '{}') ->> 'ok'$q$) = 'ok:true' and pg_temp.n('0012') = 1 and pg_temp.bells('0012') = 1);
select pg_temp.mk('0021', 'Truss', null, '1', 'Stage253', null, 'in_progress'); select pg_temp.mk('0022', 'Lamps', '0021', '2');
select pg_temp.t('2i signed-in crew (crew_task_respond): once', pg_temp.as_val('r253_ravi@a.test', $q$select public.crew_task_respond('a0000000-0000-4000-8000-00000f530021', 'complete') ->> 'status'$q$) = 'ok:completed' and pg_temp.n('0022') = 1);
select pg_temp.t('2i2 with the crew person''s name', pg_temp.wa('0022') = 1 and (select done_by = 'Ravi Kumar' from public.task_start_notices where task_id = pg_temp.id('0022')));
select pg_temp.mk('0031', 'Office job', null, '2', 'Stage253', null, 'in_progress'); select pg_temp.mk('0032', 'After office', '0031', '1');
select pg_temp.t('2j office: a direct update by somebody with Staff edit: once, "by" = the office person', pg_temp.as_val('a_admin@a.test', $q$update public.event_tasks set status = 'completed', completed_at = now() where id = 'a0000000-0000-4000-8000-00000f530031' returning status$q$) = 'ok:completed' and pg_temp.n('0032') = 1);
select pg_temp.mk('0041', 'Vendor job', null, null, 'Stage253', null, 'in_progress', false, 'outsourced'); select pg_temp.mk('0042', 'After vendor', '0041', '1');
update public.event_tasks set assignee_phone = '+919000025319', assignee_name = 'Sri Flowers' where id = pg_temp.id('0041');
insert into public.work_tokens (quote_id, phone, name, org_id, token) values (:Q, '+919000025319', 'Sri Flowers', :A, 'a0000000-0000-4000-8000-000000253002');
select pg_temp.t('2k the vendor''s link (the same worker link): once, "by" = the vendor', pg_temp.as_val('anon', $q$select public.worker_respond('a0000000-0000-4000-8000-000000253002', 'a0000000-0000-4000-8000-00000f530041', 'complete') ->> 'ok'$q$) = 'ok:true' and pg_temp.n('0042') = 1, pg_temp.n('0042')::text);
select pg_temp.t('2k2 with the vendor''s name', (select done_by = 'Sri Flowers' from public.task_start_notices where task_id = pg_temp.id('0042')), pg_temp.n('0042')::text);
select pg_temp.mk('0051', 'Bulk one', null, '2', 'Bulk253', null, 'in_progress'); select pg_temp.mk('0052', 'Bulk two', null, '2', 'Bulk253', null, 'in_progress');
select pg_temp.mk('0053', 'After one', '0051', '1'); select pg_temp.mk('0054', 'After two', '0052', '1');
update public.event_tasks set status = 'completed', completed_at = now() where category = 'Bulk253' and quote_id = :Q;
select pg_temp.t('2l several finished in one statement: each waiting task once', pg_temp.n('0053') = 1 and pg_temp.n('0054') = 1 and pg_temp.bells('0053') = 1 and pg_temp.bells('0054') = 1);
select pg_temp.mk('0061', 'Dropped', null, '2', 'Stage253', null, 'accepted'); select pg_temp.mk('0062', 'After dropped', '0061', '1');
select pg_temp.t('2m cancel_task: once', pg_temp.as_val('a_admin@a.test', $q$select public.cancel_task('a0000000-0000-4000-8000-00000f530061', 'not needed') ->> 'ok'$q$) = 'ok:true' and pg_temp.n('0062') = 1 and pg_temp.label('0062') like '%Dropped was cancelled%');
select pg_temp.mk('0063', 'Sound', null, '2'); select pg_temp.mk('0064', 'Mic check', '0063', '1'); select pg_temp.st('0063', 'rejected');
select pg_temp.t('2n the worker turns the earlier task down: the manager only, as in 0434', pg_temp.n('0064', 'wait_rejected') = 1 and pg_temp.bells('0064', 'r253_mgr@a.test') = 1 and pg_temp.bells('0064', 'r253_ravi@a.test') = 0 and pg_temp.wa('0064') = 0
  and pg_temp.label('0064') = 'Mic check is waiting for Sound, which was turned down by Anu Rao. Give it to someone else (Rao wedding)');
select pg_temp.t('2o the only functions that can set status completed are the worker link and the signed-in crew (everything else = a direct update)', (select string_agg(p.proname, ',' order by p.proname) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.prosrc ~* 'update +(public\.)?event_tasks +set +status *= *(newst|''completed'')') = 'crew_task_respond__pre0311,worker_respond__pre0299,worker_respond__pre0311',
  (select string_agg(p.proname, ',' order by p.proname) from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.prosrc ~* 'update +(public\.)?event_tasks +set +status *= *(newst|''completed'')'));

-- ---- 3) the e-mail queue --------------------------------------------------------------------------------------------------------------------
delete from public.event_tasks where quote_id = :Q and org_id = :A; delete from public.staff_update_outbox where quote_id = :Q; delete from public.assign_notify_outbox where quote_id = :Q;
insert into public.event_plan (quote_id, org_id, venue_name) values (:Q, :A, 'Taj Krishna') on conflict (quote_id) do update set venue_name = 'Taj Krishna';
select pg_temp.mk('0101', 'Stage set-up', null, '2', 'Stage253', null, 'in_progress'); select pg_temp.mk('0102', 'Flowers', '0101', '1', 'Decor253', date_trunc('day', now()) + interval '2 days 10 hours 30 minutes');
select pg_temp.as_val('anon', $q$select public.worker_respond('a0000000-0000-4000-8000-000000253001', 'a0000000-0000-4000-8000-00000f530101', 'complete')::text$q$);
savepoint m1;
create temp table _m as select public.staff_update_claim(50) as j;
select pg_temp.t('3a the sender gets the old line AND the facts; kind stays task_update', (select jsonb_array_length(j) = 1 and x ->> 'kind' = 'task_update' and x -> 'changes' = '["You can start now: Flowers - Stage set-up is done"]'::jsonb
    and x ->> 'to' = 'ravi253@example.org' and x ->> 'venue' = 'Taj Krishna' and x ->> 'event' = 'Rao wedding' and jsonb_array_length(x -> 'start_now') = 1
    and x -> 'start_now' -> 0 @> '{"type": "start_now", "line": "You can start now: Flowers - Stage set-up is done", "task": "Flowers", "section": "Decor253", "start": "4:00 PM", "earlier": "Stage set-up", "earlier_state": "done", "by": "Anu Rao"}'::jsonb
    and x -> 'start_now' -> 0 ->> 'at' ~ '^[0-9]{1,2}:[0-9]{2} (AM|PM)$' and x -> 'start_now' -> 0 ->> 'at_day' ~ '[0-9]{4}$' from _m, jsonb_array_elements(j) x), (select j::text from _m));
select pg_temp.t('3b what the kept claim answers is unchanged but for that one field', (select (x - 'start_now') ? 'tasks' and x ->> 'more' = '0' and (x ->> 'cancelled') = 'false' from _m, jsonb_array_elements(j) x));
select coalesce(jsonb_agg(to_jsonb(r)), '[]') as keep from _rs r \gset
rollback to savepoint m1;
insert into _rs select x ->> 'name', x ->> 'result' from jsonb_array_elements((:'keep')::jsonb) x where not exists (select 1 from _rs r where r.name = x ->> 'name');
-- an ordinary change notice: no new field
insert into public.staff_update_outbox (org_id, quote_id, crew_id, recipient, name, changes, change_count, not_before)
  values (:A, :Q, 'a0000000-0000-4000-8000-0000000c2532', 'anu253@example.org', 'Anu Rao', '["Flowers: instructions updated"]', 1, now());
savepoint m2;
create temp table _m as select public.staff_update_claim(50) as j;
select pg_temp.t('3c an ordinary change notice carries no start_now', (select count(*) = 1 and bool_and(not x ? 'start_now') from _m, jsonb_array_elements(j) x where x ->> 'to' = 'anu253@example.org'));
select coalesce(jsonb_agg(to_jsonb(r)), '[]') as keep from _rs r \gset
rollback to savepoint m2;
insert into _rs select x ->> 'name', x ->> 'result' from jsonb_array_elements((:'keep')::jsonb) x where not exists (select 1 from _rs r where r.name = x ->> 'name');
-- an office change and the start line in ONE notice
update public.staff_update_outbox set changes = changes || '["Flowers: instructions updated"]', change_count = 2 where recipient = 'ravi253@example.org' and sent_at is null;
savepoint m3;
update public.event_tasks set status = 'in_progress' where id = pg_temp.id('0102');
create temp table _m as select public.staff_update_claim(50) as j;
select pg_temp.t('3d the person started before the e-mail was picked up: the start line is left out, the other change still goes', (select count(*) = 1 and bool_and(x -> 'changes' = '["Flowers: instructions updated"]'::jsonb and not x ? 'start_now' and x ->> 'more' = '0') from _m, jsonb_array_elements(j) x where x ->> 'to' = 'ravi253@example.org'), (select j::text from _m));
select coalesce(jsonb_agg(to_jsonb(r)), '[]') as keep from _rs r \gset
rollback to savepoint m3;
insert into _rs select x ->> 'name', x ->> 'result' from jsonb_array_elements((:'keep')::jsonb) x where not exists (select 1 from _rs r where r.name = x ->> 'name');
update public.staff_update_outbox set changes = '["You can start now: Flowers - Stage set-up is done"]', change_count = 1 where recipient = 'ravi253@example.org' and sent_at is null;
savepoint m4;
update public.event_tasks set crew_id = 'a0000000-0000-4000-8000-0000000c2532', assignee_name = 'Anu Rao', assignee_phone = '+91 90000 25312' where id = pg_temp.id('0102');
select public.staff_update_claim(50);
select pg_temp.t('3e given to somebody else meanwhile: not sent (nothing_changed)', (select status = 'skipped' and reason = 'nothing_changed' from public.staff_update_outbox where recipient = 'ravi253@example.org' and reason is not null), (select string_agg(status || ' ' || coalesce(reason, '-') || changes::text, ' | ') from public.staff_update_outbox where recipient = 'ravi253@example.org'));
select coalesce(jsonb_agg(to_jsonb(r)), '[]') as keep from _rs r \gset
rollback to savepoint m4;
insert into _rs select x ->> 'name', x ->> 'result' from jsonb_array_elements((:'keep')::jsonb) x where not exists (select 1 from _rs r where r.name = x ->> 'name');

-- ---- 4) rework ---------------------------------------------------------------------------------------------------------------------------------
select pg_temp.mk('0103', 'Garlands', '0101', '2', 'Decor253', null, 'accepted'); select pg_temp.mk('0104', 'Lights', '0101', '1', 'Decor253', null, 'in_progress');
select pg_temp.mk('0105', 'Vendor drapes', '0101', null, 'Decor253', null, null, false, 'outsourced'); select pg_temp.mk('0106', 'No one yet', '0101', null, 'Decor253');
select pg_temp.mk('0107', 'Already done', '0101', '1', 'Decor253', null, 'completed'); select pg_temp.mk('0108', 'Unreached', '0101', '3', 'Decor253');
insert into public.role_access (org_id, role, area, can_view, can_edit) values (:A, 'manager', 'staff', true, true), (:A, 'supervisor', 'staff', true, false) on conflict (org_id, role, area) do update set can_view = true;
select pg_temp.t('4b the checker (event manager role) rejects it', pg_temp.as_val('r253_mgr@a.test', $q$select (public.verify_task('a0000000-0000-4000-8000-00000f530101', false, 'the left wing is loose')).verify_status$q$) = 'ok:rejected');
select pg_temp.t('4b2 it is back to work', (select status = 'in_progress' and completed_at is null from public.event_tasks where id = pg_temp.id('0101')));
select pg_temp.t('4c everyone waiting and not done is asked to hold - also who had started; the finished one not', pg_temp.n('0102', 'hold') = 1 and pg_temp.n('0103', 'hold') = 1 and pg_temp.n('0104', 'hold') = 1 and pg_temp.n('0107', 'hold') = 0
  and pg_temp.bells('0104', 'r253_ravi@a.test') = 1 and pg_temp.label('0104') = 'Stage set-up needs rework - please hold: Lights (Rao wedding)'
  and pg_temp.mails('Please hold: Garlands - Stage set-up needs rework') = 1 and pg_temp.mails('Please hold: Lights - Stage set-up needs rework') = 1, pg_temp.label('0104'));
select pg_temp.t('4d the WhatsApp fits the existing template', (select a.params = '["Anu", "Garlands", "Rao wedding", "please hold - Stage set-up needs rework"]'::jsonb and a.body like 'Hi Anu, please hold: Garlands (Rao wedding). Stage set-up needs rework.%' from public.assign_notify_outbox a where a.item_id = pg_temp.id('0103') and a.template = 'staff_task_changed'),
  (select a::text from public.assign_notify_outbox a where a.item_id = pg_temp.id('0103')));
select pg_temp.t('4e ONE bell for the event manager: who checked, what waits, whom to tell', pg_temp.bells('0101', 'r253_mgr@a.test') = 1
  and pg_temp.label('0101') = 'Stage set-up needs rework (checked by Mia Manager). Waiting for it: Flowers, Garlands, Lights and 3 more. Please tell: Sri Flowers (vendor), Nokia Less - Rao wedding'
  and pg_temp.bells('0105') = 0 and pg_temp.bells('0106') = 0 and pg_temp.wa('0105') = 0, pg_temp.label('0101'));
select public._r436_rework(t, t.verified_at) from public.event_tasks t where t.id = pg_temp.id('0101');
update public.event_tasks set note = 'x' where id = pg_temp.id('0101');
select pg_temp.t('4f once per rejection', pg_temp.n('0102', 'hold') = 1 and pg_temp.n('0101', 'hold_office') = 1 and pg_temp.bells('0101') = 1);
savepoint r1;
create temp table _m as select public.staff_update_claim(50) as j;
select pg_temp.t('4g a "you can start now" that was not picked up yet is taken out, the hold goes', (select count(*) = 1 and bool_and(not (x -> 'changes') ? 'You can start now: Flowers - Stage set-up is done' and (x -> 'changes') ? 'Please hold: Flowers - Stage set-up needs rework'
    and x -> 'start_now' @> '[{"type": "hold", "task": "Flowers", "earlier_state": "rework", "by": "Mia Manager"}]'::jsonb) from _m, jsonb_array_elements(j) x where x ->> 'to' = 'ravi253@example.org'), (select j::text from _m));
update public.assign_notify_outbox set updated_at = now() - interval '2 minutes', created_at = now() - interval '2 minutes' where quote_id = :Q;
create temp table _w as select public.assign_notify_claim(50) as j;
select pg_temp.t('4h WhatsApp: the stale start is dropped, the holds go - also to the one who had started', (select count(*) filter (where x ->> 'text' like '%you can start now%') = 0 and count(*) filter (where x ->> 'text' like '%please hold: Lights%') = 1 and count(*) filter (where x ->> 'text' like '%please hold%') = 3
    from _w, jsonb_array_elements(j) x), (select j::text from _w));
select coalesce(jsonb_agg(to_jsonb(r)), '[]') as keep from _rs r \gset
rollback to savepoint r1;
insert into _rs select x ->> 'name', x ->> 'result' from jsonb_array_elements((:'keep')::jsonb) x where not exists (select 1 from _rs r where r.name = x ->> 'name');
select pg_sleep(0.01);
select pg_temp.t('4i done again by the worker link', pg_temp.as_val('anon', $q$select public.worker_respond('a0000000-0000-4000-8000-000000253001', 'a0000000-0000-4000-8000-00000f530101', 'complete') ->> 'ok'$q$) = 'ok:true');
select pg_temp.t('4j start now again (the same second of one transaction shares the key: see 4k for a new moment); who had started: go on', pg_temp.n('0103') = 1 and pg_temp.n('0104', 'go_on') = 1 and pg_temp.mails('You can go on now: Lights - Stage set-up is done') = 1, pg_temp.n('0103') || '/' || pg_temp.n('0104', 'go_on'));
select pg_temp.t('4j2 nobody else who runs is told', pg_temp.n('0107', 'go_on') = 0 and pg_temp.n('0107') = 0);
-- a second round with its own moments
update public.event_tasks set verify_status = 'rejected', status = 'in_progress', completed_at = null, verified_at = now() + interval '1 second' where id = pg_temp.id('0101');
select pg_temp.st('0101', 'completed');
select pg_temp.t('4k second rejection + done again: one more hold and one more start / go on each', pg_temp.n('0102', 'hold') = 2 and pg_temp.n('0103') = 2 and pg_temp.n('0104', 'go_on') = 2 and pg_temp.bells('0101') = 2, pg_temp.n('0102', 'hold') || '/' || pg_temp.n('0103') || '/' || pg_temp.n('0104', 'go_on') || '/' || pg_temp.bells('0101'));
savepoint r2;
create temp table _m as select public.staff_update_claim(50) as j;
select pg_temp.t('4l in the end the e-mail says only what is true now: start / go on, no hold', (select count(*) = 1 and bool_and(not (x -> 'changes')::text like '%Please hold%' and (x -> 'changes') ? 'You can start now: Flowers - Stage set-up is done' and (x -> 'changes') ? 'You can go on now: Lights - Stage set-up is done'
    and jsonb_array_length(x -> 'start_now') = 2) from _m, jsonb_array_elements(j) x where x ->> 'to' = 'ravi253@example.org'), (select j::text from _m));
select coalesce(jsonb_agg(to_jsonb(r)), '[]') as keep from _rs r \gset
rollback to savepoint r2;
insert into _rs select x ->> 'name', x ->> 'result' from jsonb_array_elements((:'keep')::jsonb) x where not exists (select 1 from _rs r where r.name = x ->> 'name');

-- ---- 5) safety ---------------------------------------------------------------------------------------------------------------------------------------
create or replace function pg_temp.reject(p_n text) returns void language sql as $$
  update public.event_tasks set verify_status = 'rejected', status = 'in_progress', completed_at = null, verified_at = clock_timestamp() where id = pg_temp.id(p_n) $$;
create or replace function pg_temp.round(p_a text, p_b text) returns void language plpgsql as $$
begin perform pg_temp.mk(p_a, 'E' || p_a, null, '2'); perform pg_temp.mk(p_b, 'W' || p_b, p_a, '1'); perform pg_temp.st(p_a, 'in_progress'); perform pg_temp.st(p_a, 'completed'); perform pg_temp.reject(p_a); end $$;
create or replace function pg_temp.sent(p_a text, p_b text) returns text language sql as $$
  select pg_temp.bells(p_b) || '/' || pg_temp.wa(p_b) || '/' || (select count(*) from public.staff_update_outbox u where u.changes::text like '%W' || p_b || ' -%') || '/' ||
         (select count(*) from public.task_start_notices n where n.earlier_id = pg_temp.id(p_a)) $$;
select pg_temp.round('0201', '0202');
select pg_temp.t('5a control: normal = 2 bells, 2 WhatsApp, 1 notice, 3 ledger rows', pg_temp.sent('0201', '0202') = '2/2/1/3', pg_temp.sent('0201', '0202'));
update public.quotes set is_demo = true where id = :Q; select pg_temp.round('0203', '0204'); update public.quotes set is_demo = false where id = :Q;
select pg_temp.t('5b sample event: nothing', pg_temp.sent('0203', '0204') = '0/0/0/0', pg_temp.sent('0203', '0204'));
insert into public.task_reminder_settings (org_id, start_now) values (:A, false) on conflict (org_id) do update set start_now = false;
select pg_temp.round('0205', '0206'); update public.task_reminder_settings set start_now = true where org_id = :A;
select pg_temp.t('5c the studio switched it off: nothing', pg_temp.sent('0205', '0206') = '0/0/0/0', pg_temp.sent('0205', '0206'));
update public.quotes set status = 'cancelled' where id = :Q; select pg_temp.round('0207', '0208'); update public.quotes set status = 'confirmed' where id = :Q;
select pg_temp.t('5d cancelled event: nothing', pg_temp.sent('0207', '0208') = '0/0/0/0', pg_temp.sent('0207', '0208'));
select set_config('helm.maintenance', 'on', true); select pg_temp.round('0209', '0210'); select set_config('helm.maintenance', 'off', true);
select pg_temp.t('5e a system change: nothing', pg_temp.sent('0209', '0210') = '0/0/0/0', pg_temp.sent('0209', '0210'));
savepoint cl;
update public.quotes set lifecycle_stage = 'closed' where id = :Q; select pg_temp.round('0211', '0212');
select pg_temp.t('5f closed event: nothing', pg_temp.sent('0211', '0212') = '0/0/0/0', pg_temp.sent('0211', '0212'));
select coalesce(jsonb_agg(to_jsonb(r)), '[]') as keep from _rs r \gset
rollback to savepoint cl;
insert into _rs select x ->> 'name', x ->> 'result' from jsonb_array_elements((:'keep')::jsonb) x where not exists (select 1 from _rs r where r.name = x ->> 'name');
savepoint tr;
insert into public.studio_subscriptions (org_id, status, trial_ends_at) values (:A, 'trial', now() + interval '5 days') on conflict (org_id) do update set status = 'trial', trial_ends_at = now() + interval '5 days', current_period_end = null;
update public.organizations set trial_ends_at = now() + interval '5 days' where id = :A; delete from public.subscription_payments where org_id = :A;
select pg_temp.round('0213', '0214');
select pg_temp.t('5g free trial: bells inside Helm only', public.trial_send_blocked(:A, :Q, null) and pg_temp.sent('0213', '0214') = '2/0/0/3', pg_temp.sent('0213', '0214'));
select coalesce(jsonb_agg(to_jsonb(r)), '[]') as keep from _rs r \gset
rollback to savepoint tr;
insert into _rs select x ->> 'name', x ->> 'result' from jsonb_array_elements((:'keep')::jsonb) x where not exists (select 1 from _rs r where r.name = x ->> 'name');
savepoint ro;
insert into public.studio_subscriptions (org_id, status) values (:A, 'suspended') on conflict (org_id) do update set status = 'suspended';
select pg_temp.round('0215', '0216');
select pg_temp.t('5h read-only studio: nothing', pg_temp.sent('0215', '0216') = '0/0/0/0', pg_temp.sent('0215', '0216'));
select coalesce(jsonb_agg(to_jsonb(r)), '[]') as keep from _rs r \gset
rollback to savepoint ro;
insert into _rs select x ->> 'name', x ->> 'result' from jsonb_array_elements((:'keep')::jsonb) x where not exists (select 1 from _rs r where r.name = x ->> 'name');
select pg_temp.mk('0217', 'Base', null, '2'); select pg_temp.mk('0218', 'Off login', '0217', '4'); select pg_temp.mk('0219', 'Inactive', '0217', '5');
select pg_temp.st('0217', 'in_progress'); select pg_temp.st('0217', 'completed');
select pg_temp.t('5i deactivated login and inactive staff record: nothing to them, the event manager is told', pg_temp.bells('0218', 'r253_off@a.test') = 0 and pg_temp.bells('0218', 'r253_mgr@a.test') = 1 and pg_temp.wa('0218') = 0
  and pg_temp.bells('0219', 'r253_mgr@a.test') = 1 and pg_temp.wa('0219') = 0 and pg_temp.mails('You can start now: Inactive - Base is done') = 0 and pg_temp.label('0219') like 'Tell Left Us: Inactive can start now - Base is done.%', pg_temp.label('0219'));
select pg_temp.reject('0217');
select pg_temp.t('5j and for a rejection the manager''s one bell names them', pg_temp.label('0217') like '%Please tell: Old Login, Left Us - Rao wedding' and pg_temp.wa('0219') = 0, pg_temp.label('0217'));
select pg_temp.t('5k another studio: no row of any kind', not exists (select 1 from public.task_start_notices where org_id <> :A) and not exists (select 1 from public.notifications where detail ->> 'source' = '0434' and org_id <> :A)
  and not exists (select 1 from public.staff_update_outbox where org_id <> :A and changes::text ~ '(start now|Please hold)'));
create or replace function pg_temp.boom() returns trigger language plpgsql as $$ begin raise exception 'queue down'; end $$;
set client_min_messages = error;
savepoint bm;
create trigger a_boom before insert on public.assign_notify_outbox for each row execute function pg_temp.boom();
create trigger a_boom before insert on public.staff_update_outbox for each row execute function pg_temp.boom();
create trigger a_boom before insert on public.notifications for each row execute function pg_temp.boom();
create trigger a_boom before insert on public.task_start_notices for each row execute function pg_temp.boom();
select pg_temp.mk('0221', 'Boom one', null, null); select pg_temp.mk('0222', 'Boom two', '0221', null);
select pg_temp.st('0221', 'in_progress'); select pg_temp.st('0221', 'completed');
select pg_temp.t('5l every queue raises: done and the check go through all the same', (select status = 'completed' from public.event_tasks where id = pg_temp.id('0221')));
select pg_temp.reject('0221');
select pg_temp.t('5m and the rejection too', (select status = 'in_progress' and verify_status = 'rejected' from public.event_tasks where id = pg_temp.id('0221')));
select coalesce(jsonb_agg(to_jsonb(r)), '[]') as keep from _rs r \gset
rollback to savepoint bm;
insert into _rs select x ->> 'name', x ->> 'result' from jsonb_array_elements((:'keep')::jsonb) x where not exists (select 1 from _rs r where r.name = x ->> 'name');
savepoint bm2;
drop function public._r436_mail_items(uuid, jsonb); drop function public._r436_fresh(public.task_start_notices, uuid, text);
create temp table _m as select public.staff_update_claim(50) as j;
select pg_temp.t('5n a broken helper: the e-mails are still handed out (old words)', (select jsonb_array_length(j) >= 1 from _m));
select pg_temp.t('5o and the WhatsApp claim still answers', pg_temp.as_val(null, 'select jsonb_typeof(public.assign_notify_claim(5))') = 'ok:array');
select coalesce(jsonb_agg(to_jsonb(r)), '[]') as keep from _rs r \gset
rollback to savepoint bm2;
insert into _rs select x ->> 'name', x ->> 'result' from jsonb_array_elements((:'keep')::jsonb) x where not exists (select 1 from _rs r where r.name = x ->> 'name');
set client_min_messages = warning;

-- ---- 6) the department supervisor's check -----------------------------------------------------------------------------------------------------------
delete from public.event_tasks where quote_id = :Q and org_id = :A;
insert into public.crew_members (id, name, phone, email, org_id, profile_id, active) values ('a0000000-0000-4000-8000-0000000c2536', 'Sunil Super', '+91 90000 25316', null, :A, (select id from auth.users where email = 'r253_sup@a.test'), true);
select pg_temp.mk('0301', 'My section', null, '2', 'Lights253', null, 'in_progress'); select pg_temp.mk('0302', 'Other section', null, '2', 'Stage253', null, 'in_progress');
select pg_temp.mk('0303', 'My own job', null, '6', 'Lights253', null, 'in_progress'); select pg_temp.mk('0304', 'Not done yet', null, '2', 'Lights253', null, 'in_progress');
select pg_temp.mk('0305', 'Mine to fail', null, '2', 'Lights253', null, 'in_progress'); select pg_temp.mk('0306', 'Waits', '0305', '1', 'Lights253');
select pg_temp.mk('0307', 'My phone', null, null, 'Lights253', null, 'in_progress'); update public.event_tasks set assignee_phone = '+919000025316', assignee_name = 'S' where id = pg_temp.id('0307');
insert into public.quotes (id, code, title, org_id, status, event_date) values ('a0000000-0000-4000-8000-00000da02530', 'R253-OTHER', 'Other event', :A, 'confirmed', (now() + interval '2 days')::date) on conflict (id) do nothing;
insert into public.event_tasks (id, quote_id, org_id, category, title, status) values (pg_temp.id('0308'), 'a0000000-0000-4000-8000-00000da02530', :A, 'Lights253', 'Same section, other event', 'in_progress');
update public.event_tasks set status = 'completed', completed_at = now() where id = any (array[pg_temp.id('0301'), pg_temp.id('0302'), pg_temp.id('0303'), pg_temp.id('0305'), pg_temp.id('0307'), pg_temp.id('0308')]);
create or replace function pg_temp.vt(p_who text, p_n text, p_pass boolean, p_note text default null) returns text language sql as $$
  select pg_temp.as_val(p_who, format('select (public.verify_task(%L, %L, %L)).verify_status', pg_temp.id(p_n), p_pass, p_note)) $$;
select pg_temp.t('6a the section''s supervisor may pass a finished task', pg_temp.vt('r253_sup@a.test', '0301', true) = 'ok:passed');
select pg_temp.t('6a2 with the supervisor as the checker', (select verified_by = (select id from auth.users where email = 'r253_sup@a.test') and verified_at is not null and status = 'completed' from public.event_tasks where id = pg_temp.id('0301')));
select pg_temp.t('6b the same audit trail', (select count(*) = 1 from public.audit_log a where a.action = 'task.verify' and a.entity_id = pg_temp.id('0301')::text and a.actor = (select id from auth.users where email = 'r253_sup@a.test') and a.changed ->> 'to' = 'passed'));
select pg_temp.t('6c another section: refused', pg_temp.vt('r253_sup@a.test', '0302', true) like '42501%', pg_temp.vt('r253_sup@a.test', '0302', true));
select pg_temp.t('6d another event (not its supervisor there): refused', pg_temp.vt('r253_sup@a.test', '0308', true) like '42501%');
select pg_temp.t('6e own task (by staff record): refused', pg_temp.vt('r253_sup@a.test', '0303', true) like '42501%');
select pg_temp.t('6f own task (by phone): refused', pg_temp.vt('r253_sup@a.test', '0307', true) like '42501%');
select pg_temp.t('6g not completed: refused', pg_temp.vt('r253_sup@a.test', '0304', true) like '22023%');
select pg_temp.t('6h already checked: refused', pg_temp.vt('r253_sup@a.test', '0301', false, 'again') like '22023%');
select pg_temp.t('6i rejecting needs a reason', pg_temp.vt('r253_sup@a.test', '0305', false, '  ') like '22023%' and (select verify_status = 'pending' from public.event_tasks where id = pg_temp.id('0305')));
select pg_temp.t('6j rejecting with a reason works and asks the waiting person to hold', pg_temp.vt('r253_sup@a.test', '0305', false, 'cable is loose') = 'ok:rejected');
select pg_temp.t('6j2 back to work with the reason; hold', (select status = 'in_progress' and verify_note = 'cable is loose' from public.event_tasks where id = pg_temp.id('0305')) and pg_temp.n('0306', 'hold') = 1 and pg_temp.label('0305') like '%(checked by Sunil Super)%', pg_temp.label('0305'));
select pg_temp.t('6k a supervisor of another studio: not found', pg_temp.as_val('b_admin@b.test', $q$select (public.verify_task('a0000000-0000-4000-8000-00000f530302', true, null)).verify_status$q$) not like 'ok:%');
update public.role_access set can_view = false where org_id = :A and role = 'supervisor' and area = 'staff';
select pg_temp.st('0304', 'completed');
select pg_temp.t('6l without Staff view: refused', pg_temp.vt('r253_sup@a.test', '0304', true) like '42501%');
update public.role_access set can_view = true where org_id = :A and role = 'supervisor' and area = 'staff';
update public.event_department_supervisors set profile_id = (select id from auth.users where email = 'r253_mgr@a.test') where quote_id = :Q and department = 'Lights253';
select pg_temp.t('6m no longer the section''s supervisor: refused', pg_temp.vt('r253_sup@a.test', '0304', true) like '42501%');
update public.event_department_supervisors set profile_id = (select id from auth.users where email = 'r253_sup@a.test') where quote_id = :Q and department = 'Lights253';
select pg_temp.t('6n other roles as before: sales is refused even with Staff view, the event manager may', pg_temp.vt('r253_ravi@a.test', '0304', true) like '42501%' and pg_temp.vt('r253_mgr@a.test', '0302', true) = 'ok:passed');
select pg_temp.t('6o signed out: refused', pg_temp.vt('anon', '0304', true) not like 'ok:%');
insert into public.team_member_status (user_id, org_id, status, deactivated_at) values ((select id from auth.users where email = 'r253_sup@a.test'), :A, 'deactivated', now()) on conflict (user_id, org_id) do update set status = 'deactivated';
select pg_temp.t('6p a deactivated supervisor: refused', pg_temp.vt('r253_sup@a.test', '0304', true) not like 'ok:%');
update public.team_member_status set status = 'active' where user_id = (select id from auth.users where email = 'r253_sup@a.test');
select pg_temp.t('6q the page''s answer (one read): supervisor = own sections + own staff records; manager = all; sales = nothing', pg_temp.as_val('r253_sup@a.test', $q$select public.event_department_supervisors_get('a0000000-0000-4000-8000-00000000da01') ->> 'verify'$q$)
    = 'ok:{"all": false, "departments": ["Lights253"], "my_crew_ids": ["a0000000-0000-4000-8000-0000000c2536"]}'
  and pg_temp.as_val('r253_mgr@a.test', $q$select public.event_department_supervisors_get('a0000000-0000-4000-8000-00000000da01') -> 'verify' ->> 'all'$q$) = 'ok:true',
  pg_temp.as_val('r253_sup@a.test', $q$select public.event_department_supervisors_get('a0000000-0000-4000-8000-00000000da01') ->> 'verify'$q$));

-- ---- 7) the task pages ----------------------------------------------------------------------------------------------------------------------------------
delete from public.event_tasks where quote_id = :Q and org_id = :A;
select pg_temp.mk('0401', 'Ladder', null, '1'); select pg_temp.mk('0402', 'Ceiling', '0401', '1'); select pg_temp.mk('0403', 'Plain', null, '1');
insert into public.work_tokens (quote_id, phone, name, org_id, token) values (:Q, '+91 90000 25311', 'Ravi Kumar', :A, 'a0000000-0000-4000-8000-000000253003');
create or replace function pg_temp.wf(p_title text) returns jsonb language sql as $$ select x -> 'waits_for' from jsonb_array_elements(public.worker_get_tasks('a0000000-0000-4000-8000-000000253003') -> 'tasks') x where x ->> 'title' = p_title $$;
select pg_temp.t('7a worker page: waiting / null', pg_temp.wf('Ceiling') = '{"title": "Ladder", "done": false, "state": "waiting", "done_at": null}'::jsonb and pg_temp.wf('Plain') = 'null'::jsonb, pg_temp.wf('Ceiling')::text);
select pg_temp.t('7b everything else on the worker page is identical', (select (j - 'tasks') = (k - 'tasks') and (select jsonb_agg(x - 'waits_for' order by o) from jsonb_array_elements(j -> 'tasks') with ordinality e(x, o)) = k -> 'tasks'
  from (select public.worker_get_tasks('a0000000-0000-4000-8000-000000253003') j, public.worker_get_tasks__pre0434('a0000000-0000-4000-8000-000000253003') k) z));
select pg_temp.st('0401', 'in_progress'); select pg_temp.st('0401', 'completed');
select pg_temp.t('7c done', pg_temp.wf('Ceiling') @> '{"done": true, "state": "done"}'::jsonb and pg_temp.wf('Ceiling') ->> 'done_at' is not null);
select pg_temp.t('7d signed-in page (crew_event_brief) and my tasks: the same', pg_temp.as_val('r253_ravi@a.test', $q$select x -> 'waits_for' ->> 'state' from jsonb_array_elements(public.crew_event_brief('a0000000-0000-4000-8000-00000000da01') -> 'tasks') x where x ->> 'title' = 'Ceiling'$q$) = 'ok:done'
  and pg_temp.as_val('r253_ravi@a.test', $q$select string_agg(x -> 'waits_for' ->> 'state', ',') from jsonb_each(public.my_tasks()) e, jsonb_array_elements(case when jsonb_typeof(e.value) = 'array' then e.value else '[]' end) x where x ->> 'title' = 'Ceiling'$q$) = 'ok:done');
select pg_temp.reject('0401');
select pg_temp.t('7e rework', pg_temp.wf('Ceiling') @> '{"done": false, "state": "rework"}'::jsonb);
insert into public.staff_links (org_id, crew_id, token) values (:A, 'a0000000-0000-4000-8000-0000000c2531', repeat('a', 64)) on conflict do nothing;
select pg_temp.t('7f the permanent link page', pg_temp.as_val('anon', $q$select x -> 'waits_for' ->> 'state' from jsonb_array_elements(public.staff_link_view(repeat('a', 64)) -> 'events') e, jsonb_array_elements(e -> 'tasks') x where x ->> 'title' = 'Ceiling'$q$) = 'ok:rework',
  pg_temp.as_val('anon', $q$select public.staff_link_view(repeat('a', 64))::text$q$));
select pg_temp.st('0401', 'cancelled');
select pg_temp.t('7g cancelled', pg_temp.wf('Ceiling') @> '{"done": true, "state": "cancelled"}'::jsonb);
select pg_temp.t('7h a wrong link is refused as before', pg_temp.as_val('anon', $q$select public.worker_get_tasks('a0000000-0000-4000-8000-000000253fff')::text$q$) not like 'ok:%');

-- ---- 8) no circles in "waits for" -----------------------------------------------------------------------------------------------------------------------
delete from public.event_tasks where quote_id = :Q and org_id = :A;
select pg_temp.mk('0501', 'A', null, '1'); select pg_temp.mk('0502', 'B', '0501', '1'); select pg_temp.mk('0503', 'C', '0502', '1'); select pg_temp.mk('0504', 'D', null, '1'); select pg_temp.mk('0505', 'E', null, '1');
create or replace function pg_temp.sched(p_n text, p_dep text) returns text language sql as $$
  select pg_temp.as_val('a_admin@a.test', format('select (public.set_task_schedule(%L, null, null, %s)).depends_on', pg_temp.id(p_n), case when p_dep is null then 'null' else quote_literal(pg_temp.id(p_dep)) end)) $$;
select pg_temp.t('8a two tasks on each other: refused in plain words', pg_temp.sched('0501', '0502') = '22023 That would make the two tasks wait for each other.', pg_temp.sched('0501', '0502'));
select pg_temp.t('8b a longer circle: refused', pg_temp.sched('0501', '0503') like '22023 That would make%');
select pg_temp.t('8c itself: refused as before', pg_temp.sched('0501', '0501') like '%a task cannot depend on itself%');
select pg_temp.t('8d a chain without a circle, and clearing it, still work', pg_temp.sched('0504', '0503') like 'ok:%' and pg_temp.sched('0504', null) = 'ok:<null>' and pg_temp.sched('0504', '0501') like 'ok:%');
update public.event_tasks set depends_on = null where id = pg_temp.id('0504');
select pg_temp.st('0502', 'cancelled');
select pg_temp.t('8e a circle through a cancelled task: refused too', pg_temp.sched('0501', '0503') like '22023 That would make%');
select pg_temp.t('8f the other way to set it (event_task_duration_set) and a direct change', pg_temp.as_val('a_admin@a.test', $q$select public.event_task_duration_set('a0000000-0000-4000-8000-00000f530501', 30, 'a0000000-0000-4000-8000-00000f530503', true)::text$q$) like 'P0001 needs_loop%'
  and pg_temp.as_val('a_admin@a.test', $q$update public.event_tasks set depends_on = 'a0000000-0000-4000-8000-00000f530503' where id = 'a0000000-0000-4000-8000-00000f530501' returning title$q$) like '22023%');
select pg_temp.t('8g a task of another event: refused', pg_temp.as_val('a_admin@a.test', format('select (public.set_task_schedule(%L, null, null, %L)).depends_on', pg_temp.id('0505'), pg_temp.id('0308'))) like '22023 A task can only wait for a task of the same event.%',
  pg_temp.as_val('a_admin@a.test', format('select (public.set_task_schedule(%L, null, null, %L)).depends_on', pg_temp.id('0505'), pg_temp.id('0308'))));
select set_config('helm.maintenance', 'on', true);
update public.event_tasks set depends_on = pg_temp.id('0503') where id = pg_temp.id('0501');   -- a circle stored before 0436 (a restore)
select set_config('helm.maintenance', 'off', true);
select pg_temp.t('8h a circle that is already stored: other edits still work, nothing hangs, joining it is fine, it can be taken apart', pg_temp.as_val('a_admin@a.test', $q$update public.event_tasks set note = 'x' where id = 'a0000000-0000-4000-8000-00000f530501' returning note$q$) = 'ok:x'
  and pg_temp.sched('0505', '0501') like 'ok:%' and pg_temp.sched('0501', null) = 'ok:<null>');

select name, result from _rs where result <> 'PASS' order by name;
select case when count(*) filter (where result <> 'PASS') = 0
            then 'R253-START-NOW-MAIL-0436: ALL PASS (' || count(*) || '/' || count(*) || ')'
            else 'R253-START-NOW-MAIL-0436: FAILURES (' || count(*) filter (where result <> 'PASS') || ' of ' || count(*) || ')' end as summary
  from _rs;
rollback;
