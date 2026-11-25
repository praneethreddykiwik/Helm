-- 0434_r252_start_now.sql - R252 "You can start now" for tasks that wait for another task (owner, 24 Nov 2026; approved for
-- STAGING, later Canada production and Mumbai). Forward-only, additive, safe to run twice. ASCII only.
-- REQUIRES 0283, 0311 / 0312, 0338, 0361, 0363, 0364, 0367, 0369, 0396 (0385 for the tasks page; 0399 and 0432 optional).
--
-- In plain words - the gap: a task can wait for an earlier task (event_tasks.depends_on). Helm already HOLDS the reminders of a
--   waiting task, but nobody is told when it may begin, and a task without a start time is never reminded at all.
-- What 0434 does:
--   A  When a task becomes completed (or is cancelled - the same rule the reminder hold uses), every task of the same event and
--      studio that waits for it and has not started gets "You can start now", once per (waiting task, earlier task, time it was
--      finished): a bell for the login of the person on it, one e-mail (the 0363 change-notice queue, one line with the exact
--      words), one WhatsApp (the 0132 queue, the existing template staff_task_changed). No edge function change.
--      No person on the task: a bell for the event manager and the department supervisor (0399). A vendor's task: a bell for
--      the event manager. A person Helm cannot reach: a bell for the event manager ("Tell Ravi ...").
--   B  When the earlier task is turned down: one bell for the event manager. When it is late by more than the studio's
--      late interval (Settings -> Task reminders, 15 min by default), or the waiting task should have started: one bell.
--   C  While a task waits (and the studio holds waiting tasks): the special-task reminders (0367) and the escalation ladder
--      (0369) do not blame the person who cannot start yet. After the earlier task is done, the "not started" reminders, the
--      ladder and the office alert count from the moment it was done, not from the old start time. The red latest-start bell
--      (0396) still comes (the plan IS at risk) but names the earlier task: "Waiting for Stage build: Drape - ...".
--      Each edit is ONE exact piece of an existing body (0432 way; old body kept as <name>__pre0434; unexpected body = left).
--   D  worker_get_tasks answers waits_for { title, done } per task (one more field, nothing else changes).
--      my_tasks no longer calls a task blocked when the task it waits for was cancelled.
--   E  Studio switch: task_reminder_settings.start_now (default ON), read / written by task_reminder_settings_get / _set
--      ({"start_now": false}). The big "Task reminders" switch off = nothing from 0434 either.
-- NEVER SENDS: sample events, cancelled / deleted / closed events, events over for 3+ days, read-only studios, system changes
--   (SQL editor / migrations). Free trial: the bell only - nothing leaves Helm.
-- A problem while telling people never blocks or rolls back the status change (raise warning, like the neighbours).
-- ACCESS: new functions and the new table are server only (RLS on, no grants to anon / authenticated).
-- ZERO DATA LOSS: 1 table, 1 column (default true), 3 indexes, functions, 1 trigger. No stored row changed. Safe to run twice.
-- SWITCH OFF (nothing deleted): alter table public.event_tasks disable trigger zzz_r434_start_now;  (enable trigger = on again)
-- ROLLBACK (manual, only if ever needed): the line above, and for each kept body: create the function again from <name>__pre0434.

-- ---- 0) preflight -----------------------------------------------------------------------------------------------------------
do $$ declare f text; begin
  if to_regclass('public.event_tasks') is null or to_regclass('public.task_reminder_settings') is null
     or to_regclass('public.assign_notify_outbox') is null or to_regclass('public.staff_update_outbox') is null then
    raise exception 'STOP 0434: run 0132, 0338 and 0363 first (task reminder tables missing)'; end if;
  if not exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'event_tasks' and column_name = 'cancelled_at') then
    raise exception 'STOP 0434: run 0312 first (event_tasks.cancelled_at missing)'; end if;
  foreach f in array array['public._is_system_change()', 'public.trial_send_blocked(uuid,uuid,uuid)', 'public._trial_locked(uuid)',
      'public._studio_writable(uuid)', 'public._r283_is_off(uuid,uuid)', 'public._r283_off_phone(uuid,text)', 'public._assign132_phone(text)',
      'public._r338_event(uuid)', 'public._r338_f(text,integer)', 'public._r338_link(uuid,uuid,text)', 'public._r338_time(timestamptz,uuid)',
      'public._r361_on(uuid)', 'public._r361_person(uuid,uuid,text)', 'public._r363_can(uuid,uuid,boolean)', 'public.studio_today(uuid,timestamptz)',
      'public.task_reminder_tick(timestamptz)', 'public.assign_notify_claim(integer)', 'public.task_reminder_settings_get()',
      'public.task_reminder_settings_set(jsonb)', 'public.worker_get_tasks(uuid)'] loop
    if to_regprocedure(f) is null then raise exception 'STOP 0434: % is missing - an earlier update is not on this database', f; end if;
  end loop;
end $$;

-- ---- 1) the studio switch, the once-only ledger, the indexes -------------------------------------------------------------------
alter table public.task_reminder_settings add column if not exists start_now boolean not null default true;

