-- 0354_r156_wa_template_jobs.sql - R156 WhatsApp template setup in the background. Forward-only, additive, safe to run twice.
-- REQUIRES 0117 (org_whatsapp_accounts), 0337 (studio WhatsApp, _r337_wa_ready) and 0329 (notification catalog chain).
--
-- In plain words:
--   Set up message templates used to create all 21 templates inside ONE web request and threw away the reason Meta gave
--   for each refusal. Now the button only puts the missing templates in a queue and returns at once. A background worker
--   (the wa-template-worker edge function, run by pg_cron every few minutes) creates them one by one, never twice (it
--   first checks the name and language in the studio account), retries with a growing wait, stays under the Meta limit of
--   100 creates per hour per WhatsApp account, keeps the Meta error number and a short safe message per template, polls
--   the review result until every template is final, re-checks every studio once a night, records a change of category
--   (utility moved to marketing by Meta) and the phone quality rating, messaging limit and send health.
--   When a setup round is over the studio admins get ONE bell notice: all approved, or which ones were rejected and why.
--   A rejected or failed template gets a Fix and resubmit button (wa_template_resubmit).
--   1  wa_template_jobs   one row per studio + template name + language (unique, so a template is queued only once)
--   2  wa_template_setup  one row per studio: current round, rate counter, pause after a Meta rate limit, health
--   Both tables: row security on, studio admins read their own studio rows only, nobody writes them directly - every
--   write goes through the security definer functions below (the worker calls them with the service role).
--   The bell kind wa_templates is admin only (like plan_active in 0329).
--   The cron jobs are scheduled only when pg_cron, pg_net and the two Vault secrets exist (see the end of this file).
--
-- ZERO DATA LOSS: two new tables, new functions, three notification functions wrapped (old bodies kept once as
-- *__pre0354 with no app privilege), restrictive policies added. Nothing dropped, deleted or rewritten.
-- Notes: supabase/migrations/MANIFEST entry 0354.

-- ---- 0) preflight ---------------------------------------------------------------------------------------------------
do $$
begin
  if to_regclass('public.org_whatsapp_accounts') is null or to_regprocedure('public._r337_wa_ready(uuid)') is null then
    raise exception 'STOP 0354: run 0337 (studio WhatsApp) first'; end if;
  if to_regprocedure('public.notification_catalog()') is null or to_regprocedure('public.notification_type_of(text,text)') is null
     or to_regprocedure('public.notify_default(uuid,text,text,text)') is null or to_regclass('public.notifications') is null then
    raise exception 'STOP 0354: notification catalog (0036 + 0329) missing'; end if;
  if to_regprocedure('public.current_org_id()') is null or to_regprocedure('public.is_admin()') is null then
    raise exception 'STOP 0354: current_org_id() or is_admin() missing'; end if;
end $$;

-- ---- 1) tables --------------------------------------------------------------------------------------------------------
create table if not exists public.wa_template_jobs (
  id              uuid primary key default gen_random_uuid(),
  org_id          uuid not null references public.organizations(id),
  name            text not null,
  language        text not null default 'en',
  state           text not null default 'queued',
  action          text not null default 'create',
  variant         text not null default 'own',
  library_name    text,
  param_map       jsonb,
  attempts        integer not null default 0,
  next_attempt_at timestamptz,
  lease_until     timestamptz,
  last_error      jsonb,
  meta_id         text,
  meta_status     text,
  category        text,
  prev_category   text,
  category_changed_at timestamptz,
  quality         text,
  rejected_reason text,
  batch_id        uuid,
  final_at        timestamptz,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  constraint wa_template_jobs_uk354 unique (org_id, name, language),
  constraint wa_template_jobs_name_chk354 check (name ~ '^[a-z0-9_]{1,64}$' and language ~ '^[a-z]{2}(_[A-Z]{2})?$'),
  constraint wa_template_jobs_state_chk354 check (state in ('queued', 'creating', 'pending', 'approved', 'rejected', 'failed', 'paused', 'disabled')),
  constraint wa_template_jobs_action_chk354 check (action in ('create', 'resubmit')),
  constraint wa_template_jobs_variant_chk354 check (variant in ('own', 'library') and (library_name is null or library_name ~ '^[a-z0-9_]{1,128}$')),
  constraint wa_template_jobs_json_chk354 check ((param_map is null or (jsonb_typeof(param_map) = 'object' and length(param_map::text) <= 1000))
                                              and (last_error is null or (jsonb_typeof(last_error) = 'object' and length(last_error::text) <= 1500))),
  constraint wa_template_jobs_meta_chk354 check ((meta_id is null or meta_id ~ '^[0-9]{1,30}$') and (meta_status is null or meta_status ~ '^[A-Z_]{1,30}$')
                                              and (category is null or category ~ '^[A-Z_]{1,30}$') and (prev_category is null or prev_category ~ '^[A-Z_]{1,30}$')
                                              and (quality is null or quality ~ '^[A-Z_]{1,20}$') and (rejected_reason is null or length(rejected_reason) <= 300))
);
create index if not exists wa_template_jobs_due_ix354 on public.wa_template_jobs (org_id, state, next_attempt_at);

create table if not exists public.wa_template_setup (
  org_id            uuid primary key references public.organizations(id),
  batch_id          uuid,
  started_at        timestamptz,
  started_by        uuid,
  finished_at       timestamptz,
  notified_batch    uuid,
  notified_kind     text,
  paused_until      timestamptz,
  create_times      jsonb not null default '[]'::jsonb,
  last_sync_at      timestamptz,
  next_sync_at      timestamptz,
  health            jsonb,
  health_checked_at timestamptz,
  health_warned     text,
  updated_at        timestamptz not null default now(),
  constraint wa_template_setup_json_chk354 check (jsonb_typeof(create_times) = 'array' and length(create_times::text) <= 6000
                                               and (health is null or (jsonb_typeof(health) = 'object' and length(health::text) <= 2000))
                                               and (health_warned is null or length(health_warned) <= 300)
                                               and (notified_kind is null or notified_kind in ('approved', 'rejected')))
);

