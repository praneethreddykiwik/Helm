-- r242-p5-jobs-0409-0412.sql -- R242 fix plan Phase 5: cron stagger (0409), package-code wake + ledger lanes (0410),
-- Helm-wide render cap (0411), HQ switches + schema version (0412).
-- Proves: (1) structure - only render_cap_status / helm_schema_version / hq_switches for signed-in users, nothing for anon,
-- every new function definer (or a plain sql helper) with an empty search_path, new tables row security on + no app access;
-- (2) stagger - only jobs that are EXACTLY what the migration made are moved (schedule only, command / active kept);
-- hand-changed schedule / command, owner jobs and mailer jobs untouched; the new schedules keep the interval; second apply
-- moves nothing; undo puts them back; the report never shows a command; no pg_cron = nothing;
-- (3) wake - a package code insert never fails (no pg_net, missing secret), posts to pkg-client-notify once (20 s throttle),
-- other kinds / switch off / test switch = no call; (4) ledger lanes - the 5 new lanes are accepted, listed and closed when
-- the row is marked, old lanes still work, a bad lane is refused, the 0410 CHECK replaced the 0402 one;
-- (5) render cap - kill switch, studio day cap, Helm day / month / cost caps refuse with a plain message + hint, errors and old
-- rows do not count, the test switch skips, one HQ bell row a day at 80 %, render_cap_status signed-in only;
-- (6) switches - anon / studio admin refused, HQ owner reads every group, a Vault secret VALUE and an env text value never
-- appear, secrets shown as set / not set by name; (7) schema version - signed-out refused, recent numbers found, a new
-- marker row raises the version. Re-applies 0409-0412 twice. Local disposable PG only. Fake data only. Rolled back.
\set ON_ERROR_STOP 0
set client_min_messages = error;
\ir ../../supabase/migrations/0409_r242_cron_stagger.sql
\ir ../../supabase/migrations/0410_r242_mailer_wake_ledger.sql
\ir ../../supabase/migrations/0411_r242_render_cap.sql
\ir ../../supabase/migrations/0412_r242_switches_schema.sql
\ir ../../supabase/migrations/0409_r242_cron_stagger.sql
\ir ../../supabase/migrations/0410_r242_mailer_wake_ledger.sql
\ir ../../supabase/migrations/0411_r242_render_cap.sql
\ir ../../supabase/migrations/0412_r242_switches_schema.sql
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
  insert into public.platform_admins(email, added_by, role) values (p_email, 'r242 test', p_role) on conflict (email) do nothing;
  update public.platform_admins set role = p_role, status = 'active', require_mfa = false,
         user_id = (select id from auth.users where email = p_email) where email = p_email;
end $$;
create or replace function pg_temp.try(p_sql text) returns text language plpgsql as $$
declare v_hint text; begin execute p_sql; return 'ok'; exception when others then get stacked diagnostics v_hint = pg_exception_hint;
  return sqlstate || ' [' || coalesce(v_hint, '') || '] ' || sqlerrm; end $$;
grant execute on function pg_temp.try(text) to anon, authenticated, service_role;
\set A '''a0000000-0000-4000-8000-000000000001'''

-- ---- 1) structure -----------------------------------------------------------------------------------------------------
select pg_temp.t('1a new tables: row security on, no anon / signed-in privilege',
  (select bool_and(relrowsecurity) from pg_class where oid in ('public.helm_ops_settings'::regclass, 'public.ops_mailer_wake'::regclass,
     'public.helm_render_cap'::regclass, 'public.helm_schema_markers'::regclass))
  and not exists (select 1 from unnest(array['helm_ops_settings', 'ops_mailer_wake', 'helm_render_cap', 'helm_schema_markers']) t, unnest(array['anon', 'authenticated']) r
                   where has_table_privilege(r, 'public.' || t, 'select') or has_table_privilege(r, 'public.' || t, 'update')));
