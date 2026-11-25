-- r254-e2e-fixes-0437.sql - R254 (0437). Proves: (1) applied twice: no stored row changed, privileges, kept bodies; (2) making a link: none ->
-- sent as before, paid / approved stay (first link, after Revoke), stale -> sent (reissue) as before, the advance basis and payment dates
-- untouched, no message; (3) the client validity reminder skips a confirmed event when queued AND when sent, still goes for an open one;
-- (4) public_get_quote answers the live date; pricing byte-identical, the rest of the answer identical, approval_check_shown the same; a wrong
-- link is refused; (5) arrived_at / left_at through every move, nobody can send them, one row per booking, duplicates are never deleted;
-- crew check-in with a row already there; (6) a rejection needs a reason for every role, refusals as before. Local disposable PG only. Rolled back.
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

-- ---- 1) applied twice -------------------------------------------------------------------------------------------------------------------
create temp table _before as select (select md5(coalesce(string_agg(to_jsonb(t)::text, '|' order by t.id), '')) from public.quotes t) as q,
  (select md5(coalesce(string_agg((to_jsonb(t) - 'arrived_at' - 'left_at')::text, '|' order by t.id), '')) from public.event_day t) as d, (select count(*) from public.notifications) as n;
\ir ../../supabase/migrations/0437_r254_e2e_fixes.sql
\ir ../../supabase/migrations/0437_r254_e2e_fixes.sql
set client_min_messages = warning;
select pg_temp.t('1a no stored row changed (twice)', (select b.q = (select md5(coalesce(string_agg(to_jsonb(t)::text, '|' order by t.id), '')) from public.quotes t)
  and b.d = (select md5(coalesce(string_agg((to_jsonb(t) - 'arrived_at' - 'left_at')::text, '|' order by t.id), '')) from public.event_day t) and b.n = (select count(*) from public.notifications) from _before b));
select pg_temp.t('1b new functions + kept bodies: server only; new ones definer + empty search_path', not exists (
  select 1 from pg_proc p, unnest(array['anon', 'authenticated']) r where p.pronamespace = 'public'::regnamespace and (p.proname like '\_r437\_%' or p.proname like '%\_\_pre0437') and has_function_privilege(r, p.oid, 'execute'))
  and not exists (select 1 from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname like '\_r437\_%' and not (p.prosecdef and p.proconfig @> array['search_path=""'])));
select pg_temp.t('1c seven kept bodies, none with the new text; every edit is in', (select count(*) = 7 and bool_and(position('r254-0437' in prosrc) = 0) from pg_proc where proname like '%\_\_pre0437')
  and (select bool_and(position('r254-0437' in pg_get_functiondef(f::regprocedure)) > 0) from unnest(array['public.generate_approval_token__pre0039(uuid)', 'public.quote_validity_tick()', 'public._qv262_claim(integer)', 'public.public_get_quote(uuid)',
   'public.crew_check(uuid,text,numeric,numeric,numeric)', 'public.crew_checkin_office_set(uuid,uuid,date,timestamptz,timestamptz,text)', 'public.verify_task(uuid,boolean,text)']) f));
select pg_temp.t('1d grants: verify_task signed-in + server, not anon; the others as they were', not has_function_privilege('anon', 'public.verify_task(uuid,boolean,text)', 'execute')
  and has_function_privilege('authenticated', 'public.verify_task(uuid,boolean,text)', 'execute') and has_function_privilege('service_role', 'public.verify_task(uuid,boolean,text)', 'execute')
  and has_function_privilege('anon', 'public.public_get_quote(uuid)', 'execute') and has_function_privilege('authenticated', 'public.generate_approval_token(uuid)', 'execute')
  and not has_function_privilege('anon', 'public.generate_approval_token(uuid)', 'execute') and not has_function_privilege('authenticated', 'public.generate_approval_token__pre0039(uuid)', 'execute')
  and not has_function_privilege('authenticated', 'public.quote_validity_tick()', 'execute') and not has_function_privilege('authenticated', 'public._qv262_claim(integer)', 'execute')
  and has_function_privilege('anon', 'public.crew_check(uuid,text,numeric,numeric,numeric)', 'execute') and not has_function_privilege('anon', 'public.crew_checkin_office_set(uuid,uuid,date,timestamptz,timestamptz,text)', 'execute'));
