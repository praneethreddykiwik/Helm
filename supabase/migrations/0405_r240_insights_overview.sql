-- 0405_r240_insights_overview.sql - CANONICAL forward-only. R240 (owner 20 Nov 2026: "We need to improve our Insights page").
-- REQUIRES 0076 (insights area), 0108 + 0154 (dashboard_money_for: the overdue rule copied here), 0185 (leads.clean_archived_at),
-- 0198 (event_cancellations), 0029 (has_area / role_access). All already on staging and production.
--
-- In plain words:
--   ONE new READ-ONLY function for the Insights page: insights_overview(from, to, currency).
--   It only reads. It writes nothing, adds no table, no column, no index, no trigger, and changes no existing function.
--   For the dates picked on Insights (and the same-sized period just before them, for "better or worse") it counts:
--     * the sales funnel: new enquiries (leads) and how many were won / lost, quotes made and how many were confirmed /
--       cancelled, bookings confirmed, cancellations - plus enquiries per lead source and per month;
--     * what is coming: confirmed events in the next 30 days with their open / unassigned tasks and crew;
--     * which packages the period's confirmed events used (counts + event ids; the page adds the ledger revenue);
--     * the top cancellation reasons;
--     * payments (finance only): what is overdue today - the SAME rule as the dashboard's overdue list
--       (dashboard_money_for: ledger payments spread over the milestones in order) - with ageing, and how late clients paid.
--   Who may call it: a signed-in member with the Insights area (admins always), inside their own studio only.
--   Enquiries / sources need the Leads area, cancellation reasons the Quotes area, every amount the Finance area.
--   No new money math: amounts are the dashboard's overdue balances; revenue / profit stay on insights_event_costs.
--   Bounded: the period may be at most 3 years, every list is capped, every query reads only the studio's own rows.
--   Safe to run twice (create or replace).

-- ---- previous period of the same shape -----------------------------------------------------------------------------------
-- whole calendar months (1st .. last day) -> the same number of months just before; any other period -> the same number of days
create or replace function public._r405_prev_range(p_from date, p_to date)
returns date[] language sql immutable set search_path = '' as $$
  -- r240-insights-0405
  select case
    when p_from is null or p_to is null or p_to < p_from then null
    when extract(day from p_from) = 1 and extract(day from p_to + 1) = 1 then
      array[(p_from - make_interval(months => (((extract(year from p_to + 1) - extract(year from p_from)) * 12
                                                + extract(month from p_to + 1) - extract(month from p_from))::int)))::date, p_from - 1]
    else array[p_from - (p_to - p_from + 1), p_from - 1] end
$$;

-- ---- funnel counts of one period (server only) ---------------------------------------------------------------------------
create or replace function public._r405_funnel(p_org uuid, p_tz text, p_from date, p_to date, p_leads boolean)
returns jsonb language sql stable set search_path = '' as $$
  -- r240-insights-0405
  with b as (
    select (p_from::timestamp at time zone p_tz) as t0, ((p_to + 1)::timestamp at time zone p_tz) as t1
  ), l as (
    select coalesce(l.status = 'won', false) or coalesce(q.status = 'confirmed', false) as won,
           coalesce(l.status = 'lost', false) or coalesce(q.status = 'cancelled', false) as lost
      from b cross join public.leads l
      left join public.quotes q on q.id = l.quote_id and q.org_id = p_org and q.deleted_at is null
     where p_leads and l.org_id = p_org and l.clean_archived_at is null
       and l.created_at >= b.t0 and l.created_at < b.t1
  ), qm as (
    select q.status
      from b cross join public.quotes q
     where q.org_id = p_org and q.deleted_at is null and q.created_at >= b.t0 and q.created_at < b.t1
       and coalesce(q.lifecycle_stage, 'quote') not in ('lead', 'discovery', 'proposal')
  )
  select jsonb_build_object(
    'from', p_from, 'to', p_to,
    'enquiries',        case when p_leads then (select count(*) from l) end,
    'enquiries_won',    case when p_leads then (select count(*) filter (where won) from l) end,
    'enquiries_lost',   case when p_leads then (select count(*) filter (where lost and not won) from l) end,
    'quotes_made',      (select count(*) from qm),
    'quotes_won',       (select count(*) filter (where status = 'confirmed') from qm),
    'quotes_cancelled', (select count(*) filter (where status = 'cancelled') from qm),
    'quotes_open',      (select count(*) filter (where status = 'quote') from qm),
    'bookings',         (select count(*) from b cross join public.quotes q
                          where q.org_id = p_org and q.deleted_at is null and q.status = 'confirmed'
                            and q.confirmed_at >= b.t0 and q.confirmed_at < b.t1),
    'cancellations',    (select count(distinct c.quote_id) from b cross join public.event_cancellations c
                          where c.org_id = p_org and c.created_at >= b.t0 and c.created_at < b.t1))
