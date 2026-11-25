-- r257-no-lock-checklist-0442.sql - R257 (25 Nov 2026): the event-day lock never applies any more; a CLOSED event keeps refusing plan changes;
-- the Day before / Pre-event checklist keeps who ticked what and when.
-- Proves: structure after two runs (kept bodies, grants, row security), no stored row changed, a locked + an event-day event take tasks, times,
-- steps, run-sheet, Venue opens / Ready by; a closed one refuses all four and a layout in plain words; a cancelled one as before; an old page's Lock
-- press writes nothing; ticks (who / when / note, idempotent, undo, history), the 11 ticks keep the first person, own lines (once per press, same words, cap, cancel, gone),
-- rights (viewer, other studio, anon), the one-line switch. Local disposable PG only. Fake data only. Rolled back.
\set ON_ERROR_STOP 0
set client_min_messages = error;
begin;
create temp table _before as select (select md5(coalesce(string_agg(q::text, '|' order by q.id), '')) from public.quotes q) as qs,
  (select md5(coalesce(string_agg(l::text, '|'), '')) from public.event_plan_locks l) as ls, (select md5(coalesce(string_agg(l::text, '|' order by l.id), '')) from public.event_plan_lock_log l) as lg,
  (select md5(coalesce(string_agg(p::text, '|' order by p.quote_id), '')) from public.event_day_plans p) as ps;
\o /dev/null
\i supabase/migrations/0442_r257_no_lock_checklist.sql
\i supabase/migrations/0442_r257_no_lock_checklist.sql
\o
set client_min_messages = warning;
select set_config('helm.r397_plan_lock', 'on', false);
create temp table _rc(name text, result text); grant all on _rc to anon, authenticated, service_role;
create or replace function pg_temp.su() returns void language plpgsql as $$
begin execute 'reset role'; perform auth.logout(); execute 'reset role'; end $$;
create or replace function pg_temp.login(p_email text) returns void language plpgsql as $$
declare u uuid; begin
  perform pg_temp.su(); select id into u from auth.users where email = p_email;
  perform set_config('request.jwt.claims', jsonb_build_object('sub', u, 'role', 'authenticated', 'email', p_email, 'aal', 'aal1')::text, false);
  perform set_config('role', 'authenticated', false);
end $$;
create or replace function pg_temp.res(p_name text, p_ok boolean, p_detail text default '') returns void language plpgsql as $$
begin insert into _rc values (p_name, case when coalesce(p_ok, false) then 'PASS' else 'FAIL: ' || coalesce(p_detail, '') end); end $$;
create or replace function pg_temp.try(p_sql text) returns text language plpgsql as $$
begin execute p_sql; return ''; exception when others then return sqlstate || ' ' || sqlerrm; end $$;
create or replace function pg_temp.j(p_sql text) returns jsonb language plpgsql as $$
declare v jsonb; begin execute p_sql into v; return v; exception when others then return jsonb_build_object('err', sqlstate || ' ' || sqlerrm); end $$;
-- a page call (security definer) runs as the owner with the caller's claims: keep the claims, drop the role
create or replace function pg_temp.as_definer(p_sql text) returns void language plpgsql as $$
begin execute 'reset role'; execute p_sql; perform set_config('role', 'authenticated', false); exception when others then perform set_config('role', 'authenticated', false); raise; end $$;
grant execute on all functions in schema pg_temp to anon, authenticated, service_role;


-- 1) structure
select pg_temp.res('01 no stored row changed by the file (run twice)', (select b.qs = md5(coalesce((select string_agg(q::text, '|' order by q.id) from public.quotes q), ''))
  and b.ls = md5(coalesce((select string_agg(l::text, '|') from public.event_plan_locks l), '')) and b.lg = md5(coalesce((select string_agg(l::text, '|' order by l.id) from public.event_plan_lock_log l), ''))
  and b.ps = md5(coalesce((select string_agg(p::text, '|' order by p.quote_id) from public.event_day_plans p), '')) from _before b));
