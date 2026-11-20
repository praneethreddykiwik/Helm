-- 0412_r242_switches_schema.sql - CANONICAL forward-only. R242 (fix plan Phase 5, owner approved 20 Nov 2026; HQ-03, HQ-04).
-- REQUIRES 0277 + 0332 (_hq27_require / _hq27_read_perm, the HQ gate). Every switch table is optional: a database without
-- one shows "not on this database" for that row.
--
-- In plain words:
--   1  One read-only "Switches" list for HQ (HQ-03). About 25 on / off switches live in different tables (welcome e-mails,
--      free-trial purge, skip-payment at checkout, photo render limits, upload scanner, referral program, two-step for HQ,
--      sales form ...), plus the cron jobs and the Vault secrets the e-mail jobs need. hq_switches() lists them all with
--      their current value - HQ staff with Overview access only, read-only (it changes nothing). Secrets are shown ONLY as
--      "set" / "not set" by their NAME (read from vault.secrets, never decrypted) - a secret value is never read or returned.
--   2  The app knows which database updates are in (HQ-04). A page's code can reach the site before its SQL is pasted
--      (then the page used to fail with "function not found"). helm_schema_version() answers the highest database update
--      this database has + the list of recent ones found (signed-in users; numbers only). The pages hide a feature whose
--      update is not in yet and say "database update pending" instead of failing. From now on every migration adds its
--      number to helm_schema_markers (one insert, see docs/RUNBOOK-MIGRATIONS.md); older ones are found by their objects.
--
-- ZERO DATA LOSS: additive + idempotent. One new table helm_schema_markers (numbers only), read-only functions. Nothing
-- changed, dropped or deleted. Safe to run twice. ASCII only.

do $$
begin
  if to_regprocedure('public._hq27_require(text,boolean)') is null or to_regprocedure('public._hq27_read_perm(text)') is null then
    raise exception 'STOP 0412: _hq27_require / _hq27_read_perm missing - run 0277 first'; end if;
end $$;

-- ===========================================================================================================================
-- 1) schema version
-- ===========================================================================================================================
create table if not exists public.helm_schema_markers (
  num        integer primary key,
  name       text not null,
  applied_at timestamptz not null default now(),
  constraint helm_schema_markers_num_chk412 check (num between 1 and 9999),
  constraint helm_schema_markers_name_chk412 check (name ~ '^[a-z0-9_]{1,80}$')
);
comment on table public.helm_schema_markers is
  'r242-0412: one row per database update (migration number + file name) - written by the migration itself (insert ... on conflict do nothing). Read by helm_schema_version(). Numbers only.';
alter table public.helm_schema_markers enable row level security;
insert into public.helm_schema_markers(num, name) values
  (409, '0409_r242_cron_stagger'), (410, '0410_r242_mailer_wake_ledger'), (411, '0411_r242_render_cap'), (412, '0412_r242_switches_schema')
on conflict (num) do nothing;

-- recent updates found by one object each (for the ones made before helm_schema_markers existed)
create or replace function public._r412_probes()
returns table(num integer, kind text, obj text) language sql immutable set search_path = '' as $$
  select * from (values
    (381, 'tbl', 'public.studio_test_mode'), (383, 'tbl', 'public.signin_notice_settings'), (384, 'idx', 'public.ix_event_tasks_quote_crew_0384'),
    (385, 'fn', 'public._r385_can_assign()'), (386, 'fn', 'public._r386_tg_role_sync()'), (387, 'fn', 'public.event_money_header__pre0387(uuid)'),
    (388, 'fn', 'public._r388_vis(uuid,uuid)'), (389, 'fn', 'public.page_bootstrap()'), (393, 'idx', 'public.ix_leads_org_updated_0393'),
    (396, 'tbl', 'public.event_day_plans'), (397, 'tbl', 'public.event_plan_locks'), (398, 'fn', 'public._r398_retired_roles()'),
    (399, 'tbl', 'public.event_department_supervisors'), (400, 'fn', 'public._r400_roles()'), (401, 'fn', 'public._r401_keep(regprocedure)'),
    (402, 'tbl', 'public.ops_heartbeat'), (403, 'tbl', 'public.account_age_confirmations'),
    (409, 'fn', 'public.ops_cron_stagger_report()'), (410, 'tbl', 'public.helm_ops_settings'), (411, 'tbl', 'public.helm_render_cap'),
    (412, 'tbl', 'public.helm_schema_markers')
  ) v(num, kind, obj);
$$;

create or replace function public._r412_applied()
returns integer[] language plpgsql stable security definer set search_path = '' as $$
declare p record; v integer[] := array[]::integer[];
begin
  for p in select * from public._r412_probes() loop
    if (p.kind = 'fn' and to_regprocedure(p.obj) is not null) or (p.kind in ('tbl', 'idx') and to_regclass(p.obj) is not null) then
      v := v || p.num; end if;
  end loop;
  v := v || coalesce((select array_agg(m.num order by m.num) from public.helm_schema_markers m), array[]::integer[]);
  return coalesce((select array_agg(distinct x order by x) from unnest(v) x), array[]::integer[]);
