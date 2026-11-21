-- APPLY-0411 (R242 fix plan Phase 5: Helm-wide photo render limits - cost safety - and the AI-generated mark).
-- Run on STAGING first, then production. Safe to run twice. Needs 0095 (photo renders) - already on both.
-- What it does:
--   * New one-row table helm_render_cap (owner only): renders_on (pause renders for every studio), pictures per studio
--     per day (40), pictures per day for all studios (300), per month (3000) and an estimated cost per month (600 USD).
--     Change a limit in the SQL editor, e.g.  update public.helm_render_cap set helm_monthly_usd = 300 where id;
--   * When a limit is reached, the studio gets a plain message and nothing is ordered or charged. HQ gets one bell notice
--     a day once the month passes 80% of a Helm-wide limit.
--   * New pictures are marked ai_generated (the builder and the client booklet show an "AI-generated" label).
--   * Redeploy render-photo (R242) so the studio sees the plain message (the old one says "could not start the render").
-- Nothing is deleted. One new table, one new column (default true), functions, one check trigger on photo_render_usage.
-- It waits at most 5 seconds for a table lock (then stops with an error and changes nothing - just run it again later).
-- Paste the whole file into the Supabase SQL editor and press Run. The last result lists checks - every ok must be true.
begin;
set local lock_timeout = '5s';
set local statement_timeout = '5min';
-- 0411_r242_render_cap.sql - CANONICAL forward-only. R242 (fix plan Phase 5, owner approved 20 Nov 2026; INT-05 cost safety,
-- LEG-06 AI label). REQUIRES 0095 (photo_render_usage, photo_render_begin). Nothing else.
--
-- In plain words:
--   Photo renders are paid for per picture (OpenAI). Until now the only limits were per studio (0095: a monthly quota and an
--   hourly limit, set by the studio's admin). This adds Helm-wide limits that only the owner can change:
--     * one switch "photo renders on / paused for everyone" (renders_on, on by default - nothing changes until you use it);
--     * a DAILY limit per studio (studio_daily_images, default 40 pictures a day);
--     * Helm-wide daily and monthly limits on the number of pictures (helm_daily_images 300, helm_monthly_images 3000) and on
--       the estimated cost of the month (helm_monthly_usd 600 US dollars).
--   When a limit is reached the studio gets a plain message ("Helm's photo renders are paused for today - try again
--   tomorrow") and nothing is charged. HQ gets ONE bell notice a day (with a count) once the month passes 80% of a Helm-wide limit.
--   The check runs in the database itself (a BEFORE INSERT trigger on photo_render_usage, the row photo_render_begin writes
--   before the picture is ordered), so it works with the deployed render-photo too; the redeployed render-photo (R242)
--   only turns the refusal into the plain message instead of "could not start the render".
--   render_cap_status() (signed-in staff of a studio, read-only): the Helm-wide state for the builder's photo panel.
--   Each picture made from now on is also marked "AI-generated" (column photo_renders.ai_generated, default true) so the
--   booklet and the builder can label it (LEG-06; the label itself is in the page code + the file marker in render-photo).
--
-- ZERO DATA LOSS: additive + idempotent. One new one-row table helm_render_cap, one new column (default true, no rewrite of
-- old rows' data), functions, one BEFORE INSERT trigger (it only refuses a NEW render over a limit; it never changes or
-- deletes a row). Nothing dropped, nothing deleted. Safe to run twice. ASCII only.
-- Test switch: helm.render_cap = off (older suites that make many fake renders).
-- Undo (manual): update public.helm_render_cap set renders_on = true, studio_daily_images = 1000, helm_daily_images = 100000,
--   helm_monthly_images = 1000000, helm_monthly_usd = null; (or drop trigger zz_r411_render_cap on public.photo_render_usage)

do $$
begin
  if to_regclass('public.photo_render_usage') is null or to_regclass('public.photo_renders') is null then
    raise exception 'STOP 0411: photo_render_usage / photo_renders missing - run 0095 first'; end if;
end $$;

create table if not exists public.helm_render_cap (
  id                  boolean primary key default true check (id),
  renders_on          boolean not null default true,
  studio_daily_images integer not null default 40,
  helm_daily_images   integer not null default 300,
  helm_monthly_images integer not null default 3000,
  helm_monthly_usd    numeric(10,2) default 600,
  warn_pct            integer not null default 80,
  paused_message      text,
  updated_at          timestamptz not null default now(),
  updated_by          uuid,
  constraint helm_render_cap_studio_chk411 check (studio_daily_images between 0 and 1000),
  constraint helm_render_cap_daily_chk411 check (helm_daily_images between 0 and 100000),
  constraint helm_render_cap_monthly_chk411 check (helm_monthly_images between 0 and 1000000),
  constraint helm_render_cap_usd_chk411 check (helm_monthly_usd is null or helm_monthly_usd between 0 and 100000),
  constraint helm_render_cap_warn_chk411 check (warn_pct between 50 and 100),
  constraint helm_render_cap_msg_chk411 check (paused_message is null or char_length(paused_message) between 3 and 200)
);
comment on table public.helm_render_cap is
  'r242-0411: Helm-wide photo render limits (owner only, SQL editor): renders_on (false = paused for every studio), pictures per studio per day, Helm-wide pictures per day / month, estimated US dollars per month (null = no cost limit), HQ bell at warn_pct %. One row.';
insert into public.helm_render_cap(id) values (true) on conflict (id) do nothing;
alter table public.helm_render_cap enable row level security;

alter table public.photo_renders add column if not exists ai_generated boolean not null default true;
comment on column public.photo_renders.ai_generated is
  'r242-0411 (LEG-06, IT Rules 2026 amendment): the picture was made by an AI model - shown with an "AI-generated" label wherever it is shown or downloaded.';

-- pictures counted against a limit: finished ok + still running in the last 15 minutes (the 0095 rule), all studios
create or replace function public._r411_used(p_org uuid, p_since timestamptz)
returns table(images bigint, usd numeric) language sql stable security definer set search_path = '' as $$
  select coalesce(sum(u.n), 0)::bigint, coalesce(sum(u.cost_usd), 0)::numeric
    from public.photo_render_usage u
   where u.created_at >= p_since and (p_org is null or u.org_id = p_org)
     and (u.status = 'ok' or (u.status = 'pending' and u.created_at > now() - interval '15 minutes'));
$$;

-- the limits + what is used, as one object (no studio names, no ids)
create or replace function public._r411_state(p_org uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare c public.helm_render_cap; d record; m record; v_s bigint; v_day timestamptz := date_trunc('day', now()); v_month timestamptz := date_trunc('month', now());
begin
  select * into c from public.helm_render_cap where id;
  if c.id is null then c.renders_on := true; c.studio_daily_images := 40; c.helm_daily_images := 300; c.helm_monthly_images := 3000; c.helm_monthly_usd := 600; c.warn_pct := 80; end if;
  select * into d from public._r411_used(null, v_day);
  select * into m from public._r411_used(null, v_month);
  if p_org is not null then select u.images into v_s from public._r411_used(p_org, v_day) u; end if;
  return jsonb_build_object('renders_on', c.renders_on, 'studio_daily_images', c.studio_daily_images, 'helm_daily_images', c.helm_daily_images,
    'helm_monthly_images', c.helm_monthly_images, 'helm_monthly_usd', c.helm_monthly_usd, 'warn_pct', c.warn_pct,
    'helm_day_used', d.images, 'helm_month_used', m.images, 'helm_month_usd', round(m.usd, 2),
    'studio_day_used', v_s, 'day_resets_at', v_day + interval '1 day', 'month_resets_at', v_month + interval '1 month');
end $$;

-- the BEFORE INSERT check (photo_render_begin inserts the pending usage row before the picture is ordered)
create or replace function public._r411_tg_render_cap()
returns trigger language plpgsql security definer set search_path = '' as $$
-- r242-0411: refuse a NEW render over a Helm-wide limit (plain message, hint for the edge function). Never changes a row.
declare c public.helm_render_cap; v jsonb; v_n integer := coalesce(NEW.n, 1); v_cost numeric := coalesce(NEW.cost_usd, 0); v_pct numeric;
begin
  if coalesce(current_setting('helm.render_cap', true), '') = 'off' then return NEW; end if;
  if NEW.status is distinct from 'pending' then return NEW; end if;
  select * into c from public.helm_render_cap where id;
  if c.id is null then return NEW; end if;
  if not c.renders_on then
    raise exception '%', coalesce(c.paused_message, 'Photo renders are paused for all studios right now. Please try again later.')
      using errcode = 'P0001', hint = 'render_helm_off';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('photo_render:helm', 0));   -- one check at a time Helm-wide (renders are rare)
  v := public._r411_state(NEW.org_id);
  if (v ->> 'studio_day_used')::bigint + v_n > c.studio_daily_images then
    raise exception 'Your studio has made its % photo renders for today. You can make more tomorrow.', c.studio_daily_images
      using errcode = 'P0001', hint = 'render_day_cap';
  end if;
  if (v ->> 'helm_day_used')::bigint + v_n > c.helm_daily_images then
    raise exception 'Helm''s photo renders are paused for today (the daily limit for all studios is reached). Please try again tomorrow.'
      using errcode = 'P0001', hint = 'render_helm_cap';
  end if;
  if (v ->> 'helm_month_used')::bigint + v_n > c.helm_monthly_images
     or (c.helm_monthly_usd is not null and (v ->> 'helm_month_usd')::numeric + v_cost > c.helm_monthly_usd) then
    raise exception 'Helm''s photo renders are paused until next month (the monthly limit for all studios is reached).'
      using errcode = 'P0001', hint = 'render_helm_cap';
  end if;
  -- one HQ bell notice a day once the month passes warn_pct % of a Helm-wide limit (never blocks the render)
  begin
    v_pct := greatest(((v ->> 'helm_month_used')::numeric + v_n) * 100 / nullif(c.helm_monthly_images, 0),
                      case when c.helm_monthly_usd is not null then ((v ->> 'helm_month_usd')::numeric + v_cost) * 100 / nullif(c.helm_monthly_usd, 0) end);
    if v_pct >= c.warn_pct and to_regclass('public.hq_security_notices') is not null then
      insert into public.hq_security_notices(org_key, org_id, alert_type, day, count, first_at, last_at, detail)
        values ('00000000-0000-0000-0000-000000000000'::uuid, null, 'render_cap', (now() at time zone 'Asia/Kolkata')::date, 1, now(), now(),
                jsonb_build_object('subject_name', floor(v_pct)::int || '% of this month''s Helm-wide photo render limit used', 'source', '0411'))
      on conflict (org_key, alert_type, day) do update
        set count = public.hq_security_notices.count + 1, last_at = now(), detail = excluded.detail;
    end if;
  exception when others then null;
  end;
  return NEW;
end $$;

do $$ begin
  execute 'create or replace trigger zz_r411_render_cap before insert on public.photo_render_usage for each row execute function public._r411_tg_render_cap()';
end $$;

-- the HQ bell label for the notice (patched in place, like 0271 did; left unchanged when the body is unexpected)
do $$ declare v_def text; v_old text := 'else ''Security event'' end'; begin
  if to_regprocedure('public._sa54_label(text)') is null then return; end if;
  v_def := pg_get_functiondef('public._sa54_label(text)'::regprocedure);
  if position('Photo render limit' in v_def) > 0 then return; end if;
  if (length(v_def) - length(replace(v_def, v_old, ''))) <> length(v_old) then
    raise notice '0411: _sa54_label has an unexpected body - left unchanged (the HQ bell says "Security event")'; return; end if;
  execute replace(v_def, v_old, 'when ''render_cap'' then ''Photo render limit'' ' || v_old);
end $$;

-- the builder's photo panel: Helm-wide state (signed-in staff of a studio; numbers only)
create or replace function public.render_cap_status()
returns jsonb language plpgsql stable security definer set search_path = '' as $$
-- r242-0411
declare v_org uuid := public.current_org_id(); v jsonb;
begin
  if auth.uid() is null or v_org is null then raise exception 'not authorized' using errcode = '42501'; end if;
  v := public._r411_state(v_org);
  return jsonb_build_object('renders_on', v -> 'renders_on', 'studio_daily_images', v -> 'studio_daily_images', 'studio_day_used', v -> 'studio_day_used',
    'helm_day_full', (v ->> 'helm_day_used')::bigint >= (v ->> 'helm_daily_images')::bigint,
    'helm_month_full', (v ->> 'helm_month_used')::bigint >= (v ->> 'helm_monthly_images')::bigint
                       or ((v ->> 'helm_monthly_usd') is not null and (v ->> 'helm_month_usd')::numeric >= (v ->> 'helm_monthly_usd')::numeric),
    'day_resets_at', v -> 'day_resets_at', 'ai_label', true);
end $$;

do $$ declare f text; r text; begin
  foreach f in array array['public._r411_used(uuid, timestamp with time zone)', 'public._r411_state(uuid)', 'public._r411_tg_render_cap()',
      'public.render_cap_status()'] loop
    execute format('revoke all on function %s from public', f);
    foreach r in array array['anon', 'authenticated', 'service_role'] loop
      if exists (select 1 from pg_roles where rolname = r) then execute format('revoke all on function %s from %I', f, r); end if;
    end loop;
  end loop;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    execute 'grant execute on function public.render_cap_status() to authenticated';
  end if;
  execute 'revoke all on table public.helm_render_cap from public';
  foreach r in array array['anon', 'authenticated'] loop
    if exists (select 1 from pg_roles where rolname = r) then execute format('revoke all on table public.helm_render_cap from %I', r); end if;
  end loop;
end $$;

-- ---- checks (every ok must be true) --------------------------------------------------------------------------------------
select item, ok, note from (
  select '01 helm_render_cap: one row, row security on, no app access' as item,
     (select count(*) from public.helm_render_cap) = 1
     and coalesce((select c.relrowsecurity from pg_class c where c.oid = to_regclass('public.helm_render_cap')), false)
     and not has_table_privilege('authenticated', 'public.helm_render_cap', 'select') as ok,
     (select 'renders ' || case when renders_on then 'ON' else 'PAUSED' end || ', studio/day ' || studio_daily_images || ', Helm day ' || helm_daily_images
             || ', Helm month ' || helm_monthly_images || ', USD/month ' || coalesce(helm_monthly_usd::text, 'no limit') from public.helm_render_cap where id) as note
  union all
  select '02 cap trigger on photo_render_usage',
     exists (select 1 from pg_trigger t where t.tgname = 'zz_r411_render_cap' and t.tgrelid = 'public.photo_render_usage'::regclass), ''
  union all
  select '03 photo_renders.ai_generated (default true)',
     exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'photo_renders' and column_name = 'ai_generated'
               and column_default = 'true'), ''
  union all
  select '04 render_cap_status: signed-in only; helpers: no app privilege',
     has_function_privilege('authenticated', 'public.render_cap_status()', 'execute')
     and not has_function_privilege('anon', 'public.render_cap_status()', 'execute')
     and not has_function_privilege('authenticated', 'public._r411_state(uuid)', 'execute')
     and not has_function_privilege('authenticated', 'public._r411_tg_render_cap()', 'execute'), ''
  union all
  select '05 HQ bell label for the 80% notice',
     to_regprocedure('public._sa54_label(text)') is null or public._sa54_label('render_cap') = 'Photo render limit', ''
  union all
  select '06 used so far (report only)', true,
     (select (public._r411_state(null) ->> 'helm_month_used') || ' picture(s) this month, ' || (public._r411_state(null) ->> 'helm_day_used') || ' today, about USD '
             || (public._r411_state(null) ->> 'helm_month_usd'))
) v order by item;
commit;
