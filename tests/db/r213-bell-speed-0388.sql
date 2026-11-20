-- r213-bell-speed-0388.sql - R213 (0388): the bell / badge / pending / inbox answers are IDENTICAL before and after the
-- speed fix, for every person of three studios. Seeds studio C (12 people: admin, manager, coordinator, sales x2, planner,
-- designer, crew, worker, operations, supervisor, quality) with ~1,500 notifications of every kind (money rows, links /
-- tokens, notify-list rows naming other people or people of another studio, security / closure / price / client-view
-- rows), Done / read / snoozed / back-from-snooze / marked-unread inbox state, mutes, switched-off types (role + person),
-- "mark all read" times; studios A and B get their own rows. Then works everything out twice in one transaction: with the
-- 0388 functions, and with the kept __pre0388 bodies put back in their place (the old answers) - bell_feed(10 / 100 /
-- default), my_pending, inbox_feed (4 tabs), _r23_visible, _r23_rows, _r23_counts per person must match exactly. Plus:
-- nobody sees another studio's notice, a notify-list notice only for the people on it, money / price / closure rules,
-- the test data really has back-from-snooze, Done, stripped money keys and links; definer / empty search_path / grants /
-- markers; the tripwire: _r23_visible still the r213-0388 body on _r388_vis (a new wrapper must also go into _r388_vis).
-- Re-applies 0388 twice. Rolled back.
\set ON_ERROR_STOP 0
set client_min_messages = error;
\ir ../../supabase/migrations/0388_r213_bell_speed.sql
\ir ../../supabase/migrations/0388_r213_bell_speed.sql
set client_min_messages = warning;
begin;
-- r235 (0401): this suite proves 0388 against the bodies before it, so the 0388 bodies that 0401 kept as __pre0401 are put
-- back while it runs (0401 is proved by tests/db/r235-db-load-0401.sql; rolled back)
do $$ declare f record; begin
  for f in select * from (values ('bell_feed__pre0042', 'integer', false), ('bell_feed__pre0299', 'integer', false), ('my_pending', '', true),
                              ('inbox_feed__pre0299', 'text,text,uuid,integer,text', false),
                              ('inbox_act', 'uuid[],text,timestamp with time zone,text', true), ('inbox_read_all', 'text,uuid', true)) x(n, a, page) loop
    if to_regprocedure(format('public.%s__pre0401(%s)', f.n, f.a)) is not null then
      execute format('alter function public.%I(%s) rename to %I', f.n, f.a, f.n || '__r235off');
      execute format('alter function public.%I(%s) rename to %I', f.n || '__pre0401', f.a, f.n);
      if f.page then execute format('grant execute on function public.%I(%s) to authenticated', f.n, f.a); end if;
    end if;
  end loop;
end $$;
create temp table _r213(name text, result text); grant all on _r213 to anon, authenticated, service_role;
create temp table _r213o(mode text, email text, call text, v jsonb); grant all on _r213o to anon, authenticated, service_role;
create or replace function pg_temp.su() returns void language plpgsql as $$
begin execute 'reset role'; perform auth.logout(); execute 'reset role'; end $$;
create or replace function pg_temp.login(p_email text) returns void language plpgsql as $$
declare u uuid; begin
  perform pg_temp.su(); select id into u from auth.users where email = p_email;
  perform set_config('request.jwt.claims', jsonb_build_object('sub', u, 'role', 'authenticated', 'email', p_email)::text, false);
  perform set_config('role', 'authenticated', false);
end $$;
create or replace function pg_temp.res(p_name text, p_ok boolean, p_detail text default '') returns void language plpgsql as $$
begin perform pg_temp.su(); insert into _r213 values (p_name, case when coalesce(p_ok, false) then 'PASS' else 'FAIL: '||coalesce(p_detail,'') end); end $$;
-- one call as the signed-in person; an error is kept as its text (it must be the same error before and after)
create or replace function pg_temp.try(p_sql text) returns jsonb language plpgsql as $$
declare v jsonb; begin execute p_sql into v; return v; exception when others then return jsonb_build_object('error', sqlstate); end $$;
grant execute on function pg_temp.try(text) to anon, authenticated, service_role;

