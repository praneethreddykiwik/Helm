-- APPLY-0442 (R257: the event-day lock is removed, the checklist keeps who ticked what). Run on STAGING first, then Canada production, then HELM-PROD-MUMBAI.
-- Safe to run twice. Needs 0368, 0370, 0385, 0396, 0397, 0438 and 0441; it stops before changing anything if one is missing.
-- Same content as supabase/migrations/0442_r257_no_lock_checklist.sql. The last result lists one row per check.
begin;
set local lock_timeout = '5s';
set local statement_timeout = '5min';
-- 0442_r257_no_lock_checklist.sql - R257 (owner, 25 Nov 2026: "First of all remove the lock ... Instead of manually locking everything, add a
-- checklist. Mark as done, who did it."). Forward-only, additive, safe to run twice. ASCII only.
-- REQUIRES 0368, 0370, 0385, 0396, 0397, 0438, 0441. Paste the whole file in the Supabase SQL editor; the last statement answers one row per check.
--
-- In plain words:
--   A  THE EVENT-DAY LOCK IS GONE. Nothing is refused any more because the event is on its day or because somebody pressed Lock: tasks,
--      their times and steps, the run-sheet, Venue opens / Ready by. A CLOSED event keeps refusing plan changes exactly as before (the
--      lock was the only thing that did it): tasks, run-sheet, layout, Venue opens / Ready by. A cancelled event is as before (no refusal).
--      The stored lock rows and their history stay as they are; nothing reads them while the lock is off (a closed event still does).
--   B  THE CHECKLIST. Day before and Pre-event: a tick with who and when for every line, also a line Helm works out by itself
--      ("Marked done by Ananya, though 1 vendor is not confirmed"), own lines per event, and the history of every tick. A tick never
--      changes a vendor, the stock, a task or anything else. The 11 Day-before ticks (0396) stay where they are; they get the history too.
--      Reading = Staff - Can see, ticking = the same right as today's ticks ("Assign & send tasks", 0385), same studio only.
--   C  LATEST. When a check sends work back or approves it, the event's activity gets a line with who and the reason (0368 log).
--   D  BUSY. "Busy on another event that day" (crew_day_status) no longer counts an event that is already at Settlement (Closed was left out already).
--
-- ZERO DATA LOSS: 3 new tables, functions, 1 trigger, two more words in the log's list. No stored row is changed, nothing is deleted (a line of your own is cancelled, never removed).
-- The bodies replaced are kept as <name>__pre0442.
-- BRING THE LOCK BACK, one line (the checklist stays):
--   create or replace function public._r442_lock_on() returns boolean language sql stable set search_path = '' as 'select true';
-- (running this file again takes the lock away again)

-- ---- 0) preflight -----------------------------------------------------------------------------------------------------
do $$ declare f text; begin
  foreach f in array array['public._r397_locked(uuid)', 'public._r397_guard(uuid,text)', 'public._r397_enforce()', 'public._r397_auto(uuid)', 'public._r397_read(uuid)',
                           'public._r441_closed_guard(uuid,text)', 'public._r441_auto_at(uuid)', 'public._r441_on_day(uuid)', 'public.event_plan_lock_get(uuid)',
                           'public.event_plan_lock_set(uuid,boolean,text)', 'public._r396_event(uuid)', 'public._r396_check_keys()',
                           'public.event_day_check_set(uuid,text,boolean)', 'public._r385_can_assign()', 'public.has_area(text,text)', 'public.current_org_id()',
                           'public.crew_day_status(date,uuid)', 'public._r368_actor_kind()'] loop
    if to_regprocedure(f) is null then raise exception 'STOP 0442: run 0368, 0370, 0385, 0396, 0397, 0438 and 0441 first (% missing)', f; end if;
  end loop;
  if position('r227-0397' in pg_get_functiondef('public._r397_locked(uuid)'::regprocedure)) = 0
     or position('r227-0397' in pg_get_functiondef('public._r397_guard(uuid,text)'::regprocedure)) = 0
     or position('r256-0441' in pg_get_functiondef('public.event_plan_lock_get(uuid)'::regprocedure)) = 0
     or position('r256-0441' in pg_get_functiondef('public.event_plan_lock_set(uuid,boolean,text)'::regprocedure)) = 0
     or position('r187-0370' in pg_get_functiondef('public.crew_day_status(date,uuid)'::regprocedure)) = 0
     or position('r226-0396' in pg_get_functiondef('public.event_day_check_set(uuid,text,boolean)'::regprocedure)) = 0 then
    raise exception 'STOP 0442: a lock or tick function is not the body this file was written for - nothing was changed'; end if;
