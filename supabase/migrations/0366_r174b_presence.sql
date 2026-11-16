-- 0366_r174b_presence.sql - R174b (owner, 16 Nov 2026: "show who is active in the studio on the chat, like a green dot -
-- make it perfect"). REQUIRES current_org_id(), profiles.org_id.
--
-- What it does, in plain words:
--   1  member_presence: one small row per signed-in person: when they were last active in Helm (written at most once
--      every 2 minutes) and their own choice "Show when I am online" (on by default). Nobody can read or write it
--      directly (RLS on, no policies); only the three functions below use it.
--   2  presence_touch(): "I am active now" (the app calls it at most every 3 minutes while the person is using Helm).
--   3  presence_list(): for my studio only - who chose to be shown, and when each was last active, plus my own choice.
--   4  presence_set_visible(on): my own "Show when I am online" switch. Off = nobody sees my dot or last active time.
--   5  Live dots use Supabase Realtime presence on a PRIVATE channel per studio (topic presence:org:<studio id>). Two
--      policies on realtime.messages let a signed-in person join only their own studio channel. Where the realtime
--      schema is missing (local tests) this step is skipped; the app then shows "last active" times only.
--
-- ZERO DATA LOSS: additive + idempotent. One new table, new functions, two new realtime policies. Nothing dropped,
-- nothing deleted. Safe to run twice. ASCII only.

-- ---- 0) preflight ---------------------------------------------------------------------------------------------------
do $$
begin
  if to_regprocedure('public.current_org_id()') is null then raise exception 'STOP 0366: current_org_id missing'; end if;
  if not exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'profiles' and column_name = 'org_id') then
    raise exception 'STOP 0366: profiles.org_id missing'; end if;
end $$;

-- ---- 1) the table ---------------------------------------------------------------------------------------------------
create table if not exists public.member_presence (
  user_id       uuid primary key,
  org_id        uuid not null,
  last_seen_at  timestamptz,
  show_online   boolean not null default true,
  updated_at    timestamptz not null default now()
);
create index if not exists member_presence_org_idx on public.member_presence (org_id);
alter table public.member_presence enable row level security;
revoke all on table public.member_presence from public;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'anon') then execute 'revoke all on table public.member_presence from anon'; end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then execute 'revoke all on table public.member_presence from authenticated'; end if;
end $$;

-- a read-only (suspended / ended trial) studio writes nothing here either (same guard as every studio table)
do $$ begin
  if to_regprocedure('public.tg_studio_read_only()') is not null
     and not exists (select 1 from pg_trigger where tgrelid = 'public.member_presence'::regclass and tgname = 'zzz_studio_read_only') then
    create trigger zzz_studio_read_only before insert or update or delete on public.member_presence for each row execute function public.tg_studio_read_only('org_id');
  end if;
end $$;

-- ---- 2) presence_touch: I am active now (server-side throttle: at most one write per 2 minutes) -------------------------
create or replace function public.presence_touch()
returns void language plpgsql volatile security definer set search_path = '' as $$
-- r174b-0366
declare v_uid uuid := auth.uid(); v_org uuid := public.current_org_id();
begin
  if v_uid is null or v_org is null then return; end if;
  insert into public.member_presence as mp (user_id, org_id, last_seen_at, updated_at)
    values (v_uid, v_org, now(), now())
  on conflict (user_id) do update set last_seen_at = now(), org_id = v_org, updated_at = now()
    where mp.last_seen_at is null or mp.last_seen_at < now() - interval '2 minutes' or mp.org_id <> v_org;
exception when others then
  return;   -- a read-only studio (or any hiccup): no last active time, never an error in the app
end $$;

-- ---- 3) presence_list: my studio only, people who chose to be shown --------------------------------------------------
create or replace function public.presence_list()
returns jsonb language plpgsql stable security definer set search_path = '' as $$
-- r174b-0366
declare v_uid uuid := auth.uid(); v_org uuid := public.current_org_id();
begin
  if v_uid is null or v_org is null then raise exception 'not authorized' using errcode = '42501'; end if;
  return jsonb_build_object(
    'me_show', coalesce((select mp.show_online from public.member_presence mp where mp.user_id = v_uid), true),
    'people', coalesce((
      select jsonb_agg(jsonb_build_object('user_id', p.id, 'last_seen_at', mp.last_seen_at))
        from public.profiles p
        join public.member_presence mp on mp.user_id = p.id and mp.org_id = v_org and mp.show_online
       where p.org_id = v_org and p.id <> v_uid), '[]'::jsonb),
    'hidden', coalesce((
      select jsonb_agg(p.id)
        from public.profiles p
        join public.member_presence mp on mp.user_id = p.id and not mp.show_online
       where p.org_id = v_org and p.id <> v_uid), '[]'::jsonb));
end $$;

