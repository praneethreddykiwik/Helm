-- r149-indexes-0344.sql - R149: missing indexes (0344) + comms_outbox_unsub back (the APPLY-0165 gap).
-- Proves: (1) all 34 indexes exist, valid, on the planned table + columns; no table filtered by org_id in row security
-- is left without an index starting with org_id; the planner can use the new indexes for the quote -> lead sync lookup,
-- the Live Status task lookup, the every-minute task reminder window and a studio's team list; (2) comms_outbox_unsub
-- has the 0165 body byte for byte, service role only, and answers what comms-dispatch reads (ok / opted_out / token),
-- including after the recipient unsubscribes; anon + studio users refused; (3) on a database like prod (function
-- missing because the short APPLY-0165 was pasted) 0344 alone brings it back with the right privileges; (4) re-running
-- 0344 twice changes no index, no function and no row. Local disposable PG only. Fake data only. Rolled back.
\set ON_ERROR_STOP 0
set client_min_messages = warning;
begin;
create temp table _rs(name text, result text); grant all on _rs to anon, authenticated, service_role;
create or replace function pg_temp.t(p_name text, p_ok boolean, p_detail text default '') returns void language plpgsql as $$
begin insert into _rs values (p_name, case when coalesce(p_ok, false) then 'PASS' else 'FAIL: ' || coalesce(p_detail, '') end); end $$;
create or replace function pg_temp.as_val(p_who text, p_sql text) returns text language plpgsql as $$
declare v text;
begin
  if p_who = 'anon' then perform auth.login_anon();
  elsif p_who = 'svc' then
    perform set_config('request.jwt.claims', '{"role":"service_role"}', true); execute 'set local role service_role';
  elsif p_who is not null then perform auth.login_as((select id from auth.users where email = p_who)); end if;
  execute p_sql into v;
  execute 'reset role'; perform auth.logout(); execute 'reset role';
  return 'ok:' || coalesce(v, '<null>');
exception when others then
  execute 'reset role'; perform auth.logout(); execute 'reset role';
  return sqlstate || ' ' || sqlerrm;
end $$;
-- the plan of a query with seq scans off (the fixture tables are tiny - this proves the index fits the query)
create or replace function pg_temp.plan_text(p_sql text) returns text language plpgsql set enable_seqscan = off as $$
declare r record; v text := '';
begin
  for r in execute 'explain (format text) ' || p_sql loop v := v || r."QUERY PLAN" || ' '; end loop;
  return v;
end $$;
create temp table _ix(t text, idx text, def text);
insert into _ix(t, idx, def) values
  ('chat_reactions', 'ix_chat_reactions_org_id_0344', '(org_id)'), ('client_booklets', 'ix_client_booklets_org_id_0344', '(org_id)'),
  ('client_link_opens', 'ix_client_link_opens_org_id_0344', '(org_id)'), ('event_checkin_sites', 'ix_event_checkin_sites_org_id_0344', '(org_id)'),
  ('event_files', 'ix_event_files_org_id_0344', '(org_id)'), ('inbox_person_prefs', 'ix_inbox_person_prefs_org_id_0344', '(org_id)'),
  ('notification_mutes', 'ix_notification_mutes_org_id_0344', '(org_id)'), ('open_shift_claims', 'ix_open_shift_claims_org_id_0344', '(org_id)'),
  ('package_selections', 'ix_package_selections_org_id_0344', '(org_id)'), ('pkg_credits', 'ix_pkg_credits_org_id_0344', '(org_id)'),
  ('profiles', 'ix_profiles_org_id_0344', '(org_id)'), ('quotation_versions', 'ix_quotation_versions_org_id_0344', '(org_id)'),
  ('quote_validity_log', 'ix_quote_validity_log_org_id_0344', '(org_id)'), ('user_dashboard_prefs', 'ix_user_dashboard_prefs_org_id_0344', '(org_id)'),
  ('user_recent_records', 'ix_user_recent_records_org_id_0344', '(org_id)'),
  ('leads', 'ix_leads_quote_id_0344', '(quote_id)'), ('assign_notify_outbox', 'ix_assign_notify_outbox_quote_id_0344', '(quote_id)'),
  ('task_wa_outbox', 'ix_task_wa_outbox_org_id_quote_id_0344', '(org_id, quote_id)'), ('notifications', 'ix_notifications_quote_id_0344', '(quote_id)'),
  ('comms_outbox', 'ix_comms_outbox_quote_id_0344', '(quote_id)'), ('comms_outbox', 'ix_comms_outbox_org_id_created_at_0344', '(org_id, created_at)'),
  ('delivery_commitments', 'ix_delivery_commitments_org_id_0344', '(org_id)'),
  ('delivery_reminder_sends', 'ix_delivery_reminder_sends_commitment_id_0344', '(commitment_id)'),
  ('delivery_reminder_sends', 'ix_delivery_reminder_sends_org_id_created_at_0344', '(org_id, created_at)'),
  ('vendor_request_sends', 'ix_vendor_request_sends_request_id_0344', '(request_id)'), ('vendor_bills', 'ix_vendor_bills_booking_id_0344', '(booking_id)'),
  ('vendor_bills', 'ix_vendor_bills_vendor_id_0344', '(vendor_id)'), ('vendor_bills', 'ix_vendor_bills_file_id_0344', '(file_id)'),
  ('event_costs', 'ix_event_costs_booking_id_0344', '(booking_id)'), ('vendor_invoices', 'ix_vendor_invoices_booking_id_0344', '(booking_id)'),
  ('event_resources', 'ix_event_resources_need_id_0344', '(need_id)'), ('lead_enquiries', 'ix_lead_enquiries_lead_id_0344', '(lead_id)'),
  ('welcome_email_outbox', 'ix_welcome_email_outbox_org_id_0344', '(org_id)'), ('event_tasks', 'ix_event_tasks_planned_start_0344', '(planned_start)');
