-- 0363_r172_update_notices_staff_link.sql - R172 (owner, 16 Nov 2026: "whenever a task or anything is updated, send the
-- person a message - e-mail now, WhatsApp later - with their link; and one permanent link per staff member").
-- REQUIRES 0361 (staff_email_outbox, _r361_person, _r361_on), 0362 (staff_email_claim wrapper), 0338 (_r338_event,
-- _r338_time, _r338_day, _r338_link), 0341 (_r341_limit), 0334 (_r125_closed), 0132 (_assign132_phone).
--
-- What it does, in plain words:
--   1  staff_links: ONE permanent task link per staff member (64 random hex characters, about 244 bits). The office copies it
--      from the Staff page or the Operations worker links; "New link" stops the old one at once. The link opens
--      work.html?staff=<link>: that person sees ONLY their own open tasks across their upcoming live events, and each event
--      opens the existing per-event task page (work.html?token=...) for accept / start / done, so every action still goes
--      through the same checked worker functions as today (nothing about them is changed or widened).
--      The raw link is kept (not hashed) because automatic e-mails must include it later; the table is closed to the app
--      (RLS on, no grants) and only the functions below read it.
--   2  staff_update_outbox: change notices. When the office changes something on a task given to someone (name, start or
--      end time, instructions, area, status, cancelled, given to someone else) or on the event itself (date, time, venue,
--      cancelled), one line is added to that person waiting notice for that event. Lines collect for 5 quiet minutes
--      (never more than 15 minutes after the first change), so ten edits give ONE e-mail. Changes made by the worker
--      through their own link, timers and system jobs stay quiet. Nothing is queued while that person still has a
--      waiting "new work for you" e-mail for the event (that e-mail already shows the latest state).
--   3  staff_update_claim / staff_update_mark: comms-dispatch sends the notices (every row re-checked at send time).
--   4  staff_email_claim is wrapped once more (old body kept as staff_email_claim__pre0363): staff e-mails now carry the
--      permanent link instead of the per-event link (the per-event link stays the fallback).
-- The studio switch "E-mail staff their tasks" (0361) also covers these notices: one switch for all automatic staff e-mail.
--
-- ZERO DATA LOSS: additive + idempotent. Two new tables, new functions, one function wrapped once (old body kept),
-- new triggers. Nothing dropped, nothing deleted. Safe to run twice. ASCII only.

-- ---- 0) preflight ---------------------------------------------------------------------------------------------------
do $$
begin
  if to_regclass('public.staff_email_outbox') is null or to_regprocedure('public._r361_person(uuid,uuid,text)') is null
     or to_regprocedure('public._r361_on(uuid)') is null then
    raise exception 'STOP 0363: run 0361 (staff e-mail) first'; end if;
  if to_regprocedure('public.staff_email_claim__pre0362(integer)') is null then
    raise exception 'STOP 0363: run 0362 (staff reminders) first'; end if;
  if to_regprocedure('public._r338_event(uuid)') is null or to_regprocedure('public._r338_link(uuid,uuid,text)') is null then
    raise exception 'STOP 0363: run 0338 (task reminders) first'; end if;
  if to_regprocedure('public._r341_limit(text,integer,integer)') is null then
    raise exception 'STOP 0363: run 0341 (link lookup limits) first'; end if;
  if to_regprocedure('public._r125_closed(uuid)') is null then
    raise exception 'STOP 0363: run 0334 (trial preview lockdown) first'; end if;
end $$;

-- ---- 1) the permanent links -------------------------------------------------------------------------------------------------
create table if not exists public.staff_links (
  id           uuid primary key default gen_random_uuid(),
  org_id       uuid not null references public.organizations(id) on delete cascade,
  crew_id      uuid not null references public.crew_members(id) on delete cascade,
  token        text not null check (token ~ '^[0-9a-f]{64}$'),
  created_by   uuid,
  created_at   timestamptz not null default now(),
  revoked_at   timestamptz,
  last_used_at timestamptz
);
alter table public.staff_links enable row level security;
create unique index if not exists staff_links_token363 on public.staff_links(token);
create unique index if not exists staff_links_live363 on public.staff_links(crew_id) where revoked_at is null;
create index if not exists staff_links_org_id_idx on public.staff_links(org_id);

do $$ begin
  revoke all on table public.staff_links from public;
  if exists (select 1 from pg_roles where rolname = 'anon') then execute 'revoke all on table public.staff_links from anon'; end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then execute 'revoke all on table public.staff_links from authenticated'; end if;
  -- a read-only studio cannot make or change links (same guard as every studio table)
  if to_regprocedure('public.tg_studio_read_only()') is not null
     and not exists (select 1 from pg_trigger where tgrelid = 'public.staff_links'::regclass and tgname = 'zzz_studio_read_only') then
    create trigger zzz_studio_read_only before insert or update or delete on public.staff_links for each row execute function public.tg_studio_read_only('org_id');
  end if;
end $$;

-- ---- 2) the change-notice queue -------------------------------------------------------------------------------------------
create table if not exists public.staff_update_outbox (
  id           uuid primary key default gen_random_uuid(),
  org_id       uuid not null references public.organizations(id) on delete cascade,
  quote_id     uuid not null references public.quotes(id) on delete cascade,
  crew_id      uuid references public.crew_members(id) on delete set null,
  phone        text check (phone is null or phone ~ '^[0-9]{8,15}$'),
  recipient    text not null check (char_length(recipient) between 6 and 320 and recipient ~ '^[^[:space:]@<>",;:]{1,64}@[A-Za-z0-9.-]{1,190}[.][A-Za-z]{2,24}$'),
  name         text check (name is null or char_length(name) <= 120),
  changes      jsonb not null default '[]'::jsonb check (jsonb_typeof(changes) = 'array'),
  change_count integer not null default 0,
  cancelled    boolean not null default false,
  first_at     timestamptz not null default now(),
  last_at      timestamptz not null default now(),
  not_before   timestamptz not null default now() + interval '5 minutes',
  status       text not null default 'pending' check (status in ('pending', 'sent', 'skipped', 'failed')),
  reason       text check (reason is null or char_length(reason) <= 80),
  attempts     integer not null default 0,
  claimed_at   timestamptz,
  sent_at      timestamptz,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);
