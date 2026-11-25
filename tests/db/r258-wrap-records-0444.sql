-- r258-wrap-records-0444.sql - R258 (25 Nov 2026): Wrap-up keeps whether a vendor's items were handed back (all / not / with a problem + note, who,
-- when, Undo) and the notes of a stock problem. Proves: structure after two runs, no stored row changed, the three answers with a quantity, the note
-- rule, somebody else was faster, the same press twice, Undo, history kept, booking + money untouched, rights (viewer, no vendors, other studio, anon),
-- closed / cancelled / asked-only refused, stock notes, the tables are closed. Local disposable PG only. Fake data only. Rolled back.
\set ON_ERROR_STOP 0
set client_min_messages = error;
begin;
create temp table _before as select (select md5(coalesce(string_agg(q::text, '|' order by q.id), '')) from public.quotes q) as qs,
  (select md5(coalesce(string_agg(r::text, '|' order by r.id), '')) from public.event_resources r) as rs, (select md5(coalesce(string_agg(c::text, '|' order by c.id), '')) from public.inventory_checkouts c) as cs,
  (select md5(coalesce(string_agg(d::text, '|' order by d.id), '')) from public.event_day d) as ds;
\o /dev/null
\i supabase/migrations/0444_r258_wrap_records.sql
\i supabase/migrations/0444_r258_wrap_records.sql
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
grant execute on all functions in schema pg_temp to anon, authenticated, service_role;

select pg_temp.res('01 no stored row changed by the file (run twice)', (select b.qs = md5(coalesce((select string_agg(q::text, '|' order by q.id) from public.quotes q), ''))
  and b.rs = md5(coalesce((select string_agg(r::text, '|' order by r.id) from public.event_resources r), '')) and b.cs = md5(coalesce((select string_agg(c::text, '|' order by c.id) from public.inventory_checkouts c), ''))
  and b.ds = md5(coalesce((select string_agg(d::text, '|' order by d.id) from public.event_day d), '')) from _before b));
select pg_temp.res('02 the table is closed, the guards and the purge list are there', (select c.relrowsecurity and not has_table_privilege('authenticated', c.oid, 'select,insert,update,delete') and not has_table_privilege('service_role', c.oid, 'insert,update,delete')
  from pg_class c where c.oid = 'public.event_wrap_records'::regclass) and exists (select 1 from pg_trigger where tgname = 'zz_quote_org_match' and tgrelid = 'public.event_wrap_records'::regclass)
  and position('event_wrap_records' in pg_get_functiondef('public._tr184_purge_tables()'::regprocedure)) > 0);

