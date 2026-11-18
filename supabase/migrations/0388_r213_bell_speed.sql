-- 0388_r213_bell_speed.sql - R213 bell / inbox / pending speed (prod pg_stat_statements, 18 Nov 2026). Forward-only,
-- additive, safe to run twice. ASCII only.
-- REQUIRES 0266 + 0293 + 0357 (the inbox rule, kept as _r23_visible__pre0369 by 0369), 0369 / 0373 / 0383 (the newest
--          _r23_visible wrappers), 0299 (bell_feed__pre0299 = the 0266 inbox layer of the bell), 0357 (bell_feed__pre0042 =
--          the bell's base list).
--
-- In plain words:
--   On prod the bell (asked on every page and again every 30 seconds by the visible tab), the Home "pending" counter
--   (my_pending) and the inbox were the biggest database cost of the app: 28,075 calls, 262 ms each on average, 7,359 s in
--   all, while everything else averages 7 - 47 ms. Every one of those calls works out, for EVERY notification of the
--   studio, whether this person may see it and the cleaned-up copy of its details (links / tokens taken out, money
--   fields taken out for people without Quotes view) - even though the bell only shows 10 rows and the badge only needs a
--   count. The cleaned-up details were the expensive half: each row's details were taken apart key by key, and the rows
--   then passed through three more wrappers (0369 / 0373 / 0383), each copying every row again.
--   Now:
--     1  _r388_vis - the same "who may see which notification" rule (0266 / 0270 / 0293 / 0357 + the three notify-list
--        rules of 0369 task_escalated, 0373 vendor_bill_due, 0383 team_signin) in ONE pass, without building the details.
--        Every rule that only depends on (kind, channel) is decided once per distinct pair of the studio, not per row.
--     2  _r23_visible = _r388_vis + the cleaned-up details (same rows, same details): the money keys are found once per
--        distinct detail key of the studio and each row drops them in one step. The inbox page, "mark all read" and the
--        digests keep reading _r23_visible / _r23_rows as before.
--     3  _r388_rows - the person's inbox flags (unread / Done / snoozed / back from snooze) on top of _r388_vis, without the
--        details. The badge count (_r23_counts -> my_pending, inbox actions) and the bell's inbox layer
--        (bell_feed__pre0299) read it; the bell builds details only for the up to 10 rows back from a snooze it adds.
--     4  bell_feed__pre0042 (the bell's base list + count): the shown rows are kept as (id, time) only; the details are read
--        for the listed rows only (the old copy of every row with its details spilled about 3 MB to disk per bell call).
--   The answers stay the same: tests/db/r213-bell-speed-0388.sql compares the old and the new bell, badge, pending count,
--   inbox rule and inbox rows for every person of three studios (admin, manager, coordinator, sales, planner, crew,
--   worker, ... with Done / snoozed / muted / switched-off types, money rows, notify-list rows of other people).
--   FROM NOW ON a new "who may see it" rule for the inbox goes into _r388_vis (re-issue it, old body kept as
--   __preNNNN), not only into a new wrapper of _r23_visible - the bell count and my_pending read _r388_vis. The DB test
--   fails if _r23_visible is wrapped again without that.
--
-- ZERO DATA LOSS: read-only functions only. No table, column, row, policy or table grant is changed or deleted. The
-- previous bodies are kept once as _r23_visible__pre0388, _r23_counts__pre0388, bell_feed__pre0299__pre0388 and
-- bell_feed__pre0042__pre0388 with no app privilege. A body that is not the known one on this database is left unchanged (NOTICE) and the matching
-- APPLY-0388 check shows false.
-- Rollback: drop the new function and rename the kept __pre0388 copy back (four functions), then drop _r388_rows and
-- _r388_vis.

-- ---- 0) preflight ------------------------------------------------------------------------------------------------------
do $$ begin
  if to_regclass('public.notifications') is null or to_regclass('public.notification_inbox_state') is null
     or to_regclass('public.notification_seen') is null then
    raise exception 'STOP 0388: notifications / notification_inbox_state / notification_seen missing - this is not a Helm database'; end if;
  if to_regprocedure('public._r23_visible(uuid,uuid)') is null or to_regprocedure('public._r23_rows(uuid,uuid)') is null
     or to_regprocedure('public._r23_counts(uuid,uuid)') is null or to_regprocedure('public.bell_feed__pre0299(integer)') is null
     or to_regprocedure('public.bell_feed__pre0042(integer)') is null then
    raise exception 'STOP 0388: the 0266 inbox functions are missing - run 0266 / 0299 first'; end if;
  if to_regprocedure('public._r23_visible__pre0383(uuid,uuid)') is null or to_regprocedure('public._r23_visible__pre0373(uuid,uuid)') is null
     or to_regprocedure('public._r23_visible__pre0369(uuid,uuid)') is null then
    raise exception 'STOP 0388: the _r23_visible wrappers of 0369 / 0373 / 0383 are missing - run 0383 first'; end if;
  if to_regprocedure('public._a42_redact_detail(jsonb)') is null or to_regprocedure('public._a153_money_key(text)') is null
     or to_regprocedure('public._r23_detail(jsonb,boolean)') is null or to_regprocedure('public._r23_area(uuid,text,text,text)') is null
     or to_regprocedure('public._notify_hidden_types(uuid,uuid)') is null or to_regprocedure('public.notification_type_of(text,text)') is null then
    raise exception 'STOP 0388: helper functions of 0042 / 0153 / 0250 / 0266 missing'; end if;
end $$;

-- ---- 1) _r388_vis: who may see which notification - the whole rule, one pass, no details --------------------------------
-- = _r23_visible__pre0369 (r23-inbox-0266 + r24-ci-0270 + r52-notif-0293 + r163-0357) followed by the r186-0369 /
--   r190-0373 / r205-0383 notify-list wrappers, without the detail column.
create or replace function public._r388_vis(p_org uuid, p_uid uuid)
returns table(id uuid, kind text, channel text, status text, created_at timestamptz, quote_id uuid, ntype text)
language sql stable security definer set search_path = '' as $$
  -- r213-0388: the inbox rule in one pass (kept wrapper chain: _r23_visible__pre0388)
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
  ), ty as materialized (          -- the (kind, channel) pairs this person may see, with their type
    select k.kind, k.channel, (k.kind is null) as kn, (k.channel is null) as cn, x.ty
      from pairs k
      cross join me
      cross join lateral (select public.notification_type_of(k.kind, k.channel) as ty) x
     where coalesce(k.kind, '') <> 'security_alert'
       and not (x.ty = any (me.hid))
       and not (x.ty = any (me.mut))
       and (me.qe or coalesce(k.kind, '') <> 'price_change')
       and (me.qv or coalesce(k.kind, '') !~ '(price|reapproval|payment|refund|invoice|bill|settle|pkg_pay|quote_|discount|budget)')
       and (me.cl or coalesce(k.kind, '') not in ('event_close_request', 'event_close_decision'))
  )
  select n.id, n.kind, n.channel, n.status, n.created_at, n.quote_id, t.ty
    from me
    join public.notifications n on n.org_id = p_org
    join ty t on coalesce(t.kind, '') = coalesce(n.kind, '') and t.kn = (n.kind is null)
             and coalesce(t.channel, '') = coalesce(n.channel, '') and t.cn = (n.channel is null)
   where (me.adm
          or coalesce(n.kind, '') not in ('client_link_viewed', 'client_view_followup')
          or (me.qv
              and not (n.kind = 'client_view_followup'
                       and jsonb_typeof(n.detail -> 'notify') = 'array'
                       and jsonb_array_length(n.detail -> 'notify') > 0
                       and not ((n.detail -> 'notify') ? p_uid::text))))
     -- r186-0369 task_escalated, r190-0373 vendor_bill_due, r205-0383 team_signin: only for the people in its notify list
     and (coalesce(n.kind, '') not in ('task_escalated', 'vendor_bill_due', 'team_signin')
          or (jsonb_typeof(n.detail -> 'notify') = 'array' and (n.detail -> 'notify') ? p_uid::text));
