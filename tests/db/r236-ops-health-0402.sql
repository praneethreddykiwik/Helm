-- r236-ops-health-0402.sql -- R236: ops health heartbeat, mailer cron jobs in code, no double send, growing wait (0402).
-- Proves: (1) structure - new tables with row security and no app privilege, every function definer with an empty
-- search_path, only ops_health for signed-in users (HQ gate inside), the three sender calls for the service role only,
-- 7 claim bodies kept once as __pre0402 without privilege, one backoff trigger per staff / reminder queue;
-- (2) heartbeat - counts only (text / bad keys dropped), bad name / status refused, runs counted, last good run kept;
-- (3) send ledger - a note is listed, closed (never deleted) once its row is marked, bad lane refused, old notes closed;
-- (4) growing wait - a failed staff e-mail waits (next_attempt_at, lease pushed, not handed out at once), the claim then
-- gives up after 8 tries, not 5; with helm.retry_backoff = off: no wait and 5 tries (the older suites);
-- (5) mailer jobs - without the Vault secret nothing is created (state says why); with it the job is created with the
-- code command, once; a hand-made job is never changed (owner_version), another job calling the function blocks a second
-- one; the kick posts to <base>/<function> with the secret from Vault and FAILS when it is missing; the report never shows a
-- command; adopt switches only by hand; the address can come from helm_wa_worker_url; re-applying 0402 changes no job;
-- (6) ops_health / hq_ops_health (the HQ page call) - anon / studio users refused, HQ owner + viewer read it; 18 queues; old waiting row = red, failed = amber;
-- stale / missing / paused jobs; refused calls (401) red, "dormant" answers amber; heartbeat switched off = red, fresh =
-- green; reading changes nothing; cron interval parsing.
-- Re-applies 0402 twice. Local disposable PG only. Fake data only. Rolled back.
\set ON_ERROR_STOP 0
set client_min_messages = error;
\ir ../../supabase/migrations/0402_r236_ops_health.sql
\ir ../../supabase/migrations/0402_r236_ops_health.sql
set client_min_messages = warning;
begin;
create temp table _rs(name text, result text); grant all on _rs to anon, authenticated, service_role;
create or replace function pg_temp.t(p_name text, p_ok boolean, p_detail text default '') returns void language plpgsql as $$
begin insert into _rs values (p_name, case when coalesce(p_ok, false) then 'PASS' else 'FAIL: ' || coalesce(p_detail, '') end); end $$;
grant execute on function pg_temp.t(text, boolean, text) to anon, authenticated, service_role;
create or replace function pg_temp.su() returns void language plpgsql as $$
begin execute 'reset role'; perform auth.logout(); execute 'reset role'; perform set_config('request.jwt.claims', '', false);
  perform set_config('request.headers', '', false); end $$;
create or replace function pg_temp.hq(p_email text) returns void language plpgsql as $$
declare u uuid; begin
  perform pg_temp.su(); select id into u from auth.users where email = p_email;
  perform set_config('request.jwt.claims', jsonb_build_object('sub', u, 'role', 'authenticated', 'email', p_email, 'aal', 'aal2')::text, false);
  perform set_config('role', 'authenticated', false);
end $$;
create or replace function pg_temp.staff(p_email text, p_role text) returns void language plpgsql as $$
begin
  perform pg_temp.su();
  if not exists (select 1 from auth.users where email = p_email) then perform auth.seed_user(p_email); end if;
  update auth.users set email_confirmed_at = now() where email = p_email;
  insert into public.platform_admins(email, added_by, role) values (p_email, 'r236 test', p_role) on conflict (email) do nothing;
  update public.platform_admins set role = p_role, status = 'active', require_mfa = false,
         user_id = (select id from auth.users where email = p_email) where email = p_email;
end $$;
create or replace function pg_temp.try(p_sql text) returns text language plpgsql as $$
begin execute p_sql; return 'ok'; exception when others then return sqlstate || ' ' || sqlerrm; end $$;
grant execute on function pg_temp.try(text) to anon, authenticated, service_role;
create or replace function pg_temp.lvl(h jsonb, p_key text) returns text language sql as $$
  select x ->> 'level' from jsonb_array_elements(h -> 'checks') x where x ->> 'key' = p_key $$;
create or replace function pg_temp.q(h jsonb, p_tbl text) returns jsonb language sql as $$
  select x from jsonb_array_elements(h -> 'queues') x where x ->> 'name' = p_tbl $$;
