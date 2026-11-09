-- 0338_r130_task_reminders.sql - CANONICAL forward-only. R130 (owner, 9 Nov 2026: "work on templates and their working",
-- U-31 / U-03 / U-04 / U-32 / U-05 / U-02 / U-18 of updates/UPDATES-TASKS-STAFF-RESOURCES.md).
-- REQUIRES 0132 (assign_notify_outbox), 0265 (open_shifts, _r23_tz, _r23_notify), 0337 (_r337_wa_ready),
--          0179 (trial_send_blocked), base event_tasks / work_tokens / crew_members / quotes.
--
-- In plain words:
--   1  Studio reminder settings (Settings -> Notifications -> Task reminders): on/off, the default "before" times
--      (owner: 10 and 5 minutes, custom allowed), late reminders (owner: every 15 minutes, up to 3 times), then tell the
--      office, and "hold a waiting task's reminders until the earlier task is done" (default ON; the final rule is a
--      question for the boss - 11-09-2026-questions.docx).
--   2  Each task can have its own "before" times (event_tasks.remind_before). Empty = the studio default.
--   3  task_reminder_tick(): run every minute by pg_cron. For each scheduled task that has not started, it queues ONE
--      WhatsApp per reminder time, to the person on the task, in the studio's time zone. If several times are already due
--      (e.g. the task was scheduled late, or was held), only the latest goes and the older ones are marked "skipped".
--      After the start time it queues the late reminders, then an office alert (bell + WhatsApp to the event manager).
--      A changed time or a changed person starts a fresh set; done / cancelled / started tasks get nothing more.
--   4  task_wa_outbox: every reminder / late / office message with its fixed template + fields and its status
--      (queued, sent, delivered, read, failed, skipped, not set up). Server only; the page reads a summary.
--   5  assign_notify_outbox (task assigned, open shift, run-sheet reminder) gets its own template + fields filled on
--      insert, and the WhatsApp message id + delivery status, so each send shows Queued / Sent / Delivered / Failed.
--   6  Meta's delivery ticks (wa-webhook -> integration_webhook_events) move both queues' status forward.
--   7  task_wa_status(quote): the Live Status page's WhatsApp line per task (members with Staff view, own studio only).
--
-- ZERO DATA LOSS: additive + idempotent. New tables, new nullable columns, new functions, one new trigger on
-- assign_notify_outbox (fills two new columns only) and one on integration_webhook_events (updates the new status
-- columns only). Nothing dropped, nothing deleted. The pg_cron job is created only when pg_cron exists. Safe to run twice.

-- ---- 0) preflight ---------------------------------------------------------------------------------------------------
do $$
begin
  if to_regclass('public.event_tasks') is null or to_regclass('public.assign_notify_outbox') is null or to_regclass('public.work_tokens') is null then
    raise exception 'STOP 0338: event_tasks / assign_notify_outbox / work_tokens missing (0132)'; end if;
  if to_regclass('public.open_shifts') is null or to_regprocedure('public._r23_tz(uuid)') is null or to_regprocedure('public._r23_notify(uuid,text,jsonb)') is null then
    raise exception 'STOP 0338: run 0265 (crew availability / open shifts) first'; end if;
  if to_regprocedure('public._r337_wa_ready(uuid)') is null then
    raise exception 'STOP 0338: run 0337 (studio WhatsApp) first'; end if;
  if to_regprocedure('public.trial_send_blocked(uuid,uuid,uuid)') is null then
    raise exception 'STOP 0338: trial_send_blocked missing (0179)'; end if;
end $$;

-- ---- 1) studio settings ------------------------------------------------------------------------------------------------
create table if not exists public.task_reminder_settings (
  org_id          uuid primary key references public.organizations(id),
  enabled         boolean not null default true,
  default_before  integer[] not null default '{10,5}',
  late_every_min  integer not null default 15,
  late_max        integer not null default 3,
  alert_office    boolean not null default true,
  hold_waiting    boolean not null default true,
  updated_at      timestamptz not null default now(),
  updated_by      uuid,
  constraint task_reminder_settings_before_chk338 check (cardinality(default_before) <= 8 and 0 <= all(default_before) and 1440 >= all(default_before)),
  constraint task_reminder_settings_late_chk338 check (late_every_min between 5 and 120 and late_max between 0 and 10)
);
alter table public.task_reminder_settings enable row level security;
revoke all on table public.task_reminder_settings from public;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'anon') then execute 'revoke all on table public.task_reminder_settings from anon'; end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then execute 'revoke all on table public.task_reminder_settings from authenticated'; end if;
  if exists (select 1 from pg_roles where rolname = 'service_role') then execute 'grant select on table public.task_reminder_settings to service_role'; end if;
