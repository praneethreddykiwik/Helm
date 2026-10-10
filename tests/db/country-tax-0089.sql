-- country-tax-0089.sql -- 0089: taxExempt priced at 0% by the D8 authority, India/UAE/US totals
-- unchanged, per-quote currency + tax_snapshot stamped from the quote's own pricing, studio country
-- mirrored from brand.billing, and a country switch never rewrites an existing quote. Rolled back.
\set ON_ERROR_STOP 0
set client_min_messages = warning;
begin;
create temp table _ct(name text, result text);
create or replace function pg_temp.res(p_name text, p_ok boolean, p_detail text default '') returns void language plpgsql as $$
begin insert into _ct values (p_name, case when coalesce(p_ok, false) then 'PASS' else 'FAIL: '||coalesce(p_detail,'') end); end $$;

do $$ declare qa uuid := 'a0000000-0000-4000-8000-00000000da01'; t jsonb; s jsonb; s0 jsonb;
begin
  execute 'reset role';
  perform pg_temp.res('01 India exclusive unchanged 5000+18%', public.helm_quote_total('{"gstPct":18,"chairs":10,"chairPrice":500}') = 5900);
  perform pg_temp.res('02 UAE VAT 5%', public.helm_quote_total('{"gstPct":5,"chairs":10,"chairPrice":500,"taxCountry":"AE"}') = 5250);
  perform pg_temp.res('03 US Texas 6.25%', public.helm_quote_total('{"gstPct":6.25,"chairs":10,"chairPrice":500,"taxCountry":"US"}') = 5313);
  perform pg_temp.res('04 US Oregon 0%', public.helm_quote_total('{"gstPct":0,"chairs":10,"chairPrice":500,"taxCountry":"US"}') = 5000);
  perform pg_temp.res('05 exempt client -> no tax', public.helm_quote_total('{"gstPct":18,"chairs":10,"chairPrice":500,"taxExempt":true}') = 5000);
  perform pg_temp.res('06 exempt string "true" honoured', public.helm_quote_total('{"gstPct":7.25,"chairs":10,"chairPrice":500,"taxExempt":"true"}') = 5000);
  perform pg_temp.res('07 inclusive still 0079 rule', public.helm_quote_total('{"gstPct":18,"chairs":10,"chairPrice":500,"taxInclusive":true}') = 5000);
  perform pg_temp.res('08 taxExempt false = normal', public.helm_quote_total('{"gstPct":18,"chairs":10,"chairPrice":500,"taxExempt":false}') = 5900);

  -- existing quote: snapshot only appears when the app writes pricing; old values are not rewritten
  select pricing, tax_snapshot into t, s0 from public.quotes where id = qa;
  perform pg_temp.res('10 India quote snapshot = INR/GST (no country keys)', s0 ->> 'country' = 'IN' and s0 ->> 'currency' = 'INR', coalesce(s0::text,'null'));
  update public.organizations set brand = coalesce(brand,'{}'::jsonb) || '{"billing":{"country":"us","state":"Texas"}}'::jsonb where id = 'a0000000-0000-4000-8000-000000000001';
  perform pg_temp.res('11 studio country mirrored from billing', (select country = 'US' and tax_region = 'Texas' from public.organizations where id = 'a0000000-0000-4000-8000-000000000001'));
  perform pg_temp.res('12 country switch leaves quote pricing intact', (select pricing = t and tax_snapshot = s0 and currency = 'INR' from public.quotes where id = qa));

  update public.quotes set pricing = '{"gstPct":6.25,"chairs":10,"chairPrice":500,"taxCountry":"US","currency":"USD","taxRegion":"Texas","total":1}'::jsonb where id = qa;
  select tax_snapshot into s from public.quotes where id = qa;
  perform pg_temp.res('13 snapshot stamped on write', s ->> 'country' = 'US' and s ->> 'currency' = 'USD' and (s ->> 'rate')::numeric = 6.25 and s ->> 'region' = 'Texas', s::text);
  perform pg_temp.res('14 snapshot total = server total', (s ->> 'total')::numeric = 5313 and (select currency from public.quotes where id = qa) = 'USD', s::text);
  update public.quotes set pricing = '{"gstPct":18,"chairs":10,"chairPrice":500}'::jsonb where id = qa;
  select tax_snapshot into s from public.quotes where id = qa;
  perform pg_temp.res('15 India default snapshot', s ->> 'country' = 'IN' and s ->> 'currency' = 'INR' and s ->> 'placeOfSupply' = 'intra' and s ->> 'taxName' = 'GST', s::text);
  perform pg_temp.res('16 functions definer + empty search_path', (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname in ('helm_quote_total','helm_quote_tax_snapshot','helm_org_country_sync') and p.prosecdef and p.proconfig @> array['search_path=""']) = 3);
  perform pg_temp.res('17 bad country rejected', (select count(*) from pg_constraint where conname = 'organizations_country_0089_chk') = 1);
end $$;

select name, result from _ct order by name;
select case when count(*) filter (where result <> 'PASS') = 0 then 'COUNTRY-TAX-0089: ALL PASS (' || count(*) || '/' || count(*) || ')'
            else 'COUNTRY-TAX-0089: ' || count(*) filter (where result <> 'PASS') || ' FAILED of ' || count(*) end as summary from _ct;
rollback;