alter table public.wa_template_jobs enable row level security;
alter table public.wa_template_setup enable row level security;
do $$ begin
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'wa_template_jobs' and policyname = 'r354_jobs_admin_read') then
    create policy r354_jobs_admin_read on public.wa_template_jobs for select to authenticated
      using (org_id = (select public.current_org_id()) and coalesce((select public.is_admin()), false));
  end if;
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'wa_template_setup' and policyname = 'r354_setup_admin_read') then
    create policy r354_setup_admin_read on public.wa_template_setup for select to authenticated
      using (org_id = (select public.current_org_id()) and coalesce((select public.is_admin()), false));
  end if;
end $$;
do $$ declare t text; begin
  foreach t in array array['public.wa_template_jobs', 'public.wa_template_setup'] loop
    execute 'revoke all on table ' || t || ' from public';
    if exists (select 1 from pg_roles where rolname = 'anon') then execute 'revoke all on table ' || t || ' from anon'; end if;
    if exists (select 1 from pg_roles where rolname = 'authenticated') then
      execute 'revoke all on table ' || t || ' from authenticated';
      execute 'grant select on table ' || t || ' to authenticated'; end if;
    if exists (select 1 from pg_roles where rolname = 'service_role') then
      execute 'revoke all on table ' || t || ' from service_role';
      execute 'grant select on table ' || t || ' to service_role'; end if;
  end loop;
end $$;

-- 0045 read-only guard (a suspended or ended-trial studio takes no new rows from its people, the server job passes)
do $$ declare t text; begin
  if to_regprocedure('public.tg_studio_read_only()') is not null then
    foreach t in array array['wa_template_jobs', 'wa_template_setup'] loop
      if not exists (select 1 from pg_catalog.pg_trigger where tgname = 'zzz_studio_read_only' and tgrelid = ('public.' || t)::regclass) then
        execute format('create trigger zzz_studio_read_only before insert or update or delete on public.%I for each row execute function public.tg_studio_read_only(''org_id'')', t);
      end if;
    end loop;
  end if;
end $$;

