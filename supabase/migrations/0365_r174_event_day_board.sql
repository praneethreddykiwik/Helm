-- 0365_r174_event_day_board.sql - R174 (owner, 16 Nov 2026: "the worker marked a day they cannot work but nothing shows on the
-- dashboard; how do I see the progress on the event day; add an ongoing events tracker on the home page").
-- REQUIRES 0161/0163 (crew_schedule), 0198 (_a198_org_today), 0265 (crew_availability, crew_checkins, _r23_tz).
--
-- What it does, in plain words:
--   1  crew_schedule: the day of a task is now worked out in the STUDIO time zone (it used UTC, so in India a task between
--      midnight and 5:29 AM showed on the previous day). Same columns, same rules, same grants.
--   2  live_events_today(p_hours): one call for the home page card and the Calendar "Live today" tab. Events happening today
--      or in the next p_hours (studio time), each with task progress: total, waiting for a yes, accepted, started, done,
--      turned down, late (start time passed and not started), staff counts, who checked in today, the next start time,
--      the latest activity and up to 6 late tasks. Office people only (Staff, Calendar or Quotes view), own studio only.
--   3  crew_unavailable_conflicts(from, to): people who are given work on a day they marked "cannot work" (for the
--      Calendar conflicts list). Staff view only, own studio only, at most 92 days.
--
-- ZERO DATA LOSS: functions only (one replaced with the same signature, two new). No table, no column, no row changed.
-- Safe to run twice. ASCII only.

-- ---- 0) preflight ---------------------------------------------------------------------------------------------------
do $$
begin
  if to_regprocedure('public.crew_schedule(date,date,uuid)') is null then raise exception 'STOP 0365: run 0161 / 0163 (crew schedule) first'; end if;
  if to_regprocedure('public._r23_tz(uuid)') is null or to_regclass('public.crew_availability') is null or to_regclass('public.crew_checkins') is null then
    raise exception 'STOP 0365: run 0265 (crew availability and check-in) first'; end if;
  if to_regprocedure('public._a198_org_today(uuid)') is null then raise exception 'STOP 0365: run 0198 first'; end if;
  if to_regprocedure('public.has_area(text,text)') is null or to_regprocedure('public.current_org_id()') is null then
    raise exception 'STOP 0365: has_area / current_org_id missing'; end if;
end $$;

-- ---- 1) crew_schedule: the task day in the studio time zone ------------------------------------------------------------
create or replace function public.crew_schedule(p_from date, p_to date, p_staff uuid default null)
returns table (
  crew_id uuid, crew_name text, crew_role text, department text,
  quote_id uuid, event_code text, event_title text, event_date date, event_time text,
  venue_name text, task_id uuid, task_title text, category text, status text,
  planned_start timestamptz, planned_end timestamptz, sched_date date
)
language plpgsql stable security definer set search_path = '' as $$
#variable_conflict use_column
-- crew-schedule-0161 / r174-0365: schedule fields only, no client / money fields, ever; the day is the studio day
declare
  v_org uuid := public.current_org_id();
  v_role text;
  v_team boolean := false;
  v_tz text;
begin
  if auth.uid() is null or v_org is null then raise exception 'not authorized' using errcode = '42501'; end if;
  if p_from is null or p_to is null or p_to < p_from then raise exception 'invalid date range' using errcode = '22023'; end if;
  if p_to - p_from > 62 then raise exception 'date range too long (max 62 days)' using errcode = '22023'; end if;
  v_tz := coalesce(nullif(public._r23_tz(v_org), ''), 'Asia/Kolkata');
  select lower(coalesce(pr.role, '')) into v_role from public.profiles pr where pr.id = auth.uid() and pr.org_id = v_org;
  v_team := coalesce(v_role, '') not in ('crew', 'worker')
            and (public.has_area('staff', 'view') or public.has_area('calendar', 'view'));
  return query
    select cm.id, cm.name, cm.role, cm.department,
           q.id, q.code, q.title, q.event_date, q.event_time,
           ep.venue_name, t.id, t.title, t.category, t.status,
           t.planned_start, t.planned_end,
           coalesce((t.planned_start at time zone v_tz)::date, q.event_date) as sched_date
      from public.event_tasks t
      join public.crew_members cm on cm.id = t.crew_id and cm.org_id = v_org
      join public.quotes q on q.id = t.quote_id and q.org_id = v_org and q.deleted_at is null
      left join public.event_plan ep on ep.quote_id = q.id and ep.org_id = v_org
     where t.org_id = v_org
       and coalesce(t.status, '') <> 'cancelled'
       and coalesce(q.status, '') not in ('cancelled', 'lost')
       and coalesce((t.planned_start at time zone v_tz)::date, q.event_date) between p_from and p_to
       and (case when v_team then (p_staff is null or t.crew_id = p_staff)
                 else t.crew_id in (select public._a153_my_crew_ids())
                      and (p_staff is null or t.crew_id = p_staff) end)
     order by 17, t.planned_start nulls last, cm.name, t.seq;
