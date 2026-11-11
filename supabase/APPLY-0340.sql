-- APPLY-0340.sql - paste into the Supabase SQL editor (STAGING first; production when the owner says go).
-- It stops with "STOP 0340: ..." if a migration it builds on is missing (0164 and 0199 must be applied first).
-- R136: clearer audit log.
--   WHAT PEOPLE WILL NOTICE: in Settings > Audit log, a lead that Helm creates or updates by itself when a quote is saved
--   now shows Who = "Helm (automatic)", with "from quote ... after <person> saved it" underneath.
--   Nothing is dropped or deleted. Existing audit rows are not changed. Safe to run twice.
begin;
-- 0340_r136_audit_via.sql - CANONICAL forward-only. R136 (owner, 11 Nov 2026: "make the audit log clear").
-- REQUIRES 0164 (tg_audit body with the sys-quiet-0164 marker, _audit_redact, _is_system_change),
--          0199 (sync_quote_to_lead body with the budget / guests single-source marker).
--
-- In plain words:
--   When a quote is saved, Helm itself creates or updates the matching CRM lead (sync_quote_to_lead, the
--   quotes_sync_lead_ins / quotes_sync_lead_upd triggers). The audit log wrote that lead change under the
--   person who saved the quote, so it read like the person had edited the lead by hand.
--   From now on:
--     1  sync_quote_to_lead() sets a marker for the length of its OWN lead write only
--        (set_config('helm.audit_via', 'quote_sync', true) + the quote id in 'helm.audit_via_quote'), and puts the
--        previous value back straight after. Everything else in the function is exactly the 0199 body.
--     2  tg_audit() copies that marker into the new audit row: changed->'_via' = 'quote_sync' and
--        changed->'_via_quote' = the quote id. The audit page then shows Who = "Helm (automatic)" with
--        "from quote ... after <person> saved it". The actor (the person) is kept, so nothing is lost.
--        Everything else in tg_audit is exactly the 0164 body (secrets redacted, maintenance tag, studio id).
--   Values for the quote's client details were already stored (old + new) by tg_audit; nothing changes there.
--   The audit page shows values only for non-sensitive client fields (phone / e-mail / address stay names-only).
--
-- ZERO DATA LOSS: additive + idempotent. No table, column, row, policy or grant is changed or removed; existing
-- audit rows are never touched. The two functions keep their signatures and triggers; each previous body is kept
-- once as <name>__pre0340 (no app privilege) for a rollback. A function whose live body is not the known one is
-- left unchanged (notice). Safe to run twice.

-- ---- 0) preflight ----------------------------------------------------------------------------------------------
do $$
begin
  if to_regprocedure('public.tg_audit()') is null then raise exception 'STOP 0340: public.tg_audit() missing (0164)'; end if;
  if to_regprocedure('public._audit_redact(jsonb,boolean)') is null or to_regprocedure('public._is_system_change()') is null then
    raise exception 'STOP 0340: _audit_redact / _is_system_change missing - run 0164 first'; end if;
  if to_regprocedure('public.sync_quote_to_lead()') is null or to_regprocedure('public._b199_amount(text)') is null then
    raise exception 'STOP 0340: sync_quote_to_lead / _b199_amount missing - run 0199 first'; end if;
end $$;

-- ---- 1) keep a function's current body once as <name>__pre0340 (no API privilege) --------------------------------
create or replace function public._r340_keep(p_fn text)
returns void language plpgsql volatile security definer set search_path = '' as $$
-- r136-0340: copy (never rename - triggers stay bound to the live function) the current body once
declare v_oid oid := to_regprocedure(p_fn); v_name text; v_types text; v_def text; v_pre text;
begin
  if v_oid is null then return; end if;
  select p.proname, oidvectortypes(p.proargtypes) into v_name, v_types from pg_proc p where p.oid = v_oid;
  v_pre := format('public.%I(%s)', v_name || '__pre0340', v_types);
  if to_regprocedure(v_pre) is not null then return; end if;
  v_def := pg_get_functiondef(v_oid);
  v_def := regexp_replace(v_def, '^CREATE OR REPLACE FUNCTION public\.' || v_name || '\(',
                          'CREATE OR REPLACE FUNCTION public.' || v_name || '__pre0340(');
  if position(v_name || '__pre0340(' in v_def) = 0 then raise exception 'r136-0340: could not keep %', p_fn; end if;
  execute v_def;
  execute format('revoke all on function %s from public', v_pre);
  if exists (select 1 from pg_roles where rolname = 'anon') then execute format('revoke all on function %s from anon', v_pre); end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then execute format('revoke all on function %s from authenticated', v_pre); end if;
