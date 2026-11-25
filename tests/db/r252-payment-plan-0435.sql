-- r252-payment-plan-0435.sql - R252 "Payment plan, advance and approval" (0435). Proves: (1) applied twice: no stored money row
-- changed, privileges, kept bodies, exact edits; (2) the fourth built-in, the first three as before; (3) the planner's own plan:
-- preview writes nothing, sum = invoice total to the paisa, refusals, rights, other studio, read-only studio, frozen / closed /
-- cancelled, audit; (4) re-split like a template plan, paid rows untouched; (5) nothing is sent / overdue / belled before the
-- client approves, everything after; "Send reminder now" still works; (6) the approval day moves only untouched unpaid plan
-- payments, forward only, once; (7) a booking by advance is recorded as that, the client can still approve once, status stays
-- paid; (8) the stage after a payment; (9) the advance number, the event's own percentage, its history and rights; the studio
-- switch; (10) settings / public page shapes. Every UPDATE / DELETE of a paid milestone or of any receipt during the whole run is
-- logged and must be none (except the payment functions' own un-mark of a part-paid line). Local disposable PG only. Rolled back.
\set ON_ERROR_STOP 0
set client_min_messages = error;
begin;
create temp table _r5(name text, result text); grant all on _r5 to anon, authenticated, service_role;
create temp table _kv(k text primary key, v text); grant all on _kv to anon, authenticated, service_role;
create or replace function pg_temp.t(p_name text, p_ok boolean, p_detail text default '') returns void language plpgsql as $$
begin insert into _r5 values (p_name, case when coalesce(p_ok, false) then 'PASS' else 'FAIL: ' || left(coalesce(p_detail, ''), 700) end); end $$;
-- run as somebody; jsonb answer, or {"err": "<sqlstate> <message>"}
create or replace function pg_temp.as_j(p_who text, p_sql text) returns jsonb language plpgsql as $$
declare v jsonb;
begin
  if p_who = 'anon' then perform auth.login_anon();
  else perform auth.login_as((select id from auth.users where email = p_who)); end if;
  execute p_sql into v;
  perform auth.logout(); execute 'reset role';
  return v;
exception when others then
  perform auth.logout(); execute 'reset role';
  return jsonb_build_object('err', sqlstate || ' ' || sqlerrm);
end $$;
create or replace function pg_temp.digest() returns text language sql as $$
  select md5(concat_ws('#',
    (select string_agg(to_jsonb(m)::text, '|' order by m.id) from public.payment_milestones m),
    (select string_agg(to_jsonb(p)::text, '|' order by p.id) from public.quote_payments p),
    (select string_agg(to_jsonb(q)::text, '|' order by q.id) from public.quotes q),
    (select string_agg((to_jsonb(s) - 'advance_fixed')::text, '|' order by s.org_id) from public.payment_schedule_settings s),
    (select string_agg((to_jsonb(s) - 'plan_lines' - 'approved_on')::text, '|' order by s.quote_id) from public.payment_schedule_quote_prefs s),
    (select string_agg(to_jsonb(c)::text, '|' order by c.org_id, c.key) from public.app_config c))) $$;
create temp table _d as select pg_temp.digest() as d;
create temp table _b as select public._pst_builtins() as j;
\ir ../../supabase/migrations/0435_r252_payment_plan.sql
\ir ../../supabase/migrations/0435_r252_payment_plan.sql
set client_min_messages = error;
select pg_temp.t('1a no stored row changed by the migration (twice)', (select d = pg_temp.digest() from _d));
select pg_temp.t('1b helpers + kept bodies: nobody but the server, definer + empty search_path', not exists (
  select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace, unnest(array['anon', 'authenticated']) r
   where n.nspname = 'public' and (p.proname like '\_r435\_%' or p.proname like '%\_\_pre0435') and has_function_privilege(r, p.oid, 'execute'))
  and not exists (select 1 from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname like '\_r435\_%' and not (p.prosecdef and p.proconfig @> array['search_path=""'])));
select pg_temp.t('1c the five new RPCs: signed-in only, definer + empty search_path', (select count(*) = 5 and bool_and(p.prosecdef and p.proconfig @> array['search_path=""']
   and has_function_privilege('authenticated', p.oid, 'execute') and not has_function_privilege('anon', p.oid, 'execute')) from pg_proc p where p.pronamespace = 'public'::regnamespace
   and p.proname in ('payment_schedule_apply_custom', 'advance_get', 'advance_override_set', 'advance_override_clear', 'quote_approval_basis')));
select pg_temp.t('1d changed names keep their grants', has_function_privilege('anon', 'public.public_get_quote(uuid)', 'execute') and has_function_privilege('anon', 'public.public_payment_schedule(uuid)', 'execute')
  and has_function_privilege('authenticated', 'public.record_payment(uuid,numeric,text,text,uuid,text,text)', 'execute') and not has_function_privilege('anon', 'public.record_payment(uuid,numeric,text,text,uuid,text,text)', 'execute')
  and not has_function_privilege('authenticated', 'public.record_payment__pre0042(uuid,numeric,text,text,uuid,text,text)', 'execute')
  and not has_function_privilege('authenticated', 'public._pst_apply(uuid,text,text,uuid)', 'execute') and not has_function_privilege('anon', 'public._pst_apply(uuid,text,text,uuid)', 'execute')
  and has_function_privilege('authenticated', 'public.payment_schedule_settings_set(jsonb)', 'execute') and not has_function_privilege('anon', 'public.payment_schedule_settings_set(jsonb)', 'execute')
  and not has_function_privilege('anon', 'public.verify_and_consent__base(uuid,text,text,boolean,text,text,text,text)', 'execute'));
select pg_temp.t('1e every edit is in, every kept body is without it', (select count(*) = 17 and bool_and(position('r252-0435' in prosrc) = 0) from pg_proc where proname like '%\_\_pre0435')
  and (select bool_and(position('r252-0435' in pg_get_functiondef(f::regprocedure)) > 0) from unnest(array['public.record_payment__pre0042(uuid,numeric,text,text,uuid,text,text)',
   'public.record_payment(uuid,numeric,text,text,uuid,text,text)', 'public._comms_queue_pay(uuid,text,text,boolean,uuid)', 'public.comms_outbox_claim__pre0283(integer)', 'public._pst_tick()',
   'public.payment_schedule_for_quote(uuid)', 'public.public_payment_schedule(uuid)', 'public.event_money_header(uuid)', 'public.event_money_cash(uuid)',
   'public._r307_verify(uuid,text,text,boolean,text,text,text,text)', 'public.verify_and_consent__base(uuid,text,text,boolean,text,text,text,text)', 'public.public_get_quote(uuid)',
   'public.payment_schedule_settings_set__pre0285(jsonb)']) f), (select string_agg(proname, ',') from pg_proc where proname like '%\_\_pre0435'));
select pg_temp.t('1f the history table: RLS on, no app grant, server reads only', (select relrowsecurity from pg_class where oid = 'public.quote_advance_log'::regclass)
  and not has_table_privilege('authenticated', 'public.quote_advance_log', 'select, insert, update, delete') and not has_table_privilege('anon', 'public.quote_advance_log', 'select, insert, update, delete')
  and not has_table_privilege('service_role', 'public.quote_advance_log', 'insert, update, delete'));
select pg_temp.t('1g free-trial retention knows it once, before the quotes', (select count(*) = 1 from unnest(public._tr184_purge_tables()) x where x = 'quote_advance_log')
  and array_position(public._tr184_purge_tables(), 'quote_advance_log') < array_position(public._tr184_purge_tables(), 'quotes'));

-- ---- fixtures -----------------------------------------------------------------------------------------------------------------------
\set A '\'a0000000-0000-4000-8000-000000000001\''
\set B '\'b0000000-0000-4000-8000-000000000001\''
do $$ declare e text; u uuid; begin
  foreach e in array array['r435_fin@a.test:manager', 'r435_view@a.test:operations', 'r435_crew@a.test:crew', 'r435_cli@a.test:client'] loop
    select id into u from auth.users where email = split_part(e, ':', 1);
    if u is null then u := auth.seed_user(split_part(e, ':', 1)); end if;
    insert into public.profiles(id, email, full_name, role, org_id, must_change_password, created_at)
      values (u, split_part(e, ':', 1), initcap(split_part(e, ':', 2)) || ' Person', split_part(e, ':', 2), 'a0000000-0000-4000-8000-000000000001', false, now())
    on conflict (id) do update set role = excluded.role, org_id = excluded.org_id, full_name = excluded.full_name;
  end loop;
end $$;
update public.role_access set can_view = true, can_edit = false where org_id = :A and role = 'operations' and area = 'finance';
delete from public.role_access where org_id = :A and area = 'discount_approve';
delete from public.comms_settings where org_id in (:A, :B); delete from public.payment_schedule_settings where org_id in (:A, :B);
insert into public.comms_settings(org_id, pay_enabled) values (:A, true); insert into public.payment_schedule_settings(org_id, overdue_bell) values (:A, true);
insert into public.app_config(org_id, key, value) values (:A, 'pricing', '{"chairPrice":200,"advancePct":40}') on conflict (org_id, key) do update set value = public.app_config.value || '{"advancePct":40}';
create or replace function pg_temp.today() returns date language sql as $$ select public._pst_today('a0000000-0000-4000-8000-000000000001') $$;
create or replace function pg_temp.q(p_n text) returns uuid language sql as $$ select ('a0000000-0000-4000-8000-00000043' || p_n)::uuid $$;
create or replace function pg_temp.ev(p_n text, p_total numeric, p_days integer, p_status text default 'quote', p_appr text default 'sent', p_stage text default 'quote') returns uuid language plpgsql as $$
begin
  insert into public.quotes(id, code, title, status, client, pricing, current_version, approval_status, org_id, approval_token, event_date, lifecycle_stage, created_at, updated_at)
    values (pg_temp.q(p_n), 'R435-' || p_n, 'Event ' || p_n, p_status, jsonb_build_object('name', 'Riya', 'email', 'riya@example.com', 'phone', '+91980000' || p_n),
            case when p_total is null then '{}'::jsonb else jsonb_build_object('subtotal', p_total, 'discount', 0, 'gstPct', 0, 'total', p_total) end, 1, p_appr,
            'a0000000-0000-4000-8000-000000000001', gen_random_uuid(), case when p_days is null then null else pg_temp.today() + p_days end, p_stage, now(), now());
  return pg_temp.q(p_n);
end $$;
create or replace function pg_temp.ms(p_n text) returns text language sql as $$
  select coalesce(string_agg(trim_scale(m.amount)::text || '@' || coalesce((m.due_date - pg_temp.today())::text, '-') || ':' || m.status, ' ' order by m.seq), '') from public.payment_milestones m where m.quote_id = pg_temp.q(p_n) $$;
create or replace function pg_temp.sums(p_n text) returns boolean language sql as $$
  select (select sum(amount) from public.payment_milestones where quote_id = pg_temp.q(p_n) and status <> 'waived') = public.helm_invoice_total(pg_temp.q(p_n)) $$;
create or replace function pg_temp.custom(p_who text, p_n text, p_lines text, p_prev boolean default false) returns jsonb language sql as $$
  select pg_temp.as_j(p_who, format('select public.payment_schedule_apply_custom(%L, %L::jsonb, %L)', pg_temp.q(p_n), p_lines, p_prev)) $$;
create or replace function pg_temp.pay(p_n text, p_amount numeric, p_key text) returns jsonb language sql as $$
  select pg_temp.as_j('r435_fin@a.test', format('select public.record_payment(%L, %s, ''cash'', null, null, null, %L)', pg_temp.q(p_n), p_amount, p_key)) $$;
create or replace function pg_temp.sched(p_n text) returns jsonb language sql as $$ select pg_temp.as_j('a_admin@a.test', format('select public.payment_schedule_for_quote(%L)', pg_temp.q(p_n))) $$;
create or replace function pg_temp.old_sched(p_n text) returns jsonb language plpgsql as $$
declare v jsonb; begin   -- the kept body, as the server, with the admin's login claims
  perform set_config('request.jwt.claims', jsonb_build_object('sub', (select id from auth.users where email = 'a_admin@a.test'), 'role', 'authenticated')::text, true);
  v := public.payment_schedule_for_quote__pre0435(pg_temp.q(p_n)); perform auth.logout(); execute 'reset role'; return v; end $$;
create or replace function pg_temp.shift(p_n text, p_days integer) returns void language plpgsql as $$
begin   -- the plan was made p_days ago: the milestones' dates and the remembered ones go back together
  update public.payment_milestones set due_date = due_date - p_days where quote_id = pg_temp.q(p_n);
  update public.payment_schedule_quote_prefs set plan_lines = (select jsonb_agg(x || jsonb_build_object('due_date', (x ->> 'due_date')::date - p_days) order by o) from jsonb_array_elements(plan_lines) with ordinality e(x, o))
   where quote_id = pg_temp.q(p_n);
end $$;
-- the witness: any change of a paid milestone, any change / delete of a receipt, any delete of a milestone
create temp table _witness(what text); grant all on _witness to anon, authenticated, service_role;
create or replace function public._t435_w() returns trigger language plpgsql security definer as $$
begin
  if tg_table_name = 'quote_payments' then insert into pg_temp._witness values ('receipt ' || tg_op || ' ' || old.id);
  elsif tg_op = 'DELETE' then insert into pg_temp._witness values ('milestone delete ' || old.id);
  elsif old.status = 'paid' and new.status = 'paid' and to_jsonb(new) is distinct from to_jsonb(old) then insert into pg_temp._witness values ('paid milestone changed ' || old.id);
  elsif old.status = 'paid' and (new.amount, new.due_date, new.label) is distinct from (old.amount, old.due_date, old.label) then insert into pg_temp._witness values ('un-marked + changed ' || old.id);
  end if;
  return null;
end $$;
create trigger t435_w after update or delete on public.payment_milestones for each row execute function public._t435_w();
create trigger t435_w after update or delete on public.quote_payments for each row execute function public._t435_w();

-- ---- 2) built-ins -------------------------------------------------------------------------------------------------------------------------
select pg_temp.t('2a four built-ins: 3, 2, 1 payments byte-identical to before + 4 payments', jsonb_array_length(public._pst_builtins()) = 4
  and (select jsonb_agg(x order by o) from jsonb_array_elements(public._pst_builtins()) with ordinality e(x, o) where o <= 3) = (select jsonb_agg(x order by o) from _b, jsonb_array_elements(_b.j) with ordinality e(x, o) where o <= 3)
  and public._pst_builtins() -> 3 ->> 'key' = 'builtin:25-25-25-25');
