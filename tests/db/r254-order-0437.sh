#!/usr/bin/env bash
# r254-order-0437.sh - R254 (0437) on a throw-away copy of the test database:
#   1 APPLY-0437 twice; APPLY-0436 / APPLY-0435 / APPLY-0262 pasted again later, then 0437 again: every check row true, kept bodies once
#   2 two people marking the same vendor at the same moment (two REAL sessions): one row, the other gets 23505
#   3 LIST-0437 (read only) and REPAIR-0437: only bookings with evidence go back to paid, audited, no payment plan made, no date moved,
#     no message; twice = nothing more; the UNDO line works; the two triggers are on again
#   4 the prod checker finds 0437
# Local disposable PG only. Fake data only. Dropped at the end.
set -u
DB=helm_r254_order; fail=0
ok() { if [ "$2" = t ]; then echo "  ok  $1"; else echo "  FAIL $1 (${2:-})"; fail=1; fi; }
SRC="$(psql -X -At -c 'select current_database()')"
dropdb --if-exists "$DB" >/dev/null 2>&1; createdb -T "$SRC" "$DB" || exit 1
export PGDATABASE="$DB"
q() { psql -X -q -At -c "$1" 2>&1; }
checks() { psql -X -q -A -t -F '|' -v ON_ERROR_STOP=1 -f "$1" 2>&1; }
allok() { [ "$(grep -cE '^[0-9]{2} [^|]*\|t$' <<<"$1")" = "$2" ] && ! grep -qE '\|f$|ERROR' <<<"$1" && echo t || { grep -E '\|f$|ERROR' <<<"$1" | head -3; }; }
for k in 1 2; do ok "1 0437 paste $k" "$(allok "$(checks supabase/APPLY-0437.sql)" 11)"; done
ok "1 0436 again after 0437: all 15 rows" "$(allok "$(checks supabase/APPLY-0436.sql)" 15)"
ok "1 0435 again: all 14 rows" "$(allok "$(checks supabase/APPLY-0435.sql)" 14)"
checks supabase/APPLY-0262.sql >/dev/null
ok "1 0437 again after the older files: all 11 rows" "$(allok "$(checks supabase/APPLY-0437.sql)" 11)"
ok "1 kept bodies once, no kept copy of a kept copy of 0437" "$(q "select count(*) = 7 and not exists (select 1 from pg_proc where proname like '%pre0437%pre0437') from pg_proc where proname like '%\_\_pre0437'")"
# 2 two real sessions
A=a0000000-0000-4000-8000-000000000001; Q='a0000000-0000-4000-8000-000043710001'
q "insert into public.quotes (id, code, title, status, lifecycle_stage, client, pricing, approval_status, org_id, event_date, current_version) values
   ('$Q', 'R437-O1', 'Order', 'confirmed', 'planning', '{\"name\":\"R\"}', '{\"subtotal\":1000,\"discount\":0,\"gstPct\":0,\"total\":1000}', 'none', '$A', '2027-01-10', 1)" >/dev/null
