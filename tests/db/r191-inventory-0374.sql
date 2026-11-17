-- r191-inventory-0374.sql - R191 Money phase 3 (inventory upgrade) + phase 4 (multi-day stock).
-- Proves: (1) privileges, insert-only tables, wraps kept once; (2) consumables: left over back, the rest used + costed as a
-- normal cost (never a loss); (3) photo proof required by the new call (setting on by default), not by the old one (line shows
-- "photo needed"), photo path must be this studio's; (4) part-return: the rest stays Out, the old call counts it, the final
-- check-in writes off only what is still missing; (5) found = stock back + loss credited; (6) under repair -> repaired (+ cost,
-- Finance only) / can't be fixed; (7) decision: warehouse refused, charge = one pending "Recover from client", P&L credit only
-- once processed, no second charge while one is live; (8) warehouse sees quantities, never amounts; (9) settings: insert-only
-- versions, portal flag needs Finance edit; (10) client portal shows charges only when on; (11) stock windows + buffer days:
-- overlap blocks, no window = one-day rule, overlap list, short list on a longer range; (12) stock still out from a finished
-- event counts on later dates (display bug fixed in the reserve guard); (13) an event with no R191 rows: ledger unchanged;
-- (14) another studio gets nothing; (15) re-run safe.
-- Re-applies 0374 twice. Local disposable PG only. Fake data only. Rolled back.
\set ON_ERROR_STOP 0
set client_min_messages = error;
\ir ../../supabase/migrations/0374_r191_inventory_upgrade.sql
\ir ../../supabase/migrations/0374_r191_inventory_upgrade.sql
set client_min_messages = warning;
begin;
create temp table _rs(name text, result text); grant all on _rs to anon, authenticated, service_role;
create or replace function pg_temp.t(p_name text, p_ok boolean, p_detail text default '') returns void language plpgsql as $$
begin insert into _rs values (p_name, case when coalesce(p_ok, false) then 'PASS' else 'FAIL: ' || coalesce(p_detail, '') end); end $$;
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
create temp table _v(k text primary key, v text);
create or replace function pg_temp.r(p_key text, p_who text, p_sql text) returns text language plpgsql as $$
declare v text; begin v := pg_temp.as_val(p_who, p_sql); insert into _v values (p_key, v); return v; end $$;
create or replace function pg_temp.v(p_key text) returns text language sql as $$ select v from _v where k = p_key $$;
create or replace function pg_temp.total(p_item uuid) returns numeric language sql as $$
  select total_qty from public.inventory_items where id = p_item $$;
create or replace function pg_temp.lines(p_quote uuid) returns jsonb language sql as $$
  select public._r21_cost_lines(p_quote, 'a0000000-0000-4000-8000-000000000001') $$;
create or replace function pg_temp.line(p_quote uuid, p_key text) returns jsonb language sql as $$
  select l from jsonb_array_elements(public._r21_cost_lines(p_quote, 'a0000000-0000-4000-8000-000000000001')) l where l ->> 'key' = p_key $$;

-- fixture: studio A - a warehouse person (operations: Inventory edit, no Finance, no Command), the admin (everything)
do $$ declare u uuid; begin
  select id into u from auth.users where email = 'r191_wh@a.test';
  if u is null then u := auth.seed_user('r191_wh@a.test'); end if;
  insert into public.profiles(id, email, full_name, role, org_id, must_change_password, created_at)
    values (u, 'r191_wh@a.test', 'Wara House', 'operations', 'a0000000-0000-4000-8000-000000000001', false, now())
  on conflict (id) do update set role = excluded.role, org_id = excluded.org_id;
end $$;
insert into public.role_access(role, area, can_view, can_edit, org_id, updated_at) values
  ('operations', 'inventory', true, true, 'a0000000-0000-4000-8000-000000000001', now()),
  ('operations', 'finance', false, false, 'a0000000-0000-4000-8000-000000000001', now()),
  ('operations', 'command', false, false, 'a0000000-0000-4000-8000-000000000001', now()),
  ('operations', 'settlement', false, false, 'a0000000-0000-4000-8000-000000000001', now())
on conflict (role, area, org_id) do update set can_view = excluded.can_view, can_edit = excluded.can_edit;
insert into storage.buckets (id, name, public) values ('event-docs', 'event-docs', false) on conflict (id) do nothing;
update public.quotes set event_date = (now() + interval '20 days')::date, status = 'confirmed', title = 'Reddy Wedding', deleted_at = null
 where id = 'a0000000-0000-4000-8000-00000000da01';