-- fixture: studio A, an open event with 4 bookings, a closed and a cancelled one; stock out
do $$ declare orgA uuid := 'a0000000-0000-4000-8000-000000000001'; u_view uuid; u_nov uuid; r record; begin
  u_view := auth.seed_user('a_view444@a.test'); u_nov := auth.seed_user('a_nov444@a.test');
  insert into public.profiles(id, email, full_name, role, org_id, must_change_password, created_at) values
    (u_view, 'a_view444@a.test', 'Vani Viewer', 'supervisor', orgA, false, now()), (u_nov, 'a_nov444@a.test', 'Nikhil NoVendors', 'quality', orgA, false, now())
  on conflict (id) do update set role = excluded.role, org_id = excluded.org_id, full_name = excluded.full_name;
  insert into public.role_access(role, area, can_view, can_edit, org_id, updated_at) values ('supervisor', 'command', true, false, orgA, now()), ('supervisor', 'vendors', true, true, orgA, now()), ('supervisor', 'inventory', false, false, orgA, now()),
    ('quality', 'command', true, true, orgA, now()), ('quality', 'vendors', false, false, orgA, now()), ('quality', 'inventory', false, false, orgA, now())
  on conflict (role, area, org_id) do update set can_view = excluded.can_view, can_edit = excluded.can_edit;
  for r in select * from (values ('1', 'event_day', 'confirmed'), ('2', 'closed', 'confirmed'), ('3', 'planning', 'cancelled')) x(n, stage, st) loop
    insert into public.quotes(id, code, title, status, client, pricing, current_version, approval_status, org_id, created_at, updated_at, event_date, lifecycle_stage)
    values (('a0000000-0000-4000-8000-0000000d444' || r.n)::uuid, 'A-444' || r.n, 'E' || r.n, 'confirmed', '{}'::jsonb, '{}'::jsonb, 1, 'approved', orgA, now(), now(), current_date, 'planning');
    insert into public.event_resources(id, quote_id, label, qty, cost, status, org_id) values (('a0000000-0000-4000-8000-0000000b44' || r.n || '1')::uuid, ('a0000000-0000-4000-8000-0000000d444' || r.n)::uuid, 'Chairs', 120, 9000, 'confirmed', orgA),
      (('a0000000-0000-4000-8000-0000000b44' || r.n || '2')::uuid, ('a0000000-0000-4000-8000-0000000d444' || r.n)::uuid, 'DJ', null, 5000, 'booked', orgA),
      (('a0000000-0000-4000-8000-0000000b44' || r.n || '3')::uuid, ('a0000000-0000-4000-8000-0000000d444' || r.n)::uuid, 'Tent', 2, null, 'enquiry', orgA);
    update public.quotes set lifecycle_stage = r.stage, status = r.st where id = ('a0000000-0000-4000-8000-0000000d444' || r.n)::uuid;
  end loop;
  insert into public.inventory_items(id, name, total_qty, org_id) values ('a0000000-0000-4000-8000-00000000f444', 'Uplight', 50, orgA);
  insert into public.inventory_checkouts(id, item_id, quote_id, qty_out, issued_to, org_id) values ('a0000000-0000-4000-8000-00000000c441', 'a0000000-0000-4000-8000-00000000f444', 'a0000000-0000-4000-8000-0000000d4441', 5, 'Ravi', orgA),
    ('a0000000-0000-4000-8000-00000000c442', 'a0000000-0000-4000-8000-00000000f444', null, 1, 'Ravi', orgA);
end $$;
\set Q '\'a0000000-0000-4000-8000-0000000d4441\''
\set B1 '\'a0000000-0000-4000-8000-0000000b4411\''
\set B2 '\'a0000000-0000-4000-8000-0000000b4412\''
create temp table _bk as select md5(string_agg(r::text, '|' order by r.id)) as m from public.event_resources r; grant all on _bk to authenticated;
create or replace function pg_temp.vset(p_b uuid, p_s text, p_note text default null, p_back numeric default null, p_seen uuid default null, p_id uuid default null, p_q uuid default 'a0000000-0000-4000-8000-0000000d4441')
returns jsonb language sql as $f$ select pg_temp.j(format('select public.event_vendor_return_set(%L, %L, %L, %L, %L, %L, %L)', p_q, p_b, p_s, p_note, p_back, p_seen, p_id)) $f$;
grant execute on all functions in schema pg_temp to anon, authenticated, service_role;

