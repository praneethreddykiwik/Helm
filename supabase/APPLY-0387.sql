-- APPLY-0387 (R212 event money reads fast: the money header, the cash view and the Business page answer about twice as fast).
-- Run on STAGING first, then production. Safe to run twice. Needs 0372, 0373, 0374, 0376 and 0377 first.
-- What it does: the event money header and the cash view built the whole cost ledger of an event twice per call; now once.
-- Inside the ledger, the "which category is this line" helper ran once per place its answer is used; now once per line.
-- Every money answer stays exactly the same (the old bodies are kept as __pre0387). Functions only: no table, row, policy
-- or index is created, changed or deleted, and nothing is written.
-- Paste the whole file into the Supabase SQL editor and press Run. The last result lists checks - every ok must be true.
-- Check 07 compares new and old answers on your 10 most recently changed events (read-only; a few seconds).
begin;
-- 0387_r212_money_speed.sql - R212 event money reads fast (prod pg_stat_statements 18 Nov 2026: event_money_header /
-- event_money_cash / business_pnl calls averaging up to 1 s, slowest 6.3 s; event_money_header answered 500 after the 8 s
-- statement timeout at 09:46). Forward-only, additive, safe to run twice. ASCII only. Every money answer stays the same.
-- REQUIRES 0372 (money lock: _vb_event_pnl, _r21_event_money, _r372_cfg, _r372_current_snapshot), 0373 + 0374 (the ledger
--          wrappers over _r21_cost_lines__pre0372), 0376 (event_money_header), 0377 (event_money_cash).
--
-- In plain words - why it was slow:
--   1  THE COST LEDGER WAS WORKED OUT TWICE PER CALL. event_money_header and event_money_cash first asked _vb_event_pnl for
--      the profit (which builds the whole cost ledger - every booking, bill, cost line, crew wage, claim, change and
--      write-off of the event - once), then asked _r21_event_money for the same ledger again with its lines. Each call
--      built the ledger twice and read the 0146 P&L body three times.
--   2  ONE SMALL HELPER RAN MORE OFTEN THAN NEEDED. Inside the ledger, the "which category is this line" helper
--      (_r21_category: a list of word patterns) was evaluated once per place its answer is used (up to five times per
--      cost line) because the database folds the sub-queries together. On a 50-item event it ran about 75 times per ledger
--      instead of about 30, and it was a third of all the time spent.
--   The Business page (business_pnl) builds the ledger once per event, so it gets the second fix.
-- What 0387 does:
--   A  the kept ledger body _r21_cost_lines__pre0372 is re-issued with five "offset 0" fences, so each row's category is
--      worked out once. Same rows, same order, same numbers (old body kept as _r21_cost_lines__pre0372__pre0387).
--   B  NEW server-only _r387_event_pnl(quote, studio, ledger): exactly the _vb_event_pnl answer (0372 frozen figure for a
--      closed + frozen event, else the live r21 numbers over the 0146 body) for a caller that already holds the ledger.
--   C  event_money_header and event_money_cash are re-issued: the ledger once, the profit from it (old bodies kept as
--      __pre0387, server only). Same inputs, same answers, same access checks, same grants.
--   No index is added: every table the ledger reads is already indexed on its event (quote_id / booking_id / bill_id).
-- ACCESS: unchanged. event_money_header / event_money_cash: signed-in studio staff with Finance view (checked inside, as
--   before); the kept bodies and _r387_event_pnl are for the server only. Definer + empty search_path everywhere.
-- ZERO DATA LOSS: functions only. No table, column, row, policy, trigger or index is created, changed or dropped. Nothing
--   is written by any of these calls.
-- ROLLBACK (manual, only if ever needed; no data involved):
--   drop function public.event_money_header(uuid); alter function public.event_money_header__pre0387(uuid) rename to event_money_header;
--   drop function public.event_money_cash(uuid); alter function public.event_money_cash__pre0387(uuid) rename to event_money_cash;
--   grant execute on both to authenticated;
--   drop function public._r21_cost_lines__pre0372(uuid, uuid);
--   alter function public._r21_cost_lines__pre0372__pre0387(uuid, uuid) rename to _r21_cost_lines__pre0372;
--   drop function public._r387_event_pnl(uuid, uuid, jsonb).

-- ---- 0) preflight -------------------------------------------------------------------------------------------------------------
do $$ begin
  if to_regprocedure('public._vb_event_pnl__pre0372(uuid,uuid)') is null or to_regprocedure('public._vb_event_pnl__pre0246(uuid,uuid)') is null
     or to_regprocedure('public._r21_event_money(uuid,uuid,boolean)') is null or to_regprocedure('public._r372_current_snapshot(uuid)') is null
     or to_regprocedure('public._r372_cfg(uuid)') is null then
    raise exception 'STOP 0387: apply 0372 (money lock) first'; end if;
  if to_regprocedure('public._r21_cost_lines__pre0373(uuid,uuid)') is null or to_regprocedure('public._r21_cost_lines__pre0374(uuid,uuid)') is null then
    raise exception 'STOP 0387: apply 0373 and 0374 first'; end if;
  if to_regprocedure('public._r21_cost_lines__pre0372(uuid,uuid)') is null and to_regprocedure('public._r21_cost_lines__pre0372__pre0387(uuid,uuid)') is null then
    raise exception 'STOP 0387: the kept ledger body _r21_cost_lines__pre0372 is missing (apply 0372 first)'; end if;
  if to_regprocedure('public.event_money_header(uuid)') is null and to_regprocedure('public.event_money_header__pre0387(uuid)') is null then
    raise exception 'STOP 0387: apply 0376 (event_money_header) first'; end if;
  if to_regprocedure('public.event_money_cash(uuid)') is null and to_regprocedure('public.event_money_cash__pre0387(uuid)') is null then
    raise exception 'STOP 0387: apply 0377 (event_money_cash) first'; end if;
end $$;

-- ---- 1) keep the old bodies once -------------------------------------------------------------------------------------------------
do $$ begin
  if to_regprocedure('public._r21_cost_lines__pre0372__pre0387(uuid,uuid)') is null then
    alter function public._r21_cost_lines__pre0372(uuid, uuid) rename to _r21_cost_lines__pre0372__pre0387;
  end if;
  if to_regprocedure('public.event_money_header__pre0387(uuid)') is null then
    alter function public.event_money_header(uuid) rename to event_money_header__pre0387;
  end if;
  if to_regprocedure('public.event_money_cash__pre0387(uuid)') is null then
    alter function public.event_money_cash(uuid) rename to event_money_cash__pre0387;
  end if;
end $$;

