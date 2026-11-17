-- 0369_r186_special_escalation.sql - R186 (owner, 17 Nov 2026). Forward-only, additive, safe to run twice. ASCII only.
-- REQUIRES 0367 (special-task reminders: task_reminder_tick wrapped, _r338_queue), 0368 (event_task_log), 0361 + 0363
-- (staff_email_outbox, staff_email_claim chain, _r361_on / _r361_live / _r361_email), 0283 (_r283_is_off / _r283_owner /
-- _r283_off_email), 0266 + 0293 + 0357 (_r23_visible), 0299 (bell_feed).
--
-- In plain words (owner business partner: a special task must not slip more than about 10 minutes):
--   1  The escalation ladder for SPECIAL tasks that are NOT STARTED at their start time. Default steps (per studio):
--        step 1  at the start time      the person on the task + the event coordinator
--        step 2  5 minutes after        the person + the coordinator + the manager(s)
--        step 3  10 minutes after       the person + the coordinator + the manager(s) + the admin(s) / studio owner
--      It stops at once when the task is started (or done, cancelled, turned down or taken off the person). Each step is
--      recorded once per task and start time (task_escalation_steps, unique), so nobody gets the same step twice; a new
--      start time starts a fresh ladder. Steps missed while the timer was off are recorded as skipped, never sent late.
--      Who is who (studio roles, profiles.role):
--        coordinator = the person set as the event lead on the event (quotes.manager_id) when that person is an active team
--                      member; otherwise every active member with the coordinator or supervisor role
--        manager     = every active member with the manager role
--        admin       = every active member with the admin role, plus the studio owner
--      Deactivated members, clients and crew logins are never on the ladder. The person on the task gets their reminder
--      through the normal task reminder lane (e-mail, WhatsApp once connected); when a normal reminder already went in
--      the last 3 minutes (for example the 5 minute "not started yet"), that one counts and no second one is sent.
--   2  Delivery to the office: one bell notice per step, shown ONLY to the people of that step (detail.notify), plus an
--      e-mail to each of them through the staff e-mail queue (kind task_escalation; comms-dispatch sends it on the shared
--      Helm layout). Free-trial studios: bell only, nothing leaves Helm. The studio switch "E-mail staff their tasks"
--      off = no escalation e-mails either. Sample (demo) events never escalate.
--   3  Each sent step is written to the event activity log (event_task_log kind escalated), so the Event day monitor
--      shows it in the Activity timeline and as a badge on the Late panel ("Escalated to manager 3:10 PM").
--   4  The steps are a per-studio setting (task_escalation_settings, ladder not_started, default 0 / 5 / 10 minutes),
--      read and saved in Settings -> Notifications -> Task reminders. The table already has room for a second ladder
--      (not_completed) so a later "not done by the end time" ladder can reuse it; that ladder is NOT built here.
--   Wrapped once (old bodies kept as *__pre0369): task_reminder_tick (pg_cron every minute, unchanged), staff_email_claim,
--   _r23_visible and bell_feed. Two check rules are widened (never narrowed): staff_email_outbox.kind gets task_escalation
--   and event_task_log.kind gets escalated; every value allowed before stays allowed.
--   Nothing dropped, nothing deleted, no existing row changed. If it stops with a STOP message nothing was applied.

-- ---- 0) preflight -----------------------------------------------------------------------------------------------------
do $$ begin
  if to_regprocedure('public.task_reminder_tick(timestamptz)') is null
     or position('r179-0367' in coalesce((select p.prosrc from pg_proc p where p.oid = to_regprocedure('public.task_reminder_tick(timestamptz)')), '')
                               || coalesce((select p.prosrc from pg_proc p where p.oid = to_regprocedure('public.task_reminder_tick__pre0369(timestamptz)')), '')) = 0 then
    raise exception 'STOP 0369: run 0367 (special-task reminders) first'; end if;
  if to_regprocedure('public._r338_queue(public.event_tasks,uuid,text,text,text,text,text,text,jsonb,text,timestamptz,text,text)') is null then
    raise exception 'STOP 0369: _r338_queue missing - run 0338 first'; end if;
  if to_regclass('public.event_task_log') is null then raise exception 'STOP 0369: run 0368 (event activity log) first'; end if;
  if to_regclass('public.staff_email_outbox') is null or to_regprocedure('public.staff_email_claim(integer)') is null
     or to_regprocedure('public._r361_on(uuid)') is null or to_regprocedure('public._r361_live(uuid,uuid)') is null
     or to_regprocedure('public._r361_email(text)') is null then
    raise exception 'STOP 0369: run 0361 (staff e-mail) first'; end if;
  if to_regprocedure('public._r283_is_off(uuid,uuid)') is null or to_regprocedure('public._r283_owner(uuid)') is null
     or to_regprocedure('public._r283_off_email(uuid,text)') is null then
    raise exception 'STOP 0369: run 0283 (team safety) first'; end if;
  if to_regprocedure('public._r23_visible(uuid,uuid)') is null or to_regprocedure('public.bell_feed(integer)') is null then
    raise exception 'STOP 0369: run 0266 + 0299 (bell / inbox) first'; end if;
  if to_regprocedure('public.trial_send_blocked(uuid,uuid,uuid)') is null or to_regprocedure('public._sample_outbound_blocked(uuid,text)') is null then
    raise exception 'STOP 0369: trial gates (trial_send_blocked / _sample_outbound_blocked) missing'; end if;
  if to_regprocedure('public.has_area(text,text)') is null or to_regprocedure('public.current_org_id()') is null then
    raise exception 'STOP 0369: has_area / current_org_id missing'; end if;
end $$;

