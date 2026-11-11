-- r136-audit-via-0340.sql - R136: a lead Helm creates / updates by itself from a saved quote is marked in the audit log.
-- Proves: (1) structure: both functions marked, old bodies kept with no app privilege, triggers + signatures unchanged;
-- (2) a quote save that updates the linked lead -> the LEADS audit row carries _via = quote_sync + _via_quote, the person
-- stays the actor, the QUOTES row carries no marker and keeps old + new client values; (3) a new quote creates its lead ->
-- the lead CREATED row is marked; (4) the marker is gone straight after the sync (a hand edit of the lead right after is
-- NOT marked); (5) the sync still copies budget / guests exactly as 0199; (6) re-applying 0340 changes no audit row and
-- keeps one marker; (7) a direct database change is still tagged helm:maintenance. Local disposable PG only. Fake data
-- only. Rolled back.
\set ON_ERROR_STOP 0
set client_min_messages = error;
\ir ../../supabase/migrations/0340_r136_audit_via.sql
\ir ../../supabase/migrations/0340_r136_audit_via.sql
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
select pg_temp.t('1a both live bodies carry the 0340 marker',
  position('audit-via-0340' in (select prosrc from pg_proc where oid = to_regprocedure('public.sync_quote_to_lead()'))) > 0
  and position('audit-via-0340' in (select prosrc from pg_proc where oid = to_regprocedure('public.tg_audit()'))) > 0);
select pg_temp.t('1b previous bodies kept once, no app privilege',
  to_regprocedure('public.tg_audit__pre0340()') is not null and to_regprocedure('public.sync_quote_to_lead__pre0340()') is not null
  and position('sys-quiet-0164' in (select prosrc from pg_proc where oid = to_regprocedure('public.tg_audit__pre0340()'))) > 0
  and not has_function_privilege('authenticated', 'public.tg_audit__pre0340()', 'execute')
  and not has_function_privilege('anon', 'public.sync_quote_to_lead__pre0340()', 'execute')
  and not has_function_privilege('authenticated', 'public._r340_keep(text)', 'execute'));
select pg_temp.t('1c signatures + triggers unchanged (sync ins/upd on, audit on quotes + leads)',
  (select count(*) from pg_trigger where tgrelid = 'public.quotes'::regclass and tgname in ('quotes_sync_lead_ins', 'quotes_sync_lead_upd') and tgenabled = 'O') = 2
  and (select count(*) from pg_trigger where tgname = 'audit_trg' and tgrelid in ('public.quotes'::regclass, 'public.leads'::regclass)) = 2
  and (select prorettype = 'trigger'::regtype and prosecdef from pg_proc where oid = to_regprocedure('public.tg_audit()'))
  and (select prorettype = 'trigger'::regtype and prosecdef from pg_proc where oid = to_regprocedure('public.sync_quote_to_lead()')));
select pg_temp.t('1d the 0164 secrets redaction is still in tg_audit',
  position('_audit_redact(v_changed, true)' in (select prosrc from pg_proc where oid = to_regprocedure('public.tg_audit()'))) > 0
  and position('helm:maintenance' in (select prosrc from pg_proc where oid = to_regprocedure('public.tg_audit()'))) > 0);

-- ---- 2) quote save -> lead update is marked ---------------------------------------------------------------------
update public.quotes set deleted_at = null, client = '{"name":"Spandhana","budget":"8000000","guests":"100","city":"Hyderabad","phone":"9000013601"}'::jsonb
 where id = 'a0000000-0000-4000-8000-00000000da01';
create temp table _seen as select id from public.audit_log;   -- rows written before the admin's save
select pg_temp.t('2a the admin saves the quote (budget 80 L -> 8 L, guests 150)', pg_temp.as_val('a_admin@a.test',
  $q$update public.quotes set client = client || '{"budget":"800000","guests":"150"}'::jsonb where id = 'a0000000-0000-4000-8000-00000000da01' returning id::text$q$)
  = 'ok:a0000000-0000-4000-8000-00000000da01');
select pg_temp.t('2b the LEADS row is marked quote_sync + the quote id; the admin stays the actor',
  exists (select 1 from public.audit_log a where a.entity = 'leads' and a.action = 'update' and a.id not in (select id from _seen)
            and a.changed ->> '_via' = 'quote_sync' and a.changed ->> '_via_quote' = 'a0000000-0000-4000-8000-00000000da01'
            and a.actor = (select id from auth.users where email = 'a_admin@a.test') and a.actor_email = 'a_admin@a.test'
            and a.changed -> 'budget' = '[8000000, 800000]'::jsonb),
  (select string_agg(entity || ' ' || action || ' ' || coalesce(changed::text, ''), ' | ') from public.audit_log where id not in (select id from _seen)));
select pg_temp.t('2c the QUOTES row carries no marker and keeps old + new client values',
  exists (select 1 from public.audit_log a where a.entity = 'quotes' and a.action = 'update' and a.id not in (select id from _seen)
            and not (a.changed ? '_via') and a.changed -> 'client' -> 0 ->> 'budget' = '8000000' and a.changed -> 'client' -> 1 ->> 'budget' = '800000'));
select pg_temp.t('2d both rows share the same time (one save = one transaction)',
  (select count(distinct at) from public.audit_log where id not in (select id from _seen) and entity in ('quotes', 'leads')) = 1);

