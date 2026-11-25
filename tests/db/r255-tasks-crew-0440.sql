-- r255-tasks-crew-0440.sql - R255: (1) applied twice, no stored row changed, privileges; (2) the waiting change notice: 5 quiet minutes as before,
-- "You can start now" due at once and never pushed back by a later change, "Cancelled" 1 minute, still one row per person; the words of "accepted
-- by the office" and the claim that leaves it out next to "You can start now"; (3) a deactivated login gets no new work (linked login, e-mail only
-- without a link, other studio), tasks it has stay; (4) extras: rights, studio isolation, once per press, cancel keeps the row, no money touched.
-- Local disposable PG only. Fake data only. Rolled back.
\set ON_ERROR_STOP 0
set client_min_messages = error;
begin;
create temp table _rs(name text, result text); grant all on _rs to anon, authenticated, service_role;
create or replace function pg_temp.t(p_name text, p_ok boolean, p_detail text default '') returns void language plpgsql as $$
begin insert into _rs values (p_name, case when coalesce(p_ok, false) then 'PASS' else 'FAIL: ' || coalesce(p_detail, '') end); end $$;
create or replace function pg_temp.as_val(p_who text, p_sql text) returns text language plpgsql as $$
declare v text;
begin
  if p_who = 'anon' then perform auth.login_anon();
  elsif p_who is not null then perform auth.login_as((select id from auth.users where email = p_who)); end if;
  execute p_sql into v;
  perform auth.logout(); execute 'reset role';
  return 'ok:' || coalesce(v, '<null>');
exception when others then
  perform auth.logout(); execute 'reset role';
  return sqlstate || ' ' || sqlerrm;
end $$;
create temp table _before as select (select md5(coalesce(string_agg(t::text, '|' order by t.id), '')) from public.event_tasks t) as tasks,
  (select count(*) from public.staff_update_outbox) as mails;
\ir ../../supabase/migrations/0440_r255_tasks_crew.sql
\ir ../../supabase/migrations/0440_r255_tasks_crew.sql
set client_min_messages = warning;
select pg_temp.t('1a no stored row changed (twice)', (select b.tasks = md5(coalesce((select string_agg(t::text, '|' order by t.id) from public.event_tasks t), '')) and b.mails = (select count(*) from public.staff_update_outbox) from _before b));
select pg_temp.t('1b helpers server only', not exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace, unnest(array['anon', 'authenticated', 'service_role']) r
   where n.nspname = 'public' and (p.proname like '\_r440\_%' or p.proname like '%\_\_pre0440') and has_function_privilege(r, p.oid, 'execute')));
select pg_temp.t('1c kept bodies are the old ones', (select count(*) = 4 and bool_and(position('r255-0440' in p.prosrc) = 0) from pg_proc p where p.proname like '%\_\_pre0440' or p.proname = '_r440_kept_mail'));
select pg_temp.t('1d anon cannot run the new calls', not has_function_privilege('anon', 'public.crew_login_off()', 'execute') and not has_function_privilege('anon', 'public.event_extra_cancel(uuid,text)', 'execute') and not has_function_privilege('anon', 'public.event_extra_decide(uuid,text)', 'execute'));
select pg_temp.t('1e grants of the replaced ones', has_function_privilege('service_role', 'public.staff_update_claim(integer)', 'execute') and not has_function_privilege('authenticated', 'public.staff_update_claim(integer)', 'execute') and not has_function_privilege('authenticated', 'public._r363_note(uuid,uuid,uuid,text,text[],boolean)', 'execute'));

\set A '\'a0000000-0000-4000-8000-000000000001\''
\set Q '\'a0000000-0000-4000-8000-00000000da01\''
do $$ declare e text; u uuid; begin
  foreach e in array array['r255_mgr@a.test:manager:Mia Manager', 'r255_off@a.test:sales:Pat Sample', 'r255_crew@a.test:crew:Crew Login'] loop
    select id into u from auth.users where email = split_part(e, ':', 1);
    if u is null then u := auth.seed_user(split_part(e, ':', 1)); end if;
    insert into public.profiles(id, email, full_name, role, org_id, must_change_password, created_at)
      values (u, split_part(e, ':', 1), split_part(e, ':', 3), split_part(e, ':', 2), 'a0000000-0000-4000-8000-000000000001', false, now())
    on conflict (id) do update set role = excluded.role, org_id = excluded.org_id, full_name = excluded.full_name, email = excluded.email;
  end loop;
  insert into public.team_member_status (user_id, org_id, status, deactivated_at)
  values ((select id from auth.users where email = 'r255_off@a.test'), 'a0000000-0000-4000-8000-000000000001', 'deactivated', now()) on conflict (user_id, org_id) do update set status = 'deactivated';
