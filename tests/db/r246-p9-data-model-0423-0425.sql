-- r246-p9-data-model-0423-0425.sql -- R246 fix plan Phase 9 (0423-0425):
--   Q-08 (0423) pricing-differential per country (IN / AE / US): the D8 pricing authority is unchanged (bodies + answers),
--        India quotes byte-identical with the new trigger on and off, a NEW subtotal-only quote with no rate gets UAE 5 /
--        US 0 / the studio override, an already-priced quote is never re-priced, the quote's own taxCountry wins;
--   Q-16 (0424) event_end_date: null = one day, rules (not before, <= 60 days, same day = one day), the last day follows the
--        first day, the ledger: one-day event = the kept body byte for byte, multi-day = planned crew wages x days;
--   DATA-01 (0425) NOT VALID length checks: new long text refused, at-limit saved, an old longer row stays and can still be
--        saved, a column with an old longer row gets no limit and is reported;
--   stored quotes byte-identical across APPLY-0423..0425 pasted twice. Fixture: studios A / B of 10-fixtures.sql.
-- Local disposable PG only. Fake data only. Rolled back.
\set ON_ERROR_STOP 0
set client_min_messages = warning;
begin;
create temp table _uf(name text, result text);
create temp table _kv(k text primary key, v text);

create or replace function pg_temp.su() returns void language plpgsql as $$
begin execute 'reset role'; perform set_config('request.jwt.claims', '', false); end $$;
create or replace function pg_temp.res(p_name text, p_ok boolean, p_detail text default '') returns void language plpgsql as $$
begin insert into _uf values (p_name, case when coalesce(p_ok, false) then 'PASS' else 'FAIL: '||coalesce(p_detail,'') end); end $$;
create or replace function pg_temp.try(p_sql text) returns text language plpgsql as $$
begin execute p_sql; return ''; exception when others then return sqlstate || ' ' || sqlerrm; end $$;
create or replace function pg_temp.put(k text, v text) returns void language sql as $$ insert into _kv values (k, v) on conflict (k) do update set v = excluded.v $$;
create or replace function pg_temp.get(k text) returns text language sql as $$ select v from _kv where _kv.k = $1 $$;
-- a fingerprint of every stored quote (all columns, in id order)
create or replace function pg_temp.quotes_md5() returns text language sql as $$
  select md5(coalesce(string_agg(to_jsonb(q)::text, '|' order by q.id), '')) from public.quotes q $$;
-- the D8 pricing functions' bodies
create or replace function pg_temp.d8_md5() returns text language sql as $$
  select md5(string_agg(p.proname || ':' || pg_get_functiondef(p.oid), '|' order by p.proname))
    from pg_proc p where p.pronamespace = 'public'::regnamespace
     and p.proname in ('helm_quote_total', 'helm_quote_total__pretax', 'helm_quote_total__base', 'helm_quote_total_canonical',
                       'enforce_pricing_total', 'helm_pricing_assert_sane', 'helm_quote_tax_snapshot') $$;

-- baseline BEFORE re-applying: stored quotes + D8 bodies
select pg_temp.put('q_md5_0', pg_temp.quotes_md5());
select pg_temp.put('d8_md5_0', pg_temp.d8_md5());

-- the migrations applied a second time on top of themselves (create or replace / if not exists only)
\i supabase/migrations/0423_r246_tax_default_country.sql
\i supabase/migrations/0424_r246_event_end_date.sql
\i supabase/migrations/0425_r246_text_len_checks.sql

do $$ begin
  perform pg_temp.res('01 re-applying 0423-0425 changes no stored quote and no D8 pricing body',
    pg_temp.quotes_md5() = pg_temp.get('q_md5_0') and pg_temp.d8_md5() = pg_temp.get('d8_md5_0'));
end $$;

