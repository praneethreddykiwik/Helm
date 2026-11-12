-- APPLY-0351 (R154e Suggestion box v2). Run on STAGING first, then production. Safe to run twice.
begin;
-- 0351_r154e_suggestion_box.sql - R154e Suggestion box v2. CANONICAL forward-only, additive, safe to run twice.
-- REQUIRES 0271 (suggestions + submit_suggestion + hq_suggestions + hq_set_suggestion), 0277 (HQ roles gate),
--          0298 (masked HQ lists, _r57_mask_rows), 0050 (rate_hit).
--
-- In plain words (owner, R154e: any signed-in person of a studio sends an idea to the Helm team, HQ sees all of them,
-- marks New / Planned / Done / Not now and writes a short reply the sender can read):
--   1  suggestions gets NEW nullable / defaulted columns: reply (shown to the sender), replied_at, replied_by,
--      reply_seen_at (the sender opened it), share_with_studio (default false: the sender ticks it so people of the
--      same studio can see it and add a +1). The status check is widened ONCE to a superset (new, reviewed, planned,
--      done, not_now): every existing row still passes, no row is changed.
--   2  NEW suggestion_votes (one row per person per suggestion, active true or false: a +1 taken back is kept as
--      active false, never deleted). RLS on, no table privilege for the app: only the functions below touch it.
--   3  A BEFORE INSERT trigger on suggestions: at most 20 suggestions a day per signed-in person (any route), and the
--      share tick passed by suggestion_submit (a transaction-local setting, only for the person own new row).
--   4  NEW signed-in functions: suggestion_submit (the app form, 0271 rules + share tick + the daily cap answer),
--      my_suggestions (my own rows + the shared rows of my studio, with status, reply, +1 count), suggestion_vote,
--      suggestion_share (my own row only), suggestion_replies_seen, my_suggestion_unread (count of unread replies).
--      A studio member never sees who wrote a shared row of someone else, only the text, status, reply and +1 count.
--   5  HQ: hq_suggestions re-issued in full (same masking as 0298 + reply, votes, shared), hq_set_suggestion re-issued
--      with the wider status list, NEW hq_reply_suggestion (inbox.write via the same hq.suggestion.update action, audited).
--      Each previous body kept once as name__pre0351 with no app privilege.
--   The HQ bell for a new suggestion is the 0271 one (unchanged). Text is stored as plain text, never HTML.
--   Nothing dropped or deleted. No existing row changed. Safe to run twice. ASCII only.
-- ROLLBACK (manual, only if ever needed): the app keeps working on the 0271 functions, the new columns can stay.

do $$ begin
  if to_regclass('public.suggestions') is null or to_regprocedure('public.submit_suggestion(jsonb)') is null
     or to_regprocedure('public.hq_suggestions(text)') is null or to_regprocedure('public.hq_set_suggestion(uuid,text,text)') is null then
    raise exception 'STOP 0351: the 0271 suggestions box is not applied'; end if;
  if to_regprocedure('public._hq_gate(text,text)') is null or to_regprocedure('public._hq_wgate(text,text,text,jsonb)') is null then
    raise exception 'STOP 0351: HQ gates (0029 / 0277) missing'; end if;
  if to_regprocedure('public._r57_mask_rows(jsonb,text[],text[])') is null then raise exception 'STOP 0351: 0298 masking missing'; end if;
  if to_regprocedure('public.rate_hit(text,text,integer,integer)') is null then raise exception 'STOP 0351: 0050 rate_hit missing'; end if;
end $$;

