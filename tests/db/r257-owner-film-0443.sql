-- r257-owner-film-0443.sql - R257 (0443): (1) applied twice, no stored row changed, privileges, kept bodies; (2) the studio's own name / accent /
-- logo on the crew link, approval, portal and proposal answers (never another studio's, only a safe https logo, the earlier fields kept, a dead
-- link still refused); (3) payment reminders ask for what is left, none when nothing is left, a waiting automatic one is skipped, the 0435 rule
-- stays; (4) "Receipt recorded"; (5) who checked a person in; (6) when check-in opens. Local disposable PG only. Fake data only. Rolled back.
\set ON_ERROR_STOP 0
set client_min_messages = error;
begin;
create temp table _rs(name text, result text); grant all on _rs to anon, authenticated, service_role;
create or replace function pg_temp.t(p_name text, p_ok boolean, p_detail text default '') returns void language plpgsql as $$
begin insert into _rs values (p_name, case when coalesce(p_ok, false) then 'PASS' else 'FAIL: ' || left(coalesce(p_detail, ''), 500) end); end $$;
create or replace function pg_temp.anon_j(p_sql text) returns jsonb language plpgsql as $$
declare v jsonb;
begin
  perform auth.login_anon(); execute p_sql into v; perform auth.logout(); execute 'reset role'; return v;
exception when others then perform auth.logout(); execute 'reset role'; return jsonb_build_object('err', sqlstate || ' ' || sqlerrm);
end $$;
create or replace function pg_temp.digest() returns text language sql as $$
  select md5(concat_ws('#', (select string_agg(to_jsonb(m)::text, '|' order by m.id) from public.payment_milestones m), (select string_agg(to_jsonb(p)::text, '|' order by p.id) from public.quote_payments p),
    (select string_agg(to_jsonb(q)::text, '|' order by q.id) from public.quotes q), (select string_agg(to_jsonb(o)::text, '|' order by o.id) from public.organizations o),
    (select string_agg(to_jsonb(c)::text, '|' order by c.id) from public.comms_outbox c), (select string_agg(to_jsonb(k)::text, '|' order by k.id) from public.crew_checkins k))) $$;
create temp table _d as select pg_temp.digest() as d;
\ir ../../supabase/migrations/0443_r257_owner_film.sql
\ir ../../supabase/migrations/0443_r257_owner_film.sql
set client_min_messages = error;
select pg_temp.t('1a no stored row changed (twice)', (select d = pg_temp.digest() from _d));
select pg_temp.t('1b helpers + kept bodies: server only', not exists (select 1 from pg_proc p, unnest(array['anon', 'authenticated']) r where p.pronamespace = 'public'::regnamespace
   and (p.proname like '\_r443\_%' or p.proname like '%\_\_pre0443') and has_function_privilege(r, p.oid, 'execute')));
select pg_temp.t('1c helpers: definer + empty search_path', (select count(*) = 4 and bool_and(p.prosecdef and p.proconfig @> array['search_path=""']) from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname like '\_r443\_%'));
select pg_temp.t('1d kept bodies are the old ones, kept once', (select count(*) = 9 and bool_and(position('r257-0443' in p.prosrc) = 0) from pg_proc p where p.proname like '%\_\_pre0443'), (select string_agg(proname, ',') from pg_proc where proname like '%\_\_pre0443'));
select pg_temp.t('1e the changed names keep their callers', has_function_privilege('anon', 'public.worker_get_tasks(uuid)', 'execute') and has_function_privilege('anon', 'public.public_get_portal(uuid)', 'execute')
   and has_function_privilege('anon', 'public.public_quote_ready(uuid)', 'execute') and has_function_privilege('anon', 'public.public_get_proposal(uuid)', 'execute') and has_function_privilege('anon', 'public.crew_link_home(uuid)', 'execute')
   and not has_function_privilege('authenticated', 'public._comms_queue_pay(uuid,text,text,boolean,uuid)', 'execute') and not has_function_privilege('anon', 'public._comms_queue_pay(uuid,text,text,boolean,uuid)', 'execute')
   and not has_function_privilege('anon', 'public.comms_outbox_claim(integer)', 'execute') and not has_function_privilege('anon', 'public._r21_cost_lines__pre0372(uuid,uuid)', 'execute'));