-- ---- Q-08 (0423): pricing differential per country ------------------------------------------------------------------
-- three studios: IN (studio A, no country = India), AE (studio B set to AE), US (a new studio)
do $$ declare a uuid := 'a0000000-0000-4000-8000-000000000001'; b uuid := 'b0000000-0000-4000-8000-000000000001';
  u uuid := 'c4230000-0000-4000-8000-000000000001';
  p jsonb; c text; i int := 0; ok_in boolean := true; ok_all boolean := true; t_on numeric; t_off numeric; pr_on jsonb; pr_off jsonb; det text := '';
  corpus jsonb[] := array[
    '{"subtotal":1000,"discount":0}', '{"subtotal":99999,"discount":1234}', '{"subtotal":250000.5,"discount":0,"gstPct":null}',
    '{"subtotal":1000,"discount":0,"gstPct":18}', '{"subtotal":1000,"discount":0,"gstPct":5}', '{"subtotal":1000,"discount":0,"gstPct":0}',
    '{"gstPct":18,"chairs":100,"chairPrice":500,"guests":200,"platePrice":800}',
    '{"gstPct":18,"chairs":37,"chairPrice":149.5,"guests":121,"platePrice":777,"discount":333,"serviceChargePct":7.5}',
    '{"gstPct":5,"guests":400,"platePrice":425,"chairs":400,"chairPrice":15,"other":60000,"currency":"AED","taxCountry":"AE"}',
    '{"gstPct":18,"guests":10,"platePrice":100,"taxInclusive":true}', '{"gstPct":18,"guests":10,"platePrice":100,"taxExempt":true}',
    '{"gstPct":18,"chairs":10,"chairPrice":100,"coupon":{"kind":"percent","value":10},"discountPct":5}',
    '{"subtotal":1000,"discount":0,"taxInclusive":true}', '{"subtotal":5000,"discount":6000}'
  ]::jsonb[];
begin
  perform pg_temp.su();
  update public.organizations set country = 'AE' where id = b;
  insert into public.organizations(id, name, currency, timezone, brand, plan, created_at, country)
    values (u, 'Studio US', 'USD', 'America/New_York', '{}'::jsonb, 'pro', now(), 'US') on conflict (id) do update set country = 'US';
  foreach p in array corpus loop
    foreach c in array array[a::text, b::text, u::text] loop
      i := i + 1;
      perform set_config('helm.r423_gst_default', 'off', true);
      insert into public.quotes(id, code, title, status, pricing, org_id) values (('c4230000-0000-4000-8000-1' || lpad(i::text, 11, '0'))::uuid, 'DF-OFF-' || i, 'diff off', 'quote', p, c::uuid)
        returning (pricing ->> 'total')::numeric, pricing into t_off, pr_off;
      perform set_config('helm.r423_gst_default', '', true);
      insert into public.quotes(id, code, title, status, pricing, org_id) values (('c4230000-0000-4000-8000-2' || lpad(i::text, 11, '0'))::uuid, 'DF-ON-' || i, 'diff on', 'quote', p, c::uuid)
        returning (pricing ->> 'total')::numeric, pricing into t_on, pr_on;
      -- the pure function gives the same answer as the stored total with the switch off (D8 unchanged)
      if t_off is distinct from public.helm_quote_total(p) then ok_all := false; det := det || ' fn#' || i; end if;
      if c = a::text then
        if pr_on is distinct from pr_off or t_on is distinct from t_off then ok_in := false; det := det || ' IN#' || i || ':' || t_off || '/' || t_on; end if;
      elsif not ((p ? 'subtotal') and ((not p ? 'gstPct') or jsonb_typeof(p -> 'gstPct') = 'null')) then
        -- every payload that carries its own rate (or line items) prices the same in every country, on or off
        if pr_on is distinct from pr_off then ok_all := false; det := det || ' rate#' || i; end if;
      end if;
      perform pg_temp.put('t_on:' || c || ':' || p::text, t_on::text);
    end loop;
  end loop;
  perform pg_temp.res('02 IN: every corpus payload byte-identical (pricing + total) with 0423 on and off', ok_in, det);
  perform pg_temp.res('03 IN / AE / US: stored total = helm_quote_total (unchanged D8); payloads with their own rate identical in every country', ok_all, det);
  perform pg_temp.res('04 AE: a NEW subtotal-only quote with no rate is priced at VAT 5% (1000 -> 1050; 99999-1234 -> 103703)',
    pg_temp.get('t_on:' || b || ':{"discount": 0, "subtotal": 1000}') = '1050'
    and pg_temp.get('t_on:' || b || ':{"discount": 1234, "subtotal": 99999}') = '103703'
    and pg_temp.get('t_on:' || b || ':{"gstPct": null, "discount": 0, "subtotal": 250000.5}') = '262501',
    coalesce(pg_temp.get('t_on:' || b || ':{"discount": 0, "subtotal": 1000}'), 'null'));
  perform pg_temp.res('05 US: a NEW subtotal-only quote with no rate is priced at 0% (1000 -> 1000); India stays 18% (1180)',
    pg_temp.get('t_on:' || u || ':{"discount": 0, "subtotal": 1000}') = '1000'
    and pg_temp.get('t_on:' || a || ':{"discount": 0, "subtotal": 1000}') = '1180'
    and pg_temp.get('t_on:' || u || ':{"discount": 6000, "subtotal": 5000}') = '0',
    coalesce(pg_temp.get('t_on:' || u || ':{"discount": 0, "subtotal": 1000}'), 'null'));
  perform pg_temp.res('06 the snapshot (0089) records the rate the quote was priced at',
    (select (tax_snapshot ->> 'rate')::numeric from public.quotes where code = 'DF-ON-2') = 5
    and (select (tax_snapshot ->> 'rate')::numeric from public.quotes where code = 'DF-ON-3') = 0
    and (select tax_snapshot ->> 'rate' from public.quotes where code = 'DF-ON-1') is null);
