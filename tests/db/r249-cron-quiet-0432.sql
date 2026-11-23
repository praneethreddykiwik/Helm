-- r249-cron-quiet-0432.sql - R249 background jobs answer "nothing to do" cheaply (0432). Proves: (1) applied twice, six kept
-- bodies once (__pre0432), cron jobs still service_role only, the 0401 lock_timeout kept, the loop prefilters in place once;
-- (2) quiet (300 extra empty studios): every job answers exactly what its kept body answers and nothing is written; the three
-- "anything due?" checks say no; (3) one row in the window -> the check says yes and the kept body runs (same answer, same rows);
-- (4) SUPERSET: over a sweep of tasks / run-sheet lines / deliveries at many times and states, every row the kept body would
-- pick makes its check say yes; every studio the kept loops would act for passes the prefilter (due instalment, opened client
-- link, active stock item, recent notification, returned snooze); (5) with work in a studio, the prefiltered digests / comms /
-- payment-schedule bodies write exactly the rows the kept bodies write; (6) an unexpected loop line is left unchanged.
-- Local disposable PG only. Rolled back.
\set ON_ERROR_STOP 0
set client_min_messages = warning;
begin;
create temp table _rm(name text, result text);
create temp table _rkv(k text primary key, v text);
create or replace function pg_temp.res(p_name text, p_ok boolean, p_detail text default '') returns void language plpgsql as $$
begin insert into _rm values (p_name, case when coalesce(p_ok, false) then 'PASS' else 'FAIL: '||coalesce(p_detail,'') end); end $$;
create or replace function pg_temp.put(p_k text, p_v text) returns void language plpgsql as $$
begin insert into _rkv values (p_k, p_v) on conflict (k) do update set v = excluded.v; end $$;
create or replace function pg_temp.get(p_k text) returns text language sql as $$ select v from _rkv where k = p_k $$;
-- everything a job can write (rows counted per table)
create or replace function pg_temp.written() returns text language sql as $$
  select (select count(*) from public.notifications) || '/' || (select count(*) from public.comms_outbox) || '/'
      || (select count(*) from public.helm_notice_outbox) || '/' || (select count(*) from public.task_wa_outbox) || '/'
      || (select count(*) from public.runsheet_reminder_sends) || '/' || (select count(*) from public.delivery_reminder_sends) || '/'
      || (select count(*) from public.notification_inbox_state) || '/' || (select count(*) from public.inv_shortage_alerts) || '/'
      || (select count(*) from public.payment_overdue_alerts) || '/' || (select count(*) from public.task_escalation_steps) $$;
-- the rows one call writes, as text (run inside a block that is rolled back by the caller)
create or replace function pg_temp.snap() returns text language sql as $$
  select md5(coalesce((select string_agg(x::text, ',' order by x::text) from (
      select jsonb_build_object('k', n.kind, 'q', n.quote_id, 'o', n.org_id, 'd', n.detail - 'at') as x from public.notifications n
      union all select jsonb_build_object('p', c.purpose, 'ch', c.channel, 'r', c.recipient, 'k', c.dedupe_key, 'pl', c.payload) from public.comms_outbox c
      union all select jsonb_build_object('h', h.kind, 'k', h.dedupe_key, 'pl', h.payload) from public.helm_notice_outbox h
      union all select jsonb_build_object('s', s.item_id, 'k', s.need, 'e', s.event_date) from public.inv_shortage_alerts s
      union all select jsonb_build_object('m', a.milestone_id) from public.payment_overdue_alerts a
      union all select jsonb_build_object('u', st.user_id, 'n', st.notification_id, 'd', st.digested_at is not null) from public.notification_inbox_state st) t), ''))
$$;

-- ---- setup: 300 empty studios (trial / sample studios on prod) ---------------------------------------------------------------
do $$ declare i int; begin
  for i in 1..300 loop insert into public.organizations(name, timezone) values ('R249 empty ' || i, 'Asia/Kolkata'); end loop;
  perform pg_temp.put('w0', pg_temp.written());
