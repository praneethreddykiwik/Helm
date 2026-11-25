-- r261-vendor-money-0450.sql - R261 (25 Nov 2026): what a vendor charges for missing / broken items (asked, agreed = one bill of its own, already in their
-- invoice, taken back), counted exactly once in the cost ledger whatever the other bills and typed lines are; paying a vendor who sent no bill (bill +
-- payment in one go, same key once); settled_reason. Rights, other studio, anon, closed, frozen, read-only. Local disposable PG only. Rolled back.
\set ON_ERROR_STOP 0
set client_min_messages = error;
begin;
create temp table _before as select (select md5(coalesce(string_agg(q::text, '|' order by q.id), '')) from public.quotes q) as qs, (select md5(coalesce(string_agg((to_jsonb(r) - 'settled_reason')::text, '|' order by r.id), '')) from public.event_resources r) as rs,
  (select md5(coalesce(string_agg(b::text, '|' order by b.id), '')) from public.vendor_bills b) as bs, (select md5(coalesce(string_agg(public._r21_cost_lines(q.id, q.org_id)::text, '|' order by q.id), '')) from public.quotes q) as ml;
\o /dev/null
\i supabase/migrations/0450_r261_vendor_money.sql
\i supabase/migrations/0450_r261_vendor_money.sql
\o
set client_min_messages = warning;
create temp table _rc(name text, result text); grant all on _rc to anon, authenticated, service_role;
create or replace function pg_temp.su() returns void language plpgsql as $$ begin execute 'reset role'; perform auth.logout(); execute 'reset role'; end $$;
create or replace function pg_temp.login(p_email text) returns void language plpgsql as $$
declare u uuid; begin
  perform pg_temp.su(); select id into u from auth.users where email = p_email;
  perform set_config('request.jwt.claims', jsonb_build_object('sub', u, 'role', 'authenticated', 'email', p_email, 'aal', 'aal1')::text, false);
  perform set_config('role', 'authenticated', false);
end $$;
create or replace function pg_temp.res(p_name text, p_ok boolean, p_detail text default '') returns void language plpgsql as $$ begin insert into _rc values (p_name, case when coalesce(p_ok, false) then 'PASS' else 'FAIL: ' || coalesce(p_detail, '') end); end $$;
create or replace function pg_temp.j(p_sql text) returns jsonb language plpgsql as $$ declare v jsonb; begin execute p_sql into v; return v; exception when others then return jsonb_build_object('err', sqlstate || ' ' || sqlerrm); end $$;
create or replace function pg_temp.ev(p_e text default '1') returns uuid language sql immutable as $$ select ('a0000000-0000-4000-8000-0000000d450' || p_e)::uuid $$;
create or replace function pg_temp.bk(p_n text, p_e text default '1') returns uuid language sql immutable as $$ select ('a0000000-0000-4000-8000-0000000b45' || p_e || p_n)::uuid $$;
create or replace function pg_temp.get(p_e text default '1') returns jsonb language sql as $$ select pg_temp.j(format('select public.event_vendor_charges_get(%L)', pg_temp.ev(p_e))) $$;
create or replace function pg_temp.add(p_bk uuid, p_amt jsonb, p_state text, p_req uuid default gen_random_uuid(), p_label text default 'Tables', p_e text default '1') returns jsonb language sql as $$
  select pg_temp.j(format('select public.event_vendor_charge_add(%L, %L::jsonb, %L)', pg_temp.ev(p_e), jsonb_build_object('booking', p_bk, 'label', p_label, 'qty', 1, 'amount', p_amt, 'note', 'leg broken', 'state', p_state), p_req)) $$;
create or replace function pg_temp.cset(p_id text, p_from text, p_to text, p_why text default null) returns jsonb language sql as $$ select pg_temp.j(format('select public.event_vendor_charge_set(%L, %L, %L, %L)', p_id, p_from, p_to, p_why)) $$;
create or replace function pg_temp.pay(p_bk uuid, p_amt numeric, p_key text) returns jsonb language sql as $$ select pg_temp.j(format('select public.vendor_booking_pay(%L, %L::jsonb, %L)', p_bk, jsonb_build_object('amount', p_amt, 'method', 'UPI'), p_key)) $$;
grant execute on all functions in schema pg_temp to anon, authenticated, service_role;
-- the ledger as the server sees it: expected / actual of an event
create or replace function pg_temp.fc(p_e text default '1') returns numeric language sql as $$ select sum((l ->> 'c_fc')::numeric) from jsonb_array_elements(public._r21_cost_lines(pg_temp.ev(p_e), 'a0000000-0000-4000-8000-000000000001')) l $$;
create or replace function pg_temp.act(p_e text default '1') returns numeric language sql as $$ select sum((l ->> 'c_act')::numeric) from jsonb_array_elements(public._r21_cost_lines(pg_temp.ev(p_e), 'a0000000-0000-4000-8000-000000000001')) l $$;

