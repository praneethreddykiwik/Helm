-- r187-cantwork-approval-0370.sql - R187: a day a staff member marks as cannot work is a REQUEST the office approves.
-- Proves (0370 applied twice first = re-run safe): (1) an existing marked day (from before 0370) counts as approved and is
-- not changed; (2) the staff link asks (pending), the office is told (bell row + e-mail to owner / admins / managers / Staff
-- editors, never sales without Staff edit), a free trial is in-app only; (3) the buffer is checked on the SERVER in the
-- studio time zone (today .. today + 6 refused with the friendly sentence, today + 7 allowed), changing a reason and
-- freeing a day always work, the buffer is a studio setting (Control Center edit only, 0..60); (4) only owner / admin /
-- Staff editors decide, other studio / anon refused; approve keeps the day off, turn down frees it; the staff member gets
-- an e-mail and sees it on both links until "OK, got it" (time recorded); (5) the office grid marks a day inside the buffer
-- (approved at once) and freeing a pending request from the grid counts as turned down; (6) the assign warning / range /
-- conflicts carry pending vs approved, nothing blocks assigning; (7) the e-mail claim re-checks rows; grants.
-- Local disposable PG only. Fake data only. Rolled back.
\set ON_ERROR_STOP 0
set client_min_messages = error;
begin;
\i supabase/migrations/0370_r187_cantwork_approval.sql
\i supabase/migrations/0370_r187_cantwork_approval.sql
set client_min_messages = warning;
create temp table _rc(name text, result text); grant all on _rc to anon, authenticated, service_role;
create temp table _rkv(k text primary key, v text); grant all on _rkv to anon, authenticated, service_role;
create or replace function pg_temp.su() returns void language plpgsql as $$
begin execute 'reset role'; perform auth.logout(); execute 'reset role'; end $$;
create or replace function pg_temp.login(p_email text) returns void language plpgsql as $$
declare u uuid; begin
  perform pg_temp.su(); select id into u from auth.users where email = p_email;
  perform set_config('request.jwt.claims', jsonb_build_object('sub', u, 'role', 'authenticated', 'email', p_email, 'aal', 'aal1')::text, false);
  perform set_config('role', 'authenticated', false);
end $$;
create or replace function pg_temp.anon() returns void language plpgsql as $$
begin perform pg_temp.su(); perform auth.login_anon(); end $$;
create or replace function pg_temp.res(p_name text, p_ok boolean, p_detail text default '') returns void language plpgsql as $$
begin insert into _rc values (p_name, case when coalesce(p_ok, false) then 'PASS' else 'FAIL: ' || coalesce(p_detail, '') end); end $$;
create or replace function pg_temp.try(p_sql text) returns text language plpgsql as $$
begin execute p_sql; return ''; exception when others then return sqlstate || ' ' || sqlerrm; end $$;
create or replace function pg_temp.j(p_sql text) returns jsonb language plpgsql as $$
declare v jsonb; begin execute p_sql into v; return v; exception when others then return jsonb_build_object('err', sqlstate || ' ' || sqlerrm); end $$;
create or replace function pg_temp.put(p_k text, p_v text) returns void language plpgsql as $$
begin insert into _rkv values (p_k, p_v) on conflict (k) do update set v = excluded.v; end $$;
create or replace function pg_temp.get(p_k text) returns text language sql as $$ select v from _rkv where k = p_k $$;
grant execute on function pg_temp.res(text, boolean, text), pg_temp.try(text), pg_temp.j(text), pg_temp.put(text, text), pg_temp.get(text)
  to anon, authenticated, service_role;

-- ---- setup: studio A in a far-east time zone (its today can differ from UTC), Ravi (on the event) + Mala; studio B ------------------
do $$ declare a uuid := 'a0000000-0000-4000-8000-000000000001'; b uuid := 'b0000000-0000-4000-8000-000000000001';
  q uuid := 'a0000000-0000-4000-8000-00000000da01'; c uuid; v_today date;