-- ---- 1) the per-studio setting (one row per studio and ladder; no row = the defaults) ------------------------------------
create table if not exists public.task_escalation_settings (
  org_id     uuid not null references public.organizations(id) on delete cascade,
  ladder     text not null default 'not_started' check (ladder in ('not_started', 'not_completed')),
  enabled    boolean not null default true,
  steps      integer[] not null default '{0,5,10}'
             check (array_length(steps, 1) = 3 and array_position(steps, null) is null
                    and steps[1] between 0 and 60 and steps[2] > steps[1] and steps[3] > steps[2] and steps[3] <= 120),
  updated_at timestamptz not null default now(),
  updated_by uuid,
  primary key (org_id, ladder)
);

-- ---- 2) the ladder record: one row per task, start time, ladder and step (the "never twice" guard) -----------------------
create table if not exists public.task_escalation_steps (
  id          uuid primary key default gen_random_uuid(),
  org_id      uuid not null references public.organizations(id) on delete cascade,
  quote_id    uuid not null references public.quotes(id) on delete cascade,
  task_id     uuid not null references public.event_tasks(id) on delete cascade,
  ladder      text not null default 'not_started' check (ladder in ('not_started', 'not_completed')),
  step        smallint not null check (step between 0 and 2),
  level       text not null check (level in ('coordinator', 'manager', 'admin')),
  ref_start   timestamptz not null,
  due_at      timestamptz not null,
  status      text not null default 'sent' check (status in ('sent', 'superseded', 'missed')),
  recipients  jsonb not null default '[]'::jsonb check (jsonb_typeof(recipients) = 'array'),
  worker      text check (worker is null or char_length(worker) <= 40),
  emails      integer not null default 0,
  created_at  timestamptz not null default now()
);
create unique index if not exists task_escalation_steps_once369 on public.task_escalation_steps (task_id, ref_start, ladder, step);
create index if not exists task_escalation_steps_org369 on public.task_escalation_steps (org_id);
create index if not exists task_escalation_steps_quote369 on public.task_escalation_steps (quote_id);

-- both tables: RLS on, no grants (only the functions below read or write them), studio guards like every studio table
do $$
declare t text;
begin
  foreach t in array array['task_escalation_settings', 'task_escalation_steps'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on table public.%I from public', t);
    if exists (select 1 from pg_roles where rolname = 'anon') then execute format('revoke all on table public.%I from anon', t); end if;
    if exists (select 1 from pg_roles where rolname = 'authenticated') then execute format('revoke all on table public.%I from authenticated', t); end if;
    if to_regprocedure('public.tg_studio_read_only()') is not null
       and not exists (select 1 from pg_trigger where tgrelid = format('public.%I', t)::regclass and tgname = 'zzz_studio_read_only') then
      execute format('create trigger zzz_studio_read_only before insert or update or delete on public.%I for each row execute function public.tg_studio_read_only(%L)', t, 'org_id');
    end if;
  end loop;
  if to_regprocedure('public.tg_quote_org_match()') is not null
     and not exists (select 1 from pg_trigger where tgrelid = 'public.task_escalation_steps'::regclass and tgname = 'zz_quote_org_match') then
    create trigger zz_quote_org_match before insert or update on public.task_escalation_steps for each row execute function public.tg_quote_org_match();
  end if;
end $$;

-- ---- 3) widen two kind rules (every value allowed before stays allowed; only a value is added) ---------------------------
-- staff_email_outbox.kind + task_escalation
do $$
declare c record; m text[]; v_vals text[] := array['task_assigned', 'task_list', 'task_one', 'task_reminder', 'task_late', 'office_alert', 'task_escalation'];
        n integer; v_ok boolean;
begin
  for c in select x.oid, x.conname from pg_constraint x
            where x.conrelid = 'public.staff_email_outbox'::regclass and x.contype = 'c' and pg_get_constraintdef(x.oid) ~ '[(]kind = ANY' loop
    for m in select regexp_matches(pg_get_constraintdef(c.oid), '''([a-z0-9_]+)''::text', 'g') loop
      if not (m[1] = any (v_vals)) then v_vals := v_vals || m[1]; end if;
    end loop;
  end loop;
  select count(*), coalesce(bool_and((select bool_and(position(quote_literal(v) in pg_get_constraintdef(x.oid)) > 0) from unnest(v_vals) v)), false)
    into n, v_ok
    from pg_constraint x where x.conrelid = 'public.staff_email_outbox'::regclass and x.contype = 'c' and pg_get_constraintdef(x.oid) ~ '[(]kind = ANY';
  if n = 1 and v_ok then return; end if;
  for c in select x.conname from pg_constraint x
            where x.conrelid = 'public.staff_email_outbox'::regclass and x.contype = 'c' and pg_get_constraintdef(x.oid) ~ '[(]kind = ANY' loop
    execute format('alter table public.staff_email_outbox drop constraint %I', c.conname);
  end loop;
  execute format('alter table public.staff_email_outbox add constraint staff_email_outbox_kind_chk369 check (kind in (%s))',
                 (select string_agg(quote_literal(v), ', ') from unnest(v_vals) v));
end $$;

-- event_task_log.kind + escalated
do $$
declare c record; m text[]; n integer; v_ok boolean;
        v_vals text[] := array['assigned', 'reassigned', 'unassigned', 'time_changed', 'special_on', 'special_off', 'accepted', 'rejected',
                               'started', 'completed', 'cancelled', 'reopened', 'check_in', 'check_out', 'check_edit', 'escalated'];
begin
  for c in select x.oid, x.conname from pg_constraint x
            where x.conrelid = 'public.event_task_log'::regclass and x.contype = 'c' and pg_get_constraintdef(x.oid) ~ '[(]kind = ANY' loop
    for m in select regexp_matches(pg_get_constraintdef(c.oid), '''([a-z0-9_]+)''::text', 'g') loop
      if not (m[1] = any (v_vals)) then v_vals := v_vals || m[1]; end if;
    end loop;
  end loop;
  select count(*), coalesce(bool_and((select bool_and(position(quote_literal(v) in pg_get_constraintdef(x.oid)) > 0) from unnest(v_vals) v)), false)
    into n, v_ok
    from pg_constraint x where x.conrelid = 'public.event_task_log'::regclass and x.contype = 'c' and pg_get_constraintdef(x.oid) ~ '[(]kind = ANY';
  if n = 1 and v_ok then return; end if;
  for c in select x.conname from pg_constraint x
            where x.conrelid = 'public.event_task_log'::regclass and x.contype = 'c' and pg_get_constraintdef(x.oid) ~ '[(]kind = ANY' loop
    execute format('alter table public.event_task_log drop constraint %I', c.conname);
  end loop;
  execute format('alter table public.event_task_log add constraint event_task_log_kind_chk369 check (kind in (%s))',
                 (select string_agg(quote_literal(v), ', ') from unnest(v_vals) v));
end $$;

-- ---- 4) helpers (server only) -----------------------------------------------------------------------------------------
-- the studio setting for one ladder: { enabled, steps: [a, b, c], saved }
create or replace function public._r369_cfg(p_org uuid, p_ladder text default 'not_started')
returns jsonb language sql stable security definer set search_path = '' as $fn$
  -- r186-0369
  select coalesce((select jsonb_build_object('enabled', s.enabled, 'steps', to_jsonb(s.steps), 'saved', true)
                     from public.task_escalation_settings s where s.org_id = p_org and s.ladder = coalesce(p_ladder, 'not_started')),
                  jsonb_build_object('enabled', true, 'steps', '[0,5,10]'::jsonb, 'saved', false));