select pg_temp.t('1b every new function: empty search_path; definer except the immutable sql helpers',
  (select bool_and(coalesce(array_to_string(p.proconfig, ','), '') like '%search_path=""%') from pg_proc p
    where p.pronamespace = 'public'::regnamespace and (p.proname like '\_r409\_%' or p.proname like '\_r410\_%' or p.proname like '\_r411\_%'
      or p.proname like '\_r412\_%' or p.proname in ('ops_cron_stagger_report', 'ops_cron_stagger_apply', 'ops_cron_stagger_undo', 'render_cap_status',
      'helm_schema_version', 'hq_switches')))
  and (select bool_and(p.prosecdef) from pg_proc p where p.pronamespace = 'public'::regnamespace
        and p.proname in ('ops_cron_stagger_report', 'ops_cron_stagger_apply', 'ops_cron_stagger_undo', 'render_cap_status', 'helm_schema_version',
                          'hq_switches', '_r410_wake', '_r410_tg_pkg_wake', '_r411_tg_render_cap', '_r412_switches', '_r412_secret_set')));
select pg_temp.t('1c signed-in: render_cap_status, helm_schema_version, hq_switches only; anon nothing; service role nothing new',
  has_function_privilege('authenticated', 'public.render_cap_status()', 'execute') and has_function_privilege('authenticated', 'public.helm_schema_version()', 'execute')
  and has_function_privilege('authenticated', 'public.hq_switches()', 'execute')
  and not exists (select 1 from pg_proc p where p.pronamespace = 'public'::regnamespace
        and (p.proname like '\_r409\_%' or p.proname like '\_r410\_%' or p.proname like '\_r411\_%' or p.proname like '\_r412\_%'
             or p.proname in ('ops_cron_stagger_report', 'ops_cron_stagger_apply', 'ops_cron_stagger_undo', 'render_cap_status', 'helm_schema_version', 'hq_switches'))
        and (has_function_privilege('anon', p.oid, 'execute') or has_function_privilege('service_role', p.oid, 'execute')
             or (p.proname not in ('render_cap_status', 'helm_schema_version', 'hq_switches') and has_function_privilege('authenticated', p.oid, 'execute')))));
select pg_temp.t('1d one wake trigger on pkg_outbox, one cap trigger on photo_render_usage, ledger CHECK 0410 replaced 0402',
  (select count(*) from pg_trigger where tgname = 'zz_r410_pkg_wake' and tgrelid = 'public.pkg_outbox'::regclass) = 1
  and (select count(*) from pg_trigger where tgname = 'zz_r411_render_cap' and tgrelid = 'public.photo_render_usage'::regclass) = 1
  and exists (select 1 from pg_constraint where conname = 'ops_send_ledger_lane_chk410' and convalidated)
  and not exists (select 1 from pg_constraint where conname = 'ops_send_ledger_lane_chk402'));
select pg_temp.t('1e no pg_cron here: the report says so and apply / undo move nothing',
  (select state from public.ops_cron_stagger_report() limit 1) = 'no_pg_cron'
  and cardinality(public.ops_cron_stagger_apply()) = 0 and cardinality(public.ops_cron_stagger_undo()) = 0);

-- ---- 2) cron stagger (fake pg_cron) ------------------------------------------------------------------------------------
create schema if not exists cron;
create table cron.job (jobid bigserial primary key, jobname text, schedule text, command text, active boolean default true, username text default 'postgres');
create or replace function cron.alter_job(job_id bigint, schedule text default null, command text default null, database text default null,
  username text default null, active boolean default null) returns void language sql as $$
  update cron.job j set schedule = coalesce(alter_job.schedule, j.schedule), command = coalesce(alter_job.command, j.command),
         active = coalesce(alter_job.active, j.active) where j.jobid = alter_job.job_id $$;
-- every job exactly as its migration made it ...
insert into cron.job(jobname, schedule, command) select x.job, x.old_schedule, x.cmd from public._r409_plan() x;
-- ... except: one schedule changed by hand, one command changed by hand (with a secret-looking text), one paused
update cron.job set schedule = '*/10 * * * *' where jobname = 'helm_link_views_tick';
update cron.job set command = 'select net.http_post(url := ''https://x.test/f'', headers := ''{"x-helm-cron-secret": "SECRETCMD999"}''::jsonb)' where jobname = 'helm_vendor_requests';
update cron.job set active = false where jobname = 'helm_comms_tick';
insert into cron.job(jobname, schedule, command) values ('my_own_job', '*/5 * * * *', 'select 42'),
  ('helm_comms_dispatch', '*/5 * * * *', 'select 1 /* hand-made */'), ('helm-task-reminders', '* * * * *', 'select public.task_reminder_tick()');
