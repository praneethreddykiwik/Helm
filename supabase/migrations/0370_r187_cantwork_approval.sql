-- 0370_r187_cantwork_approval.sql - R187 (owner, 17 Nov 2026). Forward-only, additive, safe to run twice. ASCII only.
-- REQUIRES 0265 (crew_availability, crew link), 0266 (_r23_area), 0283 (_r283_is_off), 0299 (crew_link_home chain),
--          0334 (_work_token_live), 0341 (_r341_limit), 0361 (_r361_person / _r361_email), 0363 (staff_links, _r363_link),
--          0365 (crew_unavailable_conflicts), 0179 (_tb179_no_send).
--
-- In plain words:
--   A day a staff member marks as "can not work" on their link is now a REQUEST that the office approves or turns down.
--   1  crew_availability gets six new columns, all empty on every existing row: approval (pending / approved / rejected;
--      EMPTY = approved, so every day marked before this change counts as approved exactly as before - no row is
--      updated), requested_at, decided_at, decided_by, decision_note (up to 200 characters) and ack_at (when the staff
--      member tapped "OK, got it" on the decision).
--   2  crew_set_availability (the staff link) re-issued: a new day becomes a pending request; days inside the studio
--      buffer (default 7 days: today up to today + 6, in the STUDIO time zone) are refused on the server with
--      "Too close - days within a week can not be blocked here. Please call your manager."; changing the reason of a
--      day already asked for is always allowed; freeing a day is always allowed. The owner, admins and managers (and
--      anyone who can edit Staff) get a bell notice and, outside a free trial, an e-mail (new cantwork_email_outbox,
--      sent by comms-dispatch).
--   3  cantwork_requests / cantwork_decide: the Staff page list (badge count) and Approve / Turn down with an optional
--      note. Only the owner / admins / people who can edit Staff decide. The staff member gets an e-mail (outside a free
--      trial) and sees the decision on their link until they tap "OK, got it" (crew_cantwork_ack on the event link,
--      staff_link_cantwork / staff_link_cantwork_ack on the permanent link).
--   4  crew_availability_set (the office grid) re-issued: a day the office marks is approved at once, inside the buffer
--      too. Turning a pending request free from the grid counts as turned down.
--   5  crew_day_status / crew_availability_range / crew_unavailable_conflicts re-issued with the same answers plus
--      approval (pending / approved), so the assign warning, the Team calendar, Conflicts and the monitor can say
--      "asked off, waiting for approval" or "approved day off". Assigning is never blocked.
--   6  crew_link_home wrapped once (old body kept as crew_link_home__pre0370): each marked day carries its approval and
--      the answer carries the buffer and the decisions still to acknowledge.
--   7  cantwork_settings_get / cantwork_settings_set: the per-studio buffer (0 to 60 days, default 7) in app_config
--      key cantwork.
--   event_task_log (0368) needs an event, and a day off is not about one event, so the request steps are kept on the
--   row itself (requested_at / decided_at / decided_by / ack_at) and each decision is written to audit_log.
--   Nothing is dropped or deleted. Goes after 0368.

-- ---- 0) preflight ---------------------------------------------------------------------------------------------------------------
do $$
declare v text;
begin
  if to_regclass('public.crew_availability') is null or to_regclass('public.staff_links') is null or to_regclass('public.app_config') is null then
    raise exception 'STOP 0370: run 0265 (crew availability) and 0363 (staff links) first'; end if;
  foreach v in array array['public._r23_cfg(uuid)', 'public._r23_tz(uuid)', 'public._a198_org_today(uuid)', 'public._work_token_live(uuid)',
                           'public._r23_crew_of_token(public.work_tokens)', 'public._r23_notify(uuid,text,jsonb)', 'public._r23_area(uuid,text,text,text)',
                           'public._r283_is_off(uuid,uuid)', 'public._r361_person(uuid,uuid,text)', 'public._r361_email(text)',
                           'public._r363_link(uuid,uuid)', 'public._tb179_no_send(uuid)', 'public._r341_limit(text,integer,integer)',
                           'public._r125_closed(uuid)', 'public.has_area(text,text)', 'public.current_org_id()', 'public.user_role()',
                           'public.is_admin()', 'public.crew_unavailable_conflicts(date,date)'] loop
    if to_regprocedure(v) is null then raise exception 'STOP 0370: % missing', v; end if;
  end loop;
  if to_regprocedure('public.crew_link_home(uuid)') is null and to_regprocedure('public.crew_link_home__pre0370(uuid)') is null then
    raise exception 'STOP 0370: crew_link_home missing (run 0265 and 0299 first)'; end if;
end $$;

-- ---- 1) new columns (all empty on existing rows: empty approval = approved) --------------------------------------------------
alter table public.crew_availability add column if not exists approval text;
alter table public.crew_availability add column if not exists requested_at timestamptz;
alter table public.crew_availability add column if not exists decided_at timestamptz;
alter table public.crew_availability add column if not exists decided_by uuid;
alter table public.crew_availability add column if not exists decision_note text;
alter table public.crew_availability add column if not exists ack_at timestamptz;
do $$ begin
  if not exists (select 1 from pg_constraint where conrelid = 'public.crew_availability'::regclass and conname = 'crew_availability_approval_r370') then
    alter table public.crew_availability add constraint crew_availability_approval_r370
      check (approval is null or approval in ('pending', 'approved', 'rejected'));
  end if;
  if not exists (select 1 from pg_constraint where conrelid = 'public.crew_availability'::regclass and conname = 'crew_availability_decision_note_r370') then
    alter table public.crew_availability add constraint crew_availability_decision_note_r370
      check (decision_note is null or char_length(decision_note) <= 200);
  end if;
end $$;
create index if not exists crew_availability_pending_r370 on public.crew_availability (org_id, day) where approval = 'pending';