create or replace function pg_temp.job(h jsonb, p_job text) returns jsonb language sql as $$
  select x from jsonb_array_elements(h -> 'jobs') x where x ->> 'name' = p_job $$;
\set A '''a0000000-0000-4000-8000-000000000001'''

-- ---- 1) structure ---------------------------------------------------------------------------------------------------
select pg_temp.t('1a new tables: row security on, no anon / signed-in privilege',
  (select bool_and(relrowsecurity) from pg_class where oid in ('public.ops_heartbeat'::regclass, 'public.ops_send_ledger'::regclass))
  and not has_table_privilege('anon', 'public.ops_heartbeat', 'select') and not has_table_privilege('authenticated', 'public.ops_heartbeat', 'select')
  and not has_table_privilege('authenticated', 'public.ops_send_ledger', 'insert') and not has_table_privilege('anon', 'public.ops_send_ledger', 'select'));
select pg_temp.t('1b every 0402 function is security definer (or plain sql helper) with an empty search_path',
  (select bool_and(coalesce(array_to_string(p.proconfig, ','), '') like '%search_path=""%') from pg_proc p
    where p.pronamespace = 'public'::regnamespace and (p.proname like '\_ops402\_%' or p.proname like 'ops\_%' or p.proname like '\_r402\_%')
      and p.proname not like '%\_\_pre0402'));
select pg_temp.t('1c signed-in may run only ops_health; the sender calls are service role only; anon runs nothing',
  has_function_privilege('authenticated', 'public.ops_health()', 'execute') and has_function_privilege('authenticated', 'public.hq_ops_health()', 'execute')
  and not has_function_privilege('anon', 'public.ops_health()', 'execute') and not has_function_privilege('anon', 'public.hq_ops_health()', 'execute')
  and not has_function_privilege('authenticated', 'public._ops402_health()', 'execute')
  and not has_function_privilege('authenticated', 'public.ops_heartbeat_beat(text,text,jsonb)', 'execute')
  and has_function_privilege('service_role', 'public.ops_heartbeat_beat(text,text,jsonb)', 'execute')
  and has_function_privilege('service_role', 'public.ops_send_ledger_note(text,uuid,text)', 'execute')
  and has_function_privilege('service_role', 'public.ops_send_ledger_open()', 'execute')
  and not has_function_privilege('service_role', 'public.ops_kick_mailer(text)', 'execute')
  and not has_function_privilege('service_role', 'public.ops_mailer_cron_ensure()', 'execute')
  and not has_function_privilege('authenticated', 'public.ops_mailer_cron_adopt(text)', 'execute')
  and not exists (select 1 from pg_proc p where p.pronamespace = 'public'::regnamespace
                    and (p.proname like '\_ops402\_%' or p.proname like 'ops\_%' or p.proname like '\_r402\_%' or p.proname like '%\_\_pre0402')
                    and has_function_privilege('anon', p.oid, 'execute')));
select pg_temp.t('1d seven claim bodies kept once as __pre0402 (no privilege), live bodies use the 0342 try limit',
  (select count(*) from pg_proc where pronamespace = 'public'::regnamespace and proname like '%\_\_pre0402') = 7
  and (select count(*) from pg_proc where pronamespace = 'public'::regnamespace and proname like '%\_\_pre0402\_\_pre0402') = 0
  and not exists (select 1 from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname like '%\_\_pre0402'
                    and (has_function_privilege('service_role', p.oid, 'execute') or has_function_privilege('authenticated', p.oid, 'execute')))
  and (select count(*) from pg_proc p where p.pronamespace = 'public'::regnamespace and position('_r342_max_attempts()' in p.prosrc) > 0
         and p.proname in ('staff_email_claim__pre0362', 'staff_update_claim', 'task_wa_claim', 'delivery_reminder_claim',
                           'runsheet_reminder_claim__pre0283', 'vendor_bill_reminder_claim', 'cantwork_email_claim')) = 7);
select pg_temp.t('1e one backoff trigger on each of the 7 staff / reminder queues, next_attempt_at added',
  (select count(*) from pg_trigger where tgname = 'zz_r402_backoff') = 7
  and (select count(*) from pg_attribute a where a.attname = 'next_attempt_at' and not a.attisdropped
         and a.attrelid in (select ('public.' || x)::regclass from unnest(public._r402_queues()) x)) = 7);