$$;

-- ---- payment timing of one period: milestones marked paid in it (counts only, server only) -------------------------------
create or replace function public._r405_timing(p_org uuid, p_tz text, p_from date, p_to date)
returns jsonb language sql stable set search_path = '' as $$
  -- r240-insights-0405
  with b as (
    select (p_from::timestamp at time zone p_tz) as t0, ((p_to + 1)::timestamp at time zone p_tz) as t1
  ), m as (
    select ((m.paid_at at time zone p_tz)::date - m.due_date) as late
      from b cross join public.payment_milestones m
      join public.quotes q on q.id = m.quote_id and q.org_id = p_org and q.deleted_at is null
     where m.org_id = p_org and m.status = 'paid' and m.due_date is not null
       and m.paid_at >= b.t0 and m.paid_at < b.t1
  )
  select jsonb_build_object('from', p_from, 'to', p_to,
    'paid', count(*), 'on_time', count(*) filter (where late <= 0), 'late', count(*) filter (where late > 0),
    'avg_days_late', round(avg(late) filter (where late > 0), 1), 'max_days_late', max(late) filter (where late > 0))
  from m
$$;

-- ---- the Insights overview -----------------------------------------------------------------------------------------------
create or replace function public.insights_overview(p_from date, p_to date, p_currency text default null)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
-- r240-insights-0405: read-only Insights overview (funnel, sources, months, upcoming, packages, cancellations, payments)
declare
  v_org uuid := public.current_org_id();
  v_fin boolean; v_leads boolean; v_quotes boolean;
  v_tz text; v_cur text; v_today date; v_prev date[];
  v_t0 timestamptz; v_t1 timestamptz;
  v_cur_f jsonb; v_prev_f jsonb; v_sources jsonb; v_months jsonb; v_up jsonb; v_pk jsonb; v_pk_none bigint;
  v_cx jsonb; v_cx_none bigint; v_pay jsonb;
  v_od_n bigint; v_od_cur jsonb; v_od_age jsonb; v_od_list jsonb;
