-- r271-links-0454.sql - R271 Settings > Links going out: the list, turn off / back on / new link. Local disposable PG only. Fake data. Rolled back.
\set ON_ERROR_STOP 0
set client_min_messages = error;
begin;
\o /dev/null
\i supabase/migrations/0454_r271_links.sql
\i supabase/migrations/0454_r271_links.sql
\o
set client_min_messages = warning;
create temp table _rc(name text, result text); grant all on _rc to anon, authenticated, service_role;
create temp table _kv(k text primary key, v text); grant all on _kv to anon, authenticated, service_role;
create or replace function pg_temp.su() returns void language plpgsql as $$ begin execute 'reset role'; perform auth.logout(); execute 'reset role'; end $$;
create or replace function pg_temp.login(p_email text) returns void language plpgsql as $$
declare u uuid; begin
  perform pg_temp.su(); select id into u from auth.users where email = p_email;
  perform set_config('request.jwt.claims', jsonb_build_object('sub', u, 'role', 'authenticated', 'email', p_email, 'aal', 'aal1')::text, false);
  perform set_config('role', 'authenticated', false);
end $$;
create or replace function pg_temp.anon() returns void language plpgsql as $$ begin perform pg_temp.su(); perform set_config('request.jwt.claims', '{"role":"anon"}', false); perform set_config('role', 'anon', false); end $$;
create or replace function pg_temp.res(p_name text, p_ok boolean, p_detail text default '') returns void language plpgsql as $$
begin insert into _rc values (p_name, case when coalesce(p_ok, false) then 'PASS' else 'FAIL: ' || left(coalesce(p_detail, ''), 400) end); end $$;
create or replace function pg_temp.j(p_sql text) returns jsonb language plpgsql as $$
declare v jsonb; begin execute p_sql into v; return coalesce(v, 'null'::jsonb); exception when others then return jsonb_build_object('err', sqlstate || ' ' || sqlerrm); end $$;
create or replace function pg_temp.put(p_k text, p_v text) returns void language sql as $$ insert into _kv values (p_k, p_v) on conflict (k) do update set v = excluded.v $$;
create or replace function pg_temp.get(p_k text) returns text language sql as $$ select v from _kv where k = p_k $$;
create or replace function pg_temp.member(p_email text, p_role text, p_org uuid, p_name text) returns uuid language plpgsql as $$
declare u uuid; begin
  perform pg_temp.su(); select id into u from auth.users where email = p_email; if u is null then u := auth.seed_user(p_email); end if;
  insert into public.profiles(id, email, full_name, role, org_id, must_change_password, created_at) values (u, p_email, p_name, p_role, p_org, false, now())
    on conflict (id) do update set org_id = excluded.org_id, role = excluded.role, full_name = excluded.full_name;
  return u; end $$;