-- ---- 2) heartbeat -----------------------------------------------------------------------------------------------------
do $$ declare h record; begin
  perform pg_temp.su(); set local role service_role;
  perform pg_temp.t('2a service role writes a heartbeat', public.ops_heartbeat_beat('comms-dispatch', 'ok', '{"sent": 3, "failed": 1, "to": "x@y.test", "Bad-Key": 4, "neg": -2}'::jsonb));
  perform pg_temp.t('2b bad name / bad status refused', not public.ops_heartbeat_beat('Comms Dispatch!', 'ok') and not public.ops_heartbeat_beat('comms-dispatch', 'great'));
  perform public.ops_heartbeat_beat('comms-dispatch', 'dormant');
  execute 'reset role';
  select * into h from public.ops_heartbeat where name = 'comms-dispatch';
  perform pg_temp.t('2c counts only: text, bad keys and negatives dropped; runs counted; last good run kept while dormant',
    h.runs = 2 and h.last_status = 'dormant' and h.last_ok_at is not null and h.detail = '{}'::jsonb
    and (select count(*) from public.ops_heartbeat) = 1, row_to_json(h)::text);
  update public.ops_heartbeat set detail = '{}' where name = 'comms-dispatch';
  set local role service_role; perform public.ops_heartbeat_beat('comms-dispatch', 'ok', '{"sent": 3, "failed": 1, "to": "x@y.test"}'::jsonb); execute 'reset role';
  perform pg_temp.t('2d numbers kept', (select detail from public.ops_heartbeat where name = 'comms-dispatch') = '{"sent": 3, "failed": 1}'::jsonb);
  set local role authenticated;
  perform pg_temp.t('2e signed-in user cannot write a heartbeat', pg_temp.try('select public.ops_heartbeat_beat(''x'', ''ok'')') like '42501%');
  execute 'reset role';
exception when others then perform pg_temp.su(); insert into _rs values ('2x', 'FAIL: ' || sqlstate || ' ' || sqlerrm); end $$;
delete from public.ops_heartbeat;

-- ---- 3) send ledger -----------------------------------------------------------------------------------------------------
do $$ declare v_id uuid; v_id2 uuid; o jsonb; begin
  perform pg_temp.su();
  insert into public.helm_notice_outbox(kind, dedupe_key) values ('hq_staff', 'r236-ledger-1') returning id into v_id;
  insert into public.helm_notice_outbox(kind, dedupe_key) values ('hq_staff', 'r236-ledger-2') returning id into v_id2;
  set local role service_role;
  perform pg_temp.t('3a a note is taken (lane + id + provider id only); a bad lane is refused',
    public.ops_send_ledger_note('helm_notice', v_id, 'smtp') and public.ops_send_ledger_note('helm_notice', v_id2, null)
    and not public.ops_send_ledger_note('nope', v_id, null) and not public.ops_send_ledger_note('helm_notice', null, null));
  o := public.ops_send_ledger_open();
  perform pg_temp.t('3b both open notes are listed', jsonb_array_length(o) = 2 and o @> jsonb_build_array(jsonb_build_object('lane', 'helm_notice', 'id', v_id)), o::text);
  execute 'reset role';
  update public.helm_notice_outbox set status = 'sent', sent_at = now() where id = v_id;
  set local role service_role;
  o := public.ops_send_ledger_open();
  execute 'reset role';
  perform pg_temp.t('3c once its row is marked the note is closed (kept, not deleted)',
    jsonb_array_length(o) = 1 and (o -> 0 ->> 'id')::uuid = v_id2
    and (select resolved_at is not null from public.ops_send_ledger where row_id = v_id) and (select count(*) from public.ops_send_ledger) = 2, o::text);
  update public.ops_send_ledger set noted_at = now() - interval '8 days' where row_id = v_id2;
  set local role service_role; o := public.ops_send_ledger_open(); execute 'reset role';
  perform pg_temp.t('3d a note older than 7 days is closed', jsonb_array_length(o) = 0 and (select count(*) from public.ops_send_ledger where resolved_at is null) = 0);
  set local role service_role; perform public.ops_send_ledger_note('helm_notice', v_id2, 'x'); execute 'reset role';
  perform pg_temp.t('3e noting again re-opens it (same row, one note)', (select count(*) from public.ops_send_ledger where row_id = v_id2 and resolved_at is null) = 1);
  set local role authenticated;
  perform pg_temp.t('3f signed-in users cannot read or write the ledger', pg_temp.try('select public.ops_send_ledger_open()') like '42501%'
    and pg_temp.try('select public.ops_send_ledger_note(''comms'', gen_random_uuid(), null)') like '42501%');
  execute 'reset role';
