-- r199-team-status-0378.sql - R199 (0378): team_account_status() - the account status of my studio's people and open
-- invitations for Settings -> Users & invites. Admin / Users EDIT only (anon, no-Users-edit, Users-view-only refused),
-- own studio only (studio B never sees A and the other way round), sign-in facts (last sign-in, never signed in,
-- invitation login without a password, temporary password), deactivated, joined via an invitation + who invited,
-- open invitations: newest per e-mail, expired flagged, revoked / accepted / already-a-member left out, e-mail sent
-- time + status; reading writes nothing. Plus R199 question 6 (re-adding a deactivated staff record): the database
-- takes a second record with the same e-mail / phone (no unique rule), but never a second record with the phone of a
-- LINKED account (23505 with a plain sentence). All dates relative to now(). Re-applies 0378 twice. Rolled back.
\set ON_ERROR_STOP 0
set client_min_messages = error;
\ir ../../supabase/migrations/0378_r199_team_account_status.sql
\ir ../../supabase/migrations/0378_r199_team_account_status.sql
set client_min_messages = warning;
begin;
create temp table _r199(name text, result text); grant all on _r199 to anon, authenticated, service_role;
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
begin perform pg_temp.su(); insert into _r199 values (p_name, case when coalesce(p_ok, false) then 'PASS' else 'FAIL: '||coalesce(p_detail,'') end); end $$;
create or replace function pg_temp.try(p_sql text) returns text language plpgsql as $$
begin execute p_sql; return ''; exception when others then return sqlstate || ' ' || sqlerrm; end $$;
grant execute on function pg_temp.try(text) to anon, authenticated, service_role;
create or replace function pg_temp.status() returns jsonb language plpgsql as $$
begin return public.team_account_status(); end $$;
grant execute on function pg_temp.status() to anon, authenticated, service_role;
create or replace function pg_temp.m(p jsonb, p_email text) returns jsonb language sql as $$
  select e from jsonb_array_elements(p -> 'members') e
   where e ->> 'user_id' = (select id::text from auth.users where email = p_email) $$;
create or replace function pg_temp.i(p jsonb, p_email text) returns jsonb language sql as $$
  select e from jsonb_array_elements(p -> 'invites') e where e ->> 'email' = p_email $$;
grant execute on function pg_temp.m(jsonb, text) to authenticated; grant execute on function pg_temp.i(jsonb, text) to authenticated;

do $$ declare orgA uuid := 'a0000000-0000-4000-8000-000000000001'; orgB uuid := 'b0000000-0000-4000-8000-000000000001';
  a_admin uuid; a_staff uuid; b_admin uuid; u_new uuid; u_inv uuid; u_off uuid; r jsonb; e text; n int; n0 int; i1 uuid; i2 uuid;
  c1 uuid; c_link uuid;
