-- APPLY-0410 (R242 fix plan Phase 5: package codes sent at once + no double send for the other e-mail senders).
-- Run on STAGING first, then production, AFTER APPLY-0402 (already on both). Safe to run twice.
-- If APPLY-0402 is ever run again later, run this file again after it (check row 03 says so).
-- What it does:
--   * When a client asks for a package confirmation code (it lives 10 minutes), the database wakes the package sender at
--     once instead of waiting for its 2-minute job. Needs the Vault secrets helm_pkg_notify_secret + helm_functions_base_url
--     (check row 05 says which are missing); without them nothing changes - the regular job still sends the code. It never
--     blocks the client. Switch it off: update public.helm_ops_settings set pkg_wake = false;
--   * The "sent but not marked" ledger (0402) now also covers the welcome, invitation, security alert, package and billing
--     e-mails - so after the redeploy of those 5 edge functions a message is never sent twice when marking it failed.
-- Nothing is deleted. Two small new tables, new functions, one trigger on pkg_outbox, a wider check on ops_send_ledger.
-- It waits at most 5 seconds for a table lock (then stops with an error and changes nothing - just run it again later).
-- Paste the whole file into the Supabase SQL editor and press Run. The last result lists checks - every ok must be true.
begin;
set local lock_timeout = '5s';
set local statement_timeout = '5min';
-- 0410_r242_mailer_wake_ledger.sql - CANONICAL forward-only. R242 (fix plan Phase 5, owner approved 20 Nov 2026; LINK-01,
-- INT-02 / JOB-03 for the other mailers). REQUIRES 0402 (ops_send_ledger, _ops402_lane, ops_kick_mailer) + 0069 (pkg_outbox).
--
-- In plain words:
--   1  Package codes go out at once (LINK-01). A client's package confirmation code lives 10 minutes, but the package sender
--      runs only every 2 minutes (and a hand-made job may run less often). Now, when a code is queued, the database wakes
--      the sender straight away (one call to pkg-client-notify through pg_net, with the secret read from Vault by name -
--      the same ops_kick_mailer the 0402 jobs use). It never blocks or slows the client: any problem (no pg_net, no Vault
--      secret, no functions address) is skipped quietly and the regular 2-minute job still sends the code. At most one
--      wake-up per 20 seconds. Owner switch: helm_ops_settings.pkg_wake (on by default; false = only the regular job).
--   2  No double send for the other mailers (JOB-03). The 0402 "sent but not marked" ledger now also takes the welcome,
--      invitation, security alert, package and billing e-mails (lanes welcome / invite / security / pkg / billing), so
--      welcome-mailer, invite-mailer, security-alert-mailer, pkg-client-notify and billing-reminder can use it like
--      comms-dispatch does (edge functions R242: redeploy them). Lane names only - never an address or text.
--
-- ZERO DATA LOSS: additive + idempotent. Two new one-row / small tables (helm_ops_settings, ops_mailer_wake: no business data),
-- new functions, one AFTER INSERT trigger on pkg_outbox (it only wakes the sender, it never changes the row). The ledger's
-- lane CHECK is replaced by a WIDER one (every old lane kept, so no existing note can fail it). _ops402_lane re-issued with
-- the 5 new lanes (every old lane unchanged). Nothing dropped from data, nothing deleted. Safe to run twice. ASCII only.
-- NOTE: APPLY-0402 run again later would put the older _ops402_lane back - then run APPLY-0410 again (check row 03 says so).
-- Undo (manual): update public.helm_ops_settings set pkg_wake = false; (or drop trigger zz_r410_pkg_wake on public.pkg_outbox)

do $$
begin
  if to_regclass('public.ops_send_ledger') is null or to_regprocedure('public._ops402_lane(text)') is null
     or to_regprocedure('public.ops_kick_mailer(text)') is null then
    raise exception 'STOP 0410: ops_send_ledger / _ops402_lane / ops_kick_mailer missing - run 0402 first'; end if;
end $$;

-- ===========================================================================================================================
-- 1) owner switches for Phase 5 (one row)
-- ===========================================================================================================================
create table if not exists public.helm_ops_settings (
  id         boolean primary key default true check (id),
  pkg_wake   boolean not null default true,
  updated_at timestamptz not null default now(),
  updated_by uuid
);
comment on table public.helm_ops_settings is
  'r242-0410: owner switches for background senders. pkg_wake = wake pkg-client-notify as soon as a package code is queued (false = only the regular cron job). One row. Owner changes it in the SQL editor.';