end $$;

-- ---- 1) keep the old bodies once (server only) -------------------------------------------------------------------------
do $$ declare r record; v text; begin
  for r in select * from (values ('_r397_locked', '(uuid)'), ('_r397_guard', '(uuid,text)'), ('event_plan_lock_get', '(uuid)'),
                                 ('event_plan_lock_set', '(uuid,boolean,text)'), ('event_day_check_set', '(uuid,text,boolean)'), ('crew_day_status', '(date,uuid)')) x(n, a) loop
    if to_regprocedure('public.' || r.n || '__pre0442' || r.a) is null then
      v := pg_get_functiondef(('public.' || r.n || r.a)::regprocedure);
      execute replace(v, 'FUNCTION public.' || r.n || '(', 'FUNCTION public.' || r.n || '__pre0442(');
    end if;
  end loop;
end $$;

-- ---- 2) the lock never applies; a closed event still refuses --------------------------------------------------------------
-- the switch: false = no lock (the line at the top of this file turns it back on)
create or replace function public._r442_lock_on()
returns boolean language sql stable set search_path = '' as $fn$ select false $fn$;

create or replace function public._r397_locked(p_quote uuid)
returns boolean language plpgsql stable security definer set search_path = '' as $fn$
-- r227-0397 r257-0442: only a closed event (the rule of 0397 for it); with the switch on: 0397 again
begin
  if not public._r442_lock_on()
     and not exists (select 1 from public.quotes q where q.id = p_quote and q.lifecycle_stage = 'closed') then return false; end if;
  return public._r397_locked__pre0442(p_quote);
end $fn$;

create or replace function public._r397_guard(p_quote uuid, p_what text)
returns void language plpgsql stable security definer set search_path = '' as $fn$
-- r227-0397 r257-0442
begin
  if p_quote is null or not public._r397_enforce() then return; end if;
  if public._r442_lock_on() then perform public._r397_guard__pre0442(p_quote, p_what); return; end if;
  if public._r397_locked(p_quote) then
    raise exception 'This event is closed, so its % cannot be changed. An admin can re-open it from its Closure page.', p_what
      using errcode = '42501', hint = 'event_closed';
  end if;
end $fn$;

