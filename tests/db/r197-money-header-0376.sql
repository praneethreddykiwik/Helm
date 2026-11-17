-- r197-money-header-0376.sql - R197 P&L clarity phase 1 (0376). Proves: (1) applied twice, old bodies kept once, no money row
-- rewritten, the call itself writes nothing; (2) anon / a client / a role without Finance view refused, another studio's or an
-- unknown event = null; (3) the header numbers are the server's own ledger numbers (Quoted, Received, balance, Costs vs Plan,
-- Profit = _vb_event_pnl, margin to 1 decimal); (4) traffic light: target not set = 25 %, the studio target (0242) and the
-- amber band (new money rule, default 5) move the light; (5) plan vs expected per category with the 0372 big-gap flag, the two
-- reasons; (6) cost lines: per-person crew pay for the admin only; (7) Needs attention: at most 3, red first (bill due
-- tomorrow, money to collect after the event, margin below target); (8) a closed event shows the frozen figure (Frozen v1),
-- a later rate change is a live note only; (9) money rules: margin_band saved with the other rules, ranges, Settings edit
-- only, audit; the kept 0372 bodies are server only; (10) get_studio_target_margin default 25; grants / definer / search_path.
-- Local disposable PG only. Rolled back.
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
          || coalesce((select string_agg(to_jsonb(c)::text, ',' order by c.org_id, c.key) from public.app_config c), '')) $$;

-- ---- setup: studio A event A-0001 (2,36,000 incl. 18% GST = 2,00,000 + 36,000), event 3 days ago, nothing closed --------------
do $$ declare a uuid := 'a0000000-0000-4000-8000-000000000001'; q uuid := 'a0000000-0000-4000-8000-00000000da01';
  v1 uuid; bk1 uuid; bk2 uuid; c1 uuid; c2 uuid;
begin
  perform pg_temp.member('r197_coord@a.test', 'coordinator', a);      -- no finance
  perform pg_temp.member('r197_mgr@a.test', 'manager', a);            -- finance view, not admin
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
  insert into public.vendors(id, name, category, org_id) values (gen_random_uuid(), 'Royal Caterers', 'Catering', a) returning id into v1;
  insert into public.event_resources(id, quote_id, vendor_id, kind, label, cost, status, contract, org_id, created_at)
    values (gen_random_uuid(), q, v1, 'catering', 'Royal Caterers', 50000, 'confirmed', true, a, now() - interval '20 days') returning id into bk1;
  insert into public.event_resources(id, quote_id, kind, label, cost, status, org_id, created_at)
    values (gen_random_uuid(), q, 'sound', 'Sound & lights', 30000, 'booked', a, now() - interval '20 days') returning id into bk2;
  -- catering bill 70,800 (50,000 planned: 20,800 over = big gap), due tomorrow; sound bill 31,000 due in 10 days
  insert into public.vendor_bills(quote_id, booking_id, vendor_id, amount, gst_amount, due_date, org_id) values (q, bk1, v1, 70800, 10800, public.studio_today(a) + 1, a);
  insert into public.vendor_bills(quote_id, booking_id, amount, due_date, org_id) values (q, bk2, 31000, public.studio_today(a) + 10, a);
  insert into public.crew_members(id, name, phone, day_rate, org_id) values (gen_random_uuid(), 'Ravi R197', '+919811100071', 1200, a) returning id into c1;
  insert into public.crew_members(id, name, phone, day_rate, org_id) values (gen_random_uuid(), 'Meena R197', '+919811100072', 1000, a) returning id into c2;
  perform pg_temp.put('ravi', c1::text);
  insert into public.event_tasks(quote_id, category, title, crew_id, status, org_id) values
    (q, 'setup', 'Load in', c1, 'accepted', a), (q, 'setup', 'Welcome desk', c2, 'accepted', a);
  insert into public.event_day(quote_id, kind, who, ref_id, status, org_id) values (q, 'arrival', 'Ravi R197', c1, 'arrived', a), (q, 'arrival', 'Meena R197', c2, 'arrived', a);
  insert into public.quote_payments(quote_id, amount, status, paid_at, org_id, provider, simulated) values (q, 118000, 'paid', now(), a, 'manual', false);
  insert into public.payment_milestones(quote_id, label, amount, status, seq, due_date, org_id) values
    (q, 'Advance', 118000, 'paid', 1, public.studio_today(a) - 30, a), (q, 'Balance', 118000, 'due', 2, public.studio_today(a) - 1, a);
  perform pg_temp.put('h0', pg_temp.rows_hash());
  perform pg_temp.put('np', (select count(*) from pg_proc p join pg_namespace s on s.oid = p.pronamespace where s.nspname = 'public')::text);
