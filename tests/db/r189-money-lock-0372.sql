-- r189-money-lock-0372.sql - R189 Money phase 1 "Lock the money" (0372). Proves: (1) applied twice, old bodies kept, no money
-- row rewritten; (2) closed to the app; (3) settings: safe defaults, Settings edit only, ranges, audit; (4) the ledger is
-- unchanged until someone confirms attendance; (5) "Confirm attendance": suggestion from check-ins / roster, one tap, a fix
-- is a new row, overtime / half day / allowance only when switched on, pay admin-only; (6) Unplanned tag + big-gap flags;
-- (7) cost corrections are new rows that count; (8) client TDS counts as settled for the close gate + the payment schedule,
-- Form 16A, a minus row reverses; (9) closing freezes the P&L (v1), frozen numbers stay when a rate changes, snapshots can't
-- be changed, closed = re-open first, late adjustment (admin, when allowed) = v2, re-open + close = v3 with the reason;
-- (10) the frozen-numbers switch; (11) "Freeze now" for an event closed before; (12) cancelled events in the monthly
-- profit (setting); (13) GST + TDS by month; (14) tenant isolation + crew / no-finance never see money; (15) free-trial
-- purge only; (16) a snapshot failure never blocks the close. Re-applies 0372 twice. Local disposable PG only. Rolled back.
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
create or replace function pg_temp.n(p jsonb, p_k text) returns numeric language sql as $$ select (p ->> p_k)::numeric $$;
grant execute on function pg_temp.n(jsonb, text) to anon, authenticated, service_role;
create or replace function pg_temp.line(p jsonb, p_label text) returns jsonb language sql as $$
  select l from jsonb_array_elements(p -> 'lines') l where l ->> 'label' = p_label limit 1 $$;
grant execute on function pg_temp.line(jsonb, text) to anon, authenticated, service_role;
create or replace function pg_temp.person(p jsonb, p_name text) returns jsonb language sql as $$
  select x from jsonb_array_elements(p -> 'people') x where x ->> 'name' = p_name limit 1 $$;
grant execute on function pg_temp.person(jsonb, text) to anon, authenticated, service_role;
create or replace function pg_temp.cat(p jsonb, p_cat text, p_k text) returns text language sql as $$
  select c ->> p_k from jsonb_array_elements(p -> 'by_category') c where c ->> 'key' = p_cat $$;
grant execute on function pg_temp.cat(jsonb, text, text) to anon, authenticated, service_role;
create or replace function pg_temp.member(p_email text, p_role text, p_org uuid) returns uuid language plpgsql as $$
declare u uuid; begin
  perform pg_temp.su(); select id into u from auth.users where email = p_email;
  if u is null then u := auth.seed_user(p_email); end if;
  insert into public.profiles(id, email, role, org_id, must_change_password, created_at) values (u, p_email, p_role, p_org, false, now())
    on conflict (id) do update set org_id = excluded.org_id, role = excluded.role;
  return u;
end $$;
create or replace function pg_temp.nopurge(p_sql text) returns text language plpgsql as $$
declare v text; begin
  perform set_config('helm.allow_purge', '', true);
  begin execute p_sql; v := ''; exception when others then v := sqlstate || ' ' || sqlerrm; end;
  perform set_config('helm.allow_purge', 'on', true); return v;
end $$;
create or replace function pg_temp.purge_as(p_org text, p_sql text) returns text language plpgsql as $$
declare v text; begin
  perform set_config('helm.allow_purge', p_org, true);
  begin execute p_sql; v := ''; exception when others then v := sqlstate || ' ' || sqlerrm; end;
  perform set_config('helm.allow_purge', 'on', true); return v;
end $$;
-- every existing money / attendance row as one hash: proves the migration never rewrites a row
create or replace function pg_temp.rows_hash() returns text language sql as $$
  select md5(coalesce((select string_agg(to_jsonb(k)::text, ',' order by k.id) from public.event_costs k), '')
          || coalesce((select string_agg(to_jsonb(b)::text, ',' order by b.id) from public.vendor_bills b), '')
          || coalesce((select string_agg(to_jsonb(p)::text, ',' order by p.id) from public.quote_payments p), '')
          || coalesce((select string_agg(to_jsonb(m)::text, ',' order by m.id) from public.payment_milestones m), '')
          || coalesce((select string_agg(to_jsonb(d)::text, ',' order by d.id) from public.event_day d), '')
          || coalesce((select string_agg(to_jsonb(c)::text, ',' order by c.id) from public.crew_checkins c), '')) $$;

-- ---- setup (studio A event A-0001: 2,36,000 incl. 18% GST = 2,00,000 + 36,000; event 3 days ago) ------------------------------
do $$ declare a uuid := 'a0000000-0000-4000-8000-000000000001'; b uuid := 'b0000000-0000-4000-8000-000000000001';
  q uuid := 'a0000000-0000-4000-8000-00000000da01'; v1 uuid; bk1 uuid; bk2 uuid; c1 uuid; c2 uuid; c3 uuid; c4 uuid; cb uuid;
