-- r210-role-sync-0386.sql - R210 (0386): a role change made in Settings -> Users reaches every copy of the role in the
-- same transaction, and one login = one studio. The prod report reproduced first (0386 triggers off): a member added
-- with "Add user" as Admin, an older open "Admin" invitation for the same e-mail, a linked staff record + login details
-- saying "Admin" -> changed to Event manager: profiles.role says manager but the invitation still says Admin (and is
-- still open), the staff record + login details still say Admin. With 0386: invitation closed (accepted by them,
-- activity log), staff record + login details say "Event manager", a job title / own words never touched, another
-- studio's invitation untouched, the old invitation link answers "already" and keeps the new role, a 24-hour admin
-- change applies the same way, a moved login is unlinked from the old studio's staff record (row kept). One login =
-- one studio: Add user refuses an address already used in another studio in any letter case / spaces; a login has
-- exactly one studio. Re-applies 0386 twice. Rolled back.
\set ON_ERROR_STOP 0
set client_min_messages = error;
\ir ../../supabase/migrations/0386_r210_role_sync.sql
\ir ../../supabase/migrations/0386_r210_role_sync.sql
set client_min_messages = warning;
begin;
create temp table _r210(name text, result text); grant all on _r210 to anon, authenticated, service_role;
create or replace function pg_temp.su() returns void language plpgsql as $$
begin execute 'reset role'; perform auth.logout(); execute 'reset role'; end $$;
-- signed in with a fresh two-step code (adding / removing an Admin needs it, 0285)
create or replace function pg_temp.login(p_email text) returns void language plpgsql as $$
declare u uuid; begin
  perform pg_temp.su(); select id into u from auth.users where email = p_email;
  perform set_config('request.jwt.claims', jsonb_build_object('sub', u, 'role', 'authenticated', 'email', p_email, 'aal', 'aal2',
    'amr', jsonb_build_array(jsonb_build_object('method', 'totp', 'timestamp', extract(epoch from now())::bigint)))::text, false);
  perform set_config('role', 'authenticated', false);
end $$;
create or replace function pg_temp.res(p_name text, p_ok boolean, p_detail text default '') returns void language plpgsql as $$
begin perform pg_temp.su(); insert into _r210 values (p_name, case when coalesce(p_ok, false) then 'PASS' else 'FAIL: '||coalesce(p_detail,'') end); end $$;
create or replace function pg_temp.try(p_sql text) returns text language plpgsql as $$
begin execute p_sql; return ''; exception when others then return sqlstate || ' ' || sqlerrm; end $$;
grant execute on function pg_temp.try(text) to anon, authenticated, service_role;
create or replace function pg_temp.mk(p_email text, p_role text) returns jsonb language plpgsql as $$ begin return public.admin_create_user_temp(p_email, p_role); end $$;
create or replace function pg_temp.setrole(p uuid, p_role text) returns jsonb language plpgsql as $$ begin return public.team_set_role(p, p_role); end $$;
create or replace function pg_temp.accept(p_tok text) returns jsonb language plpgsql as $$ begin return public.accept_invitation(p_tok); end $$;
grant execute on function pg_temp.mk(text, text) to authenticated; grant execute on function pg_temp.setrole(uuid, text) to authenticated;
grant execute on function pg_temp.accept(text) to authenticated;
-- the Add user login of studio A, an older open "Admin" invitation for the same e-mail, a linked staff record + login
-- details that say "Admin", a second member whose staff record carries a job title, and B's invitation for the same e-mail
create or replace function pg_temp.setup() returns uuid language plpgsql as $$
declare orgA uuid := 'a0000000-0000-4000-8000-000000000001'; orgB uuid := 'b0000000-0000-4000-8000-000000000001';
        a_admin uuid; b_admin uuid; u uuid; r jsonb;