alter table public.staff_update_outbox enable row level security;
create unique index if not exists staff_update_outbox_open363 on public.staff_update_outbox(quote_id, recipient)
  where status = 'pending' and sent_at is null and claimed_at is null;
create index if not exists staff_update_outbox_pending363 on public.staff_update_outbox(not_before) where sent_at is null;
create index if not exists staff_update_outbox_org_id_idx on public.staff_update_outbox(org_id);
create index if not exists staff_update_outbox_crew_id_idx on public.staff_update_outbox(crew_id);

do $$ begin
  revoke all on table public.staff_update_outbox from public;
  if exists (select 1 from pg_roles where rolname = 'anon') then execute 'revoke all on table public.staff_update_outbox from anon'; end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then execute 'revoke all on table public.staff_update_outbox from authenticated'; end if;
  if exists (select 1 from pg_roles where rolname = 'service_role') then execute 'grant select on table public.staff_update_outbox to service_role'; end if;
  -- the same guards as every outbox: event and studio match, read-only studios, system changes quiet, free trial sends nothing
  if to_regprocedure('public.tg_quote_org_match()') is not null
     and not exists (select 1 from pg_trigger where tgrelid = 'public.staff_update_outbox'::regclass and tgname = 'zz_quote_org_match') then
    create trigger zz_quote_org_match before insert or update on public.staff_update_outbox for each row execute function public.tg_quote_org_match();
  end if;
  if to_regprocedure('public.tg_studio_read_only()') is not null
     and not exists (select 1 from pg_trigger where tgrelid = 'public.staff_update_outbox'::regclass and tgname = 'zzz_studio_read_only') then
    create trigger zzz_studio_read_only before insert or update or delete on public.staff_update_outbox for each row execute function public.tg_studio_read_only('org_id');
  end if;
  if to_regprocedure('public._sq164_tg_outbox()') is not null
     and not exists (select 1 from pg_trigger where tgrelid = 'public.staff_update_outbox'::regclass and tgname = 'zzz_sq164_system_skip') then
    create trigger zzz_sq164_system_skip before insert on public.staff_update_outbox for each row execute function public._sq164_tg_outbox();
  end if;
  if to_regprocedure('public._ts166_tg_outbox_skip()') is not null
     and not exists (select 1 from pg_trigger where tgrelid = 'public.staff_update_outbox'::regclass and tgname = 'zzzz_ts166_outbox_skip') then
    create trigger zzzz_ts166_outbox_skip before insert on public.staff_update_outbox for each row execute function public._ts166_tg_outbox_skip();
  end if;
end $$;

-- trial retention (0184): the notice queue and the permanent links are purged with the studio events (like staff_email_outbox, 0361)
do $$ declare v_def text; begin
  if to_regprocedure('public._tr184_purge_tables()') is not null then
    v_def := pg_get_functiondef('public._tr184_purge_tables()'::regprocedure);
    if position('''staff_update_outbox''' in v_def) = 0 then
      if (length(v_def) - length(replace(v_def, '''staff_email_outbox'', ''assign_notify_outbox''', ''))) / length('''staff_email_outbox'', ''assign_notify_outbox''') <> 1 then
        raise notice '0363: _tr184_purge_tables has an unexpected body - left unchanged';
      else execute replace(v_def, '''staff_email_outbox'', ''assign_notify_outbox''', '''staff_email_outbox'', ''staff_update_outbox'', ''staff_links'', ''assign_notify_outbox'''); end if;
    end if;
  end if;
end $$;
do $$ declare v_def text; begin
  if to_regprocedure('public._tr184_purge_tables()') is not null then
    v_def := pg_get_functiondef('public._tr184_purge_tables()'::regprocedure);
    if position('''staff_links''' in v_def) = 0 and position('''staff_update_outbox'', ''assign_notify_outbox''' in v_def) > 0 then
      execute replace(v_def, '''staff_update_outbox'', ''assign_notify_outbox''', '''staff_update_outbox'', ''staff_links'', ''assign_notify_outbox''');
    end if;
  end if;
end $$;

-- ---- 3) link helpers ----------------------------------------------------------------------------------------------------------
-- 64 random hex characters (two random uuids, about 244 random bits)
create or replace function public._r363_new_token()
returns text language sql volatile set search_path = '' as $fn$
  -- r172-0363
  select replace(gen_random_uuid()::text, '-', '') || replace(gen_random_uuid()::text, '-', '');
$fn$;

-- the live permanent link path of an ACTIVE staff member of this studio (made once when missing); null in a closed
-- (trial preview) studio or for anybody else
create or replace function public._r363_link(p_org uuid, p_crew uuid)
returns text language plpgsql volatile security definer set search_path = '' as $fn$
-- r172-0363
declare v text;
begin
  if p_org is null or p_crew is null then return null; end if;
  if coalesce(public._r125_closed(p_org), false) then return null; end if;
  if not exists (select 1 from public.crew_members cm where cm.id = p_crew and cm.org_id = p_org and cm.active) then return null; end if;
  select l.token into v from public.staff_links l where l.crew_id = p_crew and l.org_id = p_org and l.revoked_at is null;
  if v is null then
    begin
      insert into public.staff_links (org_id, crew_id, token, created_by) values (p_org, p_crew, public._r363_new_token(), auth.uid())
      on conflict do nothing;
    exception when others then
      raise warning 'r172-0363: permanent link not made (%)', sqlstate;
      return null;
    end;
    select l.token into v from public.staff_links l where l.crew_id = p_crew and l.org_id = p_org and l.revoked_at is null;
  end if;
  return case when v is null then null else 'work.html?staff=' || v end;
