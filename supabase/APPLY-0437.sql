-- APPLY-0437 (R254: fixes from the end-to-end test). Run on STAGING first, then Canada production, then HELM-PROD-MUMBAI. Safe to run twice.
-- Run 0434, 0435 and 0436 BEFORE it; it stops before changing anything if an earlier update is missing.
-- What it does:
--   * making an approval link never turns a paid / approved booking back into "sent"; no "quote runs out" e-mail to a confirmed client;
--   * the approval page gets the event's date as it is now (the approved price is not touched);
--   * the day-of record keeps when somebody arrived and when they left; one row per vendor / person;
--   * rejecting a finished task needs a reason for everybody; verify_task is for signed-in people only.
-- No stored row is changed and nothing is deleted.
-- It waits at most 5 seconds for a lock (then stops with an error and changes nothing - just run it again later).
-- Paste the whole file into the Supabase SQL editor and press Run. The last result lists checks - every ok must be true.
begin;
set local lock_timeout = '5s';
set local statement_timeout = '5min';
-- 0437_r254_e2e_fixes.sql - R254 fixes found in the staging end-to-end test (owner, 25 Nov 2026; staging, then Canada production and
-- Mumbai). Forward-only, additive, safe to run twice. ASCII only. REQUIRES 0262, 0265, 0435, 0436 (and what they need).
--
-- In plain words:
--   A  APPROVAL LINK. Making a link (first one, or a new one after Revoke) for a booking that is already PAID or APPROVED no longer
--      turns it back into "sent". (Seen live: confirmed by the advance, link made later -> "sent" -> the advance note was lost and the
--      "your quote is valid until" reminders could go to a paid client.) Unchanged: none / cancelled -> sent; a changed price
--      (consent_stale) -> sent, the client approves again. The client reminders of 0262 also skip every event that is confirmed
--      (status or stage), when they are queued and again when they are sent.
--   B  EVENT DATE ON THE APPROVAL PAGE. public_get_quote also answers event_date, event_time, event_end_date (the event as it is now).
--      The approved price snapshot (pricing) is not touched by one byte; approval_check_shown and the consent are unchanged.
--      Portal, booklet, pay terms and paid status already answer the live date; proposal and payment schedule show none.
--   C  DAY-OF RECORD (event_day, kind arrival): arrived_at and left_at, kept by the server. First "arrived" sets arrived_at; "left" sets
--      left_at and keeps arrived_at; back from left to arrived keeps the ORIGINAL arrived_at and clears left_at; "expected" or
--      "no_show" clears both; a row made directly as left has left_at only. Nothing is filled in for old rows.
--      One row per (event, kind, person / booking): a unique index - made only when no duplicate rows exist (else a notice, nothing is
--      deleted). The crew link check-in and the office check-in step aside for a row that was made a moment earlier.
--   D  CHECK. Rejecting a finished task needs a reason for EVERY role (hint r436_reason). verify_task is for signed-in people only:
--      execute is taken from public and anon, given to authenticated and service_role (also for a copied database).
-- ZERO DATA LOSS: 2 empty columns, 1 index, 1 trigger, functions. No stored row is changed. Rows that were already turned back to "sent"
--   are listed by 0437-LIST.sql (read only) and put back by 0437-REPAIR.sql - by the owner, not by this file.
-- Every edit of an existing body is ONE exact piece (0432 way; old body kept as <name>__pre0437, server only; unexpected body = left).
-- If 0262, 0265, 0311, 0435 or 0436 is ever pasted again after 0437, paste 0437 again.
-- ROLLBACK (manual): create the functions again from <name>__pre0437; alter table public.event_day disable trigger zz_r437_day_times;
--   drop index public.event_day_ref_uk437;

-- ---- 0) preflight -----------------------------------------------------------------------------------------------------------
do $$ declare f text; begin
  if to_regclass('public.event_day') is null then raise exception 'STOP 0437: event_day is missing'; end if;
  foreach f in array array['public.generate_approval_token__pre0039(uuid)', 'public.quote_validity_tick()', 'public._qv262_claim(integer)',
      'public._r435_waiting(text,text,text)', 'public._r435_public_approval(uuid)', 'public.public_get_quote(uuid)', 'public.crew_check(uuid,text,numeric,numeric,numeric)',
      'public.crew_checkin_office_set(uuid,uuid,date,timestamptz,timestamptz,text)', 'public.verify_task(uuid,boolean,text)',
      'public._r436_verify_task(uuid,boolean,text)', 'public._is_system_change()'] loop
    if to_regprocedure(f) is null then raise exception 'STOP 0437: % is missing - an earlier update is not on this database', f; end if;
  end loop;
