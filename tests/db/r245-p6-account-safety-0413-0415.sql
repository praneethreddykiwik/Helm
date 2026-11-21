-- r245-p6-account-safety-0413-0415.sql -- R245 (fix plan Phase 6 "Account and team safety": 0413 + 0414 + 0415).
-- Proves: (1) ACC-05 - a studio member's used login can not be deleted from auth.users by the dashboard role
-- (supabase_auth_admin) or the SQL editor (superuser) without the flag; the owner flag (this login / 'on', this transaction)
-- passes and another login's flag does not; never-used invitation logins, logins with no studio, the trial purge mark of
-- that studio, the 0296 purge mark and the DELETE-0398 order (profile first) pass; a bug in the check fails open;
-- (2) ACC-03 / ACC-04 - hq_account_checks: HQ People access only, unconfirmed logins older than the days (masked, never
-- deleted), same phone / same name + similar e-mail pairs across studios, client logins left out, nothing changed, one
-- HQ view row; (3) ACC-18 / ACC-24 - HQ promote + deactivate: signed-in non-HQ, HQ at aal1 and a non-Owner HQ role refused,
-- reason 20+ characters, client / deactivated refused, the member becomes admin with an HQ row + a studio row, deactivate =
-- the 0283 path (status deactivated, profile + login kept), never the owner, never the last admin, at most 5 a day, HQ can
-- not delete; grants. Re-applies 0413-0415 twice. Local disposable PG only. Fake data only. Rolled back.
\set ON_ERROR_STOP 0
set client_min_messages = error;
\ir ../../supabase/migrations/0413_r245_login_delete_guard.sql
\ir ../../supabase/migrations/0414_r245_hq_account_checks.sql
\ir ../../supabase/migrations/0415_r245_hq_member_actions.sql
\ir ../../supabase/migrations/0413_r245_login_delete_guard.sql
\ir ../../supabase/migrations/0414_r245_hq_account_checks.sql
\ir ../../supabase/migrations/0415_r245_hq_member_actions.sql
set client_min_messages = warning;
begin;
-- run-all pins helm.allow_purge=on for the older suites; this suite needs the marks off (each test turns on what it needs)
select set_config('helm.allow_purge', '', false), set_config('helm.allow_org_purge', '', false), set_config('helm.trial_purge_org', '', false),
       set_config('helm.allow_login_delete', '', false);
create temp table _rs(name text, result text); grant all on _rs to anon, authenticated, service_role, supabase_auth_admin;
create temp table _kv(k text primary key, v text); grant all on _kv to anon, authenticated, service_role, supabase_auth_admin;
grant usage on schema auth to supabase_auth_admin; grant select, delete on auth.users to supabase_auth_admin;   -- like Supabase: the dashboard's Auth admin owns these rows

create or replace function pg_temp.su() returns void language plpgsql as $$
begin execute 'reset role'; perform set_config('request.jwt.claims', '', false); perform set_config('request.headers', '', false); end $$;
create or replace function pg_temp.res(p_name text, p_ok boolean, p_detail text default '') returns void language plpgsql as $$
begin insert into _rs values (p_name, case when coalesce(p_ok, false) then 'PASS' else 'FAIL: '||coalesce(p_detail,'') end); end $$;
grant execute on function pg_temp.res(text, boolean, text) to anon, authenticated, service_role, supabase_auth_admin;
create or replace function pg_temp.try(p_sql text) returns text language plpgsql as $$
declare h text; begin execute p_sql; return ''; exception when others then
  get stacked diagnostics h = pg_exception_hint; return sqlstate || ' ' || sqlerrm || ' [' || coalesce(h, '') || ']'; end $$;
grant execute on function pg_temp.try(text) to anon, authenticated, service_role, supabase_auth_admin;
create or replace function pg_temp.put(p_k text, p_v text) returns void language plpgsql as $$
begin insert into _kv values (p_k, p_v) on conflict (k) do update set v = excluded.v; end $$;
create or replace function pg_temp.get(p_k text) returns text language sql as $$ select v from _kv where k = p_k $$;
grant execute on function pg_temp.get(text) to anon, authenticated, service_role, supabase_auth_admin;
create or replace function pg_temp.login(p_email text) returns void language plpgsql as $$
declare u uuid; begin
  perform pg_temp.su(); select id into u from auth.users where email = p_email;
  perform set_config('request.jwt.claims', jsonb_build_object('sub', u, 'role', 'authenticated', 'email', p_email, 'aal', 'aal1')::text, false);
  perform set_config('role', 'authenticated', false);
