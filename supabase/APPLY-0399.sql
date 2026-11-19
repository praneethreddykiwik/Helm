-- APPLY-0399 (R230 department supervisors on Tasks & Crew: one supervisor per event + department).
-- Run on STAGING first, then production. Safe to run twice. Needs 0283 and 0385 first - already on both.
-- What it does: lets the office pick ONE supervisor per department of an event (department = the task section the tasks
-- already use, e.g. Catering). New tables event_department_supervisors (who supervises what) and
-- event_department_supervisor_log (the history: set / replaced / cleared, who + when). The new supervisor gets one in-app
-- bell notice. The late / escalation bell notices (0369 + 0396) for that department tasks also go to its supervisor
-- (they are added to the notice list, nobody is removed). Bell only - no e-mail, no WhatsApp. No money.
-- Nothing is dropped, deleted or changed. Until this runs, Tasks & Crew simply shows no supervisor pickers.
-- Paste the whole file into the Supabase SQL editor and press Run. The last result lists checks - every ok must be true.
begin;
-- 0399_r230_dept_supervisors.sql - CANONICAL forward-only. R230 (owner, 18 Nov 2026: under Catering, Koushik has cooking
-- and Vivek has another task, on top of them, a supervisor monitors the Catering department).
-- REQUIRES base quotes / event_tasks / notifications / profiles / organizations, has_area + current_org_id (phase29 / 57),
--          0283 (_r283_is_off), 0385 (_r385_can_assign = Assign & send tasks).
--          0369 / 0396 are NOT required: when they are present their late / escalation bell rows also reach the supervisor.
--
-- In plain words:
--   1  Each event can have ONE supervisor per department. A department is the section the tasks already use
--      (event_tasks.category: Stage setup, Catering, AV & sound ...), no new list. Saved in a new table
--      event_department_supervisors, one row per (event, department). Clearing a supervisor keeps the row with no person
--      (nothing is ever deleted). Who set it and when are kept.
--   2  Every change is written to event_department_supervisor_log (Meera set Sunil as Catering supervisor, replaced,
--      cleared) and to the shared Audit log (tg_audit). Append only.
--   3  The supervisor can be a login whose role is Supervisor, Event manager (manager) or Admin, of the same studio, not
--      switched off. Giving the job sends that person ONE in-app bell notice (kind task_escalated, only they see it).
--      Saving the same person again changes nothing and sends nothing.
--   4  Late alerts: the bell notices of the special-task escalation ladder (0369) and the latest-start alerts (0396) for a
--      task also go to the supervisor of that task department. This is done by ADDING the supervisor to the row notify
--      list as the row is written (a BEFORE INSERT trigger on notifications, only for kind task_escalated rows of those
--      two sources, never blocks the insert). Nobody already on the list is removed. Bell only - no e-mail, no WhatsApp.
--
-- Access: reading = Staff - Can see (anyone who can see the event tasks) or Assign & send tasks, choosing a supervisor =
-- Assign & send tasks (0385, _r385_can_assign). Same studio only. Nothing here holds or returns money.
--
-- ZERO DATA LOSS: additive + idempotent. Two new tables, new functions, one new trigger on notifications (adds names only),
-- tenant guard / read-only / audit triggers on the new tables, and the free-trial retention list (0184) learns the new
-- tables (patched in place once, like 0396). Nothing dropped, nothing deleted, no existing function, policy or row changed.
-- Safe to run twice. ASCII only.
-- Undo (manual, if ever needed): drop trigger zz_r399_dept_supervisor_notify on public.notifications - the supervisors then
-- simply stop getting the late alerts, the two tables can stay.

-- ---- 0) preflight -----------------------------------------------------------------------------------------------------
do $$ begin
  if to_regclass('public.event_tasks') is null or to_regclass('public.quotes') is null or to_regclass('public.notifications') is null
     or to_regclass('public.profiles') is null or to_regclass('public.organizations') is null then
    raise exception 'STOP 0399: quotes / event_tasks / notifications / profiles / organizations missing'; end if;
  if to_regprocedure('public.has_area(text,text)') is null or to_regprocedure('public.current_org_id()') is null then
    raise exception 'STOP 0399: has_area / current_org_id missing (phase29 / phase57)'; end if;
  if to_regprocedure('public._r385_can_assign()') is null then
    raise exception 'STOP 0399: run 0385 first (_r385_can_assign)'; end if;
  if to_regprocedure('public._r283_is_off(uuid,uuid)') is null then
    raise exception 'STOP 0399: run 0283 first (_r283_is_off)'; end if;
