-- r129-studio-whatsapp-0337.sql - R129: each studio sends WhatsApp from its own connected number.
-- Proves: (1) structure - kept bodies have no app privilege, server-only functions are server-only, grants as intended;
-- (2) wa_connect_org is the admin's own studio only; (3) a saved but unchecked number is not "ready"; (4) the connection
-- check result makes it ready for that studio only (member check, approval page "wa", admin summary); (5) template states
-- are cleaned and updated by WABA id only for known templates; (6) a failed check is "error" and not ready; (7) one number
-- per studio; (8) Disconnect: admin only, token out of the key store, number freed for another studio, record kept;
-- (9) re-run safe. Re-applies 0337 twice. Local disposable PG only. Fake data only. Rolled back.
\set ON_ERROR_STOP 0
set client_min_messages = error;
\ir ../../supabase/migrations/0337_r129_studio_whatsapp.sql
\ir ../../supabase/migrations/0337_r129_studio_whatsapp.sql
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
-- run p_sql as a person (email) or anon; -> 'ok:<value>' or '<sqlstate> <message>'
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

-- fixture: both quotes have a live approval link
update public.quotes set approval_token = 'a0000000-0000-4000-8000-0000000a0337'::uuid, approval_token_revoked_at = null,
       approval_token_expires_at = now() + interval '7 days', deleted_at = null, pricing = jsonb_build_object('total', 118000, 'subtotal', 118000)
 where id = 'a0000000-0000-4000-8000-00000000da01';
update public.quotes set approval_token = 'b0000000-0000-4000-8000-0000000b0337'::uuid, approval_token_revoked_at = null,
       approval_token_expires_at = now() + interval '7 days', deleted_at = null, pricing = jsonb_build_object('total', 118000, 'subtotal', 118000)
 where id = 'b0000000-0000-4000-8000-00000000da01';
delete from public.org_whatsapp_accounts where org_id in ('a0000000-0000-4000-8000-000000000001', 'b0000000-0000-4000-8000-000000000001');

-- ---- 1) structure ---------------------------------------------------------------------------------------------------
select pg_temp.t('1a kept bodies exist (re-run made no second copy)',
  (select count(*) = 2 from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname like '%\_\_pre0337'));
select pg_temp.t('1b kept bodies: no app or server privilege',
  not has_function_privilege('anon', 'public.public_quote_ready__pre0337(uuid)', 'execute')
  and not has_function_privilege('authenticated', 'public.public_quote_ready__pre0337(uuid)', 'execute')
  and not has_function_privilege('service_role', 'public.public_quote_ready__pre0337(uuid)', 'execute')
  and not has_function_privilege('authenticated', 'public.my_integration_accounts__pre0337()', 'execute'));
select pg_temp.t('1c server-only functions: the app cannot run them',
  not has_function_privilege('authenticated', 'public.org_whatsapp_check_creds(uuid)', 'execute')
  and not has_function_privilege('anon', 'public.org_whatsapp_check_creds(uuid)', 'execute')
  and not has_function_privilege('authenticated', 'public.wa_account_verified(uuid,boolean,text,text,text,text)', 'execute')
  and not has_function_privilege('authenticated', 'public.wa_templates_mark(uuid,jsonb)', 'execute')
  and not has_function_privilege('authenticated', 'public.wa_template_status(text,text,text)', 'execute')
  and not has_function_privilege('authenticated', 'public._r337_wa_ready(uuid)', 'execute')
  and not has_function_privilege('anon', 'public._r337_wa_ready(uuid)', 'execute'));
select pg_temp.t('1d the server can run them',
  has_function_privilege('service_role', 'public.org_whatsapp_check_creds(uuid)', 'execute')
  and has_function_privilege('service_role', 'public.wa_account_verified(uuid,boolean,text,text,text,text)', 'execute')
  and has_function_privilege('service_role', 'public.wa_templates_mark(uuid,jsonb)', 'execute')
  and has_function_privilege('service_role', 'public.wa_template_status(text,text,text)', 'execute'));
