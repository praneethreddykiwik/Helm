-- 0431_r249_money_once.sql - R249 the event money reads share ONE cost ledger (prod 22 Nov 2026 23:54: event_money_cash,
-- event_money_header and event_cost_breakdown answered 500 with 57014 "canceling statement due to statement timeout" at the same
-- second, for the same event). Forward-only, additive, safe to run twice. ASCII only. Every money answer stays the same.
-- REQUIRES 0124 (event_pnl), 0246 (event_cost_breakdown), 0372 (_r21_event_money wrapper over _r21_event_money__pre0372),
--          0376 (event_money_header), 0377 (event_money_cash), 0387 (header / cash build the ledger once each).
--
-- In plain words - why they still ran out of time after 0387:
--   The Budget, Settlement and Closure pages show the money header, the "Cash in & out" / "Who owes what" tabs and the
--   "Budget & margin" card. Each of those is its own call, and each call builds the WHOLE cost ledger of the event (every
--   booking, bill, cost line, crew wage, claim, change and write-off) - the expensive part. The page sent the three calls at
--   the same moment, so the database built the same ledger three times in parallel, on a small server that was already
--   swapping memory. Each build then took long enough to hit the 8 s limit.
-- What 0431 does:
--   A  NEW event_money_bundle(event, parts): ONE call that answers any of 'header', 'cash', 'breakdown', 'pnl'. It simply calls
--      event_money_header / event_money_cash / event_cost_breakdown / event_pnl one after the other inside the same statement,
--      so each part is exactly what its own call answers (same access checks inside each one). A part the caller may not
--      see answers its error in "errors" (the other parts still come back), the way its own call would have failed.
--   B  Inside that one call (and only there) the heavy ledger body is worked out once and reused: _r21_event_money__pre0372
--      becomes a thin wrapper (the kept body is _r21_event_money__pre0372__pre0431) that remembers the last answer for the
--      same event + studio for the rest of THIS statement. The memory is switched on by event_money_bundle only, cleared at
--      its start and its end, and lives in a transaction-local setting, so no other call, request or person can ever see it.
--      Every other caller gets exactly the kept body, as before.
--   The pages ask for what they show in one bundle (store-api.js), so the ledger is built once instead of three times, and the
--   calls no longer run side by side. A database without 0431 keeps the separate calls (the page falls back by itself).
-- ACCESS: event_money_bundle: signed-in only (each part re-checks Finance view + own studio inside, as before). The wrapper and
--   the kept body are for the server only. Definer + empty search_path everywhere.
-- ZERO DATA LOSS: functions only. No table, column, row, policy, trigger or index is created, changed or dropped. Nothing is
--   written by any of these calls.
-- ROLLBACK (manual, only if ever needed; no data involved):
--   revoke execute on function public.event_money_bundle(uuid, text[]) from authenticated;   (the pages fall back by themselves)
--   drop function public._r21_event_money__pre0372(uuid, uuid, boolean);
--   alter function public._r21_event_money__pre0372__pre0431(uuid, uuid, boolean) rename to _r21_event_money__pre0372;

-- ---- 0) preflight ---------------------------------------------------------------------------------------------------------
do $$ begin
  if to_regprocedure('public._r21_event_money(uuid,uuid,boolean)') is null
     or (to_regprocedure('public._r21_event_money__pre0372(uuid,uuid,boolean)') is null
         and to_regprocedure('public._r21_event_money__pre0372__pre0431(uuid,uuid,boolean)') is null) then
    raise exception 'STOP 0431: apply 0372 (money lock) first'; end if;
  if to_regprocedure('public.event_money_header__pre0387(uuid)') is null or to_regprocedure('public.event_money_cash(uuid)') is null then
    raise exception 'STOP 0431: apply 0376, 0377 and 0387 first'; end if;
  if to_regprocedure('public.event_cost_breakdown(uuid)') is null or to_regprocedure('public.event_pnl(uuid)') is null then
    raise exception 'STOP 0431: apply 0124 and 0246 first'; end if;
end $$;

-- ---- 1) keep the heavy ledger body once -----------------------------------------------------------------------------------
do $$ begin
  if to_regprocedure('public._r21_event_money__pre0372__pre0431(uuid,uuid,boolean)') is null then
    alter function public._r21_event_money__pre0372(uuid, uuid, boolean) rename to _r21_event_money__pre0372__pre0431;
  end if;
end $$;

