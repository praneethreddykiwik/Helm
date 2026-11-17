-- 0377_r198_event_money_cash.sql - R198 "P&L clarity" phase 2 (owner, 17 Nov 2026: "continue with phase 2";
-- PNL-CLARITY-PLAN.md phase 2 + mockups/pnl "Cash in & out" and "Who owes what"). Forward-only, additive, safe to run twice.
-- ASCII only.
-- REQUIRES 0376 (event_money_header: the same access rule, the same frozen / live choice), 0372 (_r372_tds, _r372_tz,
--          _r372_current_snapshot, client_tds, frozen P&L), 0373 (_r373_open, vendor_payouts.source), 0246 (_r21_event_money /
--          _vb_event_pnl: the event cost ledger), 0110 (helm_invoice_total, helm_total_paid), 0264 (payment_milestones),
--          0287 (studio_today).
--
-- In plain words:
--   1  CASH IN & OUT. event_money_cash(quote) returns one dated list of the real money of an event: money IN (client payments
--      received, the payment plan's instalments still to come - never more than the balance - and recoveries from the client)
--      and money OUT (vendor payouts made, vendor bills still open with their due dates, crew wages to pay, staff expense
--      claims paid / to pay back, refunds to the client), past and coming. Client TDS is listed but is not cash. The four
--      totals (came in, went out, still to come in, still to pay out), a running "cash left" per date, and the plain
--      "cash left is not profit" explanation with the exact numbers: GST collected (owed to the government) minus GST on
--      vendor bills you can claim back, client TDS (kept by the client for the tax office), stock lost (a cost, no cash),
--      TDS you deducted from vendors (owed to the tax office), and whatever has no money record yet - so cash left = profit +
--      those parts, to the rupee.
--   2  WHO OWES WHAT. The same call also returns: the client's balance with the next instalment and an overdue flag (and the
--      words for a WhatsApp reminder), each vendor bill still unpaid or part paid with its due date (due date first), crew
--      wages to pay (ONE total for Finance roles; per person for the studio admin only, as 0372), staff pay-backs (expense
--      claims approved / waiting), refunds owed to the client, GST to pay for this event and TDS deducted from vendors.
--      It only READS. Nothing is stored or changed. The page links each row to where you act (Settlement).
--   Crew wages: Helm records no wage payments, so the whole wage bill of the event (the ledger's own crew lines; the frozen
--   lines once the event is closed + frozen) shows as "to pay" on the event day.
-- ACCESS: as event_money_header (0376): a signed-in studio member with Finance view; a client account, anon and crew / vendor
--   links are refused (42501); an event of another studio, a deleted or an unknown one answers null (no error).
-- ZERO DATA LOSS: one new read-only function plus one server-only helper. No table, column, row, policy or trigger is
--   created, dropped or changed.
-- ROLLBACK (manual, only if ever needed; no data involved): drop function public.event_money_cash(uuid);
--   drop function public._r377_d(timestamptz, text).

-- ---- 0) preflight -------------------------------------------------------------------------------------------------------------
do $$ begin
  if to_regprocedure('public.event_money_header(uuid)') is null then raise exception 'STOP 0377: apply 0376 (event money header) first'; end if;
  if to_regprocedure('public._r372_tds(uuid)') is null or to_regprocedure('public._r372_tz(uuid)') is null
     or to_regprocedure('public._r372_current_snapshot(uuid)') is null or to_regclass('public.client_tds') is null then
    raise exception 'STOP 0377: apply 0372 (money lock) first'; end if;
  if to_regprocedure('public._r373_open(uuid)') is null or to_regclass('public.vendor_payouts') is null
     or not exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'vendor_payouts' and column_name = 'source') then
    raise exception 'STOP 0377: apply 0373 (vendor bills) first'; end if;
  if to_regprocedure('public._r21_event_money(uuid,uuid,boolean)') is null or to_regprocedure('public._vb_event_pnl(uuid,uuid)') is null then
    raise exception 'STOP 0377: apply 0246 (the event cost ledger) first'; end if;
  if to_regprocedure('public.helm_invoice_total(uuid)') is null or to_regprocedure('public.helm_total_paid(uuid,uuid,uuid)') is null then
    raise exception 'STOP 0377: helm_invoice_total / helm_total_paid missing (apply 0110 first)'; end if;
  if to_regprocedure('public.studio_today(uuid,timestamp with time zone)') is null then raise exception 'STOP 0377: apply 0287 first'; end if;
  if to_regclass('public.payment_milestones') is null or to_regclass('public.quote_payments') is null or to_regclass('public.expense_claims') is null
     or to_regclass('public.event_refunds') is null or to_regclass('public.vendor_bills') is null or to_regclass('public.event_closure') is null then
    raise exception 'STOP 0377: payment_milestones / quote_payments / expense_claims / event_refunds / vendor_bills / event_closure missing'; end if;
