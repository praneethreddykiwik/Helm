-- DIAG-R249-db-load.sql (R249, 23 Nov 2026). READ ONLY - changes nothing, safe on production and staging, safe to run twice.
-- Paste the whole file into the Supabase SQL editor and press Run. ONE result: section, item, value (sorted).
-- What it shows (for the R249 PR "Event Workspace speed + database load"):
--   A  Realtime: which tables are published, whether the app listens to each (from the code), and live listeners per table now
--   B  cron jobs: name, schedule, on/off, the command (long keys shown as [hidden]), and the last 24 h of runs (count, mean, slowest, failed)
--   C  pg_stat_statements: since when it counts, what it counts (track), the 25 statements with the most total time, the
--      PostgREST schema-cache family (one set per PostgREST start / reload) per hour, and which function each "p_limit" call is
--   D  PostgREST reloads vs restarts: when the database started, when each role's connections started (authenticator = PostgREST),
--      the event triggers that send "reload schema"
--   E  how many studios the per-studio jobs walk (trial / sample studios included) and how many were active in 7 days
-- No temp tables, no settings, no writes. Views that may be missing (cron, realtime.subscription, pg_stat_statements) are read
-- through query_to_xml behind a check, so a missing one never stops the run.
select section, item, value from (
  -- A) Realtime publication ------------------------------------------------------------------------------------------------------
  select 'A realtime' as section, '0 publication publishes' as item,
         concat_ws(', ', case when p.pubinsert then 'insert' end, case when p.pubupdate then 'update' end,
                   case when p.pubdelete then 'delete' end, case when p.pubtruncate then 'truncate' end,
                   case when p.puballtables then 'ALL TABLES' end) as value
    from pg_publication p where p.pubname = 'supabase_realtime'
  union all
  select 'A realtime', '1 table ' || t.schemaname || '.' || t.tablename,
         case when t.schemaname = 'public' and t.tablename in ('leads', 'chat_messages', 'chat_conversations', 'quote_live_signals')
                then 'the app listens (store-api.js)'
              when t.schemaname = 'public' and t.tablename in ('quote_versions', 'quotation_versions')
                then 'pages opened before 0427 + the fallback when the 0427 check fails - keep for now'
              when t.schemaname = 'public' and t.tablename = 'chat_reactions' then 'nobody listens (left in 0156) - APPLY-0433 takes it out'
              else 'NOT in Helm code - added by hand? (owner decision)' end
         || ' | rows written: ' || coalesce(s.n_tup_ins + s.n_tup_upd + s.n_tup_del, 0)
         || ' | size ' || pg_size_pretty(pg_total_relation_size(format('%I.%I', t.schemaname, t.tablename)::regclass))
    from pg_publication_tables t
    left join pg_stat_user_tables s on s.schemaname = t.schemaname and s.relname = t.tablename
   where t.pubname = 'supabase_realtime'
  union all
  select 'A realtime', '2 live listeners ' || coalesce(x.v ->> 'entity', '?'), (x.v ->> 'n') || ' subscriptions'
    from (select jsonb_array_elements(case when to_regclass('realtime.subscription') is null then '[]'::jsonb else
            (select coalesce(jsonb_agg(jsonb_build_object('entity', (xpath('/row/entity/text()', r))[1]::text, 'n', (xpath('/row/n/text()', r))[1]::text)), '[]'::jsonb)
               from unnest(xpath('/table/row', query_to_xml('select entity::text as entity, count(*) as n from realtime.subscription group by 1 order by 2 desc', false, false, ''))) r) end) v) x
  union all
  -- B) cron jobs -------------------------------------------------------------------------------------------------------------------
  select 'B cron', '1 job ' || coalesce(x.v ->> 'jobname', '?'),
         coalesce(x.v ->> 'schedule', '') || ' | ' || coalesce(x.v ->> 'active', '') || ' | ' || coalesce(x.v ->> 'cmd', '')
    from (select jsonb_array_elements(case when to_regclass('cron.job') is null then '[]'::jsonb else
            (select coalesce(jsonb_agg(jsonb_build_object('jobname', (xpath('/row/jobname/text()', r))[1]::text,
                      'schedule', (xpath('/row/schedule/text()', r))[1]::text, 'active', (xpath('/row/active/text()', r))[1]::text,
                      'cmd', (xpath('/row/cmd/text()', r))[1]::text)), '[]'::jsonb)
               from unnest(xpath('/table/row', query_to_xml(
                 'select jobname, schedule, active, left(regexp_replace(regexp_replace(command, ''[A-Za-z0-9_.=-]{40,}'', ''[hidden]'', ''g''), ''\s+'', '' '', ''g''), 160) as cmd from cron.job order by jobname',
                 false, false, ''))) r) end) v) x
  union all
  select 'B cron', '2 last 24 h ' || coalesce(x.v ->> 'jobname', '?'),
         (x.v ->> 'runs') || ' runs | mean ' || (x.v ->> 'mean_ms') || ' ms | slowest ' || (x.v ->> 'max_ms') || ' ms | failed ' || (x.v ->> 'failed')
    from (select jsonb_array_elements(case when to_regclass('cron.job_run_details') is null or to_regclass('cron.job') is null then '[]'::jsonb else
            (select coalesce(jsonb_agg(jsonb_build_object('jobname', (xpath('/row/jobname/text()', r))[1]::text, 'runs', (xpath('/row/runs/text()', r))[1]::text,
                      'mean_ms', (xpath('/row/mean_ms/text()', r))[1]::text, 'max_ms', (xpath('/row/max_ms/text()', r))[1]::text,
                      'failed', (xpath('/row/failed/text()', r))[1]::text)), '[]'::jsonb)
               from unnest(xpath('/table/row', query_to_xml(
                 'select j.jobname, count(*) as runs, round(avg(extract(epoch from d.end_time - d.start_time) * 1000)) as mean_ms,
                         round(max(extract(epoch from d.end_time - d.start_time) * 1000)) as max_ms, count(*) filter (where d.status <> ''succeeded'') as failed
                    from cron.job_run_details d join cron.job j on j.jobid = d.jobid
                   where d.start_time > now() - interval ''24 hours'' group by j.jobname order by 3 desc',
                 false, false, ''))) r) end) v) x
  union all
  -- C) pg_stat_statements ----------------------------------------------------------------------------------------------------------
  select 'C statements', '0 counting since', coalesce((select (xpath('/row/r/text()', r))[1]::text
           from unnest(xpath('/table/row', query_to_xml('select stats_reset as r from pg_stat_statements_info', false, false, ''))) r), 'pg_stat_statements not installed')
   where to_regclass('pg_stat_statements_info') is not null or to_regclass('extensions.pg_stat_statements_info') is not null
  union all
  select 'C statements', '0 track (top = page calls only, all = also calls inside functions)', current_setting('pg_stat_statements.track', true)
  union all
  select 'C statements', '1 top ' || lpad(x.o::text, 2, '0'),
         (x.v ->> 'calls') || ' calls | mean ' || (x.v ->> 'mean_ms') || ' ms | total ' || (x.v ->> 'total_s') || ' s | ' || (x.v ->> 'pct') || '% | '
         || coalesce(x.v ->> 'role', '') || ' | ' || coalesce(x.v ->> 'q', '')
    from (select v, o from jsonb_array_elements(case when to_regclass('pg_stat_statements') is null and to_regclass('extensions.pg_stat_statements') is null then '[]'::jsonb else
            (select coalesce(jsonb_agg(jsonb_build_object('calls', (xpath('/row/calls/text()', r))[1]::text, 'mean_ms', (xpath('/row/mean_ms/text()', r))[1]::text,
                      'total_s', (xpath('/row/total_s/text()', r))[1]::text, 'pct', (xpath('/row/pct/text()', r))[1]::text,
                      'role', (xpath('/row/role/text()', r))[1]::text, 'q', (xpath('/row/q/text()', r))[1]::text)), '[]'::jsonb)
               from unnest(xpath('/table/row', query_to_xml(
                 'select s.calls, round(s.mean_exec_time::numeric, 1) as mean_ms, round(s.total_exec_time::numeric / 1000) as total_s,
                         round(100 * s.total_exec_time / nullif(sum(s.total_exec_time) over (), 0)) as pct, r.rolname as role,
                         left(regexp_replace(s.query, ''\s+'', '' '', ''g''), 140) as q
                    from pg_stat_statements s join pg_roles r on r.oid = s.userid order by s.total_exec_time desc limit 25',
                 false, false, ''))) r) end) with ordinality t(v, o)) x
  union all
  select 'C statements', '2 schema-cache family ' || coalesce(x.v ->> 'kind', '?'),
         (x.v ->> 'calls') || ' calls | ' || (x.v ->> 'per_hour') || ' per hour | mean ' || (x.v ->> 'mean_ms') || ' ms'
    from (select jsonb_array_elements(case when to_regclass('pg_stat_statements') is null and to_regclass('extensions.pg_stat_statements') is null then '[]'::jsonb else
            (select coalesce(jsonb_agg(jsonb_build_object('kind', (xpath('/row/kind/text()', r))[1]::text, 'calls', (xpath('/row/calls/text()', r))[1]::text,
                      'per_hour', (xpath('/row/per_hour/text()', r))[1]::text, 'mean_ms', (xpath('/row/mean_ms/text()', r))[1]::text)), '[]'::jsonb)
               from unnest(xpath('/table/row', query_to_xml(
                 'select case when s.query ilike ''%pg_timezone_names%'' then ''timezone names'' when s.query ilike ''%arg_modes%'' then ''functions (arg_modes)''
                              when s.query ilike ''%pg_extension%'' then ''extensions'' when s.query ilike ''%typbasetype%'' then ''domain types''
                              else ''tables / columns'' end as kind,
                         sum(s.calls) as calls, round(sum(s.calls) / greatest(extract(epoch from now() - max(i.stats_reset)) / 3600, 1)::numeric, 2) as per_hour,
                         round(avg(s.mean_exec_time)::numeric) as mean_ms
                    from pg_stat_statements s cross join pg_stat_statements_info i
                   where s.query ilike ''%pg_timezone_names%'' or s.query ilike ''%arg_modes%'' or s.query ilike ''%pg_extension%''
                      or s.query ilike ''%typbasetype%'' or (s.query ilike ''%json_agg%'' and s.query ilike ''%pg_attribute%'')
                   group by 1 order by 2 desc',
                 false, false, ''))) r) end) v) x
  union all
  select 'C statements', '3 p_limit call ' || coalesce(x.v ->> 'fn', '?'),
         (x.v ->> 'calls') || ' calls | mean ' || (x.v ->> 'mean_ms') || ' ms | total ' || (x.v ->> 'total_s') || ' s'
    from (select jsonb_array_elements(case when to_regclass('pg_stat_statements') is null and to_regclass('extensions.pg_stat_statements') is null then '[]'::jsonb else
            (select coalesce(jsonb_agg(jsonb_build_object('fn', (xpath('/row/fn/text()', r))[1]::text, 'calls', (xpath('/row/calls/text()', r))[1]::text,
                      'mean_ms', (xpath('/row/mean_ms/text()', r))[1]::text, 'total_s', (xpath('/row/total_s/text()', r))[1]::text)), '[]'::jsonb)
               from unnest(xpath('/table/row', query_to_xml(
                 'select coalesce(substring(s.query from ''"public"\."([a-z0-9_]+)"''), substring(s.query from ''public\.([a-z0-9_]+)\(''), ''?'') as fn,
                         s.calls, round(s.mean_exec_time::numeric) as mean_ms, round(s.total_exec_time::numeric / 1000) as total_s
                    from pg_stat_statements s where s.query ilike ''%p_limit%'' order by s.total_exec_time desc limit 15',
                 false, false, ''))) r) end) v) x
  union all
  -- D) PostgREST restarts vs reloads -------------------------------------------------------------------------------------------------
  select 'D restarts', '0 database started', pg_postmaster_start_time()::text || ' (' || date_trunc('minute', now() - pg_postmaster_start_time())::text || ' ago)'
  union all
  select 'D restarts', '1 connections of ' || a.usename || ' / ' || coalesce(nullif(a.application_name, ''), '-'),
         count(*) || ' open | newest started ' || date_trunc('second', now() - max(a.backend_start))::text || ' ago | oldest ' || date_trunc('second', now() - min(a.backend_start))::text || ' ago'
    from pg_stat_activity a where a.usename in ('authenticator', 'supabase_admin', 'postgres', 'supabase_realtime_admin', 'supabase_storage_admin')
   group by a.usename, a.application_name
  union all
  select 'D restarts', '2 event trigger ' || e.evtname, e.evtevent || ' -> ' || e.evtfoid::regproc::text || ' (' || e.evtenabled::text || ')'
    from pg_event_trigger e
  union all
  -- E) what the per-studio jobs walk -------------------------------------------------------------------------------------------------
  select 'E studios', '0 studios', count(*)::text from public.organizations
  union all
  select 'E studios', '1 studios with a notification in the last 7 days',
         (select count(distinct n.org_id) from public.notifications n where n.created_at > now() - interval '7 days')::text
  union all
  select 'E studios', '2 studios with a due / invoiced instalment',
         (select count(distinct pm.org_id) from public.payment_milestones pm where pm.status in ('due', 'invoiced'))::text
  union all
  select 'E studios', '3 R249 SQL in (0431 / 0432 / 0433)',
         concat_ws(' / ', (to_regprocedure('public.event_money_bundle(uuid,text[])') is not null)::text,
                   (to_regprocedure('public._r432_task_due(timestamptz)') is not null)::text,
                   (to_regclass('public.chat_messages_org_created_idx_0433') is not null)::text)
) d order by section, item;