-- ---- 0) keep a previous function body once as name__pre0351 (no app privilege) -----------------------------------
create or replace function public._r351_keep(p_fn text)
returns void language plpgsql volatile security definer set search_path = '' as $$
declare v_oid oid := to_regprocedure(p_fn); v_name text; v_types text; v_def text; v_pre text;
begin
  if v_oid is null then return; end if;
  if position('r154e-0351' in coalesce((select p.prosrc from pg_proc p where p.oid = v_oid), '')) > 0 then return; end if;
  select p.proname, oidvectortypes(p.proargtypes) into v_name, v_types from pg_proc p where p.oid = v_oid;
  v_pre := format('public.%I(%s)', v_name || '__pre0351', v_types);
  if to_regprocedure(v_pre) is not null then return; end if;
  v_def := pg_get_functiondef(v_oid);
  v_def := regexp_replace(v_def, '^CREATE OR REPLACE FUNCTION public\.' || v_name || '\(',
                          'CREATE OR REPLACE FUNCTION public.' || v_name || '__pre0351(');
  if position(v_name || '__pre0351(' in v_def) = 0 then raise exception 'r154e-0351: could not keep %', p_fn; end if;
  execute v_def;
  execute format('revoke all on function %s from public', v_pre);
  if exists (select 1 from pg_roles where rolname = 'anon') then execute format('revoke all on function %s from anon', v_pre); end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then execute format('revoke all on function %s from authenticated', v_pre); end if;
end $$;
revoke all on function public._r351_keep(text) from public;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'anon') then execute 'revoke all on function public._r351_keep(text) from anon'; end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then execute 'revoke all on function public._r351_keep(text) from authenticated'; end if;
end $$;
select public._r351_keep('public.hq_suggestions(text)');
select public._r351_keep('public.hq_set_suggestion(uuid,text,text)');

-- ---- 1) new columns + the wider status list --------------------------------------------------------------------
alter table public.suggestions add column if not exists reply text check (reply is null or char_length(reply) between 1 and 1000);
alter table public.suggestions add column if not exists replied_at timestamptz;
alter table public.suggestions add column if not exists replied_by uuid;
alter table public.suggestions add column if not exists reply_seen_at timestamptz;
alter table public.suggestions add column if not exists share_with_studio boolean not null default false;

do $$
declare v_def text;
begin
  select pg_get_constraintdef(c.oid) into v_def from pg_constraint c
   where c.conrelid = 'public.suggestions'::regclass and c.conname = 'suggestions_status_check';
  if v_def is null or position('not_now' in v_def) = 0 then
    -- superset of the 0271 list: every existing row (new, reviewed, done) still passes
    execute 'alter table public.suggestions drop constraint if exists suggestions_status_check, '
         || 'add constraint suggestions_status_check check (status in (''new'', ''reviewed'', ''planned'', ''done'', ''not_now''))';
  end if;
end $$;

create index if not exists suggestions_user_created_0351 on public.suggestions (user_id, created_at desc) where user_id is not null;
create index if not exists suggestions_studio_shared_0351 on public.suggestions (studio_id, created_at desc) where share_with_studio;

-- ---- 2) +1 votes (kept, never deleted: a +1 taken back is active false) ------------------------------------------
create table if not exists public.suggestion_votes (
  suggestion_id uuid not null references public.suggestions(id) on delete cascade,
  user_id       uuid not null,
  studio_id     uuid,
  active        boolean not null default true,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  primary key (suggestion_id, user_id)
);
create index if not exists suggestion_votes_user_0351 on public.suggestion_votes (user_id);
do $$ begin
  execute 'alter table public.suggestion_votes enable row level security';
  execute 'revoke all on table public.suggestion_votes from public';
  if exists (select 1 from pg_roles where rolname = 'anon') then execute 'revoke all on table public.suggestion_votes from anon'; end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then execute 'revoke all on table public.suggestion_votes from authenticated'; end if;
  if exists (select 1 from pg_roles where rolname = 'service_role') then execute 'grant select on table public.suggestion_votes to service_role'; end if;
end $$;

