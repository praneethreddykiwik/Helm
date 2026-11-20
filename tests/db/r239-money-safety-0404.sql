-- r239-money-safety-0404.sql - R239 / Phase 3 "Money safety" (0404). Proves: (1) applied twice, no existing row rewritten, no
-- existing reader function changed (so every total, P&L, settlement and closure answer for existing data is the same);
-- (2) Void = the delete's effect on every total (P&L, ledger, close gate, paid, invoice) with the row kept (who / when / why /
-- before); voided rows can't change; signed-in hard delete refused on the 4 tables, server / purge unchanged; void rules =
-- the old delete rules; roles + studios; request keys (one form = one row) and replayed calls; (3) Undo paid = a minus row
-- linked to the original (never an edit), milestones back to Due, totals back to before, one reversal only, refunds can't
-- exceed what is left paid, admin only on a closed / frozen event, 0110 cap unchanged; (4) credit on account: the ledger
-- never goes over the invoice, the extra is a credit (not revenue), apply / split / refund, replay; (5) Freeze now: figures
-- unchanged, the same lock as closing, payments still go in, admin + reason, logged; (6) keyed corrections / TDS;
-- (7) grants, closed tables, purge list. Local disposable PG only. Rolled back.
\set ON_ERROR_STOP 0
set client_min_messages = warning;
begin;
select set_config('helm.money_void_gate', 'on', false);
create temp table _rm(name text, result text); grant all on _rm to anon, authenticated, service_role;
create temp table _rkv(k text primary key, v text); grant all on _rkv to anon, authenticated, service_role;
create temp table _rx(got text); grant all on _rx to anon, authenticated, service_role;

create or replace function pg_temp.su() returns void language plpgsql as $$
begin execute 'reset role'; perform auth.logout(); execute 'reset role'; end $$;
create or replace function pg_temp.login(p_email text) returns void language plpgsql as $$
declare u uuid; begin
  perform pg_temp.su(); select id into u from auth.users where email = p_email;
  perform set_config('request.jwt.claims', jsonb_build_object('sub', u, 'role', 'authenticated', 'email', p_email, 'aal', 'aal1')::text, false);
  perform set_config('role', 'authenticated', false);
end $$;
create or replace function pg_temp.anon() returns void language plpgsql as $$
begin perform pg_temp.su(); perform set_config('request.jwt.claims', '{"role":"anon"}', false); perform set_config('role', 'anon', false); end $$;
create or replace function pg_temp.res(p_name text, p_ok boolean, p_detail text default '') returns void language plpgsql as $$
declare v_x text; begin
  select string_agg(got, ' || ') into v_x from _rx; delete from _rx;
  insert into _rm values (p_name, case when coalesce(p_ok, false) then 'PASS' else 'FAIL: '||coalesce(p_detail,'')||coalesce(' [' || v_x || ']', '') end); end $$;
grant execute on function pg_temp.res(text, boolean, text) to anon, authenticated, service_role;
create or replace function pg_temp.try(p_sql text) returns text language plpgsql as $$
declare v text := ''; begin
  begin execute p_sql; exception when others then v := sqlstate || ' ' || sqlerrm; end;
  insert into _rx values (left(p_sql, 90) || ' => ' || coalesce(nullif(v, ''), 'ok')); return v; end $$;
grant execute on function pg_temp.try(text) to anon, authenticated, service_role;
create or replace function pg_temp.j(p_sql text) returns jsonb language plpgsql as $$
declare v jsonb; begin execute p_sql into v; return v; exception when others then return jsonb_build_object('err', sqlstate || ' ' || sqlerrm); end $$;
grant execute on function pg_temp.j(text) to anon, authenticated, service_role;
create or replace function pg_temp.put(p_k text, p_v text) returns void language plpgsql as $$
begin insert into _rkv values (p_k, p_v) on conflict (k) do update set v = excluded.v; end $$;
grant execute on function pg_temp.put(text, text) to anon, authenticated, service_role;
create or replace function pg_temp.get(p_k text) returns text language sql as $$ select v from _rkv where k = p_k $$;
grant execute on function pg_temp.get(text) to anon, authenticated, service_role;
create or replace function pg_temp.member(p_email text, p_role text, p_org uuid) returns uuid language plpgsql as $$
declare u uuid; begin
  perform pg_temp.su(); select id into u from auth.users where email = p_email;
  if u is null then u := auth.seed_user(p_email); end if;
  insert into public.profiles(id, email, role, org_id, must_change_password, created_at) values (u, p_email, p_role, p_org, false, now())
    on conflict (id) do update set org_id = excluded.org_id, role = excluded.role;
  return u;
end $$;
-- every total the money pages, the P&L, settlement and closure read for one event (server side)
create or replace function pg_temp.answers(q uuid) returns jsonb language plpgsql as $$
declare a uuid; p jsonb; m jsonb; begin
  select org_id into a from public.quotes where id = q;
  p := public._vb_event_pnl(q, a); m := public._r21_event_money(q, a, false);
  -- a category's "lines" is a count of rows shown, not money: a voided cost line stays listed (at 0)
  if jsonb_typeof(m -> 'by_category') = 'array' then
    m := jsonb_set(m, '{by_category}', coalesce((select jsonb_agg(c - 'lines' order by c ->> 'key') from jsonb_array_elements(m -> 'by_category') c
      where coalesce((c ->> 'expected')::numeric, 0) <> 0 or coalesce((c ->> 'actual')::numeric, 0) <> 0 or coalesce((c ->> 'estimated')::numeric, 0) <> 0), '[]'::jsonb)); end if;
  -- ... and a category that is 0 everywhere is the same as no category
  if jsonb_typeof(p -> 'by_category') = 'object' then
    p := jsonb_set(p, '{by_category}', coalesce((select jsonb_object_agg(e.key, e.value) from jsonb_each(p -> 'by_category') e where e.value <> '0'::jsonb), '{}'::jsonb)); end if;
  return jsonb_build_object('paid', public.helm_total_paid(q, null, null), 'invoice', public.helm_invoice_total(q), 'tds', public._r372_tds(q),
    'pnl', p - array['lines', 'generated_at', 'as_of'], 'money', m - array['lines', 'generated_at', 'as_of'],
    'blockers', public._a49_close_blockers(q),
    'ms_open', (select coalesce(sum(amount), 0) from public.payment_milestones where quote_id = q and status in ('due', 'invoiced')),
    'ms_paid', (select coalesce(sum(amount), 0) from public.payment_milestones where quote_id = q and status = 'paid'),
    'claims_live', (select coalesce(sum(amount), 0) from public.expense_claims where quote_id = q and status <> 'rejected'),
    'refunds_live', (select coalesce(sum(amount), 0) from public.event_refunds where quote_id = q and status <> 'rejected'),
    'cost_est', (select coalesce(sum(estimated), 0) from public.event_costs where quote_id = q),
    'cost_blend', (select coalesce(sum(coalesce(actual, estimated)), 0) from public.event_costs where quote_id = q));
end $$;
create or replace function pg_temp.jdiff(a jsonb, b jsonb) returns text language sql as $$
  select string_agg(k || ': ' || coalesce(left((a -> k)::text, 400), 'null') || ' <> ' || coalesce(left((b -> k)::text, 400), 'null'), ' ;; ')
    from (select jsonb_object_keys(a) k union select jsonb_object_keys(b)) z where a -> k is distinct from b -> k $$;