-- the two tables in the free-trial retention lists (0184): kept, like org_whatsapp_accounts (an account record, not studio work)
do $$ declare v_def text; begin
  if to_regprocedure('public._tr184_keep_tables()') is not null then
    v_def := pg_get_functiondef('public._tr184_keep_tables()'::regprocedure);
    if position('''wa_template_jobs''' in v_def) = 0 then
      if (length(v_def) - length(replace(v_def, '''org_whatsapp_accounts'',', ''))) / length('''org_whatsapp_accounts'',') <> 1 then
        raise notice '0354: _tr184_keep_tables has an unexpected body - left unchanged';
      else execute replace(v_def, '''org_whatsapp_accounts'',', '''org_whatsapp_accounts'', ''wa_template_jobs'', ''wa_template_setup'','); end if;
    end if;
  end if;
end $$;

-- ---- 2) helpers -------------------------------------------------------------------------------------------------------
-- Meta template status -> job state
create or replace function public._r354_state_of(p_status text)
returns text language sql immutable set search_path = '' as $$
  -- r156-0354
  select case upper(coalesce(p_status, ''))
    when 'APPROVED' then 'approved' when 'REJECTED' then 'rejected' when 'PAUSED' then 'paused'
    when 'DISABLED' then 'disabled' when 'ARCHIVED' then 'disabled' when 'DELETED' then 'disabled'
    else 'pending' end;
$$;

-- wait before the next try: 1 2 4 8 16 32 64 128 256 then 360 minutes, plus up to 10 percent jitter
create or replace function public._r354_backoff(p_attempts integer)
returns interval language sql volatile set search_path = '' as $$
  -- r156-0354
  select make_interval(secs => least(360::float8, power(2::float8, greatest(coalesce(p_attempts, 1), 1) - 1)) * 60 * (1 + 0.1 * random()));
$$;

-- only short safe text from Meta: no links, no long tokens, one line, at most p_max characters
create or replace function public._r354_safe_text(p text, p_max integer default 300)
returns text language sql immutable set search_path = '' as $$
  -- r156-0354
  select nullif(left(btrim(regexp_replace(regexp_replace(regexp_replace(coalesce(p, ''), 'https?://[^ ]+', '[link]', 'gi'),
           '[A-Za-z0-9_-]{32,}', '[hidden]', 'g'), '[[:cntrl:]<>]+', ' ', 'g')), greatest(coalesce(p_max, 300), 1)), '');
$$;

-- a Meta error kept per template: numbers + short text only
create or replace function public._r354_clean_error(p jsonb)
returns jsonb language sql immutable set search_path = '' as $$
  -- r156-0354
  select case when p is null or jsonb_typeof(p) <> 'object' then null else jsonb_strip_nulls(jsonb_build_object(
    'reason', case when coalesce(p ->> 'reason', '') ~ '^[a-z_]{1,30}$' then p ->> 'reason' end,
    'code', case when coalesce(p ->> 'code', '') ~ '^[0-9]{1,9}$' then (p ->> 'code')::bigint end,
    'subcode', case when coalesce(p ->> 'subcode', '') ~ '^[0-9]{1,9}$' then (p ->> 'subcode')::bigint end,
    'status', case when coalesce(p ->> 'status', '') ~ '^[0-9]{1,3}$' then (p ->> 'status')::int end,
    'title', public._r354_safe_text(p ->> 'title', 120),
    'message', public._r354_safe_text(p ->> 'message', 300),
    'at', to_char(now() at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'))) end;
$$;

create or replace function public._r354_upper_word(p text, p_max integer)
returns text language sql immutable set search_path = '' as $$
  -- r156-0354
  select case when upper(coalesce(p, '')) ~ ('^[A-Z_]{1,' || p_max || '}$') then upper(p) end;
$$;

-- the studio setup row (created when missing)
create or replace function public._r354_setup_row(p_org uuid)
returns public.wa_template_setup language plpgsql volatile security definer set search_path = '' as $$
-- r156-0354
declare s public.wa_template_setup;
begin
  insert into public.wa_template_setup(org_id) values (p_org) on conflict (org_id) do nothing;
  select * into s from public.wa_template_setup where org_id = p_org for update;
  return s;
end $$;

-- start a setup round when none is running (a running round keeps its id). A round whose notice already went out (a
-- rejection while others still wait) is closed: a new round takes over the rows still waiting, so they get their own notice
create or replace function public._r354_start_round(p_org uuid, p_user uuid)
returns uuid language plpgsql volatile security definer set search_path = '' as $$
-- r156-0354
declare s public.wa_template_setup; v_batch uuid;
begin
  s := public._r354_setup_row(p_org);
  if s.batch_id is not null and s.finished_at is null and s.notified_batch is distinct from s.batch_id then return s.batch_id; end if;
  v_batch := gen_random_uuid();
  update public.wa_template_setup set batch_id = v_batch, started_at = now(), started_by = p_user, finished_at = null,
         next_sync_at = now(), updated_at = now() where org_id = p_org;
  if s.batch_id is not null then
    update public.wa_template_jobs set batch_id = v_batch, updated_at = now()
     where org_id = p_org and batch_id = s.batch_id and state in ('queued', 'creating', 'pending');
  end if;
  return v_batch;
end $$;

-- creates sent to Meta for this studio in the last hour (Meta allows 100 per WhatsApp account per hour)
create or replace function public._r354_creates_last_hour(p_org uuid)
returns integer language sql stable security definer set search_path = '' as $$
  -- r156-0354
  select coalesce((select count(*)::int from public.wa_template_setup s, jsonb_array_elements_text(s.create_times) e(t)
                    where s.org_id = p_org and e.t ~ '^[0-9]{4}-' and e.t::timestamptz > now() - interval '1 hour'), 0);
$$;

-- ---- 3) enqueue (server, after reading the studio account): only names that are missing at Meta -----------------------
create or replace function public.wa_template_enqueue(p_org uuid, p_items jsonb, p_user uuid default null)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
-- r156-0354: idempotent - a name already queued or being created is left alone, the unique key never allows a second row
declare v_batch uuid; it jsonb; v_name text; v_lang text; n int := 0; v_rows int;
begin
  if p_org is null or not public._r337_wa_ready(p_org) then return jsonb_build_object('ok', false, 'reason', 'not_connected'); end if;
  if p_items is null or jsonb_typeof(p_items) <> 'array' then return jsonb_build_object('ok', false, 'reason', 'bad_items'); end if;
  v_batch := public._r354_start_round(p_org, p_user);
  for it in select * from jsonb_array_elements(p_items) limit 60 loop
    v_name := it ->> 'name'; v_lang := coalesce(nullif(it ->> 'language', ''), 'en');
    continue when coalesce(v_name, '') !~ '^[a-z0-9_]{1,64}$' or v_lang !~ '^[a-z]{2}(_[A-Z]{2})?$';
    insert into public.wa_template_jobs as j (org_id, name, language, state, action, batch_id, next_attempt_at)
      values (p_org, v_name, v_lang, 'queued', 'create', v_batch, now())
      on conflict (org_id, name, language) do update set state = 'queued', action = 'create', attempts = 0, next_attempt_at = now(), lease_until = null, last_error = null,
            batch_id = v_batch, final_at = null, updated_at = now()
        where j.state not in ('queued', 'creating');
    get diagnostics v_rows = row_count; n := n + v_rows;
  end loop;
  return jsonb_build_object('ok', true, 'queued', n, 'batch_id', v_batch);
end $$;

-- ---- 4) Fix and resubmit (the studio admin, from the Integrations page) ------------------------------------------------
create or replace function public.wa_template_resubmit(p_name text, p_language text default 'en')
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
-- r156-0354: a rejected template that exists at Meta is edited with the fixed wording, one that was never created is created
declare v_org uuid := public.current_org_id(); j public.wa_template_jobs; v_batch uuid;
begin
  if auth.uid() is null or v_org is null or not coalesce(public.is_admin(), false) then
    raise exception 'not_allowed' using errcode = '42501'; end if;
  if not public._r337_wa_ready(v_org) then raise exception 'not_connected' using errcode = '22023'; end if;
  select * into j from public.wa_template_jobs where org_id = v_org and name = p_name and language = coalesce(nullif(p_language, ''), 'en') for update;
  if j.id is null then raise exception 'not_found' using errcode = '22023'; end if;
  if j.state not in ('rejected', 'failed', 'paused') then raise exception 'not_resubmittable' using errcode = '22023'; end if;
  v_batch := public._r354_start_round(v_org, auth.uid());
  update public.wa_template_jobs set state = 'queued', action = case when meta_id is not null and state in ('rejected', 'paused') then 'resubmit' else 'create' end,
         attempts = 0, next_attempt_at = now(), lease_until = null, batch_id = v_batch, final_at = null, updated_at = now()
   where id = j.id;
  return jsonb_build_object('ok', true, 'name', j.name, 'batch_id', v_batch);
end $$;

-- ---- 5) worker: which studios have work -----------------------------------------------------------------------------------
create or replace function public.wa_template_due_orgs(p_nightly boolean default false, p_limit integer default 50)
returns uuid[] language sql stable security definer set search_path = '' as $$
  -- r156-0354
  select coalesce(array_agg(x.org_id), '{}'::uuid[]) from (
    select w.org_id from public.org_whatsapp_accounts w
      left join public.wa_template_setup s on s.org_id = w.org_id
     where public._r337_wa_ready(w.org_id)
       and (coalesce(p_nightly, false)
            or exists (select 1 from public.wa_template_jobs j where j.org_id = w.org_id
                         and ((j.state = 'queued' and coalesce(j.next_attempt_at, now()) <= now() and coalesce(s.paused_until, now()) <= now())
                              or (j.state = 'creating' and coalesce(j.lease_until, now()) <= now())))
            or (exists (select 1 from public.wa_template_jobs j where j.org_id = w.org_id and j.state = 'pending')
                and coalesce(s.next_sync_at, now()) <= now())
            or (s.org_id is not null and coalesce(s.health_checked_at, now() - interval '1 day') <= now() - interval '12 hours'))
     order by coalesce(s.last_sync_at, 'epoch'::timestamptz)
     limit greatest(1, least(coalesce(p_limit, 50), 200))) x;
$$;

-- ---- 6) worker: claim the due rows of one studio (skip locked, never more than the hourly Meta budget) ---------------------
create or replace function public.wa_template_claim(p_org uuid, p_limit integer default 10)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
-- r156-0354
declare s public.wa_template_setup; v_budget int; v_out jsonb;
begin
  if p_org is null or not public._r337_wa_ready(p_org) then return '[]'::jsonb; end if;
  s := public._r354_setup_row(p_org);
  if s.paused_until is not null and s.paused_until > now() then return '[]'::jsonb; end if;
  v_budget := greatest(0, least(coalesce(p_limit, 10), 25, 100 - public._r354_creates_last_hour(p_org)));
  if v_budget = 0 then return '[]'::jsonb; end if;
  with c as (
    select j.id from public.wa_template_jobs j
     where j.org_id = p_org
       and ((j.state = 'queued' and coalesce(j.next_attempt_at, now()) <= now()) or (j.state = 'creating' and coalesce(j.lease_until, now()) <= now()))
     order by j.next_attempt_at nulls first, j.created_at
     limit v_budget
     for update skip locked
  ), u as (
    update public.wa_template_jobs j set state = 'creating', lease_until = now() + interval '10 minutes', updated_at = now()
      from c where j.id = c.id
    returning j.id, j.name, j.language, j.action, j.variant, j.meta_id, j.attempts
  )
  select coalesce(jsonb_agg(jsonb_build_object('id', u.id, 'name', u.name, 'language', u.language, 'action', u.action,
           'variant', u.variant, 'meta_id', u.meta_id, 'attempts', u.attempts)), '[]'::jsonb) into v_out from u;
  return v_out;
end $$;

-- ---- 7) worker: one result --------------------------------------------------------------------------------------------------
-- p_result: outcome created | exists | retry | failed | paused, counted (a create was sent to Meta), meta_id, meta_status,
--           category, variant, library_name, param_map, error, retry_minutes
create or replace function public.wa_template_record(p_id uuid, p_result jsonb)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
-- r156-0354
declare j public.wa_template_jobs; v_out text := coalesce(p_result ->> 'outcome', ''); v_state text; v_err jsonb;
        v_cat text; v_att int; v_min int;
begin
  select * into j from public.wa_template_jobs where id = p_id for update;
  if j.id is null or j.state <> 'creating' then return jsonb_build_object('result', 'ignored'); end if;
  if coalesce((p_result ->> 'counted')::boolean, false) then
    perform public._r354_setup_row(j.org_id);
    update public.wa_template_setup s set create_times = (select coalesce(jsonb_agg(to_jsonb(t)), '[]'::jsonb) from (
              select e.t from jsonb_array_elements_text(s.create_times) e(t)
               where e.t ~ '^[0-9]{4}-' and e.t::timestamptz > now() - interval '1 hour'
              union all select to_char(now() at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
              order by 1 desc limit 120) x(t)),
           updated_at = now()
     where s.org_id = j.org_id;
  end if;
  v_err := public._r354_clean_error(p_result -> 'error');
  if v_out in ('created', 'exists') then
    v_state := public._r354_state_of(p_result ->> 'meta_status');
    v_cat := public._r354_upper_word(p_result ->> 'category', 30);
    update public.wa_template_jobs set state = v_state, action = 'create', lease_until = null, next_attempt_at = null, last_error = null,
           meta_id = coalesce(case when coalesce(p_result ->> 'meta_id', '') ~ '^[0-9]{1,30}$' then p_result ->> 'meta_id' end, meta_id),
           meta_status = coalesce(public._r354_upper_word(p_result ->> 'meta_status', 30), 'PENDING'),
           prev_category = case when category is not null and v_cat is not null and category <> v_cat then category else prev_category end,
           category_changed_at = case when category is not null and v_cat is not null and category <> v_cat then now() else category_changed_at end,
           category = coalesce(v_cat, category),
           variant = case when p_result ->> 'variant' in ('own', 'library') then p_result ->> 'variant' else variant end,
           library_name = case when p_result ->> 'variant' = 'own' then null
                               when coalesce(p_result ->> 'library_name', '') ~ '^[a-z0-9_]{1,128}$' then p_result ->> 'library_name' else library_name end,
           param_map = case when p_result ->> 'variant' = 'own' then null
                            when jsonb_typeof(p_result -> 'param_map') = 'object' and length((p_result -> 'param_map')::text) <= 1000 then p_result -> 'param_map'
                            else param_map end,
           rejected_reason = case when v_state = 'rejected' then public._r354_safe_text(p_result ->> 'rejected_reason', 300) else null end,
           final_at = case when v_state in ('approved', 'rejected', 'disabled') then now() else null end,
           updated_at = now()
     where id = j.id;
    return jsonb_build_object('result', v_state);
  elsif v_out = 'paused' then
    v_min := least(greatest(coalesce(nullif(p_result ->> 'retry_minutes', '')::int, 60), 5), 360);
    perform public._r354_setup_row(j.org_id);
    update public.wa_template_setup set paused_until = now() + make_interval(mins => v_min), updated_at = now() where org_id = j.org_id;
    update public.wa_template_jobs set state = 'queued', lease_until = null, next_attempt_at = now() + make_interval(mins => v_min),
           last_error = coalesce(v_err, last_error), updated_at = now() where id = j.id;
    return jsonb_build_object('result', 'paused');
  elsif v_out = 'retry' then
    v_att := j.attempts + 1;
    if v_att >= 8 then
      update public.wa_template_jobs set state = 'failed', attempts = v_att, lease_until = null, next_attempt_at = null,
             last_error = coalesce(v_err, last_error), final_at = now(), updated_at = now() where id = j.id;
      return jsonb_build_object('result', 'failed');
    end if;
    update public.wa_template_jobs set state = 'queued', attempts = v_att, lease_until = null,
           next_attempt_at = now() + public._r354_backoff(v_att), last_error = coalesce(v_err, last_error), updated_at = now() where id = j.id;
    return jsonb_build_object('result', 'retry');
  else
    update public.wa_template_jobs set state = 'failed', attempts = j.attempts + 1, lease_until = null, next_attempt_at = null,
           last_error = coalesce(v_err, jsonb_build_object('reason', 'other')), final_at = now(), updated_at = now() where id = j.id;
    return jsonb_build_object('result', 'failed');
  end if;
end $$;

-- ---- 8) worker: the template list read from Meta (status, category, quality, rejection reason) ----------------------------
-- p_list: [{name, language, status, category, rejected_reason, quality_score, id}] for Helm templates only
create or replace function public.wa_template_sync(p_org uuid, p_list jsonb, p_any_pending boolean default false)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
-- r156-0354: rows being queued or created are left to the worker, a template Helm has no row for is recorded (older setups)
declare it jsonb; v_name text; v_lang text; v_st text; v_cat text; v_q text; n int := 0; v_re jsonb := '[]'::jsonb; j public.wa_template_jobs;
begin
  if p_org is null or p_list is null or jsonb_typeof(p_list) <> 'array' then return jsonb_build_object('changed', 0); end if;
  perform public._r354_setup_row(p_org);
  for it in select * from jsonb_array_elements(p_list) limit 300 loop
    v_name := it ->> 'name'; v_lang := coalesce(nullif(it ->> 'language', ''), 'en');
    continue when coalesce(v_name, '') !~ '^[a-z0-9_]{1,64}$' or v_lang !~ '^[a-z]{2}(_[A-Z]{2})?$';
    v_st := coalesce(public._r354_upper_word(it ->> 'status', 30), 'PENDING');
    v_cat := public._r354_upper_word(it ->> 'category', 30);
    v_q := public._r354_upper_word(coalesce(it #>> '{quality_score,score}', it ->> 'quality_score'), 20);
    select * into j from public.wa_template_jobs where org_id = p_org and name = v_name and language = v_lang for update;
    if j.id is null then
      insert into public.wa_template_jobs(org_id, name, language, state, meta_id, meta_status, category, quality, rejected_reason, final_at)
        values (p_org, v_name, v_lang, public._r354_state_of(v_st),
                case when coalesce(it ->> 'id', '') ~ '^[0-9]{1,30}$' then it ->> 'id' end, v_st, v_cat, v_q,
                case when v_st = 'REJECTED' then public._r354_safe_text(it ->> 'rejected_reason', 300) end,
                case when public._r354_state_of(v_st) in ('approved', 'rejected', 'disabled') then now() end)
        on conflict (org_id, name, language) do nothing;
      n := n + 1;
      continue;
    end if;
    continue when j.state in ('queued', 'creating');
    if j.category is not null and v_cat is not null and j.category <> v_cat then
      v_re := v_re || jsonb_build_array(jsonb_build_object('name', v_name, 'from', j.category, 'to', v_cat));
    end if;
    update public.wa_template_jobs set state = case when j.state = 'failed' and v_st not in ('APPROVED', 'REJECTED') then 'pending' else public._r354_state_of(v_st) end,
           meta_status = v_st,
           meta_id = coalesce(case when coalesce(it ->> 'id', '') ~ '^[0-9]{1,30}$' then it ->> 'id' end, meta_id),
           prev_category = case when category is not null and v_cat is not null and category <> v_cat then category else prev_category end,
           category_changed_at = case when category is not null and v_cat is not null and category <> v_cat then now() else category_changed_at end,
           category = coalesce(v_cat, category), quality = coalesce(v_q, quality),
           rejected_reason = case when v_st = 'REJECTED' then coalesce(public._r354_safe_text(it ->> 'rejected_reason', 300), rejected_reason) else null end,
           last_error = case when v_st in ('APPROVED', 'PENDING') then null else last_error end,
           final_at = case when public._r354_state_of(v_st) in ('approved', 'rejected', 'disabled') then coalesce(final_at, now()) else null end,
           updated_at = now()
     where id = j.id and (meta_status is distinct from v_st or category is distinct from coalesce(v_cat, category)
                          or quality is distinct from coalesce(v_q, quality) or (j.state = 'failed'));
    if found then n := n + 1; end if;
  end loop;
  update public.wa_template_setup set last_sync_at = now(),
         next_sync_at = case when coalesce(p_any_pending, false)
                               or exists (select 1 from public.wa_template_jobs x where x.org_id = p_org and x.state = 'pending')
                             then now() + interval '5 minutes' else null end,
         updated_at = now()
   where org_id = p_org;
  return jsonb_build_object('changed', n, 'recategorised', v_re);
end $$;

-- ---- 9) bell: the wa_templates kind (admins only by default) --------------------------------------------------------------
do $$
declare f record; v_pub regprocedure; v_pre regprocedure;
begin
  for f in select * from (values ('notification_catalog', ''), ('notification_type_of', 'text,text'), ('notify_default', 'uuid,text,text,text')) x(n, a) loop
    v_pub := to_regprocedure('public.' || f.n || '(' || f.a || ')');
    v_pre := to_regprocedure('public.' || f.n || '__pre0354(' || f.a || ')');
    if v_pub is not null and v_pre is null
       and position('r156-0354' in coalesce((select p.prosrc from pg_proc p where p.oid = v_pub), '')) = 0 then
      execute format('alter function public.%I(%s) rename to %I', f.n, f.a, f.n || '__pre0354');
    end if;
  end loop;
end $$;
create or replace function public.notification_catalog()
returns jsonb language sql immutable security definer set search_path = '' as $$
  -- r156-0354: + wa_templates (once)
  select case when exists (select 1 from jsonb_array_elements(c) e where e ->> 'type' = 'wa_templates') then c
    else c || $cat$[
    {"type":"wa_templates","group":"Studio","label":"WhatsApp templates",
     "description":"Meta finished reviewing the WhatsApp message templates (all approved, or which ones were rejected and why), a template category changed, or the number health dropped. Admins only by default.",
     "audience":"studio","channels":["in_app"],"required":[],"gated":[],"money":false}
  ]$cat$::jsonb end
  from (select public.notification_catalog__pre0354() as c) x;
$$;
create or replace function public.notification_type_of(p_kind text, p_channel text default null)
returns text language sql immutable security definer set search_path = '' as $$
  -- r156-0354
  select case when lower(btrim(coalesce(p_kind, ''))) = 'wa_templates' then 'wa_templates'
              else public.notification_type_of__pre0354(p_kind, p_channel) end;
$$;
create or replace function public.notify_default(p_org uuid, p_role text, p_type text, p_channel text)
returns boolean language sql stable security definer set search_path = '' as $$
  -- r156-0354: WhatsApp template notices reach admins only unless a studio admin opts a role in
  select case when p_type = 'wa_templates' then coalesce(p_role = 'admin', false) and p_channel = 'in_app'
              else public.notify_default__pre0354(p_org, p_role, p_type, p_channel) end;
$$;
do $$ begin
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'notifications' and policyname = 'r354_wa_read') then
    create policy r354_wa_read on public.notifications as restrictive for select to authenticated
      using (coalesce(kind, '') <> 'wa_templates' or (select public.is_admin()));
  end if;
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'notifications' and policyname = 'r354_wa_ins') then
    create policy r354_wa_ins on public.notifications as restrictive for insert to authenticated
      with check (coalesce(kind, '') <> 'wa_templates');
  end if;
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'notifications' and policyname = 'r354_wa_upd') then
    create policy r354_wa_upd on public.notifications as restrictive for update to authenticated
      using (coalesce(kind, '') <> 'wa_templates') with check (coalesce(kind, '') <> 'wa_templates');
  end if;
