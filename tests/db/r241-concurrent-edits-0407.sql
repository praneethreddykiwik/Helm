-- r241-concurrent-edits-0407.sql - R241 fix plan Phase 4 (20 Nov 2026): layout save conflict (0407) + event detail lock
-- counter (0408). Proves: structure (counter table closed to the app, definer + empty search_path, grants, old wrapper kept
-- with no app privilege), both migrations applied twice, a save on top of the latest version works, a save on a STALE base
-- writes nothing and answers the conflict plainly (no money, no layout), "save mine as a new version" appends and keeps every
-- older version byte-identical, old pages (no base version) keep working and are counted, rights (no Quotes / Layouts edit
-- refused, another studio refused without learning anything, anon refused), the 0397 plan lock still refuses, the same
-- numbering as before; quotes.meta_rev moves only on a real detail change (not a layout save, a same-value write, a stage
-- move or a hand-set value), a stale counter changes nothing, the trigger runs last. Local disposable PG only. Rolled back.
-- The two-session race (two saves at the same moment) is tests/db/r241-qv-race-0407.sh.
\set ON_ERROR_STOP 0
set client_min_messages = error;
begin;
\i supabase/migrations/0407_r241_layout_save_conflict.sql
\i supabase/migrations/0407_r241_layout_save_conflict.sql
\i supabase/migrations/0408_r241_quote_meta_rev.sql
\i supabase/migrations/0408_r241_quote_meta_rev.sql
set client_min_messages = warning;
create temp table _rc(name text, result text); grant all on _rc to anon, authenticated, service_role;
create temp table _rkv(k text primary key, v text); grant all on _rkv to anon, authenticated, service_role;
create or replace function pg_temp.su() returns void language plpgsql as $$
begin execute 'reset role'; perform auth.logout(); execute 'reset role'; end $$;
create or replace function pg_temp.login(p_email text) returns void language plpgsql as $$
declare u uuid; begin
  perform pg_temp.su(); select id into u from auth.users where email = p_email;
  perform set_config('request.jwt.claims', jsonb_build_object('sub', u, 'role', 'authenticated', 'email', p_email, 'aal', 'aal1')::text, false);
  perform set_config('role', 'authenticated', false);
end $$;
create or replace function pg_temp.anon() returns void language plpgsql as $$
begin perform pg_temp.su(); perform auth.login_anon(); end $$;
create or replace function pg_temp.res(p_name text, p_ok boolean, p_detail text default '') returns void language plpgsql as $$
begin insert into _rc values (p_name, case when coalesce(p_ok, false) then 'PASS' else 'FAIL: ' || coalesce(p_detail, '') end); end $$;
create or replace function pg_temp.try(p_sql text) returns text language plpgsql as $$
begin execute p_sql; return ''; exception when others then return sqlstate || ' ' || sqlerrm; end $$;
create or replace function pg_temp.j(p_sql text) returns jsonb language plpgsql as $$
declare v jsonb; begin execute p_sql into v; return v; exception when others then return jsonb_build_object('err', sqlstate || ' ' || sqlerrm); end $$;
create or replace function pg_temp.put(p_k text, p_v text) returns void language plpgsql as $$
begin insert into _rkv values (p_k, p_v) on conflict (k) do update set v = excluded.v; end $$;
create or replace function pg_temp.get(p_k text) returns text language sql as $$ select v from _rkv where k = p_k $$;
grant execute on function pg_temp.res(text, boolean, text), pg_temp.try(text), pg_temp.j(text), pg_temp.put(text, text), pg_temp.get(text)
  to anon, authenticated, service_role;