end $$;
create or replace function pg_temp.hq(p_email text, p_aal text default 'aal2') returns void language plpgsql as $$
declare u uuid; begin
  perform pg_temp.su(); select id into u from auth.users where email = p_email;
  perform set_config('request.jwt.claims', jsonb_build_object('sub', u, 'role', 'authenticated', 'email', p_email, 'aal', p_aal)::text, false);
  perform set_config('role', 'authenticated', false);
end $$;
create or replace function pg_temp.member(p_email text, p_org uuid, p_role text, p_name text default null) returns uuid language plpgsql as $$
declare u uuid; begin
  perform pg_temp.su(); select id into u from auth.users where email = p_email;
  if u is null then u := auth.seed_user(p_email); end if;
  insert into public.profiles(id, email, role, org_id, full_name, must_change_password, created_at)
    values (u, p_email, p_role, p_org, p_name, false, now())
    on conflict (id) do update set org_id = p_org, role = p_role, email = p_email, full_name = p_name;
  return u;
end $$;
create or replace function pg_temp.staff(p_email text, p_role text) returns void language plpgsql as $$
begin
  perform pg_temp.su();
  if not exists (select 1 from auth.users where email = p_email) then perform auth.seed_user(p_email); end if;
  insert into public.platform_admins(email, added_by, role) values (p_email, 'r245 test', p_role) on conflict (email) do nothing;
  update public.platform_admins set role = p_role, status = 'active', require_mfa = false,
         user_id = (select id from auth.users where email = p_email) where email = p_email;
end $$;
create or replace function pg_temp.org(p_name text) returns uuid language plpgsql as $$
declare o uuid; begin perform pg_temp.su(); insert into public.organizations(name) values (p_name) returning id into o; return o; end $$;
-- delete one login as the given role ('' = the superuser / SQL editor); answers '' or the error
create or replace function pg_temp.del_login(p_id uuid, p_as text default '') returns text language plpgsql as $$
declare e text; begin
  perform pg_temp.su();
  if p_as <> '' then execute format('set local role %I', p_as); end if;
  e := pg_temp.try(format('delete from auth.users where id = %L', p_id));
  perform pg_temp.su();
  return e;
end $$;

-- ---- setup ------------------------------------------------------------------------------------------------------------------
do $$ declare a uuid; b uuid; c uuid; begin
  perform pg_temp.staff('r245_owner@hqstaff.test', 'owner');
  perform pg_temp.staff('r245_support@hqstaff.test', 'support');
  perform pg_temp.staff('r245_viewer@hqstaff.test', 'viewer');
  perform pg_temp.su();
  update public.helm_hq_settings set hq_ip_allowlist_on = false where id;
  a := pg_temp.org('R245 Alpha'); b := pg_temp.org('R245 Beta'); c := pg_temp.org('R245 Gamma');
  perform pg_temp.put('a', a::text); perform pg_temp.put('b', b::text); perform pg_temp.put('c', c::text);
  perform pg_temp.put('a_owner', pg_temp.member('r245.aowner@alpha.test', a, 'admin', 'Asha Owner')::text);
  perform pg_temp.put('a_plan', pg_temp.member('r245.aplan@alpha.test', a, 'planner', 'Ravi Kumar')::text);
  perform pg_temp.put('a_crew', pg_temp.member('r245.acrew@alpha.test', a, 'crew', 'Crew One')::text);
  perform pg_temp.put('a_client', pg_temp.member('r245.aclient@alpha.test', a, 'client', 'Client One')::text);
  perform pg_temp.put('b_owner', pg_temp.member('r245.bowner@beta.test', b, 'admin', 'Bina Owner')::text);
  perform pg_temp.put('b_admin2', pg_temp.member('r245.badmin2@beta.test', b, 'admin', 'Second Admin')::text);
  -- ACC-04 look-alikes in studio Gamma: the same name + a similar e-mail as Alpha's planner, and the same phone as Alpha's crew
  perform pg_temp.put('c_ravi', pg_temp.member('ravi.kumar+gamma@gamma.test', c, 'sales', 'Ravi  Kumar')::text);
  perform pg_temp.put('c_phone', pg_temp.member('r245.cphone@gamma.test', c, 'planner', 'Phone Twin')::text);
  perform pg_temp.put('c_other', pg_temp.member('totally.different@gamma.test', c, 'planner', 'Crew One')::text);
  perform pg_temp.put('c_client', pg_temp.member('r245.cclient@gamma.test', c, 'client', 'Ravi Kumar')::text);
  perform pg_temp.su();
  update public.profiles set email = 'ravikumar@alpha.test' where id = pg_temp.get('a_plan')::uuid;
  update auth.users set email = 'ravikumar@alpha.test' where id = pg_temp.get('a_plan')::uuid;
  insert into public.member_profiles(user_id, phone) values (pg_temp.get('a_crew')::uuid, '+919876500413') on conflict (user_id) do update set phone = excluded.phone;
  insert into public.member_profiles(user_id, phone) values (pg_temp.get('c_phone')::uuid, '+919876500413') on conflict (user_id) do update set phone = excluded.phone;
