-- r259-vendor-flow-0447.sql - R259 (25 Nov 2026): one vendor flow. Proves: structure after two runs and no stored row changed; products + agreed price
-- rules; the answer at the agreed price confirms at once; a changed price / quantity waits (approve, ask to change, decline), stale answers, the same
-- press twice; not available + changing the mind; files (grant, other purpose, other link); invoice lines that must add up, over-agreed tick, GST only in
-- India + one tax amount elsewhere, bill currency; invoice e-mails: once per slot, stops, switch, only requests confirmed after the file; invoice-only
-- requests; the old dispatcher never gets the new kinds; rights, studio isolation, trial, sample, cancelled event, anon; kept bodies, trial clean-up.
-- Rolled back. Local disposable PG only. Fake data. Nothing is ever sent.
\set ON_ERROR_STOP 0
set client_min_messages = error;
begin;
create temp table _before as select (select md5(coalesce(string_agg((to_jsonb(q))::text, '|' order by q.id), '')) from public.quotes q) as qs,
  (select md5(coalesce(string_agg(to_jsonb(r)::text, '|' order by r.id), '')) from public.event_resources r) as rs, (select count(*) from public.vendor_requests) as vr, (select count(*) from public.notifications) as nt;
\o /dev/null
\i supabase/migrations/0447_r259_vendor_flow.sql
\i supabase/migrations/0447_r259_vendor_flow.sql
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

select pg_temp.res('01 no stored row changed by the file (run twice), nothing queued or rung', (select b.qs = md5(coalesce((select string_agg((to_jsonb(q))::text, '|' order by q.id) from public.quotes q), ''))
  and b.rs = md5(coalesce((select string_agg(to_jsonb(r)::text, '|' order by r.id) from public.event_resources r), '')) and b.vr = (select count(*) from public.vendor_requests) and b.nt = (select count(*) from public.notifications) from _before b));
select pg_temp.res('02 kept bodies once, closed to the app; a second run keeps the same ones', (select count(*) = 16 and bool_and(not has_function_privilege('authenticated', p.oid, 'execute')) from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname like '%\_\_pre0447')
  and not exists (select 1 from pg_proc p where p.proname like '%pre0447\_\_pre0447'));
select pg_temp.res('03 the offers table is closed and in the trial clean-up', not has_table_privilege('authenticated', 'public.vendor_offers', 'select') and not has_table_privilege('anon', 'public.vendor_offers', 'select') and not has_table_privilege('service_role', 'public.vendor_offers', 'insert')
  and position('vendor_offers' in pg_get_functiondef('public._tr184_purge_tables()'::regprocedure)) > 0);
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

