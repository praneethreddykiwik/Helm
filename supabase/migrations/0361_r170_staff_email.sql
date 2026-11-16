-- 0361_r170_staff_email.sql - CANONICAL forward-only. R170 (owner, 15 Nov 2026: "while assigning task and crew ... Send by
-- email ... the task reminder should be going to the email. As of now, since WhatsApp is not integrated, let us make this work").
-- REQUIRES 0132 (event_tasks assign trigger, _assign132_phone), 0269 (automation_settings), 0274 (automation_overview /
--          automation_switch), 0283 (_r283_off_email), 0338 (task_wa_outbox, _r338_event / _r338_link / _r338_time / _r338_day),
--          0179 (_tb179_no_send), 0183 (_trial_locked), 0164 (_sq164_tg_outbox), 0166 (_ts166_tg_outbox_skip), 0150 (comms_settings
--          email_from_name / email_reply_to).
--
-- In plain words:
--   1  A NEW e-mail queue for staff, staff_email_outbox. Until now "you have been given a task" and the task reminders were
--      WhatsApp only (assign_notify_outbox / task_wa_outbox), so with WhatsApp not connected nothing reached the person.
--   2  Task given to a staff member (new task, or the person on a task changes): ONE e-mail is queued to that person, listing
--      all their open tasks for that event. Tasks given within the same minute are merged into that one e-mail.
--   3  Task reminders (before the start, late, office alert): every reminder the 0338 timer queues for WhatsApp is ALSO
--      queued as an e-mail (the office alert goes to the event manager). Same times, same rules, nothing new to set up.
--   4  staff_email_send(task, all): the "Send by email" buttons on the Operations page (Staff edit only, own studio only).
--      The address is always read from the staff record (or the linked login), never taken from the page.
--   5  staff_email_hold(event, staff): the "Send by email" box on the assign form, when unticked, cancels the e-mail that
--      was just queued for that person (it waits one minute before it is sent, so there is time).
--   6  Studio switch "E-mail staff their tasks" (Settings -> Automations), ON by default; the automatic e-mails follow it.
--      The buttons always work (they are an explicit office action).
--   7  staff_email_claim / staff_email_mark: comms-dispatch sends the e-mails (studio name + reply-to, as every other studio
--      e-mail). Every row is re-checked at send time (task still open, same person, studio not on a trial, event live).
--   Free trial: unchanged - nothing leaves Helm (the 0166 / 0179 / 0183 gates skip the rows).
--   Deactivated team members get nothing (0283).
--
-- ZERO DATA LOSS: additive + idempotent. One new column (default true), one new table, new functions, two new AFTER
-- triggers (they only ever INSERT / UPDATE rows of the new table and can never make the save fail), and the two automation
-- functions wrapped once (old bodies kept as *__pre0361). Nothing dropped, nothing deleted. Safe to run twice. ASCII only.

-- ---- 0) preflight ---------------------------------------------------------------------------------------------------
do $$
begin
  if to_regclass('public.event_tasks') is null or to_regclass('public.crew_members') is null or to_regclass('public.quotes') is null
     or to_regclass('public.profiles') is null then
    raise exception 'STOP 0361: base tables (event_tasks / crew_members / quotes / profiles) missing'; end if;
  if to_regclass('public.task_wa_outbox') is null or to_regprocedure('public._r338_link(uuid,uuid,text)') is null
     or to_regprocedure('public._r338_event(uuid)') is null or to_regprocedure('public._r338_time(timestamp with time zone,uuid)') is null
     or to_regprocedure('public._r338_day(timestamp with time zone,uuid)') is null then
    raise exception 'STOP 0361: run 0338 (task reminders) first'; end if;
  if to_regclass('public.automation_settings') is null or to_regprocedure('public.automation_overview()') is null
     or to_regprocedure('public.automation_switch(text,boolean)') is null then
    raise exception 'STOP 0361: run 0269 + 0274 (automations) first'; end if;
  if to_regprocedure('public._assign132_phone(text)') is null then raise exception 'STOP 0361: run 0132 first'; end if;
  if to_regprocedure('public._r283_off_email(uuid,text)') is null then raise exception 'STOP 0361: run 0283 first'; end if;
  if to_regprocedure('public._tb179_no_send(uuid)') is null or to_regprocedure('public._trial_locked(uuid)') is null then
    raise exception 'STOP 0361: run 0179 + 0183 first'; end if;
  if to_regprocedure('public._sq164_tg_outbox()') is null or to_regprocedure('public._ts166_tg_outbox_skip()') is null then
    raise exception 'STOP 0361: run 0164 + 0166 first'; end if;
  if to_regprocedure('public.has_area(text,text)') is null or to_regprocedure('public.current_org_id()') is null then
    raise exception 'STOP 0361: has_area / current_org_id missing'; end if;
  if not exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'comms_settings' and column_name = 'email_reply_to') then
    raise exception 'STOP 0361: run 0150 (studio e-mail settings) first'; end if;
