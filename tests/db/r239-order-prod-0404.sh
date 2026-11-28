#!/usr/bin/env bash
# r239-order-prod-0404.sh - R239 (coordinator, 20 Nov 2026): the real production order. Staging + prod already have every
# migration up to 0400, then APPLY-0402, APPLY-0403 and APPLY-0401 were pasted IN THAT ORDER (0401 last). This builds that
# order on the disposable local cluster - every MANIFEST entry except 0401 and 0404, then APPLY-0402, APPLY-0403, APPLY-0401
# pasted like the SQL editor - and then pastes APPLY-0404 TWICE: every check row true both times, nothing created twice,
# and the 0404 behaviour suite (tests/db/r239-money-safety-0404.sql, rolled back) passes on that database.
# Self-contained: its own database (helm_r239order_<pid>), dropped at the end; reads nothing run-all left behind. The
# function fingerprint is ordered by name (a stable order), and every failing check is repeated on the last line. Prints R239-ORDER-PROD-0404: PASS.
# R244: before 0404 it adds the hand-applied Wave 16 rule quote_payments_amount_pos (amount > 0) that staging + prod carry.
set -uo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/../.."
DB="helm_r239order_$$"
HARNESS_OPTS="${PGOPTIONS:-}"
export PGOPTIONS=""   # like the SQL editor: no harness switches
fail=0; FAILS=""; ok() { if [ "$2" = "t" ]; then echo "  ok   $1"; else echo "  FAIL $1 ($2)"; fail=1; FAILS="$FAILS | $1 ($2)"; fi; }
q() { PGDATABASE=$DB psql -X -q -A -t -v ON_ERROR_STOP=1 -c "$1"; }
paste() { PGDATABASE=$DB psql -X -q -A -t -F '|' -v ON_ERROR_STOP=1 -f "$1" 2>&1; }
allok() { local out="$1" min="$2"; if [ "$(grep -cE '^[0-9]{2} [^|]*\|t(\||$)' <<<"$out")" -ge "$min" ] && ! grep -qE '^[0-9]{2} [^|]*\|f(\||$)|ERROR' <<<"$out"; then echo t; else grep -E '\|f(\||$)|ERROR' <<<"$out" | head -3; fi; }
dropdb --if-exists "$DB" >/dev/null 2>&1; createdb "$DB" || { echo "R239-ORDER-PROD-0404: FAIL (createdb)"; exit 1; }
PGDATABASE=$DB psql -q -v ON_ERROR_STOP=1 -f supabase/test-harness/00-supabase-shim.sql >/dev/null 2>&1
q "create table if not exists public.helm_schema_migrations(filename text primary key, sha256 text not null, applied_at timestamptz not null default now())" >/dev/null
n=0; bad=""
while read -r scope path _; do
  [ -z "${scope:-}" ] && continue; case "$scope" in \#*) continue;; esac
  case "$path" in *0401_r235_db_load.sql|*0404_r239_money_safety.sql|*0435_r252_*|*0437_r254_*|*0438_r254_*|*0445_r258_*|*0450_r261_*|*0455_r271_*) continue;; esac   # 0438 + 0445 need 0401, 0435 + 0450 need 0404, 0437 needs 0435, 0455 needs 0450 (later in real life)
  PGDATABASE=$DB PGOPTIONS="$HARNESS_OPTS" psql -X -q -v ON_ERROR_STOP=1 -1 -f "$path" >/dev/null 2>&1 || { bad="$path"; break; }
  n=$((n+1))
done < supabase/migrations/MANIFEST
ok "production before 0404: $n migrations, no 0401 / 0404 yet" "$( [ -z "$bad" ] && [ "$(q "select to_regprocedure('public.money_void(text,uuid,text,text)') is null and to_regprocedure('public._r401_sync()') is null")" = t ] && echo t || echo "stopped at ${bad:-?}")"
ok "APPLY-0402 pasted: every check row ok" "$(allok "$(paste supabase/APPLY-0402.sql)" 10)"
ok "APPLY-0403 pasted: every check row ok" "$(allok "$(paste supabase/APPLY-0403.sql)" 8)"
ok "APPLY-0401 pasted after them (the real order): every check row ok" "$(allok "$(paste supabase/APPLY-0401.sql)" 10)"
# R244: staging + production also carry the hand-applied Wave 16 rule quote_payments_amount_pos (amount > 0, validated) - add it
# exactly as the owner's CHECK-0404-PAYMENT-CHECKS showed on staging, so 0404 is proven against the real constraint set
q "alter table public.quote_payments add constraint quote_payments_amount_pos check (amount > 0)" >/dev/null
ok "staging constraint set before 0404: amount_pos (amount > 0) present and validated" "$(q "select exists (select 1 from pg_constraint where conrelid = 'public.quote_payments'::regclass and conname = 'quote_payments_amount_pos' and convalidated and pg_get_constraintdef(oid) = 'CHECK ((amount > (0)::numeric))')")"
ok "APPLY-0404 pasted (1st): all 12 check rows ok" "$(allok "$(paste supabase/APPLY-0404.sql)" 12)"
H1="$(q "select md5(string_agg(p.oid::regprocedure::text || md5(p.prosrc), ',' order by p.oid::regprocedure::text)) from pg_proc p where p.pronamespace = 'public'::regnamespace")"
ok "APPLY-0404 pasted (2nd): all 12 check rows ok" "$(allok "$(paste supabase/APPLY-0404.sql)" 12)"
ok "the second paste changed no function and made no extra copy" "$( [ "$H1" = "$(q "select md5(string_agg(p.oid::regprocedure::text || md5(p.prosrc), ',' order by p.oid::regprocedure::text)) from pg_proc p where p.pronamespace = 'public'::regnamespace")" ] && [ "$(q "select count(*) from pg_proc where proname like '%\_\_pre0404\_\_pre0404'")" = 0 ] && echo t || echo changed)"
ok "R244: amount_pos re-issued under the same name, still validated, still > 0 for a normal payment, minus only on a reversal" "$(q "select exists (select 1 from pg_constraint where conrelid = 'public.quote_payments'::regclass and conname = 'quote_payments_amount_pos' and convalidated and pg_get_constraintdef(oid) like '%amount > (0)::numeric%' and pg_get_constraintdef(oid) like '%reverses_payment_id IS NOT NULL%amount < (0)::numeric%') and (select count(*) from pg_constraint where conrelid = 'public.quote_payments'::regclass and conname = 'quote_payments_amount_pos') = 1")"
ok "0401 untouched by 0404 (its sync helper still answers)" "$(q "select to_regprocedure('public._r401_sync()') is not null and position('r239-money-0404' in pg_get_functiondef('public._r401_sync()'::regprocedure)) = 0")"
PGDATABASE=$DB PGOPTIONS="$HARNESS_OPTS" psql -q -v ON_ERROR_STOP=1 -f supabase/test-harness/10-fixtures.sql >/dev/null 2>&1
SUITE="$(PGDATABASE=$DB PGOPTIONS="$HARNESS_OPTS" psql -q -f tests/db/r239-money-safety-0404.sql 2>&1)"
ok "the 0404 behaviour suite passes on the production-order database" "$(grep -q 'R239-MONEY-SAFETY-0404: ALL PASS' <<<"$SUITE" && echo t || grep -E 'R239-MONEY|FAIL' <<<"$SUITE" | head -3)"
dropdb --if-exists "$DB" >/dev/null 2>&1
if [ "$fail" = 0 ]; then echo "R239-ORDER-PROD-0404: PASS"; else echo "R239-ORDER-PROD-0404: FAIL$FAILS"; exit 1; fi
