-- APPLY-0414 (R245 fix plan Phase 6, ACC-03 + ACC-04: one READ-ONLY Helm HQ report - unconfirmed logins older than 30
-- days, and possible duplicate people). Run on STAGING first, then production. Safe to run twice. Needs 0277 + 0298.
-- What it does:
--   * hq_account_checks(days): HQ people with People access see (1) logins never confirmed and never signed in, older than
--     30 days, and (2) pairs of logins that look like one person (same phone, or same name + a similar e-mail). E-mails are
--     masked, phone numbers never shown. It NEVER deletes and NEVER merges anything.
-- 4 new read-only functions. Nothing changed or deleted.
-- Paste the whole file into the Supabase SQL editor and press Run. The last result lists checks - every ok must be true.
begin;
set local lock_timeout = '5s';
set local statement_timeout = '5min';

-- 0414_r245_hq_account_checks.sql - CANONICAL forward-only. R245 (fix plan Phase 6 "Account and team safety", owner
-- approved 20 Nov 2026; ACC-03 + ACC-04). REQUIRES 0277 (_hq27_require), 0298 (_r57_mask_email), helm_norm_phone.
--
-- In plain words - ONE read-only HQ report, hq_account_checks(days), for HQ staff who may see People (people.read):
--   1  ACC-03 "Unconfirmed logins": logins that were never confirmed AND never signed in, older than N days (default 30,
--      7 to 365). For each: the e-mail MASKED, when it was made / invited, how old, the studio and role (if any). It NEVER deletes anything. Removing one stays an owner decision with a
--      backed-up, owner-run script (the DELETE-0398 pattern) - the monthly owner checklist line.
--   2  ACC-04 "Possible duplicates": two logins that look like the same person - the SAME PHONE (mobile / WhatsApp on the
--      member profile, or the login's phone), or the SAME NAME plus a SIMILAR E-MAIL (the part before "@" is the same
--      once dots and "+tags" are ignored, or one starts with the other, at least 4 letters). Studio client logins are left
--      out. Read-only: studios are NEVER merged automatically - HQ looks at the pair in the weekly review.
--   E-mails are always masked; no phone number is returned (only "same phone"). Each run writes one HQ "view" log row.
--
-- ZERO DATA LOSS: additive + idempotent. 3 read-only helper functions + 1 HQ function. No table, column or row is changed
-- (apart from the HQ view log row). Safe to run twice. ASCII only.

do $$
begin
  if to_regprocedure('public._hq27_require(text,boolean)') is null then
    raise exception 'STOP 0414: _hq27_require missing - run 0277 first'; end if;
  if to_regprocedure('public._r57_mask_email(text)') is null then
    raise exception 'STOP 0414: _r57_mask_email missing - run 0298 first'; end if;
  if to_regprocedure('public.helm_norm_phone(text)') is null then
    raise exception 'STOP 0414: helm_norm_phone missing'; end if;
end $$;

-- the part of an e-mail before "@" that two addresses of one person share: lower case, "+tag" and dots dropped
create or replace function public._r414_email_key(p_email text)
returns text language sql immutable set search_path = '' as $$
  -- r245-0414
  select nullif(replace(split_part(split_part(lower(btrim(coalesce(p_email, ''))), '@', 1), '+', 1), '.', ''), '')
$$;
-- a name to compare: lower case, single spaces, at least 3 letters
create or replace function public._r414_name_key(p_name text)
returns text language sql immutable set search_path = '' as $$
  -- r245-0414
  select case when char_length(x) >= 3 then x end
    from (select lower(regexp_replace(btrim(coalesce(p_name, '')), '\s+', ' ', 'g')) as x) z
$$;

