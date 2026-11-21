-- 0429_r247_storage_usage.sql -- R247 fix plan Phase 10 (FILE-04): how full the studio's file storage is, plus one bell at 80 %.
-- REQUIRES 0049 (studio_upload_limits + storage_quota_ok: the 2 GB default quota and the bucket list), 0032 (storage_upload_log
--   + its trigger on storage.objects - optional, see below), has_area + current_org_id, the base notifications table.
--
-- Before: a studio found out its storage was full only when an upload was refused ("Your studio's storage is full").
-- Now:
--   1  storage_usage() - signed-in studio staff with Settings (controls) view: used bytes, the quota (studio override -> plan
--      -> 2 GB, the SAME numbers storage_quota_ok uses), percent, file count and a per-kind split (invitation photos, event
--      files + stock photos, chat media, crew proof photos, profile photos). Numbers only - never a file name.
--      Settings -> Notifications shows it as a meter (storage-usage-settings.js).
--   2  At 80 % or more the studio gets ONE bell notice (kind storage_usage_high), at most once every 7 days while it stays
--      that full. It is checked (a) after an upload (AFTER INSERT trigger on storage_upload_log, at most once an hour per
--      studio - the sum is the same one storage_quota_ok already runs on every upload) and (b) when someone opens the meter.
--      Where the 0032 storage trigger could not be made (no privilege on storage.objects) only (b) runs.
--      The check never blocks or slows an upload: any problem is skipped quietly.
--   3  storage_usage_alerts: one row per studio (when it was last checked / last told). Server only.
-- ZERO DATA LOSS: additive + idempotent. One table, functions, one trigger. Nothing deleted or rewritten. Safe to run twice.
-- Rollback: drop trigger zz_r429_usage_check on public.storage_upload_log (the meter keeps working without the bell on upload).

-- ---- 1) per-studio check state (server only) ------------------------------------------------------------------------------
create table if not exists public.storage_usage_alerts (
  org_id      uuid primary key,
  checked_at  timestamptz,
  last_pct    numeric,
  alerted_at  timestamptz,
  alerted_pct numeric
);
comment on table public.storage_usage_alerts is
  'r247-0429 (FILE-04): when each studio''s storage use was last summed (at most hourly after an upload) and when the 80 % bell was last sent (at most once per 7 days). Numbers only. Server only.';
alter table public.storage_usage_alerts enable row level security;   -- no policy: server only
revoke all on public.storage_usage_alerts from public;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'anon') then execute 'revoke all on public.storage_usage_alerts from anon'; end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then execute 'revoke all on public.storage_usage_alerts from authenticated'; end if;
  if exists (select 1 from pg_roles where rolname = 'service_role') then execute 'grant select on public.storage_usage_alerts to service_role'; end if;
end $$;

-- ---- 2) the sum (the same buckets + quota as storage_quota_ok, 0049) --------------------------------------------------------
create or replace function public._r429_usage(p_org uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
-- r247-0429: numbers only - bytes + files per bucket of this studio, the quota, percent
declare v_quota bigint; v_used bigint := 0; v_files bigint := 0; v_b jsonb := '[]'::jsonb;
begin
  if p_org is null then return null; end if;
  if to_regprocedure('public.studio_upload_limits(uuid)') is not null then
    select l.storage_quota_bytes into v_quota from public.studio_upload_limits(p_org) l;
  end if;
  v_quota := coalesce(v_quota, 2147483648::bigint);
  if to_regclass('storage.objects') is not null then
    with x as (
      select o.bucket_id as b, count(*) as n,
             coalesce(sum(case when coalesce(o.metadata ->> 'size', '') ~ '^[0-9]{1,15}$' then (o.metadata ->> 'size')::bigint else 0 end), 0) as s
        from storage.objects o
       where o.bucket_id in ('invite-media', 'event-docs', 'chat-media', 'task-proof', 'member-avatars')
         and o.name like p_org::text || '/%'
       group by o.bucket_id)
    select coalesce(sum(x.s), 0), coalesce(sum(x.n), 0),
           coalesce(jsonb_agg(jsonb_build_object('bucket', x.b, 'bytes', x.s, 'files', x.n) order by x.s desc, x.b), '[]'::jsonb)
      into v_used, v_files, v_b from x;
  end if;
  return jsonb_build_object('used_bytes', v_used, 'quota_bytes', v_quota, 'files', v_files,
    'pct', case when v_quota > 0 then round(v_used * 100.0 / v_quota, 1) end, 'warn_pct', 80, 'buckets', v_b);
end $$;

-- ---- 3) one bell at 80 % (at most once per 7 days per studio) -----------------------------------------------------------------
create or replace function public._r429_maybe_bell(p_org uuid, p_usage jsonb)
returns boolean language plpgsql security definer set search_path = '' as $$
-- r247-0429: true when a bell notice was written now
declare v_pct numeric := (p_usage ->> 'pct')::numeric; v_id uuid; v_used numeric; v_quota numeric; v_label text;
begin
  if p_org is null or p_usage is null then return false; end if;
  insert into public.storage_usage_alerts as a (org_id, checked_at, last_pct) values (p_org, now(), v_pct)
  on conflict (org_id) do update set checked_at = excluded.checked_at, last_pct = excluded.last_pct;
  if v_pct is null or v_pct < 80 then return false; end if;
  update public.storage_usage_alerts a set alerted_at = now(), alerted_pct = v_pct
   where a.org_id = p_org and (a.alerted_at is null or a.alerted_at < now() - interval '7 days')
  returning a.org_id into v_id;
  if v_id is null then return false; end if;
  v_used := round(coalesce((p_usage ->> 'used_bytes')::numeric, 0) / 1048576.0);
  v_quota := round(coalesce((p_usage ->> 'quota_bytes')::numeric, 0) / 1048576.0);
  v_label := 'Studio file storage is ' || round(v_pct)::text || '% full (' || v_used::text || ' MB of ' || v_quota::text
             || ' MB). Delete old files or ask Helm to raise the limit.';
  begin
    insert into public.notifications (quote_id, channel, kind, status, detail, org_id)
    values (null, 'in_app', 'storage_usage_high', 'simulated',
            jsonb_build_object('label', v_label, 'pct', round(v_pct), 'used_mb', v_used, 'quota_mb', v_quota, 'source', '0429'), p_org);
  exception when others then
    raise warning 'r247-0429: storage bell skipped (%)', sqlstate; return false;
  end;
  return true;
