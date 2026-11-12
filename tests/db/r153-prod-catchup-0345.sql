-- r153-prod-catchup-0345.sql - R153: the prod catch-up 0345 brings a PRODUCTION-shaped database in line with canonical.
-- Proves: (0) on canonical 0345 is a no-op; (1) the prod state from PROD-DIAG-RESULT.md is rebuilt in this throwaway
-- transaction (pricing trigger only under its old name quotes_enforce_pricing_total, no trg_no_overpayment_ms,
-- no zz_work_token_renew, no 0012 approval expiry / code limit functions + triggers, the 3 plan saves without has_area,
-- no return_reservation, no unique inventory name index, no zz_quote_org_match on the 2 WhatsApp proposal tables);
-- (2) 0345 applied TWICE makes every item match canonical, nothing duplicated (exactly one pricing trigger, one
-- trigger per guard function, one kept __pre0345 body each, no privilege on them); (3) behaviour: overpayment
-- refused, approval link end date stamped for a new link only, code limit, area check on the plan saves (a role
-- without quotes / discovery edit is refused, prod body let it through), return_reservation works;
-- (4) skip cases: duplicate active inventory names -> index skipped, rows untouched; an old overpayment body
-- without the 0125 marker -> trigger not added; a guard under another trigger name -> not added again.
-- Local disposable PG only. Fake data only. Rolled back.
\set ON_ERROR_STOP 0
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
-- the state 0345 is about: trigger definitions on the 6 tables, the functions (body without comments, security,
-- settings, privileges), the inventory name index
create or replace function pg_temp.state() returns table(k text, v text) language sql as $$
  select 'trg ' || c.relname || ' ' || t.tgname, pg_get_triggerdef(t.oid)
    from pg_trigger t join pg_class c on c.oid = t.tgrelid
   where not t.tgisinternal and c.relnamespace = 'public'::regnamespace
     and c.relname in ('quotes', 'payment_milestones', 'event_tasks', 'quote_otps', 'wa_proposal_audit', 'wa_proposal_optins')
  union all
  select 'fn ' || p.oid::regprocedure::text,
         md5(regexp_replace(p.prosrc, '--[^\n]*', '', 'g')) || ' sd=' || p.prosecdef || ' cfg=' || coalesce(array_to_string(p.proconfig, ','), '')
         || ' ret=' || p.prorettype::regtype::text || ' acl=' || coalesce(array_to_string(p.proacl, ','), '<default>')
    from pg_proc p where p.pronamespace = 'public'::regnamespace
     and p.proname in ('enforce_no_overpayment_ms', 'tg_work_token_renew', 'tg_approval_token_expiry', 'tg_otp_rate_limit',
                       'set_discovery', 'set_event_plan', 'set_proposal', 'return_reservation', 'tg_quote_org_match', 'enforce_pricing_total')
  union all
  select 'idx ' || i.relname, pg_get_indexdef(i.oid) from pg_class i where i.relname = 'inventory_items_org_name_uidx'
$$;
create or replace function pg_temp.ntrg(p_tab text, p_fn text) returns int language sql as $$
  select count(*)::int from pg_trigger t where t.tgrelid = to_regclass('public.' || p_tab) and not t.tgisinternal
     and t.tgfoid = to_regprocedure('public.' || p_fn || '()')
$$;
create or replace function pg_temp.src(p_sig text) returns text language sql as $$
  select prosrc from pg_proc where oid = to_regprocedure(p_sig)
$$;
create temp table _canon as select * from pg_temp.state();
create temp table _md5c as select p.proname, md5(p.prosrc) m from pg_proc p
 where p.pronamespace = 'public'::regnamespace and p.proname in ('set_discovery', 'set_event_plan', 'set_proposal', 'tg_approval_token_expiry', 'tg_otp_rate_limit');

-- ---- 0) canonical: 0345 changes nothing ---------------------------------------------------------------------------
set client_min_messages = error;
\ir ../../supabase/migrations/0345_r153_prod_catchup.sql
set client_min_messages = warning;
select pg_temp.t('0a canonical: 0345 is a no-op (same triggers / functions / index, no kept copy)',
  not exists ((select * from pg_temp.state()) except (select * from _canon)) and not exists ((select * from _canon) except (select * from pg_temp.state()))
  and not exists (select 1 from pg_proc where proname like '%\_\_pre0345'));

