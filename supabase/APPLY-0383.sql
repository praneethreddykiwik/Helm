-- APPLY-0383 (R205 teammate sign-in notices: "Ravi Kumar (Planner) signed in - 10:42 AM" in the bell of the studio owner + admins).
-- Run on STAGING first, then production. Safe to run twice. Paste the whole file into the Supabase SQL editor and press Run.
-- Adds: a trigger on auth.users (after Supabase Auth writes last_sign_in_at) and one on profiles (an invited person joining), two
-- small tables (the studio setting + a sign-in log, no app access), Settings -> Notifications -> "Teammate sign-ins" (Off / First
-- sign-in each day = default / Every sign-in, Only roles = all except Crew by default), a bell type "Teammate sign-ins" (owner +
-- admins only), an audit row per sign-in (auth.sign_in) and a browser fallback (signin_notice_ping) used only if the trigger is refused.
-- Nothing existing is changed or deleted; five functions are wrapped once (old bodies kept as __pre0383).
-- The last result lists checks - every ok must be true. If ONLY check 03 is false, this Supabase project refused a trigger on
-- auth.users (a NOTICE said so): everything else is in place and the app fallback (each signed-in tab says so once per session)
-- gives the same notices - nothing else to do.
-- After it: run CHECK-PROD-MIGRATIONS.sql (0383 should be "present").
begin;
-- 0383_r205_signin_notice.sql - R205 (owner 18 Nov 2026: "When someone logs in, the admin should get a notification like
-- 'a person with role X logged in'"). Forward-only, additive, safe to run twice. ASCII only.
-- REQUIRES 0036 (notification prefs: notification_catalog / notification_type_of / notify_default), 0042 (_a42_is_operator_email),
--          0164 (system-quiet bell rule), 0248 (reserved_email_domain), 0266 (_r23_tz), 0283 (_r283_owner / _r283_is_off),
--          0358 (cached notification_catalog), 0373 (the newest _r23_visible / bell_feed wrappers).
--
-- In plain words:
--   When a teammate really signs in (password, Google, an e-mail link or an invitation link), the studio's OWNER and ADMINS get a
--   bell notice: "Ravi Kumar (Planner) signed in - 10:42 AM - Chrome on Windows" (studio time zone; the browser and system come
--   from the sign-in's own browser name, never the network address). A teammate added or invited who signs in for the first
--   time gets "Spandana (Event manager) signed in for the first time - 9:05 AM". Clicking it opens Settings -> Users & invites
--   with that person's details. The person never gets a notice about their own sign-in, and Helm HQ staff never cause one.
--
--   HOW A SIGN-IN IS SEEN (server side, nothing in the browser): Supabase Auth writes auth.users.last_sign_in_at on every real
--   sign-in. An AFTER UPDATE OF last_sign_in_at trigger on auth.users (zz_r383_signin_notice) hands it to _r383_signin(). The
--   newest auth.sessions row of that person gives the session id + browser; a session already seen is a token refresh, not a
--   sign-in, and is ignored. An invited person signs in BEFORE they belong to the studio (accept_invitation runs just after),
--   so a second trigger on profiles (zz_r383_join_notice: AFTER UPDATE OF org_id) sends the first-time notice when someone who
--   signed in within the last 30 minutes joins a studio.
--   NEVER BLOCKS OR SLOWS A SIGN-IN: both triggers swallow every error (WARNING only, never an exception), do a handful of
--   indexed lookups and at most three small inserts.
--   A hand edit of last_sign_in_at in the SQL editor / dashboard (session postgres or supabase_admin) is not a sign-in.
--   SUPABASE LIMITATION + FALLBACK: Helm already keeps triggers on auth.users / auth.identities made from the SQL editor (0053,
--   0248, 0288). If a Supabase project ever refuses one (42501 "must be owner of table users"), this file does NOT fail: the
--   trigger is skipped with a NOTICE, check 03 of APPLY-0383 shows false, and the app's fallback takes over by itself: every
--   signed-in tab calls signin_notice_ping() once per session (store-api.js); the server ignores it while the trigger is on.
--
--   NOISE CONTROL (per studio, Settings -> Notifications -> "Teammate sign-ins", admins only):
--     Tell admins when teammates sign in:  Off  |  First sign-in each day (DEFAULT)  |  Every sign-in
--     Only roles: every office role except Crew by default (Crew / worker logins say nothing unless ticked).
--     Always: never for the admin's own sign-in, never for HQ staff (Helm operators, helm.events addresses), never for the
--     sample studio, never for a deactivated member or a client login; at most one notice per person per 10 minutes; a
--     first-ever sign-in is always told (unless Off or the role is not ticked).
--   Who sees the notice: only the people named on it (owner + active admins, minus the person) - the bell list, the inbox,
--   the unread count and digests (_r23_visible / bell_feed wrapped once, like 0369 / 0373) and direct reads of the table
--   (restrictive policy). Its own notification type "Teammate sign-ins" (admins only by default) so an admin can mute it in
--   their own notification settings. An e-mail digest is not built (off; nothing is e-mailed).
--   AUDIT: each real sign-in in a studio is also written to the audit log (action auth.sign_in, the person as actor; role,
--   first time yes / no, browser / system hint) - also when the notice is off.
--
-- New: tables signin_notice_settings (one row per studio once saved) + signin_notice_log (one row per real sign-in seen, for
--   "first of the day", the 10-minute rule and refresh detection); helpers _r383_*; settings calls signin_notice_settings_get /
--   signin_notice_settings_set; the fallback signin_notice_ping(text); triggers zz_r383_signin_notice (auth.users) and
--   zz_r383_join_notice (profiles); three restrictive policies on notifications (kind team_signin).
-- Wrapped once (old bodies kept as __pre0383, no app privilege): _r23_visible, bell_feed, notification_catalog,
--   notification_type_of, notify_default.
-- ZERO DATA LOSS: no existing table, column, row or policy is changed or deleted; nothing is ever deleted by this feature. The
--   free-trial retention (0184) lists both new tables as KEPT (like the audit log), so they are never purged either.
-- Undo: drop trigger zz_r383_signin_notice on auth.users; drop trigger zz_r383_join_notice on public.profiles;
--   (the notices stop; everything else can stay - the setting "Off" does the same from the app).

-- ---- 0) preflight ------------------------------------------------------------------------------------------------------
do $$ begin
  if to_regclass('public.notifications') is null or to_regclass('public.audit_log') is null or to_regclass('public.profiles') is null then
    raise exception 'STOP 0383: notifications / audit_log / profiles missing'; end if;
  if to_regprocedure('public._r23_visible(uuid,uuid)') is null or to_regprocedure('public.bell_feed(integer)') is null
     or to_regprocedure('public._r23_visible__pre0373(uuid,uuid)') is null then
    raise exception 'STOP 0383: the bell wrappers of 0373 are missing - run 0373 first'; end if;
  if to_regprocedure('public.notification_catalog()') is null or to_regprocedure('public.notification_type_of(text,text)') is null
     or to_regprocedure('public.notify_default(uuid,text,text,text)') is null then
    raise exception 'STOP 0383: notification catalog (0036 / 0354 / 0358) missing'; end if;
  if to_regprocedure('public._r283_owner(uuid)') is null or to_regprocedure('public._r283_is_off(uuid,uuid)') is null then
    raise exception 'STOP 0383: team safety helpers (0283) missing'; end if;
  if to_regprocedure('public._r23_tz(uuid)') is null or to_regprocedure('public.reserved_email_domain(text)') is null
     or to_regprocedure('public._a42_is_operator_email(text)') is null or to_regprocedure('public._trial_locked(uuid)') is null then
    raise exception 'STOP 0383: _r23_tz (0266) / reserved_email_domain (0248) / _a42_is_operator_email (0042) / _trial_locked (0183) missing'; end if;
  if to_regclass('auth.users') is null then raise exception 'STOP 0383: auth.users missing'; end if;
end $$;

-- ---- 1) tables (no app privilege: read and written only through the functions below) --------------------------------------
create table if not exists public.signin_notice_settings (
  org_id     uuid primary key references public.organizations(id),
  mode       text not null default 'first_daily',
  roles      text[],                                   -- null = the default (every office role except crew / worker)
  updated_at timestamptz not null default now(),
  updated_by uuid
);
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'signin_notice_settings_mode_chk' and conrelid = 'public.signin_notice_settings'::regclass) then
    alter table public.signin_notice_settings add constraint signin_notice_settings_mode_chk check (mode in ('off', 'first_daily', 'every'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'signin_notice_settings_roles_chk' and conrelid = 'public.signin_notice_settings'::regclass) then
    alter table public.signin_notice_settings add constraint signin_notice_settings_roles_chk check (roles is null or cardinality(roles) <= 30);
  end if;
end $$;

create table if not exists public.signin_notice_log (
  id           uuid primary key default gen_random_uuid(),
  org_id       uuid not null references public.organizations(id),
  user_id      uuid not null,
  session_id   uuid,
  signed_in_at timestamptz not null default now(),
  first_time   boolean not null default false,
  device       text,
  via          text not null default 'trigger',
  notified     boolean not null default false,
  reason       text
);
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'signin_notice_log_via_chk' and conrelid = 'public.signin_notice_log'::regclass) then
    alter table public.signin_notice_log add constraint signin_notice_log_via_chk check (via in ('trigger', 'join', 'ping'));
  end if;
