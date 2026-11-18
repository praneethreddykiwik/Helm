-- r217-page-bootstrap-0389.sql - R217 (0389): page_bootstrap() answers a signed-in page's startup questions in ONE call.
-- Proves, against the real migrated database, that every part equals what the old separate call / read gives the SAME
-- signed-in person (same value, or the same refusal listed under errors):
--   * every role of the studio app (admin, manager, planner, coordinator, supervisor, operations, quality, designer,
--     sales, crew, worker, client) in studio A with the default switches, and a planner with CUSTOM switches;
--   * studio B's members only ever get studio B's answers (never A's custom switches), and A's never B's;
--   * a deactivated member gets no studio and no access switches, a member who must change the password is told so
--     (like the old reads);
--   * signed out (anon) is refused (no execute), a signed-in token with no user is refused (42501);
--   * read-only: no transaction id is assigned by a call (it writes nothing), stable, definer, empty search_path;
--   * re-applying 0389 twice changes no other function (definitions hashed before / after).
-- The old reads are made exactly like the page makes them: the RPCs as the signed-in user, profiles / role_access as
-- the signed-in user THROUGH their row-level security. Rolled back.
\set ON_ERROR_STOP 0
set client_min_messages = error;
select md5(string_agg(pg_get_functiondef(p.oid), '' order by p.oid)) as fn_before
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
 where n.nspname in ('public', 'auth') and p.prokind = 'f' and p.proname <> 'page_bootstrap' \gset
\ir ../../supabase/migrations/0389_r217_page_bootstrap.sql
\ir ../../supabase/migrations/0389_r217_page_bootstrap.sql
select md5(string_agg(pg_get_functiondef(p.oid), '' order by p.oid)) as fn_after
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
 where n.nspname in ('public', 'auth') and p.prokind = 'f' and p.proname <> 'page_bootstrap' \gset
set client_min_messages = warning;

-- read-only: a call in a fresh transaction gets no transaction id (nothing written, not even a lock-taking write)
begin;
select set_config('request.jwt.claims', jsonb_build_object('sub', (select id from auth.users where email = 'a_staff@a.test'), 'role', 'authenticated', 'aal', 'aal1')::text, true) is not null as _c \gset
set local role authenticated;
select (public.page_bootstrap() -> 'parts' ->> 'current_org_id') is not null and txid_current_if_assigned() is null as ro_ok \gset
rollback;

begin;
create temp table _r217(name text, result text); grant all on _r217 to anon, authenticated, service_role;
create or replace function pg_temp.su() returns void language plpgsql as $$
begin execute 'reset role'; perform auth.logout(); execute 'reset role'; end $$;
create or replace function pg_temp.login(p_uid uuid) returns void language plpgsql as $$
begin
  perform pg_temp.su();
  perform set_config('request.jwt.claims', jsonb_build_object('sub', p_uid, 'role', 'authenticated', 'aal', 'aal1')::text, false);
  perform set_config('role', 'authenticated', false);
end $$;
create or replace function pg_temp.res(p_name text, p_ok boolean, p_detail text default '') returns void language plpgsql as $$
begin perform pg_temp.su(); insert into _r217 values (p_name, case when coalesce(p_ok, false) then 'PASS' else 'FAIL: '||coalesce(p_detail,'') end); end $$;
grant execute on function pg_temp.res(text, boolean, text) to anon, authenticated;
-- one old call, as the page makes it: {"ok": <answer>} or {"err": <sqlstate>}
create or replace function pg_temp.old(p_fn text) returns jsonb language plpgsql as $$
declare v jsonb; begin
  execute format('select to_jsonb(public.%I())', p_fn) into v;
  return jsonb_build_object('ok', v);
exception when others then return jsonb_build_object('err', sqlstate); end $$;
-- every old read of the page for the signed-in caller (role_access + profiles through RLS)
create or replace function pg_temp.old_all() returns jsonb language plpgsql as $$
declare o jsonb := '{}'::jsonb; f text; v_role text; v_found boolean; begin
  foreach f in array array['current_org_id', 'my_profile_status', 'my_checkout_status', 'password_change_required', 'my_trial_org',
                           'my_trial_status', 'my_demo_status', 'my_subscription', 'my_test_studio', 'get_pricing_config', 'get_item_rate_cards'] loop
    o := o || jsonb_build_object(f, pg_temp.old(f));
  end loop;
  select p.role into v_role from public.profiles p where p.id = auth.uid();          -- profiles?select=role&id=eq.<me>
  v_found := found;
  if v_found then o := o || jsonb_build_object('profile_role', jsonb_build_object('ok', to_jsonb(v_role))); end if;
  if v_found and (o -> 'current_org_id' ->> 'ok') is not null then                    -- role_access?role=eq.<role>
    o := o || jsonb_build_object('role_access', jsonb_build_object('ok', coalesce((select jsonb_agg(jsonb_build_object('area', ra.area, 'can_view', ra.can_view, 'can_edit', ra.can_edit) order by ra.area)
                                                   from public.role_access ra where ra.role = coalesce(v_role, 'client')), '[]'::jsonb)));
  end if;
  return o;
end $$;
-- the same, from the one call: {"ok": parts.x} or {"err": errors.x}
create or replace function pg_temp.boot_all() returns jsonb language plpgsql as $$
declare b jsonb := public.page_bootstrap(); o jsonb := '{}'::jsonb; k text; begin
  for k in select jsonb_object_keys(b -> 'parts') loop o := o || jsonb_build_object(k, jsonb_build_object('ok', b -> 'parts' -> k)); end loop;
  for k in select jsonb_object_keys(b -> 'errors') loop o := o || jsonb_build_object(k, jsonb_build_object('err', b -> 'errors' -> k)); end loop;
  return o;
end $$;
create or replace function pg_temp.try(p_sql text) returns text language plpgsql as $$
begin execute p_sql; return ''; exception when others then return sqlstate; end $$;
grant execute on function pg_temp.old(text), pg_temp.old_all(), pg_temp.boot_all(), pg_temp.try(text) to anon, authenticated;

-- every role in studio A + B (default switches from the new-studio template), a planner in A with CUSTOM switches
do $$
declare orgA uuid := 'a0000000-0000-4000-8000-000000000001'; orgB uuid := 'b0000000-0000-4000-8000-000000000001';
        r text; u uuid;
begin
  perform pg_temp.su();
  insert into public.role_access(org_id, role, area, can_view, can_edit, updated_at)
    select o, d.role, d.area, d.can_view, d.can_edit, now() from public._a49_default_matrix() d, (values (orgA), (orgB)) x(o)
  on conflict (org_id, role, area) do nothing;
  foreach r in array array['admin', 'manager', 'planner', 'coordinator', 'supervisor', 'operations', 'quality', 'designer', 'sales', 'crew', 'worker', 'client'] loop
    u := auth.seed_user('r217_a_' || r || '@a.test', 'x');
    insert into public.profiles(id, email, role, org_id, must_change_password, created_at)
      values (u, 'r217_a_' || r || '@a.test', r, orgA, false, now() - interval '400 days')
      on conflict (id) do update set role = excluded.role, org_id = excluded.org_id, must_change_password = false;
    u := auth.seed_user('r217_b_' || r || '@b.test', 'x');
    insert into public.profiles(id, email, role, org_id, must_change_password, created_at)
      values (u, 'r217_b_' || r || '@b.test', r, orgB, false, now() - interval '400 days')
      on conflict (id) do update set role = excluded.role, org_id = excluded.org_id, must_change_password = false;
  end loop;
  -- studio A's custom switches for planners (B keeps the template)
  insert into public.role_access(org_id, role, area, can_view, can_edit, updated_at) values
    (orgA, 'planner', 'leads', false, false, now()), (orgA, 'planner', 'finance', true, true, now()), (orgA, 'planner', 'r217_custom', true, false, now())
  on conflict (org_id, role, area) do update set can_view = excluded.can_view, can_edit = excluded.can_edit;
  -- a deactivated member and a member still on a temporary password (both in A)
  u := auth.seed_user('r217_a_gone@a.test', 'x');
  insert into public.profiles(id, email, role, org_id, must_change_password, created_at) values (u, 'r217_a_gone@a.test', 'planner', orgA, false, now() - interval '400 days')
    on conflict (id) do update set role = excluded.role, org_id = excluded.org_id, must_change_password = false;
  insert into public.team_member_status(user_id, org_id, status, deactivated_at) values (u, orgA, 'deactivated', now()) on conflict do nothing;
  u := auth.seed_user('r217_a_temp@a.test', 'x');
  insert into public.profiles(id, email, role, org_id, must_change_password, created_at) values (u, 'r217_a_temp@a.test', 'sales', orgA, true, now() - interval '400 days')
    on conflict (id) do update set role = excluded.role, org_id = excluded.org_id, must_change_password = true;
end $$;

-- 01-24: page_bootstrap = the old separate calls, every role, both studios
do $$
declare r text; s text; u uuid; o jsonb; b jsonb; i int := 0;
begin
  foreach s in array array['a', 'b'] loop
    foreach r in array array['admin', 'manager', 'planner', 'coordinator', 'supervisor', 'operations', 'quality', 'designer', 'sales', 'crew', 'worker', 'client'] loop
      i := i + 1;
      perform pg_temp.su(); select id into u from auth.users where email = 'r217_' || s || '_' || r || '@' || s || '.test';
      perform pg_temp.login(u); o := pg_temp.old_all(); b := pg_temp.boot_all();
      perform pg_temp.res(lpad(i::text, 2, '0') || ' studio ' || upper(s) || ' ' || r || ': page_bootstrap = the old calls (' ||
        (select count(*) from jsonb_object_keys(o)) || ' answers)', o = b and o ? 'role_access' and b ? 'role_access',
        'old=' || o::text || ' boot=' || b::text);
    end loop;
  end loop;
end $$;

-- 25 custom switches: A's planner gets A's saved switches (incl. the custom row), exactly
do $$ declare u uuid; b jsonb; begin
  perform pg_temp.su(); select id into u from auth.users where email = 'r217_a_planner@a.test';
  perform pg_temp.login(u); b := public.page_bootstrap();
  perform pg_temp.res('25 custom switches: studio A planner sees A''s saved rows (leads off, finance on, the custom row)',
    b -> 'parts' -> 'role_access' @> '[{"area":"leads","can_view":false,"can_edit":false},{"area":"finance","can_view":true,"can_edit":true},{"area":"r217_custom","can_view":true,"can_edit":false}]'::jsonb
    and jsonb_array_length(b -> 'parts' -> 'role_access') = (select count(*) from public.role_access where org_id = 'a0000000-0000-4000-8000-000000000001' and role = 'planner'),
    b::text);
end $$;

-- 26 another studio: B's planner never gets A's custom switches; every row it gets is a B row; B's studio id
do $$ declare u uuid; b jsonb; begin
  perform pg_temp.su(); select id into u from auth.users where email = 'r217_b_planner@b.test';
  perform pg_temp.login(u); b := public.page_bootstrap();
  perform pg_temp.su();
  perform pg_temp.res('26 another studio: B''s planner gets only B''s rows (no custom row, same count as B) and B''s studio id',
    (b -> 'parts' ->> 'current_org_id') = 'b0000000-0000-4000-8000-000000000001'
    and not (b -> 'parts' -> 'role_access' @> '[{"area":"r217_custom"}]'::jsonb)
    and jsonb_array_length(b -> 'parts' -> 'role_access') = (select count(*) from public.role_access where org_id = 'b0000000-0000-4000-8000-000000000001' and role = 'planner')
    and b -> 'parts' -> 'role_access' = (select jsonb_agg(jsonb_build_object('area', area, 'can_view', can_view, 'can_edit', can_edit) order by area)
                                          from public.role_access where org_id = 'b0000000-0000-4000-8000-000000000001' and role = 'planner'),
    b::text);
end $$;

-- 27 the studio's own settings only: A's and B's admins get their own studio's pricing config / rate cards answer
do $$ declare ua uuid; ub uuid; ba jsonb; bb jsonb; oa jsonb; ob jsonb; begin
  perform pg_temp.su(); select id into ua from auth.users where email = 'r217_a_admin@a.test'; select id into ub from auth.users where email = 'r217_b_admin@b.test';
  perform pg_temp.login(ua); ba := public.page_bootstrap(); oa := pg_temp.old('get_pricing_config');
  perform pg_temp.login(ub); bb := public.page_bootstrap(); ob := pg_temp.old('get_pricing_config');
  perform pg_temp.res('27 each studio gets its own studio id + its own pricing config (= its own old call)',
    (ba -> 'parts' ->> 'current_org_id') = 'a0000000-0000-4000-8000-000000000001' and (bb -> 'parts' ->> 'current_org_id') = 'b0000000-0000-4000-8000-000000000001'
    and ba -> 'parts' -> 'get_pricing_config' = oa -> 'ok' and bb -> 'parts' -> 'get_pricing_config' = ob -> 'ok', ba::text || ' / ' || bb::text);
end $$;

-- 28 a deactivated member: no studio, no access switches (as the old reads: current_org_id null, role_access not read)
do $$ declare u uuid; b jsonb; o jsonb; begin
  perform pg_temp.su(); select id into u from auth.users where email = 'r217_a_gone@a.test';
  perform pg_temp.login(u); b := public.page_bootstrap(); o := pg_temp.old_all();
  perform pg_temp.res('28 deactivated member: no studio, no access switches, = the old calls',
    (b -> 'parts' -> 'current_org_id') = 'null'::jsonb and not (b -> 'parts' ? 'role_access') and o = pg_temp.boot_all(), b::text);
end $$;

-- 29 must change the password (must_change_password): told so; everything else = the old calls
do $$ declare u uuid; b jsonb; o jsonb; begin
  perform pg_temp.su(); select id into u from auth.users where email = 'r217_a_temp@a.test';
  perform pg_temp.login(u); b := public.page_bootstrap(); o := pg_temp.old_all();
  -- (the page then shows the "choose a new password" step before anything else - evaluateGate, unchanged)
  perform pg_temp.res('29 must change the password: password_change_required true, every answer = the old calls',
    (b -> 'parts' -> 'password_change_required') = 'true'::jsonb and o = pg_temp.boot_all(), b::text);
end $$;

-- 30 the original fixture users (A + B sales with the fixture's edit rows) as well
do $$ declare u uuid; e text; ok boolean := true; begin
  foreach e in array array['a_staff@a.test', 'b_staff@b.test', 'a_admin@a.test', 'b_admin@b.test'] loop
    perform pg_temp.su(); select id into u from auth.users where email = e;
    perform pg_temp.login(u); ok := ok and pg_temp.old_all() = pg_temp.boot_all();
  end loop;
  perform pg_temp.res('30 fixture users of both studios: page_bootstrap = the old calls', ok);
end $$;

-- 31 signed out: anon may not run it; 32 a token without a user: 42501
do $$ declare s text; begin
  perform pg_temp.su(); perform set_config('role', 'anon', false);
  s := pg_temp.try('select public.page_bootstrap()');
  perform pg_temp.res('31 signed out (anon): refused (42501 permission denied), no answer', s = '42501', s);
  perform pg_temp.su(); perform set_config('request.jwt.claims', '{"role":"authenticated"}', false); perform set_config('role', 'authenticated', false);
  s := pg_temp.try('select public.page_bootstrap()');
  perform pg_temp.res('32 signed-in role without a user id: refused (42501)', s = '42501', s);
end $$;

-- 33 read-only (no transaction id assigned by a call), stable, definer, empty search_path, grants
select pg_temp.res('33 read-only: a call writes nothing (no transaction id); stable + definer + empty search_path; authenticated only',
  :'ro_ok'::boolean
  and (select p.provolatile = 's' and p.prosecdef and coalesce(p.proconfig, '{}') @> array['search_path=""']
              and has_function_privilege('authenticated', p.oid, 'execute') and not has_function_privilege('anon', p.oid, 'execute')
              and not exists (select 1 from aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a where a.grantee = 0)
         from pg_proc p where p.oid = 'public.page_bootstrap()'::regprocedure));

-- 34 additive: re-applying 0389 twice changed no other function in public / auth
select pg_temp.res('34 re-applying 0389 twice changed no other function (definitions hashed before / after)', :'fn_before' = :'fn_after');

select pg_temp.su();
do $$ declare n int; f int; r record; begin
  select count(*), count(*) filter (where result <> 'PASS') into n, f from _r217;
  for r in select * from _r217 where result <> 'PASS' loop raise warning '% -> %', r.name, left(r.result, 1500); end loop;
  if f = 0 then raise warning 'R217-PAGE-BOOTSTRAP-0389: ALL PASS (%/%)', n, n;
  else raise warning 'R217-PAGE-BOOTSTRAP-0389: % FAILED of %', f, n; end if;
end $$;
rollback;
