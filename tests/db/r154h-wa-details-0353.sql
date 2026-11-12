-- r154h-wa-details-0353.sql - R154h: the WhatsApp Business Account ID + Phone number ID are kept for the studio admin
-- without a token, and the page learns only whether a token is saved. Proves: (1) structure - the 0353 bodies, kept
-- bodies without privilege, grants; (2) the reported bug: before 0353 the IDs alone could not be saved (invalid_token),
-- so typed IDs were lost; (3) after 0353 the admin saves the IDs alone (pending, no token) and reads them back with
-- token_saved false; members, the other studio and anon are refused / see nothing; (4) bad IDs refused, one number per
-- studio; (5) with a token the call works exactly as before (token into the key store, token_saved true, never the
-- token itself); (6) the same IDs again keep a connected number connected and the token; new IDs need the check again,
-- the token stays; a paused number stays paused; (7) after Disconnect the WABA id is still there and new IDs can be
-- saved; (8) re-run safe. Re-applies 0353 twice. Local disposable PG only. Fake data only. Rolled back.
\set ON_ERROR_STOP 0
set client_min_messages = error;
\ir ../../supabase/migrations/0337_r129_studio_whatsapp.sql
\ir ../../supabase/migrations/0353_r154h_wa_details.sql
\ir ../../supabase/migrations/0353_r154h_wa_details.sql
set client_min_messages = warning;
begin;
-- a stand-in for Supabase Vault (the real one exists on staging / production)
create schema if not exists vault;
create table if not exists vault.secrets (id uuid primary key default gen_random_uuid(), secret text, name text, description text);
create or replace view vault.decrypted_secrets as select id, secret as decrypted_secret, name from vault.secrets;
create or replace function vault.create_secret(p_secret text, p_name text, p_desc text) returns uuid language sql as $$
  insert into vault.secrets(secret, name, description) values (p_secret, p_name, p_desc) returning id $$;
create or replace function vault.update_secret(p_id uuid, p_secret text) returns void language sql as $$
  update vault.secrets set secret = p_secret where id = p_id $$;

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
delete from public.org_whatsapp_accounts where org_id in ('a0000000-0000-4000-8000-000000000001', 'b0000000-0000-4000-8000-000000000001');

-- ---- 1) structure ---------------------------------------------------------------------------------------------------
select pg_temp.t('1a 0353 bodies in place, old bodies kept once (re-run made no second copy)',
  position('r154h-0353' in pg_get_functiondef('public.save_org_whatsapp_account(text,text,text,text)'::regprocedure)) > 0
  and position('r154h-0353' in pg_get_functiondef('public.my_integration_accounts()'::regprocedure)) > 0
  and (select count(*) = 2 from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname like '%\_\_pre0353')
  and position('integration-accounts-0117' in pg_get_functiondef('public.save_org_whatsapp_account__pre0353(text,text,text,text)'::regprocedure)) > 0
  and position('r129-0337' in pg_get_functiondef('public.my_integration_accounts__pre0353()'::regprocedure)) > 0);
select pg_temp.t('1b kept bodies: no app or server privilege',
  not has_function_privilege('authenticated', 'public.save_org_whatsapp_account__pre0353(text,text,text,text)', 'execute')
  and not has_function_privilege('anon', 'public.save_org_whatsapp_account__pre0353(text,text,text,text)', 'execute')
  and not has_function_privilege('service_role', 'public.save_org_whatsapp_account__pre0353(text,text,text,text)', 'execute')
  and not has_function_privilege('authenticated', 'public.my_integration_accounts__pre0353()', 'execute')
  and not has_function_privilege('service_role', 'public.my_integration_accounts__pre0353()', 'execute'));
select pg_temp.t('1c signed-in users + the server run the new ones, anon does not',
  has_function_privilege('authenticated', 'public.save_org_whatsapp_account(text,text,text,text)', 'execute')
  and has_function_privilege('authenticated', 'public.my_integration_accounts()', 'execute')
  and has_function_privilege('service_role', 'public.save_org_whatsapp_account(text,text,text,text)', 'execute')
  and not has_function_privilege('anon', 'public.save_org_whatsapp_account(text,text,text,text)', 'execute')
  and not has_function_privilege('anon', 'public.my_integration_accounts()', 'execute'));