insert into public.quotes(id, code, title, status, client, pricing, current_version, approval_status, org_id, approval_token, event_date, created_at, updated_at) values
  ('a0000000-0000-4000-8000-00000000d191', 'A-0191', 'Rao Party', 'confirmed', '{"name":"Ravi"}'::jsonb,
   '{"subtotal":100000,"discount":0,"gstPct":18,"total":118000}'::jsonb, 1, 'sent', 'a0000000-0000-4000-8000-000000000001',
   'a0000000-0000-4000-8000-0000000191aa', (now() + interval '22 days')::date, now(), now()),
  ('a0000000-0000-4000-8000-00000000d192', 'A-0192', 'Old Gala', 'confirmed', '{"name":"Old"}'::jsonb,
   '{"subtotal":100000,"discount":0,"gstPct":18,"total":118000}'::jsonb, 1, 'sent', 'a0000000-0000-4000-8000-000000000001',
   'a0000000-0000-4000-8000-0000000192aa', (now() - interval '10 days')::date, now(), now());
insert into public.inventory_items (id, name, category, total_qty, unit, unit_cost, item_kind, org_id) values
  ('a0000000-0000-4000-8000-0000000a1911', 'Chiavari chair', 'Seating', 100, 'pcs', 1200, 'reusable', 'a0000000-0000-4000-8000-000000000001'),
  ('a0000000-0000-4000-8000-0000000a1912', 'Rose petals', 'Decor & Florals', 200, 'kg', 300, 'consumable', 'a0000000-0000-4000-8000-000000000001'),
  ('a0000000-0000-4000-8000-0000000a1913', 'Uplight', 'Lighting', 40, 'pcs', 2500, 'reusable', 'a0000000-0000-4000-8000-000000000001');
insert into public.inventory_checkouts (id, item_id, quote_id, qty_out, issued_to, status, org_id) values
  ('a0000000-0000-4000-8000-0000000c1911', 'a0000000-0000-4000-8000-0000000a1912', 'a0000000-0000-4000-8000-00000000da01', 50, 'Decor team', 'out', 'a0000000-0000-4000-8000-000000000001'),
  ('a0000000-0000-4000-8000-0000000c1912', 'a0000000-0000-4000-8000-0000000a1911', 'a0000000-0000-4000-8000-00000000da01', 30, 'Ravi', 'out', 'a0000000-0000-4000-8000-000000000001'),
  ('a0000000-0000-4000-8000-0000000c1913', 'a0000000-0000-4000-8000-0000000a1913', 'a0000000-0000-4000-8000-00000000da01', 10, 'Sound', 'out', 'a0000000-0000-4000-8000-000000000001'),
  ('a0000000-0000-4000-8000-0000000c1914', 'a0000000-0000-4000-8000-0000000a1913', 'a0000000-0000-4000-8000-00000000da01', 6, 'Sound', 'out', 'a0000000-0000-4000-8000-000000000001');
insert into storage.objects (bucket_id, name) values
  ('event-docs', 'a0000000-0000-4000-8000-000000000001/a0000000-0000-4000-8000-00000000da01/stock/11111111-2222-4333-8444-555555555555.jpg'),
  ('event-docs', 'b0000000-0000-4000-8000-000000000001/b0000000-0000-4000-8000-00000000da01/stock/11111111-2222-4333-8444-555555555556.jpg');

-- ---- 1) privileges + shape -------------------------------------------------------------------------------------------------
select pg_temp.t('1a anon cannot mark back, find or read the story',
  pg_temp.as_val('anon', $q$select public.checkin_stock_v2('a0000000-0000-4000-8000-0000000c1912', 1, 0)$q$) like '42501%'
  and pg_temp.as_val('anon', $q$select public.stock_story(null)$q$) like '42501%'
  and pg_temp.as_val('anon', $q$select public.stock_found('a0000000-0000-4000-8000-0000000c1912', 1)$q$) like '42501%');
select pg_temp.t('1b the tables are closed to the app (no select / insert for signed-in users)',
  pg_temp.as_val('r191_wh@a.test', $q$select count(*) from public.inventory_stock_events$q$) like '42501%'
  and pg_temp.as_val('a_admin@a.test', $q$insert into public.inventory_settings (org_id) values ('a0000000-0000-4000-8000-000000000001') returning seq$q$) like '42501%');
select pg_temp.t('1c old items are Reusable, old check-outs used 0',
  not exists (select 1 from public.inventory_items where item_kind is null)
  and not exists (select 1 from public.inventory_checkouts where qty_used is null));

-- ---- 2) consumable: 50 out, 15 left over -> 35 used ------------------------------------------------------------------------
select pg_temp.t('2a consumable check-in: left over back, the rest used', pg_temp.as_val('r191_wh@a.test',
  $q$select public.checkin_stock_v2('a0000000-0000-4000-8000-0000000c1911', 15, 0, 'Decor team') ->> 'used'$q$) = 'ok:35');