$$;

-- ---- 2) _r23_visible = _r388_vis + the cleaned-up details ------------------------------------------------------------------
-- Kept once as _r23_visible__pre0388 when the live chain is the known r205-0383 -> r190-0373 -> r186-0369 -> r163-0357 one.
do $$
declare v_top text := coalesce((select p.prosrc from pg_proc p where p.oid = to_regprocedure('public._r23_visible(uuid,uuid)')), '');
        v_383 text := coalesce((select p.prosrc from pg_proc p where p.oid = to_regprocedure('public._r23_visible__pre0383(uuid,uuid)')), '');
        v_373 text := coalesce((select p.prosrc from pg_proc p where p.oid = to_regprocedure('public._r23_visible__pre0373(uuid,uuid)')), '');
        v_369 text := coalesce((select p.prosrc from pg_proc p where p.oid = to_regprocedure('public._r23_visible__pre0369(uuid,uuid)')), '');
begin
  if position('r213-0388' in v_top) > 0 then return; end if;
  if position('r205-0383' in v_top) > 0 and position('from public._r23_visible__pre0383(p_org, p_uid) v' in v_top) > 0
     and position('''team_signin''' in v_top) > 0
     and position('r190-0373' in v_383) > 0 and position('from public._r23_visible__pre0373(p_org, p_uid) v' in v_383) > 0
     and position('''vendor_bill_due''' in v_383) > 0
     and position('r186-0369' in v_373) > 0 and position('from public._r23_visible__pre0369(p_org, p_uid) v' in v_373) > 0
     and position('''task_escalated''' in v_373) > 0
     and position('r163-0357' in v_369) > 0 and position('r52-notif-0293' in v_369) > 0
     and position('coalesce((select jsonb_object_agg(e.k, e.v) from jsonb_each(dd.d) e(k, v)' in v_369) > 0
     and position('from (select public._a42_redact_detail(n.detail) as d) dd)' in v_369) > 0
     and position('''client_view_followup''' in v_369) > 0
     and to_regprocedure('public._r23_visible__pre0388(uuid,uuid)') is null then
    alter function public._r23_visible(uuid, uuid) rename to _r23_visible__pre0388;
  elsif to_regprocedure('public._r23_visible__pre0388(uuid,uuid)') is null then
    raise notice '0388: _r23_visible is not the known r205-0383 / r190-0373 / r186-0369 / r163-0357 chain on this database - left unchanged';
  end if;
