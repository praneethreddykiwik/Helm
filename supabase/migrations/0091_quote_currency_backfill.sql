-- 0091_quote_currency_backfill.sql - CANONICAL forward-only. Old quotes keep their rupees.
--
-- In plain words:
--   0089 started stamping each quote's own currency + tax facts (quotes.currency / tax_snapshot)
--   whenever its pricing is saved, but did not fill the quotes created BEFORE 0089. Those rows
--   have no currency, so a studio that later switched to UAE / USA saw its old Indian quotes
--   labelled AED / $. Every quote created before 0089 was an India / INR quote. This fills ONLY
--   the empty columns: currency = 'INR' (or the pricing's own country when it has one) and a
--   tax_snapshot built from the quote's own pricing, marked backfill 91.
--   Never touches pricing, totals, status, payments or any other column; rows that already have
--   a currency are left exactly as they are. Safe to run twice (second run updates 0 rows).
--   Additive + idempotent. Needs 0089.
-- ============================================================================

do $$ begin
  if not exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'quotes' and column_name = 'tax_snapshot') then
    raise exception '0091: apply 0089_country_tax.sql first (quotes.tax_snapshot missing)';
  end if;
end $$;

update public.quotes q
set currency = x.cur,
    tax_snapshot = coalesce(q.tax_snapshot, x.snap)
from (
  select s.id, s.cur, jsonb_strip_nulls(jsonb_build_object(
      'country', s.cc, 'currency', s.cur,
      'taxName', coalesce(nullif(left(s.p ->> 'taxName', 24), ''), case s.cc when 'AE' then 'VAT' when 'US' then 'Sales tax' when 'IN' then 'GST' else 'Tax' end),
      'rate', case when lower(coalesce(s.p ->> 'taxExempt', '')) = 'true' then 0
                   when coalesce(s.p ->> 'gstPct', '') ~ '^-?[0-9]+(\.[0-9]+)?$' then (s.p ->> 'gstPct')::numeric else null end,
      'exempt', lower(coalesce(s.p ->> 'taxExempt', '')) = 'true',
      'inclusive', lower(coalesce(s.p ->> 'taxInclusive', '')) = 'true',
      'region', nullif(left(coalesce(s.p ->> 'taxRegion', ''), 60), ''),
      'placeOfSupply', case when s.cc = 'IN' then coalesce(nullif(s.p ->> 'placeOfSupply', ''), 'intra') else null end,
      'total', case when jsonb_typeof(s.p -> 'total') = 'number' then s.p -> 'total' else null end,
      'v', 91, 'backfill', true)) as snap
  from (
    select c.id, c.p, c.cc,
           case when c.cc = 'IN' then 'INR'
                when upper(coalesce(c.p ->> 'currency', '')) ~ '^[A-Z]{3}$' then upper(c.p ->> 'currency')
                when c.cc = 'AE' then 'AED' when c.cc = 'US' then 'USD' else 'INR' end as cur
    from (
      select q0.id,
             case when jsonb_typeof(q0.pricing) = 'object' then q0.pricing else '{}'::jsonb end as p,
             case when upper(coalesce(q0.pricing ->> 'taxCountry', '')) ~ '^[A-Z]{2}$' then upper(q0.pricing ->> 'taxCountry') else 'IN' end as cc
      from public.quotes q0
      where q0.currency is null
    ) c
  ) s
) x
where q.id = x.id and q.currency is null;