end $$;
revoke all on function public._r340_keep(text) from public;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'anon') then revoke all on function public._r340_keep(text) from anon; end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then revoke all on function public._r340_keep(text) from authenticated; end if;
end $$;

-- ---- 2) sync_quote_to_lead: the 0199 body + the "made by Helm from this quote" marker around its lead write ------
do $do$ declare v_src text; begin
  select p.prosrc into v_src from pg_proc p where p.oid = to_regprocedure('public.sync_quote_to_lead()');
  if position('0199: the quote is the single source' in v_src) = 0 and position('audit-via-0340' in v_src) = 0 then
    raise notice '0340: sync_quote_to_lead on this database is not the known 0199 body - left unchanged';
    return;
  end if;
  perform public._r340_keep('public.sync_quote_to_lead()');
  execute $fn$
create or replace function public.sync_quote_to_lead()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
-- audit-via-0340: the lead write below is marked so its audit row reads "Helm (automatic), from this quote"
declare
  v_name  text := nullif(btrim(NEW.client->>'name'), '');
  v_email text := nullif(btrim(NEW.client->>'email'), '');
  v_phone text := nullif(btrim(NEW.client->>'phone'), '');
  -- 0199: the quote is the single source of the event's budget + guests
  v_budget numeric := public._b199_amount(NEW.client->>'budget');
  v_guests integer := public._b199_guests(NEW.client->>'guests');
  v_bchg boolean := true;
  v_gchg boolean := true;
  v_status text;
  v_lead public.leads;
  v_via0 text := coalesce(current_setting('helm.audit_via', true), '');
  v_viaq0 text := coalesce(current_setting('helm.audit_via_quote', true), '');
begin
  if v_name is null then return NEW; end if;
  if TG_OP = 'UPDATE' then
    v_bchg := (OLD.client->>'budget') is distinct from (NEW.client->>'budget');
    v_gchg := (OLD.client->>'guests') is distinct from (NEW.client->>'guests');
  end if;
  v_status := case
    when NEW.status = 'cancelled'                          then 'lost'
    when NEW.approval_status = 'paid'
      or NEW.status = 'confirmed'
      or NEW.lifecycle_stage in ('planning','event','settlement','closed') then 'won'
    when NEW.lifecycle_stage = 'discovery'                 then 'discovery'
    else 'quoted' end;
  select * into v_lead from public.leads where quote_id = NEW.id and org_id = NEW.org_id limit 1;
  if v_lead.id is null then
    select * into v_lead from public.leads
     where org_id = NEW.org_id and quote_id is null
       and ( (v_email is not null and lower(coalesce(email,'')) = lower(v_email))
          or (v_email is null and lower(coalesce(name,'')) = lower(v_name)) )
     order by updated_at desc limit 1;
  end if;
  -- audit-via-0340: only this function's own lead write carries the marker (transaction-local, put back below)
  perform set_config('helm.audit_via', 'quote_sync', true);
  perform set_config('helm.audit_via_quote', NEW.id::text, true);
  if v_lead.id is not null then
    update public.leads set
      name       = v_name,
      email      = coalesce(v_email, email),
      phone      = coalesce(v_phone, phone),
      event_type = coalesce(NEW.event_type, event_type),
      event_date = coalesce(NEW.event_date, event_date),
      -- 0199: only when the quote's budget / guests were set or changed; a cleared value keeps the lead's
      budget      = case when v_bchg and v_budget is not null then v_budget else budget end,
      guest_count = case when v_gchg and v_guests is not null then v_guests else guest_count end,
      status     = case when status in ('won','lost') and v_status in ('quoted','discovery')
                        then status else v_status end,
      quote_id   = NEW.id,
      updated_at = now()
     where id = v_lead.id;
  else
    insert into public.leads (org_id, name, phone, email, source, event_type, event_date, budget, guest_count, status, quote_id)
      values (NEW.org_id, v_name, v_phone, v_email, 'quote', NEW.event_type, NEW.event_date, v_budget, v_guests, v_status, NEW.id);
  end if;
  perform set_config('helm.audit_via', v_via0, true);
  perform set_config('helm.audit_via_quote', v_viaq0, true);
  return NEW;
end; $function$
$fn$;
end $do$;

-- ---- 3) tg_audit: the 0164 body + the marker copied into the row ----------------------------------------------
do $do$ declare v_src text; begin
  select p.prosrc into v_src from pg_proc p where p.oid = to_regprocedure('public.tg_audit()');
  if position('sys-quiet-0164' in v_src) = 0 and position('audit-via-0340' in v_src) = 0 then
    raise notice '0340: tg_audit on this database is not the known 0164 body - left unchanged';
    return;
  end if;
  perform public._r340_keep('public.tg_audit()');
  execute $fn$
