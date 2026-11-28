-- APPLY-0455 (R271: once a vendor is paid every page says paid - closure, Who owes what, the money header, the vendor's step; stock still out = only what is still out). Run on STAGING, then Canada production, then HELM-PROD-MUMBAI.
-- Safe to run twice. It stops before changing anything if something it needs is missing. If 0268, 0282, 0447 or 0450 is ever pasted again, paste 0455 after it.
-- Same content as supabase/migrations/0455_r271_vendor_paid.sql. The last result lists one row per check.
begin;
set local lock_timeout = '5s';
set local statement_timeout = '5min';
-- 0455_r271_vendor_paid.sql - R271 once a vendor is paid every page says paid; stock still out counts only what is still out.
-- Forward-only, additive, safe to run twice. ASCII only.
-- REQUIRES 0268 (closure checklist body), 0282 (its wrapper), 0373 (typed advances as payouts), 0447 (vendor request state), 0450 (settled_reason).
--
-- In plain words (owner, 27 Nov 2026: "I already paid the vendor, but it was still showing at the closure that I need to pay the vendor"
-- and "make sure everything is synced properly ... giving back inventory, reserving, checking in"):
--   A  A typed advance on a vendor booking now goes onto the vendor's bill as a payment the moment the bill is made (an approved invoice,
--      "Pay the vendor" without a bill, or a bill typed in). Before, the bill showed the advance as still to pay on the closure checklist,
--      the money header, Who owes what and the bell, while Payments & invoice said Paid. Same rows as the "Record typed advances" button
--      (0373, same key, so never twice). Best effort: if it cannot be written the bill is still saved exactly as before.
--   B  Closure checklist "Vendors paid": a typed advance that is not on the bill yet counts as paid (the rule Payments & invoice uses).
--   C  Closure checklist "Vendor bills recorded": a vendor closed without a payment (with a reason) needs no bill.
--   D  The vendor's step on Resource plan / Wrap-up / Vendors: paid in full on the bills (payments + typed advance) = "paid", however it was paid.
--   E  Closure checklist stock: "Out and not back yet" counts what is still out, not the whole lot given out (a part already came back),
--      and what came back of a part return counts as back. Used-up consumables are not counted as back.
-- Old bodies are kept: _r22_close_checks__pre0455 (the closure checklist body before the edit), _r447_state__pre0455.
-- ZERO DATA LOSS: no table, column or stored row is changed or removed. Only new payout rows of a typed advance on NEW bills (A).

do $$ begin
  if to_regprocedure('public._r22_close_checks__pre0282(uuid,uuid)') is null or to_regprocedure('public._r22_close_checks(uuid,uuid)') is null then
    raise exception 'STOP 0455: apply 0254, 0268 and 0282 first (closure checklist)'; end if;
  if to_regprocedure('public._r373_converted(uuid)') is null or to_regprocedure('public._a198_org_today(uuid)') is null then
    raise exception 'STOP 0455: apply 0198 and 0373 first (typed advances)'; end if;
  if to_regprocedure('public._r447_state(public.vendor_requests)') is null then raise exception 'STOP 0455: apply 0447 first (vendor requests)'; end if;
  if not exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'event_resources' and column_name = 'settled_reason') then
    raise exception 'STOP 0455: apply 0450 first (settled_reason)'; end if;
  if position('r24-stock-0268' in pg_get_functiondef('public._r22_close_checks__pre0282(uuid,uuid)'::regprocedure)) = 0 then
    raise exception 'STOP 0455: the closure checklist is not the 0268 body - nothing was changed'; end if;
end $$;

-- ---- helpers (server only) -------------------------------------------------------------------------------------------------------
-- the part of a booking's typed advance that is not a payout row yet, given to this bill oldest bill first (as Payments & invoice does)
create or replace function public._r455_adv_credit(p_bill uuid)
returns numeric language sql stable security definer set search_path = '' as $fn$
  -- r271-0455
  with b as (select x.booking_id, x.org_id from public.vendor_bills x where x.id = p_bill and x.status <> 'void' and x.booking_id is not null),
       k as (select greatest(0, coalesce(r.advance, 0) - public._r373_converted(r.id)) as credit
               from public.event_resources r join b on r.id = b.booking_id and r.org_id = b.org_id where r.status <> 'cancelled'),
       l as (select x.id, x.bill_date, x.created_at,
                    greatest(0, x.amount - coalesce((select sum(p.amount) from public.vendor_payouts p where p.bill_id = x.id), 0)) as gap
               from public.vendor_bills x join b on x.booking_id = b.booking_id and x.org_id = b.org_id where x.status <> 'void'),
       c as (select l.id, l.gap, coalesce(sum(l.gap) over (order by l.bill_date, l.created_at, l.id rows between unbounded preceding and 1 preceding), 0) as before from l)
  select coalesce((select least(c.gap, greatest(0, k.credit - c.before)) from c, k where c.id = p_bill), 0);
