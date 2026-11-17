-- APPLY-0374 (R191 Money phase 3 inventory upgrade + phase 4 multi-day stock). Run on STAGING first, then production. Safe to run twice.
-- Adds item type (reusable / consumable), used / left-over and part-returns at Mark back, photo proof, found / repair rows, the absorb / charge-client decision, stock dates per event + buffer days, and keeps item costs for Finance. Three new insert-only tables, four functions wrapped once (old bodies kept). Nothing is changed or deleted. If it stops with a STOP message nothing was applied.
begin;
-- 0374_r191_inventory_upgrade.sql - R191 (Money phase 3 Inventory upgrade + phase 4 multi-day stock). Forward-only,
-- additive, safe to run twice. ASCII only.
-- REQUIRES 0268 (stock one flow: checkin_stock, _r24_not_back, _checkout_free, checkout_availability), 0071 + 0197 (reserve),
--          0073 (worker_checkin_equipment, cancel_checkout), 0246 + 0252 + 0265 (_r21_cost_lines: the event cost ledger),
--          phase24 (event_refunds: Recover from client), 0282 (_r282_event_closed), 0101 + 0260 + 0334 (public_portal_extras),
--          0198 (_a198_org_today), 0296 (_r55_purge_allowed), 0184 (free-trial purge lists), 0299 (inventory_costs, item columns).
--
-- In plain words (owner, 17 Nov 2026, MONEY-INVENTORY-PLAN.md phases 3-4 + Phase 3-4 review (R191)):
--   1  Item type. Every stock item is Reusable (chairs, lights - must come back) or Consumable (flowers, candles, tape -
--      used up). NEW inventory_items.item_kind (default reusable, so nothing changes until a studio marks items) and an
--      optional reorder_level (low-stock alert on the Inventory page).
--   2  Check-in (Mark back). Reusable: came back OK / damaged, the rest missing (as before), or some are still out -
--      coming back later: the counted part is recorded and the rest stays Out. Consumable: how many are left over (back
--      to stock), the rest was used (NEW inventory_checkouts.qty_used, costed on the event as a normal cost, never as a
--      loss). NEW checkin_stock_v2, the old checkin_stock keeps its inputs and answers and now also knows an earlier
--      part-return. The crew link refuses a returned total lower than what the store already counted.
--   3  Photo proof. A damaged or missing line needs a photo (studio setting, ON by default) on the Inventory and Teardown
--      screens (checked by checkin_stock_v2). Older screens still work, their lines show Photo needed and a photo can be
--      added later (stock_add_photo). Photos: private bucket event-docs, path <studio>/<event or none>/stock/<uuid>.<ext>.
--   4  Damage decision (Finance edit only): Studio absorbs (as today) or Charge client. A charge writes ONE pending
--      Recover from client row (event_refunds kind recovery, the existing Settlement path with its maker-checker and
--      closure check). It lowers Damages & loss in the event P&L only once it is processed (collected), rejected =
--      absorbed. The client portal shows the charge only when the studio turns that on (OFF by default).
--   5  Stock coming back, always as NEW rows, never by editing a write-off: found (a late return: back in stock, the
--      loss credited on that event), under repair -> repaired (back in stock, optional repair cost on the event that
--      broke it) or cannot be fixed. NEW insert-only inventory_stock_events.
--   6  Free stock. Stock still out from an event whose days are over (or from a cancelled / closed event) now counts as
--      off the shelf on every date, in the reserve guard too (the check-out guard already did), partly returned
--      check-outs are no longer counted twice in the reserve guard (same rule as 0268).
--   7  Multi-day (phase 4). Optional set-up from / teardown until per event (NEW insert-only event_stock_windows, the
--      newest row counts, quotes is not touched) + buffer days (studio setting, default 0). Reservations and check-outs
--      then block stock for the whole range, stock_overlaps lists the other events holding the same items on overlapping
--      days. No range + 0 buffer days = exactly the old one-day rule.
--   8  Money stays with Finance. Every amount (charge, repair cost) comes only through these functions and only to
--      people with Finance view, warehouse staff see quantities.
-- What changes in place (same name, inputs and output): checkin_stock, _checkout_free, checkout_availability,
--   reserve_inventory, reserve_inventory_with_sourcing. Wrapped once (old bodies kept as __pre0374): _r21_cost_lines,
--   public_portal_extras, worker_checkin_equipment, inventory_costs (item costs: Finance view, or stock staff only when the
--   studio turns stock staff see item costs on - default off).
-- ZERO DATA LOSS: 3 new columns (defaulted / nullable), 3 new insert-only tables (UPDATE refused, DELETE only for the
--   free-trial purge / sample clean-up), new functions, 2 new storage policies. No table, column, row or policy is
--   dropped, the script itself updates no existing row. Additive + idempotent: safe to run twice.
-- ROLLBACK (manual, only if ever needed): alter function public._r21_cost_lines__pre0374(uuid,uuid) rename to
--   _r21_cost_lines (after dropping the wrapper), same for public_portal_extras / worker_checkin_equipment, re-run the
--   0268 section 3 + 5 bodies and the 0071 / 0197 reserve bodies. The new tables and columns can stay.

do $$ begin
  if to_regclass('public.inventory_checkouts') is null or to_regclass('public.inventory_items') is null
     or to_regclass('public.inventory_reservations') is null or to_regclass('public.event_refunds') is null then
    raise exception 'STOP 0374: inventory / refund tables missing (phase7 / phase24 / phase33)'; end if;
  if to_regprocedure('public._r24_not_back(numeric,numeric,numeric,numeric)') is null
     or to_regprocedure('public.checkin_stock(uuid,numeric,numeric,text)') is null then
    raise exception 'STOP 0374: apply 0268 (stock one flow) first'; end if;
  if to_regprocedure('public.reserve_inventory_with_sourcing(uuid,uuid,numeric,text,text,uuid,numeric,text)') is null then
    raise exception 'STOP 0374: apply 0197 (stock shortage) first'; end if;
  if to_regprocedure('public._r21_cost_lines(uuid,uuid)') is null and to_regprocedure('public._r21_cost_lines__pre0374(uuid,uuid)') is null then
    raise exception 'STOP 0374: apply 0246 (event cost ledger) first'; end if;
  if to_regprocedure('public.public_portal_extras(uuid)') is null and to_regprocedure('public.public_portal_extras__pre0374(uuid)') is null then
    raise exception 'STOP 0374: apply 0101 (portal extras) first'; end if;
  if to_regprocedure('public.worker_checkin_equipment(uuid,uuid,numeric)') is null and to_regprocedure('public.worker_checkin_equipment__pre0374(uuid,uuid,numeric)') is null then
    raise exception 'STOP 0374: apply 0073 (crew link return) first'; end if;
  if to_regprocedure('public._r282_event_closed(uuid)') is null then raise exception 'STOP 0374: apply 0282 first'; end if;
  if to_regprocedure('public.inventory_costs(uuid[])') is null and to_regprocedure('public.inventory_costs__pre0374(uuid[])') is null then
    raise exception 'STOP 0374: apply 0299 (item cost by role) first'; end if;
  if to_regprocedure('public._a198_org_today(uuid)') is null then raise exception 'STOP 0374: apply 0198 first'; end if;
  if to_regprocedure('public._r55_purge_allowed(uuid,boolean)') is null then raise exception 'STOP 0374: apply 0296 first'; end if;
  if to_regprocedure('public._r21_category(text,text)') is null then raise exception 'STOP 0374: apply 0246 first'; end if;
end $$;

-- ---- 1) columns (additive, old rows keep their meaning) ------------------------------------------------------------------
alter table public.inventory_items add column if not exists item_kind text not null default 'reusable';
alter table public.inventory_items add column if not exists reorder_level numeric;
do $$ begin
  if not exists (select 1 from pg_constraint where conrelid = 'public.inventory_items'::regclass and conname = 'inventory_items_kind_0374') then
    alter table public.inventory_items add constraint inventory_items_kind_0374 check (item_kind in ('reusable', 'consumable')) not valid;
  end if;
  if not exists (select 1 from pg_constraint where conrelid = 'public.inventory_items'::regclass and conname = 'inventory_items_reorder_0374') then
    alter table public.inventory_items add constraint inventory_items_reorder_0374
      check (reorder_level is null or (reorder_level >= 0 and reorder_level <= 100000000)) not valid;
  end if;
end $$;
alter table public.inventory_checkouts add column if not exists qty_used numeric not null default 0;
do $$ begin
  if not exists (select 1 from pg_constraint where conrelid = 'public.inventory_checkouts'::regclass and conname = 'inventory_checkouts_used_0374') then
    alter table public.inventory_checkouts add constraint inventory_checkouts_used_0374 check (qty_used >= 0) not valid;
  end if;
end $$;

-- ---- 2) three new insert-only tables (RLS on, no grants: only the functions below read or write them) ----------------------
create table if not exists public.inventory_stock_events (
  id          uuid primary key default gen_random_uuid(),
  seq         bigint generated always as identity,
  org_id      uuid not null references public.organizations(id) on delete cascade,
  checkout_id uuid not null references public.inventory_checkouts(id) on delete cascade,
  item_id     uuid not null references public.inventory_items(id) on delete cascade,
  quote_id    uuid references public.quotes(id) on delete cascade,
  kind        text not null check (kind in ('part_back', 'found', 'repair_start', 'repaired', 'scrapped', 'photo', 'charge_client', 'absorb')),
  qty         numeric check (qty is null or (qty >= 0 and qty = trunc(qty) and qty <= 100000000)),
  damaged     numeric not null default 0 check (damaged >= 0 and damaged = trunc(damaged)),
  amount      numeric check (amount is null or (amount >= 0 and amount < 1000000000)),
  photo_path  text check (photo_path is null or char_length(photo_path) <= 300),
  refund_id   uuid,
  note        text check (note is null or char_length(note) <= 500),
  created_by  uuid,
  created_at  timestamptz not null default now()
);
create index if not exists inventory_stock_events_checkout_idx on public.inventory_stock_events (checkout_id, seq);
create index if not exists inventory_stock_events_quote_idx on public.inventory_stock_events (quote_id) where quote_id is not null;
create index if not exists inventory_stock_events_org_idx on public.inventory_stock_events (org_id);
create index if not exists inventory_stock_events_item_idx on public.inventory_stock_events (item_id);

create table if not exists public.inventory_settings (
  seq           bigint generated always as identity primary key,
  org_id        uuid not null references public.organizations(id) on delete cascade,
  photo_proof   boolean not null default true,
  portal_damage boolean not null default false,
  buffer_days   integer not null default 0 check (buffer_days between 0 and 14),
  stock_costs   boolean not null default false,
  created_by    uuid,
  created_at    timestamptz not null default now()
);
alter table public.inventory_settings add column if not exists stock_costs boolean not null default false;
create index if not exists inventory_settings_org_idx on public.inventory_settings (org_id, seq desc);

create table if not exists public.event_stock_windows (
  id          uuid primary key default gen_random_uuid(),
  seq         bigint generated always as identity,
  org_id      uuid not null references public.organizations(id) on delete cascade,
  quote_id    uuid not null references public.quotes(id) on delete cascade,
  setup_from  date,
  teardown_to date,
  created_by  uuid,
  created_at  timestamptz not null default now(),
  check (setup_from is null or teardown_to is null or setup_from <= teardown_to)
);
create index if not exists event_stock_windows_quote_idx on public.event_stock_windows (quote_id, seq desc);
create index if not exists event_stock_windows_org_idx on public.event_stock_windows (org_id);

