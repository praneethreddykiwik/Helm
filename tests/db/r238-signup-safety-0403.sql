-- r238-signup-safety-0403.sql -- R238 (fix plan Phase 2): 18+ confirmation + no e-mail without an ending (0403).
-- Proves: (1) structure - account_age_confirmations has row security, no anon / signed-in privilege (service_role reads),
-- confirm_account_age is definer with an empty search_path, signed-in only; the helpers have no app privilege; one guard
-- trigger on auth.users, invitations and crew_members; (2) confirm_account_age - signed-out refused, the person's own row
-- with server time + the Terms version in force, a second call keeps the first answer, unknown source -> signup, browser
-- name cleaned; (3) the e-mail rule - only "x@gmail" / "x@gmail." / "x@b.c" / "x@" are refused, unusual endings pass;
-- (4) guards - a NEW login / e-mail change / pending e-mail change, a NEW invitation, a NEW staff e-mail without an ending is
-- refused with a plain message (22023, hint email_no_tld); an OLD row with such an address is never blocked: sign-in
-- fields, status, other columns and the same e-mail pass, fixing it passes; (5) re-run safe.
-- Re-applies 0403 twice. Local disposable PG only. Fake data only. Rolled back.
\set ON_ERROR_STOP 0
set client_min_messages = error;
\ir ../../supabase/migrations/0403_r238_signup_safety.sql
\ir ../../supabase/migrations/0403_r238_signup_safety.sql
set client_min_messages = warning;
begin;
create temp table _rs(name text, result text); grant all on _rs to anon, authenticated, service_role;
create or replace function pg_temp.t(p_name text, p_ok boolean, p_detail text default '') returns void language plpgsql as $$
begin insert into _rs values (p_name, case when coalesce(p_ok, false) then 'PASS' else 'FAIL: ' || coalesce(p_detail, '') end); end $$;
grant execute on function pg_temp.t(text, boolean, text) to anon, authenticated, service_role;
create or replace function pg_temp.su() returns void language plpgsql as $$
begin execute 'reset role'; perform set_config('request.jwt.claims', '', false); end $$;
create or replace function pg_temp.as_user(p_email text) returns void language plpgsql as $$
declare u uuid; begin
  perform pg_temp.su(); select id into u from auth.users where email = p_email;
  perform set_config('request.jwt.claims', jsonb_build_object('sub', u, 'role', 'authenticated', 'email', p_email)::text, false);
  perform set_config('role', 'authenticated', false);
end $$;
-- runs a statement, answers 'ok' or '<sqlstate>|<hint>|<message>'
create or replace function pg_temp.try(p_sql text) returns text language plpgsql as $$
declare st text; h text; m text; begin
  execute p_sql; return 'ok';
exception when others then get stacked diagnostics st = returned_sqlstate, h = pg_exception_hint, m = message_text;
  return st || '|' || coalesce(h, '') || '|' || m; end $$;
grant execute on function pg_temp.try(text) to anon, authenticated, service_role;

-- ---- 1) structure ----------------------------------------------------------------------------------------------------
select pg_temp.t('1a account_age_confirmations: row security on, no anon / signed-in privilege, service_role reads',
  (select relrowsecurity from pg_class where oid = 'public.account_age_confirmations'::regclass)
  and not has_table_privilege('anon', 'public.account_age_confirmations', 'select')
  and not has_table_privilege('authenticated', 'public.account_age_confirmations', 'select')
  and not has_table_privilege('authenticated', 'public.account_age_confirmations', 'insert')
  and has_table_privilege('service_role', 'public.account_age_confirmations', 'select')
  and not has_table_privilege('service_role', 'public.account_age_confirmations', 'insert'));
select pg_temp.t('1b confirm_account_age: definer, empty search_path, signed-in only',
  (select prosecdef and proconfig @> array['search_path=""'] from pg_proc where oid = 'public.confirm_account_age(text,text)'::regprocedure)
  and has_function_privilege('authenticated', 'public.confirm_account_age(text,text)', 'execute')
  and not has_function_privilege('anon', 'public.confirm_account_age(text,text)', 'execute'));
select pg_temp.t('1c helpers + trigger function: no app privilege, empty search_path',
  not has_function_privilege('authenticated', 'public._r403_email_has_tld(text)', 'execute')
  and not has_function_privilege('anon', 'public._r403_email_has_tld(text)', 'execute')
  and not has_function_privilege('authenticated', 'public._r403_email_message(text)', 'execute')
  and not has_function_privilege('authenticated', 'public.tg_r403_email_tld_guard()', 'execute')
  and not has_function_privilege('anon', 'public.tg_r403_email_tld_guard()', 'execute')
  and (select bool_and(proconfig @> array['search_path=""']) from pg_proc
         where oid in ('public._r403_email_has_tld(text)'::regprocedure, 'public._r403_email_message(text)'::regprocedure, 'public.tg_r403_email_tld_guard()'::regprocedure)));
