-- 0443_r257_owner_film.sql - R257 (owner, 25 Nov 2026: "Fix all of the problems" from the recorded test of event 11252026-01).
-- Forward-only, additive, safe to run twice. ASCII only. Paste the whole file in the Supabase SQL editor; the last statement answers one
-- row per check. The pages work without it (they only say less).
--
-- In plain words:
--   A  THE STUDIO'S NAME on its own pages. worker_get_tasks answers studio { name, accent, logo }; public_get_proposal answers studio;
--      public_quote_ready (it already answers the name) and public_get_portal (name + accent) also answer the logo the studio saved in
--      Settings (the booklet shows it already). Only after the link's own checks; nothing else is answered.
--   B  PAYMENT REMINDERS ask for what is LEFT of a payment (it asked for the whole amount after a part payment) and are not queued - and a
--      waiting automatic one is skipped - when nothing is left of it.
--   C  "Payment receipt sent" in the activity mails becomes "Receipt recorded": recording a payment by hand e-mails nothing.
--   D  CREW WAGES: the note under a person says "checked in by the office" when the office did it (it always said the crew link).
--   E  The crew link also answers WHEN check-in opens as a time (opens_ts) and the server's time (now_ts), so the button can wait for it.
--
-- ZERO DATA LOSS: no table, no column, no row touched. Functions only; every body that is changed is kept once as <name>__pre0443 (server
-- only). Bodies are changed with exact text edits (the piece must be there exactly once, else the body is left as it is and a notice says so).
-- UNDO of one function: run the text of its <name>__pre0443 under the old name.

-- ---- 0) preflight ------------------------------------------------------------------------------------------------------------------
do $$ declare f text; begin
  foreach f in array array['public.worker_get_tasks(uuid)', 'public.public_quote_ready(uuid)', 'public.public_get_portal(uuid)', 'public.public_get_proposal(uuid)',
                           'public._comms_queue_pay(uuid,text,text,boolean,uuid)'] loop
    if to_regprocedure(f) is null then raise exception 'STOP 0443: % is missing - nothing was changed', f; end if;
  end loop;
  if to_regclass('public.work_tokens') is null or to_regclass('public.payment_milestones') is null or to_regclass('public.organizations') is null then
    raise exception 'STOP 0443: work_tokens / payment_milestones / organizations missing - nothing was changed'; end if;
end $$;

-- ---- 1) keep helper (same shape as _r435_keep) ------------------------------------------------------------------------------------------
create or replace function public._r443_keep(p_fn text)
returns void language plpgsql volatile security definer set search_path = '' as $$
-- r257-0443
declare v_oid oid := to_regprocedure(p_fn); v_name text; v_types text; v_def text; v_pre text; r text;
begin
  if v_oid is null then return; end if;
  select p.proname, oidvectortypes(p.proargtypes) into v_name, v_types from pg_proc p where p.oid = v_oid;
  v_pre := format('public.%I(%s)', v_name || '__pre0443', v_types);
  if to_regprocedure(v_pre) is null then
    v_def := pg_get_functiondef(v_oid);
    v_def := regexp_replace(v_def, '^CREATE OR REPLACE FUNCTION public\.' || v_name || '\(', 'CREATE OR REPLACE FUNCTION public.' || v_name || '__pre0443(');
    if position(v_name || '__pre0443(' in v_def) = 0 then raise exception 'r257-0443: could not keep %', p_fn; end if;
    execute v_def;
  end if;
  execute format('revoke all on function %s from public', v_pre);
  foreach r in array array['anon', 'authenticated', 'service_role'] loop
    if exists (select 1 from pg_roles where rolname = r) then execute format('revoke all on function %s from %I', v_pre, r); end if;
  end loop;
end $$;

-- ---- 2) helpers (server only) ---------------------------------------------------------------------------------------------------------------
-- the studio as its own client / crew pages may show it: the same three fields the booklet answers (0065)
create or replace function public._r443_studio(p_org uuid)
returns jsonb language sql stable security definer set search_path = '' as $$
  -- r257-0443
  select jsonb_strip_nulls(jsonb_build_object('name', left(nullif(btrim(o.name), ''), 120),
    'accent', case when (o.brand ->> 'accent') ~* '^#([0-9a-f]{3}|[0-9a-f]{6})$' then o.brand ->> 'accent' end,
    'logo', case when (o.brand ->> 'logo') ~* '^https://[^\s"<>]+$' and char_length(o.brand ->> 'logo') <= 500 then o.brand ->> 'logo' end))
    from public.organizations o where o.id = p_org;
