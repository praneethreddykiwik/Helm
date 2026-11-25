-- r258-payment-followup-0445.sql - R258 (0445): (1) applied twice, no stored row changed, privileges, kept bodies; (2) the studio is reminded: the
-- working day before / on the day / every 3 days late, at its time, once, for what is left, only Finance edit; stops when paid / closed / held /
-- moved; trial bell only; (3) bell, inbox, e-mail lists: only the people named; (4) client reminders by hand: preview queues nothing, default off;
-- (5) the client's step: token, isolation, codes (own table, tries, single use, limits), "I have paid" records no money, studio answers it.
-- Local disposable PG only. Fake data only. Rolled back. Nothing is sent.
\set ON_ERROR_STOP 0
set client_min_messages = error;
begin;
create temp table _rs(name text, result text); grant all on _rs to anon, authenticated, service_role;
create or replace function pg_temp.t(p_name text, p_ok boolean, p_detail text default '') returns void language plpgsql as $$
begin insert into _rs values (p_name, case when coalesce(p_ok, false) then 'PASS' else 'FAIL: ' || left(coalesce(p_detail, ''), 600) end); end $$;
create or replace function pg_temp.as_j(p_role text, p_email text, p_sql text) returns jsonb language plpgsql as $$
declare v jsonb; u uuid;
begin
  if p_role = 'authenticated' then select id into u from auth.users where email = p_email; end if;
  perform set_config('request.jwt.claims', jsonb_strip_nulls(jsonb_build_object('sub', u, 'role', p_role, 'email', p_email, 'aal', 'aal1'))::text, true);
  perform set_config('role', p_role, true); execute p_sql into v;
  execute 'reset role'; perform set_config('request.jwt.claims', '', true); return v;
exception when others then execute 'reset role'; perform set_config('request.jwt.claims', '', true); return jsonb_build_object('err', sqlstate || ' ' || sqlerrm);
end $$;
create or replace function pg_temp.member(p_email text, p_role text, p_org uuid) returns uuid language plpgsql as $$
declare u uuid; begin
  select id into u from auth.users where email = p_email; if u is null then u := auth.seed_user(p_email); end if;
  insert into public.profiles(id, email, full_name, role, org_id, must_change_password, created_at) values (u, p_email, initcap(split_part(p_email, '@', 1)), p_role, p_org, false, now())
    on conflict (id) do update set org_id = excluded.org_id, role = excluded.role, full_name = excluded.full_name; return u; end $$;
create or replace function pg_temp.digest() returns text language sql as $$
  select md5(concat_ws('#', (select string_agg(to_jsonb(m)::text, '|' order by m.id) from public.payment_milestones m), (select string_agg(to_jsonb(p)::text, '|' order by p.id) from public.quote_payments p),
    (select string_agg(to_jsonb(q)::text, '|' order by q.id) from public.quotes q), (select string_agg(to_jsonb(o)::text, '|' order by o.id) from public.quote_otps o),
    (select string_agg(to_jsonb(c)::text, '|' order by c.id) from public.comms_outbox c), (select string_agg(to_jsonb(c)::text, '|' order by c.id) from public.quote_consents c),
    (select string_agg(to_jsonb(s)::text, '|' order by s.org_id) from public.comms_settings s))) $$;
create temp table _d as select pg_temp.digest() as d;
\ir ../../supabase/migrations/0445_r258_payment_followup.sql
\ir ../../supabase/migrations/0445_r258_payment_followup.sql
set client_min_messages = error;
select pg_temp.t('1a no stored row changed (twice)', (select d = pg_temp.digest() from _d));
select pg_temp.t('1b helpers + kept bodies: server only, search_path pinned', not exists (select 1 from pg_proc p, unnest(array['anon', 'authenticated']) r where p.pronamespace = 'public'::regnamespace
   and (p.proname like '\_r445\_%' or p.proname like '%\_\_pre0445') and has_function_privilege(r, p.oid, 'execute')));
select pg_temp.t('1c every body was changed once', (select count(*) = 7 and bool_and(position('r258-0445' in p.prosrc) = 0) from pg_proc p where p.proname like '%\_\_pre0445'), (select string_agg(proname, ',') from pg_proc where proname like '%\_\_pre0445'));
select pg_temp.t('1d the changed names keep their callers', has_function_privilege('authenticated', 'public.bell_feed(integer)', 'execute') and not has_function_privilege('anon', 'public.bell_feed(integer)', 'execute')
   and has_function_privilege('authenticated', 'public.notification_type_of(text,text)', 'execute') and not has_function_privilege('authenticated', 'public._comms_queue_pay(uuid,text,text,boolean,uuid)', 'execute')
   and not has_function_privilege('authenticated', 'public._r388_vis(uuid,uuid)', 'execute'));