select pg_temp.t('1e app grants: approval page (anon) quote ready; members connect / disconnect / ready; anon none of those',
  has_function_privilege('anon', 'public.public_quote_ready(uuid)', 'execute')
  and has_function_privilege('authenticated', 'public.wa_connect_org()', 'execute')
  and has_function_privilege('authenticated', 'public.disconnect_org_whatsapp_account()', 'execute')
  and has_function_privilege('authenticated', 'public.studio_whatsapp_ready()', 'execute')
  and has_function_privilege('authenticated', 'public.my_integration_accounts()', 'execute')
  and not has_function_privilege('anon', 'public.wa_connect_org()', 'execute')
  and not has_function_privilege('anon', 'public.disconnect_org_whatsapp_account()', 'execute')
  and not has_function_privilege('anon', 'public.studio_whatsapp_ready()', 'execute'));
select pg_temp.t('1f re-issued functions carry the 0337 marker',
  position('r129-0337' in pg_get_functiondef('public.public_quote_ready(uuid)'::regprocedure)) > 0
  and position('r129-0337' in pg_get_functiondef('public.my_integration_accounts()'::regprocedure)) > 0);

-- ---- 2) wa_connect_org ------------------------------------------------------------------------------------------------
select pg_temp.t('2a the admin gets their own studio', pg_temp.as_val('a_admin@a.test', 'select public.wa_connect_org()::text') = 'ok:a0000000-0000-4000-8000-000000000001',
  pg_temp.as_val('a_admin@a.test', 'select public.wa_connect_org()::text'));
select pg_temp.t('2b a non-admin member is refused', pg_temp.as_val('a_staff@a.test', 'select public.wa_connect_org()::text') like '42501%');
select pg_temp.t('2c anon is refused', pg_temp.as_val('anon', 'select public.wa_connect_org()::text') like '42501%');

-- ---- 3) saved, not checked: not ready ---------------------------------------------------------------------------------
select pg_temp.t('3a the admin saves a number (pending)',
  pg_temp.as_val('a_admin@a.test', $q$select public.save_org_whatsapp_account('1000000337', '2000000337', 'test-token-0337-xxxxxxxxxxxxxxxx', '+91 90000 00337') ->> 'status'$q$) = 'ok:pending');
select pg_temp.t('3b pending is not ready for members', pg_temp.as_val('a_staff@a.test', $q$select public.studio_whatsapp_ready() ->> 'connected'$q$) = 'ok:false');
select pg_temp.t('3c the approval page says wa false while pending', (public.public_quote_ready('a0000000-0000-4000-8000-0000000a0337') ->> 'wa') = 'false');
select pg_temp.t('3d the server reads the pending number + token for the check',
  (public.org_whatsapp_check_creds('a0000000-0000-4000-8000-000000000001') ->> 'token') = 'test-token-0337-xxxxxxxxxxxxxxxx'
  and (public.org_whatsapp_check_creds('a0000000-0000-4000-8000-000000000001') ->> 'phone_number_id') = '2000000337');
select pg_temp.t('3e the normal send lookup still answers nothing while pending', public.org_whatsapp_creds('a0000000-0000-4000-8000-000000000001') is null);

-- ---- 4) the check passes: ready for that studio only ------------------------------------------------------------------------
select pg_temp.t('4a check result: connected',
  (public.wa_account_verified('a0000000-0000-4000-8000-000000000001', true, '+91 90000 00337', 'Studio A <b>', 'GREEN') ->> 'result') = 'connected');
select pg_temp.t('4b row: connected, name cleaned, quality kept',
  exists (select 1 from public.org_whatsapp_accounts where org_id = 'a0000000-0000-4000-8000-000000000001' and status = 'connected'
          and verified_name = 'Studio A  b' and quality = 'GREEN' and connected_at is not null));
select pg_temp.t('4c a member of A sees connected + the number', pg_temp.as_val('a_staff@a.test',
  $q$select (public.studio_whatsapp_ready() ->> 'connected') || '|' || (public.studio_whatsapp_ready() ->> 'display_phone')$q$) = 'ok:true|+91 90000 00337');
select pg_temp.t('4d the member answer never carries an id or a token', pg_temp.as_val('a_staff@a.test',
  $q$select (public.studio_whatsapp_ready() ? 'phone_number_id') or (public.studio_whatsapp_ready() ? 'token') or (public.studio_whatsapp_ready() ? 'waba_id')$q$) = 'ok:false');
