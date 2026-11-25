-- 0446_r258_quotes_page.sql - R258 the Quotes page reads ONE page of 10 rows and its exact total from the server. Forward-only,
-- additive, safe to run twice. ASCII only.
-- REQUIRES 0040 (archive / deleted shelves). Uses my_open_quotes (0350 / 0356 / 0357) for the In progress tab when it is there.
--
-- In plain words (owner, 25 Nov 2026: "10 per page in ALL the quotes tabs; another 10 are pulled from the server"):
--   Until now every tab asked for 25 rows, then threw away the archived / deleted ones in the browser, and the whole Archive +
--   Deleted shelf (every row) was read on each open. No exact total was possible. quotes_page does the tab rule, the search, the
--   type, the event dates, the Deleted switch and the order in the database and answers only the rows of the page asked for,
--   the exact total, and (only when asked) the small numbers on the tabs.
-- Who sees what: SECURITY INVOKER - it reads public.quotes as the signed-in person, so the row security of the table decides
--   (own studio + has_area quotes view), exactly like the reads it replaces (quotes select + list_quote_shelf, both run as the
--   caller). The columns are the ones the list already read. In progress = my_open_quotes as it is (same checks, same rows).
-- Tab rules (the same as store-api.js sbQuoteView + the shelf filter of quotes.html):
--   all / quote / confirmed = not archived, not deleted, not cancelled, not closed-after-confirmed
--   attention = the same + event date before today, or an id in p_ids (viewed-not-approved / expiring soon, asked by the page)
--   cancelled = status cancelled, not deleted            deleted = deleted (p_kind: all | hand | empty drafts Helm tidied)
--   archived  = not deleted and (archived by hand, cancelled, or closed after confirmed); archived by hand come first
--   inprogress = my_open_quotes (studio)
-- ZERO DATA LOSS: one new read-only (STABLE) function. No table, column, row, policy or existing function is changed.
-- ROLLBACK (manual, only if ever needed): drop function public.quotes_page(text,text,text,date,date,text,text,integer,integer,uuid[],date,boolean);
--   the page then uses the old reads by itself.

do $$ begin
  if to_regclass('public.quotes') is null or not exists (select 1 from pg_attribute where attrelid = 'public.quotes'::regclass and attname = 'deleted_reason' and not attisdropped) then
    raise exception 'STOP 0446: apply 0040 first (archive / deleted shelves)'; end if;
end $$;

create or replace function public.quotes_page(
  p_tab text default 'all', p_search text default null, p_type text default null, p_from date default null, p_to date default null,
  p_kind text default 'all', p_sort text default 'confirmed', p_page integer default 1, p_size integer default 10,
  p_ids uuid[] default null, p_today date default null, p_counts boolean default true)
returns jsonb language plpgsql stable security invoker set search_path = '' as $$
-- r258-0446: one page of a Quotes tab, its exact total, and the numbers on the tabs. Row security of public.quotes decides.
declare
  v_tab text := lower(btrim(coalesce(p_tab, 'all')));
  v_kind text := lower(btrim(coalesce(p_kind, 'all')));
  v_conf boolean := lower(btrim(coalesce(p_sort, 'confirmed'))) <> 'updated';
  v_size integer := greatest(1, least(coalesce(p_size, 10), 50));
  v_page integer := greatest(1, least(coalesce(p_page, 1), 1000000));
  v_term text := lower(btrim(left(btrim(coalesce(p_search, '')), 100)));
  v_like text; v_type text := nullif(lower(left(btrim(coalesce(p_type, '')), 200)), '');
  v_ids uuid[] := coalesce(p_ids[1:300], '{}'::uuid[]);
  v_today date := coalesce(p_today, (now() at time zone 'Asia/Kolkata')::date);
  v_total integer := 0; v_rows jsonb := '[]'::jsonb; v_counts jsonb;
  d jsonb; r jsonb; v_off integer; v_hay text; v_tok text; v_hit boolean;
