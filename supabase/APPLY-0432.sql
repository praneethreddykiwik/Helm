-- APPLY-0432 (R249: background jobs answer "nothing to do" cheaply - run-sheet, task and delivery reminders, inbox digests,
-- comms and payment-schedule checks). Run on STAGING first, then production. Safe to run twice. Does NOT change cron.job (same
-- schedules, same commands) and does NOT change what is sent, to whom or when. Does NOT need 0423-0425 or 0430.
-- What it does:
--   * a quick "anything in the window?" check before the run-sheet / task / delivery reminder jobs load their full body;
--   * inbox digests, comms and the payment schedule only walk studios that can have work;
--   * three small indexes for those checks. Old bodies are kept as <name>__pre0432.
-- Nothing is changed or deleted.
-- It waits at most 5 seconds for a lock (then stops with an error and changes nothing - just run it again later).
-- Paste the whole file into the Supabase SQL editor and press Run. The last result lists checks - every ok must be true.
begin;
set local lock_timeout = '5s';
set local statement_timeout = '5min';
-- 0432_r249_cron_quiet.sql - R249 background jobs answer "nothing to do" cheaply (prod pg_stat_statements 23 Nov 2026:
-- runsheet_reminders_tick 9.7k calls / 101 ms, inbox_tick 98 ms, task_reminder_tick 91 ms + 45 ms, comms_tick 2.6k / 295 ms,
-- delivery_reminders_tick 55 ms - on a Nano that swaps, every job run costs). Forward-only, additive, safe to run twice. ASCII only.
-- REQUIRES 0241 (delivery_reminders_tick), 0264 / 0285 (comms_tick chain, _pst_tick), 0266 + 0401 (inbox_tick, _r23_queue_digests),
--          0269 (runsheet_reminders_tick), 0338 / 0364 / 0367 / 0369 (task_reminder_tick chain). A missing one is skipped with a notice.
--
-- In plain words - why a quiet job still cost ~100 ms:
--   Each pg_cron run is a fresh database session: it loads and plans the whole job (hundreds of lines) from cold before it finds
--   that nothing is due. inbox_tick and comms_tick also walk EVERY studio (trial and sample studios included) and read each one's
--   settings, time zone and people, even when the studio has nothing that could be sent.
-- What 0432 does (cron.job is NOT changed - same schedules, same commands):
--   A  run-sheet reminders, task reminders (every minute), delivery reminders: a short "anything in the window?" check runs first
--      (an index lookup). Nothing in the window -> the job answers the same zero answer its full body gives, without loading it.
--      Something in the window -> the kept full body runs, exactly as before. Each check uses the body's own driving conditions
--      with the finer ones left out, so it can only say "maybe" more often, never less (proved by the tests).
--   B  inbox digests (_r23_queue_digests), comms (comms_tick__pre0264: pay reminders, client follow-ups, low stock) and the
--      payment schedule part (_pst_tick) only walk studios that can have work: a notification of the last 2 days or a snooze
--      that came back (digests); a due / invoiced instalment with an amount, a client link that was opened, or an active stock
--      item (comms); a due / invoiced instalment with an amount (payment schedule). The loop line is edited in place (old body
--      kept as <name>__pre0432); if the loop line is not exactly as expected the function is left as it is (still correct).
--   C  three small partial indexes for those checks.
--   What is sent, to whom, when and with which words: unchanged. Only how quickly a quiet run finds out it is quiet.
-- ACCESS: unchanged - every job stays service_role / pg_cron only; the kept bodies and the checks are server only.
-- ZERO DATA LOSS: functions + 3 indexes (create index if not exists). Nothing deleted or rewritten. Safe to run twice.
-- ROLLBACK (manual, only if ever needed; no data involved): for each of runsheet_reminders_tick(), task_reminder_tick(timestamptz),
--   delivery_reminders_tick(), _r23_queue_digests(), comms_tick__pre0264(), _pst_tick(): drop the function, then rename
--   <name>__pre0432 back to <name> and grant execute to service_role. The indexes can stay.

