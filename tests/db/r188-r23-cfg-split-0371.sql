-- r188-r23-cfg-split-0371.sql - R188: the 0265 crew settings and the 0266 inbox settings each have their own reader.
-- Proves: (0) the reported bug is real - with the 0266 _r23_cfg body live (as on prod), a day marked off on the crew link
-- is saved but the link lists NO days off and every crew switch reads as null; (1) after 0371 (applied twice) the crew
-- link lists the days off again and every crew caller reads _r25_crew_cfg, every inbox caller _r25_inbox_cfg, nobody but
-- the shared name itself calls _r23_cfg; (2) crew settings switches are respected end to end (availability off -> link
-- hides the list + refuses a new day; self check-in off -> check-in refused; saved claim mode / radius come back);
-- (3) inbox settings still save and read (and no crew keys leak into them, or inbox keys into the crew settings);
-- (4) re-running an OLD paste (the 0266 body or the 0265 body put back on _r23_cfg) no longer breaks either feature;
-- (5) owner / grants / security definer / search_path of every re-issued caller unchanged; _r23_cfg = the 0274 text.
-- Local disposable PG only. Fake data only. Rolled back.
\set ON_ERROR_STOP 0
set client_min_messages = warning;
begin;
create temp table _rs(name text, result text); grant all on _rs to anon, authenticated, service_role;
create temp table _kv(k text primary key, v text); grant all on _kv to anon, authenticated, service_role;
create or replace function pg_temp.t(p_name text, p_ok boolean, p_detail text default '') returns void language plpgsql as $$
begin insert into _rs values (p_name, case when coalesce(p_ok, false) then 'PASS' else 'FAIL: ' || coalesce(p_detail, '') end); end $$;
create or replace function pg_temp.as_val(p_who text, p_sql text) returns text language plpgsql as $$
declare v text;
begin
  if p_who = 'anon' then perform auth.login_anon();
  elsif p_who is not null then perform auth.login_as((select id from auth.users where email = p_who)); end if;
  execute p_sql into v;
  perform auth.logout(); execute 'reset role';
  return 'ok:' || coalesce(v, '<null>');
exception when others then
  perform auth.logout(); execute 'reset role';
  return sqlstate || ' ' || sqlerrm;
end $$;
grant execute on function pg_temp.t(text, boolean, text) to anon, authenticated, service_role;

-- the two OLD bodies of _r23_cfg, exactly as 0266 and 0265 wrote them (what a re-run of those paste files puts back)
create or replace function pg_temp.put_0266_body() returns void language plpgsql as $f$
begin
  execute $b$
create or replace function public._r23_cfg(p_org uuid)
returns jsonb language sql stable security definer set search_path = '' as $$
  -- r23-inbox-0266
  select jsonb_build_object(
    'email_enabled', coalesce(s.email_enabled, true),
    'digest_default', coalesce(s.digest_default, 'daily'),
    'digest_hour', coalesce(s.digest_hour, 8),
    'digest_min_age_minutes', coalesce(s.digest_min_age_minutes, 60),
    'bell_open_marks_read', coalesce(s.bell_open_marks_read, false),
    'timezone', coalesce((select o.timezone from public.organizations o where o.id = p_org), 'Asia/Kolkata'),
    'saved', s.org_id is not null)
  from (select 1) one left join public.inbox_settings s on s.org_id = p_org;
$$ $b$;
end $f$;
create or replace function pg_temp.put_0265_body() returns void language plpgsql as $f$
begin
  -- the crew half only (the 0265 keys): what a re-run of APPLY-0265 puts back
  execute $b$
create or replace function public._r23_cfg(p_org uuid)
returns jsonb language sql stable security definer set search_path = '' as $$
  select public._r25_crew_cfg(p_org)
$$ $b$;
end $f$;

-- fixture: studio A event a..da01 today, one staff member Ravi with a crew link; studio A starts from the crew defaults
do $$ declare a uuid := 'a0000000-0000-4000-8000-000000000001'; q uuid := 'a0000000-0000-4000-8000-00000000da01'; c uuid;
begin
  update public.quotes set status = 'confirmed', lifecycle_stage = 'confirmed', event_date = public._a198_org_today(a), event_time = null where id = q;
  delete from public.app_config where key = 'crew' and org_id = a;      -- test transaction only (rolled back)
  insert into public.crew_members(name, phone, day_rate, org_id) values ('Ravi r188', '+919800003711', 1200, a) returning id into c;
  insert into public.event_tasks(quote_id, category, title, crew_id, assignee_name, assignee_phone, status, org_id)
    values (q, 'Setup', 'Load in', c, 'Ravi r188', '+919800003711', 'accepted', a);
  insert into public.work_tokens(token, quote_id, phone, name, org_id) values ('f3710000-0000-4000-8000-000000000001', q, '+919800003711', 'Ravi r188', a);
  insert into _kv values ('crew', c::text), ('today', public._a198_org_today(a)::text);