end $$;
update public.quotes set deleted_at = null, status = 'confirmed', title = 'Rao wedding', event_date = (now() + interval '1 day')::date, is_demo = false,
       lifecycle_stage = case when lifecycle_stage in ('closed', 'cancelled') then 'execution' else lifecycle_stage end where id = :Q;
insert into public.role_access (org_id, role, area, can_view, can_edit) select :A, 'manager', a, true, true from unnest(array['staff', 'issues', 'budget', 'quotes', 'assign', 'tasks']) a on conflict (org_id, role, area) do update set can_view = true, can_edit = true;
insert into public.role_access (org_id, role, area, can_view, can_edit) select :A, 'crew', a, true, a = 'issues' from unnest(array['issues', 'budget']) a on conflict (org_id, role, area) do update set can_view = excluded.can_view, can_edit = excluded.can_edit;
delete from public.automation_settings where org_id = :A; delete from public.task_reminder_settings where org_id = :A;
insert into public.crew_members (id, name, phone, email, org_id, profile_id, active) values
  ('a0000000-0000-4000-8000-0000000c2551', 'Sam Two', '+91 90000 25511', 'k255@example.org', :A, null, true),
  ('a0000000-0000-4000-8000-0000000c2552', 'Pat Sample', '+91 90000 25512', 'other255@example.org', :A, (select id from auth.users where email = 'r255_off@a.test'), true),
  ('a0000000-0000-4000-8000-0000000c2553', 'Same Mail', '+91 90000 25513', 'R255_OFF@a.test', :A, null, true),
  ('a0000000-0000-4000-8000-0000000c2554', 'Fine Person', '+91 90000 25514', 'fine255@example.org', :A, null, true);
insert into public.event_tasks (id, quote_id, org_id, category, title, crew_id, assignee_name, assignee_phone, status, depends_on) values
  ('a0000000-0000-4000-8000-00000f550001', :Q, :A, 'Stage255', 'Fix stage platform', null, null, null, 'unassigned', null),
  ('a0000000-0000-4000-8000-00000f550002', :Q, :A, 'Stage255', 'Stage stairs', 'a0000000-0000-4000-8000-0000000c2551', 'Sam Two', '+91 90000 25511', 'assigned', 'a0000000-0000-4000-8000-00000f550001'),
  ('a0000000-0000-4000-8000-00000f550003', :Q, :A, 'Stage255', 'Second ramp', 'a0000000-0000-4000-8000-0000000c2551', 'Sam Two', '+91 90000 25511', 'assigned', null),
  ('a0000000-0000-4000-8000-00000f550004', :Q, :A, 'Stage255', 'Old work', 'a0000000-0000-4000-8000-0000000c2552', 'Pat Sample', '+91 90000 25512', 'assigned', null);
delete from public.staff_email_outbox where quote_id = :Q; delete from public.assign_notify_outbox where quote_id = :Q; delete from public.staff_update_outbox where quote_id = :Q;
create or replace function pg_temp.row() returns public.staff_update_outbox language sql as $$ select o from public.staff_update_outbox o where o.quote_id = 'a0000000-0000-4000-8000-00000000da01' and o.recipient = 'k255@example.org' and o.status = 'pending' $$;

