-- APPLY-0436 (R253: "stage is done -> the flowers crew is told", a clear e-mail, rework = please hold, the department supervisor's check).
-- Run on STAGING first, then Canada production, then HELM-PROD-MUMBAI. Safe to run twice. Run 0434 BEFORE it (0435 may come before or
-- after it). It stops before changing anything if an earlier update is missing.
-- What it does:
--   * the e-mail "You can start now: Flowers (Rao wedding)" (needs the R253 comms-dispatch; with the old one the 0434 words still go out);
--   * the checker rejects the earlier task: the waiting people are asked to hold, the event manager gets one bell; done again = start again;
--   * the task pages know what each task waits for;
--   * two tasks can never wait for each other (a new "waits for" that closes a circle, or points at another event, is refused);
--   * a department supervisor may check the finished tasks of their own section on that event (never their own task).
-- No stored row is changed and nothing is deleted.
-- It waits at most 5 seconds for a lock (then stops with an error and changes nothing - just run it again later).
-- Paste the whole file into the Supabase SQL editor and press Run. The last result lists checks - every ok must be true.
begin;
set local lock_timeout = '5s';
set local statement_timeout = '5min';
-- 0436_r253_start_now_mail.sql - R253 "stage is done -> the flowers crew is told", end to end (owner, 25 Nov 2026; approved for
-- STAGING, later Canada production and Mumbai). Forward-only, additive, safe to run twice. ASCII only.
-- REQUIRES 0434 (and everything it needs), 0311, 0363, 0385, 0399.
--
-- In plain words:
--   A  E-MAIL. The "You can start now" notice of 0434 travels in the 0363 change notice. 0436 remembers which notice went into which
--      e-mail and hands the facts to the sender (staff_update_claim answers start_now: the task, its start time and section, the
--      earlier task, who finished it and when). comms-dispatch (R253) makes "You can start now: Flowers (Rao wedding)" from it. The
--      kind stays task_update and the change line stays, so an older comms-dispatch keeps sending the 0434 wording.
--      A line that is no longer true when the e-mail is picked up (rejected again, started, given to someone else) is left out.
--   B  REWORK. A checker rejects the earlier task (verify_task): everyone on a task that waits for it and is not done gets
--      "Stage set-up needs rework - please hold" once per rejection (bell, e-mail, WhatsApp with the existing template
--      staff_task_changed), and the event manager gets ONE bell that names the waiting tasks and whoever Helm could not reach.
--      Done again -> "You can start now" again ("You can go on now" for somebody who had already started and was asked to hold).
--   C  A staff record that is switched off (inactive) is treated like a deactivated login: nothing to them, the manager is told.
--   D  The task pages: worker_get_tasks, crew_event_brief, my_tasks and the permanent link (staff_link_view) answer waits_for
--      { title, done, state: waiting | rework | done | cancelled, done_at } per task (title + done = 0434).
--   E  SUPERVISOR CHECK (owner: "the supervisor / QE should have an option to approve that their crew tasks are done and verified").
--      verify_task also accepts the role supervisor, ONLY for a task whose section that person is the department supervisor of on
--      that event (0399), with Staff view, the task completed and waiting for a check, never a task the person is on; a rejection
--      needs a reason. Same update, same audit trail. Admin / manager / planner / quality exactly as before; nobody else.
--      event_department_supervisors_get answers verify { all, departments, my_crew_ids } so the page knows without another read.
--   F  NO CIRCLES. A task can never wait for itself through other tasks ("That would make the two tasks wait for each other.") and only
--      for a task of its own event - on every way that sets "waits for" (set_task_schedule, event_task_duration_set, a direct
--      change), also for two changes at the same moment. Only a NEW value is checked; stored rows are never changed.
-- NEVER SENDS: exactly the 0434 rules (_r434_event / _r434_cfg): sample, cancelled, closed, old events, read-only studios, system
--   changes, the studio's start_now / task reminders switch off = nothing. Free trial: the bell only.
-- A problem while telling people never blocks or rolls back the status change / the check.
-- ACCESS: new functions server only. verify_task and event_department_supervisors_get keep the grants they had.
-- ZERO DATA LOSS: 4 columns + 3 allowed words on task_start_notices, 2 indexes, functions, 2 triggers. No stored row changed.
-- SWITCH OFF (nothing deleted): alter table public.event_tasks disable trigger zzz_r436_rework;   (rework notices; enable = on)
--   alter table public.event_tasks disable trigger zz_r436_no_circle;   (the circle check)
--   "You can start now" itself: the 0434 switch (trigger zzz_r434_start_now, or the studio switch start_now).
-- ROLLBACK (manual, only if ever needed): paste APPLY-0434 again (start-now as in 0434), the line above, and for the kept bodies
--   (<name>__pre0436): create the function again from the kept one. If an older file (0311, 0363, 0399, 0402, 0434) is ever pasted again
--   after 0436, paste 0436 again.

-- ---- 0) preflight -----------------------------------------------------------------------------------------------------------
do $$ declare f text; begin
  if to_regclass('public.task_start_notices') is null then raise exception 'STOP 0436: run 0434 first (task_start_notices missing)'; end if;
  if to_regclass('public.event_department_supervisors') is null then raise exception 'STOP 0436: run 0399 first (event_department_supervisors missing)'; end if;
  foreach f in array array['public._r434_cfg(uuid)', 'public._r434_event(uuid,uuid)', 'public._r434_manager(uuid,uuid)',
      'public._r434_bell(uuid,uuid,uuid,text,text,jsonb)', 'public._r434_tg_start_now()', 'public.worker_get_tasks__pre0434(uuid)',
      'public.assign_notify_claim(integer)', 'public.staff_update_claim(integer)', 'public.crew_event_brief(uuid)', 'public.my_tasks()',
      'public.staff_link_view__pre0367(text)', 'public.verify_task(uuid,boolean,text)', 'public._r311_verify_task(uuid,boolean,text)',
      'public.event_department_supervisors_get(uuid)', 'public._r361_mine(public.event_tasks,uuid,text)', 'public._r337_wa_ready(uuid)',
      'public._a153_my_crew_ids()', 'public._r399_role_ok(uuid,uuid)'] loop
    if to_regprocedure(f) is null then raise exception 'STOP 0436: % is missing - an earlier update is not on this database', f; end if;
  end loop;
end $$;