select pg_temp.ev('0001', 100001, 60);
select pg_temp.t('2b 4 payments: on approval, 30 and 15 days before, on the day; adds up exactly',
  pg_temp.as_j('r435_fin@a.test', format('select public.payment_schedule_apply(%L, ''builtin:25-25-25-25'')', pg_temp.q('0001'))) ->> 'applied' = 'true'
  and pg_temp.ms('0001') = '25000@0:due 25000@30:due 25000@45:due 25001@60:due' and pg_temp.sums('0001'), pg_temp.ms('0001'));
select pg_temp.t('2c the plan remembers its rules', (select jsonb_array_length(plan_lines) = 4 and plan_lines -> 0 ->> 'anchor' = 'approval' and plan_lines -> 1 ->> 'offset_days' = '-30'
  and applied_source = 'manual' and applied_template = '25 / 25 / 25 / 25' from public.payment_schedule_quote_prefs where quote_id = pg_temp.q('0001')));
select pg_temp.t('2d it may be the studio default (admin); an unknown one is refused', pg_temp.as_j('a_admin@a.test', $q$select public.payment_schedule_settings_set('{"default_template":"builtin:25-25-25-25"}')$q$) ->> 'default_template' = 'builtin:25-25-25-25'
  and pg_temp.as_j('a_admin@a.test', $q$select public.payment_schedule_settings_set('{"default_template":"builtin:1-2-3"}')$q$) ->> 'err' like '22023%');
