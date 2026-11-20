#!/usr/bin/env bash
# r241-qv-race-0407.sh - R241 fix plan Phase 4 (DB-07 / Q-03 + FE-01 / Q-01): TWO real sessions save the same event at the
# same moment. Session A saves and keeps its transaction open 2 s; session B saves during that time.
#   1 the OLD numbering (add_quote_version__pre0407 = the 0144 wrapper, max+1 without a lock) reproduces the bug: B fails
#     with duplicate key 23505 ("Autosave failed") - proof the test really races
#   2 the old pages' call add_quote_version (0407: per-event lock): B waits for A, then gets the next number - no error,
#     numbers 1..n with no gap, nothing lost
#   3 the new call add_quote_version_checked with the SAME base in both sessions: A saves, B waits, then sees A's newer
#     version and is answered with the conflict - nothing written by B, A's version intact
#   4 another event is never held up by the lock (B on a different event finishes while A still holds its transaction)
# Runs on the run-all database (PG* env), signed in as the fixture studio-A admin. Cleans up its own rows.
# Prints R241-QV-RACE-0407: PASS.
set -uo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/../.."
fail=0; ok() { if [ "$2" = "t" ]; then echo "  ok   $1"; else echo "  FAIL $1 ($2)"; fail=1; fi; }
q() { psql -X -q -A -t -v ON_ERROR_STOP=1 -c "$1"; }
QA='a0000000-0000-4000-8000-00000000da01'; ORG='a0000000-0000-4000-8000-000000000001'; Q2='a0000000-0000-4000-8000-0000000e0407'
UID_A="$(q "select id from auth.users where email = 'a_admin@a.test'")"
[ -n "$UID_A" ] || { echo "R241-QV-RACE-0407: FAIL (fixture admin missing)"; exit 1; }
SIGNIN="\\o /dev/null
select set_config('request.jwt.claims', '{\"sub\":\"$UID_A\",\"role\":\"authenticated\",\"email\":\"a_admin@a.test\",\"aal\":\"aal1\"}', false); set role authenticated;
\\o"
reset_rows() {
  q "delete from public.quote_versions where quote_id in ('$QA', '$Q2')" >/dev/null
  q "insert into public.quote_versions(quote_id, version_no, label, data, object_count, org_id, created_by) values ('$QA', 1, 'race base', '{\"items\": []}'::jsonb, 0, '$ORG', '$UID_A')" >/dev/null
  q "update public.quotes set current_version = 1 where id = '$QA'" >/dev/null
}
q "insert into public.quotes(id, code, title, status, client, pricing, current_version, approval_status, org_id, created_at, updated_at)
   values ('$Q2', 'A-0407R', 'Race other event', 'quote', '{\"name\": \"Other\"}'::jsonb, '{\"subtotal\": 1000, \"discount\": 0, \"gstPct\": 18, \"total\": 1180}'::jsonb, 1, 'none', '$ORG', now(), now())
   on conflict (id) do nothing" >/dev/null
# A: one save, transaction held open 2 s
hold_a() { psql -X -q -A -t -v ON_ERROR_STOP=1 >/dev/null 2>&1 <<SQL
$SIGNIN
begin;
select $1;
select pg_sleep(2);
commit;
SQL
}
# B: one save while A holds (prints the answer or the error)
run_b() { psql -X -q -A -t -v ON_ERROR_STOP=1 2>&1 <<SQL
$SIGNIN
select $1;
SQL
}

# 1) the old numbering reproduces the bug (owner call: the kept 0144 wrapper, granted to the test session for this probe only)
reset_rows
q "grant execute on function public.add_quote_version__pre0407(uuid,text,jsonb,integer) to authenticated" >/dev/null
hold_a "(public.add_quote_version__pre0407('$QA', 'A', '{\"items\": [1]}'::jsonb, 1)).version_no" & AP=$!
sleep 0.6
B1="$(run_b "(public.add_quote_version__pre0407('$QA', 'B', '{\"items\": [2]}'::jsonb, 1)).version_no")"
wait $AP
q "revoke execute on function public.add_quote_version__pre0407(uuid,text,jsonb,integer) from authenticated" >/dev/null
ok "before 0407 (max+1, no lock): the second save at the same moment fails with duplicate key 23505" "$(grep -q 'duplicate key value violates unique constraint' <<<"$B1" && echo t || echo "B said: $B1")"

