-- r247-p10-scale-0427-0429.sql -- R247 fix plan Phase 10 (scale and speed): layout live signals + size cap (0427, Q-11),
-- the stock-photo upload rate (0428, FILE-05), the storage meter + 80 % bell (0429, FILE-04), report timing budgets (REP-03).
-- Proves: (1) structure - the signal table has row security, signed-in staff may only read it, anon nothing; the new
-- functions are definer with an empty search_path; only storage_usage() is open to signed-in users;
-- (2) signals - a saved floor-plan version / quotation version updates ONE small row per event and kind (version number,
-- no layout data), the studio's own staff see it, another studio does not; quote_versions stay in place for old pages;
-- (3) size cap - NOT VALID (old rows never checked), a new version over 10 MB is refused (23514), a normal one saves;
-- (4) stock-photo cap - a stock photo upload is refused once the person made 100 uploads in 10 minutes (files or log), other
-- paths are not touched by the new rule; (5) storage meter - signed-out / no Settings view refused, numbers of the own studio
-- only, per kind; at 80 % one bell row (seen in the bell), not again within 7 days, nothing for the other studio; the upload
-- trigger sums at most once an hour; (6) timing budgets - with 300 confirmed events over a year, each 3-month report piece
-- and the whole year in pieces stay well inside the 8 s limit, and the pieces return exactly the rows of one call.
-- Re-applies 0427-0429 twice. Local disposable PG only. Fake data only. Rolled back.
\set ON_ERROR_STOP 0
set client_min_messages = error;
\ir ../../supabase/migrations/0427_r247_layout_live_signals.sql
\ir ../../supabase/migrations/0428_r247_stock_upload_cap.sql
\ir ../../supabase/migrations/0429_r247_storage_usage.sql
\ir ../../supabase/migrations/0427_r247_layout_live_signals.sql
\ir ../../supabase/migrations/0428_r247_stock_upload_cap.sql
\ir ../../supabase/migrations/0429_r247_storage_usage.sql
set client_min_messages = warning;
begin;
create temp table _rs(name text, result text); grant all on _rs to anon, authenticated, service_role;
create or replace function pg_temp.t(p_name text, p_ok boolean, p_detail text default '') returns void language plpgsql as $$
begin insert into _rs values (p_name, case when coalesce(p_ok, false) then 'PASS' else 'FAIL: ' || coalesce(p_detail, '') end); end $$;
grant execute on function pg_temp.t(text, boolean, text) to anon, authenticated, service_role;
create or replace function pg_temp.su() returns void language plpgsql as $$
begin execute 'reset role'; perform auth.logout(); execute 'reset role'; perform set_config('request.jwt.claims', '', false); end $$;
create or replace function pg_temp.login(p_email text) returns void language plpgsql as $$
declare u uuid; begin
  perform pg_temp.su(); select id into u from auth.users where email = p_email;
  perform set_config('request.jwt.claims', jsonb_build_object('sub', u, 'role', 'authenticated', 'email', p_email, 'aal', 'aal1')::text, false);
  perform set_config('role', 'authenticated', false);
end $$;
create or replace function pg_temp.anon() returns void language plpgsql as $$
begin perform pg_temp.su(); perform set_config('request.jwt.claims', '{"role":"anon"}', false); perform set_config('role', 'anon', false); end $$;
create or replace function pg_temp.try(p_sql text) returns text language plpgsql as $$
begin execute p_sql; return 'ok'; exception when others then return sqlstate || ' ' || sqlerrm; end $$;
grant execute on function pg_temp.try(text) to anon, authenticated, service_role;
create or replace function pg_temp.uid(p_email text) returns uuid language sql as $$ select id from auth.users where email = p_email $$;
grant execute on function pg_temp.uid(text) to anon, authenticated, service_role;

-- ---- 1) structure -----------------------------------------------------------------------------------------------------
select pg_temp.t('1a quote_live_signals: row security on, signed-in may only read, anon nothing',
  (select relrowsecurity from pg_class where oid = 'public.quote_live_signals'::regclass)
  and has_table_privilege('authenticated', 'public.quote_live_signals', 'select')
  and not has_table_privilege('authenticated', 'public.quote_live_signals', 'insert')
  and not has_table_privilege('authenticated', 'public.quote_live_signals', 'update')
  and not has_table_privilege('authenticated', 'public.quote_live_signals', 'delete')
  and not has_table_privilege('anon', 'public.quote_live_signals', 'select'));