end $$;

-- ---- 2) live_events_today: progress of the events happening now / today / in the next hours --------------------------------
create or replace function public.live_events_today(p_hours integer default 24)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
-- r174-0365
declare
  v_org uuid := public.current_org_id();
  v_role text;
  v_tz text;
  v_now timestamptz := now();
  v_today date;
  v_h integer := least(greatest(coalesce(p_hours, 24), 1), 72);
  v_until timestamptz;
  v_events jsonb;
begin
  if auth.uid() is null or v_org is null then raise exception 'not authorized' using errcode = '42501'; end if;
  select lower(coalesce(pr.role, '')) into v_role from public.profiles pr where pr.id = auth.uid() and pr.org_id = v_org;
  if coalesce(v_role, '') in ('crew', 'worker')
     or not (public.has_area('staff', 'view') or public.has_area('calendar', 'view') or public.has_area('quotes', 'view')) then
    raise exception 'not authorized' using errcode = '42501'; end if;
  v_tz := coalesce(nullif(public._r23_tz(v_org), ''), 'Asia/Kolkata');
  v_today := public._a198_org_today(v_org);
  v_until := v_now + make_interval(hours => v_h);

  with ev as (
    select q.id, q.code, q.title, q.event_date, q.event_time, q.status, ep.venue_name
      from public.quotes q
      left join public.event_plan ep on ep.quote_id = q.id and ep.org_id = v_org
     where q.org_id = v_org and q.deleted_at is null
       and coalesce(q.status, '') not in ('cancelled', 'lost')
       and coalesce(q.lifecycle_stage, '') not in ('closed', 'cancelled', 'archived')
       and ( q.event_date between v_today and (v_until at time zone v_tz)::date
             or exists (select 1 from public.event_tasks t2
                         where t2.quote_id = q.id and t2.org_id = v_org
                           and coalesce(t2.status, '') not in ('cancelled', 'rejected', 'completed')
                           and t2.planned_start between v_now - interval '12 hours' and v_until) )
  ), tk as (
    select t.quote_id, t.id, t.title, t.category, t.status, t.crew_id, coalesce(cm.name, t.assignee_name) as who,
           t.planned_start, t.responded_at, t.started_at, t.completed_at,
           (t.status in ('assigned', 'accepted') and t.planned_start is not null and t.planned_start < v_now) as late
      from public.event_tasks t
      join ev on ev.id = t.quote_id
      left join public.crew_members cm on cm.id = t.crew_id and cm.org_id = v_org
     where t.org_id = v_org and coalesce(t.status, '') <> 'cancelled'
  ), act as (
    select x.quote_id, x.at, x.kind, x.who, x.title,
           row_number() over (partition by x.quote_id order by x.at desc) as rn
      from (
        select quote_id, completed_at as at, 'completed' as kind, who, title from tk where completed_at is not null
        union all select quote_id, started_at, 'started', who, title from tk where started_at is not null
        union all select quote_id, responded_at, case when status = 'rejected' then 'rejected' else 'accepted' end, who, title
                    from tk where responded_at is not null
      ) x
  )
  select coalesce(jsonb_agg(e.j order by e.first_at nulls last, e.event_date, e.code), '[]'::jsonb) into v_events
    from (
      select ev.event_date, ev.code,
             (select min(planned_start) from tk where tk.quote_id = ev.id) as first_at,
             jsonb_build_object(
               'quote_id', ev.id, 'code', ev.code, 'title', ev.title, 'event_date', ev.event_date, 'event_time', ev.event_time,
               'status', ev.status, 'venue', ev.venue_name,
               'is_today', ev.event_date = v_today,
               'total', (select count(*) from tk where tk.quote_id = ev.id),
               'unassigned', (select count(*) from tk where tk.quote_id = ev.id and (tk.status = 'unassigned' or tk.crew_id is null and tk.who is null)),
               'waiting', (select count(*) from tk where tk.quote_id = ev.id and tk.status = 'assigned'),
               'accepted', (select count(*) from tk where tk.quote_id = ev.id and tk.status = 'accepted'),
               'started', (select count(*) from tk where tk.quote_id = ev.id and tk.status = 'in_progress'),
               'done', (select count(*) from tk where tk.quote_id = ev.id and tk.status = 'completed'),
               'rejected', (select count(*) from tk where tk.quote_id = ev.id and tk.status = 'rejected'),
               'late', (select count(*) from tk where tk.quote_id = ev.id and tk.late),
               'staff', (select count(distinct tk.crew_id) from tk where tk.quote_id = ev.id and tk.crew_id is not null),
               'staff_confirmed', (select count(distinct tk.crew_id) from tk where tk.quote_id = ev.id and tk.crew_id is not null
                                     and tk.status in ('accepted', 'in_progress', 'completed')),
               'checked_in', (select count(distinct c.crew_id) from public.crew_checkins c
                               where c.quote_id = ev.id and c.org_id = v_org and c.work_day = v_today),
               'first_start', (select min(planned_start) from tk where tk.quote_id = ev.id),
               'next_start', (select min(planned_start) from tk where tk.quote_id = ev.id and tk.planned_start >= v_now
                                and tk.status in ('assigned', 'accepted')),
               'last', (select jsonb_build_object('at', a.at, 'kind', a.kind, 'who', a.who, 'title', a.title)
                          from act a where a.quote_id = ev.id and a.rn = 1),
               'late_tasks', coalesce((select jsonb_agg(jsonb_build_object('id', l.id, 'title', l.title, 'who', l.who, 'category', l.category,
                                                                          'status', l.status, 'planned_start', l.planned_start)
                                                       order by l.planned_start)
                                         from (select * from tk where tk.quote_id = ev.id and tk.late order by tk.planned_start limit 6) l), '[]'::jsonb)
             ) as j
        from ev
       order by 3 nulls last, ev.event_date, ev.code
       limit 30
    ) e;

  return jsonb_build_object('now', v_now, 'today', v_today, 'tz', v_tz, 'hours', v_h, 'events', coalesce(v_events, '[]'::jsonb));