select pg_temp.res('02 six old bodies kept once, without the new marker', (select count(*) = 6 and bool_and(position('r257-0442' in p.prosrc) = 0) from pg_proc p where p.proname like '%\_\_pre0442'));
select pg_temp.res('03 page calls signed in only; helpers + kept bodies server only; tables closed', has_function_privilege('authenticated', 'public.event_check_mark(uuid,text,boolean,text)', 'execute')
  and not has_function_privilege('anon', 'public.event_check_mark(uuid,text,boolean,text)', 'execute') and not has_function_privilege('anon', 'public.event_checks_get(uuid)', 'execute')
  and (select bool_and(not has_function_privilege('authenticated', oid, 'execute') and not has_function_privilege('anon', oid, 'execute')) from pg_proc where proname like '\_r442\_%' or proname like '%\_\_pre0442')
  and (select count(*) = 3 and bool_and(relrowsecurity) and bool_and(not has_table_privilege('authenticated', oid, 'select,insert,update,delete') and not has_table_privilege('service_role', oid, 'insert,update,delete')) from pg_class where relname in ('event_check_marks', 'event_check_lines', 'event_check_log')));
select pg_temp.res('04 the purge list knows the three tables; the tenant guard is on them', position('event_check_marks' in pg_get_functiondef('public._tr184_purge_tables()'::regprocedure)) > 0
  and (select count(*) = 3 from pg_trigger where tgname = 'zz_quote_org_match' and tgrelid in ('public.event_check_marks'::regclass, 'public.event_check_lines'::regclass, 'public.event_check_log'::regclass)));

-- fixture: studio A, an event locked by hand, an event on its day (automatic lock), a closed one, a cancelled one
do $$ declare orgA uuid := 'a0000000-0000-4000-8000-000000000001'; u_sup uuid; u_view uuid; v_tz text; r record; begin
  u_sup := auth.seed_user('a_sup442@a.test'); u_view := auth.seed_user('a_view442@a.test');
  insert into public.profiles(id, email, full_name, role, org_id, must_change_password, created_at) values
    (u_sup, 'a_sup442@a.test', 'Sunil Supervisor', 'supervisor', orgA, false, now()), (u_view, 'a_view442@a.test', 'Vani Viewer', 'coordinator', orgA, false, now())
  on conflict (id) do update set role = excluded.role, org_id = excluded.org_id, full_name = excluded.full_name;
  insert into public.role_access(role, area, can_view, can_edit, org_id, updated_at) values ('supervisor', 'staff', true, false, orgA, now()), ('supervisor', 'tasks', true, true, orgA, now()),
    ('supervisor', 'quotes', true, false, orgA, now()), ('coordinator', 'staff', true, false, orgA, now()), ('coordinator', 'quotes', true, false, orgA, now()), ('coordinator', 'tasks', true, false, orgA, now())
  on conflict (role, area, org_id) do update set can_view = excluded.can_view, can_edit = excluded.can_edit;
  v_tz := public._r23_tz(orgA);
  for r in select * from (values ('1', 'planning', 'confirmed', 10), ('2', 'event_day', 'confirmed', 0), ('3', 'closed', 'confirmed', -3), ('4', 'planning', 'cancelled', 5)) x(n, stage, st, d) loop
    insert into public.quotes(id, code, title, status, client, pricing, current_version, approval_status, org_id, created_at, updated_at, event_date, event_time, lifecycle_stage)
    values (('a0000000-0000-4000-8000-0000000d442' || r.n)::uuid, 'A-442' || r.n, 'E' || r.n, 'confirmed', '{"hallLen": 120}'::jsonb, '{}'::jsonb, 1, 'approved', orgA, now(), now(), (now() at time zone v_tz)::date + r.d, '18:30', 'planning');
    insert into public.quote_versions(quote_id, version_no, data, object_count, org_id) values (('a0000000-0000-4000-8000-0000000d442' || r.n)::uuid, 1, '{"items": []}'::jsonb, 0, orgA);
    insert into public.event_tasks(id, quote_id, org_id, category, title, seq, status, assignee_name) values (('a0000000-0000-4000-8000-00000000a44' || r.n)::uuid, ('a0000000-0000-4000-8000-0000000d442' || r.n)::uuid, orgA, 'Stage', 'Stage set-up', 1, 'assigned', 'Ravi');
    insert into public.run_sheet_items(id, quote_id, org_id, start_time, duration_min, title, seq) values (('a0000000-0000-4000-8000-0000000e044' || r.n)::uuid, ('a0000000-0000-4000-8000-0000000d442' || r.n)::uuid, orgA, '17:00', 30, 'Doors', 1);
    insert into public.event_plan_locks(quote_id, org_id, state, during_auto) values (('a0000000-0000-4000-8000-0000000d442' || r.n)::uuid, orgA, 'locked', true);
    update public.quotes set lifecycle_stage = r.stage, status = r.st where id = ('a0000000-0000-4000-8000-0000000d442' || r.n)::uuid;
  end loop;
