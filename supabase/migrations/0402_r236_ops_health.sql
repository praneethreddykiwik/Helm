-- 0402_r236_ops_health.sql - CANONICAL forward-only. R236 (reliability review 19 Nov 2026, PART-C JOB-01/02/03/04, MSG-01).
-- REQUIRES 0342 (_r342_max_attempts / _r342_backoff), 0277 + 0332 (_hq27_require / _hq27_read_perm, the HQ gate).
-- Every queue table is optional: a database without one simply has nothing to show / change for it.
--
-- In plain words:
--   1  E-mail sender schedules in code (JOB-02). The 6 pg_cron jobs that call the mailers (helm_comms_dispatch,
--      invite-mailer, helm_security_alerts, helm_pkg_notify, helm_billing_reminder, helm_welcome_mailer) were made by hand
--      in the dashboard. They are now described here (same names, same schedules). A job that ALREADY EXISTS is never
--      changed - whatever its command is (the owner's own version is kept and reported). A missing job is created only
--      when its Vault secret (by NAME, e.g. helm_comms_secret) and the functions address (Vault helm_functions_base_url,
--      or the existing helm_wa_worker_url) are there; otherwise it is not created and the check says why. The command of
--      a job made here is `select public.ops_kick_mailer('<function>')`: it reads the secret from Vault by name at every
--      run (no secret value is ever written in a job or in this file) and FAILS the cron run (visible in the job history)
--      when the secret or the address is missing, instead of quietly doing nothing.
--      ops_mailer_cron_report() shows, per mailer, what is live vs this code (never the command text).
--      ops_mailer_cron_adopt('<job>') (owner only, by hand) switches an existing job to the code command - never automatic.
--   2  ops_health() (JOB-01): one read-only answer for the HQ System health card, HQ staff with Overview access only:
--      each scheduled job vs its schedule (stale = no good run in 2 x its interval, missing, paused, failing), the pg_net
--      answers of the last hour (non-2xx = red: wrong secret 401, function missing 404, 5xx), senders that answered
--      "switched off" (dormant), the comms-dispatch heartbeat (last run, switched off, no e-mail provider), every queue
--      (18) with waiting / oldest waiting / failed 24 h / sent 24 h, and a red / amber / green verdict for each and overall.
--      comms-dispatch writes its heartbeat with ops_heartbeat_beat (service role only, one row upserted per run).
--   3  No double send (JOB-03). When a message went out but its "mark as sent" failed (after retries in the edge
--      function), the dispatcher notes it in ops_send_ledger (lane + row id + provider id, never an address or text).
--      On the next claim of that row the dispatcher marks it sent WITHOUT sending it again. ops_send_ledger_open() lists
--      the open notes and closes the ones whose row is already marked (a note is closed, never deleted).
--   4  Growing wait for the staff + reminder queues (JOB-04): staff_email_outbox, staff_update_outbox, task_wa_outbox,
--      delivery_reminder_sends, runsheet_reminder_sends, vendor_bill_mail_outbox, cantwork_email_outbox get the 0342
--      retry wait (1 2 4 8 16 30 60 minutes, next_attempt_at column) and give up after 8 tries instead of 5 (each claim's
--      own age rule - 2 hours for time-critical reminders - still skips anything too old, so nothing is ever sent late).
--
-- ZERO DATA LOSS: additive + idempotent. Three new tables (ops_heartbeat, ops_send_ledger + no data), new functions, one
-- new column next_attempt_at on 7 queue tables, one new trigger per those tables (sets the retry wait only), 7 claim
-- bodies re-issued with the 8-try limit (old bodies kept as <name>__pre0402, no app privilege). Cron jobs are only ever
-- ADDED when missing - never altered, never unscheduled. Nothing dropped, nothing deleted. Safe to run twice. ASCII only.
-- Test switch: helm.retry_backoff = off (older suites) keeps the 5-try limit and no wait, exactly like 0342.
-- Undo (manual, if ever needed): drop trigger zz_r402_backoff on each of the 7 tables (retries go back to every tick);
--   select cron.unschedule('<job>') only for a job this file created (ops_mailer_cron_report says state = code).

do $$
begin
  if to_regprocedure('public._r342_max_attempts(text)') is null or to_regprocedure('public._r342_backoff(integer)') is null then
    raise exception 'STOP 0402: _r342_max_attempts / _r342_backoff missing - run 0342 first'; end if;
  if to_regprocedure('public._hq27_require(text,boolean)') is null or to_regprocedure('public._hq27_read_perm(text)') is null then
    raise exception 'STOP 0402: _hq27_require / _hq27_read_perm missing - run 0277 first'; end if;
end $$;

-- ===========================================================================================================================
-- 1) heartbeat: one row per background sender, written by the sender itself (service role, through the function only)
-- ===========================================================================================================================
create table if not exists public.ops_heartbeat (
  name        text primary key,
  last_run_at timestamptz not null default now(),
  last_status text not null,
  last_ok_at  timestamptz,
  runs        bigint not null default 0,
  detail      jsonb not null default '{}'::jsonb,
  updated_at  timestamptz not null default now(),
  constraint ops_heartbeat_name_chk402 check (name ~ '^[a-z0-9_-]{1,40}$'),
  constraint ops_heartbeat_status_chk402 check (last_status in ('ok', 'dormant', 'no_provider', 'error')),
  constraint ops_heartbeat_detail_chk402 check (jsonb_typeof(detail) = 'object' and length(detail::text) <= 2000)
);
comment on table public.ops_heartbeat is
  'r236-0402: last run of each background sender (comms-dispatch): status ok / dormant (switched off) / no_provider / error + counts. Written only by ops_heartbeat_beat (service role).';
alter table public.ops_heartbeat enable row level security;