select pg_temp.t('1e tables: no app privilege', not exists (select 1 from unnest(array['payment_team_reminders', 'payment_claims', 'payment_codes']) t, unnest(array['anon', 'authenticated']) r, unnest(array['select', 'insert', 'update', 'delete']) pv where has_table_privilege(r, 'public.' || t, pv))
   and not has_table_privilege('service_role', 'public.payment_codes', 'select'));
select pg_temp.t('1f trial retention knows the new tables', public._tr184_purge_tables() @> array['payment_team_reminders', 'payment_claims', 'payment_codes']);

\set A '\'a0000000-0000-4000-8000-000000000001\''
\set B '\'b0000000-0000-4000-8000-000000000001\''
\set Q '\'a0000000-0000-4000-8000-00000000da01\''
\set M1 '\'a0000000-0000-4000-8000-000000445201\''
\set M2 '\'a0000000-0000-4000-8000-000000445202\''
\set M3 '\'a0000000-0000-4000-8000-000000445203\''
\set TK '\'a0000000-0000-4000-8000-000000445001\''
select set_config('request.jwt.claims', '{"role":"service_role"}', true) \g /dev/null
select pg_temp.member('fin445@a.test', 'manager', :A), pg_temp.member('look445@a.test', 'sales', :A), pg_temp.member('crew445@a.test', 'crew', :A), pg_temp.member('adm445@a.test', 'admin', :A), pg_temp.member('adm445@b.test', 'admin', :B), pg_temp.member('off445@a.test', 'admin', :A) \g /dev/null
insert into public.role_access(org_id, role, area, can_view, can_edit) values (:A, 'manager', 'finance', true, true), (:A, 'manager', 'quotes', true, true), (:A, 'sales', 'finance', true, false), (:A, 'sales', 'quotes', true, false)
  on conflict (org_id, role, area) do update set can_view = excluded.can_view, can_edit = excluded.can_edit;
insert into public.team_member_status(user_id, org_id, status) select id, org_id, 'deactivated' from public.profiles where email = 'off445@a.test' on conflict do nothing;
delete from public.studio_subscriptions where org_id = :A; delete from public.studio_send_windows where org_id = :A;
update public.organizations set timezone = 'Asia/Kolkata', country = 'IN', name = 'Aurora Events' where id = :A;
update public.payment_milestones set status = 'waived' where org_id = :A and status in ('due', 'invoiced');
update public.quotes set deleted_at = null, archived_at = null, status = 'confirmed', lifecycle_stage = 'confirmed', approval_status = 'approved', title = 'Rao wedding', is_demo = false, event_date = '2026-12-20',
       approval_token = :TK, approval_token_expires_at = now() + interval '20 days', approval_token_revoked_at = null,
       client = coalesce(client, '{}'::jsonb) || '{"name":"Rohan Sharma","email":"rohan@example.com","phone":"+91 98480 12345"}', pricing = coalesce(pricing, '{}'::jsonb) || '{"total":230160}' where id = :Q;
delete from public.comms_outbox where quote_id = :Q; delete from public.quote_payments where quote_id = :Q; delete from public.payment_milestones where quote_id = :Q; delete from public.comms_settings where org_id = :A;
-- Mon 16 Nov 2026
insert into public.payment_milestones (id, quote_id, org_id, seq, label, amount, due_date, status) values (:M1, :Q, :A, 1, 'Second payment (50%)', 115080, '2026-11-16', 'due'), (:M2, :Q, :A, 2, 'Final balance (50%)', 115080, '2026-12-20', 'due');
create or replace function pg_temp.tick(p text) returns integer language sql as $$ select (public.payment_team_tick((p || '+05:30')::timestamptz) ->> 'payment_followups')::integer $$;
create or replace function pg_temp.last() returns jsonb language sql as $$ select detail from public.notifications where kind = 'payment_followup' order by created_at desc, (detail ->> 'days')::integer limit 1 $$;
create or replace function pg_temp.n() returns bigint language sql as $$ select count(*) from public.notifications where kind = 'payment_followup' $$;