-- every index of the database before the re-runs (name + definition)
create temp table _idx0 as select indexrelid::regclass::text n, pg_get_indexdef(indexrelid) d from pg_index i join pg_class c on c.oid = i.indrelid where c.relnamespace = 'public'::regnamespace;

-- ---- 1) the indexes -------------------------------------------------------------------------------------------
select pg_temp.t('1a 34 R149 indexes, all valid and ready',
  (select count(*) from pg_index i join pg_class c on c.oid = i.indexrelid where c.relnamespace = 'public'::regnamespace
     and c.relname like 'ix%' and right(c.relname, 5) = '_0344' and i.indisvalid and i.indisready) = 34
  and (select count(*) from _ix) = 34);
select pg_temp.t('1b each one on the planned table + columns, plain btree, not unique, no WHERE',
  not exists (select 1 from _ix x where not exists (
     select 1 from pg_indexes p where p.schemaname = 'public' and p.tablename = x.t and p.indexname = x.idx
        and p.indexdef = 'CREATE INDEX ' || x.idx || ' ON public.' || x.t || ' USING btree ' || x.def)),
  (select string_agg(x.idx, ', ') from _ix x where not exists (select 1 from pg_indexes p where p.indexname = x.idx and p.tablename = x.t)));
select pg_temp.t('1c no table filtered by org_id in row security is left without an index starting with org_id',
  not exists (select 1 from pg_policies p join pg_class c on c.relname = p.tablename and c.relnamespace = 'public'::regnamespace
     join pg_attribute a on a.attrelid = c.oid and a.attname = 'org_id' and not a.attisdropped
    where p.schemaname = 'public' and (coalesce(p.qual, '') ~ '\morg_id\M' or coalesce(p.with_check, '') ~ '\morg_id\M')
      and not exists (select 1 from pg_index i where i.indrelid = c.oid and i.indkey[0] = a.attnum)));
select pg_temp.t('1d quote -> lead sync lookup (sync_quote_to_lead) uses ix_leads_quote_id_0344',
  position('ix_leads_quote_id_0344' in pg_temp.plan_text($q$select * from public.leads where quote_id = 'a0000000-0000-4000-8000-00000000da01' and org_id = 'a0000000-0000-4000-8000-000000000001' limit 1$q$)) > 0,
  pg_temp.plan_text($q$select * from public.leads where quote_id = 'a0000000-0000-4000-8000-00000000da01' and org_id = 'a0000000-0000-4000-8000-000000000001' limit 1$q$));
select pg_temp.t('1e Live Status (task_wa_status) uses the task_wa_outbox + assign_notify_outbox indexes',
  position('ix_task_wa_outbox_org_id_quote_id_0344' in pg_temp.plan_text($q$select task_id from public.task_wa_outbox o where o.quote_id = 'a0000000-0000-4000-8000-00000000da01' and o.org_id = 'a0000000-0000-4000-8000-000000000001'$q$)) > 0
  and position('ix_assign_notify_outbox_quote_id_0344' in pg_temp.plan_text($q$select item_id from public.assign_notify_outbox a where a.quote_id = 'a0000000-0000-4000-8000-00000000da01' and a.item_kind = 'task'$q$)) > 0);
select pg_temp.t('1f every-minute task reminder window uses ix_event_tasks_planned_start_0344',
  position('ix_event_tasks_planned_start_0344' in pg_temp.plan_text($q$select id from public.event_tasks t where t.planned_start between now() - interval '1 day' and now() + interval '25 hours' and t.status in ('assigned', 'accepted')$q$)) > 0);