begin
  if auth.uid() is null or v_org is null then raise exception 'not authorized' using errcode = '42501'; end if;
  if not public.has_area('insights', 'view') then raise exception 'not authorized' using errcode = '42501'; end if;
  if p_from is null or p_to is null then raise exception 'pick a start and an end date' using errcode = '22023'; end if;
  if p_to < p_from then raise exception 'the end date is before the start date' using errcode = '22023'; end if;
  if p_to - p_from > 1100 then raise exception 'pick a period of three years or less' using errcode = '22023'; end if;
  v_fin := public.has_area('finance', 'view');
  v_leads := public.has_area('leads', 'view');
  v_quotes := public.has_area('quotes', 'view');

  -- time zone + reporting currency: the same rules as dashboard_money_for (0108 / 0142 / 0145 / 0154)
  select coalesce(nullif(o.timezone, ''), 'Asia/Kolkata'),
         case when upper(coalesce(o.currency, '')) ~ '^[A-Z]{3}$' then upper(o.currency) else 'INR' end
    into v_tz, v_cur from public.organizations o where o.id = v_org;
  v_tz := coalesce(v_tz, 'Asia/Kolkata'); v_cur := coalesce(v_cur, 'INR');
  if upper(btrim(coalesce(p_currency, ''))) ~ '^[A-Z]{3}$' then
    v_cur := upper(btrim(p_currency));
  elsif not exists (select 1 from public.quotes q where q.org_id = v_org and q.deleted_at is null
                   and upper(btrim(coalesce(q.currency, ''))) = v_cur) then
    select x.c into v_cur from (
      select upper(q.currency) as c, count(*) as n from public.quotes q
       where q.org_id = v_org and q.deleted_at is null and upper(coalesce(q.currency, '')) ~ '^[A-Z]{3}$'
       group by 1 order by 2 desc, 1 limit 1) x;
    v_cur := coalesce(v_cur, 'INR');
  end if;
  begin perform now() at time zone v_tz; exception when others then v_tz := 'Asia/Kolkata'; end;
  v_today := (now() at time zone v_tz)::date;
  v_prev := public._r405_prev_range(p_from, p_to);
  v_t0 := (p_from::timestamp at time zone v_tz); v_t1 := ((p_to + 1)::timestamp at time zone v_tz);

  -- 1) funnel: this period + the one before
  v_cur_f := public._r405_funnel(v_org, v_tz, p_from, p_to, v_leads);
  v_prev_f := public._r405_funnel(v_org, v_tz, v_prev[1], v_prev[2], v_leads);

  -- 2) enquiries per lead source (Leads area)
  if v_leads then
    select coalesce(jsonb_agg(jsonb_build_object('source', s.src, 'enquiries', s.n, 'won', s.w, 'lost', s.lo) order by s.n desc, s.src), '[]'::jsonb)
      into v_sources
      from (
        select left(coalesce(nullif(lower(btrim(l.source)), ''), 'none'), 40) as src, count(*) as n,
               count(*) filter (where coalesce(l.status = 'won', false) or coalesce(q.status = 'confirmed', false)) as w,
               count(*) filter (where not (coalesce(l.status = 'won', false) or coalesce(q.status = 'confirmed', false))
                                  and (coalesce(l.status = 'lost', false) or coalesce(q.status = 'cancelled', false))) as lo
          from public.leads l
          left join public.quotes q on q.id = l.quote_id and q.org_id = v_org and q.deleted_at is null
         where l.org_id = v_org and l.clean_archived_at is null and l.created_at >= v_t0 and l.created_at < v_t1
         group by 1 order by 2 desc, 1 limit 12) s;
  end if;

  -- 3) month by month (the last 24 months of the period at most)
  select coalesce(jsonb_agg(jsonb_build_object('month', to_char(g.m, 'YYYY-MM'),
           'enquiries', case when v_leads then coalesce(le.n, 0) end,
           'quotes_made', coalesce(qm.n, 0), 'bookings', coalesce(bk.n, 0)) order by g.m), '[]'::jsonb)
    into v_months
    from generate_series(greatest(date_trunc('month', p_from::timestamp), date_trunc('month', p_to::timestamp) - interval '23 months'),
                         date_trunc('month', p_to::timestamp), interval '1 month') g(m)
    left join (select date_trunc('month', (l.created_at at time zone v_tz)) as m, count(*) as n
                 from public.leads l
                where v_leads and l.org_id = v_org and l.clean_archived_at is null and l.created_at >= v_t0 and l.created_at < v_t1
                group by 1) le on le.m = g.m
    left join (select date_trunc('month', (q.created_at at time zone v_tz)) as m, count(*) as n
                 from public.quotes q
                where q.org_id = v_org and q.deleted_at is null and q.created_at >= v_t0 and q.created_at < v_t1
                  and coalesce(q.lifecycle_stage, 'quote') not in ('lead', 'discovery', 'proposal')
                group by 1) qm on qm.m = g.m
    left join (select date_trunc('month', (q.confirmed_at at time zone v_tz)) as m, count(*) as n
                 from public.quotes q
                where q.org_id = v_org and q.deleted_at is null and q.status = 'confirmed'
                  and q.confirmed_at >= v_t0 and q.confirmed_at < v_t1
                group by 1) bk on bk.m = g.m;

  -- 4) coming up: confirmed events in the next 30 days (studio calendar), with their task load
  with u as (
    select q.id, q.code, q.title, q.event_date as d, coalesce(q.lifecycle_stage, 'quote') as stage,
           nullif(btrim(coalesce(q.event_type, '')), '') as etype,
           case when coalesce(q.pricing ->> 'guests', '') ~ '^\s*[0-9]{1,6}\s*$' and (q.pricing ->> 'guests')::int > 0 then (q.pricing ->> 'guests')::int
                when coalesce(q.client ->> 'guests', '') ~ '^\s*[0-9]{1,6}\s*$' and (q.client ->> 'guests')::int > 0 then (q.client ->> 'guests')::int end as guests
      from public.quotes q
     where q.org_id = v_org and q.deleted_at is null and q.status = 'confirmed'
       and q.event_date between v_today and v_today + 30
  ), t as (
    select t.quote_id,
           count(*) filter (where t.status <> 'cancelled') as total,
           count(*) filter (where t.status not in ('completed', 'cancelled')) as open,
           count(*) filter (where t.status not in ('completed', 'cancelled')
                              and (t.status = 'unassigned' or (t.crew_id is null and t.vendor_id is null
                                   and nullif(btrim(coalesce(t.assignee_name, '')), '') is null))) as unassigned,
           count(distinct coalesce(t.crew_id::text, nullif(lower(btrim(coalesce(t.assignee_name, ''))), '')))
             filter (where t.status <> 'cancelled' and coalesce(t.assignee_kind, 'in_house') <> 'outsourced') as crew
      from public.event_tasks t join u on u.id = t.quote_id
     where t.org_id = v_org
     group by t.quote_id
  )
  select jsonb_build_object('from', v_today, 'to', v_today + 30, 'total', (select count(*) from u),
    'weeks', (select coalesce(jsonb_agg(jsonb_build_object('from', v_today + w * 7, 'to', least(v_today + w * 7 + 6, v_today + 30),
                 'events', (select count(*) from u where u.d between v_today + w * 7 and least(v_today + w * 7 + 6, v_today + 30)))
                 order by w), '[]'::jsonb) from generate_series(0, 4) w),
    'tasks_open', (select coalesce(sum(t.open), 0) from t), 'tasks_unassigned', (select coalesce(sum(t.unassigned), 0) from t),
    'events', (select coalesce(jsonb_agg(x order by x ->> 'date', x ->> 'code'), '[]'::jsonb) from (
       select jsonb_build_object('id', u.id, 'code', u.code, 'title', u.title, 'date', u.d, 'stage', u.stage, 'event_type', u.etype,
                'guests', u.guests, 'tasks', coalesce(t.total, 0), 'tasks_open', coalesce(t.open, 0),
                'tasks_unassigned', coalesce(t.unassigned, 0), 'crew', coalesce(t.crew, 0)) as x
         from u left join t on t.quote_id = u.id
        order by u.d, u.code limit 30) s))
    into v_up;

  -- 5) packages of the period's confirmed events (same events as insights_event_costs: event day in range, past discovery)
  with e as (
    select q.id, nullif(btrim(coalesce(q.pricing ->> '_packageName', '')), '') as pk
      from public.quotes q
     where q.org_id = v_org and q.deleted_at is null and q.status = 'confirmed'
       and coalesce(q.event_date, (q.created_at at time zone v_tz)::date) between p_from and p_to
       and coalesce(q.lifecycle_stage, 'quote') not in ('lead', 'discovery', 'proposal')
  )
  select (select coalesce(jsonb_agg(jsonb_build_object('name', s.nm, 'events', s.n, 'ids', s.ids) order by s.n desc, s.nm), '[]'::jsonb) from (
            select left(min(e.pk), 80) as nm, count(*) as n, to_jsonb((array_agg(e.id order by e.id))[1:500]) as ids
              from e where e.pk is not null group by lower(e.pk) order by 2 desc, 1 limit 8) s),
         (select count(*) from e where e.pk is null)
    into v_pk, v_pk_none;

  -- 6) cancellation reasons (Quotes area)
  if v_quotes then
    select coalesce(jsonb_agg(jsonb_build_object('reason', s.r, 'count', s.n) order by s.n desc, s.r), '[]'::jsonb),
           (select count(distinct c.quote_id) from public.event_cancellations c
             where c.org_id = v_org and c.created_at >= v_t0 and c.created_at < v_t1 and nullif(btrim(coalesce(c.reason, '')), '') is null)
      into v_cx, v_cx_none
      from (select left(min(btrim(c.reason)), 120) as r, count(*) as n
              from public.event_cancellations c
             where c.org_id = v_org and c.created_at >= v_t0 and c.created_at < v_t1 and nullif(btrim(coalesce(c.reason, '')), '') is not null
             group by lower(btrim(c.reason)) order by 2 desc, 1 limit 5) s;
  end if;

  -- 7) payments (Finance area): overdue today = the dashboard_money_for rule, every row (not only the first 10)
  if v_fin then
    with q as (
      select q.id, q.code, q.title, q.client, q.status,
             case when upper(coalesce(q.currency, '')) ~ '^[A-Z]{3}$' then upper(q.currency) else v_cur end as cur
        from public.quotes q
       where q.org_id = v_org and q.deleted_at is null
    ), led as (
      select p.quote_id, sum(p.amount) filter (where p.status = 'paid') as paid from public.quote_payments p
       where p.org_id = v_org group by p.quote_id
    ), msp as (
      select m.quote_id, sum(m.amount) filter (where m.status = 'paid') as paid from public.payment_milestones m
       where m.org_id = v_org group by m.quote_id
    ), ev as (
      select q.*, case when led.quote_id is not null then coalesce(led.paid, 0) else coalesce(msp.paid, 0) end as paid,
             led.quote_id is not null as has_led
        from q left join led on led.quote_id = q.id left join msp on msp.quote_id = q.id
    ), y as (
      select m.id, m.quote_id, m.label, m.due_date, m.amount, m.status as mstatus, e.code, e.title, e.client, e.cur,
             e.paid as qpaid, e.has_led,
             coalesce(sum(m.amount) over (partition by m.quote_id order by m.seq, m.due_date nulls last, m.created_at, m.id
                                          rows between unbounded preceding and 1 preceding), 0) as prior_amt
        from public.payment_milestones m
        join ev e on e.id = m.quote_id and e.status = 'confirmed'
       where m.org_id = v_org
    ), z as (
      select y.*, case when y.has_led then least(greatest(y.qpaid - y.prior_amt, 0), y.amount)
                       when y.mstatus = 'paid' then y.amount else 0 end as mpaid
        from y
    ), od as (
      select z.*, (v_today - z.due_date) as late,
             case when v_today - z.due_date <= 7 then '1-7' when v_today - z.due_date <= 30 then '8-30'
                  when v_today - z.due_date <= 60 then '31-60' else '60+' end as bucket
        from z
       where z.due_date is not null and z.due_date < v_today and z.mstatus <> 'waived' and z.mpaid < z.amount
    )
    select (select count(*) from od),
           (select coalesce(jsonb_agg(jsonb_build_object('currency', s.cur, 'count', s.n, 'balance', s.b, 'oldest_days', s.o) order by s.cur), '[]'::jsonb)
              from (select od.cur, count(*) as n, sum(od.amount - od.mpaid) as b, max(od.late) as o from od group by od.cur) s),
           (select coalesce(jsonb_agg(jsonb_build_object('bucket', s.bucket, 'currency', s.cur, 'count', s.n, 'balance', s.b)
                     order by s.cur, s.k), '[]'::jsonb)
              from (select od.bucket, od.cur, count(*) as n, sum(od.amount - od.mpaid) as b,
                           case od.bucket when '1-7' then 1 when '8-30' then 2 when '31-60' then 3 else 4 end as k
                      from od group by od.bucket, od.cur) s),
           (select coalesce(jsonb_agg(o order by (o ->> 'due_date'), (o ->> 'code')), '[]'::jsonb) from (
              select jsonb_build_object('quote_id', od.quote_id, 'milestone_id', od.id, 'code', od.code, 'title', od.title,
                       'client', nullif(btrim(coalesce(od.client ->> 'name', '')), ''), 'label', od.label, 'due_date', od.due_date,
                       'amount', od.amount, 'paid', od.mpaid, 'balance', od.amount - od.mpaid, 'currency', od.cur,
                       'days_late', od.late) as o
                from od order by od.due_date, od.code limit 10) s)
      into v_od_n, v_od_cur, v_od_age, v_od_list;
    v_pay := jsonb_build_object(
      'overdue', jsonb_build_object('count', v_od_n, 'by_currency', v_od_cur, 'ageing', v_od_age, 'list', v_od_list),
      'timing', public._r405_timing(v_org, v_tz, p_from, p_to),
      'timing_prev', public._r405_timing(v_org, v_tz, v_prev[1], v_prev[2]));
  end if;

  return jsonb_build_object(
    'from', p_from, 'to', p_to, 'prev_from', v_prev[1], 'prev_to', v_prev[2], 'today', v_today, 'currency', v_cur,
    'finance', v_fin, 'leads', v_leads, 'quotes', v_quotes,
    'funnel', jsonb_build_object('cur', v_cur_f, 'prev', v_prev_f),
    'sources', v_sources, 'months', v_months, 'upcoming', v_up,
    'packages', jsonb_build_object('list', v_pk, 'without', v_pk_none),
    'cancellations', jsonb_build_object('reasons', v_cx, 'no_reason', v_cx_none),
    'payments', v_pay);