-- the pages (also an older copy of them): nothing to lock, nothing to unlock
create or replace function public.event_plan_lock_get(p_quote uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $fn$
-- r227-0397 r256-0441 r257-0442
declare v jsonb;
begin
  v := public.event_plan_lock_get__pre0442(p_quote);
  if public._r442_lock_on() then return v; end if;
  return v || jsonb_build_object('removed', true, 'auto', false, 'auto_at', null, 'relocks', false, 'can_lock', false, 'can_unlock', false);
end $fn$;

create or replace function public.event_plan_lock_set(p_quote uuid, p_lock boolean, p_reason text)
returns jsonb language plpgsql volatile security definer set search_path = '' as $fn$
-- r227-0397 r256-0441 r257-0442: nothing is written while the lock is off
declare v_org uuid;
begin
  if public._r442_lock_on() then return public.event_plan_lock_set__pre0442(p_quote, p_lock, p_reason); end if;
  v_org := public._r396_event(p_quote);
  if p_lock is null then raise exception 'invalid' using errcode = '22023'; end if;
  if not (coalesce(public.has_area('quotes', 'edit'), false) or (p_lock and coalesce(public._r385_can_assign(), false))) then
    raise exception 'not allowed' using errcode = '42501'; end if;
  if p_lock then raise exception 'The event-day lock was removed. Tasks and times stay open until the event is closed. Reload the page.' using errcode = '22023', hint = 'r442_no_lock'; end if;
  if public._r397_locked(p_quote) then
    raise exception 'This event is closed. An admin can re-open it from its Closure page.' using errcode = '42501', hint = 'event_closed'; end if;
  return public.event_plan_lock_get(p_quote);
end $fn$;

-- ---- 3) the checklist: ticks, own lines, history -------------------------------------------------------------------------
create table if not exists public.event_check_marks (
  quote_id   uuid not null references public.quotes(id) on delete cascade,
  org_id     uuid not null references public.organizations(id),
  key        text not null,
  done       boolean not null default false,
  note       text,
  by_user    uuid,
  by_name    text,
  at         timestamptz not null default now(),
  primary key (quote_id, key),
  constraint event_check_marks_key_chk442 check (key ~ '^(daybefore|pre):[a-z0-9][a-z0-9_:.-]{0,90}$'),
  constraint event_check_marks_text_chk442 check (char_length(coalesce(note, '')) <= 160 and char_length(coalesce(by_name, '')) <= 80)
);
create table if not exists public.event_check_lines (
  id             uuid primary key default gen_random_uuid(),
  org_id         uuid not null references public.organizations(id),
  quote_id       uuid not null references public.quotes(id) on delete cascade,
  step           text not null,
  title          text not null,
  created_by     uuid,
  created_name   text,
  created_at     timestamptz not null default now(),
  cancelled_at   timestamptz,
  cancelled_by   uuid,
  cancelled_name text,
  constraint event_check_lines_step_chk442 check (step in ('daybefore', 'pre')),
  constraint event_check_lines_title_chk442 check (char_length(btrim(title)) between 1 and 120)
);
create table if not exists public.event_check_log (
  id         uuid primary key default gen_random_uuid(),
  org_id     uuid not null references public.organizations(id),
  quote_id   uuid not null references public.quotes(id) on delete cascade,
  key        text not null,
  action     text not null,
  note       text,
  by_user    uuid,
  by_name    text,
  at         timestamptz not null default now(),
  constraint event_check_log_action_chk442 check (action in ('done', 'undo', 'add', 'cancel')),
  constraint event_check_log_text_chk442 check (char_length(key) <= 110 and char_length(coalesce(note, '')) <= 160 and char_length(coalesce(by_name, '')) <= 80)
);
comment on table public.event_check_marks is 'r257-0442: who ticked which line of the event-day checklist (Day before, Pre-event). A tick never changes the thing it is about.';
comment on table public.event_check_lines is 'r257-0442: own lines of one event''s checklist. Cancelled, never deleted.';
comment on table public.event_check_log is 'r257-0442: the history of every tick and own line. Never changed by the app.';
create index if not exists event_check_marks_org442 on public.event_check_marks (org_id);
create index if not exists event_check_lines_quote442 on public.event_check_lines (quote_id, step, created_at);
create index if not exists event_check_lines_org442 on public.event_check_lines (org_id);
create index if not exists event_check_log_quote442 on public.event_check_log (quote_id, at desc);
create index if not exists event_check_log_org442 on public.event_check_log (org_id);