end $$;

-- ---- 1) keep helper (same shape as _r436_keep) -----------------------------------------------------------------------------------
create or replace function public._r437_keep(p_fn text)
returns void language plpgsql volatile security definer set search_path = '' as $$
declare v_oid oid := to_regprocedure(p_fn); v_name text; v_types text; v_def text; v_pre text; r text;
begin
  if v_oid is null then return; end if;
  select p.proname, oidvectortypes(p.proargtypes) into v_name, v_types from pg_proc p where p.oid = v_oid;
  v_pre := format('public.%I(%s)', v_name || '__pre0437', v_types);
  if to_regprocedure(v_pre) is null then
    v_def := pg_get_functiondef(v_oid);
    v_def := regexp_replace(v_def, '^CREATE OR REPLACE FUNCTION public\.' || v_name || '\(',
                            'CREATE OR REPLACE FUNCTION public.' || v_name || '__pre0437(');
    if position(v_name || '__pre0437(' in v_def) = 0 then raise exception 'r254-0437: could not keep %', p_fn; end if;
    execute v_def;
  end if;
  execute format('revoke all on function %s from public', v_pre);
  foreach r in array array['anon', 'authenticated', 'service_role'] loop
    if exists (select 1 from pg_roles where rolname = r) then execute format('revoke all on function %s from %I', v_pre, r); end if;
  end loop;
end $$;

-- ---- 2) small helpers (server only) ----------------------------------------------------------------------------------------------
-- may the client still be reminded that the quote runs out? (sent, and the event is not confirmed - status or stage)
create or replace function public._r437_client_open(p_quote uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  -- r254-0437
  select coalesce((select q.approval_status = 'sent' and public._r435_waiting(q.approval_status, q.status, q.lifecycle_stage)
                     from public.quotes q where q.id = p_quote), false);
$$;
-- the event's date as it is now, for the holder of the approval link (only added after the link itself was accepted)
create or replace function public._r437_public_dates(p_token uuid)
returns jsonb language sql stable security definer set search_path = '' as $$
  -- r254-0437
  select coalesce((select jsonb_build_object('event_date', to_jsonb(q) -> 'event_date', 'event_time', to_jsonb(q) -> 'event_time',
                                             'event_end_date', to_jsonb(q) -> 'event_end_date')
                     from public.quotes q where p_token is not null and q.approval_token = p_token), '{}'::jsonb);
$$;

-- ---- 3) exact text edits (each piece must be there exactly once, else the body is left as it is) --------------------------------------
do $do$
declare r record; v_def text;
begin
  for r in select * from (values
    ('public.generate_approval_token__pre0039(uuid)', 'approval_status = ''sent'', updated_at = now()',
       'approval_status = case when approval_status in (''paid'', ''approved'') and not coalesce(consent_stale, false) then approval_status else ''sent'' end /* r254-0437 */, updated_at = now()'),
    ('public.quote_validity_tick()', 'and r.approval_status = ''sent'' and not r.is_demo',
       'and r.approval_status = ''sent'' and not r.is_demo and public._r437_client_open(r.quote_id) /* r254-0437 */'),
    ('public._qv262_claim(integer)', 'and (c ->> ''client_reminders'')::boolean',
       'and (c ->> ''client_reminders'')::boolean and public._r437_client_open(r.quote_id) /* r254-0437 */'),
    ('public.public_get_quote(uuid)', '|| public._r435_public_approval(p_token)',
       '|| public._r437_public_dates(p_token) /* r254-0437 */ || public._r435_public_approval(p_token)'),
    ('public.crew_check(uuid,text,numeric,numeric,numeric)', '''arrived'', ''self check-in'')',
       '''arrived'', ''self check-in'') on conflict do nothing /* r254-0437 */'),
    ('public.crew_checkin_office_set(uuid,uuid,date,timestamptz,timestamptz,text)', '''entered by the office'', auth.uid())',
       '''entered by the office'', auth.uid()) on conflict do nothing /* r254-0437 */')
  ) v(fn, a, b) loop
    v_def := pg_get_functiondef(to_regprocedure(r.fn));
    continue when position('r254-0437' in v_def) > 0;            -- already done (second run)
    if (length(v_def) - length(replace(v_def, r.a, ''))) / length(r.a) <> 1 then raise notice '0437: % has an unexpected body - left unchanged', r.fn; continue; end if;
    perform public._r437_keep(r.fn);
    execute replace(v_def, r.a, r.b);
  end loop;
