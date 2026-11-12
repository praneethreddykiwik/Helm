-- r154e-suggestion-box-0351.sql -- 0351: the Suggestion box v2. Any signed-in person (admin / sales / crew) sends an idea,
-- sees their own list with status + the Helm reply, can share it with their studio, people of the SAME studio see shared
-- ones (text, status, reply, +1 count, never who) and add a +1; another studio sees nothing; anon is refused; 20 a day per
-- person; HQ lists all (e-mail masked), marks New / Planned / Done / Not now and replies (audited); studio admins cannot.
-- Re-applies itself, nothing changes. Rolled back. Local disposable PG only. Fake data only. Nothing is ever sent.
\set ON_ERROR_STOP 0
set client_min_messages = warning;
begin;
create temp table _tp(name text, result text); grant all on _tp to anon, authenticated, service_role;

create or replace function pg_temp.su() returns void language plpgsql as $$
begin execute 'reset role'; perform auth.logout(); execute 'reset role'; perform set_config('request.headers', '', false); end $$;
create or replace function pg_temp.login(p_email text) returns void language plpgsql as $$
declare u uuid; begin
  perform pg_temp.su(); select id into u from auth.users where email = p_email;
  perform set_config('request.jwt.claims', jsonb_build_object('sub', u, 'role', 'authenticated', 'email', p_email, 'aal', 'aal1')::text, false);
  perform set_config('role', 'authenticated', false);
end $$;
create or replace function pg_temp.op() returns void language plpgsql as $$
declare u uuid; begin
  perform pg_temp.su(); select id into u from auth.users where email = 'admin@helm.events';
  perform set_config('request.jwt.claims', jsonb_build_object('sub', u, 'role', 'authenticated', 'email', 'admin@helm.events', 'aal', 'aal2')::text, false);
  perform set_config('role', 'authenticated', false);
end $$;
create or replace function pg_temp.anon(p_ip text default '203.0.113.70') returns void language plpgsql as $$
begin perform pg_temp.su(); perform set_config('request.jwt.claims', '{"role":"anon"}', false);
  if p_ip is not null then perform set_config('request.headers', jsonb_build_object('x-forwarded-for', p_ip, 'user-agent', 'TestUA/1')::text, false); end if;
  perform set_config('role', 'anon', false); end $$;
create or replace function pg_temp.res(p_name text, p_ok boolean, p_detail text default '') returns void language plpgsql as $$
begin insert into _tp values (p_name, case when coalesce(p_ok, false) then 'PASS' else 'FAIL: '||coalesce(p_detail,'') end); end $$;
grant execute on function pg_temp.res(text, boolean, text) to anon, authenticated, service_role;
create or replace function pg_temp.try(p_sql text) returns text language plpgsql as $$
begin execute p_sql; return ''; exception when others then return sqlstate || ' ' || sqlerrm; end $$;
grant execute on function pg_temp.try(text) to anon, authenticated, service_role;

-- ---- the migration, twice (safe to re-run) -------------------------------------------------------------------------
\ir ../../supabase/migrations/0351_r154e_suggestion_box.sql
\ir ../../supabase/migrations/0351_r154e_suggestion_box.sql

do $$ declare u uuid; begin
  perform pg_temp.su();
  if not exists (select 1 from auth.users where email = 'admin@helm.events') then perform auth.seed_user('admin@helm.events'); end if;
  insert into public.platform_admins(email) values ('admin@helm.events') on conflict do nothing;
  update public.platform_admins set require_mfa = false;
  select id into u from auth.users where email = 'a_crew@a.test';
  if u is null then u := auth.seed_user('a_crew@a.test'); end if;
  insert into public.profiles(id, email, role, org_id, must_change_password, created_at)
    values (u, 'a_crew@a.test', 'crew', 'a0000000-0000-4000-8000-000000000001', false, now())
    on conflict (id) do update set role = excluded.role, org_id = excluded.org_id;
  delete from public.auth_rate_hits where bucket like 'sugg.%';
  -- the public /suggest form (0271 / 0298 grant): an earlier suite in run-all takes anon off every function, so put the
  -- fresh-install grant back for this run only (rolled back with everything else)
  grant execute on function public.submit_suggestion(jsonb) to anon;
  delete from public.suggestion_votes;
  delete from public.suggestions;
end $$;