-- 2) the notice
select pg_temp.t('2a manager accepts for them', pg_temp.as_val('r255_mgr@a.test', $q$ with u as (update public.event_tasks set note = 'bring gloves' where id = 'a0000000-0000-4000-8000-00000f550003' returning 1) select count(*)::text from u $q$) = 'ok:1');
select pg_temp.t('2b an ordinary change waits 5 minutes', (pg_temp.row()).not_before = now() + interval '5 minutes', (pg_temp.row()).not_before::text);
update public.staff_update_outbox set first_at = now() - interval '2 minutes', not_before = now() + interval '3 minutes' where id = (pg_temp.row()).id;
select pg_temp.as_val('r255_mgr@a.test', $q$ with u as (update public.event_tasks set note = 'bring tape' where id = 'a0000000-0000-4000-8000-00000f550003' returning 1) select count(*)::text from u $q$);
select pg_temp.t('2c another ordinary change still waits for 5 quiet minutes', (pg_temp.row()).not_before = now() + interval '5 minutes');
select pg_temp.t('2d a cancelled task: 1 minute, the same e-mail', pg_temp.as_val('r255_mgr@a.test', $q$ select public.cancel_task('a0000000-0000-4000-8000-00000f550003', 'not needed') is not null $q$) like 'ok:%'
  and (pg_temp.row()).not_before = now() + interval '1 minute' and (pg_temp.row()).changes @> '["Cancelled: Second ramp"]'
  and (select count(*) from public.staff_update_outbox where quote_id = :Q and recipient = 'k255@example.org') = 1, (pg_temp.row()).not_before::text);
select pg_temp.as_val('r255_mgr@a.test', $q$ with u as (update public.event_tasks set note = 'x' where id = 'a0000000-0000-4000-8000-00000f550002' returning 1) select count(*)::text from u $q$);
select pg_temp.t('2e an ordinary change after it does not push it back', (pg_temp.row()).not_before = now() + interval '1 minute', (pg_temp.row()).not_before::text);
update public.event_tasks set status = 'in_progress' where id = 'a0000000-0000-4000-8000-00000f550001';
select pg_temp.t('2f the earlier task is done', pg_temp.as_val('r255_mgr@a.test', $q$ with u as (update public.event_tasks set status = 'completed', completed_at = now() where id = 'a0000000-0000-4000-8000-00000f550001' returning 1) select count(*)::text from u $q$) = 'ok:1');
select pg_temp.t('2g "You can start now" is due at once', (pg_temp.row()).not_before <= now() and (pg_temp.row()).changes @> '["You can start now: Stage stairs - Fix stage platform is done"]', (pg_temp.row()).changes::text);
select pg_temp.as_val('r255_mgr@a.test', $q$ with u as (update public.event_tasks set status = 'accepted' where id = 'a0000000-0000-4000-8000-00000f550002' returning 1) select count(*)::text from u $q$);
select pg_temp.t('2h accepted by the office after it: NOT pushed back (the 25 Nov bug), plain words', (pg_temp.row()).not_before <= now() and (pg_temp.row()).changes @> '["Stage stairs: accepted for you by the office"]', (pg_temp.row()).not_before::text || (pg_temp.row()).changes::text);
create temp table _claim as select e from jsonb_array_elements(public.staff_update_claim(50)) e where e ->> 'to' = 'k255@example.org';
select pg_temp.t('2i one e-mail, the facts of 0436, without the accepted line of the same task', (select count(*) = 1 and bool_and(jsonb_array_length(e -> 'start_now') = 1 and e -> 'changes' @> '["You can start now: Stage stairs - Fix stage platform is done"]' and e -> 'changes' @> '["Cancelled: Second ramp"]'
  and not e -> 'changes' @> '["Stage stairs: accepted for you by the office"]') from _claim), (select string_agg(e::text, ' ') from _claim));
select pg_temp.t('2j claimed once', not exists (select 1 from jsonb_array_elements(public.staff_update_claim(50)) e where e ->> 'to' = 'k255@example.org'));
select pg_temp.t('2k tidy: other tasks, the old words, long titles', public._r440_tidy('["You can start now: A - B is done","A: status changed from Assigned to Accepted by the office","AB: accepted for you by the office"]') = '["You can start now: A - B is done","AB: accepted for you by the office"]'
  and public._r440_tidy('["A: accepted for you by the office"]') = '["A: accepted for you by the office"]'
  and public._r440_tidy(jsonb_build_array('You can start now: ' || repeat('x', 70) || ' - B is done', repeat('x', 90) || ': accepted for you by the office')) = jsonb_build_array('You can start now: ' || repeat('x', 70) || ' - B is done'));

