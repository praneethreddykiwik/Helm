-- 0368_r184_event_activity.sql - R184 (owner, 17 Nov 2026). Forward-only, additive, safe to run twice. ASCII only.
-- REQUIRES 0265 (crew_checkins), 0361 (staff_email_outbox), 0363 (staff_update_outbox, _tr184_purge_tables list), 0366.
--
-- In plain words:
--   The Event day monitor page should show EVERY update on an event, newest first: work given out, given to someone
--   else, accepted, turned down, started, done, cancelled, start time changed, marked special, check-in, check-out and
--   the e-mails Helm sent. Until now Helm only kept the latest time of each step on the task itself, so a change of
--   person or of start time left no trace.
--   1  event_task_log: one small row per change, written by two triggers (on event_tasks and on crew_checkins) from now on.
--      The triggers never block the change itself: if writing the log row fails, the change still goes through.
--      RLS on, no grants: only the function below reads it. A read-only (suspended / ended trial) studio writes nothing
--      (same guard as every studio table) and the free-trial clean-up removes the rows with the studio data.
--   2  event_day_activity(quote, limit): the timeline of the event for the office (signed in, own studio only, Staff / Calendar /
--      Quotes view like the live board; never crew). It merges the log with what Helm already had before this
--      migration (task step times, check-ins, sent e-mails) so older events have a timeline too, without doubles.
--   Nothing is changed or deleted in any existing table. Goes after 0367.

-- ---- 1) the log table -------------------------------------------------------------------------------------------------------------
create table if not exists public.event_task_log (
  id         uuid primary key default gen_random_uuid(),
  org_id     uuid not null references public.organizations(id) on delete cascade,
  quote_id   uuid not null references public.quotes(id) on delete cascade,
  task_id    uuid references public.event_tasks(id) on delete set null,
  crew_id    uuid references public.crew_members(id) on delete set null,
  kind       text not null check (kind in ('assigned', 'reassigned', 'unassigned', 'time_changed', 'special_on', 'special_off',
                                           'accepted', 'rejected', 'started', 'completed', 'cancelled', 'reopened',
                                           'check_in', 'check_out', 'check_edit')),
  title      text check (title is null or char_length(title) <= 300),
  detail     jsonb not null default '{}'::jsonb check (jsonb_typeof(detail) = 'object'),
  actor      uuid,
  actor_kind text not null default 'system' check (actor_kind in ('office', 'staff', 'system')),
  at         timestamptz not null default now()
);
create index if not exists event_task_log_quote_idx on public.event_task_log (quote_id, at desc);
create index if not exists event_task_log_org_idx on public.event_task_log (org_id);
create index if not exists event_task_log_task_idx on public.event_task_log (task_id);
alter table public.event_task_log enable row level security;
revoke all on table public.event_task_log from public;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'anon') then execute 'revoke all on table public.event_task_log from anon'; end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then execute 'revoke all on table public.event_task_log from authenticated'; end if;
end $$;

-- event <-> studio integrity, and a read-only (suspended / ended trial) studio writes nothing here either (same guards as
-- every studio table)
do $$ begin
  if to_regprocedure('public.tg_quote_org_match()') is not null
     and not exists (select 1 from pg_trigger where tgrelid = 'public.event_task_log'::regclass and tgname = 'zz_quote_org_match') then
    create trigger zz_quote_org_match before insert or update on public.event_task_log for each row execute function public.tg_quote_org_match();
  end if;
  if to_regprocedure('public.tg_studio_read_only()') is not null
     and not exists (select 1 from pg_trigger where tgrelid = 'public.event_task_log'::regclass and tgname = 'zzz_studio_read_only') then
    create trigger zzz_studio_read_only before insert or update or delete on public.event_task_log for each row execute function public.tg_studio_read_only('org_id');
  end if;
end $$;

-- who made the change: a signed-in office user, a staff member through their link (an API call with no user), or Helm itself
create or replace function public._r368_actor_kind()
returns text language sql stable security definer set search_path = '' as $$
-- r184-0368
  select case when auth.uid() is not null then 'office'
              when coalesce(nullif(current_setting('request.jwt.claims', true), ''), '{}') <> '{}' then 'staff'
              else 'system' end
$$;