-- ---- 1) schema + grants ------------------------------------------------------------------------------------------
do $$ begin
  perform pg_temp.res('01 new columns, wider status list (superset), +1 table with RLS on and no app table privilege',
    (select count(*) from pg_attribute where attrelid = 'public.suggestions'::regclass and not attisdropped
       and attname in ('reply', 'replied_at', 'replied_by', 'reply_seen_at', 'share_with_studio')) = 5
    and (select pg_get_constraintdef(c.oid) from pg_constraint c where c.conname = 'suggestions_status_check' and c.conrelid = 'public.suggestions'::regclass)
        ~ 'reviewed.*planned.*done.*not_now'
    and (select relrowsecurity from pg_class where oid = 'public.suggestion_votes'::regclass)
    and not has_table_privilege('authenticated', 'public.suggestion_votes', 'select')
    and not has_table_privilege('anon', 'public.suggestion_votes', 'select')
    and not has_table_privilege('authenticated', 'public.suggestions', 'select')
    and not has_table_privilege('authenticated', 'public.suggestions', 'update'));
  perform pg_temp.res('02 signed-in only for the app functions, nobody for the helpers, kept copies not callable',
    has_function_privilege('authenticated', 'public.suggestion_submit(jsonb)', 'execute')
    and has_function_privilege('authenticated', 'public.my_suggestions()', 'execute')
    and has_function_privilege('authenticated', 'public.suggestion_vote(uuid,boolean)', 'execute')
    and has_function_privilege('authenticated', 'public.hq_reply_suggestion(uuid,text,text)', 'execute')
    and not has_function_privilege('anon', 'public.suggestion_submit(jsonb)', 'execute')
    and not has_function_privilege('anon', 'public.my_suggestions()', 'execute')
    and not has_function_privilege('anon', 'public.suggestion_vote(uuid,boolean)', 'execute')
    and not has_function_privilege('anon', 'public.suggestion_share(uuid,boolean)', 'execute')
    and not has_function_privilege('anon', 'public.hq_reply_suggestion(uuid,text,text)', 'execute')
    and not has_function_privilege('anon', 'public.hq_suggestions(text)', 'execute')
    and not has_function_privilege('authenticated', 'public._r351_row(public.suggestions,uuid)', 'execute')
    and not has_function_privilege('authenticated', 'public._r351_keep(text)', 'execute')
    and to_regprocedure('public.hq_suggestions__pre0351(text)') is not null
    and to_regprocedure('public.hq_set_suggestion__pre0351(uuid,text,text)') is not null
    and not has_function_privilege('authenticated', 'public.hq_suggestions__pre0351(text)', 'execute')
    and not has_function_privilege('authenticated', 'public.hq_set_suggestion__pre0351(uuid,text,text)', 'execute'));
end $$;

-- ---- 2) anon is refused --------------------------------------------------------------------------------------------
do $$ declare e text; begin
  perform pg_temp.anon();
  e := pg_temp.try('select public.my_suggestions()');
  perform pg_temp.res('03 anon: My suggestions refused', e like '42501%', e);
  e := pg_temp.try('select public.suggestion_submit(''{"message": "anon idea here"}''::jsonb)');
  perform pg_temp.res('04 anon: the app form refused', e like '42501%', e);
  e := pg_temp.try('select public.suggestion_vote(gen_random_uuid(), true)');
  perform pg_temp.res('05 anon: +1 refused', e like '42501%', e);
  e := pg_temp.try('select count(*) from public.suggestions');
  perform pg_temp.res('06 anon: the table itself refused', e like '42501%', e);
  perform pg_temp.su();
end $$;