end $$;

-- ---- 1) studio switch (ON by default) ---------------------------------------------------------------------------------
alter table public.automation_settings add column if not exists staff_email_enabled boolean not null default true;

-- ---- 2) the queue ------------------------------------------------------------------------------------------------------
create table if not exists public.staff_email_outbox (
  id          uuid primary key default gen_random_uuid(),
  org_id      uuid not null references public.organizations(id) on delete cascade,
  quote_id    uuid not null references public.quotes(id) on delete cascade,
  task_id     uuid references public.event_tasks(id) on delete cascade,
  crew_id     uuid references public.crew_members(id) on delete set null,
  phone       text check (phone is null or phone ~ '^[0-9]{8,15}$'),
  kind        text not null check (kind in ('task_assigned', 'task_list', 'task_one', 'task_reminder', 'task_late', 'office_alert')),
  recipient   text not null check (char_length(recipient) between 6 and 320 and recipient ~ '^[^[:space:]@<>",;:]{1,64}@[A-Za-z0-9.-]{1,190}[.][A-Za-z]{2,24}$'),
  name        text check (name is null or char_length(name) <= 120),
  dedupe_key  text not null check (char_length(dedupe_key) <= 300),
  ref_start   timestamptz,
  status      text not null default 'pending' check (status in ('pending', 'sent', 'skipped', 'failed')),
  reason      text check (reason is null or char_length(reason) <= 80),
  not_before  timestamptz not null default now(),
  attempts    integer not null default 0,
  claimed_at  timestamptz,
  sent_at     timestamptz,
  created_by  uuid,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create unique index if not exists staff_email_outbox_dedupe361 on public.staff_email_outbox(dedupe_key);
create index if not exists staff_email_outbox_pending361 on public.staff_email_outbox(not_before) where sent_at is null;
create index if not exists staff_email_outbox_merge361 on public.staff_email_outbox(quote_id, recipient) where sent_at is null;
create index if not exists staff_email_outbox_org_id_idx on public.staff_email_outbox(org_id);
create index if not exists staff_email_outbox_task_id_idx on public.staff_email_outbox(task_id);
create index if not exists staff_email_outbox_crew_id_idx on public.staff_email_outbox(crew_id);

do $$ begin
  alter table public.staff_email_outbox enable row level security;
  revoke all on table public.staff_email_outbox from public;
  if exists (select 1 from pg_roles where rolname = 'anon') then execute 'revoke all on table public.staff_email_outbox from anon'; end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then execute 'revoke all on table public.staff_email_outbox from authenticated'; end if;
  if exists (select 1 from pg_roles where rolname = 'service_role') then execute 'grant select on table public.staff_email_outbox to service_role'; end if;
  -- event <-> studio integrity, read-only studios, system changes stay quiet, free trial sends nothing (same as every outbox)
  if to_regprocedure('public.tg_quote_org_match()') is not null
     and not exists (select 1 from pg_trigger where tgrelid = 'public.staff_email_outbox'::regclass and tgname = 'zz_quote_org_match') then
    create trigger zz_quote_org_match before insert or update on public.staff_email_outbox for each row execute function public.tg_quote_org_match();
  end if;
  if to_regprocedure('public.tg_studio_read_only()') is not null
     and not exists (select 1 from pg_trigger where tgrelid = 'public.staff_email_outbox'::regclass and tgname = 'zzz_studio_read_only') then
    create trigger zzz_studio_read_only before insert or update or delete on public.staff_email_outbox for each row execute function public.tg_studio_read_only('org_id');
  end if;
  if not exists (select 1 from pg_trigger where tgrelid = 'public.staff_email_outbox'::regclass and tgname = 'zzz_sq164_system_skip') then
    create trigger zzz_sq164_system_skip before insert on public.staff_email_outbox for each row execute function public._sq164_tg_outbox();
  end if;
  if not exists (select 1 from pg_trigger where tgrelid = 'public.staff_email_outbox'::regclass and tgname = 'zzzz_ts166_outbox_skip') then
    create trigger zzzz_ts166_outbox_skip before insert on public.staff_email_outbox for each row execute function public._ts166_tg_outbox_skip();
  end if;
end $$;

-- trial retention (0184): the queue is purged with the studio events (like task_wa_outbox)
do $$ declare v_def text; begin
  if to_regprocedure('public._tr184_purge_tables()') is not null then
    v_def := pg_get_functiondef('public._tr184_purge_tables()'::regprocedure);
    if position('''staff_email_outbox''' in v_def) = 0 then
      if (length(v_def) - length(replace(v_def, '''task_wa_outbox'', ''assign_notify_outbox''', ''))) / length('''task_wa_outbox'', ''assign_notify_outbox''') <> 1 then
        raise notice '0361: _tr184_purge_tables has an unexpected body - left unchanged';
      else execute replace(v_def, '''task_wa_outbox'', ''assign_notify_outbox''', '''task_wa_outbox'', ''staff_email_outbox'', ''assign_notify_outbox'''); end if;
    end if;
  end if;
end $$;

-- ---- 3) helpers --------------------------------------------------------------------------------------------------------
-- a usable e-mail address (lower case) or null
create or replace function public._r361_email(p text)
returns text language sql immutable set search_path = '' as $fn$
  -- r170-0361
  select case when char_length(btrim(coalesce(p, ''))) between 6 and 320
               and lower(btrim(p)) ~ '^[^[:space:]@<>",;:]{1,64}@[a-z0-9.-]{1,190}[.][a-z]{2,24}$'
              then lower(btrim(p)) end;