end $$;

-- one bell row for the studio (deduplicated by key)
create or replace function public._r354_bell(p_org uuid, p_key text, p_label text, p_detail jsonb)
returns boolean language plpgsql volatile security definer set search_path = '' as $$
-- r156-0354
begin
  if exists (select 1 from public.notifications n where n.org_id = p_org and n.kind = 'wa_templates' and n.detail ->> 'key' = p_key) then
    return false; end if;
  insert into public.notifications(quote_id, channel, kind, status, detail, org_id)
    values (null, 'in_app', 'wa_templates', 'simulated',
            coalesce(p_detail, '{}'::jsonb) || jsonb_build_object('label', left(p_label, 200), 'key', p_key, 'source', '0354'), p_org);
  return true;
end $$;

-- ---- 10) worker: is the round over? one notice per round ---------------------------------------------------------------------
create or replace function public.wa_template_finish(p_org uuid)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
-- r156-0354: rejected (or could not be created) as soon as one is final and refused, else all approved when nothing waits
declare s public.wa_template_setup; v_wait int; v_bad int; v_ok int; v_names text; v_kind text; v_label text;
begin
  select * into s from public.wa_template_setup where org_id = p_org for update;
  if s.org_id is null or s.batch_id is null then return jsonb_build_object('result', 'none'); end if;
  select count(*) filter (where state in ('queued', 'creating', 'pending')),
         count(*) filter (where state in ('rejected', 'failed', 'paused', 'disabled')),
         count(*) filter (where state = 'approved')
    into v_wait, v_bad, v_ok
    from public.wa_template_jobs where org_id = p_org and batch_id = s.batch_id;
  if v_wait = 0 and s.finished_at is null then
    update public.wa_template_setup set finished_at = now(), updated_at = now() where org_id = p_org;
  end if;
  if s.notified_batch is not distinct from s.batch_id then return jsonb_build_object('result', 'already', 'waiting', v_wait); end if;
  if v_bad > 0 then
    select string_agg(x.name || coalesce(' (' || x.why || ')', ''), ', ') into v_names from (
      select j.name, left(coalesce(j.rejected_reason, j.last_error ->> 'reason'), 60) as why from public.wa_template_jobs j
       where j.org_id = p_org and j.batch_id = s.batch_id and j.state in ('rejected', 'failed', 'paused', 'disabled')
       order by j.name limit 3) x;
    v_kind := 'rejected';
    v_label := v_bad || ' WhatsApp template' || case when v_bad = 1 then ' was' else 's were' end || ' not approved: ' || coalesce(v_names, '')
               || case when v_bad > 3 then ' and more' else '' end || '. Open Integrations to see why and press Fix and resubmit.';
  elsif v_wait = 0 and v_ok > 0 then
    v_kind := 'approved';
    v_label := 'All WhatsApp message templates are approved. WhatsApp messages from your number are ready.';
  else
    return jsonb_build_object('result', 'waiting', 'waiting', v_wait);
  end if;
  perform public._r354_bell(p_org, 'round:' || s.batch_id::text, v_label, jsonb_build_object('event', 'templates_' || v_kind));
  update public.wa_template_setup set notified_batch = s.batch_id, notified_kind = v_kind, updated_at = now() where org_id = p_org;
  return jsonb_build_object('result', v_kind, 'waiting', v_wait);
