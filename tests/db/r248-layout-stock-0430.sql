-- r248-layout-stock-0430.sql - R248: floor-plan products on the Inventory page (needed / held / free / to borrow).
-- Proves: (1) structure - the link table has row security, signed-in staff may only read it, anon nothing; helpers closed,
-- the 5 calls signed-in only, definer + empty search_path; read-only studio guard, audit and same-studio item guard on the
-- table; the free-trial purge list takes it; marker 430;
-- (2) links - Inventory edit only (sales / view-only / anon refused), own active item only (another studio's item, an
-- inactive item refused), the same type + item again = the same row, bad type / per object / mode refused, a direct insert
-- refused, another studio never sees them, removing keeps the row (removed_at) and a re-link is a new row, a 21st item for one
-- type refused;
-- (3) needs math - the LATEST floor-plan version only, objects + seats per type (rows x cols, seats as number or text, a single
-- chair = 1 seat), several links per type added per item, each link rounded up, garbage items ignored, unlinked types listed;
-- held (reserved) / free on the stock days (0374 rule) / to borrow;
-- (4) same day - another live event on the same stock days that needs the same item is listed with the shortfall if both go
-- ahead; once it reserves, this event is short on its own; an event on another day / a cancelled event is not listed;
-- (5) overview - default next 30 days, range rules, summary counts, own studio only; Inventory view needed;
-- (6) reading never changes a reservation; (7) speed: a 40 000-object (~9.9 MB) floor plan is counted in well under 2 s;
-- (8) inventory_demand (the Inventory page's one startup read) = the same per item + event numbers as every row, own studio only.
-- Re-applies 0430 twice. Local disposable PG only. Fake data only. Rolled back.
\set ON_ERROR_STOP 0
set client_min_messages = error;
\ir ../../supabase/migrations/0430_r248_layout_stock.sql
\ir ../../supabase/migrations/0430_r248_layout_stock.sql
set client_min_messages = warning;
begin;
set local helm.r397_plan_lock = off;
create temp table _rs(name text, result text); grant all on _rs to anon, authenticated, service_role;
create or replace function pg_temp.t(p_name text, p_ok boolean, p_detail text default '') returns void language plpgsql as $$
begin insert into _rs values (p_name, case when coalesce(p_ok, false) then 'PASS' else 'FAIL: ' || left(coalesce(p_detail, ''), 900) end); end $$;
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
create or replace function pg_temp.j(p_who text, p_sql text) returns jsonb language plpgsql as $$
declare v text := pg_temp.as_val(p_who, p_sql);
begin if v like 'ok:%' then return substr(v, 4)::jsonb; end if; return jsonb_build_object('error', v); end $$;
-- one item line of a needs answer
create or replace function pg_temp.it(p_block jsonb, p_item uuid) returns jsonb language sql as $$
  select e from jsonb_array_elements(p_block -> 'items') e where e ->> 'item_id' = p_item::text $$;

-- fixture: studio A - a view-only stock person (operations: Inventory view, no edit); items; three events
do $$ declare u uuid; begin
  select id into u from auth.users where email = 'r248_view@a.test';
  if u is null then u := auth.seed_user('r248_view@a.test'); end if;
  insert into public.profiles(id, email, full_name, role, org_id, must_change_password, created_at)
    values (u, 'r248_view@a.test', 'Vina Ew', 'operations', 'a0000000-0000-4000-8000-000000000001', false, now())
  on conflict (id) do update set role = excluded.role, org_id = excluded.org_id;
end $$;
insert into public.role_access(role, area, can_view, can_edit, org_id, updated_at) values
  ('operations', 'inventory', true, false, 'a0000000-0000-4000-8000-000000000001', now())
on conflict (role, area, org_id) do update set can_view = excluded.can_view, can_edit = excluded.can_edit;
update public.quotes set event_date = (now() + interval '20 days')::date, status = 'confirmed', title = 'Reddy Wedding', deleted_at = null
 where id = 'a0000000-0000-4000-8000-00000000da01';
update public.quotes set event_date = (now() + interval '20 days')::date, status = 'confirmed', title = 'B Gala', deleted_at = null
 where id = 'b0000000-0000-4000-8000-00000000da01';
insert into public.quotes(id, code, title, status, client, pricing, current_version, approval_status, org_id, approval_token, event_date, created_at, updated_at) values
  ('a0000000-0000-4000-8000-00000000e481', 'A-0481', 'Rao Rally', 'confirmed', '{"name":"Ravi"}'::jsonb,
   '{"subtotal":100000,"discount":0,"gstPct":18,"total":118000}'::jsonb, 1, 'sent', 'a0000000-0000-4000-8000-000000000001',
   'a0000000-0000-4000-8000-0000000481aa', (now() + interval '20 days')::date, now(), now()),
  ('a0000000-0000-4000-8000-00000000e482', 'A-0482', 'Later Gala', 'confirmed', '{"name":"Lata"}'::jsonb,
   '{"subtotal":100000,"discount":0,"gstPct":18,"total":118000}'::jsonb, 1, 'sent', 'a0000000-0000-4000-8000-000000000001',
   'a0000000-0000-4000-8000-0000000482aa', (now() + interval '40 days')::date, now(), now()),
  ('a0000000-0000-4000-8000-00000000e483', 'A-0483', 'Called Off', 'cancelled', '{"name":"Cora"}'::jsonb,
   '{"subtotal":100000,"discount":0,"gstPct":18,"total":118000}'::jsonb, 1, 'sent', 'a0000000-0000-4000-8000-000000000001',
   'a0000000-0000-4000-8000-0000000483aa', (now() + interval '20 days')::date, now(), now());
insert into public.inventory_items (id, name, category, total_qty, unit, org_id, active) values
  ('a0000000-0000-4000-8000-0000000a4801', 'Round table 6 ft', 'Tables', 10, 'pcs', 'a0000000-0000-4000-8000-000000000001', true),
  ('a0000000-0000-4000-8000-0000000a4802', 'Chiavari chair', 'Seating', 150, 'pcs', 'a0000000-0000-4000-8000-000000000001', true),
  ('a0000000-0000-4000-8000-0000000a4803', 'Barricade 2 m', 'Security', 6, 'pcs', 'a0000000-0000-4000-8000-000000000001', true),
  ('a0000000-0000-4000-8000-0000000a4804', 'Old podium', 'AV', 2, 'pcs', 'a0000000-0000-4000-8000-000000000001', false),
  ('b0000000-0000-4000-8000-0000000b4801', 'B chair', 'Seating', 99, 'pcs', 'b0000000-0000-4000-8000-000000000001', true);
-- floor plans: an OLD version (must be ignored) then the latest; garbage entries are ignored
insert into public.quote_versions(quote_id, version_no, data, object_count, org_id) values
  ('a0000000-0000-4000-8000-00000000da01', 901, '{"items":[{"type":"table","properties":{"seats":8}},{"type":"barricade"},{"type":"barricade"},{"type":"barricade"},{"type":"barricade"},{"type":"barricade"},{"type":"barricade"},{"type":"barricade"}]}', 8, 'a0000000-0000-4000-8000-000000000001'),
  ('a0000000-0000-4000-8000-00000000da01', 902, '{"items":[
     {"id":"t1","type":"table","category":"seating","label":"Round Table","properties":{"seats":8}},
     {"id":"t2","type":"table","category":"seating","label":"Round Table","properties":{"seats":8}},
     {"id":"t3","type":"table","category":"seating","label":"Round Table","properties":{"seats":"6"}},
     {"id":"s1","type":"seatblock","category":"seating","label":"Seating Block","properties":{"rows":10,"cols":14}},
     {"id":"c1","type":"chiavari","category":"seating","label":"Chair (single)"},
     {"id":"c2","type":"chiavari","category":"seating","label":"Chair (single)"},
     {"id":"b1","type":"barricade","category":"security","label":"Barricade"},
     {"id":"b2","type":"barricade","category":"security","label":"Barricade"},
     {"id":"b3","type":"barricade","category":"security","label":"Barricade"},
     {"id":"b4","type":"barricade","category":"security","label":"Barricade"},
     {"id":"e1","type":"exit","category":"safety","label":"Exit Zone"},
     {"id":"x1","type":"Bad Type!","properties":{"seats":5}}, "just text", 42, {"label":"no type"},
     {"id":"x2","type":"table","category":"seating","label":"Round Table","properties":{"seats":-3}}
   ]}', 15, 'a0000000-0000-4000-8000-000000000001'),
  ('a0000000-0000-4000-8000-00000000e481', 1, '{"items":[{"type":"barricade"},{"type":"barricade"},{"type":"barricade"},{"type":"barricade"}]}', 4, 'a0000000-0000-4000-8000-000000000001'),
  ('a0000000-0000-4000-8000-00000000e482', 1, '{"items":[{"type":"barricade"},{"type":"barricade"}]}', 2, 'a0000000-0000-4000-8000-000000000001'),
  ('a0000000-0000-4000-8000-00000000e483', 1, '{"items":[{"type":"barricade"},{"type":"barricade"},{"type":"barricade"}]}', 3, 'a0000000-0000-4000-8000-000000000001'),
  ('b0000000-0000-4000-8000-00000000da01', 901, '{"items":[{"type":"table","properties":{"seats":8}}]}', 1, 'b0000000-0000-4000-8000-000000000001');

