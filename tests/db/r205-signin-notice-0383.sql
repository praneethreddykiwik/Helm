-- r205-signin-notice-0383.sql - R205 (0383): "a teammate signed in" bell notices for the studio owner + admins.
-- A real sign-in (auth.users.last_sign_in_at written, a NEW auth.sessions row) -> one bell row named on the owner + active
-- admins only (never the person, never another studio), label "Name (Role) signed in - h:mm AM - Browser on System" in the
-- studio time zone, "for the first time" on a first sign-in, an audit row auth.sign_in; a token refresh (same session) is not
-- a sign-in; 10-minute rule; First sign-in each day (default, studio today) / Every sign-in / Off; Only roles (crew off by
-- default); HQ staff / helm.events / deactivated / sample studio / client never; invited person joining = first-time notice;
-- the trigger never fails a sign-in; the browser fallback ping (no-op while the trigger is on); settings get / set (admins
-- only, validated, audited, own studio); RLS on direct reads / writes; catalog type; grants. All dates relative to now() and
-- the studio's own today. Re-applies 0383 twice. Rolled back.
\set ON_ERROR_STOP 0
set client_min_messages = error;
\ir ../../supabase/migrations/0383_r205_signin_notice.sql
\ir ../../supabase/migrations/0383_r205_signin_notice.sql
set client_min_messages = warning;
begin;
select set_config('helm.signin_notice', 'on', false);
create temp table _r205(name text, result text); grant all on _r205 to anon, authenticated, service_role;
create or replace function pg_temp.su() returns void language plpgsql as $$
begin execute 'reset role'; perform auth.logout(); execute 'reset role'; end $$;
create or replace function pg_temp.login(p_email text, p_sid uuid default null) returns void language plpgsql as $$
declare u uuid; begin
  perform pg_temp.su(); select id into u from auth.users where email = p_email;
  perform set_config('request.jwt.claims', jsonb_strip_nulls(jsonb_build_object('sub', u, 'role', 'authenticated', 'email', p_email, 'aal', 'aal1',
    'session_id', p_sid))::text, false);
  perform set_config('role', 'authenticated', false);