$fn$;

-- the office people of one step (cumulative: step 0 coordinator, step 1 + manager, step 2 + admin / owner), each person
-- once with their highest level: [{ profile_id, name, level, email }] (email null when there is no usable address)
create or replace function public._r369_people(p_org uuid, p_quote uuid, p_crew uuid, p_step integer)
returns jsonb language plpgsql stable security definer set search_path = '' as $fn$
-- r186-0369
declare v_lead uuid; v_self uuid; v_owner uuid := public._r283_owner(p_org); v jsonb;
begin
  if p_org is null or p_quote is null then return '[]'::jsonb; end if;
  select q.manager_id into v_lead from public.quotes q where q.id = p_quote and q.org_id = p_org;
  if p_crew is not null then select cm.profile_id into v_self from public.crew_members cm where cm.id = p_crew and cm.org_id = p_org; end if;
  with office as (
    select p.id, lower(coalesce(p.role, '')) as role,
           coalesce(nullif(btrim(p.full_name), ''), nullif(split_part(coalesce(p.email, ''), '@', 1), ''), 'Team member') as name, p.email
      from public.profiles p
     where p.org_id = p_org and lower(coalesce(p.role, '')) not in ('', 'client', 'crew', 'worker')
       and not public._r283_is_off(p.id, p_org)
  ), lead_ok as (
    select exists (select 1 from office o where o.id = v_lead) as ok
  ), picked as (
    select o.id, o.name, o.email, 0 as lvl from office o, lead_ok l
     where (l.ok and o.id = v_lead) or (not l.ok and o.role in ('coordinator', 'supervisor'))
    union all
    select o.id, o.name, o.email, 1 from office o where p_step >= 1 and o.role = 'manager'
    union all
    select o.id, o.name, o.email, 2 from office o where p_step >= 2 and (o.role = 'admin' or o.id = v_owner)
  ), one as (
    select distinct on (x.id) x.id, x.name, x.email, x.lvl from picked x where x.id is distinct from v_self order by x.id, x.lvl desc
  )
  select coalesce(jsonb_agg(jsonb_build_object(
           'profile_id', one.id, 'name', left(one.name, 120),
           'level', case one.lvl when 0 then 'coordinator' when 1 then 'manager' else 'admin' end,
           'email', (select e.v from (select coalesce(
               public._r361_email((select cm.email from public.crew_members cm where cm.org_id = p_org and cm.profile_id = one.id and cm.active
                                    order by cm.created_at limit 1)),
               public._r361_email(one.email)) as v) e
              where e.v is not null and not coalesce(public._r283_off_email(p_org, e.v), false)))
           order by one.lvl, one.name), '[]'::jsonb)
    into v from one;
  return v;
end $fn$;

-- ---- 5) the ladder itself (called every minute by task_reminder_tick, after the reminders) -------------------------------
create or replace function public._r369_escalation_tick(p_now timestamptz default null)
returns jsonb language plpgsql volatile security definer set search_path = '' as $fn$
-- r186-0369: special tasks not started at their start time -> worker + coordinator, then + manager, then + admin / owner.
-- One task_escalation_steps row per (task, start time, ladder, step) = every person gets every step at most once.
-- Only the latest due step is sent; earlier due ones are recorded superseded; a step more than 10 minutes late is missed.
declare r record; c jsonb; v_now timestamptz := coalesce(p_now, now()); v_steps integer[]; k integer; v_at timestamptz;
        v_best integer; v_best_at timestamptz; v_id uuid; v_people jsonb; p jsonb; v_trial boolean; v_mail boolean;
        v_phone text; v_who text; v_st text; v_rs text; v_base text; v_ev jsonb; v_link text; v_task text; v_when text;
        v_level text; v_names jsonb; v_notify jsonb; v_worker text; v_mails integer; v_sent integer := 0; v_skip integer := 0;
        v_mins integer; v_label text;
