-- r139-token-limits-0341.sql - R139: per-network limits on the public link lookups (approval link, client portal,
-- invitation). Proves: (1) structure: the three live bodies carry the 0341 marker, the old bodies are kept once as
-- *__pre0341 with no app privilege (anon / authenticated / service_role), signatures, return types, SECURITY DEFINER,
-- search_path and the app grants unchanged, the crew task link + crew check-in untouched (already limited by 0154),
-- _tl173_trial_locked no longer callable by anon (signed-in still can); (2) normal calls return exactly what the kept
-- body returns; (3) each limit fires on call N+1 from one network with a clean 22023 sentence (hint rate_limited) that
-- the pages show as "try again", another network and a caller with no readable address are not blocked; (4) inside a
-- read-only transaction (PostgREST runs STABLE callers that way) the lookups still answer; (5) re-applying 0341 keeps
-- one copy each. Local disposable PG only. Fake data only. Rolled back.
\set ON_ERROR_STOP 0
set client_min_messages = error;
\ir ../../supabase/migrations/0341_r139_token_lookup_limits.sql
\ir ../../supabase/migrations/0341_r139_token_lookup_limits.sql
set client_min_messages = warning;

begin;
create temp table _rs(name text, result text); grant all on _rs to anon, authenticated, service_role;
create or replace function pg_temp.t(p_name text, p_ok boolean, p_detail text default '') returns void language plpgsql as $$
begin insert into _rs values (p_name, case when coalesce(p_ok, false) then 'PASS' else 'FAIL: ' || coalesce(p_detail, '') end); end $$;
-- run p_sql, answer 'ok:<value>' or '<sqlstate> <hint> <message>'
create or replace function pg_temp.try(p_sql text) returns text language plpgsql as $$
declare v text; h text;
begin
  execute p_sql into v;
  return 'ok:' || coalesce(v, '<null>');
exception when others then
  get stacked diagnostics h = pg_exception_hint;
  return sqlstate || ' ' || coalesce(nullif(h, ''), '-') || ' ' || sqlerrm;
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
-- call p_sql p_n times from the current network, answer the last result
create or replace function pg_temp.hammer(p_sql text, p_n integer) returns text language plpgsql as $$
declare v text;
begin
  for i in 1 .. p_n loop v := pg_temp.try(p_sql); end loop;
  return v;
end $$;

-- ---- fixtures: quote A with a known approval link (earlier suites rotate it), a crew link + a published invitation --
update public.quotes set approval_token = 'a0000000-0000-4000-8000-0000000000aa', approval_status = 'sent', status = 'quote', deleted_at = null
 where id = 'a0000000-0000-4000-8000-00000000da01';
insert into public.crew_members(id, name, phone, org_id, active) values
  ('a0000000-0000-4000-8000-0000013900c1', 'Crew R139', '+91 90000 13901', 'a0000000-0000-4000-8000-000000000001', true)
  on conflict (id) do nothing;
insert into public.work_tokens(token, quote_id, phone, name, org_id) values
  ('a0000000-0000-4000-8000-0000013900d1', 'a0000000-0000-4000-8000-00000000da01', '+919000013901', 'Crew R139', 'a0000000-0000-4000-8000-000000000001')
  on conflict do nothing;
insert into public.event_tasks(quote_id, org_id, category, title, status, assignee_phone, seq)
  select 'a0000000-0000-4000-8000-00000000da01', 'a0000000-0000-4000-8000-000000000001', 'Decor', 'R139 stage', 'assigned', '+919000013901', 1
   where to_regclass('public.event_tasks') is not null;
select set_config('request.jwt.claims', jsonb_build_object('sub', (select id from auth.users where email = 'a_admin@a.test'), 'role', 'authenticated')::text, true);
insert into public.event_sites(org_id, quote_id, slug, status, data)
  values ('a0000000-0000-4000-8000-000000000001', 'a0000000-0000-4000-8000-00000000da01', 'r139-site', 'draft', '{}');
update public.event_sites set status = 'published', published_at = now() where slug = 'r139-site';
select set_config('request.jwt.claims', '', true);

-- ---- 1) structure -----------------------------------------------------------------------------------------------
select pg_temp.t('1a the three live bodies carry the 0341 marker and call the limiter',
  (select count(*) from pg_proc p where p.oid in (to_regprocedure('public.public_get_quote(uuid)'), to_regprocedure('public.public_get_portal(uuid)'),
       to_regprocedure('public.public_event_site(text)'))
     and position('r341-0341' in p.prosrc) > 0 and position('_r341_limit(' in p.prosrc) > 0) = 3);