create temp table _before as select jobid, jobname, schedule, command, active from cron.job;
do $$ declare v text[]; v2 text[]; begin
  v := public.ops_cron_stagger_apply();
  perform pg_temp.t('2a apply moves exactly the 10 untouched migration jobs (paused one included, stays paused)',
    cardinality(v) = 10 and not ('helm_link_views_tick' = any(v)) and not ('helm_vendor_requests' = any(v)) and 'helm_comms_tick' = any(v), array_to_string(v, ','));
  perform pg_temp.t('2b moved jobs: new schedule, command and active flag unchanged',
    not exists (select 1 from cron.job j join _before b using (jobid) join public._r409_plan() p on p.job = j.jobname
                 where j.jobname = any(v) and (j.schedule <> p.new_schedule or j.command <> b.command or j.active <> b.active))
    and (select active from cron.job where jobname = 'helm_comms_tick') = false);
  perform pg_temp.t('2c hand-changed, owner and mailer jobs untouched',
    not exists (select 1 from cron.job j join _before b using (jobid) where not (j.jobname = any(v))
                 and (j.schedule, j.command, j.active) is distinct from (b.schedule, b.command, b.active)));
  perform pg_temp.t('2d report: staggered / kept_owner / owner_job / mailer / known - never a command',
    (select count(*) from public.ops_cron_stagger_report() where state = 'staggered') = 10
    and (select state from public.ops_cron_stagger_report() where job = 'helm_link_views_tick') = 'kept_owner'
    and (select state from public.ops_cron_stagger_report() where job = 'helm_vendor_requests') = 'kept_owner'
    and (select state from public.ops_cron_stagger_report() where job = 'my_own_job') = 'owner_job'
    and (select state from public.ops_cron_stagger_report() where job = 'helm_comms_dispatch') = 'mailer'
    and (select state from public.ops_cron_stagger_report() where job = 'helm-task-reminders') = 'known'
    and (select string_agg(r::text, '|') from public.ops_cron_stagger_report() r) not like '%SECRETCMD999%'
    and (select string_agg(r::text, '|') from public.ops_cron_stagger_report() r) not like '%select 42%');
  v2 := public.ops_cron_stagger_apply();
  perform pg_temp.t('2e second apply moves nothing (idempotent)', cardinality(v2) = 0);
  perform pg_temp.t('2f the new schedules keep each interval and no longer start at minute 0',
    not exists (select 1 from public._r409_plan() p where public._ops402_every(p.new_schedule) is distinct from public._ops402_every(p.old_schedule)
                   or split_part(p.new_schedule, ' ', 1) ~ '(^|,)0(,|$)'));
  perform pg_temp.t('2g at minute :00 only the every-minute job (and hand-made ones) of the known list still start',
    not exists (select 1 from cron.job j where j.jobname = any(v) and split_part(j.schedule, ' ', 1) ~ '(^|,)(0|30)(,|$)'));
  v2 := public.ops_cron_stagger_undo();
  perform pg_temp.t('2h undo puts the 10 back on their old schedule (nothing else touched)', cardinality(v2) = 10
    and not exists (select 1 from cron.job j join _before b using (jobid) where (j.schedule, j.command, j.active) is distinct from (b.schedule, b.command, b.active)));
  perform public.ops_cron_stagger_apply();
exception when others then perform pg_temp.su(); insert into _rs values ('2x', 'FAIL: ' || sqlstate || ' ' || sqlerrm); end $$;
-- re-applying 0409 with jobs present: no change
create temp table _after as select md5(string_agg(jobname || schedule || command || active, '|' order by jobid)) m from cron.job;
set client_min_messages = error;
\ir ../../supabase/migrations/0409_r242_cron_stagger.sql
set client_min_messages = warning;
select pg_temp.t('2i re-applying 0409 changes no job', (select md5(string_agg(jobname || schedule || command || active, '|' order by jobid)) from cron.job) = (select m from _after));

