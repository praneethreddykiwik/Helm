-- r235-db-load-0401.sql - R235 (0401): the bell / badge / Home unread look at the last 90 days, the Inbox page builds
-- details for the shown page only, inbox actions check visibility without details, assign_tasks(_vendor)_once dedupe a
-- press sent twice, ten background jobs give up on a lock after 10 s.
--   A  SAME ANSWERS for the visible window: studio C (12 people, every role left after 0400, ~1,500 notifications of every kind, all in
--      the last 7 days, read / Done / snoozed / back from snooze / marked unread, mutes, switched-off types) - every answer
--      worked out twice in one transaction (0401 bodies, then the kept __pre0401 bodies put back): bell_feed 10 / 100 /
--      default, my_pending, inbox_feed (4 tabs, a group filter, page 2 by cursor) per person must be identical.
--   B  OLDER ROWS: 400 notifications 100-400 days old are added (some unread, one marked unread today, one back from a
--      snooze today). The bell + badge + Home unread leave out the old rows (except the two the person touched today) and
--      still agree with each other; the Inbox page still shows everything, identical to before (full history kept).
--   C  _r401_vis is exactly the live _r388_vis text plus the window (tripwire), and its rows = _r388_vis rows in the window.
--   D  request keys: same key -> the first answer (no second task, no second notification), different tasks with the same
--      key refused, no key = the old call, another person's key independent; vendor variant; grants / RLS.
--   F  the inbox digest job (every 5 min) picks the same rows from the bell window as from the whole inbox.
--   E  lock_timeout = 10s on the ten jobs; definer / empty search_path / grants; kept __pre0401 without app privilege.
-- Re-applies 0401 twice (second run changes nothing). Rolled back.
\set ON_ERROR_STOP 0
set client_min_messages = error;
-- everything below is ONE transaction, rolled back at the end (nothing is left behind for the later suites)
begin;
-- run-all.sh runs this suite FIRST, on the freshly migrated database (like a real one): later suites re-apply older
-- migrations (0036 / 0292 / 0293) outside their transactions and leave older bodies behind. 0401 again, twice:
\ir ../../supabase/migrations/0401_r235_db_load.sql
\ir ../../supabase/migrations/0401_r235_db_load.sql
set client_min_messages = warning;
create temp table _r235(name text, result text); grant all on _r235 to anon, authenticated, service_role;
create temp table _r235o(mode text, email text, call text, v jsonb); grant all on _r235o to anon, authenticated, service_role;
create or replace function pg_temp.su() returns void language plpgsql as $$
begin execute 'reset role'; perform auth.logout(); execute 'reset role'; end $$;
create or replace function pg_temp.login(p_email text) returns void language plpgsql as $$
declare u uuid; begin
  perform pg_temp.su(); select id into u from auth.users where email = p_email;
  perform set_config('request.jwt.claims', jsonb_build_object('sub', u, 'role', 'authenticated', 'email', p_email)::text, false);
  perform set_config('role', 'authenticated', false);
end $$;
create or replace function pg_temp.res(p_name text, p_ok boolean, p_detail text default '') returns void language plpgsql as $$
begin perform pg_temp.su(); insert into _r235 values (p_name, case when coalesce(p_ok, false) then 'PASS' else 'FAIL: '||coalesce(p_detail,'') end); end $$;
create or replace function pg_temp.try(p_sql text) returns jsonb language plpgsql as $$
declare v jsonb; begin execute p_sql into v; return v; exception when others then return jsonb_build_object('error', sqlstate); end $$;
grant execute on function pg_temp.try(text) to anon, authenticated, service_role;

select pg_temp.res('00 0401 applied twice: the bell window, inbox and request-key functions exist (second run = already)',
  to_regprocedure('public._r401_vis(uuid,uuid)') is not null and to_regprocedure('public._r401_rows(uuid,uuid)') is not null
  and to_regprocedure('public.assign_tasks_once(uuid,text,text[],uuid,text,text,uuid)') is not null
  and to_regprocedure('public.assign_tasks_vendor_once(uuid,text,text[],uuid,uuid)') is not null
  and (select count(*) from pg_proc p where p.oid in (to_regprocedure('public.bell_feed__pre0042(integer)'), to_regprocedure('public.bell_feed__pre0299(integer)'),
         to_regprocedure('public.my_pending()'), to_regprocedure('public.inbox_feed__pre0299(text,text,uuid,integer,text)'),
         to_regprocedure('public.inbox_act(uuid[],text,timestamp with time zone,text)'), to_regprocedure('public.inbox_read_all(text,uuid)'))
         and position('r235-0401' in p.prosrc) > 0) = 6
  and to_regprocedure('public.bell_feed__pre0042__pre0401__pre0401(integer)') is null
  and to_regclass('public.rpc_request_keys') is not null);

-- ---- seed studio C (deterministic ids; all rows inside the last 7 days) -----------------------------------------------
do $$
declare v_c uuid := 'c3000000-0000-4000-8000-000000000401'; v_a uuid := 'a0000000-0000-4000-8000-000000000001';
        roles text[] := array['admin','manager','planner','sales','sales','planner','supervisor','crew','worker','operations','supervisor','quality'];
        u uuid; i int; ids uuid[] := '{}'; a_admin uuid;
