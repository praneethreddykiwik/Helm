-- 0397_r227_event_plan_lock.sql - CANONICAL forward-only. R227 (owner, 18 Nov 2026: "Event day - add planner 2D, 3D, measure,
-- and can print. Add a lock so no modifications - you need to unlock and then edit it.").
-- REQUIRES base quotes / quote_versions / event_tasks / run_sheet_items / event_plan / profiles, has_area + current_org_id
--          (phase29 / 57), 0265 (_r23_tz, _r23_parse_time), 0385 (_r385_can_assign), 0396 (event_day_plans, _r396_event).
--
-- In plain words:
--   1  The event's PLAN can be locked for the event day: the floor plan (layout versions), the hall / venue sizes, the
--      run-sheet, the task plan (names, times, durations, "needs first", order) and Venue opens / Ready by.
--   2  It locks by itself once the event reaches "On the day" (1 hour before the first thing on the event day, studio clock,
--      or midnight when nothing has a time) or the Event Day / Settlement / Closed stage, for a CONFIRMED event. Anyone who
--      can change quotes or give out tasks can also press "Lock plan" any time after the event is confirmed.
--   3  Unlock needs Quotes - Can change (admin / event manager) and a short reason (3-300 characters). Every lock and
--      unlock is kept with who, when and why (event_plan_lock_log, never changed or deleted by the app) and shows in the
--      event's activity trail.
--   4  The DATABASE refuses plan changes while locked (guard triggers, a clear "plan_locked" message), whoever sends them
--      and from whichever page. The day itself keeps working: task status (accept / start / done / cancel), reassigning a
--      crew member, check-ins, proof photos, issues, reminders, the Day-before ticks, settlement, teardown and closure.
--   5  event_floor_get(quote): the saved floor plan for the event-day screens and the printed pack - the item shapes,
--      the hall size, guests and the venue. NO money (prices are stripped from every item).
--
-- Access: reading = Staff - Can see or Quotes - Can see (same studio only); lock = Quotes - Can change or "Assign & send
-- tasks" (0385); unlock = Quotes - Can change + a reason.
--
-- ZERO DATA LOSS: additive + idempotent. Two new tables, new functions, guard triggers that only REFUSE a change (they never
-- write), event_activity wrapped once (old body kept as event_activity__pre0397), the free-trial retention list (0184) learns
-- the new tables (patched in place once, like 0396). Nothing dropped, nothing deleted, no row changed. Safe to run twice.
-- Test switch: the setting helm.r397_plan_lock = off turns the guard off for one session (the older local test suites; never
-- set by the app). ASCII only.

-- ---- 0) preflight -----------------------------------------------------------------------------------------------------
do $$ begin
  if to_regclass('public.quotes') is null or to_regclass('public.quote_versions') is null or to_regclass('public.event_tasks') is null
     or to_regclass('public.run_sheet_items') is null or to_regclass('public.profiles') is null then
    raise exception 'STOP 0397: quotes / quote_versions / event_tasks / run_sheet_items / profiles missing'; end if;
  if to_regprocedure('public.has_area(text,text)') is null or to_regprocedure('public.current_org_id()') is null then
    raise exception 'STOP 0397: has_area / current_org_id missing (phase29 / phase57)'; end if;
  if to_regprocedure('public._r23_tz(uuid)') is null or to_regprocedure('public._r23_parse_time(text)') is null then
    raise exception 'STOP 0397: run 0265 first (_r23_tz / _r23_parse_time)'; end if;
  if to_regprocedure('public._r385_can_assign()') is null then
    raise exception 'STOP 0397: run 0385 first (_r385_can_assign)'; end if;
  if to_regclass('public.event_day_plans') is null or to_regprocedure('public._r396_event(uuid)') is null then
    raise exception 'STOP 0397: run 0396 first (event_day_plans / _r396_event)'; end if;
  if to_regprocedure('public.event_activity(uuid)') is null then
    raise exception 'STOP 0397: event_activity(uuid) missing'; end if;
end $$;