-- ---- 1) structure -----------------------------------------------------------------------------------------------------------
select pg_temp.t('1a inventory_layout_links: row security on, signed-in may only read, anon nothing',
  (select relrowsecurity from pg_class where oid = 'public.inventory_layout_links'::regclass)
  and has_table_privilege('authenticated', 'public.inventory_layout_links', 'select')
  and not has_table_privilege('authenticated', 'public.inventory_layout_links', 'insert')
  and not has_table_privilege('authenticated', 'public.inventory_layout_links', 'update')
  and not has_table_privilege('authenticated', 'public.inventory_layout_links', 'delete')
  and not has_table_privilege('anon', 'public.inventory_layout_links', 'select'));
select pg_temp.t('1b every 0430 function: definer + empty search_path (the pure number helper: empty search_path)',
  (select bool_and((p.prosecdef or p.proname = '_r430_num') and p.proconfig @> array['search_path=""']) from pg_proc p
    where p.pronamespace = 'public'::regnamespace and (p.proname like '\_r430\_%' or p.proname in ('layout_stock_needs', 'layout_stock_overview', 'layout_links', 'layout_link_set', 'layout_link_remove', 'inventory_demand')))
  and (select count(*) from pg_proc p where p.pronamespace = 'public'::regnamespace
         and (p.proname like '\_r430\_%' or p.proname in ('layout_stock_needs', 'layout_stock_overview', 'layout_links', 'layout_link_set', 'layout_link_remove', 'inventory_demand'))) = 12);