$fn$;

-- the studio switch "E-mail staff their tasks" (no settings row yet = ON)
create or replace function public._r361_on(p_org uuid)
returns boolean language sql stable security definer set search_path = '' as $fn$
  -- r170-0361
  select p_org is not null and coalesce((select s.staff_email_enabled from public.automation_settings s where s.org_id = p_org), true);
$fn$;

-- the staff member of THIS studio: by staff id, else the one active staff member with this phone.
-- Address = the staff record e-mail, else the e-mail of the Helm login linked to the record. Deactivated members: none.
-- { crew_id, name, email } or null
create or replace function public._r361_person(p_org uuid, p_crew uuid, p_phone text)
returns jsonb language plpgsql stable security definer set search_path = '' as $fn$
-- r170-0361
declare c public.crew_members; v_phone text := public._assign132_phone(p_phone); v_n integer; v_email text;
begin
  if p_org is null then return null; end if;
  if p_crew is not null then
    select * into c from public.crew_members m where m.id = p_crew and m.org_id = p_org;
  end if;
  if c.id is null and v_phone is not null then
    select count(*) into v_n from public.crew_members m where m.org_id = p_org and m.active and public._assign132_phone(m.phone) = v_phone;
    if v_n = 1 then
      select * into c from public.crew_members m where m.org_id = p_org and m.active and public._assign132_phone(m.phone) = v_phone;
    end if;
  end if;
  if c.id is null then return null; end if;
  v_email := coalesce(public._r361_email(c.email),
                      public._r361_email((select p.email from public.profiles p where p.id = c.profile_id)));
  if v_email is null or coalesce(public._r283_off_email(p_org, v_email), false) then return null; end if;
  return jsonb_build_object('crew_id', c.id, 'name', c.name, 'email', v_email);
end $fn$;