begin
  perform pg_temp.member('r189_coord@a.test', 'coordinator', a);      -- no finance
  perform pg_temp.su();
  update public.organizations set timezone = 'Asia/Kolkata' where id = a;
  -- a clean event: earlier suites may have left money rows on A-0001 (rolled back at the end, like every suite)
  if to_regclass('public.event_pnl_snapshots') is not null then   -- 0372 rows other suites left on this event (purge mark is on)
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
  update public.quotes set status = 'confirmed', lifecycle_stage = 'settlement', event_date = current_date - 3, deleted_at = null, is_demo = false
   where id = q;
  insert into public.vendors(id, name, category, org_id) values (gen_random_uuid(), 'Royal Caterers', 'Catering', a) returning id into v1;
  insert into public.event_resources(id, quote_id, vendor_id, kind, label, cost, status, contract, org_id, created_at)
    values (gen_random_uuid(), q, v1, 'catering', 'Royal Caterers', 50000, 'confirmed', true, a, now() - interval '20 days') returning id into bk1;
  insert into public.event_resources(id, quote_id, kind, label, cost, status, org_id, created_at)
    values (gen_random_uuid(), q, 'sound', 'Sound & lights', 30000, 'booked', a, now() - interval '20 days') returning id into bk2;
  insert into public.vendor_bills(quote_id, booking_id, vendor_id, amount, gst_amount, org_id) values (q, bk1, v1, 70800, 10800, a);
  insert into public.vendor_bills(quote_id, booking_id, amount, org_id) values (q, bk2, 31000, a);
  insert into public.vendor_bills(quote_id, amount, description, org_id) values (q, 10000, 'Extra generator', a);   -- unplanned (added after the event day, no plan)
  insert into public.crew_members(id, name, phone, day_rate, org_id) values (gen_random_uuid(), 'Ravi', '+919811100001', 1200, a) returning id into c1;
  insert into public.crew_members(id, name, phone, day_rate, org_id) values (gen_random_uuid(), 'Meena', '+919811100002', 1000, a) returning id into c2;
  insert into public.crew_members(id, name, phone, day_rate, org_id) values (gen_random_uuid(), 'Sita', '+919811100003', 1500, a) returning id into c3;
  insert into public.crew_members(id, name, phone, day_rate, org_id) values (gen_random_uuid(), 'Ajay', '+919811100004', 900, a) returning id into c4;
  insert into public.crew_members(id, name, phone, day_rate, org_id) values (gen_random_uuid(), 'B crew', '+919811100009', 9999, b) returning id into cb;
  perform pg_temp.put('ravi', c1::text); perform pg_temp.put('meena', c2::text); perform pg_temp.put('sita', c3::text);
  perform pg_temp.put('ajay', c4::text); perform pg_temp.put('bcrew', cb::text);
  insert into public.event_tasks(quote_id, category, title, crew_id, status, org_id) values
    (q, 'setup', 'Load in', c1, 'accepted', a), (q, 'setup', 'Welcome desk', c2, 'accepted', a),
    (q, 'setup', 'Bar', c3, 'accepted', a), (q, 'setup', 'Lights', c4, 'assigned', a);
  insert into public.crew_checkins(org_id, quote_id, crew_id, work_day, check_in_at, check_out_at)
    values (a, q, c1, current_date - 3, (current_date - 3) + time '08:00', (current_date - 3) + time '18:00');   -- 10 hours
  insert into public.event_day(quote_id, kind, who, ref_id, status, org_id) values (q, 'arrival', 'Meena', c2, 'arrived', a);
  insert into public.event_day(quote_id, kind, who, ref_id, status, org_id) values (q, 'arrival', 'Sita', c3, 'no_show', a);
  insert into public.quote_payments(quote_id, amount, status, paid_at, org_id, provider, simulated) values (q, 232000, 'paid', now(), a, 'manual', false);
  insert into public.payment_milestones(quote_id, label, amount, status, seq, due_date, org_id) values
    (q, 'Advance', 118000, 'due', 1, current_date - 30, a), (q, 'Balance', 118000, 'due', 2, current_date - 1, a);
  perform pg_temp.put('h0', pg_temp.rows_hash());
end $$;

-- ---- the migration, twice ------------------------------------------------------------------------------------------------------
set client_min_messages = error;
\ir ../../supabase/migrations/0372_r189_money_lock.sql
\ir ../../supabase/migrations/0372_r189_money_lock.sql
set client_min_messages = warning;

do $$ begin
  perform pg_temp.su();
  perform pg_temp.res('01 applied twice: no money / attendance row rewritten; six old bodies kept once; markers in the wrappers',
    pg_temp.rows_hash() = pg_temp.get('h0')
    and (select count(*) from pg_proc p join pg_namespace s on s.oid = p.pronamespace where s.nspname = 'public' and p.proname like '%\_\_pre0372') = 6
    and position('r23-crew-0265' in pg_get_functiondef('public._r21_cost_lines__pre0372(uuid,uuid)'::regprocedure)) > 0
    and position('r189-money-0372' in pg_get_functiondef('public._r21_cost_lines(uuid,uuid)'::regprocedure)) > 0
    and position('r21-money-0246' in pg_get_functiondef('public._vb_event_pnl__pre0372(uuid,uuid)'::regprocedure)) > 0
    and position('helm-0198-stages' in pg_get_functiondef('public._a49_close_blockers__pre0372(uuid)'::regprocedure)) > 0
    and position('r20-business-0239' in pg_get_functiondef('public.business_pnl__pre0372(date,date)'::regprocedure)) > 0
    and not exists (select 1 from public.event_pnl_snapshots where quote_id = 'a0000000-0000-4000-8000-00000000da01')
    and not exists (select 1 from public.money_corrections where quote_id = 'a0000000-0000-4000-8000-00000000da01'));
end $$;

-- ---- closed to the app --------------------------------------------------------------------------------------------------------
select pg_temp.anon();
do $$ declare q uuid := 'a0000000-0000-4000-8000-00000000da01'; begin
  perform pg_temp.res('02 anon: every page function refused, no table readable',
    pg_temp.try(format('select public.event_pnl_versions(%L)', q)) like '42501%'
    and pg_temp.try(format('select public.crew_attendance(%L)', q)) like '42501%'
    and pg_temp.try(format('select public.client_tds_list(%L)', q)) like '42501%'
    and pg_temp.try('select public.money_settings_get()') like '42501%'
    and pg_temp.try('select public.business_tax_by_month(null, null)') like '42501%'
    and pg_temp.try('select count(*) from public.event_pnl_snapshots') like '42501%');
end $$;
select pg_temp.login('a_admin@a.test');
do $$ declare q uuid := 'a0000000-0000-4000-8000-00000000da01'; begin
  perform pg_temp.res('03 signed in (even an admin): no direct read / write of the money tables; the internal helpers are refused',
    pg_temp.try('select count(*) from public.client_tds') like '42501%'
    and pg_temp.try(format('insert into public.money_corrections(org_id, quote_id, category, amount, reason) values (%L, %L, ''misc'', 1, ''direct write'')',
                    'a0000000-0000-4000-8000-000000000001', q)) like '42501%'
    and pg_temp.try(format('select public._r372_snapshot(%L, %L, ''close'', null)', q, 'a0000000-0000-4000-8000-000000000001')) like '42501%'
    and pg_temp.try(format('select public._vb_event_pnl__pre0372(%L, %L)', q, 'a0000000-0000-4000-8000-000000000001')) like '42501%');
end $$;

