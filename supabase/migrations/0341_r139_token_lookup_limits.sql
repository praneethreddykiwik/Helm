-- 0341_r139_token_lookup_limits.sql - R139 per-network limits on the public link lookups. Forward-only, additive, safe to run twice.
-- approval link + client portal 240 and invitation 600 per 10 minutes per network. Crew task link and crew check-in unchanged, limited since 0154 by _work_token_live.
do $$
declare f record; v_src text;
begin
  if to_regprocedure('public.rate_hit(text,text,integer,integer)') is null then raise exception 'STOP 0341: rate_hit missing - run 0050 first'; end if;
  if to_regprocedure('public._r57_client_net()') is null then raise exception 'STOP 0341: _r57_client_net missing - run 0298 first'; end if;
  for f in select * from (values
      ('public.public_get_quote(uuid)', 'r125-0334'), ('public.public_get_portal(uuid)', 'r125-0334'),
      ('public.public_event_site(text)', 'r125-0334')) x(fn, mark)
  loop
    if to_regprocedure(f.fn) is null then raise exception 'STOP 0341: % missing', f.fn; end if;
    select p.prosrc into v_src from pg_proc p where p.oid = to_regprocedure(f.fn);
    if position('r341-0341' in v_src) > 0 then
      if to_regprocedure(replace(f.fn, '(', '__pre0341(')) is null then raise exception 'STOP 0341: % is the 0341 body but its kept copy is missing', f.fn; end if;
    elsif position(f.mark in v_src) = 0 then
      raise exception 'STOP 0341: % is not the known body (%) - nothing changed', f.fn, f.mark;
    end if;
  end loop;
end $$;

create or replace function public._r341_keep(p_fn text)
returns void language plpgsql volatile security definer set search_path = '' as $$
declare v_oid oid := to_regprocedure(p_fn); v_name text; v_types text; v_def text; v_pre text;
begin
  if v_oid is null then raise exception 'r139-0341: % missing', p_fn; end if;
  select p.proname, oidvectortypes(p.proargtypes) into v_name, v_types from pg_proc p where p.oid = v_oid;
  v_pre := format('public.%I(%s)', v_name || '__pre0341', v_types);
  if to_regprocedure(v_pre) is null then
    if position('r341-0341' in (select p.prosrc from pg_proc p where p.oid = v_oid)) > 0 then
      raise exception 'r139-0341: % is already the 0341 body but its kept copy is missing', p_fn; end if;
    v_def := pg_get_functiondef(v_oid);
    v_def := regexp_replace(v_def, '^CREATE OR REPLACE FUNCTION public\.' || v_name || '\(',
                            'CREATE OR REPLACE FUNCTION public.' || v_name || '__pre0341(');
    if position(v_name || '__pre0341(' in v_def) = 0 then raise exception 'r139-0341: could not keep %', p_fn; end if;
    execute v_def;
  end if;
  execute format('revoke all on function %s from public', v_pre);
  if exists (select 1 from pg_roles where rolname = 'anon') then execute format('revoke all on function %s from anon', v_pre); end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then execute format('revoke all on function %s from authenticated', v_pre); end if;
  if exists (select 1 from pg_roles where rolname = 'service_role') then execute format('revoke all on function %s from service_role', v_pre); end if;
end $$;

create or replace function public._r341_limit(p_kind text, p_window integer, p_max integer)
returns void language plpgsql volatile security definer set search_path = '' as $$
-- r341-0341 one counter per caller network per kind, no readable address means no counter, a counter that cannot be written never blocks
declare v_net text; v_wait integer := 0;
begin
  begin v_net := public._r57_client_net(); exception when others then v_net := null; end;
  if v_net is null then return; end if;
  begin
    v_wait := public.rate_hit(p_kind || '.ip', v_net, p_window, p_max);
  exception when others then v_wait := 0;
  end;
  if coalesce(v_wait, 0) > 0 then
    raise exception 'Too many requests from your network. Please wait a few minutes and try again.'
      using errcode = '22023', hint = 'rate_limited', detail = json_build_object('retry_after', v_wait)::text;
  end if;
end $$;

do $$
declare f text;
begin
  foreach f in array array['public._r341_keep(text)', 'public._r341_limit(text,integer,integer)'] loop
    execute format('revoke all on function %s from public', f);
    if exists (select 1 from pg_roles where rolname = 'anon') then execute format('revoke all on function %s from anon', f); end if;
    if exists (select 1 from pg_roles where rolname = 'authenticated') then execute format('revoke all on function %s from authenticated', f); end if;
  end loop;
end $$;

do $do$ begin
  perform public._r341_keep('public.public_get_quote(uuid)');
  execute $fn$
create or replace function public.public_get_quote(p_token uuid)
 returns jsonb language plpgsql volatile security definer set search_path = '' as $function$
-- r341-0341 approval link, 240 per 10 minutes per network, then the kept body
begin
  perform public._r341_limit('quote_get', 600, 240);
  return public.public_get_quote__pre0341(p_token);
end $function$
$fn$;
end $do$;

do $do$ begin
  perform public._r341_keep('public.public_get_portal(uuid)');
  execute $fn$
create or replace function public.public_get_portal(p_token uuid)
 returns jsonb language plpgsql volatile security definer set search_path = '' as $function$
-- r341-0341 client portal, 240 per 10 minutes per network, then the kept body
begin
  perform public._r341_limit('portal_get', 600, 240);
  return public.public_get_portal__pre0341(p_token);
end $function$
$fn$;
end $do$;

do $do$ begin
  perform public._r341_keep('public.public_event_site(text)');
  execute $fn$
create or replace function public.public_event_site(p_slug text)
 returns table(event_type text, template text, title text, data jsonb) language plpgsql volatile security definer set search_path = '' as $function$
-- r341-0341 invitation, 600 per 10 minutes per network, then the kept body
begin
  perform public._r341_limit('site_get', 600, 600);
  return query select * from public.public_event_site__pre0341(p_slug);
end $function$
$fn$;
end $do$;

do $$ begin
  if to_regprocedure('public._tl173_trial_locked(uuid)') is not null and exists (select 1 from pg_roles where rolname = 'anon') then
    revoke all on function public._tl173_trial_locked(uuid) from anon;
  end if;
end $$;