end $$;

-- ---- 00 the bug as the owner saw it (callers on the shared name, the 0266 body live) -----------------------------------------
-- this DB already has 0371 (db-migrate): put every caller back on _r23_cfg first = the database before this fix
do $$ declare f text; v_def text;
begin
  foreach f in array array['public.get_crew_settings()', 'public.crew_link_home__pre0299(uuid)', 'public.crew_set_availability(uuid,date,text,text)',
        'public.crew_claim_shift(uuid,uuid)', 'public.crew_check(uuid,text,numeric,numeric,numeric)',
        'public.open_shift_post(uuid,text,date,time,time,numeric,text,integer,text,text,text,text)', 'public.open_shifts_for_event(uuid)',
        'public.event_timesheet(uuid)', 'public._r21_cost_lines(uuid,uuid)', 'public._r23_mode(uuid,uuid)', 'public._r23_my_settings(uuid,uuid)',
        'public.admin_get_inbox_settings()', 'public.admin_set_inbox_settings(jsonb)', 'public.bell_feed__pre0299(integer)',
        'public._r23_queue_digests()'] loop
    v_def := pg_get_functiondef(f::regprocedure);
    execute replace(replace(v_def, 'public._r25_crew_cfg(', 'public._r23_cfg('), 'public._r25_inbox_cfg(', 'public._r23_cfg(');
  end loop;
