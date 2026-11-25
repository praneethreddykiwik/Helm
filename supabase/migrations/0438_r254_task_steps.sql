-- 0438_r254_task_steps.sql - R254 "the step of a task is what the person picked" + "one person, two works at the same time" (owner,
-- 25 Nov 2026; staging, later Canada production and Mumbai). Forward-only, additive, safe to run twice. ASCII only.
-- REQUIRES 0368, 0385, 0397, 0401, 0434, 0436.
--
-- In plain words:
--   A  event_tasks.step: daybefore / pre / onday / wrapup, or empty (tasks made before this: the page's old rule, nothing jumps).
--      Studio switch auto_steps (task_reminder_settings, OFF by default; task_reminder_settings_get / _set). Off: a new task without a
--      step gets 'pre', whatever makes it. On: nothing is filled in; a saved step is kept for later. Never filled in: sample data copied
--      for a trial, restores / the SQL editor. Nothing is backfilled.
--   B  assign_tasks_step / assign_tasks_vendor_step (+ _once): the existing calls plus the picked step, in one transaction.
--   C  set_task_step(tasks, step): moves up to 200 tasks. Assign & send tasks right, own studio, live event, refused while the plan is locked.
--      One line in the task log (kind step_changed); no message to anybody. A direct change of the column follows the same rules.
--   D  crew_time_clashes(items, exclude): READ ONLY - which other works of the same person overlap. Staff view.
-- Nothing else uses the step: reminders, "you can start now", the escalation and the red banner keep using the time.
-- ZERO DATA LOSS: 2 columns (empty / default false), 2 checks, 1 index, functions, 3 triggers. No stored row changed. Old signatures stay.
-- Bodies wrapped in the 0434 way: the old one kept as <name>__pre0438 (server only). If 0338 or 0434 is ever pasted again, paste 0438 again.
-- SWITCH OFF (nothing deleted): alter table public.event_tasks disable trigger zz_r438_step_default;  (new tasks get no step)

-- ---- 0) preflight -----------------------------------------------------------------------------------------------------------
do $$ declare f text; begin
  if to_regclass('public.task_reminder_settings') is null or to_regclass('public.event_task_log') is null then raise exception 'STOP 0438: run 0338 and 0368 first'; end if;
  foreach f in array array['public._r385_can_assign()', 'public._r397_guard(uuid,text)', 'public._r401_key_get(text,uuid,text)', 'public._r401_key_put(text,uuid,text,jsonb)',
      'public.assign_tasks(uuid,text,text[],uuid,text,text)', 'public.assign_tasks_vendor(uuid,text,text[],uuid)', 'public.task_reminder_settings_get()',
      'public.task_reminder_settings_set(jsonb)', 'public._r368_actor_kind()', 'public._is_system_change()', 'public._r436_waits(uuid,uuid,uuid)'] loop
    if to_regprocedure(f) is null then raise exception 'STOP 0438: % is missing - an earlier update is not on this database', f; end if;
  end loop;
end $$;

-- ---- 1) columns, checks, index ---------------------------------------------------------------------------------------------------
alter table public.event_tasks add column if not exists step text;
alter table public.task_reminder_settings add column if not exists auto_steps boolean not null default false;
do $$ declare v_def text; begin
  if not exists (select 1 from pg_constraint where conrelid = 'public.event_tasks'::regclass and conname = 'event_tasks_step_chk438') then
    alter table public.event_tasks add constraint event_tasks_step_chk438 check (step is null or step in ('daybefore', 'pre', 'onday', 'wrapup')); end if;
  -- the task log knows one more word (the same list + step_changed; a list this file does not know is left as it is)
  select pg_get_constraintdef(c.oid) into v_def from pg_constraint c where c.conrelid = 'public.event_task_log'::regclass and c.conname = 'event_task_log_kind_chk369';
  if v_def is not null and position('step_changed' in v_def) = 0 then
    if (length(v_def) - length(replace(v_def, '::text', ''))) / length('::text') = 16 and position('''escalated''' in v_def) > 0 then
      alter table public.event_task_log drop constraint event_task_log_kind_chk369,
        add constraint event_task_log_kind_chk369 check (kind in ('assigned', 'reassigned', 'unassigned', 'time_changed', 'special_on', 'special_off', 'accepted', 'rejected',
          'started', 'completed', 'cancelled', 'reopened', 'check_in', 'check_out', 'check_edit', 'escalated', 'step_changed'));
    else raise notice '0438: the task log has an unexpected list of words - step changes are not logged'; end if;
  end if;