select pg_temp.t('1g a studio team list (profiles by org_id) + event activity (notifications by quote) use the new indexes',
  position('ix_profiles_org_id_0344' in pg_temp.plan_text($q$select id from public.profiles where org_id = 'a0000000-0000-4000-8000-000000000001'$q$)) > 0
  and position('ix_notifications_quote_id_0344' in pg_temp.plan_text($q$select id from public.notifications where quote_id = 'a0000000-0000-4000-8000-00000000da01'$q$)) > 0);

-- ---- 2) comms_outbox_unsub --------------------------------------------------------------------------------------
select pg_temp.t('2a comms_outbox_unsub(uuid): plpgsql, stable, security definer, empty search_path, returns jsonb, 0165 marker',
  (select p.prosecdef and p.provolatile = 's' and p.prorettype = 'jsonb'::regtype and l.lanname = 'plpgsql'
          and p.proconfig = array['search_path=""'] and position('email-unsub-0165' in p.prosrc) > 0
     from pg_proc p join pg_language l on l.oid = p.prolang where p.oid = to_regprocedure('public.comms_outbox_unsub(uuid)')));
select pg_temp.t('2b service role only: anon, authenticated and PUBLIC cannot run it',
  has_function_privilege('service_role', 'public.comms_outbox_unsub(uuid)', 'execute')
  and not has_function_privilege('anon', 'public.comms_outbox_unsub(uuid)', 'execute')
  and not has_function_privilege('authenticated', 'public.comms_outbox_unsub(uuid)', 'execute')
  and not exists (select 1 from pg_proc p, aclexplode(p.proacl) a where p.oid = to_regprocedure('public.comms_outbox_unsub(uuid)') and a.grantee = 0));
insert into public.comms_outbox(org_id, quote_id, purpose, channel, recipient, payload, dedupe_key, status)
  values ('a0000000-0000-4000-8000-000000000001', 'a0000000-0000-4000-8000-00000000da01', 'follow_up', 'email', 'r149.client@example.com',
          '{"studio":"Studio A"}', 'r149test:fu:1', 'pending');
create temp table _u as select id from public.comms_outbox where dedupe_key = 'r149test:fu:1';
grant select on _u to service_role, anon, authenticated;
select pg_temp.t('2c comms-dispatch view of a follow-up row: ok, not opted out, a signed token that verifies',
  pg_temp.as_val('svc', $q$select (public.comms_outbox_unsub((select id from _u)) ->> 'ok') || '|' || (public.comms_outbox_unsub((select id from _u)) ->> 'opted_out')
     || '|' || (public.email_unsub_status(public.comms_outbox_unsub((select id from _u)) ->> 'token') ->> 'ok')
     || '|' || left(public.comms_outbox_unsub((select id from _u)) ->> 'token', 3)$q$) = 'ok:true|false|true|v1.',
  pg_temp.as_val('svc', $q$select public.comms_outbox_unsub((select id from _u))::text$q$));
select pg_temp.t('2d after the client clicks unsubscribe the same row answers opted_out = true (dispatcher skips it)',
  pg_temp.as_val('svc', $q$select (public.email_unsub_set(public.comms_outbox_unsub((select id from _u)) ->> 'token', true, 'link') ->> 'opted_out')$q$) = 'ok:true'
  and pg_temp.as_val('svc', $q$select public.comms_outbox_unsub((select id from _u)) ->> 'opted_out'$q$) = 'ok:true');
select pg_temp.t('2e an unknown row answers ok = false (fail closed)',
  pg_temp.as_val('svc', $q$select public.comms_outbox_unsub('00000000-0000-0000-0000-000000000000')::text$q$) = 'ok:{"ok": false}');
select pg_temp.t('2f anon and a studio admin are refused (42501)',
  pg_temp.as_val('anon', $q$select public.comms_outbox_unsub((select id from _u))::text$q$) like '42501%'
  and pg_temp.as_val('a_admin@a.test', $q$select public.comms_outbox_unsub((select id from _u))::text$q$) like '42501%');

-- every table row count before the re-runs below
create temp table _rows0(t text, n bigint);
do $$ declare r record; v bigint; begin
  for r in select c.relname from pg_class c where c.relnamespace = 'public'::regnamespace and c.relkind = 'r' loop
    execute format('select count(*) from public.%I', r.relname) into v; insert into _rows0 values (r.relname, v);
  end loop;
end $$;