end $$;
create or replace function pg_temp.anon() returns void language plpgsql as $$
begin perform pg_temp.su(); perform set_config('request.jwt.claims', '{"role":"anon"}', false); perform set_config('role', 'anon', false); end $$;
create or replace function pg_temp.res(p_name text, p_ok boolean, p_detail text default '') returns void language plpgsql as $$
begin perform pg_temp.su(); insert into _r205 values (p_name, case when coalesce(p_ok, false) then 'PASS' else 'FAIL: '||coalesce(p_detail,'') end); end $$;
create or replace function pg_temp.try(p_sql text) returns text language plpgsql as $$
begin execute p_sql; return ''; exception when others then return sqlstate || ' ' || sqlerrm; end $$;
grant execute on function pg_temp.try(text) to anon, authenticated, service_role;
-- one real sign-in the way Supabase Auth does it: a new session row, then last_sign_in_at
create or replace function pg_temp.signin(p_email text, p_ua text default 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36')
returns uuid language plpgsql as $$
declare u uuid; s uuid; begin
  perform pg_temp.su(); select id into u from auth.users where email = p_email;
  insert into auth.sessions(user_id, user_agent, created_at) values (u, p_ua, clock_timestamp()) returning id into s;
  update auth.users set last_sign_in_at = clock_timestamp() where id = u;
  return s;
end $$;
-- a token refresh: Supabase Auth may write last_sign_in_at again, the session stays the same
create or replace function pg_temp.refresh(p_email text) returns void language plpgsql as $$
begin perform pg_temp.su(); update auth.users set last_sign_in_at = clock_timestamp() where email = p_email; end $$;
create or replace function pg_temp.uid(p_email text) returns uuid language sql as $$ select id from auth.users where email = p_email $$;
create or replace function pg_temp.notes(p_email text) returns integer language sql as $$
  select count(*)::int from public.notifications n where n.kind = 'team_signin' and n.detail ->> 'user_id' = (select id::text from auth.users where email = p_email) $$;
create or replace function pg_temp.last_note(p_email text) returns jsonb language sql as $$
  select n.detail from public.notifications n where n.kind = 'team_signin' and n.detail ->> 'user_id' = (select id::text from auth.users where email = p_email)
   order by (n.detail ->> 'at')::timestamptz desc limit 1 $$;
create or replace function pg_temp.last_log(p_email text) returns public.signin_notice_log language sql as $$
  select l.* from public.signin_notice_log l where l.user_id = (select id from auth.users where email = p_email) order by l.signed_in_at desc, l.id desc limit 1 $$;
create or replace function pg_temp.clear(p_email text) returns void language sql as $$
  delete from public.signin_notice_log where user_id = (select id from auth.users where email = $1);
  delete from public.notifications where kind = 'team_signin' and detail ->> 'user_id' = (select id::text from auth.users where email = $1) $$;
create or replace function pg_temp.mode(p_org uuid, p_mode text, p_roles text[] default null) returns void language sql as $$
  insert into public.signin_notice_settings(org_id, mode, roles) values ($1, $2, $3)
  on conflict (org_id) do update set mode = excluded.mode, roles = excluded.roles $$;
create or replace function pg_temp.bell() returns jsonb language plpgsql as $$ begin return public.bell_feed(50); end $$;
grant execute on function pg_temp.bell() to authenticated;
create or replace function pg_temp.bell_has(p jsonb, p_uid uuid) returns boolean language sql as $$
  select exists (select 1 from jsonb_array_elements(p -> 'items') e where e ->> 'kind' = 'team_signin' and e -> 'detail' ->> 'user_id' = p_uid::text) $$;
grant execute on function pg_temp.bell_has(jsonb, uuid) to authenticated;

do $$ declare orgA uuid := 'a0000000-0000-4000-8000-000000000001'; orgB uuid := 'b0000000-0000-4000-8000-000000000001';
  a_admin uuid; a_staff uuid; b_admin uuid; a_admin2 uuid; a_crew uuid; u_hq uuid; u_helm uuid; u_off uuid; u_inv uuid; u_samp uuid;
  orgS uuid; tz text; d jsonb; l public.signin_notice_log; s uuid; n int; n0 int; e text; r jsonb; v_midnight timestamptz; ok boolean;
begin
  perform pg_temp.su();
  perform set_config('helm.signin_notice', 'off', false);    -- the set-up below is not a sign-in
  update public.organizations set timezone = 'Asia/Kolkata' where id = orgA;
  tz := public._r23_tz(orgA);
  v_midnight := ((now() at time zone tz)::date)::timestamp at time zone tz;    -- the start of the studio's today
  a_admin := pg_temp.uid('a_admin@a.test'); a_staff := pg_temp.uid('a_staff@a.test'); b_admin := pg_temp.uid('b_admin@b.test');
  update public.profiles set full_name = 'Ravi Kumar', role = 'planner' where id = a_staff;
  update auth.users set last_sign_in_at = now() - interval '5 days' where id in (a_admin, a_staff, b_admin);
  -- a second admin in A, a crew login, a deactivated member, an HQ operator and a helm.events address in A
  a_admin2 := auth.seed_user('r205_admin2@a.test');
  insert into public.profiles(id, email, role, org_id, full_name, must_change_password, created_at)
    values (a_admin2, 'r205_admin2@a.test', 'admin', orgA, 'Asha Admin', false, now() - interval '30 days') on conflict (id) do update set org_id = excluded.org_id, role = 'admin';
  a_crew := auth.seed_user('r205_crew@a.test');
  insert into public.profiles(id, email, role, org_id, full_name, must_change_password, created_at)
    values (a_crew, 'r205_crew@a.test', 'crew', orgA, 'Chandu Crew', false, now() - interval '30 days') on conflict (id) do update set org_id = excluded.org_id, role = 'crew';
  u_off := auth.seed_user('r205_off@a.test');
  insert into public.profiles(id, email, role, org_id, full_name, must_change_password, created_at)
    values (u_off, 'r205_off@a.test', 'sales', orgA, 'Off Person', false, now() - interval '30 days') on conflict (id) do update set org_id = excluded.org_id;
  insert into public.team_member_status(user_id, org_id, status, changed_at, deactivated_at)
    values (u_off, orgA, 'deactivated', now() - interval '1 day', now() - interval '1 day') on conflict (user_id, org_id) do update set status = 'deactivated';
  u_hq := auth.seed_user('r205_operator@a.test');
  insert into public.profiles(id, email, role, org_id, full_name, must_change_password, created_at)
    values (u_hq, 'r205_operator@a.test', 'manager', orgA, 'HQ Person', false, now() - interval '30 days') on conflict (id) do update set org_id = excluded.org_id;
  insert into public.platform_admins(email) values ('r205_operator@a.test') on conflict do nothing;
  insert into public.staff_email_allowlist(email) values ('r205_support@helm.events') on conflict do nothing;   -- a Helm team address
  u_helm := auth.seed_user('r205_support@helm.events');
  insert into public.profiles(id, email, role, org_id, full_name, must_change_password, created_at)
    values (u_helm, 'r205_support@helm.events', 'manager', orgA, 'Helm Support', false, now() - interval '30 days') on conflict (id) do update set org_id = excluded.org_id;
  update auth.users set last_sign_in_at = now() - interval '5 days' where id in (a_admin2, a_crew, u_off, u_hq, u_helm);

  perform set_config('helm.signin_notice', 'on', false);
  -- 01-04 the first sign-in ever of an added teammate -> "for the first time", owner + admins only, studio clock, device
  update auth.users set last_sign_in_at = null where id = a_staff;
  s := pg_temp.signin('a_staff@a.test');
  d := pg_temp.last_note('a_staff@a.test');
  perform pg_temp.res('01 first sign-in ever: one bell row "Ravi Kumar (Planner) signed in for the first time - h:mm AM - Chrome on Windows" (studio time)',
    pg_temp.notes('a_staff@a.test') = 1
    and d ->> 'label' = 'Ravi Kumar (Planner) signed in for the first time ' || chr(183) || ' ' || btrim(to_char(now() at time zone tz, 'FMHH12:MI AM')) || ' ' || chr(183) || ' Chrome on Windows'
    and (d ->> 'first_time')::boolean and d ->> 'device' = 'Chrome on Windows', coalesce(d::text, 'no row'));
  perform pg_temp.res('02 named on it: the owner + the other admin, never the person; the row is studio A''s',
    (d -> 'notify') ? a_admin::text and (d -> 'notify') ? a_admin2::text and not ((d -> 'notify') ? a_staff::text)
    and jsonb_array_length(d -> 'notify') = 2
    and (select n.org_id from public.notifications n where n.kind = 'team_signin' and n.detail ->> 'user_id' = a_staff::text limit 1) = orgA,
    d::text);
  l := pg_temp.last_log('a_staff@a.test');
  perform pg_temp.res('03 logged once: session id, first time, notified, via trigger; no IP anywhere in the notice',
    l.session_id = s and l.first_time and l.notified and l.via = 'trigger' and l.org_id = orgA
    and position('ip' in lower(coalesce((select string_agg(k, ',') from jsonb_object_keys(d) k), ''))) = 0, l::text);
  perform pg_temp.res('04 audit log: auth.sign_in by the person (role, first time, device, notice sent)',
    exists (select 1 from public.audit_log a where a.action = 'auth.sign_in' and a.actor = a_staff and a.org_id = orgA
             and a.changed ->> 'role' = 'planner' and (a.changed ->> 'first_time')::boolean and a.changed ->> 'notice' = 'sent'
             and a.changed ->> 'device' = 'Chrome on Windows'));

  -- 05 a token refresh (same session, last_sign_in_at written again) is not a sign-in
  select count(*) into n0 from public.signin_notice_log where user_id = a_staff;
  perform pg_temp.refresh('a_staff@a.test');
  perform pg_temp.res('05 token refresh (same session): no new log row, no new bell row',
    (select count(*) from public.signin_notice_log where user_id = a_staff) = n0 and pg_temp.notes('a_staff@a.test') = 1);

  -- 06-08 the bell: the admin sees it (bell list + inbox rule), the person and studio B do not; direct reads follow the same rule
  perform pg_temp.login('a_admin@a.test');
  r := pg_temp.bell();
  perform pg_temp.su();
  perform pg_temp.res('06 admin (owner): in the bell list and in the inbox rule (_r23_visible)',
    pg_temp.bell_has(r, a_staff)
    and exists (select 1 from public._r23_visible(orgA, a_admin) v where v.kind = 'team_signin' and v.ntype = 'team_signin'), r::text);
  perform pg_temp.login('a_staff@a.test');
  r := pg_temp.bell();
  perform pg_temp.login('a_staff@a.test');
  select count(*) into n from public.notifications where kind = 'team_signin';
  perform pg_temp.su();
  perform pg_temp.res('07 the person: not in their bell, inbox rule or direct reads',
    not pg_temp.bell_has(r, a_staff) and n = 0
    and not exists (select 1 from public._r23_visible(orgA, a_staff) v where v.kind = 'team_signin'), 'bell ' || r::text || ' rows ' || n);
  perform pg_temp.login('b_admin@b.test');
  r := pg_temp.bell();
  perform pg_temp.login('b_admin@b.test');
  select count(*) into n from public.notifications where kind = 'team_signin';
  perform pg_temp.res('08 studio B admin: never sees studio A''s sign-ins', not pg_temp.bell_has(r, a_staff) and n = 0, n::text);

  -- 09 nobody may write such a row through the API
  perform pg_temp.login('a_admin@a.test');
  e := pg_temp.try($q$insert into public.notifications(channel, kind, status, detail) values ('in_app', 'team_signin', 'simulated', '{"label":"fake"}')$q$);
  perform pg_temp.res('09 a team_signin row cannot be written by a signed-in caller (restrictive policy)', e <> '', e);

  -- 10 First sign-in each day (default): a second sign-in today is quiet, logged as not_first_today
  perform pg_temp.su(); perform pg_temp.clear('a_staff@a.test');
  insert into public.signin_notice_log(org_id, user_id, signed_in_at, notified) values (orgA, a_staff, v_midnight, false);
  s := pg_temp.signin('a_staff@a.test');
  l := pg_temp.last_log('a_staff@a.test');
  perform pg_temp.res('10 default First sign-in each day: signed in earlier today (studio clock) -> quiet, reason not_first_today',
    pg_temp.notes('a_staff@a.test') = 0 and l.reason = 'not_first_today' and not l.notified and l.session_id = s, l::text);
  -- 11 the studio's yesterday does not count
  perform pg_temp.su(); perform pg_temp.clear('a_staff@a.test');
  insert into public.signin_notice_log(org_id, user_id, signed_in_at, notified) values (orgA, a_staff, v_midnight - interval '1 hour', true);
  s := pg_temp.signin('a_staff@a.test');
  d := pg_temp.last_note('a_staff@a.test');
  perform pg_temp.res('11 last sign-in was yesterday (studio clock) -> told; not "first time"',
    pg_temp.notes('a_staff@a.test') = 1 and d ->> 'label' like 'Ravi Kumar (Planner) signed in ' || chr(183) || ' %' and not (d ->> 'first_time')::boolean,
    coalesce(d::text, 'none'));

  -- 12-13 Every sign-in: told each time, but at most once per 10 minutes
  perform pg_temp.su(); perform pg_temp.mode(orgA, 'every'); perform pg_temp.clear('a_staff@a.test');
  insert into public.signin_notice_log(org_id, user_id, signed_in_at, notified) values (orgA, a_staff, now() - interval '20 minutes', true);
  perform pg_temp.signin('a_staff@a.test');
  perform pg_temp.res('12 Every sign-in: told again 20 minutes after the last notice', pg_temp.notes('a_staff@a.test') = 1);
  perform pg_temp.signin('a_staff@a.test');
  l := pg_temp.last_log('a_staff@a.test');
  perform pg_temp.res('13 Every sign-in: a new sign-in within 10 minutes -> quiet (within_10_min)',
    pg_temp.notes('a_staff@a.test') = 1 and l.reason = 'within_10_min', l::text);

  -- 14 Off: nothing in the bell, still in the log + audit log
  perform pg_temp.su(); perform pg_temp.mode(orgA, 'off'); perform pg_temp.clear('a_staff@a.test');
  select count(*) into n0 from public.audit_log where action = 'auth.sign_in' and actor = a_staff;
  perform pg_temp.signin('a_staff@a.test');
  l := pg_temp.last_log('a_staff@a.test');
  perform pg_temp.res('14 Off: no bell row; the sign-in is still logged (reason off) and in the audit log',
    pg_temp.notes('a_staff@a.test') = 0 and l.reason = 'off'
    and (select count(*) from public.audit_log where action = 'auth.sign_in' and actor = a_staff) = n0 + 1, l::text);

  -- 15-16 Only roles: crew quiet by default; ticking crew tells; a first sign-in of an unticked role stays quiet
  perform pg_temp.su(); delete from public.signin_notice_settings where org_id = orgA;
  perform pg_temp.signin('r205_crew@a.test');
  l := pg_temp.last_log('r205_crew@a.test');
  perform pg_temp.res('15 default roles: a Crew sign-in is quiet (reason role)', pg_temp.notes('r205_crew@a.test') = 0 and l.reason = 'role', l::text);
  perform pg_temp.su(); perform pg_temp.mode(orgA, 'every', array['crew', 'admin']); perform pg_temp.clear('r205_crew@a.test');
  perform pg_temp.signin('r205_crew@a.test');
  perform pg_temp.su(); perform pg_temp.clear('a_staff@a.test');
  perform pg_temp.signin('a_staff@a.test');
  perform pg_temp.res('16 roles crew + admin ticked: Crew told, a Planner not',
    pg_temp.notes('r205_crew@a.test') = 1 and pg_temp.notes('a_staff@a.test') = 0 and (pg_temp.last_log('a_staff@a.test')).reason = 'role');
  perform pg_temp.su(); delete from public.signin_notice_settings where org_id = orgA;

  -- 17 an admin's own sign-in: told to the other admin, never to themselves
  perform pg_temp.su(); perform pg_temp.clear('r205_admin2@a.test');
  perform pg_temp.signin('r205_admin2@a.test');
  d := pg_temp.last_note('r205_admin2@a.test');
  perform pg_temp.res('17 an admin signs in: the owner is told, the admin is not named on their own notice',
    d is not null and (d -> 'notify') ? a_admin::text and not ((d -> 'notify') ? a_admin2::text), coalesce(d::text, 'none'));
  -- 18 the only admin signs in: nobody else to tell -> quiet (reason nobody)
  perform pg_temp.su(); perform pg_temp.clear('b_admin@b.test');
  perform pg_temp.signin('b_admin@b.test');
  perform pg_temp.res('18 the only admin of studio B signs in: no notice (nobody), logged', pg_temp.notes('b_admin@b.test') = 0
    and (pg_temp.last_log('b_admin@b.test')).reason = 'nobody' and (pg_temp.last_log('b_admin@b.test')).org_id = orgB);

  -- 19-21 never: HQ operator, a helm.events address, a deactivated member
  perform pg_temp.signin('r205_operator@a.test'); perform pg_temp.signin('r205_support@helm.events'); perform pg_temp.signin('r205_off@a.test');
  perform pg_temp.res('19 an HQ operator (platform_admins) signs in: nothing at all',
    pg_temp.notes('r205_operator@a.test') = 0 and not exists (select 1 from public.signin_notice_log where user_id = u_hq));
  perform pg_temp.res('20 a helm.events address (Helm team) signs in: nothing at all',
    pg_temp.notes('r205_support@helm.events') = 0 and not exists (select 1 from public.signin_notice_log where user_id = u_helm));
  perform pg_temp.res('21 a deactivated member: nothing', pg_temp.notes('r205_off@a.test') = 0 and not exists (select 1 from public.signin_notice_log where user_id = u_off));
  -- HQ staff are never named as a recipient either
  perform pg_temp.su(); update public.profiles set role = 'admin' where id = u_hq; perform pg_temp.clear('r205_crew@a.test');
  perform pg_temp.mode(orgA, 'every', array['crew']);
  perform pg_temp.signin('r205_crew@a.test');
  d := pg_temp.last_note('r205_crew@a.test');
  perform pg_temp.res('22 an HQ operator with the admin role in the studio is never named on a notice',
    d is not null and not ((d -> 'notify') ? u_hq::text), coalesce(d::text, 'none'));
  perform pg_temp.su(); update public.profiles set role = 'manager' where id = u_hq; delete from public.signin_notice_settings where org_id = orgA;

  -- 23 the sample studio is never told
  orgS := gen_random_uuid();
  insert into public.organizations(id, name, slug, is_sample_master) values (orgS, 'R205 Sample', 'r205-sample-' || left(orgS::text, 8), true);
  u_samp := auth.seed_user('r205_sample@s.test');
  insert into public.profiles(id, email, role, org_id, full_name, must_change_password) values (u_samp, 'r205_sample@s.test', 'sales', orgS, 'Sample', false)
    on conflict (id) do update set org_id = excluded.org_id;
  update public.profiles set org_id = orgS, role = 'admin' where id = a_admin2;
  perform pg_temp.signin('r205_sample@s.test');
  perform pg_temp.res('23 the sample studio: nothing', pg_temp.notes('r205_sample@s.test') = 0 and not exists (select 1 from public.signin_notice_log where user_id = u_samp));
  update public.profiles set org_id = orgA, role = 'admin' where id = a_admin2;

  -- 24-25 an invited person: signs in first (no studio yet), then joins -> "for the first time"; an old sign-in joining -> nothing
  perform pg_temp.su();
  u_inv := auth.seed_user('r205_spandana@a.test');
  update public.profiles set org_id = null where id = u_inv;
  insert into public.profiles(id, email, role, org_id, full_name, must_change_password) values (u_inv, 'r205_spandana@a.test', 'manager', null, 'Spandana', false)
    on conflict (id) do update set org_id = null, role = 'manager', full_name = 'Spandana';
  update auth.users set last_sign_in_at = null where id = u_inv;
  perform pg_temp.signin('r205_spandana@a.test', 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1');
  ok := pg_temp.notes('r205_spandana@a.test') = 0 and not exists (select 1 from public.signin_notice_log where user_id = u_inv);
  update public.profiles set org_id = orgA where id = u_inv;     -- what accept_invitation does
  d := pg_temp.last_note('r205_spandana@a.test');
  perform pg_temp.res('24 invited: nothing before joining; joining = "Spandana (Event manager) signed in for the first time - ... - Safari on iPhone"',
    ok and pg_temp.notes('r205_spandana@a.test') = 1 and d ->> 'label' like 'Spandana (Event manager) signed in for the first time ' || chr(183) || ' % ' || chr(183) || ' Safari on iPhone'
    and (pg_temp.last_log('r205_spandana@a.test')).via = 'join', coalesce(d::text, 'none'));
  update public.profiles set org_id = null where id = u_inv; perform pg_temp.clear('r205_spandana@a.test');
  update auth.users set last_sign_in_at = now() - interval '2 hours' where id = u_inv;
  perform pg_temp.su(); perform set_config('helm.signin_notice', 'on', false);
  update public.profiles set org_id = orgA where id = u_inv;
  perform pg_temp.res('25 joining a studio without a sign-in in the last 30 minutes: nothing', pg_temp.notes('r205_spandana@a.test') = 0);

  -- 26 the trigger never fails a sign-in: the log table gone for a moment -> the sign-in update still succeeds
  perform pg_temp.su(); perform pg_temp.clear('a_staff@a.test');
  alter table public.signin_notice_log rename to signin_notice_log_r205_away;
  e := pg_temp.try($q$update auth.users set last_sign_in_at = clock_timestamp() where email = 'a_staff@a.test'$q$);
  alter table public.signin_notice_log_r205_away rename to signin_notice_log;
  perform pg_temp.res('26 a broken notice never blocks the sign-in (the update succeeds, nothing raised)', e = '', e);

  -- 27 a session kept quiet (helm.signin_notice = off, the other DB suites) and the SQL-editor rule
  perform set_config('helm.signin_notice', 'off', false); perform pg_temp.clear('a_staff@a.test');
  perform pg_temp.signin('a_staff@a.test');
  perform set_config('helm.signin_notice', 'on', false);
  perform pg_temp.res('27 helm.signin_notice = off: nothing; hand edits as postgres / supabase_admin are not sign-ins',
    pg_temp.notes('a_staff@a.test') = 0 and not exists (select 1 from public.signin_notice_log where user_id = a_staff)
    and position('''postgres'', ''supabase_admin''' in (select p.prosrc from pg_proc p where p.oid = 'public._r383_trigger_may()'::regprocedure)) > 0);

  -- 28-30 the browser fallback ping: a no-op while the trigger is on; with the trigger off it tells once per session
  perform pg_temp.su(); perform pg_temp.clear('a_staff@a.test');
  s := gen_random_uuid();
  insert into auth.sessions(id, user_id, user_agent, created_at) values (s, a_staff, 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Firefox/131.0', clock_timestamp());
  perform pg_temp.login('a_staff@a.test', s);
  r := public.signin_notice_ping(null);
  perform pg_temp.su();
  perform pg_temp.res('28 ping while the trigger is on: does nothing (via trigger)', r ->> 'via' = 'trigger' and pg_temp.notes('a_staff@a.test') = 0, r::text);
  perform pg_temp.su(); alter table auth.users disable trigger zz_r383_signin_notice;
  perform pg_temp.login('a_staff@a.test', s);
  r := public.signin_notice_ping('ignored when the session has a browser');
  perform pg_temp.login('a_staff@a.test', s);
  r := r || jsonb_build_object('second', public.signin_notice_ping(null));
  perform pg_temp.su();
  d := pg_temp.last_note('a_staff@a.test');
  perform pg_temp.res('29 trigger off: the ping tells once (Firefox on Mac from the session); the same session again: nothing',
    r ->> 'via' = 'ping' and (r ->> 'notified')::boolean and not (r -> 'second' ->> 'notified')::boolean
    and pg_temp.notes('a_staff@a.test') = 1 and d ->> 'device' = 'Firefox on Mac' and (pg_temp.last_log('a_staff@a.test')).via = 'ping', r::text);
  perform pg_temp.login('a_staff@a.test');
  r := public.signin_notice_ping(null);
  perform pg_temp.anon();
  e := pg_temp.try($q$select public.signin_notice_ping(null)$q$);
  perform pg_temp.res('30 ping without a session id: skipped; signed out: not callable (42501)',
    r ->> 'skipped' = 'no_session' and e like '42501%', r::text || ' ' || e);
  perform pg_temp.su(); alter table auth.users enable trigger zz_r383_signin_notice;

  -- 31-35 Settings: admins only, validated, audited, own studio
  perform pg_temp.login('a_admin@a.test');
  r := public.signin_notice_settings_get();
  perform pg_temp.res('31 settings never saved: First sign-in each day, every role except crew, digest off, trigger mode',
    r ->> 'mode' = 'first_daily' and (r ->> 'roles_default')::boolean and not ((r -> 'roles') ? 'crew') and (r -> 'roles') ? 'planner'
    and (r -> 'roles_all') ? 'crew' and not (r ->> 'email_digest')::boolean and (r ->> 'can_edit')::boolean and r ->> 'via' = 'trigger', r::text);
  perform pg_temp.login('a_admin@a.test');
  r := public.signin_notice_settings_set('{"mode":"every","roles":["manager","Crew"," planner "]}');
  perform pg_temp.res('32 admin saves Every sign-in + roles (trimmed, lower case); audited',
    r ->> 'mode' = 'every' and r -> 'roles' = '["crew","manager","planner"]'::jsonb and not (r ->> 'roles_default')::boolean
    and exists (select 1 from public.audit_log a where a.action = 'signin_notice.settings' and a.org_id = orgA and a.actor = a_admin
                  and a.changed -> 'to' ->> 'mode' = 'every'), r::text);
  perform pg_temp.login('a_admin@a.test');
  e := pg_temp.try($q$select public.signin_notice_settings_set('{"mode":"sometimes"}')$q$)
       || ' | ' || pg_temp.try($q$select public.signin_notice_settings_set('{"roles":["client"]}')$q$)
       || ' | ' || pg_temp.try($q$select public.signin_notice_settings_set('"x"')$q$);
  perform pg_temp.res('33 bad mode / unknown role (client) / not an object: refused 22023', e like '22023%| 22023%| 22023%', e);
  perform pg_temp.login('a_admin@a.test');
  r := public.signin_notice_settings_set('{"roles":null}');
  perform pg_temp.res('34 roles null = back to the default (mode kept)', r ->> 'mode' = 'every' and (r ->> 'roles_default')::boolean, r::text);
  perform pg_temp.login('a_staff@a.test');
  e := pg_temp.try($q$select public.signin_notice_settings_get()$q$) || ' | ' || pg_temp.try($q$select public.signin_notice_settings_set('{"mode":"off"}')$q$);
  perform pg_temp.anon();
  e := e || ' | ' || pg_temp.try($q$select public.signin_notice_settings_get()$q$);
  perform pg_temp.su();
  perform pg_temp.res('35 a non-admin cannot read or change it (42501); signed out refused; studio B untouched',
    e like '42501%| 42501%| 42%' and not exists (select 1 from public.signin_notice_settings where org_id = orgB), e);

  -- 36 the notification type: in the catalog once, admins only by default, its own kind
  perform pg_temp.res('36 type team_signin: in the catalog once, admin yes / planner no by default, kind maps to it',
    (select count(*) from jsonb_array_elements(public.notification_catalog()) c where c ->> 'type' = 'team_signin') = 1
    and public.notify_default(orgA, 'admin', 'team_signin', 'in_app') and not public.notify_default(orgA, 'planner', 'team_signin', 'in_app')
    and not public.notify_default(orgA, 'admin', 'team_signin', 'email')
    and public.notification_type_of('team_signin', 'in_app') = 'team_signin' and public.notification_type_of('task_assigned', 'in_app') = 'task_assigned');
end $$;

-- 37 wrapped once, triggers in place
select pg_temp.res('37 wrapped once (__pre0383 kept, no __pre0383__pre0383), both triggers present',
  to_regprocedure('public._r23_visible__pre0383(uuid,uuid)') is not null and to_regprocedure('public.bell_feed__pre0383(integer)') is not null
  and to_regprocedure('public._r23_visible__pre0383__pre0383(uuid,uuid)') is null and to_regprocedure('public.notification_catalog__pre0383__pre0383()') is null
  and position('r205-0383' in (select p.prosrc from pg_proc p where p.oid = 'public._r23_visible(uuid,uuid)'::regprocedure)) > 0
  and exists (select 1 from pg_trigger where tgname = 'zz_r383_signin_notice' and tgrelid = 'auth.users'::regclass and not tgisinternal)
  and exists (select 1 from pg_trigger where tgname = 'zz_r383_join_notice' and tgrelid = 'public.profiles'::regclass and not tgisinternal));

-- 38 grants + definer + search_path
select pg_temp.res('38 settings / ping: signed-in only, not anon; helpers + triggers: no app privilege; definer + empty search_path; tables closed',
  has_function_privilege('authenticated', 'public.signin_notice_settings_get()', 'execute')
  and has_function_privilege('authenticated', 'public.signin_notice_settings_set(jsonb)', 'execute')
  and has_function_privilege('authenticated', 'public.signin_notice_ping(text)', 'execute')
  and not has_function_privilege('anon', 'public.signin_notice_settings_get()', 'execute')
  and not has_function_privilege('anon', 'public.signin_notice_ping(text)', 'execute')
  and not has_function_privilege('authenticated', 'public._r383_signin(uuid,uuid,text,boolean,text)', 'execute')
  and not has_function_privilege('authenticated', 'public.tg_r383_signin()', 'execute')
  and not has_function_privilege('authenticated', 'public._r23_visible__pre0383(uuid,uuid)', 'execute')
  and has_function_privilege('authenticated', 'public.bell_feed(integer)', 'execute')
  and not has_table_privilege('authenticated', 'public.signin_notice_log', 'select')
  and not has_table_privilege('authenticated', 'public.signin_notice_settings', 'select')
  and not has_table_privilege('anon', 'public.signin_notice_log', 'select')
  and (select bool_and(p.prosecdef and coalesce(p.proconfig, '{}') @> array['search_path=""'])
         from pg_proc p where p.oid in ('public._r383_signin(uuid,uuid,text,boolean,text)'::regprocedure, 'public.tg_r383_signin()'::regprocedure,
           'public.tg_r383_join()'::regprocedure, 'public.signin_notice_ping(text)'::regprocedure, 'public.signin_notice_settings_get()'::regprocedure,
           'public.signin_notice_settings_set(jsonb)'::regprocedure, 'public.bell_feed(integer)'::regprocedure)));

-- 39 free-trial retention: the sign-in log is studio data (purged with a trial studio), the setting is kept
select pg_temp.res('39 trial retention: signin_notice_log on the PURGE list (not kept), signin_notice_settings KEPT',
  'signin_notice_log' = any (public._tr184_purge_tables()) and not ('signin_notice_log' = any (public._tr184_keep_tables()))
  and 'signin_notice_settings' = any (public._tr184_keep_tables()) and not ('signin_notice_settings' = any (public._tr184_purge_tables())));

select pg_temp.su();
do $$ declare n int; f int; r record; begin
  select count(*), count(*) filter (where result <> 'PASS') into n, f from _r205;
  for r in select * from _r205 where result <> 'PASS' loop raise warning '% -> %', r.name, r.result; end loop;
  if f = 0 then raise warning 'R205-SIGNIN-NOTICE-0383: ALL PASS (%/%)', n, n;
  else raise warning 'R205-SIGNIN-NOTICE-0383: % FAILED of %', f, n; end if;
end $$;
rollback;
