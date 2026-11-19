-- APPLY-0400 (R232: remove every trace of the roles Event coordinator / Designer - owner decision 19 Nov 2026).
-- Run on STAGING first, then production, ONLY AFTER APPLY-0398 and the owner-run DELETE-0398-RETIRED-ROLE-USERS.sql.
-- Safe to run twice (a second run finds nothing left and changes nothing).
-- What it does, in plain words:
--   * SAFETY GATE: if any login still has Event coordinator / Designer (also a studio owner / Helm HQ account, which
--     DELETE-0398 never deletes), or a 24-hour admin change to one of them is still waiting, it changes NOTHING and
--     check row 01 says what to do first (ok = false). Then: run DELETE-0398 (or reassign that owner / HQ login in
--     Settings -> Users & invites, or cancel the waiting change) and paste this file again.
--   * Otherwise, in every studio, free trial and new studio, the two roles are removed: their access-matrix rows,
--     the invitations sent with them (and those invitations' e-mail queue rows), their per-role notification settings,
--     the two roles inside the sign-in notice / event-ready alert / WhatsApp forward lists and the vendor-bill payer
--     role (becomes Admin), the role words "Event coordinator" / "Designer" on staff records that show EXACTLY that
--     label (other words are kept), the same words in the free-trial sample data, and the name of the first
--     escalation step ("coordinator" becomes "lead" = Event lead: the same people are told at the same times).
--   * Server functions that named the two roles are re-issued without them (old bodies kept as <name>__pre0400);
--     every other role keeps exactly the same access, notices, approvals, escalations and new-studio set-up.
--   * The database then refuses the two roles for good (role checks rebuilt / added).
--   * Before any row is deleted or changed, a copy goes to public._r398_backup (kind r400_...).
--   * Crew is AVAILABLE again (owner change 19 Nov 2026): it can be invited, added and given in a role change again
--     (this part runs even when the safety gate stops the rest - it removes nothing).
-- Never touched: users / logins, quotes, tasks, payments, chat messages, notifications, audit and history rows.
-- Paste the whole file into the Supabase SQL editor and press Run. The last result lists checks - every ok must be true.
-- Rows that start with "list" name each staff record whose role words were removed (ok is always true for them).
begin;
-- 0400_r232_remove_role_traces.sql - R232 (owner decision 19 Nov 2026). CANONICAL forward-only. ASCII only.
-- REQUIRES 0398 (R229: _r398_backup, _r398_removed_roles, _r398_role_label) and, on a real database, the owner-run
-- supabase/DELETE-0398-RETIRED-ROLE-USERS.sql already done (the safety gate below checks it).
--
-- In plain words:
--   The roles Event coordinator (coordinator) and Designer (designer) are removed for good. 0398 stopped anyone new
--   getting them and DELETE-0398 deleted the logins that had them. This migration removes what is LEFT of the two roles,
--   in every studio, free trial and new studio, so the product looks as if they never existed:
--     * the access-matrix rows (role_access) of the two roles;
--     * the invitations that were sent with one of the two roles (0398 already cancelled the open ones) and the
--       invitation e-mail queue rows that belong to them;
--     * per-role notification settings rows (notification_prefs) of the two roles;
--     * the two roles inside studio settings lists: sign-in notice roles, event-ready alert roles, WhatsApp forward
--       roles and the vendor-bill payer role (a payer role of a removed role becomes Admin, the role that already got
--       those reminders because nobody held the removed role any more);
--     * the role WORDS "Event coordinator" / "Designer" on staff records, only when the record shows EXACTLY that
--       label (the words Helm copied from the login role) - any other words a studio typed are kept;
--     * the same words in the free-trial sample data (trial manifest staff), so new trials never get them;
--     * the special-task escalation ladder: its first step was named "coordinator"; it is now named "lead" (shown as
--       Event lead) - the SAME people are told at the SAME times (the event lead, otherwise every Supervisor), the
--       manager and admin steps are unchanged. The escalation record rows are relabelled (copy kept first);
--     * server functions: the default access matrix for new studios, the Designer starter set, role labels, the
--       role whitelist, the closure / restore approvers (admin, manager - as before minus the removed role), the
--       delivery / vendor-request announcements, the bell visibility rule and the messages that named the role
--       (old bodies kept as <name>__pre0400, no app privilege);
--     * finally the database stops accepting the two roles: the profiles / invitations role checks are rebuilt
--       without them and new checks are added (NOT VALID + VALIDATE; skipped and reported if a leftover row exists).
--   SAFETY GATE: if any login still has one of the two roles (also a studio owner / Helm HQ account, which DELETE-0398
--   never deletes - reassign them first), or a 24-hour admin change to one of the two roles is still waiting, NOTHING
--   is changed and the APPLY check row 01 says what to do first (ok = false).
--   Before any row is deleted or changed, a copy goes to public._r398_backup (kind r400_<table>).
--   Never deleted or changed: any user / login, quote, task, payment, chat message, notification, audit / history row
--   (old notices that once said "coordinator" stay as they were written). Crew is NOT removed: owner change 19 Nov 2026 -
--   Crew is AVAILABLE again (0398 had disabled it): the 0398 guard now refuses only the two removed roles, so Crew can be
--   invited, added and given in a role change again (step 1a below; not behind the safety gate - it removes nothing).
--   Kept on purpose: the 0398 guard (_r398_* refuses the two roles if anything ever tries), the word "coordinator" in
--   the cost-category matcher (_r21_category: "event coordinator" fee lines are staff costs) and "Guest coordinator"
--   staff in the sample data (_demo_seed_ae, _demo_seed__pre0166: a job title, not a login role).
--   Test switch: helm.r400_remove = 'off' makes this file change nothing (the local test cluster's older suites only;
--   the app's API calls cannot set it). Safe to run twice: a second run finds nothing left and changes nothing.

-- ---- 0) helpers (always created; they change nothing by themselves) -------------------------------------------------
-- the roles that still exist (one place): the 0398 profiles list without the two removed roles
create or replace function public._r400_roles()
returns text[] language sql immutable set search_path = '' as $$
  -- r232-0400
  select array['admin', 'manager', 'planner', 'sales', 'supervisor', 'quality', 'operations', 'crew', 'worker', 'client']::text[];
$$;

-- who / what still blocks 0400: logins with a removed role, waiting 24-hour admin changes to a removed role
create or replace function public._r400_blockers()
returns table(kind text, org_id uuid, user_id uuid, email text, role text, owner_or_hq boolean)
language sql stable security definer set search_path = '' as $$
  -- r232-0400
  select 'login'::text, p.org_id, p.id, p.email, p.role,
         (exists (select 1 from public.organizations o where o.id = p.org_id and o.created_by = p.id)
          or public._r283_owner(p.org_id) is not distinct from p.id
          or exists (select 1 from public.platform_admins pa where pa.user_id = p.id or lower(pa.email) = lower(p.email)))
    from public.profiles p
   where p.role = any (public._r398_removed_roles())
  union all
  select 'admin_change'::text, c.org_id, c.target_user, null::text, c.new_role, false
    from public.team_admin_changes c
   where c.status = 'pending' and c.new_role = any (public._r398_removed_roles());
$$;

-- keep a function's current body as <name>__pre0400 (once), with no app privilege
create or replace function public._r400_keep(p_fn regprocedure)
returns text language plpgsql security definer set search_path = '' as $$
-- r232-0400
declare v_name text; v_args text; v_types text; v_copy text; d text;
begin
  select p.proname, pg_get_function_identity_arguments(p.oid), oidvectortypes(p.proargtypes) into v_name, v_args, v_types
    from pg_proc p where p.oid = p_fn;
  if v_name is null then return 'missing'; end if;
  if to_regprocedure('public.' || v_name || '__pre0400(' || v_types || ')') is not null then return 'kept'; end if;
  d := pg_get_functiondef(p_fn);
  v_copy := regexp_replace(d, '^CREATE OR REPLACE FUNCTION public\.' || v_name || '\(',
                           'CREATE OR REPLACE FUNCTION public.' || v_name || '__pre0400(');
  if v_copy = d then return 'missing'; end if;
  execute v_copy;
  execute format('revoke all on function public.%I(%s) from public', v_name || '__pre0400', v_args);
  if exists (select 1 from pg_roles where rolname = 'anon') then
    execute format('revoke all on function public.%I(%s) from anon', v_name || '__pre0400', v_args); end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    execute format('revoke all on function public.%I(%s) from authenticated', v_name || '__pre0400', v_args); end if;
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    execute format('revoke all on function public.%I(%s) from service_role', v_name || '__pre0400', v_args); end if;
  return 'copied';
end $$;

-- patch a function in place: every p_old[i] (must all be found) -> p_new[i]. Never raises:
--   'already' = none of the old texts is there (done before), 'skipped' = the live body differs (left as it is, reported)
create or replace function public._r400_patch(p_fn regprocedure, p_old text[], p_new text[])
returns text language plpgsql security definer set search_path = '' as $$
-- r232-0400
declare d text; i integer; v_any boolean := false;
begin
  if p_fn is null then return 'missing'; end if;
  d := pg_get_functiondef(p_fn);
  for i in 1 .. coalesce(array_length(p_old, 1), 0) loop
    if position(p_old[i] in d) > 0 then v_any := true; end if;
  end loop;
  if not v_any then return 'already'; end if;
  for i in 1 .. array_length(p_old, 1) loop
    if position(p_old[i] in d) = 0 then return 'skipped'; end if;
  end loop;
  perform public._r400_keep(p_fn);
  for i in 1 .. array_length(p_old, 1) loop
    d := replace(d, p_old[i], p_new[i]);
  end loop;
  begin
    execute d;
  exception when others then
    raise warning 'r232-0400: % not patched (%)', p_fn, sqlerrm;
    return 'skipped';
  end;
  return 'patched';
end $$;

-- proof for the check rows: the new-studio default matrix + starter set are the kept old ones minus the two roles
-- (null = 0400 not applied yet: the kept copies are missing)
create or replace function public._r400_seed_same()
returns boolean language plpgsql stable security definer set search_path = '' as $$
-- r232-0400
begin
  if to_regprocedure('public._a49_default_matrix__pre0400()') is null or to_regprocedure('public._a143_role_defaults__pre0400()') is null then
    return null; end if;
  return not exists ((select * from public._a49_default_matrix__pre0400() d where not (d.role = any (public._r398_removed_roles())))
                     except (select * from public._a49_default_matrix()))
     and not exists ((select * from public._a49_default_matrix()) except (select * from public._a49_default_matrix__pre0400()))
     and not exists ((select * from public._a143_role_defaults__pre0400() d where not (d.role = any (public._r398_removed_roles())))
                     except (select * from public._a143_role_defaults()))
     and not exists ((select * from public._a143_role_defaults()) except (select * from public._a143_role_defaults__pre0400()))
     and not exists (select 1 from public._a49_default_matrix() d where d.role = any (public._r398_removed_roles()))
     and not exists (select 1 from public._a143_role_defaults() d where d.role = any (public._r398_removed_roles()));
end $$;

revoke all on function public._r400_roles() from public;
revoke all on function public._r400_blockers() from public;
revoke all on function public._r400_keep(regprocedure) from public;
revoke all on function public._r400_patch(regprocedure, text[], text[]) from public;
revoke all on function public._r400_seed_same() from public;
do $r400g$ begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    execute 'revoke all on function public._r400_roles(), public._r400_blockers(), public._r400_keep(regprocedure), '
         || 'public._r400_patch(regprocedure, text[], text[]), public._r400_seed_same() from anon';
  end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    execute 'revoke all on function public._r400_roles(), public._r400_blockers(), public._r400_keep(regprocedure), '
         || 'public._r400_patch(regprocedure, text[], text[]), public._r400_seed_same() from authenticated';
  end if;
end $r400g$;

-- ---- 1a) Crew is available again (owner change 19 Nov 2026): the 0398 guard refuses ONLY the two removed roles -----
-- (not behind the safety gate: it removes nothing). Old body kept as _r398_retired_roles__pre0400.
do $r400c$ begin
  if coalesce(current_setting('helm.r400_remove', true), '') = 'off' then return; end if;
  if to_regprocedure('public._r398_retired_roles()') is null then return; end if;
  if 'crew' = any (public._r398_retired_roles()) then
    perform public._r400_keep('public._r398_retired_roles()'::regprocedure);
    execute $f$