end $$;
create index if not exists signin_notice_log_user_idx on public.signin_notice_log (user_id, org_id, signed_in_at desc);
create index if not exists signin_notice_log_session_idx on public.signin_notice_log (session_id) where session_id is not null;

alter table public.signin_notice_settings enable row level security;
alter table public.signin_notice_log enable row level security;
do $$ declare t text; r text; begin
  foreach t in array array['public.signin_notice_settings', 'public.signin_notice_log'] loop
    execute 'revoke all on table ' || t || ' from public';
    foreach r in array array['anon', 'authenticated'] loop
      if exists (select 1 from pg_roles where rolname = r) then execute format('revoke all on table %s from %I', t, r); end if;
    end loop;
  end loop;
end $$;
-- the setting follows the studio read-only rule (suspended / ended trial) like every studio setting; the log is a system
-- record written by the sign-in trigger and stays writable (a sign-in to a read-only studio is still recorded)
do $$ begin
  if to_regprocedure('public.tg_studio_read_only()') is not null
     and not exists (select 1 from pg_trigger where tgrelid = 'public.signin_notice_settings'::regclass and tgname = 'zzz_studio_read_only') then
    execute 'create trigger zzz_studio_read_only before insert or update or delete on public.signin_notice_settings for each row execute function public.tg_studio_read_only(''org_id'')';
  end if;
end $$;