do $$ declare t text; begin
  foreach t in array array['inventory_stock_events', 'inventory_settings', 'event_stock_windows'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on table public.%I from public', t);
    if exists (select 1 from pg_roles where rolname = 'anon') then execute format('revoke all on table public.%I from anon', t); end if;
    if exists (select 1 from pg_roles where rolname = 'authenticated') then execute format('revoke all on table public.%I from authenticated', t); end if;
  end loop;
end $$;

-- history is kept for good: no update ever, delete only for the free-trial purge / sample clean-up / studio closure (0296 marks)
create or replace function public._r374_tg_insert_only()
returns trigger language plpgsql set search_path = '' as $$
-- r191-inventory-0374
begin
  if tg_op = 'DELETE' and public._r55_purge_allowed(old.org_id) then return old; end if;
  raise exception 'Stock history is kept for good - add a new entry instead of changing this one.'
    using errcode = '42501', hint = 'r191_insert_only';
end $$;
revoke all on function public._r374_tg_insert_only() from public;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'anon') then execute 'revoke all on function public._r374_tg_insert_only() from anon'; end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then execute 'revoke all on function public._r374_tg_insert_only() from authenticated'; end if;
end $$;
do $$ declare t text; begin
  foreach t in array array['inventory_stock_events', 'inventory_settings', 'event_stock_windows'] loop
    execute format('drop trigger if exists a374_insert_only on public.%I', t);
    execute format('create trigger a374_insert_only before update or delete on public.%I for each row execute function public._r374_tg_insert_only()', t);
    if to_regprocedure('public.tg_studio_read_only()') is not null
       and not exists (select 1 from pg_trigger where tgrelid = ('public.' || t)::regclass and tgname = 'zzz_studio_read_only') then
      execute format('create trigger zzz_studio_read_only before insert or update or delete on public.%I for each row execute function public.tg_studio_read_only(%L)', t, 'org_id');
    end if;
  end loop;
  foreach t in array array['inventory_stock_events', 'event_stock_windows'] loop
    if to_regprocedure('public.tg_quote_org_match()') is not null
       and not exists (select 1 from pg_trigger where tgrelid = ('public.' || t)::regclass and tgname = 'zz_quote_org_match') then
      execute format('create trigger zz_quote_org_match before insert or update on public.%I for each row execute function public.tg_quote_org_match()', t);
    end if;
  end loop;
end $$;

-- ---- 3) studio settings (newest row counts, every change is a new row = who changed what, when) --------------------------
create or replace function public._r374_cfg(p_org uuid)
returns jsonb language sql stable security definer set search_path = '' as $$
  -- r191-inventory-0374: defaults when the studio never saved: photo proof ON, client portal OFF, 0 buffer days,
  -- item costs for Finance only (stock staff without Finance view see quantities)
  select coalesce((select jsonb_build_object('photo_proof', s.photo_proof, 'portal_damage', s.portal_damage, 'buffer_days', s.buffer_days,
                                             'stock_costs', s.stock_costs, 'changed_at', s.created_at)
                     from public.inventory_settings s where s.org_id = p_org order by s.seq desc limit 1),
                  jsonb_build_object('photo_proof', true, 'portal_damage', false, 'buffer_days', 0, 'stock_costs', false, 'changed_at', null));
$$;
create or replace function public._r374_buffer(p_org uuid)
returns integer language sql stable security definer set search_path = '' as $$
  -- r191-inventory-0374
  select coalesce((select s.buffer_days from public.inventory_settings s where s.org_id = p_org order by s.seq desc limit 1), 0);
$$;

-- may this person see item costs? Finance view, or Inventory edit when the studio lets stock staff see costs (off by default)
create or replace function public._r374_can_cost(p_org uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  -- r191-inventory-0374
  select coalesce(public.has_area('finance', 'view'), false)
      or (coalesce(public.has_area('inventory', 'edit'), false) and coalesce((public._r374_cfg(p_org) ->> 'stock_costs')::boolean, false));
$$;

create or replace function public.inventory_settings_get()
returns jsonb language plpgsql stable security definer set search_path = '' as $$
-- r191-inventory-0374: the stock settings + what this person may see / do (the pages follow the server)
declare v_org uuid := public.current_org_id();
begin
  if v_org is null or auth.uid() is null then raise exception 'not authorized' using errcode = '42501'; end if;
  if not (public.has_area('inventory', 'view') or public.has_area('command', 'view') or public.has_area('quotes', 'view')) then
    raise exception 'not authorized' using errcode = '42501'; end if;
  return public._r374_cfg(v_org) || jsonb_build_object(
    'can_money', coalesce(public.has_area('finance', 'view'), false),
    'can_cost', public._r374_can_cost(v_org),
    'can_decide', coalesce(public.has_area('finance', 'edit'), false),
    'can_set', coalesce(public.has_area('inventory', 'edit'), false));
end $$;

create or replace function public.inventory_settings_set(p_photo_proof boolean default null, p_portal_damage boolean default null,
                                                         p_buffer_days integer default null, p_stock_costs boolean default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
-- r191-inventory-0374: null = keep. Photo proof + buffer days: Inventory edit. Client portal + stock staff see costs: Finance edit too.
declare v_org uuid := public.current_org_id(); v_cur jsonb; v_photo boolean; v_portal boolean; v_buf integer; v_costs boolean;
begin
  if v_org is null or auth.uid() is null or not coalesce(public.has_area('inventory', 'edit'), false) then
    raise exception 'not authorized' using errcode = '42501'; end if;
  v_cur := public._r374_cfg(v_org);
  v_photo := coalesce(p_photo_proof, (v_cur ->> 'photo_proof')::boolean);
  v_portal := coalesce(p_portal_damage, (v_cur ->> 'portal_damage')::boolean);
  v_buf := coalesce(p_buffer_days, (v_cur ->> 'buffer_days')::integer);
  v_costs := coalesce(p_stock_costs, (v_cur ->> 'stock_costs')::boolean, false);
  if v_buf < 0 or v_buf > 14 then raise exception 'Buffer days: 0 to 14.' using errcode = '22023'; end if;
  if v_portal is distinct from (v_cur ->> 'portal_damage')::boolean and not coalesce(public.has_area('finance', 'edit'), false) then
    raise exception 'Only someone with Finance edit can change what the client sees.' using errcode = '42501'; end if;
  if v_costs is distinct from coalesce((v_cur ->> 'stock_costs')::boolean, false) and not coalesce(public.has_area('finance', 'edit'), false) then
    raise exception 'Only someone with Finance edit can show item costs to stock staff.' using errcode = '42501'; end if;
  if v_photo is distinct from (v_cur ->> 'photo_proof')::boolean or v_portal is distinct from (v_cur ->> 'portal_damage')::boolean
     or v_buf is distinct from (v_cur ->> 'buffer_days')::integer or v_costs is distinct from coalesce((v_cur ->> 'stock_costs')::boolean, false) then
    insert into public.inventory_settings (org_id, photo_proof, portal_damage, buffer_days, stock_costs, created_by)
      values (v_org, v_photo, v_portal, v_buf, v_costs, auth.uid());
  end if;
  return public.inventory_settings_get();
end $$;

-- ---- 4) an event stock window: set-up from .. teardown until (+ buffer days), null = no date ----------------------------
create or replace function public._r374_win(p_quote uuid, p_org uuid, out d_from date, out d_to date, out setup_from date, out teardown_to date)
language sql stable security definer set search_path = '' as $$
  -- r191-inventory-0374
  select coalesce(w.setup_from, q.event_date), coalesce(w.teardown_to, q.event_date) + public._r374_buffer(p_org), w.setup_from, w.teardown_to
    from public.quotes q
    left join lateral (select x.setup_from, x.teardown_to from public.event_stock_windows x
                        where x.quote_id = q.id and x.org_id = p_org order by x.seq desc limit 1) w on true
   where q.id = p_quote and q.org_id = p_org and q.event_date is not null;
$$;

-- per item: what an event can still reserve against (0071 rule, on the window, stock still out from an event whose days are
-- over, or from a cancelled / closed / shelved event, counts on every date)
create or replace function public._r374_load(p_item uuid, p_quote uuid, p_org uuid)
returns numeric language plpgsql stable security definer set search_path = '' as $$
-- r191-inventory-0374
declare v_buf integer := public._r374_buffer(p_org); v_today date := public._a198_org_today(p_org);
        v_f date; v_t date; v_load numeric; v_undated numeric; v_late numeric;
begin
  select w.d_from, w.d_to into v_f, v_t from public._r374_win(p_quote, p_org) w;
  with win as (select distinct on (x.quote_id) x.quote_id, x.setup_from, x.teardown_to
                 from public.event_stock_windows x where x.org_id = p_org order by x.quote_id, x.seq desc),
       ev as (select q.id, q.event_date, coalesce(win.setup_from, q.event_date) as d_from,
                     coalesce(win.teardown_to, q.event_date) + v_buf as d_to,
                     (q.deleted_at is null and q.archived_at is null and q.status <> 'cancelled'
                      and not (q.lifecycle_stage = 'closed' and q.status = 'confirmed')) as live
                from public.quotes q left join win on win.quote_id = q.id where q.org_id = p_org),
       per as (select e.id, e.event_date, e.d_from, e.d_to, e.live,
                      coalesce((select sum(r.qty) from public.inventory_reservations r
                                 where r.item_id = p_item and r.quote_id = e.id and r.status in ('reserved', 'allocated')), 0) as res,
                      coalesce((select sum(public._r24_not_back(c.qty_out, c.qty_in, c.written_off, c.qty_damaged)) from public.inventory_checkouts c
                                 where c.item_id = p_item and c.quote_id = e.id and c.org_id = p_org and c.status in ('out', 'partial')), 0) as outq
                 from ev e),
       k as (select p.*, (p.live and p.event_date is not null and v_f is not null and p.d_from <= v_t and v_f <= p.d_to) as hit from per p)
  select coalesce(sum(greatest(k.res, k.outq)) filter (where k.hit), 0),
         coalesce(sum(greatest(k.res, k.outq)) filter (where k.live and k.event_date is null), 0),
         coalesce(sum(k.outq) filter (where not k.hit and not (k.live and k.event_date is null)
                                        and (not k.live or k.d_to < v_today)), 0)
    into v_load, v_undated, v_late from k;
  -- stock checked out with no event counts as undated demand (0071)
  v_undated := v_undated + coalesce((select sum(public._r24_not_back(c.qty_out, c.qty_in, c.written_off, c.qty_damaged)) from public.inventory_checkouts c
                                      where c.item_id = p_item and c.org_id = p_org and c.quote_id is null and c.status in ('out', 'partial')), 0);
  if v_f is null then v_load := v_undated; v_undated := 0; end if;   -- 0071: a dateless event is checked against its own bucket
  return v_load + v_undated + v_late;
end $$;

create or replace function public.event_stock_window_set(p_quote uuid, p_setup_from date, p_teardown_to date)
returns jsonb language plpgsql security definer set search_path = '' as $$
-- r191-inventory-0374: null + null = back to the one-day rule. Answers the items that are now short on the longer range.
declare v_org uuid := public.current_org_id(); v_date date; v_short jsonb;
begin
  if v_org is null or auth.uid() is null or not (public.has_area('inventory', 'edit') or public.has_area('quotes', 'edit')) then
    raise exception 'not authorized' using errcode = '42501'; end if;
  select q.event_date into v_date from public.quotes q where q.id = p_quote and q.org_id = v_org;
  if not found then raise exception 'event not found' using errcode = '42501'; end if;
  if v_date is null then raise exception 'Set the event date first.' using errcode = '22023'; end if;
  if p_setup_from is not null and p_setup_from > v_date then raise exception 'Set-up must start on or before the event day.' using errcode = '22023'; end if;
  if p_teardown_to is not null and p_teardown_to < v_date then raise exception 'Teardown must end on or after the event day.' using errcode = '22023'; end if;
  if coalesce(p_teardown_to, v_date) - coalesce(p_setup_from, v_date) > 60 then
    raise exception 'A stock range can be at most 60 days.' using errcode = '22023'; end if;
  if exists (select 1 from public.event_stock_windows w where w.quote_id = p_quote and w.org_id = v_org) or p_setup_from is not null or p_teardown_to is not null then
    if not exists (select 1 from (select w.setup_from, w.teardown_to from public.event_stock_windows w
                                   where w.quote_id = p_quote and w.org_id = v_org order by w.seq desc limit 1) z
                    where z.setup_from is not distinct from p_setup_from and z.teardown_to is not distinct from p_teardown_to) then
      insert into public.event_stock_windows (org_id, quote_id, setup_from, teardown_to, created_by)
        values (v_org, p_quote, p_setup_from, p_teardown_to, auth.uid());
    end if;
  end if;
  -- items of this event that no longer fit on the whole range (reserved, not yet out, more than is free)
  select coalesce(jsonb_agg(jsonb_build_object('item_id', x.item_id, 'item', x.name, 'short', x.short) order by x.name), '[]'::jsonb) into v_short
    from (select r.item_id, coalesce(nullif(btrim(i.name), ''), 'Item') as name,
                 greatest(r.res - coalesce(o.outq, 0) - public._checkout_free(r.item_id, v_date, p_quote), 0) as short
            from (select r0.item_id, sum(r0.qty) as res from public.inventory_reservations r0
                   where r0.quote_id = p_quote and r0.org_id = v_org and r0.status in ('reserved', 'allocated') group by r0.item_id) r
            join public.inventory_items i on i.id = r.item_id and i.org_id = v_org
            left join (select c.item_id, sum(public._r24_not_back(c.qty_out, c.qty_in, c.written_off, c.qty_damaged)) as outq
                         from public.inventory_checkouts c where c.quote_id = p_quote and c.org_id = v_org and c.status in ('out', 'partial')
                        group by c.item_id) o on o.item_id = r.item_id) x
   where x.short > 0;
  return coalesce(public.stock_windows(array[p_quote]) -> 0, '{}'::jsonb) || jsonb_build_object('short', v_short);
end $$;

create or replace function public.stock_windows(p_quotes uuid[])
returns jsonb language plpgsql stable security definer set search_path = '' as $$
-- r191-inventory-0374: the stock window of each event asked for (own studio only), buffer days included in d_to
declare v_org uuid := public.current_org_id(); v_buf integer;
begin
  if v_org is null or auth.uid() is null
     or not (public.has_area('inventory', 'view') or public.has_area('quotes', 'view') or public.has_area('command', 'view')) then
    raise exception 'not authorized' using errcode = '42501'; end if;
  if p_quotes is null or cardinality(p_quotes) = 0 then return '[]'::jsonb; end if;
  if cardinality(p_quotes) > 2000 then raise exception 'too many events' using errcode = '22023'; end if;
  v_buf := public._r374_buffer(v_org);
  return coalesce((select jsonb_agg(jsonb_build_object('quote_id', q.id, 'event_date', q.event_date,
            'setup_from', w.setup_from, 'teardown_to', w.teardown_to, 'buffer_days', v_buf,
            'd_from', w.d_from, 'd_to', w.d_to) order by q.event_date nulls last, q.id)
     from public.quotes q left join lateral public._r374_win(q.id, v_org) w on true
    where q.org_id = v_org and q.id = any (p_quotes)), '[]'::jsonb);
end $$;

-- ---- 5) free stock + reserve on the window (bodies from 0268 / 0071 / 0197, only the date rule changes) ---------------------
create or replace function public._checkout_free(p_item uuid, p_date date, p_quote uuid)
returns numeric language plpgsql stable security definer set search_path = '' as $$
-- r24-stock-0268 + r191-inventory-0374: other live events whose stock window overlaps this one (was: the same date)
declare v_org uuid := public.current_org_id(); v_total numeric; v_out numeric; v_res numeric; v_f date; v_t date; v_buf integer;
begin
  select coalesce(total_qty, 0) into v_total from public.inventory_items where id = p_item and org_id = v_org;
  if not found then return 0; end if;
  select coalesce(sum(public._r24_not_back(c.qty_out, c.qty_in, c.written_off, c.qty_damaged)), 0) into v_out
    from public.inventory_checkouts c
   where c.item_id = p_item and c.org_id = v_org and c.status in ('out', 'partial');
  v_res := 0;
  v_buf := public._r374_buffer(v_org);
  if p_quote is not null then select w.d_from, w.d_to into v_f, v_t from public._r374_win(p_quote, v_org) w; end if;
  if v_f is null and p_date is not null then v_f := p_date; v_t := p_date + v_buf; end if;
  if v_f is not null then
    -- other live events on overlapping days: reserved minus what they already took out (counted above)
    with win as (select distinct on (x.quote_id) x.quote_id, x.setup_from, x.teardown_to
                   from public.event_stock_windows x where x.org_id = v_org order by x.quote_id, x.seq desc)
    select coalesce(sum(greatest(r.res - coalesce(o.out_qty, 0), 0)), 0) into v_res
      from (select r0.quote_id, sum(r0.qty) as res from public.inventory_reservations r0
             where r0.item_id = p_item and r0.status in ('reserved', 'allocated') group by r0.quote_id) r
      join public.quotes q on q.id = r.quote_id
      left join win on win.quote_id = q.id
      left join (select c0.quote_id, sum(public._r24_not_back(c0.qty_out, c0.qty_in, c0.written_off, c0.qty_damaged)) as out_qty
                   from public.inventory_checkouts c0
                  where c0.item_id = p_item and c0.org_id = v_org and c0.status in ('out', 'partial') group by c0.quote_id) o
        on o.quote_id = r.quote_id
     where q.org_id = v_org and q.event_date is not null and q.id is distinct from p_quote
       and coalesce(win.setup_from, q.event_date) <= v_t and v_f <= coalesce(win.teardown_to, q.event_date) + v_buf
       and q.deleted_at is null and q.archived_at is null and q.status <> 'cancelled'
       and not (q.lifecycle_stage = 'closed' and q.status = 'confirmed');
  end if;
  return greatest(v_total - v_out - v_res, 0);