-- ---- 1) the lock (one row per event) + the lock / unlock record -----------------------------------------------------------
create table if not exists public.event_plan_locks (
  quote_id     uuid primary key references public.quotes(id) on delete cascade,
  org_id       uuid not null references public.organizations(id),
  state        text not null,
  during_auto  boolean not null default false,
  reason       text,
  changed_at   timestamptz not null default now(),
  changed_by   uuid,
  constraint event_plan_locks_state_chk397 check (state in ('locked', 'unlocked')),
  constraint event_plan_locks_reason_chk397 check (reason is null or char_length(reason) <= 300)
);
create table if not exists public.event_plan_lock_log (
  id           uuid primary key default gen_random_uuid(),
  quote_id     uuid not null references public.quotes(id) on delete cascade,
  org_id       uuid not null references public.organizations(id),
  action       text not null,
  auto_active  boolean not null default false,
  reason       text,
  by_user      uuid,
  by_name      text,
  created_at   timestamptz not null default now(),
  constraint event_plan_lock_log_action_chk397 check (action in ('lock', 'unlock')),
  constraint event_plan_lock_log_reason_chk397 check (reason is null or char_length(reason) <= 300),
  constraint event_plan_lock_log_name_chk397 check (by_name is null or char_length(by_name) <= 120)
);
create index if not exists event_plan_lock_log_quote397 on public.event_plan_lock_log (quote_id, created_at desc);

-- server only: the pages read and write through the calls below
do $$ declare t text; begin
  foreach t in array array['event_plan_locks', 'event_plan_lock_log'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on table public.%I from public', t);
    if exists (select 1 from pg_roles where rolname = 'anon') then execute format('revoke all on table public.%I from anon', t); end if;
    if exists (select 1 from pg_roles where rolname = 'authenticated') then execute format('revoke all on table public.%I from authenticated', t); end if;
    if exists (select 1 from pg_roles where rolname = 'service_role') then execute format('grant select on table public.%I to service_role', t); end if;
    if to_regprocedure('public.tg_quote_org_match()') is not null then
      execute format('drop trigger if exists zz_quote_org_match on public.%I', t);
      execute format('create trigger zz_quote_org_match before insert or update on public.%I for each row execute function public.tg_quote_org_match()', t);
    end if;
    if to_regprocedure('public.tg_studio_read_only()') is not null
       and not exists (select 1 from pg_catalog.pg_trigger where tgname = 'zzz_studio_read_only' and tgrelid = ('public.' || t)::regclass) then
      execute format('create trigger zzz_studio_read_only before insert or update or delete on public.%I for each row execute function public.tg_studio_read_only(''org_id'')', t);
    end if;
  end loop;
end $$;

-- ---- 2) helpers ----------------------------------------------------------------------------------------------------------
-- the guard applies to signed-in requests (directly or through a page call); the session switch is for local tests only
create or replace function public._r397_enforce()
returns boolean language sql stable security definer set search_path = '' as $fn$
  -- r227-0397
  select coalesce(current_setting('helm.r397_plan_lock', true), '') <> 'off' and auth.uid() is not null;
$fn$;

-- locked by itself: a confirmed event in the Event Day / Settlement / Closed stage, or from "On the day" on the studio's clock
-- (1 hour before the first thing on the event day - a run-sheet line, a task start that day, guests arrive - else midnight)
create or replace function public._r397_auto(p_quote uuid)
returns boolean language plpgsql stable security definer set search_path = '' as $fn$
-- r227-0397 (the same rule as HelmTaskStatus.opsMode on the pages)
declare q record; v_tz text; v_day0 timestamptz; v_day1 timestamptz; v_first timestamptz; t time;
begin
  select qq.org_id, qq.status, qq.lifecycle_stage, qq.event_date, qq.event_time into q from public.quotes qq where qq.id = p_quote;
  if q.org_id is null or coalesce(q.status, '') <> 'confirmed' then return false; end if;
  if coalesce(q.lifecycle_stage, '') in ('event_day', 'settlement', 'closed') then return true; end if;
  if q.event_date is null then return false; end if;
  v_tz := public._r23_tz(q.org_id);
  v_day0 := (q.event_date::timestamp) at time zone v_tz;
  v_day1 := ((q.event_date + 1)::timestamp) at time zone v_tz;
  begin t := public._r23_parse_time(q.event_time); exception when others then t := null; end;
  v_first := least(
    (select min((q.event_date + r.start_time) at time zone v_tz) from public.run_sheet_items r where r.quote_id = p_quote and r.start_time is not null),
    (select min(k.planned_start) from public.event_tasks k where k.quote_id = p_quote and k.status <> 'cancelled'
        and k.planned_start >= v_day0 and k.planned_start < v_day1),
    case when t is not null then (q.event_date + t) at time zone v_tz end);
  return now() >= coalesce(v_first - interval '1 hour', v_day0);
