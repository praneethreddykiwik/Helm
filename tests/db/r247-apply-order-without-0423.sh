#!/usr/bin/env bash
# r247-apply-order-without-0423.sh - R247 fix plan Phase 10 (20 Nov 2026): owner decision - Phase 9 (0423-0425) is ON HOLD
# and will NOT be pasted on staging / production for now, although it is in main. APPLY-0427 .. APPLY-0429 must therefore
# work on a database WITHOUT 0423-0425 (no quotes.event_end_date, no _r21_cost_lines__pre0424, no 0423 tax default,
# no 0425 length checks). This builds that state on the disposable local cluster and proves it:
#   1 a database migrated with every MANIFEST entry EXCEPT 0423 / 0424 / 0425 and 0427 / 0428 / 0429 (prod order)
#   2 APPLY-0427, APPLY-0428, APPLY-0429 pasted (no harness switches, like the SQL editor): every check row true;
#     pasted again: every check row still true, nothing doubled
#   3 the 0424 / 0423 objects are still absent afterwards (P10 neither needs nor makes them) and stored events, layout
#     versions and bell notices are untouched (same count + content digest)
#   4 the prod checker reports 0427-0429 present, and only 0423-0425 missing / partial
#   5 later, when the owner does take Phase 9: APPLY-0423 .. 0425 then APPLY-0427 .. 0429 again - every check row true
# Own database (helm_r247no0423), dropped at the end. Prints R247-ORDER-WITHOUT-0423: PASS.
set -uo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/../.."
DB=helm_r247no0423
export PGOPTIONS=""   # like the SQL editor: no harness switches
fail=0; ok() { if [ "$2" = "t" ]; then echo "  ok   $1"; else echo "  FAIL $1 ($2)"; fail=1; fi; }
q() { PGDATABASE=$DB psql -X -q -A -t -v ON_ERROR_STOP=1 -c "$1"; }
checks() { PGDATABASE=$DB psql -X -q -A -t -F '|' -v ON_ERROR_STOP=1 -f "$1" 2>&1; }
allok() { local out="$1" min="$2"; [ "$(grep -cE '^[0-9]{2} [^|]*\|t$' <<<"$out")" -ge "$min" ] && ! grep -qE '^[0-9]{2} [^|]*\|f$|ERROR' <<<"$out" && echo t || { grep -E '\|f$|ERROR' <<<"$out" | head -3; echo "rows=$(grep -cE '^[0-9]{2} [^|]*\|t$' <<<"$out")"; }; }
dropdb --if-exists "$DB" >/dev/null 2>&1; createdb "$DB" || { echo "R247-ORDER-WITHOUT-0423: FAIL (createdb)"; exit 1; }
PGDATABASE=$DB psql -q -v ON_ERROR_STOP=1 -f supabase/test-harness/00-supabase-shim.sql >/dev/null 2>&1
q "create table if not exists public.helm_schema_migrations(filename text primary key, sha256 text not null, applied_at timestamptz not null default now())" >/dev/null
# 1) staging / production with Phase 9 on hold: every MANIFEST entry except 0423-0425 and 0427-0429, in order
n=0; bad=""
while read -r scope path _; do
  [ -z "${scope:-}" ] && continue; case "$scope" in \#*) continue;; esac
  case "$path" in *0423_r246_*|*0424_r246_*|*0425_r246_*|*0427_r247_*|*0428_r247_*|*0429_r247_*) continue;; esac
  PGDATABASE=$DB psql -X -q -v ON_ERROR_STOP=1 -1 -f "$path" >/dev/null 2>&1 || { bad="$path"; break; }
  n=$((n+1))
done < supabase/migrations/MANIFEST
NO9="select not exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'quotes' and column_name = 'event_end_date')
  and to_regprocedure('public._r21_cost_lines__pre0424(uuid,uuid)') is null
  and not exists (select 1 from pg_proc where pronamespace = 'public'::regnamespace and proname like '%\_\_pre0424')
  and not exists (select 1 from pg_constraint where conname like '%\_len425')
  and to_regclass('public.quote_live_signals') is null"