$$;
-- what is left of one payment: money received covers the payments in order (the rule of payment_schedule_for_quote)
create or replace function public._r443_left(p_milestone uuid)
returns numeric language plpgsql stable security definer set search_path = '' as $$
-- r257-0443
declare m public.payment_milestones; x record; v_left numeric; v_take numeric;
begin
  select * into m from public.payment_milestones pm where pm.id = p_milestone;
  if m.id is null or m.status in ('paid', 'waived') then return 0; end if;
  select coalesce(sum(qp.amount), 0) into v_left from public.quote_payments qp where qp.quote_id = m.quote_id and qp.status = 'paid';
  v_left := greatest(v_left - coalesce((select sum(pm.amount) from public.payment_milestones pm where pm.quote_id = m.quote_id and pm.status = 'paid'), 0), 0);
  for x in select pm.id, greatest(coalesce(pm.amount, 0), 0) as amt from public.payment_milestones pm
            where pm.quote_id = m.quote_id and pm.status not in ('paid', 'waived') order by pm.due_date nulls last, pm.seq, pm.created_at, pm.id loop
    v_take := least(x.amt, v_left); v_left := v_left - v_take;
    if x.id = m.id then return round(x.amt - v_take, 2); end if;
  end loop;
  return 0;
end $$;
-- who recorded the check-ins of one person on one event, in words
create or replace function public._r443_checked(p_quote uuid, p_crew uuid, p_word text)
returns text language sql stable security definer set search_path = '' as $$
  -- r257-0443
  select p_word || case when coalesce(bool_and(k.source = 'office'), false) then ' by the office'
                        when coalesce(bool_or(k.source = 'office'), false) then ' on the crew link and by the office' else ' on the crew link' end
    from public.crew_checkins k where k.quote_id = p_quote and k.crew_id = p_crew;
$$;

-- ---- 3) A: the studio's name (and logo) on its own pages. Each one: the kept body answers first (every check is there), then the field. ----------
do $do$ begin
  if position('r257-0443' in pg_get_functiondef('public.worker_get_tasks(uuid)'::regprocedure)) = 0 then
    perform public._r443_keep('public.worker_get_tasks(uuid)');
    execute $fn$
create or replace function public.worker_get_tasks(p_token uuid)
returns jsonb language plpgsql volatile security definer set search_path = '' as $f$
-- r257-0443 (r252-0434 r253-0436 kept below): + studio { name, accent, logo } of the link's own event
-- (the 0436 answer is kept as worker_get_tasks__pre0443: the link check + limit _work_token_live(p_token) happens there)
declare v jsonb := public.worker_get_tasks__pre0443(p_token); v_org uuid;
begin
  if jsonb_typeof(v) is distinct from 'object' then return v; end if;
  select q.org_id into v_org from public.work_tokens w join public.quotes q on q.id = w.quote_id where w.token = p_token;
  return v || jsonb_build_object('studio', public._r443_studio(v_org));
exception when undefined_function or undefined_column or undefined_table then
  return v;   -- the extra field is a nice-to-have: the worker page always gets its tasks
end $f$
$fn$;
  end if;
  if position('r257-0443' in pg_get_functiondef('public.public_quote_ready(uuid)'::regprocedure)) = 0 then
    perform public._r443_keep('public.public_quote_ready(uuid)');
    execute $fn$