-- ---- 2) the e-mail queue (office: new request; staff member: the decision) -----------------------------------------------------
create table if not exists public.cantwork_email_outbox (
  id          uuid primary key default gen_random_uuid(),
  org_id      uuid not null references public.organizations(id) on delete cascade,
  avail_id    uuid references public.crew_availability(id) on delete cascade,
  crew_id     uuid references public.crew_members(id) on delete set null,
  kind        text not null check (kind in ('request', 'decision')),
  recipient   text not null check (char_length(recipient) between 6 and 320 and recipient ~ '^[^[:space:]@<>",;:]{1,64}@[A-Za-z0-9.-]{1,190}[.][A-Za-z]{2,24}$'),
  name        text check (name is null or char_length(name) <= 120),
  dedupe_key  text not null check (char_length(dedupe_key) <= 300),
  status      text not null default 'pending' check (status in ('pending', 'sent', 'skipped', 'failed')),
  reason      text check (reason is null or char_length(reason) <= 80),
  not_before  timestamptz not null default now(),
  attempts    integer not null default 0,
  claimed_at  timestamptz,
  sent_at     timestamptz,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create unique index if not exists cantwork_email_outbox_dedupe370 on public.cantwork_email_outbox (dedupe_key);
create index if not exists cantwork_email_outbox_pending370 on public.cantwork_email_outbox (not_before) where sent_at is null;
create index if not exists cantwork_email_outbox_org_idx on public.cantwork_email_outbox (org_id);
create index if not exists cantwork_email_outbox_avail_idx on public.cantwork_email_outbox (avail_id);
create index if not exists cantwork_email_outbox_crew_idx on public.cantwork_email_outbox (crew_id);
do $$ begin
  alter table public.cantwork_email_outbox enable row level security;
  revoke all on table public.cantwork_email_outbox from public;
  if exists (select 1 from pg_roles where rolname = 'anon') then execute 'revoke all on table public.cantwork_email_outbox from anon'; end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then execute 'revoke all on table public.cantwork_email_outbox from authenticated'; end if;
  if exists (select 1 from pg_roles where rolname = 'service_role') then execute 'grant select on table public.cantwork_email_outbox to service_role'; end if;
  -- read-only studios write nothing, system changes stay quiet, sample / trial addresses are skipped (same as every outbox)
  if to_regprocedure('public.tg_studio_read_only()') is not null
     and not exists (select 1 from pg_trigger where tgrelid = 'public.cantwork_email_outbox'::regclass and tgname = 'zzz_studio_read_only') then
    create trigger zzz_studio_read_only before insert or update or delete on public.cantwork_email_outbox for each row execute function public.tg_studio_read_only('org_id');
  end if;
  if to_regprocedure('public._sq164_tg_outbox()') is not null
     and not exists (select 1 from pg_trigger where tgrelid = 'public.cantwork_email_outbox'::regclass and tgname = 'zzz_sq164_system_skip') then
    create trigger zzz_sq164_system_skip before insert on public.cantwork_email_outbox for each row execute function public._sq164_tg_outbox();
  end if;
  if to_regprocedure('public._ts166_tg_outbox_skip()') is not null
     and not exists (select 1 from pg_trigger where tgrelid = 'public.cantwork_email_outbox'::regclass and tgname = 'zzzz_ts166_outbox_skip') then
    create trigger zzzz_ts166_outbox_skip before insert on public.cantwork_email_outbox for each row execute function public._ts166_tg_outbox_skip();
  end if;
end $$;

-- free-trial retention (0184): the queue goes with the studio data (like event_task_log 0368)
do $$ declare v_def text; begin
  if to_regprocedure('public._tr184_purge_tables()') is not null then
    v_def := pg_get_functiondef('public._tr184_purge_tables()'::regprocedure);
    if position('''cantwork_email_outbox''' in v_def) = 0 then
      if (length(v_def) - length(replace(v_def, '''crew_availability''', ''))) / length('''crew_availability''') = 1 then
        execute replace(v_def, '''crew_availability''', '''cantwork_email_outbox'', ''crew_availability''');
      else
        raise notice '0370: _tr184_purge_tables has an unexpected body - left unchanged';
      end if;
    end if;
  end if;
end $$;

-- ---- 3) helpers -------------------------------------------------------------------------------------------------------------------
-- the studio buffer: a staff member can not ask for a day off from today up to today + (buffer - 1); default 7, 0 to 60
create or replace function public._r370_buffer(p_org uuid)
returns integer language sql stable security definer set search_path = '' as $fn$
  -- r187-0370
  select least(greatest(coalesce((
    select case when jsonb_typeof(c.value -> 'bufferDays') = 'number' then round((c.value ->> 'bufferDays')::numeric) end
      from public.app_config c where c.org_id = p_org and c.key = 'cantwork'), 7), 0), 60)::integer;
$fn$;

create or replace function public._r370_too_close(p_buf integer)
returns text language sql immutable set search_path = '' as $fn$
  -- r187-0370: the sentence the owner asked for (7 days = a week)
  select case when p_buf = 7 then 'Too close - days within a week can''t be blocked here. Please call your manager.'
              when p_buf = 1 then 'Too close - today can''t be blocked here. Please call your manager.'
              else 'Too close - days within the next ' || p_buf || ' days can''t be blocked here. Please call your manager.' end;
$fn$;

-- who may approve / turn down: the owner and admins always, else anyone who can edit Staff (never crew / clients)
create or replace function public._r370_can_decide()
returns boolean language sql stable security definer set search_path = '' as $fn$
  -- r187-0370
  select auth.uid() is not null and public.current_org_id() is not null
     and coalesce(public.user_role(), '') not in ('client', 'crew', 'worker')
     and (coalesce(public.is_admin(), false) or coalesce(public.has_area('staff', 'edit'), false));
$fn$;

-- a staff member of the permanent link (work.html?staff=...): active, studio open; null otherwise
create or replace function public._r370_staff_of_link(p_token text)
returns public.crew_members language plpgsql volatile security definer set search_path = '' as $fn$
-- r187-0370
declare l public.staff_links; c public.crew_members;
begin
  perform public._r341_limit('staff_link', 600, 240);
  if p_token is null or p_token !~ '^[0-9a-f]{64}$' then return null; end if;
  select * into l from public.staff_links x where x.token = p_token and x.revoked_at is null;
  if l.id is null then return null; end if;
  select * into c from public.crew_members m where m.id = l.crew_id and m.org_id = l.org_id and m.active;
  if c.id is null or coalesce(public._r125_closed(l.org_id), false) then return null; end if;
  return c;
end $fn$;

-- the decisions a staff member has not acknowledged yet (today - 1 onwards, newest decision first)
create or replace function public._r370_decisions(p_org uuid, p_crew uuid, p_today date)
returns jsonb language sql stable security definer set search_path = '' as $fn$
  -- r187-0370
  select coalesce(jsonb_agg(jsonb_build_object('day', x.day, 'approval', x.approval, 'note', x.note, 'decision_note', x.decision_note,
                                               'decided_at', x.decided_at) order by x.decided_at desc), '[]'::jsonb)
    from (select a.day, a.approval, a.note, a.decision_note, a.decided_at from public.crew_availability a
           where a.org_id = p_org and a.crew_id = p_crew and a.requested_at is not null and a.decided_at is not null and a.ack_at is null
             and a.approval in ('approved', 'rejected') and a.day >= p_today - 1
           order by a.decided_at desc limit 20) x;
