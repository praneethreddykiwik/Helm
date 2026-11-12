-- r156-wa-template-jobs-0354.sql - R156: WhatsApp templates set up in the background. Proves: (1) structure - tables with
-- row security, unique key, grants, kept notification bodies; (2) enqueue is idempotent (same names twice = no second row,
-- not connected = nothing); (3) claim takes due rows only, within Meta's hourly budget, never twice while leased; (4) record:
-- created / retry with a growing wait / failed with a clean Meta error (no link, no token) / rate-limit pause; (5) sync:
-- states, category change recorded, older templates recorded; (6) ONE bell notice per round (approved / rejected), admins
-- only; (7) Fix and resubmit: admin only, own studio only, rejected / failed only; (8) row security: studio admins read their
-- own rows, members / other studio / anon nothing, nobody writes directly; (9) health warnings = one notice per new set;
-- (10) the sender variant, due studios, the cron kick without secrets. Re-applies 0354 twice. Local disposable PG only.
-- Fake data only. Rolled back.
\set ON_ERROR_STOP 0
set client_min_messages = error;
\ir ../../supabase/migrations/0337_r129_studio_whatsapp.sql
\ir ../../supabase/migrations/0353_r154h_wa_details.sql
\ir ../../supabase/migrations/0354_r156_wa_template_jobs.sql
\ir ../../supabase/migrations/0354_r156_wa_template_jobs.sql
set client_min_messages = warning;
begin;
create schema if not exists vault;
create table if not exists vault.secrets (id uuid primary key default gen_random_uuid(), secret text, name text, description text);
create or replace view vault.decrypted_secrets as select id, secret as decrypted_secret, name from vault.secrets;
create or replace function vault.create_secret(p_secret text, p_name text, p_desc text) returns uuid language sql as $$
  insert into vault.secrets(secret, name, description) values (p_secret, p_name, p_desc) returning id $$;
create or replace function vault.update_secret(p_id uuid, p_secret text) returns void language sql as $$
  update vault.secrets set secret = p_secret where id = p_id $$;

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
\set A '''a0000000-0000-4000-8000-000000000001'''
\set B '''b0000000-0000-4000-8000-000000000001'''
delete from public.org_whatsapp_accounts where org_id in (:A, :B);

-- ---- 1) structure ---------------------------------------------------------------------------------------------------
select pg_temp.t('1a tables with row security, unique key, three kept bodies (re-run made no second copy)',
  (select bool_and(relrowsecurity) from pg_class where oid in ('public.wa_template_jobs'::regclass, 'public.wa_template_setup'::regclass))
  and exists (select 1 from pg_constraint where conname = 'wa_template_jobs_uk354')
  and (select count(*) = 3 from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname like '%\_\_pre0354'));
select pg_temp.t('1b kept bodies: no app or server privilege',
  not has_function_privilege('authenticated', 'public.notification_catalog__pre0354()', 'execute')
  and not has_function_privilege('service_role', 'public.notification_catalog__pre0354()', 'execute')
  and not has_function_privilege('service_role', 'public.notify_default__pre0354(uuid,text,text,text)', 'execute'));
select pg_temp.t('1c worker functions: server only; page functions: signed-in only',
  has_function_privilege('service_role', 'public.wa_template_claim(uuid,integer)', 'execute')
  and not has_function_privilege('authenticated', 'public.wa_template_claim(uuid,integer)', 'execute')
  and not has_function_privilege('authenticated', 'public.wa_template_enqueue(uuid,jsonb,uuid)', 'execute')
  and not has_function_privilege('authenticated', 'public.wa_health_record(uuid,jsonb)', 'execute')
  and not has_function_privilege('authenticated', 'public._r354_bell(uuid,text,text,jsonb)', 'execute')
  and has_function_privilege('authenticated', 'public.my_wa_template_setup()', 'execute')
  and not has_function_privilege('anon', 'public.my_wa_template_setup()', 'execute')
  and not has_function_privilege('anon', 'public.wa_template_resubmit(text,text)', 'execute'));