-- as someone: run one call and answer its jsonb (or {err})
create or replace function pg_temp.as_(p_who text, p_sql text) returns jsonb language plpgsql as $$
declare v jsonb; begin if p_who = 'anon' then perform pg_temp.anon(); else perform pg_temp.login(p_who); end if; v := pg_temp.j(p_sql); perform pg_temp.su(); return v; end $$;
-- the public side of every kind: a jsonb answer, or {err}
create or replace function pg_temp.pub(p_kind text) returns jsonb language plpgsql as $$
begin
  return pg_temp.as_('anon', case p_kind
    when 'approval' then 'select public.public_get_quote(''a0000000-0000-4000-8000-0000000000aa''::uuid)'
    when 'booklet'  then 'select public.public_get_booklet(''a0000000-0000-4000-8000-00000000b001''::uuid)'
    when 'proposal' then 'select public.public_get_proposal(''a0000000-0000-4000-8000-00000000c001''::uuid)'
    when 'site'     then format('select to_jsonb(public.public_event_site(%L))', pg_temp.get('slug'))
    when 'crew'     then 'select to_jsonb(x) from public.worker_get_tasks(''a0000000-0000-4000-8000-00000000d001''::uuid) x limit 1'
    when 'staff'    then format('select public.staff_link_view(%L)', repeat('ab', 32))
    when 'vendor'   then format('select public.vendor_link_get(%L)', repeat('cd', 32))
    when 'delivery' then format('select public.delivery_link_get(%L)', repeat('ef', 32))
    when 'team'     then 'select to_jsonb(public.invitation_preview('''||repeat('7a',24)||'''))' end);
end $$;
-- is the public side open? (each kind answers "no" in its own way)
create or replace function pg_temp.open_(p_kind text) returns boolean language plpgsql as $$
declare v jsonb := pg_temp.pub(p_kind); begin
  if v ? 'err' or v = 'null'::jsonb then return false; end if;
  if p_kind in ('vendor', 'delivery') then return coalesce((v ->> 'ok')::boolean, false); end if;
  if p_kind = 'staff' then return coalesce((v ->> 'ok')::boolean, true) and not (v ? 'reason'); end if;
  if p_kind = 'team' then return coalesce((v ->> 'valid')::boolean, false); end if;
  return true;
end $$;
create or replace function pg_temp.row_(p_kind text, p_who text default 'a_admin@a.test') returns jsonb language sql as $$
  select (select e from jsonb_array_elements(pg_temp.as_(p_who, format('select public.studio_links_list(%L)', p_kind)) -> 'rows') e limit 1) $$;
grant execute on all functions in schema pg_temp to anon, authenticated, service_role;

-- ---- fake data: studio A (admin a_admin, sales a_staff), studio B (b_admin) -----------------------------------------------------
create temp table _before as select (select count(*) from public.quotes) q, (select count(*) from public.client_booklets) bk, (select count(*) from public.event_proposal) pr,
  (select count(*) from public.event_sites) si, (select count(*) from public.work_tokens) wt, (select count(*) from public.staff_links) sl,
  (select count(*) from public.vendor_request_links) vl, (select count(*) from public.delivery_links) dl, (select count(*) from public.invitations) iv;
do $$ declare a uuid := 'a0000000-0000-4000-8000-000000000001'; b uuid := 'b0000000-0000-4000-8000-000000000001'; qa uuid := 'a0000000-0000-4000-8000-00000000da01';
  qb uuid := 'b0000000-0000-4000-8000-00000000da01'; adm uuid; cm uuid; vd uuid; vr uuid; dc uuid; begin
  select id into adm from public.profiles where email = 'a_admin@a.test';
  update public.quotes set event_date = current_date + 20, client = '{"name":"Alice Rao"}' where id = qa;
  update public.quotes set event_date = current_date + 20 where id = qb;
  insert into public.client_booklets(org_id, quote_id, token, shared_versions, created_by, expires_at)
    values (a, qa, 'a0000000-0000-4000-8000-00000000b001', '{}', adm, now() + interval '20 days'),
           (b, qb, 'b0000000-0000-4000-8000-00000000b001', '{}', null, now() + interval '20 days');
  insert into public.event_proposal(quote_id, org_id, concept, share_token, published) values (qa, a, 'Garden', 'a0000000-0000-4000-8000-00000000c001', true)
    on conflict (quote_id) do update set share_token = excluded.share_token, published = true;
  perform set_config('request.jwt.claims', jsonb_build_object('sub', adm, 'role', 'authenticated', 'email', 'a_admin@a.test')::text, false);
  insert into public.event_sites(org_id, quote_id, event_type, template, slug, title, status, published_at, data)
    values (a, qa, 'wedding', 'eternal', 'alice-and-dev-r271a0000000000aa', 'Alice and Dev', 'published', now(), '{"names":"Alice and Dev"}');
  perform pg_temp.su();
  perform pg_temp.put('slug', 'alice-and-dev-r271a0000000000aa');
  insert into public.work_tokens(token, quote_id, phone, name, org_id) values ('a0000000-0000-4000-8000-00000000d001', qa, '+919800000001', 'Ravi Crew', a),
    ('b0000000-0000-4000-8000-00000000d001', qb, '+919800000009', 'B Crew', b);
  insert into public.event_tasks(quote_id, category, title, assignee_phone, assignee_name, org_id) values (qa, 'decor', 'Set up stage', '+919800000001', 'Ravi Crew', a);
  insert into public.crew_members(name, phone, active, org_id) values ('Sita Crew', '+919800000002', true, a) returning id into cm;
  insert into public.staff_links(org_id, crew_id, token, created_by) values (a, cm, repeat('ab', 32), adm);
  insert into public.vendors(name, category, org_id) values ('Deccan Rentals', 'Furniture', a) returning id into vd;
  insert into public.vendor_requests(org_id, quote_id, vendor_id, vendor_name, what, when_at, respond_by, status, agreed_amount)
    values (a, qa, vd, 'Deccan Rentals', 'Chairs', now() + interval '10 days', now() + interval '3 days', 'sent', 500) returning id into vr;
  insert into public.vendor_request_links(token_hash, request_id, org_id, issued_via, expires_at)
    values (encode(sha256(convert_to(repeat('cd', 32), 'UTF8')), 'hex'), vr, a, 'copy', now() + interval '5 days');
  insert into public.delivery_commitments(org_id, quote_id, what, party_kind, vendor_id, party_name, due_at)
    values (a, qa, 'Flowers', 'vendor', vd, 'Bloom Co', now() + interval '6 days') returning id into dc;
  insert into public.delivery_links(token_hash, commitment_id, org_id, issued_via, expires_at)
    values (encode(sha256(convert_to(repeat('ef', 32), 'UTF8')), 'hex'), dc, a, 'copy', now() + interval '7 days');
  insert into public.invitations(org_id, email, role, token, status, invited_by, expires_at) values (a, 'new.planner@a.test', 'sales', repeat('7a', 24), 'pending', adm, now() + interval '7 days');
end $$;

do $$ declare v jsonb; k text; kinds text[] := array['approval', 'booklet', 'proposal', 'site', 'crew', 'staff', 'vendor', 'delivery', 'team']; r jsonb; t text; begin
  perform pg_temp.res('01 the file changed nothing stored (run twice)', (select b.q = (select count(*) from public.quotes) and b.bk + 2 = (select count(*) from public.client_booklets) from _before b)
    and (select count(*) = 0 from public.link_offs));
  -- before: every public link opens
  foreach k in array kinds loop perform pg_temp.res('02 before: the ' || k || ' link opens', pg_temp.open_(k), pg_temp.pub(k)::text); end loop;
  -- the list: own studio only, every kind, names only, never a token
  v := pg_temp.as_('a_admin@a.test', 'select public.studio_links_list()'); t := v::text;
  perform pg_temp.res('03 the list shows every kind of link of this studio', (select count(distinct e ->> 'kind') = 9 from jsonb_array_elements(v -> 'rows') e), t);
  perform pg_temp.res('04 nothing of studio B', not exists (select 1 from jsonb_array_elements(v -> 'rows') e where e ->> 'quote_id' = 'b0000000-0000-4000-8000-00000000da01') and t not like '%B Crew%', t);
  perform pg_temp.res('05 no token, hash or slug in the answer', t not like '%0000000000aa%' and t not like '%00000000b001%' and t not like '%00000000c001%' and t not like '%00000000d001%'
    and t not like '%abababab%' and t not like '%cdcdcdcd%' and t not like '%efefefef%' and t not like '%' || repeat('7a', 24) || '%' and t not like '%r271a0000000000aa%'
    and t not like '%' || encode(sha256(convert_to(repeat('cd', 32), 'UTF8')), 'hex') || '%', t);
  perform pg_temp.res('06 names, events and states', t like '%Alice Rao%' and t like '%Ravi Crew%' and t like '%Sita Crew%' and t like '%Deccan Rentals%' and t like '%Bloom Co%'
    and t like '%A-0001%' and (select bool_and(e ->> 'status' = 'live') from jsonb_array_elements(v -> 'rows') e), t);
  v := pg_temp.as_('a_admin@a.test', 'select public.studio_links_list(''crew'')');
  perform pg_temp.res('07 filter by kind', jsonb_array_length(v -> 'rows') = 1 and v #>> '{rows,0,kind}' = 'crew', v::text);
  v := pg_temp.as_('a_admin@a.test', 'select public.studio_links_list(null, ''a0000000-0000-4000-8000-00000000da01''::uuid, 3)');
  perform pg_temp.res('08 filter by event + a page of 3 says there is more', jsonb_array_length(v -> 'rows') = 3 and (v ->> 'more')::boolean
    and not exists (select 1 from jsonb_array_elements(v -> 'rows') e where e ->> 'quote_id' is distinct from 'a0000000-0000-4000-8000-00000000da01'), v::text);
  -- who may not
  v := pg_temp.as_('a_staff@a.test', 'select public.studio_links_list()');
  perform pg_temp.res('09 a non-admin is refused (list)', v ->> 'err' like '42501%', v::text);
  r := pg_temp.row_('crew');
  v := pg_temp.as_('a_staff@a.test', format('select public.studio_link_off(''crew'', %L::uuid)', r ->> 'id'));
  perform pg_temp.res('10 a non-admin is refused (turn off)', v ->> 'err' like '42501%' and pg_temp.open_('crew'), v::text);
  v := pg_temp.as_('anon', 'select public.studio_links_list()');
  perform pg_temp.res('11 signed out is refused', v ->> 'err' like '42501%', v::text);
  v := pg_temp.as_('b_admin@b.test', format('select public.studio_link_off(''crew'', %L::uuid)', r ->> 'id'));
  perform pg_temp.res('12 another studio''s admin cannot turn it off', v ->> 'err' like 'P0002%' and pg_temp.open_('crew'), v::text);
  v := pg_temp.as_('b_admin@b.test', 'select public.studio_link_off(''approval'', ''a0000000-0000-4000-8000-00000000da01''::uuid)');
  perform pg_temp.res('13 another studio''s admin cannot turn off the client page', v ->> 'err' like 'P0002%' and pg_temp.open_('approval'), v::text);
  -- turn off each kind, the public link refuses, the list says Turned off; twice = no change
  foreach k in array kinds loop
    r := pg_temp.row_(k);
    v := pg_temp.as_('a_admin@a.test', format('select public.studio_link_off(%L, %L::uuid)', k, r ->> 'id'));
    perform pg_temp.res('14 turn off ' || k, (v ->> 'changed')::boolean and not pg_temp.open_(k), v::text || ' ' || pg_temp.pub(k)::text);
    v := pg_temp.as_('a_admin@a.test', format('select public.studio_link_off(%L, %L::uuid)', k, r ->> 'id'));
    perform pg_temp.res('15 turn off ' || k || ' again: nothing more changes', v ->> 'changed' = 'false', v::text);
    perform pg_temp.res('16 the list says ' || k || ' is turned off', pg_temp.row_(k) ->> 'status' = 'off', pg_temp.row_(k)::text);
  end loop;
  perform pg_temp.res('17 the off page shows no event details', pg_temp.pub('approval')::text not like '%Wedding A%' and pg_temp.pub('approval')::text like '%expired%', pg_temp.pub('approval')::text);
  perform pg_temp.res('18 every change is in the activity log', (select count(*) = 9 from public.audit_log l where l.action = 'studio_link.off' and l.org_id = 'a0000000-0000-4000-8000-000000000001'));
  perform pg_temp.res('19 no row and no token was removed', (select b.bk + 2 = (select count(*) from public.client_booklets) and b.pr <= (select count(*) from public.event_proposal)
      and b.si + 1 = (select count(*) from public.event_sites) and b.wt + 2 = (select count(*) from public.work_tokens) and b.sl + 1 = (select count(*) from public.staff_links)
      and b.vl + 1 = (select count(*) from public.vendor_request_links) and b.dl + 1 = (select count(*) from public.delivery_links) and b.iv + 1 = (select count(*) from public.invitations) from _before b)
    and exists (select 1 from public.quotes q where q.id = 'a0000000-0000-4000-8000-00000000da01' and q.approval_token = 'a0000000-0000-4000-8000-0000000000aa' and q.approval_status = 'sent')
    and exists (select 1 from public.work_tokens w where w.token = 'a0000000-0000-4000-8000-00000000d001'));
  perform pg_temp.res('20 studio B''s links still open', (select pg_temp.as_('anon', 'select public.public_get_quote(''b0000000-0000-4000-8000-0000000000bb''::uuid)') ? 'code')
    and (select revoked_at is null from public.work_tokens where token = 'b0000000-0000-4000-8000-00000000d001'));
  -- turn back on where a safe way exists
  foreach k in array array['approval', 'proposal', 'site', 'vendor', 'delivery'] loop
    r := pg_temp.row_(k);
    perform pg_temp.res('21 ' || k || ' can be turned back on', (r ->> 'can_on')::boolean, r::text);
    v := pg_temp.as_('a_admin@a.test', format('select public.studio_link_on(%L, %L::uuid)', k, r ->> 'id'));
    perform pg_temp.res('22 back on: the ' || k || ' link opens again', (v ->> 'changed')::boolean and pg_temp.open_(k) and pg_temp.row_(k) ->> 'status' = 'live', v::text || ' ' || pg_temp.pub(k)::text);
  end loop;
  r := pg_temp.row_('crew');
  v := pg_temp.as_('a_admin@a.test', format('select public.studio_link_on(''crew'', %L::uuid)', r ->> 'id'));
  perform pg_temp.res('23 a crew link is not turned back on here (send tasks again)', v ->> 'err' like '22023%' and not (r ->> 'can_on')::boolean and not pg_temp.open_('crew'), v::text);
  perform pg_temp.res('24 the switch rows stay (back on = a date)', (select count(*) = 3 and bool_and(on_at is not null) from public.link_offs));
  -- new link: the invitation gets a new address, nothing returned to copy
  r := pg_temp.row_('site');
  v := pg_temp.as_('a_admin@a.test', format('select public.studio_link_new(''site'', %L::uuid)', r ->> 'id'));
  perform pg_temp.res('25 new invitation link: the old one stops, no link in the answer', (v ->> 'changed')::boolean and not pg_temp.open_('site') and v::text not like '%alice-and-dev%'
    and (select s.slug <> pg_temp.get('slug') from public.event_sites s where s.id = (r ->> 'id')::uuid), v::text);
  -- several at once
  v := pg_temp.as_('a_admin@a.test', format('select public.studio_links_off(%L::jsonb)', jsonb_build_array(jsonb_build_object('kind', 'approval', 'id', 'a0000000-0000-4000-8000-00000000da01'),
       jsonb_build_object('kind', 'vendor', 'id', pg_temp.row_('vendor') ->> 'id'), jsonb_build_object('kind', 'nope', 'id', 'a0000000-0000-4000-8000-00000000da01'))));
  perform pg_temp.res('26 tick several -> turn off (a wrong one does not stop the rest)', (v ->> 'turned_off')::int = 2 and jsonb_array_length(v -> 'failed') = 1
    and not pg_temp.open_('approval') and not pg_temp.open_('vendor'), v::text);
  -- a cancelled event: the list says so, and its links cannot be turned back on here
  update public.quotes set status = 'cancelled' where id = 'a0000000-0000-4000-8000-00000000da01';
  r := pg_temp.row_('approval');
  perform pg_temp.res('27 cancelled event shown as such, no turning back on', r ->> 'status' = 'cancelled' and not (r ->> 'can_on')::boolean, r::text);
  v := pg_temp.as_('a_admin@a.test', 'select public.studio_link_on(''approval'', ''a0000000-0000-4000-8000-00000000da01''::uuid)');
  perform pg_temp.res('28 back on refused while the event is cancelled', v ->> 'err' like '22023%', v::text);
  perform pg_temp.res('29 no link_offs row was ever deleted', (select count(*) = 5 from public.link_offs));
end $$;
select name, result from _rc where result <> 'PASS' order by name;
select 'R271-LINKS-0454: ' || case when count(*) filter (where result <> 'PASS') = 0 then 'ALL PASS' else 'FAIL' end || ' (' || count(*) filter (where result = 'PASS') || '/' || count(*) || ')' from _rc;
rollback;