$fn$;

-- what is still owed on a booking's bills (bills - payouts - typed advance not on a bill yet); null = the booking has no bill
create or replace function public._r455_booking_owed(p_booking uuid)
returns numeric language sql stable security definer set search_path = '' as $fn$
  -- r271-0455
  select case when count(x.id) = 0 then null
              else greatest(0, sum(x.amount) - sum(coalesce((select sum(p.amount) from public.vendor_payouts p where p.bill_id = x.id), 0))
                               - max(greatest(0, coalesce(r.advance, 0) - public._r373_converted(r.id)))) end
    from public.vendor_bills x join public.event_resources r on r.id = x.booking_id and r.org_id = x.org_id
   where x.booking_id = p_booking and x.status <> 'void' and r.status <> 'cancelled';
$fn$;

-- ---- A: a new bill of a booking takes the typed advance as a payment (the 0373 row, same key) -------------------------------------------
create or replace function public._r455_tg_take_advance()
returns trigger language plpgsql security definer set search_path = '' as $fn$
-- r271-0455: best effort; a failure here never stops the bill
declare v_left numeric; v_use numeric; v_key text;
begin
  if new.booking_id is null or new.status = 'void' then return null; end if;
  begin
    select greatest(0, coalesce(r.advance, 0) - public._r373_converted(r.id)) into v_left
      from public.event_resources r where r.id = new.booking_id and r.org_id = new.org_id and r.status <> 'cancelled' and coalesce(r.cost, 0) > 0;
    if coalesce(v_left, 0) <= 0.005 then return null; end if;
    v_use := round(least(new.amount - coalesce((select sum(p.amount) from public.vendor_payouts p where p.bill_id = new.id), 0), v_left), 2);
    v_key := 'adv:' || new.booking_id::text || ':' || new.id::text;
    if v_use > 0.005 and not exists (select 1 from public.vendor_payouts p where p.org_id = new.org_id and p.idempotency_key = v_key) then
      insert into public.vendor_payouts(bill_id, org_id, amount, paid_on, method, reference, idempotency_key, source)
      values (new.id, new.org_id, v_use, public._a198_org_today(new.org_id), 'Advance (typed earlier)', 'Advance typed on the vendor booking', v_key, 'advance');
    end if;
  exception when others then
    raise warning 'r271-0455: typed advance not put on bill % (%)', new.id, sqlstate;
  end;
  return null;
end $fn$;
drop trigger if exists zz_r455_take_advance on public.vendor_bills;
create trigger zz_r455_take_advance after insert on public.vendor_bills
  for each row execute function public._r455_tg_take_advance();