create or replace function public.ops_heartbeat_beat(p_name text, p_status text, p_detail jsonb default '{}'::jsonb)
returns boolean language plpgsql volatile security definer set search_path = '' as $$
-- r236-0402: counts only (keys a-z_, numbers 0..10^9, at most 12) - never an address, a name or message text
declare v jsonb := '{}'::jsonb; k text; x jsonb; n integer := 0;
begin
  if coalesce(p_name, '') !~ '^[a-z0-9_-]{1,40}$' or coalesce(p_status, '') not in ('ok', 'dormant', 'no_provider', 'error') then return false; end if;
  if jsonb_typeof(p_detail) = 'object' then
    for k, x in select e.key, e.value from jsonb_each(p_detail) e order by e.key loop
      exit when n >= 12;
      continue when k !~ '^[a-z_]{1,20}$' or jsonb_typeof(x) <> 'number' or (x::text)::numeric < 0 or (x::text)::numeric > 1000000000;
      v := v || jsonb_build_object(k, floor((x::text)::numeric)::bigint); n := n + 1;
    end loop;
  end if;
  insert into public.ops_heartbeat as h (name, last_run_at, last_status, last_ok_at, runs, detail, updated_at)
    values (p_name, now(), p_status, case when p_status = 'ok' then now() end, 1, v, now())
  on conflict (name) do update set last_run_at = now(), last_status = excluded.last_status,
         last_ok_at = case when excluded.last_status = 'ok' then now() else h.last_ok_at end,
         runs = h.runs + 1, detail = excluded.detail, updated_at = now();
  return true;
end $$;

-- ===========================================================================================================================
-- 2) send ledger: "this message went out but could not be marked" - so the next claim marks it without sending again
-- ===========================================================================================================================
create table if not exists public.ops_send_ledger (
  lane         text not null,
  row_id       uuid not null,
  provider_ref text,
  noted_at     timestamptz not null default now(),
  resolved_at  timestamptz,
  constraint ops_send_ledger_pk402 primary key (lane, row_id),
  constraint ops_send_ledger_lane_chk402 check (lane in ('comms', 'trial_reminder', 'trial_retention', 'assign', 'task_wa', 'delivery',
    'vendor_request', 'vendor_bill', 'runsheet', 'staff_email', 'staff_update', 'cantwork', 'enquiry', 'helm_notice')),
  constraint ops_send_ledger_ref_chk402 check (provider_ref is null or provider_ref ~ '^[A-Za-z0-9_.:=+/-]{1,160}$')
);
comment on table public.ops_send_ledger is
  'r236-0402: messages the provider accepted whose "mark as sent" failed. The dispatcher marks them sent on the next claim without sending again. Notes are closed (resolved_at), never deleted. No address / text.';
alter table public.ops_send_ledger enable row level security;
create index if not exists ops_send_ledger_open_idx402 on public.ops_send_ledger (noted_at) where resolved_at is null;

-- lane -> its queue table + "sent" column (fixed list; the only place a lane name becomes a table name)
create or replace function public._ops402_lane(p_lane text)
returns text[] language sql immutable set search_path = '' as $$
  select case p_lane
    when 'comms' then array['comms_outbox', 'sent_at']
    when 'trial_reminder' then array['trial_reminders', 'email_sent_at']
    when 'trial_retention' then array['trial_retention_notices', 'email_sent_at']
    when 'assign' then array['assign_notify_outbox', 'sent_at']
    when 'task_wa' then array['task_wa_outbox', 'sent_at']
    when 'delivery' then array['delivery_reminder_sends', 'sent_at']
    when 'vendor_request' then array['vendor_request_sends', 'sent_at']
    when 'vendor_bill' then array['vendor_bill_mail_outbox', 'sent_at']
    when 'runsheet' then array['runsheet_reminder_sends', 'sent_at']
    when 'staff_email' then array['staff_email_outbox', 'sent_at']
    when 'staff_update' then array['staff_update_outbox', 'sent_at']
    when 'cantwork' then array['cantwork_email_outbox', 'sent_at']
    when 'enquiry' then array['lead_enquiries', 'sent_at']
    when 'helm_notice' then array['helm_notice_outbox', 'sent_at']
  end;
$$;

create or replace function public.ops_send_ledger_note(p_lane text, p_id uuid, p_ref text default null)
returns boolean language plpgsql volatile security definer set search_path = '' as $$
-- r236-0402: the provider accepted row p_id of lane p_lane, but marking it failed
begin
  if public._ops402_lane(p_lane) is null or p_id is null then return false; end if;
  insert into public.ops_send_ledger as l (lane, row_id, provider_ref, noted_at, resolved_at)
    values (p_lane, p_id, case when p_ref ~ '^[A-Za-z0-9_.:=+/-]{1,160}$' then p_ref end, now(), null)
  on conflict (lane, row_id) do update set noted_at = now(), resolved_at = null,
         provider_ref = coalesce(excluded.provider_ref, l.provider_ref);
  return true;
end $$;

create or replace function public.ops_send_ledger_open()
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
-- r236-0402: open notes as [{lane, id}] (at most 500). Notes whose row is marked by now, whose row is gone, or older than
-- 7 days (every lane's own age rule has ended it by then) are closed first - closed, never deleted.
declare r record; c text[]; v_gone boolean; v_out jsonb;
begin
  for r in select l.lane, l.row_id, l.noted_at from public.ops_send_ledger l where l.resolved_at is null order by l.noted_at limit 2000 loop
    c := public._ops402_lane(r.lane);
    v_gone := true;
    if c is not null and to_regclass('public.' || c[1]) is not null and r.noted_at >= now() - interval '7 days' then
      begin
        execute format('select not exists (select 1 from public.%I t where t.id = $1 and t.%I is null)', c[1], c[2]) into v_gone using r.row_id;
      exception when others then v_gone := false;
      end;
    end if;
    if v_gone then update public.ops_send_ledger set resolved_at = now() where lane = r.lane and row_id = r.row_id and resolved_at is null; end if;
  end loop;
  select coalesce(jsonb_agg(jsonb_build_object('lane', x.lane, 'id', x.row_id) order by x.noted_at), '[]'::jsonb) into v_out
    from (select l.lane, l.row_id, l.noted_at from public.ops_send_ledger l where l.resolved_at is null order by l.noted_at limit 500) x;
  return v_out;
end $$;

-- ===========================================================================================================================
-- 3) growing wait + 8 tries for the 7 staff / reminder queues (JOB-04) - the 0342 rule, with each queue's own lease
-- ===========================================================================================================================
create or replace function public._r402_queues()
returns text[] language sql immutable set search_path = '' as $$
  select array['staff_email_outbox', 'staff_update_outbox', 'task_wa_outbox', 'delivery_reminder_sends', 'runsheet_reminder_sends',
               'vendor_bill_mail_outbox', 'cantwork_email_outbox'];
$$;

