-- r163-bell-type-once-0357.sql - behavioral proof for 0357 (bell / inbox / pending: the notification type worked out once
-- per (kind, channel) pair, not once per row). The new _r23_visible and bell_feed__pre0042 answer EXACTLY what the kept
-- bodies (_r23_visible__pre0357, bell_feed__pre0042__pre0357) answer - same rows, same type, same redacted detail, same list
-- and unread count - for an admin, a sales login (money / closure / link-view rules), muted types and odd kinds (null kind,
-- security_alert, wa_templates, price_change, client_view_followup with and without "notify"); much faster; kept bodies
-- without any privilege; a re-run changes nothing. Local disposable PG only. Rolled back.
\set ON_ERROR_STOP 0
set client_min_messages = warning;
begin;
create temp table _bt(name text, result text); grant all on _bt to anon, authenticated;
-- earlier suites in run-all.sh re-apply older inbox bodies (0266 / 0270) for real: put the canonical 0293 rules back first
\i supabase/migrations/0293_r52_notifications_clear.sql
\i supabase/migrations/0357_r163_bell_type_once.sql
-- a re-run is safe
\i supabase/migrations/0357_r163_bell_type_once.sql

do $$ declare a_admin uuid; a_staff uuid; org uuid := 'a0000000-0000-4000-8000-000000000001'; q uuid; n int; m int;
  t0 timestamptz; t_old interval; t_new interval; src text; begin
  execute 'reset role';
  select id into a_admin from auth.users where email='a_admin@a.test';
  select id into a_staff from auth.users where email='a_staff@a.test';
  select id into q from public.quotes where org_id = org limit 1;

  insert into public.notifications(quote_id, channel, kind, status, detail, org_id, created_at)
  select case when g % 2 = 0 then q end,
         (array['in_app', 'email', 'whatsapp'])[1 + g % 3],
         (array[null, 'price_change', 'client_link_viewed', 'client_view_followup', 'event_close_request', 'wa_templates',
                'security_alert', 'payment_received', 'quote_sent', 'task_assigned', 'chat'])[1 + g % 11],
         'simulated',
         case when g % 5 = 0 then jsonb_build_object('notify', jsonb_build_array(a_staff::text), 'total', 5, 'message', 'paid Rs. 500')
              when g % 5 = 1 then jsonb_build_object('notify', jsonb_build_array(gen_random_uuid()::text), 'amount', g)
              when g % 5 = 2 then jsonb_build_object('approval_token', gen_random_uuid()::text, 'label', 'x')
              else jsonb_build_object('amount', g, 'label', 'row ' || g) end,
         org, now() - make_interval(secs => g * 13)
    from generate_series(1, 4000) g;
  insert into public.notification_mutes(user_id, org_id, type)
    values (a_staff, org, public.notification_type_of('task_assigned', 'in_app')) on conflict do nothing;

  -- 1-4 _r23_visible: identical rows (admin + sales), both directions
  select count(*) into n from (select * from public._r23_visible__pre0357(org, a_admin) except all select * from public._r23_visible(org, a_admin)) x;
  select count(*) into m from (select * from public._r23_visible(org, a_admin) except all select * from public._r23_visible__pre0357(org, a_admin)) x;
  insert into _bt values ('01 admin inbox rows identical', case when n = 0 and m = 0 and (select count(*) from public._r23_visible(org, a_admin)) > 3000 then 'PASS' else 'FAIL ' || n || '/' || m end);
  select count(*) into n from (select * from public._r23_visible__pre0357(org, a_staff) except all select * from public._r23_visible(org, a_staff)) x;
  select count(*) into m from (select * from public._r23_visible(org, a_staff) except all select * from public._r23_visible__pre0357(org, a_staff)) x;
  insert into _bt values ('02 sales inbox rows identical (money / closure / link views / mutes)', case when n = 0 and m = 0 then 'PASS' else 'FAIL ' || n || '/' || m end);
  insert into _bt values ('03 sales sees fewer rows than admin (rules still apply)',
    case when (select count(*) from public._r23_visible(org, a_staff)) < (select count(*) from public._r23_visible(org, a_admin)) then 'PASS' else 'FAIL' end);
  insert into _bt values ('04 muted type and security_alert stay out',
    case when not exists (select 1 from public._r23_visible(org, a_staff) v where v.ntype = public.notification_type_of('task_assigned', 'in_app'))
          and not exists (select 1 from public._r23_visible(org, a_admin) v where v.kind = 'security_alert') then 'PASS' else 'FAIL' end);

  -- 5-6 bell_feed__pre0042 (the 0036 list + unread) identical, as admin and as sales
  perform auth.login_as(a_admin); execute 'reset role';
  insert into _bt values ('05 admin bell list + unread identical',
    case when public.bell_feed__pre0042(20) = public.bell_feed__pre0042__pre0357(20) and public.bell_feed__pre0042(100) = public.bell_feed__pre0042__pre0357(100) then 'PASS' else 'FAIL' end);
  perform auth.login_as(a_staff); execute 'reset role';
  insert into _bt values ('06 sales bell list + unread identical',
    case when public.bell_feed__pre0042(20) = public.bell_feed__pre0042__pre0357(20) then 'PASS' else 'FAIL' end);

  -- 7 faster: the old inbox rows vs the new ones (same data)
  t0 := clock_timestamp(); perform count(*) from public._r23_visible__pre0357(org, a_admin); t_old := clock_timestamp() - t0;
  t0 := clock_timestamp(); perform count(*) from public._r23_visible(org, a_admin); t_new := clock_timestamp() - t0;
  insert into _bt values ('07 inbox rows at least 3x faster', case when t_new * 3 < t_old then 'PASS' else 'FAIL old ' || t_old || ' new ' || t_new end);

  -- 8-9 the bodies: new marker, type once per pair; kept copies are the known old bodies
  select p.prosrc into src from pg_proc p where p.oid = to_regprocedure('public._r23_visible(uuid,uuid)');
  insert into _bt values ('08 _r23_visible is the 0357 body (pairs materialized, no per-row type call)',
    case when position('r163-0357' in src) > 0 and position('pairs as materialized' in src) > 0 and position('cross join lateral' in src) = 0 then 'PASS' else 'FAIL' end);
  insert into _bt values ('09 kept copies are the 0293 / 0036 bodies',
    case when position('r52-notif-0293' in (select p.prosrc from pg_proc p where p.oid = to_regprocedure('public._r23_visible__pre0357(uuid,uuid)'))) > 0
          and position('notification-prefs-0036' in (select p.prosrc from pg_proc p where p.oid = to_regprocedure('public.bell_feed__pre0042__pre0357(integer)'))) > 0
          and position('r163-0357' in (select p.prosrc from pg_proc p where p.oid = to_regprocedure('public.bell_feed__pre0042(integer)'))) > 0 then 'PASS' else 'FAIL' end);

  -- 10-11 privileges
  insert into _bt values ('10 nobody may run the kept bodies',
    case when not has_function_privilege('authenticated', 'public._r23_visible__pre0357(uuid,uuid)', 'execute')
          and not has_function_privilege('anon', 'public._r23_visible__pre0357(uuid,uuid)', 'execute')
          and not has_function_privilege('service_role', 'public._r23_visible__pre0357(uuid,uuid)', 'execute')
          and not has_function_privilege('authenticated', 'public.bell_feed__pre0042__pre0357(integer)', 'execute')
          and not has_function_privilege('service_role', 'public.bell_feed__pre0042__pre0357(integer)', 'execute') then 'PASS' else 'FAIL' end);
  insert into _bt values ('11 the new helpers stay internal (no anon / signed-in), service role as before',
    case when not has_function_privilege('authenticated', 'public._r23_visible(uuid,uuid)', 'execute')
          and not has_function_privilege('anon', 'public.bell_feed__pre0042(integer)', 'execute')
          and has_function_privilege('service_role', 'public._r23_visible(uuid,uuid)', 'execute')
          and has_function_privilege('authenticated', 'public.bell_feed(integer)', 'execute') then 'PASS' else 'FAIL' end);
  insert into _bt values ('12 security definer + empty search_path kept',
    case when (select bool_and(p.prosecdef and 'search_path=""' = any(p.proconfig)) from pg_proc p
                where p.oid in (to_regprocedure('public._r23_visible(uuid,uuid)'), to_regprocedure('public.bell_feed__pre0042(integer)'))) then 'PASS' else 'FAIL' end);

  -- 14-16 my_open_quotes: the 0356 answer exactly, the step count only where needed
  insert into public.quotes(id, code, title, status, client, pricing, current_version, approval_status, org_id, event_type, created_at, updated_at)
  select gen_random_uuid(), 'OQ-' || g, case when g % 4 = 0 then 'OQ-' || g else 'Open ' || g end,
         case when g % 6 = 0 then 'confirmed' else 'quote' end,
         case when g % 4 = 0 then '{}'::jsonb else jsonb_build_object('name', 'C' || g) end,
         case when g % 3 = 0 then '{"subtotal":1000,"discount":0,"gstPct":18,"total":1180}'::jsonb
              else '{"subtotal":0,"discount":0,"gstPct":18,"total":0}'::jsonb end, 1,
         case when g % 5 = 0 then 'sent' else 'none' end, org, case when g % 4 = 0 then null else 'Wedding' end,
         now() - make_interval(hours => g), now() - make_interval(hours => g)
    from generate_series(1, 120) g;
  -- an empty quote with a requirement (listed only through its step count) and one with my flow step
  insert into public.event_requirements(quote_id, org_id, service)
    select q2.id, org, 'need' from public.quotes q2 where q2.code in ('OQ-4', 'OQ-8') on conflict do nothing;
  insert into public.quote_flow_progress(quote_id, user_id, org_id, last_step, last_step_at)
    select q2.id, a_admin, org, 'venue', now() - interval '5 minutes' from public.quotes q2 where q2.code in ('OQ-12', 'OQ-30', 'OQ-31') on conflict do nothing;
  perform auth.login_as(a_admin); execute 'reset role';
  select count(*) into n from (values ('mine', 5, 0, null::int), ('mine', 100, 0, null), ('studio', 20, 0, null), ('studio', 100, 0, null),
                                       ('studio', 100, 40, null), ('studio', 10, 0, 1), ('mine', 3, 2, null)) a(s, l, o, d)
   where public.my_open_quotes(a.s, a.l, a.o, null, a.d) is distinct from public.my_open_quotes__pre0357(a.s, a.l, a.o, null, a.d);
  select count(*) into m from public.quotes q2 where q2.org_id = org and q2.code like 'OQ-%'
     and public.my_open_quotes('studio', 5, 0, q2.id, null) is distinct from public.my_open_quotes__pre0357('studio', 5, 0, q2.id, null);
  insert into _bt values ('14 my_open_quotes answers exactly as the 0356 body (admin, every scope / page / one quote)',
    case when n = 0 and m = 0 and (public.my_open_quotes('studio', 100, 0, null, null) ->> 'total')::int > 50
          and exists (select 1 from jsonb_array_elements(public.my_open_quotes('studio', 100, 0, null, null) -> 'rows') r where r ->> 'code' = 'OQ-4')
          and not exists (select 1 from jsonb_array_elements(public.my_open_quotes('studio', 100, 0, null, null) -> 'rows') r where r ->> 'code' = 'OQ-16')
         then 'PASS' else 'FAIL ' || n || '/' || m end);
  perform auth.login_as(a_staff); execute 'reset role';
  select count(*) into n from (values ('mine', 5, 0), ('studio', 100, 0), ('studio', 7, 3)) a(s, l, o)
   where public.my_open_quotes(a.s, a.l, a.o, null, null) is distinct from public.my_open_quotes__pre0357(a.s, a.l, a.o, null, null);
  insert into _bt values ('15 my_open_quotes answers exactly as the 0356 body (sales)', case when n = 0 then 'PASS' else 'FAIL ' || n end);
  select p.prosrc into src from pg_proc p where p.oid = to_regprocedure('public.my_open_quotes(text,integer,integer,uuid,integer)');
  insert into _bt values ('16 my_open_quotes 0357 body, 0356 kept with no privilege, signed-in may call',
    case when position('r163-0357' in src) > 0 and position('public._flow_steps_done(b.id)' in src) = 0
          and position('open-quotes-0356' in (select p.prosrc from pg_proc p where p.oid = to_regprocedure('public.my_open_quotes__pre0357(text,integer,integer,uuid,integer)'))) > 0
          and not has_function_privilege('authenticated', 'public.my_open_quotes__pre0357(text,integer,integer,uuid,integer)', 'execute')
          and not has_function_privilege('service_role', 'public.my_open_quotes__pre0357(text,integer,integer,uuid,integer)', 'execute')
          and has_function_privilege('authenticated', 'public.my_open_quotes(text,integer,integer,uuid,integer)', 'execute')
          and not has_function_privilege('anon', 'public.my_open_quotes(text,integer,integer,uuid,integer)', 'execute') then 'PASS' else 'FAIL' end);
end $$;

-- 13 the public bell + pending still answer for a signed-in admin
select auth.login_as((select id from auth.users where email='a_admin@a.test'));
insert into _bt select '13 bell_feed + my_pending answer as the signed-in user',
  case when jsonb_typeof(public.bell_feed(20) -> 'items') = 'array' and public.my_pending() is not null then 'PASS' else 'FAIL' end;
reset role;

select name, result from _bt order by name;
select case when count(*) filter (where result <> 'PASS') = 0 and count(*) = 16
            then 'R163-BELL-TYPE-ONCE-0357: ALL PASS (' || count(*) || '/' || count(*) || ')'
            else 'R163-BELL-TYPE-ONCE-0357: FAIL (' || count(*) filter (where result = 'PASS') || '/' || count(*) || ')' end
  from _bt;
rollback;
