-- r212-money-speed-0387.sql - R212 event money reads fast (0387). Proves: (1) applied twice, the three old bodies kept once
-- (__pre0387), the new bodies carry the r212-0387 marker and the old r197-0376 / r198-0377 / r21-money-0246 markers;
-- (2) THE MONEY DOES NOT CHANGE: on a seeded studio (40 events, each with bookings, bills, payouts, cost lines, crew tasks,
-- arrivals, check-ins, wage confirmations, an open shift, claims, change orders, refunds, payments, a payment plan,
-- client TDS, corrections, stock reservations, write-offs, found / repaired / charged-back items; 6 closed + frozen, one more
-- closed under the legacy rules) plus a second studio that does not freeze closed events, every event_money_header and
-- event_money_cash answer (admin + a Finance manager + the other studio's admin), every ledger and every P&L is
-- byte-identical to the old chain (the kept bodies swapped back in, same transaction), every business_pnl answer has the
-- same events with the same numbers in the same date order (same-day events may swap: 0124 orders by date only); (3) the header and
-- the cash view build the ledger ONCE (was twice) and the fenced ledger asks the category helper fewer times;
-- (4) reading writes nothing; access unchanged (anon / no Finance view refused, another studio = null);
-- (5) definer + empty search_path, the page calls for signed-in staff only, the kept bodies + _r387_event_pnl server only.
-- Local disposable PG only. Rolled back.
\set ON_ERROR_STOP 0
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
-- every money answer for one signed-in person, stored under a state name (new / old)
create or replace function pg_temp.collect(p_state text, p_email text, p_org uuid) returns void language plpgsql as $$
declare q uuid; begin
  perform pg_temp.login(p_email);
  for q in select x.id from public.quotes x where x.org_id = p_org order by x.id loop
    insert into _out values (p_state, p_email, 'header:' || q, coalesce(pg_temp.j(format('select public.event_money_header(%L)', q))::text, 'null'));
    insert into _out values (p_state, p_email, 'cash:' || q, coalesce(pg_temp.j(format('select public.event_money_cash(%L)', q))::text, 'null'));
  end loop;
  insert into _out values (p_state, p_email, 'business_pnl:year',
    coalesce(pg_temp.j('select public.business_pnl(current_date - 365, current_date + 365)')::text, 'null'));
  insert into _out values (p_state, p_email, 'business_pnl:default', coalesce(pg_temp.j('select public.business_pnl(null, null)')::text, 'null'));
  perform pg_temp.su();
end $$;
-- the server-side pieces for every event of every studio
create or replace function pg_temp.collect_su(p_state text) returns void language plpgsql as $$
declare x record; begin
  perform pg_temp.su();
  for x in select q.id, q.org_id from public.quotes q order by q.id loop
    insert into _out values (p_state, 'server', 'ledger:' || x.id, coalesce(public._r21_cost_lines__pre0372(x.id, x.org_id)::text, 'null'));
    insert into _out values (p_state, 'server', 'cost_lines:' || x.id, coalesce(public._r21_cost_lines(x.id, x.org_id)::text, 'null'));
    insert into _out values (p_state, 'server', 'pnl:' || x.id, coalesce(public._vb_event_pnl(x.id, x.org_id)::text, 'null'));
    insert into _out values (p_state, 'server', 'money:' || x.id, coalesce(public._r21_event_money(x.id, x.org_id, true)::text, 'null'));
  end loop;
end $$;
-- swap the kept (old) bodies in, or the new ones back
create or replace function pg_temp.swap(p_old boolean) returns void language plpgsql as $$ begin
  perform pg_temp.su();
  if p_old then
    alter function public._r21_cost_lines__pre0372(uuid, uuid) rename to _r212_new_cl;
    alter function public._r21_cost_lines__pre0372__pre0387(uuid, uuid) rename to _r21_cost_lines__pre0372;
    alter function public.event_money_header(uuid) rename to _r212_new_h;
    alter function public.event_money_header__pre0387(uuid) rename to event_money_header;
    alter function public.event_money_cash(uuid) rename to _r212_new_c;
    alter function public.event_money_cash__pre0387(uuid) rename to event_money_cash;
    grant execute on function public.event_money_header(uuid), public.event_money_cash(uuid) to authenticated;
  else
    revoke all on function public.event_money_header(uuid), public.event_money_cash(uuid) from authenticated;
    alter function public._r21_cost_lines__pre0372(uuid, uuid) rename to _r21_cost_lines__pre0372__pre0387;
    alter function public._r212_new_cl(uuid, uuid) rename to _r21_cost_lines__pre0372;
    alter function public.event_money_header(uuid) rename to event_money_header__pre0387;
    alter function public._r212_new_h(uuid) rename to event_money_header;
    alter function public.event_money_cash(uuid) rename to event_money_cash__pre0387;
    alter function public._r212_new_c(uuid) rename to event_money_cash;
  end if;
end $$;
-- calls of a function in THIS transaction so far (track_functions = all)
create or replace function pg_temp.calls(p_fn text) returns bigint language sql as $$
  select coalesce(pg_stat_get_xact_function_calls(to_regprocedure(p_fn)), 0) $$;
grant execute on function pg_temp.calls(text) to anon, authenticated, service_role;

-- ---- setup: 40 busy events in studio A (6 closed + frozen, 1 closed under the legacy rules), 8 in studio B (closed events not frozen) --------
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
\ir ../../supabase/migrations/0387_r212_money_speed.sql
\ir ../../supabase/migrations/0387_r212_money_speed.sql
set client_min_messages = warning;

do $$ begin
  perform pg_temp.su();
  perform pg_temp.res('01 applied twice: the three old bodies kept once (__pre0387), nothing written',
    (select count(*) from pg_proc p join pg_namespace s on s.oid = p.pronamespace where s.nspname = 'public' and p.proname like '%\_\_pre0387') = 3
    and to_regprocedure('public._r21_cost_lines__pre0372__pre0387(uuid,uuid)') is not null
    and to_regprocedure('public.event_money_header__pre0387(uuid)') is not null and to_regprocedure('public.event_money_cash__pre0387(uuid)') is not null
    and pg_temp.rows_hash() = pg_temp.get('h0'));
  perform pg_temp.res('02 new bodies: r212-0387 marker + the old markers kept; the kept bodies are the old ones',
    position('r212-0387' in pg_get_functiondef('public.event_money_header(uuid)'::regprocedure)) > 0
    and position('r197-0376' in pg_get_functiondef('public.event_money_header(uuid)'::regprocedure)) > 0
    and position('r212-0387' in pg_get_functiondef('public.event_money_cash(uuid)'::regprocedure)) > 0
    and position('r198-0377' in pg_get_functiondef('public.event_money_cash(uuid)'::regprocedure)) > 0
    and position('r212-0387' in pg_get_functiondef('public._r21_cost_lines__pre0372(uuid,uuid)'::regprocedure)) > 0
    and position('r21-money-0246' in pg_get_functiondef('public._r21_cost_lines__pre0372(uuid,uuid)'::regprocedure)) > 0
    and position('r212-0387' in pg_get_functiondef('public._r387_event_pnl(uuid,uuid,jsonb)'::regprocedure)) > 0
    and position('r212-0387' in pg_get_functiondef('public.event_money_header__pre0387(uuid)'::regprocedure)) = 0
    and position('r197-0376' in pg_get_functiondef('public.event_money_header__pre0387(uuid)'::regprocedure)) > 0
    and position('r212-0387' in pg_get_functiondef('public.event_money_cash__pre0387(uuid)'::regprocedure)) = 0
    and position('r212-0387' in pg_get_functiondef('public._r21_cost_lines__pre0372__pre0387(uuid,uuid)'::regprocedure)) = 0
    and position('public._vb_event_pnl(' in pg_get_functiondef('public.event_money_header(uuid)'::regprocedure)) = 0
    and position('public._vb_event_pnl(' in pg_get_functiondef('public.event_money_cash(uuid)'::regprocedure)) = 0);
  perform pg_temp.res('03 definer + empty search_path; page calls for signed-in staff only; kept bodies + _r387_event_pnl server only',
    (select bool_and(p.prosecdef and coalesce(p.proconfig, '{}') @> array['search_path=""'] and p.provolatile = 's') from pg_proc p
      where p.oid in ('public.event_money_header(uuid)'::regprocedure, 'public.event_money_cash(uuid)'::regprocedure,
                      'public._r21_cost_lines__pre0372(uuid,uuid)'::regprocedure, 'public._r387_event_pnl(uuid,uuid,jsonb)'::regprocedure,
                      'public.event_money_header__pre0387(uuid)'::regprocedure, 'public.event_money_cash__pre0387(uuid)'::regprocedure,
                      'public._r21_cost_lines__pre0372__pre0387(uuid,uuid)'::regprocedure))
    and has_function_privilege('authenticated', 'public.event_money_header(uuid)', 'execute')
    and has_function_privilege('authenticated', 'public.event_money_cash(uuid)', 'execute')
    and not has_function_privilege('anon', 'public.event_money_header(uuid)', 'execute')
    and not has_function_privilege('anon', 'public.event_money_cash(uuid)', 'execute')
    and not has_function_privilege('authenticated', 'public._r387_event_pnl(uuid,uuid,jsonb)', 'execute')
    and not has_function_privilege('anon', 'public._r387_event_pnl(uuid,uuid,jsonb)', 'execute')
    and not has_function_privilege('authenticated', 'public._r21_cost_lines__pre0372(uuid,uuid)', 'execute')
    and not has_function_privilege('authenticated', 'public._r21_cost_lines__pre0372__pre0387(uuid,uuid)', 'execute')
    and not has_function_privilege('authenticated', 'public.event_money_header__pre0387(uuid)', 'execute')
    and not has_function_privilege('authenticated', 'public.event_money_cash__pre0387(uuid)', 'execute')
    and not has_function_privilege('anon', 'public.event_money_cash__pre0387(uuid)', 'execute')
    and has_function_privilege('service_role', 'public._r387_event_pnl(uuid,uuid,jsonb)', 'execute'));
end $$;

-- ---- access unchanged ----------------------------------------------------------------------------------------------------------
select pg_temp.anon();
do $$ begin
  perform pg_temp.res('04 anon refused on both calls',
    pg_temp.try('select public.event_money_header(''a0000000-0000-4000-8000-00000000da01'')') like '42501%'
    and pg_temp.try('select public.event_money_cash(''a0000000-0000-4000-8000-00000000da01'')') like '42501%');
end $$;
select pg_temp.login('r212_coord@a.test');
do $$ declare q text := (select id::text from public.quotes where code = 'R212-A010'); begin
  perform pg_temp.res('05 a role without Finance view is refused on both (42501)',
    pg_temp.try(format('select public.event_money_header(%L)', q)) like '42501%not authorized%'
    and pg_temp.try(format('select public.event_money_cash(%L)', q)) like '42501%not authorized%');
end $$;
select pg_temp.login('b_admin@b.test');
do $$ declare q text := (select id::text from public.quotes where code = 'R212-A010'); begin
  perform pg_temp.res('06 another studio''s admin: null on both, nothing about the event',
    pg_temp.j(format('select public.event_money_header(%L)', q)) is null and pg_temp.j(format('select public.event_money_cash(%L)', q)) is null);
end $$;

-- ---- the money: new answers, then the old chain swapped back in (same transaction, same "today"), then compared ---------------
select pg_temp.collect('new', 'a_admin@a.test', 'a0000000-0000-4000-8000-000000000001');
select pg_temp.collect('new', 'r212_mgr@a.test', 'a0000000-0000-4000-8000-000000000001');
select pg_temp.collect('new', 'b_admin@b.test', 'b0000000-0000-4000-8000-000000000001');
select pg_temp.collect_su('new');
do $$ declare x record; begin
  perform pg_temp.su();
  for x in select q.id, q.org_id from public.quotes q order by q.id loop
    insert into _out values ('new', 'server', 'r387:' || x.id,
      coalesce(public._r387_event_pnl(x.id, x.org_id, public._r21_event_money(x.id, x.org_id, true))::text, 'null'));
    insert into _out values ('new', 'server', 'money_nolines:' || x.id, coalesce(public._r21_event_money(x.id, x.org_id, false)::text, 'null'));
  end loop;
end $$;
-- ledger calls per header / cash call (open event, frozen event), new bodies
set track_functions = 'all';
do $$ declare qo uuid := (select id from public.quotes where code = 'R212-A030'); qf uuid := (select id from public.quotes where code = 'R212-A003');
  c0 bigint; k0 bigint; c1 bigint; c2 bigint; c3 bigint; k1 bigint; v jsonb;
begin
  perform pg_temp.login('a_admin@a.test');
  c0 := pg_temp.calls('public._r21_cost_lines(uuid,uuid)'); k0 := pg_temp.calls('public._r21_category(text,text)');
  v := public.event_money_header(qo); c1 := pg_temp.calls('public._r21_cost_lines(uuid,uuid)');
  k1 := pg_temp.calls('public._r21_category(text,text)');
  v := public.event_money_cash(qo); c2 := pg_temp.calls('public._r21_cost_lines(uuid,uuid)');
  v := public.event_money_header(qf); c3 := pg_temp.calls('public._r21_cost_lines(uuid,uuid)');
  perform pg_temp.su();
  perform pg_temp.put('new_calls', (c1 - c0) || '/' || (c2 - c1) || '/' || (c3 - c2)); perform pg_temp.put('new_cat', (k1 - k0)::text);
end $$;

select pg_temp.swap(true);
select pg_temp.collect('old', 'a_admin@a.test', 'a0000000-0000-4000-8000-000000000001');
select pg_temp.collect('old', 'r212_mgr@a.test', 'a0000000-0000-4000-8000-000000000001');
select pg_temp.collect('old', 'b_admin@b.test', 'b0000000-0000-4000-8000-000000000001');
select pg_temp.collect_su('old');
do $$ declare qo uuid := (select id from public.quotes where code = 'R212-A030'); qf uuid := (select id from public.quotes where code = 'R212-A003');
  c0 bigint; k0 bigint; c1 bigint; c2 bigint; c3 bigint; k1 bigint; v jsonb;
begin
  perform pg_temp.login('a_admin@a.test');
  c0 := pg_temp.calls('public._r21_cost_lines(uuid,uuid)'); k0 := pg_temp.calls('public._r21_category(text,text)');
  v := public.event_money_header(qo); c1 := pg_temp.calls('public._r21_cost_lines(uuid,uuid)');
  k1 := pg_temp.calls('public._r21_category(text,text)');
  v := public.event_money_cash(qo); c2 := pg_temp.calls('public._r21_cost_lines(uuid,uuid)');
  v := public.event_money_header(qf); c3 := pg_temp.calls('public._r21_cost_lines(uuid,uuid)');
  perform pg_temp.su();
  perform pg_temp.put('old_calls', (c1 - c0) || '/' || (c2 - c1) || '/' || (c3 - c2)); perform pg_temp.put('old_cat', (k1 - k0)::text);
end $$;
select pg_temp.swap(false);
reset track_functions;

do $$ declare n_new int; n_old int; n_diff int; n_err int; d text; begin
  perform pg_temp.su();
  select count(*) into n_new from _out where state = 'new';
  select count(*) into n_old from _out where state = 'old';
  -- business_pnl lists events "order by event_date" (0124 body, unchanged): two events on the same day may come back in either
  -- order, so for it: the same events with the same numbers, the same dates in the same order, the rest of the answer identical
  select count(*), min(n.k) into n_diff, d from _out n join _out o on o.state = 'old' and o.who = n.who and o.k = n.k
   where n.state = 'new' and n.v is distinct from o.v
     and not (n.k like 'business_pnl:%' and n.v like '{%' and o.v like '{%'
              and (n.v::jsonb - 'events') = (o.v::jsonb - 'events')
              and (select jsonb_agg(e order by e::text) from jsonb_array_elements(n.v::jsonb -> 'events') e)
                  is not distinct from (select jsonb_agg(e order by e::text) from jsonb_array_elements(o.v::jsonb -> 'events') e)
              and (select jsonb_agg(e -> 'date' order by x) from jsonb_array_elements(n.v::jsonb -> 'events') with ordinality t(e, x))
                  is not distinct from (select jsonb_agg(e -> 'date' order by x) from jsonb_array_elements(o.v::jsonb -> 'events') with ordinality t(e, x)));
  -- the only refusals: a Finance manager has no Business area (business_pnl is admin-only, 0239) - the same in both states
  -- the only refusals allowed: business_pnl for the Finance manager when the studio gives that role no Business area (0239)
  select count(*) into n_err from _out n where n.v like '{"err"%' and not (n.who = 'r212_mgr@a.test' and n.k like 'business_pnl:%'
    and n.v = '{"err": "42501 not authorized"}' and exists (select 1 from _out o where o.who = n.who and o.k = n.k and o.state <> n.state and o.v = n.v));
  perform pg_temp.res('07 every header / cash answer (admin, Finance manager, other studio) and every ledger + P&L byte-identical to the old chain; business_pnl same events + numbers',
    n_diff = 0 and n_err = 0 and n_old > 400
    and n_new = n_old + 2 * (select count(*) from public.quotes)
    and not exists (select 1 from _out o where o.state = 'old' and not exists (select 1 from _out n where n.state = 'new' and n.who = o.who and n.k = o.k)),
    format('diff=%s first=%s err=%s new=%s old=%s', n_diff, d, n_err, n_new, n_old));
  perform pg_temp.res('08 _r387_event_pnl(quote, studio, ledger) = _vb_event_pnl for every event; the no-lines ledger = the ledger minus its lines',
    not exists (select 1 from _out a join _out b on b.state = 'new' and b.who = 'server' and b.k = 'pnl:' || substr(a.k, 6)
                 where a.state = 'new' and a.who = 'server' and a.k like 'r387:%' and a.v is distinct from b.v)
    and not exists (select 1 from _out a join _out b on b.state = 'new' and b.who = 'server' and b.k = 'money:' || substr(a.k, 15)
                     where a.state = 'new' and a.who = 'server' and a.k like 'money_nolines:%'
                       and a.v is distinct from case when b.v = 'null' then 'null' else (b.v::jsonb - 'lines')::text end)
    and (select count(*) from _out where state = 'new' and who = 'server' and k like 'r387:%') = (select count(*) from public.quotes));
end $$;

do $$ declare h jsonb; f jsonb; l jsonb; m jsonb; c jsonb; b jsonb; bb jsonb; begin
  perform pg_temp.su();
  h := (select v::jsonb from _out where state = 'new' and who = 'a_admin@a.test' and k = 'header:' || (select id from public.quotes where code = 'R212-A030'));
  m := (select v::jsonb from _out where state = 'new' and who = 'r212_mgr@a.test' and k = 'header:' || (select id from public.quotes where code = 'R212-A030'));
  f := (select v::jsonb from _out where state = 'new' and who = 'a_admin@a.test' and k = 'header:' || (select id from public.quotes where code = 'R212-A003'));
  l := (select v::jsonb from _out where state = 'new' and who = 'a_admin@a.test' and k = 'header:' || (select id from public.quotes where code = 'R212-A001'));
  c := (select v::jsonb from _out where state = 'new' and who = 'a_admin@a.test' and k = 'cash:' || (select id from public.quotes where code = 'R212-A030'));
  b := (select v::jsonb from _out where state = 'new' and who = 'b_admin@b.test' and k = 'header:' || (select id from public.quotes where code = 'R212-B001'));
  bb := (select v::jsonb from _out where state = 'new' and who = 'a_admin@a.test' and k = 'business_pnl:year');
  perform pg_temp.res('09 the compared data is rich: open + frozen + legacy + not-frozen events, crew / bills / write-offs / categories, both views',
    jsonb_array_length(h -> 'categories') >= 6 and jsonb_array_length(h -> 'lines') >= 30 and (h ->> 'costs')::numeric > 0
    and h -> 'frozen' = 'null'::jsonb and jsonb_typeof(f -> 'frozen') = 'object' and (f ->> 'live_differs')::boolean
    and l ->> 'rules' = 'legacy' and (l ->> 'closed')::boolean
    and (b ->> 'closed')::boolean and b -> 'frozen' = 'null'::jsonb
    and not (h ->> 'pay_private')::boolean and (m ->> 'pay_private')::boolean
    and jsonb_array_length(c -> 'entries') >= 10 and (c #>> '{owes,crew,total}')::numeric > 0
    and jsonb_array_length(bb -> 'events') >= 30
    and exists (select 1 from jsonb_array_elements(h -> 'lines') x where x ->> 'source' = 'writeoff')
    and exists (select 1 from _out where state = 'new' and who = 'server' and k like 'cost_lines:%' and v like '%"unplanned": true%'),
    left(coalesce(h::text, 'null'), 200));
  perform pg_temp.res('10 the header and the cash view build the ledger once per call (was twice); a frozen event once (as before)',
    pg_temp.get('new_calls') = '1/1/1' and pg_temp.get('old_calls') = '2/2/1',
    'new ' || coalesce(pg_temp.get('new_calls'), '?') || ' old ' || coalesce(pg_temp.get('old_calls'), '?'));
  perform pg_temp.res('11 the fenced ledger asks the category helper far fewer times per header (one ledger, each row once)',
    pg_temp.get('new_cat')::int > 0 and pg_temp.get('new_cat')::int * 3 < pg_temp.get('old_cat')::int,
    'new ' || coalesce(pg_temp.get('new_cat'), '?') || ' old ' || coalesce(pg_temp.get('old_cat'), '?'));
  perform pg_temp.res('12 reading every answer (old and new) wrote nothing; the swap left the new bodies in place',
    pg_temp.rows_hash() = pg_temp.get('h0')
    and position('r212-0387' in pg_get_functiondef('public.event_money_header(uuid)'::regprocedure)) > 0
    and position('r212-0387' in pg_get_functiondef('public._r21_cost_lines__pre0372(uuid,uuid)'::regprocedure)) > 0
    and has_function_privilege('authenticated', 'public.event_money_header(uuid)', 'execute')
    and not has_function_privilege('authenticated', 'public.event_money_header__pre0387(uuid)', 'execute')
    and to_regprocedure('public._r212_new_h(uuid)') is null);
end $$;

select name, result from _rm order by name;
select case when count(*) filter (where result <> 'PASS') = 0
            then 'R212-MONEY-SPEED-0387: ALL PASS (' || count(*) || '/' || count(*) || ')'
            else 'R212-MONEY-SPEED-0387: FAILURES (' || count(*) filter (where result <> 'PASS') || ' of ' || count(*) || ')' end as summary
  from _rm;
rollback;
