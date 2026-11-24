#!/usr/bin/env bash
# r252-payment-plan-race-0435.sh - R252 (0435): two REAL sessions at the same moment, in a throw-away copy of the test database.
#   1 a custom plan and a template plan for one event: exactly one plan, sum = invoice total, the other session is refused in words
#   2 the same custom plan twice (double click): one plan
#   3 two first payments without client approval: one "confirmed by advance" record, two receipts
#   4 the same advance percentage + reason twice: one history row
#   5 two approval codes of a booking confirmed by an advance: one consent
#   6 an approval and a payment at the same time: both go through, the plan adds up, nothing deadlocks
# Local disposable PG only (PGHOST / PGPORT / PGDATABASE from the caller). Fake data only; the copy is dropped.
set -uo pipefail
export LC_ALL=C LANG=C
SRC="${PGDATABASE:-helm_runall}"; DB="helm_r435_race"
dropdb --if-exists "$DB" >/dev/null 2>&1
createdb -T "$SRC" "$DB" >/dev/null 2>&1 || { echo "could not copy $SRC"; exit 1; }
trap 'dropdb --if-exists "$DB" >/dev/null 2>&1' EXIT
export PGDATABASE="$DB"
psql -X -q -v ON_ERROR_STOP=1 -1 -f supabase/migrations/0435_r252_payment_plan.sql >/dev/null 2>&1 || { echo "0435 did not apply"; exit 1; }
q() { psql -X -q -A -t -v ON_ERROR_STOP=1 -c "$1" 2>&1; }
fail=0; ok() { if [ "$2" = "t" ]; then echo "  ok   $1"; else echo "  FAIL $1: $2"; fail=1; fi; }
ORG='a0000000-0000-4000-8000-000000000001'; ADM="(select id from auth.users where email = 'a_admin@a.test')"
q "delete from public.payment_schedule_settings where org_id = '$ORG'; insert into public.payment_schedule_settings(org_id, auto_apply) values ('$ORG', false)" >/dev/null
for n in 1 2 3 4 5 6 7; do
  q "insert into public.quotes(id, code, title, status, client, pricing, current_version, approval_status, org_id, approval_token, event_date, lifecycle_stage)
     values ('a0000000-0000-4000-8000-00000043f00$n', 'R435R-$n', 'Race $n', 'quote', '{\"name\":\"Riya\",\"phone\":\"+91980004350$n\"}',
             '{\"subtotal\":100001,\"discount\":0,\"gstPct\":0,\"total\":100001}', 1, 'sent', '$ORG', 'a0000000-0000-4000-8000-00000043e00$n', current_date + 90, 'quote')" >/dev/null
done
id() { echo "a0000000-0000-4000-8000-00000043f00$1"; }
# run SQL $1 (as admin) and hold the transaction 1.5 s; 0.4 s later run SQL $2 in another session; both outputs -> $OA $OB
race() { local who="${3:-auth.login_as($ADM)}" a b; a="$(mktemp)"; b="$(mktemp)"
  ( psql -X -q -A -t >"$a" 2>&1 <<SQL
begin; set local lock_timeout = '20s'; select $who; $1; select pg_sleep(1.5); commit;
SQL
  ) & local p=$!
  sleep 0.4
  psql -X -q -A -t >"$b" 2>&1 <<SQL
begin; set local lock_timeout = '20s'; select $who; $2; commit;
SQL
  wait $p; OA="$(cat "$a")"; OB="$(cat "$b")"; rm -f "$a" "$b"; }
LINES_='[{"label":"A","kind":"percent","value":60},{"label":"B","kind":"rest"}]'
sum() { q "select (select sum(amount) from public.payment_milestones where quote_id = '$(id "$1")') = public.helm_invoice_total('$(id "$1")')"; }

