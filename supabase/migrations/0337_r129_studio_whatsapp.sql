-- 0337_r129_studio_whatsapp.sql - CANONICAL forward-only. R129 (owner: "implement whatsapp and enable whatsapp integration on the website").
-- REQUIRES 0117 (org_whatsapp_accounts, _integ_vault_*, org_whatsapp_creds, mark_org_integration),
--          0318 (public_quote_ready), public.current_org_id(), public.is_admin()
--
-- In plain words:
--   Each studio sends its client messages from ITS OWN WhatsApp Business number. Helm's own number is only for Helm's own
--   messages (staff phone verification). A studio that has not connected a number sends no WhatsApp: e-mail and the manual
--   "open WhatsApp" buttons keep working. This file adds what the connect screen and the senders need:
--   1  wa_connect_org(): the studio admin's own studio (the connect function asks this AS the caller). Others are refused.
--   2  org_whatsapp_check_creds(org): the saved number + token for the connection check, also while it is still "pending".
--      Server only.
--   3  wa_account_verified(org, ...): the connection check's result. "connected" with the number and name Meta returned,
--      or "error" with a short reason. A paused or disconnected account is left alone. Server only.
--   4  Message templates: the studio's template states (approved / pending / rejected) are kept on its account row
--      (wa_templates_mark, and wa_template_status from Meta's webhook). Server only.
--   5  disconnect_org_whatsapp_account(): the studio admin disconnects. The token is removed from the secure key store,
--      the number is freed (another studio may connect it), the row stays as a record ("disabled" + when).
--   6  studio_whatsapp_ready(): any member of the studio may ask "is our WhatsApp connected?" (yes / no + the number shown
--      to clients). Never an id or a token.
--   7  public_quote_ready(token) also says "wa": true when the link's studio has a connected number, so the client
--      approval page shows "Send code on WhatsApp" only when it can really be sent.
--   8  my_integration_accounts() also returns the verified name, template states and when it was disconnected.
--
-- ZERO DATA LOSS: additive + idempotent. New columns (nullable) and new functions. Two functions re-issued
-- (public_quote_ready, my_integration_accounts); their old bodies are kept once as *__pre0337 with no app privilege.
-- Nothing is dropped. The only row deleted is the disconnected studio's OWN token in the secure key store, and only when
-- its admin presses Disconnect. Safe to run twice.

-- ---- 0) preflight ---------------------------------------------------------------------------------------------------
do $$
begin
  if to_regclass('public.org_whatsapp_accounts') is null or to_regprocedure('public.org_whatsapp_creds(uuid)') is null
     or to_regprocedure('public._integ_vault_get(uuid)') is null or to_regprocedure('public.mark_org_integration(uuid,text,text,text)') is null then
    raise exception 'STOP 0337: run 0117 (integration accounts) first'; end if;
  if to_regprocedure('public.public_quote_ready(uuid)') is null then
    raise exception 'STOP 0337: public_quote_ready(uuid) missing - run 0318 first'; end if;
  if to_regprocedure('public.my_integration_accounts()') is null then
    raise exception 'STOP 0337: my_integration_accounts() missing - run 0117 first'; end if;
  if to_regprocedure('public.current_org_id()') is null or to_regprocedure('public.is_admin()') is null then
    raise exception 'STOP 0337: current_org_id() / is_admin() missing'; end if;
end $$;

-- ---- 1) columns (nullable, additive) --------------------------------------------------------------------------------
alter table public.org_whatsapp_accounts add column if not exists templates jsonb;
alter table public.org_whatsapp_accounts add column if not exists templates_checked_at timestamptz;
alter table public.org_whatsapp_accounts add column if not exists disconnected_at timestamptz;
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'org_whatsapp_accounts_templates_chk337') then
    alter table public.org_whatsapp_accounts add constraint org_whatsapp_accounts_templates_chk337
      check (templates is null or (jsonb_typeof(templates) = 'object' and length(templates::text) <= 4000));
  end if;
end $$;