select pg_temp.t('1d nobody writes the tables directly (select only)',
  not has_table_privilege('authenticated', 'public.wa_template_jobs', 'insert') and not has_table_privilege('authenticated', 'public.wa_template_jobs', 'update')
  and not has_table_privilege('authenticated', 'public.wa_template_jobs', 'delete') and not has_table_privilege('service_role', 'public.wa_template_jobs', 'insert')
  and not has_table_privilege('anon', 'public.wa_template_jobs', 'select') and not has_table_privilege('authenticated', 'public.wa_template_setup', 'update'));
select pg_temp.t('1e the bell knows wa_templates; admins only by default; other kinds unchanged',
  public.notification_type_of('wa_templates', null) = 'wa_templates'
  and (select count(*) = 1 from jsonb_array_elements(public.notification_catalog()) e where e ->> 'type' = 'wa_templates')
  and public.notify_default(:A, 'admin', 'wa_templates', 'in_app') and not public.notify_default(:A, 'staff', 'wa_templates', 'in_app')
  and public.notification_type_of('plan_active', null) = 'plan_active');

select pg_temp.t('1f free-trial retention: both tables are KEPT (like org_whatsapp_accounts), nothing unclassified',
  'wa_template_jobs' = any(public._tr184_keep_tables()) and 'wa_template_setup' = any(public._tr184_keep_tables())
  and not ('wa_template_jobs' = any(public._tr184_purge_tables())) and public.trial_retention_dry_run() -> 'unclassified_tables' = '[]'::jsonb);

-- ---- 2) enqueue -----------------------------------------------------------------------------------------------------
select pg_temp.t('2a not connected = nothing queued', (public.wa_template_enqueue(:A, '[{"name":"proposal_sent"}]'::jsonb) ->> 'reason') = 'not_connected'
  and not exists (select 1 from public.wa_template_jobs where org_id = :A));
select pg_temp.as_val('a_admin@a.test', $q$select public.save_org_whatsapp_account('1000000354', '2000000354', 'test-token-0354-xxxxxxxxxxxxxxxx')::text$q$);
select public.wa_account_verified(:A, true, '+91 90000 00354', 'Studio A', 'GREEN');
select public.wa_template_enqueue(:A, '[{"name":"proposal_sent","language":"en"},{"name":"staff_shift_result"},{"name":"vendor_request"},{"name":"Bad Name!"}]'::jsonb) ->> 'queued' as v \gset
select pg_temp.t('2b connected: three names queued in one round (a bad name skipped)', :'v' = '3'
  and (select count(*) = 3 and count(distinct batch_id) = 1 and bool_and(state = 'queued') from public.wa_template_jobs where org_id = :A));
select public.wa_template_enqueue(:A, '[{"name":"proposal_sent"},{"name":"staff_shift_result"},{"name":"vendor_request"}]'::jsonb) ->> 'queued' as v \gset
select pg_temp.t('2c the same names again: nothing new (idempotent), the round stays the same', :'v' = '0'
  and (select count(*) = 3 and count(distinct batch_id) = 1 from public.wa_template_jobs where org_id = :A));
select pg_temp.t('2d the unique key refuses a second row for the same name + language', (select count(*) = 1 from public.wa_template_jobs where org_id = :A and name = 'proposal_sent'));

-- ---- 3) claim -------------------------------------------------------------------------------------------------------
create temp table _c as select jsonb_array_elements(public.wa_template_claim(:A, 2)) j;
select pg_temp.t('3a claim takes 2 due rows and leases them', (select count(*) = 2 from _c)
  and (select count(*) = 2 from public.wa_template_jobs where org_id = :A and state = 'creating' and lease_until > now()));
select pg_temp.t('3b a second claim takes only the third (leased rows are never handed out twice)',
  jsonb_array_length(public.wa_template_claim(:A, 5)) = 1);
select pg_temp.t('3c nothing left to claim', jsonb_array_length(public.wa_template_claim(:A, 5)) = 0);
select pg_temp.t('3d the other studio claims nothing of A', jsonb_array_length(public.wa_template_claim(:B, 5)) = 0);

