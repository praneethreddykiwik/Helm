-- APPLY-0401 (R235 database load: the bell looks at the last 90 days, the Inbox page builds details only for the page it
-- shows, a press sent twice is done once, background jobs give up on a lock after 10 s).
-- Run on STAGING first, then production. Safe to run twice. Needs 0388 / 0266 / 0293 / 0299 / 0144 / 0385 - already on both.
-- What it does:
--   * The bell list + badge and the Home "unread" number look at notifications of the last 90 days (plus older ones the
--     person marked unread / snoozed in that time). Same rule of who sees what. The Inbox page still shows everything.
--     Nothing is deleted. Measured on a copy with 50,000 notifications at Nano's 2 MB sort memory: a bell call went from
--     ~255 ms and ~55 MB of temporary files to ~120 ms and none.
--   * The Inbox page builds the cleaned-up details only for the rows it shows (same rows, order, counts and details).
--   * assign tasks (crew / vendor), Remind -> Bell, the "client opened the link" nudge and "Send payment reminder now"
--     get a <name>_once call with a request key: pressed again after a lost answer = the first answer, nothing sent
--     twice. New table rpc_request_keys (row security on, no app access). The old calls are unchanged.
--   * Seven frequent background jobs get lock_timeout = 10s on the function itself. Role / database settings untouched.
--   * The time zone name copy (0358) gets any missing name (insert only).
-- Old function bodies are kept as <name>__pre0401 (no app privilege). One new table, new functions, no data changed.
-- It waits at most 5 seconds for a table lock (then stops with an error and changes nothing - just run it again later)
-- and stops after 5 minutes at the most, so a paste can never hold up the app for long.
-- Paste the whole file into the Supabase SQL editor and press Run. The last result lists checks - every ok must be true.
begin;
set local lock_timeout = '5s';
set local statement_timeout = '5min';
-- 0401_r235_db_load.sql - R235 database load (owner read-only measurement 19 Nov 2026: 141,867 temp files / 595 GB since
-- 25 Aug = about 7 GB a day of sorts / hashes spilled to disk; auth 500s + 57014 timeouts while the DB was busy).
-- CANONICAL forward-only, additive, safe to run twice. ASCII only.
-- REQUIRES 0388 (_r388_vis / _r388_rows, the bell layers bell_feed__pre0042 / bell_feed__pre0299), 0266 (inbox_feed__pre0299,
--          inbox_act, inbox_read_all), 0292 / 0293 (my_pending), 0144 / 0385 (assign_tasks, assign_tasks_vendor).
--
-- In plain words:
--   1  THE BELL LOOKS AT THE LAST 90 DAYS. The bell list + badge (bell_feed) and the Home "unread" number (my_pending) are
--      asked on every page and again every 30 seconds. Each call worked out, for EVERY notification the studio ever had,
--      whether this person may see it and whether it is unread - on a local copy with 50,000 notifications that is
--      ~250 ms and ~18 MB written to temporary files per bell call (Nano has 2 MB of sort memory per query). Now they look
--      at the notifications of the last 90 days (plus any older one the person marked unread or snoozed in that time).
--      The rule of who sees what is the SAME rule (_r401_vis is made from the live text of _r388_vis, so it can never
--      drift; a check proves it). Older notifications stay in the database and stay on the Inbox page ("Open inbox"),
--      which still pages through everything. Nothing is deleted.
--      The window rows carry only what the rule reads (of the details: the notify list), worked out once - no sort is
--      spilled to disk any more (measured: 0 temporary files per bell call at 2 MB sort memory, was ~55 MB).
--   2  THE INBOX PAGE builds the cleaned-up details only for the up to 100 rows it shows (it built them for every row of
--      the studio and then threw all but one page away). Same rows, same order, same counts, same details.
--      "Mark read / done / snooze" and "Mark all read" check visibility without building details. Same answers.
--   3  A SAVE THAT IS SENT TWICE IS DONE ONCE: assign_tasks_once / assign_tasks_vendor_once take a request key (one per
--      press of Assign, kept by the page until the answer arrives). If the first answer was lost (venue 4G) and the
--      planner presses again, the database answers with the FIRST result instead of creating the tasks again and
--      sending the crew a second WhatsApp. Same key with different tasks = refused (22023). Without a key = exactly the
--      old call. The old assign_tasks / assign_tasks_vendor are unchanged (old pages keep working).
--      The same for the other "create + send" presses: event_task_remind_bell_once (ping a task's person),
--      link_view_nudge_once (nudge a client), payment_reminder_send_now_once. (Invite: create_invitation already answers the
--      same pending invite when pressed twice.)
--      New table public.rpc_request_keys (row security on, no policy, no app privilege): who, which call, the key,
--      a fingerprint of the request, the first answer, when. Keyed by person (no studio column: it is not studio data,
--      so trial retention / read-only studio guards do not apply to it).
--   4  SERVER JOBS DO NOT WAIT FOREVER ON A LOCK: seven frequent background jobs (quote stage sweep, link views,
--      link expiry archive, empty draft clean-up, event-ready alerts, team safety, pay details) get lock_timeout = 10s
--      on the function itself (ALTER FUNCTION ... SET; tested: a per-function lock_timeout works, a per-function
--      statement_timeout does NOT - Postgres arms that timer only when the outer statement starts). A job blocked by a
--      long lock now gives up for that studio / that run and tries again next time instead of queueing app writes
--      behind it. Role and database settings are NOT changed (owner decisions, see the PR).
--
--   5  TIME ZONE NAMES: the 0358 copy of the server's time zone names gets any name missing from it (insert only), so a
--      studio time zone is answered from the copy instead of reading every time zone file (~0.5 s each on Nano).
--
-- ZERO DATA LOSS: no row is deleted or changed; one new table (empty), new functions, re-issued read functions (old bodies
-- kept once as <name>__pre0401 with no app privilege). A body that is not the known one is left unchanged (WARNING) and
-- the matching APPLY-0401 check row shows false.
-- Rollback (all optional, nothing to undo in data): for each re-issued function drop it and rename <name>__pre0401 back
-- (bell_feed__pre0042, bell_feed__pre0299, my_pending, inbox_feed__pre0299, inbox_act, inbox_read_all);
-- "alter function ... reset lock_timeout" for the seven jobs; the new functions / table can stay (nothing calls them
-- once the page is rolled back) or be dropped.
-- FROM NOW ON: a migration that changes the inbox rule in _r388_vis must end with "select public._r401_sync();" so the bell
-- window copy follows (tests/db/r235-db-load-0401.sql fails otherwise).

-- ---- 0) preflight ------------------------------------------------------------------------------------------------------
do $$ begin
  if to_regclass('public.notifications') is null or to_regclass('public.notification_inbox_state') is null then
    raise exception 'STOP 0401: notifications / notification_inbox_state missing - this is not a Helm database'; end if;
  if to_regprocedure('public._r388_vis(uuid,uuid)') is null or to_regprocedure('public._r388_rows(uuid,uuid)') is null then
    raise exception 'STOP 0401: _r388_vis / _r388_rows missing - run 0388 first'; end if;
  if to_regprocedure('public.bell_feed__pre0042(integer)') is null or to_regprocedure('public.bell_feed__pre0299(integer)') is null
     or to_regprocedure('public.my_pending()') is null or to_regprocedure('public.inbox_feed__pre0299(text,text,uuid,integer,text)') is null
     or to_regprocedure('public.inbox_act(uuid[],text,timestamp with time zone,text)') is null
     or to_regprocedure('public.inbox_read_all(text,uuid)') is null then
    raise exception 'STOP 0401: the bell / inbox functions of 0266 / 0293 / 0299 / 0388 are missing'; end if;
  if to_regprocedure('public.assign_tasks(uuid,text,text[],uuid,text,text)') is null
     or to_regprocedure('public.assign_tasks_vendor(uuid,text,text[],uuid)') is null then
    raise exception 'STOP 0401: assign_tasks / assign_tasks_vendor missing'; end if;
  if to_regprocedure('public._r23_detail(jsonb,boolean)') is null or to_regprocedure('public._r23_area(uuid,text,text,text)') is null then
    raise exception 'STOP 0401: _r23_detail / _r23_area (0266) missing'; end if;
