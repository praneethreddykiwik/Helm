-- 0386_r210_role_sync.sql - R210 (owner 18 Nov 2026, Settings -> Users & invites: "Even if I change this to Event
-- manager, the person is getting Admin" + "the same e-mail in both studios - check it out"). Forward-only, additive,
-- safe to run twice. ASCII only.
-- REQUIRES 0106 (_a106_role_label), 0283 (team safety), 0156 (an old invitation never rewrites a member's role).
--
-- In plain words:
--   A person's Helm role is decided by ONE value: profiles.role (user_role / is_admin / has_area all read it). Three
--   other places keep a COPY of the role as words, and none of them followed a role change made in Settings -> Users:
--     1. an open invitation for the same e-mail in the same studio (e.g. sent earlier as "Admin"). The table hides it
--        because the person is already a member, but the invitation e-mail / join page still said "invited you as
--        Admin" and it kept counting as an open invitation;
--     2. the staff record linked to that login (crew_members.role), when it shows the role name (no job title);
--     3. the role name an invitation e-mail wrote into the login's own details (auth user_metadata "role").
--   From now on, the moment profiles.role changes (Settings -> Users, Staff -> login role, a 24-hour admin change, any
--   path), the same database transaction also:
--     1. closes every open invitation of that studio for that person's e-mail (marked accepted by them - exactly what
--        0156 already does when they open it; they are a member, so it can never be used again),
--     2. renames the linked staff record's role to the new role name, ONLY when it still shows the OLD role's name
--        (a job title or any other words are never touched),
--     3. updates the "role" words in the login's details, ONLY when that key is there.
--   One login = one studio (profiles has one org_id per login). The only way a login leaves a studio is accepting
--   another studio's invitation for an account that studio had created (0155). Its staff record in the OLD studio
--   stayed linked to a login that now belongs to another studio. From now on such a move unlinks it (the staff record,
--   its name, phone, history and pay stay exactly as they are; it is just no longer tied to that login).
--
-- Changes: two new trigger functions + two triggers on public.profiles. No function re-issued, no row deleted, no row
-- changed except the copies above (invitation status pending -> accepted, a staff record's role words, one key in the
-- login details, a staff record's link) - each change is written to the activity log.
-- Undo: drop trigger if exists zzzzz_r386_role_sync on public.profiles;
--       drop trigger if exists zzzzz_r386_left_studio on public.profiles;
--       drop function if exists public._r386_tg_role_sync(); drop function if exists public._r386_tg_left_studio();

do $$ begin
  if to_regprocedure('public._a106_role_label(text)') is null then raise exception '0386: _a106_role_label is not installed (apply 0106 first)'; end if;
  if to_regclass('public.team_admin_changes') is null then raise exception '0386: 0283 (team safety) is not installed'; end if;
  if to_regclass('public.invitations') is null or to_regclass('public.crew_members') is null or to_regclass('public.audit_log') is null then
    raise exception '0386: invitations / crew_members / audit_log missing'; end if;
end $$;

-- ---- 1) a role change reaches every copy of the role, in the same transaction ----------------------------------
create or replace function public._r386_tg_role_sync()
returns trigger language plpgsql security definer set search_path = '' as $$
-- r210-0386: profiles.role changed in the same studio -> open invitations for that e-mail closed, the linked staff
-- record's role words + the login's "role" words follow (only when they still show the old role)
declare v_email text; v_old_words text[]; v_new text := public._a106_role_label(new.role); v_n integer; v_ids jsonb;
begin
  if new.org_id is null or new.org_id is distinct from old.org_id or new.role is not distinct from old.role then return null; end if;
  select lower(btrim(u.email)) into v_email from auth.users u where u.id = new.id;
  v_email := coalesce(nullif(v_email, ''), nullif(lower(btrim(coalesce(new.email, ''))), ''));
  -- 1. open invitations of this studio for this member's e-mail (or their profile e-mail) - never used again
  if v_email is not null then
    with c as (
      update public.invitations i set status = 'accepted', accepted_at = now(), accepted_by = new.id
       where i.org_id = new.org_id and i.status = 'pending'
         and lower(btrim(i.email)) in (v_email, lower(btrim(coalesce(new.email, ''))))
      returning i.id, i.role)
    select count(*), coalesce(jsonb_agg(jsonb_build_object('invitation', c.id, 'role', c.role)), '[]'::jsonb) into v_n, v_ids from c;
    if v_n > 0 then
      insert into public.audit_log(actor, action, entity, entity_id, changed, org_id, at)
        values (auth.uid(), 'team.invite.superseded', 'profiles', new.id::text,
                jsonb_build_object('reason', 'role changed to ' || coalesce(new.role, ''), 'invitations', v_ids), new.org_id, now());
    end if;
  end if;
  -- 2. the linked staff record, only while it shows the OLD role's name (never a job title / own words)
  if coalesce(new.role, '') <> 'client' then
    v_old_words := array[lower(public._a106_role_label(old.role)), lower(initcap(replace(coalesce(old.role, ''), '_', ' ')))];
    update public.crew_members c set role = v_new
     where c.profile_id = new.id and c.org_id = new.org_id
       and lower(btrim(coalesce(c.role, ''))) = any (v_old_words)
       and c.role is distinct from v_new;
  end if;
  -- 3. the role words an invitation e-mail put in the login's own details (display only), when that key is there
  update auth.users u set raw_user_meta_data = jsonb_set(u.raw_user_meta_data, '{role}', to_jsonb(v_new))
   where u.id = new.id and jsonb_typeof(u.raw_user_meta_data) = 'object' and u.raw_user_meta_data ? 'role'
     and (u.raw_user_meta_data ->> 'role') is distinct from v_new;
  return null;
end $$;
revoke all on function public._r386_tg_role_sync() from public;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'anon') then execute 'revoke all on function public._r386_tg_role_sync() from anon'; end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then execute 'revoke all on function public._r386_tg_role_sync() from authenticated'; end if;
end $$;

