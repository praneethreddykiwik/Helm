-- APPLY-0404 (R239 / Phase 3 money safety: payment key kept across a reload, Void instead of delete, Undo paid = a reversing
-- entry, credit on account, "Freeze now" before closing).
-- Run on STAGING first, then production. Safe to run twice. Needs 0110, 0264, 0282, 0296, 0372 and 0390 - already on both.
-- What it does:
--   * Refunds / recoveries, expense claims, cost lines and new milestones carry the form's request key: the same form sent
--     twice (a reload or a retry after a lost answer) saves ONE row. Cost corrections and client TDS get keyed calls too.
--   * Void instead of delete: the entry is KEPT (who, when, why, what it was) and counts exactly as a deleted one did. The
--     database now refuses a hard delete of refunds, claims, cost lines and milestones from signed-in users (Helm's own jobs,
--     the free-trial purge and the service role are unchanged). A voided entry can never be changed again.
--   * Undo paid: a NEW minus receipt (REV-...) linked to the original; the original receipt is never edited or deleted.
--   * Credit on account: when a client pays more than is due, the due part is the normal receipt and the extra is a credit
--     (never revenue) that can be applied later or marked given back.
--   * Freeze now: an admin can lock an event's money before closing (the same lock a closed event has), with a reason;
--     unfreeze = admin + reason; both are logged.
-- No existing row is changed or deleted. New columns (empty), 4 new tables, new functions and guard triggers. The payment
-- amount check is re-issued under the same name so only a reversal row may be a minus amount.
-- It waits at most 5 seconds for a table lock (then stops with an error and changes nothing - just run it again later).
-- Paste the whole file into the Supabase SQL editor and press Run. The last result lists checks - every ok must be true.
begin;
set local lock_timeout = '5s';
set local statement_timeout = '5min';
-- 0404_r239_money_safety.sql - R239 / Phase 3 of the Helm fix plan "Money safety" (owner approved 20 Nov 2026;
-- LIMITATIONS-AND-EDGE-CASES-v2.md PAY-02, PAY-03, PAY-04, PAY-05, PAY-06). Forward-only, additive, safe to run twice. ASCII only.
-- REQUIRES 0110 (overpayment cap), 0246 + 0372 (event money ledger, money lock, client TDS), 0264 (payment schedules),
--          0282 (closed-event freeze), 0296 (_r55_purge_allowed), 0184 (_tr184_purge_tables), 0390 (vendor payout key lock).
--
-- In plain words:
--   1  A PAYMENT KEY THAT SURVIVES A RELOAD (PAY-02). The screens keep one request key per money form until the server
--      answers (sessionStorage). Payments, milestone marks and vendor payouts already accepted a key; refunds / recoveries,
--      expense claims, cost lines and new milestones now carry one too (request_key + one unique index per table: the
--      same form sent twice saves ONE row), and cost corrections / client TDS get keyed calls (money_correction_add_once,
--      client_tds_record_once) that answer "already recorded" for a repeated key.
--   2  VOID INSTEAD OF DELETE (PAY-03). Wherever a screen could delete a money row (a pending / rejected refund, a pending
--      expense claim, a cost line of an open event, an unpaid milestone) it now offers Void: money_void(kind, id, reason).
--      The row is KEPT with who / when / why and what it was before (void_before). Its effect on every total is exactly
--      the effect the delete had: a refund or claim becomes "rejected" (every total already leaves rejected rows out), a
--      milestone becomes "waived" (left out of what is scheduled), a cost line keeps its amounts in void_before and counts
--      0 (it also lets go of its vendor booking / requirement / crew-wage link, as a delete did). A voided row can never be
--      changed again. The database now REFUSES a hard delete of these four tables from signed-in users; the free-trial
--      purge, "clear sample data" and the service role are unchanged.
--   3  UNDO A PAID MILESTONE = A REVERSING ROW (PAY-04). payment_reverse(payment, reason) writes a NEW minus receipt
--      (REV-<receipt>, linked to the original by reverses_payment_id); the original receipt is never edited or deleted.
--      Every total that sums the ledger (received, balance, close gate, schedule, P&L cash, dashboards) therefore drops by
--      exactly that amount, and the milestones that payment had covered go back to Due. milestone_undo_paid(milestone,
--      reason) finds the receipt that marked the milestone and reverses it. One reversal per receipt; a reversal is never
--      reversed; it is refused when the refunds already given back would then be more than what is left paid.
--   4  CREDIT ON ACCOUNT (PAY-05). record_payment_with_credit: when a client pays more than is due, the part that is due
--      is recorded as the normal receipt (so the 0110 cap still holds: the ledger never goes over the invoice) and the extra
--      is kept as a credit on the event (money_credits). It is never revenue. money_credit_apply records it as a payment
--      ('credit') once something is due again (a change order), splitting off what is left; money_credit_refund marks it
--      given back. Shown on the Settlement page.
--   5  "FREEZE NOW" BEFORE CLOSING (PAY-06). An admin (with Finance edit) can freeze an event's money with a reason:
--      the same lock a closed event has (cost lines, claims, refunds, milestones, change orders, corrections, wage
--      confirmations, new vendor bills, the quote price) refuses signed-in changes; client payments, vendor payouts and
--      TDS still go in, as after closing. Unfreeze = admin + reason. Every freeze / unfreeze is logged (event_money_freeze_log).
-- ACCESS: refunds = Settlement edit (as their table policy); claims / cost lines / milestones / reversals / credit refunds
--   = Finance edit; payments with credit + applying credit = Settlement edit (as record_settlement_payment); freeze = admin +
--   Finance edit; every read = Finance or Settlement view. Studio match on every call. Crew / client links never call these.
-- ZERO DATA LOSS: no existing row is changed or deleted by this migration. New nullable columns (void + request key on 4
--   tables, reversal link on quote_payments), 4 new tables (RLS on, no grants - functions only, kept for good), new functions,
--   guard triggers. The quote_payments amount check is re-issued under the same name so a REVERSAL row (and only a reversal
--   row) may be negative; every existing row passes both the old and the new check. _pkg_tg_payment is patched in place (old
--   body kept as _pkg_tg_payment__pre0404) so a reversal never tells the client "payment received".
-- ROLLBACK (manual, only if ever needed; no data involved): drop the triggers zzzzz_r404_money_guard (4 tables) and
--   ab_r404_money_freeze (9 tables); alter table public.quote_payments drop constraint quote_payments_amount_finite_chk, add
--   constraint quote_payments_amount_finite_chk check ((amount >= 0) and (amount < 1000000000000)) not valid (only once no
--   reversal row exists); drop function public._pkg_tg_payment(); alter function public._pkg_tg_payment__pre0404() rename
--   to _pkg_tg_payment; revert the page. The new columns / tables can stay (nothing reads them then).

-- ---- 0) preflight -------------------------------------------------------------------------------------------------------------
do $$ begin
  if to_regclass('public.quote_payments') is null or to_regclass('public.payment_milestones') is null or to_regclass('public.event_refunds') is null
     or to_regclass('public.expense_claims') is null or to_regclass('public.event_costs') is null then
    raise exception 'STOP 0404: the money tables are missing'; end if;
  if to_regprocedure('public.helm_total_paid(uuid,uuid,uuid)') is null or to_regprocedure('public.helm_invoice_total(uuid)') is null then
    raise exception 'STOP 0404: apply 0110 (overpayment cap) first'; end if;
  if to_regprocedure('public._r372_tds(uuid)') is null or to_regprocedure('public.money_correction_add(uuid,text,numeric,text,text,uuid)') is null
     or to_regprocedure('public.client_tds_record(uuid,numeric,text,numeric,text,uuid)') is null or to_regprocedure('public._r372_tg_keep()') is null then
    raise exception 'STOP 0404: apply 0372 (money lock) first'; end if;
  if to_regprocedure('public._r282_event_closed(uuid)') is null or to_regprocedure('public._r282_api_caller()') is null then
    raise exception 'STOP 0404: apply 0282 first'; end if;
  if to_regprocedure('public._r55_purge_allowed(uuid,boolean)') is null then raise exception 'STOP 0404: apply 0296 first'; end if;
  if to_regprocedure('public.record_settlement_payment(uuid,numeric,text,text,uuid,text,text)') is null
     or to_regprocedure('public._pst_allocate(uuid)') is null then raise exception 'STOP 0404: apply 0264 first'; end if;
  if to_regprocedure('public._pkg_tg_payment()') is null then raise exception 'STOP 0404: _pkg_tg_payment missing (0099)'; end if;
  -- a reversal row is a minus amount: only the one amount check this migration re-issues may look at quote_payments.amount
  if exists (select 1 from pg_constraint c where c.conrelid = 'public.quote_payments'::regclass and c.contype = 'c'
              and c.conname not in ('quote_payments_amount_finite_chk', 'quote_payments_r404_reversal_sign_chk')
              -- the hand-applied Wave 16 rule (amount > 0) is known: section 1 re-issues it under the same name (R244)
              and not (c.conname = 'quote_payments_amount_pos' and (pg_get_constraintdef(c.oid) = 'CHECK ((amount > (0)::numeric))'
                       or pg_get_constraintdef(c.oid) like '%reverses_payment_id%'))
              and pg_get_constraintdef(c.oid) ~ '\mamount\M') then
    raise exception 'STOP 0404: quote_payments has another amount check - tell the developer before running this'; end if;
end $$;