-- ---- seed (deterministic ids) -----------------------------------------------------------------------------------------
do $$
declare v_c uuid := 'c3000000-0000-4000-8000-000000000388'; v_a uuid := 'a0000000-0000-4000-8000-000000000001';
        v_b uuid := 'b0000000-0000-4000-8000-000000000001';
        roles text[] := array['admin','manager','coordinator','sales','sales','planner','designer','crew','worker','operations','supervisor','quality'];
        u uuid; i int; ids uuid[] := '{}'; a_admin uuid;
begin
  perform pg_temp.su();
  insert into public.organizations(id, name, currency, timezone, brand, plan, created_at)
    values (v_c, 'Studio C r213', 'INR', 'Asia/Kolkata', '{}'::jsonb, 'pro', now()) on conflict (id) do nothing;
  for i in 1..array_length(roles, 1) loop
    select id into u from auth.users where email = 'r213_' || i || '@c.test';
    if u is null then u := auth.seed_user('r213_' || i || '@c.test'); end if;
    insert into public.profiles(id, email, role, org_id, must_change_password, created_at)
      values (u, 'r213_' || i || '@c.test', roles[i], v_c, false, now())
      on conflict (id) do update set role = excluded.role, org_id = excluded.org_id;
    ids := ids || u;
  end loop;
  -- a signed-in login that belongs to no studio
  if not exists (select 1 from auth.users where email = 'r213_nostudio@c.test') then perform auth.seed_user('r213_nostudio@c.test'); end if;
  select id into a_admin from auth.users where email = 'a_admin@a.test';
  insert into public.role_access(role, area, can_view, can_edit, org_id, updated_at)
    select r, a, true, (r <> 'planner'), v_c, now()
      from (values ('sales'), ('manager'), ('planner')) rr(r), (values ('quotes'), ('finance'), ('proposal')) aa(a)
  on conflict (role, area, org_id) do nothing;
  insert into public.role_access(role, area, can_view, can_edit, org_id, updated_at) values
    ('planner', 'closure', true, false, v_c, now()), ('operations', 'closure', true, false, v_c, now())
  on conflict (role, area, org_id) do nothing;
  insert into public.quotes(id, code, title, status, client, pricing, current_version, approval_status, org_id, created_at, updated_at, event_date)
    select md5('r213q' || g)::uuid, 'C388-' || g, 'Event ' || g, 'quote', '{"name":"Client"}'::jsonb, '{"subtotal":100000,"discount":0,"gstPct":18,"total":118000}'::jsonb, 1, 'sent', v_c,
           now() - (g || ' days')::interval, now(), (now() + (g || ' days')::interval)::date
      from generate_series(1, 20) g
  on conflict (id) do nothing;

  set local session_replication_role = replica;   -- bulk test rows: no notification triggers (rolled back)
  insert into public.notifications(id, quote_id, channel, recipient, kind, status, detail, created_at, org_id)
  select md5('r213n' || g)::uuid,
         case when g % 5 = 0 then null else md5('r213q' || (1 + g % 20))::uuid end,
         (array['in_app','in_app','sms','email','whatsapp'])[1 + g % 5], null, k.kind, (array['simulated','sent','failed'])[1 + g % 3],
         case when g % 97 = 0 then null
              when g % 89 = 0 then '"just text"'::jsonb
              when g % 83 = 0 then '[1, 2]'::jsonb
              else jsonb_strip_nulls(jsonb_build_object(
                'message', case when g % 4 = 0 then 'Paid Rs. ' || g || ' (total)' when g % 7 = 0 then 'Amount due ' || g else 'Update ' || g end,
                'amount', case when g % 3 = 0 then g * 10 end, 'total', case when g % 5 = 0 then g * 100 end,
                'balance_due', case when g % 11 = 0 then g end, 'Discount', case when g % 13 = 0 then 5 end,
                'link', case when g % 2 = 0 then 'https://x.test/l/' || md5(g::text) end, 'token', case when g % 9 = 0 then md5('t' || g) end,
                'work_url', case when g % 10 = 0 then 'https://x.test/w/' || g end,
                'task', 'Task ' || g, 'label', 'Label ' || g,
                'notify', case when g % 3 = 0 then jsonb_build_array(ids[1 + g % 12]::text, ids[1 + (g * 5) % 12]::text)
                               when g % 3 = 1 then jsonb_build_array(a_admin::text)
                               when g % 17 = 0 then '[]'::jsonb end)) end,
         now() - ((g * 7) || ' minutes')::interval, v_c
    from generate_series(1, 1500) g
    cross join lateral (select (array['task_assigned','task_update','task_reminder','task_due','design_update','approval_link','otp',
                                      'whatsapp_message','payment_link','payment_reminder','payment_receipt','advance_paid','chat_message',
                                      'other','price_change','pkg_payment','pkg_selected','client_link_viewed','client_view_followup',
                                      'event_close_request','event_close_decision','task_escalated','vendor_bill_due','team_signin',
                                      'security_alert','team_safety','studio_security','plan_active','wa_templates','inventory_low_stock',
                                      'payment_overdue','invoice_sent','refund_issued','budget_alert','quote_sent', null])[1 + (g * 7) % 36] as kind) k
  on conflict (id) do nothing;
  -- studios v_a and v_b: their own rows (one names a studio v_c person on its notify list)
  insert into public.notifications(id, channel, kind, status, detail, created_at, org_id)
  select md5('r213ab' || g)::uuid, 'in_app', (array['task_update','team_signin','payment_receipt','vendor_bill_due','other'])[1 + g % 5], 'simulated',
         jsonb_build_object('message', 'other studio ' || g, 'amount', g, 'notify', jsonb_build_array(a_admin::text, ids[1 + g % 12]::text)),
         now() - (g || ' minutes')::interval, case when g % 2 = 0 then v_a else v_b end
    from generate_series(1, 300) g
  on conflict (id) do nothing;
  -- inbox state: read / Done / snoozed (still) / back from snooze / marked unread
  insert into public.notification_inbox_state(user_id, notification_id, org_id, read_at, unread_at, done_at, snoozed_until, snooze_returned_at, updated_at)
  select p.id, n.id, n.org_id,
         case when h % 5 = 0 then n.created_at + interval '1 minute' end,
         case when h % 29 = 0 then now() - interval '30 minutes' end,
         case when h % 11 = 1 then n.created_at + interval '2 minutes' end,
         case when h % 13 = 2 then now() + interval '1 day' when h % 7 = 3 then now() - ((h % 300) || ' minutes')::interval end,
         case when h % 17 = 4 then now() - ((h % 200) || ' minutes')::interval end,
         now()
    from public.profiles p
    join public.notifications n on n.org_id = p.org_id
    cross join lateral (select abs(hashtext(p.id::text || n.id::text)) as h) hh
   where p.org_id in (v_a, v_b, v_c) and (h % 5 = 0 or h % 29 = 0 or h % 11 = 1 or h % 13 = 2 or h % 7 = 3 or h % 17 = 4)
  on conflict do nothing;
  -- rows written in one statement share one time; the bell orders by time only, so ties have no fixed order before or
  -- after 0388 - give every row of the three studios its own time (a microsecond apart) so the comparison is exact
  update public.notifications n set created_at = n.created_at - make_interval(secs => r.rn / 1000000.0)
    from (select x.id, row_number() over (partition by x.org_id, x.created_at order by x.id) - 1 as rn
            from public.notifications x where x.org_id in (v_a, v_b, v_c)) r
   where r.id = n.id and r.rn > 0;
  set local session_replication_role = origin;
  -- "mark all read": some recently, some long ago, some never
  insert into public.notification_seen(user_id, last_seen_at, org_id)
    select ids[k], now() - ((k * 37) || ' minutes')::interval, v_c from generate_series(1, 12) k where k % 4 <> 0
  on conflict (user_id) do update set last_seen_at = excluded.last_seen_at, org_id = excluded.org_id;
  delete from public.notification_seen where user_id in (ids[4], ids[8], ids[12]);
  -- mutes + switched-off types (a role default and one person)
  insert into public.notification_mutes(user_id, org_id, type) values (ids[2], v_c, 'chat_message'), (ids[4], v_c, 'task_update'), (ids[8], v_c, 'other')
  on conflict do nothing;
  insert into public.notification_prefs(org_id, role, user_id, type, channel, enabled) values
    (v_c, 'crew', null, 'design_update', 'in_app', false), (v_c, 'sales', null, 'task_reminder', 'in_app', false)
  on conflict do nothing;
  insert into public.notification_prefs(org_id, role, user_id, type, channel, enabled) values (v_c, '*', ids[6], 'task_assigned', 'in_app', false)
  on conflict do nothing;