-- ---- 1) rebuild the PRODUCTION state of PROD-DIAG-RESULT.md (throwaway, rolled back) --------------------------------
drop trigger zz_enforce_pricing_total on public.quotes;             -- prod: only quotes_enforce_pricing_total
drop trigger trg_no_overpayment_ms on public.payment_milestones;
drop trigger zz_work_token_renew on public.event_tasks;
drop trigger zz_approval_token_expiry on public.quotes;
drop function public.tg_approval_token_expiry();
drop trigger zz_otp_rate_limit on public.quote_otps;
drop function public.tg_otp_rate_limit();
drop function public.return_reservation(uuid, numeric);
drop index public.inventory_items_org_name_uidx;
drop trigger zz_quote_org_match on public.wa_proposal_audit;
drop trigger zz_quote_org_match on public.wa_proposal_optins;
do $$ declare f text; d text; begin
  foreach f in array array['public.set_discovery(uuid,date,text,text,text,text,numeric,numeric)',
                           'public.set_event_plan(uuid,text,text,text,text,text,text)', 'public.set_proposal(uuid,text,text,jsonb,jsonb,jsonb)'] loop
    d := regexp_replace(pg_get_functiondef(to_regprocedure(f)), '\n[^\n]*has_area[^\n]*', '');
    execute d;
  end loop;
end $$;
select pg_temp.t('1a prod state rebuilt: 1 pricing trigger (old name), the 10 gaps present',
  (select count(*) from pg_trigger where tgrelid = 'public.quotes'::regclass and tgfoid = 'public.enforce_pricing_total()'::regprocedure) = 1
  and exists (select 1 from pg_trigger where tgrelid = 'public.quotes'::regclass and tgname = 'quotes_enforce_pricing_total')
  and pg_temp.ntrg('payment_milestones', 'enforce_no_overpayment_ms') = 0 and pg_temp.ntrg('event_tasks', 'tg_work_token_renew') = 0
  and to_regprocedure('public.tg_approval_token_expiry()') is null and to_regprocedure('public.tg_otp_rate_limit()') is null
  and to_regprocedure('public.return_reservation(uuid,numeric)') is null and to_regclass('public.inventory_items_org_name_uidx') is null
  and pg_temp.ntrg('wa_proposal_audit', 'tg_quote_org_match') = 0 and pg_temp.ntrg('wa_proposal_optins', 'tg_quote_org_match') = 0
  and position('has_area' in pg_temp.src('public.set_discovery(uuid,date,text,text,text,text,numeric,numeric)')) = 0
  and position('assert_quote_org' in pg_temp.src('public.set_proposal(uuid,text,text,jsonb,jsonb,jsonb)')) > 0);

-- prod: an approval link issued without the 0012 trigger has no end date
update public.quotes set approval_token_expires_at = null where id = 'b0000000-0000-4000-8000-00000000da01';
-- prod behaviour before 0345: a role with no quotes / discovery edit can still save Discovery
update public.role_access set can_edit = false
 where org_id = 'a0000000-0000-4000-8000-000000000001' and role = 'sales' and area in ('quotes', 'proposal', 'discovery', 'plan');
insert into public.role_access(org_id, role, area, can_view, can_edit) values ('a0000000-0000-4000-8000-000000000001', 'sales', 'finance', true, true)
  on conflict (org_id, role, area) do update set can_view = true, can_edit = true;   -- sales keeps an edit area, so can_edit() is true
select pg_temp.t('1b prod body before 0345: sales without quotes / discovery edit CAN save Discovery (the gap)',
  pg_temp.as_val('a_staff@a.test', $q$select (public.set_discovery('a0000000-0000-4000-8000-00000000da01', null, 'call', null, null, 'r153 prod', null, null)).quote_id::text$q$)
  = 'ok:a0000000-0000-4000-8000-00000000da01');

-- ---- 2) apply 0345 twice ------------------------------------------------------------------------------------------
set client_min_messages = error;
\ir ../../supabase/migrations/0345_r153_prod_catchup.sql
create temp table _after1 as select * from pg_temp.state();
\ir ../../supabase/migrations/0345_r153_prod_catchup.sql
set client_min_messages = warning;