begin
  perform pg_temp.su();
  insert into public.organizations(id, name, currency, timezone, brand, plan, created_at)
    values (v_c, 'Studio C r235', 'INR', 'Asia/Kolkata', '{}'::jsonb, 'pro', now()) on conflict (id) do nothing;
  for i in 1..array_length(roles, 1) loop
    select id into u from auth.users where email = 'r235_' || i || '@c.test';
    if u is null then u := auth.seed_user('r235_' || i || '@c.test'); end if;
    insert into public.profiles(id, email, role, org_id, must_change_password, created_at)
      values (u, 'r235_' || i || '@c.test', roles[i], v_c, false, now())
      on conflict (id) do update set role = excluded.role, org_id = excluded.org_id;
    ids := ids || u;
  end loop;
  select id into a_admin from auth.users where email = 'a_admin@a.test';
  insert into public.role_access(role, area, can_view, can_edit, org_id, updated_at)
    select r, a, true, (r <> 'planner'), v_c, now()
      from (values ('sales'), ('manager'), ('planner')) rr(r), (values ('quotes'), ('finance'), ('proposal')) aa(a)
  on conflict (role, area, org_id) do nothing;
  insert into public.role_access(role, area, can_view, can_edit, org_id, updated_at) values
    ('planner', 'closure', true, false, v_c, now()), ('operations', 'closure', true, false, v_c, now())
  on conflict (role, area, org_id) do nothing;
  insert into public.quotes(id, code, title, status, client, pricing, current_version, approval_status, org_id, created_at, updated_at, event_date)
    select md5('r235q' || g)::uuid, 'C401-' || g, 'Event ' || g, 'quote', '{"name":"Client"}'::jsonb, '{"subtotal":100000,"discount":0,"gstPct":18,"total":118000}'::jsonb, 1, 'sent', v_c,
           now() - (g || ' days')::interval, now(), (now() + (g || ' days')::interval)::date
      from generate_series(1, 20) g
  on conflict (id) do nothing;
  set local session_replication_role = replica;   -- bulk test rows: no notification triggers (rolled back)
  insert into public.notifications(id, quote_id, channel, recipient, kind, status, detail, created_at, org_id)
  select md5('r235n' || g)::uuid,
         case when g % 5 = 0 then null else md5('r235q' || (1 + g % 20))::uuid end,
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
                               when g % 17 = 0 then '[]'::jsonb
                               when g % 19 = 0 then 'null'::jsonb end)) end,
         now() - ((g * 7) || ' minutes')::interval - make_interval(secs => g / 1000000.0), v_c
    from generate_series(1, 1500) g
    cross join lateral (select (array['task_assigned','task_update','task_reminder','task_due','design_update','approval_link','otp',
                                      'whatsapp_message','payment_link','payment_reminder','payment_receipt','advance_paid','chat_message',
                                      'other','price_change','pkg_payment','pkg_selected','client_link_viewed','client_view_followup',
                                      'event_close_request','event_close_decision','task_escalated','vendor_bill_due','team_signin',
                                      'security_alert','team_safety','studio_security','plan_active','wa_templates','inventory_low_stock',
                                      'payment_overdue','invoice_sent','refund_issued','budget_alert','quote_sent', null])[1 + (g * 7) % 36] as kind) k
  on conflict (id) do nothing;
  insert into public.notification_inbox_state(user_id, notification_id, org_id, read_at, unread_at, done_at, snoozed_until, snooze_returned_at, updated_at)
  select p.id, n.id, n.org_id,
         case when h % 5 = 0 then n.created_at + interval '1 minute' end,
         case when h % 29 = 0 then now() - interval '30 minutes' end,
         case when h % 11 = 1 then n.created_at + interval '2 minutes' end,
         case when h % 13 = 2 then now() + interval '1 day' when h % 7 = 3 then n.created_at + interval '1 minute' end,   -- back from a snooze: unique times (no ties)
         case when h % 17 = 4 then n.created_at + interval '90 seconds' end,
         now()
    from public.profiles p
    join public.notifications n on n.org_id = p.org_id
    cross join lateral (select abs(hashtext(p.id::text || n.id::text)) as h) hh
   where p.org_id = v_c and (h % 5 = 0 or h % 29 = 0 or h % 11 = 1 or h % 13 = 2 or h % 7 = 3 or h % 17 = 4)
  on conflict do nothing;
  set local session_replication_role = origin;
  insert into public.notification_seen(user_id, last_seen_at, org_id)
    select ids[k], now() - ((k * 37) || ' minutes')::interval, v_c from generate_series(1, 12) k where k % 4 <> 0
  on conflict (user_id) do update set last_seen_at = excluded.last_seen_at, org_id = excluded.org_id;
  delete from public.notification_seen where user_id in (ids[4], ids[8], ids[12]);
  insert into public.notification_mutes(user_id, org_id, type) values (ids[2], v_c, 'chat_message'), (ids[4], v_c, 'task_update'), (ids[8], v_c, 'other')
  on conflict do nothing;
  insert into public.notification_prefs(org_id, role, user_id, type, channel, enabled) values
    (v_c, 'crew', null, 'design_update', 'in_app', false), (v_c, 'sales', null, 'task_reminder', 'in_app', false)
  on conflict do nothing;
end $$;

-- fresh test rows: give the planner their numbers (a live database keeps these up to date by itself)
analyze public.notifications; analyze public.notification_inbox_state; analyze public.profiles; analyze public.notification_seen;

-- ---- every answer, per person -------------------------------------------------------------------------------------------
create or replace function pg_temp.collect(p_mode text) returns void language plpgsql as $$
declare r record; v jsonb; t text; c text;
begin
  for r in select u.id, u.email from auth.users u where u.email like 'r235\_%@c.test' order by u.email loop
    perform pg_temp.login(r.email);
    insert into _r235o values (p_mode, r.email, 'bell10', pg_temp.try('select public.bell_feed(10)'));
    insert into _r235o values (p_mode, r.email, 'bell100', pg_temp.try('select public.bell_feed(100)'));
    insert into _r235o values (p_mode, r.email, 'bell', pg_temp.try('select public.bell_feed()'));
    insert into _r235o values (p_mode, r.email, 'pending', pg_temp.try('select public.my_pending() - ''as_of'''));
    foreach t in array array['unread', 'all', 'done', 'snoozed'] loop
      v := pg_temp.try(format('select public.inbox_feed(%L, null, null, 40, null)', t));
      insert into _r235o values (p_mode, r.email, 'inbox_' || t, v);
      c := v ->> 'next_cursor';
      if c is not null then
        insert into _r235o values (p_mode, r.email, 'inbox_' || t || '_p2', pg_temp.try(format('select public.inbox_feed(%L, null, null, 40, %L)', t, c)));
      end if;
    end loop;
    insert into _r235o values (p_mode, r.email, 'inbox_tasks', pg_temp.try('select public.inbox_feed(''all'', ''tasks'', null, 100, null)'));
    insert into _r235o values (p_mode, r.email, 'inbox_quote', pg_temp.try(format('select public.inbox_feed(''all'', null, %L, 100, null)', md5('r235q3')::uuid)));
  end loop;
  perform pg_temp.su();
