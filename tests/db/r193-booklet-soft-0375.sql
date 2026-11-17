-- r193-booklet-soft-0375.sql - R193 (0375): the booklet READ calls answer "nothing" for an event that is not the
-- caller's (another studio / deleted / unknown / null id) instead of P0002 (PostgREST HTTP 500), while every
-- authorization refusal is unchanged (signed out, client account, no quotes VIEW / EDIT -> 42501) and the WRITE calls
-- still raise for an unknown event. A real event of the caller's studio answers exactly as before.
-- Re-applies 0375 twice. Local disposable PG only. Fixture studios A + B. Rolled back.
\set ON_ERROR_STOP 0
set client_min_messages = error;
\ir ../../supabase/migrations/0375_r193_booklet_soft_reads.sql
\ir ../../supabase/migrations/0375_r193_booklet_soft_reads.sql
set client_min_messages = warning;
begin;
create temp table _r193(name text, result text); grant all on _r193 to anon, authenticated, service_role;
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
begin perform pg_temp.su(); insert into _r193 values (p_name, case when coalesce(p_ok, false) then 'PASS' else 'FAIL: '||coalesce(p_detail,'') end); end $$;
create or replace function pg_temp.try(p_sql text) returns text language plpgsql as $$
begin execute p_sql; return ''; exception when others then return sqlstate || ' ' || sqlerrm; end $$;
grant execute on function pg_temp.try(text) to anon, authenticated, service_role;
-- the four reads of one event as one text: current | image_info | staff_image | layout_auto_on (errors as "ERR <sqlstate>")
create or replace function pg_temp.reads(p_q uuid) returns text language plpgsql as $$
declare a text; b text; c text; d text; begin
  begin a := coalesce(public.booklet_current(p_q)::text, 'null'); exception when others then a := 'ERR ' || sqlstate; end;
  begin b := coalesce(public.booklet_image_info(p_q)::text, 'null'); exception when others then b := 'ERR ' || sqlstate; end;
  begin c := coalesce(public.booklet_staff_image(p_q, '2d', 'labels')::text, 'null'); exception when others then c := 'ERR ' || sqlstate; end;
  begin d := coalesce(public.booklet_layout_auto_on(p_q)::text, 'null'); exception when others then d := 'ERR ' || sqlstate; end;
  return a || ' | ' || b || ' | ' || c || ' | ' || d;
end $$;
grant execute on function pg_temp.reads(uuid) to anon, authenticated, service_role;

do $$ declare qa uuid := 'a0000000-0000-4000-8000-00000000da01'; qb uuid := 'b0000000-0000-4000-8000-00000000da01';
  r jsonb; e text; tok text; n int; nothing text := 'null | {} | null | {"ok": false, "changed": false}';
