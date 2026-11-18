-- audit-d-list-indexes-0393.sql - Audit D (0393): Leads / Quotes newest-first list indexes on seeded volume. Proves:
-- (1) 0393 applied twice: both indexes exist once, are valid and have the expected key (org_id, updated_at desc, id desc);
-- (2) the older indexes are kept and row security is still on;
-- (3) the bug: WITHOUT the new index a small studio next to 200 busy studios walks the global updated_at index and throws
--     away almost every lead of other studios (row security on, signed in as the studio admin);
-- (4) WITH the index the same page uses ix_leads_org_updated_0393 and reads only a handful of rows; same for quotes;
-- (5) same answers: the page rows (ids, in order) are identical with and without the new indexes, for a small and a big
--     studio, leads and quotes, with and without a status filter;
-- (6) isolation unchanged: studio B never sees a lead or quote of studio A or of the seeded studios.
-- Local disposable PG only. Fixture studios A + B. Rolled back.
\set ON_ERROR_STOP 0
set client_min_messages = error;
\ir ../../supabase/migrations/0393_audit_d_list_indexes.sql
\ir ../../supabase/migrations/0393_audit_d_list_indexes.sql
set client_min_messages = warning;
begin;
create temp table _d393(name text, result text); grant all on _d393 to anon, authenticated, service_role;
create temp table _d393kv(k text primary key, v jsonb); grant all on _d393kv to anon, authenticated, service_role;
create or replace function pg_temp.su() returns void language plpgsql as $$
begin execute 'reset role'; perform auth.logout(); execute 'reset role'; end $$;
create or replace function pg_temp.login(p_email text) returns void language plpgsql as $$
declare u uuid; begin
  perform pg_temp.su(); select id into u from auth.users where email = p_email;
  perform set_config('request.jwt.claims', jsonb_build_object('sub', u, 'role', 'authenticated', 'email', p_email, 'aal', 'aal1')::text, false);
  perform set_config('role', 'authenticated', false);
end $$;
create or replace function pg_temp.ok(p_name text, p_ok boolean) returns void language plpgsql as $$
begin insert into _d393 values (p_name, case when coalesce(p_ok, false) then 'PASS' else 'FAIL' end); end $$;
-- the plan of one query as text (index names + rows removed), run as the CURRENT role
create or replace function pg_temp.plan(p_sql text) returns jsonb language plpgsql as $$
declare j json; begin execute 'explain (analyze, format json, costs off, timing off) ' || p_sql into j; return j::jsonb; end $$;
-- the first node that scans leads / quotes, with the rows it removed by filter
create or replace function pg_temp.scan(p jsonb, p_rel text) returns jsonb language sql as $$
  with recursive n(node) as (select p -> 0 -> 'Plan' union all select c from n, jsonb_array_elements(coalesce(n.node -> 'Plans', '[]'::jsonb)) c)
  select jsonb_build_object('index', node ->> 'Index Name', 'removed', coalesce((node ->> 'Rows Removed by Filter')::int, 0),
                            'type', node ->> 'Node Type')
    from n where node ->> 'Relation Name' = p_rel limit 1 $$;

-- ---- (1) + (2) applied twice ----------------------------------------------------------------------------------------------
select pg_temp.ok('01 leads index once, valid, expected key',
  (select count(*) from pg_index i join pg_class c on c.oid = i.indexrelid where c.relname = 'ix_leads_org_updated_0393'
     and i.indisvalid and i.indrelid = 'public.leads'::regclass
     and pg_get_indexdef(i.indexrelid) like '%(org_id, updated_at DESC, id DESC)') = 1);
select pg_temp.ok('02 quotes index once, valid, expected key',
  (select count(*) from pg_index i join pg_class c on c.oid = i.indexrelid where c.relname = 'ix_quotes_org_updated_0393'
     and i.indisvalid and i.indrelid = 'public.quotes'::regclass
     and pg_get_indexdef(i.indexrelid) like '%(org_id, updated_at DESC, id DESC)') = 1);
select pg_temp.ok('03 older indexes kept + row security on',
  to_regclass('public.leads_org_idx') is not null and to_regclass('public.leads_updated_idx') is not null
  and to_regclass('public.quotes_org_idx') is not null and to_regclass('public.quotes_updated_idx') is not null
  and (select bool_and(relrowsecurity) from pg_class where oid in ('public.leads'::regclass, 'public.quotes'::regclass)));

