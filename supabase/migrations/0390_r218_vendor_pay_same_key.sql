-- 0390_r218_vendor_pay_same_key.sql - audit C (reliability, 18 Nov 2026). Forward-only, additive, safe to run twice. ASCII only.
-- REQUIRES 0124 + 0156 (record_vendor_payout -> record_vendor_payout__pre0156), 0373 (vendor_bill_pay).
--
-- In plain words:
--   Every vendor payment carries a "this is the same payment" key, so pressing Record twice never pays twice. But when
--   two requests with the SAME key arrive at the same time (two tabs, or the phone sends the request again while the
--   first one is still running), the second one looked for the key BEFORE the first had finished saving, did not find
--   it, waited for the bill, and then hit the database own "this key is already used" rule. The money was right (one
--   payment), but the person saw an error ("duplicate key value ...") for a payment that WAS recorded - or, with a
--   different amount, "that would overpay the bill".
--   Now each of the two payment functions waits for any other request with the same key first (a lock on the key, held
--   until that request is finished), so the second request finds the saved payment and answers "Already recorded" like
--   any repeat. Nothing else changes: same checks, same answers, same permissions.
--
-- Changes: one line added inside public.vendor_bill_pay and public.record_vendor_payout__pre0156 (patched in place; the
-- body is otherwise unchanged, owner / grants / search_path kept). No table, column, row, policy or grant is changed.
-- Undo (only if ever needed, no data involved): re-run 0373 section 4 (vendor_bill_pay) and 0124 (record_vendor_payout
-- body, then 0156 renames it again) - or simply leave it: the extra line only makes a same-key request wait.

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

notify pgrst, 'reload schema';
