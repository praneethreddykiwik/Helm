-- 0367_r177_plain_dash_reissue.sql - R177 prod catch-up: three functions re-issued with plain dashes. Forward-only, additive, safe to run twice.
-- REQUIRES 0032 (tg_refund_maker_checker), 0033 (tg_guard_task_verify), 0055 (_mp_mobile).
--
-- In plain words:
--   The prod checker (16 Nov) showed these three function bodies differ from the repo on BOTH staging and production,
--   although their logic markers are there. Their texts held a long dash (in an error message or a comment). When an
--   APPLY file is copied without UTF-8 (pbcopy without LANG=en_US.UTF-8) that dash is garbled, so the stored text
--   differs and a refund / phone error message can show odd characters to the user. Same logic, nothing else changes.
--   Each function is re-issued ONLY when the live body is the known one (its rescore2-0032 / rescore3-0033 / 0055 marker),
--   with plain ASCII dashes and a r177-0367 marker. A body that is not the known one is left unchanged (NOTICE).
--   1  tg_refund_maker_checker  (refunds start as pending; someone else approves)
--   2  tg_guard_task_verify     (QC columns only via verify_task; runs as the caller)
--   3  _mp_mobile               (Indian or +country mobile numbers)
--
-- ZERO DATA LOSS: no table, column, row, trigger, policy or grant is changed. The previous bodies are kept once as
-- NAME__pre0367 with no privilege for anyone. Rollback: drop the function and rename the kept copy back.

create or replace function public._r367_keep(p_fn text)
returns void language plpgsql volatile security definer set search_path = '' as $k$
declare v_oid oid := to_regprocedure(p_fn); v_name text; v_types text; v_def text; v_pre text;
begin
  if v_oid is null then return; end if;
  select p.proname, oidvectortypes(p.proargtypes) into v_name, v_types from pg_proc p where p.oid = v_oid;
  v_pre := format('public.%I(%s)', v_name || '__pre0367', v_types);
  if to_regprocedure(v_pre) is not null then return; end if;
  v_def := pg_get_functiondef(v_oid);
  v_def := regexp_replace(v_def, '^CREATE OR REPLACE FUNCTION public\.' || v_name || '\(',
                          'CREATE OR REPLACE FUNCTION public.' || v_name || '__pre0367(');
  if position(v_name || '__pre0367(' in v_def) = 0 then raise exception 'r177-0367: could not keep %', p_fn; end if;
  execute v_def;
  execute format('revoke all on function %s from public', v_pre);
  if exists (select 1 from pg_roles where rolname = 'anon') then execute format('revoke all on function %s from anon', v_pre); end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then execute format('revoke all on function %s from authenticated', v_pre); end if;
end $k$;
revoke all on function public._r367_keep(text) from public;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'anon') then revoke all on function public._r367_keep(text) from anon; end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then revoke all on function public._r367_keep(text) from authenticated; end if;
end $$;

-- ---- 1) refund maker-checker ----
do $do$ declare v_src text; begin
  select p.prosrc into v_src from pg_proc p where p.oid = to_regprocedure('public.tg_refund_maker_checker()');
  if v_src is null then raise notice '0367: public.tg_refund_maker_checker() is missing here - skipped'; return; end if;
  if position('r177-0367' in v_src) > 0 then return; end if;
  if position('rescore2-0032' in v_src) = 0 then
    raise notice '0367: public.tg_refund_maker_checker() is not the known body on this database - left unchanged'; return;
  end if;
  perform public._r367_keep('public.tg_refund_maker_checker()');
  execute $fn$
create or replace function public.tg_refund_maker_checker()
returns trigger language plpgsql set search_path = '' as $$
-- r177-0367 (same logic as rescore2-0032, plain dashes)
begin
  if current_user in ('anon', 'authenticated') then
    if tg_op = 'INSERT' then
      new.created_by := auth.uid();
      -- rescore2-0032: an entry starts as pending for everyone (admin included);
      -- approving it is a separate update, checked below.
      if new.status is distinct from 'pending' then
        raise exception 'A new refund starts as pending - approve it as a separate step.' using errcode = '42501';
      end if;
    else
      if new.created_by is distinct from old.created_by then
        raise exception 'who entered a refund can''t be changed' using errcode = '42501';
      end if;
      if new.status is distinct from old.status and new.status in ('approved', 'processed')
         and old.created_by is not null and old.created_by = auth.uid()
         and coalesce(public.user_role(), '') <> 'admin' then
        raise exception 'Someone else must approve a refund you entered.' using errcode = 'P0001';
      end if;
    end if;
  end if;
  return new;
end $$;
$fn$;
  execute 'revoke all on function public.tg_refund_maker_checker() from public';
  if exists (select 1 from pg_roles where rolname = 'anon') then execute 'revoke all on function public.tg_refund_maker_checker() from anon'; end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then execute 'revoke all on function public.tg_refund_maker_checker() from authenticated'; end if;
end $do$;

-- ---- 2) QC verify guard ----
do $do$ declare v_src text; begin
  select p.prosrc into v_src from pg_proc p where p.oid = to_regprocedure('public.tg_guard_task_verify()');
  if v_src is null then raise notice '0367: public.tg_guard_task_verify() is missing here - skipped'; return; end if;
  if position('r177-0367' in v_src) > 0 then return; end if;
  if position('rescore3-0033' in v_src) = 0 then
    raise notice '0367: public.tg_guard_task_verify() is not the known body on this database - left unchanged'; return;
  end if;
  perform public._r367_keep('public.tg_guard_task_verify()');
  execute $fn$
