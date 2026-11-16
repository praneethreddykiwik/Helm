-- APPLY-0364 (R173 task timing: reminders at an exact time like 6:32 PM, e-mail reminders without a phone number). Run on STAGING first, then production. Safe to run twice.
-- Adds exact-time reminders to tasks and lets e-mail reminders reach staff who have no phone number. Nothing is changed or deleted. If it stops with a STOP message nothing was applied.
begin;
-- 0364_r173_task_timing.sql - R173 (owner, 16 Nov 2026: "not only minutes - a custom time, e.g. at 6:32 PM; I want to
-- assign a task at 6 PM with reminders 10 and 5 min before; make it perfect and clear").
-- REQUIRES 0338 (task reminders: task_reminder_tick, task_wa_outbox, _r338_queue), 0361 (staff e-mail: staff_email_outbox,
-- _r361_on, _r361_live, _r361_person), 0132 (_assign132_phone).
--
-- What it does, in plain words:
--   1  event_tasks.remind_at: up to 8 reminders at an exact clock time (for example 6:32 PM), next to the existing
--      "minutes before" times (remind_before). Empty = none. Each one must be at or before the task start and at most
--      24 hours before it.
--   2  set_task_reminder_times(task, times): the Schedule task popup and the Assign work form save those times (Staff edit,
--      own studio only). A new time in the past is refused; a time saved earlier may stay.
--   3  task_reminder_tick is wrapped once (old body kept as task_reminder_tick__pre0364). The new body is the same rules,
--      plus two things:
--        a) exact-time reminders: queued once when their time comes (at most 10 minutes late; a time missed by more is
--           marked skipped, never sent late). The same moment as a minutes-before reminder is not sent twice.
--        b) a person with NO phone number on the task still gets the e-mail reminders (before, late) when their staff record
--           has an e-mail. These rows are queued as skipped / email_only, so WhatsApp never tries them; a new trigger turns
--           them into e-mails. People with a phone number: exactly as before (same keys, so nothing is sent twice).
--   4  _r364_tg_email_only: the e-mail for those email_only rows (same e-mail queue, same switch, same live-event checks).
--
-- ZERO DATA LOSS: additive + idempotent. One new column, new functions, one function wrapped once (old body kept), one new
-- trigger. Nothing dropped, nothing deleted. Safe to run twice. ASCII only.

-- ---- 0) preflight ---------------------------------------------------------------------------------------------------
do $$
begin
  if to_regclass('public.task_wa_outbox') is null or to_regprocedure('public._r338_queue(public.event_tasks,uuid,text,text,text,text,text,text,jsonb,text,timestamptz,text,text)') is null then
    raise exception 'STOP 0364: run 0338 (task reminders) first'; end if;
  if to_regprocedure('public.task_reminder_tick(timestamptz)') is null and to_regprocedure('public.task_reminder_tick__pre0364(timestamptz)') is null then
    raise exception 'STOP 0364: task_reminder_tick missing - run 0338 first'; end if;
  if to_regclass('public.staff_email_outbox') is null or to_regprocedure('public._r361_person(uuid,uuid,text)') is null
     or to_regprocedure('public._r361_on(uuid)') is null or to_regprocedure('public._r361_live(uuid,uuid)') is null then
    raise exception 'STOP 0364: run 0361 (staff e-mail) first'; end if;
  if to_regprocedure('public._assign132_phone(text)') is null then raise exception 'STOP 0364: run 0132 first'; end if;
  if to_regprocedure('public.has_area(text,text)') is null or to_regprocedure('public.current_org_id()') is null then
    raise exception 'STOP 0364: has_area / current_org_id missing'; end if;
end $$;

-- ---- 1) exact reminder times on a task --------------------------------------------------------------------------------
alter table public.event_tasks add column if not exists remind_at timestamptz[];
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'event_tasks_remind_at_chk364') then
    alter table public.event_tasks add constraint event_tasks_remind_at_chk364
      check (remind_at is null or (cardinality(remind_at) between 1 and 8 and array_position(remind_at, null) is null));
  end if;
end $$;

