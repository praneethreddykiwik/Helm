-- APPLY-0091.sql - paste into the Supabase SQL editor (prod or staging). ASCII only, idempotent,
-- safe to paste twice (the second run fills 0 rows). Fill-only: never changes pricing or totals.
-- Ends with verify rows (item, ok) - every ok must be true.
begin;

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

commit;

select item, ok from (values
  ('0091 01 quotes currency + tax_snapshot columns', (select count(*) from information_schema.columns where table_schema='public' and table_name='quotes' and column_name in ('currency','tax_snapshot')) = 2),
  ('0091 02 no quote left without a currency', not exists (select 1 from public.quotes where currency is null)),
  ('0091 03 no quote left without a tax snapshot', not exists (select 1 from public.quotes where tax_snapshot is null)),
  ('0091 04 quotes without pricing.taxCountry are INR', not exists (select 1 from public.quotes where coalesce(pricing ->> 'taxCountry', '') = '' and currency <> 'INR' and coalesce(tax_snapshot ->> 'backfill', '') = 'true')),
  ('0091 05 snapshot trigger still installed', exists (select 1 from pg_trigger where tgname='zzz_quote_tax_snapshot' and tgrelid='public.quotes'::regclass))
) v(item, ok)
order by item;