end $$;

-- ---- 1) one supervisor per event + department -------------------------------------------------------------------------
create table if not exists public.event_department_supervisors (
  id           uuid primary key default gen_random_uuid(),
  org_id       uuid not null references public.organizations(id),
  quote_id     uuid not null references public.quotes(id) on delete cascade,
  department   text not null,
  profile_id   uuid references public.profiles(id) on delete set null,
  assigned_by  uuid,
  assigned_at  timestamptz not null default now(),
  constraint event_department_supervisors_dept_chk399 check (char_length(department) between 1 and 60 and department = btrim(department)),
  constraint event_department_supervisors_uq399 unique (quote_id, department)
);
create index if not exists event_department_supervisors_org399 on public.event_department_supervisors (org_id);
create index if not exists event_department_supervisors_profile399 on public.event_department_supervisors (profile_id) where profile_id is not null;

-- ---- 2) the history (append only) -------------------------------------------------------------------------------------
create table if not exists public.event_department_supervisor_log (
  id               uuid primary key default gen_random_uuid(),
  org_id           uuid not null references public.organizations(id),
  quote_id         uuid not null references public.quotes(id) on delete cascade,
  department       text not null,
  action           text not null,
  profile_id       uuid,
  name             text,
  prev_profile_id  uuid,
  prev_name        text,
  actor            uuid,
  actor_name       text,
  at               timestamptz not null default now(),
  constraint event_department_supervisor_log_action_chk399 check (action in ('set', 'replaced', 'cleared')),
  constraint event_department_supervisor_log_len_chk399 check (char_length(department) between 1 and 60
    and (name is null or char_length(name) <= 120) and (prev_name is null or char_length(prev_name) <= 120)
    and (actor_name is null or char_length(actor_name) <= 120))
);
create index if not exists event_department_supervisor_log_quote399 on public.event_department_supervisor_log (quote_id, at desc);
create index if not exists event_department_supervisor_log_org399 on public.event_department_supervisor_log (org_id);

-- row security: the supervisors of the caller own studio can be read (Staff - Can see), every write goes through the calls
do $$ declare t text; begin
  foreach t in array array['event_department_supervisors', 'event_department_supervisor_log'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on table public.%I from public', t);
    if exists (select 1 from pg_roles where rolname = 'anon') then execute format('revoke all on table public.%I from anon', t); end if;
    if exists (select 1 from pg_roles where rolname = 'authenticated') then execute format('revoke all on table public.%I from authenticated', t); end if;
    if exists (select 1 from pg_roles where rolname = 'service_role') then execute format('grant select on table public.%I to service_role', t); end if;
  end loop;
end $$;
drop policy if exists "eds read same studio" on public.event_department_supervisors;
create policy "eds read same studio" on public.event_department_supervisors for select to authenticated
  using (org_id = (select public.current_org_id()) and (select public.has_area('staff', 'view')));
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    execute 'grant select on table public.event_department_supervisors to authenticated'; end if;
end $$;

-- the event must belong to the same studio (shared guard) + a suspended / ended-trial studio takes no new rows (0045)
-- + every change in the Audit log (shared tg_audit, like 0394)
do $$ declare t text; begin
  foreach t in array array['event_department_supervisors', 'event_department_supervisor_log'] loop
    if to_regprocedure('public.tg_quote_org_match()') is not null then
      execute format('drop trigger if exists zz_quote_org_match on public.%I', t);
      execute format('create trigger zz_quote_org_match before insert or update on public.%I for each row execute function public.tg_quote_org_match()', t);
    end if;
    if to_regprocedure('public.tg_studio_read_only()') is not null
       and not exists (select 1 from pg_catalog.pg_trigger where tgname = 'zzz_studio_read_only' and tgrelid = ('public.' || t)::regclass) then
      execute format('create trigger zzz_studio_read_only before insert or update or delete on public.%I for each row execute function public.tg_studio_read_only(''org_id'')', t);
    end if;
  end loop;
  if to_regprocedure('public.tg_audit()') is not null then
    execute 'drop trigger if exists audit_trg on public.event_department_supervisors';
    execute 'create trigger audit_trg after insert or delete or update on public.event_department_supervisors for each row execute function public.tg_audit()';
  end if;
end $$;

-- ---- 3) helpers (server only) -----------------------------------------------------------------------------------------
-- a person display name (never the full e-mail)
create or replace function public._r399_name(p_profile uuid)
returns text language sql stable security definer set search_path = '' as $fn$
  -- r230-0399
  select left(coalesce(nullif(btrim(p.full_name), ''), nullif(split_part(coalesce(p.email, ''), '@', 1), ''), 'Team member'), 120)
    from public.profiles p where p.id = p_profile;