select pg_temp.t('1d signed-in users still cannot read the token key column',
  not has_column_privilege('authenticated', 'public.org_whatsapp_accounts', 'token_secret_id', 'select'));

-- ---- 2) the reported bug: the old body refuses the IDs without a token (typed IDs were lost) ------------------------------------
do $$ begin
  perform set_config('request.jwt.claims', json_build_object('sub', (select id from auth.users where email = 'a_admin@a.test'), 'role', 'authenticated')::text, true);
  begin
    perform public.save_org_whatsapp_account__pre0353('1000000353', '2000000353', null);
    insert into _rs values ('2a the old body refused the IDs alone', 'FAIL: it saved them');
  exception when others then
    insert into _rs values ('2a the old body refused the IDs alone (invalid_token) - typed IDs were lost', case when sqlerrm = 'invalid_token' then 'PASS' else 'FAIL: ' || sqlerrm end);
  end;
  perform set_config('request.jwt.claims', '', true);
end $$;
select pg_temp.t('2b ... and nothing was kept', not exists (select 1 from public.org_whatsapp_accounts where org_id = 'a0000000-0000-4000-8000-000000000001'));

-- ---- 3) after 0353: the admin saves the IDs alone and reads them back ----------------------------------------------------------
select pg_temp.t('3a the admin saves the IDs without a token (null)',
  pg_temp.as_val('a_admin@a.test', $q$select (r ->> 'status') || '|' || (r ->> 'token_saved') || '|' || (r ->> 'changed') from public.save_org_whatsapp_account('1000000353', '2000000353', null) r$q$) = 'ok:pending|false|true',
  pg_temp.as_val('a_admin@a.test', $q$select public.save_org_whatsapp_account('1000000353', '2000000353', null)::text$q$));
select pg_temp.t('3b the row: both IDs, pending, no token',
  (select waba_id = '1000000353' and phone_number_id = '2000000353' and status = 'pending' and token_secret_id is null
     from public.org_whatsapp_accounts where org_id = 'a0000000-0000-4000-8000-000000000001'));
