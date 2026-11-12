-- 0358_r163_catalog_tz_speed.sql - R163 notification catalog + studio time zone speed fix. Forward-only, additive, safe to run twice.
-- REQUIRES 0329 + 0354 (notification_catalog layers) and 0266 (_r23_tz).
--
-- In plain words (prod pg_stat_statements, 12 Nov, after the R152..R162 release):
--   1  notification_catalog() is the list of notification types. It is asked again and again inside one request: once per
--      type and role in admin_get_notification_prefs (about 1,150 times - 1.6 s on prod), about 100 times in
--      my_notification_prefs (every page, 197 ms on prod), and by every notification insert. Its 0329 and 0354 layers are
--      SQL that name the layer below twice, so each call rebuilt the lower layers 3 x 3 = 9 times - 0354 (today) made every
--      catalog read 3 times slower again. Now the top layer reads the layer below ONCE and keeps the answer for the rest of
--      the request (a transaction-local setting): the same list, built once per request.
--   2  _r23_tz(studio) (the studio time zone, else India) checked the name against pg_timezone_names, which reads every
--      time zone file on each call (509 ms on prod, 1,257 calls - task reminders every minute, inbox, snooze, timesheets).
--      Now a valid name is checked against a small copy of that list (_r358_tz_names, filled here) and by using it once;
--      a name not in the copy still goes through the old pg_timezone_names check, so the answer is the same.
--
-- ZERO DATA LOSS: two read-only functions re-issued in place (same names, arguments, answers, IMMUTABLE / STABLE,
-- SECURITY DEFINER, empty search_path, grants); old bodies kept once as notification_catalog__pre0358 / _r23_tz__pre0358
-- with no app privilege. One NEW table _r358_tz_names (time zone names only, row security on, no app privilege).
-- A body that is not the known one is left unchanged (NOTICE). Nothing dropped or deleted.
-- Notes: supabase/migrations/MANIFEST entry 0358.

-- ---- 0) preflight ---------------------------------------------------------------------------------------------------
do $$
begin
  if to_regprocedure('public.notification_catalog()') is null or to_regprocedure('public.notification_catalog__pre0354()') is null
     or to_regprocedure('public.notification_catalog__pre0329()') is null then
    raise exception 'STOP 0358: notification catalog layers 0329 / 0354 missing - run 0329 + 0354 first'; end if;
  if to_regprocedure('public._r23_tz(uuid)') is null or to_regclass('public.organizations') is null then
    raise exception 'STOP 0358: _r23_tz (0266) missing - run 0266 first'; end if;
end $$;

-- ---- 1) the time zone names copy -------------------------------------------------------------------------------------
create table if not exists public._r358_tz_names (name text primary key);
alter table public._r358_tz_names enable row level security;
do $$ declare r text; begin
  execute 'revoke all on table public._r358_tz_names from public';
  foreach r in array array['anon', 'authenticated', 'service_role'] loop
    if exists (select 1 from pg_roles where rolname = r) then execute format('revoke all on table public._r358_tz_names from %I', r); end if;
  end loop;
end $$;
insert into public._r358_tz_names(name) select distinct z.name from pg_catalog.pg_timezone_names z on conflict (name) do nothing;

-- ---- 2) keep the old bodies once -------------------------------------------------------------------------------------
do $$
declare v_src text;
begin
  select p.prosrc into v_src from pg_proc p where p.oid = to_regprocedure('public.notification_catalog()');
  if position('r163-0358' in v_src) = 0 then
    if position('r156-0354: + wa_templates (once)' in v_src) > 0 and position('notification_catalog__pre0354()' in v_src) > 0
       and position('r121-0329: + plan_active (once)' in coalesce((select p.prosrc from pg_proc p where p.oid = to_regprocedure('public.notification_catalog__pre0354()')), '')) > 0
       and to_regprocedure('public.notification_catalog__pre0358()') is null then
      alter function public.notification_catalog() rename to notification_catalog__pre0358;
    elsif to_regprocedure('public.notification_catalog__pre0358()') is null then
      raise notice '0358: notification_catalog is not the known 0354 body on this database - left unchanged';
    end if;
  end if;
  select p.prosrc into v_src from pg_proc p where p.oid = to_regprocedure('public._r23_tz(uuid)');
  if position('r163-0358' in v_src) = 0 then
    if position('r23-inbox-0266' in v_src) > 0 and position('pg_timezone_names' in v_src) > 0
       and to_regprocedure('public._r23_tz__pre0358(uuid)') is null then
      alter function public._r23_tz(uuid) rename to _r23_tz__pre0358;
    elsif to_regprocedure('public._r23_tz__pre0358(uuid)') is null then
      raise notice '0358: _r23_tz is not the known 0266 body on this database - left unchanged';
    end if;
  end if;
end $$;

-- ---- 3) notification_catalog: the 0329 + 0354 layers applied once, the answer kept for the request ------------------------
do $do$
begin
  -- create when renamed above; re-issue when the live body is again the known old one (its old body is already kept)
  if to_regprocedure('public.notification_catalog()') is not null and (position('r163-0358' in coalesce((select p.prosrc from pg_proc p where p.oid = to_regprocedure('public.notification_catalog()')), '')) > 0
     or position('r156-0354: + wa_templates (once)' in coalesce((select p.prosrc from pg_proc p where p.oid = to_regprocedure('public.notification_catalog()')), '')) = 0) then return; end if;
  execute $fn$
