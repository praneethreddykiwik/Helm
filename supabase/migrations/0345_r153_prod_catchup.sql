-- 0345_r153_prod_catchup.sql - R153 prod catch-up. Brings production in line with canonical for the gaps the
-- prod checker found and PROD-DIAG-1111 confirmed. Forward-only, additive, safe to run twice.
-- Every step is GUARDED and is a no-op where the protection is already there, also under another name.
-- Nothing dropped or deleted. No table, column or row is changed.
--   1  payment_milestones  trigger trg_no_overpayment_ms        (only if no trigger calls enforce_no_overpayment_ms)
--   2  event_tasks         trigger zz_work_token_renew          (only if no trigger calls tg_work_token_renew)
--   3  quotes + quote_otps 0012 approval link expiry + code send limit (functions only if missing, triggers only if none calls them)
--   4  set_discovery / set_event_plan / set_proposal get the 0011 has_area check (only if the live body has none)
--      old bodies kept as NAME__pre0345 with no privilege for anyone
--   5  return_reservation(uuid, numeric) created if missing (the teardown Return button calls it)
--   6  unique index inventory_items_org_name_uidx only when there are NO duplicate active names (else a notice)
--   7  zz_quote_org_match on wa_proposal_audit + wa_proposal_optins (only if no trigger calls tg_quote_org_match)
--   The pricing authority is NOT added again: quotes_enforce_pricing_total already runs enforce_pricing_total.
--   The trial purge cron job helm_trial_retention_purge is NOT added (owner decision, see APPLY-0345).
--   Text with dashes copied to the clipboard needs LANG=en_US.UTF-8 pbcopy.

do $$
begin
  if to_regclass('public.quotes') is null or to_regclass('public.payment_milestones') is null
     or to_regclass('public.event_tasks') is null or to_regclass('public.quote_otps') is null
     or to_regclass('public.inventory_items') is null then
    raise exception 'STOP 0345: a core table is missing - this is not a Helm database';
  end if;
  if to_regprocedure('public.has_area(text,text)') is null or to_regprocedure('public.can_edit()') is null
     or to_regprocedure('public.assert_quote_org(uuid)') is null or to_regprocedure('public.current_org_id()') is null then
    raise exception 'STOP 0345: has_area / can_edit / assert_quote_org / current_org_id missing - run the base + 0004 + 0011 first';
  end if;
end $$;

-- keeps a function body once as NAME__pre0345 (same arguments), callable by nobody
create or replace function public._r345_keep(p_fn text)
returns void language plpgsql volatile security definer set search_path = '' as $$
declare v_oid oid := to_regprocedure(p_fn); v_name text; v_types text; v_def text; v_pre text; r text;
begin
  if v_oid is null then return; end if;
  select p.proname, oidvectortypes(p.proargtypes) into v_name, v_types from pg_proc p where p.oid = v_oid;
  v_pre := format('public.%I(%s)', v_name || '__pre0345', v_types);
  if to_regprocedure(v_pre) is not null then return; end if;
  v_def := pg_get_functiondef(v_oid);
  v_def := regexp_replace(v_def, '^CREATE OR REPLACE FUNCTION public\.' || v_name || '\(',
                          'CREATE OR REPLACE FUNCTION public.' || v_name || '__pre0345(');
  if position(v_name || '__pre0345(' in v_def) = 0 then raise exception 'r153-0345: could not keep %', p_fn; end if;
  execute v_def;
  execute format('revoke all on function %s from public', v_pre);
  foreach r in array array['anon', 'authenticated', 'service_role'] loop
    if exists (select 1 from pg_roles where rolname = r) then execute format('revoke all on function %s from %I', v_pre, r); end if;
  end loop;
end $$;
revoke all on function public._r345_keep(text) from public;
do $$ declare r text; begin
  foreach r in array array['anon', 'authenticated'] loop
    if exists (select 1 from pg_roles where rolname = r) then execute format('revoke all on function public._r345_keep(text) from %I', r); end if;
  end loop;
end $$;

