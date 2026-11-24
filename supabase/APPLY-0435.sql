-- APPLY-0435 (R252: payment plan, advance and approval). Run on STAGING first, then Canada production, then HELM-PROD-MUMBAI.
-- Run 0434 first (order 0434, then 0435). Safe to run twice. Needs 0264, 0282, 0285, 0307, 0321, 0341, 0377, 0404 (all on staging and
-- production); it stops before changing anything if one is missing. Does NOT need 0423-0425 or 0430.
-- What it does:
--   * a built-in plan with 4 payments, and the planner's own plan (1 - 8 payments);
--   * the advance percentage of the studio can be changed for one event, with a reason that is kept;
--   * no payment reminder / overdue before the client approves or the booking is confirmed; "on approval" payments count from that day;
--   * a booking confirmed by an advance is recorded as that, and the client can still approve afterwards;
--   * recording a payment moves the stage to Confirmed at most, unless Planning is really open (menu locked + layout).
-- No payment, milestone or receipt is changed and nothing is deleted. No edge function to deploy.
-- It waits at most 5 seconds for a lock (then stops with an error and changes nothing - just run it again later).
-- Paste the whole file into the Supabase SQL editor and press Run. The last result lists checks - every ok must be true.
begin;
set local lock_timeout = '5s';
set local statement_timeout = '5min';

-- 0435_r252_payment_plan.sql - R252 "Payment plan, advance and approval" (owner, 25 Nov 2026; approved for STAGING first, later
-- Canada production and Mumbai). Forward-only, additive, safe to run twice. ASCII only.
-- REQUIRES 0042, 0052, 0110, 0156, 0198, 0264, 0282, 0285, 0307, 0321, 0341, 0377, 0404, 0432 (0434 may be there or not).
--
-- In plain words:
--   1  One more built-in plan: "25 / 25 / 25 / 25" (on approval, 30 days before, 15 days before, on the event day). Full payment,
--      2 payments (50 / 50) and 3 payments (30 / 50 / 20) are the built-ins that exist already. It may be the studio's default.
--   2  payment_schedule_apply_custom: the planner's own plan (1 - 8 payments: percent, fixed amount, one "rest"), with the checks,
--      rounding, permission, locks and audit of payment_schedule_apply. Only when the event has no plan. Preview writes nothing.
--      Re-priced later = re-split like a template plan (0321). Every plan made from now on remembers its rules (plan_lines).
--   3  The advance percentage: the studio's (pricing config advancePct - the one Settings / onboarding already save). New switch
--      payment_schedule_settings.advance_fixed (default true). One event may have its own percentage with a reason; every change
--      is kept (quote_advance_log) and audited. Helm never refuses a payment of another amount - it only says the number.
--   4  Until the client approves or the booking is confirmed: no automatic payment reminder, no "overdue" (schedule card, client
--      page, event money), no overdue bell. "Send reminder now" still works. On the day of approval / confirmation, an unpaid
--      plan payment that is due "on approval" gets that day (an earlier date never stays behind); a payment whose date, name,
--      amount or status was changed by hand is left alone.
--   5  A booking confirmed by an advance without client approval stays allowed, and is recorded as exactly that
--      (quote_advance_log 'advance_confirm' + audit; basis 'advance' / 'client' / 'studio' in the read functions).
--      approval_status keeps its meaning ('paid'). The client can still approve with the normal link (before: "already approved",
--      no consent was kept); the consent is stored and approval_status stays 'paid'.
--   6  Recording a payment moves the stage to Confirmed at most. It lands on Planning only when the 0198 planning gate is open
--      (menu locked + layout, price not stale).
-- ZERO DATA LOSS: 1 new table, 3 new columns (empty / default), 1 check constraint widened by one value, functions, 1 trigger. No payment, milestone
-- or receipt row is changed or deleted by this file; amounts are never changed by anything in it.
-- Each edit of an existing function is ONE exact piece of its body (0432 way; old body kept as <name>__pre0435; unexpected = left).
-- ROLLBACK (manual, only if ever needed): alter table public.quotes disable trigger zzzz_r435_dates; and for each kept body:
--   create the function again from <name>__pre0435. The table and the columns can stay (unused).

-- ---- 0) preflight -----------------------------------------------------------------------------------------------------------
do $$ declare f text; begin
  if to_regclass('public.payment_schedule_quote_prefs') is null or to_regclass('public.payment_milestones') is null then
    raise exception 'STOP 0435: run 0264 first (payment schedules missing)'; end if;
  foreach f in array array['public._pst_apply(uuid,text,text,uuid)', 'public._pst_resolve(uuid,text)', 'public._pst_lines_clean(jsonb)',
      'public._pst_compute(jsonb,numeric,date,date)', 'public._pst_today(uuid)', 'public._pst_allocate(uuid)', 'public._pst_tick()',
      'public._comms_queue_pay(uuid,text,text,boolean,uuid)', 'public.comms_outbox_claim__pre0283(integer)',
      'public.payment_schedule_for_quote(uuid)', 'public.public_payment_schedule(uuid)', 'public.payment_schedule_settings_get()',
      'public.payment_schedule_settings_set(jsonb)', 'public.payment_schedule_settings_set__pre0285(jsonb)',
      'public.record_payment(uuid,numeric,text,text,uuid,text,text)', 'public.record_payment__pre0042(uuid,numeric,text,text,uuid,text,text)',
      'public._a198_stage_blockers(uuid,text)', 'public._a52_stage_idx(text)', 'public._a52_has_consent(uuid)',
      'public._r307_verify(uuid,text,text,boolean,text,text,text,text)', 'public.verify_and_consent__base(uuid,text,text,boolean,text,text,text,text)',
      'public.public_get_quote(uuid)', 'public.event_money_header(uuid)', 'public.event_money_cash(uuid)', 'public.helm_invoice_total(uuid)',
      'public._r282_event_closed(uuid)', 'public._r404_frozen(uuid)', 'public.has_area(text,text)', 'public.current_org_id()'] loop
    if to_regprocedure(f) is null then raise exception 'STOP 0435: % is missing - an earlier update is not on this database', f; end if;
  end loop;
  if not exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'payment_milestones' and column_name = 'voided_at') then
    raise exception 'STOP 0435: run 0404 first (payment_milestones.voided_at missing)'; end if;
end $$;

-- ---- 1) columns + the append-only history ----------------------------------------------------------------------------------------
alter table public.payment_schedule_settings add column if not exists advance_fixed boolean not null default true;
alter table public.payment_schedule_quote_prefs add column if not exists plan_lines jsonb;
alter table public.payment_schedule_quote_prefs add column if not exists approved_on date;

create table if not exists public.quote_advance_log (
  id          uuid primary key default gen_random_uuid(),
  org_id      uuid not null references public.organizations(id),
  quote_id    uuid not null references public.quotes(id) on delete cascade,
  kind        text not null,
  pct         numeric,
  reason      text,
  amount      numeric,
  receipt_no  text,
  actor       uuid,
  actor_email text,
  created_at  timestamptz not null default clock_timestamp(),
  constraint quote_advance_log_kind_chk435 check (kind in ('override', 'override_clear', 'advance_confirm')),
  constraint quote_advance_log_pct_chk435 check ((kind = 'override') = (pct is not null) and (pct is null or (pct >= 0 and pct <= 100))),
  constraint quote_advance_log_reason_chk435 check (case when kind = 'override' then reason is not null and char_length(reason) between 5 and 300
                                                          else reason is null or char_length(reason) <= 300 end)
);
create index if not exists quote_advance_log_quote435 on public.quote_advance_log (quote_id, created_at desc);
create index if not exists quote_advance_log_org435 on public.quote_advance_log (org_id);
create unique index if not exists quote_advance_log_confirm_uk435 on public.quote_advance_log (quote_id) where kind = 'advance_confirm';