begin
  perform pg_temp.su();
  update public.organizations set timezone = 'Pacific/Kiritimati' where id = a;
  v_today := public._a198_org_today(a);
  perform pg_temp.put('today', v_today::text);
  update public.quotes set status = 'confirmed', lifecycle_stage = 'confirmed', event_date = v_today + 10, deleted_at = null where id = q;
  delete from public.app_config where key in ('crew', 'cantwork') and org_id = a;   -- test transaction only: start from the defaults
  insert into public.crew_members(name, phone, email, org_id) values ('Ravi Kumar', '+919800018701', 'ravi187@example.org', a) returning id into c;
  perform pg_temp.put('ravi', c::text);
  insert into public.event_tasks(quote_id, category, title, crew_id, assignee_name, assignee_phone, status, org_id)
    values (q, 'Setup', 'Load in', c, 'Ravi Kumar', '+919800018701', 'accepted', a);
  insert into public.work_tokens(token, quote_id, phone, name, org_id) values ('f1870000-0000-4000-8000-000000000001', q, '+919800018701', 'Ravi Kumar', a);
  insert into public.staff_links(org_id, crew_id, token) values (a, c, repeat('ab', 32));
  insert into public.crew_members(name, phone, org_id) values ('Mala', '+919800018702', a) returning id into c;
  perform pg_temp.put('mala', c::text);
  -- a day marked before 0370 (no approval columns set): the grandfathered row
  insert into public.crew_availability(org_id, crew_id, day, status, note, source) values (a, c, v_today + 2, 'unavailable', 'old reason', 'crew');
  -- a manager with an e-mail (gets the request e-mail); a_staff (sales, no Staff edit) must not
  update public.profiles set role = 'manager' where email = 'a_staff@a.test';
end $$;

-- ---- 1) grandfathered rows: approved, untouched --------------------------------------------------------------------------------------
select pg_temp.login('a_admin@a.test');
do $$ declare v jsonb; begin
  v := pg_temp.j(format('select public.crew_availability_range(%L, %L, null)', pg_temp.get('today'), (pg_temp.get('today')::date + 30)::text));
  perform pg_temp.su();
  perform pg_temp.res('01 a day marked before 0370 reads as approved (empty approval column, row not changed)',
    exists (select 1 from jsonb_array_elements(v) x where x ->> 'crew_id' = pg_temp.get('mala') and x ->> 'approval' = 'approved' and x ->> 'note' = 'old reason')
    and (select approval is null and requested_at is null and decided_at is null from public.crew_availability where crew_id = pg_temp.get('mala')::uuid), v::text);
end $$;