select pg_temp.t('2b the check-out is Back (all accounted for), 35 used + written off, stock 200 -> 165',
  (select status = 'returned' and qty_in = 50 and qty_used = 35 and written_off = 35 from public.inventory_checkouts where id = 'a0000000-0000-4000-8000-0000000c1911')
  and pg_temp.total('a0000000-0000-4000-8000-0000000a1912') = 165);
select pg_temp.t('2c P&L: a normal cost in its own category (decor), not Damages & loss',
  (pg_temp.line('a0000000-0000-4000-8000-00000000da01', 'writeoff:a0000000-0000-4000-8000-0000000c1911:used') ->> 'category') = 'decor'
  and (pg_temp.line('a0000000-0000-4000-8000-00000000da01', 'writeoff:a0000000-0000-4000-8000-0000000c1911:used') ->> 'c_act')::numeric = 10500
  and pg_temp.line('a0000000-0000-4000-8000-00000000da01', 'writeoff:a0000000-0000-4000-8000-0000000c1911') is null,
  pg_temp.lines('a0000000-0000-4000-8000-00000000da01')::text);
select pg_temp.t('2d no photo needed for a consumable', (pg_temp.as_val('r191_wh@a.test',
  $q$select public.stock_story('a0000000-0000-4000-8000-00000000da01') -> 'lines' -> 'a0000000-0000-4000-8000-0000000c1911' ->> 'photo_needed'$q$)) = 'ok:false');

-- ---- 3) photo proof -------------------------------------------------------------------------------------------------------
select pg_temp.t('3a the new call refuses damaged / missing without a photo (setting on by default)', pg_temp.as_val('r191_wh@a.test',
  $q$select public.checkin_stock_v2('a0000000-0000-4000-8000-0000000c1913', 7, 1)$q$) like '22023%photo%');
select pg_temp.t('3b another studio''s photo path is refused', pg_temp.as_val('r191_wh@a.test',
  $q$select public.checkin_stock_v2('a0000000-0000-4000-8000-0000000c1913', 7, 1, null, false,
     'b0000000-0000-4000-8000-000000000001/b0000000-0000-4000-8000-00000000da01/stock/11111111-2222-4333-8444-555555555556.jpg')$q$) like '22023%');
select pg_temp.r('3c', 'r191_wh@a.test',
  $q$select public.checkin_stock_v2('a0000000-0000-4000-8000-0000000c1913', 7, 1, 'Sound', false,
     'a0000000-0000-4000-8000-000000000001/a0000000-0000-4000-8000-00000000da01/stock/11111111-2222-4333-8444-555555555555.jpg') ->> 'missing'$q$);
select pg_temp.t('3c with this studio''s photo: 7 back, 1 damaged, 2 missing; photo kept', pg_temp.v('3c') = 'ok:2'
  and exists (select 1 from public.inventory_stock_events where checkout_id = 'a0000000-0000-4000-8000-0000000c1913' and kind = 'photo')
  and pg_temp.total('a0000000-0000-4000-8000-0000000a1913') = 37);
select pg_temp.r('3d', 'r191_wh@a.test', $q$select public.checkin_stock('a0000000-0000-4000-8000-0000000c1914', 5, 0) ->> 'missing'$q$);
select pg_temp.t('3d the old call still works without a photo; the line says photo needed', pg_temp.v('3d') = 'ok:1'
  and pg_temp.as_val('r191_wh@a.test', $q$select public.stock_story('a0000000-0000-4000-8000-00000000da01') -> 'lines' -> 'a0000000-0000-4000-8000-0000000c1914' ->> 'photo_needed'$q$) = 'ok:true');
select pg_temp.r('3e', 'r191_wh@a.test',
  $q$select public.stock_add_photo('a0000000-0000-4000-8000-0000000c1914',
     'a0000000-0000-4000-8000-000000000001/a0000000-0000-4000-8000-00000000da01/stock/11111111-2222-4333-8444-555555555555.jpg') ->> 'ok'$q$);
select pg_temp.t('3e a photo added later clears it', pg_temp.v('3e') = 'ok:true'
  and pg_temp.as_val('r191_wh@a.test', $q$select public.stock_story('a0000000-0000-4000-8000-00000000da01') -> 'lines' -> 'a0000000-0000-4000-8000-0000000c1914' ->> 'photo_needed'$q$) = 'ok:false');

-- ---- 4) part-return: 30 out, 20 back now, the rest still out ----------------------------------------------------------------
select pg_temp.r('4a', 'r191_wh@a.test', $q$select public.checkin_stock_v2('a0000000-0000-4000-8000-0000000c1912', 20, 0, 'Ravi', true) ->> 'still_out'$q$);
select pg_temp.t('4a 20 back, 10 still out: the check-out stays Out', pg_temp.v('4a') = 'ok:10'
  and (select status = 'out' and qty_in = 20 and written_off = 0 from public.inventory_checkouts where id = 'a0000000-0000-4000-8000-0000000c1912')
  and pg_temp.total('a0000000-0000-4000-8000-0000000a1911') = 100);