end $$;

-- a template moved to another category by Meta (utility to marketing costs more): one notice per template + category
create or replace function public.wa_template_category_notice(p_org uuid, p_name text, p_from text, p_to text)
returns boolean language plpgsql volatile security definer set search_path = '' as $$
-- r156-0354
begin
  if p_org is null or coalesce(p_name, '') !~ '^[a-z0-9_]{1,64}$' or public._r354_upper_word(p_to, 30) is null then return false; end if;
  return public._r354_bell(p_org, 'category:' || p_name || ':' || upper(p_to),
    'Meta moved the WhatsApp template ' || p_name || ' from ' || coalesce(lower(public._r354_upper_word(p_from, 30)), 'its category') || ' to '
      || lower(upper(p_to)) || case when upper(p_to) = 'MARKETING' then ' - marketing messages cost more and need opt-in.' else '.' end,
    jsonb_build_object('event', 'category_changed', 'template', p_name));
end $$;

-- ---- 11) worker: number health (quality rating, messaging limit, send health, payment) -------------------------------------
create or replace function public.wa_health_record(p_org uuid, p_health jsonb)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
-- r156-0354: read-only Meta facts, words and numbers only, a new warning set = one bell notice
declare v jsonb; v_warn text; s public.wa_template_setup;
begin
  if p_org is null or p_health is null or jsonb_typeof(p_health) <> 'object' then return jsonb_build_object('result', 'ignored'); end if;
  s := public._r354_setup_row(p_org);
  v := jsonb_strip_nulls(jsonb_build_object(
    'quality', public._r354_upper_word(p_health ->> 'quality', 20),
    'tier', public._r354_upper_word(p_health ->> 'tier', 30),
    'can_send', public._r354_upper_word(p_health ->> 'can_send', 20),
    'name_status', public._r354_upper_word(p_health ->> 'name_status', 30),
    'payment_issue', case when jsonb_typeof(p_health -> 'payment_issue') = 'boolean' then p_health -> 'payment_issue' end,
    'limit_low', case when jsonb_typeof(p_health -> 'limit_low') = 'boolean' then p_health -> 'limit_low' end,
    'errors', (select jsonb_agg(public._r354_safe_text(e, 160)) from (select jsonb_array_elements_text(case when jsonb_typeof(p_health -> 'errors') = 'array' then p_health -> 'errors' else '[]'::jsonb end) e limit 5) x),
    'warnings', (select jsonb_agg(w) from (select jsonb_array_elements_text(case when jsonb_typeof(p_health -> 'warnings') = 'array' then p_health -> 'warnings' else '[]'::jsonb end) w limit 8) x
                   where w ~ '^[a-z_]{1,30}$')));
  v_warn := (select string_agg(w, ',' order by w) from jsonb_array_elements_text(coalesce(v -> 'warnings', '[]'::jsonb)) w);
  update public.wa_template_setup set health = v, health_checked_at = now(), health_warned = v_warn, updated_at = now() where org_id = p_org;
  if v_warn is not null and v_warn is distinct from s.health_warned then
    perform public._r354_bell(p_org, 'health:' || v_warn || ':' || to_char(now(), 'YYYY-MM-DD'),
      'WhatsApp number needs attention: ' || replace(replace(replace(replace(replace(v_warn, 'quality_red', 'quality rating is red'),
        'quality_yellow', 'quality rating is yellow'), 'payment', 'no working payment method in Meta'), 'limit_low', 'daily messaging limit is low'),
        'blocked', 'Meta is blocking sends') || '. Open Integrations for details.',
      jsonb_build_object('event', 'health'));
  end if;
  return jsonb_build_object('result', 'recorded', 'warnings', coalesce(v -> 'warnings', '[]'::jsonb));
