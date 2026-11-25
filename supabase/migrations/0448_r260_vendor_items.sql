-- 0448_r260_vendor_items.sql - R260 (owner, 25 Nov 2026: "On Pre-event: vendor check-in items and all; check-out on the Wrap-up. Add it safely").
-- Forward-only, additive, safe to run twice. ASCII only. Paste the whole file in the Supabase SQL editor; the last statement answers one row per
-- check. The pages work without it (Arrived / Left and the 0444 answer, as today).
-- REQUIRES 0396 (_r396_event), 0442 (_r442_name), 0444 (event_wrap_records). Reads 0447 (vendor request products) only when it is there.
--
-- In plain words:
--   A  THE LIST. The items of a booked vendor = the products of their accepted request (0447: the approved answer), else the booking itself (its name
--      and quantity, or the quantity of the need it covers). People (freelancers, staff needs) are no items. Items added by hand come on top.
--   B  CHECK IN / CHECK OUT. Per item how many are fine and how many are damaged; the server works out what is missing. Missing / damaged needs a note.
--      A vendor without a list has one question (all arrived / some missing / with a problem). Every answer is one new row with who and when; Undo is
--      a row too. Nothing is ever changed or deleted. Stock counts, the booking, its status, cost and bills are not touched.
--   C  WRAP-UP. "All their items handed back?" is worked out from the checked-out items; the 0444 answer given later than those still wins.
--   Rights: change = Event-day command edit + Vendors view (the arrival rows' right, 0444). See = Event-day command view + Vendors view; Settlement /
--   Finance view see only what was missing or broken. Same studio only, signed in only. A closed or cancelled event takes nothing.
--
-- ZERO DATA LOSS: 1 new table + 7 functions, event_wrap_records_get (0444) re-created with the worked-out answers added. No stored row is changed.
-- ROLLBACK (manual): run the event_wrap_records_get part of 0444 again and drop the functions; the table can stay.

-- ---- 0) preflight -----------------------------------------------------------------------------------------------------
do $$ declare f text; begin
  foreach f in array array['public._r396_event(uuid)', 'public._r442_name()', 'public.has_area(text,text)', 'public._r444_item(public.event_wrap_records)', 'public.event_wrap_records_get(uuid)'] loop
    if to_regprocedure(f) is null then raise exception 'STOP 0448: run 0396, 0442 and 0444 first (% missing)', f; end if;
  end loop;
  if to_regclass('public.event_resources') is null or to_regclass('public.event_resource_needs') is null or to_regclass('public.event_day') is null then raise exception 'STOP 0448: the vendor bookings are missing'; end if;
end $$;

-- ---- 1) the table: insert-only, server only -------------------------------------------------------------------------------
create table if not exists public.event_vendor_item_log (
  id          uuid primary key default gen_random_uuid(),
  seq         bigint generated always as identity,
  org_id      uuid not null references public.organizations(id),
  quote_id    uuid not null references public.quotes(id) on delete cascade,
  booking_id  uuid not null,
  phase       text not null,
  item_key    text not null,
  label       text not null,
  unit        text,
  expected    numeric,
  qty_ok      numeric,
  qty_missing numeric,
  qty_damaged numeric,
  state       text not null,
  note        text,
  by_user     uuid,
  by_name     text,
  request_id  uuid not null,
  at          timestamptz not null default clock_timestamp(),
  constraint event_vendor_item_phase_chk448 check (phase in ('in', 'out') and (item_key <> '*' or phase = 'in')),
  constraint event_vendor_item_state_chk448 check (state in ('ok', 'missing', 'damaged', 'undo')),
  constraint event_vendor_item_text_chk448 check (item_key ~ '^(\*|[0-9a-f]{32})$' and char_length(btrim(label)) between 1 and 120 and char_length(coalesce(unit, '')) <= 20 and char_length(coalesce(note, '')) <= 300 and char_length(coalesce(by_name, '')) <= 80),
  constraint event_vendor_item_note_chk448 check (state not in ('missing', 'damaged') or char_length(btrim(coalesce(note, ''))) > 0),
  constraint event_vendor_item_qty_chk448 check (case when state = 'undo' or item_key = '*' then expected is null and qty_ok is null and qty_missing is null and qty_damaged is null
    else expected is not null and expected > 0 and qty_ok is not null and qty_ok >= 0 and qty_missing is not null and qty_missing >= 0 and qty_damaged is not null and qty_damaged >= 0 and qty_ok + qty_damaged <= expected * 10
      and (state = 'missing') = (qty_missing > 0) and (state = 'ok') = (qty_missing = 0 and qty_damaged = 0) end)
);
comment on table public.event_vendor_item_log is 'r260-0448: the items of a booked vendor checked in (Pre-event) and out (Wrap-up): how many fine / missing / damaged, note, who, when. Insert-only, Undo is a row, the newest row per item wins.';
create index if not exists event_vendor_item_quote448 on public.event_vendor_item_log (quote_id, booking_id, phase, item_key, seq desc);
create index if not exists event_vendor_item_org448 on public.event_vendor_item_log (org_id);
create unique index if not exists event_vendor_item_req448 on public.event_vendor_item_log (request_id, booking_id, phase, item_key);