end $$;

-- ---- the migration, twice ------------------------------------------------------------------------------------------------------
set client_min_messages = error;
\ir ../../supabase/migrations/0376_r197_event_money_header.sql
\ir ../../supabase/migrations/0376_r197_event_money_header.sql
set client_min_messages = warning;

do $$ begin
  perform pg_temp.su();
  perform pg_temp.res('01 applied twice: no money / settings row rewritten; the two 0372 bodies kept once; new column defaulted',
    pg_temp.rows_hash() = pg_temp.get('h0')
    and (select count(*) from pg_proc p join pg_namespace s on s.oid = p.pronamespace where s.nspname = 'public' and p.proname like '%\_\_pre0376') = 2
    and position('r189-money-0372' in pg_get_functiondef('public.money_settings_get__pre0376()'::regprocedure)) > 0
    and position('r189-money-0372' in pg_get_functiondef('public.money_settings_set__pre0376(jsonb)'::regprocedure)) > 0
    and position('r197-0376' in pg_get_functiondef('public.money_settings_get()'::regprocedure)) > 0
    and position('r197-0376' in pg_get_functiondef('public.money_settings_set(jsonb)'::regprocedure)) > 0
    and position('r197-0376' in pg_get_functiondef('public.get_studio_target_margin()'::regprocedure)) > 0
    and exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'money_settings'
                 and column_name = 'margin_band' and column_default = '5' and is_nullable = 'NO'));
end $$;

-- ---- who may call it ------------------------------------------------------------------------------------------------------------
select pg_temp.anon();
do $$ begin
  perform pg_temp.res('02 anon refused (no execute)',
    pg_temp.try('select public.event_money_header(''a0000000-0000-4000-8000-00000000da01'')') like '42501%');
end $$;
select pg_temp.login('r197_coord@a.test');
do $$ begin
  perform pg_temp.res('03 a role without Finance view is refused (42501); no money leaks in the error',
    pg_temp.try('select public.event_money_header(''a0000000-0000-4000-8000-00000000da01'')') like '42501%not authorized%');
end $$;
select pg_temp.login('b_admin@b.test');
do $$ declare v jsonb; begin
  v := pg_temp.j('select public.event_money_header(''a0000000-0000-4000-8000-00000000da01'')');
  perform pg_temp.res('04 another studio (even its admin): null, nothing about the event', v is null, coalesce(v::text, ''));
end $$;
select pg_temp.login('a_admin@a.test');
do $$ declare v jsonb; begin
  v := pg_temp.j('select public.event_money_header(''00000000-0000-4000-8000-000000000bad'')');
  perform pg_temp.res('05 an unknown event: null (no error = no HTTP 500 in the log)', v is null, coalesce(v::text, ''));
end $$;

-- ---- the numbers --------------------------------------------------------------------------------------------------------------
do $$ declare q uuid := 'a0000000-0000-4000-8000-00000000da01'; a uuid := 'a0000000-0000-4000-8000-000000000001';
  v jsonb; b jsonb; p jsonb; h1 text; h2 text; n_audit bigint; n2 bigint;
