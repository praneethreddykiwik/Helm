-- 0379_r202_signin_help.sql - R202 (owner 18 Nov 2026, Settings -> Users & invites). Forward-only, additive,
-- safe to run twice. ASCII only.
-- REQUIRES 0028 (auth_temp_passwords), 0155 (a155_admin_created), 0283 (team_member_status, _r283_is_off, _r283_audit),
--          0378 (team_account_status).
--
-- In plain words:
--   People made with "Add user" (a login at once + a one-time temporary password shown ONCE to the admin) showed
--   "Added - never signed in" and the owner had no way to get them in once that password was lost. This file adds:
--     team_signin_link_request(person)  -> the admin asks Helm to e-mail that person a secure "set your password" link.
--         The page then sends it with the same Supabase password-reset e-mail as "Forgot password?" on the sign-in
--         page (the person picks their own password; nobody else ever sees it). Once per 10 minutes per person.
--         Admins and roles with Users EDIT, own studio only, never a deactivated person ("Reactivate first"), never
--         yourself (use "Forgot password?"). Recorded in the activity log.
--     team_signin_link_failed(id)       -> the page could not send that e-mail: the 10-minute wait is lifted again.
--     team_temp_password_reset(person)  -> "New temporary password": a new one-time temporary password, shown once,
--         exactly like Add user. ADMINS only, own studio, only for a login THIS studio created with Add user that has
--         NEVER signed in (so it never takes over an account somebody already uses), not deactivated, not yourself.
--         They must still choose their own password at first sign-in. Once per 10 minutes per person, 50 a day per
--         studio. Recorded in the activity log (never the password).
--     team_account_status() re-issued with two more facts per member: signin_link_at (the last sign-in link sent)
--         and can_new_temp (New temporary password is allowed for them). Everything it returned before is unchanged.
--   One new private table, team_signin_help (who asked, for whom, when; no password, no link, no token). It is studio
--   data: the free-trial purge (0184) empties it with the rest of a purged trial studio (_tr184_purge_tables).
--
-- Changes: one new table (RLS on, no client access), three new functions, one function re-issued (same answer plus two
-- keys). No existing row is changed or deleted except the target login's password hash when an admin asks for a new
-- temporary password (the same thing Add user does). Nothing is ever deleted.
-- Undo: drop function public.team_signin_link_request(uuid); drop function public.team_signin_link_failed(bigint);
--       drop function public.team_temp_password_reset(uuid); drop function public._r379_temp_ok(uuid, uuid);
--       re-run 0378 (the older team_account_status body); the table team_signin_help may stay (it is only a log) and
--       stays in _tr184_purge_tables (harmless).

do $$ begin
  if to_regclass('public.auth_temp_passwords') is null then raise exception '0379: auth_temp_passwords is not installed (apply 0028 first)'; end if;
  if to_regclass('public.a155_admin_created') is null then raise exception '0379: a155_admin_created is not installed (apply 0155 first)'; end if;
  if to_regprocedure('public._r283_is_off(uuid,uuid)') is null or to_regprocedure('public._r283_audit(uuid,text,uuid,jsonb,uuid)') is null then
    raise exception '0379: 0283 (team safety) is not installed'; end if;
  if to_regprocedure('public.team_account_status()') is null then raise exception '0379: team_account_status is not installed (apply 0378 first)'; end if;
end $$;

-- ---- 1) the private log: who asked for a sign-in link / a new temporary password, for whom, when ----------------------
-- studio data: emptied with the rest of a free-trial studio by the 0184 trial purge (added to _tr184_purge_tables below)
create table if not exists public.team_signin_help (
  id         bigserial primary key,
  org_id     uuid not null,
  user_id    uuid not null,
  actor      uuid,
  kind       text not null check (kind in ('link', 'temp')),
  created_at timestamptz not null default now(),
  failed_at  timestamptz                       -- the page could not send the e-mail (does not count for the 10 minutes)
);
create index if not exists team_signin_help_user_idx on public.team_signin_help (org_id, user_id, kind, created_at desc);
alter table public.team_signin_help enable row level security;
revoke all on table public.team_signin_help from public;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    execute 'revoke all on table public.team_signin_help from anon';
    execute 'revoke all on sequence public.team_signin_help_id_seq from anon'; end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    execute 'revoke all on table public.team_signin_help from authenticated';
    execute 'revoke all on sequence public.team_signin_help_id_seq from authenticated'; end if;
end $$;