end $$;

do $do$
declare v_src text;
begin
  -- create when kept above; re-issue over our own body or over a known older wrapper put back by re-running 0369 / 0373 / 0383
  -- (the chain is kept as _r23_visible__pre0388); never over an unknown body
  if to_regprocedure('public._r23_visible__pre0388(uuid,uuid)') is null then return; end if;
  v_src := coalesce((select p.prosrc from pg_proc p where p.oid = to_regprocedure('public._r23_visible(uuid,uuid)')), '');
  if v_src <> '' and position('r213-0388' in v_src) = 0
     and not (position('r205-0383' in v_src) > 0 and position('from public._r23_visible__pre0383(p_org, p_uid) v' in v_src) > 0)
     and not (position('r190-0373' in v_src) > 0 and position('from public._r23_visible__pre0373(p_org, p_uid) v' in v_src) > 0)
     and not (position('r186-0369' in v_src) > 0 and position('from public._r23_visible__pre0369(p_org, p_uid) v' in v_src) > 0) then
    raise notice '0388: _r23_visible has an unknown body on this database - left unchanged'; return; end if;
  execute $fn$
create or replace function public._r23_visible(p_org uuid, p_uid uuid)
returns table(id uuid, kind text, channel text, status text, detail jsonb, created_at timestamptz, quote_id uuid, ntype text)
language sql stable security definer set search_path = '' as $$
  -- r213-0388: the rows of _r388_vis (the r24-ci-0270 + r163-0357 rule with the r186-0369 / r190-0373 / r205-0383 notify-list
  -- rules, one pass) + the same cleaned-up detail as before (r23-inbox-0266 _r23_detail: links / tokens out; for a person
  -- without Quotes view the money keys and a money "message" out). The money keys are found once per distinct detail key
  -- of the studio (dk / mk), not by taking every row apart. Kept chain: _r23_visible__pre0388.
  with me as materialized (
    select public._r23_area(p_org, p.role, 'quotes', 'view') as qv
      from public.profiles p
     where p.id = p_uid and p.org_id = p_org and p_org is not null
  ), dk as materialized (          -- the distinct detail keys of the studio (only for a person without Quotes view)
    select distinct e.k
      from me, public.notifications n cross join lateral jsonb_object_keys(n.detail) e(k)
     where not me.qv and n.org_id = p_org and jsonb_typeof(n.detail) = 'object'
  ), mk as materialized (          -- the money keys among them
    select coalesce(array_agg(z.k), '{}'::text[]) as a from dk z where public._a153_money_key(z.k)
  )
  select l.id, l.kind, l.channel, l.status,
         (select case when me.qv then dd.d
                      when dd.d is null then '{}'::jsonb
                      when jsonb_typeof(dd.d) <> 'object' then dd.d
                      when coalesce(dd.d -> 'message' #>> '{}', '') ~* '(price|total|amount|paid|rs\.|inr)' then (dd.d - mk.a) - 'message'
                      else dd.d - mk.a end
            from (select public._a42_redact_detail(n.detail) as d offset 0) dd),
         l.created_at, l.quote_id, l.ntype
    from me
    cross join mk
    cross join public._r388_vis(p_org, p_uid) l
    join public.notifications n on n.id = l.id;
$$
  $fn$;
end $do$;

-- ---- 3) _r388_rows: the person's inbox flags without the details (= _r23_rows minus detail) ---------------------------------
create or replace function public._r388_rows(p_org uuid, p_uid uuid)
returns table(id uuid, kind text, channel text, status text, created_at timestamptz, quote_id uuid, ntype text,
              read_at timestamptz, done_at timestamptz, snoozed_until timestamptz, digested_at timestamptz,
              is_unread boolean, is_snoozed boolean, is_done boolean, returned boolean, sort_at timestamptz)