-- ---- seed: 200 busy studios (200 leads + 100 quotes each), studio A busy, studio B small --------------------------------
set local session_replication_role = replica;
create temp table _o as select gen_random_uuid() id, g rn from generate_series(1, 200) g;
insert into public.organizations(id, name) select id, 'D393 seed ' || rn from _o;
insert into public.leads(org_id, name, status, created_at, updated_at)
  select o.id, 'L' || g, (array['new','qualified','won','lost'])[1 + g % 4], now() - make_interval(mins => g), now() - make_interval(mins => g)
    from _o o, generate_series(1, 200) g;
insert into public.leads(org_id, name, status, created_at, updated_at)
  select 'a0000000-0000-4000-8000-000000000001', 'A' || g, 'new', now() - make_interval(mins => g), now() - make_interval(mins => g)
    from generate_series(1, 1500) g;
insert into public.leads(org_id, name, status, created_at, updated_at)
  select 'b0000000-0000-4000-8000-000000000001', 'B' || g, 'new', now() - make_interval(days => 400 + g), now() - make_interval(days => 400 + g)
    from generate_series(1, 3) g;
insert into public.quotes(id, org_id, code, title, status, updated_at, created_at)
  select gen_random_uuid(), o.id, 'D393-' || o.rn || '-' || g, 'E' || g, (array['quote','confirmed','cancelled'])[1 + g % 3],
         now() - make_interval(mins => g), now() - make_interval(mins => g)
    from _o o, generate_series(1, 100) g;
insert into public.quotes(id, org_id, code, title, status, updated_at, created_at)
  select gen_random_uuid(), 'b0000000-0000-4000-8000-000000000001', 'D393-B-' || g, 'B' || g, 'quote',
         now() - make_interval(days => 400 + g), now() - make_interval(days => 400 + g)
    from generate_series(1, 3) g;
set local session_replication_role = origin;
analyze public.leads; analyze public.quotes;

-- the four page queries the app sends (store-api leads.page / quotes.page), row security adds the studio
create temp table _q(k text, rel text, sql text); grant all on _q to anon, authenticated, service_role;
insert into _q values
  ('leads',        'leads',  'select id from public.leads order by updated_at desc, id desc limit 26'),
  ('leads_status', 'leads',  'select id from public.leads where status = ''new'' order by updated_at desc, id desc limit 26'),
  ('quotes',       'quotes', 'select id from public.quotes where archived_at is null and deleted_at is null order by updated_at desc, id desc limit 26'),
  ('quotes_conf',  'quotes', 'select id from public.quotes where status = ''confirmed'' order by updated_at desc, id desc limit 26');

-- run every query as a studio and keep plan + ids; p_tag tells with / without the new indexes
create or replace function pg_temp.capture(p_tag text, p_forced boolean) returns void language plpgsql as $$
declare r record; e text; ids jsonb; pl jsonb; begin
  -- forced = no bitmap scan and no sort: the planner must take an index that already gives the newest-first order
  perform set_config('enable_bitmapscan', case when p_forced then 'off' else 'on' end, true);
  perform set_config('enable_sort', case when p_forced then 'off' else 'on' end, true);
  foreach e in array array['b_admin@b.test', 'a_admin@a.test'] loop
    perform pg_temp.login(e);
    for r in select * from _q loop
      execute 'select coalesce(jsonb_agg(id), ''[]''::jsonb) from (' || r.sql || ') s' into ids;
      pl := pg_temp.scan(pg_temp.plan(r.sql), r.rel);
      perform pg_temp.su();
      insert into _d393kv values (p_tag || '|' || e || '|' || r.k, jsonb_build_object('ids', ids, 'scan', pl));
      perform pg_temp.login(e);
    end loop;
  end loop;
  perform pg_temp.su();
  perform set_config('enable_bitmapscan', 'on', true); perform set_config('enable_sort', 'on', true);
end $$;