-- ---- 2) small helpers --------------------------------------------------------------------------------------------------
-- "Chrome on Windows" / "Safari on iPhone" from a browser's user agent (never stored raw, never the network address)
create or replace function public._r383_device(p_ua text)
returns text language sql immutable set search_path = '' as $fn$
  -- r205-0383
  select case when coalesce(btrim(p_ua), '') = '' then null else nullif(concat_ws(' on ',
    case when ua ~* 'edg(e|a|ios)?/' then 'Edge' when ua ~* 'opr/|opera' then 'Opera' when ua ~* 'samsungbrowser' then 'Samsung Internet'
         when ua ~* 'firefox/|fxios' then 'Firefox' when ua ~* 'chrome/|crios|chromium' then 'Chrome' when ua ~* 'safari/' then 'Safari' end,
    case when ua ~* 'iphone' then 'iPhone' when ua ~* 'ipad' then 'iPad' when ua ~* 'android' then 'Android' when ua ~* 'windows' then 'Windows'
         when ua ~* 'cros' then 'Chromebook' when ua ~* 'mac os x|macintosh' then 'Mac' when ua ~* 'linux' then 'Linux' end), '') end
    from (select left(coalesce(p_ua, ''), 400) as ua) x;
$fn$;

-- the role names people see (same words as the app)
create or replace function public._r383_role_label(p_role text)
returns text language sql immutable set search_path = '' as $fn$
  -- r205-0383
  select case lower(coalesce(p_role, '')) when 'admin' then 'Admin' when 'manager' then 'Event manager' when 'planner' then 'Planner'
    when 'sales' then 'Sales' when 'coordinator' then 'Event coordinator' when 'supervisor' then 'Supervisor' when 'quality' then 'Quality engineer'
    when 'operations' then 'Operations' when 'designer' then 'Designer' when 'crew' then 'Crew' when 'worker' then 'Crew'
    else initcap(replace(lower(coalesce(nullif(btrim(p_role), ''), 'team member')), '_', ' ')) end;
$fn$;

-- the roles a studio can tick (office roles + crew); the default = all of them except crew / worker
create or replace function public._r383_roles_all()
returns text[] language sql immutable set search_path = '' as $fn$
  -- r205-0383
  select array['admin', 'manager', 'planner', 'sales', 'coordinator', 'supervisor', 'quality', 'operations', 'designer', 'crew']::text[];
$fn$;

-- the studio setting (defaults when never saved)
create or replace function public._r383_cfg(p_org uuid)
returns jsonb language sql stable security definer set search_path = '' as $fn$
  -- r205-0383
  select jsonb_build_object(
    'mode', coalesce(s.mode, 'first_daily'),
    'roles', to_jsonb(coalesce(s.roles, array['admin', 'manager', 'planner', 'sales', 'coordinator', 'supervisor', 'quality', 'operations', 'designer']::text[])),
    'roles_default', s.roles is null,
    'saved', s.org_id is not null,
    'updated_at', s.updated_at,
    'email_digest', false)
    from (select 1) one left join public.signin_notice_settings s on s.org_id = p_org;
$fn$;

-- HQ staff (Helm operators, Helm's own e-mail domains) never cause a notice
create or replace function public._r383_is_hq(p_email text)
returns boolean language plpgsql stable security definer set search_path = '' as $fn$
-- r205-0383
begin
  if coalesce(btrim(p_email), '') = '' then return false; end if;
  return coalesce(public._a42_is_operator_email(p_email), false) or public.reserved_email_domain(p_email) is not null;
exception when others then return false;
end $fn$;

-- may a trigger here say "signed in"? Not for a hand edit in the SQL editor / dashboard (they connect as postgres or
-- supabase_admin; Supabase Auth connects as supabase_auth_admin, the app as authenticator). helm.signin_notice = 'off' keeps a
-- session quiet (the DB test suites), 'on' forces it (testing from the SQL editor on staging).
create or replace function public._r383_trigger_may()
returns boolean language sql stable set search_path = '' as $fn$
  -- r205-0383
  select case coalesce(current_setting('helm.signin_notice', true), '')
           when 'off' then false when 'on' then true
           else session_user::text not in ('postgres', 'supabase_admin') end;
$fn$;

-- is the auth.users trigger in place (then the browser fallback does nothing)?
create or replace function public._r383_trigger_on()
returns boolean language sql stable security definer set search_path = '' as $fn$
  -- r205-0383
  select exists (select 1 from pg_catalog.pg_trigger t
                  where t.tgname = 'zz_r383_signin_notice' and t.tgrelid = to_regclass('auth.users') and t.tgenabled <> 'D');
$fn$;

-- ---- 3) the core: one real sign-in -> log row + (maybe) one bell row + one audit row ----------------------------------------
-- p_first: the person's first sign-in ever (trigger: last_sign_in_at was empty; join: first sign-in seen in this studio).
-- Returns the number of bell rows made (0 or 1). Errors are the caller's to swallow.
create or replace function public._r383_signin(p_uid uuid, p_session uuid, p_ua text, p_first boolean, p_via text)
returns integer language plpgsql volatile security definer set search_path = '' as $fn$
-- r205-0383
declare
  v_email text; v_org uuid; v_role text; v_name text; v_cfg jsonb; v_tz text; v_now timestamptz := clock_timestamp(); v_dev text;
  v_notify jsonb; v_reason text; v_label text; v_owner uuid; v_first boolean := coalesce(p_first, false); v_n integer := 0;
  v_prev text := current_setting('helm.maintenance', true);