end $$;

-- signed-in users: { version: highest update found, applied: [recent numbers found] } - numbers only
create or replace function public.helm_schema_version()
returns jsonb language plpgsql stable security definer set search_path = '' as $$
-- r242-0412
declare v integer[];
begin
  if auth.uid() is null then raise exception 'not authorized' using errcode = '42501'; end if;
  v := public._r412_applied();
  return jsonb_build_object('version', coalesce((select max(x) from unnest(v) x), 0), 'applied', to_jsonb(v), 'marker', 'r242-0412');
end $$;

-- ===========================================================================================================================
-- 2) the switches list (HQ, read-only)
-- ===========================================================================================================================
-- one column of a one-row settings table, as jsonb (null when the table / column is not here)
create or replace function public._r412_val(p_tbl text, p_col text)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare v jsonb;
begin
  if to_regclass('public.' || p_tbl) is null then return null; end if;
  if not exists (select 1 from pg_attribute a where a.attrelid = ('public.' || p_tbl)::regclass and a.attname = p_col and not a.attisdropped) then return null; end if;
  execute format('select to_jsonb(t.%I) from public.%I t limit 1', p_col, p_tbl) into v;
  return v;
exception when others then return null;
end $$;

-- a Vault secret exists by NAME (vault.secrets, never decrypted). null = cannot be read here.
create or replace function public._r412_secret_set(p_name text)
returns boolean language plpgsql stable security definer set search_path = '' as $$
declare v boolean;
begin
  if to_regclass('vault.secrets') is null then return null; end if;
  execute 'select exists (select 1 from vault.secrets s where s.name = $1)' into v using p_name;
  return v;
exception when others then return null;
end $$;

create or replace function public._r412_item(p_key text, p_label text, p_value jsonb, p_good jsonb, p_note text)
returns jsonb language sql immutable set search_path = '' as $$
  -- state: on / off / value / missing (table not here); good = the value Helm expects on production (for an amber dot)
  select jsonb_strip_nulls(jsonb_build_object('key', p_key, 'label', p_label, 'value', p_value,
    'state', case when p_value is null then 'missing' when p_value = 'true'::jsonb then 'on' when p_value = 'false'::jsonb then 'off' else 'value' end,
    'expected', p_good, 'differs', case when p_good is not null and p_value is not null then p_value <> p_good end, 'note', p_note));
$$;