-- ---- 4) presence_set_visible: my own switch ----------------------------------------------------------------------------
create or replace function public.presence_set_visible(p_show boolean)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
-- r174b-0366
declare v_uid uuid := auth.uid(); v_org uuid := public.current_org_id();
begin
  if v_uid is null or v_org is null then raise exception 'not authorized' using errcode = '42501'; end if;
  insert into public.member_presence as mp (user_id, org_id, show_online, updated_at)
    values (v_uid, v_org, coalesce(p_show, true), now())
  on conflict (user_id) do update set show_online = coalesce(p_show, true), org_id = v_org, updated_at = now();
  return jsonb_build_object('ok', true, 'show_online', coalesce(p_show, true));
end $$;

-- ---- 5) grants -----------------------------------------------------------------------------------------------------------
do $$
declare f text;
begin
  foreach f in array array['public.presence_touch()', 'public.presence_list()', 'public.presence_set_visible(boolean)'] loop
    execute format('revoke all on function %s from public', f);
    if exists (select 1 from pg_roles where rolname = 'anon') then execute format('revoke all on function %s from anon', f); end if;
    if exists (select 1 from pg_roles where rolname = 'authenticated') then execute format('grant execute on function %s to authenticated', f); end if;
  end loop;
end $$;

-- ---- 5b) free-trial retention (0184): presence rows go with the studio data (like staff_links, 0363) ---------------------------
do $$ declare v_def text; begin
  if to_regprocedure('public._tr184_purge_tables()') is not null then
    v_def := pg_get_functiondef('public._tr184_purge_tables()'::regprocedure);
    if position('''member_presence''' in v_def) = 0 then
      if position('''staff_links'', ''assign_notify_outbox''' in v_def) = 0 then
        raise notice '0366: _tr184_purge_tables has an unexpected body - left unchanged';
      else execute replace(v_def, '''staff_links'', ''assign_notify_outbox''', '''staff_links'', ''member_presence'', ''assign_notify_outbox'''); end if;
    end if;
  end if;
end $$;

-- ---- 6) realtime: a signed-in person may join only their own studio presence channel (private channel) ---------------------
do $$
begin
  if to_regclass('realtime.messages') is null or to_regprocedure('realtime.topic()') is null then
    raise notice '0366: no realtime schema here - live dots are skipped, last active times still work';
    return;
  end if;
  if not exists (select 1 from pg_policies where schemaname = 'realtime' and tablename = 'messages' and policyname = 'helm_presence_read_own_studio') then
    execute $p$create policy helm_presence_read_own_studio on realtime.messages for select to authenticated
      using (realtime.messages.extension = 'presence' and realtime.topic() = 'presence:org:' || public.current_org_id()::text)$p$;
  end if;
  if not exists (select 1 from pg_policies where schemaname = 'realtime' and tablename = 'messages' and policyname = 'helm_presence_write_own_studio') then
    execute $p$create policy helm_presence_write_own_studio on realtime.messages for insert to authenticated
      with check (realtime.messages.extension = 'presence' and realtime.topic() = 'presence:org:' || public.current_org_id()::text)$p$;
  end if;
end $$;

-- VERIFY every line should say true (line 05 is true where there is no realtime schema, e.g. local tests)
select item, ok from (values
  ('01 presence table, RLS on, closed to the app', to_regclass('public.member_presence') is not null
     and coalesce((select c.relrowsecurity from pg_class c where c.oid = to_regclass('public.member_presence')), false)
     and not has_table_privilege('authenticated', 'public.member_presence', 'select')
     and not has_table_privilege('anon', 'public.member_presence', 'select')),
  ('02 touch / list / switch for signed-in people only', coalesce(has_function_privilege('authenticated', 'public.presence_touch()', 'execute')
     and has_function_privilege('authenticated', 'public.presence_list()', 'execute')
     and has_function_privilege('authenticated', 'public.presence_set_visible(boolean)', 'execute')
     and not has_function_privilege('anon', 'public.presence_list()', 'execute')
     and not has_function_privilege('anon', 'public.presence_touch()', 'execute'), false)),
  ('03 functions are the R174b ones', position('r174b-0366' in coalesce(pg_get_functiondef(to_regprocedure('public.presence_list()')), '')) > 0),
  ('04 server throttle (one write per 2 minutes)', position('2 minutes' in coalesce(pg_get_functiondef(to_regprocedure('public.presence_touch()')), '')) > 0),
  ('06 free-trial purge knows the presence table (or 0184 is absent)', to_regprocedure('public._tr184_purge_tables()') is null
     or position('member_presence' in pg_get_functiondef(to_regprocedure('public._tr184_purge_tables()'))) > 0),
  ('05 realtime policies (own studio channel only) or no realtime here', to_regclass('realtime.messages') is null
     or (select count(*) = 2 from pg_policies where schemaname = 'realtime' and tablename = 'messages'
          and policyname in ('helm_presence_read_own_studio', 'helm_presence_write_own_studio')))
) v(item, ok) order by item;
