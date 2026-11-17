-- APPLY-0372 (R189 Money phase 1: lock the money - frozen P&L at close, corrections, Confirm attendance, client TDS, money rules). Run on STAGING first, then production, after 0371. Safe to run twice - also on top of an earlier APPLY-0372.
-- Adds six closed money tables (insert-only), one trigger on event_closure and wraps six money functions once (old bodies kept as __pre0372). Every default keeps today's numbers. Nothing is changed or deleted. If it stops with a STOP message nothing was applied.
begin;
-- 0372_r189_money_lock.sql - R189 Money phase 1 "Lock the money" (owner, 17 Nov 2026; MONEY-INVENTORY-PLAN.md phase 1 +
-- its "Phase 1 review (R189)"). Forward-only, additive, safe to run twice. ASCII only.
-- REQUIRES 0274 (_r25_crew_cfg; 0371 moved every crew caller to it) + 0246 + 0252 + 0265 (_r21_cost_lines / _r21_event_money / _vb_event_pnl: the event cost ledger), 0049 + 0110 +
--          0152 + 0198 (_a49_close_blockers), 0239 (business_pnl), 0264 (_pst_allocate), 0282 (_r282_event_closed),
--          0287 (studio_today), 0296 (_r55_purge_allowed), 0184 (_tr184_purge_tables / _tr184_keep_tables).
--
-- In plain words:
--   1  FROZEN P&L AT CLOSE. When an event is closed (any of the three ways: plain close, admin override, approved close
--      request), Helm writes one P&L snapshot: every number of the P&L card, the cost per category and the cost lines,
--      who closed it and when. A snapshot is NEVER changed or deleted. Re-open + close again writes version 2 with what
--      changed ("+4,000 vendor bill"). A snapshot problem never blocks the close: it is logged and an admin can tap
--      "Freeze now". Closed events show their frozen numbers everywhere (Business, Settlement, Closure profit) - studio
--      setting, on by default; cash columns (vendor bills paid / due) stay live because paying after closing is allowed.
--      Events closed before this release are NOT back-filled: they say "not frozen" (an admin may freeze one by hand).
--   2  CORRECTIONS ARE NEW ROWS. money_corrections: a + or - amount in a cost category with a reason (and the row it fixes).
--      It counts in the ledger and the P&L. On a closed event the default is "re-open first" (as today); the studio can let
--      admins add a "late adjustment" instead, which writes the next snapshot version at once.
--   3  WAGES = day rate x days + overtime + allowance, with one-tap "Confirm attendance". crew_wage_confirmations: one new
--      row per person per confirmation (the newest wins; a fix is a new row). The suggestion comes from the crew link
--      check-ins / check-outs (crew_checkins, 0265) and the arrival roster. Studio settings, all OFF by default so the numbers
--      stay as they are: half day (off = a part day is paid as a full day), overtime (off; when on 1.5 x hourly or a
--      fixed rate per hour, after the standard day hours), allowance (off). Hourly-paid crew: hours x hourly rate.
--   4  CLIENT TDS. client_tds: TDS a corporate client deducted (amount, section e.g. 194C). It counts as settled for the
--      close gate (so the closing checklist and the payment schedule "outstanding" follow), it covers the last payment of
--      the schedule (no reminder chases the 2%), and it is "TDS receivable" until Form 16A is ticked
--      (client_tds_certificates). It never changes profit. A wrong TDS row is reversed by a new minus row.
--   5  BIG-GAP FLAGS + UNPLANNED. Each cost category more than X% or more than Rs Y over the plan is flagged (studio
--      setting, default 10% / 10,000 - the numbers the screens use today). A cost line with no estimate added on or after
--      the event day (studio time zone) is tagged "Unplanned".
--   6  CANCELLED EVENTS in the monthly profit (studio setting, OFF by default): revenue = money kept (payments - refunds)
--      without its GST, cost = money already paid to vendors + approved / paid staff claims + corrections.
--   7  GST AND TDS BY MONTH for the Business page: GST collected - GST on refunds - input credit = GST to pay (by event
--      month), client TDS deducted / Form 16A pending (by date recorded), TDS on vendor invoices (information only).
-- ACCESS: every read needs Finance view; writes need Finance edit; settings need Settings (controls) edit; monthly tax needs
--   the Business area; per-person wages (also inside a snapshot) stay admin-only. Crew links never call any of this.
-- ZERO DATA LOSS: 6 new tables (insert-only: no update ever, delete only by the free-trial purge; RLS on, no grants -
--   functions only; studio read-only lock; event / studio match); 6 functions wrapped ONCE with the old bodies kept as
--   __pre0372 (_r21_cost_lines, _r21_event_money, _vb_event_pnl, _a49_close_blockers, _pst_allocate, business_pnl);
--   one AFTER trigger on event_closure. No existing row, column, policy or trigger is changed or dropped.
-- ROLLBACK (manual, only if ever needed; no data involved): drop trigger zzz_r372_close_snapshot on public.event_closure;
--   for each wrapped f: drop function public.f(...); alter function public.f__pre0372(...) rename to f; (the new tables can
--   stay - nothing reads them then).

-- ---- 0) preflight -------------------------------------------------------------------------------------------------------------
do $$ begin
  if to_regprocedure('public._r21_cost_lines(uuid,uuid)') is null or to_regprocedure('public._r21_event_money(uuid,uuid,boolean)') is null
     or to_regprocedure('public._vb_event_pnl(uuid,uuid)') is null or to_regprocedure('public._vb_event_pnl__pre0246(uuid,uuid)') is null then
    raise exception 'STOP 0372: apply 0246 (the event cost ledger) first'; end if;
  if to_regprocedure('public._r25_crew_cfg(uuid)') is null or to_regclass('public.crew_checkins') is null then
    raise exception 'STOP 0372: apply 0265 (crew check-ins) and 0274 (_r25_crew_cfg) first'; end if;
  if to_regprocedure('public._a49_close_blockers(uuid)') is null then raise exception 'STOP 0372: apply 0198 first'; end if;
  if to_regprocedure('public.business_pnl(date,date)') is null or to_regprocedure('public.business_pnl__pre0239(date,date)') is null then
    raise exception 'STOP 0372: apply 0239 (Business area) first'; end if;
  if to_regprocedure('public._pst_allocate(uuid)') is null then raise exception 'STOP 0372: apply 0264 first'; end if;
  if to_regprocedure('public._r282_event_closed(uuid)') is null then raise exception 'STOP 0372: apply 0282 first'; end if;
  if to_regprocedure('public._r55_purge_allowed(uuid,boolean)') is null then raise exception 'STOP 0372: apply 0296 first'; end if;
  if to_regprocedure('public.has_area(text,text)') is null or to_regprocedure('public.is_admin()') is null
     or to_regprocedure('public.current_org_id()') is null then raise exception 'STOP 0372: has_area / is_admin / current_org_id missing'; end if;
  if to_regclass('public.event_closure') is null or to_regclass('public.quote_payments') is null or to_regclass('public.payment_milestones') is null then
    raise exception 'STOP 0372: event_closure / quote_payments / payment_milestones missing'; end if;
end $$;

-- ---- 1) tables -----------------------------------------------------------------------------------------------------------------
-- studio money rules (one row per studio; no row = every default below)
create table if not exists public.money_settings (
  org_id            uuid primary key references public.organizations(id) on delete cascade,
  ot_enabled        boolean not null default false,
  ot_mode           text not null default 'multiplier' check (ot_mode in ('multiplier', 'per_hour')),
  ot_multiplier     numeric not null default 1.5 check (ot_multiplier >= 1 and ot_multiplier <= 5),
  ot_rate           numeric check (ot_rate is null or (ot_rate >= 0 and ot_rate < 10000000)),
  std_hours         numeric check (std_hours is null or (std_hours >= 1 and std_hours <= 24)),
  half_day          boolean not null default false,
  allowance_enabled boolean not null default false,
  allowance_default numeric not null default 0 check (allowance_default >= 0 and allowance_default < 1000000),
  tds_enabled       boolean not null default true,
  tds_rate          numeric not null default 2 check (tds_rate >= 0 and tds_rate <= 30),
  tds_section       text not null default '194C' check (tds_section ~ '^19[0-9][A-Z]{0,3}$'),
  cancelled_in_pnl  boolean not null default false,
  gap_pct           numeric not null default 10 check (gap_pct >= 0 and gap_pct <= 1000),
  gap_abs           numeric not null default 10000 check (gap_abs >= 0 and gap_abs < 1000000000),
  unplanned_tag     boolean not null default true,
  late_adjust       text not null default 'reopen' check (late_adjust in ('reopen', 'admin')),
  freeze_closed     boolean not null default true,
  updated_at        timestamptz not null default now(),
  updated_by        uuid
);

-- the frozen P&L, one row per close (never changed)
create table if not exists public.event_pnl_snapshots (
  id           uuid primary key default gen_random_uuid(),
  org_id       uuid not null references public.organizations(id) on delete cascade,
  quote_id     uuid not null references public.quotes(id) on delete cascade,
  version      integer not null check (version >= 1),
  reason       text not null check (reason in ('close', 'late_adjustment', 'manual_freeze')),
  closed_at    timestamptz,
  pnl          jsonb not null check (jsonb_typeof(pnl) = 'object'),
  money        jsonb not null default '{}'::jsonb check (jsonb_typeof(money) = 'object'),
  diff         jsonb not null default '{}'::jsonb check (jsonb_typeof(diff) = 'object'),
  note         text check (note is null or char_length(note) <= 1000),
  signed_by    uuid,
  signed_email text,
  created_at   timestamptz not null default now(),
  constraint event_pnl_snapshots_version_uq unique (quote_id, version)
);
create index if not exists event_pnl_snapshots_org_idx on public.event_pnl_snapshots (org_id);

-- a cost correction: a + or - amount in a category, with a reason (never an edit of the original row)
create table if not exists public.money_corrections (
  id          uuid primary key default gen_random_uuid(),
  org_id      uuid not null references public.organizations(id) on delete cascade,
  quote_id    uuid not null references public.quotes(id) on delete cascade,
  category    text not null check (category in ('venue', 'food', 'decor', 'rentals', 'vendors', 'staff', 'misc', 'logistics', 'damages', 'changes')),
  amount      numeric not null check (amount <> 0 and abs(amount) < 10000000000),
  reason      text not null check (char_length(btrim(reason)) between 5 and 500),
  target_kind text check (target_kind is null or target_kind in ('bill', 'booking', 'cost_line', 'claim', 'crew', 'writeoff', 'change', 'other')),
  target_id   uuid,
  after_close boolean not null default false,
  created_by  uuid,
  created_email text,
  created_at  timestamptz not null default now()
);
create index if not exists money_corrections_quote_idx on public.money_corrections (quote_id, created_at);
create index if not exists money_corrections_org_idx on public.money_corrections (org_id);

-- "Confirm attendance": days worked (1, 0.5, 2.5 ...), hours (hourly pay), overtime hours, allowance. Newest row wins.
create table if not exists public.crew_wage_confirmations (
  id           uuid primary key default gen_random_uuid(),
  seq          bigint generated always as identity,
  org_id       uuid not null references public.organizations(id) on delete cascade,
  quote_id     uuid not null references public.quotes(id) on delete cascade,
  crew_id      uuid not null references public.crew_members(id),
  days         numeric not null check (days >= 0 and days <= 60),
  hours        numeric check (hours is null or (hours >= 0 and hours <= 1000)),
  ot_hours     numeric not null default 0 check (ot_hours >= 0 and ot_hours <= 300),
  allowance    numeric not null default 0 check (allowance >= 0 and allowance < 1000000),
  note         text check (note is null or char_length(note) <= 300),
  suggested    jsonb not null default '{}'::jsonb check (jsonb_typeof(suggested) = 'object'),
  confirmed_by uuid,
  confirmed_email text,
  confirmed_at timestamptz not null default now()
);
create index if not exists crew_wage_confirmations_quote_idx on public.crew_wage_confirmations (quote_id, crew_id, seq desc);
create index if not exists crew_wage_confirmations_org_idx on public.crew_wage_confirmations (org_id);
create index if not exists crew_wage_confirmations_crew_idx on public.crew_wage_confirmations (crew_id);