\set A '\'a0000000-0000-4000-8000-000000000001\''
\set B '\'b0000000-0000-4000-8000-000000000001\''
\set Q '\'a0000000-0000-4000-8000-00000000da01\''
-- an event of studio A that is approved, tomorrow; the studio has a name, an accent and a logo
update public.organizations set name = 'Aurora Events', brand = jsonb_build_object('accent', '#0f7a43', 'logo', 'https://cdn.example.com/aurora.png', 'phone', '+91 1', 'billing', jsonb_build_object('legal_name', 'SECRET')) where id = :A;
update public.organizations set name = 'Other Studio', brand = '{"logo":"https://cdn.example.com/other.png"}' where id = :B;
update public.quotes set deleted_at = null, archived_at = null, status = 'confirmed', lifecycle_stage = 'confirmed', approval_status = 'approved', title = 'Rao wedding', is_demo = false, event_date = ((now() at time zone 'Asia/Kolkata')::date),
       approval_token = 'a0000000-0000-4000-8000-000000443001', approval_token_expires_at = now() + interval '20 days', approval_token_revoked_at = null,
       client = coalesce(client, '{}'::jsonb) || '{"name":"Riya","email":"riya@example.com"}' where id = :Q;
delete from public.work_tokens where quote_id = :Q;
insert into public.work_tokens(token, quote_id, phone, name, org_id, expires_at) values ('a0000000-0000-4000-8000-000000443002', :Q, '+91 90000 44301', 'Kavya Menon', :A, now() + interval '5 days');
insert into public.event_tasks (id, quote_id, org_id, category, title, assignee_name, assignee_phone, status) values ('a0000000-0000-4000-8000-000000443101', :Q, :A, 'Decor', 'Linen', 'Kavya Menon', '+91 90000 44301', 'assigned');
delete from public.event_proposal where quote_id = :Q;
insert into public.event_proposal(quote_id, org_id, share_token, published, concept, theme) values (:Q, :A, 'a0000000-0000-4000-8000-000000443003', true, 'x', 'Gold');

create temp table _v as select pg_temp.anon_j('select public.worker_get_tasks(''a0000000-0000-4000-8000-000000443002'')') as w, pg_temp.anon_j('select public.public_quote_ready(''a0000000-0000-4000-8000-000000443001'')') as r,
  pg_temp.anon_j('select public.public_get_portal(''a0000000-0000-4000-8000-000000443001'')') as p, pg_temp.anon_j('select public.public_get_proposal(''a0000000-0000-4000-8000-000000443003'')') as s;