-- A) asking
do $$ declare r jsonb; x jsonb; q record; begin
  r := pg_temp.ask(pg_temp.rq('{"key":"a0000000-0000-4000-8000-0000000fe001"}')); perform pg_temp.put('r1', r ->> 'id'); perform pg_temp.put('t1', r #>> '{link,token}');
  perform pg_temp.res('10 two products, all priced: the agreed total is their sum', (r ->> 'agreed_amount')::numeric = 1600 and jsonb_array_length(r -> 'lines') = 2 and r ->> 'state' = 'asked' and r ->> 'what' = 'Chairs, Tables' and r ->> 'qty' is null and r ->> 'currency' = 'INR', r::text);
  select * into q from public.event_resources b where b.id = (r ->> 'booking_id')::uuid;
  perform pg_temp.res('11 one booking, asked, at that amount; the request e-mail is queued once', q.status = 'enquiry' and q.cost = 1600 and (select count(*) from public.vendor_request_sends s where s.request_id = (r ->> 'id')::uuid and s.channel = 'email' and s.kind = 'request' and s.status = 'pending') = 1, r::text);
  x := pg_temp.ask(pg_temp.rq('{"key":"a0000000-0000-4000-8000-0000000fe001"}'));
  perform pg_temp.res('12 the same press twice = one request', x ->> 'id' = r ->> 'id' and (x ->> 'same')::boolean and (select count(*) from public.vendor_requests v where v.client_key = 'a0000000-0000-4000-8000-0000000fe001') = 1, x::text);
  r := pg_temp.ask(pg_temp.rq('{"lines":[{"name":"Tent","qty":1}],"vendor_id":"a0000000-0000-4000-8000-0000000fa002"}')); perform pg_temp.put('r2', r ->> 'id'); perform pg_temp.put('t2', r #>> '{link,token}');
  perform pg_temp.res('13 no price: the vendor tells it; the booking has no cost yet (not 0)', (r ->> 'price_open')::boolean and r ->> 'agreed_amount' is null and (select b.cost is null from public.event_resources b where b.id = (r ->> 'booking_id')::uuid), r::text);
  r := pg_temp.ask(pg_temp.rq('{"lines":[{"name":"PA","qty":1},{"name":"Mic","qty":6}],"agreed_total":9000,"vendor_id":"a0000000-0000-4000-8000-0000000fa003","send":false}')); perform pg_temp.put('r3', r ->> 'id'); perform pg_temp.put('t3', r #>> '{link,token}');
  perform pg_temp.res('14 a typed total; no e-mail address: nothing queued, the link is there', (r ->> 'agreed_amount')::numeric = 9000 and not (r ->> 'price_open')::boolean and (r ->> 'queued')::int = 0 and (r #>> '{link,token}') ~ '^[0-9a-f]{64}$', r::text);
  perform pg_temp.res('15 refused: no products, 31 products, quantity 0, minus price, 3 decimals, a tag, text as a number, an unknown field',
    pg_temp.ask(pg_temp.rq('{"lines":[]}')) ->> 'err' like '22023%' and pg_temp.ask(pg_temp.rq(jsonb_build_object('lines', (select jsonb_agg(jsonb_build_object('name', 'x' || i, 'qty', 1)) from generate_series(1, 31) i)))) ->> 'err' like '22023%'
    and pg_temp.ask(pg_temp.rq('{"lines":[{"name":"a","qty":0}]}')) ->> 'err' like '22023%' and pg_temp.ask(pg_temp.rq('{"lines":[{"name":"a","qty":1,"price":-1}]}')) ->> 'err' like '22023%' and pg_temp.ask(pg_temp.rq('{"lines":[{"name":"a","qty":1,"price":1.234}]}')) ->> 'err' like '22023%'
    and pg_temp.ask(pg_temp.rq('{"lines":[{"name":"<b>","qty":1}]}')) ->> 'err' like '22023%' and pg_temp.ask(pg_temp.rq('{"lines":[{"name":"a","qty":"1"}]}')) ->> 'err' like '22023%' and pg_temp.ask(pg_temp.rq('{"lines":[{"name":"a","qty":1,"cost":1}]}')) ->> 'err' like '22023%');
  perform pg_temp.login('vf_view@a.test'); x := pg_temp.j(format('select public.vendor_request_ask(%L::jsonb)', pg_temp.rq())); perform pg_temp.login('vf_crew@a.test'); r := pg_temp.j(format('select public.vendor_request_ask(%L::jsonb)', pg_temp.rq())); perform pg_temp.su();
  perform pg_temp.res('16 asking needs Vendors edit (viewer + crew refused)', x ->> 'err' like '42501%' and r ->> 'err' like '42501%', x::text);
  perform pg_temp.login('vf_plan@b.test'); x := pg_temp.j(format('select public.vendor_request_ask(%L::jsonb)', pg_temp.rq())); r := pg_temp.j(format('select public.vendor_offer_review(%L, %L)', gen_random_uuid(), 'approve')); perform pg_temp.su();
  perform pg_temp.res('17 another studio: their event, not mine', x ->> 'err' like 'P0002%' and r ->> 'err' like 'P0002%', x::text || r::text);
  perform pg_temp.anon(); x := pg_temp.j('select public.vendor_request_ask(''{}'')'); r := pg_temp.j('select public.vendor_flow_claim(5)'); perform pg_temp.su();
  perform pg_temp.res('18 signed out: the studio calls and the dispatcher are closed', x ->> 'err' like '42501%' and r ->> 'err' like '42501%', x::text);
end $$;

-- B) the link page
do $$ declare p jsonb; begin
  perform pg_temp.anon(); p := public.vendor_link_get(pg_temp.get('t1')); perform pg_temp.su();
  perform pg_temp.res('20 the page: the products with the agreed price, event by type, currency, GST, the studio''s day', (p ->> 'flow') = '447' and jsonb_array_length(p -> 'lines') = 2 and (p #>> '{lines,0,price}')::numeric = 50 and p ->> 'event' = 'Wedding' and p ->> 'currency' = 'INR' and (p ->> 'gst')::boolean and p ->> 'today' ~ '^\d{4}-\d\d-\d\d$' and (p ->> 'can_respond')::boolean, p::text);
  perform pg_temp.res('21 nothing of the client, other vendors, the need or the studio''s money', p::text !~ 'Sharma|secret|need_id|Royal|storage_path|contact_|org_id', p::text);
end $$;
do $$ declare p jsonb; b record; e jsonb; begin
  p := pg_temp.offer(pg_temp.get('t1'), '{"available":true,"mode":"lines","lines":[{"id":"l1","qty":12,"price":50},{"id":"l2","qty":4,"price":250}],"total":1600,"note":"Ready at 9","key":"a0000000-0000-4000-8000-0000000fe011"}');
  select * into b from public.event_resources x where x.id = (select booking_id from public.vendor_requests where id = pg_temp.get('r1')::uuid);
  perform pg_temp.res('22 at the agreed price and full quantity = accepted at once, as Accept does', p ->> 'status' = 'accepted' and b.status = 'confirmed' and b.cost = 1600 and (select r.confirmed_at is not null and r.delivery_id is not null and r.response_note = 'Ready at 9' from public.vendor_requests r where r.id = pg_temp.get('r1')::uuid)
    and (select count(*) = 1 and bool_and(o.status = 'approved') from public.vendor_offers o where o.request_id = pg_temp.get('r1')::uuid), p::text);
  perform pg_temp.res('23 the bell and the event chat say it (no money)', exists (select 1 from public.notifications n where n.detail ->> 'vendor_request_id' = pg_temp.get('r1') and n.detail ->> 'event' = 'accepted') and not exists (select 1 from public.notifications n where n.detail ->> 'vendor_request_id' = pg_temp.get('r1') and n.detail ->> 'label' ~ '1600')
    and exists (select 1 from public.chat_messages m where m.meta ->> 'vendor_request_id' = pg_temp.get('r1')));
  e := pg_temp.offer(pg_temp.get('t1'), '{"available":true,"mode":"lines","lines":[{"id":"l1","qty":12,"price":50},{"id":"l2","qty":4,"price":250}],"total":1600,"key":"a0000000-0000-4000-8000-0000000fe011"}');
  perform pg_temp.res('24 the same press again: the same answer, nothing doubled', (e ->> 'ok')::boolean and (select count(*) from public.vendor_offers where request_id = pg_temp.get('r1')::uuid) = 1 and (select count(*) from public.vendor_request_log l where l.request_id = pg_temp.get('r1')::uuid and l.event = 'accepted') = 1, e::text);
  e := pg_temp.offer(pg_temp.get('t1'), '{"available":false,"reason":"cannot any more"}');
  perform pg_temp.res('25 after it is confirmed the vendor cannot change it here', e ->> 'reason' = 'closed' and (select status from public.vendor_requests where id = pg_temp.get('r1')::uuid) = 'accepted', e::text);
end $$;

-- C) changed price / quantity, ask to change, approve, decline
do $$ declare r jsonb; p jsonb; o jsonb; x jsonb; b record; t text; path text; begin
  r := pg_temp.ask(pg_temp.rq('{"lines":[{"name":"Chairs","qty":12,"price":50}],"send":false}')); perform pg_temp.put('r4', r ->> 'id'); t := r #>> '{link,token}'; perform pg_temp.put('t4', t);
  perform pg_temp.res('30 refused answers: more than asked, no price, minus, 3 decimals, wrong total, discount above the price, all 0, missing / unknown / doubled product, a tag',
    pg_temp.offer(t, '{"available":true,"lines":[{"id":"l1","qty":13,"price":50}]}') ->> 'err' like '22023%' and pg_temp.offer(t, '{"available":true,"lines":[{"id":"l1","qty":12}]}') ->> 'err' like '22023%' and pg_temp.offer(t, '{"available":true,"lines":[{"id":"l1","qty":12,"price":-5}]}') ->> 'err' like '22023%'
    and pg_temp.offer(t, '{"available":true,"lines":[{"id":"l1","qty":12,"price":5.555}]}') ->> 'err' like '22023%' and pg_temp.offer(t, '{"available":true,"lines":[{"id":"l1","qty":12,"price":50}],"total":10}') ->> 'err' like '22023%' and pg_temp.offer(t, '{"available":true,"lines":[{"id":"l1","qty":12,"price":50}],"discount":700}') ->> 'err' like '22023%'
    and pg_temp.offer(t, '{"available":true,"lines":[{"id":"l1","qty":0,"price":50}]}') ->> 'err' like '22023%' and pg_temp.offer(t, '{"available":true,"lines":[]}') ->> 'err' like '22023%' and pg_temp.offer(t, '{"available":true,"lines":[{"id":"l9","qty":1,"price":5}]}') ->> 'err' like '22023%'
    and pg_temp.offer(t, '{"available":true,"lines":[{"id":"l1","qty":1,"price":5}],"note":"<b>"}') ->> 'err' like '22023%' and pg_temp.offer(t, '{"lines":[]}') ->> 'err' like '22023%' and not exists (select 1 from public.vendor_offers where request_id = pg_temp.get('r4')::uuid));
  path := pg_temp.upload(t, 'application/pdf', 'vendor_offer_upload');
  p := pg_temp.offer(t, jsonb_build_object('available', true, 'mode', 'lines', 'lines', '[{"id":"l1","qty":8,"price":60}]'::jsonb, 'charges', 100, 'discount', 30.5, 'total', 549.5, 'note', 'Only 8', 'file_path', path));
  perform pg_temp.put('path4', path);
  perform pg_temp.res('31 8 of 12 at another price + delivery - discount: the total is worked out, it waits, nothing is booked', p ->> 'status' = 'sent' and p #>> '{offer,status}' = 'offered' and (p #>> '{offer,total}')::numeric = 549.5 and (p #>> '{offer,has_file}')::boolean
    and (select e.status = 'enquiry' and e.cost = 600 and e.qty = 12 from public.event_resources e where e.id = (r ->> 'booking_id')::uuid), p::text);
  perform pg_temp.login('vf_plan@a.test'); x := public.vendor_requests_list('a0000000-0000-4000-8000-00000000f447', null); perform pg_temp.su();
  o := (select y from jsonb_array_elements(x) y where y ->> 'id' = pg_temp.get('r4'));
  perform pg_temp.res('32 the studio sees it: state, lines, total, the file, not overdue; a summary count', o ->> 'state' = 'available' and (o ->> 'offer_open')::boolean and (o #>> '{offer,total}')::numeric = 549.5 and o #>> '{offer,storage_path}' = path and not (o ->> 'overdue_reply')::boolean, o::text);
  perform pg_temp.login('vf_plan@a.test'); x := public.vendor_requests_summary('a0000000-0000-4000-8000-00000000f447');
  perform pg_temp.res('33 summary: one price to approve; the file can be opened by that studio, not by a viewer or another studio', (x ->> 'offers_to_review')::int = 1 and public.vendor_invoice_file_visible(path), x::text);
  perform pg_temp.login('vf_view@a.test'); x := public.vendor_requests_list('a0000000-0000-4000-8000-00000000f447', null);
  perform pg_temp.res('34 a Vendors viewer without money sees the answer without any price', not public.vendor_invoice_file_visible(path) and (select y #>> '{offer,status}' = 'offered' and y #> '{offer,total}' is null and y::text !~ '549|asked_price|"price"|storage_path' from jsonb_array_elements(x) y where y ->> 'id' = pg_temp.get('r4')), x::text);
  perform pg_temp.login('vf_plan@b.test'); perform pg_temp.res('35 another studio cannot open the file', not public.vendor_invoice_file_visible(path));
  perform pg_temp.su();
  perform pg_temp.res('36 approving needs Vendors edit: finance-only, viewer and crew are refused', pg_temp.review(o #>> '{offer,id}', 'approve', null, 'vf_fin@a.test') ->> 'err' like '42501%' and pg_temp.review(o #>> '{offer,id}', 'approve', null, 'vf_view@a.test') ->> 'err' like '42501%' and pg_temp.review(o #>> '{offer,id}', 'approve', null, 'vf_crew@a.test') ->> 'err' like '42501%');
  perform pg_temp.res('37 another studio cannot approve it', pg_temp.review(o #>> '{offer,id}', 'approve', null, 'vf_plan@b.test') ->> 'err' like 'P0002%');
  perform pg_temp.res('38 ask to change needs words', pg_temp.review(o #>> '{offer,id}', 'change', '') ->> 'err' like '22023%');
  x := pg_temp.review(o #>> '{offer,id}', 'change', 'Please do 50 each', 'vf_plan@a.test', true);
  perform pg_temp.res('39 ask to change: the vendor sees the words, the e-mail is queued once, the booking is untouched', x ->> 'state' = 'change' and x #>> '{offer,review_note}' = 'Please do 50 each' and (x #>> '{mail,queued}')::boolean
    and (select count(*) from public.vendor_request_sends s where s.request_id = pg_temp.get('r4')::uuid and s.kind = 'change') = 1, x::text);
  perform pg_temp.res('40 the decided answer cannot be approved any more', pg_temp.review(o #>> '{offer,id}', 'approve') ->> 'err' like '22023%');
  p := pg_temp.offer(t, '{"available":true,"lines":[{"id":"l1","qty":10,"price":50}],"total":500}');
  perform pg_temp.res('41 a new answer: the older one is kept as superseded, the file of the first stays', (select count(*) = 2 and count(*) filter (where status = 'superseded' and storage_path is not null) = 1 and count(*) filter (where status = 'offered') = 1 from public.vendor_offers where request_id = pg_temp.get('r4')::uuid)
    and exists (select 1 from public.notifications n where n.detail ->> 'vendor_request_id' = pg_temp.get('r4') and n.detail ->> 'event' = 'offer_again'), p::text);
  x := pg_temp.review(p #>> '{offer,id}', 'approve', null, 'vf_plan@a.test', true);
  select * into b from public.event_resources y where y.id = (r ->> 'booking_id')::uuid;
  perform pg_temp.res('42 approve: booked at that amount; the one-product booking takes the 10 the vendor brings', x ->> 'state' = 'confirmed' and (x ->> 'agreed_amount')::numeric = 500 and (x ->> 'asked_amount')::numeric = 600 and b.status = 'confirmed' and b.cost = 500 and b.qty = 10 and (x ->> 'qty')::numeric = 10, x::text || to_jsonb(b)::text);
  perform pg_temp.res('43 every step is in the history (old -> new amounts), the delivery is scheduled, the confirm e-mail queued', (select array_agg(l.event order by l.at) @> array['sent', 'offer', 'offer_change', 'offer_approved', 'booking_confirmed', 'booking_quantity'] from public.vendor_request_log l where l.request_id = pg_temp.get('r4')::uuid)
    and (select r.delivery_id is not null from public.vendor_requests r where r.id = pg_temp.get('r4')::uuid) and (x #>> '{mail,queued}')::boolean);
  perform pg_temp.res('44 pressed twice: the same answer, one booking confirmation', (pg_temp.review(p #>> '{offer,id}', 'approve') ->> 'same')::boolean and (select count(*) from public.vendor_request_log l where l.request_id = pg_temp.get('r4')::uuid and l.event = 'booking_confirmed') = 1);
  perform pg_temp.res('45 an answer''s content can never be changed', pg_temp.j(format('with u as (update public.vendor_offers set total = 1 where id = %L returning 1) select to_jsonb(count(*)) from u', p #>> '{offer,id}')) ->> 'err' like '42501%');
end $$;

-- price open, one total, decline, not available + back, stale approve, reassign, phone
do $$ declare r jsonb; p jsonb; x jsonb; t text := pg_temp.get('t2'); o1 text; begin
  perform pg_temp.login('vf_plan@a.test'); x := pg_temp.j(format('select public.vendor_request_set_status(%L, %L, null)', pg_temp.get('r2'), 'accepted')); perform pg_temp.anon(); r := pg_temp.j(format('select public.vendor_link_respond(%L, %L, null)', t, 'accept')); perform pg_temp.su();
  perform pg_temp.res('50 no price yet: an old Accept (page or by phone) is refused, nothing is booked at 0', x ->> 'err' like '22023%' and r ->> 'err' like '22023 enter%' and (select status from public.vendor_requests where id = pg_temp.get('r2')::uuid) = 'sent', x::text || r::text);
  perform pg_temp.res('51 one total price: needs the total, no charges next to it, above 0', pg_temp.offer(t, '{"available":true,"mode":"total","lines":[{"id":"l1","qty":1}]}') ->> 'err' like '22023%' and pg_temp.offer(t, '{"available":true,"mode":"total","lines":[{"id":"l1","qty":1}],"total":0}') ->> 'err' like '22023%'
    and pg_temp.offer(t, '{"available":true,"mode":"total","lines":[{"id":"l1","qty":1}],"total":500,"charges":1}') ->> 'err' like '22023%');
  p := pg_temp.offer(t, '{"available":true,"mode":"total","lines":[{"id":"l1","qty":1}],"total":45000}'); o1 := p #>> '{offer,id}';
  perform pg_temp.res('52 one total price waits for the studio', p #>> '{offer,mode}' = 'total' and (p #>> '{offer,total}')::numeric = 45000 and p ->> 'status' = 'sent', p::text);
  p := pg_temp.offer(t, '{"available":false,"reason":"Booked that day"}');
  perform pg_temp.res('53 not available: declined with the reason, the offer is kept as withdrawn', p ->> 'status' = 'rejected' and (p ->> 'can_respond')::boolean and (select status from public.vendor_offers where id = o1::uuid) = 'withdrawn' and (select declined_by from public.vendor_requests where id = pg_temp.get('r2')::uuid) = 'vendor', p::text);
  perform pg_temp.res('54 approving the withdrawn one is refused', pg_temp.review(o1, 'approve') ->> 'err' like '22023%');
  p := pg_temp.offer(t, '{"available":true,"mode":"total","lines":[{"id":"l1","qty":1}],"total":40000}');
  perform pg_temp.res('55 they change their mind: open again with the new price', p ->> 'status' = 'sent' and (p #>> '{offer,total}')::numeric = 40000 and (select declined_by is null from public.vendor_requests where id = pg_temp.get('r2')::uuid), p::text);
  x := pg_temp.review(p #>> '{offer,id}', 'decline', 'Too high for us');
  perform pg_temp.res('56 the studio declines: closed for the vendor, kept, can be given to another vendor', x ->> 'state' = 'declined' and x ->> 'declined_by' = 'studio' and pg_temp.offer(t, '{"available":true,"mode":"total","lines":[{"id":"l1","qty":1}],"total":1}') ->> 'reason' = 'closed', x::text);
  perform pg_temp.login('vf_plan@a.test'); x := pg_temp.j(format('select public.vendor_request_reassign(%L, %L, null, null)', pg_temp.get('r2'), 'a0000000-0000-4000-8000-0000000fa001')); perform pg_temp.su();
  perform pg_temp.res('57 reassign keeps the products and "tell us your price"; the booking has no cost', (x ->> 'price_open')::boolean and x #>> '{lines,0,name}' = 'Tent' and (select b.cost is null and b.vendor_id = 'a0000000-0000-4000-8000-0000000fa001' from public.event_resources b where b.id = (x ->> 'booking_id')::uuid) and x #>> '{link,token}' ~ '^[0-9a-f]{64}$', x::text);
  p := pg_temp.offer(x #>> '{link,token}', '{"available":true,"lines":[{"id":"l1","qty":1,"price":30000}]}');
  perform pg_temp.login('vf_plan@a.test'); r := pg_temp.j(format('select public.vendor_request_record_offer(%L, %L::jsonb)', x ->> 'id', '{"available":true,"lines":[{"id":"l1","qty":1,"price":28000}],"approve":true}')); perform pg_temp.su();
  perform pg_temp.res('58 told by phone: the studio records it and confirms in one step; the earlier answer is superseded', r ->> 'status' = 'accepted' and (r ->> 'agreed_amount')::numeric = 28000 and (select status from public.vendor_offers where id = (p #>> '{offer,id}')::uuid) = 'superseded', r::text);
  p := pg_temp.offer(pg_temp.get('t3'), '{"available":true,"mode":"total","lines":[{"id":"l1","qty":1},{"id":"l2","qty":6}],"total":9000}');
  perform pg_temp.res('59 a typed agreed total answered as one total = confirmed at once', p ->> 'status' = 'accepted', p::text);
end $$;
-- two answers, the older approved
do $$ declare r jsonb; a jsonb; b jsonb; begin
  r := pg_temp.ask(pg_temp.rq('{"lines":[{"name":"Lights","qty":10}],"send":false}'));
  a := pg_temp.offer(r #>> '{link,token}', '{"available":true,"lines":[{"id":"l1","qty":10,"price":10}]}'); b := pg_temp.offer(r #>> '{link,token}', '{"available":true,"lines":[{"id":"l1","qty":10,"price":99}]}');
  perform pg_temp.res('60 approving the older of two answers is refused (the studio sees the newer price first)', pg_temp.review(a #>> '{offer,id}', 'approve') ->> 'err' like '22023%' and (select status from public.vendor_requests where id = (r ->> 'id')::uuid) = 'sent');
  perform pg_temp.login('vf_plan@a.test'); perform public.vendor_request_cancel((r ->> 'id')::uuid, 'not needed'); perform pg_temp.su();
  perform pg_temp.res('61 cancelled: the waiting answer is kept as superseded and cannot be approved', (select status from public.vendor_offers where id = (b #>> '{offer,id}')::uuid) = 'superseded' and pg_temp.review(b #>> '{offer,id}', 'approve') ->> 'err' like '22023%');
end $$;
-- files: other purpose, other link, not uploaded, wrong type
do $$ declare r jsonb; t text; path text; g jsonb; begin
  r := pg_temp.ask(pg_temp.rq('{"lines":[{"name":"Flowers","qty":1}],"send":false}')); t := r #>> '{link,token}'; perform pg_temp.put('t5', t); perform pg_temp.put('r5', r ->> 'id');
  perform pg_temp.res('62 only PDF / photo; an invoice upload is refused before it is confirmed', pg_temp.upload(t, 'text/html', 'vendor_offer_upload') like '22023%' and pg_temp.upload(t, 'application/pdf', 'vendor_invoice_upload') like '22023%');
  perform pg_temp.anon(); g := public.vendor_offer_upload(t, 'image/png');
  perform pg_temp.res('63 the storage gate: this one-time key only', public.vendor_invoice_upload_ok(g ->> 'path') and not public.vendor_invoice_upload_ok(replace(g ->> 'path', '.png', '.pdf')));
  perform pg_temp.su();
  perform pg_temp.res('64 a file that never arrived, and another link''s file, are refused', pg_temp.offer(t, jsonb_build_object('available', true, 'lines', '[{"id":"l1","qty":1,"price":5}]'::jsonb, 'file_path', g ->> 'path')) ->> 'err' like '22023%'
    and pg_temp.offer(pg_temp.lk(pg_temp.get('r5')), jsonb_build_object('available', true, 'lines', '[{"id":"l1","qty":1,"price":5}]'::jsonb, 'file_path', pg_temp.upload(t, 'image/png', 'vendor_offer_upload'))) ->> 'err' like '42501%');
  perform pg_temp.res('65 a bad or unknown link: nothing', pg_temp.offer(repeat('a', 64), '{"available":true}') ->> 'ok' = 'false' and pg_temp.offer('x', '{"available":true}') ->> 'ok' = 'false');
end $$;

-- D) the invoice with its products
do $$ declare t text := pg_temp.lk(pg_temp.get('r4')); p jsonb; x jsonb; path text; base jsonb; id uuid; b record; begin
  perform pg_temp.anon(); p := public.vendor_link_get(t); perform pg_temp.su();
  perform pg_temp.res('70 the form starts from what was confirmed', (p #>> '{confirmed,total}')::numeric = 500 and (p #>> '{confirmed,lines,0,qty}')::numeric = 10 and (p #>> '{confirmed,lines,0,price}')::numeric = 50 and (p ->> 'can_invoice')::boolean, p::text);
  path := pg_temp.upload(t, 'application/pdf', 'vendor_invoice_upload');
  base := jsonb_build_object('invoice_no', 'DR/1', 'invoice_date', to_char(current_date, 'YYYY-MM-DD'), 'taxable_amount', 500, 'file_path', path, 'lines', '[{"name":"Chairs","qty":10,"price":50}]'::jsonb);
  perform pg_temp.res('71 refused: products that do not add up, minus, no product name, a file is required, one tax amount in India',
    pg_temp.inv(t, base || '{"taxable_amount":499}') ->> 'err' like '22023 the products do not add up%' and pg_temp.inv(t, base || '{"lines":[{"name":"Chairs","qty":10,"price":-50}]}') ->> 'err' like '22023%' and pg_temp.inv(t, base || '{"lines":[{"name":" ","qty":10,"price":50}]}') ->> 'err' like '22023%'
    and pg_temp.inv(t, base - 'file_path') ->> 'err' like '22023%' and pg_temp.inv(t, base || '{"tax":20}') ->> 'err' like '22023%' and not exists (select 1 from public.vendor_invoices where request_id = pg_temp.get('r4')::uuid));
  x := pg_temp.inv(t, base || '{"key":"a0000000-0000-4000-8000-0000000fe041","charges":60,"discount":10,"taxable_amount":550,"cgst":49.5,"sgst":49.5,"vendor_gstin":"36ABCDE1234F1Z5"}');
  perform pg_temp.res('72 products + delivery - discount = taxable value; kept with the invoice', (x ->> 'ok')::boolean and x ->> 'submitted' = 'DR/1' and (select i.lines #>> '{0,total}' = '500.00' or (i.lines #>> '{0,total}')::numeric = 500 from public.vendor_invoices i where i.request_id = pg_temp.get('r4')::uuid)
    and (select i.total_amount = 649 and i.charges = 60 and i.discount = 10 from public.vendor_invoices i where i.request_id = pg_temp.get('r4')::uuid), x::text);
  x := pg_temp.inv(t, base || '{"key":"a0000000-0000-4000-8000-0000000fe041","charges":60,"discount":10,"taxable_amount":550,"cgst":49.5,"sgst":49.5,"vendor_gstin":"36ABCDE1234F1Z5"}');
  perform pg_temp.res('73 the same press twice = one invoice', x ->> 'submitted' = 'DR/1' and (select count(*) from public.vendor_invoices where request_id = pg_temp.get('r4')::uuid) = 1, x::text);
  select i.id into id from public.vendor_invoices i where i.request_id = pg_temp.get('r4')::uuid;
  perform pg_temp.login('vf_plan@a.test'); x := pg_temp.j(format('select public.vendor_invoice_review(%L, %L, null, %L::jsonb)', id, 'approve', '{}')); perform pg_temp.su();
  perform pg_temp.res('74 approving an invoice still needs Finance edit', x ->> 'err' like '42501%', x::text);
  perform pg_temp.login('vf_fin@a.test'); x := pg_temp.j(format('select public.vendor_invoice_review(%L, %L, null, %L::jsonb)', id, 'approve', '{}')); p := pg_temp.j(format('select public.vendor_invoice_review(%L, %L, null, %L::jsonb)', id, 'approve', '{"allow_over":true}')); perform pg_temp.su();
  select * into b from public.vendor_bills v where v.id = (p ->> 'bill_id')::uuid;
  perform pg_temp.res('75 above the agreed amount needs the tick; then one bill as today (amount, GST, currency)', x ->> 'err' like '23514%' and p ->> 'status' = 'approved' and p #>> '{lines,0,name}' = 'Chairs' and b.amount = 649 and b.gst_amount = 99 and b.currency = 'INR' and b.booking_id is not null, x::text || p::text);
  perform pg_temp.res('76 an invoice''s products can never be changed', pg_temp.j(format('with u as (update public.vendor_invoices set lines = ''[{"a":1}]'' where id = %L returning 1) select to_jsonb(count(*)) from u', id)) ->> 'err' like '42501%');
  perform pg_temp.login('vf_plan@a.test'); x := (select y from jsonb_array_elements(public.vendor_requests_list('a0000000-0000-4000-8000-00000000f447', null)) y where y ->> 'id' = pg_temp.get('r4')); perform pg_temp.su();
  perform pg_temp.res('77 where it stands: approved, then paid', x ->> 'state' = 'invoice_approved', x ->> 'state');
  insert into public.vendor_payouts(org_id, bill_id, amount, paid_on, method) values ('a0000000-0000-4000-8000-000000000001', b.id, 649, current_date, 'upi');
  perform pg_temp.res('78 paid', public._r447_state((select r from public.vendor_requests r where r.id = pg_temp.get('r4')::uuid)) = 'paid');
  -- an old page (no products) still works
  t := pg_temp.lk(pg_temp.get('r3')); path := pg_temp.upload(t, 'image/jpeg', 'vendor_invoice_upload');
  x := pg_temp.inv(t, jsonb_build_object('invoice_no', 'SC-1', 'invoice_date', to_char(current_date, 'YYYY-MM-DD'), 'taxable_amount', 9000, 'file_path', path));
  perform pg_temp.res('79 an older page without products still sends its invoice', x ->> 'submitted' = 'SC-1' and (select i.lines is null from public.vendor_invoices i where i.request_id = pg_temp.get('r3')::uuid), x::text);
end $$;
do $$ declare r jsonb; t text; path text; x jsonb; p jsonb; iid uuid; b record; begin
  -- outside India: one tax amount, no GST; a cost unless it is ticked
  update public.organizations set country = 'AE', currency = 'AED' where id = 'a0000000-0000-4000-8000-000000000001'; update public.quotes set currency = 'AED' where id = 'a0000000-0000-4000-8000-00000000f447';
  r := pg_temp.ask(pg_temp.rq('{"lines":[{"name":"Stage","qty":1,"price":1000}],"send":false}')); t := r #>> '{link,token}'; p := pg_temp.offer(t, '{"available":true,"lines":[{"id":"l1","qty":1,"price":1000}]}');
  path := pg_temp.upload(t, 'application/pdf', 'vendor_invoice_upload');
  x := pg_temp.inv(t, jsonb_build_object('invoice_no', 'AE1', 'invoice_date', to_char(current_date, 'YYYY-MM-DD'), 'taxable_amount', 1000, 'file_path', path, 'lines', '[{"name":"Stage","qty":1,"price":1000}]'::jsonb, 'tax', 50));
  select i.id into iid from public.vendor_invoices i where i.request_id = (r ->> 'id')::uuid;
  perform pg_temp.login('vf_fin@a.test'); p := pg_temp.j(format('select public.vendor_invoice_review(%L, %L, null, %L::jsonb)', iid, 'approve', '{"allow_over":true}')); perform pg_temp.su();
  select * into b from public.vendor_bills v where v.id = (p ->> 'bill_id')::uuid;
  perform pg_temp.res('80 outside India: AED, one tax amount in the total; the bill is in AED and the tax a cost', r ->> 'currency' = 'AED' and not (x ->> 'gst')::boolean and (x #>> '{invoices,0,total_amount}')::numeric = 1050 and b.amount = 1050 and b.currency = 'AED' and b.gst_amount = 50 and b.gst_claimable is false, x::text || p::text);
  update public.organizations set country = 'IN', currency = 'INR' where id = 'a0000000-0000-4000-8000-000000000001'; update public.quotes set currency = 'INR' where id = 'a0000000-0000-4000-8000-00000000f447';
end $$;

-- E) "please send your invoice"
create or replace function pg_temp.autos(p_req text) returns integer language sql as $$ select count(*)::int from public.vendor_request_sends s where s.request_id = p_req::uuid and s.kind = 'invoice_auto' $$;
create or replace function pg_temp.tick() returns jsonb language plpgsql as $$ declare v jsonb; begin perform pg_temp.svc(); v := public.vendor_requests_tick(); perform pg_temp.su(); return v; end $$;
grant execute on all functions in schema pg_temp to anon, authenticated, service_role;
do $$ declare r jsonb; p jsonb; x jsonb; today date := (now() at time zone public.studio_timezone('a0000000-0000-4000-8000-000000000001'))::date; q uuid := 'a0000000-0000-4000-8000-00000000f447'; a uuid := 'a0000000-0000-4000-8000-000000000001'; n integer; bk uuid; begin
  r := pg_temp.ask(pg_temp.rq('{"lines":[{"name":"Sofas","qty":3,"price":500}],"send":false}')); perform pg_temp.put('r6', r ->> 'id'); p := pg_temp.offer(r #>> '{link,token}', '{"available":true,"lines":[{"id":"l1","qty":3,"price":500}]}');
  perform pg_temp.put('t6', r #>> '{link,token}'); bk := (r ->> 'booking_id')::uuid;
  update public.quotes set event_date = today where id = q; perform pg_temp.tick();
  perform pg_temp.res('90 on the event day nothing is sent', pg_temp.autos(pg_temp.get('r6')) = 0);
  update public.quotes set event_date = today - 1 where id = q;
  perform pg_temp.tick(); perform pg_temp.res('91 a request confirmed only after the event is never asked by itself', pg_temp.autos(pg_temp.get('r6')) = 0);
  update public.vendor_requests set confirmed_at = null where id = pg_temp.get('r6')::uuid; perform pg_temp.tick(); perform pg_temp.res('92 a request confirmed before this update is never asked by itself', pg_temp.autos(pg_temp.get('r6')) = 0);
  update public.vendor_requests set confirmed_at = now() - interval '30 days' where id = pg_temp.get('r6')::uuid;
  update public.automation_settings set vendor_invoice_ask_enabled = false where org_id = a; insert into public.automation_settings(org_id, vendor_invoice_ask_enabled) values (a, false) on conflict (org_id) do update set vendor_invoice_ask_enabled = false;
  perform pg_temp.tick(); perform pg_temp.res('93 switched off: nothing', pg_temp.autos(pg_temp.get('r6')) = 0);
  perform pg_temp.login('a_admin@a.test'); x := pg_temp.j('select public.automation_switch(''vendor_invoice_ask'', true)'); perform pg_temp.su();
  perform pg_temp.res('94 the switch in Automations: on again, logged; the other switches still answer', (x #>> '{on,vendor_invoice_ask}')::boolean and (x -> 'on') ? 'staff_email' and (x -> 'on') ? 'vendor_reminders' and exists (select 1 from public.audit_log l where l.action = 'automation.switch' and l.entity_id = 'vendor_invoice_ask'), x::text);
  perform pg_temp.login('vf_plan@a.test'); x := pg_temp.j('select public.automation_switch(''vendor_invoice_ask'', false)'); perform pg_temp.su(); perform pg_temp.res('95 only with Settings edit', x ->> 'err' like '42501%', x::text);
  update public.event_resources set status = 'cancelled' where id = bk; perform pg_temp.tick(); perform pg_temp.res('96 booking cancelled: nothing', pg_temp.autos(pg_temp.get('r6')) = 0); update public.event_resources set status = 'confirmed' where id = bk;
  update public.quotes set status = 'cancelled' where id = q; perform pg_temp.tick(); perform pg_temp.res('97 event cancelled: nothing', pg_temp.autos(pg_temp.get('r6')) = 0); update public.quotes set status = 'confirmed' where id = q;
  update public.quotes set is_demo = true where id = q; perform pg_temp.tick(); perform pg_temp.res('98 sample event: nothing', pg_temp.autos(pg_temp.get('r6')) = 0); update public.quotes set is_demo = false where id = q;
  x := pg_temp.tick(); perform pg_temp.tick();
  perform pg_temp.res('99 the day after at 10:00 studio time: one e-mail, once however often it runs; state "invoice asked"', pg_temp.autos(pg_temp.get('r6')) = 1 and (x ->> 'invoice_asks')::int >= 1 and public._r447_state((select v from public.vendor_requests v where v.id = pg_temp.get('r6')::uuid)) = 'invoice_asked', x::text);
  perform pg_temp.ask(pg_temp.rq('{"lines":[{"name":"Mats","qty":9,"price":10},{"name":"Lamps","qty":1}]}'));
  perform pg_temp.svc(); x := public.vendor_request_claim(50, 'email'); p := public.vendor_flow_claim(50); perform pg_temp.su();
  perform pg_temp.res('100 the older dispatcher call never hands them out; the new one does, with a fresh link, the products, no event title', not exists (select 1 from jsonb_array_elements(x) y where y ->> 'kind' not in ('request', 'reminder')) and (select count(*) from jsonb_array_elements(p) y where y ->> 'kind' = 'invoice_auto') = 1
    and (select y ->> 'token' ~ '^[0-9a-f]{64}$' and y #>> '{confirmed,lines,0,name}' = 'Sofas' and y ->> 'event' = 'Wedding' and y ->> 'currency' = 'INR' from jsonb_array_elements(p) y where y ->> 'kind' = 'invoice_auto') and p::text !~ 'Sharma|secret', p::text);
  perform pg_temp.res('101 the request e-mail: products without a price, event by type', (select bool_and(y ->> 'event' = 'Wedding' and y::text !~ 'Sharma|"price":') from jsonb_array_elements(x) y) and jsonb_array_length(x) > 0, x::text);
  update public.vendor_request_sends set status = 'sent', sent_at = now() where request_id = pg_temp.get('r6')::uuid and kind = 'invoice_auto';
  update public.quotes set event_date = today - 2 where id = q; perform pg_temp.tick(); n := pg_temp.autos(pg_temp.get('r6'));
  update public.quotes set event_date = today - 4 where id = q; perform pg_temp.tick();
  perform pg_temp.res('102 3 days later again, not in between', n = 1 and pg_temp.autos(pg_temp.get('r6')) = 2);
  update public.quotes set event_date = today - 8 where id = q; perform pg_temp.tick(); n := pg_temp.autos(pg_temp.get('r6')); update public.quotes set event_date = today - 9 where id = q; perform pg_temp.tick();
  perform pg_temp.res('103 7 days later the last one, then never again', n = 3 and pg_temp.autos(pg_temp.get('r6')) = 3);
  update public.quotes set event_date = today - 4 where id = q; delete from public.vendor_request_sends where request_id = pg_temp.get('r6')::uuid and dedupe_key like '%:invoice4:%';
  x := pg_temp.inv(pg_temp.lk(pg_temp.get('r6')), '{}'::jsonb);
  insert into public.vendor_bills(org_id, quote_id, booking_id, amount, bill_date, description) values (a, q, bk, 1500, current_date, 'typed'); perform pg_temp.tick();
  perform pg_temp.res('104 a bill typed by the studio (or an invoice) stops it', pg_temp.autos(pg_temp.get('r6')) = 2);
end $$;
-- by hand + invoice only
do $$ declare x jsonb; p jsonb; y jsonb; q uuid := 'a0000000-0000-4000-8000-00000000f447'; a uuid := 'a0000000-0000-4000-8000-000000000001'; bk uuid := 'a0000000-0000-4000-8000-0000000fb447'; bk2 uuid := 'a0000000-0000-4000-8000-0000000fb448'; today date := (now() at time zone public.studio_timezone(a))::date; n integer; begin
  update public.quotes set event_date = today - 20 where id = q;
  insert into public.event_resources(id, quote_id, vendor_id, label, qty, cost, status, org_id) values (bk, q, 'a0000000-0000-4000-8000-0000000fa002', 'Generator', 1, 4000, 'booked', a), (bk2, q, 'a0000000-0000-4000-8000-0000000fa002', 'Old thing', 1, 100, 'enquiry', a);
  perform pg_temp.login('vf_plan@a.test'); x := pg_temp.j(format('select public.vendor_invoice_ask_preview(%L::jsonb)', jsonb_build_object('booking_id', bk))); perform pg_temp.su();
  perform pg_temp.res('110 preview first: who, what, how much; nothing is written', x ->> 'to' = 'royal@tents.test' and (x ->> 'can_send')::boolean and (x #>> '{confirmed,total}')::numeric = 4000 and x ->> 'event' = 'Wedding' and not exists (select 1 from public.vendor_requests r where r.booking_id = bk), x::text);
  perform pg_temp.login('vf_plan@a.test'); x := pg_temp.j(format('select public.vendor_invoice_ask(%L::jsonb)', jsonb_build_object('booking_id', bk, 'key', 'a0000000-0000-4000-8000-0000000fe071'))); perform pg_temp.su();
  perform pg_temp.res('111 20 days after the event, no request: an invoice-only request, the e-mail queued, the booking untouched', (x ->> 'invoice_only')::boolean and x ->> 'status' = 'accepted' and (x #>> '{mail,queued}')::boolean and x #>> '{link,token}' ~ '^[0-9a-f]{64}$' and x ->> 'state' = 'invoice_asked'
    and (select b.status = 'booked' and b.cost = 4000 and b.qty = 1 from public.event_resources b where b.id = bk) and (select r.delivery_id is null and r.booking_created = false from public.vendor_requests r where r.id = (x ->> 'id')::uuid), x::text);
  perform pg_temp.login('vf_plan@a.test'); y := pg_temp.j(format('select public.vendor_invoice_ask(%L::jsonb)', jsonb_build_object('booking_id', bk))); perform pg_temp.su();
  perform pg_temp.res('112 asked again at once: the same request, no second e-mail within 10 minutes, a fresh link', y ->> 'id' = x ->> 'id' and y #>> '{mail,reason}' = 'recent' and (select count(*) from public.vendor_request_sends s where s.request_id = (x ->> 'id')::uuid) = 1, y::text);
  perform pg_temp.tick(); perform pg_temp.res('113 an invoice-only request is never asked by itself', pg_temp.autos(x ->> 'id') = 0);
  perform pg_temp.anon(); p := public.vendor_link_get(x #>> '{link,token}'); perform pg_temp.su();
  perform pg_temp.res('114 their page: only the invoice', (p ->> 'invoice_only')::boolean and (p ->> 'can_invoice')::boolean and not (p ->> 'can_respond')::boolean and (p #>> '{confirmed,lines,0,price}')::numeric = 4000, p::text);
  perform pg_temp.login('vf_plan@a.test');
  p := pg_temp.j(format('select public.vendor_invoice_ask(%L::jsonb)', jsonb_build_object('booking_id', bk2))); y := pg_temp.j(format('select public.vendor_request_reassign(%L, %L, null, null)', x ->> 'id', 'a0000000-0000-4000-8000-0000000fa001')); perform pg_temp.su();
  perform pg_temp.res('115 only asked (not booked): refused; an invoice-only request is not reassigned', p ->> 'err' like '22023%' and y ->> 'err' like '22023%', p::text || y::text);
  update public.quotes set event_date = today - 61 where id = q; update public.event_resources set status = 'confirmed' where id = bk2;
  perform pg_temp.login('vf_plan@a.test'); p := pg_temp.j(format('select public.vendor_invoice_ask(%L::jsonb)', jsonb_build_object('booking_id', bk2))); perform pg_temp.login('vf_fin@a.test'); y := pg_temp.j(format('select public.vendor_invoice_ask(%L::jsonb)', jsonb_build_object('booking_id', bk))); perform pg_temp.login('vf_plan@b.test'); x := pg_temp.j(format('select public.vendor_invoice_ask(%L::jsonb)', jsonb_build_object('booking_id', bk))); perform pg_temp.su();
  perform pg_temp.res('116 more than 60 days: refused; Vendors edit needed; not another studio''s', p ->> 'err' like '22023%' and y ->> 'err' like '42501%' and x ->> 'err' like 'P0002%', p::text || y::text || x::text);
  update public.quotes set event_date = current_date + 5 where id = q;
  perform pg_temp.login('vf_plan@a.test'); p := pg_temp.j(format('select public.vendor_invoice_ask(%L::jsonb)', jsonb_build_object('request_id', pg_temp.get('r4')))); x := pg_temp.j(format('select public.vendor_invoice_ask(%L::jsonb)', jsonb_build_object('request_id', pg_temp.get('r5')))); perform pg_temp.su();
  perform pg_temp.res('117 an invoice is in / not confirmed yet: refused in plain words', p ->> 'err' like '22023 An invoice%' and x ->> 'err' like '22023%has not confirmed%', p::text || x::text);
  update public.vendor_request_sends set created_at = now() - interval '49 hours' where kind = 'invoice_ask'; perform pg_temp.tick();
  perform pg_temp.res('118 an e-mail nobody could send for two days is closed, never sent late', not exists (select 1 from public.vendor_request_sends where kind = 'invoice_ask' and status = 'pending'));
end $$;

-- F) waiting price = no reminder, no "no reply"; cancelled event; read-only; trial; older request; kept rows
do $$ declare r jsonb; p jsonb; x jsonb; q uuid := 'a0000000-0000-4000-8000-00000000f447'; a uuid := 'a0000000-0000-4000-8000-000000000001'; begin
  insert into public.automation_settings(org_id, vendor_reminders_enabled) values (a, true) on conflict (org_id) do update set vendor_reminders_enabled = true;
  r := pg_temp.ask(pg_temp.rq('{"lines":[{"name":"Fans","qty":2}],"send":false}')); p := pg_temp.offer(r #>> '{link,token}', '{"available":true,"lines":[{"id":"l1","qty":2,"price":70}]}');
  update public.vendor_requests set created_at = now() - interval '25 hours', respond_by = now() - interval '1 minute' where id = (r ->> 'id')::uuid; perform pg_temp.tick();
  perform pg_temp.res('120 a price that waits for the studio: no reminder, no "no reply"', not exists (select 1 from public.vendor_request_sends s where s.request_id = (r ->> 'id')::uuid and s.kind = 'reminder') and (select no_response_at is null from public.vendor_requests where id = (r ->> 'id')::uuid));
  update public.quotes set status = 'cancelled' where id = q; x := pg_temp.offer(r #>> '{link,token}', '{"available":true,"lines":[{"id":"l1","qty":2,"price":71}]}');
  perform pg_temp.res('121 cancelled event: the link says so, approving is refused, no upload', x ->> 'reason' = 'cancelled' and pg_temp.review(p #>> '{offer,id}', 'approve') ->> 'err' is not null and pg_temp.upload(r #>> '{link,token}', 'application/pdf', 'vendor_offer_upload') is null, x::text);
  update public.quotes set status = 'confirmed', client_links_paused_at = null where id = q;
  -- an older request (made before this file): one product made from it, answered at the agreed amount
  perform pg_temp.login('vf_plan@a.test'); x := public.vendor_request_save(jsonb_build_object('quote_id', q, 'vendor_id', 'a0000000-0000-4000-8000-0000000fa002', 'what', 'Dhol', 'qty', 3, 'when_at', (now() + interval '3 days')::text, 'agreed_amount', 10000, 'send', false)); perform pg_temp.su();
  perform pg_temp.anon(); p := public.vendor_link_get(x #>> '{link,token}'); perform pg_temp.su();
  perform pg_temp.res('122 an older request: one product; a total that does not divide has no price each', jsonb_array_length(p -> 'lines') = 1 and (p #>> '{lines,0,qty}')::numeric = 3 and p #> '{lines,0,price}' = 'null'::jsonb and (p ->> 'agreed_amount')::numeric = 10000, p::text);
  p := pg_temp.offer(x #>> '{link,token}', '{"available":true,"mode":"total","lines":[{"id":"l1","qty":3}],"total":10000}');
  perform pg_temp.res('123 answered at that amount = accepted, as before', p ->> 'status' = 'accepted' and (select b.cost = 10000 and b.status = 'confirmed' from public.event_resources b where b.id = (x ->> 'booking_id')::uuid), p::text);
  perform pg_temp.login('vf_plan@a.test'); x := public.vendor_request_save(jsonb_build_object('quote_id', q, 'vendor_id', 'a0000000-0000-4000-8000-0000000fa002', 'what', 'Band', 'when_at', (now() + interval '3 days')::text, 'agreed_amount', 700, 'send', false)); perform pg_temp.su();
  perform pg_temp.anon(); p := public.vendor_link_respond(x #>> '{link,token}', 'accept', 'ok'); perform pg_temp.su();
  perform pg_temp.res('124 the older page''s Accept still works', p ->> 'status' = 'accepted' and (select confirmed_at is not null from public.vendor_requests where id = (x ->> 'id')::uuid), p::text);
end $$;
do $$ declare r jsonb; x jsonb; u uuid; t uuid; tq uuid := gen_random_uuid(); tv uuid; l text; begin
  perform pg_temp.su(); select id into u from auth.users where email = 'vf_trial@t.test'; if u is null then u := auth.seed_user('vf_trial@t.test'); end if;
  insert into public.profiles(id, email, role, org_id, must_change_password, created_at) values (u, 'vf_trial@t.test', 'admin', null, false, now()) on conflict (id) do update set org_id = null, role = 'admin';
  perform pg_temp.login('vf_trial@t.test'); r := public.start_self_serve_trial('T vf', 'Asia/Kolkata', 'INR', 'demo'); perform pg_temp.su(); t := (r ->> 'org_id')::uuid;
  insert into public.quotes(id, code, title, status, client, pricing, current_version, approval_status, org_id, created_at, updated_at, event_date) values (tq, 'T-447', 'Trial event', 'confirmed', '{}', '{}', 1, 'none', t, now(), now(), current_date + 3);
  insert into public.vendors(id, name, email, phone, org_id) values (gen_random_uuid(), 'Trial Vendor', 'tv@vendor.test', '+919811111111', t) returning id into tv;
  insert into public.event_resources(quote_id, vendor_id, label, qty, cost, status, org_id) values (tq, tv, 'Booked', 1, 10, 'booked', t);
  perform pg_temp.login('vf_trial@t.test'); r := public.vendor_request_ask(jsonb_build_object('quote_id', tq, 'vendor_id', tv, 'lines', '[{"name":"Chairs","qty":2}]'::jsonb, 'when_at', (now() + interval '3 days')::text));
  x := public.vendor_invoice_ask(jsonb_build_object('booking_id', (select b.id from public.event_resources b where b.quote_id = tq and b.label = 'Booked'))); perform pg_temp.su();
  perform pg_temp.res('130 free trial: it works inside, nothing is ever queued', r ->> 'status' = 'sent' and (r ->> 'queued')::int = 0 and not (x #>> '{mail,queued}')::boolean and not exists (select 1 from public.vendor_request_sends s where s.org_id = t and s.status <> 'skipped'), x::text);
  perform set_config('helm.r125_gate', 'on', true); l := r #>> '{link,token}';
  x := pg_temp.offer(l, '{"available":true,"lines":[{"id":"l1","qty":2,"price":5}]}');
  perform pg_temp.res('131 a trial studio''s link answers nothing; no link is made', x ->> 'ok' = 'false' and x ->> 'reason' is null and pg_temp.upload(l, 'application/pdf', 'vendor_offer_upload') like '42501%', x::text);
  perform set_config('helm.r125_gate', 'off', true);
end $$;
do $$ declare b jsonb; begin
  perform pg_temp.su();
  perform pg_temp.res('132 the event group of another studio got nothing', not exists (select 1 from public.notifications n where n.org_id = 'b0000000-0000-4000-8000-000000000001' and n.detail ->> 'source' = '0256' and n.created_at >= now()));
  perform pg_temp.res('133 no table privilege for the app roles anywhere in the vendor flow', not has_table_privilege('authenticated', 'public.vendor_requests', 'select') and not has_table_privilege('authenticated', 'public.vendor_offers', 'insert') and not has_table_privilege('anon', 'public.vendor_invoice_grants', 'select'));
end $$;
select name, result from _rc where result <> 'PASS' order by name;
select 'R259-VENDOR-FLOW-0447: ' || case when count(*) filter (where result <> 'PASS') = 0 then 'ALL PASS' else 'FAIL' end || ' (' || count(*) filter (where result = 'PASS') || '/' || count(*) || ')' from _rc;
rollback;