select pg_temp.t('1b storage_usage_alerts: row security on, no app access',
  (select relrowsecurity from pg_class where oid = 'public.storage_usage_alerts'::regclass)
  and not has_table_privilege('authenticated', 'public.storage_usage_alerts', 'select')
  and not has_table_privilege('anon', 'public.storage_usage_alerts', 'select'));
select pg_temp.t('1c new functions: definer + empty search_path',
  (select bool_and(p.prosecdef and p.proconfig @> array['search_path=""']) from pg_proc p
    where p.oid in ('public._r427_tg_live_signal()'::regprocedure, 'public._r428_upload_rate_ok()'::regprocedure,
                    'public._r429_usage(uuid)'::regprocedure, 'public._r429_maybe_bell(uuid,jsonb)'::regprocedure,
                    'public._r429_tg_usage_check()'::regprocedure, 'public.storage_usage()'::regprocedure)),
  (select string_agg(p.proname || ':' || coalesce(array_to_string(p.proconfig, ','), '-'), ' ') from pg_proc p where p.proname like '\_r42%' or p.proname = 'storage_usage'));
select pg_temp.t('1d grants: storage_usage for signed-in, helpers closed, nothing for anon',
  has_function_privilege('authenticated', 'public.storage_usage()', 'execute')
  and not has_function_privilege('anon', 'public.storage_usage()', 'execute')
  and not has_function_privilege('authenticated', 'public._r429_usage(uuid)', 'execute')
  and not has_function_privilege('authenticated', 'public._r429_maybe_bell(uuid,jsonb)', 'execute')
  and not has_function_privilege('anon', 'public._r428_upload_rate_ok()', 'execute'));
select pg_temp.t('1e triggers in place: 2 live-signal triggers, the usage check on the upload log',
  (select count(*) from pg_trigger where tgname = 'zz_r427_live_signal' and not tgisinternal) = 2
  and exists (select 1 from pg_trigger where tgname = 'zz_r429_usage_check' and tgrelid = 'public.storage_upload_log'::regclass));
select pg_temp.t('1f the size cap is NOT VALID (rows saved before 0427 are never checked)',
  exists (select 1 from pg_constraint where conname = 'quote_versions_data_size_chk427' and conrelid = 'public.quote_versions'::regclass and not convalidated));
select pg_temp.t('1g schema markers 427 / 428 / 429 recorded',
  to_regclass('public.helm_schema_markers') is null
  or (select count(*) from public.helm_schema_markers where num in (427, 428, 429)) = 3);
select pg_temp.t('1h trial purge list takes the signal rows, keeps the storage check state; the signal table has no quote_id column (0141 / 0220 blank-draft check)',
  (to_regprocedure('public._tr184_purge_tables()') is null or 'quote_live_signals' = any(public._tr184_purge_tables()))
  and (to_regprocedure('public._tr184_keep_tables()') is null or 'storage_usage_alerts' = any(public._tr184_keep_tables()))
  and not exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'quote_live_signals' and column_name = 'quote_id'));

-- ---- 2) live signals --------------------------------------------------------------------------------------------------
do $$ declare qa uuid := 'a0000000-0000-4000-8000-00000000da01'; qb uuid := 'b0000000-0000-4000-8000-00000000da01';
  a uuid := 'a0000000-0000-4000-8000-000000000001'; b uuid := 'b0000000-0000-4000-8000-000000000001';
  n0 int; v1 int; v2 int; nrow int; vno int; seenA int; seenB int; cols text;