-- ACC-04 same-phone pairs: two team logins whose mobile / WhatsApp (member profile) or login phone is the same once
-- normalised. Answers ONLY the two user ids - never a number. The HQ report itself only gets these id pairs and never reads the member profile table
-- (the hq-subscriptions "no studio business data in HQ" rule). Server only.
create or replace function public._r414_phone_twins()
returns table(a_id uuid, b_id uuid) language sql stable security definer set search_path = '' as $$
  -- r245-0414
  with people as (
    select p.id from public.profiles p where p.org_id is not null and coalesce(p.role, '') <> 'client'
  ), phones as (
    select distinct z.id, z.ph from (
      select pe.id, public.helm_norm_phone(m.phone) as ph from people pe join public.member_profiles m on m.user_id = pe.id
      union all select pe.id, public.helm_norm_phone(m.whatsapp) from people pe join public.member_profiles m on m.user_id = pe.id
      union all select pe.id, public.helm_norm_phone(u.phone::text) from people pe join auth.users u on u.id = pe.id) z
     where char_length(coalesce(z.ph, '')) >= 8
  )
  select distinct pa.id, pb.id from phones pa join phones pb on pb.ph = pa.ph and pb.id > pa.id
$$;

create or replace function public.hq_account_checks(p_days integer default 30)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
-- r245-0414 ACC-03 + ACC-04: read-only (one HQ view log row); never deletes, never merges
declare v_days integer := least(greatest(coalesce(p_days, 30), 7), 365); v_unconf jsonb; v_n_unconf bigint; v_dup jsonb; v_n_dup bigint;
begin
  perform public._hq27_require('people.read', false);
  insert into public.audit_log(actor, actor_email, action, entity, entity_id, org_id, at)
    select auth.uid(), u.email, 'hq.view', 'hq_account_checks', v_days::text, null, now() from auth.users u where u.id = auth.uid();

  -- 1) unconfirmed logins older than v_days (never confirmed, never signed in)
  with x as (
    select u.id, u.email::text as email, u.created_at, u.invited_at, p.org_id, p.role, o.name as studio,
           exists (select 1 from public.platform_admins pa where pa.user_id = u.id or pa.email = lower(u.email::text)) as hq
      from auth.users u
      left join public.profiles p on p.id = u.id
      left join public.organizations o on o.id = p.org_id
     where u.email_confirmed_at is null and u.last_sign_in_at is null
       and u.created_at < now() - make_interval(days => v_days)
  )
  select count(*), coalesce(jsonb_agg(jsonb_build_object(
           'user_id', x.id, 'email', public._r57_mask_email(x.email), 'created_at', x.created_at, 'invited_at', x.invited_at,
           'days_old', (current_date - x.created_at::date), 'studio', x.studio, 'org_id', x.org_id,
           'role', case when x.hq then 'Helm HQ' when x.org_id is null then 'No studio' else x.role end) order by x.created_at) filter (where x.rn <= 500), '[]'::jsonb)
    into v_n_unconf, v_unconf
    from (select x.*, row_number() over (order by x.created_at, x.id) as rn from x) x;

  -- 2) possible duplicates (same phone, or same name + a similar e-mail); studio client logins left out
  with people as (
    select p.id, p.org_id, o.name as studio, u.email::text as email, public._r414_name_key(p.full_name) as nk,
           public._r414_email_key(u.email::text) as ek, p.full_name
      from public.profiles p
      join auth.users u on u.id = p.id
      left join public.organizations o on o.id = p.org_id
     where p.org_id is not null and coalesce(p.role, '') <> 'client'
  ), pairs as (
    select t.a_id, t.b_id, 'same_phone'::text as why
      from public._r414_phone_twins() t join people a on a.id = t.a_id join people b on b.id = t.b_id
    union
    select a.id, b.id, 'same_name_similar_email'
      from people a join people b on b.nk = a.nk and b.id > a.id
     where a.nk is not null and a.ek is not null and b.ek is not null
       and (a.ek = b.ek or (char_length(a.ek) >= 4 and char_length(b.ek) >= 4 and (a.ek like b.ek || '%' or b.ek like a.ek || '%')))
  ), grouped as (
    select pr.a_id, pr.b_id, array_agg(distinct pr.why order by pr.why) as whys from pairs pr group by pr.a_id, pr.b_id
  )
  select count(*), coalesce(jsonb_agg(jsonb_build_object(
           'reasons', to_jsonb(g.whys), 'same_studio', a.org_id = b.org_id,
           'a', jsonb_build_object('user_id', a.id, 'name', a.full_name, 'email', public._r57_mask_email(a.email), 'studio', a.studio, 'org_id', a.org_id),
           'b', jsonb_build_object('user_id', b.id, 'name', b.full_name, 'email', public._r57_mask_email(b.email), 'studio', b.studio, 'org_id', b.org_id))
           order by a.studio, a.id) filter (where g.rn <= 200), '[]'::jsonb)
    into v_n_dup, v_dup
    from (select g.*, row_number() over (order by g.a_id, g.b_id) as rn from grouped g) g
    join people a on a.id = g.a_id join people b on b.id = g.b_id;

  return jsonb_build_object('days', v_days, 'read_only', true,
    'unconfirmed', jsonb_build_object('count', v_n_unconf, 'rows', v_unconf, 'shown_max', 500),
    'duplicates', jsonb_build_object('count', v_n_dup, 'rows', v_dup, 'shown_max', 200));