-- ---- 3) sending (admin / sales / crew) -----------------------------------------------------------------------------
do $$ declare r jsonb; begin
  perform pg_temp.login('a_staff@a.test');
  r := public.suggestion_submit('{"message": "Please add a Gantt view for events", "category": "idea", "page": "/dashboard", "share": true}');
  perform pg_temp.su();
  perform pg_temp.res('10 sales sends a shared idea: ok, studio A recorded by the server, shared, source app, page kept',
    r ->> 'ok' = 'true' and exists (select 1 from public.suggestions s join auth.users u on u.id = s.user_id
      where u.email = 'a_staff@a.test' and s.studio_id = 'a0000000-0000-4000-8000-000000000001' and s.share_with_studio
        and s.source = 'app' and s.category = 'idea' and s.page = '/dashboard' and s.status = 'new' and s.reply is null), r::text);
  perform pg_temp.login('a_admin@a.test');
  r := public.suggestion_submit('{"message": "The invoice PDF cuts the logo", "category": "problem", "page": "/finance"}');
  perform pg_temp.su();
  perform pg_temp.res('11 admin sends a private problem (no share tick): not shared',
    r ->> 'ok' = 'true' and exists (select 1 from public.suggestions s join auth.users u on u.id = s.user_id
      where u.email = 'a_admin@a.test' and not s.share_with_studio and s.category = 'problem'), r::text);
  perform pg_temp.login('a_crew@a.test');
  r := public.suggestion_submit('{"message": "Show the venue map on my task page", "category": "other", "share": true}');
  perform pg_temp.su();
  perform pg_temp.res('12 crew sends one too (every role)',
    r ->> 'ok' = 'true' and exists (select 1 from public.suggestions s join auth.users u on u.id = s.user_id
      where u.email = 'a_crew@a.test' and s.share_with_studio), r::text);
  perform pg_temp.login('b_admin@b.test');
  r := public.suggestion_submit('{"message": "Studio B wants dark tables", "category": "idea", "share": true}');
  perform pg_temp.su();
  perform pg_temp.res('13 another studio sends a shared one', r ->> 'ok' = 'true', r::text);
  -- validation (the 0271 rules)
  perform pg_temp.login('a_staff@a.test');
  perform pg_temp.res('14 too short / bad kind / extra key / not an object -> refused, nothing saved',
    public.suggestion_submit('{"message": "x"}') ->> 'reason' = 'invalid'
    and public.suggestion_submit('{"message": "A fine idea", "category": "rant"}') ->> 'field' = 'category'
    and public.suggestion_submit('{"message": "A fine idea", "studio_id": "b0000000-0000-4000-8000-000000000001"}') ->> 'reason' = 'invalid'
    and public.suggestion_submit('"text"') ->> 'reason' = 'invalid');
  r := public.suggestion_submit(jsonb_build_object('message', '<script>alert(1)</script> ' || repeat('a', 2100), 'share', 'yes'));
  perform pg_temp.su();
  perform pg_temp.res('15 tags flattened, text cut at 2000, a share that is not true / false = not shared',
    r ->> 'ok' = 'true' and exists (select 1 from public.suggestions s where s.message like '%script%alert(1)%'
      and char_length(s.message) <= 2000 and s.message !~ '[<>]' and not s.share_with_studio), r::text);
  perform pg_temp.res('16 refused tries saved nothing (studio A: 4 rows)',
    (select count(*) from public.suggestions where studio_id = 'a0000000-0000-4000-8000-000000000001') = 4);
exception when others then perform pg_temp.su(); insert into _tp values ('1x send', 'FAIL: '||sqlstate||' '||sqlerrm); end $$;

-- ---- 4) reading: own + studio-shared, never another studio ---------------------------------------------------------
do $$ declare r jsonb; x jsonb; begin
  perform pg_temp.login('a_staff@a.test');
  r := public.my_suggestions();
  perform pg_temp.res('20 sales: mine = my 2, studio = only the crew shared one (not the admin private one)',
    jsonb_array_length(r -> 'mine') = 2 and jsonb_array_length(r -> 'studio') = 1
    and r -> 'studio' -> 0 ->> 'message' = 'Show the venue map on my task page' and (r ->> 'can_share')::boolean, left(r::text, 400));
  x := r -> 'studio' -> 0;
  perform pg_temp.res('21 a shared row never says who wrote it (no user, e-mail, name, network, browser, HQ note)',
    not (x ? 'user_id') and not (x ? 'email') and not (x ? 'who') and not (x ? 'ip_hash') and not (x ? 'user_agent')
    and not (x ? 'hq_note') and x ->> 'mine' = 'false', x::text);
  perform pg_temp.login('b_admin@b.test');
  r := public.my_suggestions();
  perform pg_temp.res('22 studio B: sees only its own row, nothing of studio A',
    jsonb_array_length(r -> 'mine') = 1 and jsonb_array_length(r -> 'studio') = 0
    and r::text not like '%Gantt%' and r::text not like '%venue map%', left(r::text, 300));
  perform pg_temp.su();