-- ---- 3) the insert guard: 20 a day per signed-in person, the share tick --------------------------------------------
create or replace function public._r351_tg_suggestion_guard()
returns trigger language plpgsql security definer set search_path = '' as $$
-- r154e-0351
begin
  if new.user_id is not null then
    if (select count(*) from public.suggestions s where s.user_id = new.user_id and s.created_at > now() - interval '1 day') >= 20 then
      raise exception 'You have sent 20 suggestions today. Thank you - please send more tomorrow.'
        using errcode = 'P0001', hint = 'rate_limited';
    end if;
    new.share_with_studio := new.studio_id is not null and coalesce(current_setting('helm.r351_share', true), '') = 'on';
  else
    new.share_with_studio := false;
  end if;
  new.reply := null; new.replied_at := null; new.replied_by := null; new.reply_seen_at := null;
  return new;
end $$;
revoke all on function public._r351_tg_suggestion_guard() from public;
drop trigger if exists zz_r351_suggestion_guard on public.suggestions;
create trigger zz_r351_suggestion_guard before insert on public.suggestions
  for each row execute function public._r351_tg_suggestion_guard();

-- ---- 4) the app side (signed in) --------------------------------------------------------------------------------
-- one row as the sender or a studio member sees it (never the e-mail, network, browser or the HQ note)
create or replace function public._r351_row(g public.suggestions, p_uid uuid)
returns jsonb language sql stable security definer set search_path = '' as $$
  -- r154e-0351
  select jsonb_build_object('id', g.id, 'message', g.message, 'category', g.category, 'page', g.page, 'status', g.status,
    'reply', g.reply, 'replied_at', g.replied_at, 'created_at', g.created_at, 'shared', g.share_with_studio,
    'mine', g.user_id = p_uid,
    'unread', g.user_id = p_uid and g.reply is not null and (g.reply_seen_at is null or g.reply_seen_at < g.replied_at),
    'votes', (select count(*) from public.suggestion_votes v where v.suggestion_id = g.id and v.active),
    'voted', exists (select 1 from public.suggestion_votes v where v.suggestion_id = g.id and v.user_id = p_uid and v.active))
$$;

create or replace function public._r351_org()
returns uuid language plpgsql stable security definer set search_path = '' as $$
-- r154e-0351: the caller studio, null when there is none (never an error)
begin
  return public.current_org_id();
exception when others then return null;
end $$;

-- p: {message, category, page, share (true / false), website}
create or replace function public.suggestion_submit(p jsonb)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
-- r154e-0351: the app form - the 0271 rules (submit_suggestion) + the share tick + a plain answer for the daily cap
declare v_uid uuid := auth.uid(); v_share boolean; v_body jsonb; r jsonb;
begin
  if v_uid is null then raise exception 'not signed in' using errcode = '42501'; end if;
  if p is null or jsonb_typeof(p) <> 'object' then
    return jsonb_build_object('ok', false, 'reason', 'invalid', 'message', 'Please write your suggestion.'); end if;
  v_share := case when jsonb_typeof(p -> 'share') = 'boolean' then (p ->> 'share')::boolean else false end;
  v_body := p - 'share';
  if (select count(*) from public.suggestions s where s.user_id = v_uid and s.created_at > now() - interval '1 day') >= 20 then
    return jsonb_build_object('ok', false, 'reason', 'rate', 'message', 'You have sent 20 suggestions today. Thank you - please send more tomorrow.'); end if;
  perform set_config('helm.r351_share', case when v_share then 'on' else 'off' end, true);
  r := public.submit_suggestion(v_body);
  perform set_config('helm.r351_share', 'off', true);
  return r;
end $$;

create or replace function public.my_suggestions()
returns jsonb language plpgsql stable security definer set search_path = '' as $$
-- r154e-0351: my own suggestions (newest first) + the ones people of my studio shared (most +1 first)
declare v_uid uuid := auth.uid(); v_org uuid;
begin
  if v_uid is null then raise exception 'not signed in' using errcode = '42501'; end if;
  v_org := public._r351_org();
  return jsonb_build_object(
    'mine', coalesce((select jsonb_agg(z.j order by z.created_at desc)
                        from (select public._r351_row(g, v_uid) j, g.created_at from public.suggestions g
                               where g.user_id = v_uid order by g.created_at desc limit 100) z), '[]'::jsonb),
    'studio', case when v_org is null then '[]'::jsonb else coalesce((
        select jsonb_agg(z.j order by (z.j ->> 'votes')::int desc, z.created_at desc)
          from (select public._r351_row(g, v_uid) j, g.created_at
                  from public.suggestions g
                 where g.studio_id = v_org and g.share_with_studio and g.user_id is distinct from v_uid
                 order by g.created_at desc limit 100) z), '[]'::jsonb) end,
    'unread', (select count(*) from public.suggestions s where s.user_id = v_uid and s.reply is not null
                 and (s.reply_seen_at is null or s.reply_seen_at < s.replied_at)),
    'can_share', v_org is not null);