select pg_temp.t('2a the crew link answers its own studio and the tasks as before', (select w -> 'studio' = '{"name":"Aurora Events","accent":"#0f7a43","logo":"https://cdn.example.com/aurora.png"}'::jsonb and w #>> '{event,code}' is not null
   and w #>> '{worker,name}' = 'Kavya Menon' and (w #> '{tasks,0}') ? 'waits_for' from _v), (select w::text from _v));
select pg_temp.t('2b the approval page: name + logo', (select r ->> 'studio' = 'Aurora Events' and r ->> 'logo' = 'https://cdn.example.com/aurora.png' and r ? 'priced' and r ? 'wa' from _v), (select r::text from _v));
select pg_temp.t('2c the portal: name, accent, logo - nothing else of the brand', (select p #>> '{studio,name}' = 'Aurora Events' and p #>> '{studio,logo}' = 'https://cdn.example.com/aurora.png' and p #>> '{studio,brand,accent}' = '#0f7a43'
   and position('SECRET' in p::text) = 0 from _v), (select p::text from _v));
select pg_temp.t('2d the proposal: the studio', (select s #>> '{studio,name}' = 'Aurora Events' and s ->> 'theme' = 'Gold' from _v), (select s::text from _v));
update public.organizations set brand = '{"logo":"javascript:alert(1)","accent":"red"}' where id = :A;
select pg_temp.t('2e an unsafe logo / accent is not answered', pg_temp.anon_j('select public.worker_get_tasks(''a0000000-0000-4000-8000-000000443002'')') -> 'studio' = '{"name":"Aurora Events"}'::jsonb
   and not (pg_temp.anon_j('select public.public_quote_ready(''a0000000-0000-4000-8000-000000443001'')') ? 'logo') and not ((pg_temp.anon_j('select public.public_get_portal(''a0000000-0000-4000-8000-000000443001'')') -> 'studio') ? 'logo'));
update public.work_tokens set expires_at = now() - interval '1 minute', revoked_at = now() where token = 'a0000000-0000-4000-8000-000000443002';
select pg_temp.t('2f a dead crew link is refused as before', pg_temp.anon_j('select public.worker_get_tasks(''a0000000-0000-4000-8000-000000443002'')') ? 'err');
select pg_temp.t('2g an unknown link answers nothing', pg_temp.anon_j('select public.public_quote_ready(''a0000000-0000-4000-8000-0000004430ff'')') is null and pg_temp.anon_j('select public.public_get_portal(''a0000000-0000-4000-8000-0000004430ff'')') ? 'err');
update public.work_tokens set expires_at = now() + interval '5 days', revoked_at = null where token = 'a0000000-0000-4000-8000-000000443002';

-- ---- 3) reminders -----------------------------------------------------------------------------------------------------------------------------
delete from public.comms_settings where org_id = :A; insert into public.comms_settings(org_id, pay_enabled) values (:A, true);
delete from public.comms_outbox where quote_id = :Q; delete from public.quote_payments where quote_id = :Q; delete from public.payment_milestones where quote_id = :Q;
update public.quotes set pricing = coalesce(pricing, '{}'::jsonb) || '{"total":100000}' where id = :Q;
insert into public.payment_milestones (id, quote_id, org_id, seq, label, amount, due_date, status) values
  ('a0000000-0000-4000-8000-000000443201', :Q, :A, 1, 'Advance (30%)', 30000, current_date - 3, 'due'), ('a0000000-0000-4000-8000-000000443202', :Q, :A, 2, 'Balance', 70000, current_date + 1, 'due');
select pg_temp.t('3a nothing paid: the whole payment', public._r443_left('a0000000-0000-4000-8000-000000443201') = 30000 and public._r443_left('a0000000-0000-4000-8000-000000443202') = 70000);
insert into public.quote_payments (quote_id, org_id, amount, status, provider, method, paid_at, receipt_no) values (:Q, :A, 20000, 'paid', 'cash', 'cash', now(), 'R443-1');
select pg_temp.t('3b part paid: what is left of the first, the second untouched', public._r443_left('a0000000-0000-4000-8000-000000443201') = 10000 and public._r443_left('a0000000-0000-4000-8000-000000443202') = 70000);
select pg_temp.t('3c one reminder is queued', public._comms_queue_pay('a0000000-0000-4000-8000-000000443201', 'due', 'is due', false, null) = 1);
select pg_temp.t('3c2 the reminder asks for what is left', (select payload ->> 'text' ~ '10,000' and replace(payload ->> 'text', '(the rest of Rs. 30,000)', '') !~ '30,000' from public.comms_outbox where quote_id = :Q), (select string_agg(payload::text, ' ') from public.comms_outbox where quote_id = :Q));
insert into public.quote_payments (quote_id, org_id, amount, status, provider, method, paid_at, receipt_no) values (:Q, :A, 15000, 'paid', 'cash', 'cash', now(), 'R443-2');
select pg_temp.t('3d covered: nothing left, the rest goes to the next one', public._r443_left('a0000000-0000-4000-8000-000000443201') = 0 and public._r443_left('a0000000-0000-4000-8000-000000443202') = 65000);
select pg_temp.t('3e no reminder when nothing is left, not even by hand', public._comms_queue_pay('a0000000-0000-4000-8000-000000443201', 'late1', 'is late', false, null) = 0 and public._comms_queue_pay('a0000000-0000-4000-8000-000000443201', 'manual', 'is due', true, null) = 0);
select count(*) from public.comms_outbox_claim(5) \g /dev/null
select pg_temp.t('3f the automatic one that was waiting is skipped, never sent', (select bool_and(status = 'skipped') from public.comms_outbox where quote_id = :Q and milestone_id = 'a0000000-0000-4000-8000-000000443201'), (select string_agg(status, ',') from public.comms_outbox where quote_id = :Q));
update public.quotes set approval_status = 'sent', status = 'quote', lifecycle_stage = 'quote' where id = :Q;
select pg_temp.t('3g before the client approves nothing is sent (0435)', public._comms_queue_pay('a0000000-0000-4000-8000-000000443202', 'before', 'is due', false, null) = 0);
update public.quotes set approval_status = 'approved', status = 'confirmed', lifecycle_stage = 'confirmed' where id = :Q;
insert into public.payment_milestones (id, quote_id, org_id, seq, label, amount, due_date, status) values ('a0000000-0000-4000-8000-000000443203', :Q, :A, 3, 'Waived', 500, current_date, 'waived');
select pg_temp.t('3h a waived or unknown payment has nothing left', public._r443_left('a0000000-0000-4000-8000-000000443203') = 0 and public._r443_left(gen_random_uuid()) = 0);

select pg_temp.t('4a the activity mail says Receipt recorded', public._r23_label('payment_receipt', '{}'::jsonb) = 'Receipt recorded' and public._r23_label('advance_paid', '{}'::jsonb) = 'Payment received', public._r23_label('payment_receipt', '{}'::jsonb));

-- ---- 5) who checked the person in ----------------------------------------------------------------------------------------------------------------
insert into public.crew_members (id, name, phone, email, org_id, active, day_rate) values ('a0000000-0000-4000-8000-000000443301', 'Kavya Menon', '+91 90000 44301', 'kavya443@example.org', :A, true, 1000);
update public.event_tasks set crew_id = 'a0000000-0000-4000-8000-000000443301', status = 'accepted', planned_start = now() + interval '8 hours' where id = 'a0000000-0000-4000-8000-000000443101';
create or replace function pg_temp.note() returns text language sql as $$ select l ->> 'note' from jsonb_array_elements(public._r21_cost_lines('a0000000-0000-4000-8000-00000000da01', 'a0000000-0000-4000-8000-000000000001')) l where l ->> 'source' = 'crew' and l ->> 'label' = 'Kavya Menon' $$;
insert into public.crew_checkins (org_id, quote_id, crew_id, work_day, check_in_at, source) values (:A, :Q, 'a0000000-0000-4000-8000-000000443301', current_date, now() - interval '3 hours', 'office');
select pg_temp.t('5a checked in by the office', pg_temp.note() like 'checked in by the office (1 day)%', pg_temp.note());
update public.crew_checkins set source = 'crew' where crew_id = 'a0000000-0000-4000-8000-000000443301';
select pg_temp.t('5b on the crew link as before', pg_temp.note() = 'checked in on the crew link (1 day)', pg_temp.note());
insert into public.crew_checkins (org_id, quote_id, crew_id, work_day, check_in_at, source) values (:A, :Q, 'a0000000-0000-4000-8000-000000443301', current_date - 1, now() - interval '27 hours', 'office');
select pg_temp.t('5c both', pg_temp.note() = 'checked in on the crew link and by the office (2 days)', pg_temp.note());
select pg_temp.t('5d only the words changed: the same amounts', (select (l - 'note') is not null and (l ->> 'days')::int = 2 and (l ->> 'actual')::numeric = 2000 from jsonb_array_elements(public._r21_cost_lines(:Q, :A)) l where l ->> 'source' = 'crew' and l ->> 'label' = 'Kavya Menon'));
delete from public.crew_checkins where crew_id = 'a0000000-0000-4000-8000-000000443301';

-- ---- 6) when check-in opens ------------------------------------------------------------------------------------------------------------------------
create temp table _h as select pg_temp.anon_j('select public.crew_link_home(''a0000000-0000-4000-8000-000000443002'')') -> 'checkin' as c;
select pg_temp.t('6a opens_ts is the same moment as opens_at (studio time) and now_ts is the server time', (select c is null or (c ->> 'opens_ts') is null
   or (to_char((c ->> 'opens_ts')::timestamptz at time zone coalesce((select o.timezone from public.organizations o where o.id = :A), 'Asia/Kolkata'), 'HH24:MI') = c ->> 'opens_at' and abs(extract(epoch from (now() - (c ->> 'now_ts')::timestamptz))) < 5) from _h), (select c::text from _h));
select pg_temp.t('6b the rest of the answer is there', (select c ? 'today_ok' and c ? 'expected_start' and c ? 'opens_at' and c ? 'opens_ts' and c ? 'now_ts' from _h), (select c::text from _h));

select name, result from _rs where result <> 'PASS' order by name;
select 'R257-OWNER-FILM-0443: ' || case when count(*) filter (where result <> 'PASS') = 0 then 'ALL PASS' else 'FAIL' end || ' (' || count(*) filter (where result = 'PASS') || '/' || count(*) || ')' from _rs;
rollback;