-- TDS the client deducted (a minus row reverses one)
create table if not exists public.client_tds (
  id          uuid primary key default gen_random_uuid(),
  org_id      uuid not null references public.organizations(id) on delete cascade,
  quote_id    uuid not null references public.quotes(id) on delete cascade,
  amount      numeric not null check (amount <> 0 and abs(amount) < 10000000000),
  section     text check (section is null or section ~ '^19[0-9][A-Z]{0,3}$'),
  rate        numeric check (rate is null or (rate >= 0 and rate <= 30)),
  payment_id  uuid,
  note        text check (note is null or char_length(note) <= 300),
  corrects_id uuid references public.client_tds(id),
  created_by  uuid,
  created_email text,
  created_at  timestamptz not null default now(),
  check ((amount > 0 and corrects_id is null) or (amount < 0 and corrects_id is not null))
);
create unique index if not exists client_tds_one_reversal_uq on public.client_tds (corrects_id) where corrects_id is not null;
create index if not exists client_tds_quote_idx on public.client_tds (quote_id, created_at);
create index if not exists client_tds_org_idx on public.client_tds (org_id);

-- "Form 16A received" for one TDS row
create table if not exists public.client_tds_certificates (
  id          uuid primary key default gen_random_uuid(),
  org_id      uuid not null references public.organizations(id) on delete cascade,
  quote_id    uuid not null references public.quotes(id) on delete cascade,
  tds_id      uuid not null references public.client_tds(id),
  received_on date not null,
  note        text check (note is null or char_length(note) <= 300),
  created_by  uuid,
  created_email text,
  created_at  timestamptz not null default now(),
  constraint client_tds_certificates_one_uq unique (tds_id)
);
create index if not exists client_tds_certificates_org_idx on public.client_tds_certificates (org_id);
create index if not exists client_tds_certificates_quote_idx on public.client_tds_certificates (quote_id);

-- closed to the app (functions only), RLS on
do $$ declare t text; begin
  foreach t in array array['money_settings', 'event_pnl_snapshots', 'money_corrections', 'crew_wage_confirmations', 'client_tds', 'client_tds_certificates'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on table public.%I from public', t);
    if exists (select 1 from pg_roles where rolname = 'anon') then execute format('revoke all on table public.%I from anon', t); end if;
    if exists (select 1 from pg_roles where rolname = 'authenticated') then execute format('revoke all on table public.%I from authenticated', t); end if;
  end loop;
end $$;

-- money rows are kept for good: no update; delete only by the free-trial purge / sample clear-out (0296 marks)
create or replace function public._r372_tg_keep()
returns trigger language plpgsql set search_path = '' as $$
-- r189-money-0372
begin
  if tg_op = 'DELETE' and public._r55_purge_allowed(old.org_id) then return old; end if;
  raise exception 'Money records are kept for good and can''t be changed or deleted. Add a correction instead.'
    using errcode = '42501', hint = 'r189_keep', detail = 'table ' || tg_table_name;
end $$;
revoke all on function public._r372_tg_keep() from public;

do $$ declare t text; begin
  foreach t in array array['event_pnl_snapshots', 'money_corrections', 'crew_wage_confirmations', 'client_tds', 'client_tds_certificates'] loop
    if not exists (select 1 from pg_trigger where tgrelid = ('public.' || t)::regclass and tgname = 'aa_r372_keep') then
      execute format('create trigger aa_r372_keep before update or delete on public.%I for each row execute function public._r372_tg_keep()', t);
    end if;
    if to_regprocedure('public.tg_quote_org_match()') is not null
       and not exists (select 1 from pg_trigger where tgrelid = ('public.' || t)::regclass and tgname = 'zz_quote_org_match') then
      execute format('create trigger zz_quote_org_match before insert or update on public.%I for each row execute function public.tg_quote_org_match()', t);
    end if;
  end loop;
  foreach t in array array['money_settings', 'event_pnl_snapshots', 'money_corrections', 'crew_wage_confirmations', 'client_tds', 'client_tds_certificates'] loop
    if to_regprocedure('public.tg_studio_read_only()') is not null
       and not exists (select 1 from pg_trigger where tgrelid = ('public.' || t)::regclass and tgname = 'zzz_studio_read_only') then
      execute format('create trigger zzz_studio_read_only before insert or update or delete on public.%I for each row execute function public.tg_studio_read_only(''org_id'')', t);
    end if;
  end loop;
end $$;

-- ---- 2) settings ---------------------------------------------------------------------------------------------------------------
create or replace function public._r372_cfg(p_org uuid)
returns jsonb language sql stable security definer set search_path = '' as $$
  -- r189-money-0372: the money rules of a studio, every default when it never saved them
  select jsonb_build_object(
    'ot_enabled', coalesce(s.ot_enabled, false), 'ot_mode', coalesce(s.ot_mode, 'multiplier'),
    'ot_multiplier', coalesce(s.ot_multiplier, 1.5), 'ot_rate', s.ot_rate,
    'std_hours', coalesce(s.std_hours, nullif((public._r25_crew_cfg(p_org) ->> 'dayHours')::numeric, 0), 8), 'std_hours_set', s.std_hours,
    'half_day', coalesce(s.half_day, false),
    'allowance_enabled', coalesce(s.allowance_enabled, false), 'allowance_default', coalesce(s.allowance_default, 0),
    'tds_enabled', coalesce(s.tds_enabled, true), 'tds_rate', coalesce(s.tds_rate, 2), 'tds_section', coalesce(s.tds_section, '194C'),
    'cancelled_in_pnl', coalesce(s.cancelled_in_pnl, false),
    'gap_pct', coalesce(s.gap_pct, 10), 'gap_abs', coalesce(s.gap_abs, 10000),
    'unplanned_tag', coalesce(s.unplanned_tag, true), 'late_adjust', coalesce(s.late_adjust, 'reopen'),
    'freeze_closed', coalesce(s.freeze_closed, true), 'saved', s.org_id is not null, 'updated_at', s.updated_at)
  from (select 1) one left join public.money_settings s on s.org_id = p_org;
$$;

create or replace function public._r372_tz(p_org uuid)
returns text language plpgsql stable security definer set search_path = '' as $$
-- r189-money-0372
declare v text;
begin
  select coalesce(nullif(btrim(o.timezone), ''), 'Asia/Kolkata') into v from public.organizations o where o.id = p_org;
  begin perform now() at time zone coalesce(v, 'Asia/Kolkata'); exception when others then v := 'Asia/Kolkata'; end;
  return coalesce(v, 'Asia/Kolkata');
end $$;

create or replace function public._r372_who()
returns text language sql stable security definer set search_path = '' as $$
  -- r189-money-0372
  select u.email::text from auth.users u where u.id = auth.uid();
$$;

create or replace function public.money_settings_get()
returns jsonb language plpgsql stable security definer set search_path = '' as $$
-- r189-money-0372: Finance or Settings view
declare v_org uuid := public.current_org_id();
begin
  if auth.uid() is null or v_org is null or not (public.has_area('finance', 'view') or public.has_area('controls', 'view')) then
    raise exception 'not authorized' using errcode = '42501'; end if;
  return public._r372_cfg(v_org) || jsonb_build_object('can_edit', public.has_area('controls', 'edit'),
    'defaults', jsonb_build_object('ot_enabled', false, 'ot_mode', 'multiplier', 'ot_multiplier', 1.5, 'half_day', false,
      'allowance_enabled', false, 'allowance_default', 0, 'tds_enabled', true, 'tds_rate', 2, 'tds_section', '194C',
      'cancelled_in_pnl', false, 'gap_pct', 10, 'gap_abs', 10000, 'unplanned_tag', true, 'late_adjust', 'reopen', 'freeze_closed', true));
end $$;

create or replace function public.money_settings_set(p jsonb)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
-- r189-money-0372: Settings edit; only the keys given change; every change is in the audit log
declare v_org uuid := public.current_org_id(); v_old jsonb; v jsonb; k text;
  b_keys text[] := array['ot_enabled', 'half_day', 'allowance_enabled', 'tds_enabled', 'cancelled_in_pnl', 'unplanned_tag', 'freeze_closed'];
  n_keys text[] := array['ot_multiplier', 'allowance_default', 'tds_rate', 'gap_pct', 'gap_abs'];
  nn_keys text[] := array['ot_rate', 'std_hours'];
  t_keys text[] := array['ot_mode', 'tds_section', 'late_adjust'];
begin
  if auth.uid() is null or v_org is null or coalesce(public.user_role(), '') = 'client' or not public.has_area('controls', 'edit') then
    raise exception 'Only a studio admin (or someone allowed to edit Settings) can change the money rules.' using errcode = '42501'; end if;
  if p is null or jsonb_typeof(p) <> 'object' then raise exception 'settings must be an object' using errcode = '22023'; end if;
  for k in select jsonb_object_keys(p) loop
    if k = any(b_keys) then
      if jsonb_typeof(p -> k) <> 'boolean' then raise exception '% must be true or false', k using errcode = '22023'; end if;
    elsif k = any(n_keys) then
      if jsonb_typeof(p -> k) <> 'number' then raise exception '% must be a number', k using errcode = '22023'; end if;
    elsif k = any(nn_keys) then
      if jsonb_typeof(p -> k) not in ('number', 'null') then raise exception '% must be a number or empty', k using errcode = '22023'; end if;
    elsif k = any(t_keys) then
      if jsonb_typeof(p -> k) <> 'string' then raise exception '% must be text', k using errcode = '22023'; end if;
    else raise exception 'unknown setting %', k using errcode = '22023'; end if;
  end loop;
  perform pg_advisory_xact_lock(hashtextextended('helm:money_settings:' || v_org::text, 0));
  v_old := public._r372_cfg(v_org);
  v := v_old || p;
  if p ? 'tds_section' then v := v || jsonb_build_object('tds_section', upper(btrim(p ->> 'tds_section'))); end if;
  if not (p ? 'std_hours') then v := v || jsonb_build_object('std_hours', v_old -> 'std_hours_set'); end if;
  begin
    insert into public.money_settings as s (org_id, ot_enabled, ot_mode, ot_multiplier, ot_rate, std_hours, half_day, allowance_enabled,
        allowance_default, tds_enabled, tds_rate, tds_section, cancelled_in_pnl, gap_pct, gap_abs, unplanned_tag, late_adjust,
        freeze_closed, updated_at, updated_by)
    values (v_org, (v ->> 'ot_enabled')::boolean, v ->> 'ot_mode', round((v ->> 'ot_multiplier')::numeric, 2),
        round((v ->> 'ot_rate')::numeric, 2), round((v ->> 'std_hours')::numeric, 2), (v ->> 'half_day')::boolean,
        (v ->> 'allowance_enabled')::boolean, round((v ->> 'allowance_default')::numeric, 2), (v ->> 'tds_enabled')::boolean,
        round((v ->> 'tds_rate')::numeric, 2), v ->> 'tds_section', (v ->> 'cancelled_in_pnl')::boolean,
        round((v ->> 'gap_pct')::numeric, 1), round((v ->> 'gap_abs')::numeric, 2), (v ->> 'unplanned_tag')::boolean,
        v ->> 'late_adjust', (v ->> 'freeze_closed')::boolean, now(), auth.uid())
    on conflict (org_id) do update set ot_enabled = excluded.ot_enabled, ot_mode = excluded.ot_mode, ot_multiplier = excluded.ot_multiplier,
        ot_rate = excluded.ot_rate, std_hours = excluded.std_hours, half_day = excluded.half_day, allowance_enabled = excluded.allowance_enabled,
        allowance_default = excluded.allowance_default, tds_enabled = excluded.tds_enabled, tds_rate = excluded.tds_rate,
        tds_section = excluded.tds_section, cancelled_in_pnl = excluded.cancelled_in_pnl, gap_pct = excluded.gap_pct, gap_abs = excluded.gap_abs,
        unplanned_tag = excluded.unplanned_tag, late_adjust = excluded.late_adjust, freeze_closed = excluded.freeze_closed,
        updated_at = now(), updated_by = auth.uid();
  exception when check_violation or not_null_violation or invalid_text_representation then
    raise exception 'A money rule is out of range (overtime 1 to 5 x, standard day 1 to 24 hours, TDS 0 to 30%%, TDS section like 194C).'
      using errcode = '22023';
  end;
  begin
    insert into public.audit_log(actor, action, entity, entity_id, changed, org_id)
      values (auth.uid(), 'money_settings.changed', 'money_settings', v_org::text,
              jsonb_build_object('from', v_old - 'updated_at' - 'saved', 'set', p), v_org);
  exception when others then raise warning 'r189-0372: audit skipped (%)', sqlstate;
  end;
  return public.money_settings_get();