select pg_temp.ev('0002', 80000, 60); update public.quotes set approval_status = 'approved' where id = pg_temp.q('0002');
select pg_temp.t('2e the default is added on approval as before', pg_temp.ms('0002') = '20000@0:due 20000@30:due 20000@45:due 20000@60:due', pg_temp.ms('0002'));
select pg_temp.as_j('a_admin@a.test', $q$select public.payment_schedule_settings_set('{"default_template":"builtin:30-50-20"}')$q$) is not null;

-- ---- 3) the planner's own plan ----------------------------------------------------------------------------------------------------------------
select pg_temp.ev('0010', 123456, 50); insert into public.change_requests(quote_id, org_id, title, status, price_delta) values (pg_temp.q('0010'), :A, 'Extra hour', 'approved', 0.37);
\set L3 '[{"label":"Token","kind":"amount","value":"15000.50","due":{"anchor":"approval","offset_days":0}},{"label":"Half","kind":"percent","value":50,"due":{"anchor":"event","offset_days":-20}},{"label":"Rest","kind":"rest","due":{"anchor":"event","offset_days":0}}]'
insert into _kv values ('p', pg_temp.custom('r435_view@a.test', '0010', :'L3', true)::text);
select pg_temp.t('3a preview (Finance view): amounts + dates + rules, nothing written', (select (v::jsonb ->> 'applied') = 'false' and v::jsonb ->> 'template' = 'Custom (3 payments)'
   and v::jsonb -> 'schedule' -> 0 ->> 'amount' = '15000.50' and v::jsonb -> 'schedule' -> 1 ->> 'amount' = '61728' and v::jsonb -> 'schedule' -> 2 ->> 'amount' = '46727.87'
   and v::jsonb -> 'schedule' -> 1 ->> 'anchor' = 'event' and (v::jsonb -> 'schedule' -> 1 ->> 'offset_days')::int = -20 from _kv where k = 'p') and pg_temp.ms('0010') = ''
   and not exists (select 1 from public.payment_schedule_quote_prefs where quote_id = pg_temp.q('0010')) and not exists (select 1 from public.audit_log where quote_id = pg_temp.q('0010') and action like 'payment_schedule%'), (select v from _kv where k = 'p'));
select pg_temp.t('3b Finance view may not save; crew, a client login, signed out, another studio: refused', pg_temp.custom('r435_view@a.test', '0010', :'L3') ->> 'err' like '42501%'
  and pg_temp.custom('r435_crew@a.test', '0010', :'L3', true) ->> 'err' like '42501%' and pg_temp.custom('r435_cli@a.test', '0010', :'L3', true) ->> 'err' like '42501%'
  and pg_temp.custom('anon', '0010', :'L3', true) ->> 'err' like '42501%' and pg_temp.custom('b_admin@b.test', '0010', :'L3') ->> 'err' like '42501 event not found%' and pg_temp.ms('0010') = '');
insert into _kv values ('c3', pg_temp.custom('r435_fin@a.test', '0010', :'L3')::text);
select pg_temp.t('3c saved by Finance edit = the preview, sum = the invoice total to the paisa', (select v::jsonb ->> 'applied' = 'true' from _kv where k = 'c3')
  and pg_temp.ms('0010') = '15000.5@0:due 61728@30:due 46727.87@50:due' and pg_temp.sums('0010')
  and (select jsonb_agg(m.amount order by m.seq) = (select jsonb_agg(x -> 'amount' order by (x ->> 'seq')::int) from _kv, jsonb_array_elements(v::jsonb -> 'schedule') x where k = 'p') from public.payment_milestones m where m.quote_id = pg_temp.q('0010')), pg_temp.ms('0010'));
select pg_temp.t('3d audited with its lines; stored as a plan (source manual)', (select a.changed ->> 'template' = 'Custom (3 payments)' and jsonb_array_length(a.changed -> 'lines') = 3 and a.actor = (select id from auth.users where email = 'r435_fin@a.test')
   from public.audit_log a where a.quote_id = pg_temp.q('0010') and a.action = 'payment_schedule.applied') and (select applied_at is not null and applied_source = 'manual' and jsonb_array_length(plan_lines) = 3 from public.payment_schedule_quote_prefs where quote_id = pg_temp.q('0010')));
select pg_temp.t('3e never over an existing plan (custom, template or hand-made)', pg_temp.custom('r435_fin@a.test', '0010', :'L3') ->> 'err' like '22023 This event already has%' and pg_temp.custom('r435_fin@a.test', '0001', :'L3', true) ->> 'err' like '22023%');
select pg_temp.ev('0011', 100000, 40);
create temp table _bad(n int, l text, msg text);
insert into _bad values
 (1, '[]', 'Add at least one'), (2, '"x"', 'Add at least one'), (3, 'null', 'Add at least one'),
 (4, (select jsonb_agg(jsonb_build_object('label', 'P' || i, 'kind', 'percent', 'value', 10)) from generate_series(1, 9) i)::text, 'at most 8'),
 (5, '[{"label":"A","kind":"percent","value":90}]', 'add up to 100'),
 (6, '[{"label":"A","kind":"percent","value":60},{"label":"B","kind":"percent","value":50}]', 'more than 100'),
 (7, '[{"label":"A","kind":"rest"},{"label":"B","kind":"rest"}]', 'at most one'),
 (8, '[{"label":"A","kind":"amount","value":150000},{"label":"B","kind":"rest"}]', 'do not fit'),
 (9, '[{"label":"A","kind":"amount","value":100000},{"label":"B","kind":"rest"}]', 'do not fit'),
 (10, '[{"label":"A","kind":"percent","value":50},{"label":"B","kind":"amount","value":60000},{"label":"C","kind":"rest"}]', 'do not fit'),
 (11, '[{"label":"A","kind":"amount","value":100000}]', 'add up to 100'),
 (12, '[{"label":"<b>","kind":"percent","value":100}]', 'enter a name'),
 (13, '[{"label":"A","kind":"percent","value":-5}]', 'as a number'), (14, '[{"label":"A","kind":"percent","value":"1e2"}]', 'as a number'),
 (15, '[{"label":"A","kind":"percent","value":100,"due":{"anchor":"birthday"}}]', 'due date counts'),
 (16, '[{"label":"A","kind":"percent","value":100,"due":{"anchor":"approval","offset_days":-3}}]', 'before the approval'),
 (17, '[{"label":"A","kind":"percent","value":100,"offset_days":"9999"}]', 'whole number'), (18, '[7]', 'not a valid payment'),
 (19, '[{"label":"A","kind":"gift","value":5}]', 'choose percent'), (20, '[{"label":"A","kind":"percent","value":0}]', 'more than 0'),
 (21, '[{"label":"A","kind":"percent","value":"NaN"}]', 'as a number'), (22, '{"label":"A"}', 'Add at least one');
select pg_temp.t('3f refused, in words: ' || string_agg(n::text, ',' order by n), bool_and(r ->> 'err' like '22023%' || msg || '%'), string_agg(n || ': ' || r::text, ' / ') filter (where not coalesce(r ->> 'err' like '22023%' || msg || '%', false)))
  from (select n, msg, pg_temp.custom('r435_fin@a.test', '0011', l) as r from _bad) x;
select pg_temp.t('3g nothing was written by the refusals', pg_temp.ms('0011') = '');
do $$ declare c record; i int; bad text := ''; begin   -- many totals x many shapes: always exact, every payment > 0
  i := 100;
  for c in select t, l from unnest(array[100000, 99999.99, 1234567.89, 777, 10.01, 250000.5]::numeric[]) t,
      (values ('[{"label":"A","kind":"percent","value":33.33},{"label":"B","kind":"percent","value":33.33},{"label":"C","kind":"percent","value":33.34}]'),
              ('[{"label":"A","kind":"percent","value":12.5},{"label":"B","kind":"percent","value":12.5},{"label":"C","kind":"percent","value":12.5},{"label":"D","kind":"percent","value":12.5},{"label":"E","kind":"percent","value":12.5},{"label":"F","kind":"percent","value":12.5},{"label":"G","kind":"percent","value":12.5},{"label":"H","kind":"percent","value":12.5}]'),
              ('[{"label":"A","kind":"rest"},{"label":"B","kind":"amount","value":"3.33"},{"label":"C","kind":"percent","value":40}]'),
              ('[{"label":"All","kind":"rest"}]')) s(l) loop
    i := i + 1;
    perform pg_temp.ev('0' || i, round(c.t), 30);
    if c.t <> round(c.t) then insert into public.change_requests(quote_id, org_id, title, status, price_delta) values (pg_temp.q('0' || i), 'a0000000-0000-4000-8000-000000000001', 'x', 'approved', c.t - round(c.t)); end if;
    if pg_temp.custom('r435_fin@a.test', '0' || i, c.l) ->> 'applied' is distinct from 'true' then bad := bad || ' no:' || c.t || c.l;
    elsif not pg_temp.sums('0' || i) or exists (select 1 from public.payment_milestones where quote_id = pg_temp.q('0' || i) and amount <= 0) then bad := bad || ' sum:' || c.t || ' ' || pg_temp.ms('0' || i); end if;
  end loop;
  perform pg_temp.t('3h 24 total x shape pairs: sum of plan = invoice total to the paisa, every payment above 0', bad = '', bad);
