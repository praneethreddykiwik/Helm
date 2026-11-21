-- APPLY-0407 (R241 fix plan Phase 4: two people saving the same floor plan).
-- Run on STAGING first, then production. Safe to run twice. Needs 0144 - already on both.
-- What it does:
--   * New call add_quote_version_checked: the builder says which version it started from. If a teammate saved a newer
--     version meanwhile, NOTHING is saved and the builder asks "Reload / Save mine as a new version" (both keep everything).
--   * Two saves of one event at the same moment no longer give "Autosave failed": the second waits a moment and gets the
--     next version number (same numbering as before).
--   * Pages opened before this release keep saving exactly as before; those saves are only counted (no person, no content).
-- Nothing is dropped or deleted. One new counter table, new functions; add_quote_version re-issued (old one kept).
-- It waits at most 5 seconds for a lock (then stops with an error and changes nothing - just run it again later).
-- Paste the whole file into the Supabase SQL editor and press Run. The last result lists checks - every ok must be true.
begin;
set local lock_timeout = '5s';
set local statement_timeout = '5min';
-- 0407_r241_layout_save_conflict.sql - CANONICAL forward-only. R241 fix plan Phase 4 "concurrent edits" (owner approved
-- 20 Nov 2026; LIMITATIONS v2 Q-01 / Q-03, reliability review PART-B FE-01 + PART-A DB-07). ASCII only.
-- REQUIRES the 0144 add_quote_version wrapper (has_area quotes / layouts edit -> add_quote_version__pre0144) - on every DB.
--
-- In plain words:
--   1  SAVE CONFLICT (FE-01 / Q-01). Two people had the same floor plan open; the one who saved last silently became
--      "the latest", and the teammate's work dropped out of the current plan (it was still in the history). New call
--      add_quote_version_checked(quote, label, layout, object count, base version, save_as_new): the builder sends the
--      version number its canvas is built on. If someone saved a NEWER version meanwhile, the server writes NOTHING and
--      answers {ok:false, conflict:'newer_version', latest_version, latest_by, latest_at, message}. The builder then asks
--      "Someone saved a newer version - Reload / Save mine as a new version". Save mine = the same call again with
--      save_as_new = true: one more version is appended (the teammate's version stays in the history, untouched).
--      Nothing is ever overwritten: quote_versions stays append-only, as before.
--   2  TWO SAVES AT THE SAME MOMENT (DB-07 / Q-03). add_quote_version numbered the new version max+1 with no lock, so two
--      saves of one event in the same instant collided (duplicate key 23505 -> "Autosave failed"). Both calls now take a
--      per-event transaction lock (pg_advisory_xact_lock on the quote id) before numbering, so the second save simply
--      waits a few milliseconds and gets the next number. Same numbering as before (1, 2, 3 ...); existing rows untouched.
--   3  OLD PAGES KEEP WORKING. A page loaded before this release still calls add_quote_version (no base version): it
--      saves exactly as before (now with the lock) and the call is counted in r407_legacy_calls (function, day, count -
--      no person, no studio, no content) + a server LOG line, so we can see when the old pages are gone.
--   Same rights as before: Quotes edit or Layouts edit, own studio only (assert_quote_org), the 0397 plan lock and the
--   closed-event / read-only studio guards still refuse at the table. The answer carries no money and no layout.
-- ZERO DATA LOSS: 1 new table (counts only), 4 new functions, add_quote_version re-issued once with the old wrapper kept
--   as add_quote_version__pre0407 (no app privilege). No row changed or deleted; no column / policy / trigger touched.
--   Safe to run twice.
-- ROLLBACK (manual, only if ever needed; no data involved): the pages fall back to add_quote_version by themselves when
--   add_quote_version_checked is missing. To undo the lock: drop function public.add_quote_version(uuid,text,jsonb,integer);
--   alter function public.add_quote_version__pre0407(uuid,text,jsonb,integer) rename to add_quote_version; grant execute
--   on it to authenticated, service_role.
-- ============================================================================

do $$ begin
  if to_regprocedure('public.add_quote_version(uuid,text,jsonb,integer)') is null
     and to_regprocedure('public.add_quote_version__pre0407(uuid,text,jsonb,integer)') is null then
    raise exception 'STOP: public.add_quote_version is missing on this database'; end if;
  if to_regprocedure('public.add_quote_version__pre0144(uuid,text,jsonb,integer)') is null then
    raise exception 'STOP: 0144 (add_quote_version__pre0144) is not applied'; end if;
  if to_regprocedure('public.assert_quote_org(uuid)') is null or to_regprocedure('public.has_area(text,text)') is null then
    raise exception 'STOP: assert_quote_org / has_area are missing'; end if;
end $$;

-- ---- 1) legacy-call counter (counts only; 16 shards per function per day so busy studios never queue on one row) -------
create table if not exists public.r407_legacy_calls (
  fn      text        not null,
  day     date        not null,
  shard   smallint    not null default 0,
  calls   integer     not null default 0,
  last_at timestamptz not null default now(),
  primary key (fn, day, shard)
);
alter table public.r407_legacy_calls enable row level security;
revoke all on table public.r407_legacy_calls from public, anon, authenticated;
grant select on table public.r407_legacy_calls to service_role;
comment on table public.r407_legacy_calls is
  'r241-0407: how often a page saved a layout WITHOUT a base version (a page loaded before 0407). Counts only, no person / studio / content.';

