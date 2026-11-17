-- APPLY-0373 (R190 Money phase 2: finish vendor bills - due reminders, TDS off the payout + TDS report, typed advances -> payout rows, GST 150-day + cash warnings, bill photo added later, late bills after close). Run on STAGING first, then production. Safe to run twice.
-- Adds five closed tables, three empty columns on vendor_payouts, new functions, wraps three functions once (old bodies kept) and re-issues one money guard with a single added early return. Nothing is changed or deleted. If it stops with a STOP message nothing was applied.
begin;
-- 0373_r190_vendor_bills_finish.sql - R190 (owner, 17 Nov 2026: Money phase 2 "Finish vendor bills"). Forward-only,
-- additive, safe to run twice. ASCII only.
-- REQUIRES 0124 + 0156 (vendor_bills, vendor_payouts, record_vendor_payout), 0152 (tg_a152_money_create_guard),
--          0246 + 0265 (vendor_bills.gst_amount / gst_claimable, _r21_cost_lines), 0256 (vendor_invoices.tds_section /
--          tds_amount), 0198 (_a198_org_today), 0283 (_r283_is_off / _r283_owner / _r283_off_email), 0361 (_r361_email),
--          0266 + 0369 (_r23_visible, bell_feed), trial gates (trial_send_blocked, _sample_outbound_blocked, _dl241_send_block).
--
-- In plain words (MONEY-INVENTORY-PLAN.md phase 2 + "Phase 2 review (R190)"):
--   1  BILL DUE REMINDERS. Every hour (pg_cron, only when it is installed) Helm looks at open vendor bills with a due date
--      and, from 9:00 studio time, tells the "who pays vendors" person or role: 3 days before, on the day, then
--      every 3 days while overdue (up to 180 days; all per-studio settings). One reminder per bill and slot, ever
--      (vendor_bill_reminders, unique). Bell notice only for the people named on it (it shows money), plus an e-mail each
--      through the new vendor_bill_mail_outbox (comms-dispatch sends it on the shared Helm layout once redeployed).
--      Free-trial studios: bell only. Sample events never. A paid / voided bill stops at once (re-checked at send time).
--   2  OPTIONAL REMINDER TO THE VENDOR (OFF by default): "your bill #142 is due for payment on <date>", once, N days
--      before (default 3), to the e-mail of the vendor. Opted-out addresses, trials and samples never.
--   3  TDS OFF THE PAYOUT. vendor_bill_pay records the cash part AND the TDS part as two payout rows (the TDS row has
--      source tds + its section), so every existing "paid" sum (close checklist, payables, P&L, overpay rule) stays
--      right without any change, and the bill counts as fully settled. vendor_tds_report = those rows by month for the CA.
--      Suggested TDS: from the approved vendor invoice (0256) when it has one, else the studio default (none by default).
--   4  OLD TYPED ADVANCES -> PAYOUT ROWS by ADDING rows only (source advance), per event on request
--      (vendor_bill_convert_advances), oldest bill first, never more than the open amount of a bill. The typed advance stays as
--      it is (never edited) and is LOCKED once part of it is converted; everything that counted it as paid now subtracts
--      what was converted (_r21_cost_lines wrapped here; the browser rule in store-api.js), so nothing is counted twice.
--   5  WARNINGS: unpaid bill with claimable GST at 150 days ("pay before day 180 or reverse the GST credit"); a cash payout
--      that takes one vendor over Rs 10,000 in a day (Section 40A(3)). Warnings only, never a block.
--   6  BILL PHOTO / PDF ADDED LATER: vendor_bill_files (insert only) - the bill row itself is never edited.
--   7  BILL AFTER THE EVENT CLOSED = a LATE ADJUSTMENT (vendor_bill_add_late): only on a closed event, with a reason, by
--      the admins (studio setting: admins / Finance editors). The 0152 "event is closed" check is skipped for that one bill
--      only (a vendor_bill_late row written first in the same transaction); every other rule still runs. When a P&L
--      snapshot hook exists (public.pnl_snapshot_after_late_cost(uuid, text), R189) it is called so a new version is
--      written; without it nothing else happens. Paying an already-recorded bill after close is allowed through
--      vendor_bill_pay (it does not change profit; the close checklist already says so).
--   Access: everything needs the Finance area (view to read, edit to pay / attach / convert); settings + late bills
--   admin by default; crew and crew links never see any of it. Own studio only everywhere.
-- Changes: 5 new tables (RLS on, no app table privileges - RPCs only), 3 nullable columns on vendor_payouts (source,
-- tds_section, payout_ref: empty on every existing row), new functions, _r21_cost_lines / _r23_visible / bell_feed wrapped
-- once (old bodies kept as *__pre0373), tg_a152_money_create_guard re-issued with ONE added early return for late bills
-- (same body otherwise), 1 trigger on event_resources (advance lock), 1 pg_cron job (only if pg_cron exists), the free
-- trial purge / keep lists learn the new tables. No row is updated or deleted; nothing is dropped except the one
-- replaced trigger function body. If it stops with a STOP message nothing was applied.
-- ROLLBACK (manual, only if ever needed; no data involved): unschedule the pg_cron job named helm-vendor-bill-reminders;
--   drop function public._r21_cost_lines(uuid, uuid); alter function public._r21_cost_lines__pre0373(uuid, uuid) rename to _r21_cost_lines;
--   (same for _r23_visible / bell_feed); re-run the 0152 tg_a152_money_create_guard body. The new tables can stay.

-- ---- 0) preflight -----------------------------------------------------------------------------------------------------
do $$ begin
  if to_regclass('public.vendor_bills') is null or to_regclass('public.vendor_payouts') is null
     or to_regprocedure('public.record_vendor_payout(uuid,numeric,date,text,text,text)') is null then
    raise exception 'STOP 0373: run 0124 (vendor bills) first'; end if;
  if not exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'vendor_bills' and column_name = 'gst_claimable') then
    raise exception 'STOP 0373: run 0246 (GST on vendor bills) first'; end if;
  if to_regclass('public.vendor_invoices') is null then raise exception 'STOP 0373: run 0256 (vendor invoices) first'; end if;
  if to_regprocedure('public.tg_a152_money_create_guard()') is null or to_regprocedure('public._a156_vendor_bill_refs_ok(uuid,uuid,uuid,uuid)') is null then
    raise exception 'STOP 0373: run 0152 + 0156 (money guards) first'; end if;
  if to_regprocedure('public._r21_cost_lines(uuid,uuid)') is null then raise exception 'STOP 0373: run 0246 / 0265 (cost ledger) first'; end if;
  if to_regprocedure('public._a198_org_today(uuid)') is null or to_regprocedure('public._r23_tz(uuid)') is null then
    raise exception 'STOP 0373: run 0198 + 0266 (studio day / time zone) first'; end if;
  if to_regprocedure('public._r283_is_off(uuid,uuid)') is null or to_regprocedure('public._r283_owner(uuid)') is null
     or to_regprocedure('public._r283_off_email(uuid,text)') is null or to_regprocedure('public._r361_email(text)') is null then
    raise exception 'STOP 0373: run 0283 + 0361 first'; end if;
  if to_regprocedure('public._r23_visible(uuid,uuid)') is null or to_regprocedure('public.bell_feed(integer)') is null then
    raise exception 'STOP 0373: run 0266 + 0299 (bell / inbox) first'; end if;
  if to_regprocedure('public.trial_send_blocked(uuid,uuid,uuid)') is null or to_regprocedure('public._sample_outbound_blocked(uuid,text)') is null
     or to_regprocedure('public._dl241_send_block(uuid,text,boolean)') is null or to_regprocedure('public.email_is_opted_out(uuid,text)') is null then
    raise exception 'STOP 0373: trial / send gates missing'; end if;
  if to_regprocedure('public.has_area(text,text)') is null or to_regprocedure('public.current_org_id()') is null
     or to_regprocedure('public.user_role()') is null or to_regprocedure('public._trial_locked(uuid)') is null then
    raise exception 'STOP 0373: has_area / current_org_id / user_role / _trial_locked missing'; end if;
end $$;

-- ---- 1) tables ----------------------------------------------------------------------------------------------------------
-- the per-studio setting (no row = the defaults below)
create table if not exists public.vendor_bill_settings (
  org_id             uuid primary key references public.organizations(id) on delete cascade,
  enabled            boolean not null default true,
  payer_kind         text not null default 'role' check (payer_kind in ('role', 'person')),
  payer_role         text not null default 'admin' check (payer_role ~ '^[a-z_]{2,30}$'),
  payer_profile      uuid,
  days_before        integer not null default 3 check (days_before between 0 and 30),
  on_due_day         boolean not null default true,
  overdue_every      integer not null default 3 check (overdue_every between 1 and 30),
  email_on           boolean not null default true,
  vendor_reminders   boolean not null default false,
  vendor_days_before integer not null default 3 check (vendor_days_before between 1 and 30),
  cash_limit         numeric not null default 10000 check (cash_limit >= 0 and cash_limit < 100000000),
  gst_warn_days      integer not null default 150 check (gst_warn_days between 30 and 179),
  tds_section        text check (tds_section is null or tds_section ~ '^19[0-9][A-Z]{0,3}$'),
  tds_pct            numeric check (tds_pct is null or (tds_pct > 0 and tds_pct <= 30)),
  late_who           text not null default 'admin' check (late_who in ('admin', 'finance')),
  updated_at         timestamptz not null default now(),
  updated_by         uuid
);

-- a photo / PDF added to a bill after it was saved (insert only; the bill row is never edited)
create table if not exists public.vendor_bill_files (
  id          uuid primary key default gen_random_uuid(),
  org_id      uuid not null references public.organizations(id) on delete cascade,
  quote_id    uuid not null references public.quotes(id) on delete cascade,
  bill_id     uuid not null references public.vendor_bills(id) on delete cascade,
  file_id     uuid not null references public.event_files(id) on delete cascade,
  created_by  uuid,
  created_at  timestamptz not null default now()
);
create index if not exists vendor_bill_files_bill373 on public.vendor_bill_files (bill_id);
create index if not exists vendor_bill_files_org373 on public.vendor_bill_files (org_id);
create index if not exists vendor_bill_files_quote373 on public.vendor_bill_files (quote_id);
create index if not exists vendor_bill_files_file373 on public.vendor_bill_files (file_id);

