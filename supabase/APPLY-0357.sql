-- APPLY-0357 (R163 bell, inbox, pending counter and Continue quotes speed fix). Run on STAGING first, then production. Safe to run twice.
-- Re-issues three read-only functions, keeps their old bodies. Nothing is changed or deleted. If it stops with a STOP message nothing was applied.
begin;
-- 0357_r163_bell_type_once.sql - R163 bell / inbox / pending counts speed fix. Forward-only, additive, safe to run twice.
-- REQUIRES 0036 (bell_feed__pre0042 = the 0036 bell), 0266 + 0293 (_r23_visible), 0354 (notification_type_of chain), 0356.
--
-- In plain words:
--   Prod 12 Nov (after the R152..R162 release): almost every signed-in page was slow on every device. The bell
--   (bell_feed, asked on every page and again every 30 seconds by every open tab), the inbox and the Home "pending"
--   counter (my_pending) worked out the notification TYPE of EVERY notification row of the studio by calling
--   notification_type_of(kind, channel) once per row - up to 3 times per row in _r23_visible. That function is a chain of
--   12 wrapped SECURITY DEFINER functions (0036 ... 0329, + 0354 for wa_templates), so Postgres cannot inline it and each
--   call costs about 0.1 ms. Measured on a copy with 50,000 notifications in one studio: bell_feed 31 s, my_pending 21 s
--   (a laptop - a Nano database is many times slower), so the bell polls kept the small prod database busy and every
--   other page query waited behind them.
--   The type only depends on (kind, channel) and notification_type_of is IMMUTABLE, so it is now worked out ONCE per
--   distinct (kind, channel) pair of the studio (a few dozen) and joined back to the rows: the same rows, the same type,
--   the same counts and order - only faster (50,000 rows: bell_feed 31 s -> well under a second).
--   1  _r23_visible (inbox rows: bell badge, inbox, my_pending)  - type once per pair, every rule unchanged
--   2  bell_feed__pre0042 (the 0036 bell list + unread count)    - type once per pair, every rule unchanged
--   3  my_open_quotes (0356, Continue quotes on Home / Quotes / workspace) - the ~8-lookup step count (_flow_steps_done)
--      only for the rows of the page and for an empty quote whose listing depends on it, not for every open quote
--
-- ZERO DATA LOSS: three read-only functions re-issued in place (same names, arguments, answer shapes, STABLE SECURITY DEFINER,
-- empty search_path, grants). The previous bodies are kept once as _r23_visible__pre0357 and bell_feed__pre0042__pre0357
-- with no app privilege (and my_open_quotes__pre0357, the 0356 body). A body that is not the known one on this database is left unchanged (NOTICE). No table, column,
-- row, policy or grant is changed or deleted. Rollback: drop the new function and rename the kept copy back.
-- Notes: supabase/migrations/MANIFEST entry 0357.

-- ---- 0) preflight ---------------------------------------------------------------------------------------------------
do $$
begin
  if to_regclass('public.notifications') is null or to_regprocedure('public.notification_type_of(text,text)') is null then
    raise exception 'STOP 0357: notifications / notification_type_of missing - this is not a Helm database'; end if;
  if to_regprocedure('public._r23_visible(uuid,uuid)') is null or to_regprocedure('public.bell_feed__pre0042(integer)') is null then
    raise exception 'STOP 0357: _r23_visible (0266) or bell_feed__pre0042 (0036 bell) missing - run 0266 + 0293 first'; end if;
end $$;

-- ---- 1) keep the old bodies once (only the known bodies are replaced) -------------------------------------------------
do $$
declare v_src text;
begin
  select p.prosrc into v_src from pg_proc p where p.oid = to_regprocedure('public._r23_visible(uuid,uuid)');
  if position('r163-0357' in v_src) = 0 then
    if position('r52-notif-0293' in v_src) > 0 and position('cross join lateral (select public.notification_type_of(n.kind, n.channel) as ty) t' in v_src) > 0
       and to_regprocedure('public._r23_visible__pre0357(uuid,uuid)') is null then
      alter function public._r23_visible(uuid, uuid) rename to _r23_visible__pre0357;
    elsif to_regprocedure('public._r23_visible__pre0357(uuid,uuid)') is null then
      raise notice '0357: _r23_visible is not the known 0293 body on this database - left unchanged';
    end if;
  end if;
  select p.prosrc into v_src from pg_proc p where p.oid = to_regprocedure('public.bell_feed__pre0042(integer)');
  if position('r163-0357' in v_src) = 0 then
    if position('notification-prefs-0036' in v_src) > 0 and position('not (public.notification_type_of(n.kind, n.channel) = any (v_hidden))' in v_src) > 0
       and to_regprocedure('public.bell_feed__pre0042__pre0357(integer)') is null then
      alter function public.bell_feed__pre0042(integer) rename to bell_feed__pre0042__pre0357;
    elsif to_regprocedure('public.bell_feed__pre0042__pre0357(integer)') is null then
      raise notice '0357: bell_feed__pre0042 is not the known 0036 body on this database - left unchanged';
    end if;
  end if;