end $fn$;

-- the office: get (or make) a staff member permanent link. Staff edit only, own studio only.
create or replace function public.staff_link_get(p_crew uuid)
returns jsonb language plpgsql volatile security definer set search_path = '' as $fn$
-- r172-0363
declare v_org uuid := public.current_org_id(); v_path text; v_at timestamptz;
begin
  if auth.uid() is null or v_org is null or not public.has_area('staff', 'edit') then
    raise exception 'not authorized' using errcode = '42501'; end if;
  if not exists (select 1 from public.crew_members cm where cm.id = p_crew and cm.org_id = v_org) then
    raise exception 'staff member not found' using errcode = 'P0002'; end if;
  if coalesce(public._r125_closed(v_org), false) then return jsonb_build_object('ok', false, 'reason', 'trial'); end if;
  if not exists (select 1 from public.crew_members cm where cm.id = p_crew and cm.org_id = v_org and cm.active) then
    return jsonb_build_object('ok', false, 'reason', 'inactive'); end if;
  v_path := public._r363_link(v_org, p_crew);
  if v_path is null then return jsonb_build_object('ok', false, 'reason', 'unavailable'); end if;
  select l.created_at into v_at from public.staff_links l where l.crew_id = p_crew and l.org_id = v_org and l.revoked_at is null;
  return jsonb_build_object('ok', true, 'path', v_path, 'created_at', v_at);
end $fn$;

-- the office: "New link" - the old link stops working at once, a new one is made
create or replace function public.staff_link_regenerate(p_crew uuid)
returns jsonb language plpgsql volatile security definer set search_path = '' as $fn$
-- r172-0363
declare v_org uuid := public.current_org_id(); v_n integer := 0;
begin
  if auth.uid() is null or v_org is null or not public.has_area('staff', 'edit') then
    raise exception 'not authorized' using errcode = '42501'; end if;
  if not exists (select 1 from public.crew_members cm where cm.id = p_crew and cm.org_id = v_org) then
    raise exception 'staff member not found' using errcode = 'P0002'; end if;
  update public.staff_links set revoked_at = now() where crew_id = p_crew and org_id = v_org and revoked_at is null;
  get diagnostics v_n = row_count;
  begin
    insert into public.audit_log(actor, action, entity, entity_id, changed, org_id)
      values (auth.uid(), 'staff_link.regenerate', 'crew_member', p_crew::text, jsonb_build_object('revoked', v_n), v_org);
  exception when others then raise warning 'r172-0363: audit skipped (%)', sqlstate;
  end;
  return public.staff_link_get(p_crew);
end $fn$;

-- the person (no login): their open tasks across their upcoming live events. Rate limited per network. Each event carries
-- that person existing per-event task link (made when missing, exactly like the office does), so accept / start / done
-- use the unchanged worker functions. Nothing about other people, no prices, no event codes.
create or replace function public.staff_link_view(p_token text)
returns jsonb language plpgsql volatile security definer set search_path = '' as $fn$
-- r172-0363
declare l public.staff_links; c public.crew_members; v_phone text; v_today date; v_events jsonb := '[]'::jsonb; e record;
        v_tok uuid; v_ev jsonb; v_tasks jsonb; v_studio text;