create or replace function public.public_quote_ready(p_token uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $f$
-- r257-0443 (r129-0337 kept below): + logo
declare v jsonb := public.public_quote_ready__pre0443(p_token); v_logo text;
begin
  if v is null or jsonb_typeof(v) <> 'object' or nullif(v ->> 'studio', '') is null then return v; end if;
  select public._r443_studio(q.org_id) ->> 'logo' into v_logo from public.quotes q where q.approval_token = p_token and q.deleted_at is null limit 1;
  return case when v_logo is null then v else v || jsonb_build_object('logo', v_logo) end;
end $f$
$fn$;
  end if;
  if position('r257-0443' in pg_get_functiondef('public.public_get_portal(uuid)'::regprocedure)) = 0 then
    perform public._r443_keep('public.public_get_portal(uuid)');
    execute $fn$
create or replace function public.public_get_portal(p_token uuid)
returns jsonb language plpgsql volatile security definer set search_path = '' as $f$
-- r257-0443 (r341-0341 kept below): + the studio's logo
declare v jsonb := public.public_get_portal__pre0443(p_token); v_logo text;
begin
  if v is null or jsonb_typeof(v) <> 'object' or jsonb_typeof(v -> 'studio') is distinct from 'object' then return v; end if;
  select public._r443_studio(q.org_id) ->> 'logo' into v_logo from public.quotes q where q.approval_token = p_token limit 1;
  return case when v_logo is null then v else jsonb_set(v, '{studio,logo}', to_jsonb(v_logo)) end;
end $f$
$fn$;
  end if;
  if position('r257-0443' in pg_get_functiondef('public.public_get_proposal(uuid)'::regprocedure)) = 0 then
    perform public._r443_keep('public.public_get_proposal(uuid)');
    execute $fn$
create or replace function public.public_get_proposal(p_token uuid)
returns jsonb language plpgsql volatile security definer set search_path = '' as $f$
-- r257-0443 (the earlier body kept below): + studio { name, accent, logo }
declare v jsonb := public.public_get_proposal__pre0443(p_token); v_s jsonb;
begin
  if v is null or jsonb_typeof(v) <> 'object' then return v; end if;
  select public._r443_studio(q.org_id) into v_s from public.event_proposal pr join public.quotes q on q.id = pr.quote_id where pr.share_token = p_token limit 1;
  return case when v_s is null then v else v || jsonb_build_object('studio', v_s) end;
end $f$
$fn$;
  end if;
end $do$;

-- ---- 4) B, C, D, E: exact text edits -----------------------------------------------------------------------------------------------------------
do $do$
declare r record; e jsonb; x jsonb; v_def text; v_new text; v_ok boolean; v_fn text;
begin
  for r in select * from (values
    -- B: the amount in the reminder = what is left; nothing left = no reminder
    ('\_comms\_queue\_pay', 'pay-schedule-0264', jsonb_build_array(
      jsonb_build_array('or coalesce(m.amount, 0) <= 0 then return 0; end if;', 'or coalesce(m.amount, 0) <= 0 then return 0; end if;
  if public._r443_left(m.id) <= 0.5 then return 0; end if; /* r257-0443 */'),
      jsonb_build_array('public._comms_money(m.amount, ', 'public._comms_money(public._r443_left(m.id), '))),
    ('comms\_outbox\_claim%', 'or public._r435_held(c.quote_id) /* r252-0435 */);', jsonb_build_array(
      jsonb_build_array('or public._r435_held(c.quote_id) /* r252-0435 */);',
                        'or public._r435_held(c.quote_id) /* r252-0435 */ or (c.milestone_id is not null and public._r443_left(c.milestone_id) <= 0.5) /* r257-0443 */);'))),
    -- C: the words of the activity / digest mails
    ('\_r23\_label%', 'Payment receipt sent', jsonb_build_array(
      jsonb_build_array('then ''Payment receipt sent''', 'then ''Receipt recorded'' /* r257-0443 */'))),
    -- D: who checked the person in
    ('\_r21\_cost\_lines%', 'r212-0387', jsonb_build_array(
      jsonb_build_array('''checked in on the crew link - not checked out yet (planned hours until then)''',
                        'public._r443_checked(p_quote, y.id, ''checked in'') || '' - not checked out yet (planned hours until then)'' /* r257-0443 */'),
      jsonb_build_array('''checked in / out on the crew link: '' ||', 'public._r443_checked(p_quote, y.id, ''checked in / out'') || '': '' ||'),
      jsonb_build_array('''checked in on the crew link ('' ||', 'public._r443_checked(p_quote, y.id, ''checked in'') || '' ('' ||'))),
    -- E: when check-in opens, as a time
    ('crew\_link\_home%', '''opens_at'', case when v_exp is not null', jsonb_build_array(
      jsonb_build_array('''opens_at'', case when v_exp is not null',
                        '''opens_ts'', case when v_exp is not null then to_char((v_exp - interval ''3 hours'') at time zone ''UTC'', ''YYYY-MM-DD"T"HH24:MI:SS"Z"'') end,
      ''now_ts'', to_char(now() at time zone ''UTC'', ''YYYY-MM-DD"T"HH24:MI:SS"Z"''), /* r257-0443 */
      ''opens_at'', case when v_exp is not null')))
  ) v(name_like, has, edits) loop
    v_ok := false;
    for v_fn, v_def in
      select format('public.%I(%s)', p.proname, oidvectortypes(p.proargtypes)), pg_get_functiondef(p.oid) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'public' and p.prokind = 'f' and p.proname like r.name_like and p.proname not like '%\_\_pre0443' and (position(r.has in p.prosrc) > 0 or position('r257-0443' in p.prosrc) > 0) loop
      if position('r257-0443' in v_def) > 0 then v_ok := true; continue; end if;          -- already done (second run)
      -- only a body that carries every piece exactly once is changed (a kept copy an older wrapper still calls is one of them)
      v_new := v_def;
      for e in select y from jsonb_array_elements(r.edits) y loop
        if (length(v_new) - length(replace(v_new, e ->> 0, ''))) / length(e ->> 0) <> 1 then v_new := null; exit; end if;
        v_new := replace(v_new, e ->> 0, e ->> 1);
      end loop;
      if v_new is null then continue; end if;
      perform public._r443_keep(v_fn);
      execute v_new; v_ok := true;
    end loop;
    if not v_ok then raise notice '0443: no body like % with the expected text - left unchanged', r.name_like; end if;
  end loop;
end $do$;

-- ---- 5) grants: the helpers and kept bodies are server only --------------------------------------------------------------------------------------
do $$ declare f text; r text; begin
  foreach f in array array['public._r443_keep(text)', 'public._r443_studio(uuid)', 'public._r443_left(uuid)', 'public._r443_checked(uuid,uuid,text)'] loop
    execute format('revoke all on function %s from public', f);
    foreach r in array array['anon', 'authenticated'] loop
      if exists (select 1 from pg_roles where rolname = r) then execute format('revoke all on function %s from %I', f, r); end if;
    end loop;
  end loop;
end $$;

do $$ begin
  if to_regclass('public.helm_schema_markers') is not null then
    insert into public.helm_schema_markers(num, name) values (443, '0443_r257_owner_film') on conflict (num) do nothing;
  end if;
end $$;

notify pgrst, 'reload schema';

-- ---- 6) CHECK (read only): every row must say true ---------------------------------------------------------------------------------------------
select c.check, c.ok from (values
  ('01 the crew task link answers the studio', position('r257-0443' in pg_get_functiondef('public.worker_get_tasks(uuid)'::regprocedure)) > 0),
  ('02 the approval page gets the logo', position('r257-0443' in pg_get_functiondef('public.public_quote_ready(uuid)'::regprocedure)) > 0),
  ('03 the portal gets the logo', position('r257-0443' in pg_get_functiondef('public.public_get_portal(uuid)'::regprocedure)) > 0),
  ('04 the proposal answers the studio', position('r257-0443' in pg_get_functiondef('public.public_get_proposal(uuid)'::regprocedure)) > 0),
  ('05 a payment reminder asks for what is left', position('_r443_left(m.id), ' in pg_get_functiondef('public._comms_queue_pay(uuid,text,text,boolean,uuid)'::regprocedure)) > 0),
  ('06 a payment with nothing left gets no reminder', position('r257-0443' in pg_get_functiondef('public._comms_queue_pay(uuid,text,text,boolean,uuid)'::regprocedure)) > 0),
  ('07 the 0435 rule (no reminder before the approval) is still there', position('_r435_held' in pg_get_functiondef('public._comms_queue_pay(uuid,text,text,boolean,uuid)'::regprocedure)) > 0
      or to_regprocedure('public._r435_held(uuid)') is null),
  ('08 the activity mail says Receipt recorded', to_regprocedure('public._r23_label(text,jsonb)') is null
      or exists (select 1 from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname like '\_r23\_label%' and p.proname not like '%\_\_pre0443' and position('Receipt recorded' in p.prosrc) > 0)),
  ('09 the wage note says who checked the person in', exists (select 1 from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname like '\_r21\_cost\_lines%'
      and p.proname not like '%\_\_pre0443' and position('_r443_checked' in p.prosrc) > 0)),
  ('10 the crew link says when check-in opens', exists (select 1 from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname like 'crew\_link\_home%'
      and p.proname not like '%\_\_pre0443' and position('opens_ts' in p.prosrc) > 0)),
  ('11 the public links still answer signed-out people', has_function_privilege('anon', 'public.worker_get_tasks(uuid)', 'execute') and has_function_privilege('anon', 'public.public_quote_ready(uuid)', 'execute')
      and has_function_privilege('anon', 'public.public_get_portal(uuid)', 'execute') and has_function_privilege('anon', 'public.public_get_proposal(uuid)', 'execute')),
  ('12 helpers and kept bodies are server only, search_path pinned', (select count(*) >= 9 and bool_and(not has_function_privilege('anon', p.oid, 'execute') and not has_function_privilege('authenticated', p.oid, 'execute'))
      and bool_and(p.proname like '%\_\_pre0443' or coalesce(p.proconfig @> array['search_path=""'], false))
      from pg_proc p where p.pronamespace = 'public'::regnamespace and (p.proname like '\_r443\_%' or p.proname like '%\_\_pre0443')))
) c("check", ok);
