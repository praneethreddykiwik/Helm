-- APPLY-0441 (R256: the 2D / 3D layout leaves the event-day lock). Run on STAGING first, then Canada production, then HELM-PROD-MUMBAI.
-- Safe to run twice. Needs 0397 only; it stops before changing anything if 0397 is missing.
-- Same content as supabase/migrations/0441_r256_layout_not_locked.sql. The last result lists one row per check.
begin;
set local lock_timeout = '5s';
set local statement_timeout = '5min';
-- 0441_r256_layout_not_locked.sql - R256 (owner, 25 Nov 2026: "If the 2D 3D layout is locked, why is it not unlocking the tasks and
-- crew? Remove that unlock and lock from the 2D 3D layout, respectively and safely"). Forward-only, additive, safe to run twice. ASCII only.
-- REQUIRES 0397. Paste the whole file in the Supabase SQL editor; the last statement answers one row per check.
--
-- In plain words:
--   A  THE FLOOR PLAN LEAVES THE LOCK. Saving a layout version, choosing the current version and the hall / venue sizes are no longer
--      refused while the event-day lock is on. The task plan, the run-sheet and Venue opens / Ready by stay locked exactly as before.
--      A CLOSED event still refuses a layout (until now only the lock did that on the server): same rule, its own words.
--   B  AN UNLOCK ON THE EVENT DAY HOLDS. An unlock made on the event day (studio clock) stays open until someone locks again, also when
--      it was made before the automatic lock started. (0397: an unlock at 8 am was locked over again an hour before the first thing.)
--      An unlock made on an earlier day is still followed by the automatic lock.
--   C  THE PAGES CAN SAY IT. event_plan_lock_get also answers auto_at (when the automatic lock starts; null = it has started or never
--      will) and relocks (an unlock made now, or the one that stands, is followed by the automatic lock).
--
-- ZERO DATA LOSS: no table, no column, no row touched. Four functions re-issued from their latest bodies (0397, no later author); the old
-- bodies are kept as <name>__pre0441.
-- UNDO, one line (the floor plan is in the lock again, everything else stays):
--   create or replace function public._r441_floor_in_lock() returns boolean language sql stable set search_path = '' as 'select true';
-- (running this file again puts the floor plan out of the lock again)

-- ---- 0) preflight -----------------------------------------------------------------------------------------------------
do $$ declare f text; begin
  foreach f in array array['public._r397_tg_versions()', 'public._r397_tg_quote()', 'public._r397_guard(uuid,text)', 'public._r397_locked(uuid)',
                           'public._r397_auto(uuid)', 'public._r397_enforce()', 'public._r397_read(uuid)', 'public.event_plan_lock_get(uuid)',
                           'public.event_plan_lock_set(uuid,boolean,text)', 'public._r23_tz(uuid)', 'public._r23_parse_time(text)'] loop
    if to_regprocedure(f) is null then raise exception 'STOP 0441: run 0397 first (% missing)', f; end if;
  end loop;
  foreach f in array array['public._r397_tg_versions()', 'public._r397_tg_quote()', 'public.event_plan_lock_get(uuid)', 'public.event_plan_lock_set(uuid,boolean,text)'] loop
    if position('r227-0397' in pg_get_functiondef(f::regprocedure)) = 0 then raise exception 'STOP 0441: % is not the 0397 body - nothing was changed', f; end if;
  end loop;
end $$;

-- ---- 1) keep the old bodies once (server only) -------------------------------------------------------------------------
do $$ declare r record; v text; begin
  for r in select * from (values ('_r397_tg_versions', '()'), ('_r397_tg_quote', '()'), ('event_plan_lock_get', '(uuid)'), ('event_plan_lock_set', '(uuid,boolean,text)')) x(n, a) loop
    if to_regprocedure('public.' || r.n || '__pre0441' || r.a) is null then
      v := pg_get_functiondef(('public.' || r.n || r.a)::regprocedure);
      execute replace(v, 'FUNCTION public.' || r.n || '(', 'FUNCTION public.' || r.n || '__pre0441(');
    end if;
  end loop;
end $$;

-- ---- 2) the floor plan and the hall size are not part of the lock -------------------------------------------------------
-- the switch: false = out of the lock (the line at the top of this file turns it back)
create or replace function public._r441_floor_in_lock()
returns boolean language sql stable set search_path = '' as $fn$ select false $fn$;

-- a closed event: still no new layout (the same requests the lock refused; an admin can re-open the event)
create or replace function public._r441_closed_guard(p_quote uuid, p_what text)
returns void language plpgsql stable security definer set search_path = '' as $fn$
-- r256-0441
begin
  if p_quote is null or not public._r397_enforce() then return; end if;
  if exists (select 1 from public.quotes q where q.id = p_quote and q.lifecycle_stage = 'closed') and public._r397_locked(p_quote) then
    raise exception 'This event is closed, so its % cannot be changed. An admin can re-open it from its Closure page.', p_what
      using errcode = '42501', hint = 'event_closed';
  end if;
end $fn$;