-- ---- 3) a database like prod: the function is missing (the short APPLY-0165 was pasted) -> 0344 alone fixes it ------
alter function public.comms_outbox_unsub(uuid) rename to comms_outbox_unsub__r149test;
select pg_temp.t('3a simulated prod: comms_outbox_unsub missing, dispatcher would get an error and skip',
  to_regprocedure('public.comms_outbox_unsub(uuid)') is null
  and pg_temp.as_val('svc', $q$select public.comms_outbox_unsub((select id from _u))::text$q$) like '42883%');
set client_min_messages = error;
\ir ../../supabase/migrations/0344_r149_missing_indexes.sql
set client_min_messages = warning;
select pg_temp.t('3b 0344 alone brings it back: service role only, same answers',
  to_regprocedure('public.comms_outbox_unsub(uuid)') is not null
  and has_function_privilege('service_role', 'public.comms_outbox_unsub(uuid)', 'execute')
  and not has_function_privilege('anon', 'public.comms_outbox_unsub(uuid)', 'execute')
  and not has_function_privilege('authenticated', 'public.comms_outbox_unsub(uuid)', 'execute')
  and not exists (select 1 from pg_proc p, aclexplode(p.proacl) a where p.oid = to_regprocedure('public.comms_outbox_unsub(uuid)') and a.grantee = 0)
  and pg_temp.as_val('svc', $q$select (public.comms_outbox_unsub((select id from _u)) ->> 'ok') || '|' || (public.comms_outbox_unsub((select id from _u)) ->> 'opted_out')$q$) = 'ok:true|true');
select pg_temp.t('3c the restored body is the one the database had',
  (select prosrc from pg_proc where oid = to_regprocedure('public.comms_outbox_unsub(uuid)'))
  = (select prosrc from pg_proc where oid = to_regprocedure('public.comms_outbox_unsub__r149test(uuid)')));

-- ---- 4) re-run 0344 twice: nothing else changes -------------------------------------------------------------------
set client_min_messages = error;
\ir ../../supabase/migrations/0344_r149_missing_indexes.sql
\ir ../../supabase/migrations/0344_r149_missing_indexes.sql
set client_min_messages = warning;
select pg_temp.t('4a re-run twice: every index of the database the same (none added, none dropped, none changed)',
  not exists ((select n, d from _idx0 except select indexrelid::regclass::text, pg_get_indexdef(indexrelid) from pg_index i join pg_class c on c.oid = i.indrelid where c.relnamespace = 'public'::regnamespace)
              union all
              (select indexrelid::regclass::text, pg_get_indexdef(indexrelid) from pg_index i join pg_class c on c.oid = i.indrelid where c.relnamespace = 'public'::regnamespace except select n, d from _idx0)));
select pg_temp.t('4b re-run twice: one comms_outbox_unsub, still service role only',
  (select count(*) from pg_proc where proname = 'comms_outbox_unsub' and pronamespace = 'public'::regnamespace) = 1
  and has_function_privilege('service_role', 'public.comms_outbox_unsub(uuid)', 'execute')
  and not has_function_privilege('authenticated', 'public.comms_outbox_unsub(uuid)', 'execute'));
create temp table _rows1(t text, n bigint);
do $$ declare r record; v bigint; begin
  for r in select t from _rows0 loop execute format('select count(*) from public.%I', r.t) into v; insert into _rows1 values (r.t, v); end loop;
end $$;
select pg_temp.t('4c the three 0344 runs added or deleted no row in any table (every row count the same)',
  not exists (select 1 from _rows0 a join _rows1 b using (t) where a.n <> b.n) and (select count(*) from _rows1) = (select count(*) from _rows0),
  (select string_agg(a.t || ' ' || a.n || '->' || b.n, ', ') from _rows0 a join _rows1 b using (t) where a.n <> b.n));
-- the 0165 file itself re-creates the same body (proves 0344 copies it exactly; rolled back)
create temp table _b344 as select prosrc s from pg_proc where oid = to_regprocedure('public.comms_outbox_unsub(uuid)');
set client_min_messages = error;
\ir ../../supabase/migrations/0165_email_unsubscribe.sql
set client_min_messages = warning;
select pg_temp.t('4d migrations/0165 and 0344 define the same comms_outbox_unsub body',
  (select prosrc from pg_proc where oid = to_regprocedure('public.comms_outbox_unsub(uuid)')) = (select s from _b344));

do $$ declare n int; f int; r record; begin
  select count(*), count(*) filter (where result <> 'PASS') into n, f from _rs;
  for r in select * from _rs where result <> 'PASS' loop raise warning '% -> %', r.name, r.result; end loop;
  if f = 0 then raise warning 'R149-INDEXES-0344: ALL PASS (%/%)', n, n;
  else raise warning 'R149-INDEXES-0344: % FAILED of %', f, n; end if;
end $$;
rollback;
