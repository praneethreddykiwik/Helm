-- r249-money-once-0431.sql - R249 the event money reads share ONE cost ledger (0431). Proves: (1) applied twice, the heavy ledger
-- body kept once (_r21_event_money__pre0372__pre0431), the same-name wrapper carries the r249-0431 marker, definer + empty
-- search_path, grants (bundle: signed-in only; wrapper + kept body: server only); (2) THE MONEY DOES NOT CHANGE: on the R212
-- seeded studio (40 busy events: bookings, bills, payouts, cost lines, crew, claims, changes, refunds, payments, TDS, corrections,
-- write-offs; 6 closed + frozen, 1 legacy) plus a second studio that does not freeze, every event_money_bundle part (header, cash,
-- breakdown, pnl) is byte-identical to its own call for the admin, a Finance manager, a role without Finance view (the same
-- 42501 as its own call, in errors) and another studio's admin (null); the wrapper outside a bundle = the kept body for every
-- event; (3) ONE ledger per bundle (was one per call: 4 for the four calls); the memory is off again after the bundle, never
-- answers another event, another studio or the other lines flag; (4) anon refused; unknown part names ignored; reading writes
-- nothing. Local disposable PG only. Rolled back.
set client_min_messages = warning;
begin;
create temp table _rm(name text, result text); grant all on _rm to anon, authenticated, service_role;
create temp table _rkv(k text primary key, v text); grant all on _rkv to anon, authenticated, service_role;
create temp table _out(state text, who text, k text, v text, primary key (state, who, k)); grant all on _out to anon, authenticated, service_role;

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
          || coalesce((select string_agg(to_jsonb(p)::text, ',' order by p.id) from public.vendor_payouts p), '')
          || coalesce((select string_agg(to_jsonb(p)::text, ',' order by p.id) from public.quote_payments p), '')
          || coalesce((select string_agg(to_jsonb(s)::text, ',' order by s.id) from public.event_pnl_snapshots s), '')
          || coalesce((select count(*)::text from public.audit_log), '')) $$;
-- calls of a function in THIS transaction so far (track_functions = all)
create or replace function pg_temp.calls(p_fn text) returns bigint language sql as $$
  select coalesce(pg_stat_get_xact_function_calls(to_regprocedure(p_fn)), 0) $$;
grant execute on function pg_temp.calls(text) to anon, authenticated, service_role;

-- ---- setup (the R212 seed, unchanged): 40 busy events in studio A (6 closed + frozen, 1 closed under the legacy rules), 8 in studio B (closed events not frozen) --------
do $$
declare a uuid := 'a0000000-0000-4000-8000-000000000001'; bo uuid := 'b0000000-0000-4000-8000-000000000001';
  o uuid; q uuid; i int; j int; n int; v_ven uuid[]; v_crew uuid[]; v_item uuid[]; bk uuid; b uuid; ch uuid; sh uuid; d date; c uuid;
  rf uuid; v_cut timestamptz;
