#!/usr/bin/env bash
# r253-order-0436.sh - R253: the orders the owner may really paste in, on a throw-away copy of the test database.
#   1 0434 pasted again after 0436: every 0434 check row true, start-now goes back to the 0434 words (nothing broken)
#   2 0436 pasted again: every check row true, each kept body once
#   3 an older 0399 pasted again + 0436 again: every 0436 check row true
#   4 switched off: zzz_r436_rework / zzz_r434_start_now disabled = a finished / rejected task tells nobody, the change goes through
#   6 two people closing a circle at the same moment (two REAL sessions): exactly one of them is refused
#   5 the prod checker reports 0434 and 0436 present
# Local disposable PG only. Dropped at the end.
set -u
DB=helm_r253_order; fail=0
ok() { if [ "$2" = t ]; then echo "  ok  $1"; else echo "  FAIL $1 (${2:-})"; fail=1; fi; }
SRC="$(psql -X -At -c 'select current_database()')"
dropdb --if-exists "$DB" >/dev/null 2>&1; createdb -T "$SRC" "$DB" || exit 1
export PGDATABASE="$DB"
q() { psql -X -q -At -c "$1" 2>&1; }
checks() { psql -X -q -A -t -F '|' -v ON_ERROR_STOP=1 -f "$1" 2>&1; }
allok() { [ "$(grep -cE '^[0-9]{2} [^|]*\|t$' <<<"$1")" = "$2" ] && ! grep -qE '\|f$|ERROR' <<<"$1" && echo t || { grep -E '\|f$|ERROR' <<<"$1" | head -3; }; }
ok "0436" "$(allok "$(checks supabase/APPLY-0436.sql)" 15)"
ok "1 0434 again after 0436: all 14 rows" "$(allok "$(checks supabase/APPLY-0434.sql)" 14)"
ok "1 the 0434 body is back, the rework trigger stays" "$(q "select position('_r434_closed' in pg_get_functiondef('public._r434_tg_start_now()'::regprocedure)) > 0 and exists (select 1 from pg_trigger where tgname = 'zzz_r436_rework')")"
ok "2 0436 again: all 15 rows" "$(allok "$(checks supabase/APPLY-0436.sql)" 15)"
ok "2 kept bodies once, no kept copy of a kept copy" "$(q "select count(*) = 8 from pg_proc where proname like '%\_\_pre0436'")"
checks supabase/APPLY-0399.sql >/dev/null
ok "3 0436 after an older 0399: all 15 rows" "$(allok "$(checks supabase/APPLY-0436.sql)" 15)"
ok "4 switches" "$(q "alter table public.event_tasks disable trigger zzz_r436_rework; alter table public.event_tasks disable trigger zzz_r434_start_now;
  select count(*) = 2 from pg_trigger where tgname in ('zzz_r436_rework', 'zzz_r434_start_now') and tgenabled = 'D'")"
q "alter table public.event_tasks enable trigger zzz_r436_rework; alter table public.event_tasks enable trigger zzz_r434_start_now" >/dev/null
CHK="$(checks supabase/CHECK-PROD-MIGRATIONS.sql)"
ok "5 the checker finds 0434 and 0436" "$(grep -qE '^0434_r252_start_now\|present\|' <<<"$CHK" && grep -qE '^0436_r253_start_now_mail\|present\|' <<<"$CHK" && echo t || grep -E '^043[46]' <<<"$CHK")"
# 6: two real sessions; the first keeps its change open for a second
read -r O1 Q1 <<<"$(q "select org_id || ' ' || id from public.quotes where deleted_at is null order by id limit 1")"
q "insert into public.event_tasks (id, quote_id, org_id, category, title, status) values ('a0000000-0000-4000-8000-00000f536001', '$Q1', '$O1', 'Race', 'R1', 'unassigned'), ('a0000000-0000-4000-8000-00000f536002', '$Q1', '$O1', 'Race', 'R2', 'unassigned')" >/dev/null
T1="$(mktemp)"; T2="$(mktemp)"
(psql -X -q -At -c "begin; update public.event_tasks set depends_on = 'a0000000-0000-4000-8000-00000f536002' where id = 'a0000000-0000-4000-8000-00000f536001'; select pg_sleep(1.5); commit; select 'one done'" >"$T1" 2>&1) & P1=$!
sleep 0.4
psql -X -q -At -c "update public.event_tasks set depends_on = 'a0000000-0000-4000-8000-00000f536001' where id = 'a0000000-0000-4000-8000-00000f536002'" >"$T2" 2>&1
wait $P1
ok "6 the second of two changes at the same moment waits, then is refused" "$(grep -q 'wait for each other' "$T2" && [ "$(q "select count(*) = 1 from public.event_tasks where id in ('a0000000-0000-4000-8000-00000f536001', 'a0000000-0000-4000-8000-00000f536002') and depends_on is not null")" = t ] && echo t || cat "$T1" "$T2")"
rm -f "$T1" "$T2"
export PGDATABASE="$SRC"; dropdb --if-exists "$DB" >/dev/null 2>&1
[ "$fail" = 0 ] && echo "R253-ORDER-0436: PASS" || { echo "R253-ORDER-0436: FAILED"; exit 1; }