-- ---- 0) keep helper (same shape as _r402_keep) ------------------------------------------------------------------------------
create or replace function public._r432_keep(p_fn text)
returns void language plpgsql volatile security definer set search_path = '' as $$
declare v_oid oid := to_regprocedure(p_fn); v_name text; v_types text; v_def text; v_pre text; r text;
begin
  if v_oid is null then return; end if;
  select p.proname, oidvectortypes(p.proargtypes) into v_name, v_types from pg_proc p where p.oid = v_oid;
  v_pre := format('public.%I(%s)', v_name || '__pre0432', v_types);
  if to_regprocedure(v_pre) is null then
    v_def := pg_get_functiondef(v_oid);
    v_def := regexp_replace(v_def, '^CREATE OR REPLACE FUNCTION public\.' || v_name || '\(',
                            'CREATE OR REPLACE FUNCTION public.' || v_name || '__pre0432(');
    if position(v_name || '__pre0432(' in v_def) = 0 then raise exception 'r249-0432: could not keep %', p_fn; end if;
    execute v_def;
  end if;
  execute format('revoke all on function %s from public', v_pre);
  foreach r in array array['anon', 'authenticated', 'service_role'] loop
    if exists (select 1 from pg_roles where rolname = r) then execute format('revoke all on function %s from %I', v_pre, r); end if;
  end loop;
end $$;
revoke all on function public._r432_keep(text) from public;
do $$ declare r text; begin
  foreach r in array array['anon', 'authenticated', 'service_role'] loop
    if exists (select 1 from pg_roles where rolname = r) then execute format('revoke all on function public._r432_keep(text) from %I', r); end if;
  end loop;
end $$;

-- ---- 1) indexes (small; partial) ---------------------------------------------------------------------------------------------
-- delivery: the tick selects on coalesce(eta_at, due_at); the existing delivery_commitments_due_idx is on due_at only
create index if not exists ix_delivery_commitments_when_0432 on public.delivery_commitments ((coalesce(eta_at, due_at)))
  where status in ('scheduled', 'reminded', 'delayed') and reminders_on;
-- inbox: snooze returns of the last 2 days (the other half of the digest window); only rows ever snoozed
create index if not exists ix_inbox_state_snooze_ret_0432 on public.notification_inbox_state (snooze_returned_at)
  where snooze_returned_at is not null;
-- task reminders: the every-minute guard (existing ix_event_tasks_planned_start_0344 also works; this one is smaller)
create index if not exists ix_event_tasks_remind_due_0432 on public.event_tasks (planned_start)
  where status in ('assigned', 'accepted') and planned_start is not null;

-- ---- 2) "anything due?" guards (read-only, server only) ---------------------------------------------------------------------
-- run-sheet: kept body loops over run_sheet_items x quotes with start_time not null, event_date in [today-1, today+2],
-- not deleted (+ more filters). Guard = those two tables and those predicates only (superset). current_date is the same
-- value for the whole transaction, so guard and body agree.
create or replace function public._r432_runsheet_due()
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.quotes q
                  where q.event_date between current_date - 1 and current_date + 2 and q.deleted_at is null
                    and exists (select 1 from public.run_sheet_items ri
                                 where ri.quote_id = q.id and ri.org_id = q.org_id and ri.start_time is not null));
$$;
-- task reminders: union of the three driving windows (0364 body [-1 day, +25 h], 0367 special [-7 h, +15 min],
-- 0369 escalation [-3 h, 0]) = [-1 day, +25 h]; status assigned/accepted; in_house. Quote filters dropped (superset).
create or replace function public._r432_task_due(p_now timestamptz)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.event_tasks t
                  where t.planned_start is not null
                    and t.planned_start between coalesce(p_now, now()) - interval '1 day' and coalesce(p_now, now()) + interval '25 hours'
                    and t.status in ('assigned', 'accepted')
                    and coalesce(t.assignee_kind, 'in_house') = 'in_house');
$$;
-- delivery: the kept body's own row filter minus the settings / quote joins (superset)
create or replace function public._r432_delivery_due()
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.delivery_commitments d
                  where d.status in ('scheduled', 'reminded', 'delayed') and d.reminders_on
                    and coalesce(d.eta_at, d.due_at) between now() - interval '3 hours' and now() + interval '1465 minutes');
$$;
revoke all on function public._r432_runsheet_due(), public._r432_task_due(timestamptz), public._r432_delivery_due() from public;
do $$ declare r text; begin
  foreach r in array array['anon', 'authenticated', 'service_role'] loop
    if exists (select 1 from pg_roles where rolname = r) then
      execute format('revoke all on function public._r432_runsheet_due(), public._r432_task_due(timestamptz), public._r432_delivery_due() from %I', r);
    end if;
  end loop;
end $$;

