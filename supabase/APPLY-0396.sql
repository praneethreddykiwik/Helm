-- APPLY-0396 (R226 event operations v2: Ready by, Day-before checklist, backward schedule, 1-hour + latest-start bell alerts).
-- Run on STAGING first, then production. Safe to run twice. Needs 0265, 0283, 0369 and 0385 first - already on both.
-- What it does: adds "Venue opens" / "Ready by" and the Day-before checklist per event (new table event_day_plans), how long
-- each task takes (new empty column event_tasks.duration_min), studio alert settings and a 5-minute job that puts IN-APP BELL
-- notices only (no e-mail, no WhatsApp) for the event manager + managers / supervisors: "Event starts in 1 hour - ready?
-- 8/10 done", and a reminder / red alert around each set-up job's latest start. Nothing is dropped, deleted or changed.
-- Paste the whole file into the Supabase SQL editor and press Run. The last result lists checks - every ok must be true.
begin;
-- 0396_r226_event_day_plan.sql - CANONICAL forward-only. R226 (owner, 18 Nov 2026: "the day before, event day, everything
-- should be organised properly"; EVENT-OPS-PLAN-V2.md).
-- REQUIRES base quotes / event_tasks / notifications / profiles / crew_members, has_area + current_org_id (phase29 / 57),
--          0265 (_r23_tz, _r23_parse_time), 0369 (task_escalated bell rows only for the people named on them),
--          0385 (_r385_can_assign = "Assign & send tasks").
--
-- In plain words:
--   1  Each event can carry two times for the day: "Venue opens" (when the crew can get in) and "Ready by" (when every
--      set-up job must be finished, e.g. 5 PM for a 6 PM event). Saved in a new table event_day_plans, one row per event.
--   2  The same row keeps the Day-before checklist ticks (vendors called, final head count to the caterer, crew call
--      times, load list, transport, venue access, power, permits, rain plan, run-sheet shared, client confirmed):
--      who ticked it and when. A tick can be taken back; nothing is ever deleted.
--   3  Each task can say how long it takes (event_tasks.duration_min, new, empty = not a timed set-up job). "Needs first"
--      is the dependency the task already has (event_tasks.depends_on, Phase 37) - unchanged.
--   4  Backward schedule: from Ready by, Helm works out each job's LATEST START (its duration + the studio buffer, 15 %
--      by default, before the job that needs it, or before Ready by). _r396_schedule(quote) - the page does the same sum.
--   5  Learned durations: event_day_plan_get also returns how long tasks with the same name really took before (the
--      middle value of start -> done over the studio's past events), so the page can suggest a duration.
--   6  Alerts (studio settings, Settings -> Notifications style; on by default, IN-APP BELL ONLY - no e-mail, no WhatsApp):
--      - "Event starts in 1 hour - ready? 8/10 done" to the event manager + the chosen roles (default manager, supervisor)
--      - a reminder 30 min before a job's latest start, and a red alert when the latest start has passed and it has not
--        started. Run every 5 minutes by event_ready_alert_tick() (pg_cron where it exists). Each alert goes once.
--      The bell rows use the existing kind task_escalated (0369), so ONLY the people named on a row see it.
--   7  Remind on the monitor: "Bell" sends the person's own Helm login a bell reminder (only if they have a login;
--      once per 5 minutes per task). E-mail and WhatsApp keep using the existing calls and their switches.
--
-- Access: reading = Staff - Can see (same as Tasks & Crew / the monitor); saving times, ticks and durations = "Assign &
-- send tasks" (0385, _r385_can_assign); alert settings = Controls - Can change (like task reminder settings, 0338).
-- Nothing here holds or returns money.
--
-- ZERO DATA LOSS: additive + idempotent. Three new tables, one new nullable column, new functions, one pg_cron job, and the
-- free-trial retention lists (0184) learn the new tables (patched in place once, like 0338 / 0370).
-- Nothing dropped, nothing deleted, no existing function, policy or row changed. Safe to run twice. ASCII only.

-- ---- 0) preflight -----------------------------------------------------------------------------------------------------
do $$ begin
  if to_regclass('public.event_tasks') is null or to_regclass('public.quotes') is null or to_regclass('public.notifications') is null
     or to_regclass('public.crew_members') is null or to_regclass('public.profiles') is null then
    raise exception 'STOP 0396: quotes / event_tasks / notifications / crew_members / profiles missing'; end if;
  if to_regprocedure('public.has_area(text,text)') is null or to_regprocedure('public.current_org_id()') is null then
    raise exception 'STOP 0396: has_area / current_org_id missing (phase29 / phase57)'; end if;
  if to_regprocedure('public._r23_tz(uuid)') is null or to_regprocedure('public._r23_parse_time(text)') is null then
    raise exception 'STOP 0396: run 0265 first (_r23_tz / _r23_parse_time)'; end if;
  if to_regprocedure('public._r385_can_assign()') is null then
    raise exception 'STOP 0396: run 0385 first (_r385_can_assign)'; end if;
  if to_regprocedure('public._r283_is_off(uuid,uuid)') is null then
    raise exception 'STOP 0396: run 0283 first (_r283_is_off)'; end if;
  if not exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'event_tasks' and column_name = 'depends_on') then
    raise exception 'STOP 0396: event_tasks.depends_on missing (Phase 37)'; end if;
end $$;

-- ---- 1) how long a task takes ------------------------------------------------------------------------------------------
alter table public.event_tasks add column if not exists duration_min integer;
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'event_tasks_duration_chk396') then
    alter table public.event_tasks add constraint event_tasks_duration_chk396 check (duration_min is null or duration_min between 1 and 1440);
  end if;
end $$;

