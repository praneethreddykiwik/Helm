-- r172-update-notices-0363.sql - R172: change notices to staff + one permanent task link per staff member.
-- Proves: (1) privileges; (2) permanent link: made once, same link again, other studio / anon / no staff edit refused,
-- the link page shows only that person own open tasks with a working per-event link, bad / old / deactivated links
-- refused, New link stops the old one; (3) change notices: office edits collect into ONE waiting notice per person per
-- event (5 quiet minutes, max 15 from the first), worker / system changes stay quiet, cancelled task, given to someone
-- else (old person told), event date / venue / cancelled reach every person with open work, nothing while a "new work"
-- e-mail is still waiting, nothing with the switch off; (4) the claim hands comms-dispatch one row with the lines and the
-- permanent link, staff e-mails carry the permanent link too; (5) re-run safe.
-- Re-applies 0363 twice (after 0362 if an older suite re-applied it). Local disposable PG only. Fake data only. Rolled back.
\set ON_ERROR_STOP 0
set client_min_messages = error;
\ir ../../supabase/migrations/0363_r172_update_notices_staff_link.sql
\ir ../../supabase/migrations/0363_r172_update_notices_staff_link.sql
set client_min_messages = warning;
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
-- the office (signed-in admin claims, superuser rights so the fixture edits are not refused by unrelated rules)
create or replace function pg_temp.office() returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claims', jsonb_build_object('sub', (select id from auth.users where email = 'a_admin@a.test')::text,
    'role', 'authenticated')::text, false);
end $$;
create or replace function pg_temp.sys() returns void language plpgsql as $$
begin perform set_config('request.jwt.claims', '', false); end $$;
create or replace function pg_temp.notes(p_rcpt text) returns jsonb language sql as $$
  select coalesce(jsonb_agg(jsonb_build_object('changes', changes, 'count', change_count, 'cancelled', cancelled, 'status', status)), '[]'::jsonb)
    from public.staff_update_outbox where recipient = p_rcpt and sent_at is null $$;
create or replace function pg_temp.lines(p_rcpt text) returns text language sql as $$
  select coalesce(string_agg(x, ' | ' order by o), '') from public.staff_update_outbox u, jsonb_array_elements_text(u.changes) with ordinality a(x, o)
   where u.recipient = p_rcpt and u.sent_at is null $$;

-- fixture: studio A, a live future event, three staff members (two with e-mail), tasks given to them
update public.organizations set timezone = 'Asia/Kolkata' where id = 'a0000000-0000-4000-8000-000000000001';
update public.quotes set deleted_at = null, status = 'confirmed', title = 'Rao Wedding', event_date = (now() + interval '3 days')::date, is_demo = false
 where id = 'a0000000-0000-4000-8000-00000000da01';
delete from public.automation_settings where org_id = 'a0000000-0000-4000-8000-000000000001';
insert into public.crew_members (id, name, phone, email, org_id, profile_id) values
  ('a0000000-0000-4000-8000-0000000c3721', 'Guest Desk', '+91 90000 37211', 'desk72@example.org', 'a0000000-0000-4000-8000-000000000001', null),
  ('a0000000-0000-4000-8000-0000000c3722', 'Cater Lead', '+91 90000 37212', 'cater72@example.org', 'a0000000-0000-4000-8000-000000000001', null),
  ('a0000000-0000-4000-8000-0000000c3723', 'No Mail', '+91 90000 37213', null, 'a0000000-0000-4000-8000-000000000001', null);
insert into public.event_tasks (id, quote_id, org_id, category, title, crew_id, assignee_name, assignee_phone, status, planned_start) values
  ('a0000000-0000-4000-8000-0000000f3721', 'a0000000-0000-4000-8000-00000000da01', 'a0000000-0000-4000-8000-000000000001', 'Guests', 'Receive guests',
   'a0000000-0000-4000-8000-0000000c3721', 'Guest Desk', '+91 90000 37211', 'assigned', date_trunc('minute', now()) + interval '3 days'),
  ('a0000000-0000-4000-8000-0000000f3722', 'a0000000-0000-4000-8000-00000000da01', 'a0000000-0000-4000-8000-000000000001', 'Catering', 'Welcome drinks',
   'a0000000-0000-4000-8000-0000000c3722', 'Cater Lead', '+91 90000 37212', 'assigned', date_trunc('minute', now()) + interval '3 days'),
  ('a0000000-0000-4000-8000-0000000f3723', 'a0000000-0000-4000-8000-00000000da01', 'a0000000-0000-4000-8000-000000000001', 'Catering', 'Plate count',
   'a0000000-0000-4000-8000-0000000c3722', 'Cater Lead', '+91 90000 37212', 'completed', date_trunc('minute', now()) + interval '3 days'),
  ('a0000000-0000-4000-8000-0000000f3724', 'a0000000-0000-4000-8000-00000000da01', 'a0000000-0000-4000-8000-000000000001', 'Catering', 'Napkins',
   'a0000000-0000-4000-8000-0000000c3722', 'Cater Lead', '+91 90000 37212', 'assigned', date_trunc('minute', now()) + interval '3 days');
