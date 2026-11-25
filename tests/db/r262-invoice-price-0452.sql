-- r262-invoice-price-0452.sql - R262: a vendor invoice keeps the approved price. Local disposable PG only. Fake data. Rolled back.
\set ON_ERROR_STOP 0
set client_min_messages = error;
begin;
create temp table _before as select (select md5(coalesce(string_agg((to_jsonb(q))::text, '|' order by q.id), '')) from public.quotes q) as qs,
  (select md5(coalesce(string_agg(to_jsonb(r)::text, '|' order by r.id), '')) from public.event_resources r) as rs, (select count(*) from public.vendor_requests) as vr, (select count(*) from public.notifications) as nt;
\o /dev/null
\i supabase/migrations/0452_r262_invoice_price_lock.sql
\i supabase/migrations/0452_r262_invoice_price_lock.sql
\o
set client_min_messages = warning;
create temp table _rc(name text, result text); grant all on _rc to anon, authenticated, service_role;
create temp table _kv(k text primary key, v text); grant all on _kv to anon, authenticated, service_role;
create or replace function pg_temp.su() returns void language plpgsql as $$ begin execute 'reset role'; perform auth.logout(); execute 'reset role'; end $$;
create or replace function pg_temp.login(p_email text) returns void language plpgsql as $$
declare u uuid; begin
  perform pg_temp.su(); select id into u from auth.users where email = p_email;
  perform set_config('request.jwt.claims', jsonb_build_object('sub', u, 'role', 'authenticated', 'email', p_email, 'aal', 'aal1')::text, false);
  perform set_config('role', 'authenticated', false);
end $$;
create or replace function pg_temp.anon() returns void language plpgsql as $$ begin perform pg_temp.su(); perform set_config('request.jwt.claims', '{"role":"anon"}', false); perform set_config('role', 'anon', false); end $$;
create or replace function pg_temp.svc() returns void language plpgsql as $$ begin perform pg_temp.su(); perform set_config('request.jwt.claims', '{"role":"service_role"}', false); perform set_config('role', 'service_role', false); end $$;
create or replace function pg_temp.res(p_name text, p_ok boolean, p_detail text default '') returns void language plpgsql as $$
begin insert into _rc values (p_name, case when coalesce(p_ok, false) then 'PASS' else 'FAIL: ' || left(coalesce(p_detail, ''), 400) end); end $$;
create or replace function pg_temp.j(p_sql text) returns jsonb language plpgsql as $$
declare v jsonb; begin execute p_sql into v; return v; exception when others then return jsonb_build_object('err', sqlstate || ' ' || sqlerrm); end $$;
create or replace function pg_temp.put(p_k text, p_v text) returns void language sql as $$ insert into _kv values (p_k, p_v) on conflict (k) do update set v = excluded.v $$;
create or replace function pg_temp.get(p_k text) returns text language sql as $$ select v from _kv where k = p_k $$;
create or replace function pg_temp.member(p_email text, p_role text, p_org uuid, p_name text) returns uuid language plpgsql as $$
declare u uuid; begin
  perform pg_temp.su(); select id into u from auth.users where email = p_email; if u is null then u := auth.seed_user(p_email); end if;
  insert into public.profiles(id, email, full_name, role, org_id, must_change_password, created_at) values (u, p_email, p_name, p_role, p_org, false, now())
    on conflict (id) do update set org_id = excluded.org_id, role = excluded.role, full_name = excluded.full_name;
  return u; end $$;
-- helpers: ask as the planner (answers the row), the vendor's answer (signed out), an uploaded file
create or replace function pg_temp.ask(p jsonb) returns jsonb language plpgsql as $$
declare v jsonb; begin perform pg_temp.login('vf_plan@a.test'); v := pg_temp.j(format('select public.vendor_request_ask(%L::jsonb)', p)); perform pg_temp.su(); return v; end $$;
create or replace function pg_temp.offer(p_tok text, p jsonb) returns jsonb language plpgsql as $$
declare v jsonb; begin perform pg_temp.anon(); v := pg_temp.j(format('select public.vendor_link_offer(%L, %L::jsonb)', p_tok, p)); perform pg_temp.su(); return v; end $$;
create or replace function pg_temp.review(p_offer text, p_act text, p_note text default null, p_who text default 'vf_plan@a.test', p_send boolean default false) returns jsonb language plpgsql as $$
declare v jsonb; begin perform pg_temp.login(p_who); v := pg_temp.j(format('select public.vendor_offer_review(%L::uuid, %L, %L, %L)', p_offer, p_act, p_note, p_send)); perform pg_temp.su(); return v; end $$;
create or replace function pg_temp.upload(p_tok text, p_mime text, p_fn text) returns text language plpgsql as $$
declare g jsonb; begin perform pg_temp.anon(); g := pg_temp.j(format('select public.%I(%L, %L)', p_fn, p_tok, p_mime)); perform pg_temp.su();
  if g ? 'err' then return g ->> 'err'; end if; if g ->> 'path' is null then return null; end if; insert into storage.objects(bucket_id, name) values ('vendor-invoices', g ->> 'path'); return g ->> 'path'; end $$;