-- ---- 2) the event's day plan: Venue opens, Ready by, Day-before ticks ---------------------------------------------------
create table if not exists public.event_day_plans (
  quote_id      uuid primary key references public.quotes(id) on delete cascade,
  org_id        uuid not null references public.organizations(id),
  venue_access  text,
  ready_by      text,
  checks        jsonb not null default '{}'::jsonb,
  updated_at    timestamptz not null default now(),
  updated_by    uuid,
  constraint event_day_plans_times_chk396 check ((venue_access is null or venue_access ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$')
                                                 and (ready_by is null or ready_by ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$')),
  constraint event_day_plans_checks_chk396 check (jsonb_typeof(checks) = 'object')
);

-- ---- 3) alert settings (one row per studio; no row = the defaults) ------------------------------------------------------
create table if not exists public.event_ready_alert_settings (
  org_id             uuid primary key references public.organizations(id),
  enabled            boolean not null default true,
  hour_before_min    integer not null default 60,
  notify_roles       text[] not null default '{manager,supervisor}',
  latest_alerts      boolean not null default true,
  remind_before_min  integer not null default 30,
  buffer_pct         integer not null default 15,
  updated_at         timestamptz not null default now(),
  updated_by         uuid,
  constraint event_ready_alert_settings_chk396 check (hour_before_min between 10 and 240 and remind_before_min between 0 and 180
    and buffer_pct between 0 and 100 and cardinality(notify_roles) <= 12),
  constraint event_ready_alert_settings_roles_chk396 check (array_to_string(notify_roles, ',') ~ '^([a-z_]{1,20}(,[a-z_]{1,20})*)?$')
);

-- ---- 4) each alert goes once ---------------------------------------------------------------------------------------------
create table if not exists public.event_ready_alert_sends (
  slot_key    text primary key,
  org_id      uuid not null references public.organizations(id),
  quote_id    uuid not null references public.quotes(id) on delete cascade,
  task_id     uuid references public.event_tasks(id) on delete cascade,
  kind        text not null,
  recipients  integer not null default 0,
  created_at  timestamptz not null default now(),
  constraint event_ready_alert_sends_kind_chk396 check (kind in ('ready_hour', 'latest_soon', 'latest_late', 'office_bell'))
);
create index if not exists event_ready_alert_sends_quote396 on public.event_ready_alert_sends (quote_id, created_at desc);

-- server only: the pages read and write through the calls below
do $$ declare t text; begin
  foreach t in array array['event_day_plans', 'event_ready_alert_settings', 'event_ready_alert_sends'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on table public.%I from public', t);
    if exists (select 1 from pg_roles where rolname = 'anon') then execute format('revoke all on table public.%I from anon', t); end if;
    if exists (select 1 from pg_roles where rolname = 'authenticated') then execute format('revoke all on table public.%I from authenticated', t); end if;
    if exists (select 1 from pg_roles where rolname = 'service_role') then execute format('grant select on table public.%I to service_role', t); end if;
  end loop;
end $$;
-- the event must belong to the same studio (shared guard) + a suspended / ended-trial studio takes no new rows (0045)
do $$ declare t text; begin
  foreach t in array array['event_day_plans', 'event_ready_alert_sends'] loop
    if to_regprocedure('public.tg_quote_org_match()') is not null then
      execute format('drop trigger if exists zz_quote_org_match on public.%I', t);
      execute format('create trigger zz_quote_org_match before insert or update on public.%I for each row execute function public.tg_quote_org_match()', t);
    end if;
  end loop;
  if to_regprocedure('public.tg_studio_read_only()') is not null then
    foreach t in array array['event_day_plans', 'event_ready_alert_settings', 'event_ready_alert_sends'] loop
      if not exists (select 1 from pg_catalog.pg_trigger where tgname = 'zzz_studio_read_only' and tgrelid = ('public.' || t)::regclass) then
        execute format('create trigger zzz_studio_read_only before insert or update or delete on public.%I for each row execute function public.tg_studio_read_only(''org_id'')', t);
      end if;
    end loop;
  end if;
end $$;

-- ---- 5) helpers ----------------------------------------------------------------------------------------------------------
-- the Day-before checklist keys the server accepts (the page shows the words)
create or replace function public._r396_check_keys()
returns text[] language sql immutable set search_path = '' as $fn$
  -- r226-0396
  select array['vendors', 'headcount', 'crew_call', 'load_list', 'transport', 'venue_access', 'power', 'permits', 'weather',
               'runsheet', 'client']::text[];
$fn$;

-- the studio's alert settings with the defaults filled in
create or replace function public._r396_cfg(p_org uuid)
returns jsonb language sql stable security definer set search_path = '' as $fn$
  -- r226-0396
  select coalesce((select jsonb_build_object('enabled', s.enabled, 'hour_before_min', s.hour_before_min, 'notify_roles', to_jsonb(s.notify_roles),
                    'latest_alerts', s.latest_alerts, 'remind_before_min', s.remind_before_min, 'buffer_pct', s.buffer_pct, 'saved', true)
                     from public.event_ready_alert_settings s where s.org_id = p_org),
                  jsonb_build_object('enabled', true, 'hour_before_min', 60, 'notify_roles', to_jsonb(array['manager', 'supervisor']::text[]),
                    'latest_alerts', true, 'remind_before_min', 30, 'buffer_pct', 15, 'saved', false));
$fn$;

-- "HH:MM" (24 h) from what a person typed ("5 pm", "17:00", "5.30 PM"); '' / null -> null; nonsense -> exception
create or replace function public._r396_hhmm(p text)
returns text language plpgsql immutable set search_path = '' as $fn$
-- r226-0396
declare t time;
begin
  if p is null or btrim(p) = '' then return null; end if;
  t := public._r23_parse_time(p);
  if t is null then raise exception 'invalid_time' using errcode = 'P0001'; end if;
  return to_char(t, 'HH24:MI');
end $fn$;

-- the instant Ready by falls on: the plan's Ready by, else 1 hour before Guests arrive (event_time); studio time zone
create or replace function public._r396_ready_at(p_quote uuid)
returns timestamptz language plpgsql stable security definer set search_path = '' as $fn$
-- r226-0396
declare q record; v_tz text; t time; v_rb text;
begin
  select qq.org_id, qq.event_date, qq.event_time into q from public.quotes qq where qq.id = p_quote;
  if q.org_id is null or q.event_date is null then return null; end if;
  v_tz := public._r23_tz(q.org_id);
  select p.ready_by into v_rb from public.event_day_plans p where p.quote_id = p_quote;
  if v_rb is not null then return (q.event_date + public._r23_parse_time(v_rb)) at time zone v_tz; end if;
  t := public._r23_parse_time(q.event_time);
  if t is null then return null; end if;
  return ((q.event_date + t) at time zone v_tz) - interval '60 minutes';
end $fn$;

-- the backward schedule: every timed job (duration set, not cancelled) gets its latest finish = the earliest latest start
-- of the timed jobs that need it first (depends_on = it), else Ready by; latest start = latest finish - duration x (1 + buffer)
-- (rounded up to the minute). A loop in the "needs first" links leaves those jobs on Ready by (never an endless loop).
create or replace function public._r396_schedule(p_quote uuid)
returns table(task_id uuid, duration_min integer, depends_on uuid, latest_start timestamptz, latest_finish timestamptz)
language plpgsql stable security definer set search_path = '' as $fn$
-- r226-0396 (arrays only: no temporary table, nothing written)
declare v_ready timestamptz := public._r396_ready_at(p_quote); v_org uuid; v_buf integer;
        ids uuid[]; durs integer[]; deps uuid[]; ls timestamptz[]; lf timestamptz[]; n integer; i integer; j integer;
        pass integer := 0; changed boolean; ready_ok boolean; m timestamptz;
begin
  if v_ready is null then return; end if;
  select q.org_id into v_org from public.quotes q where q.id = p_quote;
  v_buf := coalesce((public._r396_cfg(v_org) ->> 'buffer_pct')::integer, 15);
  select coalesce(array_agg(t.id order by t.id), '{}'), coalesce(array_agg(t.duration_min order by t.id), '{}'), coalesce(array_agg(t.depends_on order by t.id), '{}')
    into ids, durs, deps
    from public.event_tasks t
   where t.quote_id = p_quote and t.status <> 'cancelled' and t.duration_min is not null and t.duration_min > 0;
  n := coalesce(array_length(ids, 1), 0);
  if n = 0 then return; end if;
  ls := array_fill(null::timestamptz, array[n]); lf := array_fill(null::timestamptz, array[n]);
  loop
    pass := pass + 1; changed := false;
    for i in 1 .. n loop
      if ls[i] is not null then continue; end if;
      ready_ok := true; m := null;
      for j in 1 .. n loop
        if deps[j] = ids[i] and j <> i then
          if ls[j] is null then ready_ok := false; exit; end if;
          if m is null or ls[j] < m then m := ls[j]; end if;
        end if;
      end loop;
      if ready_ok then
        lf[i] := coalesce(m, v_ready);
        ls[i] := lf[i] - make_interval(mins => ceil(durs[i] * (100 + v_buf) / 100.0)::integer);
        changed := true;
      end if;
    end loop;
    exit when not changed or pass > n + 1;
  end loop;
  for i in 1 .. n loop
    if ls[i] is null then   -- a loop in the "needs first" links: timed from Ready by
      lf[i] := v_ready; ls[i] := v_ready - make_interval(mins => ceil(durs[i] * (100 + v_buf) / 100.0)::integer);
    end if;
    task_id := ids[i]; duration_min := durs[i]; depends_on := deps[i]; latest_start := ls[i]; latest_finish := lf[i];
    return next;
  end loop;
end $fn$;

-- who an event alert goes to: the event manager + the studio members whose role is chosen; nobody -> the admins
create or replace function public._r396_people(p_org uuid, p_quote uuid)
returns jsonb language sql stable security definer set search_path = '' as $fn$
  -- r226-0396
  with roles as (select array(select jsonb_array_elements_text(public._r396_cfg(p_org) -> 'notify_roles')) as r),
  ppl as (
    select p.id from public.profiles p, roles where p.org_id = p_org and lower(coalesce(p.role, '')) = any (roles.r)
       and lower(coalesce(p.role, '')) not in ('', 'client', 'crew', 'worker') and not public._r283_is_off(p.id, p_org)
    union
    select p.id from public.profiles p join public.quotes q on q.manager_id = p.id
     where q.id = p_quote and p.org_id = p_org and lower(coalesce(p.role, '')) not in ('', 'client', 'crew', 'worker')
       and not public._r283_is_off(p.id, p_org)
  )
  select case when exists (select 1 from ppl) then (select jsonb_agg(id::text) from ppl)
              else coalesce((select jsonb_agg(p.id::text) from public.profiles p
                              where p.org_id = p_org and p.role = 'admin' and not public._r283_is_off(p.id, p_org)), '[]'::jsonb) end;
$fn$;

-- one bell row for the people named on it (kind task_escalated: 0369 shows it only to them); never blocks the caller
create or replace function public._r396_bell(p_org uuid, p_quote uuid, p_task uuid, p_label text, p_via text, p_notify jsonb)
returns integer language plpgsql volatile security definer set search_path = '' as $fn$
-- r226-0396
begin
  if p_notify is null or jsonb_typeof(p_notify) <> 'array' or jsonb_array_length(p_notify) = 0 then return 0; end if;
  insert into public.notifications (quote_id, channel, kind, status, detail, org_id)
  values (p_quote, 'in_app', 'task_escalated', 'simulated',
          jsonb_build_object('label', left(p_label, 300), 'task_id', p_task, 'notify', p_notify, 'source', '0396', 'via', p_via), p_org);
  return jsonb_array_length(p_notify);
exception when others then
  raise warning 'r226-0396: bell notice skipped (%)', sqlstate;
  return 0;
end $fn$;

-- the caller's studio + the event, or an exception (same studio only)
create or replace function public._r396_event(p_quote uuid)
returns uuid language plpgsql stable security definer set search_path = '' as $fn$
-- r226-0396
declare v_org uuid := public.current_org_id();
begin
  if auth.uid() is null or v_org is null then raise exception 'not allowed' using errcode = '42501'; end if;
  if not exists (select 1 from public.quotes q where q.id = p_quote and q.org_id = v_org) then
    raise exception 'event not found' using errcode = 'P0002'; end if;
  return v_org;
end $fn$;

-- ---- 6) the page calls -----------------------------------------------------------------------------------------------------
-- everything the Ready-by card and the Day-before checklist need for one event
create or replace function public.event_day_plan_get(p_quote uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $fn$
-- r226-0396
declare v_org uuid; pl record; v_tz text; v_out jsonb;
begin
  v_org := public._r396_event(p_quote);
  if not coalesce(public.has_area('staff', 'view'), false) then raise exception 'not allowed' using errcode = '42501'; end if;
  v_tz := public._r23_tz(v_org);
  select p.venue_access, p.ready_by, p.checks into pl from public.event_day_plans p where p.quote_id = p_quote;
  v_out := jsonb_build_object(
    'v', 1,
    'venue_access', pl.venue_access,
    'ready_by', pl.ready_by,
    'ready_at', public._r396_ready_at(p_quote),
    'checks', coalesce(pl.checks, '{}'::jsonb),
    'check_keys', to_jsonb(public._r396_check_keys()),
    'settings', public._r396_cfg(v_org),
    'can_edit', coalesce(public._r385_can_assign(), false),
    'can_settings', coalesce(public.has_area('controls', 'edit'), false),
    'tz', v_tz,
    'schedule', coalesce((select jsonb_agg(jsonb_build_object('task_id', s.task_id, 'duration_min', s.duration_min, 'depends_on', s.depends_on,
                            'latest_start', s.latest_start, 'latest_finish', s.latest_finish) order by s.latest_start)
                            from public._r396_schedule(p_quote) s), '[]'::jsonb),
    -- learned: how long tasks with the same name really took on the studio's other events (start -> done, 1 min .. 24 h)
    'learned', coalesce((
      select jsonb_agg(jsonb_build_object('title', x.k, 'minutes', x.m, 'n', x.n))
        from (select lower(btrim(o.title)) as k, round(percentile_cont(0.5) within group (order by extract(epoch from (o.completed_at - o.started_at)) / 60.0))::integer as m,
                     count(*) as n
                from public.event_tasks o
               where o.org_id = v_org and o.quote_id <> p_quote and o.status = 'completed'
                 and o.started_at is not null and o.completed_at is not null
                 and o.completed_at > o.started_at and o.completed_at - o.started_at <= interval '24 hours'
                 and o.completed_at > now() - interval '400 days'
                 and lower(btrim(o.title)) in (select lower(btrim(t.title)) from public.event_tasks t where t.quote_id = p_quote and t.status <> 'cancelled')
               group by 1) x where x.m >= 1), '[]'::jsonb));
  return v_out;
end $fn$;

-- save Venue opens / Ready by ("" = clear that time)
create or replace function public.event_day_plan_set(p_quote uuid, p_venue_access text, p_ready_by text)
returns jsonb language plpgsql volatile security definer set search_path = '' as $fn$
-- r226-0396
declare v_org uuid; v_va text; v_rb text;
begin
  v_org := public._r396_event(p_quote);
  if not coalesce(public._r385_can_assign(), false) then raise exception 'not allowed' using errcode = '42501'; end if;
  v_va := public._r396_hhmm(p_venue_access); v_rb := public._r396_hhmm(p_ready_by);
  insert into public.event_day_plans (quote_id, org_id, venue_access, ready_by, updated_by)
  values (p_quote, v_org, v_va, v_rb, auth.uid())
  on conflict (quote_id) do update set venue_access = excluded.venue_access, ready_by = excluded.ready_by, updated_at = now(), updated_by = auth.uid();
  return jsonb_build_object('ok', true, 'venue_access', v_va, 'ready_by', v_rb, 'ready_at', public._r396_ready_at(p_quote));
end $fn$;

-- tick / untick one Day-before line (an untick is kept as done:false with who + when)
create or replace function public.event_day_check_set(p_quote uuid, p_key text, p_done boolean)
returns jsonb language plpgsql volatile security definer set search_path = '' as $fn$
-- r226-0396
declare v_org uuid; v_who text; v_item jsonb;
begin
  v_org := public._r396_event(p_quote);
  if not coalesce(public._r385_can_assign(), false) then raise exception 'not allowed' using errcode = '42501'; end if;
  if p_key is null or not (p_key = any (public._r396_check_keys())) then raise exception 'invalid_key' using errcode = 'P0001'; end if;
  select left(coalesce(nullif(btrim(p.full_name), ''), split_part(coalesce(p.email, ''), '@', 1), 'Someone'), 80) into v_who
    from public.profiles p where p.id = auth.uid();
  v_item := jsonb_build_object('done', coalesce(p_done, false), 'by', coalesce(v_who, 'Someone'), 'at', now());
  insert into public.event_day_plans (quote_id, org_id, checks, updated_by)
  values (p_quote, v_org, jsonb_build_object(p_key, v_item), auth.uid())
  on conflict (quote_id) do update set checks = public.event_day_plans.checks || jsonb_build_object(p_key, v_item), updated_at = now(), updated_by = auth.uid();
  return jsonb_build_object('ok', true, 'key', p_key, 'item', v_item);
end $fn$;

-- how long one task takes (null = not a timed set-up job) and, when p_set_needs, what it needs first (event_tasks.depends_on:
-- same event, never itself, never a loop). Only these two columns change (start times, people, status are left alone).
create or replace function public.event_task_duration_set(p_task uuid, p_minutes integer, p_needs uuid default null, p_set_needs boolean default false)
returns jsonb language plpgsql volatile security definer set search_path = '' as $fn$
-- r226-0396
declare v_q uuid; v_cur uuid; i integer := 0;
begin
  select t.quote_id into v_q from public.event_tasks t where t.id = p_task;
  if v_q is null then raise exception 'task not found' using errcode = 'P0002'; end if;
  perform public._r396_event(v_q);
  if not coalesce(public._r385_can_assign(), false) then raise exception 'not allowed' using errcode = '42501'; end if;
  if p_minutes is not null and (p_minutes < 1 or p_minutes > 1440) then raise exception 'invalid_minutes' using errcode = 'P0001'; end if;
  if coalesce(p_set_needs, false) and p_needs is not null then
    if p_needs = p_task or not exists (select 1 from public.event_tasks t where t.id = p_needs and t.quote_id = v_q) then
      raise exception 'invalid_needs' using errcode = 'P0001'; end if;
    v_cur := p_needs;                       -- walk the chain from the new "needs first": reaching this task = a loop
    while v_cur is not null and i < 500 loop
      select t.depends_on into v_cur from public.event_tasks t where t.id = v_cur and t.quote_id = v_q;
      if v_cur = p_task then raise exception 'needs_loop' using errcode = 'P0001'; end if;
      i := i + 1;
    end loop;
  end if;
  update public.event_tasks set duration_min = p_minutes,
         depends_on = case when coalesce(p_set_needs, false) then p_needs else depends_on end
   where id = p_task;
  return jsonb_build_object('ok', true, 'task_id', p_task, 'duration_min', p_minutes,
    'depends_on', (select t.depends_on from public.event_tasks t where t.id = p_task));
end $fn$;

-- the alert settings (Staff or Controls - Can see reads; Controls - Can change saves)
create or replace function public.event_ready_settings_get()
returns jsonb language plpgsql stable security definer set search_path = '' as $fn$
-- r226-0396
declare v_org uuid := public.current_org_id();
begin
  if auth.uid() is null or v_org is null or not (coalesce(public.has_area('staff', 'view'), false) or coalesce(public.has_area('controls', 'view'), false)) then
    raise exception 'not allowed' using errcode = '42501'; end if;
  return public._r396_cfg(v_org) || jsonb_build_object('can_edit', coalesce(public.has_area('controls', 'edit'), false));
end $fn$;

create or replace function public.event_ready_settings_set(p jsonb)
returns jsonb language plpgsql volatile security definer set search_path = '' as $fn$
-- r226-0396
declare v_org uuid := public.current_org_id(); c jsonb; v_roles text[];
begin
  if auth.uid() is null or v_org is null or not coalesce(public.has_area('controls', 'edit'), false) then
    raise exception 'not allowed' using errcode = '42501'; end if;
  if p is null or jsonb_typeof(p) <> 'object' then raise exception 'invalid_settings' using errcode = 'P0001'; end if;
  c := public._r396_cfg(v_org) || p;
  if jsonb_typeof(c -> 'notify_roles') <> 'array' then raise exception 'invalid_settings' using errcode = 'P0001'; end if;
  v_roles := array(select distinct lower(btrim(x)) from jsonb_array_elements_text(c -> 'notify_roles') x where btrim(x) <> '');
  begin
    insert into public.event_ready_alert_settings (org_id, enabled, hour_before_min, notify_roles, latest_alerts, remind_before_min, buffer_pct, updated_by)
    values (v_org, (c ->> 'enabled')::boolean, (c ->> 'hour_before_min')::integer, v_roles, (c ->> 'latest_alerts')::boolean,
            (c ->> 'remind_before_min')::integer, (c ->> 'buffer_pct')::integer, auth.uid())
    on conflict (org_id) do update set enabled = excluded.enabled, hour_before_min = excluded.hour_before_min, notify_roles = excluded.notify_roles,
      latest_alerts = excluded.latest_alerts, remind_before_min = excluded.remind_before_min, buffer_pct = excluded.buffer_pct,
      updated_at = now(), updated_by = auth.uid();
  exception when check_violation or invalid_text_representation or numeric_value_out_of_range then
    raise exception 'invalid_settings' using errcode = 'P0001';
  end;
  return public._r396_cfg(v_org) || jsonb_build_object('can_edit', true);
end $fn$;

-- Remind -> Bell: a bell reminder to the person's own Helm login (only when they have one; once per 5 min per task)
create or replace function public.event_task_remind_bell(p_task uuid)
returns jsonb language plpgsql volatile security definer set search_path = '' as $fn$
-- r226-0396
declare t record; v_org uuid; v_pid uuid; v_name text; v_key text; v_tz text;
begin
  select tt.id, tt.quote_id, tt.title, tt.crew_id, tt.status, tt.planned_start into t from public.event_tasks tt where tt.id = p_task;
  if t.id is null then raise exception 'task not found' using errcode = 'P0002'; end if;
  v_org := public._r396_event(t.quote_id);
  if not coalesce(public._r385_can_assign(), false) then raise exception 'not allowed' using errcode = '42501'; end if;
  if t.status in ('completed', 'cancelled', 'rejected') then return jsonb_build_object('ok', false, 'reason', 'closed'); end if;
  select c.profile_id, c.name into v_pid, v_name from public.crew_members c where c.id = t.crew_id and c.org_id = v_org;
  if v_pid is null or not exists (select 1 from public.profiles p where p.id = v_pid and p.org_id = v_org) then
    return jsonb_build_object('ok', false, 'reason', 'no_login', 'name', v_name); end if;
  v_key := 'bell|' || p_task::text || '|' || v_pid::text || '|' || floor(extract(epoch from now()) / 300)::bigint::text;
  insert into public.event_ready_alert_sends (slot_key, org_id, quote_id, task_id, kind, recipients)
  values (v_key, v_org, t.quote_id, p_task, 'office_bell', 1) on conflict (slot_key) do nothing;
  if not found then return jsonb_build_object('ok', false, 'reason', 'just_sent', 'name', v_name); end if;
  v_tz := public._r23_tz(v_org);
  perform public._r396_bell(v_org, t.quote_id, p_task,
    'Reminder from the office: ' || left(coalesce(t.title, 'your task'), 120)
      || case when t.planned_start is not null then ' (start ' || to_char(t.planned_start at time zone v_tz, 'FMHH12:MI AM') || ')' else '' end,
    'office_reminder', jsonb_build_array(v_pid::text));
  return jsonb_build_object('ok', true, 'name', v_name);
end $fn$;

-- ---- 7) the 5-minute job: "starts in 1 hour - ready?" + latest-start reminders / red alerts (bell only) -------------------
create or replace function public.event_ready_alert_tick()
returns integer language plpgsql volatile security definer set search_path = '' as $fn$
-- r226-0396: server job (pg_cron / service role). Writes in-app bell rows only, each once (event_ready_alert_sends).
declare e record; s record; c jsonb; v_tz text; v_start timestamptz; v_ready timestamptz; v_done integer; v_total integer; v_late integer;
        v_people jsonb; v_n integer := 0; v_mins integer; v_title text; v_label text;
