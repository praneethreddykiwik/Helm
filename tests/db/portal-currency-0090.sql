-- portal-currency-0090.sql -- 0090: the client portal returns the quote's own currency + tax snapshot,
-- still strips brand.billing (0082), and an India quote stays INR. Rolled back.
\set ON_ERROR_STOP 0
set client_min_messages = warning;
begin;
create temp table _ct(name text, result text);
create or replace function pg_temp.res(p_name text, p_ok boolean, p_detail text default '') returns void language plpgsql as $$
begin insert into _ct values (p_name, case when coalesce(p_ok, false) then 'PASS' else 'FAIL: '||coalesce(p_detail,'') end); end $$;

do $$ declare qa uuid := 'a0000000-0000-4000-8000-00000000da01'; tok uuid := gen_random_uuid(); v jsonb;
begin
  execute 'reset role';
  update public.organizations set brand = coalesce(brand,'{}'::jsonb) || '{"billing":{"country":"AE","legal_name":"X LLC"}}'::jsonb
    where id = (select org_id from public.quotes where id = qa);
  update public.quotes set approval_token = tok, pricing = '{"gstPct":5,"chairs":10,"chairPrice":500,"taxCountry":"AE","currency":"AED","total":1}'::jsonb where id = qa;
  v := public.public_get_portal(tok);
  perform pg_temp.res('01 portal returns quote currency', v ->> 'currency' = 'AED', coalesce(v::text,'null'));
  perform pg_temp.res('02 portal returns tax snapshot', v #>> '{tax,country}' = 'AE' and v #>> '{tax,taxName}' = 'VAT' and (v #>> '{tax,rate}')::numeric = 5, coalesce(v -> 'tax','null')::text);
  perform pg_temp.res('03 billing still stripped (0082)', not ((v #> '{studio,brand}') ? 'billing'), coalesce(v -> 'studio','null')::text);
  perform pg_temp.res('04 total is the server total', (v ->> 'total')::numeric = 5250, v ->> 'total');
  update public.quotes set pricing = '{"gstPct":18,"chairs":10,"chairPrice":500}'::jsonb where id = qa;
  v := public.public_get_portal(tok);
  perform pg_temp.res('05 India quote stays INR', v ->> 'currency' = 'INR' and v #>> '{tax,country}' = 'IN', coalesce(v::text,'null'));
  perform pg_temp.res('06 anon can execute, definer + empty search_path', has_function_privilege('anon', 'public.public_get_portal(uuid)', 'execute')
    and (select p.prosecdef and p.proconfig @> array['search_path=""'] from pg_proc p where p.oid = 'public.public_get_portal(uuid)'::regprocedure));
  begin perform public.public_get_portal(gen_random_uuid()); perform pg_temp.res('07 bad token still rejected', false, 'no error');
  exception when others then perform pg_temp.res('07 bad token still rejected', true); end;
end $$;

select name, result from _ct order by name;
select case when count(*) filter (where result <> 'PASS') = 0 then 'PORTAL-CURRENCY-0090: ALL PASS (' || count(*) || '/' || count(*) || ')'
            else 'PORTAL-CURRENCY-0090: ' || count(*) filter (where result <> 'PASS') || ' FAILED of ' || count(*) end as summary from _ct;
rollback;