-- ---- 2) save the exact times (Schedule popup / Assign form) --------------------------------------------------------------
-- answer { ok, remind_at }; errors (errcode 22023): no_start_time | after_start | too_early | in_past | invalid_times
create or replace function public.set_task_reminder_times(p_task uuid, p_at timestamptz[])
returns jsonb language plpgsql volatile security definer set search_path = '' as $fn$
-- r173-0364
declare v_org uuid := public.current_org_id(); t public.event_tasks; v timestamptz[]; a timestamptz;
begin
  if auth.uid() is null or v_org is null or not coalesce(public.has_area('staff', 'edit'), false) then
    raise exception 'not authorized' using errcode = '42501'; end if;
  select * into t from public.event_tasks x where x.id = p_task and x.org_id = v_org for update;
  if t.id is null then raise exception 'not found' using errcode = 'P0002'; end if;
  if p_at is not null and cardinality(p_at) > 0 then
    if cardinality(p_at) > 8 or array_position(p_at, null) is not null then
      raise exception 'invalid_times' using errcode = '22023'; end if;
    if t.planned_start is null then raise exception 'no_start_time' using errcode = '22023'; end if;
    foreach a in array p_at loop
      if a > t.planned_start then raise exception 'after_start' using errcode = '22023'; end if;
      if a < t.planned_start - interval '24 hours' then raise exception 'too_early' using errcode = '22023'; end if;
      -- a time saved before may stay (it may already have gone out); a NEW time must not be in the past
      if a < now() - interval '1 minute' and not (a = any(coalesce(t.remind_at, '{}'::timestamptz[]))) then
        raise exception 'in_past' using errcode = '22023'; end if;
    end loop;
    select array_agg(distinct x order by x) into v from unnest(p_at) x;
  end if;
  update public.event_tasks set remind_at = v where id = t.id and org_id = v_org;
  return jsonb_build_object('ok', true, 'remind_at', to_jsonb(v));
end $fn$;

-- ---- 3) the every-minute timer: wrapped once (old body kept) ---------------------------------------------------------------
do $$
declare v_src text;
begin
  select p.prosrc into v_src from pg_proc p where p.oid = to_regprocedure('public.task_reminder_tick(timestamptz)');
  if position('r173-0364' in coalesce(v_src, '')) = 0 and to_regprocedure('public.task_reminder_tick__pre0364(timestamptz)') is null then
    alter function public.task_reminder_tick(timestamptz) rename to task_reminder_tick__pre0364;
  end if;
  if to_regprocedure('public.task_reminder_tick__pre0364(timestamptz)') is null then
    raise exception 'STOP 0364: task_reminder_tick could not be kept as task_reminder_tick__pre0364'; end if;
end $$;

create or replace function public.task_reminder_tick(p_now timestamptz default null)
returns jsonb language plpgsql volatile security definer set search_path = '' as $fn$
-- r173-0364: the 0338 rules (r130-0338), plus exact-time reminders (event_tasks.remind_at) and e-mail-only reminders for a
-- person with no phone number. pg_cron every minute. Queues; comms-dispatch sends. p_now: tests only; null = now().
declare r record; c jsonb; v_phone text; v_base text; v_ev jsonb; v_link text; v_name text; v_task text; v_when text;
        v_mins integer[]; m integer; k integer; v_every integer; v_max integer; v_at timestamptz; v_best text; v_best_at timestamptz;
        v_dep public.event_tasks; v_now timestamptz := coalesce(p_now, now()); v_n integer := 0; v_skip integer := 0; v_mgr text; v_mgr_name text;
        v_who text; v_st text; v_rs text; v_a timestamptz; v_ak text; v_params jsonb;
