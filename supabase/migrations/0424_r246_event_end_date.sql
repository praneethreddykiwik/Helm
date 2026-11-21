-- 0424_r246_event_end_date.sql - CANONICAL forward-only. R246 (fix plan Phase 9, owner approved 20 Nov 2026; Q-16).
-- REQUIRES 0374 (the event cost ledger _r21_cost_lines). Nothing else.
--
-- In plain words:
--   A quote / event had only ONE date (event_date), so a 3-day wedding showed as one day. Now an event may also have a
--   LAST day: quotes.event_end_date (a new, empty column - null = a one-day event, exactly as before).
--     * The quote form gets an optional "Last day" box; the Events calendar draws the event on every day from the first
--       to the last day.
--     * The event's P&L: the PLANNED wage of a crew member paid by the day (or by the hour) counts every event day
--       (day rate x days) - before, it always counted one day. What really happened is unchanged: crew-link check-ins
--       (days checked in), confirmed wages and the event-day roster still decide the Actual.
--   Rules kept by the database:
--     * the last day can't be before the first day, and an event is at most 60 days long (check, NOT VALID: no old row
--       is checked - every old row has no last day anyway);
--     * moving the first day (calendar drag, date change) moves the last day with it, so the length stays the same;
--       clearing the first day clears the last day;
--     * a closed event's last day can't be changed from the app (re-open it first), like its prices.
--   Not in this file (deferred, fix plan P12): times of day, and venue / crew / stock clashes across several days - clash
--   checks still look at the first day only.
--
-- ZERO DATA LOSS: additive + idempotent. One nullable column (no default, no backfill), one NOT VALID check, one trigger,
-- and the cost ledger wrapped once more (the current body kept as _r21_cost_lines__pre0424; an event without a last day
-- gets that body's answer byte for byte). Nothing is deleted or re-saved.
-- ============================================================================

do $$ begin
  if to_regprocedure('public._r21_cost_lines(uuid,uuid)') is null then
    raise exception '0424: _r21_cost_lines(uuid,uuid) is missing (apply 0246 .. 0374 first)';
  end if;
end $$;

-- 1) the column + its check (NOT VALID: old rows are never checked)
alter table public.quotes add column if not exists event_end_date date;
comment on column public.quotes.event_end_date is
  'r246-0424: the LAST day of a multi-day event (null = a one-day event on event_date). Never before event_date, at most 60 days long.';
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'quotes_event_end_date_chk424' and conrelid = 'public.quotes'::regclass) then
    alter table public.quotes add constraint quotes_event_end_date_chk424
      check (event_end_date is null
             or (event_date is not null and event_end_date >= event_date and event_end_date <= event_date + 60)) not valid;
  end if;
end $$;

-- how many days an event runs (1 for a one-day event or no date). Pure.
create or replace function public.helm_event_days(p_start date, p_end date)
returns integer language sql immutable set search_path = '' as $$
  -- r246-0424: first day .. last day, both counted; null / same / earlier last day = 1; at most 61
  select case when p_start is null or p_end is null or p_end <= p_start then 1
              else least((p_end - p_start) + 1, 61) end;
$$;

-- 2) the last day follows the first day; a closed event's last day stays as it is
create or replace function public._r424_tg_end_date()
returns trigger language plpgsql security definer set search_path = '' as $$
-- r246-0424: moving event_date keeps the length (last day moves too); no first day = no last day; closed event = frozen
begin
  if tg_op = 'UPDATE' and new.event_end_date is not distinct from old.event_end_date
     and new.event_date is distinct from old.event_date and old.event_end_date is not null then
    if new.event_date is null then
      new.event_end_date := null;
    elsif old.event_date is not null then
      new.event_end_date := new.event_date + (old.event_end_date - old.event_date);
    end if;
  end if;
  if tg_op = 'UPDATE' and new.event_end_date is distinct from old.event_end_date
     and new.event_date is not distinct from old.event_date
     and to_regprocedure('public._r282_api_caller()') is not null and to_regprocedure('public._r282_event_closed(uuid)') is not null then
    if public._r282_api_caller() and public._r282_event_closed(new.id) then
      raise exception 'This event is closed - re-open it first (an admin can re-open it from its Closure page).'
        using errcode = '42501', hint = 'event_closed';
    end if;
  end if;
  if new.event_end_date is not null and new.event_end_date = new.event_date then
    new.event_end_date := null;   -- last day = first day is a one-day event
  end if;
  return new;
