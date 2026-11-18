-- APPLY-0384-CONCURRENT (R206, optional). Only for big tables - for todays small tables APPLY-0384.sql alone is fine.
-- Builds the same 5 indexes WITHOUT holding writes, using create index concurrently.
-- HOW TO RUN - one line at a time. Select ONE create index line, press Run, wait for Success, then the next line.
-- Do not run the whole file at once. The SQL editor wraps several lines in one transaction and concurrently refuses to run inside one.
-- No begin and no commit in this file on purpose. Every line is safe to run twice. Nothing is dropped or deleted.
-- AFTER the last line run APPLY-0384.sql once. Its index lines are then no-ops, it re-issues event_timesheet and shows the checks.
-- If a line fails half way, the check at the bottom shows that index with valid = false. Stop and ask before doing anything else.

create index concurrently if not exists ix_audit_log_org_at_id_0384 on public.audit_log (org_id, at desc, id desc);
create index concurrently if not exists ix_event_tasks_quote_crew_0384 on public.event_tasks (quote_id, crew_id) where crew_id is not null;
create index concurrently if not exists ix_event_day_arrival_ref_0384 on public.event_day (quote_id, ref_id, updated_at desc) where kind = 'arrival';
create index concurrently if not exists ix_open_shift_claims_crew_0384 on public.open_shift_claims (crew_id);
create index concurrently if not exists ix_event_task_log_crew_0384 on public.event_task_log (crew_id) where crew_id is not null;

-- CHECK (safe to run any time, reads only): every row should say valid = true
select c.relname as index_name, i.indisvalid as valid from pg_index i join pg_class c on c.oid = i.indexrelid
 where c.relname in ('ix_audit_log_org_at_id_0384', 'ix_event_tasks_quote_crew_0384', 'ix_event_day_arrival_ref_0384',
                     'ix_open_shift_claims_crew_0384', 'ix_event_task_log_crew_0384') order by 1;
