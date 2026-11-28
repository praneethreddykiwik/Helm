-- r190-vendor-bills-0373.sql - R190 Money phase 2 "Finish vendor bills".
-- Proves: (1) privileges: new tables closed to the app, timer / claim / mark server only, page functions signed-in only, three
-- wraps kept once; (2) TDS off the payout = two payout rows (cash + TDS with its section), the bill counts as settled, the old
-- sums agree, same key = never twice, overpay / no section / too-high TDS refused; (3) cash over the studio limit to one vendor
-- in a day = a warning, never a block; (4) Finance only, own studio only (no-finance member and studio B refused / see nothing);
-- (5) typed advance -> payout rows (added rows only, oldest bill first, never above a bill's open amount, again = nothing),
-- the cost ledger does not count it twice, the typed advance is then locked; (6) photo / PDF added later (same event's file only);
-- (7) a bill after close: normal insert still refused, vendor_bill_add_late = admins only by default (setting widens it), reason
-- needed, the bill + its reason row exist; paying after close works through vendor_bill_pay (the old function still refuses);
-- (8) reminders: 3 days before / on the day / every 3 days overdue, never twice, not before 9:00, paid bills never; bell only for
-- the payers; e-mail rows; the claim re-checks (paid bill skipped) and gives the facts; payer = one person; vendor reminder
-- off by default, on = one e-mail to the vendor; free trial = bell only; (9) settings admin only + checked; (10) due list,
-- 150-day GST warning, TDS report; (11) free-trial purge / keep lists; (12) re-run safe.
-- Re-applies 0373 twice. Local disposable PG only. Fake data only. Rolled back.
\set ON_ERROR_STOP 0
set client_min_messages = error;
\ir ../../supabase/migrations/0373_r190_vendor_bills_finish.sql
\ir ../../supabase/migrations/0373_r190_vendor_bills_finish.sql
set client_min_messages = warning;
begin;
-- r271 (0455): a new bill takes the typed advance by itself (zz_r455_take_advance); this suite proves the 0373 button on bills made before that,
-- so the trigger is off while it runs (rolled back; tests/db/r271-vendor-paid-0455.sql proves the trigger)
do $$ begin if exists (select 1 from pg_trigger where tgname = 'zz_r455_take_advance') then alter table public.vendor_bills disable trigger zz_r455_take_advance; end if; end $$;
create temp table _rs(name text, result text); grant all on _rs to anon, authenticated, service_role;
create or replace function pg_temp.t(p_name text, p_ok boolean, p_detail text default '') returns void language plpgsql as $$
begin insert into _rs values (p_name, case when coalesce(p_ok, false) then 'PASS' else 'FAIL: ' || coalesce(p_detail, '') end); end $$;
create or replace function pg_temp.as_val(p_who text, p_sql text) returns text language plpgsql as $$
declare v text;
begin
  if p_who = 'anon' then perform auth.login_anon();
  elsif p_who is not null then perform auth.login_as((select id from auth.users where email = p_who)); end if;
  execute p_sql into v;
  perform auth.logout(); execute 'reset role';
  return 'ok:' || coalesce(v, '<null>');
exception when others then
  perform auth.logout(); execute 'reset role';
  return sqlstate || ' ' || sqlerrm;
end $$;
create temp table _k(k text primary key, v text); grant all on _k to anon, authenticated, service_role;

-- fixture: studio A, a confirmed live event, two vendors (one with an e-mail), a member with no Finance (designer, Finance off)
update public.organizations set timezone = 'Asia/Kolkata' where id = 'a0000000-0000-4000-8000-000000000001';
update public.quotes set deleted_at = null, status = 'confirmed', title = 'Rao Wedding', event_date = (now() - interval '2 days')::date, is_demo = false
 where id = 'a0000000-0000-4000-8000-00000000da01';
delete from public.vendor_bill_settings where org_id = 'a0000000-0000-4000-8000-000000000001';
do $$ declare u uuid; begin
  select id into u from auth.users where email = 'r190_ops@a.test';
  if u is null then u := auth.seed_user('r190_ops@a.test'); end if;
  insert into public.profiles(id, email, full_name, role, org_id, must_change_password, created_at)
    values (u, 'r190_ops@a.test', 'Opi Ops', 'designer', 'a0000000-0000-4000-8000-000000000001', false, now())
  on conflict (id) do update set role = excluded.role, org_id = excluded.org_id;
  insert into public.role_access(role, area, can_view, can_edit, org_id, updated_at) values ('designer', 'finance', false, false, 'a0000000-0000-4000-8000-000000000001', now())
  on conflict (role, area, org_id) do update set can_view = false, can_edit = false;
end $$;
update public.profiles set full_name = 'Asha Admin' where email = 'a_admin@a.test';
insert into public.vendors (id, name, category, email, org_id) values
  ('a0000000-0000-4000-8000-0000000a1901', 'Sri Sai Tents', 'tents', 'tents190@example.org', 'a0000000-0000-4000-8000-000000000001'),
  ('a0000000-0000-4000-8000-0000000a1902', 'Lotus Flowers', 'decor', null, 'a0000000-0000-4000-8000-000000000001');
insert into public.event_resources (id, quote_id, vendor_id, label, cost, advance, status, org_id) values
  ('a0000000-0000-4000-8000-0000000b1901', 'a0000000-0000-4000-8000-00000000da01', 'a0000000-0000-4000-8000-0000000a1901', 'Tent', 7000, 5000, 'confirmed', 'a0000000-0000-4000-8000-000000000001');
insert into public.vendor_bills (id, org_id, quote_id, booking_id, vendor_id, bill_no, bill_date, amount, due_date) values
  -- TDS bill
  ('a0000000-0000-4000-8000-0000000e1901', 'a0000000-0000-4000-8000-000000000001', 'a0000000-0000-4000-8000-00000000da01', null, 'a0000000-0000-4000-8000-0000000a1902', 'L-1', current_date, 18000, null),
  -- cash bills (same vendor)
  ('a0000000-0000-4000-8000-0000000e1902', 'a0000000-0000-4000-8000-000000000001', 'a0000000-0000-4000-8000-00000000da01', null, 'a0000000-0000-4000-8000-0000000a1902', 'L-2', current_date, 9000, null),
  -- the tent booking's two bills (advance 5000 goes 3000 + 2000)
  ('a0000000-0000-4000-8000-0000000e1903', 'a0000000-0000-4000-8000-000000000001', 'a0000000-0000-4000-8000-00000000da01', 'a0000000-0000-4000-8000-0000000b1901', 'a0000000-0000-4000-8000-0000000a1901', 'T-1', current_date - 5, 3000, null),
  ('a0000000-0000-4000-8000-0000000e1904', 'a0000000-0000-4000-8000-000000000001', 'a0000000-0000-4000-8000-00000000da01', 'a0000000-0000-4000-8000-0000000b1901', 'a0000000-0000-4000-8000-0000000a1901', 'T-2', current_date - 1, 4000, null);
insert into public.event_files (id, quote_id, storage_path, filename, org_id) values
  ('a0000000-0000-4000-8000-0000000f1901', 'a0000000-0000-4000-8000-00000000da01', 'a0000000-0000-4000-8000-000000000001/a0000000-0000-4000-8000-00000000da01/r190-bill.jpg', 'bill.jpg', 'a0000000-0000-4000-8000-000000000001'),
  ('b0000000-0000-4000-8000-0000000f1901', 'b0000000-0000-4000-8000-00000000da01', 'b0000000-0000-4000-8000-000000000001/b0000000-0000-4000-8000-00000000da01/r190-bill.jpg', 'bill.jpg', 'b0000000-0000-4000-8000-000000000001');
create or replace function pg_temp.pays(p_bill uuid) returns text language sql as $$
  select coalesce(string_agg(coalesce(source, 'old') || ':' || amount::numeric(12,2)::text, ',' order by source nulls first, amount), '') from public.vendor_payouts where bill_id = p_bill $$;

-- ---- 1) privileges + wraps ---------------------------------------------------------------------------------------------------
select pg_temp.t('1a new tables: RLS on + forced, no app privilege',
  (select bool_and(c.relrowsecurity and c.relforcerowsecurity) from pg_class c where c.oid in (to_regclass('public.vendor_bill_settings'), to_regclass('public.vendor_bill_files'),
     to_regclass('public.vendor_bill_late'), to_regclass('public.vendor_bill_reminders'), to_regclass('public.vendor_bill_mail_outbox')))
  and not has_table_privilege('authenticated', 'public.vendor_bill_settings', 'select')
  and not has_table_privilege('authenticated', 'public.vendor_bill_late', 'insert')
  and not has_table_privilege('authenticated', 'public.vendor_bill_mail_outbox', 'select')
  and not has_table_privilege('anon', 'public.vendor_bill_reminders', 'select'));
select pg_temp.t('1b timer / claim / mark / helpers / kept bodies: server only',
  not has_function_privilege('authenticated', 'public.vendor_bill_reminder_tick(timestamptz)', 'execute')
  and not has_function_privilege('authenticated', 'public.vendor_bill_reminder_claim(integer)', 'execute')
  and not has_function_privilege('anon', 'public.vendor_bill_reminder_mark(uuid,text)', 'execute')
  and not has_function_privilege('authenticated', 'public._r373_people(uuid)', 'execute')
  and not has_function_privilege('authenticated', 'public._r21_cost_lines__pre0373(uuid,uuid)', 'execute')
  and not has_function_privilege('authenticated', 'public._r23_visible(uuid,uuid)', 'execute')
  and has_function_privilege('service_role', 'public.vendor_bill_reminder_claim(integer)', 'execute'));
select pg_temp.t('1c page functions: signed-in only (each checks Finance itself)',
  has_function_privilege('authenticated', 'public.vendor_bill_pay(uuid,numeric,numeric,text,date,text,text,text)', 'execute')
  and not has_function_privilege('anon', 'public.vendor_bill_pay(uuid,numeric,numeric,text,date,text,text,text)', 'execute')
  and has_function_privilege('authenticated', 'public.vendor_bill_add_late(uuid,jsonb,text)', 'execute')
  and not has_function_privilege('anon', 'public.vendor_bills_extra(uuid)', 'execute')
  and not has_function_privilege('anon', 'public.vendor_bill_settings_set(jsonb)', 'execute')
  and has_function_privilege('authenticated', 'public.bell_feed(integer)', 'execute'));
select pg_temp.t('1d three wraps once, old bodies kept',
  to_regprocedure('public._r21_cost_lines__pre0373(uuid,uuid)') is not null and to_regprocedure('public._r23_visible__pre0373(uuid,uuid)') is not null
  and to_regprocedure('public.bell_feed__pre0373(integer)') is not null
  and position('r190-0373' in pg_get_functiondef(to_regprocedure('public._r21_cost_lines__pre0373(uuid,uuid)'))) = 0
  and position('r190-0373' in pg_get_functiondef(to_regprocedure('public.bell_feed(integer)'))) > 0
  and position('r190-0373' in pg_get_functiondef(to_regprocedure('public.tg_a152_money_create_guard()'))) > 0
  and to_regprocedure('public._r21_cost_lines__pre0373__pre0373(uuid,uuid)') is null);
select pg_temp.t('1e existing payouts untouched: the new columns are empty, no row was changed',
  not exists (select 1 from public.vendor_payouts where source is not null and created_at < now() - interval '1 hour'));

-- ---- 2) TDS off the payout -----------------------------------------------------------------------------------------------------
-- (each action runs in its own statement; the checks read the rows in the next one)
insert into _k values ('2a', pg_temp.as_val('a_staff@a.test', $q$select (public.vendor_bill_pay('a0000000-0000-4000-8000-0000000e1901', 17640, 360, '194c', current_date, 'Bank transfer', 'UTR1', 'k-r190-1') ->> 'balance')::numeric::text$q$));
select pg_temp.t('2a pay 17,640 + TDS 360 (194C): two rows, nothing left, bill settled',
  (select v from _k where k = '2a') = 'ok:0'
  and pg_temp.pays('a0000000-0000-4000-8000-0000000e1901') = 'manual:17640.00,tds:360.00'
  and (select tds_section from public.vendor_payouts where bill_id = 'a0000000-0000-4000-8000-0000000e1901' and source = 'tds') = '194C'
  and (select payout_ref from public.vendor_payouts where source = 'tds' and bill_id = 'a0000000-0000-4000-8000-0000000e1901')
      = (select id from public.vendor_payouts where source = 'manual' and bill_id = 'a0000000-0000-4000-8000-0000000e1901')
  and public._r373_open('a0000000-0000-4000-8000-0000000e1901') = 0,
  (select v from _k where k = '2a') || ' ' || pg_temp.pays('a0000000-0000-4000-8000-0000000e1901'));