-- ---- 1) payment_milestones overpayment guard ------------------------------------------------------------------------
-- Same trigger as canonical (0003, body 0125). It checks only rows that are paid. A paid milestone can be changed only
-- by the payment functions (0027 guard), and a change that keeps a paid row on a quote that is ALREADY over its
-- invoice total is refused by this check, exactly as on staging. The count of such quotes is shown as a notice.
do $$
declare v_fn oid := to_regprocedure('public.enforce_no_overpayment_ms()'); v_n bigint;
begin
  if v_fn is null then raise notice '0345 item 1: enforce_no_overpayment_ms missing - skipped (run 0003 + 0125)'; return; end if;
  if exists (select 1 from pg_trigger t where t.tgrelid = 'public.payment_milestones'::regclass and not t.tgisinternal and t.tgfoid = v_fn) then
    return;   -- already protected (any name)
  end if;
  if exists (select 1 from pg_trigger t where t.tgrelid = 'public.payment_milestones'::regclass and t.tgname = 'trg_no_overpayment_ms') then
    raise notice '0345 item 1: a trigger trg_no_overpayment_ms with another function exists - left unchanged'; return;
  end if;
  if position('helm-0125-ms-no-double-count' in (select prosrc from pg_proc where oid = v_fn)) = 0 then
    raise notice '0345 item 1: enforce_no_overpayment_ms is not the 0125 body (it would count a payment twice) - trigger NOT added, run APPLY-0125 first';
    return;
  end if;
  if to_regprocedure('public.helm_invoice_total(uuid)') is null then
    raise notice '0345 item 1: helm_invoice_total missing - trigger NOT added'; return;
  end if;
  begin
    select count(*) into v_n from (
      select pm.quote_id, sum(coalesce(pm.amount, 0)) s from public.payment_milestones pm where pm.status = 'paid' group by pm.quote_id) x
      join public.quotes q on q.id = x.quote_id
     where coalesce((q.pricing ->> 'total')::numeric, 0) > 0 and x.s > public.helm_invoice_total(x.quote_id) + 0.5;
    if v_n > 0 then
      raise notice '0345 item 1: % quote(s) already have more paid milestones than the invoice total - nothing changed, but a later change that keeps such a row paid is refused (same as staging)', v_n;
    end if;
  exception when others then
    raise notice '0345 item 1: could not count already-overpaid quotes (%)', sqlerrm;
  end;
  create trigger trg_no_overpayment_ms before insert or update on public.payment_milestones
    for each row execute function public.enforce_no_overpayment_ms();
end $$;

-- ---- 2) a new task for a worker renews that worker link ------------------------------------------------------------
do $$
declare v_fn oid := to_regprocedure('public.tg_work_token_renew()');
begin
  if v_fn is null then raise notice '0345 item 2: tg_work_token_renew missing - skipped (run 0012 + 0022)'; return; end if;
  if exists (select 1 from pg_trigger t where t.tgrelid = 'public.event_tasks'::regclass and not t.tgisinternal and t.tgfoid = v_fn) then return; end if;
  if exists (select 1 from pg_trigger t where t.tgrelid = 'public.event_tasks'::regclass and t.tgname = 'zz_work_token_renew') then
    raise notice '0345 item 2: a trigger zz_work_token_renew with another function exists - left unchanged'; return;
  end if;
  create trigger zz_work_token_renew after insert on public.event_tasks
    for each row execute function public.tg_work_token_renew();
end $$;

-- ---- 3a) 0012 approval link expiry ------------------------------------------------------------------------------------
-- New links get an end date (30 days after issue or 30 days after the event, the later one). Links that already
-- exist keep their end date, also an empty one, until the link itself is changed. Still active in canonical
-- (0022 keeps it unchanged, 0039 age limits come on top of it).
do $do$
begin
  if (select count(*) from information_schema.columns where table_schema = 'public' and table_name = 'quotes'
       and column_name in ('approval_token', 'approval_token_expires_at', 'approval_token_revoked_at', 'approval_status', 'event_date')) <> 5 then
    raise notice '0345 item 3a: quotes is missing an approval link column - skipped'; return;
  end if;
  if to_regprocedure('public.tg_approval_token_expiry()') is null then
    execute $fn$