-- ---- 2) trigger on event_tasks ------------------------------------------------------------------------------------------------------
create or replace function public._r368_task_log()
returns trigger language plpgsql security definer set search_path = '' as $$
-- r184-0368: one log row per meaningful change; never blocks the task change
declare v_kind text := public._r368_actor_kind(); v_uid uuid := auth.uid();
begin
  begin
    if tg_op = 'INSERT' then
      if new.crew_id is not null or nullif(btrim(coalesce(new.assignee_name, '')), '') is not null then
        insert into public.event_task_log (org_id, quote_id, task_id, crew_id, kind, title, detail, actor, actor_kind)
        values (new.org_id, new.quote_id, new.id, new.crew_id, 'assigned', left(new.title, 300),
                jsonb_build_object('to', new.assignee_name), v_uid, v_kind);
      end if;
      return new;
    end if;
    -- UPDATE
    if new.crew_id is distinct from old.crew_id or coalesce(new.assignee_phone, '') is distinct from coalesce(old.assignee_phone, '') then
      insert into public.event_task_log (org_id, quote_id, task_id, crew_id, kind, title, detail, actor, actor_kind)
      values (new.org_id, new.quote_id, new.id, new.crew_id,
              case when new.crew_id is null and nullif(btrim(coalesce(new.assignee_name, '')), '') is null then 'unassigned'
                   when old.crew_id is null and nullif(btrim(coalesce(old.assignee_name, '')), '') is null then 'assigned'
                   else 'reassigned' end,
              left(new.title, 300), jsonb_build_object('from', old.assignee_name, 'to', new.assignee_name), v_uid, v_kind);
    end if;
    if new.planned_start is distinct from old.planned_start then
      insert into public.event_task_log (org_id, quote_id, task_id, crew_id, kind, title, detail, actor, actor_kind)
      values (new.org_id, new.quote_id, new.id, new.crew_id, 'time_changed', left(new.title, 300),
              jsonb_build_object('from', old.planned_start, 'to', new.planned_start), v_uid, v_kind);
    end if;
    if coalesce(new.is_special, false) is distinct from coalesce(old.is_special, false) then
      insert into public.event_task_log (org_id, quote_id, task_id, crew_id, kind, title, detail, actor, actor_kind)
      values (new.org_id, new.quote_id, new.id, new.crew_id, case when coalesce(new.is_special, false) then 'special_on' else 'special_off' end,
              left(new.title, 300), '{}'::jsonb, v_uid, v_kind);
    end if;
    if new.status is distinct from old.status then
      insert into public.event_task_log (org_id, quote_id, task_id, crew_id, kind, title, detail, actor, actor_kind)
      select new.org_id, new.quote_id, new.id, new.crew_id, k, left(new.title, 300),
             jsonb_build_object('from', old.status, 'to', new.status, 'reason', left(coalesce(new.cancel_reason, ''), 200)), v_uid, v_kind
        from (select case new.status when 'accepted' then 'accepted' when 'rejected' then 'rejected' when 'in_progress' then 'started'
                                     when 'completed' then 'completed' when 'cancelled' then 'cancelled'
                                     when 'assigned' then 'reopened' when 'unassigned' then 'unassigned' end as k) s
       where s.k is not null;
    end if;
  exception when others then
    null;   -- the log is a nice-to-have: the task change always goes through
  end;
  return new;
end $$;

do $$ begin
  if not exists (select 1 from pg_trigger where tgrelid = 'public.event_tasks'::regclass and tgname = 'zzz_r368_task_log') then
    create trigger zzz_r368_task_log after insert or update on public.event_tasks for each row execute function public._r368_task_log();
  end if;
end $$;

-- ---- 3) trigger on crew_checkins (check-in / check-out / office edit) --------------------------------------------------------------
create or replace function public._r368_checkin_log()
returns trigger language plpgsql security definer set search_path = '' as $$
-- r184-0368
declare v_kind text := public._r368_actor_kind(); v_uid uuid := auth.uid();
begin
  begin
    if tg_op = 'INSERT' then
      insert into public.event_task_log (org_id, quote_id, crew_id, kind, detail, actor, actor_kind, at)
      values (new.org_id, new.quote_id, new.crew_id, 'check_in',
              jsonb_build_object('day', new.work_day, 'late_min', new.late_min, 'within', new.in_within, 'source', new.source),
              v_uid, v_kind, case when new.source = 'office' then now() else new.check_in_at end);
      if new.check_out_at is not null then
        insert into public.event_task_log (org_id, quote_id, crew_id, kind, detail, actor, actor_kind, at)
        values (new.org_id, new.quote_id, new.crew_id, 'check_out', jsonb_build_object('day', new.work_day, 'source', new.source),
                v_uid, v_kind, case when new.source = 'office' then now() else new.check_out_at end);
      end if;
      return new;
    end if;
    if old.check_out_at is null and new.check_out_at is not null and new.edited_at is not distinct from old.edited_at then
      insert into public.event_task_log (org_id, quote_id, crew_id, kind, detail, actor, actor_kind, at)
      values (new.org_id, new.quote_id, new.crew_id, 'check_out', jsonb_build_object('day', new.work_day, 'within', new.out_within),
              v_uid, v_kind, new.check_out_at);
    elsif new.edited_at is distinct from old.edited_at
       or new.check_in_at is distinct from old.check_in_at or new.check_out_at is distinct from old.check_out_at then
      insert into public.event_task_log (org_id, quote_id, crew_id, kind, detail, actor, actor_kind)
      values (new.org_id, new.quote_id, new.crew_id, 'check_edit',
              jsonb_build_object('day', new.work_day, 'in', new.check_in_at, 'out', new.check_out_at, 'note', left(coalesce(new.edit_note, ''), 200)),
              v_uid, v_kind);
    end if;
  exception when others then
    null;
  end;
  return new;