begin
  perform pg_temp.su();
  set local helm.r397_plan_lock = off;
  select coalesce(max(version_no), 0) into n0 from public.quote_versions where quote_id = qa;
  insert into public.quote_versions(quote_id, version_no, data, object_count, org_id) values (qa, n0 + 1, '{"items":[{"t":"table"}]}', 1, a);
  insert into public.quote_versions(quote_id, version_no, data, object_count, org_id) values (qa, n0 + 2, '{"items":[{"t":"table"},{"t":"bar"}]}', 2, a);
  insert into public.quote_versions(quote_id, version_no, data, object_count, org_id)
    values (qb, coalesce((select max(version_no) from public.quote_versions where quote_id = qb), 0) + 1, '{"items":[]}', 0, b);
  select count(*), max(version_no) into nrow, vno from public.quote_live_signals where event_id = qa and kind = 'layout';
  perform pg_temp.t('2a two saves = ONE signal row for the event, holding the newest version number', nrow = 1 and vno = n0 + 2, nrow || ' / ' || coalesce(vno, -1));
  select string_agg(column_name, ',' order by ordinal_position) into cols from information_schema.columns where table_schema = 'public' and table_name = 'quote_live_signals';
  perform pg_temp.t('2b the signal row carries no layout data (ids, kind, version, time only)', cols = 'event_id,kind,org_id,version_no,changed_at', cols);
  insert into public.quotation_versions(quote_id, label, pricing, total, org_id) values (qa, 'Q-r247', '{}', 0, a);
  perform pg_temp.t('2c a quotation version = a quotation signal row',
    exists (select 1 from public.quote_live_signals where event_id = qa and kind = 'quotation' and org_id = a));
  perform pg_temp.login('a_admin@a.test');
  select count(*) filter (where org_id = a), count(*) filter (where org_id = b) into seenA, seenB from public.quote_live_signals;
  perform pg_temp.t('2d own studio staff read their signals, never another studio''s', seenA >= 2 and seenB = 0, seenA || ' / ' || seenB);
  perform pg_temp.t('2e signed-in staff cannot write a signal row',
    pg_temp.try($q$update public.quote_live_signals set version_no = 0$q$) like '42501%'
    and pg_temp.try($q$insert into public.quote_live_signals(event_id, kind, org_id) values (gen_random_uuid(), 'layout', public.current_org_id())$q$) like '42501%');
  perform pg_temp.anon();
  perform pg_temp.t('2f signed-out: no access', pg_temp.try('select count(*) from public.quote_live_signals') like '42501%');
  perform pg_temp.su();
  perform pg_temp.t('2g quote_versions keep every saved version (nothing removed by the trigger)',
    (select count(*) from public.quote_versions where quote_id = qa and version_no in (n0 + 1, n0 + 2)) = 2);
exception when others then perform pg_temp.su(); insert into _rs values ('2x signals', 'FAIL: ' || sqlstate || ' ' || sqlerrm); end $$;

-- ---- 3) size cap ------------------------------------------------------------------------------------------------------
do $$ declare qa uuid := 'a0000000-0000-4000-8000-00000000da01'; a uuid := 'a0000000-0000-4000-8000-000000000001'; n int; r text;
begin
  perform pg_temp.su();
  set local helm.r397_plan_lock = off;
  select coalesce(max(version_no), 0) + 1 into n from public.quote_versions where quote_id = qa;
  r := pg_temp.try(format($q$insert into public.quote_versions(quote_id, version_no, data, object_count, org_id)
          values (%L, %s, jsonb_build_object('items', '[]'::jsonb, 'note', repeat('x', 11 * 1024 * 1024)), 0, %L)$q$, qa, n, a));
  perform pg_temp.t('3a a new version over 10 MB is refused (23514, the 0427 check)', r like '23514%quote_versions_data_size_chk427%', left(r, 160));
  r := pg_temp.try(format($q$insert into public.quote_versions(quote_id, version_no, data, object_count, org_id)
          values (%L, %s, jsonb_build_object('items', '[]'::jsonb, 'note', repeat('x', 2 * 1024 * 1024)), 0, %L)$q$, qa, n, a));
  perform pg_temp.t('3b a 2 MB layout still saves', r = 'ok', r);
exception when others then perform pg_temp.su(); insert into _rs values ('3x size cap', 'FAIL: ' || sqlstate || ' ' || sqlerrm); end $$;

-- ---- 4) stock-photo upload rate -----------------------------------------------------------------------------------------
do $$ declare a uuid := 'a0000000-0000-4000-8000-000000000001'; u uuid := pg_temp.uid('a_admin@a.test'); r text; ok1 boolean; ok2 boolean;
  p text;