select pg_temp.t('2a every item now matches canonical (only difference: the pricing trigger keeps its prod name)',
  not exists ((select * from pg_temp.state()) except (select * from _canon))
  and (select array_agg(k order by k) from ((select k from _canon) except (select k from pg_temp.state())) d) = array['trg quotes zz_enforce_pricing_total'],
  coalesce((select string_agg(k, ', ') from ((select * from pg_temp.state()) except (select * from _canon)) d), '')
  || ' | missing: ' || coalesce((select string_agg(k, ', ') from ((select * from _canon) except (select * from pg_temp.state())) d), ''));
select pg_temp.t('2b exactly ONE pricing trigger (quotes_enforce_pricing_total), no zz_enforce_pricing_total added',
  (select count(*) from pg_trigger where tgrelid = 'public.quotes'::regclass and tgfoid = 'public.enforce_pricing_total()'::regprocedure) = 1
  and not exists (select 1 from pg_trigger where tgrelid = 'public.quotes'::regclass and tgname = 'zz_enforce_pricing_total'));
select pg_temp.t('2c one trigger per guard, nothing duplicated by the second run',
  pg_temp.ntrg('payment_milestones', 'enforce_no_overpayment_ms') = 1 and pg_temp.ntrg('event_tasks', 'tg_work_token_renew') = 1
  and pg_temp.ntrg('quotes', 'tg_approval_token_expiry') = 1 and pg_temp.ntrg('quote_otps', 'tg_otp_rate_limit') = 1
  and pg_temp.ntrg('wa_proposal_audit', 'tg_quote_org_match') = 1 and pg_temp.ntrg('wa_proposal_optins', 'tg_quote_org_match') = 1
  and (select count(*) from pg_class where relname = 'inventory_items_org_name_uidx') = 1
  and (select count(*) from pg_proc where proname = 'return_reservation') = 1
  and not exists ((select * from pg_temp.state()) except (select * from _after1)) and not exists ((select * from _after1) except (select * from pg_temp.state())));
select pg_temp.t('2d trigger names as canonical',
  exists (select 1 from pg_trigger where tgrelid = 'public.payment_milestones'::regclass and tgname = 'trg_no_overpayment_ms')
  and exists (select 1 from pg_trigger where tgrelid = 'public.event_tasks'::regclass and tgname = 'zz_work_token_renew')
  and exists (select 1 from pg_trigger where tgrelid = 'public.quotes'::regclass and tgname = 'zz_approval_token_expiry')
  and exists (select 1 from pg_trigger where tgrelid = 'public.quote_otps'::regclass and tgname = 'zz_otp_rate_limit')
  and (select count(*) from pg_trigger where tgname = 'zz_quote_org_match' and tgrelid in ('public.wa_proposal_audit'::regclass, 'public.wa_proposal_optins'::regclass)) = 2);
select pg_temp.t('2e the 3 plan saves + 2 0012 functions have the EXACT canonical body (prod checker: present)',
  (select count(*) from pg_proc p join _md5c c on c.proname = p.proname where p.pronamespace = 'public'::regnamespace and md5(p.prosrc) = c.m) = 5);
select pg_temp.t('2f prod bodies kept once as __pre0345, no has_area, no privilege for anyone',
  (select count(*) from pg_proc where proname in ('set_discovery__pre0345', 'set_event_plan__pre0345', 'set_proposal__pre0345')) = 3
  and (select count(*) from pg_proc where proname like '%\_\_pre0345') = 3
  and not exists (select 1 from pg_proc where proname like '%\_\_pre0345' and position('has_area' in prosrc) > 0)
  and not exists (select 1 from pg_proc p, unnest(array['public', 'anon', 'authenticated', 'service_role']) r
                   where p.proname like '%\_\_pre0345'
                     and (case when r = 'public' then exists (select 1 from aclexplode(p.proacl) a where a.grantee = 0)
                               else has_function_privilege(r, p.oid, 'execute') end))
  and not has_function_privilege('authenticated', 'public._r345_keep(text)', 'execute'));
select pg_temp.t('2g plan saves + return_reservation: authenticated may call, anon may not',
  has_function_privilege('authenticated', 'public.set_discovery(uuid,date,text,text,text,text,numeric,numeric)', 'execute')
  and not has_function_privilege('anon', 'public.set_event_plan(uuid,text,text,text,text,text,text)', 'execute')
  and has_function_privilege('authenticated', 'public.return_reservation(uuid,numeric)', 'execute')
  and not has_function_privilege('anon', 'public.return_reservation(uuid,numeric)', 'execute')
  and not has_function_privilege('anon', 'public.tg_otp_rate_limit()', 'execute'));