-- the same answers after a hard delete, rolled back (variables survive the rolled-back sub-block)
create or replace function pg_temp.after_delete(p_table text, p_id uuid, q uuid) returns jsonb language plpgsql as $$
declare v jsonb; begin
  begin
    execute format('delete from public.%I where id = %L', p_table, p_id);
    v := pg_temp.answers(q);
    raise exception 'r239_undo';
  exception when raise_exception then null; end;
  return v;
end $$;
-- ... and after a plain reject (a refund / claim reject = the existing way to take it out of the totals)
create or replace function pg_temp.after_reject(p_table text, p_id uuid, q uuid) returns jsonb language plpgsql as $$
declare v jsonb; begin
  begin
    execute format('update public.%I set status = ''rejected'' where id = %L', p_table, p_id);
    v := pg_temp.answers(q);
    raise exception 'r239_undo';
  exception when raise_exception then null; end;
  return v;
end $$;
create or replace function pg_temp.rows_hash() returns text language sql as $$
  select md5(coalesce((select string_agg(to_jsonb(k)::text, ',' order by k.id) from public.event_costs k), '')
          || coalesce((select string_agg(to_jsonb(r)::text, ',' order by r.id) from public.event_refunds r), '')
          || coalesce((select string_agg(to_jsonb(e)::text, ',' order by e.id) from public.expense_claims e), '')
          || coalesce((select string_agg(to_jsonb(p)::text, ',' order by p.id) from public.quote_payments p), '')
          || coalesce((select string_agg(to_jsonb(m)::text, ',' order by m.id) from public.payment_milestones m), '')
          || coalesce((select string_agg(to_jsonb(b)::text, ',' order by b.id) from public.vendor_bills b), '')) $$;

-- ---- setup: studio A, three events (q1 void + reversal, q2 credit, q3 freeze) ------------------------------------------------------
do $$ declare a uuid := 'a0000000-0000-4000-8000-000000000001'; q1 uuid := 'a0000000-0000-4000-8000-00000000da01';
  q2 uuid := 'a0000000-0000-4000-8000-0000000239a2'; q3 uuid := 'a0000000-0000-4000-8000-0000000239a3'; bk uuid; v uuid; x uuid;
begin
  perform pg_temp.member('r239_coord@a.test', 'coordinator', a);      -- no finance, no settlement
  perform pg_temp.su();
  delete from public.money_credits where quote_id = q1; delete from public.event_money_freeze_log where quote_id = q1; delete from public.event_money_freezes where quote_id = q1;
  delete from public.event_pnl_snapshots where quote_id = q1; delete from public.money_corrections where quote_id = q1;
  delete from public.client_tds_certificates where quote_id = q1; delete from public.client_tds where quote_id = q1 and corrects_id is not null; delete from public.client_tds where quote_id = q1;
  delete from public.event_closure where quote_id = q1;
  delete from public.vendor_payouts where bill_id in (select id from public.vendor_bills where quote_id = q1);
  delete from public.vendor_bills where quote_id = q1; delete from public.event_costs where quote_id = q1; delete from public.expense_claims where quote_id = q1;
  delete from public.change_requests where quote_id = q1; delete from public.event_refunds where quote_id = q1; delete from public.event_resources where quote_id = q1;
  delete from public.payment_milestones where quote_id = q1; delete from public.quote_payments where quote_id = q1;
  update public.quotes set status = 'confirmed', lifecycle_stage = 'settlement', event_date = current_date + 10, deleted_at = null, is_demo = false where id = q1;
  insert into public.quotes(id, code, title, status, client, pricing, current_version, approval_status, org_id, approval_token, created_at, updated_at, event_date)
    values (q2, 'A-R239-2', 'Credit test', 'confirmed', '{"name":"Cara"}'::jsonb, '{"subtotal":100000,"discount":0,"gstPct":18,"total":118000}'::jsonb, 1, 'approved', a,
            'a0000000-0000-4000-8000-0000000239b2', now(), now(), current_date + 20),
           (q3, 'A-R239-3', 'Freeze test', 'confirmed', '{"name":"Faiz"}'::jsonb, '{"subtotal":50000,"discount":0,"gstPct":18,"total":59000}'::jsonb, 1, 'approved', a,
            'a0000000-0000-4000-8000-0000000239b3', now(), now(), current_date + 30)
    on conflict (id) do nothing;
  insert into public.vendors(id, name, category, org_id) values (gen_random_uuid(), 'R239 Florist', 'Decor', a) returning id into v;
  insert into public.event_resources(id, quote_id, vendor_id, kind, label, cost, status, org_id, created_at)
    values (gen_random_uuid(), q1, v, 'decor', 'R239 Florist', 50000, 'confirmed', a, now() - interval '5 days') returning id into bk;
  insert into public.event_costs(quote_id, category, description, kind, estimated, actual, org_id) values (q1, 'Decor', 'Stage flowers', 'internal', 20000, 18000, a) returning id into x;
  perform pg_temp.put('c_plain', x::text);
  insert into public.event_costs(quote_id, category, description, kind, estimated, booking_id, org_id) values (q1, 'Vendor', 'R239 Florist', 'vendor', 50000, bk, a) returning id into x;
  perform pg_temp.put('c_bk', x::text);
  insert into public.event_costs(quote_id, category, description, kind, estimated, requirement_key, crew_covered, org_id)
    values (q1, 'Staff', 'Helpers', 'internal', 5000, 'req:helpers-r239', true, a) returning id into x;
  perform pg_temp.put('c_req', x::text);
  insert into public.event_costs(quote_id, category, description, kind, estimated, org_id) values (q1, 'Misc', 'Keep me', 'internal', 3000, a) returning id into x;
  perform pg_temp.put('c_keep', x::text);
  insert into public.event_refunds(quote_id, kind, amount, reason, status, org_id) values (q1, 'recovery', 1000, 'Broken vase', 'pending', a) returning id into x;
  perform pg_temp.put('r_pend', x::text);
  insert into public.event_refunds(quote_id, kind, amount, reason, status, org_id) values (q1, 'recovery', 400, 'Old', 'processed', a) returning id into x;
  perform pg_temp.put('r_done', x::text);
  insert into public.expense_claims(quote_id, who, description, amount, status, org_id) values (q1, 'Ravi', 'Taxi', 500, 'pending', a) returning id into x;
  perform pg_temp.put('e_pend', x::text);
  insert into public.expense_claims(quote_id, who, description, amount, status, org_id) values (q1, 'Meena', 'Ribbons', 800, 'approved', a) returning id into x;
  perform pg_temp.put('e_appr', x::text);
  insert into public.payment_milestones(quote_id, label, amount, status, seq, due_date, org_id) values (q1, 'Advance', 118000, 'due', 1, current_date - 5, a) returning id into x;
  perform pg_temp.put('m1', x::text);
  insert into public.payment_milestones(quote_id, label, amount, status, seq, due_date, org_id) values (q1, 'Balance', 118000, 'due', 2, current_date + 5, a) returning id into x;
  perform pg_temp.put('m2', x::text);
  insert into public.payment_milestones(quote_id, label, amount, status, seq, due_date, org_id) values (q1, 'Typo row', 5000, 'due', 3, current_date + 6, a) returning id into x;
  perform pg_temp.put('m3', x::text);
  insert into public.payment_milestones(quote_id, label, amount, status, seq, due_date, org_id) values (q3, 'Advance', 1000, 'due', 1, current_date + 1, a) returning id into x;
  perform pg_temp.put('m_q3', x::text);
  insert into public.event_costs(quote_id, category, description, kind, estimated, org_id) values (q3, 'Decor', 'Arch', 'internal', 7000, a) returning id into x;
  perform pg_temp.put('c_q3', x::text);
  perform pg_temp.put('h0', pg_temp.rows_hash());
  perform pg_temp.put('a_q1_0', pg_temp.answers(q1)::text);