begin
  perform pg_temp.su();
  perform pg_temp.t('4a the restrictive stock-photo policy exists (insert, authenticated)',
    exists (select 1 from pg_policy where polname = 'event_docs_stock_rate_0428' and polrelid = 'storage.objects'::regclass and not polpermissive and polcmd = 'a'));
  insert into public.storage_upload_log(owner, bucket_id, created_at) select u, 'event-docs', now() - interval '1 minute' from generate_series(1, 99);
  perform pg_temp.login('a_admin@a.test');
  ok1 := public._r428_upload_rate_ok();
  p := a::text || '/none/stock/' || gen_random_uuid()::text || '.jpg';
  r := pg_temp.try(format($q$insert into storage.objects(bucket_id, name, owner, metadata) values ('event-docs', %L, auth.uid(), '{"size":1000}')$q$, p));
  perform pg_temp.t('4b at 99 uploads in 10 minutes a stock photo still uploads', ok1 and r = 'ok', coalesce(ok1::text, '-') || ' ' || r);
  -- that upload logged the 100th (0032 trigger); one more is refused
  perform pg_temp.su();
  if (select count(*) from public.storage_upload_log where owner = u and created_at > now() - interval '10 minutes') < 100 then
    insert into public.storage_upload_log(owner, bucket_id) values (u, 'event-docs'); end if;
  perform pg_temp.login('a_admin@a.test');
  ok2 := public._r428_upload_rate_ok();
  r := pg_temp.try(format($q$insert into storage.objects(bucket_id, name, owner, metadata) values ('event-docs', %L, auth.uid(), '{"size":1000}')$q$,
         a::text || '/none/stock/' || gen_random_uuid()::text || '.jpg'));
  perform pg_temp.t('4c at 100 uploads in 10 minutes the next stock photo is refused', not ok2 and r like '42501%', coalesce(ok2::text, '-') || ' ' || r);
  perform pg_temp.su();
  perform pg_temp.login('a_admin@a.test');
  perform pg_temp.t('4f the name guard: the stock key of the OWN studio passes, another studio''s / a bad name / a pdf do not, the 3-part key still passes',
    public.storage_object_name_ok('event-docs', a::text || '/none/stock/' || gen_random_uuid()::text || '.webp')
    and public.storage_object_name_ok('event-docs', a::text || '/' || gen_random_uuid()::text || '/stock/' || gen_random_uuid()::text || '.jpg')
    and not public.storage_object_name_ok('event-docs', 'b0000000-0000-4000-8000-000000000001/none/stock/' || gen_random_uuid()::text || '.jpg')
    and not public.storage_object_name_ok('event-docs', a::text || '/none/stock/../x.jpg')
    and not public.storage_object_name_ok('event-docs', a::text || '/none/stock/' || gen_random_uuid()::text || '.pdf')
    and public.storage_object_name_ok('event-docs', a::text || '/' || gen_random_uuid()::text || '/' || gen_random_uuid()::text || '.pdf')
    and to_regprocedure('public.storage_object_name_ok__pre0428(text,text)') is not null
    and not has_function_privilege('anon', 'public.storage_object_name_ok__pre0428(text,text)', 'execute')
    and not has_function_privilege('authenticated', 'public.storage_object_name_ok__pre0428(text,text)', 'execute'));
  perform pg_temp.su();
  perform pg_temp.t('4d older uploads (over 10 minutes ago) do not count',
    (select count(*) from public.storage_upload_log where owner = u) >= 100);
  update public.storage_upload_log set created_at = now() - interval '11 minutes' where owner = u;
  update storage.objects set created_at = now() - interval '11 minutes' where owner = u;
  perform pg_temp.login('a_admin@a.test');
  perform pg_temp.t('4e after the window the stock upload is allowed again', public._r428_upload_rate_ok());
  perform pg_temp.su();
exception when others then perform pg_temp.su(); insert into _rs values ('4x stock cap', 'FAIL: ' || sqlstate || ' ' || sqlerrm); end $$;

-- ---- 5) storage meter + bell --------------------------------------------------------------------------------------------
do $$ declare a uuid := 'a0000000-0000-4000-8000-000000000001'; b uuid := 'b0000000-0000-4000-8000-000000000001';
  v jsonb; r text; n1 int; n2 int; nb int; c1 timestamptz; c2 timestamptz; feed jsonb; u uuid := pg_temp.uid('a_admin@a.test');
