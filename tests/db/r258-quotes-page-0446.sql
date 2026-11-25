-- r258-quotes-page-0446.sql - R258 (25 Nov 2026): the Quotes page reads one page of 10 rows + the exact total from the server (quotes_page).
-- Proves on a fixture of 60 more quotes: nothing stored changes (file run twice), every tab = the old reads (the PostgREST rule of store-api.js
-- sbQuoteView + list_quote_shelf taken out / put first as quotes.html did) in the same ORDER, page by page, no row twice or missing; totals; tab
-- numbers = list_quote_shelf / HEAD counts; search (escaped), type, dates, Deleted switch, sort; page / size clamps; In progress = my_open_quotes;
-- studio isolation, no Quotes view, temporary password, not signed in. Local disposable PG only. Fake data only. Rolled back.
\set ON_ERROR_STOP 0
set client_min_messages = error;
begin;
create temp table _before as select (select md5(coalesce(string_agg(q::text, '|' order by q.id), '')) from public.quotes q) as qs;
\o /dev/null
\i supabase/migrations/0446_r258_quotes_page.sql
\i supabase/migrations/0446_r258_quotes_page.sql
\o
set client_min_messages = warning;
create temp table _rc(name text, result text); grant all on _rc to anon, authenticated, service_role;
create or replace function pg_temp.su() returns void language plpgsql as $$
begin execute 'reset role'; perform auth.logout(); execute 'reset role'; end $$;
create or replace function pg_temp.login(p_email text) returns void language plpgsql as $$
declare u uuid; begin
  perform pg_temp.su(); select id into u from auth.users where email = p_email;
  perform set_config('request.jwt.claims', jsonb_build_object('sub', u, 'role', 'authenticated', 'email', p_email, 'aal', 'aal1')::text, false);
  perform set_config('role', 'authenticated', false);
end $$;
create or replace function pg_temp.res(p_name text, p_ok boolean, p_detail text default '') returns void language plpgsql as $$
begin insert into _rc values (p_name, case when coalesce(p_ok, false) then 'PASS' else 'FAIL: ' || coalesce(p_detail, '') end); end $$;
create or replace function pg_temp.j(p_sql text) returns jsonb language plpgsql as $$
declare v jsonb; begin execute p_sql into v; return v; exception when others then return jsonb_build_object('err', sqlstate || ' ' || sqlerrm); end $$;
select pg_temp.res('01 no stored row changed by the file (run twice)', (select b.qs = md5(coalesce((select string_agg(q::text, '|' order by q.id) from public.quotes q), '')) from _before b));

-- 60 quotes in studio A (every shape), 5 in studio B; a person without Quotes view
do $$ declare orgA uuid := 'a0000000-0000-4000-8000-000000000001'; orgB uuid := 'b0000000-0000-4000-8000-000000000001'; u_nov uuid; i int; st text; lc text; arch timestamptz; del timestamptz; ar text; dr text; begin
  u_nov := auth.seed_user('a_noq446@a.test');
  insert into public.profiles(id, email, full_name, role, org_id, must_change_password, created_at) values (u_nov, 'a_noq446@a.test', 'Nina NoQuotes', 'quality', orgA, false, now())
  on conflict (id) do update set role = excluded.role, org_id = excluded.org_id;
  insert into public.role_access(role, area, can_view, can_edit, org_id, updated_at) values ('quality', 'quotes', false, false, orgA, now())
  on conflict (role, area, org_id) do update set can_view = false, can_edit = false;
  perform set_config('session_replication_role', 'replica', true);   -- plain rows: the list reads are what is tested
  for i in 1..65 loop
    st := (array['quote','quote','confirmed','quote','cancelled','confirmed'])[1 + i % 6];
    lc := case when i % 12 = 2 then 'closed' when i % 7 = 0 then 'planning' when i % 13 = 0 then null else 'quote' end;
    arch := null; del := null; ar := null; dr := null;
    if i % 10 = 3 then del := now() - make_interval(hours => i); dr := 'manual'; elsif i % 10 = 6 then del := now() - make_interval(hours => 2 * i); dr := 'auto_empty_draft';
    elsif i % 10 = 9 then del := now() - make_interval(hours => 3 * i); dr := 'link_expired'; elsif i % 10 = 4 then arch := now() - make_interval(hours => i); ar := 'manual'; end if;
    insert into public.quotes(id, code, title, event_type, status, client, pricing, current_version, approval_status, org_id, created_at, updated_at, event_date, lifecycle_stage, archived_at, archived_reason, deleted_at, deleted_reason)
    values (('a0000000-0000-4000-8000-0000004460' || lpad(i::text, 2, '0'))::uuid, 'T446-' || lpad(i::text, 2, '0'), case when i = 5 then '100%_off \ party' when i % 4 = 0 then 'WED_HYD_200_03DEC26' else 'Event ' || i end,
      case when i % 3 = 0 then 'Wedding' when i % 3 = 1 then 'wedding' else null end, st,
      case when i % 11 = 0 then '{}'::jsonb else jsonb_build_object('name', 'Client ' || i, 'city', 'Hyderabad', 'phone', '+9190000000' || lpad(i::text, 2, '0')) end,
      jsonb_build_object('total', i * 1000, 'client', jsonb_build_object('name', 'Priced ' || i), 'items', jsonb_build_array(1, 2)), 1, (array['none','sent','approved'])[1 + i % 3],
      case when i > 60 then orgB else orgA end, now() - make_interval(days => 200), now() - make_interval(hours => (i * 7) % 20), case when i % 5 = 0 then null else current_date + (i - 30) end, lc, arch, ar, del, dr);
  end loop;
  perform set_config('session_replication_role', 'origin', true);