-- ---- 3) wrappers (same name, signature, SET options, grants; cron.job unchanged) -------------------------------------------
do $$ begin
  if to_regprocedure('public.runsheet_reminders_tick__pre0432()') is null then perform public._r432_keep('public.runsheet_reminders_tick()'); end if;
  if to_regprocedure('public.task_reminder_tick__pre0432(timestamptz)') is null then perform public._r432_keep('public.task_reminder_tick(timestamptz)'); end if;
  if to_regprocedure('public.delivery_reminders_tick__pre0432()') is null then perform public._r432_keep('public.delivery_reminders_tick()'); end if;
end $$;

create or replace function public.runsheet_reminders_tick()
returns jsonb language plpgsql security definer set search_path = '' set lock_timeout = '10s' as $$
-- r249-0432: nothing in the window -> the kept body's own zero answer, without loading it
begin
  if not public._r432_runsheet_due() then return jsonb_build_object('done', 0, 'skipped', 0); end if;
  return public.runsheet_reminders_tick__pre0432();
end $$;

create or replace function public.task_reminder_tick(p_now timestamptz default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
-- r249-0432: every minute; no assigned / accepted in-house job in [-1 day, +25 h] -> the kept chain's zero answer
-- (the kept chain task_reminder_tick__pre0432 = the r186-0369 escalation over the r179-0367 / r173-0364 timer, unchanged)
begin
  if not public._r432_task_due(p_now) then
    return jsonb_build_object('queued', 0, 'skipped', 0, 'special', 0, 'escalated', 0); end if;
  return public.task_reminder_tick__pre0432(p_now);
end $$;

create or replace function public.delivery_reminders_tick()
returns jsonb language plpgsql security definer set search_path = '' as $$
-- r249-0432
begin
  if not public._r432_delivery_due() then return jsonb_build_object('queued', 0, 'skipped', 0, 'no_response', 0); end if;
  return public.delivery_reminders_tick__pre0432();
end $$;
-- (create or replace keeps the existing ACL; on a fresh rename the new functions need it:)
do $$ declare f text; begin
  foreach f in array array['public.runsheet_reminders_tick()', 'public.task_reminder_tick(timestamptz)', 'public.delivery_reminders_tick()'] loop
    execute format('revoke all on function %s from public', f);
    if exists (select 1 from pg_roles where rolname = 'anon') then execute format('revoke all on function %s from anon, authenticated', f); end if;
    if exists (select 1 from pg_roles where rolname = 'service_role') then execute format('grant execute on function %s to service_role', f); end if;
  end loop;
end $$;

-- ---- 4) per-studio loops skip studios that cannot have work (exact text edit of ONE loop header, 0402 style) -------------
-- inbox digests (_r23_queue_digests, 0401 body): a digest needs an unread row with sort_at >= now() - 2 days;
-- sort_at = greatest(created_at, snoozed_until when back, snooze_returned_at) of a notification of THIS studio.
-- comms (comms_tick__pre0264): pay reminders need a due/invoiced milestone with an amount; follow-ups need a client link
-- open; low stock needs an active stock item. _pst_tick: both parts need a due/invoiced milestone with an amount.
do $do$
declare r record; v_oid oid; v_def text; v_n integer;
begin
  for r in select * from (values
    ('public._r23_queue_digests()',
     'for o in select g.id from public.organizations g loop',
     'for o in select g.id from public.organizations g where exists (select 1 from public.notifications n where n.org_id = g.id and n.created_at >= now() - interval ''2 days'') or exists (select 1 from public.notification_inbox_state st join public.notifications n on n.id = st.notification_id and n.org_id = g.id where (st.snooze_returned_at >= now() - interval ''2 days'') or (st.snoozed_until is not null and st.snoozed_until <= now())) /* r249-0432 */ loop'),
    ('public.comms_tick__pre0264()',
     'for o in select org.id, org.name, coalesce(org.timezone, ''Asia/Kolkata'') as tz from public.organizations org loop',
     'for o in select org.id, org.name, coalesce(org.timezone, ''Asia/Kolkata'') as tz from public.organizations org where exists (select 1 from public.payment_milestones pm where pm.org_id = org.id and pm.status in (''due'', ''invoiced'') and pm.amount > 0) or exists (select 1 from public.client_link_opens lo join public.quotes q on q.id = lo.quote_id where q.org_id = org.id) or exists (select 1 from public.inventory_items i where i.org_id = org.id and i.active) /* r249-0432 */ loop'),
    ('public._pst_tick()',
     'for o in select org.id from public.organizations org loop',
     'for o in select org.id from public.organizations org where exists (select 1 from public.payment_milestones pm where pm.org_id = org.id and pm.status in (''due'', ''invoiced'') and coalesce(pm.amount, 0) > 0) or exists (select 1 from public.quotes q join public.payment_milestones pm on pm.quote_id = q.id where q.org_id = org.id and pm.status in (''due'', ''invoiced'') and pm.amount > 0) /* r249-0432 */ loop')
  ) v(fn, old_txt, new_txt) loop
    v_oid := to_regprocedure(r.fn);
    if v_oid is null then raise notice '0432: % not on this database - left unchanged', r.fn; continue; end if;
    v_def := pg_get_functiondef(v_oid);
    if position('r249-0432' in v_def) > 0 then continue; end if;             -- already done (second run)
    v_n := (length(v_def) - length(replace(v_def, r.old_txt, ''))) / length(r.old_txt);
    if v_n <> 1 then raise notice '0432: % has an unexpected body - left unchanged (still correct, just not faster)', r.fn; continue; end if;
    perform public._r432_keep(r.fn);
    execute replace(v_def, r.old_txt, r.new_txt);
  end loop;