-- ---- 1) the ledger: which e-mail a notice went into, its exact line, who finished the earlier task --------------------------------
alter table public.task_start_notices
  add column if not exists mail_id uuid,
  add column if not exists mail_line text,
  add column if not exists done_by text,
  add column if not exists wa436_id uuid;
do $$ begin
  if not exists (select 1 from pg_constraint where conrelid = 'public.task_start_notices'::regclass and contype = 'c'
                   and pg_get_constraintdef(oid) like '%hold_office%') then
    alter table public.task_start_notices
      drop constraint if exists task_start_notices_kind_chk434,
      add constraint task_start_notices_kind_chk434
        check (kind in ('start_now', 'wait_rejected', 'wait_late', 'go_on', 'hold', 'hold_office'));
  end if;
end $$;
create index if not exists task_start_notices_mail436 on public.task_start_notices (mail_id) where mail_id is not null;
create index if not exists task_start_notices_wa436 on public.task_start_notices (wa436_id) where wa436_id is not null;

-- ---- 2) keep helper (same shape as _r434_keep; p_as = the kept name, default <name>__pre0436) ----------------------------------------
create or replace function public._r436_keep(p_fn text, p_as text default null)
returns void language plpgsql volatile security definer set search_path = '' as $$
declare v_oid oid := to_regprocedure(p_fn); v_name text; v_types text; v_def text; v_pre text; v_as text; r text;
begin
  if v_oid is null then return; end if;
  select p.proname, oidvectortypes(p.proargtypes) into v_name, v_types from pg_proc p where p.oid = v_oid;
  v_as := coalesce(p_as, v_name || '__pre0436');
  v_pre := format('public.%I(%s)', v_as, v_types);
  if to_regprocedure(v_pre) is null then
    v_def := pg_get_functiondef(v_oid);
    v_def := regexp_replace(v_def, '^CREATE OR REPLACE FUNCTION public\.' || v_name || '\(',
                            'CREATE OR REPLACE FUNCTION public.' || v_as || '(');
    if position('FUNCTION public.' || v_as || '(' in v_def) = 0 then raise exception 'r253-0436: could not keep %', p_fn; end if;
    execute v_def;
  end if;
  execute format('revoke all on function %s from public', v_pre);
  foreach r in array array['anon', 'authenticated', 'service_role'] loop
    if exists (select 1 from pg_roles where rolname = r) then execute format('revoke all on function %s from %I', v_pre, r); end if;
  end loop;
end $$;

-- ---- 3) small helpers (server only) ----------------------------------------------------------------------------------------------
-- what a task waits for, as the task pages show it (null = nothing)
create or replace function public._r436_waits(p_dep uuid, p_org uuid, p_quote uuid)
returns jsonb language sql stable security definer set search_path = '' as $$
  -- r253-0436: the same release rule as 0434 (completed or cancelled); the check (verify_status) never delays it
  select jsonb_build_object('title', left(d.title, 120), 'done', d.status in ('completed', 'cancelled'),
           'state', case when d.status = 'completed' then 'done' when d.status = 'cancelled' then 'cancelled'
                         when d.verify_status = 'rejected' then 'rework' else 'waiting' end,
           'done_at', case d.status when 'completed' then d.completed_at when 'cancelled' then d.cancelled_at end)
    from public.event_tasks d where p_dep is not null and d.id = p_dep and d.org_id = p_org and d.quote_id = p_quote;
$$;
-- the name to show for "done by": the signed-in person, else the person on the task
create or replace function public._r436_by(d public.event_tasks)
returns text language sql stable security definer set search_path = '' as $$
  -- r253-0436
  select left(coalesce((select nullif(btrim(p.full_name), '') from public.profiles p where p.id = auth.uid() and p.org_id = d.org_id),
                       nullif(btrim(d.assignee_name), ''),
                       (select nullif(btrim(v.name), '') from public.vendors v where v.id = d.vendor_id and v.org_id = d.org_id)), 80);
$$;
-- is this notice still true? (re-checked when the e-mail / WhatsApp is picked up; p_crew / p_phone = the person it goes to, null = not checked)
create or replace function public._r436_fresh(n public.task_start_notices, p_crew uuid default null, p_phone text default null)
returns boolean language sql stable security definer set search_path = '' as $$
  -- r253-0436
  select exists (
    select 1 from public.event_tasks w join public.event_tasks d on d.id = n.earlier_id and d.org_id = w.org_id and d.quote_id = w.quote_id
     where w.id = n.task_id and w.org_id = n.org_id and w.depends_on = d.id
       and case n.kind
             when 'start_now' then w.status in ('assigned', 'accepted') and d.status in ('completed', 'cancelled')
             when 'go_on'     then w.status in ('assigned', 'accepted', 'in_progress') and d.status in ('completed', 'cancelled')
             when 'hold'      then w.status in ('assigned', 'accepted', 'in_progress') and d.status not in ('completed', 'cancelled')
             else false end
       and ((p_crew is null and p_phone is null) or public._r361_mine(w, p_crew, p_phone)))
     and not exists (select 1 from public.task_start_notices x where x.task_id = n.task_id and x.earlier_id = n.earlier_id and x.id <> n.id
                       and x.kind in ('start_now', 'go_on', 'hold') and (x.kind = 'hold') <> (n.kind = 'hold') and x.created_at > n.created_at);
$$;
-- one line in the person's waiting change notice, sent at once (the 0434 insert, but it answers the row's id; null = not queued)
create or replace function public._r436_mail(p_org uuid, p_quote uuid, p_crew uuid, p_phone text, p_line text)
returns uuid language plpgsql volatile security definer set search_path = '' as $$
-- r253-0436
declare v_p jsonb; v_st text; v_id uuid;
begin
  if not public._r361_on(p_org) or not public._r363_can(p_org, p_quote, false) then return null; end if;
  v_p := public._r361_person(p_org, p_crew, p_phone);
  if v_p is null then return null; end if;
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
  returning u.status, u.id into v_st, v_id;
  return case when v_st = 'pending' then v_id end;
exception when others then
  raise warning 'r253-0436: e-mail not queued (%)', sqlstate;
  return null;