select pg_temp.t('1c grants: the 5 calls for signed-in only, helpers closed, nothing for anon',
  has_function_privilege('authenticated', 'public.layout_stock_needs(uuid)', 'execute')
  and has_function_privilege('authenticated', 'public.layout_stock_overview(date,date)', 'execute')
  and has_function_privilege('authenticated', 'public.layout_links()', 'execute')
  and has_function_privilege('authenticated', 'public.layout_link_set(text,uuid,numeric,text)', 'execute')
  and has_function_privilege('authenticated', 'public.layout_link_remove(uuid)', 'execute')
  and not has_function_privilege('anon', 'public.layout_stock_needs(uuid)', 'execute')
  and not has_function_privilege('anon', 'public.layout_link_set(text,uuid,numeric,text)', 'execute')
  and has_function_privilege('authenticated', 'public.inventory_demand(uuid)', 'execute')
  and not has_function_privilege('anon', 'public.inventory_demand(uuid)', 'execute')
  and not has_function_privilege('authenticated', 'public._r430_event_block(uuid,uuid)', 'execute')
  and not has_function_privilege('authenticated', 'public._r430_type_counts(uuid,uuid)', 'execute')
  and not has_function_privilege('authenticated', 'public._r430_item_needs(uuid,uuid)', 'execute')
  and not has_function_privilege('authenticated', 'public._r430_held(uuid,uuid,uuid)', 'execute'));
select pg_temp.t('1d triggers on the new table: same-studio item guard, read-only studio guard, audit',
  (select count(*) from pg_trigger where tgrelid = 'public.inventory_layout_links'::regclass and not tgisinternal
     and tgname in ('ab_r430_link_guard', 'zzz_studio_read_only', 'audit_trg')) = 3);
select pg_temp.t('1e trial purge list takes the links (before the stock items); marker 430 recorded',
  (to_regprocedure('public._tr184_purge_tables()') is null
   or (array_position(public._tr184_purge_tables(), 'inventory_layout_links') < array_position(public._tr184_purge_tables(), 'inventory_items')
       and (select count(*) from unnest(public._tr184_purge_tables()) x where x = 'inventory_layout_links') = 1))
  and (to_regclass('public.helm_schema_markers') is null or exists (select 1 from public.helm_schema_markers where num = 430)));

-- ---- 2) links ---------------------------------------------------------------------------------------------------------------
create temp table _l(k text primary key, v jsonb);
insert into _l values
  ('table_t', pg_temp.j('a_admin@a.test', $q$select public.layout_link_set('table', 'a0000000-0000-4000-8000-0000000a4801')::text$q$)),
  ('table_c', pg_temp.j('a_admin@a.test', $q$select public.layout_link_set(' Table ', 'a0000000-0000-4000-8000-0000000a4802', 1, 'seats')::text$q$)),
  ('block_c', pg_temp.j('a_admin@a.test', $q$select public.layout_link_set('seatblock', 'a0000000-0000-4000-8000-0000000a4802', 1, 'seats')::text$q$)),
  ('chiav_c', pg_temp.j('a_admin@a.test', $q$select public.layout_link_set('chiavari', 'a0000000-0000-4000-8000-0000000a4802', 1.5)::text$q$)),
  ('barr',    pg_temp.j('a_admin@a.test', $q$select public.layout_link_set('barricade', 'a0000000-0000-4000-8000-0000000a4803')::text$q$));
select pg_temp.t('2a admin links: 5 rows, the type is trimmed + lower-cased, per seat kept',
  (select count(*) from public.inventory_layout_links where org_id = 'a0000000-0000-4000-8000-000000000001' and removed_at is null) = 5
  and (select v ->> 'layout_type' = 'table' and v ->> 'count_mode' = 'seats' from _l where k = 'table_c'),
  (select string_agg(k || '=' || v::text, ' ') from _l));
do $$ declare r jsonb; begin
  r := pg_temp.j('a_admin@a.test', $q$select public.layout_link_set('chiavari', 'a0000000-0000-4000-8000-0000000a4802', 1)::text$q$);
  perform pg_temp.t('2b the same type + item again = the same row (per object updated, no second row)',
    r ->> 'link_id' = (select v ->> 'link_id' from _l where k = 'chiav_c')
    and (select count(*) from public.inventory_layout_links where layout_type = 'chiavari' and removed_at is null) = 1
    and (select per_object from public.inventory_layout_links where layout_type = 'chiavari' and removed_at is null) = 1, r::text);
end $$;
select pg_temp.t('2c refused: sales (no Inventory), view-only, anon',
  pg_temp.as_val('a_staff@a.test', $q$select public.layout_link_set('bar', 'a0000000-0000-4000-8000-0000000a4801')::text$q$) like '42501%'
  and pg_temp.as_val('r248_view@a.test', $q$select public.layout_link_set('bar', 'a0000000-0000-4000-8000-0000000a4801')::text$q$) like '42501%'
  and pg_temp.as_val('anon', $q$select public.layout_link_set('bar', 'a0000000-0000-4000-8000-0000000a4801')::text$q$) like '42501%');
select pg_temp.t('2d refused: another studio''s item, an inactive item',
  pg_temp.as_val('a_admin@a.test', $q$select public.layout_link_set('bar', 'b0000000-0000-4000-8000-0000000b4801')::text$q$) like '42501%'
  and pg_temp.as_val('a_admin@a.test', $q$select public.layout_link_set('podium', 'a0000000-0000-4000-8000-0000000a4804')::text$q$) like '42501%');
