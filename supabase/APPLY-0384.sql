-- APPLY-0384 (R206 prod API log 17-18 Nov 2026: statement timeouts on the check-in times call). Run on STAGING first, then production. Safe to run twice.
-- event_timesheet gives the same answer with work bounded by the event (was: work for every staff member of the studio on every call).
-- Five additive indexes. runsheet_group_status is not changed. Who may call what is unchanged. Nothing dropped or deleted.
-- Big audit_log or event_tasks (hundreds of thousands of rows)? Run APPLY-0384-CONCURRENT.sql first, one line at a time, then this file.
-- Paste the whole file into the Supabase SQL editor and press Run. The last result lists checks - every ok must be true.
begin;
-- 0384_r206_api_timeouts.sql - R206 (prod API log 17-18 Nov 2026). Forward-only, additive, safe to run twice. ASCII only.
-- REQUIRES 0265 (event_timesheet, crew_checkins, open_shifts, open_shift_claims, event_checkin_sites, _r23_tz,
--          _r23_parse_time), 0274 + 0371 (_r25_crew_cfg = the crew settings reader), 0198 (_a198_org_today).
--
-- In plain words:
--   The production API log showed two statement timeout errors (HTTP 500, Postgres 57014): event_timesheet (the
--   check-in times on Tasks & Crew / Event-day monitor / Ops board) and runsheet_group_status (the run-sheet page).
--   1  event_timesheet did work for EVERY staff member of the studio on every call: for each person in the studio it
--      ran three lookups to see whether they are on this event, then for each person on the event it read their
--      check-ins five separate times and worked out their expected start through a helper that read the event, the
--      studio and the studio time zone again. Monitor and Tasks & Crew ask for it every 30 seconds for every event of
--      the day, so on the small production database a busy moment pushed it past the 8 second limit.
--      Now it starts from the people on THIS event only (tasks, approved shift claims, arrivals, check-ins of this
--      event - the same four sources as before), reads the check-ins of each person once, and works out the expected start
--      in one pass with the time zone read once. The answer is the same, key for key (the DB test compares it with the
--      old body on a seeded studio). Who may call it is unchanged (staff or command VIEW, own studio only).
--      The old body is kept once as event_timesheet__pre0384 (no app privilege) so it can be put back.
--   2  runsheet_group_status itself is two index lookups (about 25 page reads) - it was not slow, it timed out in the
--      same minutes as event_timesheet because the whole database was busy. It is not changed.
--   3  Indexes (create index if not exists - additive, no row touched):
--        event_tasks (quote_id, crew_id)            - the tasks of one person on one event (check-ins, crew link, reminders)
--        event_day (quote_id, ref_id, updated_at)   - the latest arrival mark of one person on one event
--        open_shift_claims (crew_id)                - the claims of a staff member (and deleting a staff member)
--        event_task_log (crew_id)                   - the task history of a staff member (and deleting a staff member)
--        audit_log (org_id, at desc, id desc)       - home Recent activity / Audit log, newest first for one studio
--                                                     (was: walk the whole log newest first and skip other studios)
--      For a big audit_log run APPLY-0384-CONCURRENT.sql first (one line at a time) - then these lines are no-ops.
--
-- Changes: five indexes, one function re-issued in place (same input, same output, same grants), one old body kept.
-- No table, column, policy, grant or row is created for the app, changed or deleted.
-- Undo (only if ever needed, no data involved): drop function public.event_timesheet(uuid), then
--   alter function public.event_timesheet__pre0384(uuid) rename to event_timesheet, then grant execute on it to authenticated.

