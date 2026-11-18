-- 0385_r208_task_assign_access.sql - R208 (owner 18 Nov 2026: How can a Supervisor assign tasks? Is giving access to
-- Tasks & crew related to Can change on Quotes? Show the dependencies properly.). Forward-only, additive, safe to run
-- twice. ASCII only. 0379-0384 are taken by other rounds (R202-R207), nothing here depends on them.
-- REQUIRES phase29 / phase57 (role_access, has_area, user_role, current_org_id), 0049 + 0239 (_a49_default_matrix,
--          _a49_seed_clean_matrix),
--          0300 (_r300_area_ok + admin_set_role_access), 0144 / 0311 / 0312 / 0338 / 0361-0364 (the task calls below).
--
-- In plain words:
--   Today every give out work button on Tasks & Crew (and Nudge on the Event-day monitor) needs Staff - Can change.
--   It never needed Quotes & workspace - Can change. But Staff - Can change is a big switch: it also lets a role
--   edit staff records and wages, post open shifts with pay, approve cannot work days and make new staff links. The
--   Supervisor role only has Staff - Can see, so a Supervisor could watch tasks (and even got the 0369 escalation
--   bell) but could not assign, reassign or nudge anyone.
--   This file adds ONE new access switch, Assign & send tasks (area key tasks, a single switch like the money
--   permissions: saved as view + edit together):
--     ON  = may give out and manage work on events: + Add & assign (in-house or to a vendor), reassign, set the start /
--           end time and dependencies, reminders (minutes before or exact times), mark special, cancel with a reason,
--           Nudge / Send by e-mail, Send on WhatsApp, the persons task links (copy, never make new ones).
--     It needs Staff - Can see (to see the crew and the tasks), without it the switch does nothing.
--     It does NOT give: staff records or wages, open shifts (they carry pay), approving days off, new staff links,
--     anything about money. Those stay with Staff - Can change (and the money switches).
--   NOBODY LOSES ANYTHING: a role with no tasks row follows its Staff - Can change switch exactly as before (the
--   new helper is has_area(staff, edit) word for word for such a role). The only rows this file writes are
--   (supervisor, tasks, on) for each studio whose Supervisor can already see Staff and has no tasks row yet -
--   so Supervisors can assign tasks for events and nothing else. Once a studio has a tasks row for a role, that row
--   decides (an admin can switch it off for a role that keeps Staff - Can change).
--
--   1  _r385_can_assign(): no tasks row for my role -> has_area(staff, edit) (todays rule). A tasks row ->
--      that row (view and edit) AND Staff - Can see, never for a client / crew / worker login. Admin = always.
--   2  The staff-edit check inside each task call is swapped for _r385_can_assign() IN PLACE (the live body is read and
--      exactly one check is replaced - the way 0198 / 0241 patch _tr184_*, a body that does not have exactly one such
--      check is left unchanged and the last check below says so). Calls: assign_tasks, assign_tasks_vendor (Vendors
--      edit still works too), reassign_task (its 0311 + pre0311 layers), cancel_task, set_task_schedule,
--      set_task_special, set_task_reminders, set_task_reminder_times, run_task_triggers, run_task_reminders,
--      staff_email_send, staff_email_hold, staff_whatsapp_send, staff_link_get, work_links_for_event.
--      NOT changed (still Staff - Can change): staff_link_regenerate, open_shift_post / _set_status / _decide,
--      cantwork_decide, crew_availability_set, event_checkin_site_set, admin_revoke_work_links, staff_department_add,
--      crew_members / event_tasks / work_tokens row policies (RLS is unchanged for everyone).
--   3  _r300_area_ok (the access matrix accepts known areas only) learns tasks (patched in place, the list kept).
--   4  A NEW studio starts with tasks on for the roles that can change Staff in the default matrix + supervisor:
--      _a49_seed_clean_matrix is wrapped once (old body kept as __pre0385), _a49_default_matrix itself is unchanged.
--   5  Existing studios: (supervisor, tasks, on) where the Supervisor can see Staff and no tasks row exists yet.
--      Written as a normal row (the audit trigger logs it), never overwrites a row an admin saved.
--   Nothing dropped, nothing deleted, no policy changed. If it stops with a STOP message nothing was applied.
--
-- Undo (manual, if ever needed): remove the role_access rows of area tasks - everyone then follows Staff again
-- (the patched calls then behave exactly as before 0385).