select pg_temp.t('2e refused: bad type, per object 0 / 3 decimals / too big, unknown count mode',
  pg_temp.as_val('a_admin@a.test', $q$select public.layout_link_set('Bad Type!', 'a0000000-0000-4000-8000-0000000a4801')::text$q$) like '22023%'
  and pg_temp.as_val('a_admin@a.test', $q$select public.layout_link_set('bar', 'a0000000-0000-4000-8000-0000000a4801', 0)::text$q$) like '22023%'
  and pg_temp.as_val('a_admin@a.test', $q$select public.layout_link_set('bar', 'a0000000-0000-4000-8000-0000000a4801', 1.005)::text$q$) like '22023%'
  and pg_temp.as_val('a_admin@a.test', $q$select public.layout_link_set('bar', 'a0000000-0000-4000-8000-0000000a4801', 10001)::text$q$) like '22023%'
  and pg_temp.as_val('a_admin@a.test', $q$select public.layout_link_set('bar', 'a0000000-0000-4000-8000-0000000a4801', 1, 'metres')::text$q$) like '22023%');
select pg_temp.t('2f a direct insert by a signed-in admin is refused (writes only through the calls)',
  pg_temp.as_val('a_admin@a.test', $q$insert into public.inventory_layout_links (org_id, layout_type, item_id)
    values ('a0000000-0000-4000-8000-000000000001', 'bar', 'a0000000-0000-4000-8000-0000000a4801') returning id::text$q$) like '42501%');
select pg_temp.t('2g another studio sees none of them (table read + layout_links), studio A view-only sees all 5',
  pg_temp.as_val('b_admin@b.test', $q$select count(*)::text from public.inventory_layout_links$q$) = 'ok:0'
  and pg_temp.as_val('b_admin@b.test', $q$select public.layout_links()::text$q$) = 'ok:[]'
  and pg_temp.as_val('r248_view@a.test', $q$select count(*)::text from public.inventory_layout_links$q$) = 'ok:5'
  and pg_temp.as_val('r248_view@a.test', $q$select jsonb_array_length(public.layout_links())::text$q$) = 'ok:5'
  and pg_temp.as_val('a_staff@a.test', $q$select count(*)::text from public.inventory_layout_links$q$) = 'ok:0');
select pg_temp.t('2h the server guard: a row pointing at another studio''s item is refused even for server code',
  pg_temp.as_val(null, $q$insert into public.inventory_layout_links (org_id, layout_type, item_id)
    values ('a0000000-0000-4000-8000-000000000001', 'bar', 'b0000000-0000-4000-8000-0000000b4801') returning id::text$q$) like '42501%');
do $$ declare id1 uuid; id2 uuid; r text; begin
  r := pg_temp.as_val('a_admin@a.test', $q$select public.layout_link_set('bar', 'a0000000-0000-4000-8000-0000000a4801')::text$q$);
  id1 := (substr(r, 4)::jsonb ->> 'link_id')::uuid;
  perform pg_temp.t('2i another studio cannot remove it', pg_temp.as_val('b_admin@b.test', format('select public.layout_link_remove(%L)::text', id1)) like '42501%');
  r := pg_temp.as_val('a_admin@a.test', format('select public.layout_link_remove(%L)::text', id1));
  perform pg_temp.t('2j removing keeps the row (removed_at + who), it leaves the list, a second remove changes nothing',
    r = 'ok:{"removed": true}'
    and exists (select 1 from public.inventory_layout_links where id = id1 and removed_at is not null and removed_by is not null)
    and pg_temp.as_val('a_admin@a.test', $q$select count(*)::text from jsonb_array_elements(public.layout_links()) e where e ->> 'layout_type' = 'bar'$q$) = 'ok:0'
    and pg_temp.as_val('a_admin@a.test', format('select public.layout_link_remove(%L)::text', id1)) = 'ok:{"removed": false}', r);
  r := pg_temp.as_val('a_admin@a.test', $q$select public.layout_link_set('bar', 'a0000000-0000-4000-8000-0000000a4801')::text$q$);
  id2 := (substr(r, 4)::jsonb ->> 'link_id')::uuid;
  perform pg_temp.t('2k a re-link is a new row; the removed row stays', id2 is not null and id2 <> id1
    and (select count(*) from public.inventory_layout_links where layout_type = 'bar') = 2, r);
  perform pg_temp.as_val('a_admin@a.test', format('select public.layout_link_remove(%L)::text', id2));
end $$;
do $$ declare i int; r text; begin
  perform auth.logout(); execute 'reset role';
  for i in 1..20 loop
    insert into public.inventory_items (id, name, category, total_qty, org_id) values
      (('a0000000-0000-4000-8000-0000000c' || lpad(i::text, 4, '0'))::uuid, 'Lantern ' || i, 'Decor', 5, 'a0000000-0000-4000-8000-000000000001');
  end loop;
  for i in 1..20 loop
    r := pg_temp.as_val('a_admin@a.test', format('select public.layout_link_set(%L, %L)::text', 'lanterns', ('a0000000-0000-4000-8000-0000000c' || lpad(i::text, 4, '0'))));
  end loop;
  r := pg_temp.as_val('a_admin@a.test', $q$select public.layout_link_set('lanterns', 'a0000000-0000-4000-8000-0000000a4801')::text$q$);
  perform pg_temp.t('2l at most 20 stock items for one layout product', r like '22023%' and (select count(*) from public.inventory_layout_links where layout_type = 'lanterns' and removed_at is null) = 20, r);
end $$;