-- ---- 1) new columns (nullable, no default: no existing row is rewritten) -------------------------------------------------------
alter table public.event_refunds add column if not exists voided_at timestamptz;
alter table public.event_refunds add column if not exists voided_by uuid;
alter table public.event_refunds add column if not exists void_reason text;
alter table public.event_refunds add column if not exists void_before jsonb;
alter table public.event_refunds add column if not exists request_key text;
alter table public.expense_claims add column if not exists voided_at timestamptz;
alter table public.expense_claims add column if not exists voided_by uuid;
alter table public.expense_claims add column if not exists void_reason text;
alter table public.expense_claims add column if not exists void_before jsonb;
alter table public.expense_claims add column if not exists request_key text;
alter table public.event_costs add column if not exists voided_at timestamptz;
alter table public.event_costs add column if not exists voided_by uuid;
alter table public.event_costs add column if not exists void_reason text;
alter table public.event_costs add column if not exists void_before jsonb;
alter table public.event_costs add column if not exists request_key text;
alter table public.payment_milestones add column if not exists voided_at timestamptz;
alter table public.payment_milestones add column if not exists voided_by uuid;
alter table public.payment_milestones add column if not exists void_reason text;
alter table public.payment_milestones add column if not exists void_before jsonb;
alter table public.payment_milestones add column if not exists request_key text;
alter table public.quote_payments add column if not exists reverses_payment_id uuid;
alter table public.quote_payments add column if not exists reversal_reason text;
alter table public.quote_payments add column if not exists reversed_by uuid;

-- one form = one row: the same request key on the same event can only be saved once
create unique index if not exists event_refunds_r404_request_key_uq on public.event_refunds (quote_id, request_key) where request_key is not null;
create unique index if not exists expense_claims_r404_request_key_uq on public.expense_claims (quote_id, request_key) where request_key is not null;
create unique index if not exists event_costs_r404_request_key_uq on public.event_costs (quote_id, request_key) where request_key is not null;
create unique index if not exists payment_milestones_r404_request_key_uq on public.payment_milestones (quote_id, request_key) where request_key is not null;
-- one reversal per receipt
create unique index if not exists quote_payments_r404_one_reversal_uq on public.quote_payments (reverses_payment_id) where reverses_payment_id is not null;