begin
  perform pg_temp.su();
  select id into a_admin from auth.users where email = 'a_admin@a.test';
  select id into b_admin from auth.users where email = 'b_admin@b.test';
  insert into auth.mfa_factors(user_id, status) select a_admin, 'verified'
   where not exists (select 1 from auth.mfa_factors f where f.user_id = a_admin and f.status = 'verified');
  insert into public.invitations(org_id, email, role, token, invited_by, status, expires_at, created_at)
    values (orgA, 'spandana@a.test', 'admin', 'r210-old-admin-invite', a_admin, 'pending', now() + interval '6 days', now() - interval '1 day'),
           (orgB, 'spandana@a.test', 'planner', 'r210-b-invite', b_admin, 'pending', now() + interval '6 days', now());
  perform pg_temp.login('a_admin@a.test');
  r := pg_temp.mk('spandana@a.test', 'admin');
  u := (r ->> 'user_id')::uuid;
  perform pg_temp.su();
  update auth.users set raw_user_meta_data = jsonb_build_object('studio', 'A', 'role', 'Admin') where id = u;
  insert into public.crew_members(org_id, name, phone, email, role, profile_id, active)
    values (orgA, 'Spandana', '+919800000210', 'spandana@a.test', 'Admin', u, true);
  return u;
end $$;

-- ---- 01-03 the prod report reproduced: 0386 off ---------------------------------------------------------------
do $$ declare u uuid; r jsonb; b1 boolean; b2 boolean; b3 boolean; d text; begin
  -- inside a block that is undone at its end (only the three answers are kept)
  begin
    perform pg_temp.su();
    alter table public.profiles disable trigger zzzzz_r386_role_sync;
    u := pg_temp.setup();
    perform pg_temp.login('a_admin@a.test');
    r := pg_temp.setrole(u, 'manager');
    perform pg_temp.su();
    b1 := (r ->> 'ok')::boolean and not (r ->> 'scheduled')::boolean and (select role from public.profiles where id = u) = 'manager';
    b2 := (select status || '/' || role from public.invitations where token = 'r210-old-admin-invite') = 'pending/admin';
    b3 := (select role from public.crew_members where profile_id = u) = 'Admin'
          and (select raw_user_meta_data ->> 'role' from auth.users where id = u) = 'Admin';
    d := r::text;
    raise exception 'r210 undo' using errcode = 'P0R21';
  exception when sqlstate 'P0R21' then null;
  end;
  perform pg_temp.res('01 before 0386: the change is saved where access is decided (profiles.role = manager, team_set_role ok)', b1, d);
  perform pg_temp.res('02 before 0386 (the bug): the old invitation for the same e-mail still says Admin and is still open', b2);
  perform pg_temp.res('03 before 0386 (the bug): staff record + login details still say Admin', b3);
end $$;

-- ---- 04-12 with 0386 --------------------------------------------------------------------------------------------
do $$ declare orgA uuid := 'a0000000-0000-4000-8000-000000000001'; orgB uuid := 'b0000000-0000-4000-8000-000000000001';
  u uuid; u2 uuid; a_admin uuid; r jsonb; e text; n0 int;