exception when others then perform pg_temp.su(); insert into _tp values ('2x read', 'FAIL: '||sqlstate||' '||sqlerrm); end $$;

-- ---- 5) +1 and share ---------------------------------------------------------------------------------------------
do $$ declare r jsonb; e text; v_staff uuid; v_admin uuid; v_b uuid; begin
  perform pg_temp.su();
  select s.id into v_staff from public.suggestions s join auth.users u on u.id = s.user_id where u.email = 'a_staff@a.test' and s.share_with_studio;
  select s.id into v_admin from public.suggestions s join auth.users u on u.id = s.user_id where u.email = 'a_admin@a.test';
  select s.id into v_b from public.suggestions s join auth.users u on u.id = s.user_id where u.email = 'b_admin@b.test';
  perform pg_temp.login('a_admin@a.test');
  r := public.suggestion_vote(v_staff, true);
  perform pg_temp.res('30 a studio mate +1s a shared idea', (r ->> 'votes')::int = 1 and (r ->> 'voted')::boolean, r::text);
  r := public.suggestion_vote(v_staff, true);
  perform pg_temp.res('31 a second +1 by the same person still counts once', (r ->> 'votes')::int = 1, r::text);
  perform pg_temp.login('a_crew@a.test');
  r := public.suggestion_vote(v_staff, true);
  perform pg_temp.res('32 another studio mate: 2', (r ->> 'votes')::int = 2, r::text);
  r := public.suggestion_vote(v_staff, false);
  perform pg_temp.su();
  perform pg_temp.res('33 a +1 taken back: count 1, the vote row is kept (active false, nothing deleted)',
    (r ->> 'votes')::int = 1 and (select count(*) from public.suggestion_votes where suggestion_id = v_staff) = 2
    and (select count(*) from public.suggestion_votes where suggestion_id = v_staff and not active) = 1, r::text);
  perform pg_temp.login('a_staff@a.test');
  e := pg_temp.try(format('select public.suggestion_vote(%L, true)', v_staff));
  perform pg_temp.res('34 no +1 on your own suggestion', e like '22023%', e);
  e := pg_temp.try(format('select public.suggestion_vote(%L, true)', v_admin));
  perform pg_temp.res('35 no +1 on a private one of a studio mate (looks like not found)', e like '22023%suggestion not found%', e);
  perform pg_temp.login('b_admin@b.test');
  e := pg_temp.try(format('select public.suggestion_vote(%L, true)', v_staff));
  perform pg_temp.res('36 another studio cannot +1 (not found, nothing learned)', e like '22023%suggestion not found%', e);
  e := pg_temp.try(format('select public.suggestion_share(%L, false)', v_staff));
  perform pg_temp.res('37 another studio cannot un-share it', e like '22023%', e);
  perform pg_temp.login('a_staff@a.test');
  e := pg_temp.try(format('select public.suggestion_share(%L, true)', v_admin));
  perform pg_temp.res('38 a studio mate cannot share someone else row', e like '22023%', e);
  perform pg_temp.login('a_admin@a.test');
  r := public.suggestion_share(v_admin, true);
  perform pg_temp.res('39 the sender shares their own row', (r ->> 'shared')::boolean and (r ->> 'mine')::boolean, r::text);
  perform pg_temp.login('a_staff@a.test');
  perform pg_temp.res('40 ... and now a studio mate sees it',
    exists (select 1 from jsonb_array_elements(public.my_suggestions() -> 'studio') z where z ->> 'id' = v_admin::text));
  perform pg_temp.su();
  perform pg_temp.res('41 another studio row never got a vote from studio A', not exists (select 1 from public.suggestion_votes where suggestion_id = v_b));
exception when others then perform pg_temp.su(); insert into _tp values ('3x vote', 'FAIL: '||sqlstate||' '||sqlerrm); end $$;