-- a bill added after the event was closed (the reason + who / when; written BEFORE the bill, in the same transaction)
create table if not exists public.vendor_bill_late (
  id          uuid primary key default gen_random_uuid(),
  org_id      uuid not null references public.organizations(id) on delete cascade,
  quote_id    uuid not null references public.quotes(id) on delete cascade,
  bill_id     uuid not null unique references public.vendor_bills(id) on delete cascade deferrable initially deferred,
  reason      text not null check (char_length(btrim(reason)) between 10 and 500),
  closed_at   timestamptz,
  tx          bigint not null default txid_current(),
  created_by  uuid,
  created_at  timestamptz not null default now()
);
create index if not exists vendor_bill_late_org373 on public.vendor_bill_late (org_id);
create index if not exists vendor_bill_late_quote373 on public.vendor_bill_late (quote_id);

-- one row per bill and reminder slot (the "never twice" guard)
create table if not exists public.vendor_bill_reminders (
  id          uuid primary key default gen_random_uuid(),
  org_id      uuid not null references public.organizations(id) on delete cascade,
  quote_id    uuid not null references public.quotes(id) on delete cascade,
  bill_id     uuid not null references public.vendor_bills(id) on delete cascade,
  slot        text not null check (slot ~ '^(before|due|overdue:[0-9]{1,3}|vendor_before)$'),
  kind        text not null check (kind in ('before', 'due', 'overdue', 'vendor_before')),
  due_on      date not null,
  open_amount numeric not null,
  recipients  jsonb not null default '[]'::jsonb check (jsonb_typeof(recipients) = 'array'),
  emails      integer not null default 0,
  created_at  timestamptz not null default now()
);
create unique index if not exists vendor_bill_reminders_once373 on public.vendor_bill_reminders (bill_id, slot);
create index if not exists vendor_bill_reminders_org373 on public.vendor_bill_reminders (org_id);
create index if not exists vendor_bill_reminders_quote373 on public.vendor_bill_reminders (quote_id);

-- the e-mail queue (claimed by comms-dispatch with the service role)
create table if not exists public.vendor_bill_mail_outbox (
  id          uuid primary key default gen_random_uuid(),
  org_id      uuid not null references public.organizations(id) on delete cascade,
  bill_id     uuid not null references public.vendor_bills(id) on delete cascade,
  reminder_id uuid not null references public.vendor_bill_reminders(id) on delete cascade,
  audience    text not null check (audience in ('office', 'vendor')),
  profile_id  uuid,
  recipient   text not null check (char_length(recipient) between 3 and 200),
  name        text check (name is null or char_length(name) <= 120),
  dedupe_key  text not null check (char_length(dedupe_key) <= 200),
  status      text not null default 'pending' check (status in ('pending', 'sent', 'skipped', 'failed')),
  reason      text check (reason is null or char_length(reason) <= 60),
  attempts    integer not null default 0,
  claimed_at  timestamptz,
  sent_at     timestamptz,
  created_at  timestamptz not null default now()
);
create unique index if not exists vendor_bill_mail_outbox_dedupe373 on public.vendor_bill_mail_outbox (dedupe_key);
create index if not exists vendor_bill_mail_outbox_pending373 on public.vendor_bill_mail_outbox (created_at) where sent_at is null;
create index if not exists vendor_bill_mail_outbox_org373 on public.vendor_bill_mail_outbox (org_id);
create index if not exists vendor_bill_mail_outbox_bill373 on public.vendor_bill_mail_outbox (bill_id);
create index if not exists vendor_bill_mail_outbox_rem373 on public.vendor_bill_mail_outbox (reminder_id);

-- payouts: three NEW nullable columns (every existing row keeps them empty = an ordinary payment)
alter table public.vendor_payouts add column if not exists source text;
alter table public.vendor_payouts add column if not exists tds_section text;
alter table public.vendor_payouts add column if not exists payout_ref uuid;
comment on column public.vendor_payouts.source is '0373: empty / manual = a payment; tds = tax deducted at source (counts as settled); advance = a typed booking advance turned into a payout';
comment on column public.vendor_payouts.payout_ref is '0373: the cash payout a TDS row belongs to (no foreign key: payouts are immutable)';
do $$ begin
  if not exists (select 1 from pg_constraint where conrelid = 'public.vendor_payouts'::regclass and conname = 'vendor_payouts_src_0373_ck') then
    alter table public.vendor_payouts add constraint vendor_payouts_src_0373_ck
      check ((source is null or source in ('manual', 'tds', 'advance'))
             and (tds_section is null or tds_section ~ '^19[0-9][A-Z]{0,3}$')
             and (source is distinct from 'tds' or tds_section is not null));
  end if;
end $$;
create index if not exists ix_vendor_payouts_src373 on public.vendor_payouts (org_id, source) where source is not null;

-- RLS on, no grants (only the functions below read or write the new tables), the studio guards every table has
do $$
declare t text;
begin
  foreach t in array array['vendor_bill_settings', 'vendor_bill_files', 'vendor_bill_late', 'vendor_bill_reminders', 'vendor_bill_mail_outbox'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('alter table public.%I force row level security', t);
    execute format('revoke all on table public.%I from public', t);
    if exists (select 1 from pg_roles where rolname = 'anon') then execute format('revoke all on table public.%I from anon', t); end if;
    if exists (select 1 from pg_roles where rolname = 'authenticated') then execute format('revoke all on table public.%I from authenticated', t); end if;
    if to_regprocedure('public.tg_studio_read_only()') is not null
       and not exists (select 1 from pg_trigger where tgrelid = format('public.%I', t)::regclass and tgname = 'zzz_studio_read_only') then
      execute format('create trigger zzz_studio_read_only before insert or update or delete on public.%I for each row execute function public.tg_studio_read_only(%L)', t, 'org_id');
    end if;
  end loop;
  if to_regprocedure('public.tg_quote_org_match()') is not null then
    foreach t in array array['vendor_bill_files', 'vendor_bill_late', 'vendor_bill_reminders'] loop
      if not exists (select 1 from pg_trigger where tgrelid = format('public.%I', t)::regclass and tgname = 'zz_quote_org_match') then
        execute format('create trigger zz_quote_org_match before insert or update on public.%I for each row execute function public.tg_quote_org_match()', t);
      end if;
    end loop;
  end if;
end $$;

-- ---- 2) helpers (server only) -----------------------------------------------------------------------------------------
create or replace function public._r373_cfg(p_org uuid)
returns jsonb language sql stable security definer set search_path = '' as $fn$
  -- r190-0373: the studio setting, or the defaults (saved = false)
  select coalesce((select jsonb_build_object('enabled', s.enabled, 'payer_kind', s.payer_kind, 'payer_role', s.payer_role,
                            'payer_profile', s.payer_profile, 'days_before', s.days_before, 'on_due_day', s.on_due_day,
                            'overdue_every', s.overdue_every, 'email_on', s.email_on, 'vendor_reminders', s.vendor_reminders,
                            'vendor_days_before', s.vendor_days_before, 'cash_limit', s.cash_limit, 'gst_warn_days', s.gst_warn_days,
                            'tds_section', s.tds_section, 'tds_pct', s.tds_pct, 'late_who', s.late_who, 'saved', true)
                     from public.vendor_bill_settings s where s.org_id = p_org),
                  jsonb_build_object('enabled', true, 'payer_kind', 'role', 'payer_role', 'admin', 'payer_profile', null,
                            'days_before', 3, 'on_due_day', true, 'overdue_every', 3, 'email_on', true, 'vendor_reminders', false,
                            'vendor_days_before', 3, 'cash_limit', 10000, 'gst_warn_days', 150, 'tds_section', null, 'tds_pct', null,
                            'late_who', 'admin', 'saved', false));
$fn$;

-- what is still open on a bill (amount - every payout row, TDS and converted advances included)
create or replace function public._r373_open(p_bill uuid)
returns numeric language sql stable security definer set search_path = '' as $fn$
  -- r190-0373
  select greatest(0, b.amount - coalesce((select sum(p.amount) from public.vendor_payouts p where p.bill_id = b.id), 0))
    from public.vendor_bills b where b.id = p_bill;
$fn$;

-- "Rs 18,000" / "AED 1,250.50" (ASCII, for bell labels; e-mails format their own)
create or replace function public._r373_money(p_n numeric, p_cur text)
returns text language sql stable set search_path = '' as $fn$
  -- r190-0373
  select case when upper(coalesce(nullif(btrim(p_cur), ''), 'INR')) = 'INR' then 'Rs ' else upper(btrim(p_cur)) || ' ' end
         || case when round(coalesce(p_n, 0)) = round(coalesce(p_n, 0), 2) then to_char(round(coalesce(p_n, 0)), 'FM999,999,999,990')
                 else to_char(round(coalesce(p_n, 0), 2), 'FM999,999,999,990.00') end;
$fn$;

-- the "who pays vendors" people: [{ profile_id, name, email }] - one named person, or every active member with the role;
-- nobody matching (person left, role empty) = the admins + the studio owner. Clients / crew logins never.
create or replace function public._r373_people(p_org uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $fn$
-- r190-0373
declare c jsonb := public._r373_cfg(p_org); v_owner uuid := public._r283_owner(p_org); v jsonb;
begin
  if p_org is null then return '[]'::jsonb; end if;
  with office as (
    select p.id, lower(coalesce(p.role, '')) as role,
           coalesce(nullif(btrim(p.full_name), ''), nullif(split_part(coalesce(p.email, ''), '@', 1), ''), 'Team member') as name, p.email
      from public.profiles p
     where p.org_id = p_org and lower(coalesce(p.role, '')) not in ('', 'client', 'crew', 'worker')
       and not public._r283_is_off(p.id, p_org)
  ), chosen as (
    select o.* from office o
     where (c ->> 'payer_kind' = 'person' and o.id::text = coalesce(c ->> 'payer_profile', ''))
        or (c ->> 'payer_kind' = 'role' and o.role = coalesce(c ->> 'payer_role', 'admin'))
  ), picked as (
    select * from chosen
    union all
    select o.* from office o where not exists (select 1 from chosen) and (o.role = 'admin' or o.id = v_owner)
  )
  select coalesce(jsonb_agg(jsonb_build_object(
           'profile_id', x.id, 'name', left(x.name, 120),
           'email', (select e.v from (select coalesce(
               public._r361_email((select cm.email from public.crew_members cm where cm.org_id = p_org and cm.profile_id = x.id and cm.active
                                    order by cm.created_at limit 1)),
               public._r361_email(x.email)) as v) e
              where e.v is not null and not coalesce(public._r283_off_email(p_org, e.v), false)))
           order by x.name), '[]'::jsonb)
    into v from (select distinct on (id) * from picked order by id) x;
  return v;
end $fn$;

-- the local hour of the studio (0..23), for "not before 9:00"
create or replace function public._r373_hour(p_org uuid, p_now timestamptz)
returns integer language plpgsql stable security definer set search_path = '' as $fn$
-- r190-0373
begin
  return extract(hour from (p_now at time zone public._r23_tz(p_org)))::integer;
exception when others then
  return extract(hour from (p_now at time zone 'Asia/Kolkata'))::integer;
end $fn$;

-- the reminder slot for a bill on the day of the studio: before / due / overdue:<n> (null = nothing today)
create or replace function public._r373_slot(p_due date, p_today date, p_cfg jsonb)
returns text language plpgsql immutable set search_path = '' as $fn$
-- r190-0373
declare d integer; n integer := greatest(1, coalesce((p_cfg ->> 'overdue_every')::integer, 3)); b integer := coalesce((p_cfg ->> 'days_before')::integer, 3);
begin
  if p_due is null or p_today is null then return null; end if;
  d := p_due - p_today;
  if d > 0 and b > 0 and d = b then return 'before'; end if;
  if d = 0 and coalesce((p_cfg ->> 'on_due_day')::boolean, true) then return 'due'; end if;
  if d < 0 and -d <= 180 and ((-d - 1) % n) = 0 then return 'overdue:' || (-d)::text; end if;
  return null;
end $fn$;

-- ---- 3) the hourly reminder timer ----------------------------------------------------------------------------------------
create or replace function public.vendor_bill_reminder_tick(p_now timestamptz default null)
returns jsonb language plpgsql volatile security definer set search_path = '' as $fn$
-- r190-0373: open vendor bills with a due date -> the payers (bell + e-mail; trial = bell only) and, when the studio turned
-- it on, the vendor. One vendor_bill_reminders row per bill and slot = never twice. From 9:00 studio time only.
declare r record; c jsonb; v_now timestamptz := coalesce(p_now, now()); v_today date; v_slot text; v_kind text; v_open numeric;
        v_id uuid; v_people jsonb; p jsonb; v_trial boolean; v_mail boolean; v_n integer; v_label text; v_notify jsonb;
        v_sent integer := 0; v_vend integer := 0; v_to text; v_cur text; v_days integer; v_vname text;
