-- r208-task-assign-0385.sql - 0385: "Assign & send tasks" (area 'tasks') - who may give out work on events.
-- Proves, on Studio A seeded with the pre-0385 default matrix (an existing studio):
--   BEFORE vs AFTER for every default role: the task gate was has_area('staff','edit'); after 0385 the same roles keep
--   it and the ONLY role that gains is the Supervisor (nobody loses access); the only rows written are one
--   ('supervisor','tasks') per studio whose Supervisor sees Staff; a second run writes nothing.
--   Supervisor: assign (in-house), reassign, start time, special, reminders (minutes + exact times), cancel, e-mail,
--   hold, WhatsApp, the person's link, the event's links, run triggers / reminders - none refused as "not authorized".
--   Supervisor still refused: open shifts (pay), approve days off, new staff links, staff availability, crew rows /
--   task rows written directly (RLS unchanged), money (finance / business / event money header), another studio.
--   The 'tasks' row decides once saved (switched off = refused again, also for a manager who keeps Staff edit); it needs
--   Staff - Can see; a crew login never qualifies; sales (no row, no Staff edit) refused; admin always; anon no execute.
--   Matrix: _r300_area_ok knows 'tasks', admin_set_role_access saves it (audit row), a non-admin cannot.
--   New studios: seeding adds the 'tasks' rows (Staff edit roles + supervisor); _a49_default_matrix unchanged (0239 fingerprint).
--   Bodies: each patched call carries one r208-0385 check, no Staff-edit check left, definer / search_path / grants kept.
-- Re-applies 0385 twice inside the transaction. Rolled back.
\set ON_ERROR_STOP 0
set client_min_messages = error;
\ir ../../supabase/migrations/0385_r208_task_assign_access.sql
\ir ../../supabase/migrations/0385_r208_task_assign_access.sql
set client_min_messages = warning;
begin;
create temp table _t385(name text, result text); grant all on _t385 to anon, authenticated, service_role;
create temp table _b385(role text, email text, before_gate boolean, after_norow boolean); grant all on _b385 to anon, authenticated, service_role;
create or replace function pg_temp.su() returns void language plpgsql as $$
begin execute 'reset role'; perform set_config('request.jwt.claims', '', false); end $$;
create or replace function pg_temp.login(p_email text) returns void language plpgsql as $$
declare u uuid; begin
  perform pg_temp.su(); select id into u from auth.users where email = p_email;
  perform set_config('request.jwt.claims', jsonb_build_object('sub', u, 'role', 'authenticated', 'email', p_email, 'aal', 'aal1')::text, false);
  perform set_config('role', 'authenticated', false);
end $$;
create or replace function pg_temp.anon() returns void language plpgsql as $$
begin perform pg_temp.su(); perform set_config('request.jwt.claims', '{"role":"anon"}', false); perform set_config('role', 'anon', false); end $$;
create or replace function pg_temp.res(p_name text, p_ok boolean, p_detail text default '') returns void language plpgsql as $$
begin insert into _t385 values (p_name, case when coalesce(p_ok, false) then 'PASS' else 'FAIL: '||coalesce(p_detail,'') end); end $$;
create or replace function pg_temp.try(p_sql text) returns text language plpgsql as $$
begin execute p_sql; return '';
exception when others then return sqlstate || ' | ' || sqlerrm; end $$;
create or replace function pg_temp.val(p_sql text) returns text language plpgsql as $$
declare r text; begin execute p_sql into r; return r;
exception when others then return 'ERR ' || sqlstate || ' | ' || sqlerrm; end $$;
grant execute on function pg_temp.try(text) to anon, authenticated, service_role;
grant execute on function pg_temp.val(text) to anon, authenticated, service_role;
-- "refused as not authorized" = 42501 (any other error is a business rule AFTER the access check passed)
-- the helper is server-only (no execute for app roles): read it through a definer shim, as the patched calls do
create or replace function pg_temp.can_assign() returns boolean language sql security definer as $$ select public._r385_can_assign() $$;
grant execute on function pg_temp.can_assign() to anon, authenticated, service_role;
create or replace function pg_temp.denied(e text) returns boolean language sql as $$ select coalesce(e, '') like '42501%' $$;

-- ---- setup: Studio A as an existing studio (the pre-0385 default matrix), one person per default role -----------------
do $$
declare
  orgA uuid := 'a0000000-0000-4000-8000-000000000001'; orgB uuid := 'b0000000-0000-4000-8000-000000000001';
  r text; u uuid;