select pg_temp.t('4e a member of B: not connected', pg_temp.as_val('b_staff@b.test', $q$select public.studio_whatsapp_ready() ->> 'connected'$q$) = 'ok:false');
select pg_temp.t('4f approval page: wa true for A''s link, false for B''s',
  pg_temp.as_val('anon', $q$select public.public_quote_ready('a0000000-0000-4000-8000-0000000a0337') ->> 'wa'$q$) = 'ok:true'
  and pg_temp.as_val('anon', $q$select public.public_quote_ready('b0000000-0000-4000-8000-0000000b0337') ->> 'wa'$q$) = 'ok:false');
select pg_temp.t('4g approval page: priced + studio unchanged',
  (public.public_quote_ready('a0000000-0000-4000-8000-0000000a0337') ->> 'studio') = 'Studio A'
  and (public.public_quote_ready('a0000000-0000-4000-8000-0000000a0337') ? 'priced'));
select pg_temp.t('4h an unknown link is still null', public.public_quote_ready('c0000000-0000-4000-8000-0000000c0337') is null);
select pg_temp.t('4i the normal send lookup now answers with the token',
  (public.org_whatsapp_creds('a0000000-0000-4000-8000-000000000001') ->> 'token') = 'test-token-0337-xxxxxxxxxxxxxxxx');
select pg_temp.t('4j admin summary: verified name + ready, never a token', pg_temp.as_val('a_admin@a.test',
  $q$select (public.my_integration_accounts() #>> '{whatsapp,ready}') || '|' || (public.my_integration_accounts()::text like '%test-token-0337%')::text$q$) = 'ok:true|false');
select pg_temp.t('4k a non-admin gets no summary', pg_temp.as_val('a_staff@a.test', $q$select public.my_integration_accounts() ->> 'is_admin'$q$) = 'ok:false');

-- ---- 5) template states ------------------------------------------------------------------------------------------------------
select public.wa_templates_mark('a0000000-0000-4000-8000-000000000001', '{"proposal_sent":"PENDING","Bad Name":"APPROVED","helm_notice":"approved","x":1}'::jsonb);
select pg_temp.t('5a only safe name + state pairs are kept',
  (select templates = '{"proposal_sent":"PENDING"}'::jsonb and templates_checked_at is not null from public.org_whatsapp_accounts where org_id = 'a0000000-0000-4000-8000-000000000001'),
  (select coalesce(templates::text, 'null') from public.org_whatsapp_accounts where org_id = 'a0000000-0000-4000-8000-000000000001'));
select pg_temp.t('5b the webhook records a known template by WABA id', (public.wa_template_status('1000000337', 'proposal_sent', 'approved') ->> 'result') = 'recorded');
select pg_temp.t('5b2 ... as APPROVED', (select templates ->> 'proposal_sent' from public.org_whatsapp_accounts where org_id = 'a0000000-0000-4000-8000-000000000001') = 'APPROVED');
select pg_temp.t('5c an unknown template / other WABA / bad name is ignored',
  (public.wa_template_status('1000000337', 'someone_elses', 'APPROVED') ->> 'result') = 'ignored'
  and (public.wa_template_status('9999999337', 'proposal_sent', 'REJECTED') ->> 'result') = 'ignored'
  and (public.wa_template_status('1000000337', 'x; drop', 'APPROVED') ->> 'result') = 'ignored'
  and (select templates = '{"proposal_sent":"APPROVED"}'::jsonb from public.org_whatsapp_accounts where org_id = 'a0000000-0000-4000-8000-000000000001'));

-- ---- 6) a failed check: error, not ready; a later pass connects again ---------------------------------------------------------
select public.wa_account_verified('a0000000-0000-4000-8000-000000000001', false, null, null, null, 'Meta says the token <expired>');
select pg_temp.t('6a failed check: error + reason, not ready',
  (select status = 'error' and last_error not like '%<%' and last_error like '%token%' from public.org_whatsapp_accounts where org_id = 'a0000000-0000-4000-8000-000000000001')
  and public._r337_wa_ready('a0000000-0000-4000-8000-000000000001') is false
  and (public.public_quote_ready('a0000000-0000-4000-8000-0000000a0337') ->> 'wa') = 'false');
select public.wa_account_verified('a0000000-0000-4000-8000-000000000001', true, null, null, 'GREEN');
select pg_temp.t('6b a later pass connects again, number kept', public._r337_wa_ready('a0000000-0000-4000-8000-000000000001')
  and (select display_phone = '+91 90000 00337' from public.org_whatsapp_accounts where org_id = 'a0000000-0000-4000-8000-000000000001'));

-- ---- 7) one number per studio ------------------------------------------------------------------------------------------------------
select pg_temp.t('7a studio B cannot connect A''s number',
  pg_temp.as_val('b_admin@b.test', $q$select public.save_org_whatsapp_account('1000000338', '2000000337', 'test-token-b-0337-xxxxxxxxxxxxxx') ->> 'status'$q$) like '23505%phone_in_use%');

