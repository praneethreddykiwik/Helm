-- APPLY-0352 (R154f sign-in page e-mail check limits). Run on STAGING first, then production. Safe to run twice.
begin;
-- 0352_r154f_email_probe_limits.sql - R154f per-network and per-address limits on the two sign-in page e-mail checks. Forward-only, additive, safe to run twice.
-- signup_email_preauthorised and staff_google_only_for stay callable by visitors (the sign-up and sign-in pages ask before anyone is signed in).
-- Each now counts every ask in auth_rate_hits (rate_hit, the 0050 counter also used by 0298 and 0341) - 20 per 10 minutes per network
-- and 20 per 10 minutes per address. Over a limit, or when the counter cannot be written, the answer is false - the same answer the
-- pages already treat as no (early reserved message, password form shown), and the database hooks stay the real gate.
-- Old bodies kept once as NAME__pre0352 with no app privilege. Signatures, return types, SECURITY DEFINER, search_path and grants unchanged.
-- Nothing dropped or deleted. Notes: supabase/migrations/MANIFEST entry 0352.
do $$
declare f record; v_src text;
begin
  if to_regprocedure('public.rate_hit(text,text,integer,integer)') is null then raise exception 'STOP 0352: rate_hit missing - run 0050 first'; end if;
  if to_regprocedure('public._r57_client_net()') is null then raise exception 'STOP 0352: _r57_client_net missing - run 0298 first'; end if;
  for f in select * from (values
      ('public.signup_email_preauthorised(text)', 'r57-0298'), ('public.staff_google_only_for(text)', 'r39-staff-google-0288')) x(fn, mark)
  loop
    if to_regprocedure(f.fn) is null then raise exception 'STOP 0352: % missing', f.fn; end if;
    select p.prosrc into v_src from pg_proc p where p.oid = to_regprocedure(f.fn);
    if position('r352-0352' in v_src) > 0 then
      if to_regprocedure(replace(f.fn, '(', '__pre0352(')) is null then raise exception 'STOP 0352: % is the 0352 body but its kept copy is missing', f.fn; end if;
    elsif position(f.mark in v_src) = 0 then
      raise exception 'STOP 0352: % is not the known body (%) - nothing changed', f.fn, f.mark;
    end if;
  end loop;
end $$;

-- keeps a function body once as NAME__pre0352 (same arguments), callable by nobody
create or replace function public._r352_keep(p_fn text)
returns void language plpgsql volatile security definer set search_path = '' as $$
declare v_oid oid := to_regprocedure(p_fn); v_name text; v_types text; v_def text; v_pre text; r text;
begin
  if v_oid is null then raise exception 'r154f-0352: % missing', p_fn; end if;
  select p.proname, oidvectortypes(p.proargtypes) into v_name, v_types from pg_proc p where p.oid = v_oid;
  v_pre := format('public.%I(%s)', v_name || '__pre0352', v_types);
  if to_regprocedure(v_pre) is null then
    if position('r352-0352' in (select p.prosrc from pg_proc p where p.oid = v_oid)) > 0 then
      raise exception 'r154f-0352: % is already the 0352 body but its kept copy is missing', p_fn; end if;
    v_def := pg_get_functiondef(v_oid);
    v_def := regexp_replace(v_def, '^CREATE OR REPLACE FUNCTION public\.' || v_name || '\(',
                            'CREATE OR REPLACE FUNCTION public.' || v_name || '__pre0352(');
    if position(v_name || '__pre0352(' in v_def) = 0 then raise exception 'r154f-0352: could not keep %', p_fn; end if;
    execute v_def;
  end if;
  execute format('revoke all on function %s from public', v_pre);
  foreach r in array array['anon', 'authenticated', 'service_role'] loop
    if exists (select 1 from pg_roles where rolname = r) then execute format('revoke all on function %s from %I', v_pre, r); end if;
  end loop;
end $$;

