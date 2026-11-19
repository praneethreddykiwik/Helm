-- r232-probe-0400.sql - used by r232-remove-role-traces-0400.sh, run once BEFORE and once AFTER APPLY-0400.
-- Prints "key|value" lines describing how every OTHER role behaves: access matrix + has_area per login, invitations,
-- role changes, a new studio's matrix, a new free trial (matrix + sample staff), the escalation ladder (who is told at
-- each step, e-mails, bell, activity log), sign-in notice settings, closure / restore approvers, bell visibility, role
-- labels. The step name of the first escalation step is printed as L1 (it was "coordinator", it is now "lead").
-- Everything it writes is rolled back. Local disposable PG only.
\set ON_ERROR_STOP 1
set client_min_messages = error;
begin;
create temp table _p(k text, v text); grant all on _p to anon, authenticated, service_role;
create or replace function pg_temp.su() returns void language plpgsql as $$
begin execute 'reset role'; perform auth.logout(); execute 'reset role'; end $$;
create or replace function pg_temp.login(p_email text) returns void language plpgsql as $$
declare u uuid; begin
  perform pg_temp.su(); select id into u from auth.users where email = p_email;
  perform set_config('request.jwt.claims', jsonb_build_object('sub', u, 'role', 'authenticated', 'email', p_email, 'aal', 'aal2',
    'amr', jsonb_build_array(jsonb_build_object('method', 'totp', 'timestamp', extract(epoch from now())::bigint)))::text, false);
  perform set_config('role', 'authenticated', false);
end $$;
create or replace function pg_temp.v(p_sql text) returns text language plpgsql as $$
declare r text; begin
  begin execute p_sql into r; return 'ok:' || coalesce(r, '<null>');
  exception when others then return 'err:' || sqlstate; end;
end $$;
grant execute on function pg_temp.v(text) to anon, authenticated, service_role;
create or replace function pg_temp.put(p_k text, p_v text) returns void language plpgsql as $$
begin execute 'reset role'; insert into _p values (p_k, p_v); end $$;
create or replace function pg_temp.lv(t text) returns text language sql immutable as $$
  select replace(replace(replace(coalesce(t, ''), '"coordinator"', '"L1"'), '"lead"', '"L1"'), 'event lead', 'L1') $$;
-- a settings object with the two removed roles taken out of its role list (what 0400 does to saved lists)
create or replace function pg_temp.nr(c jsonb, k text) returns jsonb language sql immutable as $$
  select case when jsonb_typeof(c -> k) = 'array' then jsonb_set(c, array[k], (select coalesce(jsonb_agg(x), '[]'::jsonb)
           from jsonb_array_elements(c -> k) x where x #>> '{}' not in ('coordinator', 'designer'))) else c end $$;
create temp table _who as
  select u.email, u.id from auth.users u join public.profiles p on p.id = u.id
   where p.org_id = 'a0000000-0000-4000-8000-000000000001' order by u.email;
grant select on _who to anon, authenticated, service_role;
create temp table _areas as select distinct area from public.role_access where org_id = 'a0000000-0000-4000-8000-000000000001'
  union select 'tasks' order by 1;
grant select on _areas to anon, authenticated, service_role;

-- 1) the access matrix of the two studios, every other role
select pg_temp.put('matrix ' || o.name || ' ' || ra.role || ' ' || ra.area, ra.can_view::text || '/' || ra.can_edit::text)
  from public.role_access ra join public.organizations o on o.id = ra.org_id
 where ra.org_id in ('a0000000-0000-4000-8000-000000000001', 'b0000000-0000-4000-8000-000000000001')
   and ra.role not in ('coordinator', 'designer');

-- 2) what each login of studio A may see / change (has_area), its role and label
do $$ declare w record; a record; r text; begin
  for w in select * from _who loop
    for a in select area from _areas loop
      perform pg_temp.login(w.email);
      r := pg_temp.v(format('select public.has_area(%L, ''view'')::text || ''/'' || public.has_area(%L, ''edit'')::text', a.area, a.area));
      perform pg_temp.put('has_area ' || w.email || ' ' || a.area, r);
    end loop;
    perform pg_temp.login(w.email);
    r := pg_temp.v('select public.user_role()');
    perform pg_temp.put('role ' || w.email, r);
    perform pg_temp.login(w.email);
    r := pg_temp.v('select public._r22_can_approve()::text');
    perform pg_temp.put('closure approve ' || w.email, r);
    perform pg_temp.login(w.email);
    r := pg_temp.v('select public._a260_can_restore()::text');
    perform pg_temp.put('restore ' || w.email, r);
    perform pg_temp.su();
    perform pg_temp.put('bell rows ' || w.email, (select count(*)::text from public._r388_vis('a0000000-0000-4000-8000-000000000001', w.id)));
  end loop;
