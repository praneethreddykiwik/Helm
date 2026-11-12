-- r154f-email-probe-0352.sql - R154f: per-network and per-address limits on the two e-mail checks the sign-up / sign-in
-- pages make before anyone is signed in (signup_email_preauthorised, staff_google_only_for). Proves: (1) structure: both
-- live bodies carry the 0352 marker and call _r352_allow, the old bodies are kept once as *__pre0352 with no app
-- privilege, signatures, return types, SECURITY DEFINER, search_path and the anon / signed-in grants unchanged, helpers
-- private; (2) normal asks give exactly the kept body answer (switch on and off, Helm and other domains, as anon too);
-- (3) ask 21 from one network is false for everyone (fail closed), another network is not blocked, ask 21 for one address
-- from many networks is false, other addresses unaffected, no readable address = one shared bucket, addresses kept only as
-- a hash; (4) a counter that cannot be written (read-only transaction) answers false; (5) re-applying 0352 keeps one copy
-- each. Local disposable PG only. Fake data only. Rolled back.
\set ON_ERROR_STOP 0
set client_min_messages = error;
\ir ../../supabase/migrations/0352_r154f_email_probe_limits.sql
\ir ../../supabase/migrations/0352_r154f_email_probe_limits.sql
set client_min_messages = warning;

begin;
create temp table _rs(name text, result text); grant all on _rs to anon, authenticated, service_role;
-- earlier suites in run-all re-apply old lock-down migrations (0032 / 0033 loops) and leave these two closed to anon;
-- put back the canonical 0288 / 0298 grants inside this rolled-back run (a fresh install has them, see CHECK-PROD)
grant execute on function public.signup_email_preauthorised(text), public.staff_google_only_for(text) to anon, authenticated;
create or replace function pg_temp.t(p_name text, p_ok boolean, p_detail text default '') returns void language plpgsql as $$
begin insert into _rs values (p_name, case when coalesce(p_ok, false) then 'PASS' else 'FAIL: ' || coalesce(p_detail, '') end); end $$;
-- run p_sql, answer 'ok:<value>' or '<sqlstate> <message>'
create or replace function pg_temp.try(p_sql text) returns text language plpgsql as $$
declare v text;
begin
  execute p_sql into v;
  return 'ok:' || coalesce(v, '<null>');
exception when others then
  return sqlstate || ' ' || sqlerrm;
end $$;
create or replace function pg_temp.as_anon(p_sql text) returns text language plpgsql as $$
declare v text;
begin
  perform auth.login_anon();
  v := pg_temp.try(p_sql);
  perform auth.logout(); execute 'reset role';
  return v;
end $$;
create or replace function pg_temp.ip(p_ip text) returns void language plpgsql as $$
begin
  perform set_config('request.headers', case when p_ip is null then '' else jsonb_build_object('cf-connecting-ip', p_ip)::text end, true);
end $$;
-- ask p_n times (p_sql gets %s = the loop number), answer the last result
create or replace function pg_temp.hammer(p_sql text, p_n integer) returns text language plpgsql as $$
declare v text;
begin
  for i in 1 .. p_n loop v := pg_temp.try(format(p_sql, i)); end loop;
  return v;
end $$;

-- ---- 1) structure -----------------------------------------------------------------------------------------------
select pg_temp.t('1a both live bodies carry the 0352 marker and call the limiter once',
  (select count(*) from pg_proc p where p.oid in (to_regprocedure('public.signup_email_preauthorised(text)'), to_regprocedure('public.staff_google_only_for(text)'))
     and position('r352-0352' in p.prosrc) > 0 and length(p.prosrc) - length(replace(p.prosrc, '_r352_allow(', '')) = length('_r352_allow(')) = 2);
select pg_temp.t('1b old bodies kept once: the 0298 sign-up check and the 0288 hint',
  (select count(*) from pg_proc where pronamespace = 'public'::regnamespace and proname like '%\_\_pre0352') = 2
  and position('r57-0298' in (select prosrc from pg_proc where oid = to_regprocedure('public.signup_email_preauthorised__pre0352(text)'))) > 0
  and position('r39-staff-google-0288' in (select prosrc from pg_proc where oid = to_regprocedure('public.staff_google_only_for__pre0352(text)'))) > 0);