begin
  u := pg_temp.setup();
  perform pg_temp.su();
  select id into a_admin from auth.users where email = 'a_admin@a.test';
  -- a second member whose staff record shows a job title (never touched)
  u2 := auth.seed_user('r210_titled@a.test');
  insert into public.profiles(id, email, role, org_id) values (u2, 'r210_titled@a.test', 'crew', orgA)
    on conflict (id) do update set org_id = excluded.org_id, role = excluded.role;
  insert into public.crew_members(org_id, name, phone, email, role, profile_id, active)
    values (orgA, 'Titled', '+919800000211', 'r210_titled@a.test', 'Manager / Production', u2, true);
  select count(*) into n0 from public.profiles;

  perform pg_temp.login('a_admin@a.test');
  r := pg_temp.setrole(u, 'manager');
  perform pg_temp.su();
  perform pg_temp.res('04 Admin -> Event manager by the owner: saved at once (profiles.role = manager)',
    (r ->> 'ok')::boolean and not (r ->> 'scheduled')::boolean and (select role from public.profiles where id = u) = 'manager', r::text);
  perform pg_temp.res('05 the old "Admin" invitation of this studio for that e-mail is closed (accepted by them), same transaction',
    (select status = 'accepted' and accepted_by = u and accepted_at is not null and role = 'admin'
       from public.invitations where token = 'r210-old-admin-invite'));
  perform pg_temp.res('06 activity log: team.invite.superseded with the invitation + its old role',
    exists (select 1 from public.audit_log a where a.action = 'team.invite.superseded' and a.entity_id = u::text and a.org_id = orgA
              and a.actor = a_admin and a.changed -> 'invitations' -> 0 ->> 'role' = 'admin'));
  perform pg_temp.res('07 staff record + login details now say "Event manager" (other login details kept)',
    (select role from public.crew_members where profile_id = u and org_id = orgA) = 'Event manager'
    and (select raw_user_meta_data ->> 'role' = 'Event manager' and raw_user_meta_data ->> 'studio' = 'A' from auth.users where id = u));
  perform pg_temp.res('08 another studio''s invitation for the same e-mail is untouched',
    (select status || '/' || role from public.invitations where token = 'r210-b-invite') = 'pending/planner');

  -- 09 the old invitation link afterwards: "already", and the role stays Event manager
  perform pg_temp.su(); update public.profiles set must_change_password = false where id = u;
  perform pg_temp.login('spandana@a.test');
  e := pg_temp.try('select pg_temp.accept(''r210-old-admin-invite'')');
  perform pg_temp.su();
  perform pg_temp.res('09 opening the old Admin invitation link later never makes them Admin',
    e = '' and (select role from public.profiles where id = u) = 'manager' and (select org_id from public.profiles where id = u) = orgA, e);

  -- 10 a job title / own words on a staff record are never renamed; a same-role save touches nothing
  perform pg_temp.login('a_admin@a.test');
  r := pg_temp.setrole(u2, 'planner');
  r := pg_temp.setrole(u, 'manager');
  perform pg_temp.su();
  perform pg_temp.res('10 job title kept on the staff record; same role again = unchanged',
    (select role from public.crew_members where profile_id = u2) = 'Manager / Production'
    and (select role from public.profiles where id = u2) = 'planner' and (r ->> 'unchanged')::boolean, r::text);

  -- 11 Event manager -> Admin -> Planner (owner): the staff words follow each step
  perform pg_temp.login('a_admin@a.test');
  r := pg_temp.setrole(u, 'admin');
  perform pg_temp.su();
  e := (select role from public.crew_members where profile_id = u);
  perform pg_temp.login('a_admin@a.test');
  r := pg_temp.setrole(u, 'planner');
  perform pg_temp.su();
  perform pg_temp.res('11 every step follows: Admin then Planner on the staff record + login details',
    e = 'Admin' and (select role from public.crew_members where profile_id = u) = 'Planner'
    and (select raw_user_meta_data ->> 'role' from auth.users where id = u) = 'Planner', e);

  -- 12 a login moved to another studio (0155 path) is unlinked from the old studio's staff record; the row is kept
  perform pg_temp.su();
  update public.profiles set org_id = orgB, role = 'planner' where id = u2;
  perform pg_temp.res('12 moved login: the old studio''s staff record kept, no longer linked, logged; nothing deleted',
    (select profile_id is null and name = 'Titled' and role = 'Manager / Production' and active from public.crew_members where email = 'r210_titled@a.test' and org_id = orgA)
    and exists (select 1 from public.audit_log a where a.action = 'staff.login_unlinked' and a.entity_id = u2::text and a.org_id = orgA)
    and (select count(*) from public.profiles) = n0);
end $$;