end $$;

-- 3) invitations + role changes by the admin, for every other role
do $$ declare r text; x text; n int := 0; begin
  foreach x in array array['admin', 'manager', 'planner', 'sales', 'supervisor', 'quality', 'operations', 'client'] loop   -- crew: re-enabled by 0400 (tested on its own)
    n := n + 1;
    perform pg_temp.login('a_admin@a.test');
    r := pg_temp.v(format('select (public.create_invitation(%L, %L) ->> ''role'')', 'r232inv' || n || '@x.test', x));
    perform pg_temp.put('invite ' || x, r);
  end loop;
  foreach x in array array['manager', 'planner', 'sales', 'supervisor', 'quality', 'operations'] loop
    perform pg_temp.login('a_admin@a.test');
    r := pg_temp.v(format('select (public.team_set_role((select id from auth.users where email = ''r232_qa@a.test''), %L))::text', x));
    perform pg_temp.put('team_set_role ' || x, regexp_replace(r, '"(at|updated_at|effective_at|id)": "[^"]*"', '', 'g'));
  end loop;
  perform pg_temp.su();
  update public.profiles set role = 'quality' where email = 'r232_qa@a.test';
end $$;

-- 4) a new studio and a new free trial: their access matrix (without the studio id) + the trial's sample staff
do $$ declare u uuid; r jsonb; o uuid; begin
  perform pg_temp.su();
  u := auth.seed_user('r232_new@x.test');
  insert into public.profiles(id, email, role, org_id, must_change_password, created_at) values (u, 'r232_new@x.test', 'admin', null, false, now())
    on conflict (id) do update set role = 'admin', org_id = null;
  perform pg_temp.login('r232_new@x.test');
  r := public.start_self_serve_trial('R232 Trial', 'Asia/Kolkata', 'INR', 'demo');
  perform pg_temp.su();
  o := (r ->> 'org_id')::uuid;
  perform pg_temp.put('trial matrix ' || ra.role || ' ' || ra.area, ra.can_view::text || '/' || ra.can_edit::text)
     from public.role_access ra where ra.org_id = o;
  -- the built-in trial extras' sample designer: role words "Designer" before, "Design lead" after (printed as R1)
  perform pg_temp.put('trial staff ' || c.name, case when c.role in ('Designer', 'Design lead') then 'R1' else coalesce(c.role, '<none>') end
                      || ' / ' || coalesce(c.department, ''))
     from public.crew_members c where c.org_id = o;
  insert into public.organizations(id, name, currency, timezone, plan, created_at)
    values ('d2320000-0000-4000-8000-000000000001', 'R232 New Studio', 'INR', 'Asia/Kolkata', 'pro', now());
  perform public._a49_seed_clean_matrix('d2320000-0000-4000-8000-000000000001');
  perform public._a143_seed_role_defaults('d2320000-0000-4000-8000-000000000001');
  perform pg_temp.put('new studio matrix ' || ra.role || ' ' || ra.area, ra.can_view::text || '/' || ra.can_edit::text)
     from public.role_access ra where ra.org_id = 'd2320000-0000-4000-8000-000000000001';
end $$;

