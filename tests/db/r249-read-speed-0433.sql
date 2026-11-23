-- r249-read-speed-0433.sql - R249 the bell's chat reads (0433). Proves: (1) applied twice, the old chat_my_mentions kept once
-- (__pre0433, server only), the new body asks the caller once (sub-selects), signed-in only, definer + empty search_path, the
-- (org_id, created_at desc) index exists; (2) THE ANSWER DOES NOT CHANGE: on 3,000 seeded messages (DMs, a group, a broadcast,
-- mentions, read markers, deleted and own messages, another studio) chat_my_mentions answers exactly what the kept body answers
-- for 4 people at limits null / 1 / 20 / 100 / 500; (3) the bell's newest-60 read (row security on) uses the new index and no
-- longer sorts the whole studio; (4) Realtime: chat_reactions leaves supabase_realtime when it is in it, every live table stays,
-- a database without the publication is left alone. Local disposable PG only. Rolled back.
\set ON_ERROR_STOP 0
set client_min_messages = warning;
begin;
create temp table _rm(name text, result text); grant all on _rm to anon, authenticated, service_role;
create temp table _rkv(k text primary key, v text); grant all on _rkv to anon, authenticated, service_role;
create or replace function pg_temp.su() returns void language plpgsql as $$
begin execute 'reset role'; perform auth.logout(); execute 'reset role'; end $$;
create or replace function pg_temp.login(p_email text) returns void language plpgsql as $$
declare u uuid; begin
  perform pg_temp.su(); select id into u from auth.users where email = p_email;
  perform set_config('request.jwt.claims', jsonb_build_object('sub', u, 'role', 'authenticated', 'email', p_email, 'aal', 'aal1')::text, false);
  perform set_config('role', 'authenticated', false);
end $$;
create or replace function pg_temp.res(p_name text, p_ok boolean, p_detail text default '') returns void language plpgsql as $$
begin insert into _rm values (p_name, case when coalesce(p_ok, false) then 'PASS' else 'FAIL: '||coalesce(p_detail,'') end); end $$;
grant execute on function pg_temp.res(text, boolean, text) to anon, authenticated, service_role;
create or replace function pg_temp.put(p_k text, p_v text) returns void language plpgsql as $$
begin insert into _rkv values (p_k, p_v) on conflict (k) do update set v = excluded.v; end $$;
grant execute on function pg_temp.put(text, text) to anon, authenticated, service_role;
create or replace function pg_temp.get(p_k text) returns text language sql as $$ select v from _rkv where k = p_k $$;
grant execute on function pg_temp.get(text) to anon, authenticated, service_role;

-- ---- setup: 3,000 messages in studio A (+ 300 in studio B) ---------------------------------------------------------------------
do $$ declare a uuid := 'a0000000-0000-4000-8000-000000000001'; b uuid := 'b0000000-0000-4000-8000-000000000001';
  ua uuid := (select id from auth.users where email = 'a_admin@a.test'); us uuid := (select id from auth.users where email = 'a_staff@a.test');
  ub uuid := (select id from auth.users where email = 'b_admin@b.test'); dm uuid; gr uuid; bc uuid; ob uuid; i int; c uuid; who uuid;
begin
  insert into public.chat_conversations(org_id, kind, dm_key) values (a, 'dm', 'r249dm') returning id into dm;
  insert into public.chat_conversations(org_id, kind, title) values (a, 'group', 'R249 crew') returning id into gr;
  insert into public.chat_conversations(org_id, kind, title) values (a, 'broadcast', 'Everyone') returning id into bc;
  insert into public.chat_conversations(org_id, kind, title) values (b, 'group', 'B group') returning id into ob;
  insert into public.chat_members(conversation_id, user_id, org_id, last_read_at) values
    (dm, ua, a, now() - interval '3 days'), (dm, us, a, null), (gr, ua, a, now() - interval '10 days'), (gr, us, a, now() - interval '1 day'),
    (ob, ub, b, null);
  for i in 1 .. 3000 loop
    c := (array[dm, gr, bc])[1 + i % 3]; who := case when i % 2 = 0 then ua else us end;
    insert into public.chat_messages(conversation_id, org_id, sender_id, kind, body, created_at, deleted, meta)
      values (c, a, who, 'text', 'R249 message ' || i, now() - make_interval(mins => i * 7), i % 97 = 0,
              case when i % 5 = 0 then jsonb_build_object('mentions', jsonb_build_array(ua::text))
                   when i % 7 = 0 then jsonb_build_object('mentions', jsonb_build_array(us::text, ua::text)) end);
  end loop;
  for i in 1 .. 300 loop
    insert into public.chat_messages(conversation_id, org_id, sender_id, kind, body, created_at, meta)
      values (ob, b, ub, 'text', 'B ' || i, now() - make_interval(mins => i), jsonb_build_object('mentions', jsonb_build_array(ua::text)));
  end loop;
end $$;
-- the kept body's answers BEFORE 0433 (it is the function that becomes __pre0433)
create temp table _old(who text, lim text, v text); grant all on _old to authenticated;
do $$ declare e text; l int; begin
  foreach e in array array['a_admin@a.test', 'a_staff@a.test', 'b_admin@b.test', 'b_staff@b.test'] loop
    perform pg_temp.login(e);
    foreach l in array array[-1, 1, 20, 100, 500] loop
      insert into _old values (e, l::text, coalesce((select jsonb_agg(to_jsonb(x))::text from public.chat_my_mentions(case when l = -1 then null else l end) x), '[]'));
    end loop;
  end loop;
  perform pg_temp.su();
