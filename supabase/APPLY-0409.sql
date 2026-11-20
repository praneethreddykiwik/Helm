-- APPLY-0409 (R242 fix plan Phase 5: spread the background jobs over the hour - PERF-03 / JOB-05).
-- Run on STAGING first, then production. Safe to run twice. Needs nothing else (on staging, without pg_cron, it moves nothing).
-- What it does:
--   * About 12 jobs that Helm's own migrations created start in the same minute at :00 and :30. They are moved to start
--     1 to 19 minutes later - each still runs exactly as often (every 5 minutes stays every 5 minutes).
--   * Only a job that is EXACTLY what its migration made (same name, command and schedule) is moved, and only its schedule.
--     The e-mail sender jobs made by hand in the dashboard, any job whose schedule / command was changed by hand and every
--     other job are NOT touched - check row 03 lists them by name so you can decide.
--   * Undo at any time: select public.ops_cron_stagger_undo();
-- No table, no row, no data is created, changed or deleted.
-- It waits at most 5 seconds for a table lock (then stops with an error and changes nothing - just run it again later).
-- Paste the whole file into the Supabase SQL editor and press Run. The last result lists checks - every ok must be true.
begin;
set local lock_timeout = '5s';
set local statement_timeout = '5min';
-- 0409_r242_cron_stagger.sql - CANONICAL forward-only. R242 (fix plan Phase 5, owner approved 20 Nov 2026; PERF-03 / JOB-05,
-- audit C #4). REQUIRES nothing. pg_cron is optional: a database without it (staging, local) simply has nothing to move.
--
-- In plain words:
--   About 14 background jobs start in the same minute at :00 and :30 (every 5 / 15 / 30 minutes, plus the e-mail senders).
--   On the small production database that is a burst of connections and memory at the same moment. This file spreads the
--   jobs that Helm's OWN migrations created over the hour - each still runs just as often (every 5 minutes stays every
--   5 minutes, it only starts 1 to 4 minutes later), so reminders still go out within the same 5 minutes.
--   A job is moved ONLY when it is exactly what the migration made: same name, same command, same schedule. A job whose
--   schedule or command was changed by hand, a job made by hand in the dashboard (for example the e-mail sender jobs on
--   production) and every job this file does not know are NEVER touched - ops_cron_stagger_report() lists them by name
--   (never their command) so the owner can decide.
--   ops_cron_stagger_report()  what each known job is now (state staggered / can_stagger / kept_owner / missing) + the
--                              other jobs by name only (owner_job / mailer). Read-only.
--   ops_cron_stagger_apply()   moves the "can_stagger" jobs (run by this file; running it again moves nothing more).
--   ops_cron_stagger_undo()    OWNER ONLY, by hand: puts every job this file moved back on its old schedule.
--
-- ZERO DATA LOSS: no table, no row, no column is created, changed or deleted. Only the SCHEDULE of up to 12 cron jobs
-- changes (cron.alter_job, schedule only - command, active flag and owner are kept). Nothing dropped, nothing unscheduled.
-- Safe to run twice (the second run finds every job already staggered). ASCII only.
-- Undo (manual): select public.ops_cron_stagger_undo();

-- the jobs Helm's migrations made, their command, the schedule the migration gave them and the staggered one
create or replace function public._r409_plan()
returns table(job text, cmd text, old_schedule text, new_schedule text, made_by text)
language sql immutable set search_path = '' as $$
  select * from (values
    ('helm_inbox_tick',         'select public.inbox_tick()',               '*/5 * * * *',  '1,6,11,16,21,26,31,36,41,46,51,56 * * * *', '0266'),
    ('helm_team_safety_tick',   'select public.team_safety_tick()',         '*/5 * * * *',  '1,6,11,16,21,26,31,36,41,46,51,56 * * * *', '0283'),
    ('helm_runsheet_reminders', 'select public.runsheet_reminders_tick()',  '*/5 * * * *',  '2,7,12,17,22,27,32,37,42,47,52,57 * * * *', '0269'),
    ('helm_pay_details_tick',   'select public.pay_details_tick()',         '*/5 * * * *',  '3,8,13,18,23,28,33,38,43,48,53,58 * * * *', '0285'),
    ('helm-event-ready-alerts', 'select public.event_ready_alert_tick()',   '*/5 * * * *',  '3,8,13,18,23,28,33,38,43,48,53,58 * * * *', '0396'),
    ('helm_delivery_reminders', 'select public.delivery_reminders_tick()',  '*/5 * * * *',  '4,9,14,19,24,29,34,39,44,49,54,59 * * * *', '0241'),
    ('helm_comms_tick',         'select public.comms_tick()',               '*/15 * * * *', '7,22,37,52 * * * *', '0078'),
    ('helm_vendor_requests',    'select public.vendor_requests_tick()',     '*/15 * * * *', '9,24,39,54 * * * *', '0256'),
    ('helm_link_expiry_shelf',  'select public.apply_link_expiry_archive_all()', '*/30 * * * *', '11,41 * * * *', '0040'),
    ('helm_link_views_tick',    'select public.link_views_tick()',          '*/30 * * * *', '13,43 * * * *', '0261'),
    ('helm_quote_stage_sweep',  'select public.quote_stage_sweep(500)',     '*/30 * * * *', '19,49 * * * *', '0263'),
    ('helm-wa-templates',       'select public._r354_kick(''tick'')',       '*/3 * * * *',  '1,4,7,10,13,16,19,22,25,28,31,34,37,40,43,46,49,52,55,58 * * * *', '0354')
  ) v(job, cmd, old_schedule, new_schedule, made_by);