end $$;

-- the kept __pre0401 bodies back in place (= the answers before 0401), or the 0401 ones
create or replace function pg_temp.swap(p_old boolean) returns void language plpgsql as $$
declare f record;
begin
  for f in select * from (values ('bell_feed__pre0042', 'integer'), ('bell_feed__pre0299', 'integer'), ('my_pending', ''),
                              ('inbox_feed__pre0299', 'text,text,uuid,integer,text'),
                              ('inbox_act', 'uuid[],text,timestamp with time zone,text'), ('inbox_read_all', 'text,uuid')) x(n, a) loop
    if p_old then
      execute format('alter function public.%I(%s) rename to %I', f.n, f.a, f.n || '__r235new');
      execute format('alter function public.%I(%s) rename to %I', f.n || '__pre0401', f.a, f.n);
    else
      execute format('alter function public.%I(%s) rename to %I', f.n, f.a, f.n || '__pre0401');
      execute format('alter function public.%I(%s) rename to %I', f.n || '__r235new', f.a, f.n);
    end if;
  end loop;
  -- the page-facing one needs its signed-in grant while it is swapped in (the kept copy has none; rolled back)
  if p_old then execute 'grant execute on function public.my_pending() to authenticated';
  else execute 'revoke all on function public.my_pending__pre0401() from authenticated'; end if;
end $$;

select pg_temp.collect('new');
select pg_temp.swap(true);
select pg_temp.collect('old');
select pg_temp.swap(false);

do $$
declare n int; d int; ex text;
begin
  perform pg_temp.su();
  select count(*) into n from _r235o where mode = 'new';
  select count(*), min(o.email || ' ' || o.call) into d, ex
    from _r235o o left join _r235o x on x.email = o.email and x.call = o.call and x.mode = 'new'
   where o.mode = 'old' and (o.v is distinct from x.v);
  perform pg_temp.res('A1 every answer identical before / after 0401 for the visible window (12 people: bell 10 / 100 / default, my_pending, inbox 4 tabs + page 2 + group + event filter)',
    n >= 12 * 10 and d = 0 and (select count(*) from _r235o where mode = 'old') = n, format('%s answers, %s differ, first: %s', n, d, ex));
  perform pg_temp.res('A2 the answers are real: no error, the bell has rows, inbox page 2 exists, back-from-snooze rows in the bell, Done / snoozed counted',
    not exists (select 1 from _r235o where mode = 'new' and v ? 'error')
    and exists (select 1 from _r235o where mode = 'new' and call = 'bell10' and jsonb_array_length(v -> 'items') = 10)
    and exists (select 1 from _r235o where mode = 'new' and call like 'inbox_%_p2' and jsonb_array_length(v -> 'items') > 0)
    and exists (select 1 from _r235o o, jsonb_array_elements(o.v -> 'items') e where o.mode = 'new' and o.call = 'bell100' and (e ->> 'returned')::boolean)
    and exists (select 1 from _r235o where mode = 'new' and call = 'inbox_done' and (v -> 'counts' ->> 'done')::int > 0 and (v -> 'counts' ->> 'snoozed')::int > 0)
    and (select count(distinct v -> 'counts') from _r235o where mode = 'new' and call = 'inbox_all') >= 8);
  perform pg_temp.res('A3 inbox details still cleaned: money keys out for a person without Quotes view (crew), kept for admin; links / tokens out for all',
    not exists (select 1 from _r235o o, jsonb_array_elements(o.v -> 'items') e where o.mode = 'new' and o.call = 'inbox_all' and o.email = 'r235_8@c.test'
                 and jsonb_typeof(e -> 'detail') = 'object' and e -> 'detail' ?| array['amount', 'total', 'balance_due', 'Discount'])
    and exists (select 1 from _r235o o, jsonb_array_elements(o.v -> 'items') e where o.mode = 'new' and o.call = 'inbox_all' and o.email = 'r235_1@c.test'
                 and e -> 'detail' ? 'amount')
    and not exists (select 1 from _r235o o, jsonb_array_elements(o.v -> 'items') e where o.mode = 'new' and o.call like 'inbox_%'
                     and jsonb_typeof(e -> 'detail') = 'object' and e -> 'detail' ?| array['link', 'token', 'work_url']));
end $$;

-- inbox actions: the rows they may mark = the same rows as before (0401 reads _r388_vis / _r388_rows instead of the detail-building ones)
select pg_temp.res('A4 inbox_act / inbox_read_all read the same rows: _r388_vis ids = _r23_visible ids, _r388_rows = _r23_rows minus details, per person',
  (select bool_and(
      not exists ((select v.id from public._r388_vis(p.org_id, p.id) v) except all (select v.id from public._r23_visible(p.org_id, p.id) v))
      and not exists ((select v.id from public._r23_visible(p.org_id, p.id) v) except all (select v.id from public._r388_vis(p.org_id, p.id) v))
      and not exists ((select x.id, x.is_unread, x.ntype, x.kind, x.quote_id from public._r388_rows(p.org_id, p.id) x)
                      except all (select x.id, x.is_unread, x.ntype, x.kind, x.quote_id from public._r23_rows(p.org_id, p.id) x)))
     from public.profiles p where p.org_id = 'c3000000-0000-4000-8000-000000000401'));