-- ---- 2) the kept ledger body, fenced (answer unchanged) ------------------------------------------------------------------------
create or replace function public._r21_cost_lines__pre0372(p_quote uuid, p_org uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
-- r212-0387: the same ledger as before (byte-identical answer); five 'offset 0' fences so each row's category
-- (public._r21_category) is worked out once per row instead of once per place it is used. Nothing else changed.
-- r21-money-0246 (r22-money-0252: a task naming a crew member counts while unassigned - estimated wage)
-- r23-crew-0265: crew wages use the crew link's check-in / check-out times, shift wages and hourly pay (section D)
declare
  v_lines jsonb := '[]'::jsonb; v_part jsonb;
  v_lb numeric; v_llf numeric; v_bills_win boolean; v_has_crew boolean;
  v_cfg jsonb := public._r25_crew_cfg(p_org); v_basis text; v_day_h numeric;
begin
  v_basis := coalesce(v_cfg ->> 'payBasis', 'day'); if v_basis = 'hours' then v_basis := 'hours'; else v_basis := 'day'; end if;
  v_day_h := coalesce((v_cfg ->> 'dayHours')::numeric, 8); if v_day_h <= 0 then v_day_h := 8; end if;
  if not exists (select 1 from public.quotes q where q.id = p_quote and q.org_id = p_org) then return null; end if;

  -- crew on this event: assigned by a live task, or on the arrival roster (a crew member of this studio)
  v_has_crew := exists (select 1 from public.event_tasks t join public.crew_members cm on cm.id = t.crew_id and cm.org_id = p_org
                         where t.quote_id = p_quote and t.org_id = p_org and t.status not in ('rejected', 'cancelled'))
             or exists (select 1 from public.event_day d join public.crew_members cm on cm.id = d.ref_id and cm.org_id = p_org
                         where d.quote_id = p_quote and d.org_id = p_org and d.kind = 'arrival');

  -- A) active vendor bookings: one line each (bills, else a typed actual on its cost line(s), else committed / estimate)
  select coalesce(jsonb_agg(jsonb_build_object(
      'key', 'booking:' || x.id, 'source', 'booking', 'source_id', x.id, 'category', x.cat, 'label', x.label,
      'estimated', x.est, 'committed', x.com, 'actual', x.act,
      'c_est', x.est, 'c_com', coalesce(x.com, 0), 'c_fc', coalesce(x.act, x.com, x.est), 'c_act', coalesce(x.act, 0),
      'paid', x.paid, 'gst_status', x.gst_status, 'input_tax', x.itc, 'blocked_gst', x.blocked,
      'bills', x.nbills, 'note', x.note) order by x.cat, x.label), '[]'::jsonb)
    into v_part
  from (
    select b.id, coalesce(nullif(btrim(b.label), ''), 'Vendor booking') as label, y.cat,
           case when coalesce(l.est, 0) > 0 then l.est else coalesce(b.cost, l.est, 0) end as est,
           case when b.status in ('booked', 'confirmed', 'delivered') or b.contract
                then coalesce(b.cost, case when coalesce(l.est, 0) > 0 then l.est end) end as com,
           case when bl.n > 0 then bl.cost when l.n > 0 and l.n_act = l.n then l.act end as act,
           coalesce(bl.paid, 0) + coalesce(b.advance, 0) as paid,
           case when bl.n > 0 then case when bl.n_unknown > 0 then 'unknown' else 'split' end end as gst_status,
           coalesce(bl.itc, 0) as itc, coalesce(bl.blocked, 0) as blocked, coalesce(bl.n, 0) as nbills,
           case when bl.n > 0 then 'actual from ' || bl.n || ' vendor bill(s)'
                when l.n > 0 and l.n_act = l.n then 'actual typed on the budget line'
                when b.status in ('booked', 'confirmed', 'delivered') or b.contract then 'booked - no bill yet'
                else 'enquiry - estimate only' end as note
      from public.event_resources b
      left join public.vendors v on v.id = b.vendor_id and v.org_id = p_org
      left join lateral (
        select count(*) as n, count(k.actual) as n_act, sum(k.estimated) as est, sum(k.actual) as act,
               string_agg(coalesce(k.requirement_key, '') || ' ' || coalesce(k.category, '') || ' ' || coalesce(k.description, ''), ' ') as words
          from public.event_costs k where k.booking_id = b.id and k.org_id = p_org and k.quote_id = p_quote) l on true
      left join lateral (
        select count(*) as n, count(*) filter (where vb.gst_amount is null) as n_unknown,
               sum(vb.amount - case when vb.gst_amount is not null and z.claim then vb.gst_amount else 0 end) as cost,
               sum(case when vb.gst_amount is not null and z.claim then vb.gst_amount else 0 end) as itc,
               sum(case when vb.gst_amount is not null and not z.claim then vb.gst_amount else 0 end) as blocked,
               sum((select coalesce(sum(p.amount), 0) from public.vendor_payouts p where p.bill_id = vb.id)) as paid
          from public.vendor_bills vb
          cross join lateral (select coalesce(vb.gst_claimable,
                      public._r21_category(coalesce(l.words, '') || ' ' || coalesce(b.kind, '') || ' ' || coalesce(b.label, '') || ' ' || coalesce(v.category, ''), 'vendors') <> 'food') as claim offset 0) z
         where vb.booking_id = b.id and vb.org_id = p_org and vb.status <> 'void') bl on true
      cross join lateral (select public._r21_category(
                  case when l.words ~ '(^| )std:' then substring(l.words from 'std:[a-z]+')
                       else coalesce(l.words, '') || ' ' || coalesce(b.kind, '') || ' ' || coalesce(b.label, '') || ' ' || coalesce(v.category, '') end,
                  'vendors') as cat offset 0) y
     where b.quote_id = p_quote and b.org_id = p_org and b.status <> 'cancelled') x;
  v_lines := v_lines || v_part;

  -- B) vendor spend NOT tied to an active booking has ONE source (0146 rule): the unlinked bills or the
  --    unlinked "vendor" cost lines, whichever is larger - never both. The other side shows, counted 0.
  v_lb := coalesce((select sum(vb.amount - case when vb.gst_amount is not null and coalesce(vb.gst_claimable,
                         public._r21_category(coalesce(v.category, '') || ' ' || coalesce(v.name, '') || ' ' || coalesce(vb.description, ''), 'vendors') <> 'food')
                       then vb.gst_amount else 0 end)
       from public.vendor_bills vb left join public.vendors v on v.id = vb.vendor_id and v.org_id = p_org
      where vb.quote_id = p_quote and vb.org_id = p_org and vb.status <> 'void'
        and not exists (select 1 from public.event_resources b where b.id = vb.booking_id and b.status <> 'cancelled')), 0);
  v_llf := coalesce((select sum(coalesce(k.actual, k.estimated)) from public.event_costs k
      where k.quote_id = p_quote and k.org_id = p_org and k.kind = 'vendor' and not (k.crew_covered and v_has_crew)
        and not exists (select 1 from public.event_resources b where b.id = k.booking_id and b.status <> 'cancelled')), 0);
  v_bills_win := v_lb > 0 and v_lb >= v_llf;

  select coalesce(jsonb_agg(jsonb_build_object(
      'key', 'bill:' || x.id, 'source', 'bill', 'source_id', x.id, 'category', x.cat,
      'label', x.label, 'estimated', null, 'committed', null, 'actual', x.cost,
      'c_est', 0, 'c_com', 0, 'c_fc', case when v_bills_win then x.cost else 0 end, 'c_act', case when v_bills_win then x.cost else 0 end,
      'paid', x.paid, 'gst_status', case when x.gst_amount is null then 'unknown' else 'split' end,
      'input_tax', case when v_bills_win and x.gst_amount is not null and x.claim then x.gst_amount else 0 end,
      'blocked_gst', case when v_bills_win and x.gst_amount is not null and not x.claim then x.gst_amount else 0 end,
      'bills', 1,
      'note', case when v_bills_win then 'vendor bill not linked to a booking' else 'not counted: the vendor cost lines for this spend are larger' end)
      order by x.bill_date, x.id), '[]'::jsonb)
    into v_part
  from (
    select vb.id, vb.bill_date, vb.gst_amount, z.cat, z.claim,
           coalesce(nullif(btrim(coalesce(v.name, '') || case when vb.bill_no is not null then ' #' || vb.bill_no else '' end), ''), 'Vendor bill') as label,
           vb.amount - case when vb.gst_amount is not null and z.claim then vb.gst_amount else 0 end as cost,
           (select coalesce(sum(p.amount), 0) from public.vendor_payouts p where p.bill_id = vb.id) as paid
      from public.vendor_bills vb
      left join public.vendors v on v.id = vb.vendor_id and v.org_id = p_org
      cross join lateral (select public._r21_category(coalesce(v.category, '') || ' ' || coalesce(v.name, '') || ' ' || coalesce(vb.description, ''), 'vendors') as cat offset 0) c0
      cross join lateral (select c0.cat as cat, coalesce(vb.gst_claimable, c0.cat <> 'food') as claim offset 0) z
     where vb.quote_id = p_quote and vb.org_id = p_org and vb.status <> 'void'
       and not exists (select 1 from public.event_resources b where b.id = vb.booking_id and b.status <> 'cancelled')) x;
  v_lines := v_lines || v_part;

  -- C) budget lines not tied to an active booking (vendor lines follow rule B; contingency is plan-only;
  --    a line ticked "replaced by crew wages" counts 0 while the event has crew)
  select coalesce(jsonb_agg(jsonb_build_object(
      'key', 'cost:' || x.id, 'source', case when x.kind = 'vendor' then 'vendor_line' else 'cost_line' end, 'source_id', x.id,
      'category', x.cat, 'label', x.label, 'estimated', x.estimated, 'committed', null, 'actual', x.actual,
      'c_est', case when x.replaced then 0 else x.estimated end, 'c_com', 0,
      'c_fc', case when x.replaced or (x.kind = 'vendor' and v_bills_win) then 0
                   when x.cat = 'contingency' then coalesce(x.actual, 0) else coalesce(x.actual, x.estimated) end,
      'c_act', case when x.replaced or (x.kind = 'vendor' and v_bills_win) then 0 else coalesce(x.actual, 0) end,
      'paid', null, 'crew_covered', x.crew_covered, 'staff_like', x.cat = 'staff',
      'note', case when x.replaced then 'replaced by the crew wage lines'
                   when x.kind = 'vendor' and v_bills_win then 'in the plan only: the unlinked vendor bills count instead'
                   when x.cat = 'contingency' then 'buffer - counts in the plan only'
                   when x.actual is not null then 'actual typed on the budget line'
                   else 'estimate only - no actual yet' end)
      order by x.created_at, x.id), '[]'::jsonb)
    into v_part
  from (
    select k.id, k.kind, k.estimated, k.actual, k.created_at, k.crew_covered,
           coalesce(nullif(btrim(k.description), ''), 'Cost line') as label,
           (k.crew_covered and v_has_crew) as replaced,
           public._r21_category(case when k.requirement_key ~ '^std:' then k.requirement_key
                                     else coalesce(k.category, '') || ' ' || coalesce(k.description, '') end,
                                case when k.kind = 'vendor' then 'vendors' else 'misc' end) as cat
      from public.event_costs k
     where k.quote_id = p_quote and k.org_id = p_org
       and not exists (select 1 from public.event_resources b where b.id = k.booking_id and b.status <> 'cancelled') offset 0) x;
  v_lines := v_lines || v_part;

  -- D) crew wages: one line per person.
  --    r23-crew-0265: Actual comes from the crew link's own check-in / check-out (crew_checkins) when there is one:
  --    day rate x days checked in, or hours worked x hourly rate when the studio pays by the hour (Control Center ->
  --    Crew: pay basis; hourly rate = day rate / day hours) or the open shift they claimed was posted per hour.
  --    A wage posted on an open shift replaces the day rate for that event. No check-in -> the event-day arrival
  --    roster as before ('arrived' or 'left' = 1 day, no-show = 0).
  select coalesce(jsonb_agg(jsonb_build_object(
      'key', 'crew:' || y.id, 'source', 'crew', 'source_id', y.id, 'crew_id', y.id, 'category', 'staff',
      'label', y.name, 'day_rate', y.rate, 'rate_missing', y.rate_missing,
      'estimated', y.est, 'committed', case when y.accepted then y.est end,
      'actual', y.act,
      'c_est', y.est, 'c_com', case when y.accepted then y.est else 0 end,
      'c_fc', case when y.act is not null then y.act when y.no_show then 0 else y.est end,
      'c_act', coalesce(y.act, 0),
      'attendance', case when y.arrived then 'arrived' when y.no_show then 'no_show' else 'not_marked' end,
      'pay_basis', y.basis, 'hours', y.hours, 'days', y.days, 'checked_in', y.days > 0,
      'shift_wage', y.shift_wage, 'paid', null,
      'note', case when y.rate_missing then 'day rate missing - set it on the Staff page'
                   when y.days > 0 and y.basis = 'hours' and y.open_n > 0 and coalesce(y.hours, 0) = 0
                     then 'checked in on the crew link - not checked out yet (planned hours until then)'
                   when y.days > 0 and y.basis = 'hours'
                     then 'checked in / out on the crew link: ' || to_char(coalesce(y.hours, 0), 'FM9990.0') || ' h'
                          || case when y.open_n > 0 then ' so far (still checked in)' else '' end
                   when y.days > 0 then 'checked in on the crew link (' || y.days || ' day' || case when y.days = 1 then '' else 's' end || ')'
                   when y.arrived then 'arrived on the event day (1 day)'
                   when y.no_show then 'no-show on the event day (no wage)'
                   when y.accepted then 'accepted - attendance not marked yet'
                   else 'assigned - not accepted yet' end)
      order by y.name, y.id), '[]'::jsonb)
    into v_part
  from (
    select x.*,
           (coalesce(x.rate, 0) = 0 and x.shift_wage is null) as rate_missing,
           x.days > 0 or x.roster_in as arrived,
           not (x.days > 0 or x.roster_in) and x.roster_no as no_show,
           case when x.basis = 'hours' then round(coalesce(x.hourly, 0) * coalesce(x.planned_h, v_day_h), 2)
                else coalesce(x.rate, 0) end as est,
           case when x.days > 0 then
                  case when x.basis = 'hours' then
                         case when x.open_n > 0 and coalesce(x.hours, 0) = 0 then null
                              else round(coalesce(x.hourly, 0) * coalesce(x.hours, 0), 2) end
                       else coalesce(x.rate, 0) * x.days end
                when x.roster_in then
                  case when x.basis = 'hours' then round(coalesce(x.hourly, 0) * coalesce(x.planned_h, v_day_h), 2)
                       else coalesce(x.rate, 0) end
                when x.roster_no then 0 end as act
      from (
        select cm.id, coalesce(nullif(btrim(cm.name), ''), 'Crew member') as name,
               coalesce(case when sw.basis = 'day' then sw.wage end, cm.day_rate) as rate,
               case when sw.basis = 'hour' then sw.wage
                    when coalesce(cm.day_rate, 0) > 0 then round(cm.day_rate / v_day_h, 2) end as hourly,
               case when sw.basis = 'hour' then 'hours' when sw.basis = 'day' then 'day' else v_basis end as basis,
               sw.wage as shift_wage, sw.planned_h,
               coalesce(ci.days, 0) as days, round(ci.hours, 2) as hours, coalesce(ci.open_n, 0) as open_n,
               exists (select 1 from public.event_tasks t where t.quote_id = p_quote and t.org_id = p_org and t.crew_id = cm.id
                         and (t.status in ('accepted', 'in_progress', 'completed') or (t.responded_at is not null and t.status not in ('rejected', 'cancelled')))) as accepted,
               exists (select 1 from public.event_day d where d.quote_id = p_quote and d.org_id = p_org and d.kind = 'arrival'
                         and d.ref_id = cm.id and d.status in ('arrived', 'left')) as roster_in,
               exists (select 1 from public.event_day d where d.quote_id = p_quote and d.org_id = p_org and d.kind = 'arrival'
                         and d.ref_id = cm.id and d.status = 'no_show') as roster_no
          from public.crew_members cm
          left join lateral (
            select s.wage, s.wage_basis as basis,
                   case when s.start_time is not null and s.end_time is not null
                        then round((extract(epoch from (s.end_time - s.start_time)) / 3600.0
                                    + case when s.end_time <= s.start_time then 24 else 0 end)::numeric, 2) end as planned_h
              from public.open_shift_claims c join public.open_shifts s on s.id = c.shift_id and s.org_id = p_org
             where c.quote_id = p_quote and c.org_id = p_org and c.crew_id = cm.id and c.status = 'approved' and s.wage is not null
             order by c.decided_at desc nulls last, c.id limit 1) sw on true
          left join lateral (
            select count(distinct k.work_day) filter (where k.check_in_at is not null) as days,
                   sum(extract(epoch from (k.check_out_at - k.check_in_at)) / 3600.0) filter (where k.check_out_at is not null) as hours,
                   count(*) filter (where k.check_in_at is not null and k.check_out_at is null) as open_n
              from public.crew_checkins k where k.quote_id = p_quote and k.org_id = p_org and k.crew_id = cm.id) ci on true
         where cm.org_id = p_org
           and (exists (select 1 from public.event_tasks t where t.quote_id = p_quote and t.org_id = p_org and t.crew_id = cm.id
                          and t.status not in ('rejected', 'cancelled'))
             or exists (select 1 from public.event_day d where d.quote_id = p_quote and d.org_id = p_org and d.kind = 'arrival' and d.ref_id = cm.id))) x) y;
  v_lines := v_lines || v_part;

  -- E) expense claims (staff out-of-pocket): waiting = committed, approved / paid = actual, rejected = not a cost
  select coalesce(jsonb_agg(jsonb_build_object(
      'key', 'claim:' || e.id, 'source', 'claim', 'source_id', e.id, 'category', 'misc',
      'label', 'Expense: ' || left(coalesce(nullif(btrim(e.who), ''), 'staff') || coalesce(' - ' || nullif(btrim(e.description), ''), ''), 160),
      'estimated', null, 'committed', case when e.status = 'pending' then e.amount end,
      'actual', case when e.status in ('approved', 'paid') then e.amount end,
      'c_est', 0, 'c_com', case when e.status = 'pending' then e.amount else 0 end,
      'c_fc', e.amount, 'c_act', case when e.status in ('approved', 'paid') then e.amount else 0 end,
      'paid', case when e.status = 'paid' then e.amount else 0 end, 'status', e.status,
      'note', case e.status when 'pending' then 'claim waiting for approval' when 'approved' then 'approved - not paid yet' else 'paid' end)
      order by e.created_at, e.id), '[]'::jsonb)
    into v_part
  from public.expense_claims e
  where e.quote_id = p_quote and e.org_id = p_org and e.status <> 'rejected';
  v_lines := v_lines || v_part;

  -- F) approved change orders: their extra cost is agreed (committed); the real spend arrives as a bill / line
  select coalesce(jsonb_agg(jsonb_build_object(
      'key', 'change:' || c.id, 'source', 'change', 'source_id', c.id, 'category', 'changes',
      'label', 'Change: ' || left(coalesce(nullif(btrim(c.title), ''), 'change order'), 160),
      'estimated', c.cost_delta, 'committed', c.cost_delta, 'actual', null,
      'c_est', c.cost_delta, 'c_com', c.cost_delta, 'c_fc', c.cost_delta, 'c_act', 0, 'paid', null,
      'note', 'approved change order - extra cost agreed')
      order by c.created_at, c.id), '[]'::jsonb)
    into v_part
  from public.change_requests c
  where c.quote_id = p_quote and c.org_id = p_org and c.status = 'approved' and c.cost_delta <> 0;
  v_lines := v_lines || v_part;

  -- G) our own equipment written off at check-in: written off x the item's cost (absorbed by the event)
  select coalesce(jsonb_agg(jsonb_build_object(
      'key', 'writeoff:' || x.id, 'source', 'writeoff', 'source_id', x.id, 'category', 'damages',
      'label', x.name || ' x' || trim(to_char(x.written_off, 'FM999999990.##')),
      'estimated', null, 'committed', null, 'actual', x.cost,
      'c_est', 0, 'c_com', 0, 'c_fc', x.cost, 'c_act', x.cost, 'paid', null, 'cost_missing', x.unit_cost = 0,
      'note', case when x.unit_cost = 0 then 'written off - item cost missing (set it in Inventory)' else 'written off at check-in' end)
      order by x.name, x.id), '[]'::jsonb)
    into v_part
  from (
    select ch.id, ch.written_off, coalesce(i.unit_cost, 0) as unit_cost,
           coalesce(nullif(btrim(i.name), ''), 'Item') as name, round(ch.written_off * coalesce(i.unit_cost, 0), 2) as cost
      from public.inventory_checkouts ch join public.inventory_items i on i.id = ch.item_id and i.org_id = p_org
     where ch.quote_id = p_quote and ch.org_id = p_org and ch.written_off > 0 and ch.status <> 'cancelled') x;
  v_lines := v_lines || v_part;

  return v_lines;