-- ---- settings ---------------------------------------------------------------------------------------------------------------------
select pg_temp.login('a_staff@a.test');
do $$ declare s jsonb; begin
  s := pg_temp.j('select public.money_settings_get()');
  perform pg_temp.res('04 defaults keep today''s numbers: overtime / half day / allowance / cancelled off, TDS on (2%, 194C), gap 10% / 10,000, late = re-open, frozen on',
    s ->> 'ot_enabled' = 'false' and s ->> 'half_day' = 'false' and s ->> 'allowance_enabled' = 'false' and s ->> 'cancelled_in_pnl' = 'false'
    and s ->> 'tds_enabled' = 'true' and pg_temp.n(s, 'tds_rate') = 2 and s ->> 'tds_section' = '194C' and pg_temp.n(s, 'gap_pct') = 10
    and pg_temp.n(s, 'gap_abs') = 10000 and s ->> 'late_adjust' = 'reopen' and s ->> 'freeze_closed' = 'true' and s ->> 'unplanned_tag' = 'true'
    and pg_temp.n(s, 'std_hours') = 8 and s ->> 'saved' = 'false', s::text);
  perform pg_temp.res('05 bad values refused (22023): unknown key, wrong type, out of range, bad TDS section',
    pg_temp.try('select public.money_settings_set(''{"surprise": true}'')') like '22023%'
    and pg_temp.try('select public.money_settings_set(''{"ot_enabled": "yes"}'')') like '22023%'
    and pg_temp.try('select public.money_settings_set(''{"ot_multiplier": 9}'')') like '22023%'
    and pg_temp.try('select public.money_settings_set(''{"tds_section": "X1"}'')') like '22023%'
    and pg_temp.try('select public.money_settings_set(''{"std_hours": 30}'')') like '22023%');
end $$;
select pg_temp.login('r189_coord@a.test');
do $$ begin
  perform pg_temp.res('06 a role without Settings edit cannot change the money rules (42501)',
    pg_temp.try('select public.money_settings_set(''{"ot_enabled": true}'')') like '42501%');
end $$;

-- ---- the ledger before any confirmation = the kept body ------------------------------------------------------------------------
do $$ declare q uuid := 'a0000000-0000-4000-8000-00000000da01'; a uuid := 'a0000000-0000-4000-8000-000000000001'; m jsonb; o jsonb; p jsonb; p0 jsonb; begin
  perform pg_temp.su();
  m := public._r21_event_money(q, a, true); o := public._r21_event_money__pre0372(q, a, true);
  p := public._vb_event_pnl(q, a); p0 := public._vb_event_pnl__pre0372(q, a);
  perform pg_temp.put('net0', p ->> 'net_profit');
  perform pg_temp.res('07 nothing confirmed / corrected yet: every total and the P&L are exactly the old numbers (wages 1,200 + 1,000 + 0 + 900 estimate)',
    m -> 'cost_expected' = o -> 'cost_expected' and m -> 'cost_actual' = o -> 'cost_actual' and m -> 'cost_estimated' = o -> 'cost_estimated'
    and m -> 'cost_other' = o -> 'cost_other' and m -> 'cost_wages' = o -> 'cost_wages' and pg_temp.n(m, 'cost_wages') = 3100
    and p -> 'net_profit' = p0 -> 'net_profit' and p -> 'vendors' = p0 -> 'vendors' and p -> 'other' = p0 -> 'other'
    and pg_temp.n(p, 'net_profit') = 200000 - 114900 and not (p ? 'frozen'), format('%s / %s', m ->> 'cost_expected', p ->> 'net_profit'));
end $$;

-- ---- Confirm attendance ----------------------------------------------------------------------------------------------------------
select pg_temp.login('a_admin@a.test');
do $$ declare q uuid := 'a0000000-0000-4000-8000-00000000da01'; v jsonb; begin
  v := pg_temp.j(format('select public.crew_attendance(%L)', q));
  perform pg_temp.res('08 suggestion: Ravi 1 day from his check-in (10 h), Meena 1 day (roster arrived), Sita 0 (no-show), Ajay not marked; admin sees rates',
    pg_temp.person(v, 'Ravi') -> 'suggested' ->> 'source' = 'checkin' and (pg_temp.person(v, 'Ravi') -> 'suggested' ->> 'days')::numeric = 1
    and (pg_temp.person(v, 'Ravi') -> 'suggested' ->> 'hours')::numeric = 10 and (pg_temp.person(v, 'Ravi') -> 'suggested' ->> 'ot_hours')::numeric = 0
    and pg_temp.person(v, 'Meena') -> 'suggested' ->> 'source' = 'roster' and (pg_temp.person(v, 'Meena') -> 'suggested' ->> 'days')::numeric = 1
    and (pg_temp.person(v, 'Sita') -> 'suggested' ->> 'days')::numeric = 0 and pg_temp.person(v, 'Ajay') -> 'suggested' ->> 'source' = 'none'
    and (pg_temp.person(v, 'Ravi') ->> 'day_rate')::numeric = 1200 and (pg_temp.person(v, 'Ravi') ->> 'suggested_wage')::numeric = 1200
    and pg_temp.n(v, 'count') = 4 and pg_temp.n(v, 'not_marked') = 1 and (v ->> 'pay_visible')::boolean and (v ->> 'can_confirm')::boolean, v::text);
end $$;
select pg_temp.login('a_staff@a.test');
do $$ declare q uuid := 'a0000000-0000-4000-8000-00000000da01'; v jsonb; m jsonb; begin
  v := pg_temp.j(format('select public.crew_attendance(%L)', q));
  perform pg_temp.res('09 Finance without admin: days and hours yes, never a rate or a wage',
    position('day_rate' in v::text) = 0 and position('wage' in v::text) = 0 and position('1200' in v::text) = 0
    and pg_temp.person(v, 'Ravi') -> 'suggested' ->> 'days' = '1' and not (v ->> 'pay_visible')::boolean, v::text);
  v := pg_temp.j(format('select public.crew_attendance_confirm(%L, null)', q));
  m := pg_temp.j(format('select public.event_cost_breakdown(%L)', q));
  perform pg_temp.res('10 one tap: Ravi, Meena and Sita confirmed as suggested (Ajay, not marked, stays an estimate); wages still 3,100 (defaults change nothing)',
    pg_temp.n(v, 'written') = 3 and pg_temp.n(v, 'confirmed') = 3 and pg_temp.person(v, 'Ajay') -> 'confirmed' = 'null'::jsonb
    and pg_temp.n(m, 'cost_wages') = 3100 and pg_temp.n(m, 'crew_confirmed') = 3 and pg_temp.n(m, 'crew_people') = 4
    and exists (select 1 from jsonb_array_elements(m -> 'warnings') w where w ->> 'code' = 'attendance_unconfirmed' and (w ->> 'count')::int = 1)
    and position('wage_detail' in m::text) = 0, coalesce(v::text, '') || ' | ' || coalesce(m ->> 'cost_wages', ''));
  v := pg_temp.j(format('select public.crew_attendance_confirm(%L, ''[]''::jsonb)', q));
  perform pg_temp.res('11 a second one tap writes nothing (everyone marked is already confirmed)', pg_temp.n(v, 'written') = 0, v::text);
  perform pg_temp.res('12 bad rows refused (22023): not on this event, 0.3 days, negative overtime; no-finance user refused (42501 below)',
    pg_temp.try(format('select public.crew_attendance_confirm(%L, %L::jsonb)', q, jsonb_build_array(jsonb_build_object('crew_id', pg_temp.get('bcrew'), 'days', 1)))) like '22023%'
    and pg_temp.try(format('select public.crew_attendance_confirm(%L, %L::jsonb)', q, jsonb_build_array(jsonb_build_object('crew_id', pg_temp.get('meena'), 'days', 0.3)))) like '22023%'
    and pg_temp.try(format('select public.crew_attendance_confirm(%L, %L::jsonb)', q, jsonb_build_array(jsonb_build_object('crew_id', pg_temp.get('ravi'), 'days', 1, 'ot_hours', -1)))) like '22023%');
