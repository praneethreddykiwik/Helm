#!/usr/bin/env bash
# r241-apply-order-0407.sh - R241 fix plan Phase 4 (20 Nov 2026): the REAL production order. Staging / production have
# every MANIFEST entry up to 0403 (0404 / 0405 / 0406 are parallel PRs that may land before or after); the owner then
# pastes APPLY-0407 and APPLY-0408 in the SQL editor (no harness switches). This builds that state on the disposable
# local cluster and proves it is safe:
#   1 a database migrated with every MANIFEST entry EXCEPT 0407 / 0408
#   2 APPLY-0407 then APPLY-0408 pasted: every check row true; pasted again: every check row still true, nothing doubled
#   3 the layout rows and the event rows are untouched (same count + content digest before / after)
#   4 the prod checker (CHECK-PROD-MIGRATIONS.sql) then reports 0407 + 0408 present (and nothing missing / partial)
#   5 a signed-in admin can save with a base version, gets the conflict on a stale one, and the old call still works
# Own database (helm_r241order), dropped at the end. Prints R241-APPLY-ORDER-0407: PASS.
set -uo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/../.."
DB=helm_r241order
export PGOPTIONS=""   # like the SQL editor: no harness switches
fail=0; ok() { if [ "$2" = "t" ]; then echo "  ok   $1"; else echo "  FAIL $1 ($2)"; fail=1; fi; }
q() { PGDATABASE=$DB psql -X -q -A -t -v ON_ERROR_STOP=1 -c "$1"; }
checks() { PGDATABASE=$DB psql -X -q -A -t -F '|' -v ON_ERROR_STOP=1 -f "$1" 2>&1; }
allok() { local out="$1" min="$2"; [ "$(grep -cE '^0[0-9] [^|]*\|t\|' <<<"$out")" -ge "$min" ] && ! grep -qE '^0[0-9] [^|]*\|f\||ERROR' <<<"$out" && echo t || grep -E '\|f\||ERROR' <<<"$out" | head -3; }
dropdb --if-exists "$DB" >/dev/null 2>&1; createdb "$DB" || { echo "R241-APPLY-ORDER-0407: FAIL (createdb)"; exit 1; }
PGDATABASE=$DB psql -q -v ON_ERROR_STOP=1 -f supabase/test-harness/00-supabase-shim.sql >/dev/null 2>&1
q "create table if not exists public.helm_schema_migrations(filename text primary key, sha256 text not null, applied_at timestamptz not null default now())" >/dev/null
# 1) production today: every MANIFEST entry except 0407 / 0408, in order, one transaction each (like scripts/db-migrate.sh)
n=0; bad=""
while read -r scope path _; do
  [ -z "${scope:-}" ] && continue; case "$scope" in \#*) continue;; esac
  case "$path" in *0407_r241_*|*0408_r241_*) continue;; esac
  PGDATABASE=$DB psql -X -q -v ON_ERROR_STOP=1 -1 -f "$path" >/dev/null 2>&1 || { bad="$path"; break; }
  n=$((n+1))
done < supabase/migrations/MANIFEST
ok "production order built: $n migrations without 0407 / 0408" "$( [ -z "$bad" ] && [ "$(q "select to_regprocedure('public.add_quote_version_checked(uuid,text,jsonb,integer,integer,boolean)') is null and to_regprocedure('public.add_quote_version(uuid,text,jsonb,integer)') is not null and not exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'quotes' and column_name = 'meta_rev')")" = t ] && echo t || echo "stopped at ${bad:-?}")"
PGDATABASE=$DB psql -q -v ON_ERROR_STOP=1 -f supabase/test-harness/10-fixtures.sql >/dev/null 2>&1
QA='a0000000-0000-4000-8000-00000000da01'; ORG='a0000000-0000-4000-8000-000000000001'
q "insert into public.quote_versions(quote_id, version_no, label, data, object_count, org_id) values ('$QA', 1, 'v1', '{\"items\": [{\"id\": \"s1\"}]}'::jsonb, 1, '$ORG'), ('$QA', 2, 'v2', '{\"items\": [{\"id\": \"s1\"}, {\"id\": \"t1\"}]}'::jsonb, 2, '$ORG') on conflict do nothing" >/dev/null
q "update public.quotes set current_version = 2 where id = '$QA'" >/dev/null
DIG="select (select count(*) || ':' || md5(coalesce(string_agg(quote_id || '/' || version_no || '/' || md5(data::text) || '/' || coalesce(label, ''), ',' order by quote_id, version_no), '')) from public.quote_versions)
  || '|' || (select count(*) || ':' || md5(coalesce(string_agg(id || '/' || coalesce(title, '') || '/' || md5(coalesce(client::text, '')) || '/' || md5(coalesce(pricing::text, '')) || '/' || coalesce(current_version, 0), ',' order by id), '')) from public.quotes)"