begin
  for r in
    select t as t, q.org_id as org_id
      from public.event_tasks t join public.quotes q on q.id = t.quote_id and q.org_id = t.org_id
     where t.is_special
       and t.planned_start is not null
       and t.planned_start between v_now - interval '3 hours' and v_now
       and t.status in ('assigned', 'accepted')
       and coalesce(t.assignee_kind, 'in_house') = 'in_house'
       and (t.crew_id is not null or nullif(btrim(coalesce(t.assignee_name, '')), '') is not null or t.assignee_phone is not null)
       and q.deleted_at is null and coalesce(q.status, '') <> 'cancelled' and not coalesce(q.is_demo, false)
  loop
    begin
      if coalesce(public._trial_locked(r.org_id), false) then continue; end if;   -- read-only studio: nothing
      c := public._r369_cfg(r.org_id, 'not_started');
      if not coalesce((c ->> 'enabled')::boolean, true) then continue; end if;
      select coalesce(array_agg(x::integer order by o), '{0,5,10}') into v_steps
        from jsonb_array_elements_text(c -> 'steps') with ordinality e(x, o);
      if coalesce(array_length(v_steps, 1), 0) <> 3 then v_steps := '{0,5,10}'; end if;
      -- the latest due step not recorded yet; earlier due ones are recorded as superseded (never sent late)
      v_best := null; v_best_at := null;
      for k in 0 .. 2 loop
        v_at := (r.t).planned_start + make_interval(mins => v_steps[k + 1]);
        continue when v_at > v_now;
        continue when exists (select 1 from public.task_escalation_steps s where s.task_id = (r.t).id and s.ref_start = (r.t).planned_start
                                and s.ladder = 'not_started' and s.step = k);
        if v_best is not null then
          insert into public.task_escalation_steps (org_id, quote_id, task_id, ladder, step, level, ref_start, due_at, status)
          values (r.org_id, (r.t).quote_id, (r.t).id, 'not_started', v_best, case v_best when 0 then 'coordinator' when 1 then 'manager' else 'admin' end,
                  (r.t).planned_start, v_best_at, 'superseded')
          on conflict (task_id, ref_start, ladder, step) do nothing;
          v_skip := v_skip + 1;
        end if;
        v_best := k; v_best_at := v_at;
      end loop;
      continue when v_best is null;
      v_level := case v_best when 0 then 'coordinator' when 1 then 'manager' else 'admin' end;
      if v_best_at < v_now - interval '10 minutes' then
        insert into public.task_escalation_steps (org_id, quote_id, task_id, ladder, step, level, ref_start, due_at, status)
        values (r.org_id, (r.t).quote_id, (r.t).id, 'not_started', v_best, v_level, (r.t).planned_start, v_best_at, 'missed')
        on conflict (task_id, ref_start, ladder, step) do nothing;
        v_skip := v_skip + 1;
        continue;
      end if;
      v_worker := 'none';
      v_id := null;
      insert into public.task_escalation_steps (org_id, quote_id, task_id, ladder, step, level, ref_start, due_at, status)
      values (r.org_id, (r.t).quote_id, (r.t).id, 'not_started', v_best, v_level, (r.t).planned_start, v_best_at, 'sent')
      on conflict (task_id, ref_start, ladder, step) do nothing
      returning id into v_id;
      continue when v_id is null;

      v_trial := coalesce(public.trial_send_blocked(r.org_id, (r.t).quote_id, null), false);
      v_mail := not v_trial and public._r361_on(r.org_id) and public._r361_live(r.org_id, (r.t).quote_id)
                and not coalesce(public._sample_outbound_blocked(r.org_id, null::text), false);
      v_task := public._r338_f((r.t).title, 100);
      v_when := public._r338_time((r.t).planned_start, r.org_id);
      v_mins := greatest(0, floor(extract(epoch from (v_now - (r.t).planned_start)) / 60))::integer;

      -- (a) the person on the task: the normal reminder lane (e-mail; WhatsApp once connected). Free trial: nothing.
      if not v_trial then
        v_phone := public._assign132_phone((r.t).assignee_phone);
        v_who := null;
        if v_phone is not null then v_who := v_phone; v_st := 'queued'; v_rs := null;
        elsif (r.t).crew_id is not null then v_who := 'c' || (r.t).crew_id::text; v_st := 'skipped'; v_rs := 'email_only'; end if;
        if v_who is not null then
          v_base := (r.t).id::text || '|' || extract(epoch from (r.t).planned_start)::bigint::text || '|' || v_who || '|';
          v_ev := public._r338_event((r.t).quote_id);
          v_link := public._r338_link((r.t).quote_id, r.org_id, v_phone);
          if exists (select 1 from public.task_wa_outbox o
                      where o.task_id = (r.t).id and left(o.slot_key, length(v_base)) = v_base and o.kind in ('reminder', 'late')
                        and (o.status <> 'skipped' or coalesce(o.reason, '') = 'email_only')
                        and o.due_at > v_best_at - interval '3 minutes' and o.due_at <= v_now) then
            -- a normal reminder just went to this person (for example the 5 minute "not started yet"): that one counts
            perform public._r338_queue(r.t, r.org_id, 'late', 'esc' || v_best, v_base || 'esc' || v_best, v_phone, (r.t).assignee_name,
              'staff_task_overdue', '[]'::jsonb, v_link, v_best_at, 'skipped', 'covered');
            v_worker := 'covered';
          elsif public._r338_queue(r.t, r.org_id, 'late', 'esc' || v_best, v_base || 'esc' || v_best, v_phone, (r.t).assignee_name,
                  'staff_task_overdue',
                  jsonb_build_array(public._r338_f(split_part(btrim(coalesce((r.t).assignee_name, '')), ' ', 1), 60), v_task,
                    public._r338_f(v_ev ->> 'event', 100), public._r338_f(v_when, 20), '@link'),
                  v_link, v_best_at, v_st, v_rs) then
            v_worker := 'reminded';
          end if;
        end if;
      else
        v_worker := 'trial';
      end if;

      -- (b) the office people of this step: an e-mail each (not on a free trial / switch off), one bell notice for them all
      v_people := public._r369_people(r.org_id, (r.t).quote_id, (r.t).crew_id, v_best);
      v_mails := 0;
      if v_mail then
        for p in select x from jsonb_array_elements(v_people) x loop
          continue when (p ->> 'email') is null;
          insert into public.staff_email_outbox (org_id, quote_id, task_id, crew_id, phone, kind, recipient, name, dedupe_key, ref_start, not_before)
          values (r.org_id, (r.t).quote_id, (r.t).id, null, null, 'task_escalation', p ->> 'email', left(p ->> 'name', 120),
                  'esc|' || v_id::text || '|' || (p ->> 'profile_id'), (r.t).planned_start, now())
          on conflict (dedupe_key) do nothing;
          if found then v_mails := v_mails + 1; end if;
        end loop;
      end if;
      select coalesce(jsonb_agg(x -> 'profile_id'), '[]'::jsonb), coalesce(jsonb_agg(x ->> 'name'), '[]'::jsonb)
        into v_notify, v_names from jsonb_array_elements(v_people) x;
      update public.task_escalation_steps
         set recipients = (select coalesce(jsonb_agg(x - 'email' || jsonb_build_object('emailed', v_mail and (x ->> 'email') is not null)), '[]'::jsonb)
                             from jsonb_array_elements(v_people) x),
             worker = v_worker, emails = v_mails
       where id = v_id;
      v_label := left('Special task not started: ' || coalesce(v_task, 'a task')
                 || case when nullif(btrim(coalesce((r.t).assignee_name, '')), '') is not null then ' (' || public._r338_f((r.t).assignee_name, 60) || ')' else '' end
                 || ' - was due ' || coalesce(v_when, '') || '. Escalated to ' || case v_level when 'admin' then 'admin / owner' else v_level end, 300);
      if jsonb_array_length(v_notify) > 0 then
        begin
          insert into public.notifications (quote_id, channel, kind, status, detail, org_id)
          values ((r.t).quote_id, 'in_app', 'task_escalated', 'simulated',
                  jsonb_build_object('label', v_label, 'task', v_task, 'task_id', (r.t).id, 'worker', public._r338_f((r.t).assignee_name, 80),
                                     'start', v_when, 'step', v_best + 1, 'level', v_level, 'minutes', v_mins,
                                     'notify', v_notify, 'source', '0369', 'via', 'escalation'),
                  r.org_id);
        exception when others then raise warning 'r186-0369: bell notice skipped (%)', sqlstate;
        end;
      end if;

      -- (c) the event activity timeline (never blocks the ladder)
      begin
        insert into public.event_task_log (org_id, quote_id, task_id, crew_id, kind, title, detail, actor, actor_kind, at)
        values (r.org_id, (r.t).quote_id, (r.t).id, (r.t).crew_id, 'escalated', left((r.t).title, 300),
                jsonb_build_object('step', v_best + 1, 'level', v_level, 'ladder', 'not_started', 'minutes', v_mins,
                                   'ref_start', (r.t).planned_start, 'to', v_names, 'worker', v_worker, 'emails', v_mails),
                null, 'system', v_now);
      exception when others then null;
      end;
      v_sent := v_sent + 1;
    exception when others then
      raise warning 'r186-0369: special task % escalation skipped (%)', (r.t).id, sqlstate;
    end;
  end loop;
  return jsonb_build_object('sent', v_sent, 'skipped', v_skip);