-- ---- 6) Helm HQ --------------------------------------------------------------------------------------------------
do $$ declare r jsonb; e text; v uuid; x jsonb; begin
  perform pg_temp.su();
  select s.id into v from public.suggestions s join auth.users u on u.id = s.user_id where u.email = 'a_staff@a.test' and s.share_with_studio;
  perform pg_temp.login('a_admin@a.test');
  e := pg_temp.try('select public.hq_suggestions(null)');
  perform pg_temp.res('50 a studio admin cannot read the HQ list', e like '42501%', e);
  e := pg_temp.try(format('select public.hq_reply_suggestion(%L, ''hi'', null)', v));
  perform pg_temp.res('51 a studio admin cannot reply', e like '42501%', e);
  e := pg_temp.try(format('select public.hq_set_suggestion(%L, ''done'', null)', v));
  perform pg_temp.res('52 a studio admin cannot change the status', e like '42501%', e);
  perform pg_temp.op();
  r := public.hq_suggestions(null);
  select z into x from jsonb_array_elements(r -> 'rows') z where z ->> 'id' = v::text;
  perform pg_temp.res('53 HQ sees every studio (A + B), with +1 count, shared, in-app, e-mail masked',
    jsonb_array_length(r -> 'rows') = 5 and (r -> 'counts' ->> 'new')::int = 5
    and (x ->> 'votes')::int = 1 and (x ->> 'shared')::boolean and (x ->> 'in_app')::boolean and x ->> 'studio' = 'Studio A'
    and x ->> 'email' <> 'a_staff@a.test' and x ->> 'who' <> 'a_staff@a.test'
    and r::text like '%Studio B%', left(coalesce(x::text, r::text), 400));
  r := public.hq_set_suggestion(v, 'planned', null);
  perform pg_temp.res('54 HQ marks Planned', r ->> 'status' = 'planned', r::text);
  r := public.hq_set_suggestion(v, 'not_now', null);
  perform pg_temp.res('55 HQ marks Not now', r ->> 'status' = 'not_now', r::text);
  e := pg_temp.try(format('select public.hq_set_suggestion(%L, ''won'', null)', v));
  perform pg_temp.res('56 a bad status is refused', e like '22023%', e);
  r := public.hq_reply_suggestion(v, E'Thanks! Gantt view is planned for December.\u0007', 'planned');
  perform pg_temp.res('57 HQ replies + Planned in one step (control characters flattened)',
    r ->> 'status' = 'planned' and r ->> 'reply' = 'Thanks! Gantt view is planned for December.' and r ->> 'replied_at' is not null, r::text);
  perform pg_temp.su();
  perform pg_temp.res('58 the reply is in the audit log (hq.suggestion.update)',
    exists (select 1 from public.audit_log where action = 'hq.suggestion.update' and entity_id = v::text and changed ? 'reply'));
  perform pg_temp.op();
  perform pg_temp.res('59 filter by Planned', jsonb_array_length(public.hq_suggestions('planned') -> 'rows') = 1);
exception when others then perform pg_temp.su(); insert into _tp values ('4x HQ', 'FAIL: '||sqlstate||' '||sqlerrm); end $$;

-- ---- 7) the sender reads the reply ---------------------------------------------------------------------------------
do $$ declare r jsonb; x jsonb; n int; v uuid; begin
  perform pg_temp.login('a_staff@a.test');
  r := public.my_suggestions();
  select z into x from jsonb_array_elements(r -> 'mine') z where z ->> 'status' = 'planned';
  perform pg_temp.res('60 the sender sees Planned + the reply, marked unread (count 1)',
    x ->> 'reply' = 'Thanks! Gantt view is planned for December.' and (x ->> 'unread')::boolean and (r ->> 'unread')::int = 1
    and public.my_suggestion_unread() = 1, left(r::text, 400));
  n := public.suggestion_replies_seen();
  perform pg_temp.res('61 opening My suggestions marks it read', n = 1 and public.my_suggestion_unread() = 0
    and (public.my_suggestions() ->> 'unread')::int = 0);
  perform pg_temp.login('a_crew@a.test');
  r := public.my_suggestions();
  perform pg_temp.res('62 a studio mate sees the reply on the shared row, but it is not unread for them and they cannot mark it',
    exists (select 1 from jsonb_array_elements(r -> 'studio') z where z ->> 'reply' like 'Thanks!%' and z ->> 'unread' = 'false')
    and public.suggestion_replies_seen() = 0, left(r::text, 300));
  perform pg_temp.login('b_admin@b.test');
  perform pg_temp.res('63 another studio never sees the reply', public.my_suggestions()::text not like '%Gantt%');
  perform pg_temp.op();
  select (z ->> 'id')::uuid into v from jsonb_array_elements(public.hq_suggestions('planned') -> 'rows') z limit 1;
  r := public.hq_reply_suggestion(v, '  ', null);
  perform pg_temp.res('64 an empty reply removes it (status kept)', r ->> 'reply' is null and r ->> 'status' = 'planned', r::text);
  perform pg_temp.su();