end $$;
revoke all on function public._checkout_free(uuid, date, uuid) from public, anon, authenticated;

create or replace function public.checkout_availability(p_item uuid, p_quote uuid default null)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
-- r24-stock-0268 + r191-inventory-0374: due back = the day after the teardown day, other events on overlapping days
declare
  v_org uuid := public.current_org_id(); v_it record; v_date date; v_out numeric; v_free numeric; v_buf integer; v_f date; v_t date;
  v_blocking jsonb; v_overdue jsonb; v_subs jsonb; v_resother jsonb; v_today date;
begin
  if not (public.has_area('inventory', 'view') or public.has_area('inventory', 'edit')) then
    raise exception 'not authorized' using errcode = '42501'; end if;
  select id, name, category, unit, coalesce(total_qty, 0) as total into v_it
    from public.inventory_items where id = p_item and org_id = v_org;
  if not found then raise exception 'item not found' using errcode = '42501'; end if;
  if p_quote is not null then
    perform public.assert_quote_org(p_quote);
    select event_date into v_date from public.quotes where id = p_quote;
    select w.d_from, w.d_to into v_f, v_t from public._r374_win(p_quote, v_org) w;
  end if;
  v_buf := public._r374_buffer(v_org);
  v_today := public._a198_org_today(v_org);

  select coalesce(sum(public._r24_not_back(c.qty_out, c.qty_in, c.written_off, c.qty_damaged)), 0) into v_out
    from public.inventory_checkouts c where c.item_id = p_item and c.org_id = v_org and c.status in ('out', 'partial');
  v_free := public._checkout_free(p_item, v_date, p_quote);

  -- open check-outs holding this item: which event, how many, when due back (day after the teardown day)
  select coalesce(jsonb_agg(x order by x->>'due_back' nulls last), '[]'::jsonb) into v_blocking from (
    select jsonb_build_object('checkout_id', c.id, 'quote_id', c.quote_id,
             'event', coalesce(q.title, 'No event'), 'event_date', q.event_date,
             'due_back', case when q.event_date is not null then coalesce(w.teardown_to, q.event_date) + 1 end,
             'qty', public._r24_not_back(c.qty_out, c.qty_in, c.written_off, c.qty_damaged), 'issued_to', c.issued_to,
             'overdue', (q.event_date is not null and coalesce(w.teardown_to, q.event_date) + 1 < v_today)) as x
      from public.inventory_checkouts c left join public.quotes q on q.id = c.quote_id
      left join lateral public._r374_win(c.quote_id, v_org) w on c.quote_id is not null
     where c.item_id = p_item and c.org_id = v_org and c.status in ('out', 'partial')
       and public._r24_not_back(c.qty_out, c.qty_in, c.written_off, c.qty_damaged) > 0) s;
  select coalesce(jsonb_agg(e), '[]'::jsonb) into v_overdue
    from jsonb_array_elements(v_blocking) e where (e->>'overdue')::boolean;

  -- other events on overlapping days holding a reservation
  select coalesce(jsonb_agg(jsonb_build_object('quote_id', q.id, 'event', q.title, 'event_date', q.event_date, 'qty', r.qty,
                                               'from', w.d_from, 'to', w.d_to - v_buf)), '[]'::jsonb)
    into v_resother
    from (select quote_id, sum(qty) as qty from public.inventory_reservations
           where item_id = p_item and status in ('reserved', 'allocated') group by quote_id) r
    join public.quotes q on q.id = r.quote_id
    cross join lateral public._r374_win(q.id, v_org) w
   where v_f is not null and q.org_id = v_org and q.id is distinct from p_quote
     and w.d_from <= v_t and v_f <= w.d_to
     and q.deleted_at is null and q.archived_at is null and q.status <> 'cancelled';

  -- substitutes: same category, active, something free on that date
  select coalesce(jsonb_agg(s order by (s->>'available')::numeric desc), '[]'::jsonb) into v_subs from (
    select jsonb_build_object('item_id', i.id, 'name', i.name, 'unit', i.unit,
             'available', public._checkout_free(i.id, v_date, p_quote)) as s
      from public.inventory_items i
     where i.org_id = v_org and i.id <> p_item and coalesce(i.active, true)
       and v_it.category is not null and i.category = v_it.category
     limit 20) t
   where (s->>'available')::numeric > 0;

  return jsonb_build_object('item_id', v_it.id, 'item', v_it.name, 'category', v_it.category, 'unit', v_it.unit,
    'total', v_it.total, 'out_now', v_out, 'reserved_other', greatest(v_it.total - v_out - v_free, 0),
    'in_repair', coalesce((select sum(e.qty) filter (where e.kind = 'repair_start') - coalesce(sum(e.qty) filter (where e.kind in ('repaired', 'scrapped')), 0)
                             from public.inventory_stock_events e where e.item_id = p_item and e.org_id = v_org), 0),
    'available', v_free, 'event_date', v_date, 'window_from', v_f, 'window_to', case when v_t is not null then v_t - v_buf end,
    'blocking', v_blocking, 'overdue', v_overdue, 'reserved_by', v_resother,
    'substitutes', (select coalesce(jsonb_agg(e), '[]'::jsonb) from (select e from jsonb_array_elements(v_subs) e limit 5) z));