select pg_temp.t('4b free stock counts only the 10 still out', (pg_temp.as_val('a_admin@a.test',
  $q$select public.checkout_availability('a0000000-0000-4000-8000-0000000a1911', null) ->> 'out_now'$q$)) = 'ok:10');
select pg_temp.t('4c the old call knows the earlier part-return (at most 10 more)', pg_temp.as_val('r191_wh@a.test',
  $q$select public.checkin_stock('a0000000-0000-4000-8000-0000000c1912', 11, 0)$q$) like '22023%10%');
select pg_temp.r('4d', 'r191_wh@a.test', $q$select public.checkin_stock('a0000000-0000-4000-8000-0000000c1912', 5, 2) ->> 'missing'$q$);
select pg_temp.t('4d final: 5 back, 2 damaged, 3 missing -> 5 written off once (not 10)', pg_temp.v('4d') = 'ok:3'
  and (select status = 'partial' and qty_in = 27 and qty_damaged = 2 and written_off = 5 from public.inventory_checkouts where id = 'a0000000-0000-4000-8000-0000000c1912')
  and pg_temp.total('a0000000-0000-4000-8000-0000000a1911') = 95);

-- ---- 5) found later -------------------------------------------------------------------------------------------------------
select pg_temp.r('5a', 'r191_wh@a.test', $q$select public.stock_found('a0000000-0000-4000-8000-0000000c1912', 2, 'found in the van') ->> 'still_missing'$q$);
select pg_temp.t('5a 2 of the 3 missing turn up: back in stock', pg_temp.v('5a') = 'ok:1'
  and pg_temp.total('a0000000-0000-4000-8000-0000000a1911') = 97);
select pg_temp.t('5b cannot find more than is missing', pg_temp.as_val('r191_wh@a.test',
  $q$select public.stock_found('a0000000-0000-4000-8000-0000000c1912', 2)$q$) like '22023%');
select pg_temp.t('5c the write-off row is never edited (still 5)',
  (select written_off from public.inventory_checkouts where id = 'a0000000-0000-4000-8000-0000000c1912') = 5);

-- ---- 6) repair ------------------------------------------------------------------------------------------------------------
select pg_temp.r('6a', 'r191_wh@a.test', $q$select public.stock_repair('a0000000-0000-4000-8000-0000000c1912', 'start', 2) ->> 'step'$q$);
select pg_temp.r('6a2', 'r191_wh@a.test', $q$select public.stock_repair('a0000000-0000-4000-8000-0000000c1912', 'start', 1)$q$);
select pg_temp.t('6a damaged 2 -> 2 under repair', pg_temp.v('6a') = 'ok:repair_start'
  and pg_temp.v('6a2') like '22023%');
select pg_temp.t('6b a repair cost needs Finance edit', pg_temp.as_val('r191_wh@a.test',
  $q$select public.stock_repair('a0000000-0000-4000-8000-0000000c1912', 'done', 1, 400)$q$) like '42501%');
select pg_temp.r('6c1', 'a_admin@a.test', $q$select public.stock_repair('a0000000-0000-4000-8000-0000000c1912', 'done', 1, 400) ->> 'ok'$q$);
select pg_temp.r('6c2', 'r191_wh@a.test', $q$select public.stock_repair('a0000000-0000-4000-8000-0000000c1912', 'scrap', 1) ->> 'ok'$q$);
select pg_temp.r('6c3', 'r191_wh@a.test', $q$select public.stock_repair('a0000000-0000-4000-8000-0000000c1912', 'done', 1)$q$);
select pg_temp.t('6c repaired (admin, cost 400): back in stock; 1 can''t be fixed', pg_temp.v('6c1') = 'ok:true'
  and pg_temp.v('6c2') = 'ok:true' and pg_temp.v('6c3') like '22023%'
  and pg_temp.total('a0000000-0000-4000-8000-0000000a1911') = 98);
select pg_temp.t('6d P&L: loss = 5 written off - 2 found - 1 repaired = 2 x 1200, + repair 400',
  (pg_temp.line('a0000000-0000-4000-8000-00000000da01', 'writeoff:a0000000-0000-4000-8000-0000000c1912') ->> 'c_act')::numeric = 2400
  and (pg_temp.line('a0000000-0000-4000-8000-00000000da01', 'writeoff:a0000000-0000-4000-8000-0000000c1912:repair') ->> 'c_act')::numeric = 400,
  pg_temp.lines('a0000000-0000-4000-8000-00000000da01')::text);