begin
  for r in
    select b.id, b.org_id, b.quote_id, b.vendor_id, b.bill_no, b.amount, b.due_date, b.currency,
           coalesce(nullif(btrim(q.title), ''), 'the event') as event
      from public.vendor_bills b
      join public.quotes q on q.id = b.quote_id and q.org_id = b.org_id
     where b.status = 'open' and b.due_date is not null
       and b.due_date between (v_now at time zone 'UTC')::date - 182 and (v_now at time zone 'UTC')::date + 32
       and q.deleted_at is null and not coalesce(q.is_demo, false)
       and b.amount > coalesce((select sum(x.amount) from public.vendor_payouts x where x.bill_id = b.id), 0) + 0.005
     order by b.due_date, b.id
     limit 5000
  loop
    begin
      if coalesce(public._trial_locked(r.org_id), false) then continue; end if;
      c := public._r373_cfg(r.org_id);
      continue when not coalesce((c ->> 'enabled')::boolean, true);
      continue when public._r373_hour(r.org_id, v_now) < 9;
      v_today := public._a198_org_today(r.org_id);
      v_open := public._r373_open(r.id);
      continue when coalesce(v_open, 0) <= 0.005;
      v_cur := coalesce(nullif(upper(btrim(r.currency)), ''), 'INR');
      v_days := r.due_date - v_today;
      v_trial := coalesce(public.trial_send_blocked(r.org_id, r.quote_id, null), false);
      v_vname := coalesce((select nullif(btrim(v.name), '') from public.vendors v where v.id = r.vendor_id and v.org_id = r.org_id), 'a vendor');

      -- (a) the office (the payers)
      v_slot := public._r373_slot(r.due_date, v_today, c);
      if v_slot is not null then
        v_kind := split_part(v_slot, ':', 1);
        v_id := null;
        insert into public.vendor_bill_reminders (org_id, quote_id, bill_id, slot, kind, due_on, open_amount)
        values (r.org_id, r.quote_id, r.id, v_slot, v_kind, r.due_date, v_open)
        on conflict (bill_id, slot) do nothing
        returning id into v_id;
        if v_id is not null then
          v_people := public._r373_people(r.org_id);
          v_mail := coalesce((c ->> 'email_on')::boolean, true) and not v_trial
                    and not coalesce(public._sample_outbound_blocked(r.org_id, null::text), false);
          v_n := 0;
          if v_mail then
            for p in select x from jsonb_array_elements(v_people) x loop
              continue when (p ->> 'email') is null;
              insert into public.vendor_bill_mail_outbox (org_id, bill_id, reminder_id, audience, profile_id, recipient, name, dedupe_key)
              values (r.org_id, r.id, v_id, 'office', (p ->> 'profile_id')::uuid, p ->> 'email', left(p ->> 'name', 120),
                      'vb|' || v_id::text || '|' || (p ->> 'profile_id'))
              on conflict (dedupe_key) do nothing;
              if found then v_n := v_n + 1; end if;
            end loop;
          end if;
          select coalesce(jsonb_agg(x -> 'profile_id'), '[]'::jsonb) into v_notify from jsonb_array_elements(v_people) x;
          update public.vendor_bill_reminders
             set recipients = (select coalesce(jsonb_agg(jsonb_build_object('profile_id', x -> 'profile_id', 'name', x -> 'name',
                                                                             'emailed', v_mail and (x ->> 'email') is not null)), '[]'::jsonb)
                                 from jsonb_array_elements(v_people) x),
                 emails = v_n
           where id = v_id;
          v_label := left(case v_kind when 'before' then 'Vendor bill due in ' || v_days || case when v_days = 1 then ' day: ' else ' days: ' end
                                      when 'due' then 'Vendor bill due today: '
                                      else 'Vendor bill overdue by ' || (-v_days) || case when v_days = -1 then ' day: ' else ' days: ' end end
                          || public._r373_money(v_open, v_cur) || ' to ' || v_vname
                          || case when r.bill_no is not null then ' (#' || left(r.bill_no, 40) || ')' else '' end
                          || ' - ' || left(r.event, 120), 300);
          if jsonb_array_length(v_notify) > 0 then
            begin
              insert into public.notifications (quote_id, channel, kind, status, detail, org_id)
              values (r.quote_id, 'in_app', 'vendor_bill_due', 'simulated',
                      jsonb_build_object('label', v_label, 'bill_id', r.id, 'vendor', v_vname, 'bill_no', r.bill_no,
                                         'open', v_open, 'currency', v_cur, 'due', r.due_date, 'days', v_days, 'slot', v_slot,
                                         'notify', v_notify, 'source', '0373'),
                      r.org_id);
            exception when others then raise warning 'r190-0373: bell notice skipped (%)', sqlstate;
            end;
          end if;
          v_sent := v_sent + 1;
        end if;
      end if;

      -- (b) the vendor (only when the studio turned it on; e-mail only; never on a trial / sample)
      if coalesce((c ->> 'vendor_reminders')::boolean, false) and v_days = coalesce((c ->> 'vendor_days_before')::integer, 3) and not v_trial then
        v_to := public._r361_email((select v.email from public.vendors v where v.id = r.vendor_id and v.org_id = r.org_id));
        if v_to is not null and public._dl241_send_block(r.org_id, v_to, false) is null
           and not coalesce(public.email_is_opted_out(r.org_id, v_to), false)
           and not coalesce(public._sample_outbound_blocked(r.org_id, v_to), false) then
          v_id := null;
          insert into public.vendor_bill_reminders (org_id, quote_id, bill_id, slot, kind, due_on, open_amount, emails)
          values (r.org_id, r.quote_id, r.id, 'vendor_before', 'vendor_before', r.due_date, v_open, 1)
          on conflict (bill_id, slot) do nothing
          returning id into v_id;
          if v_id is not null then
            insert into public.vendor_bill_mail_outbox (org_id, bill_id, reminder_id, audience, recipient, name, dedupe_key)
            values (r.org_id, r.id, v_id, 'vendor', v_to, left(v_vname, 120), 'vbv|' || v_id::text)
            on conflict (dedupe_key) do nothing;
            v_vend := v_vend + 1;
          end if;
        end if;
      end if;
    exception when others then
      raise warning 'r190-0373: bill % reminder skipped (%)', r.id, sqlstate;
    end;
  end loop;
  return jsonb_build_object('office', v_sent, 'vendor', v_vend);
end $fn$;

-- comms-dispatch takes due e-mails (service role); each is re-checked: bill still open, studio may send, recipient still a
-- payer (office) / still the address of the vendor and the studio switch still on (vendor), at most 20 hours old
create or replace function public.vendor_bill_reminder_claim(p_limit integer default 25)
returns jsonb language plpgsql volatile security definer set search_path = '' as $fn$
-- r190-0373
declare s record; v_out jsonb := '[]'::jsonb; b public.vendor_bills; c jsonb; v_ok boolean; v_open numeric; v_today date;
        v_ident jsonb; v_rem public.vendor_bill_reminders; q record; v_vname text;
