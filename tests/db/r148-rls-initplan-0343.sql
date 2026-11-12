-- r148-rls-initplan-0343.sql - R148: RLS speed-up - every per-query helper in a policy (has_area, current_org_id,
-- auth.uid, is_admin, user_role, can_create, can_delete) runs ONCE per query, not once per row (0343).
-- Proves: (1) structure: every policy 0343 changes has the 0343 expression, nothing is left to wrap, unwrapping
-- gives exactly the pre-0343 expression, the helpers have no app privilege; (2) the pre-0343 expressions can be put
-- back (test only) with the same policy names / commands / roles / permissive flags; (3) SAME ROWS: for admin,
-- manager, sales, coordinator, crew, client, a signed-in outsider with no studio, the other studio (sales + admin) and
-- anon, the rows each one sees in every changed table are identical before / after, and so is the outcome (row count
-- or error) of an UPDATE, a DELETE and an INSERT on every changed table; (4) SAME ANSWER PER ROW: every changed USING /
-- WITH CHECK expression gives the same yes / no / null on every row (real + synthetic rows of both studios) for admin,
-- sales, crew, the outsider, the other studio and anon, pre vs 0343; (5) the 0343 file turns a pre-0343 database into the 0343 one, a second run changes
-- nothing, a policy that differs from the canonical one is left alone; (6) speed: EXPLAIN shows an InitPlan and no
-- per-row has_area, and the same 2,000 tasks are counted much faster for a Sales login. Local disposable PG only.
-- Fake data only. Rolled back.
\set ON_ERROR_STOP 0
set client_min_messages = error;
\ir ../../supabase/migrations/0343_r148_rls_initplan.sql
\ir ../../supabase/migrations/0343_r148_rls_initplan.sql
set client_min_messages = warning;
begin;
create temp table _rs(name text, result text); grant all on _rs to anon, authenticated, service_role;
create or replace function pg_temp.t(p_name text, p_ok boolean, p_detail text default '') returns void language plpgsql as $$
begin insert into _rs values (p_name, case when coalesce(p_ok, false) then 'PASS' else 'FAIL: ' || coalesce(p_detail, '') end); end $$;

create temp table _x343(tbl text, rel text, pol text, cmd text, pre_q text, pre_c text, new_q text, new_c text);
\ir r148-rls-initplan-0343-cases.sql

-- md5 of the live USING | WITH CHECK of a policy, deparsed with an empty search_path ('-' = no such clause)
create or replace function pg_temp.cur(p_tbl text, p_pol text) returns text language sql stable set search_path = '' as $$
  select coalesce(public._r343_md5(pg_catalog.pg_get_expr(p.polqual, p.polrelid)), '-') || '|'
      || coalesce(public._r343_md5(pg_catalog.pg_get_expr(p.polwithcheck, p.polrelid)), '-')
    from pg_catalog.pg_policy p where p.polrelid = pg_catalog.to_regclass(p_tbl) and p.polname = p_pol $$;
create or replace function pg_temp.want(p_q text, p_c text) returns text language sql immutable as $$
  select coalesce(public._r343_md5(p_q), '-') || '|' || coalesce(public._r343_md5(p_c), '-') $$;
-- remove every "( SELECT schema.fn(...) AS alias)" wrapper, normalise blanks
create or replace function pg_temp.unwrap(p text) returns text language plpgsql immutable as $$
declare v text := regexp_replace(btrim(p), '\s+', ' ', 'g'); w text;
begin
  if p is null then return null; end if;
  loop
    w := regexp_replace(v, '\( SELECT ((?:public|auth)\.[a-z0-9_]+\((?:[^()]|\([^()]*\))*\)) AS [a-z0-9_]+\)', '\1', 'g');
    exit when w = v; v := w;
  end loop;
  return v;
end $$;
-- every policy with its command / roles / permissive flag (names and table included), for "nothing else changed"
create or replace function pg_temp.shape() returns text language sql stable as $$
  select md5(string_agg(p.polrelid::regclass::text || '/' || p.polname || '/' || p.polcmd::text || '/' || p.polpermissive::text || '/' || p.polroles::text, ','
                        order by p.polrelid::regclass::text, p.polname)) || ':' || count(*) from pg_policy p $$;
-- the whole policy catalog including expressions
create or replace function pg_temp.full_cat() returns text language sql stable set search_path = '' as $$
  select pg_catalog.md5(pg_catalog.string_agg(p.polrelid::regclass::text || '/' || p.polname || '/' || p.polcmd::text || '/' || p.polpermissive::text || '/'
           || p.polroles::text || '/' || coalesce(pg_catalog.pg_get_expr(p.polqual, p.polrelid), '-') || '/' || coalesce(pg_catalog.pg_get_expr(p.polwithcheck, p.polrelid), '-'), ','
           order by p.polrelid::regclass::text, p.polname)) from pg_catalog.pg_policy p $$;