begin
  if p_uid is null then return 0; end if;
  if v_prev = 'on' then return 0; end if;                                  -- forced maintenance: stay quiet
  -- the same session already seen = a token refresh, not a new sign-in
  if p_session is not null and exists (select 1 from public.signin_notice_log l where l.session_id = p_session) then return 0; end if;
  select lower(btrim(u.email)) into v_email from auth.users u where u.id = p_uid;
  if public._r383_is_hq(v_email) then return 0; end if;
  select p.org_id, lower(coalesce(p.role, '')),
         left(coalesce(nullif(btrim(p.full_name), ''), nullif(split_part(coalesce(p.email, v_email, ''), '@', 1), ''), 'A teammate'), 80)
    into v_org, v_role, v_name
    from public.profiles p where p.id = p_uid;
  if v_org is null or v_role in ('', 'client') then return 0; end if;
  if exists (select 1 from public.organizations o where o.id = v_org and coalesce(o.is_sample_master, false)) then return 0; end if;
  if public._r283_is_off(p_uid, v_org) then return 0; end if;
  v_dev := public._r383_device(p_ua);
  v_cfg := public._r383_cfg(v_org);
  v_tz := public._r23_tz(v_org);
  -- the rules, in order
  if v_cfg ->> 'mode' = 'off' then v_reason := 'off';
  elsif not ((v_cfg -> 'roles') ? (case when v_role = 'worker' then 'crew' else v_role end)) then v_reason := 'role';
  elsif exists (select 1 from public.signin_notice_log l where l.user_id = p_uid and l.org_id = v_org and l.notified
                   and l.signed_in_at > v_now - interval '10 minutes') then v_reason := 'within_10_min';
  elsif v_cfg ->> 'mode' = 'first_daily' and not v_first
        and exists (select 1 from public.signin_notice_log l where l.user_id = p_uid and l.org_id = v_org
                       and l.signed_in_at >= ((v_now at time zone v_tz)::date)::timestamp at time zone v_tz) then v_reason := 'not_first_today';
  end if;
  if v_reason is null then
    v_owner := public._r283_owner(v_org);
    select coalesce(jsonb_agg(x.id::text order by x.id), '[]'::jsonb) into v_notify
      from (select p.id from public.profiles p
             where p.org_id = v_org and (lower(coalesce(p.role, '')) = 'admin' or p.id = v_owner)
               and p.id <> p_uid and not public._r283_is_off(p.id, v_org)
               and not exists (select 1 from auth.users u where u.id = p.id and public._r383_is_hq(lower(u.email)))) x;
    if jsonb_array_length(v_notify) = 0 then v_reason := 'nobody'; end if;
  end if;
  if v_reason is null then
    v_label := left(v_name || ' (' || public._r383_role_label(v_role) || ') signed in'
               || case when v_first then ' for the first time' else '' end
               || ' ' || chr(183) || ' ' || btrim(to_char(v_now at time zone v_tz, 'FMHH12:MI AM'))
               || coalesce(' ' || chr(183) || ' ' || v_dev, ''), 200);
    -- 0164 drops bell rows made without an API request (Supabase Auth has none): this one is a real sign-in, keep it
    perform pg_catalog.set_config('helm.maintenance', 'off', true);
    begin
      insert into public.notifications (quote_id, channel, kind, status, detail, org_id)
        values (null, 'in_app', 'team_signin', 'simulated',
                jsonb_build_object('label', v_label, 'user_id', p_uid::text, 'role', v_role, 'name', v_name, 'first_time', v_first,
                                   'device', v_dev, 'at', v_now, 'notify', v_notify, 'source', '0383'), v_org);
      get diagnostics v_n = row_count;
    exception when others then
      perform pg_catalog.set_config('helm.maintenance', coalesce(v_prev, ''), true);
      raise;
    end;
    perform pg_catalog.set_config('helm.maintenance', coalesce(v_prev, ''), true);
  end if;
  insert into public.signin_notice_log (org_id, user_id, session_id, signed_in_at, first_time, device, via, notified, reason)
    values (v_org, p_uid, p_session, v_now, v_first, v_dev, coalesce(p_via, 'trigger'), v_n > 0, v_reason);
  begin
    insert into public.audit_log (actor, actor_email, action, entity, entity_id, changed, org_id)
      values (p_uid, v_email, 'auth.sign_in', 'session', p_uid::text,
              jsonb_strip_nulls(jsonb_build_object('role', v_role, 'first_time', v_first, 'device', v_dev, 'via', p_via,
                                                   'notice', case when v_n > 0 then 'sent' else v_reason end)), v_org);
  exception when others then raise warning 'r205-0383: audit skipped (%)', sqlstate;
  end;
  return v_n;
end $fn$;

-- the newest session of a person (id + browser); null when auth.sessions cannot be read
create or replace function public._r383_session(p_uid uuid, out session_id uuid, out user_agent text)
language plpgsql stable security definer set search_path = '' as $fn$
-- r205-0383
begin
  if to_regclass('auth.sessions') is null then return; end if;
  begin
    execute 'select s.id, s.user_agent::text from auth.sessions s where s.user_id = $1 order by s.created_at desc nulls last limit 1'
      into session_id, user_agent using p_uid;
  exception when others then session_id := null; user_agent := null;
  end;
end $fn$;

-- ---- 4) the triggers (never raise) ----------------------------------------------------------------------------------------
create or replace function public.tg_r383_signin()
returns trigger language plpgsql security definer set search_path = '' as $fn$
-- r205-0383: Supabase Auth wrote last_sign_in_at = a sign-in. Never blocks it: every error becomes a WARNING.
declare s record;
begin
  if new.last_sign_in_at is null or new.last_sign_in_at is not distinct from old.last_sign_in_at then return null; end if;
  begin
    if not public._r383_trigger_may() then return null; end if;
    select * into s from public._r383_session(new.id);
    perform public._r383_signin(new.id, s.session_id, s.user_agent, old.last_sign_in_at is null, 'trigger');
  exception when others then raise warning 'r205-0383: sign-in notice skipped (%)', sqlstate;
  end;
  return null;
end $fn$;

