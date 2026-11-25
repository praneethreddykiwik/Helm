-- r260-vendor-items-0448.sql - R260 (25 Nov 2026): the items of a booked vendor are checked in on Pre-event and out on Wrap-up. Proves: structure after
-- two runs, no stored row changed, where the list comes from (booking, need, 0447 products, people are no items), all in one press, fewer / damaged with a
-- note, items that were not listed, the one question without a list, numbers, somebody else was faster, the same press twice, Undo, check-out on what came
-- in, Wrap-up's answer worked out (and the 0444 answer given later wins), what was missing / broken for Settlement, rights, other studio, anon, closed /
-- cancelled events, read-only studio, bookings / money / stock untouched. Local disposable PG only. Fake data only. Rolled back.
\set ON_ERROR_STOP 0
set client_min_messages = error;
begin;
create temp table _before as select (select md5(coalesce(string_agg(q::text, '|' order by q.id), '')) from public.quotes q) as qs,
  (select md5(coalesce(string_agg(r::text, '|' order by r.id), '')) from public.event_resources r) as rs, (select md5(coalesce(string_agg(c::text, '|' order by c.id), '')) from public.inventory_checkouts c) as cs,
  (select md5(coalesce(string_agg(d::text, '|' order by d.id), '')) from public.event_day d) as ds, (select md5(coalesce(string_agg(w::text, '|' order by w.id), '')) from public.event_wrap_records w) as ws;
\o /dev/null
\i supabase/migrations/0448_r260_vendor_items.sql
\i supabase/migrations/0448_r260_vendor_items.sql
\o
set client_min_messages = warning;
create temp table _rc(name text, result text); grant all on _rc to anon, authenticated, service_role;
create or replace function pg_temp.su() returns void language plpgsql as $$
begin execute 'reset role'; perform auth.logout(); execute 'reset role'; end $$;
create or replace function pg_temp.login(p_email text) returns void language plpgsql as $$
declare u uuid; begin
  perform pg_temp.su(); select id into u from auth.users where email = p_email;
  perform set_config('request.jwt.claims', jsonb_build_object('sub', u, 'role', 'authenticated', 'email', p_email, 'aal', 'aal1')::text, false);
  perform set_config('role', 'authenticated', false);
end $$;
create or replace function pg_temp.res(p_name text, p_ok boolean, p_detail text default '') returns void language plpgsql as $$
begin insert into _rc values (p_name, case when coalesce(p_ok, false) then 'PASS' else 'FAIL: ' || coalesce(p_detail, '') end); end $$;
create or replace function pg_temp.j(p_sql text) returns jsonb language plpgsql as $$
declare v jsonb; begin execute p_sql into v; return v; exception when others then return jsonb_build_object('err', sqlstate || ' ' || sqlerrm); end $$;
-- ids: booking 1 Chairs 120 - 2 DJ, no number - 3 Tent, only asked - 4 Waiters (a freelancer) - 5 a need of 8 (equipment) - 6 a need of 4 people - 7 Plates from the stock shortfall
create or replace function pg_temp.bk(p_n text, p_e text default '1') returns uuid language sql immutable as $$ select ('a0000000-0000-4000-8000-0000000b48' || p_e || p_n)::uuid $$;
create or replace function pg_temp.ev(p_e text default '1') returns uuid language sql immutable as $$ select ('a0000000-0000-4000-8000-0000000d448' || p_e)::uuid $$;
create or replace function pg_temp.k(p_label text) returns text language sql immutable as $$ select md5(lower(p_label)) $$;
create or replace function pg_temp.st(p_e text default '1') returns jsonb language sql as $$ select pg_temp.j(format('select public.event_vendor_items_get(%L)', pg_temp.ev(p_e))) $$;
create or replace function pg_temp.rec(p_e text default '1') returns jsonb language sql as $$ select pg_temp.j(format('select public.event_wrap_records_get(%L)', pg_temp.ev(p_e))) $$;
create or replace function pg_temp.vset(p_phase text, p_items jsonb, p_req uuid default null, p_q uuid default 'a0000000-0000-4000-8000-0000000d4481') returns jsonb language sql as $$
  select pg_temp.j(format('select public.event_vendor_items_set(%L, %L, %L::jsonb, %L)', p_q, p_phase, p_items, p_req)) $$;
