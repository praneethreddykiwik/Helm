#!/usr/bin/env bash
# r254-order-0438.sh - R254 (0438) on a throw-away copy of the test database:
#   1 APPLY-0438 twice; APPLY-0434, 0436 and 0437 pasted again later, then 0438 again: every check row true, kept bodies once
#   2 two people move the same tasks at the same moment, in opposite order (two REAL sessions): no deadlock, the second one wins, both logged
#   3 two people give the same work with the same request key at the same moment: made once
#   4 switched off (trigger disabled): new tasks get no step; the prod checker finds 0438
# Local disposable PG only. Fake data only. Dropped at the end.
set -u
DB=helm_r254_order8; fail=0
ok() { if [ "$2" = t ]; then echo "  ok  $1"; else echo "  FAIL $1 (${2:-})"; fail=1; fi; }
SRC="$(psql -X -At -c 'select current_database()')"
dropdb --if-exists "$DB" >/dev/null 2>&1; createdb -T "$SRC" "$DB" || exit 1
export PGDATABASE="$DB"
q() { psql -X -q -At -c "$1" 2>&1; }
checks() { psql -X -q -A -t -F '|' -v ON_ERROR_STOP=1 -f "$1" 2>&1; }
allok() { [ "$(grep -cE '^[0-9]{2} [^|]*\|t$' <<<"$1")" = "$2" ] && ! grep -qE '\|f$|ERROR' <<<"$1" && echo t || { grep -E '\|f$|ERROR' <<<"$1" | head -3; }; }
checks supabase/APPLY-0437.sql >/dev/null
for k in 1 2; do ok "1 0438 paste $k" "$(allok "$(checks supabase/APPLY-0438.sql)" 11)"; done
ok "1 0434 again: 14 rows" "$(allok "$(checks supabase/APPLY-0434.sql)" 14)"
ok "1 0436 again: 15 rows" "$(allok "$(checks supabase/APPLY-0436.sql)" 15)"
ok "1 0437 again: 11 rows" "$(allok "$(checks supabase/APPLY-0437.sql)" 11)"
ok "1 0438 again after the older files: 11 rows, kept bodies once" "$(allok "$(checks supabase/APPLY-0438.sql)" 11)"
ok "1 no kept copy of a kept copy" "$(q "select count(*) = 2 from pg_proc where proname like '%\_\_pre0438'")"
A=a0000000-0000-4000-8000-000000000001; Q=a0000000-0000-4000-8000-000043810001; T1=a0000000-0000-4000-8000-000043810101; T2=a0000000-0000-4000-8000-000043810102
U="$(q "select id from auth.users where email = 'a_admin@a.test'")"
q "insert into public.quotes (id, code, title, status, lifecycle_stage, client, pricing, approval_status, org_id, event_date, current_version) values ('$Q', 'R438-O1', 'Order', 'confirmed', 'planning', '{\"name\":\"R\"}', '{\"subtotal\":1000,\"discount\":0,\"gstPct\":0,\"total\":1000}', 'none', '$A', '2027-01-10', 1);
   insert into public.event_tasks (id, quote_id, org_id, category, title, status, step) values ('$T1', '$Q', '$A', 'O', 'O1', 'assigned', 'pre'), ('$T2', '$Q', '$A', 'O', 'O2', 'assigned', 'pre')" >/dev/null
O1="$(mktemp)"; O2="$(mktemp)"
(psql -X -q -At -c "begin; select auth.login_as('$U'); select public.set_task_step(array['$T1', '$T2']::uuid[], 'onday'); select pg_sleep(1.5); commit" >"$O1" 2>&1) & P1=$!
sleep 0.4; psql -X -q -At -c "begin; select auth.login_as('$U'); select public.set_task_step(array['$T2', '$T1']::uuid[], 'wrapup'); commit" >"$O2" 2>&1; wait $P1
ok "2 opposite order at the same moment: no deadlock, the second one wins" "$(! grep -qE 'ERROR' "$O1" "$O2" && [ "$(q "select string_agg(step, ',') from public.event_tasks where id in ('$T1', '$T2')")" = wrapup,wrapup ] && echo t || cat "$O1" "$O2")"
ok "2 every move is in the log" "$(q "select count(*) = 4 from public.event_task_log where quote_id = '$Q' and kind = 'step_changed'")"
C="begin; select auth.login_as('$U'); select public.assign_tasks_step_once('$Q', 'O', array['Keyed'], null, 'Anu', '+919000043800', 'wrapup', 'a0000000-0000-4000-8000-0000438100aa')"
(psql -X -q -At -c "$C; select pg_sleep(1.5); commit" >"$O1" 2>&1) & P1=$!
sleep 0.4; psql -X -q -At -c "$C; commit" >"$O2" 2>&1; wait $P1
ok "3 the same key at the same moment: one task" "$([ "$(q "select count(*) || coalesce(max(step), '') from public.event_tasks where quote_id = '$Q' and title = 'Keyed'")" = 1wrapup ] && grep -q replayed "$O2" && echo t || cat "$O1" "$O2")"
rm -f "$O1" "$O2"
q "alter table public.event_tasks disable trigger zz_r438_step_default; insert into public.event_tasks (quote_id, org_id, category, title, status) values ('$Q', '$A', 'O', 'Off', 'unassigned')" >/dev/null
ok "4 switched off: no step" "$(q "select step is null from public.event_tasks where quote_id = '$Q' and title = 'Off'")"
q "alter table public.event_tasks enable trigger zz_r438_step_default" >/dev/null
CHK="$(checks supabase/CHECK-PROD-MIGRATIONS.sql)"
ok "4 the checker finds 0438" "$(grep -qE '^0438_r254_task_steps\|present\|' <<<"$CHK" && echo t || grep -E '^0438' <<<"$CHK")"
export PGDATABASE="$SRC"; dropdb --if-exists "$DB" >/dev/null 2>&1
[ "$fail" = 0 ] && echo "R254-ORDER-0438: PASS" || { echo "R254-ORDER-0438: FAILED"; exit 1; }