-- ---- 2) helpers -----------------------------------------------------------------------------------------------------
-- a studio's number is ready to send: connected, with a number and a token
create or replace function public._r337_wa_ready(p_org uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  -- r129-0337
  select exists (select 1 from public.org_whatsapp_accounts w
                  where w.org_id = p_org and w.status = 'connected' and w.phone_number_id is not null and w.token_secret_id is not null);
$$;

-- template states: only {"name": "STATE"} pairs with safe names / states
create or replace function public._r337_clean_templates(p jsonb)
returns jsonb language plpgsql immutable set search_path = '' as $$
-- r129-0337
declare v_out jsonb := '{}'::jsonb; k text; v jsonb; n int := 0;
begin
  if p is null or jsonb_typeof(p) <> 'object' then return null; end if;
  for k, v in select * from jsonb_each(p) loop
    exit when n >= 30;
    if k ~ '^[a-z0-9_]{1,64}$' and jsonb_typeof(v) = 'string' and (v #>> '{}') ~ '^[A-Z_]{1,30}$' then
      v_out := v_out || jsonb_build_object(k, v #>> '{}'); n := n + 1;
    end if;
  end loop;
  return v_out;
end $$;

-- ---- 3) the studio admin's own studio (asked AS the caller by the wa-connect edge function) ----------------------------
create or replace function public.wa_connect_org()
returns uuid language plpgsql stable security definer set search_path = '' as $$
-- r129-0337
declare v_org uuid := public.current_org_id();
begin
  if auth.uid() is null or v_org is null or not coalesce(public.is_admin(), false) then
    raise exception 'not_allowed' using errcode = '42501'; end if;
  return v_org;
end $$;

-- ---- 4) server only: the saved number + token for the connection check (pending / connected / error) ---------------------
create or replace function public.org_whatsapp_check_creds(p_org uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
-- r129-0337
declare r public.org_whatsapp_accounts;
begin
  select * into r from public.org_whatsapp_accounts
   where org_id = p_org and status in ('pending', 'connected', 'error') and phone_number_id is not null and token_secret_id is not null;
  if r.org_id is null then return null; end if;
  return jsonb_build_object('org_id', r.org_id, 'waba_id', r.waba_id, 'phone_number_id', r.phone_number_id, 'status', r.status,
    'token', public._integ_vault_get(r.token_secret_id));
end $$;

-- ---- 5) server only: the connection check's result ---------------------------------------------------------------------
create or replace function public.wa_account_verified(p_org uuid, p_ok boolean, p_display_phone text default null,
  p_verified_name text default null, p_quality text default null, p_error text default null)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
-- r129-0337
declare v_status text;
begin
  select w.status into v_status from public.org_whatsapp_accounts w where w.org_id = p_org for update;
  if v_status is null or v_status not in ('pending', 'connected', 'error') then return jsonb_build_object('result', 'ignored'); end if;
  if coalesce(p_ok, false) then
    update public.org_whatsapp_accounts set status = 'connected', last_error = null,
           display_phone = coalesce(left(nullif(btrim(regexp_replace(coalesce(p_display_phone, ''), '[^0-9+ ()-]', '', 'g')), ''), 30), display_phone),
           verified_name = coalesce(left(nullif(btrim(regexp_replace(coalesce(p_verified_name, ''), '[<>\r\n\t]', ' ', 'g')), ''), 120), verified_name),
           quality = left(nullif(btrim(regexp_replace(coalesce(p_quality, ''), '[^A-Za-z_]', '', 'g')), ''), 20),
           connected_at = case when status = 'connected' and connected_at is not null then connected_at else now() end,
           updated_at = now()
     where org_id = p_org;
    return jsonb_build_object('result', 'connected');
  end if;
  update public.org_whatsapp_accounts set status = 'error',
         last_error = left(coalesce(nullif(btrim(regexp_replace(coalesce(p_error, ''), '[<>\r\n\t]', ' ', 'g')), ''), 'connection check failed'), 200),
         updated_at = now()
   where org_id = p_org;
  return jsonb_build_object('result', 'error');
end $$;

-- ---- 6) server only: template states ----------------------------------------------------------------------------------
create or replace function public.wa_templates_mark(p_org uuid, p_templates jsonb)
returns void language plpgsql volatile security definer set search_path = '' as $$
-- r129-0337
begin
  update public.org_whatsapp_accounts set templates = public._r337_clean_templates(p_templates), templates_checked_at = now(), updated_at = now()
   where org_id = p_org and status in ('pending', 'connected', 'error');