create or replace function public.tg_guard_task_verify()
returns trigger language plpgsql security invoker set search_path = '' as $tg$
-- r177-0367 (same logic as rescore3-0033, plain dashes)
-- rescore3-0033: SECURITY INVOKER - current_user is the API role on a direct
-- write; verify_task() (SECURITY DEFINER) runs as its owner and passes.
begin
  if current_user in ('anon', 'authenticated') then
    if tg_op = 'INSERT' then
      if new.verify_status not in ('unverified', 'pending') or new.verified_by is not null or new.verified_at is not null then
        raise exception 'verify columns are set only via verify_task()' using errcode = '42501';
      end if;
    elsif new.verify_status is distinct from old.verify_status
       or new.verified_by is distinct from old.verified_by
       or new.verified_at is distinct from old.verified_at then
      -- the one automatic step: completing a task queues it for QC (tg_task_verify)
      if not (new.verify_status = 'pending' and old.verify_status = 'unverified'
              and new.status = 'completed' and old.status is distinct from 'completed'
              and new.verified_by is not distinct from old.verified_by
              and new.verified_at is not distinct from old.verified_at) then
        raise exception 'verify columns are set only via verify_task()' using errcode = '42501';
      end if;
    end if;
  end if;
  -- whoever passes / rejects is the signed-in checker
  if new.verify_status in ('passed', 'rejected') and auth.uid() is not null
     and (tg_op = 'INSERT' or new.verify_status is distinct from old.verify_status) then
    new.verified_by := auth.uid();
  end if;
  return new;
end $tg$;
$fn$;
  execute 'alter function public.tg_guard_task_verify() security invoker';
  execute 'revoke all on function public.tg_guard_task_verify() from public';
  if exists (select 1 from pg_roles where rolname = 'anon') then execute 'revoke all on function public.tg_guard_task_verify() from anon'; end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then execute 'revoke all on function public.tg_guard_task_verify() from authenticated'; end if;
end $do$;

-- ---- 3) mobile number rule ----
do $do$ declare v_src text; begin
  select p.prosrc into v_src from pg_proc p where p.oid = to_regprocedure('public._mp_mobile(text,text)');
  if v_src is null then raise notice '0367: public._mp_mobile(text,text) is missing here - skipped'; return; end if;
  if position('r177-0367' in v_src) > 0 then return; end if;
  if position('including the country code' in v_src) = 0 then
    raise notice '0367: public._mp_mobile(text,text) is not the known body on this database - left unchanged'; return;
  end if;
  perform public._r367_keep('public._mp_mobile(text,text)');
  execute $fn$
create or replace function public._mp_mobile(p_val text, p_label text)
returns text language plpgsql immutable set search_path = '' as $$
-- r177-0367 (same rule as 0055 including the country code, plain dashes)
declare v text := btrim(coalesce(p_val, '')); d text;
begin
  if v = '' then return null; end if;
  if v !~ '^\+?[0-9 ().-]{6,24}$' then
    raise exception '% must be a valid mobile number.', p_label using errcode = '22023'; end if;
  d := regexp_replace(v, '[^0-9]', '', 'g');
  if left(v, 1) = '+' and left(d, 2) <> '91' then
    if d !~ '^[1-9][0-9]{6,14}$' then
      raise exception '% must be 7-15 digits including the country code.', p_label using errcode = '22023'; end if;
    return '+' || d;
  end if;
  if char_length(d) = 12 and left(d, 2) = '91' then d := substr(d, 3);
  elsif char_length(d) = 11 and left(d, 1) = '0' then d := substr(d, 2);
  end if;
  if d !~ '^[6-9][0-9]{9}$' then
    raise exception '% must be a 10-digit Indian mobile number starting with 6, 7, 8 or 9.', p_label using errcode = '22023'; end if;
  return '+91' || d;
end $$;
$fn$;
end $do$;

-- VERIFY every line should say true
select item, ok from (values
  ('01 refund maker-checker: known logic, plain dashes', coalesce((select position('rescore2-0032' in p.prosrc) > 0 and position('r177-0367' in p.prosrc) > 0 from pg_proc p where p.oid = to_regprocedure('public.tg_refund_maker_checker()')), false)),
  ('02 QC verify guard: known logic, runs as the caller', coalesce((select position('rescore3-0033' in p.prosrc) > 0 and position('r177-0367' in p.prosrc) > 0 and not p.prosecdef from pg_proc p where p.oid = to_regprocedure('public.tg_guard_task_verify()')), false)),
  ('03 mobile rule: +country numbers, plain dashes', coalesce((select position('including the country code' in p.prosrc) > 0 and position('r177-0367' in p.prosrc) > 0 from pg_proc p where p.oid = to_regprocedure('public._mp_mobile(text,text)')), false)),
  ('04 kept copies callable by nobody', not coalesce(has_function_privilege('authenticated', to_regprocedure('public._mp_mobile__pre0367(text,text)'), 'execute'), false)
     and not coalesce(has_function_privilege('authenticated', to_regprocedure('public._r367_keep(text)'), 'execute'), false))
) v(item, ok) order by item;