end $$;

-- overtime / half day / allowance only when the studio switches them on
select pg_temp.login('a_admin@a.test');
do $$ declare q uuid := 'a0000000-0000-4000-8000-00000000da01'; v jsonb; m jsonb; l jsonb; begin
  perform pg_temp.j('select public.money_settings_set(''{"ot_enabled": true}'')');
  v := pg_temp.j(format('select public.crew_attendance(%L)', q));
  perform pg_temp.res('13 overtime on: Ravi''s 10 h day suggests 2 h overtime (standard day 8 h)',
    (pg_temp.person(v, 'Ravi') -> 'suggested' ->> 'ot_hours')::numeric = 2 and (pg_temp.person(v, 'Ravi') ->> 'suggested_wage')::numeric = 1650, v::text);
  v := pg_temp.j(format('select public.crew_attendance_confirm(%L, %L::jsonb)', q,
         jsonb_build_array(jsonb_build_object('crew_id', pg_temp.get('ravi'), 'days', 1, 'ot_hours', 2, 'note', 'stayed for the pack-down'))));
  m := pg_temp.j(format('select public.event_cost_breakdown(%L)', q)); l := pg_temp.line(m, 'Ravi');
  perform pg_temp.res('14 wage = 1,200 x 1 day + 2 h x (1,200 / 8 x 1.5 = 225) = 1,650; the admin line shows how',
    (l ->> 'actual')::numeric = 1650 and (l -> 'wage_detail' ->> 'ot_amount')::numeric = 450 and (l ->> 'confirmed')::boolean
    and pg_temp.n(m, 'cost_wages') = 3550, coalesce(l::text, m::text));
  perform pg_temp.j(format('select public.crew_attendance_confirm(%L, %L::jsonb)', q, jsonb_build_array(jsonb_build_object('crew_id', pg_temp.get('meena'), 'days', 0.5, 'allowance', 200))));
  l := pg_temp.line(pg_temp.j(format('select public.event_cost_breakdown(%L)', q)), 'Meena');
  perform pg_temp.res('15 half day OFF: 0.5 day is paid as a full day (1,000); allowance OFF: ignored', (l ->> 'actual')::numeric = 1000, l::text);
  perform pg_temp.j('select public.money_settings_set(''{"half_day": true, "allowance_enabled": true, "allowance_default": 150}'')');
  l := pg_temp.line(pg_temp.j(format('select public.event_cost_breakdown(%L)', q)), 'Meena');
  perform pg_temp.res('16 half day ON + allowance ON: 1,000 x 0.5 + 200 allowance = 700', (l ->> 'actual')::numeric = 700, l::text);
  perform pg_temp.j('select public.money_settings_set(''{"ot_enabled": false, "half_day": false, "allowance_enabled": false}'')');
  m := pg_temp.j(format('select public.event_cost_breakdown(%L)', q));
  perform pg_temp.res('17 everything switched off again: wages back to 3,100 (the typed overtime / half day / allowance stay on record, unused)',
    pg_temp.n(m, 'cost_wages') = 3100, m ->> 'cost_wages');
  perform pg_temp.su();
  perform pg_temp.res('18 a fix is a new row: Meena has 2 rows, Ravi 2; a row can''t be changed or deleted (42501); settings change is in the audit log',
    (select count(*) from public.crew_wage_confirmations where crew_id = pg_temp.get('meena')::uuid) = 2
    and (select count(*) from public.crew_wage_confirmations where crew_id = pg_temp.get('ravi')::uuid) = 2
    and pg_temp.try(format('update public.crew_wage_confirmations set days = 5 where crew_id = %L', pg_temp.get('meena'))) like '42501%'
    and pg_temp.nopurge('delete from public.crew_wage_confirmations') like '42501%'
    and (select count(*) from public.audit_log where action = 'money_settings.changed' and org_id = 'a0000000-0000-4000-8000-000000000001') = 3);
end $$;
select pg_temp.login('r189_coord@a.test');
do $$ declare q uuid := 'a0000000-0000-4000-8000-00000000da01'; begin
  perform pg_temp.res('19 crew / no-Finance role: attendance, P&L versions, TDS, corrections all refused (42501)',
    pg_temp.try(format('select public.crew_attendance(%L)', q)) like '42501%'
    and pg_temp.try(format('select public.crew_attendance_confirm(%L, null)', q)) like '42501%'
    and pg_temp.try(format('select public.event_pnl_versions(%L)', q)) like '42501%'
    and pg_temp.try(format('select public.client_tds_list(%L)', q)) like '42501%'
    and pg_temp.try(format('select public.money_correction_add(%L, ''misc'', 100, ''test reason'')', q)) like '42501%');
end $$;

-- ---- Unplanned + big-gap flags ---------------------------------------------------------------------------------------------------
select pg_temp.login('a_staff@a.test');
do $$ declare q uuid := 'a0000000-0000-4000-8000-00000000da01'; m jsonb; begin
  m := pg_temp.j(format('select public.event_cost_breakdown(%L)', q));
  perform pg_temp.res('20 Unplanned: the 10,000 bill added after the event day with no plan is tagged; planned bookings are not',
    (select (l ->> 'unplanned')::boolean from jsonb_array_elements(m -> 'lines') l where l ->> 'source' = 'bill') is true
    and (select l ->> 'unplanned' from jsonb_array_elements(m -> 'lines') l where l ->> 'label' = 'Royal Caterers') is null
    and pg_temp.n(m, 'unplanned_amount') = 10000 and pg_temp.n(m, 'unplanned_lines') = 1
    and exists (select 1 from jsonb_array_elements(m -> 'warnings') w where w ->> 'code' = 'unplanned'), m::text);
  perform pg_temp.res('21 big gap: food 70,800 vs 50,000 planned (+41%) = over; rentals 31,000 vs 30,000 (+3%, < 10,000) = watch',
    pg_temp.cat(m, 'food', 'flag') = 'over' and pg_temp.cat(m, 'rentals', 'flag') = 'watch' and pg_temp.n(m, 'gap_flags') >= 1
    and exists (select 1 from jsonb_array_elements(m -> 'warnings') w where w ->> 'code' = 'big_gap'), (m -> 'by_category')::text);
