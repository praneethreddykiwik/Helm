-- 0090_portal_quote_currency.sql - CANONICAL forward-only. Client portal shows the quote's OWN money.
--
-- In plain words:
--   The signed-out client portal (public_get_portal) formatted amounts as Indian rupees because it
--   could not read the studio's settings. It now also returns the quote's own currency and tax
--   snapshot (stamped by 0089 from the quote's pricing), so a UAE / US studio's client sees AED / $.
--   Nothing else changes: the 0082 rule (never hand out brand.billing on the portal) is kept, the
--   token check is the same (the 0082 chain), and no table, row or grant is added or removed.
--   Additive + idempotent (create or replace only). Needs 0082 and 0089.
-- ============================================================================

do $$ begin
  if to_regprocedure('public.public_get_portal__pre0082(uuid)') is null then
    raise exception '0090: apply 0082_r4_sql_fixes.sql first (public_get_portal__pre0082 missing)';
  end if;
  if not exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'quotes' and column_name = 'tax_snapshot') then
    raise exception '0090: apply 0089_country_tax.sql first (quotes.tax_snapshot missing)';
  end if;
end $$;

create or replace function public.public_get_portal(p_token uuid)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
-- portal-brand-r4-0082: never hand out brand.billing on the signed-out portal
-- portal-currency-0090: + the quote's own currency / tax_snapshot (display only)
declare v jsonb; cur text; snap jsonb;
begin
  v := public.public_get_portal__pre0082(p_token);
  if jsonb_typeof(v -> 'studio') = 'object' and jsonb_typeof(v #> '{studio,brand}') = 'object' then
    v := jsonb_set(v, '{studio,brand}', (v #> '{studio,brand}') - 'billing');
  end if;
  select q.currency, q.tax_snapshot into cur, snap from public.quotes q where q.approval_token = p_token limit 1;
  if v is not null and jsonb_typeof(v) = 'object' then
    v := v || jsonb_build_object('currency', cur,
      'tax', case when jsonb_typeof(snap) = 'object'
                  then jsonb_strip_nulls(jsonb_build_object('country', snap -> 'country', 'currency', snap -> 'currency',
                         'taxName', snap -> 'taxName', 'rate', snap -> 'rate', 'exempt', snap -> 'exempt',
                         'inclusive', snap -> 'inclusive', 'region', snap -> 'region'))
                  else null end);
  end if;
  return v;
end $$;
revoke all on function public.public_get_portal(uuid) from public;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'anon') then execute 'grant execute on function public.public_get_portal(uuid) to anon'; end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then execute 'grant execute on function public.public_get_portal(uuid) to authenticated'; end if;
end $$;