end $$;
revoke all on function public.checkout_availability(uuid, uuid) from public, anon;
grant execute on function public.checkout_availability(uuid, uuid) to authenticated;

create or replace function public.reserve_inventory(p_item uuid, p_quote uuid, p_qty numeric, p_note text default null)
returns public.inventory_reservations language plpgsql security definer set search_path = '' as $$
-- 0071 + r191-inventory-0374: the demand rule is _r374_load (the event stock window, stock not back counts everywhere)
declare v_total numeric; v_org uuid := public.current_org_id(); v_load numeric; v_row public.inventory_reservations;
begin
  if not public.has_area('inventory','edit') then raise exception 'not authorized' using errcode='42501'; end if;
  if coalesce(p_qty,0) <= 0 then raise exception 'quantity must be > 0'; end if;
  perform public.assert_quote_org(p_quote);
  -- serialise concurrent reservations of the same item
  select total_qty into v_total from public.inventory_items where id = p_item and org_id = v_org for update;
  if not found then raise exception 'item not found' using errcode='42501'; end if;
  v_load := public._r374_load(p_item, p_quote, v_org);
  if v_load + p_qty > v_total then
    raise exception 'not enough stock free (% left)', greatest(v_total - v_load, 0) using errcode='P0001';
  end if;
  insert into public.inventory_reservations (item_id, quote_id, qty, note, created_by)
    values (p_item, p_quote, p_qty, nullif(btrim(coalesce(p_note,'')),''), auth.uid())
    returning * into v_row;
  return v_row;
end $$;
revoke all on function public.reserve_inventory(uuid, uuid, numeric, text) from public, anon;
grant execute on function public.reserve_inventory(uuid, uuid, numeric, text) to authenticated;

create or replace function public.reserve_inventory_with_sourcing(
  p_item uuid, p_quote uuid, p_qty numeric, p_note text default null,
  p_source text default 'none', p_vendor uuid default null, p_rate numeric default null, p_source_note text default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
-- 0197 + r191-inventory-0374: the demand rule is _r374_load (the event stock window, stock not back counts everywhere)
declare
  v_org uuid := public.current_org_id();
  v_total numeric; v_name text; v_unit text; v_date date; v_code text;
  v_load numeric; v_free numeric; v_take numeric; v_short numeric;
  v_res uuid; v_req uuid; v_bk uuid; v_vname text; v_vkind text; v_src text := coalesce(nullif(btrim(coalesce(p_source, '')), ''), 'none');
  v_snote text := left(nullif(btrim(coalesce(p_source_note, '')), ''), 500);
  v_label text; v_txt text;
begin
  if auth.uid() is null or v_org is null or not coalesce(public.has_area('inventory', 'edit'), false) then
    raise exception 'not authorized' using errcode = '42501';
  end if;
  if p_qty is null or p_qty <= 0 or p_qty <> trunc(p_qty) or p_qty > 1000000 then
    raise exception 'quantity must be a whole number above 0' using errcode = '22023';
  end if;
  if v_src not in ('vendor', 'buy', 'none') then raise exception 'source must be vendor, buy or none' using errcode = '22023'; end if;
  if p_rate is not null and (p_rate < 0 or p_rate >= 1e9 or round(p_rate, 2) <> p_rate) then
    raise exception 'rate must be an amount of 0 or more' using errcode = '22023';
  end if;
  if not exists (select 1 from public.quotes where id = p_quote and org_id = v_org) then
    raise exception 'not authorized for this event' using errcode = '42501';
  end if;
  if v_src = 'vendor' then
    if p_vendor is null then raise exception 'pick the vendor to rent from' using errcode = '22023'; end if;
    if not coalesce(public.has_area('vendors', 'edit'), false) then
      raise exception 'your role cannot add vendor bookings - choose outsource / buy or ask a manager' using errcode = '42501';
    end if;
    select name, kind into v_vname, v_vkind from public.vendors where id = p_vendor and org_id = v_org;
    if not found then raise exception 'vendor belongs to another studio' using errcode = '42501'; end if;
  elsif p_vendor is not null then
    raise exception 'a vendor is only used with source vendor' using errcode = '22023';
  end if;

  -- serialise with reserve_inventory / other sourcing calls on the same item
  select total_qty, name, unit into v_total, v_name, v_unit from public.inventory_items
    where id = p_item and org_id = v_org for update;
  if not found then raise exception 'item not found' using errcode = '42501'; end if;
  select event_date, code into v_date, v_code from public.quotes where id = p_quote;

  v_load := public._r374_load(p_item, p_quote, v_org);
  v_free := floor(greatest(coalesce(v_total, 0) - v_load, 0));
  v_take := least(p_qty, v_free);
  v_short := p_qty - v_take;

  if v_take > 0 then
    insert into public.inventory_reservations (item_id, quote_id, qty, note, created_by)
      values (p_item, p_quote, v_take, nullif(btrim(coalesce(p_note, '')), ''), auth.uid())
      returning id into v_res;
  end if;

  if v_short > 0 then
    v_label := left('Short: ' || v_short::text || ' x ' || coalesce(v_name, 'item'), 200);
    if v_src = 'vendor' then
      v_txt := left('Rent ' || v_short::text || ' ' || coalesce(nullif(v_unit, ''), 'x') || ' ' || coalesce(v_name, 'item')
        || ' for ' || coalesce(v_code, 'this event') || coalesce(' on ' || to_char(v_date, 'DD Mon YYYY'), '')
        || ' (stock shortfall)' || coalesce('. ' || v_snote, ''), 2000);
      insert into public.event_resources (quote_id, vendor_id, kind, label, qty, cost, status, note, created_by)
        values (p_quote, p_vendor, v_vkind, left(coalesce(v_name, 'Item') || ' - rent ' || v_short::text || ' (stock shortfall)', 500),
                v_short, case when p_rate is null then null else round(v_short * p_rate, 2) end, 'enquiry', v_txt, auth.uid())
        returning id into v_bk;
    end if;
    insert into public.event_stock_requests (quote_id, item_id, label, qty, status, note, created_by, source, booking_id, vendor_id)
      values (p_quote, p_item, v_label, v_short, 'requested',
              left(case v_src when 'vendor' then 'Sourcing from ' || coalesce(v_vname, 'vendor')
                              when 'buy' then 'Outsource / buy'
                              else 'Unsourced' end
                   || coalesce(' - ' || v_snote, ''), 1000),
              auth.uid(), v_src, v_bk, case when v_src = 'vendor' then p_vendor end)
      returning id into v_req;
  end if;

  return jsonb_strip_nulls(jsonb_build_object('reserved', v_take, 'short', v_short, 'available', v_free,
    'reservation_id', v_res, 'request_id', v_req, 'booking_id', v_bk, 'source', case when v_short > 0 then v_src end));
end $$;
revoke all on function public.reserve_inventory_with_sourcing(uuid, uuid, numeric, text, text, uuid, numeric, text) from public, anon;
grant execute on function public.reserve_inventory_with_sourcing(uuid, uuid, numeric, text, text, uuid, numeric, text) to authenticated;

-- other events holding the same items on overlapping days (Chiavari chairs: 150 held by Reddy wedding 14-16 Dec)
create or replace function public.stock_overlaps(p_quote uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
-- r191-inventory-0374
declare v_org uuid := public.current_org_id(); v_f date; v_t date; v_buf integer;
begin
  if v_org is null or auth.uid() is null or not (public.has_area('inventory', 'view') or public.has_area('command', 'view')) then
    raise exception 'not authorized' using errcode = '42501'; end if;
  if not exists (select 1 from public.quotes q where q.id = p_quote and q.org_id = v_org) then
    raise exception 'event not found' using errcode = '42501'; end if;
  select w.d_from, w.d_to into v_f, v_t from public._r374_win(p_quote, v_org) w;
  if v_f is null then return '[]'::jsonb; end if;
  v_buf := public._r374_buffer(v_org);
  return coalesce((select jsonb_agg(jsonb_build_object('item_id', z.item_id, 'item', z.name, 'total', z.total, 'events', z.evs) order by z.name)
    from (select mine.item_id, coalesce(nullif(btrim(i.name), ''), 'Item') as name, coalesce(i.total_qty, 0) as total,
                 jsonb_agg(jsonb_build_object('quote_id', o.quote_id, 'event', o.title, 'from', o.d_from, 'to', o.d_to - v_buf, 'qty', o.qty)
                           order by o.d_from, o.title) as evs
            from (select distinct r.item_id from public.inventory_reservations r where r.quote_id = p_quote and r.org_id = v_org
                     and r.status in ('reserved', 'allocated')
                  union select distinct c.item_id from public.inventory_checkouts c where c.quote_id = p_quote and c.org_id = v_org
                     and c.status in ('out', 'partial')) mine
            join public.inventory_items i on i.id = mine.item_id and i.org_id = v_org
            join lateral (select q.id as quote_id, coalesce(nullif(btrim(q.title), ''), q.code, 'Event') as title, w.d_from, w.d_to,
                                 greatest(coalesce((select sum(r.qty) from public.inventory_reservations r where r.quote_id = q.id and r.item_id = mine.item_id
                                                      and r.status in ('reserved', 'allocated')), 0),
                                          coalesce((select sum(public._r24_not_back(c.qty_out, c.qty_in, c.written_off, c.qty_damaged))
                                                      from public.inventory_checkouts c where c.quote_id = q.id and c.item_id = mine.item_id
                                                       and c.status in ('out', 'partial')), 0)) as qty
                            from public.quotes q cross join lateral public._r374_win(q.id, v_org) w
                           where q.org_id = v_org and q.id <> p_quote and q.deleted_at is null and q.archived_at is null and q.status <> 'cancelled'
                             and not (q.lifecycle_stage = 'closed' and q.status = 'confirmed')
                             and w.d_from <= v_t and v_f <= w.d_to) o on o.qty > 0
           group by mine.item_id, i.name, i.total_qty) z), '[]'::jsonb);
end $$;

-- ---- 6) photo proof: a path this studio uploaded under <studio>/<event or none>/stock/ -------------------------------------
create or replace function public._r374_photo_ok(p_path text, p_org uuid, p_quote uuid)
returns boolean language plpgsql stable security definer set search_path = '' as $$
-- r191-inventory-0374
declare v_ok boolean;
begin
  if p_path is null or p_org is null then return false; end if;
  if p_path !~ ('^' || p_org::text || '/' || coalesce(p_quote::text, 'none')
                || '/stock/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}[.](jpg|png|webp)$') then return false; end if;
  if to_regclass('storage.objects') is null then return true; end if;
  begin
    execute 'select exists (select 1 from storage.objects o where o.bucket_id = $1 and o.name = $2)' into v_ok using 'event-docs', p_path;
  exception when insufficient_privilege then v_ok := true;   -- the path shape is still checked
  end;
  return coalesce(v_ok, false);
end $$;

-- ---- 7) the decision on a loss: studio absorbs / charge client (Finance edit) ------------------------------------------------
create or replace function public._r374_decide(p_checkout uuid, p_decision text, p_amount numeric, p_note text)
returns jsonb language plpgsql security definer set search_path = '' as $$
-- r191-inventory-0374: internal, callers lock the check-out row. One live decision per check-out: a new one is allowed only
-- after absorb (switch to charge) or after a charge whose recovery was rejected / removed.
declare v_org uuid := public.current_org_id(); v_c public.inventory_checkouts; v_units numeric; v_last record; v_name text;
        v_amt numeric; v_ref uuid; v_note text := left(nullif(btrim(coalesce(p_note, '')), ''), 500);