select pg_temp.t('2b the old event P&L sees the bill fully paid (TDS counts as settled)',
  (select (public._vb_event_pnl('a0000000-0000-4000-8000-00000000da01', 'a0000000-0000-4000-8000-000000000001') ->> 'bills_paid')::numeric) >= 18000);
insert into _k values ('2c', pg_temp.as_val('a_staff@a.test', $q$select (public.vendor_bill_pay('a0000000-0000-4000-8000-0000000e1901', 17640, 360, '194C', current_date, 'Bank transfer', 'UTR1', 'k-r190-1') ->> 'duplicate')$q$));
select pg_temp.t('2c same key again: the same payment, never twice',
  (select v from _k where k = '2c') = 'ok:true'
  and (select count(*) from public.vendor_payouts where bill_id = 'a0000000-0000-4000-8000-0000000e1901') = 2);
select pg_temp.t('2d overpay / TDS without a section / too-high TDS refused',
  pg_temp.as_val('a_staff@a.test', $q$select public.vendor_bill_pay('a0000000-0000-4000-8000-0000000e1902', 9500, 0, null, current_date, 'UPI', null, 'k-r190-x1')::text$q$) like '22023 That would overpay%'
  and pg_temp.as_val('a_staff@a.test', $q$select public.vendor_bill_pay('a0000000-0000-4000-8000-0000000e1902', 100, 50, null, current_date, 'UPI', null, 'k-r190-x2')::text$q$) like '22023 Give the TDS section%'
  and pg_temp.as_val('a_staff@a.test', $q$select public.vendor_bill_pay('a0000000-0000-4000-8000-0000000e1902', 100, 4000, '194J', current_date, 'UPI', null, 'k-r190-x3')::text$q$) like '22023 That TDS looks too high%'
  and pg_temp.pays('a0000000-0000-4000-8000-0000000e1902') = '');