-- ---- 0) preflight ---------------------------------------------------------------------------------------------------------------
do $$ begin
  if to_regprocedure('public.event_timesheet(uuid)') is null or to_regclass('public.crew_checkins') is null
     or to_regclass('public.open_shift_claims') is null or to_regclass('public.open_shifts') is null
     or to_regclass('public.event_checkin_sites') is null or to_regprocedure('public._r23_tz(uuid)') is null
     or to_regprocedure('public._r23_parse_time(text)') is null then
    raise exception 'STOP 0384: apply 0265 (crew check-ins and shifts) first'; end if;
  if to_regprocedure('public._r25_crew_cfg(uuid)') is null then raise exception 'STOP 0384: apply 0274 and 0371 first'; end if;
  if to_regprocedure('public._a198_org_today(uuid)') is null then raise exception 'STOP 0384: apply 0198 first'; end if;
  if to_regclass('public.event_task_log') is null or to_regclass('public.event_day') is null or to_regclass('public.audit_log') is null then
    raise exception 'STOP 0384: event_task_log / event_day / audit_log missing'; end if;
end $$;

-- ---- 1) indexes -----------------------------------------------------------------------------------------------------------------
create index if not exists ix_event_tasks_quote_crew_0384 on public.event_tasks (quote_id, crew_id) where crew_id is not null;
create index if not exists ix_event_day_arrival_ref_0384 on public.event_day (quote_id, ref_id, updated_at desc) where kind = 'arrival';
create index if not exists ix_open_shift_claims_crew_0384 on public.open_shift_claims (crew_id);
create index if not exists ix_event_task_log_crew_0384 on public.event_task_log (crew_id) where crew_id is not null;
create index if not exists ix_audit_log_org_at_id_0384 on public.audit_log (org_id, at desc, id desc);

-- ---- 2) keep the live body once (server only) -------------------------------------------------------------------------------------
do $$
declare v_def text;
begin
  if to_regprocedure('public.event_timesheet__pre0384(uuid)') is null then
    v_def := pg_get_functiondef('public.event_timesheet(uuid)'::regprocedure);
    if position('r206-0384' in v_def) = 0 then
      execute replace(v_def, 'FUNCTION public.event_timesheet(', 'FUNCTION public.event_timesheet__pre0384(');
    end if;
  end if;
  if to_regprocedure('public.event_timesheet__pre0384(uuid)') is not null then
    execute 'revoke all on function public.event_timesheet__pre0384(uuid) from public';
    if exists (select 1 from pg_roles where rolname = 'anon') then execute 'revoke all on function public.event_timesheet__pre0384(uuid) from anon'; end if;
    if exists (select 1 from pg_roles where rolname = 'authenticated') then execute 'revoke all on function public.event_timesheet__pre0384(uuid) from authenticated'; end if;
  end if;
end $$;