end $$;

-- ---- 1) helpers: keep a body once as <name>__pre0401 (no app privilege); patch a body in place --------------------------
create or replace function public._r401_keep(p_fn regprocedure)
returns text language plpgsql security definer set search_path = '' as $$
-- r235-0401
declare v_name text; v_args text; v_types text; v_copy text; d text;
begin
  select p.proname, pg_get_function_identity_arguments(p.oid), oidvectortypes(p.proargtypes) into v_name, v_args, v_types
    from pg_proc p where p.oid = p_fn;
  if v_name is null then return 'missing'; end if;
  if to_regprocedure('public.' || v_name || '__pre0401(' || v_types || ')') is not null then return 'kept'; end if;
  d := pg_get_functiondef(p_fn);
  v_copy := regexp_replace(d, '^CREATE OR REPLACE FUNCTION public\.' || v_name || '\(',
                           'CREATE OR REPLACE FUNCTION public.' || v_name || '__pre0401(');
  if v_copy = d then return 'missing'; end if;
  execute v_copy;
  execute format('revoke all on function public.%I(%s) from public', v_name || '__pre0401', v_args);
  if exists (select 1 from pg_roles where rolname = 'anon') then
    execute format('revoke all on function public.%I(%s) from anon', v_name || '__pre0401', v_args); end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    execute format('revoke all on function public.%I(%s) from authenticated', v_name || '__pre0401', v_args); end if;
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    execute format('revoke all on function public.%I(%s) from service_role', v_name || '__pre0401', v_args); end if;
  return 'copied';