-- one item of the state: { key, in, out, in_seen, ... }
create or replace function pg_temp.it(p_n text, p_label text) returns jsonb language sql as $$
  select x from jsonb_array_elements(pg_temp.st() #> array['vendors', pg_temp.bk(p_n)::text, 'items']) x where x ->> 'key' = pg_temp.k(p_label) $$;
create or replace function pg_temp.one(p_n text, p_label text, p_phase text, p_ok numeric, p_dmg numeric default 0, p_note text default null, p_seen text default 'now') returns jsonb language sql as $$
  select pg_temp.vset(p_phase, jsonb_build_array(jsonb_build_object('booking', pg_temp.bk(p_n), 'key', pg_temp.k(p_label), 'ok', p_ok, 'damaged', p_dmg, 'note', p_note,
    'seen', case when p_seen = 'now' then pg_temp.it(p_n, p_label) ->> (p_phase || '_seen') else p_seen end))) $$;
create or replace function pg_temp.undo(p_n text, p_key text, p_phase text, p_seen text) returns jsonb language sql as $$
  select pg_temp.vset(p_phase, jsonb_build_array(jsonb_build_object('booking', pg_temp.bk(p_n), 'key', p_key, 'undo', true, 'seen', p_seen))) $$;
grant execute on all functions in schema pg_temp to anon, authenticated, service_role;

select pg_temp.res('01 no stored row changed by the file (run twice)', (select b.qs = md5(coalesce((select string_agg(q::text, '|' order by q.id) from public.quotes q), ''))
  and b.rs = md5(coalesce((select string_agg(r::text, '|' order by r.id) from public.event_resources r), '')) and b.cs = md5(coalesce((select string_agg(c::text, '|' order by c.id) from public.inventory_checkouts c), ''))
  and b.ds = md5(coalesce((select string_agg(d::text, '|' order by d.id) from public.event_day d), '')) and b.ws = md5(coalesce((select string_agg(w::text, '|' order by w.id) from public.event_wrap_records w), '')) from _before b));
select pg_temp.res('02 the table is closed, the guards and the purge list are there', (select c.relrowsecurity and not has_table_privilege('authenticated', c.oid, 'select,insert,update,delete') and not has_table_privilege('service_role', c.oid, 'insert,update,delete')
  from pg_class c where c.oid = 'public.event_vendor_item_log'::regclass) and exists (select 1 from pg_trigger where tgname = 'zz_quote_org_match' and tgrelid = 'public.event_vendor_item_log'::regclass)
  and exists (select 1 from pg_trigger where tgname = 'zzz_studio_read_only' and tgrelid = 'public.event_vendor_item_log'::regclass)
  and (length(pg_get_functiondef('public._tr184_purge_tables()'::regprocedure)) - length(replace(pg_get_functiondef('public._tr184_purge_tables()'::regprocedure), '''event_vendor_item_log''', ''))) / length('''event_vendor_item_log''') = 1);

do $$ declare orgA uuid := 'a0000000-0000-4000-8000-000000000001'; u uuid; r record; begin
  for r in select * from (values ('a_view448@a.test', 'Vani Viewer', 'supervisor'), ('a_nov448@a.test', 'Nikhil NoVendors', 'quality'), ('a_set448@a.test', 'Sana Settles', 'sales'), ('a_none448@a.test', 'Nora None', 'operations')) x(m, n, rl) loop
    u := auth.seed_user(r.m);
    insert into public.profiles(id, email, full_name, role, org_id, must_change_password, created_at) values (u, r.m, r.n, r.rl, orgA, false, now())
    on conflict (id) do update set role = excluded.role, org_id = excluded.org_id, full_name = excluded.full_name;
  end loop;
  insert into public.role_access(role, area, can_view, can_edit, org_id, updated_at) values ('supervisor', 'command', true, false, orgA, now()), ('supervisor', 'vendors', true, true, orgA, now()),
    ('quality', 'command', true, true, orgA, now()), ('quality', 'vendors', false, false, orgA, now()), ('quality', 'settlement', false, false, orgA, now()), ('quality', 'finance', false, false, orgA, now()),
    ('sales', 'command', false, false, orgA, now()), ('sales', 'settlement', true, true, orgA, now()), ('sales', 'vendors', true, false, orgA, now()),
    ('operations', 'command', false, false, orgA, now()), ('operations', 'vendors', true, false, orgA, now()), ('operations', 'settlement', false, false, orgA, now()), ('operations', 'finance', false, false, orgA, now())
  on conflict (role, area, org_id) do update set can_view = excluded.can_view, can_edit = excluded.can_edit;
  for r in select * from (values ('1', 'event_day', 'confirmed'), ('2', 'closed', 'confirmed'), ('3', 'planning', 'cancelled')) x(n, stage, st) loop
    insert into public.quotes(id, code, title, status, client, pricing, current_version, approval_status, org_id, created_at, updated_at, event_date, lifecycle_stage)
    values (pg_temp.ev(r.n), 'A-448' || r.n, 'E' || r.n, 'confirmed', '{}'::jsonb, '{}'::jsonb, 1, 'approved', orgA, now(), now(), current_date, 'planning');
    insert into public.event_resource_needs(id, quote_id, kind, label, qty, org_id) values (('a0000000-0000-4000-8000-0000000e48' || r.n || '5')::uuid, pg_temp.ev(r.n), 'other', 'Fog machines', 8, orgA), (('a0000000-0000-4000-8000-0000000e48' || r.n || '6')::uuid, pg_temp.ev(r.n), 'staff', 'Valets', 4, orgA);
    insert into public.event_resources(id, quote_id, label, qty, cost, status, kind, need_id, org_id) values (pg_temp.bk('1', r.n), pg_temp.ev(r.n), 'Chairs', 120, 9000, 'confirmed', 'rental', null, orgA),
      (pg_temp.bk('2', r.n), pg_temp.ev(r.n), 'DJ', null, 5000, 'booked', 'vendor', null, orgA), (pg_temp.bk('3', r.n), pg_temp.ev(r.n), 'Tent', 2, null, 'enquiry', 'rental', null, orgA),
      (pg_temp.bk('4', r.n), pg_temp.ev(r.n), 'Waiters', 6, 600, 'booked', 'freelancer', null, orgA), (pg_temp.bk('5', r.n), pg_temp.ev(r.n), 'Fog machines', null, 100, 'booked', 'rental', ('a0000000-0000-4000-8000-0000000e48' || r.n || '5')::uuid, orgA),
      (pg_temp.bk('6', r.n), pg_temp.ev(r.n), 'Valets', 4, 100, 'booked', 'vendor', ('a0000000-0000-4000-8000-0000000e48' || r.n || '6')::uuid, orgA), (pg_temp.bk('7', r.n), pg_temp.ev(r.n), 'Plates  (stock shortfall)', 12.5, 100, 'booked', 'rental', null, orgA);
    update public.quotes set lifecycle_stage = r.stage, status = r.st where id = pg_temp.ev(r.n);
  end loop;
  insert into public.event_day(quote_id, kind, who, role, ref_id, status, org_id) values (pg_temp.ev('1'), 'arrival', 'Waiters', 'vendor', pg_temp.bk('4'), 'no_show', orgA);
end $$;
create temp table _bk as select (select md5(string_agg(r::text, '|' order by r.id)) from public.event_resources r) as m, (select md5(string_agg(c::text, '|' order by c.id)) from public.inventory_checkouts c) as c, (select md5(string_agg(c::text, '|' order by c.id)) from public.event_costs c) as k; grant all on _bk to authenticated;

select pg_temp.login('a_admin@a.test');
select pg_temp.res('03 the list: booking, need, shortfall name cleaned; no number / people / only asked = none', (select jsonb_array_length(s #> array['vendors', pg_temp.bk('1')::text, 'items']) = 1
  and s #>> array['vendors', pg_temp.bk('1')::text, 'items', '0', 'label'] = 'Chairs' and (s #>> array['vendors', pg_temp.bk('1')::text, 'items', '0', 'expected'])::numeric = 120 and s #> array['vendors', pg_temp.bk('1')::text, 'items', '0', 'in'] = 'null'::jsonb
  and s #> array['vendors', pg_temp.bk('2')::text, 'items'] = '[]'::jsonb and not (s -> 'vendors') ? pg_temp.bk('3')::text and s #> array['vendors', pg_temp.bk('4')::text, 'items'] = '[]'::jsonb and s #>> array['vendors', pg_temp.bk('4')::text, 'arrival'] = 'no_show'
  and (s #>> array['vendors', pg_temp.bk('5')::text, 'items', '0', 'expected'])::numeric = 8 and s #> array['vendors', pg_temp.bk('6')::text, 'items'] = '[]'::jsonb
  and s #>> array['vendors', pg_temp.bk('7')::text, 'items', '0', 'label'] = 'Plates' and (s #>> array['vendors', pg_temp.bk('7')::text, 'items', '0', 'expected'])::numeric = 12.5
  and s ->> 'can_edit' = 'true' and s ->> 'closed' = 'false' and s ->> 'full' = 'true' from pg_temp.st() s), pg_temp.st()::text);
create temp table _a as select pg_temp.vset('in', jsonb_build_array(jsonb_build_object('booking', pg_temp.bk('1'), 'key', pg_temp.k('chairs'), 'ok', 120), jsonb_build_object('booking', pg_temp.bk('5'), 'key', pg_temp.k('fog machines'), 'ok', 8, 'damaged', 0)), 'a0000000-0000-4000-8000-00000000e481') as v; grant all on _a to authenticated;
select pg_temp.res('04 all arrived in one press: two vendors, who and when', (select v ->> 'ok' = 'true' and v #>> array['state', 'vendors', pg_temp.bk('1')::text, 'items', '0', 'in', 'state'] = 'ok' and (v #>> array['state', 'vendors', pg_temp.bk('5')::text, 'items', '0', 'in', 'ok'])::numeric = 8
  and coalesce(v #>> array['state', 'vendors', pg_temp.bk('1')::text, 'items', '0', 'in', 'by'], '') <> '' and v #>> array['state', 'vendors', pg_temp.bk('1')::text, 'items', '0', 'in', 'at'] is not null from _a), (select v::text from _a));
select pg_temp.res('05 the same press twice writes nothing', pg_temp.vset('in', jsonb_build_array(jsonb_build_object('booking', pg_temp.bk('1'), 'key', pg_temp.k('chairs'), 'ok', 1, 'note', 'x')), 'a0000000-0000-4000-8000-00000000e481') ->> 'same' = 'true' and (pg_temp.it('1', 'chairs') #>> '{in,ok}')::numeric = 120);
select pg_temp.res('06 somebody else was faster: nothing is written (not even the other item), the new state comes back', (select x ->> 'ok' = 'false' and x ->> 'changed' = 'true' and x #>> array['state', 'vendors', pg_temp.bk('1')::text, 'items', '0', 'in', 'state'] = 'ok'
    from pg_temp.vset('in', jsonb_build_array(jsonb_build_object('booking', pg_temp.bk('7'), 'key', pg_temp.k('plates'), 'ok', 12.5), jsonb_build_object('booking', pg_temp.bk('1'), 'key', pg_temp.k('chairs'), 'ok', 100, 'note', 'less'))) x)
  and pg_temp.it('7', 'plates') -> 'in' = 'null'::jsonb);
select pg_temp.res('07 fewer or damaged needs a note; text is cleaned and checked', pg_temp.one('7', 'plates', 'in', 10) ->> 'err' like '22023 Plates: write a short note%' and pg_temp.one('7', 'plates', 'in', 12, 0.5) ->> 'err' like '22023 Plates: write%' and pg_temp.one('7', 'plates', 'in', 10, 0, '   ') ->> 'err' like '22023 Plates: write%'
  and pg_temp.one('7', 'plates', 'in', 10, 0, '<b>x</b>') ->> 'err' like '22023 Leave out%' and pg_temp.one('7', 'plates', 'in', 10, 0, repeat('n', 301)) ->> 'err' like '22023 Use up to 300%');
select pg_temp.res('08 numbers: below 0, 3 decimals, text, 10 times too many are refused', pg_temp.one('7', 'plates', 'in', -1, 0, 'x') ->> 'err' like '22023 Use numbers%' and pg_temp.one('7', 'plates', 'in', 1.005, 0, 'x') ->> 'err' like '22023 Use numbers%' and pg_temp.one('7', 'plates', 'in', 125.01) ->> 'err' like '22023 Plates: that is far more%'
  and pg_temp.vset('in', jsonb_build_array(jsonb_build_object('booking', pg_temp.bk('7'), 'key', pg_temp.k('plates'), 'ok', '12'))) ->> 'err' like '22023 Type how many%' and pg_temp.one('7', 'plates', 'in', 5, -2, 'x') ->> 'err' like '22023 Use numbers%');
select pg_temp.res('09 10 fine, 1 damaged of 12.5: 1.5 missing is worked out', (select (x #>> '{in,ok}')::numeric = 10 and (x #>> '{in,damaged}')::numeric = 1 and (x #>> '{in,missing}')::numeric = 1.5 and x #>> '{in,state}' = 'missing' and x #>> '{in,note}' = 'one box short'
    from (select pg_temp.one('7', 'plates', 'in', 10, 1, ' one   box short ') as r) z, lateral (select pg_temp.it('7', 'plates') as x where z.r ->> 'ok' = 'true') y));
create temp table _u as select pg_temp.undo('7', pg_temp.k('plates'), 'in', pg_temp.it('7', 'plates') ->> 'in_seen') as v; grant all on _u to authenticated;
select pg_temp.res('10 Undo is a row; undone twice = nothing more; more than expected is fine', (select v ->> 'ok' = 'true' from _u) and pg_temp.it('7', 'plates') -> 'in' = 'null'::jsonb and pg_temp.undo('7', pg_temp.k('plates'), 'in', pg_temp.it('7', 'plates') ->> 'in_seen') ->> 'same' = 'true'
  and pg_temp.one('7', 'plates', 'in', 15) ->> 'ok' = 'true' and pg_temp.it('7', 'plates') #>> '{in,state}' = 'ok' and (pg_temp.it('7', 'plates') #>> '{in,missing}')::numeric = 0);
select pg_temp.res('11 an item that was not listed is added as arrived; twice the same name, no number, no name, in check-out: refused',
  pg_temp.vset('in', jsonb_build_array(jsonb_build_object('booking', pg_temp.bk('1'), 'label', ' Chair  covers ', 'qty', 130))) ->> 'ok' = 'true' and (pg_temp.it('1', 'chair covers') #>> '{in,ok}')::numeric = 130 and pg_temp.it('1', 'chair covers') ->> 'listed' = 'false'
  and pg_temp.vset('in', jsonb_build_array(jsonb_build_object('booking', pg_temp.bk('1'), 'label', 'CHAIR COVERS', 'qty', 1))) ->> 'err' like '22023 CHAIR COVERS is already%' and pg_temp.vset('in', jsonb_build_array(jsonb_build_object('booking', pg_temp.bk('1'), 'label', 'chairs', 'qty', 1))) ->> 'err' like '22023 chairs is already%'
  and pg_temp.vset('in', jsonb_build_array(jsonb_build_object('booking', pg_temp.bk('1'), 'label', 'Ropes', 'qty', 0))) ->> 'err' like '22023 How many%' and pg_temp.vset('in', jsonb_build_array(jsonb_build_object('booking', pg_temp.bk('1'), 'label', '  ', 'qty', 2))) ->> 'err' like '22023 Write what came%'
  and pg_temp.vset('out', jsonb_build_array(jsonb_build_object('booking', pg_temp.bk('1'), 'label', 'Ropes', 'qty', 2))) ->> 'err' like '22023 invalid_item%');
select pg_temp.res('12 an added item that is undone leaves the list', pg_temp.vset('in', jsonb_build_array(jsonb_build_object('booking', pg_temp.bk('1'), 'label', 'Wrong one', 'qty', 1))) ->> 'ok' = 'true'
  and pg_temp.undo('1', pg_temp.k('wrong one'), 'in', pg_temp.it('1', 'wrong one') ->> 'in_seen') ->> 'ok' = 'true' and pg_temp.it('1', 'wrong one') is null);
select pg_temp.res('13 up to 60 items per vendor', pg_temp.vset('in', (select jsonb_agg(jsonb_build_object('booking', pg_temp.bk('5'), 'label', 'Part ' || g, 'qty', 1)) from generate_series(1, 60) g)) ->> 'err' like '22023 A vendor can have up to 60%'
  and pg_temp.vset('in', (select jsonb_agg(jsonb_build_object('booking', pg_temp.bk('5'), 'label', 'Part ' || g, 'qty', 1)) from generate_series(1, 201) g)) ->> 'err' like '22023 Choose%' and pg_temp.it('5', 'part 1') is null);
select pg_temp.res('14 without a list: one question, missing needs a note, Undo', pg_temp.vset('in', jsonb_build_array(jsonb_build_object('booking', pg_temp.bk('2'), 'key', '*', 'answer', 'missing'))) ->> 'err' like '22023 Write a short note%'
  and pg_temp.vset('in', jsonb_build_array(jsonb_build_object('booking', pg_temp.bk('2'), 'key', '*', 'answer', 'damaged', 'note', 'one speaker hums'))) ->> 'ok' = 'true' and pg_temp.st() #>> array['vendors', pg_temp.bk('2')::text, 'all', 'state'] = 'damaged'
  and pg_temp.undo('2', '*', 'in', pg_temp.st() #>> array['vendors', pg_temp.bk('2')::text, 'all_seen']) ->> 'ok' = 'true' and pg_temp.st() #> array['vendors', pg_temp.bk('2')::text, 'all'] = 'null'::jsonb
  and pg_temp.vset('in', jsonb_build_array(jsonb_build_object('booking', pg_temp.bk('2'), 'key', '*', 'answer', 'ok', 'seen', pg_temp.st() #>> array['vendors', pg_temp.bk('2')::text, 'all_seen']))) ->> 'ok' = 'true'
  and pg_temp.vset('out', jsonb_build_array(jsonb_build_object('booking', pg_temp.bk('2'), 'key', '*', 'answer', 'ok'))) ->> 'err' like '22023 invalid_item%');
select pg_temp.res('15 not on the list, twice in one press, a strange field, only asked, unknown vendor: refused', pg_temp.one('1', 'sofas', 'in', 1) ->> 'err' like 'P0002 This item%' and pg_temp.vset('in', jsonb_build_array(jsonb_build_object('booking', pg_temp.bk('3'), 'label', 'x', 'qty', 1))) ->> 'err' like '22023 This vendor is not booked%'
  and pg_temp.vset('in', jsonb_build_array(jsonb_build_object('booking', pg_temp.bk('5'), 'label', 'x', 'qty', 1), jsonb_build_object('booking', pg_temp.bk('5'), 'label', 'X', 'qty', 1))) ->> 'err' like '22023 The same item%'
  and pg_temp.vset('in', jsonb_build_array(jsonb_build_object('booking', pg_temp.bk('5'), 'label', 'x', 'qty', 1, 'cost', 5))) ->> 'err' like '22023 unknown field%' and pg_temp.vset('in', jsonb_build_array(jsonb_build_object('booking', gen_random_uuid(), 'label', 'x', 'qty', 1))) ->> 'err' like 'P0002%'
  and pg_temp.vset('in', jsonb_build_array(jsonb_build_object('booking', 'nope', 'label', 'x', 'qty', 1))) ->> 'err' like '22023 invalid_item%');
-- check out
select pg_temp.res('16 Wrap-up has no answer while nothing is checked out', not (pg_temp.rec() -> 'vendor') ? pg_temp.bk('1')::text);
select pg_temp.res('17 back = what came in: 15 plates came (of 12.5), 16 back is refused, 15 is all', pg_temp.one('7', 'plates', 'out', 16) ->> 'err' like '22023 Plates: only 15 came in%' and pg_temp.one('7', 'plates', 'out', 15) ->> 'ok' = 'true' and pg_temp.it('7', 'plates') #>> '{out,state}' = 'ok'
  and pg_temp.rec() #>> array['vendor', pg_temp.bk('7')::text, 'state'] = 'returned' and pg_temp.rec() #>> array['vendor', pg_temp.bk('7')::text, 'items'] = 'true' and (pg_temp.rec() #>> array['vendor', pg_temp.bk('7')::text, 'qty_back'])::numeric = 15);
select pg_temp.res('18 a checked-out item: its check-in cannot be changed under it', pg_temp.undo('7', pg_temp.k('plates'), 'in', pg_temp.it('7', 'plates') ->> 'in_seen') ->> 'err' like '22023 Plates is already checked out%');
select pg_temp.res('19 119 back of 120, 1 missing: an answer at once, with the note; the other item is still open', pg_temp.one('1', 'chairs', 'out', 118, 1) ->> 'err' like '22023 Chairs: write%' and pg_temp.one('1', 'chairs', 'out', 118, 1, 'one lost, one leg broken') ->> 'ok' = 'true'
  and (select x ->> 'state' = 'not_returned' and x ->> 'note' = 'Chairs: 1 not returned, 1 broken - one lost, one leg broken' and x -> 'qty_total' = 'null'::jsonb from (select pg_temp.rec() #> array['vendor', pg_temp.bk('1')::text] as x) y), (pg_temp.rec() #> array['vendor', pg_temp.bk('1')::text])::text);
select pg_temp.res('20 all checked out: n of m over all items', pg_temp.one('1', 'chair covers', 'out', 130) ->> 'ok' = 'true' and (select (x ->> 'qty_total')::numeric = 250 and (x ->> 'qty_back')::numeric = 249 and x ->> 'state' = 'not_returned' from (select pg_temp.rec() #> array['vendor', pg_temp.bk('1')::text] as x) y));
select pg_temp.res('21 the 0444 answer given later wins, its Undo brings the worked-out one back', (select x ->> 'ok' = 'true' from pg_temp.j(format('select public.event_vendor_return_set(%L, %L, %L, null, null, null, null)', pg_temp.ev(), pg_temp.bk('1'), 'returned')) x)
  and pg_temp.rec() #>> array['vendor', pg_temp.bk('1')::text, 'state'] = 'returned' and not (pg_temp.rec() #> array['vendor', pg_temp.bk('1')::text]) ? 'items'
  and (select x ->> 'ok' = 'true' from pg_temp.j(format('select public.event_vendor_return_set(%L, %L, %L, null, null, %L, null)', pg_temp.ev(), pg_temp.bk('1'), 'undo', pg_temp.rec() #>> array['vendor', pg_temp.bk('1')::text, 'id'])) x)
  and pg_temp.rec() #>> array['vendor', pg_temp.bk('1')::text, 'state'] = 'not_returned' and (pg_temp.rec() #> array['vendor', pg_temp.bk('1')::text]) ? 'items');
select pg_temp.res('22 what was wrong is listed (in + out) with the notes', (select jsonb_array_length(x) = 1 and x #>> '{0,phase}' = 'out' and (x #>> '{0,missing}')::numeric = 1 and (x #>> '{0,damaged}')::numeric = 1 from (select pg_temp.st() #> array['vendors', pg_temp.bk('1')::text, 'problems'] as x) y));
select pg_temp.res('23 bookings, stock out and costs are untouched', (select m = (select md5(string_agg(r::text, '|' order by r.id)) from public.event_resources r) and c is not distinct from (select md5(string_agg(r::text, '|' order by r.id)) from public.inventory_checkouts r) from _bk));
-- the 0447 products (the column / table are made here when 0447 is not on this database yet)
select pg_temp.su();
alter table public.vendor_requests add column if not exists lines jsonb;
create table if not exists public.vendor_offers (id uuid primary key default gen_random_uuid(), seq bigint generated always as identity, org_id uuid, quote_id uuid, request_id uuid, mode text, lines jsonb, total numeric, status text);
insert into public.vendor_requests(id, org_id, quote_id, vendor_name, booking_id, what, when_at, agreed_amount, respond_by, status, lines) values
  ('a0000000-0000-4000-8000-00000000f481', 'a0000000-0000-4000-8000-000000000001', pg_temp.ev(), 'DJ Arun', pg_temp.bk('2'), 'DJ', now() + interval '1 day', 0, now() + interval '2 hours', 'accepted',
   '[{"id":"l1","name":"Speakers","unit":"pcs","qty":4,"price":500},{"id":"l2","name":"speakers ","qty":2},{"id":"l3","name":"Mixer","qty":1},{"id":"l4","name":"Not sent","qty":0}]');
select pg_temp.login('a_admin@a.test');
select pg_temp.res('24 the products of the accepted request are the list (same name added up, 0 left out, no price); the old answer stays', (select jsonb_array_length(x -> 'items') = 2 and (pg_temp.it('2', 'speakers') ->> 'expected')::numeric = 6 and (pg_temp.it('2', 'mixer') ->> 'expected')::numeric = 1 and x #>> '{all,state}' = 'ok' and x::text not like '%price%'
  from (select pg_temp.st() #> array['vendors', pg_temp.bk('2')::text] as x) y), (pg_temp.st() #> array['vendors', pg_temp.bk('2')::text])::text);
select pg_temp.su();
insert into public.vendor_offers(org_id, quote_id, request_id, mode, lines, total, status) values ('a0000000-0000-4000-8000-000000000001', pg_temp.ev(), 'a0000000-0000-4000-8000-00000000f481', 'lines', '[{"id":"l1","name":"Speakers","qty":5},{"id":"l3","name":"Mixer","qty":0}]', 10, 'approved');
select pg_temp.login('a_admin@a.test');
select pg_temp.res('25 the approved answer decides how many', (pg_temp.it('2', 'speakers') ->> 'expected')::numeric = 5 and pg_temp.it('2', 'mixer') is null and pg_temp.one('2', 'speakers', 'in', 5) ->> 'ok' = 'true');
select pg_temp.res('26 closed and cancelled events take nothing and say so', pg_temp.vset('in', jsonb_build_array(jsonb_build_object('booking', pg_temp.bk('1', '2'), 'key', pg_temp.k('chairs'), 'ok', 120)), null, pg_temp.ev('2')) ->> 'err' like '22023 This event is closed%'
  and pg_temp.vset('out', jsonb_build_array(jsonb_build_object('booking', pg_temp.bk('1', '3'), 'key', pg_temp.k('chairs'), 'ok', 120)), null, pg_temp.ev('3')) ->> 'err' like '22023 This event is closed%' and pg_temp.st('2') ->> 'closed' = 'true' and pg_temp.st('2') ->> 'can_edit' = 'false');
select pg_temp.login('a_view448@a.test');
select pg_temp.res('27 without Event-day command edit: can see, cannot press; without Vendors view: neither', pg_temp.one('5', 'fog machines', 'out', 8) ->> 'err' like '42501%' and pg_temp.st() ->> 'can_edit' = 'false' and pg_temp.st() ->> 'full' = 'true');
select pg_temp.login('a_nov448@a.test');
select pg_temp.res('27b no Vendors view', pg_temp.st() ->> 'err' like '42501%' and pg_temp.vset('in', jsonb_build_array(jsonb_build_object('booking', pg_temp.bk('1'), 'key', pg_temp.k('chairs'), 'ok', 1, 'note', 'x'))) ->> 'err' like '42501%' and pg_temp.rec() -> 'vendor' = 'null'::jsonb);
select pg_temp.login('a_set448@a.test');
select pg_temp.res('28 Settlement sees only what was missing or broken', (select s ->> 'full' = 'false' and (s #> array['vendors', pg_temp.bk('1')::text]) ? 'problems' and not (s #> array['vendors', pg_temp.bk('1')::text]) ? 'items' and not (s -> 'vendors') ? pg_temp.bk('5')::text from pg_temp.st() s)
  and pg_temp.vset('in', jsonb_build_array(jsonb_build_object('booking', pg_temp.bk('1'), 'key', pg_temp.k('chairs'), 'ok', 1, 'note', 'x'))) ->> 'err' like '42501%', pg_temp.st()::text);
select pg_temp.login('a_none448@a.test');
select pg_temp.res('29 neither Event-day command nor money: nothing; another studio: not found; the same press id of another event: refused', pg_temp.st() ->> 'err' like '42501%');
select pg_temp.login('b_admin@b.test');
select pg_temp.res('29b another studio sees and writes nothing', pg_temp.st() ->> 'err' like 'P0002%' and pg_temp.vset('in', jsonb_build_array(jsonb_build_object('booking', pg_temp.bk('1'), 'key', pg_temp.k('chairs'), 'ok', 1, 'note', 'x'))) ->> 'err' like 'P0002%');
select pg_temp.su(); set role anon;
select pg_temp.res('30 not signed in: refused; the table cannot be read or written directly', pg_temp.st() ->> 'err' like '42501%' and pg_temp.vset('in', '[{"booking":"x"}]'::jsonb) ->> 'err' like '42501%');
reset role; set role authenticated;
select pg_temp.res('30b no direct access', pg_temp.j('with x as (select count(*) c from public.event_vendor_item_log) select to_jsonb(c) from x') ->> 'err' like '42501%' and pg_temp.j('select public._r448_src(gen_random_uuid(), gen_random_uuid()) is null') ->> 'err' like '42501%');
reset role;
select pg_temp.su();
select name, result from _rc where result <> 'PASS' order by name;
select 'R260-VENDOR-ITEMS-0448: ' || case when count(*) filter (where result <> 'PASS') = 0 then 'ALL PASS' else 'FAIL' end || ' (' || count(*) filter (where result = 'PASS') || '/' || count(*) || ')' from _rc;
rollback;