drop trigger if exists zzzzz_r386_role_sync on public.profiles;
create trigger zzzzz_r386_role_sync after update of role on public.profiles
  for each row when (old.role is distinct from new.role and old.org_id is not distinct from new.org_id and new.org_id is not null)
  execute function public._r386_tg_role_sync();

-- ---- 2) a login that moved to another studio is no longer tied to the OLD studio's staff record ---------------
create or replace function public._r386_tg_left_studio()
returns trigger language plpgsql security definer set search_path = '' as $$
-- r210-0386: profiles.org_id changed from one studio to another (0155 move) -> the old studio's staff record keeps
-- everything but its link to this login. Best effort: it never stops the move (every read of a link is studio-scoped).
declare v_n integer;
begin
  if old.org_id is null or new.org_id is not distinct from old.org_id then return null; end if;
  begin
    with c as (
      update public.crew_members c set profile_id = null
       where c.profile_id = new.id and c.org_id = old.org_id
      returning c.id)
    select count(*) into v_n from c;
    if v_n > 0 then
      insert into public.audit_log(actor, action, entity, entity_id, changed, org_id, at)
        values (auth.uid(), 'staff.login_unlinked', 'profiles', new.id::text,
                jsonb_build_object('reason', 'the login moved to another studio', 'staff_records', v_n), old.org_id, now());
    end if;
  exception when others then
    raise warning 'r210-0386: staff record of a moved login left linked (%)', sqlstate;
  end;
  return null;
end $$;
revoke all on function public._r386_tg_left_studio() from public;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'anon') then execute 'revoke all on function public._r386_tg_left_studio() from anon'; end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then execute 'revoke all on function public._r386_tg_left_studio() from authenticated'; end if;
end $$;

drop trigger if exists zzzzz_r386_left_studio on public.profiles;
create trigger zzzzz_r386_left_studio after update of org_id on public.profiles
  for each row when (old.org_id is not null and old.org_id is distinct from new.org_id)
  execute function public._r386_tg_left_studio();