select pg_temp.t('1b old bodies kept once (the 0334 trial-gate bodies), one copy each',
  (select count(*) from pg_proc where pronamespace = 'public'::regnamespace and proname like '%\_\_pre0341') = 3
  and position('r125-0334' in (select prosrc from pg_proc where oid = to_regprocedure('public.public_get_quote__pre0341(uuid)'))) > 0
  and position('r125-0334' in (select prosrc from pg_proc where oid = to_regprocedure('public.public_get_portal__pre0341(uuid)'))) > 0
  and position('r125-0334' in (select prosrc from pg_proc where oid = to_regprocedure('public.public_event_site__pre0341(text)'))) > 0
  and (select prosrc from pg_proc where oid = to_regprocedure('public.public_get_quote__pre0341(uuid)')) like '%public_get_quote__pre0334(%');
select pg_temp.t('1b2 crew task link + crew check-in untouched, still limited by _work_token_live (0154: 120 a minute per link, 600 per address)',
  position('r341-0341' in (select prosrc from pg_proc where oid = to_regprocedure('public.worker_get_tasks(uuid)'))) = 0
  and position('r341-0341' in (select prosrc from pg_proc where oid = to_regprocedure('public.crew_check(uuid,text,numeric,numeric,numeric)'))) = 0
  and to_regprocedure('public.worker_get_tasks__pre0341(uuid)') is null
  and position('_work_token_live(p_token)' in (select prosrc from pg_proc where oid = to_regprocedure('public.worker_get_tasks(uuid)'))) > 0
  and position('_work_token_live(p_token)' in (select prosrc from pg_proc where oid = to_regprocedure('public.crew_check(uuid,text,numeric,numeric,numeric)'))) > 0
  and exists (select 1 from pg_proc where pronamespace = 'public'::regnamespace and proname like '\_work\_token\_live%'
                 and position('_a154_hit(''ip:''' in prosrc) > 0));
select pg_temp.t('1c kept copies + helpers: not executable by anon / authenticated (copies not by service_role either)',
  not exists (select 1 from pg_proc p, unnest(array['anon', 'authenticated', 'service_role']) r
               where p.pronamespace = 'public'::regnamespace and p.proname like '%\_\_pre0341' and has_function_privilege(r, p.oid, 'execute'))
  and not exists (select 1 from unnest(array['anon', 'authenticated']) r, unnest(array['public._r341_limit(text,integer,integer)', 'public._r341_keep(text)']) f
                   where has_function_privilege(r, f::regprocedure, 'execute')));
select pg_temp.t('1d live functions: same signature + return type, SECURITY DEFINER, search_path, anon + signed-in + service role can call',
  (select count(*) from pg_proc p where p.oid in (to_regprocedure('public.public_get_quote(uuid)'), to_regprocedure('public.public_get_portal(uuid)'),
       to_regprocedure('public.public_event_site(text)'))
     and p.prosecdef and p.provolatile = 'v'
     and has_function_privilege('anon', p.oid, 'execute') and has_function_privilege('authenticated', p.oid, 'execute')
     and has_function_privilege('service_role', p.oid, 'execute')
     and pg_get_function_result(p.oid) = pg_get_function_result(to_regprocedure('public.' || p.proname || '__pre0341(' || oidvectortypes(p.proargtypes) || ')'))
     and pg_get_function_arguments(p.oid) = pg_get_function_arguments(to_regprocedure('public.' || p.proname || '__pre0341(' || oidvectortypes(p.proargtypes) || ')'))
     and p.proconfig = (select q.proconfig from pg_proc q where q.oid = to_regprocedure('public.' || p.proname || '__pre0341(' || oidvectortypes(p.proargtypes) || ')'))) = 3);
select pg_temp.t('1e no PUBLIC execute on the live functions (grants exactly as before)',
  not exists (select 1 from pg_proc p, aclexplode(p.proacl) a where p.oid in (to_regprocedure('public.public_get_quote(uuid)'), to_regprocedure('public.public_get_portal(uuid)'),
       to_regprocedure('public.public_event_site(text)')) and a.grantee = 0));