end $$;

create or replace function public.my_suggestion_unread()
returns integer language sql stable security definer set search_path = '' as $$
  -- r154e-0351
  select case when auth.uid() is null then 0 else (select count(*)::int from public.suggestions s
     where s.user_id = auth.uid() and s.reply is not null and (s.reply_seen_at is null or s.reply_seen_at < s.replied_at)) end
$$;

create or replace function public.suggestion_replies_seen()
returns integer language plpgsql volatile security definer set search_path = '' as $$
-- r154e-0351: the sender opened My suggestions - their replies count as read
declare v_uid uuid := auth.uid(); n integer;
begin
  if v_uid is null then raise exception 'not signed in' using errcode = '42501'; end if;
  update public.suggestions s set reply_seen_at = now()
   where s.user_id = v_uid and s.reply is not null and (s.reply_seen_at is null or s.reply_seen_at < s.replied_at);
  get diagnostics n = row_count;
  return n;
end $$;

create or replace function public.suggestion_vote(p_id uuid, p_on boolean default true)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
-- r154e-0351: +1 (or take it back) on a suggestion someone ELSE of my studio shared
declare v_uid uuid := auth.uid(); v_org uuid; g public.suggestions;
begin
  if v_uid is null then raise exception 'not signed in' using errcode = '42501'; end if;
  v_org := public._r351_org();
  select * into g from public.suggestions s where s.id = p_id;
  if g.id is null or v_org is null or g.studio_id is distinct from v_org or not g.share_with_studio then
    raise exception 'suggestion not found' using errcode = '22023'; end if;
  if g.user_id = v_uid then raise exception 'You cannot +1 your own suggestion.' using errcode = '22023'; end if;
  if public.rate_hit('sugg.vote', v_uid::text, 3600, 120) > 0 then
    raise exception 'Too many changes in one hour. Please try again later.' using errcode = 'P0001', hint = 'rate_limited'; end if;
  insert into public.suggestion_votes as v (suggestion_id, user_id, studio_id, active)
    values (g.id, v_uid, v_org, coalesce(p_on, true))
  on conflict (suggestion_id, user_id) do update set active = excluded.active, updated_at = now();
  return public._r351_row(g, v_uid);
end $$;

create or replace function public.suggestion_share(p_id uuid, p_on boolean)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
-- r154e-0351: the sender shows / hides their own suggestion for people of their studio
declare v_uid uuid := auth.uid(); g public.suggestions;
begin
  if v_uid is null then raise exception 'not signed in' using errcode = '42501'; end if;
  update public.suggestions s set share_with_studio = coalesce(p_on, false) and s.studio_id is not null
   where s.id = p_id and s.user_id = v_uid
  returning * into g;
  if g.id is null then raise exception 'suggestion not found' using errcode = '22023'; end if;
  return public._r351_row(g, v_uid);
end $$;