end $$;

-- every p_old[i] (each must be found) -> p_new[i]; the body keeps its owner, grants, definer and settings (create or
-- replace). Never raises: 'already' = done before (p_mark is in the body), 'skipped' = the live body differs (left as it is)
create or replace function public._r401_patch(p_fn regprocedure, p_mark text, p_old text[], p_new text[])
returns text language plpgsql security definer set search_path = '' as $$
-- r235-0401
declare d text; i integer;
begin
  if p_fn is null then return 'missing'; end if;
  d := pg_get_functiondef(p_fn);
  if position(p_mark in d) > 0 then return 'already'; end if;
  for i in 1 .. coalesce(array_length(p_old, 1), 0) loop
    if position(p_old[i] in d) = 0 then
      raise warning 'r235-0401: % left unchanged (its body is not the known one)', p_fn; return 'skipped'; end if;
  end loop;
  perform public._r401_keep(p_fn);
  for i in 1 .. array_length(p_old, 1) loop
    d := replace(d, p_old[i], p_new[i]);
  end loop;
  begin
    execute d;
  exception when others then
    raise warning 'r235-0401: % not patched (%)', p_fn, sqlerrm;
    return 'skipped';
  end;
  return 'patched';
end $$;

-- ---- 2) the bell window -------------------------------------------------------------------------------------------------
-- Plain (invoker, no settings) on purpose: Postgres then folds it into the query as one value (an index range on
-- notifications (org_id, created_at desc)) instead of calling a function for every row. It reads nothing.
create or replace function public._r401_since()
returns timestamptz language sql stable as $$
  -- r235-0401: the bell / badge / Home unread look at the last 90 days (the Inbox page keeps everything)
  select pg_catalog.now() - interval '90 days';
$$;

-- _r401_vis = the live _r388_vis text, limited to notifications created in the last 90 days (_r401_since) + the ones this
-- person marked unread / snoozed / got back from a snooze in that time. Made from the live text (never typed twice), so
-- the rule cannot drift.
-- null = the live _r388_vis is not the known shape (then nothing is made and the bell keeps its 0388 body).
create or replace function public._r401_vis_def()
returns text language plpgsql stable security definer set search_path = '' as $$
-- r235-0401
declare d text := pg_get_functiondef('public._r388_vis(uuid,uuid)'::regprocedure);
        a1 text := 'CREATE OR REPLACE FUNCTION public._r388_vis(p_org uuid, p_uid uuid)';
        a2 text := '  ), pairs as materialized (';
        a3 text := 'select distinct n.kind, n.channel from public.notifications n where n.org_id = p_org';
        a4 text := '    join public.notifications n on n.org_id = p_org' || chr(10);
        a5 text := 'AS $function$' || chr(10);
begin
  if (length(d) - length(replace(d, a1, ''))) / length(a1) <> 1 or (length(d) - length(replace(d, a2, ''))) / length(a2) <> 1
     or (length(d) - length(replace(d, a3, ''))) / length(a3) <> 1 or (length(d) - length(replace(d, a4, ''))) / length(a4) <> 1
     or (length(d) - length(replace(d, a5, ''))) / length(a5) <> 1 then
    return null; end if;
  d := replace(d, a1, 'CREATE OR REPLACE FUNCTION public._r401_vis(p_org uuid, p_uid uuid)');
  d := replace(d, a5, a5 || '  -- r235-0401: = _r388_vis (made from its live text by _r401_vis_def) limited to the bell window (_r401_since)' || chr(10));
  d := replace(d, a2,
         '  ), wn as materialized (         -- r235-0401: the bell window (_r401_since: the last 90 days) - created since then (index' || chr(10)
      || '                                 -- range), plus older rows this person marked unread / snoozed / got back since then.' || chr(10)
      || '                                 -- Worked out once; of detail only its notify list is read below (a missing one stays' || chr(10)
      || '                                 -- null), so only that is carried - small rows, no sort spilled to disk' || chr(10)
      || '    select n.id, n.kind, n.channel, n.status, n.created_at, n.quote_id,' || chr(10)
      || '           case when n.detail -> ''notify'' is null then null else jsonb_build_object(''notify'', n.detail -> ''notify'') end as detail' || chr(10)
      || '      from public.notifications n where n.org_id = p_org and n.created_at >= public._r401_since()' || chr(10)
      || '    union all' || chr(10)
      || '    select o.id, o.kind, o.channel, o.status, o.created_at, o.quote_id, o.detail' || chr(10)
      || '      from (select st.notification_id from public.notification_inbox_state st' || chr(10)
      || '             where st.user_id = p_uid and st.org_id = p_org' || chr(10)
      || '               and greatest(st.unread_at, st.snoozed_until, st.snooze_returned_at) >= public._r401_since() offset 0) s' || chr(10)
      || '      cross join lateral (select n.id, n.kind, n.channel, n.status, n.created_at, n.quote_id,' || chr(10)
      || '                                 case when n.detail -> ''notify'' is null then null else jsonb_build_object(''notify'', n.detail -> ''notify'') end as detail' || chr(10)
      || '                            from public.notifications n' || chr(10)
      || '                           where n.id = s.notification_id and n.org_id = p_org and n.created_at < public._r401_since() offset 0) o' || chr(10)
      || a2);
  d := replace(d, a3, 'select distinct n.kind, n.channel from wn n');
  d := replace(d, a4, '    join wn n on true' || chr(10));
  return d;
