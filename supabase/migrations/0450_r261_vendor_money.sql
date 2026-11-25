-- 0450_r261_vendor_money.sql - R261 (owner, 25 Nov 2026: "i didnt pay the vendor invoice yet check out what is happening", "missing or damaged items pay
-- for vendors is also not there ... to keep perfect track of P and L"). Forward-only, additive, safe to run twice. ASCII only. Paste the whole file in
-- the Supabase SQL editor; the last statement answers one row per check. The pages work without it (the new parts stay hidden).
-- REQUIRES 0387 (the ledger body), 0372 / 0373 (vendor_bill_pay), 0396 (_r396_event), 0404 (freeze), 0442 (_r442_name), 0447 (_r447_cur).
--
-- In plain words:
--   A  CHARGED BY THE VENDOR. Something of a vendor was missing or broken and they ask to be paid for it: event_vendor_charges keeps what, how many, how
--      much, a note and where it stands - asked (not agreed yet), agreed, already in their invoice, or taken back (with a reason; the row is kept).
--      Agreed = ONE vendor bill of its own ("Vendor damage: ..."), so paying, TDS, reminders, cash and the vendor's balance work as for every bill.
--      Already in their invoice = no bill, so it is never counted twice. Taken back = that bill is voided (never with a payment on it).
--   B  THE COST COUNTS ONCE. The event's cost ledger shows these bills as their own lines under Damages, next to the vendor's agreed price and whatever
--      the "bills or typed vendor lines, the larger" rule (0146) says about other unlinked bills. Asked = expected, not actual. Closed events that are
--      frozen keep their frozen figures; the money of events without such a charge does not change at all.
--   C  PAYING A VENDOR WHO SENT NO BILL. vendor_booking_pay makes the bill of the agreed price and records the payment in one go (same key = once).
--   D  CLOSED WITHOUT PAYMENT. event_resources.settled_reason: why nothing is paid. Rows settled before stay as they are.
--   Rights: A + C change = Finance edit; A see = Finance view or Settlement view. Same studio only, signed in only, closed events and frozen money take
--   nothing. Read-only studios write nothing.
--
-- ZERO DATA LOSS: 1 new table, 1 new column (empty), new functions; _r21_cost_lines is kept as _r21_cost_lines__pre0450 and wrapped; its innermost body
-- (_r21_cost_lines__pre0372, 0387) gets one condition. No stored row is changed or removed. ROLLBACK (manual): drop the wrapper, rename
-- _r21_cost_lines__pre0450 back, run the _r21_cost_lines__pre0372 part of 0387 again; the table and the column can stay.
-- PASTE ORDER: if 0372, 0373, 0374 or 0387 is ever pasted again, paste 0450 after it. If 0448 is pasted again nothing is needed.

do $$ declare f text; begin
  foreach f in array array['public._r396_event(uuid)', 'public._r442_name()', 'public._r447_cur(uuid,uuid)', 'public.has_area(text,text)', 'public._r21_cost_lines(uuid,uuid)', 'public._r21_cost_lines__pre0372(uuid,uuid)', 'public._r372_cfg(uuid)', 'public._r372_tz(uuid)', 'public._r373_open(uuid)',
      'public.vendor_bill_pay(uuid,numeric,numeric,text,date,text,text,text)', 'public.studio_today(uuid,timestamptz)'] loop
    if to_regprocedure(f) is null then raise exception 'STOP 0450: run 0373, 0387, 0396, 0442 and 0447 first (% missing)', f; end if;
  end loop;
  if to_regclass('public.vendor_bills') is null or to_regclass('public.vendor_payouts') is null or to_regclass('public.event_resources') is null or to_regclass('public.event_money_freezes') is null or to_regclass('public.event_closure') is null then
    raise exception 'STOP 0450: the vendor bills (0124) or the money safety tables (0404) are missing'; end if;
end $$;

-- ---- 1) D: why a vendor is settled without a payment ---------------------------------------------------------------------------
alter table public.event_resources add column if not exists settled_reason text;
comment on column public.event_resources.settled_reason is 'r261-0450: why this vendor was closed without a payment (empty = not said)';
do $$ begin
  if not exists (select 1 from pg_constraint where conrelid = 'public.event_resources'::regclass and conname = 'event_resources_settled_reason_chk450') then
    alter table public.event_resources add constraint event_resources_settled_reason_chk450 check (settled_reason is null or (char_length(btrim(settled_reason)) between 3 and 300 and settled_reason !~ '[<>]'));
  end if;
end $$;