end $$;

-- ---- 1) a moment as a date in the studio's time zone (server only) -----------------------------------------------------------
create or replace function public._r377_d(p_at timestamptz, p_tz text)
returns date language sql stable set search_path = '' as $$
  -- r198-0377
  select (coalesce(p_at, now()) at time zone coalesce(nullif(p_tz, ''), 'Asia/Kolkata'))::date;
$$;

-- ---- 2) cash in & out + who owes what of one event (read-only) ---------------------------------------------------------------
create or replace function public.event_money_cash(p_quote uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
-- r198-0377: read-only. Finance view, own studio; null for an event that is not in the caller's studio (or deleted / unknown).
-- Every number is worked out here; the page only shows it. Per-person crew pay only for the studio admin.
declare
  v_org uuid := public.current_org_id(); v_admin boolean; q record; v_tz text; v_today date; v_closed timestamptz;
  v_pnl jsonb; v_money jsonb; s public.event_pnl_snapshots; v_frozen boolean := false; v_studio text;
  v_quoted numeric; v_paid numeric; v_tds numeric; v_bal numeric; v_left numeric; v_amt numeric; v_d date;
  v_e jsonb := '[]'::jsonb; r record; n int := 0;
  v_in numeric := 0; v_out numeric := 0; v_tin numeric := 0; v_tout numeric := 0;
  v_crew numeric := 0; v_crew_n int := 0; v_people jsonb := '[]'::jsonb;
  v_bills jsonb := '[]'::jsonb; v_bills_total numeric := 0; v_claims jsonb := '[]'::jsonb; v_cl_ok numeric := 0; v_cl_wait numeric := 0;
  v_refs jsonb := '[]'::jsonb; v_ref_due numeric := 0; v_vtds numeric := 0;
  v_next jsonb; v_overdue numeric := 0; v_late boolean := false;
  v_tax numeric; v_rtax numeric; v_itc numeric; v_blocked numeric; v_gst_net numeric; v_lost numeric; v_profit numeric;
  v_cash_left numeric; v_other numeric; v_points jsonb; v_event_d date;
begin
  if auth.uid() is null or v_org is null or coalesce(public.user_role(), '') = 'client' or not public.has_area('finance', 'view') then
    raise exception 'not authorized' using errcode = '42501'; end if;
  select x.id, x.code, x.title, x.event_date, x.status, coalesce(nullif(upper(btrim(x.currency)), ''), 'INR') as cur,
         case when (x.pricing ->> 'total') ~ '^\s*-?[0-9]+(\.[0-9]+)?\s*$' then (x.pricing ->> 'total')::numeric else 0 end as base,
         nullif(left(btrim(coalesce(x.client ->> 'name', '')), 120), '') as client_name
    into q from public.quotes x where x.id = p_quote and x.org_id = v_org and x.deleted_at is null;
  if not found then return null; end if;
  v_admin := public.is_admin();
  v_tz := public._r372_tz(v_org);
  v_today := public.studio_today(v_org);
  v_event_d := coalesce(q.event_date, v_today);
  select c.closed_at into v_closed from public.event_closure c where c.quote_id = p_quote;
  select nullif(left(btrim(coalesce(o.name, '')), 120), '') into v_studio from public.organizations o where o.id = v_org;

  -- profit + GST: the frozen figure for a closed + frozen event, else live (0372 _vb_event_pnl decides; same as 0376)
  v_pnl := public._vb_event_pnl(p_quote, v_org);
  if v_pnl is null then return null; end if;
  if jsonb_typeof(v_pnl -> 'frozen') = 'object' then
    v_frozen := true;
    s := public._r372_current_snapshot(p_quote);
    if s.id is not null and s.org_id = v_org and s.money <> '{}'::jsonb then v_money := s.money; end if;
  end if;
  if v_money is null then v_money := coalesce(public._r21_event_money(p_quote, v_org, true), '{}'::jsonb); end if;
  v_profit := coalesce((v_pnl ->> 'net_profit')::numeric, 0);

  -- the client bill (as 0376): quote + approved changes, what came in, client TDS (counts as settled)
  v_quoted := case when q.base > 0 then coalesce(public.helm_invoice_total(p_quote), 0) else 0 end;
  v_paid := coalesce(public.helm_total_paid(p_quote, null, null), 0);
  v_tds := coalesce(public._r372_tds(p_quote), 0);
  v_bal := greatest(v_quoted - v_paid - v_tds, 0); if v_bal <= 0.5 then v_bal := 0; end if;

  -- ---- money IN ----
  -- client payments received (the same rows helm_total_paid adds up)
  for r in select p.id, p.amount, public._r377_d(coalesce(p.paid_at, p.created_at), v_tz) as d,
                  coalesce(nullif(btrim(p.method), ''), nullif(btrim(p.provider), ''), '') as how, nullif(btrim(coalesce(p.receipt_no, '')), '') as rno
             from public.quote_payments p
            where p.quote_id = p_quote and p.status = 'paid' and coalesce(p.amount, 0) <> 0
            order by 3, p.created_at limit 300 loop
    v_e := v_e || jsonb_build_array(jsonb_build_object('kind', 'payment', 'dir', 'in', 'cash', true, 'done', true, 'date', r.d,
      'who', 'Payment from ' || coalesce(q.client_name, 'the client'), 'how', r.how, 'ref', r.rno, 'amount', r.amount, 'act', 'payments'));
    v_in := v_in + r.amount;
  end loop;
  -- client TDS: settled, but not cash (the client paid it to the tax office for you)
  if abs(v_tds) > 0.005 then
    select public._r377_d(max(t.created_at), v_tz) into v_d from public.client_tds t where t.quote_id = p_quote;
    v_e := v_e || jsonb_build_array(jsonb_build_object('kind', 'client_tds', 'dir', 'in', 'cash', false, 'done', true, 'date', v_d,
      'who', 'TDS kept by the client', 'how', 'Not cash: claim it in your tax return (Form 16A)', 'amount', v_tds, 'act', 'tds'));
  end if;
  -- instalments still to come: the open payment plan, never more than the balance; the rest of the balance on the event day
  v_left := v_bal;
  for r in select pm.id, pm.label, pm.amount, pm.due_date, pm.status from public.payment_milestones pm
            where pm.quote_id = p_quote and pm.org_id = v_org and pm.status in ('due', 'invoiced') and coalesce(pm.amount, 0) > 0
            order by pm.due_date nulls last, pm.seq, pm.created_at limit 100 loop
    exit when v_left <= 0.5;
    v_amt := least(r.amount, v_left); v_left := v_left - v_amt;
    v_d := coalesce(r.due_date, v_event_d);
    v_e := v_e || jsonb_build_array(jsonb_build_object('kind', 'instalment', 'dir', 'in', 'cash', true, 'done', false, 'date', v_d,
      'who', coalesce(nullif(left(btrim(r.label), 120), ''), 'Instalment'), 'how', case when r.status = 'invoiced' then 'Invoiced' else 'Payment plan' end,
      'amount', v_amt, 'late', v_d < v_today, 'no_date', r.due_date is null, 'act', 'payments'));
    v_tin := v_tin + v_amt;
    if v_next is null then
      v_next := jsonb_build_object('label', coalesce(nullif(left(btrim(r.label), 120), ''), 'Instalment'), 'amount', v_amt, 'date', r.due_date,
                                   'days', r.due_date - v_today, 'late', r.due_date is not null and r.due_date < v_today);
    end if;
    if v_d < v_today then v_overdue := v_overdue + v_amt; end if;
  end loop;
  if v_left > 0.5 then
    v_d := greatest(v_event_d, v_today);
    v_e := v_e || jsonb_build_array(jsonb_build_object('kind', 'balance', 'dir', 'in', 'cash', true, 'done', false, 'date', v_d,
      'who', 'Balance from ' || coalesce(q.client_name, 'the client'), 'how', 'Not in the payment plan', 'amount', v_left,
      'late', q.event_date is not null and q.event_date < v_today, 'no_date', true, 'act', 'payments'));
    v_tin := v_tin + v_left;
    if v_next is null then
      v_next := jsonb_build_object('label', 'Balance', 'amount', v_left, 'date', q.event_date, 'days', q.event_date - v_today,
                                   'late', q.event_date is not null and q.event_date < v_today);
    end if;
    if q.event_date is not null and q.event_date < v_today then v_overdue := v_overdue + v_left; end if;
  end if;
  v_late := v_overdue > 0.5;

  -- refunds to the client (out) and recoveries from the client (in); deductions from a deposit move no cash
  for r in select f.id, f.kind, f.amount, f.status, nullif(left(btrim(coalesce(f.reason, '')), 120), '') as reason,
                  public._r377_d(f.created_at, v_tz) as d
             from public.event_refunds f
            where f.quote_id = p_quote and f.org_id = v_org and f.kind in ('refund', 'recovery') and f.status <> 'rejected'
              and coalesce(f.amount, 0) > 0
            order by f.created_at limit 100 loop
    v_e := v_e || jsonb_build_array(jsonb_build_object('kind', r.kind, 'dir', case when r.kind = 'refund' then 'out' else 'in' end,
      'cash', true, 'done', r.status = 'processed', 'date', case when r.status = 'processed' then r.d else v_today end,
      'who', case when r.kind = 'refund' then 'Refund to ' else 'Recovery from ' end || coalesce(q.client_name, 'the client'),
      'how', coalesce(r.reason, '') || case when r.status = 'processed' then '' when r.status = 'approved' then ' (approved)' else ' (waiting approval)' end,
      'amount', r.amount, 'act', 'refunds'));
    if r.kind = 'refund' then
      if r.status = 'processed' then v_out := v_out + r.amount;
      else v_tout := v_tout + r.amount; v_ref_due := v_ref_due + r.amount;
        v_refs := v_refs || jsonb_build_array(jsonb_build_object('id', r.id, 'reason', r.reason, 'amount', r.amount, 'status', r.status)); end if;
    else
      if r.status = 'processed' then v_in := v_in + r.amount; else v_tin := v_tin + r.amount; end if;
    end if;
  end loop;

  -- ---- money OUT ----
  -- vendor payouts made (a TDS row is tax you deducted: not paid to the vendor, you owe it to the government)
  for r in select vp.id, vp.amount, vp.paid_on, vp.method, coalesce(vp.source, '') as src, b.bill_no,
                  coalesce(nullif(btrim(vv.name), ''), nullif(btrim(er.label), ''), nullif(btrim(b.description), ''), 'Vendor') as who
             from public.vendor_payouts vp
             join public.vendor_bills b on b.id = vp.bill_id and b.org_id = v_org and b.quote_id = p_quote
             left join public.vendors vv on vv.id = b.vendor_id and vv.org_id = v_org
             left join public.event_resources er on er.id = b.booking_id and er.org_id = v_org
            where vp.org_id = v_org and coalesce(vp.amount, 0) <> 0
            order by vp.paid_on nulls last, vp.created_at limit 500 loop
    if r.src = 'tds' then v_vtds := v_vtds + r.amount; continue; end if;
    v_e := v_e || jsonb_build_array(jsonb_build_object('kind', 'payout', 'dir', 'out', 'cash', true, 'done', true,
      'date', coalesce(r.paid_on, v_today), 'who', left(r.who, 120),
      'how', case when r.src = 'advance' then 'Advance' else coalesce(nullif(btrim(r.method), ''), 'Paid') end
             || case when r.bill_no is not null and btrim(r.bill_no) <> '' then ' - bill ' || left(btrim(r.bill_no), 40) else '' end,
      'amount', r.amount, 'act', 'bills'));
    v_out := v_out + r.amount;
  end loop;
  -- vendor bills still open (0373: what is left after payouts), due date first
  for r in select b.id, b.bill_no, b.amount, b.due_date, b.gst_amount, b.gst_claimable, o.open,
                  coalesce(nullif(btrim(vv.name), ''), nullif(btrim(er.label), ''), nullif(btrim(b.description), ''), 'Vendor') as who,
                  nullif(left(btrim(coalesce(b.description, '')), 120), '') as what
             from public.vendor_bills b
             left join public.vendors vv on vv.id = b.vendor_id and vv.org_id = v_org
             left join public.event_resources er on er.id = b.booking_id and er.org_id = v_org
             cross join lateral (select public._r373_open(b.id) as open) o
            where b.quote_id = p_quote and b.org_id = v_org and b.status = 'open' and o.open > 0.005
            order by b.due_date nulls last, b.bill_date nulls last, b.created_at limit 200 loop
    v_d := coalesce(r.due_date, v_today);
    v_e := v_e || jsonb_build_array(jsonb_build_object('kind', 'bill', 'dir', 'out', 'cash', true, 'done', false, 'date', v_d,
      'who', left(r.who, 120), 'how', case when r.due_date is null then 'Bill, no due date' else 'Bill due' end
             || case when r.bill_no is not null and btrim(r.bill_no) <> '' then ' - ' || left(btrim(r.bill_no), 40) else '' end,
      'amount', r.open, 'late', r.due_date is not null and r.due_date < v_today, 'no_date', r.due_date is null, 'act', 'bills'));
    v_tout := v_tout + r.open; v_bills_total := v_bills_total + r.open;
    v_bills := v_bills || jsonb_build_array(jsonb_build_object('id', r.id, 'who', left(r.who, 120), 'what', r.what,
      'bill_no', nullif(left(btrim(coalesce(r.bill_no, '')), 40), ''), 'amount', r.amount, 'paid', r.amount - r.open, 'open', r.open,
      'part', r.amount - r.open > 0.005, 'due_date', r.due_date, 'days', r.due_date - v_today,
      'late', r.due_date is not null and r.due_date < v_today,
      'gst', case when coalesce(r.gst_amount, 0) > 0 then case when coalesce(r.gst_claimable, false) then 'claimable' else 'not_claimable' end else 'none' end));
  end loop;
  -- crew wages: the ledger's own crew lines (frozen lines once closed + frozen); Helm records no wage payments
  select coalesce(sum(coalesce((l ->> 'c_fc')::numeric, 0)), 0), count(*) filter (where coalesce((l ->> 'c_fc')::numeric, 0) > 0.005)
    into v_crew, v_crew_n
    from jsonb_array_elements(coalesce(v_money -> 'lines', '[]'::jsonb)) l where l ->> 'source' = 'crew';
  if v_admin then
    select coalesce(jsonb_agg(jsonb_build_object('name', coalesce(nullif(left(btrim(l ->> 'label'), 120), ''), 'Crew'),
             'amount', coalesce((l ->> 'c_fc')::numeric, 0),
             'stage', case when l ->> 'actual' is not null then 'actual' else 'expected' end,
             'note', nullif(left(btrim(coalesce(l ->> 'note', '')), 160), ''))
             order by coalesce((l ->> 'c_fc')::numeric, 0) desc, l ->> 'label'), '[]'::jsonb)
      into v_people from jsonb_array_elements(coalesce(v_money -> 'lines', '[]'::jsonb)) l
     where l ->> 'source' = 'crew' and coalesce((l ->> 'c_fc')::numeric, 0) > 0.005;
  end if;
  if v_crew > 0.005 then
    v_e := v_e || jsonb_build_array(jsonb_build_object('kind', 'wages', 'dir', 'out', 'cash', true, 'done', false, 'date', v_event_d,
      'who', 'Crew wages (' || v_crew_n || case when v_crew_n = 1 then ' person)' else ' people)' end,
      'how', 'On the event day - Helm does not record wage payments', 'amount', v_crew, 'late', false, 'act', 'crew'));
    v_tout := v_tout + v_crew;
  end if;
  -- staff expense claims: paid = out (on the day it was added), approved = to pay back, pending = waiting approval
  for r in select x.id, x.amount, x.status, nullif(left(btrim(coalesce(x.who, '')), 120), '') as who,
                  nullif(left(btrim(coalesce(x.description, '')), 160), '') as what, public._r377_d(x.created_at, v_tz) as d
             from public.expense_claims x
            where x.quote_id = p_quote and x.org_id = v_org and x.status in ('pending', 'approved', 'paid') and coalesce(x.amount, 0) > 0
            order by x.created_at limit 300 loop
    v_e := v_e || jsonb_build_array(jsonb_build_object('kind', 'claim', 'dir', 'out', 'cash', true, 'done', r.status = 'paid',
      'date', case when r.status = 'paid' then r.d else v_today end,
      'who', 'Pay-back: ' || coalesce(r.who, 'staff'), 'how', coalesce(r.what, 'Expense claim')
             || case r.status when 'paid' then '' when 'approved' then ' - approved' else ' - waiting approval' end,
      'amount', r.amount, 'act', 'claims'));
    if r.status = 'paid' then v_out := v_out + r.amount;
    else
      v_tout := v_tout + r.amount;
      if r.status = 'approved' then v_cl_ok := v_cl_ok + r.amount; else v_cl_wait := v_cl_wait + r.amount; end if;
      v_claims := v_claims || jsonb_build_array(jsonb_build_object('id', r.id, 'who', coalesce(r.who, 'Staff'), 'what', r.what,
        'amount', r.amount, 'status', r.status, 'date', r.d));
    end if;
  end loop;

  -- ---- running "cash left" per date (cash rows only; a TDS row is not cash) ----
  select coalesce(jsonb_agg(jsonb_build_object('date', t.d, 'in', t.i, 'out', t.o, 'in_due', t.i_due, 'out_due', t.o_due,
           'done', t.i_due = 0 and t.o_due = 0, 'run', t.run) order by t.d), '[]'::jsonb)
    into v_points
    from (select g.d, g.i, g.o, g.i_due, g.o_due, sum(g.i - g.o) over (order by g.d) as run
            from (select (e ->> 'date')::date as d,
                         coalesce(sum((e ->> 'amount')::numeric) filter (where e ->> 'dir' = 'in'), 0) as i,
                         coalesce(sum((e ->> 'amount')::numeric) filter (where e ->> 'dir' = 'out'), 0) as o,
                         coalesce(sum((e ->> 'amount')::numeric) filter (where e ->> 'dir' = 'in' and not (e ->> 'done')::boolean), 0) as i_due,
                         coalesce(sum((e ->> 'amount')::numeric) filter (where e ->> 'dir' = 'out' and not (e ->> 'done')::boolean), 0) as o_due
                    from jsonb_array_elements(v_e) e where (e ->> 'cash')::boolean group by 1) g) t;

  -- ---- why cash left is not the profit (exact: the parts add up to the cash left) ----
  v_tax := coalesce((v_pnl ->> 'tax')::numeric, 0); v_rtax := coalesce((v_pnl ->> 'refunds_tax')::numeric, 0);
  v_itc := coalesce((v_pnl ->> 'input_tax')::numeric, (v_money ->> 'input_tax')::numeric, 0);
  v_blocked := coalesce((v_pnl ->> 'blocked_gst')::numeric, (v_money ->> 'blocked_gst')::numeric, 0);
  v_gst_net := v_tax - v_rtax - v_itc;
  select coalesce(sum(coalesce((c ->> 'expected')::numeric, 0)), 0) into v_lost
    from jsonb_array_elements(coalesce(v_money -> 'by_category', '[]'::jsonb)) c where c ->> 'key' = 'damages';
  v_cash_left := v_in + v_tin - v_out - v_tout;
  v_other := v_cash_left - v_profit - v_gst_net - v_lost + v_tds - v_vtds;

  select coalesce(jsonb_agg(e order by (e ->> 'date')::date, case e ->> 'dir' when 'in' then 0 else 1 end), '[]'::jsonb) into v_e
    from jsonb_array_elements(v_e) e;

  return jsonb_build_object(
    'quote_id', q.id, 'code', q.code, 'title', q.title, 'event_date', q.event_date, 'status', q.status, 'currency', q.cur,
    'today', v_today, 'days_to_event', q.event_date - v_today, 'closed', v_closed is not null, 'frozen', v_frozen,
    'entries', v_e, 'points', v_points,
    'totals', jsonb_build_object('came_in', v_in, 'went_out', v_out, 'to_come', v_tin, 'to_pay', v_tout,
                                 'cash_now', v_in - v_out, 'cash_left', v_cash_left),
    'explain', jsonb_build_object('cash_left', v_cash_left, 'profit', v_profit,
      'gst_collected', v_tax - v_rtax, 'gst_claimable', v_itc, 'gst_to_pay', v_gst_net, 'gst_blocked', v_blocked,
      'client_tds', v_tds, 'vendor_tds', v_vtds, 'stock_lost', v_lost, 'other', v_other,
      'advance', case when v_closed is null and (q.event_date is null or q.event_date >= v_today) then v_in else 0 end),
    'owes', jsonb_build_object(
      'client', jsonb_build_object('name', q.client_name, 'quoted', v_quoted, 'received', v_paid, 'tds', v_tds, 'balance', v_bal,
        'next', v_next, 'overdue', v_late, 'overdue_amount', v_overdue, 'event_title', q.title, 'event_date', q.event_date,
        'studio', v_studio),
      'vendors', jsonb_build_object('total', v_bills_total, 'count', jsonb_array_length(v_bills), 'bills', v_bills),
      'crew', jsonb_build_object('total', v_crew, 'people', v_crew_n, 'private', not v_admin,
        'per_person', case when v_admin then v_people end, 'date', q.event_date, 'paid_tracked', false),
      'claims', jsonb_build_object('approved', v_cl_ok, 'waiting', v_cl_wait, 'items', v_claims),
      'refunds', jsonb_build_object('total', v_ref_due, 'items', v_refs),
      'gst', jsonb_build_object('collected', v_tax - v_rtax, 'claimable', v_itc, 'to_pay', greatest(v_gst_net, 0),
        'credit', greatest(-v_gst_net, 0), 'blocked', v_blocked, 'vendor_tds', v_vtds),
      'you_owe', v_bills_total + v_crew + v_cl_ok + v_cl_wait + v_ref_due),
    'pay_private', not v_admin);
end $$;

-- ---- 3) grants: the page call for signed-in staff (it checks its area); the helper for the server only ------------------------
do $$
declare f text;
begin
  foreach f in array array['public._r377_d(timestamptz,text)'] loop
    execute format('revoke all on function %s from public', f);
    if exists (select 1 from pg_roles where rolname = 'anon') then execute format('revoke all on function %s from anon', f); end if;
    if exists (select 1 from pg_roles where rolname = 'authenticated') then execute format('revoke all on function %s from authenticated', f); end if;
    if exists (select 1 from pg_roles where rolname = 'service_role') then execute format('grant execute on function %s to service_role', f); end if;
  end loop;
  foreach f in array array['public.event_money_cash(uuid)'] loop
    execute format('revoke all on function %s from public', f);
    if exists (select 1 from pg_roles where rolname = 'anon') then execute format('revoke all on function %s from anon', f); end if;
    if exists (select 1 from pg_roles where rolname = 'authenticated') then execute format('grant execute on function %s to authenticated', f); end if;
    if exists (select 1 from pg_roles where rolname = 'service_role') then execute format('grant execute on function %s to service_role', f); end if;
  end loop;
end $$;

notify pgrst, 'reload schema';
