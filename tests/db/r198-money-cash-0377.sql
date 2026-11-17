-- r198-money-cash-0377.sql - R198 P&L clarity phase 2 (0377). Proves: (1) applied twice, no row anywhere rewritten, no table
-- added, the call writes nothing; (2) anon / a role without Finance view refused, another studio's or an unknown event = null;
-- (3) money in: client payments received (= the header's Received), the payment plan still to come capped at the balance,
-- overdue flag + next instalment, client TDS listed as not cash; (4) money out: vendor payouts made (a TDS payout is not cash,
-- it is owed to the tax office), open bills by due date with part paid, crew wages, expense claims paid / approved / waiting,
-- refunds; (5) the four totals = the entries, the running cash left ends at the cash left; (6) "cash left is not profit": the
-- parts add up to the cash left exactly; (7) who owes what: client / vendors / crew / pay-backs / GST; (8) per-person crew pay
-- for the admin only (a Finance manager gets one total, no names); (9) a closed + frozen event still answers (frozen lines);
-- (10) grants / definer / search_path. Dates relative to the studio's today. Local disposable PG only. Rolled back.
\set ON_ERROR_STOP 0
set client_min_messages = warning;
begin;
create temp table _rm(name text, result text); grant all on _rm to anon, authenticated, service_role;
create temp table _rkv(k text primary key, v text); grant all on _rkv to anon, authenticated, service_role;

create or replace function pg_temp.su() returns void language plpgsql as $$
begin execute 'reset role'; perform auth.logout(); execute 'reset role'; end $$;
create or replace function pg_temp.login(p_email text) returns void language plpgsql as $$
declare u uuid; begin
  perform pg_temp.su(); select id into u from auth.users where email = p_email;
  perform set_config('request.jwt.claims', jsonb_build_object('sub', u, 'role', 'authenticated', 'email', p_email, 'aal', 'aal1')::text, false);
  perform set_config('role', 'authenticated', false);
end $$;
create or replace function pg_temp.anon() returns void language plpgsql as $$
begin perform pg_temp.su(); perform set_config('role', 'anon', false); end $$;
create or replace function pg_temp.res(p_name text, p_ok boolean, p_detail text default '') returns void language plpgsql as $$
begin insert into _rm values (p_name, case when coalesce(p_ok, false) then 'PASS' else 'FAIL: '||coalesce(p_detail,'') end); end $$;
grant execute on function pg_temp.res(text, boolean, text) to anon, authenticated, service_role;
create or replace function pg_temp.try(p_sql text) returns text language plpgsql as $$
begin execute p_sql; return ''; exception when others then return sqlstate || ' ' || sqlerrm; end $$;
grant execute on function pg_temp.try(text) to anon, authenticated, service_role;
create or replace function pg_temp.j(p_sql text) returns jsonb language plpgsql as $$
declare v jsonb; begin execute p_sql into v; return v; exception when others then return jsonb_build_object('err', sqlstate || ' ' || sqlerrm); end $$;
grant execute on function pg_temp.j(text) to anon, authenticated, service_role;
create or replace function pg_temp.put(p_k text, p_v text) returns void language plpgsql as $$
begin insert into _rkv values (p_k, p_v) on conflict (k) do update set v = excluded.v; end $$;
grant execute on function pg_temp.put(text, text) to anon, authenticated, service_role;
create or replace function pg_temp.get(p_k text) returns text language sql as $$ select v from _rkv where k = p_k $$;
grant execute on function pg_temp.get(text) to anon, authenticated, service_role;
create or replace function pg_temp.cat(p jsonb, p_cat text, p_k text) returns text language sql as $$
  select c ->> p_k from jsonb_array_elements(p -> 'categories') c where c ->> 'key' = p_cat $$;
grant execute on function pg_temp.cat(jsonb, text, text) to anon, authenticated, service_role;
create or replace function pg_temp.kinds(p jsonb) returns text language sql as $$
  select coalesce(string_agg(a ->> 'kind' || ':' || (a ->> 'level'), ',' order by ord), '') from jsonb_array_elements(p -> 'attention') with ordinality x(a, ord) $$;
grant execute on function pg_temp.kinds(jsonb) to anon, authenticated, service_role;
create or replace function pg_temp.member(p_email text, p_role text, p_org uuid) returns uuid language plpgsql as $$
declare u uuid; begin
  perform pg_temp.su(); select id into u from auth.users where email = p_email;
  if u is null then u := auth.seed_user(p_email); end if;
  insert into public.profiles(id, email, role, org_id, must_change_password, created_at) values (u, p_email, p_role, p_org, false, now())
    on conflict (id) do update set org_id = excluded.org_id, role = excluded.role;
  return u;
end $$;
create or replace function pg_temp.rows_hash() returns text language sql as $$
  select md5(coalesce((select string_agg(to_jsonb(k)::text, ',' order by k.id) from public.event_costs k), '')
          || coalesce((select string_agg(to_jsonb(b)::text, ',' order by b.id) from public.vendor_bills b), '')
          || coalesce((select string_agg(to_jsonb(p)::text, ',' order by p.id) from public.quote_payments p), '')
          || coalesce((select string_agg(to_jsonb(m)::text, ',' order by m.id) from public.payment_milestones m), '')
          || coalesce((select string_agg(to_jsonb(s)::text, ',' order by s.org_id) from public.money_settings s), '')
          || coalesce((select string_agg(to_jsonb(c)::text, ',' order by c.org_id, c.key) from public.app_config c), '')
          || coalesce((select string_agg(to_jsonb(x)::text, ',' order by x.id) from public.expense_claims x), '')
          || coalesce((select string_agg(to_jsonb(v)::text, ',' order by v.id) from public.vendor_payouts v), '')
          || coalesce((select string_agg(to_jsonb(t)::text, ',' order by t.id) from public.client_tds t), '')
          || coalesce((select string_agg(to_jsonb(f)::text, ',' order by f.id) from public.event_refunds f), '')) $$;

-- ---- setup: studio A event A-0001 (2,36,000 incl. 18% GST = 2,00,000 + 36,000), event 3 days ago, nothing closed --------------
do $$ declare a uuid := 'a0000000-0000-4000-8000-000000000001'; q uuid := 'a0000000-0000-4000-8000-00000000da01';
  v1 uuid; bk1 uuid; bk2 uuid; c1 uuid; c2 uuid;
begin
  perform pg_temp.member('r198_coord@a.test', 'coordinator', a);      -- no finance
  perform pg_temp.member('r198_mgr@a.test', 'manager', a);            -- finance view, not admin
  perform pg_temp.su();
  update public.organizations set timezone = 'Asia/Kolkata' where id = a;
  if to_regclass('public.event_pnl_snapshots') is not null then
    delete from public.event_pnl_snapshots where quote_id = q; delete from public.money_corrections where quote_id = q;
    delete from public.crew_wage_confirmations where quote_id = q; delete from public.client_tds_certificates where quote_id = q;
    delete from public.client_tds where quote_id = q and corrects_id is not null; delete from public.client_tds where quote_id = q;
  end if;
  delete from public.event_closure where quote_id = q;
  delete from public.vendor_payouts where bill_id in (select id from public.vendor_bills where quote_id = q);
  delete from public.vendor_bills where quote_id = q;
  delete from public.event_costs where quote_id = q;
  delete from public.expense_claims where quote_id = q;
  delete from public.change_requests where quote_id = q;
  delete from public.event_refunds where quote_id = q;
  delete from public.inventory_checkouts where quote_id = q;
  delete from public.crew_checkins where quote_id = q;
  delete from public.event_day where quote_id = q;
  delete from public.event_tasks where quote_id = q;
  delete from public.event_resources where quote_id = q;
  delete from public.payment_milestones where quote_id = q;
  delete from public.quote_payments where quote_id = q;
  delete from public.money_settings where org_id = a;
  delete from public.app_config where org_id = a and key = 'insights';
  update public.quotes set status = 'confirmed', lifecycle_stage = 'settlement', event_date = public.studio_today(a) - 3, deleted_at = null, is_demo = false,
         pricing = '{"subtotal":200000,"discount":0,"gstPct":18,"total":236000}'::jsonb where id = q;
  insert into public.vendors(id, name, category, org_id) values (gen_random_uuid(), 'Royal Caterers R198', 'Catering', a) returning id into v1;
  insert into public.event_resources(id, quote_id, vendor_id, kind, label, cost, status, contract, org_id, created_at)
    values (gen_random_uuid(), q, v1, 'catering', 'Royal Caterers R198', 50000, 'confirmed', true, a, now() - interval '20 days') returning id into bk1;
  insert into public.event_resources(id, quote_id, kind, label, cost, status, org_id, created_at)
    values (gen_random_uuid(), q, 'sound', 'Sound & lights', 30000, 'booked', a, now() - interval '20 days') returning id into bk2;
  -- catering bill 70,800 (50,000 planned: 20,800 over = big gap), due tomorrow; sound bill 31,000 due in 10 days
  insert into public.vendor_bills(quote_id, booking_id, vendor_id, amount, gst_amount, due_date, org_id) values (q, bk1, v1, 70800, 10800, public.studio_today(a) + 1, a);
  insert into public.vendor_bills(quote_id, booking_id, amount, due_date, org_id) values (q, bk2, 31000, public.studio_today(a) + 10, a);
  insert into public.crew_members(id, name, phone, day_rate, org_id) values (gen_random_uuid(), 'Ravi R198', '+919811100081', 1200, a) returning id into c1;
  insert into public.crew_members(id, name, phone, day_rate, org_id) values (gen_random_uuid(), 'Meena R198', '+919811100082', 1000, a) returning id into c2;
  perform pg_temp.put('ravi', c1::text);
  insert into public.event_tasks(quote_id, category, title, crew_id, status, org_id) values
    (q, 'setup', 'Load in', c1, 'accepted', a), (q, 'setup', 'Welcome desk', c2, 'accepted', a);
  insert into public.event_day(quote_id, kind, who, ref_id, status, org_id) values (q, 'arrival', 'Ravi R198', c1, 'arrived', a), (q, 'arrival', 'Meena R198', c2, 'arrived', a);
  insert into public.quote_payments(quote_id, amount, status, paid_at, org_id, provider, simulated) values (q, 118000, 'paid', now(), a, 'manual', false);
  insert into public.payment_milestones(quote_id, label, amount, status, seq, due_date, org_id) values
    (q, 'Advance', 118000, 'paid', 1, public.studio_today(a) - 30, a), (q, 'Balance', 118000, 'due', 2, public.studio_today(a) - 1, a);

  -- R198 extra: a payout on the catering bill 2 days ago (part paid), a TDS payout on the sound bill (not cash), staff claims
  insert into public.vendor_payouts(bill_id, org_id, amount, paid_on, method)
    select b.id, a, 20000, public.studio_today(a) - 2, 'upi' from public.vendor_bills b where b.quote_id = q and b.amount = 70800;
  insert into public.vendor_payouts(bill_id, org_id, amount, paid_on, method, source, tds_section)
    select b.id, a, 600, public.studio_today(a) - 2, 'tds', 'tds', '194C' from public.vendor_bills b where b.quote_id = q and b.amount = 31000;
  insert into public.expense_claims(quote_id, who, description, amount, status, org_id) values
    (q, 'Salma R198', 'Gaffer tape', 4200, 'approved', a), (q, 'Ravi R198', 'Tea', 1600, 'paid', a), (q, 'Ravi R198', 'Ice', 900, 'pending', a),
    (q, 'Ravi R198', 'Refused', 700, 'rejected', a);
  perform pg_temp.put('h0', pg_temp.rows_hash());
  perform pg_temp.put('nt', (select count(*) from information_schema.tables where table_schema = 'public')::text);
end $$;

-- ---- the migration, twice ------------------------------------------------------------------------------------------------------
set client_min_messages = error;
\ir ../../supabase/migrations/0377_r198_event_money_cash.sql
\ir ../../supabase/migrations/0377_r198_event_money_cash.sql
set client_min_messages = warning;

do $$ begin
  perform pg_temp.su();
  perform pg_temp.res('01 applied twice: no money row rewritten, no table added, the 0376 header untouched',
    pg_temp.rows_hash() = pg_temp.get('h0')
    and (select count(*) from information_schema.tables where table_schema = 'public')::text = pg_temp.get('nt')
    and to_regprocedure('public.event_money_cash(uuid)') is not null
    and position('r197-0376' in pg_get_functiondef('public.event_money_header(uuid)'::regprocedure)) > 0
    and position('r198-0377' in pg_get_functiondef('public.event_money_cash(uuid)'::regprocedure)) > 0);
end $$;

-- ---- who may call it ------------------------------------------------------------------------------------------------------------
select pg_temp.anon();
do $$ begin
  perform pg_temp.res('02 anon refused (no execute)',
    pg_temp.try('select public.event_money_cash(''a0000000-0000-4000-8000-00000000da01'')') like '42501%');
end $$;
select pg_temp.login('r198_coord@a.test');
do $$ begin
  perform pg_temp.res('03 a role without Finance view is refused (42501), nothing in the error',
    pg_temp.try('select public.event_money_cash(''a0000000-0000-4000-8000-00000000da01'')') like '42501%not authorized%');
end $$;
select pg_temp.login('b_admin@b.test');
do $$ declare v jsonb; begin
  v := pg_temp.j('select public.event_money_cash(''a0000000-0000-4000-8000-00000000da01'')');
  perform pg_temp.res('04 another studio (even its admin): null, nothing about the event', v is null, coalesce(v::text, ''));
end $$;
select pg_temp.login('a_admin@a.test');
do $$ declare v jsonb; begin
  v := pg_temp.j('select public.event_money_cash(''00000000-0000-4000-8000-000000000bad'')');
  perform pg_temp.res('05 an unknown event: null (no error)', v is null, coalesce(v::text, ''));
end $$;

-- ---- the numbers --------------------------------------------------------------------------------------------------------------
do $$ declare q uuid := 'a0000000-0000-4000-8000-00000000da01'; a uuid := 'a0000000-0000-4000-8000-000000000001';
  v jsonb; h jsonb; h1 text; h2 text; n_audit bigint; n2 bigint; td date;
begin
  perform pg_temp.su(); h1 := pg_temp.rows_hash(); n_audit := (select count(*) from public.audit_log); td := public.studio_today(a);
  perform pg_temp.login('a_admin@a.test');
  v := pg_temp.j(format('select public.event_money_cash(%L)', q));
  h := pg_temp.j(format('select public.event_money_header(%L)', q));
  perform pg_temp.su(); h2 := pg_temp.rows_hash(); n2 := (select count(*) from public.audit_log); perform pg_temp.login('a_admin@a.test');
  perform pg_temp.put('v_admin', v::text);
  perform pg_temp.res('06 reading writes nothing (no money row, no audit row)', h1 = h2 and n2 = n_audit and v ? 'totals', left(coalesce(v::text, 'null'), 300));
  perform pg_temp.res('07 money in: came in 1,18,000 = the header''s Received; still to come = the balance 1,18,000 (the plan''s Balance, capped)',
    (v -> 'totals' ->> 'came_in')::numeric = 118000 and (v -> 'totals' ->> 'came_in')::numeric = (h ->> 'received')::numeric
    and (v -> 'totals' ->> 'to_come')::numeric = (h ->> 'balance')::numeric and (v #>> '{owes,client,balance}')::numeric = 118000
    and (select count(*) from jsonb_array_elements(v -> 'entries') e where e ->> 'kind' = 'instalment') = 1
    and (select (e ->> 'amount')::numeric from jsonb_array_elements(v -> 'entries') e where e ->> 'kind' = 'instalment') = 118000,
    v ->> 'totals');
  perform pg_temp.res('08 the client: next instalment = Balance (due yesterday), overdue, studio + event for the reminder text',
    v #>> '{owes,client,next,label}' = 'Balance' and (v #>> '{owes,client,next,date}')::date = td - 1 and (v #>> '{owes,client,next,days}')::int = -1
    and (v #>> '{owes,client,overdue}')::boolean and (v #>> '{owes,client,overdue_amount}')::numeric = 118000
    and v #>> '{owes,client,event_title}' is not null and v #>> '{owes,client,studio}' is not null, v #>> '{owes,client}');
  perform pg_temp.res('09 vendors: open bills due date first, part paid after the payout, the TDS payout settles 600 but is not cash',
    jsonb_array_length(v #> '{owes,vendors,bills}') = 2
    and v #>> '{owes,vendors,bills,0,who}' = 'Royal Caterers R198' and (v #>> '{owes,vendors,bills,0,open}')::numeric = 50800
    and (v #>> '{owes,vendors,bills,0,part}')::boolean and (v #>> '{owes,vendors,bills,0,days}')::int = 1
    and (v #>> '{owes,vendors,bills,1,open}')::numeric = 30400 and (v #>> '{owes,vendors,bills,1,days}')::int = 10
    and (v #>> '{owes,vendors,total}')::numeric = 81200 and (v #>> '{owes,gst,vendor_tds}')::numeric = 600
    and (select count(*) from jsonb_array_elements(v -> 'entries') e where e ->> 'kind' = 'payout') = 1
    and (select (e ->> 'date')::date from jsonb_array_elements(v -> 'entries') e where e ->> 'kind' = 'payout') = td - 2,
    v #>> '{owes,vendors}');
  perform pg_temp.res('10 staff pay-backs: approved 4,200 + waiting 900 to pay, the paid 1,600 went out, a rejected claim is left out',
    (v #>> '{owes,claims,approved}')::numeric = 4200 and (v #>> '{owes,claims,waiting}')::numeric = 900
    and jsonb_array_length(v #> '{owes,claims,items}') = 2
    and (select count(*) from jsonb_array_elements(v -> 'entries') e where e ->> 'kind' = 'claim') = 3
    and (v -> 'totals' ->> 'went_out')::numeric = 20000 + 1600, v #>> '{owes,claims}');
  perform pg_temp.res('11 crew wages = the ledger''s crew lines (2,200, 2 people) on the event day; the admin sees each person',
    (v #>> '{owes,crew,total}')::numeric = 2200 and (v #>> '{owes,crew,people}')::int = 2 and not (v #>> '{owes,crew,private}')::boolean
    and jsonb_array_length(v #> '{owes,crew,per_person}') = 2 and position('Ravi R198' in (v #> '{owes,crew,per_person}')::text) > 0
    and (select (e ->> 'date')::date from jsonb_array_elements(v -> 'entries') e where e ->> 'kind' = 'wages') = td - 3,
    v #>> '{owes,crew}');
  perform pg_temp.res('12 the four totals are the entries'' own sums; still to pay = bills + wages + pay-backs',
    (v -> 'totals' ->> 'came_in')::numeric = (select sum((e ->> 'amount')::numeric) from jsonb_array_elements(v -> 'entries') e where e ->> 'dir' = 'in' and (e ->> 'cash')::boolean and (e ->> 'done')::boolean)
    and (v -> 'totals' ->> 'to_come')::numeric = (select sum((e ->> 'amount')::numeric) from jsonb_array_elements(v -> 'entries') e where e ->> 'dir' = 'in' and (e ->> 'cash')::boolean and not (e ->> 'done')::boolean)
    and (v -> 'totals' ->> 'went_out')::numeric = (select sum((e ->> 'amount')::numeric) from jsonb_array_elements(v -> 'entries') e where e ->> 'dir' = 'out' and (e ->> 'done')::boolean)
    and (v -> 'totals' ->> 'to_pay')::numeric = (select sum((e ->> 'amount')::numeric) from jsonb_array_elements(v -> 'entries') e where e ->> 'dir' = 'out' and not (e ->> 'done')::boolean)
    and (v -> 'totals' ->> 'to_pay')::numeric = 81200 + 2200 + 4200 + 900
    and (v -> 'totals' ->> 'cash_left')::numeric = (v -> 'totals' ->> 'came_in')::numeric + (v -> 'totals' ->> 'to_come')::numeric
          - (v -> 'totals' ->> 'went_out')::numeric - (v -> 'totals' ->> 'to_pay')::numeric, v ->> 'totals');
  perform pg_temp.res('13 the running line: one point per date, in date order, the last one ends at the cash left',
    jsonb_array_length(v -> 'points') >= 3
    and (v -> 'points' -> (jsonb_array_length(v -> 'points') - 1) ->> 'run')::numeric = (v -> 'totals' ->> 'cash_left')::numeric
    and (select bool_and(x.d > x.p) from (select (p ->> 'date')::date as d, lag((p ->> 'date')::date) over (order by o) as p
                                             from jsonb_array_elements(v -> 'points') with ordinality y(p, o)) x where x.p is not null),
    v ->> 'points');
  perform pg_temp.res('14 cash left is not profit: profit (= the header''s) + GST to pay + stock lost - client TDS + vendor TDS + the rest = cash left, exactly',
    (v #>> '{explain,profit}')::numeric = (h ->> 'profit')::numeric
    and (v #>> '{explain,gst_collected}')::numeric = 36000 and (v #>> '{explain,gst_to_pay}')::numeric = 36000
    and (v #>> '{explain,gst_blocked}')::numeric = 10800 and (v #>> '{explain,vendor_tds}')::numeric = 600
    and (v #>> '{explain,cash_left}')::numeric = (v #>> '{explain,profit}')::numeric + (v #>> '{explain,gst_to_pay}')::numeric
          + (v #>> '{explain,stock_lost}')::numeric - (v #>> '{explain,client_tds}')::numeric + (v #>> '{explain,vendor_tds}')::numeric
          + (v #>> '{explain,other}')::numeric
    and (v #>> '{explain,cash_left}')::numeric = (v -> 'totals' ->> 'cash_left')::numeric
    and abs((v #>> '{explain,other}')::numeric) < 0.01, v ->> 'explain');
  perform pg_temp.res('15 GST to pay for this event = collected - claimable; the event is past, so no advance note',
    (v #>> '{owes,gst,to_pay}')::numeric = 36000 and (v #>> '{owes,gst,claimable}')::numeric = 0 and (v #>> '{explain,advance}')::numeric = 0
    and (v #>> '{owes,you_owe}')::numeric = 81200 + 2200 + 4200 + 900, v #>> '{owes,gst}');
end $$;

-- a Finance-view role that is not the admin: same totals, crew pay as ONE number, no names
select pg_temp.login('r198_mgr@a.test');
do $$ declare q uuid := 'a0000000-0000-4000-8000-00000000da01'; v jsonb; adm jsonb := pg_temp.get('v_admin')::jsonb; begin
  v := pg_temp.j(format('select public.event_money_cash(%L)', q));
  perform pg_temp.res('16 manager (Finance view): same totals, crew wages one total, no per-person list, no crew name anywhere',
    public.has_area('finance', 'view') and v -> 'totals' = adm -> 'totals' and (v #>> '{owes,crew,private}')::boolean
    and v #> '{owes,crew,per_person}' = 'null'::jsonb and (v #>> '{owes,crew,total}')::numeric = 2200
    and position('Meena R198' in v::text) = 0 and position('Ravi R198 ' in v::text) = 0
    and (select count(*) from jsonb_array_elements(v -> 'entries') e where e ->> 'kind' = 'wages') = 1, coalesce(left(v::text, 400), 'null'));
end $$;

-- client TDS + a refund + an instalment in the future: TDS is not cash, the plan is capped by the balance
do $$ declare q uuid := 'a0000000-0000-4000-8000-00000000da01'; a uuid := 'a0000000-0000-4000-8000-000000000001'; v jsonb; td date; begin
  perform pg_temp.su(); td := public.studio_today(a);
  insert into public.client_tds(org_id, quote_id, amount, section) values (a, q, 4000, '194C');
  insert into public.event_refunds(quote_id, kind, amount, reason, status, org_id) values (q, 'refund', 3000, 'Fewer chairs', 'pending', a);
  update public.payment_milestones set due_date = td + 5 where quote_id = q and label = 'Balance';
  perform pg_temp.login('a_admin@a.test');
  v := pg_temp.j(format('select public.event_money_cash(%L)', q));
  perform pg_temp.res('17 client TDS 4,000: listed as not cash, balance and still-to-come go down by it, the refund owed is to pay out, the parts still add up',
    (select count(*) from jsonb_array_elements(v -> 'entries') e where e ->> 'kind' = 'client_tds' and not (e ->> 'cash')::boolean) = 1
    and (v -> 'totals' ->> 'to_come')::numeric = 114000 and (v #>> '{owes,client,balance}')::numeric = 114000
    and (v #>> '{owes,client,tds}')::numeric = 4000 and (v #>> '{explain,client_tds}')::numeric = 4000
    and (v #>> '{owes,refunds,total}')::numeric = 3000 and not (v #>> '{owes,client,overdue}')::boolean
    and (v #>> '{owes,client,next,days}')::int >= 0
    and (v #>> '{explain,cash_left}')::numeric = (v #>> '{explain,profit}')::numeric + (v #>> '{explain,gst_to_pay}')::numeric
          + (v #>> '{explain,stock_lost}')::numeric - (v #>> '{explain,client_tds}')::numeric + (v #>> '{explain,vendor_tds}')::numeric
          + (v #>> '{explain,other}')::numeric
    and (v #>> '{explain,other}')::numeric = -3000, (v ->> 'totals') || ' ' || (v #>> '{owes,client}') || ' ' || (v #>> '{owes,refunds}'));
  perform pg_temp.su();
  delete from public.event_refunds where quote_id = q;
  update public.payment_milestones set due_date = td - 1 where quote_id = q and label = 'Balance';
end $$;

-- a closed + frozen event still answers, with the frozen crew lines (a rate changed after closing does not move them)
select pg_temp.login('a_admin@a.test');
do $$ declare q uuid := 'a0000000-0000-4000-8000-00000000da01'; v1 jsonb; v2 jsonb; e text; begin
  perform pg_temp.su();
  insert into public.quote_payments(quote_id, amount, status, paid_at, org_id, provider, simulated)
    values (q, 114000, 'paid', now(), 'a0000000-0000-4000-8000-000000000001', 'manual', false);
  perform pg_temp.login('a_admin@a.test');
  e := pg_temp.try(format('select public.close_event(%L, true)', q));
  v1 := public.event_money_cash(q);
  perform pg_temp.su();
  update public.crew_members set day_rate = 5000 where id = pg_temp.get('ravi')::uuid;
  perform pg_temp.login('a_admin@a.test');
  v2 := public.event_money_cash(q);
  perform pg_temp.res('18 closed + frozen: frozen, client settled (nothing to collect), crew wages stay the frozen 2,200 after a rate change',
    e = '' and (v1 ->> 'closed')::boolean and (v1 ->> 'frozen')::boolean and (v1 #>> '{owes,client,balance}')::numeric = 0
    and (v1 -> 'totals' ->> 'to_come')::numeric = 0 and (v2 #>> '{owes,crew,total}')::numeric = 2200
    and (v2 #>> '{explain,profit}')::numeric = (v1 #>> '{explain,profit}')::numeric, e || ' ' || left(coalesce(v2::text, 'null'), 300));
end $$;

-- ---- grants / definer / search_path ----------------------------------------------------------------------------------------------
select pg_temp.su();
do $$ begin
  perform pg_temp.res('19 grants: the call for signed-in staff only; the helper server only; definer + empty search_path',
    has_function_privilege('authenticated', 'public.event_money_cash(uuid)', 'execute')
    and not has_function_privilege('anon', 'public.event_money_cash(uuid)', 'execute')
    and not has_function_privilege('authenticated', 'public._r377_d(timestamptz,text)', 'execute')
    and not has_function_privilege('anon', 'public._r377_d(timestamptz,text)', 'execute')
    and (select p.prosecdef and coalesce(p.proconfig, '{}') @> array['search_path=""'] from pg_proc p where p.oid = 'public.event_money_cash(uuid)'::regprocedure)
    and (select coalesce(p.proconfig, '{}') @> array['search_path=""'] from pg_proc p where p.oid = 'public._r377_d(timestamptz,text)'::regprocedure)
    and (select p.provolatile = 's' from pg_proc p where p.oid = 'public.event_money_cash(uuid)'::regprocedure));
end $$;

select pg_temp.su();
\ir ../../supabase/migrations/0377_r198_event_money_cash.sql

select name, result from _rm order by name;
select case when count(*) filter (where result <> 'PASS') = 0
            then 'R198-MONEY-CASH-0377: ALL PASS (' || count(*) || '/' || count(*) || ')'
            else 'R198-MONEY-CASH-0377: FAILURES (' || count(*) filter (where result <> 'PASS') || ' of ' || count(*) || ')' end as summary
  from _rm;
rollback;