-- ---- 3) cash warning (not a block) ------------------------------------------------------------------------------------------------
select pg_temp.t('3a cash 8,000 to Lotus today: no warning',
  pg_temp.as_val('a_staff@a.test', $q$select jsonb_array_length(public.vendor_bill_pay('a0000000-0000-4000-8000-0000000e1902', 8000, 0, null, current_date, 'Cash', null, 'k-r190-c1') -> 'warnings')::text$q$) = 'ok:0');
select pg_temp.t('3b another 1,000 cash = 9,000 today: still under 10,000',
  pg_temp.as_val('a_staff@a.test', $q$select jsonb_array_length(public.vendor_bill_pay('a0000000-0000-4000-8000-0000000e1902', 1000, 0, null, current_date, 'Cash', null, 'k-r190-c2') -> 'warnings')::text$q$) = 'ok:0');
-- one more Lotus bill, paid in cash the same day: 9,000 + 2,500 > 10,000 -> warning, payment still recorded
insert into public.vendor_bills (id, org_id, quote_id, vendor_id, bill_no, bill_date, amount) values
  ('a0000000-0000-4000-8000-0000000e1905', 'a0000000-0000-4000-8000-000000000001', 'a0000000-0000-4000-8000-00000000da01', 'a0000000-0000-4000-8000-0000000a1902', 'L-3', current_date, 2500);
select pg_temp.t('3c cash over the limit to one vendor in a day: warning (Section 40A(3)), still recorded',
  pg_temp.as_val('a_staff@a.test', $q$select (public.vendor_bill_pay('a0000000-0000-4000-8000-0000000e1905', 2500, 0, null, current_date, 'Cash', null, 'k-r190-c3') -> 'warnings' -> 0 ->> 'code')$q$) = 'ok:cash_limit'
  and pg_temp.pays('a0000000-0000-4000-8000-0000000e1905') = 'manual:2500.00');

-- ---- 4) Finance only, own studio only ---------------------------------------------------------------------------------------------
select pg_temp.t('4a a member without Finance: refused everywhere',
  pg_temp.as_val('r190_ops@a.test', $q$select public.vendor_bill_pay('a0000000-0000-4000-8000-0000000e1903', 10, 0, null, null, null, null, null)::text$q$) like '42501%'
  and pg_temp.as_val('r190_ops@a.test', $q$select public.vendor_bills_extra('a0000000-0000-4000-8000-00000000da01')::text$q$) like '42501%'
  and pg_temp.as_val('r190_ops@a.test', $q$select public.vendor_bills_due(14)::text$q$) like '42501%'
  and pg_temp.as_val('r190_ops@a.test', $q$select public.vendor_tds_report(null, null)::text$q$) like '42501%'
  and pg_temp.as_val('r190_ops@a.test', $q$select public.vendor_bill_settings_get()::text$q$) like '42501%'
  and pg_temp.as_val('anon', $q$select public.vendor_bills_due(14)::text$q$) like '42501%');
