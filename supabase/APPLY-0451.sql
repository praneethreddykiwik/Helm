-- APPLY-0451 (R261: an event marked complete can be closed on the same day). Run on STAGING first, then Canada production, then HELM-PROD-MUMBAI.
-- Safe to run twice. It stops before changing anything if something it needs is missing. If 0372 is ever pasted again, paste 0451 after it.
-- Same content as supabase/migrations/0451_r261_close_same_day.sql. The last result lists one row per check.
begin;
set local lock_timeout = '5s';
set local statement_timeout = '5min';
-- 0451_r261_close_same_day.sql - R261 an event that was marked complete can be closed the same day. Forward-only, additive, safe to
-- run twice. ASCII only.
-- REQUIRES 0198 (event day rule), 0282 (close gate), 0372 (close blockers with TDS).
--
-- In plain words (owner, 25 Nov 2026: "if the event is completed that day ... once event done is clicked this should go away"):
--   Until now an event could only be closed from the day AFTER the event day, with no exception. Now: when the event day is TODAY
--   (studio time) and the event was marked complete (Wrap-up "Mark event complete", stage Settlement), the rule counts as met.
--   An event in the future still cannot be closed, and every other rule (balance, stock, claims, bills, booking) is unchanged.
-- Same lines as before: the old blockers body is kept as _a49_close_blockers__pre0451; the close gate keeps its whole text and only
--   its one date line asks _r451_done_today first.
-- ZERO DATA LOSS: no table, column or row is changed or removed.

do $$ begin
  if to_regprocedure('public._a49_close_blockers(uuid)') is null or to_regprocedure('public._a198_org_today(uuid)') is null then
    raise exception 'STOP 0451: apply 0198 first'; end if;
  if position('r32-0282' in pg_get_functiondef('public._a49_close_gate(uuid,text)'::regprocedure)) = 0 then
    raise exception 'STOP 0451: apply 0282 first (close gate)'; end if;
  if position('r189-money-0372' in pg_get_functiondef('public._a49_close_blockers(uuid)'::regprocedure)) = 0
     and position('r261-0451' in pg_get_functiondef('public._a49_close_blockers(uuid)'::regprocedure)) = 0 then
    raise exception 'STOP 0451: apply 0372 first (close blockers)'; end if;
end $$;

create or replace function public._r451_done_today(p_quote uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  -- r261-0451: the event day is today (studio time) and the event was marked complete
  select exists (select 1 from public.quotes q where q.id = p_quote and q.status = 'confirmed' and q.lifecycle_stage = 'settlement'
                    and q.event_date is not null and q.event_date = public._a198_org_today(q.org_id));
$$;

-- keep 0372's body (a re-run of 0372 puts its own body back under the public name: then it is kept again, never overwritten)
do $$ begin
  if to_regprocedure('public._a49_close_blockers__pre0451(uuid)') is null then
    alter function public._a49_close_blockers(uuid) rename to _a49_close_blockers__pre0451;
  end if;
end $$;
create or replace function public._a49_close_blockers(p_quote uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
-- r261-0451: wraps _a49_close_blockers__pre0451 (r189-money-0372 body): marked complete on the event day = the day is over
declare b jsonb;
begin
  b := public._a49_close_blockers__pre0451(p_quote);
  if b is null or not coalesce((b ->> 'too_early')::boolean, false) or not public._r451_done_today(p_quote) then return b; end if;
  return b || jsonb_build_object('too_early', false, 'done_today', true,
    'blocked', (coalesce((b ->> 'balance_owed')::numeric, 0) > 0 or coalesce((b ->> 'open_checkouts')::int, 0) > 0
                or (b ->> 'not_booked') is not null or coalesce((b ->> 'no_event_date')::boolean, false)));
end $$;

-- the close gate: only its date line changes
do $$ declare v_def text; v_old text := 'v_date >= v_today then'; v_new text := 'v_date >= v_today and not public._r451_done_today(p_quote) then';
begin
  v_def := pg_get_functiondef('public._a49_close_gate(uuid,text)'::regprocedure);
  if position('_r451_done_today' in v_def) = 0 then
    if position(v_old in v_def) = 0 or position(v_old in substr(v_def, position(v_old in v_def) + 1)) > 0 then
      raise exception 'STOP 0451: the close gate does not look as expected - nothing was changed'; end if;
    execute replace(v_def, v_old, v_new);
  end if;
end $$;

do $$ declare f text; begin
  foreach f in array array['_r451_done_today(uuid)', '_a49_close_blockers(uuid)', '_a49_close_blockers__pre0451(uuid)', '_a49_close_gate(uuid,text)'] loop
    execute 'revoke all on function public.' || f || ' from public';
    if exists (select 1 from pg_roles where rolname = 'anon') then execute 'revoke all on function public.' || f || ' from anon'; end if;
    if exists (select 1 from pg_roles where rolname = 'authenticated') then execute 'revoke all on function public.' || f || ' from authenticated'; end if;
    if exists (select 1 from pg_roles where rolname = 'service_role') then execute 'grant execute on function public.' || f || ' to service_role'; end if;
  end loop;
end $$;

do $$ begin
  if to_regclass('public.helm_schema_markers') is not null then
    insert into public.helm_schema_markers(num, name) values (451, '0451_r261_close_same_day') on conflict (num) do nothing;
  end if;
end $$;

notify pgrst, 'reload schema';

-- ---- CHECK (read only): every row must say true -------------------------------------------------------------------------------
select c."check", c.ok from (values
  ('01 marked complete on the event day counts as over', position('r261-0451' in pg_get_functiondef('public._a49_close_blockers(uuid)'::regprocedure)) > 0
      and position('_r451_done_today' in pg_get_functiondef('public._a49_close_gate(uuid,text)'::regprocedure)) > 0),
  ('02 the gate kept every other rule', position('r32-0282' in pg_get_functiondef('public._a49_close_gate(uuid,text)'::regprocedure)) > 0
      and position('HL425' in pg_get_functiondef('public._a49_close_gate(uuid,text)'::regprocedure)) > 0
      and position('event_close_overrides' in pg_get_functiondef('public._a49_close_gate(uuid,text)'::regprocedure)) > 0),
  ('03 the old body is kept', to_regprocedure('public._a49_close_blockers__pre0451(uuid)') is not null
      and position('r189-money-0372' in pg_get_functiondef(to_regprocedure('public._a49_close_blockers__pre0451(uuid)'))) > 0),
  ('04 server only', not has_function_privilege('authenticated', 'public._r451_done_today(uuid)', 'execute')
      and not has_function_privilege('authenticated', 'public._a49_close_blockers(uuid)', 'execute')
      and not has_function_privilege('authenticated', 'public._a49_close_gate(uuid,text)', 'execute')
      and not has_function_privilege('anon', 'public._a49_close_gate(uuid,text)', 'execute')),
  ('05 search_path pinned', (select bool_and(coalesce(p.proconfig @> array['search_path=""'], false)) from pg_proc p where p.pronamespace = 'public'::regnamespace
      and p.proname in ('_r451_done_today', '_a49_close_blockers', '_a49_close_blockers__pre0451', '_a49_close_gate')))
) c("check", ok);
commit;