end $fn$;

-- is the plan locked right now? a manual lock wins; an unlock made while the automatic lock applied keeps it open until
-- someone locks again; an unlock made earlier stops counting once the event reaches "On the day". A cancelled event never is.
create or replace function public._r397_locked(p_quote uuid)
returns boolean language plpgsql stable security definer set search_path = '' as $fn$
-- r227-0397
declare l record; v_status text;
begin
  select q.status into v_status from public.quotes q where q.id = p_quote;
  if v_status is null or v_status = 'cancelled' then return false; end if;
  select x.state, x.during_auto into l from public.event_plan_locks x where x.quote_id = p_quote;
  if l.state = 'locked' then return true; end if;
  if l.state = 'unlocked' and l.during_auto then return false; end if;
  return public._r397_auto(p_quote);
end $fn$;

-- refuse a plan change on a locked event (signed-in requests only)
create or replace function public._r397_guard(p_quote uuid, p_what text)
returns void language plpgsql stable security definer set search_path = '' as $fn$
-- r227-0397
begin
  if p_quote is null or not public._r397_enforce() then return; end if;
  if public._r397_locked(p_quote) then
    raise exception 'plan_locked: the event plan is locked for the event day, so the % cannot be changed. Unlock the plan first (admin or event manager, with a reason).', p_what
      using errcode = 'P0001', hint = 'Tasks & Crew or the Event-day monitor -> Unlock.';
  end if;
end $fn$;

-- ---- 3) guard triggers (they only refuse; they never write) -----------------------------------------------------------------
-- floor plan: every layout version save / change / removal
create or replace function public._r397_tg_versions()
returns trigger language plpgsql security definer set search_path = '' as $fn$
-- r227-0397
begin
  perform public._r397_guard(case when tg_op = 'DELETE' then old.quote_id else new.quote_id end, 'floor plan');
  return case when tg_op = 'DELETE' then old else new end;
end $fn$;

-- the quote row: which layout version is current + the hall / venue sizes (measurements). Money, stage, status, client
-- details and everything else stay open (their own locks decide).
create or replace function public._r397_tg_quote()
returns trigger language plpgsql security definer set search_path = '' as $fn$
-- r227-0397
begin
  if new.current_version is distinct from old.current_version then perform public._r397_guard(old.id, 'floor plan'); end if;
  if (new.client -> 'hallLen', new.client -> 'hallWid', new.client -> 'venueLen', new.client -> 'venueWid')
     is distinct from (old.client -> 'hallLen', old.client -> 'hallWid', old.client -> 'venueLen', old.client -> 'venueWid') then
    perform public._r397_guard(old.id, 'hall size');
  end if;
  return new;
end $fn$;

-- the task plan: new tasks and the plan columns (name, group, order, times, buffer, duration, "needs first"). Status, the
-- person, notes, proof, verification, reminders and cancel stay open. A crew member claiming an open shift (0265) is staffing,
-- not the plan, so that task may still be added.
create or replace function public._r397_tg_tasks()
returns trigger language plpgsql security definer set search_path = '' as $fn$
-- r227-0397
begin
  if tg_op = 'INSERT' then
    if not (new.seq = 900 and new.title like 'Shift: %' and coalesce(new.note, '') like 'Claimed from an open shift%') then
      perform public._r397_guard(new.quote_id, 'task plan');
    end if;
    return new;
  elsif tg_op = 'DELETE' then
    perform public._r397_guard(old.quote_id, 'task plan');
    return old;
  end if;
  if (new.quote_id, new.title, new.category, new.seq, new.planned_start, new.planned_end, new.buffer_min, new.depends_on, new.duration_min)
     is distinct from (old.quote_id, old.title, old.category, old.seq, old.planned_start, old.planned_end, old.buffer_min, old.depends_on, old.duration_min) then
    perform public._r397_guard(old.quote_id, 'task plan');
  end if;
  return new;