$$;

-- every other job a migration made (never moved: hourly / daily ones already start at their own minute)
create or replace function public._r409_known_jobs()
returns text[] language sql immutable set search_path = '' as $$
  select array['helm-task-reminders', 'helm_billing_refresh', 'helm_trial_reminders', 'helm_event_reminders', 'helm_discard_empty_drafts',
               'helm_trial_retention', 'helm_trial_retention_purge', 'helm_quote_validity', 'helm_rate_hits_purge',
               'helm-wa-templates-nightly', 'helm-cron-log-trim', 'helm-vendor-bill-reminders', 'helm_referral_tick'];
$$;

-- the 0402 mailer job names (made by hand on production; never moved here)
create or replace function public._r409_mailer_jobs()
returns text[] language sql immutable set search_path = '' as $$
  select array['helm_comms_dispatch', 'invite-mailer', 'helm_security_alerts', 'helm_pkg_notify', 'helm_billing_reminder', 'helm_welcome_mailer'];
$$;

create or replace function public._r409_norm(p text)
returns text language sql immutable set search_path = '' as $$
  select lower(btrim(regexp_replace(regexp_replace(coalesce(p, ''), '\s+', ' ', 'g'), ';\s*$', '')));
$$;

-- state per job. Never returns a command (a hand-made job can carry a secret).
--   staggered   = on the new schedule, command as the migration made it
--   can_stagger = exactly what the migration made (old schedule + command) - apply moves it
--   kept_owner  = known name, but schedule or command changed by hand - never touched
--   missing     = not on this database
--   paused      = what the migration made, but switched off (active = false) - still moved (stays paused)
--   owner_job / mailer / known = other jobs, by name only, never touched
create or replace function public.ops_cron_stagger_report()
returns table(job text, live_schedule text, old_schedule text, new_schedule text, state text, note text)
language plpgsql stable security definer set search_path = '' as $$
-- r242-0409
declare p record; j record;
begin
  if to_regclass('cron.job') is null then
    job := '(pg_cron)'; state := 'no_pg_cron'; note := 'pg_cron is not switched on here - nothing to move'; return next; return;
  end if;
  for p in select * from public._r409_plan() loop
    job := p.job; old_schedule := p.old_schedule; new_schedule := p.new_schedule; live_schedule := null; note := null;
    execute 'select jobid, schedule, command, active from cron.job where jobname = $1 order by jobid limit 1' into j using p.job;
    if j.jobid is null then state := 'missing'; note := 'not on this database (made by ' || p.made_by || ' when pg_cron is on)';
    else
      live_schedule := j.schedule;
      if public._r409_norm(j.command) <> public._r409_norm(p.cmd) then
        state := 'kept_owner'; note := 'its command was changed by hand - not touched';
      elsif j.schedule = p.new_schedule then state := 'staggered'; note := case when j.active then 'spread over the hour' else 'spread over the hour (paused)' end;
      elsif j.schedule = p.old_schedule then state := case when j.active then 'can_stagger' else 'paused' end;
        note := 'exactly as migration ' || p.made_by || ' made it';
      else state := 'kept_owner'; note := 'its schedule was changed by hand - not touched';
      end if;
    end if;
    return next;
  end loop;
  for j in execute 'select jobname, schedule from cron.job order by jobname' loop
    continue when j.jobname in (select x.job from public._r409_plan() x);
    job := j.jobname; live_schedule := j.schedule; old_schedule := null; new_schedule := null;
    if j.jobname = any(public._r409_mailer_jobs()) then state := 'mailer'; note := 'e-mail sender job (0402 / dashboard) - not moved';
    elsif j.jobname = any(public._r409_known_jobs()) then state := 'known'; note := 'made by a migration; already on its own minute - not moved';
    else state := 'owner_job'; note := 'made by hand - not touched';
    end if;
    return next;
  end loop;
end $$;

