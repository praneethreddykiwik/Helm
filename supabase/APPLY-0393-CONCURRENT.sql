-- APPLY-0393-CONCURRENT (Audit D, optional). Only for big tables - for todays small tables APPLY-0393.sql alone is fine.
-- Builds the same 2 indexes WITHOUT holding writes, using create index concurrently.
-- HOW TO RUN - one line at a time. Select ONE create index line, press Run, wait for Success, then the next line.
-- Do not run the whole file at once. The SQL editor wraps several lines in one transaction and concurrently refuses to run inside one.
-- No begin and no commit in this file on purpose. Every line is safe to run twice. Nothing is dropped or deleted.
-- AFTER the last line run APPLY-0393.sql once. Its index lines are then no-ops and it shows the checks.
-- If a line fails half way, the check at the bottom shows that index with valid = false. Stop and ask before doing anything else.

create index concurrently if not exists ix_leads_org_updated_0393 on public.leads (org_id, updated_at desc, id desc);
create index concurrently if not exists ix_quotes_org_updated_0393 on public.quotes (org_id, updated_at desc, id desc);

-- CHECK (safe to run any time, reads only): every row should say valid = true
select c.relname as index_name, i.indisvalid as valid from pg_index i join pg_class c on c.oid = i.indexrelid
 where c.relname in ('ix_leads_org_updated_0393', 'ix_quotes_org_updated_0393') order by 1;
