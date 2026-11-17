-- 0376_r197_event_money_header.sql - R197 "P&L clarity" phase 1 (owner, 17 Nov 2026: PNL-CLARITY-PLAN.md phase 1 +
-- mockups/pnl). Forward-only, additive, safe to run twice. ASCII only.
-- REQUIRES 0242 (studio target margin in app_config 'insights'), 0246 + 0252 + 0265 (_r21_event_money / _vb_event_pnl:
--          the event cost ledger), 0372 (money_settings, _r372_cfg, _r372_flag, _r372_current_snapshot, _r372_tds, frozen P&L),
--          0373 (_r373_open: what is still to pay on a vendor bill), 0110 (helm_invoice_total, helm_total_paid), 0287 (studio_today).
--
-- In plain words:
--   1  ONE READ CALL FOR THE MONEY HEADER. event_money_header(quote) returns, for the Budget, Settlement, Closure and event
--      pages: Quoted (with GST), Received (+ client TDS) and the balance, Costs (Expected before the event is closed,
--      Actual after) against the Plan, Profit and margin % against the studio target with a traffic light, the two
--      categories that pulled the margin down, the cost per category (Plan / Expected or Actual / difference / the
--      studio's big-gap flag from 0372) with the cost lines behind each, and up to three "Needs attention" items (next
--      vendor bill to pay, money to collect, margin below target, categories over plan, unplanned spends, damage & loss,
--      crew attendance not confirmed). It only READS: it composes _vb_event_pnl (the frozen figure for a closed + frozen
--      event, 0372), the frozen snapshot / the live ledger (_r21_event_money), the vendor bills (0373) and the payments.
--      Nothing is stored. A closed + frozen event shows its frozen numbers and "Frozen vN"; the live figure only as a note.
--   2  TRAFFIC LIGHT. Green = margin at or above the target, amber = up to N points below, red = more than N below or a
--      loss. N is a new studio money rule, money_settings.margin_band (default 5 points, 0 to 50), saved with the other
--      money rules (money_settings_get / money_settings_set wrapped once, old bodies kept as __pre0376).
--   3  TARGET MARGIN. The ONE studio target from 0242 (Settings, also used by Insights). Not set = 25% (owner, 17 Nov 2026;
--      was 30%): get_studio_target_margin re-issued in place with default_pct 25, nothing else changed.
-- ACCESS: event_money_header needs a signed-in studio member with Finance view (owner / admin always; other roles as the
--   studio's access matrix says); a client account, anon and crew / vendor links are refused (42501); an event of another
--   studio (or a deleted one) answers null. Per-person crew pay stays admin-only: other roles see one "Crew wages" line.
-- ZERO DATA LOSS: one new column with a default (money_settings.margin_band; no existing row rewritten), two functions
--   wrapped once (old bodies kept), one re-issued in place with the same inputs and grants, new read-only functions.
--   No table, column, row, policy or trigger is dropped or changed.
-- ROLLBACK (manual, only if ever needed; no data involved): drop function public.event_money_header(uuid);
--   drop function public.money_settings_get(); alter function public.money_settings_get__pre0376() rename to money_settings_get;
--   drop function public.money_settings_set(jsonb); alter function public.money_settings_set__pre0376(jsonb) rename to money_settings_set;
--   re-grant both to authenticated; re-run the 0242 body of get_studio_target_margin. The margin_band column can stay.

-- ---- 0) preflight -------------------------------------------------------------------------------------------------------------
do $$ begin
  if to_regclass('public.money_settings') is null or to_regprocedure('public._r372_cfg(uuid)') is null
     or to_regprocedure('public._r372_flag(numeric,numeric,jsonb)') is null or to_regprocedure('public._r372_current_snapshot(uuid)') is null
     or to_regprocedure('public._r372_tds(uuid)') is null or to_regprocedure('public._vb_event_pnl__pre0372(uuid,uuid)') is null then
    raise exception 'STOP 0376: apply 0372 (money lock) first'; end if;
  if to_regprocedure('public.money_settings_get()') is null and to_regprocedure('public.money_settings_get__pre0376()') is null then
    raise exception 'STOP 0376: money_settings_get is missing (apply 0372 first)'; end if;
  if to_regprocedure('public.money_settings_set(jsonb)') is null and to_regprocedure('public.money_settings_set__pre0376(jsonb)') is null then
    raise exception 'STOP 0376: money_settings_set is missing (apply 0372 first)'; end if;
  if to_regprocedure('public._r21_event_money(uuid,uuid,boolean)') is null or to_regprocedure('public._vb_event_pnl(uuid,uuid)') is null then
    raise exception 'STOP 0376: apply 0246 (the event cost ledger) first'; end if;
  if to_regprocedure('public._r373_open(uuid)') is null then raise exception 'STOP 0376: apply 0373 (vendor bills) first'; end if;
  if to_regprocedure('public.get_studio_target_margin()') is null or to_regclass('public.app_config') is null then
    raise exception 'STOP 0376: apply 0242 (studio target margin) first'; end if;
  if to_regprocedure('public.helm_invoice_total(uuid)') is null or to_regprocedure('public.helm_total_paid(uuid,uuid,uuid)') is null then
    raise exception 'STOP 0376: helm_invoice_total / helm_total_paid missing (apply 0110 first)'; end if;
  if to_regprocedure('public.studio_today(uuid,timestamp with time zone)') is null then raise exception 'STOP 0376: apply 0287 first'; end if;
  if to_regprocedure('public.has_area(text,text)') is null or to_regprocedure('public.is_admin()') is null
     or to_regprocedure('public.current_org_id()') is null or to_regprocedure('public.user_role()') is null then
    raise exception 'STOP 0376: has_area / is_admin / current_org_id / user_role missing'; end if;
  if to_regclass('public.vendor_bills') is null or to_regclass('public.payment_milestones') is null or to_regclass('public.event_closure') is null then
    raise exception 'STOP 0376: vendor_bills / payment_milestones / event_closure missing'; end if;