select pg_temp.t('4b studio B: cannot pay, attach, convert or read studio A',
  pg_temp.as_val('b_admin@b.test', $q$select public.vendor_bill_pay('a0000000-0000-4000-8000-0000000e1903', 10, 0, null, null, null, null, null)::text$q$) like 'P0002%'
  and pg_temp.as_val('b_admin@b.test', $q$select public.vendor_bill_attach('a0000000-0000-4000-8000-0000000e1903', 'a0000000-0000-4000-8000-0000000f1901')::text$q$) like 'P0002%'
  and pg_temp.as_val('b_admin@b.test', $q$select public.vendor_bill_convert_advances('a0000000-0000-4000-8000-00000000da01')::text$q$) like 'P0002%'
  and pg_temp.as_val('b_admin@b.test', $q$select coalesce(public.vendor_bills_extra('a0000000-0000-4000-8000-00000000da01')::text, 'none')$q$) = 'ok:none'
  and pg_temp.as_val('b_admin@b.test', $q$select jsonb_array_length(public.vendor_bills_due(60) -> 'bills')::text$q$) = 'ok:0'
  and pg_temp.as_val('b_admin@b.test', $q$select jsonb_array_length(public.vendor_tds_report(null, null) -> 'rows')::text$q$) = 'ok:0');

-- ---- 5) typed advance -> payout rows ------------------------------------------------------------------------------------------------
insert into _k values ('paid_before', (select (l ->> 'paid') from jsonb_array_elements(public._r21_cost_lines('a0000000-0000-4000-8000-00000000da01', 'a0000000-0000-4000-8000-000000000001')) l
                                        where l ->> 'source' = 'booking' and l ->> 'source_id' = 'a0000000-0000-4000-8000-0000000b1901'));
select pg_temp.t('5a extras: 5,000 typed advance, nothing converted, convertible',
  pg_temp.as_val('a_staff@a.test', $q$select (select b ->> 'left' || '|' || (b ->> 'convertible') from jsonb_array_elements(public.vendor_bills_extra('a0000000-0000-4000-8000-00000000da01') -> 'bookings') b)$q$) = 'ok:5000|true');
select pg_temp.t('5b convert: 3,000 on the older bill, 2,000 on the newer one (added rows only)',
  pg_temp.as_val('a_staff@a.test', $q$select (public.vendor_bill_convert_advances('a0000000-0000-4000-8000-00000000da01') ->> 'rows')$q$) = 'ok:2'
  and pg_temp.pays('a0000000-0000-4000-8000-0000000e1903') = 'advance:3000.00'
  and pg_temp.pays('a0000000-0000-4000-8000-0000000e1904') = 'advance:2000.00'
  and (select advance from public.event_resources where id = 'a0000000-0000-4000-8000-0000000b1901') = 5000,
  pg_temp.pays('a0000000-0000-4000-8000-0000000e1903') || ' / ' || pg_temp.pays('a0000000-0000-4000-8000-0000000e1904'));
select pg_temp.t('5c convert again: nothing more',
  pg_temp.as_val('a_staff@a.test', $q$select (public.vendor_bill_convert_advances('a0000000-0000-4000-8000-00000000da01') ->> 'rows')$q$) = 'ok:0'
  and (select count(*) from public.vendor_payouts where source = 'advance') = 2);
select pg_temp.t('5d the cost ledger does not count the advance twice (paid stays 5,000)',
  (select (l ->> 'paid')::numeric from jsonb_array_elements(public._r21_cost_lines('a0000000-0000-4000-8000-00000000da01', 'a0000000-0000-4000-8000-000000000001')) l
    where l ->> 'source' = 'booking' and l ->> 'source_id' = 'a0000000-0000-4000-8000-0000000b1901') = (select v::numeric from _k where k = 'paid_before')
  and (select v::numeric from _k where k = 'paid_before') = 5000, (select v from _k where k = 'paid_before'));
select pg_temp.t('5e the typed advance is now locked for the app (the system can still write)',
  pg_temp.as_val('a_admin@a.test', $q$with u as (update public.event_resources set advance = 6000 where id = 'a0000000-0000-4000-8000-0000000b1901' returning 1) select count(*)::text from u$q$) like '23514 This advance is already recorded%'
  and pg_temp.as_val('a_admin@a.test', $q$with u as (update public.event_resources set note = 'ok' where id = 'a0000000-0000-4000-8000-0000000b1901' returning 1) select count(*)::text from u$q$) = 'ok:1');

-- ---- 6) photo / PDF added later --------------------------------------------------------------------------------------------------------
insert into _k values ('6a', pg_temp.as_val('a_staff@a.test', $q$select (public.vendor_bill_attach('a0000000-0000-4000-8000-0000000e1903', 'a0000000-0000-4000-8000-0000000f1901') ->> 'ok')$q$));
select pg_temp.t('6a attach a file of the same event: one row, the bill row unchanged',
  (select v from _k where k = '6a') = 'ok:true'
  and (select count(*) from public.vendor_bill_files where bill_id = 'a0000000-0000-4000-8000-0000000e1903') = 1
  and (select file_id from public.vendor_bills where id = 'a0000000-0000-4000-8000-0000000e1903') is null);
select pg_temp.t('6b a file of another event / studio refused',
  pg_temp.as_val('a_staff@a.test', $q$select public.vendor_bill_attach('a0000000-0000-4000-8000-0000000e1903', 'b0000000-0000-4000-8000-0000000f1901')::text$q$) like 'P0002 file not found%');