end $$;
-- one WhatsApp in the 0132 queue with the existing template staff_task_changed (the 0434 one, with the words given); null = not queued
create or replace function public._r436_wa(p_org uuid, p_quote uuid, p_task uuid, p_phone text, p_name text, p_title text, p_lead text, p_why text)
returns uuid language plpgsql volatile security definer set search_path = '' as $$
-- r253-0436
declare v_id uuid; v_st text; v_first text; v_event text; v_link text;
begin
  if p_phone is null or coalesce(public._r283_off_phone(p_org, p_phone), false) then return null; end if;
  v_first := split_part(btrim(coalesce(p_name, '')), ' ', 1);
  v_event := public._r338_f(public._r338_event(p_quote) ->> 'event', 100);
  v_link := public._r338_link(p_quote, p_org, p_phone);
  insert into public.assign_notify_outbox (org_id, quote_id, item_kind, item_id, phone, name, body, link_path, created_by)
  values (p_org, p_quote, 'task', p_task, p_phone, left(nullif(btrim(p_name), ''), 120),
          left(regexp_replace('Hi ' || coalesce(nullif(v_first, ''), 'there') || ', ' || p_lead || ': ' || left(p_title, 100) || ' (' || v_event || '). '
            || p_why || '.' || case when v_link is not null then ' Open your link:' else '' end, '[[:cntrl:]<>]', ' ', 'g'), 880),
          v_link, auth.uid())
  returning id into v_id;
  if v_id is null then return null; end if;
  update public.assign_notify_outbox
     set template = 'staff_task_changed',
         params = jsonb_build_array(public._r338_f(v_first, 60), public._r338_f(p_title, 100), v_event, public._r338_f(p_lead || ' - ' || p_why, 150))
   where id = v_id and sent_at is null
   returning status into v_st;
  return case when v_st = 'pending' then v_id end;
exception when others then
  raise warning 'r253-0436: WhatsApp not queued (%)', sqlstate;
  return null;
end $$;

