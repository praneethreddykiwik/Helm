-- 0444_r258_wrap_records.sql - R258 (owner, 25 Nov 2026: "Vendors: returned, all the items returned, or how? A note if not returned ... under
-- inventory and under vendors only"). Forward-only, additive, safe to run twice. ASCII only. Paste the whole file in the Supabase SQL editor; the
-- last statement answers one row per check. The pages work without it (the two new vendor answers and the stock note stay switched off).
-- REQUIRES 0374 (stock check-in), 0396 (_r396_event), 0442 (_r442_name).
--
-- In plain words:
--   A  VENDOR ITEMS. Wrap-up asks per booked vendor "All their items handed back?": All returned / Not returned / Returned with a problem (the
--      last two need a note; with a quantity on the booking also how many of them). Every answer is one new row with who and when; Undo is a row
--      too. Nothing is ever changed or deleted. The booking, its status and its money are not touched.
--   B  STOCK NOTE. A note with a stock problem (damaged / missing / still out), kept with the check-out it is about.
--   Rights: vendor answers = Event-day command edit + Vendors view (the arrival rows' right), stock notes = the right to mark stock back (0374).
--   Same studio only, signed in only. A closed or cancelled event takes no vendor answer.
--
-- ZERO DATA LOSS: 1 new table + 3 functions. No stored row is read for change, changed or deleted.
-- ROLLBACK (manual): drop the three functions; the table can stay.

-- ---- 0) preflight -----------------------------------------------------------------------------------------------------
do $$ declare f text; begin
  foreach f in array array['public._r396_event(uuid)', 'public._r442_name()', 'public.has_area(text,text)', 'public.current_org_id()', 'public.checkin_stock_v2(uuid,numeric,numeric,text,boolean,text,text,numeric)'] loop
    if to_regprocedure(f) is null then raise exception 'STOP 0444: run 0374, 0396 and 0442 first (% missing)', f; end if;
  end loop;
  if to_regclass('public.event_resources') is null or to_regclass('public.inventory_checkouts') is null then raise exception 'STOP 0444: the vendor bookings or stock tables are missing'; end if;
end $$;

-- ---- 1) the table: insert-only, server only -------------------------------------------------------------------------------
create table if not exists public.event_wrap_records (
  id         uuid primary key default gen_random_uuid(),
  seq        bigint generated always as identity,
  org_id     uuid not null references public.organizations(id),
  quote_id   uuid not null references public.quotes(id) on delete cascade,
  part       text not null,
  ref_id     uuid not null,
  label      text,
  state      text not null,
  qty_total  numeric,
  qty_back   numeric,
  note       text,
  by_user    uuid,
  by_name    text,
  at         timestamptz not null default clock_timestamp(),
  constraint event_wrap_records_part_chk444 check (part in ('vendor', 'stock')),
  constraint event_wrap_records_state_chk444 check (case when part = 'stock' then state = 'note' else state in ('returned', 'not_returned', 'problem', 'undo') end),
  constraint event_wrap_records_text_chk444 check (char_length(coalesce(note, '')) <= 500 and char_length(coalesce(label, '')) <= 200 and char_length(coalesce(by_name, '')) <= 80),
  constraint event_wrap_records_note_chk444 check (state not in ('not_returned', 'problem', 'note') or char_length(btrim(coalesce(note, ''))) > 0),
  constraint event_wrap_records_qty_chk444 check ((qty_total is null or qty_total > 0) and (qty_back is null or (qty_back >= 0 and qty_total is not null and qty_back <= qty_total)))
);
comment on table public.event_wrap_records is 'r258-0444: Wrap-up - were a vendor''s items handed back (each answer one row, Undo too) and the notes of a stock problem. Insert-only.';
create index if not exists event_wrap_records_quote444 on public.event_wrap_records (quote_id, part, ref_id, seq desc);
create index if not exists event_wrap_records_org444 on public.event_wrap_records (org_id);