-- put the canonical pre-0343 expressions back (TEST ONLY, inside this rolled-back transaction)
create or replace function pg_temp.put_pre() returns int language plpgsql set search_path = '' as $$
declare r record; n int := 0; v text;
begin
  for r in select * from pg_temp._x343 loop
    v := pg_catalog.format('alter policy %I on %s', r.pol, r.tbl);
    if r.new_q is distinct from r.pre_q then v := v || ' using (' || r.pre_q || ')'; end if;
    if r.new_c is distinct from r.pre_c then v := v || ' with check (' || r.pre_c || ')'; end if;
    execute v; n := n + 1;
  end loop;
  return n;
end $$;

-- ---- 1) structure -----------------------------------------------------------------------------------------------
create temp table _shape_post as select pg_temp.shape() s;
select pg_temp.t('1a every policy 0343 changes has the 0343 expression (' || (select count(*) from _x343) || ' policies)',
  (select count(*) from _x343) > 250
  and not exists (select 1 from _x343 x where pg_temp.cur(x.tbl, x.pol) is distinct from pg_temp.want(x.new_q, x.new_c)),
  (select string_agg(pol || ' on ' || tbl, ', ') from _x343 x where pg_temp.cur(x.tbl, x.pol) is distinct from pg_temp.want(x.new_q, x.new_c)));
select pg_temp.t('1b no policy calls a per-query helper with constant arguments directly any more',
  not exists (select 1 from public._r343_unwrapped()), (select string_agg(pol || ' on ' || tbl || ': ' || call, '; ') from public._r343_unwrapped()));
select pg_temp.t('1c same logic: removing the (SELECT ...) wrappers gives exactly the pre-0343 expression, every policy, both clauses',
  not exists (select 1 from _x343 where pg_temp.unwrap(new_q) is distinct from pg_temp.unwrap(pre_q) or pg_temp.unwrap(new_c) is distinct from pg_temp.unwrap(pre_c))
  and not exists (select 1 from _x343 where new_q is not distinct from pre_q and new_c is not distinct from pre_c),
  (select string_agg(pol || ' on ' || tbl, ', ') from _x343 where pg_temp.unwrap(new_q) is distinct from pg_temp.unwrap(pre_q) or pg_temp.unwrap(new_c) is distinct from pg_temp.unwrap(pre_c)));
select pg_temp.t('1d every has_area call with constant arguments is wrapped (none left bare, 300+ wrapped)',
  (select count(*) from pg_policies, regexp_matches(coalesce(qual, '') || ' ' || coalesce(with_check, ''), 'SELECT (public\.)?has_area\(', 'g')) >= 300
  and not exists (select 1 from public._r343_unwrapped() where call like 'public.has_area(%'));
select pg_temp.t('1e the 0343 helpers have no app privilege',
  not has_function_privilege('authenticated', 'public._r343_wrap(text,text,text,text,text,text,text,text)', 'execute')
  and not has_function_privilege('anon', 'public._r343_wrap(text,text,text,text,text,text,text,text)', 'execute')
  and not has_function_privilege('authenticated', 'public._r343_unwrapped()', 'execute')
  and not has_function_privilege('anon', 'public._r343_md5(text)', 'execute'));
select pg_temp.t('1f a column-reading call is left alone (chat_can_see(conversation_id) still per row)',
  exists (select 1 from pg_policies where coalesce(qual, '') || coalesce(with_check, '') ~ 'chat_can_see\(conversation_id\)')
  and not exists (select 1 from pg_policies where coalesce(qual, '') || coalesce(with_check, '') ~ 'SELECT (public\.)?chat_can_see\('));