begin
  perform pg_temp.member('r212_mgr@a.test', 'manager', a);
  perform pg_temp.member('r212_coord@a.test', 'coordinator', a);
  perform pg_temp.su();
  update public.organizations set timezone = 'Asia/Kolkata' where id in (a, bo);
  insert into public.money_settings(org_id, freeze_closed) values (bo, false) on conflict (org_id) do update set freeze_closed = false;
  insert into public.app_config(org_id, key, value) values (a, 'crew', '{"payBasis":"day","dayHours":8}'::jsonb) on conflict do nothing;
  foreach o in array array[a, bo] loop
    v_ven := '{}'; v_crew := '{}'; v_item := '{}';
    for i in 1..12 loop
      insert into public.vendors(name, category, org_id) values ('R212 vendor ' || i,
        (array['Catering','Decor','Sound','Venue','Transport','Furniture','Florist','Lights'])[1 + i % 8], o) returning id into c;
      v_ven := v_ven || c;
    end loop;
    for i in 1..30 loop
      insert into public.crew_members(name, phone, day_rate, org_id) values ('R212 crew ' || i, '+9197' || lpad((i + case when o = a then 0 else 100 end)::text, 8, '0'),
        case when i % 13 = 0 then null else 800 + (i % 7) * 100 end, o) returning id into c;
      v_crew := v_crew || c;
    end loop;
    for i in 1..20 loop
      insert into public.inventory_items(name, category, total_qty, unit_cost, org_id)
        values ('R212 item ' || i, (array['Chairs','Lights','Linen','Glassware','Decor'])[1 + i % 5], 500, case when i % 11 = 0 then 0 else 50 + i end, o) returning id into c;
      v_item := v_item || c;
    end loop;
    n := case when o = a then 40 else 8 end;
    for i in 1..n loop
      d := current_date - 60 + i * 3;
      insert into public.quotes(code, title, status, lifecycle_stage, client, pricing, current_version, approval_status, org_id, event_date, created_at, updated_at)
        values ('R212-' || case when o = a then 'A' else 'B' end || lpad(i::text, 3, '0'), 'R212 event ' || i, 'confirmed', 'settlement',
                jsonb_build_object('name', 'Client ' || i),
                jsonb_build_object('subtotal', 400000 + i * 1000, 'discount', 0, 'gstPct', 18, 'total', round((400000 + i * 1000) * 1.18)), 1, 'approved', o, d,
                now() - interval '300 days', now())
        returning id into q;
      for j in 1..8 loop
        insert into public.event_resources(quote_id, vendor_id, kind, label, cost, advance, status, contract, org_id, created_at)
          values (q, v_ven[1 + (i + j) % 12], (array['catering','decor','sound','venue','transport','furniture','flowers','lights'])[j], 'Booking ' || j,
                  10000 + j * 2500, case when j % 3 = 0 then 2000 end,
                  (array['booked','confirmed','enquiry','delivered','cancelled','confirmed','booked','confirmed'])[j], j % 2 = 0, o, d - 40 + j) returning id into bk;
        insert into public.event_costs(quote_id, category, description, kind, estimated, actual, booking_id, org_id, requirement_key, created_at)
          values (q, (array['Catering','Decor','Sound','Venue','Transport','Furniture','Florist','Lights'])[j], 'Line for booking ' || j, 'vendor',
                  9000 + j * 2500, case when j % 4 = 0 then 11000 + j * 2500 end, bk, o, case when j = 1 then 'std:catering' end, d - 45 + j);
        if j % 4 <> 3 then
          insert into public.vendor_bills(quote_id, booking_id, vendor_id, bill_no, bill_date, amount, gst_amount, gst_claimable, due_date, status, void_reason, org_id, created_at)
            values (q, bk, v_ven[1 + (i + j) % 12], 'B' || i || '-' || j, d - 5, 11800 + j * 2950, case when j % 3 <> 0 then 1800 + j * 450 end,
                    case when j = 5 then false end, d + 10, case when j = 7 then 'void' else 'open' end, case when j = 7 then 'wrong bill' end, o,
                    (d - 5)::timestamptz + interval '10 hours') returning id into b;
          insert into public.vendor_payouts(bill_id, org_id, amount, paid_on, method, source) values (b, o, 4000, d - 3, 'upi', case when j % 3 = 0 then 'advance' end);
          if j % 2 = 0 then
            insert into public.vendor_payouts(bill_id, org_id, amount, paid_on, method, source, tds_section) values (b, o, 300, d, 'tds', 'tds', '194C');
          end if;
        end if;
      end loop;
      for j in 1..3 loop
        insert into public.vendor_bills(quote_id, vendor_id, bill_no, bill_date, description, amount, gst_amount, due_date, status, org_id, created_at)
          values (q, v_ven[1 + (i * 3 + j) % 12], 'L' || i || '-' || j, d, 'Loose bill ' || j || ' generator', 5000 + j * 1000 + (i % 4) * 4000,
                  case when j = 2 then 900 end, d + 5, 'open', o, d::timestamptz + interval '12 hours');
      end loop;
      for j in 1..12 loop
        insert into public.event_costs(quote_id, category, description, kind, estimated, actual, org_id, requirement_key, crew_covered, created_at)
          values (q, (array['Logistics','Staff','Misc','Decor','Transport','Contingency'])[1 + j % 6], 'Budget line ' || j,
                  case when j % 4 = 0 then 'vendor' else 'other' end, case when j = 9 then 0 else 1000 * j end, case when j % 3 = 0 then 1100 * j end, o,
                  case when j = 6 then 'std:contingency' when j = 2 then 'std:staff' end, j = 2,
                  case when j > 10 then d::timestamptz + interval '13 hours' else d - 30 end);
      end loop;
      for j in 1..10 loop
        c := v_crew[1 + (i * 10 + j) % 30];
        insert into public.event_tasks(quote_id, category, title, crew_id, status, org_id, responded_at)
          values (q, 'setup', 'Task ' || j, c, (array['accepted','assigned','in_progress','completed','rejected'])[1 + j % 5], o, case when j % 2 = 0 then now() end);
        insert into public.event_tasks(quote_id, category, title, status, org_id) values (q, 'prep', 'Unassigned task ' || j, 'unassigned', o);
        insert into public.event_day(quote_id, kind, who, ref_id, status, org_id)
          values (q, 'arrival', 'Crew', c, (array['arrived','left','no_show','expected'])[1 + j % 4], o);
        if j % 3 = 0 then
          insert into public.crew_checkins(org_id, quote_id, crew_id, work_day, check_in_at, check_out_at)
            values (o, q, c, d, d::timestamptz + interval '8 hours', case when j % 2 = 0 then d::timestamptz + interval '17 hours' end);
        end if;
        if j % 4 = 0 then
          insert into public.crew_wage_confirmations(org_id, quote_id, crew_id, days, hours, ot_hours, allowance) values (o, q, c, 1, 9, 1, 200);
        end if;
      end loop;
      insert into public.open_shifts(org_id, quote_id, title, shift_date, start_time, end_time, wage, wage_basis, status)
        values (o, q, 'Extra hands', d, '09:00', '18:00', 150, case when i % 2 = 0 then 'hour' else 'day' end, 'closed') returning id into sh;
      insert into public.open_shift_claims(org_id, shift_id, quote_id, crew_id, status, decided_at) values (o, sh, q, v_crew[1 + (i * 10 + 1) % 30], 'approved', now());
      for j in 1..4 loop
        insert into public.expense_claims(quote_id, who, description, amount, status, org_id, created_at)
          values (q, 'Staff ' || j, 'Petty ' || j, 500 * j, (array['pending','approved','paid','rejected'])[j], o, d::timestamptz + interval '15 hours');
      end loop;
      insert into public.change_requests(quote_id, title, price_delta, cost_delta, status, org_id)
        values (q, 'Extra lights', 11800, 6000, 'approved', o), (q, 'More chairs', 2000, 900, 'requested', o);
      insert into public.event_refunds(quote_id, kind, amount, reason, status, org_id)
        values (q, 'refund', 3000, 'Short delivery', case when i % 2 = 0 then 'processed' else 'pending' end, o);
      for j in 1..3 loop
        insert into public.quote_payments(quote_id, amount, status, paid_at, org_id, provider, method, simulated, receipt_no)
          values (q, 100000 + (i % 3) * 20000, 'paid', d::timestamptz - (j * interval '20 days'), o, 'manual', 'bank', false, 'R212-' || i || '-' || j);
        insert into public.payment_milestones(quote_id, label, amount, status, seq, due_date, org_id)
          values (q, 'Part ' || j, round((400000 + i * 1000) * 1.18 / 3), case when j = 1 then 'paid' else 'due' end, j, d - 30 + j * 15, o);
      end loop;
      if i % 5 = 0 then insert into public.client_tds(org_id, quote_id, amount, section, rate) values (o, q, 8000, '194C', 2); end if;
      if i % 7 = 0 then insert into public.money_corrections(org_id, quote_id, category, amount, reason) values (o, q, 'food', 1500, 'Extra plates'); end if;
      for j in 1..6 loop
        insert into public.inventory_reservations(item_id, quote_id, qty, status, org_id) values (v_item[1 + (i * 6 + j) % 20], q, 10 + j, 'reserved', o);
      end loop;
      for j in 1..5 loop
        insert into public.inventory_checkouts(item_id, quote_id, qty_out, issued_to, qty_in, status, org_id, written_off, qty_used)
          values (v_item[1 + (i * 5 + j) % 20], q, 20, 'Crew', 17, 'returned', o, case when j % 2 = 0 then 3 else 0 end, case when j = 4 then 1 else 0 end)
          returning id into ch;
        if j = 2 then
          insert into public.inventory_stock_events(org_id, checkout_id, item_id, quote_id, kind, qty, amount)
            values (o, ch, v_item[1 + (i * 5 + j) % 20], q, 'repaired', 1, 250);
          insert into public.inventory_stock_events(org_id, checkout_id, item_id, quote_id, kind, qty)
            values (o, ch, v_item[1 + (i * 5 + j) % 20], q, 'found', 1);
        end if;
        if j = 4 and i % 3 = 0 then
          insert into public.event_refunds(quote_id, kind, amount, reason, status, org_id) values (q, 'recovery', 400, 'Broken glasses', 'processed', o) returning id into rf;
          insert into public.inventory_stock_events(org_id, checkout_id, item_id, quote_id, kind, qty, amount, refund_id)
            values (o, ch, v_item[1 + (i * 5 + j) % 20], q, 'charge_client', 1, 400, rf);
        end if;
      end loop;
    end loop;
  end loop;
  -- closed events: the close trigger freezes the P&L (studio B does not freeze); one studio A event closed before the r21 rules
  select r.effective_at into v_cut from public.helm_money_rules r where r.rule = 'r21-ledger';
  for q in select x.id from public.quotes x where x.org_id = a and x.code like 'R212-A%' order by x.code limit 7 loop
    insert into public.event_closure(quote_id, closed_at, org_id) values (q, now(), a);
  end loop;
  update public.event_closure c set closed_at = coalesce(v_cut, now()) - interval '1 day'
   where c.quote_id = (select x.id from public.quotes x where x.code = 'R212-A001' and x.org_id = a);
  for q in select x.id from public.quotes x where x.org_id = bo and x.code like 'R212-B%' order by x.code limit 2 loop
    insert into public.event_closure(quote_id, closed_at, org_id) values (q, now(), bo);
  end loop;
  -- a later rate change on a frozen event: the live figure moves, the frozen one does not
  update public.crew_members set day_rate = coalesce(day_rate, 0) + 700
   where org_id = a and id in (select t.crew_id from public.event_tasks t join public.quotes x on x.id = t.quote_id where x.code = 'R212-A003' and t.crew_id is not null);
  perform pg_temp.put('h0', pg_temp.rows_hash());