-- ---- 2) helpers (server only) ----------------------------------------------------------------------------------------------
create or replace function public._r407_qv_lock(p_quote_id uuid)
returns void language plpgsql volatile security definer set search_path = '' as $$
begin
  -- r241-0407: one save at a time per event (held to the end of the transaction); other events never wait
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('helm.r407.quote_versions:' || coalesce(p_quote_id::text, ''), 0));
end $$;

create or replace function public._r407_note_legacy(p_fn text, p_quote_id uuid)
returns void language plpgsql volatile security definer set search_path = '' as $$
begin
  -- r241-0407: never blocks a save - a problem here is swallowed
  begin
    raise log 'helm r241-0407 legacy save without base version: fn=% quote=%', p_fn, p_quote_id;
    insert into public.r407_legacy_calls as t (fn, day, shard, calls, last_at)
      values (left(coalesce(p_fn, '?'), 60), (now() at time zone 'utc')::date,
              (abs(pg_catalog.hashtext(coalesce(p_quote_id::text, ''))) % 16)::smallint, 1, now())
      on conflict (fn, day, shard) do update set calls = t.calls + 1, last_at = excluded.last_at;
  exception when others then null;
  end;
end $$;

revoke all on function public._r407_qv_lock(uuid) from public, anon, authenticated;
revoke all on function public._r407_note_legacy(text, uuid) from public, anon, authenticated;
grant execute on function public._r407_qv_lock(uuid) to service_role;
grant execute on function public._r407_note_legacy(text, uuid) to service_role;

-- ---- 3) add_quote_version: keep the 0144 wrapper ONCE as __pre0407, re-issue it with the per-event lock ------------------
do $$ begin
  if to_regprocedure('public.add_quote_version__pre0407(uuid,text,jsonb,integer)') is null then
    alter function public.add_quote_version(uuid, text, jsonb, integer) rename to add_quote_version__pre0407;
  end if;
end $$;
revoke all on function public.add_quote_version__pre0407(uuid, text, jsonb, integer) from public, anon, authenticated;
grant execute on function public.add_quote_version__pre0407(uuid, text, jsonb, integer) to service_role;

create or replace function public.add_quote_version(p_quote_id uuid, p_label text, p_data jsonb, p_object_count integer)
returns public.quote_versions language plpgsql volatile security definer set search_path = '' as $$
begin
  -- r241-0407: a page without a base version (loaded before 0407). Same checks first, then the per-event lock, so two
  -- saves at the same moment get the next numbers instead of a duplicate-key error. Counted as a legacy call.
  if not (public.has_area('quotes', 'edit') or public.has_area('layouts', 'edit')) then
    raise exception 'not authorized' using errcode = '42501'; end if;
  perform public.assert_quote_org(p_quote_id);
  perform public._r407_qv_lock(p_quote_id);
  perform public._r407_note_legacy('add_quote_version', p_quote_id);
  return public.add_quote_version__pre0407(p_quote_id, p_label, p_data, p_object_count);
end $$;
revoke all on function public.add_quote_version(uuid, text, jsonb, integer) from public, anon;
grant execute on function public.add_quote_version(uuid, text, jsonb, integer) to authenticated, service_role;

-- ---- 4) the new save with a base version ---------------------------------------------------------------------------------
create or replace function public.add_quote_version_checked(
  p_quote_id uuid, p_label text, p_data jsonb, p_object_count integer, p_base_version integer, p_save_as_new boolean default false)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare v public.quote_versions; l_no integer; l_by uuid; l_at timestamptz;