-- ---- 3) package code wake (fake pg_net / Vault) ------------------------------------------------------------------------
do $$ declare v_q uuid; r text; begin
  perform pg_temp.su();
  select id into v_q from public.quotes where org_id = 'a0000000-0000-4000-8000-000000000001' order by id limit 1;
  r := pg_temp.try(format('insert into public.pkg_outbox(org_id, quote_id, audience, channel, kind, recipient, dedupe_key) values (%L, %L, ''client'', ''email'', ''pkg_otp'', ''c@x.test'', ''r242-w0'')',
      'a0000000-0000-4000-8000-000000000001', v_q));
  perform pg_temp.t('3a no pg_net here: a package code insert still works (nothing woken)', r = 'ok' and not exists (select 1 from public.ops_mailer_wake), r);
end $$;
create schema if not exists vault;
create table if not exists vault.secrets (id uuid primary key default gen_random_uuid(), secret text, name text, description text);
create or replace view vault.decrypted_secrets as select id, secret as decrypted_secret, name from vault.secrets;
create schema if not exists net;
create table net._fake_posts (id bigserial, url text, headers jsonb, body jsonb, timeout_ms int);
create table net._http_response (id bigint, status_code int, content_type text, headers jsonb, content text, timed_out boolean, error_msg text, created timestamptz default now());
create or replace function net.http_post(url text, body jsonb default '{}'::jsonb, params jsonb default '{}'::jsonb, headers jsonb default '{}'::jsonb,
  timeout_milliseconds int default 5000) returns bigint language sql as $$
  insert into net._fake_posts(url, headers, body, timeout_ms) values (url, headers, body, timeout_milliseconds) returning id $$;
do $$ declare v_q uuid; r text; r2 text; v_ins text := 'insert into public.pkg_outbox(org_id, quote_id, audience, channel, kind, recipient, dedupe_key) values (%L, %L, ''client'', ''email'', %L, ''c@x.test'', %L)'; begin
  perform pg_temp.su();
  select id into v_q from public.quotes where org_id = 'a0000000-0000-4000-8000-000000000001' order by id limit 1;
  -- pg_net but no Vault secret yet: the insert works, the wake is skipped and counted
  r := pg_temp.try(format(v_ins, 'a0000000-0000-4000-8000-000000000001', v_q, 'pkg_otp', 'r242-w1'));
  perform pg_temp.t('3b missing secret: insert works, nothing posted, the skip is counted (SQLSTATE only)',
    r = 'ok'
    and (select count(*) from net._fake_posts) = 0 and (select skipped from public.ops_mailer_wake where fn = 'pkg-client-notify') = 1
    and (select last_skip from public.ops_mailer_wake where fn = 'pkg-client-notify') = '55000');
  insert into vault.secrets(name, secret) values ('helm_pkg_notify_secret', 'pkg-secret-value-r242'), ('helm_functions_base_url', 'https://abcdefghijklmnopqrst.supabase.co/functions/v1');
  update public.ops_mailer_wake set last_kick_at = now() - interval '1 minute';
  r := pg_temp.try(format(v_ins, 'a0000000-0000-4000-8000-000000000001', v_q, 'pkg_otp', 'r242-w2'));
  perform pg_temp.t('3c a package code wakes pkg-client-notify once (Vault secret in the header, the functions address)',
    r = 'ok'
    and (select count(*) from net._fake_posts) = 1
    and (select url from net._fake_posts order by id desc limit 1) = 'https://abcdefghijklmnopqrst.supabase.co/functions/v1/pkg-client-notify'
    and (select headers ->> 'x-helm-cron-secret' from net._fake_posts order by id desc limit 1) = 'pkg-secret-value-r242');
  r := pg_temp.try(format(v_ins, 'a0000000-0000-4000-8000-000000000001', v_q, 'pkg_otp', 'r242-w3'));
  r2 := pg_temp.try(format(v_ins, 'a0000000-0000-4000-8000-000000000001', v_q, 'pkg_accepted', 'r242-w4'));
  perform pg_temp.t('3d a second code within 20 s: no second call (throttle); another kind: no call',
    r = 'ok' and r2 = 'ok'
    and (select count(*) from net._fake_posts) = 1);
  update public.ops_mailer_wake set last_kick_at = now() - interval '1 minute';
  update public.helm_ops_settings set pkg_wake = false where id;
  r := pg_temp.try(format(v_ins, 'a0000000-0000-4000-8000-000000000001', v_q, 'pkg_otp', 'r242-w5'));
  perform pg_temp.t('3e owner switch off: no call', r = 'ok'
    and (select count(*) from net._fake_posts) = 1);
  update public.helm_ops_settings set pkg_wake = true where id;
  perform set_config('helm.mailer_wake', 'off', true);
  r := pg_temp.try(format(v_ins, 'a0000000-0000-4000-8000-000000000001', v_q, 'pkg_otp', 'r242-w6'));
  perform pg_temp.t('3f test switch helm.mailer_wake = off: no call', r = 'ok'
    and (select count(*) from net._fake_posts) = 1);
  perform set_config('helm.mailer_wake', '', true);
  perform pg_temp.t('3g the wake changes no outbox row (status / attempts untouched)',
    not exists (select 1 from public.pkg_outbox where dedupe_key like 'r242-w%' and (status <> 'pending' or attempts <> 0 or claimed_at is not null)));