end $$;

-- ---- every answer, per person ---------------------------------------------------------------------------------------------
create or replace function pg_temp.collect(p_mode text) returns void language plpgsql as $$
declare r record; o uuid; v jsonb; t text;
begin
  for r in select u.id, u.email from auth.users u
            where u.email like 'r213\_%@c.test' or u.email in ('a_admin@a.test', 'a_staff@a.test', 'b_admin@b.test', 'b_staff@b.test')
            order by u.email loop
    perform pg_temp.login(r.email);
    insert into _r213o values (p_mode, r.email, 'bell10', pg_temp.try('select public.bell_feed(10)'));
    insert into _r213o values (p_mode, r.email, 'bell100', pg_temp.try('select public.bell_feed(100)'));
    insert into _r213o values (p_mode, r.email, 'bell', pg_temp.try('select public.bell_feed()'));
    insert into _r213o values (p_mode, r.email, 'pending', pg_temp.try('select public.my_pending() - ''as_of'''));
    foreach t in array array['unread', 'all', 'done', 'snoozed'] loop
      insert into _r213o values (p_mode, r.email, 'inbox_' || t, pg_temp.try(format('select public.inbox_feed(%L, null, null, 100, null)', t)));
    end loop;
    perform pg_temp.su();
    o := (select p.org_id from public.profiles p where p.id = r.id);
    insert into _r213o values (p_mode, r.email, 'visible',
      (select coalesce(jsonb_agg(to_jsonb(x) order by x.id), '[]'::jsonb) from public._r23_visible(o, r.id) x));
    insert into _r213o values (p_mode, r.email, 'rows',
      (select coalesce(jsonb_agg(to_jsonb(x) order by x.id), '[]'::jsonb) from public._r23_rows(o, r.id) x));
    insert into _r213o values (p_mode, r.email, 'counts', public._r23_counts(o, r.id));
  end loop;
  perform pg_temp.su();