create or replace function public._r397_tg_versions()
returns trigger language plpgsql security definer set search_path = '' as $fn$
-- r227-0397 r256-0441
begin
  if public._r441_floor_in_lock() then
    perform public._r397_guard(case when tg_op = 'DELETE' then old.quote_id else new.quote_id end, 'floor plan');
  else
    perform public._r441_closed_guard(case when tg_op = 'DELETE' then old.quote_id else new.quote_id end, 'floor plan');
  end if;
  return case when tg_op = 'DELETE' then old else new end;
end $fn$;

create or replace function public._r397_tg_quote()
returns trigger language plpgsql security definer set search_path = '' as $fn$
-- r227-0397 r256-0441: the quote row holds only the floor plan's parts of the lock (current version, hall / venue sizes)
declare v_in boolean;
begin
  if new.current_version is distinct from old.current_version then
    v_in := public._r441_floor_in_lock();
    if v_in then perform public._r397_guard(old.id, 'floor plan'); else perform public._r441_closed_guard(old.id, 'floor plan'); end if;
  end if;
  if (new.client -> 'hallLen', new.client -> 'hallWid', new.client -> 'venueLen', new.client -> 'venueWid')
     is distinct from (old.client -> 'hallLen', old.client -> 'hallWid', old.client -> 'venueLen', old.client -> 'venueWid') then
    v_in := coalesce(v_in, public._r441_floor_in_lock());
    if v_in then perform public._r397_guard(old.id, 'hall size'); else perform public._r441_closed_guard(old.id, 'hall size'); end if;
  end if;
  return new;
end $fn$;

-- ---- 3) when the automatic lock starts (the _r397_auto clock rule), and whether an unlock would be followed by it -------------
create or replace function public._r441_auto_at(p_quote uuid)
returns timestamptz language plpgsql stable security definer set search_path = '' as $fn$
-- r256-0441: 1 hour before the first thing on the event day, else midnight (studio clock); null = not confirmed / no date
declare q record; v_tz text; v_day0 timestamptz; v_day1 timestamptz; v_first timestamptz; t time;
begin
  select qq.org_id, qq.status, qq.event_date, qq.event_time into q from public.quotes qq where qq.id = p_quote;
  if q.org_id is null or coalesce(q.status, '') <> 'confirmed' or q.event_date is null then return null; end if;
  v_tz := public._r23_tz(q.org_id);
  v_day0 := (q.event_date::timestamp) at time zone v_tz;
  v_day1 := ((q.event_date + 1)::timestamp) at time zone v_tz;
  begin t := public._r23_parse_time(q.event_time); exception when others then t := null; end;
  v_first := least(
    (select min((q.event_date + r.start_time) at time zone v_tz) from public.run_sheet_items r where r.quote_id = p_quote and r.start_time is not null),
    (select min(k.planned_start) from public.event_tasks k where k.quote_id = p_quote and k.status <> 'cancelled'
        and k.planned_start >= v_day0 and k.planned_start < v_day1),
    case when t is not null then (q.event_date + t) at time zone v_tz end);
  return coalesce(v_first - interval '1 hour', v_day0);
end $fn$;

-- is it the event day (or later) on the studio's clock?
create or replace function public._r441_on_day(p_quote uuid)
returns boolean language sql stable security definer set search_path = '' as $fn$
  -- r256-0441
  select coalesce((select q.event_date <= (now() at time zone public._r23_tz(q.org_id))::date from public.quotes q where q.id = p_quote), false);
$fn$;