exception when others then perform pg_temp.su(); insert into _rs values ('3x', 'FAIL: ' || sqlstate || ' ' || sqlerrm); end $$;

-- ---- 4) ledger lanes ---------------------------------------------------------------------------------------------------
do $$ declare v_p uuid; v_h uuid; v_b uuid; o jsonb; begin
  perform pg_temp.su();
  select id into v_p from public.pkg_outbox where dedupe_key = 'r242-w2';
  insert into public.helm_notice_outbox(kind, dedupe_key) values ('hq_staff', 'r242-ledger-h') returning id into v_h;
  insert into public.billing_reminders(org_id, kind, period_end) values ('a0000000-0000-4000-8000-000000000001', 'due_soon', current_date + 3) returning id into v_b;
  set local role service_role;
  perform pg_temp.t('4a new lanes pkg / billing / welcome / invite / security accepted; old lane still; bad lane refused',
    public.ops_send_ledger_note('pkg', v_p, 'smtp') and public.ops_send_ledger_note('billing', v_b, null)
    and public.ops_send_ledger_note('helm_notice', v_h, null) and public.ops_send_ledger_note('welcome', gen_random_uuid(), null)
    and public.ops_send_ledger_note('invite', gen_random_uuid(), null) and public.ops_send_ledger_note('security', gen_random_uuid(), null)
    and not public.ops_send_ledger_note('nope', v_p, null));
  o := public.ops_send_ledger_open();
  execute 'reset role';
  perform pg_temp.t('4b open notes list the pkg + billing rows; rows that do not exist are closed (never deleted)',
    o @> jsonb_build_array(jsonb_build_object('lane', 'pkg', 'id', v_p)) and o @> jsonb_build_array(jsonb_build_object('lane', 'billing', 'id', v_b))
    and not (o::text like '%"welcome"%') and (select count(*) from public.ops_send_ledger) = 6, o::text);
  update public.pkg_outbox set sent_at = now(), status = 'sent' where id = v_p;
  update public.billing_reminders set sent_at = now(), channel = 'email' where id = v_b;
  set local role service_role; o := public.ops_send_ledger_open(); execute 'reset role';
  perform pg_temp.t('4c marked rows are closed on the next look', not (o::text like '%' || v_p::text || '%') and not (o::text like '%' || v_b::text || '%')
    and (select resolved_at is not null from public.ops_send_ledger where lane = 'pkg' and row_id = v_p), o::text);
exception when others then perform pg_temp.su(); insert into _rs values ('4x', 'FAIL: ' || sqlstate || ' ' || sqlerrm); end $$;

