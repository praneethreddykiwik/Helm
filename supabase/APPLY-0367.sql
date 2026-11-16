-- APPLY-0367 (R179 special tasks get reminders 10 and 5 min before and every 5 min until started; permanent staff link opens each event inside it). Run on STAGING first, then production. Safe to run twice.
-- Adds one function and wraps two (old bodies kept). Nothing is changed or deleted. If it stops with a STOP message nothing was applied.
begin;
-- 0367_r179_special_reminders_staff_link_event.sql - R179 (owner, 16 Nov 2026). Forward-only, additive, safe to run twice. ASCII only.
-- REQUIRES 0338 + 0364 (task_reminder_tick, task_wa_outbox, _r338_queue and helpers), 0361 (staff e-mail mirror of the timer
-- rows), 0363 (staff_links, staff_link_view).
--
-- In plain words:
--   1  Special tasks get reminders. Marking a task special (Operations, Mark special) used to send nothing (the old phase 38
--      repeat job was never switched on). Now a special task with a start time gets, by e-mail (and WhatsApp once the studio
--      number is connected):
--        * a reminder 10 minutes and 5 minutes before its start, even when the task or the studio has no reminder times
--          (the same timer slot as the normal 10 / 5 minute reminder, so nothing is ever sent twice), and
--        * if it is still not started after the start time: "Not started yet" every remind_every_min minutes (the task
--          setting, default 5, kept between 1 and 60), up to 6 times, until the person starts it.
--      The free-trial rule (nothing leaves Helm), cancelled / deleted events, done / started / cancelled tasks and outsourced
--      work are skipped exactly like the normal timer.
--      task_reminder_tick is wrapped once (old body kept as task_reminder_tick__pre0367); the pg_cron job keeps calling
--      task_reminder_tick() every minute, unchanged.
--   2  The permanent staff link page (work.html?staff=...) gets each event id (quote_id) so an event opens INSIDE the same
--      permanent link (work.html?staff=...&event=<id>) instead of jumping to a different per-event link. staff_link_view is
--      wrapped once (old body kept as staff_link_view__pre0367); same answer plus quote_id on each event that has a task link.
-- Nothing dropped, nothing deleted, no table or column changed. If it stops with a STOP message nothing was applied.

do $$ begin
  if to_regprocedure('public.task_reminder_tick(timestamptz)') is null and to_regprocedure('public.task_reminder_tick__pre0367(timestamptz)') is null then
    raise exception 'STOP 0367: task_reminder_tick missing - run 0338 and 0364 first'; end if;
  if to_regprocedure('public._r338_queue(public.event_tasks,uuid,text,text,text,text,text,text,jsonb,text,timestamptz,text,text)') is null then
    raise exception 'STOP 0367: _r338_queue missing - run 0338 first'; end if;
  if to_regprocedure('public.staff_link_view(text)') is null and to_regprocedure('public.staff_link_view__pre0367(text)') is null then
    raise exception 'STOP 0367: staff_link_view missing - run 0363 first'; end if;
end $$;

-- ---- 1) special tasks: the extra reminders (server only) -------------------------------------------------------------------
create or replace function public._r367_special_tick(p_now timestamptz default null)
returns jsonb language plpgsql volatile security definer set search_path = '' as $fn$
-- r179-0367: special tasks (event_tasks.is_special): 10 and 5 minutes before the start, then every remind_every_min minutes
-- (1..60, default 5) up to 6 times while not started. Same timer table and slots as task_reminder_tick, so the e-mail mirror
-- (0361 / 0364 triggers) and the WhatsApp sender treat these rows like any reminder; a slot is never queued twice.
declare r record; v_now timestamptz := coalesce(p_now, now()); v_n integer := 0; v_skip integer := 0;
        v_phone text; v_who text; v_st text; v_rs text; v_base text; v_ev jsonb; v_link text; v_name text; v_task text; v_when text;
        m integer; k integer; v_at timestamptz; v_every integer; v_best text; v_best_at timestamptz; v_params jsonb;