-- inbox_act / inbox_read_all for real (savepoint-free: the answers of the new and the old body on the same starting state)
do $$
declare ids uuid[]; a jsonb; b jsonb;
begin
  perform pg_temp.login('r235_6@c.test');
  select array_agg(x.id) into ids from (select n.id from public.notifications n where n.org_id = 'c3000000-0000-4000-8000-000000000401' order by n.id limit 30) x;
  a := pg_temp.try(format('select public.inbox_act(%L::uuid[], ''done'', null, null)', ids));
  b := pg_temp.try(format('select public.inbox_act(%L::uuid[], ''undone'', null, null)', ids));
  perform pg_temp.res('A5 inbox_act on 30 ids (some not visible to a planner): marks only visible rows, answers counts',
    (a ->> 'changed')::int > 0 and (a ->> 'changed')::int < 30 and (a ->> 'changed') = (b ->> 'changed') and a ? 'counts',
    a::text || ' / ' || b::text);
end $$;

-- ---- B: older rows (100-400 days old) ------------------------------------------------------------------------------------
do $$
declare v_c uuid := 'c3000000-0000-4000-8000-000000000401'; adm uuid; a_admin uuid;
begin
  perform pg_temp.su();
  select id into adm from auth.users where email = 'r235_1@c.test';
  set local session_replication_role = replica;
  insert into public.notifications(id, quote_id, channel, kind, status, detail, created_at, org_id)
    select md5('r235old' || g)::uuid, md5('r235q' || (1 + g % 20))::uuid, 'in_app', (array['task_update','other','payment_receipt','task_assigned'])[1 + g % 4],
           'simulated', jsonb_build_object('message', 'old ' || g), now() - ((100 + g * 0.75) || ' days')::interval, v_c
      from generate_series(1, 400) g on conflict (id) do nothing;
  -- the admin marked one old row unread today, and one old row came back from a snooze today
  insert into public.notification_inbox_state(user_id, notification_id, org_id, unread_at, updated_at)
    values (adm, md5('r235old7')::uuid, v_c, now() - interval '1 hour', now()) on conflict do nothing;
  insert into public.notification_inbox_state(user_id, notification_id, org_id, snooze_returned_at, unread_at, updated_at)
    values (adm, md5('r235old9')::uuid, v_c, now() - interval '2 hours', now() - interval '2 hours', now()) on conflict do nothing;
  set local session_replication_role = origin;
  delete from public.notification_seen where user_id = adm;    -- "mark all read" never: every old row counts as unread before 0401
end $$;

-- fresh test rows: give the planner their numbers (a live database keeps these up to date by itself)
analyze public.notifications; analyze public.notification_inbox_state; analyze public.profiles; analyze public.notification_seen;
truncate _r235o;
select pg_temp.collect('new');
select pg_temp.swap(true);
select pg_temp.collect('old');
select pg_temp.swap(false);

do $$
declare b_new jsonb; b_old jsonb; p_new jsonb; ok boolean; v_cut timestamptz := public._r401_since();
begin
  perform pg_temp.su();
  select v into b_new from _r235o where mode = 'new' and email = 'r235_1@c.test' and call = 'bell100';
  select v into b_old from _r235o where mode = 'old' and email = 'r235_1@c.test' and call = 'bell100';
  select v into p_new from _r235o where mode = 'new' and email = 'r235_1@c.test' and call = 'pending';
  perform pg_temp.res('B1 the bell leaves out rows older than 90 days, except the two the person touched today (marked unread / back from snooze)',
    not exists (select 1 from jsonb_array_elements(b_new -> 'items') e
                 where (e ->> 'created_at')::timestamptz < v_cut and e ->> 'id' not in (md5('r235old7')::uuid::text, md5('r235old9')::uuid::text))
    and exists (select 1 from jsonb_array_elements(b_new -> 'items') e where e ->> 'id' = md5('r235old9')::uuid::text)
    and (b_old ->> 'unread')::int - (b_new ->> 'unread')::int between 390 and 400,
    format('old unread %s, new unread %s', b_old ->> 'unread', b_new ->> 'unread'));
  perform pg_temp.res('B2 badge = Home unread (bell_feed unread = my_pending unread) for every person, with old rows present',
    not exists (select 1 from _r235o b join _r235o p on p.email = b.email and p.mode = 'new' and p.call = 'pending'
                 where b.mode = 'new' and b.call = 'bell10' and (b.v ->> 'unread')::int <> (p.v ->> 'unread')::int));
  perform pg_temp.res('B3 the badge counts the old row marked unread today and the one back from a snooze (window = created OR touched in 90 days)',
    (b_new ->> 'unread')::int = (select count(*) from public._r23_rows('c3000000-0000-4000-8000-000000000401', (select id from auth.users where email = 'r235_1@c.test')) r
                                  where r.is_unread and (r.created_at >= v_cut or r.id in (md5('r235old7')::uuid, md5('r235old9')::uuid))));
  perform pg_temp.res('B4 the Inbox page still shows the whole history: every inbox answer identical before / after 0401 with the old rows',
    not exists (select 1 from _r235o o join _r235o x on x.email = o.email and x.call = o.call and x.mode = 'new'
                 where o.mode = 'old' and o.call like 'inbox_%' and o.v is distinct from x.v)
    and exists (select 1 from _r235o o, jsonb_array_elements(o.v -> 'items') e where o.mode = 'new' and o.call like 'inbox_all%'
                 and e ->> 'id' = md5('r235old300')::uuid::text) is not null);
  perform pg_temp.res('B5 the Inbox unread count still includes the old rows (nothing hidden there): inbox unread > bell unread for the admin',
    (select (v -> 'counts' ->> 'unread')::int from _r235o where mode = 'new' and email = 'r235_1@c.test' and call = 'inbox_unread') >= (b_new ->> 'unread')::int + 390);