create or replace function public.ops_cron_stagger_apply()
returns text[] language plpgsql volatile security definer set search_path = '' as $$
-- r242-0409: move only the jobs that are exactly what the migrations made (schedule only)
declare r record; v_id bigint; v_moved text[] := array[]::text[];
begin
  if to_regclass('cron.job') is null or to_regprocedure('cron.alter_job(bigint,text,text,text,text,boolean)') is null then return v_moved; end if;
  for r in select x.job, x.new_schedule from public.ops_cron_stagger_report() x where x.state in ('can_stagger', 'paused') loop
    begin
      execute 'select jobid from cron.job where jobname = $1 order by jobid limit 1' into v_id using r.job;
      execute 'select cron.alter_job(job_id := $1, schedule := $2)' using v_id, r.new_schedule;
      v_moved := v_moved || r.job;
    exception when others then
      raise warning 'r242-0409: % not moved (%)', r.job, sqlstate;
    end;
  end loop;
  return v_moved;
end $$;

-- OWNER ONLY, by hand: every job this file moved goes back to its old schedule (a job changed by hand since is not touched)
create or replace function public.ops_cron_stagger_undo()
returns text[] language plpgsql volatile security definer set search_path = '' as $$
-- r242-0409
declare r record; v_id bigint; v_back text[] := array[]::text[];
begin
  if to_regclass('cron.job') is null or to_regprocedure('cron.alter_job(bigint,text,text,text,text,boolean)') is null then return v_back; end if;
  for r in select x.job, x.old_schedule from public.ops_cron_stagger_report() x where x.state = 'staggered' loop
    begin
      execute 'select jobid from cron.job where jobname = $1 order by jobid limit 1' into v_id using r.job;
      execute 'select cron.alter_job(job_id := $1, schedule := $2)' using v_id, r.old_schedule;
      v_back := v_back || r.job;
    exception when others then
      raise warning 'r242-0409: % not moved back (%)', r.job, sqlstate;
    end;
  end loop;
  return v_back;
end $$;

-- privileges: nobody but the database owner (the HQ switches page reads the report through 0412's definer function)
do $$ declare f text; r text; begin
  foreach f in array array['public._r409_plan()', 'public._r409_known_jobs()', 'public._r409_mailer_jobs()', 'public._r409_norm(text)',
      'public.ops_cron_stagger_report()', 'public.ops_cron_stagger_apply()', 'public.ops_cron_stagger_undo()'] loop
    execute format('revoke all on function %s from public', f);
    foreach r in array array['anon', 'authenticated', 'service_role'] loop
      if exists (select 1 from pg_roles where rolname = r) then execute format('revoke all on function %s from %I', f, r); end if;
    end loop;
  end loop;
end $$;

-- move them now (nothing to do without pg_cron)
do $$ declare v text[]; r record; begin
  if to_regclass('cron.job') is null then raise notice '0409: pg_cron is not enabled here - no job moved'; return; end if;
  v := public.ops_cron_stagger_apply();
  if cardinality(v) > 0 then raise notice '0409: jobs spread over the hour: %', array_to_string(v, ', '); end if;
  for r in select x.job, x.state from public.ops_cron_stagger_report() x where x.state in ('kept_owner', 'owner_job') loop
    raise notice '0409: job % : % (not touched)', r.job, r.state;
  end loop;
end $$;

-- ---- checks (every ok must be true) --------------------------------------------------------------------------------------
select item, ok, note from (
  select '01 functions in place, no app privilege' as item,
     to_regprocedure('public.ops_cron_stagger_report()') is not null and to_regprocedure('public.ops_cron_stagger_apply()') is not null
     and to_regprocedure('public.ops_cron_stagger_undo()') is not null
     and not has_function_privilege('authenticated', 'public.ops_cron_stagger_report()', 'execute')
     and not has_function_privilege('anon', 'public.ops_cron_stagger_apply()', 'execute') as ok, '' as note
  union all
  select '02 every job Helm made exactly as the migration did is now spread (none left at :00 / :30)',
     not exists (select 1 from public.ops_cron_stagger_report() x where x.state in ('can_stagger', 'paused')),
     coalesce((select count(*) || ' staggered. ' from public.ops_cron_stagger_report() x where x.state = 'staggered'), '')
     || case when to_regclass('cron.job') is null then 'no pg_cron here - nothing to move' else '' end
  union all
  select '03 not touched (report only - your decision): hand-changed or hand-made jobs',
     true,
     coalesce((select string_agg(x.job || ' (' || x.state || ')', ', ' order by x.job) from public.ops_cron_stagger_report() x
                where x.state in ('kept_owner', 'owner_job', 'mailer')), 'none')
  union all
  select '04 the new schedules keep every interval',
     to_regprocedure('public._ops402_every(text)') is null
     or not exists (select 1 from public._r409_plan() p where public._ops402_every(p.new_schedule) is distinct from public._ops402_every(p.old_schedule)), ''
) v order by item;
commit;