$fn$;

-- tell the office about a new request: one bell row; outside a free trial one e-mail to each owner / admin / manager /
-- Staff editor with an address (never a deactivated or unsubscribed one). Never blocks the request.
create or replace function public._r370_tell_office(p_id uuid)
returns void language plpgsql volatile security definer set search_path = '' as $fn$
-- r187-0370
declare a public.crew_availability; v_name text; p record;
begin
  select * into a from public.crew_availability x where x.id = p_id;
  if a.id is null or a.approval is distinct from 'pending' then return; end if;
  select cm.name into v_name from public.crew_members cm where cm.id = a.crew_id and cm.org_id = a.org_id;
  begin
    insert into public.notifications(quote_id, channel, kind, status, detail, org_id)
      values (null, 'in_app', 'crew_cantwork_request', 'simulated',
              jsonb_build_object('worker', left(coalesce(v_name, 'A staff member'), 80), 'day', a.day, 'crew_id', a.crew_id, 'source', '0370'), a.org_id);
  exception when others then raise warning 'r187-0370: bell notice skipped (%)', sqlstate;
  end;
  if coalesce(public._tb179_no_send(a.org_id), true) then return; end if;   -- free trial / sample / read-only: in-app only
  for p in select distinct on (lower(btrim(pr.email))) lower(btrim(pr.email)) as email, pr.full_name
             from public.profiles pr
            where pr.org_id = a.org_id and public._r361_email(pr.email) is not null
              and coalesce(pr.role, '') not in ('client', 'crew', 'worker')
              and (coalesce(pr.role, '') in ('admin', 'manager') or public._r23_area(a.org_id, pr.role, 'staff', 'edit'))
              and not public._r283_is_off(pr.id, a.org_id)
              and (to_regprocedure('public.email_is_opted_out(uuid,text)') is null or not public.email_is_opted_out(a.org_id, pr.email))
            order by lower(btrim(pr.email)), pr.id
            limit 20 loop
    begin
      insert into public.cantwork_email_outbox (org_id, avail_id, crew_id, kind, recipient, name, dedupe_key)
        values (a.org_id, a.id, a.crew_id, 'request', p.email, left(nullif(btrim(coalesce(p.full_name, '')), ''), 120),
                'cw370:req:' || a.id::text || ':' || floor(extract(epoch from a.requested_at))::bigint::text || ':' || p.email)
        on conflict (dedupe_key) do nothing;
    exception when others then raise warning 'r187-0370: office e-mail skipped (%)', sqlstate;
    end;
  end loop;
exception when others then
  raise warning 'r187-0370: office notice skipped (%)', sqlstate;
end $fn$;

-- tell the staff member the decision by e-mail (outside a free trial, when they have an address); never blocks
create or replace function public._r370_tell_staff(p_id uuid)
returns void language plpgsql volatile security definer set search_path = '' as $fn$
-- r187-0370
declare a public.crew_availability; v_p jsonb;
begin
  select * into a from public.crew_availability x where x.id = p_id;
  if a.id is null or a.decided_at is null or coalesce(a.approval, '') not in ('approved', 'rejected') then return; end if;
  if coalesce(public._tb179_no_send(a.org_id), true) then return; end if;
  v_p := public._r361_person(a.org_id, a.crew_id, null);
  if v_p is null or (v_p ->> 'email') is null then return; end if;
  if to_regprocedure('public.email_is_opted_out(uuid,text)') is not null and public.email_is_opted_out(a.org_id, v_p ->> 'email') then return; end if;
  insert into public.cantwork_email_outbox (org_id, avail_id, crew_id, kind, recipient, name, dedupe_key)
    values (a.org_id, a.id, a.crew_id, 'decision', v_p ->> 'email', left(v_p ->> 'name', 120),
            'cw370:dec:' || a.id::text || ':' || floor(extract(epoch from a.decided_at))::bigint::text)
    on conflict (dedupe_key) do nothing;
exception when others then
  raise warning 'r187-0370: staff e-mail skipped (%)', sqlstate;
end $fn$;

-- ---- 4) the staff link: mark / free a day (re-issued; the 0265 checks unchanged, plus the buffer and the request) -----------------
create or replace function public.crew_set_availability(p_token uuid, p_day date, p_status text, p_note text default null)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
-- r23-crew-0265 + r187-0370: a new day off is a pending request; the buffer is checked here, never only on the page
declare w public.work_tokens; c public.crew_members; v_today date; n int; v_note text; r record; v_clash int := 0;
        v_buf int; v_old public.crew_availability; v_new public.crew_availability; v_fresh boolean := false;