begin
  update public.vendor_bill_mail_outbox set status = 'failed', sent_at = now() where sent_at is null and attempts >= 5;
  update public.vendor_bill_mail_outbox set status = 'skipped', reason = 'stale', sent_at = now()
   where sent_at is null and created_at < now() - interval '20 hours';
  for s in select x.* from public.vendor_bill_mail_outbox x
            where x.sent_at is null and x.status = 'pending' and (x.claimed_at is null or x.claimed_at < now() - interval '10 minutes')
            order by x.created_at limit greatest(1, least(coalesce(p_limit, 25), 100)) for update of x skip locked loop
    select * into b from public.vendor_bills where id = s.bill_id and org_id = s.org_id;
    select * into v_rem from public.vendor_bill_reminders where id = s.reminder_id;
    select x.id, x.title, x.event_date, x.deleted_at, x.is_demo into q from public.quotes x where x.id = b.quote_id;
    c := public._r373_cfg(s.org_id);
    v_open := case when b.id is not null then public._r373_open(b.id) end;
    v_ok := b.id is not null and b.status = 'open' and coalesce(v_open, 0) > 0.005 and q.id is not null and q.deleted_at is null
            and not coalesce(q.is_demo, false) and coalesce((c ->> 'enabled')::boolean, true)
            and not coalesce(public.trial_send_blocked(s.org_id, b.quote_id, null), false)
            and not coalesce(public._trial_locked(s.org_id), false);
    if v_ok and s.audience = 'office' then
      v_ok := coalesce((c ->> 'email_on')::boolean, true)
              and exists (select 1 from jsonb_array_elements(public._r373_people(s.org_id)) x
                           where x ->> 'profile_id' = s.profile_id::text and lower(x ->> 'email') = lower(s.recipient));
    elsif v_ok then
      v_ok := coalesce((c ->> 'vendor_reminders')::boolean, false)
              and lower(coalesce(public._r361_email((select v.email from public.vendors v where v.id = b.vendor_id and v.org_id = b.org_id)), '')) = lower(s.recipient)
              and not coalesce(public.email_is_opted_out(s.org_id, s.recipient), false)
              and public._dl241_send_block(s.org_id, s.recipient, false) is null;
    end if;
    if not v_ok then
      update public.vendor_bill_mail_outbox set status = 'skipped', reason = 'recheck', sent_at = now() where id = s.id;
      continue;
    end if;
    v_today := public._a198_org_today(s.org_id);
    select jsonb_build_object('from_name', cs.email_from_name, 'reply_to', cs.email_reply_to) into v_ident
      from public.comms_settings cs where cs.org_id = s.org_id;
    v_vname := (select nullif(btrim(v.name), '') from public.vendors v where v.id = b.vendor_id and v.org_id = b.org_id);
    update public.vendor_bill_mail_outbox set claimed_at = now(), attempts = attempts + 1 where id = s.id;
    v_out := v_out || jsonb_build_array(jsonb_build_object(
      'id', s.id, 'to', s.recipient, 'name', s.name, 'audience', s.audience, 'kind', v_rem.kind,
      'studio', (select o.name from public.organizations o where o.id = s.org_id),
      'vendor', v_vname, 'bill_no', b.bill_no, 'amount', b.amount, 'open', v_open,
      'currency', coalesce(nullif(upper(btrim(b.currency)), ''), 'INR'),
      'due_text', to_char(b.due_date, 'DD/MM/YYYY'), 'days', b.due_date - v_today,
      'event', coalesce(nullif(btrim(q.title), ''), 'the event'), 'event_date', to_char(q.event_date, 'DD/MM/YYYY'),
      'quote_id', b.quote_id, 'identity', coalesce(v_ident, '{}'::jsonb)));
  end loop;
  return v_out;
end $fn$;

create or replace function public.vendor_bill_reminder_mark(p_id uuid, p_status text)
returns text language plpgsql volatile security definer set search_path = '' as $fn$
-- r190-0373
begin
  if p_status not in ('sent', 'skipped', 'failed', 'retry') then raise exception 'bad status' using errcode = '22023'; end if;
  if p_status = 'retry' then
    update public.vendor_bill_mail_outbox set claimed_at = null where id = p_id and sent_at is null;
    return 'pending';
  end if;
  update public.vendor_bill_mail_outbox set status = p_status, sent_at = now() where id = p_id and sent_at is null;
  return p_status;
end $fn$;

-- ---- 4) pay a bill: cash part + TDS part (two payout rows), allowed after the event closed, cash warning --------------------
create or replace function public.vendor_bill_pay(p_bill uuid, p_amount numeric, p_tds numeric, p_tds_section text,
  p_paid_on date, p_method text, p_reference text, p_key text)
returns jsonb language plpgsql volatile security definer set search_path = '' as $fn$
-- r190-0373: Finance edit, own studio. Idempotent (same key = the same payment, never twice). Never more than what is
-- open. TDS (optional) is its own payout row (source tds + section): the bill counts as settled, every "paid" sum stays right.
declare v_org uuid := public.current_org_id(); b public.vendor_bills; v_key text := nullif(btrim(coalesce(p_key, '')), '');
        v_amt numeric := round(coalesce(p_amount, 0), 2); v_tds numeric := round(coalesce(p_tds, 0), 2); v_open numeric;
        v_sec text := nullif(upper(btrim(coalesce(p_tds_section, ''))), ''); v_row public.vendor_payouts; v_trow public.vendor_payouts;
        v_method text := left(nullif(btrim(coalesce(p_method, '')), ''), 40); v_ref text := left(nullif(btrim(coalesce(p_reference, '')), ''), 120);
        v_day date; c jsonb; v_cash numeric; v_warn jsonb := '[]'::jsonb; v_closed boolean; v_today date;
begin
  if auth.uid() is null or v_org is null or not public.has_area('finance', 'edit') then
    raise exception 'not authorized' using errcode = '42501'; end if;
  if v_key is not null and length(v_key) > 90 then raise exception 'idempotency key too long' using errcode = '22023'; end if;
  if v_key is not null then
    select * into v_row from public.vendor_payouts p where p.org_id = v_org and p.idempotency_key = v_key;
    if found then
      if v_row.bill_id <> p_bill then raise exception 'idempotency key already used for another bill' using errcode = '22023'; end if;
      select * into v_trow from public.vendor_payouts p where p.org_id = v_org and p.idempotency_key = v_key || ':tds';
      return jsonb_build_object('ok', true, 'duplicate', true, 'payout', to_jsonb(v_row),
                                'tds_payout', case when v_trow.id is not null then to_jsonb(v_trow) end, 'warnings', '[]'::jsonb);
    end if;
    if exists (select 1 from public.vendor_payouts p where p.org_id = v_org and p.idempotency_key = v_key || ':tds') then
      return jsonb_build_object('ok', true, 'duplicate', true, 'warnings', '[]'::jsonb);
    end if;
  end if;
  select * into b from public.vendor_bills x where x.id = p_bill and x.org_id = v_org for update;
  if not found then raise exception 'bill not found' using errcode = 'P0002'; end if;
  if b.status = 'void' then raise exception 'This bill is void.' using errcode = '22023'; end if;
  if v_amt < 0 or v_tds < 0 then raise exception 'Amounts cannot be below zero.' using errcode = '22023'; end if;
  if v_amt + v_tds <= 0 then raise exception 'Enter an amount above zero.' using errcode = '22023'; end if;
  if v_tds > 0 then
    if v_sec is null or v_sec !~ '^19[0-9][A-Z]{0,3}$' then
      raise exception 'Give the TDS section (for example 194C).' using errcode = '22023'; end if;
    if v_tds > b.amount * 0.35 then raise exception 'That TDS looks too high for this bill - check the amount.' using errcode = '22023'; end if;
  end if;
  v_today := public._a198_org_today(v_org);
  v_day := coalesce(p_paid_on, v_today);
  if v_day > v_today + 1 then raise exception 'The payment date is in the future.' using errcode = '22023'; end if;
  v_open := public._r373_open(b.id);
  if v_amt + v_tds > v_open + 0.005 then
    raise exception 'That would overpay the bill: only % is left to pay.', to_char(v_open, 'FM999999999990.00') using errcode = '22023';
  end if;
  v_closed := exists (select 1 from public.event_closure ec where ec.quote_id = b.quote_id and ec.closed_at is not null);
  if v_amt > 0 then
    insert into public.vendor_payouts(bill_id, org_id, amount, paid_on, method, reference, idempotency_key, source)
    values (b.id, v_org, v_amt, v_day, v_method, v_ref, v_key, 'manual')
    returning * into v_row;
  end if;
  if v_tds > 0 then
    insert into public.vendor_payouts(bill_id, org_id, amount, paid_on, method, reference, idempotency_key, source, tds_section, payout_ref)
    values (b.id, v_org, v_tds, v_day, 'TDS ' || v_sec, v_ref, case when v_key is not null then v_key || ':tds' end, 'tds', v_sec, v_row.id)
    returning * into v_trow;
  end if;
  -- cash over the studio limit to one vendor in one day (Section 40A(3)): a warning, never a block
  c := public._r373_cfg(v_org);
  if v_amt > 0 and coalesce(v_method, '') ~* '^cash' and coalesce((c ->> 'cash_limit')::numeric, 10000) > 0 then
    select coalesce(sum(p.amount), 0) into v_cash
      from public.vendor_payouts p join public.vendor_bills x on x.id = p.bill_id
     where p.org_id = v_org and p.paid_on = v_day and coalesce(p.source, 'manual') = 'manual' and coalesce(p.method, '') ~* '^cash'
       and ((b.vendor_id is not null and x.vendor_id = b.vendor_id) or (b.vendor_id is null and x.id = b.id));
    if v_cash > (c ->> 'cash_limit')::numeric then
      v_warn := v_warn || jsonb_build_array(jsonb_build_object('code', 'cash_limit', 'total', v_cash, 'limit', (c ->> 'cash_limit')::numeric,
        'text', 'Cash paid to this vendor today is ' || public._r373_money(v_cash, b.currency) || ', over the '
                || public._r373_money((c ->> 'cash_limit')::numeric, b.currency) || ' limit. Cash above the limit to one person in a day may not count as a business expense (Section 40A(3)) - pay by bank or UPI next time.'));
    end if;
  end if;
  return jsonb_build_object('ok', true, 'duplicate', false, 'payout', case when v_row.id is not null then to_jsonb(v_row) end,
    'tds_payout', case when v_trow.id is not null then to_jsonb(v_trow) end,
    'paid', b.amount - v_open + v_amt + v_tds, 'balance', greatest(0, v_open - v_amt - v_tds),
    'after_close', v_closed, 'warnings', v_warn);
end $fn$;

-- ---- 5) typed advances -> payout rows (added rows only; the typed advance is kept and locked) -------------------------------
-- how much of the typed advance of a booking is already a payout row
create or replace function public._r373_converted(p_booking uuid)
returns numeric language sql stable security definer set search_path = '' as $fn$
  -- r190-0373
  select coalesce(sum(p.amount), 0) from public.vendor_payouts p join public.vendor_bills b on b.id = p.bill_id
   where b.booking_id = p_booking and p.source = 'advance';
$fn$;

create or replace function public.vendor_bill_convert_advances(p_quote uuid)
returns jsonb language plpgsql volatile security definer set search_path = '' as $fn$
-- r190-0373: Finance edit. For each booking of the event with a typed advance: what is not converted yet goes onto its bills,
-- oldest first, never more than the open amount of a bill (one row per booking and bill; running it again adds nothing).
declare v_org uuid := public.current_org_id(); bk record; bl record; v_left numeric; v_open numeric; v_use numeric;
        v_rows integer := 0; v_total numeric := 0; v_today date; v_key text;
