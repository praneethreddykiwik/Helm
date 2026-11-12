-- r154-slug-skeleton-0346.sql - R154: studio settings save refused with 42501 permission denied for function
-- _r23_slug_skeleton (prod log 12 Nov). Proves: (1) with the 0257 grants (helper revoked from signed-in users) a studio
-- admin saving Settings is refused as soon as the organizations row cannot be updated in place (the look-alike index
-- needs a new entry) - the prod error, reproduced; (2) after 0346 the same saves go through and are kept; another
-- studio still changes nothing, anon still cannot run the helper or change a studio, the name / link lock still holds;
-- (3) grants: authenticated + service role yes, anon + PUBLIC no; the helper body, volatility and invoker rights are
-- untouched; no index on a public table uses a function signed-in users cannot run; (4) 0346 re-runs twice with
-- nothing changed. Local disposable PG only. Fake data only. Rolled back.
\set ON_ERROR_STOP 0
set client_min_messages = warning;
begin;
create temp table _rs(name text, result text); grant all on _rs to anon, authenticated, service_role;
create or replace function pg_temp.t(p_name text, p_ok boolean, p_detail text default '') returns void language plpgsql as $$
begin insert into _rs values (p_name, case when coalesce(p_ok, false) then 'PASS' else 'FAIL: ' || coalesce(p_detail, '') end); end $$;
create or replace function pg_temp.as_val(p_who text, p_sql text) returns text language plpgsql as $$
declare v text;
begin
  if p_who = 'anon' then perform auth.login_anon();
  elsif p_who = 'svc' then
    perform set_config('request.jwt.claims', '{"role":"service_role"}', true); execute 'set local role service_role';
  elsif p_who is not null then perform auth.login_as((select id from auth.users where email = p_who)); end if;
  execute p_sql into v;
  execute 'reset role'; perform auth.logout(); execute 'reset role';
  return 'ok:' || coalesce(v, '<null>');
exception when others then
  execute 'reset role'; perform auth.logout(); execute 'reset role';
  return sqlstate || ' ' || sqlerrm;
end $$;
grant execute on function pg_temp.as_val(text, text) to anon, authenticated, service_role;
-- N Settings saves in a row on studio A (each one = BPStore.org.save: PATCH organizations?id=eq.<studio>&select=id).
-- Inside one transaction no old row version can be pruned, so after a handful of saves the page is full and the next
-- save cannot stay on its page: Postgres must write a new entry in every index, the look-alike index included.
create or replace function pg_temp.saves(p_n int) returns text language plpgsql as $$
declare k int := 0; c int;
begin
  for i in 1..p_n loop
    update public.organizations set brand = coalesce(brand, '{}'::jsonb) || jsonb_build_object('r154_save', i, 'r154_pad', repeat('x', 300))
     where id = 'a0000000-0000-4000-8000-000000000001';
    get diagnostics c = row_count; k := k + c;
  end loop;
  return k::text;
end $$;
grant execute on function pg_temp.saves(int) to anon, authenticated, service_role;

create temp table _p0 as select p.prosrc, p.provolatile, p.prosecdef from pg_proc p where p.oid = 'public._r23_slug_skeleton(text)'::regprocedure;

-- ---- 1) before 0346: the 0257 grants reproduce the prod error -----------------------------------------------------
revoke all on function public._r23_slug_skeleton(text) from authenticated;
do $$ declare v text; begin
  v := pg_temp.as_val('a_admin@a.test', 'select pg_temp.saves(200)');
  perform pg_temp.t('01 pre-0346: admin Settings saves refused with 42501 permission denied for function _r23_slug_skeleton',
    v like '42501 %' and v like '%permission denied for function _r23_slug_skeleton%', v);
end $$;
do $$ begin
  perform pg_temp.t('02 pre-0346: the refused saves left the studio row as it was',
    (select not (brand ? 'r154_save') from public.organizations where id = 'a0000000-0000-4000-8000-000000000001'), 'brand changed');
end $$;

-- ---- 2) apply 0346 -------------------------------------------------------------------------------------------------
\ir ../../supabase/migrations/0346_r154_slug_skeleton_execute.sql