end $$;
select pg_temp.ev('0012', null, 40); select pg_temp.ev('0013', 50000, 40); update public.quotes set status = 'cancelled' where id = pg_temp.q('0013');
select pg_temp.ev('0014', 50000, 40); update public.quotes set archived_at = now(), archived_reason = 'manual' where id = pg_temp.q('0014');
\set ONE '[{"label":"All","kind":"percent","value":100}]'
select pg_temp.t('3i unpriced, cancelled, archived: refused', pg_temp.custom('r435_fin@a.test', '0012', :'ONE') ->> 'err' like '22023 Price the quote%' and pg_temp.custom('r435_fin@a.test', '0013', :'ONE') ->> 'err' like '22023 This event is cancelled%'
  and pg_temp.custom('r435_fin@a.test', '0014', :'ONE') ->> 'err' like '22023 This event is cancelled%');
insert into public.event_money_freezes(quote_id, org_id, frozen, reason) values (pg_temp.q('0011'), :A, true, 'Month-end review');
select pg_temp.t('3j frozen money: refused like a template plan', pg_temp.custom('r435_fin@a.test', '0011', :'ONE') ->> 'err' like '42501 The money on this event is frozen%'
  and pg_temp.as_j('r435_fin@a.test', format('select public.payment_schedule_apply(%L)', pg_temp.q('0011'))) ->> 'err' like '42501 The money on this event is frozen%' and pg_temp.ms('0011') = '');
update public.event_money_freezes set frozen = false where quote_id = pg_temp.q('0011');
insert into public.event_closure(quote_id, org_id, closed_at) values (pg_temp.q('0011'), :A, now()) on conflict (quote_id) do update set closed_at = now();
select pg_temp.t('3k closed event: refused', pg_temp.custom('r435_fin@a.test', '0011', :'ONE') ->> 'err' like '42501 This event is closed%' and pg_temp.ms('0011') = '');
update public.event_closure set closed_at = null where quote_id = pg_temp.q('0011');
select pg_temp.ev('0015', 50000, 40);
create temp table _sub as select * from public.studio_subscriptions where org_id = :A;
insert into public.studio_subscriptions (org_id, status) values (:A, 'suspended') on conflict (org_id) do update set status = 'suspended';
select pg_temp.t('3l read-only studio: refused, nothing written (plan, advance, switch); preview and reading work', pg_temp.custom('r435_fin@a.test', '0011', :'ONE') ->> 'err' like '25006%' and pg_temp.ms('0011') = ''
  and pg_temp.custom('r435_fin@a.test', '0011', :'ONE', true) ->> 'preview' = 'true'
  and pg_temp.as_j('a_admin@a.test', format('select public.advance_override_set(%L, 25, ''Old client'')', pg_temp.q('0011'))) ->> 'err' like '25006%'
  and pg_temp.as_j('a_admin@a.test', $q$select public.payment_schedule_settings_set('{"advance_fixed":false}')$q$) ->> 'err' like '25006%'
  and pg_temp.as_j('a_admin@a.test', format('select public.advance_get(%L)', pg_temp.q('0011'))) ->> 'pct' = '40');
select pg_temp.t('3l2 ... no advance row, switch untouched', not exists (select 1 from public.quote_advance_log where quote_id = pg_temp.q('0011')) and (select advance_fixed from public.payment_schedule_settings where org_id = :A));
delete from public.studio_subscriptions where org_id = :A; insert into public.studio_subscriptions select * from _sub;
insert into public.studio_subscriptions (org_id, status, trial_ends_at) values (:A, 'trial', now() + interval '5 days') on conflict (org_id) do update set status = 'trial', trial_ends_at = now() + interval '5 days';
update public.organizations set trial_ends_at = now() + interval '5 days' where id = :A;
select pg_temp.t('3m running free trial: allowed, like a template plan', pg_temp.custom('r435_fin@a.test', '0011', :'ONE') ->> 'applied' = 'true' and pg_temp.ms('0011') = '100000@0:due', pg_temp.ms('0011'));
update public.organizations set trial_ends_at = now() - interval '1 day' where id = :A; update public.studio_subscriptions set trial_ends_at = now() - interval '1 day' where org_id = :A;
select pg_temp.t('3n ended free trial: refused', pg_temp.custom('r435_fin@a.test', '0015', :'ONE') ->> 'err' is not null and pg_temp.ms('0015') = '', pg_temp.custom('r435_fin@a.test', '0015', :'ONE')::text);
update public.organizations set trial_ends_at = null where id = :A; delete from public.studio_subscriptions where org_id = :A; insert into public.studio_subscriptions select * from _sub;
update public.payment_schedule_settings set auto_apply = false where org_id = :A;
insert into public.payment_schedule_settings(org_id, auto_apply) values (:A, false) on conflict (org_id) do update set auto_apply = false;
select pg_temp.ev('0016', 90000, 40); select pg_temp.pay('0016', 30000, 'r435-k16') ->> 'receipt_no' is not null;
select pg_temp.t('3o money already received covers the first payments', pg_temp.custom('r435_fin@a.test', '0016', '[{"label":"A","kind":"amount","value":20000},{"label":"B","kind":"amount","value":20000},{"label":"C","kind":"rest"}]') ->> 'applied' = 'true'
  and pg_temp.ms('0016') = '20000@0:paid 20000@0:due 50000@0:due', pg_temp.ms('0016'));
update public.payment_schedule_settings set auto_apply = true where org_id = :A;

-- ---- 4) re-split like a template plan ----------------------------------------------------------------------------------------------------------
update public.quotes set pricing = pricing || '{"subtotal":99000.25,"total":99000.25}' where id = pg_temp.q('0016');
select pg_temp.t('4a re-priced: the card says mismatch, the re-split keeps the paid row and adds up again', pg_temp.sched('0016') ->> 'mismatch' = 'true'
  and pg_temp.as_j('r435_fin@a.test', format('select public.payment_schedule_resync(%L)', pg_temp.q('0016'))) ->> 'changed' = 'true' and pg_temp.sums('0016') and pg_temp.ms('0016') like '20000@0:paid %', pg_temp.ms('0016'));

-- ---- 5) nothing before the client approves -----------------------------------------------------------------------------------------------------
select pg_temp.ev('0020', 60000, 30); select pg_temp.custom('r435_fin@a.test', '0020', '[{"label":"Advance","kind":"percent","value":30},{"label":"Mid","kind":"percent","value":30,"due":{"anchor":"event","offset_days":-25}},{"label":"Last","kind":"rest","due":{"anchor":"event"}}]') ->> 'applied';
select pg_temp.shift('0020', 8);      -- made 8 days ago: advance 8 days "late", the second 3 days "late"
select pg_temp.t('5a before approval: state due (not overdue), held, next is not overdue', (pg_temp.sched('0020') ->> 'held')::boolean and pg_temp.sched('0020') -> 'rows' -> 0 ->> 'state' = 'due' and pg_temp.sched('0020') -> 'rows' -> 1 ->> 'state' = 'due'
  and pg_temp.sched('0020') -> 'next' ->> 'state' = 'due' and pg_temp.sched('0020') -> 'rows' -> 0 -> 'rule' = '{"anchor":"approval","offset_days":0}', pg_temp.sched('0020')::text);