end $$;
select pg_temp.login('a_admin@a.test');
do $$ declare q uuid := 'a0000000-0000-4000-8000-00000000da01'; m jsonb; begin
  perform pg_temp.j('select public.money_settings_set(''{"gap_pct": 50, "gap_abs": 30000}'')');
  m := pg_temp.j(format('select public.event_cost_breakdown(%L)', q));
  perform pg_temp.res('22 the studio rule decides: 50% / 30,000 -> food (+41%, 20,800) is only "watch"', pg_temp.cat(m, 'food', 'flag') = 'watch', (m -> 'by_category')::text);
  perform pg_temp.j('select public.money_settings_set(''{"gap_pct": 10, "gap_abs": 10000}'')');
end $$;

-- ---- corrections ------------------------------------------------------------------------------------------------------------------
select pg_temp.login('a_staff@a.test');
do $$ declare q uuid := 'a0000000-0000-4000-8000-00000000da01'; v jsonb; p jsonb; m jsonb; begin
  v := pg_temp.j(format('select public.money_correction_add(%L, ''vendors'', -2000, ''generator bill typed 2,000 too high'', ''bill'', null)', q));
  perform pg_temp.su();
  p := public._vb_event_pnl(q, 'a0000000-0000-4000-8000-000000000001');
  perform pg_temp.login('a_staff@a.test');
  m := pg_temp.j(format('select public.event_cost_breakdown(%L)', q));
  perform pg_temp.res('23 a correction is a new row that counts: -2,000 lowers the cost, net profit +2,000, the old keys still add up',
    jsonb_array_length(v -> 'corrections') = 1 and pg_temp.n(p, 'net_profit') = pg_temp.get('net0')::numeric + 2000
    and pg_temp.n(p, 'revenue') - pg_temp.n(p, 'vendors') - pg_temp.n(p, 'other') - pg_temp.n(p, 'staff') - pg_temp.n(p, 'refunds') = pg_temp.n(p, 'net_profit')
    and (select (l ->> 'c_fc')::numeric from jsonb_array_elements(m -> 'lines') l where l ->> 'source' = 'correction') = -2000
    and pg_temp.n(m, 'cost_corrections') = -2000, coalesce(v::text, '') || ' | ' || coalesce(p::text, ''));
  perform pg_temp.res('24 corrections refused (22023): no reason, unknown category, zero amount',
    pg_temp.try(format('select public.money_correction_add(%L, ''vendors'', 100, ''ab'')', q)) like '22023%'
    and pg_temp.try(format('select public.money_correction_add(%L, ''contingency'', 100, ''valid reason'')', q)) like '22023%'
    and pg_temp.try(format('select public.money_correction_add(%L, ''misc'', 0, ''valid reason'')', q)) like '22023%');
end $$;

-- ---- client TDS -------------------------------------------------------------------------------------------------------------------
do $$ declare q uuid := 'a0000000-0000-4000-8000-00000000da01'; v jsonb; b jsonb; s jsonb; begin
  perform pg_temp.su(); perform public._pst_allocate(q); b := public._a49_close_blockers(q);
  perform pg_temp.login('a_staff@a.test');
  v := pg_temp.j(format('select public.client_tds_list(%L)', q));
  perform pg_temp.res('25 before TDS: 4,000 still owed and the close is blocked; TDS suggested 2% of 2,00,000 = 4,000; only the advance is paid',
    pg_temp.n(b, 'balance_owed') = 4000 and (b ->> 'blocked')::boolean and pg_temp.n(v, 'suggested') = 4000 and pg_temp.n(v, 'total') = 0
    and pg_temp.n(v, 'balance_owed') = 4000
    and (select string_agg(status, ',' order by seq) from public.payment_milestones where quote_id = q and label in ('Advance', 'Balance')) = 'paid,due', b::text || v::text);
  perform pg_temp.res('26 TDS refused (22023): more than the balance owed, a wrong section, zero',
    pg_temp.try(format('select public.client_tds_record(%L, 4001, ''194C'')', q)) like '22023%'
    and pg_temp.try(format('select public.client_tds_record(%L, 100, ''X1'')', q)) like '22023%'
    and pg_temp.try(format('select public.client_tds_record(%L, 0)', q)) like '22023%');
  v := pg_temp.j(format('select public.client_tds_record(%L, 4000, ''194c'', 2, ''Acme Ltd deducted 2%%'')', q));
  s := pg_temp.j(format('select public.payment_schedule_for_quote(%L)', q));
  perform pg_temp.put('tds1', (v -> 'rows' -> 0 ->> 'id'));
  perform pg_temp.su(); b := public._a49_close_blockers(q);
  perform pg_temp.res('27 TDS 4,000 recorded: counts as settled (balance 0, money no longer blocks), covers the last payment, schedule outstanding 0',
    pg_temp.n(v, 'total') = 4000 and v -> 'rows' -> 0 ->> 'section' = '194C' and pg_temp.n(b, 'balance_owed') = 0 and pg_temp.n(b, 'client_tds') = 4000
    and pg_temp.n(b, 'balance_before_tds') = 4000 and not (b ->> 'blocked')::boolean
    and (select string_agg(status, ',' order by seq) from public.payment_milestones where quote_id = q and label in ('Advance', 'Balance')) = 'paid,paid'
    and pg_temp.n(s, 'outstanding') = 0 and pg_temp.n(v, 'milestones_covered') = 1, b::text || ' ' || coalesce(s::text, '') || ' ' || v::text);
  perform pg_temp.res('28 TDS never changes profit (net profit = before TDS)',
    pg_temp.n(public._vb_event_pnl(q, 'a0000000-0000-4000-8000-000000000001'), 'net_profit') = pg_temp.get('net0')::numeric + 2000);
  perform pg_temp.login('a_staff@a.test');
  v := pg_temp.j(format('select public.client_tds_reverse(%L, ''typed on the wrong event'')', pg_temp.get('tds1')));
  perform pg_temp.su(); b := public._a49_close_blockers(q);
  perform pg_temp.login('a_staff@a.test');
  perform pg_temp.res('29 a wrong TDS row is reversed by a minus row (never edited): total 0, owed 4,000 again; twice refused',
    pg_temp.n(v, 'total') = 0 and jsonb_array_length(v -> 'rows') = 2 and pg_temp.n(b, 'balance_owed') = 4000
    and pg_temp.try(format('select public.client_tds_reverse(%L, ''again please'')', pg_temp.get('tds1'))) like '22023%', v::text);
  v := pg_temp.j(format('select public.client_tds_record(%L, 4000, null)', q));
  perform pg_temp.put('tds2', (select r ->> 'id' from jsonb_array_elements(v -> 'rows') r where (r ->> 'amount')::numeric > 0 and not (r ->> 'reversed')::boolean));
  v := pg_temp.j(format('select public.client_tds_form16a(%L, current_date, ''received by mail'')', pg_temp.get('tds2')));
  perform pg_temp.res('30 recorded again + Form 16A ticked: total 4,000, certified 4,000; a second tick changes nothing; the reversed row can''t be certified',
    pg_temp.n(v, 'total') = 4000 and pg_temp.n(v, 'certified') = 4000
    and pg_temp.try(format('select public.client_tds_form16a(%L)', pg_temp.get('tds2'))) = ''
    and pg_temp.try(format('select public.client_tds_form16a(%L)', pg_temp.get('tds1'))) like '22023%', v::text);