end $fn$;

-- the run-sheet: every line, except its reminder switches
create or replace function public._r397_tg_runsheet()
returns trigger language plpgsql security definer set search_path = '' as $fn$
-- r227-0397
begin
  if tg_op = 'INSERT' then perform public._r397_guard(new.quote_id, 'run-sheet'); return new; end if;
  if tg_op = 'DELETE' then perform public._r397_guard(old.quote_id, 'run-sheet'); return old; end if;
  if (to_jsonb(new) - array['remind', 'remind_offsets', 'remind_group', 'assign_changed_at'])
     is distinct from (to_jsonb(old) - array['remind', 'remind_offsets', 'remind_group', 'assign_changed_at']) then
    perform public._r397_guard(old.quote_id, 'run-sheet');
  end if;
  return new;
end $fn$;

-- Venue opens / Ready by (the Day-before ticks stay open)
create or replace function public._r397_tg_dayplan()
returns trigger language plpgsql security definer set search_path = '' as $fn$
-- r227-0397
begin
  if tg_op = 'INSERT' then
    if new.venue_access is not null or new.ready_by is not null then perform public._r397_guard(new.quote_id, 'Venue opens / Ready by times'); end if;
  elsif (new.venue_access, new.ready_by) is distinct from (old.venue_access, old.ready_by) then
    perform public._r397_guard(old.quote_id, 'Venue opens / Ready by times');
  end if;
  return new;
end $fn$;

do $$ begin
  if not exists (select 1 from pg_trigger where tgname = 'zz_r397_plan_lock' and tgrelid = 'public.quote_versions'::regclass) then
    create trigger zz_r397_plan_lock before insert or update or delete on public.quote_versions for each row execute function public._r397_tg_versions();
  end if;
  if not exists (select 1 from pg_trigger where tgname = 'zz_r397_plan_lock' and tgrelid = 'public.quotes'::regclass) then
    create trigger zz_r397_plan_lock before update of current_version, client on public.quotes for each row execute function public._r397_tg_quote();
  end if;
  if not exists (select 1 from pg_trigger where tgname = 'zz_r397_plan_lock' and tgrelid = 'public.event_tasks'::regclass) then
    create trigger zz_r397_plan_lock before insert or update or delete on public.event_tasks for each row execute function public._r397_tg_tasks();
  end if;
  if not exists (select 1 from pg_trigger where tgname = 'zz_r397_plan_lock' and tgrelid = 'public.run_sheet_items'::regclass) then
    create trigger zz_r397_plan_lock before insert or update or delete on public.run_sheet_items for each row execute function public._r397_tg_runsheet();
  end if;
  if not exists (select 1 from pg_trigger where tgname = 'zz_r397_plan_lock' and tgrelid = 'public.event_day_plans'::regclass) then
    create trigger zz_r397_plan_lock before insert or update on public.event_day_plans for each row execute function public._r397_tg_dayplan();
  end if;
end $$;

-- ---- 4) the page calls ---------------------------------------------------------------------------------------------------
-- the event, if the caller may READ its plan (Staff - Can see or Quotes - Can see, same studio)
create or replace function public._r397_read(p_quote uuid)
returns uuid language plpgsql stable security definer set search_path = '' as $fn$
-- r227-0397
declare v_org uuid;
begin
  v_org := public._r396_event(p_quote);
  if not (coalesce(public.has_area('staff', 'view'), false) or coalesce(public.has_area('quotes', 'view'), false)) then
    raise exception 'not allowed' using errcode = '42501'; end if;
  return v_org;
end $fn$;