end $$;

-- ---- F: the inbox digest job picks the same rows from the bell window (old rows present) ------------------------------------
do $$
declare v_c uuid := 'c3000000-0000-4000-8000-000000000401'; r record; d int := 0; n int := 0; picked int := 0; a uuid[]; b uuid[]; ex text;
begin
  perform pg_temp.su();
  for r in select p.id from public.profiles p where p.org_id = v_c loop
    -- daily digest selection (0266 / 0283 text), then the instant-important one: whole inbox vs the bell window
    select array_agg(z.id order by z.sort_at desc) into a from (select x.id, x.sort_at from public._r23_rows(v_c, r.id) x
      where x.is_unread and x.digested_at is null and x.sort_at <= now() - interval '60 minutes' and x.sort_at >= now() - interval '2 days'
      order by x.sort_at desc limit 20) z;
    select array_agg(z.id order by z.sort_at desc) into b from (select x.id, x.sort_at from public._r401_rows(v_c, r.id) x
      where x.is_unread and x.digested_at is null and x.sort_at <= now() - interval '60 minutes' and x.sort_at >= now() - interval '2 days'
      order by x.sort_at desc limit 20) z;
    n := n + 1; picked := picked + coalesce(array_length(a, 1), 0);
    if a is distinct from b then d := d + 1; ex := coalesce(ex, r.id::text || ' daily'); end if;
    select array_agg(z.id order by z.sort_at desc) into a from (select x.id, x.sort_at from public._r23_rows(v_c, r.id) x
      where x.is_unread and x.digested_at is null and public._r23_important(x.kind)
        and x.sort_at <= now() - interval '5 minutes' and x.sort_at >= now() - interval '1 day' order by x.sort_at desc limit 20) z;
    select array_agg(z.id order by z.sort_at desc) into b from (select x.id, x.sort_at from public._r401_rows(v_c, r.id) x
      where x.is_unread and x.digested_at is null and public._r23_important(x.kind)
        and x.sort_at <= now() - interval '5 minutes' and x.sort_at >= now() - interval '1 day' order by x.sort_at desc limit 20) z;
    if a is distinct from b then d := d + 1; ex := coalesce(ex, r.id::text || ' instant'); end if;
  end loop;
  perform pg_temp.res('F1 inbox digests: the rows picked (daily + instant-important) are identical from the whole inbox and from the bell window, every person',
    n >= 12 and d = 0 and picked > 0, format('%s people, %s differ (first %s), %s rows picked', n, d, ex, picked));
  perform pg_temp.res('F2 the old row back from a snooze 2 hours ago (created > 90 days ago) is still picked for the admin''s daily digest',
    exists (select 1 from public._r401_rows(v_c, (select id from auth.users where email = 'r235_1@c.test')) x
             where x.id = md5('r235old9')::uuid and x.is_unread and x.sort_at >= now() - interval '2 days'));
  perform pg_temp.res('F3 _r23_queue_digests reads the bell window (2 places, no whole-inbox read left); the old body kept as __pre0401 without app privilege',
    (select (length(prosrc) - length(replace(prosrc, 'public._r401_rows(o.id, p.id)', ''))) / length('public._r401_rows(o.id, p.id)')
       from pg_proc where oid = 'public._r23_queue_digests()'::regprocedure) = 2
    and position('_r23_rows(' in (select prosrc from pg_proc where oid = 'public._r23_queue_digests()'::regprocedure)) = 0
    and position('public._r23_rows(o.id, p.id)' in (select prosrc from pg_proc where oid = 'public._r23_queue_digests__pre0401()'::regprocedure)) > 0
    and not has_function_privilege('authenticated', 'public._r23_queue_digests__pre0401()', 'execute')
    and not has_function_privilege('service_role', 'public._r23_queue_digests__pre0401()', 'execute'));
end $$;

-- ---- C: the window copy cannot drift from the live rule --------------------------------------------------------------------
select pg_temp.res('C1 tripwire: _r401_vis / _r401_rows are exactly the live _r388_vis / _r388_rows text + the window (a change to _r388_vis must call _r401_sync())',
  pg_get_functiondef('public._r401_vis(uuid,uuid)'::regprocedure) = public._r401_vis_def()
  and pg_get_functiondef('public._r401_rows(uuid,uuid)'::regprocedure) = public._r401_rows_def());
select pg_temp.res('C2 _r401_vis rows = _r388_vis rows created in the window or touched by the person in it (every person, both studios)',
  (select bool_and(
      not exists ((select * from public._r401_vis(p.org_id, p.id))
                  except all
                  (select v.* from public._r388_vis(p.org_id, p.id) v
                    where v.created_at >= public._r401_since()
                       or exists (select 1 from public.notification_inbox_state st where st.user_id = p.id and st.notification_id = v.id
                                   and greatest(st.unread_at, st.snoozed_until, st.snooze_returned_at) >= public._r401_since())))
      and not exists ((select v.* from public._r388_vis(p.org_id, p.id) v
                        where v.created_at >= public._r401_since()
                           or exists (select 1 from public.notification_inbox_state st where st.user_id = p.id and st.notification_id = v.id
                                       and greatest(st.unread_at, st.snoozed_until, st.snooze_returned_at) >= public._r401_since()))
                      except all (select * from public._r401_vis(p.org_id, p.id))))
     from public.profiles p where p.org_id in ('c3000000-0000-4000-8000-000000000401', 'a0000000-0000-4000-8000-000000000001')));