begin
  perform pg_temp.su(); set local session_replication_role = replica;
  update public.quotes set deleted_at = null where id in (qa, qb);
  set local session_replication_role = origin;
  perform pg_temp.su();
  update public.role_access set can_view = true, can_edit = true where role = 'sales' and area = 'quotes';

  -- 01 own event, no link yet: the same "nothing" as before (no error)
  perform pg_temp.login('a_admin@a.test');
  e := pg_temp.reads(qa);
  perform pg_temp.res('01 own event without a link: null / {} / null / ok false', e = nothing, e);

  -- 02 own event with a live link: answers as before
  perform pg_temp.login('a_admin@a.test');
  r := public.booklet_share(qa); tok := r ->> 'token';
  perform pg_temp.login('a_staff@a.test');
  r := public.booklet_current(qa);
  perform pg_temp.res('02 own event: current returns the live link (unchanged)', r ->> 'token' = tok and r ? 'sections' and r ? 'image_variants', coalesce(r::text, 'null'));
  perform pg_temp.login('a_staff@a.test');
  r := public.booklet_layout_auto_on(qa);
  perform pg_temp.res('03 own event: layout_auto_on answers ok true', (r ->> 'ok')::boolean, coalesce(r::text, 'null'));

  -- 04 another studio's event: nothing (no token, no pictures, link untouched) - and no error (was P0002 = HTTP 500)
  perform pg_temp.login('b_admin@b.test');
  e := pg_temp.reads(qa);
  perform pg_temp.res('04 other studio: nothing, no error', e = nothing and e not like '%' || tok || '%', e);
  perform pg_temp.su();
  select count(*) into n from public.client_booklets where quote_id = qa and revoked_at is null and sections_set_at is null;
  perform pg_temp.res('05 other studio call changed nothing on the live link', n = 1, n::text);

  -- 06 unknown id / null id: nothing
  perform pg_temp.login('a_admin@a.test');
  e := pg_temp.reads(gen_random_uuid());
  perform pg_temp.res('06 unknown event: nothing', e = nothing, e);
  perform pg_temp.login('a_admin@a.test');
  e := pg_temp.reads(null);
  perform pg_temp.res('07 null id: nothing', e = nothing, e);

  -- 08 own event that was deleted: nothing (the link is not shown any more)
  perform pg_temp.su(); set local session_replication_role = replica;
  update public.quotes set deleted_at = now() where id = qa;
  set local session_replication_role = origin;
  perform pg_temp.login('a_admin@a.test');
  e := pg_temp.reads(qa);
  perform pg_temp.res('08 deleted event: nothing', e = nothing, e);
  perform pg_temp.su(); set local session_replication_role = replica;
  update public.quotes set deleted_at = null where id = qa;
  set local session_replication_role = origin;

  -- 09 authorization unchanged: signed out -> refused before the body runs (no execute right)
  perform pg_temp.anon();
  e := pg_temp.reads(qa);
  perform pg_temp.res('09 signed out: all four refused (42501)', e = 'ERR 42501 | ERR 42501 | ERR 42501 | ERR 42501', e);

  -- 10 a role without quotes VIEW is still refused (42501), on its own event and on an unknown one
  perform pg_temp.su();
  update public.role_access set can_view = false, can_edit = false where role = 'sales' and area = 'quotes';
  perform pg_temp.login('a_staff@a.test');
  e := pg_temp.reads(qa) || ' || ' || pg_temp.reads(gen_random_uuid());
  perform pg_temp.res('10 no quotes view: refused (42501), never "nothing"', e = 'ERR 42501 | ERR 42501 | ERR 42501 | ERR 42501 || ERR 42501 | ERR 42501 | ERR 42501 | ERR 42501', e);
  -- 11 quotes VIEW only: reads answer, layout_auto_on (an edit) still refused
  perform pg_temp.su();
  update public.role_access set can_view = true, can_edit = false where role = 'sales' and area = 'quotes';
  perform pg_temp.login('a_staff@a.test');
  e := pg_temp.reads(qa);
  perform pg_temp.res('11 quotes view only: reads answer, layout_auto_on refused (42501)', e like '{%' and e like '% | ERR 42501', e);
  perform pg_temp.su();
  update public.role_access set can_view = true, can_edit = true where role = 'sales' and area = 'quotes';

  -- 12 writes keep the strict check: another studio's event still raises (no silent success)
  perform pg_temp.login('b_admin@b.test');
  e := pg_temp.try(format('select public.booklet_share(%L)', qa)) || pg_temp.try(format('select public.booklet_revoke(%L)', qa));
  perform pg_temp.res('12 writes on another studio''s event still refused', e like 'P0002%P0002%', e);
  perform pg_temp.su();
  select count(*) into n from public.client_booklets where quote_id = qa and revoked_at is null;
  perform pg_temp.res('13 the live link is still there', n = 1, n::text);
end $$;

-- 14 grants + definer + search_path + markers; the helper is server-only
select pg_temp.res('14 grants, definer, search_path, markers; helper server-only',
  has_function_privilege('authenticated', 'public.booklet_current(uuid)', 'execute')
  and has_function_privilege('authenticated', 'public.booklet_image_info(uuid)', 'execute')
  and has_function_privilege('authenticated', 'public.booklet_staff_image(uuid,text,text)', 'execute')
  and has_function_privilege('authenticated', 'public.booklet_layout_auto_on(uuid)', 'execute')
  and not has_function_privilege('anon', 'public.booklet_current(uuid)', 'execute')
  and not has_function_privilege('anon', 'public.booklet_image_info(uuid)', 'execute')
  and not has_function_privilege('anon', 'public.booklet_staff_image(uuid,text,text)', 'execute')
  and not has_function_privilege('anon', 'public.booklet_layout_auto_on(uuid)', 'execute')
  and not has_function_privilege('authenticated', 'public._booklet_staff_quote_soft(uuid,boolean)', 'execute')
  and not has_function_privilege('anon', 'public._booklet_staff_quote_soft(uuid,boolean)', 'execute')
  and (select bool_and(p.prosecdef and coalesce(p.proconfig, '{}') @> array['search_path=""'] and position('r193-0375' in p.prosrc) > 0)
         from pg_proc p where p.oid in ('public.booklet_current(uuid)'::regprocedure, 'public.booklet_image_info(uuid)'::regprocedure,
           'public.booklet_staff_image(uuid,text,text)'::regprocedure, 'public.booklet_layout_auto_on(uuid)'::regprocedure,
           'public._booklet_staff_quote_soft(uuid,boolean)'::regprocedure))
  and position('booklet-layout-0220' in pg_get_functiondef('public.booklet_current(uuid)'::regprocedure)) > 0
  and position('booklet-images-0083' in pg_get_functiondef('public.booklet_image_info(uuid)'::regprocedure)) > 0);

select pg_temp.su();
do $$ declare n int; f int; r record; begin
  select count(*), count(*) filter (where result <> 'PASS') into n, f from _r193;
  for r in select * from _r193 where result <> 'PASS' loop raise warning '% -> %', r.name, r.result; end loop;
  if f = 0 then raise warning 'R193-BOOKLET-SOFT-0375: ALL PASS (%/%)', n, n;
  else raise warning 'R193-BOOKLET-SOFT-0375: % FAILED of %', f, n; end if;
end $$;
rollback;