begin
  w := public._work_token_live(p_token);
  c := public._r23_crew_of_token(w);
  if c.id is null then raise exception 'This link is not linked to a staff member - ask the office.' using errcode = '42501'; end if;
  if not (public._r23_cfg(w.org_id) ->> 'availability')::boolean then
    raise exception 'Your studio has switched availability off - tell the office directly.' using errcode = '42501'; end if;
  v_today := public._a198_org_today(w.org_id);
  if p_day is null or p_day < v_today or p_day > v_today + 120 then
    raise exception 'Pick a day from today up to 120 days ahead.' using errcode = '22023'; end if;
  if p_status is null or p_status not in ('unavailable', 'available') then raise exception 'invalid status' using errcode = '22023'; end if;
  v_note := nullif(left(regexp_replace(btrim(coalesce(p_note, '')), '[[:cntrl:]<>]', ' ', 'g'), 200), '');
  perform pg_advisory_xact_lock(hashtextextended('helm.r23.avail:' || c.id::text, 0));
  select count(*) into n from public.crew_availability a where a.crew_id = c.id and a.source = 'crew' and a.updated_at > now() - interval '1 hour';
  if n >= 100 then raise exception 'Too many changes - try again in an hour.' using errcode = '54000'; end if;
  select * into v_old from public.crew_availability a where a.crew_id = c.id and a.day = p_day;
  v_buf := public._r370_buffer(w.org_id);
  if p_status = 'unavailable' then
    v_fresh := v_old.id is null or v_old.status <> 'unavailable';
    if v_fresh and p_day < v_today + v_buf then
      raise exception '%', public._r370_too_close(v_buf) using errcode = '22023', hint = 'cantwork_buffer';
    end if;
    if v_fresh then
      insert into public.crew_availability (org_id, crew_id, day, status, note, source, set_by, approval, requested_at)
        values (w.org_id, c.id, p_day, 'unavailable', v_note, 'crew', null, 'pending', now())
      on conflict (crew_id, day) do update set status = 'unavailable', note = excluded.note, source = 'crew', set_by = null, updated_at = now(),
        approval = 'pending', requested_at = now(), decided_at = null, decided_by = null, decision_note = null, ack_at = null
      returning * into v_new;
      perform public._r370_tell_office(v_new.id);
    else
      -- the day is already asked for / approved: only the reason changes, the decision stays
      update public.crew_availability set note = v_note, updated_at = now() where id = v_old.id returning * into v_new;
    end if;
  else
    insert into public.crew_availability (org_id, crew_id, day, status, note, source, set_by)
      values (w.org_id, c.id, p_day, 'available', v_note, 'crew', null)
    on conflict (crew_id, day) do update set status = 'available', note = excluded.note, source = 'crew', set_by = null, updated_at = now(),
      approval = null, ack_at = coalesce(public.crew_availability.ack_at, now())
    returning * into v_new;
  end if;
  if p_status = 'unavailable' and v_fresh then
    -- already booked that day: the office is told (once per event)
    for r in select distinct t.quote_id from public.event_tasks t join public.quotes qq on qq.id = t.quote_id and qq.deleted_at is null
              where t.org_id = w.org_id and t.crew_id = c.id and t.status not in ('rejected', 'cancelled')
                and coalesce((t.planned_start at time zone public._r23_tz(w.org_id))::date, qq.event_date) = p_day loop
      v_clash := v_clash + 1;
      perform public._r23_notify(r.quote_id, 'crew_unavailable', jsonb_build_object('worker', c.name, 'day', p_day, 'note', v_note));
    end loop;
  end if;
  return jsonb_build_object('ok', true, 'day', p_day, 'status', p_status, 'booked_that_day', v_clash > 0,
    'approval', case when p_status = 'unavailable' then coalesce(v_new.approval, 'approved') end, 'buffer_days', v_buf);
end $$;

-- the staff member taps "OK, got it" on a decision (event link); p_day null = every decision shown
create or replace function public.crew_cantwork_ack(p_token uuid, p_day date default null)
returns jsonb language plpgsql volatile security definer set search_path = '' as $fn$
-- r187-0370
declare w public.work_tokens; c public.crew_members; n integer;
begin
  w := public._work_token_live(p_token);
  c := public._r23_crew_of_token(w);
  if c.id is null then raise exception 'This link is not linked to a staff member - ask the office.' using errcode = '42501'; end if;
  update public.crew_availability set ack_at = now()
   where crew_id = c.id and org_id = w.org_id and (p_day is null or day = p_day)
     and requested_at is not null and decided_at is not null and ack_at is null;
  get diagnostics n = row_count;
  return jsonb_build_object('ok', true, 'acknowledged', n);
end $fn$;

-- the permanent link page: decisions to acknowledge + days still waiting (no other person, no event)
create or replace function public.staff_link_cantwork(p_token text)
returns jsonb language plpgsql volatile security definer set search_path = '' as $fn$
-- r187-0370
declare c public.crew_members; v_today date;
begin
  c := public._r370_staff_of_link(p_token);
  if c.id is null then return jsonb_build_object('ok', false, 'reason', 'bad_link'); end if;
  begin v_today := public._a198_org_today(c.org_id); exception when others then v_today := current_date; end;
  return jsonb_build_object('ok', true, 'today', v_today, 'buffer_days', public._r370_buffer(c.org_id),
    'decisions', public._r370_decisions(c.org_id, c.id, v_today),
    'waiting', coalesce((select jsonb_agg(jsonb_build_object('day', a.day, 'note', a.note) order by a.day)
                           from public.crew_availability a
                          where a.org_id = c.org_id and a.crew_id = c.id and a.status = 'unavailable' and a.approval = 'pending'
                            and a.day >= v_today), '[]'::jsonb));
end $fn$;

create or replace function public.staff_link_cantwork_ack(p_token text, p_day date default null)
returns jsonb language plpgsql volatile security definer set search_path = '' as $fn$
-- r187-0370
declare c public.crew_members; n integer;
begin
  c := public._r370_staff_of_link(p_token);
  if c.id is null then raise exception 'This link no longer works - ask the office for a new one.' using errcode = '42501'; end if;
  update public.crew_availability set ack_at = now()
   where crew_id = c.id and org_id = c.org_id and (p_day is null or day = p_day)
     and requested_at is not null and decided_at is not null and ack_at is null;
  get diagnostics n = row_count;
  return jsonb_build_object('ok', true, 'acknowledged', n);
end $fn$;

-- ---- 5) crew_link_home wrapped once: approval per marked day, the buffer, decisions to acknowledge ---------------------------------
do $$
declare v_src text;
begin
  select p.prosrc into v_src from pg_proc p where p.oid = to_regprocedure('public.crew_link_home(uuid)');
  if position('r187-0370' in coalesce(v_src, '')) = 0 and to_regprocedure('public.crew_link_home__pre0370(uuid)') is null then
    alter function public.crew_link_home(uuid) rename to crew_link_home__pre0370;
  end if;
  if to_regprocedure('public.crew_link_home__pre0370(uuid)') is null then
    raise exception 'STOP 0370: crew_link_home could not be kept as crew_link_home__pre0370'; end if;
end $$;

