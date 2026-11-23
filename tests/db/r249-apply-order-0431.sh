#!/usr/bin/env bash
# r249-apply-order-0431.sh - R249: the REAL order on staging / production. Phase 9 (0423-0425) is ON HOLD and R248 (0430) may land
# before or after this PR, so APPLY-0431 .. APPLY-0433 must work on a database WITHOUT 0423-0425 and WITHOUT 0430:
#   1 a database migrated with every MANIFEST entry except 0423-0425, 0430 and 0431-0433 (no harness switches, like the SQL editor)
#   2 APPLY-0431, APPLY-0432, APPLY-0433 pasted twice: every check row true, nothing doubled
#   3 events, money rows, bell notices, chat messages, outboxes untouched (same count + content digest)
#   4 the prod checker reports 0431-0433 present and nothing else missing / partial except 0423-0425 (and 0430 when absent)
#   5 later: APPLY-0423 .. 0425 (Phase 9 taken) then APPLY-0431 .. 0433 again - every check row true
# Own database (helm_r249order), dropped at the end. Prints R249-APPLY-ORDER-0431: PASS.
set -uo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/../.."
DB=helm_r249order
export PGOPTIONS=""
fail=0; ok() { if [ "$2" = "t" ]; then echo "  ok   $1"; else echo "  FAIL $1 ($2)"; fail=1; fi; }
q() { PGDATABASE=$DB psql -X -q -A -t -v ON_ERROR_STOP=1 -c "$1"; }
checks() { PGDATABASE=$DB psql -X -q -A -t -F '|' -v ON_ERROR_STOP=1 -f "$1" 2>&1; }
allok() { local out="$1" min="$2"; [ "$(grep -cE '^[0-9]{2} [^|]*\|t$' <<<"$out")" -ge "$min" ] && ! grep -qE '^[0-9]{2} [^|]*\|f$|ERROR' <<<"$out" && echo t || { grep -E '\|f$|ERROR' <<<"$out" | head -3; echo "rows=$(grep -cE '^[0-9]{2} [^|]*\|t$' <<<"$out")"; }; }
dropdb --if-exists "$DB" >/dev/null 2>&1; createdb "$DB" || { echo "R249-APPLY-ORDER-0431: FAIL (createdb)"; exit 1; }
PGDATABASE=$DB psql -q -v ON_ERROR_STOP=1 -f supabase/test-harness/00-supabase-shim.sql >/dev/null 2>&1
q "create table if not exists public.helm_schema_migrations(filename text primary key, sha256 text not null, applied_at timestamptz not null default now())" >/dev/null
n=0; bad=""
while read -r scope path _; do
  [ -z "${scope:-}" ] && continue; case "$scope" in \#*) continue;; esac
  case "$path" in *0423_r246_*|*0424_r246_*|*0425_r246_*|*0430_*|*0431_r249_*|*0432_r249_*|*0433_r249_*) continue;; esac
  PGDATABASE=$DB psql -X -q -v ON_ERROR_STOP=1 -1 -f "$path" >/dev/null 2>&1 || { bad="$path"; break; }
  n=$((n+1))
done < supabase/migrations/MANIFEST
ok "production order built: $n migrations without 0423-0425 / 0430 / 0431-0433" "$( [ -z "$bad" ] && [ "$(q "select to_regprocedure('public._r21_cost_lines__pre0424(uuid,uuid)') is null and to_regprocedure('public.event_money_bundle(uuid,text[])') is null")" = t ] && echo t || echo "stopped at ${bad:-?}")"
PGDATABASE=$DB psql -q -v ON_ERROR_STOP=1 -f supabase/test-harness/10-fixtures.sql >/dev/null 2>&1
DIG="select (select count(*) || ':' || md5(coalesce(string_agg(to_jsonb(x)::text, ',' order by x.id), '')) from public.quotes x)
  || '|' || (select count(*) || ':' || md5(coalesce(string_agg(to_jsonb(n)::text, ',' order by n.id), '')) from public.notifications n)
  || '|' || (select count(*) from public.chat_messages) || '|' || (select count(*) from public.comms_outbox) || '|' || (select count(*) from public.event_costs)
  || '|' || (select count(*) from public.quote_payments) || '|' || (select count(*) from public.task_wa_outbox) || '|' || (select count(*) from public.helm_notice_outbox)"