begin
  if p_decision not in ('absorb', 'charge') then raise exception 'Choose "Studio absorbs" or "Charge client".' using errcode = '22023'; end if;
  if not coalesce(public.has_area('finance', 'edit'), false) then
    raise exception 'Only someone with Finance edit can decide who pays for a loss.' using errcode = '42501', hint = 'finance_only'; end if;
  select * into v_c from public.inventory_checkouts where id = p_checkout and org_id = v_org;
  if not found then raise exception 'check-out not found' using errcode = '42501'; end if;
  v_units := greatest(coalesce(v_c.written_off, 0) - coalesce(v_c.qty_used, 0), 0);
  if v_units <= 0 then raise exception 'Nothing was lost or damaged on this line.' using errcode = 'P0001'; end if;
  select e.kind, e.refund_id, r.status as rstatus into v_last from public.inventory_stock_events e
    left join public.event_refunds r on r.id = e.refund_id
   where e.checkout_id = p_checkout and e.kind in ('absorb', 'charge_client') order by e.seq desc limit 1;
  if found then
    if v_last.kind = 'absorb' and p_decision = 'absorb' then return jsonb_build_object('ok', true, 'already', true, 'decision', 'absorb'); end if;
    if v_last.kind = 'charge_client' and coalesce(v_last.rstatus, 'rejected') <> 'rejected' then
      raise exception 'This line is already charged to the client - reject that recovery in Settlement first to change it.' using errcode = 'P0001'; end if;
  end if;
  if v_c.quote_id is not null and public._r282_event_closed(v_c.quote_id) then
    raise exception 'This event is closed - re-open it first (an admin can re-open it from its Closure page).' using errcode = '42501', hint = 'event_closed'; end if;
  if p_decision = 'absorb' then
    insert into public.inventory_stock_events (org_id, checkout_id, item_id, quote_id, kind, qty, note, created_by)
      values (v_org, v_c.id, v_c.item_id, v_c.quote_id, 'absorb', v_units, v_note, auth.uid());
    return jsonb_build_object('ok', true, 'decision', 'absorb', 'units', v_units);
  end if;
  if v_c.quote_id is null then raise exception 'This was given out with no event - there is no client to charge.' using errcode = 'P0001'; end if;
  v_amt := p_amount;
  if v_amt is null or v_amt <= 0 or v_amt >= 1000000000 or round(v_amt, 2) <> v_amt then
    raise exception 'Enter the amount to charge (above 0).' using errcode = '22023'; end if;
  select coalesce(nullif(btrim(i.name), ''), 'Item') into v_name from public.inventory_items i where i.id = v_c.item_id and i.org_id = v_org;
  insert into public.event_refunds (quote_id, kind, amount, reason, status, note, created_by, org_id)
    values (v_c.quote_id, 'recovery', v_amt, left('Damage / loss: ' || trim(to_char(v_units, 'FM999999990')) || ' x ' || v_name, 500), 'pending',
            left(concat_ws(' | ', 'From stock check-in (R191), check-out ' || v_c.id::text, v_note), 2000), auth.uid(), v_org)
    returning id into v_ref;
  insert into public.inventory_stock_events (org_id, checkout_id, item_id, quote_id, kind, qty, amount, refund_id, note, created_by)
    values (v_org, v_c.id, v_c.item_id, v_c.quote_id, 'charge_client', v_units, v_amt, v_ref, v_note, auth.uid());
  return jsonb_build_object('ok', true, 'decision', 'charge', 'units', v_units, 'amount', v_amt, 'refund_id', v_ref);
end $$;

create or replace function public.stock_damage_decision(p_checkout uuid, p_decision text, p_amount numeric default null, p_note text default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
-- r191-inventory-0374
begin
  perform 1 from public.inventory_checkouts where id = p_checkout and org_id = public.current_org_id() for update;
  if not found then raise exception 'check-out not found' using errcode = '42501'; end if;
  return public._r374_decide(p_checkout, p_decision, p_amount, p_note);
end $$;

-- ---- 8) Mark back (one core for the old and the new call) --------------------------------------------------------------------
create or replace function public._r374_checkin(p_id uuid, p_ok numeric, p_damaged numeric, p_returned_by text, p_rest_out boolean,
                                               p_photo text, p_strict boolean, p_decision text, p_charge numeric)
returns jsonb language plpgsql security definer set search_path = '' as $$
-- r191-inventory-0374: reusable = OK + damaged, the rest missing (or still out with p_rest_out), consumable = left over, the
-- rest used. An earlier part-return (qty_in while Out) is counted. Missing, damaged and used leave what you own, once.
declare v_org uuid := public.current_org_id(); v_row public.inventory_checkouts; v_kind text;
        v_ok numeric := coalesce(p_ok, 0); v_dmg numeric := coalesce(p_damaged, 0); v_prior numeric; v_left numeric;
        v_miss numeric := 0; v_used numeric := 0; v_off numeric := 0; v_part boolean := false; v_photo text;
        v_cfg jsonb; v_dec jsonb;
begin
  select * into v_row from public.inventory_checkouts where id = p_id and org_id = v_org for update;
  if not found then raise exception 'check-out not found' using errcode = '42501'; end if;
  -- Inventory edit, or event-day Command edit for stock given out on an event (0268)
  if not (public.has_area('inventory', 'edit') or (v_row.quote_id is not null and public.has_area('command', 'edit'))) then
    raise exception 'not authorized' using errcode = '42501'; end if;
  if v_row.status = 'cancelled' then raise exception 'This was cancelled - nothing to mark back.' using errcode = 'P0001'; end if;
  if v_row.status <> 'out' then raise exception 'Already marked back.' using errcode = 'P0001'; end if;
  if v_ok < 0 or v_dmg < 0 or v_ok <> trunc(v_ok) or v_dmg <> trunc(v_dmg) then
    raise exception 'Use whole numbers, 0 or more.' using errcode = '22023'; end if;
  select coalesce(i.item_kind, 'reusable') into v_kind from public.inventory_items i where i.id = v_row.item_id and i.org_id = v_org;
  v_prior := coalesce(v_row.qty_in, 0);
  v_left := greatest(v_row.qty_out - v_prior, 0);
  if v_ok + v_dmg > v_left then
    raise exception 'Only % still out - came back OK + damaged can be at most %.', v_left, v_left using errcode = '22023'; end if;
  v_part := coalesce(p_rest_out, false) and v_ok + v_dmg < v_left;
  if v_part and v_ok + v_dmg = 0 then raise exception 'Count what came back now (the rest stays out).' using errcode = '22023'; end if;
  if v_kind = 'consumable' then
    if v_part and v_dmg > 0 then raise exception 'A consumable is not marked damaged - count what is left over.' using errcode = '22023'; end if;
    if not v_part then v_used := v_left - v_ok; v_dmg := 0; end if;        -- what did not come back was used (old screens: damaged = used)
    v_off := v_used;
  elsif v_part then
    v_off := v_dmg;                                                            -- damaged leaves what you own now; the rest stays Out
  else
    v_miss := v_left - v_ok - v_dmg;
    v_off := v_miss + v_dmg;
  end if;
  v_photo := nullif(btrim(coalesce(p_photo, '')), '');
  if v_photo is not null and not public._r374_photo_ok(v_photo, v_org, v_row.quote_id) then
    raise exception 'That photo was not uploaded for this studio and event - add it again.' using errcode = '22023', hint = 'photo_invalid'; end if;
  v_cfg := public._r374_cfg(v_org);
  if coalesce(p_strict, false) and v_kind <> 'consumable' and (v_miss > 0 or v_dmg > 0) and v_photo is null
     and coalesce((v_cfg ->> 'photo_proof')::boolean, true) then
    raise exception 'Add a photo of the damaged or missing items (your studio asks for one).' using errcode = '22023', hint = 'photo_required'; end if;
  if p_decision is not null and not coalesce(public.has_area('finance', 'edit'), false) then
    raise exception 'Only someone with Finance edit can decide who pays for a loss.' using errcode = '42501', hint = 'finance_only'; end if;

  if v_part then
    update public.inventory_checkouts
       set qty_in = v_prior + v_ok + v_dmg, qty_damaged = coalesce(qty_damaged, 0) + v_dmg,
           written_off = coalesce(written_off, 0) + v_off,
           returned_by = coalesce(nullif(btrim(coalesce(p_returned_by, '')), ''), returned_by)
     where id = p_id and org_id = v_org
     returning * into v_row;
    insert into public.inventory_stock_events (org_id, checkout_id, item_id, quote_id, kind, qty, damaged, note, created_by)
      values (v_org, v_row.id, v_row.item_id, v_row.quote_id, 'part_back', v_ok, v_dmg,
              left(nullif(btrim(coalesce(p_returned_by, '')), ''), 500), auth.uid());
  else
    update public.inventory_checkouts
       set qty_in = v_prior + v_ok + v_dmg + v_used, qty_damaged = coalesce(qty_damaged, 0) + v_dmg,
           qty_used = coalesce(qty_used, 0) + v_used,
           returned_by = nullif(btrim(coalesce(p_returned_by, '')), ''),
           confirmed_by = auth.uid(), checked_in_at = now(),
           written_off = coalesce(written_off, 0) + v_off,
           status = case when v_miss = 0 then 'returned' else 'partial' end
     where id = p_id and org_id = v_org
     returning * into v_row;
  end if;
  if v_off > 0 then
    update public.inventory_items set total_qty = greatest(0, coalesce(total_qty, 0) - v_off)
     where id = v_row.item_id and org_id = v_org;
  end if;
  if v_photo is not null then
    insert into public.inventory_stock_events (org_id, checkout_id, item_id, quote_id, kind, photo_path, created_by)
      values (v_org, v_row.id, v_row.item_id, v_row.quote_id, 'photo', v_photo, auth.uid());
  end if;
  if p_decision is not null and (v_miss > 0 or v_dmg > 0 or (v_row.written_off - coalesce(v_row.qty_used, 0)) > 0) then
    v_dec := public._r374_decide(v_row.id, p_decision, p_charge, null);
  end if;
  return jsonb_build_object('ok', true, 'checkout_id', v_row.id, 'status', v_row.status, 'kind', v_kind,
    'back', v_ok, 'damaged', v_dmg, 'missing', v_miss, 'used', v_used, 'written_off', v_off,
    'still_out', case when v_part then v_left - v_ok - v_dmg else 0 end, 'part', v_part,
    'photo_needed', v_kind <> 'consumable' and (v_miss > 0 or v_dmg > 0) and v_photo is null, 'decision', v_dec);
end $$;

