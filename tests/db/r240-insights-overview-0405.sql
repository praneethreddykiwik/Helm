-- r240-insights-overview-0405.sql -- 0405 insights_overview: access (signed in, Insights area, studio only), the
-- Leads / Quotes / Finance parts hidden without their area, previous-period shapes, funnel + source + month counts,
-- next 30 days with task load, packages, cancellation reasons, overdue = the dashboard's overdue list (same rule,
-- every row counted), payment timing, read-only, safe to run twice. Fixture: studios A / B of 10-fixtures.sql.
-- Local disposable PG only. Fake data only. Rolled back.
\set ON_ERROR_STOP 0
set client_min_messages = warning;
begin;
create temp table _uf(name text, result text); grant all on _uf to anon, authenticated, service_role;

create or replace function pg_temp.su() returns void language plpgsql as $$
begin execute 'reset role'; perform auth.logout(); execute 'reset role'; end $$;
create or replace function pg_temp.login(p_email text) returns void language plpgsql as $$
declare u uuid; begin
  perform pg_temp.su(); select id into u from auth.users where email = p_email;
  perform set_config('request.jwt.claims', jsonb_build_object('sub', u, 'role', 'authenticated', 'email', p_email, 'aal', 'aal1')::text, false);
  perform set_config('role', 'authenticated', false);
end $$;
create or replace function pg_temp.anon() returns void language plpgsql as $$
begin perform pg_temp.su(); perform set_config('request.jwt.claims', '{"role":"anon"}', false); perform set_config('role', 'anon', false); end $$;
create or replace function pg_temp.res(p_name text, p_ok boolean, p_detail text default '') returns void language plpgsql as $$
begin insert into _uf values (p_name, case when coalesce(p_ok, false) then 'PASS' else 'FAIL: '||coalesce(p_detail,'') end); end $$;
grant execute on function pg_temp.res(text, boolean, text) to anon, authenticated, service_role;
create or replace function pg_temp.try(p_sql text) returns text language plpgsql as $$
begin execute p_sql; return ''; exception when others then return sqlstate || ' ' || sqlerrm; end $$;
grant execute on function pg_temp.try(text) to anon, authenticated, service_role;

-- the migration applied a second time on top of itself must still work (create or replace only)
\i supabase/migrations/0405_r240_insights_overview.sql

-- ---- fixture ----------------------------------------------------------------------------------------------------------
-- March 2026 is the period; February 2026 the period before. "today" = the studio's calendar day (Asia/Kolkata).
do $$ declare a uuid := 'a0000000-0000-4000-8000-000000000001'; b uuid := 'b0000000-0000-4000-8000-000000000001';
  u uuid; td date := (now() at time zone 'Asia/Kolkata')::date;
  q1 uuid := 'a0000000-0000-4000-8000-0000004050a1'; q2 uuid := 'a0000000-0000-4000-8000-0000004050a2';
  q3 uuid := 'a0000000-0000-4000-8000-0000004050a3'; q6 uuid := 'a0000000-0000-4000-8000-0000004050a6';
  q7 uuid := 'a0000000-0000-4000-8000-0000004050a7'; q8 uuid := 'a0000000-0000-4000-8000-0000004050a8';
  up1 uuid := 'a0000000-0000-4000-8000-0000004050b1'; od1 uuid := 'a0000000-0000-4000-8000-0000004050c1';
  t1 timestamptz := '2026-03-05 11:00+05:30';