begin
  if v_tab = 'active' then v_tab := 'all'; end if;
  if v_tab not in ('all', 'inprogress', 'quote', 'confirmed', 'attention', 'cancelled', 'archived', 'deleted') then
    raise exception 'unknown tab' using errcode = '22023'; end if;
  if v_kind not in ('all', 'hand', 'empty') then v_kind := 'all'; end if;
  -- typed text is literal: \ % _ are escaped
  v_like := case when v_term = '' then null else '%' || replace(replace(replace(v_term, '\', '\\'), '%', '\%'), '_', '\_') || '%' end;

  -- ---- the numbers on the tabs, only when the page asks (it keeps them for a short time) -------------------------------
  if coalesce(p_counts, true) then
    select jsonb_build_object(
             'all', count(*) filter (where q.deleted_at is null and q.archived_at is null),
             'cancelled', count(*) filter (where q.deleted_at is null and q.status = 'cancelled'),
             'archived', count(*) filter (where q.deleted_at is null and (q.archived_at is not null or q.status = 'cancelled' or (q.lifecycle_stage = 'closed' and q.status = 'confirmed'))),
             'deleted', count(*) filter (where q.deleted_at is not null),
             'deleted_empty', count(*) filter (where q.deleted_at is not null and q.deleted_reason = 'auto_empty_draft'))
      into v_counts from public.quotes q;
  end if;

  -- ---- In progress: the list of my_open_quotes as it is ---------------------------------------------------------------
  if v_tab = 'inprogress' then
    if to_regprocedure('public.my_open_quotes(text,integer,integer,uuid,integer)') is null then
      return jsonb_build_object('tab', v_tab, 'missing', true, 'rows', '[]'::jsonb, 'total', 0, 'page', 1, 'size', v_size); end if;
    if v_term = '' and v_type is null and p_from is null and p_to is null then
      d := public.my_open_quotes('studio', v_size, least((v_page - 1) * v_size::bigint, 100000)::integer, null, null);
      v_total := coalesce((d ->> 'total')::integer, 0);
      if v_page > greatest(1, ceil(v_total / v_size::numeric)) then
        v_page := greatest(1, ceil(v_total / v_size::numeric))::integer;
        d := public.my_open_quotes('studio', v_size, (v_page - 1) * v_size, null, null);
      end if;
      v_rows := coalesce(d -> 'rows', '[]'::jsonb);
    else
      v_off := 0;
      declare v_hits jsonb[] := '{}'; v_all integer; begin
        loop
          d := public.my_open_quotes('studio', 100, v_off, null, null);
          v_all := coalesce((d ->> 'total')::integer, 0);
          for r in select e from jsonb_array_elements(coalesce(d -> 'rows', '[]'::jsonb)) e loop
            v_hit := (v_type is null or lower(coalesce(r ->> 'event_type', '')) = v_type)
                 and (p_from is null or (r ->> 'event_date')::date >= p_from) and (p_to is null or (r ->> 'event_date')::date <= p_to);
            if coalesce(v_hit, false) and v_term <> '' then
              v_hay := lower(concat_ws(' ', r ->> 'title', r ->> 'code', r #>> '{client,name}'));
              if position(v_term in v_hay) = 0 then
                -- the name on screen can be automatic (WED_HYD_200_03DEC26): its parts are the type, place, guests and date
                v_hay := lower(concat_ws(' ', v_hay, r ->> 'event_type', r #>> '{client,city}', r #>> '{client,venue}', r #>> '{client,guests}',
                                         to_char((r ->> 'event_date')::date, 'DDMONYY')));
                v_hit := btrim(replace(v_term, '_', ' ')) <> '';
                foreach v_tok in array string_to_array(v_term, '_') loop
                  if btrim(v_tok) <> '' and position(btrim(v_tok) in v_hay) = 0 then v_hit := false; end if;
                end loop;
              end if;
            end if;
            if coalesce(v_hit, false) then v_hits := v_hits || r; end if;
          end loop;
          v_off := v_off + 100;
          exit when v_off >= v_all or v_off >= 10000;
        end loop;
        v_total := coalesce(cardinality(v_hits), 0);
        v_page := least(v_page, greatest(1, ceil(v_total / v_size::numeric))::integer);
        select coalesce(jsonb_agg(x.e order by x.n), '[]'::jsonb) into v_rows
          from unnest(v_hits) with ordinality x(e, n) where x.n > (v_page - 1) * v_size and x.n <= v_page * v_size;
      end;
    end if;
    return jsonb_build_object('tab', v_tab, 'rows', v_rows, 'total', v_total, 'page', v_page, 'size', v_size, 'counts', v_counts,
      'can_edit', coalesce((d ->> 'can_edit')::boolean, false), 'read_only', coalesce((d ->> 'read_only')::boolean, false), 'open', true);
  end if;

  -- ---- the other tabs: ids in order + total, then only the rows of the page -------------------------------------------
  with f as materialized (
    select q.id, count(*) over () as n, row_number() over (order by
             case when v_tab = 'deleted' and q.deleted_reason = 'auto_empty_draft' then 1 else 0 end,                 -- deleted by somebody first
             case when v_tab = 'archived' and q.archived_at is null then 1 else 0 end,                                -- archived by hand first
             case when v_tab = 'deleted' then q.deleted_at when v_tab = 'archived' then q.archived_at end desc nulls last,
             case when v_conf and v_tab = 'archived' then q.status end desc,                                          -- confirmed above cancelled
             case when v_conf and v_tab not in ('archived', 'deleted') then q.status end,                             -- confirmed above quote
             q.updated_at desc, q.id desc) as rn
      from public.quotes q
     where case
             when v_tab = 'deleted' then q.deleted_at is not null
                  and (v_kind = 'all' or (v_kind = 'empty') = (q.deleted_reason is not distinct from 'auto_empty_draft'))
             when q.deleted_at is not null then false
             when v_tab = 'cancelled' then q.status = 'cancelled'
             when v_tab = 'archived' then q.archived_at is not null or q.status = 'cancelled' or (coalesce(q.lifecycle_stage, '') = 'closed' and q.status = 'confirmed')
             else q.archived_at is null and q.status <> 'cancelled' and not (coalesce(q.lifecycle_stage, '') = 'closed' and q.status = 'confirmed')
                  and (v_tab = 'all' or (v_tab in ('quote', 'confirmed') and q.status = v_tab)
                       or (v_tab = 'attention' and (coalesce(q.event_date < v_today, false) or q.id = any (v_ids))))
           end
       and (v_type is null or lower(q.event_type) = v_type)
       and (p_from is null or q.event_date >= p_from) and (p_to is null or q.event_date <= p_to)
       and (v_like is null or q.code ilike v_like or q.title ilike v_like or q.client ->> 'name' ilike v_like
            or ((q.archived_at is not null or q.deleted_at is not null) and q.client ->> 'name' is null and q.pricing -> 'client' ->> 'name' ilike v_like))
  ), t as (select coalesce(max(f.n), 0)::integer as n from f),
  p as (select t.n, least(v_page, greatest(1, ceil(t.n / v_size::numeric))::integer) as pg from t)
  select p.n, p.pg, coalesce((
      select jsonb_agg(jsonb_build_object(
               'id', q.id, 'code', q.code, 'title', q.title, 'event_type', q.event_type, 'status', q.status, 'lifecycle_stage', q.lifecycle_stage,
               'approval_status', q.approval_status, 'current_version', q.current_version, 'event_date', q.event_date, 'event_time', q.event_time,
               'updated_at', q.updated_at, 'created_at', q.created_at, 'confirmed_at', q.confirmed_at,
               'client_name', q.client ->> 'name', 'client_phone', q.client ->> 'phone', 'client_venue', q.client ->> 'venue',
               'client_address', q.client ->> 'address', 'client_city', q.client ->> 'city', 'client_guests', q.client ->> 'guests',
               'total', q.pricing -> 'total', 'pricing_client_name', q.pricing -> 'client' ->> 'name', 'pricing_client_phone', q.pricing -> 'client' ->> 'phone',
               'pricing_guests', q.pricing -> 'guests', 'tax_country', q.pricing ->> 'taxCountry', 'tax_region', q.pricing ->> 'taxRegion',
               'tax_name', q.pricing ->> 'taxName', 'tax_currency', q.pricing ->> 'currency',
               'archived_at', q.archived_at, 'archived_reason', q.archived_reason, 'deleted_at', q.deleted_at, 'deleted_reason', q.deleted_reason,
               'link_expired_at', q.link_expired_at) order by f.rn)
        from f join public.quotes q on q.id = f.id
       where f.rn > (p.pg - 1) * v_size and f.rn <= p.pg * v_size), '[]'::jsonb)
    into v_total, v_page, v_rows from p;

  return jsonb_build_object('tab', v_tab, 'rows', v_rows, 'total', v_total, 'page', v_page, 'size', v_size, 'counts', v_counts);
end $$;

do $$ begin
  execute 'revoke all on function public.quotes_page(text,text,text,date,date,text,text,integer,integer,uuid[],date,boolean) from public';
  if exists (select 1 from pg_roles where rolname = 'anon') then
    execute 'revoke all on function public.quotes_page(text,text,text,date,date,text,text,integer,integer,uuid[],date,boolean) from anon'; end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    execute 'grant execute on function public.quotes_page(text,text,text,date,date,text,text,integer,integer,uuid[],date,boolean) to authenticated'; end if;
end $$;

comment on function public.quotes_page(text,text,text,date,date,text,text,integer,integer,uuid[],date,boolean) is
  'r258-0446: one page (10) of a Quotes tab with its exact total and the tab numbers. Read only, runs as the caller (row security of quotes).';

do $$ begin
  if to_regclass('public.helm_schema_markers') is not null then
    insert into public.helm_schema_markers(num, name) values (446, '0446_r258_quotes_page') on conflict (num) do nothing;
  end if;
end $$;

notify pgrst, 'reload schema';

-- ---- CHECK (read only): every row must say true -------------------------------------------------------------------------------
select c."check", c.ok from (values
  ('01 the function is there, read only, and runs as the caller', (select p.provolatile = 's' and not p.prosecdef from pg_proc p where p.oid = to_regprocedure('public.quotes_page(text,text,text,date,date,text,text,integer,integer,uuid[],date,boolean)'))),
  ('02 search_path pinned', (select coalesce(p.proconfig @> array['search_path=""'], false) from pg_proc p where p.oid = to_regprocedure('public.quotes_page(text,text,text,date,date,text,text,integer,integer,uuid[],date,boolean)'))),
  ('03 signed-in people only', has_function_privilege('authenticated', 'public.quotes_page(text,text,text,date,date,text,text,integer,integer,uuid[],date,boolean)', 'execute')
      and not has_function_privilege('anon', 'public.quotes_page(text,text,text,date,date,text,text,integer,integer,uuid[],date,boolean)', 'execute')),
  ('04 quotes is still protected by row security', (select c.relrowsecurity from pg_class c where c.oid = 'public.quotes'::regclass))
) c("check", ok);