end $$;
create index if not exists ix_event_tasks_crew_start_0438 on public.event_tasks (crew_id, planned_start) where crew_id is not null and planned_start is not null;

-- ---- 2) keep helper (same shape as _r437_keep) -----------------------------------------------------------------------------------
create or replace function public._r438_keep(p_fn text)
returns void language plpgsql volatile security definer set search_path = '' as $$
declare v_oid oid := to_regprocedure(p_fn); v_name text; v_types text; v_def text; v_pre text; r text;
begin
  if v_oid is null then return; end if;
  select p.proname, oidvectortypes(p.proargtypes) into v_name, v_types from pg_proc p where p.oid = v_oid;
  v_pre := format('public.%I(%s)', v_name || '__pre0438', v_types);
  if to_regprocedure(v_pre) is null then
    v_def := pg_get_functiondef(v_oid);
    v_def := regexp_replace(v_def, '^CREATE OR REPLACE FUNCTION public\.' || v_name || '\(',
                            'CREATE OR REPLACE FUNCTION public.' || v_name || '__pre0438(');
    if position(v_name || '__pre0438(' in v_def) = 0 then raise exception 'r254-0438: could not keep %', p_fn; end if;
    execute v_def;
  end if;
  execute format('revoke all on function %s from public', v_pre);
  foreach r in array array['anon', 'authenticated', 'service_role'] loop
    if exists (select 1 from pg_roles where rolname = r) then execute format('revoke all on function %s from %I', v_pre, r); end if;
  end loop;
end $$;

-- ---- 3) the studio switch ------------------------------------------------------------------------------------------------------------
create or replace function public._r438_auto(p_org uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  -- r254-0438
  select coalesce((select s.auto_steps from public.task_reminder_settings s where s.org_id = p_org), false);
$$;
do $$ begin
  perform public._r438_keep(f) from unnest(array['public.task_reminder_settings_get()', 'public.task_reminder_settings_set(jsonb)']) f
   where position('r254-0438' in pg_get_functiondef(to_regprocedure(f))) = 0;
end $$;
create or replace function public.task_reminder_settings_get()
returns jsonb language plpgsql stable security definer set search_path = '' as $$
-- r254-0438: the r252-0434 answer (kept as task_reminder_settings_get__pre0438) + auto_steps
declare v jsonb := public.task_reminder_settings_get__pre0438();
begin
  return v || jsonb_build_object('auto_steps', public._r438_auto(public.current_org_id()));
end $$;
create or replace function public.task_reminder_settings_set(p jsonb)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
-- r254-0438: the r252-0434 save (kept as task_reminder_settings_set__pre0438: its checks and refusals first), then auto_steps when the page sends it
begin
  if p ? 'auto_steps' and jsonb_typeof(p -> 'auto_steps') <> 'boolean' then raise exception 'invalid_auto_steps' using errcode = '22023'; end if;
  perform public.task_reminder_settings_set__pre0438(p);
  if p ? 'auto_steps' then
    update public.task_reminder_settings set auto_steps = (p ->> 'auto_steps')::boolean where org_id = public.current_org_id();
  end if;
  return public.task_reminder_settings_get();
end $$;

-- ---- 4) the step of a new task, and who may change it ------------------------------------------------------------------------------------
create or replace function public._r438_tg_step_default()
returns trigger language plpgsql volatile security definer set search_path = '' as $$
-- r254-0438: a given step stays. Else the step picked in this transaction (assign_tasks_step), else 'pre' while the studio sorts by hand.
declare v text := nullif(current_setting('helm.task_step', true), '');
begin
  if new.step is not null or public._is_system_change() then return new; end if;
  if v in ('daybefore', 'pre', 'onday', 'wrapup') then new.step := v; return new; end if;
  -- sample data copied for a trial (no maker): stays as it is
  if new.created_by is null and exists (select 1 from public.quotes q where q.id = new.quote_id and q.is_demo) then return new; end if;
  if not public._r438_auto(new.org_id) then new.step := 'pre'; end if;
  return new;