begin
  if auth.uid() is null or v_org is null or not public.has_area('finance', 'edit') then
    raise exception 'not authorized' using errcode = '42501'; end if;
  if not exists (select 1 from public.quotes q where q.id = p_quote and q.org_id = v_org) then
    raise exception 'event not found' using errcode = 'P0002'; end if;
  perform pg_advisory_xact_lock(hashtextextended('helm:vbadv:' || p_quote::text, 0));
  v_today := public._a198_org_today(v_org);
  for bk in select b.id, coalesce(b.advance, 0) as advance from public.event_resources b
             where b.quote_id = p_quote and b.org_id = v_org and b.status <> 'cancelled' and coalesce(b.advance, 0) > 0 order by b.created_at, b.id loop
    v_left := bk.advance - public._r373_converted(bk.id);
    continue when v_left <= 0.005;
    for bl in select x.id from public.vendor_bills x where x.booking_id = bk.id and x.org_id = v_org and x.status <> 'void'
               order by x.bill_date, x.created_at, x.id for update of x loop
      exit when v_left <= 0.005;
      v_open := public._r373_open(bl.id);
      v_use := round(least(v_open, v_left), 2);
      continue when v_use <= 0.005;
      v_key := 'adv:' || bk.id::text || ':' || bl.id::text;
      continue when exists (select 1 from public.vendor_payouts p where p.org_id = v_org and p.idempotency_key = v_key);
      insert into public.vendor_payouts(bill_id, org_id, amount, paid_on, method, reference, idempotency_key, source)
      values (bl.id, v_org, v_use, v_today, 'Advance (typed earlier)', 'Advance typed on the vendor booking', v_key, 'advance');
      v_left := v_left - v_use; v_rows := v_rows + 1; v_total := v_total + v_use;
    end loop;
  end loop;
  return jsonb_build_object('ok', true, 'rows', v_rows, 'amount', v_total);
end $fn$;

-- once part of a typed advance is a payout row, the typed number can not change any more (it would no longer add up)
create or replace function public.tg_r373_advance_lock()
returns trigger language plpgsql security definer set search_path = '' as $fn$
-- r190-0373
begin
  if coalesce(auth.role(), '') not in ('anon', 'authenticated') then return new; end if;
  if new.advance is distinct from old.advance and public._r373_converted(old.id) > 0 then
    raise exception 'This advance is already recorded as a payment on the vendor bill - record a payout on the bill instead of changing the advance.'
      using errcode = '23514', hint = 'advance_converted';
  end if;
  return new;
end $fn$;
drop trigger if exists ad_r373_advance_lock on public.event_resources;
create trigger ad_r373_advance_lock before update of advance on public.event_resources
  for each row execute function public.tg_r373_advance_lock();

-- the cost ledger: the "paid" of a booking line was payouts + the typed advance; converted rows are now payouts too, so the
-- converted part is taken off once (wrapped once, old body kept as _r21_cost_lines__pre0373)
do $$
declare v_src text;
begin
  select p.prosrc into v_src from pg_proc p where p.oid = to_regprocedure('public._r21_cost_lines(uuid,uuid)');
  if position('r190-0373' in coalesce(v_src, '')) = 0 and to_regprocedure('public._r21_cost_lines__pre0373(uuid,uuid)') is null then
    alter function public._r21_cost_lines(uuid, uuid) rename to _r21_cost_lines__pre0373;
  end if;
  if to_regprocedure('public._r21_cost_lines__pre0373(uuid,uuid)') is null then
    raise exception 'STOP 0373: _r21_cost_lines could not be kept as _r21_cost_lines__pre0373'; end if;
end $$;

create or replace function public._r21_cost_lines(p_quote uuid, p_org uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $fn$
-- r190-0373: the kept ledger (_r21_cost_lines__pre0373 = the r21-money-0246 / r22-money-0252 / r23-crew-0265 body) unchanged,
-- except the "paid" of a booking line no longer counts a converted typed advance twice (payout rows with source advance are already in it)
declare v jsonb := public._r21_cost_lines__pre0373(p_quote, p_org);
begin
  if v is null or jsonb_typeof(v) <> 'array' then return v; end if;
  if not exists (select 1 from public.vendor_payouts p join public.vendor_bills b on b.id = p.bill_id
                  where b.quote_id = p_quote and b.org_id = p_org and p.source = 'advance') then return v; end if;
  return coalesce((select jsonb_agg(case when e.i ->> 'source' = 'booking' and (e.i ->> 'paid') is not null
                                          then jsonb_set(e.i, '{paid}', to_jsonb(greatest(0, (e.i ->> 'paid')::numeric
                                                 - public._r373_converted(nullif(e.i ->> 'source_id', '')::uuid))))
                                          else e.i end order by e.o)
                     from jsonb_array_elements(v) with ordinality e(i, o)), v);
end $fn$;

-- ---- 6) a photo / PDF added to a bill later ------------------------------------------------------------------------------
create or replace function public.vendor_bill_attach(p_bill uuid, p_file uuid)
returns jsonb language plpgsql volatile security definer set search_path = '' as $fn$
-- r190-0373: Finance edit, own studio; the file must be one of the files of the same event
declare v_org uuid := public.current_org_id(); b public.vendor_bills; v_id uuid;
begin
  if auth.uid() is null or v_org is null or not public.has_area('finance', 'edit') then
    raise exception 'not authorized' using errcode = '42501'; end if;
  select * into b from public.vendor_bills x where x.id = p_bill and x.org_id = v_org;
  if not found then raise exception 'bill not found' using errcode = 'P0002'; end if;
  if b.status = 'void' then raise exception 'This bill is void.' using errcode = '22023'; end if;
  if not exists (select 1 from public.event_files f where f.id = p_file and f.org_id = v_org and f.quote_id = b.quote_id) then
    raise exception 'file not found' using errcode = 'P0002'; end if;
  if (select count(*) from public.vendor_bill_files a where a.bill_id = b.id) >= 10 then
    raise exception 'A bill can have at most 10 added files.' using errcode = '22023'; end if;
  insert into public.vendor_bill_files (org_id, quote_id, bill_id, file_id, created_by)
  values (v_org, b.quote_id, b.id, p_file, auth.uid()) returning id into v_id;
  return jsonb_build_object('ok', true, 'id', v_id, 'file_id', p_file);
end $fn$;

-- ---- 7) a bill after the event closed = a late adjustment --------------------------------------------------------------------
-- the 0152 insert guard, same body, plus ONE early return: the bill a vendor_bill_add_late call is adding right now
create or replace function public.tg_a152_money_create_guard()
returns trigger language plpgsql security definer set search_path = '' as $$
-- manager-1019-0152: refunds / vendor bills checked on insert (API callers only)
-- r190-0373: a late vendor bill on a closed event is let through ONLY when vendor_bill_add_late wrote its reason row first in
-- this same transaction (vendor_bill_late, closed to the app); every other check below is unchanged
declare v_status text; v_paid numeric; v_open numeric;
begin
  if coalesce(auth.role(), '') not in ('anon', 'authenticated') then return new; end if;
  if new.quote_id is null then return new; end if;
  if tg_table_name = 'vendor_bills' and to_regclass('public.vendor_bill_late') is not null
     and exists (select 1 from public.vendor_bill_late l where l.bill_id = new.id and l.quote_id = new.quote_id and l.tx = txid_current()) then
    return new;
  end if;
  perform pg_advisory_xact_lock(hashtextextended('helm:pay:quote:' || new.quote_id::text, 0));
  select q.status into v_status from public.quotes q where q.id = new.quote_id;
  if exists (select 1 from public.event_closure c where c.quote_id = new.quote_id and c.closed_at is not null) then
    raise exception 'This event is closed - re-open it before adding a %.',
      case when tg_table_name = 'vendor_bills' then 'vendor bill' else 'refund' end
      using errcode = '23514', hint = 'event_closed';
  end if;
  if tg_table_name = 'vendor_bills' then
    if coalesce(v_status, '') = 'quote' then
      raise exception 'This quote is not confirmed yet - confirm the booking before adding a vendor bill.'
        using errcode = '23514', hint = 'not_confirmed';
    end if;
    return new;
  end if;
  -- event_refunds: money given back cannot exceed money received
  if coalesce(new.kind, 'refund') = 'refund' and coalesce(new.status, 'pending') <> 'rejected' then
    v_paid := coalesce(public.helm_total_paid(new.quote_id, null, null), 0);
    select coalesce(sum(r.amount), 0) into v_open from public.event_refunds r
     where r.quote_id = new.quote_id and coalesce(r.kind, 'refund') = 'refund' and r.status in ('pending', 'approved', 'processed');
    if coalesce(new.amount, 0) + v_open > v_paid + 0.5 then
      raise exception 'A refund can''t be more than the client has paid (paid %, already refunded or pending %).',
        to_char(v_paid, 'FM999999999990.00'), to_char(v_open, 'FM999999999990.00')
        using errcode = '23514', hint = 'refund_over_paid';
    end if;
  end if;
  return new;
end $$;
revoke all on function public.tg_a152_money_create_guard() from public, anon, authenticated;

-- may this person add a late bill? (studio setting late_who: admins only (default) or anyone with Finance edit)
create or replace function public._r373_can_late(p_org uuid)
returns boolean language sql stable security definer set search_path = '' as $fn$
  -- r190-0373
  select auth.uid() is not null and public.has_area('finance', 'edit')
     and (coalesce(public.user_role(), '') = 'admin' or auth.uid() = public._r283_owner(p_org)
          or public._r373_cfg(p_org) ->> 'late_who' = 'finance');
$fn$;

create or replace function public.vendor_bill_add_late(p_quote uuid, p jsonb, p_reason text)
returns jsonb language plpgsql volatile security definer set search_path = '' as $fn$
-- r190-0373: a vendor bill for a CLOSED event, with a reason (10..500 characters). The event is not re-opened. Every bill
-- rule still runs (amount, GST, references, not a void bill, studio read-only); only the "event is closed" check is skipped
-- for this one bill. Then the P&L snapshot hook (R189) when it exists.
declare v_org uuid := public.current_org_id(); v_id uuid := gen_random_uuid(); v_closed timestamptz; v_r text := btrim(coalesce(p_reason, ''));
        v_amt numeric; v_gst numeric; v_row public.vendor_bills; v_snap jsonb; v_booking uuid; v_vendor uuid; v_file uuid;
        v_day date; v_due date;