select pg_temp.t('1f _tl173_trial_locked: anon can no longer call it, signed-in + service role still can',
  not has_function_privilege('anon', 'public._tl173_trial_locked(uuid)', 'execute')
  and has_function_privilege('authenticated', 'public._tl173_trial_locked(uuid)', 'execute')
  and has_function_privilege('service_role', 'public._tl173_trial_locked(uuid)', 'execute'));
select pg_temp.t('1g anon calling _tl173_trial_locked directly: permission denied',
  pg_temp.as_anon($q$select public._tl173_trial_locked('a0000000-0000-4000-8000-000000000001')::text$q$) like '42501%');

-- ---- 2) normal calls return the same data -----------------------------------------------------------------------
select pg_temp.ip('198.51.100.10');
select pg_temp.t('2a approval link: same answer as the kept body',
  public.public_get_quote('a0000000-0000-4000-8000-0000000000aa') = public.public_get_quote__pre0341('a0000000-0000-4000-8000-0000000000aa')
  and public.public_get_quote('a0000000-0000-4000-8000-0000000000aa') ->> 'code' = 'A-0001',
  coalesce(public.public_get_quote('a0000000-0000-4000-8000-0000000000aa')::text, '<null>'));
select pg_temp.t('2b client portal: same answer as the kept body',
  public.public_get_portal('a0000000-0000-4000-8000-0000000000aa') = public.public_get_portal__pre0341('a0000000-0000-4000-8000-0000000000aa')
  and public.public_get_portal('a0000000-0000-4000-8000-0000000000aa') is not null);
select pg_temp.t('2c invitation: same row as the kept body',
  (select jsonb_agg(to_jsonb(x)) from public.public_event_site('r139-site') x) = (select jsonb_agg(to_jsonb(x)) from public.public_event_site__pre0341('r139-site') x)
  and (select count(*) from public.public_event_site('r139-site')) = 1);
select pg_temp.t('2d crew task link answers as before',
  public.worker_get_tasks('a0000000-0000-4000-8000-0000013900d1') #>> '{worker,name}' = 'Crew R139',
  coalesce(public.worker_get_tasks('a0000000-0000-4000-8000-0000013900d1')::text, '<null>'));