$fn$;

-- the role of a person who may supervise a department in this studio (supervisor / manager / admin, not switched off), else null
create or replace function public._r399_role_ok(p_org uuid, p_profile uuid)
returns text language sql stable security definer set search_path = '' as $fn$
  -- r230-0399
  select lower(p.role) from public.profiles p
   where p.id = p_profile and p.org_id = p_org and p_org is not null
     and lower(coalesce(p.role, '')) in ('supervisor', 'manager', 'admin')
     and not coalesce(public._r283_is_off(p.id, p_org), false);
$fn$;

-- the caller studio + the event, or an exception (same studio only)
create or replace function public._r399_event(p_quote uuid)
returns uuid language plpgsql stable security definer set search_path = '' as $fn$
-- r230-0399
declare v_org uuid := public.current_org_id();
begin
  if auth.uid() is null or v_org is null then raise exception 'not allowed' using errcode = '42501'; end if;
  if p_quote is null or not exists (select 1 from public.quotes q where q.id = p_quote and q.org_id = v_org) then
    raise exception 'event not found' using errcode = 'P0002'; end if;
  return v_org;
end $fn$;

-- ---- 4) the page calls ------------------------------------------------------------------------------------------------
-- the supervisors of one event, who may be picked, and the last changes
create or replace function public.event_department_supervisors_get(p_quote uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $fn$
-- r230-0399
declare v_org uuid; v_edit boolean;
begin
  v_org := public._r399_event(p_quote);
  v_edit := coalesce(public._r385_can_assign(), false);
  if not (v_edit or coalesce(public.has_area('staff', 'view'), false)) then raise exception 'not allowed' using errcode = '42501'; end if;
  return jsonb_build_object(
    'v', 1,
    'can_edit', v_edit,
    'me', auth.uid(),
    'rows', coalesce((select jsonb_agg(jsonb_build_object('department', s.department, 'profile_id', s.profile_id,
                        'name', public._r399_name(s.profile_id), 'role', lower(coalesce(p.role, '')),
                        'assigned_by', public._r399_name(s.assigned_by), 'assigned_at', s.assigned_at) order by s.department)
                        from public.event_department_supervisors s join public.profiles p on p.id = s.profile_id
                       where s.quote_id = p_quote and s.org_id = v_org and s.profile_id is not null), '[]'::jsonb),
    'candidates', coalesce((select jsonb_agg(jsonb_build_object('id', p.id, 'name', public._r399_name(p.id), 'role', lower(p.role))
                              order by case lower(p.role) when 'supervisor' then 0 when 'manager' then 1 else 2 end, public._r399_name(p.id))
                              from public.profiles p
                             where p.org_id = v_org and lower(coalesce(p.role, '')) in ('supervisor', 'manager', 'admin')
                               and not coalesce(public._r283_is_off(p.id, v_org), false)), '[]'::jsonb),
    'log', coalesce((select jsonb_agg(jsonb_build_object('department', x.department, 'action', x.action, 'name', x.name,
                       'prev_name', x.prev_name, 'by', x.actor_name, 'at', x.at) order by x.at desc)
                       from (select l.* from public.event_department_supervisor_log l
                              where l.quote_id = p_quote and l.org_id = v_org order by l.at desc limit 30) x), '[]'::jsonb));
end $fn$;

-- set (p_profile = a person) or clear (p_profile = null) the supervisor of one department of one event
create or replace function public.event_department_supervisor_set(p_quote uuid, p_department text, p_profile uuid)
returns jsonb language plpgsql volatile security definer set search_path = '' as $fn$
-- r230-0399
declare v_org uuid; v_dept text := btrim(coalesce(p_department, '')); v_role text; v_prev uuid; v_had boolean;
        v_name text; v_prev_name text; v_actor text; v_action text; v_ev text; v_tpl boolean := false;
begin
  v_org := public._r399_event(p_quote);
  if not coalesce(public._r385_can_assign(), false) then raise exception 'not allowed' using errcode = '42501'; end if;
  if char_length(v_dept) < 1 or char_length(v_dept) > 60 then raise exception 'invalid_department' using errcode = 'P0001'; end if;
  -- a department = a section the event tasks use, or a section of the studio task checklist
  if to_regclass('public.task_templates') is not null then
    execute 'select exists (select 1 from public.task_templates t where t.org_id = $1 and btrim(t.category) = $2)' into v_tpl using v_org, v_dept;
  end if;
  if not v_tpl and not exists (select 1 from public.event_tasks t where t.quote_id = p_quote and t.org_id = v_org and btrim(coalesce(t.category, '')) = v_dept) then
    raise exception 'invalid_department' using errcode = 'P0001'; end if;
  if p_profile is not null then
    v_role := public._r399_role_ok(v_org, p_profile);
    if v_role is null then raise exception 'invalid_person' using errcode = 'P0001'; end if;
  end if;
  select s.profile_id, true into v_prev, v_had from public.event_department_supervisors s
   where s.quote_id = p_quote and s.department = v_dept for update;
  if p_profile is not distinct from v_prev then
    return jsonb_build_object('ok', true, 'changed', false, 'department', v_dept, 'profile_id', p_profile,
                              'name', public._r399_name(p_profile), 'role', v_role);
  end if;
  insert into public.event_department_supervisors (org_id, quote_id, department, profile_id, assigned_by, assigned_at)
  values (v_org, p_quote, v_dept, p_profile, auth.uid(), now())
  on conflict (quote_id, department) do update set profile_id = excluded.profile_id, assigned_by = excluded.assigned_by, assigned_at = now();
  v_name := public._r399_name(p_profile); v_prev_name := public._r399_name(v_prev); v_actor := public._r399_name(auth.uid());
  v_action := case when p_profile is null then 'cleared' when v_prev is null then 'set' else 'replaced' end;
  insert into public.event_department_supervisor_log (org_id, quote_id, department, action, profile_id, name, prev_profile_id, prev_name, actor, actor_name)
  values (v_org, p_quote, v_dept, v_action, p_profile, v_name, v_prev, v_prev_name, auth.uid(), v_actor);
  -- the new supervisor: one bell notice, only for them (never for yourself, never blocks the save)
  if p_profile is not null and p_profile is distinct from auth.uid() then
    begin
      select coalesce(nullif(q.code, ''), left(coalesce(q.title, 'an event'), 60)) into v_ev from public.quotes q where q.id = p_quote;
      insert into public.notifications (quote_id, channel, kind, status, detail, org_id)
      values (p_quote, 'in_app', 'task_escalated', 'simulated',
              jsonb_build_object('label', left('You are the ' || v_dept || ' supervisor for ' || coalesce(v_ev, 'an event') || ' (set by ' || coalesce(v_actor, 'the office') || ')', 300),
                                 'department', v_dept, 'notify', jsonb_build_array(p_profile::text), 'source', '0399', 'via', 'dept_supervisor'),
              v_org);
    exception when others then raise warning 'r230-0399: bell notice skipped (%)', sqlstate;
    end;
  end if;
  return jsonb_build_object('ok', true, 'changed', true, 'action', v_action, 'department', v_dept, 'profile_id', p_profile,
                            'name', v_name, 'role', v_role);
end $fn$;

-- ---- 5) late alerts also reach the department supervisor ------------------------------------------------------------
-- BEFORE INSERT on notifications, only kind task_escalated (trigger WHEN): for a task escalation step (0369) or its
-- latest-start reminder / red alert (0396), the supervisor of the task department is added to detail.notify.
-- Never removes anyone, never blocks the insert (any problem = the row goes in unchanged).
create or replace function public._r399_notify_supervisor()
returns trigger language plpgsql security definer set search_path = '' as $fn$
-- r230-0399
declare v_task uuid; v_sup uuid; v_list jsonb;
begin
  begin
    if jsonb_typeof(new.detail) <> 'object' or jsonb_typeof(new.detail -> 'notify') <> 'array' then return new; end if;
    if not (coalesce(new.detail ->> 'source', '') in ('0369', '0396')
            and coalesce(new.detail ->> 'via', '') in ('escalation', 'latest_soon', 'latest_late')) then return new; end if;
    if coalesce(new.detail ->> 'task_id', '') !~ '^[0-9a-fA-F-]{36}$' then return new; end if;
    v_task := (new.detail ->> 'task_id')::uuid;
    select s.profile_id into v_sup
      from public.event_tasks t
      join public.event_department_supervisors s on s.quote_id = t.quote_id and s.org_id = t.org_id and s.department = btrim(coalesce(t.category, ''))
     where t.id = v_task and t.org_id = new.org_id and s.profile_id is not null;
    if v_sup is null or public._r399_role_ok(new.org_id, v_sup) is null then return new; end if;
    v_list := new.detail -> 'notify';
    if v_list ? v_sup::text then return new; end if;
    new.detail := jsonb_set(new.detail, '{notify}', v_list || jsonb_build_array(v_sup::text)) || jsonb_build_object('dept_supervisor', v_sup::text);
  exception when others then
    raise warning 'r230-0399: supervisor not added (%)', sqlstate;
  end;
  return new;