select pg_temp.t('3c the page reads them back (pre-fill) with token_saved false',
  pg_temp.as_val('a_admin@a.test', $q$select (m #>> '{whatsapp,waba_id}') || '|' || (m #>> '{whatsapp,phone_number_id}') || '|' || (m #>> '{whatsapp,token_saved}') || '|' || (m #>> '{whatsapp,status}') || '|' || ((m #>> '{whatsapp,saved_at}') is not null)::text from public.my_integration_accounts() m$q$)
  = 'ok:1000000353|2000000353|false|pending|true');
select pg_temp.t('3d an empty / blank token is the same as no token',
  pg_temp.as_val('a_admin@a.test', $q$select public.save_org_whatsapp_account('1000000353', '2000000353', '   ') ->> 'changed'$q$) = 'ok:false'
  and pg_temp.as_val('a_admin@a.test', $q$select public.save_org_whatsapp_account('1000000353', '2000000353', '') ->> 'changed'$q$) = 'ok:false');
select pg_temp.t('3e a non-admin member cannot save the IDs', pg_temp.as_val('a_staff@a.test', $q$select public.save_org_whatsapp_account('1000000999', '2000000999', null)::text$q$) like '42501%');
select pg_temp.t('3f anon cannot', pg_temp.as_val('anon', $q$select public.save_org_whatsapp_account('1000000999', '2000000999', null)::text$q$) like '42501%');
select pg_temp.t('3g a member sees no IDs', pg_temp.as_val('a_staff@a.test', $q$select (public.my_integration_accounts() ? 'whatsapp')::text || '|' || (public.my_integration_accounts() ->> 'is_admin')$q$) = 'ok:false|false');
select pg_temp.t('3h the other studio admin sees nothing of A',
  pg_temp.as_val('b_admin@b.test', $q$select coalesce(public.my_integration_accounts() #>> '{whatsapp,waba_id}', 'none')$q$) = 'ok:none');
select pg_temp.t('3i not ready, the check reads nothing (no token yet), the send lookup answers nothing',
  public._r337_wa_ready('a0000000-0000-4000-8000-000000000001') is false
  and public.org_whatsapp_check_creds('a0000000-0000-4000-8000-000000000001') is null
  and public.org_whatsapp_creds('a0000000-0000-4000-8000-000000000001') is null);
select pg_temp.t('3j studio A was not changed by the refused member / anon calls',
  (select waba_id = '1000000353' and phone_number_id = '2000000353' from public.org_whatsapp_accounts where org_id = 'a0000000-0000-4000-8000-000000000001'));

-- ---- 4) bad IDs, one number per studio ----------------------------------------------------------------------------------------
select pg_temp.t('4a a WABA id that is not a long number is refused', pg_temp.as_val('a_admin@a.test', $q$select public.save_org_whatsapp_account('abc', '2000000353', null)::text$q$) like '22023%invalid_waba_id%');
select pg_temp.t('4b a phone number id that is not a long number is refused', pg_temp.as_val('a_admin@a.test', $q$select public.save_org_whatsapp_account('1000000353', '+91 98', null)::text$q$) like '22023%invalid_phone_number_id%');
select pg_temp.t('4c studio B cannot take A''s phone number id (IDs only)',
  pg_temp.as_val('b_admin@b.test', $q$select public.save_org_whatsapp_account('1000000354', '2000000353', null)::text$q$) like '23505%phone_in_use%'
  and not exists (select 1 from public.org_whatsapp_accounts where org_id = 'b0000000-0000-4000-8000-000000000001'));

-- ---- 5) with a token: exactly as before -------------------------------------------------------------------------------------------
select pg_temp.t('5a the admin adds the token (pending, token in the key store)',
  pg_temp.as_val('a_admin@a.test', $q$select public.save_org_whatsapp_account('1000000353', '2000000353', 'test-token-0353-xxxxxxxxxxxxxxxx') ->> 'status'$q$) = 'ok:pending');
select pg_temp.t('5a2 ... the token is in the key store, linked to the row',
  (select s.secret = 'test-token-0353-xxxxxxxxxxxxxxxx' from public.org_whatsapp_accounts w join vault.secrets s on s.id = w.token_secret_id where w.org_id = 'a0000000-0000-4000-8000-000000000001'));
select pg_temp.t('5b the page sees token_saved true and never the token',
  pg_temp.as_val('a_admin@a.test', $q$select (public.my_integration_accounts() #>> '{whatsapp,token_saved}') || '|' || (public.my_integration_accounts()::text like '%test-token-0353%')::text || '|' || (public.my_integration_accounts()::text like '%token_secret%')::text$q$) = 'ok:true|false|false');
select pg_temp.t('5c the connection check now reads the number + token', (public.org_whatsapp_check_creds('a0000000-0000-4000-8000-000000000001') ->> 'phone_number_id') = '2000000353');
select public.wa_account_verified('a0000000-0000-4000-8000-000000000001', true, '+91 90000 00353', 'Studio A', 'GREEN');
create temp table _sid as select token_secret_id from public.org_whatsapp_accounts where org_id = 'a0000000-0000-4000-8000-000000000001';

-- ---- 6) saving the IDs again ------------------------------------------------------------------------------------------------------
select pg_temp.t('6a the same IDs again: nothing changes, the number stays connected',
  pg_temp.as_val('a_admin@a.test', $q$select (r ->> 'changed') || '|' || (r ->> 'status') || '|' || (r ->> 'token_saved') from public.save_org_whatsapp_account('1000000353', '2000000353', null) r$q$) = 'ok:false|connected|true'
  and public._r337_wa_ready('a0000000-0000-4000-8000-000000000001'));
select pg_temp.t('6b new phone number id: pending again (check needed), the saved token stays',
  pg_temp.as_val('a_admin@a.test', $q$select (r ->> 'changed') || '|' || (r ->> 'status') || '|' || (r ->> 'token_saved') from public.save_org_whatsapp_account('1000000353', '2000000355', null) r$q$) = 'ok:true|pending|true');
select pg_temp.t('6b2 ... same key store entry, new number, not ready until checked',
  (select w.token_secret_id = _sid.token_secret_id and w.phone_number_id = '2000000355' from public.org_whatsapp_accounts w, _sid where w.org_id = 'a0000000-0000-4000-8000-000000000001')
  and exists (select 1 from vault.secrets s join _sid on s.id = _sid.token_secret_id where s.secret = 'test-token-0353-xxxxxxxxxxxxxxxx')
  and public._r337_wa_ready('a0000000-0000-4000-8000-000000000001') is false);
select pg_temp.t('6c the old phone number id is free for another studio now',
  pg_temp.as_val('b_admin@b.test', $q$select public.save_org_whatsapp_account('1000000354', '2000000353', null) ->> 'status'$q$) = 'ok:pending');
update public.org_whatsapp_accounts set status = 'error', last_error = 'the access token stopped working' where org_id = 'a0000000-0000-4000-8000-000000000001';
select pg_temp.t('6d new IDs after a failed check clear the old reason',
  pg_temp.as_val('a_admin@a.test', $q$select public.save_org_whatsapp_account('1000000356', '2000000356', null) ->> 'status'$q$) = 'ok:pending');
select pg_temp.t('6d2 ... reason cleared, new WABA id kept',
  (select last_error is null and waba_id = '1000000356' from public.org_whatsapp_accounts where org_id = 'a0000000-0000-4000-8000-000000000001'));
select pg_temp.as_val('a_admin@a.test', $q$select public.set_org_integration_status('whatsapp', 'disabled')::text$q$);
select pg_temp.t('6e a paused number stays paused when its IDs change',
  pg_temp.as_val('a_admin@a.test', $q$select public.save_org_whatsapp_account('1000000356', '2000000357', null) ->> 'status'$q$) = 'ok:disabled');
select pg_temp.t('6e2 ... row still paused with the new number',
  (select status = 'disabled' and phone_number_id = '2000000357' from public.org_whatsapp_accounts where org_id = 'a0000000-0000-4000-8000-000000000001'));

-- ---- 7) after Disconnect ---------------------------------------------------------------------------------------------------------
select pg_temp.as_val('a_admin@a.test', $q$select public.disconnect_org_whatsapp_account()::text$q$);
select pg_temp.t('7a disconnected: the WABA id is still shown for pre-fill, no token',
  pg_temp.as_val('a_admin@a.test', $q$select (public.my_integration_accounts() #>> '{whatsapp,waba_id}') || '|' || (public.my_integration_accounts() #>> '{whatsapp,token_saved}') || '|' || (public.my_integration_accounts() #>> '{whatsapp,status}')$q$) = 'ok:1000000356|false|disabled');
select pg_temp.t('7b new IDs after Disconnect: pending, still no token, disconnect time kept',
  pg_temp.as_val('a_admin@a.test', $q$select public.save_org_whatsapp_account('1000000356', '2000000358', null) ->> 'status'$q$) = 'ok:pending');
select pg_temp.t('7b2 ... still no token, the disconnect time kept',
  (select token_secret_id is null and disconnected_at is not null from public.org_whatsapp_accounts where org_id = 'a0000000-0000-4000-8000-000000000001'));
select pg_temp.t('7c nothing deleted: both studios still have their row', (select count(*) = 2 from public.org_whatsapp_accounts
  where org_id in ('a0000000-0000-4000-8000-000000000001', 'b0000000-0000-4000-8000-000000000001')));

-- ---- result ----------------------------------------------------------------------------------------------------------------------
do $$ declare n int; f int; r record; begin
  select count(*), count(*) filter (where result <> 'PASS') into n, f from _rs;
  for r in select * from _rs where result <> 'PASS' loop raise warning '% -> %', r.name, r.result; end loop;
  if f = 0 then raise warning 'R154H-WA-DETAILS-0353: ALL PASS (%/%)', n, n;
  else raise warning 'R154H-WA-DETAILS-0353: % FAILED of %', f, n; end if;
end $$;
rollback;