create or replace function public._r412_switches()
returns jsonb language plpgsql stable security definer set search_path = '' set statement_timeout = '15s' as $$
-- r242-0412: read-only (writes nothing). Never a secret value, never a job's own text, never a studio name / address.
declare g jsonb := '[]'::jsonb; it jsonb; r record; v_env jsonb; v_n bigint; v_cron boolean := to_regclass('cron.job') is not null;
begin
  -- ---- messages ---------------------------------------------------------------------------------------------------------
  it := jsonb_build_array(
    public._r412_item('welcome_emails', 'Welcome e-mails (new studios / members)', public._r412_val('helm_welcome_mail_settings', 'enabled'), null, 'helm_welcome_mail_settings.enabled (0327)'),
    public._r412_item('trial_client_email', 'Free-trial client e-mails (capped)', public._r412_val('trial_email_settings', 'enabled'), null, 'trial_email_settings.enabled (0212)'),
    public._r412_item('pkg_wake', 'Send package codes at once', public._r412_val('helm_ops_settings', 'pkg_wake'), 'true'::jsonb,
      'helm_ops_settings.pkg_wake (0410)' || case when to_regprocedure('public._r410_wake_ready(text)') is not null then ' - needs ' || public._r410_wake_ready('pkg-client-notify') else '' end),
    public._r412_item('sales_form_open', 'Contact-sales form open', public._r412_val('helm_sales_settings', 'form_open'), 'true'::jsonb, 'helm_sales_settings.form_open (0271)'),
    public._r412_item('sales_auto_reply', 'Contact-sales auto reply', public._r412_val('helm_sales_settings', 'auto_reply'), null, 'helm_sales_settings.auto_reply (0271)'));
  if to_regclass('public.ops_heartbeat') is not null then
    it := it || jsonb_build_array(public._r412_item('comms_dispatch', 'E-mail / WhatsApp sender (comms-dispatch) last answer',
      (select to_jsonb(h.last_status) from public.ops_heartbeat h where h.name = 'comms-dispatch'), '"ok"'::jsonb,
      'dormant = switched off with HELM_COMMS_ENABLED (edge secret); no_provider = no SMTP / Resend secret'));
  end if;
  it := it || jsonb_build_array(public._r412_item('edge_switches', 'Edge function switches (HELM_..._ENABLED)', '"see System health"'::jsonb, null,
    'these live in the Supabase edge secrets, not in the database - System health shows a sender that answered "switched off"'));
  g := g || jsonb_build_array(jsonb_build_object('key', 'messages', 'label', 'Messages', 'items', it));

  -- ---- free trial + billing ----------------------------------------------------------------------------------------------
  it := jsonb_build_array(
    public._r412_item('trial_purge', 'Free-trial data purge (DELETES ended trials)', public._r412_val('helm_trial_retention', 'delete_enabled'), 'false'::jsonb, 'helm_trial_retention.delete_enabled (0184) - keep off until the owner decides'),
    public._r412_item('trial_retention_days', 'Free-trial data kept for (days)', public._r412_val('helm_trial_retention', 'retention_days'), null, 'helm_trial_retention.retention_days'),
    public._r412_item('checkout_skip_payment', 'Checkout "Skip payment" bypass', public._r412_val('helm_billing_settings', 'allow_trial_bypass'), 'false'::jsonb, 'helm_billing_settings.allow_trial_bypass (0056 / 0162: off on production)'),
    public._r412_item('referral_program', 'Referral program', public._r412_val('referral_settings', 'program_on'), null, 'referral_settings.program_on (0279)'));
  g := g || jsonb_build_array(jsonb_build_object('key', 'trial', 'label', 'Free trial and billing', 'items', it));

  -- ---- photo renders -----------------------------------------------------------------------------------------------------
  v_n := null;
  if to_regclass('public.photo_render_settings') is not null then
    begin execute 'select count(*) from public.photo_render_settings where enabled' into v_n; exception when others then v_n := null; end;
  end if;
  it := jsonb_build_array(
    public._r412_item('renders_on', 'Photo renders (all studios)', public._r412_val('helm_render_cap', 'renders_on'), null, 'helm_render_cap.renders_on (0411) - false pauses every studio'),
    public._r412_item('render_studio_day', 'Pictures per studio per day', public._r412_val('helm_render_cap', 'studio_daily_images'), null, 'helm_render_cap.studio_daily_images'),
    public._r412_item('render_helm_day', 'Pictures per day, all studios', public._r412_val('helm_render_cap', 'helm_daily_images'), null, 'helm_render_cap.helm_daily_images'),
    public._r412_item('render_helm_month', 'Pictures per month, all studios', public._r412_val('helm_render_cap', 'helm_monthly_images'), null, 'helm_render_cap.helm_monthly_images'),
    public._r412_item('render_helm_usd', 'Estimated cost per month, all studios (USD)', public._r412_val('helm_render_cap', 'helm_monthly_usd'), null, 'helm_render_cap.helm_monthly_usd (empty = no cost limit)'),
    public._r412_item('render_studios_on', 'Studios with photo renders switched on', to_jsonb(v_n), null, 'photo_render_settings.enabled (0095, each studio''s admin)'));
  if to_regprocedure('public._r411_state(uuid)') is not null then
    begin
      it := it || jsonb_build_array(public._r412_item('render_used', 'Pictures made this month / today (all studios)',
        to_jsonb((public._r411_state(null) ->> 'helm_month_used') || ' / ' || (public._r411_state(null) ->> 'helm_day_used')), null, 'counted the 0095 way (finished + running)'));
    exception when others then null;
    end;
  end if;
  g := g || jsonb_build_array(jsonb_build_object('key', 'renders', 'label', 'Photo renders (AI)', 'items', it));

  -- ---- security ----------------------------------------------------------------------------------------------------------
  it := jsonb_build_array(
    public._r412_item('hq_require_mfa', 'Two-step required for HQ', public._r412_val('helm_hq_settings', 'hq_require_mfa'), 'true'::jsonb, 'helm_hq_settings.hq_require_mfa (0047)'),
    public._r412_item('upload_scan', 'Upload scanner enforced', public._r412_val('upload_scan_config', 'enforce'), null, 'upload_scan_config.enforce (0051) - on after verify-upload is deployed'),
    public._r412_item('stage_guard', 'Quote stage guard', public._r412_val('helm_stage_settings', 'guard_mode'), null, 'helm_stage_settings.guard_mode (0263: off / warn / enforce)'));
  -- per-environment switches (0042): the value only when it is true / false / a number - any other value is shown as "set"
  if to_regclass('public.helm_env_settings') is not null then
    for r in execute 'select key, value from public.helm_env_settings order by key limit 30' loop
      continue when r.key !~ '^[a-z0-9_]{1,60}$';
      v_env := case when jsonb_typeof(r.value) in ('boolean', 'number', 'null') then r.value else '"set"'::jsonb end;
      it := it || jsonb_build_array(public._r412_item('env_' || r.key, 'Environment: ' || r.key, v_env, null, 'helm_env_settings (0042)'));
    end loop;
  end if;
  g := g || jsonb_build_array(jsonb_build_object('key', 'security', 'label', 'Security', 'items', it));

  -- ---- jobs --------------------------------------------------------------------------------------------------------------
  it := jsonb_build_array(
    public._r412_item('pg_cron', 'Job timer (pg_cron)', to_jsonb(v_cron), 'true'::jsonb, case when v_cron then null else 'not switched on: no scheduled job runs here' end),
    public._r412_item('pg_net', 'Calls to the senders (pg_net)', to_jsonb(to_regnamespace('net') is not null), 'true'::jsonb, null));
  if v_cron and to_regprocedure('public.ops_cron_stagger_report()') is not null then
    begin
      for r in select x.state, count(*) n, string_agg(x.job, ', ' order by x.job) jobs from public.ops_cron_stagger_report() x group by x.state order by x.state loop
        it := it || jsonb_build_array(public._r412_item('cron_' || r.state, 'Jobs: ' || r.state, to_jsonb(r.n),
          null, case when r.state in ('kept_owner', 'owner_job', 'can_stagger') then left(r.jobs, 300) end));
      end loop;
    exception when others then null;
    end;
  end if;
  if v_cron and to_regprocedure('public.ops_mailer_cron_report()') is not null then
    begin
      for r in select x.job, x.state from public.ops_mailer_cron_report() x order by x.job loop
        it := it || jsonb_build_array(public._r412_item('mailer_' || r.job, 'Sender job ' || r.job, to_jsonb(r.state), null, null));
      end loop;
    exception when others then null;
    end;
  end if;
  g := g || jsonb_build_array(jsonb_build_object('key', 'jobs', 'label', 'Scheduled jobs', 'items', it));

  -- ---- Vault secrets, by NAME only ---------------------------------------------------------------------------------------
  it := '[]'::jsonb;
  for r in select x.name from (values ('helm_functions_base_url'), ('helm_comms_secret'), ('helm_invite_email_secret'), ('helm_security_alert_secret'),
      ('helm_pkg_notify_secret'), ('helm_billing_cron_secret'), ('helm_welcome_email_secret'), ('helm_wa_worker_url'), ('helm_wa_template_secret')) x(name) loop
    it := it || jsonb_build_array(public._r412_item('vault_' || r.name, r.name,
      case public._r412_secret_set(r.name) when true then '"set"'::jsonb when false then '"not set"'::jsonb else '"cannot be read here"'::jsonb end, null, null));
  end loop;
  g := g || jsonb_build_array(jsonb_build_object('key', 'vault', 'label', 'Vault secrets (name only - never the value)', 'items', it));

  -- ---- database updates --------------------------------------------------------------------------------------------------
  g := g || jsonb_build_array(jsonb_build_object('key', 'schema', 'label', 'Database updates', 'items', jsonb_build_array(
    public._r412_item('schema_version', 'Highest database update found', to_jsonb((select max(x) from unnest(public._r412_applied()) x)), null,
      'run CHECK-PROD-MIGRATIONS.sql for the full list'))));

  return jsonb_build_object('groups', g, 'generated_at', now(), 'version', 1);