end $$;

-- ---- 12) the page: my studio setup (admin only, no secret) ---------------------------------------------------------------------
create or replace function public.my_wa_template_setup()
returns jsonb language plpgsql stable security definer set search_path = '' as $$
-- r156-0354
declare v_org uuid := public.current_org_id(); s public.wa_template_setup; v_jobs jsonb;
begin
  if auth.uid() is null or v_org is null or not coalesce(public.is_admin(), false) then
    raise exception 'not_allowed' using errcode = '42501'; end if;
  select * into s from public.wa_template_setup where org_id = v_org;
  select coalesce(jsonb_agg(jsonb_strip_nulls(jsonb_build_object('name', j.name, 'language', j.language, 'state', j.state,
           'action', j.action, 'variant', j.variant, 'attempts', j.attempts, 'next_attempt_at', j.next_attempt_at,
           'meta_status', j.meta_status, 'category', j.category, 'prev_category', j.prev_category,
           'category_changed_at', j.category_changed_at, 'quality', j.quality, 'rejected_reason', j.rejected_reason,
           'error', j.last_error, 'in_round', j.batch_id is not null and j.batch_id = s.batch_id, 'updated_at', j.updated_at)) order by j.name), '[]'::jsonb)
    into v_jobs from public.wa_template_jobs j where j.org_id = v_org;
  return jsonb_build_object('running', s.batch_id is not null and s.finished_at is null
                                        and exists (select 1 from public.wa_template_jobs j where j.org_id = v_org and j.batch_id = s.batch_id
                                                       and j.state in ('queued', 'creating', 'pending')),
    'started_at', s.started_at, 'finished_at', s.finished_at, 'paused_until', case when s.paused_until > now() then s.paused_until end,
    'last_sync_at', s.last_sync_at, 'notified', s.notified_kind, 'health', s.health, 'health_checked_at', s.health_checked_at,
    'jobs', v_jobs);