select pg_temp.t('5b the client page: no overdue, "on approval" marked', (select p ->> 'held' = 'true' and p -> 'rows' -> 0 ->> 'state' = 'due' and p -> 'rows' -> 0 ->> 'on_approval' = 'true' and p -> 'rows' -> 1 ->> 'on_approval' = 'false'
   from (select pg_temp.as_j('anon', format('select public.public_payment_schedule(%L)', (select approval_token from public.quotes where id = pg_temp.q('0020')))) as p) x));
select public.comms_tick() is not null;
select pg_temp.t('5c the job: no reminder, no overdue bell, no alert row', not exists (select 1 from public.comms_outbox where quote_id = pg_temp.q('0020')) and not exists (select 1 from public.notifications where quote_id = pg_temp.q('0020') and kind = 'payment_overdue')
  and not exists (select 1 from public.payment_overdue_alerts where quote_id = pg_temp.q('0020')));
select pg_temp.t('5d event money: not late', (select x ->> 'late' = 'false' from (select jsonb_path_query_first(pg_temp.as_j('a_admin@a.test', format('select public.event_money_cash(%L)', pg_temp.q('0020'))), '$.**.next') as x) y)
  and pg_temp.as_j('a_admin@a.test', format('select public.event_money_header(%L)', pg_temp.q('0020')))::text not like '%"kind": "collect", "level": "bad"%', pg_temp.as_j('a_admin@a.test', format('select public.event_money_cash(%L)', pg_temp.q('0020')))::text);
select pg_temp.t('5e "Send reminder now" still works', (pg_temp.as_j('a_admin@a.test', format('select public.payment_reminder_send_now(%L)', (select id from public.payment_milestones where quote_id = pg_temp.q('0020') and seq = 1))) ->> 'queued')::int = 1);
insert into public.comms_outbox(org_id, quote_id, milestone_id, purpose, channel, recipient, payload, dedupe_key) select :A, pg_temp.q('0020'), id, 'pay_reminder', 'email', 'riya@example.com', '{"manual":false,"text":"x","subject":"x"}', 'r435:old:' || id from public.payment_milestones where quote_id = pg_temp.q('0020') and seq = 2;
select public.comms_outbox_claim(50) is not null;
select pg_temp.t('5f an automatic reminder still waiting for such an event is skipped at the claim, the one sent by hand is not', (select status = 'skipped' from public.comms_outbox where quote_id = pg_temp.q('0020') and dedupe_key like 'r435:old:%')
  and (select status <> 'skipped' from public.comms_outbox where quote_id = pg_temp.q('0020') and dedupe_key like 'pay:now:%'));

-- ---- 6) the approval day -----------------------------------------------------------------------------------------------------------------------
update public.quotes set approval_status = 'approved' where id = pg_temp.q('0020');
select pg_temp.t('6a on approval: the "on approval" payment and the date that passed are due today, the future one stays, amounts unchanged', pg_temp.ms('0020') = '18000@0:due 18000@0:due 24000@22:due' and pg_temp.sums('0020'), pg_temp.ms('0020'));
select pg_temp.t('6b audited, dated, rules follow', (select jsonb_array_length(changed -> 'rows') = 2 from public.audit_log where quote_id = pg_temp.q('0020') and action = 'payment_schedule.dates_moved')
  and (select approved_on = pg_temp.today() from public.payment_schedule_quote_prefs where quote_id = pg_temp.q('0020')) and pg_temp.sched('0020') -> 'rows' -> 0 -> 'rule' ->> 'anchor' = 'approval');
select public.comms_tick() is not null;
select pg_temp.t('6c from now on reminders go out', (select count(*) >= 1 from public.comms_outbox where quote_id = pg_temp.q('0020') and purpose = 'pay_reminder' and not coalesce((payload ->> 'manual')::boolean, false) and dedupe_key like 'pay:%'));
select pg_temp.shift('0020', 2); update public.quotes set approval_status = 'sent', lifecycle_stage = 'quote' where id = pg_temp.q('0020');
update public.payment_schedule_quote_prefs set approved_on = approved_on - 2 where quote_id = pg_temp.q('0020');
update public.quotes set approval_status = 'approved' where id = pg_temp.q('0020');
select pg_temp.t('6d a second approval another day moves nothing', pg_temp.ms('0020') = '18000@-2:due 18000@-2:due 24000@20:due', pg_temp.ms('0020'));
select public.comms_tick() is not null;
select pg_temp.t('6e approved and late = overdue + one bell per payment, as before', pg_temp.sched('0020') -> 'rows' -> 0 ->> 'state' = 'overdue' and (select count(*) = 2 from public.notifications where quote_id = pg_temp.q('0020') and kind = 'payment_overdue'));
-- touched by hand
\set FIVE '[{"label":"A","kind":"percent","value":20},{"label":"B","kind":"percent","value":20},{"label":"C","kind":"percent","value":20},{"label":"D","kind":"percent","value":20},{"label":"E","kind":"percent","value":20,"due":{"anchor":"approval","offset_days":7}}]'
select pg_temp.ev('0021', 50000, 90); select pg_temp.custom('r435_fin@a.test', '0021', :'FIVE') ->> 'applied'; select pg_temp.shift('0021', 10);
update public.payment_milestones set due_date = due_date + 1 where quote_id = pg_temp.q('0021') and seq = 1;
update public.payment_milestones set label = 'B by hand' where quote_id = pg_temp.q('0021') and seq = 2;
update public.payment_milestones set status = 'invoiced' where quote_id = pg_temp.q('0021') and seq = 3;
update public.payment_milestones set amount = 9000 where quote_id = pg_temp.q('0021') and seq = 4;
update public.quotes set status = 'confirmed' where id = pg_temp.q('0021');
select pg_temp.t('6f by hand changed date / name / amount, invoiced: left; untouched one: confirmation day + its 7 days', pg_temp.ms('0021') = '10000@-9:due 10000@-10:due 10000@-10:invoiced 9000@-10:due 10000@7:due', pg_temp.ms('0021'));
-- re-priced before the approval: the automatic re-split changes amounts, the dates still move
select pg_temp.ev('0022', 50000, 90); select pg_temp.as_j('r435_fin@a.test', format('select public.payment_schedule_apply(%L, ''builtin:50-50'')', pg_temp.q('0022'))) ->> 'applied'; select pg_temp.shift('0022', 5);
update public.quotes set pricing = pricing || '{"subtotal":70001,"total":70001}' where id = pg_temp.q('0022'); update public.quotes set approval_status = 'approved' where id = pg_temp.q('0022');
select pg_temp.t('6g re-split on approval (0321) and moved in the same step; adds up', pg_temp.ms('0022') like '%@0:due %@78:due' and pg_temp.sums('0022'), pg_temp.ms('0022'));
-- a hand-made plan and an older plan (no remembered rules): never moved
select pg_temp.ev('0023', 50000, 90); insert into public.payment_milestones(quote_id, org_id, label, amount, status, seq, due_date) values (pg_temp.q('0023'), :A, 'Token', 5000, 'due', 1, pg_temp.today() - 4);
select pg_temp.ev('0024', 50000, 90); select pg_temp.as_j('r435_fin@a.test', format('select public.payment_schedule_apply(%L, ''builtin:50-50'')', pg_temp.q('0024'))) ->> 'applied'; select pg_temp.shift('0024', 5);
update public.payment_schedule_quote_prefs set plan_lines = null where quote_id = pg_temp.q('0024');
update public.quotes set approval_status = 'approved' where id in (pg_temp.q('0023'), pg_temp.q('0024'));
select pg_temp.t('6h hand-made plan / plan from before 0435: dates stay', pg_temp.ms('0023') = '5000@-4:due' and pg_temp.ms('0024') like '25000@-5:due%', pg_temp.ms('0024'));
-- frozen money: the approval goes through, nothing moves
select pg_temp.ev('0025', 50000, 90); select pg_temp.custom('r435_fin@a.test', '0025', :'ONE') ->> 'applied'; select pg_temp.shift('0025', 5);
insert into public.event_money_freezes(quote_id, org_id, frozen, reason) values (pg_temp.q('0025'), :A, true, 'Month-end review');
update public.quotes set approval_status = 'approved' where id = pg_temp.q('0025');
select pg_temp.t('6i frozen money: approved, dates stay', pg_temp.ms('0025') = '50000@-5:due' and (select approval_status = 'approved' from public.quotes where id = pg_temp.q('0025')));