create or replace function public.tg_r383_join()
returns trigger language plpgsql security definer set search_path = '' as $fn$
-- r205-0383: someone who signed in within the last 30 minutes joined a studio (accept an invitation) = their first sign-in there
declare s record; v_last timestamptz;
begin
  if new.org_id is null or new.org_id is not distinct from old.org_id then return null; end if;
  begin
    if not public._r383_trigger_may() then return null; end if;
    select u.last_sign_in_at into v_last from auth.users u where u.id = new.id;
    if v_last is null or v_last < now() - interval '30 minutes' then return null; end if;
    if exists (select 1 from public.signin_notice_log l where l.user_id = new.id and l.org_id = new.org_id) then return null; end if;
    select * into s from public._r383_session(new.id);
    perform public._r383_signin(new.id, s.session_id, s.user_agent, true, 'join');
  exception when others then raise warning 'r205-0383: join notice skipped (%)', sqlstate;
  end;
  return null;
end $fn$;

drop trigger if exists zz_r383_join_notice on public.profiles;
create trigger zz_r383_join_notice after update of org_id on public.profiles
  for each row execute function public.tg_r383_join();

-- auth.users belongs to Supabase Auth: Helm already keeps triggers there (0053 / 0248 / 0288). If this project refuses, skip
-- with a NOTICE - the browser fallback (signin_notice_ping) then does the job.
do $$ begin
  drop trigger if exists zz_r383_signin_notice on auth.users;
  create trigger zz_r383_signin_notice after update of last_sign_in_at on auth.users
    for each row execute function public.tg_r383_signin();
exception when insufficient_privilege then
  raise notice '0383: could not add the sign-in trigger on auth.users (%). The app fallback signin_notice_ping() takes over.', sqlerrm;
end $$;

-- ---- 5) the fallback: a signed-in tab says "I am signed in" once per session (does nothing while the trigger is on) --------
create or replace function public.signin_notice_ping(p_ua text default null)
returns jsonb language plpgsql volatile security definer set search_path = '' as $fn$
-- r205-0383: never raises; the same rules as the trigger; a session already seen is ignored
declare v_uid uuid := auth.uid(); v_sid uuid; s record; v_first boolean; v_n integer := 0;
begin
  if v_uid is null then return jsonb_build_object('ok', false); end if;
  if public._r383_trigger_on() then return jsonb_build_object('ok', true, 'via', 'trigger'); end if;
  begin
    v_sid := nullif(auth.jwt() ->> 'session_id', '')::uuid;
  exception when others then v_sid := null;
  end;
  if v_sid is null then return jsonb_build_object('ok', true, 'via', 'ping', 'skipped', 'no_session'); end if;
  begin
    select * into s from public._r383_session(v_uid);
    v_first := not exists (select 1 from public.signin_notice_log l where l.user_id = v_uid)
               and exists (select 1 from auth.users u where u.id = v_uid and u.created_at > now() - interval '2 days');
    v_n := public._r383_signin(v_uid, v_sid, coalesce(case when s.session_id = v_sid then s.user_agent end, left(p_ua, 400)), v_first, 'ping');
  exception when others then
    raise warning 'r205-0383: ping skipped (%)', sqlstate;
    return jsonb_build_object('ok', false, 'via', 'ping');
  end;
  return jsonb_build_object('ok', true, 'via', 'ping', 'notified', v_n > 0);
end $fn$;

-- ---- 6) Settings -> Notifications -> Teammate sign-ins (admins) -------------------------------------------------------------
create or replace function public.signin_notice_settings_get()
returns jsonb language plpgsql stable security definer set search_path = '' as $fn$
-- r205-0383: { mode, roles, roles_default, saved, updated_at, email_digest: false, roles_all, can_edit, via }
declare v_org uuid := public.current_org_id();
begin
  if auth.uid() is null or v_org is null or not coalesce(public.is_admin(), false) then
    raise exception 'not authorized' using errcode = '42501'; end if;
  return public._r383_cfg(v_org) || jsonb_build_object('roles_all', to_jsonb(public._r383_roles_all()), 'can_edit', true,
    'via', case when public._r383_trigger_on() then 'trigger' else 'ping' end);
end $fn$;

create or replace function public.signin_notice_settings_set(p jsonb)
returns jsonb language plpgsql volatile security definer set search_path = '' as $fn$
-- r205-0383: a studio admin only, own studio; mode off / first_daily / every; roles from the list (null / missing = default)
declare v_org uuid := public.current_org_id(); v_me uuid := auth.uid(); v_old jsonb; v_mode text; v_roles text[]; r text;
begin
  if v_me is null or v_org is null or not coalesce(public.is_admin(), false) then
    raise exception 'Only a studio admin can change the sign-in notices.' using errcode = '42501'; end if;
  if coalesce(public._trial_locked(v_org), false) then raise exception 'This studio is read-only' using errcode = '25006'; end if;
  if p is null or jsonb_typeof(p) <> 'object' then raise exception 'bad settings' using errcode = '22023'; end if;
  v_old := public._r383_cfg(v_org);
  v_mode := coalesce(p ->> 'mode', v_old ->> 'mode');
  if v_mode not in ('off', 'first_daily', 'every') then
    raise exception 'Choose Off, First sign-in each day or Every sign-in.' using errcode = '22023'; end if;
  if p ? 'roles' and jsonb_typeof(p -> 'roles') = 'array' then
    select coalesce(array_agg(distinct lower(btrim(x)) order by lower(btrim(x))), '{}'::text[]) into v_roles
      from jsonb_array_elements_text(p -> 'roles') x;
    foreach r in array v_roles loop
      if not (r = any (public._r383_roles_all())) then raise exception 'Unknown role: %', left(r, 30) using errcode = '22023'; end if;
    end loop;
  elsif p ? 'roles' and jsonb_typeof(p -> 'roles') <> 'null' then
    raise exception 'bad roles' using errcode = '22023';
  elsif p ? 'roles' then
    v_roles := null;                                                   -- back to the default
  else
    select s.roles into v_roles from public.signin_notice_settings s where s.org_id = v_org;
  end if;
  insert into public.signin_notice_settings (org_id, mode, roles, updated_at, updated_by)
    values (v_org, v_mode, v_roles, now(), v_me)
    on conflict (org_id) do update set mode = excluded.mode, roles = excluded.roles, updated_at = now(), updated_by = v_me;
  begin
    insert into public.audit_log (actor, action, entity, entity_id, changed, org_id)
      values (v_me, 'signin_notice.settings', 'signin_notice_settings', v_org::text,
              jsonb_build_object('from', v_old - 'updated_at' - 'saved', 'to', public._r383_cfg(v_org) - 'updated_at' - 'saved'), v_org);
  exception when others then raise warning 'r205-0383: audit skipped (%)', sqlstate;
  end;
  return public.signin_notice_settings_get();