-- ---- 4) tell ONE waiting task (start_now / go_on / hold) ------------------------------------------------------------------------------
-- answers null = this notice was already given; {} = told; { "miss": "Ravi" } = a hold Helm could not give (the manager's bell names them)
create or replace function public._r436_tell(w public.event_tasks, d public.event_tasks, p_kind text, p_at timestamptz, p_ev text, p_trial boolean, p_by text)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
-- r253-0436: the 0434 rules per waiting task; once per (waiting task, earlier task, moment) - the ledger's unique key
declare v_id uuid; v_wt text; v_dt text; v_why text; v_lead text; v_line text; v_bell text; v_list jsonb; v_who text; v_sup uuid; v_off boolean;
        v_crew public.crew_members; v_phone text; v_login uuid; v_bells integer := 0; v_mail uuid; v_wa uuid; v_hold boolean := p_kind = 'hold'; v_miss text;
begin
  insert into public.task_start_notices (org_id, quote_id, task_id, earlier_id, kind, slot_key, state_at, done_by, created_at)
  values (w.org_id, w.quote_id, w.id, d.id, p_kind,
          p_kind || '|' || w.id::text || '|' || d.id::text || '|' || floor(extract(epoch from p_at) * 1000000)::bigint::text, p_at, p_by, clock_timestamp())
  on conflict (slot_key) do nothing returning id into v_id;
  if v_id is null then return null; end if;
  v_wt := left(coalesce(nullif(btrim(w.title), ''), 'A task'), 70);
  v_dt := left(coalesce(nullif(btrim(d.title), ''), 'The earlier task'), 70);
  v_why := v_dt || case when v_hold then ' needs rework' when d.status = 'cancelled' then ' was cancelled' else ' is done' end;
  v_lead := case p_kind when 'hold' then 'Please hold' when 'go_on' then 'You can go on now' else 'You can start now' end;
  v_line := v_lead || ': ' || v_wt || ' - ' || v_why;
  v_bell := case when v_hold then v_dt || ' needs rework - please hold: ' || v_wt else v_line end || ' (' || p_ev || ')';
  v_list := public._r434_manager(w.org_id, w.quote_id);

  if coalesce(w.assignee_kind, 'in_house') <> 'in_house' then
    -- a vendor's task: Helm does not message vendors about tasks, the event manager tells them
    select nullif(btrim(v.name), '') into v_who from public.vendors v where v.id = w.vendor_id and v.org_id = w.org_id;
    v_who := coalesce(left(coalesce(v_who, nullif(btrim(w.assignee_name), '')), 50), 'The vendor');
    if v_hold then v_miss := v_who || ' (vendor)';
    else v_bells := public._r434_bell(w.org_id, w.quote_id, w.id, v_who || ' (vendor) can ' || case p_kind when 'go_on' then 'go on' else 'start' end
           || ' now: ' || v_wt || ' - ' || v_why || ' (' || p_ev || ')', 'start_now_vendor', v_list);
    end if;
  elsif w.crew_id is null and public._assign132_phone(w.assignee_phone) is null and nullif(btrim(coalesce(w.assignee_name, '')), '') is null then
    -- nobody on it: the event manager, and the department supervisor (0399)
    if not v_hold then
      select s.profile_id into v_sup from public.event_department_supervisors s join public.profiles p on p.id = s.profile_id and p.org_id = s.org_id
       where s.quote_id = w.quote_id and s.org_id = w.org_id and s.department = btrim(coalesce(w.category, ''))
         and lower(coalesce(p.role, '')) not in ('', 'client', 'crew', 'worker') and not coalesce(public._r283_is_off(p.id, w.org_id), false);
      if v_sup is not null and not (v_list ? v_sup::text) then v_list := v_list || jsonb_build_array(v_sup::text); end if;
      v_bells := public._r434_bell(w.org_id, w.quote_id, w.id,
        v_wt || ' can start now - ' || v_why || '. Nobody is on it yet (' || p_ev || ')', 'start_now_office', v_list);
    end if;
  else
    -- the person on the task: by staff id, else the one active staff member with this phone
    v_phone := public._assign132_phone(w.assignee_phone);
    if w.crew_id is not null then
      select * into v_crew from public.crew_members c where c.id = w.crew_id and c.org_id = w.org_id;
    elsif v_phone is not null and (select count(*) from public.crew_members c where c.org_id = w.org_id and c.active and public._assign132_phone(c.phone) = v_phone) = 1 then
      select * into v_crew from public.crew_members c where c.org_id = w.org_id and c.active and public._assign132_phone(c.phone) = v_phone;
    end if;
    v_phone := coalesce(v_phone, public._assign132_phone(v_crew.phone));
    -- a switched-off login or an inactive staff record gets nothing, whatever address it carries
    v_off := coalesce(v_crew.active = false, false) or (v_crew.profile_id is not null and coalesce(public._r283_is_off(v_crew.profile_id, w.org_id), false));
    if not v_off then
      if v_crew.profile_id is not null then
        select p.id into v_login from public.profiles p where p.id = v_crew.profile_id and p.org_id = w.org_id
           and lower(coalesce(p.role, '')) not in ('', 'client');
      end if;
      if v_login is not null then
        v_bells := public._r434_bell(w.org_id, w.quote_id, w.id, v_bell, case when v_hold then 'hold' else 'start_now' end, jsonb_build_array(v_login::text));
      end if;
      if not p_trial then
        v_mail := public._r436_mail(w.org_id, w.quote_id, w.crew_id, v_phone, v_line);
        v_wa := public._r436_wa(w.org_id, w.quote_id, w.id, v_phone, coalesce(nullif(btrim(w.assignee_name), ''), v_crew.name), v_wt, lower(left(v_lead, 1)) || substr(v_lead, 2), v_why);
      end if;
    end if;
    -- nobody was reached: the event manager tells the person
    if v_bells = 0 and v_mail is null and (v_wa is null or not coalesce(public._r337_wa_ready(w.org_id), false)) then
      v_who := coalesce(left(coalesce(nullif(btrim(w.assignee_name), ''), v_crew.name), 40), 'the person on it');
      if v_hold then v_miss := v_who;
      else v_bells := public._r434_bell(w.org_id, w.quote_id, w.id, 'Tell ' || v_who || ': ' || v_wt || ' can ' || case p_kind when 'go_on' then 'go on' else 'start' end
             || ' now - ' || v_why || '. Helm could not message this person (' || p_ev || ')', 'start_now_office', v_list);
      end if;
    end if;
  end if;
  update public.task_start_notices
     set bells = v_bells, email = v_mail is not null, mail_id = v_mail, mail_line = case when v_mail is not null then left(v_line, 200) end, wa436_id = v_wa
   where id = v_id;
  return jsonb_strip_nulls(jsonb_build_object('miss', v_miss));
end $$;

-- ---- 5) a task was finished / cancelled / turned down -----------------------------------------------------------------------------------
create or replace function public._r436_closed(d public.event_tasks, p_at timestamptz)
returns integer language plpgsql volatile security definer set search_path = '' as $$
-- r253-0436: who waits and has not started, plus who had started and was asked to hold (rework) since the last release
declare w public.event_tasks; v_ev text; v_trial boolean; v_by text; v_n integer := 0; v_held boolean; v_id uuid;
begin
  if not exists (select 1 from public.event_tasks x where x.depends_on = d.id and x.org_id = d.org_id and x.quote_id = d.quote_id
                   and x.id <> d.id and x.status in ('unassigned', 'assigned', 'accepted', 'in_progress')) then return 0; end if;
  if not (public._r434_cfg(d.org_id) ->> 'on')::boolean then return 0; end if;
  v_ev := public._r434_event(d.org_id, d.quote_id);
  if v_ev is null then return 0; end if;
  v_trial := coalesce(public.trial_send_blocked(d.org_id, d.quote_id, null), false);
  v_by := public._r436_by(d);
  for w in
    select t.* from public.event_tasks t
     where t.depends_on = d.id and t.org_id = d.org_id and t.quote_id = d.quote_id and t.id <> d.id
       and t.status in ('unassigned', 'assigned', 'accepted', 'in_progress')
     order by t.planned_start nulls last, t.category, t.seq, t.id limit 50
  loop
    begin
      if d.status = 'rejected' then
        continue when w.status = 'in_progress';
        v_id := null;
        insert into public.task_start_notices (org_id, quote_id, task_id, earlier_id, kind, slot_key, state_at)
        values (w.org_id, w.quote_id, w.id, d.id, 'wait_rejected',
                'wait_rejected|' || w.id::text || '|' || d.id::text || '|' || floor(extract(epoch from p_at) * 1000000)::bigint::text, p_at)
        on conflict (slot_key) do nothing returning id into v_id;
        continue when v_id is null;
        update public.task_start_notices set bells = public._r434_bell(w.org_id, w.quote_id, w.id,
          left(coalesce(nullif(btrim(w.title), ''), 'A task'), 70) || ' is waiting for ' || left(coalesce(nullif(btrim(d.title), ''), 'The earlier task'), 70)
            || ', which was turned down' || coalesce(' by ' || left(nullif(btrim(d.assignee_name), ''), 40), '')
            || '. Give it to someone else (' || v_ev || ')', 'wait_rejected', public._r434_manager(w.org_id, w.quote_id)) where id = v_id;
        v_n := v_n + 1;
        continue;
      end if;
      if w.status = 'in_progress' then
        select n.kind = 'hold' into v_held from public.task_start_notices n
         where n.task_id = w.id and n.earlier_id = d.id and n.kind in ('start_now', 'go_on', 'hold') order by n.created_at desc limit 1;
        continue when not coalesce(v_held, false);
      end if;
      if public._r436_tell(w, d, case when w.status = 'in_progress' then 'go_on' else 'start_now' end, p_at, v_ev, v_trial, v_by) is not null then v_n := v_n + 1; end if;
    exception when others then
      raise warning 'r253-0436: task % not told (%)', w.id, sqlstate;
    end;
  end loop;
  return v_n;
end $$;

