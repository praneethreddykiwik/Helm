-- 0089_country_tax.sql - CANONICAL forward-only. Country tax for India / UAE / USA.
--
-- In plain words:
--   * Every studio can be in India (GST 18%, CGST+SGST or IGST), the UAE (VAT 5%, TRN)
--     or the USA (sales tax at the state's rate, optional EIN). The browser table lives in
--     public/country-profile.js (window.HelmCountry); the money is still ONE rate per quote
--     (pricing.gstPct) so the D8 server pricing authority stays the single source of truth.
--   * New money rule: a TAX-EXEMPT client (pricing.taxExempt = true, e.g. a US resale /
--     nonprofit certificate) is priced with no tax. helm_quote_total (0079 wrapper) now
--     prices such a quote at gstPct 0, exactly like store-api.js pricing._canon.
--   * New columns (all nullable, no defaults that change rows):
--       organizations.country / tax_region / tax_rate_override - mirrored from the studio's
--         billing details (brand.billing.country / state) whenever the brand is saved.
--       quotes.currency / tax_snapshot - stamped from the quote's OWN pricing whenever its
--         pricing is written, so a saved/sent/paid quote keeps the currency and tax it was
--         priced with even after the studio changes country.
--   * Nothing is backfilled, updated or deleted: existing rows stay byte-identical until the
--     next time the app itself writes them. India studios with no country = India, as before.
--   Additive + idempotent (add column if not exists, create or replace, drop trigger if exists).
--
-- Research (Oct 2026): India event management SAC 998596 at 18% (unchanged by the Sept 2025
-- GST rate rationalisation); UAE VAT 5%, 15-digit TRN, "Tax Invoice" wording, VAT shown in
-- AED (VAT Executive Regulation Art. 59); US state base sales-tax rates per Tax Foundation
-- 2026 table (AK/DE/MT/NH/OR = 0%); service taxability varies by state -> studio override.
-- ============================================================================

do $$ begin
  if to_regprocedure('public.helm_quote_total__pretax(jsonb)') is null then
    raise exception '0089: apply 0079_country_tax.sql first (helm_quote_total__pretax missing)';
  end if;
end $$;

-- 1) studio country / region / rate override (nullable = India / not set)
alter table public.organizations add column if not exists country text;
alter table public.organizations add column if not exists tax_region text;
alter table public.organizations add column if not exists tax_rate_override numeric;
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'organizations_country_0089_chk') then
    alter table public.organizations add constraint organizations_country_0089_chk
      check (country is null or country ~ '^[A-Z]{2}$') not valid;
  end if;
  if not exists (select 1 from pg_constraint where conname = 'organizations_tax_rate_0089_chk') then
    alter table public.organizations add constraint organizations_tax_rate_0089_chk
      check (tax_rate_override is null or (tax_rate_override >= 0 and tax_rate_override <= 100)) not valid;
  end if;
  if not exists (select 1 from pg_constraint where conname = 'organizations_tax_region_0089_chk') then
    alter table public.organizations add constraint organizations_tax_region_0089_chk
      check (tax_region is null or length(tax_region) <= 60) not valid;
  end if;
end $$;

create or replace function public.helm_org_country_sync()
returns trigger language plpgsql security definer set search_path = '' as $$
-- country-tax-0089: mirror brand.billing.country/state into the typed columns (never clears them)
declare b jsonb; c text; r text;
begin
  b := case when jsonb_typeof(new.brand) = 'object' then new.brand -> 'billing' else null end;
  if b is not null and jsonb_typeof(b) = 'object' then
    c := upper(btrim(coalesce(b ->> 'country', '')));
    if c ~ '^[A-Z]{2}$' then new.country := c; end if;
    r := left(btrim(coalesce(b ->> 'state', '')), 60);
    if r <> '' then new.tax_region := r; end if;
  end if;
  return new;
end $$;
revoke all on function public.helm_org_country_sync() from public;
drop trigger if exists zz_org_country_sync on public.organizations;
create trigger zz_org_country_sync before insert or update of brand on public.organizations
  for each row execute function public.helm_org_country_sync();

