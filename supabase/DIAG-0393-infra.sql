-- DIAG-0393-infra.sql (Audit D, 18 Nov 2026). READ ONLY - changes nothing, safe on production and staging, safe to run twice.
-- Paste the whole file into the Supabase SQL editor and press Run. One result: section, item, value.
-- What it shows (for the infra plan in AUDIT-2026-11-18/D-data-infra.md):
--   A  which tables are in the supabase_realtime publication and what it publishes (insert / update / delete)
--   B  the Realtime replication slot (active, how much change log it holds back)
--   C  pg_stat_statements - when the counters were last reset, and the realtime.list_changes line (calls, mean ms)
--   D  database size and the 12 biggest tables
--   E  indexes never used since the statistics reset (not unique, not primary key), with their size
--   F  tables read by full scans many times (seq_scan) with more than 5,000 rows
--   G  tables that log the whole old row on every change (replica identity full)
--   H  whether the 0393 list indexes are there
-- No temp tables, no settings, no writes. pg_stat_statements is read through query_to_xml so a missing view never fails the run.
select section, item, value from (
  -- A
  select 'A publication' as section, p.pubname || ' publishes' as item,
         concat_ws(', ', case when p.pubinsert then 'insert' end, case when p.pubupdate then 'update' end,
                   case when p.pubdelete then 'delete' end, case when p.pubtruncate then 'truncate' end) as value, 1 as o
    from pg_publication p where p.pubname = 'supabase_realtime'
  union all
  select 'A publication', 'table ' || t.schemaname || '.' || t.tablename,
         'replica identity ' || case c.relreplident when 'f' then 'FULL' when 'd' then 'default' when 'n' then 'nothing' else 'index' end
         || ', ' || pg_size_pretty(pg_total_relation_size(c.oid)), 2
    from pg_publication_tables t join pg_class c on c.relname = t.tablename
    join pg_namespace n on n.oid = c.relnamespace and n.nspname = t.schemaname
   where t.pubname = 'supabase_realtime'
  union all
  -- B
  select 'B slot', s.slot_name, 'active ' || s.active || ', holds back '
         || coalesce(pg_size_pretty(pg_wal_lsn_diff(pg_current_wal_lsn(), s.restart_lsn)), 'n/a'), 3
    from pg_replication_slots s
  union all
  -- C
  select 'C pg_stat_statements', x.item, x.value, 4 from (
    select 'stats reset at' as item,
           (xpath('/table/row/v/text()', query_to_xml(
              case when to_regclass('extensions.pg_stat_statements_info') is not null
                   then 'select stats_reset::text as v from extensions.pg_stat_statements_info'
                   when to_regclass('public.pg_stat_statements_info') is not null
                   then 'select stats_reset::text as v from public.pg_stat_statements_info'
                   else 'select ''pg_stat_statements not readable here''::text as v' end, false, false, '')))[1]::text as value
    union all
    select 'realtime.list_changes calls | mean ms | total s',
           (xpath('/table/row/v/text()', query_to_xml(
              case when to_regclass('extensions.pg_stat_statements') is not null
                   then 'select string_agg(calls::text || '' | '' || round(mean_exec_time::numeric, 2) || '' | '' || round((total_exec_time / 1000)::numeric), ''; '') as v from extensions.pg_stat_statements where query ilike ''%list_changes%'''
                   else 'select ''pg_stat_statements not readable here''::text as v' end, false, false, '')))[1]::text
  ) x
  union all
  -- D
  select 'D size', 'database', pg_size_pretty(pg_database_size(current_database())), 5
  union all
  select 'D size', 'table ' || b.relname, b.sz, 6 from (
    select c.relname, pg_size_pretty(pg_total_relation_size(c.oid)) as sz from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'public' and c.relkind = 'r' order by pg_total_relation_size(c.oid) desc limit 12) b
  union all
  -- E
  select 'E unused index', u.relname || '.' || u.indexrelname, pg_size_pretty(pg_relation_size(u.indexrelid)) || ' (0 scans)', 7
    from pg_stat_user_indexes u join pg_index i on i.indexrelid = u.indexrelid
   where u.schemaname = 'public' and u.idx_scan = 0 and not i.indisunique and not i.indisprimary
  union all
  -- F
  select 'F full scans', s.relname, s.seq_scan || ' seq scans, ' || s.n_live_tup || ' rows, ' || coalesce(s.idx_scan, 0) || ' index scans', 8
    from pg_stat_user_tables s where s.schemaname = 'public' and s.n_live_tup > 5000 and s.seq_scan > 100
  union all
  -- G
  select 'G replica identity full', n.nspname || '.' || c.relname, 'every update logs the whole old row', 9
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'public' and c.relkind = 'r' and c.relreplident = 'f'
  union all
  -- H
  select 'H 0393 indexes', x.n, case when to_regclass('public.' || x.n) is null then 'missing' else 'present' end, 10
    from (values ('ix_leads_org_updated_0393'), ('ix_quotes_org_updated_0393')) x(n)
) r order by o, section, item;
