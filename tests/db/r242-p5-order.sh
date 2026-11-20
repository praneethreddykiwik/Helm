#!/usr/bin/env bash
# r242-p5-order.sh - R242 fix plan Phase 5: the REAL order on staging / production. Those databases have every migration up to
# 0403 (0404-0408 are separate PRs) and get APPLY-0409 .. APPLY-0412 pasted by hand, in that order, maybe twice. This builds
# that order on the disposable local cluster and proves it is safe:
#   1 a database migrated with every MANIFEST entry EXCEPT 0409-0412, plus a pg_cron job list like production (the jobs the
#     migrations made + hand-made e-mail sender jobs + one job whose schedule the owner changed + one owner job)
#   2 APPLY-0409, -0410, -0411, -0412 pasted like the SQL editor (one transaction each, lock_timeout 5s): every check row true;
#      the jobs the migrations made are spread, the hand-made / changed ones are byte-for-byte the same
#   3 all four pasted a second time: every check row still true, no job moves again
#   4 APPLY-0402 pasted again (it puts the older _ops402_lane back): APPLY-0410 check 03 says so (false), APPLY-0410 again
#      fixes it (true) - exactly what the APPLY-0410 header tells the owner
#   5 nothing 0402 / 0403 made is changed by the four pastes except _ops402_lane (more lanes) and the ledger CHECK (wider)
# Own database (helm_r242order), dropped at the end. Prints R242-P5-ORDER: PASS.
set -uo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/../.."
DB=helm_r242order
export PGOPTIONS=""   # like the SQL editor: no harness switches
fail=0; ok() { if [ "$2" = "t" ]; then echo "  ok   $1"; else echo "  FAIL $1 ($2)"; fail=1; fi; }
q() { PGDATABASE=$DB psql -X -q -A -t -v ON_ERROR_STOP=1 -c "$1"; }
checks() { PGDATABASE=$DB psql -X -q -A -t -F '|' -v ON_ERROR_STOP=1 -f "$1" 2>&1; }
allok() { local out="$1" min="$2"; [ "$(grep -cE '^[0-9]{2} [^|]*\|t\|' <<<"$out")" -ge "$min" ] && ! grep -qE '^[0-9]{2} [^|]*\|f\||ERROR' <<<"$out" && echo t || grep -E '\|f\||ERROR' <<<"$out" | head -3; }
dropdb --if-exists "$DB" >/dev/null 2>&1; createdb "$DB" || { echo "R242-P5-ORDER: FAIL (createdb)"; exit 1; }
PGDATABASE=$DB psql -q -v ON_ERROR_STOP=1 -f supabase/test-harness/00-supabase-shim.sql >/dev/null 2>&1
q "create table if not exists public.helm_schema_migrations(filename text primary key, sha256 text not null, applied_at timestamptz not null default now())" >/dev/null
# 1) production today: every MANIFEST entry except 0409-0412, in order, one transaction each
n=0; bad=""
while read -r scope path _; do
  [ -z "${scope:-}" ] && continue; case "$scope" in \#*) continue;; esac
  case "$path" in *0409_r242_*|*0410_r242_*|*0411_r242_*|*0412_r242_*) continue;; esac
  PGDATABASE=$DB psql -X -q -v ON_ERROR_STOP=1 -1 -f "$path" >/dev/null 2>&1 || { bad="$path"; break; }
  n=$((n+1))
done < supabase/migrations/MANIFEST
ok "production order built: $n migrations, 0402 + 0403 in, no 0409-0412" "$( [ -z "$bad" ] && [ "$(q "select to_regprocedure('public.ops_health()') is not null and to_regclass('public.account_age_confirmations') is not null and to_regclass('public.helm_render_cap') is null and to_regprocedure('public.hq_switches()') is null")" = t ] && echo t || echo "stopped at ${bad:-?}")"
# a job list like production (fake pg_cron: only what 0409 / 0402 read and call)
q "create schema if not exists cron;
   create table cron.job (jobid bigserial primary key, jobname text, schedule text, command text, active boolean default true);
   create table cron.job_run_details (runid bigserial, jobid bigint, status text, start_time timestamptz, end_time timestamptz, return_message text);
   create or replace function cron.schedule(p_name text, p_schedule text, p_command text) returns bigint language sql as \$\$
     insert into cron.job(jobname, schedule, command) values (p_name, p_schedule, p_command) returning jobid \$\$;
   create or replace function cron.alter_job(job_id bigint, schedule text default null, command text default null, database text default null,
     username text default null, active boolean default null) returns void language sql as \$\$
     update cron.job j set schedule = coalesce(alter_job.schedule, j.schedule), command = coalesce(alter_job.command, j.command),
            active = coalesce(alter_job.active, j.active) where j.jobid = alter_job.job_id \$\$;
   insert into cron.job(jobname, schedule, command) values
     ('helm_inbox_tick', '*/5 * * * *', 'select public.inbox_tick()'), ('helm_team_safety_tick', '*/5 * * * *', 'select public.team_safety_tick()'),
     ('helm_runsheet_reminders', '*/5 * * * *', 'select public.runsheet_reminders_tick()'), ('helm_pay_details_tick', '*/5 * * * *', 'select public.pay_details_tick()'),
     ('helm-event-ready-alerts', '*/5 * * * *', 'select public.event_ready_alert_tick()'), ('helm_delivery_reminders', '*/5 * * * *', 'select public.delivery_reminders_tick()'),
     ('helm_comms_tick', '*/15 * * * *', 'select public.comms_tick()'), ('helm_vendor_requests', '*/15 * * * *', 'select public.vendor_requests_tick()'),
     ('helm_link_expiry_shelf', '*/30 * * * *', 'select public.apply_link_expiry_archive_all()'), ('helm_link_views_tick', '*/20 * * * *', 'select public.link_views_tick()'),
     ('helm_quote_stage_sweep', '*/30 * * * *', 'select public.quote_stage_sweep(500)'), ('helm-task-reminders', '* * * * *', 'select public.task_reminder_tick()'),
     ('helm_comms_dispatch', '*/5 * * * *', 'select net.http_post(url := ''https://x.supabase.co/functions/v1/comms-dispatch'')'),
     ('invite-mailer', '*/2 * * * *', 'select net.http_post(url := ''https://x.supabase.co/functions/v1/invite-mailer'')'),
     ('owner_report', '0 * * * *', 'select 1')" >/dev/null