-- ---- 0) preflight -----------------------------------------------------------------------------------------------------
do $$ begin
  if to_regclass('public.role_access') is null or to_regprocedure('public.has_area(text,text)') is null
     or to_regprocedure('public.user_role()') is null or to_regprocedure('public.current_org_id()') is null then
    raise exception 'STOP 0385: role_access / has_area / user_role / current_org_id missing (phase29 / phase57)'; end if;
  if to_regprocedure('public._r300_area_ok(text)') is null then raise exception 'STOP 0385: run 0300 first (_r300_area_ok)'; end if;
  if to_regprocedure('public._a49_default_matrix()') is null or to_regprocedure('public._a49_seed_clean_matrix(uuid)') is null then
    raise exception 'STOP 0385: run 0049 + 0239 first (_a49_default_matrix / _a49_seed_clean_matrix)'; end if;
  if to_regprocedure('public.assign_tasks(uuid,text,text[],uuid,text,text)') is null
     or to_regprocedure('public._r311_reassign_task(uuid,uuid,text,text)') is null
     or to_regprocedure('public.cancel_task(uuid,text)') is null
     or to_regprocedure('public.set_task_reminder_times(uuid,timestamptz[])') is null
     or to_regprocedure('public.staff_email_send(uuid,boolean)') is null
     or to_regprocedure('public.staff_link_get(uuid)') is null then
    raise exception 'STOP 0385: the task calls are missing - run 0311, 0312, 0361, 0363 and 0364 first'; end if;
end $$;

-- ---- 1) who may give out work ------------------------------------------------------------------------------------------
create or replace function public._r385_can_assign()
returns boolean language sql stable security definer set search_path = '' as $$
  -- r208-0385: no tasks row for my role = todays rule (Staff - Can change), word for word. A tasks row decides:
  -- view + edit on it AND Staff - Can see, never a client / crew / worker login. Admin always (has_area says so).
  select case
    when coalesce(public.user_role(), '') <> 'admin'
         and exists (select 1 from public.role_access ra
                      where ra.org_id = public.current_org_id() and ra.role = public.user_role() and ra.area = 'tasks')
      then coalesce(public.user_role(), '') not in ('client', 'crew', 'worker')
           and coalesce(public.has_area('staff', 'view'), false)
           and coalesce((select ra.can_view and ra.can_edit from public.role_access ra
                          where ra.org_id = public.current_org_id() and ra.role = public.user_role() and ra.area = 'tasks'), false)
    else coalesce(public.has_area('staff', 'edit'), false)
  end;
$$;
do $$ begin
  execute 'revoke all on function public._r385_can_assign() from public';
  if exists (select 1 from pg_roles where rolname = 'anon') then execute 'revoke all on function public._r385_can_assign() from anon'; end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then execute 'revoke all on function public._r385_can_assign() from authenticated'; end if;
  if exists (select 1 from pg_roles where rolname = 'service_role') then execute 'grant execute on function public._r385_can_assign() to service_role'; end if;
end $$;

-- ---- 2) the task calls ask _r385_can_assign() instead of Staff - Can change (patched in place, exactly one check each) ---
do $$
declare
  f text; v_def text; v_new text; n int;
  v_list text[] := array[
    'public.assign_tasks(uuid,text,text[],uuid,text,text)',
    'public.assign_tasks_vendor(uuid,text,text[],uuid)',
    'public._r311_reassign_task(uuid,uuid,text,text)',
    'public.reassign_task__pre0311(uuid,uuid,text,text)',
    'public.cancel_task(uuid,text)',
    'public.set_task_schedule(uuid,timestamptz,timestamptz,uuid)',
    'public.set_task_special(uuid,boolean,integer)',
    'public.set_task_reminders(uuid,integer[])',
    'public.set_task_reminder_times(uuid,timestamptz[])',
    'public.run_task_triggers(uuid)',
    'public.run_task_reminders(uuid)',
    'public.staff_email_send(uuid,boolean)',
    'public.staff_email_hold(uuid,uuid)',
    'public.staff_whatsapp_send(uuid)',
    'public.staff_link_get(uuid)',
    'public.work_links_for_event(uuid)'];