-- ---- 7) booked by an advance, approved later ------------------------------------------------------------------------------------------------------
select pg_temp.ev('0030', 100000, 90); select pg_temp.as_j('r435_fin@a.test', format('select public.payment_schedule_apply(%L, ''builtin:30-50-20'')', pg_temp.q('0030'))) ->> 'applied'; select pg_temp.shift('0030', 6);
insert into _kv values ('r30', pg_temp.pay('0030', 12345, 'r435-k30')::text);
select pg_temp.t('7a a part advance confirms the booking (allowed); status paid as before', (select v::jsonb ->> 'booking' = 'confirmed' from _kv where k = 'r30') and (select approval_status = 'paid' and status = 'confirmed' from public.quotes where id = pg_temp.q('0030')), (select v from _kv where k = 'r30'));
select pg_temp.t('7b the part-paid advance line is open and due today (its 6 days are not "late")', pg_temp.ms('0030') = '30000@0:due 50000@69:due 20000@84:due' and pg_temp.sched('0030') -> 'rows' -> 0 ->> 'state' = 'part_paid' and pg_temp.sums('0030'), pg_temp.ms('0030'));
select pg_temp.t('7c recorded as "by advance", once, audited', (select count(*) = 1 and bool_and(amount = 12345 and actor_email = 'r435_fin@a.test' and receipt_no is not null) from public.quote_advance_log where quote_id = pg_temp.q('0030') and kind = 'advance_confirm')
  and (select count(*) = 1 from public.audit_log where quote_id = pg_temp.q('0030') and action = 'booking.confirmed_by_advance'));
select pg_temp.t('7d every read says advance, not client approved', pg_temp.sched('0030') -> 'approval' ->> 'basis' = 'advance' and pg_temp.sched('0030') -> 'approval' ->> 'client_approved' = 'false' and pg_temp.sched('0030') -> 'approval' ->> 'advance_at' is not null
  and pg_temp.as_j('a_staff@a.test', format('select public.quote_approval_basis(array[%L::uuid])', pg_temp.q('0030'))) -> 0 ->> 'basis' = 'advance'
  and (select p ->> 'client_approved' = 'false' and p ->> 'approval_basis' = 'advance' and p ->> 'approval_status' = 'paid' from (select pg_temp.as_j('anon', format('select public.public_get_quote(%L)', (select approval_token from public.quotes where id = pg_temp.q('0030')))) as p) x),
  (select pg_temp.as_j('anon', format('select public.public_get_quote(%L)', (select approval_token from public.quotes where id = pg_temp.q('0030'))))::text));
select pg_temp.pay('0030', 1000, 'r435-k30b') ->> 'receipt_no' is not null;
select pg_temp.t('7e another payment adds no second record; a replay neither', (select count(*) = 1 from public.quote_advance_log where quote_id = pg_temp.q('0030') and kind = 'advance_confirm')
  and pg_temp.pay('0030', 1000, 'r435-k30b') ->> 'idempotent_replay' = 'true' and (select count(*) = 2 from public.quote_payments where quote_id = pg_temp.q('0030')));
select pg_temp.t('7e2 ... still one record, two receipts (read after the replay)', (select count(*) = 1 from public.quote_advance_log where quote_id = pg_temp.q('0030')) and (select count(*) = 2 from public.quote_payments where quote_id = pg_temp.q('0030')));
create or replace function pg_temp.otp(p_n text, p_code text) returns void language sql as $$
  insert into public.quote_otps(quote_id, phone, code_hash, expires_at, org_id, created_at) select q.id, public._otp_canon_phone(q.approval_token, q.client ->> 'phone'), extensions.crypt(p_code, extensions.gen_salt('bf', 4)), now() + interval '10 minutes', q.org_id, clock_timestamp() from public.quotes q where q.id = pg_temp.q(p_n) $$;
create or replace function pg_temp.verify(p_n text, p_code text) returns jsonb language sql as $$
  select pg_temp.as_j('anon', format('select public.verify_and_consent(%L, %L, %L, true, ''v1'', ''I agree'', ''Riya'', ''ua'')', (select approval_token from public.quotes where id = pg_temp.q(p_n)), '+91980000' || p_n, p_code)) $$;
select pg_temp.otp('0030', '111111'); select pg_temp.otp('0030', '222222');
insert into _kv values ('v0', pg_temp.verify('0030', '999999')::text);
select pg_temp.t('7f a wrong code is still a wrong code', (select v::jsonb ->> 'approved' = 'false' from _kv where k = 'v0') and not exists (select 1 from public.quote_consents where quote_id = pg_temp.q('0030')), (select v from _kv where k = 'v0'));
insert into _kv values ('v1', pg_temp.verify('0030', '222222')::text);
select pg_temp.t('7g the client approves afterwards with the normal link: one consent, status stays paid, basis client', (select v::jsonb ->> 'approved' = 'true' and not (v::jsonb ? 'already_approved') from _kv where k = 'v1')
  and (select count(*) = 1 and bool_and(agreed) from public.quote_consents where quote_id = pg_temp.q('0030')) and (select approval_status = 'paid' and status = 'confirmed' from public.quotes where id = pg_temp.q('0030'))
  and pg_temp.sched('0030') -> 'approval' ->> 'basis' = 'client' and pg_temp.sched('0030') -> 'approval' ->> 'client_approved' = 'true', (select v from _kv where k = 'v1'));
select pg_temp.t('7h only once: the other code and a new one answer already approved, no second consent', pg_temp.verify('0030', '111111') ->> 'already_approved' = 'true'
  and pg_temp.verify('0030', '333333') ->> 'already_approved' = 'true' and (select count(*) = 1 from public.quote_consents where quote_id = pg_temp.q('0030')));
select pg_temp.t('7h2 ... one consent (read after the two tries), status still paid', (select count(*) = 1 from public.quote_consents where quote_id = pg_temp.q('0030')) and (select approval_status = 'paid' from public.quotes where id = pg_temp.q('0030')));
select pg_temp.t('7i the later approval moved no money row', pg_temp.ms('0030') = '30000@0:due 50000@69:due 20000@84:due');
-- the normal order is as before
select pg_temp.ev('0031', 100000, 90); select pg_temp.otp('0031', '444444'); insert into _kv values ('v2', pg_temp.verify('0031', '444444')::text);
insert into _kv values ('s7', (select approval_status from public.quotes where id = pg_temp.q('0031')));
insert into _kv values ('p7', pg_temp.pay('0031', 30000, 'r435-k31')::text);
select pg_temp.t('7j approval first: approved + basis client, then the payment: paid, no advance record', (select v::jsonb ->> 'approved' = 'true' from _kv where k = 'v2') and (select v = 'approved' from _kv where k = 's7')
  and (select v::jsonb ->> 'receipt_no' is not null from _kv where k = 'p7') and (select approval_status = 'paid' from public.quotes where id = pg_temp.q('0031')) and not exists (select 1 from public.quote_advance_log where quote_id = pg_temp.q('0031'))
  and pg_temp.sched('0031') -> 'approval' ->> 'basis' = 'client' and pg_temp.ms('0031') like '30000@0:paid%', pg_temp.ms('0031'));
-- price changed after approval (stale) and paid: re-approval still gives approved, as before 0435
update public.quotes set consent_stale = true where id = pg_temp.q('0031'); select pg_temp.otp('0031', '555555'); insert into _kv values ('v3', pg_temp.verify('0031', '555555')::text);
select pg_temp.t('7k stale + paid: the re-approval path is as it was', (select v::jsonb ->> 'approved' = 'true' from _kv where k = 'v3') and (select approval_status = 'approved' and not consent_stale from public.quotes where id = pg_temp.q('0031')), (select v from _kv where k = 'v3'));
select pg_temp.ev('0032', 100000, 90, 'confirmed', 'none', 'confirmed');
select pg_temp.t('7l confirmed by the studio only: basis studio; a plain quote: none; wrong token: refused as before', pg_temp.sched('0032') -> 'approval' ->> 'basis' = 'studio' and pg_temp.sched('0001') -> 'approval' -> 'basis' = 'null'::jsonb
  and pg_temp.as_j('anon', 'select public.public_get_quote(gen_random_uuid())') ->> 'err' is not null);