-- ---- 2) the same name: the kept body, remembered for the rest of one event_money_bundle call ---------------------------------
create or replace function public._r21_event_money__pre0372(p_quote uuid, p_org uuid, p_lines boolean)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
-- r249-0431: exactly _r21_event_money__pre0372__pre0431 (the r21-money-0246 / 0287 ledger). Only while event_money_bundle runs
-- (helm.r431_money_on = 'on', set and cleared by it, transaction-local) the answer for the same event + studio + lines is
-- reused instead of being built again. Everywhere else: the kept body, every time.
declare v_key text; v_val text; m jsonb;
begin
  if coalesce(current_setting('helm.r431_money_on', true), '') <> 'on' then
    return public._r21_event_money__pre0372__pre0431(p_quote, p_org, p_lines);
  end if;
  v_key := coalesce(p_quote::text, '-') || '|' || coalesce(p_org::text, '-') || '|' || coalesce(p_lines::text, '-');
  if coalesce(current_setting('helm.r431_money_key', true), '') = v_key then
    v_val := current_setting('helm.r431_money_val', true);
    if v_val = 'null' then return null; end if;
    if v_val is not null and v_val <> '' then return v_val::jsonb; end if;
  end if;
  m := public._r21_event_money__pre0372__pre0431(p_quote, p_org, p_lines);
  perform set_config('helm.r431_money_key', v_key, true);
  perform set_config('helm.r431_money_val', coalesce(m::text, 'null'), true);
  return m;
end $$;

-- ---- 3) one call for the money parts a page shows -----------------------------------------------------------------------------
create or replace function public.event_money_bundle(p_quote uuid, p_parts text[])
returns jsonb language plpgsql stable security definer set search_path = '' as $$
-- r249-0431: read-only. Each part = its own call, in this order: header (event_money_header), cash (event_money_cash),
-- breakdown (event_cost_breakdown), pnl (event_pnl). Unknown part names are ignored. A part that fails answers
-- errors.<part> = {code, message} (its own call would have failed the same way); the others still come back.
-- A statement timeout is never swallowed (it is not "others").
declare v_parts text[]; v_out jsonb := jsonb_build_object('v', 1); v_err jsonb := '{}'::jsonb; p text; v jsonb;
begin
  if auth.uid() is null then raise exception 'not authorized' using errcode = '42501'; end if;
  select coalesce(array_agg(x.k order by x.o), '{}'::text[]) into v_parts
    from (values ('header', 1), ('cash', 2), ('breakdown', 3), ('pnl', 4)) x(k, o)
   where x.k = any (coalesce(p_parts, '{}'::text[]));
  perform set_config('helm.r431_money_key', '', true);
  perform set_config('helm.r431_money_val', '', true);
  perform set_config('helm.r431_money_on', 'on', true);
  foreach p in array v_parts loop
    begin
      if p = 'header' then v := public.event_money_header(p_quote);
      elsif p = 'cash' then v := public.event_money_cash(p_quote);
      elsif p = 'breakdown' then v := public.event_cost_breakdown(p_quote);
      else v := public.event_pnl(p_quote);
      end if;
      v_out := v_out || jsonb_build_object(p, v);
    exception when others then
      v_err := v_err || jsonb_build_object(p, jsonb_build_object('code', sqlstate, 'message', left(sqlerrm, 300)));
    end;
  end loop;
  perform set_config('helm.r431_money_on', '', true);
  perform set_config('helm.r431_money_key', '', true);
  perform set_config('helm.r431_money_val', '', true);
  return v_out || jsonb_build_object('errors', v_err);
end $$;

-- ---- 4) grants: the bundle for signed-in people; the wrapper + kept body for the server only ---------------------------------
do $$ declare f text; begin
  foreach f in array array['public._r21_event_money__pre0372(uuid,uuid,boolean)', 'public._r21_event_money__pre0372__pre0431(uuid,uuid,boolean)',
                           'public.event_money_bundle(uuid,text[])'] loop
    execute format('revoke all on function %s from public', f);
    if exists (select 1 from pg_roles where rolname = 'anon') then execute format('revoke all on function %s from anon', f); end if;
    if exists (select 1 from pg_roles where rolname = 'authenticated') then execute format('revoke all on function %s from authenticated', f); end if;
    if exists (select 1 from pg_roles where rolname = 'service_role') then execute format('grant execute on function %s to service_role', f); end if;
  end loop;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    execute 'grant execute on function public.event_money_bundle(uuid,text[]) to authenticated'; end if;
end $$;

do $$ begin
  if to_regclass('public.helm_schema_markers') is not null then
    insert into public.helm_schema_markers(num, name) values (431, '0431_r249_money_once') on conflict (num) do nothing;
  end if;
end $$;

notify pgrst, 'reload schema';