end $fn$;
drop trigger if exists zz_r399_dept_supervisor_notify on public.notifications;
create trigger zz_r399_dept_supervisor_notify before insert on public.notifications
  for each row when (new.kind = 'task_escalated') execute function public._r399_notify_supervisor();

-- ---- 6) grants ----------------------------------------------------------------------------------------------------------
do $$ declare f text; begin
  foreach f in array array['public._r399_name(uuid)', 'public._r399_role_ok(uuid,uuid)', 'public._r399_event(uuid)', 'public._r399_notify_supervisor()'] loop
    execute format('revoke all on function %s from public', f);
    if exists (select 1 from pg_roles where rolname = 'anon') then execute format('revoke all on function %s from anon', f); end if;
    if exists (select 1 from pg_roles where rolname = 'authenticated') then execute format('revoke all on function %s from authenticated', f); end if;
  end loop;
  foreach f in array array['public.event_department_supervisors_get(uuid)', 'public.event_department_supervisor_set(uuid,text,uuid)'] loop
    execute format('revoke all on function %s from public', f);
    if exists (select 1 from pg_roles where rolname = 'anon') then execute format('revoke all on function %s from anon', f); end if;
    if exists (select 1 from pg_roles where rolname = 'authenticated') then execute format('grant execute on function %s to authenticated', f); end if;
    if exists (select 1 from pg_roles where rolname = 'service_role') then execute format('grant execute on function %s to service_role', f); end if;
  end loop;