begin
  perform public._r341_limit('staff_link', 600, 240);
  if p_token is null or p_token !~ '^[0-9a-f]{64}$' then return jsonb_build_object('ok', false, 'reason', 'bad_link'); end if;
  select * into l from public.staff_links x where x.token = p_token and x.revoked_at is null;
  if l.id is null then return jsonb_build_object('ok', false, 'reason', 'bad_link'); end if;
  select * into c from public.crew_members m where m.id = l.crew_id and m.org_id = l.org_id and m.active;
  if c.id is null or coalesce(public._r125_closed(l.org_id), false) then return jsonb_build_object('ok', false, 'reason', 'bad_link'); end if;
  if l.last_used_at is null or l.last_used_at < now() - interval '10 minutes' then
    begin update public.staff_links set last_used_at = now() where id = l.id;
    exception when others then null;   -- a read-only studio: the page still answers
    end;
  end if;
  v_phone := public._assign132_phone(c.phone);
  begin v_today := public._a198_org_today(l.org_id); exception when others then v_today := current_date; end;
  select o.name into v_studio from public.organizations o where o.id = l.org_id;
  for e in
    select q.id as quote_id, min(t.planned_start) as first_start, q.event_date,
           (array_agg(t.assignee_phone order by t.created_at) filter (where coalesce(t.assignee_phone, '') <> ''))[1] as task_phone
      from public.event_tasks t join public.quotes q on q.id = t.quote_id and q.org_id = l.org_id
     where t.org_id = l.org_id and q.deleted_at is null and coalesce(q.status, '') not in ('cancelled', 'lost')
       and not coalesce(q.is_demo, false)
       and t.status not in ('completed', 'cancelled', 'rejected') and coalesce(t.assignee_kind, 'in_house') = 'in_house'
       and (t.crew_id = c.id or (v_phone is not null and public._assign132_phone(t.assignee_phone) = v_phone))
       and (q.event_date is null or q.event_date >= v_today - 1)
     group by q.id, q.event_date
     order by q.event_date nulls last, min(t.planned_start) nulls last
     limit 30
  loop
    v_tok := null;
    if e.task_phone is not null then
      select wt.token into v_tok from public.work_tokens wt
       where wt.quote_id = e.quote_id and wt.org_id = l.org_id and wt.phone = e.task_phone
         and wt.revoked_at is null and (wt.expires_at is null or wt.expires_at > now())
       order by wt.created_at desc limit 1;
      if v_tok is null and not exists (select 1 from public.work_tokens wt where wt.quote_id = e.quote_id and wt.phone = e.task_phone) then
        begin
          insert into public.work_tokens (quote_id, phone, name, org_id) values (e.quote_id, e.task_phone, left(c.name, 120), l.org_id)
          on conflict do nothing;
          select wt.token into v_tok from public.work_tokens wt
           where wt.quote_id = e.quote_id and wt.org_id = l.org_id and wt.phone = e.task_phone
             and wt.revoked_at is null and (wt.expires_at is null or wt.expires_at > now())
           order by wt.created_at desc limit 1;
        exception when others then v_tok := null;
        end;
      end if;
    end if;
    v_ev := public._r338_event(e.quote_id);
    select coalesce(jsonb_agg(jsonb_build_object('title', left(t.title, 160), 'category', left(coalesce(t.category, ''), 60),
             'start', public._r338_time(t.planned_start, l.org_id), 'day', public._r338_day(t.planned_start, l.org_id),
             'status', t.status) order by t.planned_start nulls last, t.category, t.seq), '[]'::jsonb)
      into v_tasks
      from (select * from public.event_tasks t
             where t.quote_id = e.quote_id and t.org_id = l.org_id
               and t.status not in ('completed', 'cancelled', 'rejected') and coalesce(t.assignee_kind, 'in_house') = 'in_house'
               and (t.crew_id = c.id or (v_phone is not null and public._assign132_phone(t.assignee_phone) = v_phone))
             order by t.planned_start nulls last, t.category, t.seq limit 40) t;
    v_events := v_events || jsonb_build_array(jsonb_build_object(
      'event', v_ev ->> 'event', 'date', v_ev ->> 'date', 'time', v_ev ->> 'time', 'venue', v_ev ->> 'venue',
      'link', case when v_tok is null then null else v_tok::text end, 'tasks', v_tasks));
  end loop;
  return jsonb_build_object('ok', true, 'name', split_part(btrim(coalesce(c.name, '')), ' ', 1), 'studio', v_studio,
    'today', v_today, 'events', v_events);
end $fn$;

-- ---- 4) change notices: queue one line -------------------------------------------------------------------------------------
-- when a task time is shown in a notice
create or replace function public._r363_when(p_at timestamptz, p_org uuid)
returns text language sql stable security definer set search_path = '' as $fn$
  -- r172-0363
  select case when p_at is null then 'no time set' else public._r338_time(p_at, p_org) || ' on ' || public._r338_day(p_at, p_org) end;
$fn$;

-- the studio may send to staff about this event (not a trial / read-only studio, not a sample event). A cancelled or
-- deleted event only for the "event cancelled" notice.
create or replace function public._r363_can(p_org uuid, p_quote uuid, p_cancelled_ok boolean)
returns boolean language sql stable security definer set search_path = '' as $fn$
  -- r172-0363
  select p_org is not null
     and not coalesce(public._tb179_no_send(p_org), false) and not coalesce(public._trial_locked(p_org), false)
     and exists (select 1 from public.quotes q where q.id = p_quote and q.org_id = p_org and not coalesce(q.is_demo, false)
                   and (coalesce(p_cancelled_ok, false) or (q.deleted_at is null and coalesce(q.status, '') <> 'cancelled')));
$fn$;

-- add change lines to the waiting notice of one person for one event (made when missing). Never raises.
create or replace function public._r363_note(p_org uuid, p_quote uuid, p_crew uuid, p_phone text, p_lines text[], p_cancelled boolean default false)
returns void language plpgsql volatile security definer set search_path = '' as $fn$
-- r172-0363
declare v_p jsonb; v_phone text := public._assign132_phone(p_phone); v_new jsonb; v_lines text[];
begin
  begin
    select coalesce(array_agg(left(btrim(x), 200)), '{}') into v_lines from unnest(p_lines) x where nullif(btrim(coalesce(x, '')), '') is not null;
    if coalesce(array_length(v_lines, 1), 0) = 0 then return; end if;
    if not public._r361_on(p_org) or not public._r363_can(p_org, p_quote, p_cancelled) then return; end if;
    v_p := public._r361_person(p_org, p_crew, v_phone);
    if v_p is null then return; end if;
    -- the "new work for you" e-mail still waiting for this person and event already shows the latest state
    if exists (select 1 from public.staff_email_outbox o where o.quote_id = p_quote and o.recipient = v_p ->> 'email'
                 and o.kind = 'task_assigned' and o.status = 'pending' and o.sent_at is null) then return; end if;
    v_new := to_jsonb(v_lines);
    insert into public.staff_update_outbox as u (org_id, quote_id, crew_id, phone, recipient, name, changes, change_count, cancelled)
    values (p_org, p_quote, (v_p ->> 'crew_id')::uuid, v_phone, v_p ->> 'email', left(v_p ->> 'name', 120), v_new,
            jsonb_array_length(v_new), coalesce(p_cancelled, false))
    on conflict (quote_id, recipient) where status = 'pending' and sent_at is null and claimed_at is null
    do update set
      changes = (select coalesce(jsonb_agg(z.v order by z.o), '[]'::jsonb) from (
                   select x.v, min(x.o) as o from (
                     select v, o from jsonb_array_elements(u.changes) with ordinality a(v, o)
                     union all
                     select v, 1000 + o from jsonb_array_elements(excluded.changes) with ordinality b(v, o)) x
                   group by x.v order by min(x.o) limit 30) z),
      change_count = u.change_count + excluded.change_count,
      cancelled = u.cancelled or excluded.cancelled,
      last_at = now(),
      not_before = least(u.first_at + interval '15 minutes', now() + interval '5 minutes'),
      updated_at = now();
  exception when others then
    raise warning 'r172-0363: change notice not queued (%)', sqlstate;
  end;