begin
  if auth.uid() is null or v_org is null or not public.has_area('finance', 'edit') then
    raise exception 'not authorized' using errcode = '42501'; end if;
  if not public._r373_can_late(v_org) then
    raise exception 'Only a studio admin can add a bill to a closed event (Business -> Vendor bill reminders sets who may).' using errcode = '42501'; end if;
  if p is null or jsonb_typeof(p) <> 'object' then raise exception 'bad bill' using errcode = '22023'; end if;
  select c.closed_at into v_closed from public.event_closure c where c.quote_id = p_quote and c.org_id = v_org;
  if not exists (select 1 from public.quotes q where q.id = p_quote and q.org_id = v_org and q.deleted_at is null) then
    raise exception 'event not found' using errcode = 'P0002'; end if;
  if v_closed is null then raise exception 'This event is not closed - add the bill the normal way.' using errcode = '22023'; end if;
  if char_length(v_r) < 10 or char_length(v_r) > 500 then
    raise exception 'Say why this bill came after the event was closed (10 to 500 characters).' using errcode = '22023'; end if;
  v_amt := case when (p ->> 'amount') ~ '^\s*[0-9]+(\.[0-9]+)?\s*$' then round((p ->> 'amount')::numeric, 2) end;
  if v_amt is null or v_amt <= 0 then raise exception 'Enter the bill amount (above zero).' using errcode = '22023'; end if;
  v_gst := case when nullif(btrim(coalesce(p ->> 'gst_amount', '')), '') is null then null
                when (p ->> 'gst_amount') ~ '^\s*[0-9]+(\.[0-9]+)?\s*$' then round((p ->> 'gst_amount')::numeric, 2) end;
  if nullif(btrim(coalesce(p ->> 'gst_amount', '')), '') is not null and (v_gst is null or v_gst >= v_amt) then
    raise exception 'The GST must be 0 or more and less than the bill amount.' using errcode = '22023'; end if;
  v_booking := case when (p ->> 'booking_id') ~ '^[0-9a-f-]{36}$' then (p ->> 'booking_id')::uuid end;
  v_vendor := case when (p ->> 'vendor_id') ~ '^[0-9a-f-]{36}$' then (p ->> 'vendor_id')::uuid end;
  v_file := case when (p ->> 'file_id') ~ '^[0-9a-f-]{36}$' then (p ->> 'file_id')::uuid end;
  if not public._a156_vendor_bill_refs_ok(p_quote, v_booking, v_vendor, v_file) then
    raise exception 'The booking, vendor or file is not part of this event.' using errcode = '42501'; end if;
  v_day := case when (p ->> 'bill_date') ~ '^\d{4}-\d{2}-\d{2}$' then (p ->> 'bill_date')::date else public._a198_org_today(v_org) end;
  v_due := case when (p ->> 'due_date') ~ '^\d{4}-\d{2}-\d{2}$' then (p ->> 'due_date')::date end;
  if v_due is not null and v_due < v_day then raise exception 'The due date is before the bill date.' using errcode = '22023'; end if;
  -- the reason row FIRST (same transaction): the 0152 guard lets exactly this bill through
  insert into public.vendor_bill_late (org_id, quote_id, bill_id, reason, closed_at, created_by)
  values (v_org, p_quote, v_id, v_r, v_closed, auth.uid());
  insert into public.vendor_bills (id, org_id, quote_id, booking_id, vendor_id, bill_no, bill_date, description, amount, currency,
                                   due_date, file_id, gst_amount, gst_claimable)
  values (v_id, v_org, p_quote, v_booking, v_vendor, left(nullif(btrim(coalesce(p ->> 'bill_no', '')), ''), 80), v_day,
          left(nullif(btrim(coalesce(p ->> 'description', '')), ''), 500), v_amt,
          coalesce(nullif(upper(left(btrim(coalesce(p ->> 'currency', '')), 3)), ''),
                   (select coalesce(nullif(upper(btrim(q.currency)), ''), 'INR') from public.quotes q where q.id = p_quote)),
          v_due, v_file, v_gst, case when v_gst is not null and jsonb_typeof(p -> 'gst_claimable') = 'boolean' then (p ->> 'gst_claimable')::boolean end)
  returning * into v_row;
  begin
    insert into public.audit_log(actor, action, entity, entity_id, changed, org_id)
      values (auth.uid(), 'vendor_bill.late', 'vendor_bills', v_id::text,
              jsonb_build_object('quote_id', p_quote, 'amount', v_amt, 'reason', v_r, 'closed_at', v_closed), v_org);
  exception when others then raise warning 'r190-0373: audit skipped (%)', sqlstate;
  end;
  -- R189 (P&L snapshot): a new version with this reason, when that feature is installed; never blocks the bill
  if to_regprocedure('public.pnl_snapshot_after_late_cost(uuid,text)') is not null then
    begin
      execute 'select to_jsonb(public.pnl_snapshot_after_late_cost($1, $2))' into v_snap using p_quote, 'Late vendor bill: ' || v_r;
    exception when others then raise warning 'r190-0373: P&L snapshot hook skipped (%)', sqlstate; v_snap := null;
    end;
  end if;
  return jsonb_build_object('ok', true, 'bill', to_jsonb(v_row), 'late', true, 'snapshot', v_snap);
end $fn$;

-- ---- 8) reads for the pages ------------------------------------------------------------------------------------------------
-- the Vendor bills card on Settlement: per bill extras (added files, late reason, TDS suggestion, GST 150-day warning,
-- reminders sent), per booking typed advance vs converted, the event closed flag and the studio limits
create or replace function public.vendor_bills_extra(p_quote uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $fn$
-- r190-0373: Finance view, own studio
declare v_org uuid := public.current_org_id(); c jsonb; v_today date; v_bills jsonb; v_books jsonb; v_closed boolean;
begin
  if auth.uid() is null or v_org is null or not public.has_area('finance', 'view') then
    raise exception 'not authorized' using errcode = '42501'; end if;
  if not exists (select 1 from public.quotes q where q.id = p_quote and q.org_id = v_org) then return null; end if;
  c := public._r373_cfg(v_org); v_today := public._a198_org_today(v_org);
  v_closed := exists (select 1 from public.event_closure ec where ec.quote_id = p_quote and ec.org_id = v_org and ec.closed_at is not null);
  select coalesce(jsonb_agg(jsonb_build_object(
      'id', b.id,
      'files', (select coalesce(jsonb_agg(jsonb_build_object('id', a.id, 'file_id', a.file_id, 'at', a.created_at) order by a.created_at), '[]'::jsonb)
                  from public.vendor_bill_files a where a.bill_id = b.id),
      'late', (select jsonb_build_object('reason', l.reason, 'at', l.created_at) from public.vendor_bill_late l where l.bill_id = b.id),
      'open', public._r373_open(b.id),
      'age_days', v_today - b.bill_date,
      'gst_warn', b.status = 'open' and coalesce(b.gst_amount, 0) > 0 and coalesce(b.gst_claimable, true)
                  and v_today - b.bill_date >= (c ->> 'gst_warn_days')::integer and public._r373_open(b.id) > 0.005,
      'gst_deadline', b.bill_date + 180,
      'tds_suggest', coalesce(
         (select jsonb_build_object('section', i.tds_section, 'amount', i.tds_amount, 'from', 'invoice')
            from public.vendor_invoices i where i.bill_id = b.id and i.org_id = v_org and i.status = 'approved'
             and i.tds_section is not null and coalesce(i.tds_amount, 0) > 0 order by i.reviewed_at desc nulls last limit 1),
         case when (c ->> 'tds_section') is not null and (c ->> 'tds_pct') is not null
              then jsonb_build_object('section', c ->> 'tds_section', 'from', 'default', 'pct', (c ->> 'tds_pct')::numeric,
                     'amount', round((b.amount - coalesce(b.gst_amount, 0)) * (c ->> 'tds_pct')::numeric / 100, 0)) end),
      'reminders', (select count(*) from public.vendor_bill_reminders r where r.bill_id = b.id),
      'last_reminder', (select max(r.created_at) from public.vendor_bill_reminders r where r.bill_id = b.id))
      order by b.bill_date, b.id), '[]'::jsonb)
    into v_bills
    from public.vendor_bills b where b.quote_id = p_quote and b.org_id = v_org;
  select coalesce(jsonb_agg(jsonb_build_object('id', x.id, 'advance', x.advance, 'converted', x.conv,
           'left', greatest(0, x.advance - x.conv),
           'convertible', x.advance - x.conv > 0.005 and exists (select 1 from public.vendor_bills vb where vb.booking_id = x.id and vb.org_id = v_org
                                                                    and vb.status <> 'void' and public._r373_open(vb.id) > 0.005))
           order by x.created_at, x.id), '[]'::jsonb)
    into v_books
    from (select b.id, b.created_at, coalesce(b.advance, 0) as advance, public._r373_converted(b.id) as conv
            from public.event_resources b where b.quote_id = p_quote and b.org_id = v_org and b.status <> 'cancelled' and coalesce(b.advance, 0) > 0) x;
  return jsonb_build_object('closed', v_closed, 'can_late', v_closed and public._r373_can_late(v_org),
    'late_who', c ->> 'late_who', 'today', v_today, 'cash_limit', (c ->> 'cash_limit')::numeric, 'gst_warn_days', (c ->> 'gst_warn_days')::integer,
    'bills', v_bills, 'bookings', v_books);
end $fn$;

-- the Business page "Bills to pay" list: open bills due within p_days (0..60) or overdue, plus GST 150-day warnings
create or replace function public.vendor_bills_due(p_days integer default 14)
returns jsonb language plpgsql stable security definer set search_path = '' as $fn$
-- r190-0373: Finance view, own studio, at most 300 rows
declare v_org uuid := public.current_org_id(); c jsonb; v_today date; v_d integer := greatest(0, least(coalesce(p_days, 14), 60)); v jsonb;
begin
  if auth.uid() is null or v_org is null or not public.has_area('finance', 'view') then
    raise exception 'not authorized' using errcode = '42501'; end if;
  c := public._r373_cfg(v_org); v_today := public._a198_org_today(v_org);
  select coalesce(jsonb_agg(to_jsonb(x) order by x.due_date nulls last, x.bill_date), '[]'::jsonb) into v
    from (select b.id as bill_id, b.quote_id, q.code, coalesce(nullif(btrim(q.title), ''), 'Event') as event, q.event_date,
                 coalesce(nullif(btrim(vv.name), ''), nullif(btrim(er.label), ''), 'Vendor') as vendor, b.bill_no, b.bill_date, b.due_date,
                 b.amount, o.open, coalesce(nullif(upper(btrim(b.currency)), ''), 'INR') as currency,
                 b.due_date - v_today as days,
                 case when b.due_date < v_today then 'overdue' when b.due_date = v_today then 'today' when b.due_date is not null then 'soon' else 'gst' end as state,
                 coalesce(b.gst_amount, 0) > 0 and coalesce(b.gst_claimable, true) and v_today - b.bill_date >= (c ->> 'gst_warn_days')::integer as gst_warn,
                 b.bill_date + 180 as gst_deadline
            from public.vendor_bills b
            join public.quotes q on q.id = b.quote_id and q.org_id = v_org and q.deleted_at is null
            left join public.vendors vv on vv.id = b.vendor_id and vv.org_id = v_org
            left join public.event_resources er on er.id = b.booking_id and er.org_id = v_org
            cross join lateral (select public._r373_open(b.id) as open) o
           where b.org_id = v_org and b.status = 'open' and o.open > 0.005
             and ((b.due_date is not null and b.due_date <= v_today + v_d)
                  or (coalesce(b.gst_amount, 0) > 0 and coalesce(b.gst_claimable, true) and v_today - b.bill_date >= (c ->> 'gst_warn_days')::integer))
           order by b.due_date nulls last, b.bill_date limit 300) x;
  return jsonb_build_object('today', v_today, 'days', v_d, 'bills', v);
end $fn$;

-- the TDS report for the CA: every TDS row in the range (by payment date), with vendor, section, bill and event
create or replace function public.vendor_tds_report(p_from date, p_to date)
returns jsonb language plpgsql stable security definer set search_path = '' as $fn$
-- r190-0373: Finance view, own studio, at most 3 years, at most 2000 rows
declare v_org uuid := public.current_org_id(); v_from date := coalesce(p_from, current_date - 365); v_to date := coalesce(p_to, current_date); v jsonb;
begin
  if auth.uid() is null or v_org is null or not public.has_area('finance', 'view') then
    raise exception 'not authorized' using errcode = '42501'; end if;
  if v_to < v_from then raise exception 'the end date is before the start date' using errcode = '22023'; end if;
  if v_to - v_from > 1100 then raise exception 'range too long (max 3 years)' using errcode = '22023'; end if;
  select coalesce(jsonb_agg(to_jsonb(x) order by x.paid_on, x.id), '[]'::jsonb) into v
    from (select p.id, p.paid_on, to_char(p.paid_on, 'YYYY-MM') as month, p.tds_section as section, p.amount,
                 coalesce(nullif(btrim(vv.name), ''), 'Vendor') as vendor,
                 (select i.vendor_gstin from public.vendor_invoices i where i.bill_id = b.id and i.org_id = v_org and i.vendor_gstin is not null
                   order by i.submitted_at desc limit 1) as gstin,
                 b.bill_no, b.id as bill_id, b.amount as bill_amount, coalesce(nullif(upper(btrim(b.currency)), ''), 'INR') as currency,
                 q.code, coalesce(nullif(btrim(q.title), ''), 'Event') as event, b.quote_id
            from public.vendor_payouts p
            join public.vendor_bills b on b.id = p.bill_id and b.org_id = v_org
            join public.quotes q on q.id = b.quote_id
            left join public.vendors vv on vv.id = b.vendor_id and vv.org_id = v_org
           where p.org_id = v_org and p.source = 'tds' and p.paid_on between v_from and v_to
           order by p.paid_on, p.id limit 2000) x;
  return jsonb_build_object('from', v_from, 'to', v_to, 'rows', v);
end $fn$;

-- ---- 9) the studio setting (Business page -> Vendor bill reminders) ------------------------------------------------------------
create or replace function public.vendor_bill_settings_get()
returns jsonb language plpgsql stable security definer set search_path = '' as $fn$
-- r190-0373: Finance view reads; the office people (names + roles only) for the "who pays vendors" picker
declare v_org uuid := public.current_org_id();
begin
  if auth.uid() is null or v_org is null or not public.has_area('finance', 'view') then
    raise exception 'not authorized' using errcode = '42501'; end if;
  return public._r373_cfg(v_org) || jsonb_build_object(
    'can_edit', coalesce(public.user_role(), '') = 'admin' or auth.uid() = public._r283_owner(v_org),
    'people', (select coalesce(jsonb_agg(jsonb_build_object('id', p.id, 'role', lower(p.role),
                 'name', left(coalesce(nullif(btrim(p.full_name), ''), nullif(split_part(coalesce(p.email, ''), '@', 1), ''), 'Team member'), 120))
                 order by p.full_name, p.id), '[]'::jsonb)
                 from public.profiles p where p.org_id = v_org and lower(coalesce(p.role, '')) not in ('', 'client', 'crew', 'worker')
                  and not public._r283_is_off(p.id, v_org)),
    'payers', (select coalesce(jsonb_agg(jsonb_build_object('name', x ->> 'name', 'emailed', (x ->> 'email') is not null)), '[]'::jsonb)
                 from jsonb_array_elements(public._r373_people(v_org)) x));
