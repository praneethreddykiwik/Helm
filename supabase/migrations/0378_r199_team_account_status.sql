-- 0378_r199_team_account_status.sql - R199 (owner 17 Nov 2026: "Users & invites is confusing"). Forward-only, additive,
-- safe to run twice. ASCII only.
-- REQUIRES phase83 (public.invitations), 0041 (profiles in a studio, is_admin / has_area), 0131 (invite_email_outbox),
--          0283 (team_member_status), 0287 (studio_timezone).
--
-- In plain words:
--   Settings -> Users & invites showed "Complete" / "Incomplete" for each person. The owner read "Complete" as
--   "has signed up" - it only meant "the profile has a name and a mobile number". The page now shows a real
--   ACCOUNT STATUS for each person: "Invited - not signed up yet" (sent on ..., the link expires on ... or Expired),
--   "Signed up - never signed in", "Last signed in 3 days ago" or "Deactivated", with the profile completeness as a
--   small separate hint. The browser cannot see sign-in times (they live in the private auth schema), so this file
--   adds ONE read-only call for it:
--     team_account_status() -> { tz, now, members: [...], invites: [...] } for the CALLER'S OWN STUDIO only.
--       members[]: user_id, account_created_at, last_sign_in_at, email_confirmed (yes / no), needs_password (a login
--                  made by an invitation e-mail that still has no password and no Google sign-in), temp_password
--                  (an admin-given temporary password not changed yet), deactivated + deactivated_at, joined_at,
--                  invited_at, invited_by_name (the display name of the teammate who sent the invite).
--       invites[]: the newest open (pending) invitation per e-mail - id, email, role, created_at (sent), expires_at,
--                  expired (yes / no), invited_by_name, emailed_at (when the invitation e-mail last went out) and
--                  email_status (pending / sent / skipped / failed) from the invite e-mail queue.
--     Nothing else about a login is returned: no password, no token, no other studio's people, no IP, no device.
--   WHO MAY CALL IT: a signed-in studio admin, or a role with Users EDIT in the access matrix (the people who can
--   invite and manage teammates). Anyone else (crew, sales without Users edit, clients, signed-out callers) is refused
--   with 42501 "not authorized". The answer only ever lists people whose profile is in the caller's studio and
--   invitations of the caller's studio.
--
-- Changes: one new function. No table, column, policy, grant on a table or row is created, changed or deleted.
-- Nothing is ever deleted: "Cancel invite" in the app marks the invitation revoked (the existing invitations update),
-- deactivating a person keeps everything (0283).
-- Undo: drop function public.team_account_status();

do $$ begin
  if to_regclass('public.invitations') is null then raise exception '0378: public.invitations is not installed (apply phase83 first)'; end if;
  if to_regclass('public.invite_email_outbox') is null then raise exception '0378: invite_email_outbox is not installed (apply 0131 first)'; end if;
  if to_regclass('public.team_member_status') is null then raise exception '0378: team_member_status is not installed (apply 0283 first)'; end if;
  if to_regprocedure('public.studio_timezone(uuid)') is null then raise exception '0378: studio_timezone is not installed (apply 0287 first)'; end if;
  if to_regprocedure('public.has_area(text,text)') is null or to_regprocedure('public.is_admin()') is null then
    raise exception '0378: is_admin / has_area are not installed'; end if;
end $$;

create or replace function public.team_account_status()
returns jsonb language plpgsql stable security definer set search_path = '' as $$
-- r199-0378: account status of my studio's people + open invitations (admin / Users edit only)
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
           'invited_by_name', inv.by_name)
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

-- grants: signed-in callers only (the function checks the studio + admin / Users edit inside); never anon
do $$ begin
  execute 'revoke all on function public.team_account_status() from public';
  if exists (select 1 from pg_roles where rolname = 'anon') then execute 'revoke all on function public.team_account_status() from anon'; end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then execute 'grant execute on function public.team_account_status() to authenticated'; end if;
end $$;