CREATE OR REPLACE FUNCTION public.tg_approval_token_expiry()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
declare v_floor timestamptz;
begin
  if new.approval_token is null or new.approval_token_revoked_at is not null then return new; end if;
  -- usable 30 days from issue, and until 30 days after the event (client portal)
  v_floor := greatest(now() + interval '30 days',
                      coalesce(new.event_date::timestamptz + interval '30 days', '-infinity'));
  if tg_op = 'INSERT' or new.approval_token is distinct from old.approval_token then
    if new.approval_token_expires_at is null then new.approval_token_expires_at := v_floor; end if;
  elsif new.approval_token_expires_at is null then
    new.approval_token_expires_at := old.approval_token_expires_at;      -- an expiry is never silently cleared
  elsif new.approval_token_expires_at > now()                             -- only a LIVE link is extended
    and ((new.approval_status is distinct from old.approval_status and new.approval_status in ('approved','paid'))
         or new.event_date is distinct from old.event_date) then
    new.approval_token_expires_at := greatest(new.approval_token_expires_at, v_floor);
  end if;
  return new;
end; $function$
$fn$;
    execute 'revoke all on function public.tg_approval_token_expiry() from public';
    if exists (select 1 from pg_roles where rolname = 'anon') then execute 'revoke all on function public.tg_approval_token_expiry() from anon'; end if;
    if exists (select 1 from pg_roles where rolname = 'authenticated') then execute 'revoke all on function public.tg_approval_token_expiry() from authenticated'; end if;
  end if;
  if exists (select 1 from pg_trigger t where t.tgrelid = 'public.quotes'::regclass and not t.tgisinternal
              and t.tgfoid = to_regprocedure('public.tg_approval_token_expiry()')) then return; end if;
  if exists (select 1 from pg_trigger t where t.tgrelid = 'public.quotes'::regclass and t.tgname = 'zz_approval_token_expiry') then
    raise notice '0345 item 3a: a trigger zz_approval_token_expiry with another function exists - left unchanged'; return;
  end if;
  create trigger zz_approval_token_expiry
    before insert or update of approval_token, approval_token_expires_at, approval_status, event_date
    on public.quotes for each row execute function public.tg_approval_token_expiry();
end $do$;

-- ---- 3b) 0012 approval code send limit (3 per number per hour, 10 per quote per day, serialized) -----------------------
-- Still active in canonical: the 0042 checks in otp_send_authorize run before the send and are not serialized, this
-- trigger is the race-proof limit at the moment the code row is written and also counts across quotes.
do $do$
begin
  if (select count(*) from information_schema.columns where table_schema = 'public' and table_name = 'quote_otps'
       and column_name in ('phone', 'quote_id', 'created_at')) <> 3 then
    raise notice '0345 item 3b: quote_otps is missing phone / quote_id / created_at - skipped'; return;
  end if;
  if to_regprocedure('public.tg_otp_rate_limit()') is null then
    execute $fn$
CREATE OR REPLACE FUNCTION public.tg_otp_rate_limit()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare v_digits text := regexp_replace(coalesce(new.phone,''), '[^0-9]', '', 'g'); n int;
begin
  -- Serialize per phone number, then per quote (fixed order → no deadlock).
  -- The lock is held to COMMIT, and each count below runs as a new statement,
  -- so under READ COMMITTED it sees every row committed by the previous holder.
  perform pg_advisory_xact_lock(hashtextextended('helm:otp:phone:' || v_digits, 0));
  perform pg_advisory_xact_lock(hashtextextended('helm:otp:quote:' || new.quote_id::text, 0));
  select count(*) into n from public.quote_otps
   where regexp_replace(coalesce(phone,''), '[^0-9]', '', 'g') = v_digits and created_at > now() - interval '1 hour';
  if n >= 3 then raise exception 'too many codes sent to this number — try again in an hour' using errcode = 'P0001'; end if;
  select count(*) into n from public.quote_otps where quote_id = new.quote_id and created_at > now() - interval '1 day';
  if n >= 10 then raise exception 'too many codes requested for this quote today' using errcode = 'P0001'; end if;
  return new;
