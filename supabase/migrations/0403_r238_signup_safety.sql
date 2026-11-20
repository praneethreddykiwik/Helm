-- 0403_r238_signup_safety.sql - CANONICAL forward-only. R238 (fix plan Phase 2, owner approved 20 Nov 2026).
-- REQUIRES 0255 (account_terms_acceptances, _account_terms_version), 0248 (invitations e-mail guard pattern).
-- crew_members is optional: a database without it simply gets no staff e-mail guard.
--
-- In plain words:
--   1  "I am 18 or older" at sign-up (LEG-07, DPDP s.9 + Terms s.3). New table account_age_confirmations: one row per
--      person with the time (server clock), the Terms version in force, where it was given (signup / google / studio)
--      and a short browser name. Written by confirm_account_age(source, user_agent) - the person's OWN tick, signed in,
--      no studio needed. The first confirmation is kept; a second call changes nothing. Shown nowhere publicly: no app
--      role can read the table (definer functions only; service_role may read it for a legal request).
--      Existing users are NOT asked and NOT blocked - only new sign-ups tick the box (login.html step 1).
--   2  E-mail addresses with no ending (ACC-02 / SEC-05): "ravi@gmail" (no .com / .in) can no longer be saved as a NEW
--      login, a NEW invitation or a NEW staff e-mail - by any route (sign-up, Google, Add user, invite, Staff page,
--      import). Guard triggers refuse only that one clearly broken shape with a plain message; every other address -
--      a studio's own domain, a new ending like .events, .xn--... - is untouched. A row whose e-mail does not change is
--      never checked (existing rows, sign-ins, status changes all pass), and a bug in the check never stops sign-in.
--   Nothing existing is changed or deleted: 1 new table, 5 new functions, 3 new triggers. No DROP of data, no UPDATE,
--   no DELETE. Additive + idempotent: safe to run twice. ASCII only.
-- ROLLBACK (manual, only if ever needed): drop trigger a403_email_tld_guard on auth.users / public.invitations /
--   public.crew_members. The table can stay (it only holds the 18+ confirmations).
-- ============================================================================

do $$ begin
  if to_regclass('public.account_terms_acceptances') is null or to_regprocedure('public._account_terms_version()') is null then
    raise exception 'STOP: 0255 (Terms at sign-up) is not applied'; end if;
  if to_regclass('public.invitations') is null then raise exception 'STOP: public.invitations is missing'; end if;
  if to_regclass('auth.users') is null then raise exception 'STOP: auth.users is missing'; end if;
end $$;

-- ---- 1) 18+ confirmation ------------------------------------------------------------------------------------
create table if not exists public.account_age_confirmations (
  user_id        uuid        primary key,
  confirmed_at   timestamptz not null default now(),
  policy_version text        check (policy_version is null or policy_version ~ '^[A-Za-z0-9._-]{1,32}$'),
  source         text        not null default 'signup' check (source in ('signup', 'google', 'studio')),
  user_agent     text        check (user_agent is null or char_length(user_agent) <= 160)
);
comment on table public.account_age_confirmations is
  '0403: "I am 18 or older" ticked at sign-up (per person, server time, Terms version in force). Definer functions only; never shown publicly.';
alter table public.account_age_confirmations enable row level security;
revoke all on table public.account_age_confirmations from public;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'anon') then execute 'revoke all on table public.account_age_confirmations from anon'; end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then execute 'revoke all on table public.account_age_confirmations from authenticated'; end if;
  if exists (select 1 from pg_roles where rolname = 'service_role') then execute 'grant select on table public.account_age_confirmations to service_role'; end if;
end $$;

create or replace function public.confirm_account_age(p_source text default 'signup', p_user_agent text default null)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
-- r238-age-0403: the person's own "I am 18 or older"; insert once, a second call changes nothing
declare v_uid uuid := auth.uid(); v_ver text; v_ua text; v_src text; v_at timestamptz;
begin
  if v_uid is null then raise exception 'not signed in' using errcode = '42501'; end if;
  v_ver := public._account_terms_version();
  if v_ver is not null and v_ver !~ '^[A-Za-z0-9._-]{1,32}$' then v_ver := null; end if;
  v_ua := nullif(left(regexp_replace(coalesce(p_user_agent, ''), '[^\x20-\x7e]', '', 'g'), 160), '');
  v_src := case when p_source in ('signup', 'google', 'studio') then p_source else 'signup' end;
  insert into public.account_age_confirmations(user_id, policy_version, source, user_agent)
    values (v_uid, v_ver, v_src, v_ua)
  on conflict (user_id) do nothing;
  select a.confirmed_at into v_at from public.account_age_confirmations a where a.user_id = v_uid;
  return jsonb_build_object('confirmed', true, 'confirmed_at', v_at);