-- ---- 2) A: the charges ---------------------------------------------------------------------------------------------------------
create table if not exists public.event_vendor_charges (
  id           uuid primary key default gen_random_uuid(),
  seq          bigint generated always as identity,
  org_id       uuid not null references public.organizations(id),
  quote_id     uuid not null references public.quotes(id) on delete cascade,
  booking_id   uuid not null,
  vendor_id    uuid,
  vendor_name  text not null,
  label        text not null,
  qty          numeric,
  amount       numeric not null,
  state        text not null,
  note         text,
  bill_id      uuid references public.vendor_bills(id) on delete set null,
  void_reason  text,
  by_user      uuid,
  by_name      text,
  created_at   timestamptz not null default clock_timestamp(),
  changed_by   uuid,
  changed_name text,
  changed_at   timestamptz,
  request_id   uuid not null,
  constraint event_vendor_charges_state_chk450 check (state in ('asked', 'agreed', 'in_invoice', 'void') and (state <> 'void' or char_length(btrim(coalesce(void_reason, ''))) >= 3) and (state <> 'agreed' or bill_id is not null or changed_at is not null)),
  constraint event_vendor_charges_num_chk450 check (amount > 0 and amount <= 1000000000 and amount = round(amount, 2) and (qty is null or (qty > 0 and qty <= 1000000))),
  constraint event_vendor_charges_text_chk450 check (char_length(btrim(label)) between 1 and 120 and char_length(vendor_name) between 1 and 120 and char_length(coalesce(note, '')) <= 300 and char_length(coalesce(void_reason, '')) <= 300 and char_length(coalesce(by_name, '')) <= 80 and char_length(coalesce(changed_name, '')) <= 80)
);
comment on table public.event_vendor_charges is 'r261-0450: what a vendor charges for their missing / broken items: asked, agreed (its own vendor bill), already in their invoice, or taken back (kept). Written only by event_vendor_charge_add / event_vendor_charge_set.';
create index if not exists event_vendor_charges_quote450 on public.event_vendor_charges (quote_id, seq);
create index if not exists event_vendor_charges_org450 on public.event_vendor_charges (org_id);
create index if not exists event_vendor_charges_bill450 on public.event_vendor_charges (bill_id) where bill_id is not null;
create unique index if not exists event_vendor_charges_req450 on public.event_vendor_charges (request_id);