-- ---- fixture: studio A event with V1..V3 (V2 by a teammate), a supervisor without Quotes / Layouts edit ----------------
do $$
declare orgA uuid := 'a0000000-0000-4000-8000-000000000001'; qA uuid := 'a0000000-0000-4000-8000-00000000da01'; u_sup uuid; u_admin uuid;
begin
  u_sup := auth.seed_user('a_sup407@a.test');
  select id into u_admin from auth.users where email = 'a_admin@a.test';
  insert into public.profiles(id, email, full_name, role, org_id, must_change_password, created_at) values
    (u_sup, 'a_sup407@a.test', 'Sunil Supervisor', 'supervisor', orgA, false, now())
  on conflict (id) do update set role = excluded.role, org_id = excluded.org_id;
  insert into public.role_access(role, area, can_view, can_edit, org_id, updated_at) values
    ('supervisor', 'quotes', true, false, orgA, now()), ('supervisor', 'layouts', true, false, orgA, now())
  on conflict (role, area, org_id) do update set can_view = excluded.can_view, can_edit = excluded.can_edit;
  delete from public.quote_versions where quote_id = qA;
  insert into public.quote_versions(quote_id, version_no, label, data, object_count, org_id, created_by) values
    (qA, 1, null, '{"items": [{"id": "s1", "type": "stage", "price": 90000}]}'::jsonb, 1, orgA, u_admin),
    (qA, 2, 'teammate', '{"items": [{"id": "s1"}, {"id": "t1"}]}'::jsonb, 2, orgA, u_sup),
    (qA, 3, null, '{"items": [{"id": "s1"}, {"id": "t1"}, {"id": "t2"}]}'::jsonb, 3, orgA, u_admin);
  update public.quotes set current_version = 3, status = 'quote' where id = qA;
  -- a second studio-A event for the detail-counter checks
  insert into public.quotes(id, code, title, status, client, pricing, current_version, approval_status, org_id, created_at, updated_at)
    values ('a0000000-0000-4000-8000-0000000d0407', 'A-0407', 'Meta test', 'quote', '{"name": "Mina"}'::jsonb,
            '{"subtotal": 1000, "discount": 0, "gstPct": 18, "total": 1180}'::jsonb, 1, 'none', orgA, now(), now())
    on conflict (id) do nothing;
end $$;
select pg_temp.put('md5_before', (select string_agg(version_no || ':' || md5(data::text) || ':' || coalesce(label, ''), ',' order by version_no)
  from public.quote_versions where quote_id = 'a0000000-0000-4000-8000-00000000da01'));
select pg_temp.put('quotes_before', (select count(*)::text from public.quotes));
select pg_temp.put('others_before', (select coalesce(string_agg(id || ':' || meta_rev, ',' order by id), '') from public.quotes
  where id not in ('a0000000-0000-4000-8000-00000000da01', 'a0000000-0000-4000-8000-0000000d0407')));

-- ---- 1) structure ------------------------------------------------------------------------------------------------------------
select pg_temp.res('01 counter table r407_legacy_calls: RLS on, closed to anon / signed-in, service_role reads',
  (select c.relrowsecurity from pg_class c where c.oid = 'public.r407_legacy_calls'::regclass)
  and not has_table_privilege('authenticated', 'public.r407_legacy_calls', 'select')
  and not has_table_privilege('anon', 'public.r407_legacy_calls', 'select')
  and not has_table_privilege('authenticated', 'public.r407_legacy_calls', 'insert')
  and has_table_privilege('service_role', 'public.r407_legacy_calls', 'select'));
select pg_temp.res('02 add_quote_version_checked + add_quote_version: signed-in only, definer, empty search_path',
  (select bool_and(p.prosecdef and p.proconfig @> array['search_path=""']
         and has_function_privilege('authenticated', p.oid, 'execute') and not has_function_privilege('anon', p.oid, 'execute'))
     from pg_proc p where p.oid in (to_regprocedure('public.add_quote_version_checked(uuid,text,jsonb,integer,integer,boolean)'),
                                    to_regprocedure('public.add_quote_version(uuid,text,jsonb,integer)'))
  ) and (select count(*) from pg_proc p where p.oid in (to_regprocedure('public.add_quote_version_checked(uuid,text,jsonb,integer,integer,boolean)'),
                                    to_regprocedure('public.add_quote_version(uuid,text,jsonb,integer)'))) = 2);