-- ---- 2) people + data (both studios) ----------------------------------------------------------------------------
create temp table _who(who text primary key, uid uuid, anon boolean default false, org uuid, claims text);
do $$
declare a uuid := 'a0000000-0000-4000-8000-000000000001'; b uuid := 'b0000000-0000-4000-8000-000000000001'; r record; v uuid;
begin
  for r in select * from (values ('manager', 'r148_mgr@a.test', 'manager', a), ('coordinator', 'r148_coord@a.test', 'coordinator', a),
                                 ('crew', 'r148_crew@a.test', 'crew', a), ('client', 'r148_client@a.test', 'client', a),
                                 ('outsider', 'r148_out@x.test', null, null)) x(who, email, role, org) loop
    select id into v from auth.users where email = r.email;
    if v is null then v := auth.seed_user(r.email); end if;
    if r.role is not null then
      insert into public.profiles(id, email, role, org_id, must_change_password, created_at) values (v, r.email, r.role, r.org, false, now())
        on conflict (id) do update set role = excluded.role, org_id = excluded.org_id, must_change_password = false;
    end if;
    insert into _who(who, uid, org) values (r.who, v, r.org);
  end loop;
  insert into _who(who, uid, org) select 'admin', id, a from auth.users where email = 'a_admin@a.test';
  insert into _who(who, uid, org) select 'sales', id, a from auth.users where email = 'a_staff@a.test';
  insert into _who(who, uid, org) select 'other studio sales', id, b from auth.users where email = 'b_staff@b.test';
  insert into _who(who, uid, org) select 'other studio admin', id, b from auth.users where email = 'b_admin@b.test';
  insert into _who(who, uid, anon) values ('anon', null, true);
  update _who w set claims = case when w.anon then '{"role":"anon"}' else
    json_build_object('sub', w.uid::text, 'role', 'authenticated', 'email', (select email from auth.users u where u.id = w.uid))::text end;
  -- a mixed access matrix for every area the policies name (view / edit differ per role), both studios
  insert into public.role_access(role, area, can_view, can_edit, org_id, updated_at)
  select rr.rl, aa.ar, (abs(hashtext(rr.rl || ':' || aa.ar)) % 3) <> 0, (abs(hashtext(rr.rl || ':' || aa.ar)) % 3) <> 0 and (abs(hashtext(aa.ar || ':' || rr.rl)) % 2) = 0, oo.o, now()
    from (values ('manager'), ('sales'), ('coordinator'), ('crew'), ('client')) rr(rl),
         (select distinct (regexp_matches(coalesce(pre_q, '') || coalesce(pre_c, ''), 'has_area\(''([a-z_]+)''', 'g'))[1] from _x343) aa(ar),
         (values (a), (b)) oo(o)
  on conflict (role, area, org_id) do update set can_view = excluded.can_view, can_edit = excluded.can_edit;
  update public.role_access set can_view = true where org_id = a and role in ('sales', 'manager') and area in ('staff', 'quotes', 'leads', 'inventory');
end $$;
grant select on _who to anon, authenticated;

-- a generic row for a table: every NOT NULL column without a default gets a typed placeholder
create or replace function pg_temp.ins_sql(p_tbl text, p_org uuid, p_quote uuid, p_user uuid) returns text language plpgsql stable as $$
declare c record; cols text := ''; vals text := ''; v text;
begin
  for c in select a.attname, format_type(a.atttypid, a.atttypmod) typ, t.typcategory cat, a.attnotnull nn, a.atthasdef def
             from pg_attribute a join pg_type t on t.oid = a.atttypid
            where a.attrelid = to_regclass(p_tbl) and a.attnum > 0 and not a.attisdropped and a.attgenerated = '' and a.attidentity = ''
            order by a.attnum loop
    v := case
      when c.attname = 'org_id' then quote_literal(p_org) || '::uuid'
      when c.attname = 'quote_id' and p_quote is not null then quote_literal(p_quote) || '::uuid'
      when c.attname ~ '^(user_id|sender_id|owner|owner_id|created_by|uploaded_by|member_id|requested_by|author_id)$' and c.typ = 'uuid' then quote_literal(p_user) || '::uuid'
      when not c.nn or c.def then null
      when c.typ = 'uuid' then 'gen_random_uuid()'
      when c.cat = 'S' then '''r148'''
      when c.cat = 'N' then '1'
      when c.typ = 'boolean' then 'false'
      when c.typ in ('jsonb', 'json') then '''{}''::' || c.typ
      when c.cat = 'D' then 'now()'
      when c.cat = 'A' then '''{}''::' || c.typ
      else null end;
    if v is not null then cols := cols || ', ' || quote_ident(c.attname); vals := vals || ', ' || v || '::' || c.typ; end if;
  end loop;
  if cols = '' then return format('insert into %s default values', p_tbl); end if;
  return format('insert into %s (%s) values (%s)', p_tbl, substr(cols, 3), substr(vals, 3));
end $$;
-- seed: key tables explicitly, storage objects per bucket the policies name, then one best-effort generic row per
-- changed table and studio (a row that a trigger / check refuses is simply not added)
do $$
declare a uuid := 'a0000000-0000-4000-8000-000000000001'; b uuid := 'b0000000-0000-4000-8000-000000000001';
        qa uuid := 'a0000000-0000-4000-8000-00000000da01'; qb uuid := 'b0000000-0000-4000-8000-00000000da01';
        ua uuid := (select uid from _who where who = 'sales'); ub uuid := (select uid from _who where who = 'other studio sales');
        r record; o record;