begin
  perform pg_temp.su();
  foreach r in array array['manager', 'planner', 'coordinator', 'supervisor', 'operations', 'quality', 'crew'] loop
    select id into u from auth.users where email = 'r385_' || r || '@a.test';
    if u is null then u := auth.seed_user('r385_' || r || '@a.test'); end if;
    insert into public.profiles(id, email, role, org_id, must_change_password, created_at)
      values (u, 'r385_' || r || '@a.test', r, orgA, false, now())
      on conflict (id) do update set role = excluded.role, org_id = excluded.org_id;
  end loop;
  select id into u from auth.users where email = 'r385_supervisor@b.test';
  if u is null then u := auth.seed_user('r385_supervisor@b.test'); end if;
  insert into public.profiles(id, email, role, org_id, must_change_password, created_at)
    values (u, 'r385_supervisor@b.test', 'supervisor', orgB, false, now())
    on conflict (id) do update set role = excluded.role, org_id = excluded.org_id;
  -- the default matrix as a studio has it before 0385: the template rows, no 'tasks' rows
  perform public._a49_seed_clean_matrix(orgA);
  perform public._a49_seed_clean_matrix(orgB);
  delete from public.role_access where area = 'tasks';
  -- the 'sales' fixture person (a_staff) keeps the template sales rows
  insert into _b385(role, email) values ('admin', 'a_admin@a.test'), ('sales', 'a_staff@a.test'),
    ('manager', 'r385_manager@a.test'), ('planner', 'r385_planner@a.test'), ('coordinator', 'r385_coordinator@a.test'),
    ('supervisor', 'r385_supervisor@a.test'), ('operations', 'r385_operations@a.test'), ('quality', 'r385_quality@a.test'),
    ('crew', 'r385_crew@a.test');
end $$;

-- BEFORE: the old gate (word for word) and the new helper with no 'tasks' row yet, per role
do $$
declare x record; b boolean; a boolean;
begin
  for x in select role, email from _b385 loop
    perform pg_temp.login(x.email);
    b := coalesce(public.has_area('staff', 'edit'), false);
    perform pg_temp.su();
    perform pg_temp.login(x.email);
    a := pg_temp.can_assign();
    perform pg_temp.su();
    update _b385 set before_gate = b, after_norow = a where role = x.role;
  end loop;
end $$;
do $$ begin perform pg_temp.su(); end $$;
create temp table _rows_before as select org_id, role, area, can_view, can_edit from public.role_access;

-- the 0385 data step on this studio (as the owner pastes it), twice
set client_min_messages = error;
\ir ../../supabase/migrations/0385_r208_task_assign_access.sql
create temp table _rows_once as select org_id, role, area, can_view, can_edit from public.role_access;
\ir ../../supabase/migrations/0385_r208_task_assign_access.sql
set client_min_messages = warning;

do $$
declare
  orgA uuid := 'a0000000-0000-4000-8000-000000000001'; orgB uuid := 'b0000000-0000-4000-8000-000000000001';
  qa uuid := 'a0000000-0000-4000-8000-00000000da01'; qb uuid := 'b0000000-0000-4000-8000-00000000da01';
  p1 text := '+919385000001'; p2 text := '+919385000002';
  c1 uuid; c2 uuid; cb uuid; ven uuid; t1 uuid; t2 uuid; t3 uuid; tb uuid; cw uuid;
  e text; v text; x record; ok boolean; d text; n int; n0 int; f text;
  v_after jsonb := '{}'::jsonb;
