-- APPLY-0359 (R167 daily cleanup of old pg_cron run history). Run on STAGING first, then production. Safe to run twice.
-- Adds one cleanup function and one daily job that deletes pg_cron run-history rows older than 7 days. No business data is touched. Staging has no pg_cron: the job is simply not scheduled there.
begin;
-- 0359 (R167, prod test 13 Nov: pg_cron run history cron.job_run_details is never trimmed).
-- About 21 scheduled jobs, one every minute, add roughly 4000-6000 rows a day (about 2M a year)
-- on the small Nano database. This adds ONE daily cleanup job that deletes run-history rows
-- older than 7 days. It changes no existing timer and touches no business data: cron.job_run_details
-- is pg_cron internal bookkeeping only. Additive and idempotent. Safe to run twice.
-- Staging has no pg_cron: the function is still created (guarded, harmless) and the job is simply
-- not scheduled there, which is fine.

-- 1) the cleanup function (guarded so it is harmless where pg_cron is absent)
create or replace function public._r359_trim_cron_log()
returns integer language plpgsql security definer set search_path = '' as $fn$
declare n integer := 0;
begin
  if to_regclass('cron.job_run_details') is not null then
    delete from cron.job_run_details where end_time < now() - interval '7 days';
    get diagnostics n = row_count;
  end if;
  return n;
end $fn$;

-- least privilege: no app role may call it
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'anon') then execute 'revoke all on function public._r359_trim_cron_log() from anon'; end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then execute 'revoke all on function public._r359_trim_cron_log() from authenticated'; end if;
  execute 'revoke all on function public._r359_trim_cron_log() from public';
end $$;

-- 2) the daily job (only where pg_cron exists; re-run keeps a single job)
do $$ begin
  if to_regnamespace('cron') is not null and to_regprocedure('cron.schedule(text,text,text)') is not null then
    if not exists (select 1 from cron.job where jobname = 'helm-cron-log-trim') then
      perform cron.schedule('helm-cron-log-trim', '23 2 * * *', 'select public._r359_trim_cron_log()');
    end if;
  else
    raise notice '0359: pg_cron not available (staging) - cron log trim not scheduled here, which is fine';
  end if;
end $$;

-- NOTE: the VERIFY lines below must not NAME cron.job / cron.job_run_details as a relation,
-- because Postgres parses a plain SELECT fully before running it, so a direct reference would
-- error on a database without pg_cron (staging and the CI canonical build). We use to_regclass
-- (a text argument) and call the guarded function instead.
-- VERIFY 01: function exists
select to_regprocedure('public._r359_trim_cron_log()') is not null as fn_ok;
-- VERIFY 02: is pg_cron present here (true on prod; false on staging / CI, which is fine)
select to_regclass('cron.job') is not null as pg_cron_present;
-- VERIFY 03: run the cleanup once now - returns rows deleted (0 where pg_cron is absent; a real count on prod)
select public._r359_trim_cron_log() as rows_trimmed_now;
commit;