select pg_temp.t('2a three days before: nothing', pg_temp.tick('2026-11-13 12:00') = 0);
select pg_temp.t('2b the working day before (Saturday, Sunday is skipped) but before 10:00: nothing', pg_temp.tick('2026-11-14 09:59') = 0);
select pg_temp.t('2c at 10:00 studio time: one bell', pg_temp.tick('2026-11-14 10:00') = 1 and pg_temp.n() = 1);
select pg_temp.t('2d the words', (select pg_temp.last() ->> 'label' = 'Rohan Sharma''s second payment of ' || chr(8377) || '1,15,080 is due on 16 Nov 2026. Call +91 98480 12345, or press Send reminder.'), (select pg_temp.last()::text));
select pg_temp.t('2e once per slot (again, and on Sunday)', pg_temp.tick('2026-11-14 10:15') = 0 and pg_temp.tick('2026-11-15 12:00') = 0);
select pg_temp.t('2f the due day: one more, "is due today"', pg_temp.tick('2026-11-16 10:05') = 1);
select pg_temp.t('2f2 the words', (select string_agg(detail ->> 'label', '|') ~ 'is due today\.' from public.notifications where kind = 'payment_followup' and detail ->> 'slot' = 'due'));
insert into public.quote_payments (quote_id, org_id, amount, status, provider, method, paid_at, receipt_no) values (:Q, :A, 65080, 'paid', 'cash', 'cash', now(), 'R445-1');
select pg_temp.t('2g one day late: what is left', pg_temp.tick('2026-11-17 10:05') = 1);
select pg_temp.t('2g2 the words', (select string_agg(detail ->> 'label', '|') ~ (chr(8377) || '50,000 of ' || chr(8377) || '1,15,080 is left and was due on 16 Nov 2026, 1 day late\.') from public.notifications where kind = 'payment_followup' and detail ->> 'slot' = 'late'), (select string_agg(detail ->> 'label', '|') from public.notifications where kind = 'payment_followup'));
select pg_temp.t('2h days 2 and 3 late: nothing; day 4: one', pg_temp.tick('2026-11-18 10:05') = 0 and pg_temp.tick('2026-11-19 10:05') = 0 and pg_temp.tick('2026-11-20 10:05') = 1);
select pg_temp.t('2i night (the staff send window): nothing, the next morning it comes', pg_temp.tick('2026-11-23 23:30') = 0 and pg_temp.tick('2026-11-24 10:05') = 1);
select pg_temp.t('2j the same moment twice (retry): once', pg_temp.tick('2026-11-24 10:05') = 0);
insert into public.quote_payments (quote_id, org_id, amount, status, provider, method, paid_at, receipt_no) values (:Q, :A, 50000, 'paid', 'cash', 'cash', now(), 'R445-2');
select pg_temp.t('2k nothing left: it stops (even while the row still says due)', pg_temp.tick('2026-11-27 10:05') = 0 and (select status = 'due' from public.payment_milestones where id = :M1));
delete from public.quote_payments where quote_id = :Q;
update public.quotes set lifecycle_stage = 'closed' where id = :Q;
select pg_temp.t('2l a closed event: nothing', pg_temp.tick('2026-11-30 10:05') = 0);
update public.quotes set lifecycle_stage = 'confirmed', status = 'cancelled' where id = :Q;
select pg_temp.t('2m a cancelled event: nothing', pg_temp.tick('2026-11-30 10:06') = 0);
update public.quotes set status = 'quote', approval_status = 'sent', lifecycle_stage = 'quote' where id = :Q;
select pg_temp.t('2n not approved yet: nothing (0435)', pg_temp.tick('2026-11-30 10:07') = 0);
update public.quotes set status = 'confirmed', approval_status = 'approved', lifecycle_stage = 'confirmed' where id = :Q;
update public.payment_milestones set due_date = '2026-12-02' where id = :M1;
select pg_temp.t('2o a moved date starts over: tomorrow', pg_temp.tick('2026-12-01 10:05') = 1);
select pg_temp.t('2o2 the words', (select string_agg(detail ->> 'label', '|') ~ 'is due tomorrow\.' from public.notifications where kind = 'payment_followup' and detail ->> 'due_date' = '2026-12-02'));
update public.payment_milestones set status = 'waived' where id = :M1;
select pg_temp.t('2p2 waived: nothing', pg_temp.tick('2026-12-02 10:05') = 0);
update public.payment_milestones set status = 'due' where id = :M1;
select pg_temp.t('2q0 switched off in Settings', (pg_temp.as_j('authenticated', 'adm445@a.test', 'select public.payment_team_settings_set(false, ''10:00'')') ->> 'on') = 'false');
select pg_temp.t('2q nothing', pg_temp.tick('2026-12-02 10:06') = 0);
select pg_temp.t('2r another time: 11:30', (pg_temp.as_j('authenticated', 'adm445@a.test', 'select public.payment_team_settings_set(true, ''11:30'')') ->> 'at') = '11:30');
select pg_temp.t('2r2 from then', pg_temp.tick('2026-12-02 11:29') = 0 and pg_temp.tick('2026-12-02 11:30') = 1);
select pg_temp.t('2s a wrong time / a person without Settings edit is refused', pg_temp.as_j('authenticated', 'adm445@a.test', 'select public.payment_team_settings_set(true, ''03:00'')') ->> 'err' like '22023%'
   and pg_temp.as_j('authenticated', 'crew445@a.test', 'select public.payment_team_settings_set(true, ''10:00'')') ->> 'err' like '42501%' and pg_temp.as_j('anon', null, 'select public.payment_team_settings_get()') ->> 'err' like '42501%', pg_temp.as_j('authenticated', 'crew445@a.test', 'select public.payment_team_settings_set(true, ''10:00'')')::text || pg_temp.as_j('authenticated', 'adm445@a.test', 'select public.payment_team_settings_set(true, ''03:00'')')::text || pg_temp.as_j('anon', null, 'select public.payment_team_settings_get()')::text);
