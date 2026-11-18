-- e-menu-audit-0394.sql - audit E (18 Nov 2026): menu packages (menu_templates) write to the Audit log through the shared
-- tg_audit trigger, like every other price-feeding catalogue list. Proves: (1) structure: one audit_trg, after insert /
-- update / delete, row level, calling tg_audit; the other menu_templates triggers kept; (2) a studio admin adding a menu
-- package -> one 'insert' audit row in THEIR studio with them as actor; (3) a price-per-plate change -> one 'update' row
-- with old -> new price; (4) a save that changes nothing -> no audit row; (5) the other studio sees none of it (audit read
-- policy); (6) re-applying 0394 keeps one trigger and changes no audit row. Local disposable PG only. Fake data only.
-- Rolled back.
\set ON_ERROR_STOP 0
set client_min_messages = error;
\ir ../../supabase/migrations/0394_e_menu_package_audit.sql
\ir ../../supabase/migrations/0394_e_menu_package_audit.sql
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

-- ---- 1) structure -----------------------------------------------------------------------------------------------
select pg_temp.t('1a one audit_trg on menu_templates: after insert/update/delete, row level, tg_audit',
  (select count(*) from pg_trigger t where t.tgrelid = 'public.menu_templates'::regclass and t.tgname = 'audit_trg'
     and t.tgfoid = to_regprocedure('public.tg_audit()') and (t.tgtype & 1) = 1 and (t.tgtype & 2) = 0
     and (t.tgtype & 28) = 28) = 1);
select pg_temp.t('1b the other menu_templates triggers are kept',
  (select count(*) from pg_trigger t where t.tgrelid = 'public.menu_templates'::regclass and not t.tgisinternal
     and t.tgname in ('zz_r3_menu_price_changed', 'zzzzz_r55_no_hard_delete', 'zzz_studio_read_only')) = 3);

-- ---- 2) a studio admin adds a menu package ----------------------------------------------------------------------
create temp table _seen as select id from public.audit_log;
grant select on _seen to authenticated;
create temp table _m(id text); grant all on _m to authenticated;
select pg_temp.t('2a the admin of studio A adds a menu package', (select v from (select pg_temp.as_val('a_admin@a.test',
  $q$with x as (insert into public.menu_templates (org_id, tier, diet, name, price_per_plate, dishes, active, seq)
       values (public.current_org_id(), 'gold', 'veg', 'E0394 Gold Veg', 650, '[{"n":"Paneer tikka","c":"Starters","k":"veg"}]'::jsonb, true, 1) returning id::text)
     insert into _m select id from x returning id$q$) v) s) like 'ok:%',
  'the insert was refused');
select pg_temp.t('2b one insert row in studio A with the admin as actor and the package values',
  (select count(*) from public.audit_log a where a.id not in (select id from _seen) and a.entity = 'menu_templates'
     and a.action = 'insert' and a.entity_id = (select id from _m)
     and a.org_id = 'a0000000-0000-4000-8000-000000000001'
     and a.actor = (select id from auth.users where email = 'a_admin@a.test') and a.actor_email = 'a_admin@a.test'
     and (a.changed ->> 'price_per_plate')::numeric = 650 and a.changed ->> 'name' = 'E0394 Gold Veg') = 1,
  (select string_agg(a.entity || ':' || a.action || ':' || coalesce(a.org_id::text, '-'), ', ') from public.audit_log a where a.id not in (select id from _seen)));

-- ---- 3) the price per plate changes -----------------------------------------------------------------------------
drop table _seen; create temp table _seen as select id from public.audit_log; grant select on _seen to authenticated;
select pg_temp.t('3a the admin changes the price per plate 650 -> 700', pg_temp.as_val('a_admin@a.test',
  format($q$update public.menu_templates set price_per_plate = 700 where id = %L returning price_per_plate::text$q$, (select id from _m)))
  = 'ok:700');
select pg_temp.t('3b one update row: price_per_plate [650, 700], nothing else changed is listed',
  (select count(*) from public.audit_log a where a.id not in (select id from _seen) and a.entity = 'menu_templates'
     and a.action = 'update' and a.entity_id = (select id from _m)
     and (a.changed -> 'price_per_plate' ->> 0)::numeric = 650 and (a.changed -> 'price_per_plate' ->> 1)::numeric = 700
     and a.changed ?| array['name', 'dishes', 'tier'] = false) = 1,
  (select string_agg(a.changed::text, ' | ') from public.audit_log a where a.id not in (select id from _seen)));

-- ---- 4) a save with no change writes nothing --------------------------------------------------------------------
drop table _seen; create temp table _seen as select id from public.audit_log; grant select on _seen to authenticated;
select pg_temp.t('4a a no-change save', pg_temp.as_val('a_admin@a.test',
  format($q$update public.menu_templates set price_per_plate = 700 where id = %L returning id::text$q$, (select id from _m))) like 'ok:%');
select pg_temp.t('4b ... writes no menu_templates audit row',
  not exists (select 1 from public.audit_log a where a.id not in (select id from _seen) and a.entity = 'menu_templates'));

-- ---- 5) studio B cannot see studio A's menu audit rows ----------------------------------------------------------
select pg_temp.t('5a the admin of studio B sees no menu_templates audit row of studio A', pg_temp.as_val('b_admin@b.test',
  format($q$select count(*)::text from public.audit_log where entity = 'menu_templates' and entity_id = %L$q$, (select id from _m))) = 'ok:0');

-- ---- 6) re-apply -------------------------------------------------------------------------------------------------
drop table _seen; create temp table _seen as select id from public.audit_log;
set client_min_messages = error;
drop trigger if exists audit_trg on public.menu_templates;
create trigger audit_trg after insert or delete or update on public.menu_templates for each row execute function public.tg_audit();
set client_min_messages = warning;
select pg_temp.t('6a re-apply: still one trigger, no audit row written',
  (select count(*) from pg_trigger t where t.tgrelid = 'public.menu_templates'::regclass and t.tgname = 'audit_trg') = 1
  and not exists (select 1 from public.audit_log a where a.id not in (select id from _seen)));

do $$ declare n int; f int; r record; begin
  select count(*), count(*) filter (where result <> 'PASS') into n, f from _rs;
  for r in select * from _rs where result <> 'PASS' loop raise warning '% -> %', r.name, r.result; end loop;
  if f = 0 then raise warning 'E-MENU-AUDIT-0394: ALL PASS (%/%)', n, n;
  else raise warning 'E-MENU-AUDIT-0394: % FAILED of %', f, n; end if;
end $$;
rollback;