D1="$(q "$DIG")"
# 2) APPLY-0407 + APPLY-0408, twice
for k in 1 2; do
  ok "APPLY-0407 paste $k: every check row true" "$(allok "$(checks supabase/APPLY-0407.sql)" 6)"
  ok "APPLY-0408 paste $k: every check row true" "$(allok "$(checks supabase/APPLY-0408.sql)" 6)"
done
ok "after two pastes: one add_quote_version_checked, one kept __pre0407, one meta_rev trigger" "$(q "select (select count(*) from pg_proc where pronamespace = 'public'::regnamespace and proname = 'add_quote_version_checked') = 1 and (select count(*) from pg_proc where pronamespace = 'public'::regnamespace and proname = 'add_quote_version__pre0407') = 1 and (select count(*) from pg_trigger where tgname = 'zzzzz_r408_meta_rev') = 1")"
# 3) data untouched
D2="$(q "$DIG")"
ok "layout versions + events untouched (same count + content digest)" "$( [ "$D1" = "$D2" ] && echo t || echo "$D1 vs $D2")"
# 4) prod checker
CHK="$(PGDATABASE=$DB psql -X -q -A -t -F '|' -v ON_ERROR_STOP=1 -f supabase/CHECK-PROD-MIGRATIONS.sql 2>&1)"
ok "prod checker: 0407 + 0408 present" "$( grep -qE '^0407_r241_layout_save_conflict\|present\|' <<<"$CHK" && grep -qE '^0408_r241_quote_meta_rev\|present\|' <<<"$CHK" && echo t || grep -E '^040[78]' <<<"$CHK" | head -2)"
ok "prod checker: nothing missing / partial" "$( ! grep -qE '^[^|]+\|(missing|partial)\|' <<<"$CHK" && echo t || grep -E '^[^|]+\|(missing|partial)\|' <<<"$CHK" | head -3)"
# 5) the calls as a signed-in admin
UID_A="$(q "select id from auth.users where email = 'a_admin@a.test'")"
sql5() { cat <<SQL
\o /dev/null
select set_config('request.jwt.claims', '{"sub":"$UID_A","role":"authenticated","email":"a_admin@a.test","aal":"aal1"}', false);
set role authenticated;
\o
select (public.add_quote_version_checked('$QA', null, '{"items": []}'::jsonb, 0, 2, false) #>> '{version,version_no}');
select public.add_quote_version_checked('$QA', null, '{"items": []}'::jsonb, 0, 1, false) ->> 'conflict';
select (public.add_quote_version('$QA', null, '{"items": []}'::jsonb, 0)).version_no;
SQL
}
R="$(sql5 | PGDATABASE=$DB psql -X -q -A -t -v ON_ERROR_STOP=1 2>&1)"
ok "signed-in admin: base V2 -> V3 saved, stale base V1 -> newer_version, old call -> V4" "$( [ "$(tr '\n' ' ' <<<"$R")" = "3 newer_version 4 " ] && echo t || echo "$R")"
dropdb --if-exists "$DB" >/dev/null 2>&1
[ "$fail" = 0 ] && echo "R241-APPLY-ORDER-0407: PASS" || echo "R241-APPLY-ORDER-0407: FAIL"
