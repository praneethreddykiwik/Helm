#!/usr/bin/env bash
# r245-apply-order-0413.sh - R245 fix plan Phase 6 (20 Nov 2026): the REAL staging / production order. Phase 9
# (0423-0425, #485) is ON HOLD by owner decision: its SQL is in main but will NOT be pasted on staging / production for
# now. So staging / production have every MANIFEST entry EXCEPT 0413-0415 (this PR) and 0423-0425 (on hold); the owner
# then pastes APPLY-0413, APPLY-0414, APPLY-0415 in the SQL editor (no harness switches). This builds that state on the
# disposable local cluster and proves APPLY-0413..0415 never need 0423-0425:
#   1 a database migrated with every MANIFEST entry except 0413-0415 and 0423-0425 (0423-0425 objects really absent)
#   2 APPLY-0413, -0414, -0415 pasted: every check row true; pasted again: every check row still true
#   3 the prod checker then reports 0413-0415 present, 0423-0425 missing (on hold), nothing else missing / partial
#   4 the 0413 guard works: deleting a used studio member's login is refused (rolled back)
# Own database (helm_r245order), dropped at the end. Prints R245-APPLY-ORDER-0413: PASS.
set -uo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/../.."
DB=helm_r245order
export PGOPTIONS=""   # like the SQL editor: no harness switches
fail=0; ok() { if [ "$2" = "t" ]; then echo "  ok   $1"; else echo "  FAIL $1 ($2)"; fail=1; fi; }
q() { PGDATABASE=$DB psql -X -q -A -t -v ON_ERROR_STOP=1 -c "$1"; }
checks() { PGDATABASE=$DB psql -X -q -A -t -F '|' -v ON_ERROR_STOP=1 -f "$1" 2>&1; }
allok() { local out="$1" min="$2"; [ "$(grep -cE '^0[0-9] [^|]*\|t\|' <<<"$out")" -ge "$min" ] && ! grep -qE '^0[0-9] [^|]*\|f\||ERROR' <<<"$out" && echo t || grep -E '\|f\||ERROR' <<<"$out" | head -3; }
dropdb --if-exists "$DB" >/dev/null 2>&1; createdb "$DB" || { echo "R245-APPLY-ORDER-0413: FAIL (createdb)"; exit 1; }
PGDATABASE=$DB psql -q -v ON_ERROR_STOP=1 -f supabase/test-harness/00-supabase-shim.sql >/dev/null 2>&1
q "create table if not exists public.helm_schema_migrations(filename text primary key, sha256 text not null, applied_at timestamptz not null default now())" >/dev/null
# 1) staging / production today: every MANIFEST entry except 0413-0415 and 0423-0425, in order, one transaction each
n=0; bad=""
while read -r scope path _; do
  [ -z "${scope:-}" ] && continue; case "$scope" in \#*) continue;; esac
  case "$path" in *041[345]_r245_*|*042[345]_r246_*) continue;; esac
  PGDATABASE=$DB psql -X -q -v ON_ERROR_STOP=1 -1 -f "$path" >/dev/null 2>&1 || { bad="$path"; break; }
  n=$((n+1))
done < supabase/migrations/MANIFEST
ok "production order built: $n migrations without 0413-0415 and without 0423-0425" "$( [ -z "$bad" ] && echo t || echo "stopped at $bad")"
ok "0423-0425 really absent (no quotes.event_end_date, no 0423 trigger) and 0413 not in yet" "$(q "select not exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'quotes' and column_name = 'event_end_date') and not exists (select 1 from pg_trigger where tgname = 'ab_r423_gst_default') and to_regprocedure('public._r413_login_delete_allowed(uuid,uuid)') is null")"
PGDATABASE=$DB psql -q -v ON_ERROR_STOP=1 -f supabase/test-harness/10-fixtures.sql >/dev/null 2>&1
# 2) APPLY-0413 .. APPLY-0415, twice
for k in 1 2; do
  for f in 0413 0414 0415; do ok "APPLY-$f paste $k: every check row true" "$(allok "$(checks supabase/APPLY-$f.sql)" 4)"; done
done
# 3) prod checker
CHK="$(PGDATABASE=$DB psql -X -q -A -t -F '|' -v ON_ERROR_STOP=1 -f supabase/CHECK-PROD-MIGRATIONS.sql 2>&1)"
ok "prod checker: 0413 + 0414 + 0415 present" "$( [ "$(grep -cE '^041[345]_r245_[a-z_]+\|present\|' <<<"$CHK")" = 3 ] && echo t || grep -E '^041[345]' <<<"$CHK" | head -3)"
ok "prod checker: only 0423-0425 (on hold) not present, nothing else missing / partial" "$( ! grep -E '^[^|]+\|(missing|partial)\|' <<<"$CHK" | grep -qvE '^042[345]_r246_' && echo t || grep -E '^[^|]+\|(missing|partial)\|' <<<"$CHK" | grep -vE '^042[345]_r246_' | head -3)"
# 4) the guard on this database: a used studio member's login cannot be deleted (rolled back either way)
R="$(PGDATABASE=$DB psql -X -q -A -t 2>&1 <<'SQL'
begin;
update auth.users set email_confirmed_at = coalesce(email_confirmed_at, now()) where email = 'a_admin@a.test';
delete from auth.users where email = 'a_admin@a.test';
rollback;
SQL
)"
ok "0413 guard: deleting a used studio member's login is refused" "$(grep -q 'Deactivate them in Settings' <<<"$R" && echo t || echo "$R" | tail -2)"
ok "the login is still there" "$(q "select exists (select 1 from auth.users where email = 'a_admin@a.test')")"
dropdb --if-exists "$DB" >/dev/null 2>&1
[ "$fail" = 0 ] && echo "R245-APPLY-ORDER-0413: PASS" || echo "R245-APPLY-ORDER-0413: FAIL"