select pg_temp.t('2f anon opens the approval link, the portal, the invitation and the crew link',
  pg_temp.as_anon($q$select public.public_get_quote('a0000000-0000-4000-8000-0000000000aa') ->> 'code'$q$) = 'ok:A-0001'
  and pg_temp.as_anon($q$select (public.public_get_portal('a0000000-0000-4000-8000-0000000000aa') is not null)::text$q$) = 'ok:true'
  and pg_temp.as_anon($q$select count(*)::text from public.public_event_site('r139-site')$q$) = 'ok:1'
  and pg_temp.as_anon($q$select public.worker_get_tasks('a0000000-0000-4000-8000-0000013900d1') #>> '{worker,name}'$q$) = 'ok:Crew R139');
select pg_temp.t('2g an unknown approval link still answers as before (not the limit)',
  pg_temp.try($q$select public.public_get_quote('a0000000-0000-4000-8000-00000139beef')::text$q$)
  = pg_temp.try($q$select public.public_get_quote__pre0341('a0000000-0000-4000-8000-00000139beef')::text$q$));

-- ---- 3) the limits fire after N calls from one network ----------------------------------------------------------
-- approval link: 240 per 10 minutes. Counted so far from 198.51.100.10 by section 2: use a fresh network
select pg_temp.ip('203.0.113.11');
select pg_temp.t('3a approval link: call 240 still answers',
  pg_temp.hammer($q$select public.public_get_quote('a0000000-0000-4000-8000-0000000000aa') ->> 'code'$q$, 240) = 'ok:A-0001');
select pg_temp.t('3b approval link: call 241 refused with the clean sentence (22023, hint rate_limited)',
  pg_temp.try($q$select public.public_get_quote('a0000000-0000-4000-8000-0000000000aa') ->> 'code'$q$)
  = '22023 rate_limited Too many requests from your network. Please wait a few minutes and try again.',
  pg_temp.try($q$select public.public_get_quote('a0000000-0000-4000-8000-0000000000aa') ->> 'code'$q$));
select pg_temp.t('3c ... also for anon, also for a random token (scraping)',
  pg_temp.as_anon($q$select public.public_get_quote('a0000000-0000-4000-8000-00000139beef')::text$q$) like '22023 rate_limited Too many requests%');
select pg_temp.t('3d the sentence is not read as a bad / expired / cancelled link by the pages',
  'Too many requests from your network. Please wait a few minutes and try again.' !~* '(invalid link|expired|has been cancelled|not found|no rows|has ended)');
select pg_temp.ip('203.0.113.12');
select pg_temp.t('3e another network is not blocked',
  pg_temp.try($q$select public.public_get_quote('a0000000-0000-4000-8000-0000000000aa') ->> 'code'$q$) = 'ok:A-0001');
select pg_temp.ip(null);
select pg_temp.t('3f no readable address: no counter, still answers',
  pg_temp.hammer($q$select public.public_get_quote('a0000000-0000-4000-8000-0000000000aa') ->> 'code'$q$, 260) = 'ok:A-0001'
  and not exists (select 1 from public.auth_rate_hits where bucket = 'quote_get.ip' and key not in ('198.51.100.10', '203.0.113.11', '203.0.113.12')));

select pg_temp.ip('203.0.113.21');
select pg_temp.t('3g client portal: 240 answer, 241 refused',
  pg_temp.hammer($q$select (public.public_get_portal('a0000000-0000-4000-8000-0000000000aa') is not null)::text$q$, 240) = 'ok:true'
  and pg_temp.try($q$select public.public_get_portal('a0000000-0000-4000-8000-0000000000aa')::text$q$) like '22023 rate_limited Too many requests%');

select pg_temp.ip('203.0.113.31');
select pg_temp.t('3h invitation: 600 answer, 601 refused',
  pg_temp.hammer($q$select count(*)::text from public.public_event_site('r139-site')$q$, 600) = 'ok:1'
  and pg_temp.try($q$select count(*)::text from public.public_event_site('r139-site')$q$) like '22023 rate_limited Too many requests%');

select pg_temp.t('3k one counter row per network per kind (no row per token)',
  (select count(*) from public.auth_rate_hits where bucket in ('quote_get.ip', 'portal_get.ip', 'site_get.ip')
     and key like '203.0.113.%') = 4);

-- ---- 5) re-applying keeps one copy each --------------------------------------------------------------------------
set client_min_messages = error;
\ir ../../supabase/migrations/0341_r139_token_lookup_limits.sql
set client_min_messages = warning;
select pg_temp.t('5a re-apply: one kept copy each, one limiter call each, grants unchanged',
  (select count(*) from pg_proc where pronamespace = 'public'::regnamespace and proname like '%\_\_pre0341') = 3
  and (select length(prosrc) - length(replace(prosrc, '_r341_limit(', '')) from pg_proc where oid = to_regprocedure('public.public_get_quote(uuid)')) = length('_r341_limit(')
  and position('r341-0341' in (select prosrc from pg_proc where oid = to_regprocedure('public.public_get_quote__pre0341(uuid)'))) = 0
  and has_function_privilege('anon', 'public.public_get_quote(uuid)', 'execute')
  and not has_function_privilege('anon', 'public.public_get_quote__pre0341(uuid)', 'execute')
  and not has_function_privilege('anon', 'public._tl173_trial_locked(uuid)', 'execute'));

-- ---- 4) read-only from here on (PostgREST runs STABLE callers that way): the counter cannot be written, the lookups still answer
set transaction read only;
select pg_temp.ip('203.0.113.90');
select pg_temp.t('4a read-only transaction: approval link, portal and invitation still answer (counter skipped)',
  pg_temp.try($q$select public.public_get_quote('a0000000-0000-4000-8000-0000000000aa') ->> 'code'$q$) = 'ok:A-0001'
  and pg_temp.try($q$select (public.public_get_portal('a0000000-0000-4000-8000-0000000000aa') is not null)::text$q$) = 'ok:true'
  and pg_temp.try($q$select count(*)::text from public.public_event_site('r139-site')$q$) = 'ok:1'
  and current_setting('transaction_read_only') = 'on',
  pg_temp.try($q$select public.public_get_quote('a0000000-0000-4000-8000-0000000000aa') ->> 'code'$q$));

do $$ declare n int; f int; r record; begin
  select count(*), count(*) filter (where result <> 'PASS') into n, f from _rs;
  for r in select * from _rs where result <> 'PASS' loop raise warning '% -> %', r.name, r.result; end loop;
  if f = 0 then raise warning 'R139-TOKEN-LIMITS-0341: ALL PASS (%/%)', n, n;
  else raise warning 'R139-TOKEN-LIMITS-0341: % FAILED of %', f, n; end if;
end $$;
rollback;