do $$ declare r text; v_def text; begin
  alter table public.event_vendor_charges enable row level security;
  revoke all on table public.event_vendor_charges from public;
  foreach r in array array['anon', 'authenticated', 'service_role'] loop
    if exists (select 1 from pg_roles where rolname = r) then execute format('revoke all on table public.event_vendor_charges from %I', r); end if;
  end loop;
  if exists (select 1 from pg_roles where rolname = 'service_role') then grant select on table public.event_vendor_charges to service_role; end if;
  if to_regprocedure('public.tg_quote_org_match()') is not null and not exists (select 1 from pg_trigger where tgrelid = 'public.event_vendor_charges'::regclass and tgname = 'zz_quote_org_match') then
    create trigger zz_quote_org_match before insert or update on public.event_vendor_charges for each row execute function public.tg_quote_org_match();
  end if;
  if to_regprocedure('public.tg_studio_read_only()') is not null and not exists (select 1 from pg_trigger where tgrelid = 'public.event_vendor_charges'::regclass and tgname = 'zzz_studio_read_only') then
    create trigger zzz_studio_read_only before insert or update or delete on public.event_vendor_charges for each row execute function public.tg_studio_read_only('org_id');
  end if;
  if to_regprocedure('public.tg_audit()') is not null and not exists (select 1 from pg_trigger where tgrelid = 'public.event_vendor_charges'::regclass and tgname = 'audit_trg') then
    create trigger audit_trg after insert or update or delete on public.event_vendor_charges for each row execute function public.tg_audit();
  end if;
  -- free-trial retention (0184): they go with the studio's events (patched in place once, like 0448)
  if to_regprocedure('public._tr184_purge_tables()') is not null then
    v_def := pg_get_functiondef('public._tr184_purge_tables()'::regprocedure);
    if position('''event_vendor_charges''' in v_def) = 0 then
      if (length(v_def) - length(replace(v_def, '''event_issues'', ', ''))) / length('''event_issues'', ') <> 1 then
        raise notice '0450: _tr184_purge_tables has an unexpected body - left unchanged';
      else execute replace(v_def, '''event_issues'', ', '''event_issues'', ''event_vendor_charges'', '); end if;
    end if;
  end if;
end $$;

-- ---- 3) helpers (server only) --------------------------------------------------------------------------------------------------
create or replace function public._r450_text(p_text text, p_max integer)
returns text language plpgsql immutable set search_path = '' as $fn$
-- r261-0450
declare v text := nullif(btrim(regexp_replace(coalesce(p_text, ''), '[[:cntrl:][:space:]]+', ' ', 'g')), '');
begin
  if char_length(coalesce(v, '')) > p_max then raise exception 'Use up to % characters.', p_max using errcode = '22023', hint = 'r450_text'; end if;
  if coalesce(v, '') ~ '[<>]' then raise exception 'Leave out < and >.' using errcode = '22023', hint = 'r450_text'; end if;
  return v;
end $fn$;
-- may this event's vendor money change now? answers the studio
create or replace function public._r450_open(p_quote uuid)
returns uuid language plpgsql stable security definer set search_path = '' as $fn$
-- r261-0450
declare v_org uuid := public._r396_event(p_quote); v_why text;
begin
  if not coalesce(public.has_area('finance', 'edit'), false) then raise exception 'not allowed' using errcode = '42501'; end if;
  if exists (select 1 from public.event_closure c where c.quote_id = p_quote and c.closed_at is not null) then
    raise exception 'This event is closed - re-open it first, or add a late bill on the Settlement page.' using errcode = '22023', hint = 'r450_closed'; end if;
  select coalesce(f.reason, 'no reason') into v_why from public.event_money_freezes f where f.quote_id = p_quote and f.frozen limit 1;
  if v_why is not null then raise exception 'The money on this event is frozen (%). An admin can unfreeze it on the Settlement page.', v_why using errcode = '22023', hint = 'r450_frozen'; end if;
  return v_org;
end $fn$;
-- one bill of its own for an agreed charge
create or replace function public._r450_bill(p public.event_vendor_charges)
returns uuid language plpgsql volatile security definer set search_path = '' as $fn$
-- r261-0450: not linked to the booking (a linked bill would replace the agreed price), the vendor and the event are the same
declare v uuid;
begin
  insert into public.vendor_bills(org_id, quote_id, booking_id, vendor_id, bill_date, description, amount, currency)
    values (p.org_id, p.quote_id, null, (select x.id from public.vendors x where x.id = p.vendor_id and x.org_id = p.org_id), public.studio_today(p.org_id),
            left('Vendor damage: ' || p.label || case when p.qty is not null then ' x' || trim(trailing '.' from to_char(p.qty, 'FM999999990.##')) else '' end || coalesce(' - ' || p.note, ''), 500),
            p.amount, public._r447_cur(p.org_id, p.quote_id)) returning id into v;
  return v;
end $fn$;
create or replace function public._r450_row(p public.event_vendor_charges)
returns jsonb language sql stable security definer set search_path = '' as $fn$
  -- r261-0450: state 'void' also when its bill was voided on the Vendor bills card
  select jsonb_build_object('id', p.id, 'booking', p.booking_id, 'vendor_id', p.vendor_id, 'vendor', p.vendor_name, 'label', p.label, 'qty', p.qty, 'amount', p.amount, 'note', p.note,
    'state', case when p.state = 'agreed' and not exists (select 1 from public.vendor_bills b where b.id = p.bill_id and b.status <> 'void') then 'void' else p.state end, 'reason', coalesce(p.void_reason, (select b.void_reason from public.vendor_bills b where b.id = p.bill_id and b.status = 'void')),
    'bill_id', p.bill_id, 'paid', case when p.state = 'agreed' then (select coalesce(sum(x.amount), 0) from public.vendor_payouts x where x.bill_id = p.bill_id) end,
    'by', p.by_name, 'at', p.created_at, 'changed_by', p.changed_name, 'changed_at', p.changed_at);
$fn$;

-- ---- 4) what the pages call ----------------------------------------------------------------------------------------------------
create or replace function public.event_vendor_charges_get(p_quote uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $fn$
-- r261-0450: the charges of one event, the newest first; Finance view or Settlement view
declare v_org uuid := public._r396_event(p_quote); v_closed boolean; v_frozen boolean; v_rows jsonb;
begin
  if not coalesce(public.has_area('finance', 'view'), false) and not coalesce(public.has_area('settlement', 'view'), false) then raise exception 'not allowed' using errcode = '42501'; end if;
  v_closed := exists (select 1 from public.event_closure c where c.quote_id = p_quote and c.closed_at is not null);
  v_frozen := exists (select 1 from public.event_money_freezes f where f.quote_id = p_quote and f.frozen);
  select coalesce(jsonb_agg(public._r450_row(x) order by x.seq desc), '[]'::jsonb) into v_rows from public.event_vendor_charges x where x.quote_id = p_quote and x.org_id = v_org;
  return jsonb_build_object('v', 1, 'rows', v_rows, 'closed', v_closed, 'frozen', v_frozen, 'can_edit', not v_closed and not v_frozen and coalesce(public.has_area('finance', 'edit'), false), 'currency', public._r447_cur(v_org, p_quote));
end $fn$;

-- p: { booking, label, qty, amount, note, state: asked | agreed | in_invoice }. p_request = made by the page: the same press twice is one charge.
create or replace function public.event_vendor_charge_add(p_quote uuid, p jsonb, p_request uuid)
returns jsonb language plpgsql volatile security definer set search_path = '' as $fn$
-- r261-0450
declare v_org uuid; k text; r public.event_vendor_charges; b record; v_amt numeric; v_qty numeric; v_state text;
begin
  if jsonb_typeof(p) is distinct from 'object' or p_request is null then raise exception 'invalid' using errcode = '22023'; end if;
  perform public._r396_event(p_quote);
  if not coalesce(public.has_area('finance', 'edit'), false) then raise exception 'not allowed' using errcode = '42501'; end if;
  perform pg_catalog.pg_advisory_xact_lock(hashtextextended('r450:' || p_quote::text, 0));
  select * into r from public.event_vendor_charges x where x.request_id = p_request;
  if r.id is not null then
    if r.org_id is distinct from public.current_org_id() or r.quote_id is distinct from p_quote then raise exception 'not allowed' using errcode = '42501'; end if;
    return jsonb_build_object('ok', true, 'same', true, 'row', public._r450_row(r), 'state', public.event_vendor_charges_get(p_quote));
  end if;
  v_org := public._r450_open(p_quote);
  for k in select jsonb_object_keys(p) loop
    if k not in ('booking', 'label', 'qty', 'amount', 'note', 'state') then raise exception 'unknown field %', k using errcode = '22023'; end if;
  end loop;
  if coalesce(p ->> 'booking', '') !~* '^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$' then raise exception 'invalid' using errcode = '22023'; end if;
  select e.id, e.vendor_id, e.status, left(coalesce(nullif(btrim(v.name), ''), nullif(btrim(e.label), ''), 'Vendor'), 120) as nm into b
    from public.event_resources e left join public.vendors v on v.id = e.vendor_id and v.org_id = v_org where e.id = (p ->> 'booking')::uuid and e.quote_id = p_quote and e.org_id = v_org;
  if b.id is null then raise exception 'This vendor is not on the event any more.' using errcode = 'P0002'; end if;
  if b.status in ('cancelled', 'enquiry') then raise exception 'This vendor is not booked for the event.' using errcode = '22023', hint = 'r450_not_booked'; end if;
  v_state := coalesce(p ->> 'state', '');
  if v_state not in ('asked', 'agreed', 'in_invoice') then raise exception 'invalid state' using errcode = '22023'; end if;
  if jsonb_typeof(p -> 'amount') is distinct from 'number' then raise exception 'Enter the amount they charge (above 0).' using errcode = '22023', hint = 'r450_amount'; end if;
  v_amt := (p ->> 'amount')::numeric;
  if v_amt <= 0 or v_amt > 1000000000 or v_amt <> round(v_amt, 2) then raise exception 'Enter the amount they charge (above 0).' using errcode = '22023', hint = 'r450_amount'; end if;
  if p -> 'qty' is not null and jsonb_typeof(p -> 'qty') <> 'null' then
    if jsonb_typeof(p -> 'qty') <> 'number' then raise exception 'How many? Use a number above 0.' using errcode = '22023', hint = 'r450_qty'; end if;
    v_qty := (p ->> 'qty')::numeric;
    if v_qty <= 0 or v_qty > 1000000 then raise exception 'How many? Use a number above 0.' using errcode = '22023', hint = 'r450_qty'; end if;
  end if;
  if public._r450_text(p ->> 'label', 120) is null then raise exception 'Say what is missing or broken.' using errcode = '22023', hint = 'r450_label'; end if;
  if (select count(*) from public.event_vendor_charges x where x.quote_id = p_quote and x.state <> 'void') >= 100 then raise exception 'Up to 100 charges per event.' using errcode = '22023', hint = 'r450_full'; end if;
  r.id := gen_random_uuid(); r.org_id := v_org; r.quote_id := p_quote; r.booking_id := b.id; r.vendor_id := b.vendor_id; r.vendor_name := b.nm; r.label := public._r450_text(p ->> 'label', 120);
  r.qty := v_qty; r.amount := v_amt; r.state := v_state; r.note := public._r450_text(p ->> 'note', 300);
  if v_state = 'agreed' then r.bill_id := public._r450_bill(r); end if;
  insert into public.event_vendor_charges(id, org_id, quote_id, booking_id, vendor_id, vendor_name, label, qty, amount, state, note, bill_id, by_user, by_name, request_id)
    values (r.id, r.org_id, r.quote_id, r.booking_id, r.vendor_id, r.vendor_name, r.label, r.qty, r.amount, r.state, r.note, r.bill_id, auth.uid(), public._r442_name(), p_request) returning * into r;
  return jsonb_build_object('ok', true, 'row', public._r450_row(r), 'state', public.event_vendor_charges_get(p_quote));
end $fn$;

-- p_from = the state the page showed: somebody else was faster = nothing is changed and the new state is answered
create or replace function public.event_vendor_charge_set(p_id uuid, p_from text, p_to text, p_reason text default null)
returns jsonb language plpgsql volatile security definer set search_path = '' as $fn$
-- r261-0450: asked <-> agreed / in_invoice, and taken back (void, with a reason); a bill with a payment on it is never voided
declare r public.event_vendor_charges; v_org uuid := public.current_org_id(); v_why text; v_now text;
begin
  if auth.uid() is null or v_org is null then raise exception 'not allowed' using errcode = '42501'; end if;
  select * into r from public.event_vendor_charges x where x.id = p_id and x.org_id = v_org;
  if r.id is null then raise exception 'This charge is not there any more.' using errcode = 'P0002'; end if;
  perform public._r450_open(r.quote_id);
  perform pg_catalog.pg_advisory_xact_lock(hashtextextended('r450:' || r.quote_id::text, 0));
  select * into r from public.event_vendor_charges x where x.id = p_id for update;
  v_now := public._r450_row(r) ->> 'state';
  if coalesce(p_to, '') not in ('asked', 'agreed', 'in_invoice', 'void') then raise exception 'invalid state' using errcode = '22023'; end if;
  if v_now is distinct from p_from or v_now = 'void' then return jsonb_build_object('ok', false, 'changed', true, 'state', public.event_vendor_charges_get(r.quote_id)); end if;
  if v_now = p_to then return jsonb_build_object('ok', true, 'same', true, 'state', public.event_vendor_charges_get(r.quote_id)); end if;
  v_why := public._r450_text(p_reason, 300);
  if p_to = 'void' and char_length(coalesce(v_why, '')) < 3 then raise exception 'Say why (at least 3 characters).' using errcode = '22023', hint = 'r450_reason'; end if;
  if v_now = 'agreed' then
    if exists (select 1 from public.vendor_payouts x where x.bill_id = r.bill_id) then
      raise exception 'A payment is recorded on this charge, so it stays. Correct it with the vendor''s next bill.' using errcode = '22023', hint = 'r450_paid'; end if;
    update public.vendor_bills set status = 'void', void_reason = left(coalesce(v_why, case p_to when 'in_invoice' then 'It is in the vendor''s invoice' else 'Not agreed yet' end), 300) where id = r.bill_id and status <> 'void';
  end if;
  if p_to = 'agreed' then r.bill_id := public._r450_bill(r); end if;
  update public.event_vendor_charges set state = p_to, bill_id = r.bill_id, void_reason = case when p_to = 'void' then v_why end, changed_by = auth.uid(), changed_name = public._r442_name(), changed_at = clock_timestamp() where id = r.id;
  return jsonb_build_object('ok', true, 'state', public.event_vendor_charges_get(r.quote_id));
end $fn$;

-- C: a booked vendor who sent no bill: the bill of the agreed price and the payment in one go. p: { amount, paid_on, method, reference }
create or replace function public.vendor_booking_pay(p_booking uuid, p jsonb, p_key text)
returns jsonb language plpgsql volatile security definer set search_path = '' as $fn$
-- r261-0450: Finance edit (checked here and again in vendor_bill_pay, which records the payment). The same key = the same payment.
declare v_org uuid := public.current_org_id(); b public.event_resources; v_key text := nullif(btrim(coalesce(p_key, '')), ''); v_amt numeric; v_due numeric; v_total numeric; v_bill uuid; v_old uuid; v_conv numeric;
begin
  if auth.uid() is null or v_org is null or not coalesce(public.has_area('finance', 'edit'), false) then raise exception 'not allowed' using errcode = '42501'; end if;
  if v_key is null or length(v_key) > 90 then raise exception 'invalid' using errcode = '22023'; end if;
  select * into b from public.event_resources x where x.id = p_booking and x.org_id = v_org;
  if b.id is null then raise exception 'This vendor is not on the event any more.' using errcode = 'P0002'; end if;
  perform pg_catalog.pg_advisory_xact_lock(hashtextextended('r450pay:' || p_booking::text, 0));
  select x.bill_id into v_old from public.vendor_payouts x where x.org_id = v_org and x.idempotency_key = v_key;
  if v_old is not null then
    if not exists (select 1 from public.vendor_bills y where y.id = v_old and y.booking_id = b.id) then raise exception 'idempotency key already used for another bill' using errcode = '22023'; end if;
    return jsonb_build_object('ok', true, 'duplicate', true, 'bill_id', v_old);
  end if;
  perform public._r450_open(b.quote_id);
  if b.status in ('cancelled', 'enquiry') then raise exception 'This vendor is not booked for the event.' using errcode = '22023', hint = 'r450_not_booked'; end if;
  if exists (select 1 from public.vendor_bills y where y.booking_id = b.id and y.org_id = v_org and y.status <> 'void') then
    raise exception 'This vendor has a bill already - pay that bill.' using errcode = '22023', hint = 'r450_billed'; end if;
  if to_regclass('public.vendor_invoices') is not null and exists (select 1 from public.vendor_invoices i join public.vendor_requests r on r.id = i.request_id where r.booking_id = b.id and r.org_id = v_org and i.status in ('submitted', 'queried')) then
    raise exception 'This vendor sent an invoice - review it first, then pay it.' using errcode = '22023', hint = 'r450_invoice'; end if;
  if jsonb_typeof(p -> 'amount') is distinct from 'number' then raise exception 'Enter an amount above zero.' using errcode = '22023', hint = 'r450_amount'; end if;
  v_amt := round((p ->> 'amount')::numeric, 2);
  if v_amt <= 0 or v_amt > 1000000000 then raise exception 'Enter an amount above zero.' using errcode = '22023', hint = 'r450_amount'; end if;
  if p ->> 'paid_on' is not null and p ->> 'paid_on' !~ '^\d{4}-\d{2}-\d{2}$' then raise exception 'Enter the day it was paid.' using errcode = '22023'; end if;
  v_total := coalesce(round(b.cost, 2), 0);
  v_due := greatest(v_total - coalesce(b.advance, 0), 0);
  if v_total > 0 and v_amt > v_due + 0.005 then
    raise exception 'That is more than the % left to pay.', public._r373_money(v_due, public._r447_cur(v_org, b.quote_id)) using errcode = '22023', hint = 'r450_over'; end if;
  insert into public.vendor_bills(org_id, quote_id, booking_id, vendor_id, bill_date, description, amount, currency)
    values (v_org, b.quote_id, b.id, (select x.id from public.vendors x where x.id = b.vendor_id and x.org_id = v_org), public.studio_today(v_org),
            left(coalesce(nullif(btrim(b.label), ''), 'Vendor') || ' - agreed price, no invoice', 500), case when v_total > 0 then v_total else v_amt end, public._r447_cur(v_org, b.quote_id)) returning id into v_bill;
  -- marked settled before without a payment, and not paid in full now: open again, so the rest counts as owed
  if b.settled and v_amt < v_due - 0.005 then update public.event_resources set settled = false, settled_at = null where id = b.id; end if;
  return public.vendor_bill_pay(v_bill, v_amt, 0, null, (p ->> 'paid_on')::date, p ->> 'method', p ->> 'reference', v_key) || jsonb_build_object('bill_id', v_bill);
end $fn$;

-- ---- 5) B: the cost ledger -----------------------------------------------------------------------------------------------------
-- the kept innermost body (0387, _r21_cost_lines__pre0372) leaves the charge bills out of "bills or typed lines, the larger" (exact text edit, twice)
do $$ declare v_def text; v_src text; v_old text := 'vb.quote_id = p_quote and vb.org_id = p_org and vb.status <> ''void'''; v_new text := 'vb.quote_id = p_quote and vb.org_id = p_org and vb.status <> ''void'' and not exists (select 1 from public.event_vendor_charges ec where ec.bill_id = vb.id)';
begin
  v_def := pg_get_functiondef('public._r21_cost_lines__pre0372(uuid,uuid)'::regprocedure);
  if position('event_vendor_charges' in v_def) = 0 then
    if (length(v_def) - length(replace(v_def, v_old, ''))) / length(v_old) <> 2 then
      raise exception 'STOP 0450: the cost ledger has an unexpected body - nothing was changed'; end if;
    execute replace(v_def, v_old, v_new);
  end if;
  -- the ledger every page reads is wrapped once more (0372, 0373, 0374 and maybe 0424 did the same)
  select p.prosrc into v_src from pg_proc p where p.oid = to_regprocedure('public._r21_cost_lines(uuid,uuid)');
  if position('r261-0450' in coalesce(v_src, '')) = 0 and to_regprocedure('public._r21_cost_lines__pre0450(uuid,uuid)') is null then
    alter function public._r21_cost_lines(uuid, uuid) rename to _r21_cost_lines__pre0450;
  end if;
  if to_regprocedure('public._r21_cost_lines__pre0450(uuid,uuid)') is null then raise exception 'STOP 0450: the cost ledger could not be kept'; end if;
end $$;

create or replace function public._r21_cost_lines(p_quote uuid, p_org uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $fn$
-- r261-0450: wraps the kept ledger (_r21_cost_lines__pre0450 = the r191-inventory-0374 wrapper (and the multi-day one of 0424 where it is) over r190-0373 / r189-money-0372 and the
-- r21-money-0246 / r22-money-0252 / r23-crew-0265 body, crew settings through public._r25_crew_cfg( since 0371), unchanged, + what vendors charge for
-- missing / broken items, each once. An event without such a charge = the kept answer byte for byte.
declare v jsonb := public._r21_cost_lines__pre0450(p_quote, p_org); v_part jsonb; v_ev date; v_tz text;
begin
  if v is null or jsonb_typeof(v) <> 'array' or not exists (select 1 from public.event_vendor_charges c where c.quote_id = p_quote and c.org_id = p_org and c.state in ('asked', 'agreed')) then return v; end if;
  if coalesce((public._r372_cfg(p_org) ->> 'unplanned_tag')::boolean, true) then select q.event_date into v_ev from public.quotes q where q.id = p_quote; end if;
  v_tz := public._r372_tz(p_org);
  select coalesce(jsonb_agg(x.j || case when v_ev is not null and (x.at at time zone v_tz)::date >= v_ev then jsonb_build_object('unplanned', true, 'added_on', (x.at at time zone v_tz)::date) else '{}'::jsonb end order by x.seq), '[]'::jsonb) into v_part from (
    select c.seq, c.created_at as at, jsonb_build_object('key', 'bill:' || vb.id, 'source', 'bill', 'source_id', vb.id, 'category', 'damages', 'label', left('Vendor damage: ' || c.label || ' (' || c.vendor_name || ')', 200),
        'estimated', null, 'committed', null, 'actual', y.cost, 'c_est', 0, 'c_com', 0, 'c_fc', y.cost, 'c_act', y.cost,
        'paid', (select coalesce(sum(p.amount), 0) from public.vendor_payouts p where p.bill_id = vb.id), 'input_tax', y.itc, 'blocked_gst', 0, 'bills', 1, 'vendor_charge', true,
        'note', 'charged by the vendor for missing or broken items') as j
      from public.event_vendor_charges c join public.vendor_bills vb on vb.id = c.bill_id and vb.org_id = p_org and vb.quote_id = p_quote and vb.status <> 'void'
      cross join lateral (select case when vb.gst_amount is not null and coalesce(vb.gst_claimable, false) then vb.gst_amount else 0 end as itc) g0
      cross join lateral (select vb.amount - g0.itc as cost, g0.itc as itc) y
     where c.quote_id = p_quote and c.org_id = p_org and c.state = 'agreed'
    union all
    select c.seq, c.created_at, jsonb_build_object('key', 'charge:' || c.id, 'source', 'vendor_line', 'source_id', c.id, 'category', 'damages', 'label', left('Vendor damage: ' || c.label || ' (' || c.vendor_name || ')', 200),
        'estimated', null, 'committed', c.amount, 'actual', null, 'c_est', 0, 'c_com', c.amount, 'c_fc', c.amount, 'c_act', 0, 'paid', null, 'crew_covered', false, 'staff_like', false, 'vendor_charge', true,
        'note', 'asked by the vendor for missing or broken items - not agreed yet') as j
      from public.event_vendor_charges c where c.quote_id = p_quote and c.org_id = p_org and c.state = 'asked') x;
  return v || v_part;
end $fn$;

-- ---- 6) grants -----------------------------------------------------------------------------------------------------------------
do $$ declare f text; r text; begin
  foreach f in array array['public._r450_text(text,integer)', 'public._r450_open(uuid)', 'public._r450_bill(public.event_vendor_charges)', 'public._r450_row(public.event_vendor_charges)', 'public._r21_cost_lines__pre0450(uuid,uuid)', 'public._r21_cost_lines(uuid,uuid)',
      'public.event_vendor_charges_get(uuid)', 'public.event_vendor_charge_add(uuid,jsonb,uuid)', 'public.event_vendor_charge_set(uuid,text,text,text)', 'public.vendor_booking_pay(uuid,jsonb,text)'] loop
    execute format('revoke all on function %s from public', f);
    foreach r in array array['anon', 'authenticated'] loop
      if exists (select 1 from pg_roles where rolname = r) then execute format('revoke all on function %s from %I', f, r); end if;
    end loop;
  end loop;
  if exists (select 1 from pg_roles where rolname = 'service_role') then grant execute on function public._r21_cost_lines(uuid, uuid) to service_role; end if;   -- as before
  foreach f in array array['public.event_vendor_charges_get(uuid)', 'public.event_vendor_charge_add(uuid,jsonb,uuid)', 'public.event_vendor_charge_set(uuid,text,text,text)', 'public.vendor_booking_pay(uuid,jsonb,text)'] loop
    foreach r in array array['authenticated', 'service_role'] loop
      if exists (select 1 from pg_roles where rolname = r) then execute format('grant execute on function %s to %I', f, r); end if;
    end loop;
  end loop;
end $$;

do $$ begin
  if to_regclass('public.helm_schema_markers') is not null then
    insert into public.helm_schema_markers(num, name) values (450, '0450_r261_vendor_money') on conflict (num) do nothing;
  end if;
end $$;

notify pgrst, 'reload schema';

-- ---- 7) CHECK (read only): every row must say true -------------------------------------------------------------------------------
select c.check, c.ok from (values
  ('01 the charges table is there, row security on, no direct access', (select bool_and(c.relrowsecurity and not has_table_privilege('authenticated', c.oid, 'select,insert,update,delete') and not has_table_privilege('anon', c.oid, 'select,insert,update,delete')) from pg_class c where c.oid = 'public.event_vendor_charges'::regclass)),
  ('02 a charge always belongs to its event''s studio, a read-only studio writes nothing', (to_regprocedure('public.tg_quote_org_match()') is null or exists (select 1 from pg_trigger where tgname = 'zz_quote_org_match' and tgrelid = 'public.event_vendor_charges'::regclass))
      and (to_regprocedure('public.tg_studio_read_only()') is null or exists (select 1 from pg_trigger where tgname = 'zzz_studio_read_only' and tgrelid = 'public.event_vendor_charges'::regclass))),
  ('03 signed-in people only', (select bool_and(has_function_privilege('authenticated', f, 'execute') and not has_function_privilege('anon', f, 'execute')) from unnest(array['public.event_vendor_charges_get(uuid)', 'public.event_vendor_charge_add(uuid,jsonb,uuid)', 'public.event_vendor_charge_set(uuid,text,text,text)', 'public.vendor_booking_pay(uuid,jsonb,text)']) f)),
  ('04 helpers and the ledger are server only', (select bool_and(not has_function_privilege('authenticated', f, 'execute') and not has_function_privilege('anon', f, 'execute')) from unnest(array['public._r450_text(text,integer)', 'public._r450_open(uuid)', 'public._r450_bill(public.event_vendor_charges)', 'public._r450_row(public.event_vendor_charges)', 'public._r21_cost_lines__pre0450(uuid,uuid)', 'public._r21_cost_lines(uuid,uuid)']) f)),
  ('05 search_path pinned on all ten', (select count(*) = 10 and bool_and(coalesce(p.proconfig @> array['search_path=""'], false)) from pg_proc p where p.pronamespace = 'public'::regnamespace
      and (p.proname like '\_r450\_%' or p.proname in ('event_vendor_charges_get', 'event_vendor_charge_add', 'event_vendor_charge_set', 'vendor_booking_pay', '_r21_cost_lines__pre0450', '_r21_cost_lines')))),
  ('06 the ledger counts each charge once', position('r261-0450' in pg_get_functiondef('public._r21_cost_lines(uuid,uuid)'::regprocedure)) > 0
      and (length(pg_get_functiondef('public._r21_cost_lines__pre0372(uuid,uuid)'::regprocedure)) - length(replace(pg_get_functiondef('public._r21_cost_lines__pre0372(uuid,uuid)'::regprocedure), 'event_vendor_charges', ''))) / length('event_vendor_charges') = 2),
  ('07 the reason for closing without a payment has its column', exists (select 1 from pg_attribute a where a.attrelid = 'public.event_resources'::regclass and a.attname = 'settled_reason' and not a.attisdropped)),
  ('08 the free-trial clean-up knows the table', to_regprocedure('public._tr184_purge_tables()') is null or position('event_vendor_charges' in pg_get_functiondef('public._tr184_purge_tables()'::regprocedure)) > 0)
) c("check", ok);