begin
  perform pg_temp.su(); h1 := pg_temp.rows_hash(); n_audit := (select count(*) from public.audit_log); perform pg_temp.login('a_admin@a.test');
  v := pg_temp.j(format('select public.event_money_header(%L)', q));
  b := pg_temp.j(format('select public.event_cost_breakdown(%L)', q));
  perform pg_temp.su(); p := public._vb_event_pnl(q, a); h2 := pg_temp.rows_hash(); n2 := (select count(*) from public.audit_log);
  perform pg_temp.login('a_admin@a.test');
  perform pg_temp.put('v_open', v::text);
  perform pg_temp.res('06 reading writes nothing (no money row, no audit row)',
    h2 = h1 and n2 = n_audit and v ? 'profit', left(v::text, 300));
  perform pg_temp.res('07 cash: Quoted 2,36,000 with GST, received 1,18,000 (50%), balance 1,18,000',
    (v ->> 'quoted')::numeric = 236000 and (v ->> 'received')::numeric = 118000 and (v ->> 'balance')::numeric = 118000
    and (v ->> 'received_pct')::numeric = 50 and (v ->> 'revenue')::numeric = 200000 and (v ->> 'tax')::numeric = 36000, v::text);
  perform pg_temp.res('08 costs / plan / profit are the ledger''s own: Expected (open event), plan = estimated, profit = _vb_event_pnl',
    v ->> 'cost_word' = 'expected' and not (v ->> 'closed')::boolean and v -> 'frozen' = 'null'::jsonb
    and (v ->> 'costs')::numeric = (b ->> 'cost_expected')::numeric and (v ->> 'costs_plan')::numeric = (b ->> 'cost_estimated')::numeric
    and (v ->> 'profit')::numeric = (p ->> 'net_profit')::numeric
    and (v ->> 'costs_diff')::numeric = (b ->> 'cost_expected')::numeric - (b ->> 'cost_estimated')::numeric
    and (v ->> 'margin_pct')::numeric = round((p ->> 'net_profit')::numeric / 200000 * 100, 1)
    and (v ->> 'plan_profit')::numeric = (b ->> 'margin_estimated')::numeric, v::text || ' | ' || b::text);
  perform pg_temp.res('09 categories = the ledger categories (plan / expected / actual / flag); catering is well over the plan',
    jsonb_array_length(v -> 'categories') = jsonb_array_length(b -> 'by_category')
    and pg_temp.cat(v, 'food', 'plan')::numeric = 50000 and pg_temp.cat(v, 'food', 'expected')::numeric > 50000
    and pg_temp.cat(v, 'food', 'flag') = 'over'
    and pg_temp.cat(v, 'food', 'diff')::numeric = pg_temp.cat(v, 'food', 'expected')::numeric - 50000
    and (v -> 'gap_rule' ->> 'pct')::numeric = 10 and (v -> 'gap_rule' ->> 'abs')::numeric = 10000, v -> 'categories' ->> 0);
  perform pg_temp.res('10 reasons: the categories over the plan, biggest first, at most 2',
    jsonb_array_length(v -> 'reasons') between 1 and 2 and v -> 'reasons' -> 0 ->> 'key' = 'food'
    and (v -> 'reasons' -> 0 ->> 'amount')::numeric = pg_temp.cat(v, 'food', 'diff')::numeric, v ->> 'reasons');
  perform pg_temp.res('11 the admin sees the per-person crew lines (names)',
    not (v ->> 'pay_private')::boolean
    and exists (select 1 from jsonb_array_elements(v -> 'lines') l where l ->> 'source' = 'crew' and l ->> 'label' like '%Ravi R197%'),
    v ->> 'lines');
end $$;

-- traffic light: not set = 25 % target, 5 points band
do $$ declare v jsonb := pg_temp.get('v_open')::jsonb; m numeric; begin
  m := (v ->> 'margin_pct')::numeric;
  perform pg_temp.put('m', m::text);
  perform pg_temp.res('12 target not set = 25 %, band 5; the light follows green >= target, amber within 5, red beyond',
    (v ->> 'target_pct')::numeric = 25 and not (v ->> 'target_set')::boolean and (v ->> 'band')::numeric = 5
    and v ->> 'light' = case when (v ->> 'profit')::numeric < 0 then 'bad' when m >= 25 then 'good' when m >= 20 then 'warn' else 'bad' end
    and (v ->> 'gap_points')::numeric = round(25 - m, 1), v::text);
end $$;
-- the studio target (0242, Settings) moves the light: just above the margin = amber; 6 points above = red; at the margin = green
do $$ declare q uuid := 'a0000000-0000-4000-8000-00000000da01'; m numeric := pg_temp.get('m')::numeric; v1 jsonb; v2 jsonb; v3 jsonb; v4 jsonb; e text;
begin
  perform public.set_studio_target_margin(least(90, greatest(0, round(m + 1, 1))));
  v1 := public.event_money_header(q);
  perform public.set_studio_target_margin(least(90, greatest(0, round(m + 6, 1))));
  v2 := public.event_money_header(q);
  e := pg_temp.try('select public.money_settings_set(''{"margin_band": 8}''::jsonb)');
  v3 := public.event_money_header(q);
  perform public.set_studio_target_margin(least(90, greatest(0, floor(m))));
  v4 := public.event_money_header(q);
  perform pg_temp.res('13 studio target + band: target+1 = amber, target+6 = red, band 8 makes it amber, target <= margin = green',
    (v1 ->> 'target_set')::boolean and v1 ->> 'light' = 'warn' and v2 ->> 'light' = 'bad' and e = ''
    and (v3 ->> 'band')::numeric = 8 and v3 ->> 'light' = 'warn' and v4 ->> 'light' = 'good',
    m || ' ' || (v1 ->> 'light') || (v2 ->> 'light') || (v3 ->> 'light') || (v4 ->> 'light') || ' ' || e);
  -- leave target 30 / band 5 for the attention checks below
  perform public.set_studio_target_margin(90);
  perform public.money_settings_set('{"margin_band": 5}'::jsonb);
