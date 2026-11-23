-- 0430_r248_layout_stock.sql - R248 (owner, 23 Nov 2026: "In 2D/3D layout we add all the products; those products should be
-- shown on the Inventory page - needed, available, need to borrow / rent"). Forward-only, additive, safe to run twice. ASCII only.
-- REQUIRES base quotes / quote_versions / inventory_items / inventory_reservations / inventory_checkouts / organizations,
--          has_area + current_org_id (phase29 / phase57), 0268 (_r24_not_back), 0374 (_r374_win, _r374_load, _r374_buffer:
--          the per-DAY stock windows), 0198 (_a198_org_today). Optional: 0045 / 0314 (tg_studio_read_only), 0340 (tg_audit),
--          0184 (free-trial purge list), 0412 (helm_schema_markers).
--
-- In plain words:
--   1  A floor plan (2D and 3D share it: the latest quote_versions row of an event) lists objects by type - "table", "chiavari",
--      "barricade" ... Nothing linked a layout type to a stock item. NEW inventory_layout_links: "1 Round Table = 1 Round table
--      6 ft + 8 Chiavari chairs" = two links of type "table" (per object 1, and per seat 1 counted on the seats). One active
--      link per studio + type + item. Removing a link keeps the row (removed_at, removed_by) - nothing is deleted.
--      Writes only through layout_link_set / layout_link_remove (Inventory edit, own studio, an active own item);
--      the table itself is read-only for the app (Inventory view, own studio).
--   2  layout_stock_needs(event) - Inventory view, own studio: the latest floor plan counted ONCE (one pass over its items):
--      per type the objects and seats, the links, and per linked stock item: needed, what this event already holds
--      (reserved or out), what is still free on its stock days (the SAME 0374 day-window rule the reserve guard uses:
--      _r374_load), to borrow / rent = needed - held - free (never below 0), and the other events whose stock days overlap
--      that hold or need the same item ("same day"), with the shortfall if they all go ahead. Types with no link are listed
--      so the page can ask to link them. Quantities only - never an amount.
--   3  layout_stock_overview(from, to) - Inventory view: every live event whose stock days touch the range (default today ..
--      +30 days, at most 1 year, at most 60 events) with its block from 2 + a summary (events short, same-day clashes).
--   4  layout_links() - Inventory view: the studio's active links with the item name (the "Link layout products" list).
--   5  inventory_demand(event) - the Inventory page's startup read: the stock demand already counted per item + event (reserved,
--      still out) with each event's date / live / stock window, in ONE call instead of every reservation + check-out + event row
--      over 3+ round trips. Same numbers as before, quantities only.
-- Helm counts stock by DAY (0374). No time of day here (the time-aware calendar is on hold).
-- What this does NOT do: it never creates a stock item, never reserves, never changes or releases a reservation. The page's
--   "Reserve from layout" button uses the existing reserve_inventory_with_sourcing (0197 / 0374), item by item, after a confirm.
-- ZERO DATA LOSS: additive + idempotent. One new table (RLS on, select only), new functions, triggers on the new table only
--   (read-only studio guard, audit, item same-studio guard), the free-trial purge list learns the new table (patched in place once,
--   like 0427). Nothing dropped, nothing deleted, no existing function, policy or row changed.
-- ROLLBACK (only if ever needed): revoke execute on the 5 layout functions from authenticated - the page then hides the
--   From layouts tab ("database update pending"); the table can stay. Revoking inventory_demand makes the page read the rows as before.

-- ---- 0) preflight ---------------------------------------------------------------------------------------------------------
do $$ begin
  if to_regclass('public.quotes') is null or to_regclass('public.quote_versions') is null or to_regclass('public.inventory_items') is null
     or to_regclass('public.inventory_reservations') is null or to_regclass('public.inventory_checkouts') is null
     or to_regclass('public.organizations') is null then
    raise exception 'STOP 0430: quotes / quote_versions / inventory tables missing'; end if;
  if to_regprocedure('public.has_area(text,text)') is null or to_regprocedure('public.current_org_id()') is null then
    raise exception 'STOP 0430: has_area / current_org_id missing (phase29 / phase57)'; end if;
  if to_regprocedure('public._r374_win(uuid,uuid)') is null or to_regprocedure('public._r374_load(uuid,uuid,uuid)') is null
     or to_regprocedure('public._r374_buffer(uuid)') is null then
    raise exception 'STOP 0430: apply 0374 (stock windows) first'; end if;
  if to_regprocedure('public._r24_not_back(numeric,numeric,numeric,numeric)') is null then
    raise exception 'STOP 0430: apply 0268 (stock one flow) first'; end if;
  if to_regprocedure('public._a198_org_today(uuid)') is null then raise exception 'STOP 0430: apply 0198 first'; end if;
  if to_regclass('public.event_stock_windows') is null then raise exception 'STOP 0430: apply 0374 (event_stock_windows) first'; end if;