end $$;

-- ---- 1) the traffic-light band (a money rule; default 5 points) ---------------------------------------------------------------
alter table public.money_settings add column if not exists margin_band numeric not null default 5;
do $$ begin
  if not exists (select 1 from pg_constraint where conrelid = 'public.money_settings'::regclass and conname = 'money_settings_margin_band_0376_ck') then
    alter table public.money_settings add constraint money_settings_margin_band_0376_ck check (margin_band >= 0 and margin_band <= 50);
  end if;
end $$;
comment on column public.money_settings.margin_band is
  '0376: traffic light - amber while the margin is up to this many points below the target margin, red beyond (default 5)';

-- ---- 2) the studio target margin: the 0242 body, default 25 % ---------------------------------------------------------------
create or replace function public.get_studio_target_margin()
returns jsonb language plpgsql stable security definer set search_path = '' as $$
-- studio-target-margin-0242
-- r197-0376: not set = 25 % (owner, 17 Nov 2026; was 30 %); nothing else changed
declare
  v_org uuid := public.current_org_id();
  v jsonb; v_at timestamptz; n numeric;
begin
  if auth.uid() is null or v_org is null then raise exception 'not authorized' using errcode = '42501'; end if;
  if coalesce(public.user_role(), '') = 'client' then raise exception 'not authorized' using errcode = '42501'; end if;
  if not (public.has_area('insights', 'view') or public.has_area('controls', 'view')) then
    raise exception 'not authorized' using errcode = '42501'; end if;
  select c.value, c.updated_at into v, v_at from public.app_config c where c.org_id = v_org and c.key = 'insights';
  if jsonb_typeof(v -> 'targetMarginPct') = 'number' then n := (v ->> 'targetMarginPct')::numeric; end if;
  if n is not null and not (n >= 0 and n <= 90) then n := null; end if;   -- a hand-edited row out of range reads as "not set"
  return jsonb_build_object('target_margin_pct', n, 'default_pct', 25,
    'can_edit', public.has_area('controls', 'edit'), 'updated_at', case when n is not null then v_at end);