end $$;

-- ---- 2) per-task "before" times --------------------------------------------------------------------------------------------
alter table public.event_tasks add column if not exists remind_before integer[];
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'event_tasks_remind_before_chk338') then
    alter table public.event_tasks add constraint event_tasks_remind_before_chk338
      check (remind_before is null or (cardinality(remind_before) <= 8 and 0 <= all(remind_before) and 1440 >= all(remind_before)));
  end if;
end $$;

-- ---- 3) the reminder / late / office queue -----------------------------------------------------------------------------------
create table if not exists public.task_wa_outbox (
  id          uuid primary key default gen_random_uuid(),
  org_id      uuid not null references public.organizations(id),
  quote_id    uuid not null,
  task_id     uuid not null,
  kind        text not null,
  slot        text not null,
  slot_key    text not null,
  phone       text,
  name        text,
  template    text not null,
  params      jsonb not null default '[]'::jsonb,
  link_path   text,
  status      text not null default 'queued',
  reason      text,
  wamid       text,
  attempts    integer not null default 0,
  due_at      timestamptz not null default now(),
  claimed_at  timestamptz,
  sent_at     timestamptz,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  constraint task_wa_outbox_kind_chk338 check (kind in ('reminder', 'late', 'office_alert')),
  constraint task_wa_outbox_status_chk338 check (status in ('queued', 'sent', 'delivered', 'read', 'failed', 'skipped', 'not_set_up')),
  constraint task_wa_outbox_template_chk338 check (template ~ '^[a-z0-9_]{1,64}$'),
  constraint task_wa_outbox_params_chk338 check (jsonb_typeof(params) = 'array' and jsonb_array_length(params) <= 12),
  constraint task_wa_outbox_phone_chk338 check (phone is null or phone ~ '^[0-9]{8,15}$'),
  constraint task_wa_outbox_link_chk338 check (link_path is null or link_path ~ '^(work\.html\?token=[0-9a-f-]{36}|ops\.html\?quote=[0-9a-f-]{36})$')
);
create unique index if not exists task_wa_outbox_slot_uk338 on public.task_wa_outbox (slot_key);
create index if not exists task_wa_outbox_queued338 on public.task_wa_outbox (created_at) where status = 'queued';
create index if not exists task_wa_outbox_task338 on public.task_wa_outbox (task_id, created_at desc);
create index if not exists task_wa_outbox_wamid338 on public.task_wa_outbox (wamid) where wamid is not null;
-- G4: the event must belong to the same studio (the shared quote <-> org guard every such table carries)
do $$ begin
  if to_regprocedure('public.tg_quote_org_match()') is not null then
    execute 'drop trigger if exists zz_quote_org_match on public.task_wa_outbox';
    execute 'create trigger zz_quote_org_match before insert or update on public.task_wa_outbox for each row execute function public.tg_quote_org_match()';
  end if;
end $$;
alter table public.task_wa_outbox enable row level security;
revoke all on table public.task_wa_outbox from public;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'anon') then execute 'revoke all on table public.task_wa_outbox from anon'; end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then execute 'revoke all on table public.task_wa_outbox from authenticated'; end if;
  if exists (select 1 from pg_roles where rolname = 'service_role') then execute 'grant select on table public.task_wa_outbox to service_role'; end if;
end $$;

-- ---- 4) assign_notify_outbox: template + fields + delivery status (new nullable columns) ---------------------------------------
alter table public.assign_notify_outbox add column if not exists template text;
alter table public.assign_notify_outbox add column if not exists params jsonb;
alter table public.assign_notify_outbox add column if not exists wamid text;
alter table public.assign_notify_outbox add column if not exists wa_status text;
create index if not exists assign_notify_outbox_wamid338 on public.assign_notify_outbox (wamid) where wamid is not null;