select pg_temp.t('7m quote_approval_basis: own studio only, rights, at most 500', pg_temp.as_j('b_admin@b.test', format('select public.quote_approval_basis(array[%L::uuid])', pg_temp.q('0030'))) = '[]'::jsonb
  and pg_temp.as_j('r435_crew@a.test', format('select public.quote_approval_basis(array[%L::uuid])', pg_temp.q('0030'))) ->> 'err' like '42501%'
  and pg_temp.as_j('a_admin@a.test', 'select public.quote_approval_basis(array(select gen_random_uuid() from generate_series(1, 501)))') ->> 'err' like '22023%' and pg_temp.as_j('a_admin@a.test', 'select public.quote_approval_basis(null)') = '[]'::jsonb);

-- ---- 8) the stage after a payment ---------------------------------------------------------------------------------------------------------------
create or replace function pg_temp.stage(p_n text) returns text language sql as $$ select lifecycle_stage from public.quotes where id = pg_temp.q(p_n) $$;
select pg_temp.t('8a a quote with an unlocked menu: Confirmed, not Planning', pg_temp.stage('0030') = 'confirmed' and pg_temp.stage('0016') = 'confirmed' and pg_temp.stage('0031') = 'confirmed');
select pg_temp.ev('0040', 50000, 90, 'quote', 'sent', 'lead'); select pg_temp.pay('0040', 1000, 'r435-k40') ->> 'receipt_no' is not null;
select pg_temp.t('8b from Lead: Confirmed', pg_temp.stage('0040') = 'confirmed');
select pg_temp.t('8c a second payment does not push it either', pg_temp.pay('0040', 1000, 'r435-k40b') ->> 'receipt_no' is not null and pg_temp.stage('0040') = 'confirmed');
insert into public.event_plan(quote_id, org_id, menu_locked) values (pg_temp.q('0040'), :A, true) on conflict (quote_id) do update set menu_locked = true;
select pg_temp.t('8d menu locked, no layout: still Confirmed', pg_temp.pay('0040', 1000, 'r435-k40c') ->> 'receipt_no' is not null and pg_temp.stage('0040') = 'confirmed');
insert into public.quote_versions(quote_id, org_id, version_no, label, object_count) values (pg_temp.q('0040'), :A, 1, 'v1', 3);
select pg_temp.t('8e the 0198 gate open: the payment lands on Planning, as before', pg_temp.pay('0040', 1000, 'r435-k40d') ->> 'receipt_no' is not null and pg_temp.stage('0040') = 'planning', pg_temp.stage('0040'));
select pg_temp.ev('0041', 50000, 90, 'confirmed', 'approved', 'ready');
select pg_temp.t('8f a later stage never moves back', pg_temp.pay('0041', 1000, 'r435-k41') ->> 'receipt_no' is not null and pg_temp.stage('0041') = 'ready');
select pg_temp.t('8g a refused payment (too much, other studio, no Finance edit) moves nothing', pg_temp.pay('0032', 999999, 'r435-k32') ->> 'err' like '23514%' and pg_temp.stage('0032') = 'confirmed'
  and pg_temp.as_j('b_admin@b.test', format('select public.record_payment(%L, 10, ''cash'')', pg_temp.q('0032'))) ->> 'err' like '42501%' and pg_temp.as_j('r435_view@a.test', format('select public.record_payment(%L, 10, ''cash'')', pg_temp.q('0032'))) ->> 'err' like '42501%'
  and not exists (select 1 from public.quote_payments where quote_id = pg_temp.q('0032')) and not exists (select 1 from public.quote_advance_log where quote_id = pg_temp.q('0032')));
select pg_temp.t('8g2 ... nothing written by the refusals', not exists (select 1 from public.quote_payments where quote_id = pg_temp.q('0032')) and not exists (select 1 from public.quote_advance_log where quote_id = pg_temp.q('0032')));

-- ---- 9) the advance ----------------------------------------------------------------------------------------------------------------------------
create or replace function pg_temp.adv(p_who text, p_n text) returns jsonb language sql as $$ select pg_temp.as_j(p_who, format('select public.advance_get(%L)', pg_temp.q(p_n))) $$;
create or replace function pg_temp.ovr(p_who text, p_n text, p_pct text, p_reason text) returns jsonb language sql as $$
  select pg_temp.as_j(p_who, format('select public.advance_override_set(%L, %s, %L)', pg_temp.q(p_n), p_pct, p_reason)) $$;
select pg_temp.t('9a the studio number, fixed, amount of the invoice total, first plan line + differs', (select a ->> 'pct' = '40' and a ->> 'studio_pct' = '40' and a ->> 'fixed' = 'true' and a ->> 'source' = 'studio' and a -> 'override' = 'null'::jsonb
   and a ->> 'can_override' = 'true' and (a ->> 'amount')::numeric = 40000 and (a -> 'plan_first' ->> 'amount')::numeric = 30000 and (a -> 'plan_first' ->> 'percent')::numeric = 30 and a -> 'plan_first' ->> 'is_advance' = 'true' and a ->> 'differs' = 'true'
   from (select pg_temp.adv('a_admin@a.test', '0031') as a) x), pg_temp.adv('a_admin@a.test', '0031')::text);
select pg_temp.t('9b the same block is inside the schedule', pg_temp.sched('0031') -> 'advance' ->> 'pct' = '40' and pg_temp.sched('0031') -> 'advance' ->> 'differs' = 'true');
select pg_temp.t('9c crew, client login, signed out, other studio: refused', pg_temp.adv('r435_crew@a.test', '0031') ->> 'err' like '42501%' and pg_temp.adv('r435_cli@a.test', '0031') ->> 'err' like '42501%'
  and pg_temp.adv('anon', '0031') ->> 'err' like '42501%' and pg_temp.adv('b_admin@b.test', '0031') ->> 'err' like '42501%' and pg_temp.adv('r435_view@a.test', '0031') ->> 'can_override' = 'false');
update public.role_access set can_view = false where org_id = :A and role = 'operations' and area = 'finance';
select pg_temp.t('9d without Finance view: no amounts at all', (select a ->> 'pct' = '40' and a -> 'amount' = 'null'::jsonb and a -> 'plan_first' = 'null'::jsonb and a -> 'total' = 'null'::jsonb and a -> 'history' = '[]'::jsonb from (select pg_temp.adv('r435_view@a.test', '0031') as a) x), pg_temp.adv('r435_view@a.test', '0031')::text);
update public.role_access set can_view = true where org_id = :A and role = 'operations' and area = 'finance';
select pg_temp.t('9e override: Finance edit alone is not enough (the discount / price right is needed)', pg_temp.ovr('r435_fin@a.test', '0031', '25', 'Old client, paid fast') ->> 'err' like '42501 Only a studio admin%' and not exists (select 1 from public.quote_advance_log where quote_id = pg_temp.q('0031')));
insert into _kv values ('o9', pg_temp.ovr('a_admin@a.test', '0031', '25', '  Old client,   paid fast ')::text);
select pg_temp.t('9f an admin sets it with a reason: used at once, kept, audited', (select a ->> 'pct' = '25' and a ->> 'source' = 'override' and a -> 'override' ->> 'reason' = 'Old client, paid fast' and a -> 'override' ->> 'by' is not null and a -> 'override' ->> 'at' is not null and (a ->> 'amount')::numeric = 25000
   from (select v::jsonb as a from _kv where k = 'o9') x)
  and (select changed ->> 'reason' = 'Old client, paid fast' and (changed ->> 'to')::numeric = 25 and changed -> 'from' = 'null'::jsonb from public.audit_log where quote_id = pg_temp.q('0031') and action = 'advance.override'), pg_temp.adv('a_admin@a.test', '0031')::text);