begin
  for e in
    select q.id, q.org_id, q.code, q.title, q.event_date, q.event_time
      from public.quotes q
     where q.event_date between (now() at time zone 'UTC')::date - 1 and (now() at time zone 'UTC')::date + 1
       and coalesce(q.status, '') not in ('cancelled', 'lost', 'rejected', 'draft')
       and coalesce(q.lifecycle_stage, '') not in ('settlement', 'closed', 'cancelled')
       and exists (select 1 from public.event_tasks t where t.quote_id = q.id and t.status <> 'cancelled')
  loop
    begin
      c := public._r396_cfg(e.org_id);
      if not coalesce((c ->> 'enabled')::boolean, true) then continue; end if;
      v_tz := public._r23_tz(e.org_id);
      v_ready := public._r396_ready_at(e.id);
      v_start := case when public._r23_parse_time(e.event_time) is not null then (e.event_date + public._r23_parse_time(e.event_time)) at time zone v_tz
                      when v_ready is not null then v_ready end;
      v_people := null;
      -- (a) "Event starts in 1 hour - ready? 8/10 done"
      if v_start is not null and now() >= v_start - make_interval(mins => (c ->> 'hour_before_min')::integer) and now() < v_start then
        insert into public.event_ready_alert_sends (slot_key, org_id, quote_id, kind)
        values ('ready|' || e.id::text || '|' || to_char(v_start at time zone 'UTC', 'YYYYMMDDHH24MI'), e.org_id, e.id, 'ready_hour')
        on conflict (slot_key) do nothing;
        if found then
          select count(*) filter (where t.status = 'completed'), count(*),
                 count(*) filter (where t.status in ('assigned', 'accepted') and t.planned_start is not null and t.planned_start < now())
            into v_done, v_total, v_late from public.event_tasks t where t.quote_id = e.id and t.status <> 'cancelled';
          v_mins := greatest(1, ceil(extract(epoch from (v_start - now())) / 60.0)::integer);
          v_label := 'Event starts in ' || case when v_mins >= 55 and v_mins <= 65 then '1 hour' when v_mins >= 60 then (v_mins / 60) || ' h ' || (v_mins % 60) || ' min' else v_mins || ' min' end
                     || ' - ready? ' || v_done || '/' || v_total || ' done' || case when v_late > 0 then ', ' || v_late || ' late' else '' end
                     || ' (' || coalesce(nullif(e.code, ''), left(coalesce(e.title, 'event'), 60)) || ')';
          v_people := public._r396_people(e.org_id, e.id);
          v_n := v_n + public._r396_bell(e.org_id, e.id, null, v_label, 'ready_check', v_people);
          update public.event_ready_alert_sends set recipients = jsonb_array_length(v_people)
           where slot_key = 'ready|' || e.id::text || '|' || to_char(v_start at time zone 'UTC', 'YYYYMMDDHH24MI');
        end if;
      end if;
      -- (b) latest start: a reminder before it, a red alert once it has passed (job not started)
      if coalesce((c ->> 'latest_alerts')::boolean, true) and v_ready is not null and now() < v_ready + interval '6 hours' then
        for s in
          select x.task_id, x.latest_start, t.title, t.status, t.assignee_name
            from public._r396_schedule(e.id) x join public.event_tasks t on t.id = x.task_id
           where t.status in ('unassigned', 'assigned', 'accepted')
             and now() >= x.latest_start - make_interval(mins => (c ->> 'remind_before_min')::integer)
        loop
          v_title := left(coalesce(s.title, 'A job'), 100);
          if now() < s.latest_start then
            insert into public.event_ready_alert_sends (slot_key, org_id, quote_id, task_id, kind)
            values ('soon|' || s.task_id::text || '|' || to_char(s.latest_start at time zone 'UTC', 'YYYYMMDDHH24MI'), e.org_id, e.id, s.task_id, 'latest_soon')
            on conflict (slot_key) do nothing;
            if found then
              v_people := coalesce(v_people, public._r396_people(e.org_id, e.id));
              v_n := v_n + public._r396_bell(e.org_id, e.id, s.task_id,
                v_title || ' must start by ' || to_char(s.latest_start at time zone v_tz, 'FMHH12:MI AM') || ' to be ready by '
                  || to_char(v_ready at time zone v_tz, 'FMHH12:MI AM') || coalesce(' (' || nullif(btrim(s.assignee_name), '') || ')', ''),
                'latest_soon', v_people);
            end if;
          else
            insert into public.event_ready_alert_sends (slot_key, org_id, quote_id, task_id, kind)
            values ('late|' || s.task_id::text || '|' || to_char(s.latest_start at time zone 'UTC', 'YYYYMMDDHH24MI'), e.org_id, e.id, s.task_id, 'latest_late')
            on conflict (slot_key) do nothing;
            if found then
              v_people := coalesce(v_people, public._r396_people(e.org_id, e.id));
              v_n := v_n + public._r396_bell(e.org_id, e.id, s.task_id,
                'Not started: ' || v_title || ' - latest start was ' || to_char(s.latest_start at time zone v_tz, 'FMHH12:MI AM')
                  || '. Ready by ' || to_char(v_ready at time zone v_tz, 'FMHH12:MI AM') || ' is at risk' || coalesce(' (' || nullif(btrim(s.assignee_name), '') || ')', ''),
                'latest_late', v_people);
            end if;
          end if;
        end loop;
      end if;
    exception when others then
      raise warning 'r226-0396: event % skipped (%)', e.id, sqlstate;
    end;
  end loop;
  return v_n;