do $$ declare t text; begin
  foreach t in array public._r402_queues() loop
    if to_regclass('public.' || t) is not null then
      execute format('alter table public.%I add column if not exists next_attempt_at timestamptz', t);
      execute format('comment on column public.%I.next_attempt_at is %L', t,
        'r236-0402: after a failed send the earliest next try (backoff 1 2 4 8 16 30 60 min). Null = not waiting.');
    end if;
  end loop;
end $$;

create or replace function public._r402_tg_backoff()
returns trigger language plpgsql security definer set search_path = '' as $$
-- r236-0402: the 0342 retry wait for the staff / reminder queues. A failed send is released by its *_mark('retry')
-- (claimed_at -> null); this pushes the lease so the claim hands the row out again only after the wait.
-- task_wa_outbox leases rows for 5 minutes, the others for 10.
declare v_lease interval; v_next timestamptz; v_nb timestamptz;
begin
  if coalesce(current_setting('helm.retry_backoff', true), '') = 'off' then return NEW; end if;
  begin
    if coalesce(NEW.attempts, 0) = 0 or NEW.attempts < coalesce(OLD.attempts, 0) then
      NEW.next_attempt_at := null; return NEW;
    end if;
    if OLD.claimed_at is null or NEW.claimed_at is not null or NEW.sent_at is not null then return NEW; end if;
    v_lease := case when TG_TABLE_NAME = 'task_wa_outbox' then interval '5 minutes' else interval '10 minutes' end;
    v_next := now() + public._r342_backoff(NEW.attempts);
    if coalesce(current_setting('helm.send_window', true), '') <> 'off'
       and to_regprocedure('public._sw290_not_before(text,jsonb,timestamptz)') is not null then
      v_nb := public._sw290_not_before(TG_TABLE_NAME, to_jsonb(NEW), v_next);
      if v_nb is not null and v_nb > v_next then v_next := v_nb; end if;
    end if;
    NEW.next_attempt_at := v_next;
    NEW.claimed_at := v_next - v_lease;
  exception when others then
    raise warning 'r236-0402: retry wait not applied (%)', sqlstate;
  end;
  return NEW;
end $$;

do $$ declare t text; begin
  foreach t in array public._r402_queues() loop
    continue when to_regclass('public.' || t) is null;
    continue when not exists (select 1 from pg_attribute a where a.attrelid = ('public.' || t)::regclass and a.attname = 'attempts' and not a.attisdropped)
               or not exists (select 1 from pg_attribute a where a.attrelid = ('public.' || t)::regclass and a.attname = 'claimed_at' and not a.attisdropped)
               or not exists (select 1 from pg_attribute a where a.attrelid = ('public.' || t)::regclass and a.attname = 'sent_at' and not a.attisdropped);
    execute format('create or replace trigger zz_r402_backoff before update of claimed_at on public.%I for each row execute function public._r402_tg_backoff()', t);
  end loop;
end $$;

-- keep a body once as <name>__pre0402 (no app privilege)
create or replace function public._r402_keep(p_fn text)
returns void language plpgsql volatile security definer set search_path = '' as $$
declare v_oid oid := to_regprocedure(p_fn); v_name text; v_types text; v_def text; v_pre text; r text;
begin
  if v_oid is null then return; end if;
  select p.proname, oidvectortypes(p.proargtypes) into v_name, v_types from pg_proc p where p.oid = v_oid;
  v_pre := format('public.%I(%s)', v_name || '__pre0402', v_types);
  if to_regprocedure(v_pre) is null then
    v_def := pg_get_functiondef(v_oid);
    v_def := regexp_replace(v_def, '^CREATE OR REPLACE FUNCTION public\.' || v_name || '\(',
                            'CREATE OR REPLACE FUNCTION public.' || v_name || '__pre0402(');
    if position(v_name || '__pre0402(' in v_def) = 0 then raise exception 'r236-0402: could not keep %', p_fn; end if;
    execute v_def;
  end if;
  execute format('revoke all on function %s from public', v_pre);
  foreach r in array array['anon', 'authenticated', 'service_role'] loop
    if exists (select 1 from pg_roles where rolname = r) then execute format('revoke all on function %s from %I', v_pre, r); end if;
  end loop;
end $$;

-- the 8-try limit: each claim body's single "attempts >= 5" becomes the 0342 limit (8; 5 while helm.retry_backoff = off)
do $do$ declare f text; v_oid oid; v_def text; v_n integer;
begin
  foreach f in array array['public.staff_email_claim__pre0362(integer)', 'public.staff_update_claim(integer)', 'public.task_wa_claim(integer)',
                           'public.delivery_reminder_claim(integer)', 'public.runsheet_reminder_claim__pre0283(integer)',
                           'public.vendor_bill_reminder_claim(integer)', 'public.cantwork_email_claim(integer)'] loop
    v_oid := to_regprocedure(f);
    if v_oid is null then raise notice '0402: % not on this database - left unchanged', f; continue; end if;
    v_def := pg_get_functiondef(v_oid);
    if position('_r342_max_attempts' in v_def) > 0 then continue; end if;
    v_n := (length(v_def) - length(replace(v_def, 'attempts >= 5', ''))) / length('attempts >= 5');
    if v_n <> 1 then raise notice '0402: % has an unexpected body - left unchanged (gives up after 5 tries)', f; continue; end if;
    perform public._r402_keep(f);
    execute replace(v_def, 'attempts >= 5', 'attempts >= public._r342_max_attempts()');
  end loop;
end $do$;

-- ===========================================================================================================================
-- 4) the mailer cron jobs, described in code (JOB-02)
-- ===========================================================================================================================
create or replace function public._ops402_mailers()
returns table(job text, fn text, schedule text, vault_secret text, timeout_ms integer, why text)
language sql immutable set search_path = '' as $$
  select * from (values
    ('helm_comms_dispatch', 'comms-dispatch', '*/5 * * * *', 'helm_comms_secret', 30000, 'every client / staff / Helm e-mail and WhatsApp'),
    ('invite-mailer', 'invite-mailer', '*/2 * * * *', 'helm_invite_email_secret', 15000, 'invitation e-mails'),
    ('helm_security_alerts', 'security-alert-mailer', '*/5 * * * *', 'helm_security_alert_secret', 15000, 'security alert e-mails'),
    ('helm_pkg_notify', 'pkg-client-notify', '*/2 * * * *', 'helm_pkg_notify_secret', 15000, 'package client codes (expire in 10 min)'),
    ('helm_billing_reminder', 'billing-reminder', '15 * * * *', 'helm_billing_cron_secret', 15000, 'billing reminders (dormant until switched on)'),
    ('helm_welcome_mailer', 'welcome-mailer', '*/10 * * * *', 'helm_welcome_email_secret', 15000, 'optional: comms-dispatch already sends welcomes')
  ) v(job, fn, schedule, vault_secret, timeout_ms, why);