-- ---- B + C + E: exact text edits of the closure checklist body (kept as _r22_close_checks__pre0455) ----------------------------------------
do $$ declare v_def text := pg_get_functiondef('public._r22_close_checks__pre0282(uuid,uuid)'::regprocedure); v_new text; i int;
  e_old text[] := array[
    'sum(x.qty_out) filter (where x.status = ''out'') as still_out',
    'sum(coalesce(x.qty_in, 0)) filter (where x.status in (''returned'', ''partial'')) as ci',
    'sum(coalesce(x.qty_damaged, 0)) filter (where x.status in (''returned'', ''partial'')) as dmg',
    'and r.status in (''booked'', ''confirmed'', ''delivered'') and coalesce(r.cost, 0) > 0) x;',
    'select vb.amount - coalesce((select sum(p.amount) from public.vendor_payouts p where p.bill_id = vb.id), 0) as due'];
  e_new text[] := array[
    'sum(greatest(x.qty_out - coalesce(x.qty_in, 0), 0)) filter (where x.status = ''out'') as still_out /* r271-0455: only what is still out */',
    'sum(greatest(coalesce(x.qty_in, 0) - coalesce(x.qty_used, 0), 0)) filter (where x.status in (''returned'', ''partial'', ''out'')) as ci',
    'sum(coalesce(x.qty_damaged, 0)) filter (where x.status in (''returned'', ''partial'', ''out'')) as dmg',
    'and r.status in (''booked'', ''confirmed'', ''delivered'') and coalesce(r.cost, 0) > 0
             and not (coalesce(r.settled, false) and nullif(btrim(coalesce(r.settled_reason, '''')), '''') is not null)) x; /* r271-0455: closed without payment */',
    'select greatest(0, vb.amount - coalesce((select sum(p.amount) from public.vendor_payouts p where p.bill_id = vb.id), 0) - public._r455_adv_credit(vb.id)) as due'];
begin
  if position('r271-0455' in v_def) > 0 then return; end if;
  for i in 1 .. array_length(e_old, 1) loop
    if (length(v_def) - length(replace(v_def, e_old[i], ''))) <> length(e_old[i]) then
      raise exception 'STOP 0455: the closure checklist has an unexpected body (part %) - nothing was changed', i; end if;
  end loop;
  if to_regprocedure('public._r22_close_checks__pre0455(uuid,uuid)') is null then
    execute replace(v_def, 'FUNCTION public._r22_close_checks__pre0282(', 'FUNCTION public._r22_close_checks__pre0455(');
  end if;
  v_new := v_def;
  for i in 1 .. array_length(e_old, 1) loop v_new := replace(v_new, e_old[i], e_new[i]); end loop;
  execute v_new;
end $$;

-- ---- D: the vendor's step says paid once the bills are paid (wraps the 0447 body, kept as _r447_state__pre0455) --------------------------
do $$ begin
  if to_regprocedure('public._r447_state__pre0455(public.vendor_requests)') is null then
    alter function public._r447_state(public.vendor_requests) rename to _r447_state__pre0455;
  end if;
end $$;
create or replace function public._r447_state(p_r public.vendor_requests)
returns text language plpgsql stable security definer set search_path = '' as $fn$
-- r271-0455: wraps _r447_state__pre0455 (r259-0447): paid in full on the booking's bills (payments + typed advance) = paid, whichever way it was paid
declare v text := public._r447_state__pre0455(p_r); v_owed numeric;
begin
  if v is null or v not in ('confirmed', 'invoice_asked', 'invoice_approved') or p_r.booking_id is null or p_r.status <> 'accepted' then return v; end if;
  v_owed := public._r455_booking_owed(p_r.booking_id);
  if v_owed is not null and v_owed <= 0.005 then return 'paid'; end if;
  return v;
end $fn$;

do $$ declare f text; r text; begin
  foreach f in array array['public._r455_adv_credit(uuid)', 'public._r455_booking_owed(uuid)', 'public._r455_tg_take_advance()', 'public._r22_close_checks(uuid,uuid)',
      'public._r22_close_checks__pre0282(uuid,uuid)', 'public._r22_close_checks__pre0455(uuid,uuid)', 'public._r447_state(public.vendor_requests)', 'public._r447_state__pre0455(public.vendor_requests)'] loop
    execute 'revoke all on function ' || f || ' from public';
    foreach r in array array['anon', 'authenticated'] loop
      if exists (select 1 from pg_roles where rolname = r) then execute format('revoke all on function %s from %I', f, r); end if;
    end loop;
    if exists (select 1 from pg_roles where rolname = 'service_role') then execute 'grant execute on function ' || f || ' to service_role'; end if;
  end loop;
  if to_regclass('public.helm_schema_markers') is not null then
    insert into public.helm_schema_markers(num, name) values (455, '0455_r271_vendor_paid') on conflict (num) do nothing;
  end if;
end $$;

notify pgrst, 'reload schema';

-- ---- CHECK (read only): every row must say true -------------------------------------------------------------------------------
select c."check", c.ok from (values
  ('01 a new bill takes the typed advance', exists (select 1 from pg_trigger where tgname = 'zz_r455_take_advance' and tgrelid = 'public.vendor_bills'::regclass and not tgisinternal)),
  ('02 the closure checklist counts paid and still out the same way as the pages', position('r271-0455' in pg_get_functiondef('public._r22_close_checks__pre0282(uuid,uuid)'::regprocedure)) > 0
      and position('_r455_adv_credit' in pg_get_functiondef('public._r22_close_checks__pre0282(uuid,uuid)'::regprocedure)) > 0
      and position('settled_reason' in pg_get_functiondef('public._r22_close_checks__pre0282(uuid,uuid)'::regprocedure)) > 0),
  ('03 the vendor step says paid when the bills are paid', position('r271-0455' in pg_get_functiondef('public._r447_state(public.vendor_requests)'::regprocedure)) > 0),
  ('04 the old bodies are kept', to_regprocedure('public._r22_close_checks__pre0455(uuid,uuid)') is not null
      and position('r271-0455' in pg_get_functiondef('public._r22_close_checks__pre0455(uuid,uuid)'::regprocedure)) = 0
      and position('r24-stock-0268' in pg_get_functiondef('public._r22_close_checks__pre0455(uuid,uuid)'::regprocedure)) > 0
      and to_regprocedure('public._r447_state__pre0455(public.vendor_requests)') is not null),
  ('05 server only', not has_function_privilege('authenticated', 'public._r455_adv_credit(uuid)', 'execute')
      and not has_function_privilege('authenticated', 'public._r22_close_checks__pre0455(uuid,uuid)', 'execute')
      and not has_function_privilege('anon', 'public._r447_state__pre0455(public.vendor_requests)', 'execute')
      and not has_function_privilege('authenticated', 'public._r455_booking_owed(uuid)', 'execute'))
) c("check", ok);
commit;