-- ---- 7) decision -----------------------------------------------------------------------------------------------------------
select pg_temp.t('7a warehouse cannot decide (absorb or charge)', pg_temp.as_val('r191_wh@a.test',
  $q$select public.stock_damage_decision('a0000000-0000-4000-8000-0000000c1912', 'charge', 2400)$q$) like '42501%'
  and pg_temp.as_val('r191_wh@a.test', $q$select public.stock_damage_decision('a0000000-0000-4000-8000-0000000c1912', 'absorb')$q$) like '42501%');
select pg_temp.r('7b', 'a_admin@a.test', $q$select public.stock_damage_decision('a0000000-0000-4000-8000-0000000c1912', 'charge', 2400) ->> 'decision'$q$);
select pg_temp.t('7b admin charges the client 2400: one pending Recover from client row', pg_temp.v('7b') = 'ok:charge'
  and (select count(*) from public.event_refunds where quote_id = 'a0000000-0000-4000-8000-00000000da01' and kind = 'recovery' and status = 'pending' and amount = 2400) = 1);
select pg_temp.t('7c not collected yet: no credit in the P&L',
  pg_temp.line('a0000000-0000-4000-8000-00000000da01', 'writeoff:a0000000-0000-4000-8000-0000000c1912:recovered') is null);
select pg_temp.t('7d no second charge while one is live', pg_temp.as_val('a_admin@a.test',
  $q$select public.stock_damage_decision('a0000000-0000-4000-8000-0000000c1912', 'charge', 100)$q$) like 'P0001%');
update public.event_refunds set status = 'approved' where quote_id = 'a0000000-0000-4000-8000-00000000da01' and kind = 'recovery';
update public.event_refunds set status = 'processed' where quote_id = 'a0000000-0000-4000-8000-00000000da01' and kind = 'recovery';
select pg_temp.t('7e collected: Damages & loss credited 2400',
  (pg_temp.line('a0000000-0000-4000-8000-00000000da01', 'writeoff:a0000000-0000-4000-8000-0000000c1912:recovered') ->> 'c_act')::numeric = -2400);
select pg_temp.r('7f', 'a_admin@a.test', $q$select public.stock_damage_decision('a0000000-0000-4000-8000-0000000c1913', 'absorb') ->> 'decision'$q$);
select pg_temp.t('7f absorb on another line is recorded once', pg_temp.v('7f') = 'ok:absorb'
  and pg_temp.as_val('a_admin@a.test', $q$select public.stock_damage_decision('a0000000-0000-4000-8000-0000000c1913', 'absorb') ->> 'already'$q$) = 'ok:true');

-- ---- 8) warehouse sees quantities, never amounts ----------------------------------------------------------------------------
select pg_temp.t('8a warehouse: the charge line has no amount, no repair cost; admin sees both',
  pg_temp.as_val('r191_wh@a.test', $q$select (public.stock_story('a0000000-0000-4000-8000-00000000da01') -> 'lines' -> 'a0000000-0000-4000-8000-0000000c1912') ?| array['charge_amount', 'repair_cost']$q$) = 'ok:false'
  and pg_temp.as_val('r191_wh@a.test', $q$select public.stock_story('a0000000-0000-4000-8000-00000000da01') -> 'lines' -> 'a0000000-0000-4000-8000-0000000c1912' ->> 'decision'$q$) = 'ok:charge_client'
  and pg_temp.as_val('a_admin@a.test', $q$select public.stock_story('a0000000-0000-4000-8000-00000000da01') -> 'lines' -> 'a0000000-0000-4000-8000-0000000c1912' ->> 'charge_amount'$q$) = 'ok:2400'
  and pg_temp.as_val('r191_wh@a.test', $q$select public.stock_story(null) -> 'settings' ->> 'can_money'$q$) = 'ok:false');
select pg_temp.t('8b warehouse history rows carry no amount', pg_temp.as_val('r191_wh@a.test',
  $q$select count(*) from jsonb_array_elements(public.stock_story('a0000000-0000-4000-8000-00000000da01') -> 'lines' -> 'a0000000-0000-4000-8000-0000000c1912' -> 'history') h where h ? 'amount'$q$) = 'ok:0');

-- ---- 9) settings ------------------------------------------------------------------------------------------------------------
select pg_temp.t('9a defaults: photo on, portal off, 0 buffer days', pg_temp.as_val('r191_wh@a.test',
  $q$select (s ->> 'photo_proof') || '/' || (s ->> 'portal_damage') || '/' || (s ->> 'buffer_days') from public.inventory_settings_get() s$q$) = 'ok:true/false/0');
select pg_temp.r('9b', 'r191_wh@a.test', $q$select public.inventory_settings_set(false) ->> 'photo_proof'$q$);
select pg_temp.t('9b warehouse turns photo proof off; cannot turn the client portal on', pg_temp.v('9b') = 'ok:false'
  and pg_temp.as_val('r191_wh@a.test', $q$select public.inventory_settings_set(null, true)$q$) like '42501%');