end $fn$;

-- ---- 8) grants ----------------------------------------------------------------------------------------------------------------
do $$ declare f text; begin
  foreach f in array array['public._r396_check_keys()', 'public._r396_hhmm(text)', 'public._r396_cfg(uuid)', 'public._r396_ready_at(uuid)', 'public._r396_schedule(uuid)', 'public._r396_people(uuid,uuid)',
                           'public._r396_bell(uuid,uuid,uuid,text,text,jsonb)', 'public._r396_event(uuid)', 'public.event_ready_alert_tick()'] loop
    execute format('revoke all on function %s from public', f);
    if exists (select 1 from pg_roles where rolname = 'anon') then execute format('revoke all on function %s from anon', f); end if;
    if exists (select 1 from pg_roles where rolname = 'authenticated') then execute format('revoke all on function %s from authenticated', f); end if;
  end loop;
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    execute 'grant execute on function public.event_ready_alert_tick() to service_role'; end if;
  foreach f in array array['public.event_day_plan_get(uuid)', 'public.event_day_plan_set(uuid,text,text)', 'public.event_day_check_set(uuid,text,boolean)',
                           'public.event_task_duration_set(uuid,integer,uuid,boolean)', 'public.event_ready_settings_get()', 'public.event_ready_settings_set(jsonb)',
                           'public.event_task_remind_bell(uuid)'] loop
    execute format('revoke all on function %s from public', f);
    if exists (select 1 from pg_roles where rolname = 'anon') then execute format('revoke all on function %s from anon', f); end if;
    if exists (select 1 from pg_roles where rolname = 'authenticated') then execute format('grant execute on function %s to authenticated', f); end if;
    if exists (select 1 from pg_roles where rolname = 'service_role') then execute format('grant execute on function %s to service_role', f); end if;
  end loop;
