-- APPLY-0390 (audit C, 18 Nov 2026: a vendor payment sent twice at the same moment no longer shows a false error).
-- Run on STAGING first, then production. Safe to run twice. Needs 0124 + 0156 + 0373 first.
-- What it does: when the same vendor payment arrives twice at once (two tabs, or a phone resending while the first
-- request is still running), the second one now waits for the first and answers "Already recorded" instead of a
-- "duplicate key" error. One line is added inside two payment functions; no table, row or permission is changed.
-- Paste the whole file into the Supabase SQL editor and press Run. The last result lists checks - every ok must be true.
begin;
-- ---- 0) preflight ----------------------------------------------------------------------------------------------------------
do $$ begin
  if to_regprocedure('public.vendor_bill_pay(uuid,numeric,numeric,text,date,text,text,text)') is null then
    raise exception 'STOP 0390: vendor_bill_pay missing - run 0373 first'; end if;
  if to_regprocedure('public.record_vendor_payout__pre0156(uuid,numeric,date,text,text,text)') is null then
    raise exception 'STOP 0390: record_vendor_payout__pre0156 missing - run 0124 and 0156 first'; end if;
end $$;

-- ---- 1) the same-key wait, added right after the key-length check of each function ---------------------------------------------
do $$
declare
  v_def text; v_new text; f regprocedure; v_anchor text;
  v_lock constant text := ' if v_key is not null then perform pg_advisory_xact_lock(hashtextextended(''helm:vpay:'' || coalesce(v_org::text, '''') || '':'' || v_key, 0)); end if; /* r218-0390: a parallel request with the same key finishes first */';
begin
  foreach f in array array['public.vendor_bill_pay(uuid,numeric,numeric,text,date,text,text,text)'::regprocedure,
                           'public.record_vendor_payout__pre0156(uuid,numeric,date,text,text,text)'::regprocedure] loop
    v_def := pg_get_functiondef(f);
    continue when position('r218-0390' in v_def) > 0;          -- already patched (re-run)
    v_anchor := case when f = 'public.vendor_bill_pay(uuid,numeric,numeric,text,date,text,text,text)'::regprocedure
      then 'if v_key is not null and length(v_key) > 90 then raise exception ''idempotency key too long'' using errcode = ''22023''; end if;'
      else 'if v_key is not null and length(v_key) > 100 then raise exception ''idempotency key too long'' using errcode = ''22023''; end if;' end;
    if (length(v_def) - length(replace(v_def, v_anchor, ''))) / length(v_anchor) <> 1 then
      raise notice '0390: % has an unexpected body - left unchanged', f;
      continue;
    end if;
    v_new := replace(v_def, v_anchor, v_anchor || v_lock);
    execute v_new;                                              -- create or replace: owner, grants, search_path kept
  end loop;
end $$;

select item, ok from (values
  ('01 vendor_bill_pay waits on the same-key lock (r218-0390) and still carries r190-0373',
     (select position('r218-0390' in p.prosrc) > 0 and position('r190-0373' in p.prosrc) > 0 from pg_proc p
       where p.oid = to_regprocedure('public.vendor_bill_pay(uuid,numeric,numeric,text,date,text,text,text)'))),
  ('02 record_vendor_payout__pre0156 waits on the same-key lock (r218-0390) and still carries vendor-bills-0124',
     (select position('r218-0390' in p.prosrc) > 0 and position('vendor-bills-0124' in p.prosrc) > 0 from pg_proc p
       where p.oid = to_regprocedure('public.record_vendor_payout__pre0156(uuid,numeric,date,text,text,text)'))),
  ('03 the lock line is there exactly once in each',
     (select bool_and((length(p.prosrc) - length(replace(p.prosrc, 'r218-0390', ''))) / length('r218-0390') = 1) from pg_proc p
       where p.oid in (to_regprocedure('public.vendor_bill_pay(uuid,numeric,numeric,text,date,text,text,text)'),
                       to_regprocedure('public.record_vendor_payout__pre0156(uuid,numeric,date,text,text,text)')))),
  ('04 permissions unchanged: the page functions for signed-in people, the inner one not for the app',
     (not exists (select 1 from pg_roles where rolname = 'authenticated')
      or (has_function_privilege('authenticated', 'public.vendor_bill_pay(uuid,numeric,numeric,text,date,text,text,text)', 'execute')
          and has_function_privilege('authenticated', 'public.record_vendor_payout(uuid,numeric,date,text,text,text)', 'execute')
          and not has_function_privilege('authenticated', 'public.record_vendor_payout__pre0156(uuid,numeric,date,text,text,text)', 'execute')))
     and (not exists (select 1 from pg_roles where rolname = 'anon')
          or not has_function_privilege('anon', 'public.vendor_bill_pay(uuid,numeric,numeric,text,date,text,text,text)', 'execute'))),
  ('05 both still security definer with an empty search_path',
     (select bool_and(p.prosecdef and coalesce(array_to_string(p.proconfig, ','), '') ~ 'search_path=(""|$)') from pg_proc p
       where p.oid in (to_regprocedure('public.vendor_bill_pay(uuid,numeric,numeric,text,date,text,text,text)'),
                       to_regprocedure('public.record_vendor_payout__pre0156(uuid,numeric,date,text,text,text)'))))
) v(item, ok) order by item;
commit;
notify pgrst, 'reload schema';