-- ---- 5) render cap -----------------------------------------------------------------------------------------------------
do $$ declare v_q uuid; v_b uuid; v_ins text; r text; begin
  perform pg_temp.su();
  select id into v_q from public.quotes where org_id = 'a0000000-0000-4000-8000-000000000001' order by id limit 1;
  select id into v_b from public.quotes where org_id <> 'a0000000-0000-4000-8000-000000000001' order by id limit 1;
  delete from public.photo_render_usage;
  v_ins := 'insert into public.photo_render_usage(org_id, quote_id, model, size, quality, n, status, cost_usd) values (%L, %L, ''gpt-image'', ''1536x1024'', ''medium'', %s, ''pending'', %s)';
  update public.helm_render_cap set renders_on = true, studio_daily_images = 5, helm_daily_images = 8, helm_monthly_images = 12, helm_monthly_usd = 2.00, warn_pct = 80, paused_message = null where id;
  perform pg_temp.t('5a under every limit: a render may start', pg_temp.try(format(v_ins, 'a0000000-0000-4000-8000-000000000001', v_q, 4, 0.28)) = 'ok');
  r := pg_temp.try(format(v_ins, 'a0000000-0000-4000-8000-000000000001', v_q, 2, 0.14));
  perform pg_temp.t('5b the studio day cap: refused with a plain message + hint render_day_cap', r like 'P0001 [render_day_cap] Your studio has made its 5 photo renders for today%', r);
  -- another studio: Helm-wide day cap (4 used + 4 more = 8 ok; then 1 more over)
  perform pg_temp.t('5c another studio fills the Helm-wide day', pg_temp.try(format(v_ins, (select org_id from public.quotes where id = v_b), v_b, 4, 0.28)) = 'ok');
  r := pg_temp.try(format(v_ins, (select org_id from public.quotes where id = v_b), v_b, 1, 0.07));
  perform pg_temp.t('5d Helm-wide day cap: refused, hint render_helm_cap, says tomorrow', r like 'P0001 [render_helm_cap] Helm''s photo renders are paused for today%', r);
  update public.photo_render_usage set status = 'error';
  perform pg_temp.t('5e failed renders do not count', pg_temp.try(format(v_ins, 'a0000000-0000-4000-8000-000000000001', v_q, 4, 0.28)) = 'ok');
  update public.photo_render_usage set created_at = date_trunc('month', now()) - interval '1 day' where status = 'error';
  -- month: 12 pictures; make 9 ok last days of this month (not today)
  update public.photo_render_usage set status = 'ok', created_at = date_trunc('month', now()) where status = 'pending';
  update public.helm_render_cap set helm_daily_images = 100, studio_daily_images = 100 where id;
  insert into public.photo_render_usage(org_id, quote_id, model, size, quality, n, status, cost_usd, created_at)
    select 'a0000000-0000-4000-8000-000000000001', v_q, 'gpt-image', '1536x1024', 'medium', 4, 'ok', 0.28, date_trunc('month', now()) from generate_series(1, 2);
  r := pg_temp.try(format(v_ins, 'a0000000-0000-4000-8000-000000000001', v_q, 1, 0.07));
  perform pg_temp.t('5f Helm-wide month cap (12 used): refused until next month', r like 'P0001 [render_helm_cap] Helm''s photo renders are paused until next month%', r);
  update public.helm_render_cap set helm_monthly_images = 1000, helm_monthly_usd = 0.90 where id;
  r := pg_temp.try(format(v_ins, 'a0000000-0000-4000-8000-000000000001', v_q, 1, 0.07));
  perform pg_temp.t('5g estimated cost cap (0.84 + 0.07 > 0.90): refused', r like 'P0001 [render_helm_cap]%', r);
  update public.helm_render_cap set helm_monthly_usd = null where id;
  delete from public.hq_security_notices where alert_type = 'render_cap';
  update public.helm_render_cap set helm_monthly_images = 15 where id;
  r := pg_temp.try(format(v_ins, 'a0000000-0000-4000-8000-000000000001', v_q, 1, 0.07)) || pg_temp.try(format(v_ins, 'a0000000-0000-4000-8000-000000000001', v_q, 1, 0.07));
  perform pg_temp.t('5h no cost limit (null) + 80 % of the month: allowed, ONE HQ bell row for today',
    r = 'okok'
    and (select count(*) from public.hq_security_notices where alert_type = 'render_cap') = 1
    and (select count from public.hq_security_notices where alert_type = 'render_cap') = 2
    and public._sa54_label('render_cap') = 'Photo render limit',
    r || (select count(*) || ' rows, count ' || coalesce(max(count), 0) || ', label ' || public._sa54_label('render_cap') || ', ' || public._r411_state(null)::text from public.hq_security_notices where alert_type = 'render_cap'));
  update public.helm_render_cap set renders_on = false, paused_message = 'Renders are paused for maintenance today.' where id;
  r := pg_temp.try(format(v_ins, 'a0000000-0000-4000-8000-000000000001', v_q, 1, 0.07));
  perform pg_temp.t('5i kill switch: every render refused with the owner''s message, hint render_helm_off', r like 'P0001 [render_helm_off] Renders are paused for maintenance today.%', r);
  perform set_config('helm.render_cap', 'off', true);
  perform pg_temp.t('5j test switch helm.render_cap = off skips the check', pg_temp.try(format(v_ins, 'a0000000-0000-4000-8000-000000000001', v_q, 1, 0.07)) = 'ok');
  perform set_config('helm.render_cap', '', true);
  perform pg_temp.t('5k a finished render can still be marked ok / error (update never checked)',
    pg_temp.try('update public.photo_render_usage set status = ''ok'' where status = ''pending''') = 'ok');
  update public.helm_render_cap set renders_on = true, studio_daily_images = 40, helm_daily_images = 300, helm_monthly_images = 3000, helm_monthly_usd = 600, paused_message = null where id;
  perform auth.login_anon();
  perform pg_temp.t('5l render_cap_status: anon refused', pg_temp.try('select public.render_cap_status()') like '42501%');
  perform pg_temp.su();
  perform auth.login_as((select id from public.profiles where org_id = 'a0000000-0000-4000-8000-000000000001' and role = 'admin' order by id limit 1));
  perform pg_temp.t('5m render_cap_status: studio staff get numbers + flags only (no other studio, no cost)',
    (public.render_cap_status() ->> 'renders_on')::boolean and (public.render_cap_status() ? 'studio_day_used')
    and not (public.render_cap_status() ? 'helm_month_usd') and (public.render_cap_status() ->> 'ai_label')::boolean, public.render_cap_status()::text);
  perform pg_temp.su();
  perform pg_temp.t('5n new pictures are marked ai_generated by default', (select column_default from information_schema.columns
    where table_schema = 'public' and table_name = 'photo_renders' and column_name = 'ai_generated') = 'true');