begin
  -- r241-0407: rights + studio BEFORE anything is read or locked (another studio learns nothing)
  if not (public.has_area('quotes', 'edit') or public.has_area('layouts', 'edit')) then
    raise exception 'not authorized' using errcode = '42501'; end if;
  perform public.assert_quote_org(p_quote_id);
  perform public._r407_qv_lock(p_quote_id);
  if p_base_version is null then
    perform public._r407_note_legacy('add_quote_version_checked', p_quote_id);   -- no base = the old behaviour, counted
  elsif not coalesce(p_save_as_new, false) then
    select qv.version_no, qv.created_by, qv.created_at into l_no, l_by, l_at
      from public.quote_versions qv where qv.quote_id = p_quote_id order by qv.version_no desc limit 1;
    if l_no is not null and l_no > p_base_version then
      -- a newer version exists: write NOTHING, say so plainly
      return jsonb_build_object('ok', false, 'conflict', 'newer_version', 'base_version', p_base_version,
        'latest_version', l_no, 'latest_by', l_by, 'latest_by_me', (l_by is not distinct from auth.uid()), 'latest_at', l_at,
        'message', 'Someone saved a newer version (V' || l_no || ') after you opened V' || p_base_version
                   || '. Nothing was saved and nothing was overwritten.');
    end if;
  end if;
  v := public.add_quote_version__pre0407(p_quote_id, p_label, p_data, p_object_count);
  return jsonb_build_object('ok', true, 'saved_as_new', coalesce(p_save_as_new, false) and p_base_version is not null,
    'version', jsonb_build_object('id', v.id, 'quote_id', v.quote_id, 'version_no', v.version_no, 'label', v.label,
                                  'object_count', v.object_count, 'created_at', v.created_at, 'created_by', v.created_by));
end $$;
comment on function public.add_quote_version_checked(uuid, text, jsonb, integer, integer, boolean) is
  'r241-0407: save a layout version on top of p_base_version; a newer version = {ok:false, conflict:newer_version}, nothing written. p_save_as_new = keep both (append).';
revoke all on function public.add_quote_version_checked(uuid, text, jsonb, integer, integer, boolean) from public, anon;
grant execute on function public.add_quote_version_checked(uuid, text, jsonb, integer, integer, boolean) to authenticated, service_role;

-- ---- checks (every ok must be true) --------------------------------------------------------------------------------------
select item, ok, note from (
  select '01 add_quote_version_checked: signed-in only, definer, empty search_path' as item,
     to_regprocedure('public.add_quote_version_checked(uuid,text,jsonb,integer,integer,boolean)') is not null
     and has_function_privilege('authenticated', 'public.add_quote_version_checked(uuid,text,jsonb,integer,integer,boolean)', 'execute')
     and not has_function_privilege('anon', 'public.add_quote_version_checked(uuid,text,jsonb,integer,integer,boolean)', 'execute')
     and coalesce((select p.prosecdef and p.proconfig @> array['search_path=""'] from pg_proc p
                    where p.oid = to_regprocedure('public.add_quote_version_checked(uuid,text,jsonb,integer,integer,boolean)')), false) as ok,
     '' as note
  union all
  select '02 add_quote_version (old pages): still signed-in, now takes the per-event lock',
     has_function_privilege('authenticated', 'public.add_quote_version(uuid,text,jsonb,integer)', 'execute')
     and not has_function_privilege('anon', 'public.add_quote_version(uuid,text,jsonb,integer)', 'execute')
     and coalesce((select p.prosrc like '%_r407_qv_lock%' and p.prosecdef from pg_proc p
                    where p.oid = to_regprocedure('public.add_quote_version(uuid,text,jsonb,integer)')), false), ''
  union all
  select '03 old wrapper kept as add_quote_version__pre0407 (no app privilege), still calling the 0144 body',
     to_regprocedure('public.add_quote_version__pre0407(uuid,text,jsonb,integer)') is not null
     and not has_function_privilege('authenticated', 'public.add_quote_version__pre0407(uuid,text,jsonb,integer)', 'execute')
     and coalesce((select p.prosrc like '%add_quote_version__pre0144%' from pg_proc p
                    where p.oid = to_regprocedure('public.add_quote_version__pre0407(uuid,text,jsonb,integer)')), false), ''
  union all
  select '04 helpers server only',
     not has_function_privilege('authenticated', 'public._r407_qv_lock(uuid)', 'execute')
     and not has_function_privilege('authenticated', 'public._r407_note_legacy(text,uuid)', 'execute')
     and not has_function_privilege('anon', 'public._r407_qv_lock(uuid)', 'execute'), ''
  union all
  select '05 counter table r407_legacy_calls: row security on, no app access',
     coalesce((select c.relrowsecurity from pg_class c where c.oid = to_regclass('public.r407_legacy_calls')), false)
     and not has_table_privilege('authenticated', 'public.r407_legacy_calls', 'select')
     and not has_table_privilege('anon', 'public.r407_legacy_calls', 'select'),
     (select coalesce(sum(calls), 0) from public.r407_legacy_calls) || ' old-page save(s) counted so far'
  union all
  select '06 layout versions untouched (report only)', true,
     (select count(*) from public.quote_versions) || ' version row(s)'
) v order by item;
commit;