begin
  perform pg_temp.su();
  -- an Insights-only viewer (no leads / quotes / finance)
  u := coalesce((select id from auth.users where email = 'ov_viewer@a.test'), auth.seed_user('ov_viewer@a.test'));
  insert into public.profiles(id, email, full_name, role, org_id, must_change_password, created_at)
    values (u, 'ov_viewer@a.test', 'Overview Viewer', 'quality', a, false, now()) on conflict (id) do update set role = 'quality', org_id = a;
  delete from public.role_access where org_id = a and role = 'quality';
  insert into public.role_access(role, area, can_view, can_edit, org_id, updated_at) values ('quality', 'insights', true, false, a, now());
  -- quotes (created_at set by hand: the period is decided by it)
  insert into public.quotes(id, code, title, event_type, status, lifecycle_stage, event_date, pricing, client, org_id, created_at, confirmed_at) values
    (q1, 'OV-1', 'Won in March', 'Wedding', 'confirmed', 'planning', '2026-03-20', '{"subtotal":100000,"discount":0,"gstPct":0,"total":100000,"_packageName":"Gold"}', '{"guests":"120"}', a, t1, '2026-03-06 10:00+05:30'),
    (q2, 'OV-2', 'Cancelled in March', 'Wedding', 'cancelled', 'quote', '2026-04-20', '{"subtotal":50000,"discount":0,"gstPct":0,"total":50000}', '{}', a, t1, null),
    (q3, 'OV-3', 'Open quote', 'Birthday', 'quote', 'quote', '2026-05-25', '{"subtotal":20000,"discount":0,"gstPct":0,"total":20000}', '{}', a, t1, null),
    (q6, 'OV-6', 'Made in Jan, won in March', 'Birthday', 'confirmed', 'planning', '2026-03-28', '{"subtotal":30000,"discount":0,"gstPct":0,"total":30000,"_packageName":" gold "}', '{}', a, '2026-01-10 10:00+05:30', '2026-03-02 09:00+05:30'),
    (q7, 'OV-7', 'Cancelled too', 'Wedding', 'cancelled', 'quote', '2026-06-01', '{"subtotal":10000,"discount":0,"gstPct":0,"total":10000}', '{}', a, '2026-02-10 10:00+05:30', null),
    (q8, 'OV-8', 'No package', 'Wedding', 'confirmed', 'planning', '2026-03-11', '{"subtotal":40000,"discount":0,"gstPct":0,"total":40000}', '{}', a, '2026-02-11 10:00+05:30', '2026-02-12 10:00+05:30');
  insert into public.quotes(id, code, title, status, lifecycle_stage, pricing, org_id, created_at) values
    (gen_random_uuid(), 'OV-4', 'Still a lead', 'quote', 'lead', '{}', a, t1);
  insert into public.quotes(id, code, title, status, pricing, org_id, created_at, deleted_at) values
    (gen_random_uuid(), 'OV-5', 'Deleted', 'quote', '{}', a, t1, now());
  insert into public.quotes(id, code, title, status, lifecycle_stage, event_date, pricing, org_id, created_at, confirmed_at) values
    (gen_random_uuid(), 'OVB-1', 'Studio B', 'confirmed', 'planning', '2026-03-15', '{"subtotal":777777,"discount":0,"gstPct":0,"total":777777,"_packageName":"Gold"}', b, t1, t1),
    (gen_random_uuid(), 'OVB-2', 'Studio B soon', 'confirmed', 'planning', td + 2, '{"subtotal":1,"discount":0,"gstPct":0,"total":1}', b, now(), now());
  -- leads: 4 in March (2 instagram: won / lost, 1 referral won through its confirmed quote, 1 without source open),
  -- 1 archived (left out), 1 in February (the period before), 1 in studio B
  insert into public.leads(name, source, status, quote_id, org_id, created_at) values
    ('L1', 'Instagram', 'won', null, a, t1), ('L2', ' instagram ', 'lost', null, a, t1),
    ('L3', 'referral', 'quoted', q1, a, t1), ('L4', null, 'new', null, a, t1),
    ('L6', 'referral', 'new', null, a, '2026-02-03 10:00+05:30'), ('LB', 'referral', 'won', null, b, t1);
  insert into public.leads(name, source, status, org_id, created_at, clean_archived_at) values ('L5', 'ad', 'won', a, t1, now());
  -- cancellations in March: two with the same reason (case / spaces differ), one other (a reason is required, 5+ letters)
  insert into public.event_cancellations(org_id, quote_id, reason, prev_status, created_at) values
    (a, q2, 'Client postponed', 'quote', '2026-03-07 10:00+05:30'), (a, q7, ' client postponed ', 'quote', '2026-03-08 10:00+05:30'),
    (a, q3, 'Venue not available', 'quote', '2026-03-09 10:00+05:30');
  -- coming up: one confirmed event in 3 days with 4 tasks (done, unassigned, crew-assigned, cancelled); one beyond 30 days
  insert into public.quotes(id, code, title, event_type, status, lifecycle_stage, event_date, pricing, client, org_id) values
    (up1, 'OV-U1', 'Soon', 'Wedding', 'confirmed', 'ready', td + 3, '{"subtotal":1000,"discount":0,"gstPct":0,"total":1000,"guests":"50"}', '{}', a),
    (gen_random_uuid(), 'OV-U2', 'Far away', 'Wedding', 'confirmed', 'planning', td + 45, '{"subtotal":1000,"discount":0,"gstPct":0,"total":1000}', '{}', a),
    (gen_random_uuid(), 'OV-U3', 'Cancelled soon', 'Wedding', 'cancelled', 'quote', td + 4, '{"subtotal":1000,"discount":0,"gstPct":0,"total":1000}', '{}', a);
  insert into public.event_tasks(quote_id, category, title, status, assignee_name, org_id) values
    (up1, 'decor', 'Flowers', 'completed', 'Ravi', a), (up1, 'decor', 'Stage', 'unassigned', null, a),
    (up1, 'decor', 'Lights', 'assigned', 'Ravi', a), (up1, 'decor', 'Old', 'cancelled', 'Sita', a);
  -- overdue: a confirmed event with a ledger payment of 500 spread over its milestones in order
  insert into public.quotes(id, code, title, status, lifecycle_stage, event_date, pricing, client, org_id) values
    (od1, 'OV-D1', 'Owes money', 'confirmed', 'planning', td + 60, '{"subtotal":10000,"discount":0,"gstPct":0,"total":10000}', '{"name":"Meera"}', a);
  insert into public.quote_payments(quote_id, amount, status, paid_at, org_id) values (od1, 500, 'paid', now() - interval '50 days', a);
  insert into public.payment_milestones(quote_id, label, amount, status, due_date, seq, org_id) values
    (od1, 'Advance', 1000, 'due', td - 40, 1, a), (od1, 'Second', 2000, 'invoiced', td - 5, 2, a),
    (od1, 'Waived', 700, 'waived', td - 100, 3, a), (od1, 'Later', 6300, 'due', td + 10, 4, a);
  -- payment timing in March: one paid 2 days early, one paid 10 days late (q1 has no ledger rows)
  insert into public.payment_milestones(quote_id, label, amount, status, due_date, paid_at, seq, org_id) values
    (q1, 'Advance', 40000, 'paid', '2026-03-10', '2026-03-08 12:00+05:30', 1, a),
    (q1, 'Balance', 60000, 'paid', '2026-03-01', '2026-03-11 12:00+05:30', 2, a),
    (q8, 'Feb pay', 100, 'paid', '2026-02-10', '2026-02-13 12:00+05:30', 1, a);