exception when others then perform pg_temp.su(); insert into _rs values ('00 setup', 'FAIL: '||sqlstate||' '||sqlerrm); end $$;

-- ---- 1) structure + grants ----------------------------------------------------------------------------------------------------
do $$ begin
  perform pg_temp.su();
  perform pg_temp.res('01 one BEFORE DELETE row guard on auth.users (applied twice), definer, empty search_path',
    (select count(*) from pg_trigger t where t.tgrelid = 'auth.users'::regclass and t.tgname = 'a0_r413_login_delete_guard' and not t.tgisinternal) = 1
    and (select p.prosecdef and p.proconfig @> array['search_path=""'] from pg_proc p where p.oid = 'public._r413_tg_login_delete_guard()'::regprocedure));
  perform pg_temp.res('02 grants: the 3 HQ functions signed-in only; helpers + guard: no app privilege',
    has_function_privilege('authenticated', 'public.hq_account_checks(integer)', 'execute')
    and has_function_privilege('authenticated', 'public.hq_studio_member_promote(uuid,uuid,text)', 'execute')
    and has_function_privilege('authenticated', 'public.hq_studio_member_deactivate(uuid,uuid,text)', 'execute')
    and not has_function_privilege('anon', 'public.hq_account_checks(integer)', 'execute')
    and not has_function_privilege('anon', 'public.hq_studio_member_promote(uuid,uuid,text)', 'execute')
    and not has_function_privilege('anon', 'public.hq_studio_member_deactivate(uuid,uuid,text)', 'execute')
    and not has_function_privilege('authenticated', 'public._r415_hq_member_check(text,uuid,uuid,text)', 'execute')
    and not has_function_privilege('authenticated', 'public._r413_login_delete_allowed(uuid,uuid)', 'execute')
    and not has_function_privilege('authenticated', 'public._r414_email_key(text)', 'execute'));
  perform pg_temp.res('03 the 3 migrations recorded in helm_schema_markers',
    to_regclass('public.helm_schema_markers') is null or (select count(*) from public.helm_schema_markers where num between 413 and 415) = 3);
exception when others then perform pg_temp.su(); insert into _rs values ('0x', 'FAIL: '||sqlstate||' '||sqlerrm); end $$;