end $$;

-- Needs attention: red first; at most 3
do $$ declare q uuid := 'a0000000-0000-4000-8000-00000000da01'; v jsonb; k text; begin
  v := public.event_money_header(q); k := pg_temp.kinds(v);
  perform pg_temp.res('14 needs attention: at most 3, red first - catering bill due tomorrow, balance after the event, margin far below target',
    jsonb_array_length(v -> 'attention') = 3 and k = 'bill_due:bad,collect:bad,margin:bad'
    and v -> 'attention' -> 0 ->> 'who' = 'Royal Caterers' and (v -> 'attention' -> 0 ->> 'amount')::numeric = 70800
    and (v -> 'attention' -> 0 ->> 'days')::int = 1 and (v -> 'attention' -> 0 ->> 'count')::int = 2
    and (v -> 'attention' -> 1 ->> 'amount')::numeric = 118000 and v -> 'attention' -> 1 ->> 'label' = 'Balance'
    and (v -> 'attention' -> 2 ->> 'target')::numeric = 90, k || ' ' || (v ->> 'attention'));
end $$;

-- a Finance-view role that is not the admin: same numbers, one crew line, no names
select pg_temp.login('r197_mgr@a.test');
do $$ declare q uuid := 'a0000000-0000-4000-8000-00000000da01'; v jsonb; adm jsonb := pg_temp.get('v_open')::jsonb; begin
  v := pg_temp.j(format('select public.event_money_header(%L)', q));
  perform pg_temp.res('15 manager (Finance view): same profit, crew pay as ONE line, no person''s name or rate',
    public.has_area('finance', 'view') and (v ->> 'pay_private')::boolean and (v ->> 'profit')::numeric = (adm ->> 'profit')::numeric
    and (select count(*) from jsonb_array_elements(v -> 'lines') l where l ->> 'source' = 'crew') = 1
    and exists (select 1 from jsonb_array_elements(v -> 'lines') l where l ->> 'label' = 'Crew wages (2 people)')
    and position('R197' in (v -> 'lines')::text) = 0, coalesce(v::text, 'null'));
end $$;
select pg_temp.login('r197_coord@a.test');
do $$ begin
  perform pg_temp.res('16 a role without Settings edit cannot change the money rules (the wrapper checks before anything)',
    not public.has_area('controls', 'edit')
    and pg_temp.try('select public.money_settings_set(''{"margin_band": 3}''::jsonb)') like '42501%'
    and pg_temp.try('select public.money_settings_set(''{"gap_pct": 3}''::jsonb)') like '42501%');
end $$;

-- ---- money rules ----------------------------------------------------------------------------------------------------------------
select pg_temp.login('a_admin@a.test');
do $$ declare g jsonb; s jsonb; e1 text; e2 text; e3 text; n0 bigint; begin
  g := public.money_settings_get();
  perform pg_temp.su(); n0 := (select count(*) from public.audit_log where action = 'money_settings.changed'); perform pg_temp.login('a_admin@a.test');
  s := public.money_settings_set('{"margin_band": 3.5, "gap_pct": 12}'::jsonb);
  perform pg_temp.su(); n0 := (select count(*) from public.audit_log where action = 'money_settings.changed') - n0; perform pg_temp.login('a_admin@a.test');
  e1 := pg_temp.try('select public.money_settings_set(''{"margin_band": 51}''::jsonb)');
  e2 := pg_temp.try('select public.money_settings_set(''{"margin_band": "five"}''::jsonb)');
  e3 := pg_temp.try('select public.money_settings_set(''{"nope": 1}''::jsonb)');
  perform pg_temp.res('17 money rules: margin_band read + saved with the other rules (both audited), 0..50, a number, unknown keys still refused',
    (g ->> 'margin_band')::numeric = 5 and (g -> 'defaults' ->> 'margin_band')::numeric = 5 and (g ->> 'target_default')::numeric = 25
    and (s ->> 'margin_band')::numeric = 3.5 and (s ->> 'gap_pct')::numeric = 12 and (g ->> 'can_edit')::boolean
    and n0 = 2
    and e1 like '22023%' and e2 like '22023%' and e3 like '22023%unknown setting%', s::text || ' ' || e1 || ' ' || e2 || ' ' || e3);
  perform pg_temp.res('18 the kept 0372 bodies are server only; an empty patch still goes to the 0372 body',
    pg_temp.try('select public.money_settings_set__pre0376(''{}''::jsonb)') like '42501%'
    and pg_temp.try('select public.money_settings_get__pre0376()') like '42501%'
    and pg_temp.try('select public.money_settings_set(''{}''::jsonb)') = '');
  perform pg_temp.res('19 get_studio_target_margin: default 25 (was 30), the saved value still wins',
    (public.get_studio_target_margin() ->> 'default_pct')::int = 25 and (public.get_studio_target_margin() ->> 'target_margin_pct')::numeric = 90);