language sql stable security definer set search_path = '' as $$
  -- r213-0388: the r23-inbox-0266 _r23_rows rule unchanged (unread = the newest of arrived / marked unread / back from snooze
  -- is later than the newest of marked read / "mark all read"), on _r388_vis, without the detail column
  with w as (
    select coalesce((select max(s.last_seen_at) from public.notification_seen s where s.user_id = p_uid), '-infinity'::timestamptz) as seen
  ), b as (
    select v.*, st.read_at, st.unread_at, st.done_at, st.snoozed_until, st.digested_at, st.snooze_returned_at,
           (st.done_at is not null) as dn,
           (st.done_at is null and st.snoozed_until is not null and st.snoozed_until > now()) as sz,
           case when st.snoozed_until is not null and st.snoozed_until <= now() then st.snoozed_until end as back_now
      from public._r388_vis(p_org, p_uid) v
      left join public.notification_inbox_state st on st.user_id = p_uid and st.notification_id = v.id
  )
  select b.id, b.kind, b.channel, b.status, b.created_at, b.quote_id, b.ntype,
         b.read_at, b.done_at, case when b.sz then b.snoozed_until end, b.digested_at,
         (not b.dn and not b.sz
          and greatest(b.created_at, b.unread_at, b.back_now, b.snooze_returned_at)
              > coalesce(greatest(b.read_at, case when w.seen >= b.created_at then w.seen end), '-infinity'::timestamptz)),
         b.sz, b.dn,
         coalesce(b.back_now, b.snooze_returned_at) is not null,
         greatest(b.created_at, b.back_now, b.snooze_returned_at)
    from b, w;
$$;

-- ---- 4) _r23_counts (badge, my_pending, inbox actions) on _r388_rows ------------------------------------------------------
do $$
declare v_src text := coalesce((select p.prosrc from pg_proc p where p.oid = to_regprocedure('public._r23_counts(uuid,uuid)')), '');
begin
  if position('r213-0388' in v_src) > 0 then return; end if;
  if position('r23-inbox-0266' in v_src) > 0 and position('from public._r23_rows(p_org, p_uid) r' in v_src) > 0
     and to_regprocedure('public._r23_counts__pre0388(uuid,uuid)') is null then
    alter function public._r23_counts(uuid, uuid) rename to _r23_counts__pre0388;
  elsif to_regprocedure('public._r23_counts__pre0388(uuid,uuid)') is null then
    raise notice '0388: _r23_counts is not the known r23-inbox-0266 body on this database - left unchanged';
  end if;
end $$;