end $$;

-- ---- 13) senders: which wording was created for a template (own or Meta library + its variable order) ------------------------
create or replace function public.wa_template_variant(p_org uuid, p_name text, p_language text default 'en')
returns jsonb language sql stable security definer set search_path = '' as $$
  -- r156-0354
  select jsonb_strip_nulls(jsonb_build_object('variant', j.variant, 'library_name', j.library_name, 'param_map', j.param_map, 'state', j.state))
    from public.wa_template_jobs j
   where j.org_id = p_org and j.name = p_name and j.language = coalesce(nullif(p_language, ''), 'en');
$$;

-- ---- 14) background run: pg_cron calls the worker through pg_net with the Vault secret ----------------------------------------
-- Needs two Vault secrets: helm_wa_template_secret (same value as the HELM_WA_TEMPLATE_SECRET edge secret) and
-- helm_wa_worker_url (the full https address of the wa-template-worker function). Missing anything = does nothing.
create or replace function public._r354_kick(p_mode text default 'tick')
returns boolean language plpgsql volatile security definer set search_path = '' as $$
-- r156-0354
declare v_url text; v_secret text;
begin
  if to_regclass('vault.decrypted_secrets') is null or to_regnamespace('net') is null then return false; end if;
  execute 'select decrypted_secret from vault.decrypted_secrets where name = $1 limit 1' into v_secret using 'helm_wa_template_secret';
  execute 'select decrypted_secret from vault.decrypted_secrets where name = $1 limit 1' into v_url using 'helm_wa_worker_url';
  if coalesce(v_secret, '') = '' or coalesce(v_url, '') !~ '^https://[a-z0-9-]+\.supabase\.co/functions/v1/wa-template-worker$' then return false; end if;
  execute 'select net.http_post(url := $1, body := $2, headers := $3, timeout_milliseconds := 15000)'
    using v_url, jsonb_build_object('mode', case when p_mode = 'nightly' then 'nightly' else 'tick' end),
          jsonb_build_object('Content-Type', 'application/json', 'x-helm-cron-secret', v_secret);
  return true;