end $fn$;

create or replace function public.vendor_bill_settings_set(p jsonb)
returns jsonb language plpgsql volatile security definer set search_path = '' as $fn$
-- r190-0373: a studio admin (or the owner) only; every field checked; logged in the audit trail
declare v_org uuid := public.current_org_id(); v_me uuid := auth.uid(); v_old jsonb; n jsonb; v_role text; v_pid uuid;
begin
  if v_me is null or v_org is null or not (coalesce(public.user_role(), '') = 'admin' or v_me = public._r283_owner(v_org)) then
    raise exception 'Only a studio admin can change the vendor bill settings.' using errcode = '42501'; end if;
  if coalesce(public._trial_locked(v_org), false) then raise exception 'This studio is read-only' using errcode = '25006'; end if;
  if p is null or jsonb_typeof(p) <> 'object' then raise exception 'bad settings' using errcode = '22023'; end if;
  v_old := public._r373_cfg(v_org);
  n := v_old || (p - 'saved' - 'can_edit' - 'people' - 'payers');
  v_role := lower(coalesce(n ->> 'payer_role', 'admin'));
  if n ->> 'payer_kind' not in ('role', 'person') then raise exception 'Choose a person or a role.' using errcode = '22023'; end if;
  if v_role !~ '^[a-z_]{2,30}$' or v_role in ('client', 'crew', 'worker') then raise exception 'Choose an office role.' using errcode = '22023'; end if;
  v_pid := case when (n ->> 'payer_profile') ~ '^[0-9a-f-]{36}$' then (n ->> 'payer_profile')::uuid end;
  if n ->> 'payer_kind' = 'person' and (v_pid is null or not exists (select 1 from public.profiles x where x.id = v_pid and x.org_id = v_org
        and lower(coalesce(x.role, '')) not in ('', 'client', 'crew', 'worker'))) then
    raise exception 'Choose a person from your team.' using errcode = '22023'; end if;
  begin
    insert into public.vendor_bill_settings (org_id, enabled, payer_kind, payer_role, payer_profile, days_before, on_due_day, overdue_every,
                                             email_on, vendor_reminders, vendor_days_before, cash_limit, gst_warn_days, tds_section, tds_pct,
                                             late_who, updated_at, updated_by)
    values (v_org, (n ->> 'enabled')::boolean, n ->> 'payer_kind', v_role, case when n ->> 'payer_kind' = 'person' then v_pid end,
            (n ->> 'days_before')::integer, (n ->> 'on_due_day')::boolean, (n ->> 'overdue_every')::integer,
            (n ->> 'email_on')::boolean, (n ->> 'vendor_reminders')::boolean, (n ->> 'vendor_days_before')::integer,
            (n ->> 'cash_limit')::numeric, (n ->> 'gst_warn_days')::integer, nullif(upper(btrim(coalesce(n ->> 'tds_section', ''))), ''),
            nullif(n ->> 'tds_pct', '')::numeric, n ->> 'late_who', now(), v_me)
    on conflict (org_id) do update set enabled = excluded.enabled, payer_kind = excluded.payer_kind, payer_role = excluded.payer_role,
      payer_profile = excluded.payer_profile, days_before = excluded.days_before, on_due_day = excluded.on_due_day,
      overdue_every = excluded.overdue_every, email_on = excluded.email_on, vendor_reminders = excluded.vendor_reminders,
      vendor_days_before = excluded.vendor_days_before, cash_limit = excluded.cash_limit, gst_warn_days = excluded.gst_warn_days,
      tds_section = excluded.tds_section, tds_pct = excluded.tds_pct, late_who = excluded.late_who, updated_at = now(), updated_by = v_me;
  exception
    when check_violation or invalid_text_representation or not_null_violation or numeric_value_out_of_range then
      raise exception 'One of the settings is out of range - check the numbers (days 0 to 30, GST warning 30 to 179 days, TDS 0 to 30%%, section like 194C).' using errcode = '22023';
  end;
  begin
    insert into public.audit_log(actor, action, entity, entity_id, changed, org_id)
      values (v_me, 'vendor_bills.settings', 'vendor_bill_settings', v_org::text, jsonb_build_object('from', v_old, 'to', public._r373_cfg(v_org)), v_org);
  exception when others then raise warning 'r190-0373: audit skipped (%)', sqlstate;
  end;
  return public.vendor_bill_settings_get();
end $fn$;

-- ---- 10) the bell: a bill reminder only for the people named on it (it shows money) -------------------------------------------
do $$
declare v_src text;
begin
  select p.prosrc into v_src from pg_proc p where p.oid = to_regprocedure('public._r23_visible(uuid,uuid)');
  if position('r190-0373' in coalesce(v_src, '')) = 0 and to_regprocedure('public._r23_visible__pre0373(uuid,uuid)') is null then
    alter function public._r23_visible(uuid, uuid) rename to _r23_visible__pre0373;
  end if;
  if to_regprocedure('public._r23_visible__pre0373(uuid,uuid)') is null then
    raise exception 'STOP 0373: _r23_visible could not be kept as _r23_visible__pre0373'; end if;
end $$;

create or replace function public._r23_visible(p_org uuid, p_uid uuid)
returns table(id uuid, kind text, channel text, status text, detail jsonb, created_at timestamptz, quote_id uuid, ntype text)
language sql stable security definer set search_path = '' as $fn$
  -- r190-0373: the kept rule (_r23_visible__pre0373 = the r186-0369 wrapper of the r24-ci-0270 + r163-0357 body) unchanged;
  -- a vendor_bill_due row only for the people in its notify list
  select v.id, v.kind, v.channel, v.status, v.detail, v.created_at, v.quote_id, v.ntype
    from public._r23_visible__pre0373(p_org, p_uid) v
   where coalesce(v.kind, '') <> 'vendor_bill_due'
      or exists (select 1 from public.notifications n
                  where n.id = v.id and n.org_id = p_org and jsonb_typeof(n.detail -> 'notify') = 'array'
                    and (n.detail -> 'notify') ? p_uid::text);
$fn$;

do $$
declare v_src text;
begin
  select p.prosrc into v_src from pg_proc p where p.oid = to_regprocedure('public.bell_feed(integer)');
  if position('r190-0373' in coalesce(v_src, '')) = 0 and to_regprocedure('public.bell_feed__pre0373(integer)') is null then
    alter function public.bell_feed(integer) rename to bell_feed__pre0373;
  end if;
  if to_regprocedure('public.bell_feed__pre0373(integer)') is null then
    raise exception 'STOP 0373: bell_feed could not be kept as bell_feed__pre0373'; end if;