grant execute on function public.verify_task(uuid, boolean, text) to public, anon;
set client_min_messages = error;
\ir ../../supabase/migrations/0437_r254_e2e_fixes.sql
set client_min_messages = warning;
select pg_temp.t('1e a database where anon could run verify_task (Canada, a copy): taken away by 0437', not has_function_privilege('anon', 'public.verify_task(uuid,boolean,text)', 'execute') and has_function_privilege('authenticated', 'public.verify_task(uuid,boolean,text)', 'execute'));

\set A '\'a0000000-0000-4000-8000-000000000001\''
create or replace function pg_temp.q(p_n text) returns uuid language sql as $$ select ('a0000000-0000-4000-8000-00004370' || p_n)::uuid $$;
create or replace function pg_temp.mkq(p_n text, p_status text default 'quote', p_stage text default 'quote', p_appr text default 'none') returns uuid language plpgsql as $$
begin
  insert into public.quotes (id, code, title, status, lifecycle_stage, client, pricing, approval_status, org_id, event_date, event_time, current_version)
  values (pg_temp.q(p_n), 'R437-' || p_n, 'E2E ' || p_n, p_status, p_stage, '{"name":"Riya","email":"riya437@example.org","phone":"+919800043700"}'::jsonb,
    '{"client":{"name":"Riya","eventType":"wedding","eventDate":"2027-01-10"},"subtotal":1000,"discount":0,"gstPct":0,"total":1000}'::jsonb, p_appr, 'a0000000-0000-4000-8000-000000000001', '2027-01-10', '18:00', 1);
  return pg_temp.q(p_n);
end $$;
create or replace function pg_temp.link(p_n text) returns text language sql as $$ select pg_temp.as_val('a_admin@a.test', format('select public.generate_approval_token(%L)::text', pg_temp.q(p_n))) $$;
create or replace function pg_temp.ap(p_n text) returns text language sql as $$ select approval_status from public.quotes where id = pg_temp.q(p_n) $$;

-- ---- 2) making a link ---------------------------------------------------------------------------------------------------------------------
select pg_temp.mkq('0001'); select pg_temp.link('0001');
select pg_temp.t('2a none -> sent, as before', pg_temp.ap('0001') = 'sent');
select pg_temp.mkq('0002');
select pg_temp.as_val('a_admin@a.test', format('select public.record_payment(%L, 300, ''cash'', null, null, null, null)::text', pg_temp.q('0002')));
select pg_temp.t('2b0 booked by an advance, no link yet', (select approval_status = 'paid' and approval_token is null from public.quotes where id = pg_temp.q('0002')) and public._r435_approval(pg_temp.q('0002')) ->> 'basis' = 'advance', pg_temp.ap('0002'));
create temp table _ms as select (select jsonb_agg(to_jsonb(m) order by m.id) from public.payment_milestones m where m.quote_id = pg_temp.q('0002')) as m, (select count(*) from public.notifications where quote_id = pg_temp.q('0002')) as n,
  (select count(*) from public.comms_outbox where quote_id = pg_temp.q('0002')) as c, (select count(*) from public.quote_advance_log where quote_id = pg_temp.q('0002')) as a, public._r435_approval(pg_temp.q('0002')) as b, (select stage from public.quote_stage_current where quote_ref = pg_temp.q('0002')) as st;
select pg_temp.t('2b the first link for a paid booking', pg_temp.link('0002') like 'ok:%');
select pg_temp.t('2c it stays paid, the advance basis and its time kept, the link works', pg_temp.ap('0002') = 'paid' and (select b = public._r435_approval(pg_temp.q('0002')) and b ->> 'advance_at' is not null from _ms)
  and (select approval_token is not null and approval_token_revoked_at is null and approval_token_expires_at > now() from public.quotes where id = pg_temp.q('0002')), public._r435_approval(pg_temp.q('0002'))::text);
select pg_temp.t('2d payment plan and dates, stage, messages, advance history: nothing moved', (select m is not distinct from (select jsonb_agg(to_jsonb(x) order by x.id) from public.payment_milestones x where x.quote_id = pg_temp.q('0002'))
  and n = (select count(*) from public.notifications where quote_id = pg_temp.q('0002')) and c = (select count(*) from public.comms_outbox where quote_id = pg_temp.q('0002')) and a = (select count(*) from public.quote_advance_log where quote_id = pg_temp.q('0002'))
  and st is not distinct from (select stage from public.quote_stage_current where quote_ref = pg_temp.q('0002')) from _ms));
