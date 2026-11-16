-- r177-plain-dash-0367.sql - R177: three functions re-issued with plain dashes where a long dash was garbled on paste.
-- Proves: (1) a database whose bodies hold the garbled dash (the prod / staging state found 16 Nov) gets the known logic
-- back with plain dashes and the r177-0367 marker; (2) same answers: Indian and +country mobile numbers, the refund
-- pending rule text, the QC guard still runs as the caller; (3) the garbled body is kept once as NAME__pre0367 with no app
-- privilege (zero loss); (4) a body that is not the known one is left unchanged; (5) re-run safe.
-- Re-applies 0367. Local disposable PG only. Fake data only. Rolled back.
\set ON_ERROR_STOP 0
set client_min_messages = error;
\ir ../../supabase/migrations/0367_r177_plain_dash_reissue.sql
set client_min_messages = warning;
begin;
create temp table _rs(name text, result text);
create or replace function pg_temp.t(p_name text, p_ok boolean, p_detail text default '') returns void language plpgsql as $$
begin insert into _rs values (p_name, case when coalesce(p_ok, false) then 'PASS' else 'FAIL: ' || coalesce(p_detail, '') end); end $$;
create or replace function pg_temp.err(p_sql text) returns text language plpgsql as $$
begin execute p_sql; return 'no error'; exception when others then return sqlerrm; end $$;

-- ---- 0) put the database in the garbled state: the canonical bodies with each long dash replaced by its mis-decoded bytes ----
do $$ declare r record; v_def text; begin
  for r in select * from (values ('tg_refund_maker_checker', ''), ('tg_guard_task_verify', ''), ('_mp_mobile', 'text, text')) v(fn, args) loop
    execute format('drop function if exists public.%I(%s)', r.fn || '__pre0367', r.args);
  end loop;
end $$;
-- the 0367 bodies with the dash put back garbled and the marker removed = what prod holds (rescore markers kept)
do $$ declare r record; v_def text; v_bad_em text := chr(226) || chr(8364) || chr(8221); begin
  for r in select * from (values ('public.tg_refund_maker_checker()'), ('public.tg_guard_task_verify()'), ('public._mp_mobile(text,text)')) v(sig) loop
    v_def := pg_get_functiondef(to_regprocedure(r.sig));
    v_def := regexp_replace(v_def, '\n-- r177-0367[^\n]*', '');
    v_def := replace(v_def, 'pending - approve', 'pending ' || v_bad_em || ' approve');
    v_def := replace(v_def, '7-15 digits', '7' || v_bad_em || '15 digits');
    v_def := replace(v_def, 'SECURITY INVOKER - current_user', 'SECURITY INVOKER ' || v_bad_em || ' current_user');
    execute v_def;
  end loop;
end $$;
select pg_temp.t('0a setup: garbled dashes present, no 0367 marker',
  (select bool_and(position(chr(226) || chr(8364) in p.prosrc) > 0 and position('r177-0367' in p.prosrc) = 0) from pg_proc p
    where p.oid in (to_regprocedure('public.tg_refund_maker_checker()'), to_regprocedure('public.tg_guard_task_verify()'), to_regprocedure('public._mp_mobile(text,text)'))));

-- ---- 1) run 0367 on the garbled state ----
set client_min_messages = error;
\ir ../../supabase/migrations/0367_r177_plain_dash_reissue.sql
set client_min_messages = warning;
select pg_temp.t('1a all three re-issued with the marker and no garbled dash',
  (select bool_and(position('r177-0367' in p.prosrc) > 0 and position(chr(226) || chr(8364) in p.prosrc) = 0) from pg_proc p
    where p.oid in (to_regprocedure('public.tg_refund_maker_checker()'), to_regprocedure('public.tg_guard_task_verify()'), to_regprocedure('public._mp_mobile(text,text)'))));
select pg_temp.t('1b body is pure ASCII', (select bool_and(p.prosrc !~ '[^[:ascii:]]') from pg_proc p
    where p.oid in (to_regprocedure('public.tg_refund_maker_checker()'), to_regprocedure('public.tg_guard_task_verify()'), to_regprocedure('public._mp_mobile(text,text)'))));