exception when others then perform pg_temp.su(); insert into _rs values ('3x', 'FAIL: ' || sqlstate || ' ' || sqlerrm); end $$;
delete from public.ops_send_ledger;

-- ---- 4) growing wait + 8 tries -------------------------------------------------------------------------------------------
do $$ declare v_q uuid; v_o uuid; v_id uuid; r record; begin
  perform pg_temp.su();
  select id, org_id into v_q, v_o from public.quotes where org_id = 'a0000000-0000-4000-8000-000000000001' order by created_at limit 1;
  insert into public.staff_email_outbox(org_id, quote_id, kind, recipient, dedupe_key, attempts, claimed_at)
    values (v_o, v_q, 'task_list', 'r236@studio.test', 'r236-backoff-1', 2, now()) returning id into v_id;
  -- older suites: no wait
  perform set_config('helm.retry_backoff', 'off', true);
  perform public.staff_email_mark(v_id, 'retry');
  select * into r from public.staff_email_outbox where id = v_id;
  perform pg_temp.t('4a helm.retry_backoff = off: released at once, no wait (older behaviour)', r.claimed_at is null and r.next_attempt_at is null);
  perform pg_temp.t('4b helm.retry_backoff = off: still 5 tries', public._r342_max_attempts() = 5);
  update public.staff_email_outbox set claimed_at = now() where id = v_id;
  perform set_config('helm.retry_backoff', 'on', true);
  perform public.staff_email_mark(v_id, 'retry');
  select * into r from public.staff_email_outbox where id = v_id;
  perform pg_temp.t('4c a failed send waits: next try in ~2 min, lease pushed so the claim skips it until then',
    r.next_attempt_at between now() + interval '110 seconds' and now() + interval '140 seconds'
    and r.claimed_at = r.next_attempt_at - interval '10 minutes' and r.claimed_at > now() - interval '10 minutes', row_to_json(r)::text);
  perform pg_temp.t('4d 8 tries with the wait on', public._r342_max_attempts() = 8);
  -- task_wa_outbox leases for 5 minutes
  update public.staff_email_outbox set attempts = 7, claimed_at = null, next_attempt_at = null where id = v_id;
  perform pg_temp.t('4e a row with 7 tries is not given up (was failed at 5)',
    (select status from public.staff_email_outbox where id = v_id) = 'pending');
  perform count(*) from jsonb_array_elements(coalesce(public.staff_email_claim(25), '[]'::jsonb));
  perform pg_temp.t('4f the claim leaves a 7-try row pending (8-try limit)', (select status from public.staff_email_outbox where id = v_id) = 'pending',
    (select status || '/' || coalesce(reason, '') from public.staff_email_outbox where id = v_id));
  update public.staff_email_outbox set attempts = 8, claimed_at = null where id = v_id;
  perform count(*) from jsonb_array_elements(coalesce(public.staff_email_claim(25), '[]'::jsonb));
  perform pg_temp.t('4g at 8 tries the claim marks it failed', (select status from public.staff_email_outbox where id = v_id) = 'failed',
    (select status || '/' || coalesce(reason, '') from public.staff_email_outbox where id = v_id));
  perform pg_temp.t('4h the trigger knows the 5-minute lease of task_wa_outbox',
    position('task_wa_outbox'' then interval ''5 minutes''' in (select prosrc from pg_proc where oid = 'public._r402_tg_backoff()'::regprocedure)) > 0);
  perform set_config('helm.retry_backoff', 'off', true);
exception when others then perform pg_temp.su(); perform set_config('helm.retry_backoff', 'off', true); insert into _rs values ('4x', 'FAIL: ' || sqlstate || ' ' || sqlerrm); end $$;

-- ---- 5) mailer cron jobs ---------------------------------------------------------------------------------------------------
-- fake pg_cron / Vault / pg_net (only what 0402 uses)
create schema if not exists cron;
create table cron.job (jobid bigserial primary key, jobname text, schedule text, command text, active boolean default true);
create table cron.job_run_details (runid bigserial, jobid bigint, status text, start_time timestamptz, end_time timestamptz, return_message text);
create or replace function cron.schedule(p_name text, p_schedule text, p_command text) returns bigint language sql as $$
  insert into cron.job(jobname, schedule, command) values (p_name, p_schedule, p_command) returning jobid $$;