end $$;

-- ---- a closed event shows its frozen figure ------------------------------------------------------------------------------------
do $$ declare q uuid := 'a0000000-0000-4000-8000-00000000da01'; v0 jsonb; v1 jsonb; v2 jsonb; e text; begin
  perform public.set_studio_target_margin(25);
  perform pg_temp.su();
  insert into public.quote_payments(quote_id, amount, status, paid_at, org_id, provider, simulated)
    values (q, 118000, 'paid', now(), 'a0000000-0000-4000-8000-000000000001', 'manual', false);
  perform pg_temp.login('a_admin@a.test');
  v0 := public.event_money_header(q);
  e := pg_temp.try(format('select public.close_event(%L, true)', q));
  v1 := public.event_money_header(q);
  perform pg_temp.su();
  update public.crew_members set day_rate = 5000 where id = pg_temp.get('ravi')::uuid;   -- a rate changed after closing
  perform pg_temp.login('a_admin@a.test');
  v2 := public.event_money_header(q);
  perform pg_temp.res('20 closed: Frozen v1, costs are Actual, the frozen profit = the profit at close',
    e = '' and (v1 ->> 'closed')::boolean and (v1 -> 'frozen' ->> 'version')::int = 1 and v1 ->> 'cost_word' = 'actual'
    and (v1 ->> 'profit')::numeric = (v0 ->> 'profit')::numeric and not (v1 ->> 'live_differs')::boolean, e || ' ' || left(v1::text, 400));
  perform pg_temp.res('21 a rate changed after closing: profit + categories stay frozen, the live figure comes back as a note (live_profit)',
    (v2 ->> 'profit')::numeric = (v1 ->> 'profit')::numeric and (v2 ->> 'live_differs')::boolean
    and (v2 ->> 'live_profit')::numeric < (v1 ->> 'profit')::numeric
    and pg_temp.cat(v2, 'staff', 'expected') = pg_temp.cat(v1, 'staff', 'expected')
    and (v2 -> 'frozen' ->> 'version')::int = 1 and position('frozen_drift' in pg_temp.kinds(v2)) = 0,
    pg_temp.kinds(v2) || ' ' || left(v2::text, 400));
end $$;

-- ---- grants / definer / search_path ----------------------------------------------------------------------------------------------
select pg_temp.su();
do $$ begin
  perform pg_temp.res('22 grants: header + money rules for signed-in staff only; helpers + kept bodies server only; definer + empty search_path',
    has_function_privilege('authenticated', 'public.event_money_header(uuid)', 'execute')
    and not has_function_privilege('anon', 'public.event_money_header(uuid)', 'execute')
    and has_function_privilege('authenticated', 'public.money_settings_get()', 'execute')
    and has_function_privilege('authenticated', 'public.money_settings_set(jsonb)', 'execute')
    and not has_function_privilege('anon', 'public.money_settings_set(jsonb)', 'execute')
    and not has_function_privilege('authenticated', 'public._r376_target(uuid)', 'execute')
    and not has_function_privilege('authenticated', 'public._r376_lines(jsonb,boolean)', 'execute')
    and not has_function_privilege('authenticated', 'public.money_settings_set__pre0376(jsonb)', 'execute')
    and not has_function_privilege('authenticated', 'public.money_settings_get__pre0376()', 'execute')
    and has_function_privilege('authenticated', 'public.get_studio_target_margin()', 'execute')
    and (select bool_and(p.prosecdef and coalesce(p.proconfig, '{}') @> array['search_path=""']) from pg_proc p
          where p.oid in ('public.event_money_header(uuid)'::regprocedure, 'public.money_settings_get()'::regprocedure,
                          'public.money_settings_set(jsonb)'::regprocedure, 'public._r376_target(uuid)'::regprocedure,
                          'public.get_studio_target_margin()'::regprocedure)));
end $$;

select pg_temp.su();
\ir ../../supabase/migrations/0376_r197_event_money_header.sql

select name, result from _rm order by name;
select case when count(*) filter (where result <> 'PASS') = 0
            then 'R197-MONEY-HEADER-0376: ALL PASS (' || count(*) || '/' || count(*) || ')'
            else 'R197-MONEY-HEADER-0376: FAILURES (' || count(*) filter (where result <> 'PASS') || ' of ' || count(*) || ')' end as summary
  from _rm;
rollback;