insert into _kv values ('o9a', pg_temp.ovr('a_admin@a.test', '0031', '25', 'Old client, paid fast') ->> 'pct'); insert into _kv values ('o9n', (select count(*)::text from public.quote_advance_log where quote_id = pg_temp.q('0031')));
insert into _kv values ('o9b', pg_temp.ovr('a_admin@a.test', '0031', '12.345', 'Friend of the owner') ->> 'pct');
select pg_temp.t('9g the same form again adds nothing; another number adds one more row, the old one stays', (select string_agg(v, ',' order by k) = '25,12.35,1' from _kv where k in ('o9a', 'o9b', 'o9n')) and (select count(*) = 2 and array_agg(pct order by created_at) = array[25, 12.35]::numeric[] from public.quote_advance_log where quote_id = pg_temp.q('0031'))
  and jsonb_array_length(pg_temp.adv('a_admin@a.test', '0031') -> 'history') = 2);
select pg_temp.t('9h refused: below 0, above 100, empty, NaN, short / long / <> reason, cancelled, other studio', pg_temp.ovr('a_admin@a.test', '0031', '-1', 'A good reason') ->> 'err' like '22023%' and pg_temp.ovr('a_admin@a.test', '0031', '100.5', 'A good reason') ->> 'err' like '22023%'
  and pg_temp.ovr('a_admin@a.test', '0031', 'null', 'A good reason') ->> 'err' like '22023%' and pg_temp.ovr('a_admin@a.test', '0031', '''NaN''', 'A good reason') ->> 'err' like '22023%' and pg_temp.ovr('a_admin@a.test', '0031', '10', '  abc ') ->> 'err' like '22023%'
  and pg_temp.ovr('a_admin@a.test', '0031', '10', null) ->> 'err' like '22023%' and pg_temp.ovr('a_admin@a.test', '0031', '10', repeat('x', 301)) ->> 'err' like '22023%' and pg_temp.ovr('a_admin@a.test', '0031', '10', 'bad <b> one') ->> 'err' like '22023%'
  and pg_temp.ovr('a_admin@a.test', '0013', '10', 'A good reason') ->> 'err' like '22023%' and pg_temp.ovr('b_admin@b.test', '0031', '10', 'A good reason') ->> 'err' like '42501%' and (select count(*) = 2 from public.quote_advance_log where quote_id = pg_temp.q('0031')));
insert into public.role_access(role, area, can_view, can_edit, org_id, updated_at) values ('manager', 'discount_approve', true, true, :A, now()) on conflict (role, area, org_id) do update set can_view = true, can_edit = true;
insert into _kv values ('o9c', pg_temp.ovr('r435_fin@a.test', '0031', '0', 'Corporate client') ->> 'pct');
insert into _kv values ('o9d', pg_temp.as_j('r435_fin@a.test', format('select public.advance_override_clear(%L)', pg_temp.q('0031')))::text); insert into _kv values ('o9e', pg_temp.as_j('r435_fin@a.test', format('select public.advance_override_clear(%L, ''again'')', pg_temp.q('0031'))) ->> 'pct');
select pg_temp.t('9i a role with Finance edit AND "Approve discounts" may; clearing goes back to the studio number, history kept', (select v = '0' from _kv where k = 'o9c')
  and (select a ->> 'pct' = '40' and a ->> 'source' = 'studio' and a -> 'override' = 'null'::jsonb and jsonb_array_length(a -> 'history') = 4 from (select v::jsonb as a from _kv where k = 'o9d') x)
  and (select v = '40' from _kv where k = 'o9e') and (select count(*) = 4 from public.quote_advance_log where quote_id = pg_temp.q('0031')), pg_temp.adv('a_admin@a.test', '0031')::text);
select pg_temp.t('9j the history may not be written by the app', pg_temp.as_j('a_admin@a.test', format('insert into public.quote_advance_log(org_id, quote_id, kind, pct, reason) values (%L, %L, ''override'', 1, ''by hand'') returning to_jsonb(id)', :A, pg_temp.q('0031'))) ->> 'err' like '42501%'
  and pg_temp.as_j('a_admin@a.test', 'select to_jsonb(count(*)) from public.quote_advance_log') ->> 'err' like '42501%');
select pg_temp.t('9k another amount than the advance is never refused', pg_temp.pay('0031', 777, 'r435-k31b') ->> 'receipt_no' is not null);
delete from public.role_access where org_id = :A and area = 'discount_approve';
select pg_temp.t('9l the studio switch: Settings edit without the price right is refused, admin may; only that key changes; audited', pg_temp.as_j('r435_fin@a.test', $q$select public.payment_schedule_settings_set('{"advance_fixed":false}')$q$) ->> 'err' like '42501 Only a studio admin%'
  and pg_temp.as_j('a_admin@a.test', $q$select public.payment_schedule_settings_set('{"advance_fixed":"no"}')$q$) ->> 'err' like '22023%'
  and pg_temp.as_j('a_admin@a.test', $q$select public.payment_schedule_settings_set('{"advance_fixed":false}')$q$) ->> 'advance_fixed' = 'false' and pg_temp.adv('a_admin@a.test', '0031') ->> 'fixed' = 'false' and pg_temp.adv('a_admin@a.test', '0031') ->> 'pct' = '40');
select pg_temp.t('9l2 ... nothing else of the settings changed, audited', (select auto_apply and default_builtin = '30-50-20' from public.payment_schedule_settings where org_id = :A) and exists (select 1 from public.audit_log where org_id = :A and action = 'payment_schedule.settings' and changed = '{"advance_fixed": false}'));
select pg_temp.t('9m other settings still saved by Settings edit, together with the switch in one call for an admin', pg_temp.as_j('r435_fin@a.test', $q$select public.payment_schedule_settings_set('{"overdue_bell":true}')$q$) ->> 'overdue_bell' = 'true'
  and (select s ->> 'advance_fixed' = 'true' and s ->> 'overdue_bell' = 'false' and s ->> 'advance_pct' = '40' and s ->> 'can_edit_advance_fixed' = 'true' from (select pg_temp.as_j('a_admin@a.test', $q$select public.payment_schedule_settings_set('{"advance_fixed":true,"overdue_bell":false}')$q$) as s) x)
  and pg_temp.as_j('r435_crew@a.test', 'select public.payment_schedule_settings_get()') ->> 'err' like '42501%' and pg_temp.as_j('r435_fin@a.test', 'select public.payment_schedule_settings_get()') ->> 'can_edit_advance_fixed' = 'false');
update public.app_config set value = value || '{"advancePct":"55"}' where org_id = :A and key = 'pricing';
select pg_temp.t('9n the number follows the pricing config (one source)', pg_temp.adv('a_admin@a.test', '0031') ->> 'pct' = '55');
update public.app_config set value = value || '{"advancePct":"lots"}' where org_id = :A and key = 'pricing';
select pg_temp.t('9o an unusable value: no number, not fixed, nothing differs', (select a -> 'pct' = 'null'::jsonb and a ->> 'fixed' = 'false' and a -> 'source' = 'null'::jsonb and a -> 'differs' = 'null'::jsonb from (select pg_temp.adv('a_admin@a.test', '0031') as a) x));

-- ---- 10) the witness + the old shapes ----------------------------------------------------------------------------------------------------------
select pg_temp.t('10a nothing in this whole run changed a paid payment, a receipt, or deleted a money row', not exists (select 1 from _witness), (select string_agg(what, ', ') from _witness));
select pg_temp.t('10b the schedule answers everything it answered before (same values), plus held / approval / advance / rule', pg_temp.as_j('a_admin@a.test', format('select public.payment_schedule_for_quote__pre0435(%L)', pg_temp.q('0031'))) ->> 'err' like '42501%'
  and (select (n - 'held' - 'approval' - 'advance' - 'rows') = (o - 'rows') and (select jsonb_agg(x - 'rule' order by k) from jsonb_array_elements(n -> 'rows') with ordinality e(x, k)) = o -> 'rows' from (select pg_temp.sched('0031') as n, pg_temp.old_sched('0031') as o) z));

select name, result from _r5 where result <> 'PASS' order by name;
select case when count(*) filter (where result <> 'PASS') = 0
            then 'R252-PAYMENT-PLAN-0435: ALL PASS (' || count(*) || '/' || count(*) || ')'
            else 'R252-PAYMENT-PLAN-0435: FAILURES (' || count(*) filter (where result <> 'PASS') || ' of ' || count(*) || ')' end as summary
  from _r5;
rollback;