-- ---- 6) a checker sent the earlier task back: hold ------------------------------------------------------------------------------------
create or replace function public._r436_rework(d public.event_tasks, p_at timestamptz)
returns integer language plpgsql volatile security definer set search_path = '' as $$
-- r253-0436: everyone whose task waits for it and is not done; one bell for the event manager. Once per rejection.
declare w public.event_tasks; v_ev text; v_trial boolean; v_by text; v_dt text; v_r jsonb; v_names text[] := '{}'; v_miss text[] := '{}'; v_id uuid; v_n integer := 0;
begin
  if not exists (select 1 from public.event_tasks x where x.depends_on = d.id and x.org_id = d.org_id and x.quote_id = d.quote_id
                   and x.id <> d.id and x.status in ('unassigned', 'assigned', 'accepted', 'in_progress')) then return 0; end if;
  if not (public._r434_cfg(d.org_id) ->> 'on')::boolean then return 0; end if;
  v_ev := public._r434_event(d.org_id, d.quote_id);
  if v_ev is null then return 0; end if;
  v_trial := coalesce(public.trial_send_blocked(d.org_id, d.quote_id, null), false);
  v_dt := left(coalesce(nullif(btrim(d.title), ''), 'A task'), 70);
  v_by := public._r436_by(d);
  for w in
    select t.* from public.event_tasks t
     where t.depends_on = d.id and t.org_id = d.org_id and t.quote_id = d.quote_id and t.id <> d.id
       and t.status in ('unassigned', 'assigned', 'accepted', 'in_progress')
     order by t.planned_start nulls last, t.category, t.seq, t.id limit 50
  loop
    v_names := v_names || left(coalesce(nullif(btrim(w.title), ''), 'A task'), 40);
    begin
      v_r := public._r436_tell(w, d, 'hold', p_at, v_ev, v_trial, v_by);
      if v_r is not null then v_n := v_n + 1; end if;
      if v_r ? 'miss' then v_miss := v_miss || (v_r ->> 'miss'); end if;
    exception when others then
      raise warning 'r253-0436: hold for task % not told (%)', w.id, sqlstate;
    end;
  end loop;
  begin
    insert into public.task_start_notices (org_id, quote_id, task_id, earlier_id, kind, slot_key, state_at, done_by)
    values (d.org_id, d.quote_id, d.id, d.id, 'hold_office',
            'hold_office|' || d.id::text || '|' || floor(extract(epoch from p_at) * 1000000)::bigint::text, p_at, v_by)
    on conflict (slot_key) do nothing returning id into v_id;
    if v_id is not null then
      update public.task_start_notices set bells = public._r434_bell(d.org_id, d.quote_id, d.id,
        v_dt || ' needs rework' || coalesce(' (checked by ' || left(v_by, 40) || ')', '') || '. Waiting for it: '
          || array_to_string(v_names[1:3], ', ') || case when cardinality(v_names) > 3 then ' and ' || (cardinality(v_names) - 3) || ' more' else '' end
          || case when cardinality(v_miss) > 0 then '. Please tell: ' || array_to_string(v_miss[1:3], ', ')
               || case when cardinality(v_miss) > 3 then ' and ' || (cardinality(v_miss) - 3) || ' more' else '' end else '' end
          || ' - ' || v_ev, 'hold_office', public._r434_manager(d.org_id, d.quote_id)) where id = v_id;
      v_n := v_n + 1;
    end if;
  exception when others then
    raise warning 'r253-0436: manager not told about rework of % (%)', d.id, sqlstate;
  end;
  return v_n;
end $$;

-- ---- 7) the triggers: 0434's trigger function now calls _r436_closed (its 0434 text kept as _r436_kept_tg_start_now) ----------------------
do $$ begin
  if position('r253-0436' in pg_get_functiondef('public._r434_tg_start_now()'::regprocedure)) = 0 then
    perform public._r436_keep('public._r434_tg_start_now()', '_r436_kept_tg_start_now'); end if;
end $$;
create or replace function public._r434_tg_start_now()
returns trigger language plpgsql security definer set search_path = '' as $$
-- r252-0434 r253-0436: never blocks or undoes the status change; system changes stay quiet (0164)
declare v_at timestamptz;
begin
  begin
    if public._is_system_change() then return null; end if;
    -- the moment of THIS change (a completion time left over from an earlier round is not a new one)
    v_at := case when new.status = 'completed' and new.completed_at is distinct from old.completed_at then new.completed_at
                 when new.status = 'cancelled' and new.cancelled_at is distinct from old.cancelled_at then new.cancelled_at end;
    perform public._r436_closed(new, coalesce(v_at, now()));
  exception when others then
    raise warning 'r252-0434: waiting tasks not told (%)', sqlstate;
  end;
  return null;
end $$;

create or replace function public._r436_tg_rework()
returns trigger language plpgsql security definer set search_path = '' as $$
-- r253-0436: never blocks or undoes the check; system changes stay quiet (0164)
begin
  begin
    if public._is_system_change() then return null; end if;
    perform public._r436_rework(new, coalesce(new.verified_at, now()));
  exception when others then
    raise warning 'r253-0436: rework not told (%)', sqlstate;
  end;
  return null;
end $$;
do $$ begin
  if not exists (select 1 from pg_trigger where tgrelid = 'public.event_tasks'::regclass and tgname = 'zzz_r436_rework') then
    create trigger zzz_r436_rework after update of verify_status on public.event_tasks
      for each row when (old.verify_status is distinct from new.verify_status and new.verify_status = 'rejected' and new.status not in ('completed', 'cancelled'))
      execute function public._r436_tg_rework();
  end if;
end $$;

-- ---- 8) the e-mail queue: leave out lines that are no longer true, hand the facts to the sender -------------------------------------------
create or replace function public._r436_mail_items(p_mail uuid, p_changes jsonb)
returns jsonb language sql stable security definer set search_path = '' as $$
  -- r253-0436: the newest true notice per waiting task of this e-mail; only lines that are in the e-mail
  select coalesce(jsonb_agg(z.j order by z.hold, z.at, z.title), '[]'::jsonb) from (
    select distinct on (n.task_id) n.kind = 'hold' as hold, n.state_at as at, w.title,
           jsonb_build_object('type', n.kind, 'line', n.mail_line, 'task', left(w.title, 160), 'section', left(coalesce(w.category, ''), 60),
             'start', public._r338_time(w.planned_start, w.org_id), 'day', public._r338_day(w.planned_start, w.org_id),
             'earlier', left(d.title, 160), 'earlier_state', case when n.kind = 'hold' then 'rework' when d.status = 'cancelled' then 'cancelled' else 'done' end,
             'by', n.done_by, 'at', public._r338_time(n.state_at, w.org_id), 'at_day', public._r338_day(n.state_at, w.org_id)) as j
      from public.task_start_notices n
      join public.event_tasks w on w.id = n.task_id and w.org_id = n.org_id
      join public.event_tasks d on d.id = n.earlier_id and d.org_id = n.org_id
     where n.mail_id = p_mail and n.mail_line is not null and p_changes ? n.mail_line and public._r436_fresh(n)
     order by n.task_id, n.created_at desc) z;
$$;
do $$ begin
  perform public._r436_keep(f) from unnest(array['public.staff_update_claim(integer)', 'public.assign_notify_claim(integer)', 'public.worker_get_tasks(uuid)',
    'public.verify_task(uuid,boolean,text)', 'public.event_department_supervisors_get(uuid)']) f
   where position('r253-0436' in pg_get_functiondef(to_regprocedure(f))) = 0;
end $$;