end $$;

do $$ begin
  if to_regclass('public.crew_checkins') is not null
     and not exists (select 1 from pg_trigger where tgrelid = 'public.crew_checkins'::regclass and tgname = 'zzz_r368_checkin_log') then
    create trigger zzz_r368_checkin_log after insert or update on public.crew_checkins for each row execute function public._r368_checkin_log();
  end if;
end $$;

-- ---- 4) event_day_activity: the timeline for the office -----------------------------------------------------------------------------------
create or replace function public.event_day_activity(p_quote uuid, p_limit integer default 200)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
-- r184-0368
declare
  v_org uuid := public.current_org_id();
  v_role text;
  v_lim integer := least(greatest(coalesce(p_limit, 200), 1), 500);
begin
  if auth.uid() is null or v_org is null then raise exception 'not authorized' using errcode = '42501'; end if;
  select lower(coalesce(pr.role, '')) into v_role from public.profiles pr where pr.id = auth.uid() and pr.org_id = v_org;
  if coalesce(v_role, '') in ('crew', 'worker')
     or not (public.has_area('staff', 'view') or public.has_area('calendar', 'view') or public.has_area('quotes', 'view')) then
    raise exception 'not authorized' using errcode = '42501'; end if;
  if p_quote is null or not exists (select 1 from public.quotes q where q.id = p_quote and q.org_id = v_org and q.deleted_at is null) then
    raise exception 'event not found' using errcode = 'P0002'; end if;
  return coalesce((
    select jsonb_agg(jsonb_build_object('at', a.at, 'kind', a.kind, 'task_id', a.task_id, 'title', a.title, 'crew_id', a.crew_id,
                                        'name', a.name, 'by', a.by_kind, 'by_name', a.by_name, 'detail', a.detail, 'source', a.src)
                     order by a.at desc)
      from (
        select x.* from (
          -- (a) the log (from 0368 on)
          select l.at, l.kind, l.task_id, l.title, l.crew_id, cm.name, l.actor_kind as by_kind,
                 case when l.actor_kind = 'office' then coalesce(nullif(btrim(pr.full_name), ''), 'Office')
                      when l.actor_kind = 'staff' then coalesce(cm.name, 'Staff') else 'Helm' end as by_name,
                 l.detail, 'log'::text as src
            from public.event_task_log l
            left join public.crew_members cm on cm.id = l.crew_id
            left join public.profiles pr on pr.id = l.actor
           where l.quote_id = p_quote and l.org_id = v_org
          union all
          -- (b) task step times recorded before the log existed (skipped when the log already has that step for the task)
          select s.at, s.kind, t.id, t.title, t.crew_id, coalesce(cm.name, t.assignee_name), s.by_kind,
                 case when s.by_kind = 'staff' then coalesce(cm.name, t.assignee_name, 'Staff') else 'Office' end,
                 '{}'::jsonb, 'task'
            from public.event_tasks t
            left join public.crew_members cm on cm.id = t.crew_id
            cross join lateral (values
              (t.created_at, case when t.crew_id is not null or nullif(btrim(coalesce(t.assignee_name, '')), '') is not null then 'assigned' end, 'office'),
              (t.responded_at, case when t.status = 'rejected' then 'rejected' when t.responded_at is not null then 'accepted' end, 'staff'),
              (t.started_at, 'started', 'staff'),
              (t.completed_at, 'completed', 'staff'),
              (t.cancelled_at, 'cancelled', 'office')) as s(at, kind, by_kind)
           where t.quote_id = p_quote and t.org_id = v_org and s.at is not null and s.kind is not null
             and not exists (select 1 from public.event_task_log l2 where l2.task_id = t.id and l2.kind = s.kind)
          union all
          -- (c) check-ins / check-outs recorded before the log existed
          select c.at, c.kind, null::uuid, null::text, k.crew_id, cm.name, 'staff', coalesce(cm.name, 'Staff'),
                 jsonb_build_object('day', k.work_day, 'late_min', case when c.kind = 'check_in' then k.late_min end), 'checkin'
            from public.crew_checkins k
            left join public.crew_members cm on cm.id = k.crew_id
            cross join lateral (values (k.check_in_at, 'check_in'), (k.check_out_at, 'check_out')) as c(at, kind)
           where k.quote_id = p_quote and k.org_id = v_org and c.at is not null
             and not exists (select 1 from public.event_task_log l3 where l3.quote_id = k.quote_id and l3.crew_id = k.crew_id
                                and l3.kind = c.kind and (l3.detail ->> 'day') = k.work_day::text)
          union all
          -- (d) e-mails Helm sent to staff for this event (reminders, new work, updates)
          select e.sent_at, 'email_sent', e.task_id, t.title, e.crew_id, coalesce(cm.name, e.name), 'system', 'Helm',
                 jsonb_build_object('email_kind', e.kind), 'email'
            from public.staff_email_outbox e
            left join public.event_tasks t on t.id = e.task_id
            left join public.crew_members cm on cm.id = e.crew_id
           where e.quote_id = p_quote and e.org_id = v_org and e.status = 'sent' and e.sent_at is not null
          union all
          -- (e) "your tasks were updated" e-mails (0363)
          select u.sent_at, 'email_sent', null::uuid, null::text, u.crew_id, coalesce(cm.name, u.name), 'system', 'Helm',
                 jsonb_build_object('email_kind', 'task_update', 'changes', u.change_count), 'email'
            from public.staff_update_outbox u
            left join public.crew_members cm on cm.id = u.crew_id
           where u.quote_id = p_quote and u.org_id = v_org and u.status = 'sent' and u.sent_at is not null
        ) x
        order by x.at desc
        limit v_lim
      ) a), '[]'::jsonb);