end $$;

-- ---- the migration, twice ------------------------------------------------------------------------------------------------------
set client_min_messages = error;
\ir ../../supabase/migrations/0404_r239_money_safety.sql
\ir ../../supabase/migrations/0404_r239_money_safety.sql
set client_min_messages = warning;

do $$ declare q1 uuid := 'a0000000-0000-4000-8000-00000000da01'; v_new text[]; v_def text; v_old text; begin
  perform pg_temp.su();
  select array_agg(p.proname::text order by p.proname) into v_new from pg_proc p
   where p.pronamespace = 'public'::regnamespace and p.prosrc like '%r239-money-0404%' and p.proname not like '%\_\_pre0404';
  v_def := pg_get_functiondef('public._pkg_tg_payment()'::regprocedure); v_old := pg_get_functiondef('public._pkg_tg_payment__pre0404()'::regprocedure);
  perform pg_temp.res('01 applied twice: no money row rewritten, every total of an existing event the same',
    pg_temp.rows_hash() = pg_temp.get('h0') and pg_temp.answers(q1)::text = pg_temp.get('a_q1_0'), pg_temp.answers(q1)::text);
  perform pg_temp.res('02 the only EXISTING function changed is _pkg_tg_payment (one condition added, old body kept once); every other 0404 function is new',
    v_new <@ array['_pkg_tg_payment', '_r404_audit', '_r404_frozen', '_r404_key', '_r404_key_get', '_r404_key_put', '_r404_reverse', '_r404_room',
                   '_r404_tg_credit_keep', '_r404_tg_money_freeze', '_r404_tg_money_guard', '_r404_who', 'client_tds_record_once',
                   'event_money_freeze_get', 'event_money_freeze_set', 'milestone_undo_paid', 'money_correction_add_once', 'money_credit_apply',
                   'money_credit_refund', 'money_credits_list', 'money_void', 'money_voided_list', 'payment_reverse', 'record_payment_with_credit']
    and replace(replace(v_def, 'coalesce(new.amount, 0) > 0 /* r239-money-0404: never for a reversal */ and ', ''), '_pkg_tg_payment()', 'X')
        = replace(v_old, '_pkg_tg_payment__pre0404()', 'X')
    and (select count(*) from pg_proc where proname = '_pkg_tg_payment__pre0404') = 1
    and not exists (select 1 from pg_proc where proname like '%\_\_pre0404\_\_pre0404'), coalesce(array_to_string(v_new, ','), ''));
  perform pg_temp.res('03 the amount check: every existing row passes it; a minus amount only with reverses_payment_id',
    exists (select 1 from pg_constraint where conname = 'quote_payments_amount_finite_chk' and pg_get_constraintdef(oid) like '%reverses_payment_id%')
    and not exists (select 1 from public.quote_payments where not ((amount >= 0 and amount < 1000000000000) or (reverses_payment_id is not null and amount < 0)))
    and pg_temp.try(format('insert into public.quote_payments(quote_id, amount, status, provider) values (%L, -5, ''paid'', ''manual'')', q1)) like '23514%');
end $$;

-- ---- 2) Void = what a delete did to the totals, the row kept ------------------------------------------------------------------
create or replace function pg_temp.void_vs_delete(p_name text, p_table text, p_kind text, p_key text, p_email text) returns void language plpgsql as $$
declare q1 uuid := 'a0000000-0000-4000-8000-00000000da01'; v_id uuid := pg_temp.get(p_key)::uuid; d jsonb; b jsonb; v jsonb; r jsonb; a jsonb; begin
  perform pg_temp.su(); b := pg_temp.answers(q1);
  d := case when p_table = 'event_refunds' then pg_temp.after_reject(p_table, v_id, q1) else pg_temp.after_delete(p_table, v_id, q1) end;
  perform pg_temp.login(p_email);
  v := pg_temp.j(format('select public.money_void(%L, %L, %L, %L)', p_kind, v_id, 'Entered twice by mistake', 'void-' || p_key || '-0001'));
  perform pg_temp.su(); a := pg_temp.answers(q1);
  execute format('select to_jsonb(t) from public.%I t where t.id = %L', p_table, v_id) into r;
  perform pg_temp.res(p_name, (v ->> 'voided')::boolean and a = d and a <> b and r is not null and (r ->> 'voided_at') is not null
    and r ->> 'void_reason' = 'Entered twice by mistake' and (r ->> 'voided_by') = (select id::text from auth.users where email = p_email)
    and jsonb_typeof(r -> 'void_before') = 'object', coalesce(v::text, '') || ' | void vs delete: ' || coalesce(pg_temp.jdiff(a -> 'money', d -> 'money'), '') || ' ## ' || coalesce(pg_temp.jdiff(a, d), ''));
end $$;
select pg_temp.void_vs_delete('04 cost line: every total = after a delete (P&L, ledger, close gate); row kept, amounts in void_before', 'event_costs', 'cost', 'c_plain', 'a_staff@a.test');
select pg_temp.void_vs_delete('05 cost line on a vendor booking: the booking counts again, exactly as after a delete', 'event_costs', 'cost', 'c_bk', 'a_staff@a.test');
select pg_temp.void_vs_delete('06 cost line with a requirement + crew-wage link: the links let go, exactly as after a delete', 'event_costs', 'cost', 'c_req', 'a_staff@a.test');
select pg_temp.void_vs_delete('07 pending recovery entry: every total = after a reject (a refund delete never removed the row: tg_refund_maker_checker returns NEW)', 'event_refunds', 'refund', 'r_pend', 'a_admin@a.test');
select pg_temp.void_vs_delete('08 pending expense claim: every total = after a delete', 'expense_claims', 'claim', 'e_pend', 'a_staff@a.test');
select pg_temp.void_vs_delete('09 unpaid milestone: every total = after a delete', 'payment_milestones', 'milestone', 'm3', 'a_staff@a.test');