end $$;
create or replace function public._r438_tg_step_guard()
returns trigger language plpgsql volatile security definer set search_path = '' as $$
-- r254-0438: a direct change follows set_task_step: the Assign & send tasks right, and not while the plan is locked
begin
  if auth.uid() is not null and not coalesce(public._r385_can_assign(), false) then raise exception 'not authorized' using errcode = '42501'; end if;
  perform public._r397_guard(new.quote_id, 'task plan');
  return new;
end $$;
create or replace function public._r438_tg_step_log()
returns trigger language plpgsql volatile security definer set search_path = '' as $$
-- r254-0438: one log row per change; never blocks it; nobody is messaged
begin
  begin
    insert into public.event_task_log (org_id, quote_id, task_id, crew_id, kind, title, detail, actor, actor_kind)
    values (new.org_id, new.quote_id, new.id, new.crew_id, 'step_changed', left(new.title, 300), jsonb_build_object('from', old.step, 'to', new.step), auth.uid(), public._r368_actor_kind());
  exception when others then null;
  end;
  return null;
end $$;
do $$ begin
  if not exists (select 1 from pg_trigger where tgrelid = 'public.event_tasks'::regclass and tgname = 'zz_r438_step_default') then
    create trigger zz_r438_step_default before insert on public.event_tasks for each row when (new.step is null) execute function public._r438_tg_step_default(); end if;
  if not exists (select 1 from pg_trigger where tgrelid = 'public.event_tasks'::regclass and tgname = 'zz_r438_step_guard') then
    create trigger zz_r438_step_guard before update of step on public.event_tasks for each row when (old.step is distinct from new.step) execute function public._r438_tg_step_guard(); end if;
  if not exists (select 1 from pg_trigger where tgrelid = 'public.event_tasks'::regclass and tgname = 'zzz_r438_step_log') then
    create trigger zzz_r438_step_log after update of step on public.event_tasks for each row when (old.step is distinct from new.step) execute function public._r438_tg_step_log(); end if;
end $$;

-- ---- 5) give work with the picked step -------------------------------------------------------------------------------------------------------
create or replace function public._r438_check_step(p_step text)
returns void language plpgsql immutable security definer set search_path = '' as $$
-- r254-0438
begin
  if p_step is not null and p_step not in ('daybefore', 'pre', 'onday', 'wrapup') then raise exception 'invalid_step' using errcode = '22023', hint = 'r438_step'; end if;
end $$;
create or replace function public.assign_tasks_step(p_quote_id uuid, p_category text, p_titles text[], p_crew_id uuid, p_name text, p_phone text, p_step text)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
-- r254-0438: assign_tasks (every check there) with the picked step in the same transaction
declare v jsonb;
begin
  perform public._r438_check_step(p_step);
  perform set_config('helm.task_step', coalesce(p_step, ''), true);
  v := public.assign_tasks(p_quote_id, p_category, p_titles, p_crew_id, p_name, p_phone);
  perform set_config('helm.task_step', '', true);
  return v;
end $$;
create or replace function public.assign_tasks_vendor_step(p_quote_id uuid, p_category text, p_titles text[], p_vendor_id uuid, p_step text)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
-- r254-0438: assign_tasks_vendor (every check there) with the picked step in the same transaction
declare v jsonb;
begin
  perform public._r438_check_step(p_step);
  perform set_config('helm.task_step', coalesce(p_step, ''), true);
  v := public.assign_tasks_vendor(p_quote_id, p_category, p_titles, p_vendor_id);
  perform set_config('helm.task_step', '', true);
  return v;