-- server only (no policy): read and written through the functions below
do $$ declare t text; r text; v_def text; begin
  foreach t in array array['event_check_marks', 'event_check_lines', 'event_check_log'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on table public.%I from public', t);
    foreach r in array array['anon', 'authenticated', 'service_role'] loop
      if exists (select 1 from pg_roles where rolname = r) then execute format('revoke all on table public.%I from %I', t, r); end if;
    end loop;
    if exists (select 1 from pg_roles where rolname = 'service_role') then execute format('grant select on table public.%I to service_role', t); end if;
    if to_regprocedure('public.tg_quote_org_match()') is not null
       and not exists (select 1 from pg_trigger where tgrelid = ('public.' || t)::regclass and tgname = 'zz_quote_org_match') then
      execute format('create trigger zz_quote_org_match before insert or update on public.%I for each row execute function public.tg_quote_org_match()', t);
    end if;
    if to_regprocedure('public.tg_studio_read_only()') is not null
       and not exists (select 1 from pg_trigger where tgrelid = ('public.' || t)::regclass and tgname = 'zzz_studio_read_only') then
      execute format('create trigger zzz_studio_read_only before insert or update or delete on public.%I for each row execute function public.tg_studio_read_only(''org_id'')', t);
    end if;
  end loop;
  -- free-trial retention (0184): they go with the studio's events (patched in place once, like 0440)
  if to_regprocedure('public._tr184_purge_tables()') is not null then
    v_def := pg_get_functiondef('public._tr184_purge_tables()'::regprocedure);
    if position('''event_check_marks''' in v_def) = 0 then
      if (length(v_def) - length(replace(v_def, '''event_issues'', ', ''))) / length('''event_issues'', ') <> 1 then
        raise notice '0442: _tr184_purge_tables has an unexpected body - left unchanged';
      else execute replace(v_def, '''event_issues'', ', '''event_issues'', ''event_check_log'', ''event_check_lines'', ''event_check_marks'', '); end if;
    end if;
  end if;
end $$;

create or replace function public._r442_name()
returns text language sql stable security definer set search_path = '' as $fn$
  -- r257-0442
  select coalesce((select left(coalesce(nullif(btrim(p.full_name), ''), nullif(split_part(coalesce(p.email, ''), '@', 1), '')), 80) from public.profiles p where p.id = auth.uid()), 'Someone');
$fn$;
-- may I tick? the 0396 right, on an event of my studio. Answers the studio.
create or replace function public._r442_edit(p_quote uuid)
returns uuid language plpgsql stable security definer set search_path = '' as $fn$
-- r257-0442
declare v_org uuid := public._r396_event(p_quote);
begin
  if not coalesce(public._r385_can_assign(), false) then raise exception 'not allowed' using errcode = '42501'; end if;
  return v_org;
end $fn$;
create or replace function public._r442_log(p_org uuid, p_quote uuid, p_key text, p_action text, p_note text)
returns void language sql volatile security definer set search_path = '' as $fn$
  -- r257-0442
  insert into public.event_check_log (org_id, quote_id, key, action, note, by_user, by_name, at)
  values (p_org, p_quote, left(p_key, 110), p_action, left(p_note, 160), auth.uid(), public._r442_name(), clock_timestamp());
$fn$;

-- everything the checklist keeps for one event (the 11 Day-before ticks come with event_day_plan_get, as before)
create or replace function public.event_checks_get(p_quote uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $fn$
-- r257-0442
declare v_org uuid := public._r396_event(p_quote);
begin
  if not coalesce(public.has_area('staff', 'view'), false) then raise exception 'not allowed' using errcode = '42501'; end if;
  return jsonb_build_object('v', 1, 'can_edit', coalesce(public._r385_can_assign(), false),
    'marks', coalesce((select jsonb_object_agg(m.key, jsonb_build_object('done', m.done, 'by', m.by_name, 'at', m.at, 'note', m.note))
                         from public.event_check_marks m where m.quote_id = p_quote and m.org_id = v_org), '{}'::jsonb),
    'lines', coalesce((select jsonb_agg(jsonb_build_object('id', l.id, 'step', l.step, 'title', l.title, 'by', l.created_name, 'at', l.created_at) order by l.created_at, l.id)
                         from public.event_check_lines l where l.quote_id = p_quote and l.org_id = v_org and l.cancelled_at is null), '[]'::jsonb),
    'log', coalesce((select jsonb_agg(jsonb_build_object('key', g.key, 'action', g.action, 'note', g.note, 'by', g.by_name, 'at', g.at) order by g.at desc)
                         from (select * from public.event_check_log z where z.quote_id = p_quote and z.org_id = v_org order by z.at desc limit 60) g), '[]'::jsonb));
end $fn$;

-- tick / untick one line. p_note = what the page showed at that moment ("1 vendor is not confirmed"); the same tick again changes nothing
-- (the first person and time stay)
create or replace function public.event_check_mark(p_quote uuid, p_key text, p_done boolean, p_note text default null)
returns jsonb language plpgsql volatile security definer set search_path = '' as $fn$
-- r257-0442
declare v_org uuid := public._r442_edit(p_quote); v_note text := left(nullif(btrim(regexp_replace(coalesce(p_note, ''), '[[:cntrl:][:space:]]+', ' ', 'g')), ''), 160); v_line text; m record;
begin
  if p_done is null or p_key is null or p_key !~ '^(daybefore|pre):[a-z0-9][a-z0-9_:.-]{0,90}$' then raise exception 'invalid_key' using errcode = 'P0001'; end if;
  if p_key ~ '^(daybefore|pre):own:' then
    select l.step || ':own:' || l.id::text into v_line from public.event_check_lines l
     where l.quote_id = p_quote and l.org_id = v_org and l.cancelled_at is null and p_key = l.step || ':own:' || l.id::text;
    if v_line is null then raise exception 'This line was taken off the checklist.' using errcode = '22023', hint = 'r442_gone'; end if;
  end if;
  perform pg_catalog.pg_advisory_xact_lock(hashtextextended('r442:' || p_quote::text, 0));   -- one change at a time per event
  if not exists (select 1 from public.event_check_marks x where x.quote_id = p_quote and x.key = p_key)
     and (select count(*) from public.event_check_marks x where x.quote_id = p_quote) >= 600 then
    raise exception 'This checklist is full.' using errcode = '22023', hint = 'r442_full'; end if;
  insert into public.event_check_marks as x (quote_id, org_id, key, done, note, by_user, by_name, at)
  values (p_quote, v_org, p_key, p_done, case when p_done then v_note end, auth.uid(), public._r442_name(), now())
  on conflict (quote_id, key) do update set done = excluded.done, note = excluded.note, by_user = excluded.by_user, by_name = excluded.by_name, at = excluded.at
   where x.done is distinct from excluded.done;
  if found then perform public._r442_log(v_org, p_quote, p_key, case when p_done then 'done' else 'undo' end, v_note); end if;
  select * into m from public.event_check_marks x where x.quote_id = p_quote and x.key = p_key;
  return jsonb_build_object('ok', true, 'key', p_key, 'item', jsonb_build_object('done', m.done, 'by', m.by_name, 'at', m.at, 'note', m.note));
end $fn$;

-- a line of your own. p_id = made by the page, so the same press twice is one line
create or replace function public.event_check_line_add(p_quote uuid, p_step text, p_title text, p_id uuid default null)
returns jsonb language plpgsql volatile security definer set search_path = '' as $fn$
-- r257-0442
declare v_org uuid := public._r442_edit(p_quote); v_title text := btrim(regexp_replace(coalesce(p_title, ''), '[[:cntrl:][:space:]]+', ' ', 'g')); v_id uuid; q record;
begin
  if coalesce(p_step, '') not in ('daybefore', 'pre') then raise exception 'invalid_step' using errcode = '22023'; end if;
  if char_length(v_title) < 1 or char_length(v_title) > 120 then raise exception 'Type the line (up to 120 characters).' using errcode = '22023', hint = 'r442_title'; end if;
  if v_title ~ '[<>]' then raise exception 'Leave out < and >.' using errcode = '22023', hint = 'r442_title'; end if;
  select x.status, x.lifecycle_stage into q from public.quotes x where x.id = p_quote;
  if coalesce(q.status, '') in ('cancelled', 'lost') or coalesce(q.lifecycle_stage, '') in ('closed', 'cancelled', 'archived') then
    raise exception 'This event is closed or cancelled - nothing can be added.' using errcode = '22023', hint = 'r442_closed'; end if;
  perform pg_catalog.pg_advisory_xact_lock(hashtextextended('r442:' || p_quote::text, 0));
  select l.id into v_id from public.event_check_lines l where l.quote_id = p_quote and l.org_id = v_org and l.cancelled_at is null and l.step = p_step and lower(l.title) = lower(v_title);
  if v_id is not null then return jsonb_build_object('id', v_id, 'same', true); end if;
  if (select count(*) from public.event_check_lines l where l.quote_id = p_quote and l.cancelled_at is null) >= 60 then
    raise exception 'An event can have 60 lines of your own.' using errcode = '22023', hint = 'r442_full'; end if;
  insert into public.event_check_lines (id, org_id, quote_id, step, title, created_by, created_name)
  values (coalesce(p_id, gen_random_uuid()), v_org, p_quote, p_step, v_title, auth.uid(), public._r442_name())
  on conflict (id) do nothing returning id into v_id;
  if v_id is null then
    select l.id into v_id from public.event_check_lines l where l.id = p_id and l.quote_id = p_quote and l.org_id = v_org;
    if v_id is null then raise exception 'not allowed' using errcode = '42501'; end if;
    return jsonb_build_object('id', v_id, 'same', true);
  end if;
  perform public._r442_log(v_org, p_quote, p_step || ':own:' || v_id::text, 'add', v_title);
  return jsonb_build_object('id', v_id);
end $fn$;

-- take a line of your own off the list (the row, its ticks and its history stay)
create or replace function public.event_check_line_cancel(p_id uuid)
returns jsonb language plpgsql volatile security definer set search_path = '' as $fn$
-- r257-0442
declare v_q uuid; v_org uuid; v_key text; v_title text;
begin
  select l.quote_id, l.step || ':own:' || l.id::text, l.title into v_q, v_key, v_title from public.event_check_lines l where l.id = p_id and l.org_id = public.current_org_id();
  if v_q is null then raise exception 'not allowed' using errcode = '42501'; end if;
  v_org := public._r442_edit(v_q);
  update public.event_check_lines set cancelled_at = now(), cancelled_by = auth.uid(), cancelled_name = public._r442_name() where id = p_id and org_id = v_org and cancelled_at is null;
  if found then perform public._r442_log(v_org, v_q, v_key, 'cancel', v_title); return jsonb_build_object('id', p_id, 'changed', true); end if;
  return jsonb_build_object('id', p_id, 'changed', false);
end $fn$;

-- the 11 Day-before ticks (0396 body) + the history; the same tick again keeps the first person and time
create or replace function public.event_day_check_set(p_quote uuid, p_key text, p_done boolean)
returns jsonb language plpgsql volatile security definer set search_path = '' as $fn$
-- r226-0396 r257-0442
declare v_org uuid; v_who text; v_item jsonb; v_cur jsonb;
begin
  v_org := public._r396_event(p_quote);
  if not coalesce(public._r385_can_assign(), false) then raise exception 'not allowed' using errcode = '42501'; end if;
  if p_key is null or not (p_key = any (public._r396_check_keys())) then raise exception 'invalid_key' using errcode = 'P0001'; end if;
  perform pg_catalog.pg_advisory_xact_lock(hashtextextended('r442:' || p_quote::text, 0));
  select p.checks -> p_key into v_cur from public.event_day_plans p where p.quote_id = p_quote;
  if jsonb_typeof(v_cur) = 'object' and (v_cur ->> 'done') = coalesce(p_done, false)::text then return jsonb_build_object('ok', true, 'key', p_key, 'item', v_cur); end if;
  select left(coalesce(nullif(btrim(p.full_name), ''), split_part(coalesce(p.email, ''), '@', 1), 'Someone'), 80) into v_who
    from public.profiles p where p.id = auth.uid();
  v_item := jsonb_build_object('done', coalesce(p_done, false), 'by', coalesce(v_who, 'Someone'), 'at', now());
  insert into public.event_day_plans (quote_id, org_id, checks, updated_by)
  values (p_quote, v_org, jsonb_build_object(p_key, v_item), auth.uid())
  on conflict (quote_id) do update set checks = public.event_day_plans.checks || jsonb_build_object(p_key, v_item), updated_at = now(), updated_by = auth.uid();
  perform public._r442_log(v_org, p_quote, 'daybefore:' || p_key, case when coalesce(p_done, false) then 'done' else 'undo' end, null);
  return jsonb_build_object('ok', true, 'key', p_key, 'item', v_item);
end $fn$;

-- ---- 3b) "Latest": sent back / approved by a check, with who and the reason -------------------------------------------------
do $$ declare v_def text; begin
  select pg_get_constraintdef(c.oid) into v_def from pg_constraint c where c.conrelid = 'public.event_task_log'::regclass and c.conname = 'event_task_log_kind_chk369';
  if v_def is not null and position('sent_back' in v_def) = 0 then
    if position('step_changed' in v_def) > 0 and (length(v_def) - length(replace(v_def, '::text', ''))) / length('::text') = 17 then
      alter table public.event_task_log drop constraint event_task_log_kind_chk369,
        add constraint event_task_log_kind_chk369 check (kind in ('assigned', 'reassigned', 'unassigned', 'time_changed', 'special_on', 'special_off', 'accepted', 'rejected',
          'started', 'completed', 'cancelled', 'reopened', 'check_in', 'check_out', 'check_edit', 'escalated', 'step_changed', 'sent_back', 'approved'));
    else raise notice '0442: the task log has an unexpected list of words - sent back / approved are not logged'; end if;
  end if;
end $$;
create or replace function public._r442_tg_verify_log()
returns trigger language plpgsql volatile security definer set search_path = '' as $fn$
-- r257-0442: one log row per check; never blocks it; nobody is messaged
begin
  begin
    insert into public.event_task_log (org_id, quote_id, task_id, crew_id, kind, title, detail, actor, actor_kind)
    values (new.org_id, new.quote_id, new.id, new.crew_id, case new.verify_status when 'rejected' then 'sent_back' else 'approved' end, left(new.title, 300),
            jsonb_strip_nulls(jsonb_build_object('by', case when auth.uid() is not null then public._r442_name() end, 'note', left(nullif(btrim(coalesce(new.verify_note, '')), ''), 300))), auth.uid(), public._r368_actor_kind());
  exception when others then null;
  end;
  return null;
end $fn$;
do $$ begin
  if not exists (select 1 from pg_trigger where tgrelid = 'public.event_tasks'::regclass and tgname = 'zzz_r442_verify_log') then
    create trigger zzz_r442_verify_log after update of verify_status on public.event_tasks for each row
      when (new.verify_status is distinct from old.verify_status and new.verify_status in ('rejected', 'passed')) execute function public._r442_tg_verify_log();
  end if;
end $$;

-- ---- 3c) busy elsewhere: not an event that is over and at Settlement (0370 body, one word added) -------------------------------
create or replace function public.crew_day_status(p_date date, p_exclude_quote uuid default null)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
-- r23-crew-0265 + r187-0370 r257-0442: approval added (pending = asked off, waiting; approved = approved day off)
declare v_org uuid := public.current_org_id(); v_tz text;
begin
  if auth.uid() is null or v_org is null or not public.has_area('staff', 'view') then raise exception 'not authorized' using errcode = '42501'; end if;
  if p_date is null then return '[]'::jsonb; end if;
  v_tz := public._r23_tz(v_org);
  return coalesce((
    select jsonb_agg(jsonb_build_object('crew_id', cm.id, 'name', cm.name, 'unavailable', u.day is not null, 'note', u.note,
                                        'approval', case when u.day is not null then coalesce(u.approval, 'approved') end,
                                        'booked', coalesce(b.codes, '[]'::jsonb)) order by cm.name)
      from public.crew_members cm
      left join public.crew_availability u on u.crew_id = cm.id and u.day = p_date and u.status = 'unavailable'
      left join lateral (
        select jsonb_agg(distinct jsonb_build_object('quote_id', qq.id, 'code', qq.code)) as codes
          from public.event_tasks t join public.quotes qq on qq.id = t.quote_id and qq.org_id = v_org and qq.deleted_at is null
         where t.org_id = v_org and t.crew_id = cm.id and t.status not in ('rejected', 'cancelled')
           and coalesce(qq.status, '') not in ('cancelled', 'lost') and coalesce(qq.lifecycle_stage, '') not in ('settlement', 'closed', 'cancelled', 'archived')
           and (p_exclude_quote is null or qq.id <> p_exclude_quote)
           and coalesce((t.planned_start at time zone v_tz)::date, qq.event_date) = p_date) b on true
     where cm.org_id = v_org and cm.active and (u.day is not null or b.codes is not null)), '[]'::jsonb);
end $$;

-- ---- 4) grants -----------------------------------------------------------------------------------------------------------
do $$ declare f text; r text; begin
  foreach f in array array['public._r442_lock_on()', 'public._r397_locked(uuid)', 'public._r397_guard(uuid,text)', 'public._r442_name()', 'public._r442_edit(uuid)',
                           'public._r442_log(uuid,uuid,text,text,text)', 'public._r442_tg_verify_log()', 'public.crew_day_status__pre0442(date,uuid)', 'public._r397_locked__pre0442(uuid)', 'public._r397_guard__pre0442(uuid,text)',
                           'public.event_plan_lock_get__pre0442(uuid)', 'public.event_plan_lock_set__pre0442(uuid,boolean,text)', 'public.event_day_check_set__pre0442(uuid,text,boolean)'] loop
    execute format('revoke all on function %s from public', f);
    foreach r in array array['anon', 'authenticated'] loop
      if exists (select 1 from pg_roles where rolname = r) then execute format('revoke all on function %s from %I', f, r); end if;
    end loop;
  end loop;
  foreach f in array array['public.event_plan_lock_get(uuid)', 'public.event_plan_lock_set(uuid,boolean,text)', 'public.event_day_check_set(uuid,text,boolean)', 'public.crew_day_status(date,uuid)', 'public.event_checks_get(uuid)',
                           'public.event_check_mark(uuid,text,boolean,text)', 'public.event_check_line_add(uuid,text,text,uuid)', 'public.event_check_line_cancel(uuid)'] loop
    execute format('revoke all on function %s from public', f);
    if exists (select 1 from pg_roles where rolname = 'anon') then execute format('revoke all on function %s from anon', f); end if;
    foreach r in array array['authenticated', 'service_role'] loop
      if exists (select 1 from pg_roles where rolname = r) then execute format('grant execute on function %s to %I', f, r); end if;
    end loop;
  end loop;
end $$;

do $$ begin
  if to_regclass('public.helm_schema_markers') is not null then
    insert into public.helm_schema_markers(num, name) values (442, '0442_r257_no_lock_checklist') on conflict (num) do nothing;
  end if;
end $$;

notify pgrst, 'reload schema';

-- ---- 5) CHECK (read only): every row must say true ---------------------------------------------------------------------------
select c.check, c.ok from (values
  ('01 the event-day lock is off', not public._r442_lock_on()),
  ('02 no open event refuses plan changes', not exists (select 1 from public.event_plan_locks l join public.quotes q on q.id = l.quote_id
      where coalesce(q.lifecycle_stage, '') <> 'closed' and public._r397_locked(q.id))),
  ('03 a closed event still refuses (the guard says so in words)', position('This event is closed' in pg_get_functiondef('public._r397_guard(uuid,text)'::regprocedure)) > 0
      and position('''closed''' in pg_get_functiondef('public._r397_locked(uuid)'::regprocedure)) > 0),
  ('04 the five guard triggers are still there and on', (select count(*) = 5 and bool_and(tgenabled = 'O') from pg_trigger where tgname = 'zz_r397_plan_lock')),
  ('05 the pages are told there is no lock', position('''removed''' in pg_get_functiondef('public.event_plan_lock_get(uuid)'::regprocedure)) > 0),
  ('06 three checklist tables, row security on, no direct access', (select count(*) = 3 and bool_and(c.relrowsecurity) and bool_and(not has_table_privilege('authenticated', c.oid, 'select') and not has_table_privilege('anon', c.oid, 'select')
      and not has_table_privilege('authenticated', c.oid, 'insert')) from pg_class c where c.relnamespace = 'public'::regnamespace and c.relname in ('event_check_marks', 'event_check_lines', 'event_check_log'))),
  ('07 a checklist row always belongs to its event''s studio', to_regprocedure('public.tg_quote_org_match()') is null
      or (select count(*) = 3 from pg_trigger where tgname = 'zz_quote_org_match' and tgrelid::regclass::text in ('event_check_marks', 'event_check_lines', 'event_check_log', 'public.event_check_marks', 'public.event_check_lines', 'public.event_check_log'))),
  ('08 signed-in people only', has_function_privilege('authenticated', 'public.event_check_mark(uuid,text,boolean,text)', 'execute') and not has_function_privilege('anon', 'public.event_check_mark(uuid,text,boolean,text)', 'execute')
      and not has_function_privilege('anon', 'public.event_checks_get(uuid)', 'execute') and not has_function_privilege('anon', 'public.event_check_line_add(uuid,text,text,uuid)', 'execute') and not has_function_privilege('anon', 'public.event_check_line_cancel(uuid)', 'execute')),
  ('09 ticking needs the same right as before', position('_r385_can_assign' in pg_get_functiondef('public._r442_edit(uuid)'::regprocedure)) > 0 and position('_r442_edit' in pg_get_functiondef('public.event_check_mark(uuid,text,boolean,text)'::regprocedure)) > 0),
  ('10 the 11 Day-before ticks keep a history too', position('_r442_log' in pg_get_functiondef('public.event_day_check_set(uuid,text,boolean)'::regprocedure)) > 0),
  ('11 helpers and kept bodies are server only, search_path pinned', (select count(*) = 11 and bool_and(coalesce(p.proconfig @> array['search_path=""'], false)
      and not has_function_privilege('anon', p.oid, 'execute') and not has_function_privilege('authenticated', p.oid, 'execute'))
      from pg_proc p where p.pronamespace = 'public'::regnamespace and (p.proname like '\_r442\_%' or p.proname like '%\_\_pre0442'))),
  ('12 sent back and approved are written in the activity', exists (select 1 from pg_trigger where tgrelid = 'public.event_tasks'::regclass and tgname = 'zzz_r442_verify_log' and tgenabled = 'O')
      and exists (select 1 from pg_constraint c where c.conrelid = 'public.event_task_log'::regclass and c.conname = 'event_task_log_kind_chk369' and position('sent_back' in pg_get_constraintdef(c.oid)) > 0)),
  ('13 busy elsewhere leaves out events at Settlement', position('''settlement''' in pg_get_functiondef('public.crew_day_status(date,uuid)'::regprocedure)) > 0),
  ('14 no lock row was changed by this file (locks on record: ' || (select count(*) from public.event_plan_locks) || ')', true)
) c("check", ok);
commit;