-- ---- 4) the marker is gone after the sync ----------------------------------------------------------------------
select pg_temp.t('4a nothing left in the session after the sync',
  coalesce(current_setting('helm.audit_via', true), '') = '' and coalesce(current_setting('helm.audit_via_quote', true), '') = '');
select pg_temp.t('4b a hand edit of the lead right after the save works', pg_temp.as_val('a_admin@a.test',
  $q$update public.leads set notes = 'r136 by hand' where quote_id = 'a0000000-0000-4000-8000-00000000da01' returning id::text$q$) like 'ok:%');
select pg_temp.t('4c ... and its audit row is NOT marked',
  exists (select 1 from public.audit_log a where a.entity = 'leads' and a.id not in (select id from _seen) and a.changed -> 'notes' ->> 1 = 'r136 by hand' and not (a.changed ? '_via')));

-- ---- 5) the 0199 sync itself is unchanged ----------------------------------------------------------------------
select pg_temp.t('5a the lead got the quote budget + guests (0199 behaviour kept)',
  (select budget = 800000 and guest_count = 150 and name = 'Spandhana' from public.leads where quote_id = 'a0000000-0000-4000-8000-00000000da01'));

-- ---- 3) a new quote creates its lead -> marked -----------------------------------------------------------------
-- quotes are created through the app's RPCs (no direct INSERT for the app role): insert as the database owner
-- with the admin's sign-in claims, so auth.uid() is the admin exactly like inside a SECURITY DEFINER RPC
select set_config('request.jwt.claims', jsonb_build_object('sub', (select id from auth.users where email = 'a_admin@a.test')::text, 'role', 'authenticated')::text, true);
insert into public.quotes (id, code, title, status, client, org_id)
  values ('a0000000-0000-4000-8000-0000000a0340', 'R136-0001', 'R136 test', 'quote', '{"name":"Ravi R136","email":"ravi.r136@example.test","guests":"80"}'::jsonb,
          'a0000000-0000-4000-8000-000000000001');
select set_config('request.jwt.claims', '', true);
select pg_temp.t('3a a new quote with a client creates its lead',
  exists (select 1 from public.leads where quote_id = 'a0000000-0000-4000-8000-0000000a0340' and source = 'quote' and name = 'Ravi R136'));
select pg_temp.t('3b the lead CREATED row is marked (source quote, linked quote id)',
  exists (select 1 from public.audit_log a where a.entity = 'leads' and a.action = 'insert' and a.id not in (select id from _seen)
            and a.changed ->> '_via' = 'quote_sync' and a.changed ->> '_via_quote' = 'a0000000-0000-4000-8000-0000000a0340'
            and a.changed ->> 'source' = 'quote' and a.quote_id = 'a0000000-0000-4000-8000-0000000a0340'
            and a.actor = (select id from auth.users where email = 'a_admin@a.test')),
  (select string_agg(entity || ' ' || action || ' ' || coalesce(changed::text, ''), ' | ') from public.audit_log where id not in (select id from _seen) and entity = 'leads'));
select pg_temp.t('3c the quote CREATED row itself is not marked',
  exists (select 1 from public.audit_log a where a.entity = 'quotes' and a.action = 'insert' and a.quote_id = 'a0000000-0000-4000-8000-0000000a0340' and not (a.changed ? '_via')));

-- ---- 7) a direct database change is still tagged -----------------------------------------------------------------
set local helm.maintenance = 'on';
update public.leads set notes = 'r136 maintenance' where quote_id = 'a0000000-0000-4000-8000-00000000da01';
select pg_temp.t('7a direct DB change still helm:maintenance, not marked',
  exists (select 1 from public.audit_log a where a.entity = 'leads' and a.id not in (select id from _seen) and a.actor_email = 'helm:maintenance'
            and a.changed -> 'notes' ->> 1 = 'r136 maintenance' and not (a.changed ? '_via')));
set local helm.maintenance = 'off';

-- ---- 6) re-applying changes no audit row ---------------------------------------------------------------------------
create temp table _before as select md5(string_agg(id::text || coalesce(changed::text, '') || coalesce(actor_email, ''), ',' order by id)) h, count(*) c from public.audit_log;
set client_min_messages = error;
\ir ../../supabase/migrations/0340_r136_audit_via.sql
set client_min_messages = warning;
select pg_temp.t('6a re-apply: no audit row added, changed or removed',
  (select h from _before) = (select md5(string_agg(id::text || coalesce(changed::text, '') || coalesce(actor_email, ''), ',' order by id)) from public.audit_log)
  and (select c from _before) = (select count(*) from public.audit_log));
select pg_temp.t('6b re-apply: one marker each, one kept body each',
  (select count(*) from pg_proc where proname in ('tg_audit__pre0340', 'sync_quote_to_lead__pre0340')) = 2
  and (select (length(prosrc) - length(replace(prosrc, 'set_config(''helm.audit_via'', ''quote_sync''', ''))) from pg_proc where oid = to_regprocedure('public.sync_quote_to_lead()'))
      = length('set_config(''helm.audit_via'', ''quote_sync'''));

do $$ declare n int; f int; r record; begin
  select count(*), count(*) filter (where result <> 'PASS') into n, f from _rs;
  for r in select * from _rs where result <> 'PASS' loop raise warning '% -> %', r.name, r.result; end loop;
  if f = 0 then raise warning 'R136-AUDIT-VIA-0340: ALL PASS (%/%)', n, n;
  else raise warning 'R136-AUDIT-VIA-0340: % FAILED of %', f, n; end if;
end $$;
rollback;