-- ---- 3) behaviour --------------------------------------------------------------------------------------------------
select pg_temp.t('3a sales without quotes / discovery edit is now refused (42501) on Discovery / Plan / Proposal',
  pg_temp.as_val('a_staff@a.test', $q$select (public.set_discovery('a0000000-0000-4000-8000-00000000da01', null, 'call', null, null, 'r153', null, null)).quote_id::text$q$) like '42501%'
  and pg_temp.as_val('a_staff@a.test', $q$select (public.set_event_plan('a0000000-0000-4000-8000-00000000da01', 'Hall', null, null, null, null, null)).quote_id::text$q$) like '42501%'
  and pg_temp.as_val('a_staff@a.test', $q$select (public.set_proposal('a0000000-0000-4000-8000-00000000da01', 'c', 't', null, null, null)).quote_id::text$q$) like '42501%');
insert into public.role_access(org_id, role, area, can_view, can_edit) values ('a0000000-0000-4000-8000-000000000001', 'sales', 'discovery', true, true)
  on conflict (org_id, role, area) do update set can_view = true, can_edit = true;
select pg_temp.t('3b ... and allowed again once the role gets Discovery edit; the admin always can',
  pg_temp.as_val('a_staff@a.test', $q$select (public.set_discovery('a0000000-0000-4000-8000-00000000da01', null, 'call', null, null, 'r153 ok', null, null)).notes$q$) = 'ok:r153 ok'
  and pg_temp.as_val('a_admin@a.test', $q$select (public.set_event_plan('a0000000-0000-4000-8000-00000000da01', 'Hall R153', null, null, null, null, null)).venue_name$q$) = 'ok:Hall R153');

do $$ declare e text := 'none'; begin
  begin
    insert into public.payment_milestones(quote_id, org_id, label, amount, status)
      values ('a0000000-0000-4000-8000-00000000da01', 'a0000000-0000-4000-8000-000000000001', 'r153 too much', 999999999, 'paid');
  exception when others then e := sqlstate; end;
  perform pg_temp.t('3c overpayment guard on: a paid milestone above the invoice total is refused (23514)', e = '23514', e);
end $$;

update public.quotes set title = 'Wedding B r153' where id = 'b0000000-0000-4000-8000-00000000da01';
update public.quotes set approval_token = 'a0000000-0000-4000-8000-0000000153aa', approval_token_expires_at = null where id = 'a0000000-0000-4000-8000-00000000da01';
select pg_temp.t('3d approval link: an existing link keeps its (empty) end date, a new link gets about 30 days',
  (select approval_token_expires_at is null from public.quotes where id = 'b0000000-0000-4000-8000-00000000da01')
  and (select approval_token_expires_at between now() + interval '29 days' and now() + interval '400 days' from public.quotes where id = 'a0000000-0000-4000-8000-00000000da01'));

do $$ declare e text := 'none'; i int; begin
  for i in 1..3 loop
    insert into public.quote_otps(quote_id, phone, code_hash, expires_at)
      values ('a0000000-0000-4000-8000-00000000da01', '+91 98000 15301', 'x', now() + interval '10 minutes');
  end loop;
  begin
    insert into public.quote_otps(quote_id, phone, code_hash, expires_at)
      values ('a0000000-0000-4000-8000-00000000da01', '+919800015301', 'x', now() + interval '10 minutes');
  exception when others then e := sqlstate; end;
  perform pg_temp.t('3e code limit on: the 4th code to one number within an hour is refused', e = 'P0001', e);
end $$;

insert into public.inventory_items(id, org_id, name, total_qty) values ('a0000000-0000-4000-8000-0000000153b1', 'a0000000-0000-4000-8000-000000000001', 'R153 Chairs', 10);
insert into public.inventory_reservations(id, org_id, item_id, quote_id, qty, status)
  values ('a0000000-0000-4000-8000-0000000153b2', 'a0000000-0000-4000-8000-000000000001', 'a0000000-0000-4000-8000-0000000153b1', 'a0000000-0000-4000-8000-00000000da01', 3, 'reserved');