-- 3) deactivated logins
select pg_temp.t('3a the list: the linked login and the e-mail of a record without a login', pg_temp.as_val('r255_mgr@a.test', 'select public.crew_login_off()::text') = 'ok:["a0000000-0000-4000-8000-0000000c2552", "a0000000-0000-4000-8000-0000000c2553"]', pg_temp.as_val('r255_mgr@a.test', 'select public.crew_login_off()::text'));
select pg_temp.t('3b anon is refused', pg_temp.as_val('anon', 'select public.crew_login_off()::text') like '42501%');
select pg_temp.t('3c giving new work is refused in plain words', pg_temp.as_val('r255_mgr@a.test', format('select public.assign_tasks(%L, ''Stage255'', array[''New thing''], ''a0000000-0000-4000-8000-0000000c2552'', ''Pat Sample'', ''+91 90000 25512'')::text', :Q)) like '22023 Pat Sample has a deactivated login%',
  pg_temp.as_val('r255_mgr@a.test', format('select public.assign_tasks(%L, ''Stage255'', array[''New thing''], ''a0000000-0000-4000-8000-0000000c2552'', ''Pat Sample'', ''+91 90000 25512'')::text', :Q)));
select pg_temp.t('3d nothing was made', not exists (select 1 from public.event_tasks where quote_id = :Q and title = 'New thing'));
select pg_temp.t('3e somebody else is fine', pg_temp.as_val('r255_mgr@a.test', format('select public.assign_tasks(%L, ''Stage255'', array[''New thing''], ''a0000000-0000-4000-8000-0000000c2554'', ''Fine Person'', ''+91 90000 25514'') is not null', :Q)) = 'ok:true');
select pg_temp.t('3f moving a task to them is refused', pg_temp.as_val('r255_mgr@a.test', 'select public.reassign_task((select id from public.event_tasks where title = ''New thing''), ''a0000000-0000-4000-8000-0000000c2553'', ''Same Mail'', ''+91 90000 25513'') is not null') like '22023 Same Mail has a deactivated login%');
select pg_temp.t('3g the task they already have can still be changed and cancelled', pg_temp.as_val('r255_mgr@a.test', $q$ with u as (update public.event_tasks set note = 'y' where id = 'a0000000-0000-4000-8000-00000f550004' returning 1) select count(*)::text from u $q$) = 'ok:1'
  and pg_temp.as_val('r255_mgr@a.test', $q$ select public.cancel_task('a0000000-0000-4000-8000-00000f550004', 'left the studio') is not null $q$) like 'ok:%');
update public.team_member_status set status = 'active' where user_id = (select id from auth.users where email = 'r255_off@a.test');
select pg_temp.t('3h reactivated: fine again', pg_temp.as_val('r255_mgr@a.test', 'select public.crew_login_off()::text') = 'ok:[]');

-- 4) extras
create temp table _money as select (select md5(coalesce(string_agg(x::text, '|' order by x.id), '')) from public.change_requests x) as cr, (select md5(coalesce(string_agg(x::text, '|' order by x.id), '')) from public.event_costs x) as ec,
  (select md5(q::text) from public.quotes q where q.id = :Q) as qq;
select pg_temp.t('4a add', pg_temp.as_val('r255_mgr@a.test', format($q$ select public.event_extra_add(%L, '{"what":" 20  extra plates ","qty":"20","cost":"4500","asked_by":"Bride''s father","approved_by":"Mia"}', 'a0000000-0000-4000-8000-00000e550001') ->> 'id' $q$, :Q)) like 'ok:%');
select pg_temp.t('4b the same press again = the same row', pg_temp.as_val('r255_mgr@a.test', format($q$ select public.event_extra_add(%L, '{"what":"20 extra plates"}', 'a0000000-0000-4000-8000-00000e550001') ->> 'same' $q$, :Q)) = 'ok:true' and (select count(*) from public.event_extras) = 1);
select pg_temp.t('4c what is needed, numbers are checked', pg_temp.as_val('r255_mgr@a.test', format($q$ select public.event_extra_add(%L, '{"what":"  "}') $q$, :Q)) like '22023 Say what%' and pg_temp.as_val('r255_mgr@a.test', format($q$ select public.event_extra_add(%L, '{"what":"x","qty":"-2"}') $q$, :Q)) like '22023%'
  and pg_temp.as_val('r255_mgr@a.test', format($q$ select public.event_extra_add(%L, '{"what":"x","cost":"abc"}') $q$, :Q)) like '22023%' and pg_temp.as_val('r255_mgr@a.test', format($q$ select public.event_extra_add(%L, '{"what":"x","qty":"NaN"}') $q$, :Q)) like '22023%');