ok "production order built: $n migrations without 0423-0425 / 0427-0429" "$( [ -z "$bad" ] && [ "$(q "$NO9")" = t ] && echo t || echo "stopped at ${bad:-?} / phase 9 objects: $(q "$NO9")")"
PGDATABASE=$DB psql -q -v ON_ERROR_STOP=1 -f supabase/test-harness/10-fixtures.sql >/dev/null 2>&1
QA='a0000000-0000-4000-8000-00000000da01'; ORG='a0000000-0000-4000-8000-000000000001'
q "insert into public.quote_versions(quote_id, version_no, label, data, object_count, org_id) values ('$QA', 1, 'v1', '{\"items\": [{\"id\": \"s1\"}]}'::jsonb, 1, '$ORG') on conflict do nothing" >/dev/null
DIG="select (select count(*) || ':' || md5(coalesce(string_agg(to_jsonb(v)::text, ',' order by v.quote_id, v.version_no), '')) from public.quote_versions v)
  || '|' || (select count(*) || ':' || md5(coalesce(string_agg(to_jsonb(x)::text, ',' order by x.id), '')) from public.quotes x)
  || '|' || (select count(*) || ':' || md5(coalesce(string_agg(to_jsonb(n)::text, ',' order by n.id), '')) from public.notifications n)"
D1="$(q "$DIG")"
# 2) APPLY-0427 .. 0429, twice
for k in 1 2; do
  ok "APPLY-0427 paste $k (no 0423-0425): every check row true" "$(allok "$(checks supabase/APPLY-0427.sql)" 6)"
  ok "APPLY-0428 paste $k (no 0423-0425): every check row true" "$(allok "$(checks supabase/APPLY-0428.sql)" 5)"
  ok "APPLY-0429 paste $k (no 0423-0425): every check row true" "$(allok "$(checks supabase/APPLY-0429.sql)" 5)"
done
ok "after two pastes: one signal trigger per table, one kept __pre0428, one usage trigger, one size cap" "$(q "select (select count(*) from pg_trigger where tgname = 'zz_r427_live_signal') = 2 and (select count(*) from pg_proc where pronamespace = 'public'::regnamespace and proname = 'storage_object_name_ok__pre0428') = 1 and (select count(*) from pg_trigger where tgname = 'zz_r429_usage_check') <= 1 and (select count(*) from pg_constraint where conname = 'quote_versions_data_size_chk427') = 1")"
# 3) Phase 9 still absent, data untouched
NO9B="${NO9%%and to_regclass*}true"
ok "0423-0425 objects still absent (P10 neither needs nor makes them)" "$(q "$NO9B")"
D2="$(q "$DIG")"
ok "events, layout versions, bell notices untouched (same count + content digest)" "$( [ "$D1" = "$D2" ] && echo t || echo "$D1 vs $D2")"
# 4) prod checker
CHK="$(PGDATABASE=$DB psql -X -q -A -t -F '|' -v ON_ERROR_STOP=1 -f supabase/CHECK-PROD-MIGRATIONS.sql 2>&1)"
ok "prod checker: 0427 + 0428 + 0429 present" "$( grep -qE '^0427_r247_layout_live_signals\|present\|' <<<"$CHK" && grep -qE '^0428_r247_stock_upload_cap\|present\|' <<<"$CHK" && grep -qE '^0429_r247_storage_usage\|present\|' <<<"$CHK" && echo t || grep -E '^042[789]' <<<"$CHK" | head -3)"
ok "prod checker: only 0423-0425 missing / partial" "$( ! grep -E '^[^|]+\|(missing|partial)\|' <<<"$CHK" | grep -qvE '^042[345]_r246_' && echo t || grep -E '^[^|]+\|(missing|partial)\|' <<<"$CHK" | grep -vE '^042[345]_r246_' | head -3)"
# 5) Phase 9 taken later: APPLY-0423 .. 0425, then APPLY-0427 .. 0429 again
for f in 0423 0424 0425; do
  out="$(checks supabase/APPLY-$f.sql)"
  ok "later: APPLY-$f after 0427-0429: every check row true" "$( ! grep -qE '^[0-9]{2} [^|]*\|f(\||$)|ERROR' <<<"$out" && [ "$(grep -cE '^[0-9]{2} [^|]*\|t(\||$)' <<<"$out")" -ge 3 ] && echo t || { grep -E '\|f(\||$)|ERROR' <<<"$out" | head -3; echo "rows=$(grep -cE '^[0-9]{2} [^|]*\|t(\||$)' <<<"$out")"; })"
done
ok "later: APPLY-0427 again after 0423-0425: every check row true" "$(allok "$(checks supabase/APPLY-0427.sql)" 6)"
ok "later: APPLY-0428 again after 0423-0425: every check row true" "$(allok "$(checks supabase/APPLY-0428.sql)" 5)"
ok "later: APPLY-0429 again after 0423-0425: every check row true" "$(allok "$(checks supabase/APPLY-0429.sql)" 5)"
dropdb --if-exists "$DB" >/dev/null 2>&1
[ "$fail" = 0 ] && echo "R247-ORDER-WITHOUT-0423: PASS" || echo "R247-ORDER-WITHOUT-0423: FAIL"