-- free-trial retention (0184): a purged trial studio's sign-in help log goes with the rest of its data (privacy).
-- Patched in place the way 0198 / 0206 / 0372 add their tables; an unexpected body is left alone (notice).
do $$ declare v_def text; begin
  if to_regprocedure('public._tr184_purge_tables()') is not null then
    v_def := pg_get_functiondef('public._tr184_purge_tables()'::regprocedure);
    if position('''team_signin_help''' in v_def) = 0 then
      if (length(v_def) - length(replace(v_def, '''notifications''', ''))) / length('''notifications''') <> 1 then
        raise notice '0379: _tr184_purge_tables has an unexpected body - left unchanged';
      else execute replace(v_def, '''notifications''', '''notifications'', ''team_signin_help'''); end if;
    end if;
  end if;
end $$;

-- ---- 2) may this studio give that login a new temporary password? -------------------------------------------------------
-- a login THIS studio made with Add user (or one still on an admin-given temporary password), confirmed, NEVER signed in
create or replace function public._r379_temp_ok(p_user uuid, p_org uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  -- r202-0379
  select p_user is not null and p_org is not null
     and exists (select 1 from public.profiles p where p.id = p_user and p.org_id = p_org)
     and not public._r283_is_off(p_user, p_org)
     and exists (select 1 from auth.users u where u.id = p_user and u.last_sign_in_at is null and u.email_confirmed_at is not null)
     and (exists (select 1 from public.a155_admin_created a where a.user_id = p_user and a.org_id = p_org and a.released_at is null)
          or exists (select 1 from public.auth_temp_passwords t join public.profiles p on p.id = t.user_id
                      where t.user_id = p_user and coalesce(p.must_change_password, false)));
$$;
revoke all on function public._r379_temp_ok(uuid, uuid) from public;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'anon') then execute 'revoke all on function public._r379_temp_ok(uuid, uuid) from anon'; end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then execute 'revoke all on function public._r379_temp_ok(uuid, uuid) from authenticated'; end if;
end $$;

-- ---- 3) "Send sign-in link": checks + 10-minute limit + activity log; the page then sends the reset e-mail ------------
create or replace function public.team_signin_link_request(p_user uuid)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
-- r202-0379: admin / Users edit, own studio, not deactivated, not yourself, once per 10 minutes per person
declare v_me uuid := auth.uid(); v_org uuid := public.current_org_id(); v_email text; v_last timestamptz; v_id bigint;
begin
  if v_me is null or v_org is null then raise exception 'not authorized' using errcode = '42501'; end if;
  if not (coalesce(public.is_admin(), false) or coalesce(public.has_area('users', 'edit'), false)) then
    raise exception 'not authorized' using errcode = '42501';
  end if;
  select lower(btrim(coalesce(u.email, p.email, ''))) into v_email
    from public.profiles p left join auth.users u on u.id = p.id
   where p.id = p_user and p.org_id = v_org;
  if not found then raise exception 'no such person in your studio' using errcode = 'P0002'; end if;
  if p_user = v_me then
    raise exception 'This is your own account - use "Forgot password?" on the sign-in page.' using errcode = '22023', hint = 'self';
  end if;
  if public._r283_is_off(p_user, v_org) then
    raise exception 'Reactivate them first, then send a sign-in link.' using errcode = '22023', hint = 'deactivated';
  end if;
  if v_email = '' or position('@' in v_email) = 0 then
    raise exception 'This person has no e-mail address to send a link to.' using errcode = '22023', hint = 'no_email';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('r379:link:' || p_user::text, 0));
  select max(h.created_at) into v_last from public.team_signin_help h
   where h.org_id = v_org and h.user_id = p_user and h.kind = 'link' and h.failed_at is null and h.created_at > now() - interval '10 minutes';
  if v_last is not null then
    return jsonb_build_object('ok', false, 'code', 'rate_limited', 'sent_at', v_last,
      'retry_after_s', greatest(1, ceil(extract(epoch from (v_last + interval '10 minutes' - now())))::int),
      'error', 'A sign-in link was sent to them a few minutes ago. You can send another 10 minutes after the last one.');
  end if;
  insert into public.team_signin_help(org_id, user_id, actor, kind) values (v_org, p_user, v_me, 'link') returning id into v_id;
  perform public._r283_audit(v_org, 'team.signin_link', p_user, jsonb_build_object('help_id', v_id));
  return jsonb_build_object('ok', true, 'id', v_id, 'email', v_email);
end $$;