$$;

create or replace function public._ops402_cmd(p_fn text)
returns text language sql immutable set search_path = '' as $$
  select 'select public.ops_kick_mailer(' || quote_literal(p_fn) || ')';
$$;

create or replace function public._ops402_norm(p text)
returns text language sql immutable set search_path = '' as $$
  select lower(btrim(regexp_replace(regexp_replace(coalesce(p, ''), '\s+', ' ', 'g'), ';\s*$', '')));
$$;

-- the edge functions address from Vault (helm_functions_base_url, else derived from helm_wa_worker_url), or null
create or replace function public._ops402_base_url()
returns text language plpgsql stable security definer set search_path = '' as $$
declare v text;
begin
  if to_regclass('vault.decrypted_secrets') is null then return null; end if;
  execute 'select btrim(decrypted_secret) from vault.decrypted_secrets where name = $1 limit 1' into v using 'helm_functions_base_url';
  v := regexp_replace(coalesce(v, ''), '/+$', '');
  if v ~ '^https://[a-z0-9-]+\.supabase\.co/functions/v1$' then return v; end if;
  execute 'select btrim(decrypted_secret) from vault.decrypted_secrets where name = $1 limit 1' into v using 'helm_wa_worker_url';
  v := coalesce(v, '');
  if v ~ '^https://[a-z0-9-]+\.supabase\.co/functions/v1/wa-template-worker$' then return regexp_replace(v, '/wa-template-worker$', ''); end if;
  return null;
exception when others then return null;
end $$;

-- the command of a mailer job made by this file: one call with the Vault secret, or a FAILED cron run when not set up
create or replace function public.ops_kick_mailer(p_fn text)
returns bigint language plpgsql volatile security definer set search_path = '' as $$
-- r236-0402
declare m record; v_secret text; v_base text; v_id bigint;
begin
  select * into m from public._ops402_mailers() x where x.fn = p_fn;
  if m.fn is null then raise exception 'ops_kick_mailer: unknown function' using errcode = '22023'; end if;
  if to_regnamespace('net') is null or to_regclass('vault.decrypted_secrets') is null then
    raise exception 'ops_kick_mailer: pg_net / Vault not available' using errcode = '55000'; end if;
  execute 'select decrypted_secret from vault.decrypted_secrets where name = $1 limit 1' into v_secret using m.vault_secret;
  if coalesce(v_secret, '') = '' then raise exception 'ops_kick_mailer: Vault secret % is missing', m.vault_secret using errcode = '55000'; end if;
  v_base := public._ops402_base_url();
  if v_base is null then raise exception 'ops_kick_mailer: Vault secret helm_functions_base_url is missing or not a functions address' using errcode = '55000'; end if;
  execute 'select net.http_post(url := $1, body := $2, headers := $3, timeout_milliseconds := $4)' into v_id
    using v_base || '/' || m.fn, '{}'::jsonb, jsonb_build_object('Content-Type', 'application/json', 'x-helm-cron-secret', v_secret), m.timeout_ms;
  return v_id;
end $$;

-- per mailer: what is live vs this code. Never returns a command (a hand-made one can carry a secret).
-- state: code (the job runs the code command) | code_other_schedule | owner_version (a hand-made job with this name - kept)
--        | other_name (another job already calls this function - kept, nothing added) | can_create | missing_secret
--        | missing_url | no_pg_cron | no_pg_net | no_vault
create or replace function public.ops_mailer_cron_report()
returns table(job text, fn text, code_schedule text, live_schedule text, live_active boolean, state text,
              secret_from_vault boolean, note text)
language plpgsql stable security definer set search_path = '' as $$
-- r236-0402
declare m record; j record; v_cron boolean; v_other text; v_has_secret boolean; v_base text;
begin
  v_cron := to_regclass('cron.job') is not null and to_regprocedure('cron.schedule(text,text,text)') is not null;
  v_base := public._ops402_base_url();
  for m in select * from public._ops402_mailers() loop
    job := m.job; fn := m.fn; code_schedule := m.schedule; live_schedule := null; live_active := null; secret_from_vault := null; note := m.why;
    if not v_cron then state := 'no_pg_cron'; return next; continue; end if;

    execute 'select jobid, schedule, active, command from cron.job where jobname = $1 order by jobid limit 1' into j using m.job;
    if j.jobid is not null then
      live_schedule := j.schedule; live_active := j.active;
      secret_from_vault := public._ops402_norm(j.command) = public._ops402_norm(public._ops402_cmd(m.fn))
                           or position('vault.decrypted_secrets' in coalesce(j.command, '')) > 0;
      if public._ops402_norm(j.command) = public._ops402_norm(public._ops402_cmd(m.fn)) then
        state := case when j.schedule = m.schedule then 'code' else 'code_other_schedule' end;
      else
        state := 'owner_version';
        note := case when position('/functions/v1/' || m.fn in coalesce(j.command, '')) = 0
                     then 'kept as it is; it does not call ' || m.fn || ' - check it'
                     else 'kept as it is (hand-made); switch with ops_mailer_cron_adopt if you want the code version' end;
      end if;
      return next; continue;
    end if;
    v_other := null;
    execute 'select string_agg(jobname, '', '' order by jobname) from cron.job where position($1 in command) > 0 or position($2 in command) > 0'
      into v_other using '/functions/v1/' || m.fn, 'ops_kick_mailer(' || quote_literal(m.fn) || ')';
    if v_other is not null then state := 'other_name'; note := 'already called by job ' || v_other || ' - nothing added'; return next; continue; end if;
    if to_regnamespace('net') is null then state := 'no_pg_net'; return next; continue; end if;
    if to_regclass('vault.decrypted_secrets') is null then state := 'no_vault'; return next; continue; end if;
    execute 'select exists (select 1 from vault.decrypted_secrets where name = $1 and coalesce(decrypted_secret, '''') <> '''')' into v_has_secret using m.vault_secret;
    if not v_has_secret then state := 'missing_secret'; note := 'not created: add the Vault secret ' || m.vault_secret || ' (same value as the edge secret), then run APPLY-0402 again'; return next; continue; end if;
    if v_base is null then state := 'missing_url'; note := 'not created: add the Vault secret helm_functions_base_url = https://<ref>.supabase.co/functions/v1, then run APPLY-0402 again'; return next; continue; end if;
    state := 'can_create'; return next;
  end loop;