-- the "new work for you" e-mails for the fixture have gone out
update public.staff_email_outbox set status = 'sent', sent_at = now() where sent_at is null;
delete from public.staff_update_outbox;

-- ---- 1) privileges ----------------------------------------------------------------------------------------------------------
select pg_temp.t('1a both new tables closed to the app', not has_table_privilege('authenticated', 'public.staff_links', 'select')
  and not has_table_privilege('anon', 'public.staff_links', 'select') and not has_table_privilege('authenticated', 'public.staff_update_outbox', 'select')
  and not has_table_privilege('anon', 'public.staff_update_outbox', 'select'));
select pg_temp.t('1b office link buttons: signed-in only; link page: anyone with a link',
  has_function_privilege('authenticated', 'public.staff_link_get(uuid)', 'execute') and not has_function_privilege('anon', 'public.staff_link_get(uuid)', 'execute')
  and not has_function_privilege('anon', 'public.staff_link_regenerate(uuid)', 'execute') and has_function_privilege('anon', 'public.staff_link_view(text)', 'execute'));
select pg_temp.t('1c claim / mark / helpers: server only', not has_function_privilege('authenticated', 'public.staff_update_claim(integer)', 'execute')
  and not has_function_privilege('anon', 'public.staff_update_mark(uuid,text)', 'execute')
  and not has_function_privilege('authenticated', 'public._r363_link(uuid,uuid)', 'execute')
  and not has_function_privilege('authenticated', 'public._r363_note(uuid,uuid,uuid,text,text[],boolean)', 'execute')
  and has_function_privilege('service_role', 'public.staff_update_claim(integer)', 'execute'));

-- ---- 2) the permanent link ----------------------------------------------------------------------------------------------------
create temp table _l as select pg_temp.as_val('a_admin@a.test', $q$select public.staff_link_get('a0000000-0000-4000-8000-0000000c3721') ->> 'path'$q$) as p;
select pg_temp.t('2a the office gets a link: work.html?staff=<64 hex>', (select p ~ '^ok:work\.html\?staff=[0-9a-f]{64}$' from _l), (select p from _l));
select pg_temp.t('2b asking again gives the same link', pg_temp.as_val('a_admin@a.test',
  $q$select public.staff_link_get('a0000000-0000-4000-8000-0000000c3721') ->> 'path'$q$) = (select p from _l));
select pg_temp.t('2c another studio cannot get it', pg_temp.as_val('b_admin@b.test',
  $q$select public.staff_link_get('a0000000-0000-4000-8000-0000000c3721')::text$q$) not like 'ok:%');
select pg_temp.t('2d not signed in -> refused', pg_temp.as_val('anon',
  $q$select public.staff_link_get('a0000000-0000-4000-8000-0000000c3721')::text$q$) not like 'ok:%');
create temp table _tok as select substr((select p from _l), length('ok:work.html?staff=') + 1) as tok;
create temp table _v as select (pg_temp.as_val('anon', format($q$select public.staff_link_view(%L)::text$q$, (select tok from _tok))))::text as v;
create temp table _vj as select substr(v, 4)::jsonb as j from _v where v like 'ok:%';
select pg_temp.t('2e the link page answers for that person', (select j ->> 'ok' = 'true' and j ->> 'name' = 'Guest' from _vj), (select left(v, 200) from _v));
select pg_temp.t('2f ... their own open task only, on the live event', (select jsonb_array_length(j -> 'events') = 1
  and (j -> 'events' -> 0 -> 'tasks' -> 0 ->> 'title') = 'Receive guests' and jsonb_array_length(j -> 'events' -> 0 -> 'tasks') = 1
  and position('Welcome drinks' in j::text) = 0 and position('cater72' in j::text) = 0 from _vj));