-- the 0268 call (Inventory, Teardown, Event-day command): same inputs and answers, now knows an earlier part-return + consumables
create or replace function public.checkin_stock(p_id uuid, p_ok numeric, p_damaged numeric default 0, p_returned_by text default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
-- r24-stock-0268 + r191-inventory-0374
begin
  return public._r374_checkin(p_id, p_ok, p_damaged, p_returned_by, false, null, false, null, null);
end $$;

-- the R191 call: + the rest is still out, photo proof (studio setting), the absorb / charge decision (Finance edit)
create or replace function public.checkin_stock_v2(p_id uuid, p_ok numeric, p_damaged numeric default 0, p_returned_by text default null,
                                                   p_rest_out boolean default false, p_photo_path text default null,
                                                   p_decision text default null, p_charge_amount numeric default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
-- r191-inventory-0374
begin
  return public._r374_checkin(p_id, p_ok, p_damaged, p_returned_by, p_rest_out, p_photo_path, true,
                              nullif(btrim(coalesce(p_decision, '')), ''), p_charge_amount);
end $$;

-- the crew link (0073): a returned TOTAL lower than what the store already counted would lose that count - refused
do $$ begin
  if to_regprocedure('public.worker_checkin_equipment__pre0374(uuid,uuid,numeric)') is null then
    alter function public.worker_checkin_equipment(uuid, uuid, numeric) rename to worker_checkin_equipment__pre0374;
  end if;
end $$;
create or replace function public.worker_checkin_equipment(p_token uuid, p_id uuid, p_qty_in numeric)
returns jsonb language plpgsql security definer set search_path = '' as $$
-- r191-inventory-0374: wraps the kept 0073 body (worker_checkin_equipment__pre0374)
declare v_prior numeric; v_status text;
begin
  perform public._work_token_live(p_token);
  select coalesce(c.qty_in, 0), c.status into v_prior, v_status from public.inventory_checkouts c where c.id = p_id;
  if v_status = 'out' and v_prior > 0 and coalesce(p_qty_in, 0) < v_prior then
    raise exception 'The store already counted % back - enter the total returned (at least %).', v_prior, v_prior using errcode = '22023';
  end if;
  return public.worker_checkin_equipment__pre0374(p_token, p_id, p_qty_in);
end $$;

-- ---- 9) found / repair / photo later -------------------------------------------------------------------------------------------
create or replace function public._r374_lock(p_checkout uuid, p_need_edit boolean)
returns public.inventory_checkouts language plpgsql security definer set search_path = '' as $$
-- r191-inventory-0374: internal - the check-out of this studio, locked, and the right to change stock on it
declare v_row public.inventory_checkouts;
begin
  select * into v_row from public.inventory_checkouts where id = p_checkout and org_id = public.current_org_id() for update;
  if not found then raise exception 'check-out not found' using errcode = '42501'; end if;
  if not (public.has_area('inventory', 'edit') or (v_row.quote_id is not null and public.has_area('command', 'edit'))) then
    raise exception 'not authorized' using errcode = '42501'; end if;
  if v_row.status = 'cancelled' then raise exception 'This was cancelled.' using errcode = 'P0001'; end if;
  return v_row;
end $$;

create or replace function public._r374_sum(p_checkout uuid, p_kind text)
returns numeric language sql stable security definer set search_path = '' as $$
  -- r191-inventory-0374
  select coalesce(sum(e.qty), 0) from public.inventory_stock_events e where e.checkout_id = p_checkout and e.kind = p_kind;
$$;

-- a late return: units that were written off as missing turn up - back in stock, the loss credited on that event
create or replace function public.stock_found(p_checkout uuid, p_qty numeric, p_note text default null, p_photo_path text default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
-- r191-inventory-0374
declare v_org uuid := public.current_org_id(); v_c public.inventory_checkouts; v_missing numeric; v_photo text := nullif(btrim(coalesce(p_photo_path, '')), '');
begin
  v_c := public._r374_lock(p_checkout, true);
  v_missing := greatest(coalesce(v_c.written_off, 0) - coalesce(v_c.qty_damaged, 0) - coalesce(v_c.qty_used, 0), 0) - public._r374_sum(v_c.id, 'found');
  if p_qty is null or p_qty <= 0 or p_qty <> trunc(p_qty) then raise exception 'How many turned up? (a whole number above 0)' using errcode = '22023'; end if;
  if p_qty > v_missing then raise exception 'Only % of this line are still missing.', greatest(v_missing, 0) using errcode = '22023'; end if;
  if v_photo is not null and not public._r374_photo_ok(v_photo, v_org, v_c.quote_id) then
    raise exception 'That photo was not uploaded for this studio and event - add it again.' using errcode = '22023', hint = 'photo_invalid'; end if;
  insert into public.inventory_stock_events (org_id, checkout_id, item_id, quote_id, kind, qty, photo_path, note, created_by)
    values (v_org, v_c.id, v_c.item_id, v_c.quote_id, 'found', p_qty, v_photo, left(nullif(btrim(coalesce(p_note, '')), ''), 500), auth.uid());
  update public.inventory_items set total_qty = coalesce(total_qty, 0) + p_qty where id = v_c.item_id and org_id = v_org;
  return jsonb_build_object('ok', true, 'found', p_qty, 'still_missing', v_missing - p_qty);
end $$;

-- damaged -> under repair -> repaired (back in stock, optional repair cost - Finance edit) or cannot be fixed
create or replace function public.stock_repair(p_checkout uuid, p_action text, p_qty numeric, p_cost numeric default null, p_note text default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
-- r191-inventory-0374
declare v_org uuid := public.current_org_id(); v_c public.inventory_checkouts; v_s numeric; v_r numeric; v_x numeric; v_avail numeric;
        v_kind text; v_note text := left(nullif(btrim(coalesce(p_note, '')), ''), 500);
begin
  v_c := public._r374_lock(p_checkout, true);
  if p_action not in ('start', 'done', 'scrap') then raise exception 'unknown repair step' using errcode = '22023'; end if;
  if p_qty is null or p_qty <= 0 or p_qty <> trunc(p_qty) then raise exception 'How many? (a whole number above 0)' using errcode = '22023'; end if;
  v_s := public._r374_sum(v_c.id, 'repair_start'); v_r := public._r374_sum(v_c.id, 'repaired'); v_x := public._r374_sum(v_c.id, 'scrapped');
  v_avail := case when p_action = 'start' then coalesce(v_c.qty_damaged, 0) - v_s else v_s - v_r - v_x end;
  if p_qty > v_avail then
    raise exception '%', case when p_action = 'start' then 'Only ' || greatest(v_avail, 0)::text || ' damaged on this line are not in repair yet.'
                              else 'Only ' || greatest(v_avail, 0)::text || ' on this line are in repair.' end using errcode = '22023'; end if;
  if p_cost is not null and (p_action <> 'done' or p_cost < 0 or p_cost >= 1000000000 or round(p_cost, 2) <> p_cost) then
    raise exception 'A repair cost is an amount of 0 or more, given when it is repaired.' using errcode = '22023'; end if;
  if coalesce(p_cost, 0) > 0 and not coalesce(public.has_area('finance', 'edit'), false) then
    raise exception 'Only someone with Finance edit can record a repair cost.' using errcode = '42501', hint = 'finance_only'; end if;
  v_kind := case p_action when 'start' then 'repair_start' when 'done' then 'repaired' else 'scrapped' end;
  insert into public.inventory_stock_events (org_id, checkout_id, item_id, quote_id, kind, qty, amount, note, created_by)
    values (v_org, v_c.id, v_c.item_id, v_c.quote_id, v_kind, p_qty, nullif(p_cost, 0), v_note, auth.uid());
  if p_action = 'done' then
    update public.inventory_items set total_qty = coalesce(total_qty, 0) + p_qty where id = v_c.item_id and org_id = v_org;
  end if;
  return jsonb_build_object('ok', true, 'step', v_kind, 'qty', p_qty);
end $$;

create or replace function public.stock_add_photo(p_checkout uuid, p_photo_path text)
returns jsonb language plpgsql security definer set search_path = '' as $$
-- r191-inventory-0374: photo proof added after the check-in (or at any step)
declare v_org uuid := public.current_org_id(); v_c public.inventory_checkouts;
begin
  v_c := public._r374_lock(p_checkout, true);
  if not public._r374_photo_ok(nullif(btrim(coalesce(p_photo_path, '')), ''), v_org, v_c.quote_id) then
    raise exception 'That photo was not uploaded for this studio and event - add it again.' using errcode = '22023', hint = 'photo_invalid'; end if;
  if (select count(*) from public.inventory_stock_events e where e.checkout_id = v_c.id and e.kind = 'photo') >= 20 then
    raise exception 'This line already has 20 photos.' using errcode = '22023'; end if;
  insert into public.inventory_stock_events (org_id, checkout_id, item_id, quote_id, kind, photo_path, created_by)
    values (v_org, v_c.id, v_c.item_id, v_c.quote_id, 'photo', btrim(p_photo_path), auth.uid());
  return jsonb_build_object('ok', true);
end $$;

-- ---- 10) what the screens show per check-out (amounts only with Finance view) -------------------------------------------------
create or replace function public.stock_story(p_quote uuid default null)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
-- r191-inventory-0374: per check-out of one event (or the studio lines with a loss / history, newest 500)
declare v_org uuid := public.current_org_id(); v_money boolean; v_cfg jsonb;
begin
  if v_org is null or auth.uid() is null
     or not (public.has_area('inventory', 'view') or public.has_area('command', 'view') or public.has_area('closure', 'view')) then
    raise exception 'not authorized' using errcode = '42501'; end if;
  if p_quote is not null and not exists (select 1 from public.quotes q where q.id = p_quote and q.org_id = v_org) then
    raise exception 'event not found' using errcode = '42501'; end if;
  v_money := coalesce(public.has_area('finance', 'view'), false);
  v_cfg := public._r374_cfg(v_org);
  return jsonb_build_object('settings', v_cfg || jsonb_build_object('can_money', v_money, 'can_decide', coalesce(public.has_area('finance', 'edit'), false)),
    'lines', coalesce((select jsonb_object_agg(z.id, z.j) from (
      select c.id, jsonb_strip_nulls(jsonb_build_object(
        'item_kind', coalesce(i.item_kind, 'reusable'),
        'used', coalesce(c.qty_used, 0),
        'missing', greatest(coalesce(c.written_off, 0) - coalesce(c.qty_damaged, 0) - coalesce(c.qty_used, 0), 0),
        'damaged', coalesce(c.qty_damaged, 0),
        'part_back', coalesce(s.part_ok, 0) + coalesce(s.part_dmg, 0),
        'found', coalesce(s.found, 0), 'in_repair', greatest(coalesce(s.rs, 0) - coalesce(s.rr, 0) - coalesce(s.rx, 0), 0),
        'repaired', coalesce(s.rr, 0), 'scrapped', coalesce(s.rx, 0), 'photos', coalesce(s.photos, '[]'::jsonb),
        'photo_needed', coalesce(i.item_kind, 'reusable') <> 'consumable'
                        and (greatest(coalesce(c.written_off, 0) - coalesce(c.qty_used, 0), 0) > 0) and coalesce(jsonb_array_length(s.photos), 0) = 0
                        and coalesce((v_cfg ->> 'photo_proof')::boolean, true),
        'decision', d.kind,
        'charge_status', case when d.kind = 'charge_client' then coalesce(r.status, 'removed') end,
        'charge_amount', case when v_money and d.kind = 'charge_client' then d.amount end,
        'repair_cost', case when v_money then nullif(coalesce(s.rcost, 0), 0) end,
        'history', coalesce(s.hist, '[]'::jsonb))) as j
        from public.inventory_checkouts c
        join public.inventory_items i on i.id = c.item_id and i.org_id = v_org
        left join lateral (select sum(e.qty) filter (where e.kind = 'part_back') as part_ok, sum(e.damaged) filter (where e.kind = 'part_back') as part_dmg,
                                  sum(e.qty) filter (where e.kind = 'found') as found, sum(e.qty) filter (where e.kind = 'repair_start') as rs,
                                  sum(e.qty) filter (where e.kind = 'repaired') as rr, sum(e.qty) filter (where e.kind = 'scrapped') as rx,
                                  sum(e.amount) filter (where e.kind = 'repaired') as rcost,
                                  jsonb_agg(e.photo_path order by e.seq) filter (where e.photo_path is not null) as photos,
                                  jsonb_agg(jsonb_strip_nulls(jsonb_build_object('kind', e.kind, 'qty', e.qty, 'damaged', nullif(e.damaged, 0), 'at', e.created_at,
                                            'amount', case when v_money then e.amount end, 'note', e.note)) order by e.seq) as hist
                             from public.inventory_stock_events e where e.checkout_id = c.id) s on true
        left join lateral (select e.kind, e.amount, e.refund_id from public.inventory_stock_events e
                            where e.checkout_id = c.id and e.kind in ('absorb', 'charge_client') order by e.seq desc limit 1) d on true
        left join public.event_refunds r on r.id = d.refund_id and r.org_id = v_org
       where c.org_id = v_org and c.status <> 'cancelled'
         and (case when p_quote is not null then c.quote_id = p_quote
                   else (coalesce(c.written_off, 0) > 0 or exists (select 1 from public.inventory_stock_events e2 where e2.checkout_id = c.id)) end)
       order by c.checked_out_at desc nulls last limit 500) z), '{}'::jsonb));
end $$;

-- ---- 11) the event cost ledger: write-off lines split into used / lost / repaired / recovered (wrap, old body kept) ------------
do $$ begin
  if to_regprocedure('public._r21_cost_lines__pre0374(uuid,uuid)') is null then
    alter function public._r21_cost_lines(uuid, uuid) rename to _r21_cost_lines__pre0374;
  end if;
end $$;
create or replace function public._r21_cost_lines(p_quote uuid, p_org uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
-- r191-inventory-0374: wraps the kept body (_r21_cost_lines__pre0374). An event with no R191 rows and nothing used gets the
-- kept answer unchanged. Otherwise each write-off line becomes: consumables used (a normal cost in the item own category),
-- the loss still standing (written off - found later - repaired), the repair cost, and money the client paid back for it
-- (a Charge client recovery once processed). Every line keeps source writeoff so every total adds up as before.
-- The kept body carries the r21-money-0246 + r22-money-0252 + r23-crew-0265 ledger rules unchanged.
declare v_lines jsonb; v_out jsonb; v_new jsonb := '[]'::jsonb; x record;
begin
  v_lines := coalesce(public._r21_cost_lines__pre0374(p_quote, p_org), '[]'::jsonb);
  if not exists (select 1 from public.inventory_stock_events e where e.quote_id = p_quote and e.org_id = p_org)
     and not exists (select 1 from public.inventory_checkouts c where c.quote_id = p_quote and c.org_id = p_org
                       and coalesce(c.qty_used, 0) > 0 and c.status <> 'cancelled') then
    return v_lines;
  end if;
  select coalesce(jsonb_agg(l.v order by l.n), '[]'::jsonb) into v_out
    from jsonb_array_elements(v_lines) with ordinality l(v, n) where (l.v ->> 'source') is distinct from 'writeoff';
  for x in
    select ch.id, coalesce(i.unit_cost, 0) as unit_cost, coalesce(nullif(btrim(i.name), ''), 'Item') as name, i.category,
           least(coalesce(ch.qty_used, 0), coalesce(ch.written_off, 0)) as used,
           greatest(coalesce(ch.written_off, 0) - least(coalesce(ch.qty_used, 0), coalesce(ch.written_off, 0)), 0) as lost,
           coalesce(s.found, 0) as found, coalesce(s.rep, 0) as rep, coalesce(s.rcost, 0) as rcost,
           coalesce(s.back_paid, 0) as back_paid, coalesce(s.back_waiting, 0) as back_waiting
      from public.inventory_checkouts ch join public.inventory_items i on i.id = ch.item_id and i.org_id = p_org
      left join lateral (select sum(e.qty) filter (where e.kind = 'found') as found, sum(e.qty) filter (where e.kind = 'repaired') as rep,
                                sum(e.amount) filter (where e.kind = 'repaired') as rcost,
                                sum(r.amount) filter (where e.kind = 'charge_client' and r.status = 'processed') as back_paid,
                                sum(r.amount) filter (where e.kind = 'charge_client' and r.status in ('pending', 'approved')) as back_waiting
                           from public.inventory_stock_events e left join public.event_refunds r on r.id = e.refund_id and r.org_id = p_org
                          where e.checkout_id = ch.id) s on true
     where ch.quote_id = p_quote and ch.org_id = p_org and ch.written_off > 0 and ch.status <> 'cancelled'
     order by i.name, ch.id
  loop
    if x.used > 0 then
      v_new := v_new || jsonb_build_array(jsonb_build_object(
        'key', 'writeoff:' || x.id || ':used', 'source', 'writeoff', 'source_id', x.id,
        'category', public._r21_category(coalesce(x.category, '') || ' ' || x.name, 'misc'),
        'label', 'Used: ' || x.name || ' x' || trim(to_char(x.used, 'FM999999990.##')),
        'estimated', null, 'committed', null, 'actual', round(x.used * x.unit_cost, 2),
        'c_est', 0, 'c_com', 0, 'c_fc', round(x.used * x.unit_cost, 2), 'c_act', round(x.used * x.unit_cost, 2), 'paid', null,
        'cost_missing', x.unit_cost = 0,
        'note', case when x.unit_cost = 0 then 'used up - item cost missing (set it in Inventory)' else 'consumable used at the event' end));
    end if;
    if x.lost > 0 then
      v_new := v_new || jsonb_build_array(jsonb_build_object(
        'key', 'writeoff:' || x.id, 'source', 'writeoff', 'source_id', x.id, 'category', 'damages',
        'label', x.name || ' x' || trim(to_char(greatest(x.lost - x.found - x.rep, 0), 'FM999999990.##')),
        'estimated', null, 'committed', null, 'actual', round(greatest(x.lost - x.found - x.rep, 0) * x.unit_cost, 2),
        'c_est', 0, 'c_com', 0, 'c_fc', round(greatest(x.lost - x.found - x.rep, 0) * x.unit_cost, 2),
        'c_act', round(greatest(x.lost - x.found - x.rep, 0) * x.unit_cost, 2), 'paid', null, 'cost_missing', x.unit_cost = 0,
        'note', concat_ws('; ', case when x.unit_cost = 0 then 'written off - item cost missing (set it in Inventory)' else 'written off at check-in' end,
                          case when x.found > 0 then trim(to_char(x.found, 'FM999999990')) || ' found later' end,
                          case when x.rep > 0 then trim(to_char(x.rep, 'FM999999990')) || ' repaired' end,
                          case when x.back_waiting > 0 then 'charge to the client not collected yet' end)));
    end if;
    if x.rcost > 0 then
      v_new := v_new || jsonb_build_array(jsonb_build_object(
        'key', 'writeoff:' || x.id || ':repair', 'source', 'writeoff', 'source_id', x.id, 'category', 'damages',
        'label', 'Repair: ' || x.name || ' x' || trim(to_char(x.rep, 'FM999999990')),
        'estimated', null, 'committed', null, 'actual', round(x.rcost, 2),
        'c_est', 0, 'c_com', 0, 'c_fc', round(x.rcost, 2), 'c_act', round(x.rcost, 2), 'paid', null, 'note', 'repair cost'));
    end if;
    if x.back_paid > 0 then
      v_new := v_new || jsonb_build_array(jsonb_build_object(
        'key', 'writeoff:' || x.id || ':recovered', 'source', 'writeoff', 'source_id', x.id, 'category', 'damages',
        'label', 'Charged to client: ' || x.name,
        'estimated', null, 'committed', null, 'actual', -round(x.back_paid, 2),
        'c_est', 0, 'c_com', 0, 'c_fc', -round(x.back_paid, 2), 'c_act', -round(x.back_paid, 2), 'paid', null,
        'note', 'paid back by the client (Recover from client, processed)'));
    end if;
  end loop;
  return v_out || v_new;
end $$;

-- ---- 12) client portal: damage charges, only when the studio turns it on (off by default, wrap, old body kept) ----------------
do $$ begin
  if to_regprocedure('public.public_portal_extras__pre0374(uuid)') is null then
    alter function public.public_portal_extras(uuid) rename to public_portal_extras__pre0374;
  end if;
end $$;
create or replace function public.public_portal_extras(p_token uuid)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
-- r191-inventory-0374: wraps the kept body (public_portal_extras__pre0374: link checks, trial lockdown, limits unchanged)
declare v jsonb; v_q uuid; v_org uuid; v_dc jsonb;
begin
  v := public.public_portal_extras__pre0374(p_token);
  if v is null or jsonb_typeof(v) <> 'object' then return v; end if;
  select x.id, x.org_id into v_q, v_org from public.quotes x where x.approval_token = p_token and x.deleted_at is null limit 1;
  if v_q is null or not coalesce((public._r374_cfg(v_org) ->> 'portal_damage')::boolean, false) then return v; end if;
  select coalesce(jsonb_agg(jsonb_build_object('label', left(coalesce(r.reason, 'Damage / loss'), 200), 'amount', round(r.amount, 2),
                                               'status', case r.status when 'processed' then 'paid' else 'due' end, 'date', e.created_at::date)
                            order by e.seq), '[]'::jsonb)
    into v_dc
    from public.inventory_stock_events e join public.event_refunds r on r.id = e.refund_id and r.org_id = v_org
   where e.quote_id = v_q and e.org_id = v_org and e.kind = 'charge_client' and r.status <> 'rejected';
  return v || jsonb_build_object('damage_charges', v_dc);
end $$;

-- ---- 12b) item costs: Finance view (or stock staff when the studio allows it), the two new item columns readable -----------
do $$ begin
  if to_regprocedure('public.inventory_costs__pre0374(uuid[])') is null then
    alter function public.inventory_costs(uuid[]) rename to inventory_costs__pre0374;
  end if;