end $fn$;

-- ---- 6) the every-minute timer: the 0367 body, then the ladder (wrapped once, old body kept) --------------------------------
do $$
declare v_src text;
begin
  select p.prosrc into v_src from pg_proc p where p.oid = to_regprocedure('public.task_reminder_tick(timestamptz)');
  if position('r186-0369' in coalesce(v_src, '')) = 0 and to_regprocedure('public.task_reminder_tick__pre0369(timestamptz)') is null then
    alter function public.task_reminder_tick(timestamptz) rename to task_reminder_tick__pre0369;
  end if;
  if to_regprocedure('public.task_reminder_tick__pre0369(timestamptz)') is null then
    raise exception 'STOP 0369: task_reminder_tick could not be kept as task_reminder_tick__pre0369'; end if;
end $$;

create or replace function public.task_reminder_tick(p_now timestamptz default null)
returns jsonb language plpgsql volatile security definer set search_path = '' as $fn$
-- r186-0369: the r179-0367 timer (kept as task_reminder_tick__pre0369), then the special-task escalation ladder
-- (_r369_escalation_tick).
-- pg_cron every minute, unchanged. A failure in the ladder never stops the reminders.
declare v jsonb := public.task_reminder_tick__pre0369(p_now); s jsonb;
begin
  begin s := public._r369_escalation_tick(p_now);
  exception when others then raise warning 'r186-0369: escalation skipped (%)', sqlstate; s := null;
  end;
  return coalesce(v, '{}'::jsonb) || jsonb_build_object('escalated', coalesce(s -> 'sent', '0'::jsonb));
end $fn$;

-- ---- 7) the staff e-mail claim: escalation e-mails re-checked first, then the 0363 claim, then their facts + link ----------
do $$
declare v_src text;
begin
  select p.prosrc into v_src from pg_proc p where p.oid = to_regprocedure('public.staff_email_claim(integer)');
  if position('r186-0369' in coalesce(v_src, '')) = 0 and to_regprocedure('public.staff_email_claim__pre0369(integer)') is null then
    alter function public.staff_email_claim(integer) rename to staff_email_claim__pre0369;
  end if;
  if to_regprocedure('public.staff_email_claim__pre0369(integer)') is null then
    raise exception 'STOP 0369: staff_email_claim could not be kept as staff_email_claim__pre0369'; end if;