-- the event manager of an event (office alert): their staff record e-mail, else their login e-mail
create or replace function public._r361_manager(p_org uuid, p_quote uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $fn$
-- r170-0361
declare v_mgr uuid; v_name text; v_email text;
begin
  select q.manager_id into v_mgr from public.quotes q where q.id = p_quote and q.org_id = p_org;
  if v_mgr is null then return null; end if;
  select public._r361_email(cm.email), cm.name into v_email, v_name from public.crew_members cm
   where cm.org_id = p_org and cm.profile_id = v_mgr and cm.active order by cm.created_at limit 1;
  if v_email is null then
    select public._r361_email(p.email), coalesce(v_name, p.full_name) into v_email, v_name from public.profiles p where p.id = v_mgr and p.org_id = p_org;
  end if;
  if v_email is null or coalesce(public._r283_off_email(p_org, v_email), false) then return null; end if;
  return jsonb_build_object('name', v_name, 'email', v_email);
end $fn$;

-- the event is live (not deleted / cancelled / a sample) and the studio may send (not a trial, not read-only)
create or replace function public._r361_live(p_org uuid, p_quote uuid)
returns boolean language sql stable security definer set search_path = '' as $fn$
  -- r170-0361
  select p_org is not null
     and not coalesce(public._tb179_no_send(p_org), false) and not coalesce(public._trial_locked(p_org), false)
     and exists (select 1 from public.quotes q where q.id = p_quote and q.org_id = p_org and q.deleted_at is null
                   and coalesce(q.status, '') <> 'cancelled' and not coalesce(q.is_demo, false));
$fn$;

-- a person a task is for (by staff id, else phone) matches the queued row
create or replace function public._r361_mine(t public.event_tasks, p_crew uuid, p_phone text)
returns boolean language sql stable set search_path = '' as $fn$
  -- r170-0361
  select (p_crew is not null and t.crew_id = p_crew)
      or (p_phone is not null and public._assign132_phone(t.assignee_phone) = p_phone);
$fn$;

-- ---- 4) automatic e-mail when a task is given to someone ------------------------------------------------------------
create or replace function public._r361_tg_task_assigned()
returns trigger language plpgsql security definer set search_path = '' as $fn$
-- r170-0361: never makes the save fail; merges the tasks given to one person within a minute into one e-mail
declare v_org uuid; v_p jsonb; v_phone text; v_id uuid;
begin
  if tg_op = 'UPDATE' and (new.crew_id, new.assignee_phone) is not distinct from (old.crew_id, old.assignee_phone) then return null; end if;
  begin
    if coalesce(new.assignee_kind, 'in_house') <> 'in_house' or new.status in ('completed', 'cancelled', 'rejected') then return null; end if;
    v_org := new.org_id;
    if not public._r361_on(v_org) or not public._r361_live(v_org, new.quote_id) then return null; end if;
    v_phone := public._assign132_phone(new.assignee_phone);
    v_p := public._r361_person(v_org, new.crew_id, v_phone);
    if v_p is null then return null; end if;
    -- one waiting e-mail per person per event: a later task joins it (and it waits another minute)
    select o.id into v_id from public.staff_email_outbox o
     where o.quote_id = new.quote_id and o.recipient = v_p ->> 'email' and o.kind = 'task_assigned'
       and o.status = 'pending' and o.sent_at is null and o.claimed_at is null
     order by o.created_at desc limit 1;
    if v_id is not null then
      update public.staff_email_outbox set not_before = greatest(not_before, now() + interval '1 minute'), updated_at = now() where id = v_id;
      return null;
    end if;
    insert into public.staff_email_outbox (org_id, quote_id, task_id, crew_id, phone, kind, recipient, name, dedupe_key, not_before, created_by)
    values (v_org, new.quote_id, new.id, (v_p ->> 'crew_id')::uuid, v_phone, 'task_assigned', v_p ->> 'email', left(v_p ->> 'name', 120),
            'assign|' || new.quote_id::text || '|' || (v_p ->> 'email') || '|' || gen_random_uuid()::text,
            now() + interval '1 minute', auth.uid())
    on conflict (dedupe_key) do nothing;
  exception when others then
    raise warning 'r170-0361: task e-mail not queued (%)', sqlstate;
  end;
  return null;
end $fn$;

do $$ begin
  if not exists (select 1 from pg_trigger where tgrelid = 'public.event_tasks'::regclass and tgname = 'zzz_r361_task_email') then
    create trigger zzz_r361_task_email after insert or update of crew_id, assignee_phone on public.event_tasks
      for each row execute function public._r361_tg_task_assigned();
  end if;
end $$;

-- ---- 5) every queued WhatsApp task reminder is also an e-mail ---------------------------------------------------------
create or replace function public._r361_tg_reminder()
returns trigger language plpgsql security definer set search_path = '' as $fn$
-- r170-0361: mirrors task_wa_outbox (0338 timer) into the e-mail queue; never makes the insert fail
declare t public.event_tasks; v_p jsonb; v_phone text; v_kind text;
begin
  begin
    if new.kind in ('reminder', 'late') then
      if new.status <> 'queued' then return null; end if;
      v_kind := case new.kind when 'reminder' then 'task_reminder' else 'task_late' end;
    elsif new.kind = 'office_alert' then
      -- the WhatsApp alert is skipped when the manager has no phone; the e-mail still goes
      if not (new.status = 'queued' or coalesce(new.reason, '') = 'no_event_manager_phone') then return null; end if;
      v_kind := 'office_alert';
    else
      return null;
    end if;
    if not public._r361_on(new.org_id) or not public._r361_live(new.org_id, new.quote_id) then return null; end if;
    select * into t from public.event_tasks x where x.id = new.task_id and x.org_id = new.org_id;
    if t.id is null then return null; end if;
    v_phone := public._assign132_phone(t.assignee_phone);
    if v_kind = 'office_alert' then v_p := public._r361_manager(new.org_id, new.quote_id);
    else v_p := public._r361_person(new.org_id, t.crew_id, v_phone); end if;
    if v_p is null then return null; end if;
    insert into public.staff_email_outbox (org_id, quote_id, task_id, crew_id, phone, kind, recipient, name, dedupe_key, ref_start, not_before)
    values (new.org_id, new.quote_id, t.id, case when v_kind = 'office_alert' then null else (v_p ->> 'crew_id')::uuid end, v_phone, v_kind,
            v_p ->> 'email', left(v_p ->> 'name', 120), 'rem|' || new.slot_key, t.planned_start, now())
    on conflict (dedupe_key) do nothing;
  exception when others then
    raise warning 'r170-0361: reminder e-mail not queued (%)', sqlstate;
  end;
  return null;
