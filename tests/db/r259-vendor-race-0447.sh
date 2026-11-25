#!/usr/bin/env bash
# r259-vendor-race-0447.sh - R259 (0447): two REAL sessions at the same moment, in a throw-away copy of the test database.
#   1 the studio approves while the vendor sends a new price: one outcome, never an approved price nobody saw
#   2 two people approve the same offer: one booking confirmation
#   3 the studio approves while the vendor says "not available": one outcome
#   4 the same "Ask vendor" press twice: one request, one booking
#   5 two people ask one booked vendor for the invoice: one invoice-only request
# Local disposable PG only (PGHOST / PGPORT / PGDATABASE from the caller). Fake data only; the copy is dropped.
set -uo pipefail
export LC_ALL=C LANG=C
SRC="${PGDATABASE:-helm_runall}"; DB="helm_r447_race"
dropdb --if-exists "$DB" >/dev/null 2>&1
createdb -T "$SRC" "$DB" >/dev/null 2>&1 || { echo "could not copy $SRC"; exit 1; }
trap 'dropdb --if-exists "$DB" >/dev/null 2>&1' EXIT
export PGDATABASE="$DB"
psql -X -q -v ON_ERROR_STOP=1 -1 -f supabase/migrations/0447_r259_vendor_flow.sql >/dev/null 2>&1 || { echo "0447 did not apply"; exit 1; }
q() { psql -X -q -A -t -v ON_ERROR_STOP=1 -c "$1" 2>&1; }
fail=0; ok() { if [ "$2" = "t" ]; then echo "  ok   $1"; else echo "  FAIL $1: $2"; fail=1; fi; }
ORG='a0000000-0000-4000-8000-000000000001'; ADM="(select id from auth.users where email = 'a_admin@a.test')"; Q='a0000000-0000-4000-8000-00000000e447'; V='a0000000-0000-4000-8000-00000000e4a1'
q "insert into public.quotes(id, code, title, event_type, status, client, pricing, current_version, approval_status, org_id, created_at, updated_at, event_date, lifecycle_stage) values ('$Q', 'A-447R', 'E', 'wedding', 'confirmed', '{}', '{}', 1, 'approved', '$ORG', now(), now(), current_date + 9, 'planning');
   insert into public.vendors(id, name, email, org_id) values ('$V', 'Race Vendor', 'race@vendor.test', '$ORG')" >/dev/null
# run SQL $1 and hold the transaction 1.2 s; 0.4 s later run SQL $2 in another session; $3 / $4 = who each one is
race() { local a b; a="$(mktemp)"; b="$(mktemp)"
  ( psql -X -q -A -t >"$a" 2>&1 <<SQL
begin; set local lock_timeout = '20s'; select $3; $1; select pg_sleep(1.2); commit;
SQL
  ) & local p=$!
  sleep 0.4
  psql -X -q -A -t >"$b" 2>&1 <<SQL
begin; set local lock_timeout = '20s'; select $4; $2; commit;
SQL
  wait $p; OA="$(cat "$a")"; OB="$(cat "$b")"; rm -f "$a" "$b"; }