begin
  for r in
    select t as t, q.org_id as org_id, q.manager_id as manager_id
      from public.event_tasks t join public.quotes q on q.id = t.quote_id and q.org_id = t.org_id
     where t.planned_start is not null
       and t.planned_start between v_now - interval '1 day' and v_now + interval '25 hours'
       and t.status in ('assigned', 'accepted')
       and coalesce(t.assignee_kind, 'in_house') = 'in_house'
       and q.deleted_at is null and coalesce(q.status, '') <> 'cancelled'
  loop
    begin
      c := public._r338_cfg(r.org_id);
      if not coalesce((c ->> 'enabled')::boolean, true) then continue; end if;
      if coalesce(public.trial_send_blocked(r.org_id, (r.t).quote_id, null), false) then continue; end if;   -- free trial: nothing leaves Helm
      v_phone := public._assign132_phone((r.t).assignee_phone);
      if v_phone is null then
        -- R173: no phone on the task -> e-mail only (by the staff record), never WhatsApp
        if (r.t).crew_id is null then continue; end if;
        v_who := 'c' || (r.t).crew_id::text; v_st := 'skipped'; v_rs := 'email_only';
      else
        v_who := v_phone; v_st := 'queued'; v_rs := null;
      end if;
      -- waiting on an unfinished earlier task: hold (studio setting)
      if (r.t).depends_on is not null and coalesce((c ->> 'hold_waiting')::boolean, true) then
        select * into v_dep from public.event_tasks d where d.id = (r.t).depends_on;
        if found and v_dep.status is distinct from 'completed' and v_dep.status is distinct from 'cancelled' then continue; end if;
      end if;
      v_base := (r.t).id::text || '|' || extract(epoch from (r.t).planned_start)::bigint::text || '|' || v_who || '|';
      v_ev := public._r338_event((r.t).quote_id);
      v_link := public._r338_link((r.t).quote_id, r.org_id, v_phone);
      v_name := public._r338_f(split_part(btrim(coalesce((r.t).assignee_name, '')), ' ', 1), 60);
      v_task := public._r338_f((r.t).title, 100);
      v_when := public._r338_time((r.t).planned_start, r.org_id);
      v_every := greatest(5, coalesce((c ->> 'late_every_min')::integer, 15));
      v_max := greatest(0, coalesce((c ->> 'late_max')::integer, 3));
      v_params := jsonb_build_array(v_name, v_task, public._r338_f(v_ev ->> 'event', 100), public._r338_f(v_when, 20),
                    greatest(0, ceil(extract(epoch from ((r.t).planned_start - v_now)) / 60))::integer::text, '@link');

      -- (a) before the start: the latest due "before" time only; earlier missed ones are marked skipped
      if v_now < (r.t).planned_start + interval '2 minutes' then
        if (r.t).remind_before is not null then v_mins := (r.t).remind_before;
        else select coalesce(array_agg(x::integer), '{}') into v_mins from jsonb_array_elements_text(c -> 'default_before') x; end if;
        v_best := null; v_best_at := null;
        foreach m in array coalesce(v_mins, '{}'::integer[]) loop
          v_at := (r.t).planned_start - make_interval(mins => m);
          if v_at <= v_now and not exists (select 1 from public.task_wa_outbox o where o.slot_key = v_base || 'b' || m) then
            if v_best_at is null or v_at > v_best_at then
              if v_best is not null then
                perform public._r338_queue(r.t, r.org_id, 'reminder', v_best, v_base || v_best, v_phone, (r.t).assignee_name, 'staff_task_reminder', '[]'::jsonb, v_link, v_best_at, 'skipped', 'superseded');
                v_skip := v_skip + 1;
              end if;
              v_best := 'b' || m; v_best_at := v_at;
            else
              perform public._r338_queue(r.t, r.org_id, 'reminder', 'b' || m, v_base || 'b' || m, v_phone, (r.t).assignee_name, 'staff_task_reminder', '[]'::jsonb, v_link, v_at, 'skipped', 'superseded');
              v_skip := v_skip + 1;
            end if;
          end if;
        end loop;
        if v_best is not null and public._r338_queue(r.t, r.org_id, 'reminder', v_best, v_base || v_best, v_phone, (r.t).assignee_name, 'staff_task_reminder',
             v_params, v_link, v_best_at, v_st, v_rs) then
          v_n := v_n + 1;
        end if;

        -- (a2) R173: reminders at an exact clock time (at or before the start, at most 24 hours before it)
        if (r.t).remind_at is not null then
          foreach v_a in array (r.t).remind_at loop
            continue when v_a is null or v_a > v_now or v_a > (r.t).planned_start or v_a < (r.t).planned_start - interval '24 hours';
            v_ak := 'at' || extract(epoch from v_a)::bigint::text;
            -- once per task, person and moment (a new start time does not repeat a reminder that already went)
            continue when exists (select 1 from public.task_wa_outbox o where o.task_id = (r.t).id and o.slot = v_ak
                                    and o.phone is not distinct from v_phone);
            if exists (select 1 from public.task_wa_outbox o where o.task_id = (r.t).id and o.kind = 'reminder' and o.due_at = v_a
                         and o.phone is not distinct from v_phone and o.status <> 'skipped') then
              -- the same moment as a minutes-before reminder that already went: do not send it twice
              perform public._r338_queue(r.t, r.org_id, 'reminder', v_ak, v_base || v_ak, v_phone, (r.t).assignee_name, 'staff_task_reminder', '[]'::jsonb, v_link, v_a, 'skipped', 'same_time');
              v_skip := v_skip + 1;
            elsif v_a < v_now - interval '10 minutes' then
              -- missed by more than 10 minutes (timer was off, time saved late): never sent late
              perform public._r338_queue(r.t, r.org_id, 'reminder', v_ak, v_base || v_ak, v_phone, (r.t).assignee_name, 'staff_task_reminder', '[]'::jsonb, v_link, v_a, 'skipped', 'missed');
              v_skip := v_skip + 1;
            elsif public._r338_queue(r.t, r.org_id, 'reminder', v_ak, v_base || v_ak, v_phone, (r.t).assignee_name, 'staff_task_reminder',
                    v_params, v_link, v_a, v_st, v_rs) then
              v_n := v_n + 1;
            end if;
          end loop;
        end if;
      end if;

      -- (b) late: not started after the start time -> every N minutes, up to M times (latest due only).
      if (r.t).planned_start < v_now - make_interval(mins => (v_max + 2) * v_every) then continue; end if;
      v_best := null; v_best_at := null;
      for k in 1 .. v_max loop
        v_at := (r.t).planned_start + make_interval(mins => k * v_every);
        if v_at <= v_now and not exists (select 1 from public.task_wa_outbox o where o.slot_key = v_base || 'late' || k) then
          if v_best is not null then
            perform public._r338_queue(r.t, r.org_id, 'late', v_best, v_base || v_best, v_phone, (r.t).assignee_name, 'staff_task_overdue', '[]'::jsonb, v_link, v_best_at, 'skipped', 'superseded');
            v_skip := v_skip + 1;
          end if;
          v_best := 'late' || k; v_best_at := v_at;
        end if;
      end loop;
      if v_best is not null and public._r338_queue(r.t, r.org_id, 'late', v_best, v_base || v_best, v_phone, (r.t).assignee_name, 'staff_task_overdue',
           jsonb_build_array(v_name, v_task, public._r338_f(v_ev ->> 'event', 100), public._r338_f(v_when, 20), '@link'), v_link, v_best_at, v_st, v_rs) then
        v_n := v_n + 1;
      end if;

      -- (c) office alert: once, after the last late reminder (or one interval after the start when late reminders are off)
      if coalesce((c ->> 'alert_office')::boolean, true)
         and v_now >= (r.t).planned_start + make_interval(mins => greatest(v_max, 1) * v_every)
         and not exists (select 1 from public.task_wa_outbox o where o.slot_key = v_base || 'alert') then
        v_mgr := null; v_mgr_name := null;
        if r.manager_id is not null then
          select public._assign132_phone(cm.phone), cm.name into v_mgr, v_mgr_name from public.crew_members cm
           where cm.org_id = r.org_id and cm.profile_id = r.manager_id and cm.phone is not null limit 1;
        end if;
        perform public._r23_notify((r.t).quote_id, 'task_overdue', jsonb_build_object('task', (r.t).title, 'worker', (r.t).assignee_name,
          'start', v_when, 'reminders', v_max, 'task_id', (r.t).id));
        if public._r338_queue(r.t, r.org_id, 'office_alert', 'alert', v_base || 'alert', v_mgr, v_mgr_name, 'office_staff_alert',
             jsonb_build_array(public._r338_f((r.t).assignee_name, 80), 'task not started', v_task, public._r338_f(v_ev ->> 'event', 100),
               public._r338_f(public._r338_day((r.t).planned_start, r.org_id) || ' ' || coalesce(v_when, ''), 40),
               case when v_max > 0 then 'no start after ' || v_max || ' reminder' || case when v_max = 1 then '' else 's' end else 'not started on time' end, '@link'),
             'ops.html?quote=' || (r.t).quote_id::text, v_now,
             case when v_mgr is null then 'skipped' else 'queued' end, case when v_mgr is null then 'no_event_manager_phone' end) then
          v_n := v_n + 1;
        end if;
      end if;
    exception when others then
      raise warning 'r173-0364: task % reminder skipped (%)', (r.t).id, sqlstate;
    end;
  end loop;
  return jsonb_build_object('queued', v_n, 'skipped', v_skip);