end $fn$;

do $$ begin
  if not exists (select 1 from pg_trigger where tgrelid = 'public.task_wa_outbox'::regclass and tgname = 'zzz_r361_reminder_email') then
    create trigger zzz_r361_reminder_email after insert on public.task_wa_outbox
      for each row execute function public._r361_tg_reminder();
  end if;
end $$;

-- ---- 6) the "Send by email" buttons (Operations page) -------------------------------------------------------------------
-- p_all true: every open task of this person on this event; false: just this task. One send per 2 minutes per person.
create or replace function public.staff_email_send(p_task uuid, p_all boolean default true)
returns jsonb language plpgsql volatile security definer set search_path = '' as $fn$
-- r170-0361
declare v_org uuid := public.current_org_id(); t public.event_tasks; v_p jsonb; v_phone text; v_email text; v_key text; v_id uuid;
begin
  if auth.uid() is null or v_org is null or not public.has_area('staff', 'edit') then
    raise exception 'not authorized' using errcode = '42501'; end if;
  select * into t from public.event_tasks x where x.id = p_task and x.org_id = v_org;
  if t.id is null then raise exception 'task not found' using errcode = 'P0002'; end if;
  if coalesce(t.assignee_kind, 'in_house') <> 'in_house' then return jsonb_build_object('ok', false, 'reason', 'vendor'); end if;
  if t.status in ('completed', 'cancelled', 'rejected') then return jsonb_build_object('ok', false, 'reason', 'closed'); end if;
  if coalesce(public._sample_outbound_blocked(v_org, null::text), false) or coalesce(public._tb179_no_send(v_org), false) then
    return jsonb_build_object('ok', false, 'reason', 'trial'); end if;
  if not public._r361_live(v_org, t.quote_id) then return jsonb_build_object('ok', false, 'reason', 'not_live'); end if;
  v_phone := public._assign132_phone(t.assignee_phone);
  v_p := public._r361_person(v_org, t.crew_id, v_phone);
  if v_p is null then
    return jsonb_build_object('ok', false, 'reason', 'no_email', 'name', coalesce(t.assignee_name, '')); end if;
  v_email := v_p ->> 'email';
  v_key := 'manual|' || case when p_all then t.quote_id::text else t.id::text end || '|' || v_email || '|'
           || floor(extract(epoch from now()) / 120)::bigint::text;
  insert into public.staff_email_outbox (org_id, quote_id, task_id, crew_id, phone, kind, recipient, name, dedupe_key, not_before, created_by)
  values (v_org, t.quote_id, t.id, (v_p ->> 'crew_id')::uuid, v_phone, case when p_all then 'task_list' else 'task_one' end,
          v_email, left(v_p ->> 'name', 120), v_key, now(), auth.uid())
  on conflict (dedupe_key) do nothing returning id into v_id;
  if v_id is null then return jsonb_build_object('ok', false, 'reason', 'just_sent', 'name', v_p ->> 'name'); end if;
  -- the waiting automatic e-mail for the same person and event is now covered by this one
  update public.staff_email_outbox set status = 'skipped', reason = 'sent_by_hand', sent_at = now(), updated_at = now()
   where quote_id = t.quote_id and recipient = v_email and kind = 'task_assigned' and status = 'pending' and sent_at is null
     and claimed_at is null and p_all;
  return jsonb_build_object('ok', true, 'name', v_p ->> 'name',
    'masked', left(split_part(v_email, '@', 1), 1) || '***@' || split_part(v_email, '@', 2));
end $fn$;

-- the assign form "Send by email" box unticked: cancel the e-mail just queued for that person on that event
create or replace function public.staff_email_hold(p_quote uuid, p_crew uuid)
returns integer language plpgsql volatile security definer set search_path = '' as $fn$
-- r170-0361
declare v_org uuid := public.current_org_id(); v_p jsonb; v_n integer := 0;
begin
  if auth.uid() is null or v_org is null or not public.has_area('staff', 'edit') then
    raise exception 'not authorized' using errcode = '42501'; end if;
  if not exists (select 1 from public.quotes q where q.id = p_quote and q.org_id = v_org) then return 0; end if;
  v_p := public._r361_person(v_org, p_crew, null);
  if v_p is null then return 0; end if;
  update public.staff_email_outbox set status = 'skipped', reason = 'office_unticked', sent_at = now(), updated_at = now()
   where org_id = v_org and quote_id = p_quote and recipient = v_p ->> 'email' and kind = 'task_assigned'
     and status = 'pending' and sent_at is null and claimed_at is null;
  get diagnostics v_n = row_count;
  return v_n;
end $fn$;

