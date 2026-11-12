-- r161-open-quotes-order-0356.sql - behavioral proof for 0356 (Continue quotes list, newest activity first).
-- my_open_quotes orders BOTH lists (mine, studio) by the last activity of the quote: the newest of its last save, anyone last
-- flow step and my last flow step; ties by created time (newest first). A quote a teammate just worked on in the flow moves to
-- the top of MY list too; a brand-new quote opened in the flow is first; rows carry created_at; who is listed is unchanged
-- (approved still out, Hide still hides); the 0350 body is kept with no app privilege; my_unfinished_quotes is untouched.
-- Local disposable PG only. Rolled back.
\set ON_ERROR_STOP 0
set client_min_messages = warning;
begin;
create temp table _oo(name text, result text); grant all on _oo to anon, authenticated;
\i supabase/migrations/0356_r161_open_quotes_order.sql
-- a re-run is safe
\i supabase/migrations/0356_r161_open_quotes_order.sql

do $$ declare a_admin uuid; a_staff uuid;
  org uuid := 'a0000000-0000-4000-8000-000000000001';
  qOld uuid := gen_random_uuid(); qMid uuid := gen_random_uuid(); qNew uuid := gen_random_uuid();
  qTieA uuid := gen_random_uuid(); qTieB uuid := gen_random_uuid(); qAppr uuid := gen_random_uuid();
  t0 timestamptz := now() - interval '3 days';
  j jsonb; ids text[]; n int; src text; begin
  execute 'reset role';
  select id into a_admin from auth.users where email='a_admin@a.test';
  select id into a_staff from auth.users where email='a_staff@a.test';
  -- explicit times (an INSERT keeps them; the updated_at trigger only runs on UPDATE)
  insert into public.quotes(id, code, title, status, client, pricing, current_version, approval_status, org_id, event_type, created_at, updated_at) values
    (qOld, 'OO-OLD', 'Old one', 'quote', '{"name":"Old"}', '{"subtotal":0,"discount":0,"gstPct":18,"total":0}', 1, 'none', org, 'Wedding', t0, t0),
    (qMid, 'OO-MID', 'Middle', 'quote', '{"name":"Mid"}', '{"subtotal":0,"discount":0,"gstPct":18,"total":0}', 1, 'none', org, 'Wedding', t0 + interval '1 day', t0 + interval '1 day'),
    (qNew, 'OO-NEW', 'OO-NEW', 'quote', '{}', '{"subtotal":0,"discount":0,"gstPct":18,"total":0}', 1, 'none', org, null, t0 + interval '2 days', t0 + interval '2 days'),
    (qTieA, 'OO-TIE-A', 'Tie older', 'quote', '{"name":"TieA"}', '{"subtotal":0,"discount":0,"gstPct":18,"total":0}', 1, 'none', org, 'Birthday', t0 - interval '2 days', t0 - interval '1 day'),
    (qTieB, 'OO-TIE-B', 'Tie newer', 'quote', '{"name":"TieB"}', '{"subtotal":0,"discount":0,"gstPct":18,"total":0}', 1, 'none', org, 'Birthday', t0 - interval '1 day' - interval '1 hour', t0 - interval '1 day'),
    (qAppr, 'OO-APPR', 'Approved', 'quote', '{"name":"Appr"}', '{"subtotal":0,"discount":0,"gstPct":18,"total":0}', 1, 'approved', org, 'Wedding', t0, t0);
  insert into public.quote_versions(quote_id, version_no, data, object_count, created_by, org_id)
    select x, 1, '{"items":[]}'::jsonb, 0, a_admin, org from unnest(array[qOld, qMid, qNew, qTieA, qTieB, qAppr]) x;
  -- my flow steps: Old and Mid worked on by me 2 days ago, the new empty quote just opened in the flow (step Client)
  insert into public.quote_flow_progress(quote_id, user_id, org_id, last_step, last_step_at) values
    (qOld, a_admin, org, 'proposal', t0 + interval '1 hour'),
    (qMid, a_admin, org, 'venue', t0 + interval '1 day' + interval '1 hour'),
    (qNew, a_admin, org, 'client', now()),
    (qAppr, a_admin, org, 'quote', now());

  insert into _oo values ('00 security definer, empty search_path, signed-in only, kept 0350 body for nobody', case when exists (select 1 from pg_proc p
    where p.oid = 'public.my_open_quotes(text,integer,integer,uuid,integer)'::regprocedure and p.prosecdef and 'search_path=""' = any(p.proconfig)
      and position('open-quotes-0356' in p.prosrc) > 0)
    and has_function_privilege('authenticated', 'public.my_open_quotes(text,integer,integer,uuid,integer)', 'execute')
    and not has_function_privilege('anon', 'public.my_open_quotes(text,integer,integer,uuid,integer)', 'execute')
    and position('open-quotes-0350' in (select p.prosrc from pg_proc p where p.oid = 'public.my_open_quotes__pre0356(text,integer,integer,uuid,integer)'::regprocedure)) > 0
    and not has_function_privilege('authenticated', 'public.my_open_quotes__pre0356(text,integer,integer,uuid,integer)', 'execute')
    and not has_function_privilege('anon', 'public.my_open_quotes__pre0356(text,integer,integer,uuid,integer)', 'execute')
    and not has_function_privilege('service_role', 'public.my_open_quotes__pre0356(text,integer,integer,uuid,integer)', 'execute') then 'PASS' else 'FAIL' end);
  insert into _oo values ('01 my_unfinished_quotes (0206) is untouched', case when position('flow-progress-0206' in (select p.prosrc from pg_proc p
    where p.oid = 'public.my_unfinished_quotes(text,integer,integer,uuid,integer)'::regprocedure)) > 0 then 'PASS' else 'FAIL' end);
  j := public.my_open_quotes('mine', 5, 0, null, null);
  insert into _oo values ('02 signed out: quietly nothing', case when (j ->> 'total')::int = 0 then 'PASS' else 'FAIL' end);

  -- ---- 1) newest first: the quote just opened in the flow is on top ----
  perform auth.login_as(a_admin);
  j := public.my_open_quotes('mine', 100, 0, null, null);
  select array_agg(x ->> 'code' order by o) into ids from jsonb_array_elements(j -> 'rows') with ordinality t(x, o) where x ->> 'code' like 'OO-%';
  insert into _oo values ('10 mine: the new quote first, then Middle, then Old', case when ids[1:3] = array['OO-NEW', 'OO-MID', 'OO-OLD'] then 'PASS' else 'FAIL: ' || coalesce(ids::text, 'null') end);
  insert into _oo values ('11 same last activity: the quote created later comes first', case when array_position(ids, 'OO-TIE-B') < array_position(ids, 'OO-TIE-A') then 'PASS' else 'FAIL: ' || coalesce(ids::text, 'null') end);
  insert into _oo values ('12 rows carry created_at', case when exists (select 1 from jsonb_array_elements(j -> 'rows') x where x ->> 'code' = 'OO-TIE-B' and (x ->> 'created_at')::timestamptz = t0 - interval '1 day' - interval '1 hour') then 'PASS' else 'FAIL' end);
  insert into _oo values ('13 who is listed is unchanged: an approved quote stays out', case when not ('OO-APPR' = any(ids)) then 'PASS' else 'FAIL: ' || ids::text end);
  perform auth.logout(); execute 'reset role';

  -- ---- 2) a teammate works on the OLD quote in the flow: it moves to the top of MY list and of the studio list ----
  insert into public.quote_flow_progress(quote_id, user_id, org_id, last_step, last_step_at) values (qOld, a_staff, org, 'menu', now() + interval '1 minute');
  perform auth.login_as(a_admin);
  j := public.my_open_quotes('mine', 100, 0, null, null);
  select array_agg(x ->> 'code' order by o) into ids from jsonb_array_elements(j -> 'rows') with ordinality t(x, o) where x ->> 'code' like 'OO-%';
  insert into _oo values ('20 mine: the quote a teammate just worked on comes first', case when ids[1:3] = array['OO-OLD', 'OO-NEW', 'OO-MID'] then 'PASS' else 'FAIL: ' || coalesce(ids::text, 'null') end);
  insert into _oo values ('21 mine: activity is the teammate step time, my own step stays mine', case when exists (select 1 from jsonb_array_elements(j -> 'rows') x
    where x ->> 'code' = 'OO-OLD' and (x ->> 'activity')::timestamptz = now() + interval '1 minute' and x ->> 'my_step' = 'proposal' and x ->> 'last_step' = 'menu') then 'PASS' else 'FAIL' end);
  j := public.my_open_quotes('studio', 100, 0, null, null);
  select array_agg(x ->> 'code' order by o) into ids from jsonb_array_elements(j -> 'rows') with ordinality t(x, o) where x ->> 'code' like 'OO-%';
  insert into _oo values ('22 studio: the same order', case when ids[1:3] = array['OO-OLD', 'OO-NEW', 'OO-MID'] then 'PASS' else 'FAIL: ' || coalesce(ids::text, 'null') end);
  j := public.my_open_quotes('mine', 2, 0, null, null);
  insert into _oo values ('23 paging keeps the order (limit 2 = the 2 newest)', case when jsonb_array_length(j -> 'rows') = 2 and j -> 'rows' -> 0 ->> 'code' = 'OO-OLD' then 'PASS' else 'FAIL: ' || left(j::text, 200) end);
  perform auth.logout(); execute 'reset role';

  -- ---- 3) a save of the quote (updated_at) counts as activity too ----
  update public.quotes set client = '{"name":"Mid again"}' where id = qMid;   -- trigger: updated_at = transaction time (now)
  update public.quote_flow_progress set last_step_at = now() - interval '1 hour' where quote_id in (qOld, qNew);
  perform auth.login_as(a_admin);
  j := public.my_open_quotes('mine', 100, 0, null, null);
  select array_agg(x ->> 'code' order by o) into ids from jsonb_array_elements(j -> 'rows') with ordinality t(x, o) where x ->> 'code' like 'OO-%';
  insert into _oo values ('30 the quote saved last comes first', case when ids[1] = 'OO-MID' then 'PASS' else 'FAIL: ' || coalesce(ids::text, 'null') end);
  -- Hide still hides (0206 dismiss) and never changes the quote
  perform public.mark_flow_resume_dismissed(qMid);
  j := public.my_open_quotes('mine', 100, 0, null, null);
  insert into _oo values ('31 Hide still hides it from MY list only', case when not exists (select 1 from jsonb_array_elements(j -> 'rows') x where x ->> 'code' = 'OO-MID') then 'PASS' else 'FAIL' end);
  perform auth.logout(); execute 'reset role';
  select count(*) into n from public.quotes where id in (qOld, qMid, qNew, qTieA, qTieB, qAppr) and deleted_at is null and archived_at is null;
  insert into _oo values ('40 every test quote is still there (nothing deleted)', case when n = 6 then 'PASS' else 'FAIL: ' || n end);
exception when others then execute 'reset role'; insert into _oo values ('xx setup', 'FAIL: ' || sqlstate || ' ' || sqlerrm); end $$;

select name, result from _oo order by name;
select case when count(*) filter (where result <> 'PASS') = 0 then 'R161-OPEN-QUOTES-ORDER-0356: ALL PASS (' || count(*) || '/' || count(*) || ')'
            else 'R161-OPEN-QUOTES-ORDER-0356: ' || count(*) filter (where result <> 'PASS') || ' FAILED of ' || count(*) end as summary from _oo;
rollback;