create or replace function public.crew_link_home(p_token uuid)
returns jsonb language plpgsql volatile security definer set search_path = '' as $fn$
-- r187-0370: the earlier answer (crew_link_home__pre0370: same checks), each marked day with its approval (empty = approved),
-- plus cantwork (buffer days, first day that can be asked for, decisions not acknowledged yet). Any error here returns the
-- earlier answer unchanged.
declare v jsonb := public.crew_link_home__pre0370(p_token); w public.work_tokens; c public.crew_members; v_today date; v_buf int;
begin
  if v is null or jsonb_typeof(v) <> 'object' or jsonb_typeof(v -> 'crew') is distinct from 'object' then return v; end if;
  begin
    w := public._work_token_live(p_token);
    c := public._r23_crew_of_token(w);
    if c.id is null then return v; end if;
    v_today := coalesce((v ->> 'today')::date, public._a198_org_today(w.org_id));
    v_buf := public._r370_buffer(w.org_id);
    -- the marked days are listed unless the studio switched availability off (an unreadable switch counts as on, like the
    -- staff link call itself, so a staff member always sees the days they asked for)
    if coalesce(v #>> '{settings,availability}', 'true') <> 'false' then
      v := jsonb_set(v, '{availability}', coalesce((
        select jsonb_agg(jsonb_build_object('day', a.day, 'status', a.status, 'note', a.note, 'by_office', a.source = 'office',
                                            'approval', coalesce(a.approval, 'approved'), 'decision_note', a.decision_note) order by a.day)
          from public.crew_availability a
         where a.crew_id = c.id and a.org_id = w.org_id and a.day between v_today and v_today + 120 and a.status = 'unavailable'), '[]'::jsonb));
    end if;
    v := v || jsonb_build_object('cantwork', jsonb_build_object('buffer_days', v_buf, 'first_day', v_today + v_buf,
                                                                'decisions', public._r370_decisions(w.org_id, c.id, v_today)));
  exception when others then
    raise warning 'r187-0370: crew_link_home extras skipped (%)', sqlstate;
  end;
  return v;
end $fn$;

-- ---- 6) the office -------------------------------------------------------------------------------------------------------------------
-- the Staff page list: requests waiting (badge count) and, for scope all, decisions of the last 30 days
create or replace function public.cantwork_requests(p_scope text default 'open')
returns jsonb language plpgsql stable security definer set search_path = '' as $fn$
-- r187-0370
declare v_org uuid := public.current_org_id(); v_today date; v_tz text;
begin
  if auth.uid() is null or v_org is null or coalesce(public.user_role(), '') in ('client', 'crew', 'worker') or not public.has_area('staff', 'view') then
    raise exception 'not authorized' using errcode = '42501'; end if;
  v_today := public._a198_org_today(v_org);
  v_tz := coalesce(nullif(public._r23_tz(v_org), ''), 'Asia/Kolkata');
  return jsonb_build_object(
    'today', v_today, 'buffer_days', public._r370_buffer(v_org), 'can_decide', public._r370_can_decide(),
    'pending', (select count(*) from public.crew_availability a join public.crew_members cm on cm.id = a.crew_id and cm.org_id = v_org
                 where a.org_id = v_org and a.approval = 'pending' and a.status = 'unavailable' and a.day >= v_today),
    'items', coalesce((
      select jsonb_agg(x.j order by x.waiting desc, x.day, x.name) from (
        select (a.approval = 'pending') as waiting, a.day, cm.name, jsonb_build_object(
                 'id', a.id, 'crew_id', a.crew_id, 'name', cm.name, 'department', cm.department, 'day', a.day, 'note', a.note,
                 'approval', a.approval, 'requested_at', a.requested_at, 'decided_at', a.decided_at,
                 'decided_by', nullif(btrim(coalesce(pr.full_name, '')), ''), 'decision_note', a.decision_note, 'ack_at', a.ack_at,
                 'booked', exists (select 1 from public.event_tasks t join public.quotes q on q.id = t.quote_id and q.org_id = v_org and q.deleted_at is null
                                    where t.org_id = v_org and t.crew_id = a.crew_id and t.status not in ('rejected', 'cancelled')
                                      and coalesce(q.status, '') not in ('cancelled', 'lost')
                                      and coalesce((t.planned_start at time zone v_tz)::date, q.event_date) = a.day)) as j
          from public.crew_availability a
          join public.crew_members cm on cm.id = a.crew_id and cm.org_id = v_org
          left join public.profiles pr on pr.id = a.decided_by
         where a.org_id = v_org and a.requested_at is not null
           and ((a.approval = 'pending' and a.status = 'unavailable' and a.day >= v_today)
                or (coalesce(p_scope, 'open') = 'all' and a.approval in ('approved', 'rejected') and a.decided_at > now() - interval '30 days'))
         order by (a.approval = 'pending') desc, a.day, cm.name
         limit 200) x), '[]'::jsonb));
end $fn$;

-- approve / turn down a request (optional note to the staff member). Approving keeps the day off; turning down frees the day.
create or replace function public.cantwork_decide(p_id uuid, p_decision text, p_note text default null)
returns jsonb language plpgsql volatile security definer set search_path = '' as $fn$
-- r187-0370
declare v_org uuid := public.current_org_id(); a public.crew_availability; v_note text; v_ok boolean;
begin
  if not public._r370_can_decide() then
    raise exception 'Only the owner, an admin or someone who can edit Staff can approve days off.' using errcode = '42501'; end if;
  if p_decision is null or p_decision not in ('approve', 'reject') then raise exception 'Choose approve or turn down.' using errcode = '22023'; end if;
  select * into a from public.crew_availability x where x.id = p_id and x.org_id = v_org for update;
  if a.id is null then raise exception 'request not found' using errcode = 'P0002'; end if;
  if a.requested_at is null then
    raise exception 'This day was not asked for by the staff member - change it on the Availability grid.' using errcode = '22023'; end if;
  if (p_decision = 'approve' and a.approval = 'approved' and a.status = 'unavailable') or (p_decision = 'reject' and a.approval = 'rejected') then
    return jsonb_build_object('ok', true, 'id', a.id, 'approval', a.approval, 'already', true); end if;
  if a.approval = 'pending' and a.status <> 'unavailable' then
    raise exception 'The staff member already freed this day.' using errcode = '22023'; end if;
  if a.approval is null then
    raise exception 'The staff member already freed this day.' using errcode = '22023'; end if;
  v_note := nullif(left(btrim(regexp_replace(coalesce(p_note, ''), '[[:cntrl:]<>]', ' ', 'g')), 200), '');
  v_ok := p_decision = 'approve';
  update public.crew_availability
     set status = case when v_ok then 'unavailable' else 'available' end, approval = case when v_ok then 'approved' else 'rejected' end,
         decided_at = now(), decided_by = auth.uid(), decision_note = v_note, ack_at = null, updated_at = now()
   where id = a.id returning * into a;
  begin
    insert into public.audit_log(actor, action, entity, entity_id, changed, org_id)
      values (auth.uid(), case when v_ok then 'cantwork.approve' else 'cantwork.reject' end, 'crew_availability', a.id::text,
              jsonb_build_object('crew_id', a.crew_id, 'day', a.day, 'note', v_note), v_org);
  exception when others then raise warning 'r187-0370: audit skipped (%)', sqlstate;
  end;
  perform public._r370_tell_staff(a.id);
  return jsonb_build_object('ok', true, 'id', a.id, 'approval', a.approval, 'day', a.day);