-- ---- 4) record ------------------------------------------------------------------------------------------------------
create temp table _ids as select name, id from public.wa_template_jobs where org_id = :A;
select public.wa_template_record((select id from _ids where name = 'proposal_sent'), '{"outcome":"created","counted":true,"meta_id":"9000000001","meta_status":"PENDING","category":"UTILITY","variant":"own"}') ->> 'result' as v \gset
select pg_temp.t('4a created -> pending with the Meta id, category and the own wording', :'v' = 'pending'
  and (select state = 'pending' and meta_id = '9000000001' and category = 'UTILITY' and variant = 'own' from public.wa_template_jobs where name = 'proposal_sent' and org_id = :A));
select pg_temp.t('4b a create is counted for the hourly budget', public._r354_creates_last_hour(:A) = 1);
select public.wa_template_record((select id from _ids where name = 'staff_shift_result'), jsonb_build_object('outcome', 'retry', 'counted', true,
     'error', jsonb_build_object('reason', 'other', 'code', 1, 'status', 500, 'message', 'Temporary https://graph.facebook.com/x?access_token=abc problem EAAGabcdefghijklmnopqrstuvwxyz0123456789'))) ->> 'result' as v \gset
select pg_temp.t('4c retry -> queued again with a wait, one attempt, the error kept without the link or the token', :'v' = 'retry'
  and (select state = 'queued' and attempts = 1 and next_attempt_at > now() + interval '50 seconds'
          and last_error ->> 'message' not like '%http%' and last_error ->> 'message' not like '%EAAG%' and last_error ->> 'message' like '%[link]%'
     from public.wa_template_jobs where name = 'staff_shift_result' and org_id = :A));
select pg_temp.t('4d a row that waits is not claimed before its time', jsonb_array_length(public.wa_template_claim(:A, 5)) = 0);
select public.wa_template_record((select id from _ids where name = 'vendor_request'), '{"outcome":"failed","counted":true,"error":{"reason":"ratio","code":100,"subcode":2388293,"title":"Too many variables","message":"too many variables for its length"}}') ->> 'result' as v \gset
select pg_temp.t('4e failed (wording refused) -> failed with Meta code + subcode', :'v' = 'failed'
  and (select state = 'failed' and (last_error ->> 'subcode') = '2388293' and last_error ->> 'reason' = 'ratio' from public.wa_template_jobs where name = 'vendor_request' and org_id = :A));
select pg_temp.t('4f a result for a row not being created is ignored', (public.wa_template_record((select id from _ids where name = 'vendor_request'), '{"outcome":"created"}') ->> 'result') = 'ignored');
update public.wa_template_jobs set state = 'queued', attempts = 7, next_attempt_at = now() - interval '1 second' where org_id = :A and name = 'staff_shift_result';
select public.wa_template_claim(:A, 1);
select pg_temp.t('4g eight tries at most: the 8th failed try marks it failed', (public.wa_template_record((select id from _ids where name = 'staff_shift_result'), '{"outcome":"retry"}') ->> 'result') = 'failed');
-- rate limit pause
select public.wa_template_enqueue(:A, '[{"name":"crew_runsheet_reminder"},{"name":"vendor_invoice_update"}]'::jsonb);
select public.wa_template_claim(:A, 1);
select public.wa_template_record((select id from public.wa_template_jobs where org_id = :A and state = 'creating' limit 1), '{"outcome":"paused","retry_minutes":60,"error":{"reason":"rate_limit","code":80008}}') ->> 'result' as v \gset
select pg_temp.t('4i a Meta rate limit pauses the studio (nothing claimed while paused)', :'v' = 'paused'
  and (select paused_until > now() + interval '50 minutes' from public.wa_template_setup where org_id = :A)
  and jsonb_array_length(public.wa_template_claim(:A, 5)) = 0
  and (select count(*) = 2 from public.wa_template_jobs where org_id = :A and state = 'queued'));