exception when others then insert into _uf values ('02-06 differential', 'FAIL: '||sqlstate||' '||sqlerrm); end $$;

do $$ declare b uuid := 'b0000000-0000-4000-8000-000000000001'; a uuid := 'a0000000-0000-4000-8000-000000000001';
  q uuid := 'c4230000-0000-4000-8000-000000000101'; q2 uuid := 'c4230000-0000-4000-8000-000000000102'; t numeric;
begin
  perform pg_temp.su();
  -- an AE quote priced BEFORE 0423 (18%) is never re-priced by a later save of the same shape
  perform set_config('helm.r423_gst_default', 'off', true);
  insert into public.quotes(id, code, title, status, pricing, org_id) values (q, 'DF-OLD', 'old AE', 'quote', '{"subtotal":1000,"discount":0}', b);
  perform set_config('helm.r423_gst_default', '', true);
  update public.quotes set pricing = '{"subtotal":1000,"discount":0,"note":"re-saved"}' where id = q returning (pricing ->> 'total')::numeric into t;
  perform pg_temp.res('07 AE: an already-priced quote (18% before 0423) re-saved stays 18% (1180), no gstPct added',
    t = 1180 and not ((select pricing from public.quotes where id = q) ? 'gstPct'), t::text);
  -- a never-priced draft that gets its first price -> the country default
  insert into public.quotes(id, code, title, status, pricing, org_id) values (q2, 'DF-DRAFT', 'draft AE', 'quote', '{}', b);
  update public.quotes set pricing = '{"subtotal":2000,"discount":0}' where id = q2 returning (pricing ->> 'total')::numeric into t;
  perform pg_temp.res('08 AE: a draft priced for the first time gets 5% (2000 -> 2100)', t = 2100, t::text);
  -- the quote's own tax country wins over the studio's
  insert into public.quotes(code, title, status, pricing, org_id) values ('DF-OWN1', 'IN quote in AE studio', 'quote', '{"subtotal":1000,"discount":0,"taxCountry":"IN"}', b)
    returning (pricing ->> 'total')::numeric into t;
  perform pg_temp.res('09 the quote''s own taxCountry wins: IN quote in an AE studio = 18%', t = 1180, t::text);
  insert into public.quotes(code, title, status, pricing, org_id) values ('DF-OWN2', 'AE quote in IN studio', 'quote', '{"subtotal":1000,"discount":0,"taxCountry":"AE"}', a)
    returning (pricing ->> 'total')::numeric into t;
  perform pg_temp.res('10 an AE quote (taxCountry AE) in an India studio = 5%', t = 1050, t::text);
  -- the studio override (Settings) first; an India override never changes India's rule
  update public.organizations set tax_rate_override = 7.5 where id = b;
  insert into public.quotes(code, title, status, pricing, org_id) values ('DF-OVR', 'override', 'quote', '{"subtotal":1000,"discount":0}', b)
    returning (pricing ->> 'total')::numeric into t;
  update public.organizations set tax_rate_override = 5 where id = a;
  perform pg_temp.res('11 a UAE studio override 7.5% wins (1075)',
    t = 1075, t::text);
  insert into public.quotes(code, title, status, pricing, org_id) values ('DF-INOVR', 'IN override', 'quote', '{"subtotal":1000,"discount":0}', a)
    returning (pricing ->> 'total')::numeric into t;
  perform pg_temp.res('11b an India studio with a 5% override: a subtotal-only quote with no rate keeps 18% (1180)', t = 1180, t::text);
  -- line items without gstPct are still refused (0033), never defaulted
  perform pg_temp.res('12 line items without gstPct still refused (22023), not defaulted',
    pg_temp.try($q$insert into public.quotes(code, title, status, pricing, org_id) values ('DF-BAD', 'x', 'quote', '{"subtotal":1000,"chairs":5}', 'b0000000-0000-4000-8000-000000000001')$q$) like '22023%');
  perform pg_temp.res('13 the default helper is pure: AE 5 / US 0 / IN, GB, null = no default; trigger function closed to the app',
    public.helm_country_default_gst('AE') = 5 and public.helm_country_default_gst(' us ') = 0 and public.helm_country_default_gst('IN') is null
    and public.helm_country_default_gst('GB') is null and public.helm_country_default_gst('AE', 101) = 5
    and not has_function_privilege('authenticated', 'public._r423_tg_gst_default()', 'execute'));