end $$;
revoke all on function public.confirm_account_age(text, text) from public;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'anon') then execute 'revoke all on function public.confirm_account_age(text, text) from anon'; end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then execute 'grant execute on function public.confirm_account_age(text, text) to authenticated'; end if;
end $$;

-- ---- 2) no e-mail without an ending ---------------------------------------------------------------------------
-- true = fine (or not an address at all: other checks decide). false ONLY for "x@gmail", "x@gmail.", "x@b.c", "x@".
create or replace function public._r403_email_has_tld(p_email text)
returns boolean language sql immutable set search_path = '' as $$
  -- r238-email-0403
  select case
    when e = '' or position('@' in e) = 0 then true
    else (select d <> '' and position('.' in d) > 0 and char_length(regexp_replace(d, '^.*\.', '')) >= 2
            from (select rtrim(right(e, position('@' in reverse(e)) - 1), '.') as d) y)
  end
  from (select lower(btrim(coalesce(p_email, ''))) as e) x
$$;

create or replace function public._r403_email_message(p_email text)
returns text language sql immutable set search_path = '' as $$
  -- r238-email-0403
  select 'Please check the e-mail address "' || left(btrim(coalesce(p_email, '')), 120)
         || '" - it is missing its ending, like .com or .in (for example name@gmail.com).'
$$;

-- one guard for the three tables: a NEW row, or an e-mail that CHANGES, must have an ending
create or replace function public.tg_r403_email_tld_guard()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  -- r238-email-0403
  v_bad text := null;
begin
  begin
    if tg_op = 'INSERT' then
      if not public._r403_email_has_tld(new.email) then v_bad := new.email; end if;
    elsif lower(btrim(coalesce(new.email, ''))) is distinct from lower(btrim(coalesce(old.email, '')))
          and not public._r403_email_has_tld(new.email) then
      v_bad := new.email;
    end if;
    if v_bad is null and tg_table_schema = 'auth' and tg_table_name = 'users' then
      if coalesce(new.email_change, '') <> ''
         and (tg_op = 'INSERT' or new.email_change is distinct from old.email_change)
         and not public._r403_email_has_tld(new.email_change) then v_bad := new.email_change; end if;
    end if;
  exception when others then
    v_bad := null;             -- our bug must never stop sign-in, invitations or the Staff page working
  end;
  if v_bad is not null then
    raise exception '%', public._r403_email_message(v_bad) using errcode = '22023', hint = 'email_no_tld';
  end if;
  return new;
end $$;

do $$ declare f text; begin
  foreach f in array array['public._r403_email_has_tld(text)', 'public._r403_email_message(text)', 'public.tg_r403_email_tld_guard()'] loop
    execute format('revoke all on function %s from public', f);
    if exists (select 1 from pg_roles where rolname = 'anon') then execute format('revoke all on function %s from anon', f); end if;
    if exists (select 1 from pg_roles where rolname = 'authenticated') then execute format('revoke all on function %s from authenticated', f); end if;
  end loop;
end $$;

drop trigger if exists a403_email_tld_guard on auth.users;
create trigger a403_email_tld_guard before insert or update of email, email_change on auth.users
  for each row execute function public.tg_r403_email_tld_guard();

drop trigger if exists a403_email_tld_guard on public.invitations;
create trigger a403_email_tld_guard before insert or update of email on public.invitations
  for each row execute function public.tg_r403_email_tld_guard();

do $$ begin
  if to_regclass('public.crew_members') is not null
     and exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'crew_members' and column_name = 'email') then
    execute 'drop trigger if exists a403_email_tld_guard on public.crew_members';
    execute 'create trigger a403_email_tld_guard before insert or update of email on public.crew_members
               for each row execute function public.tg_r403_email_tld_guard()';
  end if;
end $$;