create or replace function public._r398_retired_roles()
returns text[] language sql immutable set search_path = '' as $b$
  -- r229-0398 / r232-0400: Crew can be given again (owner 19 Nov 2026); only the two removed roles are refused
  select array['coordinator', 'designer']::text[];
$b$ $f$;
  end if;
end $r400c$;

-- ---- 1) the removal (only when the safety gate is clear) -------------------------------------------------------------
do $r400$
declare
  v_run timestamptz := now();
  v_rm text[]; v_ok text[] := public._r400_roles();
  v_labels text[]; v_n integer; v_s text; r record;
begin
  if coalesce(current_setting('helm.r400_remove', true), '') = 'off' then
    raise notice 'r232-0400: test switch helm.r400_remove = off - nothing changed'; return; end if;
  if to_regclass('public._r398_backup') is null or to_regprocedure('public._r398_removed_roles()') is null then
    raise notice 'r232-0400: STOP - run 0398 first. Nothing was changed.'; return; end if;
  if exists (select 1 from public._r400_blockers()) then
    raise notice 'r232-0400: STOP - % blocker(s) left (run DELETE-0398 first / reassign the studio owner or HQ login / cancel the waiting admin change). Nothing was changed.',
      (select count(*) from public._r400_blockers());
    return;
  end if;
  v_rm := public._r398_removed_roles();
  v_labels := array(select lower(public._r398_role_label(x)) from unnest(v_rm) x);

  -- a) access matrix rows of the two roles
  insert into public._r398_backup(run_at, kind, tbl, row_data)
    select v_run, 'r400_role_access', 'public.role_access', to_jsonb(t) from public.role_access t where t.role = any (v_rm);
  delete from public.role_access t where t.role = any (v_rm);

  -- b) invitations with the two roles (their e-mail queue rows go with them: copied first)
  insert into public._r398_backup(run_at, kind, tbl, row_data)
    select v_run, 'r400_invite_email_outbox', 'public.invite_email_outbox', to_jsonb(o)
      from public.invite_email_outbox o join public.invitations i on i.id = o.invitation_id where i.role = any (v_rm);
  insert into public._r398_backup(run_at, kind, tbl, row_data)
    select v_run, 'r400_invitations', 'public.invitations', to_jsonb(t) from public.invitations t where t.role = any (v_rm);
  delete from public.invitations t where t.role = any (v_rm);

  -- c) per-role notification settings of the two roles (a person's own overrides are role '*' / user rows: untouched)
  insert into public._r398_backup(run_at, kind, tbl, row_data)
    select v_run, 'r400_notification_prefs', 'public.notification_prefs', to_jsonb(t) from public.notification_prefs t where t.role = any (v_rm);
  delete from public.notification_prefs t where t.role = any (v_rm);

  -- d) studio settings lists: the two roles taken out, everything else kept as it is
  insert into public._r398_backup(run_at, kind, tbl, row_data)
    select v_run, 'r400_signin_notice_settings', 'public.signin_notice_settings', to_jsonb(t)
      from public.signin_notice_settings t where t.roles && v_rm;
  update public.signin_notice_settings t
     set roles = array(select x from unnest(t.roles) with ordinality u(x, n) where not (x = any (v_rm)) order by n)
   where t.roles && v_rm;

  insert into public._r398_backup(run_at, kind, tbl, row_data)
    select v_run, 'r400_event_ready_alert_settings', 'public.event_ready_alert_settings', to_jsonb(t)
      from public.event_ready_alert_settings t where t.notify_roles && v_rm;
  update public.event_ready_alert_settings t
     set notify_roles = array(select x from unnest(t.notify_roles) with ordinality u(x, n) where not (x = any (v_rm)) order by n)
   where t.notify_roles && v_rm;

  insert into public._r398_backup(run_at, kind, tbl, row_data)
    select v_run, 'r400_comms_settings', 'public.comms_settings', to_jsonb(t)
      from public.comms_settings t where jsonb_typeof(t.wa_forward_roles) = 'object' and t.wa_forward_roles ?| v_rm;
  update public.comms_settings t set wa_forward_roles = t.wa_forward_roles - v_rm
   where jsonb_typeof(t.wa_forward_roles) = 'object' and t.wa_forward_roles ?| v_rm;

  -- the payer role: nobody holds a removed role, so those reminders already went to the admins (the fallback) - say Admin
  insert into public._r398_backup(run_at, kind, tbl, row_data)
    select v_run, 'r400_vendor_bill_settings', 'public.vendor_bill_settings', to_jsonb(t)
      from public.vendor_bill_settings t where lower(t.payer_role) = any (v_rm);
  update public.vendor_bill_settings t set payer_role = 'admin' where lower(t.payer_role) = any (v_rm);

  -- e) staff records whose role words are EXACTLY a removed role's label (what Helm copied from the login role)
  for r in select c.* from public.crew_members c
            where c.role is not null and lower(btrim(c.role)) = any (v_labels) loop
    begin
      insert into public._r398_backup(run_at, kind, tbl, user_id, row_data)
        values (v_run, 'r400_crew_members', 'public.crew_members', r.profile_id, to_jsonb(r));
      update public.crew_members c set role = null where c.id = r.id;
    exception when others then
      raise warning 'r232-0400: staff record % kept as it is (%)', r.id, sqlerrm;
    end;
  end loop;

  -- f) free-trial sample data: the same exact words on sample staff (every published version, so no trial gets them)
  for r in select m.version, m.payload from public.helm_trial_seed_manifest m
            where jsonb_typeof(m.payload -> 'tables' -> 'crew_members') = 'array'
              and exists (select 1 from jsonb_array_elements(m.payload -> 'tables' -> 'crew_members') e
                           where lower(btrim(coalesce(e ->> 'role', ''))) = any (v_labels)) loop
    insert into public._r398_backup(run_at, kind, tbl, row_data)
      values (v_run, 'r400_helm_trial_seed_manifest', 'public.helm_trial_seed_manifest',
              jsonb_build_object('version', r.version, 'crew_members', r.payload -> 'tables' -> 'crew_members'));
    update public.helm_trial_seed_manifest m
       set payload = jsonb_set(m.payload, '{tables,crew_members}',
             (select coalesce(jsonb_agg(case when lower(btrim(coalesce(e ->> 'role', ''))) = any (v_labels)
                                             then e || jsonb_build_object('role', null) else e end order by n), '[]'::jsonb)
                from jsonb_array_elements(m.payload -> 'tables' -> 'crew_members') with ordinality x(e, n)))
     where m.version = r.version;
  end loop;

  -- g) the escalation ladder: step 1 is named "lead" (the same people), the record rows relabelled (copies first)
  if to_regclass('public.task_escalation_steps') is not null then
    insert into public._r398_backup(run_at, kind, tbl, row_data)
      select v_run, 'r400_task_escalation_steps', 'public.task_escalation_steps', to_jsonb(t)
        from public.task_escalation_steps t
       where t.level = any (v_rm)
          or exists (select 1 from jsonb_array_elements(case when jsonb_typeof(t.recipients) = 'array' then t.recipients else '[]'::jsonb end) e
                      where e ->> 'level' = any (v_rm));
    alter table public.task_escalation_steps drop constraint if exists task_escalation_steps_level_check;
    update public.task_escalation_steps t set level = 'lead' where t.level = any (v_rm);
    update public.task_escalation_steps t
       set recipients = (select coalesce(jsonb_agg(case when e ->> 'level' = any (v_rm) then e || '{"level": "lead"}'::jsonb else e end order by n), '[]'::jsonb)
                           from jsonb_array_elements(t.recipients) with ordinality x(e, n))
     where jsonb_typeof(t.recipients) = 'array'
       and exists (select 1 from jsonb_array_elements(t.recipients) e where e ->> 'level' = any (v_rm));
    alter table public.task_escalation_steps add constraint task_escalation_steps_level_check
      check (level in ('lead', 'manager', 'admin')) not valid;
    alter table public.task_escalation_steps validate constraint task_escalation_steps_level_check;
  end if;

  -- h) server functions: full re-issue of the small list / label functions (old bodies kept as __pre0400) ---------------
  perform public._r400_keep('public._valid_role(text)'::regprocedure);
  execute $f$