exception when others then perform pg_temp.su(); insert into _tp values ('5x reply', 'FAIL: '||sqlstate||' '||sqlerrm); end $$;

-- ---- 8) limits + the public form ---------------------------------------------------------------------------------
do $$ declare r jsonb; e text; u uuid; i int; begin
  perform pg_temp.su();
  select id into u from auth.users where email = 'a_crew@a.test';
  for i in 1..19 loop
    insert into public.suggestions(message, source, user_id, studio_id) values ('older idea ' || i, 'app', u, 'a0000000-0000-4000-8000-000000000001');
  end loop;
  perform pg_temp.login('a_crew@a.test');
  r := public.suggestion_submit('{"message": "One more idea today"}');
  perform pg_temp.res('70 20 a day per person: the 21st gets a plain answer (rate)', r ->> 'reason' = 'rate' and r ->> 'message' like '%20 suggestions today%', r::text);
  e := pg_temp.try('select public.submit_suggestion(''{"message": "Through the old door"}''::jsonb)');
  perform pg_temp.res('71 the older submit_suggestion route is capped too (trigger)', e like 'P0001%20 suggestions today%', e);
  perform pg_temp.login('a_staff@a.test');
  r := public.suggestion_submit('{"message": "A different person is not capped"}');
  perform pg_temp.res('72 another person of the studio is not affected', r ->> 'ok' = 'true', r::text);
  perform pg_temp.anon('203.0.113.71');
  r := public.submit_suggestion('{"message": "Visitor idea from the website", "email": "v@example.com"}');
  perform pg_temp.su();
  perform pg_temp.res('73 the public /suggest form still works, never shared, no studio',
    r ->> 'ok' = 'true' and exists (select 1 from public.suggestions where message = 'Visitor idea from the website'
      and user_id is null and studio_id is null and not share_with_studio and source = 'site'), r::text);
  insert into public.suggestions(message, source, status, reply) values ('Old reviewed row', 'site', 'reviewed', 'sneaky');
  perform pg_temp.res('74 an old 0271 status (reviewed) still passes, a reply cannot be planted on insert',
    exists (select 1 from public.suggestions where message = 'Old reviewed row' and status = 'reviewed' and reply is null));
exception when others then perform pg_temp.su(); insert into _tp values ('6x limits', 'FAIL: '||sqlstate||' '||sqlerrm); end $$;

-- ---- 9) re-apply: nothing changes -----------------------------------------------------------------------------------
create temp table _before as select id, status, reply, share_with_studio, message from public.suggestions;
\ir ../../supabase/migrations/0351_r154e_suggestion_box.sql
do $$ begin
  perform pg_temp.su();
  perform pg_temp.res('80 re-applied: every row, status, reply and share unchanged; votes unchanged',
    (select count(*) from public.suggestions) = (select count(*) from _before)
    and not exists (select 1 from _before b left join public.suggestions s on s.id = b.id
                     where s.id is null or s.status is distinct from b.status or s.reply is distinct from b.reply
                        or s.share_with_studio is distinct from b.share_with_studio or s.message is distinct from b.message)
    and (select count(*) from public.suggestion_votes) = 2);
  perform pg_temp.res('81 re-applied: the kept copies are still the pre-0351 bodies (not the new ones)',
    position('r154e-0351' in (select prosrc from pg_proc where oid = 'public.hq_suggestions__pre0351(text)'::regprocedure)) = 0
    and position('r154e-0351' in (select prosrc from pg_proc where oid = 'public.hq_suggestions(text)'::regprocedure)) > 0
    and (select count(*) from pg_trigger where tgrelid = 'public.suggestions'::regclass and tgname = 'zz_r351_suggestion_guard') = 1);
end $$;

select name, result from _tp order by name;
select case when count(*) filter (where result <> 'PASS') = 0 then 'R154E-SUGGESTION-BOX-0351: ALL PASS (' || count(*) || '/' || count(*) || ')'
            else 'R154E-SUGGESTION-BOX-0351: ' || count(*) filter (where result <> 'PASS') || ' FAILED of ' || count(*) end as summary from _tp;
rollback;