-- 5) sign-in notices, role lists and labels
select pg_temp.put('signin cfg A', pg_temp.nr(public._r383_cfg('a0000000-0000-4000-8000-000000000001') - 'updated_at', 'roles')::text);
select pg_temp.put('signin cfg B', pg_temp.nr(public._r383_cfg('b0000000-0000-4000-8000-000000000001') - 'updated_at', 'roles')::text);
select pg_temp.put('ready cfg A', pg_temp.nr(public._r396_cfg('a0000000-0000-4000-8000-000000000001') - 'updated_at', 'notify_roles')::text);
select pg_temp.put('notify roles', array_to_string(public._notify_roles(), ','));
select pg_temp.put('signin roles', array_to_string(public._r383_roles_all(), ','));
select pg_temp.put('label ' || x, public._a106_role_label(x) || ' / ' || public._r383_role_label(x) || ' / ' || public._valid_role(x)::text)
  from unnest(array['admin', 'manager', 'planner', 'sales', 'supervisor', 'quality', 'operations', 'crew', 'worker', 'client']) x;
select pg_temp.put('closure approvers A', (select string_agg(u.email, ',' order by u.email)
  from jsonb_array_elements_text(public._r22_approver_ids('a0000000-0000-4000-8000-000000000001')) i join auth.users u on u.id = i::uuid));

-- 6) the escalation ladder: a special task not started at its start time, steps at +0 / +5 / +10 minutes
delete from public.task_escalation_settings where org_id = 'a0000000-0000-4000-8000-000000000001';
create temp table _t as select date_trunc('minute', now()) + interval '3 hours' as t;
insert into public.event_tasks (id, quote_id, org_id, category, title, crew_id, assignee_name, assignee_phone, status, planned_start, remind_before, is_special, remind_every_min)
  values ('a0000000-0000-4000-8000-0000000f2321', 'a0000000-0000-4000-8000-00000000da01', 'a0000000-0000-4000-8000-000000000001', 'Guests', 'R232 probe task',
          'a0000000-0000-4000-8000-0000000c2321', 'R232 Desk', '+91 90000 23211', 'assigned', (select t from _t), '{}', true, 5);
select public.task_reminder_tick((select t from _t));
select public.task_reminder_tick((select t from _t) + interval '5 minutes');
select public.task_reminder_tick((select t from _t) + interval '10 minutes');
select pg_temp.put('esc step ' || s.step, s.status || ' ' || pg_temp.lv(to_jsonb(s.level)::text) || ' ' ||
         (select string_agg(pg_temp.lv(e ->> 'name' || ':' || to_jsonb(e ->> 'level')::text || ':' || (e ->> 'emailed')), ',' order by e ->> 'name')
            from jsonb_array_elements(s.recipients) e))
  from public.task_escalation_steps s where s.task_id = 'a0000000-0000-4000-8000-0000000f2321';
select pg_temp.put('esc mail ' || o.recipient, count(*)::text)
  from public.staff_email_outbox o where o.task_id = 'a0000000-0000-4000-8000-0000000f2321' group by o.recipient;
select pg_temp.put('esc bell ' || (n.detail ->> 'step'), pg_temp.lv(to_jsonb(n.detail ->> 'level')::text) || ' ' ||
         (select string_agg(u.email, ',' order by u.email) from jsonb_array_elements_text(n.detail -> 'notify') i join auth.users u on u.id = i::uuid)
         || ' ' || pg_temp.lv(regexp_replace(n.detail ->> 'label', 'Escalated to coordinator', 'Escalated to L1')))
  from public.notifications n where n.kind = 'task_escalated' and n.detail ->> 'task_id' = 'a0000000-0000-4000-8000-0000000f2321';
select pg_temp.put('esc log ' || (l.detail ->> 'step'), pg_temp.lv(to_jsonb(l.detail ->> 'level')::text))
  from public.event_task_log l where l.task_id = 'a0000000-0000-4000-8000-0000000f2321' and l.kind = 'escalated';
select pg_temp.put('esc bell seen by ' || w.email, (select count(*)::text from public._r388_vis('a0000000-0000-4000-8000-000000000001', w.id) v where v.kind = 'task_escalated'))
  from _who w;

select k || '|' || v from _p order by k, v;
rollback;