create or replace function public._valid_role(p_role text)
returns boolean language sql immutable set search_path = 'public' as $b$
  select p_role in ('admin','manager','planner','sales','supervisor','quality','operations','crew','worker','client');
$b$ $f$;

  perform public._r400_keep('public._notify_roles()'::regprocedure);
  execute $f$
create or replace function public._notify_roles()
returns text[] language sql immutable set search_path = '' as $b$
  -- r232-0400
  select array['admin','manager','planner','sales','supervisor','quality','operations','crew','worker']::text[];
$b$ $f$;

  perform public._r400_keep('public._r383_roles_all()'::regprocedure);
  execute $f$
create or replace function public._r383_roles_all()
returns text[] language sql immutable set search_path = '' as $b$
  -- r205-0383 / r232-0400
  select array['admin', 'manager', 'planner', 'sales', 'supervisor', 'quality', 'operations', 'crew']::text[];
$b$ $f$;

  perform public._r400_keep('public._a106_role_label(text)'::regprocedure);
  execute $f$
create or replace function public._a106_role_label(p_role text)
returns text language sql immutable set search_path = '' as $b$
  -- r232-0400
  select case p_role
    when 'admin' then 'Admin' when 'manager' then 'Event manager' when 'planner' then 'Planner'
    when 'sales' then 'Sales' when 'supervisor' then 'Supervisor'
    when 'quality' then 'Quality engineer' when 'operations' then 'Operations'
    when 'crew' then 'Crew' when 'worker' then 'Crew' when 'client' then 'Client'
    else initcap(replace(coalesce(p_role, ''), '_', ' ')) end;