-- ---- 5) Helm HQ ----------------------------------------------------------------------------------------------------
create or replace function public.hq_suggestions(p_status text default null)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
-- r154e-0351 + r57-0298 masking: the 0271 list + reply, shared, +1 count, read by the sender
declare v jsonb;
begin
  perform public._hq_gate('hq_suggestions', p_status);
  v := jsonb_build_object(
    'counts', (select coalesce(jsonb_object_agg(x.status, x.n), '{}'::jsonb)
                 from (select g.status, count(*) n from public.suggestions g group by g.status) x),
    'rows', coalesce((select jsonb_agg(z.j order by z.created_at desc) from (
       select g.created_at, jsonb_build_object('id', g.id, 'message', g.message, 'category', g.category, 'source', g.source,
         'email', g.email, 'page', g.page, 'studio', o.name, 'studio_id', g.studio_id,
         'who', (select coalesce(nullif(btrim(pr.full_name), ''), pr.email) from public.profiles pr where pr.id = g.user_id),
         'status', g.status, 'hq_note', g.hq_note, 'handled_at', g.handled_at, 'created_at', g.created_at,
         'reply', g.reply, 'replied_at', g.replied_at, 'reply_seen_at', g.reply_seen_at, 'shared', g.share_with_studio,
         'in_app', g.user_id is not null,
         'votes', (select count(*) from public.suggestion_votes sv where sv.suggestion_id = g.id and sv.active)) j
         from public.suggestions g left join public.organizations o on o.id = g.studio_id
        where p_status is null or g.status = p_status
        order by g.created_at desc limit 300) z), '[]'::jsonb));
  return public._r57_mask_rows(v, array['email'], '{}'::text[]);
end $$;

create or replace function public.hq_set_suggestion(p_id uuid, p_status text default null, p_note text default null)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
-- r154e-0351: the 0271 status + note, with Planned and Not now
declare n int;
begin
  perform public._hq_wgate('hq.suggestion.update', 'suggestions', p_id::text, jsonb_build_object('status', p_status, 'note', left(p_note, 1000)));
  if p_status is not null and p_status not in ('new', 'reviewed', 'planned', 'done', 'not_now') then
    raise exception 'status must be new, planned, done or not_now' using errcode = '22023'; end if;
  if p_status is null and p_note is null then raise exception 'nothing to change' using errcode = '22023'; end if;
  update public.suggestions set status = coalesce(p_status, status),
         hq_note = case when p_note is null then hq_note
                        else nullif(left(btrim(regexp_replace(replace(p_note, E'\r', ''), '[\x01-\x09\x0b-\x1f\x7f]', ' ', 'g')), 1000), '') end,
         handled_by = auth.uid(), handled_at = now()
   where id = p_id;
  get diagnostics n = row_count;
  if n = 0 then raise exception 'suggestion not found' using errcode = '22023'; end if;
  return (select jsonb_build_object('id', g.id, 'status', g.status, 'hq_note', g.hq_note, 'handled_at', g.handled_at)
            from public.suggestions g where g.id = p_id);
end $$;

-- the reply the sender reads in My suggestions (empty = remove it), optional status in the same step
create or replace function public.hq_reply_suggestion(p_id uuid, p_reply text, p_status text default null)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
-- r154e-0351
declare v_reply text; n int;
begin
  perform public._hq_wgate('hq.suggestion.update', 'suggestions', p_id::text,
    jsonb_build_object('reply', left(p_reply, 1000), 'status', p_status));
  if p_status is not null and p_status not in ('new', 'reviewed', 'planned', 'done', 'not_now') then
    raise exception 'status must be new, planned, done or not_now' using errcode = '22023'; end if;
  if p_reply is null then raise exception 'nothing to change' using errcode = '22023'; end if;
  v_reply := nullif(left(btrim(regexp_replace(replace(p_reply, E'\r', ''), '[\x01-\x09\x0b-\x1f\x7f]', ' ', 'g')), 1000), '');
  update public.suggestions set reply = v_reply,
         replied_at = case when v_reply is null then null else now() end,
         replied_by = case when v_reply is null then null else auth.uid() end,
         status = coalesce(p_status, status),
         handled_by = auth.uid(), handled_at = now()
   where id = p_id;
  get diagnostics n = row_count;
  if n = 0 then raise exception 'suggestion not found' using errcode = '22023'; end if;
  return (select jsonb_build_object('id', g.id, 'status', g.status, 'reply', g.reply, 'replied_at', g.replied_at, 'in_app', g.user_id is not null)
            from public.suggestions g where g.id = p_id);