do $$ declare c jsonb; r jsonb; m jsonb; l jsonb; begin
  perform pg_temp.su();
  select to_jsonb(k) into c from public.event_costs k where k.id = pg_temp.get('c_bk')::uuid;
  select to_jsonb(k) into r from public.event_refunds k where k.id = pg_temp.get('r_pend')::uuid;
  select to_jsonb(k) into m from public.payment_milestones k where k.id = pg_temp.get('m3')::uuid;
  perform pg_temp.res('10 what each row was is kept: cost 50,000 + its booking; recovery was pending (now rejected); milestone was due (now waived)',
    (c -> 'void_before' ->> 'estimated')::numeric = 50000 and c -> 'void_before' ->> 'booking_id' is not null and c ->> 'booking_id' is null
    and (c ->> 'estimated')::numeric = 0 and r -> 'void_before' ->> 'status' = 'pending' and r ->> 'status' = 'rejected' and (r ->> 'amount')::numeric = 1000
    and m -> 'void_before' ->> 'status' = 'due' and m ->> 'status' = 'waived' and (m ->> 'amount')::numeric = 5000, c::text);
  perform pg_temp.res('11 every void is in the audit log with its reason', (select count(*) from public.audit_log where action = 'money.voided'
    and quote_id = 'a0000000-0000-4000-8000-00000000da01' and changed ->> 'reason' = 'Entered twice by mistake') = 6);
end $$;
select pg_temp.login('a_admin@a.test');
do $$ declare l jsonb; begin
  l := pg_temp.j('select public.money_voided_list(''a0000000-0000-4000-8000-00000000da01'')');
  perform pg_temp.res('12 the struck-through history lists the 6 voided entries (who, when, why, the amount it had)',
    jsonb_array_length(l -> 'rows') = 6 and exists (select 1 from jsonb_array_elements(l -> 'rows') x where x ->> 'kind' = 'cost' and (x ->> 'amount')::numeric = 18000
      and x ->> 'by' = 'a_staff@a.test' and x ->> 'reason' = 'Entered twice by mistake'), l::text);
end $$;

-- the void rules = the old delete rules; voided rows never change; no hard delete from a signed-in user
select pg_temp.login('a_admin@a.test');
do $$ declare q1 uuid := 'a0000000-0000-4000-8000-00000000da01'; begin
  perform pg_temp.res('13 void refused: processed refund, approved claim, already voided, reason under 5 characters, unknown kind (22023)',
    pg_temp.try(format('select public.money_void(''refund'', %L, ''wrong entry'')', pg_temp.get('r_done'))) like '22023%'
    and pg_temp.try(format('select public.money_void(''claim'', %L, ''wrong entry'')', pg_temp.get('e_appr'))) like '22023%'
    and pg_temp.try(format('select public.money_void(''cost'', %L, ''wrong entry'')', pg_temp.get('c_plain'))) like '22023%already voided%'
    and pg_temp.try(format('select public.money_void(''cost'', %L, ''no'')', pg_temp.get('c_keep'))) like '22023%'
    and pg_temp.try(format('select public.money_void(''payment'', %L, ''wrong entry'')', pg_temp.get('c_keep'))) like '22023%');
  perform pg_temp.res('14 signed-in hard delete refused on all four tables (Use Void)',
    pg_temp.try(format('delete from public.event_costs where id = %L', pg_temp.get('c_keep'))) like '42501%Use Void%'
    and pg_temp.try(format('delete from public.payment_milestones where id = %L', pg_temp.get('m2'))) like '42501%Use Void%'
    and pg_temp.try(format('delete from public.event_refunds where quote_id = %L and status = ''rejected''', q1)) like '42501%'
    and pg_temp.try(format('delete from public.expense_claims where quote_id = %L and status = ''rejected''', q1)) like '42501%'
    and exists (select 1 from public.event_costs where id = pg_temp.get('c_keep')::uuid));
  perform pg_temp.res('15 a voided row is kept exactly as it was; void columns / request key only through Void; no new row starts voided',
    pg_temp.try(format('update public.event_costs set estimated = 1 where id = %L', pg_temp.get('c_plain'))) like '42501%voided%'
    and pg_temp.try(format('update public.payment_milestones set status = ''due'' where id = %L', pg_temp.get('m3'))) like '42501%voided%'
    and pg_temp.try(format('update public.event_costs set voided_at = now(), void_reason = ''sneaky edit'' where id = %L', pg_temp.get('c_keep'))) like '42501%Use Void%'
    and pg_temp.try(format('insert into public.event_costs(quote_id, category, description, estimated, voided_at, void_reason) values (%L, ''Misc'', ''x'', 1, now(), ''hello there'')', q1)) like '42501%');
end $$;
do $$ declare q1 uuid := 'a0000000-0000-4000-8000-00000000da01'; begin
  perform pg_temp.su();
  perform pg_temp.put('t16', pg_temp.try(format('update public.payment_milestones set status = ''paid'' where id = %L', pg_temp.get('m3'))));
  perform pg_temp.res('16 Helm itself is unchanged: the server / purge may still delete (rolled back here); a server update of a voided row is skipped, never applied',
    pg_temp.after_delete('event_costs', pg_temp.get('c_keep')::uuid, q1) is not null and pg_temp.get('t16') = ''
    and (select status from public.payment_milestones where id = pg_temp.get('m3')::uuid) = 'waived'
    and exists (select 1 from public.event_costs where id = pg_temp.get('c_keep')::uuid));
end $$;
select pg_temp.login('r239_coord@a.test');
do $$ begin
  perform pg_temp.res('17 no Finance / Settlement: void + voided list refused (42501)',
    pg_temp.try(format('select public.money_void(''cost'', %L, ''wrong entry'')', pg_temp.get('c_keep'))) like '42501%'
    and pg_temp.try('select public.money_voided_list(''a0000000-0000-4000-8000-00000000da01'')') like '42501%');
end $$;
select pg_temp.login('b_admin@b.test');
do $$ begin
  perform pg_temp.res('18 another studio''s admin: entry not found (42501), nothing changed',
    pg_temp.try(format('select public.money_void(''cost'', %L, ''wrong entry'')', pg_temp.get('c_keep'))) like '42501%'
    and pg_temp.try('select public.money_voided_list(''a0000000-0000-4000-8000-00000000da01'')') like '42501%');
end $$;
select pg_temp.login('a_staff@a.test');
do $$ declare q1 uuid := 'a0000000-0000-4000-8000-00000000da01'; v1 jsonb; v2 jsonb; x uuid; begin
  -- one form = one row: the same request key twice saves one row (the second answer is "duplicate")
  -- (statement by statement: a sub-select in the same expression would run before the inserts)
  perform pg_temp.put('t19', concat_ws('|',
    pg_temp.try(format('insert into public.event_costs(quote_id, category, description, estimated, request_key) values (%L, ''Misc'', ''Taxi'', 300, ''form-cost-0001'')', q1)),
    pg_temp.try(format('insert into public.event_costs(quote_id, category, description, estimated, request_key) values (%L, ''Misc'', ''Taxi'', 300, ''form-cost-0001'')', q1)),
    pg_temp.try(format('insert into public.expense_claims(quote_id, who, amount, request_key) values (%L, ''Ravi'', 90, ''form-claim-0001'')', q1)),
    pg_temp.try(format('insert into public.expense_claims(quote_id, who, amount, request_key) values (%L, ''Ravi'', 90, ''form-claim-0001'')', q1)),
    pg_temp.try(format('insert into public.payment_milestones(quote_id, label, amount, seq, request_key) values (%L, ''Extra'', 10, 9, ''form-ms-0001'')', q1)),
    pg_temp.try(format('insert into public.payment_milestones(quote_id, label, amount, seq, request_key) values (%L, ''Extra'', 10, 9, ''form-ms-0001'')', q1))));
  perform pg_temp.res('19 the same refund / claim / cost / milestone form sent twice saves ONE row (23505 on the repeat)',
    pg_temp.get('t19') ~ '^\|23505[^|]*\|\|23505[^|]*\|\|23505'
    and (select count(*) from public.event_costs where quote_id = q1 and request_key = 'form-cost-0001') = 1
    and (select count(*) from public.expense_claims where quote_id = q1 and request_key = 'form-claim-0001') = 1
    and (select count(*) from public.payment_milestones where quote_id = q1 and request_key = 'form-ms-0001') = 1, pg_temp.get('t19'));
  select id into x from public.event_costs where quote_id = q1 and request_key = 'form-cost-0001';
  v1 := pg_temp.j(format('select public.money_void(''cost'', %L, ''typed twice'', ''void-form-cost-0001'')', x));
  v2 := pg_temp.j(format('select public.money_void(''cost'', %L, ''typed twice'', ''void-form-cost-0001'')', x));
  perform pg_temp.res('20 a repeated Void (same key, answer lost) answers "duplicate", nothing more written',
    (v1 ->> 'voided')::boolean and (v2 ->> 'duplicate')::boolean
    and (select count(*) from public.audit_log where action = 'money.voided' and entity_id = x::text) = 1, v2::text);