begin
  perform pg_temp.su();
  select id into a_admin from auth.users where email = 'a_admin@a.test';
  select id into a_staff from auth.users where email = 'a_staff@a.test';
  select id into b_admin from auth.users where email = 'b_admin@b.test';
  update public.profiles set full_name = 'Asha Admin' where id = a_admin;
  update auth.users set last_sign_in_at = now() - interval '3 days', email_confirmed_at = now() - interval '30 days' where id = a_admin;
  update auth.users set last_sign_in_at = null where id = a_staff;
  -- a member who joined through an invitation (sent 5 days ago by Asha, accepted 4 days ago), never signed in since
  u_inv := auth.seed_user('r199_joined@a.test');
  insert into public.profiles(id, email, role, org_id, must_change_password, created_at)
    values (u_inv, 'r199_joined@a.test', 'crew', orgA, false, now() - interval '4 days') on conflict (id) do update set org_id = excluded.org_id;
  update auth.users set last_sign_in_at = null where id = u_inv;
  insert into public.invitations(org_id, email, role, status, invited_by, expires_at, accepted_at, accepted_by, created_at)
    values (orgA, 'r199_joined@a.test', 'crew', 'accepted', a_admin, now() + interval '2 days', now() - interval '4 days', u_inv, now() - interval '5 days');
  -- an invitation login with no password (the Supabase invite mailer made it) + an admin-made temporary-password login
  u_new := auth.seed_user('r199_nopw@a.test');
  update auth.users set encrypted_password = '', last_sign_in_at = null where id = u_new;
  insert into public.profiles(id, email, role, org_id, must_change_password, created_at)
    values (u_new, 'r199_nopw@a.test', 'crew', orgA, true, now()) on conflict (id) do update set org_id = excluded.org_id, must_change_password = true;
  -- a deactivated member
  u_off := auth.seed_user('r199_off@a.test');
  insert into public.profiles(id, email, role, org_id, must_change_password, created_at)
    values (u_off, 'r199_off@a.test', 'crew', orgA, false, now() - interval '60 days') on conflict (id) do update set org_id = excluded.org_id;
  insert into public.team_member_status(user_id, org_id, status, changed_at, deactivated_at)
    values (u_off, orgA, 'deactivated', now() - interval '1 day', now() - interval '1 day')
    on conflict (user_id, org_id) do update set status = 'deactivated', deactivated_at = excluded.deactivated_at;
  -- open invitations of studio A: one sent today (valid 7 days), one expired, an older + a newer one for the same e-mail,
  -- one revoked, one for someone already a member; studio B: one of its own
  insert into public.invitations(org_id, email, role, status, invited_by, expires_at, created_at)
    values (orgA, 'r199_fresh@a.test', 'manager', 'pending', a_admin, now() + interval '7 days', now() - interval '1 hour') returning id into i1;
  insert into public.invitations(org_id, email, role, status, invited_by, expires_at, created_at)
    values (orgA, 'r199_old@a.test', 'crew', 'pending', a_admin, now() - interval '1 day', now() - interval '8 days');
  insert into public.invitations(org_id, email, role, status, invited_by, expires_at, created_at)
    values (orgA, 'r199_twice@a.test', 'crew', 'pending', a_admin, now() - interval '2 days', now() - interval '9 days');
  insert into public.invitations(org_id, email, role, status, invited_by, expires_at, created_at)
    values (orgA, 'r199_twice@a.test', 'sales', 'pending', a_admin, now() + interval '6 days', now() - interval '1 day') returning id into i2;
  insert into public.invitations(org_id, email, role, status, invited_by, expires_at, created_at)
    values (orgA, 'r199_revoked@a.test', 'crew', 'revoked', a_admin, now() + interval '6 days', now() - interval '1 day');
  insert into public.invitations(org_id, email, role, status, invited_by, expires_at, created_at)
    values (orgA, 'a_staff@a.test', 'crew', 'pending', a_admin, now() + interval '6 days', now() - interval '1 day');
  insert into public.invitations(org_id, email, role, status, invited_by, expires_at, created_at)
    values (orgB, 'r199_bonly@b.test', 'crew', 'pending', b_admin, now() + interval '6 days', now() - interval '1 day');
  update public.invite_email_outbox set status = 'sent', sent_at = now() - interval '50 minutes' where invitation_id = i1;

  -- 01 signed out: refused
  perform pg_temp.anon();
  e := pg_temp.try('select pg_temp.status()');
  perform pg_temp.res('01 signed out: refused (42501 or no execute)', e like '42501%', e);

  -- 02 a role without Users edit (sales): refused; Users VIEW only: still refused
  perform pg_temp.su();
  delete from public.role_access where role = 'sales' and area = 'users' and org_id = orgA;
  perform pg_temp.login('a_staff@a.test');
  e := pg_temp.try('select pg_temp.status()');
  perform pg_temp.res('02 no Users edit: refused 42501', e like '42501%', e);
  perform pg_temp.su();
  insert into public.role_access(role, area, can_view, can_edit, org_id, updated_at) values ('sales', 'users', true, false, orgA, now());
  perform pg_temp.login('a_staff@a.test');
  e := pg_temp.try('select pg_temp.status()');
  perform pg_temp.res('03 Users view only: refused 42501', e like '42501%', e);

  -- 04 the admin: every member of studio A and nobody from B
  perform pg_temp.su(); select count(*) into n0 from public.invitations;
  perform pg_temp.login('a_admin@a.test');
  r := pg_temp.status();
  perform pg_temp.su();
  select count(*) into n from jsonb_array_elements(r -> 'members') x where (x ->> 'user_id')::uuid in (select id from public.profiles where org_id = orgA);
  perform pg_temp.res('04 admin: all studio A members, none of B',
    n = jsonb_array_length(r -> 'members') and n = (select count(*) from public.profiles where org_id = orgA)
    and pg_temp.m(r, 'b_admin@b.test') is null and pg_temp.i(r, 'r199_bonly@b.test') is null, r::text);
  perform pg_temp.res('05 studio time zone + now', r ->> 'tz' = 'Asia/Kolkata' and (r ->> 'now')::timestamptz <= now(), r ->> 'tz');
  perform pg_temp.res('06 last sign-in of the admin (3 days ago), never for the others',
    abs(extract(epoch from ((pg_temp.m(r, 'a_admin@a.test') ->> 'last_sign_in_at')::timestamptz - (now() - interval '3 days')))) < 5
    and pg_temp.m(r, 'a_staff@a.test') -> 'last_sign_in_at' = 'null'::jsonb
    and (pg_temp.m(r, 'a_admin@a.test') ->> 'email_confirmed')::boolean, (pg_temp.m(r, 'a_admin@a.test'))::text);
  perform pg_temp.res('07 invitation login without a password + temporary password flagged',
    (pg_temp.m(r, 'r199_nopw@a.test') ->> 'needs_password')::boolean and (pg_temp.m(r, 'r199_nopw@a.test') ->> 'temp_password')::boolean
    and not (pg_temp.m(r, 'a_admin@a.test') ->> 'needs_password')::boolean and not (pg_temp.m(r, 'a_admin@a.test') ->> 'temp_password')::boolean,
    (pg_temp.m(r, 'r199_nopw@a.test'))::text);
  perform pg_temp.res('08 deactivated member flagged with the date; others not',
    (pg_temp.m(r, 'r199_off@a.test') ->> 'deactivated')::boolean and pg_temp.m(r, 'r199_off@a.test') ->> 'deactivated_at' is not null
    and not (pg_temp.m(r, 'a_staff@a.test') ->> 'deactivated')::boolean and pg_temp.m(r, 'a_staff@a.test') -> 'deactivated_at' = 'null'::jsonb,
    (pg_temp.m(r, 'r199_off@a.test'))::text);
  perform pg_temp.res('09 joined through an invitation: joined = accepted, invited 5 days ago by Asha Admin',
    pg_temp.m(r, 'r199_joined@a.test') ->> 'invited_by_name' = 'Asha Admin'
    and abs(extract(epoch from ((pg_temp.m(r, 'r199_joined@a.test') ->> 'joined_at')::timestamptz - (now() - interval '4 days')))) < 5
    and abs(extract(epoch from ((pg_temp.m(r, 'r199_joined@a.test') ->> 'invited_at')::timestamptz - (now() - interval '5 days')))) < 5
    and pg_temp.m(r, 'a_staff@a.test') -> 'invited_by_name' = 'null'::jsonb, (pg_temp.m(r, 'r199_joined@a.test'))::text);
  perform pg_temp.res('10 open invite: sent, expires in 7 days, not expired, by Asha, e-mail sent 50 min ago',
    pg_temp.i(r, 'r199_fresh@a.test') ->> 'role' = 'manager' and not (pg_temp.i(r, 'r199_fresh@a.test') ->> 'expired')::boolean
    and pg_temp.i(r, 'r199_fresh@a.test') ->> 'invited_by_name' = 'Asha Admin'
    and pg_temp.i(r, 'r199_fresh@a.test') ->> 'email_status' = 'sent'
    and abs(extract(epoch from ((pg_temp.i(r, 'r199_fresh@a.test') ->> 'emailed_at')::timestamptz - (now() - interval '50 minutes')))) < 5
    and (pg_temp.i(r, 'r199_fresh@a.test') ->> 'expires_at')::timestamptz > now() + interval '6 days', (pg_temp.i(r, 'r199_fresh@a.test'))::text);
  perform pg_temp.res('11 expired invite still listed, flagged expired',
    (pg_temp.i(r, 'r199_old@a.test') ->> 'expired')::boolean, coalesce((pg_temp.i(r, 'r199_old@a.test'))::text, 'missing'));
  perform pg_temp.res('12 two invites for one e-mail: only the newest',
    (select count(*) from jsonb_array_elements(r -> 'invites') x where x ->> 'email' = 'r199_twice@a.test') = 1
    and pg_temp.i(r, 'r199_twice@a.test') ->> 'id' = i2::text and pg_temp.i(r, 'r199_twice@a.test') ->> 'role' = 'sales', r -> 'invites' #>> '{}');
  perform pg_temp.res('13 revoked / accepted / already-a-member invitations not listed',
    pg_temp.i(r, 'r199_revoked@a.test') is null and pg_temp.i(r, 'r199_joined@a.test') is null and pg_temp.i(r, 'a_staff@a.test') is null, (r -> 'invites')::text);
  perform pg_temp.res('14 no secret in the answer (token / password / mail key)',
    r::text !~* '(token|encrypted|mail_key|password_hash|"ip")' , r::text);
  perform pg_temp.res('15 reading wrote nothing', (select count(*) from public.invitations) = n0, n0::text);

  -- 16 a role WITH Users edit (sales, edit switched on) may read it
  perform pg_temp.su(); update public.role_access set can_edit = true where role = 'sales' and area = 'users' and org_id = orgA;
  perform pg_temp.login('a_staff@a.test');
  e := pg_temp.try('select pg_temp.status()');
  perform pg_temp.res('16 Users edit role: allowed', e = '', e);

  -- 17 studio B admin: only B
  perform pg_temp.login('b_admin@b.test');
  r := pg_temp.status();
  perform pg_temp.su();
  perform pg_temp.res('17 studio B: only B people + B invites',
    pg_temp.i(r, 'r199_bonly@b.test') is not null and pg_temp.i(r, 'r199_fresh@a.test') is null and pg_temp.m(r, 'a_admin@a.test') is null
    and not exists (select 1 from jsonb_array_elements(r -> 'members') x where (x ->> 'user_id')::uuid not in (select id from public.profiles where org_id = orgB)), r::text);

  -- 18-20 R199 question 6: a deactivated staff record re-added with the same e-mail + phone
  perform pg_temp.login('a_admin@a.test');
  insert into public.crew_members(name, phone, email, role, active) values ('R199 Ravi', '+919812345601', 'r199_ravi@a.test', 'Rigger', true) returning id into c1;
  update public.crew_members set active = false where id = c1;
  e := pg_temp.try($q$insert into public.crew_members(name, phone, email, role, active) values ('R199 Ravi', '+919812345601', 'r199_ravi@a.test', 'Rigger', true)$q$);
  perform pg_temp.su();
  select count(*) into n from public.crew_members where org_id = orgA and email = 'r199_ravi@a.test';
  perform pg_temp.res('18 Q6: same e-mail + phone as a DEACTIVATED record: the database takes a second record (no unique rule)', e = '' and n = 2, e || ' n=' || n);
  -- a linked record (a Helm login) owns its phone: a new unlinked record with that number is refused with a sentence
  perform pg_temp.su();
  insert into public.crew_members(name, phone, email, role, active, org_id, profile_id)
    values ('R199 Linked', '+919812345602', 'r199_joined@a.test', 'Crew', true, orgA, u_inv) returning id into c_link;
  perform pg_temp.login('a_admin@a.test');
  e := pg_temp.try($q$insert into public.crew_members(name, phone, role, active) values ('Someone Else', '+91 98123 45602', 'Crew', true)$q$);
  perform pg_temp.res('19 Q6: the phone of a LINKED account: refused 23505 "This number belongs to R199 Linked..."',
    e like '23505%This number belongs to R199 Linked%', e);
  perform pg_temp.su(); update public.crew_members set active = false where id = c_link;
  perform pg_temp.login('a_admin@a.test');
  e := pg_temp.try($q$insert into public.crew_members(name, phone, role, active) values ('Someone Else', '+919812345602', 'Crew', true)$q$);
  perform pg_temp.res('20 Q6: still refused when that linked record is deactivated (one account = one record)', e like '23505%', e);
end $$;

-- 21 grants + definer + search_path + marker
select pg_temp.res('21 signed-in execute only, definer, empty search_path, r199-0378 marker',
  has_function_privilege('authenticated', 'public.team_account_status()', 'execute')
  and not has_function_privilege('anon', 'public.team_account_status()', 'execute')
  and (select p.prosecdef and coalesce(p.proconfig, '{}') @> array['search_path=""'] and position('r199-0378' in p.prosrc) > 0
         from pg_proc p where p.oid = 'public.team_account_status()'::regprocedure));

select pg_temp.su();
do $$ declare n int; f int; r record; begin
  select count(*), count(*) filter (where result <> 'PASS') into n, f from _r199;
  for r in select * from _r199 where result <> 'PASS' loop raise warning '% -> %', r.name, r.result; end loop;
  if f = 0 then raise warning 'R199-TEAM-STATUS-0378: ALL PASS (%/%)', n, n;
  else raise warning 'R199-TEAM-STATUS-0378: % FAILED of %', f, n; end if;
end $$;
rollback;