select pg_temp.t('9c every change is a new row; a row is never edited',
  (select count(*) from public.inventory_settings where org_id = 'a0000000-0000-4000-8000-000000000001') = 1
  and pg_temp.as_val(null, $q$update public.inventory_settings set photo_proof = true returning seq$q$) like '42501%'
  and pg_temp.as_val(null, $q$update public.inventory_stock_events set note = 'x' returning seq$q$) like '42501%');
select pg_temp.r('9d0', 'r191_wh@a.test', $q$select public.checkout_equipment_smart('a0000000-0000-4000-8000-0000000a1913', 'a0000000-0000-4000-8000-00000000da01', 2, 'Sound') ->> 'checkout_id'$q$);
select pg_temp.r('9d', 'r191_wh@a.test', format($q$select public.checkin_stock_v2(%L, 1, 0) ->> 'missing'$q$, substr(pg_temp.v('9d0'), 4)));
select pg_temp.t('9d photo proof off: the new call takes a missing line without a photo', pg_temp.v('9d') = 'ok:1', pg_temp.v('9d0') || ' / ' || pg_temp.v('9d'));

-- ---- 10) client portal ------------------------------------------------------------------------------------------------------
-- (the approval link token of the wedding as it is now - another suite may have issued a new one)
create temp table _tok as select approval_token::text as t from public.quotes where id = 'a0000000-0000-4000-8000-00000000da01';
grant select on _tok to anon, authenticated;
select pg_temp.t('10a portal off: no damage charges', pg_temp.as_val('anon',
  format($q$select coalesce((public.public_portal_extras(%L::uuid) ? 'damage_charges')::text, 'null')$q$, (select t from _tok))) in ('ok:false', 'ok:null'),
  pg_temp.as_val('anon', format($q$select public.public_portal_extras(%L::uuid)::text$q$, (select t from _tok))));
select pg_temp.as_val('a_admin@a.test', $q$select public.inventory_settings_set(null, true)$q$);
select pg_temp.t('10b portal on (admin): the charge shows, paid', pg_temp.as_val('anon',
  format($q$select public.public_portal_extras(%L::uuid) -> 'damage_charges' -> 0 ->> 'status'$q$, (select t from _tok))) = 'ok:paid',
  pg_temp.as_val('anon', format($q$select public.public_portal_extras(%L::uuid)::text$q$, (select t from _tok))));

-- ---- 11) stock windows + buffer days ----------------------------------------------------------------------------------------
-- chairs: 98 owned. Rao Party (day +22) reserves 60. Reddy Wedding (day +20) can reserve 98 - still out 0 ... on its own day.
select pg_temp.as_val('a_admin@a.test', $q$select (public.reserve_inventory('a0000000-0000-4000-8000-0000000a1911', 'a0000000-0000-4000-8000-00000000d191', 60)).qty$q$);
select pg_temp.t('11a no window: a different day does not block (one-day rule as before)', pg_temp.as_val('a_admin@a.test',
  $q$select (public.reserve_inventory('a0000000-0000-4000-8000-0000000a1911', 'a0000000-0000-4000-8000-00000000da01', 50)).qty$q$) = 'ok:50');
select pg_temp.t('11b teardown until day +22: the wedding is now short 50 - (98 - 60) = 12', pg_temp.as_val('a_admin@a.test',
  $q$select public.event_stock_window_set('a0000000-0000-4000-8000-00000000da01', null, (now() + interval '22 days')::date) -> 'short' -> 0 ->> 'short'$q$) = 'ok:12');
select pg_temp.t('11c the reserve guard now blocks on the whole range', pg_temp.as_val('a_admin@a.test',
  $q$select (public.reserve_inventory('a0000000-0000-4000-8000-0000000a1911', 'a0000000-0000-4000-8000-00000000da01', 1)).qty$q$) like 'P0001%not enough%');
select pg_temp.t('11d overlap list names the other event', pg_temp.as_val('a_admin@a.test',
  $q$select public.stock_overlaps('a0000000-0000-4000-8000-00000000da01') -> 0 -> 'events' -> 0 ->> 'event'$q$) = 'ok:Rao Party');
select pg_temp.r('11e', 'a_admin@a.test', $q$select public.event_stock_window_set('a0000000-0000-4000-8000-00000000da01', null, null) ->> 'd_to'$q$);
select pg_temp.t('11e back to one day: free again; the window rows are kept', pg_temp.v('11e') = 'ok:' || (now() + interval '20 days')::date::text
  and (select count(*) from public.event_stock_windows where quote_id = 'a0000000-0000-4000-8000-00000000da01') = 2
  and pg_temp.as_val('a_admin@a.test', $q$select jsonb_array_length(public.stock_overlaps('a0000000-0000-4000-8000-00000000da01'))$q$) = 'ok:0');