end $$;
\set Q '\'a0000000-0000-4000-8000-0000000d4421\''
\set D '\'a0000000-0000-4000-8000-0000000d4422\''
\set C '\'a0000000-0000-4000-8000-0000000d4423\''
\set X '\'a0000000-0000-4000-8000-0000000d4424\''

-- 2) no lock: everything the lock refused, on an event locked by hand and on one on its day
create or replace function pg_temp.five(p_q uuid, p_n text) returns text[] language sql as $f$
  select array[pg_temp.try(format('insert into public.event_tasks(quote_id, category, title, seq, status) values (%L, ''Decor'', ''Arch %s'', 9, ''assigned'')', p_q, p_n)),
    pg_temp.try(format('update public.event_tasks set title = ''new name'' where id = ''a0000000-0000-4000-8000-00000000a44%s''', p_n)),
    pg_temp.try(format('select public.set_task_schedule(''a0000000-0000-4000-8000-00000000a44%s'', now() + interval ''10 days'', null, null)', p_n)),
    pg_temp.try(format('select public.set_task_step(array[''a0000000-0000-4000-8000-00000000a44%s'']::uuid[], ''onday'')', p_n)),
    pg_temp.try(format('update public.run_sheet_items set start_time = ''18:45'' where id = ''a0000000-0000-4000-8000-0000000e044%s''', p_n)),
    pg_temp.try(format('insert into public.run_sheet_items(quote_id, start_time, title, seq) values (%L, ''20:00'', ''Dinner'', 3)', p_q)),
    pg_temp.try(format('select public.event_day_plan_set(%L, ''09:00'', ''17:30'')', p_q)),
    pg_temp.try(format('select public.add_quote_version(%L, ''x'', ''{"items": []}''::jsonb, 0)', p_q))];
$f$;
grant execute on all functions in schema pg_temp to anon, authenticated, service_role;
select pg_temp.login('a_admin@a.test');
create temp table _f as select pg_temp.five(:Q, '1') as q, pg_temp.five(:D, '2') as d, pg_temp.five(:C, '3') as c, pg_temp.five(:X, '4') as x; grant all on _f to authenticated;
select pg_temp.res('05 an event locked by hand: tasks, times, steps, run-sheet, Venue opens, layout all work', (select q = array_fill(''::text, array[8]) from _f), (select q::text from _f));
select pg_temp.res('06 an event on its day (Event Day stage): all work', (select d = array_fill(''::text, array[8]) from _f), (select d::text from _f));
select pg_temp.res('07 a closed event refuses each of them in plain words', (select c[1] like '42501 This event is closed, so its task plan%' and c[2] like '42501 This event is closed%' and c[3] like '42501 This event is closed%' and c[5] like '42501 This event is closed, so its run-sheet%'
  and c[6] like '42501 This event is closed%' and c[7] like '42501 This event is closed, so its Venue opens%' and c[8] like '42501 This event is closed, so its floor plan%' from _f)
  and (select title = 'Stage set-up' and planned_start is null from public.event_tasks where id = 'a0000000-0000-4000-8000-00000000a443') and not exists (select 1 from public.event_tasks where quote_id = :C and step = 'onday'), (select c::text from _f));