end $$;

-- ---- 2) _r23_visible: the 0293 rules, the type worked out once per (kind, channel) pair ---------------------------------
-- The detail of each row: the 0266 _r23_detail rule written out in place (that helper is SECURITY DEFINER with its own
-- search_path, so Postgres paid a settings switch for every row). Used only while _r23_detail is still the known 0266
-- body on this database; otherwise the helper itself is called as before.
do $do$
declare v_det text := 'public._r23_detail(n.detail, me.qv)';
begin
  -- create when renamed above; re-issue when the live body is again the known old one (its old body is already kept)
  if to_regprocedure('public._r23_visible(uuid,uuid)') is not null and (position('r163-0357' in coalesce((select p.prosrc from pg_proc p where p.oid = to_regprocedure('public._r23_visible(uuid,uuid)')), '')) > 0
     or position('r52-notif-0293' in coalesce((select p.prosrc from pg_proc p where p.oid = to_regprocedure('public._r23_visible(uuid,uuid)')), '')) = 0) then return; end if;
  if position('r23-inbox-0266' in coalesce((select p.prosrc from pg_proc p where p.oid = to_regprocedure('public._r23_detail(jsonb,boolean)')), '')) > 0
     and position('public._a42_redact_detail(p)' in coalesce((select p.prosrc from pg_proc p where p.oid = to_regprocedure('public._r23_detail(jsonb,boolean)')), '')) > 0
     and to_regprocedure('public._a42_redact_detail(jsonb)') is not null and to_regprocedure('public._a153_money_key(text)') is not null then
    v_det := $d$(select case when jsonb_typeof(dd.d) <> 'object' or me.qv then dd.d
        else coalesce((select jsonb_object_agg(e.k, e.v) from jsonb_each(dd.d) e(k, v)
                        where not public._a153_money_key(e.k)
                          and not (e.k = 'message' and coalesce(e.v #>> '{}', '') ~* '(price|total|amount|paid|rs\.|inr)')), '{}'::jsonb) end
        from (select public._a42_redact_detail(n.detail) as d) dd)$d$;
  end if;
  execute replace($fn$
create or replace function public._r23_visible(p_org uuid, p_uid uuid)
returns table(id uuid, kind text, channel text, status text, detail jsonb, created_at timestamptz, quote_id uuid, ntype text)
language sql stable security definer set search_path = '' as $$
  -- r23-inbox-0266 + r24-ci-0270 ("me" materialized) + r52-notif-0293 rules unchanged; r163-0357: notification_type_of (IMMUTABLE) worked out ONCE per distinct
  -- (kind, channel) pair of the studio instead of up to 3 times per notification row
  with me as materialized (
    select public._r23_area(p_org, p.role, 'quotes', 'view') as qv,
           public._r23_area(p_org, p.role, 'quotes', 'edit') as qe,
           (coalesce(p.role, '') in ('admin', 'manager', 'coordinator') or public._r23_area(p_org, p.role, 'closure', 'view')) as cl,
           (coalesce(p.role, '') = 'admin') as adm,
           coalesce(public._notify_hidden_types(p_org, p_uid), '{}'::text[]) as hid,
           coalesce((select array_agg(m.type) from public.notification_mutes m where m.user_id = p_uid and m.org_id = p_org), '{}'::text[]) as mut
      from public.profiles p
     where p.id = p_uid and p.org_id = p_org and p_org is not null
  ), pairs as materialized (       -- materialized: the type is never pushed down to every row
    select distinct n.kind, n.channel from public.notifications n where n.org_id = p_org
  ), ty as materialized (
    select k.kind, k.channel, (k.kind is null) as kn, (k.channel is null) as cn,
           public.notification_type_of(k.kind, k.channel) as ty
      from pairs k
  )
  select n.id, n.kind, n.channel, n.status, @@DETAIL@@, n.created_at, n.quote_id, t.ty
    from me
    join public.notifications n on n.org_id = p_org
    join ty t on coalesce(t.kind, '') = coalesce(n.kind, '') and t.kn = (n.kind is null)
             and coalesce(t.channel, '') = coalesce(n.channel, '') and t.cn = (n.channel is null)
   where coalesce(n.kind, '') <> 'security_alert'
     and not (t.ty = any (me.hid))
     and not (t.ty = any (me.mut))
     and (me.qe or coalesce(n.kind, '') <> 'price_change')
     and (me.qv or coalesce(n.kind, '') !~ '(price|reapproval|payment|refund|invoice|bill|settle|pkg_pay|quote_|discount|budget)')
     and (me.cl or coalesce(n.kind, '') not in ('event_close_request', 'event_close_decision'))
     and (me.adm
          or coalesce(n.kind, '') not in ('client_link_viewed', 'client_view_followup')
          or (me.qv
              and not (n.kind = 'client_view_followup'
                       and jsonb_typeof(n.detail -> 'notify') = 'array'
                       and jsonb_array_length(n.detail -> 'notify') > 0
                       and not ((n.detail -> 'notify') ? p_uid::text))));
$$
  $fn$, '@@DETAIL@@', v_det);
end $do$;

-- ---- 3) bell_feed__pre0042: the 0036 bell, the type worked out once per (kind, channel) pair ----------------------------
do $do$
begin
  -- create when renamed above; re-issue when the live body is again the known old one (its old body is already kept)
  if to_regprocedure('public.bell_feed__pre0042(integer)') is not null and (position('r163-0357' in coalesce((select p.prosrc from pg_proc p where p.oid = to_regprocedure('public.bell_feed__pre0042(integer)')), '')) > 0
     or position('notification-prefs-0036' in coalesce((select p.prosrc from pg_proc p where p.oid = to_regprocedure('public.bell_feed__pre0042(integer)')), '')) = 0) then return; end if;
  execute $fn$
create or replace function public.bell_feed__pre0042(p_limit integer default 20)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
-- notification-prefs-0036: types switched off for the caller are hidden; no recipient column
-- r163-0357: same list + count; a (kind, channel) pair is shown when not (notification_type_of(kind, channel) = any (hidden))
-- is true - worked out ONCE per distinct pair of the studio instead of twice per notification row
declare uid uuid := auth.uid(); org uuid := public.current_org_id(); seen timestamptz; result jsonb; v_hidden text[];
begin
  if uid is null then raise exception 'not authenticated' using errcode = '42501'; end if;
  select s.last_seen_at into seen from public.notification_seen s where s.user_id = uid;
  seen := coalesce(seen, 'epoch'::timestamptz);
  v_hidden := public._notify_hidden_types(org, uid);
  with pairs as materialized (     -- materialized: the type check below must not be pushed down to every row
    select distinct n.kind, n.channel from public.notifications n where n.org_id = org
  ), shown as materialized (
    select k.kind, k.channel, (k.kind is null) as kn, (k.channel is null) as cn
      from pairs k
     where coalesce(not (public.notification_type_of(k.kind, k.channel) = any (v_hidden)), false)
  ), ok as (
    select n.* from public.notifications n
      join shown t on coalesce(t.kind, '') = coalesce(n.kind, '') and t.kn = (n.kind is null)
                  and coalesce(t.channel, '') = coalesce(n.channel, '') and t.cn = (n.channel is null)
     where n.org_id = org
  ), recent as (
    select n.id, n.kind, n.channel, n.status, n.detail, n.created_at, n.quote_id,
           q.code as event_code, q.title as event_title, (n.created_at > seen) as unread
      from ok n
      left join public.quotes q on q.id = n.quote_id
     order by n.created_at desc
     limit greatest(1, least(coalesce(p_limit, 20), 100))
  )
  select jsonb_build_object(
    'items',  coalesce((select jsonb_agg(to_jsonb(recent) order by recent.created_at desc) from recent), '[]'::jsonb),
    'unread', (select count(*) from ok n where n.created_at > seen)
  ) into result;
  return result;
end $$
  $fn$;
end $do$;

-- ---- 4) privileges - exactly as before (internal helpers: no app role), the kept bodies for nobody ----------------------
do $$ declare f text; r text; begin
  foreach f in array array['public._r23_visible(uuid, uuid)', 'public.bell_feed__pre0042(integer)',
                           'public._r23_visible__pre0357(uuid, uuid)', 'public.bell_feed__pre0042__pre0357(integer)'] loop
    continue when to_regprocedure(f) is null;
    execute 'revoke all on function ' || f || ' from public';
    foreach r in array array['anon', 'authenticated'] loop
      if exists (select 1 from pg_roles where rolname = r) then execute format('revoke all on function %s from %I', f, r); end if;
    end loop;
  end loop;
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    foreach f in array array['public._r23_visible(uuid, uuid)', 'public.bell_feed__pre0042(integer)'] loop
      continue when to_regprocedure(f) is null;
      execute 'grant execute on function ' || f || ' to service_role';
    end loop;
    foreach f in array array['public._r23_visible__pre0357(uuid, uuid)', 'public.bell_feed__pre0042__pre0357(integer)'] loop
      continue when to_regprocedure(f) is null;
      execute 'revoke all on function ' || f || ' from service_role';
    end loop;
  end if;
end $$;

-- ---- 5) my_open_quotes (0356): the step count only where it is needed ---------------------------------------------------
-- 0356 worked out _flow_steps_done (about 8 lookups) for EVERY open quote of the studio on every Home / Quotes / workspace
-- open, although it decides the listing only for an empty "building" quote nobody has stepped into yet, and is shown only
-- for the 5 - 20 rows of the page. Now: same filter (the count is asked only for such a quote), same order, total and
-- rows; the step count is worked out for the rows of the page only. 0356 body kept once as my_open_quotes__pre0357.
do $do$
declare v_src text := coalesce((select p.prosrc from pg_proc p where p.oid = to_regprocedure('public.my_open_quotes(text,integer,integer,uuid,integer)')), '');
begin
  if position('r163-0357' in v_src) > 0 then return; end if;
  if position('open-quotes-0356' in v_src) = 0 then
    raise notice '0357: my_open_quotes is not the known 0356 body on this database - left unchanged'; return; end if;
  -- keep the 0356 body once (a later re-run of 0356 that put it back is simply re-issued: its body is already kept)
  if to_regprocedure('public.my_open_quotes__pre0357(text,integer,integer,uuid,integer)') is null then
    alter function public.my_open_quotes(text, int, int, uuid, int) rename to my_open_quotes__pre0357;
  end if;
  execute $fn$
create or replace function public.my_open_quotes(p_scope text default 'mine', p_limit int default 20, p_offset int default 0,
                                                 p_quote uuid default null, p_max_days int default null)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
-- open-quotes-0356 newest activity first (own save or anyone last flow step), ties by created time
-- r163-0357: the same list; the step count (_flow_steps_done, ~8 lookups) only for a quote whose listing depends on it
-- and for the rows of the page asked for - not for every open quote of the studio
declare
  v_uid uuid := auth.uid(); v_org uuid := public.current_org_id();
  v_scope text := lower(btrim(coalesce(p_scope, 'mine')));
  v_lim int := greatest(1, least(coalesce(p_limit, 20), 100));
  v_off int := greatest(0, least(coalesce(p_offset, 0), 100000));
  v_edit boolean := false; v_locked boolean := false; v_total int := 0; v_rows jsonb := '[]'::jsonb;
begin
  if v_uid is null or v_org is null or not coalesce(public.has_area('quotes', 'view'), false) then
    return jsonb_build_object('total', 0, 'rows', '[]'::jsonb, 'can_edit', false, 'steps_total', 8, 'open', true);
  end if;
  if v_scope not in ('mine', 'studio') then raise exception 'scope must be mine or studio' using errcode = '22023'; end if;
  if p_max_days is not null and (p_max_days < 1 or p_max_days > 3650) then
    raise exception 'max_days must be 1 to 3650' using errcode = '22023';
  end if;
  v_edit := coalesce(public.has_area('quotes', 'edit'), false);
  begin
    if to_regprocedure('public._studio_writable(uuid)') is not null then
      execute 'select not public._studio_writable($1)' into v_locked using v_org;
    end if;
    if not coalesce(v_locked, false) and to_regprocedure('public._trial_locked(uuid)') is not null then
      execute 'select coalesce(public._trial_locked($1), false)' into v_locked using v_org;
    end if;
  exception when others then v_locked := false;
  end;

  with base as (
    select q.id, q.code, q.title, q.event_type, q.event_date, q.client, q.updated_at, q.created_at,
           case when coalesce(q.approval_status, 'none') = 'sent' then 'sent'
                when coalesce(q.status, 'quote') = 'confirmed' then 'locked'
                when exists (select 1 from public.quotation_versions qv where qv.quote_id = q.id) then 'quoted'
                else 'building' end as phase,
           (coalesce(btrim(q.client ->> 'name'), '') <> '' or coalesce(btrim(q.event_type), '') <> '' or q.event_date is not null
            or not (coalesce(btrim(q.title), '') in ('', 'Untitled event') or btrim(q.title) = btrim(coalesce(q.code, ''))
                    or btrim(q.title) ~ '^[0-9]{8}-[0-9]{2,}$')) as filled
      from public.quotes q
     where q.org_id = v_org and (p_quote is null or q.id = p_quote)
       and q.deleted_at is null and q.archived_at is null and q.auto_discarded_at is null
       and coalesce(q.status, 'quote') in ('quote', 'confirmed')
       and coalesce(q.lifecycle_stage, 'quote') in ('lead', 'discovery', 'proposal', 'quote')
       and coalesce(q.approval_status, 'none') in ('none', 'sent')
       and not coalesce(q.is_demo, false)
  ), x as (
    select b.*, me.last_step as my_step, me.last_step_at as my_step_at, me.dismissed_at as my_dismissed_at,
           lst.user_id as last_user, lst.last_step, lst.last_step_at, cr.created_by
      from base b
      left join lateral (select fp.last_step, fp.last_step_at, fp.dismissed_at from public.quote_flow_progress fp
                          where fp.quote_id = b.id and fp.user_id = v_uid and fp.org_id = v_org) me on true
      left join lateral (select fp.user_id, fp.last_step, fp.last_step_at from public.quote_flow_progress fp
                          where fp.quote_id = b.id and fp.org_id = v_org and fp.last_step is not null
                          order by fp.last_step_at desc, fp.user_id limit 1) lst on true
      left join lateral (select v.created_by from public.quote_versions v where v.quote_id = b.id and v.version_no = 1
                          order by v.created_at limit 1) cr on true
  ), y as (
    select x.*, greatest(x.updated_at, x.last_step_at, x.my_step_at) as activity
      from x
     where (case when x.phase <> 'building' or x.filled or x.last_user is not null then true
                 else cardinality(public._flow_steps_done(x.id)) > 0 end)
       and (v_scope = 'studio'
            or (x.my_dismissed_at is null
                and (x.my_step is not null or (x.last_user is null and x.created_by = v_uid))))
  ), z as (
    select y.* from y where p_max_days is null or y.activity > now() - make_interval(days => p_max_days)
  )
  select (select count(*) from z),
         coalesce((select jsonb_agg(r0.r order by r0.ord) from (
           select z.ord,
                  jsonb_strip_nulls(jsonb_build_object(
                    'id', z.id, 'code', z.code, 'title', z.title, 'event_type', z.event_type, 'event_date', z.event_date,
                    'phase', z.phase,
                    'client', jsonb_strip_nulls(jsonb_build_object(
                       'name', nullif(btrim(coalesce(z.client ->> 'name', '')), ''),
                       'city', case when jsonb_typeof(z.client -> 'city') = 'string' then z.client ->> 'city' end,
                       'venue', case when jsonb_typeof(z.client -> 'venue') = 'string' then z.client ->> 'venue' end,
                       'guests', case when jsonb_typeof(z.client -> 'guests') in ('number', 'string') then z.client -> 'guests' end,
                       'eventDate', case when jsonb_typeof(z.client -> 'eventDate') = 'string' then z.client ->> 'eventDate' end)),
                    'my_step', z.my_step, 'my_step_at', z.my_step_at,
                    'last_step', z.last_step, 'last_step_at', z.last_step_at,
                    'last_user_id', z.last_user, 'last_by_me', (z.last_user = v_uid),
                    'last_user_name', (select coalesce(nullif(btrim(p.full_name), ''), nullif(split_part(coalesce(p.email, ''), '@', 1), ''))
                                         from public.profiles p where p.id = z.last_user and p.org_id = v_org),
                    'created_by_me', (z.created_by = v_uid),
                    'hidden', (z.my_dismissed_at is not null),
                    'steps_done', to_jsonb(public._flow_steps_done(z.id)), 'steps_total', 8,
                    'activity', z.activity, 'updated_at', z.updated_at, 'created_at', z.created_at)) as r
             from (select z.*, row_number() over (order by z.activity desc nulls last, z.created_at desc nulls last, z.id) as ord
                     from z order by z.activity desc nulls last, z.created_at desc nulls last, z.id
                    limit v_lim offset v_off) z) r0(ord, r)), '[]'::jsonb)
    into v_total, v_rows;

  return jsonb_build_object('total', v_total, 'rows', v_rows, 'can_edit', v_edit and not coalesce(v_locked, false),
                            'read_only', coalesce(v_locked, false), 'steps_total', 8, 'scope', v_scope, 'open', true);
end $$;
  $fn$;
end $do$;
do $$ declare r text; begin
  if to_regprocedure('public.my_open_quotes(text,integer,integer,uuid,integer)') is not null then
    execute 'revoke all on function public.my_open_quotes(text, int, int, uuid, int) from public';
    if exists (select 1 from pg_roles where rolname = 'anon') then
      execute 'revoke all on function public.my_open_quotes(text, int, int, uuid, int) from anon'; end if;
    if exists (select 1 from pg_roles where rolname = 'authenticated') then
      execute 'grant execute on function public.my_open_quotes(text, int, int, uuid, int) to authenticated'; end if;
  end if;
  if to_regprocedure('public.my_open_quotes__pre0357(text,integer,integer,uuid,integer)') is not null then
    execute 'revoke all on function public.my_open_quotes__pre0357(text, int, int, uuid, int) from public';
    foreach r in array array['anon', 'authenticated', 'service_role'] loop
      if exists (select 1 from pg_roles where rolname = r) then
        execute format('revoke all on function public.my_open_quotes__pre0357(text, int, int, uuid, int) from %I', r); end if;
    end loop;
  end if;
end $$;

notify pgrst, 'reload schema';
commit;

-- VERIFY every line should say true
select item, ok from (values
  ('01 _r23_visible is the 0357 version (type once per kind + channel pair)', position('r163-0357' in coalesce((select p.prosrc from pg_proc p where p.oid = to_regprocedure('public._r23_visible(uuid,uuid)')), '')) > 0),
  ('02 bell_feed__pre0042 is the 0357 version', position('r163-0357' in coalesce((select p.prosrc from pg_proc p where p.oid = to_regprocedure('public.bell_feed__pre0042(integer)')), '')) > 0),
  ('03 the old bodies are kept once', to_regprocedure('public._r23_visible__pre0357(uuid,uuid)') is not null and to_regprocedure('public.bell_feed__pre0042__pre0357(integer)') is not null),
  ('04 nobody may run the kept bodies', coalesce(not has_function_privilege('authenticated', to_regprocedure('public._r23_visible__pre0357(uuid,uuid)'), 'execute') and not has_function_privilege('anon', to_regprocedure('public._r23_visible__pre0357(uuid,uuid)'), 'execute') and not has_function_privilege('authenticated', to_regprocedure('public.bell_feed__pre0042__pre0357(integer)'), 'execute') and not has_function_privilege('anon', to_regprocedure('public.bell_feed__pre0042__pre0357(integer)'), 'execute'), false)),
  ('05 both are security definer with an empty search_path', coalesce((select bool_and(p.prosecdef and 'search_path=""' = any(p.proconfig)) from pg_proc p where p.oid in (to_regprocedure('public._r23_visible(uuid,uuid)'), to_regprocedure('public.bell_feed__pre0042(integer)'))), false)),
  ('06 the bell is still open to signed-in users only', coalesce(has_function_privilege('authenticated', to_regprocedure('public.bell_feed(integer)'), 'execute') and not has_function_privilege('anon', to_regprocedure('public.bell_feed(integer)'), 'execute'), false)),
  ('08 my_open_quotes is the 0357 version, the 0356 body kept with no privilege', position('r163-0357' in coalesce((select p.prosrc from pg_proc p where p.oid = to_regprocedure('public.my_open_quotes(text,integer,integer,uuid,integer)')), '')) > 0 and to_regprocedure('public.my_open_quotes__pre0357(text,integer,integer,uuid,integer)') is not null and not has_function_privilege('authenticated', to_regprocedure('public.my_open_quotes__pre0357(text,integer,integer,uuid,integer)'), 'execute') and has_function_privilege('authenticated', to_regprocedure('public.my_open_quotes(text,integer,integer,uuid,integer)'), 'execute') and not has_function_privilege('anon', to_regprocedure('public.my_open_quotes(text,integer,integer,uuid,integer)'), 'execute')),
  ('07 the helpers stay internal (no signed-in or anon call)', coalesce(not has_function_privilege('authenticated', to_regprocedure('public._r23_visible(uuid,uuid)'), 'execute') and not has_function_privilege('anon', to_regprocedure('public.bell_feed__pre0042(integer)'), 'execute'), false))
) v(item, ok) order by item;