select pg_temp.t('1c kept copies + helpers: not executable by anon / signed-in (copies not by service_role either)',
  not exists (select 1 from pg_proc p, unnest(array['anon', 'authenticated', 'service_role']) r
               where p.pronamespace = 'public'::regnamespace and p.proname like '%\_\_pre0352' and has_function_privilege(r, p.oid, 'execute'))
  and not exists (select 1 from unnest(array['anon', 'authenticated']) r, unnest(array['public._r352_allow(text,text)', 'public._r352_keep(text)']) f
                   where has_function_privilege(r, f::regprocedure, 'execute')));
select pg_temp.t('1d live functions: same signature + return type, SECURITY DEFINER, search_path, VOLATILE, anon + signed-in can call, no PUBLIC',
  (select count(*) from pg_proc p where p.oid in (to_regprocedure('public.signup_email_preauthorised(text)'), to_regprocedure('public.staff_google_only_for(text)'))
     and p.prosecdef and p.provolatile = 'v'
     and has_function_privilege('anon', p.oid, 'execute') and has_function_privilege('authenticated', p.oid, 'execute')
     and pg_get_function_result(p.oid) = 'boolean'
     and pg_get_function_arguments(p.oid) = pg_get_function_arguments(to_regprocedure('public.' || p.proname || '__pre0352(text)'))
     and p.proconfig = array['search_path=""']
     and not exists (select 1 from aclexplode(p.proacl) a where a.grantee = 0)) = 2);

-- ---- 2) normal asks: the kept answer ---------------------------------------------------------------------------
select pg_temp.ip('198.51.100.41');
select pg_temp.t('2a sign-up check: helm.events true, other domains false, empty false - same as the kept body',
  public.signup_email_preauthorised('r154f-a@helm.events') and public.signup_email_preauthorised__pre0352('r154f-a@helm.events')
  and not public.signup_email_preauthorised('someone@gmail.com') and not public.signup_email_preauthorised('')
  and not public.signup_email_preauthorised(null));
update public.helm_hq_settings set staff_google_only = false where id;
select pg_temp.t('2b Google-only hint with the switch OFF: false for staff and others',
  not public.staff_google_only_for('r154f-b@helm.events') and not public.staff_google_only_for('x@gmail.com'));
update public.helm_hq_settings set staff_google_only = true where id;
select pg_temp.t('2c Google-only hint with the switch ON: true for helm.events, false for others - same as the kept body',
  public.staff_google_only_for('r154f-c@helm.events') = public.staff_google_only_for__pre0352('r154f-c@helm.events')
  and public.staff_google_only_for('r154f-c@helm.events') and not public.staff_google_only_for('x@gmail.com'));
select pg_temp.t('2d anon (the sign-up / sign-in pages) gets the same answers',
  pg_temp.as_anon($q$select public.signup_email_preauthorised('r154f-d@helm.events')::text$q$) = 'ok:true'
  and pg_temp.as_anon($q$select public.staff_google_only_for('r154f-d@helm.events')::text$q$) = 'ok:true'
  and pg_temp.as_anon($q$select public.staff_google_only_for('r154f-d@gmail.com')::text$q$) = 'ok:false');
select pg_temp.t('2e anon cannot call the kept bodies or the limiter directly',
  pg_temp.as_anon($q$select public.signup_email_preauthorised__pre0352('a@helm.events')::text$q$) like '42501%'
  and pg_temp.as_anon($q$select public.staff_google_only_for__pre0352('a@helm.events')::text$q$) like '42501%'
  and pg_temp.as_anon($q$select public._r352_allow('preauth', 'a@helm.events')::text$q$) like '42501%');

-- ---- 3) limits ---------------------------------------------------------------------------------------------------
select pg_temp.ip('203.0.113.51');
select pg_temp.t('3a one network: ask 20 for 20 different staff addresses still answers true (Google-only hint)',
  pg_temp.hammer($q$select public.staff_google_only_for('probe%s@helm.events')::text$q$, 20) = 'ok:true');
select pg_temp.t('3b ask 21 from that network is false (fail closed, the answer the page treats as no)',
  pg_temp.try($q$select public.staff_google_only_for('probe21@helm.events')::text$q$) = 'ok:false'
  and pg_temp.as_anon($q$select public.staff_google_only_for('r154f-c@helm.events')::text$q$) = 'ok:false');
select pg_temp.t('3c the sign-up check has its own counter: still answers from that network',
  public.signup_email_preauthorised('r154f-e@helm.events'));
select pg_temp.ip('203.0.113.52');
select pg_temp.t('3d another network is not blocked',
  public.staff_google_only_for('probe1@helm.events'));