create or replace function pg_temp.inv(p_tok text, p jsonb) returns jsonb language plpgsql as $$
declare v jsonb; begin perform pg_temp.anon(); v := pg_temp.j(format('select public.vendor_invoice_submit(%L, %L::jsonb)', p_tok, p)); perform pg_temp.su(); return v; end $$;
create or replace function pg_temp.lk(p_req text) returns text language plpgsql as $$
declare v jsonb; begin perform pg_temp.login('vf_plan@a.test'); v := pg_temp.j(format('select public.vendor_request_link(%L::uuid)', p_req)); perform pg_temp.su(); return v ->> 'token'; end $$;
grant execute on all functions in schema pg_temp to anon, authenticated, service_role;

do $$ declare a uuid := 'a0000000-0000-4000-8000-000000000001'; b uuid := 'b0000000-0000-4000-8000-000000000001'; adm uuid; pl uuid; cv uuid; v uuid; h integer := extract(hour from now() at time zone 'utc')::int; z integer; begin
  pl := pg_temp.member('vf_plan@a.test', 'supervisor', a, 'Pooja Planner'); perform pg_temp.member('vf_fin@a.test', 'manager', a, 'Fiona Finance'); perform pg_temp.member('vf_crew@a.test', 'crew', a, 'Crew Person');
  perform pg_temp.member('vf_view@a.test', 'quality', a, 'Vani Viewer'); perform pg_temp.member('vf_plan@b.test', 'supervisor', b, 'B Planner'); perform pg_temp.su();
  select id into adm from public.profiles where email = 'a_admin@a.test';
  insert into public.role_access(role, area, can_view, can_edit, org_id, updated_at) values ('supervisor', 'vendors', true, true, a, now()), ('supervisor', 'finance', false, false, a, now()), ('supervisor', 'controls', false, false, a, now()),
    ('manager', 'vendors', true, false, a, now()), ('manager', 'finance', true, true, a, now()), ('crew', 'vendors', false, false, a, now()), ('crew', 'finance', false, false, a, now()),
    ('quality', 'vendors', true, false, a, now()), ('quality', 'finance', false, false, a, now()), ('supervisor', 'vendors', true, true, b, now())
  on conflict (role, area, org_id) do update set can_view = excluded.can_view, can_edit = excluded.can_edit;
  -- a studio clock where it is now about noon (the 10:00 slot is open)
  z := 12 - h; update public.organizations set timezone = 'Etc/GMT' || case when z >= 0 then '-' || z else '+' || (-z) end, country = 'IN', currency = 'INR' where id = a;
  insert into public.quotes(id, code, title, event_type, status, client, pricing, current_version, approval_status, org_id, created_at, updated_at, event_date, lifecycle_stage, currency)
    values ('a0000000-0000-4000-8000-00000000f447', 'A-447', 'Sharma secret wedding', 'wedding', 'confirmed', '{"name":"Mrs Sharma"}', '{}', 1, 'approved', a, now(), now(), current_date + 5, 'planning', 'INR'),
           ('b0000000-0000-4000-8000-00000000f447', 'B-447', 'B event', 'wedding', 'confirmed', '{}', '{}', 1, 'approved', b, now(), now(), current_date + 5, 'planning', 'INR');
  insert into public.vendors(id, name, category, email, phone, org_id) values ('a0000000-0000-4000-8000-0000000fa001', 'Deccan Rentals', 'Furniture', 'Orders@Deccan.test', '+919876543210', a),
    ('a0000000-0000-4000-8000-0000000fa002', 'Royal Tents', 'Tents', 'royal@tents.test', null, a), ('a0000000-0000-4000-8000-0000000fa003', 'Sound Co', 'Sound', null, null, a);
  insert into public.vendors(id, name, category, email, org_id) values ('b0000000-0000-4000-8000-0000000fb001', 'B Vendor', 'Furniture', 'b@vendor.test', b);
  insert into public.event_resource_needs(id, quote_id, kind, label, qty, org_id) values ('a0000000-0000-4000-8000-0000000fd001', 'a0000000-0000-4000-8000-00000000f447', 'other', 'Chairs', 12, a);
  insert into public.chat_conversations(id, org_id, kind, title, quote_id, created_by) values (gen_random_uuid(), a, 'group', 'Event group A-447', 'a0000000-0000-4000-8000-00000000f447', adm) returning id into cv;
  insert into public.chat_members(conversation_id, user_id, org_id) values (cv, adm, a);