-- ---- 8) Disconnect -----------------------------------------------------------------------------------------------------------------
create temp table _sid as select token_secret_id from public.org_whatsapp_accounts where org_id = 'a0000000-0000-4000-8000-000000000001';
select pg_temp.t('8a a non-admin member cannot disconnect', pg_temp.as_val('a_staff@a.test', 'select public.disconnect_org_whatsapp_account()::text') like '42501%'
  and public._r337_wa_ready('a0000000-0000-4000-8000-000000000001'));
select pg_temp.t('8b the admin disconnects', pg_temp.as_val('a_admin@a.test', $q$select public.disconnect_org_whatsapp_account() ->> 'status'$q$) = 'ok:disconnected');
select pg_temp.t('8c the token is gone from the key store', not exists (select 1 from vault.secrets s join _sid on s.id = _sid.token_secret_id));
select pg_temp.t('8d the row stays as a record: disabled, number freed, when kept',
  (select status = 'disabled' and phone_number_id is null and token_secret_id is null and templates is null and disconnected_at is not null and waba_id = '1000000337'
     from public.org_whatsapp_accounts where org_id = 'a0000000-0000-4000-8000-000000000001'));
select pg_temp.t('8e not ready; the server lookups answer nothing; the approval page says wa false',
  public._r337_wa_ready('a0000000-0000-4000-8000-000000000001') is false
  and public.org_whatsapp_creds('a0000000-0000-4000-8000-000000000001') is null
  and public.org_whatsapp_check_creds('a0000000-0000-4000-8000-000000000001') is null
  and (public.public_quote_ready('a0000000-0000-4000-8000-0000000a0337') ->> 'wa') = 'false');
select pg_temp.t('8f a late check result cannot reconnect a disconnected studio',
  (public.wa_account_verified('a0000000-0000-4000-8000-000000000001', true, '+91 90000 00337') ->> 'result') = 'ignored'
  and (select status from public.org_whatsapp_accounts where org_id = 'a0000000-0000-4000-8000-000000000001') = 'disabled');
select pg_temp.t('8g studio B may now connect the freed number',
  pg_temp.as_val('b_admin@b.test', $q$select public.save_org_whatsapp_account('1000000338', '2000000337', 'test-token-b-0337-xxxxxxxxxxxxxx') ->> 'status'$q$) = 'ok:pending');
select pg_temp.t('8h disconnecting twice is fine', pg_temp.as_val('a_admin@a.test', $q$select public.disconnect_org_whatsapp_account() ->> 'ok'$q$) = 'ok:true');
select pg_temp.t('8i studio A can connect again later',
  pg_temp.as_val('a_admin@a.test', $q$select public.save_org_whatsapp_account('1000000337', '2000000339', 'test-token-0337-again-xxxxxxxxxx') ->> 'status'$q$) = 'ok:pending');
select pg_temp.t('8j ... pending again, the earlier disconnect time kept as history',
  (select disconnected_at is not null and status = 'pending' and phone_number_id = '2000000339' from public.org_whatsapp_accounts where org_id = 'a0000000-0000-4000-8000-000000000001'));

-- ---- result ----------------------------------------------------------------------------------------------------------------------
do $$ declare n int; f int; r record; begin
  select count(*), count(*) filter (where result <> 'PASS') into n, f from _rs;
  for r in select * from _rs where result <> 'PASS' loop raise warning '% -> %', r.name, r.result; end loop;
  if f = 0 then raise warning 'R129-STUDIO-WHATSAPP-0337: ALL PASS (%/%)', n, n;
  else raise warning 'R129-STUDIO-WHATSAPP-0337: % FAILED of %', f, n; end if;
end $$;
rollback;