end $$;

-- the saved target of a studio (null = not set) - server only; the callers check access
create or replace function public._r376_target(p_org uuid)
returns numeric language plpgsql stable security definer set search_path = '' as $$
-- r197-0376
declare v jsonb; n numeric;
begin
  select c.value into v from public.app_config c where c.org_id = p_org and c.key = 'insights';
  if jsonb_typeof(v -> 'targetMarginPct') = 'number' then n := (v ->> 'targetMarginPct')::numeric; end if;
  if n is not null and not (n >= 0 and n <= 90) then n := null; end if;
  return n;
end $$;

-- ---- 3) money rules: + margin_band (wraps the 0372 bodies once) -------------------------------------------------------------
do $$ begin
  if to_regprocedure('public.money_settings_get__pre0376()') is null then
    alter function public.money_settings_get() rename to money_settings_get__pre0376;
  end if;
  if to_regprocedure('public.money_settings_set__pre0376(jsonb)') is null then
    alter function public.money_settings_set(jsonb) rename to money_settings_set__pre0376;
  end if;
end $$;

create or replace function public.money_settings_get()
returns jsonb language plpgsql stable security definer set search_path = '' as $$
-- r197-0376: wraps money_settings_get__pre0376 (the r189-money-0372 body; it checks Finance or Settings view)
-- + margin_band (traffic light) + the studio target margin (0242, read-only here)
declare v jsonb; v_org uuid := public.current_org_id(); v_band numeric;
begin
  v := public.money_settings_get__pre0376();
  select s.margin_band into v_band from public.money_settings s where s.org_id = v_org;
  return v || jsonb_build_object('margin_band', coalesce(v_band, 5), 'target_margin_pct', public._r376_target(v_org), 'target_default', 25,
    'defaults', coalesce(v -> 'defaults', '{}'::jsonb) || jsonb_build_object('margin_band', 5));
end $$;

create or replace function public.money_settings_set(p jsonb)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
-- r197-0376: wraps money_settings_set__pre0376 (the r189-money-0372 body: Settings edit, only the keys given change, audit)
-- + margin_band (0 to 50 points); every other key goes to the kept body exactly as before
declare v_org uuid := public.current_org_id(); v_rest jsonb; v_band numeric; v_old numeric;
begin
  if auth.uid() is null or v_org is null or coalesce(public.user_role(), '') = 'client' or not public.has_area('controls', 'edit') then
    raise exception 'Only a studio admin (or someone allowed to edit Settings) can change the money rules.' using errcode = '42501'; end if;
  if p is null or jsonb_typeof(p) <> 'object' then raise exception 'settings must be an object' using errcode = '22023'; end if;
  v_rest := p - 'margin_band';
  if p ? 'margin_band' then
    if jsonb_typeof(p -> 'margin_band') <> 'number' then raise exception 'margin_band must be a number' using errcode = '22023'; end if;
    v_band := round((p ->> 'margin_band')::numeric, 1);
    if v_band < 0 or v_band > 50 then
      raise exception 'The amber band must be 0 to 50 points below the target margin.' using errcode = '22023'; end if;
  end if;
  if v_rest <> '{}'::jsonb or v_band is null then perform public.money_settings_set__pre0376(v_rest); end if;
  if v_band is not null then
    perform pg_advisory_xact_lock(hashtextextended('helm:money_settings:' || v_org::text, 0));
    select s.margin_band into v_old from public.money_settings s where s.org_id = v_org;
    insert into public.money_settings as s (org_id, margin_band, updated_at, updated_by) values (v_org, v_band, now(), auth.uid())
      on conflict (org_id) do update set margin_band = excluded.margin_band, updated_at = now(), updated_by = auth.uid();
    begin
      insert into public.audit_log(actor, action, entity, entity_id, changed, org_id)
        values (auth.uid(), 'money_settings.changed', 'money_settings', v_org::text,
                jsonb_build_object('from', jsonb_build_object('margin_band', coalesce(v_old, 5)), 'set', jsonb_build_object('margin_band', v_band)), v_org);
    exception when others then raise warning 'r197-0376: audit skipped (%)', sqlstate;
    end;
  end if;
  return public.money_settings_get();