select pg_temp.res('C3 less work: for the admin the window has fewer rows than the whole history (400 old rows left out)',
  (select count(*) from public._r401_rows('c3000000-0000-4000-8000-000000000401', (select id from auth.users where email = 'r235_1@c.test')))
  + 390 <= (select count(*) from public._r388_rows('c3000000-0000-4000-8000-000000000401', (select id from auth.users where email = 'r235_1@c.test'))));

-- ---- D: request keys ---------------------------------------------------------------------------------------------------------
do $$
declare v_q uuid; k uuid := '0401aaaa-0000-4000-8000-000000000001'; k2 uuid := '0401aaaa-0000-4000-8000-000000000002';
        r1 jsonb; r2 jsonb; r3 jsonb; r4 jsonb; r5 jsonb; n_t0 int; n_t1 int; n_t2 int; n_n0 int; n_n1 int; v_vendor uuid;
begin
  perform pg_temp.su();
  select id into v_q from public.quotes where org_id = 'a0000000-0000-4000-8000-000000000001' and deleted_at is null order by id limit 1;
  update public.quotes set deleted_at = null where id = v_q;
  delete from public.event_plan_locks where quote_id = v_q;
  select count(*) into n_t0 from public.event_tasks where quote_id = v_q;
  select count(*) into n_n0 from public.notifications where quote_id = v_q and kind = 'task_assigned';
  perform pg_temp.login('a_admin@a.test');
  r1 := pg_temp.try(format('select public.assign_tasks_once(%L, ''R235'', array[''Set up stage'', ''Lights''], null, ''Ravi'', ''+919800000401'', %L)', v_q, k));
  r2 := pg_temp.try(format('select public.assign_tasks_once(%L, ''R235'', array[''Set up stage'', ''Lights''], null, ''Ravi'', ''+919800000401'', %L)', v_q, k));
  perform pg_temp.su();
  select count(*) into n_t1 from public.event_tasks where quote_id = v_q;
  select count(*) into n_n1 from public.notifications where quote_id = v_q and kind = 'task_assigned';
  perform pg_temp.res('D1 the same key twice = ONE set of tasks + ONE notification; the second answer is the first one (+ replayed)',
    (r1 ->> 'tasks_created')::int = 2 and n_t1 = n_t0 + 2 and n_n1 = n_n0 + 1
    and (r2 - 'replayed') = r1 and (r2 ->> 'replayed')::boolean and not (r1 ? 'replayed'),
    format('r1 %s r2 %s tasks %s->%s notifications %s->%s', r1, r2, n_t0, n_t1, n_n0, n_n1));
  perform pg_temp.login('a_admin@a.test');
  r3 := pg_temp.try(format('select public.assign_tasks_once(%L, ''R235'', array[''Something else''], null, ''Ravi'', ''+919800000401'', %L)', v_q, k));
  r4 := pg_temp.try(format('select public.assign_tasks_once(%L, ''R235'', array[''Set up stage''], null, ''Ravi'', ''+919800000401'', %L)', v_q, k2));
  r5 := pg_temp.try(format('select public.assign_tasks_once(%L, ''R235'', array[''Set up stage''], null, ''Ravi'', ''+919800000401'', null)', v_q));
  perform pg_temp.su();
  select count(*) into n_t2 from public.event_tasks where quote_id = v_q;
  perform pg_temp.res('D2 the same key for different tasks is refused (22023); a new key creates again; no key = the old call (creates)',
    r3 ->> 'error' = '22023' and (r4 ->> 'tasks_created')::int = 1 and (r5 ->> 'tasks_created')::int = 1 and n_t2 = n_t1 + 2,
    format('r3 %s r4 %s r5 %s', r3, r4, r5));
  -- another person of the same studio with the same key: their own request (keys are per person)
  insert into public.profiles(id, email, role, org_id, must_change_password, created_at)
    select u.id, u.email, 'manager', 'a0000000-0000-4000-8000-000000000001', false, now() from auth.users u where u.email = 'r235_mgr@a.test'
  on conflict (id) do nothing;
  if not exists (select 1 from auth.users where email = 'r235_mgr@a.test') then
    perform auth.seed_user('r235_mgr@a.test');
    insert into public.profiles(id, email, role, org_id, must_change_password, created_at)
      select u.id, u.email, 'manager', 'a0000000-0000-4000-8000-000000000001', false, now() from auth.users u where u.email = 'r235_mgr@a.test'
    on conflict (id) do nothing;
  end if;
  perform pg_temp.login('r235_mgr@a.test');
  r1 := pg_temp.try(format('select public.assign_tasks_once(%L, ''R235'', array[''Set up stage'', ''Lights''], null, ''Ravi'', ''+919800000401'', %L)', v_q, k));
  perform pg_temp.su();
  perform pg_temp.res('D3 the same key from another person is that person''s own request (or refused by their own access) - never the first person''s answer',
    not coalesce((r1 ->> 'replayed')::boolean, false), r1::text);
  -- signed out / anon: no access to the new calls; the table is closed
  perform pg_temp.res('D4 assign_tasks(_vendor)_once: signed-in only (anon / public refused); rpc_request_keys: RLS on, no app privilege, no policy',
    has_function_privilege('authenticated', 'public.assign_tasks_once(uuid,text,text[],uuid,text,text,uuid)', 'execute')
    and has_function_privilege('authenticated', 'public.assign_tasks_vendor_once(uuid,text,text[],uuid,uuid)', 'execute')
    and not has_function_privilege('anon', 'public.assign_tasks_once(uuid,text,text[],uuid,text,text,uuid)', 'execute')
    and not has_function_privilege('anon', 'public.assign_tasks_vendor_once(uuid,text,text[],uuid,uuid)', 'execute')
    and (select relrowsecurity from pg_class where oid = 'public.rpc_request_keys'::regclass)
    and not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'rpc_request_keys')
    and not has_table_privilege('authenticated', 'public.rpc_request_keys', 'select') and not has_table_privilege('anon', 'public.rpc_request_keys', 'select')
    and not has_table_privilege('authenticated', 'public.rpc_request_keys', 'insert'));
  -- vendor variant
  v_vendor := 'a0000000-0000-4000-8000-0000000e4010';
  insert into public.vendors(id, org_id, name, phone) values (v_vendor, 'a0000000-0000-4000-8000-000000000001', 'R235 Vendor', '+919800000499')
    on conflict (id) do nothing;
  select count(*) into n_t0 from public.event_tasks where quote_id = v_q;
  perform pg_temp.login('a_admin@a.test');
  r1 := pg_temp.try(format('select public.assign_tasks_vendor_once(%L, ''R235'', array[''Flowers''], %L, %L)', v_q, v_vendor, k));
  r2 := pg_temp.try(format('select public.assign_tasks_vendor_once(%L, ''R235'', array[''Flowers''], %L, %L)', v_q, v_vendor, k));
  perform pg_temp.su();
  select count(*) into n_t1 from public.event_tasks where quote_id = v_q;
  perform pg_temp.res('D5 vendor variant: same key twice = one task, second answer = first (+ replayed); the key is per call name',
    (r1 ->> 'tasks_created')::int = 1 and n_t1 = n_t0 + 1 and (r2 - 'replayed') = r1 and (r2 ->> 'replayed')::boolean, format('r1 %s r2 %s', r1, r2));
  -- anon
  perform pg_temp.su(); perform auth.logout(); set local role anon;
  r1 := pg_temp.try(format('select public.assign_tasks_once(%L, ''R235'', array[''X''], null, ''Ravi'', ''+919800000401'', %L)', v_q, k2));
  perform pg_temp.su();
  perform pg_temp.res('D6 signed out: refused', r1 ->> 'error' = '42501', r1::text);