-- ---- 13 a 24-hour admin change (0283) applies the same way ------------------------------------------------------
do $$ declare orgA uuid := 'a0000000-0000-4000-8000-000000000001'; a_admin uuid; u3 uuid; begin
  perform pg_temp.su();
  select id into a_admin from auth.users where email = 'a_admin@a.test';
  u3 := auth.seed_user('r210_admin3@a.test');
  insert into public.profiles(id, email, role, org_id) values (u3, 'r210_admin3@a.test', 'admin', orgA)
    on conflict (id) do update set org_id = excluded.org_id, role = excluded.role;
  insert into public.invitations(org_id, email, role, token, invited_by, status, expires_at)
    values (orgA, 'R210_Admin3@A.test ', 'admin', 'r210-admin3-invite', a_admin, 'pending', now() + interval '3 days');
  insert into public.team_admin_changes(org_id, target_user, kind, new_role, requested_by, effective_at)
    values (orgA, u3, 'demote', 'sales', a_admin, now() - interval '1 minute');
  perform public._r283_apply_due(orgA);
  perform pg_temp.res('13 24-hour admin change applied: role sales + that e-mail''s open invitation closed (any letter case / spaces)',
    (select role from public.profiles where id = u3) = 'sales'
    and (select status from public.invitations where token = 'r210-admin3-invite') = 'accepted');
end $$;

-- ---- 14-15 one login = one studio --------------------------------------------------------------------------------
do $$ declare e text; r jsonb; begin
  perform pg_temp.login('a_admin@a.test');
  -- refused: answered { refused: true } (0282) or raised "send them an invitation instead" (an older body re-applied by a suite)
  begin
    e := coalesce((select (pg_temp.mk(' B_ADMIN@B.test ', 'crew')) ->> 'refused'), 'created');
  exception when others then e := case when sqlerrm like '%send them an invitation instead%' then 'true' else sqlstate || ' ' || sqlerrm end;
  end;
  perform pg_temp.su();
  perform pg_temp.res('14 Add user refuses an address already used in another studio (upper case + spaces too)',
    e = 'true' and (select count(*) from auth.users where lower(btrim(email)) = 'b_admin@b.test') = 1
    and (select org_id from public.profiles p join auth.users u on u.id = p.id where u.email = 'b_admin@b.test') = 'b0000000-0000-4000-8000-000000000001', e);
  perform pg_temp.res('15 a login has exactly one studio (profiles keyed by the login, one org_id column)',
    (select count(*) from pg_constraint c where c.conrelid = 'public.profiles'::regclass and c.contype = 'p'
       and c.conkey = array[(select attnum from pg_attribute where attrelid = 'public.profiles'::regclass and attname = 'id')]) = 1
    and not exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'profiles' and column_name in ('org_ids', 'studios')));
end $$;

-- 16 grants + definer + search_path + markers + both triggers there
select pg_temp.res('16 trigger functions closed to the app, definer, empty search_path, r210-0386 markers, both triggers',
  (select bool_and(p.prosecdef and coalesce(p.proconfig, '{}') @> array['search_path=""'] and position('r210-0386' in p.prosrc) > 0
                   and not has_function_privilege('authenticated', p.oid, 'execute') and not has_function_privilege('anon', p.oid, 'execute'))
     from pg_proc p where p.oid in ('public._r386_tg_role_sync()'::regprocedure, 'public._r386_tg_left_studio()'::regprocedure))
  and (select count(*) from pg_trigger t where t.tgrelid = 'public.profiles'::regclass and t.tgname in ('zzzzz_r386_role_sync', 'zzzzz_r386_left_studio') and t.tgenabled = 'O') = 2);

select pg_temp.su();
do $$ declare n int; f int; r record; begin
  select count(*), count(*) filter (where result <> 'PASS') into n, f from _r210;
  for r in select * from _r210 where result <> 'PASS' loop raise warning '% -> %', r.name, r.result; end loop;
  if f = 0 then raise warning 'R210-ROLE-SYNC-0386: ALL PASS (%/%)', n, n;
  else raise warning 'R210-ROLE-SYNC-0386: % FAILED of %', f, n; end if;
end $$;
rollback;