end $$;

-- ---- 8b) free-trial retention (0184): the event rows go with the studio's events, the settings are kept (like 0338) --------
do $$ declare v_def text; begin
  if to_regprocedure('public._tr184_purge_tables()') is not null then
    v_def := pg_get_functiondef('public._tr184_purge_tables()'::regprocedure);
    if position('''event_day_plans''' in v_def) = 0 then
      if (length(v_def) - length(replace(v_def, '''event_stock_requests'', ''task_evidence_grants''', ''))) / length('''event_stock_requests'', ''task_evidence_grants''') <> 1 then
        raise notice '0396: _tr184_purge_tables has an unexpected body - left unchanged';
      else execute replace(v_def, '''event_stock_requests'', ''task_evidence_grants''', '''event_stock_requests'', ''event_ready_alert_sends'', ''event_day_plans'', ''task_evidence_grants'''); end if;
    end if;
  end if;
  if to_regprocedure('public._tr184_keep_tables()') is not null then
    v_def := pg_get_functiondef('public._tr184_keep_tables()'::regprocedure);
    if position('''event_ready_alert_settings''' in v_def) = 0 then
      if (length(v_def) - length(replace(v_def, '''task_reminder_settings'', ', ''))) / length('''task_reminder_settings'', ') <> 1 then
        raise notice '0396: _tr184_keep_tables has an unexpected body - left unchanged';
      else execute replace(v_def, '''task_reminder_settings'', ', '''task_reminder_settings'', ''event_ready_alert_settings'', '); end if;
    end if;
  end if;
end $$;

-- ---- 9) the 5-minute job (only where pg_cron exists; a re-run keeps one job) -------------------------------------------------
do $$ begin
  if to_regnamespace('cron') is not null and to_regprocedure('cron.schedule(text,text,text)') is not null then
    if not exists (select 1 from cron.job where jobname = 'helm-event-ready-alerts') then
      perform cron.schedule('helm-event-ready-alerts', '*/5 * * * *', 'select public.event_ready_alert_tick()');
    end if;
  else
    raise notice '0396: pg_cron not available - schedule select public.event_ready_alert_tick() every 5 minutes yourself';
  end if;
end $$;

select item, ok from (values
  ('01 event_day_plans, event_ready_alert_settings, event_ready_alert_sends exist with RLS on',
     (select count(*) from pg_class c where c.relrowsecurity and c.oid in (to_regclass('public.event_day_plans'), to_regclass('public.event_ready_alert_settings'), to_regclass('public.event_ready_alert_sends'))) = 3),
  ('02 the three tables are closed to anon and signed-in users (the pages use the calls)',
     not has_table_privilege('authenticated', 'public.event_day_plans', 'select') and not has_table_privilege('anon', 'public.event_day_plans', 'select')
     and not has_table_privilege('authenticated', 'public.event_ready_alert_settings', 'select') and not has_table_privilege('authenticated', 'public.event_ready_alert_sends', 'select')),
  ('03 event_tasks.duration_min added (empty for every existing task) with its 1..1440 check',
     exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'event_tasks' and column_name = 'duration_min')
     and (select count(*) from pg_constraint where conname = 'event_tasks_duration_chk396') = 1),
  ('04 the seven page calls exist and signed-in users may run them, anon may not',
     (select count(*) from unnest(array['public.event_day_plan_get(uuid)', 'public.event_day_plan_set(uuid,text,text)', 'public.event_day_check_set(uuid,text,boolean)',
        'public.event_task_duration_set(uuid,integer,uuid,boolean)', 'public.event_ready_settings_get()', 'public.event_ready_settings_set(jsonb)', 'public.event_task_remind_bell(uuid)']) f
       where to_regprocedure(f) is not null and has_function_privilege('authenticated', f, 'execute') and not has_function_privilege('anon', f, 'execute')) = 7),
  ('05 the 5-minute job and the helpers are server only',
     to_regprocedure('public.event_ready_alert_tick()') is not null
     and not has_function_privilege('authenticated', 'public.event_ready_alert_tick()', 'execute')
     and not has_function_privilege('authenticated', 'public._r396_bell(uuid,uuid,uuid,text,text,jsonb)', 'execute')
     and not has_function_privilege('authenticated', 'public._r396_schedule(uuid)', 'execute')),
  ('06 every new function is security definer with a pinned search_path',
     (select bool_and(p.prosecdef or p.proname in ('_r396_check_keys', '_r396_hhmm')) and bool_and(coalesce(array_to_string(p.proconfig, ','), '') like '%search_path=%')
        from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'public' and (p.proname like '\_r396\_%' or p.proname in ('event_day_plan_get', 'event_day_plan_set', 'event_day_check_set',
             'event_task_duration_set', 'event_ready_settings_get', 'event_ready_settings_set', 'event_task_remind_bell', 'event_ready_alert_tick')))),
  ('07 the 5-minute job is scheduled once (or pg_cron is not installed here)',
     case when to_regclass('cron.job') is null then true
          else (xpath('/row/c/text()', query_to_xml('select count(*) as c from cron.job where jobname = ''helm-event-ready-alerts''', false, true, '')))[1]::text = '1' end),
  ('08 the same-studio guard is on the new event tables (or the guard is absent)',
     to_regprocedure('public.tg_quote_org_match()') is null
     or (select count(*) from pg_trigger t where t.tgname = 'zz_quote_org_match' and t.tgrelid in (to_regclass('public.event_day_plans'), to_regclass('public.event_ready_alert_sends'))) = 2),
  ('09 nothing existing was touched: task_escalated rows still go only to the people named (0369 bell rule kept)',
     position('task_escalated' in coalesce((select p.prosrc from pg_proc p where p.oid = to_regprocedure('public._r388_vis(uuid,uuid)')),
                                           (select p.prosrc from pg_proc p where p.oid = to_regprocedure('public._r23_visible(uuid,uuid)')), '')) > 0),
  ('10 the defaults read cleanly (on, 60 min before, manager + supervisor, 30 min before latest start, 15 % buffer); read only',
     (public._r396_cfg(null) ->> 'hour_before_min') = '60' and (public._r396_cfg(null) ->> 'buffer_pct') = '15'
     and (select count(*) from public._r396_schedule('00000000-0000-0000-0000-000000000000'::uuid)) = 0),
  ('11 free-trial retention knows the new tables (event rows purged with a trial, settings kept), or 0184 is absent',
     to_regprocedure('public._tr184_purge_tables()') is null
     or (array['event_day_plans', 'event_ready_alert_sends']::text[] <@ public._tr184_purge_tables()
         and 'event_ready_alert_settings' = any (public._tr184_keep_tables()))),
  ('12 signed-out users cannot run any 0396 function',
     not exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                  where n.nspname = 'public' and (p.proname like '\_r396\_%' or p.proname in ('event_day_plan_get', 'event_day_plan_set', 'event_day_check_set', 'event_task_duration_set', 'event_ready_settings_get', 'event_ready_settings_set', 'event_task_remind_bell', 'event_ready_alert_tick'))
                    and has_function_privilege('anon', p.oid, 'execute')))
) v(item, ok) order by item;
commit;