end $$;

-- the OLD reads, as the caller: the table rule of store-api.js (sbQuoteView) + order, then what quotes.html did with list_quote_shelf()
create or replace function pg_temp.old(p_view text, p_today date, p_ids uuid[], p_kind text default 'all') returns uuid[] language plpgsql as $$
declare sh jsonb := public.list_quote_shelf() -> 'rows'; base uuid[]; mine uuid[]; byid uuid[]; dels uuid[]; begin
  select coalesce(array_agg((e ->> 'id')::uuid), '{}'), coalesce(array_agg((e ->> 'id')::uuid) filter (where e ->> 'shelf' = 'deleted'), '{}') into byid, dels from jsonb_array_elements(sh) e;
  select coalesce(array_agg((e.v ->> 'id')::uuid order by (case when e.v ->> 'shelf' = 'deleted' and e.v ->> 'reason' = 'auto_empty_draft' then 1 else 0 end), e.n), '{}') into mine
    from jsonb_array_elements(sh) with ordinality e(v, n) where e.v ->> 'shelf' = case when p_view = 'deleted' then 'deleted' else 'archived' end
     and (p_view <> 'deleted' or p_kind = 'all' or (p_kind = 'empty') = (e.v ->> 'reason' = 'auto_empty_draft'));
  if p_view = 'deleted' then return mine; end if;
  select coalesce(array_agg(q.id order by case when p_view <> 'archived' then q.status end, case when p_view = 'archived' then q.status end desc, q.updated_at desc, q.id desc), '{}') into base
    from public.quotes q where q.deleted_at is null and case p_view when 'cancelled' then q.status = 'cancelled'
      when 'archived' then q.status = 'cancelled' or (q.lifecycle_stage = 'closed' and q.status = 'confirmed') or q.archived_at is not null
      else q.archived_at is null and q.status <> 'cancelled' and (q.lifecycle_stage is null or q.lifecycle_stage <> 'closed' or q.status <> 'confirmed')
        and case p_view when 'all' then true when 'attention' then q.event_date < p_today or q.id = any (p_ids) else q.status = p_view end end;
  base := array(select x.u from unnest(base) with ordinality x(u, n) where case when p_view = 'cancelled' then not x.u = any (dels) else not x.u = any (byid) end order by x.n);
  return case when p_view = 'archived' then mine || base else base end;
end $$;
-- every page of the new read, put together
create or replace function pg_temp.neu(p_view text, p_today date, p_ids uuid[], p_kind text default 'all', p_size int default 10, p_search text default null, p_type text default null, p_from date default null, p_to date default null) returns jsonb language plpgsql as $$
declare d jsonb; ids uuid[] := '{}'; n int := 0; tot int; big int := 0; begin
  loop n := n + 1;
    d := public.quotes_page(p_view, p_search, p_type, p_from, p_to, p_kind, 'confirmed', n, p_size, p_ids, p_today, false);
    tot := (d ->> 'total')::int; big := greatest(big, jsonb_array_length(d -> 'rows'));
    ids := ids || coalesce((select array_agg((e.v ->> 'id')::uuid order by e.n) from jsonb_array_elements(d -> 'rows') with ordinality e(v, n)), '{}');
    exit when n >= ceil(tot / p_size::numeric) or n > 50;
  end loop;
  return jsonb_build_object('ids', to_jsonb(ids), 'total', tot, 'pages', n, 'big', big);