end $$;

-- ---- 7) free-trial retention (0184): the rows go with the studio events (like 0396) --------------------------------------
do $$ declare v_def text; begin
  if to_regprocedure('public._tr184_purge_tables()') is not null then
    v_def := pg_get_functiondef('public._tr184_purge_tables()'::regprocedure);
    if position('''event_department_supervisors''' in v_def) = 0 then
      if (length(v_def) - length(replace(v_def, '''event_stock_requests'', ', ''))) / length('''event_stock_requests'', ') <> 1 then
        raise notice '0399: _tr184_purge_tables has an unexpected body - left unchanged';
      else execute replace(v_def, '''event_stock_requests'', ', '''event_stock_requests'', ''event_department_supervisor_log'', ''event_department_supervisors'', '); end if;
    end if;
  end if;
end $$;

select item, ok from (values
  ('01 event_department_supervisors and event_department_supervisor_log exist with RLS on',
     (select count(*) from pg_class c where c.relrowsecurity and c.oid in (to_regclass('public.event_department_supervisors'), to_regclass('public.event_department_supervisor_log'))) = 2),
  ('02 signed-in users may only READ supervisors of their own studio (policy); the history is closed; anon has nothing',
     has_table_privilege('authenticated', 'public.event_department_supervisors', 'select')
     and not has_table_privilege('authenticated', 'public.event_department_supervisors', 'insert')
     and not has_table_privilege('authenticated', 'public.event_department_supervisors', 'update')
     and not has_table_privilege('authenticated', 'public.event_department_supervisors', 'delete')
     and not has_table_privilege('authenticated', 'public.event_department_supervisor_log', 'select')
     and not has_table_privilege('anon', 'public.event_department_supervisors', 'select')
     and exists (select 1 from pg_policies p where p.schemaname = 'public' and p.tablename = 'event_department_supervisors'
                   and p.policyname = 'eds read same studio' and p.cmd = 'SELECT' and p.qual like '%current_org_id%')),
  ('03 the two page calls exist and signed-in users may run them, anon may not',
     (select count(*) from unnest(array['public.event_department_supervisors_get(uuid)', 'public.event_department_supervisor_set(uuid,text,uuid)']) f
       where to_regprocedure(f) is not null and has_function_privilege('authenticated', f, 'execute') and not has_function_privilege('anon', f, 'execute')) = 2),
  ('04 the helpers and the trigger function are server only',
     (select count(*) from unnest(array['public._r399_name(uuid)', 'public._r399_role_ok(uuid,uuid)', 'public._r399_event(uuid)', 'public._r399_notify_supervisor()']) f
       where to_regprocedure(f) is not null and not has_function_privilege('authenticated', f, 'execute') and not has_function_privilege('anon', f, 'execute')) = 4),
  ('05 every new function is security definer with an empty pinned search_path',
     (select count(*) = 6 and bool_and(p.prosecdef) and bool_and(coalesce(array_to_string(p.proconfig, ','), '') like '%search_path=""%')
        from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'public' and (p.proname like '\_r399\_%' or p.proname in ('event_department_supervisors_get', 'event_department_supervisor_set')))),
  ('06 one notify trigger on notifications, only for task_escalated rows',
     (select count(*) from pg_trigger t where t.tgname = 'zz_r399_dept_supervisor_notify' and t.tgrelid = 'public.notifications'::regclass
        and pg_get_triggerdef(t.oid) like '%task_escalated%') = 1),
  ('07 the same-studio guard is on both new tables (or the guard is absent)',
     to_regprocedure('public.tg_quote_org_match()') is null
     or (select count(*) from pg_trigger t where t.tgname = 'zz_quote_org_match' and t.tgrelid in (to_regclass('public.event_department_supervisors'), to_regclass('public.event_department_supervisor_log'))) = 2),
  ('08 supervisor changes go to the Audit log (or tg_audit is absent)',
     to_regprocedure('public.tg_audit()') is null
     or (select count(*) from pg_trigger t where t.tgname = 'audit_trg' and t.tgrelid = to_regclass('public.event_department_supervisors')) = 1),
  ('09 free-trial retention knows the new tables (rows purged with a trial), or 0184 is absent',
     to_regprocedure('public._tr184_purge_tables()') is null
     or array['event_department_supervisors', 'event_department_supervisor_log']::text[] <@ public._tr184_purge_tables()),
  ('10 nothing existing was touched: task_escalated rows still go only to the people named (0369 bell rule kept)',
     position('task_escalated' in coalesce((select p.prosrc from pg_proc p where p.oid = to_regprocedure('public._r388_vis(uuid,uuid)')),
                                           (select p.prosrc from pg_proc p where p.oid = to_regprocedure('public._r23_visible(uuid,uuid)')), '')) > 0),
  ('11 one row per event + department (unique) and a department is 1..60 characters',
     (select count(*) from pg_constraint where conname in ('event_department_supervisors_uq399', 'event_department_supervisors_dept_chk399')) = 2),
  ('12 signed-out users cannot run any 0399 function',
     not exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                  where n.nspname = 'public' and (p.proname like '\_r399\_%' or p.proname in ('event_department_supervisors_get', 'event_department_supervisor_set'))
                    and has_function_privilege('anon', p.oid, 'execute')))
) v(item, ok) order by item;
commit;