end $do$;

-- ---- 4) day-of record: when they came and when they left -------------------------------------------------------------------------------
alter table public.event_day add column if not exists arrived_at timestamptz, add column if not exists left_at timestamptz;
create or replace function public._r437_tg_day_times()
returns trigger language plpgsql volatile security definer set search_path = '' as $$
-- r254-0437: both times belong to the server (a value sent by the page is ignored). Only kind = arrival.
declare v_a timestamptz; v_l timestamptz; v_old text;
begin
  if tg_op = 'INSERT' then
    -- a restore / copy keeps its own times
    if public._is_system_change() and (new.arrived_at is not null or new.left_at is not null) then return new; end if;
  else
    v_a := old.arrived_at; v_l := old.left_at; v_old := old.status;
  end if;
  if new.kind is distinct from 'arrival' then v_a := null; v_l := null;
  elsif new.status = 'arrived' then
    if tg_op = 'INSERT' or v_old is distinct from 'arrived' then v_a := coalesce(v_a, now()); end if;
    v_l := null;
  elsif new.status = 'left' then
    if tg_op = 'INSERT' or v_old is distinct from 'left' then v_l := now(); end if;
  elsif new.status in ('expected', 'no_show') then v_a := null; v_l := null;
  end if;
  new.arrived_at := v_a; new.left_at := v_l;
  return new;
end $$;
do $$ begin
  if not exists (select 1 from pg_trigger where tgrelid = 'public.event_day'::regclass and tgname = 'zz_r437_day_times') then
    create trigger zz_r437_day_times before insert or update of status, kind, arrived_at, left_at on public.event_day
      for each row execute function public._r437_tg_day_times();
  end if;
  -- two people marking the same vendor at once: one row (never deletes; skipped while duplicates exist)
  if to_regclass('public.event_day_ref_uk437') is null then
    if exists (select 1 from public.event_day d where d.ref_id is not null group by d.quote_id, d.kind, d.ref_id having count(*) > 1) then
      raise notice '0437: event_day has duplicate rows for the same person / booking - the unique guard was left out (see 0437-LIST.sql part 2)';
    else
      create unique index event_day_ref_uk437 on public.event_day (quote_id, kind, ref_id) where ref_id is not null;
    end if;
  end if;
end $$;

-- ---- 5) a rejection needs a reason, whoever checks ----------------------------------------------------------------------------------------
do $$ begin
  if position('r254-0437' in pg_get_functiondef('public.verify_task(uuid,boolean,text)'::regprocedure)) = 0 then
    perform public._r437_keep('public.verify_task(uuid,boolean,text)'); end if;
end $$;
create or replace function public._r437_verify_task(p_id uuid, p_pass boolean, p_note text)
returns public.event_tasks language plpgsql volatile security definer set search_path = '' as $$
-- r254-0437: the reason first (it says nothing about the task), then every check of 0436 / 0311 unchanged
begin
  if p_pass is not true and nullif(btrim(coalesce(p_note, '')), '') is null then
    raise exception 'Please write what has to be done again.' using errcode = '22023', hint = 'r436_reason';
  end if;
  return public._r436_verify_task(p_id, p_pass, p_note);
end $$;
create or replace function public.verify_task(p_id uuid, p_pass boolean, p_note text default null)
returns public.event_tasks language sql security definer set search_path = '' as $$select public._r437_verify_task(p_id, p_pass, p_note) /* r92-task-lifecycle-0311 r253-0436 (over _r436_verify_task) r254-0437 */$$;

-- ---- 6) grants -----------------------------------------------------------------------------------------------------------------------------
do $$ declare f text; r text; begin
  foreach f in array array['public._r437_keep(text)', 'public._r437_client_open(uuid)', 'public._r437_public_dates(uuid)', 'public._r437_tg_day_times()',
      'public._r437_verify_task(uuid,boolean,text)'] loop
    execute format('revoke all on function %s from public', f);
    foreach r in array array['anon', 'authenticated', 'service_role'] loop
      if exists (select 1 from pg_roles where rolname = r) then execute format('revoke all on function %s from %I', f, r); end if;
    end loop;
  end loop;
  revoke all on function public.verify_task(uuid, boolean, text) from public;
  if exists (select 1 from pg_roles where rolname = 'anon') then revoke all on function public.verify_task(uuid, boolean, text) from anon; end if;
  foreach r in array array['authenticated', 'service_role'] loop
    if exists (select 1 from pg_roles where rolname = r) then execute format('grant execute on function public.verify_task(uuid, boolean, text) to %I', r); end if;
  end loop;