end $$;
create or replace function public.inventory_costs(p_ids uuid[])
returns table(id uuid, unit_cost numeric)
language plpgsql stable security definer set search_path = '' as $$
-- r191-inventory-0374: wraps the kept r58-inventory-cost-0299 body (inventory_costs__pre0374), Inventory edit alone no longer gets costs unless
-- the studio turns stock staff see item costs on (Finance view always does)
#variable_conflict use_column
declare v_org uuid := public.current_org_id();
begin
  if auth.uid() is null or v_org is null then raise exception 'not authorized' using errcode = '42501'; end if;
  if not public._r374_can_cost(v_org) then return; end if;
  return query select x.id, x.unit_cost from public.inventory_costs__pre0374(p_ids) x;
end $$;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'authenticated')
     and not has_column_privilege('authenticated', 'public.inventory_items', 'unit_cost', 'select') then
    -- 0299 granted the readable columns one by one: the two new ones join that list (unit_cost stays closed)
    grant select (item_kind, reorder_level) on public.inventory_items to authenticated;
  end if;
end $$;

-- ---- 13) photo proof files: the private event-docs bucket, folder <studio>/<event or none>/stock/ (new policies only) ----------
do $$ begin
  if to_regclass('storage.objects') is not null and to_regprocedure('storage.foldername(text)') is not null then
    execute 'drop policy if exists event_docs_stock_insert_0374 on storage.objects';
    execute $p$create policy event_docs_stock_insert_0374 on storage.objects for insert to authenticated
      with check (bucket_id = 'event-docs'
        and (storage.foldername(name))[1] = (select public.current_org_id())::text
        and (storage.foldername(name))[3] = 'stock' and array_length(storage.foldername(name), 1) = 3
        and ((select public.has_area('inventory', 'edit')) or (select public.has_area('command', 'edit'))))$p$;
    execute 'drop policy if exists event_docs_stock_select_0374 on storage.objects';
    execute $p$create policy event_docs_stock_select_0374 on storage.objects for select to authenticated
      using (bucket_id = 'event-docs'
        and (storage.foldername(name))[1] = (select public.current_org_id())::text
        and (storage.foldername(name))[3] = 'stock'
        and ((select public.has_area('inventory', 'view')) or (select public.has_area('command', 'view')) or (select public.has_area('closure', 'view'))))$p$;
  end if;