do $$ declare r text; v_def text; begin
  alter table public.event_wrap_records enable row level security;
  revoke all on table public.event_wrap_records from public;
  foreach r in array array['anon', 'authenticated', 'service_role'] loop
    if exists (select 1 from pg_roles where rolname = r) then execute format('revoke all on table public.event_wrap_records from %I', r); end if;
  end loop;
  if exists (select 1 from pg_roles where rolname = 'service_role') then grant select on table public.event_wrap_records to service_role; end if;
  if to_regprocedure('public.tg_quote_org_match()') is not null
     and not exists (select 1 from pg_trigger where tgrelid = 'public.event_wrap_records'::regclass and tgname = 'zz_quote_org_match') then
    create trigger zz_quote_org_match before insert or update on public.event_wrap_records for each row execute function public.tg_quote_org_match();
  end if;
  if to_regprocedure('public.tg_studio_read_only()') is not null
     and not exists (select 1 from pg_trigger where tgrelid = 'public.event_wrap_records'::regclass and tgname = 'zzz_studio_read_only') then
    create trigger zzz_studio_read_only before insert or update or delete on public.event_wrap_records for each row execute function public.tg_studio_read_only('org_id');
  end if;
  -- free-trial retention (0184): they go with the studio's events (patched in place once, like 0442)
  if to_regprocedure('public._tr184_purge_tables()') is not null then
    v_def := pg_get_functiondef('public._tr184_purge_tables()'::regprocedure);
    if position('''event_wrap_records''' in v_def) = 0 then
      if (length(v_def) - length(replace(v_def, '''event_issues'', ', ''))) / length('''event_issues'', ') <> 1 then
        raise notice '0444: _tr184_purge_tables has an unexpected body - left unchanged';
      else execute replace(v_def, '''event_issues'', ', '''event_issues'', ''event_wrap_records'', '); end if;
    end if;
  end if;
end $$;

-- ---- 2) helpers (server only) ---------------------------------------------------------------------------------------------
create or replace function public._r444_item(p public.event_wrap_records)
returns jsonb language sql immutable set search_path = '' as $fn$
  -- r258-0444
  select case when p.id is null then null else jsonb_build_object('id', p.id, 'ref', p.ref_id, 'label', p.label, 'state', p.state, 'qty_total', p.qty_total, 'qty_back', p.qty_back, 'note', p.note, 'by', p.by_name, 'at', p.at) end;
$fn$;
create or replace function public._r444_note(p_note text)
returns text language plpgsql immutable set search_path = '' as $fn$
-- r258-0444
declare v text := nullif(btrim(regexp_replace(coalesce(p_note, ''), '[[:cntrl:][:space:]]+', ' ', 'g')), '');
begin
  if char_length(coalesce(v, '')) > 500 then raise exception 'A note can have up to 500 characters.' using errcode = '22023', hint = 'r444_note'; end if;
  if coalesce(v, '') ~ '[<>]' then raise exception 'Leave out < and >.' using errcode = '22023', hint = 'r444_note'; end if;
  return v;
end $fn$;

-- ---- 3) what the pages call ------------------------------------------------------------------------------------------------
create or replace function public.event_wrap_records_get(p_quote uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $fn$
-- r258-0444
declare v_org uuid := public._r396_event(p_quote); v_v boolean; v_s boolean;
begin
  v_v := coalesce(public.has_area('vendors', 'view'), false) and coalesce(public.has_area('command', 'view'), false);
  v_s := coalesce(public.has_area('inventory', 'view'), false) or coalesce(public.has_area('command', 'view'), false);
  if not v_v and not v_s then raise exception 'not allowed' using errcode = '42501'; end if;
  return jsonb_build_object('v', 1,
    'vendor', case when v_v then coalesce((select jsonb_object_agg(x.ref_id, public._r444_item(x)) from
        (select distinct on (w.ref_id) w.* from public.event_wrap_records w where w.quote_id = p_quote and w.org_id = v_org and w.part = 'vendor' order by w.ref_id, w.seq desc) x), '{}'::jsonb) end,
    'stock', case when v_s then coalesce((select jsonb_agg(public._r444_item(x) order by x.seq desc) from
        (select w.* from public.event_wrap_records w where w.quote_id = p_quote and w.org_id = v_org and w.part = 'stock' order by w.seq desc limit 200) x), '[]'::jsonb) end,
    'log', case when v_v then coalesce((select jsonb_agg(public._r444_item(x) order by x.seq desc) from
        (select w.* from public.event_wrap_records w where w.quote_id = p_quote and w.org_id = v_org and w.part = 'vendor' order by w.seq desc limit 100) x), '[]'::jsonb) end);
end $fn$;

-- one answer (or Undo) for one booked vendor. p_seen = the answer the page showed (null = none): somebody else was faster = nothing is written and
-- the new state is answered. p_id = made by the page: the same press twice is one row.
create or replace function public.event_vendor_return_set(p_quote uuid, p_booking uuid, p_state text, p_note text default null, p_qty_back numeric default null,
                                                          p_seen uuid default null, p_id uuid default null)
returns jsonb language plpgsql volatile security definer set search_path = '' as $fn$
-- r258-0444
declare v_org uuid := public._r396_event(p_quote); v_note text; q record; b record; cur public.event_wrap_records; n public.event_wrap_records; v_total numeric; v_back numeric;
begin
  if not coalesce(public.has_area('command', 'edit'), false) or not coalesce(public.has_area('vendors', 'view'), false) then raise exception 'not allowed' using errcode = '42501'; end if;
  if coalesce(p_state, '') not in ('returned', 'not_returned', 'problem', 'undo') then raise exception 'invalid_state' using errcode = '22023'; end if;
  v_note := public._r444_note(p_note);
  if p_state in ('not_returned', 'problem') and v_note is null then raise exception 'Write a short note: what was not handed back, or what is wrong.' using errcode = '22023', hint = 'r444_note'; end if;
  select x.status, x.lifecycle_stage into q from public.quotes x where x.id = p_quote;
  if coalesce(q.status, '') in ('cancelled', 'lost') or coalesce(q.lifecycle_stage, '') in ('closed', 'cancelled', 'archived') then
    raise exception 'This event is closed or cancelled - nothing can be changed here.' using errcode = '22023', hint = 'r444_closed'; end if;
  perform pg_catalog.pg_advisory_xact_lock(hashtextextended('r444:' || p_quote::text, 0));   -- one change at a time per event
  select r.id, r.status, r.qty, left(coalesce(nullif(btrim(v.name), ''), nullif(btrim(r.label), ''), 'Vendor'), 200) as label into b
    from public.event_resources r left join public.vendors v on v.id = r.vendor_id and v.org_id = v_org
   where r.id = p_booking and r.quote_id = p_quote and r.org_id = v_org;
  if b.id is null then raise exception 'This vendor is not on the event any more.' using errcode = 'P0002'; end if;
  if b.status in ('cancelled', 'enquiry') then raise exception 'This vendor is not booked for the event.' using errcode = '22023', hint = 'r444_not_booked'; end if;
  if p_id is not null then
    select * into n from public.event_wrap_records w where w.id = p_id;
    if n.id is not null then
      if n.org_id is distinct from v_org or n.quote_id is distinct from p_quote or n.ref_id is distinct from p_booking then raise exception 'not allowed' using errcode = '42501'; end if;
      return jsonb_build_object('ok', true, 'same', true, 'item', public._r444_item(n));
    end if;
  end if;
  select * into cur from public.event_wrap_records w where w.quote_id = p_quote and w.org_id = v_org and w.part = 'vendor' and w.ref_id = p_booking order by w.seq desc limit 1;
  if cur.id is distinct from p_seen then return jsonb_build_object('ok', false, 'changed', true, 'item', public._r444_item(cur)); end if;
  if p_state = 'undo' then
    if cur.id is null or cur.state = 'undo' then return jsonb_build_object('ok', true, 'same', true, 'item', public._r444_item(cur)); end if;
    v_note := null;
  elsif b.qty is not null and b.qty > 0 then
    v_total := b.qty; v_back := case when p_state = 'returned' then b.qty else p_qty_back end;
    if v_back is not null and (v_back < 0 or v_back > v_total or v_back <> trunc(v_back, 2)) then raise exception 'Between 0 and % were handed back.', trim(to_char(v_total, 'FM999999990.##'), '.') using errcode = '22023', hint = 'r444_qty'; end if;
  end if;
  if (select count(*) from public.event_wrap_records w where w.quote_id = p_quote) >= 2000 then raise exception 'Too many changes on this event.' using errcode = '22023', hint = 'r444_full'; end if;
  insert into public.event_wrap_records (id, org_id, quote_id, part, ref_id, label, state, qty_total, qty_back, note, by_user, by_name)
  values (coalesce(p_id, gen_random_uuid()), v_org, p_quote, 'vendor', p_booking, b.label, p_state, v_total, v_back, v_note, auth.uid(), public._r442_name())
  returning * into n;
  return jsonb_build_object('ok', true, 'item', public._r444_item(n));
end $fn$;

-- a note with a stock problem (damaged / missing / still out): the right to mark that stock back (0374)
create or replace function public.stock_return_note(p_checkout uuid, p_note text, p_id uuid default null)
returns jsonb language plpgsql volatile security definer set search_path = '' as $fn$
-- r258-0444
declare v_org uuid := public.current_org_id(); c record; v_note text := public._r444_note(p_note); n public.event_wrap_records; v_item text;
begin
  if auth.uid() is null or v_org is null then raise exception 'not allowed' using errcode = '42501'; end if;
  select x.id, x.quote_id, x.item_id, x.status into c from public.inventory_checkouts x where x.id = p_checkout and x.org_id = v_org;
  if c.id is null then raise exception 'check-out not found' using errcode = '42501'; end if;
  if not (coalesce(public.has_area('inventory', 'edit'), false) or (c.quote_id is not null and coalesce(public.has_area('command', 'edit'), false))) then raise exception 'not allowed' using errcode = '42501'; end if;
  if c.quote_id is null then raise exception 'This stock is not out for an event.' using errcode = '22023', hint = 'r444_no_event'; end if;
  if c.status = 'cancelled' then raise exception 'This was cancelled - nothing to note.' using errcode = '22023'; end if;
  if v_note is null then raise exception 'Type the note.' using errcode = '22023', hint = 'r444_note'; end if;
  if p_id is not null then
    select * into n from public.event_wrap_records w where w.id = p_id;
    if n.id is not null then
      if n.org_id is distinct from v_org or n.ref_id is distinct from p_checkout then raise exception 'not allowed' using errcode = '42501'; end if;
      return jsonb_build_object('ok', true, 'same', true, 'item', public._r444_item(n));
    end if;
  end if;
  if (select count(*) from public.event_wrap_records w where w.quote_id = c.quote_id) >= 2000 then raise exception 'Too many notes on this event.' using errcode = '22023', hint = 'r444_full'; end if;
  select left(i.name, 200) into v_item from public.inventory_items i where i.id = c.item_id and i.org_id = v_org;
  insert into public.event_wrap_records (id, org_id, quote_id, part, ref_id, label, state, note, by_user, by_name)
  values (coalesce(p_id, gen_random_uuid()), v_org, c.quote_id, 'stock', c.id, v_item, 'note', v_note, auth.uid(), public._r442_name())
  returning * into n;
  return jsonb_build_object('ok', true, 'item', public._r444_item(n));
end $fn$;

-- ---- 4) grants ---------------------------------------------------------------------------------------------------------------
do $$ declare f text; r text; begin
  foreach f in array array['public._r444_item(public.event_wrap_records)', 'public._r444_note(text)'] loop
    execute format('revoke all on function %s from public', f);
    foreach r in array array['anon', 'authenticated'] loop
      if exists (select 1 from pg_roles where rolname = r) then execute format('revoke all on function %s from %I', f, r); end if;
    end loop;
  end loop;
  foreach f in array array['public.event_wrap_records_get(uuid)', 'public.event_vendor_return_set(uuid,uuid,text,text,numeric,uuid,uuid)', 'public.stock_return_note(uuid,text,uuid)'] loop
    execute format('revoke all on function %s from public', f);
    if exists (select 1 from pg_roles where rolname = 'anon') then execute format('revoke all on function %s from anon', f); end if;
    foreach r in array array['authenticated', 'service_role'] loop
      if exists (select 1 from pg_roles where rolname = r) then execute format('grant execute on function %s to %I', f, r); end if;
    end loop;
  end loop;
end $$;

do $$ begin
  if to_regclass('public.helm_schema_markers') is not null then
    insert into public.helm_schema_markers(num, name) values (444, '0444_r258_wrap_records') on conflict (num) do nothing;
  end if;
end $$;

notify pgrst, 'reload schema';

-- ---- 5) CHECK (read only): every row must say true ---------------------------------------------------------------------------
select c.check, c.ok from (values
  ('01 the table is there, row security on, no direct access', (select bool_and(c.relrowsecurity and not has_table_privilege('authenticated', c.oid, 'select,insert,update,delete') and not has_table_privilege('anon', c.oid, 'select,insert,update,delete'))
      from pg_class c where c.oid = 'public.event_wrap_records'::regclass)),
  ('02 a record always belongs to its event''s studio', to_regprocedure('public.tg_quote_org_match()') is null
      or exists (select 1 from pg_trigger where tgname = 'zz_quote_org_match' and tgrelid = 'public.event_wrap_records'::regclass)),
  ('03 signed-in people only', has_function_privilege('authenticated', 'public.event_vendor_return_set(uuid,uuid,text,text,numeric,uuid,uuid)', 'execute')
      and not has_function_privilege('anon', 'public.event_vendor_return_set(uuid,uuid,text,text,numeric,uuid,uuid)', 'execute')
      and not has_function_privilege('anon', 'public.event_wrap_records_get(uuid)', 'execute') and not has_function_privilege('anon', 'public.stock_return_note(uuid,text,uuid)', 'execute')),
  ('04 helpers are server only', not has_function_privilege('authenticated', 'public._r444_item(public.event_wrap_records)', 'execute') and not has_function_privilege('authenticated', 'public._r444_note(text)', 'execute')),
  ('05 search_path pinned on all five', (select count(*) = 5 and bool_and(coalesce(p.proconfig @> array['search_path=""'], false)) from pg_proc p where p.pronamespace = 'public'::regnamespace
      and p.proname in ('_r444_item', '_r444_note', 'event_wrap_records_get', 'event_vendor_return_set', 'stock_return_note'))),
  ('06 the rights are asked for in the database', position('has_area(''command'', ''edit'')' in pg_get_functiondef('public.event_vendor_return_set(uuid,uuid,text,text,numeric,uuid,uuid)'::regprocedure)) > 0
      and position('has_area(''inventory'', ''edit'')' in pg_get_functiondef('public.stock_return_note(uuid,text,uuid)'::regprocedure)) > 0),
  ('07 the free-trial clean-up knows the table', to_regprocedure('public._tr184_purge_tables()') is null or position('event_wrap_records' in pg_get_functiondef('public._tr184_purge_tables()'::regprocedure)) > 0)
) c("check", ok);