end $$;

-- the other "create + send" presses: ping a task's person, nudge a client, payment reminder now
do $$
declare v_t uuid; k uuid := '0401bbbb-0000-4000-8000-000000000001'; r1 jsonb; r2 jsonb; r3 jsonb; n0 int; n1 int;
begin
  perform pg_temp.su();
  select id into v_t from public.event_tasks where org_id = 'a0000000-0000-4000-8000-000000000001' order by id limit 1;
  select count(*) into n0 from public.notifications where org_id = 'a0000000-0000-4000-8000-000000000001';
  perform pg_temp.login('a_admin@a.test');
  r1 := pg_temp.try(format('select public.event_task_remind_bell_once(%L, %L)', v_t, k));
  r2 := pg_temp.try(format('select public.event_task_remind_bell_once(%L, %L)', v_t, k));
  r3 := pg_temp.try(format('select public.event_task_remind_bell_once(%L, null)', v_t));
  perform pg_temp.su();
  select count(*) into n1 from public.notifications where org_id = 'a0000000-0000-4000-8000-000000000001';
  perform pg_temp.res('D7 event_task_remind_bell_once: same key twice = the first answer (+ replayed); no key = the old call (same answer shape)',
    not (r1 ? 'error') and (r2 - 'replayed') = r1 and (r2 ->> 'replayed')::boolean and not (r3 ? 'replayed') and not (r3 ? 'error')
    and n1 - n0 <= 2, format('r1 %s r2 %s r3 %s new notifications %s', r1, r2, r3, n1 - n0));
  perform pg_temp.res('D8 link_view_nudge_once / payment_reminder_send_now_once: signed-in only, wrap the old calls',
    has_function_privilege('authenticated', 'public.link_view_nudge_once(uuid,text,uuid)', 'execute')
    and has_function_privilege('authenticated', 'public.payment_reminder_send_now_once(uuid,uuid)', 'execute')
    and not has_function_privilege('anon', 'public.link_view_nudge_once(uuid,text,uuid)', 'execute')
    and not has_function_privilege('anon', 'public.payment_reminder_send_now_once(uuid,uuid)', 'execute')
    and not has_function_privilege('anon', 'public.event_task_remind_bell_once(uuid,uuid)', 'execute')
    and position('public.link_view_nudge(p_quote, p_channel)' in (select prosrc from pg_proc where oid = 'public.link_view_nudge_once(uuid,text,uuid)'::regprocedure)) > 0
    and position('public.payment_reminder_send_now(p_milestone)' in (select prosrc from pg_proc where oid = 'public.payment_reminder_send_now_once(uuid,uuid)'::regprocedure)) > 0);
  perform pg_temp.res('D9 the time zone names copy holds every name the server knows (a studio zone never needs the slow pg_timezone_names read)',
    not exists (select 1 from pg_catalog.pg_timezone_names z where not exists (select 1 from public._r358_tz_names t where t.name = z.name)));
end $$;

-- ---- E: jobs, rules of the house ---------------------------------------------------------------------------------------------
select pg_temp.res('E1 ten background jobs carry lock_timeout=10s on the function (role / database settings untouched)',
  (select count(*) from pg_proc p where p.oid in (to_regprocedure('public.quote_stage_sweep(integer)'), to_regprocedure('public.link_views_tick()'),
       to_regprocedure('public.apply_link_expiry_archive_all()'), to_regprocedure('public.discard_empty_drafts_all()'),
       to_regprocedure('public.event_ready_alert_tick()'), to_regprocedure('public.team_safety_tick()'), to_regprocedure('public.pay_details_tick()'),
       to_regprocedure('public.inbox_tick()'), to_regprocedure('public.runsheet_reminders_tick()'), to_regprocedure('public.comms_tick()'))
     and p.proconfig @> array['lock_timeout=10s']) = 10
  and not exists (select 1 from pg_db_role_setting s where array_to_string(s.setconfig, ',') like '%lock_timeout=10s%'));