end $$;

-- the kept __pre0388 bodies back in place (= the answers before 0388), or the 0388 ones
create or replace function pg_temp.swap(p_old boolean) returns void language plpgsql as $$
declare f record;
begin
  for f in select * from (values ('_r23_visible', 'uuid,uuid'), ('_r23_counts', 'uuid,uuid'), ('bell_feed__pre0299', 'integer'),
                              ('bell_feed__pre0042', 'integer')) x(n, a) loop
    if p_old then
      execute format('alter function public.%I(%s) rename to %I', f.n, f.a, f.n || '__r213new');
      execute format('alter function public.%I(%s) rename to %I', f.n || '__pre0388', f.a, f.n);
    else
      execute format('alter function public.%I(%s) rename to %I', f.n, f.a, f.n || '__pre0388');
      execute format('alter function public.%I(%s) rename to %I', f.n || '__r213new', f.a, f.n);
    end if;
  end loop;
end $$;

select pg_temp.collect('new');
select pg_temp.swap(true);
select pg_temp.collect('old');
select pg_temp.swap(false);

do $$
declare n int; d int; ex text;
begin
  perform pg_temp.su();
  select count(*) into n from _r213o where mode = 'new';
  select count(*), min(o.email || ' ' || o.call) into d, ex
    from _r213o o join _r213o x on x.email = o.email and x.call = o.call and x.mode = 'new'
   where o.mode = 'old' and o.v is distinct from x.v;
  perform pg_temp.res('01 every answer identical before / after 0388 (17 people x 11 calls: bell 10 / 100 / default, my_pending, inbox x4, _r23_visible, _r23_rows, _r23_counts)',
    n = 17 * 11 and d = 0 and (select count(*) from _r213o where mode = 'old') = n, format('%s answers, %s differ, first: %s', n, d, ex));
  perform pg_temp.res('02 the bell answered (no error) for every studio member',
    not exists (select 1 from _r213o where call like 'bell%' and email <> 'r213_nostudio@c.test' and (v ? 'error' or jsonb_typeof(v -> 'items') <> 'array')));