end $$;

-- _r401_rows = the live _r388_rows text on _r401_vis (the same inbox flags for the rows of the window)
create or replace function public._r401_rows_def()
returns text language plpgsql stable security definer set search_path = '' as $$
-- r235-0401
declare d text := pg_get_functiondef('public._r388_rows(uuid,uuid)'::regprocedure);
        a1 text := 'CREATE OR REPLACE FUNCTION public._r388_rows(p_org uuid, p_uid uuid)';
        a2 text := 'from public._r388_vis(p_org, p_uid) v';
        a5 text := 'AS $function$' || chr(10);
begin
  if (length(d) - length(replace(d, a1, ''))) / length(a1) <> 1 or (length(d) - length(replace(d, a2, ''))) / length(a2) <> 1
     or (length(d) - length(replace(d, a5, ''))) / length(a5) <> 1 then
    return null; end if;
  d := replace(d, a1, 'CREATE OR REPLACE FUNCTION public._r401_rows(p_org uuid, p_uid uuid)');
  d := replace(d, a5, a5 || '  -- r235-0401: = _r388_rows (made from its live text by _r401_rows_def) on _r401_vis, the bell window' || chr(10));
  d := replace(d, a2, 'from public._r401_vis(p_org, p_uid) v');
  return d;
end $$;

-- (re)make _r401_vis + _r401_rows from the live _r388_vis / _r388_rows; server only. Safe to call any time.
create or replace function public._r401_sync()
returns text language plpgsql security definer set search_path = '' as $$
-- r235-0401
declare v text := public._r401_vis_def(); r text := public._r401_rows_def(); f text;
begin
  if v is null or r is null then
    raise warning 'r235-0401: _r388_vis / _r388_rows are not the known shape - bell window not made';
    return 'skipped'; end if;
  execute v;
  execute r;
  foreach f in array array['public._r401_vis(uuid,uuid)', 'public._r401_rows(uuid,uuid)'] loop
    execute format('revoke all on function %s from public', f);
    if exists (select 1 from pg_roles where rolname = 'anon') then execute format('revoke all on function %s from anon', f); end if;
    if exists (select 1 from pg_roles where rolname = 'authenticated') then execute format('revoke all on function %s from authenticated', f); end if;
    if exists (select 1 from pg_roles where rolname = 'service_role') then execute format('grant execute on function %s to service_role', f); end if;
  end loop;
  return 'synced';
end $$;

select public._r401_sync();