end $$;

-- Meta's message_template_status_update webhook: one template's new state for the account with that WABA id
create or replace function public.wa_template_status(p_waba_id text, p_name text, p_status text)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
-- r129-0337
declare n int;
begin
  if coalesce(p_waba_id, '') !~ '^[0-9]{5,30}$' or coalesce(p_name, '') !~ '^[a-z0-9_]{1,64}$' or upper(coalesce(p_status, '')) !~ '^[A-Z_]{1,30}$' then
    return jsonb_build_object('result', 'ignored'); end if;
  update public.org_whatsapp_accounts
     set templates = public._r337_clean_templates(coalesce(templates, '{}'::jsonb) || jsonb_build_object(p_name, upper(p_status))), updated_at = now()
   where waba_id = p_waba_id and status in ('pending', 'connected', 'error') and coalesce(templates, '{}'::jsonb) ? p_name;
  get diagnostics n = row_count;
  return jsonb_build_object('result', case when n > 0 then 'recorded' else 'ignored' end);
end $$;

-- ---- 7) the studio admin disconnects: token out of the key store, number freed, row kept as a record ------------------------
create or replace function public.disconnect_org_whatsapp_account()
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
-- r129-0337
declare v_org uuid := public.current_org_id(); r public.org_whatsapp_accounts;
begin
  if auth.uid() is null or v_org is null or not coalesce(public.is_admin(), false) then
    raise exception 'not_allowed' using errcode = '42501'; end if;
  select * into r from public.org_whatsapp_accounts where org_id = v_org for update;
  if r.org_id is null then return jsonb_build_object('ok', true, 'status', 'none'); end if;
  if r.token_secret_id is not null and to_regclass('vault.secrets') is not null then
    execute 'delete from vault.secrets where id = $1' using r.token_secret_id;
  end if;
  update public.org_whatsapp_accounts
     set phone_number_id = null, token_secret_id = null, status = 'disabled', templates = null, templates_checked_at = null,
         last_error = null, quality = null, disconnected_at = now(), updated_by = auth.uid(), updated_at = now()
   where org_id = v_org;
  return jsonb_build_object('ok', true, 'status', 'disconnected');
end $$;

-- ---- 8) any member: is our studio's WhatsApp connected? (never an id or a token) -----------------------------------------
create or replace function public.studio_whatsapp_ready()
returns jsonb language plpgsql stable security definer set search_path = '' as $$
-- r129-0337
declare v_org uuid := public.current_org_id(); w public.org_whatsapp_accounts;
begin
  if auth.uid() is null or v_org is null then return jsonb_build_object('connected', false); end if;
  if not public._r337_wa_ready(v_org) then return jsonb_build_object('connected', false); end if;
  select * into w from public.org_whatsapp_accounts where org_id = v_org;
  return jsonb_build_object('connected', true, 'display_phone', w.display_phone, 'verified_name', w.verified_name);
end $$;

-- ---- 9) public_quote_ready(token) + "wa" ------------------------------------------------------------------------------------
do $$ begin
  if to_regprocedure('public.public_quote_ready__pre0337(uuid)') is null then
    alter function public.public_quote_ready(uuid) rename to public_quote_ready__pre0337; end if;