end $$;
select pg_temp.put_0266_body();
do $$ declare h jsonb; r jsonb; d date := (select v from _kv where k = 'today')::date;
begin
  r := public.crew_set_availability('f3710000-0000-4000-8000-000000000001', d + 10, 'unavailable', 'wedding');
  h := public.crew_link_home('f3710000-0000-4000-8000-000000000001');
  perform pg_temp.t('00 bug reproduced: day saved, crew link lists no days off, crew switches read null',
    (r ->> 'ok')::boolean
    and (select count(*) from public.crew_availability where crew_id = (select v from _kv where k = 'crew')::uuid) = 1
    -- (with the 0370 crew_link_home wrapper - PR #422 - the list is rebuilt there, so only the null switch shows the bug)
    and (coalesce(jsonb_array_length(h -> 'availability'), 0) = 0 or to_regprocedure('public.crew_link_home__pre0370(uuid)') is not null)
    and h #> '{settings,availability}' = 'null'::jsonb, h::text);
end $$;

-- ---- the fix, twice ---------------------------------------------------------------------------------------------------------
\ir ../../supabase/migrations/0371_r188_r23_cfg_split.sql
\ir ../../supabase/migrations/0371_r188_r23_cfg_split.sql

do $$ declare n int; v text;
begin
  select count(*), string_agg(p.oid::regprocedure::text, ', ') into n, v from pg_proc p
   where p.pronamespace = 'public'::regnamespace and p.proname <> '_r23_cfg' and position('public._r23_cfg(' in p.prosrc) > 0;
  perform pg_temp.t('01 nobody calls the shared name any more', n = 0, coalesce(v, ''));
  select count(*) into n from unnest(array['public.get_crew_settings()', 'public.crew_link_home__pre0299(uuid)',
      'public.crew_set_availability(uuid,date,text,text)', 'public.crew_claim_shift(uuid,uuid)',
      'public.crew_check(uuid,text,numeric,numeric,numeric)',
      'public.open_shift_post(uuid,text,date,time,time,numeric,text,integer,text,text,text,text)',
      'public.open_shifts_for_event(uuid)', 'public.event_timesheet(uuid)', 'public._r21_cost_lines(uuid,uuid)']) f
   where position('public._r25_crew_cfg(' in (select prosrc from pg_proc where oid = to_regprocedure(f))) > 0;
  perform pg_temp.t('02 the nine crew callers read the crew settings (_r25_crew_cfg)', n = 9, n::text);
  select count(*) into n from unnest(array['public._r23_mode(uuid,uuid)', 'public._r23_my_settings(uuid,uuid)',
      'public.admin_get_inbox_settings()', 'public.admin_set_inbox_settings(jsonb)', 'public.bell_feed__pre0299(integer)',
      'public._r23_queue_digests()']) f
   where position('public._r25_inbox_cfg(' in (select prosrc from pg_proc where oid = to_regprocedure(f))) > 0;
  perform pg_temp.t('03 the six inbox callers read the inbox settings (_r25_inbox_cfg)', n = 6, n::text);
  perform pg_temp.t('04 _r23_cfg is the 0274 body again (both key sets; 0274 check still matches)',
    md5((select prosrc from pg_proc where oid = 'public._r23_cfg(uuid)'::regprocedure)) = '8e607bcab70096bc25f68e56dd8e71fe'
    and public._r23_cfg('a0000000-0000-4000-8000-000000000001') ? 'availability'
    and public._r23_cfg('a0000000-0000-4000-8000-000000000001') ? 'digest_default'
    and not has_function_privilege('authenticated', 'public._r23_cfg(uuid)', 'execute')
    and not has_function_privilege('anon', 'public._r23_cfg(uuid)', 'execute'));
end $$;

-- ---- 05-06 crew link lists the days off again ---------------------------------------------------------------------------------
do $$ declare h jsonb; d date := (select v from _kv where k = 'today')::date;
begin
  h := public.crew_link_home('f3710000-0000-4000-8000-000000000001');
  perform pg_temp.t('05 crew link lists the day off saved before the fix (with its note)',
    jsonb_array_length(h -> 'availability') = 1 and h #>> '{availability,0,day}' = (d + 10)::text
    and h #>> '{availability,0,note}' = 'wedding' and (h #>> '{settings,availability}')::boolean, h::text);
  perform public.crew_set_availability('f3710000-0000-4000-8000-000000000001', d + 12, 'unavailable', null);
  h := public.crew_link_home('f3710000-0000-4000-8000-000000000001');
  perform pg_temp.t('06 a new day off shows up at once', jsonb_array_length(h -> 'availability') = 2, h::text);
end $$;

-- ---- 07-11 crew settings switches respected --------------------------------------------------------------------------------
do $$ declare r text; s jsonb; h jsonb; e text;
begin
  r := pg_temp.as_val('a_admin@a.test', $q$select public.set_crew_settings('{"availability": false, "selfCheckin": false, "claimMode": "approval", "geofenceRadiusM": 500}')::text$q$);
  s := substr(r, 4)::jsonb;
  perform pg_temp.t('07 saved crew settings come back (claim mode, radius, both switches off); no inbox keys in them',
    left(r, 3) = 'ok:' and s ->> 'claimMode' = 'approval' and (s ->> 'geofenceRadiusM')::int = 500
    and not (s ->> 'availability')::boolean and not (s ->> 'selfCheckin')::boolean
    and not (s ? 'digest_default') and not (s ? 'email_enabled'), r);
  h := public.crew_link_home('f3710000-0000-4000-8000-000000000001');
  perform pg_temp.t('08 availability off: the crew link hides the list and says it is off',
    jsonb_array_length(h -> 'availability') = 0 and not (h #>> '{settings,availability}')::boolean
    and not (h #>> '{settings,selfCheckin}')::boolean, h::text);
  e := pg_temp.as_val('anon', format('select public.crew_set_availability(%L, %L, %L)::text', 'f3710000-0000-4000-8000-000000000001',
                                     (select v from _kv where k = 'today')::date + 20, 'unavailable'));
  perform pg_temp.t('09 availability off: a new day off is refused', e like '42501%switched availability off%', e);
  e := pg_temp.as_val('anon', $q$select public.crew_check('f3710000-0000-4000-8000-000000000001', 'in', null, null, null)::text$q$);
  perform pg_temp.t('10 self check-in off: check-in refused', e like '42501%Self check-in is switched off%', e);
  r := pg_temp.as_val('a_admin@a.test', $q$select public.set_crew_settings('{"availability": true}')::text$q$);
  h := public.crew_link_home('f3710000-0000-4000-8000-000000000001');
  perform pg_temp.t('11 availability back on: both days off listed again', jsonb_array_length(h -> 'availability') = 2, h::text);
end $$;

-- ---- 12-13 inbox settings still save and read --------------------------------------------------------------------------------
do $$ declare r text; s jsonb;
begin
  r := pg_temp.as_val('a_admin@a.test', $q$select public.admin_set_inbox_settings('{"email_enabled": true, "digest_default": "daily", "digest_hour": 9}')::text$q$);
  r := pg_temp.as_val('a_admin@a.test', $q$select public.admin_get_inbox_settings()::text$q$);
  s := substr(r, 4)::jsonb;
  perform pg_temp.t('12 inbox settings save + read back; no crew keys in them',
    left(r, 3) = 'ok:' and (s ->> 'email_enabled')::boolean and s ->> 'digest_default' = 'daily' and (s ->> 'digest_hour')::int = 9
    and (s ->> 'saved')::boolean and not (s ? 'availability') and not (s ? 'claimMode'), r);
  perform pg_temp.t('13 a person''s e-mail mode follows the studio inbox setting',
    public._r23_mode('a0000000-0000-4000-8000-000000000001', (select id from auth.users where email = 'a_admin@a.test')) = 'daily');
end $$;

-- ---- 14-15 an old paste file re-run no longer breaks either feature ----------------------------------------------------------
select pg_temp.put_0266_body();
do $$ declare h jsonb; r text;
begin
  h := public.crew_link_home('f3710000-0000-4000-8000-000000000001');
  r := pg_temp.as_val('a_admin@a.test', $q$select public.get_crew_settings()::text$q$);
  perform pg_temp.t('14 0266 body put back on _r23_cfg: crew link still lists the days off, crew settings intact',
    jsonb_array_length(h -> 'availability') = 2 and (h #>> '{settings,availability}')::boolean
    and substr(r, 4)::jsonb ->> 'claimMode' = 'approval', h::text || ' ' || r);
end $$;
select pg_temp.put_0265_body();
do $$ declare r text; s jsonb;
begin
  r := pg_temp.as_val('a_admin@a.test', $q$select public.admin_set_inbox_settings('{"digest_hour": 7}')::text$q$);
  r := pg_temp.as_val('a_admin@a.test', $q$select public.admin_get_inbox_settings()::text$q$);
  s := substr(r, 4)::jsonb;
  perform pg_temp.t('15 0265 body put back on _r23_cfg: inbox settings still save and read',
    left(r, 3) = 'ok:' and (s ->> 'digest_hour')::int = 7 and s ->> 'digest_default' = 'daily', r);
end $$;

-- ---- 16 nothing else about the callers changed ---------------------------------------------------------------------------------
do $$ declare n int; v text;
begin
  select count(*), string_agg(f, ', ') filter (where not ok) into n, v from (
    select f, p.prosecdef and p.proconfig = array['search_path=""'] and p.proowner = (select oid from pg_roles where rolname = current_user) as ok
      from unnest(array['public.get_crew_settings()', 'public.crew_link_home__pre0299(uuid)', 'public.crew_set_availability(uuid,date,text,text)',
        'public.crew_claim_shift(uuid,uuid)', 'public.crew_check(uuid,text,numeric,numeric,numeric)',
        'public.open_shift_post(uuid,text,date,time,time,numeric,text,integer,text,text,text,text)', 'public.open_shifts_for_event(uuid)',
        'public.event_timesheet(uuid)', 'public._r21_cost_lines(uuid,uuid)', 'public._r23_mode(uuid,uuid)', 'public._r23_my_settings(uuid,uuid)',
        'public.admin_get_inbox_settings()', 'public.admin_set_inbox_settings(jsonb)', 'public.bell_feed__pre0299(integer)',
        'public._r23_queue_digests()']) f join pg_proc p on p.oid = to_regprocedure(f)) x;
  perform pg_temp.t('16a all 15 callers still security definer, search_path empty, same owner', n = 15 and v is null, n || ' ' || coalesce(v, ''));
  perform pg_temp.t('16b grants unchanged: crew link RPCs for anon, office RPCs not, helpers / ledger for nobody',
    has_function_privilege('anon', 'public.crew_link_home(uuid)', 'execute')
    and has_function_privilege('anon', 'public.crew_set_availability(uuid,date,text,text)', 'execute')
    and has_function_privilege('anon', 'public.crew_check(uuid,text,numeric,numeric,numeric)', 'execute')
    and has_function_privilege('authenticated', 'public.get_crew_settings()', 'execute')
    and not has_function_privilege('anon', 'public.get_crew_settings()', 'execute')
    and has_function_privilege('authenticated', 'public.admin_set_inbox_settings(jsonb)', 'execute')
    and not has_function_privilege('anon', 'public.admin_set_inbox_settings(jsonb)', 'execute')
    and not has_function_privilege('authenticated', 'public._r21_cost_lines(uuid,uuid)', 'execute')
    and not has_function_privilege('authenticated', 'public._r23_queue_digests()', 'execute')
    and not has_function_privilege('authenticated', 'public._r25_crew_cfg(uuid)', 'execute')
    and not has_function_privilege('authenticated', 'public._r25_inbox_cfg(uuid)', 'execute'));
  perform pg_temp.t('16c the ledger keeps its 0246 / 0252 / 0265 markers',
    position('r22-money-0252' in (select prosrc from pg_proc where oid = 'public._r21_cost_lines(uuid,uuid)'::regprocedure)) > 0
    and position('r21-money-0246' in (select prosrc from pg_proc where oid = 'public._r21_cost_lines(uuid,uuid)'::regprocedure)) > 0
    and position('r23-crew-0265' in (select prosrc from pg_proc where oid = 'public._r21_cost_lines(uuid,uuid)'::regprocedure)) > 0);
end $$;

select name, result from _rs order by name;
select case when count(*) filter (where result <> 'PASS') = 0
            then 'R188-R23-CFG-0371: ALL PASS (' || count(*) || '/' || count(*) || ')'
            else 'R188-R23-CFG-0371: ' || count(*) filter (where result <> 'PASS') || ' FAILED' end as summary
  from _rs;
rollback;