end $$;

create or replace function public.staff_email_claim(p_limit integer default 25)
returns jsonb language plpgsql volatile security definer set search_path = '' as $fn$
-- r186-0369: an escalation e-mail (task_escalation) goes only while the task is still not started with the same start time,
-- the studio switch is on and it is at most 30 minutes old (else skipped task_changed / switched_off / too_old). Then the
-- 0363 claim (all its checks). Escalation rows then get the Event day monitor link and the step facts. Other rows unchanged.
declare v jsonb; x jsonb; v_out jsonb := '[]'::jsonb; s record; v_pid text;
begin
  update public.staff_email_outbox o
     set status = 'skipped', sent_at = now(), updated_at = now(),
         reason = case when not public._r361_on(o.org_id) then 'switched_off' when o.created_at < now() - interval '30 minutes' then 'too_old' else 'task_changed' end
   where o.kind = 'task_escalation' and o.status = 'pending' and o.sent_at is null
     and (o.claimed_at is null or o.claimed_at < now() - interval '10 minutes')
     and (not public._r361_on(o.org_id) or o.created_at < now() - interval '30 minutes'
          or not exists (select 1 from public.event_tasks t where t.id = o.task_id and t.org_id = o.org_id
                           and t.status in ('assigned', 'accepted') and t.planned_start is not distinct from o.ref_start));
  v := public.staff_email_claim__pre0369(p_limit);
  if v is null or jsonb_typeof(v) <> 'array' then return v; end if;
  if not exists (select 1 from jsonb_array_elements(v) e where e ->> 'kind' = 'task_escalation') then return v; end if;
  for x in select e from jsonb_array_elements(v) e loop
    if jsonb_typeof(x) = 'object' and x ->> 'kind' = 'task_escalation' then
      s := null; v_pid := null;
      select st.step, st.level, st.ref_start, st.recipients, split_part(o.dedupe_key, '|', 3) as pid into s
        from public.staff_email_outbox o
        join public.task_escalation_steps st on st.id::text = split_part(o.dedupe_key, '|', 2) and st.org_id = o.org_id
       where o.id::text = x ->> 'id';
      x := x || jsonb_build_object(
        'link_path', case when coalesce(x ->> 'quote_id', '') ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
                          then 'monitor.html?quote=' || (x ->> 'quote_id') end,
        'step', case when s.step is not null then s.step + 1 end,
        'level', s.level,
        'my_level', (select r ->> 'level' from jsonb_array_elements(coalesce(s.recipients, '[]'::jsonb)) r where r ->> 'profile_id' = s.pid limit 1),
        'late_min', case when s.ref_start is not null then greatest(0, floor(extract(epoch from (now() - s.ref_start)) / 60))::integer end);
    end if;
    v_out := v_out || jsonb_build_array(x);
  end loop;
  return v_out;
end $fn$;

-- ---- 8) the bell: an escalation notice is shown only to the people of its step -------------------------------------------
-- (a) the inbox rule (_r23_visible: bell badge, inbox, mark all read, digests)
do $$
declare v_src text;
begin
  select p.prosrc into v_src from pg_proc p where p.oid = to_regprocedure('public._r23_visible(uuid,uuid)');
  if position('r186-0369' in coalesce(v_src, '')) = 0 and to_regprocedure('public._r23_visible__pre0369(uuid,uuid)') is null then
    alter function public._r23_visible(uuid, uuid) rename to _r23_visible__pre0369;
  end if;
  if to_regprocedure('public._r23_visible__pre0369(uuid,uuid)') is null then
    raise exception 'STOP 0369: _r23_visible could not be kept as _r23_visible__pre0369'; end if;
end $$;

create or replace function public._r23_visible(p_org uuid, p_uid uuid)
returns table(id uuid, kind text, channel text, status text, detail jsonb, created_at timestamptz, quote_id uuid, ntype text)
language sql stable security definer set search_path = '' as $fn$
  -- r186-0369: the kept rule (_r23_visible__pre0369: the r24-ci-0270 + r163-0357 body) unchanged; a task_escalated row
  -- only for the people in its notify list
  select v.id, v.kind, v.channel, v.status, v.detail, v.created_at, v.quote_id, v.ntype
    from public._r23_visible__pre0369(p_org, p_uid) v
   where coalesce(v.kind, '') <> 'task_escalated'
      or exists (select 1 from public.notifications n
                  where n.id = v.id and n.org_id = p_org and jsonb_typeof(n.detail -> 'notify') = 'array'
                    and (n.detail -> 'notify') ? p_uid::text);
$fn$;

-- (b) the bell list itself (bell_feed: the older list is studio-wide; escalation rows for other people are taken out)
do $$
declare v_src text;
begin
  select p.prosrc into v_src from pg_proc p where p.oid = to_regprocedure('public.bell_feed(integer)');
  if position('r186-0369' in coalesce(v_src, '')) = 0 and to_regprocedure('public.bell_feed__pre0369(integer)') is null then
    alter function public.bell_feed(integer) rename to bell_feed__pre0369;
  end if;
  if to_regprocedure('public.bell_feed__pre0369(integer)') is null then
    raise exception 'STOP 0369: bell_feed could not be kept as bell_feed__pre0369'; end if;
end $$;