-- ---- 2) ACC-05: the login delete guard ---------------------------------------------------------------------------------------
do $$ declare u uuid := pg_temp.get('a_crew')::uuid; o uuid := pg_temp.get('a')::uuid; e text; begin
  e := pg_temp.del_login(u, 'supabase_auth_admin');
  perform pg_temp.res('10 dashboard delete (supabase_auth_admin) of a studio member''s login is refused with a plain message',
    e like '42501 This login belongs to a member of a studio team%Deactivate them in Settings -> Team%[login_delete_refused]'
    and exists (select 1 from auth.users where id = u) and exists (select 1 from public.profiles where id = u), e);
  e := pg_temp.del_login(u, '');
  perform pg_temp.res('11 a typed SQL-editor delete (superuser, no flag) is refused too', e like '42501 %[login_delete_refused]', e);
  perform set_config('helm.allow_login_delete', pg_temp.get('a_plan'), true);
  e := pg_temp.del_login(u, '');
  perform set_config('helm.allow_login_delete', '', true);
  perform pg_temp.res('12 the owner flag for ANOTHER login does not open this one', e like '42501 %[login_delete_refused]', e);
  perform set_config('helm.trial_purge_org', pg_temp.get('b'), true);
  e := pg_temp.del_login(u, 'supabase_auth_admin');
  perform set_config('helm.trial_purge_org', '', true);
  perform pg_temp.res('13 the trial-purge mark of ANOTHER studio does not open it', e like '42501 %[login_delete_refused]', e);
exception when others then perform pg_temp.su(); insert into _rs values ('1x', 'FAIL: '||sqlstate||' '||sqlerrm); end $$;

-- each pass case runs inside its own block and is undone (raise + catch), so the rows stay for the later tests
do $$ declare u uuid := pg_temp.get('a_crew')::uuid; e text; v text; begin
  begin
    perform set_config('helm.allow_login_delete', u::text, true);
    e := pg_temp.del_login(u, '');
    v := case when e = '' and not exists (select 1 from auth.users where id = u) and not exists (select 1 from public.profiles where id = u) then 'ok' else e end;
    raise exception 'undo';
  exception when raise_exception then null; end;
  perform set_config('helm.allow_login_delete', '', true);
  perform pg_temp.res('14 with the owner flag for THIS login the delete goes through (login + profile gone)', v = 'ok', v);
  begin
    perform set_config('helm.allow_login_delete', 'on', true);
    e := pg_temp.del_login(u, 'supabase_auth_admin');
    v := case when e = '' then 'ok' else e end;
    raise exception 'undo';
  exception when raise_exception then null; end;
  perform set_config('helm.allow_login_delete', '', true);
  perform pg_temp.res('15 flag = on (this transaction) passes', v = 'ok', v);
  begin
    perform set_config('helm.trial_purge_org', pg_temp.get('a'), true);
    e := pg_temp.del_login(u, 'supabase_auth_admin');
    v := case when e = '' then 'ok' else e end;
    raise exception 'undo';
  exception when raise_exception then null; end;
  perform set_config('helm.trial_purge_org', '', true);
  perform pg_temp.res('16 the free-trial purge of THIS studio (helm.trial_purge_org) is never blocked', v = 'ok', v);
  begin
    perform set_config('helm.allow_purge', 'on', true);
    e := pg_temp.del_login(u, '');
    v := case when e = '' then 'ok' else e end;
    raise exception 'undo';
  exception when raise_exception then null; end;
  perform set_config('helm.allow_purge', '', true);
  perform pg_temp.res('17 the existing 0296 server purge mark (helm.allow_purge) is honoured', v = 'ok', v);
  begin
    perform pg_temp.su();
    delete from public.profiles where id = u;      -- DELETE-0398 order: the profile first (owner script), then the login
    e := pg_temp.del_login(u, '');
    v := case when e = '' then 'ok' else e end;
    raise exception 'undo';
  exception when raise_exception then null; end;
  perform pg_temp.res('18 the DELETE-0398 order (profile first, then the login) still works', v = 'ok', v);
  begin
    -- a bug inside the check: it must fail OPEN (never block Supabase)
    execute $f$create or replace function public._r413_login_delete_allowed(p_user uuid, p_org uuid) returns boolean language plpgsql set search_path = '' as $b$
      begin raise exception 'simulated bug' using errcode = 'XX000'; end $b$ $f$;
    e := pg_temp.del_login(u, 'supabase_auth_admin');
    v := case when e = '' then 'ok' else e end;
    raise exception 'undo';
  exception when raise_exception then null; end;
  perform pg_temp.res('19 a bug in the check never blocks a delete (fails open); the real check is back afterwards',
    v = 'ok' and pg_temp.del_login(u, '') like '42501 %[login_delete_refused]', v);