end $$;

-- create the missing mailer jobs that can be created (never touches an existing job); returns what was created
create or replace function public.ops_mailer_cron_ensure()
returns text[] language plpgsql volatile security definer set search_path = '' as $$
-- r236-0402
declare r record; v_made text[] := array[]::text[];
begin
  for r in select x.job, x.fn, x.code_schedule from public.ops_mailer_cron_report() x where x.state = 'can_create' loop
    execute 'select cron.schedule($1, $2, $3)' using r.job, r.code_schedule, public._ops402_cmd(r.fn);
    v_made := v_made || r.job;
  end loop;
  return v_made;
end $$;

-- OWNER ONLY, by hand: switch an existing (hand-made) mailer job to the code command. Never called by this file.
create or replace function public.ops_mailer_cron_adopt(p_job text)
returns text language plpgsql volatile security definer set search_path = '' as $$
-- r236-0402
declare r record; v_id bigint; v_ok boolean;
begin
  select * into r from public.ops_mailer_cron_report() x where x.job = p_job;
  if r.job is null then return 'unknown job'; end if;
  if r.state in ('code', 'code_other_schedule') then return 'already the code version'; end if;
  if r.state <> 'owner_version' then return 'nothing to switch (state ' || r.state || ')'; end if;
  if public._ops402_base_url() is null then return 'add the Vault secret helm_functions_base_url first'; end if;
  execute 'select exists (select 1 from vault.decrypted_secrets d join public._ops402_mailers() m on m.vault_secret = d.name where m.job = $1 and coalesce(d.decrypted_secret, '''') <> '''')'
    into v_ok using p_job;
  if not coalesce(v_ok, false) then return 'add the Vault secret for this job first (see ops_mailer_cron_report)'; end if;
  execute 'select jobid from cron.job where jobname = $1 order by jobid limit 1' into v_id using p_job;
  execute 'select cron.alter_job(job_id := $1, command := $2)' using v_id, public._ops402_cmd((select m.fn from public._ops402_mailers() m where m.job = p_job));
  return 'switched to the code version (schedule and active unchanged)';
end $$;

do $$ declare v text[]; r record; begin
  if to_regclass('cron.job') is null or to_regprocedure('cron.schedule(text,text,text)') is null then
    raise notice '0402: pg_cron is not enabled here - no mailer job checked or created';
    return;
  end if;
  v := public.ops_mailer_cron_ensure();
  if cardinality(v) > 0 then raise notice '0402: mailer jobs created: %', array_to_string(v, ', '); end if;
  for r in select x.job, x.state from public.ops_mailer_cron_report() x where x.state not in ('code', 'owner_version') loop
    raise notice '0402: mailer job % : %', r.job, r.state;
  end loop;
end $$;

-- ===========================================================================================================================
-- 5) ops_health(): the HQ System health answer (JOB-01)
-- ===========================================================================================================================
-- how often a cron schedule runs (the patterns Helm uses), or null when not simple
create or replace function public._ops402_every(p_schedule text)
returns interval language plpgsql immutable set search_path = '' as $$
declare s text := btrim(coalesce(p_schedule, '')); m text[];
begin
  if s ~ '^[0-9]{1,2} seconds?$' then return make_interval(secs => split_part(s, ' ', 1)::int); end if;
  if s = '* * * * *' then return interval '1 minute'; end if;
  m := regexp_match(s, '^\*/([0-9]{1,2}) \* \* \* \*$'); if m is not null then return make_interval(mins => m[1]::int); end if;
  if s ~ '^[0-9]{1,2}(,[0-9]{1,2})* \* \* \* \*$' then return interval '1 hour' / (array_length(string_to_array(split_part(s, ' ', 1), ','), 1)); end if;
  m := regexp_match(s, '^[0-9]{1,2} \*/([0-9]{1,2}) \* \* \*$'); if m is not null then return make_interval(hours => m[1]::int); end if;
  if s ~ '^[0-9]{1,2} [0-9]{1,2} \* \* \*$' then return interval '1 day'; end if;
  if s ~ '^[0-9]{1,2} [0-9]{1,2} \* \* [0-9]$' then return interval '7 days'; end if;
  return null;
exception when others then return null;
end $$;

-- the jobs this code expects (required = red when missing)
create or replace function public._ops402_expected_jobs()
returns table(job text, required boolean) language sql immutable set search_path = '' as $$
  select * from (values
    ('helm-task-reminders', true), ('helm_inbox_tick', true), ('helm_pay_details_tick', true), ('helm_delivery_reminders', true),
    ('helm_runsheet_reminders', true), ('helm_team_safety_tick', true), ('helm-event-ready-alerts', true), ('helm_comms_tick', true),
    ('helm_vendor_requests', true), ('helm_link_expiry_shelf', true), ('helm_link_views_tick', true), ('helm_quote_stage_sweep', true),
    ('helm_quote_validity', true), ('helm_trial_reminders', true), ('helm_event_reminders', true), ('helm-vendor-bill-reminders', true),
    ('helm_trial_retention', true), ('helm_trial_retention_purge', true), ('helm_billing_refresh', true), ('helm-cron-log-trim', true),
    ('helm_discard_empty_drafts', true), ('helm_rate_hits_purge', true),
    ('helm-wa-templates', false), ('helm-wa-templates-nightly', false), ('helm_referral_tick', false),
    ('helm_comms_dispatch', true), ('invite-mailer', true), ('helm_security_alerts', false), ('helm_pkg_notify', false),
    ('helm_billing_reminder', false), ('helm_welcome_mailer', false)
  ) v(job, required);
$$;

create or replace function public._ops402_worst(p_levels text[])
returns text language sql immutable set search_path = '' as $$
  select case when 'red' = any(coalesce(p_levels, array[]::text[])) then 'red'
              when 'amber' = any(coalesce(p_levels, array[]::text[])) then 'amber' else 'green' end;
$$;