create temp table _ret as select pg_temp.as_val('a_admin@a.test', $q$select (public.return_reservation('a0000000-0000-4000-8000-0000000153b2', 2)).status$q$) r1;
select pg_temp.t('3f return_reservation: returned + 2 damaged written off in one step; a second return is refused',
  (select r1 from _ret) = 'ok:returned'
  and (select total_qty from public.inventory_items where id = 'a0000000-0000-4000-8000-0000000153b1') = 8
  and pg_temp.as_val('a_admin@a.test', $q$select (public.return_reservation('a0000000-0000-4000-8000-0000000153b2', 0)).status$q$) like '22023%',
  (select r1 from _ret) || ' / ' || (select total_qty::text from public.inventory_items where id = 'a0000000-0000-4000-8000-0000000153b1'));

select pg_temp.t('3g unique active name per studio now enforced',
  pg_temp.as_val(null, $q$insert into public.inventory_items(org_id, name, total_qty) values ('a0000000-0000-4000-8000-000000000001', ' r153 chairs ', 1) returning id::text$q$) like '23505%');

-- ---- 4) skip cases ---------------------------------------------------------------------------------------------------
-- 4a duplicate active inventory names: the index is skipped and no row is touched
drop index public.inventory_items_org_name_uidx;
insert into public.inventory_items(org_id, name, total_qty) values ('a0000000-0000-4000-8000-000000000001', ' r153 CHAIRS', 4);
create temp table _inv as select md5(string_agg(t::text, ',' order by id)) h, count(*) c from public.inventory_items t;
set client_min_messages = error;
\ir ../../supabase/migrations/0345_r153_prod_catchup.sql
\ir ../../supabase/migrations/0345_r153_prod_catchup.sql
set client_min_messages = warning;
select pg_temp.t('4a duplicate active names: index skipped, inventory rows untouched (twice)',
  to_regclass('public.inventory_items_org_name_uidx') is null
  and (select h from _inv) = (select md5(string_agg(t::text, ',' order by id)) from public.inventory_items t)
  and (select c from _inv) = (select count(*) from public.inventory_items));

-- 4b an overpayment body without the 0125 marker (it would count a payment twice): trigger NOT added
savepoint s4b;
drop trigger trg_no_overpayment_ms on public.payment_milestones;
do $$ begin execute replace(pg_get_functiondef('public.enforce_no_overpayment_ms()'::regprocedure), 'helm-0125-ms-no-double-count', 'older body'); end $$;
set client_min_messages = error;
\ir ../../supabase/migrations/0345_r153_prod_catchup.sql
set client_min_messages = warning;
select pg_temp.t('4b old overpayment body: trigger not added', pg_temp.ntrg('payment_milestones', 'enforce_no_overpayment_ms') = 0);
rollback to savepoint s4b;

-- 4c guards that exist under ANOTHER trigger name are not added again
alter trigger trg_no_overpayment_ms on public.payment_milestones rename to prod_overpay_guard;
alter trigger zz_otp_rate_limit on public.quote_otps rename to prod_otp_limit;
alter trigger zz_quote_org_match on public.wa_proposal_audit rename to prod_wa_org;
set client_min_messages = error;
\ir ../../supabase/migrations/0345_r153_prod_catchup.sql
set client_min_messages = warning;
select pg_temp.t('4c a guard under another name is not duplicated',
  pg_temp.ntrg('payment_milestones', 'enforce_no_overpayment_ms') = 1 and pg_temp.ntrg('quote_otps', 'tg_otp_rate_limit') = 1
  and pg_temp.ntrg('wa_proposal_audit', 'tg_quote_org_match') = 1
  and not exists (select 1 from pg_trigger where tgname in ('trg_no_overpayment_ms', 'zz_otp_rate_limit') and tgrelid in ('public.payment_milestones'::regclass, 'public.quote_otps'::regclass)));

do $$ declare n int; f int; r record; begin
  select count(*), count(*) filter (where result <> 'PASS') into n, f from _rs;
  for r in select * from _rs where result <> 'PASS' loop raise warning '% -> %', r.name, r.result; end loop;
  if f = 0 then raise warning 'R153-PROD-CATCHUP-0345: ALL PASS (%/%)', n, n;
  else raise warning 'R153-PROD-CATCHUP-0345: % FAILED of %', f, n; end if;
end $$;
rollback;