$b$ $f$;

  perform public._r400_keep('public._r383_role_label(text)'::regprocedure);
  execute $f$
create or replace function public._r383_role_label(p_role text)
returns text language sql immutable set search_path = '' as $b$
  -- r205-0383 / r232-0400
  select case lower(coalesce(p_role, '')) when 'admin' then 'Admin' when 'manager' then 'Event manager' when 'planner' then 'Planner'
    when 'sales' then 'Sales' when 'supervisor' then 'Supervisor' when 'quality' then 'Quality engineer'
    when 'operations' then 'Operations' when 'crew' then 'Crew' when 'worker' then 'Crew'
    else initcap(replace(lower(coalesce(nullif(btrim(p_role), ''), 'team member')), '_', ' ')) end;
$b$ $f$;

  -- the default access matrix every new studio / re-seed starts from: the same rows for every other role
  perform public._r400_keep('public._a49_default_matrix()'::regprocedure);
  execute $f$
create or replace function public._a49_default_matrix()
returns table(role text, area text, can_view boolean, can_edit boolean)
language sql immutable set search_path = '' as $b$
  -- 0049 NV-08 + r20-business-0239 ('business': admin only) / r232-0400
  with areas(area, v, e) as (values
    -- area,       roles that VIEW,                                                       roles that EDIT
    ('leads',      '{manager,planner,sales}'::text[],                                     '{manager,planner,sales}'::text[]),
    ('crm',        '{manager,planner,sales}',                                             '{manager,planner,sales}'),
    ('nurture',    '{manager,planner}',                                                   '{manager,planner}'),
    ('discovery',  '{manager,planner}',                                                   '{manager,planner}'),
    ('proposal',   '{manager,planner}',                                                   '{manager,planner}'),
    ('quotes',     '{manager,planner,supervisor,operations,quality}',                     '{manager,planner}'),
    ('layouts',    '{manager,planner,supervisor,operations,quality}',                     '{planner}'),
    ('design',     '{manager,planner}',                                                   '{manager,planner}'),
    ('staff',      '{manager,planner,supervisor,operations,quality}',                     '{manager,planner,operations}'),
    ('inventory',  '{manager,planner,supervisor,operations,quality}',                     '{manager,planner,operations}'),
    ('vendors',    '{manager,planner,supervisor,operations,quality}',                     '{manager,planner,operations}'),
    ('calendar',   '{manager,planner,supervisor,operations,quality}',                     '{manager,planner}'),
    ('templates',  '{manager,planner,operations,quality}',                                '{manager,planner}'),
    ('resources',  '{manager,planner,supervisor,operations,quality}',                     '{manager,planner,operations}'),
    ('runsheet',   '{manager,planner,supervisor,operations,quality}',                     '{manager,planner}'),
    ('plan',       '{manager,planner,supervisor,operations,quality}',                     '{manager,planner}'),
    ('logistics',  '{manager,planner,supervisor,operations,quality}',                     '{manager,planner}'),
    ('ready',      '{manager,planner,supervisor,quality}',                                '{manager,planner}'),
    ('finance',    '{manager,planner}',                                                   '{manager,planner}'),
    ('settlement', '{manager,planner}',                                                   '{manager,planner}'),
    ('closure',    '{manager,planner}',                                                   '{manager,planner}'),
    ('command',    '{manager,planner,supervisor,operations,quality}',                     '{manager,planner,supervisor,quality}'),
    ('issues',     '{manager,planner,supervisor,operations,quality}',                     '{manager,planner,supervisor,operations,quality}'),
    ('media',      '{manager,planner,supervisor,operations,quality}',                     '{manager,planner,supervisor}'),
    ('controls',   '{manager}',                                                           '{manager}'),
    ('codes',      '{manager,planner}',                                                   '{manager,planner}'),
    ('users',      '{}',                                                                  '{}'),
    ('business',   '{}',                                                                  '{}')),
  roles(role) as (values ('admin'), ('manager'), ('planner'), ('sales'), ('supervisor'),
                         ('quality'), ('operations'), ('crew'), ('worker'), ('client'))
  select r.role, a.area,
         r.role = 'admin' or r.role = any(a.v),
         r.role = 'admin' or (r.role = any(a.e) and r.role = any(a.v))      -- edit implies view
    from roles r cross join areas a;
