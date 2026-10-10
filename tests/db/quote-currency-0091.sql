-- quote-currency-0091.sql -- 0091 fill-only backfill: a quote with no currency becomes INR (its pricing's own
-- country when it has one) with a tax_snapshot from its own pricing; pricing/totals/status untouched; rows that
-- already have a currency untouched; a second run changes nothing. Fixture data, rolled back.
\set ON_ERROR_STOP 0
set client_min_messages = warning;
begin;
create temp table _qc(name text, result text);
create or replace function pg_temp.res(p_name text, p_ok boolean, p_detail text default '') returns void language plpgsql as $$
begin insert into _qc values (p_name, case when coalesce(p_ok, false) then 'PASS' else 'FAIL: '||coalesce(p_detail,'') end); end $$;
-- three fixture-org quotes in the pre-0089 shape (triggers off only for this setup, like the other suites)
set local session_replication_role = replica;
insert into public.quotes(id, org_id, code, title, status, pricing, currency, tax_snapshot)
select v.id::uuid, (select org_id from public.quotes where id = 'a0000000-0000-4000-8000-00000000da01'), v.code, 't', 'confirmed', v.p::jsonb, v.cur, v.snap::jsonb
from (values
  ('a0000000-0000-4000-8000-0000000091a1', '91-A1', '{"gstPct":18,"chairs":700,"chairPrice":200,"total":306800}', null, null),
  ('a0000000-0000-4000-8000-0000000091a2', '91-A2', '{"gstPct":5,"chairs":10,"chairPrice":100,"total":1050,"taxCountry":"AE","currency":"AED","taxName":"VAT"}', null, null),
  ('a0000000-0000-4000-8000-0000000091a3', '91-A3', '{"gstPct":5,"chairs":10,"chairPrice":100,"total":1050,"taxCountry":"AE"}', 'AED', '{"country":"AE","v":89}')
) v(id, code, p, cur, snap);
set local session_replication_role = origin;
create temp table _before as select id, pricing, status, updated_at from public.quotes where code like '91-A%';
\i supabase/migrations/0091_quote_currency_backfill.sql
do $$ declare a record; b record; c record; begin
  select currency, tax_snapshot s into a from public.quotes where code = '91-A1';
  perform pg_temp.res('01 old quote -> INR', a.currency = 'INR', coalesce(a.currency,'null'));
  perform pg_temp.res('02 snapshot IN/GST/18/total', a.s ->> 'country' = 'IN' and a.s ->> 'taxName' = 'GST' and (a.s ->> 'rate')::numeric = 18 and (a.s ->> 'total')::numeric = 306800 and a.s ->> 'backfill' = 'true', a.s::text);
  select currency, tax_snapshot s into b from public.quotes where code = '91-A2';
  perform pg_temp.res('03 pricing with own country keeps it', b.currency = 'AED' and b.s ->> 'country' = 'AE', b.s::text);
  select currency, tax_snapshot s into c from public.quotes where code = '91-A3';
  perform pg_temp.res('04 existing currency/snapshot untouched', c.currency = 'AED' and c.s = '{"country":"AE","v":89}'::jsonb, c.s::text);
  perform pg_temp.res('05 pricing/status/updated_at untouched', not exists (select 1 from public.quotes q join _before o using (id)
    where q.pricing is distinct from o.pricing or q.status is distinct from o.status or q.updated_at is distinct from o.updated_at));
end $$;
create temp table _snap1 as select id, currency, tax_snapshot from public.quotes where code like '91-A%';
\i supabase/migrations/0091_quote_currency_backfill.sql
select pg_temp.res('06 second run changes nothing', not exists (select 1 from public.quotes q join _snap1 s using (id) where q.currency is distinct from s.currency or q.tax_snapshot is distinct from s.tax_snapshot));
select name, result from _qc order by name;
select case when count(*) filter (where result <> 'PASS') = 0 then 'QUOTE-CURRENCY-0091: ALL PASS (' || count(*) || '/' || count(*) || ')'
            else 'QUOTE-CURRENCY-0091: ' || count(*) filter (where result <> 'PASS') || ' FAILED of ' || count(*) end as summary from _qc;
rollback;