-- ---- 3) needs math (Reddy Wedding, latest version 902) ------------------------------------------------------------------------
do $$ declare b jsonb; tb jsonb; ch jsonb; ba jsonb; types jsonb; unl jsonb; n_res_before int; n_res_after int; begin
  -- 50 chairs already reserved for the wedding
  perform pg_temp.as_val('a_admin@a.test', $q$select public.reserve_inventory('a0000000-0000-4000-8000-0000000a4802', 'a0000000-0000-4000-8000-00000000da01', 50)::text$q$);
  select count(*) into n_res_before from public.inventory_reservations;
  b := pg_temp.j('a_admin@a.test', $q$select public.layout_stock_needs('a0000000-0000-4000-8000-00000000da01')::text$q$);
  select count(*) into n_res_after from public.inventory_reservations;
  tb := pg_temp.it(b, 'a0000000-0000-4000-8000-0000000a4801'); ch := pg_temp.it(b, 'a0000000-0000-4000-8000-0000000a4802');
  ba := pg_temp.it(b, 'a0000000-0000-4000-8000-0000000a4803');
  select jsonb_object_agg(e ->> 'layout_type', jsonb_build_object('o', e -> 'objects', 's', e -> 'seats')) into types from jsonb_array_elements(b -> 'types') e;
  perform pg_temp.t('3a the latest version only: 4 tables (one with seats -3 counts 0 seats), 1 seat block, 2 chairs, 4 barricades, 1 exit',
    (b ->> 'version_no')::int = 902 and types -> 'table' = '{"o":4,"s":22}' and types -> 'seatblock' = '{"o":1,"s":140}'
    and types -> 'chiavari' = '{"o":2,"s":2}' and types -> 'barricade' = '{"o":4,"s":0}' and types -> 'exit' = '{"o":1,"s":0}'
    and (b ->> 'objects')::int = 12, coalesce(types::text, b::text));
  perform pg_temp.t('3b garbage entries ignored (no type, bad type, text, numbers)',
    not exists (select 1 from jsonb_array_elements(b -> 'types') e where e ->> 'layout_type' not in ('table', 'seatblock', 'chiavari', 'barricade', 'exit')), (b -> 'types')::text);
  perform pg_temp.t('3c round tables: needed 4 (objects x 1), free 10, nothing to borrow',
    (tb ->> 'needed')::numeric = 4 and (tb ->> 'held')::numeric = 0 and (tb ->> 'free')::numeric = 10 and (tb ->> 'to_borrow')::numeric = 0, tb::text);
  perform pg_temp.t('3d chairs: 22 table seats + 140 block seats + 2 single chairs = 164 needed; 50 held, 100 free, 14 to borrow',
    (ch ->> 'needed')::numeric = 164 and (ch ->> 'held')::numeric = 50 and (ch ->> 'free')::numeric = 100
    and (ch ->> 'to_reserve')::numeric = 114 and (ch ->> 'to_borrow')::numeric = 14
    and ch -> 'types' @> '["table","seatblock","chiavari"]', ch::text);
  perform pg_temp.t('3e the table type lists its two links (table x1 per object, chair x1 per seat = 22)',
    (select jsonb_array_length(e -> 'links') = 2
            and exists (select 1 from jsonb_array_elements(e -> 'links') l where l ->> 'count_mode' = 'seats' and (l ->> 'needed')::numeric = 22)
       from jsonb_array_elements(b -> 'types') e where e ->> 'layout_type' = 'table'), (b -> 'types')::text);
  select coalesce(jsonb_agg(u ->> 'layout_type'), '[]') into unl from jsonb_array_elements(b -> 'unlinked') u;
  perform pg_temp.t('3f unlinked types listed (exit), linked ones not', unl = '["exit"]', unl::text);
  perform pg_temp.t('3g short_items = 1 (chairs), labels from the floor plan', (b ->> 'short_items')::int = 1
    and (select e ->> 'label' from jsonb_array_elements(b -> 'types') e where e ->> 'layout_type' = 'table') = 'Round Table', b::text);
  perform pg_temp.t('6a reading the needs changes no reservation', n_res_before = n_res_after);
  -- a per-object of 1.5 rounds UP per link (2 chairs x 1.5 = 3)
  perform pg_temp.as_val('a_admin@a.test', $q$select public.layout_link_set('chiavari', 'a0000000-0000-4000-8000-0000000a4802', 1.25)::text$q$);
  b := pg_temp.j('a_admin@a.test', $q$select public.layout_stock_needs('a0000000-0000-4000-8000-00000000da01')::text$q$);
  perform pg_temp.t('3h per object 1.25 x 2 chairs = 2.5 -> 3 (each link rounded up)', (pg_temp.it(b, 'a0000000-0000-4000-8000-0000000a4802') ->> 'needed')::numeric = 165,
    pg_temp.it(b, 'a0000000-0000-4000-8000-0000000a4802')::text);
  perform pg_temp.as_val('a_admin@a.test', $q$select public.layout_link_set('chiavari', 'a0000000-0000-4000-8000-0000000a4802', 1)::text$q$);
  perform pg_temp.t('3i view-only stock staff may read the needs; sales / anon / another studio refused',
    pg_temp.as_val('r248_view@a.test', $q$select (public.layout_stock_needs('a0000000-0000-4000-8000-00000000da01') ->> 'version_no')$q$) = 'ok:902'
    and pg_temp.as_val('a_staff@a.test', $q$select public.layout_stock_needs('a0000000-0000-4000-8000-00000000da01')::text$q$) like '42501%'
    and pg_temp.as_val('anon', $q$select public.layout_stock_needs('a0000000-0000-4000-8000-00000000da01')::text$q$) like '42501%'
    and pg_temp.as_val('b_admin@b.test', $q$select public.layout_stock_needs('a0000000-0000-4000-8000-00000000da01')::text$q$) like '42501%');
  b := pg_temp.j('b_admin@b.test', $q$select public.layout_stock_needs('b0000000-0000-4000-8000-00000000da01')::text$q$);
  perform pg_temp.t('3j another studio''s own event: its types, no links of studio A (all unlinked), no items',
    jsonb_array_length(b -> 'items') = 0 and jsonb_array_length(b -> 'unlinked') = 1 and b -> 'unlinked' -> 0 ->> 'layout_type' = 'table', b::text);