end $fn$;

-- ---- 7) the notification type "Teammate sign-ins" (admins only by default) --------------------------------------------------
do $$
declare f record; v_pub regprocedure; v_pre regprocedure;
begin
  for f in select * from (values ('notification_catalog', ''), ('notification_type_of', 'text,text'), ('notify_default', 'uuid,text,text,text')) x(n, a) loop
    v_pub := to_regprocedure('public.' || f.n || '(' || f.a || ')');
    v_pre := to_regprocedure('public.' || f.n || '__pre0383(' || f.a || ')');
    if v_pub is not null and v_pre is null
       and position('r205-0383' in coalesce((select p.prosrc from pg_proc p where p.oid = v_pub), '')) = 0 then
      execute format('alter function public.%I(%s) rename to %I', f.n, f.a, f.n || '__pre0383');
    end if;
  end loop;
  if to_regprocedure('public.notification_catalog__pre0383()') is null or to_regprocedure('public.notification_type_of__pre0383(text,text)') is null
     or to_regprocedure('public.notify_default__pre0383(uuid,text,text,text)') is null then
    raise exception 'STOP 0383: the notification catalog functions could not be kept as __pre0383'; end if;
end $$;

create or replace function public.notification_catalog()
returns jsonb language plpgsql immutable security definer set search_path = '' as $fn$
-- r205-0383: + team_signin (once) on top of the kept list (notification_catalog__pre0383 = the r163-0358 cached r156-0354 layers);
-- the finished list kept for the rest of the request (helm.r383_cat), like r163-0358
declare v text := current_setting('helm.r383_cat', true); c jsonb;
begin
  if coalesce(v, '') <> '' then return v::jsonb; end if;
  c := public.notification_catalog__pre0383();
  if not exists (select 1 from jsonb_array_elements(c) e where e ->> 'type' = 'team_signin') then
    c := c || $cat$[
    {"type":"team_signin","group":"Team","label":"Teammate sign-ins",
     "description":"A teammate signed in (first sign-in each day by default, or every sign-in; set in Settings -> Notifications -> Teammate sign-ins). Owner and admins only.",
     "audience":"studio","channels":["in_app"],"required":[],"gated":[],"money":false}
  ]$cat$::jsonb;
  end if;
  perform pg_catalog.set_config('helm.r383_cat', c::text, true);
  return c;
end $fn$;

create or replace function public.notification_type_of(p_kind text, p_channel text default null)
returns text language sql immutable security definer set search_path = '' as $fn$
  -- r205-0383
  select case when lower(btrim(coalesce(p_kind, ''))) = 'team_signin' then 'team_signin'
              else public.notification_type_of__pre0383(p_kind, p_channel) end;
$fn$;

create or replace function public.notify_default(p_org uuid, p_role text, p_type text, p_channel text)
returns boolean language sql stable security definer set search_path = '' as $fn$
  -- r205-0383: teammate sign-in notices reach admins only (in the bell); everything else = the kept r156-0354 rule
  select case when p_type = 'team_signin' then coalesce(p_role = 'admin', false) and p_channel = 'in_app'
              else public.notify_default__pre0383(p_org, p_role, p_type, p_channel) end;
$fn$;

-- ---- 8) the bell: a sign-in notice only for the people named on it ------------------------------------------------------------
do $$
declare v_src text;
begin
  select p.prosrc into v_src from pg_proc p where p.oid = to_regprocedure('public._r23_visible(uuid,uuid)');
  if position('r205-0383' in coalesce(v_src, '')) = 0 and to_regprocedure('public._r23_visible__pre0383(uuid,uuid)') is null then
    alter function public._r23_visible(uuid, uuid) rename to _r23_visible__pre0383;
  end if;
  if to_regprocedure('public._r23_visible__pre0383(uuid,uuid)') is null then
    raise exception 'STOP 0383: _r23_visible could not be kept as _r23_visible__pre0383'; end if;
  select p.prosrc into v_src from pg_proc p where p.oid = to_regprocedure('public.bell_feed(integer)');
  if position('r205-0383' in coalesce(v_src, '')) = 0 and to_regprocedure('public.bell_feed__pre0383(integer)') is null then
    alter function public.bell_feed(integer) rename to bell_feed__pre0383;
  end if;
  if to_regprocedure('public.bell_feed__pre0383(integer)') is null then
    raise exception 'STOP 0383: bell_feed could not be kept as bell_feed__pre0383'; end if;
end $$;