end $$;

-- ---- 3) wages: one confirmed person on one event ---------------------------------------------------------------------------
-- p_line = the ledger crew line (day_rate, pay_basis, shift_wage, hours); p_days / p_hours / p_ot / p_allow = the confirmation.
-- Returns the line keys to change (actual, c_act, c_fc, attendance, confirmed, wage_detail, note).
create or replace function public._r372_wage(p_line jsonb, p_days numeric, p_hours numeric, p_ot numeric, p_allow numeric, p_cfg jsonb, p_day_h numeric)
returns jsonb language plpgsql immutable set search_path = '' as $$
-- r189-money-0372
declare v_rate numeric := coalesce((p_line ->> 'day_rate')::numeric, 0); v_basis text := coalesce(p_line ->> 'pay_basis', 'day');
  v_hourly numeric; v_units numeric; v_std numeric; v_otr numeric := 0; v_ot numeric := 0; v_allow numeric := 0; v_base numeric; v_wage numeric;
  v_hours numeric; v_day_h numeric := coalesce(nullif(p_day_h, 0), 8);
begin
  v_std := coalesce(nullif((p_cfg ->> 'std_hours')::numeric, 0), v_day_h);
  if coalesce((p_cfg ->> 'allowance_enabled')::boolean, false) then v_allow := round(coalesce(p_allow, 0), 2); end if;
  if v_basis = 'hours' then
    v_hourly := case when (p_line ->> 'shift_wage') is not null then (p_line ->> 'shift_wage')::numeric
                     when v_rate > 0 then round(v_rate / v_day_h, 2) else 0 end;
    v_hours := coalesce(p_hours, (p_line ->> 'hours')::numeric, case when coalesce(p_days, 0) > 0 then p_days * v_day_h else 0 end);
    v_base := round(v_hourly * v_hours, 2);
    v_units := null;
  else
    v_units := case when coalesce((p_cfg ->> 'half_day')::boolean, false) then coalesce(p_days, 0) else ceil(coalesce(p_days, 0)) end;
    v_base := round(v_rate * v_units, 2);
    if coalesce((p_cfg ->> 'ot_enabled')::boolean, false) and coalesce(p_ot, 0) > 0 then
      v_otr := case when p_cfg ->> 'ot_mode' = 'per_hour' then coalesce((p_cfg ->> 'ot_rate')::numeric, 0)
                    else round(v_rate / v_std * coalesce((p_cfg ->> 'ot_multiplier')::numeric, 1.5), 2) end;
      v_ot := round(p_ot * v_otr, 2);
    end if;
  end if;
  v_wage := v_base + v_ot + v_allow;
  return jsonb_build_object('actual', v_wage, 'c_act', v_wage, 'c_fc', v_wage,
    'attendance', case when coalesce(p_days, 0) > 0 or coalesce(v_hours, 0) > 0 then 'arrived' else 'no_show' end,
    'confirmed', true,
    'wage_detail', jsonb_build_object('basis', v_basis, 'days', p_days, 'paid_days', v_units, 'hours', v_hours, 'base', v_base,
                                      'ot_hours', case when v_ot > 0 then p_ot else 0 end, 'ot_rate', v_otr, 'ot_amount', v_ot, 'allowance', v_allow),
    'note', 'attendance confirmed: ' || case when v_basis = 'hours' then to_char(coalesce(v_hours, 0), 'FM9990.0') || ' h'
                                             else trim(to_char(coalesce(p_days, 0), 'FM990.##')) || ' day' || case when coalesce(p_days, 0) = 1 then '' else 's' end end
            || case when v_ot > 0 then ' + ' || trim(to_char(p_ot, 'FM990.##')) || ' h overtime' else '' end
            || case when v_allow > 0 then ' + allowance' else '' end);
end $$;

-- the suggestion for one person, from the crew link check-ins / check-outs and the arrival roster
create or replace function public._r372_suggest(p_quote uuid, p_org uuid, p_crew uuid, p_cfg jsonb)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
-- r189-money-0372
declare v_std numeric := coalesce(nullif((p_cfg ->> 'std_hours')::numeric, 0), 8); r record; v_days numeric := 0; v_ot numeric := 0;
  v_hours numeric := 0; v_n int := 0; v_open int := 0; v_roster text; v_src text;
begin
  for r in select k.work_day, k.check_in_at, k.check_out_at,
                  case when k.check_out_at is not null then extract(epoch from (k.check_out_at - k.check_in_at)) / 3600.0 end as h
             from public.crew_checkins k where k.quote_id = p_quote and k.org_id = p_org and k.crew_id = p_crew and k.check_in_at is not null loop
    v_n := v_n + 1;
    if r.h is null then v_open := v_open + 1; v_days := v_days + 1;
    else
      v_hours := v_hours + r.h;
      v_days := v_days + case when coalesce((p_cfg ->> 'half_day')::boolean, false) and r.h > 0 and r.h <= v_std / 2 then 0.5 else 1 end;
      if coalesce((p_cfg ->> 'ot_enabled')::boolean, false) and r.h > v_std then v_ot := v_ot + floor((r.h - v_std) * 2) / 2; end if;
    end if;
  end loop;
  select case when bool_or(d.status in ('arrived', 'left')) then 'arrived' when bool_or(d.status = 'no_show') then 'no_show' end
    into v_roster from public.event_day d where d.quote_id = p_quote and d.org_id = p_org and d.kind = 'arrival' and d.ref_id = p_crew;
  if v_n > 0 then v_src := 'checkin';
  elsif v_roster = 'arrived' then v_src := 'roster'; v_days := 1;
  elsif v_roster = 'no_show' then v_src := 'roster'; v_days := 0;
  else v_src := 'none'; v_days := null; end if;
  return jsonb_build_object('source', v_src, 'days', v_days, 'hours', case when v_n > 0 and v_hours > 0 then round(v_hours, 2) end,
    'ot_hours', v_ot, 'open_checkins', v_open, 'checkin_days', v_n, 'roster', v_roster,
    'allowance', case when coalesce((p_cfg ->> 'allowance_enabled')::boolean, false) and coalesce(v_days, 0) > 0
                      then round(coalesce((p_cfg ->> 'allowance_default')::numeric, 0) * ceil(v_days), 2) else 0 end);
end $$;

-- ---- 4) the ledger: wraps 0246 / 0252 / 0265 once ---------------------------------------------------------------------------
do $$ begin
  if to_regprocedure('public._r21_cost_lines__pre0372(uuid,uuid)') is null then
    alter function public._r21_cost_lines(uuid, uuid) rename to _r21_cost_lines__pre0372;
  end if;
  if to_regprocedure('public._r21_event_money__pre0372(uuid,uuid,boolean)') is null then
    alter function public._r21_event_money(uuid, uuid, boolean) rename to _r21_event_money__pre0372;
  end if;
  if to_regprocedure('public._vb_event_pnl__pre0372(uuid,uuid)') is null then
    alter function public._vb_event_pnl(uuid, uuid) rename to _vb_event_pnl__pre0372;
  end if;
  if to_regprocedure('public._a49_close_blockers__pre0372(uuid)') is null then
    alter function public._a49_close_blockers(uuid) rename to _a49_close_blockers__pre0372;
  end if;
  if to_regprocedure('public._pst_allocate__pre0372(uuid)') is null then
    alter function public._pst_allocate(uuid) rename to _pst_allocate__pre0372;
  end if;
  if to_regprocedure('public.business_pnl__pre0372(date,date)') is null then
    alter function public.business_pnl(date, date) rename to business_pnl__pre0372;
  end if;
end $$;

-- the kept ledger body reads the crew settings like 0371 made every crew caller do (only on a database where this file ran before
-- 0371: same pg_get_functiondef + replace technique, only the reader name changes; nothing else in the body)
do $$ declare v_def text; begin
  v_def := pg_get_functiondef('public._r21_cost_lines__pre0372(uuid,uuid)'::regprocedure);
  if position('public._r23_cfg(' in v_def) > 0 and to_regprocedure('public._r25_crew_cfg(uuid)') is not null then
    execute replace(v_def, 'public._r23_cfg(', 'public._r25_crew_cfg(');
  end if;
end $$;