exception when others then insert into _uf values ('07-13 rules', 'FAIL: '||sqlstate||' '||sqlerrm); end $$;

-- ---- Q-16 (0424): event_end_date ------------------------------------------------------------------------------------
do $$ declare a uuid := 'a0000000-0000-4000-8000-000000000001'; q uuid := 'c4240000-0000-4000-8000-000000000001'; e date; d date;
begin
  perform pg_temp.su();
  insert into public.quotes(id, code, title, status, pricing, org_id, event_date) values (q, 'MD-1', 'multi-day', 'quote', '{}', a, '2027-02-10');
  perform pg_temp.res('14 a new quote has no last day (one-day event)', (select event_end_date from public.quotes where id = q) is null);
  update public.quotes set event_end_date = '2027-02-12' where id = q;
  perform pg_temp.res('15 a last day after the first day is kept; helm_event_days = 3',
    (select event_end_date from public.quotes where id = q) = '2027-02-12'
    and (select public.helm_event_days(event_date, event_end_date) from public.quotes where id = q) = 3);
  perform pg_temp.res('16 a last day before the first day, or more than 60 days, is refused (23514)',
    pg_temp.try($q$update public.quotes set event_end_date = '2027-02-09' where id = 'c4240000-0000-4000-8000-000000000001'$q$) like '23514%'
    and pg_temp.try($q$update public.quotes set event_end_date = '2027-04-12' where id = 'c4240000-0000-4000-8000-000000000001'$q$) like '23514%');
  update public.quotes set event_date = '2027-03-01' where id = q;
  select event_date, event_end_date into d, e from public.quotes where id = q;
  perform pg_temp.res('17 moving the first day moves the last day with it (same length)', d = '2027-03-01' and e = '2027-03-03', d || ' .. ' || e);
  update public.quotes set event_end_date = event_date where id = q;
  perform pg_temp.res('18 last day = first day is stored as a one-day event (null)', (select event_end_date from public.quotes where id = q) is null);
  update public.quotes set event_end_date = '2027-03-02' where id = q;
  update public.quotes set event_date = null where id = q;
  perform pg_temp.res('19 clearing the first day clears the last day', (select event_end_date from public.quotes where id = q) is null);
  perform pg_temp.res('20 a last day without a first day is refused (23514)',
    pg_temp.try($q$update public.quotes set event_end_date = '2027-03-02' where id = 'c4240000-0000-4000-8000-000000000001'$q$) like '23514%');