exception when others then perform pg_temp.su(); insert into _rs values ('5x', 'FAIL: ' || sqlstate || ' ' || sqlerrm); end $$;

-- ---- 6) HQ switches ----------------------------------------------------------------------------------------------------
do $$ declare h jsonb; begin
  perform pg_temp.staff('r242_owner@hqstaff.test', 'owner');
  update public.helm_hq_settings set hq_idle_minutes = 30, hq_max_hours = 12, hq_reauth_minutes = 15, hq_ip_allowlist_on = false where id;
  insert into vault.secrets(name, secret) values ('helm_comms_secret', 'TOPSECRET-comms-r242-value');
  insert into public.helm_env_settings(key, value) values ('r242_flag', 'true'::jsonb), ('r242_text', '"some-private-token-r242"'::jsonb) on conflict (key) do nothing;
  perform pg_temp.su(); perform auth.login_anon();
  perform pg_temp.t('6a anon refused', pg_temp.try('select public.hq_switches()') like '42501%');
  perform pg_temp.su();
  perform auth.login_as((select id from public.profiles where org_id = 'a0000000-0000-4000-8000-000000000001' and role = 'admin' order by id limit 1));
  perform pg_temp.t('6b a studio admin (not HQ) is refused', pg_temp.try('select public.hq_switches()') not like 'ok%');
  perform pg_temp.hq('r242_owner@hqstaff.test');
  h := public.hq_switches();
  perform pg_temp.su();
  perform pg_temp.t('6c HQ owner reads every group', (select array_agg(g ->> 'key' order by g ->> 'key') from jsonb_array_elements(h -> 'groups') g)
    = array['jobs', 'messages', 'renders', 'schema', 'security', 'trial', 'vault'], left(h::text, 300));
  perform pg_temp.t('6d a Vault secret VALUE and an env text value never appear; secrets as set / not set by name',
    h::text not like '%TOPSECRET%' and h::text not like '%some-private-token%' and h::text not like '%pkg-secret-value%'
    and h::text like '%"key": "vault_helm_comms_secret"%' and h::text like '%"value": "set"%' and h::text like '%"value": "not set"%');
  perform pg_temp.t('6e env switches: true / false / numbers shown, text only as "set"',
    exists (select 1 from jsonb_array_elements(h -> 'groups') g, jsonb_array_elements(g -> 'items') i where i ->> 'key' = 'env_r242_flag' and i -> 'value' = 'true'::jsonb)
    and exists (select 1 from jsonb_array_elements(h -> 'groups') g, jsonb_array_elements(g -> 'items') i where i ->> 'key' = 'env_r242_text' and i ->> 'value' = 'set'));
  perform pg_temp.t('6f trial purge shown off (expected off), render switch on, jobs report the stagger states, never a cron command',
    exists (select 1 from jsonb_array_elements(h -> 'groups') g, jsonb_array_elements(g -> 'items') i where i ->> 'key' = 'trial_purge' and i ->> 'state' = 'off' and i ->> 'differs' = 'false')
    and exists (select 1 from jsonb_array_elements(h -> 'groups') g, jsonb_array_elements(g -> 'items') i where i ->> 'key' = 'renders_on' and i ->> 'state' = 'on')
    and exists (select 1 from jsonb_array_elements(h -> 'groups') g, jsonb_array_elements(g -> 'items') i where i ->> 'key' = 'cron_staggered' and (i ->> 'value')::int = 10)
    and h::text not like '%SECRETCMD999%' and h::text not like '%select 42%');
  perform pg_temp.t('6g reading changes nothing (stable, no row written)', (select provolatile from pg_proc where oid = 'public.hq_switches()'::regprocedure) = 's'
    and (select provolatile from pg_proc where oid = 'public._r412_switches()'::regprocedure) = 's');