select pg_temp.res('03 old wrapper kept ONCE as add_quote_version__pre0407 (no app privilege); helpers server only; one overload each',
  to_regprocedure('public.add_quote_version__pre0407(uuid,text,jsonb,integer)') is not null
  and not has_function_privilege('authenticated', 'public.add_quote_version__pre0407(uuid,text,jsonb,integer)', 'execute')
  and not has_function_privilege('authenticated', 'public._r407_qv_lock(uuid)', 'execute')
  and not has_function_privilege('authenticated', 'public._r407_note_legacy(text,uuid)', 'execute')
  and not has_function_privilege('authenticated', 'public._r408_tg_meta_rev()', 'execute')
  and (select count(*) from pg_proc where pronamespace = 'public'::regnamespace and proname like 'add_quote_version%') = 4
  and (select prosrc from pg_proc where oid = to_regprocedure('public.add_quote_version__pre0407(uuid,text,jsonb,integer)')) like '%add_quote_version__pre0144%');
select pg_temp.res('04 meta_rev column (default 0, not null) + one trigger that runs LAST among BEFORE UPDATE triggers',
  (select column_default = '0' and is_nullable = 'NO' from information_schema.columns where table_schema = 'public' and table_name = 'quotes' and column_name = 'meta_rev')
  and (select count(*) from pg_trigger where tgrelid = 'public.quotes'::regclass and tgname = 'zzzzz_r408_meta_rev') = 1
  and (select max(tgname::text) from pg_trigger t where t.tgrelid = 'public.quotes'::regclass and not t.tgisinternal
         and (t.tgtype & 2) = 2 and (t.tgtype & 16) = 16) = 'zzzzz_r408_meta_rev');