end $$;
create or replace function pg_temp.rq(p jsonb default '{}') returns jsonb language sql as $$
  select jsonb_build_object('quote_id', 'a0000000-0000-4000-8000-00000000f447', 'vendor_id', 'a0000000-0000-4000-8000-0000000fa001', 'when_at', (now() + interval '4 days')::text, 'where_text', 'Lawn gate 2', 'lines',
    '[{"name":"Chairs","qty":12,"price":50,"unit":"pcs","need_id":"a0000000-0000-4000-8000-0000000fd001"},{"name":"Tables","qty":4,"price":250}]'::jsonb) || p $$;
grant execute on all functions in schema pg_temp to anon, authenticated, service_role;

create or replace function pg_temp.bill(p_tok text, p_no text, p_tax numeric, p jsonb) returns jsonb language plpgsql as $$
begin return pg_temp.inv(p_tok, jsonb_build_object('invoice_no', p_no, 'invoice_date', to_char(current_date, 'YYYY-MM-DD'), 'taxable_amount', p_tax, 'file_path', pg_temp.upload(p_tok, 'application/pdf', 'vendor_invoice_upload')) || p); end $$;
grant execute on all functions in schema pg_temp to anon, authenticated, service_role;
do $$ declare r jsonb; x jsonb; t text; ok text := '[{"name":"Chairs","qty":12,"price":50},{"name":"Tables","qty":4,"price":250}]'; begin
  perform pg_temp.res('01 nothing stored changed by the file (run twice)', (select b.vr = (select count(*) from public.vendor_requests) from _before b) and (select count(*) = 1 from pg_trigger where tgname = 'r452_invoice_price'));
  -- approved 12 chairs at 50 + 4 tables at 250 = 1600, at once (exactly as asked)
  r := pg_temp.ask(pg_temp.rq('{}')); t := r #>> '{link,token}'; perform pg_temp.put('r', r ->> 'id');
  x := pg_temp.offer(t, jsonb_build_object('available', true, 'mode', 'lines', 'total', 1600, 'lines', (select jsonb_agg(jsonb_build_object('id', l ->> 'id', 'qty', (l ->> 'qty')::numeric, 'price', (l ->> 'price')::numeric)) from jsonb_array_elements(r -> 'lines') l)));
  perform pg_temp.res('02 accepted at the agreed price', x ->> 'status' = 'accepted', x::text);
  x := pg_temp.bill(t, 'A1', 1640, jsonb_build_object('lines', '[{"name":"Chairs","qty":12,"price":50},{"name":"Tables","qty":4,"price":260}]'::jsonb));
  perform pg_temp.res('03 a higher price is refused, in words', x ->> 'err' like '22023 the price of Tables was approved at 250 and cannot be changed%', x::text);
  x := pg_temp.bill(t, 'A1', 1560, jsonb_build_object('lines', '[{"name":"Chairs","qty":12,"price":50},{"name":"Tables","qty":4,"price":240}]'::jsonb));
  perform pg_temp.res('04 a lower price too (a discount is the way)', x ->> 'err' like '22023 the price of Tables%', x::text);
  x := pg_temp.bill(t, 'A1', 1650, jsonb_build_object('lines', '[{"name":"Chairs","qty":13,"price":50},{"name":"Tables","qty":4,"price":250}]'::jsonb));
  perform pg_temp.res('05 more pieces refused', x ->> 'err' like '22023 the quantity of Chairs%', x::text);
  x := pg_temp.bill(t, 'A1', 1650, jsonb_build_object('lines', '[{"name":"Chairs","qty":6,"price":50},{"name":"chairs ","qty":7,"price":50},{"name":"Tables","qty":4,"price":250}]'::jsonb));
  perform pg_temp.res('06 the same product twice does not get around it', x ->> 'err' like '22023 the quantity of%', x::text);
  x := pg_temp.bill(t, 'A1', 1700, jsonb_build_object('lines', (ok::jsonb || '[{"name":"Linen","qty":1,"price":100}]'::jsonb)));
  perform pg_temp.res('07 another product refused', x ->> 'err' like '22023 the product Linen is not part%', x::text);
  x := pg_temp.bill(t, 'A1', 1700, jsonb_build_object('lines', ok::jsonb, 'charges', 100));
  perform pg_temp.res('08 new delivery charges refused', x ->> 'err' like '22023 the delivery%', x::text);
  x := pg_temp.bill(t, 'A1', 1700, '{}');
  perform pg_temp.res('09 no product list: the total still holds', x ->> 'err' like '22023 the invoice is more than the approved price (1600%', x::text);
  perform pg_temp.res('10 nothing was stored by the refused ones', not exists (select 1 from public.vendor_invoices i where i.request_id = pg_temp.get('r')::uuid));
  x := pg_temp.bill(t, 'A1', 850, jsonb_build_object('lines', '[{"name":"Chairs","qty":12,"price":50},{"name":"Tables","qty":1,"price":250}]'::jsonb));
  perform pg_temp.res('11 fewer pieces at the approved price: fine', x ->> 'submitted' = 'A1', x::text);
  x := pg_temp.bill(t, 'A2', 1600, jsonb_build_object('lines', ok::jsonb));
  perform pg_temp.res('12 a second invoice cannot bill the same again', x ->> 'err' like '22023 the invoice is more than the approved price%together with%', x::text);
  x := pg_temp.bill(t, 'A2', 750, jsonb_build_object('lines', '[{"name":"Tables","qty":3,"price":250}]'::jsonb));
  perform pg_temp.res('13 the rest of it: fine', x ->> 'submitted' = 'A2', x::text);
  update public.vendor_invoices set status = 'rejected' where request_id = pg_temp.get('r')::uuid and invoice_no in ('A1', 'A2');
  x := pg_temp.bill(t, 'A3', 1550, jsonb_build_object('lines', ok::jsonb, 'discount', 50, 'cgst', 139.5, 'sgst', 139.5, 'vendor_gstin', '36ABCDE1234F1Z5'));
  perform pg_temp.res('14 rejected ones do not count; a discount and GST on top: fine', x ->> 'submitted' = 'A3', x::text);
  -- one total for several products
  r := pg_temp.ask(pg_temp.rq('{"lines":[{"name":"PA","qty":1},{"name":"Mic","qty":6}],"agreed_total":9000,"vendor_id":"a0000000-0000-4000-8000-0000000fa003","send":false}')); t := r #>> '{link,token}';
  x := pg_temp.offer(t, jsonb_build_object('available', true, 'mode', 'total', 'total', 9000, 'lines', (select jsonb_agg(jsonb_build_object('id', l ->> 'id', 'qty', (l ->> 'qty')::numeric)) from jsonb_array_elements(r -> 'lines') l)));
  x := pg_temp.bill(t, 'T1', 9100, '{"lines":[{"name":"PA","qty":1,"price":8500},{"name":"Mic","qty":6,"price":100}]}');
  perform pg_temp.res('15 one total: above it refused', x ->> 'err' like '22023 the invoice is more%', x::text);
  x := pg_temp.bill(t, 'T1', 9000, '{"lines":[{"name":"PA","qty":1,"price":8400},{"name":"Mic","qty":6,"price":100}]}');
  perform pg_temp.res('16 one total: at it fine', x ->> 'submitted' = 'T1', x::text);
end $$;
select name, result from _rc where result <> 'PASS' order by name;
select 'R262-INVOICE-PRICE-0452: ' || case when count(*) filter (where result <> 'PASS') = 0 then 'ALL PASS' else 'FAIL' end || ' (' || count(*) filter (where result = 'PASS') || '/' || count(*) || ')' from _rc;
rollback;