select pg_temp.as_val('a_admin@a.test', format('select public.revoke_approval_token(%L)::text', pg_temp.q('0002')));
select pg_temp.t('2e Revoke: still paid', pg_temp.ap('0002') = 'paid'); select pg_temp.link('0002'); select pg_temp.t('2e2 a new link after it: still paid', pg_temp.ap('0002') = 'paid' and (select approval_token is not null and approval_token_revoked_at is null from public.quotes where id = pg_temp.q('0002')));
select pg_temp.mkq('0003', 'confirmed', 'planning', 'approved'); select pg_temp.link('0003');
select pg_temp.t('2f approved (price not changed): stays approved', pg_temp.ap('0003') = 'approved');
select pg_temp.mkq('0004', 'quote', 'quote', 'approved'); update public.quotes set consent_stale = true, approval_status = 'sent' where id = pg_temp.q('0004');
select pg_temp.t('2g the price changed after the approval (reissue) works as before', pg_temp.as_val('a_admin@a.test', format('select public.reissue_approval_link(%L)::text', pg_temp.q('0004'))) like 'ok:%');
select pg_temp.t('2g2 sent', pg_temp.ap('0004') = 'sent');
select pg_temp.mkq('0005', 'quote', 'quote', 'paid'); update public.quotes set consent_stale = true where id = pg_temp.q('0005'); select pg_temp.link('0005');
select pg_temp.t('2h paid AND the price changed after an approval: sent, as before', pg_temp.ap('0005') = 'sent');
select pg_temp.mkq('0006', 'quote', 'quote', 'cancelled'); select pg_temp.link('0006'); select pg_temp.t('2i after a plain Revoke: sent, as before', pg_temp.ap('0006') = 'sent');
select pg_temp.t('2j another studio / signed out: refused as before', pg_temp.as_val('b_admin@b.test', format('select public.generate_approval_token(%L)::text', pg_temp.q('0002'))) not like 'ok:%' and pg_temp.as_val('anon', format('select public.generate_approval_token(%L)::text', pg_temp.q('0002'))) not like 'ok:%');

-- ---- 3) the client reminder ------------------------------------------------------------------------------------------------------------------
delete from public.app_config where key = 'quote_validity' and org_id = :A;
insert into public.app_config(org_id, key, value, updated_at) values (:A, 'quote_validity', '{"enabled": true, "client_reminders": true, "reminder_days": [3]}'::jsonb, now());
select pg_temp.mkq('0011'); select pg_temp.mkq('0012', 'confirmed', 'planning'); select pg_temp.mkq('0013', 'quote', 'planning'); select pg_temp.link('0011'); select pg_temp.link('0012'); select pg_temp.link('0013');
select pg_temp.t('3a all three say sent', pg_temp.ap('0011') || pg_temp.ap('0012') || pg_temp.ap('0013') = 'sentsentsent');
insert into public.quote_validity (quote_id, org_id, valid_until, source) select pg_temp.q(x), :A, public._a198_org_today(:A) + 3, 'manual' from unnest(array['0011', '0012', '0013']) x on conflict (quote_id) do update set valid_until = excluded.valid_until;
select public.quote_validity_tick();
create or replace function pg_temp.qe(p_n text) returns integer language sql as $$ select count(*)::integer from public.comms_outbox where quote_id = pg_temp.q(p_n) and purpose = 'quote_expiry' $$;
select pg_temp.t('3b the open quote gets the e-mail, confirmed (by status / by stage) none', pg_temp.qe('0011') = 1 and pg_temp.qe('0012') = 0 and pg_temp.qe('0013') = 0, pg_temp.qe('0011') || '/' || pg_temp.qe('0012') || '/' || pg_temp.qe('0013'));
savepoint cl; update public.quotes set status = 'confirmed' where id = pg_temp.q('0011'); select public.comms_outbox_claim(100);
select pg_temp.t('3c confirmed after it was queued: skipped when it would be sent', (select status = 'skipped' from public.comms_outbox where quote_id = pg_temp.q('0011') and purpose = 'quote_expiry'));
select coalesce(jsonb_agg(to_jsonb(r)), '[]') as keep from _rs r \gset
rollback to savepoint cl;
insert into _rs select x ->> 'name', x ->> 'result' from jsonb_array_elements((:'keep')::jsonb) x where not exists (select 1 from _rs r where r.name = x ->> 'name');
select pg_temp.t('3d still open: handed out', (select count(*) = 1 from jsonb_array_elements(public.comms_outbox_claim(100)) x where x ->> 'purpose' = 'quote_expiry'));
delete from public.app_config where key = 'quote_validity' and org_id = :A;