select pg_temp.login('a_admin@a.test');
create temp table _a as select pg_temp.vset(:B1, 'returned', null, 5, null, 'a0000000-0000-4000-8000-00000000e441') as v; grant all on _a to authenticated;
select pg_temp.res('03 all returned: who, when, the whole quantity (a count sent with it is not used)', (select (v ->> 'ok') = 'true' and v #>> '{item,state}' = 'returned' and (v #>> '{item,qty_back}')::numeric = 120 and (v #>> '{item,qty_total}')::numeric = 120
  and coalesce(v #>> '{item,by}', '') <> '' and v #>> '{item,at}' is not null and v #>> '{item,label}' = 'Chairs' from _a), (select v::text from _a));
select pg_temp.res('04 the same press twice is one row', (pg_temp.vset(:B1, 'returned', null, null, null, 'a0000000-0000-4000-8000-00000000e441') ->> 'same') = 'true'
  and jsonb_array_length(pg_temp.j(format('select public.event_wrap_records_get(%L)', :Q)) -> 'log') = 1);
select pg_temp.res('05 somebody else was faster: nothing is written, the newer answer comes back', (select (x ->> 'ok') = 'false' and (x ->> 'changed') = 'true' and x #>> '{item,state}' = 'returned' from pg_temp.vset(:B1, 'problem', 'two broken') x)
  and jsonb_array_length(pg_temp.j(format('select public.event_wrap_records_get(%L)', :Q)) -> 'log') = 1);
select pg_temp.res('06 not returned and a problem need a note', pg_temp.vset(:B2, 'not_returned') ->> 'err' like '22023 Write a short note%' and pg_temp.vset(:B2, 'problem', '   ') ->> 'err' like '22023 Write a short note%'
  and pg_temp.vset(:B2, 'problem', '<b>x</b>') ->> 'err' like '22023 Leave out%' and pg_temp.vset(:B2, 'problem', repeat('n', 501)) ->> 'err' like '22023%' and pg_temp.vset(:B2, 'lost', 'x') ->> 'err' like '22023%');
select pg_temp.res('07 a problem: n of m and the note; more than the booking has is refused', (select x #>> '{item,state}' = 'problem' and (x #>> '{item,qty_back}')::numeric = 118 and x #>> '{item,note}' = 'two legs broken'
    from pg_temp.vset(:B1, 'problem', '  two   legs broken ', 118, 'a0000000-0000-4000-8000-00000000e441') x)
  and pg_temp.vset(:B1, 'problem', 'x', 121, (pg_temp.j(format('select public.event_wrap_records_get(%L)', :Q)) #>> array['vendor', :B1, 'id'])::uuid) ->> 'err' like '22023 Between 0 and 120%'
  and pg_temp.vset(:B1, 'problem', 'x', -1, (pg_temp.j(format('select public.event_wrap_records_get(%L)', :Q)) #>> array['vendor', :B1, 'id'])::uuid) ->> 'err' like '22023 Between 0%');
select pg_temp.res('08 a booking with no quantity keeps no count', (select x #>> '{item,qty_back}' is null and x #>> '{item,state}' = 'not_returned' from pg_temp.vset(:B2, 'not_returned', 'mixer stays till Monday', 3) x));
create temp table _u as select pg_temp.vset(:B2, 'undo', 'ignored', null, (pg_temp.j(format('select public.event_wrap_records_get(%L)', :Q)) #>> array['vendor', :B2, 'id'])::uuid) as v; grant all on _u to authenticated;
select pg_temp.res('09 Undo is a row of its own, the history keeps everything', (select v #>> '{item,state}' = 'undo' and v #>> '{item,note}' is null from _u)
  and (select string_agg(x ->> 'state', ',') = 'undo,not_returned,problem,returned' from jsonb_array_elements(pg_temp.j(format('select public.event_wrap_records_get(%L)', :Q)) -> 'log') x)
  and (pg_temp.vset(:B2, 'undo', null, null, (select (v #>> '{item,id}')::uuid from _u)) ->> 'same') = 'true');
select pg_temp.res('10 bookings (status, cost) are untouched', (select m = (select md5(string_agg(r::text, '|' order by r.id)) from public.event_resources r) from _bk));
select pg_temp.res('11 asked-only, closed, cancelled, unknown bookings are refused', pg_temp.vset('a0000000-0000-4000-8000-0000000b4413', 'returned') ->> 'err' like '22023 This vendor is not booked%'
  and pg_temp.vset('a0000000-0000-4000-8000-0000000b4421', 'returned', null, null, null, null, 'a0000000-0000-4000-8000-0000000d4442') ->> 'err' like '22023 This event is closed%'
  and pg_temp.vset('a0000000-0000-4000-8000-0000000b4431', 'returned', null, null, null, null, 'a0000000-0000-4000-8000-0000000d4443') ->> 'err' like '22023 This event is closed%'
  and pg_temp.vset('a0000000-0000-4000-8000-0000000b4421', 'returned') ->> 'err' like 'P0002%');
select pg_temp.login('a_view444@a.test');
select pg_temp.res('12 without Event-day command edit: can see, cannot press', pg_temp.vset(:B2, 'returned') ->> 'err' like '42501%' and (pg_temp.j(format('select public.event_wrap_records_get(%L)', :Q)) #>> array['vendor', :B1, 'state']) = 'problem');
select pg_temp.login('a_nov444@a.test');
select pg_temp.res('13 without Vendors view: no vendor answers, none can be given; the stock notes stay', pg_temp.vset(:B2, 'returned') ->> 'err' like '42501%' and (select x -> 'vendor' = 'null'::jsonb and x -> 'log' = 'null'::jsonb and jsonb_typeof(x -> 'stock') = 'array' from pg_temp.j(format('select public.event_wrap_records_get(%L)', :Q)) x));
select pg_temp.res('14 a stock note by someone who may mark it back (Event-day command edit)', (select x #>> '{item,note}' = 'glass cracked' and x #>> '{item,by}' = 'Nikhil NoVendors' and x #>> '{item,label}' = 'Uplight'
    from pg_temp.j('select public.stock_return_note(''a0000000-0000-4000-8000-00000000c441'', '' glass  cracked '', ''a0000000-0000-4000-8000-00000000e449'')') x)
  and (pg_temp.j('select public.stock_return_note(''a0000000-0000-4000-8000-00000000c441'', ''glass cracked'', ''a0000000-0000-4000-8000-00000000e449'')') ->> 'same') = 'true'
  and jsonb_array_length(pg_temp.j(format('select public.event_wrap_records_get(%L)', :Q)) -> 'stock') = 1);
select pg_temp.res('15 empty note, stock not out for an event: refused', pg_temp.j('select public.stock_return_note(''a0000000-0000-4000-8000-00000000c441'', '' '')') ->> 'err' like '22023 Type the note%');
select pg_temp.login('a_admin@a.test');
select pg_temp.res('16 stock not out for an event / not there: refused', pg_temp.j('select public.stock_return_note(''a0000000-0000-4000-8000-00000000c442'', ''x'')') ->> 'err' like '22023 This stock is not out%' and pg_temp.j('select public.stock_return_note(gen_random_uuid(), ''x'')') ->> 'err' like '42501%');
select pg_temp.login('a_view444@a.test');
select pg_temp.res('17 a role that cannot mark stock back cannot note it', pg_temp.j('select public.stock_return_note(''a0000000-0000-4000-8000-00000000c441'', ''x'')') ->> 'err' like '42501%');
select pg_temp.login('b_admin@b.test');
select pg_temp.res('18 another studio sees and writes nothing', pg_temp.vset(:B2, 'returned') ->> 'err' like 'P0002%' and pg_temp.j(format('select public.event_wrap_records_get(%L)', :Q)) ->> 'err' like 'P0002%'
  and pg_temp.j('select public.stock_return_note(''a0000000-0000-4000-8000-00000000c441'', ''x'')') ->> 'err' like '42501%');
select pg_temp.su(); set role anon;
select pg_temp.res('19 not signed in: refused', pg_temp.vset(:B2, 'returned') ->> 'err' like '42501%' and pg_temp.j(format('select public.event_wrap_records_get(%L)', :Q)) ->> 'err' like '42501%');
reset role; set role authenticated;
select pg_temp.res('20 the table cannot be read or written directly', pg_temp.j('with x as (select count(*) c from public.event_wrap_records) select to_jsonb(c) from x') ->> 'err' like '42501%');
reset role;
select pg_temp.su();
select name, result from _rc where result <> 'PASS' order by name;
select 'R258-WRAP-RECORDS-0444: ' || case when count(*) filter (where result <> 'PASS') = 0 then 'ALL PASS' else 'FAIL' end || ' (' || count(*) filter (where result = 'PASS') || '/' || count(*) || ')' from _rc;
rollback;