OWN="select string_agg(jobname || '|' || schedule || '|' || command || '|' || active, ';' order by jobid) from cron.job where jobname in ('helm_link_views_tick', 'helm-task-reminders', 'helm_comms_dispatch', 'invite-mailer', 'owner_report')"
SNAP="select p.oid::regprocedure::text || '|' || md5(p.prosrc) || '|' || coalesce(array_to_string(p.proconfig, ','), '') || '|' || p.prosecdef
  from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname <> '_ops402_lane'
   and (p.prosrc ~ 'r236|0402|r238|0403|_r342_max_attempts' or p.proname ~ '^(ops_|_ops402|photo_render|pkg_outbox|_sa54)')
   and p.proname !~ '^(ops_cron_stagger|_r409|_r410|_r411|_r412)'
  union all select 'trigger ' || tgrelid::regclass::text || ' ' || tgname::text from pg_trigger where tgname like 'zz_r402%' or tgname like 'a403%'
  order by 1"
O1="$(q "$OWN")"; S1="$(q "$SNAP")"
# 2) the four pastes, in order
for f in 0409 0410 0411 0412; do
  A="$(checks supabase/APPLY-$f.sql)"; ok "APPLY-$f pasted: every check row true" "$(allok "$A" 4)"
done
ok "the 10 jobs the migrations made (untouched) are spread over the hour, none starts at :00 / :30" "$(q "select count(*) = 10 and bool_and(split_part(j.schedule, ' ', 1) !~ '(^|,)(0|30)(,|\$)') from cron.job j join public._r409_plan() p on p.job = j.jobname and j.schedule = p.new_schedule")"
ok "hand-changed / hand-made / mailer / every-minute jobs: byte-for-byte the same" "$( [ "$(q "$OWN")" = "$O1" ] && echo t || echo changed)"
ok "APPLY-0409 row 03 names the jobs it did not touch" "$(checks supabase/APPLY-0409.sql | grep -q '^03 .*helm_link_views_tick (kept_owner).*owner_report (owner_job)' && echo t || echo missing)"
# 3) all four again
J1="$(q "select md5(string_agg(jobname || schedule || command || active, '|' order by jobid)) from cron.job")"
for f in 0409 0410 0411 0412; do
  A="$(checks supabase/APPLY-$f.sql)"; ok "APPLY-$f pasted again: every check row true" "$(allok "$A" 4)"
done
ok "second paste moves no job" "$( [ "$(q "select md5(string_agg(jobname || schedule || command || active, '|' order by jobid)) from cron.job")" = "$J1" ] && echo t || echo moved)"
# 4) APPLY-0402 again puts the older lane list back; APPLY-0410 says so and fixes it
A402="$(checks supabase/APPLY-0402.sql)"; ok "APPLY-0402 pasted again later: its own check rows true" "$(allok "$A402" 15)"
ok "... which puts the older lane list back (why the APPLY-0410 header says: run it again after APPLY-0402)" "$(q "select public._ops402_lane('welcome') is null and public._ops402_lane('comms') is not null")"
A410="$(checks supabase/APPLY-0410.sql)"
ok "... then APPLY-0410 is pasted again and every row is true (the lane list is back, the CHECK stayed wide)" "$(allok "$A410" 5)"
ok "the 5 new lanes are accepted after that" "$(q "select public._ops402_lane('welcome') is not null and public._ops402_lane('billing') is not null and exists (select 1 from pg_constraint where conname = 'ops_send_ledger_lane_chk410')")"
# 5) nothing else 0402 / 0403 made changed (beyond _ops402_lane, the wider CHECK and the 0411 bell label)
S2="$(q "$SNAP")"
D="$(diff <(echo "$S1") <(echo "$S2") | grep -E '^[<>]' | grep -v '_sa54_label' || true)"
ok "0402 / 0403 / photo render / pkg outbox functions + triggers unchanged ($(wc -l <<<"$S1" | tr -d ' ') facts; _sa54_label gained its render line)" "$( [ -z "$D" ] && [ "$(wc -l <<<"$S1" | tr -d ' ')" -ge 30 ] && echo t || echo "$D" | head -4)"
dropdb --if-exists "$DB" >/dev/null 2>&1
[ "$fail" = 0 ] && echo "R242-P5-ORDER: PASS" || echo "R242-P5-ORDER: FAIL"
