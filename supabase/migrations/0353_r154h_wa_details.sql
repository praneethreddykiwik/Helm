-- 0353_r154h_wa_details.sql - R154h WhatsApp details kept. Forward-only, additive, safe to run twice.
-- REQUIRES 0117 (org_whatsapp_accounts, save_org_whatsapp_account) and 0337 (my_integration_accounts with the R129 fields).
--
-- In plain words:
--   On the Integrations page a studio admin typed the WhatsApp Business Account ID, the Phone number ID and the access
--   token, left the page and came back to empty boxes. The only way to keep anything was Connect WhatsApp, and that
--   saved all three together or nothing. Now:
--   1  save_org_whatsapp_account WITHOUT a token (empty or null) saves just the two IDs for the admin of the studio.
--      The two IDs are not secret. A token already in the secure key store stays as it is. With a token the call does
--      exactly what it did before (the old body is kept as save_org_whatsapp_account__pre0353 and called unchanged).
--      Same IDs again changes nothing (a connected number stays connected). New IDs mean the number has to pass the
--      connection check again (pending), unless the studio paused it (stays paused). One number per studio as before.
--   2  my_integration_accounts also says token_saved (true or false, never the token or any part of it) and saved_at,
--      so the page can say Token saved with a Replace token button and pre-fill the two IDs every time.
--
-- ZERO DATA LOSS: no table, column, row or policy dropped or deleted. Two functions re-issued, their old bodies kept once
-- as *__pre0353 with no app privilege. Admin of the studio only, as before (members and other studios are refused).
-- Notes: supabase/migrations/MANIFEST entry 0353.

-- ---- 0) preflight ---------------------------------------------------------------------------------------------------
do $$
begin
  if to_regclass('public.org_whatsapp_accounts') is null
     or to_regprocedure('public.save_org_whatsapp_account(text,text,text,text)') is null then
    raise exception 'STOP 0353: run 0117 (integration accounts) first'; end if;
  if to_regprocedure('public.my_integration_accounts__pre0337()') is null or to_regprocedure('public.my_integration_accounts()') is null then
    raise exception 'STOP 0353: run 0337 (studio WhatsApp) first'; end if;
  if to_regprocedure('public.current_org_id()') is null or to_regprocedure('public.is_admin()') is null then
    raise exception 'STOP 0353: current_org_id() or is_admin() missing'; end if;
end $$;

-- ---- 1) keep the old bodies once ------------------------------------------------------------------------------------------
do $$ begin
  if to_regprocedure('public.save_org_whatsapp_account__pre0353(text,text,text,text)') is null then
    alter function public.save_org_whatsapp_account(text, text, text, text) rename to save_org_whatsapp_account__pre0353; end if;
  if to_regprocedure('public.my_integration_accounts__pre0353()') is null then
    alter function public.my_integration_accounts() rename to my_integration_accounts__pre0353; end if;
end $$;