end $$;

-- least privilege: the helpers and triggers are server-only; the timeline is for signed-in office users only
do $$ declare f text; begin
  foreach f in array array['public._r368_actor_kind()', 'public._r368_task_log()', 'public._r368_checkin_log()', 'public.event_day_activity(uuid,integer)'] loop
    execute format('revoke all on function %s from public', f);
    if exists (select 1 from pg_roles where rolname = 'anon') then execute format('revoke all on function %s from anon', f); end if;
    if exists (select 1 from pg_roles where rolname = 'authenticated') then execute format('revoke all on function %s from authenticated', f); end if;
  end loop;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    execute 'grant execute on function public.event_day_activity(uuid,integer) to authenticated'; end if;
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    execute 'grant execute on function public.event_day_activity(uuid,integer) to service_role'; end if;
end $$;

-- ---- 5) free-trial retention (0184): log rows go with the studio data (like staff_links 0363, member_presence 0366) ---------------
do $$ declare v_def text; begin
  if to_regprocedure('public._tr184_purge_tables()') is not null then
    v_def := pg_get_functiondef('public._tr184_purge_tables()'::regprocedure);
    if position('''event_task_log''' in v_def) = 0 then
      if position('''staff_links'', ''member_presence''' in v_def) > 0 then
        execute replace(v_def, '''staff_links'', ''member_presence''', '''staff_links'', ''member_presence'', ''event_task_log''');
      elsif position('''staff_links'', ''assign_notify_outbox''' in v_def) > 0 then
        execute replace(v_def, '''staff_links'', ''assign_notify_outbox''', '''staff_links'', ''event_task_log'', ''assign_notify_outbox''');
      else
        raise notice '0368: _tr184_purge_tables has an unexpected body - left unchanged';
      end if;
    end if;
  end if;
end $$;

-- VERIFY every line should say true
select item, ok from (values
  ('01 activity log table, RLS on, closed to the app', to_regclass('public.event_task_log') is not null
     and coalesce((select c.relrowsecurity from pg_class c where c.oid = to_regclass('public.event_task_log')), false)
     and not has_table_privilege('authenticated', 'public.event_task_log', 'select')
     and not has_table_privilege('anon', 'public.event_task_log', 'select')),
  ('02 task and check-in triggers', exists (select 1 from pg_trigger where tgrelid = to_regclass('public.event_tasks') and tgname = 'zzz_r368_task_log')
     and (to_regclass('public.crew_checkins') is null
          or exists (select 1 from pg_trigger where tgrelid = to_regclass('public.crew_checkins') and tgname = 'zzz_r368_checkin_log'))),
  ('03 timeline for signed-in office only', has_function_privilege('authenticated', 'public.event_day_activity(uuid,integer)', 'execute')
     and not has_function_privilege('anon', 'public.event_day_activity(uuid,integer)', 'execute')),
  ('04 helpers server only', not has_function_privilege('authenticated', 'public._r368_task_log()', 'execute')
     and not has_function_privilege('authenticated', 'public._r368_checkin_log()', 'execute')
     and not has_function_privilege('authenticated', 'public._r368_actor_kind()', 'execute')),
  ('05 free-trial purge knows the log (or 0184 is absent)', to_regprocedure('public._tr184_purge_tables()') is null
     or position('event_task_log' in pg_get_functiondef(to_regprocedure('public._tr184_purge_tables()'))) > 0)
) v(item, ok) order by item;