-- ---- 7) a bill after the event closed = a late adjustment ---------------------------------------------------------------------------
grant select on public.event_files to authenticated;   -- Supabase gives the app this grant; the local shim does not (rolled back)
insert into public.event_closure (quote_id, closed_at, org_id) values ('a0000000-0000-4000-8000-00000000da01', now(), 'a0000000-0000-4000-8000-000000000001')
  on conflict (quote_id) do update set closed_at = now();
select pg_temp.t('7a closed event: a normal new bill is still refused',
  pg_temp.as_val('a_admin@a.test', $q$with i as (insert into public.vendor_bills (quote_id, amount, org_id) values ('a0000000-0000-4000-8000-00000000da01', 500, 'a0000000-0000-4000-8000-000000000001') returning 1) select count(*)::text from i$q$) like '23514 This event is closed%');
-- with the 0372 money lock installed its studio switch decides: re-open (default) refuses a late bill, admin allows it
insert into _k values ('7x', case when to_regclass('public.money_settings') is null then 'no-0372'
  else pg_temp.as_val('a_admin@a.test', $q$select public.vendor_bill_add_late('a0000000-0000-4000-8000-00000000da01', '{"amount": 1200}', 'Generator bill came a week later')::text$q$) end);
do $$ begin
  if to_regclass('public.money_settings') is not null then
    execute $x$insert into public.money_settings (org_id, late_adjust) values ('a0000000-0000-4000-8000-000000000001', 'admin')
             on conflict (org_id) do update set late_adjust = 'admin'$x$;
  end if;
end $$;
select pg_temp.t('7x money lock (0372) switch "re-open" refuses a late bill; without 0372 nothing to check',
  (select v from _k where k = '7x') = 'no-0372' or (select v from _k where k = '7x') like '42501 This studio re-opens a closed event%', (select v from _k where k = '7x'));
select pg_temp.t('7b a late bill: Finance editor (not admin) refused by default; short reason refused; not-closed refused',
  pg_temp.as_val('a_staff@a.test', $q$select public.vendor_bill_add_late('a0000000-0000-4000-8000-00000000da01', '{"amount": 1200}', 'Generator bill came a week later')::text$q$) like '42501 Only a studio admin%'
  and pg_temp.as_val('a_admin@a.test', $q$select public.vendor_bill_add_late('a0000000-0000-4000-8000-00000000da01', '{"amount": 1200}', 'late')::text$q$) like '22023 Say why%'
  and pg_temp.as_val('b_admin@b.test', $q$select public.vendor_bill_add_late('b0000000-0000-4000-8000-00000000da01', '{"amount": 1200}', 'Generator bill came a week later')::text$q$) like '22023 This event is not closed%');
insert into _k values ('7c', pg_temp.as_val('a_admin@a.test', $q$select (public.vendor_bill_add_late('a0000000-0000-4000-8000-00000000da01',
      '{"amount": 1200, "bill_no": "G-9", "vendor_id": "a0000000-0000-4000-8000-0000000a1901", "gst_amount": 183, "gst_claimable": true}', 'Generator bill came a week later') ->> 'late')$q$));
select pg_temp.t('7c the admin adds it: bill + reason row, event stays closed',
  (select v from _k where k = '7c') = 'ok:true'
  and exists (select 1 from public.vendor_bills b join public.vendor_bill_late l on l.bill_id = b.id
               where b.bill_no = 'G-9' and b.amount = 1200 and b.gst_amount = 183 and l.reason = 'Generator bill came a week later' and l.closed_at is not null)
  and (select closed_at from public.event_closure where quote_id = 'a0000000-0000-4000-8000-00000000da01') is not null);
create or replace function pg_temp.snap_late() returns boolean language plpgsql as $f$
declare v boolean;
begin
  if to_regclass('public.event_pnl_snapshots') is null then return true; end if;   -- no 0372 here: nothing to check
  execute $x$select exists (select 1 from public.event_pnl_snapshots where quote_id = 'a0000000-0000-4000-8000-00000000da01' and reason = 'late_adjustment'
               and note like 'Late vendor bill: Generator bill came a week later%')$x$ into v;
  return v;
end $f$;
select pg_temp.t('7c2 with 0372: the late bill wrote the next frozen P&L version (late_adjustment)',
  pg_temp.snap_late());
select pg_temp.t('7d a normal insert is STILL refused after the late one (the bypass is for that one bill only)',
  pg_temp.as_val('a_admin@a.test', $q$with i as (insert into public.vendor_bills (quote_id, amount, org_id) values ('a0000000-0000-4000-8000-00000000da01', 600, 'a0000000-0000-4000-8000-000000000001') returning 1) select count(*)::text from i$q$) like '23514 This event is closed%');
select pg_temp.t('7e studio setting "Finance editors" lets the Finance editor add a late bill',
  pg_temp.as_val('a_admin@a.test', $q$select (public.vendor_bill_settings_set('{"late_who": "finance"}') ->> 'late_who')$q$) = 'ok:finance'
  and pg_temp.as_val('a_staff@a.test', $q$select (public.vendor_bill_add_late('a0000000-0000-4000-8000-00000000da01', '{"amount": 300}', 'Courier for the returned lights') ->> 'late')$q$) = 'ok:true');
select pg_temp.t('7f paying after close: vendor_bill_pay works (marked after_close), the old payout function still refuses',
  pg_temp.as_val('a_staff@a.test', $q$select (public.vendor_bill_pay('a0000000-0000-4000-8000-0000000e1904', 500, 0, null, current_date, 'UPI', null, 'k-r190-ac') ->> 'after_close')$q$) = 'ok:true'
  and pg_temp.as_val('a_staff@a.test', $q$select public.record_vendor_payout('a0000000-0000-4000-8000-0000000e1904', 100, current_date, 'UPI', null, 'k-r190-old')::text$q$) like '23514 This event is closed%');