-- ---- 2) layout saves -------------------------------------------------------------------------------------------------------
select pg_temp.login('a_admin@a.test');
select pg_temp.put('ok4', pg_temp.j($q$select public.add_quote_version_checked('a0000000-0000-4000-8000-00000000da01', null, '{"items": [{"id": "mine"}]}'::jsonb, 1, 3, false)$q$)::text);
select pg_temp.res('05 save on top of the latest (base V3) -> ok, V4, the quote now points at V4, not counted as legacy',
  (pg_temp.get('ok4')::jsonb ->> 'ok')::boolean and (pg_temp.get('ok4')::jsonb #>> '{version,version_no}') = '4'
  and (select current_version from public.quotes where id = 'a0000000-0000-4000-8000-00000000da01') = 4, pg_temp.get('ok4'));
select pg_temp.put('c1', pg_temp.j($q$select public.add_quote_version_checked('a0000000-0000-4000-8000-00000000da01', null, '{"items": [{"id": "stale"}]}'::jsonb, 1, 2, false)$q$)::text);
select pg_temp.res('06 save on a STALE base (V2, the latest is V4) -> nothing written, plain conflict answer',
  (pg_temp.get('c1')::jsonb ->> 'ok') = 'false' and (pg_temp.get('c1')::jsonb ->> 'conflict') = 'newer_version'
  and (pg_temp.get('c1')::jsonb ->> 'latest_version') = '4' and (pg_temp.get('c1')::jsonb ->> 'base_version') = '2'
  and (pg_temp.get('c1')::jsonb ->> 'latest_by_me')::boolean
  and pg_temp.get('c1')::jsonb ->> 'message' like 'Someone saved a newer version (V4)%Nothing was saved and nothing was overwritten.'
  and (select count(*) from public.quote_versions where quote_id = 'a0000000-0000-4000-8000-00000000da01') = 4
  and (select current_version from public.quotes where id = 'a0000000-0000-4000-8000-00000000da01') = 4, pg_temp.get('c1'));
select pg_temp.res('07 the conflict answer carries no money and no layout (only the version facts + a message)',
  (select array_agg(k order by k) from jsonb_object_keys(pg_temp.get('c1')::jsonb) k)
    = array['base_version', 'conflict', 'latest_at', 'latest_by', 'latest_by_me', 'latest_version', 'message', 'ok']
  and (select array_agg(k order by k) from jsonb_object_keys(pg_temp.get('ok4')::jsonb -> 'version') k)
    = array['created_at', 'created_by', 'id', 'label', 'object_count', 'quote_id', 'version_no']);
select pg_temp.put('n5', pg_temp.j($q$select public.add_quote_version_checked('a0000000-0000-4000-8000-00000000da01', 'Saved over V4 (both kept)', '{"items": [{"id": "stale"}]}'::jsonb, 1, 2, true)$q$)::text);
select pg_temp.res('08 "Save mine as a new version" (save_as_new) -> V5 appended, V1..V4 byte-identical (nothing overwritten)',
  (pg_temp.get('n5')::jsonb ->> 'ok')::boolean and (pg_temp.get('n5')::jsonb ->> 'saved_as_new')::boolean
  and (pg_temp.get('n5')::jsonb #>> '{version,version_no}') = '5'
  and (select string_agg(version_no || ':' || md5(data::text) || ':' || coalesce(label, ''), ',' order by version_no)
         from public.quote_versions where quote_id = 'a0000000-0000-4000-8000-00000000da01' and version_no <= 3) = pg_temp.get('md5_before')
  and (select data from public.quote_versions where quote_id = 'a0000000-0000-4000-8000-00000000da01' and version_no = 4) = '{"items": [{"id": "mine"}]}'::jsonb, pg_temp.get('n5'));
select pg_temp.put('l6', pg_temp.try($q$select public.add_quote_version('a0000000-0000-4000-8000-00000000da01', null, '{"items": []}'::jsonb, 0)$q$));
select pg_temp.put('l7', pg_temp.j($q$select public.add_quote_version_checked('a0000000-0000-4000-8000-00000000da01', null, '{"items": []}'::jsonb, 0, null, false)$q$)::text);
select pg_temp.su();
select pg_temp.res('09 old pages (no base version) keep working: add_quote_version -> V6, checked with no base -> V7, each counted once (saves WITH a base never)',
  pg_temp.get('l6') = '' and (pg_temp.get('l7')::jsonb ->> 'ok')::boolean and (pg_temp.get('l7')::jsonb #>> '{version,version_no}') = '7'
  and (select string_agg(version_no::text, ',' order by version_no) from public.quote_versions where quote_id = 'a0000000-0000-4000-8000-00000000da01') = '1,2,3,4,5,6,7'
  and (select coalesce(sum(calls), 0) from public.r407_legacy_calls where fn = 'add_quote_version') = 1
  and (select coalesce(sum(calls), 0) from public.r407_legacy_calls where fn = 'add_quote_version_checked') = 1
  and (select count(*) from public.r407_legacy_calls where day = (now() at time zone 'utc')::date and shard between 0 and 15) = 2,
  pg_temp.get('l6') || ' ' || pg_temp.get('l7'));
select pg_temp.res('10 the counter holds no person, studio or content (columns fn, day, shard, calls, last_at only)',
  (select array_agg(column_name::text order by ordinal_position) from information_schema.columns where table_schema = 'public' and table_name = 'r407_legacy_calls')
    = array['fn', 'day', 'shard', 'calls', 'last_at']);

-- ---- 3) rights ---------------------------------------------------------------------------------------------------------------
select pg_temp.login('a_sup407@a.test');
select pg_temp.res('11 no Quotes / Layouts edit -> refused (42501) by both calls, nothing written',
  pg_temp.try($q$select public.add_quote_version_checked('a0000000-0000-4000-8000-00000000da01', null, '{"items": []}'::jsonb, 0, 7, false)$q$) like '42501%'
  and pg_temp.try($q$select public.add_quote_version('a0000000-0000-4000-8000-00000000da01', null, '{"items": []}'::jsonb, 0)$q$) like '42501%');
select pg_temp.login('b_admin@b.test');
select pg_temp.put('b1', pg_temp.try($q$select public.add_quote_version_checked('a0000000-0000-4000-8000-00000000da01', null, '{"items": []}'::jsonb, 0, 1, false)$q$));
select pg_temp.res('12 another studio -> refused before anything is read (no conflict answer, no version facts)',
  pg_temp.get('b1') <> '' and pg_temp.get('b1') not like '%V7%' and pg_temp.get('b1') not like '%newer%', pg_temp.get('b1'));
select pg_temp.anon();
select pg_temp.res('13 anon -> refused',
  pg_temp.try($q$select public.add_quote_version_checked('a0000000-0000-4000-8000-00000000da01', null, '{"items": []}'::jsonb, 0, 7, false)$q$) like '42501%');
select pg_temp.su();
select pg_temp.res('14 after the refusals: still exactly V1..V7',
  (select count(*) from public.quote_versions where quote_id = 'a0000000-0000-4000-8000-00000000da01') = 7);

-- ---- 4) the 0397 plan lock still refuses ------------------------------------------------------------------------------------
update public.quotes set status = 'confirmed', confirmed_at = now(), event_date = current_date + 10 where id = 'a0000000-0000-4000-8000-00000000da01';
select set_config('helm.r397_plan_lock', 'on', false);
-- 0442 (R257) removed the event-day lock: this check runs with its one-line switch on (rolled back with the suite)
create or replace function public._r442_lock_on() returns boolean language sql stable set search_path = '' as 'select true';
-- 0441 (R256) took the floor plan out of the lock; its one-line undo puts it back, so this check runs with it (rolled back with the suite)
create or replace function public._r441_floor_in_lock() returns boolean language sql stable set search_path = '' as 'select true';
select pg_temp.login('a_admin@a.test');
select pg_temp.put('lk', pg_temp.try($q$select public.event_plan_lock_set('a0000000-0000-4000-8000-00000000da01', true, 'Final plan signed off')$q$));
select pg_temp.res('15 a locked plan: the checked save (base = latest) and "save mine as new" are refused (plan_locked)',
  pg_temp.get('lk') = ''
  and pg_temp.try($q$select public.add_quote_version_checked('a0000000-0000-4000-8000-00000000da01', null, '{"items": []}'::jsonb, 0, 7, false)$q$) like '%plan_locked%'
  and pg_temp.try($q$select public.add_quote_version_checked('a0000000-0000-4000-8000-00000000da01', null, '{"items": []}'::jsonb, 0, 3, true)$q$) like '%plan_locked%',
  pg_temp.get('lk'));
select pg_temp.su();
select set_config('helm.r397_plan_lock', 'off', false);

-- ---- 5) 0408 meta_rev --------------------------------------------------------------------------------------------------------
select pg_temp.put('r0', (select meta_rev::text from public.quotes where id = 'a0000000-0000-4000-8000-0000000d0407'));
select pg_temp.put('u0', (select updated_at::text from public.quotes where id = 'a0000000-0000-4000-8000-0000000d0407'));
select pg_temp.login('a_admin@a.test');
select pg_temp.put('t1', pg_temp.try($q$update public.quotes set title = 'R241 renamed' where id = 'a0000000-0000-4000-8000-0000000d0407'$q$));
select pg_temp.put('r1', (select meta_rev::text from public.quotes where id = 'a0000000-0000-4000-8000-0000000d0407'));
select pg_temp.put('t2', pg_temp.try($q$update public.quotes set title = 'R241 renamed' where id = 'a0000000-0000-4000-8000-0000000d0407'$q$));
select pg_temp.put('r2', (select meta_rev::text from public.quotes where id = 'a0000000-0000-4000-8000-0000000d0407'));
select pg_temp.put('t3', pg_temp.try($q$select public.add_quote_version_checked('a0000000-0000-4000-8000-0000000d0407', null, '{"items": []}'::jsonb, 0, 99, false)$q$));
select pg_temp.put('r3', (select meta_rev::text || '|' || updated_at::text from public.quotes where id = 'a0000000-0000-4000-8000-0000000d0407'));
select pg_temp.res('16 meta_rev: a real rename +1; the same name again and a layout save leave it (the version was written)',
  pg_temp.get('t1') = '' and pg_temp.get('t2') = '' and pg_temp.get('t3') = ''
  and pg_temp.get('r1')::bigint = pg_temp.get('r0')::bigint + 1 and pg_temp.get('r2') = pg_temp.get('r1')
  and split_part(pg_temp.get('r3'), '|', 1) = pg_temp.get('r1')
  and exists (select 1 from public.quote_versions where quote_id = 'a0000000-0000-4000-8000-0000000d0407'),
  pg_temp.get('t1') || pg_temp.get('t2') || pg_temp.get('t3') || ' ' || pg_temp.get('r0') || '/' || pg_temp.get('r1') || '/' || pg_temp.get('r2') || '/' || pg_temp.get('r3'));