update public.wa_template_setup set paused_until = null where org_id = :A;
update public.wa_template_jobs set next_attempt_at = now() - interval '1 second' where org_id = :A and state = 'queued';
update public.wa_template_setup set create_times = (select jsonb_agg(to_char(now() at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')) from generate_series(1, 100)) where org_id = :A;
select pg_temp.t('4j at 100 creates in the last hour nothing more is claimed (Meta limit)', jsonb_array_length(public.wa_template_claim(:A, 5)) = 0);
update public.wa_template_setup set create_times = '[]'::jsonb where org_id = :A;
select pg_temp.t('4k after the hour: claimed again', jsonb_array_length(public.wa_template_claim(:A, 5)) = 2);
select public.wa_template_record(id, '{"outcome":"created","counted":true,"meta_status":"PENDING","category":"UTILITY"}') from public.wa_template_jobs where org_id = :A and state = 'creating';

-- ---- 5) sync ----------------------------------------------------------------------------------------------------------
select public.wa_template_sync(:A, '[
     {"name":"proposal_sent","language":"en","status":"APPROVED","category":"MARKETING","id":"9000000001"},
     {"name":"helm_notice","language":"en","status":"APPROVED","category":"UTILITY","id":"9000000009"}]'::jsonb) -> 'recategorised' -> 0 ->> 'to' as v \gset
select pg_temp.t('5a sync: approved, Meta moved one to marketing (recorded + reported), an older template recorded', :'v' = 'MARKETING'
  and (select state = 'approved' and category = 'MARKETING' and prev_category = 'UTILITY' and category_changed_at is not null from public.wa_template_jobs where org_id = :A and name = 'proposal_sent')
  and exists (select 1 from public.wa_template_jobs where org_id = :A and name = 'helm_notice' and state = 'approved' and batch_id is null));
select public.wa_template_category_notice(:A, 'proposal_sent', 'UTILITY', 'MARKETING')::text as v \gset
select public.wa_template_category_notice(:A, 'proposal_sent', 'UTILITY', 'MARKETING')::text as v2 \gset
select pg_temp.t('5b the category notice: one bell row, a second call adds nothing', :'v' = 'true' and :'v2' = 'false'
  and (select count(*) = 1 from public.notifications where org_id = :A and kind = 'wa_templates' and detail ->> 'event' = 'category_changed'));
select public.wa_template_sync(:A, '[{"name":"crew_runsheet_reminder","language":"en","status":"REJECTED","rejected_reason":"INVALID_FORMAT"}]'::jsonb) ->> 'changed' as v \gset
select pg_temp.t('5c a rejected one keeps the reason', :'v' = '1'
  and (select state = 'rejected' and rejected_reason = 'INVALID_FORMAT' from public.wa_template_jobs where org_id = :A and name = 'crew_runsheet_reminder'));

-- ---- 6) one notice per round -------------------------------------------------------------------------------------------
select public.wa_template_finish(:A) ->> 'result' as v \gset
select public.wa_template_finish(:A) ->> 'result' as v2 \gset
select pg_temp.t('6a a refused template = the rejected notice with names and reasons, once', :'v' = 'rejected' and :'v2' = 'already'
  and (select count(*) = 1 and bool_and(detail ->> 'label' like '%not approved%' and detail ->> 'label' like '%Fix and resubmit%')
         from public.notifications where org_id = :A and kind = 'wa_templates' and detail ->> 'event' = 'templates_rejected'));
select pg_temp.t('6b the bell row: admins see it, members do not',
  pg_temp.as_val('a_admin@a.test', $q$select count(*)::text from public.notifications where kind = 'wa_templates' and detail ->> 'event' = 'templates_rejected'$q$) = 'ok:1'
  and pg_temp.as_val('a_staff@a.test', $q$select count(*)::text from public.notifications where kind = 'wa_templates'$q$) = 'ok:0');
select pg_temp.t('6c a signed-in user cannot write a wa_templates bell row',
  pg_temp.as_val('a_admin@a.test', $q$insert into public.notifications(channel, kind, status, detail) values ('in_app', 'wa_templates', 'simulated', '{}') returning id::text$q$) like '42501%');

-- ---- 7) Fix and resubmit ----------------------------------------------------------------------------------------------
select pg_temp.t('7a a member cannot resubmit', pg_temp.as_val('a_staff@a.test', $q$select public.wa_template_resubmit('crew_runsheet_reminder')::text$q$) like '42501%');
select pg_temp.t('7b the other studio admin cannot reach A templates', pg_temp.as_val('b_admin@b.test', $q$select public.wa_template_resubmit('crew_runsheet_reminder')::text$q$) like '22023%');
select pg_temp.t('7c an approved one is not resubmittable', pg_temp.as_val('a_admin@a.test', $q$select public.wa_template_resubmit('proposal_sent')::text$q$) like '22023%not_resubmittable%');
update public.wa_template_jobs set meta_id = '9000000007' where org_id = :A and name = 'crew_runsheet_reminder';
select pg_temp.as_val('a_admin@a.test', $q$select public.wa_template_resubmit('crew_runsheet_reminder') ->> 'ok'$q$) as v \gset
select pg_temp.t('7d the admin resubmits a rejected one: queued as an edit, in a NEW round', :'v' = 'ok:true'
  and (select state = 'queued' and action = 'resubmit' and attempts = 0 from public.wa_template_jobs where org_id = :A and name = 'crew_runsheet_reminder')
  and (select batch_id is distinct from notified_batch and finished_at is null from public.wa_template_setup where org_id = :A));