delete from public.event_closure where quote_id = 'a0000000-0000-4000-8000-00000000da01';

-- ---- 8) due reminders ---------------------------------------------------------------------------------------------------------------------
insert into _k values ('today', public._a198_org_today('a0000000-0000-4000-8000-000000000001')::text);
create or replace function pg_temp.at(p_hour int) returns timestamptz language sql as $$
  select ((select v::date from _k where k = 'today') + make_time(p_hour, 5, 0)) at time zone 'Asia/Kolkata' $$;
insert into public.vendor_bills (id, org_id, quote_id, vendor_id, bill_no, bill_date, amount, due_date)
select x.id::uuid, 'a0000000-0000-4000-8000-000000000001', 'a0000000-0000-4000-8000-00000000da01', 'a0000000-0000-4000-8000-0000000a1901', x.no,
       (select v::date from _k where k = 'today') - 10, 18000, (select v::date from _k where k = 'today') + x.d
  from (values ('a0000000-0000-4000-8000-0000000e1911', 'D3', 3), ('a0000000-0000-4000-8000-0000000e1912', 'D0', 0),
               ('a0000000-0000-4000-8000-0000000e1913', 'O1', -1), ('a0000000-0000-4000-8000-0000000e1914', 'O2', -2),
               ('a0000000-0000-4000-8000-0000000e1915', 'O4', -4), ('a0000000-0000-4000-8000-0000000e1916', 'D2', 2)) x(id, no, d);
-- a paid one, due today: never reminded
insert into public.vendor_bills (id, org_id, quote_id, vendor_id, bill_no, bill_date, amount, due_date) values
  ('a0000000-0000-4000-8000-0000000e1917', 'a0000000-0000-4000-8000-000000000001', 'a0000000-0000-4000-8000-00000000da01', 'a0000000-0000-4000-8000-0000000a1901', 'PD',
   (select v::date from _k where k = 'today') - 10, 1000, (select v::date from _k where k = 'today'));
insert into public.vendor_payouts (bill_id, org_id, amount) values ('a0000000-0000-4000-8000-0000000e1917', 'a0000000-0000-4000-8000-000000000001', 1000);
create or replace function pg_temp.slots() returns text language sql as $$
  select coalesce(string_agg(b.bill_no || '=' || r.slot, ',' order by b.bill_no), '') from public.vendor_bill_reminders r join public.vendor_bills b on b.id = r.bill_id
   where b.bill_no in ('D3', 'D0', 'O1', 'O2', 'O4', 'D2', 'PD') $$;
select public.vendor_bill_reminder_tick(pg_temp.at(7));
select pg_temp.t('8a before 9:00 studio time: nothing', pg_temp.slots() = '', pg_temp.slots());
select public.vendor_bill_reminder_tick(pg_temp.at(10));
select pg_temp.t('8b 3 days before / on the day / overdue day 1 and day 4 (every 3 days); not day 2, not 2 days before, not the paid one',
  pg_temp.slots() = 'D0=due,D3=before,O1=overdue:1,O4=overdue:4', pg_temp.slots());
select public.vendor_bill_reminder_tick(pg_temp.at(11));
select pg_temp.t('8c the next hour adds nothing (never twice)', (select count(*) from public.vendor_bill_reminders r join public.vendor_bills b on b.id = r.bill_id where b.bill_no in ('D3', 'D0', 'O1', 'O4')) = 4);
select pg_temp.t('8d one bell notice per reminder, named on the admin only, with the money in the label',
  (select count(*) from public.notifications where kind = 'vendor_bill_due' and detail ->> 'source' = '0373') = 4
  and (select bool_and(detail -> 'notify' = jsonb_build_array((select id::text from auth.users where email = 'a_admin@a.test')))
         from public.notifications where kind = 'vendor_bill_due')
  and exists (select 1 from public.notifications where kind = 'vendor_bill_due' and detail ->> 'label' like 'Vendor bill due in 3 days: Rs 18,000 to Sri Sai Tents (#D3) - Rao Wedding'));
select pg_temp.t('8e the bell: the admin sees them, a Finance editor who is not the payer does not',
  pg_temp.as_val('a_admin@a.test', $q$select count(*)::text from jsonb_array_elements(public.bell_feed(100) -> 'items') i where i ->> 'kind' = 'vendor_bill_due'$q$) = 'ok:4'
  and pg_temp.as_val('a_staff@a.test', $q$select count(*)::text from jsonb_array_elements(public.bell_feed(100) -> 'items') i where i ->> 'kind' = 'vendor_bill_due'$q$) = 'ok:0'
  and pg_temp.as_val('b_admin@b.test', $q$select count(*)::text from jsonb_array_elements(public.bell_feed(100) -> 'items') i where i ->> 'kind' = 'vendor_bill_due'$q$) = 'ok:0',
  pg_temp.as_val('a_admin@a.test', $q$select count(*)::text from jsonb_array_elements(public.bell_feed(100) -> 'items') i where i ->> 'kind' = 'vendor_bill_due'$q$));
select pg_temp.t('8f one e-mail row per reminder to the admin; none to the vendor (off by default)',
  (select count(*) from public.vendor_bill_mail_outbox where audience = 'office' and recipient = 'a_admin@a.test') = 4
  and not exists (select 1 from public.vendor_bill_mail_outbox where audience = 'vendor'));