select pg_temp.res('01 no stored row and no event''s costs changed by the file (run twice)', (select b.qs = md5(coalesce((select string_agg(q::text, '|' order by q.id) from public.quotes q), '')) and b.rs = md5(coalesce((select string_agg((to_jsonb(r) - 'settled_reason')::text, '|' order by r.id) from public.event_resources r), ''))
  and b.bs = md5(coalesce((select string_agg(x::text, '|' order by x.id) from public.vendor_bills x), '')) and b.ml = md5(coalesce((select string_agg(public._r21_cost_lines(q.id, q.org_id)::text, '|' order by q.id) from public.quotes q), '')) from _before b));
select pg_temp.res('02 the table is closed, guards, audit and the purge list are there', (select c.relrowsecurity and not has_table_privilege('authenticated', c.oid, 'select,insert,update,delete') from pg_class c where c.oid = 'public.event_vendor_charges'::regclass)
  and (select count(*) = 3 from pg_trigger where tgrelid = 'public.event_vendor_charges'::regclass and tgname in ('zz_quote_org_match', 'zzz_studio_read_only', 'audit_trg'))
  and (length(pg_get_functiondef('public._tr184_purge_tables()'::regprocedure)) - length(replace(pg_get_functiondef('public._tr184_purge_tables()'::regprocedure), '''event_vendor_charges''', ''))) / length('''event_vendor_charges''') = 1);

do $$ declare orgA uuid := 'a0000000-0000-4000-8000-000000000001'; u uuid; r record; begin
  for r in select * from (values ('a_see450@a.test', 'Sana Sees', 'sales'), ('a_none450@a.test', 'Nina None', 'operations')) x(m, n, rl) loop
    u := auth.seed_user(r.m);
    insert into public.profiles(id, email, full_name, role, org_id, must_change_password, created_at) values (u, r.m, r.n, r.rl, orgA, false, now())
    on conflict (id) do update set role = excluded.role, org_id = excluded.org_id, full_name = excluded.full_name;
  end loop;
  insert into public.role_access(role, area, can_view, can_edit, org_id, updated_at) values ('sales', 'settlement', true, true, orgA, now()), ('sales', 'finance', true, false, orgA, now()), ('operations', 'settlement', false, false, orgA, now()), ('operations', 'finance', false, false, orgA, now())
  on conflict (role, area, org_id) do update set can_view = excluded.can_view, can_edit = excluded.can_edit;
  insert into public.vendors(id, name, org_id) values ('a0000000-0000-4000-8000-0000000c4501', 'Sample Vendors', orgA) on conflict do nothing;
  for r in select * from (values ('1'), ('2'), ('3'), ('4')) x(n) loop
    insert into public.quotes(id, code, title, status, client, pricing, current_version, approval_status, org_id, created_at, updated_at, event_date, lifecycle_stage)
    values (pg_temp.ev(r.n), 'A-450' || r.n, 'E' || r.n, 'confirmed', '{}'::jsonb, '{"subtotal": 200000, "gstPct": 0, "total": 200000}'::jsonb, 1, 'approved', orgA, now(), now(), current_date, 'event_day');
    insert into public.event_resources(id, quote_id, vendor_id, label, qty, cost, status, kind, org_id) values (pg_temp.bk('1', r.n), pg_temp.ev(r.n), 'a0000000-0000-4000-8000-0000000c4501', 'Tables', 81, 32900, 'confirmed', 'vendor', orgA),
      (pg_temp.bk('2', r.n), pg_temp.ev(r.n), 'a0000000-0000-4000-8000-0000000c4501', 'Lights', 12, 3600, 'booked', 'vendor', orgA), (pg_temp.bk('3', r.n), pg_temp.ev(r.n), null, 'Only asked', 1, null, 'enquiry', 'vendor', orgA);
  end loop;
end $$;