select pg_temp.t('4d the list', pg_temp.as_val('r255_mgr@a.test', format($q$ select (x -> 'items' -> 0 ->> 'what') || '|' || (x -> 'items' -> 0 ->> 'qty') || '|' || (x -> 'items' -> 0 ->> 'by') from public.event_extras_list(%L) x $q$, :Q)) = 'ok:20 extra plates|20.00|Mia Manager', pg_temp.as_val('r255_mgr@a.test', format('select public.event_extras_list(%L)::text', :Q)));
select pg_temp.t('4e no direct table access', pg_temp.as_val('r255_mgr@a.test', 'select count(*)::text from public.event_extras') like '42501%' and pg_temp.as_val('anon', 'select count(*)::text from public.event_extras') like '42501%');
select pg_temp.t('4f another studio, anon, an unknown event: refused', pg_temp.as_val('anon', format('select public.event_extras_list(%L)::text', :Q)) like '42501%'
  and (select bool_and(pg_temp.as_val(u.email, format('select public.event_extras_list(%L)::text', :Q)) like '42501%') from auth.users u join public.profiles p on p.id = u.id where p.org_id is distinct from :A and p.role = 'admin')
  and pg_temp.as_val('r255_mgr@a.test', 'select public.event_extras_list(gen_random_uuid())::text') like '42501%');
select pg_temp.t('4g decide needs Budget - Can change', pg_temp.as_val('r255_crew@a.test', 'select public.event_extra_decide((select id from public.event_extras limit 1), ''bill'')::text') like '42501%');
create temp table _r as select pg_temp.as_val('r255_mgr@a.test', format($q$ select public.event_extra_decide(((select public.event_extras_list(%L) -> 'items' -> 0 ->> 'id'))::uuid, 'bill') ->> 'changed' $q$, :Q)) as a;
select pg_temp.t('4h decide marks only', (select a from _r) = 'ok:true' and (select decision = 'bill' and decided_by is not null from public.event_extras));
select pg_temp.t('4i a cancel needs a reason', pg_temp.as_val('r255_mgr@a.test', format($q$ select public.event_extra_cancel(((select public.event_extras_list(%L) -> 'items' -> 0 ->> 'id'))::uuid, 'x') $q$, :Q)) like '22023 Give a reason%');
update _r set a = pg_temp.as_val('r255_mgr@a.test', format($q$ select public.event_extra_cancel(((select public.event_extras_list(%L) -> 'items' -> 0 ->> 'id'))::uuid, 'typed twice') ->> 'changed' $q$, :Q));
select pg_temp.t('4i2 cancel keeps the row', (select a from _r) = 'ok:true' and (select count(*) = 1 and bool_and(cancel_reason = 'typed twice') from public.event_extras));
select pg_temp.t('4j no money row and no event row changed', (select m.cr = md5(coalesce((select string_agg(x::text, '|' order by x.id) from public.change_requests x), '')) and m.ec = md5(coalesce((select string_agg(x::text, '|' order by x.id) from public.event_costs x), '')) and m.qq = (select md5(q::text) from public.quotes q where q.id = :Q) from _money m));
update public.quotes set lifecycle_stage = 'closed' where id = :Q;
select pg_temp.t('4k a closed event takes no more', pg_temp.as_val('r255_mgr@a.test', format($q$ select public.event_extra_add(%L, '{"what":"late"}') $q$, :Q)) like '22023 This event is closed%' or (select lifecycle_stage from public.quotes where id = :Q) <> 'closed');
select pg_temp.t('4l on the free-trial clean-up list', '''event_extras''' = any (array(select quote_literal(x) from unnest(public._tr184_purge_tables()) x)));

select name, result from _rs where result <> 'PASS' order by name;
select 'R255-TASKS-CREW-0440: ' || case when count(*) filter (where result <> 'PASS') = 0 then 'ALL PASS' else 'FAIL' end || ' (' || count(*) filter (where result = 'PASS') || '/' || count(*) || ')' from _rs;
rollback;