end $fn$;

-- the office grid (re-issued): a day the office marks is approved at once (inside the buffer too); freeing a pending request
-- from the grid counts as turned down
create or replace function public.crew_availability_set(p_crew uuid, p_day date, p_status text, p_note text default null)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
-- r23-crew-0265 + r187-0370
declare v_org uuid := public.current_org_id(); v_today date; v_note text; v_old public.crew_availability; v_new public.crew_availability;
begin
  if auth.uid() is null or v_org is null or not public.has_area('staff', 'edit') then
    raise exception 'Only people who can edit Staff can change availability.' using errcode = '42501'; end if;
  if not exists (select 1 from public.crew_members cm where cm.id = p_crew and cm.org_id = v_org) then
    raise exception 'staff member not found' using errcode = 'P0002'; end if;
  v_today := public._a198_org_today(v_org);
  if p_day is null or p_day < v_today - 30 or p_day > v_today + 365 then
    raise exception 'Pick a day from 30 days ago up to a year ahead.' using errcode = '22023'; end if;
  if p_status is null or p_status not in ('unavailable', 'available') then raise exception 'invalid status' using errcode = '22023'; end if;
  v_note := nullif(left(regexp_replace(btrim(coalesce(p_note, '')), '[[:cntrl:]<>]', ' ', 'g'), 200), '');
  select * into v_old from public.crew_availability a where a.crew_id = p_crew and a.day = p_day and a.org_id = v_org for update;
  insert into public.crew_availability (org_id, crew_id, day, status, note, source, set_by, approval, decided_at, decided_by)
    values (v_org, p_crew, p_day, p_status, v_note, 'office', auth.uid(),
            case when p_status = 'unavailable' then 'approved' end, case when p_status = 'unavailable' then now() end,
            case when p_status = 'unavailable' then auth.uid() end)
  on conflict (crew_id, day) do update set status = excluded.status, note = excluded.note, source = 'office', set_by = auth.uid(), updated_at = now(),
    approval = case when excluded.status = 'unavailable' then 'approved'
                    when public.crew_availability.approval = 'pending' and public.crew_availability.status = 'unavailable' then 'rejected' end,
    decided_at = case when excluded.status = 'unavailable' or public.crew_availability.approval = 'pending' then now() else public.crew_availability.decided_at end,
    decided_by = case when excluded.status = 'unavailable' or public.crew_availability.approval = 'pending' then auth.uid() else public.crew_availability.decided_by end,
    ack_at = case when public.crew_availability.approval = 'pending' then null else coalesce(public.crew_availability.ack_at, now()) end
  returning * into v_new;
  if v_old.approval = 'pending' then perform public._r370_tell_staff(v_new.id); end if;
  return jsonb_build_object('ok', true, 'crew_id', p_crew, 'day', p_day, 'status', p_status, 'approval', v_new.approval);
end $$;

-- the per-studio buffer (Settings -> Crew)
create or replace function public.cantwork_settings_get()
returns jsonb language plpgsql stable security definer set search_path = '' as $fn$
-- r187-0370
declare v_org uuid := public.current_org_id();
begin
  if auth.uid() is null or v_org is null or coalesce(public.user_role(), '') in ('client', 'crew', 'worker') then
    raise exception 'not authorized' using errcode = '42501'; end if;
  if not (public.has_area('staff', 'view') or public.has_area('controls', 'view')) then raise exception 'not authorized' using errcode = '42501'; end if;
  return jsonb_build_object('buffer_days', public._r370_buffer(v_org), 'can_edit', public.has_area('controls', 'edit'));
end $fn$;

create or replace function public.cantwork_settings_set(p_buffer_days integer)
returns jsonb language plpgsql volatile security definer set search_path = '' as $fn$
-- r187-0370
declare v_org uuid := public.current_org_id();
begin
  if auth.uid() is null or v_org is null or coalesce(public.user_role(), '') = 'client' or not public.has_area('controls', 'edit') then
    raise exception 'Only a studio admin (or someone allowed to edit Control Center) can change the crew settings.' using errcode = '42501'; end if;
  if p_buffer_days is null or p_buffer_days < 0 or p_buffer_days > 60 then
    raise exception 'The notice for a day off must be 0 to 60 days.' using errcode = '22023'; end if;
  insert into public.app_config (org_id, key, value, updated_at) values (v_org, 'cantwork', jsonb_build_object('bufferDays', p_buffer_days), now())
  on conflict (org_id, key) do update
    set value = (case when jsonb_typeof(public.app_config.value) = 'object' then public.app_config.value else '{}'::jsonb end)
                || jsonb_build_object('bufferDays', p_buffer_days), updated_at = now();
  return public.cantwork_settings_get();
end $fn$;

-- ---- 7) the assign warning, the Team calendar and Conflicts carry the approval (same answers otherwise) -------------------------
create or replace function public.crew_availability_range(p_from date, p_to date, p_crew uuid default null)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
-- r23-crew-0265 + r187-0370: approval added (empty = approved)
declare v_org uuid := public.current_org_id();
begin
  if auth.uid() is null or v_org is null or not public.has_area('staff', 'view') then raise exception 'not authorized' using errcode = '42501'; end if;
  if p_from is null or p_to is null or p_to < p_from or p_to - p_from > 92 then raise exception 'pick a range of up to 92 days' using errcode = '22023'; end if;
  return coalesce((select jsonb_agg(jsonb_build_object('crew_id', a.crew_id, 'day', a.day, 'status', a.status, 'note', a.note,
                                                        'source', a.source, 'updated_at', a.updated_at, 'id', a.id,
                                                        'approval', coalesce(a.approval, 'approved'), 'requested_at', a.requested_at,
                                                        'decided_at', a.decided_at) order by a.day, a.crew_id)
                     from public.crew_availability a
                    where a.org_id = v_org and a.day between p_from and p_to and a.status = 'unavailable'
                      and (p_crew is null or a.crew_id = p_crew)), '[]'::jsonb);
end $$;