-- the queues: table, label, status column, waiting value, sent values, "opt-in" (sender switched on by the owner: amber at most)
create or replace function public._ops402_queues()
returns table(tbl text, label text, status_col text, wait_val text, sent_vals text[], sent_col text, filter text, opt_in boolean, window_h integer)
language sql immutable set search_path = '' as $$
  select * from (values
    ('comms_outbox', 'Client messages (reminders, links)', 'status', 'pending', array['sent'], 'sent_at', '', false, 72),
    ('helm_notice_outbox', 'Helm e-mails (sales, trial, digests)', 'status', 'pending', array['sent'], 'sent_at', '', false, 72),
    ('staff_email_outbox', 'Staff task e-mails', 'status', 'pending', array['sent'], 'sent_at', '', false, 72),
    ('staff_update_outbox', 'Staff "tasks changed" e-mails', 'status', 'pending', array['sent'], 'sent_at', '', false, 72),
    ('task_wa_outbox', 'WhatsApp task reminders', 'status', 'queued', array['sent', 'delivered', 'read'], 'sent_at', '', false, 72),
    ('assign_notify_outbox', 'WhatsApp notices (team)', 'status', 'pending', array['sent'], 'sent_at', '', false, 72),
    ('delivery_reminder_sends', 'Delivery reminders', 'status', 'pending', array['sent'], 'sent_at', '', false, 72),
    ('runsheet_reminder_sends', 'Run-sheet reminders', 'status', 'pending', array['sent'], 'sent_at', 'channel = ''email''', false, 72),
    ('vendor_request_sends', 'Vendor requests', 'status', 'pending', array['sent'], 'sent_at', 'channel = ''email''', false, 72),
    ('vendor_bill_mail_outbox', 'Vendor bill reminders', 'status', 'pending', array['sent'], 'sent_at', '', false, 72),
    ('cantwork_email_outbox', 'Day-off e-mails', 'status', 'pending', array['sent'], 'sent_at', '', false, 72),
    ('lead_enquiries', 'Enquiry replies', 'reply_status', 'pending', array['sent'], 'sent_at', '', false, 72),
    ('trial_reminders', 'Free-trial reminders', 'email_status', 'pending', array['sent'], 'email_sent_at', '', false, 72),
    ('trial_retention_notices', 'After-trial e-mails', 'email_status', 'pending', array['sent'], 'email_sent_at', '', false, 72),
    ('invite_email_outbox', 'Invite e-mails', 'status', 'pending', array['sent'], 'sent_at', '', false, 72),
    ('pkg_outbox', 'Package codes + e-mails', 'status', 'pending', array['sent'], 'sent_at', '', false, 24),
    ('welcome_email_outbox', 'Welcome e-mails', 'status', 'pending', array['sent'], 'sent_at', '', true, 48),
    ('security_alert_outbox', 'Security alert e-mails', 'status', 'pending', array['sent'], 'sent_at', '', true, 72)
  ) v(tbl, label, status_col, wait_val, sent_vals, sent_col, filter, opt_in, window_h);
$$;

create or replace function public._ops402_health()
returns jsonb language plpgsql volatile security definer set search_path = '' set statement_timeout = '15s' as $$
-- r236-0402: read-only (writes nothing). Server only - HQ reads it through ops_health().
declare
  q record; c record; r jsonb := '{}'::jsonb; v_queues jsonb := '[]'::jsonb; v_jobs jsonb := '[]'::jsonb; v_checks jsonb := '[]'::jsonb;
  v_lv text; v_lvls text[] := array[]::text[]; v_cols text[]; v_due text; v_sql text; n_wait bigint; n_fail bigint; n_sent bigint; v_old timestamptz;
  v_hist boolean := false; v_cron text := 'not_installed'; v_n int; v_red int := 0; v_amber int := 0; v_txt text;
  h_total bigint; h_bad bigint; h_tmo bigint; h_err bigint; h_dorm bigint; h_codes jsonb; v_http jsonb; hb record; v_disp jsonb; v_led bigint;