end $$;

-- ---- what the answers contain (on the new answers) -----------------------------------------------------------------------
do $$
declare v jsonb; ok boolean;
begin
  perform pg_temp.su();
  -- nobody sees another studio's row: every id in every answer belongs to the person's own studio
  select bool_and(n.org_id = p.org_id) into ok
    from _r213o o join auth.users u on u.email = o.email join public.profiles p on p.id = u.id
    cross join lateral (select e ->> 'id' as id from jsonb_array_elements(case when o.call in ('visible', 'rows') then o.v
                          when jsonb_typeof(o.v -> 'items') = 'array' then o.v -> 'items' else '[]'::jsonb end) e) i
    join public.notifications n on n.id::text = i.id
   where o.mode = 'new';
  perform pg_temp.res('03 nobody sees another studio''s notification (bell, inbox, rule, rows)', ok);
  -- a notify-list kind only for the people on its list (also: a studio C person named on studio A / B rows sees nothing of them)
  select bool_and(jsonb_typeof(n.detail -> 'notify') = 'array' and (n.detail -> 'notify') ? u.id::text) into ok
    from _r213o o join auth.users u on u.email = o.email
    cross join lateral jsonb_array_elements(o.v) e join public.notifications n on n.id::text = e ->> 'id'
   where o.mode = 'new' and o.call = 'visible' and n.kind in ('task_escalated', 'vendor_bill_due', 'team_signin');
  perform pg_temp.res('04 task_escalated / vendor_bill_due / team_signin only for the people on their notify list',
    ok and exists (select 1 from _r213o o, jsonb_array_elements(o.v) e where o.mode = 'new' and o.call = 'visible' and e ->> 'kind' = 'team_signin'));
  -- money / price / closure / security rules by role
  perform pg_temp.res('05 crew / worker / designer see no money kind, no price change, no close request; nobody sees security_alert',
    not exists (select 1 from _r213o o, jsonb_array_elements(o.v) e
                 where o.mode = 'new' and o.call = 'visible' and o.email in ('r213_7@c.test', 'r213_8@c.test', 'r213_9@c.test')
                   and (coalesce(e ->> 'kind', '') ~ '(price|reapproval|payment|refund|invoice|bill|settle|pkg_pay|quote_|discount|budget)'
                        or e ->> 'kind' in ('event_close_request', 'event_close_decision')))
    and not exists (select 1 from _r213o o, jsonb_array_elements(o.v) e where o.mode = 'new' and o.call = 'visible' and e ->> 'kind' = 'security_alert'));
  perform pg_temp.res('06 money keys + money messages stripped for a person without Quotes view, kept for an admin; links / tokens out for all',
    not exists (select 1 from _r213o o, jsonb_array_elements(o.v) e where o.mode = 'new' and o.call = 'visible' and o.email = 'r213_8@c.test'
                 and jsonb_typeof(e -> 'detail') = 'object' and (e -> 'detail' ?| array['amount', 'total', 'balance_due', 'Discount']
                      or coalesce(e -> 'detail' ->> 'message', '') ~* '(price|total|amount|paid|rs\.|inr)'))
    and exists (select 1 from _r213o o, jsonb_array_elements(o.v) e where o.mode = 'new' and o.call = 'visible' and o.email = 'r213_1@c.test'
                 and e -> 'detail' ? 'amount')
    and exists (select 1 from _r213o o, jsonb_array_elements(o.v) e where o.mode = 'new' and o.call = 'visible' and o.email = 'r213_8@c.test'
                 and e -> 'detail' = '{}'::jsonb)
    and not exists (select 1 from _r213o o, jsonb_array_elements(o.v) e where o.mode = 'new' and o.call = 'visible'
                     and jsonb_typeof(e -> 'detail') = 'object' and e -> 'detail' ?| array['link', 'token', 'work_url']));
  -- the data exercised the inbox paths
  perform pg_temp.res('07 the test data has rows back from a snooze in the bell, Done / snoozed rows left out, muted / switched-off types',
    exists (select 1 from _r213o o, jsonb_array_elements(o.v -> 'items') e where o.mode = 'new' and o.call = 'bell100' and (e ->> 'returned')::boolean)
    and exists (select 1 from _r213o o where o.mode = 'new' and o.call = 'counts' and (o.v ->> 'done')::int > 0 and (o.v ->> 'snoozed')::int > 0)
    and exists (select 1 from _r213o o where o.mode = 'new' and o.call = 'bell10' and (o.v ->> 'unread')::int > 0)
    and (select count(distinct o.v) from _r213o o where o.mode = 'new' and o.call = 'counts') >= 10);
  -- the pending count = the badge count (my_pending reads _r23_counts since 0293; a suite run earlier in run-all may have put
  -- an older my_pending body back, then only bell = counts is checked)
  ok := position('_r23_counts' in (select prosrc from pg_proc where oid = 'public.my_pending()'::regprocedure)) > 0;
  perform pg_temp.res('08 the bell badge = _r23_counts unread (= my_pending unread) for every studio C person',
    not exists (select 1 from _r213o b join _r213o p on p.email = b.email and p.call = 'pending' and p.mode = 'new'
                  join _r213o c on c.email = b.email and c.call = 'counts' and c.mode = 'new'
                 where b.mode = 'new' and b.call = 'bell10' and b.email like 'r213\_%@c.test' and b.email <> 'r213_nostudio@c.test'
                   and not ((b.v ->> 'unread')::int = (c.v ->> 'unread')::int and (not ok or (p.v ->> 'unread')::int = (c.v ->> 'unread')::int))),
    (select string_agg(b.email || ' bell ' || coalesce(b.v ->> 'unread', 'null') || ' pending ' || coalesce(p.v ->> 'unread', 'null') || ' counts ' || coalesce(c.v ->> 'unread', 'null'), '; ')
       from _r213o b join _r213o p on p.email = b.email and p.call = 'pending' and p.mode = 'new'
       join _r213o c on c.email = b.email and c.call = 'counts' and c.mode = 'new'
      where b.mode = 'new' and b.call = 'bell10' and b.email like 'r213\_%@c.test' and b.email <> 'r213_nostudio@c.test'
        and not ((b.v ->> 'unread')::int = (c.v ->> 'unread')::int and (not ok or (p.v ->> 'unread')::int = (c.v ->> 'unread')::int))));