end $$;
create or replace function public.public_quote_ready(p_token uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
-- r129-0337: { priced, studio, wa } - wa = the link's studio has a connected WhatsApp number (never the number itself)
declare v jsonb; v_org uuid;
begin
  v := public.public_quote_ready__pre0337(p_token);
  if v is null then return null; end if;
  select q.org_id into v_org from public.quotes q where q.approval_token = p_token and q.deleted_at is null limit 1;
  return v || jsonb_build_object('wa', v_org is not null and public._r337_wa_ready(v_org));
end $$;

-- ---- 10) my_integration_accounts() + verified name, template states, disconnected --------------------------------------------
do $$ begin
  if to_regprocedure('public.my_integration_accounts__pre0337()') is null then
    alter function public.my_integration_accounts() rename to my_integration_accounts__pre0337; end if;
end $$;
create or replace function public.my_integration_accounts()
returns jsonb language plpgsql stable security definer set search_path = '' as $$
-- r129-0337: + whatsapp.verified_name / templates / templates_checked_at / disconnected_at (still admin only, still no secret)
declare v jsonb; w public.org_whatsapp_accounts; v_org uuid := public.current_org_id();
begin
  v := public.my_integration_accounts__pre0337();
  if v is null or coalesce((v ->> 'is_admin')::boolean, false) is not true or jsonb_typeof(v -> 'whatsapp') <> 'object' then return v; end if;
  select * into w from public.org_whatsapp_accounts where org_id = v_org;
  if w.org_id is null then return v; end if;
  return jsonb_set(v, '{whatsapp}', (v -> 'whatsapp') || jsonb_build_object('verified_name', w.verified_name, 'templates', w.templates,
    'templates_checked_at', w.templates_checked_at, 'disconnected_at', w.disconnected_at, 'ready', public._r337_wa_ready(v_org)));
end $$;

-- ---- 11) privileges -----------------------------------------------------------------------------------------------------
do $$ declare f text; begin
  foreach f in array array['public._r337_wa_ready(uuid)', 'public._r337_clean_templates(jsonb)', 'public.wa_connect_org()',
                           'public.org_whatsapp_check_creds(uuid)', 'public.wa_account_verified(uuid, boolean, text, text, text, text)',
                           'public.wa_templates_mark(uuid, jsonb)', 'public.wa_template_status(text, text, text)',
                           'public.disconnect_org_whatsapp_account()', 'public.studio_whatsapp_ready()',
                           'public.public_quote_ready(uuid)', 'public.my_integration_accounts()',
                           'public.public_quote_ready__pre0337(uuid)', 'public.my_integration_accounts__pre0337()'] loop
    execute 'revoke all on function ' || f || ' from public';
    if exists (select 1 from pg_roles where rolname = 'anon') then execute 'revoke all on function ' || f || ' from anon'; end if;
    if exists (select 1 from pg_roles where rolname = 'authenticated') then execute 'revoke all on function ' || f || ' from authenticated'; end if;
  end loop;
  if exists (select 1 from pg_roles where rolname = 'anon') then
    execute 'grant execute on function public.public_quote_ready(uuid) to anon'; end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    execute 'grant execute on function public.public_quote_ready(uuid) to authenticated';
    execute 'grant execute on function public.wa_connect_org() to authenticated';
    execute 'grant execute on function public.disconnect_org_whatsapp_account() to authenticated';
    execute 'grant execute on function public.studio_whatsapp_ready() to authenticated';
    execute 'grant execute on function public.my_integration_accounts() to authenticated'; end if;
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    foreach f in array array['public._r337_wa_ready(uuid)', 'public.org_whatsapp_check_creds(uuid)',
                             'public.wa_account_verified(uuid, boolean, text, text, text, text)', 'public.wa_templates_mark(uuid, jsonb)',
                             'public.wa_template_status(text, text, text)', 'public.public_quote_ready(uuid)', 'public.my_integration_accounts()'] loop
      execute 'grant execute on function ' || f || ' to service_role';
    end loop;
    foreach f in array array['public.public_quote_ready__pre0337(uuid)', 'public.my_integration_accounts__pre0337()'] loop
      execute 'revoke all on function ' || f || ' from service_role';
    end loop;
  end if;
end $$;