end $$;

-- ---- tenant isolation ---------------------------------------------------------------------------------------------------------------
select pg_temp.login('b_admin@b.test');
do $$ declare q uuid := 'a0000000-0000-4000-8000-00000000da01'; t jsonb; begin
  t := pg_temp.j('select public.business_tax_by_month(current_date - 60, current_date + 60)');
  perform pg_temp.res('31 studio B''s admin: every function refused on A''s event (42501); B''s monthly tax shows nothing of A',
    pg_temp.try(format('select public.event_pnl_versions(%L)', q)) like '42501%'
    and pg_temp.try(format('select public.crew_attendance(%L)', q)) like '42501%'
    and pg_temp.try(format('select public.crew_attendance_confirm(%L, null)', q)) like '42501%'
    and pg_temp.try(format('select public.client_tds_list(%L)', q)) like '42501%'
    and pg_temp.try(format('select public.client_tds_record(%L, 1)', q)) like '42501%'
    and pg_temp.try(format('select public.client_tds_reverse(%L, ''cross studio'')', pg_temp.get('tds2'))) like '42501%'
    and pg_temp.try(format('select public.client_tds_form16a(%L)', pg_temp.get('tds2'))) like '42501%'
    and pg_temp.try(format('select public.money_correction_add(%L, ''misc'', 1, ''cross studio'')', q)) like '42501%'
    and pg_temp.try(format('select public.pnl_freeze_now(%L)', q)) like '42501%'
    and position('4000' in t::text) = 0 and position('36000' in t::text) = 0, t::text);
end $$;

-- ---- close: the P&L is frozen ----------------------------------------------------------------------------------------------------
select pg_temp.login('a_admin@a.test');
do $$ declare q uuid := 'a0000000-0000-4000-8000-00000000da01'; v jsonb; p jsonb; e text; begin
  e := pg_temp.try(format('select public.close_event(%L, true)', q));
  v := pg_temp.j(format('select public.event_pnl_versions(%L)', q));
  p := pg_temp.j(format('select public.event_pnl(%L)', q));
  perform pg_temp.put('net1', v -> 'versions' -> 0 ->> 'net_profit');
  perform pg_temp.res('32 closing writes snapshot v1 (who + when), the P&L says frozen v1, the numbers = the live ones at close',
    e = '' and (v ->> 'frozen')::boolean and pg_temp.n(v, 'current_version') = 1 and jsonb_array_length(v -> 'versions') = 1
    and v -> 'versions' -> 0 ->> 'reason' = 'close' and v -> 'versions' -> 0 ->> 'by' = 'a_admin@a.test'
    and pg_temp.n(v -> 'versions' -> 0, 'net_profit') = pg_temp.get('net0')::numeric + 2000
    and (p -> 'frozen' ->> 'version')::int = 1 and pg_temp.n(p, 'net_profit') = pg_temp.get('net0')::numeric + 2000
    and not (v ->> 'live_differs')::boolean, e || ' ' || v::text || ' ' || p::text);
end $$;
do $$ declare q uuid := 'a0000000-0000-4000-8000-00000000da01'; v jsonb; p jsonb; bz jsonb; begin
  perform pg_temp.su();
  update public.crew_members set day_rate = 5000 where id = pg_temp.get('ravi')::uuid;     -- a rate changed after closing
  perform pg_temp.login('a_admin@a.test');
  v := pg_temp.j(format('select public.event_pnl_versions(%L)', q));
  p := pg_temp.j(format('select public.event_pnl(%L)', q));
  bz := pg_temp.j('select public.business_pnl(current_date - 60, current_date + 60)');
  perform pg_temp.res('33 a day rate changed after closing: frozen profit stays (P&L + Business), live shows the difference (-3,800)',
    pg_temp.n(p, 'net_profit') = pg_temp.get('net1')::numeric
    and (select (e ->> 'net_profit')::numeric from jsonb_array_elements(bz -> 'events') e where e ->> 'code' = 'A-0001') = pg_temp.get('net1')::numeric
    and (v ->> 'live_differs')::boolean and pg_temp.n(v -> 'live', 'net_profit') = pg_temp.get('net1')::numeric - 3800
    and pg_temp.n(p, 'live_net_profit') = pg_temp.get('net1')::numeric - 3800, v::text);
  perform pg_temp.su();
  update public.crew_members set day_rate = 1200 where id = pg_temp.get('ravi')::uuid;
  perform pg_temp.res('34 a snapshot can''t be changed or deleted, even by the database owner (42501)',
    pg_temp.try('update public.event_pnl_snapshots set note = ''x''') like '42501%'
    and pg_temp.nopurge('delete from public.event_pnl_snapshots') like '42501%'
    and (select count(*) from public.event_pnl_snapshots where quote_id = 'a0000000-0000-4000-8000-00000000da01') = 1);
end $$;
select pg_temp.login('a_admin@a.test');
do $$ declare q uuid := 'a0000000-0000-4000-8000-00000000da01'; v jsonb; begin
  v := pg_temp.j(format('select public.event_pnl_versions(%L)', q));
  perform pg_temp.res('35 closed + default rules: corrections, attendance and TDS reversal say "re-open first" (42501); Form 16A + new TDS still allowed',
    not (v ->> 'can_correct')::boolean
    and pg_temp.try(format('select public.money_correction_add(%L, ''misc'', 500, ''late taxi bill'')', q)) like '42501%This event is closed%'
    and pg_temp.try(format('select public.crew_attendance_confirm(%L, null)', q)) like '42501%'
    and pg_temp.try(format('select public.client_tds_reverse(%L, ''closed event'')', pg_temp.get('tds2'))) like '42501%', v::text);
  perform pg_temp.j('select public.money_settings_set(''{"freeze_closed": false}'')');
  perform pg_temp.res('36 frozen numbers switch OFF: the closed event shows live numbers again (no frozen key)',
    not (pg_temp.j(format('select public.event_pnl(%L)', q)) ? 'frozen'));
  perform pg_temp.j('select public.money_settings_set(''{"freeze_closed": true, "late_adjust": "admin"}'')');