# 2) old pages after 0407: B waits, then gets the next number
reset_rows
hold_a "(public.add_quote_version('$QA', 'A', '{\"items\": [1]}'::jsonb, 1)).version_no" & AP=$!
sleep 0.6
B2="$(run_b "(public.add_quote_version('$QA', 'B', '{\"items\": [2]}'::jsonb, 1)).version_no || '|' || round(extract(epoch from clock_timestamp() - now()) * 1000)")"
wait $AP
ok "add_quote_version (old pages) after 0407: B waited for A (>= 1 s) and got V3 - no error" "$( [ "${B2%%|*}" = "3" ] && [ "${B2##*|}" -ge 1000 ] 2>/dev/null && echo t || echo "B said: $B2 (number|ms)")"
ok "... the event holds V1, V2 (A), V3 (B) - same numbering, nothing lost, the quote points at V3" "$(q "select string_agg(version_no || ':' || coalesce(label, ''), ',' order by version_no) = '1:race base,2:A,3:B' and (select current_version from public.quotes where id = '$QA') = 3 from public.quote_versions where quote_id = '$QA'")"

# 3) the new call, both sessions on base V1: A saves, B is told about A's newer version
reset_rows
hold_a "public.add_quote_version_checked('$QA', 'A', '{\"items\": [1]}'::jsonb, 1, 1, false)" & AP=$!
sleep 0.6
B3="$(run_b "public.add_quote_version_checked('$QA', 'B', '{\"items\": [2]}'::jsonb, 1, 1, false)::text")"
wait $AP
ok "checked save, same base in both sessions: B is answered newer_version (latest V2), no error" "$(grep -q '"conflict": "newer_version"' <<<"$B3" && grep -q '"latest_version": 2' <<<"$B3" && echo t || echo "B said: $B3")"
ok "... nothing written by B: the event holds V1 + A's V2 only, A's layout intact" "$(q "select string_agg(version_no || ':' || coalesce(label, ''), ',' order by version_no) = '1:race base,2:A' and (select data from public.quote_versions where quote_id = '$QA' and version_no = 2) = '{\"items\": [1]}'::jsonb from public.quote_versions where quote_id = '$QA'")"
B3b="$(run_b "public.add_quote_version_checked('$QA', 'B kept', '{\"items\": [2]}'::jsonb, 1, 1, true)::text")"
ok "... B then chooses Save mine as a new version: V3 appended, V2 kept" "$(grep -q '"version_no": 3' <<<"$B3b" && [ "$(q "select string_agg(version_no::text, ',' order by version_no) from public.quote_versions where quote_id = '$QA'")" = "1,2,3" ] && echo t || echo "B said: $B3b")"

# 4) the lock is per event
reset_rows
hold_a "(public.add_quote_version('$QA', 'A', '{\"items\": [1]}'::jsonb, 1)).version_no" & AP=$!
sleep 0.6
B4="$(run_b "(public.add_quote_version('$Q2', 'other', '{\"items\": []}'::jsonb, 0)).version_no || '|' || round(extract(epoch from clock_timestamp() - now()) * 1000)")"
wait $AP
ok "another event is not held up: its save finished (< 0.8 s) while A still held its transaction" "$( [ "${B4%%|*}" = "1" ] && [ "${B4##*|}" -lt 800 ] 2>/dev/null && echo t || echo "B said: $B4 (number|ms)")"

q "delete from public.quote_versions where quote_id = '$Q2'" >/dev/null
q "delete from public.r407_legacy_calls" >/dev/null
reset_rows
q "delete from public.quote_versions where quote_id = '$QA'" >/dev/null
q "update public.quotes set current_version = 1 where id = '$QA'" >/dev/null
q "delete from public.quotes where id = '$Q2'" >/dev/null 2>&1 || true
[ "$fail" = 0 ] && echo "R241-QV-RACE-0407: PASS" || echo "R241-QV-RACE-0407: FAIL"