end $$;
create or replace function public.assign_tasks_step_once(p_quote_id uuid, p_category text, p_titles text[], p_crew_id uuid, p_name text, p_phone text, p_step text, p_request_id uuid)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
-- r254-0438: the r235-0401 request key around assign_tasks_step
declare v_md5 text; v jsonb;
begin
  if p_request_id is null then return public.assign_tasks_step(p_quote_id, p_category, p_titles, p_crew_id, p_name, p_phone, p_step); end if;
  v_md5 := md5(jsonb_build_array(p_quote_id, p_category, p_titles, p_crew_id, p_name, p_phone, p_step)::text);
  v := public._r401_key_get('assign_tasks_step', p_request_id, v_md5);
  if v is not null then return v; end if;
  v := public.assign_tasks_step(p_quote_id, p_category, p_titles, p_crew_id, p_name, p_phone, p_step);
  perform public._r401_key_put('assign_tasks_step', p_request_id, v_md5, v);
  return v;
end $$;
create or replace function public.assign_tasks_vendor_step_once(p_quote_id uuid, p_category text, p_titles text[], p_vendor_id uuid, p_step text, p_request_id uuid)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
-- r254-0438: the r235-0401 request key around assign_tasks_vendor_step
declare v_md5 text; v jsonb;
begin
  if p_request_id is null then return public.assign_tasks_vendor_step(p_quote_id, p_category, p_titles, p_vendor_id, p_step); end if;
  v_md5 := md5(jsonb_build_array(p_quote_id, p_category, p_titles, p_vendor_id, p_step)::text);
  v := public._r401_key_get('assign_tasks_vendor_step', p_request_id, v_md5);
  if v is not null then return v; end if;
  v := public.assign_tasks_vendor_step(p_quote_id, p_category, p_titles, p_vendor_id, p_step);
  perform public._r401_key_put('assign_tasks_vendor_step', p_request_id, v_md5, v);
  return v;
end $$;

-- ---- 6) move tasks to another step ---------------------------------------------------------------------------------------------------------
create or replace function public.set_task_step(p_tasks uuid[], p_step text)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
-- r254-0438: rows locked in one order (two people at once wait for each other, the last one wins); a locked plan refuses the whole call
declare v_org uuid := public.current_org_id(); r record; v_n integer := 0; v_skip jsonb := '[]'::jsonb; v_ids uuid[];
begin
  if auth.uid() is null or v_org is null or not coalesce(public._r385_can_assign(), false) then raise exception 'not authorized' using errcode = '42501'; end if;
  if p_step is null then raise exception 'invalid_step' using errcode = '22023', hint = 'r438_step'; end if;
  perform public._r438_check_step(p_step);
  select coalesce(array_agg(distinct x), '{}') into v_ids from unnest(p_tasks) x where x is not null;
  if cardinality(v_ids) > 200 then raise exception 'too_many_tasks' using errcode = '22023', hint = 'r438_max'; end if;
  for r in
    select i.id as ask, t.id, t.status, t.step, t.quote_id,
           (q.id is null or q.deleted_at is not null or coalesce(q.status, '') in ('cancelled', 'lost') or coalesce(q.lifecycle_stage, '') in ('closed', 'cancelled', 'archived')) as shut
      from unnest(v_ids) i(id)
      left join public.event_tasks t on t.id = i.id and t.org_id = v_org
      left join public.quotes q on q.id = t.quote_id and q.org_id = v_org
     order by i.id
  loop
    if r.id is null then v_skip := v_skip || jsonb_build_object('id', r.ask, 'reason', 'not_found'); continue; end if;
    if r.shut then v_skip := v_skip || jsonb_build_object('id', r.id, 'reason', 'event_closed'); continue; end if;
    perform public._r397_guard(r.quote_id, 'task plan');
    perform 1 from public.event_tasks t where t.id = r.id for update;
    if (select t.status from public.event_tasks t where t.id = r.id) = 'cancelled' then v_skip := v_skip || jsonb_build_object('id', r.id, 'reason', 'cancelled'); continue; end if;
    update public.event_tasks t set step = p_step where t.id = r.id and t.org_id = v_org and t.step is distinct from p_step;
    if found then v_n := v_n + 1; else v_skip := v_skip || jsonb_build_object('id', r.id, 'reason', 'same'); end if;
  end loop;
  return jsonb_build_object('changed', v_n, 'skipped', v_skip);