end $$;
select pg_temp.login('a_staff@a.test');
do $$ declare q uuid := 'a0000000-0000-4000-8000-00000000da01'; begin
  perform pg_temp.res('37 late adjustments allowed for admins: a non-admin with Finance edit is still refused (42501)',
    pg_temp.try(format('select public.money_correction_add(%L, ''logistics'', 3000, ''late transport bill'')', q)) like '42501%');
end $$;
select pg_temp.login('a_admin@a.test');
do $$ declare q uuid := 'a0000000-0000-4000-8000-00000000da01'; v jsonb; p jsonb; begin
  v := pg_temp.j(format('select public.money_correction_add(%L, ''logistics'', 3000, ''late transport bill'')', q));
  p := pg_temp.j(format('select public.event_pnl(%L)', q));
  perform pg_temp.res('38 admin late adjustment on a closed event: v2 written at once (reason, -3,000 profit, the correction listed), the event stays closed',
    pg_temp.n(v, 'current_version') = 2 and v -> 'versions' -> 0 ->> 'reason' = 'late_adjustment'
    and (v -> 'versions' -> 0 -> 'diff' -> 'net_profit' ->> 'change')::numeric = -3000
    and jsonb_array_length(v -> 'versions' -> 0 -> 'diff' -> 'corrections') = 1 and (v ->> 'closed')::boolean
    and (p -> 'frozen' ->> 'version')::int = 2 and pg_temp.n(p, 'net_profit') = pg_temp.get('net1')::numeric - 3000
    and (v -> 'corrections' -> 0 ->> 'after_close')::boolean, v::text);
  perform pg_temp.try(format('select public.reopen_event(%L, ''client paid a late extra invoice'')', q));
  p := pg_temp.j(format('select public.event_pnl(%L)', q));
  v := pg_temp.j(format('select public.event_pnl_versions(%L)', q));
  perform pg_temp.res('39 re-opened: live numbers again, nothing frozen for the open event, the old versions stay',
    not (p ? 'frozen') and not (v ->> 'frozen')::boolean and jsonb_array_length(v -> 'versions') = 2 and not (v ->> 'closed')::boolean, v::text);
  perform pg_temp.try(format('select public.close_event(%L, true)', q));
  v := pg_temp.j(format('select public.event_pnl_versions(%L)', q));
  perform pg_temp.res('40 closed again: v3 (close) with the re-open reason; Business uses v3',
    pg_temp.n(v, 'current_version') = 3 and v -> 'versions' -> 0 ->> 'reason' = 'close'
    and v -> 'versions' -> 0 -> 'diff' ->> 'reopen_reason' = 'client paid a late extra invoice'
    and (pg_temp.j(format('select public.event_pnl(%L)', q)) -> 'frozen' ->> 'version')::int = 3, v::text);
end $$;

-- ---- an event closed before this release: not frozen until an admin freezes it ---------------------------------------------------
do $$ declare a uuid := 'a0000000-0000-4000-8000-000000000001'; q2 uuid := gen_random_uuid(); begin
  perform pg_temp.su();
  insert into public.quotes(id, code, title, status, lifecycle_stage, client, pricing, current_version, approval_status, org_id, event_date, created_at, updated_at)
    values (q2, 'A-0002', 'Old closed party', 'confirmed', 'closed', '{"name":"Old"}'::jsonb, '{"subtotal":50000,"discount":0,"gstPct":18,"total":59000}'::jsonb,
            1, 'approved', a, current_date - 40, now(), now());
  alter table public.event_closure disable trigger zzz_r372_close_snapshot;
  insert into public.event_closure(quote_id, org_id, closed_at) values (q2, a, now() - interval '20 days');
  alter table public.event_closure enable trigger zzz_r372_close_snapshot;
  perform pg_temp.put('q2', q2::text);
end $$;
select pg_temp.login('a_staff@a.test');
do $$ begin
  perform pg_temp.res('41 closed before: "not frozen"; only an admin may freeze it (42501 for Finance edit)',
    not (pg_temp.j(format('select public.event_pnl_versions(%L)', pg_temp.get('q2'))) ->> 'frozen')::boolean
    and pg_temp.try(format('select public.pnl_freeze_now(%L)', pg_temp.get('q2'))) like '42501%');
end $$;
select pg_temp.login('a_admin@a.test');
do $$ declare v jsonb; begin
  v := pg_temp.j(format('select public.event_pnl_versions(%L)', pg_temp.get('q2')));
  perform pg_temp.res('42 admin sees "Freeze now"; freezing writes v1 marked as a manual freeze; a second freeze is refused (22023)',
    (v ->> 'can_freeze')::boolean
    and (pg_temp.j(format('select public.pnl_freeze_now(%L)', pg_temp.get('q2'))) -> 'versions' -> 0 ->> 'reason') = 'manual_freeze'
    and pg_temp.try(format('select public.pnl_freeze_now(%L)', pg_temp.get('q2'))) like '22023%'
    and pg_temp.try(format('select public.pnl_freeze_now(%L)', 'a0000000-0000-4000-8000-00000000da01')) like '22023%', v::text);
end $$;

-- ---- cancelled events in the monthly profit -------------------------------------------------------------------------------------
do $$ declare a uuid := 'a0000000-0000-4000-8000-000000000001'; q3 uuid := gen_random_uuid(); begin
  perform pg_temp.su();
  insert into public.quotes(id, code, title, status, lifecycle_stage, client, pricing, current_version, approval_status, org_id, event_date, created_at, updated_at)
    values (q3, 'A-0003', 'Cancelled sangeet', 'confirmed', 'confirmed', '{"name":"C"}'::jsonb, '{"subtotal":100000,"discount":0,"gstPct":18,"total":118000}'::jsonb,
            1, 'approved', a, current_date - 10, now(), now());
  insert into public.quote_payments(quote_id, amount, status, paid_at, org_id, provider, simulated) values (q3, 50000, 'paid', now(), a, 'manual', false);
  insert into public.event_refunds(quote_id, kind, amount, status, org_id) values (q3, 'refund', 10000, 'processed', a);
  insert into public.event_resources(quote_id, kind, label, cost, advance, status, org_id) values (q3, 'decor', 'Decor advance', 20000, 5000, 'booked', a);
  update public.quotes set status = 'cancelled' where id = q3;