begin
  insert into public.leads(name, org_id) values ('R148 lead A1', a), ('R148 lead A2', a), ('R148 lead B1', b);
  insert into public.inventory_items(name, org_id) values ('R148 chair A', a), ('R148 chair B', b);
  insert into public.event_tasks(quote_id, category, title, org_id) values (qa, 'setup', 'R148 task A1', a), (qa, 'decor', 'R148 task A2', a), (qb, 'setup', 'R148 task B1', b);
  insert into public.quotes(code, title, org_id) values ('R148-A2', 'R148 second A', a), ('R148-B2', 'R148 second B', b);
  for r in select distinct (regexp_matches(coalesce(pre_q, '') || coalesce(pre_c, ''), 'bucket_id = ''([a-z0-9_-]+)''', 'g'))[1] bkt from _x343 where tbl = 'storage.objects' loop
    insert into storage.buckets(id, name) values (r.bkt, r.bkt) on conflict do nothing;
    for o in select * from (values (a, ua), (b, ub)) v(org, usr) loop
      begin insert into storage.objects(bucket_id, name, owner) values (r.bkt, o.org::text || '/r148.png', o.usr);
      exception when others then null; end;
    end loop;
  end loop;
  for r in select distinct tbl from _x343 where tbl <> 'storage.objects' loop
    for o in select * from (values (a, qa, ua), (b, qb, ub)) v(org, q, usr) loop
      begin execute pg_temp.ins_sql(r.tbl, o.org, o.q, o.usr); exception when others then null; end;
    end loop;
  end loop;
end $$;