create table if not exists public.task_start_notices (
  id          uuid primary key default gen_random_uuid(),
  org_id      uuid not null references public.organizations(id),
  quote_id    uuid not null references public.quotes(id) on delete cascade,
  task_id     uuid not null references public.event_tasks(id) on delete cascade,
  earlier_id  uuid not null references public.event_tasks(id) on delete cascade,
  kind        text not null,
  slot_key    text not null,
  state_at    timestamptz not null,
  bells       integer not null default 0,
  email       boolean not null default false,
  wa_id       uuid,
  created_at  timestamptz not null default now(),
  constraint task_start_notices_kind_chk434 check (kind in ('start_now', 'wait_rejected', 'wait_late'))
);
create unique index if not exists task_start_notices_slot_uk434 on public.task_start_notices (slot_key);
create index if not exists task_start_notices_quote434 on public.task_start_notices (quote_id);
create index if not exists task_start_notices_task434 on public.task_start_notices (task_id);
create index if not exists task_start_notices_earlier434 on public.task_start_notices (earlier_id);
create index if not exists task_start_notices_org434 on public.task_start_notices (org_id);
create index if not exists task_start_notices_wa434 on public.task_start_notices (wa_id) where wa_id is not null;
-- "who waits for this task?" (the trigger and the late check)
create index if not exists ix_event_tasks_depends_on_0434 on public.event_tasks (depends_on) where depends_on is not null;