end $$;
grant execute on all functions in schema pg_temp to anon, authenticated, service_role;

select pg_temp.login('a_staff@a.test');
do $$ declare v text; o uuid[]; d jsonb; k text; xs uuid[] := array['a0000000-0000-4000-8000-000000446050','a0000000-0000-4000-8000-000000446055','a0000000-0000-4000-8000-000000446063','a0000000-0000-4000-8000-000000446053']::uuid[]; begin
  foreach v in array array['all','quote','confirmed','attention','cancelled','archived','deleted'] loop
    o := pg_temp.old(v, current_date, xs); d := pg_temp.neu(v, current_date, xs);
    perform pg_temp.res('02 ' || v || ': the same rows in the same order as the old reads', d -> 'ids' = to_jsonb(o) and cardinality(o) > 0, cardinality(o) || ' old / ' || jsonb_array_length(d -> 'ids') || ' new');
    perform pg_temp.res('03 ' || v || ': exact total, never more than 10 a page', (d ->> 'total')::int = cardinality(o) and (d ->> 'big')::int = least(10, cardinality(o)) and (d ->> 'pages')::int = greatest(1, ceil(cardinality(o) / 10.0)::int), (d - 'ids')::text);
  end loop;
  foreach k in array array['all','hand','empty'] loop
    o := pg_temp.old('deleted', current_date, xs, k); d := pg_temp.neu('deleted', current_date, xs, k);
    perform pg_temp.res('04 Deleted switch ' || k, d -> 'ids' = to_jsonb(o) and cardinality(o) > 0 and (d ->> 'total')::int = cardinality(o));
  end loop;
  perform pg_temp.res('05 no quote twice across the pages', (select count(*) = count(distinct x) from jsonb_array_elements_text(pg_temp.neu('all', current_date, xs) -> 'ids') x));
end $$;
select pg_temp.res('06 tab numbers = list_quote_shelf + the HEAD counts', (select (d -> 'archived') = (s -> 'archived_count') and (d -> 'deleted') = (s -> 'deleted_count')
   and (d ->> 'cancelled')::int = (select count(*) from public.quotes where status = 'cancelled' and deleted_at is null)
   and (d ->> 'all')::int = (select count(*) from public.quotes where archived_at is null and deleted_at is null)
   and (d ->> 'deleted_empty')::int = (select count(*) from public.quotes where deleted_reason = 'auto_empty_draft')
   and (d ->> 'deleted')::int > (d ->> 'deleted_empty')::int and (d ->> 'deleted_empty')::int > 0
  from (select public.quotes_page() -> 'counts' as d, public.list_quote_shelf() as s) z));
select pg_temp.res('07 the numbers are only worked out when asked', public.quotes_page(p_counts => false) -> 'counts' = 'null'::jsonb);
-- search / type / dates
select pg_temp.res('08 search: code, title, client name, any case', (pg_temp.neu('all', current_date, null, p_search => 't446-01') ->> 'total')::int = 1
  and (pg_temp.neu('all', current_date, null, p_search => ' CLIENT 1 ') ->> 'total')::int = (select count(*) from unnest(pg_temp.old('all', current_date, null)) u join public.quotes q on q.id = u where q.code ilike '%client 1%' or q.title ilike '%client 1%' or q.client ->> 'name' ilike '%client 1%')
  and (pg_temp.neu('all', current_date, null, p_search => 'no such thing') ->> 'total')::int = 0);
select pg_temp.res('09 search is literal: %, _ and \ match themselves', (pg_temp.neu('all', current_date, null, p_search => '100%_OFF \ p') ->> 'total') = '1'
  and (pg_temp.neu('all', current_date, null, p_search => '%') ->> 'total') = '1' and (pg_temp.neu('all', current_date, null, p_search => 'T446_01') ->> 'total')::int = 0
  and not (pg_temp.j('select public.quotes_page(''all'', ''a\'')') ? 'err') and not (pg_temp.j($q$select public.quotes_page('all', $$x') or 1=1 --$$)$q$) ? 'err'));
select pg_temp.res('10 search on the shelves also looks at the priced client name, like list_quote_shelf did', (select (pg_temp.neu('deleted', current_date, null, p_search => 'priced') ->> 'total')::int = count(*) and count(*) > 0
  from public.quotes q where q.deleted_at is not null and q.client ->> 'name' is null and q.pricing -> 'client' ->> 'name' ilike '%priced%'));