D1="$(q "$DIG")"
for k in 1 2; do
  ok "APPLY-0431 paste $k: every check row true" "$(allok "$(checks supabase/APPLY-0431.sql)" 5)"
  ok "APPLY-0432 paste $k: every check row true" "$(allok "$(checks supabase/APPLY-0432.sql)" 6)"
  ok "APPLY-0433 paste $k: every check row true" "$(allok "$(checks supabase/APPLY-0433.sql)" 4)"
done
ok "after two pastes: each kept body once, no kept copy of a kept copy" "$(q "select (select count(*) from pg_proc where pronamespace = 'public'::regnamespace and proname like '%\_\_pre0431') = 1 and (select count(*) from pg_proc where pronamespace = 'public'::regnamespace and proname like '%\_\_pre0432') = 6 and (select count(*) from pg_proc where pronamespace = 'public'::regnamespace and proname like '%\_\_pre0433') = 1 and not exists (select 1 from pg_proc where proname ~ '__pre043[123]__pre043[123]')")"
D2="$(q "$DIG")"
ok "events, notices, chat, outboxes, money rows untouched (same count + digest)" "$( [ "$D1" = "$D2" ] && echo t || echo "$D1 vs $D2")"
ok "the jobs still run on this order (quiet answers)" "$(q "select public.task_reminder_tick(now()) ? 'escalated' and public.runsheet_reminders_tick() ? 'done' and public.delivery_reminders_tick() ? 'queued' and public.inbox_tick() ? 'queued' and public.comms_tick() ? 'pay_reminders'")"
CHK="$(PGDATABASE=$DB psql -X -q -A -t -F '|' -v ON_ERROR_STOP=1 -f supabase/CHECK-PROD-MIGRATIONS.sql 2>&1)"
ok "prod checker: 0431 + 0432 + 0433 present" "$( grep -qE '^0431_r249_money_once\|present\|' <<<"$CHK" && grep -qE '^0432_r249_cron_quiet\|present\|' <<<"$CHK" && grep -qE '^0433_r249_read_speed\|present\|' <<<"$CHK" && echo t || grep -E '^043[123]' <<<"$CHK" | head -3)"
ok "prod checker: only 0423-0425 / 0430 missing / partial" "$( ! grep -E '^[^|]+\|(missing|partial)\|' <<<"$CHK" | grep -qvE '^0(42[345]_r246|430)_' && echo t || grep -E '^[^|]+\|(missing|partial)\|' <<<"$CHK" | grep -vE '^0(42[345]_r246|430)_' | head -3)"
for f in 0423 0424 0425; do
  out="$(checks supabase/APPLY-$f.sql)"
  ok "later: APPLY-$f after 0431-0433: every check row true" "$( ! grep -qE '^[0-9]{2} [^|]*\|f(\||$)|ERROR' <<<"$out" && [ "$(grep -cE '^[0-9]{2} [^|]*\|t(\||$)' <<<"$out")" -ge 3 ] && echo t || { grep -E '\|f(\||$)|ERROR' <<<"$out" | head -3; })"
done
ok "later: APPLY-0431 again: every check row true" "$(allok "$(checks supabase/APPLY-0431.sql)" 5)"
ok "later: APPLY-0432 again: every check row true" "$(allok "$(checks supabase/APPLY-0432.sql)" 6)"
ok "later: APPLY-0433 again: every check row true" "$(allok "$(checks supabase/APPLY-0433.sql)" 4)"
dropdb --if-exists "$DB" >/dev/null 2>&1
[ "$fail" = 0 ] && echo "R249-APPLY-ORDER-0431: PASS" || echo "R249-APPLY-ORDER-0431: FAIL"
