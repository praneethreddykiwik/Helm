-- APPLY-0423 (R246 fix plan Phase 9, Q-08: a quote with no tax rate gets its studio's country rate, not always 18%).
-- Run on STAGING first, then production. Safe to run twice. Needs 0001 + 0089 - already on both.
-- What it does:
--   * A NEW quote saved in the old subtotal-only shape WITHOUT a tax rate now gets the studio's country rate: UAE 5%, US 0%
--     (or the studio's own rate override). India, no country and other countries keep 18% exactly as before.
--   * The server pricing authority (helm_quote_total and the functions under it) is NOT changed. Stored quotes are never
--     re-priced or re-saved; a later save of an already-priced quote keeps its old rate.
-- Nothing is deleted. One small function, one trigger on quotes. No row is changed by this file.
-- It waits at most 5 seconds for a table lock (then stops with an error and changes nothing - just run it again later).
-- Paste the whole file into the Supabase SQL editor and press Run. The last result lists checks - every ok must be true.
begin;
set local lock_timeout = '5s';
set local statement_timeout = '5min';
-- 0423_r246_tax_default_country.sql - CANONICAL forward-only. R246 (fix plan Phase 9, owner approved 20 Nov 2026; Q-08).
-- REQUIRES 0001 (helm_quote_total), 0089 (organizations.country / tax_rate_override). Nothing else.
--
-- In plain words:
--   A quote saved in the old "subtotal" shape WITHOUT a tax rate (pricing.gstPct missing) was always priced at 18%,
--   even for a UAE studio (VAT 5%) or a US studio. From now on such a NEW quote gets its studio's country rate:
--     UAE 5%, US 0% (the studio sets its state rate itself), or the studio's own rate override (Settings) when it has one.
--   India, a studio with no country and every other country keep the old 18% exactly - nothing changes for them.
--   How: a BEFORE trigger on quotes (ab_r423_gst_default) writes the default rate into the NEW quote's pricing (gstPct)
--   before the D8 server pricing authority prices it. It acts ONLY when
--     * the pricing is the subtotal-only shape (no line items - a line-item quote must carry gstPct, 0033 refuses it), and
--     * gstPct is missing (absent or null), and
--     * the quote is NEW: an insert, or an update of a quote that was never priced (its stored pricing has no total).
--   The country is the quote's OWN tax country (pricing.taxCountry) when it carries one, else the studio's country.
--
-- PRICING AUTHORITY (D8) UNTOUCHED: helm_quote_total, helm_quote_total__pretax, helm_quote_total__base and
--   helm_quote_total_canonical are NOT re-issued - same bodies, same answers for every payload. A stored (priced) quote is
--   never re-priced or re-saved by this file; a later save of an already-priced quote keeps its old rule (18% stays 18%).
--   Single-rate India quotes give byte-identical totals (the trigger returns the row unchanged for India).
--
-- ZERO DATA LOSS: additive + idempotent. One pure function, one trigger function, one trigger. No table, column or row is
-- created, changed or deleted by this file. Test switch: set helm.r423_gst_default = 'off' (session) = old behaviour.
-- ============================================================================

do $$ begin
  if to_regprocedure('public.helm_quote_total(jsonb)') is null then
    raise exception '0423: helm_quote_total(jsonb) is not installed (apply 0001 first)';
  end if;
  if not exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'organizations' and column_name = 'country') then
    raise exception '0423: organizations.country is missing (apply 0089 first)';
  end if;
end $$;

-- the default tax rate of a country (pure). null = "no country default here, keep the old rule".
create or replace function public.helm_country_default_gst(p_country text, p_override numeric default null)
returns numeric language sql immutable set search_path = '' as $$
  -- r246-0423: UAE 5, US 0 (state rate is the studio's own), a valid studio override (0..100) first; India / others -> null
  select case
    when upper(coalesce(btrim(p_country), '')) not in ('AE', 'US') then null
    when p_override is not null and p_override >= 0 and p_override <= 100 then p_override
    when upper(btrim(p_country)) = 'AE' then 5::numeric
    else 0::numeric end;
$$;

create or replace function public._r423_tg_gst_default()
returns trigger language plpgsql security definer set search_path = '' as $$
-- r246-0423: a NEW subtotal-only quote with no gstPct gets its country's default rate (UAE 5 / US 0 / override); India unchanged
declare p jsonb := new.pricing; cc text; ov numeric; r numeric;
begin
  if coalesce(current_setting('helm.r423_gst_default', true), '') = 'off' then return new; end if;
  if p is null or jsonb_typeof(p) <> 'object' or not (p ? 'subtotal') then return new; end if;
  if (p ? 'gstPct') and jsonb_typeof(p -> 'gstPct') <> 'null' then return new; end if;
  if p ? 'chairs' or p ? 'chairPrice' or p ? 'guests' or p ? 'platePrice' or p ? 'other' or p ? 'catering' then return new; end if;
  -- only a NEW quote: an insert, or a quote whose stored pricing was never priced (no total yet)
  if tg_op = 'UPDATE' and old.pricing is not null and jsonb_typeof(old.pricing) = 'object' and (old.pricing ? 'total') then
    return new;
  end if;
  cc := upper(btrim(coalesce(p ->> 'taxCountry', '')));
  if cc !~ '^[A-Z]{2}$' then
    select upper(btrim(coalesce(o.country, ''))), o.tax_rate_override into cc, ov from public.organizations o where o.id = new.org_id;
  elsif new.org_id is not null then
    select o.tax_rate_override into ov from public.organizations o
     where o.id = new.org_id and upper(btrim(coalesce(o.country, ''))) = cc;
  end if;
  r := public.helm_country_default_gst(cc, ov);
  if r is null then return new; end if;   -- India / no country / other countries: exactly the old rule
  new.pricing := p || jsonb_build_object('gstPct', r);
  return new;
end $$;

drop trigger if exists ab_r423_gst_default on public.quotes;
create trigger ab_r423_gst_default before insert or update of pricing on public.quotes
  for each row execute function public._r423_tg_gst_default();

revoke all on function public._r423_tg_gst_default() from public;
revoke all on function public.helm_country_default_gst(text, numeric) from public;
do $$ declare r text; begin
  foreach r in array array['anon', 'authenticated'] loop
    if exists (select 1 from pg_roles where rolname = r) then
      execute format('revoke all on function public._r423_tg_gst_default() from %I', r);
    end if;
  end loop;
  if exists (select 1 from pg_roles where rolname = 'anon') then
    execute 'revoke all on function public.helm_country_default_gst(text, numeric) from anon';
  end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    execute 'grant execute on function public.helm_country_default_gst(text, numeric) to authenticated';
  end if;
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    execute 'grant execute on function public.helm_country_default_gst(text, numeric) to service_role';
  end if;
end $$;

do $$ begin
  if to_regclass('public.helm_schema_markers') is not null then
    insert into public.helm_schema_markers(num, name) values (423, '0423_r246_tax_default_country') on conflict (num) do nothing;
  end if;
end $$;

-- ---- checks (every ok must be true) --------------------------------------------------------------------------------
select item, ok, note from (values
  ('01 country default rate: UAE 5, US 0, override first, India / none / other = old rule',
     public.helm_country_default_gst('AE') = 5 and public.helm_country_default_gst('US') = 0 and public.helm_country_default_gst('ae', 7.5) = 7.5
     and public.helm_country_default_gst('IN') is null and public.helm_country_default_gst(null) is null and public.helm_country_default_gst('GB') is null, ''),
  ('02 trigger ab_r423_gst_default on quotes, before the pricing total triggers',
     exists (select 1 from pg_trigger t where t.tgname = 'ab_r423_gst_default' and t.tgrelid = 'public.quotes'::regclass)
     and 'ab_r423_gst_default' < 'quotes_enforce_pricing_total' and 'ab_r423_gst_default' < 'zz_enforce_pricing_total', ''),
  ('03 D8 pricing authority unchanged: subtotal 1000 no rate = 1180 (India 18%), canonical quote = same rupee',
     public.helm_quote_total('{"subtotal":1000,"discount":0}'::jsonb) = 1180
     and public.helm_quote_total('{"gstPct":18,"chairs":100,"chairPrice":500,"guests":200,"platePrice":800}'::jsonb) = 247800
     and public.helm_quote_total('{"subtotal":1000,"discount":0,"gstPct":5}'::jsonb) = 1050, ''),
  ('04 the trigger function is not callable from the app',
     not has_function_privilege('authenticated', 'public._r423_tg_gst_default()', 'execute')
     and not has_function_privilege('anon', 'public._r423_tg_gst_default()', 'execute'), ''),
  ('05 stored quotes: none changed by this file (report)', true,
     (select count(*) from public.quotes)::text || ' quote(s) on file, untouched')
) v(item, ok, note) order by item;
commit;