insert into public.helm_ops_settings(id) values (true) on conflict (id) do nothing;
alter table public.helm_ops_settings enable row level security;

-- one row per sender woken: when it was last woken (the 20-second throttle) and how often
create table if not exists public.ops_mailer_wake (
  fn           text primary key,
  last_kick_at timestamptz not null default now(),
  kicks        bigint not null default 0,
  skipped      bigint not null default 0,
  last_skip    text,
  constraint ops_mailer_wake_fn_chk410 check (fn ~ '^[a-z0-9-]{1,40}$'),
  constraint ops_mailer_wake_skip_chk410 check (last_skip is null or last_skip ~ '^[A-Za-z0-9_ ]{1,40}$')
);
comment on table public.ops_mailer_wake is
  'r242-0410: last wake-up of a sender from a queue trigger (throttle: one per 20 s) + counts. Function names and SQLSTATE codes only.';
alter table public.ops_mailer_wake enable row level security;

create or replace function public._r410_wake(p_fn text)
returns boolean language plpgsql volatile security definer set search_path = '' as $$
-- r242-0410: wake one sender now, at most once per 20 seconds. NEVER raises: the caller is a client's own request.
declare v_go boolean := false;
begin
  if coalesce(current_setting('helm.mailer_wake', true), '') = 'off' then return false; end if;
  if to_regnamespace('net') is null then return false; end if;
  begin
    insert into public.ops_mailer_wake as w (fn, last_kick_at, kicks) values (p_fn, now(), 1)
    on conflict (fn) do update set last_kick_at = now(), kicks = w.kicks + 1 where w.last_kick_at < now() - interval '20 seconds'
    returning true into v_go;
  exception when others then return false;
  end;
  if not coalesce(v_go, false) then return false; end if;
  begin
    perform public.ops_kick_mailer(p_fn);
    return true;
  exception when others then
    begin
      update public.ops_mailer_wake set skipped = skipped + 1, last_skip = left(sqlstate, 40) where fn = p_fn;
    exception when others then null;
    end;
    return false;
  end;
end $$;

-- what the wake needs, in words (for the APPLY check + HQ switches): never a secret value (vault.secrets by NAME only)
create or replace function public._r410_wake_ready(p_fn text default 'pkg-client-notify')
returns text language plpgsql stable security definer set search_path = '' as $$
declare v_sec text; v_has boolean;
begin
  if to_regnamespace('net') is null then return 'pg_net is not on here - the regular job sends'; end if;
  if to_regclass('vault.secrets') is null then return 'Vault not readable here'; end if;
  select m.vault_secret into v_sec from public._ops402_mailers() m where m.fn = p_fn;
  if v_sec is null then return 'unknown sender'; end if;
  execute 'select exists (select 1 from vault.secrets s where s.name = $1)' into v_has using v_sec;
  return v_sec || ': ' || case when v_has then 'set' else 'NOT set' end || ', helm_functions_base_url: '
         || case when public._ops402_base_url() is not null then 'set' else 'NOT set' end;
exception when others then return 'cannot be read here (' || sqlstate || ')';
end $$;

create or replace function public._r410_tg_pkg_wake()
returns trigger language plpgsql security definer set search_path = '' as $$
-- r242-0410: a package code was queued -> wake pkg-client-notify (fail-soft, never blocks the insert)
begin
  begin
    if coalesce((select s.pkg_wake from public.helm_ops_settings s where s.id), true) then
      perform public._r410_wake('pkg-client-notify');
    end if;
  exception when others then null;
  end;
  return null;
end $$;

do $$ begin
  if to_regclass('public.pkg_outbox') is not null then
    execute 'create or replace trigger zz_r410_pkg_wake after insert on public.pkg_outbox for each row
               when (new.kind = ''pkg_otp'' and new.status = ''pending'') execute function public._r410_tg_pkg_wake()';
  end if;
end $$;