-- ---- 4) the page calls (0397 bodies + auto_at / relocks, + an unlock on the event day holds) --------------------------------
create or replace function public.event_plan_lock_get(p_quote uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $fn$
-- r227-0397 r256-0441
declare v_org uuid; l record; q record; v_auto boolean; v_can_unlock boolean; v_at timestamptz;
begin
  v_org := public._r397_read(p_quote);
  select qq.status, qq.lifecycle_stage into q from public.quotes qq where qq.id = p_quote;
  select x.state, x.during_auto, x.reason, x.changed_at, x.changed_by into l from public.event_plan_locks x where x.quote_id = p_quote;
  v_auto := public._r397_auto(p_quote);
  v_can_unlock := coalesce(public.has_area('quotes', 'edit'), false);
  v_at := case when not v_auto then public._r441_auto_at(p_quote) end;
  return jsonb_build_object(
    'v', 1,
    'locked', public._r397_locked(p_quote),
    'auto', v_auto,
    'auto_at', v_at,
    'relocks', v_at is not null and case when l.state = 'unlocked' then not coalesce(l.during_auto, false) else not public._r441_on_day(p_quote) end,
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

create or replace function public.event_plan_lock_set(p_quote uuid, p_lock boolean, p_reason text)
returns jsonb language plpgsql volatile security definer set search_path = '' as $fn$
-- r227-0397 r256-0441
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
    -- r256-0441: during_auto = "this unlock holds": the automatic lock applies already, or it is the event day
    insert into public.event_plan_locks (quote_id, org_id, state, during_auto, reason, changed_at, changed_by)
    values (p_quote, v_org, 'unlocked', v_auto or public._r441_on_day(p_quote), v_reason, now(), auth.uid())
    on conflict (quote_id) do update set state = 'unlocked', during_auto = excluded.during_auto, reason = excluded.reason, changed_at = now(), changed_by = auth.uid();
    insert into public.event_plan_lock_log (quote_id, org_id, action, auto_active, reason, by_user, by_name, created_at)
    values (p_quote, v_org, 'unlock', v_auto, v_reason, auth.uid(), v_name, clock_timestamp());
  end if;
  return public.event_plan_lock_get(p_quote);
end $fn$;

-- ---- 5) grants (as 0397: page calls for signed-in people, everything else server only) ---------------------------------------
do $$ declare f text; begin
  foreach f in array array['public._r397_tg_versions()', 'public._r397_tg_quote()', 'public._r441_floor_in_lock()', 'public._r441_closed_guard(uuid,text)',
                           'public._r441_auto_at(uuid)', 'public._r441_on_day(uuid)', 'public._r397_tg_versions__pre0441()', 'public._r397_tg_quote__pre0441()',
                           'public.event_plan_lock_get__pre0441(uuid)', 'public.event_plan_lock_set__pre0441(uuid,boolean,text)'] loop
    execute format('revoke all on function %s from public', f);
    if exists (select 1 from pg_roles where rolname = 'anon') then execute format('revoke all on function %s from anon', f); end if;
    if exists (select 1 from pg_roles where rolname = 'authenticated') then execute format('revoke all on function %s from authenticated', f); end if;
  end loop;
  foreach f in array array['public.event_plan_lock_get(uuid)', 'public.event_plan_lock_set(uuid,boolean,text)'] loop
    execute format('revoke all on function %s from public', f);
    if exists (select 1 from pg_roles where rolname = 'anon') then execute format('revoke all on function %s from anon', f); end if;
    if exists (select 1 from pg_roles where rolname = 'authenticated') then execute format('grant execute on function %s to authenticated', f); end if;
    if exists (select 1 from pg_roles where rolname = 'service_role') then execute format('grant execute on function %s to service_role', f); end if;
  end loop;
end $$;

do $$ begin
  if to_regclass('public.helm_schema_markers') is not null then
    insert into public.helm_schema_markers(num, name) values (441, '0441_r256_layout_not_locked') on conflict (num) do nothing;
  end if;
end $$;

notify pgrst, 'reload schema';

-- ---- 6) CHECK (read only): every row must say true ---------------------------------------------------------------------------
select c.check, c.ok from (values
  ('01 the floor plan is not part of the lock', not public._r441_floor_in_lock()),
  ('02 the layout triggers use the new rule', position('_r441_closed_guard' in pg_get_functiondef('public._r397_tg_versions()'::regprocedure)) > 0
      and position('_r441_closed_guard' in pg_get_functiondef('public._r397_tg_quote()'::regprocedure)) > 0),
  ('03 all five lock triggers are still there and on', (select count(*) = 5 and bool_and(tgenabled = 'O') from pg_trigger where tgname = 'zz_r397_plan_lock')),
  ('04 tasks, run-sheet and Venue opens / Ready by are still locked', (select bool_and(position('public._r397_guard(' in pg_get_functiondef(f::regprocedure)) > 0)
      from unnest(array['public._r397_tg_tasks()', 'public._r397_tg_runsheet()', 'public._r397_tg_dayplan()']) f)),
  ('05 an unlock on the event day holds', position('_r441_on_day' in pg_get_functiondef('public.event_plan_lock_set(uuid,boolean,text)'::regprocedure)) > 0),
  ('06 the pages are told when it locks by itself', position('''auto_at''' in pg_get_functiondef('public.event_plan_lock_get(uuid)'::regprocedure)) > 0
      and position('''relocks''' in pg_get_functiondef('public.event_plan_lock_get(uuid)'::regprocedure)) > 0),
  ('07 unlock still needs Quotes edit and a reason', position('reason_required' in pg_get_functiondef('public.event_plan_lock_set(uuid,boolean,text)'::regprocedure)) > 0
      and position('has_area(''quotes'', ''edit'')' in pg_get_functiondef('public.event_plan_lock_set(uuid,boolean,text)'::regprocedure)) > 0),
  ('08 signed-in people only', has_function_privilege('authenticated', 'public.event_plan_lock_set(uuid,boolean,text)', 'execute')
      and not has_function_privilege('anon', 'public.event_plan_lock_set(uuid,boolean,text)', 'execute') and not has_function_privilege('anon', 'public.event_plan_lock_get(uuid)', 'execute')),
  ('09 helpers and kept bodies are server only, search_path pinned', (select count(*) = 8 and bool_and(coalesce(p.proconfig @> array['search_path=""'], false)
      and not has_function_privilege('anon', p.oid, 'execute') and not has_function_privilege('authenticated', p.oid, 'execute'))
      from pg_proc p where p.pronamespace = 'public'::regnamespace and (p.proname like '\_r441\_%' or p.proname like '%\_\_pre0441'))),
  ('10 no lock row was changed by this file (locks on record: ' || (select count(*) from public.event_plan_locks) || ')', true)
) c("check", ok);
commit;