-- 2) per-quote currency + tax snapshot
alter table public.quotes add column if not exists currency text;
alter table public.quotes add column if not exists tax_snapshot jsonb;

create or replace function public.helm_quote_tax_snapshot()
returns trigger language plpgsql security definer set search_path = '' as $$
-- country-tax-0089: stamp currency + tax facts from THIS quote's pricing (runs after the total is enforced)
declare p jsonb; cc text; cur text; rate numeric; ex boolean; incl boolean;
begin
  p := new.pricing;
  if p is null or jsonb_typeof(p) <> 'object' then return new; end if;
  cc := upper(coalesce(nullif(btrim(p ->> 'taxCountry'), ''), 'IN'));
  if cc !~ '^[A-Z]{2}$' then cc := 'IN'; end if;
  cur := upper(coalesce(nullif(btrim(p ->> 'currency'), ''), case cc when 'AE' then 'AED' when 'US' then 'USD' else 'INR' end));
  if cur !~ '^[A-Z]{3}$' then cur := 'INR'; end if;
  ex := lower(coalesce(p ->> 'taxExempt', '')) = 'true';
  incl := lower(coalesce(p ->> 'taxInclusive', '')) = 'true';
  rate := case when ex then 0
               when coalesce(p ->> 'gstPct', '') ~ '^-?[0-9]+(\.[0-9]+)?$' then (p ->> 'gstPct')::numeric else null end;
  new.currency := cur;
  new.tax_snapshot := jsonb_strip_nulls(jsonb_build_object(
    'country', cc, 'currency', cur,
    'taxName', coalesce(nullif(left(p ->> 'taxName', 24), ''), case cc when 'AE' then 'VAT' when 'US' then 'Sales tax' when 'IN' then 'GST' else 'Tax' end),
    'rate', rate, 'exempt', ex, 'inclusive', incl,
    'region', nullif(left(coalesce(p ->> 'taxRegion', ''), 60), ''),
    'placeOfSupply', case when cc = 'IN' then coalesce(nullif(p ->> 'placeOfSupply', ''), 'intra') else null end,
    'total', case when jsonb_typeof(p -> 'total') = 'number' then p -> 'total' else null end,
    'v', 89));
  return new;
end $$;
revoke all on function public.helm_quote_tax_snapshot() from public;
drop trigger if exists zzz_quote_tax_snapshot on public.quotes;
create trigger zzz_quote_tax_snapshot before insert or update of pricing on public.quotes
  for each row execute function public.helm_quote_tax_snapshot();

-- 3) D8: authoritative total honours taxExempt (else EXACTLY the 0079 behaviour)
create or replace function public.helm_quote_total(p jsonb)
returns numeric language plpgsql immutable security definer set search_path = '' as $$
-- country-tax-0079: taxInclusive -> price at gstPct 0, else unchanged
-- country-tax-0089: taxExempt   -> price at gstPct 0 (no tax for an exempt client)
begin
  if p is not null and jsonb_typeof(p) = 'object'
     and (lower(coalesce(p ->> 'taxInclusive', '')) = 'true' or lower(coalesce(p ->> 'taxExempt', '')) = 'true') then
    return public.helm_quote_total__pretax(p || jsonb_build_object('gstPct', 0));
  end if;
  return public.helm_quote_total__pretax(p);
end $$;

revoke all on function public.helm_quote_total(jsonb) from public;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    revoke all on function public.helm_quote_total(jsonb) from anon;
    revoke all on function public.helm_org_country_sync() from anon;
    revoke all on function public.helm_quote_tax_snapshot() from anon;
  end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    revoke all on function public.helm_org_country_sync() from authenticated;
    revoke all on function public.helm_quote_tax_snapshot() from authenticated;
    grant execute on function public.helm_quote_total(jsonb) to authenticated;
  end if;
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    grant execute on function public.helm_quote_total(jsonb) to service_role;
  end if;
end $$;