end $fn$;

-- ---- 5) change notices: what counts as a change --------------------------------------------------------------------------
-- a task changed by the OFFICE (signed in, and not the person the task is for)
create or replace function public._r363_tg_task_changed()
returns trigger language plpgsql security definer set search_path = '' as $fn$
-- r172-0363: never makes the save fail
declare v_actor uuid := auth.uid(); v_lines text[] := '{}'; v_title text; v_old_phone text; v_new_phone text;
        v_label jsonb := '{"assigned":"Assigned","accepted":"Accepted","in_progress":"In progress","completed":"Done","rejected":"Declined","cancelled":"Cancelled"}';
begin
  begin
    if v_actor is null then return null; end if;   -- worker links, timers, system jobs: quiet
    if coalesce(old.assignee_kind, 'in_house') <> 'in_house' and coalesce(new.assignee_kind, 'in_house') <> 'in_house' then return null; end if;
    v_old_phone := public._assign132_phone(old.assignee_phone);
    v_new_phone := public._assign132_phone(new.assignee_phone);
    -- the person the task is for, acting on it with their own login: quiet
    if exists (select 1 from public.crew_members cm where cm.org_id = new.org_id and cm.profile_id = v_actor
                 and (cm.id = old.crew_id or cm.id = new.crew_id
                      or (public._assign132_phone(cm.phone) is not null and public._assign132_phone(cm.phone) in (v_old_phone, v_new_phone)))) then
      return null; end if;
    v_title := left(coalesce(nullif(btrim(new.title), ''), old.title, 'a task'), 120);
    -- given to someone else: the previous person is told (the new person gets the 0361 "new work" e-mail)
    if (old.crew_id, v_old_phone) is distinct from (new.crew_id, v_new_phone) then
      if coalesce(old.assignee_kind, 'in_house') = 'in_house' and old.status not in ('completed', 'cancelled', 'rejected')
         and (old.crew_id is not null or v_old_phone is not null) then
        perform public._r363_note(old.org_id, old.quote_id, old.crew_id, v_old_phone, array['No longer yours: ' || v_title]);
      end if;
      return null;
    end if;
    if coalesce(new.assignee_kind, 'in_house') <> 'in_house' or (new.crew_id is null and v_new_phone is null) then return null; end if;
    -- edits to a task that was already closed and stays closed: quiet
    if old.status in ('completed', 'cancelled', 'rejected') and new.status = old.status then return null; end if;
    if new.title is distinct from old.title then
      v_lines := v_lines || ('Renamed: "' || left(coalesce(old.title, ''), 100) || '" is now "' || left(coalesce(new.title, ''), 100) || '"'); end if;
    if new.planned_start is distinct from old.planned_start then
      v_lines := v_lines || (v_title || ': start time changed from ' || public._r363_when(old.planned_start, new.org_id) || ' to ' || public._r363_when(new.planned_start, new.org_id)); end if;
    if new.planned_end is distinct from old.planned_end then
      v_lines := v_lines || (v_title || ': finish time changed from ' || public._r363_when(old.planned_end, new.org_id) || ' to ' || public._r363_when(new.planned_end, new.org_id)); end if;
    if new.note is distinct from old.note then
      v_lines := v_lines || (v_title || ': instructions updated'); end if;
    if new.category is distinct from old.category then
      v_lines := v_lines || (v_title || ': moved to ' || left(coalesce(new.category, ''), 60)); end if;
    if new.status is distinct from old.status then
      if new.status = 'cancelled' then v_lines := v_lines || ('Cancelled: ' || v_title);
      elsif old.status in ('completed', 'cancelled', 'rejected') then v_lines := v_lines || ('Opened again: ' || v_title);
      else v_lines := v_lines || (v_title || ': status changed from ' || coalesce(v_label ->> old.status, old.status) || ' to ' || coalesce(v_label ->> new.status, new.status) || ' by the office');
      end if;
    end if;
    if coalesce(array_length(v_lines, 1), 0) > 0 then
      perform public._r363_note(new.org_id, new.quote_id, new.crew_id, v_new_phone, v_lines);
    end if;
  exception when others then
    raise warning 'r172-0363: task change not noted (%)', sqlstate;
  end;
  return null;
end $fn$;

do $$ begin
  if not exists (select 1 from pg_trigger where tgrelid = 'public.event_tasks'::regclass and tgname = 'zzz_r363_task_changed') then
    create trigger zzz_r363_task_changed after update of title, planned_start, planned_end, note, category, status, crew_id, assignee_phone
      on public.event_tasks for each row execute function public._r363_tg_task_changed();
  end if;
end $$;