-- ---- 3) the bell, the Home unread number, the inbox: patched in place (old bodies kept as __pre0401) ------------------------
do $$
declare v_since_ok boolean := to_regprocedure('public._r401_rows(uuid,uuid)') is not null; s text;
begin
  if v_since_ok then
    -- 3a the bell base list + count (bell_feed__pre0042, the r163 / r213 body): only the window
    s := public._r401_patch('public.bell_feed__pre0042(integer)'::regprocedure, 'r235-0401',
      array['declare uid uuid := auth.uid(); org uuid := public.current_org_id();',
            'select distinct n.kind, n.channel from public.notifications n where n.org_id = org' || chr(10),
            '     where n.org_id = org' || chr(10) || '  ), top as (',
            '''unread'', (select count(*) from ok n where n.created_at > seen)',
            'r213-0388'],
      array['declare v_since timestamptz := public._r401_since(); /* r235-0401: the bell window (last 90 days) */ uid uuid := auth.uid(); org uuid := public.current_org_id();',
            'select distinct n.kind, n.channel from public.notifications n where n.org_id = org and n.created_at >= v_since' || chr(10),
            '     where n.org_id = org and n.created_at >= v_since' || chr(10) || '  ), top as (',
            '''unread'', (select count(*) from ok n where n.created_at > seen /* window rows only, r235-0401 */)',
            'r213 (0388)']);
    raise notice 'r235-0401 bell_feed__pre0042: %', s;
    -- 3b the bell inbox layer (bell_feed__pre0299): the person's inbox flags for the window only
    s := public._r401_patch('public.bell_feed__pre0299(integer)'::regprocedure, 'r235-0401',
      array['with r as materialized (select * from public._r388_rows(v_org, v_uid)),', 'r213-0388'],
      array['with r as materialized (select * from public._r401_rows(v_org, v_uid)),   -- r235-0401: the bell window',
            'r213 (0388)']);
    raise notice 'r235-0401 bell_feed__pre0299: %', s;
    -- 3c my_pending: the Home unread number = the bell badge (same window)
    s := public._r401_patch('public.my_pending()'::regprocedure, 'r235-0401',
      array['v_unread := coalesce((public._r23_counts(v_org, v_uid) ->> ''unread'')::integer, 0);'],
      array['v_unread := (select count(*) from public._r401_rows(v_org, v_uid) r where r.is_unread)::integer;   -- r235-0401: the bell window, same number as the bell badge']);
    raise notice 'r235-0401 my_pending: %', s;
  end if;
  -- 3d the Inbox page: flags without details for every row (counts / groups / paging), details only for the page shown
  s := public._r401_patch('public.inbox_feed__pre0299(text,text,uuid,integer,text)'::regprocedure, 'r235-0401',
    array['v_cat jsonb := public.notification_catalog(); v_at timestamptz;',
          '    select x.*, coalesce((select e ->> ''group'' from jsonb_array_elements(v_cat) e where e ->> ''type'' = x.ntype limit 1), ''System'') as grp' || chr(10)
       || '      from public._r23_rows(v_org, v_uid) x',
          '''detail'', p.detail,'],
    array['v_cat jsonb := public.notification_catalog(); v_at timestamptz;' || chr(10)
       || '        -- r235-0401: details are built for the shown page only (_r23_detail = the rule _r23_visible uses)' || chr(10)
       || '        v_qv boolean := (select public._r23_area(v_org, p.role, ''quotes'', ''view'') from public.profiles p where p.id = v_uid and p.org_id = v_org);',
          '    select x.*, coalesce(g.grp, ''System'') as grp' || chr(10)
       || '      from public._r388_rows(v_org, v_uid) x' || chr(10)
       || '      left join (select distinct on (c.e ->> ''type'') c.e ->> ''type'' as ty, c.e ->> ''group'' as grp' || chr(10)
       || '                   from jsonb_array_elements(v_cat) with ordinality c(e, o) order by c.e ->> ''type'', c.o) g on g.ty = x.ntype',
          '''detail'', (select public._r23_detail(nn.detail, v_qv) from public.notifications nn where nn.id = p.id),']);
  raise notice 'r235-0401 inbox_feed__pre0299: %', s;
  -- 3e inbox actions: which of the given rows may this person mark (the same rows, no details built)
  s := public._r401_patch('public.inbox_act(uuid[],text,timestamp with time zone,text)'::regprocedure, 'r235-0401',
    array['from public._r23_visible(v_org, v_uid) v where v.id = any (p_ids)'],
    array['from public._r388_vis(v_org, v_uid) v where v.id = any (p_ids) /* r235-0401: the same rows, no details */']);
  raise notice 'r235-0401 inbox_act: %', s;
  s := public._r401_patch('public.inbox_read_all(text,uuid)'::regprocedure, 'r235-0401',
    array['select x.id from public._r23_rows(v_org, v_uid) x'],
    array['select x.id from public._r388_rows(v_org, v_uid) x /* r235-0401: the same rows + flags, no details */']);
  raise notice 'r235-0401 inbox_read_all: %', s;
end $$;

-- ---- 4) request keys: the same press sent twice is done once ------------------------------------------------------------
create table if not exists public.rpc_request_keys (
  user_id    uuid not null,
  fn         text not null,
  request_id uuid not null,
  args_md5   text not null,
  result     jsonb,
  created_at timestamptz not null default now(),
  constraint rpc_request_keys_pk primary key (user_id, fn, request_id),
  constraint rpc_request_keys_fn_chk check (fn ~ '^[a-z_]{1,60}$')
);
alter table public.rpc_request_keys enable row level security;
revoke all on table public.rpc_request_keys from public;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'anon') then execute 'revoke all on table public.rpc_request_keys from anon'; end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then execute 'revoke all on table public.rpc_request_keys from authenticated'; end if;
end $$;
create index if not exists rpc_request_keys_created_idx on public.rpc_request_keys (created_at);