-- ---- 7) comms-dispatch: claim + mark (service role only) ----------------------------------------------------------------
create or replace function public.staff_email_claim(p_limit integer default 25)
returns jsonb language plpgsql volatile security definer set search_path = '' as $fn$
-- r170-0361: every row re-checked at send time; fails closed (skipped) when anything changed
declare r record; v_out jsonb := '[]'::jsonb; t public.event_tasks; v_ok boolean; v_why text; v_p jsonb; v_tasks jsonb;
        v_ident jsonb; v_ev jsonb; v_link text; v_tphone text;
begin
  update public.staff_email_outbox set status = 'failed', reason = 'too_many_attempts', sent_at = now(), updated_at = now()
   where sent_at is null and status = 'pending' and attempts >= 5;
  update public.staff_email_outbox set status = 'skipped', reason = 'too_old', sent_at = now(), updated_at = now()
   where sent_at is null and status = 'pending'
     and created_at < now() - case when kind in ('task_reminder', 'task_late', 'office_alert') then interval '2 hours' else interval '1 day' end;
  for r in select o.* from public.staff_email_outbox o
            where o.sent_at is null and o.status = 'pending' and o.not_before <= now()
              and (o.claimed_at is null or o.claimed_at < now() - interval '10 minutes')
            order by o.not_before limit greatest(1, least(coalesce(p_limit, 25), 100)) for update of o skip locked
  loop
    v_ok := true; v_why := null; v_tasks := '[]'::jsonb; v_link := null; t := null;
    if not public._r361_live(r.org_id, r.quote_id) then v_ok := false; v_why := 'not_live';
    elsif r.kind in ('task_assigned', 'task_reminder', 'task_late', 'office_alert') and not public._r361_on(r.org_id) then v_ok := false; v_why := 'switched_off';
    elsif coalesce(public._r283_off_email(r.org_id, r.recipient), false) then v_ok := false; v_why := 'deactivated';
    end if;
    if v_ok and r.task_id is not null then
      select * into t from public.event_tasks x where x.id = r.task_id and x.org_id = r.org_id;
    end if;
    if v_ok and r.kind in ('task_assigned', 'task_list', 'task_one', 'task_reminder', 'task_late') then
      -- the person must still be the same staff member with the same address
      v_p := public._r361_person(r.org_id, r.crew_id, r.phone);
      if v_p is null or (v_p ->> 'email') is distinct from r.recipient then v_ok := false; v_why := 'person_changed'; end if;
    end if;
    if v_ok and r.kind in ('task_assigned', 'task_list') then
      select coalesce(jsonb_agg(jsonb_build_object('title', left(x.title, 160), 'category', left(coalesce(x.category, ''), 60),
               'start', public._r338_time(x.planned_start, r.org_id), 'day', public._r338_day(x.planned_start, r.org_id))
               order by x.planned_start nulls last, x.category, x.seq), '[]'::jsonb)
        into v_tasks
        from (select * from public.event_tasks x where x.quote_id = r.quote_id and x.org_id = r.org_id
                 and x.status not in ('completed', 'cancelled', 'rejected') and coalesce(x.assignee_kind, 'in_house') = 'in_house'
                 and public._r361_mine(x, r.crew_id, r.phone)
               order by x.planned_start nulls last, x.category, x.seq limit 25) x;
      if jsonb_array_length(v_tasks) = 0 then v_ok := false; v_why := 'no_open_tasks'; end if;
      select public._assign132_phone(x.assignee_phone) into v_tphone from public.event_tasks x
       where x.quote_id = r.quote_id and x.org_id = r.org_id and public._r361_mine(x, r.crew_id, r.phone)
         and x.assignee_phone is not null limit 1;
    elsif v_ok and r.kind = 'task_one' then
      if t.id is null or t.status in ('completed', 'cancelled', 'rejected') or not public._r361_mine(t, r.crew_id, r.phone) then
        v_ok := false; v_why := 'task_changed'; end if;
      v_tphone := public._assign132_phone(t.assignee_phone);
    elsif v_ok and r.kind in ('task_reminder', 'task_late') then
      if t.id is null or t.status not in ('assigned', 'accepted') or not public._r361_mine(t, r.crew_id, r.phone)
         or t.planned_start is distinct from r.ref_start then
        v_ok := false; v_why := 'task_changed'; end if;
      v_tphone := public._assign132_phone(t.assignee_phone);
    elsif v_ok and r.kind = 'office_alert' then
      v_p := public._r361_manager(r.org_id, r.quote_id);
      if t.id is null or t.status not in ('assigned', 'accepted') or v_p is null or (v_p ->> 'email') is distinct from r.recipient then
        v_ok := false; v_why := 'task_changed'; end if;
    end if;
    if not coalesce(v_ok, false) then
      update public.staff_email_outbox set status = 'skipped', reason = coalesce(v_why, 'recheck'), sent_at = now(), updated_at = now() where id = r.id;
      continue;
    end if;
    v_link := case when r.kind = 'office_alert' then 'ops.html?quote=' || r.quote_id::text
                   else public._r338_link(r.quote_id, r.org_id, v_tphone) end;
    v_ev := public._r338_event(r.quote_id);
    select jsonb_build_object('from_name', cs.email_from_name, 'reply_to', cs.email_reply_to) into v_ident
      from public.comms_settings cs where cs.org_id = r.org_id;
    update public.staff_email_outbox set claimed_at = now(), attempts = attempts + 1, updated_at = now() where id = r.id;
    v_out := v_out || jsonb_build_array(jsonb_build_object(
      'id', r.id, 'to', r.recipient, 'kind', r.kind, 'name', r.name, 'quote_id', r.quote_id,
      'studio', (select o.name from public.organizations o where o.id = r.org_id),
      'event', v_ev ->> 'event', 'event_date', v_ev ->> 'date', 'venue', v_ev ->> 'venue',
      'tasks', v_tasks,
      'task', case when t.id is not null then left(t.title, 160) end,
      'worker', case when t.id is not null then left(coalesce(t.assignee_name, ''), 80) end,
      'start', case when t.id is not null then public._r338_time(t.planned_start, r.org_id) end,
      'day', case when t.id is not null then public._r338_day(t.planned_start, r.org_id) end,
      'minutes', case when t.planned_start is not null then greatest(0, ceil(extract(epoch from (t.planned_start - now())) / 60))::integer end,
      'link_path', v_link,
      'identity', coalesce(v_ident, '{}'::jsonb)));
  end loop;
  return v_out;
