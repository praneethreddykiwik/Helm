-- APPLY-0350 (R154c Continue quote list - open quotes until Confirmed). Run on STAGING first, then production. Safe to run twice.
-- Adds one read-only function my_open_quotes. Nothing is changed or deleted. If it stops with an error nothing was applied.
begin;
-- 0350_r154c_open_quotes.sql - R154c Continue quote list. Forward-only, additive, safe to run twice. Notes in MANIFEST.
-- In plain words:
--   Owner, Nov 2026: every quote that is still open and not yet Confirmed must be resumable from Home and Quotes,
--   not only the newest one, and not only until the quotation is saved in step 8.
--   my_open_quotes(scope, limit, offset, quote, max_days) answers the same shape as my_unfinished_quotes (0206)
--   plus a phase per row:
--     building = still in steps 1 to 8 (no quotation saved yet, nothing sent)
--     quoted   = a quotation version is saved but it is not shared with the client yet
--     locked   = priced and locked by the studio, approval link not sent yet
--     sent     = the approval link is with the client, waiting for their approval
--   Open = own studio, not deleted, archived or auto-discarded, status quote or confirmed (locked), stage before
--   Confirmed (lead, discovery, proposal, quote), approval none or sent (approved, paid and cancelled are done),
--   not trial sample data. Building rows also need some content, exactly like 0206.
--   scope mine = quotes I worked on and did not hide, or quotes I created that nobody worked on yet.
--   scope studio = every open quote of the studio with who worked on it last.
--   Hide stays mark_flow_resume_dismissed (0206): hide only, the quote itself is never changed or deleted.
--   1 new read-only function. No table, column, row, policy or grant of an existing object is changed or deleted.
--   my_unfinished_quotes is left exactly as it was. Rollback: drop function public.my_open_quotes.
do $$
begin
  if to_regclass('public.quote_flow_progress') is null or to_regprocedure('public._flow_steps_done(uuid)') is null
     or to_regprocedure('public.my_unfinished_quotes(text,integer,integer,uuid,integer)') is null then
    raise exception 'STOP 0350: quote_flow_progress / _flow_steps_done / my_unfinished_quotes missing - run 0206 first'; end if;
  if to_regclass('public.quotation_versions') is null then raise exception 'STOP 0350: quotation_versions missing - run phase77 first'; end if;
  if to_regprocedure('public.has_area(text,text)') is null or to_regprocedure('public.current_org_id()') is null then
    raise exception 'STOP 0350: has_area / current_org_id missing'; end if;
end $$;

create or replace function public.my_open_quotes(p_scope text default 'mine', p_limit int default 20, p_offset int default 0,
                                                 p_quote uuid default null, p_max_days int default null)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
-- open-quotes-0350
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
           lst.user_id as last_user, lst.last_step, lst.last_step_at, cr.created_by,
           public._flow_steps_done(b.id) as done
      from base b
      left join lateral (select fp.last_step, fp.last_step_at, fp.dismissed_at from public.quote_flow_progress fp
                          where fp.quote_id = b.id and fp.user_id = v_uid and fp.org_id = v_org) me on true
      left join lateral (select fp.user_id, fp.last_step, fp.last_step_at from public.quote_flow_progress fp
                          where fp.quote_id = b.id and fp.org_id = v_org and fp.last_step is not null
                          order by fp.last_step_at desc, fp.user_id limit 1) lst on true
      left join lateral (select v.created_by from public.quote_versions v where v.quote_id = b.id and v.version_no = 1
                          order by v.created_at limit 1) cr on true
  ), y as (
    select x.*, greatest(x.updated_at, case when v_scope = 'mine' then x.my_step_at else x.last_step_at end) as activity
      from x
     where (x.phase <> 'building' or x.filled or x.last_user is not null or cardinality(x.done) > 0)
       and (v_scope = 'studio'
            or (x.my_dismissed_at is null
                and (x.my_step is not null or (x.last_user is null and x.created_by = v_uid))))
  ), z as (
    select y.* from y where p_max_days is null or y.activity > now() - make_interval(days => p_max_days)
  )
  select (select count(*) from z),
         coalesce((select jsonb_agg(r0.r order by r0.ord) from (
           select row_number() over (order by z.activity desc nulls last, z.id) as ord,
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
                    'steps_done', to_jsonb(z.done), 'steps_total', 8,
                    'activity', z.activity, 'updated_at', z.updated_at)) as r
             from z order by z.activity desc nulls last, z.id
            limit v_lim offset v_off) r0(ord, r)), '[]'::jsonb)
    into v_total, v_rows;

  return jsonb_build_object('total', v_total, 'rows', v_rows, 'can_edit', v_edit and not coalesce(v_locked, false),
                            'read_only', coalesce(v_locked, false), 'steps_total', 8, 'scope', v_scope, 'open', true);
end $$;

do $$
begin
  execute 'revoke all on function public.my_open_quotes(text, int, int, uuid, int) from public';
  if exists (select 1 from pg_roles where rolname = 'anon') then
    execute 'revoke all on function public.my_open_quotes(text, int, int, uuid, int) from anon'; end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    execute 'grant execute on function public.my_open_quotes(text, int, int, uuid, int) to authenticated'; end if;
end $$;

comment on function public.my_open_quotes(text, int, int, uuid, int) is
  'r154c-0350: open quotes not yet Confirmed (building, quoted, locked, sent) for the Continue quote list. Read only.';

notify pgrst, 'reload schema';
commit;

-- VERIFY every line should say true
select item, ok from (values
  ('01 my_open_quotes is installed with the 0350 body', position('open-quotes-0350' in coalesce((select p.prosrc from pg_proc p where p.oid = to_regprocedure('public.my_open_quotes(text,integer,integer,uuid,integer)')), '')) > 0),
  ('02 it is security definer with an empty search_path', coalesce((select p.prosecdef and 'search_path=""' = any(p.proconfig) from pg_proc p where p.oid = to_regprocedure('public.my_open_quotes(text,integer,integer,uuid,integer)')), false)),
  ('03 signed-in users may call it and anon may not', coalesce(has_function_privilege('authenticated', to_regprocedure('public.my_open_quotes(text,integer,integer,uuid,integer)'), 'execute') and not has_function_privilege('anon', to_regprocedure('public.my_open_quotes(text,integer,integer,uuid,integer)'), 'execute'), false)),
  ('04 my_unfinished_quotes from 0206 is still there', to_regprocedure('public.my_unfinished_quotes(text,integer,integer,uuid,integer)') is not null),
  ('05 without a signed-in user it quietly answers nothing', coalesce((public.my_open_quotes('mine', 5, 0, null, null) ->> 'total') = '0', false))
) v(item, ok) order by item;