select pg_temp.t('2g ... with a working per-event task link (the existing worker page)',
  (select (j -> 'events' -> 0 ->> 'link') ~ '^[0-9a-f-]{36}$' from _vj)
  and pg_temp.as_val('anon', format($q$select public.worker_get_tasks(%L::uuid)::text$q$, (select j -> 'events' -> 0 ->> 'link' from _vj))) like 'ok:%Receive guests%');
select pg_temp.t('2h a made-up link -> bad_link', pg_temp.as_val('anon',
  $q$select public.staff_link_view(repeat('ab', 32)) ->> 'reason'$q$) = 'ok:bad_link');
select pg_temp.t('2i a malformed link -> bad_link', pg_temp.as_val('anon',
  $q$select public.staff_link_view('nope'' or 1=1 --') ->> 'reason'$q$) = 'ok:bad_link');
create temp table _l2 as select pg_temp.as_val('a_admin@a.test', $q$select public.staff_link_regenerate('a0000000-0000-4000-8000-0000000c3721') ->> 'path'$q$) as p;
select pg_temp.t('2j New link: a different link', (select p from _l2) ~ '^ok:work\.html\?staff=[0-9a-f]{64}$' and (select p from _l2) <> (select p from _l));
select pg_temp.t('2k ... and the old link stops at once', pg_temp.as_val('anon',
  format($q$select public.staff_link_view(%L) ->> 'reason'$q$, (select tok from _tok))) = 'ok:bad_link');
select pg_temp.t('2l ... the new link works', pg_temp.as_val('anon',
  format($q$select public.staff_link_view(%L) ->> 'ok'$q$, substr((select p from _l2), length('ok:work.html?staff=') + 1))) = 'ok:true');
update public.crew_members set active = false where id = 'a0000000-0000-4000-8000-0000000c3721';
select pg_temp.t('2m a deactivated staff member link stops', pg_temp.as_val('anon',
  format($q$select public.staff_link_view(%L) ->> 'reason'$q$, substr((select p from _l2), length('ok:work.html?staff=') + 1))) = 'ok:bad_link');
select pg_temp.t('2n ... and the office gets inactive, not a new link', pg_temp.as_val('a_admin@a.test',
  $q$select public.staff_link_get('a0000000-0000-4000-8000-0000000c3721') ->> 'reason'$q$) = 'ok:inactive');
update public.crew_members set active = true where id = 'a0000000-0000-4000-8000-0000000c3721';
select pg_temp.t('2o one live link per person at most', (select count(*) = 1 from public.staff_links
  where crew_id = 'a0000000-0000-4000-8000-0000000c3721' and revoked_at is null));

-- ---- 3) change notices ----------------------------------------------------------------------------------------------------------
select pg_temp.office();
update public.event_tasks set planned_start = planned_start + interval '30 minutes' where id = 'a0000000-0000-4000-8000-0000000f3721';
select pg_temp.t('3a an office time change queues one notice line', pg_temp.lines('desk72@example.org') like 'Receive guests: start time changed from % to %',
  pg_temp.lines('desk72@example.org'));
select pg_temp.t('3b ... sent after 5 quiet minutes', (select not_before between now() + interval '4 minutes' and now() + interval '6 minutes'
  from public.staff_update_outbox where recipient = 'desk72@example.org' and sent_at is null));
update public.event_tasks set title = 'Receive VIP guests', note = 'Use the side gate' where id = 'a0000000-0000-4000-8000-0000000f3721';
select pg_temp.t('3c more edits join the SAME notice', (select count(*) = 1 and max(change_count) = 3 and max(jsonb_array_length(changes)) = 3
  from public.staff_update_outbox where recipient = 'desk72@example.org' and sent_at is null), pg_temp.notes('desk72@example.org')::text);
select pg_temp.t('3d ... with plain lines (renamed, instructions)', pg_temp.lines('desk72@example.org') like '%Renamed: "Receive guests" is now "Receive VIP guests"%'
  and pg_temp.lines('desk72@example.org') like '%Receive VIP guests: instructions updated%', pg_temp.lines('desk72@example.org'));