end $$;

create or replace function public.hq_switches()
returns jsonb language plpgsql stable security definer set search_path = '' as $$
-- r242-0412: HQ staff with Overview access only (same gate as hq_ops_health). Read-only.
begin
  perform public._hq27_require(public._hq27_read_perm('hq_metrics'), false);
  return public._r412_switches();
end $$;

-- ===========================================================================================================================
-- 3) privileges: helm_schema_version (signed-in), hq_switches (signed-in; HQ gate inside); the rest nobody but the owner
-- ===========================================================================================================================
do $$ declare f text; r text; begin
  foreach f in array array['public._r412_probes()', 'public._r412_applied()', 'public.helm_schema_version()', 'public._r412_val(text, text)',
      'public._r412_secret_set(text)', 'public._r412_item(text, text, jsonb, jsonb, text)', 'public._r412_switches()', 'public.hq_switches()'] loop
    execute format('revoke all on function %s from public', f);
    foreach r in array array['anon', 'authenticated', 'service_role'] loop
      if exists (select 1 from pg_roles where rolname = r) then execute format('revoke all on function %s from %I', f, r); end if;
    end loop;
  end loop;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    execute 'grant execute on function public.helm_schema_version() to authenticated';
    execute 'grant execute on function public.hq_switches() to authenticated';
  end if;
  execute 'revoke all on table public.helm_schema_markers from public';
  foreach r in array array['anon', 'authenticated'] loop
    if exists (select 1 from pg_roles where rolname = r) then execute format('revoke all on table public.helm_schema_markers from %I', r); end if;
  end loop;
end $$;