exception when others then perform pg_temp.su(); insert into _rs values ('1y', 'FAIL: '||sqlstate||' '||sqlerrm); end $$;

do $$ declare inv uuid; nos uuid; e text; v text; begin
  perform pg_temp.su();
  inv := pg_temp.member('r245.invited@alpha.test', pg_temp.get('a')::uuid, 'planner', 'Invited Never');
  perform pg_temp.su();
  update auth.users set email_confirmed_at = null, last_sign_in_at = null, invited_at = now() where id = inv;
  nos := auth.seed_user('r245.nostudio@nowhere.test');
  begin
    e := pg_temp.del_login(inv, 'supabase_auth_admin') || '|' || pg_temp.del_login(nos, 'supabase_auth_admin');
    v := case when e = '|' and not exists (select 1 from auth.users where id in (inv, nos)) then 'ok' else e end;
    raise exception 'undo';
  exception when raise_exception then null; end;
  perform pg_temp.res('20 a never-used invitation login of a studio and a login with no studio can still be deleted (Supabase''s own flows)',
    v = 'ok', v);
  update auth.users set email_confirmed_at = null, last_sign_in_at = now() where id = inv;
  e := pg_temp.del_login(inv, 'supabase_auth_admin');
  perform pg_temp.res('21 an unconfirmed login that HAS signed in (a studio member) is protected', e like '42501 %[login_delete_refused]', e);
exception when others then perform pg_temp.su(); insert into _rs values ('2x', 'FAIL: '||sqlstate||' '||sqlerrm); end $$;