end $$;

-- ---- 3) crew_unavailable_conflicts: given work on a day they marked "cannot work" ------------------------------------------
create or replace function public.crew_unavailable_conflicts(p_from date, p_to date)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
-- r174-0365
declare v_org uuid := public.current_org_id(); v_tz text;
begin
  if auth.uid() is null or v_org is null or not public.has_area('staff', 'view') then raise exception 'not authorized' using errcode = '42501'; end if;
  if p_from is null or p_to is null or p_to < p_from or p_to - p_from > 92 then raise exception 'pick a range of up to 92 days' using errcode = '22023'; end if;
  v_tz := coalesce(nullif(public._r23_tz(v_org), ''), 'Asia/Kolkata');
  return coalesce((
    select jsonb_agg(jsonb_build_object('crew_id', x.crew_id, 'name', x.name, 'day', x.day, 'note', x.note, 'events', x.events)
                     order by x.day, x.name)
      from (
        select a.crew_id, cm.name, a.day, a.note,
               jsonb_agg(distinct jsonb_build_object('id', q.id, 'code', q.code)) as events
          from public.crew_availability a
          join public.crew_members cm on cm.id = a.crew_id and cm.org_id = v_org
          join public.event_tasks t on t.crew_id = a.crew_id and t.org_id = v_org
                                   and t.status not in ('rejected', 'cancelled', 'completed')
          join public.quotes q on q.id = t.quote_id and q.org_id = v_org and q.deleted_at is null
                              and coalesce(q.status, '') not in ('cancelled', 'lost')
                              and coalesce(q.lifecycle_stage, '') not in ('closed', 'cancelled', 'archived')
         where a.org_id = v_org and a.status = 'unavailable' and a.day between p_from and p_to
           and coalesce((t.planned_start at time zone v_tz)::date, q.event_date) = a.day
         group by a.crew_id, cm.name, a.day, a.note
      ) x), '[]'::jsonb);
end $$;

-- ---- 4) grants: signed-in office staff only (each function checks the studio and the role inside) ------------------------------
do $$
declare f text;
begin
  foreach f in array array['public.crew_schedule(date,date,uuid)', 'public.live_events_today(integer)',
                           'public.crew_unavailable_conflicts(date,date)'] loop
    execute format('revoke all on function %s from public', f);
    if exists (select 1 from pg_roles where rolname = 'anon') then execute format('revoke all on function %s from anon', f); end if;
    if exists (select 1 from pg_roles where rolname = 'authenticated') then execute format('grant execute on function %s to authenticated', f); end if;
  end loop;
end $$;

-- VERIFY every line should say true
select item, ok from (values
  ('01 schedule day in the studio time zone', position('r174-0365' in coalesce(pg_get_functiondef(to_regprocedure('public.crew_schedule(date,date,uuid)')), '')) > 0
     and position('UTC' in coalesce(pg_get_functiondef(to_regprocedure('public.crew_schedule(date,date,uuid)')), '')) = 0),
  ('02 live board call for signed-in staff only', coalesce(has_function_privilege('authenticated', 'public.live_events_today(integer)', 'execute')
     and not has_function_privilege('anon', 'public.live_events_today(integer)', 'execute'), false)),
  ('03 unavailable-day conflicts for signed-in staff only', coalesce(has_function_privilege('authenticated', 'public.crew_unavailable_conflicts(date,date)', 'execute')
     and not has_function_privilege('anon', 'public.crew_unavailable_conflicts(date,date)', 'execute'), false)),
  ('04 schedule still closed to anon', not has_function_privilege('anon', 'public.crew_schedule(date,date,uuid)', 'execute'))
) v(item, ok) order by item;