create or replace function public.bell_feed(p_limit integer default 20)
returns jsonb language plpgsql stable security definer set search_path = '' as $fn$
-- r186-0369: the kept bell (bell_feed__pre0369) unchanged, minus task_escalated rows the caller is not named on
declare v jsonb := public.bell_feed__pre0369(p_limit); v_uid text := auth.uid()::text; v_org uuid := public.current_org_id();
begin
  if v is null or jsonb_typeof(v -> 'items') <> 'array' then return v; end if;
  if not exists (select 1 from jsonb_array_elements(v -> 'items') e where e ->> 'kind' = 'task_escalated') then return v; end if;
  return jsonb_set(v, '{items}', coalesce((
    select jsonb_agg(e.i order by e.o)
      from jsonb_array_elements(v -> 'items') with ordinality e(i, o)
     where coalesce(e.i ->> 'kind', '') <> 'task_escalated'
        or (v_uid is not null and exists (select 1 from public.notifications n
                                           where n.id::text = e.i ->> 'id' and n.org_id = v_org and jsonb_typeof(n.detail -> 'notify') = 'array'
                                             and (n.detail -> 'notify') ? v_uid))), '[]'::jsonb));
end $fn$;

-- ---- 9) Settings: read and save the ladder steps --------------------------------------------------------------------------
-- { ladder, enabled, steps: [a, b, c], saved, can_edit }
create or replace function public.task_escalation_settings_get(p_ladder text default 'not_started')
returns jsonb language plpgsql stable security definer set search_path = '' as $fn$
-- r186-0369
declare v_org uuid := public.current_org_id(); v_l text := coalesce(p_ladder, 'not_started');
begin
  if auth.uid() is null or v_org is null or coalesce(public.user_role(), '') = 'client'
     or not (public.has_area('controls', 'view') or public.has_area('staff', 'view')) then
    raise exception 'not authorized' using errcode = '42501'; end if;
  if v_l not in ('not_started') then raise exception 'unknown ladder' using errcode = '22023'; end if;
  return public._r369_cfg(v_org, v_l) || jsonb_build_object('ladder', v_l, 'can_edit', coalesce(public.has_area('controls', 'edit'), false));
end $fn$;

create or replace function public.task_escalation_settings_set(p_ladder text, p_enabled boolean, p_steps integer[])
returns jsonb language plpgsql volatile security definer set search_path = '' as $fn$
-- r186-0369: Settings edit only, own studio only; steps = three whole minutes after the start, rising, first 0..60, last at most 120
declare v_org uuid := public.current_org_id(); v_me uuid := auth.uid(); v_l text := coalesce(p_ladder, 'not_started'); v_old jsonb;
begin
  if v_me is null or v_org is null or coalesce(public.user_role(), '') = 'client' or not public.has_area('controls', 'edit') then
    raise exception 'Only a studio admin (or someone allowed to edit Settings) can change the escalation steps.' using errcode = '42501'; end if;
  if coalesce(public._trial_locked(v_org), false) then raise exception 'This studio is read-only' using errcode = '25006'; end if;
  if v_l not in ('not_started') then raise exception 'unknown ladder' using errcode = '22023'; end if;
  if p_enabled is null then raise exception 'Choose on or off.' using errcode = '22023'; end if;
  if p_steps is null or coalesce(array_length(p_steps, 1), 0) <> 3 or array_position(p_steps, null) is not null
     or p_steps[1] < 0 or p_steps[1] > 60 or p_steps[2] <= p_steps[1] or p_steps[3] <= p_steps[2] or p_steps[3] > 120 then
    raise exception 'Give three times in minutes after the start, each later than the one before (first 0 to 60, last at most 120).' using errcode = '22023'; end if;
  v_old := public._r369_cfg(v_org, v_l);
  insert into public.task_escalation_settings (org_id, ladder, enabled, steps, updated_at, updated_by)
  values (v_org, v_l, p_enabled, p_steps, now(), v_me)
  on conflict (org_id, ladder) do update set enabled = excluded.enabled, steps = excluded.steps, updated_at = now(), updated_by = v_me;
  begin
    insert into public.audit_log(actor, action, entity, entity_id, changed, org_id)
      values (v_me, 'escalation.settings', 'task_escalation_settings', v_l,
              jsonb_build_object('from', v_old, 'to', jsonb_build_object('enabled', p_enabled, 'steps', to_jsonb(p_steps))), v_org);
  exception when others then raise warning 'r186-0369: audit skipped (%)', sqlstate;
  end;
  return public.task_escalation_settings_get(v_l);
end $fn$;

-- ---- 10) free-trial retention (0184): the ladder record goes with the studio events (like event_task_log 0368); the
--      setting is kept with the studio settings (like task_reminder_settings 0338) -------------------------------------------
do $$ declare v_def text; begin
  if to_regprocedure('public._tr184_purge_tables()') is not null then
    v_def := pg_get_functiondef('public._tr184_purge_tables()'::regprocedure);
    if position('''task_escalation_steps''' in v_def) = 0 then
      if (length(v_def) - length(replace(v_def, '''event_task_log''', ''))) / length('''event_task_log''') <> 1 then
        raise notice '0369: _tr184_purge_tables has an unexpected body - left unchanged';
      else execute replace(v_def, '''event_task_log''', '''event_task_log'', ''task_escalation_steps'''); end if;
    end if;
  end if;
  if to_regprocedure('public._tr184_keep_tables()') is not null then
    v_def := pg_get_functiondef('public._tr184_keep_tables()'::regprocedure);
    if position('''task_escalation_settings''' in v_def) = 0 then
      if (length(v_def) - length(replace(v_def, '''task_reminder_settings''', ''))) / length('''task_reminder_settings''') <> 1 then
        raise notice '0369: _tr184_keep_tables has an unexpected body - left unchanged';
      else execute replace(v_def, '''task_reminder_settings''', '''task_reminder_settings'', ''task_escalation_settings'''); end if;
    end if;
  end if;
end $$;