do $$ declare v text; begin
  v := pg_temp.as_val('a_admin@a.test', 'select pg_temp.saves(200)');
  perform pg_temp.t('03 after 0346: 200 admin Settings saves in a row all go through (one row each)', v = 'ok:200', v);
  perform pg_temp.t('04 after 0346: the last save is what the studio row holds',
    (select (brand ->> 'r154_save') = '200' from public.organizations where id = 'a0000000-0000-4000-8000-000000000001'), 'not kept');
  v := pg_temp.as_val('a_admin@a.test', $q$select public._r23_slug_skeleton('5tudio-A') || '|' || public._r23_slug_skeleton('rnoon-vvay')$q$);
  perform pg_temp.t('05 a signed-in user can run the helper and gets the 0257 look-alike fold', v = 'ok:studloa|moonway', v);
  v := pg_temp.as_val('b_admin@b.test', $q$with u as (update public.organizations set brand = brand || '{"r154_x":1}' where id = 'a0000000-0000-4000-8000-000000000001' returning id) select count(*)::text from u$q$);
  perform pg_temp.t('06 another studio admin still changes nothing on studio A', v = 'ok:0', v);
  v := pg_temp.as_val('anon', $q$select public._r23_slug_skeleton('x')$q$);
  perform pg_temp.t('07 anon still cannot run the helper', v like '42501 %', v);
  v := pg_temp.as_val('anon', $q$with u as (update public.organizations set brand = '{}' where id = 'a0000000-0000-4000-8000-000000000001' returning id) select count(*)::text from u$q$);
  perform pg_temp.t('08 anon still cannot change a studio', v = 'ok:0' or v like '42501 %', v);
  v := pg_temp.as_val('a_admin@a.test', $q$update public.organizations set public_slug = 'studio-a-new' where id = 'a0000000-0000-4000-8000-000000000001' returning id$q$);
  perform pg_temp.t('09 the 0257 studio link lock still refuses an admin link change', v like '42501 %' and v like '%studio link%', v);
  v := pg_temp.as_val('svc', $q$select public._r23_slug_skeleton('He1m')$q$);
  perform pg_temp.t('10 the service role still runs the helper', v = 'ok:helm', v);
end $$;

-- ---- 3) grants + helper untouched ----------------------------------------------------------------------------------
do $$ begin
  perform pg_temp.t('11 grants: authenticated + service_role yes, anon no',
    has_function_privilege('authenticated', 'public._r23_slug_skeleton(text)', 'execute')
    and has_function_privilege('service_role', 'public._r23_slug_skeleton(text)', 'execute')
    and not has_function_privilege('anon', 'public._r23_slug_skeleton(text)', 'execute'));
  perform pg_temp.t('12 no PUBLIC grant on the helper',
    not exists (select 1 from pg_proc p, aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
                 where p.oid = 'public._r23_slug_skeleton(text)'::regprocedure and a.grantee = 0));
  perform pg_temp.t('13 helper body, volatility and invoker rights unchanged',
    exists (select 1 from pg_proc p, _p0 where p.oid = 'public._r23_slug_skeleton(text)'::regprocedure
             and p.prosrc = _p0.prosrc and p.provolatile = 'i' and _p0.provolatile = 'i' and not p.prosecdef and not _p0.prosecdef));
  perform pg_temp.t('14 the other 0257 helpers keep no signed-in grant',
    not has_function_privilege('authenticated', 'public._r23_slug_protected(text)', 'execute')
    and not has_function_privilege('authenticated', 'public._r23_link_check(uuid,text)', 'execute')
    and not has_function_privilege('authenticated', 'public.tg_r23_org_identity_lock()', 'execute'));
  perform pg_temp.t('15 no index on a public table uses a function signed-in users cannot run',
    not exists (select 1 from pg_index i join pg_class c on c.oid = i.indrelid
                  join pg_depend d on d.classid = 'pg_class'::regclass and d.objid = i.indexrelid and d.refclassid = 'pg_proc'::regclass
                 where c.relnamespace = 'public'::regnamespace and not has_function_privilege('authenticated', d.refobjid, 'execute')));
end $$;

-- ---- 4) safe to run twice ------------------------------------------------------------------------------------------
create temp table _acl0 as select p.proacl::text a from pg_proc p where p.oid = 'public._r23_slug_skeleton(text)'::regprocedure;
\ir ../../supabase/migrations/0346_r154_slug_skeleton_execute.sql
\ir ../../supabase/migrations/0346_r154_slug_skeleton_execute.sql
do $$ begin
  perform pg_temp.t('16 re-running 0346 twice changes no grant',
    (select p.proacl::text from pg_proc p where p.oid = 'public._r23_slug_skeleton(text)'::regprocedure) = (select a from _acl0));
end $$;

do $$ declare n int; f int; r record; begin
  select count(*), count(*) filter (where result <> 'PASS') into n, f from _rs;
  for r in select * from _rs where result <> 'PASS' loop raise warning '% -> %', r.name, r.result; end loop;
  if f = 0 then raise warning 'R154-SLUG-SKELETON-0346: ALL PASS (%/%)', n, n;
  else raise warning 'R154-SLUG-SKELETON-0346: % FAILED of %', f, n; end if;
end $$;
rollback;
