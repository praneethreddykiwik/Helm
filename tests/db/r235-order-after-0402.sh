#!/usr/bin/env bash
# r235-order-after-0402.sh - R235 (coordinator, 20 Nov 2026): the owner ALREADY ran APPLY-0400 and APPLY-0402 on staging and
# production, so on the real databases APPLY-0401 is pasted AFTER APPLY-0402 (MANIFEST order is 0401, 0402). This builds
# that real order on the disposable local cluster and proves it is safe:
#   1 a database migrated with every MANIFEST entry EXCEPT 0401 (= production today), then APPLY-0402 + APPLY-0403 pasted (all ok)
#   2 APPLY-0401 pasted twice like the SQL editor: every check row true both times
#   3 everything 0402 / 0403 made is unchanged (function bodies, definer, search_path, backoff triggers, next_attempt_at columns,
#     ops tables) - the ONLY difference is lock_timeout=10s added to the job functions 0401 names
#   4 APPLY-0402 + APPLY-0403 pasted again afterwards: every check row still true, and it leaves 0401's settings in place
#   5 per function: a SET statement_timeout on a function never fires (0402 puts one on a function - follow-up), a SET
#     lock_timeout does; a statement_timeout set before the statement does fire
# Own database (helm_r235order), dropped at the end. Prints R235-ORDER-AFTER-0402: PASS.
set -uo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/../.."
DB=helm_r235order
export PGOPTIONS=""   # like the SQL editor: no harness switches
fail=0; ok() { if [ "$2" = "t" ]; then echo "  ok   $1"; else echo "  FAIL $1 ($2)"; fail=1; fi; }
q() { PGDATABASE=$DB psql -X -q -A -t -v ON_ERROR_STOP=1 -c "$1"; }
checks() { PGDATABASE=$DB psql -X -q -A -t -F '|' -v ON_ERROR_STOP=1 -f "$1" 2>&1; }
dropdb --if-exists "$DB" >/dev/null 2>&1; createdb "$DB" || { echo "R235-ORDER-AFTER-0402: FAIL (createdb)"; exit 1; }
PGDATABASE=$DB psql -q -v ON_ERROR_STOP=1 -f supabase/test-harness/00-supabase-shim.sql >/dev/null 2>&1
# the migration ledger scripts/db-migrate.sh makes first (0014 locks it down)
q "create table if not exists public.helm_schema_migrations(filename text primary key, sha256 text not null, applied_at timestamptz not null default now())" >/dev/null
# 1) production today: every MANIFEST entry except 0401, in order, one transaction each (like scripts/db-migrate.sh)
n=0; bad=""
while read -r scope path _; do
  [ -z "${scope:-}" ] && continue; case "$scope" in \#*) continue;; esac
  case "$path" in *0401_r235_db_load.sql|*0438_r254_*|*0445_r258_*) continue;; esac   # 0438 + 0445 need 0401 (later in real life)
  PGDATABASE=$DB psql -X -q -v ON_ERROR_STOP=1 -1 -f "$path" >/dev/null 2>&1 || { bad="$path"; break; }
  n=$((n+1))
done < supabase/migrations/MANIFEST
ok "production order built: $n migrations without 0401 (0400 + 0402 + 0403 in, no 0401)" "$( [ -z "$bad" ] && [ "$(q "select to_regprocedure('public._r401_sync()') is null and to_regprocedure('public.ops_health()') is not null and exists (select 1 from pg_proc where prosrc like '%r238-%0403%')")" = t ] && echo t || echo "stopped at ${bad:-?}")"
A402="$(checks supabase/APPLY-0402.sql)"
ok "APPLY-0402 pasted first: every check row ok" "$( [ "$(grep -cE '^[0-9]{2} [^|]*\|t\|' <<<"$A402")" -ge 15 ] && ! grep -qE '^[0-9]{2} [^|]*\|f\||ERROR' <<<"$A402" && echo t || grep -E '\|f\||ERROR' <<<"$A402" | head -3)"
A403="$(checks supabase/APPLY-0403.sql)"
ok "APPLY-0403 pasted next: every check row ok" "$( [ "$(grep -cE '^[0-9]{2} [^|]*\|t\|' <<<"$A403")" -ge 8 ] && ! grep -qE '^[0-9]{2} [^|]*\|f\||ERROR' <<<"$A403" && echo t || grep -E '\|f\||ERROR' <<<"$A403" | head -3)"
SNAP="select p.oid::regprocedure::text || '|' || md5(p.prosrc) || '|' || coalesce(array_to_string(array(select c from unnest(p.proconfig) c where c not like 'lock_timeout=%'), ','), '') || '|' || p.prosecdef
  from pg_proc p where p.pronamespace = 'public'::regnamespace
   and (p.prosrc ~ 'r236|0402|r238|0403|_r342_max_attempts|ops_' or p.proname ~ '^(ops_|_ops402|comms_tick|inbox_tick|runsheet_reminders_tick|pay_details_tick)')
  union all select 'trigger ' || tgrelid::regclass::text || ' ' || tgname::text || ' ' || tgenabled::text from pg_trigger where tgname like 'zz_r402%'
  union all select 'col ' || table_name::text || '.' || column_name::text from information_schema.columns where table_schema = 'public' and column_name = 'next_attempt_at'
  union all select 'table ' || c.relname::text from pg_class c where c.relnamespace = 'public'::regnamespace and c.relname in ('ops_heartbeat', 'ops_send_ledger')
  order by 1"