-- the page could not send it (network / e-mail limit): lift the 10-minute wait again (the caller's own request only)
create or replace function public.team_signin_link_failed(p_id bigint)
returns void language plpgsql volatile security definer set search_path = '' as $$
-- r202-0379
declare v_me uuid := auth.uid(); v_org uuid := public.current_org_id();
begin
  if v_me is null or v_org is null then raise exception 'not authorized' using errcode = '42501'; end if;
  update public.team_signin_help set failed_at = now()
   where id = p_id and org_id = v_org and actor = v_me and kind = 'link' and failed_at is null and created_at > now() - interval '15 minutes';
end $$;

-- ---- 4) "New temporary password" (admins; a never-used Add user login of this studio) --------------------------------
create or replace function public.team_temp_password_reset(p_user uuid)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
-- r202-0379: the same temporary password recipe as admin_create_user_temp (0282), shown once, never stored in clear
declare v_me uuid := auth.uid(); v_org uuid := public.current_org_id(); v_last timestamptz; v_n int; v_temp text;
        v_sym text := '!#%*-_+=?'; v_id bigint;
begin
  if v_me is null or v_org is null or not coalesce(public.is_admin(), false) then raise exception 'not authorized' using errcode = '42501'; end if;
  if not exists (select 1 from public.profiles p where p.id = p_user and p.org_id = v_org) then
    raise exception 'no such person in your studio' using errcode = 'P0002';
  end if;
  if p_user = v_me then raise exception 'This is your own account.' using errcode = '22023', hint = 'self'; end if;
  if public._r283_is_off(p_user, v_org) then
    raise exception 'Reactivate them first, then send a sign-in link.' using errcode = '22023', hint = 'deactivated';
  end if;
  if not public._r379_temp_ok(p_user, v_org) then
    raise exception 'A new temporary password is only for someone you added with "Add user" who has never signed in. Send them a sign-in link instead.'
      using errcode = '22023', hint = 'not_eligible';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('r379:temp:' || v_org::text, 0));
  select max(h.created_at) into v_last from public.team_signin_help h
   where h.org_id = v_org and h.user_id = p_user and h.kind = 'temp' and h.created_at > now() - interval '10 minutes';
  if v_last is not null then
    return jsonb_build_object('ok', false, 'code', 'rate_limited',
      'retry_after_s', greatest(1, ceil(extract(epoch from (v_last + interval '10 minutes' - now())))::int),
      'error', 'A new temporary password was made for them a few minutes ago. You can make another 10 minutes after the last one.');
  end if;
  select count(*) into v_n from public.team_signin_help h where h.org_id = v_org and h.kind = 'temp' and h.created_at > now() - interval '24 hours';
  if v_n >= 50 then
    raise exception 'too many new temporary passwords today - send sign-in links instead' using errcode = '54000';
  end if;
  v_temp := 'Hm' || translate(encode(extensions.gen_random_bytes(12), 'base64'), '+/=', 'xy9')
         || (get_byte(extensions.gen_random_bytes(1), 0) % 10)::text
         || substr(v_sym, 1 + get_byte(extensions.gen_random_bytes(1), 0) % length(v_sym), 1);
  update auth.users set encrypted_password = extensions.crypt(v_temp, extensions.gen_salt('bf', 12)), updated_at = now() where id = p_user;
  update public.profiles set must_change_password = true where id = p_user;
  insert into public.auth_temp_passwords (user_id, pw_hash)
    select u.id, u.encrypted_password from auth.users u where u.id = p_user
  on conflict (user_id) do update set pw_hash = excluded.pw_hash, created_at = now();
  update public.a155_admin_created a set pw_hash = u.encrypted_password from auth.users u
   where a.user_id = p_user and u.id = p_user and a.org_id = v_org and a.released_at is null;
  insert into public.team_signin_help(org_id, user_id, actor, kind) values (v_org, p_user, v_me, 'temp') returning id into v_id;
  perform public._r283_audit(v_org, 'team.temp_password_reset', p_user, jsonb_build_object('help_id', v_id));
  return jsonb_build_object('ok', true, 'user_id', p_user, 'temp_password', v_temp);
end $$;

-- grants: signed-in callers only (each function checks the studio + the role inside); never anon
do $$ declare f text; begin
  foreach f in array array['public.team_signin_link_request(uuid)', 'public.team_signin_link_failed(bigint)', 'public.team_temp_password_reset(uuid)'] loop
    execute 'revoke all on function ' || f || ' from public';
    if exists (select 1 from pg_roles where rolname = 'anon') then execute 'revoke all on function ' || f || ' from anon'; end if;
    if exists (select 1 from pg_roles where rolname = 'authenticated') then execute 'grant execute on function ' || f || ' to authenticated'; end if;
  end loop;
