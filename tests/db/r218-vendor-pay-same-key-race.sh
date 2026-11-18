#!/usr/bin/env bash
# r218 (audit C, reliability): two vendor payments with the SAME idempotency key at the same time (two tabs, or a retry
# while the first request is still running) must give ONE payout and a normal "already recorded" answer for the second -
# never a database error. Session A pays and holds its transaction 2 s; session B sends the same key 0.6 s later.
# Local disposable PG only (PGHOST/PGPORT/PGDATABASE from the caller). Fake data only; cleans up its own rows.
set -uo pipefail
export LC_ALL=C LANG=C
ORG='a0000000-0000-4000-8000-000000000001'; Q='a0000000-0000-4000-8000-00000000da01'
BILL='a0000000-0000-4000-8000-0000000e3921'; KEY="r218-race-$$"
FN="${1:-vendor_bill_pay}"   # vendor_bill_pay (r190 page) or record_vendor_payout (older page)
# later suites re-apply 0373 / 0156 over the patched bodies: put the 0390 line back first (safe to run twice)
psql -q -v ON_ERROR_STOP=1 -f supabase/migrations/0390_r218_vendor_pay_same_key.sql >/dev/null 2>&1 || { echo "0390 did not apply"; exit 1; }
psql -q -v ON_ERROR_STOP=1 >/dev/null <<SQL
update public.quotes set deleted_at = null, status = 'confirmed', is_demo = false where id = '$Q';
delete from public.event_closure where quote_id = '$Q';
delete from public.vendor_payouts where bill_id = '$BILL';
insert into public.vendor_bills (id, org_id, quote_id, bill_no, bill_date, amount)
  values ('$BILL', '$ORG', '$Q', 'R218-RACE', current_date, 10000) on conflict (id) do nothing;
SQL
CALL_A="select public.$FN('$BILL', 4000, $( [ "$FN" = vendor_bill_pay ] && echo "0, null," ) current_date, 'bank', null, '$KEY')"
( psql -q -t -A -v ON_ERROR_STOP=1 <<SQL 2>&1 | sed 's/^/A: /'
begin;
select auth.login_as((select id from auth.users where email = 'a_admin@a.test'));
$CALL_A;
select pg_sleep(2);
commit;
SQL
) &
APID=$!
sleep 0.6
B_OUT=$(psql -q -t -A <<SQL 2>&1
begin;
select auth.login_as((select id from auth.users where email = 'a_admin@a.test'));
$CALL_A;
commit;
SQL
)
wait $APID
echo "B: $B_OUT"
N=$(psql -q -t -A -c "select count(*) from public.vendor_payouts where bill_id = '$BILL'")
echo "payout rows for the bill: $N"
psql -q -c "delete from public.vendor_payouts where bill_id = '$BILL'; delete from public.vendor_bills where id = '$BILL';" >/dev/null 2>&1 || true
if [ "$N" = "1" ] && echo "$B_OUT" | grep -q '"duplicate": *true'; then echo "R218-VENDOR-PAY-RACE ($FN): PASS"; else echo "R218-VENDOR-PAY-RACE ($FN): FAIL"; fi