end $$;

-- ---- 4) after an upload: at most one sum an hour per studio, never blocks the upload -------------------------------------------
create or replace function public._r429_tg_usage_check()
returns trigger language plpgsql security definer set search_path = '' as $$
-- r247-0429: runs after storage_upload_log gets a row (= after a file upload, 0032)
declare v_org uuid; v_claim uuid;
begin
  if coalesce(current_setting('helm.storage_usage_check', true), '') = 'off' then return null; end if;
  begin
    v_org := public.current_org_id();
    if v_org is null then return null; end if;
    insert into public.storage_usage_alerts as a (org_id, checked_at) values (v_org, now())
    on conflict (org_id) do update set checked_at = excluded.checked_at
      where a.checked_at is null or a.checked_at < now() - interval '1 hour'
    returning a.org_id into v_claim;
    if v_claim is null then return null; end if;
    perform public._r429_maybe_bell(v_org, public._r429_usage(v_org));
  exception when others then
    raise warning 'r247-0429: storage check skipped (%)', sqlstate;
  end;
  return null;
end $$;

do $$ begin
  if to_regclass('public.storage_upload_log') is not null
     and not exists (select 1 from pg_trigger where tgname = 'zz_r429_usage_check' and tgrelid = 'public.storage_upload_log'::regclass) then
    create trigger zz_r429_usage_check after insert on public.storage_upload_log
      for each row execute function public._r429_tg_usage_check();
  end if;
end $$;

-- ---- 5) the meter for Settings -------------------------------------------------------------------------------------------------
create or replace function public.storage_usage()
returns jsonb language plpgsql security definer set search_path = '' as $$
-- r247-0429: signed-in studio staff with Settings view; numbers only
declare v_org uuid := public.current_org_id(); v jsonb;
begin
  if auth.uid() is null or v_org is null then raise exception 'not authorized' using errcode = '42501'; end if;
  if not public.has_area('controls', 'view') then raise exception 'not authorized' using errcode = '42501'; end if;
  v := public._r429_usage(v_org);
  begin perform public._r429_maybe_bell(v_org, v); exception when others then null; end;
  return v;
end $$;

-- ---- 6) grants: storage_usage for signed-in staff, the helpers for the server only ------------------------------------------------
do $$
declare f text;
begin
  foreach f in array array['public._r429_usage(uuid)', 'public._r429_maybe_bell(uuid,jsonb)', 'public._r429_tg_usage_check()', 'public.storage_usage()'] loop
    execute format('revoke all on function %s from public', f);
    if exists (select 1 from pg_roles where rolname = 'anon') then execute format('revoke all on function %s from anon', f); end if;
    if exists (select 1 from pg_roles where rolname = 'authenticated') then execute format('revoke all on function %s from authenticated', f); end if;
    if exists (select 1 from pg_roles where rolname = 'service_role') then execute format('grant execute on function %s to service_role', f); end if;
  end loop;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then execute 'grant execute on function public.storage_usage() to authenticated'; end if;
end $$;

-- ---- 7) free-trial purge (0184): the check state is kept like the other per-studio settings (numbers only) ------------------
do $$ declare v_def text; begin
  if to_regprocedure('public._tr184_keep_tables()') is not null then
    v_def := pg_get_functiondef('public._tr184_keep_tables()'::regprocedure);
    if position('''storage_usage_alerts''' in v_def) = 0 then
      if (length(v_def) - length(replace(v_def, '''trial_extensions''', ''))) / length('''trial_extensions''') <> 1 then
        raise notice '0429: _tr184_keep_tables has an unexpected body - left unchanged';
      else execute replace(v_def, '''trial_extensions''', '''trial_extensions'', ''storage_usage_alerts'''); end if;
    end if;
  end if;
end $$;

do $$ begin
  if to_regclass('public.helm_schema_markers') is not null then
    insert into public.helm_schema_markers(num, name) values (429, '0429_r247_storage_usage') on conflict (num) do nothing;
  end if;
end $$;

notify pgrst, 'reload schema';