create or replace function public._r23_visible(p_org uuid, p_uid uuid)
returns table(id uuid, kind text, channel text, status text, detail jsonb, created_at timestamptz, quote_id uuid, ntype text)
language sql stable security definer set search_path = '' as $fn$
  -- r205-0383: the kept rule (_r23_visible__pre0383 = the r190-0373 wrapper of the r186-0369 / r24-ci-0270 + r163-0357 bodies)
  -- unchanged; a team_signin row only for the people in its notify list
  select v.id, v.kind, v.channel, v.status, v.detail, v.created_at, v.quote_id, v.ntype
    from public._r23_visible__pre0383(p_org, p_uid) v
   where coalesce(v.kind, '') <> 'team_signin'
      or exists (select 1 from public.notifications n
                  where n.id = v.id and n.org_id = p_org and jsonb_typeof(n.detail -> 'notify') = 'array'
                    and (n.detail -> 'notify') ? p_uid::text);
$fn$;

create or replace function public.bell_feed(p_limit integer default 20)
returns jsonb language plpgsql stable security definer set search_path = '' as $fn$
-- r205-0383: the kept bell (bell_feed__pre0383 = the r190-0373 / r186-0369 body) unchanged, minus team_signin rows the caller is
-- not named on
declare v jsonb := public.bell_feed__pre0383(p_limit); v_uid text := auth.uid()::text; v_org uuid := public.current_org_id();
begin
  if v is null or jsonb_typeof(v -> 'items') <> 'array' then return v; end if;
  if not exists (select 1 from jsonb_array_elements(v -> 'items') e where e ->> 'kind' = 'team_signin') then return v; end if;
  return jsonb_set(v, '{items}', coalesce((
    select jsonb_agg(e.i order by e.o)
      from jsonb_array_elements(v -> 'items') with ordinality e(i, o)
     where coalesce(e.i ->> 'kind', '') <> 'team_signin'
        or (v_uid is not null and exists (select 1 from public.notifications n
                                           where n.id::text = e.i ->> 'id' and n.org_id = v_org and jsonb_typeof(n.detail -> 'notify') = 'array'
                                             and (n.detail -> 'notify') ? v_uid))), '[]'::jsonb));
end $fn$;

-- direct reads of the table: a sign-in notice only for the people named on it; never written by the app
do $$ begin
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'notifications' and policyname = 'r383_signin_read') then
    create policy r383_signin_read on public.notifications as restrictive for select to authenticated
      using (coalesce(kind, '') <> 'team_signin'
             or (jsonb_typeof(detail -> 'notify') = 'array' and (detail -> 'notify') ? ((select auth.uid())::text)));
  end if;
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'notifications' and policyname = 'r383_signin_ins') then
    create policy r383_signin_ins on public.notifications as restrictive for insert to authenticated
      with check (coalesce(kind, '') <> 'team_signin');
  end if;
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'notifications' and policyname = 'r383_signin_upd') then
    create policy r383_signin_upd on public.notifications as restrictive for update to authenticated
      using (coalesce(kind, '') <> 'team_signin') with check (coalesce(kind, '') <> 'team_signin');
  end if;
end $$;

-- ---- 9a) free-trial retention (0184): both tables are KEPT with the studio settings / audit log (never purged by this feature) --
do $$ declare v_def text; begin
  if to_regprocedure('public._tr184_keep_tables()') is not null then
    v_def := pg_get_functiondef('public._tr184_keep_tables()'::regprocedure);
    if position('''signin_notice_settings''' in v_def) = 0 then
      if (length(v_def) - length(replace(v_def, '''task_reminder_settings''', ''))) / length('''task_reminder_settings''') <> 1 then
        raise notice '0383: _tr184_keep_tables has an unexpected body - left unchanged';
      else execute replace(v_def, '''task_reminder_settings''', '''task_reminder_settings'', ''signin_notice_settings'', ''signin_notice_log'''); end if;
    end if;
  end if;
end $$;

-- ---- 9) grants: settings + ping for signed-in callers (each checks itself); everything else for the server only ------------
do $$
declare f text;
begin
  foreach f in array array['public._r383_device(text)', 'public._r383_role_label(text)', 'public._r383_roles_all()', 'public._r383_cfg(uuid)',
                           'public._r383_is_hq(text)', 'public._r383_trigger_on()', 'public._r383_trigger_may()', 'public._r383_signin(uuid,uuid,text,boolean,text)',
                           'public._r383_session(uuid)', 'public.tg_r383_signin()', 'public.tg_r383_join()',
                           'public._r23_visible(uuid,uuid)', 'public._r23_visible__pre0383(uuid,uuid)', 'public.bell_feed__pre0383(integer)',
                           'public.notification_catalog__pre0383()', 'public.notification_type_of__pre0383(text,text)',
                           'public.notify_default__pre0383(uuid,text,text,text)', 'public.notify_default(uuid,text,text,text)'] loop
    execute format('revoke all on function %s from public', f);
    if exists (select 1 from pg_roles where rolname = 'anon') then execute format('revoke all on function %s from anon', f); end if;
    if exists (select 1 from pg_roles where rolname = 'authenticated') then execute format('revoke all on function %s from authenticated', f); end if;
  end loop;
  foreach f in array array['public.signin_notice_settings_get()', 'public.signin_notice_settings_set(jsonb)', 'public.signin_notice_ping(text)',
                           'public.bell_feed(integer)', 'public.notification_catalog()', 'public.notification_type_of(text,text)'] loop
    execute format('revoke all on function %s from public', f);
    if exists (select 1 from pg_roles where rolname = 'anon') then execute format('revoke all on function %s from anon', f); end if;
    if exists (select 1 from pg_roles where rolname = 'authenticated') then execute format('grant execute on function %s to authenticated', f); end if;
  end loop;
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    foreach f in array array['public._r23_visible(uuid,uuid)', 'public.notification_catalog()', 'public.notification_type_of(text,text)',
                             'public.notify_default(uuid,text,text,text)'] loop
      execute format('grant execute on function %s to service_role', f);
    end loop;
    foreach f in array array['public._r23_visible__pre0383(uuid,uuid)', 'public.bell_feed__pre0383(integer)', 'public.notification_catalog__pre0383()',
                             'public.notification_type_of__pre0383(text,text)', 'public.notify_default__pre0383(uuid,text,text,text)'] loop
      execute format('revoke all on function %s from service_role', f);
    end loop;
  end if;