-- true = this ask may be answered. One counter per caller network and one per address, per kind.
-- No readable address = one shared bucket (as 0298). A counter that cannot be written = false (fail closed).
create or replace function public._r352_allow(p_kind text, p_email text)
returns boolean language plpgsql volatile security definer set search_path = '' as $$
-- r352-0352
declare v_net text; v_mail text := left(lower(btrim(coalesce(p_email, ''))), 320);
begin
  begin v_net := public._r57_client_net(); exception when others then v_net := null; end;
  begin
    if public.rate_hit('r352_' || p_kind || '.ip',
         encode(pg_catalog.sha256(convert_to('helm-r352-ip:' || coalesce(v_net, 'noip'), 'UTF8')), 'hex'), 600, 20) > 0 then
      return false;
    end if;
    if v_mail <> '' and public.rate_hit('r352_' || p_kind || '.email',
         encode(pg_catalog.sha256(convert_to('helm-r352-mail:' || v_mail, 'UTF8')), 'hex'), 600, 20) > 0 then
      return false;
    end if;
  exception when others then
    return false;
  end;
  return true;
end $$;

do $$
declare f text; r text;
begin
  foreach f in array array['public._r352_keep(text)', 'public._r352_allow(text,text)'] loop
    execute format('revoke all on function %s from public', f);
    foreach r in array array['anon', 'authenticated'] loop
      if exists (select 1 from pg_roles where rolname = r) then execute format('revoke all on function %s from %I', f, r); end if;
    end loop;
  end loop;
end $$;

do $do$ begin
  perform public._r352_keep('public.signup_email_preauthorised(text)');
  execute $fn$
create or replace function public.signup_email_preauthorised(p_email text)
 returns boolean language plpgsql volatile security definer set search_path = '' as $function$
-- r352-0352 sign-up page staff check, 20 per 10 minutes per network and per address, then the kept 0298 body
begin
  if not public._r352_allow('preauth', p_email) then return false; end if;
  return public.signup_email_preauthorised__pre0352(p_email);
end $function$
$fn$;
end $do$;

do $do$ begin
  perform public._r352_keep('public.staff_google_only_for(text)');
  execute $fn$
create or replace function public.staff_google_only_for(p_email text)
 returns boolean language plpgsql volatile security definer set search_path = '' as $function$
-- r352-0352 sign-in page Google-only hint, 20 per 10 minutes per network and per address, then the kept 0288 body
begin
  if not public._r352_allow('staff_google', p_email) then return false; end if;
  return public.staff_google_only_for__pre0352(p_email);
end $function$
$fn$;
end $do$;
commit;

-- VERIFY every line should say true
select item, ok from (values
  ('01 both e-mail checks call the 0352 limiter', (select count(*) from pg_proc p where p.oid in (to_regprocedure('public.signup_email_preauthorised(text)'), to_regprocedure('public.staff_google_only_for(text)')) and position('r352-0352' in p.prosrc) > 0 and position('_r352_allow(' in p.prosrc) > 0) = 2),
  ('02 previous bodies kept, not callable by the app', (select count(*) from pg_proc p where p.oid in (to_regprocedure('public.signup_email_preauthorised__pre0352(text)'), to_regprocedure('public.staff_google_only_for__pre0352(text)')) and not has_function_privilege('anon', p.oid, 'execute') and not has_function_privilege('authenticated', p.oid, 'execute')) = 2),
  ('03 the sign-up and sign-in pages can still ask', (select count(*) from pg_proc p where p.oid in (to_regprocedure('public.signup_email_preauthorised(text)'), to_regprocedure('public.staff_google_only_for(text)')) and has_function_privilege('anon', p.oid, 'execute') and has_function_privilege('authenticated', p.oid, 'execute') and p.prosecdef) = 2),
  ('04 limiter and keeper not callable by the app', not has_function_privilege('anon', 'public._r352_allow(text,text)', 'execute') and not has_function_privilege('authenticated', 'public._r352_allow(text,text)', 'execute') and not has_function_privilege('anon', 'public._r352_keep(text)', 'execute') and not has_function_privilege('authenticated', 'public._r352_keep(text)', 'execute'))
) v(item, ok);