end; $function$
$fn$;
    execute 'revoke all on function public.tg_otp_rate_limit() from public';
    if exists (select 1 from pg_roles where rolname = 'anon') then execute 'revoke all on function public.tg_otp_rate_limit() from anon'; end if;
    if exists (select 1 from pg_roles where rolname = 'authenticated') then execute 'revoke all on function public.tg_otp_rate_limit() from authenticated'; end if;
  end if;
  if exists (select 1 from pg_trigger t where t.tgrelid = 'public.quote_otps'::regclass and not t.tgisinternal
              and t.tgfoid = to_regprocedure('public.tg_otp_rate_limit()')) then return; end if;
  if exists (select 1 from pg_trigger t where t.tgrelid = 'public.quote_otps'::regclass and t.tgname = 'zz_otp_rate_limit') then
    raise notice '0345 item 3b: a trigger zz_otp_rate_limit with another function exists - left unchanged'; return;
  end if;
  create trigger zz_otp_rate_limit before insert on public.quote_otps
    for each row execute function public.tg_otp_rate_limit();
end $do$;

-- ---- 4) 0011 area checks on the Discovery / Plan / Proposal saves -------------------------------------------------------
-- Replaced only when the live body has no has_area check. The previous body is kept as NAME__pre0345 (no privilege).
-- Grants as canonical: authenticated + service_role may call, public / anon may not.
do $do$
declare v_sig text; v_src text; r text;
begin
  foreach v_sig in array array[
      'public.set_discovery(uuid,date,text,text,text,text,numeric,numeric)',
      'public.set_event_plan(uuid,text,text,text,text,text,text)',
      'public.set_proposal(uuid,text,text,jsonb,jsonb,jsonb)'] loop
    if to_regprocedure(v_sig) is null then
      raise notice '0345 item 4: % not found with this exact signature - skipped', v_sig; continue;
    end if;
    select p.prosrc into v_src from pg_proc p where p.oid = to_regprocedure(v_sig);
    if position('has_area' in v_src) > 0 then continue; end if;   -- already guarded
    perform public._r345_keep(v_sig);
    if v_sig like 'public.set_discovery(%' then
      execute $fn$
CREATE OR REPLACE FUNCTION public.set_discovery(p_quote_id uuid, p_meet_date date, p_mode text, p_location text, p_attendees text, p_notes text, p_budget_min numeric, p_budget_max numeric)
 RETURNS event_discovery
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare d public.event_discovery;
begin
  if not public.can_edit() then raise exception 'not authorized to edit' using errcode='42501'; end if;
  if not (public.has_area('quotes','edit') or public.has_area('discovery','edit')) then raise exception 'not authorized' using errcode='42501'; end if;  -- 0011 F10
  perform public.assert_quote_org(p_quote_id);
  insert into public.event_discovery
    (quote_id, meet_date, mode, location, attendees, notes, budget_min, budget_max, updated_at, updated_by)
  values
    (p_quote_id, p_meet_date, p_mode, p_location, p_attendees, p_notes, p_budget_min, p_budget_max, now(), auth.uid())
  on conflict (quote_id) do update set
    meet_date=excluded.meet_date, mode=excluded.mode, location=excluded.location,
    attendees=excluded.attendees, notes=excluded.notes,
    budget_min=excluded.budget_min, budget_max=excluded.budget_max,
    updated_at=now(), updated_by=auth.uid()
  returning * into d;
  return d;
end; $function$
$fn$;
    elsif v_sig like 'public.set_event_plan(%' then
      execute $fn$
