-- row-counts.sql - R238 backup helper: the exact row count of every table in public / auth / storage, one per line
-- ("schema.table|count"). A single read-only SELECT: creates nothing, changes nothing (run with
-- default_transaction_read_only=on by helm-offsite-backup.sh, and against the restored copy by RESTORE-DRILL.md).
select n.nspname || '.' || c.relname as tbl,
       (xpath('/row/c/text()', query_to_xml(format('select count(*) as c from %I.%I', n.nspname, c.relname), false, true, '')))[1]::text::bigint as n
  from pg_class c join pg_namespace n on n.oid = c.relnamespace
 where c.relkind in ('r', 'p') and n.nspname in ('public', 'auth', 'storage')
 order by 1;