select pg_temp.as_val('a_admin@a.test', $q$select public.wa_template_resubmit('vendor_request') ->> 'ok'$q$) as v \gset
select pg_temp.t('7e a failed one (never created at Meta) is queued as a new create', :'v' = 'ok:true'
  and (select action = 'create' and state = 'queued' from public.wa_template_jobs where org_id = :A and name = 'vendor_request'));
select public.wa_template_claim(:A, 5);
select public.wa_template_record(id, '{"outcome":"created","counted":true,"meta_status":"APPROVED","category":"UTILITY"}') from public.wa_template_jobs where org_id = :A and state = 'creating';
select public.wa_template_finish(:A) ->> 'result' as v0 \gset
select public.wa_template_sync(:A, '[{"name":"vendor_invoice_update","language":"en","status":"APPROVED","category":"UTILITY"}]'::jsonb);
select public.wa_template_finish(:A) ->> 'result' as v \gset
select public.wa_template_finish(:A) ->> 'result' as v2 \gset
select pg_temp.t('7f the new round (with the one still waiting from round 1) all approved -> ONE approved notice', :'v0' = 'waiting' and :'v' = 'approved' and :'v2' = 'already'
  and (select count(*) = 1 from public.notifications where org_id = :A and kind = 'wa_templates' and detail ->> 'event' = 'templates_approved'));

-- ---- 8) row security --------------------------------------------------------------------------------------------------
select pg_temp.t('8a the studio admin reads its own rows', pg_temp.as_val('a_admin@a.test', $q$select count(*)::text from public.wa_template_jobs$q$) = 'ok:' || (select count(*) from public.wa_template_jobs where org_id = :A)::text);
select pg_temp.t('8b a member reads nothing', pg_temp.as_val('a_staff@a.test', $q$select count(*)::text from public.wa_template_jobs$q$) = 'ok:0'
  and pg_temp.as_val('a_staff@a.test', $q$select count(*)::text from public.wa_template_setup$q$) = 'ok:0');
select pg_temp.t('8c the other studio admin reads nothing of A', pg_temp.as_val('b_admin@b.test', $q$select count(*)::text from public.wa_template_jobs where org_id = 'a0000000-0000-4000-8000-000000000001'$q$) = 'ok:0');
select pg_temp.t('8d anon is refused', pg_temp.as_val('anon', $q$select count(*)::text from public.wa_template_jobs$q$) like '42501%');
select pg_temp.t('8e the admin cannot write directly', pg_temp.as_val('a_admin@a.test', $q$update public.wa_template_jobs set state = 'approved' returning id::text$q$) like '42501%'
  and pg_temp.as_val('a_admin@a.test', $q$delete from public.wa_template_jobs returning id::text$q$) like '42501%');
