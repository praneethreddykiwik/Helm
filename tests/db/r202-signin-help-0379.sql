-- r202-signin-help-0379.sql - R202 (0379): "Send sign-in link" + "New temporary password" in Settings -> Users & invites.
-- team_signin_link_request: admin / Users EDIT only, own studio only, never yourself, never a deactivated person,
-- once per 10 minutes per person (a failed send lifts the wait, only for the caller's own request), activity log.
-- team_temp_password_reset: ADMIN only, own studio only, only a never-signed-in login this studio made with Add user,
-- a new one-time temporary password (the login really takes it, the old one stops working, still has to be changed at
-- first sign-in), once per 10 minutes per person, activity log without the password. team_account_status: the 0378
-- answer + signin_link_at + can_new_temp. The log table is closed to the app. Nothing deleted. Re-applies 0379 twice.
-- Rolled back.
\set ON_ERROR_STOP 0
set client_min_messages = error;
\ir ../../supabase/migrations/0379_r202_signin_help.sql
\ir ../../supabase/migrations/0379_r202_signin_help.sql
set client_min_messages = warning;
begin;
create temp table _r202(name text, result text); grant all on _r202 to anon, authenticated, service_role;
create or replace function pg_temp.su() returns void language plpgsql as $$
begin execute 'reset role'; perform auth.logout(); execute 'reset role'; end $$;
create or replace function pg_temp.login(p_email text) returns void language plpgsql as $$
declare u uuid; begin
  perform pg_temp.su(); select id into u from auth.users where email = p_email;
  perform set_config('request.jwt.claims', jsonb_build_object('sub', u, 'role', 'authenticated', 'email', p_email, 'aal', 'aal1')::text, false);
  perform set_config('role', 'authenticated', false);
end $$;
create or replace function pg_temp.anon() returns void language plpgsql as $$
begin perform pg_temp.su(); perform set_config('request.jwt.claims', '{"role":"anon"}', false); perform set_config('role', 'anon', false); end $$;
create or replace function pg_temp.res(p_name text, p_ok boolean, p_detail text default '') returns void language plpgsql as $$
begin perform pg_temp.su(); insert into _r202 values (p_name, case when coalesce(p_ok, false) then 'PASS' else 'FAIL: '||coalesce(p_detail,'') end); end $$;
create or replace function pg_temp.try(p_sql text) returns text language plpgsql as $$
begin execute p_sql; return ''; exception when others then return sqlstate || ' ' || sqlerrm; end $$;
grant execute on function pg_temp.try(text) to anon, authenticated, service_role;
create or replace function pg_temp.link(p uuid) returns jsonb language plpgsql as $$ begin return public.team_signin_link_request(p); end $$;
create or replace function pg_temp.temp(p uuid) returns jsonb language plpgsql as $$ begin return public.team_temp_password_reset(p); end $$;
create or replace function pg_temp.status() returns jsonb language plpgsql as $$ begin return public.team_account_status(); end $$;
grant execute on function pg_temp.link(uuid) to anon, authenticated; grant execute on function pg_temp.temp(uuid) to anon, authenticated;
grant execute on function pg_temp.status() to anon, authenticated;
create or replace function pg_temp.m(p jsonb, p_email text) returns jsonb language sql as $$
  select e from jsonb_array_elements(p -> 'members') e where e ->> 'user_id' = (select id::text from auth.users where email = p_email) $$;
grant execute on function pg_temp.m(jsonb, text) to authenticated;

do $$ declare orgA uuid := 'a0000000-0000-4000-8000-000000000001'; orgB uuid := 'b0000000-0000-4000-8000-000000000001';
  a_admin uuid; a_staff uuid; b_admin uuid; u_temp uuid; u_inv uuid; u_off uuid; r jsonb; r2 jsonb; e text; n int; n0 int;
  h0 text; h1 text; v_tp text; v_id bigint;
begin
  perform pg_temp.su();
  select id into a_admin from auth.users where email = 'a_admin@a.test';
  select id into a_staff from auth.users where email = 'a_staff@a.test';
  select id into b_admin from auth.users where email = 'b_admin@b.test';
  update auth.users set last_sign_in_at = now() - interval '1 day' where id in (a_admin, a_staff, b_admin);
  -- an "Add user" login of studio A: temporary password, never signed in (as admin_create_user_temp leaves it)
  u_temp := auth.seed_user('r202_added@a.test', 'HmOldTempPassword1!');
  update auth.users set last_sign_in_at = null where id = u_temp;
  insert into public.profiles(id, email, role, org_id, must_change_password, created_at)
    values (u_temp, 'r202_added@a.test', 'crew', orgA, true, now() - interval '2 days')
    on conflict (id) do update set org_id = excluded.org_id, must_change_password = true;
  insert into public.a155_admin_created(user_id, org_id, created_by, pw_hash)
    select u_temp, orgA, a_admin, u.encrypted_password from auth.users u where u.id = u_temp on conflict (user_id) do nothing;
  insert into public.auth_temp_passwords(user_id, pw_hash)
    select u_temp, u.encrypted_password from auth.users u where u.id = u_temp on conflict (user_id) do update set pw_hash = excluded.pw_hash;
  -- joined through an invitation (their own password), never signed in - NOT an Add user login
  u_inv := auth.seed_user('r202_joined@a.test');
  update auth.users set last_sign_in_at = null where id = u_inv;
  insert into public.profiles(id, email, role, org_id, must_change_password) values (u_inv, 'r202_joined@a.test', 'crew', orgA, false)
    on conflict (id) do update set org_id = excluded.org_id;
  -- a deactivated Add user login
  u_off := auth.seed_user('r202_off@a.test');
  update auth.users set last_sign_in_at = null where id = u_off;
  insert into public.profiles(id, email, role, org_id, must_change_password) values (u_off, 'r202_off@a.test', 'crew', orgA, true)
    on conflict (id) do update set org_id = excluded.org_id;
  insert into public.a155_admin_created(user_id, org_id, created_by) values (u_off, orgA, a_admin) on conflict (user_id) do nothing;
  insert into public.team_member_status(user_id, org_id, status, changed_at, deactivated_at) values (u_off, orgA, 'deactivated', now(), now())
    on conflict (user_id, org_id) do update set status = 'deactivated';
  delete from public.role_access where role = 'sales' and area = 'users' and org_id = orgA;
  select count(*) into n0 from public.profiles;

  -- 01 signed out: every call refused
  perform pg_temp.anon();
  e := pg_temp.try(format('select pg_temp.link(%L)', u_temp)) || '|' || pg_temp.try(format('select pg_temp.temp(%L)', u_temp));
  perform pg_temp.res('01 signed out: link + temp refused', e ~ '^42501.*\|42501', e);

  -- 02 no Users edit (sales): link refused
  perform pg_temp.login('a_staff@a.test');
  e := pg_temp.try(format('select pg_temp.link(%L)', u_temp));
  perform pg_temp.res('02 no Users edit: link refused 42501', e like '42501%', e);

  -- 03 admin: link for the Add user login -> ok + the e-mail; log row + activity log
  perform pg_temp.login('a_admin@a.test');
  r := pg_temp.link(u_temp);
  perform pg_temp.su();
  perform pg_temp.res('03 admin: sign-in link ok, e-mail returned, logged + activity log',
    (r ->> 'ok')::boolean and r ->> 'email' = 'r202_added@a.test'
    and exists (select 1 from public.team_signin_help h where h.id = (r ->> 'id')::bigint and h.user_id = u_temp and h.actor = a_admin and h.kind = 'link' and h.studio_id = orgA)
    and exists (select 1 from public.audit_log a where a.action = 'team.signin_link' and a.entity_id = u_temp::text and a.org_id = orgA and a.actor = a_admin), r::text);
  v_id := (r ->> 'id')::bigint;

  -- 04 again within 10 minutes: answered (not raised) rate_limited with the wait
  perform pg_temp.login('a_admin@a.test');
  r := pg_temp.link(u_temp);
  perform pg_temp.res('04 second link inside 10 min: rate_limited, retry 1..600 s',
    not (r ->> 'ok')::boolean and r ->> 'code' = 'rate_limited' and (r ->> 'retry_after_s')::int between 1 and 600, r::text);

  -- 05 a failed send by ANOTHER admin's session lifts nothing; the caller's own failed send lifts the wait
  perform pg_temp.login('a_staff@a.test');
  e := pg_temp.try(format('select public.team_signin_link_failed(%s)', v_id));
  perform pg_temp.login('a_admin@a.test');
  r := pg_temp.link(u_temp);
  perform public.team_signin_link_failed(v_id);
  r2 := pg_temp.link(u_temp);
  perform pg_temp.res('05 failed send: only the caller''s own request lifts the wait',
    r ->> 'code' = 'rate_limited' and (r2 ->> 'ok')::boolean, r::text || ' / ' || r2::text);

  -- 06 another studio's person: no such person; 07 yourself: use Forgot password; 08 deactivated: reactivate first
  perform pg_temp.login('a_admin@a.test');
  e := pg_temp.try(format('select pg_temp.link(%L)', b_admin));
  perform pg_temp.res('06 another studio''s person: P0002', e like 'P0002%', e);
  perform pg_temp.login('a_admin@a.test');
  e := pg_temp.try(format('select pg_temp.link(%L)', a_admin));
  perform pg_temp.res('07 yourself: 22023 "Forgot password"', e like '22023%Forgot password%', e);
  perform pg_temp.login('a_admin@a.test');
  e := pg_temp.try(format('select pg_temp.link(%L)', u_off)) || '|' || pg_temp.try(format('select pg_temp.temp(%L)', u_off));
  perform pg_temp.res('08 deactivated: link + temp refused "Reactivate them first"', e ~ '^22023 Reactivate them first.*\|22023 Reactivate them first', e);

  -- 09 a role WITH Users edit: link allowed, new temporary password still refused (admins only)
  perform pg_temp.su();
  insert into public.role_access(role, area, can_view, can_edit, org_id, updated_at) values ('sales', 'users', true, true, orgA, now());
  perform pg_temp.login('a_staff@a.test');
  r := pg_temp.link(u_inv);
  e := pg_temp.try(format('select pg_temp.temp(%L)', u_temp));
  perform pg_temp.res('09 Users edit: link ok, temp refused 42501', (r ->> 'ok')::boolean and e like '42501%', r::text || ' ' || e);

  -- 10 admin: new temporary password - the login takes it, the old one stops working, still must be changed
  perform pg_temp.su(); select encrypted_password into h0 from auth.users where id = u_temp;
  perform pg_temp.login('a_admin@a.test');
  r := pg_temp.temp(u_temp);
  perform pg_temp.su(); select encrypted_password into h1 from auth.users where id = u_temp; v_tp := r ->> 'temp_password';
  perform pg_temp.res('10 temp: new password works, old one not, must change at first sign-in, temp hash recorded',
    (r ->> 'ok')::boolean and v_tp ~ '^Hm[A-Za-z0-9xy]{16}[0-9][!#%*_+=?-]$' and h1 <> h0
    and extensions.crypt(v_tp, h1) = h1 and extensions.crypt('HmOldTempPassword1!', h1) <> h1
    and (select must_change_password from public.profiles where id = u_temp)
    and (select pw_hash from public.auth_temp_passwords where user_id = u_temp) = h1
    and (select pw_hash from public.a155_admin_created where user_id = u_temp) = h1, coalesce(r::text, 'null'));
  perform pg_temp.res('11 activity log names the action, never the password',
    exists (select 1 from public.audit_log a where a.action = 'team.temp_password_reset' and a.entity_id = u_temp::text and a.org_id = orgA)
    and not exists (select 1 from public.audit_log a where a.changed::text like '%' || v_tp || '%'), v_tp);
  -- the person can't clear "must change" while still on it (0028 rule kept)
  perform pg_temp.login('r202_added@a.test');
  e := pg_temp.try('select public.clear_password_change_required()');
  perform pg_temp.res('12 still on the temporary password: clear_password_change_required refused', e like '42501%', e);

  -- 13 again within 10 minutes: rate_limited, password unchanged
  perform pg_temp.login('a_admin@a.test');
  r := pg_temp.temp(u_temp);
  perform pg_temp.su();
  perform pg_temp.res('13 second temp inside 10 min: rate_limited, password unchanged',
    r ->> 'code' = 'rate_limited' and (select encrypted_password from auth.users where id = u_temp) = h1, r::text);

  -- 14 not an Add user login / has signed in / yourself: refused, nothing changed
  select encrypted_password into h0 from auth.users where id = u_inv;
  perform pg_temp.login('a_admin@a.test');
  e := pg_temp.try(format('select pg_temp.temp(%L)', u_inv)) || '|' || pg_temp.try(format('select pg_temp.temp(%L)', a_staff))
       || '|' || pg_temp.try(format('select pg_temp.temp(%L)', a_admin));
  perform pg_temp.su();
  perform pg_temp.res('14 temp refused for an invitation login, a signed-in member, yourself; nothing changed',
    e ~ '^22023 A new temporary password.*\|22023 A new temporary password.*\|22023 This is your own'
    and (select encrypted_password from auth.users where id = u_inv) = h0, e);
  -- once the Add user login HAS signed in, no admin can give it a new password any more
  update auth.users set last_sign_in_at = now() where id = u_temp;
  delete from public.team_signin_help where user_id = u_temp and kind = 'temp';
  perform pg_temp.login('a_admin@a.test');
  e := pg_temp.try(format('select pg_temp.temp(%L)', u_temp));
  perform pg_temp.res('15 after their first sign-in: temp refused (no take-over of a used account)', e like '22023%', e);
  perform pg_temp.su(); update auth.users set last_sign_in_at = null where id = u_temp;

  -- 16 studio B's admin can't touch studio A's person
  perform pg_temp.login('b_admin@b.test');
  e := pg_temp.try(format('select pg_temp.temp(%L)', u_temp)) || '|' || pg_temp.try(format('select pg_temp.link(%L)', u_temp));
  perform pg_temp.su();
  perform pg_temp.res('16 other studio admin: temp + link P0002, password unchanged',
    e ~ '^P0002.*\|P0002' and (select encrypted_password from auth.users where id = u_temp) = h1, e);

  -- 17 account status: + signin_link_at + can_new_temp (0378 keys kept)
  perform pg_temp.login('a_admin@a.test');
  r := pg_temp.status();
  perform pg_temp.su();
  perform pg_temp.res('17 status: can_new_temp only for the unused Add user login; signin_link_at; 0378 keys kept',
    (pg_temp.m(r, 'r202_added@a.test') ->> 'can_new_temp')::boolean
    and not (pg_temp.m(r, 'r202_joined@a.test') ->> 'can_new_temp')::boolean
    and not (pg_temp.m(r, 'a_staff@a.test') ->> 'can_new_temp')::boolean
    and not (pg_temp.m(r, 'a_admin@a.test') ->> 'can_new_temp')::boolean
    and not (pg_temp.m(r, 'r202_off@a.test') ->> 'can_new_temp')::boolean
    and pg_temp.m(r, 'r202_added@a.test') ->> 'signin_link_at' is not null
    and pg_temp.m(r, 'a_staff@a.test') -> 'signin_link_at' = 'null'::jsonb
    and (pg_temp.m(r, 'r202_added@a.test') ->> 'temp_password')::boolean
    and pg_temp.m(r, 'r202_added@a.test') ? 'needs_password' and r ? 'invites' and r ->> 'tz' is not null, (pg_temp.m(r, 'r202_added@a.test'))::text);
  perform pg_temp.login('a_staff@a.test');
  r := pg_temp.status();
  perform pg_temp.res('18 Users edit (not admin): can_new_temp false for everyone',
    not exists (select 1 from jsonb_array_elements(r -> 'members') x where (x ->> 'can_new_temp')::boolean), r::text);

  -- 19 the log table is closed to the app; 20 nothing deleted
  perform pg_temp.login('a_admin@a.test');
  e := pg_temp.try('select count(*) from public.team_signin_help');
  perform pg_temp.res('19 team_signin_help not readable by a signed-in user', e like '42501%', e);
  perform pg_temp.su();
  perform pg_temp.res('20 no profile deleted', (select count(*) from public.profiles) = n0, n0::text);
end $$;

-- 21 grants + definer + search_path + markers
select pg_temp.res('21 signed-in execute only, definer, empty search_path, markers (r199-0378 kept on the status body)',
  (select bool_and(has_function_privilege('authenticated', f, 'execute') and not has_function_privilege('anon', f, 'execute'))
     from unnest(array['public.team_signin_link_request(uuid)', 'public.team_signin_link_failed(bigint)', 'public.team_temp_password_reset(uuid)', 'public.team_account_status()']) f)
  and not has_function_privilege('authenticated', 'public._r379_temp_ok(uuid,uuid)', 'execute')
  and (select bool_and(p.prosecdef and coalesce(p.proconfig, '{}') @> array['search_path=""'] and position('r202-0379' in p.prosrc) > 0)
         from pg_proc p where p.oid in ('public.team_signin_link_request(uuid)'::regprocedure, 'public.team_temp_password_reset(uuid)'::regprocedure,
                                       'public.team_account_status()'::regprocedure, 'public._r379_temp_ok(uuid,uuid)'::regprocedure))
  and position('r199-0378' in (select prosrc from pg_proc where oid = 'public.team_account_status()'::regprocedure)) > 0);

select pg_temp.su();
do $$ declare n int; f int; r record; begin
  select count(*), count(*) filter (where result <> 'PASS') into n, f from _r202;
  for r in select * from _r202 where result <> 'PASS' loop raise warning '% -> %', r.name, r.result; end loop;
  if f = 0 then raise warning 'R202-SIGNIN-HELP-0379: ALL PASS (%/%)', n, n;
  else raise warning 'R202-SIGNIN-HELP-0379: % FAILED of %', f, n; end if;
end $$;
rollback;