CREATE OR REPLACE FUNCTION public.set_event_plan(p_quote_id uuid, p_venue_name text, p_venue_address text, p_venue_contact text, p_access_notes text, p_package text, p_menu text)
 RETURNS event_plan
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare r public.event_plan;
begin
  if not public.can_edit() then raise exception 'not authorized to edit' using errcode='42501'; end if;
  if not (public.has_area('quotes','edit') or public.has_area('plan','edit')) then raise exception 'not authorized' using errcode='42501'; end if;  -- 0011 F10
  perform public.assert_quote_org(p_quote_id);
  insert into public.event_plan (quote_id, venue_name, venue_address, venue_contact, access_notes, package, menu, updated_at, updated_by)
  values (p_quote_id, p_venue_name, p_venue_address, p_venue_contact, p_access_notes, p_package, p_menu, now(), auth.uid())
  on conflict (quote_id) do update set
    venue_name=excluded.venue_name, venue_address=excluded.venue_address, venue_contact=excluded.venue_contact,
    access_notes=excluded.access_notes, package=excluded.package, menu=excluded.menu,
    updated_at=now(), updated_by=auth.uid()
  returning * into r;
  return r;
end; $function$
$fn$;
    else
      execute $fn$
CREATE OR REPLACE FUNCTION public.set_proposal(p_quote_id uuid, p_concept text, p_theme text, p_palette jsonb, p_images jsonb, p_scope jsonb)
 RETURNS event_proposal
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare pr public.event_proposal;
begin
  if not public.can_edit() then raise exception 'not authorized to edit' using errcode='42501'; end if;
  if not (public.has_area('quotes','edit') or public.has_area('proposal','edit')) then raise exception 'not authorized' using errcode='42501'; end if;  -- 0011 F10
  perform public.assert_quote_org(p_quote_id);
  insert into public.event_proposal (quote_id, concept, theme, palette, images, scope, updated_at, updated_by)
  values (p_quote_id, p_concept, p_theme,
          coalesce(p_palette,'[]'::jsonb), coalesce(p_images,'[]'::jsonb), coalesce(p_scope,'[]'::jsonb),
          now(), auth.uid())
  on conflict (quote_id) do update set
    concept=excluded.concept, theme=excluded.theme, palette=excluded.palette,
    images=excluded.images, scope=excluded.scope, updated_at=now(), updated_by=auth.uid()
  returning * into pr;
  return pr;
end; $function$
$fn$;
    end if;
    execute format('revoke all on function %s from public', v_sig);
    if exists (select 1 from pg_roles where rolname = 'anon') then execute format('revoke all on function %s from anon', v_sig); end if;
    foreach r in array array['authenticated', 'service_role'] loop
      if exists (select 1 from pg_roles where rolname = r) then execute format('grant execute on function %s to %I', v_sig, r); end if;
    end loop;
  end loop;
end $do$;

-- ---- 5) return_reservation (teardown Return in ONE step: mark returned + write off damaged stock) ----------------------
-- The app calls it and falls back to two separate calls when it is missing. Created only if missing.
do $do$
declare r text;
begin
  if exists (select 1 from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname = 'return_reservation') then
    if to_regprocedure('public.return_reservation(uuid,numeric)') is null then
      raise notice '0345 item 5: a return_reservation with other arguments exists - left unchanged';
    end if;
    return;
  end if;
  if to_regclass('public.inventory_reservations') is null
     or (select count(*) from information_schema.columns where table_schema = 'public' and table_name = 'inventory_reservations'
          and column_name in ('id', 'org_id', 'item_id', 'qty', 'status')) <> 5 then
    raise notice '0345 item 5: inventory_reservations not in the expected shape - skipped'; return;
  end if;
  execute $fn$
CREATE OR REPLACE FUNCTION public.return_reservation(p_reservation_id uuid, p_damaged numeric DEFAULT 0)
 RETURNS inventory_reservations
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_org uuid := public.current_org_id();
  v_res public.inventory_reservations;
  v_dmg numeric := coalesce(p_damaged, 0);