-- the lock state for the pages: locked?, why, who may lock / unlock, the last 20 lock / unlock records
create or replace function public.event_plan_lock_get(p_quote uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $fn$
-- r227-0397
declare v_org uuid; l record; q record; v_auto boolean; v_can_unlock boolean;
begin
  v_org := public._r397_read(p_quote);
  select qq.status, qq.lifecycle_stage into q from public.quotes qq where qq.id = p_quote;
  select x.state, x.during_auto, x.reason, x.changed_at, x.changed_by into l from public.event_plan_locks x where x.quote_id = p_quote;
  v_auto := public._r397_auto(p_quote);
  v_can_unlock := coalesce(public.has_area('quotes', 'edit'), false);
  return jsonb_build_object(
    'v', 1,
    'locked', public._r397_locked(p_quote),
    'auto', v_auto,
    'state', l.state,
    'reason', l.reason,
    'changed_at', l.changed_at,
    'changed_by', public._sa54_name(l.changed_by),
    'confirmed', coalesce(q.status, '') = 'confirmed',
    'stage', q.lifecycle_stage,
    'can_lock', coalesce(q.status, '') = 'confirmed' and (v_can_unlock or coalesce(public._r385_can_assign(), false)),
    'can_unlock', v_can_unlock,
    'history', coalesce((select jsonb_agg(jsonb_build_object('action', g.action, 'auto', g.auto_active, 'reason', g.reason, 'by', g.by_name, 'at', g.created_at) order by g.created_at desc)
                           from (select * from public.event_plan_lock_log z where z.quote_id = p_quote and z.org_id = v_org order by z.created_at desc limit 20) g), '[]'::jsonb));
end $fn$;

-- lock (p_lock true; a reason is optional) or unlock (p_lock false; a reason of 3-300 characters is required)
create or replace function public.event_plan_lock_set(p_quote uuid, p_lock boolean, p_reason text)
returns jsonb language plpgsql volatile security definer set search_path = '' as $fn$
-- r227-0397
declare v_org uuid; v_status text; v_reason text := nullif(left(btrim(coalesce(p_reason, '')), 300), ''); v_auto boolean; v_name text;
begin
  v_org := public._r396_event(p_quote);
  if p_lock is null then raise exception 'invalid' using errcode = '22023'; end if;
  select q.status into v_status from public.quotes q where q.id = p_quote;
  v_name := left(coalesce(public._sa54_name(auth.uid()), (select split_part(p.email, '@', 1) from public.profiles p where p.id = auth.uid()), 'someone'), 120);
  -- one change at a time per event
  perform pg_catalog.pg_advisory_xact_lock(hashtextextended('r397:' || p_quote::text, 0));
  v_auto := public._r397_auto(p_quote);
  if p_lock then
    if not (coalesce(public.has_area('quotes', 'edit'), false) or coalesce(public._r385_can_assign(), false)) then
      raise exception 'not allowed' using errcode = '42501'; end if;
    if coalesce(v_status, '') <> 'confirmed' then raise exception 'not_confirmed: lock the plan once the event is confirmed' using errcode = 'P0001'; end if;
    if exists (select 1 from public.event_plan_locks x where x.quote_id = p_quote and x.state = 'locked') then return public.event_plan_lock_get(p_quote); end if;
    insert into public.event_plan_locks (quote_id, org_id, state, during_auto, reason, changed_at, changed_by)
    values (p_quote, v_org, 'locked', v_auto, v_reason, now(), auth.uid())
    on conflict (quote_id) do update set state = 'locked', during_auto = excluded.during_auto, reason = excluded.reason, changed_at = now(), changed_by = auth.uid();
    insert into public.event_plan_lock_log (quote_id, org_id, action, auto_active, reason, by_user, by_name, created_at)
    values (p_quote, v_org, 'lock', v_auto, v_reason, auth.uid(), v_name, clock_timestamp());
  else
    if not coalesce(public.has_area('quotes', 'edit'), false) then raise exception 'not allowed' using errcode = '42501'; end if;
    if v_reason is null or char_length(v_reason) < 3 then raise exception 'reason_required: say why the plan is being unlocked (3-300 characters)' using errcode = 'P0001'; end if;
    if not public._r397_locked(p_quote) then return public.event_plan_lock_get(p_quote); end if;
    insert into public.event_plan_locks (quote_id, org_id, state, during_auto, reason, changed_at, changed_by)
    values (p_quote, v_org, 'unlocked', v_auto, v_reason, now(), auth.uid())
    on conflict (quote_id) do update set state = 'unlocked', during_auto = excluded.during_auto, reason = excluded.reason, changed_at = now(), changed_by = auth.uid();
    insert into public.event_plan_lock_log (quote_id, org_id, action, auto_active, reason, by_user, by_name, created_at)
    values (p_quote, v_org, 'unlock', v_auto, v_reason, auth.uid(), v_name, clock_timestamp());
  end if;
  return public.event_plan_lock_get(p_quote);
end $fn$;

-- the saved floor plan for the event-day screens + the printed pack. No money: every item keeps only its shape, kind, label
-- and colour; price-like properties are dropped.
create or replace function public.event_floor_get(p_quote uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $fn$
-- r227-0397
declare v_org uuid; q record; v record; p record; v_items jsonb;
begin
  v_org := public._r397_read(p_quote);
  select qq.current_version, qq.client, qq.event_date, qq.event_time, qq.code, qq.title into q from public.quotes qq where qq.id = p_quote;
  select x.version_no, x.data, x.created_at into v from public.quote_versions x
   where x.quote_id = p_quote and x.version_no = coalesce(q.current_version, 1);
  if v.version_no is null then
    select x.version_no, x.data, x.created_at into v from public.quote_versions x where x.quote_id = p_quote order by x.version_no desc limit 1;
  end if;
  select coalesce((select jsonb_agg(jsonb_strip_nulls(jsonb_build_object(
             'id', left(it ->> 'id', 60), 'type', left(it ->> 'type', 40), 'category', left(it ->> 'category', 30), 'label', left(it ->> 'label', 80),
             'x', it -> 'x', 'y', it -> 'y', 'width', it -> 'width', 'height', it -> 'height', 'rotation', it -> 'rotation',
             'color', case when (it ->> 'color') ~ '^#[0-9A-Fa-f]{3,8}$' then it ->> 'color' end,
             'properties', (select jsonb_object_agg(k.key, k.value) from jsonb_each(case when jsonb_typeof(it -> 'properties') = 'object' then it -> 'properties' else '{}'::jsonb end) k
                             where k.key !~* '(price|cost|rate|amount|total|money|fee|charge)' and jsonb_typeof(k.value) in ('number', 'string', 'boolean'))))
           order by o.n)
           from jsonb_array_elements(case when jsonb_typeof(v.data -> 'items') = 'array' then v.data -> 'items' else '[]'::jsonb end) with ordinality o(it, n)
          where jsonb_typeof(it) = 'object' and o.n <= 1500), '[]'::jsonb) into v_items;
  select e.venue_name, e.venue_address, e.venue_contact, e.access_notes into p from public.event_plan e where e.quote_id = p_quote;
  return jsonb_build_object(
    'v', 1,
    'version_no', v.version_no,
    'saved_at', v.created_at,
    'items', v_items,
    'world', case when jsonb_typeof(v.data -> 'scale' -> 'worldFt') = 'object' then jsonb_build_object('w', v.data -> 'scale' -> 'worldFt' -> 'w', 'h', v.data -> 'scale' -> 'worldFt' -> 'h') end,
    'margins', case when jsonb_typeof(v.data -> 'margins') = 'object' then jsonb_build_object('left', v.data -> 'margins' -> 'left', 'right', v.data -> 'margins' -> 'right',
                      'top', v.data -> 'margins' -> 'top', 'bottom', v.data -> 'margins' -> 'bottom') end,
    'unit', case when v.data -> 'grid' ->> 'unit' = 'm' then 'm' else 'ft' end,
    'capacity', case when jsonb_typeof(v.data -> 'venue' -> 'capacity') = 'number' then v.data -> 'venue' -> 'capacity' end,
    'hall', jsonb_build_object('len', q.client -> 'hallLen', 'wid', q.client -> 'hallWid', 'venue_len', q.client -> 'venueLen', 'venue_wid', q.client -> 'venueWid'),
    'guests', case when (q.client ->> 'guests') ~ '^[0-9]{1,6}$' then (q.client ->> 'guests')::integer end,
    'venue', jsonb_build_object('name', left(coalesce(nullif(btrim(p.venue_name), ''), q.client ->> 'venue'), 200),
                                'address', left(coalesce(nullif(btrim(p.venue_address), ''), concat_ws(', ', nullif(btrim(q.client ->> 'address'), ''), nullif(btrim(q.client ->> 'city'), ''))), 400),
                                'contact', left(p.venue_contact, 200), 'access_notes', left(p.access_notes, 1000)),
    'event', jsonb_build_object('code', q.code, 'title', q.title, 'date', q.event_date, 'time', q.event_time),
    'lock', public.event_plan_lock_get(p_quote));
end $fn$;

-- ---- 5) the event's activity trail shows every lock / unlock (event_activity wrapped once, old body kept) --------------------
do $$ begin
  if to_regprocedure('public.event_activity__pre0397(uuid)') is null then
    alter function public.event_activity(uuid) rename to event_activity__pre0397;
  end if;
end $$;
create or replace function public.event_activity(p_quote uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $fn$
-- r227-0397: the trail before 0397 (event_activity__pre0397: studio + area checks) + the plan lock / unlock lines
declare v jsonb; v_org uuid := public.current_org_id(); v_add jsonb;
begin
  v := public.event_activity__pre0397(p_quote);
  if v is null or jsonb_typeof(v) <> 'array' or v_org is null then return v; end if;
  select coalesce(jsonb_agg(jsonb_build_object('at', g.created_at, 'kind', 'plan_lock',
           'text', left(case when g.action = 'lock' then 'Event plan locked for the event day by ' else 'Event plan unlocked by ' end
                        || coalesce(g.by_name, 'someone') || coalesce(': ' || g.reason, ''), 600))), '[]'::jsonb)
    into v_add from public.event_plan_lock_log g where g.quote_id = p_quote and g.org_id = v_org;
  if jsonb_array_length(v_add) = 0 then return v; end if;
  return (select jsonb_agg(a order by a ->> 'at' desc) from jsonb_array_elements(v || v_add) a);
end $fn$;

-- ---- 6) grants ----------------------------------------------------------------------------------------------------------------
do $$ declare f text; begin
  foreach f in array array['public._r397_enforce()', 'public._r397_auto(uuid)', 'public._r397_locked(uuid)', 'public._r397_guard(uuid,text)',
                           'public._r397_tg_versions()', 'public._r397_tg_quote()', 'public._r397_tg_tasks()', 'public._r397_tg_runsheet()',
                           'public._r397_tg_dayplan()', 'public._r397_read(uuid)', 'public.event_activity__pre0397(uuid)'] loop
    execute format('revoke all on function %s from public', f);
    if exists (select 1 from pg_roles where rolname = 'anon') then execute format('revoke all on function %s from anon', f); end if;
    if exists (select 1 from pg_roles where rolname = 'authenticated') then execute format('revoke all on function %s from authenticated', f); end if;
  end loop;
  foreach f in array array['public.event_plan_lock_get(uuid)', 'public.event_plan_lock_set(uuid,boolean,text)', 'public.event_floor_get(uuid)',
                           'public.event_activity(uuid)'] loop
    execute format('revoke all on function %s from public', f);
    if exists (select 1 from pg_roles where rolname = 'anon') then execute format('revoke all on function %s from anon', f); end if;
    if exists (select 1 from pg_roles where rolname = 'authenticated') then execute format('grant execute on function %s to authenticated', f); end if;
    if exists (select 1 from pg_roles where rolname = 'service_role') then execute format('grant execute on function %s to service_role', f); end if;
  end loop;
end $$;

-- ---- 7) free-trial retention (0184): the lock rows go with the studio's events ---------------------------------------------
do $$ declare v_def text; begin
  if to_regprocedure('public._tr184_purge_tables()') is not null then
    v_def := pg_get_functiondef('public._tr184_purge_tables()'::regprocedure);
    if position('''event_plan_locks''' in v_def) = 0 then
      if (length(v_def) - length(replace(v_def, '''event_day_plans'', ''task_evidence_grants''', ''))) / length('''event_day_plans'', ''task_evidence_grants''') <> 1 then
        raise notice '0397: _tr184_purge_tables has an unexpected body - left unchanged';
      else execute replace(v_def, '''event_day_plans'', ''task_evidence_grants''', '''event_day_plans'', ''event_plan_lock_log'', ''event_plan_locks'', ''task_evidence_grants'''); end if;
    end if;
  end if;
end $$;