end $fn$;

create or replace function public.staff_email_mark(p_id uuid, p_status text)
returns text language plpgsql volatile security definer set search_path = '' as $fn$
-- r170-0361
begin
  if p_status not in ('sent', 'skipped', 'failed', 'retry') then raise exception 'bad status' using errcode = '22023'; end if;
  if p_status = 'retry' then
    update public.staff_email_outbox set claimed_at = null, updated_at = now() where id = p_id and sent_at is null;
    return 'pending';
  end if;
  update public.staff_email_outbox set status = p_status, sent_at = now(), updated_at = now() where id = p_id and sent_at is null;
  return p_status;
end $fn$;

-- ---- 8) Settings -> Automations: the switch "E-mail staff their tasks" (key staff_email) ------------------------------
do $$
declare v_src text;
begin
  select p.prosrc into v_src from pg_proc p where p.oid = to_regprocedure('public.automation_overview()');
  if position('r170-0361' in coalesce(v_src, '')) = 0 and to_regprocedure('public.automation_overview__pre0361()') is null then
    alter function public.automation_overview() rename to automation_overview__pre0361;
  end if;
  select p.prosrc into v_src from pg_proc p where p.oid = to_regprocedure('public.automation_switch(text,boolean)');
  if position('r170-0361' in coalesce(v_src, '')) = 0 and to_regprocedure('public.automation_switch__pre0361(text,boolean)') is null then
    alter function public.automation_switch(text, boolean) rename to automation_switch__pre0361;
  end if;
  if to_regprocedure('public.automation_overview__pre0361()') is null or to_regprocedure('public.automation_switch__pre0361(text,boolean)') is null then
    raise exception 'STOP 0361: the automation functions could not be kept as *__pre0361'; end if;
end $$;

create or replace function public.automation_overview()
returns jsonb language plpgsql stable security definer set search_path = '' as $fn$
-- r170-0361: the 0274 overview + the staff e-mail switch (staff_email)
declare v jsonb := public.automation_overview__pre0361();
begin
  return jsonb_set(v, '{on,staff_email}', to_jsonb(public._r361_on(public.current_org_id())), true);
end $fn$;