update public.staff_update_outbox set first_at = now() - interval '20 minutes' where recipient = 'desk72@example.org' and sent_at is null;
update public.event_tasks set category = 'Front desk' where id = 'a0000000-0000-4000-8000-0000000f3721';
select pg_temp.t('3e never more than 15 minutes after the first change', (select not_before <= now()
  from public.staff_update_outbox where recipient = 'desk72@example.org' and sent_at is null));
select pg_temp.sys();
update public.event_tasks set status = 'accepted' where id = 'a0000000-0000-4000-8000-0000000f3721';
select pg_temp.t('3f the worker accepting (no office login) adds nothing', (select max(change_count) = 4
  from public.staff_update_outbox where recipient = 'desk72@example.org' and sent_at is null), pg_temp.notes('desk72@example.org')::text);
select pg_temp.office();
update public.event_tasks set status = 'cancelled' where id = 'a0000000-0000-4000-8000-0000000f3724';
select pg_temp.t('3g the office cancelling a task tells that person', pg_temp.lines('cater72@example.org') = 'Cancelled: Napkins',
  pg_temp.lines('cater72@example.org'));
update public.event_tasks set crew_id = 'a0000000-0000-4000-8000-0000000c3721', assignee_name = 'Guest Desk', assignee_phone = '+91 90000 37211'
 where id = 'a0000000-0000-4000-8000-0000000f3722';
select pg_temp.t('3h given to someone else: the previous person is told', pg_temp.lines('cater72@example.org') like '%No longer yours: Welcome drinks%',
  pg_temp.lines('cater72@example.org'));
select pg_temp.t('3i ... the new person gets the "new work" e-mail (0361), not a notice line', (select count(*) = 1 from public.staff_email_outbox
  where recipient = 'desk72@example.org' and kind = 'task_assigned' and sent_at is null)
  and pg_temp.lines('desk72@example.org') not like '%Welcome drinks%');
-- while that "new work" e-mail waits, further edits for that person are not noted (the e-mail shows the latest state)
update public.event_tasks set note = 'Chilled' where id = 'a0000000-0000-4000-8000-0000000f3722';
select pg_temp.t('3j nothing noted while a "new work" e-mail for the person waits', pg_temp.lines('desk72@example.org') not like '%Welcome drinks: instructions%');
update public.staff_email_outbox set status = 'sent', sent_at = now() where sent_at is null;
-- edits to a task that is closed and stays closed: quiet
update public.event_tasks set note = 'counted' where id = 'a0000000-0000-4000-8000-0000000f3723';
select pg_temp.t('3k edits to a closed task stay quiet', pg_temp.lines('cater72@example.org') not like '%Plate count%');
-- the event: date + venue reach everyone with open work; one notice each
delete from public.staff_update_outbox;
update public.quotes set event_date = event_date + 1, client = coalesce(client, '{}'::jsonb) || '{"venue":"Lake Palace"}'::jsonb
 where id = 'a0000000-0000-4000-8000-00000000da01';
select pg_temp.t('3l event date and venue reach the person with open work', pg_temp.lines('desk72@example.org') like '%Event date changed from % to %'
  and pg_temp.lines('desk72@example.org') like '%Venue changed from % to Lake Palace%', pg_temp.lines('desk72@example.org'));
select pg_temp.t('3m a person without open work on the event gets nothing', pg_temp.lines('cater72@example.org') = '', pg_temp.lines('cater72@example.org'));
-- the switch off: nothing queued
delete from public.staff_update_outbox;
insert into public.automation_settings(org_id, staff_email_enabled) values ('a0000000-0000-4000-8000-000000000001', false)
  on conflict (org_id) do update set staff_email_enabled = false;
update public.event_tasks set note = 'Smile' where id = 'a0000000-0000-4000-8000-0000000f3721';
select pg_temp.t('3n switch "E-mail staff their tasks" off -> nothing', (select count(*) = 0 from public.staff_update_outbox));
update public.automation_settings set staff_email_enabled = true where org_id = 'a0000000-0000-4000-8000-000000000001';

-- ---- 4) the claim ------------------------------------------------------------------------------------------------------------------
update public.event_tasks set note = 'Smile please' where id = 'a0000000-0000-4000-8000-0000000f3721';
select pg_temp.sys();
update public.staff_update_outbox set not_before = now() - interval '1 second' where sent_at is null;
create temp table _c as select x from jsonb_array_elements(public.staff_update_claim(25)) x;
select pg_temp.t('4a the claim hands comms-dispatch one notice', (select count(*) = 1 and bool_and(x ->> 'kind' = 'task_update' and x ->> 'to' = 'desk72@example.org') from _c),
  (select count(*)::text from _c));