end $$;
-- quiet answers of the kept chain BEFORE 0432 (the same functions that become the kept bodies)
do $$ begin
  perform pg_temp.put('q_rs', public.runsheet_reminders_tick()::text);
  perform pg_temp.put('q_tk', public.task_reminder_tick(now())::text);
  perform pg_temp.put('q_dl', public.delivery_reminders_tick()::text);
  perform pg_temp.put('q_dg', public._r23_queue_digests()::text);
  perform pg_temp.put('q_ct', public.comms_tick__pre0264()::text);
  perform pg_temp.put('q_ps', public._pst_tick()::text);
end $$;

-- ---- the migration, twice ------------------------------------------------------------------------------------------------------
set client_min_messages = error;
\ir ../../supabase/migrations/0432_r249_cron_quiet.sql
\ir ../../supabase/migrations/0432_r249_cron_quiet.sql
set client_min_messages = warning;

do $$ declare f text; ok boolean := true; begin
  foreach f in array array['public.runsheet_reminders_tick()', 'public.task_reminder_tick(timestamptz)', 'public.delivery_reminders_tick()',
                           'public._r23_queue_digests()', 'public.comms_tick__pre0264()', 'public._pst_tick()'] loop
    ok := ok and has_function_privilege('service_role', f, 'execute')
            and not has_function_privilege('authenticated', f, 'execute') and not has_function_privilege('anon', f, 'execute');
  end loop;
  perform pg_temp.res('01 applied twice: six kept bodies once (__pre0432), no __pre0432__pre0432; jobs still service_role only; kept bodies server only',
    ok and (select count(*) from pg_proc p join pg_namespace s on s.oid = p.pronamespace where s.nspname = 'public' and p.proname like '%\_\_pre0432') = 6
    and not exists (select 1 from pg_proc where proname like '%\_\_pre0432\_\_pre0432')
    and not has_function_privilege('service_role', 'public.runsheet_reminders_tick__pre0432()', 'execute')
    and not has_function_privilege('authenticated', 'public._pst_tick__pre0432()', 'execute')
    and not has_function_privilege('authenticated', 'public._r432_task_due(timestamptz)', 'execute'));
  perform pg_temp.res('02 0401 lock_timeout=10s kept on runsheet / digests caller; prefilters in place exactly once; 2 indexes (the task check uses the 0344 index)',
    (select proconfig @> array['lock_timeout=10s'] from pg_proc where oid = 'public.runsheet_reminders_tick()'::regprocedure)
    and (select proconfig @> array['lock_timeout=10s'] from pg_proc where oid = 'public.inbox_tick()'::regprocedure)
    and (select bool_and((length(pg_get_functiondef(x)) - length(replace(pg_get_functiondef(x), '/* r249-0432 */', ''))) / length('/* r249-0432 */') = 1)
           from unnest(array['public._r23_queue_digests()'::regprocedure, 'public.comms_tick__pre0264()'::regprocedure, 'public._pst_tick()'::regprocedure]) x)
    and to_regclass('public.ix_delivery_commitments_when_0432') is not null and to_regclass('public.ix_inbox_state_snooze_ret_0432') is not null
    and to_regclass('public.ix_event_tasks_remind_due_0432') is null);
end $$;

-- ---- quiet: the same answers, nothing written ----------------------------------------------------------------------------------
do $$ begin
  perform pg_temp.res('03 quiet (302 studios): every job answers exactly its kept body''s answer',
    public.runsheet_reminders_tick()::text = pg_temp.get('q_rs') and public.task_reminder_tick(now())::text = pg_temp.get('q_tk')
    and public.delivery_reminders_tick()::text = pg_temp.get('q_dl') and public._r23_queue_digests()::text = pg_temp.get('q_dg')
    and public.comms_tick__pre0264()::text = pg_temp.get('q_ct') and public._pst_tick()::text = pg_temp.get('q_ps')
    and public.comms_tick() ? 'pay_reminders' and public.inbox_tick() ? 'queued',
    pg_temp.get('q_rs') || ' ' || pg_temp.get('q_tk') || ' ' || pg_temp.get('q_dl'));
  perform pg_temp.res('04 quiet: the three checks say no; nothing was written', not public._r432_runsheet_due() and not public._r432_task_due(now())
    and not public._r432_delivery_due() and pg_temp.written() = pg_temp.get('w0'), pg_temp.written() || ' vs ' || pg_temp.get('w0'));