select pg_temp.as_val('r191_wh@a.test', $q$select public.inventory_settings_set(null, null, 2)$q$);
select pg_temp.t('11f 2 buffer days: events 2 days apart overlap again', pg_temp.as_val('a_admin@a.test',
  $q$select jsonb_array_length(public.stock_overlaps('a0000000-0000-4000-8000-00000000da01'))$q$) = 'ok:1'
  and pg_temp.as_val('a_admin@a.test', $q$select (public.checkout_availability('a0000000-0000-4000-8000-0000000a1911', 'a0000000-0000-4000-8000-00000000da01') -> 'reserved_by' -> 0 ->> 'qty')$q$) = 'ok:60');
select pg_temp.t('11g a set-up date after the event day is refused', pg_temp.as_val('a_admin@a.test',
  $q$select public.event_stock_window_set('a0000000-0000-4000-8000-00000000da01', (now() + interval '21 days')::date, null)$q$) like '22023%');
select pg_temp.as_val('r191_wh@a.test', $q$select public.inventory_settings_set(null, null, 0)$q$);

-- ---- 12) stock still out from a finished event counts on later dates ---------------------------------------------------------
insert into public.inventory_checkouts (id, item_id, quote_id, qty_out, issued_to, status, org_id) values
  ('a0000000-0000-4000-8000-0000000c1915', 'a0000000-0000-4000-8000-0000000a1913', 'a0000000-0000-4000-8000-00000000d192', 30, 'Old crew', 'out', 'a0000000-0000-4000-8000-000000000001');
select pg_temp.t('12a uplights: 30 still out from a gala 10 days ago - a future event can reserve only what is on the shelf',
  public._r374_load('a0000000-0000-4000-8000-0000000a1913', 'a0000000-0000-4000-8000-00000000d191', 'a0000000-0000-4000-8000-000000000001') = 30
  and pg_temp.as_val('a_admin@a.test', $q$select (public.reserve_inventory('a0000000-0000-4000-8000-0000000a1913', 'a0000000-0000-4000-8000-00000000d191', (select total_qty from public.inventory_items where id = 'a0000000-0000-4000-8000-0000000a1913') - 29)).qty$q$) like 'P0001%',
  public._r374_load('a0000000-0000-4000-8000-0000000a1913', 'a0000000-0000-4000-8000-00000000d191', 'a0000000-0000-4000-8000-000000000001')::text);

-- ---- 13) zero drift: no R191 rows -> the kept ledger answer -----------------------------------------------------------------
insert into public.inventory_checkouts (id, item_id, quote_id, qty_out, qty_in, issued_to, status, written_off, org_id) values
  ('a0000000-0000-4000-8000-0000000c1916', 'a0000000-0000-4000-8000-0000000a1913', 'a0000000-0000-4000-8000-00000000d192', 4, 3, 'Old crew', 'partial', 1, 'a0000000-0000-4000-8000-000000000001');
select pg_temp.t('13a an event with an old-style write-off and no new rows: ledger exactly as before',
  public._r21_cost_lines('a0000000-0000-4000-8000-00000000d192', 'a0000000-0000-4000-8000-000000000001')
  = public._r21_cost_lines__pre0374('a0000000-0000-4000-8000-00000000d192', 'a0000000-0000-4000-8000-000000000001'));
select pg_temp.t('13b the event totals still add up with the split lines',
  (select sum((l ->> 'c_act')::numeric) from jsonb_array_elements(pg_temp.lines('a0000000-0000-4000-8000-00000000da01')) l where l ->> 'source' = 'writeoff')
  = 10500 + 2400 + 400 - 2400 + (select (written_off) * 2500 from public.inventory_checkouts where id = 'a0000000-0000-4000-8000-0000000c1913')
          + (select (written_off) * 2500 from public.inventory_checkouts where id = 'a0000000-0000-4000-8000-0000000c1914')
          + (select coalesce(sum(written_off), 0) * 2500 from public.inventory_checkouts where quote_id = 'a0000000-0000-4000-8000-00000000da01' and item_id = 'a0000000-0000-4000-8000-0000000a1913' and id not in ('a0000000-0000-4000-8000-0000000c1913', 'a0000000-0000-4000-8000-0000000c1914')),
  pg_temp.lines('a0000000-0000-4000-8000-00000000da01')::text);