end $$;

notify pgrst, 'reload schema';

select item, ok from (values
  ('01 tables signin_notice_settings + signin_notice_log: row security on, no app access',
     to_regclass('public.signin_notice_settings') is not null and to_regclass('public.signin_notice_log') is not null
     and (select bool_and(c.relrowsecurity) from pg_class c where c.oid in ('public.signin_notice_settings'::regclass, 'public.signin_notice_log'::regclass))
     and (not exists (select 1 from pg_roles where rolname = 'authenticated')
          or not (has_table_privilege('authenticated', 'public.signin_notice_log', 'select') or has_table_privilege('authenticated', 'public.signin_notice_settings', 'select')))
     and (not exists (select 1 from pg_roles where rolname = 'anon') or not has_table_privilege('anon', 'public.signin_notice_log', 'select'))),
  ('02 functions installed with the r205-0383 marker (core, settings get / set, fallback ping)',
     (select count(*) from pg_proc p where p.oid in (to_regprocedure('public._r383_signin(uuid,uuid,text,boolean,text)'),
        to_regprocedure('public.signin_notice_settings_get()'), to_regprocedure('public.signin_notice_settings_set(jsonb)'),
        to_regprocedure('public.signin_notice_ping(text)'), to_regprocedure('public.tg_r383_signin()'), to_regprocedure('public.tg_r383_join()'))
        and position('r205-0383' in p.prosrc) > 0) = 6),
  ('03 sign-in trigger zz_r383_signin_notice on auth.users (false = refused by Supabase: the app fallback is used, see the top)',
     exists (select 1 from pg_trigger where tgname = 'zz_r383_signin_notice' and tgrelid = 'auth.users'::regclass and not tgisinternal)),
  ('04 join trigger zz_r383_join_notice on profiles',
     exists (select 1 from pg_trigger where tgname = 'zz_r383_join_notice' and tgrelid = 'public.profiles'::regclass and not tgisinternal)),
  ('05 bell + catalog wrapped once (old bodies kept as __pre0383), live bodies carry r205-0383',
     to_regprocedure('public._r23_visible__pre0383(uuid,uuid)') is not null and to_regprocedure('public.bell_feed__pre0383(integer)') is not null
     and to_regprocedure('public.notification_catalog__pre0383()') is not null and to_regprocedure('public.notification_type_of__pre0383(text,text)') is not null
     and to_regprocedure('public.notify_default__pre0383(uuid,text,text,text)') is not null
     and (select count(*) from pg_proc p where p.oid in (to_regprocedure('public._r23_visible(uuid,uuid)'), to_regprocedure('public.bell_feed(integer)'),
            to_regprocedure('public.notification_catalog()'), to_regprocedure('public.notification_type_of(text,text)'),
            to_regprocedure('public.notify_default(uuid,text,text,text)')) and position('r205-0383' in p.prosrc) > 0) = 5),
  ('06 notification type team_signin in the catalog once, admins only by default',
     (select count(*) from jsonb_array_elements(public.notification_catalog()) c where c ->> 'type' = 'team_signin') = 1
     and public.notification_type_of('team_signin', 'in_app') = 'team_signin'),
  ('07 restrictive policies on notifications for team_signin (read: only the people named; no app insert / update)',
     (select count(*) from pg_policies where schemaname = 'public' and tablename = 'notifications'
        and policyname in ('r383_signin_read', 'r383_signin_ins', 'r383_signin_upd') and permissive = 'RESTRICTIVE') = 3),
  ('08 grants: settings + ping for signed-in callers only, never anon; the core / triggers for nobody',
     (not exists (select 1 from pg_roles where rolname = 'authenticated')
      or (has_function_privilege('authenticated', 'public.signin_notice_settings_get()', 'execute')
          and has_function_privilege('authenticated', 'public.signin_notice_settings_set(jsonb)', 'execute')
          and has_function_privilege('authenticated', 'public.signin_notice_ping(text)', 'execute')
          and not has_function_privilege('authenticated', 'public._r383_signin(uuid,uuid,text,boolean,text)', 'execute')))
     and (not exists (select 1 from pg_roles where rolname = 'anon')
      or not (has_function_privilege('anon', 'public.signin_notice_settings_get()', 'execute')
              or has_function_privilege('anon', 'public.signin_notice_ping(text)', 'execute')))),
  ('09 definer + empty search_path on every new definer function',
     (select bool_and(coalesce(p.proconfig, '{}') @> array['search_path=""']) from pg_proc p
       where p.pronamespace = 'public'::regnamespace and p.prosecdef
         and (p.proname like '\_r383\_%' or p.proname like 'signin\_notice\_%' or p.proname like 'tg\_r383\_%'))),
  ('10 the triggers never raise (every error becomes a WARNING)',
     position('exception when others then raise warning' in (select p.prosrc from pg_proc p where p.oid = 'public.tg_r383_signin()'::regprocedure)) > 0
     and position('exception when others then raise warning' in (select p.prosrc from pg_proc p where p.oid = 'public.tg_r383_join()'::regprocedure)) > 0)
) v(item, ok) order by item;
commit;