select pg_temp.res('11 type: exact, any case', (select (pg_temp.neu('all', current_date, null, p_type => 'WEDDING') ->> 'total')::int = count(*) and count(*) > 10 from unnest(pg_temp.old('all', current_date, null)) u join public.quotes q on q.id = u where lower(q.event_type) = 'wedding')
  and (pg_temp.neu('all', current_date, null, p_type => 'wed%') ->> 'total')::int = 0);
select pg_temp.res('12 event dates: inclusive, no date = outside', (select (pg_temp.neu('all', current_date, null, p_from => current_date - 3, p_to => current_date + 3) ->> 'total')::int = count(*) and count(*) > 0
  from unnest(pg_temp.old('all', current_date, null)) u join public.quotes q on q.id = u where q.event_date between current_date - 3 and current_date + 3));
select pg_temp.res('13 date window on Deleted too', (select (pg_temp.neu('deleted', current_date, null, p_from => current_date) ->> 'total')::int = count(*) from public.quotes q where q.deleted_at is not null and q.event_date >= current_date));
-- clamps
select pg_temp.res('14 page: 0, negative, null -> 1; beyond the end -> the last page', (public.quotes_page('all', p_page => 0) ->> 'page') = '1' and (public.quotes_page('all', p_page => -5) ->> 'page') = '1' and (public.quotes_page('all', p_page => null) ->> 'page') = '1'
  and (select (d ->> 'page')::int = ceil((d ->> 'total')::int / 10.0) and jsonb_array_length(d -> 'rows') > 0 from (select public.quotes_page('all', p_page => 999999) as d) z)
  and (select (d ->> 'page')::int = ceil((d ->> 'total')::int / 10.0) from (select public.quotes_page('all', p_page => 2147483647) as d) z)
  and (public.quotes_page('all', 'no such thing', p_page => 4) ->> 'page') = '1');
select pg_temp.res('15 size: 1 to 50', jsonb_array_length(public.quotes_page('all', p_size => 100000) -> 'rows') <= 50 and (public.quotes_page('all', p_size => 100000) ->> 'size') = '50' and (public.quotes_page('all', p_size => 0) ->> 'size') = '1' and (public.quotes_page('all', p_size => null) ->> 'size') = '10');
select pg_temp.res('16 unknown tab refused; "active" = all; unknown switch = all', pg_temp.j('select public.quotes_page(''x'')') ->> 'err' like '22023%' and public.quotes_page('active') -> 'total' = public.quotes_page('all') -> 'total'
  and public.quotes_page('deleted', p_kind => 'bogus') -> 'total' = public.quotes_page('deleted') -> 'total');
select pg_temp.res('17 sort updated = newest first', (select to_jsonb(array_agg(u order by n)) from (select q.id u, row_number() over (order by q.updated_at desc, q.id desc) n from public.quotes q where q.id = any (pg_temp.old('all', current_date, null)) order by 2 limit 10) z)
  = (select jsonb_agg(e.v -> 'id' order by e.n) from jsonb_array_elements(public.quotes_page('all', p_sort => 'updated') -> 'rows') with ordinality e(v, n)));
select pg_temp.res('18 a row carries only the list columns (no pricing JSON, no approval link, no e-mail)', (select bool_and(not (e ? 'pricing') and not (e ? 'approval_token') and not (e ? 'client') and not (e ? 'org_id')) and bool_or(e ? 'total') from jsonb_array_elements(public.quotes_page('all') -> 'rows') e)
  and position('items' in public.quotes_page('all')::text) = 0);