end $$;

do $$
declare v_ok boolean := false;
begin
  if to_regnamespace('cron') is not null and to_regprocedure('cron.schedule(text,text,text)') is not null
     and to_regnamespace('net') is not null and to_regclass('vault.decrypted_secrets') is not null then
    execute 'select count(*) = 2 from vault.decrypted_secrets where name in ($1, $2) and coalesce(decrypted_secret, $3) <> $3'
      into v_ok using 'helm_wa_template_secret', 'helm_wa_worker_url', '';
    if v_ok then
      if not exists (select 1 from cron.job where jobname = 'helm-wa-templates') then
        perform cron.schedule('helm-wa-templates', '*/3 * * * *', 'select public._r354_kick(''tick'')');
      end if;
      if not exists (select 1 from cron.job where jobname = 'helm-wa-templates-nightly') then
        perform cron.schedule('helm-wa-templates-nightly', '0 21 * * *', 'select public._r354_kick(''nightly'')');
      end if;
    else
      raise notice '0354: cron not scheduled - create the Vault secrets helm_wa_template_secret and helm_wa_worker_url, then run this file again';
    end if;
  end if;
end $$;

-- ---- 15) privileges ----------------------------------------------------------------------------------------------------------
do $$ declare f text; begin
  foreach f in array array['public._r354_state_of(text)', 'public._r354_backoff(integer)', 'public._r354_safe_text(text, integer)',
      'public._r354_clean_error(jsonb)', 'public._r354_upper_word(text, integer)', 'public._r354_setup_row(uuid)',
      'public._r354_start_round(uuid, uuid)', 'public._r354_creates_last_hour(uuid)', 'public._r354_bell(uuid, text, text, jsonb)',
      'public._r354_kick(text)',
      'public.wa_template_enqueue(uuid, jsonb, uuid)', 'public.wa_template_resubmit(text, text)', 'public.wa_template_due_orgs(boolean, integer)',
      'public.wa_template_claim(uuid, integer)', 'public.wa_template_record(uuid, jsonb)', 'public.wa_template_sync(uuid, jsonb, boolean)',
      'public.wa_template_finish(uuid)', 'public.wa_template_category_notice(uuid, text, text, text)', 'public.wa_health_record(uuid, jsonb)',
      'public.my_wa_template_setup()', 'public.wa_template_variant(uuid, text, text)',
      'public.notification_catalog__pre0354()', 'public.notification_type_of__pre0354(text, text)', 'public.notify_default__pre0354(uuid, text, text, text)',
      'public.notification_catalog()', 'public.notification_type_of(text, text)', 'public.notify_default(uuid, text, text, text)'] loop
    continue when to_regprocedure(f) is null;
    execute 'revoke all on function ' || f || ' from public';
    if exists (select 1 from pg_roles where rolname = 'anon') then execute 'revoke all on function ' || f || ' from anon'; end if;
    if exists (select 1 from pg_roles where rolname = 'authenticated') then execute 'revoke all on function ' || f || ' from authenticated'; end if;
    if exists (select 1 from pg_roles where rolname = 'service_role') then execute 'revoke all on function ' || f || ' from service_role'; end if;
  end loop;
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    foreach f in array array['public.wa_template_enqueue(uuid, jsonb, uuid)', 'public.wa_template_due_orgs(boolean, integer)',
        'public.wa_template_claim(uuid, integer)', 'public.wa_template_record(uuid, jsonb)', 'public.wa_template_sync(uuid, jsonb, boolean)',
        'public.wa_template_finish(uuid)', 'public.wa_template_category_notice(uuid, text, text, text)', 'public.wa_health_record(uuid, jsonb)',
        'public.wa_template_variant(uuid, text, text)',
        'public.notification_catalog()', 'public.notification_type_of(text, text)', 'public.notify_default(uuid, text, text, text)'] loop
      execute 'grant execute on function ' || f || ' to service_role';
    end loop;
  end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    execute 'grant execute on function public.wa_template_resubmit(text, text) to authenticated';
    execute 'grant execute on function public.my_wa_template_setup() to authenticated';
    execute 'grant execute on function public.notification_catalog() to authenticated';
    execute 'grant execute on function public.notification_type_of(text, text) to authenticated';
  end if;
end $$;

notify pgrst, 'reload schema';