begin
  for r in
    select t as t, q.org_id as org_id
      from public.event_tasks t join public.quotes q on q.id = t.quote_id and q.org_id = t.org_id
     where t.is_special
       and t.planned_start is not null
       and t.planned_start between v_now - interval '7 hours' and v_now + interval '15 minutes'
       and t.status in ('assigned', 'accepted')
       and coalesce(t.assignee_kind, 'in_house') = 'in_house'
       and q.deleted_at is null and coalesce(q.status, '') <> 'cancelled'
  loop
    begin
      if coalesce(public.trial_send_blocked(r.org_id, (r.t).quote_id, null), false) then continue; end if;   -- free trial: nothing leaves Helm
      v_phone := public._assign132_phone((r.t).assignee_phone);
      if v_phone is null then
        if (r.t).crew_id is null then continue; end if;
        v_who := 'c' || (r.t).crew_id::text; v_st := 'skipped'; v_rs := 'email_only';
      else
        v_who := v_phone; v_st := 'queued'; v_rs := null;
      end if;
      v_base := (r.t).id::text || '|' || extract(epoch from (r.t).planned_start)::bigint::text || '|' || v_who || '|';
      v_ev := public._r338_event((r.t).quote_id);
      v_link := public._r338_link((r.t).quote_id, r.org_id, v_phone);
      v_name := public._r338_f(split_part(btrim(coalesce((r.t).assignee_name, '')), ' ', 1), 60);
      v_task := public._r338_f((r.t).title, 100);
      v_when := public._r338_time((r.t).planned_start, r.org_id);
      v_params := jsonb_build_array(v_name, v_task, public._r338_f(v_ev ->> 'event', 100), public._r338_f(v_when, 20),
                    greatest(0, ceil(extract(epoch from ((r.t).planned_start - v_now)) / 60))::integer::text, '@link');

      -- (a) 10 and 5 minutes before the start: the same slot keys as the normal timer (b10 / b5), so never twice
      if v_now < (r.t).planned_start + interval '2 minutes' then
        foreach m in array array[10, 5] loop
          v_at := (r.t).planned_start - make_interval(mins => m);
          continue when v_at > v_now;
          continue when exists (select 1 from public.task_wa_outbox o where o.slot_key = v_base || 'b' || m);
          if v_at < v_now - interval '4 minutes' or (m = 10 and (r.t).planned_start - interval '5 minutes' <= v_now) then
            -- saved too late for this one (or the 5 minute one is due too): recorded as skipped, never sent late
            perform public._r338_queue(r.t, r.org_id, 'reminder', 'b' || m, v_base || 'b' || m, v_phone, (r.t).assignee_name,
              'staff_task_reminder', '[]'::jsonb, v_link, v_at, 'skipped', 'superseded');
            v_skip := v_skip + 1;
          elsif public._r338_queue(r.t, r.org_id, 'reminder', 'b' || m, v_base || 'b' || m, v_phone, (r.t).assignee_name,
                  'staff_task_reminder', v_params, v_link, v_at, v_st, v_rs) then
            v_n := v_n + 1;
          end if;
        end loop;
      end if;

      -- (b) still not started after the start: every N minutes, up to 6 times (latest due only; earlier missed ones skipped)
      v_every := greatest(1, least(60, coalesce((r.t).remind_every_min, 5)));
      v_best := null; v_best_at := null;
      for k in 1 .. 6 loop
        v_at := (r.t).planned_start + make_interval(mins => k * v_every);
        if v_at <= v_now and not exists (select 1 from public.task_wa_outbox o where o.slot_key = v_base || 'sp' || k) then
          if v_best is not null then
            perform public._r338_queue(r.t, r.org_id, 'late', v_best, v_base || v_best, v_phone, (r.t).assignee_name,
              'staff_task_overdue', '[]'::jsonb, v_link, v_best_at, 'skipped', 'superseded');
            v_skip := v_skip + 1;
          end if;
          v_best := 'sp' || k; v_best_at := v_at;
        end if;
      end loop;
      if v_best is not null then
        if v_best_at < v_now - interval '4 minutes'
           or exists (select 1 from public.task_wa_outbox o where o.task_id = (r.t).id and o.kind = 'late'
                        and o.status <> 'skipped' and o.created_at > v_now - interval '2 minutes') then
          -- missed, or a normal late reminder just went: do not send two at once
          perform public._r338_queue(r.t, r.org_id, 'late', v_best, v_base || v_best, v_phone, (r.t).assignee_name,
            'staff_task_overdue', '[]'::jsonb, v_link, v_best_at, 'skipped', 'same_time');
          v_skip := v_skip + 1;
        elsif public._r338_queue(r.t, r.org_id, 'late', v_best, v_base || v_best, v_phone, (r.t).assignee_name, 'staff_task_overdue',
                jsonb_build_array(v_name, v_task, public._r338_f(v_ev ->> 'event', 100), public._r338_f(v_when, 20), '@link'),
                v_link, v_best_at, v_st, v_rs) then
          v_n := v_n + 1;
        end if;
      end if;
    exception when others then
      raise warning 'r179-0367: special task % reminder skipped (%)', (r.t).id, sqlstate;
    end;
  end loop;
  return jsonb_build_object('queued', v_n, 'skipped', v_skip);
end $fn$;

-- ---- 2) the every-minute timer: the 0364 body, then the special tasks (wrapped once, old body kept) ------------------------
do $$
declare v_src text;
begin
  select p.prosrc into v_src from pg_proc p where p.oid = to_regprocedure('public.task_reminder_tick(timestamptz)');
  if position('r179-0367' in coalesce(v_src, '')) = 0 and to_regprocedure('public.task_reminder_tick__pre0367(timestamptz)') is null then
    alter function public.task_reminder_tick(timestamptz) rename to task_reminder_tick__pre0367;
  end if;
  if to_regprocedure('public.task_reminder_tick__pre0367(timestamptz)') is null then
    raise exception 'STOP 0367: task_reminder_tick could not be kept as task_reminder_tick__pre0367'; end if;
end $$;