$b$ $f$;

  -- the starter set for a role the template gives nothing: only Crew is left
  perform public._r400_keep('public._a143_role_defaults()'::regprocedure);
  execute $f$
create or replace function public._a143_role_defaults()
returns table(role text, area text, can_view boolean, can_edit boolean)
language sql immutable set search_path = '' as $b$
  -- r232-0400
  values ('crew','runsheet',true,false), ('crew','calendar',true,false);
$b$ $f$;

  -- closure approvers / restore: admin, or a manager (with the same area checks as before)
  perform public._r400_keep('public._r22_can_approve()'::regprocedure);
  execute $f$
create or replace function public._r22_can_approve()
returns boolean language sql stable security definer set search_path = '' as $b$
  -- r22-closure-0254 / r232-0400
  select coalesce(public.user_role(), '') = 'admin'
      or (coalesce(public.user_role(), '') = 'manager' and public.has_area('closure', 'edit'));
$b$ $f$;

  perform public._r400_keep('public._r22_approver_ids(uuid)'::regprocedure);
  execute $f$
create or replace function public._r22_approver_ids(p_org uuid)
returns jsonb language sql stable security definer set search_path = '' as $b$
  -- r22-closure-0254 / r232-0400
  select coalesce(jsonb_agg(to_jsonb(p.id) order by p.id), '[]'::jsonb)
    from public.profiles p where p.org_id = p_org and p.role in ('admin', 'manager');
$b$ $f$;

  perform public._r400_keep('public._a260_can_restore()'::regprocedure);
  execute $f$
create or replace function public._a260_can_restore()
returns boolean language sql stable security definer set search_path = '' as $b$
  -- r23-cancel-0260 / r232-0400
  select public.has_area('quotes', 'edit') and coalesce(public.user_role(), '') in ('admin', 'manager');