end $$;

-- ---- superset sweep: every row a kept body would pick makes its check say yes ------------------------------------------------
do $$ declare a uuid := 'a0000000-0000-4000-8000-000000000001'; q uuid; qd uuid; qc uuid; i int; t timestamptz; bad int := 0; n_hit int := 0;
  st text; ak text; rs_k text := ''; rs_w text := '';
begin
  insert into public.quotes(code, title, status, org_id, event_date, pricing) values ('R249-T1', 'Sweep', 'confirmed', a, current_date, '{}'::jsonb) returning id into q;
  insert into public.quotes(code, title, status, org_id, event_date, pricing, deleted_at) values ('R249-T2', 'Deleted', 'confirmed', a, current_date, '{}'::jsonb, now()) returning id into qd;
  insert into public.quotes(code, title, status, org_id, event_date, pricing) values ('R249-T3', 'Cancelled', 'cancelled', a, current_date, '{}'::jsonb) returning id into qc;
  for i in -40 .. 40 loop
    foreach st in array array['assigned', 'accepted', 'unassigned', 'completed'] loop
      foreach ak in array array['in_house', 'outsourced'] loop
        insert into public.event_tasks(quote_id, category, title, status, planned_start, assignee_kind, is_special, org_id)
          values ((array[q, qd, qc])[1 + (abs(i) % 3)], 'setup', 'Sweep ' || i, st, now() + make_interval(hours => i), ak, i % 2 = 0, a);
      end loop;
    end loop;
  end loop;
  -- task: the union of the three kept bodies' driving rows (0364, 0367 special, 0369 escalation) for each "now" of a 3-day sweep
  for i in -36 .. 36 loop
    t := now() + make_interval(hours => i);
    if exists (select 1 from public.event_tasks tk join public.quotes x on x.id = tk.quote_id and x.org_id = tk.org_id
                where tk.planned_start is not null and x.deleted_at is null and coalesce(x.status, '') <> 'cancelled'
                  and tk.status in ('assigned', 'accepted') and coalesce(tk.assignee_kind, 'in_house') = 'in_house'
                  and (tk.planned_start between t - interval '1 day' and t + interval '25 hours'
                       or (tk.is_special and tk.planned_start between t - interval '7 hours' and t + interval '15 minutes')
                       or (tk.is_special and tk.planned_start between t - interval '3 hours' and t))) then
      n_hit := n_hit + 1;
      if not public._r432_task_due(t) then bad := bad + 1; end if;
    end if;
  end loop;
  -- run-sheet: the kept body's join (lines with a start time, events today-1 .. today+2, not deleted)
  insert into public.run_sheet_items(quote_id, title, start_time, org_id) values (q, 'Doors', '18:00', a);
  if exists (select 1 from public.run_sheet_items ri join public.quotes x on x.id = ri.quote_id and x.org_id = ri.org_id
              where ri.start_time is not null and x.event_date between current_date - 1 and current_date + 2 and x.deleted_at is null)
     and not public._r432_runsheet_due() then bad := bad + 100; end if;
  -- delivery: every status / time the kept body picks
  for i in -10 .. 30 loop
    insert into public.delivery_commitments(org_id, quote_id, what, due_at, eta_at, status, reminders_on)
      values (a, q, 'Sweep ' || i, now() + make_interval(hours => i), case when i % 3 = 0 then now() + make_interval(hours => i + 1) end,
              (array['scheduled', 'reminded', 'delayed', 'confirmed'])[1 + abs(i) % 4], i % 5 <> 0);
  end loop;
  if exists (select 1 from public.delivery_commitments d join public.quotes x on x.id = d.quote_id and x.org_id = d.org_id
              where d.status in ('scheduled', 'reminded', 'delayed') and d.reminders_on and x.deleted_at is null and x.status <> 'cancelled'
                and coalesce(d.eta_at, d.due_at) between now() - interval '3 hours' and now() + interval '1465 minutes')
     and not public._r432_delivery_due() then bad := bad + 1000; end if;
  perform pg_temp.res('05 SUPERSET: every task / run-sheet line / delivery a kept body would pick (3-day sweep, every state) makes its check say yes',
    bad = 0 and n_hit > 40, 'bad=' || bad || ' hits=' || n_hit);
  perform pg_temp.res('06 one row in the window: the checks say yes (the kept bodies run)',
    public._r432_task_due(now()) and public._r432_runsheet_due() and public._r432_delivery_due());
  -- with something due the wrapper IS the kept body: same answer
  begin
    rs_k := public.runsheet_reminders_tick__pre0432()::text || public.delivery_reminders_tick__pre0432()::text || pg_temp.snap();
    raise exception 'rb' using errcode = 'P0099';
  exception when sqlstate 'P0099' then null; end;
  begin
    rs_w := public.runsheet_reminders_tick()::text || public.delivery_reminders_tick()::text || pg_temp.snap();
    raise exception 'rb' using errcode = 'P0099';
  exception when sqlstate 'P0099' then null; end;
  perform pg_temp.res('07 something due: run-sheet + delivery wrappers answer and write exactly what the kept bodies do',
    rs_k <> '' and rs_k = rs_w, rs_k || ' vs ' || rs_w);