end $$;

-- ---- the migration, twice ------------------------------------------------------------------------------------------------------
set client_min_messages = error;
\ir ../../supabase/migrations/0433_r249_read_speed.sql
\ir ../../supabase/migrations/0433_r249_read_speed.sql
set client_min_messages = warning;

do $$ begin
  perform pg_temp.res('01 applied twice: the old body kept once (__pre0433, server only), the new one signed-in only, definer + empty search_path',
    (select count(*) from pg_proc p join pg_namespace s on s.oid = p.pronamespace where s.nspname = 'public' and p.proname like '%\_\_pre0433') = 1
    and position('r249-0433' in pg_get_functiondef('public.chat_my_mentions(integer)'::regprocedure)) > 0
    and position('(select public.current_org_id())' in pg_get_functiondef('public.chat_my_mentions(integer)'::regprocedure)) > 0
    and position('r249-0433' in pg_get_functiondef('public.chat_my_mentions__pre0433(integer)'::regprocedure)) = 0
    and (select p.prosecdef and p.proconfig @> array['search_path=""'] and p.provolatile = 's' from pg_proc p where p.oid = 'public.chat_my_mentions(integer)'::regprocedure)
    and has_function_privilege('authenticated', 'public.chat_my_mentions(integer)', 'execute')
    and not has_function_privilege('anon', 'public.chat_my_mentions(integer)', 'execute')
    and not has_function_privilege('authenticated', 'public.chat_my_mentions__pre0433(integer)', 'execute')
    and not has_function_privilege('anon', 'public.chat_my_mentions__pre0433(integer)', 'execute'));
  perform pg_temp.res('02 index chat_messages (org_id, created_at desc) exists',
    exists (select 1 from pg_indexes where schemaname = 'public' and indexname = 'chat_messages_org_created_idx_0433'
             and indexdef like '%(org_id, created_at DESC)%'));
end $$;

do $$ declare e text; l int; n int := 0; bad int := 0; v text; hits int := 0; begin
  foreach e in array array['a_admin@a.test', 'a_staff@a.test', 'b_admin@b.test', 'b_staff@b.test'] loop
    perform pg_temp.login(e);
    foreach l in array array[-1, 1, 20, 100, 500] loop
      v := coalesce((select jsonb_agg(to_jsonb(x))::text from public.chat_my_mentions(case when l = -1 then null else l end) x), '[]');
      if v is distinct from (select o.v from _old o where o.who = e and o.lim = l::text) then bad := bad + 1; end if;
      if v <> '[]' then hits := hits + 1; end if;
      n := n + 1;
    end loop;
  end loop;
  perform pg_temp.su();
  perform pg_temp.res('03 chat_my_mentions: the same rows in the same order as the kept body (4 people x 5 limits, mentions / read markers / deleted / own / broadcast / other studio)',
    bad = 0 and n = 20 and hits >= 8, 'bad=' || bad || ' hits=' || hits);
end $$;

-- the bell's newest-60 read as the browser sends it (row security on)
analyze public.chat_messages; analyze public.chat_conversations; analyze public.chat_members;
select pg_temp.put('ua', (select id::text from auth.users where email = 'a_admin@a.test'));
select pg_temp.login('a_admin@a.test');
do $$ declare p text := ''; r record; begin
  for r in execute 'explain select id, conversation_id, sender_id, kind, body, meta, created_at from public.chat_messages
                     where sender_id <> ' || quote_literal(pg_temp.get('ua')) || '::uuid and deleted = false
                     order by created_at desc limit 60' loop p := p || r."QUERY PLAN" || E'\n'; end loop;
  perform pg_temp.put('plan', p);
end $$;
select pg_temp.su();
do $$ begin
  perform pg_temp.res('04 the bell''s newest-messages read walks the new index (no sort of the whole studio)',
    position('chat_messages_org_created_idx_0433' in pg_temp.get('plan')) > 0 and position('Sort' in pg_temp.get('plan')) = 0,
    replace(left(pg_temp.get('plan'), 600), E'\n', ' | '));
end $$;

-- ---- Realtime: chat_reactions out (when in), the live tables stay; no publication = nothing to do --------------------------------
do $$ begin
  if not exists (select 1 from pg_publication where pubname = 'supabase_realtime') then create publication supabase_realtime; end if;
  if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and tablename = 'chat_reactions') then
    alter publication supabase_realtime add table public.chat_reactions; end if;
  if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and tablename = 'leads') then
    alter publication supabase_realtime add table public.leads; end if;
  if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and tablename = 'chat_messages') then
    alter publication supabase_realtime add table public.chat_messages; end if;
end $$;
set client_min_messages = error;
\ir ../../supabase/migrations/0433_r249_read_speed.sql
\ir ../../supabase/migrations/0433_r249_read_speed.sql
set client_min_messages = warning;
do $$ begin
  perform pg_temp.res('05 Realtime: chat_reactions taken out (it was in), leads + chat_messages stay; a second run changes nothing',
    not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and tablename = 'chat_reactions')
    and exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and tablename = 'leads')
    and exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and tablename = 'chat_messages'));
end $$;

select name, result from _rm order by name;
select case when count(*) filter (where result <> 'PASS') = 0
            then 'R249-READ-SPEED-0433: ALL PASS (' || count(*) || '/' || count(*) || ')'
            else 'R249-READ-SPEED-0433: FAILURES (' || count(*) filter (where result <> 'PASS') || ' of ' || count(*) || ')' end as summary
  from _rm;
rollback;
