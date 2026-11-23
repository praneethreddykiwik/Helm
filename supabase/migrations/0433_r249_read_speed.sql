-- 0433_r249_read_speed.sql - R249 the bell's chat reads stop scanning the whole studio (prod pg_stat_statements 23 Nov 2026: pgrst
-- calls with p_limit at 434 - 2,258 ms mean; every signed-in tab refreshes the bell every 30 s). Forward-only, additive, safe to
-- run twice. ASCII only. Every answer stays the same.
-- REQUIRES 0016 (chat_messages / chat_conversations / chat_members), 0035 (chat_my_mentions).
--
-- In plain words - why it was slow:
--   1  The bell asks "my newest chat messages" (chat_messages, newest 60, row security chat_can_see per row). There was no index on
--      (studio, time), so the database read and row-checked EVERY message the studio ever sent, then sorted them, every 30 s per
--      open tab. Locally with 40,000 messages: 14.9 s; with the index: 38 ms.
--   2  chat_my_mentions (the bell's "@ you" list) asked current_org_id() - five checks: two-step, trial, temporary password,
--      deactivated - once PER message row instead of once per call. Locally: 226 ms -> 6.6 ms.
--   3  Realtime: chat_reactions left the Realtime publication in 0156 and no page listens to it (R235 removed the last binding).
--      If it was added back by hand on a database, it is taken out again (every change to it was being decoded for nobody).
--      Nothing else is taken out: every other published table has a live listener (leads, chat_messages, chat_conversations,
--      quote_live_signals, and quote_versions / quotation_versions for pages opened before 0427 - see the R249 PR).
-- What 0433 does:
--   A  index chat_messages_org_created_idx_0433 on chat_messages (org_id, created_at desc) (create index if not exists; the
--      table is small on production, the build takes well under a second - plain, the SQL editor runs one transaction).
--   B  chat_my_mentions re-issued with auth.uid() / current_org_id() as one-time sub-selects. Same rows, same order (proved by
--      the tests). The old body is kept as chat_my_mentions__pre0433 (server only).
--   C  chat_reactions out of supabase_realtime, only if it is in it.
-- ACCESS: unchanged - chat_my_mentions for signed-in people only; the kept body server only.
-- ZERO DATA LOSS: one index, one re-issued function, one publication membership that nothing listens to. No table, column, row or
--   policy is created, changed or dropped. Safe to run twice.
-- ROLLBACK (manual, only if ever needed): drop function public.chat_my_mentions(integer); alter function
--   public.chat_my_mentions__pre0433(integer) rename to chat_my_mentions; grant execute on it to authenticated. The index can stay.

do $$ begin
  if to_regclass('public.chat_messages') is null or to_regprocedure('public.chat_my_mentions(integer)') is null
     and to_regprocedure('public.chat_my_mentions__pre0433(integer)') is null then
    raise exception 'STOP 0433: apply 0016 and 0035 first'; end if;
end $$;

-- ---- A) the bell's newest-messages read --------------------------------------------------------------------------------------
create index if not exists chat_messages_org_created_idx_0433 on public.chat_messages (org_id, created_at desc);

-- ---- B) chat_my_mentions: the caller asked once per call ----------------------------------------------------------------------
do $$ begin
  if to_regprocedure('public.chat_my_mentions__pre0433(integer)') is null then
    alter function public.chat_my_mentions(integer) rename to chat_my_mentions__pre0433;
  end if;
end $$;

create or replace function public.chat_my_mentions(p_limit integer default 20)
returns table(id uuid, conversation_id uuid, sender_id uuid, kind text, body text, created_at timestamptz, conv_kind text, conv_title text, dm_key text)
language sql stable security definer set search_path = '' as $$
  -- r249-0433: the 0035 body with auth.uid() / current_org_id() asked ONCE per call (sub-selects), not once per message row
  select m.id, m.conversation_id, m.sender_id, m.kind, left(m.body, 300), m.created_at, c.kind, c.title, c.dm_key
    from public.chat_messages m
    join public.chat_conversations c on c.id = m.conversation_id and c.org_id = m.org_id
    left join public.chat_members me on me.conversation_id = m.conversation_id and me.user_id = (select auth.uid())
   where (select auth.uid()) is not null
     and m.org_id = (select public.current_org_id())
     and (m.meta -> 'mentions') ? ((select auth.uid()))::text
     and not m.deleted
     and m.sender_id is distinct from (select auth.uid())
     and (me.user_id is not null or c.kind = 'broadcast')
     and m.created_at > coalesce(me.last_read_at, '-infinity'::timestamptz)
   order by m.created_at desc
   limit least(greatest(coalesce(p_limit, 20), 1), 100);
$$;

do $$ declare r text; begin
  execute 'revoke all on function public.chat_my_mentions(integer) from public';
  execute 'revoke all on function public.chat_my_mentions__pre0433(integer) from public';
  foreach r in array array['anon', 'authenticated', 'service_role'] loop
    if exists (select 1 from pg_roles where rolname = r) then
      execute format('revoke all on function public.chat_my_mentions__pre0433(integer) from %I', r);
    end if;
  end loop;
  if exists (select 1 from pg_roles where rolname = 'anon') then execute 'revoke all on function public.chat_my_mentions(integer) from anon'; end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then execute 'grant execute on function public.chat_my_mentions(integer) to authenticated'; end if;
  if exists (select 1 from pg_roles where rolname = 'service_role') then execute 'grant execute on function public.chat_my_mentions(integer) to service_role'; end if;
end $$;

-- ---- C) Realtime: a table nobody listens to ----------------------------------------------------------------------------------
do $$ begin
  if exists (select 1 from pg_catalog.pg_publication_tables
              where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'chat_reactions') then
    execute 'alter publication supabase_realtime drop table public.chat_reactions';
  end if;
end $$;

do $$ begin
  if to_regclass('public.helm_schema_markers') is not null then
    insert into public.helm_schema_markers(num, name) values (433, '0433_r249_read_speed') on conflict (num) do nothing;
  end if;
end $$;

notify pgrst, 'reload schema';