select pg_temp.login('a_admin@a.test');
select pg_temp.res('03 nothing yet: an empty list, may be changed', (select x -> 'rows' = '[]'::jsonb and x ->> 'can_edit' = 'true' from pg_temp.get() x), pg_temp.get()::text);
select pg_temp.su(); create temp table _m as select pg_temp.fc() as fc, pg_temp.act() as act; grant all on _m to authenticated; select pg_temp.login('a_admin@a.test');
create temp table _a as select pg_temp.add(pg_temp.bk('1'), '500', 'asked', 'a0000000-0000-4000-8000-00000000e450') as v; grant all on _a to authenticated;
select pg_temp.res('04 asked: kept with who and when, no bill', (select v ->> 'ok' = 'true' and v #>> '{row,state}' = 'asked' and v #>> '{row,bill_id}' is null and coalesce(v #>> '{row,by}', '') <> '' and v #>> '{row,vendor}' = 'Sample Vendors' from _a), (select v::text from _a));
select pg_temp.su();
select pg_temp.res('05 asked counts as expected, not as actual', pg_temp.fc() = (select fc + 500 from _m) and pg_temp.act() = (select act from _m), pg_temp.fc()::text);
select pg_temp.login('a_admin@a.test');
select pg_temp.res('06 the same press twice is one charge', pg_temp.add(pg_temp.bk('1'), '999', 'agreed', 'a0000000-0000-4000-8000-00000000e450') ->> 'same' = 'true' and jsonb_array_length(pg_temp.get() -> 'rows') = 1);
select pg_temp.res('07 somebody else was faster: nothing changes', pg_temp.cset((select v #>> '{row,id}' from _a), 'agreed', 'in_invoice') ->> 'changed' = 'true' and pg_temp.get() #>> '{rows,0,state}' = 'asked');
create temp table _t8 as select pg_temp.cset((select v #>> '{row,id}' from _a), 'asked', 'agreed') as v; grant all on _t8 to authenticated;
select pg_temp.res('08 agreed: one bill of its own, not linked to the booking', (select v ->> 'ok' = 'true' from _t8) and pg_temp.get() #>> '{rows,0,state}' = 'agreed'
  and (select count(*) = 1 and bool_and(b.booking_id is null and b.amount = 500 and b.status = 'open' and b.vendor_id = 'a0000000-0000-4000-8000-0000000c4501' and b.description like 'Vendor damage: Tables x1 - leg broken') from public.vendor_bills b where b.quote_id = pg_temp.ev()));
select pg_temp.su();
select pg_temp.res('09 agreed counts once, as actual, under damages, beside the agreed price', pg_temp.fc() = (select fc + 500 from _m) and pg_temp.act() = (select act + 500 from _m)
  and (select count(*) = 1 from jsonb_array_elements(public._r21_cost_lines(pg_temp.ev(), 'a0000000-0000-4000-8000-000000000001')) l where l ->> 'category' = 'damages' and (l ->> 'c_act')::numeric = 500));
-- other unlinked spend: typed vendor lines 1000, then unlinked bills 600 and 1400 (the larger counts) - the charge comes on top every time
insert into public.event_costs(quote_id, kind, description, estimated, org_id) values (pg_temp.ev(), 'vendor', 'Typed vendor line', 1000, 'a0000000-0000-4000-8000-000000000001');
select pg_temp.res('10 beside a larger typed vendor line: both count', pg_temp.fc() = (select fc + 1500 from _m), pg_temp.fc()::text);
insert into public.vendor_bills(id, org_id, quote_id, amount) values ('a0000000-0000-4000-8000-0000000f4501', 'a0000000-0000-4000-8000-000000000001', pg_temp.ev(), 600);
select pg_temp.res('11 the charge does not make the other bills win (600 of 1000)', pg_temp.fc() = (select fc + 1500 from _m), pg_temp.fc()::text);
insert into public.vendor_bills(id, org_id, quote_id, amount) values ('a0000000-0000-4000-8000-0000000f4502', 'a0000000-0000-4000-8000-000000000001', pg_temp.ev(), 800);
select pg_temp.res('12 larger other bills (1400) count instead of the line, the charge once', pg_temp.fc() = (select fc + 1900 from _m), pg_temp.fc()::text);
select pg_temp.login('a_admin@a.test');
select pg_temp.res('13 the profit page has it too', (pg_temp.j(format('select public.event_pnl(%L)', pg_temp.ev())) -> 'by_category' ->> 'damages')::numeric = 500, pg_temp.j(format('select public.event_pnl(%L)', pg_temp.ev()))::text);
create temp table _t14 as select pg_temp.cset((select v #>> '{row,id}' from _a), 'agreed', 'in_invoice') as v; grant all on _t14 to authenticated;
select pg_temp.res('14 already in their invoice: the bill is voided, nothing counts twice', (select v ->> 'ok' = 'true' from _t14) and (select count(*) = 1 from public.vendor_bills b where b.quote_id = pg_temp.ev() and b.status = 'void' and b.amount = 500));
select pg_temp.su();
select pg_temp.res('15 ... and costs nothing on its own', pg_temp.fc() = (select fc + 1400 from _m), pg_temp.fc()::text);
select pg_temp.login('a_admin@a.test');
select pg_temp.res('16 agreed again: a new bill; a paid charge is never taken back', pg_temp.cset((select v #>> '{row,id}' from _a), 'in_invoice', 'agreed') ->> 'ok' = 'true'
  and pg_temp.j(format('select public.vendor_bill_pay(%L, 200, 0, null, null, %L, null, %L)', pg_temp.get() #>> '{rows,0,bill_id}', 'UPI', 'k450-1')) ->> 'ok' = 'true' and (pg_temp.get() #>> '{rows,0,paid}')::numeric = 200
  and pg_temp.cset((select v #>> '{row,id}' from _a), 'agreed', 'void', 'typed wrong') ->> 'err' like '22023 A payment is recorded%', pg_temp.get()::text);
create temp table _b as select pg_temp.add(pg_temp.bk('2'), '250.5', 'agreed') as v; grant all on _b to authenticated;
select pg_temp.res('17a taken back needs a reason', pg_temp.cset((select v #>> '{row,id}' from _b), 'agreed', 'void') ->> 'err' like '22023 Say why%');
create temp table _t17 as select pg_temp.cset((select v #>> '{row,id}' from _b), 'agreed', 'void', 'they found it') as v; grant all on _t17 to authenticated;
select pg_temp.res('17b taken back: the row and its voided bill are kept', (select v ->> 'ok' = 'true' from _t17)
  and (select x ->> 'state' = 'void' and x ->> 'reason' = 'they found it' from jsonb_array_elements(pg_temp.get() -> 'rows') x where x ->> 'id' = (select v #>> '{row,id}' from _b)) and (select status = 'void' from public.vendor_bills where id = (select (v #>> '{row,bill_id}')::uuid from _b)));
select pg_temp.res('18 taken back is final', pg_temp.cset((select v #>> '{row,id}' from _b), 'void', 'asked') ->> 'changed' = 'true');
create temp table _c as select pg_temp.add(pg_temp.bk('2'), '70', 'agreed') as v; grant all on _c to authenticated;
update public.vendor_bills set status = 'void', void_reason = 'wrong' where id = (select (v #>> '{row,bill_id}')::uuid from _c);
select pg_temp.res('19 a bill voided on the Vendor bills card takes its charge with it', (select x ->> 'state' = 'void' and x ->> 'reason' = 'wrong' from jsonb_array_elements(pg_temp.get() -> 'rows') x where x ->> 'id' = (select v #>> '{row,id}' from _c)));
select pg_temp.res('20 numbers and words: 0, below 0, 3 decimals, text, no words, marks, unknown state, only asked, not here',
  pg_temp.add(pg_temp.bk('1'), '0', 'asked') ->> 'err' like '22023 Enter the amount%' and pg_temp.add(pg_temp.bk('1'), '-5', 'asked') ->> 'err' like '22023%' and pg_temp.add(pg_temp.bk('1'), '1.005', 'asked') ->> 'err' like '22023%' and pg_temp.add(pg_temp.bk('1'), '"5"', 'asked') ->> 'err' like '22023%'
  and pg_temp.add(pg_temp.bk('1'), '5', 'asked', gen_random_uuid(), '  ') ->> 'err' like '22023 Say what%' and pg_temp.add(pg_temp.bk('1'), '5', 'asked', gen_random_uuid(), '<b>') ->> 'err' like '22023 Leave out%' and pg_temp.add(pg_temp.bk('1'), '5', 'paid') ->> 'err' like '22023%'
  and pg_temp.add(pg_temp.bk('3'), '5', 'asked') ->> 'err' like '22023 This vendor is not booked%' and pg_temp.add(pg_temp.bk('1', '2'), '5', 'asked') ->> 'err' like 'P0002%' and pg_temp.add(pg_temp.bk('1'), '5', 'asked', null) ->> 'err' like '22023%');

-- C: paying a vendor without a bill (event 2)
select pg_temp.su(); update public.event_resources set settled = true, settled_at = now() where id = pg_temp.bk('1', '2'); select pg_temp.login('a_admin@a.test');
create temp table _p as select pg_temp.pay(pg_temp.bk('1', '2'), 10000, 'p450-1') as v; grant all on _p to authenticated;
select pg_temp.res('21 pay without a bill: the bill of the agreed price and the payment in one go', (select v ->> 'ok' = 'true' and v ->> 'duplicate' = 'false' and (v ->> 'balance')::numeric = 22900 from _p) and (select count(*) = 1 and bool_and(b.amount = 32900 and b.booking_id = pg_temp.bk('1', '2')) from public.vendor_bills b where b.quote_id = pg_temp.ev('2')), (select v::text from _p));
select pg_temp.res('21b marked settled before and not paid in full: open again', (select not settled and settled_at is null from public.event_resources where id = pg_temp.bk('1', '2')));
select pg_temp.res('22 the same key twice: one bill, one payment', pg_temp.pay(pg_temp.bk('1', '2'), 10000, 'p450-1') ->> 'duplicate' = 'true' and (select count(*) = 1 from public.vendor_bills b where b.quote_id = pg_temp.ev('2')) and (select sum(p.amount) = 10000 from public.vendor_payouts p join public.vendor_bills b on b.id = p.bill_id where b.quote_id = pg_temp.ev('2')));
select pg_temp.res('23 a vendor with a bill is paid on the bill; too much, 0, only asked, a key of another vendor: refused', pg_temp.pay(pg_temp.bk('1', '2'), 5, 'p450-2') ->> 'err' like '22023 This vendor has a bill%' and pg_temp.pay(pg_temp.bk('2', '2'), 3601, 'p450-3') ->> 'err' like '22023 That is more than%'
  and pg_temp.pay(pg_temp.bk('2', '2'), 0, 'p450-4') ->> 'err' like '22023%' and pg_temp.pay(pg_temp.bk('3', '2'), 5, 'p450-5') ->> 'err' like '22023 This vendor is not booked%' and pg_temp.pay(pg_temp.bk('2', '2'), 5, 'p450-1') ->> 'err' like '22023 idempotency%' and pg_temp.pay(pg_temp.bk('2', '2'), 5, null) ->> 'err' like '22023%');
update public.event_resources set advance = 600 where id = pg_temp.bk('2', '2');
select pg_temp.res('24 a typed advance comes off what can be paid', pg_temp.pay(pg_temp.bk('2', '2'), 3001, 'p450-6') ->> 'err' like '22023 That is more than%' and pg_temp.pay(pg_temp.bk('2', '2'), 3000, 'p450-7') ->> 'ok' = 'true');
select pg_temp.su();
insert into public.vendor_requests(id, org_id, quote_id, vendor_id, vendor_name, booking_id, what, when_at, agreed_amount, status, respond_by) values ('a0000000-0000-4000-8000-0000000a4501', 'a0000000-0000-4000-8000-000000000001', pg_temp.ev('3'), 'a0000000-0000-4000-8000-0000000c4501', 'Sample Vendors', pg_temp.bk('1', '3'), 'Tables', now(), 32900, 'accepted', now());
insert into public.vendor_invoices(org_id, quote_id, request_id, invoice_no, invoice_date, fy, taxable_amount, total_amount, status) values ('a0000000-0000-4000-8000-000000000001', pg_temp.ev('3'), 'a0000000-0000-4000-8000-0000000a4501', 'RY1', current_date, '2026-27', 32900, 32900, 'submitted');
select pg_temp.login('a_admin@a.test');
select pg_temp.res('25 an invoice waiting is reviewed first', pg_temp.pay(pg_temp.bk('1', '3'), 5, 'p450-8') ->> 'err' like '22023 This vendor sent an invoice%', pg_temp.pay(pg_temp.bk('1', '3'), 5, 'p450-8')::text);
select pg_temp.res('26 closed without payment: the reason is kept, too short or with marks refused', pg_temp.j(format('with x as (update public.event_resources set settled = true, settled_reason = %L where id = %L returning 1) select to_jsonb(count(*)) from x', 'They did it for free', pg_temp.bk('2', '3'))) = '1'::jsonb
  and pg_temp.j(format('with x as (update public.event_resources set settled_reason = %L where id = %L returning 1) select to_jsonb(count(*)) from x', 'a', pg_temp.bk('2', '3'))) ->> 'err' like '23514%' and pg_temp.j(format('with x as (update public.event_resources set settled_reason = %L where id = %L returning 1) select to_jsonb(count(*)) from x', '<b>no</b>', pg_temp.bk('2', '3'))) ->> 'err' like '23514%');

-- rights
select pg_temp.login('a_see450@a.test');
select pg_temp.res('27 Finance / Settlement view sees, does not change', (select jsonb_array_length(x -> 'rows') >= 3 and x ->> 'can_edit' = 'false' from pg_temp.get() x) and pg_temp.add(pg_temp.bk('1'), '5', 'asked') ->> 'err' like '42501%' and pg_temp.cset((select v #>> '{row,id}' from _a), 'agreed', 'void', 'no reason') ->> 'err' like '42501%' and pg_temp.pay(pg_temp.bk('1', '3'), 5, 'p450-9') ->> 'err' like '42501%');
select pg_temp.login('a_none450@a.test');
select pg_temp.res('28 no money rights: nothing', pg_temp.get() ->> 'err' like '42501%' and pg_temp.add(pg_temp.bk('1'), '5', 'asked') ->> 'err' like '42501%');
select pg_temp.login('b_admin@b.test');
select pg_temp.res('29 another studio sees and writes nothing', pg_temp.get() ->> 'err' like 'P0002%' and pg_temp.add(pg_temp.bk('1'), '5', 'asked') ->> 'err' like 'P0002%' and pg_temp.cset((select v #>> '{row,id}' from _a), 'agreed', 'void', 'xyz') ->> 'err' like 'P0002%' and pg_temp.pay(pg_temp.bk('1'), 5, 'p450-10') ->> 'err' like 'P0002%');
select pg_temp.su(); set role anon;
select pg_temp.res('30 not signed in: refused', pg_temp.get() ->> 'err' like '42501%' and pg_temp.pay(pg_temp.bk('1'), 5, 'p450-11') ->> 'err' like '42501%');
reset role; set role authenticated;
select pg_temp.res('31 no direct access to the table or the helpers', pg_temp.j('with x as (select count(*) c from public.event_vendor_charges) select to_jsonb(c) from x') ->> 'err' like '42501%' and pg_temp.j('select to_jsonb(public._r21_cost_lines__pre0450(gen_random_uuid(), gen_random_uuid()))') ->> 'err' like '42501%');
reset role; select pg_temp.su();
-- closed, frozen
insert into public.event_closure(quote_id, closed_at, org_id) values (pg_temp.ev('3'), now(), 'a0000000-0000-4000-8000-000000000001');
insert into public.event_money_freezes(quote_id, org_id, frozen, reason) values (pg_temp.ev('4'), 'a0000000-0000-4000-8000-000000000001', true, 'checking');
select pg_temp.login('a_admin@a.test');
select pg_temp.res('32 a closed event takes nothing', pg_temp.add(pg_temp.bk('1', '3'), '5', 'asked', gen_random_uuid(), 'Tables', '3') ->> 'err' like '22023 This event is closed%' and pg_temp.pay(pg_temp.bk('2', '3'), 5, 'p450-12') ->> 'err' like '22023 This event is closed%' and pg_temp.get('3') ->> 'can_edit' = 'false');
select pg_temp.res('33 frozen money takes nothing', pg_temp.add(pg_temp.bk('1', '4'), '5', 'asked', gen_random_uuid(), 'Tables', '4') ->> 'err' like '22023 The money on this event is frozen%' and pg_temp.pay(pg_temp.bk('1', '4'), 5, 'p450-13') ->> 'err' like '22023 The money%' and pg_temp.get('4') ->> 'can_edit' = 'false');
select pg_temp.su();
select pg_temp.res('34 the bookings and their prices are untouched', (select bool_and(cost in (32900, 3600) or cost is null) from public.event_resources where quote_id in (pg_temp.ev('1'), pg_temp.ev('2'))) and (select count(*) from public.audit_log where entity = 'event_vendor_charges') > 0);
select name, result from _rc where result <> 'PASS' order by name;
select 'R261-VENDOR-MONEY-0450: ' || case when count(*) filter (where result <> 'PASS') = 0 then 'ALL PASS' else 'FAIL' end || ' (' || count(*) filter (where result = 'PASS') || '/' || count(*) || ')' from _rc;
rollback;