end $$;

-- ---- 4) same day: the barricade case (6 owned; wedding needs 4, Rao Rally the same day needs 4) ---------------------------------
do $$ declare b jsonb; ba jsonb; sd jsonb; begin
  b := pg_temp.j('a_admin@a.test', $q$select public.layout_stock_needs('a0000000-0000-4000-8000-00000000da01')::text$q$);
  ba := pg_temp.it(b, 'a0000000-0000-4000-8000-0000000a4803'); sd := ba -> 'same_day';
  perform pg_temp.t('4a nothing reserved yet: alone 0 to borrow, but 2 short if both go ahead; Rao Rally listed (needs 4)',
    (ba ->> 'needed')::numeric = 4 and (ba ->> 'to_borrow')::numeric = 0 and (ba ->> 'to_borrow_shared')::numeric = 2
    and jsonb_array_length(sd) = 1 and sd -> 0 ->> 'event' = 'Rao Rally' and (sd -> 0 ->> 'needs')::numeric = 4 and (sd -> 0 ->> 'holds')::numeric = 0
    and (b ->> 'shared_items')::int = 1, ba::text);
  perform pg_temp.t('4b an event 20 days later and a cancelled event the same day are not listed',
    not (sd::text like '%Later Gala%') and not (sd::text like '%Called Off%'), sd::text);
  -- Rao Rally reserves its 4 first
  perform pg_temp.as_val('a_admin@a.test', $q$select public.reserve_inventory('a0000000-0000-4000-8000-0000000a4803', 'a0000000-0000-4000-8000-00000000e481', 4)::text$q$);
  b := pg_temp.j('a_admin@a.test', $q$select public.layout_stock_needs('a0000000-0000-4000-8000-00000000da01')::text$q$);
  ba := pg_temp.it(b, 'a0000000-0000-4000-8000-0000000a4803');
  perform pg_temp.t('4c after Rao Rally reserved 4: the wedding has 2 free, 2 to borrow on its own; Rao Rally holds 4',
    (ba ->> 'free')::numeric = 2 and (ba ->> 'to_borrow')::numeric = 2 and (ba ->> 'to_borrow_shared')::numeric = 2
    and (ba -> 'same_day' -> 0 ->> 'holds')::numeric = 4, ba::text);
  -- the wedding reserves what is free + records the 2 short (the page's "Reserve from layout" call), then is covered except the 2
  perform pg_temp.as_val('a_admin@a.test', $q$select public.reserve_inventory_with_sourcing('a0000000-0000-4000-8000-0000000a4803', 'a0000000-0000-4000-8000-00000000da01', 4, 'From layout', 'buy')::text$q$);
  b := pg_temp.j('a_admin@a.test', $q$select public.layout_stock_needs('a0000000-0000-4000-8000-00000000da01')::text$q$);
  ba := pg_temp.it(b, 'a0000000-0000-4000-8000-0000000a4803');
  perform pg_temp.t('4d after Reserve from layout: 2 held, 0 free, still 2 to borrow (the shortfall recorded as a stock request)',
    (ba ->> 'held')::numeric = 2 and (ba ->> 'free')::numeric = 0 and (ba ->> 'to_borrow')::numeric = 2
    and exists (select 1 from public.event_stock_requests r where r.quote_id = 'a0000000-0000-4000-8000-00000000da01'
                 and r.item_id = 'a0000000-0000-4000-8000-0000000a4803' and r.qty = 2 and r.source = 'buy'), ba::text);
  -- a stock window that ends the day before the rally: no longer the same day
  perform auth.logout(); execute 'reset role';
  insert into public.event_stock_windows (org_id, quote_id, setup_from, teardown_to)
    values ('a0000000-0000-4000-8000-000000000001', 'a0000000-0000-4000-8000-00000000e481', (now() + interval '21 days')::date, (now() + interval '22 days')::date);
  update public.quotes set event_date = (now() + interval '21 days')::date where id = 'a0000000-0000-4000-8000-00000000e481';
  b := pg_temp.j('a_admin@a.test', $q$select public.layout_stock_needs('a0000000-0000-4000-8000-00000000da01')::text$q$);
  ba := pg_temp.it(b, 'a0000000-0000-4000-8000-0000000a4803');
  perform pg_temp.t('4e moved to the next day (own stock dates): not the same day any more, its 4 are free again for the wedding',
    jsonb_array_length(ba -> 'same_day') = 0 and (ba ->> 'free')::numeric = 4 and (ba ->> 'to_borrow')::numeric = 0, ba::text);
  update public.quotes set event_date = (now() + interval '20 days')::date where id = 'a0000000-0000-4000-8000-00000000e481';
  insert into public.event_stock_windows (org_id, quote_id, setup_from, teardown_to)
    values ('a0000000-0000-4000-8000-000000000001', 'a0000000-0000-4000-8000-00000000e481', null, null);
end $$;

-- ---- 5) overview ----------------------------------------------------------------------------------------------------------------
do $$ declare o jsonb; ids text[]; s jsonb; nshort int; begin
  -- other suites may leave studio A events with a floor plan behind: check OUR events, and the summary against the list
  o := pg_temp.j('a_admin@a.test', $q$select public.layout_stock_overview()::text$q$);
  select array_agg(e ->> 'title') into ids from jsonb_array_elements(o -> 'events') e;
  perform pg_temp.t('5a default = the next 30 days: the wedding + Rao Rally (not the later gala, not the cancelled one)',
    ids @> array['Reddy Wedding', 'Rao Rally'] and not ids && array['Later Gala', 'Called Off']
    and (o ->> 'to')::date - (o ->> 'from')::date = 30, coalesce(array_to_string(ids, ','), o::text));
  s := o -> 'summary';
  select count(*) into nshort from jsonb_array_elements(o -> 'events') e where (e ->> 'short_items')::int > 0;
  perform pg_temp.t('5b summary = the list: events counted, the wedding short (chairs + barricades), Rao Rally covered, exit unlinked',
    (s ->> 'events')::int = jsonb_array_length(o -> 'events') and (s ->> 'events_short')::int = nshort
    and exists (select 1 from jsonb_array_elements(o -> 'events') e where e ->> 'title' = 'Reddy Wedding' and (e ->> 'short_items')::int = 2
                  and e -> 'unlinked' -> 0 ->> 'layout_type' = 'exit')
    and exists (select 1 from jsonb_array_elements(o -> 'events') e where e ->> 'title' = 'Rao Rally' and (e ->> 'short_items')::int = 0)
    and (s ->> 'unlinked_types')::int >= 1, s::text);
  o := pg_temp.j('a_admin@a.test', $q$select public.layout_stock_overview(current_date, current_date + 45)::text$q$);
  perform pg_temp.t('5c a 45-day range also lists the later gala (never the cancelled one)',
    exists (select 1 from jsonb_array_elements(o -> 'events') e where e ->> 'title' = 'Later Gala')
    and not exists (select 1 from jsonb_array_elements(o -> 'events') e where e ->> 'title' = 'Called Off'), (o -> 'summary')::text);
  perform pg_temp.t('5d range rules: end before start / more than a year refused',
    pg_temp.as_val('a_admin@a.test', $q$select public.layout_stock_overview(current_date, current_date - 1)::text$q$) like '22023%'
    and pg_temp.as_val('a_admin@a.test', $q$select public.layout_stock_overview(current_date, current_date + 400)::text$q$) like '22023%');
  o := pg_temp.j('b_admin@b.test', $q$select public.layout_stock_overview()::text$q$);
  perform pg_temp.t('5e another studio sees only its own events (B Gala, none of studio A)',
    exists (select 1 from jsonb_array_elements(o -> 'events') e where e ->> 'title' = 'B Gala')
    and not exists (select 1 from jsonb_array_elements(o -> 'events') e where e ->> 'title' in ('Reddy Wedding', 'Rao Rally', 'Later Gala')), o::text);
  perform pg_temp.t('5f Inventory view needed (sales, anon refused); view-only allowed',
    pg_temp.as_val('a_staff@a.test', $q$select public.layout_stock_overview()::text$q$) like '42501%'
    and pg_temp.as_val('anon', $q$select public.layout_stock_overview()::text$q$) like '42501%'
    and pg_temp.as_val('r248_view@a.test', $q$select (public.layout_stock_overview() -> 'events')::text$q$) like 'ok:%Reddy Wedding%');