begin
  -- ---- queues ------------------------------------------------------------------------------------------------------------
  for q in select * from public._ops402_queues() loop
    if to_regclass('public.' || q.tbl) is null then continue; end if;
    begin
      select array_agg(a.attname::text) into v_cols from pg_attribute a where a.attrelid = ('public.' || q.tbl)::regclass and a.attnum > 0 and not a.attisdropped;
      v_due := 'created_at';
      if 'not_before' = any(v_cols) then v_due := 'greatest(created_at, coalesce(not_before, created_at))'; end if;
      if 'due_at' = any(v_cols) then v_due := 'greatest(created_at, coalesce(due_at, created_at))'; end if;
      v_sql := format('select count(*) filter (where %1$I = %2$L and %3$I is null and %4$s <= now()),
                              count(*) filter (where %1$I = ''failed'' and coalesce(%3$I, created_at) >= now() - interval ''24 hours''),
                              count(*) filter (where %1$I = any(%5$L::text[]) and %3$I >= now() - interval ''24 hours''),
                              min(%4$s) filter (where %1$I = %2$L and %3$I is null and %4$s <= now())
                         from public.%6$I where created_at >= now() - make_interval(hours => %7$s) %8$s',
                      q.status_col, q.wait_val, q.sent_col, v_due, q.sent_vals, q.tbl, q.window_h,
                      case when q.filter <> '' then 'and ' || q.filter else '' end);
      execute v_sql into n_wait, n_fail, n_sent, v_old;
      v_lv := case when n_wait > 0 and v_old < now() - interval '60 minutes' then (case when q.opt_in then 'amber' else 'red' end)
                   when n_wait > 0 and v_old < now() - interval '20 minutes' then 'amber'
                   when n_fail > 0 then 'amber' else 'green' end;
      v_lvls := v_lvls || v_lv;
      v_queues := v_queues || jsonb_build_array(jsonb_build_object('name', q.tbl, 'label', q.label, 'waiting', n_wait, 'oldest_waiting', v_old,
        'failed_24h', n_fail, 'sent_24h', n_sent, 'level', v_lv, 'opt_in', q.opt_in));
    exception when others then
      v_queues := v_queues || jsonb_build_array(jsonb_build_object('name', q.tbl, 'label', q.label, 'level', 'amber', 'error', sqlstate));
      v_lvls := v_lvls || 'amber'::text;
    end;
  end loop;
  r := r || jsonb_build_object('queues', v_queues);
  select count(*) filter (where x ->> 'level' = 'red'), count(*) filter (where x ->> 'level' = 'amber') into v_red, v_amber from jsonb_array_elements(v_queues) x;
  v_checks := v_checks || jsonb_build_array(jsonb_build_object('key', 'queues', 'label', 'Message queues',
    'level', public._ops402_worst(array(select x ->> 'level' from jsonb_array_elements(v_queues) x)),
    'text', case when v_red > 0 then v_red || ' queue(s) with messages waiting over an hour - the sender may be off'
                 when v_amber > 0 then v_amber || ' queue(s) slow or with failed messages in 24 h'
                 else jsonb_array_length(v_queues) || ' queues moving' end));

  -- ---- scheduled jobs ----------------------------------------------------------------------------------------------------
  if to_regclass('cron.job') is not null then
    begin
      v_hist := to_regclass('cron.job_run_details') is not null;
      if v_hist then
        begin execute 'select 1 from cron.job_run_details limit 1'; exception when others then v_hist := false; end;
      end if;
      v_cron := case when v_hist then 'readable' else 'no_history' end;
      for c in execute
        format($q$
          select coalesce(j.jobname, e.job) as name, j.schedule, j.active, (j.jobid is not null) as present, coalesce(e.required, false) as required,
                 (e.job is not null) as expected, %1$s
            from (select jobid, jobname, schedule, active from cron.job where jobname like 'helm%%' or jobname = 'invite-mailer') j
            full join public._ops402_expected_jobs() e on e.job = j.jobname
           order by 1$q$,
          case when v_hist then
            '(select max(d.start_time) from cron.job_run_details d where d.jobid = j.jobid and d.status = ''succeeded'' and d.start_time >= now() - interval ''8 days'') as last_ok,
             (select max(d.start_time) from cron.job_run_details d where d.jobid = j.jobid and d.start_time >= now() - interval ''8 days'') as last_run,
             (select count(*) from cron.job_run_details d where d.jobid = j.jobid and d.status = ''failed'' and d.start_time >= now() - interval ''24 hours'') as failed_24h'
          else 'null::timestamptz as last_ok, null::timestamptz as last_run, null::bigint as failed_24h' end)
      loop
        if not c.present and not c.required then continue; end if;
        v_txt := null;
        if not c.present then v_lv := 'red'; v_txt := 'missing';
        elsif not c.active then v_lv := case when c.name = 'helm_comms_dispatch' then 'red' else 'amber' end; v_txt := 'paused';
        elsif v_hist and public._ops402_every(c.schedule) is not null
              and (c.last_ok is null or c.last_ok < now() - 2 * public._ops402_every(c.schedule)) then v_lv := 'red'; v_txt := 'no good run in 2 x its interval';
        elsif v_hist and coalesce(c.failed_24h, 0) > 0 then v_lv := 'amber'; v_txt := c.failed_24h || ' failed run(s) in 24 h';
        elsif not v_hist then v_lv := 'amber'; v_txt := 'run history not readable';
        else v_lv := 'green'; end if;
        v_jobs := v_jobs || jsonb_build_array(jsonb_strip_nulls(jsonb_build_object('name', c.name, 'schedule', c.schedule, 'active', c.active,
          'present', c.present, 'expected', c.expected, 'last_ok', c.last_ok, 'last_run', c.last_run, 'failed_24h', c.failed_24h,
          'level', v_lv, 'why', v_txt)));
      end loop;
    exception when others then v_cron := 'no_access'; v_jobs := '[]'::jsonb;
    end;
  end if;
  r := r || jsonb_build_object('jobs', v_jobs, 'cron', v_cron);
  select count(*) filter (where x ->> 'level' = 'red'), count(*) filter (where x ->> 'level' = 'amber') into v_red, v_amber from jsonb_array_elements(v_jobs) x;
  v_checks := v_checks || jsonb_build_array(jsonb_build_object('key', 'jobs', 'label', 'Scheduled jobs',
    'level', case when v_cron = 'not_installed' then 'red' when v_cron <> 'readable' then 'amber'
                  else public._ops402_worst(array(select x ->> 'level' from jsonb_array_elements(v_jobs) x)) end,
    'text', case when v_cron = 'not_installed' then 'pg_cron is not switched on - no job runs on this database'
                 when v_cron = 'no_access' then 'the job list could not be read'
                 when v_red > 0 then v_red || ' job(s) missing, paused or not running on time'
                 when v_amber > 0 then v_amber || ' job(s) with failed runs or unreadable history'
                 else jsonb_array_length(v_jobs) || ' jobs running on time' end));

  -- ---- pg_net answers of the last hour (a cron job "succeeds" when the call is queued; the answer lands here) -------------
  v_http := jsonb_build_object('readable', false);
  if to_regclass('net._http_response') is not null then
    begin
      execute $h$select count(*), count(*) filter (where status_code is not null and (status_code < 200 or status_code > 299)),
                        count(*) filter (where coalesce(timed_out, false)), count(*) filter (where status_code is null and not coalesce(timed_out, false)),
                        count(*) filter (where status_code between 200 and 299 and content ~ '"status"\s*:\s*"dormant"')
                   from net._http_response where created >= now() - interval '1 hour'$h$
        into h_total, h_bad, h_tmo, h_err, h_dorm;
      execute $h$select coalesce(jsonb_object_agg(status_code::text, n), '{}'::jsonb) from (select status_code, count(*) n from net._http_response
                   where created >= now() - interval '1 hour' and status_code is not null and (status_code < 200 or status_code > 299) group by 1) s$h$ into h_codes;
      v_http := jsonb_build_object('readable', true, 'calls_1h', h_total, 'refused_1h', h_bad, 'timed_out_1h', h_tmo, 'errors_1h', h_err,
                                   'dormant_1h', h_dorm, 'refused_by_status', h_codes);
    exception when others then v_http := jsonb_build_object('readable', false, 'code', sqlstate);
    end;
  end if;
  r := r || jsonb_build_object('http', v_http);
  v_checks := v_checks || jsonb_build_array(jsonb_build_object('key', 'calls', 'label', 'Calls to the senders (last hour)',
    'level', case when not coalesce((v_http ->> 'readable')::boolean, false) then 'amber'
                  when coalesce((v_http ->> 'refused_1h')::int, 0) > 0 or coalesce((v_http ->> 'errors_1h')::int, 0) > 0 then 'red'
                  when coalesce((v_http ->> 'timed_out_1h')::int, 0) > 0 then 'amber' else 'green' end,
    'text', case when not coalesce((v_http ->> 'readable')::boolean, false) then 'call answers can''t be read here (pg_net)'
                 when coalesce((v_http ->> 'refused_1h')::int, 0) > 0 then (v_http ->> 'refused_1h') || ' call(s) refused ' || (v_http ->> 'refused_by_status')::text || ' - 401 = wrong secret, 404 = function not deployed'
                 when coalesce((v_http ->> 'errors_1h')::int, 0) > 0 then (v_http ->> 'errors_1h') || ' call(s) could not connect'
                 when coalesce((v_http ->> 'timed_out_1h')::int, 0) > 0 then (v_http ->> 'timed_out_1h') || ' call(s) took longer than the wait (the sender may still have finished)'
                 else coalesce(v_http ->> 'calls_1h', '0') || ' call(s), all answered' end));
  v_checks := v_checks || jsonb_build_array(jsonb_build_object('key', 'switched_off', 'label', 'Senders switched off',
    'level', case when coalesce((v_http ->> 'dormant_1h')::int, 0) > 0 then 'amber' else 'green' end,
    'text', case when coalesce((v_http ->> 'dormant_1h')::int, 0) > 0 then (v_http ->> 'dormant_1h') || ' call(s) answered "switched off" (a HELM_*_ENABLED switch) - fine only if you meant it'
                 when coalesce((v_http ->> 'readable')::boolean, false) then 'none in the last hour' else 'unknown' end));

  -- ---- the comms-dispatch heartbeat ------------------------------------------------------------------------------------
  select h.* into hb from public.ops_heartbeat h where h.name = 'comms-dispatch';
  if hb.name is null then
    v_disp := jsonb_build_object('seen', false, 'level', 'amber', 'text', 'no heartbeat yet - redeploy comms-dispatch (R236) to see its runs here');
  else
    v_lv := case when hb.last_run_at < now() - interval '15 minutes' then 'red'
                 when hb.last_status in ('dormant', 'no_provider', 'error') then 'red' else 'green' end;
    v_disp := jsonb_build_object('seen', true, 'last_run_at', hb.last_run_at, 'last_ok_at', hb.last_ok_at, 'last_status', hb.last_status,
      'counts', hb.detail, 'level', v_lv,
      'text', case when hb.last_run_at < now() - interval '15 minutes' then 'last run ' || to_char(hb.last_run_at at time zone 'UTC', 'DD Mon HH24:MI') || ' UTC - not running every 5 minutes'
                   when hb.last_status = 'dormant' then 'switched off (HELM_COMMS_ENABLED = false): nothing is sent, messages wait and age out'
                   when hb.last_status = 'no_provider' then 'no e-mail provider set (SMTP / Resend secrets): e-mails wait'
                   when hb.last_status = 'error' then 'the last run failed - see the function logs'
                   else 'running; last run ' || to_char(hb.last_run_at at time zone 'UTC', 'HH24:MI') || ' UTC' end);
  end if;
  r := r || jsonb_build_object('dispatcher', v_disp);
  v_checks := jsonb_build_array(jsonb_build_object('key', 'dispatcher', 'label', 'E-mail / WhatsApp sender (comms-dispatch)',
    'level', v_disp ->> 'level', 'text', v_disp ->> 'text')) || v_checks;

  -- ---- sent but not marked (JOB-03) ------------------------------------------------------------------------------------
  select count(*) into v_led from public.ops_send_ledger l where l.resolved_at is null;
  v_checks := v_checks || jsonb_build_array(jsonb_build_object('key', 'ledger', 'label', 'Sent but not yet marked',
    'level', case when v_led > 0 then 'amber' else 'green' end,
    'text', case when v_led > 0 then v_led || ' message(s) went out but could not be marked - they will not be sent again'
                 else 'none' end));

  r := r || jsonb_build_object('checks', v_checks, 'version', 1, 'generated_at', now(),
    'overall', public._ops402_worst(array(select x ->> 'level' from jsonb_array_elements(v_checks) x)));
  return r;