-- every person with open work on an event gets the same event lines
create or replace function public._r363_note_event(p_org uuid, p_quote uuid, p_lines text[], p_cancelled boolean)
returns void language plpgsql volatile security definer set search_path = '' as $fn$
-- r172-0363
declare r record;
begin
  for r in
    select distinct on (coalesce(t.crew_id::text, public._assign132_phone(t.assignee_phone))) t.crew_id, public._assign132_phone(t.assignee_phone) as phone
      from public.event_tasks t
     where t.quote_id = p_quote and t.org_id = p_org and coalesce(t.assignee_kind, 'in_house') = 'in_house'
       and t.status not in ('completed', 'cancelled', 'rejected')
       and (t.crew_id is not null or public._assign132_phone(t.assignee_phone) is not null)
     order by coalesce(t.crew_id::text, public._assign132_phone(t.assignee_phone)), t.created_at
     limit 200
  loop
    perform public._r363_note(p_org, p_quote, r.crew_id, r.phone, p_lines, p_cancelled);
  end loop;
end $fn$;

-- the event itself changed by the office: date, time, venue (client venue), cancelled / deleted
create or replace function public._r363_tg_event_changed()
returns trigger language plpgsql security definer set search_path = '' as $fn$
-- r172-0363: never makes the save fail
declare v_lines text[] := '{}'; v_cancel boolean := false; v_ov text; v_nv text;
begin
  begin
    if auth.uid() is null or coalesce(new.is_demo, false) then return null; end if;
    if (new.status = 'cancelled' and coalesce(old.status, '') <> 'cancelled') or (new.deleted_at is not null and old.deleted_at is null) then
      v_cancel := true;
      v_lines := array['The event has been cancelled - your tasks for it are off'];
    elsif new.deleted_at is null and coalesce(new.status, '') <> 'cancelled' then
      if new.event_date is distinct from old.event_date then
        v_lines := v_lines || ('Event date changed from ' || coalesce(to_char(old.event_date, 'FMDD Mon YYYY'), 'not set') || ' to ' || coalesce(to_char(new.event_date, 'FMDD Mon YYYY'), 'not set')); end if;
      if new.event_time is distinct from old.event_time then
        v_lines := v_lines || ('Event time changed from ' || coalesce(nullif(btrim(old.event_time), ''), 'not set') || ' to ' || coalesce(nullif(btrim(new.event_time), ''), 'not set')); end if;
      v_ov := nullif(btrim(coalesce(old.client ->> 'venue', '')), '');
      v_nv := nullif(btrim(coalesce(new.client ->> 'venue', '')), '');
      if v_nv is distinct from v_ov then
        v_lines := v_lines || ('Venue changed from ' || left(coalesce(v_ov, 'not set'), 80) || ' to ' || left(coalesce(v_nv, 'not set'), 80)); end if;
    end if;
    if coalesce(array_length(v_lines, 1), 0) > 0 then
      perform public._r363_note_event(new.org_id, new.id, v_lines, v_cancel);
    end if;
  exception when others then
    raise warning 'r172-0363: event change not noted (%)', sqlstate;
  end;
  return null;
end $fn$;

do $$ begin
  if not exists (select 1 from pg_trigger where tgrelid = 'public.quotes'::regclass and tgname = 'zzz_r363_event_changed') then
    create trigger zzz_r363_event_changed after update of event_date, event_time, client, status, deleted_at
      on public.quotes for each row execute function public._r363_tg_event_changed();
  end if;
end $$;

-- the event plan venue (where the studio keeps the venue name), only where that table exists
create or replace function public._r363_tg_plan_venue()
returns trigger language plpgsql security definer set search_path = '' as $fn$
-- r172-0363: never makes the save fail
declare v_ov text; v_nv text; v_org uuid;
begin
  begin
    if auth.uid() is null then return null; end if;
    v_ov := nullif(btrim(coalesce(to_jsonb(old) ->> 'venue_name', '')), '');
    v_nv := nullif(btrim(coalesce(to_jsonb(new) ->> 'venue_name', '')), '');
    if v_nv is not distinct from v_ov then return null; end if;
    select q.org_id into v_org from public.quotes q
     where q.id = (to_jsonb(new) ->> 'quote_id')::uuid and q.deleted_at is null and coalesce(q.status, '') <> 'cancelled' and not coalesce(q.is_demo, false);
    if v_org is null then return null; end if;
    perform public._r363_note_event(v_org, (to_jsonb(new) ->> 'quote_id')::uuid,
      array['Venue changed from ' || left(coalesce(v_ov, 'not set'), 80) || ' to ' || left(coalesce(v_nv, 'not set'), 80)], false);
  exception when others then
    raise warning 'r172-0363: venue change not noted (%)', sqlstate;
  end;
  return null;
end $fn$;

do $$ begin
  if to_regclass('public.event_plan') is not null
     and exists (select 1 from pg_attribute where attrelid = 'public.event_plan'::regclass and attname = 'venue_name' and not attisdropped)
     and exists (select 1 from pg_attribute where attrelid = 'public.event_plan'::regclass and attname = 'quote_id' and not attisdropped)
     and not exists (select 1 from pg_trigger where tgrelid = 'public.event_plan'::regclass and tgname = 'zzz_r363_plan_venue') then
    execute 'create trigger zzz_r363_plan_venue after update of venue_name on public.event_plan for each row execute function public._r363_tg_plan_venue()';
  end if;
end $$;

-- ---- 6) comms-dispatch: claim + mark the notices (service role only) ------------------------------------------------------
create or replace function public.staff_update_claim(p_limit integer default 25)
returns jsonb language plpgsql volatile security definer set search_path = '' as $fn$
-- r172-0363: every row re-checked at send time; fails closed (skipped) when anything changed
declare r record; v_out jsonb := '[]'::jsonb; v_ok boolean; v_why text; v_p jsonb; v_tasks jsonb; v_ident jsonb; v_ev jsonb;
        v_link text; v_tphone text;
