-- APPLY-0393 (Audit D 18 Nov 2026: Leads and Quotes list speed). Run on STAGING first, then production. Safe to run twice.
-- Two additive indexes so the newest-first Leads and Quotes lists read only the rows of the page inside one studio.
-- Nothing else is created, changed, dropped or deleted. Who may see what is unchanged.
-- Big leads or quotes tables (hundreds of thousands of rows)? Run APPLY-0393-CONCURRENT.sql first, one line at a time, then this file.
-- Paste the whole file into the Supabase SQL editor and press Run. The last result lists checks - every ok must be true.
begin;
-- 0393_audit_d_list_indexes.sql - Audit D (data + infra, 18 Nov 2026): two list indexes. Forward-only, additive, safe to
-- run twice. ASCII only.
-- REQUIRES public.leads and public.quotes (base schema) with org_id, updated_at and id.
--
-- In plain words:
--   The Leads page and the leads list ask for the newest leads first (order by updated_at desc, id desc). Row security
--   adds the studio filter (org_id = the studio of the caller), but the database only learns WHICH studio when the
--   query runs, so it plans with the index on updated_at that holds the leads of EVERY studio and then skips the rows
--   of other studios one by one. For a small studio next to busy ones that means walking almost the whole table: on a
--   local copy with 163,000 leads over 400 studios the first page of a studio with one lead read and threw away
--   163,017 rows (23 ms warm, 638 ms cold). The cost grows with the number of leads of ALL studios together.
--   An index on (org_id, updated_at desc, id desc) lets the database jump to the studio and read only the 26 rows of
--   the page (about 1 - 4 ms on the same copy, whatever the size of other studios).
--   The quotes list uses the same order. Today it reads every quote of the studio and sorts them (13 ms for a studio
--   with 2,000 quotes) - the same kind of index on quotes reads only the page.
--
-- ZERO DATA LOSS: two create index if not exists lines. No table, column, row, policy, grant, function or trigger is
-- created, changed or deleted. Existing indexes are kept (leads_org_idx, leads_updated_idx, quotes_org_idx and
-- quotes_updated_idx stay - other queries may use them).
-- Lock: create index (not concurrently) blocks writes to leads / quotes while it builds. On todays prod tables (a few
--   thousand rows) that is well under a second. For big tables use APPLY-0393-CONCURRENT.sql first, one line at a time.
-- Rollback (only if ever needed): drop index public.ix_leads_org_updated_0393 and drop index public.ix_quotes_org_updated_0393.

-- ---- 0) preflight ------------------------------------------------------------------------------------------------------
do $$ begin
  if to_regclass('public.leads') is null or to_regclass('public.quotes') is null then
    raise exception 'STOP 0393: public.leads / public.quotes missing - this is not a Helm database'; end if;
  if (select count(*) from information_schema.columns where table_schema = 'public' and table_name = 'leads'
        and column_name in ('org_id', 'updated_at', 'id')) <> 3
     or (select count(*) from information_schema.columns where table_schema = 'public' and table_name = 'quotes'
        and column_name in ('org_id', 'updated_at', 'id')) <> 3 then
    raise exception 'STOP 0393: leads / quotes lack org_id, updated_at or id'; end if;
end $$;

-- ---- 1) list indexes (newest first inside one studio) -------------------------------------------------------------------
create index if not exists ix_leads_org_updated_0393 on public.leads (org_id, updated_at desc, id desc);
create index if not exists ix_quotes_org_updated_0393 on public.quotes (org_id, updated_at desc, id desc);

select item, ok from (values
  ('01 leads list index exists and is valid',
     exists (select 1 from pg_index i join pg_class c on c.oid = i.indexrelid join pg_namespace n on n.oid = c.relnamespace
              where n.nspname = 'public' and c.relname = 'ix_leads_org_updated_0393' and i.indisvalid
                and i.indrelid = 'public.leads'::regclass
                and pg_get_indexdef(i.indexrelid) like '%(org_id, updated_at DESC, id DESC)')),
  ('02 quotes list index exists and is valid',
     exists (select 1 from pg_index i join pg_class c on c.oid = i.indexrelid join pg_namespace n on n.oid = c.relnamespace
              where n.nspname = 'public' and c.relname = 'ix_quotes_org_updated_0393' and i.indisvalid
                and i.indrelid = 'public.quotes'::regclass
                and pg_get_indexdef(i.indexrelid) like '%(org_id, updated_at DESC, id DESC)')),
  ('03 the older leads and quotes indexes are kept',
     to_regclass('public.leads_org_idx') is not null and to_regclass('public.leads_updated_idx') is not null
     and to_regclass('public.quotes_org_idx') is not null and to_regclass('public.quotes_updated_idx') is not null),
  ('04 row security still on for leads and quotes',
     (select bool_and(c.relrowsecurity) from pg_class c where c.oid in ('public.leads'::regclass, 'public.quotes'::regclass)))
) v(item, ok) order by item;
commit;