end $$;

-- ---- 7) speed: a 40 000-object floor plan (~9.9 MB) is counted once, in well under 2 s ------------------------------------------
do $$ declare t0 timestamptz; ms numeric; b jsonb; begin
  perform auth.logout(); execute 'reset role';
  insert into public.quote_versions(quote_id, version_no, data, object_count, org_id)
    select 'a0000000-0000-4000-8000-00000000e482', 2,
           jsonb_build_object('items', jsonb_agg(jsonb_build_object('id', 'o' || g, 'type', case when g % 2 = 0 then 'chiavari' else 'barricade' end,
             'category', 'seating', 'label', 'Chair (single)', 'x', g, 'y', g, 'w', 1.6, 'h', 1.6, 'rot', 0,
             'properties', jsonb_build_object('note', repeat('x', 20))))), 40000, 'a0000000-0000-4000-8000-000000000001'
      from generate_series(1, 40000) g;
  t0 := clock_timestamp();
  b := pg_temp.j('a_admin@a.test', $q$select public.layout_stock_needs('a0000000-0000-4000-8000-00000000e482')::text$q$);
  ms := extract(epoch from clock_timestamp() - t0) * 1000;
  perform pg_temp.t('7a 40 000 objects (about 9.9 MB, just under the 0427 10 MB cap): right counts (20 000 chairs / barricades) in under 2 s',
    (pg_temp.it(b, 'a0000000-0000-4000-8000-0000000a4802') ->> 'needed')::numeric = 20000
    and (pg_temp.it(b, 'a0000000-0000-4000-8000-0000000a4803') ->> 'needed')::numeric = 20000 and ms < 2000, round(ms) || ' ms ' || left(b::text, 300));
  raise notice 'r248 timing: needs on a 9.9 MB plan % ms', round(ms);
  t0 := clock_timestamp();
  b := pg_temp.j('a_admin@a.test', $q$select public.layout_stock_overview(current_date, current_date + 45)::text$q$);
  ms := extract(epoch from clock_timestamp() - t0) * 1000;
  perform pg_temp.t('7b the overview with that plan in range: under 4 s', ms < 4000 and exists (select 1 from jsonb_array_elements(b -> 'events') e where e ->> 'title' = 'Later Gala'), round(ms) || ' ms');
  raise notice 'r248 timing: overview % ms', round(ms);
end $$;