select pg_temp.put('t4', pg_temp.try($q$update public.quotes set client = client || '{"phone": "9990001111"}'::jsonb, event_date = current_date + 30 where id = 'a0000000-0000-4000-8000-0000000d0407'$q$));
select pg_temp.res('17 a client + date change in one save: +1 (one save = one step)',
  pg_temp.get('t4') = '' and (select meta_rev from public.quotes where id = 'a0000000-0000-4000-8000-0000000d0407') = pg_temp.get('r1')::bigint + 1, pg_temp.get('t4'));
select pg_temp.res('18 the app cannot set meta_rev by hand (no column privilege)',
  pg_temp.try($q$update public.quotes set meta_rev = 0 where id = 'a0000000-0000-4000-8000-0000000d0407'$q$) like '42501%');
-- the store's lock: update ... where meta_rev = <what I read>
with u as (update public.quotes set title = 'stale write' where id = 'a0000000-0000-4000-8000-0000000d0407' and meta_rev = pg_temp.get('r1')::bigint returning 1)
select pg_temp.put('s1', (select count(*)::text from u));
with u as (update public.quotes set title = 'fresh write' where id = 'a0000000-0000-4000-8000-0000000d0407' and meta_rev = pg_temp.get('r1')::bigint + 1 returning meta_rev)
select pg_temp.put('s2', coalesce((select meta_rev::text from u), 'none'));
select pg_temp.res('19 a signed-in save with a STALE counter changes 0 rows (title kept); with the current one it saves and moves on',
  pg_temp.get('s1') = '0' and pg_temp.get('s2') = (pg_temp.get('r1')::bigint + 2)::text
  and (select title from public.quotes where id = 'a0000000-0000-4000-8000-0000000d0407') = 'fresh write', pg_temp.get('s1') || '/' || pg_temp.get('s2'));
select pg_temp.su();
update public.quotes set meta_rev = 999, lifecycle_stage = 'planning' where id = 'a0000000-0000-4000-8000-0000000d0407';
select pg_temp.res('20 even the database owner cannot set it, and a stage move alone does not move it',
  (select meta_rev from public.quotes where id = 'a0000000-0000-4000-8000-0000000d0407') = pg_temp.get('r1')::bigint + 2);
select pg_temp.res('21 nothing else changed: same number of events, every other event keeps its meta_rev',
  (select count(*)::text from public.quotes) = pg_temp.get('quotes_before')
  and (select coalesce(string_agg(id || ':' || meta_rev, ',' order by id), '') from public.quotes
        where id not in ('a0000000-0000-4000-8000-00000000da01', 'a0000000-0000-4000-8000-0000000d0407')) = pg_temp.get('others_before'));

select pg_temp.su();
select name, result from _rc order by name;
select case when (select count(*) from _rc where result <> 'PASS') = 0
            then 'R241-CONCURRENT-EDITS-0407: ALL PASS (' || (select count(*) from _rc) || '/' || (select count(*) from _rc) || ')'
            else 'R241-CONCURRENT-EDITS-0407: FAILURES' end as summary;
rollback;