end $$;

-- ---- 1) the links -----------------------------------------------------------------------------------------------------------
create table if not exists public.inventory_layout_links (
  id          uuid primary key default gen_random_uuid(),
  org_id      uuid not null references public.organizations(id),
  layout_type text not null,
  item_id     uuid not null references public.inventory_items(id) on delete cascade,   -- items are never hard-deleted by the app (0296); the trial purge / sample clear-out take their links
  per_object  numeric not null default 1,
  count_mode  text not null default 'objects',
  created_at  timestamptz not null default now(),
  created_by  uuid,
  updated_at  timestamptz,
  removed_at  timestamptz,
  removed_by  uuid,
  constraint inventory_layout_links_type_chk430 check (layout_type ~ '^[a-z][a-z0-9_]{0,39}$'),
  constraint inventory_layout_links_per_chk430 check (per_object > 0 and per_object <= 10000),
  constraint inventory_layout_links_mode_chk430 check (count_mode in ('objects', 'seats'))
);
comment on table public.inventory_layout_links is
  'r248-0430: which stock item a floor-plan object type uses ("table" -> Round table x1 + Chiavari chair x1 per seat). One active row per studio + type + item; removing keeps the row (removed_at). Written only by layout_link_set / layout_link_remove.';
create unique index if not exists inventory_layout_links_active_uq430 on public.inventory_layout_links (org_id, layout_type, item_id) where removed_at is null;
create index if not exists ix_inventory_layout_links_org_0430 on public.inventory_layout_links (org_id);
create index if not exists ix_inventory_layout_links_item_0430 on public.inventory_layout_links (item_id);

alter table public.inventory_layout_links enable row level security;
revoke all on table public.inventory_layout_links from public;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'anon') then execute 'revoke all on table public.inventory_layout_links from anon'; end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    execute 'revoke all on table public.inventory_layout_links from authenticated';
    execute 'grant select on table public.inventory_layout_links to authenticated';
  end if;
  if exists (select 1 from pg_roles where rolname = 'service_role') then execute 'grant select on table public.inventory_layout_links to service_role'; end if;
end $$;
drop policy if exists r430_links_read on public.inventory_layout_links;
create policy r430_links_read on public.inventory_layout_links for select to authenticated
  using ((select public.has_area('inventory', 'view')) and org_id = (select public.current_org_id()));

-- the linked item must be a stock item of the same studio (also for server code), the type stays as written
create or replace function public._r430_tg_link_guard()
returns trigger language plpgsql security definer set search_path = '' as $fn$
-- r248-0430
begin
  if not exists (select 1 from public.inventory_items i where i.id = new.item_id and i.org_id = new.org_id) then
    raise exception 'the stock item belongs to another studio' using errcode = '42501'; end if;
  if tg_op = 'UPDATE' and (new.org_id is distinct from old.org_id or new.layout_type is distinct from old.layout_type
                           or new.item_id is distinct from old.item_id) then
    raise exception 'a layout link keeps its studio, type and item - remove it and link again' using errcode = '22023'; end if;
  return new;
end $fn$;
revoke all on function public._r430_tg_link_guard() from public;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'anon') then execute 'revoke all on function public._r430_tg_link_guard() from anon'; end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then execute 'revoke all on function public._r430_tg_link_guard() from authenticated'; end if;
end $$;
drop trigger if exists ab_r430_link_guard on public.inventory_layout_links;
create trigger ab_r430_link_guard before insert or update on public.inventory_layout_links
  for each row execute function public._r430_tg_link_guard();