end $fn$;

-- ---- 4) e-mail for the e-mail-only rows (a person with no phone number) ------------------------------------------------------
create or replace function public._r364_tg_email_only()
returns trigger language plpgsql security definer set search_path = '' as $fn$
-- r173-0364: same e-mail as the 0361 mirror, for task_wa_outbox rows queued as skipped / email_only. Never fails the insert.
declare t public.event_tasks; v_p jsonb;
begin
  begin
    if new.kind not in ('reminder', 'late') or new.status <> 'skipped' or coalesce(new.reason, '') <> 'email_only' then return null; end if;
    if not public._r361_on(new.org_id) or not public._r361_live(new.org_id, new.quote_id) then return null; end if;
    select * into t from public.event_tasks x where x.id = new.task_id and x.org_id = new.org_id;
    if t.id is null or t.crew_id is null then return null; end if;
    v_p := public._r361_person(new.org_id, t.crew_id, null::text);
    if v_p is null then return null; end if;
    insert into public.staff_email_outbox (org_id, quote_id, task_id, crew_id, phone, kind, recipient, name, dedupe_key, ref_start, not_before)
    values (new.org_id, new.quote_id, t.id, (v_p ->> 'crew_id')::uuid, null,
            case new.kind when 'reminder' then 'task_reminder' else 'task_late' end,
            v_p ->> 'email', left(v_p ->> 'name', 120), 'rem|' || new.slot_key, t.planned_start, now())
    on conflict (dedupe_key) do nothing;
  exception when others then
    raise warning 'r173-0364: e-mail-only reminder not queued (%)', sqlstate;
  end;
  return null;