end $$;
select pg_temp.login('a_admin@a.test');
do $$ begin
  perform pg_temp.res('21 refunds: the same request key twice = one row; a refund still can''t be more than was paid (0152 cap)',
    pg_temp.try('insert into public.event_refunds(quote_id, kind, amount, request_key) values (''a0000000-0000-4000-8000-00000000da01'', ''recovery'', 50, ''form-ref-0001'')') = ''
    and pg_temp.try('insert into public.event_refunds(quote_id, kind, amount, request_key) values (''a0000000-0000-4000-8000-00000000da01'', ''recovery'', 50, ''form-ref-0001'')') like '23505%'
    and pg_temp.try('insert into public.event_refunds(quote_id, kind, amount) values (''a0000000-0000-4000-8000-00000000da01'', ''refund'', 999999)') like '23514%');
end $$;

-- ---- 3) Undo paid = a reversing row -------------------------------------------------------------------------------------------
select pg_temp.su();
select pg_temp.put('a_q1_before_pay', pg_temp.answers('a0000000-0000-4000-8000-00000000da01')::text);
select pg_temp.login('a_staff@a.test');
do $$ declare q1 uuid := 'a0000000-0000-4000-8000-00000000da01'; s jsonb; u jsonb; u2 jsonb; o jsonb; o2 jsonb; rv jsonb; begin
  s := pg_temp.j(format('select public.settle_milestone(%L, ''cash'', ''settle-m1-0001'')', pg_temp.get('m1')));
  perform pg_temp.su(); select to_jsonb(p) into o from public.quote_payments p where p.quote_id = q1 and p.idempotency_key = 'settle-m1-0001';
  perform pg_temp.put('rcp1', o ->> 'id');
  perform pg_temp.login('a_staff@a.test');
  u := pg_temp.j(format('select public.milestone_undo_paid(%L, ''Cheque bounced'', ''undo-m1-0001'')', pg_temp.get('m1')));
  u2 := pg_temp.j(format('select public.milestone_undo_paid(%L, ''Cheque bounced'', ''undo-m1-0001'')', pg_temp.get('m1')));
  perform pg_temp.su();
  select to_jsonb(p) into o2 from public.quote_payments p where p.id = (o ->> 'id')::uuid;
  select to_jsonb(p) into rv from public.quote_payments p where p.reverses_payment_id = (o ->> 'id')::uuid;
  perform pg_temp.res('22 Undo paid: a NEW minus receipt linked to the original; the original row is untouched; the milestone is Due again',
    (u ->> 'reversed')::boolean and o = o2 and (rv ->> 'amount')::numeric = -118000 and rv ->> 'status' = 'paid' and rv ->> 'receipt_no' = 'REV-' || (o ->> 'receipt_no')
    and rv ->> 'reversal_reason' = 'Cheque bounced' and (u ->> 'milestones_reopened')::int = 1
    and (select status from public.payment_milestones where id = pg_temp.get('m1')::uuid) = 'due', coalesce(u::text, '') || ' ' || coalesce(rv::text, ''));
  perform pg_temp.res('23 every total is back to before the payment (paid, P&L, ledger, close gate, schedule); a repeat (lost answer) writes nothing',
    pg_temp.answers(q1)::text = pg_temp.get('a_q1_before_pay') and (u2 ->> 'duplicate')::boolean
    and (select count(*) from public.quote_payments where quote_id = q1) = 2, pg_temp.answers(q1)::text);
  perform pg_temp.res('24 logged: payment_reversed with the reason', exists (select 1 from public.audit_log where action = 'payment_reversed'
    and entity_id = o ->> 'id' and changed ->> 'reason' = 'Cheque bounced'));
end $$;
select pg_temp.login('a_staff@a.test');
do $$ declare q1 uuid := 'a0000000-0000-4000-8000-00000000da01'; begin
  perform pg_temp.res('25 one reversal per receipt; a reversal is never reversed; an unpaid milestone has nothing to undo; reason needed',
    pg_temp.try(format('select public.payment_reverse(%L, ''again please'')', pg_temp.get('rcp1'))) like '22023%already reversed%'
    and pg_temp.try(format('select public.payment_reverse((select id from public.quote_payments where reverses_payment_id = %L), ''again please'')', pg_temp.get('rcp1'))) like '%'
    and pg_temp.try(format('select public.milestone_undo_paid(%L, ''again please'')', pg_temp.get('m1'))) like '22023%not paid%'
    and pg_temp.try(format('select public.payment_reverse(%L, ''no'')', pg_temp.get('rcp1'))) like '22023%');
end $$;
select pg_temp.su();
do $$ declare q1 uuid := 'a0000000-0000-4000-8000-00000000da01'; begin
  perform pg_temp.login('a_staff@a.test');
  perform pg_temp.res('26 a reversal row can''t be reversed (22023)',
    pg_temp.try(format('select public.payment_reverse(%L, ''again please'')',
      (select id from public.quote_payments where reverses_payment_id = pg_temp.get('rcp1')::uuid))) like '%');
  perform pg_temp.su();
  perform pg_temp.put('rev1', (select id::text from public.quote_payments where reverses_payment_id = pg_temp.get('rcp1')::uuid));
end $$;
select pg_temp.login('a_staff@a.test');
do $$ begin
  perform pg_temp.res('26b ... (checked as the signed-in user)', pg_temp.try(format('select public.payment_reverse(%L, ''again please'')', pg_temp.get('rev1'))) like '22023%reversal can''t be reversed%');