end $$;

revoke all on function public._r414_email_key(text) from public;
revoke all on function public._r414_name_key(text) from public;
revoke all on function public._r414_phone_twins() from public;
revoke all on function public.hq_account_checks(integer) from public;
do $$ declare r text; begin
  foreach r in array array['anon', 'authenticated'] loop
    if exists (select 1 from pg_roles where rolname = r) then
      execute format('revoke all on function public._r414_email_key(text) from %I', r);
      execute format('revoke all on function public._r414_name_key(text) from %I', r);
      execute format('revoke all on function public._r414_phone_twins() from %I', r);
      execute format('revoke all on function public.hq_account_checks(integer) from %I', r);
    end if;
  end loop;
  -- signed-in only: the HQ role check is inside (people.read)
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    execute 'grant execute on function public.hq_account_checks(integer) to authenticated';
  end if;
end $$;

do $$ begin
  if to_regclass('public.helm_schema_markers') is not null then
    insert into public.helm_schema_markers(num, name) values (414, '0414_r245_hq_account_checks') on conflict (num) do nothing;
  end if;
end $$;

-- ---- checks (every ok must be true) --------------------------------------------------------------------------------------
select item, ok, note from (
  select '01 hq_account_checks: signed-in only (HQ People access checked inside), definer, empty search_path' as item,
     has_function_privilege('authenticated', 'public.hq_account_checks(integer)', 'execute')
     and not has_function_privilege('anon', 'public.hq_account_checks(integer)', 'execute')
     and (select p.prosecdef and p.proconfig @> array['search_path=""'] from pg_proc p where p.oid = 'public.hq_account_checks(integer)'::regprocedure) as ok,
     '' as note
  union all
  select '02 read-only: no delete / update / merge in the report',
     (select position('delete ' in lower(p.prosrc)) = 0 and position('update ' in lower(p.prosrc)) = 0
        from pg_proc p where p.oid = 'public.hq_account_checks(integer)'::regprocedure), ''
  union all
  select '03 e-mail key: dots and +tags ignored',
     public._r414_email_key('Ravi.Kumar+work@gmail.com') = 'ravikumar' and public._r414_email_key(null) is null
     and public._r414_name_key('  Ravi   Kumar ') = 'ravi kumar' and public._r414_name_key('ab') is null, ''
  union all
  select '04 helpers: no app privilege',
     not has_function_privilege('authenticated', 'public._r414_email_key(text)', 'execute')
     and not has_function_privilege('authenticated', 'public._r414_name_key(text)', 'execute')
     and not has_function_privilege('authenticated', 'public._r414_phone_twins()', 'execute'), ''
) v order by item;
commit;
