-- 0427_r247_layout_live_signals.sql -- R247 fix plan Phase 10 (Q-11): big layouts are no longer sent in full over Realtime.
-- REQUIRES the base quote_versions / quotation_versions tables, has_area + current_org_id, 0412 (helm_schema_markers - optional).
--
-- Before: every open builder / event page listened to INSERTs on quote_versions (0077 publication), so each floor-plan save
-- sent the WHOLE layout JSON (can be megabytes) to every open page of the studio. The page only used it as a "something
-- changed" ping and then read the version list again.
-- Now:
--   1  quote_live_signals: ONE small row per event and kind ('layout' / 'quotation'): quote id, studio, version number, time.
--      An AFTER INSERT trigger on quote_versions / quotation_versions updates that row (insert ... on conflict do update).
--      New pages listen to this table (a few bytes per save) and fetch the version on demand, as before.
--      The trigger never blocks or slows a save: any problem is skipped quietly (the page still refreshes on focus).
--      Row security: the same rule as quote_versions (Quotes view + own studio). Read-only for the app.
--   2  A size cap on a floor-plan version: quote_versions_data_size_chk427 CHECK (pg_column_size(data) <= 10 MB) NOT VALID -
--      old rows are never checked or touched; a NEW save over 10 MB is refused (the page says so in plain words).
-- COMPATIBILITY: quote_versions / quotation_versions STAY in the Realtime publication, so a page opened before this update
--   (old script) keeps working exactly as before. Once every open page has been reloaded (a day after the release) the owner
--   may take quote_versions out of the publication - see the PR; that step is NOT done here.
-- ZERO DATA LOSS: additive + idempotent. One new table, one helper, two triggers, one NOT VALID CHECK. Nothing deleted or
--   rewritten. Safe to run twice. Rollback: drop the two triggers zz_r427_live_signal (the pages fall back on focus refresh),
--   alter table public.quote_versions drop constraint quote_versions_data_size_chk427.

-- ---- 1) the signal table ---------------------------------------------------------------------------------------------------
create table if not exists public.quote_live_signals (
  quote_id   uuid not null,
  kind       text not null,
  org_id     uuid not null,
  version_no integer,
  changed_at timestamptz not null default now(),
  constraint quote_live_signals_pkey primary key (quote_id, kind),
  constraint quote_live_signals_kind_chk427 check (kind in ('layout', 'quotation'))
);
comment on table public.quote_live_signals is
  'r247-0427 (Q-11): one small "this event changed" row per event and kind, written by trigger zz_r427_live_signal on quote_versions / quotation_versions. Pages listen to it over Realtime instead of the full layout rows. No layout data here.';
create index if not exists ix_quote_live_signals_org_0427 on public.quote_live_signals (org_id);
alter table public.quote_live_signals enable row level security;
drop policy if exists r427_signal_read on public.quote_live_signals;
create policy r427_signal_read on public.quote_live_signals for select to authenticated
  using ((select public.has_area('quotes', 'view')) and org_id = (select public.current_org_id()));
revoke all on public.quote_live_signals from public;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'anon') then execute 'revoke all on public.quote_live_signals from anon'; end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    execute 'revoke all on public.quote_live_signals from authenticated';
    execute 'grant select on public.quote_live_signals to authenticated';
  end if;
  if exists (select 1 from pg_roles where rolname = 'service_role') then execute 'grant select on public.quote_live_signals to service_role'; end if;
end $$;

-- ---- 2) the trigger: one upsert per saved version, never blocks the save -----------------------------------------------------
create or replace function public._r427_tg_live_signal()
returns trigger language plpgsql security definer set search_path = '' as $$
-- r247-0427: "this event's layout / quotation changed" - a few bytes for Realtime instead of the whole row
declare v_kind text := case when tg_table_name = 'quote_versions' then 'layout' else 'quotation' end;
        v_no integer;
begin
  if new.quote_id is null or new.org_id is null then return null; end if;
  begin
    if v_kind = 'layout' then v_no := (to_jsonb(new) ->> 'version_no')::integer; end if;
    insert into public.quote_live_signals as s (quote_id, kind, org_id, version_no, changed_at)
    values (new.quote_id, v_kind, new.org_id, v_no, now())
    on conflict (quote_id, kind) do update
      set org_id = excluded.org_id, version_no = excluded.version_no, changed_at = excluded.changed_at;
  exception when others then
    raise warning 'r247-0427: live signal skipped (%)', sqlstate;   -- the save itself goes on
  end;
  return null;
end $$;
revoke all on function public._r427_tg_live_signal() from public;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'anon') then execute 'revoke all on function public._r427_tg_live_signal() from anon'; end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then execute 'revoke all on function public._r427_tg_live_signal() from authenticated'; end if;
end $$;

do $$ begin
  if not exists (select 1 from pg_trigger where tgname = 'zz_r427_live_signal' and tgrelid = 'public.quote_versions'::regclass) then
    create trigger zz_r427_live_signal after insert on public.quote_versions
      for each row execute function public._r427_tg_live_signal();
  end if;
  if not exists (select 1 from pg_trigger where tgname = 'zz_r427_live_signal' and tgrelid = 'public.quotation_versions'::regclass) then
    create trigger zz_r427_live_signal after insert on public.quotation_versions
      for each row execute function public._r427_tg_live_signal();
  end if;
end $$;

-- ---- 3) Realtime: the signal table joins the publication (quote_versions / quotation_versions stay for old pages) ------------
do $$ begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime')
     and not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'quote_live_signals') then
    begin execute 'alter publication supabase_realtime add table public.quote_live_signals';
    exception when others then raise notice 'r247-0427: quote_live_signals not added to supabase_realtime (%)', sqlstate; end;
  end if;
end $$;

-- ---- 4) size cap on a NEW floor-plan version (old rows never checked) ---------------------------------------------------------
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'quote_versions_data_size_chk427' and conrelid = 'public.quote_versions'::regclass) then
    alter table public.quote_versions add constraint quote_versions_data_size_chk427
      check (pg_column_size(data) <= 10485760) not valid;
  end if;
end $$;
comment on constraint quote_versions_data_size_chk427 on public.quote_versions is
  'r247-0427 (Q-11): a floor-plan version may hold at most 10 MB of layout data. NOT VALID: rows saved before 0427 are never checked.';

-- ---- 5) free-trial purge (0184): the signal rows go with the studio events ---------------------------------------------------
do $$ declare v_def text; begin
  if to_regprocedure('public._tr184_purge_tables()') is not null then
    v_def := pg_get_functiondef('public._tr184_purge_tables()'::regprocedure);
    if position('''quote_live_signals''' in v_def) = 0 then
      if (length(v_def) - length(replace(v_def, '''inventory_checkouts''', ''))) / length('''inventory_checkouts''') <> 1 then
        raise notice '0427: _tr184_purge_tables has an unexpected body - left unchanged';
      else execute replace(v_def, '''inventory_checkouts''', '''quote_live_signals'', ''inventory_checkouts'''); end if;
    end if;
  end if;
end $$;

-- ---- 6) schema marker (0412) --------------------------------------------------------------------------------------------------
do $$ begin
  if to_regclass('public.helm_schema_markers') is not null then
    insert into public.helm_schema_markers(num, name) values (427, '0427_r247_layout_live_signals') on conflict (num) do nothing;
  end if;
end $$;

notify pgrst, 'reload schema';
