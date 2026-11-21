-- 0428_r247_stock_upload_cap.sql -- R247 fix plan Phase 10 (FILE-05, audit A5): stock-photo uploads get the same
-- "100 uploads per person per 10 minutes" cap as every other upload.
-- REQUIRES 0027 / 0032 (storage_upload_allowed + storage_upload_log) and 0374 (event_docs_stock_insert_0374).
--
-- Before: 0374 added its own insert policy for stock photos (<studio>/<event or none>/stock/<uuid>.<ext> in event-docs).
--   Insert policies are OR'd, so that path skipped the 0027 / 0032 rule (100 uploads per person per 10 minutes, counting
--   surviving files AND the upload log, so delete + upload again does not reset it). The studio storage quota (0049,
--   a restrictive policy) already applied.
-- Now: one RESTRICTIVE insert policy event_docs_stock_rate_0428 - only for the stock folder of event-docs - asks
--   _r428_upload_rate_ok(): the same count as storage_upload_allowed (same window, same limit, same two sources).
--   Every other path and bucket is unchanged (the condition is true for them). The 0374 policy is not touched.
-- Also: the 0048 upload name guard (storage_object_name_ok) did not know the 4-part stock key, so stock photos were refused
--   at upload; it now accepts exactly that key for the own studio (old body kept as storage_object_name_ok__pre0428).
-- ZERO DATA LOSS: additive + idempotent. One helper function, one policy, one wrapped guard. Nothing deleted. Safe to run twice.
-- Rollback: drop policy event_docs_stock_rate_0428 on storage.objects; to undo the guard wrapper, put the kept body back:
--   select pg_get_functiondef('public.storage_object_name_ok__pre0428(text,text)'::regprocedure) and re-run it with the
--   __pre0428 name replaced by the plain name.

create or replace function public._r428_upload_rate_ok()
returns boolean language plpgsql stable security definer set search_path = '' as $$
-- r247-0428: the 0032 per-person upload rate (100 per 10 minutes: surviving files AND the upload log), for stock photos
declare v_uid uuid := auth.uid(); n int := 0; n_log int := 0;
begin
  if v_uid is null then return false; end if;
  select count(*) into n from storage.objects o
   where o.owner = v_uid and o.created_at > now() - interval '10 minutes';
  if to_regclass('public.storage_upload_log') is not null then
    select count(*) into n_log from public.storage_upload_log l
     where l.owner = v_uid and l.created_at > now() - interval '10 minutes';
  end if;
  return greatest(n, n_log) < 100;
end $$;
revoke all on function public._r428_upload_rate_ok() from public;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'anon') then execute 'revoke all on function public._r428_upload_rate_ok() from anon'; end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then execute 'grant execute on function public._r428_upload_rate_ok() to authenticated'; end if;
  if exists (select 1 from pg_roles where rolname = 'service_role') then execute 'grant execute on function public._r428_upload_rate_ok() to service_role'; end if;
end $$;

do $$ begin
  if to_regclass('storage.objects') is not null and to_regprocedure('storage.foldername(text)') is not null then
    execute 'drop policy if exists event_docs_stock_rate_0428 on storage.objects';
    execute $p$create policy event_docs_stock_rate_0428 on storage.objects as restrictive for insert to authenticated
      with check (not (bucket_id = 'event-docs' and coalesce((storage.foldername(name))[3], '') = 'stock')
                  or (select public._r428_upload_rate_ok()))$p$;
  end if;
end $$;

-- ---- the 0048 upload name guard knows the 0374 stock-photo key ----------------------------------------------------------------
-- Found while testing the cap: the 0048 RESTRICTIVE insert guard (upload_guard_insert -> storage_object_name_ok) only knows the
-- 3-part event-docs key <studio>/<event>/<random>.<ext>, so the 4-part stock key <studio>/<event or none>/stock/<random>.<ext>
-- that 0374 allows was refused by it (a stock photo could not be uploaded). The same 0256 way as before: the current body is
-- copied ONCE to storage_object_name_ok__pre0428, then replaced in place (the policy binds to the function itself) by a
-- wrapper that accepts exactly that stock key - own studio (current_org_id), signed in, jpg / png / webp - and hands every
-- other key to the kept body unchanged. Who may upload there is still decided by event_docs_stock_insert_0374 (Inventory /
-- Command edit) and, now, the rate above.
do $$ begin
  if to_regprocedure('public.storage_object_name_ok(text,text)') is not null
     and to_regprocedure('public.storage_object_name_ok__pre0428(text,text)') is null then
    execute replace(pg_get_functiondef('public.storage_object_name_ok(text,text)'::regprocedure),
                    'public.storage_object_name_ok(', 'public.storage_object_name_ok__pre0428(');
    execute 'revoke all on function public.storage_object_name_ok__pre0428(text, text) from public';
  end if;
end $$;
-- the kept body is only ever called from inside the definer wrapper below: no app (anon / signed-in) privilege on it
do $$ begin
  if to_regprocedure('public.storage_object_name_ok__pre0428(text,text)') is not null then
    execute 'revoke all on function public.storage_object_name_ok__pre0428(text, text) from public';
    if exists (select 1 from pg_roles where rolname = 'anon') then execute 'revoke all on function public.storage_object_name_ok__pre0428(text, text) from anon'; end if;
    if exists (select 1 from pg_roles where rolname = 'authenticated') then execute 'revoke all on function public.storage_object_name_ok__pre0428(text, text) from authenticated'; end if;
    if exists (select 1 from pg_roles where rolname = 'service_role') then execute 'grant execute on function public.storage_object_name_ok__pre0428(text, text) to service_role'; end if;
  end if;
end $$;
do $$ begin
  if to_regprocedure('public.storage_object_name_ok__pre0428(text,text)') is not null then
    execute $f$
create or replace function public.storage_object_name_ok(p_bucket text, p_name text)
returns boolean language plpgsql stable security definer set search_path = '' as $b$
declare v_org uuid;
begin
  -- r247-0428: the 0374 stock-photo key <studio>/<event uuid or none>/stock/<random>.{jpg|png|webp} (own studio, signed in)
  if p_bucket = 'event-docs' and coalesce(p_name, '') like '%/stock/%' then
    v_org := public.current_org_id();
    return v_org is not null and auth.uid() is not null and length(p_name) <= 400
       and p_name ~ ('^' || v_org::text || '/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|none)/stock/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[0-9a-f]{32})\.(jpg|png|webp)$');
  end if;
  return public.storage_object_name_ok__pre0428(p_bucket, p_name);
end $b$;
$f$;
    execute 'grant execute on function public.storage_object_name_ok(text, text) to authenticated, anon, service_role';
  end if;
end $$;

do $$ begin
  if to_regclass('public.helm_schema_markers') is not null then
    insert into public.helm_schema_markers(num, name) values (428, '0428_r247_stock_upload_cap') on conflict (num) do nothing;
  end if;
end $$;