exception when others then perform pg_temp.su(); insert into _uf values ('00 fixture', 'FAIL: '||sqlstate||' '||sqlerrm); end $$;

do $$ declare r jsonb; e text; f jsonb; p jsonb; s jsonb; x jsonb; d jsonb; od jsonb; n0 bigint; n1 bigint; td date := (now() at time zone 'Asia/Kolkata')::date;
begin
  perform pg_temp.su();
  perform pg_temp.res('01 definer, stable, empty search_path; helpers pin search_path too',
    (select p.prosecdef and p.provolatile = 's' and 'search_path=""' = any(p.proconfig) from pg_proc p where p.oid = 'public.insights_overview(date,date,text)'::regprocedure)
    and (select bool_and('search_path=""' = any(p.proconfig)) from pg_proc p where p.oid in
          ('public._r405_prev_range(date,date)'::regprocedure, 'public._r405_funnel(uuid,text,date,date,boolean)'::regprocedure, 'public._r405_timing(uuid,text,date,date)'::regprocedure)));
  perform pg_temp.res('02 privileges: authenticated may call it, anon may not; helpers for nobody',
    has_function_privilege('authenticated', 'public.insights_overview(date,date,text)', 'execute')
    and not has_function_privilege('anon', 'public.insights_overview(date,date,text)', 'execute')
    and not has_function_privilege('authenticated', 'public._r405_funnel(uuid,text,date,date,boolean)', 'execute')
    and not has_function_privilege('authenticated', 'public._r405_timing(uuid,text,date,date)', 'execute')
    and not has_function_privilege('authenticated', 'public._r405_prev_range(date,date)', 'execute')
    and not has_function_privilege('anon', 'public._r405_funnel(uuid,text,date,date,boolean)', 'execute'));
  perform pg_temp.anon();
  e := pg_temp.try($q$select public.insights_overview('2026-03-01', '2026-03-31')$q$);
  perform pg_temp.res('03 signed out refused', e like '42501%', e);
  perform pg_temp.login('a_staff@a.test');   -- sales: quotes + finance, no insights area
  e := pg_temp.try($q$select public.insights_overview('2026-03-01', '2026-03-31')$q$);
  perform pg_temp.res('04 role without the Insights area refused (42501)', e like '42501%', e);
  perform pg_temp.login('a_admin@a.test');
  perform pg_temp.res('05 bad periods refused (22023): reversed, missing, longer than 3 years',
    pg_temp.try($q$select public.insights_overview('2026-03-31', '2026-03-01')$q$) like '22023%'
    and pg_temp.try($q$select public.insights_overview(null, '2026-03-01')$q$) like '22023%'
    and pg_temp.try($q$select public.insights_overview('2020-01-01', '2026-03-01')$q$) like '22023%');

  r := public.insights_overview('2026-03-01', '2026-03-31', 'INR');
  perform pg_temp.su();
  perform pg_temp.res('06 previous period: March -> February; 6 months -> the 6 before; 7 days -> the 7 before; a leap February',
    r ->> 'prev_from' = '2026-02-01' and r ->> 'prev_to' = '2026-02-28'
    and public._r405_prev_range('2026-06-01', '2026-11-30') = array['2025-12-01'::date, '2026-05-31']
    and public._r405_prev_range('2026-11-14', '2026-11-20') = array['2026-11-07'::date, '2026-11-13']
    and public._r405_prev_range('2024-03-01', '2024-03-31') = array['2024-02-01'::date, '2024-02-29']
    and public._r405_prev_range('2026-01-01', '2026-12-31') = array['2025-01-01'::date, '2025-12-31'], r::text);
  perform pg_temp.login('a_admin@a.test');
  f := r #> '{funnel,cur}';
  perform pg_temp.res('07 enquiries: 4 in March (archived + other studio left out), 2 won (status / confirmed quote), 1 lost',
    (f ->> 'enquiries')::int = 4 and (f ->> 'enquiries_won')::int = 2 and (f ->> 'enquiries_lost')::int = 1
    and (r #>> '{funnel,prev,enquiries}')::int = 1, f::text);
  perform pg_temp.res('08 quotes made in March: 3 (lead-stage + deleted left out): 1 confirmed, 1 cancelled, 1 open',
    (f ->> 'quotes_made')::int = 3 and (f ->> 'quotes_won')::int = 1 and (f ->> 'quotes_cancelled')::int = 1 and (f ->> 'quotes_open')::int = 1, f::text);
  perform pg_temp.res('09 bookings = confirmed in March (OV-1, OV-6; OV-8 was February); cancellations 3; February: 1 booking, 0 cancellations',
    (f ->> 'bookings')::int = 2 and (f ->> 'cancellations')::int = 3
    and (r #>> '{funnel,prev,bookings}')::int = 1 and (r #>> '{funnel,prev,cancellations}')::int = 0, r ->> 'funnel');
  s := r -> 'sources';
  perform pg_temp.res('10 lead sources: instagram 2 (1 won, 1 lost), referral 1 won, none 1; spaces / case merged',
    s -> 0 ->> 'source' = 'instagram' and (s -> 0 ->> 'enquiries')::int = 2 and (s -> 0 ->> 'won')::int = 1 and (s -> 0 ->> 'lost')::int = 1
    and exists (select 1 from jsonb_array_elements(s) v where v ->> 'source' = 'referral' and (v ->> 'won')::int = 1 and (v ->> 'enquiries')::int = 1)
    and exists (select 1 from jsonb_array_elements(s) v where v ->> 'source' = 'none' and (v ->> 'enquiries')::int = 1)
    and jsonb_array_length(s) = 3, s::text);
  d := public.insights_overview('2026-01-01', '2026-03-31', 'INR') -> 'months';
  perform pg_temp.res('11 months: Jan 1 quote made, Feb 1 enquiry + 1 quote + 1 booking, Mar 4 enquiries / 3 quotes / 2 bookings',
    jsonb_array_length(d) = 3 and d -> 0 ->> 'month' = '2026-01' and (d -> 0 ->> 'quotes_made')::int = 1
    and (d -> 1 ->> 'enquiries')::int = 1 and (d -> 1 ->> 'quotes_made')::int = 2 and (d -> 1 ->> 'bookings')::int = 1
    and (d -> 2 ->> 'enquiries')::int = 4 and (d -> 2 ->> 'quotes_made')::int = 3 and (d -> 2 ->> 'bookings')::int = 2, d::text);
  x := r -> 'upcoming';
  -- other suites may leave confirmed events in the coming days: check OUR rows by code
  select v into d from jsonb_array_elements(x -> 'events') v where v ->> 'code' = 'OV-U1';
  perform pg_temp.res('12 next 30 days: OV-U1 with 3 live tasks, 2 open, 1 unassigned, 1 crew; far / cancelled / other studio left out',
    (x ->> 'total')::int >= 1 and d is not null and (d ->> 'tasks')::int = 3 and (d ->> 'tasks_open')::int = 2
    and (d ->> 'tasks_unassigned')::int = 1 and (d ->> 'crew')::int = 1 and (d ->> 'guests')::int = 50
    and position('OV-U2' in x::text) = 0 and position('OV-U3' in x::text) = 0 and position('OVB-2' in x::text) = 0
    and (select sum((w ->> 'events')::int) from jsonb_array_elements(x -> 'weeks') w) = (x ->> 'total')::int
    and jsonb_array_length(x -> 'weeks') = 5 and (x ->> 'from')::date = td and (x ->> 'to')::date = td + 30, x::text);
  p := r -> 'packages';
  perform pg_temp.res('13 packages: "Gold" + " gold " = 2 events (ids listed), 1 confirmed event without a package; studio B not counted',
    jsonb_array_length(p -> 'list') = 1 and (p #>> '{list,0,events}')::int = 2 and jsonb_array_length(p #> '{list,0,ids}') = 2
    and (p ->> 'without')::int = 1 and position('OVB' in p::text) = 0, p::text);
  perform pg_temp.res('14 cancellation reasons: "Client postponed" x2 (case / spaces merged) first, then "Venue not available"',
    jsonb_array_length(r #> '{cancellations,reasons}') = 2 and (r #>> '{cancellations,reasons,0,count}')::int = 2
    and lower(r #>> '{cancellations,reasons,0,reason}') = 'client postponed' and r #>> '{cancellations,reasons,1,reason}' = 'Venue not available'
    and (r #>> '{cancellations,no_reason}')::int = 0, r ->> 'cancellations');
  od := r #> '{payments,overdue}';
  perform pg_temp.res('15 overdue today: OV-D1 has 2 rows (waived / not yet due left out): 500 (40 days) + 2000 (5 days); totals add up',
    (select count(*) from jsonb_array_elements(od -> 'list') v where v ->> 'code' = 'OV-D1') = 2
    and exists (select 1 from jsonb_array_elements(od -> 'list') v where v ->> 'code' = 'OV-D1' and (v ->> 'balance')::numeric = 500 and (v ->> 'days_late')::int = 40)
    and exists (select 1 from jsonb_array_elements(od -> 'list') v where v ->> 'code' = 'OV-D1' and (v ->> 'balance')::numeric = 2000 and (v ->> 'days_late')::int = 5)
    and (od ->> 'count')::int = (select sum((v ->> 'count')::int) from jsonb_array_elements(od -> 'by_currency') v)
    and (od ->> 'count')::int = (select sum((v ->> 'count')::int) from jsonb_array_elements(od -> 'ageing') v)
    and (select sum((v ->> 'balance')::numeric) from jsonb_array_elements(od -> 'by_currency') v) = (select sum((v ->> 'balance')::numeric) from jsonb_array_elements(od -> 'ageing') v), od::text);
  x := public.dashboard_money_for(12, 'INR');
  perform pg_temp.res('16 overdue list = the dashboard overdue list, row for row (same rule)',
    (select coalesce(jsonb_agg(v - 'days_late' order by o), '[]'::jsonb) from jsonb_array_elements(od -> 'list') with ordinality t(v, o)) = x -> 'overdue'
    and jsonb_array_length(x -> 'overdue') = least((od ->> 'count')::int, 10), (od -> 'list')::text || ' vs ' || (x -> 'overdue')::text);
  x := r #> '{payments,timing}';
  perform pg_temp.res('17 payment timing in March: 2 paid, 1 on time, 1 late by 10 days; February: 1 late by 3',
    (x ->> 'paid')::int = 2 and (x ->> 'on_time')::int = 1 and (x ->> 'late')::int = 1 and (x ->> 'avg_days_late')::numeric = 10
    and (r #>> '{payments,timing_prev,late}')::int = 1 and (r #>> '{payments,timing_prev,avg_days_late}')::numeric = 3, r ->> 'payments');

  perform pg_temp.login('ov_viewer@a.test');   -- Insights only
  r := public.insights_overview('2026-03-01', '2026-03-31');
  perform pg_temp.res('18 Insights-only member: counts yes; enquiries / sources (Leads), reasons (Quotes), payments (Finance) hidden',
    (r ->> 'finance')::boolean = false and (r ->> 'leads')::boolean = false and (r ->> 'quotes')::boolean = false
    and r #> '{funnel,cur,enquiries}' = 'null'::jsonb and r -> 'sources' = 'null'::jsonb and r #> '{months,0,enquiries}' = 'null'::jsonb
    and r #> '{cancellations,reasons}' = 'null'::jsonb and r -> 'payments' = 'null'::jsonb
    and (r #>> '{funnel,cur,quotes_made}')::int = 3 and position('Meera' in r::text) = 0 and position('2500' in r::text) = 0, r::text);

  perform pg_temp.login('b_admin@b.test');
  r := public.insights_overview('2026-03-01', '2026-03-31', 'INR');
  perform pg_temp.res('19 studio B sees only its own numbers',
    (r #>> '{funnel,cur,enquiries}')::int = 1 and (r #>> '{funnel,cur,bookings}')::int = 1 and position('OVB-2' in (r -> 'upcoming')::text) > 0
    and position('OV-' in r::text) = 0 and position('Meera' in r::text) = 0, r::text);

  perform pg_temp.su();
  select count(*) into n0 from public.quotes;
  perform pg_temp.login('a_admin@a.test');
  r := public.insights_overview('2026-03-01', '2026-03-31');
  r := public.insights_overview('2025-01-01', '2026-12-31');
  perform pg_temp.su();
  select count(*) into n1 from public.quotes;
  perform pg_temp.res('20 read-only: calls change no row; a 2-year period still returns at most 24 months',
    n0 = n1 and (select count(*) from public.event_tasks where quote_id = 'a0000000-0000-4000-8000-0000004050b1') = 4
    and jsonb_array_length(r -> 'months') = 24, n0 || ' vs ' || n1);
exception when others then perform pg_temp.su(); insert into _uf values ('2x run', 'FAIL: '||sqlstate||' '||sqlerrm); end $$;

select name, result from _uf order by name;
select case when count(*) filter (where result <> 'PASS') = 0 then 'R240-INSIGHTS-0405: ALL PASS (' || count(*) || '/' || count(*) || ')'
            else 'R240-INSIGHTS-0405: ' || count(*) filter (where result <> 'PASS') || ' FAILED of ' || count(*) end as summary from _uf;
rollback;
