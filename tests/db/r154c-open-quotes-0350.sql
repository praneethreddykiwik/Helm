-- r154c-open-quotes-0350.sql - behavioral proof for 0350 (Continue quote list: every open quote until Confirmed).
-- my_open_quotes lists EVERY quote I worked on that is still open (not only the newest), keeps a quote after its
-- quotation is saved / locked / sent, drops it once approved, paid, confirmed, cancelled, archived, deleted or
-- sample data; Hide (0206 dismiss) hides only and never changes the quote; another studio sees nothing; a
-- view-only role gets can_edit false; my_unfinished_quotes (0206) answers exactly as before. Local disposable PG only. Rolled back.
\set ON_ERROR_STOP 0
set client_min_messages = warning;
begin;
create temp table _oq(name text, result text); grant all on _oq to anon, authenticated;
\i supabase/migrations/0350_r154c_open_quotes.sql
-- a re-run is safe
\i supabase/migrations/0350_r154c_open_quotes.sql

do $$ declare a_admin uuid; a_staff uuid; b_admin uuid;
  org uuid := 'a0000000-0000-4000-8000-000000000001';
  q1 uuid := gen_random_uuid(); q2 uuid := gen_random_uuid(); qQ uuid := gen_random_uuid(); qL uuid := gen_random_uuid();
  qSent uuid := gen_random_uuid(); qAppr uuid := gen_random_uuid(); qPaid uuid := gen_random_uuid(); qCanc uuid := gen_random_uuid();
  qConf uuid := gen_random_uuid(); qArch uuid := gen_random_uuid(); qDel uuid := gen_random_uuid(); qDemo uuid := gen_random_uuid();
  j jsonb; j0 jsonb; e text; n int; ids text[]; ts timestamptz; begin
  execute 'reset role';
  select id into a_admin from auth.users where email='a_admin@a.test';
  select id into a_staff from auth.users where email='a_staff@a.test';
  select id into b_admin from auth.users where email='b_admin@b.test';
  insert into public.quotes(id, code, title, status, client, pricing, current_version, approval_status, org_id, event_type, event_date, created_at, updated_at) values
    (q1, 'OQ-1', 'Open one', 'quote', '{"name":"Asha"}', '{"subtotal":0,"discount":0,"gstPct":18,"total":0}', 1, 'none', org, 'Wedding', null, now(), now()),
    (q2, 'OQ-2', 'Open two', 'quote', '{"name":"Ravi"}', '{"subtotal":0,"discount":0,"gstPct":18,"total":0}', 1, 'none', org, 'Birthday', null, now(), now()),
    (qQ, 'OQ-Q', 'Quoted', 'quote', '{"name":"Quoted"}', '{"subtotal":5000,"discount":0,"gstPct":0,"total":5000}', 1, 'none', org, null, null, now(), now()),
    (qL, 'OQ-L', 'Locked', 'quote', '{"name":"Locked"}', '{"subtotal":5000,"discount":0,"gstPct":0,"total":5000}', 1, 'none', org, null, null, now(), now()),
    (qSent, 'OQ-SENT', 'Sent', 'quote', '{"name":"Sent"}', '{"subtotal":5000,"discount":0,"gstPct":0,"total":5000}', 1, 'none', org, null, null, now(), now()),
    (qAppr, 'OQ-APPR', 'Approved', 'quote', '{"name":"Appr"}', '{"subtotal":5000,"discount":0,"gstPct":0,"total":5000}', 1, 'none', org, null, null, now(), now()),
    (qPaid, 'OQ-PAID', 'Paid', 'quote', '{"name":"Paid"}', '{"subtotal":5000,"discount":0,"gstPct":0,"total":5000}', 1, 'none', org, null, null, now(), now()),
    (qCanc, 'OQ-CANC', 'Cancelled', 'quote', '{"name":"Canc"}', '{"subtotal":0,"discount":0,"gstPct":18,"total":0}', 1, 'none', org, null, null, now(), now()),
    (qConf, 'OQ-CONF', 'Stage confirmed', 'quote', '{"name":"Conf"}', '{"subtotal":0,"discount":0,"gstPct":18,"total":0}', 1, 'none', org, null, null, now(), now()),
    (qArch, 'OQ-ARCH', 'Archived', 'quote', '{"name":"Arch"}', '{"subtotal":0,"discount":0,"gstPct":18,"total":0}', 1, 'none', org, null, null, now(), now()),
    (qDel, 'OQ-DEL', 'Deleted', 'quote', '{"name":"Del"}', '{"subtotal":0,"discount":0,"gstPct":18,"total":0}', 1, 'none', org, null, null, now(), now()),
    (qDemo, 'OQ-DEMO', 'Demo', 'quote', '{"name":"Demo"}', '{"subtotal":0,"discount":0,"gstPct":18,"total":0}', 1, 'none', org, null, null, now(), now());
  -- states set the way a superuser fixture can (the app reaches them only through the server actions)
  update public.quotes set status = 'confirmed' where id = qL;
  update public.quotes set approval_status = 'sent', approval_token = gen_random_uuid() where id = qSent;
  update public.quotes set approval_status = 'approved' where id = qAppr;
  update public.quotes set approval_status = 'paid' where id = qPaid;
  update public.quotes set status = 'cancelled' where id = qCanc;
  update public.quotes set lifecycle_stage = 'confirmed' where id = qConf;
  update public.quotes set archived_at = now() where id = qArch;
  update public.quotes set deleted_at = now(), deleted_reason = 'manual' where id = qDel;
  update public.quotes set is_demo = true where id = qDemo;
  insert into public.quote_versions(quote_id, version_no, data, object_count, created_by, org_id)
    select x, 1, '{"items":[]}'::jsonb, 0, a_admin, org from unnest(array[q1, q2, qQ, qL, qSent, qAppr, qPaid, qCanc, qConf, qArch, qDel, qDemo]) x;
  insert into public.quotation_versions(quote_id, label, pricing, total, org_id, created_by) values (qQ, 'Q1', '{"total":5000}', 5000, org, a_admin);

  insert into _oq values ('00 security definer, empty search_path, anon cannot call', case when exists (select 1 from pg_proc p
    where p.oid = 'public.my_open_quotes(text,integer,integer,uuid,integer)'::regprocedure and p.prosecdef and 'search_path=""' = any(p.proconfig))
    and not has_function_privilege('anon', 'public.my_open_quotes(text,integer,integer,uuid,integer)', 'execute')
    and has_function_privilege('authenticated', 'public.my_open_quotes(text,integer,integer,uuid,integer)', 'execute') then 'PASS' else 'FAIL' end);
  j := public.my_open_quotes('mine', 5, 0, null, null);
  insert into _oq values ('01 signed out: quietly nothing', case when (j ->> 'total')::int = 0 and not (j ->> 'can_edit')::boolean then 'PASS' else 'FAIL: ' || j::text end);

  -- ---- 1) the owner bug: start quote one, leave at Proposal, start quote two - BOTH stay ----
  perform auth.login_as(a_admin);
  perform public.mark_flow_step(q1, 'proposal');
  perform pg_sleep(0.01);
  perform public.mark_flow_step(q2, 'discovery');
  perform public.mark_flow_step(x, 'quote') from unnest(array[qQ, qL, qSent, qAppr, qPaid, qCanc, qConf, qArch, qDel, qDemo]) x;
  j := public.my_open_quotes('mine', 100, 0, null, null);
  select array_agg(x ->> 'code' order by o) into ids from jsonb_array_elements(j -> 'rows') with ordinality t(x, o) where x ->> 'code' like 'OQ-%';
  insert into _oq values ('10 both unfinished quotes are listed, the newest first', case when ids[1:2] = array['OQ-2', 'OQ-1'] or (array_position(ids, 'OQ-1') is not null and array_position(ids, 'OQ-2') is not null and array_position(ids, 'OQ-2') < array_position(ids, 'OQ-1'))
    then 'PASS' else 'FAIL: ' || coalesce(ids::text, 'null') end);
  insert into _oq values ('11 the step each one stopped at is kept per quote', case when exists (select 1 from jsonb_array_elements(j -> 'rows') x where x ->> 'code' = 'OQ-1' and x ->> 'my_step' = 'proposal' and x ->> 'phase' = 'building')
    and exists (select 1 from jsonb_array_elements(j -> 'rows') x where x ->> 'code' = 'OQ-2' and x ->> 'my_step' = 'discovery') then 'PASS' else 'FAIL' end);
  insert into _oq values ('12 quotation saved, locked and sent stay listed with their phase', case when
    exists (select 1 from jsonb_array_elements(j -> 'rows') x where x ->> 'code' = 'OQ-Q' and x ->> 'phase' = 'quoted')
    and exists (select 1 from jsonb_array_elements(j -> 'rows') x where x ->> 'code' = 'OQ-L' and x ->> 'phase' = 'locked')
    and exists (select 1 from jsonb_array_elements(j -> 'rows') x where x ->> 'code' = 'OQ-SENT' and x ->> 'phase' = 'sent') then 'PASS' else 'FAIL: ' || coalesce(ids::text, 'null') end);
  insert into _oq values ('13 approved, paid, cancelled, confirmed stage, archived, deleted and sample data are not listed', case when
    not (ids && array['OQ-APPR', 'OQ-PAID', 'OQ-CANC', 'OQ-CONF', 'OQ-ARCH', 'OQ-DEL', 'OQ-DEMO']) then 'PASS' else 'FAIL: ' || ids::text end);
  insert into _oq values ('14 total counts every open quote, can_edit for an editor', case when (j ->> 'total')::int >= 5 and (j ->> 'can_edit')::boolean and (j ->> 'open')::boolean then 'PASS' else 'FAIL: ' || left(j::text, 200) end);
  j := public.my_open_quotes('mine', 2, 0, null, null);
  insert into _oq values ('15 limit pages the rows, total stays', case when jsonb_array_length(j -> 'rows') = 2 and (j ->> 'total')::int >= 5 then 'PASS' else 'FAIL' end);
  j := public.my_unfinished_quotes('mine', 100, 0, null, null);
  select array_agg(x ->> 'code') into ids from jsonb_array_elements(j -> 'rows') x where x ->> 'code' like 'OQ-%';
  insert into _oq values ('16 my_unfinished_quotes (0206) answers as before: building only', case when ids @> array['OQ-1', 'OQ-2'] and not (ids && array['OQ-Q', 'OQ-L', 'OQ-SENT'])
    then 'PASS' else 'FAIL: ' || coalesce(ids::text, 'null') end);
  j := public.my_open_quotes('studio', 1, 0, qQ, null);
  insert into _oq values ('17 one quote by id', case when (j ->> 'total')::int = 1 and j -> 'rows' -> 0 ->> 'id' = qQ::text then 'PASS' else 'FAIL' end);
  e := ''; begin perform public.my_open_quotes('everyone', 5, 0, null, null); exception when others then e := sqlstate; end;
  insert into _oq values ('18 an unknown scope is refused', case when e = '22023' then 'PASS' else 'FAIL: ' || e end);

  -- ---- 2) Hide = hide only ----
  select updated_at into ts from public.quotes where id = q1;
  perform public.mark_flow_resume_dismissed(q1);
  j := public.my_open_quotes('mine', 100, 0, null, null);
  insert into _oq values ('20 hidden quote leaves MY list', case when not exists (select 1 from jsonb_array_elements(j -> 'rows') x where x ->> 'code' = 'OQ-1')
    and exists (select 1 from jsonb_array_elements(j -> 'rows') x where x ->> 'code' = 'OQ-2') then 'PASS' else 'FAIL' end);
  j := public.my_open_quotes('studio', 100, 0, null, null);
  insert into _oq values ('21 the studio list still has it, marked hidden', case when exists (select 1 from jsonb_array_elements(j -> 'rows') x where x ->> 'code' = 'OQ-1' and (x ->> 'hidden')::boolean)
    then 'PASS' else 'FAIL' end);
  perform auth.logout(); execute 'reset role';
  insert into _oq values ('22 hiding never changes or deletes the quote', case when exists (select 1 from public.quotes where id = q1 and deleted_at is null and archived_at is null
    and status = 'quote' and updated_at = ts) then 'PASS' else 'FAIL' end);
  perform auth.login_as(a_admin);
  perform public.mark_flow_step(q1, 'layout');
  j := public.my_open_quotes('mine', 100, 0, null, null);
  insert into _oq values ('23 working on it again brings it back at the new step', case when exists (select 1 from jsonb_array_elements(j -> 'rows') x where x ->> 'code' = 'OQ-1' and x ->> 'my_step' = 'layout')
    then 'PASS' else 'FAIL' end);
  perform auth.logout(); execute 'reset role';

  -- ---- 3) client approves -> gone ----
  update public.quotes set approval_status = 'approved' where id = qSent;
  perform auth.login_as(a_admin);
  j := public.my_open_quotes('mine', 100, 0, null, null);
  insert into _oq values ('30 once the client approves the quote leaves the list', case when not exists (select 1 from jsonb_array_elements(j -> 'rows') x where x ->> 'code' = 'OQ-SENT')
    then 'PASS' else 'FAIL' end);
  perform auth.logout(); execute 'reset role';

  -- ---- 4) teammate, view-only role, another studio ----
  perform auth.login_as(a_staff);
  j := public.my_open_quotes('mine', 100, 0, null, null);
  insert into _oq values ('40 a teammate does not get my quotes in their own list', case when not exists (select 1 from jsonb_array_elements(j -> 'rows') x where x ->> 'code' like 'OQ-%') then 'PASS' else 'FAIL' end);
  perform auth.logout(); execute 'reset role';
  update public.role_access set can_edit = false where role = 'sales' and area = 'quotes' and org_id = org;
  perform auth.login_as(a_staff);
  j := public.my_open_quotes('studio', 100, 0, null, null);
  insert into _oq values ('41 view-only role sees the studio list with can_edit false', case when exists (select 1 from jsonb_array_elements(j -> 'rows') x where x ->> 'code' = 'OQ-1')
    and not (j ->> 'can_edit')::boolean then 'PASS' else 'FAIL: ' || left(j::text, 200) end);
  perform auth.logout(); execute 'reset role';
  perform auth.login_as(b_admin);
  j := public.my_open_quotes('studio', 100, 0, null, null);
  insert into _oq values ('42 another studio never lists these quotes', case when not exists (select 1 from jsonb_array_elements(j -> 'rows') x where x ->> 'code' like 'OQ-%') then 'PASS' else 'FAIL' end);
  j := public.my_open_quotes('studio', 1, 0, q1, null);
  insert into _oq values ('43 another studio cannot read one by id', case when (j ->> 'total')::int = 0 then 'PASS' else 'FAIL' end);
  perform auth.logout(); execute 'reset role';
  select count(*) into n from public.quotes where id in (q1, q2, qQ, qL, qSent, qAppr, qPaid, qCanc, qConf, qArch, qDel, qDemo);
  insert into _oq values ('50 every test quote is still there (nothing deleted)', case when n = 12 then 'PASS' else 'FAIL: ' || n end);
exception when others then execute 'reset role'; insert into _oq values ('xx setup', 'FAIL: ' || sqlstate || ' ' || sqlerrm); end $$;

select name, result from _oq order by name;
select case when count(*) filter (where result <> 'PASS') = 0 then 'R154C-OPEN-QUOTES-0350: ALL PASS (' || count(*) || '/' || count(*) || ')'
            else 'R154C-OPEN-QUOTES-0350: ' || count(*) filter (where result <> 'PASS') || ' FAILED of ' || count(*) end as summary from _oq;
rollback;
