-- r261-close-same-day-0451.sql - R261: marked complete on the event day = may be closed that day; nothing else of the close rules changes.
-- Local disposable PG only. Fake data only. Rolled back.
\set ON_ERROR_STOP 0
set client_min_messages = error;
begin;
create temp table _before as select (select md5(coalesce(string_agg(q::text, '|' order by q.id), '')) from public.quotes q) as qs;
\o /dev/null
\i supabase/migrations/0451_r261_close_same_day.sql
\i supabase/migrations/0451_r261_close_same_day.sql
\o
set client_min_messages = warning;
create temp table _rc(name text, result text); grant all on _rc to anon, authenticated, service_role;
create or replace function pg_temp.su() returns void language plpgsql as $$ begin execute 'reset role'; perform auth.logout(); execute 'reset role'; end $$;
create or replace function pg_temp.login(p_email text) returns void language plpgsql as $$
declare u uuid; begin perform pg_temp.su(); select id into u from auth.users where email = p_email;
  perform set_config('request.jwt.claims', jsonb_build_object('sub', u, 'role', 'authenticated', 'email', p_email, 'aal', 'aal1')::text, false); perform set_config('role', 'authenticated', false); end $$;
create or replace function pg_temp.res(p_name text, p_ok boolean, p_detail text default '') returns void language plpgsql as $$
begin insert into _rc values (p_name, case when coalesce(p_ok, false) then 'PASS' else 'FAIL: ' || coalesce(p_detail, '') end); end $$;
create or replace function pg_temp.r(p_sql text) returns text language plpgsql as $$ declare v text; begin execute p_sql into v; return 'ok:' || coalesce(v, ''); exception when others then return 'err:' || sqlstate || ':' || sqlerrm; end $$;
create or replace function pg_temp.put(p_stage text, p_day date, p_paid numeric default 118000, p_status text default 'confirmed') returns void language plpgsql as $$
begin perform pg_temp.su(); perform set_config('session_replication_role', 'replica', true);
  update public.quotes set lifecycle_stage = p_stage, event_date = p_day, status = p_status where id = 'a0000000-0000-4000-8000-000000045101';
  delete from public.event_closure where quote_id = 'a0000000-0000-4000-8000-000000045101';
  update public.quote_payments set amount = p_paid where quote_id = 'a0000000-0000-4000-8000-000000045101';
  perform set_config('session_replication_role', 'origin', true);
end $$;
select pg_temp.res('01 no stored quote changed by the file (run twice)', (select b.qs = md5(coalesce((select string_agg(q::text, '|' order by q.id) from public.quotes q), '')) from _before b));
do $$ declare a uuid := 'a0000000-0000-4000-8000-000000000001'; d date := public._a198_org_today('a0000000-0000-4000-8000-000000000001'); begin
  perform set_config('session_replication_role', 'replica', true);
  insert into public.quotes(id, code, title, status, client, pricing, current_version, approval_status, org_id, lifecycle_stage, event_date, confirmed_at, created_at, updated_at)
  values ('a0000000-0000-4000-8000-000000045101', 'T-451-1', 'Close today', 'confirmed', '{"name":"Client One"}'::jsonb, '{"subtotal":100000,"discount":0,"gstPct":18,"total":118000}'::jsonb, 1, 'approved', a, 'settlement', d, now(), now(), now());
  insert into public.quote_payments(quote_id, org_id, provider, amount, currency, status, paid_at) values ('a0000000-0000-4000-8000-000000045101', a, 'manual', 118000, 'INR', 'paid', now());
  perform set_config('session_replication_role', 'origin', true);
end $$;
create or replace function pg_temp.d() returns date language sql security definer as $$ select public._a198_org_today('a0000000-0000-4000-8000-000000000001') $$;


select pg_temp.put('event_day', pg_temp.d()); select pg_temp.login('a_admin@a.test');
select pg_temp.res('02 today, not marked complete: still HL425', x like 'err:HL425%', x) from pg_temp.r($q$select public.close_event('a0000000-0000-4000-8000-000000045101', true)::text$q$) x;
select pg_temp.res('03 the checklist still says too early', (public.close_event_blockers('a0000000-0000-4000-8000-000000045101') ->> 'too_early')::boolean);
select pg_temp.put('settlement', pg_temp.d() + 1); select pg_temp.login('a_admin@a.test');
select pg_temp.res('04 tomorrow, stage settlement: still HL425 (a future event is never over)', x like 'err:HL425%', x) from pg_temp.r($q$select public.close_event('a0000000-0000-4000-8000-000000045101', true)::text$q$) x;
select pg_temp.put('settlement', pg_temp.d(), 1000); select pg_temp.login('a_admin@a.test');
select pg_temp.res('05 marked complete today but money owed: the balance still blocks (not the day)', x like 'err:P0001%' and x not like '%not over%' and x ~ 'owed', x) from pg_temp.r($q$select public.close_event('a0000000-0000-4000-8000-000000045101', true)::text$q$) x;
select pg_temp.res('06 the blockers say so', not (b ->> 'too_early')::boolean and (b ->> 'blocked')::boolean and (b ->> 'done_today')::boolean, b::text) from public.close_event_blockers('a0000000-0000-4000-8000-000000045101') b;
select pg_temp.login('b_admin@b.test');
select pg_temp.res('07 another studio is refused', x like 'err:42501%', x) from pg_temp.r($q$select public.close_event('a0000000-0000-4000-8000-000000045101', true)::text$q$) x;
select pg_temp.put('settlement', pg_temp.d()); select pg_temp.login('a_admin@a.test');
select pg_temp.res('08 the review: the event-day check is ok', (select c ->> 'status' from jsonb_array_elements(public.event_closure_review('a0000000-0000-4000-8000-000000045101') -> 'checks') c where c ->> 'key' = 'event_day') = 'ok');
select pg_temp.res('09 marked complete today, all settled: it closes', x like 'ok:%', x) from pg_temp.r($q$select public.close_event('a0000000-0000-4000-8000-000000045101', true)::text$q$) x;
select pg_temp.su();
select pg_temp.res('10 and it is closed', exists (select 1 from public.event_closure c where c.quote_id = 'a0000000-0000-4000-8000-000000045101' and c.closed_at is not null));
select pg_temp.put('settlement', pg_temp.d() - 1); select pg_temp.login('a_admin@a.test');
select pg_temp.res('11 the day after: as always', not (b ->> 'too_early')::boolean and not (b ? 'done_today'), b::text) from public.close_event_blockers('a0000000-0000-4000-8000-000000045101') b;
select pg_temp.su();
select pg_temp.res('12 the app cannot call the inner functions', not has_function_privilege('authenticated', 'public._r451_done_today(uuid)', 'execute') and not has_function_privilege('authenticated', 'public._a49_close_gate(uuid,text)', 'execute'));
select name, result from _rc where result <> 'PASS' order by name;
select 'R261-CLOSE-SAME-DAY-0451: ' || case when count(*) filter (where result <> 'PASS') = 0 and count(*) = 12 then 'ALL PASS' else 'FAIL' end || ' (' || count(*) filter (where result = 'PASS') || '/' || count(*) || ')' from _rc;
rollback;