end $$;

-- ---- 3) the profit from a ledger the caller already holds ---------------------------------------------------------------------
-- Exactly the _vb_event_pnl answer: the r21-money-0246 step (_vb_event_pnl__pre0372: the 0146 body + the r21 ledger numbers)
-- then the r189-money-0372 step (_vb_event_pnl: the frozen figure for a closed + frozen event). p_money must be
-- _r21_event_money(p_quote, p_org, true); its "without lines" answer (what _vb_event_pnl__pre0372 asks for) is p_money - 'lines'.
create or replace function public._r387_event_pnl(p_quote uuid, p_org uuid, p_money jsonb)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
-- r212-0387: _vb_event_pnl (r189-money-0372 over r21-money-0246) composed from the caller's ledger, not worked out again
declare v_old jsonb; m jsonb; v_cats jsonb; v jsonb; s public.event_pnl_snapshots;
begin
  -- the r21-money-0246 step (_vb_event_pnl__pre0372); legacy events keep the 0146 numbers
  v_old := public._vb_event_pnl__pre0246(p_quote, p_org);
  if v_old is null then return null; end if;
  m := p_money - 'lines';
  if m is null then
    v := v_old;
  else
    select coalesce(jsonb_object_agg(c ->> 'key', (c ->> 'expected')::numeric), '{}'::jsonb) into v_cats
      from jsonb_array_elements(m -> 'by_category') c;
    if m ->> 'rules' = 'legacy' then
      v := v_old || jsonb_build_object('rules', 'legacy', 'closed_at', m -> 'closed_at',
        'r21', jsonb_build_object('net_profit', m -> 'margin_expected', 'margin_pct', m -> 'margin_expected_pct',
          'cost_estimated', m -> 'cost_estimated', 'cost_actual', m -> 'cost_actual', 'cost_expected', m -> 'cost_expected',
          'accuracy_pct', m -> 'accuracy_pct', 'wages', m -> 'cost_wages'));
    else
      v := v_old || jsonb_build_object(
        'rules', 'r21',
        'vendors', m -> 'cost_vendors', 'other', m -> 'cost_other',
        'staff', ((m ->> 'cost_wages')::numeric + (m ->> 'cost_claims')::numeric),
        'wages', m -> 'cost_wages', 'expenses', m -> 'cost_claims',
        'refunds', m -> 'refunds_ex_tax', 'refunds_tax', m -> 'refunds_tax',
        'net_profit', m -> 'margin_expected',
        'margin_pct', case when (m ->> 'revenue')::numeric <> 0 then round((m ->> 'margin_expected')::numeric / (m ->> 'revenue')::numeric * 100) end,
        'net_revenue', m -> 'net_revenue',
        'cost_estimated', m -> 'cost_estimated', 'cost_committed', m -> 'cost_committed',
        'cost_expected', m -> 'cost_expected', 'cost_actual', m -> 'cost_actual',
        'margin_estimated', m -> 'margin_estimated', 'margin_expected', m -> 'margin_expected', 'margin_actual', m -> 'margin_actual',
        'gross_margin', m -> 'gross_margin', 'net_margin', m -> 'net_margin', 'net_margin_pct', m -> 'net_margin_pct',
        'accuracy_pct', m -> 'accuracy_pct', 'input_tax', m -> 'input_tax', 'blocked_gst', m -> 'blocked_gst',
        'by_category', v_cats,
        'legacy_net_profit', v_old -> 'net_profit');
    end if;
  end if;
  -- the r189-money-0372 step (_vb_event_pnl): a closed + frozen event answers its frozen figure
  if not coalesce((public._r372_cfg(p_org) ->> 'freeze_closed')::boolean, true) then return v; end if;
  s := public._r372_current_snapshot(p_quote);
  if s.id is null or s.org_id <> p_org then return v; end if;
  return s.pnl || jsonb_build_object('bills_paid', v -> 'bills_paid', 'bills_due', v -> 'bills_due',
    'frozen', jsonb_build_object('version', s.version, 'at', s.created_at, 'reason', s.reason, 'by', s.signed_email),
    'live_net_profit', v -> 'net_profit');