-- the first answer for (me, call, key), waiting for a concurrent press with the same key; null = new request.
-- the same key with a different request is refused (a page bug must never return another request's answer)
create or replace function public._r401_key_get(p_fn text, p_request uuid, p_md5 text)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
-- r235-0401
declare v_uid uuid := auth.uid(); k record;
begin
  if v_uid is null or p_request is null then return null; end if;
  perform pg_advisory_xact_lock(hashtextextended('helm:r401-once:' || v_uid::text || ':' || p_fn || ':' || p_request::text, 0));
  select r.args_md5, r.result into k from public.rpc_request_keys r
   where r.user_id = v_uid and r.fn = p_fn and r.request_id = p_request;
  if not found then return null; end if;
  if k.args_md5 <> p_md5 then
    raise exception 'This request key was already used for a different request - reload the page and try again'
      using errcode = '22023', hint = 'request_key_reused';
  end if;
  return coalesce(k.result, '{}'::jsonb) || jsonb_build_object('replayed', true);
end $$;

create or replace function public._r401_key_put(p_fn text, p_request uuid, p_md5 text, p_result jsonb)
returns void language plpgsql volatile security definer set search_path = '' as $$
-- r235-0401
declare v_uid uuid := auth.uid();
begin
  if v_uid is null or p_request is null then return; end if;
  insert into public.rpc_request_keys (user_id, fn, request_id, args_md5, result)
    values (v_uid, p_fn, p_request, p_md5, p_result)
  on conflict (user_id, fn, request_id) do nothing;
end $$;

create or replace function public.assign_tasks_once(p_quote_id uuid, p_category text, p_titles text[], p_crew_id uuid,
                                                    p_name text, p_phone text, p_request_id uuid)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
-- r235-0401: assign_tasks with a request key - the same key again answers the first result (nothing created / sent twice)
declare v_md5 text; v jsonb;
begin
  if p_request_id is null then
    return public.assign_tasks(p_quote_id, p_category, p_titles, p_crew_id, p_name, p_phone); end if;
  v_md5 := md5(jsonb_build_array(p_quote_id, p_category, p_titles, p_crew_id, p_name, p_phone)::text);
  v := public._r401_key_get('assign_tasks', p_request_id, v_md5);
  if v is not null then return v; end if;
  v := public.assign_tasks(p_quote_id, p_category, p_titles, p_crew_id, p_name, p_phone);
  perform public._r401_key_put('assign_tasks', p_request_id, v_md5, v);
  return v;
end $$;

create or replace function public.assign_tasks_vendor_once(p_quote_id uuid, p_category text, p_titles text[], p_vendor_id uuid,
                                                           p_request_id uuid)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
-- r235-0401: assign_tasks_vendor with a request key - the same key again answers the first result
declare v_md5 text; v jsonb;
begin
  if p_request_id is null then
    return public.assign_tasks_vendor(p_quote_id, p_category, p_titles, p_vendor_id); end if;
  v_md5 := md5(jsonb_build_array(p_quote_id, p_category, p_titles, p_vendor_id)::text);
  v := public._r401_key_get('assign_tasks_vendor', p_request_id, v_md5);
  if v is not null then return v; end if;
  v := public.assign_tasks_vendor(p_quote_id, p_category, p_titles, p_vendor_id);
  perform public._r401_key_put('assign_tasks_vendor', p_request_id, v_md5, v);
  return v;
end $$;

-- the other "create + send" presses of the pages: ping a task's person (bell), nudge a client who opened a link, send a
-- payment reminder now. (Invite a team member is already safe twice: create_invitation answers the same pending invite.) Same rule: same key again = the first answer, nothing sent twice.
create or replace function public.event_task_remind_bell_once(p_task uuid, p_request_id uuid)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
-- r235-0401: event_task_remind_bell with a request key
declare v_md5 text; v jsonb;
begin
  if p_request_id is null then return public.event_task_remind_bell(p_task); end if;
  v_md5 := md5(jsonb_build_array(p_task)::text);
  v := public._r401_key_get('event_task_remind_bell', p_request_id, v_md5);
  if v is not null then return v; end if;
  v := public.event_task_remind_bell(p_task);
  perform public._r401_key_put('event_task_remind_bell', p_request_id, v_md5, v);
  return v;
end $$;

create or replace function public.link_view_nudge_once(p_quote uuid, p_channel text, p_request_id uuid)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
-- r235-0401: link_view_nudge with a request key
declare v_md5 text; v jsonb;
begin
  if p_request_id is null then return public.link_view_nudge(p_quote, p_channel); end if;
  v_md5 := md5(jsonb_build_array(p_quote, p_channel)::text);
  v := public._r401_key_get('link_view_nudge', p_request_id, v_md5);
  if v is not null then return v; end if;
  v := public.link_view_nudge(p_quote, p_channel);
  perform public._r401_key_put('link_view_nudge', p_request_id, v_md5, v);
  return v;
end $$;

create or replace function public.payment_reminder_send_now_once(p_milestone uuid, p_request_id uuid)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
-- r235-0401: payment_reminder_send_now with a request key
declare v_md5 text; v jsonb;
begin
  if p_request_id is null then return public.payment_reminder_send_now(p_milestone); end if;
  v_md5 := md5(jsonb_build_array(p_milestone)::text);
  v := public._r401_key_get('payment_reminder_send_now', p_request_id, v_md5);
  if v is not null then return v; end if;
  v := public.payment_reminder_send_now(p_milestone);
  perform public._r401_key_put('payment_reminder_send_now', p_request_id, v_md5, v);
  return v;
end $$;

-- ---- 4b) time zone names: the 0358 copy gets any name this server knows that is not in it yet (insert only). A studio
-- time zone found in the copy is answered without reading the time zone files (~0.5 s on Nano); same answers.
do $$ begin
  if to_regclass('public._r358_tz_names') is not null then
    insert into public._r358_tz_names(name) select distinct z.name from pg_catalog.pg_timezone_names z on conflict (name) do nothing;
  end if;