do $$ declare r text; v_def text; begin
  alter table public.event_vendor_item_log enable row level security;
  revoke all on table public.event_vendor_item_log from public;
  foreach r in array array['anon', 'authenticated', 'service_role'] loop
    if exists (select 1 from pg_roles where rolname = r) then execute format('revoke all on table public.event_vendor_item_log from %I', r); end if;
  end loop;
  if exists (select 1 from pg_roles where rolname = 'service_role') then grant select on table public.event_vendor_item_log to service_role; end if;
  if to_regprocedure('public.tg_quote_org_match()') is not null
     and not exists (select 1 from pg_trigger where tgrelid = 'public.event_vendor_item_log'::regclass and tgname = 'zz_quote_org_match') then
    create trigger zz_quote_org_match before insert or update on public.event_vendor_item_log for each row execute function public.tg_quote_org_match();
  end if;
  if to_regprocedure('public.tg_studio_read_only()') is not null
     and not exists (select 1 from pg_trigger where tgrelid = 'public.event_vendor_item_log'::regclass and tgname = 'zzz_studio_read_only') then
    create trigger zzz_studio_read_only before insert or update or delete on public.event_vendor_item_log for each row execute function public.tg_studio_read_only('org_id');
  end if;
  -- free-trial retention (0184): they go with the studio's events (patched in place once, like 0444)
  if to_regprocedure('public._tr184_purge_tables()') is not null then
    v_def := pg_get_functiondef('public._tr184_purge_tables()'::regprocedure);
    if position('''event_vendor_item_log''' in v_def) = 0 then
      if (length(v_def) - length(replace(v_def, '''event_issues'', ', ''))) / length('''event_issues'', ') <> 1 then
        raise notice '0448: _tr184_purge_tables has an unexpected body - left unchanged';
      else execute replace(v_def, '''event_issues'', ', '''event_issues'', ''event_vendor_item_log'', '); end if;
    end if;
  end if;
end $$;

-- ---- 2) helpers (server only) ---------------------------------------------------------------------------------------------
create or replace function public._r448_text(p_text text, p_max integer)
returns text language plpgsql immutable set search_path = '' as $fn$
-- r260-0448
declare v text := nullif(btrim(regexp_replace(coalesce(p_text, ''), '[[:cntrl:][:space:]]+', ' ', 'g')), '');
begin
  if char_length(coalesce(v, '')) > p_max then raise exception 'Use up to % characters.', p_max using errcode = '22023', hint = 'r448_text'; end if;
  if coalesce(v, '') ~ '[<>]' then raise exception 'Leave out < and >.' using errcode = '22023', hint = 'r448_text'; end if;
  return v;
end $fn$;
-- one name = one item of a vendor, however it is written
create or replace function public._r448_key(p_label text)
returns text language sql immutable set search_path = '' as $fn$
  -- r260-0448
  select md5(lower(btrim(regexp_replace(coalesce(p_label, ''), '[[:cntrl:][:space:]]+', ' ', 'g'))));
$fn$;

-- what each booked vendor brings: 0447 products when there, else the booking itself
create or replace function public._r448_src(p_quote uuid, p_org uuid)
returns table (booking_id uuid, item_key text, label text, unit text, expected numeric, ord bigint)
language plpgsql stable security definer set search_path = '' as $fn$
-- r260-0448
declare v_map jsonb := '{}'::jsonb; v_offer text := 'null::jsonb';
begin
  if to_regclass('public.vendor_requests') is not null
     and exists (select 1 from pg_catalog.pg_attribute a where a.attrelid = to_regclass('public.vendor_requests') and a.attname = 'lines' and a.atttypid = 'jsonb'::regtype and not a.attisdropped) then
    if to_regclass('public.vendor_offers') is not null then
      v_offer := '(select o.lines from public.vendor_offers o where o.request_id = r.id and o.status = ''approved'' order by o.seq desc limit 1)';
    end if;
    execute 'select coalesce(jsonb_object_agg(x.booking_id, x.l), ''{}''::jsonb) from (select distinct on (r.booking_id) r.booking_id, coalesce(' || v_offer || ', r.lines) as l
               from public.vendor_requests r where r.quote_id = $1 and r.org_id = $2 and r.booking_id is not null and r.status = ''accepted'' order by r.booking_id, r.created_at desc) x where jsonb_typeof(x.l) = ''array'''
      into v_map using p_quote, p_org;
  end if;
  return query
  with b as (
    select e.id, e.status, e.kind, e.created_at, e.qty, n.kind as nkind, n.qty as nqty,
           left(btrim(regexp_replace(regexp_replace(coalesce(e.label, ''), '[[:cntrl:][:space:]<>]+', ' ', 'g'), '\s*\(stock shortfall\)\s*$', '', 'i')), 120) as lb
      from public.event_resources e left join public.event_resource_needs n on n.id = e.need_id and n.quote_id = p_quote
     where e.quote_id = p_quote and e.org_id = p_org and e.status not in ('cancelled', 'enquiry')
  ), l as (
    select b.id as bid, left(btrim(regexp_replace(x.v ->> 'name', '[[:cntrl:][:space:]<>]+', ' ', 'g')), 120) as lb, nullif(left(btrim(regexp_replace(coalesce(x.v ->> 'unit', ''), '[[:cntrl:][:space:]<>]+', ' ', 'g')), 20), '') as un,
           round((x.v ->> 'qty')::numeric, 2) as q, x.n
      from b cross join lateral jsonb_array_elements(coalesce(v_map -> b.id::text, '[]'::jsonb)) with ordinality x(v, n)
     where jsonb_typeof(x.v -> 'qty') = 'number' and btrim(coalesce(x.v ->> 'name', '')) <> '' and x.n <= 60
  ), k as (
    select l.bid, public._r448_key(l.lb) as ik, min(l.lb) as lb, min(l.un) as un, sum(l.q) as q, min(l.n) as n from l where l.q > 0 and l.lb <> '' group by l.bid, public._r448_key(l.lb)
  ), o as (
    select b.id as bid, b.lb, round(case when b.qty is not null and b.qty > 0 then b.qty else b.nqty end, 2) as q from b
     where coalesce(b.kind, '') <> 'freelancer' and coalesce(b.nkind, '') <> 'staff' and b.lb <> '' and not exists (select 1 from k where k.bid = b.id)
  )
  select k.bid, k.ik, k.lb, k.un, k.q, k.n from k
  union all
  select o.bid, public._r448_key(o.lb), o.lb, null::text, o.q, 1::bigint from o where o.q is not null and o.q > 0;
end $fn$;

-- the newest row per item and phase
create or replace function public._r448_last(p_quote uuid, p_org uuid)
returns setof public.event_vendor_item_log language sql stable security definer set search_path = '' as $fn$
  -- r260-0448
  select distinct on (g.booking_id, g.phase, g.item_key) g.* from public.event_vendor_item_log g
   where g.quote_id = p_quote and g.org_id = p_org order by g.booking_id, g.phase, g.item_key, g.seq desc;
$fn$;
create or replace function public._r448_row(p public.event_vendor_item_log)
returns jsonb language sql immutable set search_path = '' as $fn$
  -- r260-0448
  select case when p.id is null or p.state = 'undo' then null else jsonb_build_object('id', p.id, 'state', p.state, 'expected', p.expected, 'ok', p.qty_ok, 'missing', p.qty_missing, 'damaged', p.qty_damaged, 'note', p.note, 'by', p.by_name, 'at', p.at) end;
$fn$;

-- Wrap-up's answer per vendor, worked out from what was checked out: every item that came in is back = returned; something missing = not returned;
-- something broken = problem; not finished and nothing wrong = no answer yet
create or replace function public._r448_answers(p_quote uuid, p_org uuid)
returns table (booking_id uuid, state text, qty_total numeric, qty_back numeric, note text, by_name text, at timestamptz)
language sql stable security definer set search_path = '' as $fn$
  -- r260-0448
  with t as (select * from public._r448_last(p_quote, p_org) x where x.item_key <> '*' and x.state <> 'undo'),
  p as (select coalesce(i.booking_id, o.booking_id) as bid, coalesce(o.label, i.label) as label, case when i.id is not null then i.qty_ok + i.qty_damaged else o.expected end as came, o
          from (select * from t where t.phase = 'in') i full join (select * from t where t.phase = 'out') o on o.booking_id = i.booking_id and o.item_key = i.item_key),
  s as (select p.bid, count(*) filter (where p.came > 0) as n, count((p.o).id) as outs, sum(p.came) as came, sum((p.o).qty_ok + (p.o).qty_damaged) as back, coalesce(sum((p.o).qty_missing), 0) as miss, coalesce(sum((p.o).qty_damaged), 0) as dmg, max((p.o).at) as at,
               (array_agg((p.o).by_name order by (p.o).seq desc) filter (where (p.o).id is not null))[1] as by_name,
               string_agg(p.label || ': ' || concat_ws(', ', case when (p.o).qty_missing > 0 then trim(to_char((p.o).qty_missing, 'FM999999990.##'), '.') || ' not returned' end, case when (p.o).qty_damaged > 0 then trim(to_char((p.o).qty_damaged, 'FM999999990.##'), '.') || ' broken' end)
                 || coalesce(' - ' || (p.o).note, ''), '; ' order by (p.o).seq) filter (where (p.o).qty_missing > 0 or (p.o).qty_damaged > 0) as note
          from p group by p.bid)
  select s.bid, case when s.miss > 0 then 'not_returned' when s.dmg > 0 then 'problem' else 'returned' end, case when s.outs >= s.n then s.came end, case when s.outs >= s.n then s.back end, left(s.note, 500), s.by_name, s.at
    from s where s.outs > 0 and (s.outs >= s.n or s.miss > 0 or s.dmg > 0);
$fn$;

-- ---- 3) what the pages call ------------------------------------------------------------------------------------------------
create or replace function public.event_vendor_items_get(p_quote uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $fn$
-- r260-0448
declare v_org uuid := public._r396_event(p_quote); v_full boolean; v_out jsonb; q record; v_closed boolean;
begin
  v_full := coalesce(public.has_area('vendors', 'view'), false) and coalesce(public.has_area('command', 'view'), false);
  if not v_full and not coalesce(public.has_area('settlement', 'view'), false) and not coalesce(public.has_area('finance', 'view'), false) then raise exception 'not allowed' using errcode = '42501'; end if;
  select x.status, x.lifecycle_stage into q from public.quotes x where x.id = p_quote;
  v_closed := coalesce(q.status, '') in ('cancelled', 'lost') or coalesce(q.lifecycle_stage, '') in ('closed', 'cancelled', 'archived');
  with src as (select * from public._r448_src(p_quote, v_org)),
  t as (select * from public._r448_last(p_quote, v_org)),
  ks as (select s.booking_id, s.item_key from src s union select t.booking_id, t.item_key from t where t.state <> 'undo' and t.item_key <> '*'),
  it as (
    select k.booking_id, coalesce(s.ord, 1000) as ord, coalesce(s.label, i.label, o.label) as label,
           jsonb_build_object('key', k.item_key, 'label', coalesce(s.label, i.label, o.label), 'unit', coalesce(s.unit, i.unit, o.unit), 'expected', coalesce(s.expected, i.expected, o.expected), 'listed', s.item_key is not null,
             'in', public._r448_row(i), 'in_seen', i.id, 'out', public._r448_row(o), 'out_seen', o.id) as j
      from ks k left join src s on s.booking_id = k.booking_id and s.item_key = k.item_key
      left join t i on i.booking_id = k.booking_id and i.item_key = k.item_key and i.phase = 'in'
      left join t o on o.booking_id = k.booking_id and o.item_key = k.item_key and o.phase = 'out'
  ),
  bad as (
    select t.booking_id, jsonb_agg(jsonb_build_object('phase', t.phase, 'label', case when t.item_key = '*' then null else t.label end, 'state', t.state, 'missing', t.qty_missing, 'damaged', t.qty_damaged, 'note', t.note, 'by', t.by_name, 'at', t.at) order by t.phase, t.seq) as j
      from t where t.state in ('missing', 'damaged') group by t.booking_id
  )
  select coalesce(jsonb_object_agg(e.id, jsonb_build_object('problems', coalesce(bad.j, '[]'::jsonb)) || case when not v_full then '{}'::jsonb else
      jsonb_build_object('vendor', left(coalesce(nullif(btrim(v.name), ''), nullif(btrim(e.label), ''), 'Vendor'), 120), 'vendor_id', e.vendor_id, 'label', left(coalesce(e.label, ''), 120), 'status', e.status,
        'arrival', (select d.status from public.event_day d where d.quote_id = p_quote and d.org_id = v_org and d.kind = 'arrival' and d.ref_id = e.id order by coalesce(d.updated_at, d.created_at) desc limit 1),
        'items', coalesce((select jsonb_agg(it.j order by it.ord, lower(it.label)) from it where it.booking_id = e.id), '[]'::jsonb),
        'all', (select public._r448_row(t) from t where t.booking_id = e.id and t.item_key = '*' limit 1), 'all_seen', (select t.id from t where t.booking_id = e.id and t.item_key = '*' limit 1)) end), '{}'::jsonb) into v_out
    from public.event_resources e left join public.vendors v on v.id = e.vendor_id and v.org_id = v_org left join bad on bad.booking_id = e.id
   where e.quote_id = p_quote and e.org_id = v_org and (case when v_full then e.status not in ('cancelled', 'enquiry') or bad.j is not null else bad.j is not null end);
  return jsonb_build_object('v', 1, 'full', v_full, 'closed', v_closed, 'can_edit', v_full and not v_closed and coalesce(public.has_area('command', 'edit'), false), 'vendors', v_out);
end $fn$;

-- check in / out one or more items (max 200 in one press, 60 per vendor), or Undo. p_items: [{ booking, key, seen, ok, damaged, note } | { booking, key, seen, undo: true }
-- | { booking, key: "*", seen, answer: "ok"|"missing"|"damaged", note } | { booking, label, qty }]. seen = the row the page showed (null = none): somebody
-- else was faster = nothing at all is written and the new state is answered. p_request = made by the page: the same press twice is one set of rows.
create or replace function public.event_vendor_items_set(p_quote uuid, p_phase text, p_items jsonb, p_request uuid default null)
returns jsonb language plpgsql volatile security definer set search_path = '' as $fn$
-- r260-0448
declare v_org uuid := public._r396_event(p_quote); q record; x record; e jsonb; k text; b record; v_bid uuid; v_key text; v_note text; v_label text; v_unit text; v_exp numeric; v_ok numeric; v_dmg numeric; v_miss numeric; v_state text;
        cur public.event_vendor_item_log; oth public.event_vendor_item_log; s record; v_seen uuid; v_rows jsonb := '[]'::jsonb; v_done text[] := '{}'; v_req uuid := coalesce(p_request, gen_random_uuid()); v_found boolean;
begin
  if not coalesce(public.has_area('command', 'edit'), false) or not coalesce(public.has_area('vendors', 'view'), false) then raise exception 'not allowed' using errcode = '42501'; end if;
  if coalesce(p_phase, '') not in ('in', 'out') then raise exception 'invalid_phase' using errcode = '22023'; end if;
  if jsonb_typeof(p_items) is distinct from 'array' or jsonb_array_length(p_items) not between 1 and 200 then raise exception 'Choose at least one item.' using errcode = '22023'; end if;
  select y.status, y.lifecycle_stage into q from public.quotes y where y.id = p_quote;
  if coalesce(q.status, '') in ('cancelled', 'lost') or coalesce(q.lifecycle_stage, '') in ('closed', 'cancelled', 'archived') then
    raise exception 'This event is closed or cancelled - nothing can be changed here.' using errcode = '22023', hint = 'r448_closed'; end if;
  perform pg_catalog.pg_advisory_xact_lock(hashtextextended('r448:' || p_quote::text, 0));   -- one change at a time per event
  if p_request is not null then
    select * into cur from public.event_vendor_item_log g where g.request_id = p_request limit 1;
    if cur.id is not null then
      if cur.org_id is distinct from v_org or cur.quote_id is distinct from p_quote then raise exception 'not allowed' using errcode = '42501'; end if;
      return jsonb_build_object('ok', true, 'same', true, 'state', public.event_vendor_items_get(p_quote));
    end if;
  end if;
  for x in select i.v, i.n from jsonb_array_elements(p_items) with ordinality i(v, n) order by i.n loop
    e := x.v; if jsonb_typeof(e) is distinct from 'object' then raise exception 'invalid_item' using errcode = '22023'; end if;
    for k in select jsonb_object_keys(e) loop
      if k not in ('booking', 'key', 'seen', 'ok', 'damaged', 'note', 'undo', 'answer', 'label', 'qty') then raise exception 'unknown field %', k using errcode = '22023'; end if;
    end loop;
    if coalesce(e ->> 'booking', '') !~* '^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$' or (e ->> 'seen' is not null and e ->> 'seen' !~* '^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$') then raise exception 'invalid_item' using errcode = '22023'; end if;
    v_bid := (e ->> 'booking')::uuid; v_seen := (e ->> 'seen')::uuid;
    select r.id, r.status into b from public.event_resources r where r.id = v_bid and r.quote_id = p_quote and r.org_id = v_org;
    if b.id is null then raise exception 'This vendor is not on the event any more.' using errcode = 'P0002'; end if;
    if b.status in ('cancelled', 'enquiry') then raise exception 'This vendor is not booked for the event.' using errcode = '22023', hint = 'r448_not_booked'; end if;
    v_note := public._r448_text(e ->> 'note', 300); v_unit := null; v_exp := null; v_ok := null; v_dmg := null; v_miss := null; v_found := false; s := null; oth := null;
    if e ? 'label' then
      -- not on the list: it came, so it is checked in
      if p_phase <> 'in' or e ? 'key' then raise exception 'invalid_item' using errcode = '22023'; end if;
      v_label := public._r448_text(e ->> 'label', 120);
      if v_label is null then raise exception 'Write what came.' using errcode = '22023', hint = 'r448_label'; end if;
      if jsonb_typeof(e -> 'qty') is distinct from 'number' then raise exception 'How many came? Use a number above 0.' using errcode = '22023', hint = 'r448_qty'; end if;
      v_exp := (e ->> 'qty')::numeric;
      if v_exp <= 0 or v_exp > 1000000 or v_exp <> round(v_exp, 2) then raise exception 'How many came? Use a number above 0.' using errcode = '22023', hint = 'r448_qty'; end if;
      v_key := public._r448_key(v_label);
      if exists (select 1 from public._r448_src(p_quote, v_org) z where z.booking_id = v_bid and z.item_key = v_key)
         or exists (select 1 from public._r448_last(p_quote, v_org) z where z.booking_id = v_bid and z.item_key = v_key and z.state <> 'undo') then
        raise exception '% is already on the list.', v_label using errcode = '22023', hint = 'r448_listed'; end if;
      if (select count(*) from (select z.item_key from public._r448_src(p_quote, v_org) z where z.booking_id = v_bid union select z.item_key from public._r448_last(p_quote, v_org) z where z.booking_id = v_bid and z.state <> 'undo' and z.item_key <> '*') c)
         + (select count(*) from jsonb_array_elements(v_rows) w(v) where w.v ->> 'b' = v_bid::text and (w.v ->> 'new')::boolean) >= 60 then raise exception 'A vendor can have up to 60 items.' using errcode = '22023', hint = 'r448_full'; end if;
      v_ok := v_exp; v_dmg := 0; v_miss := 0; v_state := 'ok';
    else
      v_key := coalesce(e ->> 'key', '');
      if v_key !~ '^(\*|[0-9a-f]{32})$' then raise exception 'invalid_item' using errcode = '22023'; end if;
      select * into cur from public.event_vendor_item_log g where g.quote_id = p_quote and g.org_id = v_org and g.booking_id = v_bid and g.phase = p_phase and g.item_key = v_key order by g.seq desc limit 1;
      if cur.id is distinct from v_seen then return jsonb_build_object('ok', false, 'changed', true, 'state', public.event_vendor_items_get(p_quote)); end if;
      select * into oth from public.event_vendor_item_log g where g.quote_id = p_quote and g.org_id = v_org and g.booking_id = v_bid and g.phase = case p_phase when 'in' then 'out' else 'in' end and g.item_key = v_key order by g.seq desc limit 1;
      if p_phase = 'in' and oth.id is not null and oth.state <> 'undo' then raise exception '% is already checked out. Undo that first.', oth.label using errcode = '22023', hint = 'r448_out'; end if;
      if v_key = '*' then
        if p_phase <> 'in' then raise exception 'invalid_item' using errcode = '22023'; end if;
        v_label := 'All items'; v_found := true;
      else
        select z.label, z.unit, z.expected into s from public._r448_src(p_quote, v_org) z where z.booking_id = v_bid and z.item_key = v_key;
        v_found := found;
        if v_found then v_label := s.label; v_unit := s.unit; v_exp := s.expected;
        elsif cur.id is not null then v_label := cur.label; v_unit := cur.unit; v_exp := cur.expected; v_found := cur.state <> 'undo' or p_phase = 'out' and oth.id is not null and oth.state <> 'undo';
        elsif oth.id is not null and oth.state <> 'undo' then v_label := oth.label; v_unit := oth.unit; v_exp := oth.expected; v_found := true; end if;
        if not v_found then raise exception 'This item is not on the list any more.' using errcode = 'P0002'; end if;
        if p_phase = 'out' then v_exp := case when oth.id is not null and oth.state <> 'undo' then oth.qty_ok + oth.qty_damaged else coalesce(v_exp, oth.expected) end; end if;
      end if;
      if e ? 'undo' then
        if e -> 'undo' is distinct from 'true'::jsonb then raise exception 'invalid_item' using errcode = '22023'; end if;
        if cur.id is null or cur.state = 'undo' then continue; end if;
        v_state := 'undo'; v_label := cur.label; v_unit := cur.unit; v_note := null; v_exp := null;
      elsif v_key = '*' then
        v_state := e ->> 'answer'; if coalesce(v_state, '') not in ('ok', 'missing', 'damaged') then raise exception 'invalid_item' using errcode = '22023'; end if;
        if v_state <> 'ok' and v_note is null then raise exception 'Write a short note: what is missing or damaged.' using errcode = '22023', hint = 'r448_note'; end if;
      else
        if jsonb_typeof(e -> 'ok') is distinct from 'number' or (e ? 'damaged' and jsonb_typeof(e -> 'damaged') not in ('number', 'null')) then raise exception 'Type how many.' using errcode = '22023', hint = 'r448_qty'; end if;
        if v_exp is null or v_exp <= 0 then raise exception '%: nothing of this came in.', v_label using errcode = '22023', hint = 'r448_qty'; end if;
        v_ok := (e ->> 'ok')::numeric; v_dmg := coalesce((e ->> 'damaged')::numeric, 0);
        if v_ok < 0 or v_dmg < 0 or v_ok <> round(v_ok, 2) or v_dmg <> round(v_dmg, 2) then raise exception 'Use numbers of 0 or more, with up to 2 decimals.' using errcode = '22023', hint = 'r448_qty'; end if;
        if p_phase = 'in' and v_ok + v_dmg > v_exp * 10 then raise exception '%: that is far more than the % expected. Check the number.', v_label, trim(to_char(v_exp, 'FM999999990.##'), '.') using errcode = '22023', hint = 'r448_qty'; end if;
        if p_phase = 'out' and v_ok + v_dmg > v_exp then raise exception '%: only % came in.', v_label, trim(to_char(v_exp, 'FM999999990.##'), '.') using errcode = '22023', hint = 'r448_qty'; end if;
        v_miss := greatest(v_exp - v_ok - v_dmg, 0); v_state := case when v_miss > 0 then 'missing' when v_dmg > 0 then 'damaged' else 'ok' end;
        if v_state <> 'ok' and v_note is null then raise exception '%: write a short note about what is missing or damaged.', v_label using errcode = '22023', hint = 'r448_note'; end if;
      end if;
    end if;
    if (v_bid::text || v_key) = any(v_done) then raise exception 'The same item is there twice.' using errcode = '22023'; end if;
    v_done := v_done || (v_bid::text || v_key);
    v_rows := v_rows || jsonb_build_array(jsonb_build_object('b', v_bid, 'k', v_key, 'l', v_label, 'u', v_unit, 'e', v_exp, 'ok', v_ok, 'm', v_miss, 'd', v_dmg, 's', v_state, 'n', v_note, 'new', e ? 'label'));
  end loop;
  if jsonb_array_length(v_rows) = 0 then return jsonb_build_object('ok', true, 'same', true, 'state', public.event_vendor_items_get(p_quote)); end if;
  if (select count(*) from public.event_vendor_item_log g where g.quote_id = p_quote) + jsonb_array_length(v_rows) > 5000 then raise exception 'Too many changes on this event.' using errcode = '22023', hint = 'r448_full'; end if;
  insert into public.event_vendor_item_log (org_id, quote_id, booking_id, phase, item_key, label, unit, expected, qty_ok, qty_missing, qty_damaged, state, note, by_user, by_name, request_id)
  select v_org, p_quote, (w.v ->> 'b')::uuid, p_phase, w.v ->> 'k', w.v ->> 'l', w.v ->> 'u', (w.v ->> 'e')::numeric, (w.v ->> 'ok')::numeric, (w.v ->> 'm')::numeric, (w.v ->> 'd')::numeric, w.v ->> 's', w.v ->> 'n', auth.uid(), public._r442_name(), v_req
    from jsonb_array_elements(v_rows) with ordinality w(v, n) order by w.n;
  return jsonb_build_object('ok', true, 'state', public.event_vendor_items_get(p_quote));
end $fn$;

-- 0444's read + the answers worked out from the items (items: true); the id stays the 0444 row's, so its "seen" check works as before. The 0444 answer
-- given after the last checked-out item wins.
create or replace function public.event_wrap_records_get(p_quote uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $fn$
-- r258-0444 + r260-0448
declare v_org uuid := public._r396_event(p_quote); v_v boolean; v_s boolean;
begin
  v_v := coalesce(public.has_area('vendors', 'view'), false) and coalesce(public.has_area('command', 'view'), false);
  v_s := coalesce(public.has_area('inventory', 'view'), false) or coalesce(public.has_area('command', 'view'), false);
  if not v_v and not v_s then raise exception 'not allowed' using errcode = '42501'; end if;
  return jsonb_build_object('v', 1,
    'vendor', case when v_v then coalesce((select jsonb_object_agg(x.ref_id, public._r444_item(x)) from
        (select distinct on (w.ref_id) w.* from public.event_wrap_records w where w.quote_id = p_quote and w.org_id = v_org and w.part = 'vendor' order by w.ref_id, w.seq desc) x), '{}'::jsonb)
      || coalesce((select jsonb_object_agg(a.booking_id, jsonb_build_object('id', l.id, 'ref', a.booking_id, 'label', l.label, 'state', a.state, 'qty_total', a.qty_total, 'qty_back', a.qty_back, 'note', a.note, 'by', a.by_name, 'at', a.at, 'items', true))
            from public._r448_answers(p_quote, v_org) a
            left join lateral (select w.id, w.label, w.state, w.at from public.event_wrap_records w where w.quote_id = p_quote and w.org_id = v_org and w.part = 'vendor' and w.ref_id = a.booking_id order by w.seq desc limit 1) l on true
           where l.id is null or l.state = 'undo' or l.at < a.at), '{}'::jsonb) end,
    'stock', case when v_s then coalesce((select jsonb_agg(public._r444_item(x) order by x.seq desc) from
        (select w.* from public.event_wrap_records w where w.quote_id = p_quote and w.org_id = v_org and w.part = 'stock' order by w.seq desc limit 200) x), '[]'::jsonb) end,
    'log', case when v_v then coalesce((select jsonb_agg(public._r444_item(x) order by x.seq desc) from
        (select w.* from public.event_wrap_records w where w.quote_id = p_quote and w.org_id = v_org and w.part = 'vendor' order by w.seq desc limit 100) x), '[]'::jsonb) end);
end $fn$;

-- ---- 4) grants ---------------------------------------------------------------------------------------------------------------
do $$ declare f text; r text; begin
  foreach f in array array['public._r448_text(text,integer)', 'public._r448_key(text)', 'public._r448_src(uuid,uuid)', 'public._r448_last(uuid,uuid)', 'public._r448_row(public.event_vendor_item_log)', 'public._r448_answers(uuid,uuid)'] loop
    execute format('revoke all on function %s from public', f);
    foreach r in array array['anon', 'authenticated'] loop
      if exists (select 1 from pg_roles where rolname = r) then execute format('revoke all on function %s from %I', f, r); end if;
    end loop;
  end loop;
  foreach f in array array['public.event_vendor_items_get(uuid)', 'public.event_vendor_items_set(uuid,text,jsonb,uuid)', 'public.event_wrap_records_get(uuid)'] loop
    execute format('revoke all on function %s from public', f);
    if exists (select 1 from pg_roles where rolname = 'anon') then execute format('revoke all on function %s from anon', f); end if;
    foreach r in array array['authenticated', 'service_role'] loop
      if exists (select 1 from pg_roles where rolname = r) then execute format('grant execute on function %s to %I', f, r); end if;
    end loop;
  end loop;
end $$;

do $$ begin
  if to_regclass('public.helm_schema_markers') is not null then
    insert into public.helm_schema_markers(num, name) values (448, '0448_r260_vendor_items') on conflict (num) do nothing;
  end if;
end $$;

notify pgrst, 'reload schema';

-- ---- 5) CHECK (read only): every row must say true ---------------------------------------------------------------------------
select c.check, c.ok from (values
  ('01 the table is there, row security on, no direct access', (select bool_and(c.relrowsecurity and not has_table_privilege('authenticated', c.oid, 'select,insert,update,delete') and not has_table_privilege('anon', c.oid, 'select,insert,update,delete') and not has_table_privilege('service_role', c.oid, 'insert,update,delete'))
      from pg_class c where c.oid = 'public.event_vendor_item_log'::regclass)),
  ('02 a record always belongs to its event''s studio', to_regprocedure('public.tg_quote_org_match()') is null
      or exists (select 1 from pg_trigger where tgname = 'zz_quote_org_match' and tgrelid = 'public.event_vendor_item_log'::regclass)),
  ('03 signed-in people only', has_function_privilege('authenticated', 'public.event_vendor_items_set(uuid,text,jsonb,uuid)', 'execute') and has_function_privilege('authenticated', 'public.event_vendor_items_get(uuid)', 'execute')
      and not has_function_privilege('anon', 'public.event_vendor_items_set(uuid,text,jsonb,uuid)', 'execute') and not has_function_privilege('anon', 'public.event_vendor_items_get(uuid)', 'execute') and not has_function_privilege('anon', 'public.event_wrap_records_get(uuid)', 'execute')),
  ('04 helpers are server only', (select count(*) = 6 and bool_and(not has_function_privilege('authenticated', p.oid, 'execute') and not has_function_privilege('anon', p.oid, 'execute')) from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname like '\_r448\_%')),
  ('05 search_path pinned on all nine', (select count(*) = 9 and bool_and(coalesce(p.proconfig @> array['search_path=""'], false)) from pg_proc p where p.pronamespace = 'public'::regnamespace
      and (p.proname like '\_r448\_%' or p.proname in ('event_vendor_items_get', 'event_vendor_items_set', 'event_wrap_records_get')))),
  ('06 the rights are asked for in the database', position('has_area(''command'', ''edit'')' in pg_get_functiondef('public.event_vendor_items_set(uuid,text,jsonb,uuid)'::regprocedure)) > 0),
  ('07 Wrap-up''s answer is worked out from the items', position('_r448_answers' in pg_get_functiondef('public.event_wrap_records_get(uuid)'::regprocedure)) > 0),
  ('08 the free-trial clean-up knows the table', to_regprocedure('public._tr184_purge_tables()') is null or position('event_vendor_item_log' in pg_get_functiondef('public._tr184_purge_tables()'::regprocedure)) > 0)
) c("check", ok);
