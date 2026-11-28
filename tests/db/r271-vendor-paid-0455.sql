-- r271-vendor-paid-0455.sql - R271: once a vendor is paid (an approved invoice's bill paid with TDS, "Pay the vendor" without a bill with a
-- typed advance, closed without payment) the closure checklist, the event P&L, Who owes what, the money header and the vendor's step agree;
-- a part payment shows the exact remainder; stock still out = only what is still out. Local disposable PG only. Fake data. Rolled back.
\set ON_ERROR_STOP 0
set client_min_messages = error;
begin;
create temp table _before as select (select md5(coalesce(string_agg(q::text, '|' order by q.id), '')) from public.quotes q) as qs,
  (select md5(coalesce(string_agg(r::text, '|' order by r.id), '')) from public.event_resources r) as rs,
  (select md5(coalesce(string_agg(b::text, '|' order by b.id), '')) from public.vendor_bills b) as bs,
  (select md5(coalesce(string_agg(p::text, '|' order by p.id), '')) from public.vendor_payouts p) as ps,
  (select md5(coalesce(string_agg(c::text, '|' order by c.id), '')) from public.inventory_checkouts c) as cs;
\o /dev/null
\i supabase/migrations/0455_r271_vendor_paid.sql
\i supabase/migrations/0455_r271_vendor_paid.sql
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
create or replace function pg_temp.res(p_name text, p_ok boolean, p_detail text default '') returns void language plpgsql as $$
begin insert into _rc values (p_name, case when coalesce(p_ok, false) then 'PASS' else 'FAIL: ' || left(coalesce(p_detail, ''), 400) end); end $$;
create or replace function pg_temp.j(p_sql text) returns jsonb language plpgsql as $$ declare v jsonb; begin execute p_sql into v; return v; exception when others then return jsonb_build_object('err', sqlstate || ' ' || sqlerrm); end $$;
create or replace function pg_temp.ev(p_e text) returns uuid language sql immutable as $$ select ('a0000000-0000-4000-8000-0000000d455' || p_e)::uuid $$;
create or replace function pg_temp.bk(p_n text) returns uuid language sql immutable as $$ select ('a0000000-0000-4000-8000-0000000b455' || p_n)::uuid $$;
create or replace function pg_temp.org() returns uuid language sql immutable as $$ select 'a0000000-0000-4000-8000-000000000001'::uuid $$;
-- one closure check of an event: { status, detail, count, amount }
create or replace function pg_temp.chk(p_e text, p_key text) returns jsonb language sql as $$
  select c from jsonb_array_elements(public._r22_close_checks(pg_temp.ev(p_e), pg_temp.org()) -> 'checks') c where c ->> 'key' = p_key limit 1 $$;