-- 0045 read-only guard (a suspended / ended-trial studio takes no new rows from its people; the server's own job passes)
-- and trial retention (0184): the queue is purged with the studio's events, the settings are kept like comms_settings
do $$ declare t text; v_def text; begin
  if to_regprocedure('public.tg_studio_read_only()') is not null then
    foreach t in array array['task_reminder_settings', 'task_wa_outbox'] loop
      if not exists (select 1 from pg_catalog.pg_trigger where tgname = 'zzz_studio_read_only' and tgrelid = ('public.' || t)::regclass) then
        execute format('create trigger zzz_studio_read_only before insert or update or delete on public.%I for each row execute function public.tg_studio_read_only(''org_id'')', t);
      end if;
    end loop;
  end if;
  if to_regprocedure('public._tr184_purge_tables()') is not null then
    v_def := pg_get_functiondef('public._tr184_purge_tables()'::regprocedure);
    if position('''task_wa_outbox''' in v_def) = 0 then
      if (length(v_def) - length(replace(v_def, '''comms_outbox'', ''assign_notify_outbox''', ''))) / length('''comms_outbox'', ''assign_notify_outbox''') <> 1 then
        raise notice '0338: _tr184_purge_tables has an unexpected body - left unchanged';
      else execute replace(v_def, '''comms_outbox'', ''assign_notify_outbox''', '''comms_outbox'', ''task_wa_outbox'', ''assign_notify_outbox'''); end if;
    end if;
  end if;
  if to_regprocedure('public._tr184_keep_tables()') is not null then
    v_def := pg_get_functiondef('public._tr184_keep_tables()'::regprocedure);
    if position('''task_reminder_settings''' in v_def) = 0 then
      if (length(v_def) - length(replace(v_def, '''comms_settings'', ''studio_send_windows''', ''))) / length('''comms_settings'', ''studio_send_windows''') <> 1 then
        raise notice '0338: _tr184_keep_tables has an unexpected body - left unchanged';
      else execute replace(v_def, '''comms_settings'', ''studio_send_windows''', '''comms_settings'', ''task_reminder_settings'', ''studio_send_windows'''); end if;
    end if;
  end if;
end $$;

-- ---- 5) helpers ------------------------------------------------------------------------------------------------------------
-- one template field: one line, no control characters, never empty (Meta refuses an empty field)
create or replace function public._r338_f(p text, p_max integer default 120)
returns text language sql immutable set search_path = '' as $$
  select coalesce(nullif(btrim(left(regexp_replace(regexp_replace(coalesce(p, ''), '[[:cntrl:]]+', ' ', 'g'), ' {2,}', ' ', 'g'), p_max)), ''), '-');
$$;

-- the studio's settings (defaults when it never saved any)
create or replace function public._r338_cfg(p_org uuid)
returns jsonb language sql stable security definer set search_path = '' as $$
  -- r130-0338
  select coalesce((select jsonb_build_object('enabled', s.enabled, 'default_before', to_jsonb(s.default_before), 'late_every_min', s.late_every_min,
                     'late_max', s.late_max, 'alert_office', s.alert_office, 'hold_waiting', s.hold_waiting, 'saved', true)
                     from public.task_reminder_settings s where s.org_id = p_org),
                  jsonb_build_object('enabled', true, 'default_before', '[10,5]'::jsonb, 'late_every_min', 15, 'late_max', 3,
                     'alert_office', true, 'hold_waiting', true, 'saved', false));
$$;

-- "28 Nov 2026" / "12:30 PM" in the studio's time zone
create or replace function public._r338_day(p_at timestamptz, p_org uuid)
returns text language sql stable security definer set search_path = '' as $$
  select case when p_at is null then null else to_char(p_at at time zone public._r23_tz(p_org), 'FMDD Mon YYYY') end;
$$;
create or replace function public._r338_time(p_at timestamptz, p_org uuid)
returns text language sql stable security definer set search_path = '' as $$
  select case when p_at is null then null else to_char(p_at at time zone public._r23_tz(p_org), 'FMHH12:MI AM') end;
$$;