-- length / shape checks on the new columns only (NOT VALID: nothing existing is scanned; every existing row has nulls)
do $$ declare t text; begin
  foreach t in array array['event_refunds', 'expense_claims', 'event_costs', 'payment_milestones'] loop
    if not exists (select 1 from pg_constraint where conrelid = ('public.' || t)::regclass and conname = t || '_r404_void_chk') then
      execute format('alter table public.%I add constraint %I check ((voided_at is null and voided_by is null and void_reason is null and void_before is null)'
        || ' or (voided_at is not null and char_length(btrim(coalesce(void_reason, ''''))) between 5 and 500)) not valid', t, t || '_r404_void_chk');
    end if;
    if not exists (select 1 from pg_constraint where conrelid = ('public.' || t)::regclass and conname = t || '_r404_request_key_chk') then
      execute format('alter table public.%I add constraint %I check (request_key is null or char_length(request_key) between 8 and 100) not valid', t, t || '_r404_request_key_chk');
    end if;
  end loop;
end $$;

-- a reversal row (and only a reversal row) is a minus amount. Same name as the 0142 check, so the owner checker still finds it.
do $$ begin
  if not exists (select 1 from pg_constraint where conrelid = 'public.quote_payments'::regclass and conname = 'quote_payments_amount_finite_chk'
                  and pg_get_constraintdef(oid) like '%reverses_payment_id%') then
    alter table public.quote_payments drop constraint if exists quote_payments_amount_finite_chk;
    alter table public.quote_payments add constraint quote_payments_amount_finite_chk
      check (((amount >= 0) and (amount < 1000000000000)) or ((reverses_payment_id is not null) and (amount < 0) and (amount > -1000000000000))) not valid;
  end if;
  if not exists (select 1 from pg_constraint where conrelid = 'public.quote_payments'::regclass and conname = 'quote_payments_r404_reversal_sign_chk') then
    alter table public.quote_payments add constraint quote_payments_r404_reversal_sign_chk
      check (reverses_payment_id is null or (amount < 0 and status = 'paid' and char_length(btrim(coalesce(reversal_reason, ''))) between 5 and 500)) not valid;
  end if;
end $$;

-- R244: staging and production also carry a hand-applied rule quote_payments_amount_pos = (amount > 0) (Wave 16, W16-01;
-- not in the migration chain). It would refuse every reversal row. Re-issue it under the SAME name, exactly as strict for a
-- normal payment (still > 0, never 0) and allowing a minus amount only on a reversal row. Only where it exists (it is never
-- created here); it keeps its validated state (validated again only if it was validated before - every existing row already
-- passed amount > 0). No row is changed.
do $$ declare v_valid boolean; begin
  select c.convalidated into v_valid from pg_constraint c
   where c.conrelid = 'public.quote_payments'::regclass and c.conname = 'quote_payments_amount_pos';
  if found and not exists (select 1 from pg_constraint where conrelid = 'public.quote_payments'::regclass and conname = 'quote_payments_amount_pos'
                             and pg_get_constraintdef(oid) like '%reverses_payment_id%') then
    alter table public.quote_payments drop constraint quote_payments_amount_pos;
    alter table public.quote_payments add constraint quote_payments_amount_pos
      check ((amount > 0) or ((reverses_payment_id is not null) and (amount < 0))) not valid;
    if v_valid then alter table public.quote_payments validate constraint quote_payments_amount_pos; end if;
  end if;
end $$;

-- ---- 2) new tables (RLS on, no grants: functions only) ------------------------------------------------------------------------
-- a repeated request key answers what the first request answered
create table if not exists public.money_request_keys (
  org_id      uuid not null references public.organizations(id) on delete cascade,
  request_key text not null check (char_length(request_key) between 8 and 100),
  kind        text not null check (char_length(kind) between 2 and 40),
  quote_id    uuid references public.quotes(id) on delete cascade,
  result      jsonb not null default '{}'::jsonb check (jsonb_typeof(result) = 'object'),
  created_by  uuid,
  created_at  timestamptz not null default now(),
  constraint money_request_keys_pk primary key (org_id, request_key)
);
create index if not exists money_request_keys_quote_idx on public.money_request_keys (quote_id);

-- credit on account: money a client paid over what was due (never revenue); open -> applied / refunded, once
create table if not exists public.money_credits (
  id                 uuid primary key default gen_random_uuid(),
  org_id             uuid not null references public.organizations(id) on delete cascade,
  quote_id           uuid not null references public.quotes(id) on delete cascade,
  amount             numeric not null check (amount > 0 and amount < 10000000000),
  status             text not null default 'open' check (status in ('open', 'applied', 'refunded')),
  source             text not null default 'overpayment' check (source in ('overpayment', 'remainder')),
  parent_id          uuid,
  method             text check (method is null or char_length(method) <= 20),
  note               text check (note is null or char_length(note) <= 300),
  request_key        text check (request_key is null or char_length(request_key) between 8 and 100),
  created_by         uuid,
  created_email      text,
  created_at         timestamptz not null default now(),
  closed_at          timestamptz,
  closed_by          uuid,
  closed_email       text,
  close_note         text check (close_note is null or char_length(close_note) <= 500),
  applied_payment_id uuid,
  applied_amount     numeric check (applied_amount is null or applied_amount > 0)
);
create unique index if not exists money_credits_request_key_uq on public.money_credits (org_id, request_key) where request_key is not null;
create index if not exists money_credits_quote_idx on public.money_credits (quote_id, created_at);
create index if not exists money_credits_org_idx on public.money_credits (org_id);

-- "Freeze now": the current state (one row per event) + every freeze / unfreeze (kept for good)
create table if not exists public.event_money_freezes (
  quote_id  uuid primary key references public.quotes(id) on delete cascade,
  org_id    uuid not null references public.organizations(id) on delete cascade,
  frozen    boolean not null default true,
  reason    text not null check (char_length(btrim(reason)) between 5 and 300),
  set_by    uuid,
  set_email text,
  set_at    timestamptz not null default now()
);
create index if not exists event_money_freezes_org_idx on public.event_money_freezes (org_id);
create index if not exists event_money_freezes_frozen_idx on public.event_money_freezes (quote_id) where frozen;
create table if not exists public.event_money_freeze_log (
  id        uuid primary key default gen_random_uuid(),
  org_id    uuid not null references public.organizations(id) on delete cascade,
  quote_id  uuid not null references public.quotes(id) on delete cascade,
  action    text not null check (action in ('freeze', 'unfreeze')),
  reason    text not null check (char_length(btrim(reason)) between 5 and 300),
  by_user   uuid,
  by_email  text,
  at        timestamptz not null default now()
);
create index if not exists event_money_freeze_log_quote_idx on public.event_money_freeze_log (quote_id, at);
create index if not exists event_money_freeze_log_org_idx on public.event_money_freeze_log (org_id);

do $$ declare t text; begin
  foreach t in array array['money_request_keys', 'money_credits', 'event_money_freezes', 'event_money_freeze_log'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on table public.%I from public', t);
    if exists (select 1 from pg_roles where rolname = 'anon') then execute format('revoke all on table public.%I from anon', t); end if;
    if exists (select 1 from pg_roles where rolname = 'authenticated') then execute format('revoke all on table public.%I from authenticated', t); end if;
    if to_regprocedure('public.tg_studio_read_only()') is not null
       and not exists (select 1 from pg_trigger where tgrelid = ('public.' || t)::regclass and tgname = 'zzz_studio_read_only') then
      execute format('create trigger zzz_studio_read_only before insert or update or delete on public.%I for each row execute function public.tg_studio_read_only(''org_id'')', t);
    end if;
    if to_regprocedure('public.tg_quote_org_match()') is not null
       and not exists (select 1 from pg_trigger where tgrelid = ('public.' || t)::regclass and tgname = 'zz_quote_org_match') then
      execute format('create trigger zz_quote_org_match before insert or update on public.%I for each row execute function public.tg_quote_org_match()', t);
    end if;
  end loop;
  -- the freeze log is kept for good (0372 rule: no update; delete only by the free-trial purge)
  if not exists (select 1 from pg_trigger where tgrelid = 'public.event_money_freeze_log'::regclass and tgname = 'aa_r372_keep') then
    create trigger aa_r372_keep before update or delete on public.event_money_freeze_log for each row execute function public._r372_tg_keep();
  end if;
  if to_regprocedure('public.tg_audit()') is not null
     and not exists (select 1 from pg_trigger where tgrelid = 'public.money_credits'::regclass and tgname = 'audit_trg') then
    create trigger audit_trg after insert or update or delete on public.money_credits for each row execute function public.tg_audit();
  end if;
end $$;

-- a credit is kept for good: only open -> applied / refunded (once, amount / event never change); delete = free-trial purge only
create or replace function public._r404_tg_credit_keep()
returns trigger language plpgsql set search_path = '' as $$
-- r239-money-0404
begin
  if tg_op = 'DELETE' then
    if public._r55_purge_allowed(old.org_id) then return old; end if;
    raise exception 'A credit on account is kept for good. Apply it or mark it refunded instead.' using errcode = '42501', hint = 'r404_keep';
  end if;
  if old.status = 'open' and new.status in ('applied', 'refunded')
     and (new.id, new.org_id, new.quote_id, new.amount, new.source, new.parent_id, new.created_by, new.created_at, new.request_key)
         is not distinct from (old.id, old.org_id, old.quote_id, old.amount, old.source, old.parent_id, old.created_by, old.created_at, old.request_key) then
    return new;
  end if;
  raise exception 'A credit on account can only be applied or refunded once - it is never edited.' using errcode = '42501', hint = 'r404_keep';
end $$;
revoke all on function public._r404_tg_credit_keep() from public;
drop trigger if exists aa_r404_credit_keep on public.money_credits;
create trigger aa_r404_credit_keep before update or delete on public.money_credits for each row execute function public._r404_tg_credit_keep();

-- ---- 3) small helpers ------------------------------------------------------------------------------------------------------------
create or replace function public._r404_key(p_key text)
returns text language plpgsql immutable set search_path = '' as $$
-- r239-money-0404: a request key from a page (8 to 100 safe characters) or null
declare v text := nullif(btrim(coalesce(p_key, '')), '');
begin
  if v is null then return null; end if;
  if char_length(v) < 8 or char_length(v) > 100 or v !~ '^[A-Za-z0-9:_.-]+$' then
    raise exception 'request key must be 8 to 100 letters, digits or : _ . -' using errcode = '22023'; end if;
  return v;
end $$;

-- waits for a parallel request with the same key, then answers what it answered (null = first time)
create or replace function public._r404_key_get(p_org uuid, p_key text)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
-- r239-money-0404
declare v jsonb;
begin
  if p_key is null or p_org is null then return null; end if;
  perform pg_advisory_xact_lock(hashtextextended('helm:mkey:' || p_org::text || ':' || p_key, 0));
  select k.result into v from public.money_request_keys k where k.org_id = p_org and k.request_key = p_key;
  if v is null then return null; end if;
  return v || jsonb_build_object('duplicate', true);
end $$;

create or replace function public._r404_key_put(p_org uuid, p_key text, p_kind text, p_quote uuid, p_result jsonb)
returns void language plpgsql volatile security definer set search_path = '' as $$
-- r239-money-0404
begin
  if p_key is null or p_org is null then return; end if;
  insert into public.money_request_keys(org_id, request_key, kind, quote_id, result, created_by)
    values (p_org, p_key, p_kind, p_quote, coalesce(p_result, '{}'::jsonb), auth.uid())
    on conflict (org_id, request_key) do nothing;
end $$;

create or replace function public._r404_who()
returns text language sql stable security definer set search_path = '' as $$
  -- r239-money-0404
  select u.email::text from auth.users u where u.id = auth.uid();
$$;

create or replace function public._r404_frozen(p_quote uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  -- r239-money-0404: "Freeze now" is on for this event
  select p_quote is not null and exists (select 1 from public.event_money_freezes f where f.quote_id = p_quote and f.frozen);
$$;

-- what the client still owes right now: invoice (quote + approved change orders) - ledger receipts - client TDS
create or replace function public._r404_room(p_quote uuid)
returns numeric language sql stable security definer set search_path = '' as $$
  -- r239-money-0404
  select round(public.helm_invoice_total(p_quote) - public.helm_total_paid(p_quote, null, null) - coalesce(public._r372_tds(p_quote), 0), 2);
$$;

create or replace function public._r404_audit(p_org uuid, p_quote uuid, p_action text, p_entity text, p_id text, p_changed jsonb)
returns void language plpgsql volatile security definer set search_path = '' as $$
-- r239-money-0404
begin
  insert into public.audit_log(actor, actor_email, action, entity, entity_id, quote_id, changed, org_id)
  values (auth.uid(), public._r404_who(), p_action, p_entity, p_id, p_quote, coalesce(p_changed, '{}'::jsonb), p_org);
end $$;

-- ---- 4) the money-row guard: no hard delete from signed-in users, a voided row is kept as it was ---------------------------------
-- Runs as the caller (not a definer): a direct API request is current_user anon / authenticated; Helm's own functions
-- (money_void, the payment functions, the free-trial purge, sample clear-out) run as their owner and pass.
-- Test switch for the older local suites only: helm.money_void_gate = off (deletes as before).
create or replace function public._r404_tg_money_guard()
returns trigger language plpgsql set search_path = '' as $$
-- r239-money-0404
declare v_api boolean := current_user::text in ('anon', 'authenticated'); o jsonb; n jsonb;
begin
  if tg_op = 'DELETE' then
    if not v_api or coalesce(current_setting('helm.money_void_gate', true), '') = 'off' then return old; end if;
    raise exception 'Money entries are never deleted. Use Void instead - the entry is kept, crossed out, and left out of the totals.'
      using errcode = '42501', hint = 'r404_use_void', detail = 'table ' || tg_table_name;
  end if;
  n := to_jsonb(new);
  if tg_op = 'INSERT' then
    if v_api and ((n ->> 'voided_at') is not null or (n ->> 'voided_by') is not null or (n ->> 'void_reason') is not null
                  or (n ->> 'void_before') is not null) then
      raise exception 'A new entry can''t start as voided.' using errcode = '42501', hint = 'r404_use_void';
    end if;
    return new;
  end if;
  o := to_jsonb(old);
  if (o ->> 'voided_at') is not null then
    if n = o then return new; end if;
    if v_api then
      raise exception 'This entry was voided and is kept exactly as it was.' using errcode = '42501', hint = 'r404_voided', detail = 'table ' || tg_table_name;
    end if;
    -- Helm's own functions never change a voided row either (e.g. a payment never marks a voided milestone): skipped
    raise warning 'r404: % % is voided - left unchanged', tg_table_name, old.id;
    return null;
  end if;
  if v_api and ((n -> 'voided_at', n -> 'voided_by', n -> 'void_reason', n -> 'void_before')
                is distinct from (o -> 'voided_at', o -> 'voided_by', o -> 'void_reason', o -> 'void_before')) then
    raise exception 'Use Void to void an entry (it needs a reason).' using errcode = '42501', hint = 'r404_use_void';
  end if;
  if v_api and (n -> 'request_key') is distinct from (o -> 'request_key') then
    raise exception 'The request key of an entry can''t be changed.' using errcode = '42501', hint = 'r404_request_key';
  end if;
  return new;
end $$;
revoke all on function public._r404_tg_money_guard() from public;
drop trigger if exists zzzzz_r404_money_guard on public.event_refunds;
create trigger zzzzz_r404_money_guard before insert or update or delete on public.event_refunds for each row execute function public._r404_tg_money_guard();
drop trigger if exists zzzzz_r404_money_guard on public.expense_claims;
create trigger zzzzz_r404_money_guard before insert or update or delete on public.expense_claims for each row execute function public._r404_tg_money_guard();
drop trigger if exists zzzzz_r404_money_guard on public.event_costs;
create trigger zzzzz_r404_money_guard before insert or update or delete on public.event_costs for each row execute function public._r404_tg_money_guard();
drop trigger if exists zzzzz_r404_money_guard on public.payment_milestones;
create trigger zzzzz_r404_money_guard before insert or update or delete on public.payment_milestones for each row execute function public._r404_tg_money_guard();

-- ---- 5) "Freeze now": the same lock a closed event has, before closing -----------------------------------------------------------
-- Like _r282_tg_closed_freeze (0282): signed-in requests only (also inside Helm's functions, read from the request), the
-- payment functions still mark / un-mark milestones (status paid <-> due only), payments / payouts / TDS are not guarded.
create or replace function public._r404_tg_money_freeze()
returns trigger language plpgsql security definer set search_path = '' as $$
-- r239-money-0404
declare v_q uuid; v_q2 uuid; v_reason text;
begin
  if not public._r282_api_caller() then return coalesce(new, old); end if;
  if not exists (select 1 from public.event_money_freezes f where f.frozen) then return coalesce(new, old); end if;   -- fast path
  if tg_table_name = 'quotes' then
    if (to_jsonb(new) -> 'pricing') is not distinct from (to_jsonb(old) -> 'pricing')
       and (to_jsonb(new) -> 'currency') is not distinct from (to_jsonb(old) -> 'currency') then return new; end if;
    v_q := new.id;
  elsif tg_op = 'DELETE' then v_q := old.quote_id;
  elsif tg_op = 'UPDATE' then v_q := new.quote_id; v_q2 := old.quote_id;
  else v_q := new.quote_id;
  end if;
  -- a payment (or its reversal) marks / un-marks the milestones it covers: only status + paid_at, to or from paid
  -- (nested ifs: a record field is only read on the table that has it)
  if tg_table_name = 'payment_milestones' and tg_op = 'UPDATE' then
    if (to_jsonb(new) ->> 'status' = 'paid' or to_jsonb(old) ->> 'status' = 'paid')
       and (to_jsonb(new) - array['status', 'paid_at']) = (to_jsonb(old) - array['status', 'paid_at']) then
      return new;
    end if;
  end if;
  -- vendor bills: a new bill or a new amount is frozen; paying a bill is not
  if tg_table_name = 'vendor_bills' and tg_op = 'UPDATE' then
    if (to_jsonb(new) -> 'amount') is not distinct from (to_jsonb(old) -> 'amount') and new.quote_id is not distinct from old.quote_id then
      return new;
    end if;
  end if;
  if public._r404_frozen(v_q) or (v_q2 is distinct from v_q and public._r404_frozen(v_q2)) then
    select f.reason into v_reason from public.event_money_freezes f where f.quote_id in (v_q, v_q2) and f.frozen limit 1;
    raise exception 'The money on this event is frozen (%). An admin can unfreeze it on the Settlement page.', coalesce(v_reason, 'no reason')
      using errcode = '42501', hint = 'money_frozen';
  end if;
  return coalesce(new, old);
end $$;
revoke all on function public._r404_tg_money_freeze() from public;
drop trigger if exists ab_r404_money_freeze on public.event_costs;
create trigger ab_r404_money_freeze before insert or update or delete on public.event_costs for each row execute function public._r404_tg_money_freeze();
drop trigger if exists ab_r404_money_freeze on public.expense_claims;
create trigger ab_r404_money_freeze before insert or update or delete on public.expense_claims for each row execute function public._r404_tg_money_freeze();
drop trigger if exists ab_r404_money_freeze on public.event_refunds;
create trigger ab_r404_money_freeze before insert or update or delete on public.event_refunds for each row execute function public._r404_tg_money_freeze();
drop trigger if exists ab_r404_money_freeze on public.payment_milestones;
create trigger ab_r404_money_freeze before insert or update or delete on public.payment_milestones for each row execute function public._r404_tg_money_freeze();
drop trigger if exists ab_r404_money_freeze on public.change_requests;
create trigger ab_r404_money_freeze before insert or update or delete on public.change_requests for each row execute function public._r404_tg_money_freeze();
drop trigger if exists ab_r404_money_freeze on public.money_corrections;
create trigger ab_r404_money_freeze before insert on public.money_corrections for each row execute function public._r404_tg_money_freeze();
drop trigger if exists ab_r404_money_freeze on public.crew_wage_confirmations;
create trigger ab_r404_money_freeze before insert on public.crew_wage_confirmations for each row execute function public._r404_tg_money_freeze();
drop trigger if exists ab_r404_money_freeze on public.vendor_bills;
create trigger ab_r404_money_freeze before insert or update on public.vendor_bills for each row execute function public._r404_tg_money_freeze();
drop trigger if exists ab_r404_money_freeze on public.quotes;
create trigger ab_r404_money_freeze before update of pricing, currency on public.quotes for each row execute function public._r404_tg_money_freeze();

create or replace function public.event_money_freeze_get(p_quote uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
-- r239-money-0404
declare v_org uuid := public.current_org_id(); f public.event_money_freezes; v_log jsonb;
begin
  if auth.uid() is null or v_org is null or not (public.has_area('finance', 'view') or public.has_area('settlement', 'view')) then
    raise exception 'not authorized' using errcode = '42501'; end if;
  if not exists (select 1 from public.quotes q where q.id = p_quote and q.org_id = v_org) then raise exception 'event not found' using errcode = '42501'; end if;
  select * into f from public.event_money_freezes x where x.quote_id = p_quote and x.org_id = v_org;
  select coalesce(jsonb_agg(jsonb_build_object('action', l.action, 'reason', l.reason, 'by', l.by_email, 'at', l.at) order by l.at desc), '[]'::jsonb)
    into v_log from (select * from public.event_money_freeze_log l where l.quote_id = p_quote and l.org_id = v_org order by l.at desc limit 20) l;
  return jsonb_build_object('frozen', coalesce(f.frozen, false), 'reason', f.reason, 'by', f.set_email, 'at', f.set_at,
    'closed', public._r282_event_closed(p_quote), 'log', v_log,
    'can_set', public.is_admin() and public.has_area('finance', 'edit'));
end $$;

create or replace function public.event_money_freeze_set(p_quote uuid, p_frozen boolean, p_reason text)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
-- r239-money-0404
declare v_org uuid := public.current_org_id(); v_reason text := btrim(coalesce(p_reason, '')); v_now boolean;
begin
  if auth.uid() is null or v_org is null or not public.is_admin() or not public.has_area('finance', 'edit') then
    raise exception 'Only an admin can freeze or unfreeze the money of an event.' using errcode = '42501'; end if;
  perform 1 from public.quotes q where q.id = p_quote and q.org_id = v_org for update;
  if not found then raise exception 'event not found' using errcode = '42501'; end if;
  if p_frozen is null then raise exception 'Say freeze or unfreeze.' using errcode = '22023'; end if;
  if char_length(v_reason) < 5 or char_length(v_reason) > 300 then raise exception 'Give a reason of 5 to 300 characters.' using errcode = '22023'; end if;
  select f.frozen into v_now from public.event_money_freezes f where f.quote_id = p_quote;
  if coalesce(v_now, false) = p_frozen then
    raise exception '%', case when p_frozen then 'The money on this event is already frozen.' else 'The money on this event is not frozen.' end using errcode = '22023'; end if;
  if p_frozen and public._r282_event_closed(p_quote) then
    raise exception 'This event is closed - its money is already locked.' using errcode = '22023'; end if;
  insert into public.event_money_freezes(quote_id, org_id, frozen, reason, set_by, set_email, set_at)
    values (p_quote, v_org, p_frozen, v_reason, auth.uid(), public._r404_who(), now())
    on conflict (quote_id) do update set frozen = excluded.frozen, reason = excluded.reason, set_by = excluded.set_by,
                                         set_email = excluded.set_email, set_at = excluded.set_at;
  insert into public.event_money_freeze_log(org_id, quote_id, action, reason, by_user, by_email, at)
    values (v_org, p_quote, case when p_frozen then 'freeze' else 'unfreeze' end, v_reason, auth.uid(), public._r404_who(), clock_timestamp());
  perform public._r404_audit(v_org, p_quote, case when p_frozen then 'money.frozen' else 'money.unfrozen' end, 'quotes', p_quote::text,
                             jsonb_build_object('reason', v_reason));
  return public.event_money_freeze_get(p_quote);
end $$;

-- ---- 6) Void -----------------------------------------------------------------------------------------------------------------
create or replace function public.money_void(p_kind text, p_id uuid, p_reason text, p_key text default null)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
-- r239-money-0404: void instead of delete. The row is kept with who / when / why / what it was; its effect on the totals is
-- the effect a delete had (refund / claim -> rejected, milestone -> waived, cost line -> 0 with its links let go).
declare v_org uuid := public.current_org_id(); v_kind text := lower(btrim(coalesce(p_kind, ''))); v_reason text := btrim(coalesce(p_reason, ''));
  v_key text := public._r404_key(p_key); v_old jsonb; v_q uuid; v_rep jsonb; v_out jsonb; v_st text; v_area text;
begin
  if auth.uid() is null or v_org is null then raise exception 'not authorized' using errcode = '42501'; end if;
  if v_kind not in ('refund', 'claim', 'cost', 'milestone') then raise exception 'unknown kind of entry' using errcode = '22023'; end if;
  v_area := case when v_kind = 'refund' then 'settlement' else 'finance' end;
  if not public.has_area(v_area, 'edit') then raise exception 'not authorized' using errcode = '42501'; end if;
  if char_length(v_reason) < 5 or char_length(v_reason) > 500 then raise exception 'Give a reason of 5 to 500 characters.' using errcode = '22023'; end if;
  if v_kind = 'refund' then select to_jsonb(r) into v_old from public.event_refunds r where r.id = p_id and r.org_id = v_org;
  elsif v_kind = 'claim' then select to_jsonb(r) into v_old from public.expense_claims r where r.id = p_id and r.org_id = v_org;
  elsif v_kind = 'cost' then select to_jsonb(r) into v_old from public.event_costs r where r.id = p_id and r.org_id = v_org;
  else select to_jsonb(r) into v_old from public.payment_milestones r where r.id = p_id and r.org_id = v_org; end if;
  if v_old is null then raise exception 'entry not found' using errcode = '42501'; end if;
  v_q := (v_old ->> 'quote_id')::uuid;
  perform pg_advisory_xact_lock(hashtextextended('helm:pay:quote:' || v_q::text, 0));
  v_rep := public._r404_key_get(v_org, v_key);
  if v_rep is not null then return v_rep; end if;
  -- re-read under the lock
  if v_kind = 'refund' then select to_jsonb(r) into v_old from public.event_refunds r where r.id = p_id for update;
  elsif v_kind = 'claim' then select to_jsonb(r) into v_old from public.expense_claims r where r.id = p_id for update;
  elsif v_kind = 'cost' then select to_jsonb(r) into v_old from public.event_costs r where r.id = p_id for update;
  else select to_jsonb(r) into v_old from public.payment_milestones r where r.id = p_id for update; end if;
  if (v_old ->> 'voided_at') is not null then raise exception 'This entry is already voided.' using errcode = '22023'; end if;
  v_st := v_old ->> 'status';
  -- the same rows a delete was allowed for, nothing more
  if v_kind = 'refund' and coalesce(v_st, 'pending') not in ('pending', 'rejected') then
    raise exception 'An approved or processed refund can''t be voided - reject it, or add a correcting entry.' using errcode = '22023'; end if;
  if v_kind = 'claim' and coalesce(v_st, 'pending') <> 'pending' then
    raise exception 'An approved, paid or rejected expense claim can''t be voided - add a correcting claim instead.' using errcode = '22023'; end if;
  if v_kind = 'milestone' and v_st = 'paid' then
    raise exception 'A paid milestone can''t be voided - use Undo paid (it adds a reversing entry).' using errcode = '22023'; end if;
  if public._r282_event_closed(v_q) then
    raise exception 'This event is closed - re-open it first (an admin can re-open it from its Closure page).' using errcode = '42501', hint = 'event_closed'; end if;

  if v_kind = 'refund' then
    update public.event_refunds set status = 'rejected', voided_at = now(), voided_by = auth.uid(), void_reason = v_reason,
           void_before = jsonb_build_object('status', v_st) where id = p_id;
  elsif v_kind = 'claim' then
    update public.expense_claims set status = 'rejected', voided_at = now(), voided_by = auth.uid(), void_reason = v_reason,
           void_before = jsonb_build_object('status', v_st) where id = p_id;
  elsif v_kind = 'milestone' then
    update public.payment_milestones set status = 'waived', paid_at = null, voided_at = now(), voided_by = auth.uid(), void_reason = v_reason,
           void_before = jsonb_build_object('status', v_st) where id = p_id;
  else
    update public.event_costs set estimated = 0, actual = null, quoted = case when quoted is null then null else 0 end,
           booking_id = null, requirement_key = null, crew_covered = false,
           voided_at = now(), voided_by = auth.uid(), void_reason = v_reason,
           void_before = jsonb_build_object('estimated', v_old -> 'estimated', 'actual', v_old -> 'actual', 'quoted', v_old -> 'quoted',
                                            'booking_id', v_old -> 'booking_id', 'requirement_key', v_old -> 'requirement_key',
                                            'crew_covered', v_old -> 'crew_covered')
     where id = p_id;
  end if;
  if not found then raise exception 'entry not found' using errcode = '42501'; end if;
  perform public._r404_audit(v_org, v_q, 'money.voided', case v_kind when 'refund' then 'event_refunds' when 'claim' then 'expense_claims'
                             when 'cost' then 'event_costs' else 'payment_milestones' end, p_id::text,
                             jsonb_build_object('reason', v_reason, 'kind', v_kind, 'before', v_old - array['org_id', 'request_key']));
  v_out := jsonb_build_object('voided', true, 'kind', v_kind, 'id', p_id, 'quote_id', v_q);
  perform public._r404_key_put(v_org, v_key, 'void', v_q, v_out);
  return v_out;
end $$;

-- the voided entries of one event (struck-through history on the money pages); each kind only for those who may see it
create or replace function public.money_voided_list(p_quote uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
-- r239-money-0404
declare v_org uuid := public.current_org_id(); v_fin boolean; v_set boolean; v jsonb := '[]'::jsonb;
begin
  v_fin := public.has_area('finance', 'view'); v_set := public.has_area('settlement', 'view');
  if auth.uid() is null or v_org is null or not (v_fin or v_set) then raise exception 'not authorized' using errcode = '42501'; end if;
  if not exists (select 1 from public.quotes q where q.id = p_quote and q.org_id = v_org) then raise exception 'event not found' using errcode = '42501'; end if;
  select coalesce(jsonb_agg(x.j order by x.at desc), '[]'::jsonb) into v from (
    select r.voided_at as at, jsonb_build_object('kind', 'refund', 'id', r.id, 'label', initcap(coalesce(r.kind, 'refund')) || coalesce(': ' || nullif(btrim(r.reason), ''), ''),
           'amount', r.amount, 'voided_at', r.voided_at, 'by', (select u.email from auth.users u where u.id = r.voided_by), 'reason', r.void_reason, 'before', r.void_before) as j
      from public.event_refunds r where v_set and r.quote_id = p_quote and r.org_id = v_org and r.voided_at is not null
    union all
    select e.voided_at, jsonb_build_object('kind', 'claim', 'id', e.id, 'label', coalesce(e.who, 'Claim') || coalesce(': ' || nullif(btrim(e.description), ''), ''),
           'amount', e.amount, 'voided_at', e.voided_at, 'by', (select u.email from auth.users u where u.id = e.voided_by), 'reason', e.void_reason, 'before', e.void_before)
      from public.expense_claims e where v_fin and e.quote_id = p_quote and e.org_id = v_org and e.voided_at is not null
    union all
    select c.voided_at, jsonb_build_object('kind', 'cost', 'id', c.id, 'label', coalesce(nullif(btrim(c.description), ''), c.category, 'Cost line'),
           'amount', coalesce((c.void_before ->> 'actual')::numeric, (c.void_before ->> 'estimated')::numeric, 0), 'voided_at', c.voided_at,
           'by', (select u.email from auth.users u where u.id = c.voided_by), 'reason', c.void_reason, 'before', c.void_before)
      from public.event_costs c where v_fin and c.quote_id = p_quote and c.org_id = v_org and c.voided_at is not null
    union all
    select m.voided_at, jsonb_build_object('kind', 'milestone', 'id', m.id, 'label', coalesce(m.label, 'Milestone'), 'amount', m.amount, 'voided_at', m.voided_at,
           'by', (select u.email from auth.users u where u.id = m.voided_by), 'reason', m.void_reason, 'before', m.void_before)
      from public.payment_milestones m where v_fin and m.quote_id = p_quote and m.org_id = v_org and m.voided_at is not null
    ) x;
  return jsonb_build_object('rows', v);
end $$;

-- ---- 7) reversal of a receipt (undo a paid milestone) ----------------------------------------------------------------------------
create or replace function public._r404_reverse(p_payment uuid, p_reason text, p_key text, p_prefer_ms uuid)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
-- r239-money-0404: a NEW minus receipt linked to the original (never an edit of it) + the milestones it covered back to Due
declare v_org uuid := public.current_org_id(); v_reason text := btrim(coalesce(p_reason, '')); v_key text := public._r404_key(p_key);
  p public.quote_payments; q public.quotes; ex public.quote_payments; v_rno text; v_closed boolean; v_paid_after numeric; v_ref numeric;
  v_gap numeric; v_cover numeric; v_ms_paid numeric; v_mid uuid; v_n integer := 0; v_tries integer := 0; v_out jsonb;
begin
  if char_length(v_reason) < 5 or char_length(v_reason) > 500 then raise exception 'Give a reason of 5 to 500 characters.' using errcode = '22023'; end if;
  select * into p from public.quote_payments x where x.id = p_payment and x.org_id = v_org;
  if p.id is null then raise exception 'payment not found' using errcode = '42501'; end if;
  perform pg_advisory_xact_lock(hashtextextended('helm:pay:quote:' || p.quote_id::text, 0));
  select * into q from public.quotes x where x.id = p.quote_id and x.org_id = v_org for update;
  if v_key is not null then
    select * into ex from public.quote_payments x where x.quote_id = p.quote_id and x.idempotency_key = v_key limit 1;
    if ex.id is not null then
      return jsonb_build_object('reversed', true, 'receipt_no', ex.receipt_no, 'amount', ex.amount, 'payment', ex.reverses_payment_id, 'duplicate', true); end if;
  end if;
  select * into p from public.quote_payments x where x.id = p_payment for update;
  if p.reverses_payment_id is not null then raise exception 'A reversal can''t be reversed - record the payment again instead.' using errcode = '22023'; end if;
  if p.status is distinct from 'paid' or not (coalesce(p.amount, 0) > 0) then raise exception 'Only a paid receipt can be reversed.' using errcode = '22023'; end if;
  if p.method = 'credit' and p.provider = 'credit' then
    raise exception 'This receipt was paid from a credit on account - it can''t be reversed.' using errcode = '22023'; end if;
  if exists (select 1 from public.quote_payments x where x.reverses_payment_id = p.id) then
    raise exception 'This payment was already reversed.' using errcode = '22023'; end if;
  v_closed := public._r282_event_closed(p.quote_id);
  if (v_closed or public._r404_frozen(p.quote_id)) and not public.is_admin() then
    raise exception 'This event is closed or its money is frozen - only an admin can reverse a payment on it.' using errcode = '42501'; end if;
  -- money given back can never be more than money received (the 0152 / 0156 refund rule)
  v_paid_after := public.helm_total_paid(p.quote_id, null, null) - p.amount;
  select coalesce(sum(r.amount), 0) into v_ref from public.event_refunds r
   where r.quote_id = p.quote_id and coalesce(r.kind, 'refund') = 'refund' and r.status in ('pending', 'approved', 'processed');
  if v_ref > v_paid_after + 0.5 then
    raise exception 'Refunds on this event (%) would be more than what is left paid (%) - reject or void a refund first.',
      to_char(v_ref, 'FM999999999990.00'), to_char(v_paid_after, 'FM999999999990.00') using errcode = '23514', hint = 'refund_over_paid'; end if;
  -- milestones already marked paid beyond the money before this reversal (old data) stay as they are
  select coalesce(sum(m.amount), 0) into v_ms_paid from public.payment_milestones m where m.quote_id = p.quote_id and m.status = 'paid' and m.voided_at is null;
  v_gap := greatest(v_ms_paid - (public.helm_total_paid(p.quote_id, null, null) + coalesce(public._r372_tds(p.quote_id), 0)), 0);

  loop
    v_tries := v_tries + 1;
    v_rno := left('REV-' || coalesce(nullif(btrim(p.receipt_no), ''), substr(p.id::text, 1, 8)), 60) || case when v_tries > 1 then '-' || v_tries::text else '' end;
    begin
      insert into public.quote_payments(quote_id, org_id, provider, amount, currency, status, provider_ref, receipt_no, method, simulated,
                                        paid_at, note, idempotency_key, is_demo, reverses_payment_id, reversal_reason, reversed_by)
        values (p.quote_id, p.org_id, 'reversal', -p.amount, p.currency, 'paid', v_rno, v_rno, p.method, coalesce(p.simulated, false),
                now(), left('Reversal of ' || coalesce(p.receipt_no, 'a payment') || ': ' || v_reason, 200), v_key, coalesce(p.is_demo, false),
                p.id, v_reason, auth.uid());
      exit;
    exception when unique_violation then
      if exists (select 1 from public.quote_payments x where x.reverses_payment_id = p.id) then
        raise exception 'This payment was already reversed.' using errcode = '22023'; end if;
      if v_tries >= 5 then raise; end if;
    end;
  end loop;

  -- the milestones that money had covered go back to Due (the one asked for first, then the newest paid)
  v_cover := public.helm_total_paid(p.quote_id, null, null) + coalesce(public._r372_tds(p.quote_id), 0) + v_gap;
  if v_closed then perform set_config('helm.r282_pay', p.quote_id::text, true); end if;
  loop
    select coalesce(sum(m.amount), 0) into v_ms_paid from public.payment_milestones m where m.quote_id = p.quote_id and m.status = 'paid' and m.voided_at is null;
    exit when v_ms_paid <= v_cover + 0.5 or v_n >= 200;
    select m.id into v_mid from public.payment_milestones m
     where m.quote_id = p.quote_id and m.status = 'paid' and m.voided_at is null
     order by (m.id = p_prefer_ms) desc, m.paid_at desc nulls last, m.due_date desc nulls last, m.seq desc nulls last, m.created_at desc limit 1;
    exit when v_mid is null;
    update public.payment_milestones set status = 'due', paid_at = null where id = v_mid;
    v_n := v_n + 1;
  end loop;
  if v_closed then perform set_config('helm.r282_pay', '', true); end if;
  update public.quotes set updated_at = now() where id = p.quote_id;
  v_out := jsonb_build_object('reversed', true, 'receipt_no', v_rno, 'amount', -p.amount, 'payment', p.id, 'milestones_reopened', v_n);
  perform public._r404_audit(v_org, p.quote_id, 'payment_reversed', 'quote_payments', p.id::text,
    jsonb_build_object('reason', v_reason, 'amount', p.amount, 'receipt_no', p.receipt_no, 'reversal_receipt', v_rno, 'milestones_reopened', v_n,
                       'after_close', v_closed));
  return v_out;
end $$;

create or replace function public.payment_reverse(p_payment uuid, p_reason text, p_key text default null)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
-- r239-money-0404
begin
  if auth.uid() is null or public.current_org_id() is null or not public.has_area('finance', 'edit') then
    raise exception 'not authorized' using errcode = '42501'; end if;
  return public._r404_reverse(p_payment, p_reason, p_key, null);
end $$;

-- "Undo paid" on a milestone: reverses the receipt that marked it (settle_milestone writes "Milestone: <label>", same amount)
create or replace function public.milestone_undo_paid(p_milestone uuid, p_reason text, p_key text default null)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
-- r239-money-0404
declare v_org uuid := public.current_org_id(); m public.payment_milestones; v_pay uuid; v_rep jsonb; v_key text := public._r404_key(p_key);
begin
  if auth.uid() is null or v_org is null or not public.has_area('finance', 'edit') then raise exception 'not authorized' using errcode = '42501'; end if;
  select * into m from public.payment_milestones x where x.id = p_milestone and x.org_id = v_org;
  if m.id is null then raise exception 'no such milestone' using errcode = '42501'; end if;
  perform pg_advisory_xact_lock(hashtextextended('helm:pay:quote:' || m.quote_id::text, 0));
  if v_key is not null and exists (select 1 from public.quote_payments x where x.quote_id = m.quote_id and x.idempotency_key = v_key) then
    return public._r404_reverse((select x.reverses_payment_id from public.quote_payments x where x.quote_id = m.quote_id and x.idempotency_key = v_key limit 1),
                                coalesce(nullif(btrim(p_reason), ''), 'repeat request'), v_key, m.id);
  end if;
  select * into m from public.payment_milestones x where x.id = p_milestone for update;
  if m.status is distinct from 'paid' then raise exception 'This milestone is not paid.' using errcode = '22023'; end if;
  select x.id into v_pay from public.quote_payments x
   where x.quote_id = m.quote_id and x.status = 'paid' and x.amount > 0 and x.reverses_payment_id is null
     and x.amount = m.amount and x.note = left('Milestone: ' || coalesce(m.label, ''), 200)
     and not exists (select 1 from public.quote_payments y where y.reverses_payment_id = x.id)
   order by x.paid_at desc nulls last, x.created_at desc limit 1;
  if v_pay is null then
    raise exception 'This milestone was covered by a payment recorded for the whole event. To undo it, reverse that payment under Settlement -> Receipts.'
      using errcode = '22023', hint = 'r404_reverse_receipt'; end if;
  return public._r404_reverse(v_pay, p_reason, v_key, m.id);
end $$;

-- ---- 8) credit on account ------------------------------------------------------------------------------------------------------
create or replace function public.record_payment_with_credit(p_quote uuid, p_amount numeric, p_method text default 'cash',
                                                              p_note text default null, p_key text default null)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
-- r239-money-0404: what is due = the normal receipt (cap 0110 unchanged); the extra = a credit on account (never revenue)
declare v_org uuid := public.current_org_id(); v_key text := public._r404_key(p_key); v_amt numeric := round(p_amount, 2);
  v_method text := lower(coalesce(nullif(btrim(coalesce(p_method, '')), ''), 'cash')); v_note text := nullif(btrim(coalesce(p_note, '')), '');
  v_room numeric; v_pay numeric; v_cred numeric; v_out jsonb := '{}'::jsonb; c public.money_credits; v_base numeric;
begin
  if auth.uid() is null or v_org is null or not public.has_area('settlement', 'edit') then raise exception 'not authorized' using errcode = '42501'; end if;
  if v_key is null then raise exception 'request key required' using errcode = '22023'; end if;
  if v_method !~ '^[a-z_]{2,20}$' then raise exception 'unknown payment method' using errcode = '22023'; end if;
  if v_note is not null and char_length(v_note) > 300 then raise exception 'note too long' using errcode = '22023'; end if;
  if v_amt is null or v_amt <= 0 or v_amt >= 10000000000 then raise exception 'amount must be greater than zero' using errcode = '22023'; end if;
  if not exists (select 1 from public.quotes q where q.id = p_quote and q.org_id = v_org) then raise exception 'no such event' using errcode = '42501'; end if;
  perform pg_advisory_xact_lock(hashtextextended('helm:pay:quote:' || p_quote::text, 0));
  -- the same form again: the same answer
  select * into c from public.money_credits x where x.org_id = v_org and x.request_key = v_key;
  if c.id is not null then
    return jsonb_build_object('duplicate', true, 'credit', jsonb_build_object('id', c.id, 'amount', c.amount),
      'paid', coalesce((select x.amount from public.quote_payments x where x.quote_id = p_quote and x.idempotency_key = v_key limit 1), 0)); end if;
  if exists (select 1 from public.quote_payments x where x.quote_id = p_quote and x.idempotency_key = v_key) then
    return public.record_settlement_payment(p_quote, v_amt, v_method, null, null, v_note, v_key) || jsonb_build_object('credit', null); end if;
  select public.helm_pricing_num(q.pricing -> 'total') into v_base from public.quotes q where q.id = p_quote;
  if coalesce(v_base, 0) <= 0 then raise exception 'this event has no quote total yet - price the quote before recording a payment' using errcode = '23514'; end if;
  v_room := greatest(public._r404_room(p_quote), 0);
  if v_amt <= v_room + 0.5 then
    return public.record_settlement_payment(p_quote, v_amt, v_method, null, null, coalesce(v_note, 'Settlement payment'), v_key) || jsonb_build_object('credit', null); end if;
  v_pay := round(v_room, 2); v_cred := round(v_amt - v_pay, 2);
  if v_pay > 0.005 then
    v_out := public.record_settlement_payment(p_quote, v_pay, v_method, null, null, coalesce(v_note, 'Settlement payment'), v_key);
  end if;
  insert into public.money_credits(org_id, quote_id, amount, source, method, note, request_key, created_by, created_email)
    values (v_org, p_quote, v_cred, 'overpayment', v_method, coalesce(v_note, 'Paid over the balance due'), v_key, auth.uid(), public._r404_who())
    returning * into c;
  perform public._r404_audit(v_org, p_quote, 'money.credit_recorded', 'money_credits', c.id::text,
    jsonb_build_object('received', v_amt, 'recorded_as_payment', v_pay, 'credit', v_cred, 'method', v_method));
  return v_out || jsonb_build_object('paid', v_pay, 'credit', jsonb_build_object('id', c.id, 'amount', c.amount));
end $$;

create or replace function public.money_credit_apply(p_credit uuid, p_key text default null)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
-- r239-money-0404: the credit (or the part that is due) becomes a receipt (method credit); what is left stays as a new credit
declare v_org uuid := public.current_org_id(); c public.money_credits; v_room numeric; v_amt numeric; v_out jsonb; v_pid uuid; v_rest public.money_credits;
  v_k text;
begin
  perform public._r404_key(p_key);
  if auth.uid() is null or v_org is null or not public.has_area('settlement', 'edit') then raise exception 'not authorized' using errcode = '42501'; end if;
  select * into c from public.money_credits x where x.id = p_credit and x.org_id = v_org;
  if c.id is null then raise exception 'credit not found' using errcode = '42501'; end if;
  perform pg_advisory_xact_lock(hashtextextended('helm:pay:quote:' || c.quote_id::text, 0));
  select * into c from public.money_credits x where x.id = p_credit for update;
  v_k := 'credit-apply:' || c.id::text;
  if c.status = 'applied' then
    return jsonb_build_object('duplicate', true, 'applied', c.applied_amount, 'payment', c.applied_payment_id); end if;
  if c.status <> 'open' then raise exception 'This credit was already given back to the client.' using errcode = '22023'; end if;
  v_room := public._r404_room(c.quote_id);
  if v_room <= 0.005 then raise exception 'Nothing is due on this event right now - the credit stays on account.' using errcode = '22023'; end if;
  v_amt := round(least(c.amount, v_room), 2);
  v_out := public.record_settlement_payment(c.quote_id, v_amt, 'credit', null, null, 'Credit on account applied', v_k);
  select x.id into v_pid from public.quote_payments x where x.quote_id = c.quote_id and x.idempotency_key = v_k limit 1;
  update public.money_credits set status = 'applied', closed_at = now(), closed_by = auth.uid(), closed_email = public._r404_who(),
         close_note = 'applied to the balance', applied_payment_id = v_pid, applied_amount = v_amt where id = c.id;
  if c.amount - v_amt > 0.005 then
    insert into public.money_credits(org_id, quote_id, amount, source, parent_id, method, note, created_by, created_email)
      values (c.org_id, c.quote_id, round(c.amount - v_amt, 2), 'remainder', c.id, c.method, 'Left after applying part of a credit', auth.uid(), public._r404_who())
      returning * into v_rest;
  end if;
  perform public._r404_audit(v_org, c.quote_id, 'money.credit_applied', 'money_credits', c.id::text,
    jsonb_build_object('applied', v_amt, 'left', case when v_rest.id is null then 0 else v_rest.amount end, 'receipt_no', v_out ->> 'receipt_no'));
  return v_out || jsonb_build_object('applied', v_amt, 'left', case when v_rest.id is null then null else jsonb_build_object('id', v_rest.id, 'amount', v_rest.amount) end);
end $$;

create or replace function public.money_credit_refund(p_credit uuid, p_reason text, p_key text default null)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
-- r239-money-0404: the credit was given back to the client (outside the ledger: it was never a receipt)
declare v_org uuid := public.current_org_id(); c public.money_credits; v_reason text := btrim(coalesce(p_reason, ''));
begin
  perform public._r404_key(p_key);
  if auth.uid() is null or v_org is null or not public.has_area('finance', 'edit') then raise exception 'not authorized' using errcode = '42501'; end if;
  if char_length(v_reason) < 5 or char_length(v_reason) > 500 then raise exception 'Give a reason of 5 to 500 characters.' using errcode = '22023'; end if;
  select * into c from public.money_credits x where x.id = p_credit and x.org_id = v_org;
  if c.id is null then raise exception 'credit not found' using errcode = '42501'; end if;
  perform pg_advisory_xact_lock(hashtextextended('helm:pay:quote:' || c.quote_id::text, 0));
  select * into c from public.money_credits x where x.id = p_credit for update;
  if c.status = 'refunded' then return jsonb_build_object('duplicate', true, 'refunded', c.amount); end if;
  if c.status <> 'open' then raise exception 'This credit was already applied to the balance.' using errcode = '22023'; end if;
  update public.money_credits set status = 'refunded', closed_at = now(), closed_by = auth.uid(), closed_email = public._r404_who(), close_note = v_reason
   where id = c.id;
  perform public._r404_audit(v_org, c.quote_id, 'money.credit_refunded', 'money_credits', c.id::text, jsonb_build_object('amount', c.amount, 'reason', v_reason));
  return jsonb_build_object('refunded', c.amount, 'id', c.id);
end $$;

create or replace function public.money_credits_list(p_quote uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
-- r239-money-0404
declare v_org uuid := public.current_org_id(); v_rows jsonb;
begin
  if auth.uid() is null or v_org is null or not (public.has_area('finance', 'view') or public.has_area('settlement', 'view')) then
    raise exception 'not authorized' using errcode = '42501'; end if;
  if not exists (select 1 from public.quotes q where q.id = p_quote and q.org_id = v_org) then raise exception 'event not found' using errcode = '42501'; end if;
  select coalesce(jsonb_agg(jsonb_build_object('id', c.id, 'amount', c.amount, 'status', c.status, 'source', c.source, 'method', c.method, 'note', c.note,
           'created_at', c.created_at, 'by', c.created_email, 'closed_at', c.closed_at, 'closed_by', c.closed_email, 'close_note', c.close_note,
           'applied_amount', c.applied_amount, 'parent_id', c.parent_id) order by c.created_at desc), '[]'::jsonb)
    into v_rows from public.money_credits c where c.quote_id = p_quote and c.org_id = v_org;
  return jsonb_build_object('rows', v_rows,
    'open_total', coalesce((select sum(c.amount) from public.money_credits c where c.quote_id = p_quote and c.org_id = v_org and c.status = 'open'), 0),
    'due_now', greatest(public._r404_room(p_quote), 0),
    'can_record', public.has_area('settlement', 'edit'), 'can_apply', public.has_area('settlement', 'edit'), 'can_refund', public.has_area('finance', 'edit'));
end $$;

-- ---- 9) request keys for the two 0372 money calls that had none ----------------------------------------------------------------
create or replace function public.money_correction_add_once(p_key text, p_quote uuid, p_category text, p_amount numeric, p_reason text,
                                                             p_target_kind text default null, p_target_id uuid default null)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
-- r239-money-0404
declare v_org uuid := public.current_org_id(); v_key text := public._r404_key(p_key); v jsonb;
begin
  if auth.uid() is null or v_org is null then raise exception 'not authorized' using errcode = '42501'; end if;
  if v_key is null then raise exception 'request key required' using errcode = '22023'; end if;
  v := public._r404_key_get(v_org, v_key);
  if v is not null then return v; end if;
  v := public.money_correction_add(p_quote, p_category, p_amount, p_reason, p_target_kind, p_target_id);
  perform public._r404_key_put(v_org, v_key, 'correction', p_quote, v);
  return v;
end $$;

create or replace function public.client_tds_record_once(p_key text, p_quote uuid, p_amount numeric, p_section text default null, p_rate numeric default null,
                                                          p_note text default null, p_payment uuid default null)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
-- r239-money-0404
declare v_org uuid := public.current_org_id(); v_key text := public._r404_key(p_key); v jsonb;
begin
  if auth.uid() is null or v_org is null then raise exception 'not authorized' using errcode = '42501'; end if;
  if v_key is null then raise exception 'request key required' using errcode = '22023'; end if;
  v := public._r404_key_get(v_org, v_key);
  if v is not null then return v; end if;
  v := public.client_tds_record(p_quote, p_amount, p_section, p_rate, p_note, p_payment);
  perform public._r404_key_put(v_org, v_key, 'client_tds', p_quote, v);
  return v;
end $$;

-- ---- 10) a reversal never tells the client "payment received" (patched in place, old body kept once) ------------------------------
do $$ declare v_def text; v_anchor constant text := 'if new.status = ''paid'' and (tg_op = ''INSERT'' or old.status is distinct from ''paid'')'; begin
  v_def := pg_get_functiondef('public._pkg_tg_payment()'::regprocedure);
  if position('r239-money-0404' in v_def) = 0 then
    if (length(v_def) - length(replace(v_def, v_anchor, ''))) / length(v_anchor) <> 1 then
      raise notice '0404: _pkg_tg_payment has an unexpected body - left unchanged';
    else
      if to_regprocedure('public._pkg_tg_payment__pre0404()') is null then
        execute replace(v_def, 'FUNCTION public._pkg_tg_payment()', 'FUNCTION public._pkg_tg_payment__pre0404()');
      end if;
      execute replace(v_def, v_anchor, 'if new.status = ''paid'' and coalesce(new.amount, 0) > 0 /* r239-money-0404: never for a reversal */ and (tg_op = ''INSERT'' or old.status is distinct from ''paid'')');
    end if;
  end if;
end $$;

-- ---- 11) free-trial retention (0184): the new money records go with the studio's events ----------------------------------------
do $$ declare v_def text; begin
  if to_regprocedure('public._tr184_purge_tables()') is not null then
    v_def := pg_get_functiondef('public._tr184_purge_tables()'::regprocedure);
    if position('''money_credits''' in v_def) = 0 then
      if (length(v_def) - length(replace(v_def, '''client_tds_certificates''', ''))) / length('''client_tds_certificates''') <> 1 then
        raise notice '0404: _tr184_purge_tables has an unexpected body - left unchanged';
      else execute replace(v_def, '''client_tds_certificates''', '''money_credits'', ''money_request_keys'', ''event_money_freeze_log'', ''event_money_freezes'', ''client_tds_certificates'''); end if;
    end if;
  end if;
end $$;

-- ---- 12) grants: page calls for signed-in staff (each checks its area); helpers for the server only ----------------------------
do $$
declare f text;
begin
  foreach f in array array['public._r404_key(text)', 'public._r404_key_get(uuid,text)', 'public._r404_key_put(uuid,text,text,uuid,jsonb)',
                           'public._r404_who()', 'public._r404_frozen(uuid)', 'public._r404_room(uuid)', 'public._r404_audit(uuid,uuid,text,text,text,jsonb)',
                           'public._r404_tg_money_guard()', 'public._r404_tg_money_freeze()', 'public._r404_tg_credit_keep()',
                           'public._r404_reverse(uuid,text,text,uuid)'] loop
    execute format('revoke all on function %s from public', f);
    if exists (select 1 from pg_roles where rolname = 'anon') then execute format('revoke all on function %s from anon', f); end if;
    if exists (select 1 from pg_roles where rolname = 'authenticated') then execute format('revoke all on function %s from authenticated', f); end if;
  end loop;
  if to_regprocedure('public._pkg_tg_payment__pre0404()') is not null then
    revoke all on function public._pkg_tg_payment__pre0404() from public;
    if exists (select 1 from pg_roles where rolname = 'anon') then revoke all on function public._pkg_tg_payment__pre0404() from anon; end if;
    if exists (select 1 from pg_roles where rolname = 'authenticated') then revoke all on function public._pkg_tg_payment__pre0404() from authenticated; end if;
    if exists (select 1 from pg_roles where rolname = 'service_role') then revoke all on function public._pkg_tg_payment__pre0404() from service_role; end if;
  end if;
  foreach f in array array['public.money_void(text,uuid,text,text)', 'public.money_voided_list(uuid)',
                           'public.payment_reverse(uuid,text,text)', 'public.milestone_undo_paid(uuid,text,text)',
                           'public.record_payment_with_credit(uuid,numeric,text,text,text)', 'public.money_credit_apply(uuid,text)',
                           'public.money_credit_refund(uuid,text,text)', 'public.money_credits_list(uuid)',
                           'public.event_money_freeze_get(uuid)', 'public.event_money_freeze_set(uuid,boolean,text)',
                           'public.money_correction_add_once(text,uuid,text,numeric,text,text,uuid)',
                           'public.client_tds_record_once(text,uuid,numeric,text,numeric,text,uuid)'] loop
    execute format('revoke all on function %s from public', f);
    if exists (select 1 from pg_roles where rolname = 'anon') then execute format('revoke all on function %s from anon', f); end if;
    if exists (select 1 from pg_roles where rolname = 'authenticated') then execute format('grant execute on function %s to authenticated', f); end if;
    if exists (select 1 from pg_roles where rolname = 'service_role') then execute format('grant execute on function %s to service_role', f); end if;
  end loop;
end $$;

notify pgrst, 'reload schema';

-- ---- VERIFY: every ok must be true ------------------------------------------------------------------------------------------------
select item, ok from (values
  ('01 void + request-key columns on refunds, claims, cost lines, milestones; reversal link on payments',
     (select count(*) from information_schema.columns where table_schema = 'public' and column_name in ('voided_at', 'voided_by', 'void_reason', 'void_before', 'request_key')
        and table_name in ('event_refunds', 'expense_claims', 'event_costs', 'payment_milestones')) = 20
     and (select count(*) from information_schema.columns where table_schema = 'public' and table_name = 'quote_payments'
        and column_name in ('reverses_payment_id', 'reversal_reason', 'reversed_by')) = 3),
  ('02 one form = one row: a unique request-key index on each of the 4 tables; one reversal per receipt',
     (select count(*) from pg_indexes where schemaname = 'public' and indexname in ('event_refunds_r404_request_key_uq', 'expense_claims_r404_request_key_uq',
        'event_costs_r404_request_key_uq', 'payment_milestones_r404_request_key_uq', 'quote_payments_r404_one_reversal_uq')) = 5),
  ('03 payment amount check: only a reversal row may be a minus amount; every existing payment passes it',
     exists (select 1 from pg_constraint where conrelid = 'public.quote_payments'::regclass and conname = 'quote_payments_amount_finite_chk'
             and pg_get_constraintdef(oid) like '%reverses_payment_id%')
     and exists (select 1 from pg_constraint where conrelid = 'public.quote_payments'::regclass and conname = 'quote_payments_r404_reversal_sign_chk')
     and not exists (select 1 from public.quote_payments where not ((amount >= 0 and amount < 1000000000000) or (reverses_payment_id is not null and amount < 0)))
     -- R244: the hand-applied amount_pos rule, where it exists, allows a reversal row too
     and not exists (select 1 from pg_constraint where conrelid = 'public.quote_payments'::regclass and conname = 'quote_payments_amount_pos'
                     and pg_get_constraintdef(oid) not like '%reverses_payment_id%')),
  ('04 every voided entry keeps its reason and what it was (this file voids nothing)',
     not exists (select 1 from public.event_refunds where voided_at is not null and (void_reason is null or void_before is null))
     and not exists (select 1 from public.expense_claims where voided_at is not null and (void_reason is null or void_before is null))
     and not exists (select 1 from public.event_costs where voided_at is not null and (void_reason is null or void_before is null))
     and not exists (select 1 from public.payment_milestones where voided_at is not null and (void_reason is null or void_before is null))),
  ('05 signed-in users can no longer hard-delete these rows + voided rows kept as they are (guard trigger on 4 tables)',
     (select count(*) from pg_trigger where tgname = 'zzzzz_r404_money_guard' and tgrelid in ('public.event_refunds'::regclass,
        'public.expense_claims'::regclass, 'public.event_costs'::regclass, 'public.payment_milestones'::regclass)) = 4),
  ('06 Freeze now: the lock trigger on the 9 money tables + quote price',
     (select count(*) from pg_trigger where tgname = 'ab_r404_money_freeze') = 9),
  ('07 four new tables, RLS on, closed to the app (functions only)',
     (select count(*) from pg_class where oid in (to_regclass('public.money_request_keys'), to_regclass('public.money_credits'),
        to_regclass('public.event_money_freezes'), to_regclass('public.event_money_freeze_log')) and relrowsecurity) = 4
     and not has_table_privilege('authenticated', 'public.money_credits', 'select')
     and not has_table_privilege('anon', 'public.event_money_freezes', 'select')
     and not has_table_privilege('authenticated', 'public.money_request_keys', 'insert')),
  ('08 page calls for signed-in staff only; helpers server only',
     has_function_privilege('authenticated', 'public.money_void(text,uuid,text,text)', 'execute')
     and has_function_privilege('authenticated', 'public.payment_reverse(uuid,text,text)', 'execute')
     and has_function_privilege('authenticated', 'public.record_payment_with_credit(uuid,numeric,text,text,text)', 'execute')
     and has_function_privilege('authenticated', 'public.event_money_freeze_set(uuid,boolean,text)', 'execute')
     and not has_function_privilege('anon', 'public.money_void(text,uuid,text,text)', 'execute')
     and not has_function_privilege('anon', 'public.money_credits_list(uuid)', 'execute')
     and not has_function_privilege('authenticated', 'public._r404_reverse(uuid,text,text,uuid)', 'execute')
     and not has_function_privilege('authenticated', 'public._r404_key_put(uuid,text,text,uuid,jsonb)', 'execute')),
  ('09 a reversal never sends "payment received" (_pkg_tg_payment patched once, old body kept, nobody may run it)',
     position('r239-money-0404' in pg_get_functiondef('public._pkg_tg_payment()'::regprocedure)) > 0
     and to_regprocedure('public._pkg_tg_payment__pre0404()') is not null
     and not has_function_privilege('authenticated', 'public._pkg_tg_payment__pre0404()', 'execute')),
  ('10 every 0404 definer function pins an empty search_path',
     not exists (select 1 from pg_proc p where p.pronamespace = 'public'::regnamespace and p.prosrc like '%r239-money-0404%' and p.prosecdef
                 and coalesce(array_to_string(p.proconfig, ','), '') not like '%search_path=""%')),
  ('11 the free-trial purge knows the new money tables (or 0184 is absent)',
     to_regprocedure('public._tr184_purge_tables()') is null
     or position('''money_credits''' in pg_get_functiondef(to_regprocedure('public._tr184_purge_tables()'))) > 0),
  ('12 every reversal is linked to a receipt of the same event and cancels it exactly',
     not exists (select 1 from public.quote_payments r left join public.quote_payments o on o.id = r.reverses_payment_id
                  where r.reverses_payment_id is not null and (o.id is null or o.quote_id <> r.quote_id or r.amount <> -o.amount)))
) v(item, ok) order by item;
commit;