$b$ $f$;

  -- i) longer functions: patched in place (each old text must be found, else left as it is and reported) -------------
  v_s := public._r400_patch(to_regprocedure('public._r369_people(uuid,uuid,uuid,integer)'),
    array['(not l.ok and o.role in (''coordinator'', ''supervisor''))', 'when 0 then ''coordinator'' when 1'],
    array['(not l.ok and o.role = ''supervisor'')', 'when 0 then ''lead'' when 1']);
  raise notice 'r232-0400: _r369_people %', v_s;
  v_s := public._r400_patch(to_regprocedure('public._r369_escalation_tick(timestamp with time zone)'),
    array['-> worker + coordinator, then', 'when 0 then ''coordinator'' when 1',
          'case v_level when ''admin'' then ''admin / owner'' else v_level end'],
    array['-> worker + event lead, then', 'when 0 then ''lead'' when 1',
          'case v_level when ''admin'' then ''admin / owner'' when ''lead'' then ''event lead'' else v_level end']);
  raise notice 'r232-0400: _r369_escalation_tick %', v_s;
  v_s := public._r400_patch(to_regprocedure('public.request_event_close(uuid,text,jsonb)'),
    array['an admin or coordinator can approve it'], array['an admin or an event manager can approve it']);
  raise notice 'r232-0400: request_event_close %', v_s;
  v_s := public._r400_patch(to_regprocedure('public.decide_event_close(uuid,boolean,text)'),
    array['Only an admin, or a coordinator / manager who can close events,', 'ask an admin or a coordinator.'],
    array['Only an admin, or an event manager who can close events,', 'ask an admin or an event manager.']);
  raise notice 'r232-0400: decide_event_close %', v_s;
  v_s := public._r400_patch(to_regprocedure('public._r22_close_mail(uuid,uuid,text)'),
    array['p.role in (''admin'', ''coordinator'', ''manager'')'], array['p.role in (''admin'', ''manager'')']);
  raise notice 'r232-0400: _r22_close_mail %', v_s;
  v_s := public._r400_patch(to_regprocedure('public.restore_event(uuid,text)'),
    array['Only an admin, a manager or a coordinator can restore'], array['Only an admin or a manager can restore']);
  raise notice 'r232-0400: restore_event %', v_s;
  v_s := public._r400_patch(to_regprocedure('public.resume_client_links(uuid)'),
    array['Only an admin, a manager or a coordinator can re-share'], array['Only an admin or a manager can re-share']);
  raise notice 'r232-0400: resume_client_links %', v_s;
  v_s := public._r400_patch(to_regprocedure('public._dl241_announce(uuid,text,text,text)'),
    array['-- r21: event coordinators + managers of the same studio', 'p.role in (''coordinator'', ''manager'')'],
    array['-- r21: event managers of the same studio', 'p.role = ''manager''']);
  raise notice 'r232-0400: _dl241_announce %', v_s;
  v_s := public._r400_patch(to_regprocedure('public._vr256_announce(uuid,text,text,text)'),
    array[E'\n              -- coordinators of the same studio, only when they are in the group (the bell row reaches every one)\n'
          || E'              union select p.id from public.profiles p\n'
          || E'                     join public.chat_members m on m.conversation_id = v_conv and m.user_id = p.id and m.org_id = r.org_id\n'
          || E'                    where p.org_id = r.org_id and p.role = ''coordinator'') u;',
          'p.role in (''admin'', ''coordinator'', ''manager'')'],
    array[') u;', 'p.role in (''admin'', ''manager'')']);
  raise notice 'r232-0400: _vr256_announce %', v_s;
  v_s := public._r400_patch(to_regprocedure('public._r388_vis(uuid,uuid)'),
    array['in (''admin'', ''manager'', ''coordinator'') or public._r23_area'], array['in (''admin'', ''manager'') or public._r23_area']);
  raise notice 'r232-0400: _r388_vis %', v_s;
  -- older bodies still reached through wrapper chains (the bell, a new studio, the free-trial fallback seed) and the
  -- other kept bodies of the bell rule: the same list without the removed role
  v_s := public._r400_patch(to_regprocedure('public.bell_feed__pre0261(integer)'),
    array['in (''admin'', ''manager'', ''coordinator'') or public.has_area'], array['in (''admin'', ''manager'') or public.has_area']);
  raise notice 'r232-0400: bell_feed__pre0261 %', v_s;
  for r in select p.oid from pg_proc p where p.pronamespace = 'public'::regnamespace
              and p.proname in ('_r23_visible__pre0293', '_r23_visible__pre0357', '_r23_visible__pre0369') loop
    v_s := public._r400_patch(r.oid::regprocedure,
      array['in (''admin'', ''manager'', ''coordinator'') or public._r23_area'], array['in (''admin'', ''manager'') or public._r23_area']);
    raise notice 'r232-0400: % %', r.oid::regprocedure, v_s;
  end loop;
  v_s := public._r400_patch(to_regprocedure('public.create_studio__pre0159(text,text,text,text)'),
    array['-- a143: a NEW studio also gets the designer / crew starting access'], array['-- a143: a NEW studio also gets the crew starting access']);
  raise notice 'r232-0400: create_studio__pre0159 %', v_s;
  -- the built-in trial extras (used only when no sample manifest is published): the sample designer's role words
  v_s := public._r400_patch(to_regprocedure('public._trial_seed_extra__pre0166(uuid)'),
    array['''Design'', ''Designer'', ''full_time'''], array['''Design'', ''Design lead'', ''full_time''']);
  raise notice 'r232-0400: _trial_seed_extra__pre0166 %', v_s;
  -- settings saves never store a removed role again (quietly left out / refused like a non-office role)
  v_s := public._r400_patch(to_regprocedure('public.event_ready_settings_set(jsonb)'),
    array['x where btrim(x) <> '''');'],
    array['x where btrim(x) <> '''' and not (lower(btrim(x)) = any (public._r398_removed_roles())));']);
  raise notice 'r232-0400: event_ready_settings_set %', v_s;
  v_s := public._r400_patch(to_regprocedure('public.vendor_bill_settings_set(jsonb)'),
    array['or v_role in (''client'', ''crew'', ''worker'') then raise exception ''Choose an office role.'''],
    array['or v_role in (''client'', ''crew'', ''worker'') or v_role = any (public._r398_removed_roles()) then raise exception ''Choose an office role.''']);
  raise notice 'r232-0400: vendor_bill_settings_set %', v_s;

  -- j) the database stops accepting the two roles (rebuilt / new checks; skipped + reported if a leftover row exists)
  if not exists (select 1 from public.profiles p where p.role is not null and not (p.role = any (v_ok))) then
    alter table public.profiles drop constraint if exists profiles_role_check;
    alter table public.profiles add constraint profiles_role_check
      check (role = any (array['admin','manager','planner','sales','supervisor','quality','operations','crew','worker','client']::text[])) not valid;
    alter table public.profiles validate constraint profiles_role_check;
  else raise notice 'r232-0400: profiles_role_check kept (a login has a role outside the list)'; end if;

  if not exists (select 1 from public.invitations i where i.role is not null and not (i.role = any (v_ok))) then
    alter table public.invitations drop constraint if exists invitations_role_chk;
    alter table public.invitations add constraint invitations_role_chk
      check (role = any (array['admin','manager','planner','sales','supervisor','quality','operations','crew','worker','client']::text[])) not valid;
    alter table public.invitations validate constraint invitations_role_chk;
  else raise notice 'r232-0400: invitations_role_chk kept (an invitation has a role outside the list)'; end if;

  if not exists (select 1 from pg_constraint where conname = 'role_access_role_r400_chk' and conrelid = 'public.role_access'::regclass) then
    if not exists (select 1 from public.role_access t where not (t.role = any (v_ok))) then
      alter table public.role_access add constraint role_access_role_r400_chk
        check (role = any (array['admin','manager','planner','sales','supervisor','quality','operations','crew','worker','client']::text[])) not valid;
      alter table public.role_access validate constraint role_access_role_r400_chk;
    else raise notice 'r232-0400: role_access_role_r400_chk skipped (a row has a role outside the list)'; end if;
  end if;

  if not exists (select 1 from pg_constraint where conname = 'notification_prefs_role_r400_chk' and conrelid = 'public.notification_prefs'::regclass) then
    if not exists (select 1 from public.notification_prefs t where t.role <> '*' and not (t.role = any (v_ok))) then
      alter table public.notification_prefs add constraint notification_prefs_role_r400_chk
        check (role = '*' or role = any (array['admin','manager','planner','sales','supervisor','quality','operations','crew','worker','client']::text[])) not valid;
      alter table public.notification_prefs validate constraint notification_prefs_role_r400_chk;
    else raise notice 'r232-0400: notification_prefs_role_r400_chk skipped (a row has a role outside the list)'; end if;
  end if;

  if not exists (select 1 from pg_constraint where conname = 'signin_notice_settings_roles_r400_chk' and conrelid = 'public.signin_notice_settings'::regclass) then
    if not exists (select 1 from public.signin_notice_settings t where t.roles is not null and not (t.roles <@ v_ok)) then
      alter table public.signin_notice_settings add constraint signin_notice_settings_roles_r400_chk
        check (roles is null or roles <@ array['admin','manager','planner','sales','supervisor','quality','operations','crew','worker','client']::text[]) not valid;
      alter table public.signin_notice_settings validate constraint signin_notice_settings_roles_r400_chk;
    else raise notice 'r232-0400: signin_notice_settings_roles_r400_chk skipped (a list has a role outside the list)'; end if;
  end if;

  if not exists (select 1 from pg_constraint where conname = 'event_ready_alert_settings_roles_r400_chk' and conrelid = 'public.event_ready_alert_settings'::regclass) then
    if not exists (select 1 from public.event_ready_alert_settings t where not (t.notify_roles <@ v_ok)) then
      alter table public.event_ready_alert_settings add constraint event_ready_alert_settings_roles_r400_chk
        check (notify_roles <@ array['admin','manager','planner','sales','supervisor','quality','operations','crew','worker','client']::text[]) not valid;
      alter table public.event_ready_alert_settings validate constraint event_ready_alert_settings_roles_r400_chk;
    else raise notice 'r232-0400: event_ready_alert_settings_roles_r400_chk skipped (a list has a role outside the list)'; end if;
  end if;

  if not exists (select 1 from pg_constraint where conname = 'comms_settings_wa_roles_r400_chk' and conrelid = 'public.comms_settings'::regclass) then
    if not exists (select 1 from public.comms_settings t where jsonb_typeof(t.wa_forward_roles) = 'object' and (t.wa_forward_roles - v_ok) <> '{}'::jsonb) then
      alter table public.comms_settings add constraint comms_settings_wa_roles_r400_chk
        check (jsonb_typeof(wa_forward_roles) <> 'object'
               or (wa_forward_roles - array['admin','manager','planner','sales','supervisor','quality','operations','crew','worker','client']::text[]) = '{}'::jsonb) not valid;
      alter table public.comms_settings validate constraint comms_settings_wa_roles_r400_chk;
    else raise notice 'r232-0400: comms_settings_wa_roles_r400_chk skipped (a forward list has a role outside the list)'; end if;
  end if;

  if not exists (select 1 from pg_constraint where conname = 'vendor_bill_settings_payer_r400_chk' and conrelid = 'public.vendor_bill_settings'::regclass) then
    if not exists (select 1 from public.vendor_bill_settings t where not (lower(t.payer_role) = any (v_ok))) then
      alter table public.vendor_bill_settings add constraint vendor_bill_settings_payer_r400_chk
        check (lower(payer_role) = any (array['admin','manager','planner','sales','supervisor','quality','operations','crew','worker','client']::text[])) not valid;
      alter table public.vendor_bill_settings validate constraint vendor_bill_settings_payer_r400_chk;
    else raise notice 'r232-0400: vendor_bill_settings_payer_r400_chk skipped (a payer role outside the list)'; end if;
  end if;

  raise notice 'r232-0400: done (copies in public._r398_backup, kind r400_*, run_at %)', v_run;