ADMIN="auth.login_as($ADM)"; ANON="set_config('request.jwt.claims', '{\"role\":\"anon\"}', false)"
make() { q "select auth.login_as($ADM); select (j ->> 'id') || ' ' || (j #>> '{link,token}') from (select public.vendor_request_ask(jsonb_build_object('quote_id', '$Q', 'vendor_id', '$V', 'when_at', (now() + interval '5 days')::text, 'send', false, 'lines', '[{\"name\":\"Chairs $1\",\"qty\":10}]'::jsonb)) j) x" | tail -1; }
offer() { q "select public.vendor_link_offer('$1', '{\"available\":true,\"lines\":[{\"id\":\"l1\",\"qty\":10,\"price\":$2}]}')" >/dev/null; q "select id from public.vendor_offers where request_id = '$3' and status = 'offered'"; }
for n in 1 2 3; do read -r R T <<<"$(make $n)"; eval "R$n=$R T$n=$T"; done
O1="$(offer "$T1" 10 "$R1")"; O2="$(offer "$T2" 10 "$R2")"; O3="$(offer "$T3" 10 "$R3")"
race "select public.vendor_offer_review('$O1', 'approve', null, false)" "select public.vendor_link_offer('$T1', '{\"available\":true,\"lines\":[{\"id\":\"l1\",\"qty\":10,\"price\":99}]}')" "$ADMIN" "$ANON"
ok "approve first, a new price a moment later: booked at the price the studio saw, the vendor is told it is closed" "$(q "select r.status = 'accepted' and r.agreed_amount = 100 and (select count(*) from public.vendor_offers o where o.request_id = r.id) = 1 from public.vendor_requests r where r.id = '$R1'")"
ok "the vendor's late press answers closed" "$(grep -q '"reason": "closed"' <<<"$OB" && echo t || echo "$OB")"
race "select public.vendor_link_offer('$T2', '{\"available\":true,\"lines\":[{\"id\":\"l1\",\"qty\":10,\"price\":99}]}')" "select public.vendor_offer_review('$O2', 'approve', null, false)" "$ANON" "$ADMIN"
ok "a new price first, approve a moment later: not booked, the studio is told to look again" "$(q "select r.status = 'sent' and (select count(*) from public.vendor_offers o where o.request_id = r.id and o.status = 'offered' and o.total = 990) = 1 from public.vendor_requests r where r.id = '$R2'")"
ok "refused in words" "$(grep -q 'newer answer' <<<"$OB" && echo t || echo "$OB")"
O2="$(q "select id from public.vendor_offers where request_id = '$R2' and status = 'offered'")"
race "select public.vendor_offer_review('$O2', 'approve', null, false)" "select public.vendor_offer_review('$O2', 'approve', null, false)" "$ADMIN" "$ADMIN"
ok "two people approve at once: one confirmation" "$(q "select (select count(*) from public.vendor_request_log l where l.request_id = '$R2' and l.event = 'booking_confirmed') = 1 and (select status from public.vendor_requests where id = '$R2') = 'accepted'")"
race "select public.vendor_link_offer('$T3', '{\"available\":false,\"reason\":\"fully booked\"}')" "select public.vendor_offer_review('$O3', 'approve', null, false)" "$ANON" "$ADMIN"
ok "not available first, approve a moment later: declined, nothing booked" "$(q "select r.status = 'rejected' and (select b.status = 'enquiry' from public.event_resources b where b.id = r.booking_id) and (select status = 'withdrawn' from public.vendor_offers where id = '$O3') from public.vendor_requests r where r.id = '$R3'")"
ASK="select public.vendor_request_ask(jsonb_build_object('quote_id', '$Q', 'vendor_id', '$V', 'when_at', (now() + interval '5 days')::text, 'send', false, 'key', 'a0000000-0000-4000-8000-00000000e4c1', 'lines', '[{\"name\":\"Twice\",\"qty\":1}]'::jsonb))"
race "$ASK" "$ASK" "$ADMIN" "$ADMIN"
ok "the same Ask press twice at once: one request, one booking" "$(q "select (select count(*) from public.vendor_requests where what = 'Twice') = 1 and (select count(*) from public.event_resources where label = 'Twice') = 1")"
q "insert into public.event_resources(id, quote_id, vendor_id, label, qty, cost, status, org_id) values ('a0000000-0000-4000-8000-00000000e4b1', '$Q', '$V', 'Generator', 1, 4000, 'booked', '$ORG')" >/dev/null
IA="select public.vendor_invoice_ask(jsonb_build_object('booking_id', 'a0000000-0000-4000-8000-00000000e4b1'))"
race "$IA" "$IA" "$ADMIN" "$ADMIN"
ok "two people ask for the invoice at once: one invoice-only request, one e-mail" "$(q "select (select count(*) from public.vendor_requests where booking_id = 'a0000000-0000-4000-8000-00000000e4b1') = 1 and (select count(*) from public.vendor_request_sends where kind = 'invoice_ask') = 1")"
[ "$fail" = 0 ] && echo "R259-VENDOR-RACE-0447: ALL PASS" || { echo "R259-VENDOR-RACE-0447: FAIL"; exit 1; }