create or replace function public.tg_audit()
returns trigger language plpgsql security definer set search_path = 'public' as $body$
-- audit-via-0340: the 0164 body (row carries the studio; role_access role + area; link secrets redacted; direct-DB
--   changes tagged 'helm:maintenance') + a change Helm made by itself on a person's behalf carries _via / _via_quote
declare
  v_actor uuid := auth.uid();
  v_email text;
  v_id text;
  v_quote uuid;
  v_changed jsonb;
  v_org uuid;
  v_via text := nullif(current_setting('helm.audit_via', true), '');
  v_via_q text := nullif(current_setting('helm.audit_via_quote', true), '');
  o jsonb; n jsonb;
begin
  if v_actor is not null then select email into v_email from auth.users where id = v_actor;
  elsif public._is_system_change() then v_email := 'helm:maintenance';
  end if;
  if tg_op = 'DELETE' then n := to_jsonb(OLD); else n := to_jsonb(NEW); end if;
  if tg_op = 'UPDATE' then o := to_jsonb(OLD); end if;

  v_id := coalesce(n->>'id', n->>'quote_id');
  if tg_table_name = 'role_access' then v_id := coalesce(n->>'role', '') || ':' || coalesce(n->>'area', ''); end if;
  if tg_table_name = 'quotes' then v_quote := (n->>'id')::uuid;
  elsif n ? 'quote_id' then v_quote := nullif(n->>'quote_id','')::uuid;
  end if;

  if tg_op = 'UPDATE' then
    select jsonb_object_agg(key, jsonb_build_array(o->key, n->key))
      into v_changed
      from jsonb_object_keys(n) as key
      where (o->key) is distinct from (n->key)
        and key not in ('updated_at','confirmed_at');
    if v_changed is null then return null; end if;
    if tg_table_name = 'role_access' then
      v_changed := v_changed || jsonb_build_object('role', n->'role', 'area', n->'area');
    end if;
    v_changed := public._audit_redact(v_changed, true);
  else
    v_changed := public._audit_redact(n, false);
  end if;

  -- audit-via-0340: made by Helm itself (e.g. the lead kept in step with a saved quote) - the person stays the actor
  if v_via is not null and v_via ~ '^[a-z_]{1,40}$' then
    v_changed := coalesce(v_changed, '{}'::jsonb) || jsonb_build_object('_via', v_via)
      || case when coalesce(v_via_q, '') ~ '^[0-9a-fA-F-]{36}$' then jsonb_build_object('_via_quote', v_via_q) else '{}'::jsonb end;
  end if;

  if tg_table_name = 'organizations' and coalesce(n->>'id','') ~ '^[0-9a-fA-F-]{36}$' then
    v_org := (n->>'id')::uuid;
  elsif coalesce(n->>'org_id','') ~ '^[0-9a-fA-F-]{36}$' then
    v_org := (n->>'org_id')::uuid;
  end if;
  if v_org is null and v_quote is not null then
    select q.org_id into v_org from public.quotes q where q.id = v_quote;
  end if;
  v_org := coalesce(v_org, public.current_org_id());

  insert into public.audit_log(actor, actor_email, action, entity, entity_id, quote_id, changed, org_id)
    values (v_actor, v_email, lower(tg_op), tg_table_name, v_id, v_quote, v_changed, v_org);
  return null;
end $body$
$fn$;
end $do$;
commit;

-- VERIFY (every line should say true)
select item, ok from (values
  ('01 sync_quote_to_lead marks its lead write', position('audit-via-0340' in (select prosrc from pg_proc where oid = to_regprocedure('public.sync_quote_to_lead()'))) > 0),
  ('02 tg_audit copies the marker into the row', position('audit-via-0340' in (select prosrc from pg_proc where oid = to_regprocedure('public.tg_audit()'))) > 0),
  ('03 previous bodies kept, not callable by the app', to_regprocedure('public.tg_audit__pre0340()') is not null and to_regprocedure('public.sync_quote_to_lead__pre0340()') is not null
     and not has_function_privilege('authenticated', 'public.tg_audit__pre0340()', 'execute') and not has_function_privilege('anon', 'public.sync_quote_to_lead__pre0340()', 'execute')),
  ('04 quote -> lead sync triggers still on', (select count(*) from pg_trigger where tgrelid = 'public.quotes'::regclass and tgname in ('quotes_sync_lead_ins', 'quotes_sync_lead_upd') and tgenabled = 'O') = 2),
  ('05 leads + quotes still audited', (select count(*) from pg_trigger where tgname = 'audit_trg' and tgrelid in ('public.quotes'::regclass, 'public.leads'::regclass)) = 2)
) v(item, ok);