begin
  foreach f in array v_list loop
    if to_regprocedure(f) is null then raise notice '0385: % is not installed - skipped', f; continue; end if;
    v_def := pg_get_functiondef(to_regprocedure(f));
    if position('r208-0385' in v_def) > 0 then continue; end if;                       -- already patched (second run)
    v_new := replace(replace(v_def, 'public.has_area(''staff'', ''edit'')', 'public._r385_can_assign() /* r208-0385 */'),
                     'public.has_area(''staff'',''edit'')', 'public._r385_can_assign() /* r208-0385 */');
    n := (length(v_new) - length(replace(v_new, 'r208-0385', ''))) / length('r208-0385');
    if n <> 1 then raise notice '0385: % has % Staff-edit checks (expected exactly 1) - left unchanged', f, n; continue; end if;
    execute v_new;
  end loop;
end $$;

-- ---- 3) the access matrix accepts the new area -------------------------------------------------------------------------
do $$ declare v_def text; begin
  v_def := pg_get_functiondef('public._r300_area_ok(text)'::regprocedure);
  if position('''tasks''' in v_def) = 0 then
    if (length(v_def) - length(replace(v_def, 'p_area = any (array[', ''))) / length('p_area = any (array[') <> 1 then
      raise notice '0385: _r300_area_ok has an unexpected body - left unchanged';
    else
      execute replace(v_def, 'p_area = any (array[', 'p_area = any (array[''tasks'' /* r208-0385 */, ');
    end if;
  end if;
end $$;

-- ---- 4) what a NEW studio starts with: + tasks (the roles that can change Staff in the template + supervisor) ---------
-- _a49_default_matrix() itself is NOT changed (0239 re-checks its exact rows), the seeding step that copies it into a new
-- studio is wrapped once (old body kept as _a49_seed_clean_matrix__pre0385) and then writes the tasks rows.
do $$ begin
  if to_regprocedure('public._a49_seed_clean_matrix__pre0385(uuid)') is null then
    alter function public._a49_seed_clean_matrix(uuid) rename to _a49_seed_clean_matrix__pre0385;
  end if;
end $$;

create or replace function public._a49_seed_clean_matrix(p_org uuid)
returns integer language plpgsql security definer set search_path = '' as $$
-- r208-0385: the clean default matrix (0049 / 0239, unchanged), then Assign & send tasks: on for every role that can
-- change Staff in that template, plus supervisor, off for the rest (one switch = view + edit together)
declare n int; m int;
begin
  n := public._a49_seed_clean_matrix__pre0385(p_org);
  insert into public.role_access(org_id, role, area, can_view, can_edit, updated_at)
    select p_org, d.role, 'tasks', d.can_edit or d.role = 'supervisor', d.can_edit or d.role = 'supervisor', now()
      from public._a49_default_matrix() d where d.area = 'staff'
  on conflict (org_id, role, area) do update set can_view = excluded.can_view, can_edit = excluded.can_edit, updated_at = now();
  get diagnostics m = row_count;
  return coalesce(n, 0) + coalesce(m, 0);
end $$;
do $$ begin
  execute 'revoke all on function public._a49_seed_clean_matrix(uuid) from public';
  execute 'revoke all on function public._a49_seed_clean_matrix__pre0385(uuid) from public';
  if exists (select 1 from pg_roles where rolname = 'anon') then
    execute 'revoke all on function public._a49_seed_clean_matrix(uuid) from anon';
    execute 'revoke all on function public._a49_seed_clean_matrix__pre0385(uuid) from anon'; end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    execute 'revoke all on function public._a49_seed_clean_matrix(uuid) from authenticated';
    execute 'revoke all on function public._a49_seed_clean_matrix__pre0385(uuid) from authenticated'; end if;
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    execute 'grant execute on function public._a49_seed_clean_matrix(uuid) to service_role'; end if;
end $$;

-- ---- 5) existing studios: Supervisors may assign tasks (only where they can see Staff and no tasks row exists yet) ---
insert into public.role_access(org_id, role, area, can_view, can_edit, updated_at)
  select s.org_id, 'supervisor', 'tasks', true, true, now()
    from public.role_access s
   where s.role = 'supervisor' and s.area = 'staff' and s.can_view and s.org_id is not null
     and not exists (select 1 from public.role_access t where t.org_id = s.org_id and t.role = 'supervisor' and t.area = 'tasks')
on conflict (org_id, role, area) do nothing;