end $$;

-- ---- 4) the money header: the ledger once ------------------------------------------------------------------------------------
create or replace function public.event_money_header(p_quote uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
-- r212-0387: same answer as the r197-0376 body (kept as event_money_header__pre0387); the ledger is worked out once, not twice.
-- r197-0376: read-only. Finance view, own studio; null for an event that is not in the caller's studio (or deleted).
-- Composes _vb_event_pnl (frozen figure when closed + frozen, 0372), the frozen snapshot or the live ledger (_r21_event_money),
-- the vendor bills (0373) and the client payments. Every number is worked out here; the page only shows it.
declare
  v_org uuid := public.current_org_id(); v_admin boolean; q record; v_pnl jsonb; v_money jsonb; s public.event_pnl_snapshots;
  v_cfg jsonb; v_band numeric; v_target numeric; v_target_set boolean; v_today date; v_closed timestamptz; v_frozen jsonb;
  v_rev numeric; v_profit numeric; v_margin numeric; v_plan_profit numeric; v_plan_margin numeric; v_light text; v_rules text;
  v_quoted numeric; v_paid numeric; v_tds numeric; v_bal numeric; v_cats jsonb; v_reasons jsonb; v_cost numeric; v_plan numeric;
  v_items jsonb := '[]'::jsonb; v_attn jsonb; v_live numeric; v_drift boolean := false; rb record; rm record; n_open integer; v_open numeric;
  n_over integer; v_top jsonb; v_unp numeric; v_dmg numeric; v_warn jsonb; v_live_m jsonb;
begin
  if auth.uid() is null or v_org is null or coalesce(public.user_role(), '') = 'client' or not public.has_area('finance', 'view') then
    raise exception 'not authorized' using errcode = '42501'; end if;
  select x.id, x.code, x.title, x.event_date, x.status, coalesce(nullif(upper(btrim(x.currency)), ''), 'INR') as cur,
         case when (x.pricing ->> 'total') ~ '^\s*-?[0-9]+(\.[0-9]+)?\s*$' then (x.pricing ->> 'total')::numeric else 0 end as base
    into q from public.quotes x where x.id = p_quote and x.org_id = v_org and x.deleted_at is null;
  if not found then return null; end if;
  v_admin := public.is_admin();
  v_cfg := public._r372_cfg(v_org);
  select coalesce(ms.margin_band, 5) into v_band from (select 1) one left join public.money_settings ms on ms.org_id = v_org;
  v_target := public._r376_target(v_org); v_target_set := v_target is not null; v_target := coalesce(v_target, 25);
  v_today := public.studio_today(v_org);
  select c.closed_at into v_closed from public.event_closure c where c.quote_id = p_quote;

  -- profit: the frozen figure for a closed + frozen event, else live (0372 _vb_event_pnl decides)
  -- r212-0387: the live ledger is worked out ONCE (with its lines); the profit is composed from it by _r387_event_pnl, which
  -- answers exactly what _vb_event_pnl answers (0372 frozen figure for a closed + frozen event, else live). Was: twice per call.
  v_live_m := public._r21_event_money(p_quote, v_org, true);
  v_pnl := public._r387_event_pnl(p_quote, v_org, v_live_m);
  if v_pnl is null then return null; end if;
  if jsonb_typeof(v_pnl -> 'frozen') = 'object' then
    v_frozen := v_pnl -> 'frozen';
    s := public._r372_current_snapshot(p_quote);
    if s.id is not null and s.org_id = v_org and s.money <> '{}'::jsonb then v_money := s.money; end if;
    v_live := (v_pnl ->> 'live_net_profit')::numeric;
  end if;
  if v_money is null then v_money := coalesce(v_live_m, '{}'::jsonb); end if;
  v_rules := coalesce(v_pnl ->> 'rules', v_money ->> 'rules', 'r21');
  v_rev := coalesce((v_pnl ->> 'revenue')::numeric, 0);
  v_profit := coalesce((v_pnl ->> 'net_profit')::numeric, 0);
  v_plan := coalesce((v_money ->> 'cost_estimated')::numeric, 0);
  v_cost := case when v_rules = 'legacy' then v_rev - v_profit else coalesce((v_money ->> 'cost_expected')::numeric, 0) end;
  v_drift := v_frozen is not null and v_live is not null and abs(v_live - v_profit) > 0.5;
  v_margin := case when v_rev > 0 then round(v_profit / v_rev * 100, 1) end;
  v_plan_profit := coalesce((v_money ->> 'margin_estimated')::numeric, v_rev - v_plan);
  v_plan_margin := case when v_rev > 0 then round(v_plan_profit / v_rev * 100, 1) end;
  v_light := case when v_rev <= 0 then 'none' when v_profit < 0 then 'bad' when v_margin >= v_target then 'good'
                  when v_margin >= v_target - v_band then 'warn' else 'bad' end;

  -- cash: the client bill (quote + approved changes), what came in, client TDS (counts as settled, 0372)
  v_quoted := case when q.base > 0 then coalesce(public.helm_invoice_total(p_quote), 0) else 0 end;
  v_paid := coalesce(public.helm_total_paid(p_quote, null, null), 0);
  v_tds := coalesce(public._r372_tds(p_quote), 0);
  v_bal := greatest(v_quoted - v_paid - v_tds, 0); if v_bal <= 0.5 then v_bal := 0; end if;

  -- plan vs expected / actual per category (the studio's big-gap flag; a frozen snapshot keeps the flag it had)
  select coalesce(jsonb_agg(jsonb_build_object('key', c ->> 'key', 'label', coalesce(c ->> 'label', c ->> 'key'),
           'plan', coalesce((c ->> 'estimated')::numeric, 0), 'expected', coalesce((c ->> 'expected')::numeric, 0),
           'actual', coalesce((c ->> 'actual')::numeric, 0),
           'diff', coalesce((c ->> 'expected')::numeric, 0) - coalesce((c ->> 'estimated')::numeric, 0),
           'diff_pct', case when coalesce((c ->> 'estimated')::numeric, 0) > 0
                            then round((coalesce((c ->> 'expected')::numeric, 0) - (c ->> 'estimated')::numeric) / (c ->> 'estimated')::numeric * 100) end,
           'flag', case when c ->> 'key' = 'contingency' then ''
                        else coalesce(c ->> 'flag', public._r372_flag((c ->> 'estimated')::numeric,
                               coalesce((c ->> 'expected')::numeric, 0) - coalesce((c ->> 'estimated')::numeric, 0), v_cfg)) end,
           'unplanned', coalesce((c ->> 'unplanned')::numeric, 0), 'lines', coalesce((c ->> 'lines')::integer, 0),
           'plan_only', c ->> 'key' = 'contingency')), '[]'::jsonb)
    into v_cats from jsonb_array_elements(coalesce(v_money -> 'by_category', '[]'::jsonb)) c;
  -- the two categories that cost the most over the plan (the sentence under the header)
  select coalesce(jsonb_agg(t.x order by (t.x ->> 'amount')::numeric desc), '[]'::jsonb) into v_reasons
    from (select jsonb_build_object('key', c ->> 'key', 'label', c ->> 'label', 'amount', (c ->> 'diff')::numeric,
                                    'unplanned', (c ->> 'plan')::numeric <= 0) as x
            from jsonb_array_elements(v_cats) c
           where (c ->> 'diff')::numeric > 0.5 and not (c ->> 'plan_only')::boolean
           order by (c ->> 'diff')::numeric desc limit 2) t;

  -- ---- needs attention (at most 3: red first, then amber, then information) ----
  -- 1 vendor bills still to pay on this event (0373: open part after payouts)
  select count(*), coalesce(sum(o.open), 0) into n_open, v_open
    from public.vendor_bills b cross join lateral (select public._r373_open(b.id) as open) o
   where b.quote_id = p_quote and b.org_id = v_org and b.status = 'open' and o.open > 0.005;
  if n_open > 0 then
    select b.due_date, o.open, coalesce(nullif(btrim(vv.name), ''), nullif(btrim(er.label), ''), nullif(btrim(b.description), ''), 'Vendor') as who
      into rb
      from public.vendor_bills b
      left join public.vendors vv on vv.id = b.vendor_id and vv.org_id = v_org
      left join public.event_resources er on er.id = b.booking_id and er.org_id = v_org
      cross join lateral (select public._r373_open(b.id) as open) o
     where b.quote_id = p_quote and b.org_id = v_org and b.status = 'open' and o.open > 0.005
     order by b.due_date nulls last, b.bill_date nulls last, b.created_at limit 1;
    v_items := v_items || jsonb_build_array(jsonb_build_object('kind', 'bill_due', 'rank', 1,
      'level', case when rb.due_date is not null and rb.due_date <= v_today + 1 then 'bad'
                    when rb.due_date is not null and rb.due_date <= v_today + 3 then 'warn' else 'info' end,
      'who', rb.who, 'amount', rb.open, 'date', rb.due_date, 'days', rb.due_date - v_today, 'count', n_open, 'total', v_open));
  end if;
  -- 2 money to collect from the client (the next payment of the schedule, 0264)
  if v_bal > 0 then
    select pm.label, pm.amount, pm.due_date into rm from public.payment_milestones pm
     where pm.quote_id = p_quote and pm.org_id = v_org and pm.status in ('due', 'invoiced') and coalesce(pm.amount, 0) > 0
     order by pm.due_date nulls last, pm.seq limit 1;
    v_items := v_items || jsonb_build_array(jsonb_build_object('kind', 'collect', 'rank', 2,
      'level', case when (rm.due_date is not null and rm.due_date < v_today) or (q.event_date is not null and q.event_date < v_today) then 'bad'
                    when (rm.due_date is not null and rm.due_date <= v_today + 3) or (q.event_date is not null and q.event_date <= v_today + 3) then 'warn'
                    else 'info' end,
      'amount', v_bal, 'next_amount', case when rm.amount is not null then least(rm.amount, v_bal) end, 'label', rm.label,
      'date', rm.due_date, 'days', rm.due_date - v_today));
  end if;
  -- 3 margin below the target
  if v_light in ('warn', 'bad') then
    v_items := v_items || jsonb_build_array(jsonb_build_object('kind', 'margin', 'rank', 3, 'level', v_light,
      'margin', v_margin, 'target', v_target, 'gap', round(v_target - v_margin, 1), 'loss', v_profit < 0));
  end if;
  -- 4 categories well over the plan (the 0372 big-gap rule)
  select count(*) into n_over from jsonb_array_elements(v_cats) c where c ->> 'flag' = 'over';
  if n_over > 0 then
    select jsonb_build_object('key', c ->> 'key', 'label', c ->> 'label', 'amount', (c ->> 'diff')::numeric) into v_top
      from jsonb_array_elements(v_cats) c where c ->> 'flag' = 'over' order by (c ->> 'diff')::numeric desc limit 1;
    v_items := v_items || jsonb_build_array(jsonb_build_object('kind', 'over_plan', 'rank', 4, 'level', 'warn', 'count', n_over, 'top', v_top,
      'total', (select coalesce(sum((c ->> 'diff')::numeric), 0) from jsonb_array_elements(v_cats) c where c ->> 'flag' = 'over')));
  end if;
  -- 6 unplanned spends (no estimate, added on or after the event day)
  v_unp := coalesce((v_money ->> 'unplanned_amount')::numeric, 0);
  if v_unp > 0.5 then
    v_items := v_items || jsonb_build_array(jsonb_build_object('kind', 'unplanned', 'rank', 6, 'level', 'info', 'amount', v_unp,
      'count', coalesce((v_money ->> 'unplanned_lines')::integer, 0)));
  end if;
  -- 7 damage & loss counted as a cost
  select coalesce(sum((c ->> 'expected')::numeric), 0) into v_dmg from jsonb_array_elements(v_cats) c where c ->> 'key' = 'damages';
  if v_dmg > 0.5 then
    v_items := v_items || jsonb_build_array(jsonb_build_object('kind', 'damage', 'rank', 7, 'level', 'info', 'amount', v_dmg));
  end if;
  -- 8 crew attendance not confirmed yet (0372 warning; live numbers only)
  if v_frozen is null then
    select w into v_warn from jsonb_array_elements(coalesce(v_money -> 'warnings', '[]'::jsonb)) w where w ->> 'code' = 'attendance_unconfirmed' limit 1;
    if v_warn is not null then
      v_items := v_items || jsonb_build_array(jsonb_build_object('kind', 'attendance', 'rank', 8, 'level', 'info',
        'count', coalesce((v_warn ->> 'count')::integer, 0)));
    end if;
  end if;
  select coalesce(jsonb_agg(t.a order by t.o, t.r), '[]'::jsonb) into v_attn
    from (select a, case a ->> 'level' when 'bad' then 0 when 'warn' then 1 else 2 end as o, (a ->> 'rank')::integer as r
            from jsonb_array_elements(v_items) a order by 2, 3 limit 3) t;

  return jsonb_build_object(
    'quote_id', q.id, 'code', q.code, 'title', q.title, 'event_date', q.event_date, 'status', q.status, 'currency', q.cur,
    'today', v_today, 'days_to_event', q.event_date - v_today, 'closed', v_closed is not null, 'closed_at', v_closed, 'rules', v_rules,
    'frozen', v_frozen, 'live_profit', case when v_frozen is not null then v_live end, 'live_differs', v_drift,
    'quoted', v_quoted, 'revenue', v_rev, 'tax', coalesce((v_pnl ->> 'tax')::numeric, 0),
    'refunds', case when v_rules = 'legacy' then 0 else coalesce((v_money ->> 'refunds_ex_tax')::numeric, 0) end,
    'received', v_paid, 'client_tds', v_tds, 'balance', v_bal,
    'received_pct', case when v_quoted > 0 then least(100, floor((v_paid + v_tds) / v_quoted * 100)) end,
    'cost_word', case when v_closed is not null then 'actual' else 'expected' end,
    'costs', v_cost, 'costs_plan', v_plan, 'costs_diff', v_cost - v_plan, 'costs_actual', coalesce((v_money ->> 'cost_actual')::numeric, 0),
    'accuracy_pct', v_money -> 'accuracy_pct',
    'profit', v_profit, 'margin_pct', v_margin, 'plan_profit', v_plan_profit, 'plan_margin_pct', v_plan_margin,
    'target_pct', v_target, 'target_set', v_target_set, 'band', v_band, 'light', v_light,
    'gap_points', case when v_margin is not null then round(v_target - v_margin, 1) end,
    'reasons', v_reasons, 'categories', v_cats, 'lines', public._r376_lines(v_money -> 'lines', v_admin),
    'gap_rule', jsonb_build_object('pct', v_cfg -> 'gap_pct', 'abs', v_cfg -> 'gap_abs'),
    'attention', v_attn, 'pay_private', not v_admin);
end $$;

-- ---- 5) the cash view: the ledger once ---------------------------------------------------------------------------------------
create or replace function public.event_money_cash(p_quote uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
-- r212-0387: same answer as the r198-0377 body (kept as event_money_cash__pre0387); the ledger is worked out once, not twice.
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
  v_cash_left numeric; v_other numeric; v_points jsonb; v_event_d date; v_live_m jsonb;
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
  -- r212-0387: the live ledger is worked out ONCE (with its lines); the profit is composed from it by _r387_event_pnl, which
  -- answers exactly what _vb_event_pnl answers (0372 frozen figure for a closed + frozen event, else live). Was: twice per call.
  v_live_m := public._r21_event_money(p_quote, v_org, true);
  v_pnl := public._r387_event_pnl(p_quote, v_org, v_live_m);
  if v_pnl is null then return null; end if;
  if jsonb_typeof(v_pnl -> 'frozen') = 'object' then
    v_frozen := true;
    s := public._r372_current_snapshot(p_quote);
    if s.id is not null and s.org_id = v_org and s.money <> '{}'::jsonb then v_money := s.money; end if;
  end if;
  if v_money is null then v_money := coalesce(v_live_m, '{}'::jsonb); end if;
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

-- ---- 6) grants: the two page calls for signed-in staff (each checks Finance view inside); everything else server only ---------
do $$
declare f text;
begin
  foreach f in array array['public._r21_cost_lines__pre0372(uuid,uuid)', 'public._r21_cost_lines__pre0372__pre0387(uuid,uuid)',
                           'public._r387_event_pnl(uuid,uuid,jsonb)',
                           'public.event_money_header__pre0387(uuid)', 'public.event_money_cash__pre0387(uuid)'] loop
    execute format('revoke all on function %s from public', f);
    if exists (select 1 from pg_roles where rolname = 'anon') then execute format('revoke all on function %s from anon', f); end if;
    if exists (select 1 from pg_roles where rolname = 'authenticated') then execute format('revoke all on function %s from authenticated', f); end if;
    if exists (select 1 from pg_roles where rolname = 'service_role') then execute format('grant execute on function %s to service_role', f); end if;
  end loop;
  foreach f in array array['public.event_money_header(uuid)', 'public.event_money_cash(uuid)'] loop
    execute format('revoke all on function %s from public', f);
    if exists (select 1 from pg_roles where rolname = 'anon') then execute format('revoke all on function %s from anon', f); end if;
    if exists (select 1 from pg_roles where rolname = 'authenticated') then execute format('grant execute on function %s to authenticated', f); end if;
    if exists (select 1 from pg_roles where rolname = 'service_role') then execute format('grant execute on function %s to service_role', f); end if;
  end loop;
end $$;

notify pgrst, 'reload schema';

select item, ok from (values
  ('01 the three old bodies kept once (__pre0387)',
     to_regprocedure('public._r21_cost_lines__pre0372__pre0387(uuid,uuid)') is not null
     and to_regprocedure('public.event_money_header__pre0387(uuid)') is not null
     and to_regprocedure('public.event_money_cash__pre0387(uuid)') is not null),
  ('02 new bodies carry the r212-0387 marker and keep the r197-0376 / r198-0377 / r21-money-0246 markers',
     position('r212-0387' in pg_get_functiondef(to_regprocedure('public.event_money_header(uuid)'))) > 0
     and position('r197-0376' in pg_get_functiondef(to_regprocedure('public.event_money_header(uuid)'))) > 0
     and position('r212-0387' in pg_get_functiondef(to_regprocedure('public.event_money_cash(uuid)'))) > 0
     and position('r198-0377' in pg_get_functiondef(to_regprocedure('public.event_money_cash(uuid)'))) > 0
     and position('r212-0387' in pg_get_functiondef(to_regprocedure('public._r21_cost_lines__pre0372(uuid,uuid)'))) > 0
     and position('r21-money-0246' in pg_get_functiondef(to_regprocedure('public._r21_cost_lines__pre0372(uuid,uuid)'))) > 0
     and position('r212-0387' in pg_get_functiondef(to_regprocedure('public._r387_event_pnl(uuid,uuid,jsonb)'))) > 0),
  ('03 header + cash build the ledger once (no second _vb_event_pnl ledger); the ledger has its five fences',
     position('public._vb_event_pnl(' in pg_get_functiondef(to_regprocedure('public.event_money_header(uuid)'))) = 0
     and position('public._r387_event_pnl(' in pg_get_functiondef(to_regprocedure('public.event_money_header(uuid)'))) > 0
     and position('public._vb_event_pnl(' in pg_get_functiondef(to_regprocedure('public.event_money_cash(uuid)'))) = 0
     and position('public._r387_event_pnl(' in pg_get_functiondef(to_regprocedure('public.event_money_cash(uuid)'))) > 0
     and (length(pg_get_functiondef(to_regprocedure('public._r21_cost_lines__pre0372(uuid,uuid)')))
          - length(replace(pg_get_functiondef(to_regprocedure('public._r21_cost_lines__pre0372(uuid,uuid)')), ' offset 0) ', ''))) / length(' offset 0) ') = 5),
  ('04 definer + empty search_path + stable on all seven functions',
     (select count(*) = 7 and bool_and(p.prosecdef and coalesce(p.proconfig, '{}') @> array['search_path=""'] and p.provolatile = 's') from pg_proc p
       where p.oid in (to_regprocedure('public.event_money_header(uuid)'), to_regprocedure('public.event_money_cash(uuid)'),
                       to_regprocedure('public._r21_cost_lines__pre0372(uuid,uuid)'), to_regprocedure('public._r387_event_pnl(uuid,uuid,jsonb)'),
                       to_regprocedure('public.event_money_header__pre0387(uuid)'), to_regprocedure('public.event_money_cash__pre0387(uuid)'),
                       to_regprocedure('public._r21_cost_lines__pre0372__pre0387(uuid,uuid)')))),
  ('05 the page calls stay open to signed-in staff only (Finance view checked inside), never to signed-out callers',
     (not exists (select 1 from pg_roles where rolname = 'authenticated')
        or (has_function_privilege('authenticated', 'public.event_money_header(uuid)', 'execute')
            and has_function_privilege('authenticated', 'public.event_money_cash(uuid)', 'execute')))
     and (not exists (select 1 from pg_roles where rolname = 'anon')
        or (not has_function_privilege('anon', 'public.event_money_header(uuid)', 'execute')
            and not has_function_privilege('anon', 'public.event_money_cash(uuid)', 'execute')))),
  ('06 the kept bodies and _r387_event_pnl are server only',
     (select bool_and((not exists (select 1 from pg_roles where rolname = 'authenticated') or not has_function_privilege('authenticated', p.oid, 'execute'))
                  and (not exists (select 1 from pg_roles where rolname = 'anon') or not has_function_privilege('anon', p.oid, 'execute')))
        from pg_proc p where p.oid in (to_regprocedure('public._r387_event_pnl(uuid,uuid,jsonb)'), to_regprocedure('public.event_money_header__pre0387(uuid)'),
                                       to_regprocedure('public.event_money_cash__pre0387(uuid)'), to_regprocedure('public._r21_cost_lines__pre0372(uuid,uuid)'),
                                       to_regprocedure('public._r21_cost_lines__pre0372__pre0387(uuid,uuid)')))),
  ('07 same money: on the 10 most recently changed events the new ledger = the old ledger and the new P&L = _vb_event_pnl',
     not exists (select 1 from (select q.id, q.org_id from public.quotes q where q.deleted_at is null and q.org_id is not null
                                 order by q.updated_at desc nulls last limit 10) e
                  where public._r21_cost_lines__pre0372(e.id, e.org_id) is distinct from public._r21_cost_lines__pre0372__pre0387(e.id, e.org_id)
                     or public._r387_event_pnl(e.id, e.org_id, public._r21_event_money(e.id, e.org_id, true)) is distinct from public._vb_event_pnl(e.id, e.org_id)))
) v(item, ok) order by item;
commit;