create or replace function public.staff_update_claim(p_limit integer default 25)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
-- r253-0436: lines of "you can start now" / "please hold" that are no longer true are taken out of the waiting notice (a notice with
-- nothing left is skipped by the kept claim: nothing_changed), then the r172-0363 claim unchanged (kept as staff_update_claim__pre0436,
-- with its 0402 try limit _r342_max_attempts());
-- each answered notice also carries start_now = the facts of its start / hold lines. An older sender ignores that field.
declare r record; v_new jsonb; v jsonb;
begin
  begin
    for r in select u.* from public.staff_update_outbox u
              where u.sent_at is null and u.status = 'pending' and (u.claimed_at is null or u.claimed_at < now() - interval '10 minutes')
                and exists (select 1 from public.task_start_notices n where n.mail_id = u.id and n.mail_line is not null)
              order by u.not_before limit 200 for update of u skip locked
    loop
      select coalesce(jsonb_agg(c.v order by c.o), '[]'::jsonb) into v_new
        from jsonb_array_elements(r.changes) with ordinality c(v, o)
       where not exists (select 1 from public.task_start_notices n where n.mail_id = r.id and to_jsonb(n.mail_line) = c.v)
          or exists (select 1 from public.task_start_notices n where n.mail_id = r.id and to_jsonb(n.mail_line) = c.v and public._r436_fresh(n, r.crew_id, r.phone));
      if jsonb_array_length(v_new) < jsonb_array_length(r.changes) then
        update public.staff_update_outbox set changes = v_new, updated_at = now(),
               change_count = greatest(jsonb_array_length(v_new), change_count - (jsonb_array_length(r.changes) - jsonb_array_length(v_new)))
         where id = r.id;
      end if;
    end loop;
  exception when others then raise warning 'r253-0436: start notices not re-checked (%)', sqlstate;
  end;
  v := public.staff_update_claim__pre0436(p_limit);
  begin
    if jsonb_typeof(v) = 'array' and jsonb_array_length(v) > 0 then
      v := (select jsonb_agg(case when jsonb_array_length(i.items) > 0 then x.e || jsonb_build_object('start_now', i.items) else x.e end order by x.o)
              from jsonb_array_elements(v) with ordinality x(e, o)
              cross join lateral (select public._r436_mail_items((x.e ->> 'id')::uuid, coalesce(x.e -> 'changes', '[]'::jsonb)) as items) i);
    end if;
  exception when others then raise warning 'r253-0436: start facts not added (%)', sqlstate;
  end;
  return v;
end $$;

create or replace function public.assign_notify_claim(p_limit integer default 25)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
-- r253-0436: a waiting start / hold WhatsApp that is no longer true (or older than 2 hours) is dropped, then the r252-0434 claim
-- unchanged (kept as assign_notify_claim__pre0436, over assign_notify_claim__pre0434 and assign_notify_claim__pre0283)
begin
  begin
    update public.assign_notify_outbox a set status = 'skipped', sent_at = now(), updated_at = now()
      from public.task_start_notices n
     where n.wa436_id = a.id and a.sent_at is null and a.status = 'pending'
       and (a.created_at < now() - interval '2 hours' or not public._r436_fresh(n));
  exception when others then raise warning 'r253-0436: start notices not re-checked (%)', sqlstate;
  end;
  return public.assign_notify_claim__pre0436(p_limit);
end $$;

-- ---- 9) the task pages --------------------------------------------------------------------------------------------------------------------
create or replace function public.worker_get_tasks(p_token uuid)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
-- r252-0434 r253-0436: the 0012 answer (kept as worker_get_tasks__pre0434: the link check + limit _work_token_live(p_token) happens there); each task
-- also carries waits_for { title, done, state, done_at } when it waits for another task of the same event, else null. Nothing else changes.
declare v jsonb := public.worker_get_tasks__pre0434(p_token);
begin
  if jsonb_typeof(v -> 'tasks') is distinct from 'array' then return v; end if;
  return jsonb_set(v, '{tasks}', coalesce((
    select jsonb_agg(x.j || jsonb_build_object('waits_for', (
             select public._r436_waits(t.depends_on, t.org_id, t.quote_id) from public.event_tasks t where t.id::text = x.j ->> 'id')) order by x.o)
      from jsonb_array_elements(v -> 'tasks') with ordinality x(j, o)), '[]'::jsonb));
exception when undefined_function or undefined_column or data_exception then
  return v;   -- the extra field is a nice-to-have: the worker page always gets its tasks
end $$;

-- exact text edits (0432 way: the piece must be there exactly once, else the body is left as it is)
do $do$
declare r record; v_def text;
begin
  for r in select * from (values
    ('public.crew_event_brief(uuid)', '''planned_end'', t.planned_end, ''note'', t.note)',
       '''planned_end'', t.planned_end, ''note'', t.note, ''waits_for'', public._r436_waits(t.depends_on, t.org_id, t.quote_id) /* r253-0436 */)'),
    ('public.my_tasks()', ' as is_blocked', ' as is_blocked, public._r436_waits(t.depends_on, t.org_id, t.quote_id) as waits_for /* r253-0436 */'),
    ('public.staff_link_view__pre0367(text)', '''status'', t.status) order by t.planned_start nulls last',
       '''status'', t.status, ''waits_for'', public._r436_waits(t.depends_on, t.org_id, t.quote_id) /* r253-0436 */) order by t.planned_start nulls last')
  ) v(fn, a, b) loop
    v_def := pg_get_functiondef(to_regprocedure(r.fn));
    continue when position('r253-0436' in v_def) > 0;            -- already done (second run)
    if (length(v_def) - length(replace(v_def, r.a, ''))) / length(r.a) <> 1 then raise notice '0436: % has an unexpected body - left unchanged', r.fn; continue; end if;
    perform public._r436_keep(r.fn);
    execute replace(v_def, r.a, r.b);
  end loop;
end $do$;