-- ---- 3) event_timesheet: the same answer, bounded by this event ------------------------------------------------------------------
create or replace function public.event_timesheet(p_quote uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
-- r23-crew-0265: times + hours + late / no-show flags (no pay - that is the ledger, admin only)
-- r206-0384: same answer as the 0265 / 0371 body (kept as event_timesheet__pre0384), the work is bounded by this event -
--   only the people on this event (tasks, approved shift claims, arrivals, check-ins), their check-ins read once, the
--   expected start (= _r23_expected_start) worked out inline with the studio time zone read once.
declare v_org uuid := public.current_org_id(); v_tz text; v_cfg jsonb; v_today date; q record; v_site record; v_rows jsonb;
        v_grace int; v_noshow int; v_evt time; v_evt_at timestamptz;
begin
  if auth.uid() is null or v_org is null or not (public.has_area('staff', 'view') or public.has_area('command', 'view')) then
    raise exception 'not authorized' using errcode = '42501'; end if;
  select qq.id, qq.event_date, qq.event_time into q from public.quotes qq where qq.id = p_quote and qq.org_id = v_org;
  if q.id is null then raise exception 'no such event' using errcode = 'P0002'; end if;
  v_tz := public._r23_tz(v_org); v_cfg := public._r25_crew_cfg(v_org); v_today := public._a198_org_today(v_org);
  v_grace := (v_cfg ->> 'lateGraceMin')::int; v_noshow := (v_cfg ->> 'noShowAfterMin')::int;
  v_evt := public._r23_parse_time(q.event_time);
  if v_evt is not null and q.event_date is not null then v_evt_at := (q.event_date + v_evt) at time zone v_tz; end if;
  select s.lat, s.lng, s.radius_m into v_site from public.event_checkin_sites s where s.quote_id = p_quote and s.org_id = v_org;
  select coalesce(jsonb_agg(jsonb_build_object(
      'crew_id', x.id, 'name', x.name, 'department', x.department, 'roster', x.roster,
      'expected_start', to_char(x.exp at time zone v_tz, 'HH24:MI'),
      'entries', x.entries,
      'hours', x.hours,
      'flag', case when x.n_in > 0 and x.max_late > v_grace then 'late'
                   when x.n_in > 0 then null
                   when x.roster = 'no_show' then 'no_show'
                   when x.roster in ('arrived', 'left') then null
                   when x.exp is not null and now() > x.exp + make_interval(mins => v_noshow) then 'no_show_suspected'
                   end,
      'late_min', x.max_late) order by x.name, x.id), '[]'::jsonb)
    into v_rows
  from (
    select y.id, y.name, y.department, y.roster, y.n_in, y.max_late, y.hours, y.entries,
           coalesce(least(
             (select min((s.shift_date + s.start_time) at time zone v_tz)
                from public.open_shift_claims c join public.open_shifts s on s.id = c.shift_id
               where c.quote_id = p_quote and c.crew_id = y.id and c.status = 'approved' and s.shift_date = y.day and s.start_time is not null),
             (select min(tk.planned_start) from public.event_tasks tk
               where tk.quote_id = p_quote and tk.crew_id = y.id and tk.status not in ('rejected', 'cancelled')
                 and tk.planned_start is not null and (tk.planned_start at time zone v_tz)::date = y.day)),
             case when q.event_date = y.day then v_evt_at end) as exp
    from (
      select cm.id, cm.name, cm.department,
             (select d.status from public.event_day d where d.quote_id = p_quote and d.org_id = v_org and d.kind = 'arrival' and d.ref_id = cm.id
               order by d.updated_at desc limit 1) as roster,
             coalesce(k.first_day, q.event_date) as day,
             coalesce(k.n_in, 0) as n_in, k.max_late, k.hours, coalesce(k.entries, '[]'::jsonb) as entries
        from (select t.crew_id as id from public.event_tasks t
               where t.quote_id = p_quote and t.crew_id is not null and t.status not in ('rejected', 'cancelled')
              union select c.crew_id from public.open_shift_claims c where c.quote_id = p_quote and c.status = 'approved'
              union select d.ref_id from public.event_day d where d.quote_id = p_quote and d.kind = 'arrival' and d.ref_id is not null
              union select k.crew_id from public.crew_checkins k where k.quote_id = p_quote) e
        join public.crew_members cm on cm.id = e.id and cm.org_id = v_org
        left join (
          select k.crew_id, count(*) as n_in, max(k.late_min) as max_late, min(k.work_day) as first_day,
                 round((sum(extract(epoch from (k.check_out_at - k.check_in_at)) / 3600.0) filter (where k.check_out_at is not null))::numeric, 2) as hours,
                 jsonb_agg(jsonb_build_object('id', k.id, 'day', k.work_day,
                   'in', to_char(k.check_in_at at time zone v_tz, 'HH24:MI'), 'out', to_char(k.check_out_at at time zone v_tz, 'HH24:MI'),
                   'in_at', k.check_in_at, 'out_at', k.check_out_at, 'late_min', k.late_min,
                   'distance_m', k.in_distance_m, 'within', k.in_within, 'source', k.source,
                   'edited', k.edited_at is not null, 'edit_note', k.edit_note,
                   'orig_in', to_char(k.orig_check_in_at at time zone v_tz, 'HH24:MI'), 'orig_out', to_char(k.orig_check_out_at at time zone v_tz, 'HH24:MI'))
                   order by k.work_day) as entries
            from public.crew_checkins k where k.quote_id = p_quote group by k.crew_id) k on k.crew_id = cm.id
    ) y
  ) x;
  return jsonb_build_object('rows', v_rows, 'today', v_today, 'event_date', q.event_date,
    'site', case when v_site.lat is not null then jsonb_build_object('lat', v_site.lat, 'lng', v_site.lng, 'radius_m', v_site.radius_m) end,
    'settings', jsonb_build_object('selfCheckin', v_cfg -> 'selfCheckin', 'geofence', v_cfg -> 'geofence', 'geofenceRadiusM', v_cfg -> 'geofenceRadiusM',
                                   'lateGraceMin', v_cfg -> 'lateGraceMin', 'noShowAfterMin', v_cfg -> 'noShowAfterMin', 'payBasis', v_cfg -> 'payBasis'),
    'can_edit', public.has_area('command', 'edit') or public.has_area('staff', 'edit'));
end $$;

-- same privileges as 0265: signed-in staff only (the body re-checks the area and the studio)
do $$ begin
  execute 'revoke all on function public.event_timesheet(uuid) from public';
  if exists (select 1 from pg_roles where rolname = 'anon') then execute 'revoke all on function public.event_timesheet(uuid) from anon'; end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then execute 'grant execute on function public.event_timesheet(uuid) to authenticated'; end if;
  if exists (select 1 from pg_roles where rolname = 'service_role') then execute 'grant execute on function public.event_timesheet(uuid) to service_role'; end if;
end $$;

notify pgrst, 'reload schema';

select item, ok from (values
  ('01 event_timesheet carries the r206-0384 body',
     position('r206-0384' in pg_get_functiondef(to_regprocedure('public.event_timesheet(uuid)'))) > 0
     and position('public._r25_crew_cfg(' in pg_get_functiondef(to_regprocedure('public.event_timesheet(uuid)'))) > 0),
  ('02 the old body is kept once as event_timesheet__pre0384, server only',
     to_regprocedure('public.event_timesheet__pre0384(uuid)') is not null
     and position('r206-0384' in pg_get_functiondef(to_regprocedure('public.event_timesheet__pre0384(uuid)'))) = 0
     and (not exists (select 1 from pg_roles where rolname = 'authenticated')
          or not has_function_privilege('authenticated', 'public.event_timesheet__pre0384(uuid)', 'execute'))
     and (not exists (select 1 from pg_roles where rolname = 'anon')
          or not has_function_privilege('anon', 'public.event_timesheet__pre0384(uuid)', 'execute'))),
  ('03 signed-in staff keep execute, signed-out callers have none',
     (not exists (select 1 from pg_roles where rolname = 'authenticated')
      or has_function_privilege('authenticated', 'public.event_timesheet(uuid)', 'execute'))
     and (not exists (select 1 from pg_roles where rolname = 'anon')
      or not has_function_privilege('anon', 'public.event_timesheet(uuid)', 'execute'))),
  ('04 definer + empty search_path + stable kept',
     (select bool_and(p.prosecdef and p.provolatile = 's' and coalesce(p.proconfig, '{}') @> array['search_path=""']) from pg_proc p
       where p.oid in (to_regprocedure('public.event_timesheet(uuid)'), to_regprocedure('public.event_timesheet__pre0384(uuid)')))),
  ('05 the five indexes exist and are valid',
     (select count(*) from pg_index i join pg_class c on c.oid = i.indexrelid join pg_namespace n on n.oid = c.relnamespace
       where n.nspname = 'public' and i.indisvalid
         and c.relname in ('ix_event_tasks_quote_crew_0384', 'ix_event_day_arrival_ref_0384', 'ix_open_shift_claims_crew_0384',
                           'ix_event_task_log_crew_0384', 'ix_audit_log_org_at_id_0384')) = 5),
  ('06 runsheet_group_status is still there and callable by signed-in staff',
     to_regprocedure('public.runsheet_group_status(uuid)') is not null
     and (not exists (select 1 from pg_roles where rolname = 'authenticated')
          or has_function_privilege('authenticated', 'public.runsheet_group_status(uuid)', 'execute')))
) v(item, ok) order by item;
commit;