end $$;

-- ---- 4) the cost lines behind a category (per-person crew pay only for the admin) --------------------------------------------
create or replace function public._r376_lines(p_lines jsonb, p_admin boolean)
returns jsonb language plpgsql stable set search_path = '' as $$
-- r197-0376: compact ledger lines for the "tap a category" list; not counted lines (0 plan and 0 cost) are left out
declare v jsonb; c record;
begin
  select coalesce(jsonb_agg(jsonb_build_object('category', l ->> 'category', 'label', coalesce(nullif(btrim(l ->> 'label'), ''), 'Cost'),
           'source', l ->> 'source', 'plan', coalesce((l ->> 'c_est')::numeric, 0), 'expected', coalesce((l ->> 'c_fc')::numeric, 0),
           'actual', case when l ->> 'actual' is not null then coalesce((l ->> 'c_act')::numeric, 0) end,
           'stage', case when l ->> 'actual' is not null then 'actual' when l ->> 'committed' is not null then 'expected' else 'plan' end,
           'unplanned', coalesce((l ->> 'unplanned')::boolean, false),
           'note', nullif(left(btrim(coalesce(l ->> 'note', '')), 200), ''))
           order by l ->> 'category', coalesce((l ->> 'c_fc')::numeric, 0) desc), '[]'::jsonb)
    into v from jsonb_array_elements(coalesce(p_lines, '[]'::jsonb)) l
   where (coalesce(p_admin, false) or coalesce(l ->> 'source', '') <> 'crew')
     and (abs(coalesce((l ->> 'c_fc')::numeric, 0)) > 0.005 or abs(coalesce((l ->> 'c_est')::numeric, 0)) > 0.005);
  if not coalesce(p_admin, false) then
    select count(*) as n, coalesce(sum((l ->> 'c_est')::numeric), 0) as e, coalesce(sum((l ->> 'c_fc')::numeric), 0) as f,
           coalesce(sum((l ->> 'c_act')::numeric), 0) as a, count(*) filter (where l ->> 'actual' is null) as open
      into c from jsonb_array_elements(coalesce(p_lines, '[]'::jsonb)) l where l ->> 'source' = 'crew';
    if c.n > 0 then
      v := v || jsonb_build_array(jsonb_build_object('category', 'staff', 'label', 'Crew wages (' || c.n || ' people)', 'source', 'crew',
        'plan', c.e, 'expected', c.f, 'actual', case when c.open = 0 then c.a end, 'stage', case when c.open = 0 then 'actual' else 'expected' end,
        'unplanned', false, 'note', 'Per-person pay is visible to the studio admin only'));
    end if;
  end if;
  return v;
end $$;