-- ---- 2) the staff link: buffer (studio time zone), request, office told -----------------------------------------------------------
select pg_temp.anon();
do $$ declare e text; v jsonb; d date := pg_temp.get('today')::date; begin
  e := pg_temp.try(format('select public.crew_set_availability(%L, %L, %L, %L)', 'f1870000-0000-4000-8000-000000000001', d + 6, 'unavailable', 'wedding'));
  perform pg_temp.res('02 buffer: today + 6 (studio day) refused on the server with the friendly sentence',
    e like '22023%Too close - days within a week can''t be blocked here. Please call your manager.%', e);
  e := pg_temp.try(format('select public.crew_set_availability(%L, %L, %L, %L)', 'f1870000-0000-4000-8000-000000000001', d, 'unavailable', null));
  perform pg_temp.res('03 buffer: today refused too', e like '22023%Too close%', e);
  v := pg_temp.j(format('select public.crew_set_availability(%L, %L, %L, %L)', 'f1870000-0000-4000-8000-000000000001', d + 7, 'unavailable', 'Family <b>function</b>'));
  perform pg_temp.res('04 today + 7 allowed: a pending request (reason cleaned)', v ->> 'approval' = 'pending' and (v ->> 'buffer_days')::int = 7, v::text);
  v := pg_temp.j(format('select public.crew_link_home(%L)', 'f1870000-0000-4000-8000-000000000001'));
  perform pg_temp.res('05 link page: the day shows as pending, the buffer and first day are given',
    exists (select 1 from jsonb_array_elements(v -> 'availability') x where x ->> 'day' = (d + 7)::text and x ->> 'approval' = 'pending')
    and (v #>> '{cantwork,buffer_days}')::int = 7 and v #>> '{cantwork,first_day}' = (d + 7)::text, v::text);
end $$;
select pg_temp.su();
do $$ declare a uuid := 'a0000000-0000-4000-8000-000000000001'; begin
  perform pg_temp.res('06 bell notice for the office (name + day only)',
    exists (select 1 from public.notifications n where n.org_id = a and n.kind = 'crew_cantwork_request' and n.quote_id is null and n.channel = 'in_app'
             and n.detail ->> 'worker' = 'Ravi Kumar' and n.detail ->> 'day' = (pg_temp.get('today')::date + 7)::text));
  perform pg_temp.res('07 request e-mail to the admin and the manager, never sales without Staff edit, nothing to the staff member',
    exists (select 1 from public.cantwork_email_outbox o where o.org_id = a and o.kind = 'request' and o.recipient = 'a_admin@a.test')
    and exists (select 1 from public.cantwork_email_outbox o where o.org_id = a and o.kind = 'request' and o.recipient = 'a_staff@a.test')
    and not exists (select 1 from public.cantwork_email_outbox o where o.org_id = a and o.recipient = 'ravi187@example.org'),
    (select string_agg(recipient || ':' || kind, ',') from public.cantwork_email_outbox));
  update public.profiles set role = 'sales' where email = 'a_staff@a.test';
end $$;
select pg_temp.su();
do $$ declare v jsonb; e text; d date := pg_temp.get('today')::date; n int; begin
  -- change the reason of the day asked for: allowed, still pending, no second notice
  select count(*) into n from public.notifications where kind = 'crew_cantwork_request';
  perform pg_temp.anon();
  v := pg_temp.j(format('select public.crew_set_availability(%L, %L, %L, %L)', 'f1870000-0000-4000-8000-000000000001', d + 7, 'unavailable', 'Exam'));
  perform pg_temp.su();
  perform pg_temp.res('08 changing the reason keeps the request pending and tells nobody again',
    v ->> 'approval' = 'pending' and (select count(*) from public.notifications where kind = 'crew_cantwork_request') = n
    and (select note from public.crew_availability where crew_id = pg_temp.get('ravi')::uuid and day = d + 7) = 'Exam', v::text);
end $$;

-- ---- 3) who decides; approve / turn down ---------------------------------------------------------------------------------------------
select pg_temp.su();
select pg_temp.put('req1', (select a.id::text from public.crew_availability a where a.crew_id = pg_temp.get('ravi')::uuid and a.approval = 'pending'));
select pg_temp.login('a_staff@a.test');
do $$ declare e text; v jsonb; id uuid := pg_temp.get('req1')::uuid; begin
  e := pg_temp.try(format('select public.cantwork_decide(%L, %L, null)', id, 'approve'));
  perform pg_temp.res('09 sales without Staff edit cannot decide', e like '42501%', e);
end $$;
select pg_temp.login('b_admin@b.test');
do $$ declare e text; begin
  e := pg_temp.try(format('select public.cantwork_decide(%L, %L, null)', pg_temp.get('req1'), 'approve'));
  perform pg_temp.res('10 another studio: not found', e like 'P0002%', e);
end $$;
select pg_temp.anon();
do $$ declare e text; begin
  e := pg_temp.try(format('select public.cantwork_decide(%L, %L, null)', pg_temp.get('req1'), 'approve'));
  perform pg_temp.res('11 anon cannot decide', e <> '' and e not like 'P0002%', e);
  e := pg_temp.try('select public.cantwork_requests(''open'')');
  perform pg_temp.res('12 anon cannot list requests', e <> '', e);
end $$;
select pg_temp.login('a_admin@a.test');
do $$ declare v jsonb; begin
  v := pg_temp.j('select public.cantwork_requests(''open'')');
  perform pg_temp.res('13 list: one waiting (badge 1), reason, booked flag, can decide',
    (v ->> 'pending')::int = 1 and (v ->> 'can_decide')::boolean
    and exists (select 1 from jsonb_array_elements(v -> 'items') x where x ->> 'id' = pg_temp.get('req1') and x ->> 'note' = 'Exam' and x ->> 'approval' = 'pending'), v::text);
  v := pg_temp.j(format('select public.cantwork_decide(%L, %L, %L)', pg_temp.get('req1'), 'approve', 'Enjoy <script>'));
  perform pg_temp.su();
  perform pg_temp.res('14 approve: day stays off, decided by + note recorded, worker e-mail queued',
    v ->> 'approval' = 'approved'
    and (select status = 'unavailable' and decided_by is not null and decided_at is not null and ack_at is null and decision_note = 'Enjoy  script'
           from public.crew_availability where id = pg_temp.get('req1')::uuid)
    and exists (select 1 from public.cantwork_email_outbox o where o.avail_id = pg_temp.get('req1')::uuid and o.kind = 'decision' and o.recipient = 'ravi187@example.org')
    and exists (select 1 from public.audit_log where action = 'cantwork.approve' and entity_id = pg_temp.get('req1')), v::text);
  perform pg_temp.login('a_admin@a.test');
  v := pg_temp.j(format('select public.cantwork_decide(%L, %L, null)', pg_temp.get('req1'), 'approve'));
  perform pg_temp.res('15 approve twice: already, nothing new', (v ->> 'already')::boolean, v::text);
  v := pg_temp.j('select public.cantwork_requests(''all'')');
  perform pg_temp.res('16 list: none waiting now, the answer in the last 30 days', (v ->> 'pending')::int = 0
    and exists (select 1 from jsonb_array_elements(v -> 'items') x where x ->> 'id' = pg_temp.get('req1') and x ->> 'approval' = 'approved'), v::text);
end $$;

-- ---- 4) the staff member sees it and acknowledges (event link + permanent link) ---------------------------------------------------
select pg_temp.anon();
do $$ declare v jsonb; e text; begin
  v := pg_temp.j(format('select public.crew_link_home(%L)', 'f1870000-0000-4000-8000-000000000001'));
  perform pg_temp.res('17 event link: the decision is shown with the note',
    exists (select 1 from jsonb_array_elements(v #> '{cantwork,decisions}') x where x ->> 'approval' = 'approved' and x ->> 'decision_note' = 'Enjoy  script'), v::text);
  v := pg_temp.j(format('select public.staff_link_cantwork(%L)', repeat('ab', 32)));
  perform pg_temp.res('18 permanent link: the same decision', (v ->> 'ok')::boolean and jsonb_array_length(v -> 'decisions') = 1, v::text);
  v := pg_temp.j(format('select public.staff_link_cantwork(%L)', repeat('cd', 32)));
  perform pg_temp.res('19 an unknown permanent link sees nothing', v ->> 'ok' = 'false', v::text);
  v := pg_temp.j(format('select public.crew_cantwork_ack(%L, %L)', 'f1870000-0000-4000-8000-000000000001', (pg_temp.get('today')::date + 7)::text));
  perform pg_temp.su();
  perform pg_temp.res('20 OK, got it: acknowledgement time recorded, decision gone from the link',
    (v ->> 'acknowledged')::int = 1 and (select ack_at is not null from public.crew_availability where id = pg_temp.get('req1')::uuid)
    and jsonb_array_length(public.staff_link_cantwork(repeat('ab', 32)) -> 'decisions') = 0, v::text);
  perform pg_temp.anon();
  e := pg_temp.try(format('select public.crew_cantwork_ack(%L, null)', 'f1870000-0000-4000-8000-0000000000ff'));
  perform pg_temp.res('21 a bad event link cannot acknowledge', e <> '', e);
end $$;

-- ---- 5) turn down; freeing; re-asking ---------------------------------------------------------------------------------------------
select pg_temp.anon();
do $$ declare v jsonb; d date := pg_temp.get('today')::date; begin
  v := pg_temp.j(format('select public.crew_set_availability(%L, %L, %L, null)', 'f1870000-0000-4000-8000-000000000001', d + 9, 'unavailable'));
  perform pg_temp.su();
  perform pg_temp.put('req2', (select id::text from public.crew_availability where crew_id = pg_temp.get('ravi')::uuid and day = d + 9));
end $$;
select pg_temp.login('a_admin@a.test');
do $$ declare v jsonb; d date := pg_temp.get('today')::date; st jsonb; begin
  st := pg_temp.j(format('select public.crew_day_status(%L, null)', (d + 9)::text));
  perform pg_temp.res('22 assign warning: pending says pending (assigning is never blocked)',
    exists (select 1 from jsonb_array_elements(st) x where x ->> 'crew_id' = pg_temp.get('ravi') and (x ->> 'unavailable')::boolean and x ->> 'approval' = 'pending'), st::text);
  -- the event is on d + 10 and Ravi works it: the office marks that day off (approved) -> Conflicts says approved
  perform public.crew_availability_set(pg_temp.get('ravi')::uuid, d + 10, 'unavailable', 'doctor');
  st := pg_temp.j(format('select public.crew_unavailable_conflicts(%L, %L)', d::text, (d + 30)::text));
  perform pg_temp.res('23 conflicts: a day off with work on it carries its approval',
    exists (select 1 from jsonb_array_elements(st) x where x ->> 'crew_id' = pg_temp.get('ravi') and x ->> 'day' = (d + 10)::text and x ->> 'approval' = 'approved'), st::text);
  v := pg_temp.j(format('select public.cantwork_decide(%L, %L, %L)', pg_temp.get('req2'), 'reject', 'Big wedding that day'));
  st := public.crew_day_status(d + 9, null);
  perform pg_temp.su();
  perform pg_temp.res('24 turn down: the day is free again (no warning), the decision stays for the staff member',
    v ->> 'approval' = 'rejected' and (select status = 'available' and approval = 'rejected' from public.crew_availability where id = pg_temp.get('req2')::uuid)
    and not exists (select 1 from jsonb_array_elements(st) x where x ->> 'crew_id' = pg_temp.get('ravi') and (x ->> 'unavailable')::boolean), v::text);
end $$;
select pg_temp.anon();
do $$ declare v jsonb; d date := pg_temp.get('today')::date; begin
  v := pg_temp.j(format('select public.staff_link_cantwork(%L)', repeat('ab', 32)));
  perform pg_temp.res('25 the staff member sees "not approved" with the note',
    exists (select 1 from jsonb_array_elements(v -> 'decisions') x where x ->> 'approval' = 'rejected' and x ->> 'decision_note' = 'Big wedding that day'), v::text);
  v := pg_temp.j(format('select public.staff_link_cantwork_ack(%L, null)', repeat('ab', 32)));
  perform pg_temp.res('26 OK, got it on the permanent link', (v ->> 'acknowledged')::int = 1, v::text);
  -- freeing an approved day inside the buffer is always allowed
  perform pg_temp.su();
  update public.crew_availability set day = d + 3 where id = pg_temp.get('req1')::uuid;
  perform pg_temp.anon();
  v := pg_temp.j(format('select public.crew_set_availability(%L, %L, %L, null)', 'f1870000-0000-4000-8000-000000000001', d + 3, 'available'));
  perform pg_temp.su();
  perform pg_temp.res('27 freeing a day inside the buffer works', v ->> 'status' = 'available'
    and (select status = 'available' and approval is null from public.crew_availability where id = pg_temp.get('req1')::uuid), v::text);
end $$;

-- ---- 6) the office grid + the buffer setting ---------------------------------------------------------------------------------------
select pg_temp.login('a_admin@a.test');
do $$ declare v jsonb; e text; d date := pg_temp.get('today')::date; begin
  v := pg_temp.j(format('select public.crew_availability_set(%L, %L, %L, %L)', pg_temp.get('ravi'), (d + 1)::text, 'unavailable', 'called in sick'));
  perform pg_temp.su();
  perform pg_temp.res('28 office marks a day inside the buffer: approved at once',
    v ->> 'approval' = 'approved' and (select approval = 'approved' and decided_at is not null from public.crew_availability where crew_id = pg_temp.get('ravi')::uuid and day = d + 1), v::text);
  perform pg_temp.login('a_admin@a.test');
  e := pg_temp.try('select public.cantwork_settings_set(61)');
  perform pg_temp.res('29 buffer setting: 0..60 only', e like '22023%', e);
  v := pg_temp.j('select public.cantwork_settings_set(3)');
  perform pg_temp.res('30 buffer setting saved by an admin', (v ->> 'buffer_days')::int = 3, v::text);
end $$;
select pg_temp.login('b_admin@b.test');
do $$ declare v jsonb; begin
  v := pg_temp.j('select public.cantwork_settings_set(0)');
  perform pg_temp.su();
  perform pg_temp.res('31 another studio changing its buffer leaves this studio at 3', (v ->> 'buffer_days')::int = 0
    and public._r370_buffer('a0000000-0000-4000-8000-000000000001') = 3 and public._r370_buffer('b0000000-0000-4000-8000-000000000001') = 0, v::text);
end $$;
select pg_temp.anon();
do $$ declare e text; begin
  e := pg_temp.try('select public.cantwork_settings_set(0)');
  perform pg_temp.res('31b anon cannot change the buffer', e <> '', e);
end $$;
select pg_temp.anon();
do $$ declare v jsonb; e text; d date := pg_temp.get('today')::date; begin
  v := pg_temp.j(format('select public.crew_set_availability(%L, %L, %L, null)', 'f1870000-0000-4000-8000-000000000001', d + 4, 'unavailable'));
  e := pg_temp.try(format('select public.crew_set_availability(%L, %L, %L, null)', 'f1870000-0000-4000-8000-000000000001', d + 2, 'unavailable'));
  perform pg_temp.res('32 a 3-day buffer: today + 4 allowed, today + 2 refused with the 3-day sentence',
    v ->> 'approval' = 'pending' and e like '22023%within the next 3 days%', v::text || ' / ' || e);
  perform pg_temp.su();
  perform pg_temp.put('req3', (select id::text from public.crew_availability where crew_id = pg_temp.get('ravi')::uuid and day = d + 4));
end $$;
select pg_temp.login('a_admin@a.test');
do $$ declare v jsonb; d date := pg_temp.get('today')::date; begin
  v := pg_temp.j(format('select public.crew_availability_set(%L, %L, %L, null)', pg_temp.get('ravi'), (d + 4)::text, 'available'));
  perform pg_temp.su();
  perform pg_temp.res('33 freeing a pending request on the grid counts as turned down (the staff member is told)',
    v ->> 'approval' = 'rejected' and (select ack_at is null and decided_at is not null from public.crew_availability where id = pg_temp.get('req3')::uuid)
    and exists (select 1 from public.cantwork_email_outbox o where o.avail_id = pg_temp.get('req3')::uuid and o.kind = 'decision'), v::text);
end $$;

-- ---- 7) free trial: in-app only; the claim re-checks ------------------------------------------------------------------------------
select pg_temp.su();
do $$ declare a uuid := 'a0000000-0000-4000-8000-000000000001'; n0 int; n1 int; b0 int; v jsonb; d date := pg_temp.get('today')::date; begin
  -- the claim: a request that was decided since is skipped, the decision e-mail goes out
  v := public.cantwork_email_claim(50);
  perform pg_temp.res('34 claim: decided requests skipped, the decision e-mails handed out with the permanent link',
    not exists (select 1 from jsonb_array_elements(v) x where x ->> 'kind' = 'request' and x ->> 'to' = 'a_admin@a.test' and x ->> 'day' = to_char(d + 7, 'DD/MM/YYYY'))
    and exists (select 1 from jsonb_array_elements(v) x where x ->> 'kind' = 'decision' and x ->> 'link_path' = 'work.html?staff=' || repeat('ab', 32)),
    v::text);
  perform pg_temp.res('35 mark sent', public.cantwork_email_mark((v -> 0 ->> 'id')::uuid, 'sent') = 'sent');
  insert into public.studio_subscriptions (org_id, status) values (a, 'trial') on conflict (org_id) do update set status = 'trial';
  select count(*) into n0 from public.cantwork_email_outbox; select count(*) into b0 from public.notifications where kind = 'crew_cantwork_request';
  perform pg_temp.anon();
  perform public.crew_set_availability('f1870000-0000-4000-8000-000000000001', d + 20, 'unavailable', null);
  perform pg_temp.su();
  select count(*) into n1 from public.cantwork_email_outbox;
  perform pg_temp.res('36 free trial: bell notice yes, e-mail no',
    _tb179_no_send(a) is not false and n1 = n0 and (select count(*) from public.notifications where kind = 'crew_cantwork_request') = b0 + 1,
    n0 || '/' || n1 || ' trial=' || coalesce(public._tb179_no_send(a)::text, 'null'));