end $$;

-- ---- rules of the house -------------------------------------------------------------------------------------------------
select pg_temp.res('09 new + re-issued functions: definer, empty search_path, r213-0388 marker, server only (no anon / authenticated)',
  (select bool_and(p.prosecdef and coalesce(p.proconfig, '{}') @> array['search_path=""'] and position('r213-0388' in p.prosrc) > 0
                   and not has_function_privilege('authenticated', p.oid, 'execute') and not has_function_privilege('anon', p.oid, 'execute'))
     from pg_proc p where p.oid in ('public._r388_vis(uuid,uuid)'::regprocedure, 'public._r388_rows(uuid,uuid)'::regprocedure,
                                    'public._r23_visible(uuid,uuid)'::regprocedure, 'public._r23_counts(uuid,uuid)'::regprocedure,
                                    'public.bell_feed__pre0299(integer)'::regprocedure, 'public.bell_feed__pre0042(integer)'::regprocedure)));
select pg_temp.res('10 old bodies kept once as __pre0388 with no app privilege; bell_feed / my_pending / inbox_feed still for signed-in callers',
  (select count(*) from pg_proc p where p.oid in (to_regprocedure('public._r23_visible__pre0388(uuid,uuid)'), to_regprocedure('public._r23_counts__pre0388(uuid,uuid)'),
                                                  to_regprocedure('public.bell_feed__pre0299__pre0388(integer)'), to_regprocedure('public.bell_feed__pre0042__pre0388(integer)'))
     and not has_function_privilege('authenticated', p.oid, 'execute') and not has_function_privilege('anon', p.oid, 'execute')
     and not has_function_privilege('service_role', p.oid, 'execute')) = 4
  and has_function_privilege('authenticated', 'public.bell_feed(integer)', 'execute') and has_function_privilege('authenticated', 'public.my_pending()', 'execute')
  and has_function_privilege('authenticated', 'public.inbox_feed(text,text,uuid,integer,text)', 'execute')
  and not has_function_privilege('anon', 'public.bell_feed(integer)', 'execute'));