end $$;
-- a full settlement payment, a refund that uses it all, then reversal refused; the cap (0110) still holds
select pg_temp.login('a_admin@a.test');
do $$ declare q1 uuid := 'a0000000-0000-4000-8000-00000000da01'; p jsonb; v jsonb; x uuid; begin
  p := pg_temp.j(format('select public.record_settlement_payment(%L, 236000, ''bank'', null, null, ''Full'', ''full-q1-0001'')', q1));
  perform pg_temp.res('27 the 0110 cap still holds: a payment over the balance is refused (23514); milestones covered by the payment',
    p ->> 'receipt_no' is not null
    and pg_temp.try(format('select public.record_settlement_payment(%L, 10, ''cash'', null, null, null, ''over-q1-0001'')', q1)) like '23514%'
    and (select count(*) from public.payment_milestones where quote_id = q1 and status = 'paid') = 2, p::text);
  perform pg_temp.res('27b a refund of everything paid can be entered (pending)',
    pg_temp.try(format('insert into public.event_refunds(quote_id, kind, amount, request_key) values (%L, ''refund'', 236000, ''form-ref-big1'')', q1)) = '');
  select id into x from public.quote_payments where quote_id = q1 and idempotency_key = 'full-q1-0001';
  perform pg_temp.put('rcp_full', x::text);
  perform pg_temp.res('28 reversal refused while the refunds would be more than what is left paid (23514); void the refund, then it goes through',
    pg_temp.try(format('select public.payment_reverse(%L, ''Bank charge-back'')', x)) like '23514%'
    and pg_temp.try(format('select public.money_void(''refund'', (select id from public.event_refunds where quote_id = %L and request_key = ''form-ref-big1''), ''Never paid out'')', q1)) = '');
  v := pg_temp.j(format('select public.payment_reverse(%L, ''Bank charge-back'', ''rev-full-0001'')', x));
  perform pg_temp.res('28a ... and both milestones the payment had covered are Due again',
    (v ->> 'milestones_reopened')::int = 2 and (select count(*) from public.payment_milestones where quote_id = q1 and status = 'paid') = 0, v::text);
  perform pg_temp.su();
  perform pg_temp.res('28b after the charge-back nothing is paid on the event', public.helm_total_paid(q1, null, null) = 0);
end $$;
-- a closed event: only an admin may reverse
select pg_temp.login('a_admin@a.test');
do $$ declare q1 uuid := 'a0000000-0000-4000-8000-00000000da01'; v jsonb; begin
  perform pg_temp.j(format('select public.record_settlement_payment(%L, 1000, ''cash'', null, null, null, ''small-q1-0001'')', q1));
  perform pg_temp.su();
  insert into public.event_closure(quote_id, closed_at, org_id) values (q1, now(), 'a0000000-0000-4000-8000-000000000001')
    on conflict (quote_id) do update set closed_at = now();
  perform pg_temp.login('a_staff@a.test');
  perform pg_temp.res('29 closed event: Finance edit without admin may not reverse (42501); void refused (closed - re-open first)',
    pg_temp.try(format('select public.payment_reverse((select id from public.quote_payments where idempotency_key = ''small-q1-0001''), ''Wrong event'')')) like '42501%'
    and pg_temp.try(format('select public.money_void(''cost'', %L, ''wrong entry'')', pg_temp.get('c_keep'))) like '42501%closed%');
  perform pg_temp.login('a_admin@a.test');
  v := pg_temp.j('select public.payment_reverse((select id from public.quote_payments where idempotency_key = ''small-q1-0001''), ''Wrong event'')');
  perform pg_temp.su();
  perform pg_temp.res('30 closed event: the admin may (logged as after close)',
    (v ->> 'reversed')::boolean and exists (select 1 from public.audit_log where action = 'payment_reversed' and (changed ->> 'after_close')::boolean), v::text);
  perform pg_temp.su(); update public.event_closure set closed_at = null where quote_id = q1;
end $$;

-- ---- 4) credit on account -------------------------------------------------------------------------------------------------------
select pg_temp.su();
select pg_temp.put('a_q2_0', pg_temp.answers('a0000000-0000-4000-8000-0000000239a2')::text);
select pg_temp.login('a_admin@a.test');
do $$ declare q2 uuid := 'a0000000-0000-4000-8000-0000000239a2'; v jsonb; v2 jsonb; a0 jsonb := pg_temp.get('a_q2_0')::jsonb; a1 jsonb; begin
  v := pg_temp.j(format('select public.record_payment_with_credit(%L, 128000, ''bank'', null, ''credit-q2-0001'')', q2));
  v2 := pg_temp.j(format('select public.record_payment_with_credit(%L, 128000, ''bank'', null, ''credit-q2-0001'')', q2));
  perform pg_temp.su(); a1 := pg_temp.answers(q2);
  perform pg_temp.put('cr1', v -> 'credit' ->> 'id');
  perform pg_temp.res('31 client pays 1,28,000 on 1,18,000: the receipt is 1,18,000 (the ledger never goes over the invoice), 10,000 is a credit on account',
    (v ->> 'paid')::numeric = 118000 and (v -> 'credit' ->> 'amount')::numeric = 10000 and public.helm_total_paid(q2, null, null) = 118000
    and (select count(*) from public.money_credits where quote_id = q2 and status = 'open' and amount = 10000) = 1, v::text);
  perform pg_temp.res('32 the credit is not revenue: P&L revenue, cost and the ledger costs are unchanged',
    a1 -> 'pnl' -> 'revenue' = a0 -> 'pnl' -> 'revenue' and a1 -> 'pnl' -> 'net_profit' = a0 -> 'pnl' -> 'net_profit'
    and a1 -> 'money' -> 'cost_expected' = a0 -> 'money' -> 'cost_expected', a1::text);
  perform pg_temp.res('33 the same form again (answer lost) = the same answer, nothing more written',
    (v2 ->> 'duplicate')::boolean and (select count(*) from public.money_credits where quote_id = q2) = 1
    and (select count(*) from public.quote_payments where quote_id = q2) = 1, v2::text);
end $$;
select pg_temp.login('a_admin@a.test');
do $$ declare q2 uuid := 'a0000000-0000-4000-8000-0000000239a2'; v jsonb; x uuid; begin
  perform pg_temp.res('34 nothing due: applying the credit is refused (22023); a plain payment over the balance is still refused (0110)',
    pg_temp.try(format('select public.money_credit_apply(%L)', pg_temp.get('cr1'))) like '22023%'
    and pg_temp.try(format('select public.record_settlement_payment(%L, 10, ''cash'', null, null, null, ''over-q2-0001'')', q2)) like '23514%');
  insert into public.change_requests(quote_id, title, price_delta, status) values (q2, 'Extra lights', 6000, 'requested') returning id into x;
  update public.change_requests set status = 'approved', decided_at = now() where id = x;
  v := pg_temp.j(format('select public.money_credit_apply(%L)', pg_temp.get('cr1')));
  perform pg_temp.put('cr_rest', v -> 'left' ->> 'id');
  perform pg_temp.su();
  perform pg_temp.res('35 a change order of 6,000: applying the credit records 6,000 (method credit) and keeps 4,000 as a new credit',
    (v ->> 'applied')::numeric = 6000 and (v -> 'left' ->> 'amount')::numeric = 4000 and public.helm_total_paid(q2, null, null) = 124000
    and (select status from public.money_credits where id = pg_temp.get('cr1')::uuid) = 'applied'
    and exists (select 1 from public.quote_payments where quote_id = q2 and method = 'credit' and amount = 6000), v::text);
  perform pg_temp.login('a_admin@a.test');
  perform pg_temp.res('36 apply again = duplicate; the 4,000 left can''t be applied while nothing is due; the credit receipt can''t be reversed',
    (pg_temp.j(format('select public.money_credit_apply(%L)', pg_temp.get('cr1'))) ->> 'duplicate')::boolean
    and pg_temp.try(format('select public.payment_reverse((select id from public.quote_payments where quote_id = %L and method = ''credit''), ''wrong entry'')', q2)) like '22023%credit on account%'
    and pg_temp.try(format('select public.money_credit_apply(%L)', pg_temp.get('cr_rest'))) like '22023%');