select pg_temp.t('8f the page function: admin sees jobs + reasons, member refused',
  pg_temp.as_val('a_admin@a.test', $q$select (jsonb_array_length(s -> 'jobs') >= 6)::text || '|' || (s ->> 'running') from public.my_wa_template_setup() s$q$) = 'ok:true|false'
  and pg_temp.as_val('a_staff@a.test', $q$select public.my_wa_template_setup()::text$q$) like '42501%'
  and pg_temp.as_val('a_admin@a.test', $q$select public.my_wa_template_setup()::text$q$) not like '%test-token-0354%');

-- ---- 9) health -------------------------------------------------------------------------------------------------------------
select (public.wa_health_record(:A, '{"quality":"RED","tier":"TIER_250","payment_issue":true,"limit_low":true,"warnings":["quality_red","payment","limit_low","not a code"]}') -> 'warnings')::text as v \gset
select public.wa_health_record(:A, '{"quality":"RED","tier":"TIER_250","warnings":["quality_red","payment","limit_low"]}') ->> 'result' as v2 \gset
select pg_temp.t('9a a red quality + payment problem = one notice, the same set again = none', :'v'::jsonb = '["quality_red", "payment", "limit_low"]'::jsonb and :'v2' = 'recorded'
  and (select count(*) = 1 and bool_and(detail ->> 'label' like '%quality rating is red%' and detail ->> 'label' like '%payment method%') from public.notifications where org_id = :A and kind = 'wa_templates' and detail ->> 'event' = 'health'));
select pg_temp.t('9b health shown on the page (words only)', pg_temp.as_val('a_admin@a.test', $q$select s #>> '{health,quality}' from public.my_wa_template_setup() s$q$) = 'ok:RED');

-- ---- 10) senders, due studios, cron kick -----------------------------------------------------------------------------------
select public.wa_template_enqueue(:A, '[{"name":"payment_received"}]'::jsonb);
select public.wa_template_claim(:A, 1);
select public.wa_template_record((select id from public.wa_template_jobs where org_id = :A and name = 'payment_received'),
  '{"outcome":"created","counted":true,"meta_status":"PENDING","variant":"library","library_name":"payment_confirmation_2","param_map":{"fields":["name","amount"],"url_button":false}}');
select pg_temp.t('10a the sender learns the library version and its blank order',
  (public.wa_template_variant(:A, 'payment_received') ->> 'variant') = 'library'
  and (public.wa_template_variant(:A, 'payment_received') #>> '{param_map,fields,1}') = 'amount'
  and public.wa_template_variant(:A, 'proposal_approved_pay') is null);
update public.wa_template_setup set next_sync_at = null where org_id = :A;
select pg_temp.t('10b a waiting template makes the studio due for a status check; a studio without a connection never is',
  :A = any(public.wa_template_due_orgs(false, 50)) and not (:B = any(public.wa_template_due_orgs(true, 50))));
select pg_temp.t('10c the cron kick does nothing without pg_net / the Vault secrets', public._r354_kick('tick') is false);
select pg_temp.t('10d nothing deleted: the studio row and every job row are still there',
  (select count(*) = 1 from public.org_whatsapp_accounts where org_id = :A) and (select count(*) >= 7 from public.wa_template_jobs where org_id = :A));

-- ---- result ----------------------------------------------------------------------------------------------------------------
do $$ declare n int; f int; r record; begin
  select count(*), count(*) filter (where result <> 'PASS') into n, f from _rs;
  for r in select * from _rs where result <> 'PASS' loop raise warning '% -> %', r.name, r.result; end loop;
  if f = 0 then raise warning 'R156-WA-TEMPLATE-JOBS-0354: ALL PASS (%/%)', n, n;
  else raise warning 'R156-WA-TEMPLATE-JOBS-0354: % FAILED of %', f, n; end if;
end $$;
rollback;