exception when others then insert into _uf values ('14-20 end date', 'FAIL: '||sqlstate||' '||sqlerrm); end $$;

do $$ declare a uuid := 'a0000000-0000-4000-8000-000000000001'; q uuid := 'a0000000-0000-4000-8000-00000000da01'; c uuid; c2 uuid;
  v0 jsonb; v1 jsonb; l jsonb; l2 jsonb;
begin
  perform pg_temp.su();
  update public.quotes set status = 'confirmed', lifecycle_stage = 'confirmed', event_date = '2027-05-10', event_end_date = null where id = q;
  insert into public.crew_members(name, phone, day_rate, org_id) values ('MD Ravi', '+919800042401', 1200, a) returning id into c;
  insert into public.event_tasks(quote_id, category, title, crew_id, assignee_name, assignee_phone, status, org_id)
    values (q, 'Setup', 'Load in', c, 'MD Ravi', '+919800042401', 'accepted', a);
  insert into public.crew_members(name, phone, day_rate, org_id) values ('MD Sita', '+919800042402', 1500, a) returning id into c2;
  insert into public.event_tasks(quote_id, category, title, crew_id, assignee_name, assignee_phone, status, org_id)
    values (q, 'Setup', 'Desk', c2, 'MD Sita', '+919800042402', 'assigned', a);
  v0 := public._r21_cost_lines(q, a);
  perform pg_temp.res('21 one-day event: the ledger = the kept body (_r21_cost_lines__pre0424) byte for byte',
    v0 is not distinct from public._r21_cost_lines__pre0424(q, a) and v0::text = public._r21_cost_lines__pre0424(q, a)::text);
  update public.quotes set event_end_date = '2027-05-12' where id = q;
  v1 := public._r21_cost_lines(q, a);
  select x into l from jsonb_array_elements(v1) x where x ->> 'crew_id' = c::text;
  select x into l2 from jsonb_array_elements(v1) x where x ->> 'crew_id' = c2::text;
  perform pg_temp.res('22 3-day event: planned wage = day rate x 3 (accepted: estimated, committed, forecast; assigned: estimated, forecast)',
    (l ->> 'estimated')::numeric = 3600 and (l ->> 'c_est')::numeric = 3600 and (l ->> 'committed')::numeric = 3600 and (l ->> 'c_com')::numeric = 3600
    and (l ->> 'c_fc')::numeric = 3600 and (l ->> 'event_days')::int = 3 and (l ->> 'day_rate')::numeric = 1200
    and (l2 ->> 'estimated')::numeric = 4500 and (l2 ->> 'c_com')::numeric = 0 and l2 -> 'committed' = 'null'::jsonb and (l2 ->> 'c_fc')::numeric = 4500,
    coalesce(l::text, 'no line') || ' / ' || coalesce(l2::text, 'no line'));
  perform pg_temp.res('23 3-day event: every non-crew line unchanged, actual unchanged',
    (select count(*) from jsonb_array_elements(v1) x where x ->> 'source' <> 'crew') = (select count(*) from jsonb_array_elements(v0) x where x ->> 'source' <> 'crew')
    and (select coalesce(jsonb_agg(x order by x::text), '[]') from jsonb_array_elements(v1) x where x ->> 'source' <> 'crew')
        = (select coalesce(jsonb_agg(x order by x::text), '[]') from jsonb_array_elements(v0) x where x ->> 'source' <> 'crew')
    and l -> 'actual' = (select x -> 'actual' from jsonb_array_elements(v0) x where x ->> 'crew_id' = c::text));
  -- a checked-in actual stays the real days
  insert into public.event_day(quote_id, org_id, kind, ref_id, who, status) values (q, a, 'arrival', c, 'MD Ravi', 'no_show');
  select x into l from jsonb_array_elements(public._r21_cost_lines(q, a)) x where x ->> 'crew_id' = c::text;
  perform pg_temp.res('24 a no-show keeps its forecast at 0 on a multi-day event', (l ->> 'c_fc')::numeric = 0, l::text);
  perform pg_temp.res('25 ledger wrapper + kept body closed to the app (service role only)',
    not has_function_privilege('authenticated', 'public._r21_cost_lines(uuid,uuid)', 'execute')
    and not has_function_privilege('authenticated', 'public._r21_cost_lines__pre0424(uuid,uuid)', 'execute')
    and has_function_privilege('service_role', 'public._r21_cost_lines(uuid,uuid)', 'execute'));