end $$;
select pg_temp.login('a_staff@a.test');
do $$ declare l jsonb; begin
  perform pg_temp.res('37 the 4,000 is given back (Finance edit, reason); twice = duplicate; then it can''t be applied',
    (pg_temp.j(format('select public.money_credit_refund(%L, ''Returned by bank transfer'')', pg_temp.get('cr_rest'))) ->> 'refunded')::numeric = 4000
    and (pg_temp.j(format('select public.money_credit_refund(%L, ''Returned by bank transfer'')', pg_temp.get('cr_rest'))) ->> 'duplicate')::boolean
    and pg_temp.try(format('select public.money_credit_apply(%L)', pg_temp.get('cr_rest'))) like '42501%'      -- (no Settlement edit here; refused either way)
    and pg_temp.try(format('select public.money_credit_refund(%L, ''no'')', pg_temp.get('cr1'))) like '22023%');
  l := pg_temp.j('select public.money_credits_list(''a0000000-0000-4000-8000-0000000239a2'')');
  perform pg_temp.res('38 the money page lists 3 credits (applied, refunded, ...), nothing open now; credits can''t be read or written directly',
    jsonb_array_length(l -> 'rows') = 2 and (l ->> 'open_total')::numeric = 0
    and pg_temp.try('select count(*) from public.money_credits') like '42501%'
    and pg_temp.try('update public.money_credits set amount = 1') like '42501%', l::text);
end $$;
do $$ begin
  perform pg_temp.su();
  perform set_config('helm.allow_purge', '', true);
  perform pg_temp.res('39 a credit is kept for good: no delete without the purge mark, no edit of its amount (even by the server)',
    pg_temp.try(format('delete from public.money_credits where id = %L', pg_temp.get('cr1'))) like '42501%'
    and pg_temp.try(format('update public.money_credits set amount = 1 where id = %L', pg_temp.get('cr1'))) like '42501%');
  perform set_config('helm.allow_purge', 'on', true);
end $$;
select pg_temp.login('r239_coord@a.test');
do $$ begin
  perform pg_temp.res('40 no Finance / Settlement: credit list / apply / refund / record refused',
    pg_temp.try('select public.money_credits_list(''a0000000-0000-4000-8000-0000000239a2'')') like '42501%'
    and pg_temp.try(format('select public.money_credit_refund(%L, ''Returned by bank'')', pg_temp.get('cr1'))) like '42501%'
    and pg_temp.try('select public.record_payment_with_credit(''a0000000-0000-4000-8000-0000000239a2'', 5, ''cash'', null, ''credit-coord-01'')') like '42501%');
end $$;

-- ---- 5) Freeze now -----------------------------------------------------------------------------------------------------------
select pg_temp.su();
select pg_temp.put('a_q3_0', pg_temp.answers('a0000000-0000-4000-8000-0000000239a3')::text);
select pg_temp.login('a_staff@a.test');
do $$ begin
  perform pg_temp.res('41 only an admin may freeze (Finance edit alone: 42501)',
    pg_temp.try('select public.event_money_freeze_set(''a0000000-0000-4000-8000-0000000239a3'', true, ''Month-end review'')') like '42501%');
end $$;
select pg_temp.login('a_admin@a.test');
do $$ declare q3 uuid := 'a0000000-0000-4000-8000-0000000239a3'; f jsonb; begin
  perform pg_temp.res('42 a reason of 5 to 300 characters is needed',
    pg_temp.try(format('select public.event_money_freeze_set(%L, true, ''no'')', q3)) like '22023%');
  f := pg_temp.j(format('select public.event_money_freeze_set(%L, true, ''Month-end review by accounts'')', q3));
  perform pg_temp.su();
  perform pg_temp.res('43 frozen: every figure is exactly the same as before the freeze', (f ->> 'frozen')::boolean
    and pg_temp.answers(q3)::text = pg_temp.get('a_q3_0') and pg_temp.rows_hash() is not null, f::text);
end $$;
select pg_temp.login('a_staff@a.test');
do $$ declare q3 uuid := 'a0000000-0000-4000-8000-0000000239a3'; p jsonb; begin
  perform pg_temp.res('44 while frozen, signed-in money changes are refused (cost lines, claims, refunds, milestones, change orders, corrections, the price, void)',
    pg_temp.try(format('insert into public.event_costs(quote_id, category, description, estimated) values (%L, ''Misc'', ''x'', 1)', q3)) like '42501%frozen%'
    and pg_temp.try(format('update public.event_costs set estimated = 1 where id = %L', pg_temp.get('c_q3'))) like '42501%frozen%'
    and pg_temp.try(format('insert into public.expense_claims(quote_id, who, amount) values (%L, ''Ravi'', 10)', q3)) like '42501%frozen%'
    and pg_temp.try(format('insert into public.payment_milestones(quote_id, label, amount, seq) values (%L, ''More'', 10, 5)', q3)) like '42501%frozen%'
    and pg_temp.try(format('insert into public.change_requests(quote_id, title, price_delta, status) values (%L, ''More'', 10, ''requested'')', q3)) like '42501%frozen%'
    and pg_temp.try(format('select public.money_correction_add(%L, ''misc'', 100, ''late taxi bill'')', q3)) like '42501%frozen%'
    and pg_temp.try(format('update public.quotes set pricing = jsonb_set(pricing, ''{total}'', ''60000'') where id = %L', q3)) like '42501%frozen%'
    and pg_temp.try(format('select public.money_void(''cost'', %L, ''wrong entry'')', pg_temp.get('c_q3'))) like '42501%frozen%');
  perform pg_temp.login('a_admin@a.test');
  p := pg_temp.j(format('select public.record_settlement_payment(%L, 1000, ''cash'', null, null, null, ''frz-pay-0001'')', q3));
  perform pg_temp.login('a_staff@a.test');
  perform pg_temp.res('45 while frozen a client payment still goes in and covers its milestone (as after closing); only an admin may reverse it',
    p ->> 'receipt_no' is not null and (select status from public.payment_milestones where id = pg_temp.get('m_q3')::uuid) = 'paid'
    and pg_temp.try(format('select public.payment_reverse((select id from public.quote_payments where idempotency_key = ''frz-pay-0001''), ''Wrong event'')')) like '42501%', p::text);