end $$;
revoke all on function public._r424_tg_end_date() from public;
drop trigger if exists ab_r424_end_date on public.quotes;
create trigger ab_r424_end_date before insert or update of event_date, event_end_date on public.quotes
  for each row execute function public._r424_tg_end_date();

-- 3) the event cost ledger: planned crew wages count every event day (wrap, old body kept)
do $$ declare v_src text; begin
  select p.prosrc into v_src from pg_proc p where p.oid = to_regprocedure('public._r21_cost_lines(uuid,uuid)');
  if position('r246-0424' in coalesce(v_src, '')) = 0 and to_regprocedure('public._r21_cost_lines__pre0424(uuid,uuid)') is null then
    alter function public._r21_cost_lines(uuid, uuid) rename to _r21_cost_lines__pre0424;
  end if;
  if to_regprocedure('public._r21_cost_lines__pre0424(uuid,uuid)') is null then
    raise exception 'STOP 0424: _r21_cost_lines could not be kept as _r21_cost_lines__pre0424';
  end if;
end $$;

create or replace function public._r21_cost_lines(p_quote uuid, p_org uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $fn$
-- r246-0424: wraps the kept ledger (_r21_cost_lines__pre0424 = the r191-inventory-0374 wrapper over r190-0373 / r189-money-0372
-- and the r21-money-0246 / r22-money-0252 / r23-crew-0265 body, crew settings through public._r25_crew_cfg( since 0371), unchanged.
-- One-day event (no event_end_date) = the kept answer byte for byte. A multi-day event: the PLANNED wage of each crew line
-- (estimated, committed, the forecast while nothing actual is known) counts every event day. Actual / confirmed lines unchanged.
declare v jsonb := public._r21_cost_lines__pre0424(p_quote, p_org); n integer;
begin
  if v is null or jsonb_typeof(v) <> 'array' then return v; end if;
  select public.helm_event_days(q.event_date, q.event_end_date) into n
    from public.quotes q where q.id = p_quote and q.org_id = p_org and q.event_end_date is not null;
  if n is null or n <= 1 then return v; end if;
  return coalesce((select jsonb_agg(case
      when e.i ->> 'source' = 'crew' and not (e.i ? 'confirmed_at') and jsonb_typeof(e.i -> 'estimated') = 'number' then
        e.i || jsonb_build_object(
          'estimated', round((e.i ->> 'estimated')::numeric * n, 2),
          'c_est', round(coalesce((e.i ->> 'c_est')::numeric, 0) * n, 2),
          'committed', case when jsonb_typeof(e.i -> 'committed') = 'number' then to_jsonb(round((e.i ->> 'committed')::numeric * n, 2)) else e.i -> 'committed' end,
          'c_com', round(coalesce((e.i ->> 'c_com')::numeric, 0) * n, 2),
          'c_fc', case when jsonb_typeof(e.i -> 'actual') = 'number' or e.i ->> 'attendance' = 'no_show'
                       then e.i -> 'c_fc' else to_jsonb(round(coalesce((e.i ->> 'c_fc')::numeric, 0) * n, 2)) end,
          'event_days', n,
          'note', coalesce(e.i ->> 'note', '') || ' (planned for ' || n || ' event days)')
      else e.i end order by e.o)
    from jsonb_array_elements(v) with ordinality e(i, o)), v);
end $fn$;

revoke all on function public._r21_cost_lines(uuid, uuid) from public;
revoke all on function public._r21_cost_lines__pre0424(uuid, uuid) from public;
revoke all on function public.helm_event_days(date, date) from public;
do $$ declare r text; begin
  foreach r in array array['anon', 'authenticated'] loop
    if exists (select 1 from pg_roles where rolname = r) then
      execute format('revoke all on function public._r21_cost_lines(uuid, uuid) from %I', r);
      execute format('revoke all on function public._r21_cost_lines__pre0424(uuid, uuid) from %I', r);
      execute format('revoke all on function public._r424_tg_end_date() from %I', r);
    end if;
  end loop;
  if exists (select 1 from pg_roles where rolname = 'anon') then
    execute 'revoke all on function public.helm_event_days(date, date) from anon';
  end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    execute 'grant execute on function public.helm_event_days(date, date) to authenticated';
  end if;
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    execute 'grant execute on function public._r21_cost_lines(uuid, uuid) to service_role';
  end if;
end $$;

do $$ begin
  if to_regclass('public.helm_schema_markers') is not null then
    insert into public.helm_schema_markers(num, name) values (424, '0424_r246_event_end_date') on conflict (num) do nothing;
  end if;
end $$;