-- ---- 4) the approval page's date ----------------------------------------------------------------------------------------------------------------
create temp table _pg as select public.public_get_quote(q.approval_token) as j, q.pricing::text as raw from public.quotes q where q.id = pg_temp.q('0011');
update public.quotes set event_date = '2027-02-20', event_time = '19:30', event_end_date = '2027-02-21' where id = pg_temp.q('0011');
create temp table _pg2 as select public.public_get_quote(q.approval_token) as j, public.public_get_quote__pre0437(q.approval_token) as k, q.pricing::text as raw from public.quotes q where q.id = pg_temp.q('0011');
select pg_temp.t('4a the moved date, time and end date; the snapshot date stays in pricing', (select j ->> 'event_date' = '2027-02-20' and j ->> 'event_time' = '19:30' and j ->> 'event_end_date' = '2027-02-21' and j #>> '{pricing,client,eventDate}' = '2027-01-10' from _pg2), (select j::text from _pg2));
select pg_temp.t('4b pricing byte-identical before / after the move and before / after 0437; the stored pricing untouched; nothing else differs', (select (a.j -> 'pricing')::text = (b.j -> 'pricing')::text and (b.j -> 'pricing')::text = (b.k -> 'pricing')::text and a.raw = b.raw
  and b.j - 'event_date' - 'event_time' - 'event_end_date' = b.k from _pg a, _pg2 b));
select pg_temp.t('4c the total check of the approval is the same', (select public.approval_check_shown(approval_token, 1000) = '{"ok": true}'::jsonb and (public.approval_check_shown(approval_token, 999) ->> 'ok') = 'false' from public.quotes where id = pg_temp.q('0011')));
select pg_temp.t('4d one day event: end date null, the key is there', (select j ? 'event_end_date' and j -> 'event_end_date' = 'null'::jsonb from (select public.public_get_quote(approval_token) j from public.quotes where id = pg_temp.q('0012')) z));
select pg_temp.t('4e a wrong link is refused as before', pg_temp.as_val('anon', $q$select public.public_get_quote('a0000000-0000-4000-8000-0000000437ff')::text$q$) not like 'ok:%');
select pg_temp.t('4f the portal already shows the live date', (select (public.public_get_portal(approval_token))::text like '%2027-02-20%' from public.quotes where id = pg_temp.q('0011')));

-- ---- 5) day-of record ------------------------------------------------------------------------------------------------------------------------------
create or replace function pg_temp.dv(p text) returns public.event_day language sql as $$ select d from public.event_day d where d.quote_id = pg_temp.q('0012') and d.who = p $$;
create or replace function pg_temp.setd(p text, s text) returns void language sql as $$ update public.event_day set status = s where quote_id = pg_temp.q('0012') and who = p $$;
insert into public.event_day (quote_id, org_id, kind, who, role, ref_id, status) values (pg_temp.q('0012'), :A, 'arrival', 'V1', 'vendor', gen_random_uuid(), 'expected');
select pg_temp.t('5a expected: no times', (pg_temp.dv('V1')).arrived_at is null and (pg_temp.dv('V1')).left_at is null);
select pg_temp.setd('V1', 'arrived'); select pg_temp.t('5b arrived: arrived_at', (pg_temp.dv('V1')).arrived_at = now() and (pg_temp.dv('V1')).left_at is null);
alter table public.event_day disable trigger zz_r437_day_times; update public.event_day set arrived_at = now() - interval '3 hours' where who = 'V1' and quote_id = pg_temp.q('0012'); alter table public.event_day enable trigger zz_r437_day_times;
update public.event_day set note = 'x' where who = 'V1' and quote_id = pg_temp.q('0012'); select pg_temp.setd('V1', 'arrived');
select pg_temp.t('5c arrived again: the first time stays', (pg_temp.dv('V1')).arrived_at = now() - interval '3 hours');
select pg_temp.setd('V1', 'left'); select pg_temp.t('5d left: left_at, arrived_at kept', (pg_temp.dv('V1')).arrived_at = now() - interval '3 hours' and (pg_temp.dv('V1')).left_at = now());
select pg_temp.setd('V1', 'arrived'); select pg_temp.t('5e undo to arrived: the ORIGINAL arrived_at, left_at cleared', (pg_temp.dv('V1')).arrived_at = now() - interval '3 hours' and (pg_temp.dv('V1')).left_at is null);
select pg_temp.setd('V1', 'left'); select pg_temp.setd('V1', 'expected'); select pg_temp.t('5f back to expected: both cleared', (pg_temp.dv('V1')).arrived_at is null and (pg_temp.dv('V1')).left_at is null);
select pg_temp.setd('V1', 'arrived'); select pg_temp.setd('V1', 'no_show'); select pg_temp.t('5g did not come: both cleared', (pg_temp.dv('V1')).arrived_at is null and (pg_temp.dv('V1')).left_at is null);
insert into public.event_day (quote_id, org_id, kind, who, role, ref_id, status) values (pg_temp.q('0012'), :A, 'arrival', 'V2', 'vendor', 'a0000000-0000-4000-8000-000043700f02', 'left');
select pg_temp.t('5h made directly as left: left_at only', (pg_temp.dv('V2')).arrived_at is null and (pg_temp.dv('V2')).left_at = now());
insert into public.event_day (quote_id, org_id, kind, who, status) values (pg_temp.q('0012'), :A, 'check', 'C1', 'done'); select pg_temp.t('5i a check row has no times', (pg_temp.dv('C1')).arrived_at is null and (pg_temp.dv('C1')).left_at is null);
select pg_temp.t('5j the page cannot send the times', pg_temp.as_val('a_admin@a.test', format('update public.event_day set arrived_at = ''2020-01-01'', left_at = ''2020-01-02'' where quote_id = %L and who = ''V2'' returning (arrived_at is null and left_at > now() - interval ''1 day'')::text', pg_temp.q('0012'))) = 'ok:true'
  and pg_temp.as_val('a_admin@a.test', format('insert into public.event_day (quote_id, kind, who, status, arrived_at) values (%L, ''arrival'', ''V3'', ''expected'', ''2020-01-01'') returning (arrived_at is null)::text', pg_temp.q('0012'))) = 'ok:true');
select pg_temp.t('5k the same vendor twice: refused with 23505', pg_temp.as_val('a_admin@a.test', format('insert into public.event_day (quote_id, kind, who, role, ref_id, status) values (%L, ''arrival'', ''V2 again'', ''vendor'', ''a0000000-0000-4000-8000-000043700f02'', ''arrived'') returning who', pg_temp.q('0012'))) like '23505%event_day_ref_uk437%');
insert into public.event_day (quote_id, org_id, kind, who, ref_id, status) values (pg_temp.q('0013'), :A, 'arrival', 'W', 'a0000000-0000-4000-8000-000043700f02', 'arrived'), (pg_temp.q('0012'), :A, 'check', 'W', 'a0000000-0000-4000-8000-000043700f02', 'done'),
  (pg_temp.q('0012'), :A, 'arrival', 'N', null, 'expected'), (pg_temp.q('0012'), :A, 'arrival', 'N', null, 'expected');
select pg_temp.t('5l the same ref on another event / another kind, and rows without a ref are fine', (select count(*) = 4 from public.event_day where who in ('W', 'N') and quote_id in (pg_temp.q('0012'), pg_temp.q('0013'))));
savepoint du; drop index public.event_day_ref_uk437;
insert into public.event_day (quote_id, org_id, kind, who, ref_id, status) values (pg_temp.q('0012'), :A, 'arrival', 'V2 copy', 'a0000000-0000-4000-8000-000043700f02', 'arrived');
create temp table _dc as select count(*) as n from public.event_day; set client_min_messages = error;
\ir ../../supabase/migrations/0437_r254_e2e_fixes.sql
set client_min_messages = warning;
select pg_temp.t('5m duplicates there: no guard, nothing deleted, the rest applies', to_regclass('public.event_day_ref_uk437') is null and (select n = (select count(*) from public.event_day) from _dc));
select coalesce(jsonb_agg(to_jsonb(r)), '[]') as keep from _rs r \gset
rollback to savepoint du;
insert into _rs select x ->> 'name', x ->> 'result' from jsonb_array_elements((:'keep')::jsonb) x where not exists (select 1 from _rs r where r.name = x ->> 'name');
set client_min_messages = warning;
insert into public.crew_members (id, name, phone, org_id, active) values ('a0000000-0000-4000-8000-0000000c4371', 'Anu Rao', '+91 90000 43712', :A, true);
insert into public.event_tasks (id, quote_id, org_id, category, title, crew_id, assignee_name, assignee_phone, status) values ('a0000000-0000-4000-8000-00000f543701', pg_temp.q('0012'), :A, 'S', 'T', 'a0000000-0000-4000-8000-0000000c4371', 'Anu Rao', '+91 90000 43712', 'in_progress');
update public.organizations set timezone = 'Asia/Kolkata' where id = :A;
update public.quotes set event_date = (now() at time zone 'Asia/Kolkata')::date where id = pg_temp.q('0012');
select pg_temp.t('5n office check-in makes the row', pg_temp.as_val('a_admin@a.test', format('select (public.crew_checkin_office_set(%L, ''a0000000-0000-4000-8000-0000000c4371'', (now() at time zone ''Asia/Kolkata'')::date, now() - interval ''2 minutes'', null, ''added by office'')) ->> ''ok''', pg_temp.q('0012'))) = 'ok:true',
  pg_temp.as_val('a_admin@a.test', format('select (public.crew_checkin_office_set(%L, ''a0000000-0000-4000-8000-0000000c4371'', (now() at time zone ''Asia/Kolkata'')::date, now() - interval ''2 minutes'', null, ''added by office''))::text', pg_temp.q('0012'))));
select pg_temp.as_val('a_admin@a.test', format('select (public.crew_checkin_office_set(%L, ''a0000000-0000-4000-8000-0000000c4371'', (now() at time zone ''Asia/Kolkata'')::date, now() - interval ''2 minutes'', now(), ''added by office''))::text', pg_temp.q('0012')));
select pg_temp.t('5o one row, left, both times', (select count(*) = 1 and bool_and(status = 'left' and arrived_at is not null and left_at is not null) from public.event_day where quote_id = pg_temp.q('0012') and ref_id = 'a0000000-0000-4000-8000-0000000c4371'));

-- ---- 6) a rejection needs a reason ------------------------------------------------------------------------------------------------------------------
update public.event_tasks set status = 'completed', completed_at = now() where id = 'a0000000-0000-4000-8000-00000f543701';
create or replace function pg_temp.vt(p_who text, p_pass text, p_note text) returns text language sql as $$ select pg_temp.as_val(p_who, format('select (public.verify_task(''a0000000-0000-4000-8000-00000f543701'', %s, %L)).verify_status', p_pass, p_note)) $$;
select pg_temp.t('6a admin without a reason: refused, nothing changed', pg_temp.vt('a_admin@a.test', 'false', '') = '22023 Please write what has to be done again.' and pg_temp.vt('a_admin@a.test', 'false', '   ') like '22023%' and pg_temp.vt('a_admin@a.test', 'false', null) like '22023%' and pg_temp.vt('a_admin@a.test', 'null', null) like '22023%'
  and (select verify_status = 'pending' and status = 'completed' from public.event_tasks where id = 'a0000000-0000-4000-8000-00000f543701'));