create or replace function public.crew_day_status(p_date date, p_exclude_quote uuid default null)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
-- r23-crew-0265 + r187-0370: approval added (pending = asked off, waiting; approved = approved day off)
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
           and coalesce(qq.status, '') not in ('cancelled', 'lost') and coalesce(qq.lifecycle_stage, '') not in ('closed', 'cancelled', 'archived')
           and (p_exclude_quote is null or qq.id <> p_exclude_quote)
           and coalesce((t.planned_start at time zone v_tz)::date, qq.event_date) = p_date) b on true
     where cm.org_id = v_org and cm.active and (u.day is not null or b.codes is not null)), '[]'::jsonb);
end $$;

create or replace function public.crew_unavailable_conflicts(p_from date, p_to date)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
-- r174-0365 + r187-0370: approval added
declare v_org uuid := public.current_org_id(); v_tz text;
begin
  if auth.uid() is null or v_org is null or not public.has_area('staff', 'view') then raise exception 'not authorized' using errcode = '42501'; end if;
  if p_from is null or p_to is null or p_to < p_from or p_to - p_from > 92 then raise exception 'pick a range of up to 92 days' using errcode = '22023'; end if;
  v_tz := coalesce(nullif(public._r23_tz(v_org), ''), 'Asia/Kolkata');
  return coalesce((
    select jsonb_agg(jsonb_build_object('crew_id', x.crew_id, 'name', x.name, 'day', x.day, 'note', x.note, 'events', x.events,
                                        'approval', x.approval)
                     order by x.day, x.name)
      from (
        select a.crew_id, cm.name, a.day, a.note, coalesce(a.approval, 'approved') as approval,
               jsonb_agg(distinct jsonb_build_object('id', q.id, 'code', q.code)) as events
          from public.crew_availability a
          join public.crew_members cm on cm.id = a.crew_id and cm.org_id = v_org
          join public.event_tasks t on t.crew_id = a.crew_id and t.org_id = v_org
                                   and t.status not in ('rejected', 'cancelled', 'completed')
          join public.quotes q on q.id = t.quote_id and q.org_id = v_org and q.deleted_at is null
                              and coalesce(q.status, '') not in ('cancelled', 'lost')
                              and coalesce(q.lifecycle_stage, '') not in ('closed', 'cancelled', 'archived')
         where a.org_id = v_org and a.status = 'unavailable' and a.day between p_from and p_to
           and coalesce((t.planned_start at time zone v_tz)::date, q.event_date) = a.day
         group by a.crew_id, cm.name, a.day, a.note, coalesce(a.approval, 'approved')
      ) x), '[]'::jsonb);
end $$;

-- ---- 8) comms-dispatch: claim / mark the e-mails (server only). Every row is re-checked at send time. -----------------------------
create or replace function public.cantwork_email_claim(p_limit integer default 25)
returns jsonb language plpgsql volatile security definer set search_path = '' as $fn$
-- r187-0370: fails closed (skipped) when anything changed since the row was queued
declare r record; a public.crew_availability; v_out jsonb := '[]'::jsonb; v_why text; v_name text; v_by text; v_link text; v_ident jsonb; v_p jsonb;
begin
  update public.cantwork_email_outbox set status = 'failed', reason = 'too_many_attempts', sent_at = now(), updated_at = now()
   where sent_at is null and status = 'pending' and attempts >= 5;
  update public.cantwork_email_outbox set status = 'skipped', reason = 'too_old', sent_at = now(), updated_at = now()
   where sent_at is null and status = 'pending' and created_at < now() - interval '2 days';
  for r in select o.* from public.cantwork_email_outbox o
            where o.sent_at is null and o.status = 'pending' and o.not_before <= now()
              and (o.claimed_at is null or o.claimed_at < now() - interval '10 minutes')
            order by o.not_before limit greatest(1, least(coalesce(p_limit, 25), 100)) for update of o skip locked
  loop
    v_why := null; a := null; v_link := null;
    select * into a from public.crew_availability x where x.id = r.avail_id and x.org_id = r.org_id;
    if a.id is null then v_why := 'gone';
    elsif coalesce(public._tb179_no_send(r.org_id), true) then v_why := 'trial';
    elsif coalesce(public._r283_off_email(r.org_id, r.recipient), false) then v_why := 'deactivated';
    elsif r.kind = 'request' and (a.approval is distinct from 'pending' or a.status <> 'unavailable') then v_why := 'decided';
    elsif r.kind = 'decision' and (coalesce(a.approval, '') not in ('approved', 'rejected') or a.decided_at is null) then v_why := 'changed';
    end if;
    if v_why is null and r.kind = 'decision' then
      v_p := public._r361_person(r.org_id, a.crew_id, null);
      if v_p is null or (v_p ->> 'email') is distinct from r.recipient then v_why := 'person_changed'; end if;
    end if;
    if v_why is not null then
      update public.cantwork_email_outbox set status = 'skipped', reason = v_why, sent_at = now(), updated_at = now() where id = r.id;
      continue;
    end if;
    select cm.name into v_name from public.crew_members cm where cm.id = a.crew_id and cm.org_id = r.org_id;
    select nullif(btrim(coalesce(pr.full_name, '')), '') into v_by from public.profiles pr where pr.id = a.decided_by;
    if r.kind = 'decision' then v_link := public._r363_link(r.org_id, a.crew_id); end if;
    select jsonb_build_object('from_name', cs.email_from_name, 'reply_to', cs.email_reply_to) into v_ident
      from public.comms_settings cs where cs.org_id = r.org_id;
    update public.cantwork_email_outbox set claimed_at = now(), attempts = attempts + 1, updated_at = now() where id = r.id;
    v_out := v_out || jsonb_build_array(jsonb_build_object(
      'id', r.id, 'to', r.recipient, 'kind', r.kind, 'name', r.name, 'studio', (select o.name from public.organizations o where o.id = r.org_id),
      'worker', v_name, 'day', to_char(a.day, 'DD/MM/YYYY'), 'weekday', trim(to_char(a.day, 'Dy')), 'note', a.note,
      'approval', a.approval, 'decision_note', a.decision_note, 'decided_by', v_by,
      'link_path', case when r.kind = 'request' then 'staff.html#cantwork-requests' else v_link end,
      'identity', coalesce(v_ident, '{}'::jsonb)));
  end loop;
  return v_out;
end $fn$;

create or replace function public.cantwork_email_mark(p_id uuid, p_status text)
returns text language plpgsql volatile security definer set search_path = '' as $fn$
-- r187-0370
begin
  if p_status is null or p_status not in ('sent', 'skipped', 'failed', 'retry') then raise exception 'bad status' using errcode = '22023'; end if;
  if p_status = 'retry' then
    update public.cantwork_email_outbox set claimed_at = null, updated_at = now() where id = p_id and sent_at is null;
    return 'pending';
  end if;
  update public.cantwork_email_outbox set status = p_status, sent_at = now(), updated_at = now() where id = p_id and sent_at is null;
  return p_status;