do $do$
declare v_src text;
begin
  -- create when kept above; re-issue over our own body or the known r23-inbox-0266 body put back by re-running 0266
  if to_regprocedure('public._r23_counts__pre0388(uuid,uuid)') is null then return; end if;
  v_src := coalesce((select p.prosrc from pg_proc p where p.oid = to_regprocedure('public._r23_counts(uuid,uuid)')), '');
  if v_src <> '' and position('r213-0388' in v_src) = 0
     and not (position('r23-inbox-0266' in v_src) > 0 and position('from public._r23_rows(p_org, p_uid) r' in v_src) > 0) then
    raise notice '0388: _r23_counts has an unknown body on this database - left unchanged'; return; end if;
  execute $fn$
create or replace function public._r23_counts(p_org uuid, p_uid uuid)
returns jsonb language sql stable security definer set search_path = '' as $$
  -- r23-inbox-0266 counts unchanged; r213-0388: read from _r388_rows (the same rows and flags, no details built)
  select jsonb_build_object(
    'unread', count(*) filter (where r.is_unread),
    'all', count(*) filter (where not r.is_done and not r.is_snoozed),
    'snoozed', count(*) filter (where r.is_snoozed),
    'done', count(*) filter (where r.is_done))
  from public._r388_rows(p_org, p_uid) r;
$$
  $fn$;
end $do$;