S1="$(q "$SNAP")"; L1="$(q "select count(*) from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proconfig @> array['lock_timeout=10s']")"
# 2) APPLY-0401 twice
for k in 1 2; do
  A401="$(checks supabase/APPLY-0401.sql)"
  ok "APPLY-0401 paste $k after 0402: 10 check rows, every one true" "$( [ "$(grep -cE '^[0-9]{2} [^|]*\|t$' <<<"$A401")" = 10 ] && ! grep -qE '\|f$|ERROR' <<<"$A401" && echo t || grep -E '\|f$|ERROR' <<<"$A401" | head -3)"
done
# 3) 0402 untouched except the lock_timeout setting
S2="$(q "$SNAP")"
ok "everything 0402 / 0403 made is unchanged (bodies, definer, search_path, triggers, columns, tables: $(wc -l <<<"$S1" | tr -d ' ') facts)" "$( [ "$S1" = "$S2" ] && [ "$(wc -l <<<"$S1" | tr -d ' ')" -ge 40 ] && echo t || diff <(echo "$S1") <(echo "$S2") | head -4)"
ok "the only change to those jobs: lock_timeout=10s (comms_tick, inbox_tick, runsheet_reminders_tick, pay_details_tick), search_path kept" "$(q "select bool_and(p.proconfig @> array['lock_timeout=10s', 'search_path=\"\"']) and count(*) = 4 from pg_proc p where p.oid in (to_regprocedure('public.comms_tick()'), to_regprocedure('public.inbox_tick()'), to_regprocedure('public.runsheet_reminders_tick()'), to_regprocedure('public.pay_details_tick()'))")"
# 4) APPLY-0402 again: still all ok, 0401 kept
A402b="$(checks supabase/APPLY-0402.sql)"
ok "APPLY-0402 pasted again after 0401: every check row ok" "$( ! grep -qE '^[0-9]{2} [^|]*\|f\||ERROR' <<<"$A402b" && [ "$(grep -cE '^[0-9]{2} [^|]*\|t\|' <<<"$A402b")" -ge 15 ] && echo t || grep -E '\|f\||ERROR' <<<"$A402b" | head -3)"
A403b="$(checks supabase/APPLY-0403.sql)"
ok "APPLY-0403 pasted again after 0401: every check row ok" "$( ! grep -qE '^[0-9]{2} [^|]*\|f\||ERROR' <<<"$A403b" && [ "$(grep -cE '^[0-9]{2} [^|]*\|t\|' <<<"$A403b")" -ge 8 ] && echo t || grep -E '\|f\||ERROR' <<<"$A403b" | head -3)"
A401c="$(checks supabase/APPLY-0401.sql)"
ok "... and APPLY-0401's checks still all true (0402 / 0403 do not undo 0401)" "$( [ "$(grep -cE '^[0-9]{2} [^|]*\|t$' <<<"$A401c")" = 10 ] && ! grep -qE '\|f$' <<<"$A401c" && echo t || grep -E '\|f$' <<<"$A401c" | head -3)"
# 5) what a per-function timeout does (this is why 0401 sets lock_timeout, not statement_timeout)
q "create or replace function public.r235_probe_st() returns int language plpgsql set statement_timeout = '200ms' as \$\$ begin perform pg_sleep(0.6); return 1; end \$\$" >/dev/null
F=public.r235_probe_st
ok "a function with SET statement_timeout = 200ms runs 600 ms to the end (the timer is never armed - 0402's per-function 15s never fires)" "$( [ "$(q "select $F()")" = 1 ] && echo t || echo fired)"
ok "a statement_timeout set BEFORE the statement does stop it (the cron-command way: set statement_timeout ...; select job())" "$(PGDATABASE=$DB psql -X -q -A -t -c "set statement_timeout = '200ms'; select $F()" >/dev/null 2>&1 && echo "did not fire" || echo t)"
q "create table public.r235_probe_lock(x int); create or replace function public.r235_probe_lt() returns int language plpgsql set lock_timeout = '300ms' as \$\$ begin lock table public.r235_probe_lock in access exclusive mode; return 1; end \$\$" >/dev/null
( PGDATABASE=$DB psql -X -q -c "begin; lock table public.r235_probe_lock in access exclusive mode; select pg_sleep(3); commit;" >/dev/null 2>&1 & )
sleep 0.7
t0=$(date +%s); LT="$(q "select public.r235_probe_lt()" 2>&1)"; t1=$(date +%s)
ok "a function with SET lock_timeout = 300ms gives up on a held lock (lock timeout error, well before the 3 s holder ends)" "$( grep -q 'lock timeout' <<<"$LT" && [ $((t1 - t0)) -lt 3 ] && echo t || echo "$LT ($((t1 - t0)) s)")"
sleep 2.5
dropdb --if-exists "$DB" >/dev/null 2>&1
[ "$fail" = 0 ] && echo "R235-ORDER-AFTER-0402: PASS" || echo "R235-ORDER-AFTER-0402: FAIL"