end $$;

-- ---- 14) free-trial purge: the stock history + windows go with the studio events, the settings are kept -----------------------
do $$ declare v_def text; begin
  if to_regprocedure('public._tr184_purge_tables()') is not null then
    v_def := pg_get_functiondef('public._tr184_purge_tables()'::regprocedure);
    if position('''inventory_stock_events''' in v_def) = 0 then
      if (length(v_def) - length(replace(v_def, '''inventory_checkouts''', ''))) / length('''inventory_checkouts''') <> 1 then
        raise notice '0374: _tr184_purge_tables has an unexpected body - left unchanged';
      else execute replace(v_def, '''inventory_checkouts''', '''inventory_stock_events'', ''event_stock_windows'', ''inventory_checkouts'''); end if;
    end if;
  end if;
  if to_regprocedure('public._tr184_keep_tables()') is not null then
    v_def := pg_get_functiondef('public._tr184_keep_tables()'::regprocedure);
    if position('''inventory_settings''' in v_def) = 0 then
      if (length(v_def) - length(replace(v_def, '''trial_extensions''', ''))) / length('''trial_extensions''') <> 1 then
        raise notice '0374: _tr184_keep_tables has an unexpected body - left unchanged';
      else execute replace(v_def, '''trial_extensions''', '''trial_extensions'', ''inventory_settings'''); end if;
    end if;
  end if;
end $$;

-- ---- 15) grants: the screen calls for signed-in staff, helpers + kept bodies for the server only ---------------------------------
do $$
declare f text;
begin
  foreach f in array array['public._r374_cfg(uuid)', 'public._r374_buffer(uuid)', 'public._r374_win(uuid,uuid)', 'public._r374_load(uuid,uuid,uuid)',
                           'public._r374_photo_ok(text,uuid,uuid)', 'public._r374_decide(uuid,text,numeric,text)',
                           'public._r374_checkin(uuid,numeric,numeric,text,boolean,text,boolean,text,numeric)',
                           'public._r374_lock(uuid,boolean)', 'public._r374_sum(uuid,text)', 'public._r374_can_cost(uuid)',
                           'public._r21_cost_lines(uuid,uuid)', 'public._r21_cost_lines__pre0374(uuid,uuid)',
                           'public.public_portal_extras__pre0374(uuid)', 'public.worker_checkin_equipment__pre0374(uuid,uuid,numeric)'] loop
    continue when to_regprocedure(f) is null;
    execute format('revoke all on function %s from public', f);
    if exists (select 1 from pg_roles where rolname = 'anon') then execute format('revoke all on function %s from anon', f); end if;
    if exists (select 1 from pg_roles where rolname = 'authenticated') then execute format('revoke all on function %s from authenticated', f); end if;
    if exists (select 1 from pg_roles where rolname = 'service_role') then execute format('grant execute on function %s to service_role', f); end if;
  end loop;
  foreach f in array array['public.inventory_settings_get()', 'public.inventory_settings_set(boolean,boolean,integer,boolean)',
                           'public.event_stock_window_set(uuid,date,date)', 'public.stock_windows(uuid[])', 'public.stock_overlaps(uuid)',
                           'public.checkin_stock(uuid,numeric,numeric,text)',
                           'public.checkin_stock_v2(uuid,numeric,numeric,text,boolean,text,text,numeric)',
                           'public.stock_damage_decision(uuid,text,numeric,text)', 'public.stock_found(uuid,numeric,text,text)',
                           'public.stock_repair(uuid,text,numeric,numeric,text)', 'public.stock_add_photo(uuid,text)',
                           'public.stock_story(uuid)'] loop
    execute format('revoke all on function %s from public', f);
    if exists (select 1 from pg_roles where rolname = 'anon') then execute format('revoke all on function %s from anon', f); end if;
    if exists (select 1 from pg_roles where rolname = 'authenticated') then execute format('grant execute on function %s to authenticated', f); end if;
  end loop;
  if to_regprocedure('public.inventory_costs__pre0374(uuid[])') is not null then
    execute 'revoke all on function public.inventory_costs__pre0374(uuid[]) from public';
    if exists (select 1 from pg_roles where rolname = 'anon') then execute 'revoke all on function public.inventory_costs__pre0374(uuid[]) from anon'; end if;
    if exists (select 1 from pg_roles where rolname = 'authenticated') then execute 'revoke all on function public.inventory_costs__pre0374(uuid[]) from authenticated'; end if;
    execute 'revoke all on function public.inventory_costs(uuid[]) from public';
    if exists (select 1 from pg_roles where rolname = 'anon') then execute 'revoke all on function public.inventory_costs(uuid[]) from anon'; end if;
    if exists (select 1 from pg_roles where rolname = 'authenticated') then execute 'grant execute on function public.inventory_costs(uuid[]) to authenticated'; end if;
  end if;
  -- the two link-facing wrappers keep the grants their kept bodies had
  foreach f in array array['public.public_portal_extras(uuid)', 'public.worker_checkin_equipment(uuid,uuid,numeric)'] loop
    execute format('revoke all on function %s from public', f);
    if exists (select 1 from pg_roles where rolname = 'anon') then execute format('grant execute on function %s to anon', f); end if;
    if exists (select 1 from pg_roles where rolname = 'authenticated') then execute format('grant execute on function %s to authenticated', f); end if;
    if exists (select 1 from pg_roles where rolname = 'service_role') then execute format('grant execute on function %s to service_role', f); end if;
  end loop;
end $$;

notify pgrst, 'reload schema';

-- ---- VERIFY (read-only): every row must say ok = true ------------------------------------------------------------------------------
select item, ok from (values
  ('01 item type + reorder level + used on check-outs (old rows Reusable / 0)',
     exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'inventory_items' and column_name = 'item_kind')
     and exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'inventory_items' and column_name = 'reorder_level')
     and exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'inventory_checkouts' and column_name = 'qty_used')),
  ('02 three insert-only tables, row security on, no app grants',
     (select bool_and(c.relrowsecurity) from pg_class c where c.oid in ('public.inventory_stock_events'::regclass, 'public.inventory_settings'::regclass, 'public.event_stock_windows'::regclass))
     and not has_table_privilege('authenticated', 'public.inventory_stock_events', 'select')
     and not has_table_privilege('authenticated', 'public.inventory_stock_events', 'insert')
     and not has_table_privilege('anon', 'public.event_stock_windows', 'select')
     and (select count(*) from pg_trigger t where t.tgname = 'a374_insert_only') = 3),
  ('03 screens'' calls for signed-in staff only',
     has_function_privilege('authenticated', 'public.checkin_stock_v2(uuid,numeric,numeric,text,boolean,text,text,numeric)', 'execute')
     and not has_function_privilege('anon', 'public.checkin_stock_v2(uuid,numeric,numeric,text,boolean,text,text,numeric)', 'execute')
     and has_function_privilege('authenticated', 'public.stock_story(uuid)', 'execute')
     and not has_function_privilege('anon', 'public.stock_found(uuid,numeric,text,text)', 'execute')
     and not has_function_privilege('anon', 'public.inventory_settings_set(boolean,boolean,integer,boolean)', 'execute')),
  ('04 helpers + kept bodies server only',
     not has_function_privilege('authenticated', 'public._r374_checkin(uuid,numeric,numeric,text,boolean,text,boolean,text,numeric)', 'execute')
     and not has_function_privilege('authenticated', 'public._r21_cost_lines__pre0374(uuid,uuid)', 'execute')
     and not has_function_privilege('anon', 'public.public_portal_extras__pre0374(uuid)', 'execute')
     and not has_function_privilege('anon', 'public.worker_checkin_equipment__pre0374(uuid,uuid,numeric)', 'execute')),
  ('05 three wraps kept once (ledger, client portal, crew-link return)',
     to_regprocedure('public._r21_cost_lines__pre0374(uuid,uuid)') is not null
     and position('r191-inventory-0374' in pg_get_functiondef(to_regprocedure('public._r21_cost_lines(uuid,uuid)'))) > 0
     and to_regprocedure('public.public_portal_extras__pre0374(uuid)') is not null
     and position('r191-inventory-0374' in pg_get_functiondef(to_regprocedure('public.public_portal_extras(uuid)'))) > 0
     and to_regprocedure('public.worker_checkin_equipment__pre0374(uuid,uuid,numeric)') is not null
     and has_function_privilege('anon', 'public.public_portal_extras(uuid)', 'execute')),
  ('06 free stock + reserve on the stock window',
     position('r191-inventory-0374' in pg_get_functiondef(to_regprocedure('public._checkout_free(uuid,date,uuid)'))) > 0
     and position('r191-inventory-0374' in pg_get_functiondef(to_regprocedure('public.reserve_inventory(uuid,uuid,numeric,text)'))) > 0
     and position('r191-inventory-0374' in pg_get_functiondef(to_regprocedure('public.reserve_inventory_with_sourcing(uuid,uuid,numeric,text,text,uuid,numeric,text)'))) > 0
     and position('r191-inventory-0374' in pg_get_functiondef(to_regprocedure('public.checkin_stock(uuid,numeric,numeric,text)'))) > 0),
  ('07 free-trial purge knows the stock history, keeps the settings (or 0184 is absent)', to_regprocedure('public._tr184_purge_tables()') is null
     or (position('inventory_stock_events' in pg_get_functiondef(to_regprocedure('public._tr184_purge_tables()'))) > 0
         and position('inventory_settings' in pg_get_functiondef(to_regprocedure('public._tr184_keep_tables()'))) > 0)),
  ('09 item costs: Finance (or stock staff when allowed); the new item columns readable',
     position('r191-inventory-0374' in pg_get_functiondef(to_regprocedure('public.inventory_costs(uuid[])'))) > 0
     and to_regprocedure('public.inventory_costs__pre0374(uuid[])') is not null
     and (not exists (select 1 from pg_roles where rolname = 'authenticated')
          or has_column_privilege('authenticated', 'public.inventory_items', 'item_kind', 'select'))),
  ('08 photo folder policies (or no storage schema)', to_regclass('storage.objects') is null
     or (select count(*) from pg_policies where schemaname = 'storage' and tablename = 'objects' and policyname like 'event_docs_stock_%_0374') = 2)
) v(item, ok) order by item;
commit;