select pg_temp.t('6b signed out, another studio: refused as before', pg_temp.vt('anon', 'false', 'x') not like 'ok:%' and pg_temp.vt('b_admin@b.test', 'false', 'x') not like 'ok:%');
select pg_temp.t('6c with a reason: works', pg_temp.vt('a_admin@a.test', 'false', 'loose wing') = 'ok:rejected'); select pg_temp.t('6c2 kept', (select verify_note = 'loose wing' and status = 'in_progress' from public.event_tasks where id = 'a0000000-0000-4000-8000-00000f543701'));
insert into public.work_tokens (quote_id, phone, name, org_id, token) values (pg_temp.q('0012'), '+91 90000 43712', 'Anu Rao', :A, 'a0000000-0000-4000-8000-000000437001');
select pg_temp.t('6d the crew link is not affected (done again without any words)', pg_temp.as_val('anon', $q$select public.worker_respond('a0000000-0000-4000-8000-000000437001', 'a0000000-0000-4000-8000-00000f543701', 'complete') ->> 'ok'$q$) = 'ok:true');
select pg_temp.t('6e approving needs no words', pg_temp.vt('a_admin@a.test', 'true', null) = 'ok:passed');

select name, result from _rs where result <> 'PASS' order by name;
select case when count(*) filter (where result <> 'PASS') = 0
            then 'R254-E2E-FIXES-0437: ALL PASS (' || count(*) || '/' || count(*) || ')'
            else 'R254-E2E-FIXES-0437: FAILURES (' || count(*) filter (where result <> 'PASS') || ' of ' || count(*) || ')' end as summary
  from _rs;
rollback;