race "select public.payment_schedule_apply_custom('$(id 1)', '$LINES_')" "select public.payment_schedule_apply('$(id 1)', 'builtin:30-50-20')"
ok "custom + template at once: one plan (2 rows), it adds up" "$(q "select count(*) = 2 from public.payment_milestones where quote_id = '$(id 1)'")"
ok "its sum is the invoice total" "$(sum 1)"
ok "the other session is refused in words" "$(grep -q 'has_schedule\|already has a payment schedule' <<<"$OB" && echo t || echo "$OB")"
race "select public.payment_schedule_apply('$(id 2)', 'builtin:25-25-25-25')" "select public.payment_schedule_apply_custom('$(id 2)', '$LINES_')"
ok "template first, custom second: one plan (4 rows) + rules of that plan" "$(q "select (select count(*) = 4 from public.payment_milestones where quote_id = '$(id 2)') and (select jsonb_array_length(plan_lines) = 4 from public.payment_schedule_quote_prefs where quote_id = '$(id 2)')")"
ok "the custom one is refused in words" "$(grep -q 'has_schedule\|already has a payment schedule' <<<"$OB" && echo t || echo "$OB")"
race "select public.record_payment('$(id 3)', 1000, 'cash', null, null, null, 'race-a')" "select public.record_payment('$(id 3)', 2000, 'cash', null, null, null, 'race-b')"
ok "two first payments: two receipts, one 'confirmed by advance'" "$(q "select (select count(*) = 2 and sum(amount) = 3000 from public.quote_payments where quote_id = '$(id 3)' and status = 'paid') and (select count(*) = 1 from public.quote_advance_log where quote_id = '$(id 3)' and kind = 'advance_confirm')")"
race "select public.advance_override_set('$(id 4)', 25, 'Old client of the owner')" "select public.advance_override_set('$(id 4)', 25, 'Old client of the owner')"
ok "the same override twice: one row" "$(q "select count(*) = 1 from public.quote_advance_log where quote_id = '$(id 4)'")"
q "do \$x\$ begin perform auth.login_as($ADM); perform public.record_payment('$(id 5)', 1000, 'cash', null, null, null, 'race-c'); perform auth.logout(); end \$x\$" >/dev/null
for c in 111111 222222; do q "insert into public.quote_otps(quote_id, phone, code_hash, expires_at, org_id) select q.id, public._otp_canon_phone(q.approval_token, q.client ->> 'phone'), extensions.crypt('$c', extensions.gen_salt('bf', 4)), now() + interval '10 minutes', q.org_id from public.quotes q where q.id = '$(id 5)'" >/dev/null; done
V="select public.verify_and_consent('a0000000-0000-4000-8000-00000043e005', '+919800043505', '222222', true, 'v1', 'I agree', 'Riya', 'ua')"
race "$V" "${V/222222/111111}" "auth.login_anon()"
ok "two approval codes after an advance: one consent, status stays paid" "$(q "select (select count(*) = 1 from public.quote_consents where quote_id = '$(id 5)') and (select approval_status = 'paid' from public.quotes where id = '$(id 5)')")"
ok "the second answer is already approved" "$(grep -q already_approved <<<"$OB" && echo t || echo "$OB")"
q "do \$x\$ begin perform auth.login_as($ADM); perform public.payment_schedule_apply_custom('$(id 6)', '$LINES_'); perform auth.logout(); end \$x\$" >/dev/null
q "insert into public.quote_otps(quote_id, phone, code_hash, expires_at, org_id) select q.id, public._otp_canon_phone(q.approval_token, q.client ->> 'phone'), extensions.crypt('333333', extensions.gen_salt('bf', 4)), now() + interval '10 minutes', q.org_id from public.quotes q where q.id = '$(id 6)'" >/dev/null
a="$(mktemp)"; ( psql -X -q -A -t >"$a" 2>&1 <<SQL
begin; select auth.login_anon(); select public.verify_and_consent('a0000000-0000-4000-8000-00000043e006', '+919800043506', '333333', true, 'v1', 'I agree', 'Riya', 'ua'); select pg_sleep(1.2); commit;
SQL
) & p=$!; sleep 0.4
OB="$(psql -X -q -A -t 2>&1 <<SQL
begin; set local lock_timeout = '20s'; select auth.login_as($ADM); select public.record_payment('$(id 6)', 60001, 'cash', null, null, null, 'race-d'); commit;
SQL
)"; wait $p; OA="$(cat "$a")"; rm -f "$a"
ok "approval + payment at once: both went through" "$(grep -q '"approved": true' <<<"$OA" && grep -q receipt_no <<<"$OB" && echo t || echo "$OA / $OB")"
ok "the plan still adds up; consent + payment kept; paid" "$(q "select (select count(*) = 1 from public.quote_consents where quote_id = '$(id 6)') and (select count(*) = 1 from public.quote_payments where quote_id = '$(id 6)') and (select approval_status = 'paid' from public.quotes where id = '$(id 6)')")"
ok "its sum is the invoice total" "$(sum 6)"
# 7 a payment in progress holds the plan lock: confirming the booking does not wait for it; the payment itself moves the dates
q "do \$x\$ begin perform auth.login_as($ADM); perform public.payment_schedule_apply_custom('$(id 7)', '$LINES_'); perform auth.logout(); end \$x\$" >/dev/null
q "update public.payment_milestones set due_date = due_date - 4 where quote_id = '$(id 7)'; update public.payment_schedule_quote_prefs set plan_lines = (select jsonb_agg(x || jsonb_build_object('due_date', (x ->> 'due_date')::date - 4) order by o) from jsonb_array_elements(plan_lines) with ordinality e(x, o)) where quote_id = '$(id 7)'" >/dev/null
( psql -X -q -A -t >/dev/null 2>&1 <<SQL
begin; select pg_advisory_xact_lock(hashtextextended('helm:pay:quote:' || '$(id 7)', 0)); select pg_sleep(1.5); commit;
SQL
) & p=$!; sleep 0.4
OB="$(q "set lock_timeout = '300ms'; update public.quotes set status = 'confirmed' where id = '$(id 7)' returning status")"; wait $p
ok "confirming does not wait for a payment in progress" "$(grep -q confirmed <<<"$OB" && echo t || echo "$OB")"
ok "the dates are not moved by it" "$(q "select bool_and(due_date < public._pst_today('$ORG')) from public.payment_milestones where quote_id = '$(id 7)'")"
q "do \$x\$ begin perform auth.login_as($ADM); perform public.record_payment('$(id 7)', 10, 'cash', null, null, null, 'race-e'); perform auth.logout(); end \$x\$" >/dev/null
ok "the payment's own end moves them to the day" "$(q "select bool_and(due_date = public._pst_today('$ORG')) from public.payment_milestones where quote_id = '$(id 7)'")"
[ "$fail" = 0 ] && echo "R252-PAYMENT-PLAN-RACE-0435: ALL PASS" || { echo "R252-PAYMENT-PLAN-RACE-0435: FAILED"; exit 1; }