create or replace function public.automation_switch(p_key text, p_on boolean)
returns jsonb language plpgsql volatile security definer set search_path = '' as $fn$
-- r170-0361: staff_email is written here; every other key goes to the 0274 body unchanged
declare v_org uuid := public.current_org_id(); v_me uuid := auth.uid(); v_old boolean;
begin
  if p_key is distinct from 'staff_email' then return public.automation_switch__pre0361(p_key, p_on); end if;
  if v_me is null or v_org is null or coalesce(public.user_role(), '') = 'client' or not public.has_area('controls', 'edit') then
    raise exception 'Only a studio admin (or someone allowed to edit Settings) can switch automations on or off.' using errcode = '42501'; end if;
  if coalesce(public._trial_locked(v_org), false) then raise exception 'This studio is read-only' using errcode = '25006'; end if;
  if p_on is null then raise exception 'Choose on or off.' using errcode = '22023'; end if;
  v_old := public._r361_on(v_org);
  insert into public.automation_settings(org_id, updated_by) values (v_org, v_me) on conflict (org_id) do nothing;
  update public.automation_settings set staff_email_enabled = p_on, updated_at = now(), updated_by = v_me where org_id = v_org;
  -- switched off: the automatic e-mails still waiting are not sent
  if not p_on then
    update public.staff_email_outbox set status = 'skipped', reason = 'switched_off', sent_at = now(), updated_at = now()
     where org_id = v_org and status = 'pending' and sent_at is null and claimed_at is null
       and kind in ('task_assigned', 'task_reminder', 'task_late', 'office_alert');
  end if;
  begin
    insert into public.audit_log(actor, action, entity, entity_id, changed, org_id)
      values (v_me, 'automation.switch', 'automation', p_key, jsonb_build_object('key', p_key, 'from', v_old, 'to', p_on), v_org);
  exception when others then raise warning 'r170-0361: audit skipped (%)', sqlstate;
  end;
  return public.automation_overview();
end $fn$;

-- ---- 9) grants: buttons for signed-in staff; queue functions for the server only ---------------------------------------
do $$
declare f text;
begin
  foreach f in array array['public._r361_email(text)', 'public._r361_on(uuid)', 'public._r361_person(uuid,uuid,text)',
                           'public._r361_manager(uuid,uuid)', 'public._r361_live(uuid,uuid)', 'public._r361_mine(public.event_tasks,uuid,text)',
                           'public._r361_tg_task_assigned()', 'public._r361_tg_reminder()',
                           'public.staff_email_claim(integer)', 'public.staff_email_mark(uuid,text)',
                           'public.staff_email_send(uuid,boolean)', 'public.staff_email_hold(uuid,uuid)',
                           'public.automation_overview()', 'public.automation_switch(text,boolean)',
                           'public.automation_overview__pre0361()', 'public.automation_switch__pre0361(text,boolean)'] loop
    execute format('revoke all on function %s from public', f);
    if exists (select 1 from pg_roles where rolname = 'anon') then execute format('revoke all on function %s from anon', f); end if;
    if exists (select 1 from pg_roles where rolname = 'authenticated') then execute format('revoke all on function %s from authenticated', f); end if;
    if exists (select 1 from pg_roles where rolname = 'service_role') then execute format('grant execute on function %s to service_role', f); end if;
  end loop;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    execute 'grant execute on function public.staff_email_send(uuid,boolean) to authenticated';
    execute 'grant execute on function public.staff_email_hold(uuid,uuid) to authenticated';
    execute 'grant execute on function public.automation_overview() to authenticated';
    execute 'grant execute on function public.automation_switch(text,boolean) to authenticated';
  end if;
end $$;

-- VERIFY every line should say true
select item, ok from (values
  ('01 staff e-mail queue table', to_regclass('public.staff_email_outbox') is not null),
  ('02 studio switch column (default on)', exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'automation_settings' and column_name = 'staff_email_enabled')),
  ('03 task e-mail trigger', exists (select 1 from pg_trigger where tgrelid = to_regclass('public.event_tasks') and tgname = 'zzz_r361_task_email')),
  ('04 reminder e-mail trigger', exists (select 1 from pg_trigger where tgrelid = to_regclass('public.task_wa_outbox') and tgname = 'zzz_r361_reminder_email')),
  ('05 queue closed to the app', not has_table_privilege('authenticated', 'public.staff_email_outbox', 'select') and not has_table_privilege('anon', 'public.staff_email_outbox', 'select')),
  ('06 send buttons for signed-in staff only', has_function_privilege('authenticated', 'public.staff_email_send(uuid,boolean)', 'execute') and not has_function_privilege('anon', 'public.staff_email_send(uuid,boolean)', 'execute')),
  ('07 claim / mark server only', not has_function_privilege('authenticated', 'public.staff_email_claim(integer)', 'execute') and not has_function_privilege('authenticated', 'public.staff_email_mark(uuid,text)', 'execute')),
  ('08 kept automation bodies closed', not has_function_privilege('authenticated', 'public.automation_switch__pre0361(text,boolean)', 'execute') and not has_function_privilege('authenticated', 'public.automation_overview__pre0361()', 'execute')),
  ('10 free-trial purge knows the new queue (or 0184 is absent)', to_regprocedure('public._tr184_purge_tables()') is null or position('staff_email_outbox' in pg_get_functiondef(to_regprocedure('public._tr184_purge_tables()'))) > 0),
  ('09 automation functions still open to signed-in staff', has_function_privilege('authenticated', 'public.automation_overview()', 'execute') and has_function_privilege('authenticated', 'public.automation_switch(text,boolean)', 'execute'))
) v(item, ok) order by item;