-- a suspended / ended-trial studio takes no new rows (0045 / 0314) + every change in the Audit log (shared tg_audit)
do $$ begin
  if to_regprocedure('public.tg_studio_read_only()') is not null
     and not exists (select 1 from pg_catalog.pg_trigger where tgname = 'zzz_studio_read_only' and tgrelid = 'public.inventory_layout_links'::regclass) then
    execute 'create trigger zzz_studio_read_only before insert or update or delete on public.inventory_layout_links for each row execute function public.tg_studio_read_only(''org_id'')';
  end if;
  if to_regprocedure('public.tg_audit()') is not null then
    execute 'drop trigger if exists audit_trg on public.inventory_layout_links';
    execute 'create trigger audit_trg after insert or delete or update on public.inventory_layout_links for each row execute function public.tg_audit()';
  end if;
end $$;

-- ---- 2) helpers (server only) -----------------------------------------------------------------------------------------------
-- a JSON number (or a plain number written as text) 0 .. 100000, else null - the builder writes rows / cols / seats as numbers
create or replace function public._r430_num(p jsonb)
returns numeric language sql immutable set search_path = '' as $fn$
  -- r248-0430
  select case when jsonb_typeof(p) = 'number' then least(greatest((p #>> '{}')::numeric, 0), 100000)
              when jsonb_typeof(p) = 'string' and (p #>> '{}') ~ '^\s*[0-9]{1,6}(\.[0-9]{1,4})?\s*$' then least((p #>> '{}')::numeric, 100000)
         end;
$fn$;

-- the latest floor plan of an event, counted once: per type the objects and the seats (same seat rule as the builder's
-- pricing.seatCount: rows x cols, else seats, else 1 for a single chair / bar stool)
create or replace function public._r430_type_counts(p_quote uuid, p_org uuid)
returns table(layout_type text, category text, label text, objects integer, seats integer)
language sql stable security definer set search_path = '' as $fn$
  -- r248-0430
  with v as (select qv.data from public.quote_versions qv where qv.quote_id = p_quote and qv.org_id = p_org
              order by qv.version_no desc, qv.created_at desc limit 1),
       it as (select lower(btrim(e ->> 'type')) as t, nullif(btrim(e ->> 'category'), '') as cat, left(nullif(btrim(e ->> 'label'), ''), 80) as lbl,
                     case when jsonb_typeof(e -> 'properties') = 'object' then e -> 'properties' else '{}'::jsonb end as p
                from v cross join lateral jsonb_array_elements(case when jsonb_typeof(v.data -> 'items') = 'array' then v.data -> 'items' else '[]'::jsonb end) e
               where jsonb_typeof(e) = 'object'),
       s as (select it.t, it.cat, it.lbl,
                    case when floor(coalesce(public._r430_num(it.p -> 'rows'), 0)) > 0 and floor(coalesce(public._r430_num(it.p -> 'cols'), 0)) > 0
                           then least(floor(public._r430_num(it.p -> 'rows')) * floor(public._r430_num(it.p -> 'cols')), 100000)
                         when floor(coalesce(public._r430_num(it.p -> 'seats'), 0)) > 0 then floor(public._r430_num(it.p -> 'seats'))
                         when it.t in ('chiavari', 'barstool') then 1 else 0 end as seats
               from it where it.t ~ '^[a-z][a-z0-9_]{0,39}$')
  select s.t, left(max(s.cat), 40), mode() within group (order by s.lbl), count(*)::integer, least(sum(s.seats), 2000000000)::integer
    from s group by s.t order by s.t;
$fn$;

-- per stock item: how many the event's latest floor plan needs (each link rounded up, then added per item)
create or replace function public._r430_item_needs(p_quote uuid, p_org uuid)
returns table(item_id uuid, needed numeric)
language sql stable security definer set search_path = '' as $fn$
  -- r248-0430
  select l.item_id, sum(ceil((case when l.count_mode = 'seats' then tc.seats else tc.objects end) * l.per_object))
    from public._r430_type_counts(p_quote, p_org) tc
    join public.inventory_layout_links l on l.org_id = p_org and l.removed_at is null and l.layout_type = tc.layout_type
   group by l.item_id;
$fn$;

-- what an event already holds of an item: reserved or out (the larger, the 0374 _r374_load per-event rule)
create or replace function public._r430_held(p_item uuid, p_quote uuid, p_org uuid)
returns numeric language sql stable security definer set search_path = '' as $fn$
  -- r248-0430
  select greatest(
    coalesce((select sum(r.qty) from public.inventory_reservations r
               where r.item_id = p_item and r.quote_id = p_quote and r.status in ('reserved', 'allocated')), 0),
    coalesce((select sum(public._r24_not_back(c.qty_out, c.qty_in, c.written_off, c.qty_damaged)) from public.inventory_checkouts c
               where c.item_id = p_item and c.quote_id = p_quote and c.org_id = p_org and c.status in ('out', 'partial')), 0));
$fn$;

-- one event: its floor-plan types + links, and per linked item needed / held / free / to borrow + the same-day events
create or replace function public._r430_event_block(p_quote uuid, p_org uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $fn$
-- r248-0430
declare v_q record; v_f date; v_t date; v_buf integer := public._r374_buffer(p_org); v_vno integer;
        v_types jsonb; v_base jsonb; v_items jsonb; v_unlinked jsonb; v_objects integer;
begin
  select q.id, q.code, q.title, q.event_date, q.status, q.lifecycle_stage into v_q from public.quotes q where q.id = p_quote and q.org_id = p_org;
  if not found then return null; end if;
  select w.d_from, w.d_to into v_f, v_t from public._r374_win(p_quote, p_org) w;
  select max(qv.version_no) into v_vno from public.quote_versions qv where qv.quote_id = p_quote and qv.org_id = p_org;

  -- the floor plan is read ONCE here (materialized), everything else is small
  with tc as materialized (select * from public._r430_type_counts(p_quote, p_org)),
       ln as (select l.id, l.layout_type, l.item_id, l.per_object, l.count_mode, i.name, i.unit, i.category, coalesce(i.total_qty, 0) as total,
                     coalesce(i.active, true) as active,
                     ceil((case when l.count_mode = 'seats' then tc.seats else tc.objects end) * l.per_object) as needed
                from tc join public.inventory_layout_links l on l.org_id = p_org and l.removed_at is null and l.layout_type = tc.layout_type
                join public.inventory_items i on i.id = l.item_id and i.org_id = p_org)
  select
    coalesce((select jsonb_agg(jsonb_build_object('layout_type', tc.layout_type, 'category', tc.category, 'label', tc.label,
                'objects', tc.objects, 'seats', tc.seats,
                'links', coalesce((select jsonb_agg(jsonb_build_object('link_id', ln.id, 'item_id', ln.item_id, 'item_name', ln.name,
                                     'per_object', ln.per_object, 'count_mode', ln.count_mode, 'needed', ln.needed) order by ln.name, ln.id)
                                    from ln where ln.layout_type = tc.layout_type), '[]'::jsonb)) order by tc.category nulls last, tc.layout_type) from tc), '[]'::jsonb),
    coalesce((select jsonb_agg(jsonb_build_object('item_id', x.item_id, 'name', x.name, 'unit', x.unit, 'category', x.category,
                'total', x.total, 'active', x.active, 'needed', x.needed, 'types', x.types) order by x.name)
                from (select ln.item_id, max(ln.name) as name, max(ln.unit) as unit, max(ln.category) as category, max(ln.total) as total,
                             bool_and(ln.active) as active, sum(ln.needed) as needed, jsonb_agg(distinct ln.layout_type) as types
                        from ln group by ln.item_id) x), '[]'::jsonb),
    coalesce((select jsonb_agg(jsonb_build_object('layout_type', tc.layout_type, 'category', tc.category, 'label', tc.label,
                'objects', tc.objects, 'seats', tc.seats) order by tc.category nulls last, tc.layout_type)
                from tc where not exists (select 1 from ln where ln.layout_type = tc.layout_type)), '[]'::jsonb),
    coalesce((select sum(tc.objects) from tc), 0)::integer
  into v_types, v_base, v_unlinked, v_objects;

  -- per item: held by this event, still free on its stock days, to borrow; other events on overlapping days (max 40)
  with base as (select (b ->> 'item_id')::uuid as item_id, b from jsonb_array_elements(v_base) b),
       win as (select distinct on (x.quote_id) x.quote_id, x.setup_from, x.teardown_to
                 from public.event_stock_windows x where x.org_id = p_org and v_f is not null order by x.quote_id, x.seq desc),
       oth as (select q.id, coalesce(nullif(btrim(q.title), ''), q.code, 'Event') as title,
                      coalesce(win.setup_from, q.event_date) as d_from, coalesce(win.teardown_to, q.event_date) + v_buf as d_to
                 from public.quotes q left join win on win.quote_id = q.id
                where v_f is not null and q.org_id = p_org and q.id <> p_quote and q.event_date is not null
                  and q.deleted_at is null and q.archived_at is null and q.status <> 'cancelled'
                  and not (q.lifecycle_stage = 'closed' and q.status = 'confirmed')
                  and coalesce(win.setup_from, q.event_date) <= v_t and v_f <= coalesce(win.teardown_to, q.event_date) + v_buf
                order by 3, q.id limit 40),
       oneed as (select o.id, n.item_id, n.needed from oth o cross join lateral public._r430_item_needs(o.id, p_org) n
                  where exists (select 1 from base where base.item_id = n.item_id)),
       opairs as (select o.id, o.title, o.d_from, o.d_to, base.item_id,
                         coalesce((select n.needed from oneed n where n.id = o.id and n.item_id = base.item_id), 0) as needed,
                         public._r430_held(base.item_id, o.id, p_org) as held
                    from oth o cross join base),
       calc as (select base.item_id, base.b,
                       public._r430_held(base.item_id, p_quote, p_org) as held,
                       greatest(coalesce((base.b ->> 'total')::numeric, 0) - public._r374_load(base.item_id, p_quote, p_org), 0) as free
                  from base)
  select coalesce(jsonb_agg(c.b || jsonb_build_object(
           'held', c.held, 'free', c.free,
           'to_reserve', greatest((c.b ->> 'needed')::numeric - c.held, 0),
           'to_borrow', greatest((c.b ->> 'needed')::numeric - c.held - c.free, 0),
           'to_borrow_shared', case when (c.b ->> 'needed')::numeric - c.held <= 0 then 0
                                    else greatest((c.b ->> 'needed')::numeric - c.held
                                                  + coalesce((select sum(greatest(p.needed - p.held, 0)) from opairs p where p.item_id = c.item_id), 0) - c.free, 0) end,
           'same_day', coalesce((select jsonb_agg(jsonb_build_object('quote_id', p.id, 'event', p.title, 'from', p.d_from, 'to', p.d_to - v_buf,
                                                                     'needs', p.needed, 'holds', p.held) order by p.d_from, p.title)
                                   from opairs p where p.item_id = c.item_id and (p.needed > 0 or p.held > 0)), '[]'::jsonb))
           order by c.b ->> 'name'), '[]'::jsonb)
    into v_items from calc c;

  return jsonb_build_object('quote_id', v_q.id, 'code', v_q.code, 'title', v_q.title, 'event_date', v_q.event_date, 'status', v_q.status,
    'stage', v_q.lifecycle_stage, 'version_no', v_vno, 'from', v_f, 'to', case when v_t is not null then v_t - v_buf end,
    'objects', v_objects, 'types', v_types, 'items', v_items, 'unlinked', v_unlinked,
    'short_items', (select count(*) from jsonb_array_elements(v_items) e where (e ->> 'to_borrow')::numeric > 0),
    'shared_items', (select count(*) from jsonb_array_elements(v_items) e
                      where (e ->> 'to_borrow_shared')::numeric > (e ->> 'to_borrow')::numeric));
end $fn$;

do $$ declare f text; begin
  foreach f in array array['public._r430_num(jsonb)', 'public._r430_type_counts(uuid,uuid)', 'public._r430_item_needs(uuid,uuid)',
                           'public._r430_held(uuid,uuid,uuid)', 'public._r430_event_block(uuid,uuid)'] loop
    execute format('revoke all on function %s from public', f);
    if exists (select 1 from pg_roles where rolname = 'anon') then execute format('revoke all on function %s from anon', f); end if;
    if exists (select 1 from pg_roles where rolname = 'authenticated') then execute format('revoke all on function %s from authenticated', f); end if;
  end loop;
end $$;

-- ---- 3) the calls ---------------------------------------------------------------------------------------------------------
-- one event (the Inventory per-event panel, ?quote=)
create or replace function public.layout_stock_needs(p_quote uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $fn$
-- r248-0430
declare v_org uuid := public.current_org_id();
begin
  if v_org is null or auth.uid() is null or not coalesce(public.has_area('inventory', 'view'), false) then
    raise exception 'not authorized' using errcode = '42501'; end if;
  if p_quote is null or not exists (select 1 from public.quotes q where q.id = p_quote and q.org_id = v_org) then
    raise exception 'event not found' using errcode = '42501'; end if;
  return public._r430_event_block(p_quote, v_org);
end $fn$;

-- upcoming events (default today .. +30 days), each with its block, + a summary
create or replace function public.layout_stock_overview(p_from date default null, p_to date default null)
returns jsonb language plpgsql stable security definer set search_path = '' as $fn$
-- r248-0430
declare v_org uuid := public.current_org_id(); v_from date; v_to date; v_ids uuid[]; v_more boolean; v_events jsonb; v_buf integer;
begin
  if v_org is null or auth.uid() is null or not coalesce(public.has_area('inventory', 'view'), false) then
    raise exception 'not authorized' using errcode = '42501'; end if;
  v_from := coalesce(p_from, public._a198_org_today(v_org));
  v_to := coalesce(p_to, v_from + 30);
  if v_to < v_from then raise exception 'the end date is before the start date' using errcode = '22023'; end if;
  if v_to - v_from > 366 then raise exception 'pick at most one year' using errcode = '22023'; end if;
  v_buf := public._r374_buffer(v_org);
  with win as (select distinct on (x.quote_id) x.quote_id, x.setup_from, x.teardown_to
                 from public.event_stock_windows x where x.org_id = v_org order by x.quote_id, x.seq desc)
  select array_agg(z.id order by z.d_from, z.event_date, z.id), count(*) > 60 into v_ids, v_more
    from (select q.id, q.event_date, coalesce(win.setup_from, q.event_date) as d_from
            from public.quotes q left join win on win.quote_id = q.id
           where q.org_id = v_org and q.event_date is not null
             and q.deleted_at is null and q.archived_at is null and q.status <> 'cancelled'
             and not (q.lifecycle_stage = 'closed' and q.status = 'confirmed')
             and coalesce(win.setup_from, q.event_date) <= v_to and v_from <= coalesce(win.teardown_to, q.event_date) + v_buf
             and exists (select 1 from public.quote_versions qv where qv.quote_id = q.id and qv.org_id = v_org)
           order by 3, q.event_date, q.id limit 61) z;
  v_ids := coalesce(v_ids[1:60], '{}'::uuid[]);
  select coalesce(jsonb_agg(public._r430_event_block(x.id, v_org) order by x.n), '[]'::jsonb) into v_events
    from unnest(v_ids) with ordinality x(id, n);
  return jsonb_build_object('from', v_from, 'to', v_to, 'more', coalesce(v_more, false), 'events', v_events,
    'summary', jsonb_build_object(
      'events', jsonb_array_length(v_events),
      'events_short', (select count(*) from jsonb_array_elements(v_events) e where (e ->> 'short_items')::integer > 0),
      'events_shared', (select count(*) from jsonb_array_elements(v_events) e where (e ->> 'shared_items')::integer > 0),
      'unlinked_types', (select count(distinct u ->> 'layout_type') from jsonb_array_elements(v_events) e, jsonb_array_elements(e -> 'unlinked') u)));
end $fn$;

-- the studio's active links with the item name
create or replace function public.layout_links()
returns jsonb language plpgsql stable security definer set search_path = '' as $fn$
-- r248-0430
declare v_org uuid := public.current_org_id();
begin
  if v_org is null or auth.uid() is null or not coalesce(public.has_area('inventory', 'view'), false) then
    raise exception 'not authorized' using errcode = '42501'; end if;
  return coalesce((select jsonb_agg(jsonb_build_object('link_id', l.id, 'layout_type', l.layout_type, 'item_id', l.item_id,
            'item_name', i.name, 'unit', i.unit, 'item_active', coalesce(i.active, true), 'per_object', l.per_object, 'count_mode', l.count_mode)
            order by l.layout_type, i.name, l.id)
     from public.inventory_layout_links l join public.inventory_items i on i.id = l.item_id and i.org_id = v_org
    where l.org_id = v_org and l.removed_at is null), '[]'::jsonb);
end $fn$;

-- link (or change) a layout type -> stock item; the same type + item again = the same row (per object / mode updated)
create or replace function public.layout_link_set(p_type text, p_item uuid, p_per_object numeric default 1, p_count_mode text default 'objects')
returns jsonb language plpgsql security definer set search_path = '' as $fn$
-- r248-0430
declare v_org uuid := public.current_org_id(); v_type text := lower(btrim(coalesce(p_type, ''))); v_mode text := coalesce(nullif(btrim(coalesce(p_count_mode, '')), ''), 'objects');
        v_per numeric := coalesce(p_per_object, 1); v_row public.inventory_layout_links; v_n integer;
begin
  if v_org is null or auth.uid() is null or not coalesce(public.has_area('inventory', 'edit'), false) then
    raise exception 'not authorized' using errcode = '42501'; end if;
  if v_type !~ '^[a-z][a-z0-9_]{0,39}$' then raise exception 'unknown layout product' using errcode = '22023'; end if;
  if v_mode not in ('objects', 'seats') then raise exception 'count per object or per seat' using errcode = '22023'; end if;
  if v_per <= 0 or v_per > 10000 or round(v_per, 2) <> v_per then
    raise exception 'how many per object must be above 0 (at most 10000, 2 decimals)' using errcode = '22023'; end if;
  if p_item is null or not exists (select 1 from public.inventory_items i where i.id = p_item and i.org_id = v_org and coalesce(i.active, true)) then
    raise exception 'stock item not found' using errcode = '42501'; end if;
  perform pg_advisory_xact_lock(hashtextextended('helm:r430:' || v_org::text || ':' || v_type, 0));
  select * into v_row from public.inventory_layout_links l
   where l.org_id = v_org and l.layout_type = v_type and l.item_id = p_item and l.removed_at is null;
  if found then
    if v_row.per_object is distinct from v_per or v_row.count_mode is distinct from v_mode then
      update public.inventory_layout_links set per_object = v_per, count_mode = v_mode, updated_at = now()
       where id = v_row.id returning * into v_row;
    end if;
  else
    select count(*) into v_n from public.inventory_layout_links l where l.org_id = v_org and l.layout_type = v_type and l.removed_at is null;
    if v_n >= 20 then raise exception 'at most 20 stock items per layout product' using errcode = '22023'; end if;
    insert into public.inventory_layout_links (org_id, layout_type, item_id, per_object, count_mode, created_by)
      values (v_org, v_type, p_item, v_per, v_mode, auth.uid()) returning * into v_row;
  end if;
  return jsonb_build_object('link_id', v_row.id, 'layout_type', v_row.layout_type, 'item_id', v_row.item_id,
    'per_object', v_row.per_object, 'count_mode', v_row.count_mode);
end $fn$;

-- unlink: the row is kept (removed_at / removed_by), never deleted
create or replace function public.layout_link_remove(p_link uuid)
returns jsonb language plpgsql security definer set search_path = '' as $fn$
-- r248-0430
declare v_org uuid := public.current_org_id(); v_n integer;
begin
  if v_org is null or auth.uid() is null or not coalesce(public.has_area('inventory', 'edit'), false) then
    raise exception 'not authorized' using errcode = '42501'; end if;
  if not exists (select 1 from public.inventory_layout_links l where l.id = p_link and l.org_id = v_org) then
    raise exception 'link not found' using errcode = '42501'; end if;
  update public.inventory_layout_links set removed_at = now(), removed_by = auth.uid()
   where id = p_link and org_id = v_org and removed_at is null;
  get diagnostics v_n = row_count;
  return jsonb_build_object('removed', v_n > 0);
end $fn$;

do $$ declare f text; begin
  foreach f in array array['public.layout_stock_needs(uuid)', 'public.layout_stock_overview(date,date)', 'public.layout_links()',
                           'public.layout_link_set(text,uuid,numeric,text)', 'public.layout_link_remove(uuid)'] loop
    execute format('revoke all on function %s from public', f);
    if exists (select 1 from pg_roles where rolname = 'anon') then execute format('revoke all on function %s from anon', f); end if;
    if exists (select 1 from pg_roles where rolname = 'authenticated') then execute format('grant execute on function %s to authenticated', f); end if;
  end loop;
end $$;

-- ---- 3b) the Inventory page's startup read (owner, 23 Nov 2026: "the Inventory page loads slowly"): ONE call with the stock
-- demand already counted - per stock item + event: reserved (reserved / allocated) and still out (open check-outs, written-off
-- units not counted twice, the page's own rule), plus each event's date / live / stock window (0374 + buffer days). Before, the
-- page read EVERY reservation, EVERY check-out and then the events in chunks of 100 and their windows: 3+ round trips one after
-- the other and every row. Same numbers, quantities only (no amount, no name, no client). Inventory view, own studio.
create or replace function public.inventory_demand(p_quote uuid default null)
returns jsonb language plpgsql stable security definer set search_path = '' as $fn$
-- r248-0430
declare v_org uuid := public.current_org_id(); v_buf integer; v_rows jsonb; v_quotes jsonb;
begin
  if v_org is null or auth.uid() is null
     or not (coalesce(public.has_area('inventory', 'view'), false) or coalesce(public.has_area('inventory', 'edit'), false)) then
    raise exception 'not authorized' using errcode = '42501'; end if;
  v_buf := public._r374_buffer(v_org);
  with res as (select r.item_id, r.quote_id, sum(coalesce(r.qty, 0)) as q from public.inventory_reservations r
                where r.org_id = v_org and r.status in ('reserved', 'allocated') group by r.item_id, r.quote_id),
       co as (select c.item_id, c.quote_id,
                     sum(greatest(coalesce(c.qty_out, 0) - coalesce(c.qty_in, 0) - greatest(coalesce(c.written_off, 0) - coalesce(c.qty_damaged, 0), 0), 0)) as q
                from public.inventory_checkouts c where c.org_id = v_org and c.status in ('out', 'partial') group by c.item_id, c.quote_id),
       k as (select coalesce(res.item_id, co.item_id) as item_id, coalesce(res.quote_id, co.quote_id) as quote_id,
                    coalesce(res.q, 0) as res, coalesce(co.q, 0) as out_q
               from res full join co on co.item_id = res.item_id and co.quote_id is not distinct from res.quote_id)
  select coalesce(jsonb_agg(jsonb_build_object('i', k.item_id, 'q', k.quote_id, 'res', k.res, 'out', k.out_q)), '[]'::jsonb) into v_rows
    from k where k.res > 0 or k.out_q > 0;
  with ids as (select distinct (e ->> 'q')::uuid as id from jsonb_array_elements(v_rows) e where e ->> 'q' is not null
               union select p_quote where p_quote is not null),
       win as (select distinct on (x.quote_id) x.quote_id, x.setup_from, x.teardown_to
                 from public.event_stock_windows x join ids on ids.id = x.quote_id where x.org_id = v_org order by x.quote_id, x.seq desc),
       m as (select q.id, q.event_date,
                    not (q.deleted_at is not null or q.archived_at is not null or q.status = 'cancelled'
                         or (q.lifecycle_stage = 'closed' and q.status = 'confirmed')) as live,
                    coalesce(win.setup_from, q.event_date) as d_from, coalesce(win.teardown_to, q.event_date) + v_buf as d_to
               from public.quotes q join ids on ids.id = q.id left join win on win.quote_id = q.id where q.org_id = v_org)
  select coalesce(jsonb_object_agg(m.id, jsonb_build_object('date', m.event_date, 'active', m.live,
           'from', case when m.live and m.event_date is not null then m.d_from end, 'to', case when m.live and m.event_date is not null then m.d_to end)), '{}'::jsonb)
    into v_quotes from m;
  return jsonb_build_object('rows', v_rows, 'quotes', v_quotes);
end $fn$;
revoke all on function public.inventory_demand(uuid) from public;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'anon') then execute 'revoke all on function public.inventory_demand(uuid) from anon'; end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then execute 'grant execute on function public.inventory_demand(uuid) to authenticated'; end if;
end $$;

-- ---- 4) free-trial purge (0184): the links go with the studio's stock items ----------------------------------------------
do $$ declare v_def text; begin
  if to_regprocedure('public._tr184_purge_tables()') is not null then
    v_def := pg_get_functiondef('public._tr184_purge_tables()'::regprocedure);
    if position('''inventory_layout_links''' in v_def) = 0 then
      if (length(v_def) - length(replace(v_def, '''inventory_checkouts''', ''))) / length('''inventory_checkouts''') <> 1 then
        raise notice '0430: _tr184_purge_tables has an unexpected body - left unchanged';
      else execute replace(v_def, '''inventory_checkouts''', '''inventory_layout_links'', ''inventory_checkouts'''); end if;
    end if;
  end if;
end $$;

-- ---- 5) schema marker (0412) --------------------------------------------------------------------------------------------------
do $$ begin
  if to_regclass('public.helm_schema_markers') is not null then
    insert into public.helm_schema_markers(num, name) values (430, '0430_r248_layout_stock') on conflict (num) do nothing;
  end if;
end $$;

notify pgrst, 'reload schema';