-- ---- 3) what each person sees / may change - the 0343 rules -------------------------------------------------------
-- rows visible to a person (real RLS path): count + hash of the whole rows; a column-limited table falls back to a count
create or replace function pg_temp.vis(p_who text, p_tbl text, p_rel text) returns text language plpgsql as $$
declare w record; v text;
begin
  select * into w from _who where who = p_who;
  begin
    if w.anon then perform auth.login_anon(); else perform auth.login_as(w.uid); end if;
    begin
      execute format('select count(*) || '':'' || coalesce(md5(string_agg(md5(%1$I::text), '','' order by md5(%1$I::text))), '''') from %2$s as %1$I', p_rel, p_tbl) into v;
    exception when insufficient_privilege then
      begin execute format('select ''count:'' || count(*) from %s', p_tbl) into v; exception when others then v := 'E' || sqlstate; end;
    when others then v := 'E' || sqlstate;
    end;
    raise exception using errcode = 'R1480', message = 'undo';
  exception when sqlstate 'R1480' then null;
  end;
  return v;
end $$;
-- outcome of a write as a person: ok:<rows> or the error code; always undone
create or replace function pg_temp.wr(p_who text, p_sql text) returns text language plpgsql as $$
declare w record; v text; n bigint;
begin
  select * into w from _who where who = p_who;
  begin
    if w.anon then perform auth.login_anon(); else perform auth.login_as(w.uid); end if;
    begin execute p_sql; get diagnostics n = row_count; v := 'ok:' || n;
    exception when others then v := 'E' || sqlstate;
    end;
    raise exception using errcode = 'R1480', message = 'undo';
  exception when sqlstate 'R1480' then null;
  end;
  return v;
end $$;
create temp table _ops(tbl text, op text, sql text);
insert into _ops
select t.tbl, 'update', format('update %s as %I set %I = %I.%I', t.tbl, t.rel, c.col, t.rel, c.col)
  from (select distinct tbl, rel from _x343) t
  cross join lateral (select a.attname col from pg_attribute a where a.attrelid = to_regclass(t.tbl) and a.attnum > 0 and not a.attisdropped
                        and a.attgenerated = '' and a.attidentity = '' and a.attname not in ('id', 'org_id')
                      order by (a.attname = 'updated_at') desc, a.attnum limit 1) c
union all select distinct tbl, 'delete', format('delete from %s', tbl) from _x343
union all select distinct tbl, 'insert', null from _x343;
create temp table _obs(state text, kind text, who text, tbl text, op text, res text);
create index on _obs(kind, who, tbl, op, state);
create or replace function pg_temp.observe(p_state text) returns int language plpgsql as $$
declare w record; t record; n int := 0;
begin
  for w in select who, org, uid from _who order by who loop
    for t in select distinct tbl, rel from _x343 order by tbl loop
      insert into _obs values (p_state, 'see', w.who, t.tbl, null, pg_temp.vis(w.who, t.tbl, t.rel)); n := n + 1;
    end loop;
    for t in select * from _ops order by tbl, op loop
      insert into _obs values (p_state, 'write', w.who, t.tbl, t.op, pg_temp.wr(w.who,
        coalesce(t.sql, pg_temp.ins_sql(t.tbl, coalesce(w.org, 'a0000000-0000-4000-8000-000000000001'::uuid),
                 case when w.org = 'b0000000-0000-4000-8000-000000000001' then 'b0000000-0000-4000-8000-00000000da01'::uuid else 'a0000000-0000-4000-8000-00000000da01'::uuid end, w.uid))));
      n := n + 1;
    end loop;
  end loop;
  return n;
end $$;
select pg_temp.observe('post');

-- ---- 4) the pre-0343 rules (test only), same shape ---------------------------------------------------------------
create temp table _cat_post as select pg_temp.full_cat() h;
select pg_temp.put_pre();
select pg_temp.t('2a the pre-0343 expressions go back on every changed policy (test only)',
  not exists (select 1 from _x343 x where pg_temp.cur(x.tbl, x.pol) is distinct from pg_temp.want(x.pre_q, x.pre_c)));
select pg_temp.t('2b 0343 changed only expressions: same policy names, tables, commands, roles, permissive flags, count',
  pg_temp.shape() = (select s from _shape_post), pg_temp.shape() || ' vs ' || (select s from _shape_post));
select pg_temp.t('2c before 0343 the helpers ran per row (the detector finds the bare calls)',
  (select count(*) from public._r343_unwrapped()) >= (select count(*) from _x343));
select pg_temp.observe('pre');

-- ---- 5) same rows, same write outcomes ----------------------------------------------------------------------------
select pg_temp.t('3a every person sees exactly the same rows in every changed table, pre vs 0343 (' ||
    (select count(*) from _obs where state = 'post' and kind = 'see') || ' person x table checks, ' ||
    (select count(*) from _obs where state = 'post' and kind = 'see' and res ~ '^[1-9]') || ' with rows)',
  (select count(*) from _obs where state = 'post' and kind = 'see') = (select count(*) from _obs where state = 'pre' and kind = 'see')
  and (select count(*) from _obs where state = 'post' and kind = 'see' and res ~ '^[1-9]') >= 150
  and not exists (select 1 from _obs a join _obs b on b.state = 'pre' and b.kind = a.kind and b.who = a.who and b.tbl = a.tbl
                   where a.state = 'post' and a.kind = 'see' and a.res is distinct from b.res),
  (select string_agg(a.who || '/' || a.tbl || ' ' || a.res || ' vs ' || b.res, '; ') from _obs a join _obs b on b.state = 'pre' and b.kind = a.kind and b.who = a.who and b.tbl = a.tbl
    where a.state = 'post' and a.kind = 'see' and a.res is distinct from b.res));
select pg_temp.t('3b every person sees the same in the key tables (quotes, leads, event_tasks, inventory_items), and the studios stay apart',
  not exists (select 1 from _obs a join _obs b on b.state = 'pre' and b.kind = 'see' and b.who = a.who and b.tbl = a.tbl
               where a.state = 'post' and a.kind = 'see' and a.tbl in ('public.quotes', 'public.leads', 'public.event_tasks', 'public.inventory_items') and a.res is distinct from b.res)
  and (select res from _obs where state = 'post' and kind = 'see' and who = 'sales' and tbl = 'public.event_tasks') ~ '^[1-9]'
  and (select res from _obs where state = 'post' and kind = 'see' and who = 'admin' and tbl = 'public.leads') ~ '^[1-9]'
  and (select res from _obs where state = 'post' and kind = 'see' and who = 'outsider' and tbl = 'public.quotes') ~ '^0:'
  and (select res from _obs where state = 'post' and kind = 'see' and who = 'anon' and tbl = 'public.quotes') !~ '^[1-9]'
  and (select res from _obs where state = 'post' and kind = 'see' and who = 'admin' and tbl = 'public.quotes')
      is distinct from (select res from _obs where state = 'post' and kind = 'see' and who = 'other studio admin' and tbl = 'public.quotes'));
select pg_temp.t('3c every UPDATE / DELETE / INSERT on every changed table has the same outcome for every person, pre vs 0343 (' ||
    (select count(*) from _obs where state = 'post' and kind = 'write') || ' checks, ' ||
    (select count(*) from _obs where state = 'post' and kind = 'write' and res ~ '^ok:[1-9]') || ' changed rows)',
  (select count(*) from _obs where state = 'post' and kind = 'write') = (select count(*) from _obs where state = 'pre' and kind = 'write')
  and (select count(*) from _obs where state = 'post' and kind = 'write' and res ~ '^ok:[1-9]') >= 100
  and not exists (select 1 from _obs a join _obs b on b.state = 'pre' and b.kind = a.kind and b.who = a.who and b.tbl = a.tbl and b.op = a.op
                   where a.state = 'post' and a.kind = 'write' and a.res is distinct from b.res),
  (select string_agg(a.who || '/' || a.tbl || '/' || a.op || ' ' || a.res || ' vs ' || b.res, '; ') from _obs a join _obs b on b.state = 'pre' and b.kind = a.kind and b.who = a.who and b.tbl = a.tbl and b.op = a.op
    where a.state = 'post' and a.kind = 'write' and a.res is distinct from b.res));

-- ---- 6) same answer on every row: each changed expression, pre vs 0343, every person -------------------------------
-- a private copy of each changed table (3 real rows of any studio) + synthetic rows for both studios: the user columns
-- set to nobody / sales / crew, and one row per "<column> = '<literal>'" the table's policies test (the per-row helper
-- calls cost ~5 ms each before 0343, so the copies are kept small; section 3 covers the real rows)
create temp table _rows(tbl text, rel text, copy text);
do $$
declare t record; i int := 0; cp text; j jsonb; usr uuid; org uuid; lit record; nm text; ucols text[];
begin
  for t in select distinct tbl, rel from _x343 order by tbl loop
    i := i + 1; cp := 'pg_temp._r343_rows_' || i;
    execute format('create temp table _r343_rows_%s as select * from %s limit 3', i, t.tbl);
    select coalesce(array_agg(a.attname::text), '{}') into ucols from pg_attribute a where a.attrelid = to_regclass(t.tbl) and a.attnum > 0 and not a.attisdropped
       and a.atttypid = 'uuid'::regtype and a.attname ~ '^(user_id|sender_id|owner|owner_id|created_by|uploaded_by|member_id|requested_by|author_id|assigned_to|claimed_by|actor)$';
    for org in select unnest(array['a0000000-0000-4000-8000-000000000001', 'b0000000-0000-4000-8000-000000000001']::uuid[]) loop
      for usr in select unnest(case when cardinality(ucols) = 0 then array[null]::uuid[]
                                    else array[null, (select uid from _who where who = 'sales'), (select uid from _who where who = 'crew')]::uuid[] end) loop
        j := jsonb_build_object('org_id', org);
        if exists (select 1 from pg_attribute a where a.attrelid = to_regclass(t.tbl) and a.attname = 'id' and a.atttypid = 'uuid'::regtype) then
          j := j || jsonb_build_object('id', gen_random_uuid()); end if;
        foreach nm in array ucols loop j := j || jsonb_build_object(nm, usr); end loop;
        if t.tbl = 'storage.objects' then j := j || jsonb_build_object('name', org::text || '/r148.png'); end if;
        begin execute format('insert into %s select * from jsonb_populate_record(null::%s, $1)', cp, t.tbl) using j; exception when others then null; end;
        continue when usr is not null;
        for lit in select distinct m[1] col, m[2] val from _x343 x, regexp_matches(coalesce(x.pre_q, '') || ' ' || coalesce(x.pre_c, ''), '\m([a-z_]+) = ''([^'']*)''::text', 'g') m
                    where x.tbl = t.tbl and exists (select 1 from pg_attribute a where a.attrelid = to_regclass(t.tbl) and a.attname = m[1] and not a.attisdropped) loop
          begin execute format('insert into %s select * from jsonb_populate_record(null::%s, $1)', cp, t.tbl) using j || jsonb_build_object(lit.col, lit.val);
          exception when others then null; end;
        end loop;
      end loop;
    end loop;
    insert into _rows values (t.tbl, t.rel, cp);
  end loop;
end $$;
-- one query per policy and person: the four expressions side by side on every row ('n' = null, '-' = no such clause)
create or replace function pg_temp.ev(p_copy text, p_rel text, p_pq text, p_pc text, p_nq text, p_nc text, p_claims text) returns text[] language plpgsql as $$
declare v text[];
begin
  perform set_config('request.jwt.claims', p_claims, true);
  begin
    execute format('select array[string_agg(%s, '''' order by %I.ctid), string_agg(%s, '''' order by %I.ctid)] from %s as %I',
      case when p_pq is null then '''-''' else format('coalesce((%s)::text, ''n'')', p_pq) end || ' || ''|'' || ' ||
      case when p_pc is null then '''-''' else format('coalesce((%s)::text, ''n'')', p_pc) end, p_rel,
      case when p_nq is null then '''-''' else format('coalesce((%s)::text, ''n'')', p_nq) end || ' || ''|'' || ' ||
      case when p_nc is null then '''-''' else format('coalesce((%s)::text, ''n'')', p_nc) end, p_rel, p_copy, p_rel) into v;
  exception when others then v := array['E' || sqlstate, 'E' || sqlstate];
  end;
  perform set_config('request.jwt.claims', '', true);
  return v;
end $$;
create temp table _ev(pol text, tbl text, who text, pre text, post text);
do $$
declare x record; w record; c text; v text[];
begin
  for x in select * from _x343 loop
    select copy into c from _rows where tbl = x.tbl;
    for w in select * from _who where who in ('admin', 'sales', 'crew', 'outsider', 'other studio sales', 'anon') loop
      v := pg_temp.ev(c, x.rel, x.pre_q, x.pre_c, x.new_q, x.new_c, w.claims);
      insert into _ev values (x.pol, x.tbl, w.who, v[1], v[2]);
    end loop;
  end loop;
end $$;
select pg_temp.t('4a every changed USING / WITH CHECK gives the same yes / no / null on every row for 6 kinds of people, pre vs 0343 (' ||
    (select count(*) from _ev) || ' policy x person checks, ' || (select count(*) from _ev where post ~ 't') || ' with a yes)',
  (select count(*) from _ev) = (select count(*) from _x343) * 6
  and not exists (select 1 from _ev where pre is distinct from post)
  and not exists (select 1 from _ev where post ~ 'E') and (select count(*) from _ev where post ~ 't') >= 300
  and (select count(*) from _ev where post ~ 'f') >= 300,
  (select string_agg(pol || ' on ' || tbl || ' as ' || who, '; ') from (select * from _ev where pre is distinct from post or post ~ 'E' limit 10) z));

-- ---- 7) the file itself: pre -> 0343, re-run = no change, drift left alone ---------------------------------------
-- speed, same 2,000 tasks for a Sales login (pre rules first)
create or replace function pg_temp.count_ms(p_who text, p_sql text) returns numeric[] language plpgsql as $$
declare w record; t0 timestamptz; best numeric := 1e9; n bigint; i int;
begin
  select * into w from _who where who = p_who;
  perform auth.login_as(w.uid);
  for i in 1..2 loop t0 := clock_timestamp(); execute p_sql into n; best := least(best, extract(epoch from clock_timestamp() - t0) * 1000); end loop;
  perform auth.logout(); execute 'reset role';
  return array[n, best];
end $$;
set local session_replication_role = replica;   -- test only: add the 2,000 tasks without running the task triggers
insert into public.event_tasks(quote_id, category, title, org_id)
  select 'a0000000-0000-4000-8000-00000000da01', 'setup', 'R148 speed ' || g, 'a0000000-0000-4000-8000-000000000001' from generate_series(1, 2000) g;
set local session_replication_role = origin;
create temp table _speed as select pg_temp.count_ms('sales', 'select count(*) from public.event_tasks') pre;
grant all on _speed to authenticated;
set client_min_messages = error;
\ir ../../supabase/migrations/0343_r148_rls_initplan.sql
set client_min_messages = warning;
select pg_temp.t('5a the 0343 file turns the pre-0343 rules into the 0343 ones (every changed policy) and leaves nothing bare',
  not exists (select 1 from _x343 x where pg_temp.cur(x.tbl, x.pol) is distinct from pg_temp.want(x.new_q, x.new_c))
  and not exists (select 1 from public._r343_unwrapped()) and pg_temp.full_cat() = (select h from _cat_post));
alter table _speed add column post numeric[];
update _speed set post = pg_temp.count_ms('sales', 'select count(*) from public.event_tasks');
create temp table _plan(line text); grant all on _plan to authenticated;
do $$ declare r record; begin
  perform auth.login_as((select uid from _who where who = 'sales'));
  for r in execute 'explain (costs off) select * from public.event_tasks' loop insert into _plan values (r."QUERY PLAN"); end loop;
  perform auth.logout(); execute 'reset role';
end $$;
select pg_temp.t('6a EXPLAIN as Sales: has_area / current_org_id are InitPlans, no per-row has_area in the filter',
  exists (select 1 from _plan where line ~ 'InitPlan') and exists (select 1 from _plan where line ~ 'Filter:.*InitPlan')
  and not exists (select 1 from _plan where line ~ 'Filter:.*has_area\('), (select string_agg(line, ' / ') from _plan));
select pg_temp.t('6b same 2,000+ tasks counted for Sales, much faster with 0343 (pre ' || round((select pre[2] from _speed), 1) || ' ms, 0343 '
    || round((select post[2] from _speed), 1) || ' ms)',
  (select pre[1] = post[1] and pre[1] >= 2000 and post[2] * 5 < pre[2] from _speed));
create temp table _cat_once as select pg_temp.full_cat() h;
set client_min_messages = error;
\ir ../../supabase/migrations/0343_r148_rls_initplan.sql
set client_min_messages = warning;
select pg_temp.t('5b a second run changes nothing (whole policy catalog identical)', pg_temp.full_cat() = (select h from _cat_once));
-- drift: "ra view" on quotes differs from the canonical rule, the others are pre-0343 -> only quotes is left alone
select pg_temp.put_pre() > 0;
alter policy "ra view" on public.quotes using ((public.has_area('quotes'::text, 'view'::text) AND (org_id = public.current_org_id()) AND true));
create temp table _drift as select pg_temp.cur('public.quotes', 'ra view') q;
set client_min_messages = error;
\ir ../../supabase/migrations/0343_r148_rls_initplan.sql
set client_min_messages = warning;
select pg_temp.t('5c a policy that differs from the canonical one is left exactly as it is; every other one is changed',
  pg_temp.cur('public.quotes', 'ra view') = (select q from _drift)
  and (select count(*) from _x343 x where pg_temp.cur(x.tbl, x.pol) is distinct from pg_temp.want(x.new_q, x.new_c)) = 1
  and pg_temp.cur('public.leads', 'ra view') = (select pg_temp.want(new_q, new_c) from _x343 where tbl = 'public.leads' and pol = 'ra view'));
select pg_temp.t('5d the helper reports instead of failing: differs / done / missing',
  public._r343_wrap('public.quotes', 'ra view', 'x', null, 'y', null, 'true', null) = 'differs'
  and public._r343_wrap('public.leads', 'ra view', 'x', null, (select public._r343_md5(new_q) from _x343 where tbl = 'public.leads' and pol = 'ra view'), null, 'true', null) = 'done'
  and public._r343_wrap('public.no_such_table', 'p', null, null, null, null, null, null) = 'missing'
  and public._r343_wrap('public.leads', 'no such policy', null, null, null, null, null, null) = 'missing');
-- a helper that is VOLATILE on the target database is never wrapped (the policy is left as it is)
create or replace function pg_temp.call_wrap(p_tbl text, p_pol text) returns text language sql as $$
  select public._r343_wrap(x.tbl, x.pol, public._r343_md5(x.pre_q), public._r343_md5(x.pre_c), public._r343_md5(x.new_q), public._r343_md5(x.new_c),
           case when x.new_q is distinct from x.pre_q then x.new_q end, case when x.new_c is distinct from x.pre_c then x.new_c end)
    from _x343 x where x.tbl = p_tbl and x.pol = p_pol $$;
do $$ begin execute format('alter policy "audit read" on public.audit_log using (%s)', (select pre_q from _x343 where tbl = 'public.audit_log' and pol = 'audit read')); end $$;
alter function public.is_admin() volatile;
create temp table _vol as select pg_temp.call_wrap('public.audit_log', 'audit read') r, pg_temp.cur('public.audit_log', 'audit read') c;
alter function public.is_admin() stable;
alter table _vol add column r2 text;
update _vol set r2 = pg_temp.call_wrap('public.audit_log', 'audit read');
select pg_temp.t('5f a helper that is VOLATILE on the database is not wrapped (policy left as it is); once STABLE it is',
  (select r from _vol) = 'differs' and (select c from _vol) = (select pg_temp.want(pre_q, pre_c) from _x343 where tbl = 'public.audit_log' and pol = 'audit read')
  and (select r2 from _vol) = 'altered'
  and pg_temp.cur('public.audit_log', 'audit read') = (select pg_temp.want(new_q, new_c) from _x343 where tbl = 'public.audit_log' and pol = 'audit read')
  and (select provolatile from pg_proc where oid = 'public.is_admin()'::regprocedure) = 's');
-- back to the canonical pre-0343 rule for quotes, then the file finishes the job
do $$ begin execute format('alter policy "ra view" on public.quotes using (%s)', (select pre_q from _x343 where tbl = 'public.quotes' and pol = 'ra view')); end $$;
set client_min_messages = error;
\ir ../../supabase/migrations/0343_r148_rls_initplan.sql
set client_min_messages = warning;
select pg_temp.t('5e back to the installed 0343 rules after the test steps (whole policy catalog identical)', pg_temp.full_cat() = (select h from _cat_post));

do $$ declare n int; f int; r record; begin
  select count(*), count(*) filter (where result <> 'PASS') into n, f from _rs;
  for r in select * from _rs where result <> 'PASS' loop raise warning '% -> %', r.name, left(r.result, 1500); end loop;
  if f = 0 then raise warning 'R148-RLS-INITPLAN-0343: ALL PASS (%/%)', n, n;
  else raise warning 'R148-RLS-INITPLAN-0343: % FAILED of %', f, n; end if;
end $$;
rollback;