begin
  update public.staff_update_outbox set status = 'failed', reason = 'too_many_attempts', sent_at = now(), updated_at = now()
   where sent_at is null and status = 'pending' and attempts >= 5;
  update public.staff_update_outbox set status = 'skipped', reason = 'too_old', sent_at = now(), updated_at = now()
   where sent_at is null and status = 'pending' and created_at < now() - interval '1 day';
  for r in select o.* from public.staff_update_outbox o
            where o.sent_at is null and o.status = 'pending' and o.not_before <= now()
              and (o.claimed_at is null or o.claimed_at < now() - interval '10 minutes')
            order by o.not_before limit greatest(1, least(coalesce(p_limit, 25), 100)) for update of o skip locked
  loop
    v_ok := true; v_why := null; v_tasks := '[]'::jsonb; v_link := null; v_tphone := null;
    if not public._r363_can(r.org_id, r.quote_id, r.cancelled) then v_ok := false; v_why := 'not_live';
    elsif not public._r361_on(r.org_id) then v_ok := false; v_why := 'switched_off';
    elsif coalesce(public._r283_off_email(r.org_id, r.recipient), false) then v_ok := false; v_why := 'deactivated';
    elsif jsonb_array_length(r.changes) = 0 then v_ok := false; v_why := 'nothing_changed';
    end if;
    if v_ok then
      v_p := public._r361_person(r.org_id, r.crew_id, r.phone);
      if v_p is null or (v_p ->> 'email') is distinct from r.recipient then v_ok := false; v_why := 'person_changed'; end if;
    end if;
    if not coalesce(v_ok, false) then
      update public.staff_update_outbox set status = 'skipped', reason = coalesce(v_why, 'recheck'), sent_at = now(), updated_at = now() where id = r.id;
      continue;
    end if;
    -- their open tasks on this event now (none when the event is cancelled)
    if not r.cancelled then
      select coalesce(jsonb_agg(jsonb_build_object('title', left(x.title, 160), 'category', left(coalesce(x.category, ''), 60),
               'start', public._r338_time(x.planned_start, r.org_id), 'day', public._r338_day(x.planned_start, r.org_id))
               order by x.planned_start nulls last, x.category, x.seq), '[]'::jsonb)
        into v_tasks
        from (select * from public.event_tasks x where x.quote_id = r.quote_id and x.org_id = r.org_id
                 and x.status not in ('completed', 'cancelled', 'rejected') and coalesce(x.assignee_kind, 'in_house') = 'in_house'
                 and public._r361_mine(x, (v_p ->> 'crew_id')::uuid, r.phone)
               order by x.planned_start nulls last, x.category, x.seq limit 25) x;
      select public._assign132_phone(x.assignee_phone) into v_tphone from public.event_tasks x
       where x.quote_id = r.quote_id and x.org_id = r.org_id and public._r361_mine(x, (v_p ->> 'crew_id')::uuid, r.phone)
         and x.assignee_phone is not null limit 1;
    end if;
    -- the permanent link, else the per-event link
    v_link := coalesce(public._r363_link(r.org_id, (v_p ->> 'crew_id')::uuid),
                       case when v_tphone is not null then public._r338_link(r.quote_id, r.org_id, v_tphone) end);
    v_ev := public._r338_event(r.quote_id);
    select jsonb_build_object('from_name', cs.email_from_name, 'reply_to', cs.email_reply_to) into v_ident
      from public.comms_settings cs where cs.org_id = r.org_id;
    update public.staff_update_outbox set claimed_at = now(), attempts = attempts + 1, updated_at = now() where id = r.id;
    v_out := v_out || jsonb_build_array(jsonb_build_object(
      'id', r.id, 'to', r.recipient, 'kind', 'task_update', 'name', r.name, 'quote_id', r.quote_id,
      'studio', (select o.name from public.organizations o where o.id = r.org_id),
      'event', v_ev ->> 'event', 'event_date', v_ev ->> 'date', 'venue', v_ev ->> 'venue',
      'changes', r.changes, 'more', greatest(0, r.change_count - jsonb_array_length(r.changes)),
      'cancelled', r.cancelled, 'tasks', v_tasks, 'link_path', v_link,
      'identity', coalesce(v_ident, '{}'::jsonb)));
  end loop;
  return v_out;
end $fn$;

create or replace function public.staff_update_mark(p_id uuid, p_status text)
returns text language plpgsql volatile security definer set search_path = '' as $fn$
-- r172-0363
begin
  if p_status not in ('sent', 'skipped', 'failed', 'retry') then raise exception 'bad status' using errcode = '22023'; end if;
  if p_status = 'retry' then
    update public.staff_update_outbox set claimed_at = null, updated_at = now() where id = p_id and sent_at is null;
    return 'pending';
  end if;
  update public.staff_update_outbox set status = p_status, sent_at = now(), updated_at = now() where id = p_id and sent_at is null;
  return p_status;
end $fn$;

-- ---- 7) staff e-mails carry the permanent link (0361 / 0362 claim wrapped once, old body kept) ----------------------------
do $$
declare v_src text;
begin
  select p.prosrc into v_src from pg_proc p where p.oid = to_regprocedure('public.staff_email_claim(integer)');
  if position('r172-0363' in coalesce(v_src, '')) = 0 and to_regprocedure('public.staff_email_claim__pre0363(integer)') is null then
    alter function public.staff_email_claim(integer) rename to staff_email_claim__pre0363;
  end if;
  if to_regprocedure('public.staff_email_claim__pre0363(integer)') is null then
    raise exception 'STOP 0363: staff_email_claim could not be kept as staff_email_claim__pre0363'; end if;
end $$;