-- ---- 5) the money header of one event (read-only) ----------------------------------------------------------------------------
create or replace function public.event_money_header(p_quote uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
-- r197-0376: read-only. Finance view, own studio; null for an event that is not in the caller's studio (or deleted).
-- Composes _vb_event_pnl (frozen figure when closed + frozen, 0372), the frozen snapshot or the live ledger (_r21_event_money),
-- the vendor bills (0373) and the client payments. Every number is worked out here; the page only shows it.
declare
  v_org uuid := public.current_org_id(); v_admin boolean; q record; v_pnl jsonb; v_money jsonb; s public.event_pnl_snapshots;
  v_cfg jsonb; v_band numeric; v_target numeric; v_target_set boolean; v_today date; v_closed timestamptz; v_frozen jsonb;
  v_rev numeric; v_profit numeric; v_margin numeric; v_plan_profit numeric; v_plan_margin numeric; v_light text; v_rules text;
  v_quoted numeric; v_paid numeric; v_tds numeric; v_bal numeric; v_cats jsonb; v_reasons jsonb; v_cost numeric; v_plan numeric;
  v_items jsonb := '[]'::jsonb; v_attn jsonb; v_live numeric; v_drift boolean := false; rb record; rm record; n_open integer; v_open numeric;
  n_over integer; v_top jsonb; v_unp numeric; v_dmg numeric; v_warn jsonb;
begin
  if auth.uid() is null or v_org is null or coalesce(public.user_role(), '') = 'client' or not public.has_area('finance', 'view') then
    raise exception 'not authorized' using errcode = '42501'; end if;
  select x.id, x.code, x.title, x.event_date, x.status, coalesce(nullif(upper(btrim(x.currency)), ''), 'INR') as cur,
         case when (x.pricing ->> 'total') ~ '^\s*-?[0-9]+(\.[0-9]+)?\s*$' then (x.pricing ->> 'total')::numeric else 0 end as base
    into q from public.quotes x where x.id = p_quote and x.org_id = v_org and x.deleted_at is null;
  if not found then return null; end if;
  v_admin := public.is_admin();
  v_cfg := public._r372_cfg(v_org);
  select coalesce(ms.margin_band, 5) into v_band from (select 1) one left join public.money_settings ms on ms.org_id = v_org;
  v_target := public._r376_target(v_org); v_target_set := v_target is not null; v_target := coalesce(v_target, 25);
  v_today := public.studio_today(v_org);
  select c.closed_at into v_closed from public.event_closure c where c.quote_id = p_quote;

  -- profit: the frozen figure for a closed + frozen event, else live (0372 _vb_event_pnl decides)
  v_pnl := public._vb_event_pnl(p_quote, v_org);
  if v_pnl is null then return null; end if;
  if jsonb_typeof(v_pnl -> 'frozen') = 'object' then
    v_frozen := v_pnl -> 'frozen';
    s := public._r372_current_snapshot(p_quote);
    if s.id is not null and s.org_id = v_org and s.money <> '{}'::jsonb then v_money := s.money; end if;
    v_live := (v_pnl ->> 'live_net_profit')::numeric;
  end if;
  if v_money is null then v_money := coalesce(public._r21_event_money(p_quote, v_org, true), '{}'::jsonb); end if;
  v_rules := coalesce(v_pnl ->> 'rules', v_money ->> 'rules', 'r21');
  v_rev := coalesce((v_pnl ->> 'revenue')::numeric, 0);
  v_profit := coalesce((v_pnl ->> 'net_profit')::numeric, 0);
  v_plan := coalesce((v_money ->> 'cost_estimated')::numeric, 0);
  v_cost := case when v_rules = 'legacy' then v_rev - v_profit else coalesce((v_money ->> 'cost_expected')::numeric, 0) end;
  v_drift := v_frozen is not null and v_live is not null and abs(v_live - v_profit) > 0.5;
  v_margin := case when v_rev > 0 then round(v_profit / v_rev * 100, 1) end;
  v_plan_profit := coalesce((v_money ->> 'margin_estimated')::numeric, v_rev - v_plan);
  v_plan_margin := case when v_rev > 0 then round(v_plan_profit / v_rev * 100, 1) end;
  v_light := case when v_rev <= 0 then 'none' when v_profit < 0 then 'bad' when v_margin >= v_target then 'good'
                  when v_margin >= v_target - v_band then 'warn' else 'bad' end;

  -- cash: the client bill (quote + approved changes), what came in, client TDS (counts as settled, 0372)
  v_quoted := case when q.base > 0 then coalesce(public.helm_invoice_total(p_quote), 0) else 0 end;
  v_paid := coalesce(public.helm_total_paid(p_quote, null, null), 0);
  v_tds := coalesce(public._r372_tds(p_quote), 0);
  v_bal := greatest(v_quoted - v_paid - v_tds, 0); if v_bal <= 0.5 then v_bal := 0; end if;

  -- plan vs expected / actual per category (the studio's big-gap flag; a frozen snapshot keeps the flag it had)
  select coalesce(jsonb_agg(jsonb_build_object('key', c ->> 'key', 'label', coalesce(c ->> 'label', c ->> 'key'),
           'plan', coalesce((c ->> 'estimated')::numeric, 0), 'expected', coalesce((c ->> 'expected')::numeric, 0),
           'actual', coalesce((c ->> 'actual')::numeric, 0),
           'diff', coalesce((c ->> 'expected')::numeric, 0) - coalesce((c ->> 'estimated')::numeric, 0),
           'diff_pct', case when coalesce((c ->> 'estimated')::numeric, 0) > 0
                            then round((coalesce((c ->> 'expected')::numeric, 0) - (c ->> 'estimated')::numeric) / (c ->> 'estimated')::numeric * 100) end,
           'flag', case when c ->> 'key' = 'contingency' then ''
                        else coalesce(c ->> 'flag', public._r372_flag((c ->> 'estimated')::numeric,
                               coalesce((c ->> 'expected')::numeric, 0) - coalesce((c ->> 'estimated')::numeric, 0), v_cfg)) end,
           'unplanned', coalesce((c ->> 'unplanned')::numeric, 0), 'lines', coalesce((c ->> 'lines')::integer, 0),
           'plan_only', c ->> 'key' = 'contingency')), '[]'::jsonb)
    into v_cats from jsonb_array_elements(coalesce(v_money -> 'by_category', '[]'::jsonb)) c;
  -- the two categories that cost the most over the plan (the sentence under the header)
  select coalesce(jsonb_agg(t.x order by (t.x ->> 'amount')::numeric desc), '[]'::jsonb) into v_reasons
    from (select jsonb_build_object('key', c ->> 'key', 'label', c ->> 'label', 'amount', (c ->> 'diff')::numeric,
                                    'unplanned', (c ->> 'plan')::numeric <= 0) as x
            from jsonb_array_elements(v_cats) c
           where (c ->> 'diff')::numeric > 0.5 and not (c ->> 'plan_only')::boolean
           order by (c ->> 'diff')::numeric desc limit 2) t;

  -- ---- needs attention (at most 3: red first, then amber, then information) ----
  -- 1 vendor bills still to pay on this event (0373: open part after payouts)
  select count(*), coalesce(sum(o.open), 0) into n_open, v_open
    from public.vendor_bills b cross join lateral (select public._r373_open(b.id) as open) o
   where b.quote_id = p_quote and b.org_id = v_org and b.status = 'open' and o.open > 0.005;
  if n_open > 0 then
    select b.due_date, o.open, coalesce(nullif(btrim(vv.name), ''), nullif(btrim(er.label), ''), nullif(btrim(b.description), ''), 'Vendor') as who
      into rb
      from public.vendor_bills b
      left join public.vendors vv on vv.id = b.vendor_id and vv.org_id = v_org
      left join public.event_resources er on er.id = b.booking_id and er.org_id = v_org
      cross join lateral (select public._r373_open(b.id) as open) o
     where b.quote_id = p_quote and b.org_id = v_org and b.status = 'open' and o.open > 0.005
     order by b.due_date nulls last, b.bill_date nulls last, b.created_at limit 1;
    v_items := v_items || jsonb_build_array(jsonb_build_object('kind', 'bill_due', 'rank', 1,
      'level', case when rb.due_date is not null and rb.due_date <= v_today + 1 then 'bad'
                    when rb.due_date is not null and rb.due_date <= v_today + 3 then 'warn' else 'info' end,
      'who', rb.who, 'amount', rb.open, 'date', rb.due_date, 'days', rb.due_date - v_today, 'count', n_open, 'total', v_open));
  end if;
  -- 2 money to collect from the client (the next payment of the schedule, 0264)
  if v_bal > 0 then
    select pm.label, pm.amount, pm.due_date into rm from public.payment_milestones pm
     where pm.quote_id = p_quote and pm.org_id = v_org and pm.status in ('due', 'invoiced') and coalesce(pm.amount, 0) > 0
     order by pm.due_date nulls last, pm.seq limit 1;
    v_items := v_items || jsonb_build_array(jsonb_build_object('kind', 'collect', 'rank', 2,
      'level', case when (rm.due_date is not null and rm.due_date < v_today) or (q.event_date is not null and q.event_date < v_today) then 'bad'
                    when (rm.due_date is not null and rm.due_date <= v_today + 3) or (q.event_date is not null and q.event_date <= v_today + 3) then 'warn'
                    else 'info' end,
      'amount', v_bal, 'next_amount', case when rm.amount is not null then least(rm.amount, v_bal) end, 'label', rm.label,
      'date', rm.due_date, 'days', rm.due_date - v_today));
  end if;
  -- 3 margin below the target
  if v_light in ('warn', 'bad') then
    v_items := v_items || jsonb_build_array(jsonb_build_object('kind', 'margin', 'rank', 3, 'level', v_light,
      'margin', v_margin, 'target', v_target, 'gap', round(v_target - v_margin, 1), 'loss', v_profit < 0));
  end if;
  -- 4 categories well over the plan (the 0372 big-gap rule)
  select count(*) into n_over from jsonb_array_elements(v_cats) c where c ->> 'flag' = 'over';
  if n_over > 0 then
    select jsonb_build_object('key', c ->> 'key', 'label', c ->> 'label', 'amount', (c ->> 'diff')::numeric) into v_top
      from jsonb_array_elements(v_cats) c where c ->> 'flag' = 'over' order by (c ->> 'diff')::numeric desc limit 1;
    v_items := v_items || jsonb_build_array(jsonb_build_object('kind', 'over_plan', 'rank', 4, 'level', 'warn', 'count', n_over, 'top', v_top,
      'total', (select coalesce(sum((c ->> 'diff')::numeric), 0) from jsonb_array_elements(v_cats) c where c ->> 'flag' = 'over')));
  end if;
  -- 6 unplanned spends (no estimate, added on or after the event day)
  v_unp := coalesce((v_money ->> 'unplanned_amount')::numeric, 0);
  if v_unp > 0.5 then
    v_items := v_items || jsonb_build_array(jsonb_build_object('kind', 'unplanned', 'rank', 6, 'level', 'info', 'amount', v_unp,
      'count', coalesce((v_money ->> 'unplanned_lines')::integer, 0)));
  end if;
  -- 7 damage & loss counted as a cost
  select coalesce(sum((c ->> 'expected')::numeric), 0) into v_dmg from jsonb_array_elements(v_cats) c where c ->> 'key' = 'damages';
  if v_dmg > 0.5 then
    v_items := v_items || jsonb_build_array(jsonb_build_object('kind', 'damage', 'rank', 7, 'level', 'info', 'amount', v_dmg));
  end if;
  -- 8 crew attendance not confirmed yet (0372 warning; live numbers only)
  if v_frozen is null then
    select w into v_warn from jsonb_array_elements(coalesce(v_money -> 'warnings', '[]'::jsonb)) w where w ->> 'code' = 'attendance_unconfirmed' limit 1;
    if v_warn is not null then
      v_items := v_items || jsonb_build_array(jsonb_build_object('kind', 'attendance', 'rank', 8, 'level', 'info',
        'count', coalesce((v_warn ->> 'count')::integer, 0)));
    end if;
  end if;
  select coalesce(jsonb_agg(t.a order by t.o, t.r), '[]'::jsonb) into v_attn
    from (select a, case a ->> 'level' when 'bad' then 0 when 'warn' then 1 else 2 end as o, (a ->> 'rank')::integer as r
            from jsonb_array_elements(v_items) a order by 2, 3 limit 3) t;

  return jsonb_build_object(
    'quote_id', q.id, 'code', q.code, 'title', q.title, 'event_date', q.event_date, 'status', q.status, 'currency', q.cur,
    'today', v_today, 'days_to_event', q.event_date - v_today, 'closed', v_closed is not null, 'closed_at', v_closed, 'rules', v_rules,
    'frozen', v_frozen, 'live_profit', case when v_frozen is not null then v_live end, 'live_differs', v_drift,
    'quoted', v_quoted, 'revenue', v_rev, 'tax', coalesce((v_pnl ->> 'tax')::numeric, 0),
    'refunds', case when v_rules = 'legacy' then 0 else coalesce((v_money ->> 'refunds_ex_tax')::numeric, 0) end,
    'received', v_paid, 'client_tds', v_tds, 'balance', v_bal,
    'received_pct', case when v_quoted > 0 then least(100, floor((v_paid + v_tds) / v_quoted * 100)) end,
    'cost_word', case when v_closed is not null then 'actual' else 'expected' end,
    'costs', v_cost, 'costs_plan', v_plan, 'costs_diff', v_cost - v_plan, 'costs_actual', coalesce((v_money ->> 'cost_actual')::numeric, 0),
    'accuracy_pct', v_money -> 'accuracy_pct',
    'profit', v_profit, 'margin_pct', v_margin, 'plan_profit', v_plan_profit, 'plan_margin_pct', v_plan_margin,
    'target_pct', v_target, 'target_set', v_target_set, 'band', v_band, 'light', v_light,
    'gap_points', case when v_margin is not null then round(v_target - v_margin, 1) end,
    'reasons', v_reasons, 'categories', v_cats, 'lines', public._r376_lines(v_money -> 'lines', v_admin),
    'gap_rule', jsonb_build_object('pct', v_cfg -> 'gap_pct', 'abs', v_cfg -> 'gap_abs'),
    'attention', v_attn, 'pay_private', not v_admin);
end $$;

-- ---- 6) grants: the page calls for signed-in staff (each checks its area); everything else for the server only ---------------
do $$
declare f text;
begin
  foreach f in array array['public._r376_target(uuid)', 'public._r376_lines(jsonb,boolean)',
                           'public.money_settings_get__pre0376()', 'public.money_settings_set__pre0376(jsonb)'] loop
    execute format('revoke all on function %s from public', f);
    if exists (select 1 from pg_roles where rolname = 'anon') then execute format('revoke all on function %s from anon', f); end if;
    if exists (select 1 from pg_roles where rolname = 'authenticated') then execute format('revoke all on function %s from authenticated', f); end if;
    if exists (select 1 from pg_roles where rolname = 'service_role') then execute format('grant execute on function %s to service_role', f); end if;
  end loop;
  foreach f in array array['public.event_money_header(uuid)', 'public.money_settings_get()', 'public.money_settings_set(jsonb)'] loop
    execute format('revoke all on function %s from public', f);
    if exists (select 1 from pg_roles where rolname = 'anon') then execute format('revoke all on function %s from anon', f); end if;
    if exists (select 1 from pg_roles where rolname = 'authenticated') then execute format('grant execute on function %s to authenticated', f); end if;
    if exists (select 1 from pg_roles where rolname = 'service_role') then execute format('grant execute on function %s to service_role', f); end if;
  end loop;
end $$;

notify pgrst, 'reload schema';