create or replace function public.task_reminder_tick(p_now timestamptz default null)
returns jsonb language plpgsql volatile security definer set search_path = '' as $fn$
-- r179-0367: the 0364 timer (task_reminder_tick__pre0367), then the special-task reminders (_r367_special_tick).
-- pg_cron every minute, unchanged. A failure in the special part never stops the normal reminders.
declare v jsonb := public.task_reminder_tick__pre0367(p_now); s jsonb;
begin
  begin s := public._r367_special_tick(p_now);
  exception when others then raise warning 'r179-0367: special reminders skipped (%)', sqlstate; s := null;
  end;
  return coalesce(v, '{}'::jsonb) || jsonb_build_object('special', coalesce(s -> 'queued', '0'::jsonb));
end $fn$;

-- ---- 3) the permanent link page: each event gets its id, so it opens inside the same link (wrapped once, old body kept) ----
do $$
declare v_src text;
begin
  select p.prosrc into v_src from pg_proc p where p.oid = to_regprocedure('public.staff_link_view(text)');
  if position('r179-0367' in coalesce(v_src, '')) = 0 and to_regprocedure('public.staff_link_view__pre0367(text)') is null then
    alter function public.staff_link_view(text) rename to staff_link_view__pre0367;
  end if;
  if to_regprocedure('public.staff_link_view__pre0367(text)') is null then
    raise exception 'STOP 0367: staff_link_view could not be kept as staff_link_view__pre0367'; end if;
end $$;

create or replace function public.staff_link_view(p_token text)
returns jsonb language plpgsql volatile security definer set search_path = '' as $fn$
-- r179-0367: the 0363 answer (staff_link_view__pre0367: same checks, rate limit and events), plus quote_id on each event
-- that has a task link (looked up from that link, so only events this person already sees). Nothing else is added.
declare v jsonb := public.staff_link_view__pre0367(p_token); e jsonb; v_out jsonb := '[]'::jsonb; v_q uuid;
begin
  if v is null or jsonb_typeof(v) <> 'object' or coalesce(v ->> 'ok', '') <> 'true' or jsonb_typeof(v -> 'events') <> 'array' then
    return v; end if;
  for e in select x from jsonb_array_elements(v -> 'events') x loop
    v_q := null;
    if coalesce(e ->> 'link', '') ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
      select wt.quote_id into v_q from public.work_tokens wt where wt.token = (e ->> 'link')::uuid limit 1;
    end if;
    v_out := v_out || jsonb_build_array(case when v_q is null then e else e || jsonb_build_object('quote_id', v_q) end);
  end loop;
  return jsonb_set(v, '{events}', v_out);
end $fn$;

-- ---- 4) grants: the link page for anyone holding a link (as before); the rest for the server only ------------------------
do $$
declare f text;
begin
  foreach f in array array['public._r367_special_tick(timestamptz)', 'public.task_reminder_tick(timestamptz)',
                           'public.task_reminder_tick__pre0367(timestamptz)', 'public.staff_link_view__pre0367(text)'] loop
    execute format('revoke all on function %s from public', f);
    if exists (select 1 from pg_roles where rolname = 'anon') then execute format('revoke all on function %s from anon', f); end if;
    if exists (select 1 from pg_roles where rolname = 'authenticated') then execute format('revoke all on function %s from authenticated', f); end if;
    if exists (select 1 from pg_roles where rolname = 'service_role') then execute format('grant execute on function %s to service_role', f); end if;
  end loop;
  execute 'revoke all on function public.staff_link_view(text) from public';
  if exists (select 1 from pg_roles where rolname = 'anon') then execute 'grant execute on function public.staff_link_view(text) to anon'; end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then execute 'grant execute on function public.staff_link_view(text) to authenticated'; end if;
  if exists (select 1 from pg_roles where rolname = 'service_role') then execute 'grant execute on function public.staff_link_view(text) to service_role'; end if;
end $$;

-- VERIFY every line should say true
select item, ok from (values
  ('01 special-task reminders function', to_regprocedure('public._r367_special_tick(timestamptz)') is not null),
  ('02 timer wrapped once (old body kept)', to_regprocedure('public.task_reminder_tick__pre0367(timestamptz)') is not null
     and position('r179-0367' in coalesce(pg_get_functiondef(to_regprocedure('public.task_reminder_tick(timestamptz)')), '')) > 0),
  ('03 timer and helpers server only', not has_function_privilege('authenticated', 'public.task_reminder_tick(timestamptz)', 'execute')
     and not has_function_privilege('authenticated', 'public._r367_special_tick(timestamptz)', 'execute')
     and not has_function_privilege('authenticated', 'public.task_reminder_tick__pre0367(timestamptz)', 'execute')),
  ('04 link page wrapped once (old body kept)', to_regprocedure('public.staff_link_view__pre0367(text)') is not null
     and position('r179-0367' in coalesce(pg_get_functiondef(to_regprocedure('public.staff_link_view(text)')), '')) > 0),
  ('05 link page open to a link holder, kept body closed', has_function_privilege('anon', 'public.staff_link_view(text)', 'execute')
     and not has_function_privilege('anon', 'public.staff_link_view__pre0367(text)', 'execute'))
) v(item, ok) order by item;
commit;