-- ---- 3) ACC-03 + ACC-04: hq_account_checks -----------------------------------------------------------------------------------
do $$ declare old_u uuid; new_u uuid; e text; r jsonb; n_users bigint; n_prof bigint; n_view bigint; rows jsonb; begin
  perform pg_temp.su();
  old_u := auth.seed_user('r245.stale.person@nowhere.test');
  new_u := auth.seed_user('r245.fresh.person@nowhere.test');
  update auth.users set email_confirmed_at = null, last_sign_in_at = null, created_at = now() - interval '40 days' where id = old_u;
  update auth.users set email_confirmed_at = null, last_sign_in_at = null, created_at = now() - interval '10 days' where id = new_u;
  perform pg_temp.put('old_u', old_u::text); perform pg_temp.put('new_u', new_u::text);
  perform pg_temp.login('r245.aowner@alpha.test');
  e := pg_temp.try('select public.hq_account_checks(30)');
  perform pg_temp.res('30 a studio admin (not HQ) is refused', e like '42501%', e);
  perform pg_temp.hq('r245_viewer@hqstaff.test');
  e := pg_temp.try('select public.hq_account_checks(30)');
  perform pg_temp.res('31 an HQ Viewer (no People access) is refused', e like '42501 not authorized: HQ_ROLE%', e);
  perform pg_temp.su();
  select count(*) into n_users from auth.users; select count(*) into n_prof from public.profiles;
  select count(*) into n_view from public.audit_log where action = 'hq.view' and entity = 'hq_account_checks';
  perform pg_temp.hq('r245_support@hqstaff.test');
  r := public.hq_account_checks(30);
  perform pg_temp.su();
  rows := r -> 'unconfirmed' -> 'rows';
  perform pg_temp.res('32 HQ Support (People access): unconfirmed + never signed in + older than 30 days is listed, a 10-day one is not',
    exists (select 1 from jsonb_array_elements(rows) x where x ->> 'user_id' = old_u::text and (x ->> 'days_old')::int >= 39)
    and not exists (select 1 from jsonb_array_elements(rows) x where x ->> 'user_id' = new_u::text)
    and not exists (select 1 from jsonb_array_elements(rows) x where x ->> 'user_id' = pg_temp.get('a_plan')), left(rows::text, 300));
  perform pg_temp.res('33 e-mails are masked (no full address anywhere in the answer)',
    r::text not like '%r245.stale.person@%' and r::text not like '%ravikumar@alpha%' and r::text not like '%9876500413%'
    and exists (select 1 from jsonb_array_elements(rows) x where x ->> 'user_id' = old_u::text and x ->> 'email' like '%@nowhere.test'), left(r::text, 300));
  perform pg_temp.res('34 the report changes nothing (same logins, same profiles) and writes one HQ view row',
    (select count(*) from auth.users) = n_users and (select count(*) from public.profiles) = n_prof
    and (select count(*) from public.audit_log where action = 'hq.view' and entity = 'hq_account_checks') = n_view + 1 and (r ->> 'read_only')::boolean);
  rows := r -> 'duplicates' -> 'rows';
  perform pg_temp.put('dups', rows::text);
  perform pg_temp.res('35 same phone in two studios is flagged (reason same_phone, not the same studio)',
    exists (select 1 from jsonb_array_elements(rows) x where x -> 'reasons' ? 'same_phone' and not (x ->> 'same_studio')::boolean
              and array[x -> 'a' ->> 'user_id', x -> 'b' ->> 'user_id'] @> array[pg_temp.get('a_crew'), pg_temp.get('c_phone')]), left(rows::text, 400));
  perform pg_temp.res('36 same name (spaces / case ignored) + a similar e-mail (dots / +tag ignored) is flagged',
    exists (select 1 from jsonb_array_elements(rows) x where x -> 'reasons' ? 'same_name_similar_email'
              and array[x -> 'a' ->> 'user_id', x -> 'b' ->> 'user_id'] @> array[pg_temp.get('a_plan'), pg_temp.get('c_ravi')]), left(rows::text, 400));
  perform pg_temp.res('37 same name with an unrelated e-mail is not flagged; client logins are left out',
    not exists (select 1 from jsonb_array_elements(rows) x
                 where array[x -> 'a' ->> 'user_id', x -> 'b' ->> 'user_id'] && array[pg_temp.get('c_other'), pg_temp.get('a_client'), pg_temp.get('c_client')]), left(rows::text, 400));
  perform pg_temp.hq('r245_support@hqstaff.test');
  r := public.hq_account_checks(7);
  perform pg_temp.su();
  perform pg_temp.res('38 days = 7 lists the 10-day-old login too; days are kept between 7 and 365',
    exists (select 1 from jsonb_array_elements(r -> 'unconfirmed' -> 'rows') x where x ->> 'user_id' = new_u::text) and (r ->> 'days')::int = 7);
exception when others then perform pg_temp.su(); insert into _rs values ('3x', 'FAIL: '||sqlstate||' '||sqlerrm); end $$;