end $$;
select pg_temp.login('a_admin@a.test');
do $$ declare bz jsonb; e jsonb; begin
  bz := pg_temp.j('select public.business_pnl(current_date - 60, current_date + 60)');
  perform pg_temp.res('43 cancelled events OFF (default): not in the monthly profit, as today',
    not exists (select 1 from jsonb_array_elements(bz -> 'events') x where x ->> 'code' = 'A-0003') and not (bz ? 'cancelled_counted'), bz::text);
  perform pg_temp.j('select public.money_settings_set(''{"cancelled_in_pnl": true}'')');
  bz := pg_temp.j('select public.business_pnl(current_date - 60, current_date + 60)');
  select x into e from jsonb_array_elements(bz -> 'events') x where x ->> 'code' = 'A-0003';
  perform pg_temp.res('44 cancelled events ON: kept 40,000 (50,000 - 10,000 refund) = 33,898.31 without GST, minus 5,000 paid to the vendor = 28,898.31',
    (e ->> 'cancelled')::boolean and pg_temp.n(e, 'kept') = 40000 and pg_temp.n(e, 'revenue') = 33898.31 and pg_temp.n(e, 'vendors') = 5000
    and pg_temp.n(e, 'net_profit') = 28898.31 and (bz ->> 'cancelled_events')::int >= 1, coalesce(e::text, bz::text));
end $$;

-- ---- GST and TDS by month ------------------------------------------------------------------------------------------------------------
select pg_temp.login('a_admin@a.test');
do $$ declare t jsonb; mo jsonb; cur jsonb; begin
  t := pg_temp.j('select public.business_tax_by_month(current_date - 60, current_date + 60)');
  select x into mo from jsonb_array_elements(t -> 'months') x where x ->> 'month' = to_char(current_date - 3, 'YYYY-MM');
  select x into cur from jsonb_array_elements(t -> 'months') x where x ->> 'month' = to_char((now() at time zone 'Asia/Kolkata')::date, 'YYYY-MM');
  perform pg_temp.res('45 GST by event month: 36,000 collected, no input credit (food GST blocked), 36,000 to pay; client TDS 4,000 this month, certified 4,000, pending 0',
    pg_temp.n(mo, 'gst_collected') >= 36000 and pg_temp.n(mo, 'gst_to_pay') >= 36000 and pg_temp.n(mo, 'input_credit') = 0
    and pg_temp.n(cur, 'tds_deducted') = 4000 and pg_temp.n(cur, 'tds_certified') = 4000 and pg_temp.n(cur, 'tds_pending') = 0
    and t ->> 'currency' = 'INR', t::text);
end $$;
select pg_temp.login('a_staff@a.test');
do $$ begin
  perform pg_temp.res('46 monthly tax needs the Business area: Finance alone is refused (42501)',
    pg_temp.try('select public.business_tax_by_month(null, null)') like '42501%');
end $$;

-- ---- free-trial purge -----------------------------------------------------------------------------------------------------------------
do $$ declare e text; begin
  perform pg_temp.su();
  e := pg_temp.purge_as('a0000000-0000-4000-8000-000000000001', format('delete from public.event_pnl_snapshots where quote_id = %L', pg_temp.get('q2')));
  perform pg_temp.res('47 the free-trial purge list has the 5 money record tables (settings in the keep list); a purge-marked delete works',
    'client_tds' = any(public._tr184_purge_tables()) and 'event_pnl_snapshots' = any(public._tr184_purge_tables())
    and 'crew_wage_confirmations' = any(public._tr184_purge_tables()) and 'money_corrections' = any(public._tr184_purge_tables())
    and 'client_tds_certificates' = any(public._tr184_purge_tables()) and 'money_settings' = any(public._tr184_keep_tables())
    and e = '' and not exists (select 1 from public.event_pnl_snapshots where quote_id = pg_temp.get('q2')::uuid),
    e || ' / ' || (select count(*) from public.event_pnl_snapshots where quote_id = pg_temp.get('q2')::uuid));
end $$;

-- ---- a snapshot problem never blocks the close ---------------------------------------------------------------------------------------
do $$ declare a uuid := 'a0000000-0000-4000-8000-000000000001'; q4 uuid := gen_random_uuid(); begin
  perform pg_temp.su();
  insert into public.quotes(id, code, title, status, lifecycle_stage, client, pricing, current_version, approval_status, org_id, event_date, created_at, updated_at)
    values (q4, 'A-0004', 'Small dinner', 'confirmed', 'settlement', '{"name":"D"}'::jsonb, '{"subtotal":10000,"discount":0,"gstPct":18,"total":11800}'::jsonb,
            1, 'approved', a, current_date - 2, now(), now());
  insert into public.quote_payments(quote_id, amount, status, paid_at, org_id, provider, simulated) values (q4, 11800, 'paid', now(), a, 'manual', false);
  perform pg_temp.put('q4', q4::text);
end $$;
create or replace function public._r372_snapshot(p_quote uuid, p_org uuid, p_reason text, p_note text)
returns integer language plpgsql volatile security definer set search_path = '' as $$ begin raise exception 'simulated snapshot failure'; end $$;
select pg_temp.login('a_admin@a.test');
do $$ declare q uuid := pg_temp.get('q4')::uuid; e text; v jsonb; begin
  e := pg_temp.try(format('select public.close_event(%L, true)', q));
  v := pg_temp.j(format('select public.event_pnl_versions(%L)', q));
  perform pg_temp.res('48 snapshot failure: the close still goes through, it is logged, the page says not frozen + offers "Freeze now"',
    e = '' and (v ->> 'closed')::boolean and not (v ->> 'frozen')::boolean and (v ->> 'can_freeze')::boolean
    and exists (select 1 from public.audit_log a where a.quote_id = q and a.action = 'pnl_snapshot_failed'), e || ' ' || v::text);
end $$;

select pg_temp.su();
\ir ../../supabase/migrations/0372_r189_money_lock.sql

select name, result from _rm order by name;
select case when count(*) filter (where result <> 'PASS') = 0
            then 'R189-MONEY-LOCK-0372: ALL PASS (' || count(*) || '/' || count(*) || ')'
            else 'R189-MONEY-LOCK-0372: FAILURES (' || count(*) filter (where result <> 'PASS') || ' of ' || count(*) || ')' end as summary
  from _rm;
rollback;