-- ---- 14) another studio gets nothing ------------------------------------------------------------------------------------------
select pg_temp.t('14a studio B cannot read, find, repair, decide or photo studio A lines',
  pg_temp.as_val('b_admin@b.test', $q$select public.stock_story('a0000000-0000-4000-8000-00000000da01')$q$) like '42501%'
  and pg_temp.as_val('b_admin@b.test', $q$select public.stock_found('a0000000-0000-4000-8000-0000000c1912', 1)$q$) like '42501%'
  and pg_temp.as_val('b_admin@b.test', $q$select public.stock_repair('a0000000-0000-4000-8000-0000000c1912', 'start', 1)$q$) like '42501%'
  and pg_temp.as_val('b_admin@b.test', $q$select public.stock_damage_decision('a0000000-0000-4000-8000-0000000c1913', 'charge', 10)$q$) like '42501%'
  and pg_temp.as_val('b_admin@b.test', $q$select public.event_stock_window_set('a0000000-0000-4000-8000-00000000da01', null, null)$q$) like '42501%'
  and pg_temp.as_val('b_admin@b.test', $q$select public.stock_overlaps('a0000000-0000-4000-8000-00000000da01')$q$) like '42501%');
select pg_temp.t('14b studio B''s story and windows show none of studio A',
  pg_temp.as_val('b_admin@b.test', $q$select count(*) from jsonb_object_keys(public.stock_story(null) -> 'lines')$q$) = 'ok:0'
  and pg_temp.as_val('b_admin@b.test', $q$select jsonb_array_length(public.stock_windows(array['a0000000-0000-4000-8000-00000000da01'::uuid]))$q$) = 'ok:0');

-- ---- 16) item costs: Finance only unless the studio lets stock staff see them ----------------------------------------------------
select pg_temp.t('16a warehouse (Inventory edit, no Finance) gets no item cost; admin does; both read the item type',
  pg_temp.as_val('r191_wh@a.test', $q$select count(*) from public.inventory_costs(array['a0000000-0000-4000-8000-0000000a1911'::uuid])$q$) = 'ok:0'
  and pg_temp.as_val('a_admin@a.test', $q$select unit_cost from public.inventory_costs(array['a0000000-0000-4000-8000-0000000a1911'::uuid])$q$) = 'ok:1200'
  and pg_temp.as_val('r191_wh@a.test', $q$select item_kind from public.inventory_items where id = 'a0000000-0000-4000-8000-0000000a1912'$q$) = 'ok:consumable'
  and pg_temp.as_val('r191_wh@a.test', $q$select unit_cost from public.inventory_items where id = 'a0000000-0000-4000-8000-0000000a1912'$q$) like '42501%');
select pg_temp.t('16b warehouse cannot switch costs on for itself', pg_temp.as_val('r191_wh@a.test',
  $q$select public.inventory_settings_set(null, null, null, true)$q$) like '42501%');
select pg_temp.r('16c', 'a_admin@a.test', $q$select public.inventory_settings_set(null, null, null, true) ->> 'stock_costs'$q$);
select pg_temp.t('16c admin turns "stock staff see item costs" on: warehouse gets the cost', pg_temp.v('16c') = 'ok:true'
  and pg_temp.as_val('r191_wh@a.test', $q$select unit_cost from public.inventory_costs(array['a0000000-0000-4000-8000-0000000a1911'::uuid])$q$) = 'ok:1200'
  and pg_temp.as_val('r191_wh@a.test', $q$select (public.inventory_settings_get() ->> 'can_cost')$q$) = 'ok:true');

-- ---- 15) re-run safe ----------------------------------------------------------------------------------------------------------
select pg_temp.t('15a each wrap kept once, the live bodies are R191',
  to_regprocedure('public._r21_cost_lines__pre0374__pre0374(uuid,uuid)') is null
  and position('r191-inventory-0374' in pg_get_functiondef(to_regprocedure('public._r21_cost_lines__pre0374(uuid,uuid)'))) = 0
  and position('r191-inventory-0374' in pg_get_functiondef(to_regprocedure('public.public_portal_extras__pre0374(uuid)'))) = 0
  and position('r191-inventory-0374' in pg_get_functiondef(to_regprocedure('public.worker_checkin_equipment__pre0374(uuid,uuid,numeric)'))) = 0
  and (select count(*) from pg_trigger where tgname = 'a374_insert_only') = 3
  and (select count(*) from pg_policies where policyname like 'event_docs_stock_%_0374') = 2
  and position('r191-inventory-0374' in pg_get_functiondef(to_regprocedure('public.inventory_costs__pre0374(uuid[])'))) = 0);
do $$ declare n int; f int; r record; begin
  select count(*), count(*) filter (where result <> 'PASS') into n, f from _rs;
  for r in select * from _rs where result <> 'PASS' loop raise warning '% -> %', r.name, r.result; end loop;
  if f = 0 then raise warning 'R191-INVENTORY-0374: ALL PASS (%/%)', n, n;
  else raise warning 'R191-INVENTORY-0374: % FAILED of %', f, n; end if;
end $$;
rollback;