create or replace function pg_temp.due(p_e text) returns numeric language sql as $$ select (public._vb_event_pnl(pg_temp.ev(p_e), pg_temp.org()) ->> 'bills_due')::numeric $$;
-- as the admin: Who owes what (vendors total) and the money header's "Pay the vendor" amount
create or replace function pg_temp.owes(p_e text) returns numeric language plpgsql as $$ declare v jsonb; begin perform pg_temp.login('a_admin@a.test');
  v := pg_temp.j(format('select public.event_money_cash(%L)', pg_temp.ev(p_e))); perform pg_temp.su(); return coalesce((v #>> '{owes,vendors,total}')::numeric, -1); end $$;
create or replace function pg_temp.head(p_e text) returns numeric language plpgsql as $$ declare v jsonb; begin perform pg_temp.login('a_admin@a.test');
  v := pg_temp.j(format('select public.event_money_header(%L)', pg_temp.ev(p_e))); perform pg_temp.su();
  if v ? 'err' then return -1; end if; return coalesce((select sum((a ->> 'amount')::numeric) from jsonb_array_elements(coalesce(v -> 'attention', '[]')) a where a ->> 'kind' = 'bill_due'), 0); end $$;
create or replace function pg_temp.st(p_req uuid) returns text language sql as $$ select public._r447_state(r) from public.vendor_requests r where r.id = p_req $$;
grant execute on all functions in schema pg_temp to anon, authenticated, service_role;

select pg_temp.res('01 nothing stored changed by the file (run twice)', (select b.qs = md5(coalesce((select string_agg(q::text, '|' order by q.id) from public.quotes q), ''))
  and b.rs = md5(coalesce((select string_agg(r::text, '|' order by r.id) from public.event_resources r), '')) and b.bs = md5(coalesce((select string_agg(x::text, '|' order by x.id) from public.vendor_bills x), ''))
  and b.ps = md5(coalesce((select string_agg(p::text, '|' order by p.id) from public.vendor_payouts p), '')) and b.cs = md5(coalesce((select string_agg(c::text, '|' order by c.id) from public.inventory_checkouts c), '')) from _before b));

-- events done yesterday; one vendor (the live case: Kiwik Vendors, invoice RF4553)
do $$ declare a uuid := pg_temp.org(); r record; begin
  insert into public.vendors(id, name, org_id) values ('a0000000-0000-4000-8000-0000000c4551', 'Kiwik Vendors', a);
  for r in select * from (values ('1'), ('2'), ('3'), ('4'), ('5'), ('6')) x(n) loop
    insert into public.quotes(id, code, title, status, client, pricing, current_version, approval_status, org_id, created_at, updated_at, event_date, lifecycle_stage)
    values (pg_temp.ev(r.n), 'A-455' || r.n, 'E' || r.n, 'confirmed', '{}', '{"subtotal":100000,"gstPct":0,"total":100000}', 1, 'approved', a, now(), now(), current_date - 1, 'settlement');
  end loop;
  insert into public.event_resources(id, quote_id, vendor_id, label, qty, cost, advance, status, kind, org_id) values
   (pg_temp.bk('1'), pg_temp.ev('1'), 'a0000000-0000-4000-8000-0000000c4551', 'Tents', 1, 10000, null, 'confirmed', 'vendor', a),
   (pg_temp.bk('2'), pg_temp.ev('2'), 'a0000000-0000-4000-8000-0000000c4551', 'Tents', 1, 10000, 3000, 'confirmed', 'vendor', a),
   (pg_temp.bk('3'), pg_temp.ev('3'), 'a0000000-0000-4000-8000-0000000c4551', 'Lights', 1, 2000, null, 'confirmed', 'vendor', a),
   (pg_temp.bk('4'), pg_temp.ev('3'), 'a0000000-0000-4000-8000-0000000c4551', 'Sound', 1, 1500, null, 'confirmed', 'vendor', a),
   (pg_temp.bk('5'), pg_temp.ev('4'), 'a0000000-0000-4000-8000-0000000c4551', 'Chairs', 1, 10000, null, 'confirmed', 'vendor', a),
   (pg_temp.bk('6'), pg_temp.ev('5'), 'a0000000-0000-4000-8000-0000000c4551', 'Stage', 1, 10000, 4000, 'confirmed', 'vendor', a),
   (pg_temp.bk('7'), pg_temp.ev('5'), 'a0000000-0000-4000-8000-0000000c4551', 'Old', 1, 5000, 2000, 'cancelled', 'vendor', a);
  -- the accepted vendor request of booking 1 (the price approved through the vendor link) and of booking 5 (paid without an invoice)
  insert into public.vendor_requests(id, org_id, quote_id, vendor_id, vendor_name, booking_id, what, when_at, agreed_amount, respond_by, status, responded_at)
  values ('a0000000-0000-4000-8000-0000000e4551', a, pg_temp.ev('1'), 'a0000000-0000-4000-8000-0000000c4551', 'Kiwik Vendors', pg_temp.bk('1'), 'Tents', now() - interval '1 day', 10000, now(), 'accepted', now()),
         ('a0000000-0000-4000-8000-0000000e4552', a, pg_temp.ev('4'), 'a0000000-0000-4000-8000-0000000c4551', 'Kiwik Vendors', pg_temp.bk('5'), 'Chairs', now() - interval '1 day', 10000, now(), 'accepted', now());
end $$;

-- (a) an approved invoice = a bill on the booking (10000 + 1800 GST), paid in full: 10620 cash + 1180 TDS
insert into public.vendor_bills(id, org_id, quote_id, booking_id, vendor_id, bill_no, amount, gst_amount) values ('a0000000-0000-4000-8000-0000000f4551', pg_temp.org(), pg_temp.ev('1'), pg_temp.bk('1'), 'a0000000-0000-4000-8000-0000000c4551', 'RF4553', 11800, 1800);
select pg_temp.res('02 before paying: the closure says what is owed, the step is not paid', (pg_temp.chk('1', 'payouts') ->> 'status') = 'warn' and (pg_temp.chk('1', 'payouts') ->> 'amount')::numeric = 11800
  and pg_temp.due('1') = 11800 and pg_temp.st('a0000000-0000-4000-8000-0000000e4551') <> 'paid', pg_temp.chk('1', 'payouts')::text);
select pg_temp.login('a_admin@a.test');
select pg_temp.res('03 paid with TDS', pg_temp.j($$select public.vendor_bill_pay('a0000000-0000-4000-8000-0000000f4551', 10620, 1180, '194C', current_date, 'upi', 'UTR1', 'r455-k1')$$) ->> 'balance' = '0');
select pg_temp.su();
select pg_temp.res('04 paid in full with TDS: closure, P&L, Who owes what, money header and the step all say paid', (pg_temp.chk('1', 'payouts') ->> 'status') = 'ok' and (pg_temp.chk('1', 'bills') ->> 'status') = 'ok'
  and pg_temp.due('1') = 0 and pg_temp.owes('1') = 0 and pg_temp.head('1') = 0 and pg_temp.st('a0000000-0000-4000-8000-0000000e4551') = 'paid' and public._r455_booking_owed(pg_temp.bk('1')) = 0,
  concat_ws(' ', pg_temp.chk('1', 'payouts'), pg_temp.due('1'), pg_temp.owes('1'), pg_temp.head('1'), pg_temp.st('a0000000-0000-4000-8000-0000000e4551')));

-- (b) "Pay the vendor" without a bill, 3000 advance typed earlier: the bill takes the advance, the rest is paid
select pg_temp.login('a_admin@a.test');
select pg_temp.res('05 more than what is left after the advance is refused', pg_temp.j($$select public.vendor_booking_pay('a0000000-0000-4000-8000-0000000b4552', '{"amount":7500,"method":"upi"}', 'r455-k2x')$$) ->> 'err' like '22023 That is more than%');
create temp table _p2 as select pg_temp.j($$select public.vendor_booking_pay('a0000000-0000-4000-8000-0000000b4552', '{"amount":7000,"method":"upi"}', 'r455-k2')$$) as v; grant all on _p2 to authenticated;
select pg_temp.res('06 the rest is paid, nothing left', (select v ->> 'balance' = '0' and v ->> 'ok' = 'true' from _p2), (select v::text from _p2));
select pg_temp.su();
select pg_temp.res('07 the typed advance is on the bill once, as an advance payment', (select count(*) = 1 and sum(p.amount) = 3000 and bool_and(p.source = 'advance' and p.idempotency_key = 'adv:' || pg_temp.bk('2') || ':' || b.id)
  from public.vendor_payouts p join public.vendor_bills b on b.id = p.bill_id where b.booking_id = pg_temp.bk('2') and p.source = 'advance'));
select pg_temp.res('08 advance + payment: every page says paid', (pg_temp.chk('2', 'payouts') ->> 'status') = 'ok' and pg_temp.due('2') = 0 and pg_temp.owes('2') = 0 and pg_temp.head('2') = 0 and public._r455_booking_owed(pg_temp.bk('2')) = 0,
  concat_ws(' ', pg_temp.chk('2', 'payouts'), pg_temp.due('2'), pg_temp.owes('2'), pg_temp.head('2')));
select pg_temp.login('a_admin@a.test');
select pg_temp.res('09 the Record typed advances button adds nothing more', (pg_temp.j(format('select public.vendor_bill_convert_advances(%L)', pg_temp.ev('2'))) ->> 'rows')::int = 0);
select pg_temp.su();

-- (c) closed without payment (with a reason) needs no bill; marked settled with no reason and no bill still asks for one
update public.event_resources set settled = true, settled_at = now(), settled_reason = 'Family friend, no charge' where id = pg_temp.bk('3');
update public.event_resources set settled = true, settled_at = now() where id = pg_temp.bk('4');
select pg_temp.res('10 closed without payment: no bill asked; settled with no reason: still asked', (pg_temp.chk('3', 'bills') ->> 'status') = 'fail' and (pg_temp.chk('3', 'bills') ->> 'detail') like '1 of 1 vendor booking(s) have no bill yet: Sound.',
  pg_temp.chk('3', 'bills')::text);
update public.event_resources set settled_reason = 'Paid in cash long ago' where id = pg_temp.bk('4');
select pg_temp.res('11 both closed with a reason: nothing asked', (pg_temp.chk('3', 'bills') ->> 'status') = 'ok', pg_temp.chk('3', 'bills')::text);

-- a part payment shows the exact rest everywhere; paid in full after it = paid, also on the step of a request without an invoice
select pg_temp.login('a_admin@a.test');
select pg_temp.res('12 part paid without a bill', pg_temp.j($$select public.vendor_booking_pay('a0000000-0000-4000-8000-0000000b4555', '{"amount":4000,"method":"cash"}', 'r455-k5')$$) ->> 'balance' = '6000.00');
select pg_temp.su();
select pg_temp.res('13 the rest (6000) is the same on the closure, P&L, Who owes what and the money header; the step is not paid', (pg_temp.chk('4', 'payouts') ->> 'amount')::numeric = 6000 and pg_temp.due('4') = 6000
  and pg_temp.owes('4') = 6000 and pg_temp.head('4') = 6000 and public._r455_booking_owed(pg_temp.bk('5')) = 6000 and pg_temp.st('a0000000-0000-4000-8000-0000000e4552') <> 'paid',
  concat_ws(' ', pg_temp.chk('4', 'payouts'), pg_temp.due('4'), pg_temp.owes('4'), pg_temp.head('4'), pg_temp.st('a0000000-0000-4000-8000-0000000e4552')));
select pg_temp.login('a_admin@a.test');
select pg_temp.res('14 the rest paid on the bill', pg_temp.j(format('select public.vendor_bill_pay(%L, 6000, 0, null, current_date, %L, null, %L)', (select id from public.vendor_bills where booking_id = pg_temp.bk('5')), 'upi', 'r455-k5b')) ->> 'balance' = '0');
select pg_temp.su();
select pg_temp.res('15 paid without an invoice: the vendor step says paid too', pg_temp.st('a0000000-0000-4000-8000-0000000e4552') = 'paid' and (pg_temp.chk('4', 'payouts') ->> 'status') = 'ok');

-- an older bill made before 0455 (the advance not on it yet): the closure checklist counts the typed advance as paid, as Payments & invoice does
alter table public.vendor_bills disable trigger zz_r455_take_advance;
insert into public.vendor_bills(id, org_id, quote_id, booking_id, vendor_id, bill_no, amount, bill_date) values
  ('a0000000-0000-4000-8000-0000000f4561', pg_temp.org(), pg_temp.ev('5'), pg_temp.bk('6'), 'a0000000-0000-4000-8000-0000000c4551', 'S1', 6000, current_date - 3),
  ('a0000000-0000-4000-8000-0000000f4562', pg_temp.org(), pg_temp.ev('5'), pg_temp.bk('6'), 'a0000000-0000-4000-8000-0000000c4551', 'S2', 4000, current_date - 2);
alter table public.vendor_bills enable trigger zz_r455_take_advance;
select pg_temp.res('16 old bills: the 4000 advance goes to the oldest bill first', public._r455_adv_credit('a0000000-0000-4000-8000-0000000f4561') = 4000 and public._r455_adv_credit('a0000000-0000-4000-8000-0000000f4562') = 0
  and (pg_temp.chk('5', 'payouts') ->> 'amount')::numeric = 6000 and (pg_temp.chk('5', 'payouts') ->> 'count')::int = 2 and public._r455_booking_owed(pg_temp.bk('6')) = 6000, pg_temp.chk('5', 'payouts')::text);
select pg_temp.login('a_admin@a.test');
select pg_temp.j($$select public.vendor_bill_pay('a0000000-0000-4000-8000-0000000f4561', 2000, 0, null, current_date, 'upi', null, 'r455-k6a')$$);
select pg_temp.j($$select public.vendor_bill_pay('a0000000-0000-4000-8000-0000000f4562', 4000, 0, null, current_date, 'upi', null, 'r455-k6b')$$);
select pg_temp.su();
select pg_temp.res('17 old bills paid with the advance: the closure says paid', (pg_temp.chk('5', 'payouts') ->> 'status') = 'ok' and public._r455_booking_owed(pg_temp.bk('6')) = 0, pg_temp.chk('5', 'payouts')::text);
-- a bill of a cancelled booking, or of a booking with no price, takes no advance
insert into public.vendor_bills(id, org_id, quote_id, booking_id, amount) values ('a0000000-0000-4000-8000-0000000f4563', pg_temp.org(), pg_temp.ev('5'), pg_temp.bk('7'), 5000);
select pg_temp.res('18 a cancelled booking''s bill takes no advance', not exists (select 1 from public.vendor_payouts where bill_id = 'a0000000-0000-4000-8000-0000000f4563'));

-- stock: 10 given out, 6 back OK + 1 damaged, 3 still out (a part return); a consumable: 20 out, 5 left over, 15 used
do $$ declare a uuid := pg_temp.org(); begin
  insert into public.inventory_items(id, name, total_qty, unit, org_id, item_kind) values ('a0000000-0000-4000-8000-0000000a4551', 'Chiavari chair', 100, 'pcs', a, 'reusable'),
    ('a0000000-0000-4000-8000-0000000a4552', 'Candles', 100, 'pcs', a, 'consumable');
  insert into public.inventory_checkouts(id, item_id, quote_id, qty_out, issued_to, qty_in, qty_damaged, written_off, status, org_id) values
    ('a0000000-0000-4000-8000-0000000c4561', 'a0000000-0000-4000-8000-0000000a4551', pg_temp.ev('6'), 10, 'Ravi', 7, 1, 1, 'out', a),
    ('a0000000-0000-4000-8000-0000000c4562', 'a0000000-0000-4000-8000-0000000a4552', pg_temp.ev('6'), 20, 'Ravi', 20, 0, 15, 'returned', a);
  update public.inventory_checkouts set qty_used = 15 where id = 'a0000000-0000-4000-8000-0000000c4562';
end $$;
create temp table _inv as select i from jsonb_array_elements(public._r22_close_checks(pg_temp.ev('6'), pg_temp.org()) -> 'inventory') i;
select pg_temp.res('19 a part return: 3 still out, 6 back, 1 damaged (as Teardown and Wrap-up say)', (select (i ->> 'still_out')::numeric = 3 and (i ->> 'back')::numeric = 6 and (i ->> 'damaged')::numeric = 1 and i ->> 'state' = 'out'
  from _inv where i ->> 'item_id' = 'a0000000-0000-4000-8000-0000000a4551') and (pg_temp.chk('6', 'inventory') ->> 'detail') like 'Out and not back yet: 3 %', (select string_agg(i::text, ' ') from _inv) || ' ' || pg_temp.chk('6', 'inventory')::text);
select pg_temp.res('20 used-up candles are not counted as back', (select (i ->> 'back')::numeric = 5 and (i ->> 'still_out')::numeric = 0 and i ->> 'state' = 'back' from _inv where i ->> 'item_id' = 'a0000000-0000-4000-8000-0000000a4552'),
  (select string_agg(i::text, ' ') from _inv));
update public.inventory_checkouts set qty_in = 10, status = 'returned', checked_in_at = now() where id = 'a0000000-0000-4000-8000-0000000c4561';
select pg_temp.res('21 all back: the stock check passes', (pg_temp.chk('6', 'inventory') ->> 'status') <> 'fail', pg_temp.chk('6', 'inventory')::text);
select pg_temp.res('22 the server-only parts stay closed to the app', not has_function_privilege('authenticated', 'public._r455_adv_credit(uuid)', 'execute') and not has_function_privilege('anon', 'public._r455_booking_owed(uuid)', 'execute')
  and not has_function_privilege('authenticated', 'public._r22_close_checks__pre0455(uuid,uuid)', 'execute'));

select name, result from _rc where result <> 'PASS' order by name;
select 'R271-VENDOR-PAID-0455: ' || case when count(*) filter (where result <> 'PASS') = 0 then 'ALL PASS' else 'FAIL' end || ' (' || count(*) filter (where result = 'PASS') || '/' || count(*) || ')' from _rc;
rollback;