-- ---- 11) grants: the two Settings functions for signed-in staff; everything else for the server only ---------------------
do $$
declare f text;
begin
  foreach f in array array['public._r369_cfg(uuid,text)', 'public._r369_people(uuid,uuid,uuid,integer)', 'public._r369_escalation_tick(timestamptz)',
                           'public.task_reminder_tick(timestamptz)', 'public.task_reminder_tick__pre0369(timestamptz)',
                           'public.staff_email_claim(integer)', 'public.staff_email_claim__pre0369(integer)',
                           'public._r23_visible(uuid,uuid)', 'public._r23_visible__pre0369(uuid,uuid)', 'public.bell_feed__pre0369(integer)',
                           'public.task_escalation_settings_get(text)', 'public.task_escalation_settings_set(text,boolean,integer[])',
                           'public.bell_feed(integer)'] loop
    execute format('revoke all on function %s from public', f);
    if exists (select 1 from pg_roles where rolname = 'anon') then execute format('revoke all on function %s from anon', f); end if;
    if exists (select 1 from pg_roles where rolname = 'authenticated') then execute format('revoke all on function %s from authenticated', f); end if;
    if exists (select 1 from pg_roles where rolname = 'service_role') then execute format('grant execute on function %s to service_role', f); end if;
  end loop;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    execute 'grant execute on function public.task_escalation_settings_get(text) to authenticated';
    execute 'grant execute on function public.task_escalation_settings_set(text,boolean,integer[]) to authenticated';
    execute 'grant execute on function public.bell_feed(integer) to authenticated';
  end if;
end $$;

-- VERIFY every line should say true
select item, ok from (values
  ('01 setting + ladder tables, RLS on, closed to the app', to_regclass('public.task_escalation_settings') is not null
     and to_regclass('public.task_escalation_steps') is not null
     and coalesce((select bool_and(c.relrowsecurity) from pg_class c where c.oid in (to_regclass('public.task_escalation_settings'), to_regclass('public.task_escalation_steps'))), false)
     and not has_table_privilege('authenticated', 'public.task_escalation_steps', 'select')
     and not has_table_privilege('authenticated', 'public.task_escalation_settings', 'select')
     and not has_table_privilege('anon', 'public.task_escalation_steps', 'select')),
  ('02 each step once per task and start time', exists (select 1 from pg_indexes where schemaname = 'public' and indexname = 'task_escalation_steps_once369')),
  ('03 timer wrapped once (old body kept)', to_regprocedure('public.task_reminder_tick__pre0369(timestamptz)') is not null
     and position('r186-0369' in coalesce(pg_get_functiondef(to_regprocedure('public.task_reminder_tick(timestamptz)')), '')) > 0),
  ('04 e-mail claim wrapped once (old body kept)', to_regprocedure('public.staff_email_claim__pre0369(integer)') is not null
     and position('r186-0369' in coalesce(pg_get_functiondef(to_regprocedure('public.staff_email_claim(integer)')), '')) > 0),
  ('05 bell + inbox rule wrapped once (old bodies kept)', to_regprocedure('public.bell_feed__pre0369(integer)') is not null
     and to_regprocedure('public._r23_visible__pre0369(uuid,uuid)') is not null
     and position('r186-0369' in coalesce(pg_get_functiondef(to_regprocedure('public.bell_feed(integer)')), '')) > 0
     and position('r186-0369' in coalesce(pg_get_functiondef(to_regprocedure('public._r23_visible(uuid,uuid)')), '')) > 0),
  ('06 kind rules widened (escalation e-mail + log row allowed)',
     exists (select 1 from pg_constraint x where x.conrelid = 'public.staff_email_outbox'::regclass and x.contype = 'c' and pg_get_constraintdef(x.oid) like '%''task_escalation''%')
     and exists (select 1 from pg_constraint x where x.conrelid = 'public.event_task_log'::regclass and x.contype = 'c' and pg_get_constraintdef(x.oid) like '%''escalated''%')
     and exists (select 1 from pg_constraint x where x.conrelid = 'public.staff_email_outbox'::regclass and x.contype = 'c' and pg_get_constraintdef(x.oid) like '%''office_alert''%')
     and exists (select 1 from pg_constraint x where x.conrelid = 'public.event_task_log'::regclass and x.contype = 'c' and pg_get_constraintdef(x.oid) like '%''check_edit''%')),
  ('07 Settings functions for signed-in staff only', has_function_privilege('authenticated', 'public.task_escalation_settings_get(text)', 'execute')
     and has_function_privilege('authenticated', 'public.task_escalation_settings_set(text,boolean,integer[])', 'execute')
     and not has_function_privilege('anon', 'public.task_escalation_settings_set(text,boolean,integer[])', 'execute')),
  ('08 ladder, helpers and kept bodies server only', not has_function_privilege('authenticated', 'public._r369_escalation_tick(timestamptz)', 'execute')
     and not has_function_privilege('authenticated', 'public._r369_people(uuid,uuid,uuid,integer)', 'execute')
     and not has_function_privilege('authenticated', 'public.task_reminder_tick__pre0369(timestamptz)', 'execute')
     and not has_function_privilege('authenticated', 'public.staff_email_claim(integer)', 'execute')
     and not has_function_privilege('authenticated', 'public.bell_feed__pre0369(integer)', 'execute')
     and not has_function_privilege('authenticated', 'public._r23_visible(uuid,uuid)', 'execute')),
  ('09 bell still open to signed-in staff', has_function_privilege('authenticated', 'public.bell_feed(integer)', 'execute')
     and not has_function_privilege('anon', 'public.bell_feed(integer)', 'execute')),
  ('10 free-trial purge knows the ladder record, keeps the setting (or 0184 is absent)', to_regprocedure('public._tr184_purge_tables()') is null
     or (position('task_escalation_steps' in pg_get_functiondef(to_regprocedure('public._tr184_purge_tables()'))) > 0
         and position('task_escalation_settings' in pg_get_functiondef(to_regprocedure('public._tr184_keep_tables()'))) > 0))
) v(item, ok) order by item;