end $r400$;

select item, ok from (
  select case when exists (select 1 from public._r400_blockers() b where b.kind = 'login' and not b.owner_or_hq)
              then '01 STOP - run DELETE-0398 first: ' || (select count(*) from public._r400_blockers() b where b.kind = 'login' and not b.owner_or_hq)
                   || ' login(s) still have Event coordinator / Designer. Nothing was changed.'
              when exists (select 1 from public._r400_blockers() b where b.kind = 'login')
              then '01 STOP - reassign first: ' || (select count(*) from public._r400_blockers() b where b.kind = 'login')
                   || ' studio owner / HQ login(s) still have Event coordinator / Designer (Settings -> Users & invites). Nothing was changed.'
              when exists (select 1 from public._r400_blockers())
              then '01 STOP - cancel first: ' || (select count(*) from public._r400_blockers())
                   || ' waiting 24-hour admin change(s) to Event coordinator / Designer (Settings -> Users & invites). Nothing was changed.'
              else '01 safety gate clear: no login has Event coordinator / Designer, no admin change to them is waiting' end as item,
         not exists (select 1 from public._r400_blockers()) as ok
  union all select '02 no access-matrix (role_access) row of the two roles',
     not exists (select 1 from public.role_access t where t.role in ('coordinator', 'designer'))
  union all select '03 no invitation with the two roles',
     not exists (select 1 from public.invitations t where t.role in ('coordinator', 'designer'))
  union all select '04 no per-role notification setting of the two roles',
     not exists (select 1 from public.notification_prefs t where t.role in ('coordinator', 'designer'))
  union all select '05 settings lists without the two roles (sign-in notice, event-ready alerts, WhatsApp forward, vendor payer)',
     not exists (select 1 from public.signin_notice_settings t where t.roles && array['coordinator', 'designer'])
     and not exists (select 1 from public.event_ready_alert_settings t where t.notify_roles && array['coordinator', 'designer'])
     and not exists (select 1 from public.comms_settings t where jsonb_typeof(t.wa_forward_roles) = 'object' and t.wa_forward_roles ?| array['coordinator', 'designer'])
     and not exists (select 1 from public.vendor_bill_settings t where lower(t.payer_role) in ('coordinator', 'designer'))
  union all select '06 no staff record shows exactly "Event coordinator" / "Designer" as its role (other words kept)',
     not exists (select 1 from public.crew_members c where lower(btrim(coalesce(c.role, ''))) in ('event coordinator', 'designer'))
  union all select '07 free-trial sample data without them (every manifest version)',
     not exists (select 1 from public.helm_trial_seed_manifest m, jsonb_array_elements(case when jsonb_typeof(m.payload -> 'tables' -> 'crew_members') = 'array'
                   then m.payload -> 'tables' -> 'crew_members' else '[]'::jsonb end) e
                  where lower(btrim(coalesce(e ->> 'role', ''))) in ('event coordinator', 'designer'))
  union all select '08 escalation ladder: first step is "lead" (no "coordinator" step record left), still 3 steps',
     not exists (select 1 from public.task_escalation_steps t where t.level = 'coordinator'
                   or (jsonb_typeof(t.recipients) = 'array' and exists (select 1 from jsonb_array_elements(t.recipients) e where e ->> 'level' = 'coordinator')))
     and position('when 0 then ''lead'' when 1' in pg_get_functiondef('public._r369_people(uuid,uuid,uuid,integer)'::regprocedure)) > 0
     and position('when 0 then ''lead'' when 1' in pg_get_functiondef('public._r369_escalation_tick(timestamp with time zone)'::regprocedure)) > 0
  union all select '09 new studios: the default matrix + starter set are the old ones minus the two roles (every other row identical)',
     coalesce(public._r400_seed_same(), false)
  union all select '10 role lists and labels without the two roles (Crew kept)',
     not public._valid_role('coordinator') and not public._valid_role('designer') and public._valid_role('crew') and public._valid_role('manager')
     and not (public._notify_roles() && array['coordinator', 'designer']) and 'crew' = any (public._notify_roles())
     and not (public._r383_roles_all() && array['coordinator', 'designer']) and 'crew' = any (public._r383_roles_all())
     and public._a106_role_label('manager') = 'Event manager' and public._r383_role_label('supervisor') = 'Supervisor'
  union all select '11 no live server function names the two roles (kept on purpose: the 0398 guard, the cost-category matcher, sample job title Guest coordinator, the __pre0400 copies): '
       || coalesce((select string_agg(p.proname, ', ' order by p.proname) from pg_proc p
                     where p.pronamespace = 'public'::regnamespace and p.prosrc ~* 'coordinator|designer'
                       and p.proname !~ '__pre0400$' and p.proname !~ '^_r398_' and p.proname not in ('_r21_category', '_demo_seed_ae', '_demo_seed__pre0166')), 'none'),
     not exists (select 1 from pg_proc p
                  where p.pronamespace = 'public'::regnamespace and p.prosrc ~* 'coordinator|designer'
                    and p.proname !~ '__pre0400$' and p.proname !~ '^_r398_' and p.proname not in ('_r21_category', '_demo_seed_ae', '_demo_seed__pre0166'))
  union all select '12 the database refuses the two roles (profiles, invitations, role_access, settings, escalation checks; all validated)',
     (select count(*) from pg_constraint c where c.convalidated and c.conname in ('profiles_role_check', 'invitations_role_chk',
        'task_escalation_steps_level_check', 'role_access_role_r400_chk', 'notification_prefs_role_r400_chk', 'signin_notice_settings_roles_r400_chk',
        'event_ready_alert_settings_roles_r400_chk', 'comms_settings_wa_roles_r400_chk', 'vendor_bill_settings_payer_r400_chk')
        and pg_get_constraintdef(c.oid) !~* 'coordinator|designer') = 9
  union all select '13 the kept old bodies (__pre0400) and the 0400 helpers have no app privilege',
     coalesce((select bool_and(not has_function_privilege('authenticated', p.oid, 'execute') and not has_function_privilege('anon', p.oid, 'execute'))
                 from pg_proc p where p.pronamespace = 'public'::regnamespace and (p.proname like '%\_\_pre0400' or p.proname like '\_r400\_%')), false)
  union all select '14 Crew is available again (can be invited / added / given) - Event coordinator / Designer are still refused',
     public._valid_role('crew') and not ('crew' = any (public._r398_retired_roles()))
     and public._r398_retired_roles() @> array['coordinator', 'designer']
     and exists (select 1 from pg_constraint c where c.conname = 'profiles_role_check' and pg_get_constraintdef(c.oid) like '%crew%')
     and exists (select 1 from pg_constraint c where c.conname = 'invitations_role_chk' and pg_get_constraintdef(c.oid) like '%crew%')
  union all select '15 backup table kept (copies of everything 0400 removed or changed: ' ||
       (select count(*) from public._r398_backup b where b.kind like 'r400\_%') || ' rows)',
     to_regclass('public._r398_backup') is not null
  union all select 'list staff record "' || coalesce(b.row_data ->> 'name', '?') || '" (' || coalesce(o.name, 'studio ?') || '): role words "'
       || coalesce(b.row_data ->> 'role', '') || '" removed', true
    from public._r398_backup b left join public.organizations o on o.id = (b.row_data ->> 'org_id')::uuid
   where b.kind = 'r400_crew_members'
) v(item, ok) order by item;
commit;