select pg_temp.t('4b ... with the lines, the event and the open tasks now', (select position('instructions updated' in (x -> 'changes')::text) > 0
  and x ->> 'event' = 'Rao Wedding' and jsonb_array_length(x -> 'tasks') >= 1 from _c));
select pg_temp.t('4c ... and the permanent link', (select (x ->> 'link_path') ~ '^work\.html\?staff=[0-9a-f]{64}$' from _c), (select x ->> 'link_path' from _c));
select public.staff_update_mark((select (x ->> 'id')::uuid from _c), 'sent');
select pg_temp.t('4d marked sent; a second claim finds nothing', jsonb_array_length(public.staff_update_claim(25)) = 0);
-- event cancelled: still told (the only notice a cancelled event allows)
select pg_temp.office();
update public.quotes set status = 'cancelled' where id = 'a0000000-0000-4000-8000-00000000da01';
select pg_temp.sys();
select pg_temp.t('4e an event cancelled by the office: a cancel notice is queued', (select bool_or(cancelled) from public.staff_update_outbox
  where recipient = 'desk72@example.org' and sent_at is null), pg_temp.notes('desk72@example.org')::text);
update public.staff_update_outbox set not_before = now() - interval '1 second' where sent_at is null;
create temp table _c2 as select x from jsonb_array_elements(public.staff_update_claim(25)) x;
select pg_temp.t('4f ... and it is sent even though the event is no longer live', (select count(*) >= 1 and bool_and((x ->> 'cancelled')::boolean)
  and bool_and(jsonb_array_length(x -> 'tasks') = 0) from _c2 where x ->> 'to' = 'desk72@example.org'));
update public.quotes set status = 'confirmed' where id = 'a0000000-0000-4000-8000-00000000da01';
-- a normal staff e-mail now links to the permanent link
delete from public.staff_update_outbox;
insert into public.staff_email_outbox (org_id, quote_id, task_id, crew_id, phone, kind, recipient, name, dedupe_key, not_before) values
  ('a0000000-0000-4000-8000-000000000001', 'a0000000-0000-4000-8000-00000000da01', 'a0000000-0000-4000-8000-0000000f3721', 'a0000000-0000-4000-8000-0000000c3721',
   '919000037211', 'task_list', 'desk72@example.org', 'Guest Desk', 'r172|list', now() - interval '1 second');
create temp table _c3 as select x from jsonb_array_elements(public.staff_email_claim(25)) x;
select pg_temp.t('4g staff e-mails (tasks / reminders) now carry the permanent link', (select bool_and((x ->> 'link_path') ~ '^work\.html\?staff=[0-9a-f]{64}$')
  and count(*) = 1 from _c3 where x ->> 'kind' = 'task_list'), (select string_agg(x ->> 'link_path', ',') from _c3));

-- ---- 5) re-run safe ---------------------------------------------------------------------------------------------------------
select pg_temp.t('5a claim kept once, the new claim is the R172 one',
  to_regprocedure('public.staff_email_claim__pre0363(integer)') is not null and to_regprocedure('public.staff_email_claim__pre0363__pre0363(integer)') is null
  and position('r172-0363' in pg_get_functiondef(to_regprocedure('public.staff_email_claim(integer)'))) > 0
  and position('r172-0363' in pg_get_functiondef(to_regprocedure('public.staff_email_claim__pre0363(integer)'))) = 0);
select pg_temp.t('5b one trigger each', (select count(*) = 2 from pg_trigger where tgname in ('zzz_r363_task_changed', 'zzz_r363_event_changed')));

do $$ declare n int; f int; r record; begin
  select count(*), count(*) filter (where result <> 'PASS') into n, f from _rs;
  for r in select * from _rs where result <> 'PASS' loop raise warning '% -> %', r.name, r.result; end loop;
  if f = 0 then raise warning 'R172-UPDATE-NOTICES-0363: ALL PASS (%/%)', n, n;
  else raise warning 'R172-UPDATE-NOTICES-0363: % FAILED of %', f, n; end if;
end $$;
rollback;