begin
  perform pg_temp.su();
  set local helm.storage_usage_check = off;   -- set the scene without the upload trigger
  delete from public.storage_usage_alerts where org_id in (a, b);
  insert into storage.objects(bucket_id, name, owner, metadata) values
    ('chat-media', a::text || '/c1/' || gen_random_uuid() || '.webp', u, '{"size":1000000}'),
    ('invite-media', a::text || '/q1/' || gen_random_uuid() || '.webp', u, '{"size":3000000}'),
    ('chat-media', b::text || '/c1/' || gen_random_uuid() || '.webp', null, '{"size":999999999}');
  perform pg_temp.anon();
  perform pg_temp.t('5a signed-out: storage_usage refused', pg_temp.try('select public.storage_usage()') like '42501%');
  perform pg_temp.login('a_admin@a.test');
  v := public.storage_usage();
  perform pg_temp.su();
  perform pg_temp.t('5b own studio only: bytes of studio A, the 2 GB default quota, per-kind split',
    (v ->> 'used_bytes')::bigint = (select coalesce(sum((o.metadata ->> 'size')::bigint), 0) from storage.objects o
                                      where o.name like a::text || '/%' and o.bucket_id in ('invite-media', 'event-docs', 'chat-media', 'task-proof', 'member-avatars')
                                        and coalesce(o.metadata ->> 'size', '') ~ '^[0-9]{1,15}$')
    and (v ->> 'used_bytes')::bigint < 999999999 and (v ->> 'quota_bytes')::bigint = 2147483648
    and jsonb_array_length(v -> 'buckets') >= 2 and (v ->> 'warn_pct')::int = 80 and v::text not like '%.webp%', v::text);
  perform pg_temp.t('5c under 80 %: no bell', not exists (select 1 from public.notifications where kind = 'storage_usage_high'));
  insert into storage.objects(bucket_id, name, owner, metadata) values ('event-docs', a::text || '/q1/' || gen_random_uuid() || '.pdf', u, '{"size":1800000000}');
  perform pg_temp.login('a_admin@a.test');
  v := public.storage_usage(); v := public.storage_usage();
  perform pg_temp.su();
  select count(*) into n1 from public.notifications where kind = 'storage_usage_high' and org_id = a;
  select count(*) into nb from public.notifications where kind = 'storage_usage_high' and org_id = b;
  perform pg_temp.t('5d at 80 % or more: ONE bell row for the studio (asked twice), none for the other studio',
    (v ->> 'pct')::numeric >= 80 and n1 = 1 and nb = 0, (v ->> 'pct') || ' ' || n1 || ' ' || nb);
  perform pg_temp.t('5e the bell row says it in plain words (numbers only)',
    (select n.detail ->> 'label' from public.notifications n where n.kind = 'storage_usage_high' and n.org_id = a limit 1) ~ '^Studio file storage is [0-9]+% full \([0-9]+ MB of [0-9]+ MB\)');
  perform pg_temp.login('a_admin@a.test');
  feed := public.bell_feed(50);
  perform pg_temp.su();
  perform pg_temp.t('5f the studio admin sees it in the bell',
    exists (select 1 from jsonb_array_elements(feed -> 'items') e where e ->> 'kind' = 'storage_usage_high'), left(feed::text, 200));
  update public.storage_usage_alerts set alerted_at = now() - interval '8 days' where org_id = a;
  perform pg_temp.login('a_admin@a.test'); v := public.storage_usage(); perform pg_temp.su();
  select count(*) into n2 from public.notifications where kind = 'storage_usage_high' and org_id = a;
  perform pg_temp.t('5g still full after 7 days: one more bell', n2 = 2, n2::text);
  perform pg_temp.login('a_staff@a.test');
  r := pg_temp.try('select public.storage_usage()');
  perform pg_temp.su();
  perform pg_temp.t('5h without Settings view: refused (or allowed only by the role matrix)',
    r like '42501%' or (select public._r23_area(a, 'sales', 'controls', 'view')), r);
  -- the upload trigger: one sum an hour per studio
  set local helm.storage_usage_check = on;
  update public.storage_usage_alerts set checked_at = now() - interval '2 hours' where org_id = a;
  -- the 0032 storage trigger writes this row inside the uploader's request (claims of a_admin)
  perform set_config('request.jwt.claims', jsonb_build_object('sub', u, 'role', 'authenticated')::text, true);
  insert into public.storage_upload_log(owner, bucket_id) values (u, 'chat-media');
  select checked_at into c1 from public.storage_usage_alerts where org_id = a;
  insert into public.storage_upload_log(owner, bucket_id) values (u, 'chat-media');
  perform pg_temp.su();
  select checked_at into c2 from public.storage_usage_alerts where org_id = a;
  perform pg_temp.t('5i after an upload the studio is checked, then not again within the hour',
    c1 > now() - interval '1 minute' and c2 = c1, coalesce(c1::text, '-') || ' / ' || coalesce(c2::text, '-'));
exception when others then perform pg_temp.su(); insert into _rs values ('5x storage', 'FAIL: ' || sqlstate || ' ' || sqlerrm); end $$;