exception when others then perform pg_temp.su(); insert into _rs values ('6x', 'FAIL: ' || sqlstate || ' ' || sqlerrm); end $$;

-- ---- 7) schema version -------------------------------------------------------------------------------------------------
do $$ declare v jsonb; begin
  perform pg_temp.su(); perform auth.login_anon();
  perform pg_temp.t('7a signed-out refused', pg_temp.try('select public.helm_schema_version()') like '42501%');
  perform pg_temp.su();
  perform auth.login_as((select id from public.profiles where org_id = 'a0000000-0000-4000-8000-000000000001' and role = 'admin' order by id limit 1));
  v := public.helm_schema_version();
  perform pg_temp.t('7b signed-in: version 412 + recent numbers found (numbers only)', (v ->> 'version')::int >= 412   -- R246: later migrations (0423+) add their own marker rows
    and v -> 'applied' @> '[402, 403, 409, 410, 411, 412]'::jsonb and v ->> 'marker' = 'r242-0412'
    and not exists (select 1 from jsonb_array_elements(v -> 'applied') x where jsonb_typeof(x) <> 'number'), v::text);
  perform pg_temp.su();
  insert into public.helm_schema_markers(num, name) values (9990, 'r9990_future_update');   -- R246: above every real migration number
  perform auth.login_as((select id from public.profiles where org_id = 'a0000000-0000-4000-8000-000000000001' and role = 'admin' order by id limit 1));
  perform pg_temp.t('7c a later migration''s marker row raises the version', (public.helm_schema_version() ->> 'version')::int = 9990);
  perform pg_temp.su();
exception when others then perform pg_temp.su(); insert into _rs values ('7x', 'FAIL: ' || sqlstate || ' ' || sqlerrm); end $$;

select name, result from _rs order by name;
select case when count(*) filter (where result <> 'PASS') = 0 then 'R242-P5-JOBS-0409-0412: ALL PASS (' || count(*) || '/' || count(*) || ')'
            else 'R242-P5-JOBS-0409-0412: ' || count(*) filter (where result <> 'PASS') || ' FAILED of ' || count(*) end as summary from _rs;
rollback;