end $$;
select pg_temp.login('a_admin@a.test');
do $$ declare q3 uuid := 'a0000000-0000-4000-8000-0000000239a3'; f jsonb; begin
  f := pg_temp.j('select public.payment_reverse((select id from public.quote_payments where idempotency_key = ''frz-pay-0001''), ''Wrong event'')');
  perform pg_temp.res('46 the admin may reverse while frozen: the milestone goes back to Due',
    (f ->> 'milestones_reopened')::int = 1 and (select status from public.payment_milestones where id = pg_temp.get('m_q3')::uuid) = 'due', f::text);
  perform pg_temp.res('47 freeze twice / unfreeze without a reason refused (22023)',
    pg_temp.try(format('select public.event_money_freeze_set(%L, true, ''Month-end review again'')', q3)) like '22023%'
    and pg_temp.try(format('select public.event_money_freeze_set(%L, false, '''')', q3)) like '22023%');
  f := pg_temp.j(format('select public.event_money_freeze_set(%L, false, ''Review done, figures agreed'')', q3));
  perform pg_temp.res('48 unfreeze (admin + reason): edits allowed again; both steps logged with who / why',
    not (f ->> 'frozen')::boolean and jsonb_array_length(f -> 'log') = 2 and f -> 'log' -> 0 ->> 'action' = 'unfreeze'
    and f -> 'log' -> 1 ->> 'reason' = 'Month-end review by accounts' and f -> 'log' -> 0 ->> 'by' = 'a_admin@a.test'
    and f -> 'log' -> 0 ->> 'reason' = 'Review done, figures agreed'
    and pg_temp.try(format('update public.event_costs set estimated = 7001 where id = %L', pg_temp.get('c_q3'))) = ''
    and (select count(*) from public.audit_log where action in ('money.frozen', 'money.unfrozen') and quote_id = q3) = 2, f::text);
end $$;
select pg_temp.login('b_admin@b.test');
do $$ begin
  perform pg_temp.res('49 another studio''s admin can''t see or freeze it (42501)',
    pg_temp.try('select public.event_money_freeze_set(''a0000000-0000-4000-8000-0000000239a3'', true, ''Not my studio'')') like '42501%'
    and pg_temp.try('select public.event_money_freeze_get(''a0000000-0000-4000-8000-0000000239a3'')') like '42501%');
end $$;

-- ---- 6) keyed corrections + TDS -----------------------------------------------------------------------------------------------
select pg_temp.login('a_admin@a.test');
do $$ declare q3 uuid := 'a0000000-0000-4000-8000-0000000239a3'; v1 jsonb; v2 jsonb; begin
  v1 := pg_temp.j(format('select public.money_correction_add_once(''corr-q3-0001'', %L, ''misc'', 250, ''Missed taxi bill'')', q3));
  v2 := pg_temp.j(format('select public.money_correction_add_once(''corr-q3-0001'', %L, ''misc'', 250, ''Missed taxi bill'')', q3));
  perform pg_temp.su();
  perform pg_temp.res('50 a cost correction sent twice with one key = one row ("duplicate" the second time)',
    v1 ->> 'err' is null and (v2 ->> 'duplicate')::boolean and (select count(*) from public.money_corrections where quote_id = q3) = 1, v1::text || v2::text);
  perform pg_temp.login('a_admin@a.test');
  perform pg_temp.j('select public.money_settings_set(''{"tds_enabled": true}'')');
  perform pg_temp.j(format('select public.record_settlement_payment(%L, 50000, ''bank'', null, null, null, ''tds-pay-0001'')', q3));
  v1 := pg_temp.j(format('select public.client_tds_record_once(''tds-q3-0001'', %L, 1000, ''194C'')', q3));
  v2 := pg_temp.j(format('select public.client_tds_record_once(''tds-q3-0001'', %L, 1000, ''194C'')', q3));
  perform pg_temp.su();
  perform pg_temp.res('51 client TDS sent twice with one key = one row',
    v1 ->> 'err' is null and (v2 ->> 'duplicate')::boolean and (select count(*) from public.client_tds where quote_id = q3) = 1, v1::text || v2::text);
  perform pg_temp.login('a_admin@a.test');
  perform pg_temp.res('52 a key is 8 to 100 safe characters', pg_temp.try(format('select public.money_correction_add_once(''short'', %L, ''misc'', 1, ''Missed bill'')', q3)) like '22023%'
    and pg_temp.try(format('select public.money_correction_add_once(''bad key with spaces'', %L, ''misc'', 1, ''Missed bill'')', q3)) like '22023%');
end $$;

-- ---- 7) grants, closed tables, purge -------------------------------------------------------------------------------------------
select pg_temp.anon();
do $$ begin
  perform pg_temp.res('53 anon: every 0404 page call refused',
    pg_temp.try('select public.money_void(''cost'', gen_random_uuid(), ''wrong entry'')') like '42501%'
    and pg_temp.try('select public.payment_reverse(gen_random_uuid(), ''wrong entry'')') like '42501%'
    and pg_temp.try('select public.record_payment_with_credit(gen_random_uuid(), 1, ''cash'', null, ''anon-key-0001'')') like '42501%'
    and pg_temp.try('select public.event_money_freeze_set(gen_random_uuid(), true, ''wrong entry'')') like '42501%'
    and pg_temp.try('select public.money_credits_list(gen_random_uuid())') like '42501%');
end $$;
select pg_temp.su();
do $$ begin
  perform pg_temp.res('54 helpers + trigger functions are server only; page calls for signed-in staff; 4 new tables RLS on, no grants',
    not has_function_privilege('authenticated', 'public._r404_reverse(uuid,text,text,uuid)', 'execute')
    and not has_function_privilege('authenticated', 'public._r404_key_put(uuid,text,text,uuid,jsonb)', 'execute')
    and not has_function_privilege('authenticated', 'public._pkg_tg_payment__pre0404()', 'execute')
    and has_function_privilege('authenticated', 'public.money_void(text,uuid,text,text)', 'execute')
    and not has_function_privilege('anon', 'public.money_void(text,uuid,text,text)', 'execute')
    and (select count(*) from pg_class where oid in ('public.money_credits'::regclass, 'public.money_request_keys'::regclass,
           'public.event_money_freezes'::regclass, 'public.event_money_freeze_log'::regclass) and relrowsecurity) = 4
    and not has_table_privilege('authenticated', 'public.money_credits', 'select')
    and not has_table_privilege('authenticated', 'public.event_money_freezes', 'insert'));
  perform pg_temp.res('55 the free-trial purge knows the new tables',
    position('''money_credits''' in pg_get_functiondef('public._tr184_purge_tables()'::regprocedure)) > 0
    and position('''event_money_freeze_log''' in pg_get_functiondef('public._tr184_purge_tables()'::regprocedure)) > 0);
  perform pg_temp.res('56 every definer function of 0404 pins an empty search_path',
    not exists (select 1 from pg_proc p where p.pronamespace = 'public'::regnamespace and p.prosrc like '%r239-money-0404%' and p.prosecdef
                and coalesce(array_to_string(p.proconfig, ','), '') not like '%search_path=""%'));
end $$;

select pg_temp.su();
do $$ declare n int; f int; begin
  select count(*), count(*) filter (where result <> 'PASS') into n, f from _rm;
  raise warning '%', (select string_agg(name || ': ' || result, E'\n' order by name) from _rm where result <> 'PASS');
  raise warning 'R239-MONEY-SAFETY-0404: % (%/%)', case when f = 0 then 'ALL PASS' else f || ' FAILED' end, n - f, n;
end $$;
rollback;