-- one address asked from many networks (distributed probing of one person)
create or replace function pg_temp.spread(p_sql text, p_n integer, p_base integer) returns text language plpgsql as $$
declare v text;
begin
  for i in 1 .. p_n loop perform pg_temp.ip('198.18.' || (p_base + i / 200) || '.' || (i % 200 + 1)); v := pg_temp.try(p_sql); end loop;
  return v;
end $$;
select pg_temp.t('3e one address from 20 networks: still answers (sign-up check)',
  pg_temp.spread($q$select public.signup_email_preauthorised('target@helm.events')::text$q$, 20, 1) = 'ok:true');
select pg_temp.t('3f ask 21 for that address from a fresh network is false',
  pg_temp.spread($q$select public.signup_email_preauthorised('target@helm.events')::text$q$, 1, 50) = 'ok:false'
  and pg_temp.spread($q$select public.signup_email_preauthorised(' TARGET@helm.events ')::text$q$, 1, 60) = 'ok:false');
select pg_temp.t('3g other addresses from fresh networks are unaffected',
  pg_temp.spread($q$select public.signup_email_preauthorised('someone-else@helm.events')::text$q$, 1, 70) = 'ok:true');

select pg_temp.ip(null);
select pg_temp.t('3h no readable address: one shared bucket - 20 answer, 21 is false',
  pg_temp.hammer($q$select public.staff_google_only_for('noip%s@helm.events')::text$q$, 20) = 'ok:true'
  and pg_temp.try($q$select public.staff_google_only_for('noip21@helm.events')::text$q$) = 'ok:false');
select pg_temp.t('3i counters keep only hashes - no address and no network in auth_rate_hits',
  exists (select 1 from public.auth_rate_hits where bucket like 'r352\_%')
  and not exists (select 1 from public.auth_rate_hits where bucket like 'r352\_%' and (key like '%@%' or key like '%.%' or key !~ '^[0-9a-f]{64}$')));
select pg_temp.t('3j buckets: one per kind and per network / address (no row per ask)',
  (select count(*) from public.auth_rate_hits where bucket = 'r352_staff_google.ip') = 4
  and (select max(n) from public.auth_rate_hits where bucket like 'r352\_%') <= 25);

-- ---- 5) re-applying keeps one copy each --------------------------------------------------------------------------
set client_min_messages = error;
\ir ../../supabase/migrations/0352_r154f_email_probe_limits.sql
set client_min_messages = warning;
select pg_temp.t('5a re-apply: one kept copy each, one limiter call each, grants unchanged',
  (select count(*) from pg_proc where pronamespace = 'public'::regnamespace and proname like '%\_\_pre0352') = 2
  and position('r352-0352' in (select prosrc from pg_proc where oid = to_regprocedure('public.signup_email_preauthorised__pre0352(text)'))) = 0
  and position('r352-0352' in (select prosrc from pg_proc where oid = to_regprocedure('public.staff_google_only_for__pre0352(text)'))) = 0
  and (select length(prosrc) - length(replace(prosrc, '_r352_allow(', '')) from pg_proc where oid = to_regprocedure('public.staff_google_only_for(text)')) = length('_r352_allow(')
  and has_function_privilege('anon', 'public.staff_google_only_for(text)', 'execute')
  and has_function_privilege('anon', 'public.signup_email_preauthorised(text)', 'execute')
  and not has_function_privilege('anon', 'public.staff_google_only_for__pre0352(text)', 'execute'));

-- ---- 4) read-only from here on: the counter cannot be written, the answer is false (fail closed)
set transaction read only;
select pg_temp.ip('203.0.113.90');
select pg_temp.t('4a read-only transaction: both checks answer false, no error',
  pg_temp.try($q$select public.signup_email_preauthorised('r154f-f@helm.events')::text$q$) = 'ok:false'
  and pg_temp.try($q$select public.staff_google_only_for('r154f-f@helm.events')::text$q$) = 'ok:false'
  and current_setting('transaction_read_only') = 'on',
  pg_temp.try($q$select public.signup_email_preauthorised('r154f-f@helm.events')::text$q$));

do $$ declare n int; f int; r record; begin
  select count(*), count(*) filter (where result <> 'PASS') into n, f from _rs;
  for r in select * from _rs where result <> 'PASS' loop raise warning '% -> %', r.name, r.result; end loop;
  if f = 0 then raise warning 'R154F-EMAIL-PROBE-0352: ALL PASS (%/%)', n, n;
  else raise warning 'R154F-EMAIL-PROBE-0352: % FAILED of %', f, n; end if;
end $$;
rollback;