-- ---- 8) inventory_demand: the Inventory page's ONE startup read = the same numbers the page counted from every row ----------
do $$ declare d jsonb; want jsonb; got jsonb; m jsonb; db jsonb; begin
  perform auth.logout(); execute 'reset role';
  -- a check-out with part back + a written-off missing unit (counted once), a check-out with no event, a cancelled one (ignored)
  insert into public.inventory_checkouts (item_id, quote_id, qty_out, qty_in, written_off, qty_damaged, issued_to, status, org_id) values
    ('a0000000-0000-4000-8000-0000000a4801', 'a0000000-0000-4000-8000-00000000da01', 5, 1, 2, 1, 'Ravi', 'partial', 'a0000000-0000-4000-8000-000000000001'),
    ('a0000000-0000-4000-8000-0000000a4801', null, 2, 0, 0, 0, 'Store', 'out', 'a0000000-0000-4000-8000-000000000001'),
    ('a0000000-0000-4000-8000-0000000a4803', 'a0000000-0000-4000-8000-00000000e481', 3, 0, 0, 0, 'Sunil', 'cancelled', 'a0000000-0000-4000-8000-000000000001');
  insert into public.inventory_reservations (item_id, quote_id, qty, status, org_id) values
    ('a0000000-0000-4000-8000-0000000a4803', 'a0000000-0000-4000-8000-00000000e483', 1, 'reserved', 'a0000000-0000-4000-8000-000000000001');
  d := pg_temp.j('a_admin@a.test', $q$select public.inventory_demand('a0000000-0000-4000-8000-00000000e482')::text$q$);
  -- what the page used to count from every row (store-api _demand: reserved / allocated; still out = out - in - (written off - damaged))
  with res as (select item_id, quote_id, sum(qty) q from public.inventory_reservations where org_id = 'a0000000-0000-4000-8000-000000000001'
                and status in ('reserved', 'allocated') group by 1, 2),
       co as (select item_id, quote_id, sum(greatest(qty_out - coalesce(qty_in, 0) - greatest(coalesce(written_off, 0) - coalesce(qty_damaged, 0), 0), 0)) q
                from public.inventory_checkouts where org_id = 'a0000000-0000-4000-8000-000000000001' and status in ('out', 'partial') group by 1, 2),
       k as (select coalesce(res.item_id, co.item_id) i, coalesce(res.quote_id, co.quote_id) q, coalesce(res.q, 0) r, coalesce(co.q, 0) o
               from res full join co on co.item_id = res.item_id and co.quote_id is not distinct from res.quote_id)
  select coalesce(jsonb_agg(jsonb_build_array(i, q, r, o) order by i, q nulls first), '[]') into want from k where r > 0 or o > 0;
  select coalesce(jsonb_agg(jsonb_build_array((e ->> 'i')::uuid, (e ->> 'q')::uuid, (e ->> 'res')::numeric, (e ->> 'out')::numeric)
           order by (e ->> 'i')::uuid, (e ->> 'q')::uuid nulls first), '[]') into got from jsonb_array_elements(d -> 'rows') e;
  perform pg_temp.t('8a one call = the same per item + event numbers as every reservation / check-out row (part back, written off once, no-event, cancelled left out)',
    got = want and jsonb_array_length(got) >= 5, 'got ' || left(got::text, 400) || ' want ' || left(want::text, 400));
  m := d -> 'quotes';
  perform pg_temp.t('8b the events: date + live + stock days (+ buffer); a cancelled event is not live; the asked-for event is in even with no stock',
    (m -> 'a0000000-0000-4000-8000-00000000da01' ->> 'active')::boolean
    and m -> 'a0000000-0000-4000-8000-00000000da01' ->> 'from' = m -> 'a0000000-0000-4000-8000-00000000da01' ->> 'date'
    and not (m -> 'a0000000-0000-4000-8000-00000000e483' ->> 'active')::boolean and m -> 'a0000000-0000-4000-8000-00000000e483' ->> 'from' is null
    and m ? 'a0000000-0000-4000-8000-00000000e482'
    and not exists (select 1 from jsonb_array_elements(d -> 'rows') e where e ->> 'q' is not null and not (m ? (e ->> 'q'))), m::text);
  db := pg_temp.j('b_admin@b.test', $q$select public.inventory_demand(null)::text$q$);
  perform pg_temp.t('8c another studio: none of studio A''s items or events',
    not exists (select 1 from jsonb_array_elements(db -> 'rows') e where e ->> 'i' like 'a0000000%')
    and not exists (select 1 from jsonb_object_keys(db -> 'quotes') k where k like 'a0000000%'), db::text);
  perform pg_temp.t('8d Inventory view needed: sales / anon refused, view-only allowed',
    pg_temp.as_val('a_staff@a.test', $q$select public.inventory_demand(null)::text$q$) like '42501%'
    and pg_temp.as_val('anon', $q$select public.inventory_demand(null)::text$q$) like '42501%'
    and pg_temp.as_val('r248_view@a.test', $q$select jsonb_typeof(public.inventory_demand(null) -> 'rows')$q$) = 'ok:array');
end $$;

select name, result from _rs order by name;
select case when count(*) filter (where result <> 'PASS') = 0 then 'R248-LAYOUT-STOCK-0430: ALL PASS (' || count(*) || '/' || count(*) || ')'
            else 'R248-LAYOUT-STOCK-0430: ' || count(*) filter (where result <> 'PASS') || ' FAILED of ' || count(*) || ' - ' || string_agg(case when result <> 'PASS' then name || ': ' || result end, '; ' order by name) end as summary from _rs;
rollback;