-- pay D0 in full before the e-mail goes: its row is skipped at claim time
insert into public.vendor_payouts (bill_id, org_id, amount) values ('a0000000-0000-4000-8000-0000000e1912', 'a0000000-0000-4000-8000-000000000001', 18000);
create temp table _c as select public.vendor_bill_reminder_claim(100) as v;
select pg_temp.t('8g claim: 3 rows with the facts (open amount, due date, days, event, studio); the paid bill skipped',
  (select jsonb_array_length(v) from _c) = 3
  and (select count(*) from public.vendor_bill_mail_outbox o join public.vendor_bills b on b.id = o.bill_id where b.bill_no = 'D0' and o.status = 'skipped' and o.reason = 'recheck') = 1
  and exists (select 1 from _c, jsonb_array_elements(v) x where x ->> 'kind' = 'before' and (x ->> 'open')::numeric = 18000 and (x ->> 'days')::int = 3
                and x ->> 'vendor' = 'Sri Sai Tents' and x ->> 'event' = 'Rao Wedding' and x ->> 'studio' = 'Studio A' and x ->> 'to' = 'a_admin@a.test'
                and x ->> 'due_text' ~ '^[0-9]{2}/[0-9]{2}/[0-9]{4}$'),
  (select v::text from _c));
insert into _k values ('8h', public.vendor_bill_reminder_mark((select (v -> 0 ->> 'id')::uuid from _c), 'sent'));
select pg_temp.t('8h mark sent', (select v from _k where k = '8h') = 'sent'
  and (select status from public.vendor_bill_mail_outbox where id = (select (v -> 0 ->> 'id')::uuid from _c)) = 'sent');
-- payer = one person (the Finance editor), vendor reminders on
select pg_temp.t('8i settings: admin sets payer = one person + vendor reminders 2 days before',
  pg_temp.as_val('a_admin@a.test', format($q$select (public.vendor_bill_settings_set('{"payer_kind": "person", "payer_profile": "%s", "vendor_reminders": true, "vendor_days_before": 2}') ->> 'payer_kind')$q$,
    (select id from auth.users where email = 'a_staff@a.test'))) = 'ok:person');
insert into public.vendor_bills (id, org_id, quote_id, vendor_id, bill_no, bill_date, amount, due_date) values
  ('a0000000-0000-4000-8000-0000000e1918', 'a0000000-0000-4000-8000-000000000001', 'a0000000-0000-4000-8000-00000000da01', 'a0000000-0000-4000-8000-0000000a1901', 'N3',
   (select v::date from _k where k = 'today'), 5000, (select v::date from _k where k = 'today') + 3);
select public.vendor_bill_reminder_tick(pg_temp.at(12));
select pg_temp.t('8j the named person gets the new reminder (bell + e-mail); the vendor gets one e-mail for the bill due in 2 days',
  (select detail -> 'notify' from public.notifications n where kind = 'vendor_bill_due' and detail ->> 'bill_no' = 'N3')
     = jsonb_build_array((select id::text from auth.users where email = 'a_staff@a.test'))
  and exists (select 1 from public.vendor_bill_mail_outbox o join public.vendor_bills b on b.id = o.bill_id where b.bill_no = 'N3' and o.audience = 'office' and o.recipient = 'a_staff@a.test')
  and (select count(*) from public.vendor_bill_mail_outbox o join public.vendor_bills b on b.id = o.bill_id where o.audience = 'vendor') = 1
  and exists (select 1 from public.vendor_bill_mail_outbox o join public.vendor_bills b on b.id = o.bill_id where b.bill_no = 'D2' and o.audience = 'vendor' and o.recipient = 'tents190@example.org'));
create temp table _c2 as select public.vendor_bill_reminder_claim(100) as v;
select pg_temp.t('8k vendor e-mail claimed with its facts; office rows of the old payer are skipped (no longer the payer)',
  exists (select 1 from _c2, jsonb_array_elements(v) x where x ->> 'audience' = 'vendor' and x ->> 'kind' = 'vendor_before' and x ->> 'to' = 'tents190@example.org')
  and not exists (select 1 from _c2, jsonb_array_elements(v) x where x ->> 'to' = 'a_admin@a.test'),
  (select v::text from _c2));
-- free trial: bell only
insert into public.studio_subscriptions (org_id, status, trial_ends_at) values ('a0000000-0000-4000-8000-000000000001', 'trial', (now() + interval '10 days')::date)
  on conflict (org_id) do update set status = 'trial', trial_ends_at = (now() + interval '10 days')::date;
insert into public.vendor_bills (id, org_id, quote_id, vendor_id, bill_no, bill_date, amount, due_date) values
  ('a0000000-0000-4000-8000-0000000e1919', 'a0000000-0000-4000-8000-000000000001', 'a0000000-0000-4000-8000-00000000da01', 'a0000000-0000-4000-8000-0000000a1901', 'TR',
   (select v::date from _k where k = 'today'), 5000, (select v::date from _k where k = 'today'));
select public.vendor_bill_reminder_tick(pg_temp.at(13));
select pg_temp.t('8l free trial: the reminder + bell, no e-mail',
  coalesce(public.trial_send_blocked('a0000000-0000-4000-8000-000000000001', 'a0000000-0000-4000-8000-00000000da01', null), false)
  and exists (select 1 from public.notifications where kind = 'vendor_bill_due' and detail ->> 'bill_no' = 'TR')
  and not exists (select 1 from public.vendor_bill_mail_outbox o join public.vendor_bills b on b.id = o.bill_id where b.bill_no = 'TR'));
delete from public.studio_subscriptions where org_id = 'a0000000-0000-4000-8000-000000000001';