-- tripwire: the badge / pending count read _r388_vis. A future migration that wraps _r23_visible again (renames it to
-- __preNNNN) must ALSO put its rule into _r388_vis - this check then fails until the new wrapper carries the r213-0388 note.
select pg_temp.res('11 tripwire: _r23_visible is still the r213-0388 body built on _r388_vis (new inbox rules go into _r388_vis)',
  position('r213-0388' in (select prosrc from pg_proc where oid = 'public._r23_visible(uuid,uuid)'::regprocedure)) > 0
  and position('public._r388_vis(p_org, p_uid)' in (select prosrc from pg_proc where oid = 'public._r23_visible(uuid,uuid)'::regprocedure)) > 0
  and position('public._r388_rows(p_org, p_uid)' in (select prosrc from pg_proc where oid = 'public._r23_counts(uuid,uuid)'::regprocedure)) > 0
  and position('public._r388_rows(v_org, v_uid)' in (select prosrc from pg_proc where oid = 'public.bell_feed__pre0299(integer)'::regprocedure)) > 0);
select pg_temp.res('12 the older prod-checker markers still hold on the live bodies (r163-0357 ... r205-0383 on _r23_visible, r163-0357 on bell_feed__pre0042)',
  (select bool_and(position(m in (select prosrc from pg_proc where oid = 'public._r23_visible(uuid,uuid)'::regprocedure)) > 0)
     from unnest(array['r163-0357', 'r186-0369', 'r190-0373', 'r205-0383', 'r24-ci-0270']) m)
  and position('r163-0357' in (select prosrc from pg_proc where oid = 'public.bell_feed__pre0042(integer)'::regprocedure)) > 0
  and position('r213-0388' in (select prosrc from pg_proc where oid = 'public.bell_feed__pre0042(integer)'::regprocedure)) > 0);

-- re-running an older wrapper (0383, as its own suite does) puts its body back on top; re-running 0388 restores ours
set client_min_messages = error;
\ir ../../supabase/migrations/0383_r205_signin_notice.sql
set client_min_messages = warning;
select pg_temp.res('13a re-running 0383 after 0388 puts the 0383 wrapper back on top (as before 0388)',
  position('r213-0388' in (select prosrc from pg_proc where oid = 'public._r23_visible(uuid,uuid)'::regprocedure)) = 0
  and position('_r23_visible__pre0383(p_org, p_uid)' in (select prosrc from pg_proc where oid = 'public._r23_visible(uuid,uuid)'::regprocedure)) > 0);
set client_min_messages = error;
\ir ../../supabase/migrations/0388_r213_bell_speed.sql
set client_min_messages = warning;
select pg_temp.res('13b ... and re-running 0388 brings the 0388 body back (chain still kept once as __pre0388, no __pre0388__pre0388)',
  position('r213-0388' in (select prosrc from pg_proc where oid = 'public._r23_visible(uuid,uuid)'::regprocedure)) > 0
  and to_regprocedure('public._r23_visible__pre0388__pre0388(uuid,uuid)') is null
  and position('r205-0383' in (select prosrc from pg_proc where oid = 'public._r23_visible__pre0388(uuid,uuid)'::regprocedure)) > 0);

select pg_temp.su();
do $$ declare n int; f int; r record; begin
  select count(*), count(*) filter (where result <> 'PASS') into n, f from _r213;
  for r in select * from _r213 where result <> 'PASS' loop raise warning '% -> %', r.name, r.result; end loop;
  if f = 0 then raise warning 'R213-BELL-SPEED-0388: ALL PASS (%/%)', n, n;
  else raise warning 'R213-BELL-SPEED-0388: % FAILED of %', f, n; end if;
end $$;
rollback;