end $fn$;

do $$ begin
  if not exists (select 1 from pg_trigger where tgrelid = 'public.task_wa_outbox'::regclass and tgname = 'zzz_r364_email_only') then
    create trigger zzz_r364_email_only after insert on public.task_wa_outbox
      for each row when (new.status = 'skipped' and new.reason = 'email_only') execute function public._r364_tg_email_only();
  end if;
end $$;

-- ---- 5) grants: the save button for signed-in staff; the rest for the server only -------------------------------------------
do $$
declare f text;
begin
  foreach f in array array['public.set_task_reminder_times(uuid,timestamptz[])', 'public.task_reminder_tick(timestamptz)',
                           'public.task_reminder_tick__pre0364(timestamptz)', 'public._r364_tg_email_only()'] loop
    execute format('revoke all on function %s from public', f);
    if exists (select 1 from pg_roles where rolname = 'anon') then execute format('revoke all on function %s from anon', f); end if;
    if exists (select 1 from pg_roles where rolname = 'authenticated') then execute format('revoke all on function %s from authenticated', f); end if;
    if exists (select 1 from pg_roles where rolname = 'service_role') then execute format('grant execute on function %s to service_role', f); end if;
  end loop;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    execute 'grant execute on function public.set_task_reminder_times(uuid,timestamptz[]) to authenticated';
  end if;
end $$;

-- VERIFY every line should say true
select item, ok from (values
  ('01 exact reminder times column', exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'event_tasks' and column_name = 'remind_at')),
  ('02 save exact times: signed-in staff only', coalesce(has_function_privilege('authenticated', 'public.set_task_reminder_times(uuid,timestamptz[])', 'execute')
     and not has_function_privilege('anon', 'public.set_task_reminder_times(uuid,timestamptz[])', 'execute'), false)),
  ('03 timer wrapped once (old body kept)', to_regprocedure('public.task_reminder_tick__pre0364(timestamptz)') is not null
     and position('r173-0364' in coalesce(pg_get_functiondef(to_regprocedure('public.task_reminder_tick(timestamptz)')), '')) > 0),
  ('04 timer server only', not has_function_privilege('authenticated', 'public.task_reminder_tick(timestamptz)', 'execute')
     and not has_function_privilege('anon', 'public.task_reminder_tick(timestamptz)', 'execute')
     and not has_function_privilege('authenticated', 'public.task_reminder_tick__pre0364(timestamptz)', 'execute')),
  ('05 e-mail-only reminder trigger', exists (select 1 from pg_trigger where tgrelid = to_regclass('public.task_wa_outbox') and tgname = 'zzz_r364_email_only'))
) v(item, ok) order by item;
commit;