end $$;

-- ---- 6) grants -----------------------------------------------------------------------------------------------------
do $$
declare r record; v_anon boolean := exists (select 1 from pg_roles where rolname = 'anon');
        v_auth boolean := exists (select 1 from pg_roles where rolname = 'authenticated');
begin
  for r in select * from (values
      ('public.suggestion_submit(jsonb)', true), ('public.my_suggestions()', true), ('public.my_suggestion_unread()', true),
      ('public.suggestion_replies_seen()', true), ('public.suggestion_vote(uuid,boolean)', true),
      ('public.suggestion_share(uuid,boolean)', true),
      ('public.hq_suggestions(text)', true), ('public.hq_set_suggestion(uuid,text,text)', true),
      ('public.hq_reply_suggestion(uuid,text,text)', true),
      ('public._r351_row(public.suggestions,uuid)', false), ('public._r351_org()', false),
      ('public._r351_tg_suggestion_guard()', false)) t(fn, to_auth) loop
    execute format('revoke all on function %s from public', r.fn);
    if v_anon then execute format('revoke all on function %s from anon', r.fn); end if;
    if v_auth then
      if r.to_auth then execute format('grant execute on function %s to authenticated', r.fn);
      else execute format('revoke all on function %s from authenticated', r.fn); end if;
    end if;
  end loop;
end $$;

notify pgrst, 'reload schema';
commit;

-- VERIFY every line should say true
select item, ok from (values
  ('01 new suggestion columns', (select count(*) from pg_attribute where attrelid = 'public.suggestions'::regclass and not attisdropped
     and attname in ('reply', 'replied_at', 'replied_by', 'reply_seen_at', 'share_with_studio')) = 5),
  ('02 status list has planned and not_now', (select pg_get_constraintdef(c.oid) from pg_constraint c where c.conrelid = 'public.suggestions'::regclass
     and c.conname = 'suggestions_status_check') like '%not_now%'),
  ('03 votes table with RLS on and no app table privilege', (select relrowsecurity from pg_class where oid = 'public.suggestion_votes'::regclass)
     and not has_table_privilege('authenticated', 'public.suggestion_votes', 'select') and not has_table_privilege('anon', 'public.suggestion_votes', 'select')),
  ('04 insert guard trigger on', (select count(*) from pg_trigger where tgrelid = 'public.suggestions'::regclass and tgname = 'zz_r351_suggestion_guard' and tgenabled = 'O') = 1),
  ('05 app functions signed-in only', has_function_privilege('authenticated', 'public.suggestion_submit(jsonb)', 'execute')
     and has_function_privilege('authenticated', 'public.my_suggestions()', 'execute') and has_function_privilege('authenticated', 'public.suggestion_vote(uuid,boolean)', 'execute')
     and not has_function_privilege('anon', 'public.suggestion_submit(jsonb)', 'execute') and not has_function_privilege('anon', 'public.my_suggestions()', 'execute')),
  ('06 HQ functions re-issued and reply added', position('r154e-0351' in (select prosrc from pg_proc where oid = to_regprocedure('public.hq_suggestions(text)'))) > 0
     and position('r154e-0351' in (select prosrc from pg_proc where oid = to_regprocedure('public.hq_set_suggestion(uuid,text,text)'))) > 0
     and to_regprocedure('public.hq_reply_suggestion(uuid,text,text)') is not null and not has_function_privilege('anon', 'public.hq_reply_suggestion(uuid,text,text)', 'execute')),
  ('07 previous bodies kept, not callable by the app', to_regprocedure('public.hq_suggestions__pre0351(text)') is not null
     and to_regprocedure('public.hq_set_suggestion__pre0351(uuid,text,text)') is not null
     and not has_function_privilege('authenticated', 'public.hq_suggestions__pre0351(text)', 'execute')),
  ('08 public suggest form still open to visitors', has_function_privilege('anon', 'public.submit_suggestion(jsonb)', 'execute'))
) v(item, ok);