end $$;

-- ---- 8) closed table + grants ----------------------------------------------------------------------------------------------------
select pg_temp.su();
select pg_temp.res('37 e-mail queue: RLS on, closed to the app; claim / mark server only',
  coalesce((select relrowsecurity from pg_class where oid = 'public.cantwork_email_outbox'::regclass), false)
  and not has_table_privilege('authenticated', 'public.cantwork_email_outbox', 'select')
  and not has_function_privilege('authenticated', 'public.cantwork_email_claim(integer)', 'execute')
  and not has_function_privilege('anon', 'public.cantwork_email_mark(uuid,text)', 'execute')
  and not has_function_privilege('anon', 'public.crew_link_home__pre0370(uuid)', 'execute')
  and has_function_privilege('anon', 'public.crew_link_home(uuid)', 'execute'));
select pg_temp.res('38 wrapped once after two runs; free-trial purge lists the queue once',
  (select count(*) from pg_proc where proname = 'crew_link_home__pre0370') = 1
  and (to_regprocedure('public._tr184_purge_tables()') is null
       or (length(pg_get_functiondef('public._tr184_purge_tables()'::regprocedure))
           - length(replace(pg_get_functiondef('public._tr184_purge_tables()'::regprocedure), '''cantwork_email_outbox''', ''))) = length('''cantwork_email_outbox''')));

select name, result from _rc order by name;
select case when (select count(*) from _rc where result <> 'PASS') = 0
            then 'R187-CANTWORK-APPROVAL-0370: ALL PASS (' || (select count(*) from _rc) || '/' || (select count(*) from _rc) || ')'
            else 'R187-CANTWORK-APPROVAL-0370: FAILURES' end as summary;
rollback;