-- ---- 2) save the two IDs alone (no token), or everything as before ------------------------------------------------------
create or replace function public.save_org_whatsapp_account(p_waba_id text, p_phone_number_id text, p_token text, p_display_phone text default null)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
-- r154h-0353: no token = save the WhatsApp Business Account ID + Phone number ID only (not secret), keep any saved token
declare v_org uuid := public.current_org_id(); r public.org_whatsapp_accounts; v_status text;
begin
  if nullif(btrim(coalesce(p_token, '')), '') is not null then
    return public.save_org_whatsapp_account__pre0353(p_waba_id, p_phone_number_id, p_token, p_display_phone);
  end if;
  if auth.uid() is null or v_org is null or not coalesce(public.is_admin(), false) then
    raise exception 'not_allowed' using errcode = '42501'; end if;
  p_waba_id := btrim(coalesce(p_waba_id, '')); p_phone_number_id := btrim(coalesce(p_phone_number_id, ''));
  if p_waba_id !~ '^[0-9]{5,30}$' then raise exception 'invalid_waba_id' using errcode = '22023'; end if;
  if p_phone_number_id !~ '^[0-9]{5,30}$' then raise exception 'invalid_phone_number_id' using errcode = '22023'; end if;
  if exists (select 1 from public.org_whatsapp_accounts where phone_number_id = p_phone_number_id and org_id <> v_org) then
    raise exception 'phone_in_use' using errcode = '23505'; end if;
  select * into r from public.org_whatsapp_accounts where org_id = v_org for update;
  if r.org_id is null then
    begin
      insert into public.org_whatsapp_accounts (org_id, waba_id, phone_number_id, status, updated_by, updated_at)
        values (v_org, p_waba_id, p_phone_number_id, 'pending', auth.uid(), now());
    exception when unique_violation then
      raise exception 'phone_in_use' using errcode = '23505';
    end;
    return jsonb_build_object('ok', true, 'status', 'pending', 'token_saved', false, 'changed', true);
  end if;
  if r.waba_id is not distinct from p_waba_id and r.phone_number_id is not distinct from p_phone_number_id then
    return jsonb_build_object('ok', true, 'status', r.status, 'token_saved', r.token_secret_id is not null, 'changed', false);
  end if;
  -- new IDs: the number must pass the connection check again, a studio that paused its number stays paused
  v_status := case when r.status = 'disabled' and r.token_secret_id is not null then 'disabled' else 'pending' end;
  begin
    update public.org_whatsapp_accounts set waba_id = p_waba_id, phone_number_id = p_phone_number_id, status = v_status,
           last_error = null, updated_by = auth.uid(), updated_at = now()
     where org_id = v_org;
  exception when unique_violation then
    raise exception 'phone_in_use' using errcode = '23505';
  end;
  return jsonb_build_object('ok', true, 'status', v_status, 'token_saved', r.token_secret_id is not null, 'changed', true);
end $$;

-- ---- 3) my_integration_accounts + token_saved (yes or no only) + saved_at ------------------------------------------------
create or replace function public.my_integration_accounts()
returns jsonb language plpgsql stable security definer set search_path = '' as $$
-- r154h-0353: + whatsapp.token_saved (true or false, never the token) + saved_at (still admin only, still no secret)
declare v jsonb; w public.org_whatsapp_accounts; v_org uuid := public.current_org_id();
begin
  v := public.my_integration_accounts__pre0353();
  if v is null or coalesce((v ->> 'is_admin')::boolean, false) is not true or jsonb_typeof(v -> 'whatsapp') <> 'object' then return v; end if;
  select * into w from public.org_whatsapp_accounts where org_id = v_org;
  if w.org_id is null then return v; end if;
  return jsonb_set(v, '{whatsapp}', (v -> 'whatsapp') || jsonb_build_object('token_saved', w.token_secret_id is not null,
    'saved_at', w.updated_at));
end $$;

-- ---- 4) privileges -----------------------------------------------------------------------------------------------------
do $$ declare f text; begin
  foreach f in array array['public.save_org_whatsapp_account(text, text, text, text)', 'public.my_integration_accounts()',
                           'public.save_org_whatsapp_account__pre0353(text, text, text, text)', 'public.my_integration_accounts__pre0353()'] loop
    execute 'revoke all on function ' || f || ' from public';
    if exists (select 1 from pg_roles where rolname = 'anon') then execute 'revoke all on function ' || f || ' from anon'; end if;
    if exists (select 1 from pg_roles where rolname = 'authenticated') then execute 'revoke all on function ' || f || ' from authenticated'; end if;
    if exists (select 1 from pg_roles where rolname = 'service_role') then execute 'revoke all on function ' || f || ' from service_role'; end if;
  end loop;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    execute 'grant execute on function public.save_org_whatsapp_account(text, text, text, text) to authenticated';
    execute 'grant execute on function public.my_integration_accounts() to authenticated'; end if;
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    execute 'grant execute on function public.save_org_whatsapp_account(text, text, text, text) to service_role';
    execute 'grant execute on function public.my_integration_accounts() to service_role'; end if;
end $$;