-- In progress
do $$ declare d jsonb; o jsonb; ids jsonb := '[]'; n int := 0; tot int; begin
  o := public.my_open_quotes('studio', 100, 0); tot := (o ->> 'total')::int;
  loop n := n + 1; d := public.quotes_page('inprogress', p_page => n); ids := ids || coalesce((select jsonb_agg(e -> 'id') from jsonb_array_elements(d -> 'rows') e), '[]'); exit when n * 10 >= tot or n > 20; end loop;
  perform pg_temp.res('19 In progress = my_open_quotes, page by page, same total and rights', tot > 10 and (d ->> 'total')::int = tot and ids = (select jsonb_agg(e.v -> 'id' order by e.n) from jsonb_array_elements(o -> 'rows') with ordinality e(v, n))
    and d -> 'can_edit' = o -> 'can_edit' and d -> 'open' = 'true'::jsonb, tot || ' / ' || jsonb_array_length(ids));
  d := public.quotes_page('inprogress', p_page => 999);
  perform pg_temp.res('20 In progress: beyond the end -> the last page', (d ->> 'page')::int = ceil(tot / 10.0) and jsonb_array_length(d -> 'rows') between 1 and 10);
  d := public.quotes_page('inprogress', 'client 1', 'Wedding');
  perform pg_temp.res('21 In progress: search + type', (d ->> 'total')::int > 0 and (d ->> 'total')::int = (select count(*) from jsonb_array_elements(o -> 'rows') e where lower(e ->> 'event_type') = 'wedding' and lower(concat_ws(' ', e ->> 'title', e ->> 'code', e #>> '{client,name}')) like '%client 1%'
        or (lower(e ->> 'event_type') = 'wedding' and lower(concat_ws(' ', e ->> 'title', e ->> 'code', e #>> '{client,name}', e ->> 'event_type', e #>> '{client,city}')) like '%client 1%')), d ->> 'total');
  perform pg_temp.res('22 In progress: the automatic name finds its quote, junk finds nothing', (public.quotes_page('inprogress', 'wed_hyd') ->> 'total')::int > 0 and (public.quotes_page('inprogress', '___') ->> 'total')::int = 0 and (public.quotes_page('inprogress', 'zzqq') ->> 'total')::int = 0);
  perform pg_temp.res('23 In progress: event dates', (public.quotes_page('inprogress', p_from => current_date - 2, p_to => current_date + 2) ->> 'total')::int = (select count(*) from jsonb_array_elements(o -> 'rows') e where (e ->> 'event_date')::date between current_date - 2 and current_date + 2));
end $$;
-- who sees what
select pg_temp.res('24 only the own studio, also through p_ids', (select bool_and(q.org_id = 'a0000000-0000-4000-8000-000000000001') from unnest(array(select (jsonb_array_elements_text(pg_temp.neu('attention', current_date, array['a0000000-0000-4000-8000-000000446061']::uuid[]) -> 'ids'))::uuid)) u join public.quotes q on q.id = u)
  and not (pg_temp.neu('attention', current_date, array['a0000000-0000-4000-8000-000000446061']::uuid[]) -> 'ids') ? 'a0000000-0000-4000-8000-000000446061');
select pg_temp.login('b_admin@b.test');
select pg_temp.res('25 the other studio sees only its own', (select bool_and(c.n = (select (public.quotes_page('all', p_search => 'T446') ->> 'total')::int)) from (select count(*) n from public.quotes where code like 'T446%' and archived_at is null and deleted_at is null and status <> 'cancelled' and not (coalesce(lifecycle_stage, '') = 'closed' and status = 'confirmed')) c)
  and (public.quotes_page('all', 'T446-01') ->> 'total') = '0' and position('T446-01' in public.quotes_page('all', p_size => 50)::text) = 0
  and (public.quotes_page() #>> '{counts,deleted}')::int = (select count(*) from public.quotes where deleted_at is not null) and (public.quotes_page() #>> '{counts,deleted}')::int <= 5);
select pg_temp.login('a_noq446@a.test');
select pg_temp.res('26 no Quotes view: nothing, as before', (public.quotes_page() ->> 'total') = '0' and public.quotes_page() -> 'rows' = '[]'::jsonb and (public.quotes_page() #>> '{counts,all}') = '0'
  and (public.quotes_page('deleted') ->> 'total') = '0' and (public.quotes_page('inprogress') ->> 'total') = '0');
select pg_temp.su(); update public.profiles set must_change_password = true where email = 'a_staff@a.test';
select pg_temp.login('a_staff@a.test');
select pg_temp.res('27 temporary password: exactly what the table gives', (public.quotes_page() ->> 'total')::int = cardinality(pg_temp.old('all', current_date, null)));
select pg_temp.su(); update public.profiles set must_change_password = false where email = 'a_staff@a.test'; set role anon;
select pg_temp.res('28 not signed in: refused', pg_temp.j('select public.quotes_page()') ->> 'err' like '42501%');
reset role; set role authenticated;
select pg_temp.res('29 no person behind the request: nothing', coalesce((pg_temp.j('select public.quotes_page()') ->> 'total') = '0', pg_temp.j('select public.quotes_page()') ? 'err'));
reset role;
select pg_temp.su();
select name, result from _rc where result <> 'PASS' order by name;
select 'R258-QUOTES-PAGE-0446: ' || case when count(*) filter (where result <> 'PASS') = 0 then 'ALL PASS' else 'FAIL' end || ' (' || count(*) filter (where result = 'PASS') || '/' || count(*) || ')' from _rc;
rollback;