end $$;

create or replace function public.bell_feed(p_limit integer default 20)
returns jsonb language plpgsql stable security definer set search_path = '' as $fn$
-- r190-0373: the kept bell (bell_feed__pre0373 = the r186-0369 body) unchanged, minus vendor_bill_due rows the caller is not named on
declare v jsonb := public.bell_feed__pre0373(p_limit); v_uid text := auth.uid()::text; v_org uuid := public.current_org_id();
begin
  if v is null or jsonb_typeof(v -> 'items') <> 'array' then return v; end if;
  if not exists (select 1 from jsonb_array_elements(v -> 'items') e where e ->> 'kind' = 'vendor_bill_due') then return v; end if;
  return jsonb_set(v, '{items}', coalesce((
    select jsonb_agg(e.i order by e.o)
      from jsonb_array_elements(v -> 'items') with ordinality e(i, o)
     where coalesce(e.i ->> 'kind', '') <> 'vendor_bill_due'
        or (v_uid is not null and exists (select 1 from public.notifications n
                                           where n.id::text = e.i ->> 'id' and n.org_id = v_org and jsonb_typeof(n.detail -> 'notify') = 'array'
                                             and (n.detail -> 'notify') ? v_uid))), '[]'::jsonb));
end $fn$;

-- ---- 11) free-trial retention (0184): the bill records go with the events of the studio; the setting is kept ------------------------
do $$ declare v_def text; begin
  if to_regprocedure('public._tr184_purge_tables()') is not null then
    v_def := pg_get_functiondef('public._tr184_purge_tables()'::regprocedure);
    if position('''vendor_bill_mail_outbox''' in v_def) = 0 then
      if (length(v_def) - length(replace(v_def, '''vendor_payouts''', ''))) / length('''vendor_payouts''') <> 1 then
        raise notice '0373: _tr184_purge_tables has an unexpected body - left unchanged';
      else execute replace(v_def, '''vendor_payouts''', '''vendor_bill_mail_outbox'', ''vendor_bill_reminders'', ''vendor_bill_files'', ''vendor_bill_late'', ''vendor_payouts'''); end if;
    end if;
  end if;
  if to_regprocedure('public._tr184_keep_tables()') is not null then
    v_def := pg_get_functiondef('public._tr184_keep_tables()'::regprocedure);
    if position('''vendor_bill_settings''' in v_def) = 0 then
      if (length(v_def) - length(replace(v_def, '''task_reminder_settings''', ''))) / length('''task_reminder_settings''') <> 1 then
        raise notice '0373: _tr184_keep_tables has an unexpected body - left unchanged';
      else execute replace(v_def, '''task_reminder_settings''', '''task_reminder_settings'', ''vendor_bill_settings'''); end if;
    end if;
  end if;
end $$;

-- ---- 12) grants: the page functions for signed-in staff (each checks studio + Finance itself); the rest server only ------------
do $$
declare f text;
begin
  foreach f in array array['public._r373_cfg(uuid)', 'public._r373_open(uuid)', 'public._r373_money(numeric,text)', 'public._r373_people(uuid)',
                           'public._r373_hour(uuid,timestamptz)', 'public._r373_slot(date,date,jsonb)', 'public._r373_converted(uuid)',
                           'public._r373_can_late(uuid)', 'public.tg_r373_advance_lock()',
                           'public.vendor_bill_reminder_tick(timestamptz)', 'public.vendor_bill_reminder_claim(integer)',
                           'public.vendor_bill_reminder_mark(uuid,text)',
                           'public._r21_cost_lines(uuid,uuid)', 'public._r21_cost_lines__pre0373(uuid,uuid)',
                           'public._r23_visible(uuid,uuid)', 'public._r23_visible__pre0373(uuid,uuid)', 'public.bell_feed__pre0373(integer)'] loop
    execute format('revoke all on function %s from public', f);
    if exists (select 1 from pg_roles where rolname = 'anon') then execute format('revoke all on function %s from anon', f); end if;
    if exists (select 1 from pg_roles where rolname = 'authenticated') then execute format('revoke all on function %s from authenticated', f); end if;
  end loop;
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    grant execute on function public.vendor_bill_reminder_tick(timestamptz) to service_role;
    grant execute on function public.vendor_bill_reminder_claim(integer) to service_role;
    grant execute on function public.vendor_bill_reminder_mark(uuid, text) to service_role;
  end if;
  foreach f in array array['public.vendor_bill_pay(uuid,numeric,numeric,text,date,text,text,text)', 'public.vendor_bill_convert_advances(uuid)',
                           'public.vendor_bill_attach(uuid,uuid)', 'public.vendor_bill_add_late(uuid,jsonb,text)', 'public.vendor_bills_extra(uuid)',
                           'public.vendor_bills_due(integer)', 'public.vendor_tds_report(date,date)', 'public.vendor_bill_settings_get()',
                           'public.vendor_bill_settings_set(jsonb)', 'public.bell_feed(integer)'] loop
    execute format('revoke all on function %s from public', f);
    if exists (select 1 from pg_roles where rolname = 'anon') then execute format('revoke all on function %s from anon', f); end if;
    if exists (select 1 from pg_roles where rolname = 'authenticated') then execute format('grant execute on function %s to authenticated', f); end if;
  end loop;
end $$;

-- ---- 13) pg_cron, ONLY if it is already installed (never created here): every hour at :17 ------------------------------------
do $$ begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    begin
      if not exists (select 1 from cron.job where jobname = 'helm-vendor-bill-reminders') then
        perform cron.schedule('helm-vendor-bill-reminders', '17 * * * *', 'select public.vendor_bill_reminder_tick()');
      end if;
    exception when others then
      raise notice 'pg_cron present but helm-vendor-bill-reminders could not be scheduled (%); schedule it by hand', sqlerrm;
    end;
  end if;
end $$;

notify pgrst, 'reload schema';
commit;

-- VERIFY every line should say true
select item, ok from (values
  ('01 five new tables, RLS on + forced, closed to the app', to_regclass('public.vendor_bill_settings') is not null
     and to_regclass('public.vendor_bill_files') is not null and to_regclass('public.vendor_bill_late') is not null
     and to_regclass('public.vendor_bill_reminders') is not null and to_regclass('public.vendor_bill_mail_outbox') is not null
     and coalesce((select bool_and(c.relrowsecurity and c.relforcerowsecurity) from pg_class c where c.oid in (to_regclass('public.vendor_bill_settings'),
           to_regclass('public.vendor_bill_files'), to_regclass('public.vendor_bill_late'), to_regclass('public.vendor_bill_reminders'),
           to_regclass('public.vendor_bill_mail_outbox'))), false)
     and not has_table_privilege('authenticated', 'public.vendor_bill_mail_outbox', 'select')
     and not has_table_privilege('authenticated', 'public.vendor_bill_late', 'insert')
     and not has_table_privilege('anon', 'public.vendor_bill_settings', 'select')),
  ('02 vendor_payouts: three new columns, every existing row still an ordinary payment',
     (select count(*) from information_schema.columns where table_schema = 'public' and table_name = 'vendor_payouts' and column_name in ('source', 'tds_section', 'payout_ref')) = 3
     and exists (select 1 from pg_constraint where conrelid = 'public.vendor_payouts'::regclass and conname = 'vendor_payouts_src_0373_ck')),
  ('03 each reminder once per bill and slot', exists (select 1 from pg_indexes where schemaname = 'public' and indexname = 'vendor_bill_reminders_once373')),
  ('04 cost ledger, bell and inbox rule wrapped once (old bodies kept)', to_regprocedure('public._r21_cost_lines__pre0373(uuid,uuid)') is not null
     and to_regprocedure('public.bell_feed__pre0373(integer)') is not null and to_regprocedure('public._r23_visible__pre0373(uuid,uuid)') is not null
     and position('r190-0373' in coalesce(pg_get_functiondef(to_regprocedure('public._r21_cost_lines(uuid,uuid)')), '')) > 0
     and position('r190-0373' in coalesce(pg_get_functiondef(to_regprocedure('public.bell_feed(integer)')), '')) > 0
     and position('r190-0373' in coalesce(pg_get_functiondef(to_regprocedure('public._r23_visible(uuid,uuid)')), '')) > 0),
  ('05 the 0152 bill guard knows late bills (every other check kept)', position('r190-0373' in coalesce(pg_get_functiondef(to_regprocedure('public.tg_a152_money_create_guard()')), '')) > 0
     and position('This event is closed - re-open it' in coalesce(pg_get_functiondef(to_regprocedure('public.tg_a152_money_create_guard()')), '')) > 0
     and position('refund_over_paid' in coalesce(pg_get_functiondef(to_regprocedure('public.tg_a152_money_create_guard()')), '')) > 0),
  ('06 typed advance lock on bookings', exists (select 1 from pg_trigger where tgrelid = 'public.event_resources'::regclass and tgname = 'ad_r373_advance_lock')),
  ('07 page functions for signed-in staff only', has_function_privilege('authenticated', 'public.vendor_bill_pay(uuid,numeric,numeric,text,date,text,text,text)', 'execute')
     and has_function_privilege('authenticated', 'public.vendor_bills_extra(uuid)', 'execute')
     and has_function_privilege('authenticated', 'public.vendor_bill_settings_set(jsonb)', 'execute')
     and not has_function_privilege('anon', 'public.vendor_bill_pay(uuid,numeric,numeric,text,date,text,text,text)', 'execute')
     and not has_function_privilege('anon', 'public.vendor_tds_report(date,date)', 'execute')),
  ('08 timer, e-mail claim and helpers server only', not has_function_privilege('authenticated', 'public.vendor_bill_reminder_tick(timestamptz)', 'execute')
     and not has_function_privilege('authenticated', 'public.vendor_bill_reminder_claim(integer)', 'execute')
     and not has_function_privilege('authenticated', 'public._r373_people(uuid)', 'execute')
     and not has_function_privilege('authenticated', 'public._r21_cost_lines(uuid,uuid)', 'execute')
     and has_function_privilege('authenticated', 'public.bell_feed(integer)', 'execute')),
  ('09 free-trial purge / keep lists know the new tables (or 0184 is absent)', to_regprocedure('public._tr184_purge_tables()') is null
     or (position('vendor_bill_mail_outbox' in pg_get_functiondef(to_regprocedure('public._tr184_purge_tables()'))) > 0
         and position('vendor_bill_settings' in pg_get_functiondef(to_regprocedure('public._tr184_keep_tables()'))) > 0))
) v(item, ok) order by item;
-- the hourly timer: in the cron.job list there is one job named helm-vendor-bill-reminders on prod / staging (where pg_cron is installed)