-- ---- 10) the department supervisor checks the finished tasks of their own section (0399) ------------------------------------------------------
-- may this person check this task as its department supervisor? (the rule only; status is checked by the caller)
create or replace function public._r436_sup_can(t public.event_tasks, p_uid uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  -- r253-0436: supervisor of this section on this event (role + active re-checked), never their own task
  select p_uid is not null and public._r399_role_ok(t.org_id, p_uid) = 'supervisor'
     and exists (select 1 from public.event_department_supervisors s
                  where s.org_id = t.org_id and s.quote_id = t.quote_id and s.department = btrim(coalesce(t.category, '')) and s.profile_id = p_uid)
     and not exists (select 1 from public.crew_members c
                      where c.org_id = t.org_id
                        and (c.profile_id = p_uid or (nullif(btrim(c.email), '') is not null and lower(btrim(c.email)) = (select lower(btrim(p.email)) from public.profiles p where p.id = p_uid)))
                        and (c.id = t.crew_id or (public._assign132_phone(c.phone) is not null and public._assign132_phone(c.phone) = public._assign132_phone(t.assignee_phone))));
$$;
create or replace function public._r436_verify_task(p_id uuid, p_pass boolean, p_note text)
returns public.event_tasks language plpgsql volatile security definer set search_path = '' as $$
-- r253-0436: role supervisor = the narrow rule below; everybody else = the r92-0311 check, unchanged
declare t public.event_tasks; v_out public.event_tasks;
begin
  if coalesce(public.user_role(), '') <> 'supervisor' then return public._r311_verify_task(p_id, p_pass, p_note); end if;
  if not coalesce(public.has_area('staff', 'view'), false) then
    raise exception 'only a quality engineer, a manager or the supervisor of this section can verify tasks' using errcode = '42501';
  end if;
  select * into t from public.event_tasks x where x.id = p_id and x.org_id = public.current_org_id() for update;
  if t.id is null then raise exception 'task not found'; end if;
  if not coalesce(public._r436_sup_can(t, auth.uid()), false) then
    raise exception 'You can check only the tasks of the section you supervise on this event, and never your own task.' using errcode = '42501', hint = 'r436_not_your_section';
  end if;
  if t.status is distinct from 'completed' or t.verify_status is distinct from 'pending' then
    raise exception 'This task is not waiting for a quality check (it must be done and waiting for QC).'
      using errcode = '22023', hint = 'r311_qc_not_pending';
  end if;
  if p_pass is null or (not p_pass and nullif(btrim(coalesce(p_note, '')), '') is null) then
    raise exception 'Please write what has to be done again.' using errcode = '22023', hint = 'r436_reason';
  end if;
  -- the same update as verify_task (0282); the audit rows come from the same triggers
  update public.event_tasks set
    verify_status = case when p_pass then 'passed' else 'rejected' end,
    verified_by   = auth.uid(),
    verified_at   = now(),
    verify_note   = nullif(btrim(coalesce(p_note, '')), ''),
    status        = case when p_pass then status else 'in_progress' end,
    completed_at  = case when p_pass then completed_at else null end
  where id = t.id
  returning id, verify_status, verified_at into v_out.id, v_out.verify_status, v_out.verified_at;
  return v_out;
end $$;
create or replace function public.verify_task(p_id uuid, p_pass boolean, p_note text default null)
returns public.event_tasks language sql security definer set search_path = '' as $$select public._r436_verify_task(p_id, p_pass, p_note) /* r92-task-lifecycle-0311 r253-0436 */$$;

create or replace function public.event_department_supervisors_get(p_quote uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
-- r253-0436: the r230-0399 answer (its checks first), plus verify = what this person may check on this event:
-- all (admin / manager / planner / quality with Staff view), or the sections they supervise; my_crew_ids = their own staff records
declare v jsonb := public.event_department_supervisors_get__pre0436(p_quote); v_role text := coalesce(public.user_role(), ''); v_staff boolean := coalesce(public.has_area('staff', 'view'), false);
begin
  if v is null or jsonb_typeof(v) <> 'object' then return v; end if;
  return v || jsonb_build_object('verify', jsonb_build_object(
    'all', v_staff and v_role in ('admin', 'manager', 'planner', 'quality'),
    'departments', case when v_staff and v_role = 'supervisor' then coalesce((select jsonb_agg(s.department order by s.department)
        from public.event_department_supervisors s where s.quote_id = p_quote and s.org_id = public.current_org_id() and s.profile_id = auth.uid()), '[]'::jsonb) else '[]'::jsonb end,
    'my_crew_ids', coalesce((select jsonb_agg(c) from public._a153_my_crew_ids() c), '[]'::jsonb)));
end $$;

-- ---- 11) no circles in "waits for" ------------------------------------------------------------------------------------------------------------
create or replace function public._r436_tg_no_circle()
returns trigger language plpgsql volatile security definer set search_path = '' as $$
-- r253-0436: checks a NEW depends_on only. Status does not matter: a circle through a cancelled / finished task is refused too.
-- One change of "waits for" per event at a time (advisory lock to the end of the transaction), so two changes at the same moment
-- cannot close a circle together: the second one reads what the first one saved. Restores / system changes are not checked.
declare v_q uuid;
begin
  if new.depends_on is null or (tg_op = 'UPDATE' and new.depends_on is not distinct from old.depends_on) then return new; end if;
  if public._is_system_change() then return new; end if;
  if new.depends_on = new.id then raise exception 'A task cannot wait for itself.' using errcode = '22023', hint = 'r436_wait_circle'; end if;
  perform pg_advisory_xact_lock(hashtextextended('r436-waits|' || new.quote_id::text, 0));
  select t.quote_id into v_q from public.event_tasks t where t.id = new.depends_on;
  if v_q is not null and v_q is distinct from new.quote_id then
    raise exception 'A task can only wait for a task of the same event.' using errcode = '22023', hint = 'r436_wait_other_event'; end if;
  if exists (
    with recursive up(id) as (
      select new.depends_on
      union                                   -- union: a circle that is already stored cannot make this run for ever
      select t.depends_on from up join public.event_tasks t on t.id = up.id where t.depends_on is not null
    ) select 1 from up where up.id = new.id) then
    raise exception 'That would make the two tasks wait for each other.' using errcode = '22023', hint = 'r436_wait_circle'; end if;
  return new;
end $$;
do $$ begin
  if not exists (select 1 from pg_trigger where tgrelid = 'public.event_tasks'::regclass and tgname = 'zz_r436_no_circle') then
    create trigger zz_r436_no_circle before insert or update of depends_on on public.event_tasks
      for each row when (new.depends_on is not null) execute function public._r436_tg_no_circle();
  end if;
end $$;

-- ---- 12) grants: new functions server only; the wrapped names keep exactly the grants they had ------------------------------------------------
do $$ declare f text; r text; begin
  foreach f in array array['public._r436_keep(text,text)', 'public._r436_waits(uuid,uuid,uuid)', 'public._r436_by(public.event_tasks)',
      'public._r436_fresh(public.task_start_notices,uuid,text)', 'public._r436_mail(uuid,uuid,uuid,text,text)',
      'public._r436_wa(uuid,uuid,uuid,text,text,text,text,text)',
      'public._r436_tell(public.event_tasks,public.event_tasks,text,timestamptz,text,boolean,text)',
      'public._r436_closed(public.event_tasks,timestamptz)', 'public._r436_rework(public.event_tasks,timestamptz)', 'public._r436_tg_rework()',
      'public._r436_mail_items(uuid,jsonb)', 'public._r436_sup_can(public.event_tasks,uuid)', 'public._r436_verify_task(uuid,boolean,text)', 'public._r436_tg_no_circle()',
      'public._r434_tg_start_now()'] loop
    execute format('revoke all on function %s from public', f);
    foreach r in array array['anon', 'authenticated', 'service_role'] loop
      if exists (select 1 from pg_roles where rolname = r) then execute format('revoke all on function %s from %I', f, r); end if;
    end loop;
  end loop;
  foreach f in array array['public.staff_update_claim(integer)', 'public.assign_notify_claim(integer)'] loop
    execute format('revoke all on function %s from public', f);
    if exists (select 1 from pg_roles where rolname = 'anon') then execute format('revoke all on function %s from anon, authenticated', f); end if;
    if exists (select 1 from pg_roles where rolname = 'service_role') then execute format('grant execute on function %s to service_role', f); end if;
  end loop;