-- ---- 4) ACC-18: HQ promote a named member to admin -----------------------------------------------------------------------------
do $$ declare a uuid := pg_temp.get('a')::uuid; u uuid := pg_temp.get('a_plan')::uuid; e text; r jsonb; ch jsonb; why text := 'Only admin left the studio; called the owner back on the registered number.'; begin
  perform pg_temp.login('r245.aowner@alpha.test');
  e := pg_temp.try(format('select public.hq_studio_member_promote(%L::uuid, %L::uuid, %L)', a, u, why));
  perform pg_temp.res('40 a signed-in studio admin (not HQ) is refused', e like '42501 not authorized%', e);
  perform pg_temp.hq('r245_owner@hqstaff.test', 'aal1');
  e := pg_temp.try(format('select public.hq_studio_member_promote(%L::uuid, %L::uuid, %L)', a, u, why));
  perform pg_temp.res('41 the HQ Owner WITHOUT two-step (aal1) is refused', e like '42501 not authorized%', e);
  perform pg_temp.hq('r245_support@hqstaff.test');
  e := pg_temp.try(format('select public.hq_studio_member_promote(%L::uuid, %L::uuid, %L)', a, u, why));
  perform pg_temp.res('42 HQ Support (not Owner) at aal2 is refused by the HQ role, before any look-up', e like '42501 not authorized: HQ_ROLE%', e);
  perform pg_temp.hq('r245_owner@hqstaff.test');
  e := pg_temp.try(format('select public.hq_studio_member_promote(%L::uuid, %L::uuid, %L)', a, u, 'too short'));
  perform pg_temp.res('43 a reason under 20 characters is refused', e like '22023 Write 20 to 1000 characters%', e);
  e := pg_temp.try(format('select public.hq_studio_member_promote(%L::uuid, %L::uuid, %L)', a, pg_temp.get('a_client'), why));
  perform pg_temp.res('44 a client login can not be made admin', e like '22023 This is a client login%', e);
  e := pg_temp.try(format('select public.hq_studio_member_promote(%L::uuid, %L::uuid, %L)', pg_temp.get('b'), u, why));
  perform pg_temp.res('45 a person of ANOTHER studio is refused', e like 'P0002 This person is not a member of this studio%', e);
  r := public.hq_studio_member_promote(a, u, why);
  perform pg_temp.su();
  select x.changed into ch from public.audit_log x where x.action = 'hq.studio.member_promote' and x.entity_id = u::text order by x.at desc limit 1;
  perform pg_temp.res('46 the HQ Owner at aal2 makes the planner an admin; HQ log row (masked e-mail, reason) + a studio activity row',
    (r ->> 'ok')::boolean and (select role from public.profiles where id = u) = 'admin'
    and ch ->> 'org_id' = a::text and ch ->> 'reason' = why and ch::text not like '%ravikumar@alpha%'
    and exists (select 1 from public.audit_log x where x.action = 'team.hq_promote' and x.org_id = a and x.entity_id = u::text),
    coalesce(r::text, '') || coalesce(ch::text, ''));
  perform pg_temp.res('47 the studio owner record is unchanged', public._r283_owner(a) = pg_temp.get('a_owner')::uuid);
  perform pg_temp.hq('r245_owner@hqstaff.test');
  r := public.hq_studio_member_promote(a, u, why);
  perform pg_temp.su();
  perform pg_temp.res('48 a second promote answers already (nothing changed)', (r ->> 'already')::boolean, r::text);
exception when others then perform pg_temp.su(); insert into _rs values ('4x', 'FAIL: '||sqlstate||' '||sqlerrm); end $$;