begin
  perform pg_temp.su();
  insert into public.crew_members(name, phone, org_id, active, email) values ('R385 One', p1, orgA, true, 'r385.one@a.test') returning id into c1;
  insert into public.crew_members(name, phone, org_id, active) values ('R385 Two', p2, orgA, true) returning id into c2;
  insert into public.crew_members(name, phone, org_id, active) values ('R385 B', '+919385000009', orgB, true) returning id into cb;
  insert into public.vendors(name, org_id) values ('R385 Lights', orgA) returning id into ven;
  insert into public.event_tasks(quote_id, org_id, category, title, seq, crew_id, assignee_name, assignee_phone, status)
    values (qa, orgA, 'Decor', 'R385 t1', 1, c1, 'R385 One', p1, 'assigned') returning id into t1;
  insert into public.event_tasks(quote_id, org_id, category, title, seq, crew_id, assignee_name, assignee_phone, status)
    values (qa, orgA, 'Decor', 'R385 t2', 2, c1, 'R385 One', p1, 'assigned') returning id into t2;
  insert into public.event_tasks(quote_id, org_id, category, title, seq, crew_id, assignee_name, assignee_phone, status)
    values (qa, orgA, 'Decor', 'R385 t3', 3, c1, 'R385 One', p1, 'assigned') returning id into t3;
  insert into public.event_tasks(quote_id, org_id, category, title, seq, crew_id, assignee_name, assignee_phone, status)
    values (qb, orgB, 'Decor', 'R385 tb', 1, cb, 'R385 B', '+919385000009', 'assigned') returning id into tb;

  -- (1) before / after per role
  perform pg_temp.res('01 before 0385 the task gate (Staff edit) = admin, manager, planner, coordinator, operations',
    (select string_agg(role, ',' order by role) from _b385 where before_gate) = 'admin,coordinator,manager,operations,planner',
    (select string_agg(role || '=' || before_gate, ' ' order by role) from _b385));
  perform pg_temp.res('02 with no tasks row the new helper equals the old gate for EVERY role (word for word)',
    not exists (select 1 from _b385 where after_norow is distinct from before_gate),
    (select string_agg(role || ':' || before_gate || '/' || after_norow, ' ') from _b385));
  for x in select role, email, before_gate from _b385 loop
    perform pg_temp.login(x.email);
    ok := pg_temp.can_assign();
    perform pg_temp.su();
    v_after := v_after || jsonb_build_object(x.role, ok);
  end loop;
  perform pg_temp.res('03 after 0385 nobody lost the task gate', not exists (select 1 from _b385 b where b.before_gate and not (v_after ->> b.role)::boolean), v_after::text);
  perform pg_temp.res('04 after 0385 the ONLY role that gained it is the Supervisor',
    (select string_agg(b.role, ',') from _b385 b where not b.before_gate and (v_after ->> b.role)::boolean) = 'supervisor', v_after::text);
  perform pg_temp.res('05 rows written: one (supervisor, tasks, on) per studio whose Supervisor sees Staff, nothing else added or changed',
    (select count(*) from _rows_once o where not exists (select 1 from _rows_before b where b.org_id = o.org_id and b.role = o.role and b.area = o.area))
      = (select count(*) from _rows_before b where b.role = 'supervisor' and b.area = 'staff' and b.can_view)
    and exists (select 1 from _rows_once o where o.org_id = orgA and o.role = 'supervisor' and o.area = 'tasks' and o.can_view and o.can_edit)
    and not exists (select 1 from _rows_once o where not exists (select 1 from _rows_before b where b.org_id = o.org_id and b.role = o.role and b.area = o.area)
                      and not (o.role = 'supervisor' and o.area = 'tasks' and o.can_view and o.can_edit))
    and not exists (select 1 from _rows_before b join _rows_once o using (org_id, role, area)
                     where (b.can_view, b.can_edit) is distinct from (o.can_view, o.can_edit)),
    (select string_agg(o.org_id::text || ':' || o.role || ':' || o.area, ' ') from _rows_once o
      where not exists (select 1 from _rows_before b where b.org_id = o.org_id and b.role = o.role and b.area = o.area)));
  perform pg_temp.res('06 second run wrote nothing',
    (select count(*) from public.role_access) = (select count(*) from _rows_once)
    and not exists (select 1 from public.role_access r join _rows_once o using (org_id, role, area) where (r.can_view, r.can_edit) is distinct from (o.can_view, o.can_edit)), '');

  -- (2) the Supervisor can give out work on an event of its own studio
  perform pg_temp.login('r385_supervisor@a.test');
  v := pg_temp.val(format('select public.assign_tasks(%L, ''Lighting'', array[''R385 new''], %L, ''R385 Two'', %L)::text', qa, c2, p2));
  perform pg_temp.su();
  perform pg_temp.res('07 supervisor: + Add & assign works (task created for the person)',
    v like '%tasks_created%' and exists (select 1 from public.event_tasks where quote_id = qa and title = 'R385 new' and crew_id = c2), v);
  perform pg_temp.login('r385_supervisor@a.test');
  e := pg_temp.try(format('select public.reassign_task(%L, %L, ''R385 Two'', %L)', t1, c2, p2));
  perform pg_temp.su();
  perform pg_temp.res('08 supervisor: reassign works', e = '' and (select crew_id from public.event_tasks where id = t1) = c2, e);
  perform pg_temp.login('r385_supervisor@a.test');
  e := pg_temp.try(format('select public.set_task_schedule(%L, now() + interval ''2 days'', now() + interval ''2 days 2 hours'', null)', t2));
  perform pg_temp.su();
  perform pg_temp.res('09 supervisor: set the start / end time', e = '' and (select planned_start is not null from public.event_tasks where id = t2), e);
  perform pg_temp.login('r385_supervisor@a.test');
  e := pg_temp.try(format('select public.set_task_special(%L, true, 5)', t2));
  perform pg_temp.su();
  perform pg_temp.res('10 supervisor: mark special', e = '' and (select is_special from public.event_tasks where id = t2), e);
  perform pg_temp.login('r385_supervisor@a.test');
  d := pg_temp.try(format('select public.set_task_reminders(%L, array[30])', t2))
    || ' / ' || pg_temp.try(format('select public.set_task_reminder_times(%L, array[now() + interval ''1 day'']::timestamptz[])', t2));
  perform pg_temp.su();
  perform pg_temp.res('11 supervisor: reminders (minutes before + exact times) not refused', d not like '%42501%', d);
  perform pg_temp.login('r385_supervisor@a.test');
  d := pg_temp.try(format('select public.staff_email_send(%L, true)', t2)) || ' / ' || pg_temp.try(format('select public.staff_email_hold(%L, %L)', qa, c1))
    || ' / ' || pg_temp.try(format('select public.staff_whatsapp_send(%L)', t2)) || ' / ' || pg_temp.try(format('select public.staff_link_get(%L)', c1))
    || ' / ' || pg_temp.try(format('select public.run_task_triggers(%L)', qa)) || ' / ' || pg_temp.try(format('select public.run_task_reminders(%L)', qa));
  perform pg_temp.su();
  perform pg_temp.res('12 supervisor: e-mail / hold / WhatsApp / person link / run triggers + reminders not refused', d not like '%42501%', d);
  perform pg_temp.login('r385_supervisor@a.test');
  n := (select count(*) from public.work_links_for_event(qa));
  perform pg_temp.su();
  perform pg_temp.res('13 supervisor: the event''s task links are listed (were none with Staff - Can see only)', n >= 1, n::text);
  perform pg_temp.login('r385_supervisor@a.test');
  e := pg_temp.try(format('select public.assign_tasks_vendor(%L, ''Lighting'', array[''R385 vendor''], %L)', qa, ven));
  perform pg_temp.su();
  perform pg_temp.res('14 supervisor: give work to a vendor not refused', not pg_temp.denied(e), e);
  perform pg_temp.login('r385_supervisor@a.test');
  e := pg_temp.try(format('select public.cancel_task(%L, ''client moved it'')', t3));
  perform pg_temp.su();
  perform pg_temp.res('15 supervisor: cancel with a reason', e = '' and (select status from public.event_tasks where id = t3) = 'cancelled', e);

  -- (3) ... and nothing beyond task work
  perform pg_temp.login('r385_supervisor@a.test');
  d := pg_temp.try(format('select public.open_shift_post(%L, ''Waiter'', current_date + 3, null, null, 900, ''day'', 1, null, null, null, null)', qa));
  e := pg_temp.try(format('select public.staff_link_regenerate(%L)', c1));
  v := pg_temp.try(format('select public.crew_availability_set(%L, current_date + 5, ''unavailable'', null)', c1));
  perform pg_temp.su();
  perform pg_temp.res('16 supervisor still refused: open shifts (pay), new staff links, staff availability',
    pg_temp.denied(d) and pg_temp.denied(e) and pg_temp.denied(v), d || ' / ' || e || ' / ' || v);
  perform pg_temp.login('r385_supervisor@a.test');
  e := pg_temp.try(format('select public.cantwork_decide(%L, ''approve'', null)', gen_random_uuid()));
  perform pg_temp.su();
  perform pg_temp.res('17 supervisor still cannot approve days off (cantwork_decide)', pg_temp.denied(e), e);
  perform pg_temp.login('r385_supervisor@a.test');
  e := pg_temp.try(format('insert into public.crew_members(name, phone, org_id, active) values (''R385 X'', ''+919385000077'', %L, true)', orgA));
  update public.event_tasks set title = 'R385 hacked' where id = t2;
  get diagnostics n = row_count;
  perform pg_temp.su();
  perform pg_temp.res('18 RLS unchanged: no crew rows, no direct task row writes for the supervisor',
    e <> '' and n = 0 and (select title from public.event_tasks where id = t2) = 'R385 t2', e || ' rows=' || n);
  perform pg_temp.login('r385_supervisor@a.test');
  ok := coalesce(public.has_area('finance', 'view'), false) or coalesce(public.has_area('settlement', 'view'), false)
     or coalesce(public.has_area('closure', 'view'), false) or coalesce(public.has_area('business', 'view'), false);
  d := pg_temp.try('select public.vendor_payables_summary()') || ' / ' || pg_temp.try(format('select public.event_money_header(%L)', qa));
  perform pg_temp.su();
  perform pg_temp.res('19 supervisor never sees money (finance / settlement / closure / business off, money calls refused or empty)',
    not ok and d not like '%"quoted"%' and split_part(d, ' / ', 1) like '42501%', d);
  perform pg_temp.login('r385_supervisor@b.test');
  e := pg_temp.try(format('select public.assign_tasks(%L, ''Lighting'', array[''R385 cross''], %L, ''R385 One'', %L)', qa, c1, p1));
  v := pg_temp.try(format('select public.cancel_task(%L, ''cross studio'')', t2));
  perform pg_temp.su();
  perform pg_temp.res('20 another studio''s supervisor cannot touch Studio A''s event or tasks',
    e <> '' and v <> '' and not exists (select 1 from public.event_tasks where title = 'R385 cross')
    and (select status from public.event_tasks where id = t2) = 'assigned', e || ' / ' || v);

  -- (4) the switch decides once saved; it needs Staff - Can see; never a crew login
  update public.role_access set can_view = false, can_edit = false where org_id = orgA and role = 'supervisor' and area = 'tasks';
  perform pg_temp.login('r385_supervisor@a.test');
  e := pg_temp.try(format('select public.set_task_special(%L, false, 5)', t2));
  perform pg_temp.su();
  perform pg_temp.res('21 Assign & send tasks switched off -> supervisor refused again', pg_temp.denied(e), e);
  update public.role_access set can_view = true, can_edit = true where org_id = orgA and role = 'supervisor' and area = 'tasks';
  update public.role_access set can_view = false, can_edit = false where org_id = orgA and role = 'supervisor' and area = 'staff';
  perform pg_temp.login('r385_supervisor@a.test');
  e := pg_temp.try(format('select public.set_task_special(%L, false, 5)', t2));
  perform pg_temp.su();
  perform pg_temp.res('22 on, but Staff - Can see off -> refused (the dependency is enforced)', pg_temp.denied(e), e);
  update public.role_access set can_view = true where org_id = orgA and role = 'supervisor' and area = 'staff';
  insert into public.role_access(org_id, role, area, can_view, can_edit, updated_at) values (orgA, 'manager', 'tasks', false, false, now());
  perform pg_temp.login('r385_manager@a.test');
  e := pg_temp.try(format('select public.set_task_special(%L, false, 5)', t2));
  ok := coalesce(public.has_area('staff', 'edit'), false);
  perform pg_temp.su();
  perform pg_temp.res('23 a saved tasks row decides: manager with Staff edit but Assign off is refused', pg_temp.denied(e) and ok, e);
  update public.role_access set can_view = true, can_edit = true where org_id = orgA and role = 'manager' and area = 'tasks';
  perform pg_temp.login('r385_manager@a.test');
  e := pg_temp.try(format('select public.set_task_special(%L, false, 5)', t2));
  perform pg_temp.su();
  perform pg_temp.res('24 ... and allowed again when switched on', e = '', e);
  insert into public.role_access(org_id, role, area, can_view, can_edit, updated_at) values (orgA, 'crew', 'tasks', true, true, now())
    on conflict (org_id, role, area) do update set can_view = true, can_edit = true;
  insert into public.role_access(org_id, role, area, can_view, can_edit, updated_at) values (orgA, 'crew', 'staff', true, false, now())
    on conflict (org_id, role, area) do update set can_view = true;
  perform pg_temp.login('r385_crew@a.test');
  e := pg_temp.try(format('select public.set_task_special(%L, false, 5)', t2));
  perform pg_temp.su();
  perform pg_temp.res('25 a crew login never qualifies, even with the switch on', pg_temp.denied(e), e);
  perform pg_temp.login('a_staff@a.test');
  e := pg_temp.try(format('select public.assign_tasks(%L, ''Lighting'', array[''R385 sales''], %L, ''R385 One'', %L)', qa, c1, p1));
  perform pg_temp.su();
  perform pg_temp.res('26 sales (no tasks row, no Staff edit) still refused', pg_temp.denied(e), e);
  perform pg_temp.login('a_admin@a.test');
  ok := pg_temp.can_assign();
  perform pg_temp.su();
  perform pg_temp.anon();
  e := pg_temp.try(format('select public.assign_tasks(%L, ''Lighting'', array[''R385 anon''], %L, ''R385 One'', %L)', qa, c1, p1));
  perform pg_temp.su();
  perform pg_temp.res('27 admin always; anon has no execute', ok and pg_temp.denied(e)
    and not has_function_privilege('anon', 'public._r385_can_assign()', 'execute')
    and not has_function_privilege('authenticated', 'public._r385_can_assign()', 'execute'), e);

  -- (5) the matrix screen can save it; audit logged; non-admin refused
  delete from public.role_access where org_id = orgA and role = 'quality' and area = 'tasks';
  n0 := (select count(*) from public.audit_log where entity = 'role_access');
  perform pg_temp.login('a_admin@a.test');
  e := pg_temp.try('select public.admin_set_role_access(''quality'', ''tasks'', true, true)');
  perform pg_temp.su();
  perform pg_temp.res('28 admin saves Assign & send tasks for a role (known area, audit row written)',
    e = '' and (select can_view and can_edit from public.role_access where org_id = orgA and role = 'quality' and area = 'tasks')
    and (select count(*) from public.audit_log where entity = 'role_access') > n0, e);
  perform pg_temp.login('r385_manager@a.test');
  e := pg_temp.try('select public.admin_set_role_access(''supervisor'', ''tasks'', false, false)');
  perform pg_temp.su();
  perform pg_temp.res('29 a non-admin cannot change the matrix', pg_temp.denied(e)
    and (select can_edit from public.role_access where org_id = orgA and role = 'supervisor' and area = 'tasks'), e);
  perform pg_temp.res('30 _r300_area_ok knows tasks (list kept: leads, users, audit still known; nonsense refused)',
    public._r300_area_ok('tasks') and public._r300_area_ok('leads') and public._r300_area_ok('audit') and not public._r300_area_ok('Tasks; drop'), '');

  -- (6) new studios: the template is unchanged (0239 still recognises it); seeding a studio adds the tasks rows
  insert into public.organizations(id, name, currency, timezone, brand, plan, created_at)
    values ('c3850000-0000-4000-8000-000000000001', 'R385 New Studio', 'INR', 'Asia/Kolkata', '{}'::jsonb, 'pro', now());
  perform public._a49_seed_clean_matrix('c3850000-0000-4000-8000-000000000001');
  perform pg_temp.res('31 new studio: Assign & send tasks on for admin, manager, planner, coordinator, supervisor, operations - off for the rest',
    (select string_agg(role, ',' order by role) from public.role_access
      where org_id = 'c3850000-0000-4000-8000-000000000001' and area = 'tasks' and can_view and can_edit)
      = 'admin,coordinator,manager,operations,planner,supervisor'
    and (select count(*) from public.role_access where org_id = 'c3850000-0000-4000-8000-000000000001' and area = 'tasks') = 11
    and not exists (select 1 from public.role_access where org_id = 'c3850000-0000-4000-8000-000000000001' and area = 'tasks'
                     and role in ('quality', 'sales', 'crew', 'worker', 'client') and (can_view or can_edit)), '');
  perform pg_temp.res('32 new studio: every other row is the unchanged 0239 template (the 0239 fingerprint still matches; supervisor money / staff edit off)',
    (select md5(string_agg(d.role || ':' || d.area || ':' || d.can_view::text || ':' || d.can_edit::text, ','
                           order by d.role collate "C", d.area collate "C"))
       from public._a49_default_matrix() d where d.area <> 'business') = '498843f8c0669cf38703f30824776d86'
    and not exists (select 1 from public._a49_default_matrix() where area = 'tasks')
    and (select count(*) from public.role_access r join public._a49_default_matrix() d using (role, area)
          where r.org_id = 'c3850000-0000-4000-8000-000000000001' and (r.can_view, r.can_edit) is distinct from (d.can_view, d.can_edit)) = 0
    and not exists (select 1 from public.role_access where org_id = 'c3850000-0000-4000-8000-000000000001' and role = 'supervisor'
                     and area in ('finance', 'settlement', 'closure', 'business') and can_view)
    and exists (select 1 from public.role_access where org_id = 'c3850000-0000-4000-8000-000000000001' and role = 'supervisor'
                 and area = 'staff' and can_view and not can_edit), '');

  -- (7) bodies + privileges
  ok := true; d := '';
  foreach f in array array['public.assign_tasks(uuid,text,text[],uuid,text,text)', 'public.assign_tasks_vendor(uuid,text,text[],uuid)',
      'public._r311_reassign_task(uuid,uuid,text,text)', 'public.reassign_task__pre0311(uuid,uuid,text,text)', 'public.cancel_task(uuid,text)',
      'public.set_task_schedule(uuid,timestamptz,timestamptz,uuid)', 'public.set_task_special(uuid,boolean,integer)',
      'public.set_task_reminders(uuid,integer[])', 'public.set_task_reminder_times(uuid,timestamptz[])', 'public.run_task_triggers(uuid)',
      'public.run_task_reminders(uuid)', 'public.staff_email_send(uuid,boolean)', 'public.staff_email_hold(uuid,uuid)',
      'public.staff_whatsapp_send(uuid)', 'public.staff_link_get(uuid)', 'public.work_links_for_event(uuid)'] loop
    v := pg_get_functiondef(to_regprocedure(f));
    if (length(v) - length(replace(v, 'r208-0385', ''))) / 9 <> 1 or v ~ 'has_area\(''staff'', ?''edit''\)' then ok := false; d := d || f || ' '; end if;
  end loop;
  perform pg_temp.res('33 each patched call: exactly one r208-0385 check, no Staff-edit check left', ok, d);
  perform pg_temp.res('34 still definer; the 0311 / 0312 / 0361 markers kept; signed-in callers keep execute where they had it',
    (select bool_and(p.prosecdef) from pg_proc p where p.pronamespace = 'public'::regnamespace and pg_get_functiondef(p.oid) like '%r208-0385%')
    and position('r96-cancel-task-0312' in pg_get_functiondef('public.cancel_task(uuid,text)'::regprocedure)) > 0
    and has_function_privilege('authenticated', 'public.assign_tasks(uuid,text,text[],uuid,text,text)', 'execute')
    and has_function_privilege('authenticated', 'public.staff_email_send(uuid,boolean)', 'execute')
    and has_function_privilege('authenticated', 'public.work_links_for_event(uuid)', 'execute')
    and not has_function_privilege('anon', 'public.staff_email_send(uuid,boolean)', 'execute'), '');
  perform pg_temp.res('35 NOT patched (still Staff - Can change): open shifts, days off, new links, availability, check-in site',
    (select bool_and(position('r208-0385' in pg_get_functiondef(to_regprocedure(g))) = 0) from unnest(array[
      'public.staff_link_regenerate(uuid)', 'public._r370_can_decide()', 'public.crew_availability_set(uuid,date,text,text)',
      'public.open_shift_decide(uuid,boolean,text)', 'public.event_checkin_site_set(uuid,double precision,double precision,integer)']) g), '');
  perform pg_temp.res('36 RLS policies unchanged (event_tasks / crew_members still Staff edit to write)',
    (select count(*) from pg_policy where polrelid = 'public.event_tasks'::regclass and pg_get_expr(polqual, polrelid) like '%r385%') = 0
    and exists (select 1 from pg_policy where polrelid = 'public.event_tasks'::regclass and polcmd = 'w'
                 and pg_get_expr(polqual, polrelid) like '%has_area(''staff''::text, ''edit''::text)%'), '');
end $$;

do $$ begin perform pg_temp.su(); end $$;
select name, result from _t385 order by name;
select case when count(*) filter (where result <> 'PASS') = 0
            then 'R208-TASK-ASSIGN-0385: ALL PASS (' || count(*) || '/' || count(*) || ')'
            else 'R208-TASK-ASSIGN-0385: FAILURES ' || count(*) filter (where result <> 'PASS') || '/' || count(*) end as summary from _t385;
rollback;