begin
  if not public.has_area('inventory','edit') then
    raise exception 'not authorized' using errcode = '42501'; end if;
  if v_org is null then
    raise exception 'no organization context' using errcode = '42501'; end if;

  -- lock the row so two concurrent returns serialize, the second sees status returned
  select * into v_res from public.inventory_reservations
   where id = p_reservation_id and org_id = v_org
   for update;
  if not found then raise exception 'reservation not found' using errcode = '42501'; end if;

  if v_res.status not in ('reserved','allocated') then
    raise exception 'reservation is already %', v_res.status using errcode = '22023'; end if;
  if v_dmg < 0 or v_dmg > v_res.qty then
    raise exception 'damaged quantity must be between 0 and %', v_res.qty using errcode = '22023'; end if;

  update public.inventory_reservations
     set status = 'returned'
   where id = v_res.id and org_id = v_org
  returning * into v_res;

  if v_dmg > 0 then
    update public.inventory_items
       set total_qty = greatest(0, coalesce(total_qty,0) - v_dmg)
     where id = v_res.item_id and org_id = v_org;
    if not found then raise exception 'item not found' using errcode = '42501'; end if;  -- rolls back the status change
  end if;

  return v_res;
end; $function$
$fn$;
  execute 'revoke all on function public.return_reservation(uuid, numeric) from public';
  if exists (select 1 from pg_roles where rolname = 'anon') then execute 'revoke all on function public.return_reservation(uuid, numeric) from anon'; end if;
  foreach r in array array['authenticated', 'service_role'] loop
    if exists (select 1 from pg_roles where rolname = r) then execute format('grant execute on function public.return_reservation(uuid, numeric) to %I', r); end if;
  end loop;
end $do$;

-- ---- 6) one active inventory item per name per studio (0073 rule) --------------------------------------------------------
-- Created ONLY when the data is already clean. Otherwise a notice with the count, and no row is touched.
do $$
declare v_n bigint;
begin
  if to_regclass('public.inventory_items_org_name_uidx') is not null then return; end if;
  if exists (select 1 from pg_index x join pg_class i on i.oid = x.indexrelid
              where x.indrelid = 'public.inventory_items'::regclass and x.indisunique
                and pg_get_indexdef(x.indexrelid) ~* 'lower\(btrim\(.*name') then
    raise notice '0345 item 6: a unique name index already exists on inventory_items under another name - not added again'; return;
  end if;
  select count(*) into v_n from (select 1 from public.inventory_items where active
    group by org_id, lower(btrim(name)) having count(*) > 1) d;
  if v_n = 0 then
    execute 'create unique index inventory_items_org_name_uidx on public.inventory_items (org_id, lower(btrim(name))) where active';
  else
    raise notice '0345 item 6: inventory_items_org_name_uidx SKIPPED - % duplicate active name group(s), nothing changed. Rename or deactivate the extras in the app, then run APPLY-0345 again', v_n;
  end if;
end $$;

-- ---- 7) cross-studio guard on the 2 WhatsApp proposal tables (0172) ------------------------------------------------------
-- BEFORE INSERT OR UPDATE. The append-only trigger already refuses every UPDATE / DELETE, so in practice this checks
-- new rows only. It never changes a row, it only refuses a row whose studio is not the studio of its quote.
do $$
declare v_t text; v_fn oid := to_regprocedure('public.tg_quote_org_match()');
begin
  if v_fn is null then raise notice '0345 item 7: tg_quote_org_match missing - skipped (run 0004)'; return; end if;
  foreach v_t in array array['wa_proposal_audit', 'wa_proposal_optins'] loop
    if to_regclass('public.' || v_t) is null then continue; end if;
    if (select count(*) from information_schema.columns where table_schema = 'public' and table_name = v_t
         and column_name in ('quote_id', 'org_id')) <> 2 then continue; end if;
    if exists (select 1 from pg_trigger t where t.tgrelid = to_regclass('public.' || v_t) and not t.tgisinternal and t.tgfoid = v_fn) then continue; end if;
    if exists (select 1 from pg_trigger t where t.tgrelid = to_regclass('public.' || v_t) and t.tgname = 'zz_quote_org_match') then
      raise notice '0345 item 7: % has a zz_quote_org_match trigger with another function - left unchanged', v_t; continue;
    end if;
    execute format('create trigger zz_quote_org_match before insert or update on public.%I for each row execute function public.tg_quote_org_match()', v_t);
  end loop;
end $$;