-- ---- 5) the bell's inbox layer (bell_feed__pre0299 = the r23-inbox-0266 body) on _r388_rows --------------------------------
-- Same list, flags, order and badge; the details are built only for the up to 10 rows back from a snooze that it adds
-- (with the same r23-inbox-0266 _r23_detail rule _r23_visible uses).
do $$
declare v_src text := coalesce((select p.prosrc from pg_proc p where p.oid = to_regprocedure('public.bell_feed__pre0299(integer)')), '');
begin
  if position('r213-0388' in v_src) > 0 then return; end if;
  if position('r23-inbox-0266' in v_src) > 0 and position('with r as materialized (select * from public._r23_rows(v_org, v_uid))' in v_src) > 0
     and position('v := public.bell_feed__pre0266(p_limit);' in v_src) > 0
     and position('''detail'', r.detail' in v_src) > 0
     and to_regprocedure('public.bell_feed__pre0299__pre0388(integer)') is null then
    alter function public.bell_feed__pre0299(integer) rename to bell_feed__pre0299__pre0388;
  elsif to_regprocedure('public.bell_feed__pre0299__pre0388(integer)') is null then
    raise notice '0388: bell_feed__pre0299 is not the known r23-inbox-0266 body on this database - left unchanged';
  end if;
end $$;

do $do$
declare v_src text;
begin
  -- create when kept above; re-issue over our own body or the known r23-inbox-0266 body put back by re-running 0266 / 0299
  if to_regprocedure('public.bell_feed__pre0299__pre0388(integer)') is null then return; end if;
  v_src := coalesce((select p.prosrc from pg_proc p where p.oid = to_regprocedure('public.bell_feed__pre0299(integer)')), '');
  if v_src <> '' and position('r213-0388' in v_src) = 0
     and not (position('r23-inbox-0266' in v_src) > 0 and position('with r as materialized (select * from public._r23_rows(v_org, v_uid))' in v_src) > 0
              and position('v := public.bell_feed__pre0266(p_limit);' in v_src) > 0) then
    raise notice '0388: bell_feed__pre0299 has an unknown body on this database - left unchanged'; return; end if;
  execute $fn$
create or replace function public.bell_feed__pre0299(p_limit integer default 20)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
-- r23-inbox-0266: Done / snoozed rows leave the bell, unread follows the person's inbox, rows back from a snooze come
-- first, the badge = inbox unread (+ HQ notices for operators). Any error -> the bell exactly as before.
-- r213-0388: the same, read from _r388_rows (no details built for the whole studio); the details of the up to 10 rows back
-- from a snooze are built for those rows only (_r23_detail, the rule _r23_visible uses). Kept body: bell_feed__pre0299__pre0388.
declare v jsonb; v_uid uuid := auth.uid(); v_org uuid := public.current_org_id(); v_out jsonb;
        v_lim integer := greatest(1, least(coalesce(p_limit, 20), 100)); v_hq integer := 0; v_seen timestamptz;
begin
  v := public.bell_feed__pre0266(p_limit);
  if v is null or jsonb_typeof(v -> 'items') <> 'array' or v_uid is null or v_org is null then return v; end if;
  begin
    if to_regclass('public.hq_security_notices') is not null and public.is_platform_operator() then
      v_seen := greatest(coalesce((select max(s.last_seen_at) from public.hq_security_seen s where s.user_id = v_uid), 'epoch'::timestamptz),
                         coalesce((select max(s.last_seen_at) from public.notification_seen s where s.user_id = v_uid), 'epoch'::timestamptz));
      select count(*) into v_hq from public.hq_security_notices n where n.last_at > v_seen;
    end if;
    with r as materialized (select * from public._r388_rows(v_org, v_uid)),
    kept as (
      select case when r.id is null then e.i
                  else e.i || jsonb_build_object('unread', r.is_unread, 'returned', r.returned and r.is_unread, 'sort_at', r.sort_at) end as i,
             coalesce(r.sort_at, (e.i ->> 'created_at')::timestamptz) as at, e.ord
        from jsonb_array_elements(v -> 'items') with ordinality e(i, ord)
        left join r on r.id::text = (e.i ->> 'id')
       where not coalesce(r.is_done or r.is_snoozed, false)
    ),
    back as (
      select jsonb_build_object('id', r.id, 'kind', r.kind, 'channel', r.channel, 'status', r.status,
               'detail', public._r23_detail(n.detail, (select public._r23_area(v_org, p.role, 'quotes', 'view')
                                                         from public.profiles p where p.id = v_uid and p.org_id = v_org)),
               'created_at', r.created_at, 'sort_at', r.sort_at, 'quote_id', r.quote_id, 'event_code', q.code, 'event_title', q.title,
               'unread', true, 'returned', true) as i, r.sort_at as at, 0::bigint as ord
        from (select * from r where r.returned and r.is_unread
                and not exists (select 1 from jsonb_array_elements(v -> 'items') x where x ->> 'id' = r.id::text)
               order by r.sort_at desc limit 10) r
        join public.notifications n on n.id = r.id
        left join public.quotes q on q.id = r.quote_id and q.org_id = v_org
    ),
    allrows as (select * from kept union all select * from back)
    select jsonb_build_object(
      'items', coalesce((select jsonb_agg(a.i order by a.at desc nulls last, a.ord) from (select * from allrows order by at desc nulls last, ord limit v_lim) a), '[]'::jsonb),
      'unread', (select count(*) from r where r.is_unread) + v_hq)
      into v_out;
    return v || v_out || jsonb_build_object('inbox', jsonb_build_object('v', 1,
      'open_marks_read', coalesce((public._r25_inbox_cfg(v_org) ->> 'bell_open_marks_read')::boolean, false)));
  exception when others then
    raise warning 'r23-inbox-0266: bell inbox state skipped (%)', sqlstate;
    return v;
  end;
end $$
  $fn$;
end $do$;

-- ---- 6) the bell's base list (bell_feed__pre0042 = the r163-0357 body): the shown rows kept as (id, created_at) only ------
-- The old body kept every shown row WITH its details for the count (on a studio with 20,000 notifications that copy spilled
-- about 3 MB to disk on every bell call); the details are now read for the listed rows only. Same list, same count.
do $$
declare v_src text := coalesce((select p.prosrc from pg_proc p where p.oid = to_regprocedure('public.bell_feed__pre0042(integer)')), '');
begin
  if position('r213-0388' in v_src) > 0 then return; end if;
  if position('r163-0357' in v_src) > 0 and position('notification-prefs-0036' in v_src) > 0
     and position('  ), ok as (
    select n.* from public.notifications n' in v_src) > 0
     and position('''unread'', (select count(*) from ok n where n.created_at > seen)' in v_src) > 0
     and to_regprocedure('public.bell_feed__pre0042__pre0388(integer)') is null then
    alter function public.bell_feed__pre0042(integer) rename to bell_feed__pre0042__pre0388;
  elsif to_regprocedure('public.bell_feed__pre0042__pre0388(integer)') is null then
    raise notice '0388: bell_feed__pre0042 is not the known r163-0357 body on this database - left unchanged';
  end if;
end $$;

do $do$
declare v_src text;
begin
  -- create when kept above; re-issue over our own body or the known r163-0357 body put back by re-running 0357
  if to_regprocedure('public.bell_feed__pre0042__pre0388(integer)') is null then return; end if;
  v_src := coalesce((select p.prosrc from pg_proc p where p.oid = to_regprocedure('public.bell_feed__pre0042(integer)')), '');
  if v_src <> '' and position('r213-0388' in v_src) = 0
     and not (position('r163-0357' in v_src) > 0 and position('notification-prefs-0036' in v_src) > 0
              and position('''unread'', (select count(*) from ok n where n.created_at > seen)' in v_src) > 0) then
    raise notice '0388: bell_feed__pre0042 has an unknown body on this database - left unchanged'; return; end if;
  execute $fn$
create or replace function public.bell_feed__pre0042(p_limit integer default 20)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
-- notification-prefs-0036: types switched off for the caller are hidden; no recipient column
-- r163-0357: same list + count; a (kind, channel) pair is shown when not (notification_type_of(kind, channel) = any (hidden))
-- is true - worked out ONCE per distinct pair of the studio instead of twice per notification row
-- r213-0388: same list + count; the shown rows are kept as (id, created_at) only and the details are read for the listed
-- rows only (kept body: bell_feed__pre0042__pre0388)
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
  ), ok as materialized (
    select n.id, n.created_at from public.notifications n
      join shown t on coalesce(t.kind, '') = coalesce(n.kind, '') and t.kn = (n.kind is null)
                  and coalesce(t.channel, '') = coalesce(n.channel, '') and t.cn = (n.channel is null)
     where n.org_id = org
  ), top as (
    select o.id from ok o order by o.created_at desc limit greatest(1, least(coalesce(p_limit, 20), 100))
  ), recent as (
    select n.id, n.kind, n.channel, n.status, n.detail, n.created_at, n.quote_id,
           q.code as event_code, q.title as event_title, (n.created_at > seen) as unread
      from top
      join public.notifications n on n.id = top.id
      left join public.quotes q on q.id = n.quote_id
  )
  select jsonb_build_object(
    'items',  coalesce((select jsonb_agg(to_jsonb(recent) order by recent.created_at desc) from recent), '[]'::jsonb),
    'unread', (select count(*) from ok n where n.created_at > seen)
  ) into result;
  return result;
end $$
  $fn$;
end $do$;

-- ---- 7) grants: server only (as before); the kept copies get no app privilege ------------------------------------------------
do $$
declare f text;
begin
  foreach f in array array['public._r388_vis(uuid,uuid)', 'public._r388_rows(uuid,uuid)', 'public._r23_visible(uuid,uuid)',
                           'public._r23_counts(uuid,uuid)', 'public.bell_feed__pre0299(integer)', 'public.bell_feed__pre0042(integer)',
                           'public._r23_visible__pre0388(uuid,uuid)', 'public._r23_counts__pre0388(uuid,uuid)',
                           'public.bell_feed__pre0299__pre0388(integer)', 'public.bell_feed__pre0042__pre0388(integer)'] loop
    if to_regprocedure(f) is null then continue; end if;
    execute format('revoke all on function %s from public', f);
    if exists (select 1 from pg_roles where rolname = 'anon') then execute format('revoke all on function %s from anon', f); end if;
    if exists (select 1 from pg_roles where rolname = 'authenticated') then execute format('revoke all on function %s from authenticated', f); end if;
  end loop;
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    foreach f in array array['public._r388_vis(uuid,uuid)', 'public._r388_rows(uuid,uuid)', 'public._r23_visible(uuid,uuid)',
                             'public._r23_counts(uuid,uuid)', 'public.bell_feed__pre0299(integer)', 'public.bell_feed__pre0042(integer)'] loop
      if to_regprocedure(f) is not null then execute format('grant execute on function %s to service_role', f); end if;
    end loop;
    foreach f in array array['public._r23_visible__pre0388(uuid,uuid)', 'public._r23_counts__pre0388(uuid,uuid)',
                             'public.bell_feed__pre0299__pre0388(integer)', 'public.bell_feed__pre0042__pre0388(integer)'] loop
      if to_regprocedure(f) is not null then execute format('revoke all on function %s from service_role', f); end if;
    end loop;
  end if;
end $$;

notify pgrst, 'reload schema';