end $$;

-- ---- 5) team_account_status: the 0378 answer + signin_link_at + can_new_temp ------------------------------------------
create or replace function public.team_account_status()
returns jsonb language plpgsql stable security definer set search_path = '' as $$
-- r199-0378: account status of my studio's people + open invitations (admin / Users edit only)
-- r202-0379: + signin_link_at (last sign-in link sent) and can_new_temp (New temporary password allowed) per member
declare v_me uuid := auth.uid(); v_org uuid := public.current_org_id(); v_members jsonb; v_invites jsonb;
begin
  if v_me is null or v_org is null then raise exception 'not authorized' using errcode = '42501'; end if;
  if not (coalesce(public.is_admin(), false) or coalesce(public.has_area('users', 'edit'), false)) then
    raise exception 'not authorized' using errcode = '42501';
  end if;

  select coalesce(jsonb_agg(jsonb_build_object(
           'user_id', p.id,
           'account_created_at', u.created_at,
           'last_sign_in_at', u.last_sign_in_at,
           'email_confirmed', u.email_confirmed_at is not null,
           'needs_password', u.id is not null and coalesce(u.encrypted_password, '') = ''
                             and not exists (select 1 from auth.identities d where d.user_id = u.id and coalesce(d.provider, '') <> 'email'),
           'temp_password', coalesce(p.must_change_password, false),
           'deactivated', coalesce(s.status = 'deactivated', false),
           'deactivated_at', case when s.status = 'deactivated' then s.deactivated_at end,
           'joined_at', coalesce(inv.accepted_at, p.created_at),
           'invited_at', inv.created_at,
           'invited_by_name', inv.by_name,
           'signin_link_at', (select max(h.created_at) from public.team_signin_help h
                               where h.org_id = v_org and h.user_id = p.id and h.kind = 'link' and h.failed_at is null),
           'can_new_temp', coalesce(public.is_admin(), false) and p.id <> v_me and public._r379_temp_ok(p.id, v_org))
         order by p.id), '[]'::jsonb)
    into v_members
    from public.profiles p
    left join auth.users u on u.id = p.id
    left join public.team_member_status s on s.user_id = p.id and s.org_id = v_org
    left join lateral (
      select i.created_at, i.accepted_at,
             (select nullif(btrim(coalesce(b.full_name, '')), '') from public.profiles b where b.id = i.invited_by and b.org_id = v_org) as by_name
        from public.invitations i
       where i.org_id = v_org and i.status = 'accepted'
         and (i.accepted_by = p.id or (i.accepted_by is null and lower(btrim(i.email)) = lower(btrim(coalesce(p.email, '')))))
       order by i.accepted_at desc nulls last, i.created_at desc
       limit 1) inv on true
   where p.org_id = v_org;

  select coalesce(jsonb_agg(x.j order by x.created_at desc), '[]'::jsonb)
    into v_invites
    from (
      select distinct on (lower(btrim(i.email)))
             i.created_at,
             jsonb_build_object(
               'id', i.id,
               'email', lower(btrim(i.email)),
               'role', i.role,
               'created_at', i.created_at,
               'expires_at', i.expires_at,
               'expired', i.expires_at is not null and i.expires_at <= now(),
               'invited_by_name', (select nullif(btrim(coalesce(b.full_name, '')), '') from public.profiles b where b.id = i.invited_by and b.org_id = v_org),
               'emailed_at', (select max(o.sent_at) from public.invite_email_outbox o where o.invitation_id = i.id),
               'email_status', (select o.status from public.invite_email_outbox o where o.invitation_id = i.id
                                 order by o.queued_at desc, o.created_at desc limit 1)) as j
        from public.invitations i
       where i.org_id = v_org and i.status = 'pending'
         and not exists (select 1 from public.profiles m where m.org_id = v_org and lower(btrim(coalesce(m.email, ''))) = lower(btrim(i.email)))
       order by lower(btrim(i.email)), i.created_at desc
       limit 500) x;

  return jsonb_build_object('tz', public.studio_timezone(v_org), 'now', now(), 'members', v_members, 'invites', v_invites);
end $$;

do $$ begin
  execute 'revoke all on function public.team_account_status() from public';
  if exists (select 1 from pg_roles where rolname = 'anon') then execute 'revoke all on function public.team_account_status() from anon'; end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then execute 'grant execute on function public.team_account_status() to authenticated'; end if;
end $$;