create or replace function cron.alter_job(job_id bigint, schedule text default null, command text default null, database text default null,
  username text default null, active boolean default null) returns void language sql as $$
  update cron.job j set schedule = coalesce(alter_job.schedule, j.schedule), command = coalesce(alter_job.command, j.command),
         active = coalesce(alter_job.active, j.active) where j.jobid = alter_job.job_id $$;
create schema if not exists vault;
create table if not exists vault.secrets (id uuid primary key default gen_random_uuid(), secret text, name text, description text);
create or replace view vault.decrypted_secrets as select id, secret as decrypted_secret, name from vault.secrets;
create schema if not exists net;
create table net._fake_posts (id bigserial, url text, headers jsonb, body jsonb, timeout_ms int);
create table net._http_response (id bigint, status_code int, content_type text, headers jsonb, content text, timed_out boolean, error_msg text, created timestamptz default now());
create or replace function net.http_post(url text, body jsonb default '{}'::jsonb, params jsonb default '{}'::jsonb, headers jsonb default '{}'::jsonb,
  timeout_milliseconds int default 5000) returns bigint language sql as $$
  insert into net._fake_posts(url, headers, body, timeout_ms) values (url, headers, body, timeout_milliseconds) returning id $$;

do $$ declare n int; v text[]; r record; v_md5 text; v_a text; v_b text; begin
  perform pg_temp.su();
  perform pg_temp.t('5a no Vault secret: nothing created, the report says which secret is missing',
    cardinality(public.ops_mailer_cron_ensure()) = 0 and (select count(*) from cron.job) = 0
    and (select state from public.ops_mailer_cron_report() where job = 'helm_comms_dispatch') = 'missing_secret'
    and (select note from public.ops_mailer_cron_report() where job = 'helm_comms_dispatch') like '%helm_comms_secret%');
  insert into vault.secrets(secret, name) values ('r236-secret-value-1', 'helm_comms_secret');
  perform pg_temp.t('5b secret but no functions address: not created (missing_url)',
    cardinality(public.ops_mailer_cron_ensure()) = 0 and (select state from public.ops_mailer_cron_report() where job = 'helm_comms_dispatch') = 'missing_url');
  insert into vault.secrets(secret, name) values ('https://abcdefghijklmnopqrst.supabase.co/functions/v1/', 'helm_functions_base_url');
  -- a hand-made invite job (old dashboard style) + another job already calling pkg-client-notify
  perform cron.schedule('invite-mailer', '*/3 * * * *', $c$select net.http_post(url := 'https://abcdefghijklmnopqrst.supabase.co/functions/v1/invite-mailer', headers := jsonb_build_object('x-helm-cron-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'helm_invite_email_secret')))$c$);
  perform cron.schedule('my_pkg_job', '*/2 * * * *', $c$select net.http_post(url := 'https://abcdefghijklmnopqrst.supabase.co/functions/v1/pkg-client-notify')$c$);
  insert into vault.secrets(secret, name) values ('r236-secret-pkg', 'helm_pkg_notify_secret'), ('r236-secret-invite', 'helm_invite_email_secret');
  select md5(string_agg(jobname || schedule || command || active, '|' order by jobid)) into v_md5 from cron.job where jobname in ('invite-mailer', 'my_pkg_job');
  v := public.ops_mailer_cron_ensure();
  perform pg_temp.t('5c with the secret + address: only helm_comms_dispatch created, with the code command and schedule',
    v = array['helm_comms_dispatch'] and (select count(*) from cron.job where jobname = 'helm_comms_dispatch') = 1
    and (select command from cron.job where jobname = 'helm_comms_dispatch') = 'select public.ops_kick_mailer(''comms-dispatch'')'
    and (select schedule from cron.job where jobname = 'helm_comms_dispatch') = '*/5 * * * *', array_to_string(v, ','));
  perform pg_temp.t('5d the hand-made job and the other-name job are untouched; nothing else added',
    (select md5(string_agg(jobname || schedule || command || active, '|' order by jobid)) from cron.job where jobname in ('invite-mailer', 'my_pkg_job')) = v_md5
    and (select count(*) from cron.job) = 3
    and (select state from public.ops_mailer_cron_report() where job = 'invite-mailer') = 'owner_version'
    and (select state from public.ops_mailer_cron_report() where job = 'helm_pkg_notify') = 'other_name'
    and (select state from public.ops_mailer_cron_report() where job = 'helm_comms_dispatch') = 'code');
  perform pg_temp.t('5e second ensure creates nothing (idempotent)', cardinality(public.ops_mailer_cron_ensure()) = 0 and (select count(*) from cron.job) = 3);
  perform pg_temp.t('5f the report never shows a command or a secret value',
    not exists (select 1 from information_schema.routines rt join information_schema.parameters pa on pa.specific_name = rt.specific_name
                 where rt.routine_schema = 'public' and rt.routine_name = 'ops_mailer_cron_report' and pa.parameter_name = 'command')
    and (select string_agg(row_to_json(x)::text, '') from public.ops_mailer_cron_report() x) not like '%r236-secret%'
    and (select string_agg(row_to_json(x)::text, '') from public.ops_mailer_cron_report() x) not like '%net.http_post%');
  perform public.ops_kick_mailer('comms-dispatch');
  select * into r from net._fake_posts order by id desc limit 1;
  perform pg_temp.t('5g the kick posts to <base>/comms-dispatch with the Vault secret in the header, 30 s wait',
    r.url = 'https://abcdefghijklmnopqrst.supabase.co/functions/v1/comms-dispatch' and r.headers ->> 'x-helm-cron-secret' = 'r236-secret-value-1'
    and r.timeout_ms = 30000, row_to_json(r)::text);
  perform pg_temp.t('5h a kick without its secret FAILS (the cron run shows failed, not a quiet success)',
    pg_temp.try('select public.ops_kick_mailer(''security-alert-mailer'')') like '55000%helm_security_alert_secret%'
    and pg_temp.try('select public.ops_kick_mailer(''evil'')') like '22023%');
  v_a := public.ops_mailer_cron_adopt('invite-mailer');
  v_b := public.ops_mailer_cron_adopt('helm_security_alerts');
  perform pg_temp.t('5i adopt switches the hand-made job only when asked, schedule kept',
    v_a like 'switched%'
    and (select command from cron.job where jobname = 'invite-mailer') = 'select public.ops_kick_mailer(''invite-mailer'')'
    and (select schedule from cron.job where jobname = 'invite-mailer') = '*/3 * * * *'
    and (select state from public.ops_mailer_cron_report() where job = 'invite-mailer') = 'code_other_schedule'
    and v_b like 'nothing to switch%', v_a || ' / ' || v_b);
  delete from vault.secrets where name = 'helm_functions_base_url';
  insert into vault.secrets(secret, name) values ('https://abcdefghijklmnopqrst.supabase.co/functions/v1/wa-template-worker', 'helm_wa_worker_url');
  perform pg_temp.t('5j the address can come from the existing helm_wa_worker_url', public._ops402_base_url() = 'https://abcdefghijklmnopqrst.supabase.co/functions/v1');
  update vault.secrets set secret = 'https://evil.example.com/functions/v1/wa-template-worker' where name = 'helm_wa_worker_url';
  perform pg_temp.t('5k a non-Supabase address is refused', public._ops402_base_url() is null);
exception when others then perform pg_temp.su(); insert into _rs values ('5x', 'FAIL: ' || sqlstate || ' ' || sqlerrm); end $$;
create temp table _jobs_before as select md5(string_agg(jobname || schedule || command || active, '|' order by jobid)) m from cron.job;
set client_min_messages = error;
\ir ../../supabase/migrations/0402_r236_ops_health.sql
set client_min_messages = warning;
select pg_temp.t('5l re-applying 0402 with jobs present changes no job',
  (select md5(string_agg(jobname || schedule || command || active, '|' order by jobid)) from cron.job) = (select m from _jobs_before));

-- ---- 6) ops_health ---------------------------------------------------------------------------------------------------------
do $$ declare h jsonb; v_id uuid; v_j bigint; begin
  perform pg_temp.staff('r236_owner@hqstaff.test', 'owner');
  perform pg_temp.staff('r236_viewer@hqstaff.test', 'viewer');
  update public.helm_hq_settings set hq_idle_minutes = 30, hq_max_hours = 12, hq_reauth_minutes = 15, hq_ip_allowlist_on = false where id;
  perform pg_temp.su();
  perform auth.login_anon();
  perform pg_temp.t('6a anon refused', pg_temp.try('select public.ops_health()') like '42501%' and pg_temp.try('select public.hq_ops_health()') like '42501%');
  perform pg_temp.su();
  perform auth.login_as((select id from public.profiles where org_id = 'a0000000-0000-4000-8000-000000000001' and role = 'admin' order by id limit 1));
  perform pg_temp.t('6b a studio admin (not HQ) is refused', pg_temp.try('select public.ops_health()') not like 'ok%' and pg_temp.try('select public.hq_ops_health()') not like 'ok%');
  perform pg_temp.su();
  -- data: an old waiting Helm notice, a failed staff e-mail, jobs, call answers, heartbeat
  delete from public.helm_notice_outbox where status = 'pending';
  insert into public.helm_notice_outbox(kind, dedupe_key, created_at) values ('hq_staff', 'r236-old-1', now() - interval '2 hours') returning id into v_id;
  update public.staff_email_outbox set status = 'failed', sent_at = now() where dedupe_key = 'r236-backoff-1';
  delete from cron.job;
  insert into cron.job(jobname, schedule, command, active) values ('helm_comms_tick', '*/15 * * * *', 'select public.comms_tick()', true) returning jobid into v_j;
  insert into cron.job_run_details(jobid, status, start_time) values (v_j, 'succeeded', now() - interval '3 minutes');
  insert into cron.job(jobname, schedule, command, active) values ('helm_inbox_tick', '*/5 * * * *', 'select 1', true) returning jobid into v_j;
  insert into cron.job_run_details(jobid, status, start_time) values (v_j, 'succeeded', now() - interval '40 minutes'), (v_j, 'failed', now() - interval '2 minutes');
  insert into cron.job(jobname, schedule, command, active) values ('helm_comms_dispatch', '*/5 * * * *', 'select public.ops_kick_mailer(''comms-dispatch'')', false);
  insert into net._http_response(id, status_code, content, created) values (1, 200, '{"status":"ok","sent":1}', now()), (2, 401, '{"error":"unauthorized"}', now()),
    (3, 200, '{"status":"dormant"}', now() - interval '10 minutes'), (4, 500, 'x', now() - interval '3 hours');
  perform set_config('request.jwt.claims', '', false);
  set local role service_role; perform public.ops_heartbeat_beat('comms-dispatch', 'dormant'); execute 'reset role';
  perform pg_temp.hq('r236_owner@hqstaff.test');
  h := public.ops_health();
  perform pg_temp.su();
  perform pg_temp.t('6c HQ owner reads it: 18 queues, checks, overall', jsonb_array_length(h -> 'queues') = 18 and h ->> 'overall' = 'red'
    and (select count(*) from jsonb_array_elements(h -> 'checks')) = 6, left(h::text, 400));
  perform pg_temp.t('6d a Helm notice waiting 2 hours = red queue', pg_temp.q(h, 'helm_notice_outbox') ->> 'level' = 'red'
    and (pg_temp.q(h, 'helm_notice_outbox') ->> 'waiting')::int = 1 and pg_temp.lvl(h, 'queues') = 'red', (pg_temp.q(h, 'helm_notice_outbox'))::text);
  perform pg_temp.t('6e a failed staff e-mail in 24 h = amber queue', pg_temp.q(h, 'staff_email_outbox') ->> 'level' = 'amber'
    and (pg_temp.q(h, 'staff_email_outbox') ->> 'failed_24h')::int = 1, (pg_temp.q(h, 'staff_email_outbox'))::text);
  perform pg_temp.t('6f jobs: on time = green, no good run in 2 x 5 min = red, paused dispatcher = red, a missing required job = red',
    pg_temp.job(h, 'helm_comms_tick') ->> 'level' = 'green' and pg_temp.job(h, 'helm_inbox_tick') ->> 'level' = 'red'
    and pg_temp.job(h, 'helm_comms_dispatch') ->> 'level' = 'red' and pg_temp.job(h, 'helm_comms_dispatch') ->> 'why' = 'paused'
    and pg_temp.job(h, 'helm-task-reminders') ->> 'why' = 'missing' and pg_temp.job(h, 'helm_welcome_mailer') is null
    and pg_temp.lvl(h, 'jobs') = 'red', (h -> 'jobs')::text);
  perform pg_temp.t('6g a 401 answer in the last hour = red calls (older answers ignored); a dormant answer = amber switched off',
    pg_temp.lvl(h, 'calls') = 'red' and (h #>> '{http,refused_1h}')::int = 1 and h #>> '{http,refused_by_status,401}' = '1'
    and pg_temp.lvl(h, 'switched_off') = 'amber' and (h #>> '{http,dormant_1h}')::int = 1, (h -> 'http')::text);
  perform pg_temp.t('6h heartbeat says switched off = red dispatcher', pg_temp.lvl(h, 'dispatcher') = 'red' and h #>> '{dispatcher,last_status}' = 'dormant');
  -- all good
  delete from net._http_response; update public.helm_notice_outbox set status = 'sent', sent_at = now() where id = v_id;
  update public.staff_email_outbox set status = 'sent' where dedupe_key = 'r236-backoff-1';
  delete from public.helm_notice_outbox where status = 'pending';
  delete from cron.job where jobname not in ('helm_comms_tick');
  insert into cron.job(jobname, schedule, command, active)
    select e.job, '*/5 * * * *', 'select 1', true from public._ops402_expected_jobs() e where e.required and e.job <> 'helm_comms_tick';
  insert into cron.job_run_details(jobid, status, start_time) select j.jobid, 'succeeded', now() - interval '1 minute' from cron.job j;
  set local role service_role; perform public.ops_heartbeat_beat('comms-dispatch', 'ok', '{"sent": 2}'::jsonb); execute 'reset role';
  perform pg_temp.hq('r236_viewer@hqstaff.test');
  h := public.hq_ops_health();
  perform pg_temp.su();
  perform pg_temp.t('6i HQ viewer (Overview) reads it; everything fine = green overall',
    h ->> 'overall' = 'green' and pg_temp.lvl(h, 'dispatcher') = 'green' and pg_temp.lvl(h, 'jobs') = 'green' and pg_temp.lvl(h, 'calls') = 'green',
    (h -> 'checks')::text);
  update public.ops_heartbeat set last_run_at = now() - interval '20 minutes';
  perform pg_temp.t('6j a heartbeat older than 15 minutes = red dispatcher', public._ops402_health() #>> '{dispatcher,level}' = 'red');
exception when others then perform pg_temp.su(); insert into _rs values ('6x', 'FAIL: ' || sqlstate || ' ' || sqlerrm); end $$;
do $$ declare a text; b text; begin
  perform pg_temp.su();
  select md5(coalesce((select string_agg(row_to_json(x)::text, '' order by x.name) from public.ops_heartbeat x), '') ||
             coalesce((select string_agg(row_to_json(y)::text, '' order by y.row_id) from public.ops_send_ledger y), '') ||
             (select count(*)::text from cron.job) || (select count(*)::text from public.helm_notice_outbox)) into a;
  perform public._ops402_health(); perform public._ops402_health();
  select md5(coalesce((select string_agg(row_to_json(x)::text, '' order by x.name) from public.ops_heartbeat x), '') ||
             coalesce((select string_agg(row_to_json(y)::text, '' order by y.row_id) from public.ops_send_ledger y), '') ||
             (select count(*)::text from cron.job) || (select count(*)::text from public.helm_notice_outbox)) into b;
  perform pg_temp.t('6l reading the health changes nothing', a = b);
  perform pg_temp.t('6m cron intervals: * = 1 min, */5 = 5 min, hourly, every 3 h, daily, unknown = null',
    public._ops402_every('* * * * *') = interval '1 minute' and public._ops402_every('*/5 * * * *') = interval '5 minutes'
    and public._ops402_every('7 * * * *') = interval '1 hour' and public._ops402_every('17 */3 * * *') = interval '3 hours'
    and public._ops402_every('23 2 * * *') = interval '1 day' and public._ops402_every('30 seconds') = interval '30 seconds'
    and public._ops402_every('0 9 1 * *') is null);
exception when others then perform pg_temp.su(); insert into _rs values ('6y', 'FAIL: ' || sqlstate || ' ' || sqlerrm); end $$;

-- ---- 7) re-run safety ------------------------------------------------------------------------------------------------------
select pg_temp.t('7a re-run safe: one trigger per queue, kept bodies not wrapped twice, one heartbeat table',
  (select count(*) from pg_trigger where tgname = 'zz_r402_backoff') = 7
  and (select count(*) from pg_proc where pronamespace = 'public'::regnamespace and proname like '%\_\_pre0402\_\_pre0402') = 0
  and (select count(*) from pg_proc where pronamespace = 'public'::regnamespace and proname like '%\_\_pre0402') = 7);

select name, result from _rs order by name;
select case when count(*) filter (where result <> 'PASS') = 0 then 'R236-OPS-HEALTH-0402: ALL PASS (' || count(*) || '/' || count(*) || ')'
            else 'R236-OPS-HEALTH-0402: ' || count(*) filter (where result <> 'PASS') || ' FAILED of ' || count(*) end as summary from _rs;
rollback;