end $$;

do $$ begin
  if to_regclass('public.helm_schema_markers') is not null then
    insert into public.helm_schema_markers(num, name) values (437, '0437_r254_e2e_fixes') on conflict (num) do nothing;
  end if;
end $$;

notify pgrst, 'reload schema';

-- ---- checks (every ok must be true) --------------------------------------------------------------------------------------
select item, ok from (values
  ('01 making a link keeps paid / approved', coalesce(position('r254-0437' in pg_get_functiondef(to_regprocedure('public.generate_approval_token__pre0039(uuid)'))) > 0, false)),
  ('02 validity reminders skip confirmed events (queueing)', coalesce(position('r254-0437' in pg_get_functiondef(to_regprocedure('public.quote_validity_tick()'))) > 0, false)),
  ('03 validity reminders skip confirmed events (sending)', coalesce(position('r254-0437' in pg_get_functiondef(to_regprocedure('public._qv262_claim(integer)'))) > 0, false)),
  ('04 approval page gets the live date, same access', coalesce(position('_r437_public_dates' in pg_get_functiondef(to_regprocedure('public.public_get_quote(uuid)'))) > 0, false)
     and has_function_privilege('anon', 'public.public_get_quote(uuid)', 'execute')),
  ('05 day-of record: arrived_at, left_at and the trigger', (select count(*) = 2 from information_schema.columns where table_schema = 'public' and table_name = 'event_day' and column_name in ('arrived_at', 'left_at'))
     and exists (select 1 from pg_trigger where tgrelid = 'public.event_day'::regclass and tgname = 'zz_r437_day_times' and tgenabled = 'O')),
  ('06 one row per person / booking' || case when to_regclass('public.event_day_ref_uk437') is null then ' - LEFT OUT: duplicate rows exist (0437-LIST.sql part 2)' else '' end,
     to_regclass('public.event_day_ref_uk437') is not null
     or exists (select 1 from public.event_day d where d.ref_id is not null group by d.quote_id, d.kind, d.ref_id having count(*) > 1)),
  ('07 crew link and office check-in step aside for an existing row', coalesce(position('r254-0437' in pg_get_functiondef(to_regprocedure('public.crew_check(uuid,text,numeric,numeric,numeric)'))) > 0, false)
     and coalesce(position('r254-0437' in pg_get_functiondef(to_regprocedure('public.crew_checkin_office_set(uuid,uuid,date,timestamptz,timestamptz,text)'))) > 0, false)),
  ('08 a rejection needs a reason for every role', position('_r437_verify_task' in pg_get_functiondef('public.verify_task(uuid,boolean,text)'::regprocedure)) > 0
     and position('_r436_verify_task' in pg_get_functiondef('public._r437_verify_task(uuid,boolean,text)'::regprocedure)) > 0),
  ('09 verify_task: signed-in people and the server only', not has_function_privilege('anon', 'public.verify_task(uuid,boolean,text)', 'execute')
     and has_function_privilege('authenticated', 'public.verify_task(uuid,boolean,text)', 'execute') and has_function_privilege('service_role', 'public.verify_task(uuid,boolean,text)', 'execute')
     and not exists (select 1 from pg_proc p, aclexplode(p.proacl) a where p.oid = 'public.verify_task(uuid,boolean,text)'::regprocedure and a.grantee = 0)),
  ('10 new functions and kept bodies server only, empty search_path on the new ones', (select count(*) = 5 and bool_and(p.prosecdef and p.proconfig @> array['search_path=""']
     and not has_function_privilege('anon', p.oid, 'execute') and not has_function_privilege('authenticated', p.oid, 'execute'))
     from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname like '\_r437\_%')
     and (select bool_and(not has_function_privilege('anon', p.oid, 'execute') and not has_function_privilege('authenticated', p.oid, 'execute'))
     from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname like '%\_\_pre0437')),
  ('11 schema marker 437 recorded (or no 0412 marker table)',
     to_regclass('public.helm_schema_markers') is null or exists (select 1 from public.helm_schema_markers where num = 437))
) v(item, ok) order by item;
commit;