end $$;

-- ---- 5) frequent background jobs: give up on a lock after 10 s (per function; role / database settings untouched) --------
do $$
declare f text;
begin
  foreach f in array array['public.quote_stage_sweep(integer)', 'public.link_views_tick()', 'public.apply_link_expiry_archive_all()',
                           'public.discard_empty_drafts_all()', 'public.event_ready_alert_tick()', 'public.team_safety_tick()',
                           'public.pay_details_tick()'] loop
    if to_regprocedure(f) is null then raise notice 'r235-0401: % not on this database - skipped', f; continue; end if;
    execute format('alter function %s set lock_timeout = %L', f, '10s');
  end loop;
end $$;

-- ---- 6) grants: helpers server only; the two new page calls for signed-in people only -------------------------------------
do $$
declare f text;
begin
  foreach f in array array['public._r401_keep(regprocedure)', 'public._r401_patch(regprocedure,text,text[],text[])',
                           'public._r401_since()', 'public._r401_vis_def()', 'public._r401_rows_def()', 'public._r401_sync()',
                           'public._r401_key_get(text,uuid,text)', 'public._r401_key_put(text,uuid,text,jsonb)',
                           'public.assign_tasks_once(uuid,text,text[],uuid,text,text,uuid)',
                           'public.assign_tasks_vendor_once(uuid,text,text[],uuid,uuid)', 
                           'public.event_task_remind_bell_once(uuid,uuid)', 'public.link_view_nudge_once(uuid,text,uuid)',
                           'public.payment_reminder_send_now_once(uuid,uuid)'] loop
    execute format('revoke all on function %s from public', f);
    if exists (select 1 from pg_roles where rolname = 'anon') then execute format('revoke all on function %s from anon', f); end if;
    if exists (select 1 from pg_roles where rolname = 'authenticated') then execute format('revoke all on function %s from authenticated', f); end if;
  end loop;
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    execute 'grant execute on function public._r401_since() to service_role';
  end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    execute 'grant execute on function public.assign_tasks_once(uuid,text,text[],uuid,text,text,uuid) to authenticated';
    execute 'grant execute on function public.assign_tasks_vendor_once(uuid,text,text[],uuid,uuid) to authenticated';
    execute 'grant execute on function public.event_task_remind_bell_once(uuid,uuid) to authenticated';
    execute 'grant execute on function public.link_view_nudge_once(uuid,text,uuid) to authenticated';
    execute 'grant execute on function public.payment_reminder_send_now_once(uuid,uuid) to authenticated';
  end if;
end $$;

notify pgrst, 'reload schema';