-- an event's name and venue (venue: the event plan, else the client's venue)
create or replace function public._r338_event(p_quote uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
-- r130-0338
declare v_title text; v_code text; v_date date; v_time text; v_venue text; v_client jsonb;
begin
  select q.title, q.code, q.event_date, q.event_time, q.client into v_title, v_code, v_date, v_time, v_client from public.quotes q where q.id = p_quote;
  if to_regclass('public.event_plan') is not null then
    begin execute 'select nullif(btrim(p.venue_name), '''') from public.event_plan p where p.quote_id = $1 limit 1' into v_venue using p_quote;
    exception when others then v_venue := null; end;
  end if;
  v_venue := coalesce(v_venue, nullif(btrim(coalesce(v_client ->> 'venue', '')), ''));
  return jsonb_build_object('event', coalesce(nullif(btrim(coalesce(v_title, '')), ''), v_code), 'date', case when v_date is null then null else to_char(v_date, 'FMDD Mon YYYY') end,
    'time', nullif(btrim(coalesce(v_time, '')), ''), 'venue', v_venue);
end $$;

-- the person's live work link for this event (never creates or re-opens one)
create or replace function public._r338_link(p_quote uuid, p_org uuid, p_phone text)
returns text language plpgsql stable security definer set search_path = '' as $$
-- r130-0338
declare v uuid;
begin
  if p_phone is null then return null; end if;
  begin
    execute 'select wt.token from public.work_tokens wt where wt.quote_id = $1 and wt.org_id = $2 and public._assign132_phone(wt.phone) = $3
               and (wt.revoked_at is null) and (wt.expires_at is null or wt.expires_at > now()) order by wt.created_at desc limit 1'
      into v using p_quote, p_org, p_phone;
  exception when undefined_column then
    select wt.token into v from public.work_tokens wt where wt.quote_id = p_quote and wt.org_id = p_org and public._assign132_phone(wt.phone) = p_phone
     order by wt.created_at desc limit 1;
  end;
  return case when v is null then null else 'work.html?token=' || v::text end;
end $$;

-- ---- 6) settings RPCs (Settings page) ---------------------------------------------------------------------------------------
create or replace function public.task_reminder_settings_get()
returns jsonb language plpgsql stable security definer set search_path = '' as $$
-- r130-0338: members who can open Staff or Settings
declare v_org uuid := public.current_org_id();
begin
  if auth.uid() is null or v_org is null or not (coalesce(public.has_area('staff', 'view'), false) or coalesce(public.has_area('controls', 'view'), false)) then
    raise exception 'not authorized' using errcode = '42501'; end if;
  return public._r338_cfg(v_org) || jsonb_build_object('can_edit', coalesce(public.has_area('controls', 'edit'), false), 'wa_ready', public._r337_wa_ready(v_org));
end $$;

create or replace function public.task_reminder_settings_set(p jsonb)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
-- r130-0338: Settings edit only; validated here (the table checks again)
declare v_org uuid := public.current_org_id(); c jsonb; v_before integer[]; v_every integer; v_max integer;
begin
  if auth.uid() is null or v_org is null or not coalesce(public.has_area('controls', 'edit'), false) then
    raise exception 'not authorized' using errcode = '42501'; end if;
  if p is null or jsonb_typeof(p) <> 'object' then raise exception 'invalid_settings' using errcode = '22023'; end if;
  c := public._r338_cfg(v_org);
  if p ? 'default_before' then
    if jsonb_typeof(p -> 'default_before') <> 'array' or jsonb_array_length(p -> 'default_before') > 8 then raise exception 'invalid_before' using errcode = '22023'; end if;
    if exists (select 1 from jsonb_array_elements_text(p -> 'default_before') x where x !~ '^[0-9]{1,4}$' or x::integer > 1440) then
      raise exception 'invalid_before' using errcode = '22023'; end if;
    select coalesce(array_agg(distinct x::integer order by x::integer desc), '{}') into v_before from jsonb_array_elements_text(p -> 'default_before') x;
  else
    select coalesce(array_agg(x::integer order by x::integer desc), '{}') into v_before from jsonb_array_elements_text(c -> 'default_before') x;
  end if;
  v_every := coalesce(case when (p ->> 'late_every_min') ~ '^[0-9]{1,3}$' then (p ->> 'late_every_min')::integer end, (c ->> 'late_every_min')::integer);
  v_max := coalesce(case when (p ->> 'late_max') ~ '^[0-9]{1,2}$' then (p ->> 'late_max')::integer end, (c ->> 'late_max')::integer);
  if v_every not between 5 and 120 then raise exception 'invalid_late_every' using errcode = '22023'; end if;
  if v_max not between 0 and 10 then raise exception 'invalid_late_max' using errcode = '22023'; end if;
  insert into public.task_reminder_settings as s (org_id, enabled, default_before, late_every_min, late_max, alert_office, hold_waiting, updated_at, updated_by)
  values (v_org,
          coalesce((p ->> 'enabled')::boolean, (c ->> 'enabled')::boolean), v_before, v_every, v_max,
          coalesce((p ->> 'alert_office')::boolean, (c ->> 'alert_office')::boolean),
          coalesce((p ->> 'hold_waiting')::boolean, (c ->> 'hold_waiting')::boolean), now(), auth.uid())
  on conflict (org_id) do update set enabled = excluded.enabled, default_before = excluded.default_before, late_every_min = excluded.late_every_min,
    late_max = excluded.late_max, alert_office = excluded.alert_office, hold_waiting = excluded.hold_waiting, updated_at = now(), updated_by = auth.uid();
  return public.task_reminder_settings_get();
end $$;

-- the Schedule task popup: this task's "before" times (null / [] = the studio default). Staff edit, own studio.
create or replace function public.set_task_reminders(p_task uuid, p_before integer[])
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
-- r130-0338
declare v_org uuid := public.current_org_id(); v integer[]; n integer;
begin
  if auth.uid() is null or v_org is null or not coalesce(public.has_area('staff', 'edit'), false) then
    raise exception 'not authorized' using errcode = '42501'; end if;
  if p_before is not null and (cardinality(p_before) > 8 or exists (select 1 from unnest(p_before) x where x is null or x < 0 or x > 1440)) then
    raise exception 'invalid_before' using errcode = '22023'; end if;
  select case when p_before is null or cardinality(p_before) = 0 then null else array_agg(distinct x order by x desc) end into v
    from unnest(coalesce(p_before, '{}'::integer[])) x;
  update public.event_tasks set remind_before = v where id = p_task and org_id = v_org;
  get diagnostics n = row_count;
  if n = 0 then raise exception 'not found' using errcode = 'P0002'; end if;
  return jsonb_build_object('ok', true, 'remind_before', to_jsonb(v));
end $$;

-- ---- 7) THE every-minute job ---------------------------------------------------------------------------------------------------
-- queue one row (once per slot key); -> true when this call queued it
create or replace function public._r338_queue(t public.event_tasks, p_org uuid, p_kind text, p_slot text, p_key text, p_phone text, p_name text,
  p_template text, p_params jsonb, p_link text, p_due timestamptz, p_status text default 'queued', p_reason text default null)
returns boolean language plpgsql volatile security definer set search_path = '' as $$
-- r130-0338
declare v uuid;
begin
  insert into public.task_wa_outbox (org_id, quote_id, task_id, kind, slot, slot_key, phone, name, template, params, link_path, status, reason, due_at, sent_at)
  values (p_org, t.quote_id, t.id, p_kind, p_slot, p_key, p_phone, left(p_name, 120), p_template, p_params, p_link, p_status, p_reason, p_due,
          case when p_status = 'queued' then null else now() end)
  on conflict (slot_key) do nothing returning id into v;
  return v is not null;
end $$;

create or replace function public.task_reminder_tick(p_now timestamptz default null)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
-- r130-0338: pg_cron every minute. Queues; comms-dispatch sends (from the studio's own number only).
-- p_now: tests only (server-only function); null = v_now.
declare r record; c jsonb; v_phone text; v_base text; v_ev jsonb; v_link text; v_name text; v_task text; v_when text;
        v_mins integer[]; m integer; k integer; v_every integer; v_max integer; v_at timestamptz; v_best text; v_best_at timestamptz;
        v_dep public.event_tasks; v_now timestamptz := coalesce(p_now, now()); v_n integer := 0; v_skip integer := 0; v_mgr text; v_mgr_name text; slots jsonb;
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
      if v_phone is null then continue; end if;
      -- waiting on an unfinished earlier task: hold (studio setting; boss question pending)
      if (r.t).depends_on is not null and coalesce((c ->> 'hold_waiting')::boolean, true) then
        select * into v_dep from public.event_tasks d where d.id = (r.t).depends_on;
        if found and v_dep.status is distinct from 'completed' and v_dep.status is distinct from 'cancelled' then continue; end if;
      end if;
      v_base := (r.t).id::text || '|' || extract(epoch from (r.t).planned_start)::bigint::text || '|' || v_phone || '|';
      v_ev := public._r338_event((r.t).quote_id);
      v_link := public._r338_link((r.t).quote_id, r.org_id, v_phone);
      v_name := public._r338_f(split_part(btrim(coalesce((r.t).assignee_name, '')), ' ', 1), 60);
      v_task := public._r338_f((r.t).title, 100);
      v_when := public._r338_time((r.t).planned_start, r.org_id);
      v_every := greatest(5, coalesce((c ->> 'late_every_min')::integer, 15));
      v_max := greatest(0, coalesce((c ->> 'late_max')::integer, 3));

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
             jsonb_build_array(v_name, v_task, public._r338_f(v_ev ->> 'event', 100), public._r338_f(v_when, 20),
               greatest(0, ceil(extract(epoch from ((r.t).planned_start - v_now)) / 60))::integer::text, '@link'), v_link, v_best_at) then
          v_n := v_n + 1;
        end if;
      end if;

      -- (b) late: not started after the start time -> every N minutes, up to M times (latest due only).
      --     Only inside the late window (a task that was already long overdue when this switched on gets nothing).
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
           jsonb_build_array(v_name, v_task, public._r338_f(v_ev ->> 'event', 100), public._r338_f(v_when, 20), '@link'), v_link, v_best_at) then
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
      raise warning 'r130-0338: task % reminder skipped (%)', (r.t).id, sqlstate;
    end;
  end loop;
  return jsonb_build_object('queued', v_n, 'skipped', v_skip);
end $$;

-- ---- 8) the sender's side (service role): claim + mark ---------------------------------------------------------------------
create or replace function public.task_wa_claim(p_limit integer default 25)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
-- r130-0338: rows re-checked at claim time - the task must still be waiting for this person at this time
declare o record; v_out jsonb := '[]'::jsonb; t public.event_tasks; v_ok boolean;
begin
  update public.task_wa_outbox set status = 'failed', reason = 'too_many_attempts', sent_at = now(), updated_at = now() where status = 'queued' and attempts >= 5;
  update public.task_wa_outbox set status = 'skipped', reason = 'too_old', sent_at = now(), updated_at = now() where status = 'queued' and created_at < now() - interval '2 hours';
  for o in select * from public.task_wa_outbox x
     where x.status = 'queued' and (x.claimed_at is null or x.claimed_at < now() - interval '5 minutes')
     order by x.due_at limit greatest(1, least(coalesce(p_limit, 25), 100)) for update skip locked
  loop
    select * into t from public.event_tasks where id = o.task_id;
    v_ok := found and o.phone is not null;
    if v_ok and o.kind in ('reminder', 'late') then
      v_ok := t.status in ('assigned', 'accepted') and public._assign132_phone(t.assignee_phone) = o.phone
              and o.slot_key like t.id::text || '|' || extract(epoch from t.planned_start)::bigint::text || '|%';
    elsif v_ok and o.kind = 'office_alert' then
      v_ok := t.status in ('assigned', 'accepted');
    end if;
    if not coalesce(v_ok, false) then
      update public.task_wa_outbox set status = 'skipped', reason = 'task_changed', sent_at = now(), updated_at = now() where id = o.id;
      continue;
    end if;
    if exists (select 1 from public.whatsapp_opt_outs x where x.phone = o.phone and x.opted_out and (x.org_id is null or x.org_id = o.org_id)) then
      update public.task_wa_outbox set status = 'skipped', reason = 'opted_out', sent_at = now(), updated_at = now() where id = o.id;
      continue;
    end if;
    update public.task_wa_outbox set claimed_at = now(), attempts = attempts + 1, updated_at = now() where id = o.id;
    v_out := v_out || jsonb_build_array(jsonb_build_object('id', o.id, 'org_id', o.org_id, 'to', o.phone, 'template', o.template,
      'params', o.params, 'link_path', o.link_path, 'kind', o.kind));
  end loop;
  return v_out;
end $$;

create or replace function public.task_wa_mark(p_id uuid, p_status text, p_wamid text default null, p_reason text default null)
returns void language plpgsql volatile security definer set search_path = '' as $$
-- r130-0338: sent / failed / not_set_up / skipped / retry (back to queued)
begin
  if p_status = 'retry' then
    update public.task_wa_outbox set status = 'queued', claimed_at = null, reason = left(p_reason, 80), updated_at = now() where id = p_id and status = 'queued';
    return; end if;
  if p_status not in ('sent', 'failed', 'skipped', 'not_set_up') then raise exception 'invalid_status' using errcode = '22023'; end if;
  update public.task_wa_outbox set status = p_status, wamid = case when p_wamid ~ '^[A-Za-z0-9_.:=+/-]{1,160}$' then p_wamid end,
         reason = left(p_reason, 80), sent_at = now(), updated_at = now()
   where id = p_id and status = 'queued';
end $$;

-- assign_notify_outbox: the WhatsApp message id after a send (status words come from Meta's ticks)
create or replace function public.assign_notify_wamid(p_id uuid, p_wamid text, p_status text default 'sent')
returns void language plpgsql volatile security definer set search_path = '' as $$
-- r130-0338
begin
  if p_status not in ('sent', 'failed', 'not_set_up') then raise exception 'invalid_status' using errcode = '22023'; end if;
  update public.assign_notify_outbox set wamid = case when p_wamid ~ '^[A-Za-z0-9_.:=+/-]{1,160}$' then p_wamid end, wa_status = p_status
   where id = p_id;
end $$;

-- ---- 9) fields for task assigned / open shift / run-sheet reminder (filled on insert; the old text body is kept) -------------
create or replace function public.tg_r338_assign_fields()
returns trigger language plpgsql security definer set search_path = '' as $$
-- r130-0338: never blocks the insert - any problem leaves template null (the sender then uses the one-box notice)
declare v_ev jsonb; t public.event_tasks; s public.open_shifts; v_title text; v_start time; v_name text;
begin
  begin
    v_ev := public._r338_event(new.quote_id);
    v_name := public._r338_f(split_part(btrim(coalesce(new.name, '')), ' ', 1), 60);
    if new.item_kind = 'task' then
      select * into t from public.event_tasks where id = new.item_id;
      if found then
        new.template := 'staff_task_assigned';
        new.params := jsonb_build_array(v_name, public._r338_f(t.title, 100), public._r338_f(v_ev ->> 'event', 100),
          public._r338_f(coalesce(public._r338_day(t.planned_start, new.org_id), v_ev ->> 'date', 'date to be confirmed'), 30),
          public._r338_f(coalesce(public._r338_time(t.planned_start, new.org_id), v_ev ->> 'time', 'time to be confirmed'), 30),
          public._r338_f(coalesce(v_ev ->> 'venue', 'venue to be confirmed'), 120), '@link');
      end if;
    elsif new.item_kind = 'open_shift' then
      select * into s from public.open_shifts where id = new.item_id;
      if found then
        new.template := 'staff_open_shift';
        new.params := jsonb_build_array(v_name, public._r338_f(coalesce(s.department, s.title), 60), public._r338_f(v_ev ->> 'event', 100),
          to_char(s.shift_date, 'FMDD Mon YYYY'), public._r338_f(to_char(s.start_time, 'FMHH12:MI AM'), 20), public._r338_f(to_char(s.end_time, 'FMHH12:MI AM'), 20),
          public._r338_f(coalesce(v_ev ->> 'venue', 'venue to be confirmed'), 120), '@link');
      end if;
    elsif new.item_kind = 'runsheet' then
      execute 'select i.title, i.start_time from public.run_sheet_items i where i.id = $1' into v_title, v_start using new.item_id;
      if v_title is not null then
        new.template := 'crew_runsheet_reminder';
        new.params := jsonb_build_array(v_name, public._r338_f(to_char(v_start, 'FMHH12:MI AM'), 20), public._r338_f(v_ev ->> 'event', 100),
          public._r338_f(v_title, 100), '@link');
      end if;
    end if;
  exception when others then
    new.template := null; new.params := null;
  end;
  return new;
end $$;
drop trigger if exists zz_r338_assign_fields on public.assign_notify_outbox;
create trigger zz_r338_assign_fields before insert on public.assign_notify_outbox
  for each row execute function public.tg_r338_assign_fields();

-- ---- 10) Meta's ticks move the status forward (sent -> delivered -> read; failed wins) -------------------------------------
create or replace function public._r338_rank(p text)
returns integer language sql immutable set search_path = '' as $$
  select case p when 'sent' then 1 when 'delivered' then 2 when 'read' then 3 when 'failed' then 9 else 0 end;
$$;
create or replace function public.tg_r338_wa_tick()
returns trigger language plpgsql security definer set search_path = '' as $$
-- r130-0338: never blocks the webhook row
declare v_st text := lower(coalesce(new.status, ''));
begin
  if new.provider = 'whatsapp' and new.event_type = 'message_status' and new.ref is not null and v_st in ('sent', 'delivered', 'read', 'failed') then
    begin
      update public.task_wa_outbox set status = v_st, updated_at = now()
       where wamid = new.ref and status in ('sent', 'delivered', 'read') and public._r338_rank(v_st) > public._r338_rank(status);
      update public.assign_notify_outbox set wa_status = v_st
       where wamid = new.ref and public._r338_rank(v_st) > public._r338_rank(coalesce(wa_status, ''));
    exception when others then null;
    end;
  end if;
  return new;
end $$;
do $$ begin
  if to_regclass('public.integration_webhook_events') is not null then
    execute 'drop trigger if exists zz_r338_wa_tick on public.integration_webhook_events';
    execute 'create trigger zz_r338_wa_tick after insert on public.integration_webhook_events for each row execute function public.tg_r338_wa_tick()';
  end if;
end $$;

-- ---- 11) Live Status: the latest WhatsApp per task (members with Staff view, own studio) ----------------------------------
create or replace function public.task_wa_status(p_quote uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
-- r130-0338: { wa_ready, settings, tasks: [{ task_id, what, status, reason, at }] } - never a phone number or a token
declare v_org uuid := public.current_org_id();
begin
  if auth.uid() is null or v_org is null or not coalesce(public.has_area('staff', 'view'), false) then
    raise exception 'not authorized' using errcode = '42501'; end if;
  if not exists (select 1 from public.quotes q where q.id = p_quote and q.org_id = v_org) then return jsonb_build_object('tasks', '[]'::jsonb); end if;
  return jsonb_build_object('wa_ready', public._r337_wa_ready(v_org), 'settings', public._r338_cfg(v_org), 'tasks', coalesce((
    select jsonb_agg(x.j) from (
      select distinct on (u.task_id) jsonb_build_object('task_id', u.task_id, 'what', u.what, 'status', u.status, 'reason', u.reason, 'at', u.at) as j
        from (
          select o.task_id, o.kind as what, o.status, o.reason, coalesce(o.sent_at, o.created_at) as at
            from public.task_wa_outbox o where o.quote_id = p_quote and o.org_id = v_org and o.kind <> 'office_alert' and o.reason is distinct from 'superseded'
          union all
          select a.item_id, 'assigned', case when a.wa_status in ('sent', 'delivered', 'read', 'failed', 'not_set_up') then a.wa_status
                                             when a.status = 'pending' then 'queued' when a.status = 'failed' then 'failed' else a.status end,
                 null, coalesce(a.sent_at, a.created_at)
            from public.assign_notify_outbox a where a.quote_id = p_quote and a.org_id = v_org and a.item_kind = 'task'
        ) u order by u.task_id, u.at desc) x), '[]'::jsonb));
end $$;

-- ---- 12) privileges ------------------------------------------------------------------------------------------------------------
do $$ declare f text; begin
  foreach f in array array['public._r338_f(text, integer)', 'public._r338_cfg(uuid)', 'public._r338_day(timestamp with time zone, uuid)',
                           'public._r338_time(timestamp with time zone, uuid)', 'public._r338_event(uuid)', 'public._r338_link(uuid, uuid, text)',
                           'public._r338_queue(public.event_tasks, uuid, text, text, text, text, text, text, jsonb, text, timestamp with time zone, text, text)',
                           'public.task_reminder_tick(timestamp with time zone)', 'public.task_wa_claim(integer)', 'public.task_wa_mark(uuid, text, text, text)',
                           'public.assign_notify_wamid(uuid, text, text)', 'public.tg_r338_assign_fields()', 'public._r338_rank(text)', 'public.tg_r338_wa_tick()',
                           'public.task_reminder_settings_get()', 'public.task_reminder_settings_set(jsonb)', 'public.set_task_reminders(uuid, integer[])',
                           'public.task_wa_status(uuid)'] loop
    execute 'revoke all on function ' || f || ' from public';
    if exists (select 1 from pg_roles where rolname = 'anon') then execute 'revoke all on function ' || f || ' from anon'; end if;
    if exists (select 1 from pg_roles where rolname = 'authenticated') then execute 'revoke all on function ' || f || ' from authenticated'; end if;
  end loop;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    foreach f in array array['public.task_reminder_settings_get()', 'public.task_reminder_settings_set(jsonb)', 'public.set_task_reminders(uuid, integer[])',
                             'public.task_wa_status(uuid)'] loop
      execute 'grant execute on function ' || f || ' to authenticated';
    end loop;
  end if;
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    foreach f in array array['public.task_reminder_tick(timestamp with time zone)', 'public.task_wa_claim(integer)', 'public.task_wa_mark(uuid, text, text, text)',
                             'public.assign_notify_wamid(uuid, text, text)'] loop
      execute 'grant execute on function ' || f || ' to service_role';
    end loop;
  end if;
end $$;

-- ---- 13) the every-minute job (only where pg_cron exists; re-run keeps one job) ---------------------------------------------
do $$ begin
  if to_regnamespace('cron') is not null and to_regprocedure('cron.schedule(text,text,text)') is not null then
    if not exists (select 1 from cron.job where jobname = 'helm-task-reminders') then
      perform cron.schedule('helm-task-reminders', '* * * * *', 'select public.task_reminder_tick()');
    end if;
  else
    raise notice '0338: pg_cron not available - schedule select public.task_reminder_tick() every minute yourself';
  end if;
end $$;