-- ---- 9) settings --------------------------------------------------------------------------------------------------------------------------
select pg_temp.t('9a settings: Finance editor reads but cannot save; bad numbers refused; payer must be an office member',
  pg_temp.as_val('a_staff@a.test', $q$select (public.vendor_bill_settings_get() ->> 'can_edit')$q$) = 'ok:false'
  and pg_temp.as_val('a_staff@a.test', $q$select public.vendor_bill_settings_set('{"days_before": 5}')::text$q$) like '42501%'
  and pg_temp.as_val('a_admin@a.test', $q$select public.vendor_bill_settings_set('{"days_before": 99}')::text$q$) like '22023 One of the settings is out of range%'
  and pg_temp.as_val('a_admin@a.test', $q$select public.vendor_bill_settings_set('{"payer_kind": "role", "payer_role": "crew"}')::text$q$) like '22023 Choose an office role%'
  and pg_temp.as_val('a_admin@a.test', $q$select public.vendor_bill_settings_set('{"payer_kind": "person", "payer_profile": "b0000000-0000-4000-8000-000000000001"}')::text$q$) like '22023 Choose a person%');
select pg_temp.t('9b a saved change is in the audit trail',
  exists (select 1 from public.audit_log where action = 'vendor_bills.settings' and org_id = 'a0000000-0000-4000-8000-000000000001'));

-- ---- 10) due list, GST 150-day warning, TDS report ----------------------------------------------------------------------------------------
insert into public.vendor_bills (id, org_id, quote_id, vendor_id, bill_no, bill_date, amount, gst_amount, gst_claimable) values
  ('a0000000-0000-4000-8000-0000000e1920', 'a0000000-0000-4000-8000-000000000001', 'a0000000-0000-4000-8000-00000000da01', 'a0000000-0000-4000-8000-0000000a1901', 'OLD',
   (select v::date from _k where k = 'today') - 155, 11800, 1800, true);
select pg_temp.t('10a due list: overdue + soon bills and the 155-day-old GST bill (with its warning), never a paid one',
  pg_temp.as_val('a_staff@a.test', $q$select string_agg(x ->> 'bill_no' || ':' || (x ->> 'state'), ',' order by x ->> 'bill_no') from jsonb_array_elements(public.vendor_bills_due(14) -> 'bills') x
     where x ->> 'bill_no' in ('O1', 'O4', 'D3', 'OLD', 'PD', 'D0')$q$) = 'ok:D3:soon,O1:overdue,O4:overdue,OLD:gst'
  and pg_temp.as_val('a_staff@a.test', $q$select (x ->> 'gst_warn') from jsonb_array_elements(public.vendor_bills_due(14) -> 'bills') x where x ->> 'bill_no' = 'OLD'$q$) = 'ok:true',
  pg_temp.as_val('a_staff@a.test', $q$select string_agg(x ->> 'bill_no' || ':' || (x ->> 'state'), ',' order by x ->> 'bill_no') from jsonb_array_elements(public.vendor_bills_due(14) -> 'bills') x$q$));
select pg_temp.t('10b TDS report: the 360 row with section, vendor and event',
  pg_temp.as_val('a_staff@a.test', $q$select (r ->> 'amount') || '|' || (r ->> 'section') || '|' || (r ->> 'vendor') || '|' || (r ->> 'event') from jsonb_array_elements(public.vendor_tds_report(null, null) -> 'rows') r$q$)
    = 'ok:360.00|194C|Lotus Flowers|Rao Wedding');
select pg_temp.t('10c Settlement extras: GST warning on the old bill, TDS suggestion from the studio default when set',
  pg_temp.as_val('a_admin@a.test', $q$select (public.vendor_bill_settings_set('{"tds_section": "194C", "tds_pct": 2}') ->> 'tds_pct')$q$) = 'ok:2'
  and pg_temp.as_val('a_staff@a.test', $q$select (b ->> 'gst_warn') || '|' || (b -> 'tds_suggest' ->> 'amount') || '|' || (b -> 'tds_suggest' ->> 'from')
      from jsonb_array_elements(public.vendor_bills_extra('a0000000-0000-4000-8000-00000000da01') -> 'bills') b where b ->> 'id' = 'a0000000-0000-4000-8000-0000000e1920'$q$) = 'ok:true|200|default');

-- ---- 11) free-trial retention ---------------------------------------------------------------------------------------------------------------
select pg_temp.t('11 the trial purge list knows the bill records (before vendor_payouts), the keep list the setting',
  position('''vendor_bill_mail_outbox'', ''vendor_bill_reminders'', ''vendor_bill_files'', ''vendor_bill_late'', ''vendor_payouts''' in pg_get_functiondef(to_regprocedure('public._tr184_purge_tables()'))) > 0
  and position('''vendor_bill_settings''' in pg_get_functiondef(to_regprocedure('public._tr184_keep_tables()'))) > 0
  and (length(pg_get_functiondef(to_regprocedure('public._tr184_purge_tables()'))) - length(replace(pg_get_functiondef(to_regprocedure('public._tr184_purge_tables()')), '''vendor_bill_late''', ''))) / length('''vendor_bill_late''') = 1);

-- ---- 12) re-run safe -------------------------------------------------------------------------------------------------------------------------
select pg_temp.t('12 one source check rule, every wrap once, one cron job at most',
  (select count(*) from pg_constraint where conrelid = 'public.vendor_payouts'::regclass and conname = 'vendor_payouts_src_0373_ck') = 1
  and (select count(*) from pg_proc where proname in ('_r21_cost_lines__pre0373', 'bell_feed__pre0373', '_r23_visible__pre0373')) = 3
  and (select count(*) from pg_trigger where tgrelid = 'public.event_resources'::regclass and tgname = 'ad_r373_advance_lock') = 1);

do $$ declare n int; f int; r record; begin
  select count(*), count(*) filter (where result <> 'PASS') into n, f from _rs;
  for r in select * from _rs where result <> 'PASS' loop raise warning '% -> %', r.name, r.result; end loop;
  if f = 0 then raise warning 'R190-VENDOR-BILLS-0373: ALL PASS (%/%)', n, n;
  else raise warning 'R190-VENDOR-BILLS-0373: % FAILED of %', f, n; end if;
end $$;
rollback;