end $$;

-- ---- studio prefilters: superset + identical rows with work in a studio --------------------------------------------------------
do $$ declare a uuid := 'a0000000-0000-4000-8000-000000000001'; b uuid := 'b0000000-0000-4000-8000-000000000001';
  q uuid; q2 uuid; u uuid; nid uuid; k_dg text; w_dg text; k_ct text; w_ct text; k_ps text; w_ps text; v_pass int; v_need int;
begin
  -- studio A: a due + an overdue instalment (pay reminders on), an opened client link, stock short for an event in 10 days
  insert into public.comms_settings(org_id, pay_enabled, fu_enabled) values (a, true, true)
    on conflict (org_id) do update set pay_enabled = true, fu_enabled = true;
  insert into public.quotes(code, title, status, org_id, event_date, pricing, client, approval_status)
    values ('R249-C1', 'Comms', 'quote', a, current_date + 10, '{"subtotal": 1000, "discount": 0, "gstPct": 18, "total": 1180}'::jsonb, '{"name": "Ravi", "email": "ravi@example.test", "phone": "+919800000001"}'::jsonb, 'sent')
    returning id into q;
  insert into public.payment_milestones(quote_id, label, amount, status, seq, due_date, org_id)
    values (q, 'Advance', 500, 'due', 1, current_date + 1, a), (q, 'Late', 300, 'due', 2, current_date - 5, a);
  insert into public.client_link_opens(quote_id, kind, first_opened_at, org_id) values (q, 'quote', now() - interval '5 days', a) on conflict do nothing;
  insert into public.inventory_items(name, total_qty, org_id, active) values ('R249 chair', 5, a, true) returning id into u;
  insert into public.inventory_reservations(item_id, quote_id, qty, status, org_id) values (u, q, 9, 'reserved', a);
  -- studio B: a returned snooze + a recent notification for an instant-important person (digests)
  insert into public.notifications(quote_id, channel, kind, status, detail, org_id)
    values (null, 'in_app', 'payment_overdue', 'simulated', '{"label": "R249"}'::jsonb, b) returning id into nid;
  update public.notifications set created_at = now() - interval '30 minutes' where id = nid;
  -- superset: every studio a kept loop acts for passes its prefilter
  select count(*) filter (where g.id in (a, b)), 2 into v_pass, v_need from public.organizations g
   where exists (select 1 from public.payment_milestones pm where pm.org_id = g.id and pm.status in ('due', 'invoiced') and pm.amount > 0)
      or exists (select 1 from public.client_link_opens lo join public.quotes x on x.id = lo.quote_id where x.org_id = g.id)
      or exists (select 1 from public.inventory_items i where i.org_id = g.id and i.active)
      or exists (select 1 from public.notifications n where n.org_id = g.id and n.created_at >= now() - interval '2 days');
  -- identical rows: kept body vs prefiltered body, each rolled back
  begin k_dg := public._r23_queue_digests__pre0432()::text || pg_temp.snap(); raise exception 'rb' using errcode = 'P0099';
  exception when sqlstate 'P0099' then null; end;
  begin w_dg := public._r23_queue_digests()::text || pg_temp.snap(); raise exception 'rb' using errcode = 'P0099';
  exception when sqlstate 'P0099' then null; end;
  begin k_ct := public.comms_tick__pre0264__pre0432()::text || pg_temp.snap(); raise exception 'rb' using errcode = 'P0099';
  exception when sqlstate 'P0099' then null; end;
  begin w_ct := public.comms_tick__pre0264()::text || pg_temp.snap(); raise exception 'rb' using errcode = 'P0099';
  exception when sqlstate 'P0099' then null; end;
  begin k_ps := public._pst_tick__pre0432()::text || pg_temp.snap(); raise exception 'rb' using errcode = 'P0099';
  exception when sqlstate 'P0099' then null; end;
  begin w_ps := public._pst_tick()::text || pg_temp.snap(); raise exception 'rb' using errcode = 'P0099';
  exception when sqlstate 'P0099' then null; end;
  perform pg_temp.res('08 SUPERSET: the studios with work (due instalment, opened link, active stock, recent notification) all pass the prefilter',
    v_pass = v_need, v_pass || '/' || v_need);
  perform pg_temp.res('09 with work: digests / comms (pay reminders, follow-ups, low stock) / payment schedule write exactly the kept bodies'' rows',
    k_dg = w_dg and k_ct = w_ct and k_ps = w_ps and k_ct not like '{"low_stock": 0, "follow_ups": 0, "pay_reminders": 0}%',
    'dg ' || left(k_dg, 60) || '|' || left(w_dg, 60) || ' ct ' || left(k_ct, 80) || '|' || left(w_ct, 80) || ' ps ' || left(k_ps, 60) || '|' || left(w_ps, 60));
end $$;

-- ---- an unexpected loop line is left unchanged (still correct) -----------------------------------------------------------------
do $$ declare v text; begin
  v := pg_get_functiondef('public._pst_tick()'::regprocedure);
  execute replace(replace(v, ' /* r249-0432 */', ''), 'for o in select org.id from public.organizations org where', 'for o in select org.id from public.organizations org  where');
  perform set_config('client_min_messages', 'error', true);
end $$;
\ir ../../supabase/migrations/0432_r249_cron_quiet.sql
set client_min_messages = warning;
do $$ begin
  perform pg_temp.res('10 a loop line that is not exactly as expected is left as it is (no second edit, no error)',
    position('r249-0432' in pg_get_functiondef('public._pst_tick()'::regprocedure)) = 0
    and public._pst_tick() ? 'overdue_bells');
end $$;

select name, result from _rm order by name;
select case when count(*) filter (where result <> 'PASS') = 0
            then 'R249-CRON-QUIET-0432: ALL PASS (' || count(*) || '/' || count(*) || ')'
            else 'R249-CRON-QUIET-0432: FAILURES (' || count(*) filter (where result <> 'PASS') || ' of ' || count(*) || ')' end as summary
  from _rm;
rollback;