-- ---- 6) report timing budgets (REP-03) ----------------------------------------------------------------------------------
do $$ declare a uuid := 'a0000000-0000-4000-8000-000000000001'; i int; q uuid; t0 timestamptz; ms_piece numeric := 0; ms_year numeric;
  ms_ev numeric; ms_ov numeric; r jsonb; ids_one text[]; ids_pieces text[] := '{}'; w record; d0 date := date '2025-01-01';
begin
  perform pg_temp.su();
  for i in 1..300 loop
    q := gen_random_uuid();
    insert into public.quotes(id, code, title, event_type, status, lifecycle_stage, event_date, pricing, client, org_id, created_at, confirmed_at)
    values (q, 'TB-' || i, 'Timing ' || i, case when i % 2 = 0 then 'Wedding' else 'Birthday' end, 'confirmed', 'planning', d0 + (i * 365 / 300),
            jsonb_build_object('subtotal', 100000 + i, 'discount', 0, 'gstPct', 18, 'total', 118000 + i, 'guests', 100 + i), '{"guests":"120"}', a,
            (d0 + (i * 365 / 300))::timestamptz - interval '60 days', (d0 + (i * 365 / 300))::timestamptz - interval '30 days');
    if i % 3 = 0 then
      insert into public.payment_milestones(quote_id, label, amount, status, org_id) values (q, 'Advance', 50000, 'paid', a);
    end if;
  end loop;
  perform pg_temp.login('a_admin@a.test');
  for w in select * from (values (date '2025-01-01', date '2025-03-31'), (date '2025-04-01', date '2025-06-30'),
                                 (date '2025-07-01', date '2025-09-30'), (date '2025-10-01', date '2025-12-31')) v(f, t) loop
    t0 := clock_timestamp();
    r := public.insights_event_costs(w.f, w.t);
    ms_piece := greatest(ms_piece, extract(epoch from clock_timestamp() - t0) * 1000);
    ids_pieces := ids_pieces || coalesce((select array_agg(e ->> 'id') from jsonb_array_elements(r -> 'events') e), '{}');
  end loop;
  t0 := clock_timestamp();
  r := public.insights_event_costs(date '2025-01-01', date '2025-12-31');
  ms_year := extract(epoch from clock_timestamp() - t0) * 1000;
  ids_one := coalesce((select array_agg(e ->> 'id') from jsonb_array_elements(r -> 'events') e), '{}');
  t0 := clock_timestamp(); r := public.insights_events(date '2025-01-01', date '2025-12-31'); ms_ev := extract(epoch from clock_timestamp() - t0) * 1000;
  t0 := clock_timestamp(); r := public.insights_overview(date '2025-01-01', date '2025-12-31', null); ms_ov := extract(epoch from clock_timestamp() - t0) * 1000;
  perform pg_temp.su();
  perform pg_temp.t('6a one 3-month piece of the cost report: under 2 s (300 events a year)', ms_piece < 2000, round(ms_piece) || ' ms');
  perform pg_temp.t('6b the whole year in one call: under the 8 s limit with room (under 4 s)', ms_year < 4000, round(ms_year) || ' ms');
  perform pg_temp.t('6c the pieces return exactly the rows of one call (no row lost or doubled)',
    cardinality(ids_pieces) = cardinality(ids_one) and (select count(distinct x) from unnest(ids_pieces) x) = cardinality(ids_one)
    and ids_pieces @> ids_one and ids_one @> ids_pieces and cardinality(ids_one) >= 299, cardinality(ids_pieces) || ' / ' || cardinality(ids_one));
  perform pg_temp.t('6d per-event profit (insights_events) and the overview for a year: under 4 s each',
    ms_ev < 4000 and ms_ov < 4000, round(ms_ev) || ' / ' || round(ms_ov) || ' ms');
exception when others then perform pg_temp.su(); insert into _rs values ('6x timing', 'FAIL: ' || sqlstate || ' ' || sqlerrm); end $$;

select name, result from _rs order by name;
select case when count(*) filter (where result <> 'PASS') = 0 then 'R247-P10-SCALE-0427-0429: ALL PASS (' || count(*) || '/' || count(*) || ')'
            else 'R247-P10-SCALE-0427-0429: ' || count(*) filter (where result <> 'PASS') || ' FAILED of ' || count(*) end as summary from _rs;
rollback;