update public.payment_schedule_settings set overdue_bell = true where org_id = :A;
insert into public.payment_overdue_alerts(milestone_id, org_id, quote_id, due_date) values (:M1, :A, :Q, '2026-12-02');
select pg_temp.t('2t the older overdue bell rang already: the first late one is left out, the next one comes', pg_temp.tick('2026-12-03 12:00') = 0);
select pg_temp.t('2t2 the next one comes', pg_temp.tick('2026-12-06 12:00') = 1);
-- trial: bell only; ended trial: nothing; a sample event only in a trial
update public.quotes set is_demo = true where id = :Q;
select pg_temp.t('2u a sample event in a paid studio: nothing', pg_temp.tick('2026-12-09 12:00') = 0);
insert into public.studio_subscriptions(org_id, status, trial_ends_at) values (:A, 'trial', '2027-12-30');
select pg_temp.t('2v in a free trial: the bell (and no e-mail: _tb179_no_send)', pg_temp.tick('2026-12-09 12:05') = 1 and public._tb179_no_send(:A));
delete from public.studio_subscriptions where org_id = :A; update public.quotes set is_demo = false where id = :Q;

select pg_temp.t('3a only Finance edit people are named (never view only, crew, deactivated, another studio)', (select detail -> 'notify' @> to_jsonb(array(select id::text from public.profiles where email in ('fin445@a.test', 'adm445@a.test')))
   and not exists (select 1 from public.profiles p where p.email in ('look445@a.test', 'crew445@a.test', 'off445@a.test', 'adm445@b.test') and (n.detail -> 'notify') ? p.id::text) from public.notifications n where n.kind = 'payment_followup' limit 1));