-- ---- checks (every ok must be true) -------------------------------------------------------------------------------------
select item, ok from (values
  ('01 the bell window exists and is exactly the live inbox rule (_r388_vis / _r388_rows) limited to 90 days',
     to_regprocedure('public._r401_vis(uuid,uuid)') is not null and to_regprocedure('public._r401_rows(uuid,uuid)') is not null
     and pg_get_functiondef('public._r401_vis(uuid,uuid)'::regprocedure) = public._r401_vis_def()
     and pg_get_functiondef('public._r401_rows(uuid,uuid)'::regprocedure) = public._r401_rows_def()),
  ('02 the bell, the Home unread number and the Inbox page use the new bodies (6 of 6; false = a body was not the known one, left as it was)',
     (select count(*) from pg_proc p where p.oid in (to_regprocedure('public.bell_feed__pre0042(integer)'), to_regprocedure('public.bell_feed__pre0299(integer)'),
        to_regprocedure('public.my_pending()'), to_regprocedure('public.inbox_feed__pre0299(text,text,uuid,integer,text)'),
        to_regprocedure('public.inbox_act(uuid[],text,timestamp with time zone,text)'), to_regprocedure('public.inbox_read_all(text,uuid)'))
        and position('r235-0401' in p.prosrc) > 0) = 6),
  ('03 the old bodies are kept once as __pre0401, with no app privilege (6)',
     (select count(*) from pg_proc p where p.oid in (to_regprocedure('public.bell_feed__pre0042__pre0401(integer)'), to_regprocedure('public.bell_feed__pre0299__pre0401(integer)'),
        to_regprocedure('public.my_pending__pre0401()'), to_regprocedure('public.inbox_feed__pre0299__pre0401(text,text,uuid,integer,text)'),
        to_regprocedure('public.inbox_act__pre0401(uuid[],text,timestamp with time zone,text)'), to_regprocedure('public.inbox_read_all__pre0401(text,uuid)'))
        and not has_function_privilege('authenticated', p.oid, 'execute') and not has_function_privilege('anon', p.oid, 'execute')
        and position('r235-0401' in p.prosrc) = 0) = 6),
  ('04 rpc_request_keys: row security on, no policy, no app access',
     to_regclass('public.rpc_request_keys') is not null
     and (select c.relrowsecurity from pg_class c where c.oid = to_regclass('public.rpc_request_keys'))
     and not exists (select 1 from pg_policies p where p.schemaname = 'public' and p.tablename = 'rpc_request_keys')
     and not has_table_privilege('authenticated', 'public.rpc_request_keys', 'select')
     and not has_table_privilege('authenticated', 'public.rpc_request_keys', 'insert')
     and not has_table_privilege('anon', 'public.rpc_request_keys', 'select')),
  ('05 the five _once calls exist; signed-in users may run them, anon may not',
     (select count(*) from unnest(array['public.assign_tasks_once(uuid,text,text[],uuid,text,text,uuid)', 'public.assign_tasks_vendor_once(uuid,text,text[],uuid,uuid)',
        'public.event_task_remind_bell_once(uuid,uuid)', 'public.link_view_nudge_once(uuid,text,uuid)', 'public.payment_reminder_send_now_once(uuid,uuid)']) f
       where to_regprocedure(f) is not null and has_function_privilege('authenticated', f, 'execute') and not has_function_privilege('anon', f, 'execute')) = 5),
  ('06 the 0401 helpers are server only (signed-in users and anon may not run them)',
     (select count(*) from unnest(array['public._r401_keep(regprocedure)', 'public._r401_patch(regprocedure,text,text[],text[])', 'public._r401_since()',
        'public._r401_vis_def()', 'public._r401_rows_def()', 'public._r401_sync()', 'public._r401_key_get(text,uuid,text)', 'public._r401_key_put(text,uuid,text,jsonb)',
        'public._r401_vis(uuid,uuid)', 'public._r401_rows(uuid,uuid)']) f
       where to_regprocedure(f) is not null and not has_function_privilege('authenticated', f, 'execute') and not has_function_privilege('anon', f, 'execute')) = 10),
  ('07 every new function is security definer with an empty pinned search_path (except the plain one-line _r401_since)',
     (select bool_and(p.prosecdef and coalesce(array_to_string(p.proconfig, ','), '') like '%search_path=""%')
        from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'public' and (p.proname like '\_r401\_%' or p.proname like '%\_once') and p.proname <> '_r401_since'
         and p.proname not like '%\_\_pre%')),
  ('08 the background jobs on this database carry lock_timeout=10s (role / database settings unchanged)',
     not exists (select 1 from unnest(array['public.quote_stage_sweep(integer)', 'public.link_views_tick()', 'public.apply_link_expiry_archive_all()',
        'public.discard_empty_drafts_all()', 'public.event_ready_alert_tick()', 'public.team_safety_tick()', 'public.pay_details_tick()']) f
       where to_regprocedure(f) is not null
         and not coalesce((select p.proconfig from pg_proc p where p.oid = to_regprocedure(f)), '{}') @> array['lock_timeout=10s'])),
  ('09 the time zone name copy holds every name this server knows',
     to_regclass('public._r358_tz_names') is null
     or not exists (select 1 from pg_catalog.pg_timezone_names z where not exists (select 1 from public._r358_tz_names t where t.name = z.name)))
) v(item, ok) order by item;
commit;