alter table public.task_start_notices enable row level security;
do $$ declare r text; v_def text; begin
  revoke all on table public.task_start_notices from public;
  foreach r in array array['anon', 'authenticated', 'service_role'] loop
    if exists (select 1 from pg_roles where rolname = r) then execute format('revoke all on table public.task_start_notices from %I', r); end if;
  end loop;
  if exists (select 1 from pg_roles where rolname = 'service_role') then execute 'grant select on table public.task_start_notices to service_role'; end if;
  if to_regprocedure('public.tg_quote_org_match()') is not null
     and not exists (select 1 from pg_trigger where tgrelid = 'public.task_start_notices'::regclass and tgname = 'zz_quote_org_match') then
    create trigger zz_quote_org_match before insert or update on public.task_start_notices for each row execute function public.tg_quote_org_match();
  end if;
  if to_regprocedure('public.tg_studio_read_only()') is not null
     and not exists (select 1 from pg_trigger where tgrelid = 'public.task_start_notices'::regclass and tgname = 'zzz_studio_read_only') then
    create trigger zzz_studio_read_only before insert or update or delete on public.task_start_notices for each row execute function public.tg_studio_read_only('org_id');
  end if;
  -- free-trial retention (0184): goes with the studio's events (patched in place once, like 0396)
  if to_regprocedure('public._tr184_purge_tables()') is not null then
    v_def := pg_get_functiondef('public._tr184_purge_tables()'::regprocedure);
    if position('''task_start_notices''' in v_def) = 0 then
      if (length(v_def) - length(replace(v_def, '''event_ready_alert_sends'', ', ''))) / length('''event_ready_alert_sends'', ') <> 1 then
        raise notice '0434: _tr184_purge_tables has an unexpected body - left unchanged';
      else execute replace(v_def, '''event_ready_alert_sends'', ', '''task_start_notices'', ''event_ready_alert_sends'', '); end if;
    end if;
  end if;
end $$;

-- ---- 2) keep helper (same shape as _r432_keep) ---------------------------------------------------------------------------------
create or replace function public._r434_keep(p_fn text)
returns void language plpgsql volatile security definer set search_path = '' as $$
declare v_oid oid := to_regprocedure(p_fn); v_name text; v_types text; v_def text; v_pre text; r text;
begin
  if v_oid is null then return; end if;
  select p.proname, oidvectortypes(p.proargtypes) into v_name, v_types from pg_proc p where p.oid = v_oid;
  v_pre := format('public.%I(%s)', v_name || '__pre0434', v_types);
  if to_regprocedure(v_pre) is null then
    v_def := pg_get_functiondef(v_oid);
    v_def := regexp_replace(v_def, '^CREATE OR REPLACE FUNCTION public\.' || v_name || '\(',
                            'CREATE OR REPLACE FUNCTION public.' || v_name || '__pre0434(');
    if position(v_name || '__pre0434(' in v_def) = 0 then raise exception 'r252-0434: could not keep %', p_fn; end if;
    execute v_def;
  end if;
  execute format('revoke all on function %s from public', v_pre);
  foreach r in array array['anon', 'authenticated', 'service_role'] loop
    if exists (select 1 from pg_roles where rolname = r) then execute format('revoke all on function %s from %I', v_pre, r); end if;
  end loop;
end $$;

-- ---- 3) small helpers (server only) ----------------------------------------------------------------------------------------------
-- the studio's reminder switches this update uses (defaults when it never saved any)
create or replace function public._r434_cfg(p_org uuid)
returns jsonb language sql stable security definer set search_path = '' as $$
  -- r252-0434
  select coalesce((select jsonb_build_object('on', s.enabled and s.start_now, 'office', s.alert_office, 'hold', s.hold_waiting, 'late_min', s.late_every_min)
                     from public.task_reminder_settings s where s.org_id = p_org),
                  jsonb_build_object('on', true, 'office', true, 'hold', true, 'late_min', 15));
$$;
-- is this task held? (exactly the 0364 hold: the earlier task is neither completed nor cancelled, and the studio holds waiting tasks)
create or replace function public._r434_held(p_dep uuid, p_org uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  -- r252-0434
  select p_dep is not null
     and coalesce((select s.hold_waiting from public.task_reminder_settings s where s.org_id = p_org), true)
     and exists (select 1 from public.event_tasks d where d.id = p_dep and d.org_id = p_org
                   and d.status is distinct from 'completed' and d.status is distinct from 'cancelled');
$$;
-- when the earlier task was finished (null = it waits for nothing / not finished / the studio does not hold waiting tasks)
create or replace function public._r434_released(p_dep uuid, p_org uuid)
returns timestamptz language sql stable security definer set search_path = '' as $$
  -- r252-0434
  select least(case d.status when 'completed' then d.completed_at when 'cancelled' then d.cancelled_at end, now())
    from public.event_tasks d
   where p_dep is not null and d.id = p_dep and d.org_id = p_org and d.status in ('completed', 'cancelled')
     and coalesce((select s.hold_waiting from public.task_reminder_settings s where s.org_id = p_org), true);
$$;
-- the first words of the red latest-start bell (0396): the earlier task is named while the task cannot start
create or replace function public._r434_lead(p_task uuid)
returns text language sql stable security definer set search_path = '' as $$
  -- r252-0434
  select coalesce((select 'Waiting for ' || left(coalesce(nullif(btrim(d.title), ''), 'another task'), 60) || ': '
                     from public.event_tasks t join public.event_tasks d on d.id = t.depends_on and d.org_id = t.org_id
                    where t.id = p_task and d.status is distinct from 'completed' and d.status is distinct from 'cancelled'), 'Not started: ');
$$;
-- the event's short name when Helm may tell people about its tasks now, else null
create or replace function public._r434_event(p_org uuid, p_quote uuid)
returns text language sql stable security definer set search_path = '' as $$
  -- r252-0434: live, not a sample, not over for 3+ days; the studio is not read-only
  select left(coalesce(nullif(btrim(q.title), ''), nullif(btrim(q.code), ''), 'event'), 60)
    from public.quotes q
   where q.id = p_quote and q.org_id = p_org and p_org is not null and q.deleted_at is null
     and not coalesce(q.is_demo, false)
     and coalesce(q.status, '') not in ('cancelled', 'lost', 'rejected')
     and coalesce(q.lifecycle_stage, '') not in ('closed', 'cancelled')
     and (q.event_date is null
          or greatest(q.event_date, (to_jsonb(q) ->> 'event_end_date')::date) >= public.studio_today(p_org) - 3)
     and not coalesce(public._trial_locked(p_org), false)
     and coalesce(public._studio_writable(p_org), true)
     and not exists (select 1 from public.organizations o where o.id = p_org and o.is_sample_master);
$$;
-- the event manager's login (office role, active); none -> the active admins
create or replace function public._r434_manager(p_org uuid, p_quote uuid)
returns jsonb language sql stable security definer set search_path = '' as $$
  -- r252-0434
  with m as (
    select p.id from public.quotes q join public.profiles p on p.id = q.manager_id and p.org_id = q.org_id
     where q.id = p_quote and q.org_id = p_org
       and lower(coalesce(p.role, '')) not in ('', 'client', 'crew', 'worker') and not coalesce(public._r283_is_off(p.id, p_org), false)
  )
  select case when exists (select 1 from m) then (select jsonb_agg(m.id::text) from m)
              else coalesce((select jsonb_agg(p.id::text) from public.profiles p
                              where p.org_id = p_org and lower(coalesce(p.role, '')) = 'admin' and not coalesce(public._r283_is_off(p.id, p_org), false)),
                            '[]'::jsonb) end;
$$;
-- one bell row, seen only by the people in p_notify (the 0369 / 0396 targeted kind); -> how many people
create or replace function public._r434_bell(p_org uuid, p_quote uuid, p_task uuid, p_label text, p_via text, p_notify jsonb)
returns integer language plpgsql volatile security definer set search_path = '' as $$
-- r252-0434
begin
  if p_notify is null or jsonb_typeof(p_notify) <> 'array' or jsonb_array_length(p_notify) = 0 then return 0; end if;
  insert into public.notifications (quote_id, channel, kind, status, detail, org_id)
  values (p_quote, 'in_app', 'task_escalated', 'simulated',
          jsonb_build_object('label', left(p_label, 300), 'task_id', p_task, 'notify', p_notify, 'source', '0434', 'via', p_via), p_org);
  return jsonb_array_length(p_notify);
exception when others then
  raise warning 'r252-0434: bell notice skipped (%)', sqlstate;
  return 0;
end $$;
-- one line in the person's waiting change notice (0363 queue), sent at once instead of after 5 quiet minutes; -> queued?
create or replace function public._r434_mail(p_org uuid, p_quote uuid, p_crew uuid, p_phone text, p_line text)
returns boolean language plpgsql volatile security definer set search_path = '' as $$
-- r252-0434
declare v_p jsonb; v_st text;
begin
  if not public._r361_on(p_org) or not public._r363_can(p_org, p_quote, false) then return false; end if;
  v_p := public._r361_person(p_org, p_crew, p_phone);
  if v_p is null then return false; end if;
  insert into public.staff_update_outbox as u (org_id, quote_id, crew_id, phone, recipient, name, changes, change_count, not_before)
  values (p_org, p_quote, (v_p ->> 'crew_id')::uuid, p_phone, v_p ->> 'email', left(v_p ->> 'name', 120),
          jsonb_build_array(left(p_line, 200)), 1, now())
  on conflict (quote_id, recipient) where status = 'pending' and sent_at is null and claimed_at is null
  do update set
    changes = case when u.changes @> excluded.changes then u.changes
                   else (select coalesce(jsonb_agg(z.v order by z.o), '[]'::jsonb) from (
                           select v, o from jsonb_array_elements(excluded.changes || u.changes) with ordinality a(v, o) order by o limit 30) z) end,
    change_count = u.change_count + case when u.changes @> excluded.changes then 0 else 1 end,
    last_at = now(), not_before = now(), updated_at = now()
  returning u.status into v_st;
  return coalesce(v_st, '') = 'pending';
exception when others then
  raise warning 'r252-0434: e-mail not queued (%)', sqlstate;
  return false;
end $$;
-- one WhatsApp in the 0132 queue with the existing template staff_task_changed; -> the row id (null = not queued)
create or replace function public._r434_wa(p_org uuid, p_quote uuid, p_task uuid, p_phone text, p_name text, p_title text, p_why text)
returns uuid language plpgsql volatile security definer set search_path = '' as $$
-- r252-0434
declare v_id uuid; v_st text; v_first text; v_event text; v_link text;
begin
  if p_phone is null or coalesce(public._r283_off_phone(p_org, p_phone), false) then return null; end if;
  v_first := split_part(btrim(coalesce(p_name, '')), ' ', 1);
  v_event := public._r338_f(public._r338_event(p_quote) ->> 'event', 100);
  v_link := public._r338_link(p_quote, p_org, p_phone);
  insert into public.assign_notify_outbox (org_id, quote_id, item_kind, item_id, phone, name, body, link_path, created_by)
  values (p_org, p_quote, 'task', p_task, p_phone, left(nullif(btrim(p_name), ''), 120),
          left(regexp_replace('Hi ' || coalesce(nullif(v_first, ''), 'there') || ', you can start now: ' || left(p_title, 100) || ' (' || v_event || '). '
            || p_why || '.' || case when v_link is not null then ' Open your link:' else '' end, '[[:cntrl:]<>]', ' ', 'g'), 880),
          v_link, auth.uid())
  returning id into v_id;
  if v_id is null then return null; end if;
  -- the insert trigger (0338) fills the "task assigned" template; this message is the "task changed" one
  update public.assign_notify_outbox
     set template = 'staff_task_changed',
         params = jsonb_build_array(public._r338_f(v_first, 60), public._r338_f(p_title, 100), v_event, public._r338_f('you can start now - ' || p_why, 150))
   where id = v_id and sent_at is null
   returning status into v_st;
  return case when v_st = 'pending' then v_id end;
exception when others then
  raise warning 'r252-0434: WhatsApp not queued (%)', sqlstate;
  return null;
end $$;

-- ---- 4) a task was finished / cancelled / turned down: tell the tasks that wait for it ------------------------------------------
create or replace function public._r434_closed(d public.event_tasks, p_at timestamptz)
returns integer language plpgsql volatile security definer set search_path = '' as $$
-- r252-0434: once per (waiting task, earlier task, moment) - the ledger's unique key
declare w public.event_tasks; v_id uuid; v_ev text; v_kind text; v_why text; v_dt text; v_wt text; v_line text; v_who text;
        v_crew public.crew_members; v_phone text; v_login uuid; v_bells integer; v_mail boolean; v_wa uuid; v_list jsonb; v_sup uuid;
        v_trial boolean; v_n integer := 0;
begin
  if not exists (select 1 from public.event_tasks x where x.depends_on = d.id and x.org_id = d.org_id and x.quote_id = d.quote_id
                   and x.id <> d.id and x.status in ('unassigned', 'assigned', 'accepted')) then return 0; end if;
  if not (public._r434_cfg(d.org_id) ->> 'on')::boolean then return 0; end if;
  v_ev := public._r434_event(d.org_id, d.quote_id);
  if v_ev is null then return 0; end if;
  v_trial := coalesce(public.trial_send_blocked(d.org_id, d.quote_id, null), false);
  v_kind := case when d.status = 'rejected' then 'wait_rejected' else 'start_now' end;
  v_dt := left(coalesce(nullif(btrim(d.title), ''), 'The earlier task'), 70);
  v_why := v_dt || case d.status when 'cancelled' then ' was cancelled' else ' is done' end;
  for w in
    select t.* from public.event_tasks t
     where t.depends_on = d.id and t.org_id = d.org_id and t.quote_id = d.quote_id and t.id <> d.id
       and t.status in ('unassigned', 'assigned', 'accepted')
     order by t.planned_start nulls last, t.category, t.seq, t.id limit 50
  loop
    begin
      v_id := null; v_crew := null; v_phone := null; v_login := null; v_bells := 0; v_mail := false; v_wa := null; v_sup := null;
      insert into public.task_start_notices (org_id, quote_id, task_id, earlier_id, kind, slot_key, state_at)
      values (w.org_id, w.quote_id, w.id, d.id, v_kind,
              v_kind || '|' || w.id::text || '|' || d.id::text || '|' || floor(extract(epoch from p_at) * 1000000)::bigint::text, p_at)
      on conflict (slot_key) do nothing returning id into v_id;
      continue when v_id is null;
      v_wt := left(coalesce(nullif(btrim(w.title), ''), 'A task'), 70);
      v_list := public._r434_manager(w.org_id, w.quote_id);

      if v_kind = 'wait_rejected' then
        v_bells := public._r434_bell(w.org_id, w.quote_id, w.id,
          v_wt || ' is waiting for ' || v_dt || ', which was turned down' || coalesce(' by ' || left(nullif(btrim(d.assignee_name), ''), 40), '')
            || '. Give it to someone else (' || v_ev || ')', 'wait_rejected', v_list);
      elsif coalesce(w.assignee_kind, 'in_house') <> 'in_house' then
        -- a vendor's task: Helm does not message vendors about tasks, the event manager tells them
        select nullif(btrim(v.name), '') into v_who from public.vendors v where v.id = w.vendor_id and v.org_id = w.org_id;
        v_bells := public._r434_bell(w.org_id, w.quote_id, w.id,
          coalesce(left(coalesce(v_who, nullif(btrim(w.assignee_name), '')), 50), 'The vendor') || ' (vendor) can start now: ' || v_wt || ' - ' || v_why || ' (' || v_ev || ')',
          'start_now_vendor', v_list);
      elsif w.crew_id is null and public._assign132_phone(w.assignee_phone) is null and nullif(btrim(coalesce(w.assignee_name, '')), '') is null then
        -- nobody on it: the event manager, and the department supervisor (0399)
        if to_regclass('public.event_department_supervisors') is not null then
          select s.profile_id into v_sup from public.event_department_supervisors s join public.profiles p on p.id = s.profile_id and p.org_id = s.org_id
           where s.quote_id = w.quote_id and s.org_id = w.org_id and s.department = btrim(coalesce(w.category, ''))
             and lower(coalesce(p.role, '')) not in ('', 'client', 'crew', 'worker') and not coalesce(public._r283_is_off(p.id, w.org_id), false);
          if v_sup is not null and not (v_list ? v_sup::text) then v_list := v_list || jsonb_build_array(v_sup::text); end if;
        end if;
        v_bells := public._r434_bell(w.org_id, w.quote_id, w.id,
          v_wt || ' can start now - ' || v_why || '. Nobody is on it yet (' || v_ev || ')', 'start_now_office', v_list);
      else
        -- the person on the task: by staff id, else the one active staff member with this phone
        v_phone := public._assign132_phone(w.assignee_phone);
        if w.crew_id is not null then
          select * into v_crew from public.crew_members c where c.id = w.crew_id and c.org_id = w.org_id;
        elsif v_phone is not null and (select count(*) from public.crew_members c where c.org_id = w.org_id and c.active and public._assign132_phone(c.phone) = v_phone) = 1 then
          select * into v_crew from public.crew_members c where c.org_id = w.org_id and c.active and public._assign132_phone(c.phone) = v_phone;
        end if;
        v_phone := coalesce(v_phone, public._assign132_phone(v_crew.phone));
        v_line := 'You can start now: ' || v_wt || ' - ' || v_why;
        if v_crew.profile_id is not null then
          select p.id into v_login from public.profiles p where p.id = v_crew.profile_id and p.org_id = w.org_id
             and lower(coalesce(p.role, '')) not in ('', 'client') and not coalesce(public._r283_is_off(p.id, w.org_id), false);
        end if;
        if v_login is not null then
          v_bells := public._r434_bell(w.org_id, w.quote_id, w.id, v_line || ' (' || v_ev || ')', 'start_now', jsonb_build_array(v_login::text));
        end if;
        -- a switched-off team member gets nothing, whatever address the staff record carries
        if not v_trial and not (v_crew.profile_id is not null and coalesce(public._r283_is_off(v_crew.profile_id, w.org_id), false)) then
          v_mail := public._r434_mail(w.org_id, w.quote_id, w.crew_id, v_phone, v_line);
          v_wa := public._r434_wa(w.org_id, w.quote_id, w.id, v_phone, coalesce(nullif(btrim(w.assignee_name), ''), v_crew.name), v_wt, v_why);
        end if;
        -- nobody was reached: the event manager tells the person
        if v_bells = 0 and not v_mail and (v_wa is null or not coalesce(public._r337_wa_ready(w.org_id), false)) then
          v_bells := public._r434_bell(w.org_id, w.quote_id, w.id,
            'Tell ' || coalesce(left(coalesce(nullif(btrim(w.assignee_name), ''), v_crew.name), 40), 'the person on it') || ': ' || v_wt || ' can start now - ' || v_why
              || '. Helm could not message this person (' || v_ev || ')', 'start_now_office', v_list);
        end if;
      end if;
      update public.task_start_notices set bells = v_bells, email = v_mail, wa_id = v_wa where id = v_id;
      v_n := v_n + 1;
    exception when others then
      raise warning 'r252-0434: task % not told (%)', w.id, sqlstate;
    end;
  end loop;
  return v_n;
end $$;

create or replace function public._r434_tg_start_now()
returns trigger language plpgsql security definer set search_path = '' as $$
-- r252-0434: never blocks or undoes the status change; system changes stay quiet (0164)
declare v_at timestamptz;
begin
  begin
    if public._is_system_change() then return null; end if;
    -- the moment of THIS change (a completion time left over from an earlier round is not a new one)
    v_at := case when new.status = 'completed' and new.completed_at is distinct from old.completed_at then new.completed_at
                 when new.status = 'cancelled' and new.cancelled_at is distinct from old.cancelled_at then new.cancelled_at end;
    perform public._r434_closed(new, coalesce(v_at, now()));
  exception when others then
    raise warning 'r252-0434: waiting tasks not told (%)', sqlstate;
  end;
  return null;
end $$;

do $$ begin
  if not exists (select 1 from pg_trigger where tgrelid = 'public.event_tasks'::regclass and tgname = 'zzz_r434_start_now') then
    create trigger zzz_r434_start_now after update of status on public.event_tasks
      for each row when (old.status is distinct from new.status and new.status in ('completed', 'cancelled', 'rejected'))
      execute function public._r434_tg_start_now();
  end if;
end $$;

-- ---- 5) the earlier task is late: one bell for the event manager (inside the every-minute job, cheap check first) -----------------
create or replace function public._r434_wait_due(p_now timestamptz)
returns boolean language sql stable security definer set search_path = '' as $$
  -- r252-0434: index lookups only (planned_start 0344, depends_on 0434); wider than the real rule, never narrower
  select exists (select 1 from public.event_tasks d
                  where d.planned_start between coalesce(p_now, now()) - interval '1 day' and coalesce(p_now, now()) - interval '5 minutes'
                    and d.status in ('unassigned', 'assigned', 'accepted', 'in_progress')
                    and exists (select 1 from public.event_tasks w where w.depends_on = d.id and w.status in ('unassigned', 'assigned', 'accepted')))
      or exists (select 1 from public.event_tasks w
                  where w.planned_start between coalesce(p_now, now()) - interval '1 day' and coalesce(p_now, now()) - interval '5 minutes'
                    and w.depends_on is not null and w.status in ('unassigned', 'assigned', 'accepted')
                    and exists (select 1 from public.event_tasks d where d.id = w.depends_on and d.status in ('unassigned', 'assigned', 'accepted', 'in_progress')));
$$;

create or replace function public._r434_wait_tick(p_now timestamptz default null)
returns integer language plpgsql volatile security definer set search_path = '' as $$
-- r252-0434: bell only, once per (waiting task, earlier task, planned start). p_now: tests only.
declare r record; c jsonb; v_now timestamptz := coalesce(p_now, now()); v_late integer; v_min integer; v_id uuid; v_ev text; v_label text;
        v_dt text; v_wt text; v_n integer := 0; v_b integer;
begin
  for r in
    select x.w, x.d, x.slot from (
      select w, d, 'wait_late|' || w.id::text || '|' || d.id::text || '|' || extract(epoch from coalesce(d.planned_start, w.planned_start))::bigint::text as slot
        from (
          select a.id as did, b.id as wid from public.event_tasks a join public.event_tasks b on b.depends_on = a.id
           where a.planned_start between v_now - interval '1 day' and v_now - interval '5 minutes'
          union
          select b.depends_on, b.id from public.event_tasks b
           where b.depends_on is not null and b.planned_start between v_now - interval '1 day' and v_now - interval '5 minutes'
        ) k
        join public.event_tasks d on d.id = k.did and d.status in ('unassigned', 'assigned', 'accepted', 'in_progress')
        join public.event_tasks w on w.id = k.wid and w.status in ('unassigned', 'assigned', 'accepted')
                                 and w.org_id = d.org_id and w.quote_id = d.quote_id and w.id <> d.id
    ) x
    where not exists (select 1 from public.task_start_notices n where n.slot_key = x.slot)
    limit 200
  loop
    begin
      c := public._r434_cfg((r.w).org_id);
      if not (c ->> 'on')::boolean or not (c ->> 'office')::boolean then continue; end if;
      v_min := greatest(5, coalesce((c ->> 'late_min')::integer, 15));
      v_late := null;
      if (r.d).status in ('unassigned', 'assigned', 'accepted') and (r.d).planned_start + make_interval(mins => v_min) < v_now then
        v_late := floor(extract(epoch from (v_now - (r.d).planned_start)) / 60)::integer;
      elsif (r.d).status = 'in_progress' and (r.d).planned_end + make_interval(mins => v_min) < v_now then
        v_late := floor(extract(epoch from (v_now - (r.d).planned_end)) / 60)::integer;
      end if;
      if v_late is null and not coalesce((r.w).planned_start + make_interval(mins => v_min) < v_now, false) then continue; end if;
      v_ev := public._r434_event((r.w).org_id, (r.w).quote_id);
      continue when v_ev is null;
      v_id := null;
      insert into public.task_start_notices (org_id, quote_id, task_id, earlier_id, kind, slot_key, state_at)
      values ((r.w).org_id, (r.w).quote_id, (r.w).id, (r.d).id, 'wait_late', r.slot, v_now)
      on conflict (slot_key) do nothing returning id into v_id;
      continue when v_id is null;
      v_wt := left(coalesce(nullif(btrim((r.w).title), ''), 'A task'), 70);
      v_dt := left(coalesce(nullif(btrim((r.d).title), ''), 'another task'), 70);
      v_label := case when v_late is not null then v_wt || ' is waiting for ' || v_dt || ', which is ' || v_late || ' min late'
                      else v_wt || ' was due at ' || coalesce(public._r338_time((r.w).planned_start, (r.w).org_id), '-') || ' and is waiting for ' || v_dt || ', which is not done yet' end
                 || coalesce(' (' || left(nullif(btrim((r.d).assignee_name), ''), 40) || ')', '') || ' - ' || v_ev;
      v_b := public._r434_bell((r.w).org_id, (r.w).quote_id, (r.d).id, v_label, 'wait_late', public._r434_manager((r.w).org_id, (r.w).quote_id));
      update public.task_start_notices set bells = v_b where id = v_id;
      v_n := v_n + 1;
    exception when others then
      raise warning 'r252-0434: late waiting task % skipped (%)', (r.w).id, sqlstate;
    end;
  end loop;
  return v_n;
end $$;

-- ---- 6) exact text edits of existing bodies (0432 way: every piece must be there exactly once, else the body is left as it is) -----
do $do$
declare r record; v_oid oid; v_def text; v_new text; e jsonb; v_ok boolean;
begin
  for r in select * from (values
    -- the normal "not started" reminders + office alert (0364): count from the moment the earlier task was done, when that is later
    ('public.task_reminder_tick__pre0367(timestamptz)', jsonb_build_array(
      jsonb_build_array('v_at := (r.t).planned_start + make_interval(mins => k * v_every);',
                        'v_at := greatest((r.t).planned_start, public._r434_released((r.t).depends_on, r.org_id)) + make_interval(mins => k * v_every); /* r252-0434 */'),
      jsonb_build_array('if (r.t).planned_start < v_now - make_interval(mins => (v_max + 2) * v_every) then continue; end if;',
                        'if greatest((r.t).planned_start, public._r434_released((r.t).depends_on, r.org_id)) < v_now - make_interval(mins => (v_max + 2) * v_every) then continue; end if;'),
      jsonb_build_array('and v_now >= (r.t).planned_start + make_interval(mins => greatest(v_max, 1) * v_every)',
                        'and v_now >= greatest((r.t).planned_start, public._r434_released((r.t).depends_on, r.org_id)) + make_interval(mins => greatest(v_max, 1) * v_every)'))),
    -- special-task reminders (0367): held while waiting, then counted from the release
    ('public._r367_special_tick(timestamptz)', jsonb_build_array(
      jsonb_build_array('and t.status in (''assigned'', ''accepted'')', 'and t.status in (''assigned'', ''accepted'') and not public._r434_held(t.depends_on, t.org_id) /* r252-0434 */'),
      jsonb_build_array('v_at := (r.t).planned_start + make_interval(mins => k * v_every);',
                        'v_at := greatest((r.t).planned_start, public._r434_released((r.t).depends_on, r.org_id)) + make_interval(mins => k * v_every);'))),
    -- special-task escalation ladder (0369): held while waiting, steps counted from the release
    ('public._r369_escalation_tick(timestamptz)', jsonb_build_array(
      jsonb_build_array('and t.status in (''assigned'', ''accepted'')', 'and t.status in (''assigned'', ''accepted'') and not public._r434_held(t.depends_on, t.org_id) /* r252-0434 */'),
      jsonb_build_array('v_at := (r.t).planned_start + make_interval(mins => v_steps[k + 1]);',
                        'v_at := greatest((r.t).planned_start, public._r434_released((r.t).depends_on, r.org_id)) + make_interval(mins => v_steps[k + 1]);'))),
    -- the red latest-start bell (0396): same bell, same people, names the earlier task while the job cannot start
    ('public.event_ready_alert_tick()', jsonb_build_array(
      jsonb_build_array('''Not started: '' || v_title || '' - latest start was ''', 'public._r434_lead(s.task_id) /* r252-0434 */ || v_title || '' - latest start was '''))),
    -- my_tasks: a cancelled earlier task blocks nothing
    ('public.my_tasks()', jsonb_build_array(
      jsonb_build_array('where d.id = t.depends_on and d.completed_at is null)', 'where d.id = t.depends_on and d.completed_at is null and coalesce(d.status, '''') not in (''completed'', ''cancelled'') /* r252-0434 */)')))
  ) v(fn, edits) loop
    v_oid := to_regprocedure(r.fn);
    if v_oid is null then raise notice '0434: % not on this database - left unchanged', r.fn; continue; end if;
    v_def := pg_get_functiondef(v_oid);
    if position('r252-0434' in v_def) > 0 then continue; end if;            -- already done (second run)
    v_new := v_def; v_ok := true;
    for e in select x from jsonb_array_elements(r.edits) x loop
      if (length(v_new) - length(replace(v_new, e ->> 0, ''))) / length(e ->> 0) <> 1 then v_ok := false; exit; end if;
      v_new := replace(v_new, e ->> 0, e ->> 1);
    end loop;
    if not v_ok then raise notice '0434: % has an unexpected body - left unchanged', r.fn; continue; end if;
    perform public._r434_keep(r.fn);
    execute v_new;
  end loop;
end $do$;

-- ---- 7) wrappers (same name, signature and grants; the old body kept as <name>__pre0434, server only) -------------------------------
do $$ begin
  perform public._r434_keep(f) from unnest(array['public.task_reminder_tick(timestamptz)', 'public.assign_notify_claim(integer)',
    'public.task_reminder_settings_get()', 'public.task_reminder_settings_set(jsonb)', 'public.worker_get_tasks(uuid)']) f
   where position('r252-0434' in pg_get_functiondef(to_regprocedure(f))) = 0;
end $$;

create or replace function public.task_reminder_tick(p_now timestamptz default null)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
-- r252-0434: the r249-0432 every-minute job unchanged (kept as task_reminder_tick__pre0434 = the r186-0369 escalation over the
-- r179-0367 / r173-0364 timer), then "the earlier task is late" bells. A failure there never stops the reminders.
declare v jsonb := public.task_reminder_tick__pre0434(p_now);
begin
  begin
    if public._r434_wait_due(p_now) then perform public._r434_wait_tick(p_now); end if;
  exception when others then raise warning 'r252-0434: late waiting tasks skipped (%)', sqlstate;
  end;
  return v;
end $$;

create or replace function public.assign_notify_claim(p_limit integer default 25)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
-- r252-0434: a waiting "you can start now" WhatsApp is dropped when the task has started / is closed, or after 2 hours; then the
-- r33-0283 claim unchanged (kept as assign_notify_claim__pre0434, over assign_notify_claim__pre0283)
begin
  begin
    update public.assign_notify_outbox a set status = 'skipped', sent_at = now(), updated_at = now()
      from public.task_start_notices n
     where n.wa_id = a.id and a.sent_at is null and a.status = 'pending'
       and (a.created_at < now() - interval '2 hours'
            or not exists (select 1 from public.event_tasks t where t.id = n.task_id and t.org_id = n.org_id and t.status in ('assigned', 'accepted')));
  exception when others then raise warning 'r252-0434: start notices not re-checked (%)', sqlstate;
  end;
  return public.assign_notify_claim__pre0434(p_limit);
end $$;

create or replace function public.task_reminder_settings_get()
returns jsonb language plpgsql stable security definer set search_path = '' as $$
-- r252-0434: the r130-0338 answer + start_now
declare v jsonb := public.task_reminder_settings_get__pre0434();
begin
  return v || jsonb_build_object('start_now', coalesce((select s.start_now from public.task_reminder_settings s where s.org_id = public.current_org_id()), true));
end $$;

create or replace function public.task_reminder_settings_set(p jsonb)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
-- r252-0434: the r130-0338 save (its checks and its refusals first), then start_now when the page sends it
begin
  perform public.task_reminder_settings_set__pre0434(p);
  if p ? 'start_now' then
    if jsonb_typeof(p -> 'start_now') <> 'boolean' then raise exception 'invalid_start_now' using errcode = '22023'; end if;
    update public.task_reminder_settings set start_now = (p ->> 'start_now')::boolean where org_id = public.current_org_id();
  end if;
  return public.task_reminder_settings_get();
end $$;

create or replace function public.worker_get_tasks(p_token uuid)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
-- r252-0434: the 0012 answer (kept as worker_get_tasks__pre0434: the link check + limit _work_token_live(p_token) happens there); each task also carries
-- waits_for { title, done } when it waits for another task of the same event, else null. Nothing else changes.
declare v jsonb := public.worker_get_tasks__pre0434(p_token);
begin
  if jsonb_typeof(v -> 'tasks') is distinct from 'array' then return v; end if;
  return jsonb_set(v, '{tasks}', coalesce((
    select jsonb_agg(x.j || jsonb_build_object('waits_for', (
             select jsonb_build_object('title', left(d.title, 120), 'done', d.status in ('completed', 'cancelled'))
               from public.event_tasks t join public.event_tasks d on d.id = t.depends_on and d.org_id = t.org_id and d.quote_id = t.quote_id
              where t.id::text = x.j ->> 'id')) order by x.o)
      from jsonb_array_elements(v -> 'tasks') with ordinality x(j, o)), '[]'::jsonb));
exception when undefined_function or undefined_column or data_exception then
  return v;   -- the extra field is a nice-to-have: the worker page always gets its tasks
end $$;

-- ---- 8) grants: new functions server only; the wrapped names keep exactly the grants they had ---------------------------------------
do $$ declare f text; r text; begin
  foreach f in array array['public._r434_keep(text)', 'public._r434_cfg(uuid)', 'public._r434_held(uuid,uuid)', 'public._r434_released(uuid,uuid)',
      'public._r434_lead(uuid)', 'public._r434_event(uuid,uuid)', 'public._r434_manager(uuid,uuid)',
      'public._r434_bell(uuid,uuid,uuid,text,text,jsonb)', 'public._r434_mail(uuid,uuid,uuid,text,text)',
      'public._r434_wa(uuid,uuid,uuid,text,text,text,text)', 'public._r434_closed(public.event_tasks,timestamptz)',
      'public._r434_tg_start_now()', 'public._r434_wait_due(timestamptz)', 'public._r434_wait_tick(timestamptz)'] loop
    execute format('revoke all on function %s from public', f);
    foreach r in array array['anon', 'authenticated', 'service_role'] loop
      if exists (select 1 from pg_roles where rolname = r) then execute format('revoke all on function %s from %I', f, r); end if;
    end loop;
  end loop;
  foreach f in array array['public.task_reminder_tick(timestamptz)', 'public.assign_notify_claim(integer)'] loop
    execute format('revoke all on function %s from public', f);
    if exists (select 1 from pg_roles where rolname = 'anon') then execute format('revoke all on function %s from anon, authenticated', f); end if;
    if exists (select 1 from pg_roles where rolname = 'service_role') then execute format('grant execute on function %s to service_role', f); end if;
  end loop;
  foreach f in array array['public.task_reminder_settings_get()', 'public.task_reminder_settings_set(jsonb)'] loop
    execute format('revoke all on function %s from public', f);
    if exists (select 1 from pg_roles where rolname = 'anon') then execute format('revoke all on function %s from anon', f); end if;
    if exists (select 1 from pg_roles where rolname = 'authenticated') then execute format('grant execute on function %s to authenticated', f); end if;
  end loop;
end $$;

do $$ begin
  if to_regclass('public.helm_schema_markers') is not null then
    insert into public.helm_schema_markers(num, name) values (434, '0434_r252_start_now') on conflict (num) do nothing;
  end if;
end $$;

notify pgrst, 'reload schema';