exception when others then insert into _uf values ('21-25 ledger', 'FAIL: '||sqlstate||' '||sqlerrm); end $$;

-- ---- DATA-01 (0425): NOT VALID length checks ------------------------------------------------------------------------
do $$ declare a uuid := 'a0000000-0000-4000-8000-000000000001'; q uuid := 'a0000000-0000-4000-8000-00000000da01'; id1 uuid; r record;
begin
  perform pg_temp.su();
  perform pg_temp.res('26 every 0425 limit is NOT VALID, all 37 listed columns have one on this fresh database',
    not exists (select 1 from pg_constraint where conname like '%\_len425' and convalidated)
    and (select count(*) from public.r425_text_len_report() where limit_on) = 37 and (select count(*) from public._r425_text_limits()) = 37);
  perform pg_temp.res('27 too long is refused (23514), exactly at the limit is saved',
    pg_temp.try(format($q$insert into public.event_checklist(quote_id, section, title, detail, org_id) values (%L, 'logistics', 'long note', repeat('x', 8001), %L)$q$, q, a)) like '23514%'
    and pg_temp.try(format($q$insert into public.event_checklist(quote_id, section, title, detail, org_id) values (%L, 'logistics', 'at limit', repeat('x', 8000), %L)$q$, q, a)) = ''
    and pg_temp.try(format($q$update public.organizations set name = repeat('n', 201) where id = %L$q$, a)) like '23514%'
    and pg_temp.try(format($q$update public.quotes set event_type = repeat('t', 121) where id = %L$q$, q)) like '23514%');
  -- an OLD longer row (stored before the limit): drop the limit (test only, rolled back), store it, re-run 0425
  alter table public.event_checklist drop constraint event_checklist_detail_len425;
  insert into public.event_checklist(quote_id, section, title, detail, org_id) values (q, 'logistics', 'old', repeat('d', 9000), a) returning id into id1;
  perform pg_temp.put('ck_old', id1::text);
exception when others then insert into _uf values ('26-27 limits', 'FAIL: '||sqlstate||' '||sqlerrm); end $$;

\i supabase/migrations/0425_r246_text_len_checks.sql

do $$ declare r record; id1 uuid := pg_temp.get('ck_old')::uuid;
begin
  perform pg_temp.su();
  select * into r from public.r425_text_len_report() x where x.tbl = 'event_checklist' and x.col = 'detail';
  perform pg_temp.res('28 a column with an old longer row gets NO limit and is reported (rows_longer 1); the row is not cut',
    not r.limit_on and r.rows_longer = 1 and (select char_length(detail) from public.event_checklist where id = id1) = 9000, row_to_json(r)::text);
  perform pg_temp.res('29 that old row can still be saved (other column changed)',
    pg_temp.try(format($q$update public.event_checklist set title = 'old, renamed' where id = %L$q$, id1)) = '');
  perform pg_temp.res('30 every other column kept its limit (36 on)', (select count(*) from public.r425_text_len_report() where limit_on) = 36);
  perform pg_temp.res('31 the report is owner-only (anon / signed-in cannot call it); counts only',
    not has_function_privilege('authenticated', 'public.r425_text_len_report()', 'execute')
    and not has_function_privilege('anon', 'public.r425_text_len_report()', 'execute'));
exception when others then insert into _uf values ('28-31 old rows', 'FAIL: '||sqlstate||' '||sqlerrm); end $$;

select name, result from _uf order by name;
select case when count(*) filter (where result <> 'PASS') = 0 then 'R246-P9-DATA-0423-0425: ALL PASS (' || count(*) || '/' || count(*) || ')'
            else 'R246-P9-DATA-0423-0425: ' || count(*) filter (where result <> 'PASS') || ' FAILED of ' || count(*) end as summary from _uf;
rollback;