end $$;

-- ---- 7) one person, two works at the same time (READ ONLY) -----------------------------------------------------------------------------------
-- the end of a task: its planned end, else its length, else about one hour
create or replace function public._r438_end(p_start timestamptz, p_end timestamptz, p_min integer)
returns timestamptz language sql immutable security definer set search_path = '' as $$
  -- r254-0438
  select case when p_end > p_start then p_end when p_min > 0 then p_start + make_interval(mins => p_min) else p_start + interval '60 minutes' end;
$$;
-- does p_from wait for p_to (itself, directly or through a chain)? a circle ends
create or replace function public._r438_waits_for(p_org uuid, p_from uuid, p_to uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  -- r254-0438
  with recursive up(id) as (
    select p_from union select t.depends_on from up join public.event_tasks t on t.id = up.id and t.org_id = p_org where t.depends_on is not null
  ) select p_from is not null and p_to is not null and exists (select 1 from up where up.id = p_to);
$$;
create or replace function public.crew_time_clashes(p_items jsonb, p_exclude uuid[] default null)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
-- r254-0438: tasks of the same person (crew_id, in house; assigned / accepted / in progress) of live events of this studio that overlap.
-- [start, end): an end that equals a start is no clash. No start = never. A task that waits for the other one is no clash with it.
declare v_org uuid := public.current_org_id(); v_out jsonb := '[]'::jsonb; e jsonb; i integer := 0; v_names boolean;
        v_crew uuid; v_s timestamptz; v_e timestamptz; v_dep uuid; v_id uuid; v_q uuid; v_rows jsonb; v_min integer;
begin
  if auth.uid() is null or v_org is null or not coalesce(public.has_area('staff', 'view'), false) then raise exception 'not authorized' using errcode = '42501'; end if;
  if p_items is null or jsonb_typeof(p_items) <> 'array' then raise exception 'invalid_items' using errcode = '22023', hint = 'r438_items'; end if;
  if jsonb_array_length(p_items) > 60 then raise exception 'too_many_items' using errcode = '22023', hint = 'r438_items'; end if;
  -- the code as crew_day_status shows it to Staff view; the event's name only for who may see events
  v_names := coalesce(public.has_area('quotes', 'view'), false) or coalesce(public.has_area('calendar', 'view'), false);
  for e in select x from jsonb_array_elements(p_items) with ordinality a(x, o) order by o loop
    v_rows := '[]'::jsonb;
    begin
      v_crew := nullif(e ->> 'crew_id', '')::uuid; v_s := nullif(e ->> 'start', '')::timestamptz; v_dep := nullif(e ->> 'depends_on', '')::uuid;
      v_id := nullif(e ->> 'id', '')::uuid; v_q := nullif(e ->> 'quote_id', '')::uuid; v_min := round(nullif(e ->> 'duration_min', '')::numeric)::integer;
      v_e := public._r438_end(v_s, nullif(e ->> 'end', '')::timestamptz, v_min);
      if v_crew is not null and v_s is not null and isfinite(v_s) and isfinite(v_e) then
        if v_dep is null and v_id is not null and not (e ? 'depends_on') then select t.depends_on into v_dep from public.event_tasks t where t.org_id = v_org and t.id = v_id; end if;
        if v_q is null then select t.quote_id into v_q from public.event_tasks t where t.org_id = v_org and t.id = coalesce(v_id, v_dep); end if;
        select coalesce(jsonb_agg(z.j order by z.s, z.id), '[]'::jsonb) into v_rows from (
          select t.id, t.planned_start as s, jsonb_build_object('task_id', t.id, 'quote_id', q.id, 'code', q.code, 'title', left(t.title, 160),
                   'event_title', case when v_names then left(q.title, 160) end, 'start', t.planned_start, 'end', public._r438_end(t.planned_start, t.planned_end, t.duration_min),
                   'about', not (coalesce(t.planned_end > t.planned_start, false) or coalesce(t.duration_min > 0, false)), 'same_event', q.id is not distinct from v_q) as j
            from public.event_tasks t join public.quotes q on q.id = t.quote_id and q.org_id = v_org and q.deleted_at is null
           where t.org_id = v_org and t.crew_id = v_crew and coalesce(t.assignee_kind, 'in_house') = 'in_house'
             and t.status in ('assigned', 'accepted', 'in_progress') and t.planned_start is not null
             and coalesce(q.status, '') not in ('cancelled', 'lost') and coalesce(q.lifecycle_stage, '') not in ('closed', 'cancelled', 'archived')
             and t.planned_start < v_e and public._r438_end(t.planned_start, t.planned_end, t.duration_min) > v_s
             and t.id is distinct from v_id and not (t.id = any (coalesce(p_exclude, '{}')))
             and not public._r438_waits_for(v_org, v_dep, t.id) and not public._r438_waits_for(v_org, t.id, v_id)
           order by t.planned_start, t.id limit 5) z;
      end if;
    exception when data_exception then v_rows := '[]'::jsonb;   -- one bad item never spoils the others
    end;
    v_out := v_out || jsonb_build_array(jsonb_build_object('i', i, 'clashes', v_rows));
    i := i + 1;
  end loop;
  return v_out;
end $$;

-- ---- 8) grants -----------------------------------------------------------------------------------------------------------------------------
do $$ declare f text; r text; begin
  foreach f in array array['public._r438_keep(text)', 'public._r438_auto(uuid)', 'public._r438_tg_step_default()', 'public._r438_tg_step_guard()', 'public._r438_tg_step_log()',
      'public._r438_check_step(text)', 'public._r438_end(timestamptz,timestamptz,integer)', 'public._r438_waits_for(uuid,uuid,uuid)'] loop
    execute format('revoke all on function %s from public', f);
    foreach r in array array['anon', 'authenticated', 'service_role'] loop
      if exists (select 1 from pg_roles where rolname = r) then execute format('revoke all on function %s from %I', f, r); end if;
    end loop;
  end loop;
  foreach f in array array['public.assign_tasks_step(uuid,text,text[],uuid,text,text,text)', 'public.assign_tasks_step_once(uuid,text,text[],uuid,text,text,text,uuid)',
      'public.assign_tasks_vendor_step(uuid,text,text[],uuid,text)', 'public.assign_tasks_vendor_step_once(uuid,text,text[],uuid,text,uuid)', 'public.set_task_step(uuid[],text)',
      'public.crew_time_clashes(jsonb,uuid[])', 'public.task_reminder_settings_get()', 'public.task_reminder_settings_set(jsonb)'] loop
    execute format('revoke all on function %s from public', f);
    if exists (select 1 from pg_roles where rolname = 'anon') then execute format('revoke all on function %s from anon', f); end if;
    foreach r in array array['authenticated', 'service_role'] loop
      if exists (select 1 from pg_roles where rolname = r) then execute format('grant execute on function %s to %I', f, r); end if;
    end loop;
  end loop;
end $$;

do $$ begin
  if to_regclass('public.helm_schema_markers') is not null then
    insert into public.helm_schema_markers(num, name) values (438, '0438_r254_task_steps') on conflict (num) do nothing;
  end if;
end $$;

notify pgrst, 'reload schema';