I="insert into public.event_day (quote_id, org_id, kind, who, ref_id, status) values ('$Q', '$A', 'arrival', 'V', 'a0000000-0000-4000-8000-000043710f01', 'arrived')"
T2="$(mktemp)"
(psql -X -q -At -c "begin; $I; select pg_sleep(1.5); commit" >/dev/null 2>&1) & P1=$!
sleep 0.4; psql -X -q -At -v VERBOSITY=verbose -c "$I" >"$T2" 2>&1; wait $P1
ok "2 one row, the second marking gets 23505" "$([ "$(q "select count(*) from public.event_day where quote_id = '$Q'")" = 1 ] && grep -q '23505' "$T2" && echo t || cat "$T2")"
rm -f "$T2"
# 3 list + repair: 1 = hit (paid -> sent in the audit log), 2 = no evidence, 3 = client approved, 4 = price changed, 5 = not confirmed, 6 = money given back
mk() { q "insert into public.quotes (id, code, title, status, lifecycle_stage, client, pricing, approval_status, org_id, event_date, current_version) values
   ('a0000000-0000-4000-8000-00004371010$1', 'R437-L$1', 'L$1', '$2', '$3', '{\"name\":\"R\"}', '{\"subtotal\":1000,\"discount\":0,\"gstPct\":0,\"total\":1000}', '$4', '$A', '2027-01-10', 1);
   insert into public.quote_payments (quote_id, org_id, provider, amount, currency, status, paid_at) values ('a0000000-0000-4000-8000-00004371010$1', '$A', 'manual', 300, 'INR', 'paid', now())" >/dev/null; }
mk 1 confirmed planning paid; mk 2 confirmed planning sent; mk 3 confirmed planning paid; mk 4 confirmed planning paid; mk 5 quote quote paid; mk 6 confirmed planning paid
q "update public.quotes set approval_status = 'sent' where code in ('R437-L1', 'R437-L3', 'R437-L4', 'R437-L5', 'R437-L6')" >/dev/null
q "insert into public.quote_consents (quote_id, org_id, agreed) values ('a0000000-0000-4000-8000-000043710103', '$A', true)" >/dev/null
q "update public.quotes set consent_stale = true where code = 'R437-L4'" >/dev/null
q "insert into public.quote_payments (quote_id, org_id, provider, amount, currency, status, paid_at, reverses_payment_id, reversal_reason) select quote_id, org_id, provider, -300, 'INR', 'paid', now(), id, 'entered twice' from public.quote_payments where quote_id = 'a0000000-0000-4000-8000-000043710106'" >/dev/null
DG="select md5(concat((select string_agg(to_jsonb(m)::text, ',' order by m.id) from public.payment_milestones m), (select string_agg(to_jsonb(p)::text, ',' order by p.id) from public.quote_payments p), (select count(*) from public.notifications), (select count(*) from public.comms_outbox),
   (select string_agg((to_jsonb(x) - 'approval_status' - 'updated_at' - 'meta_rev')::text, ',' order by x.id) from public.quotes x)))"
D1="$(q "$DG")"
L="$(checks supabase/LIST-0437.sql | grep R437-L)"
ok "3 LIST: the hit booking yes, the one without evidence no, the others not listed" "$([ "$(awk -F'|' '{print $3 "=" $6}' <<<"$L" | sort | tr '\n' ' ')" = 'R437-L1=yes R437-L2=no ' ] && echo t || echo "$L")"
ok "3 LIST changes nothing" "$([ "$(q "$DG")" = "$D1" ] && echo t)"
R="$(checks supabase/REPAIR-0437.sql)"
ok "3 REPAIR: exactly the one booking" "$([ "$(q "select string_agg(code, ',') from public.quotes where code like 'R437-L%' and approval_status = 'paid'")" = R437-L1 ] && grep -q '^R437-L1|' <<<"$R" && echo t || echo "$R")"
ok "3 no plan made, no payment, message or other column changed" "$([ "$(q "$DG")" = "$D1" ] && echo t || q "select code, (select count(*) from public.payment_milestones m where m.quote_id = q.id) from public.quotes q where code like 'R437-L%'")"
ok "3 audited once, the two triggers on again" "$(q "select (select count(*) = 1 from public.audit_log where action = 'approval_status_repair_0437') and (select count(*) = 2 from pg_trigger where tgname in ('zzz_pst_auto_schedule', 'zzzz_r321_resync_on_approval') and tgenabled = 'O')")"
checks supabase/REPAIR-0437.sql >/dev/null
ok "3 twice: nothing more" "$(q "select count(*) = 1 from public.audit_log where action = 'approval_status_repair_0437'")"
U="$(sed -n 's/^--   \(update public.quotes q set\)/\1/p; s/^--      \(and exists (select 1 from public.audit_log\)/\1/p' supabase/REPAIR-0437.sql)"
q "$U" >/dev/null; ok "3 UNDO puts it back to sent" "$(q "select approval_status = 'sent' from public.quotes where code = 'R437-L1'")"
CHK="$(checks supabase/CHECK-PROD-MIGRATIONS.sql)"
ok "4 the checker finds 0437" "$(grep -qE '^0437_r254_e2e_fixes\|present\|' <<<"$CHK" && echo t || grep -E '^0437' <<<"$CHK")"
export PGDATABASE="$SRC"; dropdb --if-exists "$DB" >/dev/null 2>&1
[ "$fail" = 0 ] && echo "R254-ORDER-0437: PASS" || { echo "R254-ORDER-0437: FAILED"; exit 1; }