select pg_temp.t('1d one guard trigger on auth.users, invitations, crew_members (applied twice)',
  (select count(*) from pg_trigger where tgname = 'a403_email_tld_guard') = 3
  and exists (select 1 from pg_trigger where tgname = 'a403_email_tld_guard' and tgrelid = 'auth.users'::regclass)
  and exists (select 1 from pg_trigger where tgname = 'a403_email_tld_guard' and tgrelid = 'public.invitations'::regclass)
  and exists (select 1 from pg_trigger where tgname = 'a403_email_tld_guard' and tgrelid = 'public.crew_members'::regclass));

-- ---- 2) 18+ confirmation ---------------------------------------------------------------------------------------------
select pg_temp.su();
select set_config('role', 'anon', false);
select pg_temp.t('2a signed out: refused (42501)', pg_temp.try('select public.confirm_account_age(''signup'', null)') like '42501|%');
select pg_temp.as_user('a_admin@a.test');
select pg_temp.t('2b signed in: confirmed true with a time', (select (r ->> 'confirmed')::boolean and (r ->> 'confirmed_at') is not null
  from (select public.confirm_account_age('signup', 'Mozilla/5.0 ' || repeat('x', 300) || ' ' || chr(9731)) r) z));
select pg_temp.t('2c signed in: the table itself stays closed', pg_temp.try('select count(*) from public.account_age_confirmations') like '42501|%');
select pg_temp.su();
select pg_temp.t('2d the row: own id, server time, Terms version in force, source signup, browser name ASCII <= 160',
  (select count(*) = 1 and bool_and(a.user_id = (select id from auth.users where email = 'a_admin@a.test')
      and a.confirmed_at <= now() and a.confirmed_at > now() - interval '1 minute'
      and a.policy_version is not distinct from public._account_terms_version()
      and a.source = 'signup' and char_length(a.user_agent) <= 160 and a.user_agent !~ '[^\x20-\x7e]')
     from public.account_age_confirmations a));
create temp table _first as select confirmed_at, source from public.account_age_confirmations;
select pg_temp.as_user('a_admin@a.test');
select public.confirm_account_age('google', null);
select pg_temp.su();
select pg_temp.t('2e a second call changes nothing (first time + source kept, still one row)',
  (select count(*) = 1 from public.account_age_confirmations)
  and (select a.confirmed_at = f.confirmed_at and a.source = 'signup' from public.account_age_confirmations a, _first f));
select pg_temp.as_user('b_admin@b.test');
select public.confirm_account_age('hacked'' or 1=1', null);
select pg_temp.su();
select pg_temp.t('2f unknown source saved as signup; each person their own row',
  (select a.source = 'signup' from public.account_age_confirmations a join auth.users u on u.id = a.user_id where u.email = 'b_admin@b.test')
  and (select count(*) = 2 from public.account_age_confirmations));

-- ---- 3) the e-mail rule ----------------------------------------------------------------------------------------------
select pg_temp.t('3a fine: normal, unusual and regional endings, upper case, spaces, trailing dot, empty, not an address',
  public._r403_email_has_tld('ravi@gmail.com') and public._r403_email_has_tld('hello@aurora.events')
  and public._r403_email_has_tld('a@studio.co.in') and public._r403_email_has_tld('  RAVI@GMAIL.COM ')
  and public._r403_email_has_tld('a@gmail.com.') and public._r403_email_has_tld('a@gail.co.in')
  and public._r403_email_has_tld('a@xn--80ak6aa92e.xn--p1ai') and public._r403_email_has_tld('')
  and public._r403_email_has_tld(null) and public._r403_email_has_tld('not an address'));
select pg_temp.t('3b refused: no ending, a lone dot, a one-letter ending, nothing after @',
  not public._r403_email_has_tld('ravi@gmail') and not public._r403_email_has_tld('ravi@gmail.')
  and not public._r403_email_has_tld('x@b.c') and not public._r403_email_has_tld('x@')
  and not public._r403_email_has_tld('Ravi@Studio '));
select pg_temp.t('3c the message is plain and says what to do',
  public._r403_email_message('ravi@gmail') like 'Please check the e-mail address "ravi@gmail" - it is missing its ending, like .com or .in%');

-- ---- 4) guards -------------------------------------------------------------------------------------------------------
select pg_temp.t('4a a NEW login without an ending is refused (22023, email_no_tld)',
  pg_temp.try('select auth.seed_user(''new.person@gmail'')') like '22023|email_no_tld|Please check the e-mail address%');
select pg_temp.t('4b a NEW login with a proper address is made', pg_temp.try('select auth.seed_user(''new.person@gmail.com'')') = 'ok');
-- an OLD login that already has such an address (made before 0403)
alter table auth.users disable trigger a403_email_tld_guard;
select auth.seed_user('legacy.person@gmail');
alter table auth.users enable trigger a403_email_tld_guard;
select pg_temp.t('4c an OLD login is never blocked: sign-in time, metadata, the same e-mail all save',
  pg_temp.try('update auth.users set last_sign_in_at = now() where email = ''legacy.person@gmail''') = 'ok'
  and pg_temp.try('update auth.users set raw_user_meta_data = ''{"x":1}''::jsonb where email = ''legacy.person@gmail''') = 'ok'
  and pg_temp.try('update auth.users set email = email where email = ''legacy.person@gmail''') = 'ok'
  and pg_temp.try('update auth.users set email = ''LEGACY.person@gmail '' where email = ''legacy.person@gmail''') = 'ok');