create or replace function pg_temp.sees(p_email text) returns boolean language sql as $$ select exists (select 1 from jsonb_array_elements(coalesce(pg_temp.as_j('authenticated', p_email, 'select public.bell_feed(50)') -> 'items', '[]')) e where e ->> 'kind' = 'payment_followup') $$;
select pg_temp.t('3b the bell of a Finance edit person shows it', pg_temp.sees('fin445@a.test') and pg_temp.sees('adm445@a.test'), pg_temp.as_j('authenticated', 'fin445@a.test', 'select public.bell_feed(50)')::text);
select pg_temp.t('3c nobody else''s bell', not pg_temp.sees('look445@a.test') and not pg_temp.sees('crew445@a.test') and not pg_temp.sees('adm445@b.test'));
select pg_temp.t('3d the inbox rule and the table read say the same', exists (select 1 from public._r23_visible(:A, (select id from public.profiles where email = 'fin445@a.test')) v where v.kind = 'payment_followup')
   and not exists (select 1 from public._r23_visible(:A, (select id from public.profiles where email = 'look445@a.test')) v where v.kind = 'payment_followup')
   and not exists (select 1 from public._r401_vis(:A, (select id from public.profiles where email = 'look445@a.test')) v where v.kind = 'payment_followup')
   and pg_temp.as_j('authenticated', 'look445@a.test', 'select to_jsonb(count(*)) from public.notifications where kind = ''payment_followup''') = '0'::jsonb
   and (pg_temp.as_j('authenticated', 'fin445@a.test', 'select to_jsonb(count(*)) from public.notifications where kind = ''payment_followup''') #>> '{}')::int > 0);
select pg_temp.t('3e the app cannot write one', pg_temp.as_j('authenticated', 'adm445@a.test', 'insert into public.notifications(quote_id, channel, kind, status, detail, org_id) values (''a0000000-0000-4000-8000-00000000da01'', ''in_app'', ''payment_followup'', ''simulated'', ''{}'', ''a0000000-0000-4000-8000-000000000001'') returning to_jsonb(1)') ->> 'err' like '42501%');
insert into public.notification_prefs(org_id, user_id, role, type, channel, enabled) select :A, id, 'manager', 'payment_overdue', 'in_app', false from public.profiles where email = 'fin445@a.test';
select pg_temp.t('3f2 hidden', not pg_temp.sees('fin445@a.test') and pg_temp.sees('adm445@a.test'));
delete from public.notification_prefs where org_id = :A and type = 'payment_overdue';
select pg_temp.t('3g inbox e-mails: instant people get it, with the words', public._r23_important('payment_followup') and public._r23_important('payment_received') and not public._r23_important('task_start')
   and public._r23_label('payment_followup', '{"label":"Rohan owes"}') = 'Rohan owes' and public._r23_label('payment', '{}') = 'Payment update');

-- ---- 4) client reminders ----------------------------------------------------------------------------------------------------------------------
delete from public.comms_settings where org_id = :A; delete from public.comms_outbox where quote_id = :Q;
update public.payment_milestones set due_date = public._pst_today(:A), amount = 115080 where id = :M1; update public.payment_milestones set amount = 115080 where id = :M2;
select public.comms_tick() \g /dev/null
select pg_temp.t('4a a studio that chose nothing: no automatic client reminder', not exists (select 1 from public.comms_outbox where quote_id = :Q));
insert into public.comms_settings(org_id, pay_enabled) values (:A, true);
select public.comms_tick() \g /dev/null
select pg_temp.t('4b a studio that switched it on keeps it', (select count(*) = 1 from public.comms_outbox where quote_id = :Q and purpose = 'pay_reminder'), (select string_agg(to_jsonb(c)::text, '|') from public.comms_outbox c where quote_id = :Q));
delete from public.comms_settings where org_id = :A; delete from public.comms_outbox where quote_id = :Q;
insert into public.quote_payments (quote_id, org_id, amount, status, provider, method, paid_at, receipt_no, created_at) values (:Q, :A, 65080, 'paid', 'cash', 'cash', now(), 'R445-3', now() - interval '1 hour');
create temp table _p as select pg_temp.as_j('authenticated', 'fin445@a.test', 'select public.payment_reminder_preview(''a0000000-0000-4000-8000-000000445201'')') as p;
select pg_temp.t('4c the preview: the exact words, what is left, the rest said', (select p #>> '{items,0,to}' = 'rohan@example.com' and p #>> '{items,0,text}' ~ 'Rs\. 50,000 \(the rest of Rs\. 1,?15,080\)' and p #>> '{items,0,text}' ~ 'due today' and p ->> 'already' = 'false' from _p), (select p::text from _p));
select pg_temp.t('4d the preview queued nothing', not exists (select 1 from public.comms_outbox where quote_id = :Q));
select pg_temp.t('4e a person without the right, another studio, signed out: refused', pg_temp.as_j('authenticated', 'look445@a.test', 'select public.payment_reminder_preview(''a0000000-0000-4000-8000-000000445201'')') ->> 'err' like '42501%'
   and pg_temp.as_j('authenticated', 'adm445@b.test', 'select public.payment_reminder_preview(''a0000000-0000-4000-8000-000000445201'')') ->> 'err' like '42501%' and pg_temp.as_j('anon', null, 'select public.payment_reminder_preview(''a0000000-0000-4000-8000-000000445201'')') ->> 'err' like '42501%');
select pg_temp.t('4f the button queues it, same words', (pg_temp.as_j('authenticated', 'fin445@a.test', 'select public.payment_reminder_send_now(''a0000000-0000-4000-8000-000000445201'')') ->> 'queued') = '1');
select pg_temp.t('4f2 the same words', (select c.payload ->> 'text' = (select p #>> '{items,0,text}' from _p) from public.comms_outbox c where c.quote_id = :Q));
create temp table _f as select pg_temp.as_j('authenticated', 'fin445@a.test', 'select public.payment_followup_get(''a0000000-0000-4000-8000-00000000da01'')') as f;
select pg_temp.t('4g remembered: who and when; what is left; may send', (select f #>> array['rows', :M1, 'reminder', 'by'] = 'Fin445' and (f #>> array['rows', :M1, 'left'])::numeric = 50000 and f ->> 'can_send' = 'true' and f ->> 'phone' = '+91 98480 12345' and f ->> 'auto' = 'false' from _f), (select f::text from _f));
select pg_temp.t('4h a second press within minutes: not twice', (pg_temp.as_j('authenticated', 'fin445@a.test', 'select public.payment_reminder_preview(''a0000000-0000-4000-8000-000000445201'')') ->> 'already') = 'true');
select pg_temp.t('4i follow-up: Finance view of the studio only', pg_temp.as_j('authenticated', 'crew445@a.test', 'select public.payment_followup_get(''a0000000-0000-4000-8000-00000000da01'')') ->> 'err' like '42501%'
   and pg_temp.as_j('authenticated', 'adm445@b.test', 'select public.payment_followup_get(''a0000000-0000-4000-8000-00000000da01'')') ->> 'err' like '42501%' and (pg_temp.as_j('authenticated', 'look445@a.test', 'select public.payment_followup_get(''a0000000-0000-4000-8000-00000000da01'')') ->> 'can_send') = 'false');
insert into public.quote_payments (quote_id, org_id, amount, status, provider, method, paid_at, receipt_no, created_at) values (:Q, :A, 50000, 'paid', 'cash', 'cash', now(), 'R445-4', now() - interval '50 minutes');
select pg_temp.t('4j2 refused', pg_temp.as_j('authenticated', 'fin445@a.test', 'select public.payment_reminder_preview(''a0000000-0000-4000-8000-000000445201'')') ->> 'err' like '22023%');
delete from public.quote_payments where quote_id = :Q;

-- ---- 5) the client's step ---------------------------------------------------------------------------------------------------------------------
create or replace function pg_temp.steps(p_tok text default 'a0000000-0000-4000-8000-000000445001') returns jsonb language sql as $$ select pg_temp.as_j('anon', null, format('select public.public_payment_steps(%L)', p_tok)) $$;
create or replace function pg_temp.claim(p_m text, p_amt numeric, p_method text, p_ref text, p_proof text default null, p_tok text default 'a0000000-0000-4000-8000-000000445001') returns jsonb language sql as $$
  select pg_temp.as_j('anon', null, format('select public.public_payment_claim(%L, %L, %L, %L, %L, %L)', p_tok, p_m, p_amt, p_method, p_ref, p_proof)) $$;
create or replace function pg_temp.verify(p_code text, p_m text default 'a0000000-0000-4000-8000-000000445201') returns jsonb language sql as $$ select pg_temp.as_j('anon', null, format('select public.public_payment_code_verify(%L, %L, %L)', 'a0000000-0000-4000-8000-000000445001', p_m, p_code)) $$;
create temp table _m0 as select (select md5(string_agg(to_jsonb(m)::text, '|' order by m.id)) from public.payment_milestones m) as m, (select count(*) from public.quote_payments) as p, (select md5(string_agg(to_jsonb(c)::text, '|' order by c.id)) from public.quote_consents c) as c,
   (select md5(string_agg(to_jsonb(o)::text, '|' order by o.id)) from public.quote_otps o) as o, (select approval_status from public.quotes where id = :Q) as a;
select pg_temp.t('5a the link shows the payment to pay now, masked contact, no other event', (select s ->> 'on' = 'true' and jsonb_array_length(s -> 'rows') = 1 and s #>> '{rows,0,id}' = :M1 and s #>> '{channels,email}' = 'r***@example.com' and s ->> 'code' = 'false'
   and position('rohan@' in s::text) = 0 and position('98480' in s::text) = 0 from pg_temp.steps() s), pg_temp.steps()::text);
select pg_temp.t('5b an unknown link: refused', pg_temp.steps('a0000000-0000-4000-8000-0000004450ff') ? 'err');
select pg_temp.t('5c before anyone could get a code (send-otp not deployed): the notice goes without one', pg_temp.claim(:M1, 115080, 'upi', '') ->> 'err' like '22023%reference%' and (pg_temp.claim(:M1, 115080, 'upi', '4321 <b>9') ->> 'ok') = 'true', pg_temp.claim(:M1, 115080, 'upi', 'x')::text);
select pg_temp.t('5d the studio hears it, honestly', (select detail ->> 'label' ~ ('Rohan Sharma says ' || chr(8377) || '1,15,080 of the second payment is paid \(reference 4321 b 9\)\. Check your account, then record it\. Not confirmed with a code\.') from public.notifications where kind = 'payment_claimed'), (select string_agg(detail::text, '|') from public.notifications where kind = 'payment_claimed'));
select pg_temp.t('5e again: already said, one bell', (pg_temp.claim(:M1, 115080, 'upi', '999') ->> 'already') = 'true' and (select count(*) = 1 from public.notifications where kind = 'payment_claimed') and (select count(*) = 1 from public.payment_claims));
select pg_temp.t('5f the studio sees it on the payment row', (select f #>> array['rows', :M1, 'claim', 'reference'] = '4321 b 9' and (f #>> array['rows', :M1, 'claim', 'amount'])::numeric = 115080 from pg_temp.as_j('authenticated', 'fin445@a.test', 'select public.payment_followup_get(''a0000000-0000-4000-8000-00000000da01'')') f));
select pg_temp.t('5g the reminder of the studio says the client says it is paid', pg_temp.tick(to_char(public._pst_today(:A), 'YYYY-MM-DD') || ' 19:40') = 1);
select pg_temp.t('5g2 the words', exists (select 1 from public.notifications where kind = 'payment_followup' and detail ->> 'label' like '%is due today. The client says it is paid: check your account and record it.'), (select string_agg(detail ->> 'label', '|') from public.notifications where kind = 'payment_followup'));
select pg_temp.t('5h only Finance edit answers it', pg_temp.as_j('authenticated', 'look445@a.test', format('select public.payment_claim_close(%L, ''not_received'')', (select id from public.payment_claims))) ->> 'err' like '42501%'
   and pg_temp.as_j('authenticated', 'adm445@b.test', format('select public.payment_claim_close(%L, ''not_received'')', (select id from public.payment_claims))) ->> 'err' like '42501%'
   and (pg_temp.as_j('authenticated', 'fin445@a.test', format('select public.payment_claim_close(%L, ''not_received'')', (select id from public.payment_claims))) ->> 'closed') = 'true');
select pg_temp.t('5i wrong amount / method / payment / event', pg_temp.claim(:M1, 0, 'upi', '1') ->> 'err' like '22023%' and pg_temp.claim(:M1, 99999999, 'upi', '1') ->> 'err' like '22023%' and pg_temp.claim(:M1, 100, 'gold', '1') ->> 'err' like '22023%'
   and pg_temp.claim(:M2, 100, 'upi', '1') ->> 'err' like '22023%' and pg_temp.claim(gen_random_uuid()::text, 100, 'upi', '1') ->> 'err' like '22023%');
-- codes (what send-otp does with the service role)
create temp table _c as select pg_temp.as_j('service_role', null, 'select public.payment_code_begin(''a0000000-0000-4000-8000-000000445001'', ''a0000000-0000-4000-8000-000000445201'', ''email'')') as c;
select pg_temp.t('5j a code goes to the e-mail on the event only', (select c ->> 'email' = 'rohan@example.com' and c ->> 'masked' = 'r***@example.com' and c ->> 'resends_left' = '3' from _c), (select c::text from _c));
select pg_temp.t('5k signed out / signed in: no codes', pg_temp.as_j('anon', null, 'select public.payment_code_begin(''a0000000-0000-4000-8000-000000445001'', ''a0000000-0000-4000-8000-000000445201'', ''email'')') ->> 'err' like '42501%'
   and pg_temp.as_j('authenticated', 'adm445@a.test', 'select public.payment_code_set(gen_random_uuid(), ''123456'')') ->> 'err' like '42501%');
select pg_temp.t('5l another one within 30 seconds: refused', pg_temp.as_j('service_role', null, 'select public.payment_code_begin(''a0000000-0000-4000-8000-000000445001'', ''a0000000-0000-4000-8000-000000445201'', ''email'')') ->> 'err' like 'HL429%');
update public.payment_codes set created_at = created_at - interval '40 seconds';
select pg_temp.t('5m2 refused', pg_temp.as_j('service_role', null, 'select public.payment_code_begin(''a0000000-0000-4000-8000-000000445001'', ''a0000000-0000-4000-8000-000000445201'', ''whatsapp'')') ->> 'err' like 'HL403%');
select pg_temp.as_j('service_role', null, format('select to_jsonb(public.payment_code_set(%L, ''246810'')::text)', (select c ->> 'id' from _c))) \g /dev/null
select pg_temp.t('5n the hash only', (select code_hash like '$2%' and code_hash <> '246810' from public.payment_codes));
select pg_temp.t('5n2 made but not sent (no mail sender): no code is asked for', pg_temp.steps() ->> 'code' = 'false');
select pg_temp.as_j('service_role', null, format('select to_jsonb(public.payment_code_sent(%L)::text)', (select c ->> 'id' from _c))) \g /dev/null
select pg_temp.t('5o now a code is needed', pg_temp.steps() ->> 'code' = 'true' and pg_temp.claim(:M1, 115080, 'upi', '77') ->> 'err' like '22023%one-time code%' and pg_temp.claim(:M1, 115080, 'upi', '77', gen_random_uuid()::text) ->> 'err' like '22023%one-time code%');
select pg_temp.t('5p a wrong code counts', (select v ->> 'ok' = 'false' and v ->> 'remaining' = '4' from pg_temp.verify('000000') v));
select pg_temp.t('5q not for another payment, never an approval', pg_temp.verify('246810', :M2) ->> 'error' = 'no_active_code'
   and coalesce(pg_temp.as_j('anon', null, 'select public.verify_and_consent(''a0000000-0000-4000-8000-000000445001'', ''+91 98480 12345'', ''246810'', true, ''v'', ''t'', ''n'', ''ua'')') ->> 'already_approved', 'x') is not null and not exists (select 1 from public.quote_otps where quote_id = :Q and created_at >= now()));
create temp table _v as select pg_temp.verify('246810') as v;
select pg_temp.t('5r the right code: a proof, once', (select v ->> 'ok' = 'true' and v ? 'proof' from _v) and pg_temp.verify('246810') ->> 'ok' = 'false');
select pg_temp.t('5s with the proof: the notice, confirmed; the proof works once', (pg_temp.claim(:M1, 115080, 'bank', 'UTR 55', (select v ->> 'proof' from _v)) ->> 'ok') = 'true');
select pg_temp.t('5s1 kept as confirmed', (select bool_or(code_ok) from public.payment_claims where status = 'open') and (select used_at is not null from public.payment_codes));
update public.payment_claims set status = 'not_received' where status = 'open';
select pg_temp.t('5s2 the same proof again: refused', pg_temp.claim(:M1, 115080, 'bank', 'UTR 55', (select v ->> 'proof' from _v)) ->> 'err' like '22023%one-time code%');
insert into public.payment_codes(org_id, quote_id, milestone_id, channel, code_hash, attempts, expires_at) values (:A, :Q, :M1, 'email', extensions.crypt('111111', extensions.gen_salt('bf', 4)), 5, now() + interval '5 minutes');
select pg_temp.t('5t after 5 wrong tries: locked', pg_temp.verify('111111') ->> 'error' = 'locked');
update public.payment_codes set attempts = 0, expires_at = now() - interval '1 second' where code_hash is not null and verified_at is null;
select pg_temp.t('5u expired', pg_temp.verify('111111') ->> 'error' = 'no_active_code');
insert into public.payment_codes(org_id, quote_id, milestone_id, channel, expires_at, created_at) select :A, :Q, :M1, 'email', now() - interval '1 hour', now() - interval '2 hours' from generate_series(1, 10);
select pg_temp.t('5v ten a day', pg_temp.as_j('service_role', null, 'select public.payment_code_begin(''a0000000-0000-4000-8000-000000445001'', ''a0000000-0000-4000-8000-000000445201'', ''email'')') ->> 'err' like 'HL429%');
select pg_temp.t('5w no money, no approval, no consent, no approval code was touched', (select m = (select md5(string_agg(to_jsonb(x)::text, '|' order by x.id)) from public.payment_milestones x) and p = (select count(*) from public.quote_payments)
   and c is not distinct from (select md5(string_agg(to_jsonb(x)::text, '|' order by x.id)) from public.quote_consents x) and o is not distinct from (select md5(string_agg(to_jsonb(x)::text, '|' order by x.id)) from public.quote_otps x)
   and a = (select approval_status from public.quotes where id = :Q) from _m0));
-- recorded: the notice answers itself; one claim after another
delete from public.payment_claims; delete from public.payment_codes;
select pg_temp.claim(:M1, 50000, 'cash', null) \g /dev/null
select pg_temp.t('5x open', (select count(*) = 1 from public.payment_claims where status = 'open' and not public._r445_claim_done(id)));
insert into public.quote_payments (quote_id, org_id, amount, status, provider, method, paid_at, receipt_no, created_at) values (:Q, :A, 50000, 'paid', 'cash', 'cash', now(), 'R445-9', clock_timestamp() + interval '1 second');
select pg_temp.t('5y the studio recorded it: done, the client may say the next part', public._r445_claim_done((select id from public.payment_claims)) and not (pg_temp.steps() #> '{rows,0}' ? 'claim') and (pg_temp.claim(:M1, 65080, 'cash', null) ->> 'ok') = 'true'
   and (select count(*) = 1 from public.payment_claims where status = 'open'), (select string_agg(to_jsonb(c)::text, '|') from public.payment_claims c));
insert into public.payment_claims(org_id, quote_id, milestone_id, amount, method, status) select :A, :Q, :M1, 1, 'cash', 'not_received' from generate_series(1, 6);
update public.payment_claims set status = 'not_received' where status = 'open';
select pg_temp.t('5z six a day', pg_temp.claim(:M1, 100, 'cash', null) ->> 'err' like '22023%several times%');
update public.quotes set approval_status = 'sent', status = 'quote', lifecycle_stage = 'quote' where id = :Q;
select pg_temp.t('6a before the approval: no step', pg_temp.steps() ->> 'on' = 'false' and pg_temp.claim(:M1, 100, 'cash', null) ? 'err');
update public.quotes set approval_status = 'approved', status = 'confirmed', lifecycle_stage = 'confirmed' where id = :Q;
insert into public.studio_subscriptions(org_id, status, trial_ends_at) values (:A, 'trial', now() + interval '5 days');
select pg_temp.t('6b a free trial: no step, no code', pg_temp.steps() ->> 'on' = 'false' and pg_temp.as_j('service_role', null, 'select public.payment_code_begin(''a0000000-0000-4000-8000-000000445001'', ''a0000000-0000-4000-8000-000000445201'', ''email'')') ->> 'err' like 'HL404%');
delete from public.studio_subscriptions where org_id = :A;
update public.quotes set approval_token_expires_at = now() - interval '1 minute' where id = :Q;
select pg_temp.t('6c an expired link: refused', pg_temp.steps() ? 'err' and pg_temp.claim(:M1, 100, 'cash', null) ? 'err' and pg_temp.verify('111111') ? 'err');

select name, result from _rs where result <> 'PASS' order by name;
select 'R258-PAYMENT-FOLLOWUP-0445: ' || case when count(*) filter (where result <> 'PASS') = 0 then 'ALL PASS' else 'FAIL' end || ' (' || count(*) filter (where result = 'PASS') || '/' || count(*) || ')' from _rs;
rollback;