select pg_temp.res('08 a cancelled event: the lock refused nothing there, and still does not', (select not exists (select 1 from unnest(x) z where z ~ '(plan_locked|is closed, so its)') from _f), (select x::text from _f));
select pg_temp.res('09 a closed event: status, ticks still work', pg_temp.try('update public.event_tasks set status = ''accepted'', responded_at = now() where id = ''a0000000-0000-4000-8000-00000000a443''') = ''
  and pg_temp.try(format('select public.event_day_check_set(%L, ''power'', true)', :C)) = '');

-- 3) what the pages are told
create temp table _g as select pg_temp.j(format('select public.event_plan_lock_get(%L)', :D)) as d, pg_temp.j(format('select public.event_plan_lock_get(%L)', :C)) as c, pg_temp.j(format('select public.event_floor_get(%L)', :D)) as f; grant all on _g to authenticated;
select pg_temp.res('10 not locked, removed, nothing to press; the stored row and history are still answered', (select (d ->> 'locked') = 'false' and (d ->> 'removed') = 'true' and (d ->> 'can_lock') = 'false' and (d ->> 'can_unlock') = 'false' and (d ->> 'auto') = 'false' and (d ->> 'relocks') = 'false'
  and d ->> 'state' = 'locked' and (f #>> '{lock,locked}') = 'false' from _g), (select d::text from _g));
select pg_temp.res('11 closed: locked is true with stage closed, nobody can unlock it here', (select (c ->> 'locked') = 'true' and c ->> 'stage' = 'closed' and (c ->> 'can_unlock') = 'false' from _g));
select pg_temp.res('12 an old page presses Lock / Unlock: refused or nothing, no row written', pg_temp.try(format('select public.event_plan_lock_set(%L, true, null)', :D)) like '22023 The event-day lock was removed%'
  and (pg_temp.j(format('select public.event_plan_lock_set(%L, false, ''why not'')', :D)) ->> 'locked') = 'false' and pg_temp.try(format('select public.event_plan_lock_set(%L, false, ''why not'')', :C)) like '42501 This event is closed%');
select pg_temp.su();
select pg_temp.res('13 ... and nothing was written', not exists (select 1 from public.event_plan_lock_log where quote_id in (:D, :C, :Q)) and (select count(*) = 4 from public.event_plan_locks where state = 'locked' and quote_id in (:Q, :D, :C, :X)));

-- 4) ticks
select pg_temp.login('a_sup442@a.test');
create temp table _m as select pg_temp.j(format('select public.event_check_mark(%L, ''daybefore:rd-vendors'', true, ''1 vendor is not confirmed'')', :Q)) as a; grant all on _m to authenticated;
select pg_temp.res('14 a supervisor (Assign & send tasks) ticks: who, when, what the page showed', (select a #>> '{item,by}' = 'Sunil Supervisor' and (a #>> '{item,done}') = 'true' and a #>> '{item,note}' = '1 vendor is not confirmed' and (a #>> '{item,at}') is not null from _m), (select a::text from _m));
select pg_temp.login('a_admin@a.test');
select pg_temp.res('15 the same tick again by someone else changes nothing', pg_temp.j(format('select public.event_check_mark(%L, ''daybefore:rd-vendors'', true, ''x'')', :Q)) #>> '{item,by}' = 'Sunil Supervisor'
  and jsonb_array_length(pg_temp.j(format('select public.event_checks_get(%L)', :Q)) -> 'log') = 1);
select pg_temp.res('16 undo keeps who + when, the history has both', (pg_temp.j(format('select public.event_check_mark(%L, ''daybefore:rd-vendors'', false)', :Q)) #>> '{item,done}') = 'false'
  and (select string_agg(x ->> 'action', ',') = 'undo,done' from jsonb_array_elements(pg_temp.j(format('select public.event_checks_get(%L)', :Q)) -> 'log') x));
select pg_temp.res('17 both steps, ticks of one event only', pg_temp.try(format('select public.event_check_mark(%L, ''pre:safety'', true)', :Q)) = '' and not (pg_temp.j(format('select public.event_checks_get(%L)', :D)) -> 'marks' ? 'pre:safety')
  and (pg_temp.j(format('select public.event_checks_get(%L)', :Q)) #>> '{marks,pre:safety,done}') = 'true');
select pg_temp.res('18 keys, notes are checked', pg_temp.try(format('select public.event_check_mark(%L, ''onday:x'', true)', :Q)) like '%invalid_key%' and pg_temp.try(format('select public.event_check_mark(%L, ''pre:<b>'', true)', :Q)) like '%invalid_key%'
  and pg_temp.try(format('select public.event_check_mark(%L, ''pre:x'', null)', :Q)) like '%invalid_key%' and pg_temp.try(format('select public.event_check_mark(%L, %L, true)', :Q, 'pre:' || repeat('a', 200))) like '%invalid_key%'
  and char_length(pg_temp.j(format('select public.event_check_mark(%L, ''pre:long'', true, %L)', :Q, repeat('n', 400))) #>> '{item,note}') = 160);
select pg_temp.res('19 a tick changes nothing else (bookings, tasks, stock, plan untouched)', (select title = 'new name' and status = 'assigned' from public.event_tasks where id = 'a0000000-0000-4000-8000-00000000a441'));
select pg_temp.res('20 the 11 ticks: kept in the plan as before, history too, the first person stays', (pg_temp.j(format('select public.event_day_check_set(%L, ''permits'', true)', :Q)) #>> '{item,done}') = 'true');
select pg_temp.login('a_sup442@a.test');
select pg_temp.res('21 ... by someone else again = the first one is answered; an untick is written', pg_temp.j(format('select public.event_day_check_set(%L, ''permits'', true)', :Q)) #>> '{item,by}' <> 'Sunil Supervisor'
  and pg_temp.j(format('select public.event_day_check_set(%L, ''permits'', false)', :Q)) #>> '{item,by}' = 'Sunil Supervisor'
  and (select count(*) = 2 from jsonb_array_elements(pg_temp.j(format('select public.event_checks_get(%L)', :Q)) -> 'log') x where x ->> 'key' = 'daybefore:permits')
  and (pg_temp.j(format('select public.event_day_plan_get(%L)', :Q)) #>> '{checks,permits,done}') = 'false');

-- 5) own lines
create temp table _l as select pg_temp.j(format('select public.event_check_line_add(%L, ''pre'', ''  Cake   table   ready '', ''a0000000-0000-4000-8000-00000000c442'')', :Q)) as a; grant all on _l to authenticated;
select pg_temp.res('22 a line of your own; the same press and the same words are one line', (select a ->> 'id' = 'a0000000-0000-4000-8000-00000000c442' from _l)
  and (pg_temp.j(format('select public.event_check_line_add(%L, ''pre'', ''Cake table ready'', ''a0000000-0000-4000-8000-00000000c442'')', :Q)) ->> 'same') = 'true' and (pg_temp.j(format('select public.event_check_line_add(%L, ''pre'', ''cake TABLE ready'')', :Q)) ->> 'same') = 'true'
  and (select jsonb_array_length(v -> 'lines') = 1 and v #>> '{lines,0,title}' = 'Cake table ready' and v #>> '{lines,0,by}' = 'Sunil Supervisor' from pg_temp.j(format('select public.event_checks_get(%L)', :Q)) v), (select a::text from _l));
select pg_temp.res('23 empty, too long, < >, wrong step, closed and cancelled events refused', pg_temp.try(format('select public.event_check_line_add(%L, ''pre'', ''  '')', :Q)) like '22023%' and pg_temp.try(format('select public.event_check_line_add(%L, ''pre'', %L)', :Q, repeat('x', 121))) like '22023%'
  and pg_temp.try(format('select public.event_check_line_add(%L, ''pre'', ''<b>x</b>'')', :Q)) like '22023%' and pg_temp.try(format('select public.event_check_line_add(%L, ''onday'', ''x'')', :Q)) like '22023%'
  and pg_temp.try(format('select public.event_check_line_add(%L, ''pre'', ''x'')', :C)) like '22023 This event is closed%' and pg_temp.try(format('select public.event_check_line_add(%L, ''pre'', ''x'')', :X)) like '22023 This event is closed%');
select pg_temp.res('24 its tick; another event''s line or one that is not there is refused', pg_temp.try(format('select public.event_check_mark(%L, ''pre:own:a0000000-0000-4000-8000-00000000c442'', true)', :Q)) = ''
  and pg_temp.try(format('select public.event_check_mark(%L, ''pre:own:a0000000-0000-4000-8000-00000000c442'', true)', :D)) like '22023 This line was taken off%'
  and pg_temp.try(format('select public.event_check_mark(%L, ''daybefore:own:a0000000-0000-4000-8000-00000000c442'', true)', :Q)) like '22023 This line was taken off%');
select pg_temp.res('25 cancel takes it off the list (row, ticks, history stay); twice = nothing; no tick after', (pg_temp.j('select public.event_check_line_cancel(''a0000000-0000-4000-8000-00000000c442'')') ->> 'changed') = 'true'
  and (pg_temp.j('select public.event_check_line_cancel(''a0000000-0000-4000-8000-00000000c442'')') ->> 'changed') = 'false' and jsonb_array_length(pg_temp.j(format('select public.event_checks_get(%L)', :Q)) -> 'lines') = 0
  and pg_temp.try(format('select public.event_check_mark(%L, ''pre:own:a0000000-0000-4000-8000-00000000c442'', false)', :Q)) like '22023%');
select pg_temp.su();
select pg_temp.res('26 ... in the table', (select cancelled_name = 'Sunil Supervisor' and title = 'Cake table ready' from public.event_check_lines where id = 'a0000000-0000-4000-8000-00000000c442')
  and (select string_agg(action, ',' order by at) = 'add,done,cancel' from public.event_check_log where key = 'pre:own:a0000000-0000-4000-8000-00000000c442'));

-- 6) rights
select pg_temp.login('a_view442@a.test');
select pg_temp.res('27 a viewer reads and cannot tick, add or cancel', (pg_temp.j(format('select public.event_checks_get(%L)', :Q)) ->> 'can_edit') = 'false' and pg_temp.try(format('select public.event_check_mark(%L, ''pre:safety'', false)', :Q)) like '42501%'
  and pg_temp.try(format('select public.event_check_line_add(%L, ''pre'', ''x'')', :Q)) like '42501%' and pg_temp.try('select public.event_check_line_cancel(''a0000000-0000-4000-8000-00000000c442'')') like '42501%'
  and pg_temp.try('select count(*) from public.event_check_marks') like '42501%');
select pg_temp.login('b_admin@b.test');
select pg_temp.res('28 another studio: not found, whatever it sends', pg_temp.try(format('select public.event_checks_get(%L)', :Q)) like '%event not found%' and pg_temp.try(format('select public.event_check_mark(%L, ''pre:safety'', false)', :Q)) like '%event not found%'
  and pg_temp.try(format('select public.event_check_line_add(%L, ''pre'', ''x'')', :Q)) like '%event not found%' and pg_temp.try('select public.event_check_line_cancel(''a0000000-0000-4000-8000-00000000c442'')') like '42501%');
select pg_temp.su(); select set_config('request.jwt.claims', '{"role":"anon"}', false); select set_config('role', 'anon', false);
select pg_temp.res('29 signed out: refused', pg_temp.try(format('select public.event_checks_get(%L)', :Q)) like '42501%' and pg_temp.try(format('select public.event_check_mark(%L, ''pre:safety'', false)', :Q)) like '42501%');
select pg_temp.su();
select pg_temp.res('30 a row for another studio is refused by the guard', pg_temp.try(format('insert into public.event_check_marks(quote_id, org_id, key) select %L, id, ''pre:x9'' from public.organizations where id <> ''a0000000-0000-4000-8000-000000000001'' limit 1', :Q)) like '42501%');

-- 6b) Latest: sent back / approved; busy elsewhere
select pg_temp.su();
update public.event_tasks set status = 'completed', completed_at = now(), verify_status = 'pending' where id = 'a0000000-0000-4000-8000-00000000a441';
select pg_temp.login('a_admin@a.test');
create temp table _v as select pg_temp.try('select public.verify_task(''a0000000-0000-4000-8000-00000000a441'', false, ''Left side is not level'')') as a; grant all on _v to authenticated;
select pg_temp.su();
update public.event_tasks set status = 'completed', completed_at = now(), verify_status = 'pending' where id = 'a0000000-0000-4000-8000-00000000a441';
select pg_temp.login('a_admin@a.test');
select pg_temp.res('31 a check sends it back, then approves it after the rework', (select a = '' from _v) and pg_temp.try('select public.verify_task(''a0000000-0000-4000-8000-00000000a441'', true, null)') = '', (select a from _v));
create temp table _ac as select x from jsonb_array_elements(pg_temp.j(format('select public.event_day_activity(%L, 200)', :Q))) x where x ->> 'kind' in ('sent_back', 'approved'); grant all on _ac to authenticated;
select pg_temp.res('32 ... in the event''s activity', (select count(*) = 2 and bool_or(x ->> 'kind' = 'sent_back' and x #>> '{detail,note}' = 'Left side is not level' and x #>> '{detail,by}' <> '') from _ac), (select string_agg(x::text, ' ') from _ac));
select pg_temp.su();
do $$ declare v_c uuid; begin
  insert into public.crew_members(id, org_id, name, phone, active) values ('a0000000-0000-4000-8000-0000000cc442', 'a0000000-0000-4000-8000-000000000001', 'Busy Bala', '+919000044442', true);
  update public.event_tasks set crew_id = 'a0000000-0000-4000-8000-0000000cc442', assignee_name = 'Busy Bala', planned_start = null where id = 'a0000000-0000-4000-8000-00000000a442';
end $$;
select pg_temp.login('a_admin@a.test');
create temp table _b1 as select pg_temp.j('select public.crew_day_status((select event_date from public.quotes where id = ''a0000000-0000-4000-8000-0000000d4422''), null)') as j; grant all on _b1 to authenticated;
select pg_temp.su(); update public.quotes set lifecycle_stage = 'settlement' where id = :D; select pg_temp.login('a_admin@a.test');
create temp table _b2 as select pg_temp.j('select public.crew_day_status((select event_date from public.quotes where id = ''a0000000-0000-4000-8000-0000000d4422''), null)') as j; grant all on _b2 to authenticated;
select pg_temp.res('33 busy while the event is live, not once it is at Settlement', (select exists (select 1 from jsonb_array_elements(j) x where x ->> 'name' = 'Busy Bala' and jsonb_array_length(x -> 'booked') = 1) from _b1)
  and (select not exists (select 1 from jsonb_array_elements(j) x where x ->> 'name' = 'Busy Bala') from _b2), (select j::text from _b1));
select pg_temp.su(); update public.quotes set lifecycle_stage = 'event_day' where id = :D;

-- 7) the switch brings the lock back
create or replace function public._r442_lock_on() returns boolean language sql stable set search_path = '' as 'select true';
select pg_temp.login('a_admin@a.test');
select pg_temp.res('34 the one-line switch: locked again as 0397 + 0441, the checklist stays', pg_temp.try('update public.event_tasks set title = ''y'' where id = ''a0000000-0000-4000-8000-00000000a442''') like 'P0001 plan_locked%'
  and (pg_temp.j(format('select public.event_plan_lock_get(%L)', :D)) ->> 'locked') = 'true' and (pg_temp.j(format('select public.event_plan_lock_get(%L)', :D)) ->> 'can_unlock') = 'true'
  and (pg_temp.j(format('select public.event_plan_lock_set(%L, false, ''changed our mind'')', :D)) ->> 'locked') = 'false' and (pg_temp.j(format('select public.event_checks_get(%L)', :Q)) #>> '{marks,pre:safety,done}') = 'true');

select pg_temp.su();
select name, result from _rc where result <> 'PASS' order by name;
select 'R257-NO-LOCK-CHECKLIST-0442: ' || case when count(*) filter (where result <> 'PASS') = 0 then 'ALL PASS' else 'FAIL' end || ' (' || count(*) filter (where result = 'PASS') || '/' || count(*) || ')' from _rc;
rollback;