end $$;

do $$ begin
  if to_regclass('public.helm_schema_markers') is not null then
    insert into public.helm_schema_markers(num, name) values (436, '0436_r253_start_now_mail') on conflict (num) do nothing;
  end if;
end $$;

notify pgrst, 'reload schema';

-- ---- checks (every ok must be true) --------------------------------------------------------------------------------------
select item, ok from (values
  ('01 ledger: 4 new columns, the new words allowed, still closed to the app',
     (select count(*) = 4 from information_schema.columns where table_schema = 'public' and table_name = 'task_start_notices' and column_name in ('mail_id', 'mail_line', 'done_by', 'wa436_id'))
     and exists (select 1 from pg_constraint where conrelid = 'public.task_start_notices'::regclass and contype = 'c' and pg_get_constraintdef(oid) like '%hold_office%')
     and not has_table_privilege('anon', 'public.task_start_notices', 'select, insert, update, delete')
     and not has_table_privilege('authenticated', 'public.task_start_notices', 'select, insert, update, delete')),
  ('02 two new indexes', to_regclass('public.task_start_notices_mail436') is not null and to_regclass('public.task_start_notices_wa436') is not null),
  ('03 finished task: the 0434 trigger is on and uses the new body', exists (select 1 from pg_trigger where tgrelid = 'public.event_tasks'::regclass and tgname = 'zzz_r434_start_now' and tgenabled = 'O')
     and position('_r436_closed' in pg_get_functiondef('public._r434_tg_start_now()'::regprocedure)) > 0),
  ('04 rejected check: the new trigger is there and switched on', exists (select 1 from pg_trigger where tgrelid = 'public.event_tasks'::regclass and tgname = 'zzz_r436_rework' and tgenabled = 'O')),
  ('05 new functions server only, empty search_path', (select count(*) = 15 and bool_and(p.prosecdef and p.proconfig @> array['search_path=""']
     and not has_function_privilege('anon', p.oid, 'execute') and not has_function_privilege('authenticated', p.oid, 'execute'))
     from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname like '\_r436\_%')),
  ('06 kept bodies server only', (select count(*) >= 5 and bool_and(not has_function_privilege('anon', p.oid, 'execute') and not has_function_privilege('authenticated', p.oid, 'execute'))
     from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname like '%\_\_pre0436')),
  ('07 the e-mail claim and the WhatsApp claim wrapped once, server only',
     position('r253-0436' in pg_get_functiondef('public.staff_update_claim(integer)'::regprocedure)) > 0 and to_regprocedure('public.staff_update_claim__pre0436(integer)') is not null
     and position('r253-0436' in pg_get_functiondef('public.assign_notify_claim(integer)'::regprocedure)) > 0 and to_regprocedure('public.assign_notify_claim__pre0436(integer)') is not null
     and has_function_privilege('service_role', 'public.staff_update_claim(integer)', 'execute') and not has_function_privilege('authenticated', 'public.staff_update_claim(integer)', 'execute')
     and has_function_privilege('service_role', 'public.assign_notify_claim(integer)', 'execute') and not has_function_privilege('authenticated', 'public.assign_notify_claim(integer)', 'execute')),
  ('08 worker page knows what a task waits for, same access', position('_r436_waits' in pg_get_functiondef('public.worker_get_tasks(uuid)'::regprocedure)) > 0 and has_function_privilege('anon', 'public.worker_get_tasks(uuid)', 'execute')),
  ('09 signed-in task page knows it', position('r253-0436' in pg_get_functiondef('public.crew_event_brief(uuid)'::regprocedure)) > 0),
  ('10 my tasks knows it', position('r253-0436' in pg_get_functiondef('public.my_tasks()'::regprocedure)) > 0),
  ('11 permanent link page knows it', position('r253-0436' in pg_get_functiondef('public.staff_link_view__pre0367(text)'::regprocedure)) > 0),
  ('12 SUPERVISOR CHECK: verify_task through the narrow rule, signed-in people only',
     position('_r436_verify_task' in pg_get_functiondef('public.verify_task(uuid,boolean,text)'::regprocedure)) > 0
     and position('_r311_verify_task' in pg_get_functiondef('public._r436_verify_task(uuid,boolean,text)'::regprocedure)) > 0
     and has_function_privilege('authenticated', 'public.verify_task(uuid,boolean,text)', 'execute') and not has_function_privilege('anon', 'public.verify_task(uuid,boolean,text)', 'execute')),
  ('13 department supervisors answer what may be checked, signed-in people only',
     position('r253-0436' in pg_get_functiondef('public.event_department_supervisors_get(uuid)'::regprocedure)) > 0
     and has_function_privilege('authenticated', 'public.event_department_supervisors_get(uuid)', 'execute') and not has_function_privilege('anon', 'public.event_department_supervisors_get(uuid)', 'execute')),
  ('14 no circles: the trigger is there and switched on', exists (select 1 from pg_trigger where tgrelid = 'public.event_tasks'::regclass and tgname = 'zz_r436_no_circle' and tgenabled = 'O')),
  ('15 schema marker 436 recorded (or no 0412 marker table)',
     to_regclass('public.helm_schema_markers') is null or exists (select 1 from public.helm_schema_markers where num = 436))
) v(item, ok) order by item;
commit;