-- ---- 5) ACC-24: HQ deactivate a studio login (never delete) ---------------------------------------------------------------------
do $$ declare a uuid := pg_temp.get('a')::uuid; b uuid := pg_temp.get('b')::uuid; u uuid := pg_temp.get('a_crew')::uuid; e text; r jsonb;
        why text := 'Member left; the studio owner asked by e-mail and confirmed on a call back.'; begin
  perform pg_temp.hq('r245_support@hqstaff.test');
  e := pg_temp.try(format('select public.hq_studio_member_deactivate(%L::uuid, %L::uuid, %L)', a, u, why));
  perform pg_temp.res('50 HQ Support is refused (HQ Owner only)', e like '42501 not authorized: HQ_ROLE%', e);
  perform pg_temp.hq('r245_owner@hqstaff.test');
  e := pg_temp.try(format('select public.hq_studio_member_deactivate(%L::uuid, %L::uuid, %L)', a, pg_temp.get('a_owner'), why));
  perform pg_temp.res('51 the studio owner can not be deactivated from HQ', e like '42501 The studio owner can''t be deactivated%[owner_protected]', e);
  r := public.hq_studio_member_deactivate(a, u, why);
  perform pg_temp.su();
  perform pg_temp.res('52 deactivated with the 0283 path: status deactivated (reason kept), profile + login kept, HQ + studio rows, a bell row',
    (r ->> 'deactivated')::boolean and public._r283_is_off(u, a)
    and exists (select 1 from public.profiles where id = u and org_id = a) and exists (select 1 from auth.users where id = u)
    and (select s.reason from public.team_member_status s where s.user_id = u and s.org_id = a) like 'Helm support: Member left%'
    and exists (select 1 from public.audit_log x where x.action = 'hq.studio.member_deactivate' and x.entity_id = u::text)
    and exists (select 1 from public.audit_log x where x.action = 'team.deactivate' and x.org_id = a and x.entity_id = u::text)
    and exists (select 1 from public.notifications n where n.org_id = a and n.kind = 'team_safety' and n.detail ->> 'event' = 'hq_member_deactivated'),
    coalesce(r::text, ''));
  perform pg_temp.hq('r245_owner@hqstaff.test');
  r := public.hq_studio_member_deactivate(a, u, why);
  e := pg_temp.try(format('select public.hq_studio_member_promote(%L::uuid, %L::uuid, %L)', a, u, why));
  perform pg_temp.su();
  perform pg_temp.res('53 a second deactivate answers already; a deactivated person can not be made admin',
    (r ->> 'already')::boolean and e like '22023 This person is deactivated%', coalesce(r::text, '') || e);
  -- Beta: the recorded owner is off, the other admin is the last active admin
  insert into public.team_member_status(user_id, org_id, status, deactivated_at) values (pg_temp.get('b_owner')::uuid, b, 'deactivated', now())
    on conflict (user_id, org_id) do update set status = 'deactivated';
  perform pg_temp.hq('r245_owner@hqstaff.test');
  e := pg_temp.try(format('select public.hq_studio_member_deactivate(%L::uuid, %L::uuid, %L)', b, pg_temp.get('b_admin2'), why));
  perform pg_temp.res('54 the last active admin of a studio can not be deactivated', e like '42501 This is the studio''s last active admin%[last_admin]', e);
  -- HQ can not delete: a direct delete as the HQ person is refused, and the login delete guard holds for the dashboard
  e := pg_temp.try(format('delete from public.profiles where id = %L', u));
  perform pg_temp.su();
  perform pg_temp.res('55 HQ can deactivate but not delete: a direct profile delete is refused, the login stays protected, no delete in the HQ functions',
    e like '42501%' and exists (select 1 from public.profiles where id = u)
    and pg_temp.del_login(u, 'supabase_auth_admin') like '42501 %[login_delete_refused]'
    and (select bool_and(position('delete ' in lower(p.prosrc)) = 0) from pg_proc p
           where p.oid in ('public.hq_studio_member_deactivate(uuid,uuid,text)'::regprocedure, 'public.hq_studio_member_promote(uuid,uuid,text)'::regprocedure,
                           'public._r415_hq_member_check(text,uuid,uuid,text)'::regprocedure)), e);
exception when others then perform pg_temp.su(); insert into _rs values ('5x', 'FAIL: '||sqlstate||' '||sqlerrm); end $$;

do $$ declare a uuid := pg_temp.get('a')::uuid; i int; e text; begin
  -- 2 changes so far today by this HQ person (promote + deactivate); 3 more pass, the 6th is refused
  perform pg_temp.su();
  insert into public.audit_log(actor, actor_email, action, entity, entity_id, org_id, at)
    select (select id from auth.users where email = 'r245_owner@hqstaff.test'), 'r245_owner@hqstaff.test', 'hq.studio.member_promote', 'profiles', 'x' || g, null, now()
      from generate_series(1, 3) g;
  perform pg_temp.hq('r245_owner@hqstaff.test');
  e := pg_temp.try(format('select public.hq_studio_member_promote(%L::uuid, %L::uuid, %L)', a, pg_temp.get('a_owner'),
                          'Sixth change of the day, should be refused by the daily limit.'));
  perform pg_temp.su();
  perform pg_temp.res('56 at most 5 studio login changes per HQ person per 24 hours', e like 'P0001 Too many studio login changes%[rate_limited]', e);
exception when others then perform pg_temp.su(); insert into _rs values ('5y', 'FAIL: '||sqlstate||' '||sqlerrm); end $$;

select name, result from _rs order by name;
select case when count(*) filter (where result <> 'PASS') = 0 then 'R245-P6-ACCOUNT-SAFETY-0413-0415: ALL PASS (' || count(*) || '/' || count(*) || ')'
            else 'R245-P6-ACCOUNT-SAFETY-0413-0415: ' || count(*) filter (where result <> 'PASS') || ' FAILED of ' || count(*) end as summary from _rs;
rollback;