end $do$;
-- NOTE comms_tick__pre0264 loop: follow-ups join client_link_opens ON the studio's quotes (q.org_id = o.id), so the prefilter
-- joins quotes too (client_link_opens.org_id is not relied on). Index: client_link_opens_pkey (quote_id, kind) + quotes_org_idx.
-- notifications_org_created_idx (org_id, created_at desc) serves the inbox prefilter.


do $$ begin
  if to_regclass('public.helm_schema_markers') is not null then
    insert into public.helm_schema_markers(num, name) values (432, '0432_r249_cron_quiet') on conflict (num) do nothing;
  end if;
end $$;

notify pgrst, 'reload schema';

-- ---- checks (every ok must be true) --------------------------------------------------------------------------------------
select item, ok from (values
  ('01 the three reminder jobs check first, still service_role only',
     position('_r432_runsheet_due' in pg_get_functiondef('public.runsheet_reminders_tick()'::regprocedure)) > 0
     and position('_r432_task_due' in pg_get_functiondef('public.task_reminder_tick(timestamptz)'::regprocedure)) > 0
     and position('_r432_delivery_due' in pg_get_functiondef('public.delivery_reminders_tick()'::regprocedure)) > 0
     and not has_function_privilege('authenticated', 'public.task_reminder_tick(timestamptz)', 'execute')
     and not has_function_privilege('anon', 'public.runsheet_reminders_tick()', 'execute')),
  ('02 six kept bodies, server only',
     (select count(*) from pg_proc p join pg_namespace s on s.oid = p.pronamespace where s.nspname = 'public' and p.proname like '%\_\_pre0432') = 6
     and not has_function_privilege('authenticated', 'public.runsheet_reminders_tick__pre0432()', 'execute')
     and not has_function_privilege('authenticated', 'public._r432_task_due(timestamptz)', 'execute')),
  ('03 the studio loops of digests / comms / payment schedule are prefiltered (or left unchanged with a notice)',
     (select count(*) from unnest(array['public._r23_queue_digests()', 'public.comms_tick__pre0264()', 'public._pst_tick()']) f(x)
       where to_regprocedure(f.x) is not null and (position('r249-0432' in pg_get_functiondef(to_regprocedure(f.x))) > 0
             or to_regprocedure(replace(f.x, '()', '__pre0432()')) is null)) = 3),
  ('04 run-sheet / inbox / comms keep their 10 s lock limit',
     (select proconfig @> array['lock_timeout=10s'] from pg_proc where oid = 'public.runsheet_reminders_tick()'::regprocedure)
     and (select proconfig @> array['lock_timeout=10s'] from pg_proc where oid = 'public.inbox_tick()'::regprocedure)
     and (select proconfig @> array['lock_timeout=10s'] from pg_proc where oid = 'public.comms_tick()'::regprocedure)),
  ('05 three indexes',
     to_regclass('public.ix_delivery_commitments_when_0432') is not null and to_regclass('public.ix_inbox_state_snooze_ret_0432') is not null
     and to_regclass('public.ix_event_tasks_remind_due_0432') is not null),
  ('06 schema marker 432 recorded (or no 0412 marker table)',
     to_regclass('public.helm_schema_markers') is null or exists (select 1 from public.helm_schema_markers where num = 432))
) v(item, ok) order by item;
commit;