end $fn$;

-- ---- 9) grants: staff link calls for link holders, office calls for signed-in members, the rest server only ----------------------
do $$
declare f text;
begin
  foreach f in array array['public._r370_buffer(uuid)', 'public._r370_too_close(integer)', 'public._r370_can_decide()',
                           'public._r370_staff_of_link(text)', 'public._r370_decisions(uuid,uuid,date)', 'public._r370_tell_office(uuid)',
                           'public._r370_tell_staff(uuid)', 'public.crew_link_home__pre0370(uuid)',
                           'public.cantwork_email_claim(integer)', 'public.cantwork_email_mark(uuid,text)'] loop
    execute format('revoke all on function %s from public', f);
    if exists (select 1 from pg_roles where rolname = 'anon') then execute format('revoke all on function %s from anon', f); end if;
    if exists (select 1 from pg_roles where rolname = 'authenticated') then execute format('revoke all on function %s from authenticated', f); end if;
  end loop;
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    execute 'grant execute on function public.cantwork_email_claim(integer) to service_role';
    execute 'grant execute on function public.cantwork_email_mark(uuid,text) to service_role';
  end if;
  -- link holders (no login): the staff link calls; each one checks its own link
  foreach f in array array['public.crew_set_availability(uuid,date,text,text)', 'public.crew_link_home(uuid)', 'public.crew_cantwork_ack(uuid,date)',
                           'public.staff_link_cantwork(text)', 'public.staff_link_cantwork_ack(text,date)'] loop
    execute format('revoke all on function %s from public', f);
    if exists (select 1 from pg_roles where rolname = 'anon') then execute format('grant execute on function %s to anon', f); end if;
    if exists (select 1 from pg_roles where rolname = 'authenticated') then execute format('grant execute on function %s to authenticated', f); end if;
  end loop;
  -- signed-in office members: each function checks the studio and the area inside
  foreach f in array array['public.cantwork_requests(text)', 'public.cantwork_decide(uuid,text,text)', 'public.crew_availability_set(uuid,date,text,text)',
                           'public.cantwork_settings_get()', 'public.cantwork_settings_set(integer)', 'public.crew_availability_range(date,date,uuid)',
                           'public.crew_day_status(date,uuid)', 'public.crew_unavailable_conflicts(date,date)'] loop
    execute format('revoke all on function %s from public', f);
    if exists (select 1 from pg_roles where rolname = 'anon') then execute format('revoke all on function %s from anon', f); end if;
    if exists (select 1 from pg_roles where rolname = 'authenticated') then execute format('grant execute on function %s to authenticated', f); end if;
  end loop;
end $$;

-- VERIFY every line should say true
select item, ok from (values
  ('01 request columns on crew_availability (empty = approved)', (select count(*) from information_schema.columns where table_schema = 'public'
     and table_name = 'crew_availability' and column_name in ('approval', 'requested_at', 'decided_at', 'decided_by', 'decision_note', 'ack_at')) = 6
     and exists (select 1 from pg_constraint where conrelid = 'public.crew_availability'::regclass and conname = 'crew_availability_approval_r370')),
  ('02 e-mail queue, RLS on, closed to the app', to_regclass('public.cantwork_email_outbox') is not null
     and coalesce((select c.relrowsecurity from pg_class c where c.oid = to_regclass('public.cantwork_email_outbox')), false)
     and not has_table_privilege('authenticated', 'public.cantwork_email_outbox', 'select')
     and not has_table_privilege('anon', 'public.cantwork_email_outbox', 'select')),
  ('03 staff link: request with buffer, acknowledge', position('r187-0370' in coalesce(pg_get_functiondef(to_regprocedure('public.crew_set_availability(uuid,date,text,text)')), '')) > 0
     and has_function_privilege('anon', 'public.crew_cantwork_ack(uuid,date)', 'execute')
     and has_function_privilege('anon', 'public.staff_link_cantwork(text)', 'execute')
     and has_function_privilege('anon', 'public.staff_link_cantwork_ack(text,date)', 'execute')),
  ('04 crew link home wrapped once (old body kept, closed)', to_regprocedure('public.crew_link_home__pre0370(uuid)') is not null
     and position('r187-0370' in coalesce(pg_get_functiondef(to_regprocedure('public.crew_link_home(uuid)')), '')) > 0
     and has_function_privilege('anon', 'public.crew_link_home(uuid)', 'execute')
     and not has_function_privilege('anon', 'public.crew_link_home__pre0370(uuid)', 'execute')),
  ('05 office list / decide / settings for signed-in only', has_function_privilege('authenticated', 'public.cantwork_requests(text)', 'execute')
     and has_function_privilege('authenticated', 'public.cantwork_decide(uuid,text,text)', 'execute')
     and not has_function_privilege('anon', 'public.cantwork_decide(uuid,text,text)', 'execute')
     and not has_function_privilege('anon', 'public.cantwork_requests(text)', 'execute')
     and not has_function_privilege('anon', 'public.cantwork_settings_set(integer)', 'execute')),
  ('06 assign warning / calendar / conflicts carry the approval', position('r187-0370' in coalesce(pg_get_functiondef(to_regprocedure('public.crew_day_status(date,uuid)')), '')) > 0
     and position('r187-0370' in coalesce(pg_get_functiondef(to_regprocedure('public.crew_availability_range(date,date,uuid)')), '')) > 0
     and position('r187-0370' in coalesce(pg_get_functiondef(to_regprocedure('public.crew_unavailable_conflicts(date,date)')), '')) > 0),
  ('07 e-mail claim server only, helpers closed', not has_function_privilege('authenticated', 'public.cantwork_email_claim(integer)', 'execute')
     and not has_function_privilege('anon', 'public.cantwork_email_mark(uuid,text)', 'execute')
     and not has_function_privilege('authenticated', 'public._r370_tell_office(uuid)', 'execute')
     and not has_function_privilege('anon', 'public._r370_staff_of_link(text)', 'execute')),
  ('08 free-trial purge knows the queue (or 0184 is absent)', to_regprocedure('public._tr184_purge_tables()') is null
     or position('cantwork_email_outbox' in pg_get_functiondef(to_regprocedure('public._tr184_purge_tables()'))) > 0)
) v(item, ok) order by item;