create or replace function public.staff_email_claim(p_limit integer default 25)
returns jsonb language plpgsql volatile security definer set search_path = '' as $fn$
-- r172-0363: the 0362 claim; then every staff e-mail (not the office alert) links to the person permanent link when one
-- can be issued, else keeps the per-event link
declare v jsonb := public.staff_email_claim__pre0363(p_limit); x jsonb; v_out jsonb := '[]'::jsonb; v_org uuid; v_crew uuid; v_path text;
begin
  if v is null or jsonb_typeof(v) <> 'array' then return v; end if;
  for x in select e from jsonb_array_elements(v) e loop
    v_path := null; v_org := null; v_crew := null;
    if jsonb_typeof(x) = 'object' and coalesce(x ->> 'kind', '') <> 'office_alert' then
      select o.org_id, o.crew_id into v_org, v_crew from public.staff_email_outbox o where o.id::text = x ->> 'id';
      if v_crew is not null then v_path := public._r363_link(v_org, v_crew); end if;
    end if;
    v_out := v_out || jsonb_build_array(case when v_path is not null then jsonb_set(x, '{link_path}', to_jsonb(v_path)) else x end);
  end loop;
  return v_out;
end $fn$;

-- ---- 8) grants: office buttons for signed-in staff, the link page for anyone with a link, the rest server only ----------
do $$
declare f text;
begin
  foreach f in array array['public._r363_new_token()', 'public._r363_link(uuid,uuid)', 'public.staff_link_get(uuid)',
                           'public.staff_link_regenerate(uuid)', 'public.staff_link_view(text)', 'public._r363_when(timestamp with time zone,uuid)',
                           'public._r363_can(uuid,uuid,boolean)', 'public._r363_note(uuid,uuid,uuid,text,text[],boolean)',
                           'public._r363_note_event(uuid,uuid,text[],boolean)', 'public._r363_tg_task_changed()',
                           'public._r363_tg_event_changed()', 'public._r363_tg_plan_venue()',
                           'public.staff_update_claim(integer)', 'public.staff_update_mark(uuid,text)',
                           'public.staff_email_claim(integer)', 'public.staff_email_claim__pre0363(integer)'] loop
    execute format('revoke all on function %s from public', f);
    if exists (select 1 from pg_roles where rolname = 'anon') then execute format('revoke all on function %s from anon', f); end if;
    if exists (select 1 from pg_roles where rolname = 'authenticated') then execute format('revoke all on function %s from authenticated', f); end if;
    if exists (select 1 from pg_roles where rolname = 'service_role') then execute format('grant execute on function %s to service_role', f); end if;
  end loop;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    execute 'grant execute on function public.staff_link_get(uuid) to authenticated';
    execute 'grant execute on function public.staff_link_regenerate(uuid) to authenticated';
    execute 'grant execute on function public.staff_link_view(text) to authenticated';
  end if;
  if exists (select 1 from pg_roles where rolname = 'anon') then
    execute 'grant execute on function public.staff_link_view(text) to anon';
  end if;
end $$;

-- VERIFY every line should say true
select item, ok from (values
  ('01 permanent link table, closed to the app', to_regclass('public.staff_links') is not null
     and not has_table_privilege('authenticated', 'public.staff_links', 'select') and not has_table_privilege('anon', 'public.staff_links', 'select')),
  ('02 change notice queue, closed to the app', to_regclass('public.staff_update_outbox') is not null
     and not has_table_privilege('authenticated', 'public.staff_update_outbox', 'select') and not has_table_privilege('anon', 'public.staff_update_outbox', 'select')),
  ('03 both new tables have RLS on', coalesce((select bool_and(c.relrowsecurity) from pg_class c where c.oid in (to_regclass('public.staff_links'), to_regclass('public.staff_update_outbox'))), false)),
  ('04 task and event change triggers', exists (select 1 from pg_trigger where tgrelid = to_regclass('public.event_tasks') and tgname = 'zzz_r363_task_changed')
     and exists (select 1 from pg_trigger where tgrelid = to_regclass('public.quotes') and tgname = 'zzz_r363_event_changed')),
  ('05 office link buttons for signed-in staff only', has_function_privilege('authenticated', 'public.staff_link_get(uuid)', 'execute')
     and has_function_privilege('authenticated', 'public.staff_link_regenerate(uuid)', 'execute')
     and not has_function_privilege('anon', 'public.staff_link_get(uuid)', 'execute') and not has_function_privilege('anon', 'public.staff_link_regenerate(uuid)', 'execute')),
  ('06 link page open to a link holder', has_function_privilege('anon', 'public.staff_link_view(text)', 'execute')),
  ('07 claim / mark server only', not has_function_privilege('authenticated', 'public.staff_update_claim(integer)', 'execute')
     and not has_function_privilege('authenticated', 'public.staff_update_mark(uuid,text)', 'execute')
     and not has_function_privilege('authenticated', 'public.staff_email_claim__pre0363(integer)', 'execute')),
  ('08 staff e-mail claim wrapped once (old body kept)', to_regprocedure('public.staff_email_claim__pre0363(integer)') is not null
     and position('r172-0363' in coalesce(pg_get_functiondef(to_regprocedure('public.staff_email_claim(integer)')), '')) > 0),
  ('09 free-trial purge knows the new queue (or 0184 is absent)', to_regprocedure('public._tr184_purge_tables()') is null
     or (position('staff_update_outbox' in pg_get_functiondef(to_regprocedure('public._tr184_purge_tables()'))) > 0
         and position('staff_links' in pg_get_functiondef(to_regprocedure('public._tr184_purge_tables()'))) > 0))
) v(item, ok) order by item;