select pg_temp.t('4d changing an e-mail TO one without an ending is refused; fixing one is fine',
  pg_temp.try('update auth.users set email = ''a_staff@a'' where email = ''a_staff@a.test''') like '22023|email_no_tld|%'
  and pg_temp.try('update auth.users set email = ''legacy.person@gmail.com'' where email = ''LEGACY.person@gmail ''') = 'ok');
select pg_temp.t('4e a pending e-mail change without an ending is refused; a proper one is fine',
  pg_temp.try('update auth.users set email_change = ''new@gmail'' where email = ''a_staff@a.test''') like '22023|email_no_tld|%'
  and pg_temp.try('update auth.users set email_change = ''new@gmail.com'' where email = ''a_staff@a.test''') = 'ok');
select pg_temp.t('4f a NEW invitation without an ending is refused; a proper one is made',
  pg_temp.try('insert into public.invitations(org_id, email, role, token, status, expires_at) values (''a0000000-0000-4000-8000-000000000001'', ''guest@gmail'', ''sales'', ''tok-r238-1'', ''pending'', now() + interval ''7 days'')') like '22023|email_no_tld|%'
  and pg_temp.try('insert into public.invitations(org_id, email, role, token, status, expires_at) values (''a0000000-0000-4000-8000-000000000001'', ''guest@gmail.com'', ''sales'', ''tok-r238-2'', ''pending'', now() + interval ''7 days'')') = 'ok');
alter table public.invitations disable trigger a403_email_tld_guard;
insert into public.invitations(org_id, email, role, token, status, expires_at)
  values ('a0000000-0000-4000-8000-000000000001', 'old.guest@yahoo', 'sales', 'tok-r238-3', 'pending', now() + interval '7 days');
alter table public.invitations enable trigger a403_email_tld_guard;
select pg_temp.t('4g an OLD invitation with such an address can still be revoked / expired; changing its e-mail to another bad one is refused',
  pg_temp.try('update public.invitations set status = ''revoked'' where token = ''tok-r238-3''') = 'ok'
  and pg_temp.try('update public.invitations set expires_at = now() where token = ''tok-r238-3''') = 'ok'
  and pg_temp.try('update public.invitations set email = ''old.guest@yaho'' where token = ''tok-r238-3''') like '22023|email_no_tld|%');
select pg_temp.t('4h a NEW staff e-mail without an ending is refused; no e-mail / a proper one is fine',
  pg_temp.try('insert into public.crew_members(org_id, name, phone, email) values (''a0000000-0000-4000-8000-000000000001'', ''Meena R238'', ''9000000903'', ''meena@gmail'')') like '22023|email_no_tld|%'
  and pg_temp.try('insert into public.crew_members(org_id, name, phone) values (''a0000000-0000-4000-8000-000000000001'', ''Meena R238'', ''9000000903'')') = 'ok'
  and pg_temp.try('update public.crew_members set email = ''meena@gmail.com'' where name = ''Meena R238''') = 'ok'
  and pg_temp.try('update public.crew_members set email = ''meena@gmai'' where name = ''Meena R238''') like '22023|email_no_tld|%');
alter table public.crew_members disable trigger a403_email_tld_guard;
insert into public.crew_members(org_id, name, phone, email) values ('a0000000-0000-4000-8000-000000000001', 'Old Staff R238', '9000000904', 'old.staff@gmail');
alter table public.crew_members enable trigger a403_email_tld_guard;
select pg_temp.t('4i an OLD staff row with such an address: name / phone / notes still save',
  pg_temp.try('update public.crew_members set name = ''Old Staff R238b'', phone = ''9000000905'' where email = ''old.staff@gmail''') = 'ok');

-- ---- 5) re-run safety ------------------------------------------------------------------------------------------------
select pg_temp.t('5a re-run safe: one table, one trigger per table, one confirm function',
  (select count(*) from pg_class where relname = 'account_age_confirmations' and relnamespace = 'public'::regnamespace) = 1
  and (select count(*) from pg_trigger where tgname = 'a403_email_tld_guard') = 3
  and (select count(*) from pg_proc where proname = 'confirm_account_age' and pronamespace = 'public'::regnamespace) = 1);

select name, result from _rs order by name;
select case when count(*) filter (where result <> 'PASS') = 0 then 'R238-SIGNUP-SAFETY-0403: ALL PASS (' || count(*) || '/' || count(*) || ')'
            else 'R238-SIGNUP-SAFETY-0403: ' || count(*) filter (where result <> 'PASS') || ' FAILED of ' || count(*) end as summary from _rs;
rollback;