end $$;

-- ---- privileges: the page call for signed-in members; the helpers are server only ---------------------------------------
revoke all on function public.insights_overview(date, date, text) from public;
revoke all on function public._r405_prev_range(date, date) from public;
revoke all on function public._r405_funnel(uuid, text, date, date, boolean) from public;
revoke all on function public._r405_timing(uuid, text, date, date) from public;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    execute 'revoke all on function public.insights_overview(date, date, text) from anon';
    execute 'revoke all on function public._r405_prev_range(date, date) from anon';
    execute 'revoke all on function public._r405_funnel(uuid, text, date, date, boolean) from anon';
    execute 'revoke all on function public._r405_timing(uuid, text, date, date) from anon';
  end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    execute 'revoke all on function public._r405_prev_range(date, date) from authenticated';
    execute 'revoke all on function public._r405_funnel(uuid, text, date, date, boolean) from authenticated';
    execute 'revoke all on function public._r405_timing(uuid, text, date, date) from authenticated';
    execute 'grant execute on function public.insights_overview(date, date, text) to authenticated';
  end if;
end $$;

comment on function public.insights_overview(date, date, text) is
  '0405 (R240): read-only Insights overview - funnel, lead sources, months, next 30 days, packages, cancellation reasons, overdue (dashboard rule) + payment timing. Insights area; leads / quotes / finance areas for their parts; own studio only.';