-- cost lines: the kept body, then confirmed attendance (crew), the Unplanned tag, and the correction lines
create or replace function public._r21_cost_lines(p_quote uuid, p_org uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
-- r189-money-0372: wraps _r21_cost_lines__pre0372 (the r21-money-0246 / r22-money-0252 / r23-crew-0265 ledger body)
-- reads the crew settings through public._r25_crew_cfg( like every crew caller since 0371 (never the shared _r23_cfg)
declare v jsonb; v_out jsonb := '[]'::jsonb; l jsonb; w record; v_cfg jsonb; v_ev date; v_tz text; v_day_h numeric;
  v_at timestamptz; v_src text; v_id uuid; v_corr jsonb;
begin
  v := public._r21_cost_lines__pre0372(p_quote, p_org);
  if v is null then return null; end if;
  v_cfg := public._r372_cfg(p_org);
  v_day_h := coalesce(nullif((public._r25_crew_cfg(p_org) ->> 'dayHours')::numeric, 0), 8);
  select q.event_date into v_ev from public.quotes q where q.id = p_quote;
  v_tz := public._r372_tz(p_org);
  for l in select x from jsonb_array_elements(v) x loop
    v_src := l ->> 'source';
    if v_src = 'crew' and (l ->> 'crew_id') is not null then
      select c.days, c.hours, c.ot_hours, c.allowance, c.confirmed_at into w
        from public.crew_wage_confirmations c
       where c.quote_id = p_quote and c.org_id = p_org and c.crew_id = (l ->> 'crew_id')::uuid
       order by c.seq desc limit 1;
      if found then
        l := l || public._r372_wage(l, w.days, w.hours, w.ot_hours, w.allowance, v_cfg, v_day_h) || jsonb_build_object('confirmed_at', w.confirmed_at);
      end if;
    elsif coalesce((v_cfg ->> 'unplanned_tag')::boolean, true) and v_ev is not null
          and v_src in ('booking', 'bill', 'cost_line', 'vendor_line', 'claim')
          and coalesce((l ->> 'c_est')::numeric, 0) = 0 and coalesce((l ->> 'estimated')::numeric, 0) = 0
          and coalesce((l ->> 'c_fc')::numeric, 0) <> 0 then
      v_id := nullif(l ->> 'source_id', '')::uuid; v_at := null;
      if v_src = 'booking' then select b.created_at into v_at from public.event_resources b where b.id = v_id;
      elsif v_src = 'bill' then select b.created_at into v_at from public.vendor_bills b where b.id = v_id;
      elsif v_src = 'claim' then select e.created_at into v_at from public.expense_claims e where e.id = v_id;
      else select k.created_at into v_at from public.event_costs k where k.id = v_id; end if;
      if v_at is not null and (v_at at time zone v_tz)::date >= v_ev then
        l := l || jsonb_build_object('unplanned', true, 'added_on', (v_at at time zone v_tz)::date);
      end if;
    end if;
    v_out := v_out || jsonb_build_array(l);
  end loop;
  select coalesce(jsonb_agg(jsonb_build_object(
      'key', 'correction:' || c.id, 'source', 'correction', 'source_id', c.id, 'category', c.category,
      'label', 'Correction: ' || left(btrim(c.reason), 140), 'estimated', null, 'committed', null, 'actual', c.amount,
      'c_est', 0, 'c_com', 0, 'c_fc', c.amount, 'c_act', c.amount, 'paid', null,
      'target_kind', c.target_kind, 'target_id', c.target_id, 'after_close', c.after_close, 'created_at', c.created_at,
      'note', case when c.after_close then 'late adjustment after closing' else 'correction' end
              || ' by ' || coalesce(nullif(split_part(coalesce(c.created_email, ''), '@', 1), ''), 'the office')
              || ' on ' || to_char((c.created_at at time zone v_tz)::date, 'FMDD Mon YYYY'))
      order by c.created_at, c.id), '[]'::jsonb)
    into v_corr
    from public.money_corrections c where c.quote_id = p_quote and c.org_id = p_org;
  return v_out || v_corr;
end $$;

-- big-gap flag for one category (same rule as the screens: over = more than X% OR more than Y; else watch; no plan = new)
create or replace function public._r372_flag(p_est numeric, p_var numeric, p_cfg jsonb)
returns text language sql immutable set search_path = '' as $$
  -- r189-money-0372
  select case when coalesce(p_var, 0) < -0.005 then 'under'
              when coalesce(p_var, 0) <= 0.005 then ''
              when coalesce(p_est, 0) <= 0 then case when p_var > coalesce((p_cfg ->> 'gap_abs')::numeric, 10000) then 'over' else 'new' end
              when p_var / p_est * 100 > coalesce((p_cfg ->> 'gap_pct')::numeric, 10) or p_var > coalesce((p_cfg ->> 'gap_abs')::numeric, 10000) then 'over'
              else 'watch' end;
$$;

create or replace function public._r21_event_money(p_quote uuid, p_org uuid, p_lines boolean)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
-- r189-money-0372: wraps _r21_event_money__pre0372 (r21-money-0246 / 0287 body) + corrections in cost_other, big-gap flags,
-- Unplanned totals, attendance confirmed counts, client TDS (not profit)
declare m jsonb; v_lines jsonb; v_cfg jsonb; v_cats jsonb; v_corr numeric; v_unp numeric; n_unp int; n_crew int; n_conf int; n_over int;
  v_tds numeric; v_cert numeric; v_warn jsonb; v_ev date;
begin
  m := public._r21_event_money__pre0372(p_quote, p_org, true);
  if m is null then return null; end if;
  v_cfg := public._r372_cfg(p_org);
  v_lines := coalesce(m -> 'lines', '[]'::jsonb);
  select coalesce(sum((l ->> 'c_fc')::numeric) filter (where l ->> 'source' = 'correction'), 0),
         coalesce(sum((l ->> 'c_fc')::numeric) filter (where coalesce((l ->> 'unplanned')::boolean, false)), 0),
         count(*) filter (where coalesce((l ->> 'unplanned')::boolean, false)),
         count(*) filter (where l ->> 'source' = 'crew'),
         count(*) filter (where l ->> 'source' = 'crew' and coalesce((l ->> 'confirmed')::boolean, false))
    into v_corr, v_unp, n_unp, n_crew, n_conf
    from jsonb_array_elements(v_lines) l;
  select coalesce(jsonb_agg(c || jsonb_build_object('flag', case when c ->> 'key' = 'contingency' then ''
            else public._r372_flag((c ->> 'estimated')::numeric, (c ->> 'variance')::numeric, v_cfg) end,
            'unplanned', coalesce((select sum((l ->> 'c_fc')::numeric) from jsonb_array_elements(v_lines) l
                                    where l ->> 'category' = c ->> 'key' and coalesce((l ->> 'unplanned')::boolean, false)), 0))), '[]'::jsonb)
    into v_cats from jsonb_array_elements(coalesce(m -> 'by_category', '[]'::jsonb)) c;
  n_over := (select count(*) from jsonb_array_elements(v_cats) c where c ->> 'flag' = 'over');
  select coalesce(sum(t.amount), 0) into v_tds from public.client_tds t where t.quote_id = p_quote and t.org_id = p_org;
  select coalesce(sum(t.amount), 0) into v_cert from public.client_tds t
   where t.quote_id = p_quote and t.org_id = p_org and t.amount > 0
     and exists (select 1 from public.client_tds_certificates x where x.tds_id = t.id)
     and not exists (select 1 from public.client_tds r where r.corrects_id = t.id);
  v_warn := coalesce(m -> 'warnings', '[]'::jsonb);
  if n_over > 0 then v_warn := v_warn || jsonb_build_array(jsonb_build_object('code', 'big_gap', 'count', n_over,
    'text', n_over || ' cost categor' || case when n_over = 1 then 'y is' else 'ies are' end || ' well over the plan (more than '
            || trim(to_char((v_cfg ->> 'gap_pct')::numeric, 'FM9990.#')) || '% or more than ' || trim(to_char((v_cfg ->> 'gap_abs')::numeric, 'FM999999999990'))
            || '). Add a note on why, or a correction if a number is wrong.')); end if;
  if n_unp > 0 then v_warn := v_warn || jsonb_build_array(jsonb_build_object('code', 'unplanned', 'count', n_unp, 'amount', v_unp,
    'text', n_unp || ' cost line(s) were added on or after the event day with no estimate (Unplanned).')); end if;
  select q.event_date into v_ev from public.quotes q where q.id = p_quote;
  if n_crew > n_conf and v_ev is not null and v_ev < public.studio_today(p_org) then
    v_warn := v_warn || jsonb_build_array(jsonb_build_object('code', 'attendance_unconfirmed', 'count', n_crew - n_conf,
      'text', (n_crew - n_conf) || ' crew member(s) have no confirmed attendance yet. Tap "Confirm attendance" so wages are final.')); end if;
  m := m || jsonb_build_object(
    'cost_other', coalesce((m ->> 'cost_other')::numeric, 0) + v_corr,
    'cost_corrections', v_corr, 'by_category', v_cats, 'warnings', v_warn,
    'unplanned_amount', v_unp, 'unplanned_lines', n_unp, 'gap_flags', n_over,
    'crew_people', n_crew, 'crew_confirmed', n_conf,
    'client_tds', v_tds, 'client_tds_certified', v_cert, 'client_tds_pending', greatest(v_tds - v_cert, 0),
    'money_rules', jsonb_build_object('gap_pct', v_cfg -> 'gap_pct', 'gap_abs', v_cfg -> 'gap_abs', 'ot_enabled', v_cfg -> 'ot_enabled',
      'half_day', v_cfg -> 'half_day', 'allowance_enabled', v_cfg -> 'allowance_enabled', 'unplanned_tag', v_cfg -> 'unplanned_tag'));
  if not p_lines then m := m - 'lines'; end if;
  return m;
end $$;

-- ---- 5) the snapshot -----------------------------------------------------------------------------------------------------------
-- the numbers compared between two versions
create or replace function public._r372_diff(p_old public.event_pnl_snapshots, p_pnl jsonb, p_money jsonb)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
-- r189-money-0372
declare v_cats jsonb; d jsonb; v_reopen text; v_corr jsonb;
begin
  if p_old.id is null then return '{}'::jsonb; end if;
  select coalesce(jsonb_agg(jsonb_build_object('key', k, 'from', a, 'to', b, 'change', b - a) order by k), '[]'::jsonb) into v_cats
    from (select coalesce(n.key, o.key) as k, coalesce((o.value ->> 'expected')::numeric, 0) as a, coalesce((n.value ->> 'expected')::numeric, 0) as b
            from (select c ->> 'key' as key, c as value from jsonb_array_elements(coalesce(p_money -> 'by_category', '[]'::jsonb)) c) n
            full join (select c ->> 'key' as key, c as value from jsonb_array_elements(coalesce(p_old.money -> 'by_category', '[]'::jsonb)) c) o
              on o.key = n.key) x
   where abs(b - a) > 0.005;
  select a.changed ->> 'reason' into v_reopen from public.audit_log a
   where a.quote_id = p_old.quote_id and a.action = 'event_reopen' and a.at >= p_old.created_at order by a.at desc limit 1;
  -- the corrections in this version that the previous one did not have (by id, so timing never matters)
  select coalesce(jsonb_agg(jsonb_build_object('category', l ->> 'category', 'amount', (l ->> 'actual')::numeric, 'reason', l ->> 'label',
           'at', l ->> 'created_at') order by l ->> 'created_at'), '[]'::jsonb)
    into v_corr from jsonb_array_elements(coalesce(p_money -> 'lines', '[]'::jsonb)) l
   where l ->> 'source' = 'correction'
     and not exists (select 1 from jsonb_array_elements(coalesce(p_old.money -> 'lines', '[]'::jsonb)) o
                      where o ->> 'source' = 'correction' and o ->> 'source_id' = l ->> 'source_id');
  d := jsonb_build_object('from_version', p_old.version,
    'net_profit', jsonb_build_object('from', p_old.pnl -> 'net_profit', 'to', p_pnl -> 'net_profit',
                                     'change', coalesce((p_pnl ->> 'net_profit')::numeric, 0) - coalesce((p_old.pnl ->> 'net_profit')::numeric, 0)),
    'revenue', jsonb_build_object('from', p_old.pnl -> 'revenue', 'to', p_pnl -> 'revenue',
                                  'change', coalesce((p_pnl ->> 'revenue')::numeric, 0) - coalesce((p_old.pnl ->> 'revenue')::numeric, 0)),
    'categories', v_cats, 'corrections', v_corr, 'reopen_reason', v_reopen);
  return d;
end $$;

create or replace function public._r372_snapshot(p_quote uuid, p_org uuid, p_reason text, p_note text)
returns integer language plpgsql volatile security definer set search_path = '' as $$
-- r189-money-0372: writes the next version (internal; callers check access)
declare v_pnl jsonb; v_money jsonb; v_prev public.event_pnl_snapshots; v_ver integer; v_closed timestamptz;
begin
  perform pg_advisory_xact_lock(hashtextextended('helm:pnl:' || p_quote::text, 0));
  if not exists (select 1 from public.quotes q where q.id = p_quote and q.org_id = p_org) then return null; end if;
  select c.closed_at into v_closed from public.event_closure c where c.quote_id = p_quote;
  v_pnl := public._vb_event_pnl__pre0372(p_quote, p_org);
  if v_pnl is null then return null; end if;
  v_money := coalesce(public._r21_event_money(p_quote, p_org, true), '{}'::jsonb);
  select * into v_prev from public.event_pnl_snapshots s where s.quote_id = p_quote order by s.version desc limit 1;
  v_ver := coalesce(v_prev.version, 0) + 1;
  insert into public.event_pnl_snapshots(org_id, quote_id, version, reason, closed_at, pnl, money, diff, note, signed_by, signed_email)
    values (p_org, p_quote, v_ver, p_reason, v_closed, v_pnl, v_money, public._r372_diff(v_prev, v_pnl, v_money),
            left(nullif(btrim(coalesce(p_note, '')), ''), 1000), auth.uid(), public._r372_who());
  insert into public.audit_log(actor, actor_email, action, entity, entity_id, quote_id, changed, org_id)
    values (auth.uid(), public._r372_who(), 'pnl_frozen', 'event_pnl_snapshots', p_quote::text, p_quote,
            jsonb_build_object('version', v_ver, 'reason', p_reason, 'net_profit', v_pnl -> 'net_profit'), p_org);
  return v_ver;
end $$;

-- every close (plain, override, approved close request) freezes the P&L; never blocks the close
create or replace function public._r372_tg_close_snapshot()
returns trigger language plpgsql security definer set search_path = '' as $$
-- r189-money-0372
declare v_org uuid;
begin
  if new.closed_at is null then return null; end if;
  if tg_op = 'UPDATE' and old.closed_at is not null then return null; end if;
  v_org := coalesce(new.org_id, (select q.org_id from public.quotes q where q.id = new.quote_id));
  begin
    perform public._r372_snapshot(new.quote_id, v_org, 'close', null);
  exception when others then
    raise warning 'r189-0372: P&L snapshot not written (% %)', sqlstate, sqlerrm;
    begin
      insert into public.audit_log(actor, action, entity, entity_id, quote_id, changed, org_id)
        values (auth.uid(), 'pnl_snapshot_failed', 'event_pnl_snapshots', new.quote_id::text, new.quote_id,
                jsonb_build_object('sqlstate', sqlstate), v_org);
    exception when others then null;
    end;
  end;
  return null;
end $$;
drop trigger if exists zzz_r372_close_snapshot on public.event_closure;
create trigger zzz_r372_close_snapshot after insert or update of closed_at on public.event_closure
  for each row execute function public._r372_tg_close_snapshot();

-- the snapshot that belongs to the CURRENT close (null = open, or closed without a snapshot)
create or replace function public._r372_current_snapshot(p_quote uuid)
returns public.event_pnl_snapshots language sql stable security definer set search_path = '' as $$
  -- r189-money-0372
  select s.* from public.event_pnl_snapshots s join public.event_closure c on c.quote_id = s.quote_id
   where s.quote_id = p_quote and c.closed_at is not null and s.closed_at = c.closed_at
   order by s.version desc limit 1;
$$;

-- _vb_event_pnl: closed + frozen -> the frozen numbers (cash columns live); else the kept body unchanged
create or replace function public._vb_event_pnl(p_quote uuid, p_org uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
-- r189-money-0372: wraps _vb_event_pnl__pre0372 (the r21-money-0246 wrapper)
declare v jsonb; s public.event_pnl_snapshots;
begin
  v := public._vb_event_pnl__pre0372(p_quote, p_org);
  if v is null then return null; end if;
  if not coalesce((public._r372_cfg(p_org) ->> 'freeze_closed')::boolean, true) then return v; end if;
  s := public._r372_current_snapshot(p_quote);
  if s.id is null or s.org_id <> p_org then return v; end if;
  return s.pnl || jsonb_build_object('bills_paid', v -> 'bills_paid', 'bills_due', v -> 'bills_due',
    'frozen', jsonb_build_object('version', s.version, 'at', s.created_at, 'reason', s.reason, 'by', s.signed_email),
    'live_net_profit', v -> 'net_profit');
end $$;

-- ---- 6) client TDS in the close gate and the payment schedule ---------------------------------------------------------------
create or replace function public._r372_tds(p_quote uuid)
returns numeric language sql stable security definer set search_path = '' as $$
  -- r189-money-0372: TDS the client deducted (net of reversals)
  select coalesce(sum(t.amount), 0) from public.client_tds t where t.quote_id = p_quote;
$$;

create or replace function public._a49_close_blockers(p_quote uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
-- r189-money-0372: wraps _a49_close_blockers__pre0372 (0110 / manager-1019-0152 / helm-0198-stages body): TDS the client
-- deducted counts as settled
declare b jsonb; v_tds numeric; v_owed numeric;
begin
  b := public._a49_close_blockers__pre0372(p_quote);
  v_tds := public._r372_tds(p_quote);
  if b is null or v_tds = 0 then return b; end if;
  v_owed := greatest(coalesce((b ->> 'total')::numeric, 0) - coalesce((b ->> 'paid')::numeric, 0) - v_tds, 0);
  if v_owed <= 0.5 then v_owed := 0; end if;
  return b || jsonb_build_object('balance_owed', v_owed, 'client_tds', v_tds, 'balance_before_tds', b -> 'balance_owed',
    'blocked', (v_owed > 0 or coalesce((b ->> 'open_checkouts')::int, 0) > 0 or (b ->> 'not_booked') is not null
                or coalesce((b ->> 'too_early')::boolean, false) or coalesce((b ->> 'no_event_date')::boolean, false)));
end $$;

create or replace function public._pst_allocate(p_quote uuid)
returns integer language plpgsql volatile security definer set search_path = '' as $$
-- r189-money-0372: wraps _pst_allocate__pre0372 (pay-schedule-0264): TDS the client deducted covers payments too
declare v_tds numeric := public._r372_tds(p_quote); v_credit numeric; m record; v_n integer := 0;
begin
  if v_tds <= 0.005 then return public._pst_allocate__pre0372(p_quote); end if;
  perform pg_advisory_xact_lock(hashtextextended('helm:pay:quote:' || p_quote::text, 0));
  select coalesce(sum(qp.amount), 0) into v_credit from public.quote_payments qp where qp.quote_id = p_quote and qp.status = 'paid';
  v_credit := v_credit + v_tds - coalesce((select sum(pm.amount) from public.payment_milestones pm where pm.quote_id = p_quote and pm.status = 'paid'), 0);
  if v_credit <= 0.005 then return 0; end if;
  for m in select pm.id, pm.amount from public.payment_milestones pm
            where pm.quote_id = p_quote and pm.status in ('due', 'invoiced') and coalesce(pm.amount, 0) > 0
            order by pm.due_date nulls last, pm.seq, pm.created_at, pm.id loop
    exit when v_credit + 0.5 < m.amount;
    update public.payment_milestones set status = 'paid', paid_at = now() where id = m.id;
    v_credit := v_credit - m.amount; v_n := v_n + 1;
  end loop;
  return v_n;
end $$;

-- ---- 7) cancelled events in the monthly profit (studio setting, off by default) ----------------------------------------------
create or replace function public._r372_cancelled_row(p_quote uuid, p_org uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
-- r189-money-0372: money kept (payments - processed refunds) without its GST - money already paid out
declare o jsonb; v_paid numeric; v_ref numeric; v_kept numeric; v_ex numeric; v_rev numeric; v_tax numeric; v_cost numeric;
begin
  o := public._vb_event_pnl__pre0246(p_quote, p_org);
  if o is null then return null; end if;
  v_rev := coalesce((o ->> 'revenue')::numeric, 0); v_tax := coalesce((o ->> 'tax')::numeric, 0);
  select coalesce(sum(qp.amount), 0) into v_paid from public.quote_payments qp where qp.quote_id = p_quote and qp.status = 'paid';
  select coalesce(sum(r.amount), 0) into v_ref from public.event_refunds r where r.quote_id = p_quote and r.org_id = p_org and r.kind = 'refund' and r.status = 'processed';
  v_kept := greatest(v_paid - v_ref, 0);
  v_ex := case when v_rev + v_tax > 0 and v_tax > 0 then round(v_kept * v_rev / (v_rev + v_tax), 2) else v_kept end;
  v_cost := coalesce((select sum(p.amount) from public.vendor_payouts p join public.vendor_bills b on b.id = p.bill_id
                       where b.quote_id = p_quote and b.org_id = p_org), 0)
          + coalesce((select sum(r.advance) from public.event_resources r where r.quote_id = p_quote and r.org_id = p_org and coalesce(r.advance, 0) > 0), 0)
          + coalesce((select sum(e.amount) from public.expense_claims e where e.quote_id = p_quote and e.org_id = p_org and e.status in ('approved', 'paid')), 0)
          + coalesce((select sum(c.amount) from public.money_corrections c where c.quote_id = p_quote and c.org_id = p_org), 0);
  return jsonb_build_object('quote_id', o -> 'quote_id', 'code', o -> 'code', 'title', o -> 'title', 'date', o -> 'date', 'currency', o -> 'currency',
    'cancelled', true, 'rules', 'cancelled', 'revenue', v_ex, 'tax', v_kept - v_ex, 'kept', v_kept, 'refunds', v_ref,
    'vendors', v_cost, 'other', 0, 'staff', 0, 'net_profit', v_ex - v_cost,
    'margin_pct', case when v_ex <> 0 then round((v_ex - v_cost) / v_ex * 100) end);
end $$;

create or replace function public.business_pnl(p_from date, p_to date)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
-- r189-money-0372: wraps business_pnl__pre0372 (r20-business-0239); + cancelled events when the studio counts them
declare r jsonb; v_org uuid := public.current_org_id(); x record; e jsonb; v_rows jsonb := '[]'::jsonb; v_from date; v_to date;
begin
  r := public.business_pnl__pre0372(p_from, p_to);
  if r is null or not coalesce((public._r372_cfg(v_org) ->> 'cancelled_in_pnl')::boolean, false) then return r; end if;
  v_from := (r ->> 'from')::date; v_to := (r ->> 'to')::date;
  for x in select q.id from public.quotes q
            where q.org_id = v_org and q.deleted_at is null and q.status = 'cancelled' and not coalesce(q.is_demo, false)
              and q.event_date between v_from and v_to
            order by q.event_date limit 500 loop
    e := public._r372_cancelled_row(x.id, v_org);
    if e is not null and ((e ->> 'kept')::numeric > 0 or (e ->> 'vendors')::numeric > 0) then v_rows := v_rows || jsonb_build_array(e); end if;
  end loop;
  return r || jsonb_build_object('events', coalesce(r -> 'events', '[]'::jsonb) || v_rows, 'cancelled_counted', true, 'cancelled_events', jsonb_array_length(v_rows));
end $$;

-- ---- 8) read + write RPCs for the pages ------------------------------------------------------------------------------------------
-- the money of one event in one place for Closure: frozen versions, live numbers, corrections, what this person may do
create or replace function public.event_pnl_versions(p_quote uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
-- r189-money-0372: Finance view, own studio
declare v_org uuid := public.current_org_id(); v_live jsonb; v_cur public.event_pnl_snapshots; v_closed timestamptz; v_cfg jsonb;
  v_admin boolean := public.is_admin(); v_vers jsonb; v_corr jsonb; v_tz text;
begin
  if auth.uid() is null or v_org is null or not public.has_area('finance', 'view') then raise exception 'not authorized' using errcode = '42501'; end if;
  if not exists (select 1 from public.quotes q where q.id = p_quote and q.org_id = v_org) then raise exception 'event not found' using errcode = '42501'; end if;
  v_cfg := public._r372_cfg(v_org); v_tz := public._r372_tz(v_org);
  select c.closed_at into v_closed from public.event_closure c where c.quote_id = p_quote;
  v_live := public._vb_event_pnl__pre0372(p_quote, v_org);
  v_cur := public._r372_current_snapshot(p_quote);
  select coalesce(jsonb_agg(jsonb_build_object('version', s.version, 'reason', s.reason, 'at', s.created_at, 'by', s.signed_email,
           'closed_at', s.closed_at, 'note', s.note, 'net_profit', s.pnl -> 'net_profit', 'margin_pct', s.pnl -> 'margin_pct',
           'revenue', s.pnl -> 'revenue', 'tax', s.pnl -> 'tax', 'cost_expected', s.money -> 'cost_expected',
           'accuracy_pct', s.money -> 'accuracy_pct', 'rules', s.pnl -> 'rules', 'diff', s.diff, 'current', s.id = v_cur.id,
           'by_category', (select coalesce(jsonb_agg(jsonb_build_object('key', c ->> 'key', 'label', c ->> 'label', 'estimated', c -> 'estimated',
                             'actual', c -> 'actual', 'expected', c -> 'expected', 'flag', c -> 'flag')), '[]'::jsonb)
                             from jsonb_array_elements(coalesce(s.money -> 'by_category', '[]'::jsonb)) c))
           order by s.version desc), '[]'::jsonb)
    into v_vers from public.event_pnl_snapshots s where s.quote_id = p_quote and s.org_id = v_org;
  select coalesce(jsonb_agg(jsonb_build_object('id', c.id, 'category', c.category, 'amount', c.amount, 'reason', c.reason,
           'target_kind', c.target_kind, 'after_close', c.after_close, 'by', c.created_email,
           'on', (c.created_at at time zone v_tz)::date, 'at', c.created_at) order by c.created_at desc), '[]'::jsonb)
    into v_corr from public.money_corrections c where c.quote_id = p_quote and c.org_id = v_org;
  return jsonb_build_object('quote_id', p_quote, 'closed', v_closed is not null, 'closed_at', v_closed,
    'frozen', v_cur.id is not null, 'current_version', v_cur.version, 'freeze_closed', v_cfg -> 'freeze_closed',
    'rules', v_live -> 'rules', 'currency', v_live -> 'currency',
    'live', jsonb_build_object('net_profit', v_live -> 'net_profit', 'margin_pct', v_live -> 'margin_pct', 'revenue', v_live -> 'revenue'),
    'live_differs', v_cur.id is not null and abs(coalesce((v_live ->> 'net_profit')::numeric, 0) - coalesce((v_cur.pnl ->> 'net_profit')::numeric, 0)) > 0.5,
    'versions', v_vers, 'corrections', v_corr, 'late_adjust', v_cfg -> 'late_adjust',
    'can_correct', public.has_area('finance', 'edit') and (v_closed is null or (v_admin and v_cfg ->> 'late_adjust' = 'admin')),
    'can_freeze', v_admin and public.has_area('closure', 'edit') and v_closed is not null and v_cur.id is null,
    'is_admin', v_admin);
end $$;

-- an admin freezes a closed event that has no snapshot for its close (closed before this release, or the snapshot failed)
create or replace function public.pnl_freeze_now(p_quote uuid)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
-- r189-money-0372
declare v_org uuid := public.current_org_id(); v_ver integer;
begin
  if auth.uid() is null or v_org is null or not public.is_admin() or not public.has_area('closure', 'edit') then
    raise exception 'Only an admin can freeze the P&L.' using errcode = '42501'; end if;
  if not exists (select 1 from public.quotes q where q.id = p_quote and q.org_id = v_org) then raise exception 'event not found' using errcode = '42501'; end if;
  if not public._r282_event_closed(p_quote) then raise exception 'Close the event first - the P&L is frozen when it is closed.' using errcode = '22023'; end if;
  if (public._r372_current_snapshot(p_quote)).id is not null then raise exception 'This close is already frozen.' using errcode = '22023'; end if;
  v_ver := public._r372_snapshot(p_quote, v_org, 'manual_freeze', 'frozen by hand after closing');
  return public.event_pnl_versions(p_quote);
end $$;

-- a cost correction (open event: Finance edit; closed event: an admin, only when the studio allows late adjustments)
create or replace function public.money_correction_add(p_quote uuid, p_category text, p_amount numeric, p_reason text,
                                                       p_target_kind text default null, p_target_id uuid default null)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
-- r189-money-0372
declare v_org uuid := public.current_org_id(); v_closed boolean; v_reason text := btrim(coalesce(p_reason, '')); v_cfg jsonb;
  v_cat text := lower(btrim(coalesce(p_category, ''))); v_amt numeric;
begin
  if auth.uid() is null or v_org is null or not public.has_area('finance', 'edit') then raise exception 'not authorized' using errcode = '42501'; end if;
  perform 1 from public.quotes q where q.id = p_quote and q.org_id = v_org for update;
  if not found then raise exception 'event not found' using errcode = '42501'; end if;
  if v_cat not in ('venue', 'food', 'decor', 'rentals', 'vendors', 'staff', 'misc', 'logistics', 'damages', 'changes') then
    raise exception 'Pick the cost category the correction belongs to.' using errcode = '22023'; end if;
  v_amt := round(p_amount, 2);
  if v_amt is null or v_amt = 0 or abs(v_amt) >= 10000000000 then raise exception 'Enter the amount to add (or a minus amount to take off).' using errcode = '22023'; end if;
  if char_length(v_reason) < 5 or char_length(v_reason) > 500 then raise exception 'Give a reason of 5 to 500 characters.' using errcode = '22023'; end if;
  if p_target_kind is not null and p_target_kind not in ('bill', 'booking', 'cost_line', 'claim', 'crew', 'writeoff', 'change', 'other') then
    raise exception 'unknown row kind' using errcode = '22023'; end if;
  v_cfg := public._r372_cfg(v_org);
  v_closed := public._r282_event_closed(p_quote);
  if v_closed and not (public.is_admin() and v_cfg ->> 'late_adjust' = 'admin') then
    raise exception 'This event is closed - re-open it first (an admin can re-open it from its Closure page).'
      using errcode = '42501', hint = 'event_closed'; end if;
  insert into public.money_corrections(org_id, quote_id, category, amount, reason, target_kind, target_id, after_close, created_by, created_email)
    values (v_org, p_quote, v_cat, v_amt, v_reason, p_target_kind, p_target_id, v_closed, auth.uid(), public._r372_who());
  insert into public.audit_log(actor, actor_email, action, entity, entity_id, quote_id, changed, org_id)
    values (auth.uid(), public._r372_who(), case when v_closed then 'money_late_adjustment' else 'money_correction' end, 'money_corrections',
            p_quote::text, p_quote, jsonb_build_object('category', v_cat, 'amount', v_amt, 'reason', v_reason), v_org);
  if v_closed then perform public._r372_snapshot(p_quote, v_org, 'late_adjustment', v_reason); end if;
  return public.event_pnl_versions(p_quote);
end $$;

-- the crew on an event with their check-ins, the suggestion and the confirmed attendance (rates + amounts: admin only)
create or replace function public.crew_attendance(p_quote uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
-- r189-money-0372: Finance view, own studio
declare v_org uuid := public.current_org_id(); v_admin boolean := public.is_admin(); v_cfg jsonb; v_day_h numeric; l jsonb; v_rows jsonb := '[]'::jsonb;
  w record; v_sug jsonb; v_lines jsonb; v_closed boolean; v_tz text; n int := 0; n_conf int := 0; n_open int := 0; v_est numeric; v_sw jsonb;
begin
  if auth.uid() is null or v_org is null or not public.has_area('finance', 'view') then raise exception 'not authorized' using errcode = '42501'; end if;
  if not exists (select 1 from public.quotes q where q.id = p_quote and q.org_id = v_org) then raise exception 'event not found' using errcode = '42501'; end if;
  v_cfg := public._r372_cfg(v_org); v_tz := public._r372_tz(v_org);
  v_day_h := coalesce(nullif((public._r25_crew_cfg(v_org) ->> 'dayHours')::numeric, 0), 8);
  v_closed := public._r282_event_closed(p_quote);
  v_lines := coalesce(public._r21_cost_lines__pre0372(p_quote, v_org), '[]'::jsonb);
  for l in select x from jsonb_array_elements(v_lines) x where x ->> 'source' = 'crew' order by x ->> 'label' loop
    n := n + 1;
    v_sug := public._r372_suggest(p_quote, v_org, (l ->> 'crew_id')::uuid, v_cfg);
    select c.days, c.hours, c.ot_hours, c.allowance, c.note, c.confirmed_at, c.confirmed_email into w
      from public.crew_wage_confirmations c where c.quote_id = p_quote and c.org_id = v_org and c.crew_id = (l ->> 'crew_id')::uuid
     order by c.seq desc limit 1;
    if found then n_conf := n_conf + 1; elsif v_sug ->> 'source' = 'none' then n_open := n_open + 1; end if;
    v_est := coalesce((l ->> 'c_est')::numeric, 0);
    v_sw := case when (v_sug ->> 'days') is not null then public._r372_wage(l, (v_sug ->> 'days')::numeric, (v_sug ->> 'hours')::numeric,
                 (v_sug ->> 'ot_hours')::numeric, (v_sug ->> 'allowance')::numeric, v_cfg, v_day_h) end;
    v_rows := v_rows || jsonb_build_array(jsonb_build_object(
      'crew_id', l -> 'crew_id', 'name', l -> 'label', 'attendance', l -> 'attendance', 'pay_basis', l -> 'pay_basis',
      'suggested', v_sug,
      'confirmed', case when w.confirmed_at is not null then jsonb_build_object('days', w.days, 'hours', w.hours, 'ot_hours', w.ot_hours,
                     'allowance', w.allowance, 'note', w.note, 'at', w.confirmed_at, 'by', w.confirmed_email) end)
      || case when v_admin then jsonb_build_object('day_rate', l -> 'day_rate', 'rate_missing', l -> 'rate_missing', 'estimate', v_est,
             'suggested_wage', v_sw -> 'actual',
             'confirmed_wage', case when w.confirmed_at is not null then (public._r372_wage(l, w.days, w.hours, w.ot_hours, w.allowance, v_cfg, v_day_h)) -> 'actual' end)
         else '{}'::jsonb end);
  end loop;
  return jsonb_build_object('quote_id', p_quote, 'people', v_rows, 'count', n, 'confirmed', n_conf, 'not_marked', n_open,
    'closed', v_closed, 'can_confirm', public.has_area('finance', 'edit') and not v_closed, 'pay_visible', v_admin,
    'rules', jsonb_build_object('ot_enabled', v_cfg -> 'ot_enabled', 'half_day', v_cfg -> 'half_day', 'allowance_enabled', v_cfg -> 'allowance_enabled',
      'allowance_default', v_cfg -> 'allowance_default', 'std_hours', v_cfg -> 'std_hours'));
end $$;

-- "Confirm attendance": p_rows null / [] = everyone who checked in or is marked on the roster and is not confirmed yet, as suggested;
-- else [{crew_id, days, hours?, ot_hours?, allowance?, note?}]. A new row per person (the newest wins).
create or replace function public.crew_attendance_confirm(p_quote uuid, p_rows jsonb default null)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
-- r189-money-0372
declare v_org uuid := public.current_org_id(); v_cfg jsonb; l jsonb; r jsonb; v_sug jsonb; v_crew uuid; v_ids uuid[];
  v_days numeric; v_hours numeric; v_ot numeric; v_allow numeric; v_note text; n int := 0;
begin
  if auth.uid() is null or v_org is null or not public.has_area('finance', 'edit') then raise exception 'not authorized' using errcode = '42501'; end if;
  perform 1 from public.quotes q where q.id = p_quote and q.org_id = v_org for update;
  if not found then raise exception 'event not found' using errcode = '42501'; end if;
  if public._r282_event_closed(p_quote) then
    raise exception 'This event is closed - re-open it first (an admin can re-open it from its Closure page).' using errcode = '42501', hint = 'event_closed'; end if;
  if p_rows is not null and jsonb_typeof(p_rows) <> 'array' then raise exception 'rows must be a list' using errcode = '22023'; end if;
  if p_rows is not null and jsonb_array_length(p_rows) > 500 then raise exception 'too many rows' using errcode = '22023'; end if;
  v_cfg := public._r372_cfg(v_org);
  select coalesce(array_agg((x ->> 'crew_id')::uuid), '{}') into v_ids
    from jsonb_array_elements(coalesce(public._r21_cost_lines__pre0372(p_quote, v_org), '[]'::jsonb)) x where x ->> 'source' = 'crew';
  if p_rows is null or jsonb_array_length(p_rows) = 0 then
    foreach v_crew in array v_ids loop
      continue when exists (select 1 from public.crew_wage_confirmations c where c.quote_id = p_quote and c.crew_id = v_crew);
      v_sug := public._r372_suggest(p_quote, v_org, v_crew, v_cfg);
      continue when v_sug ->> 'source' = 'none';
      insert into public.crew_wage_confirmations(org_id, quote_id, crew_id, days, hours, ot_hours, allowance, suggested, confirmed_by, confirmed_email)
        values (v_org, p_quote, v_crew, (v_sug ->> 'days')::numeric, (v_sug ->> 'hours')::numeric, coalesce((v_sug ->> 'ot_hours')::numeric, 0),
                coalesce((v_sug ->> 'allowance')::numeric, 0), v_sug, auth.uid(), public._r372_who());
      n := n + 1;
    end loop;
  else
    for r in select x from jsonb_array_elements(p_rows) x loop
      if jsonb_typeof(r) <> 'object' then raise exception 'each row must be an object' using errcode = '22023'; end if;
      begin v_crew := (r ->> 'crew_id')::uuid; exception when others then v_crew := null; end;
      if v_crew is null or not (v_crew = any(v_ids)) then raise exception 'That person is not on this event.' using errcode = '22023'; end if;
      if jsonb_typeof(r -> 'days') <> 'number' then raise exception 'Enter the days worked (0 for a no-show).' using errcode = '22023'; end if;
      v_days := round((r ->> 'days')::numeric, 2);
      if v_days < 0 or v_days > 60 or v_days * 2 <> floor(v_days * 2) then raise exception 'Days worked must be 0 to 60, in half days (e.g. 1, 0.5, 2.5).' using errcode = '22023'; end if;
      v_hours := case when jsonb_typeof(r -> 'hours') = 'number' then round((r ->> 'hours')::numeric, 2) end;
      if v_hours is not null and (v_hours < 0 or v_hours > 1000) then raise exception 'Hours must be 0 to 1000.' using errcode = '22023'; end if;
      v_ot := case when jsonb_typeof(r -> 'ot_hours') = 'number' then round((r ->> 'ot_hours')::numeric, 2) else 0 end;
      if v_ot < 0 or v_ot > 300 then raise exception 'Overtime must be 0 to 300 hours.' using errcode = '22023'; end if;
      v_allow := case when jsonb_typeof(r -> 'allowance') = 'number' then round((r ->> 'allowance')::numeric, 2) else 0 end;
      if v_allow < 0 or v_allow >= 1000000 then raise exception 'The allowance is out of range.' using errcode = '22023'; end if;
      v_note := left(nullif(btrim(coalesce(r ->> 'note', '')), ''), 300);
      v_sug := public._r372_suggest(p_quote, v_org, v_crew, v_cfg);
      insert into public.crew_wage_confirmations(org_id, quote_id, crew_id, days, hours, ot_hours, allowance, note, suggested, confirmed_by, confirmed_email)
        values (v_org, p_quote, v_crew, v_days, v_hours, v_ot, v_allow, v_note, v_sug, auth.uid(), public._r372_who());
      n := n + 1;
    end loop;
  end if;
  if n > 0 then
    insert into public.audit_log(actor, actor_email, action, entity, entity_id, quote_id, changed, org_id)
      values (auth.uid(), public._r372_who(), 'crew_attendance_confirmed', 'crew_wage_confirmations', p_quote::text, p_quote,
              jsonb_build_object('people', n, 'one_tap', p_rows is null or jsonb_array_length(p_rows) = 0), v_org);
  end if;
  return public.crew_attendance(p_quote) || jsonb_build_object('written', n);
end $$;

-- client TDS: list + totals + the suggestion (rate x revenue without GST)
create or replace function public.client_tds_list(p_quote uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
-- r189-money-0372: Finance view, own studio
declare v_org uuid := public.current_org_id(); v_cfg jsonb; b jsonb; v_rows jsonb; v_rev numeric; v_tz text;
begin
  if auth.uid() is null or v_org is null or not public.has_area('finance', 'view') then raise exception 'not authorized' using errcode = '42501'; end if;
  if not exists (select 1 from public.quotes q where q.id = p_quote and q.org_id = v_org) then raise exception 'event not found' using errcode = '42501'; end if;
  v_cfg := public._r372_cfg(v_org); v_tz := public._r372_tz(v_org);
  b := public._a49_close_blockers(p_quote);
  v_rev := coalesce((public._vb_event_pnl__pre0372(p_quote, v_org) ->> 'revenue')::numeric, 0);
  select coalesce(jsonb_agg(jsonb_build_object('id', t.id, 'amount', t.amount, 'section', t.section, 'rate', t.rate, 'note', t.note,
           'on', (t.created_at at time zone v_tz)::date, 'by', t.created_email, 'corrects_id', t.corrects_id,
           'reversed', exists (select 1 from public.client_tds r where r.corrects_id = t.id),
           'form16a', (select jsonb_build_object('received_on', x.received_on, 'by', x.created_email, 'note', x.note)
                         from public.client_tds_certificates x where x.tds_id = t.id)) order by t.created_at, t.id), '[]'::jsonb)
    into v_rows from public.client_tds t where t.quote_id = p_quote and t.org_id = v_org;
  return jsonb_build_object('quote_id', p_quote, 'rows', v_rows, 'total', public._r372_tds(p_quote),
    'certified', coalesce((select sum(t.amount) from public.client_tds t where t.quote_id = p_quote and t.amount > 0
                            and exists (select 1 from public.client_tds_certificates x where x.tds_id = t.id)
                            and not exists (select 1 from public.client_tds r where r.corrects_id = t.id)), 0),
    'balance_owed', b -> 'balance_owed', 'invoice_total', b -> 'total', 'paid', b -> 'paid',
    'enabled', v_cfg -> 'tds_enabled', 'default_section', v_cfg -> 'tds_section', 'default_rate', v_cfg -> 'tds_rate',
    'suggested', round(v_rev * coalesce((v_cfg ->> 'tds_rate')::numeric, 0) / 100, 0),
    'closed', public._r282_event_closed(p_quote), 'can_edit', public.has_area('finance', 'edit'));
end $$;

create or replace function public.client_tds_record(p_quote uuid, p_amount numeric, p_section text default null, p_rate numeric default null,
                                                    p_note text default null, p_payment uuid default null)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
-- r189-money-0372: Finance edit; allowed after closing (it moves the balance, never the profit), logged
declare v_org uuid := public.current_org_id(); v_amt numeric := round(p_amount, 2); v_sec text := nullif(upper(btrim(coalesce(p_section, ''))), '');
  b jsonb; v_left numeric; v_closed boolean; v_n integer := 0;
begin
  if auth.uid() is null or v_org is null or not public.has_area('finance', 'edit') then raise exception 'not authorized' using errcode = '42501'; end if;
  perform 1 from public.quotes q where q.id = p_quote and q.org_id = v_org for update;
  if not found then raise exception 'event not found' using errcode = '42501'; end if;
  perform pg_advisory_xact_lock(hashtextextended('helm:pay:quote:' || p_quote::text, 0));
  if v_amt is null or v_amt <= 0 then raise exception 'Enter the TDS amount the client deducted.' using errcode = '22023'; end if;
  if v_sec is not null and v_sec !~ '^19[0-9][A-Z]{0,3}$' then raise exception 'The TDS section looks wrong (e.g. 194C, 194J).' using errcode = '22023'; end if;
  if p_rate is not null and (p_rate < 0 or p_rate > 30) then raise exception 'The TDS rate must be 0 to 30%%.' using errcode = '22023'; end if;
  if p_payment is not null and not exists (select 1 from public.quote_payments qp where qp.id = p_payment and qp.quote_id = p_quote) then
    raise exception 'That payment is not on this event.' using errcode = '22023'; end if;
  b := public._a49_close_blockers(p_quote);
  v_left := coalesce((b ->> 'total')::numeric, 0) - coalesce((b ->> 'paid')::numeric, 0) - public._r372_tds(p_quote);
  if v_amt > v_left + 0.5 then
    raise exception 'TDS can''t be more than the balance still owed (%).', to_char(greatest(v_left, 0), 'FM999999999990.00') using errcode = '22023'; end if;
  v_closed := public._r282_event_closed(p_quote);
  insert into public.client_tds(org_id, quote_id, amount, section, rate, payment_id, note, created_by, created_email)
    values (v_org, p_quote, v_amt, v_sec, round(p_rate, 2), p_payment, left(nullif(btrim(coalesce(p_note, '')), ''), 300), auth.uid(), public._r372_who());
  if v_closed then perform set_config('helm.r282_pay', p_quote::text, true); end if;
  begin v_n := public._pst_allocate(p_quote);
  exception when others then v_n := 0; raise warning 'r189-0372: milestone cover skipped (%)', sqlstate;
  end;
  if v_closed then perform set_config('helm.r282_pay', '', true); end if;
  insert into public.audit_log(actor, actor_email, action, entity, entity_id, quote_id, changed, org_id)
    values (auth.uid(), public._r372_who(), case when v_closed then 'client_tds_after_close' else 'client_tds' end, 'client_tds', p_quote::text, p_quote,
            jsonb_build_object('amount', v_amt, 'section', v_sec, 'milestones_covered', v_n), v_org);
  return public.client_tds_list(p_quote) || jsonb_build_object('milestones_covered', v_n);
end $$;

-- a wrong TDS row: a minus row reverses it (never edited); open events only
create or replace function public.client_tds_reverse(p_tds uuid, p_reason text)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
-- r189-money-0372
declare v_org uuid := public.current_org_id(); t public.client_tds; v_reason text := btrim(coalesce(p_reason, ''));
begin
  if auth.uid() is null or v_org is null or not public.has_area('finance', 'edit') then raise exception 'not authorized' using errcode = '42501'; end if;
  select * into t from public.client_tds x where x.id = p_tds and x.org_id = v_org;
  if t.id is null then raise exception 'TDS entry not found' using errcode = '42501'; end if;
  if t.amount < 0 then raise exception 'That is already a reversal.' using errcode = '22023'; end if;
  if exists (select 1 from public.client_tds r where r.corrects_id = t.id) then raise exception 'This TDS entry is already reversed.' using errcode = '22023'; end if;
  if char_length(v_reason) < 5 or char_length(v_reason) > 300 then raise exception 'Give a reason of 5 to 300 characters.' using errcode = '22023'; end if;
  if public._r282_event_closed(t.quote_id) then
    raise exception 'This event is closed - re-open it first (an admin can re-open it from its Closure page).' using errcode = '42501', hint = 'event_closed'; end if;
  perform pg_advisory_xact_lock(hashtextextended('helm:pay:quote:' || t.quote_id::text, 0));
  insert into public.client_tds(org_id, quote_id, amount, section, rate, note, corrects_id, created_by, created_email)
    values (v_org, t.quote_id, -t.amount, t.section, t.rate, left('Reversed: ' || v_reason, 300), t.id, auth.uid(), public._r372_who());
  insert into public.audit_log(actor, actor_email, action, entity, entity_id, quote_id, changed, org_id)
    values (auth.uid(), public._r372_who(), 'client_tds_reversed', 'client_tds', t.id::text, t.quote_id,
            jsonb_build_object('amount', t.amount, 'reason', v_reason), v_org);
  return public.client_tds_list(t.quote_id);
end $$;

-- "Form 16A received" (allowed after closing)
create or replace function public.client_tds_form16a(p_tds uuid, p_received_on date default null, p_note text default null)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
-- r189-money-0372
declare v_org uuid := public.current_org_id(); t public.client_tds; v_on date := coalesce(p_received_on, public.studio_today(public.current_org_id()));
begin
  if auth.uid() is null or v_org is null or not public.has_area('finance', 'edit') then raise exception 'not authorized' using errcode = '42501'; end if;
  select * into t from public.client_tds x where x.id = p_tds and x.org_id = v_org;
  if t.id is null or t.amount <= 0 then raise exception 'TDS entry not found' using errcode = '42501'; end if;
  if exists (select 1 from public.client_tds r where r.corrects_id = t.id) then raise exception 'This TDS entry was reversed.' using errcode = '22023'; end if;
  if v_on > public.studio_today(v_org) + 1 or v_on < date '2000-01-01' then raise exception 'Pick the day the Form 16A came in.' using errcode = '22023'; end if;
  insert into public.client_tds_certificates(org_id, quote_id, tds_id, received_on, note, created_by, created_email)
    values (v_org, t.quote_id, t.id, v_on, left(nullif(btrim(coalesce(p_note, '')), ''), 300), auth.uid(), public._r372_who())
    on conflict (tds_id) do nothing;
  insert into public.audit_log(actor, actor_email, action, entity, entity_id, quote_id, changed, org_id)
    values (auth.uid(), public._r372_who(), 'client_tds_form16a', 'client_tds_certificates', t.id::text, t.quote_id,
            jsonb_build_object('received_on', v_on), v_org);
  return public.client_tds_list(t.quote_id);
end $$;

-- Business page: GST to pay and TDS by month (studio currency only); Business area + Finance view
create or replace function public.business_tax_by_month(p_from date, p_to date)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
-- r189-money-0372: read-only
declare v_org uuid := public.current_org_id(); v_from date := coalesce(p_from, current_date - 365); v_to date := coalesce(p_to, current_date + 365);
  v_tz text; v_cur text; x record; p jsonb; v_m jsonb := '{}'::jsonb; k text; v_other int := 0; v_cfg jsonb; v_rows jsonb;
  n_gst numeric; n_rtax numeric; n_itc numeric;
begin
  if auth.uid() is null or v_org is null or not public.has_area('finance', 'view') or not public.has_area('business', 'view') then
    raise exception 'not authorized' using errcode = '42501'; end if;
  if v_to < v_from then raise exception 'the end date is before the start date' using errcode = '22023'; end if;
  if v_to - v_from > 1100 then raise exception 'range too long (max 3 years)' using errcode = '22023'; end if;
  v_tz := public._r372_tz(v_org); v_cfg := public._r372_cfg(v_org);
  select upper(coalesce(nullif(btrim(o.currency), ''), 'INR')) into v_cur from public.organizations o where o.id = v_org;
  for x in select q.id, q.event_date from public.quotes q
            where q.org_id = v_org and q.deleted_at is null and q.status = 'confirmed' and not coalesce(q.is_demo, false)
              and coalesce(q.lifecycle_stage, 'quote') not in ('lead', 'discovery', 'proposal')
              and q.event_date between v_from and v_to order by q.event_date limit 2000 loop
    p := public._vb_event_pnl(x.id, v_org);
    continue when p is null;
    if upper(coalesce(p ->> 'currency', v_cur)) <> v_cur then v_other := v_other + 1; continue; end if;
    k := to_char(x.event_date, 'YYYY-MM');
    n_gst := coalesce((p ->> 'tax')::numeric, 0); n_rtax := coalesce((p ->> 'refunds_tax')::numeric, 0); n_itc := coalesce((p ->> 'input_tax')::numeric, 0);
    v_m := jsonb_set(v_m, array[k], coalesce(v_m -> k, jsonb_build_object('events', 0, 'gst_collected', 0, 'gst_refunds', 0, 'input_credit', 0, 'gst_to_pay', 0,
             'tds_deducted', 0, 'tds_certified', 0, 'vendor_tds', 0))
      || jsonb_build_object('events', coalesce((v_m -> k ->> 'events')::int, 0) + 1,
           'gst_collected', coalesce((v_m -> k ->> 'gst_collected')::numeric, 0) + n_gst,
           'gst_refunds', coalesce((v_m -> k ->> 'gst_refunds')::numeric, 0) + n_rtax,
           'input_credit', coalesce((v_m -> k ->> 'input_credit')::numeric, 0) + n_itc,
           'gst_to_pay', coalesce((v_m -> k ->> 'gst_to_pay')::numeric, 0) + greatest(n_gst - n_rtax - n_itc, 0)));
  end loop;
  -- client TDS by the day it was recorded; Form 16A by the month of the TDS row
  for x in select to_char((t.created_at at time zone v_tz)::date, 'YYYY-MM') as k, sum(t.amount) as amt,
                  sum(t.amount) filter (where t.amount > 0 and exists (select 1 from public.client_tds_certificates c where c.tds_id = t.id)
                                          and not exists (select 1 from public.client_tds r where r.corrects_id = t.id)) as cert
             from public.client_tds t join public.quotes q on q.id = t.quote_id and not coalesce(q.is_demo, false)
            where t.org_id = v_org and (t.created_at at time zone v_tz)::date between v_from and v_to group by 1 loop
    v_m := jsonb_set(v_m, array[x.k], coalesce(v_m -> x.k, jsonb_build_object('events', 0, 'gst_collected', 0, 'gst_refunds', 0, 'input_credit', 0, 'gst_to_pay', 0,
             'tds_deducted', 0, 'tds_certified', 0, 'vendor_tds', 0))
      || jsonb_build_object('tds_deducted', coalesce((v_m -> x.k ->> 'tds_deducted')::numeric, 0) + coalesce(x.amt, 0),
                            'tds_certified', coalesce((v_m -> x.k ->> 'tds_certified')::numeric, 0) + coalesce(x.cert, 0)));
  end loop;
  -- TDS on approved vendor invoices (0256, information only) by invoice date
  if to_regclass('public.vendor_invoices') is not null then
    for x in execute 'select to_char(i.invoice_date, ''YYYY-MM'') as k, sum(i.tds_amount) as amt from public.vendor_invoices i
                       where i.org_id = $1 and i.status = ''approved'' and coalesce(i.tds_amount, 0) > 0 and i.invoice_date between $2 and $3 group by 1'
             using v_org, v_from, v_to loop
      v_m := jsonb_set(v_m, array[x.k], coalesce(v_m -> x.k, jsonb_build_object('events', 0, 'gst_collected', 0, 'gst_refunds', 0, 'input_credit', 0, 'gst_to_pay', 0,
               'tds_deducted', 0, 'tds_certified', 0, 'vendor_tds', 0))
        || jsonb_build_object('vendor_tds', coalesce((v_m -> x.k ->> 'vendor_tds')::numeric, 0) + coalesce(x.amt, 0)));
    end loop;
  end if;
  select coalesce(jsonb_agg(jsonb_build_object('month', e.key) || e.value || jsonb_build_object(
           'tds_pending', greatest(coalesce((e.value ->> 'tds_deducted')::numeric, 0) - coalesce((e.value ->> 'tds_certified')::numeric, 0), 0))
           order by e.key desc), '[]'::jsonb)
    into v_rows from jsonb_each(v_m) e;
  return jsonb_build_object('from', v_from, 'to', v_to, 'currency', v_cur, 'months', v_rows, 'other_currency_events', v_other,
    'tds_enabled', v_cfg -> 'tds_enabled', 'basis', 'GST by event month; client TDS by the day it was recorded; vendor TDS by invoice date');
end $$;

-- ---- 9) free-trial retention (0184): the money records go with the studio events, the money rules stay -----------------
do $$ declare v_def text; begin
  if to_regprocedure('public._tr184_purge_tables()') is not null then
    v_def := pg_get_functiondef('public._tr184_purge_tables()'::regprocedure);
    if position('''client_tds_certificates''' in v_def) = 0 then
      if (length(v_def) - length(replace(v_def, '''event_close_overrides''', ''))) / length('''event_close_overrides''') <> 1 then
        raise notice '0372: _tr184_purge_tables has an unexpected body - left unchanged';
      else execute replace(v_def, '''event_close_overrides''', '''event_close_overrides'', ''client_tds_certificates'', ''client_tds'', ''event_pnl_snapshots'', ''money_corrections'', ''crew_wage_confirmations'''); end if;
    end if;
  end if;
  if to_regprocedure('public._tr184_keep_tables()') is not null then
    v_def := pg_get_functiondef('public._tr184_keep_tables()'::regprocedure);
    if position('''money_settings''' in v_def) = 0 then
      if (length(v_def) - length(replace(v_def, '''comms_settings''', ''))) / length('''comms_settings''') <> 1 then
        raise notice '0372: _tr184_keep_tables has an unexpected body - left unchanged';
      else execute replace(v_def, '''comms_settings''', '''comms_settings'', ''money_settings'''); end if;
    end if;
  end if;
end $$;

-- ---- 10) grants: page RPCs for signed-in staff (each checks its area); everything else for the server only -------------------
do $$
declare f text;
begin
  foreach f in array array['public._r372_cfg(uuid)', 'public._r372_tz(uuid)', 'public._r372_who()',
                           'public._r372_wage(jsonb,numeric,numeric,numeric,numeric,jsonb,numeric)', 'public._r372_suggest(uuid,uuid,uuid,jsonb)',
                           'public._r372_flag(numeric,numeric,jsonb)', 'public._r372_diff(public.event_pnl_snapshots,jsonb,jsonb)',
                           'public._r372_snapshot(uuid,uuid,text,text)', 'public._r372_tg_close_snapshot()', 'public._r372_current_snapshot(uuid)',
                           'public._r372_tds(uuid)', 'public._r372_cancelled_row(uuid,uuid)', 'public._r372_tg_keep()',
                           'public._r21_cost_lines(uuid,uuid)', 'public._r21_cost_lines__pre0372(uuid,uuid)',
                           'public._r21_event_money(uuid,uuid,boolean)', 'public._r21_event_money__pre0372(uuid,uuid,boolean)',
                           'public._vb_event_pnl(uuid,uuid)', 'public._vb_event_pnl__pre0372(uuid,uuid)',
                           'public._a49_close_blockers(uuid)', 'public._a49_close_blockers__pre0372(uuid)',
                           'public._pst_allocate(uuid)', 'public._pst_allocate__pre0372(uuid)',
                           'public.business_pnl__pre0372(date,date)'] loop
    execute format('revoke all on function %s from public', f);
    if exists (select 1 from pg_roles where rolname = 'anon') then execute format('revoke all on function %s from anon', f); end if;
    if exists (select 1 from pg_roles where rolname = 'authenticated') then execute format('revoke all on function %s from authenticated', f); end if;
    -- the same as the kept bodies always had (0049 / 0198 / 0264): the server role may call them
    if exists (select 1 from pg_roles where rolname = 'service_role') then execute format('grant execute on function %s to service_role', f); end if;
  end loop;
  foreach f in array array['public.money_settings_get()', 'public.money_settings_set(jsonb)', 'public.event_pnl_versions(uuid)',
                           'public.pnl_freeze_now(uuid)', 'public.money_correction_add(uuid,text,numeric,text,text,uuid)',
                           'public.crew_attendance(uuid)', 'public.crew_attendance_confirm(uuid,jsonb)', 'public.client_tds_list(uuid)',
                           'public.client_tds_record(uuid,numeric,text,numeric,text,uuid)', 'public.client_tds_reverse(uuid,text)',
                           'public.client_tds_form16a(uuid,date,text)', 'public.business_tax_by_month(date,date)', 'public.business_pnl(date,date)'] loop
    execute format('revoke all on function %s from public', f);
    if exists (select 1 from pg_roles where rolname = 'anon') then execute format('revoke all on function %s from anon', f); end if;
    if exists (select 1 from pg_roles where rolname = 'authenticated') then execute format('grant execute on function %s to authenticated', f); end if;
    if exists (select 1 from pg_roles where rolname = 'service_role') then execute format('grant execute on function %s to service_role', f); end if;
  end loop;
end $$;

notify pgrst, 'reload schema';

-- VERIFY every line should say true
select item, ok from (values
  ('01 six money tables, RLS on, closed to the app', (select count(*) from pg_class c where c.oid in (to_regclass('public.money_settings'),
       to_regclass('public.event_pnl_snapshots'), to_regclass('public.money_corrections'), to_regclass('public.crew_wage_confirmations'),
       to_regclass('public.client_tds'), to_regclass('public.client_tds_certificates')) and c.relrowsecurity) = 6
     and not has_table_privilege('authenticated', 'public.event_pnl_snapshots', 'select')
     and not has_table_privilege('authenticated', 'public.client_tds', 'insert')
     and not has_table_privilege('anon', 'public.money_corrections', 'select')),
  ('02 money rows are kept for good (no update / delete trigger on 5 tables)', (select count(*) from pg_trigger t where t.tgname = 'aa_r372_keep'
       and t.tgrelid in (to_regclass('public.event_pnl_snapshots'), to_regclass('public.money_corrections'), to_regclass('public.crew_wage_confirmations'),
                         to_regclass('public.client_tds'), to_regclass('public.client_tds_certificates'))) = 5),
  ('03 every close freezes the P&L (trigger on event_closure)', exists (select 1 from pg_trigger t where t.tgname = 'zzz_r372_close_snapshot'
       and t.tgrelid = 'public.event_closure'::regclass)),
  ('04 six functions wrapped once (old bodies kept as __pre0372)', to_regprocedure('public._r21_cost_lines__pre0372(uuid,uuid)') is not null
     and to_regprocedure('public._r21_event_money__pre0372(uuid,uuid,boolean)') is not null and to_regprocedure('public._vb_event_pnl__pre0372(uuid,uuid)') is not null
     and to_regprocedure('public._a49_close_blockers__pre0372(uuid)') is not null and to_regprocedure('public._pst_allocate__pre0372(uuid)') is not null
     and to_regprocedure('public.business_pnl__pre0372(date,date)') is not null
     and position('r189-money-0372' in coalesce(pg_get_functiondef(to_regprocedure('public._vb_event_pnl(uuid,uuid)')), '')) > 0
     and position('r189-money-0372' in coalesce(pg_get_functiondef(to_regprocedure('public._a49_close_blockers(uuid)')), '')) > 0),
  ('05 page functions for signed-in staff only', has_function_privilege('authenticated', 'public.event_pnl_versions(uuid)', 'execute')
     and has_function_privilege('authenticated', 'public.client_tds_record(uuid,numeric,text,numeric,text,uuid)', 'execute')
     and has_function_privilege('authenticated', 'public.crew_attendance_confirm(uuid,jsonb)', 'execute')
     and has_function_privilege('authenticated', 'public.business_tax_by_month(date,date)', 'execute')
     and not has_function_privilege('anon', 'public.event_pnl_versions(uuid)', 'execute')
     and not has_function_privilege('anon', 'public.money_settings_set(jsonb)', 'execute')),
  ('06 ledger helpers and kept bodies are server only', not has_function_privilege('authenticated', 'public._r372_snapshot(uuid,uuid,text,text)', 'execute')
     and not has_function_privilege('authenticated', 'public._vb_event_pnl__pre0372(uuid,uuid)', 'execute')
     and not has_function_privilege('authenticated', 'public._r21_cost_lines(uuid,uuid)', 'execute')
     and not has_function_privilege('authenticated', 'public.business_pnl__pre0372(date,date)', 'execute')),
  ('07 free-trial purge knows the money records, keeps the money rules (or 0184 is absent)', to_regprocedure('public._tr184_purge_tables()') is null
     or (position('client_tds_certificates' in pg_get_functiondef(to_regprocedure('public._tr184_purge_tables()'))) > 0
         and position('money_settings' in pg_get_functiondef(to_regprocedure('public._tr184_keep_tables()'))) > 0))
) v(item, ok) order by item;
commit;
