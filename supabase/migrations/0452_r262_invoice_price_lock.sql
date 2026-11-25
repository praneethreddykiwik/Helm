-- 0452_r262_invoice_price_lock.sql - R262 a vendor's invoice keeps the approved price. Forward-only, additive, safe to run twice. ASCII only.
-- REQUIRES 0447 (vendor flow).
--
-- In plain words (owner, 26 Nov 2026: "once a price is approved, the vendor should not change the price when sending the invoice"):
--   When a price was approved (or agreed) for a request, a NEW invoice from the vendor's link must keep it: the same products, the approved price of
--   each, not more pieces, not more delivery / other charges, and - with their other open or approved invoices for the same request - not more than the
--   approved total (before tax). Fewer pieces, a discount and GST / tax on top are fine. Extra costs: the studio adds "+ Charge from the vendor".
--   A request with no agreed price (a plain "send your invoice") is not limited.
-- ZERO DATA LOSS: no table, column or row is changed or removed. Invoices already received stay exactly as they are (the rule runs on new rows only).

do $$ begin
  if to_regprocedure('public._r447_confirmed(public.vendor_requests)') is null then raise exception 'STOP 0452: apply 0447 first'; end if;
end $$;

create or replace function public.tg_r452_invoice_price()
returns trigger language plpgsql security definer set search_path = '' as $$
-- r262-0452
declare r public.vendor_requests; c jsonb; v_tot numeric; v_other numeric; x record; a jsonb; v_name text; v_q numeric; v_names text[] := '{}';
begin
  select * into r from public.vendor_requests y where y.id = new.request_id and y.org_id = new.org_id;
  if r.id is null or r.status <> 'accepted' or r.invoice_only then return new; end if;
  c := public._r447_confirmed(r); v_tot := round((c ->> 'total')::numeric, 2);
  if v_tot is null or v_tot <= 0 then return new; end if;                      -- no price was agreed
  select coalesce(sum(i.taxable_amount), 0) into v_other from public.vendor_invoices i
   where i.request_id = r.id and i.org_id = r.org_id and i.id <> new.id and i.status in ('submitted', 'approved');
  if new.lines is not null then
    if coalesce(new.charges, 0) > coalesce((c ->> 'charges')::numeric, 0) + 0.005 then
      raise exception 'the delivery / other charges are more than what was approved - ask the studio to add an extra cost' using errcode = '22023', hint = 'r452_price'; end if;
    for x in select lower(btrim(e.v ->> 'name')) as nm, e.v ->> 'name' as name, round((e.v ->> 'price')::numeric, 2) as price, (e.v ->> 'qty')::numeric as qty
               from jsonb_array_elements(new.lines) with ordinality e(v, n) order by e.n loop
      select y.v into a from jsonb_array_elements(c -> 'lines') y(v) where lower(btrim(y.v ->> 'name')) = x.nm limit 1;
      if a is null then raise exception 'the product % is not part of what was approved - ask the studio to add an extra cost', x.name using errcode = '22023', hint = 'r452_price'; end if;
      if jsonb_typeof(a -> 'price') = 'number' and abs(x.price - round((a ->> 'price')::numeric, 2)) > 0.005
         and not exists (select 1 from jsonb_array_elements(c -> 'lines') y(v) where lower(btrim(y.v ->> 'name')) = x.nm and abs(round((y.v ->> 'price')::numeric, 2) - x.price) <= 0.005) then
        raise exception 'the price of % was approved at % and cannot be changed', x.name, trim(to_char((a ->> 'price')::numeric, 'FM9999999999990.##'), '.') using errcode = '22023', hint = 'r452_price'; end if;
      if not (x.nm = any(v_names)) then
        v_names := v_names || x.nm;
        select sum((e.v ->> 'qty')::numeric) into v_q from jsonb_array_elements(new.lines) e(v) where lower(btrim(e.v ->> 'name')) = x.nm;
        if v_q > (select sum((y.v ->> 'qty')::numeric) from jsonb_array_elements(c -> 'lines') y(v) where lower(btrim(y.v ->> 'name')) = x.nm) + 0.005 then
          raise exception 'the quantity of % is more than what was approved', x.name using errcode = '22023', hint = 'r452_price'; end if;
      end if;
    end loop;
  end if;
  if new.taxable_amount + v_other > v_tot + 0.005 then
    raise exception 'the invoice is more than the approved price (%, before tax)%', trim(to_char(v_tot, 'FM9999999999990.##'), '.'),
      case when v_other > 0 then ', together with the invoice you already sent' else '' end using errcode = '22023', hint = 'r452_price'; end if;
  return new;
end $$;

create or replace trigger r452_invoice_price before insert on public.vendor_invoices for each row execute function public.tg_r452_invoice_price();

do $$ declare r text; begin
  revoke all on function public.tg_r452_invoice_price() from public;
  foreach r in array array['anon', 'authenticated', 'service_role'] loop
    if exists (select 1 from pg_roles where rolname = r) then execute format('revoke all on function public.tg_r452_invoice_price() from %I', r); end if;
  end loop;
  if to_regclass('public.helm_schema_markers') is not null then
    insert into public.helm_schema_markers(num, name) values (452, '0452_r262_invoice_price_lock') on conflict (num) do nothing;
  end if;
end $$;

notify pgrst, 'reload schema';

-- ---- CHECK (read only): every row must say true -------------------------------------------------------------------------------
select c."check", c.ok from (values
  ('01 the rule runs on every new vendor invoice', exists (select 1 from pg_trigger t where t.tgrelid = 'public.vendor_invoices'::regclass and t.tgname = 'r452_invoice_price' and t.tgenabled = 'O' and (t.tgtype & 7) = 7)),
  ('02 only new rows (nothing on update or delete)', (select (t.tgtype & 24) = 0 from pg_trigger t where t.tgrelid = 'public.vendor_invoices'::regclass and t.tgname = 'r452_invoice_price')),
  ('03 it reads what was approved', position('_r447_confirmed' in pg_get_functiondef('public.tg_r452_invoice_price()'::regprocedure)) > 0),
  ('04 server only, search_path pinned', not has_function_privilege('authenticated', 'public.tg_r452_invoice_price()', 'execute') and not has_function_privilege('anon', 'public.tg_r452_invoice_price()', 'execute')
      and (select p.proconfig @> array['search_path=""'] from pg_proc p where p.oid = 'public.tg_r452_invoice_price()'::regprocedure))
) c("check", ok);