create or replace function public.notification_catalog()
returns jsonb language plpgsql immutable security definer set search_path = '' as $$
-- r156-0354: + wa_templates (once) / r121-0329: + plan_active (once)
-- r163-0358: the layer below (0285 ...) read ONCE (the 0329 + 0354 SQL layers named it twice each = 9 reads per call) and the
-- finished list kept for the rest of this request in the transaction-local setting helm.r358_cat (same list every time)
declare v text := current_setting('helm.r358_cat', true); c jsonb;
begin
  if coalesce(v, '') <> '' then return v::jsonb; end if;
  c := public.notification_catalog__pre0329();
  if not exists (select 1 from jsonb_array_elements(c) e where e ->> 'type' = 'plan_active') then
    c := c || $cat$[
    {"type":"plan_active","group":"Billing","label":"Plan active",
     "description":"Helm made your paid plan active (plan, billing, next renewal). Admins only by default.",
     "audience":"studio","channels":["in_app"],"required":[],"gated":[],"money":false}
  ]$cat$::jsonb;
  end if;
  if not exists (select 1 from jsonb_array_elements(c) e where e ->> 'type' = 'wa_templates') then
    c := c || $cat$[
    {"type":"wa_templates","group":"Studio","label":"WhatsApp templates",
     "description":"Meta finished reviewing the WhatsApp message templates (all approved, or which ones were rejected and why), a template category changed, or the number health dropped. Admins only by default.",
     "audience":"studio","channels":["in_app"],"required":[],"gated":[],"money":false}
  ]$cat$::jsonb;
  end if;
  perform pg_catalog.set_config('helm.r358_cat', c::text, true);
  return c;
end $$
  $fn$;
end $do$;

-- ---- 4) _r23_tz: a known valid name without reading every time zone file ---------------------------------------------------
do $do$
begin
  -- create when renamed above; re-issue when the live body is again the known old one (its old body is already kept)
  if to_regprocedure('public._r23_tz(uuid)') is not null and (position('r163-0358' in coalesce((select p.prosrc from pg_proc p where p.oid = to_regprocedure('public._r23_tz(uuid)')), '')) > 0
     or position('r23-inbox-0266' in coalesce((select p.prosrc from pg_proc p where p.oid = to_regprocedure('public._r23_tz(uuid)')), '')) = 0) then return; end if;
  execute $fn$
create or replace function public._r23_tz(p_org uuid)
returns text language plpgsql stable security definer set search_path = '' as $$
-- r23-inbox-0266: the studio time zone when Postgres knows it, else India
-- r163-0358: a name in the _r358_tz_names copy of pg_timezone_names that Postgres can use = that name (no time zone file
-- read); anything else goes through the 0266 pg_timezone_names check exactly as before
declare v text;
begin
  select o.timezone into v from public.organizations o where o.id = p_org;
  if v is null then return 'Asia/Kolkata'; end if;
  if exists (select 1 from public._r358_tz_names t where t.name = v) then
    begin
      perform now() at time zone v;
      return v;
    exception when others then null;
    end;
  end if;
  return coalesce((select o.timezone from public.organizations o
                    where o.id = p_org and exists (select 1 from pg_catalog.pg_timezone_names z where z.name = o.timezone)), 'Asia/Kolkata');
end $$
  $fn$;
end $do$;

-- ---- 5) privileges - exactly as before, the kept bodies for nobody ----------------------------------------------------------
do $$ declare f text; r text; begin
  foreach f in array array['public.notification_catalog__pre0358()', 'public._r23_tz__pre0358(uuid)', 'public._r23_tz(uuid)'] loop
    continue when to_regprocedure(f) is null;
    execute 'revoke all on function ' || f || ' from public';
    foreach r in array array['anon', 'authenticated'] loop
      if exists (select 1 from pg_roles where rolname = r) then execute format('revoke all on function %s from %I', f, r); end if;
    end loop;
  end loop;
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    foreach f in array array['public.notification_catalog__pre0358()', 'public._r23_tz__pre0358(uuid)'] loop
      continue when to_regprocedure(f) is null;
      execute 'revoke all on function ' || f || ' from service_role';
    end loop;
    if to_regprocedure('public._r23_tz(uuid)') is not null then execute 'grant execute on function public._r23_tz(uuid) to service_role'; end if;
  end if;
  if to_regprocedure('public.notification_catalog()') is not null then
    execute 'revoke all on function public.notification_catalog() from public';
    if exists (select 1 from pg_roles where rolname = 'anon') then execute 'revoke all on function public.notification_catalog() from anon'; end if;
    if exists (select 1 from pg_roles where rolname = 'authenticated') then execute 'grant execute on function public.notification_catalog() to authenticated'; end if;
    if exists (select 1 from pg_roles where rolname = 'service_role') then execute 'grant execute on function public.notification_catalog() to service_role'; end if;
  end if;
end $$;

notify pgrst, 'reload schema';
