-- 0453_r268_checkin_anytime.sql - R268 the "check-in opens 3 hours before your start" wait is paused. Forward-only, safe to run twice. ASCII only.
-- REQUIRES 0265 (crew check-in).
--
-- In plain words (owner, 26 Nov 2026: "disable this check-in time feature now, pause it"):
--   A crew member could not check in earlier than 3 hours before their first task. That wait is paused: on the event day they can check in
--   at any time. Everything else stays: only on their event day, location check when the studio turned it on, late minutes against the start time,
--   one check-in per day. The old body is kept as crew_check__pre0453 (to turn the wait back on, a later file puts it back).
-- ZERO DATA LOSS: functions only; no table, column or row is changed or removed.

do $$ begin
  if to_regprocedure('public.crew_check(uuid,text,numeric,numeric,numeric)') is null then raise exception 'STOP 0453: apply 0265 first'; end if;
end $$;

do $$ declare v_def text := pg_get_functiondef('public.crew_check(uuid,text,numeric,numeric,numeric)'::regprocedure);
  a text := 'if v_exp is not null and now() < v_exp - interval ''3 hours'' then';
  b text := 'if v_exp is not null and now() < v_exp - interval ''3 hours'' and false then   -- r268-0453: the early wait is paused';
begin
  if position('r268-0453' in v_def) > 0 then return; end if;
  if (length(v_def) - length(replace(v_def, a, ''))) <> length(a) then raise exception 'STOP 0453: crew_check has an unexpected body - nothing was changed'; end if;
  if to_regprocedure('public.crew_check__pre0453(uuid,text,numeric,numeric,numeric)') is null then
    execute replace(v_def, 'FUNCTION public.crew_check(', 'FUNCTION public.crew_check__pre0453(');
  end if;
  execute replace(v_def, a, b);
end $$;

do $$ declare r text; begin
  revoke all on function public.crew_check__pre0453(uuid, text, numeric, numeric, numeric) from public;
  foreach r in array array['anon', 'authenticated', 'service_role'] loop
    if exists (select 1 from pg_roles where rolname = r) then execute format('revoke all on function public.crew_check__pre0453(uuid, text, numeric, numeric, numeric) from %I', r); end if;
  end loop;
  if to_regclass('public.helm_schema_markers') is not null then
    insert into public.helm_schema_markers(num, name) values (453, '0453_r268_checkin_anytime') on conflict (num) do nothing;
  end if;
end $$;

notify pgrst, 'reload schema';

-- ---- CHECK (read only): every row must say true -------------------------------------------------------------------------------
select c."check", c.ok from (values
  ('01 the early wait is paused', position('r268-0453' in pg_get_functiondef('public.crew_check(uuid,text,numeric,numeric,numeric)'::regprocedure)) > 0),
  ('02 the event-day rule, location and late minutes stay', position('Check-in opens on the event day.' in pg_get_functiondef('public.crew_check(uuid,text,numeric,numeric,numeric)'::regprocedure)) > 0
      and position('v_within' in pg_get_functiondef('public.crew_check(uuid,text,numeric,numeric,numeric)'::regprocedure)) > 0
      and position('v_late' in pg_get_functiondef('public.crew_check(uuid,text,numeric,numeric,numeric)'::regprocedure)) > 0),
  ('03 the old body is kept, closed to the app', to_regprocedure('public.crew_check__pre0453(uuid,text,numeric,numeric,numeric)') is not null
      and not has_function_privilege('anon', 'public.crew_check__pre0453(uuid,text,numeric,numeric,numeric)', 'execute')
      and not has_function_privilege('authenticated', 'public.crew_check__pre0453(uuid,text,numeric,numeric,numeric)', 'execute'))
) c("check", ok);