-- ---- (3) without the new indexes (dropped inside this rolled-back transaction only) -------------------------------------
drop index public.ix_leads_org_updated_0393; drop index public.ix_quotes_org_updated_0393;
select pg_temp.capture('old', false);
select pg_temp.capture('olf', true);
-- the planner learns the studio only at run time, so it may pick either path - the ordered one walks every studio
select pg_temp.ok('04 bug reproduced: the newest-first path of a small studio leads page walks the global index and drops 10,000+ rows of other studios',
  (select (v -> 'scan' ->> 'removed')::int > 10000 from _d393kv where k = 'olf|b_admin@b.test|leads'));

-- ---- (4) with the indexes (re-applied by the migration itself) -----------------------------------------------------------
set client_min_messages = error;
\ir ../../supabase/migrations/0393_audit_d_list_indexes.sql
set client_min_messages = warning;
analyze public.leads; analyze public.quotes;
select pg_temp.capture('new', false);
select pg_temp.capture('nef', true);
select pg_temp.ok('05 small studio leads page uses ix_leads_org_updated_0393 and drops at most a few rows',
  (select v -> 'scan' ->> 'index' = 'ix_leads_org_updated_0393' and (v -> 'scan' ->> 'removed')::int <= 5 from _d393kv where k = 'new|b_admin@b.test|leads'));
select pg_temp.ok('06 busy studio leads page uses ix_leads_org_updated_0393 + the newest-first path of a small studio drops at most a few rows',
  (select v -> 'scan' ->> 'index' = 'ix_leads_org_updated_0393' from _d393kv where k = 'new|a_admin@a.test|leads')
  and (select v -> 'scan' ->> 'index' = 'ix_leads_org_updated_0393' and (v -> 'scan' ->> 'removed')::int <= 5 from _d393kv where k = 'nef|b_admin@b.test|leads'));
select pg_temp.ok('07 leads page with a status filter stays inside the studio (few rows dropped, default and newest-first path)',
  (select bool_and((v -> 'scan' ->> 'removed')::int <= 50) from _d393kv where k in ('new|b_admin@b.test|leads_status', 'nef|b_admin@b.test|leads_status')));
select pg_temp.ok('08 quotes page (small + busy studio) uses ix_quotes_org_updated_0393',
  (select bool_and(v -> 'scan' ->> 'index' = 'ix_quotes_org_updated_0393') from _d393kv
    where k in ('new|b_admin@b.test|quotes', 'new|a_admin@a.test|quotes')));

-- ---- (5) same answers -------------------------------------------------------------------------------------------------------
select pg_temp.ok('09 every page returns the same ids in the same order with and without the new indexes, on every path (32 pages)',
  (select count(*) = 24 and bool_and(o.v -> 'ids' = n.v -> 'ids') from _d393kv o
     join _d393kv n on n.k in ('new' || substr(o.k, 4), 'nef' || substr(o.k, 4), 'olf' || substr(o.k, 4))
    where o.k like 'old|%'));
select pg_temp.ok('10 pages are filled (studio A leads a full page of 26, studio B its own 3+ seeded leads and quotes)',
  (select jsonb_array_length(v -> 'ids') = 26 from _d393kv where k = 'new|a_admin@a.test|leads')
  and (select jsonb_array_length(v -> 'ids') between 3 and 26 from _d393kv where k = 'new|b_admin@b.test|leads')
  and (select jsonb_array_length(v -> 'ids') between 3 and 26 from _d393kv where k = 'new|b_admin@b.test|quotes'));

-- ---- (6) isolation ----------------------------------------------------------------------------------------------------------
select pg_temp.ok('11 studio B sees only its own leads and quotes on the pages',
  not exists (select 1 from _d393kv kv, jsonb_array_elements_text(kv.v -> 'ids') x(id)
               where kv.k like '%|b_admin@b.test|%'
                 and coalesce((select org_id from public.leads where id = x.id::uuid), (select org_id from public.quotes where id = x.id::uuid))
                     <> 'b0000000-0000-4000-8000-000000000001'));

do $$ declare n int; f int; r record; begin
  select count(*), count(*) filter (where result <> 'PASS') into n, f from _d393;
  for r in select * from _d393 where result <> 'PASS' loop raise warning '% -> %', r.name, r.result; end loop;
  if f = 0 then raise warning 'AUDIT-D-LIST-INDEXES-0393: ALL PASS (%/%)', n, n;
  else raise warning 'AUDIT-D-LIST-INDEXES-0393: % FAILED of %', f, n; end if;
end $$;
rollback;