-- ===========================================================================================================================
-- 2) the send ledger takes the other mailers' lanes
-- ===========================================================================================================================
create or replace function public._ops402_lane(p_lane text)
returns text[] language sql immutable set search_path = '' as $$
  -- r242-0410: 0402 lanes + welcome / invite / security / pkg / billing
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
    when 'welcome' then array['welcome_email_outbox', 'sent_at']
    when 'invite' then array['invite_email_outbox', 'sent_at']
    when 'security' then array['security_alert_outbox', 'sent_at']
    when 'pkg' then array['pkg_outbox', 'sent_at']
    when 'billing' then array['billing_reminders', 'sent_at']
  end;
$$;

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'ops_send_ledger_lane_chk410' and conrelid = 'public.ops_send_ledger'::regclass) then
    alter table public.ops_send_ledger add constraint ops_send_ledger_lane_chk410 check (lane in ('comms', 'trial_reminder', 'trial_retention',
      'assign', 'task_wa', 'delivery', 'vendor_request', 'vendor_bill', 'runsheet', 'staff_email', 'staff_update', 'cantwork', 'enquiry',
      'helm_notice', 'welcome', 'invite', 'security', 'pkg', 'billing')) not valid;
    alter table public.ops_send_ledger validate constraint ops_send_ledger_lane_chk410;
  end if;
  -- the narrower 0402 check is replaced by the wider one above (every old lane is in it)
  alter table public.ops_send_ledger drop constraint if exists ops_send_ledger_lane_chk402;
end $$;

-- ===========================================================================================================================
-- 3) privileges: nobody but the database owner (the trigger function runs as its definer)
-- ===========================================================================================================================
do $$ declare f text; r text; begin
  foreach f in array array['public._r410_wake(text)', 'public._r410_wake_ready(text)', 'public._r410_tg_pkg_wake()', 'public._ops402_lane(text)'] loop
    execute format('revoke all on function %s from public', f);
    foreach r in array array['anon', 'authenticated', 'service_role'] loop
      if exists (select 1 from pg_roles where rolname = r) then execute format('revoke all on function %s from %I', f, r); end if;
    end loop;
  end loop;
  foreach f in array array['helm_ops_settings', 'ops_mailer_wake'] loop
    execute format('revoke all on table public.%I from public', f);
    foreach r in array array['anon', 'authenticated'] loop
      if exists (select 1 from pg_roles where rolname = r) then execute format('revoke all on table public.%I from %I', f, r); end if;
    end loop;
  end loop;
end $$;

-- ---- checks (every ok must be true) --------------------------------------------------------------------------------------
select item, ok, note from (
  select '01 tables helm_ops_settings + ops_mailer_wake: row security on, no app access' as item,
     coalesce((select bool_and(c.relrowsecurity) from pg_class c where c.oid in (to_regclass('public.helm_ops_settings'), to_regclass('public.ops_mailer_wake'))), false)
     and not has_table_privilege('authenticated', 'public.helm_ops_settings', 'select')
     and not has_table_privilege('anon', 'public.ops_mailer_wake', 'select') as ok,
     'package code wake is ' || case when (select pkg_wake from public.helm_ops_settings where id) then 'ON' else 'OFF' end as note
  union all
  select '02 wake trigger on pkg_outbox (package codes only)',
     exists (select 1 from pg_trigger t where t.tgname = 'zz_r410_pkg_wake' and t.tgrelid = 'public.pkg_outbox'::regclass), ''
  union all
  select '03 ledger takes the 5 new lanes (run APPLY-0410 again if APPLY-0402 was re-run after it)',
     public._ops402_lane('welcome') is not null and public._ops402_lane('invite') is not null and public._ops402_lane('security') is not null
     and public._ops402_lane('pkg') is not null and public._ops402_lane('billing') is not null and public._ops402_lane('comms') is not null
     and exists (select 1 from pg_constraint where conname = 'ops_send_ledger_lane_chk410' and convalidated)
     and not exists (select 1 from pg_constraint where conname = 'ops_send_ledger_lane_chk402'), ''
  union all
  select '04 helpers: no app privilege',
     not has_function_privilege('authenticated', 'public._r410_wake(text)', 'execute')
     and not has_function_privilege('anon', 'public._r410_tg_pkg_wake()', 'execute')
     and not has_function_privilege('service_role', 'public._r410_wake(text)', 'execute'), ''
  union all
  select '05 what the wake needs (report only): pg_net + Vault helm_pkg_notify_secret + helm_functions_base_url',
     true,
     public._r410_wake_ready('pkg-client-notify')
) v order by item;
commit;