end $$;

-- ---- the migration, twice ------------------------------------------------------------------------------------------------------
set client_min_messages = error;
\ir ../../supabase/migrations/0431_r249_money_once.sql
\ir ../../supabase/migrations/0431_r249_money_once.sql
set client_min_messages = warning;

-- every part of the bundle vs its own call, for one signed-in person (also: the bundle with all four parts at once)
create or replace function pg_temp.cmp(p_email text, p_org uuid) returns text language plpgsql as $$
declare q uuid; b jsonb; s jsonb; p text; n int := 0; bad text := ''; one jsonb; v_ids uuid[];
begin
  perform pg_temp.su();
  select array_agg(x.id order by x.id) into v_ids from public.quotes x where x.org_id = p_org;
  perform pg_temp.login(p_email);
  foreach q in array v_ids loop
    b := pg_temp.j(format('select public.event_money_bundle(%L, array[''pnl'',''breakdown'',''cash'',''header'',''nope''])', q));
    foreach p in array array['header', 'cash', 'breakdown', 'pnl'] loop
      s := pg_temp.j(format('select public.%s(%L)', case p when 'header' then 'event_money_header' when 'cash' then 'event_money_cash'
                                                       when 'breakdown' then 'event_cost_breakdown' else 'event_pnl' end, q));
      -- its own call failed: the bundle reports the same code + message in errors.<part>, and no answer for it
      if s ? 'err' then
        if not (b -> 'errors' ? p) or (b ? p) or (b #>> array['errors', p, 'code']) || ' ' || (b #>> array['errors', p, 'message']) <> s ->> 'err' then
          bad := bad || p || ':' || q || ' '; end if;
      elsif not (b ? p) or (b -> p) is distinct from coalesce(s, 'null'::jsonb) or (b -> 'errors' ? p) then
        bad := bad || p || ':' || q || ' ';
      end if;
      n := n + 1;
    end loop;
    -- one part on its own (the page asks only what it shows) = the same answer
    one := pg_temp.j(format('select public.event_money_bundle(%L, array[''cash''])', q));
    if (one ? 'header') or (one ? 'pnl') or (one -> 'cash') is distinct from (b -> 'cash') then bad := bad || 'one:' || q || ' '; end if;
    if b ? 'nope' then bad := bad || 'nope '; end if;
  end loop;
  perform pg_temp.su();
  return case when n = 4 * cardinality(v_ids) and n >= 32 then 'n' else n::text end || '|' || bad;
end $$;

do $$ begin
  perform pg_temp.su();
  perform pg_temp.res('01 applied twice: the ledger body kept once (__pre0431), the wrapper carries the marker, nothing written',
    (select count(*) from pg_proc p join pg_namespace s on s.oid = p.pronamespace where s.nspname = 'public' and p.proname like '%\_\_pre0431') = 1
    and to_regprocedure('public._r21_event_money__pre0372__pre0431(uuid,uuid,boolean)') is not null
    and position('r249-0431' in pg_get_functiondef('public._r21_event_money__pre0372(uuid,uuid,boolean)'::regprocedure)) > 0
    and position('r249-0431' in pg_get_functiondef('public._r21_event_money__pre0372__pre0431(uuid,uuid,boolean)'::regprocedure)) = 0
    and position('public._r21_event_money__pre0372(' in pg_get_functiondef('public._r21_event_money(uuid,uuid,boolean)'::regprocedure)) > 0
    and pg_temp.rows_hash() = pg_temp.get('h0'));
  perform pg_temp.res('02 definer + empty search_path + stable; bundle for signed-in only; the wrapper and the kept body server only',
    (select bool_and(p.prosecdef and coalesce(p.proconfig, '{}') @> array['search_path=""'] and p.provolatile = 's') from pg_proc p
      where p.oid in ('public.event_money_bundle(uuid,text[])'::regprocedure, 'public._r21_event_money__pre0372(uuid,uuid,boolean)'::regprocedure,
                      'public._r21_event_money__pre0372__pre0431(uuid,uuid,boolean)'::regprocedure))
    and has_function_privilege('authenticated', 'public.event_money_bundle(uuid,text[])', 'execute')
    and not has_function_privilege('anon', 'public.event_money_bundle(uuid,text[])', 'execute')
    and not has_function_privilege('authenticated', 'public._r21_event_money__pre0372(uuid,uuid,boolean)', 'execute')
    and not has_function_privilege('anon', 'public._r21_event_money__pre0372(uuid,uuid,boolean)', 'execute')
    and not has_function_privilege('authenticated', 'public._r21_event_money__pre0372__pre0431(uuid,uuid,boolean)', 'execute')
    and has_function_privilege('service_role', 'public._r21_event_money__pre0372(uuid,uuid,boolean)', 'execute'));
end $$;

-- ---- the money: every bundle part = its own call ------------------------------------------------------------------------------
do $$ declare r text; m text; c text; b text; begin
  r := pg_temp.cmp('a_admin@a.test', 'a0000000-0000-4000-8000-000000000001');
  m := pg_temp.cmp('r212_mgr@a.test', 'a0000000-0000-4000-8000-000000000001');
  c := pg_temp.cmp('r212_coord@a.test', 'a0000000-0000-4000-8000-000000000001');
  b := pg_temp.cmp('b_admin@b.test', 'b0000000-0000-4000-8000-000000000001');
  perform pg_temp.res('03 every part (header / cash / breakdown / pnl) byte-identical to its own call: admin, Finance manager (pay private)',
    r = 'n|' and m = 'n|', 'admin ' || r || ' mgr ' || left(m, 200));
  perform pg_temp.res('04 a role without Finance view: each part answers the same 42501 as its own call (in errors), nothing else',
    c = 'n|', left(c, 200));
  perform pg_temp.res('05 the other studio (closed events not frozen): identical; asking ONE part answers only that part', b = 'n|', left(b, 200));
end $$;
do $$ declare q text := (select id::text from public.quotes where code = 'R212-A010'); v jsonb; begin
  perform pg_temp.login('b_admin@b.test');
  v := pg_temp.j(format('select public.event_money_bundle(%L, array[''header'',''cash'',''breakdown'',''pnl''])', q));
  perform pg_temp.su();
  perform pg_temp.res('06 another studio''s event: header / cash null, breakdown / pnl = their own calls (no figures of studio A)',
    v -> 'header' = 'null'::jsonb and v -> 'cash' = 'null'::jsonb and not (v ? 'v' and v -> 'errors' ? 'header')
    and position('R212 event 10' in v::text) = 0, left(v::text, 200));
end $$;
select pg_temp.anon();
do $$ begin
  perform pg_temp.res('07 anon refused (42501); no part names = only the version + empty errors',
    pg_temp.try('select public.event_money_bundle(''a0000000-0000-4000-8000-00000000da01'', array[''header''])') like '42501%');
end $$;
select pg_temp.login('a_admin@a.test');
do $$ declare q uuid := (select id from public.quotes where code = 'R212-A030'); v jsonb; begin
  v := public.event_money_bundle(q, array['x', 'y']); perform pg_temp.su();
  perform pg_temp.res('08 unknown part names are ignored', v = '{"v": 1, "errors": {}}'::jsonb, v::text);
end $$;

-- ---- ONE ledger per bundle; the memory is off afterwards and never answers another event / studio / flag ----------------------
set track_functions = 'all';
do $$ declare qo uuid := (select id from public.quotes where code = 'R212-A030'); qf uuid := (select id from public.quotes where code = 'R212-A003');
  qb uuid := (select id from public.quotes where code = 'R212-B004'); a uuid := 'a0000000-0000-4000-8000-000000000001';
  k text := 'public._r21_event_money__pre0372__pre0431(uuid,uuid,boolean)'; c0 bigint; c1 bigint; c2 bigint; c3 bigint; c4 bigint; c5 bigint;
  v jsonb; w jsonb; t0 timestamptz; d_sep interval; d_bun interval; on_after text; s1 jsonb; s2 jsonb; s3 jsonb; s4 jsonb;
begin
  perform pg_temp.login('a_admin@a.test');
  c0 := pg_temp.calls(k);
  t0 := clock_timestamp();
  s1 := public.event_money_header(qo); s2 := public.event_money_cash(qo); s3 := public.event_cost_breakdown(qo); s4 := public.event_pnl(qo);
  d_sep := clock_timestamp() - t0; c1 := pg_temp.calls(k);
  t0 := clock_timestamp();
  v := public.event_money_bundle(qo, array['header', 'cash', 'breakdown', 'pnl']);
  d_bun := clock_timestamp() - t0; c2 := pg_temp.calls(k);
  on_after := coalesce(current_setting('helm.r431_money_on', true), '') || '/' || coalesce(current_setting('helm.r431_money_val', true), '');
  -- after the bundle: a separate call builds the ledger again (the memory is off)
  s1 := public.event_money_header(qo); c3 := pg_temp.calls(k);
  -- two events in one transaction: the second bundle never answers the first event's ledger
  w := public.event_money_bundle(qf, array['header', 'breakdown']); c4 := pg_temp.calls(k);
  s1 := public.event_money_header(qf); s3 := public.event_cost_breakdown(qf);
  perform pg_temp.su();
  perform pg_temp.put('calls', (c1 - c0) || '/' || (c2 - c1) || '/' || (c3 - c2) || '/' || (c4 - c3));
  perform pg_temp.put('ms', round(extract(epoch from d_sep) * 1000) || '/' || round(extract(epoch from d_bun) * 1000));
  perform pg_temp.put('on_after', on_after);
  perform pg_temp.put('w_ok', ((w -> 'header') = s1 and (w -> 'breakdown') = s3)::text);
  -- the wrapper outside a bundle = the kept body (every event, both studios, both flags); inside a bundle a different studio /
  -- flag is never answered from the memory
  perform pg_temp.put('wrap_ok', (not exists (select 1 from public.quotes x
     where public._r21_event_money__pre0372(x.id, x.org_id, true) is distinct from public._r21_event_money__pre0372__pre0431(x.id, x.org_id, true)
        or public._r21_event_money__pre0372(x.id, x.org_id, false) is distinct from public._r21_event_money__pre0372__pre0431(x.id, x.org_id, false)))::text);
  perform set_config('helm.r431_money_on', 'on', true);
  c5 := pg_temp.calls(k);
  perform pg_temp.put('mem_ok', (
        public._r21_event_money__pre0372(qo, a, true) = public._r21_event_money__pre0372__pre0431(qo, a, true)
    and public._r21_event_money__pre0372(qo, a, false) is not distinct from public._r21_event_money__pre0372__pre0431(qo, a, false)
    and public._r21_event_money__pre0372(qo, 'b0000000-0000-4000-8000-000000000001', true) is not distinct from public._r21_event_money__pre0372__pre0431(qo, 'b0000000-0000-4000-8000-000000000001', true)
    and public._r21_event_money__pre0372(qb, 'b0000000-0000-4000-8000-000000000001', true) = public._r21_event_money__pre0372__pre0431(qb, 'b0000000-0000-4000-8000-000000000001', true)
    and public._r21_event_money__pre0372(qo, a, true) = public._r21_event_money__pre0372__pre0431(qo, a, true))::text);
  perform set_config('helm.r431_money_on', '', true);
  perform set_config('helm.r431_money_key', '', true); perform set_config('helm.r431_money_val', '', true);
end $$;
reset track_functions;
do $$ begin
  perform pg_temp.res('09 ONE ledger per bundle (4 separate calls built it 4 times); after the bundle a separate call builds it again; a 2nd event = its own ledger',
    pg_temp.get('calls') = '4/1/1/1', pg_temp.get('calls') || ' (ms separate/bundle ' || pg_temp.get('ms') || ')');
  perform pg_temp.res('10 the memory is switched off and emptied at the end of the bundle', pg_temp.get('on_after') = '/', pg_temp.get('on_after'));
  perform pg_temp.res('11 the wrapper outside a bundle = the kept body for every event, both studios, both flags', pg_temp.get('wrap_ok') = 'true');
  perform pg_temp.res('12 with the memory on, another studio / event / flag is never answered from it', pg_temp.get('mem_ok') = 'true' and pg_temp.get('w_ok') = 'true',
    pg_temp.get('mem_ok') || ' ' || pg_temp.get('w_ok'));
  perform pg_temp.res('13 reading every answer wrote nothing', pg_temp.rows_hash() = pg_temp.get('h0'));
end $$;
do $$ begin raise warning 'r249-0431 timing on the R212 seed (4 calls separately / one bundle, ms): %', pg_temp.get('ms'); end $$;

select name, result from _rm order by name;
select case when count(*) filter (where result <> 'PASS') = 0
            then 'R249-MONEY-ONCE-0431: ALL PASS (' || count(*) || '/' || count(*) || ')'
            else 'R249-MONEY-ONCE-0431: FAILURES (' || count(*) filter (where result <> 'PASS') || ' of ' || count(*) || ')' end as summary
  from _rm;
rollback;