-- ---- 2) same answers ----
select pg_temp.t('2a Indian mobile normalised', public._mp_mobile('98765 43210', 'Mobile') = '+919876543210');
select pg_temp.t('2b Indian with 0 prefix', public._mp_mobile('098765 43210', 'Mobile') = '+919876543210');
select pg_temp.t('2c +country mobile kept', public._mp_mobile('+44 7700 900123', 'Mobile') = '+447700900123');
select pg_temp.t('2d empty is null', public._mp_mobile('  ', 'Mobile') is null);
select pg_temp.t('2e short +country refused with a plain dash', pg_temp.err($q$select public._mp_mobile('+44 123', 'Mobile')$q$) = 'Mobile must be 7-15 digits including the country code.',
  pg_temp.err($q$select public._mp_mobile('+44 123', 'Mobile')$q$));
select pg_temp.t('2f bad Indian refused', pg_temp.err($q$select public._mp_mobile('12345 67890', 'Mobile')$q$) like 'Mobile must be a 10-digit Indian mobile number%');
select pg_temp.t('2g refund rule text: pending - approve', (select position('A new refund starts as pending - approve it as a separate step.' in p.prosrc) > 0
  and position('Someone else must approve a refund you entered.' in p.prosrc) > 0 from pg_proc p where p.oid = to_regprocedure('public.tg_refund_maker_checker()')));
select pg_temp.t('2h QC guard still runs as the caller', (select not p.prosecdef from pg_proc p where p.oid = to_regprocedure('public.tg_guard_task_verify()')));
select pg_temp.t('2i triggers still call the same functions',
  exists (select 1 from pg_trigger where tgname = 'ab_refund_maker_checker' and tgfoid = to_regprocedure('public.tg_refund_maker_checker()'))
  and exists (select 1 from pg_trigger where tgname = 'zz_guard_task_verify' and tgfoid = to_regprocedure('public.tg_guard_task_verify()')));

-- ---- 3) zero loss: the garbled body kept once, callable by nobody ----
select pg_temp.t('3a kept copies hold the garbled body', (select count(*) = 3 and bool_and(position(chr(226) || chr(8364) in p.prosrc) > 0) from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname in ('tg_refund_maker_checker__pre0367', 'tg_guard_task_verify__pre0367', '_mp_mobile__pre0367')));
select pg_temp.t('3b kept copies: no app privilege',
  not has_function_privilege('authenticated', 'public._mp_mobile__pre0367(text,text)', 'execute')
  and not has_function_privilege('anon', 'public._mp_mobile__pre0367(text,text)', 'execute')
  and not has_function_privilege('authenticated', 'public.tg_refund_maker_checker__pre0367()', 'execute')
  and not has_function_privilege('authenticated', 'public._r367_keep(text)', 'execute'));

-- ---- 4) re-run: no change ----
create temp table _before as select p.proname, md5(p.prosrc) h from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and (p.proname like '%pre0367' or p.proname in ('tg_refund_maker_checker', 'tg_guard_task_verify', '_mp_mobile'));
set client_min_messages = error;
\ir ../../supabase/migrations/0367_r177_plain_dash_reissue.sql
set client_min_messages = warning;
select pg_temp.t('4a second run changes nothing', (select count(*) = 6 from _before b join pg_proc p on p.proname = b.proname
  join pg_namespace n on n.oid = p.pronamespace and n.nspname = 'public' where md5(p.prosrc) = b.h));

-- ---- 5) a body that is not the known one is left alone ----
create or replace function public.tg_refund_maker_checker() returns trigger language plpgsql set search_path = '' as $$
begin
  -- a local variant without the rescore2 marker
  return new;
end $$;
drop function if exists public.tg_refund_maker_checker__pre0367();
set client_min_messages = error;
\ir ../../supabase/migrations/0367_r177_plain_dash_reissue.sql
set client_min_messages = warning;
select pg_temp.t('5a unknown body left unchanged, nothing kept', (select position('a local variant' in p.prosrc) > 0 from pg_proc p where p.oid = to_regprocedure('public.tg_refund_maker_checker()'))
  and to_regprocedure('public.tg_refund_maker_checker__pre0367()') is null);

do $$ declare n int; f int; r record; begin
  select count(*), count(*) filter (where result <> 'PASS') into n, f from _rs;
  for r in select * from _rs where result <> 'PASS' loop raise warning '% -> %', r.name, r.result; end loop;
  if f = 0 then raise warning 'R177-PLAIN-DASH-0367: ALL PASS (%/%)', n, n;
  else raise warning 'R177-PLAIN-DASH-0367: % FAILED of %', f, n; end if;
end $$;
rollback;
