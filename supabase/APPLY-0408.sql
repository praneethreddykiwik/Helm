-- APPLY-0408 (R241 fix plan Phase 4: "changed by someone else" only when the event details really changed).
-- Run on STAGING first, then production, AFTER APPLY-0407. Safe to run twice. Needs nothing new.
-- What it does:
--   * New column quotes.meta_rev: a counter that goes up only when the event name, type, client details, price, status,
--     date or time really change. The pages send the counter they read with each details save; a stale one saves nothing
--     and the page says someone saved a newer version. A teammate's floor-plan autosave no longer causes a false warning.
--   * Old pages keep their old check and keep working.
-- Nothing is dropped or deleted. One new column (default 0, no table rewrite), one function, one trigger.
-- It waits at most 5 seconds for a table lock (then stops with an error and changes nothing - just run it again later).
-- Paste the whole file into the Supabase SQL editor and press Run. The last result lists checks - every ok must be true.
begin;
set local lock_timeout = '5s';
set local statement_timeout = '5min';
-- 0408_r241_quote_meta_rev.sql - CANONICAL forward-only. R241 fix plan Phase 4 "concurrent edits" (owner approved
-- 20 Nov 2026; LIMITATIONS v2 Q-02, reliability review PART-A DB-08). ASCII only.
-- REQUIRES public.quotes (base).
--
-- In plain words:
--   The event details (name, type, client details, price, status, date, time) are protected against two people saving
--   at once by a "changed since you opened it?" check (R79). That check compared the row's updated_at - which ALSO moves
--   when a teammate's floor plan autosaves (add_quote_version stamps the quote) or when the builder re-writes the same
--   name. So a planner editing the client got "changed by someone else" although nothing they could overwrite changed,
--   and the pages that could not tell skipped the check.
--   New column quotes.meta_rev: a counter that goes up ONLY when one of those details really changes (a BEFORE UPDATE
--   trigger that runs last and that the app cannot set by hand). The pages now send "the counter I read" with every
--   detail save; a save whose counter is stale changes nothing and the page says "Someone saved a newer version -
--   reload". Floor-plan saves, stage moves, approval / shelf changes and same-value writes never move the counter.
--   Old pages keep sending updated_at and keep working exactly as before.
-- ZERO DATA LOSS: 1 new column (default 0, no table rewrite), 1 new function, 1 new trigger. No row's data changed or
--   deleted; nothing dropped. Safe to run twice.
-- ROLLBACK (manual, only if ever needed): drop trigger zzzzz_r408_meta_rev on public.quotes; the pages then fall back to
--   the updated_at check by themselves when the counter stops moving (the column can stay).
-- ============================================================================

do $$ begin
  if to_regclass('public.quotes') is null then raise exception 'STOP: public.quotes is missing'; end if;
end $$;

alter table public.quotes add column if not exists meta_rev bigint not null default 0;
comment on column public.quotes.meta_rev is
  'r241-0408: goes up by 1 when title / event_type / client / pricing / status / event_date / event_time change (lock token for detail saves).';

create or replace function public._r408_tg_meta_rev()
returns trigger language plpgsql set search_path = '' as $$
begin
  -- r241-0408: runs LAST among the BEFORE UPDATE triggers, so it sees the values that will really be stored
  if (new.title, new.event_type, new.client, new.pricing, new.status, new.event_date, new.event_time)
     is distinct from (old.title, old.event_type, old.client, old.pricing, old.status, old.event_date, old.event_time) then
    new.meta_rev := coalesce(old.meta_rev, 0) + 1;
  else
    new.meta_rev := old.meta_rev;   -- nobody sets it by hand
  end if;
  return new;
end $$;
revoke all on function public._r408_tg_meta_rev() from public, anon, authenticated;

do $$ begin
  if not exists (select 1 from pg_trigger where tgname = 'zzzzz_r408_meta_rev' and tgrelid = 'public.quotes'::regclass) then
    create trigger zzzzz_r408_meta_rev before update on public.quotes for each row execute function public._r408_tg_meta_rev();
  end if;
end $$;

-- ---- checks (every ok must be true) --------------------------------------------------------------------------------------
select item, ok, note from (
  select '01 column quotes.meta_rev: bigint, not null, default 0' as item,
     exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'quotes'
              and column_name = 'meta_rev' and data_type = 'bigint' and is_nullable = 'NO' and column_default = '0') as ok,
     '' as note
  union all
  select '02 trigger zzzzz_r408_meta_rev on quotes (once), runs last among BEFORE UPDATE triggers',
     (select count(*) from pg_trigger t where t.tgrelid = 'public.quotes'::regclass and t.tgname = 'zzzzz_r408_meta_rev') = 1
     and (select max(t.tgname::text) from pg_trigger t where t.tgrelid = 'public.quotes'::regclass and not t.tgisinternal
            and (t.tgtype & 2) = 2 and (t.tgtype & 16) = 16) = 'zzzzz_r408_meta_rev', ''
  union all
  select '03 the app cannot write meta_rev by hand (no column update privilege)',
     not has_column_privilege('authenticated', 'public.quotes', 'meta_rev', 'update')
     and not has_column_privilege('anon', 'public.quotes', 'meta_rev', 'update'), ''
  union all
  select '04 signed-in pages can read it (the lock token)',
     has_column_privilege('authenticated', 'public.quotes', 'meta_rev', 'select'), ''
  union all
  select '05 trigger function: no app privilege',
     not has_function_privilege('authenticated', 'public._r408_tg_meta_rev()', 'execute'), ''
  union all
  select '06 events untouched (report only)', true,
     (select count(*) from public.quotes) || ' event(s), ' || (select count(*) from public.quotes where meta_rev <> 0) || ' with a detail change since 0408'
) v order by item;
commit;
