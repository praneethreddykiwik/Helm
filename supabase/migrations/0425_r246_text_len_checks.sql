-- 0425_r246_text_len_checks.sql - CANONICAL forward-only. R246 (fix plan Phase 9, owner approved 20 Nov 2026; DATA-01).
-- REQUIRES nothing new (every table / column is looked up first; a missing one is skipped).
--
-- In plain words:
--   The browser limits how long a typed text can be, but the database only enforced that on some columns. A script (or a
--   bug) could store a megabyte in, say, a checklist title. This file adds a length limit to the remaining free-text
--   columns people type into (names, titles, notes, categories, reasons...). The limits are generous - well above what any
--   screen lets you type - so no normal save is ever refused.
--   OLD ROWS ARE NEVER TOUCHED:
--     * every limit is a NOT VALID check: Postgres checks new and changed rows only, never the rows already stored;
--     * before adding a limit, the file COUNTS (read-only) the stored rows already longer than it. If there is even one,
--       that column gets NO limit (so that old row can still be saved later) and the column is listed in
--       public.r425_text_len_report() - the owner decides later. Nothing is shortened, cut or rewritten.
--   r425_text_len_report() (owner, SQL editor; read-only): every column in the list, its limit, whether the limit is on
--   and how many stored rows are longer (numbers only - never the text itself).
--
-- ZERO DATA LOSS: additive + idempotent. Only NOT VALID check constraints (added once, by name) and two read-only
-- functions. No row is read out, changed or deleted; no column or table changed. Safe to run twice.
-- ============================================================================

-- the list: table, column, the longest text allowed (characters)
create or replace function public._r425_text_limits()
returns table(tbl text, col text, lim integer) language sql immutable set search_path = '' as $$
  -- r246-0425: the free-text columns without any length limit before this file (generous limits). Left out on purpose:
  -- columns that already have a check (quotes.archived_reason / deleted_reason and event_checklist.section = fixed words;
  -- vendor_bills.bill_no / description = 80 / 500; event_costs / expense_claims void_reason = 500, 0404)
  select x.t, x.c, x.l from (values
    ('quotes', 'event_type', 120),
    ('leads', 'event_type', 120), ('leads', 'source', 200),
    ('vendors', 'category', 200),
    ('crew_members', 'department', 120), ('crew_members', 'role', 120),
    ('inventory_items', 'category', 120), ('inventory_items', 'unit', 40),
    ('event_tasks', 'category', 120), ('event_tasks', 'verify_note', 4000),
    ('event_costs', 'category', 200),
    ('vendor_bills', 'void_reason', 1000),
    ('event_checklist', 'title', 500), ('event_checklist', 'detail', 8000), ('event_checklist', 'owner', 200),
    ('event_discovery', 'attendees', 2000), ('event_discovery', 'location', 500), ('event_discovery', 'notes', 20000),
    ('event_issues', 'owner', 200),
    ('event_plan', 'access_notes', 8000), ('event_plan', 'venue_address', 1000), ('event_plan', 'venue_contact', 500),
    ('event_plan', 'venue_name', 300), ('event_plan', 'package', 300),
    ('event_resource_needs', 'label', 300), ('event_resource_needs', 'note', 4000), ('event_resource_needs', 'skill', 120),
    ('run_sheet_items', 'title', 500), ('run_sheet_items', 'note', 8000), ('run_sheet_items', 'location', 500), ('run_sheet_items', 'owner', 200),
    ('nurture', 'occasion', 300),
    ('organizations', 'name', 200), ('organizations', 'location', 500), ('organizations', 'business_email', 320),
    ('profiles', 'full_name', 200), ('profiles', 'email', 320)
  ) x(t, c, l);
$$;

-- the constraint name for one column (<= 63 characters)
create or replace function public._r425_con_name(p_tbl text, p_col text)
returns text language sql immutable set search_path = '' as $$
  select left(p_tbl || '_' || p_col, 52) || '_len425';
$$;

-- read-only report: limit on? stored rows longer than the limit (numbers only)
create or replace function public.r425_text_len_report()
returns table(tbl text, col text, lim integer, limit_on boolean, rows_longer bigint)
language plpgsql stable security definer set search_path = '' as $$
-- r246-0425: owner report (SQL editor). Counts only - never the text.
declare x record; n bigint;
begin
  for x in select * from public._r425_text_limits() order by 1, 2 loop
    if not exists (select 1 from information_schema.columns c where c.table_schema = 'public' and c.table_name = x.tbl
                     and c.column_name = x.col and c.data_type in ('text', 'character varying')) then
      continue;
    end if;
    execute format('select count(*) from public.%I where char_length(%I) > %s', x.tbl, x.col, x.lim) into n;
    tbl := x.tbl; col := x.col; lim := x.lim; rows_longer := n;
    limit_on := exists (select 1 from pg_constraint k where k.conname = public._r425_con_name(x.tbl, x.col)
                          and k.conrelid = to_regclass('public.' || quote_ident(x.tbl)));
    return next;
  end loop;
end $$;

-- add each limit once: only when the column exists, is text, and NO stored row is longer (counted first, read-only)
do $$ declare x record; n bigint; k text; begin
  for x in select * from public._r425_text_limits() order by 1, 2 loop
    k := public._r425_con_name(x.tbl, x.col);
    if not exists (select 1 from information_schema.columns c where c.table_schema = 'public' and c.table_name = x.tbl
                     and c.column_name = x.col and c.data_type in ('text', 'character varying')) then
      continue;
    end if;
    if exists (select 1 from pg_constraint c where c.conname = k and c.conrelid = to_regclass('public.' || quote_ident(x.tbl))) then
      continue;
    end if;
    execute format('select count(*) from public.%I where char_length(%I) > %s', x.tbl, x.col, x.lim) into n;
    if n > 0 then
      raise notice '0425: %.% has % stored row(s) longer than % - no limit added (old rows left as they are)', x.tbl, x.col, n, x.lim;
      continue;
    end if;
    execute format('alter table public.%I add constraint %I check (%I is null or char_length(%I) <= %s) not valid',
                   x.tbl, k, x.col, x.col, x.lim);
  end loop;
end $$;

revoke all on function public.r425_text_len_report() from public;
revoke all on function public._r425_text_limits() from public;
revoke all on function public._r425_con_name(text, text) from public;
do $$ declare r text; begin
  foreach r in array array['anon', 'authenticated'] loop
    if exists (select 1 from pg_roles where rolname = r) then
      execute format('revoke all on function public.r425_text_len_report() from %I', r);
      execute format('revoke all on function public._r425_text_limits() from %I', r);
      execute format('revoke all on function public._r425_con_name(text, text) from %I', r);
    end if;
  end loop;
end $$;

do $$ begin
  if to_regclass('public.helm_schema_markers') is not null then
    insert into public.helm_schema_markers(num, name) values (425, '0425_r246_text_len_checks') on conflict (num) do nothing;
  end if;
end $$;