alter table public.quote_advance_log enable row level security;
do $$ declare r text; v_def text; begin
  revoke all on table public.quote_advance_log from public;
  foreach r in array array['anon', 'authenticated', 'service_role'] loop
    if exists (select 1 from pg_roles where rolname = r) then execute format('revoke all on table public.quote_advance_log from %I', r); end if;
  end loop;
  if exists (select 1 from pg_roles where rolname = 'service_role') then execute 'grant select on table public.quote_advance_log to service_role'; end if;
  if to_regprocedure('public.tg_quote_org_match()') is not null
     and not exists (select 1 from pg_trigger where tgrelid = 'public.quote_advance_log'::regclass and tgname = 'zz_quote_org_match') then
    create trigger zz_quote_org_match before insert or update on public.quote_advance_log for each row execute function public.tg_quote_org_match();
  end if;
  if to_regprocedure('public.tg_studio_read_only()') is not null
     and not exists (select 1 from pg_trigger where tgrelid = 'public.quote_advance_log'::regclass and tgname = 'zzz_studio_read_only') then
    create trigger zzz_studio_read_only before insert or update or delete on public.quote_advance_log for each row execute function public.tg_studio_read_only('org_id');
  end if;
  -- free-trial retention (0184): goes with the studio's events (patched in place once, like 0264 / 0434)
  if to_regprocedure('public._tr184_purge_tables()') is not null then
    v_def := pg_get_functiondef('public._tr184_purge_tables()'::regprocedure);
    if position('''quote_advance_log''' in v_def) = 0 then
      if (length(v_def) - length(replace(v_def, '''payment_schedule_quote_prefs'', ', ''))) / length('''payment_schedule_quote_prefs'', ') <> 1 then
        raise notice '0435: _tr184_purge_tables has an unexpected body - left unchanged';
      else execute replace(v_def, '''payment_schedule_quote_prefs'', ', '''quote_advance_log'', ''payment_schedule_quote_prefs'', '); end if;
    end if;
  end if;
end $$;

-- the studio default may be the new built-in too (the same check + one more value; every stored value passes both)
do $$ begin
  if not exists (select 1 from pg_constraint where conrelid = 'public.payment_schedule_settings'::regclass and contype = 'c'
                   and pg_get_constraintdef(oid) like '%25-25-25-25%') then
    alter table public.payment_schedule_settings
      drop constraint if exists payment_schedule_settings_default_builtin_check,
      add constraint payment_schedule_settings_default_builtin_check
        check (default_builtin in ('30-50-20', '50-50', '100-upfront', '25-25-25-25'));
  end if;
end $$;

-- ---- 2) keep helper (same shape as _r434_keep) -----------------------------------------------------------------------------------
create or replace function public._r435_keep(p_fn text)
returns void language plpgsql volatile security definer set search_path = '' as $$
declare v_oid oid := to_regprocedure(p_fn); v_name text; v_types text; v_def text; v_pre text; r text;
begin
  if v_oid is null then return; end if;
  select p.proname, oidvectortypes(p.proargtypes) into v_name, v_types from pg_proc p where p.oid = v_oid;
  v_pre := format('public.%I(%s)', v_name || '__pre0435', v_types);
  if to_regprocedure(v_pre) is null then
    v_def := pg_get_functiondef(v_oid);
    v_def := regexp_replace(v_def, '^CREATE OR REPLACE FUNCTION public\.' || v_name || '\(',
                            'CREATE OR REPLACE FUNCTION public.' || v_name || '__pre0435(');
    if position(v_name || '__pre0435(' in v_def) = 0 then raise exception 'r252-0435: could not keep %', p_fn; end if;
    execute v_def;
  end if;
  execute format('revoke all on function %s from public', v_pre);
  foreach r in array array['anon', 'authenticated', 'service_role'] loop
    if exists (select 1 from pg_roles where rolname = r) then execute format('revoke all on function %s from %I', v_pre, r); end if;
  end loop;
end $$;

-- ---- 3) helpers (server only) --------------------------------------------------------------------------------------------------------
-- is the plan still waiting for the client? (not approved and the booking not confirmed)
create or replace function public._r435_waiting(p_approval text, p_status text, p_stage text)
returns boolean language sql immutable security definer set search_path = '' as $$
  -- r252-0435
  select coalesce(p_approval, 'none') not in ('approved', 'paid') and coalesce(p_status, '') <> 'confirmed'
     and coalesce(public._a52_stage_idx(p_stage), 4) < 5;
$$;
create or replace function public._r435_held(p_quote uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  -- r252-0435
  select coalesce((select public._r435_waiting(q.approval_status, q.status, q.lifecycle_stage) from public.quotes q where q.id = p_quote), false);
$$;
-- the stage after a recorded payment: Planning only when its 0198 gate is open, else Confirmed
create or replace function public._r435_pay_stage(p_quote uuid)
returns text language sql stable security definer set search_path = '' as $$
  -- r252-0435
  select case when jsonb_array_length(public._a198_stage_blockers(p_quote, 'planning')) = 0 then 'planning' else 'confirmed' end;
$$;
-- who said yes: the client (consent kept), an advance without it, or the studio
create or replace function public._r435_approval(p_quote uuid)
returns jsonb language sql stable security definer set search_path = '' as $$
  -- r252-0435
  select (select jsonb_build_object(
    'basis', case when x.has or q.approval_status = 'approved' then 'client'
                  when q.approval_status = 'paid' then 'advance'
                  when not public._r435_waiting(q.approval_status, q.status, q.lifecycle_stage) then 'studio' end,
    'client_approved', (x.has or q.approval_status = 'approved') and not coalesce(q.consent_stale, false),
    'stale', coalesce(q.consent_stale, false),
    'client_at', (select max(c.created_at) from public.quote_consents c where c.quote_id = q.id and c.agreed),
    'advance_at', case when not x.has and q.approval_status = 'paid' then coalesce(
        (select l.created_at from public.quote_advance_log l where l.quote_id = q.id and l.kind = 'advance_confirm'),
        (select min(coalesce(p.paid_at, p.created_at)) from public.quote_payments p where p.quote_id = q.id and p.status = 'paid')) end)
    from (select public._a52_has_consent(q.id) as has) x)
    from public.quotes q where q.id = p_quote;
$$;
-- two fields for the client's own page (the link is checked by public_get_quote before this runs)
create or replace function public._r435_public_approval(p_token uuid)
returns jsonb language sql stable security definer set search_path = '' as $$
  -- r252-0435
  select coalesce((select jsonb_build_object('client_approved', a.j -> 'client_approved', 'approval_basis', a.j -> 'basis')
                     from public.quotes q cross join lateral (select public._r435_approval(q.id) as j) a
                    where p_token is not null and q.approval_token = p_token), '{}'::jsonb);
$$;
-- record_payment found no client approval: say so once, in the history and the audit log (never blocks the payment)
create or replace function public._r435_confirmed(p_quote uuid, p_old_approval text, p_amount numeric, p_receipt text)
returns void language plpgsql volatile security definer set search_path = '' as $$
-- r252-0435
declare v_org uuid; v_mail text; v_id uuid;
begin
  if coalesce(p_old_approval, 'none') in ('approved', 'paid') or public._a52_has_consent(p_quote) then return; end if;
  select q.org_id into v_org from public.quotes q where q.id = p_quote;
  select u.email into v_mail from auth.users u where u.id = auth.uid();
  insert into public.quote_advance_log(org_id, quote_id, kind, amount, receipt_no, actor, actor_email)
    values (v_org, p_quote, 'advance_confirm', p_amount, left(p_receipt, 120), auth.uid(), v_mail)
    on conflict (quote_id) where kind = 'advance_confirm' do nothing returning id into v_id;
  if v_id is null then return; end if;
  insert into public.audit_log(actor, actor_email, action, entity, entity_id, quote_id, changed, org_id)
    values (auth.uid(), v_mail, 'booking.confirmed_by_advance', 'quotes', p_quote::text, p_quote,
            jsonb_build_object('amount', p_amount, 'receipt', p_receipt, 'client_approved', false), v_org);
exception when others then raise warning 'r252-0435: advance confirmation not recorded (%)', sqlstate;
end $$;

-- the rule a plan payment was made with ({anchor, offset_days}); null = made by hand, or its name / date was changed since
create or replace function public._r435_rule(p_quote uuid, p_milestone uuid)
returns jsonb language sql stable security definer set search_path = '' as $$
  -- r252-0435
  select jsonb_build_object('anchor', l.j ->> 'anchor', 'offset_days', (l.j ->> 'offset_days')::integer)
    from public.payment_schedule_quote_prefs p
    cross join lateral jsonb_array_elements(case when jsonb_typeof(p.plan_lines) = 'array' then p.plan_lines else '[]'::jsonb end) l(j)
    join public.payment_milestones m on m.quote_id = p.quote_id and m.id::text = l.j ->> 'id'
   where p.quote_id = p_quote and m.id = p_milestone and m.voided_at is null and m.label = l.j ->> 'label'
     and m.due_date is not distinct from (l.j ->> 'due_date')::date
   limit 1;
$$;
-- remember the rules of the plan just made (line n of the template = milestone seq n)
create or replace function public._r435_remember(p_quote uuid, p_lines jsonb)
returns void language plpgsql volatile security definer set search_path = '' as $$
-- r252-0435
begin
  update public.payment_schedule_quote_prefs p
     set plan_lines = (select jsonb_agg(jsonb_build_object('id', m.id, 'seq', m.seq, 'label', m.label, 'amount', m.amount, 'due_date', m.due_date,
                                'kind', e.l ->> 'kind', 'value', e.l -> 'value', 'anchor', e.l ->> 'anchor',
                                'offset_days', coalesce((e.l ->> 'offset_days')::integer, 0)) order by m.seq)
                         from jsonb_array_elements(p_lines) with ordinality e(l, n)
                         join public.payment_milestones m on m.quote_id = p_quote and m.seq = e.n),
         approved_on = case when not public._r435_held(p_quote) then public._pst_today(p.org_id) end,   -- made after the approval: nothing to wait for
         updated_at = now()
   where p.quote_id = p_quote;
end $$;
-- approval / confirmation day: an unpaid, untouched plan payment due "on approval" counts from that day; an untouched payment whose
-- date has passed while the plan was waiting is due that day. Dates only, forward only, never an amount. Idempotent.
-- A payment being recorded at this moment holds the lock: not waited for (it takes the event row too) - it does this step at its end.
create or replace function public._r435_dates(p_quote uuid)
returns integer language plpgsql volatile security definer set search_path = '' as $$
-- r252-0435
declare p public.payment_schedule_quote_prefs; e jsonb; n bigint; m public.payment_milestones; v_org uuid; v_today date; v_due date; v_n integer := 0;
        v_moved jsonb := '[]'::jsonb; v_lines jsonb;
begin
  if not pg_try_advisory_xact_lock(hashtextextended('helm:pay:quote:' || p_quote::text, 0)) then return 0; end if;
  select * into p from public.payment_schedule_quote_prefs x where x.quote_id = p_quote;
  if p.quote_id is null or jsonb_typeof(p.plan_lines) is distinct from 'array' then return 0; end if;
  select q.org_id into v_org from public.quotes q where q.id = p_quote and not coalesce(q.is_demo, false) and q.deleted_at is null
     and coalesce(q.status, '') <> 'cancelled';
  if v_org is null then return 0; end if;
  v_today := public._pst_today(v_org);
  if p.approved_on is not null and p.approved_on <> v_today then return 0; end if;      -- once: the first approval / confirmation day
  if public._r282_event_closed(p_quote) or public._r404_frozen(p_quote) then              -- closed / frozen money: noted, dates stay
    update public.payment_schedule_quote_prefs set approved_on = coalesce(approved_on, v_today), updated_at = now() where quote_id = p_quote;
    return 0;
  end if;
  v_lines := p.plan_lines;
  for e, n in select x, o from jsonb_array_elements(p.plan_lines) with ordinality t(x, o) loop
    select * into m from public.payment_milestones pm where pm.quote_id = p_quote and pm.id::text = e ->> 'id' and pm.status = 'due' and pm.voided_at is null;
    continue when m.id is null or m.label is distinct from e ->> 'label' or m.due_date is null or m.due_date is distinct from (e ->> 'due_date')::date;
    -- the amount is the plan's own, or the one the automatic re-split (0321) gave it
    continue when m.amount is distinct from (e ->> 'amount')::numeric
              and not exists (select 1 from public.audit_log a where a.quote_id = p_quote and a.action = 'payment_schedule.resynced'
                                and a.changed -> 'new' @> jsonb_build_array(jsonb_build_object('id', m.id, 'amount', m.amount)));
    v_due := case when e ->> 'anchor' = 'approval' then v_today + coalesce((e ->> 'offset_days')::integer, 0) else v_today end;
    continue when v_due <= m.due_date;
    update public.payment_milestones set due_date = v_due where id = m.id and status = 'due';
    v_lines := jsonb_set(v_lines, array[(n - 1)::text, 'due_date'], to_jsonb(v_due));
    v_moved := v_moved || jsonb_build_array(jsonb_build_object('id', m.id, 'label', m.label, 'from', m.due_date, 'to', v_due));
    v_n := v_n + 1;
  end loop;
  update public.payment_schedule_quote_prefs set plan_lines = v_lines, approved_on = v_today, updated_at = now() where quote_id = p_quote;
  if v_n > 0 then
    insert into public.audit_log(actor, action, entity, entity_id, quote_id, changed, org_id)
      values (auth.uid(), 'payment_schedule.dates_moved', 'quotes', p_quote::text, p_quote, jsonb_build_object('approved_on', v_today, 'rows', v_moved), v_org);
  end if;
  return v_n;
end $$;
-- after a recorded payment: a plan payment it did not fully cover gets its date too (only on the approval / confirmation day itself)
create or replace function public._r435_paid(p_quote uuid)
returns void language plpgsql volatile security definer set search_path = '' as $$
-- r252-0435
begin
  if not public._r435_held(p_quote) then perform public._r435_dates(p_quote); end if;
exception when others then raise warning 'r252-0435: plan dates not checked (%)', sqlstate;
end $$;
create or replace function public._r435_tg_dates()
returns trigger language plpgsql security definer set search_path = '' as $$
-- r252-0435: never blocks the approval
begin
  begin
    if public._r435_waiting(old.approval_status, old.status, old.lifecycle_stage)
       and not public._r435_waiting(new.approval_status, new.status, new.lifecycle_stage) then
      perform public._r435_dates(new.id);
    end if;
  exception when others then raise warning 'r252-0435: plan dates not moved (%)', sqlstate;
  end;
  return null;
end $$;
do $$ begin
  if not exists (select 1 from pg_trigger where tgrelid = 'public.quotes'::regclass and tgname = 'zzzz_r435_dates') then
    create trigger zzzz_r435_dates after update of approval_status, status, lifecycle_stage on public.quotes
      for each row when (old.approval_status is distinct from new.approval_status or old.status is distinct from new.status
                         or old.lifecycle_stage is distinct from new.lifecycle_stage)
      execute function public._r435_tg_dates();
  end if;
end $$;

-- the advance of one event: the studio's percentage or the event's own; money figures only with p_money
create or replace function public._r435_advance(p_quote uuid, p_money boolean)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
-- r252-0435
declare v_org uuid; v_raw text; v_studio numeric; v_fixed boolean; o public.quote_advance_log; v_pct numeric; v_total numeric; v_amt numeric;
        m record; v_first jsonb; v_rule jsonb;
begin
  select q.org_id into v_org from public.quotes q where q.id = p_quote;
  if v_org is null then return null; end if;
  select c.value ->> 'advancePct' into v_raw from public.app_config c where c.org_id = v_org and c.key = 'pricing';
  if coalesce(btrim(v_raw), '') ~ '^[0-9]{1,3}(\.[0-9]{1,6})?$' and v_raw::numeric <= 100 then v_studio := trim_scale(round(v_raw::numeric, 2)); end if;
  v_fixed := coalesce((select s.advance_fixed from public.payment_schedule_settings s where s.org_id = v_org), true);
  select * into o from public.quote_advance_log l where l.quote_id = p_quote and l.org_id = v_org and l.kind in ('override', 'override_clear')
   order by l.created_at desc, l.id desc limit 1;
  if o.kind is distinct from 'override' then o := null; end if;
  v_pct := coalesce(o.pct, v_studio);
  if p_money then
    v_total := public.helm_invoice_total(p_quote);
    if v_total > 0 and v_pct is not null then v_amt := round(v_total * v_pct / 100); end if;
    select pm.id, pm.label, pm.amount, pm.due_date, pm.status into m from public.payment_milestones pm
     where pm.quote_id = p_quote and pm.status <> 'waived' order by pm.due_date nulls last, pm.seq, pm.created_at, pm.id limit 1;
    if m.id is not null then
      v_rule := public._r435_rule(p_quote, m.id);
      v_first := jsonb_build_object('id', m.id, 'label', m.label, 'amount', m.amount, 'due_date', m.due_date, 'status', m.status,
        'percent', case when v_total > 0 then round(m.amount * 100 / v_total, 2) end,
        'is_advance', coalesce(v_rule ->> 'anchor' = 'approval', m.label ~* '\m(advance|booking|token|deposit)\M'));
    end if;
  end if;
  return jsonb_build_object('pct', v_pct, 'studio_pct', v_studio, 'fixed', v_fixed and v_pct is not null, 'studio_fixed', v_fixed,
    'source', case when o.id is not null then 'override' when v_studio is not null then 'studio' end,
    'override', case when o.id is null then null else jsonb_build_object('pct', o.pct, 'at', o.created_at)
      || case when p_money then jsonb_build_object('reason', o.reason, 'by', coalesce(
           (select nullif(btrim(p.full_name), '') from public.profiles p where p.id = o.actor and p.org_id = v_org), o.actor_email)) else '{}'::jsonb end end,
    'can_override', public.has_area('finance', 'edit') and public.has_area('discount_approve', 'edit'),
    'total', round(v_total, 2), 'amount', v_amt, 'plan_first', v_first,
    'differs', case when v_first is not null and (v_first ->> 'is_advance')::boolean and v_amt is not null
                    then abs((v_first ->> 'amount')::numeric - v_amt) > 1 end);
end $$;

-- ---- 4) the built-in plans: one more ----------------------------------------------------------------------------------------------------
do $$ begin
  if position('r252-0435' in pg_get_functiondef('public._pst_builtins()'::regprocedure)) = 0 then perform public._r435_keep('public._pst_builtins()'); end if;
end $$;
create or replace function public._pst_builtins()
returns jsonb language sql immutable set search_path = '' as $$
  -- pay-schedule-0264 + r252-0435: the built-in templates (always available, never stored) - the three of 0264 unchanged, then 4 payments
  select $b$[
    {"key":"builtin:30-50-20","name":"30 / 50 / 20","builtin":true,"lines":[
      {"label":"Advance (30%)","kind":"percent","value":30,"anchor":"approval","offset_days":0},
      {"label":"Second payment (50%)","kind":"percent","value":50,"anchor":"event","offset_days":-15},
      {"label":"Final balance (20%)","kind":"percent","value":20,"anchor":"event","offset_days":0}]},
    {"key":"builtin:50-50","name":"50 / 50","builtin":true,"lines":[
      {"label":"Advance (50%)","kind":"percent","value":50,"anchor":"approval","offset_days":0},
      {"label":"Balance (50%)","kind":"percent","value":50,"anchor":"event","offset_days":-7}]},
    {"key":"builtin:100-upfront","name":"100% upfront","builtin":true,"lines":[
      {"label":"Full payment (100%)","kind":"percent","value":100,"anchor":"approval","offset_days":0}]},
    {"key":"builtin:25-25-25-25","name":"25 / 25 / 25 / 25","builtin":true,"lines":[
      {"label":"Advance (25%)","kind":"percent","value":25,"anchor":"approval","offset_days":0},
      {"label":"Second payment (25%)","kind":"percent","value":25,"anchor":"event","offset_days":-30},
      {"label":"Third payment (25%)","kind":"percent","value":25,"anchor":"event","offset_days":-15},
      {"label":"Final balance (25%)","kind":"percent","value":25,"anchor":"event","offset_days":0}]}
  ]$b$::jsonb;
$$;

-- ---- 5) exact text edits of existing bodies (0432 way: every piece must be there exactly once, else the body is left as it is) -----------
do $do$
declare r record; v_oid oid; v_def text; v_new text; e jsonb; v_ok boolean;
begin
  for r in select * from (values
    -- a payment moves the stage to Confirmed at most (Planning only through its gate); a booking without client approval is recorded
    ('public.record_payment__pre0042(uuid,numeric,text,text,uuid,text,text)', jsonb_build_array(
      jsonb_build_array('then ''planning'' else lifecycle_stage end', 'then public._r435_pay_stage(quotes.id) /* r252-0435 */ else lifecycle_stage end'),
      jsonb_build_array('select business_email into studio_email from public.organizations where id = q.org_id;',
                        'perform public._r435_confirmed(p_quote, q.approval_status, p_amount, rno);
  select business_email into studio_email from public.organizations where id = q.org_id;'))),
    ('public.record_payment(uuid,numeric,text,text,uuid,text,text)', jsonb_build_array(
      jsonb_build_array('if v_n > 0 then v_out := v_out || jsonb_build_object(''milestones_covered'', v_n); end if;',
                        'perform public._r435_paid(p_quote); /* r252-0435 */
    if v_n > 0 then v_out := v_out || jsonb_build_object(''milestones_covered'', v_n); end if;'))),
    -- no automatic reminder, no overdue bell, no "overdue" while the plan waits for the client
    ('public._comms_queue_pay(uuid,text,text,boolean,uuid)', jsonb_build_array(
      jsonb_build_array('p.reminders_paused) then return 0; end if;',
                        'p.reminders_paused) then return 0; end if;
  if not coalesce(p_manual, false) and public._r435_held(q.id) /* r252-0435 */ then return 0; end if;'))),
    ('public.comms_outbox_claim__pre0283(integer)', jsonb_build_array(
      jsonb_build_array('and exists (select 1 from public.payment_schedule_quote_prefs p where p.quote_id = c.quote_id and p.reminders_paused);',
                        'and (exists (select 1 from public.payment_schedule_quote_prefs p where p.quote_id = c.quote_id and p.reminders_paused) or public._r435_held(c.quote_id) /* r252-0435 */);'))),
    ('public._pst_tick()', jsonb_build_array(
      jsonb_build_array('and not coalesce(q.is_demo, false) and public._comms_quote_live(q.id)',
                        'and not coalesce(q.is_demo, false) and public._comms_quote_live(q.id) and not public._r435_held(q.id) /* r252-0435 */'))),
    ('public.payment_schedule_for_quote(uuid)', jsonb_build_array(
      jsonb_build_array('when m.due_date is not null and m.due_date < v_today then ''overdue''',
                        'when m.due_date is not null and m.due_date < v_today and not public._r435_held(q.id) /* r252-0435 */ then ''overdue'''),
      jsonb_build_array('then m.due_date - v_today end, ''paid_at'', m.paid_at));', 'then m.due_date - v_today end, ''paid_at'', m.paid_at, ''rule'', public._r435_rule(q.id, m.id)));'),
      jsonb_build_array('''quote_id'', q.id, ''code'', q.code, ''currency''',
                        '''held'', public._r435_held(q.id), ''approval'', public._r435_approval(q.id), ''advance'', public._r435_advance(q.id, true),
    ''quote_id'', q.id, ''code'', q.code, ''currency'''))),
    ('public.public_payment_schedule(uuid)', jsonb_build_array(
      jsonb_build_array('when m.due_date is not null and m.due_date < v_today then ''overdue''',
                        'when m.due_date is not null and m.due_date < v_today and not public._r435_held(q.id) /* r252-0435 */ then ''overdue'''),
      jsonb_build_array('''state'', v_state, ''paid'', round(v_take, 2), ''remaining'', v_rem));',
                        '''state'', v_state, ''paid'', round(v_take, 2), ''remaining'', v_rem,
      ''on_approval'', coalesce(public._r435_rule(q.id, m.id) ->> ''anchor'' = ''approval'', false)));'),
      jsonb_build_array('''total'', round(public.helm_invoice_total(q.id), 2), ''paid''', '''held'', public._r435_held(q.id), ''total'', round(public.helm_invoice_total(q.id), 2), ''paid'''))),
    ('public.event_money_header(uuid)', jsonb_build_array(
      jsonb_build_array('case when (rm.due_date is not null and rm.due_date < v_today) or', 'case when (rm.due_date is not null and rm.due_date < v_today and not public._r435_held(p_quote) /* r252-0435 */) or'),
      jsonb_build_array('when (rm.due_date is not null and rm.due_date <= v_today + 3) or', 'when (rm.due_date is not null and rm.due_date <= v_today + 3 and not public._r435_held(p_quote)) or'))),
    ('public.event_money_cash(uuid)', jsonb_build_array(
      jsonb_build_array('''amount'', v_amt, ''late'', v_d < v_today, ''no_date''', '''amount'', v_amt, ''late'', v_d < v_today and not public._r435_held(p_quote) /* r252-0435 */, ''no_date'''),
      jsonb_build_array('''late'', r.due_date is not null and r.due_date < v_today);', '''late'', r.due_date is not null and r.due_date < v_today and not public._r435_held(p_quote));'),
      jsonb_build_array('if v_d < v_today then v_overdue := v_overdue + v_amt; end if;', 'if v_d < v_today and not public._r435_held(p_quote) then v_overdue := v_overdue + v_amt; end if;'))),
    -- an advance is not an approval: the client can still approve with the normal link; the booking stays "paid"
    ('public._r307_verify(uuid,text,text,boolean,text,text,text,text)', jsonb_build_array(
      jsonb_build_array('v_status in (''approved'', ''paid'') and not v_stale then',
                        'v_status in (''approved'', ''paid'') and not v_stale and not (v_status = ''paid'' and not public._a52_has_consent(v_q)) /* r252-0435 */ then'))),
    ('public.verify_and_consent__base(uuid,text,text,boolean,text,text,text,text)', jsonb_build_array(
      jsonb_build_array('update public.quotes set approval_status = ''approved'', updated_at = now() where id = q.id;',
                        'update public.quotes set approval_status = case when q.approval_status = ''paid'' and not coalesce(q.consent_stale, false) then ''paid'' else ''approved'' end /* r252-0435 */, updated_at = now() where id = q.id;'))),
    ('public.public_get_quote(uuid)', jsonb_build_array(
      jsonb_build_array('return public.public_get_quote__pre0341(p_token);', 'return public.public_get_quote__pre0341(p_token) || public._r435_public_approval(p_token) /* r252-0435 */;'))),
    ('public.payment_schedule_settings_set__pre0285(jsonb)', jsonb_build_array(
      jsonb_build_array('v_builtin not in (''30-50-20'', ''50-50'', ''100-upfront'')', 'v_builtin not in (''30-50-20'', ''50-50'', ''100-upfront'', ''25-25-25-25'') /* r252-0435 */')))
  ) v(fn, edits) loop
    v_oid := to_regprocedure(r.fn);
    if v_oid is null then raise notice '0435: % not on this database - left unchanged', r.fn; continue; end if;
    v_def := pg_get_functiondef(v_oid);
    if position('r252-0435' in v_def) > 0 then continue; end if;            -- already done (second run)
    v_new := v_def; v_ok := true;
    for e in select x from jsonb_array_elements(r.edits) x loop
      if (length(v_new) - length(replace(v_new, e ->> 0, ''))) / length(e ->> 0) <> 1 then v_ok := false; exit; end if;
      v_new := replace(v_new, e ->> 0, e ->> 1);
    end loop;
    if not v_ok then raise notice '0435: % has an unexpected body - left unchanged', r.fn; continue; end if;
    perform public._r435_keep(r.fn);
    execute v_new;
  end loop;
end $do$;

-- ---- 6) wrappers (same name, signature and grants; the old body kept as <name>__pre0435, server only) ---------------------------------------
do $$ begin
  perform public._r435_keep(f) from unnest(array['public._pst_apply(uuid,text,text,uuid)', 'public.payment_schedule_settings_get()',
    'public.payment_schedule_settings_set(jsonb)']) f
   where position('r252-0435' in pg_get_functiondef(to_regprocedure(f))) = 0;
end $$;

create or replace function public._pst_apply(p_quote uuid, p_key text, p_source text, p_actor uuid)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
-- r252-0435: the pay-schedule-0264 apply unchanged (kept as _pst_apply__pre0435), then the plan remembers the rules it was made with
declare v jsonb := public._pst_apply__pre0435(p_quote, p_key, p_source, p_actor); v_t jsonb;
begin
  if coalesce((v ->> 'applied')::boolean, false) then
    begin
      select public._pst_resolve(q.org_id, p_key) into v_t from public.quotes q where q.id = p_quote;
      if v_t ->> 'name' is not distinct from v ->> 'template' then perform public._r435_remember(p_quote, v_t -> 'lines'); end if;
    exception when others then raise warning 'r252-0435: plan rules not remembered (%)', sqlstate;
    end;
  end if;
  return v;
end $$;

create or replace function public.payment_schedule_settings_get()
returns jsonb language plpgsql stable security definer set search_path = '' as $$
-- r252-0435: the r35-0285 answer (its permission checks first) + the advance switch
declare v jsonb := public.payment_schedule_settings_get__pre0435(); v_org uuid := public.current_org_id(); v_raw text;
begin
  select c.value ->> 'advancePct' into v_raw from public.app_config c where c.org_id = v_org and c.key = 'pricing';
  return v || jsonb_build_object(
    'advance_fixed', coalesce((select s.advance_fixed from public.payment_schedule_settings s where s.org_id = v_org), true),
    'advance_pct', case when coalesce(btrim(v_raw), '') ~ '^[0-9]{1,3}(\.[0-9]{1,6})?$' and v_raw::numeric <= 100 then trim_scale(round(v_raw::numeric, 2)) end,
    'can_edit_advance_fixed', public.has_area('controls', 'edit') and public.has_area('discount_approve', 'edit'));
end $$;

create or replace function public.payment_schedule_settings_set(p jsonb)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
-- r252-0435: advance_fixed needs the right the percentage itself needs (set_pricing_config, 0300: Settings edit + admin or
-- "Approve discounts"); everything else = the r35-0285 save unchanged (its checks and its refusals first)
declare v_org uuid := public.current_org_id(); v_me uuid := auth.uid(); v_old boolean; v_new boolean;
begin
  if p is null or jsonb_typeof(p) <> 'object' or not (p ? 'advance_fixed') then return public.payment_schedule_settings_set__pre0435(p); end if;
  if jsonb_typeof(p -> 'advance_fixed') <> 'boolean' then raise exception 'advance_fixed must be true or false' using errcode = '22023'; end if;
  perform public.payment_schedule_settings_set__pre0435(p - 'advance_fixed');
  if not public.has_area('discount_approve', 'edit') then
    raise exception 'Only a studio admin, or someone allowed to "Approve discounts", can change the fixed advance.' using errcode = '42501', hint = 'pricing_right'; end if;
  v_new := (p ->> 'advance_fixed')::boolean;
  insert into public.payment_schedule_settings(org_id) values (v_org) on conflict (org_id) do nothing;
  select s.advance_fixed into v_old from public.payment_schedule_settings s where s.org_id = v_org for update;
  if v_old is distinct from v_new then
    update public.payment_schedule_settings set advance_fixed = v_new, updated_at = now(), updated_by = v_me where org_id = v_org;
    insert into public.audit_log(actor, action, entity, entity_id, changed, org_id)
      values (v_me, 'payment_schedule.settings', 'payment_schedule_settings', v_org::text, jsonb_build_object('advance_fixed', v_new), v_org);
  end if;
  return public.payment_schedule_settings_get();
end $$;

-- ---- 7) new RPCs for the app ------------------------------------------------------------------------------------------------------------------
-- the planner's own plan for an event WITHOUT a plan (Finance EDIT; preview: Finance VIEW, writes nothing)
create or replace function public.payment_schedule_apply_custom(p_quote uuid, p_lines jsonb, p_preview boolean default false)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
-- r252-0435: payment_schedule_apply (0264) with the lines given instead of a template
declare v_org uuid := public.current_org_id(); v_me uuid := auth.uid(); q public.quotes; v_lines jsonb; v_total numeric; v_rows jsonb; r jsonb;
        v_name text; v_n integer := 0;
begin
  if v_me is null or v_org is null then raise exception 'not authorized' using errcode = '42501'; end if;
  select * into q from public.quotes x where x.id = p_quote and x.org_id = v_org;
  if q.id is null then raise exception 'event not found' using errcode = '42501'; end if;
  if not (case when coalesce(p_preview, false) then public.has_area('finance', 'view') else public.has_area('finance', 'edit') end) then
    raise exception 'not authorized' using errcode = '42501'; end if;
  if exists (select 1 from public.payment_milestones m where m.quote_id = q.id) then
    raise exception 'This event already has a payment schedule - change it in Logistics > Payments.' using errcode = '22023'; end if;
  if p_lines is null or jsonb_typeof(p_lines) <> 'array' then raise exception 'Add at least one payment to the schedule.' using errcode = '22023'; end if;
  if jsonb_array_length(p_lines) > 8 then raise exception 'A plan can have at most 8 payments.' using errcode = '22023'; end if;
  if octet_length(p_lines::text) > 8000 then raise exception 'The plan is too large.' using errcode = '22023'; end if;
  -- the template words, plus "amount" (= fixed), "rest" (= balance) and the due rule as its own object
  select coalesce(jsonb_agg(case when jsonb_typeof(x) <> 'object' then x else jsonb_build_object('label', x ->> 'label',
           'kind', case x ->> 'kind' when 'amount' then 'fixed' when 'rest' then 'balance' else x ->> 'kind' end, 'value', x ->> 'value',
           'anchor', coalesce(x ->> 'anchor', x -> 'due' ->> 'anchor'), 'offset_days', coalesce(x ->> 'offset_days', x -> 'due' ->> 'offset_days')) end order by n), '[]'::jsonb)
    into v_lines from jsonb_array_elements(p_lines) with ordinality t(x, n);
  v_lines := public._pst_lines_clean(v_lines);
  v_total := public.helm_invoice_total(q.id);
  if v_total is null or v_total <= 0 then raise exception 'Price the quote first - the schedule is worked out from its total.' using errcode = '22023'; end if;
  if not coalesce(p_preview, false) then
    if q.deleted_at is not null or q.archived_at is not null or coalesce(q.status, '') = 'cancelled' then
      raise exception 'This event is cancelled or archived.' using errcode = '22023'; end if;
    perform pg_advisory_xact_lock(hashtextextended('helm:pay:quote:' || q.id::text, 0));
    if exists (select 1 from public.payment_milestones m where m.quote_id = q.id) then
      raise exception 'The payment schedule could not be added (has_schedule).' using errcode = '22023'; end if;
    v_total := public.helm_invoice_total(q.id);                                    -- again, under the lock
    if v_total is null or v_total <= 0 then raise exception 'Price the quote first - the schedule is worked out from its total.' using errcode = '22023'; end if;
  end if;
  v_rows := public._pst_compute(v_lines, v_total, public._pst_today(v_org), q.event_date);
  if jsonb_array_length(v_rows) <> jsonb_array_length(v_lines) then
    raise exception 'These payments do not fit the total (%) - at least one of them would be 0.', round(v_total, 2) using errcode = '22023', hint = 'plan_does_not_fit'; end if;
  if (select sum((x ->> 'amount')::numeric) from jsonb_array_elements(v_rows) x) is distinct from v_total then
    raise exception 'The payments do not add up to the total (%).', round(v_total, 2) using errcode = '22023', hint = 'plan_does_not_add_up'; end if;
  v_name := 'Custom (' || jsonb_array_length(v_rows) || case when jsonb_array_length(v_rows) = 1 then ' payment)' else ' payments)' end;
  select jsonb_agg(x || jsonb_build_object('anchor', v_lines -> ((x ->> 'seq')::integer - 1) ->> 'anchor',
           'offset_days', (v_lines -> ((x ->> 'seq')::integer - 1) ->> 'offset_days')::integer) order by (x ->> 'seq')::integer)
    into v_rows from jsonb_array_elements(v_rows) x;
  if coalesce(p_preview, false) then
    return jsonb_build_object('applied', false, 'preview', true, 'template', v_name, 'total', v_total, 'schedule', v_rows);
  end if;
  for r in select x from jsonb_array_elements(v_rows) x loop
    insert into public.payment_milestones(quote_id, org_id, label, due_date, amount, status, seq, note, created_by)
      values (q.id, q.org_id, r ->> 'label', (r ->> 'due_date')::date, (r ->> 'amount')::numeric, 'due', (r ->> 'seq')::integer, 'Payment schedule: ' || v_name, v_me);
    v_n := v_n + 1;
  end loop;
  insert into public.payment_schedule_quote_prefs(quote_id, org_id, applied_at, applied_by, applied_source, applied_template)
    values (q.id, q.org_id, now(), v_me, 'manual', v_name)
    on conflict (quote_id) do update set applied_at = excluded.applied_at, applied_by = excluded.applied_by,
      applied_source = excluded.applied_source, applied_template = excluded.applied_template, updated_at = now();
  perform public._r435_remember(q.id, v_lines);
  insert into public.audit_log(actor, action, entity, entity_id, quote_id, changed, org_id)
    values (v_me, 'payment_schedule.applied', 'quotes', q.id::text, q.id,
            jsonb_build_object('template', v_name, 'source', 'manual', 'rows', v_n, 'total', v_total, 'lines', v_lines), q.org_id);
  begin perform public._pst_allocate(q.id);                    -- money already received covers the first payments
  exception when others then raise warning 'r252-0435: cover skipped (%)', sqlstate;
  end;
  return jsonb_build_object('applied', true, 'rows', v_n, 'template', v_name, 'total', v_total, 'schedule', v_rows);
end $$;

-- the advance of one event (Finance or Quotes VIEW; amounts, reason and history only with Finance view)
create or replace function public.advance_get(p_quote uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
-- r252-0435
declare v_org uuid := public.current_org_id(); v_money boolean;
begin
  if auth.uid() is null or v_org is null then raise exception 'not authorized' using errcode = '42501'; end if;
  if not exists (select 1 from public.quotes q where q.id = p_quote and q.org_id = v_org) then raise exception 'event not found' using errcode = '42501'; end if;
  v_money := public.has_area('finance', 'view');
  if not (v_money or public.has_area('quotes', 'view')) then raise exception 'not authorized' using errcode = '42501'; end if;
  return public._r435_advance(p_quote, v_money) || jsonb_build_object('approval', public._r435_approval(p_quote),
    'history', case when v_money then coalesce((select jsonb_agg(jsonb_build_object('kind', l.kind, 'pct', l.pct, 'reason', l.reason, 'amount', l.amount,
         'receipt_no', l.receipt_no, 'at', l.created_at, 'by', coalesce((select nullif(btrim(p.full_name), '') from public.profiles p where p.id = l.actor and p.org_id = v_org), l.actor_email))
         order by l.created_at desc, l.id desc) from (select * from public.quote_advance_log x where x.quote_id = p_quote and x.org_id = v_org order by x.created_at desc, x.id desc limit 20) l), '[]'::jsonb)
       else '[]'::jsonb end);
end $$;

create or replace function public._r435_override(p_quote uuid, p_kind text, p_pct numeric, p_reason text)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
-- r252-0435: Finance EDIT and the right to change prices ("Approve discounts" - 0282 / 0300; an admin always has both)
declare v_org uuid := public.current_org_id(); v_me uuid := auth.uid(); q public.quotes; l public.quote_advance_log; v_mail text;
        v_reason text := nullif(btrim(regexp_replace(coalesce(p_reason, ''), '\s+', ' ', 'g')), '');
begin
  if v_me is null or v_org is null then raise exception 'not authorized' using errcode = '42501'; end if;
  select * into q from public.quotes x where x.id = p_quote and x.org_id = v_org;
  if q.id is null then raise exception 'event not found' using errcode = '42501'; end if;
  if not (public.has_area('finance', 'edit') and public.has_area('discount_approve', 'edit')) then
    raise exception 'Only a studio admin, or someone with Finance edit who may "Approve discounts", can change the advance of one event.'
      using errcode = '42501', hint = 'pricing_right'; end if;
  if q.deleted_at is not null or q.archived_at is not null or coalesce(q.status, '') = 'cancelled' then
    raise exception 'This event is cancelled or archived.' using errcode = '22023'; end if;
  if public._r282_event_closed(q.id) then raise exception 'This event is closed - re-open it first.' using errcode = '42501', hint = 'event_closed'; end if;
  if v_reason is not null and (char_length(v_reason) > 300 or v_reason ~ '[<>[:cntrl:]]') then
    raise exception 'Keep the reason to 300 characters, without < or >.' using errcode = '22023'; end if;
  if p_kind = 'override' then
    if p_pct is null or p_pct = 'NaN'::numeric or p_pct < 0 or p_pct > 100 then raise exception 'The advance must be between 0 and 100 %%.' using errcode = '22023'; end if;
    if v_reason is null or char_length(v_reason) < 5 then raise exception 'Give a reason of 5 to 300 characters.' using errcode = '22023'; end if;
  end if;
  perform pg_advisory_xact_lock(hashtextextended('helm:advance:quote:' || q.id::text, 0));
  select * into l from public.quote_advance_log x where x.quote_id = q.id and x.kind in ('override', 'override_clear') order by x.created_at desc, x.id desc limit 1;
  -- the same form again (or nothing to clear): no second row
  if (p_kind = 'override' and l.kind = 'override' and l.pct = round(p_pct, 2) and l.reason = v_reason)
     or (p_kind = 'override_clear' and l.kind is distinct from 'override') then return public.advance_get(q.id); end if;
  select u.email into v_mail from auth.users u where u.id = v_me;
  insert into public.quote_advance_log(org_id, quote_id, kind, pct, reason, actor, actor_email)
    values (v_org, q.id, p_kind, case when p_kind = 'override' then trim_scale(round(p_pct, 2)) end, v_reason, v_me, v_mail);
  insert into public.audit_log(actor, actor_email, action, entity, entity_id, quote_id, changed, org_id)
    values (v_me, v_mail, case when p_kind = 'override' then 'advance.override' else 'advance.override_cleared' end, 'quotes', q.id::text, q.id,
            jsonb_build_object('from', case when l.kind = 'override' then l.pct end, 'to', case when p_kind = 'override' then trim_scale(round(p_pct, 2)) end, 'reason', v_reason), v_org);
  return public.advance_get(q.id);
end $$;
create or replace function public.advance_override_set(p_quote uuid, p_pct numeric, p_reason text)
returns jsonb language sql volatile security definer set search_path = '' as $$
  -- r252-0435
  select public._r435_override(p_quote, 'override', p_pct, p_reason);
$$;
create or replace function public.advance_override_clear(p_quote uuid, p_reason text default null)
returns jsonb language sql volatile security definer set search_path = '' as $$
  -- r252-0435
  select public._r435_override(p_quote, 'override_clear', null, p_reason);
$$;

-- who said yes, for a list of events (Quotes VIEW, own studio; at most 500)
create or replace function public.quote_approval_basis(p_quotes uuid[])
returns jsonb language plpgsql stable security definer set search_path = '' as $$
-- r252-0435
declare v_org uuid := public.current_org_id();
begin
  if auth.uid() is null or v_org is null or not public.has_area('quotes', 'view') then raise exception 'not authorized' using errcode = '42501'; end if;
  if coalesce(cardinality(p_quotes), 0) > 500 then raise exception 'ask for at most 500 events' using errcode = '22023'; end if;
  return coalesce((select jsonb_agg(jsonb_build_object('quote_id', q.id) || public._r435_approval(q.id))
                     from public.quotes q where q.org_id = v_org and q.id = any (coalesce(p_quotes, '{}'::uuid[]))), '[]'::jsonb);
end $$;

-- ---- 8) grants: helpers server only; the new RPCs signed-in members only; the wrapped names keep exactly the grants they had -----------------
do $$ declare f text; r text; begin
  foreach f in array array['public._r435_keep(text)', 'public._r435_waiting(text,text,text)', 'public._r435_held(uuid)', 'public._r435_pay_stage(uuid)',
      'public._r435_approval(uuid)', 'public._r435_public_approval(uuid)', 'public._r435_confirmed(uuid,text,numeric,text)', 'public._r435_rule(uuid,uuid)',
      'public._r435_remember(uuid,jsonb)', 'public._r435_dates(uuid)', 'public._r435_paid(uuid)', 'public._r435_tg_dates()',
      'public._r435_advance(uuid,boolean)', 'public._r435_override(uuid,text,numeric,text)'] loop
    execute format('revoke all on function %s from public', f);
    foreach r in array array['anon', 'authenticated', 'service_role'] loop
      if exists (select 1 from pg_roles where rolname = r) then execute format('revoke all on function %s from %I', f, r); end if;
    end loop;
  end loop;
  foreach f in array array['public.payment_schedule_apply_custom(uuid,jsonb,boolean)', 'public.advance_get(uuid)', 'public.advance_override_set(uuid,numeric,text)',
      'public.advance_override_clear(uuid,text)', 'public.quote_approval_basis(uuid[])'] loop
    execute format('revoke all on function %s from public', f);
    foreach r in array array['anon', 'service_role'] loop
      if exists (select 1 from pg_roles where rolname = r) then execute format('revoke all on function %s from %I', f, r); end if;
    end loop;
    if exists (select 1 from pg_roles where rolname = 'authenticated') then execute format('grant execute on function %s to authenticated', f); end if;
  end loop;
  execute 'revoke all on function public._pst_apply(uuid,text,text,uuid) from public';
  if exists (select 1 from pg_roles where rolname = 'anon') then execute 'revoke all on function public._pst_apply(uuid,text,text,uuid) from anon, authenticated'; end if;
  foreach f in array array['public.payment_schedule_settings_get()', 'public.payment_schedule_settings_set(jsonb)'] loop
    execute format('revoke all on function %s from public', f);
    if exists (select 1 from pg_roles where rolname = 'anon') then execute format('revoke all on function %s from anon', f); end if;
    if exists (select 1 from pg_roles where rolname = 'authenticated') then execute format('grant execute on function %s to authenticated', f); end if;
  end loop;
end $$;

do $$ begin
  if to_regclass('public.helm_schema_markers') is not null then
    insert into public.helm_schema_markers(num, name) values (435, '0435_r252_payment_plan') on conflict (num) do nothing;
  end if;
end $$;

notify pgrst, 'reload schema';

-- ---- checks (every ok must be true) --------------------------------------------------------------------------------------
select item, ok from (values
  ('01 history table: closed to the app, server reads only',
     (select c.relrowsecurity from pg_class c where c.oid = to_regclass('public.quote_advance_log'))
     and not has_table_privilege('anon', 'public.quote_advance_log', 'select, insert, update, delete')
     and not has_table_privilege('authenticated', 'public.quote_advance_log', 'select, insert, update, delete')
     and not has_table_privilege('service_role', 'public.quote_advance_log', 'insert, update, delete')),
  ('02 new columns (empty; the switch on by default)',
     (select count(*) = 3 from information_schema.columns where table_schema = 'public' and ((table_name = 'payment_schedule_settings' and column_name = 'advance_fixed' and column_default = 'true')
     or (table_name = 'payment_schedule_quote_prefs' and column_name in ('plan_lines', 'approved_on'))))),
  ('03 trigger on quotes is there and switched on',
     exists (select 1 from pg_trigger where tgrelid = 'public.quotes'::regclass and tgname = 'zzzz_r435_dates' and tgenabled = 'O')),
  ('04 four built-in plans, the new one may be the default',
     (select jsonb_array_length(public._pst_builtins()) = 4) and exists (select 1 from pg_constraint where conrelid = 'public.payment_schedule_settings'::regclass and contype = 'c' and convalidated and pg_get_constraintdef(oid) like '%25-25-25-25%')
     and coalesce(position('r252-0435' in pg_get_functiondef(to_regprocedure('public.payment_schedule_settings_set__pre0285(jsonb)'))) > 0, false)),
  ('05 new helpers server only, empty search_path',
     (select count(*) = 14 and bool_and(p.prosecdef and p.proconfig @> array['search_path=""']
     and not has_function_privilege('anon', p.oid, 'execute') and not has_function_privilege('authenticated', p.oid, 'execute'))
     from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname like '\_r435\_%')),
  ('06 kept bodies server only',
     (select count(*) >= 17 and bool_and(not has_function_privilege('anon', p.oid, 'execute') and not has_function_privilege('authenticated', p.oid, 'execute'))
     from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname like '%\_\_pre0435')),
  ('07 a payment moves the stage to Confirmed at most, an advance is recorded',
     coalesce(position('r252-0435' in pg_get_functiondef(to_regprocedure('public.record_payment__pre0042(uuid,numeric,text,text,uuid,text,text)'))) > 0, false) and coalesce(position('r252-0435' in pg_get_functiondef(to_regprocedure('public.record_payment(uuid,numeric,text,text,uuid,text,text)'))) > 0, false)),
  ('08 no reminder and no overdue bell before the approval',
     coalesce(position('r252-0435' in pg_get_functiondef(to_regprocedure('public._comms_queue_pay(uuid,text,text,boolean,uuid)'))) > 0, false) and coalesce(position('r252-0435' in pg_get_functiondef(to_regprocedure('public.comms_outbox_claim__pre0283(integer)'))) > 0, false) and coalesce(position('r252-0435' in pg_get_functiondef(to_regprocedure('public._pst_tick()'))) > 0, false)),
  ('09 schedule card + client page know "waiting for approval"',
     coalesce(position('r252-0435' in pg_get_functiondef(to_regprocedure('public.payment_schedule_for_quote(uuid)'))) > 0, false) and coalesce(position('r252-0435' in pg_get_functiondef(to_regprocedure('public.public_payment_schedule(uuid)'))) > 0, false)),
  ('10 event money not late before the approval',
     coalesce(position('r252-0435' in pg_get_functiondef(to_regprocedure('public.event_money_header(uuid)'))) > 0, false) and coalesce(position('r252-0435' in pg_get_functiondef(to_regprocedure('public.event_money_cash(uuid)'))) > 0, false)),
  ('11 the client can approve after an advance',
     coalesce(position('r252-0435' in pg_get_functiondef(to_regprocedure('public._r307_verify(uuid,text,text,boolean,text,text,text,text)'))) > 0, false) and coalesce(position('r252-0435' in pg_get_functiondef(to_regprocedure('public.verify_and_consent__base(uuid,text,text,boolean,text,text,text,text)'))) > 0, false) and coalesce(position('r252-0435' in pg_get_functiondef(to_regprocedure('public.public_get_quote(uuid)'))) > 0, false)),
  ('12 plan rules remembered, settings wrapped, access as before',
     coalesce(position('r252-0435' in pg_get_functiondef(to_regprocedure('public._pst_apply(uuid,text,text,uuid)'))) > 0, false) and coalesce(position('r252-0435' in pg_get_functiondef(to_regprocedure('public.payment_schedule_settings_get()'))) > 0, false) and coalesce(position('r252-0435' in pg_get_functiondef(to_regprocedure('public.payment_schedule_settings_set(jsonb)'))) > 0, false)
     and not has_function_privilege('authenticated', 'public._pst_apply(uuid,text,text,uuid)', 'execute') and has_function_privilege('authenticated', 'public.payment_schedule_settings_set(jsonb)', 'execute')
     and not has_function_privilege('anon', 'public.payment_schedule_settings_set(jsonb)', 'execute') and has_function_privilege('anon', 'public.public_get_quote(uuid)', 'execute')
     and has_function_privilege('anon', 'public.public_payment_schedule(uuid)', 'execute') and has_function_privilege('authenticated', 'public.record_payment(uuid,numeric,text,text,uuid,text,text)', 'execute')
     and not has_function_privilege('anon', 'public.record_payment(uuid,numeric,text,text,uuid,text,text)', 'execute')),
  ('13 five new calls: signed-in members only',
     (select count(*) = 5 and bool_and(p.prosecdef and p.proconfig @> array['search_path=""'] and has_function_privilege('authenticated', p.oid, 'execute') and not has_function_privilege('anon', p.oid, 'execute'))
     from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public'
      and p.proname in ('payment_schedule_apply_custom', 'advance_get', 'advance_override_set', 'advance_override_clear', 'quote_approval_basis'))),
  ('14 schema marker 435 recorded (or no 0412 marker table)',
     to_regclass('public.helm_schema_markers') is null or exists (select 1 from public.helm_schema_markers where num = 435))
) v(item, ok) order by item;
commit;