select pg_temp.res('E2 new + patched functions: security definer, empty search_path (except the plain _r401_since); helpers server only',
  (select bool_and(p.prosecdef and coalesce(p.proconfig, '{}') @> array['search_path=""']
                   and not has_function_privilege('anon', p.oid, 'execute'))
     from pg_proc p where p.oid in ('public._r401_vis(uuid,uuid)'::regprocedure, 'public._r401_rows(uuid,uuid)'::regprocedure,
       'public._r401_keep(regprocedure)'::regprocedure, 'public._r401_patch(regprocedure,text,text[],text[])'::regprocedure,
       'public._r401_vis_def()'::regprocedure, 'public._r401_rows_def()'::regprocedure, 'public._r401_sync()'::regprocedure,
       'public._r401_key_get(text,uuid,text)'::regprocedure, 'public._r401_key_put(text,uuid,text,jsonb)'::regprocedure,
       'public.assign_tasks_once(uuid,text,text[],uuid,text,text,uuid)'::regprocedure, 'public.assign_tasks_vendor_once(uuid,text,text[],uuid,uuid)'::regprocedure,
       'public.event_task_remind_bell_once(uuid,uuid)'::regprocedure, 'public.link_view_nudge_once(uuid,text,uuid)'::regprocedure,
       'public.payment_reminder_send_now_once(uuid,uuid)'::regprocedure,
       'public.bell_feed__pre0042(integer)'::regprocedure, 'public.bell_feed__pre0299(integer)'::regprocedure, 'public.my_pending()'::regprocedure,
       'public.inbox_feed__pre0299(text,text,uuid,integer,text)'::regprocedure))
  and (select bool_and(not has_function_privilege('authenticated', p.oid, 'execute'))
     from pg_proc p where p.oid in ('public._r401_vis(uuid,uuid)'::regprocedure, 'public._r401_rows(uuid,uuid)'::regprocedure,
       'public._r401_keep(regprocedure)'::regprocedure, 'public._r401_patch(regprocedure,text,text[],text[])'::regprocedure,
       'public._r401_sync()'::regprocedure, 'public._r401_key_get(text,uuid,text)'::regprocedure, 'public._r401_key_put(text,uuid,text,jsonb)'::regprocedure,
       'public._r401_since()'::regprocedure))
  and has_function_privilege('authenticated', 'public.bell_feed(integer)', 'execute') and has_function_privilege('authenticated', 'public.my_pending()', 'execute')
  and has_function_privilege('authenticated', 'public.inbox_feed(text,text,uuid,integer,text)', 'execute'));
select pg_temp.res('E3 old bodies kept once as __pre0401 with no app privilege (6), still the 0388 / 0293 / 0266 bodies',
  (select count(*) from pg_proc p where p.oid in (to_regprocedure('public.bell_feed__pre0042__pre0401(integer)'), to_regprocedure('public.bell_feed__pre0299__pre0401(integer)'),
       to_regprocedure('public.my_pending__pre0401()'), to_regprocedure('public.inbox_feed__pre0299__pre0401(text,text,uuid,integer,text)'),
       to_regprocedure('public.inbox_act__pre0401(uuid[],text,timestamp with time zone,text)'), to_regprocedure('public.inbox_read_all__pre0401(text,uuid)'))
     and not has_function_privilege('authenticated', p.oid, 'execute') and not has_function_privilege('anon', p.oid, 'execute')
     and not has_function_privilege('service_role', p.oid, 'execute') and position('r235-0401' in p.prosrc) = 0) = 6
  and position('r213-0388' in (select prosrc from pg_proc where oid = 'public.bell_feed__pre0042__pre0401(integer)'::regprocedure)) > 0);
select pg_temp.res('E4 the older checker markers still hold on the patched bodies (r163-0357 bell base list, r23-inbox-0266 inbox layer, r52-notif-0293 my_pending)',
  position('r163-0357' in (select prosrc from pg_proc where oid = 'public.bell_feed__pre0042(integer)'::regprocedure)) > 0
  and position('r23-inbox-0266' in (select prosrc from pg_proc where oid = 'public.bell_feed__pre0299(integer)'::regprocedure)) > 0
  and position('r52-notif-0293' in (select prosrc from pg_proc where oid = 'public.my_pending()'::regprocedure)) > 0
  and position('r23-inbox-0266' in (select prosrc from pg_proc where oid = 'public.inbox_feed__pre0299(text,text,uuid,integer,text)'::regprocedure)) > 0);
-- re-running 0388 (as its own suite does) leaves the 0401 bodies alone (they keep the r213-0388 marker, so 0388 sees them as done)
set client_min_messages = error;
\ir ../../supabase/migrations/0388_r213_bell_speed.sql
set client_min_messages = warning;
select pg_temp.res('E5 re-running 0388 after 0401 leaves the 0401 bell bodies in place (they keep the r213-0388 marker, so 0388 sees them as done)',
  position('r235-0401' in (select prosrc from pg_proc where oid = 'public.bell_feed__pre0042(integer)'::regprocedure)) > 0
  and position('r235-0401' in (select prosrc from pg_proc where oid = 'public.bell_feed__pre0299(integer)'::regprocedure)) > 0);

select pg_temp.su();
do $$ declare n int; f int; r record; begin
  select count(*), count(*) filter (where result <> 'PASS') into n, f from _r235;
  for r in select * from _r235 where result <> 'PASS' loop raise warning '% -> %', r.name, r.result; end loop;
  if f = 0 then raise warning 'R235-DB-LOAD-0401: ALL PASS (%/%)', n, n;
  else raise warning 'R235-DB-LOAD-0401: % FAILED of %', f, n; end if;
end $$;
rollback;