end $$;

create or replace function public.ops_health()
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
-- r236-0402: HQ staff with Overview access only (same gate as hq_metrics). Read-only.
begin
  perform public._hq27_require(public._hq27_read_perm('hq_metrics'), false);
  return public._ops402_health();
end $$;

-- ===========================================================================================================================
-- 6) privileges: nobody but the database owner, except: ops_health (signed-in; HQ gate inside), the three sender calls
--    (service role)
-- ===========================================================================================================================
do $$ declare f text; r text; begin
  foreach f in array array['public.ops_heartbeat_beat(text, text, jsonb)', 'public.ops_send_ledger_note(text, uuid, text)',
      'public.ops_send_ledger_open()', 'public._ops402_lane(text)', 'public._r402_queues()', 'public._r402_tg_backoff()',
      'public._r402_keep(text)', 'public._ops402_mailers()', 'public._ops402_cmd(text)', 'public._ops402_norm(text)',
      'public._ops402_base_url()', 'public.ops_kick_mailer(text)', 'public.ops_mailer_cron_report()', 'public.ops_mailer_cron_ensure()',
      'public.ops_mailer_cron_adopt(text)', 'public._ops402_every(text)', 'public._ops402_expected_jobs()', 'public._ops402_worst(text[])',
      'public._ops402_queues()', 'public._ops402_health()', 'public.ops_health()'] loop
    continue when to_regprocedure(f) is null;
    execute format('revoke all on function %s from public', f);
    foreach r in array array['anon', 'authenticated', 'service_role'] loop
      if exists (select 1 from pg_roles where rolname = r) then execute format('revoke all on function %s from %I', f, r); end if;
    end loop;
  end loop;
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    execute 'grant execute on function public.ops_heartbeat_beat(text, text, jsonb) to service_role';
    execute 'grant execute on function public.ops_send_ledger_note(text, uuid, text) to service_role';
    execute 'grant execute on function public.ops_send_ledger_open() to service_role';
  end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    execute 'grant execute on function public.ops_health() to authenticated';
  end if;
  foreach f in array array['ops_heartbeat', 'ops_send_ledger'] loop
    execute format('revoke all on table public.%I from public', f);
    foreach r in array array['anon', 'authenticated'] loop
      if exists (select 1 from pg_roles where rolname = r) then execute format('revoke all on table public.%I from %I', f, r); end if;
    end loop;
  end loop;
end $$;
